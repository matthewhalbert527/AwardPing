#!/usr/bin/env node
import crypto from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { PDFParse } from "pdf-parse";
import { chromium } from "playwright-core";
import sharp from "sharp";
import { deterministicNoiseBaselineDisposition } from "./lib/deterministic-noise-disposition.mjs";
import { runGeminiCliJsonAnalysis } from "./lib/gemini-cli-analysis.mjs";
import {
  aiReviewLooksLikeRelativeAgeOnlyChange,
  changeEventSuppressionPolicyIdentity,
  hasRelativeAgeOnlyTextDiff,
  monitoringPolicyPromptLinesForScope,
} from "./lib/award-monitoring-policy.mjs";
import {
  shouldAutoReviewLaterFailure,
  shouldRejectDiscoveredSource,
} from "./source-hygiene.mjs";
import { classifySourceForConsolidation } from "./source-consolidation-core.mjs";
import {
  geminiSpendGuardStatus,
  markGeminiBillingBlocked,
} from "./lib/gemini-spend-guard.mjs";
import {
  estimateGeminiCostUsd as estimateGeminiCostUsdByMode,
  normalizeGeminiPricingMode,
} from "./lib/gemini-batch-support.mjs";
import { geminiWorkerModel } from "./lib/gemini-worker-policy.mjs";
import {
  atomicWriteJson,
  withVisualBaselineLockAsync,
} from "./lib/visual-baseline-lock.mjs";
import {
  acquireFileLock,
  annotateVisualRunReport,
  buildNightlyVisualReport,
  buildVisualRunReportSummary,
  isDailyVisualShardReport,
  monitoringDateForTimestamp,
  monitoringDateForVisualReportFilename,
  shouldReplaceLatestNightlyReport,
} from "./lib/visual-capture-run-report.mjs";
import { advanceVisualSnapshotPointer } from "./lib/visual-snapshot-pointer.mjs";
import {
  refreshedLatestVisualSnapshotHistory,
  rotatedVisualSnapshotHistory,
  visualSnapshotKeysToDeleteAfterCas,
  visualSnapshotUploadedKeysToDeleteAfterLostCas,
} from "./lib/visual-snapshot-history.mjs";
import { bindVisualTextGeometry } from "./lib/visual-event-localization.mjs";
import { captureVisibleTextGeometry } from "./lib/visible-text-geometry.mjs";
import {
  verifyExpansionStateIsolation,
  withIsolatedExpansionStatePage,
} from "./lib/expansion-state-isolation.mjs";
import {
  buildStableTextBlocks,
  captureProfileSettings,
  compareStableCaptureHashes,
  defaultCaptureProfile,
  defaultSectionExtractionProfile,
  expansionRelevanceModeForSource,
  normalizeCaptureProfile,
  normalizeSectionExtractionProfile,
  sectionExtractionProfileSettings,
  shouldUseScrollActivationForSource,
} from "./lib/capture-stability.mjs";
import {
  canonicalizeExpandableSections,
  sectionPresenceEvidence,
} from "./lib/expandable-section-identity.mjs";
import {
  aiDisabledReasonForOptions,
  missingAiProviderMessage,
  runRequiresAiFromOptions,
  selectAiProvider as selectAiProviderForRun,
} from "./lib/capture-ai-requirements.mjs";
import { inspectLocalBaselineEvidence } from "./lib/local-baseline-evidence.mjs";
import { rehydrateLocalBaselineFromR2 } from "./lib/r2-baseline-rehydration.mjs";
import {
  sourceBaselineFacts,
  sourceQualityDecision,
} from "./lib/source-quality.mjs";
import { monitoringPromotionMatcherBundleHash } from "./lib/monitoring-promotion-matcher-bundle.mjs";
import { insertedDiscoveryRows } from "./lib/source-discovery-write.mjs";
import {
  buildVisualReviewPromptPayload,
  buildVisualReviewPromptText,
  classifyVisualReviewCandidate,
  currentMonitoringPolicyAuditIdentity,
  currentVisualReviewPolicyIdentity,
  normalizeVisualReviewMode,
  visualReviewCandidateSignature,
  visualReviewEvidenceSignature,
} from "./lib/visual-review-queue.mjs";
import {
  findVisualRejectionLedgerMatch,
  touchVisualRejectionLedgerMatch,
} from "./lib/visual-rejection-ledger.mjs";
import { enqueueAwardReconciliation } from "./lib/award-fact-reconciliation.mjs";
import { checkSupabaseHealth } from "./lib/supabase-health.mjs";
import { createSupabaseServiceClient } from "./supabase-service-client.mjs";

const root = resolve(import.meta.dirname, "..");
const monitoringPromotionMatcherDigest =
  monitoringPromotionMatcherBundleHash;
const defaultArchiveRoot = "D:\\AwardPingVisualSnapshots";
const sentenceDotPlaceholder = "__AP_SENTENCE_DOT__";
const promptChars = 12_000;
const captureBehaviorVersion = 9;
const captureBehaviorName = "final-state-text-node-geometry-with-open-sections";
const args = parseArgs(process.argv.slice(2));
const envPath = args.env ? resolve(root, String(args.env)) : resolve(root, ".env.local");
const env = {
  ...loadEnvFile(envPath),
  ...process.env,
};

const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
const archiveRoot = resolve(
  String(env.AWARDPING_VISUAL_SNAPSHOT_DIR || args["archive-dir"] || defaultArchiveRoot),
);
const localBaselineEvidenceCache = new Map();
const observedVisualReviewCandidateIds = new Set();
const brokenSourcesDir = join(archiveRoot, "broken-sources");
const brokenSourcesCurrentPath = join(brokenSourcesDir, "broken-sources-current.json");
const brokenSourcesJsonlPath = join(brokenSourcesDir, "broken-sources-events.jsonl");
const brokenSourcesCsvPath = join(brokenSourcesDir, "broken-sources-current.csv");
const limit = positiveInt(args.limit, 25);
const shardCount = boundedInt(args["shard-count"] || env.AWARDPING_VISUAL_SHARD_COUNT, 1, 1, 64);
const shardIndex = nonNegativeInt(args["shard-index"] || env.AWARDPING_VISUAL_SHARD_INDEX, 0);
const requestedRunTrigger = cleanText(args["run-trigger"] || env.AWARDPING_VISUAL_RUN_TRIGGER).toLowerCase();
const runTrigger = ["scheduled", "maintenance", "manual"].includes(requestedRunTrigger)
  ? requestedRunTrigger
  : "manual";
const requestedRunCohortId = cleanText(args["run-cohort-id"] || env.AWARDPING_VISUAL_RUN_COHORT_ID);
const includeNotDue = boolArg(args.all, false) || boolArg(args["include-not-due"], false);
const sourceIdFilter = cleanText(args["source-id"]);
const sourceIdsFile = cleanText(args["source-ids-file"]);
const sourceIdsFilter = loadSourceIdsFilter(sourceIdsFile);
const sourceUrlFilter = cleanText(args["source-url"]);
const awardFilter = cleanText(args.award);
const continuous = boolArg(args.continuous, false);
const intervalMinutes = positiveInt(args["interval-minutes"], 60);
const visualSourceCheckMinutes = positiveInt(
  args["visual-source-check-minutes"] || env.AWARDPING_VISUAL_SOURCE_CHECK_MINUTES,
  24 * 60,
);
const baselineRefresh = boolArg(args["baseline-refresh"], false);
const promote = boolArg(args.promote, true);
const pdfOnly = boolArg(args["pdf-only"], false);
const webOnly = boolArg(args["web-only"], false);
const completeMissingBaselines = boolArg(args["complete-missing-baselines"], false);
const aiReviewEvidenceCapture = boolArg(args["ai-review-evidence-capture"], false);
const completeMissingBatchLimit = completeMissingBaselines
  ? positiveInt(args["complete-missing-batch-limit"] || env.AWARDPING_COMPLETE_MISSING_BATCH_LIMIT, 250)
  : 0;
const prioritizeMissingBaselines = boolArg(args["prioritize-missing-baselines"], true);
const prioritizeIssueSources = boolArg(
  args["prioritize-issue-sources"] ?? env.AWARDPING_PRIORITIZE_ISSUE_SOURCES,
  true,
);
const skipExistingBaseline = boolArg(args["skip-existing-baseline"], false);
const skipExistingBaselineEffective = skipExistingBaseline || completeMissingBaselines;
const keepUnchanged = boolArg(args["keep-unchanged"], false);
const keepRejected = boolArg(args["keep-rejected"], false);
const acceptTextOnlyNoise = boolArg(
  args["accept-text-only-noise"] ?? env.AWARDPING_ACCEPT_TEXT_ONLY_NOISE,
  false,
);
const reviewOnAiFailure = boolArg(args["review-on-ai-failure"], true);
const requestedAiProvider = String(args["ai-provider"] || env.AI_PROVIDER || "auto").toLowerCase();
const defaultGeminiCliPath = env.LOCALAPPDATA
  ? join(env.LOCALAPPDATA, "agy", "bin", "agy.exe")
  : "agy";
const geminiCliPath = cleanText(
  args["gemini-cli-path"] || env.AWARDPING_GEMINI_CLI_PATH || env.GEMINI_CLI_PATH || defaultGeminiCliPath,
);
const geminiCliModel = geminiWorkerModel();
const geminiCliWorkspaceRoot = resolve(
  String(args["gemini-cli-workspace"] || env.AWARDPING_GEMINI_CLI_WORKSPACE || join(archiveRoot, "gemini-cli-workspace")),
);
const geminiCliTimeoutMs = positiveInt(args["gemini-cli-timeout-ms"] || env.AWARDPING_GEMINI_CLI_TIMEOUT_MS, 120_000);
const geminiCliMaxCalls = nonNegativeInt(args["gemini-cli-max-calls"] || env.AWARDPING_GEMINI_CLI_MAX_CALLS, 100);
const geminiCliSafeModels = [geminiWorkerModel()];
const allowUnsafeGeminiCliModel = boolArg(
  args["allow-unsafe-gemini-cli-model"] ?? env.AWARDPING_ALLOW_UNSAFE_GEMINI_CLI_MODEL,
  false,
);
const geminiApiMaxCalls = nonNegativeInt(
  args["gemini-api-max-calls"] || env.AWARDPING_GEMINI_API_MAX_CALLS,
  0,
);
const geminiApiDailyCostCapUsd = nonNegativeNumber(
  args["gemini-api-daily-cost-cap-usd"] || env.AWARDPING_GEMINI_API_DAILY_COST_CAP_USD,
  5,
);
const geminiApiPricingMode = cleanSlug(
  args["gemini-api-pricing-mode"] || env.AWARDPING_GEMINI_API_PRICING_MODE || "standard",
) || "standard";
const localizationRepair = boolArg(args["localization-repair"] ?? env.AWARDPING_LOCALIZATION_REPAIR, false);
const resetPreviousSnapshot = boolArg(
  args["reset-previous-snapshot"] ?? env.AWARDPING_RESET_PREVIOUS_SNAPSHOT,
  false,
);
const forceR2SnapshotRefresh = boolArg(
  args["force-r2-snapshot-refresh"] ?? env.AWARDPING_FORCE_R2_SNAPSHOT_REFRESH,
  localizationRepair,
);
const extractBaselineInfo = localizationRepair
  ? false
  : boolArg(args["extract-baseline-info"] ?? env.AWARDPING_EXTRACT_BASELINE_INFO, true);
const backfillBaselineInfo = boolArg(args["backfill-baseline-info"] ?? env.AWARDPING_BACKFILL_BASELINE_INFO, false);
const viewportWidth = positiveInt(args["viewport-width"], 1365);
const viewportHeight = positiveInt(args["viewport-height"], 1600);
const jpegQuality = boundedInt(args["jpeg-quality"], 72, 30, 95);
const thumbWidth = positiveInt(args["thumb-width"], 900);
const discoveryMode = boolArg(args["discovery-mode"] ?? env.AWARDPING_DISCOVERY_MODE, false);
const captureProfile = normalizeCaptureProfile(
  args["capture-profile"] || env.AWARDPING_CAPTURE_PROFILE,
  defaultCaptureProfile({
    localizationRepair,
    discoveryMode,
    completeMissingBaselines,
    baselineRefresh,
    r2BackfillBaselines: boolArg(args["r2-backfill-baselines"], false),
  }),
);
const captureProfileConfig = captureProfileSettings(captureProfile);
const sectionExtractionProfile = normalizeSectionExtractionProfile(
  args["section-extraction-profile"] || env.AWARDPING_SECTION_EXTRACTION_PROFILE,
  defaultSectionExtractionProfile({
    completeMissingBaselines,
    baselineRefresh,
    r2BackfillBaselines: boolArg(args["r2-backfill-baselines"], false),
  }),
);
const sectionExtractionConfig = sectionExtractionProfileSettings(sectionExtractionProfile);
const extractExpandableSections = boolArg(
  args["extract-expandable-sections"] ?? env.AWARDPING_EXTRACT_EXPANDABLE_SECTIONS,
  !pdfOnly,
);
const includeSectionTextInMainHash = boolArg(
  args["include-section-text-in-main-hash"] ?? env.AWARDPING_INCLUDE_SECTION_TEXT_IN_MAIN_HASH,
  false,
);
const captureSectionEvidence = boolArg(
  args["capture-section-evidence"] ?? env.AWARDPING_CAPTURE_SECTION_EVIDENCE,
  sectionExtractionConfig.captureEvidence,
);
const defaultMaxExpansionStateScreenshots = captureProfile === "stable-daily"
  ? 8
  : captureProfileConfig.defaultMaxExpansionStateScreenshots;
const maxExpansionStateScreenshots = boundedInt(
  args["max-expansion-state-screenshots"] || env.AWARDPING_MAX_EXPANSION_STATE_SCREENSHOTS,
  defaultMaxExpansionStateScreenshots,
  0,
  24,
);
const keepRejectedEvidence = boolArg(
  args["keep-rejected-evidence"] ?? env.AWARDPING_KEEP_REJECTED_EVIDENCE,
  keepRejected,
);
const discoverPdfSubpagesRequested = boolArg(
  args["discover-pdf-subpages"] ?? env.AWARDPING_DISCOVER_PDF_SUBPAGES,
  false,
);
const discoverHtmlSubpagesRequested = boolArg(
  args["discover-html-subpages"] ?? env.AWARDPING_DISCOVER_HTML_SUBPAGES,
  false,
);
const discoverPdfSubpages = discoveryMode && discoverPdfSubpagesRequested;
const discoverHtmlSubpages = discoveryMode && discoverHtmlSubpagesRequested;
const maxHtmlSubpageDiscoveries = discoveryMode
  ? boundedInt(
      args["max-html-subpage-discoveries"] || env.AWARDPING_MAX_HTML_SUBPAGE_DISCOVERIES,
      8,
      0,
      25,
    )
  : 0;
const maxNewDiscoveriesPerAward = boundedInt(
  args["max-discoveries-per-award"] || env.AWARDPING_MAX_DISCOVERIES_PER_AWARD,
  5,
  0,
  500,
);
const maxNewDiscoveriesPerSource = boundedInt(
  args["max-discoveries-per-source"] || env.AWARDPING_MAX_DISCOVERIES_PER_SOURCE,
  3,
  0,
  100,
);
const maxNewDiscoveriesPerDomain = boundedInt(
  args["max-discoveries-per-domain"] || env.AWARDPING_MAX_DISCOVERIES_PER_DOMAIN,
  100,
  0,
  10_000,
);
const discoveryRunState = {
  byAward: new Map(),
  bySource: new Map(),
  byDomain: new Map(),
};
const timeoutMs = positiveInt(args["timeout-ms"], 60_000);
const sourceTimeoutMs = positiveInt(args["source-timeout-ms"], Math.max(timeoutMs + 30_000, 90_000));
const pageReadyTimeoutMs = positiveInt(args["page-ready-timeout-ms"] || env.AWARDPING_PAGE_READY_TIMEOUT_MS, 15_000);
const captureSettleStableMs = boundedInt(
  args["capture-settle-stable-ms"] || env.AWARDPING_CAPTURE_SETTLE_STABLE_MS,
  1_500,
  250,
  5_000,
);
const captureSettleMaxMs = boundedInt(
  args["capture-settle-max-ms"] || env.AWARDPING_CAPTURE_SETTLE_MAX_MS,
  8_000,
  1_000,
  20_000,
);
const captureSettlePollMs = boundedInt(
  args["capture-settle-poll-ms"] || env.AWARDPING_CAPTURE_SETTLE_POLL_MS,
  300,
  100,
  1_000,
);
const captureScrollActivation = boolArg(
  args["capture-scroll-activation"] ?? env.AWARDPING_CAPTURE_SCROLL_ACTIVATION,
  true,
);
const captureScrollStepRatio = Math.min(
  1,
  Math.max(
    0.25,
    nonNegativeNumber(args["capture-scroll-step-ratio"] || env.AWARDPING_CAPTURE_SCROLL_STEP_RATIO, 0.75),
  ),
);
const captureScrollWaitMs = boundedInt(
  args["capture-scroll-wait-ms"] || env.AWARDPING_CAPTURE_SCROLL_WAIT_MS,
  250,
  50,
  2_000,
);
const captureScrollFinalWaitMs = boundedInt(
  args["capture-scroll-final-wait-ms"] || env.AWARDPING_CAPTURE_SCROLL_FINAL_WAIT_MS,
  500,
  50,
  3_000,
);
const captureScrollMaxSteps = boundedInt(
  args["capture-scroll-max-steps"] || env.AWARDPING_CAPTURE_SCROLL_MAX_STEPS,
  80,
  5,
  300,
);
const delayMs = nonNegativeInt(args["delay-ms"], 0);
const domainDelayMs = Math.max(1_500, nonNegativeInt(args["domain-delay-ms"], 1_500));
const heartbeatMinutes = positiveInt(args["heartbeat-minutes"] || env.AWARDPING_WORKER_HEARTBEAT_MINUTES, 5);
const maxSourcesPerBrowser = positiveInt(args["max-sources-per-browser"], 250);
const sourceLoadPageSize = boundedInt(
  args["source-load-page-size"] || env.AWARDPING_SOURCE_LOAD_PAGE_SIZE,
  250,
  5,
  1_000,
);
const minSourceLoadPageSize = boundedInt(
  args["min-source-load-page-size"] || env.AWARDPING_MIN_SOURCE_LOAD_PAGE_SIZE,
  15,
  1,
  250,
);
const retryAccessBlockedCaptures = boolArg(
  args["retry-access-blocked-captures"] ?? env.AWARDPING_RETRY_ACCESS_BLOCKED_CAPTURES,
  true,
);
const safeRedirectUrlUpdate = boolArg(
  args["safe-redirect-url-update"] ?? env.AWARDPING_SAFE_REDIRECT_URL_UPDATE,
  true,
);
const visualWebConcurrency = boundedInt(
  args["web-concurrency"] || env.AWARDPING_VISUAL_WEB_CONCURRENCY,
  1,
  1,
  8,
);
const maxPdfBytes = positiveInt(args["max-pdf-mb"], 50) * 1024 * 1024;
const r2BackfillBaselines = boolArg(args["r2-backfill-baselines"], false);
const r2BackfillFast = boolArg(args["r2-backfill-fast"], true);
const r2BackfillSkipExisting = boolArg(args["r2-backfill-skip-existing"], true);
const r2BackfillConcurrency = boundedInt(args["r2-backfill-concurrency"], 12, 1, 32);
const r2OperationRetries = boundedInt(args["r2-operation-retries"] || env.AWARDPING_R2_OPERATION_RETRIES, 3, 0, 8);
const r2RepairMissingSnapshots = boolArg(
  args["r2-repair-missing-snapshots"] ?? env.AWARDPING_R2_REPAIR_MISSING_SNAPSHOTS,
  true,
);
const r2SnapshotSync = boolArg(
  args["r2-snapshot-sync"] ?? env.AWARDPING_R2_SNAPSHOT_SYNC ?? env.R2_SNAPSHOT_SYNC,
  r2BackfillBaselines || localizationRepair || forceR2SnapshotRefresh,
);
const visualReviewDefaultMode =
  completeMissingBaselines || localizationRepair || r2BackfillBaselines || forceR2SnapshotRefresh
    ? "none"
    : "batch";
const visualReviewMode = normalizeVisualReviewMode(
  args["visual-review-mode"] ?? env.AWARDPING_VISUAL_REVIEW_MODE ?? args["interpret-visual-changes"] ?? env.AWARDPING_INTERPRET_VISUAL_CHANGES,
  visualReviewDefaultMode,
);
if (visualReviewMode === "immediate") {
  console.error("Immediate Gemini visual review is disabled. Use --visual-review-mode=batch or --visual-review-mode=none.");
  process.exit(1);
}
const interpretVisualChanges = visualReviewMode !== "none";
const visualReviewBatchModel = geminiWorkerModel();
const snapshotHistoryPrune = boolArg(
  args["snapshot-history-prune"] ?? env.AWARDPING_SNAPSHOT_HISTORY_PRUNE,
  true,
);
const snapshotHistoryPruneKeep = boundedInt(
  args["snapshot-history-prune-keep"] || env.AWARDPING_SNAPSHOT_HISTORY_PRUNE_KEEP,
  2,
  1,
  20,
);
const snapshotHistoryPruneBatchSize = boundedInt(
  args["snapshot-history-prune-batch-size"] || env.AWARDPING_SNAPSHOT_HISTORY_PRUNE_BATCH_SIZE,
  10_000,
  100,
  100_000,
);
const snapshotHistoryPruneMaxBatches = boundedInt(
  args["snapshot-history-prune-max-batches"] || env.AWARDPING_SNAPSHOT_HISTORY_PRUNE_MAX_BATCHES,
  5,
  1,
  100,
);
const r2Bucket = String(args["r2-bucket"] || env.R2_BUCKET || "awardping-snapshots").trim();
const r2AccountId = cleanText(args["r2-account-id"] || env.R2_ACCOUNT_ID);
const r2Endpoint = cleanText(
  args["r2-endpoint"] ||
    env.R2_ENDPOINT ||
    (r2AccountId ? `https://${r2AccountId}.r2.cloudflarestorage.com` : ""),
);
const r2AccessKeyId = cleanText(args["r2-access-key-id"] || env.R2_ACCESS_KEY_ID);
const r2SecretAccessKey = cleanText(args["r2-secret-access-key"] || env.R2_SECRET_ACCESS_KEY);
const aiRequired = runRequiresAi();
const aiDisabledReason = aiRequired ? null : aiDisabledReasonForRun();
const aiProvider = aiRequired
  ? selectAiProviderForRun(requestedAiProvider, {
      gemini: env.GEMINI_API_KEY,
      openai: env.OPENAI_API_KEY,
      geminiCli: geminiCliPath,
    })
  : null;
const aiModel = modelForProvider(aiProvider);
let supabase = null;
let r2Client = null;
const hostLastFetchAt = new Map();
const hostWaitQueues = new Map();
let existingR2SnapshotSourceIds = new Set();
let knownBrokenSourceIds = null;
let lastBaselineCoverageProgressUpdateAt = 0;
let lastBaselineCoverageProgressProcessed = 0;
const crawlerUserAgent =
  cleanText(args["crawler-user-agent"] || env.AWARDPING_CRAWLER_USER_AGENT) ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

if (!supabaseUrl || !serviceRoleKey) {
  console.error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  process.exit(1);
}

if (shardIndex >= shardCount) {
  console.error(`Invalid shard index ${shardIndex}; shard index must be between 0 and ${shardCount - 1}.`);
  process.exit(1);
}

if (aiRequired && !aiProvider) {
  console.error(missingAiMessage(requestedAiProvider));
  process.exit(1);
}

if (resetPreviousSnapshot && !localizationRepair) {
  console.error("--reset-previous-snapshot=true is allowed only during localization repair.");
  process.exit(1);
}

if (aiReviewEvidenceCapture && !completeMissingBaselines) {
  console.error("--ai-review-evidence-capture=true requires --complete-missing-baselines=true.");
  process.exit(1);
}

if (aiReviewEvidenceCapture && !sourceIdFilter && sourceIdsFilter.size === 0) {
  console.error("--ai-review-evidence-capture=true requires --source-id or --source-ids-file.");
  process.exit(1);
}

if (r2SnapshotSync && (!r2Bucket || !r2Endpoint || !r2AccessKeyId || !r2SecretAccessKey)) {
  console.error(
    "R2 snapshot sync is enabled, but R2_BUCKET, R2_ACCOUNT_ID/R2_ENDPOINT, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY are required.",
  );
  process.exit(1);
}

process.on("uncaughtException", (error) => {
  if (isBrowserClosedError(error)) {
    console.log(`NONFATAL_BROWSER_CLOSED ${errorMessage(error)}`);
    return;
  }
  console.error(`UNCAUGHT ${errorMessage(error)}`);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  if (isBrowserClosedError(reason)) {
    console.log(`NONFATAL_BROWSER_CLOSED_REJECTION ${errorMessage(reason)}`);
    return;
  }
  console.error(`UNHANDLED_REJECTION ${errorMessage(reason)}`);
  process.exit(1);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    console.error(`SIGNAL ${signal}`);
    process.exit(signal === "SIGINT" ? 130 : 143);
  });
}

supabase = createSupabaseServiceClient(supabaseUrl, serviceRoleKey);

async function runOnce() {
  localBaselineEvidenceCache.clear();
  observedVisualReviewCandidateIds.clear();
  ensureArchiveDirectories();

  const startedAt = new Date().toISOString();
  const runStamp = timestampForPath(startedAt);
  const attemptId = crypto.randomUUID();
  const monitoringDate = monitoringDateForTimestamp(startedAt);
  const runCohortId = requestedRunCohortId || (
    runTrigger === "scheduled"
      ? `visual-nightly:${monitoringDate}`
      : `visual-${runTrigger}:${runStamp}`
  );
  const reportPath = join(
    root,
    "reports",
    `visual-snapshot-run-${runStamp}-shard-${shardIndex + 1}-${attemptId.slice(0, 8)}.json`,
  );
  const report = {
    report_schema_version: 2,
    archive_root: archiveRoot,
    monitoring_policy: currentVisualReviewPolicyIdentity(),
    monitoring_policy_bundle: currentMonitoringPolicyAuditIdentity(),
    suppression_policy: changeEventSuppressionPolicyIdentity,
    run_identity: {
      workflow: "visual_capture",
      trigger: runTrigger,
      cohort_id: runCohortId,
      monitoring_date: monitoringDate,
      timezone: "America/Chicago",
      shard_count: shardCount,
      shard_index: shardIndex,
      attempt_id: attemptId,
    },
    worker_run_id: null,
    started_at: startedAt,
    heartbeat_at: startedAt,
    finished_at: null,
    status: "running",
    stop_reason: null,
    billing_blocked: false,
    blocking_reason: null,
    ai_provider: aiProvider || (aiRequired ? null : "disabled"),
    ai_model: aiModel,
    ai_required: aiRequired,
    ai_disabled_reason: aiDisabledReason,
    env_path: envPath,
    options: {
      limit,
      shard_count: shardCount,
      shard_index: shardCount > 1 ? shardIndex : null,
      shard_key: shardCount > 1 ? "source_url_hostname" : null,
      run_trigger: runTrigger,
      run_cohort_id: runCohortId,
      include_not_due: includeNotDue,
      source_id: sourceIdFilter || null,
      source_url: sourceUrlFilter || null,
      award: awardFilter || null,
      baseline_refresh: baselineRefresh,
      promote,
      pdf_only: pdfOnly,
      web_only: webOnly,
      complete_missing_baselines: completeMissingBaselines,
      ai_review_evidence_capture: aiReviewEvidenceCapture,
      complete_missing_batch_limit: completeMissingBatchLimit || null,
      prioritize_missing_baselines: prioritizeMissingBaselines,
      prioritize_issue_sources: prioritizeIssueSources,
      skip_existing_baseline: skipExistingBaseline,
      keep_unchanged: keepUnchanged,
      keep_rejected: keepRejected,
      keep_rejected_evidence: keepRejectedEvidence,
      accept_text_only_noise: acceptTextOnlyNoise,
      capture_profile: captureProfile,
      section_extraction_profile: sectionExtractionProfile,
      extract_expandable_sections: extractExpandableSections,
      include_section_text_in_main_hash: includeSectionTextInMainHash,
      capture_section_evidence: captureSectionEvidence,
      localization_repair: localizationRepair,
      reset_previous_snapshot: resetPreviousSnapshot,
      force_r2_snapshot_refresh: forceR2SnapshotRefresh,
      review_on_ai_failure: reviewOnAiFailure,
      viewport_width: viewportWidth,
      viewport_height: viewportHeight,
      jpeg_quality: jpegQuality,
      thumb_width: thumbWidth,
      max_expansion_state_screenshots: maxExpansionStateScreenshots,
      discovery_mode: discoveryMode,
      discover_pdf_subpages_requested: discoverPdfSubpagesRequested,
      discover_html_subpages_requested: discoverHtmlSubpagesRequested,
      discover_pdf_subpages: discoverPdfSubpages,
      discover_html_subpages: discoverHtmlSubpages,
      max_html_subpage_discoveries: maxHtmlSubpageDiscoveries,
      max_discoveries_per_award: maxNewDiscoveriesPerAward,
      max_discoveries_per_source: maxNewDiscoveriesPerSource,
      max_discoveries_per_domain: maxNewDiscoveriesPerDomain,
      timeout_ms: timeoutMs,
      page_ready_timeout_ms: pageReadyTimeoutMs,
      capture_settle_stable_ms: captureSettleStableMs,
      capture_settle_max_ms: captureSettleMaxMs,
      capture_settle_poll_ms: captureSettlePollMs,
      capture_scroll_activation: captureScrollActivation,
      capture_scroll_step_ratio: captureScrollStepRatio,
      capture_scroll_wait_ms: captureScrollWaitMs,
      capture_scroll_final_wait_ms: captureScrollFinalWaitMs,
      capture_scroll_max_steps: captureScrollMaxSteps,
      source_timeout_ms: sourceTimeoutMs,
      visual_source_check_minutes: visualSourceCheckMinutes,
      delay_ms: delayMs,
      domain_delay_ms: domainDelayMs,
      max_sources_per_browser: maxSourcesPerBrowser,
      retry_access_blocked_captures: retryAccessBlockedCaptures,
      safe_redirect_url_update: safeRedirectUrlUpdate,
      web_concurrency: visualWebConcurrency,
      max_pdf_bytes: maxPdfBytes,
      r2_backfill_baselines: r2BackfillBaselines,
      r2_backfill_fast: r2BackfillFast,
      r2_backfill_skip_existing: r2BackfillSkipExisting,
      r2_backfill_concurrency: r2BackfillConcurrency,
      r2_operation_retries: r2OperationRetries,
      r2_repair_missing_snapshots: r2RepairMissingSnapshots,
      r2_snapshot_sync: r2SnapshotSync,
      r2_rehydrate_local_cache: r2SnapshotSync,
      r2_bucket: r2SnapshotSync ? r2Bucket : null,
      snapshot_history_prune: snapshotHistoryPrune,
      snapshot_history_prune_keep: snapshotHistoryPruneKeep,
      snapshot_history_prune_batch_size: snapshotHistoryPruneBatchSize,
      snapshot_history_prune_max_batches: snapshotHistoryPruneMaxBatches,
      gemini_cli_path: aiProvider === "gemini-cli" ? geminiCliPath : null,
      gemini_cli_model: aiProvider === "gemini-cli" ? geminiCliModel : null,
      gemini_cli_safe_models: aiProvider === "gemini-cli" ? geminiCliSafeModels : [],
      allow_unsafe_gemini_cli_model: allowUnsafeGeminiCliModel,
      ai_required: aiRequired,
      ai_disabled_reason: aiDisabledReason,
      gemini_cli_max_calls: geminiCliMaxCalls || null,
      gemini_api_max_calls: aiProvider === "gemini" ? geminiApiMaxCalls || null : null,
      gemini_api_daily_cost_cap_usd: aiProvider === "gemini" ? geminiApiDailyCostCapUsd : null,
      gemini_api_pricing_mode: aiProvider === "gemini" ? geminiApiPricingMode : null,
      visual_review_mode: visualReviewMode,
      visual_review_model: visualReviewMode === "batch" ? visualReviewBatchModel : aiModel,
      interpret_visual_changes: interpretVisualChanges,
      extract_baseline_info: extractBaselineInfo,
      backfill_baseline_info: backfillBaselineInfo,
    },
    checked: 0,
    baselined: 0,
    unchanged: 0,
    candidate_changes: 0,
    ai_true_changes: 0,
    ai_rejected: 0,
    evidence_sanity_corrected: 0,
    evidence_sanity_rejected: 0,
    text_only_ignored: 0,
    text_only_candidates: 0,
    deterministic_noise: 0,
    deterministic_source_rejected: 0,
    deterministic_noise_rejected: 0,
    text_only_candidate_enqueued: 0,
    text_only_noise_rejected: 0,
    text_only_published_or_queued: 0,
    visual_only_candidate_enqueued: 0,
    visual_review_candidate_observations: 0,
    visual_review_candidate_observation_failures: 0,
    visual_noise: 0,
    review: 0,
    skipped_existing_baseline: 0,
    skipped_pdf: 0,
    capture_behavior_refreshed: 0,
    blocked_page_captures: 0,
    page_ready_waits: 0,
    page_ready_timeouts: 0,
    page_ready_wait_ms: 0,
    capture_settle_waits: 0,
    capture_settle_timeouts: 0,
    capture_settle_wait_ms: 0,
    scroll_activation_runs: 0,
    scroll_activation_steps: 0,
    scroll_activation_wait_ms: 0,
    scroll_activation_changed: 0,
    issue_sources_loaded: 0,
    issue_sources_cleared: 0,
    issue_sources_still_failing: 0,
    issue_sources_new_failures: 0,
    access_block_retries: 0,
    safe_redirect_url_updates: 0,
    safe_redirect_url_update_skipped: 0,
    safe_redirect_url_update_failed: 0,
    failed: 0,
    promoted: 0,
    pdf_checked: 0,
    pdf_unchanged: 0,
    pdf_changed: 0,
    capture_profile: captureProfile,
    section_extraction_profile: sectionExtractionProfile,
    expandable_section_extraction_enabled: extractExpandableSections,
    section_baseline_created: 0,
    expandable_sections_detected: 0,
    expandable_sections_extracted: 0,
    expandable_sections_changed: 0,
    expandable_sections_added: 0,
    expandable_sections_removed: 0,
    expandable_section_identity_migrations: 0,
    section_addition_presence_conflicts: 0,
    section_removal_presence_conflicts: 0,
    section_change_candidates_blocked_unconfirmed: 0,
    section_change_candidates_enqueued: 0,
    section_change_candidates_overflow: 0,
    section_evidence_screenshots_taken: 0,
    section_text_included_in_main_hash: includeSectionTextInMainHash,
    section_text_included_in_baseline_facts: sectionExtractionConfig.includeInBaselineFacts,
    expanded_controls: 0,
    expansion_screenshots_taken: 0,
    expansion_screenshots_pruned: 0,
    r2_uploads_skipped_unchanged: 0,
    r2_uploads_skipped_noise: 0,
    main_content_hash_changed: 0,
    chrome_only_hash_changed: 0,
    discovered_pdf_candidates: 0,
    discovered_pdf_sources: 0,
    discovered_html_candidates: 0,
    discovered_html_sources: 0,
    discovery_mode: discoveryMode,
    discovery_candidates: 0,
    discovery_rejected_by_quality: 0,
    discovery_rejected_by_identity: 0,
    discovery_skipped_existing: 0,
    discovery_inserted_pending: 0,
    discovery_inserted_open: 0,
    discovery_rejection_reasons: {},
    discovery_cap_hits_by_award: {},
    discovery_cap_hits_by_domain: {},
    discovery_cap_hits_by_source: {},
    r2_uploaded: 0,
    r2_rotated: 0,
    r2_previous_snapshots_reset: 0,
    r2_failed: 0,
    r2_skipped_existing: 0,
    r2_repaired_missing: 0,
    r2_known_existing: 0,
    r2_known_missing: 0,
    r2_rehydrate_local_cache: 0,
    r2_rehydrated_local: 0,
    r2_rehydrated_local_exact_geometry: 0,
    r2_rehydrated_local_evidence_only: 0,
    r2_rehydrated_local_latest: 0,
    r2_rehydrated_local_previous: 0,
    r2_rehydration_refused: 0,
    r2_rehydration_failed: 0,
    r2_rehydration_reasons: {},
    snapshot_history_prune: {
      enabled: snapshotHistoryPrune,
      keep: snapshotHistoryPruneKeep,
      tables: {},
      skipped: false,
      error: null,
    },
    localization_repair_synced: 0,
    localization_repair_baselined: 0,
    localization_repair_skipped_changed: 0,
    localization_repair_skipped_missing_baseline: 0,
    localization_repair_skipped_pdf: 0,
    baseline_facts_extracted: 0,
    baseline_facts_failed: 0,
    baseline_facts_skipped: 0,
    baseline_facts_backfilled: 0,
    visual_interpreted: 0,
    visual_review_mode: visualReviewMode,
    visual_review_candidates_queued: 0,
    visual_review_candidates_existing: 0,
    visual_review_candidates_failed: 0,
    visual_review_rejected_evidence_absorbed: 0,
    visual_rejection_ledger_unavailable: 0,
    awards_queued_for_reconciliation: 0,
    award_reconciliation_queue_existing: 0,
    award_reconciliation_queue_failed: 0,
    published_updates: 0,
    publish_duplicates: 0,
    publish_failed: 0,
    gemini_usage: {
      calls: 0,
      prompt_tokens: 0,
      candidates_tokens: 0,
      total_tokens: 0,
      thoughts_tokens: 0,
      cached_content_tokens: 0,
      estimated_cost_usd: 0,
      max_calls: aiProvider === "gemini" ? geminiApiMaxCalls || null : null,
      daily_cost_cap_usd: aiProvider === "gemini" ? geminiApiDailyCostCapUsd : null,
      pricing_mode: aiProvider === "gemini" ? geminiApiPricingMode : null,
      note: "Gemini API responses include token usage but not AI Studio dollar spend. Use Google AI Studio Spend for account spend/cap dollars.",
    },
    gemini_cli_usage: {
      calls: 0,
      successes: 0,
      failures: 0,
      image_files: 0,
      view_file_calls: 0,
      stream_calls: 0,
      elapsed_ms: 0,
      model: aiProvider === "gemini-cli" ? geminiCliModel : null,
      note: "Gemini CLI / Antigravity does not expose exact token or account quota usage in worker logs. Check the Gemini account usage page for the account-level monthly allowance.",
    },
    errors: [],
    run_health: null,
    failure_groups: [],
    repair_plan: { requires_operator: false, actions: [] },
    saved_change_paths: [],
    review_paths: [],
    rejected_paths: [],
  };

  atomicWriteJson(reportPath, report);
  console.log(`REPORT_STARTED ${reportPath}`);
  const heartbeat = startRunHeartbeat(report, reportPath);
  const browserStates = new Set();
  const browserStatesByWorker = new Map();
  let workerRunId = null;
  let coverageSources = [];

  function browserStateForWorker(workerIndex) {
    const key = Number.isFinite(workerIndex) ? workerIndex : 0;
    if (!browserStatesByWorker.has(key)) {
      const state = {
        workerIndex: key,
        browser: null,
        context: null,
        browserMeta: null,
        sourcesSinceBrowserStart: 0,
      };
      browserStatesByWorker.set(key, state);
      browserStates.add(state);
    }
    return browserStatesByWorker.get(key);
  }

  async function closeBrowserState(state) {
    await state.context?.close().catch(() => null);
    await state.browser?.close().catch(() => null);
    state.context = null;
    state.browser = null;
    state.browserMeta = null;
    state.sourcesSinceBrowserStart = 0;
  }

  async function restartBrowser(state, reason) {
    await closeBrowserState(state);

    const launched = await launchBrowser();
    state.browser = launched.browser;
    state.browserMeta = launched.browserMeta;
    state.context = await createBrowserContext(state.browser);
    state.sourcesSinceBrowserStart = 0;

    if (reason) {
      console.log(`BROWSER worker=${state.workerIndex} restarted ${reason}`);
    }
  }

  async function processQueuedSource(source, workerIndex = 0) {
    const state = browserStateForWorker(workerIndex);
    const pdfSource = isPdfSource(source);
    if (pdfOnly && !pdfSource) {
      return;
    }
    if (webOnly && pdfSource) {
      return;
    }
    if (
      skipExistingBaselineEffective &&
      hasBaselineForSource(source) &&
      !needsPublishedSnapshotRepair(source)
    ) {
      report.skipped_existing_baseline += 1;
      console.log(`SKIP existing_baseline ${sourceLabel(source)}`);
      return;
    }

    if (!pdfSource && !state.context) {
      await restartBrowser(state, "initial");
    } else if (!pdfSource && state.sourcesSinceBrowserStart >= maxSourcesPerBrowser) {
      await restartBrowser(state, `after_${state.sourcesSinceBrowserStart}_sources`);
    }

    let retriedAfterBrowserRestart = false;
    let retriedAfterAccessBlock = false;
    while (true) {
      try {
        await waitForDomain(source.url);
        await withTimeout(
          processSource(source, state.context, state.browserMeta, report),
          sourceTimeoutMs,
          `source hard timeout after ${sourceTimeoutMs}ms`,
        );
        if (hasOpenSourceIssue(source)) {
          report.issue_sources_cleared += 1;
          console.log(`ISSUE_CLEARED ${sourceLabel(source)}`);
        }
        if (!pdfSource) state.sourcesSinceBrowserStart += 1;
        break;
      } catch (error) {
        if (
          !pdfSource &&
          !retriedAfterBrowserRestart &&
          (isBrowserClosedError(error) || isSourceTimeoutError(error))
        ) {
          console.log(`BROWSER closed ${sourceLabel(source)} | ${errorMessage(error)}`);
          await restartBrowser(state, "after_closed_context");
          retriedAfterBrowserRestart = true;
          continue;
        }

        if (
          !pdfSource &&
          retryAccessBlockedCaptures &&
          !retriedAfterAccessBlock &&
          isRetryableAccessBlockError(error)
        ) {
          report.access_block_retries += 1;
          console.log(`RETRY_ACCESS_BLOCK ${sourceLabel(source)} | ${errorMessage(error)}`);
          await restartBrowser(state, "after_access_block");
          retriedAfterAccessBlock = true;
          continue;
        }

        report.failed += 1;
        if (hasOpenSourceIssue(source)) {
          report.issue_sources_still_failing += 1;
        } else {
          report.issue_sources_new_failures += 1;
        }
        const message = errorMessage(error);
        report.errors.push({
          source_id: source.id,
          source_url: source.url,
          message,
        });
        await recordBrokenSourceFailure(source, message).catch((recordError) => {
          console.log(`BROKEN_SOURCE_LOG_FAILED ${errorMessage(recordError)} ${sourceLabel(source)}`);
        });
        await markSharedSourceVisualCheckFailed(source, message).catch((recordError) => {
          console.log(`SOURCE_STATUS_UPDATE_FAILED ${errorMessage(recordError)} ${sourceLabel(source)}`);
        });
        console.log(`FAILED ${message} ${sourceLabel(source)}`);

        if (!pdfSource && (isBrowserClosedError(error) || isSourceTimeoutError(error))) {
          await restartBrowser(state, "after_failed_closed_context");
        }
        break;
      }
    }

    await maybeUpdateBaselineCoverageProgress(workerRunId, report, coverageSources);
  }

  try {
    const supabaseHealth = await checkSupabaseHealth(supabase);
    if (!supabaseHealth.ok) {
      report.status = "blocked";
      report.stop_reason = "supabase_unavailable";
      report.errors.push({
        source_id: null,
        source_url: null,
        message: supabaseHealth.message,
      });
      console.log(
        `SUPABASE_UNAVAILABLE reason=${supabaseHealth.reason} message=${truncate(supabaseHealth.message, 500)}`,
      );
      return;
    }

    workerRunId = await startWorkerRun(report);
    report.worker_run_id = workerRunId;
    let sources = await loadSources(limit);
    coverageSources = sources;
    report.baseline_coverage_start = summarizeBaselineCoverage(coverageSources);
    console.log(formatBaselineCoverage("BASELINE_COVERAGE start", report.baseline_coverage_start));
    if (r2SnapshotSync && r2RepairMissingSnapshots) {
      existingR2SnapshotSourceIds = await loadExistingR2SnapshotSourceIds(sources.map((source) => source.id));
      report.r2_known_existing = existingR2SnapshotSourceIds.size;
      report.r2_known_missing = Math.max(0, sources.length - existingR2SnapshotSourceIds.size);
      console.log(
        `R2_REPAIR_SCAN loaded=${sources.length} existing=${report.r2_known_existing} missing=${report.r2_known_missing}`,
      );
    }
    await updateWorkerRunMetadata(workerRunId, report);

    if (r2BackfillBaselines) {
      await backfillR2Baselines(sources, workerRunId, report, coverageSources);
      report.status = "succeeded";
      report.baseline_coverage_finish = summarizeBaselineCoverage(await loadSources(limit));
      console.log(formatBaselineCoverage("BASELINE_COVERAGE finish", report.baseline_coverage_finish));
      await finishWorkerRun(workerRunId, "succeeded", null, report);
      return;
    }

    if (prioritizeMissingBaselines || completeMissingBaselines) {
      sources = orderSourcesForBaselineCoverage(sources);
    }

    if (prioritizeIssueSources) {
      sources = orderSourcesForIssueRepair(sources);
    }

    if (completeMissingBaselines) {
      const missingTargets = sources.filter((source) => needsMissingBaselineCompletion(source));
      const totalMissingTargets = missingTargets.length;
      const knownBrokenMissingTargets = missingTargets.filter(isKnownBrokenSource).length;
      // The ordinary completion scan avoids hammering known-broken URLs. The
      // explicit pre-AI evidence lane is different: every selected source gets
      // a bounded retry so a continuing failure can be durably moved out of
      // the AI/monitoring queue by the normal failure classifier.
      sources = aiReviewEvidenceCapture
        ? missingTargets
        : missingTargets.filter((source) => !isKnownBrokenSource(source));
      const actionableMissingTargets = aiReviewEvidenceCapture
        ? totalMissingTargets
        : totalMissingTargets - knownBrokenMissingTargets;
      if (completeMissingBatchLimit && sources.length > completeMissingBatchLimit) {
        sources = sources.slice(0, completeMissingBatchLimit);
      }
      report.baseline_completion = {
        total_missing_targets: totalMissingTargets,
        actionable_missing_targets: actionableMissingTargets,
        known_broken_missing_targets: knownBrokenMissingTargets,
        retried_known_broken_targets: aiReviewEvidenceCapture
          ? sources.filter(isKnownBrokenSource).length
          : 0,
        batch_targets: sources.length,
        batch_limit: completeMissingBatchLimit || null,
      };
      console.log(
        `BASELINE_COMPLETION targets=${sources.length} total_missing_targets=${totalMissingTargets} actionable_missing_targets=${actionableMissingTargets} known_broken_missing_targets=${knownBrokenMissingTargets} retry_known_broken=${aiReviewEvidenceCapture} batch_limit=${completeMissingBatchLimit || "all"}`,
      );
    }

    report.issue_sources_loaded = sources.filter(hasOpenSourceIssue).length;
    if (report.issue_sources_loaded > 0) {
      console.log(`ISSUE_REPAIR_QUEUE loaded=${report.issue_sources_loaded} total_sources=${sources.length}`);
    }
    await updateWorkerRunMetadata(workerRunId, report);

    if (visualWebConcurrency > 1) {
      console.log(
        `WEB_CONCURRENCY workers=${visualWebConcurrency} domain_delay_ms=${domainDelayMs} shard=${formatShardLabel()}`,
      );
      await runConcurrent(sources, visualWebConcurrency, async (source, _index, workerIndex) => {
        await processQueuedSource(source, workerIndex);
      });
    } else {
      for (const source of sources) {
        await processQueuedSource(source, 0);
      }
    }

    report.status = "succeeded";
    report.baseline_coverage_finish = summarizeBaselineCoverage(await loadSources(limit));
    console.log(formatBaselineCoverage("BASELINE_COVERAGE finish", report.baseline_coverage_finish));
    await finishWorkerRun(workerRunId, "succeeded", null, report);
  } catch (error) {
    report.status = "failed";
    report.failed += 1;
    report.errors.push({
      source_id: null,
      source_url: null,
      message: errorMessage(error),
    });
    await finishWorkerRun(workerRunId, "failed", errorMessage(error), report);
    throw error;
  } finally {
    await Promise.all([...browserStates].map((state) => closeBrowserState(state)));
    clearInterval(heartbeat);
    if (snapshotHistoryPrune && report.status !== "blocked") {
      await maybePruneSnapshotHistory(report);
    }
    report.finished_at = new Date().toISOString();
    report.heartbeat_at = report.finished_at;
    annotateVisualRunReport(report);
    atomicWriteJson(reportPath, report);
    console.log(`REPORT ${reportPath}`);
    await maybeWriteNightlyVisualReport(report, reportPath);
  }
}

async function maybeWriteNightlyVisualReport(report, reportPath) {
  if (!isDailyVisualShardReport(report)) return;

  const reportDir = dirname(reportPath);
  const monitoringDate = report.run_identity?.monitoring_date ||
    monitoringDateForTimestamp(report.started_at);
  let releaseLock = null;
  try {
    releaseLock = await acquireFileLock(join(reportDir, "visual-nightly-report.lock"));
    const reports = readdirSync(reportDir)
      .filter((name) => /^visual-snapshot-run-.*\.json$/i.test(name))
      .filter((name) => {
        const filenameDate = monitoringDateForVisualReportFilename(name);
        return !filenameDate || filenameDate === monitoringDate;
      })
      .map((name) => readJsonIfExists(join(reportDir, name)))
      .filter(Boolean);
    const nightlyReport = buildNightlyVisualReport(reports, {
      monitoringDate,
      generatedAt: report.finished_at,
    });
    const datedPath = join(reportDir, `visual-nightly-report-${monitoringDate}.json`);
    const latestPath = join(reportDir, "visual-nightly-report-latest.json");
    atomicWriteJson(datedPath, nightlyReport);
    if (shouldReplaceLatestNightlyReport(readJsonIfExists(latestPath), nightlyReport)) {
      atomicWriteJson(latestPath, nightlyReport);
    }
    console.log(`NIGHTLY_REPORT ${datedPath} status=${nightlyReport.status}`);
  } catch (error) {
    console.log(`NIGHTLY_REPORT_FAILED ${errorMessage(error)}`);
  } finally {
    releaseLock?.();
  }
}

function startRunHeartbeat(report, reportPath) {
  const intervalMs = heartbeatMinutes * 60 * 1000;
  const startedAtMs = Date.now();
  const timer = setInterval(() => {
    report.heartbeat_at = new Date().toISOString();
    try {
      atomicWriteJson(reportPath, report);
    } catch (error) {
      console.log(`REPORT_HEARTBEAT_FAILED ${errorMessage(error)}`);
    }
    const elapsedMinutes = Math.round((Date.now() - startedAtMs) / 60_000);
    const processed =
      report.checked + report.failed + report.skipped_existing_baseline + report.skipped_pdf;
    const coverage = report.baseline_coverage_progress || report.baseline_coverage_start || null;
    const coverageText = coverage
      ? ` coverage_existing=${coverage.existing_baselines} coverage_actionable_missing=${coverage.actionable_missing_baselines}`
      : "";
    console.log(
      `HEARTBEAT elapsed_minutes=${elapsedMinutes} status=${report.status} processed=${processed} checked=${report.checked} failed=${report.failed} baselined=${report.baselined} unchanged=${report.unchanged} ai_true_changes=${report.ai_true_changes} r2_uploaded=${report.r2_uploaded} r2_failed=${report.r2_failed}${coverageText}`,
    );
  }, intervalMs);

  timer.unref?.();
  return timer;
}

async function backfillR2Baselines(sources, workerRunId, report, coverageSources) {
  const targets = orderSourcesForBaselineCoverage(sources).filter((source) => {
    const pdfSource = isPdfSource(source);
    if (pdfOnly && !pdfSource) return false;
    if (webOnly && pdfSource) return false;
    return hasBaselineForSource(source);
  });
  const existingR2SourceIds = r2BackfillSkipExisting
    ? await loadExistingR2SnapshotSourceIds(targets.map((source) => source.id))
    : new Set();
  const pendingTargets = targets.filter((source) => !existingR2SourceIds.has(source.id));
  report.r2_skipped_existing += targets.length - pendingTargets.length;
  console.log(
    `R2_BASELINE_BACKFILL targets=${targets.length} pending=${pendingTargets.length} skipped_existing=${targets.length - pendingTargets.length} concurrency=${r2BackfillConcurrency} fast=${r2BackfillFast}`,
  );

  let completed = 0;
  await runConcurrent(pendingTargets, r2BackfillConcurrency, async (source) => {
    await backfillOneR2Baseline(source, report);
    completed += 1;
    if (completed === pendingTargets.length || completed % 25 === 0) {
      console.log(
        `R2_BASELINE_BACKFILL progress completed=${completed}/${pendingTargets.length} uploaded=${report.r2_uploaded} failed=${report.r2_failed}`,
      );
      await maybeUpdateBaselineCoverageProgress(workerRunId, report, coverageSources);
    }
  });
}

async function backfillOneR2Baseline(source, report) {
  return withVisualBaselineLockAsync({
    archiveRoot,
    sourceId: source.id,
    timeoutMs: 5 * 60_000,
    operation: () => backfillOneR2BaselineUnlocked(source, report),
  });
}

async function maybeRehydrateIncompleteLocalBaseline(source, baseline, report) {
  if (!r2SnapshotSync || !baseline || baselineEvidenceStatus(baseline).ok) {
    return { baseline, attempted: false, failureReason: null };
  }

  report.r2_rehydrate_local_cache += 1;
  let result;
  try {
    const snapshotRecord = await loadR2SnapshotRecord(source.id);
    const client = getR2Client();
    result = await rehydrateLocalBaselineFromR2({
      archiveRoot,
      source,
      baseline,
      snapshotRecord,
      bucket: r2Bucket,
      client,
      sendCommand: (createCommand, label) => sendR2Command(client, createCommand, label),
    });
  } catch (error) {
    result = {
      rehydrated: false,
      reason: "r2_snapshot_record_load_failed",
      detail: errorMessage(error),
    };
  }

  if (result.rehydrated) {
    report.r2_rehydrated_local += 1;
    if (result.localization_status === "exact_geometry_available") {
      report.r2_rehydrated_local_exact_geometry += 1;
    } else if (String(result.localization_status || "").startsWith("evidence_only_")) {
      report.r2_rehydrated_local_evidence_only += 1;
    }
    if (result.generation === "latest") report.r2_rehydrated_local_latest += 1;
    if (result.generation === "previous") report.r2_rehydrated_local_previous += 1;
    localBaselineEvidenceCache.set(source.id, true);
    console.log(
      `R2 LOCAL REHYDRATED generation=${result.generation} artifacts=${result.artifact_count} ${sourceLabel(source)}`,
    );
    return {
      baseline: result.baseline,
      attempted: true,
      failureReason: null,
      generation: result.generation,
    };
  }

  const reason = cleanText(result.reason) || "r2_local_rehydration_failed";
  if (isR2RehydrationOperationalFailure(reason)) report.r2_rehydration_failed += 1;
  else report.r2_rehydration_refused += 1;
  incrementCounterObject(report.r2_rehydration_reasons, reason);
  console.log(
    `R2 LOCAL REHYDRATION FAILED reason=${reason} detail=${truncate(result.detail || "unavailable", 500)} ${sourceLabel(source)}`,
  );
  return {
    baseline,
    attempted: true,
    failureReason: reason,
  };
}

function isR2RehydrationOperationalFailure(reason) {
  return new Set([
    "r2_snapshot_record_load_failed",
    "r2_object_download_failed",
    "r2_object_body_missing",
    "r2_local_rehydration_failed",
  ]).has(reason);
}

function incompleteLocalBaselineError(evidence, recovery) {
  const missing = Array.isArray(evidence?.missing) && evidence.missing.length
    ? evidence.missing.join(", ")
    : "required evidence";
  const recoveryDetail = recovery?.failureReason
    ? ` Exact R2 recovery failed (${recovery.failureReason}); the baseline was left untouched.`
    : " The baseline was left untouched.";
  return new Error(
    `Baseline exists but evidence is missing (${missing}).${recoveryDetail} Rerun with --baseline-refresh=true only after confirming the source.`,
  );
}

async function backfillOneR2BaselineUnlocked(source, report) {
  let baseline = readJsonIfExists(baselinePathForSource(source.id));
  const recovery = await maybeRehydrateIncompleteLocalBaseline(source, baseline, report);
  baseline = recovery.baseline;
  const capture = captureFromBaseline(baseline);
  if (!capture) {
    report.failed += 1;
    const recoveryDetail = recovery.failureReason
      ? ` Exact R2 recovery failed (${recovery.failureReason}).`
      : "";
    const message = `Baseline exists but could not be loaded for R2 backfill.${recoveryDetail}`;
    report.errors.push({
      source_id: source.id,
      source_url: source.url,
      message,
    });
    console.log(`R2 BACKFILL FAILED ${message} ${sourceLabel(source)}`);
    return;
  }

  report.checked += 1;
  if (capture.kind === "pdf") report.pdf_checked += 1;

  try {
    const result =
      r2BackfillFast && r2BackfillSkipExisting
        ? await syncR2BackfillLatestOnly(source, capture)
        : await syncR2SnapshotPair(source, capture);
    report.r2_uploaded += result.uploaded;
    report.r2_rotated += result.rotated;
    console.log(`R2 BACKFILL uploaded=${result.uploaded} rotated=${result.rotated} ${sourceLabel(source)}`);
  } catch (error) {
    report.r2_failed += 1;
    const message = `R2 baseline backfill failed: ${errorMessage(error)}`;
    report.errors.push({
      source_id: source.id,
      source_url: source.url,
      message,
    });
    console.log(`R2 BACKFILL FAILED ${message} ${sourceLabel(source)}`);
  }
}

async function processSource(source, context, browserMeta, report) {
  return withVisualBaselineLockAsync({
    archiveRoot,
    sourceId: source.id,
    timeoutMs: 5 * 60_000,
    operation: () => processSourceUnlocked(source, context, browserMeta, report),
  });
}

async function processSourceUnlocked(source, context, browserMeta, report) {
  const hygiene = shouldRejectDiscoveredSource({
    ...source,
    award_name: source.shared_awards?.name || "",
    source_url: source.url,
    source_title: source.title,
  });
  if (hygiene.action === "review_later") {
    await markSharedSourceReviewLater(source, hygiene);
    return;
  }

  const consolidation = classifySourceForConsolidation(source, source.shared_awards || {});
  if (consolidation.action === "review_later") {
    await markSharedSourceReviewLater(source, consolidation);
    return;
  }

  const baselinePath = baselinePathForSource(source.id);
  let baseline = readJsonIfExists(baselinePath);
  const recovery = baselineRefresh
    ? { baseline, failureReason: null }
    : await maybeRehydrateIncompleteLocalBaseline(source, baseline, report);
  baseline = recovery.baseline;
  const recoveredEvidence = baseline && !baselineRefresh
    ? baselineEvidenceStatus(baseline)
    : null;
  if (recoveredEvidence && !recoveredEvidence.ok) {
    throw incompleteLocalBaselineError(recoveredEvidence, recovery);
  }
  const pdfSource = isPdfSource(source);
  const capture = pdfSource
    ? await capturePdfSource(source)
    : await captureSource(source, context, browserMeta, report, { baseline });
  report.checked += 1;
  if (capture.kind === "pdf") {
    report.pdf_checked += 1;
  }

  const previous = baseline && !baselineRefresh
    ? readBaselineEvidence(baseline)
    : null;
  if (previous && !previous.ok) {
    throw incompleteLocalBaselineError(previous, recovery);
  }

  if (!baseline || baselineRefresh) {
    await maybeExtractBaselineFacts(source, capture, report, {
      reason: baseline ? "baseline_refresh" : "initial_baseline",
    });
    writeBaseline(source, capture, {
      reason: baseline ? "baseline_refresh" : "initial_baseline",
      previous_baseline: baseline || null,
      baseline_facts: capture.baseline_facts || null,
      baseline_facts_metadata: capture.baseline_facts_metadata || null,
    });
    report.baselined += 1;
    await maybeSyncR2Snapshot(source, capture, report, {
      reason: baseline ? "baseline_refresh" : "initial_baseline",
    });
    if (localizationRepair) report.localization_repair_baselined += 1;
    await markSharedSourceVisualCheckSucceeded(source, capture, report);
    console.log(`BASELINE ${capture.kind === "pdf" ? "PDF " : ""}${sourceLabel(source)}`);
    return;
  }

  if (needsCaptureBehaviorRefresh(baseline, capture)) {
    await maybeExtractBaselineFacts(source, capture, report, {
      reason: "capture_behavior_refresh",
    });
    writeBaseline(source, capture, {
      reason: "capture_behavior_refresh",
      previous_baseline: baseline || null,
      baseline_facts: capture.baseline_facts || baseline.summary_metadata?.baseline_facts || null,
      baseline_facts_metadata: capture.baseline_facts_metadata || null,
    });
    report.capture_behavior_refreshed += 1;
    await maybeSyncR2Snapshot(source, capture, report, { reason: "capture_behavior_refresh", unchanged: true });
    if (localizationRepair) report.localization_repair_synced += 1;
    await markSharedSourceVisualCheckSucceeded(source, capture, report);
    console.log(
      `BASELINE capture_behavior_refresh from=${baseline.capture_behavior_version || 0} to=${captureBehaviorVersion} ${sourceLabel(source)}`,
    );
    return;
  }

  if (localizationRepair) {
    await processLocalizationRepairSource(source, baseline, capture, report);
    return;
  }

  if (capture.kind === "pdf" || previous.kind === "pdf") {
    await processPdfComparison(source, baseline, previous, capture, report);
    return;
  }

  const hashComparison = compareStableCaptureHashes(baseline, capture, { profile: captureProfile });
  const screenshotChanged = hashComparison.screenshotChanged;
  const textChanged = hashComparison.textChanged;
  if (hashComparison.mainContentHashChanged) report.main_content_hash_changed += 1;
  if (hashComparison.chromeOnlyHashChanged) report.chrome_only_hash_changed += 1;

  if (!textChanged) {
    const sectionResult = await processExpandableSectionComparison(source, baseline, previous, capture, report, {
      allowFirstBaseline: !screenshotChanged || hashComparison.chromeOnlyHashChanged,
    });
    if (sectionResult.handled) return;
  }

  if (!screenshotChanged || (hashComparison.chromeOnlyHashChanged && !textChanged)) {
    if (textChanged) {
      await processTextOnlyComparison(source, baseline, previous, capture, report);
      return;
    }

    report.unchanged += 1;
    let baselineUpdatedForFacts = false;
    if (backfillBaselineInfo && !baselineHasFacts(baseline)) {
      await maybeExtractBaselineFacts(source, capture, report, {
        reason: "baseline_facts_backfill",
      });
      if (capture.baseline_facts) {
        writeBaseline(source, capture, {
          reason: "baseline_facts_backfill",
          previous_baseline: baseline || null,
          baseline_facts: capture.baseline_facts,
          baseline_facts_metadata: capture.baseline_facts_metadata || null,
        });
        baselineUpdatedForFacts = true;
        report.baseline_facts_backfilled += 1;
        await maybeSyncR2Snapshot(source, capture, report, { reason: "baseline_facts_backfill", unchanged: true });
      }
    }
    await maybeRepairMissingR2Snapshot(source, capture, report, { reason: "unchanged" });
    await markSharedSourceVisualCheckSucceeded(source, capture, report);
    console.log(
      hashComparison.chromeOnlyHashChanged
        ? `UNCHANGED chrome_only_hash_changed ${sourceLabel(source)}`
        : `UNCHANGED ${sourceLabel(source)}`,
    );
    if (!keepUnchanged && !baselineUpdatedForFacts) removeGeneratedCaptureDir(capture.dir);
    return;
  }

  const diff = buildDiffSummary(previous.text, capture.text, source);
  const deterministic = textChanged
    ? classifyDeterministicChange(diff, source)
    : {
        classification: "visual_candidate",
        reason: "screenshot_hash_changed_without_normalized_text_change",
        candidate_change: true,
      };

  report.candidate_changes += 1;
  if (!interpretVisualChanges) {
    await maybeRepairMissingR2Snapshot(source, capture, report, { reason: "visual_interpretation_disabled" });
    await markSharedSourceVisualCheckSucceeded(source, capture, report);
    pruneTransientExpansionStateScreenshots(capture, report);
    if (!keepUnchanged) removeGeneratedCaptureDir(capture.dir);
    console.log(`SKIP visual_interpretation_disabled ${sourceLabel(source)}`);
    return;
  }

  if (!deterministic.candidate_change) {
    await finishSafeDeterministicNoise({
      source,
      baseline,
      capture,
      report,
      reason: deterministic.reason || "local_diff_rejected",
    });
    return;
  }

  const gate = gateVisualReviewCandidateForAi({
    source,
    baseline,
    previous,
    capture,
    diff,
    deterministic,
    report,
  });
  if (!gate.allowed) {
    await finishSafeDeterministicNoise({
      source,
      baseline,
      capture,
      report,
      reason: gate.decision.reason || gate.decision.label || "deterministic_gate_noise",
      decision: gate.decision,
      countersAlreadyRecorded: true,
      textOnly: gate.decision.candidate_kind === "text_only",
    });
    return;
  }

  if (visualReviewMode === "batch") {
    const queueResult = await enqueueVisualReviewCandidate({
      source,
      baseline,
      previous,
      capture,
      diff,
      deterministic: gate.deterministic,
      report,
    });
    pruneTransientExpansionStateScreenshots(capture, report);
    await markSharedSourceVisualCheckSucceeded(source, capture, report);
    if (queueResult?.absorbed) {
      if (!keepUnchanged) removeGeneratedCaptureDir(capture.dir);
      console.log(`ABSORBED visual_review_rejected_evidence ${sourceLabel(source)}`);
    } else if (queueResult?.existing) {
      console.log(`EXISTING visual_review_candidate ${sourceLabel(source)}`);
    } else {
      console.log(`QUEUED visual_review_batch ${sourceLabel(source)}`);
    }
    return;
  }

  throw new Error(
    `Unsupported visual review mode \"${visualReviewMode}\": published changes require a retained batch candidate with immutable evidence.`,
  );
}

async function processLocalizationRepairSource(source, baseline, capture, report) {
  if (capture.kind === "pdf") {
    report.localization_repair_skipped_pdf += 1;
    console.log(`LOCALIZATION_REPAIR skip_pdf ${sourceLabel(source)}`);
    if (!keepUnchanged) removeGeneratedCaptureDir(capture.dir);
    return;
  }

  if (!baseline) {
    report.localization_repair_skipped_missing_baseline += 1;
    console.log(`LOCALIZATION_REPAIR skip_missing_baseline ${sourceLabel(source)}`);
    if (!keepUnchanged) removeGeneratedCaptureDir(capture.dir);
    return;
  }

  if (capture.image_hash && baseline.image_hash && capture.image_hash !== baseline.image_hash) {
    report.localization_repair_skipped_changed += 1;
    console.log(`LOCALIZATION_REPAIR skip_changed ${sourceLabel(source)}`);
    if (!keepUnchanged) removeGeneratedCaptureDir(capture.dir);
    return;
  }

  await maybeSyncR2Snapshot(source, capture, report, { reason: "localization_repair", unchanged: true });
  writeBaseline(source, capture, {
    reason: "localization_repair",
    previous_baseline: baseline || null,
    baseline_facts: baseline?.summary_metadata?.baseline_facts || null,
    baseline_facts_metadata: baseline?.summary_metadata?.baseline_facts_metadata || null,
  });
  report.localization_repair_synced += 1;
  report.unchanged += 1;
  await markSharedSourceVisualCheckSucceeded(source, capture, report);
  console.log(`LOCALIZATION_REPAIR synced ${sourceLabel(source)}`);
}

async function processTextOnlyComparison(source, baseline, previous, capture, report) {
  const diff = buildDiffSummary(previous.text || "", capture.text || "", source);
  const deterministic = {
    ...classifyDeterministicChange(diff, source),
    text_only: true,
    screenshot_changed: false,
  };

  report.candidate_changes += 1;
  report.text_only_candidates += 1;

  if (!deterministic.candidate_change) {
    await finishSafeDeterministicNoise({
      source,
      baseline,
      capture,
      report,
      reason: deterministic.reason || "text_only_deterministic_noise",
      textOnly: true,
    });
    return;
  }

  const gate = gateVisualReviewCandidateForAi({
    source,
    baseline,
    previous,
    capture,
    diff,
    deterministic,
    report,
  });

  if (!gate.allowed) {
    await finishSafeDeterministicNoise({
      source,
      baseline,
      capture,
      report,
      reason: gate.decision.reason || gate.decision.label || "text_only_gate_noise",
      decision: gate.decision,
      countersAlreadyRecorded: true,
      textOnly: true,
    });
    return;
  }

  if (!interpretVisualChanges) {
    const reviewPath = saveReviewRecord({
      source,
      baseline,
      previous,
      capture,
      diff,
      deterministic: gate.deterministic,
      reason: "text_only_visual_review_disabled",
      aiReview: {
        provider: "none",
        model: null,
        result: null,
        error: null,
      },
    });
    report.review += 1;
    report.review_paths.push(toArchiveRelative(reviewPath));
    pruneTransientExpansionStateScreenshots(capture, report);
    await markSharedSourceVisualCheckSucceeded(source, capture, report);
    console.log(`REVIEW text_only_visual_review_disabled ${sourceLabel(source)}`);
    return;
  }

  if (visualReviewMode === "batch") {
    const queueResult = await enqueueVisualReviewCandidate({
      source,
      baseline,
      previous,
      capture,
      diff,
      deterministic: gate.deterministic,
      report,
    });
    pruneTransientExpansionStateScreenshots(capture, report);
    await markSharedSourceVisualCheckSucceeded(source, capture, report);
    if (queueResult?.absorbed) {
      if (!keepUnchanged) removeGeneratedCaptureDir(capture.dir);
      console.log(`ABSORBED text_only_visual_rejected_evidence ${sourceLabel(source)}`);
    } else if (queueResult?.existing) {
      console.log(`EXISTING text_only_visual_candidate ${sourceLabel(source)}`);
    } else {
      report.text_only_published_or_queued += 1;
      console.log(`QUEUED text_only_visual_review_batch ${sourceLabel(source)}`);
    }
    return;
  }

  const reviewPath = saveReviewRecord({
    source,
    baseline,
    previous,
    capture,
    diff,
    deterministic: gate.deterministic,
    reason: "text_only_candidate_requires_batch_review",
    aiReview: {
      provider: "none",
      model: null,
      result: null,
      error: null,
    },
  });
  report.review += 1;
  report.review_paths.push(toArchiveRelative(reviewPath));
  pruneTransientExpansionStateScreenshots(capture, report);
  await markSharedSourceVisualCheckSucceeded(source, capture, report);
  console.log(`REVIEW text_only_candidate ${sourceLabel(source)}`);
}

async function processExpandableSectionComparison(
  source,
  baseline,
  previous,
  capture,
  report,
  { allowFirstBaseline = true } = {},
) {
  if (!extractExpandableSections || capture.kind === "pdf") return { handled: false, reason: "disabled" };
  const currentSections = canonicalizeExpandableSections(capture.expandable_sections);
  if (!currentSections.length) return { handled: false, reason: "no_sections" };

  const rawPreviousSections = Array.isArray(baseline?.expandable_sections) ? baseline.expandable_sections : [];
  const canonicalPreviousSections = canonicalizeExpandableSections(rawPreviousSections);
  const previousSections = new Map(
    canonicalPreviousSections
      .filter((section) => section?.section_key)
      .map((section) => [section.section_key, section]),
  );
  if (!previousSections.size) {
    if (!allowFirstBaseline) return { handled: false, reason: "missing_section_baseline_visible_change_pending" };
    writeBaseline(source, capture, {
      reason: "section_baseline_created",
      previous_baseline: baseline || null,
      baseline_facts: baseline?.summary_metadata?.baseline_facts || capture.baseline_facts || null,
      baseline_facts_metadata:
        baseline?.summary_metadata?.baseline_facts_metadata || capture.baseline_facts_metadata || null,
    });
    report.section_baseline_created += 1;
    report.unchanged += 1;
    await maybeRepairMissingR2Snapshot(source, capture, report, { reason: "section_baseline_created" });
    await markSharedSourceVisualCheckSucceeded(source, capture, report);
    console.log(`SECTION_BASELINE created sections=${currentSections.length} ${sourceLabel(source)}`);
    return { handled: true, reason: "section_baseline_created" };
  }

  const currentMap = new Map(currentSections.map((section) => [section.section_key, section]));
  const changedSections = [];
  const addedSections = [];
  const removedSections = [];
  report.expandable_section_identity_migrations += rawPreviousSections.filter((section, index) =>
    Boolean(
      section?.section_key &&
        canonicalPreviousSections[index]?.section_key &&
        section.section_key !== canonicalPreviousSections[index].section_key,
    ),
  ).length;

  for (const section of currentSections) {
    const previousSection = previousSections.get(section.section_key);
    if (!previousSection) {
      const presenceEvidence = sectionPresenceEvidence({
        changeKind: "added",
        section,
        previousPageText: previous.text,
        currentPageText: capture.text,
        previousMainContentHash: baseline.main_content_hash,
        currentMainContentHash: capture.main_content_hash,
        extractionEnabled: capture.section_extraction?.enabled,
        extractionError: capture.section_extraction?.error,
      });
      if (presenceEvidence.confirmed) {
        addedSections.push({ section, presenceEvidence });
      } else {
        report.section_addition_presence_conflicts += 1;
        report.section_change_candidates_blocked_unconfirmed += 1;
      }
    } else if (previousSection.text_hash && section.text_hash && previousSection.text_hash !== section.text_hash) {
      changedSections.push({ previousSection, section });
    }
  }

  for (const previousSection of previousSections.values()) {
    if (!currentMap.has(previousSection.section_key)) {
      const presenceEvidence = sectionPresenceEvidence({
        changeKind: "removed",
        section: previousSection,
        previousPageText: previous.text,
        currentPageText: capture.text,
        previousMainContentHash: baseline.main_content_hash,
        currentMainContentHash: capture.main_content_hash,
        extractionEnabled: capture.section_extraction?.enabled,
        extractionError: capture.section_extraction?.error,
      });
      if (presenceEvidence.confirmed) {
        removedSections.push({ previousSection, presenceEvidence });
      } else {
        report.section_removal_presence_conflicts += 1;
        report.section_change_candidates_blocked_unconfirmed += 1;
      }
    }
  }

  if (!changedSections.length && !addedSections.length && !removedSections.length) {
    return { handled: false, reason: "sections_unchanged" };
  }

  report.expandable_sections_changed += changedSections.length;
  report.expandable_sections_added += addedSections.length;
  report.expandable_sections_removed += removedSections.length;

  const sectionPairs = [
    ...changedSections,
    ...addedSections.map(({ section, presenceEvidence }) => ({
      previousSection: null,
      section,
      presenceEvidence,
    })),
    ...removedSections.map(({ previousSection, presenceEvidence }) => ({
      previousSection,
      section: null,
      presenceEvidence,
    })),
  ];

  let queued = 0;
  let rejectedAsNoise = 0;
  let preservedLastKnownGood = 0;
  let absorbed = 0;
  let existing = 0;
  let representativeNoiseDecision = null;
  const sectionReviewLimit = 24;
  const evaluatedSectionPairs = sectionPairs.slice(0, sectionReviewLimit);
  const unreviewedSectionPairs = Math.max(0, sectionPairs.length - evaluatedSectionPairs.length);
  for (const pair of evaluatedSectionPairs) {
    const result = await processOneSectionChange(source, baseline, previous, capture, report, pair);
    const outcome = typeof result === "string" ? result : result?.outcome;
    if (outcome === "queued") queued += 1;
    if (outcome === "noise") {
      rejectedAsNoise += 1;
      representativeNoiseDecision ||= result?.decision || null;
    }
    if (outcome === "preserve_last_known_good") preservedLastKnownGood += 1;
    if (outcome === "absorbed") absorbed += 1;
    if (outcome === "existing") existing += 1;
  }

  if (unreviewedSectionPairs > 0) {
    report.section_change_candidates_overflow += unreviewedSectionPairs;
    const reviewPath = saveReviewRecord({
      source,
      baseline,
      previous,
      capture,
      diff: {
        ...buildDiffSummary(previous.text || "", capture.text || "", source),
        candidate_scope: "expandable_section_overflow",
        section_change_count: sectionPairs.length,
        evaluated_section_change_count: evaluatedSectionPairs.length,
        unevaluated_section_change_count: unreviewedSectionPairs,
      },
      deterministic: {
        classification: "section_review_overflow",
        reason: "section_candidate_limit_exceeded",
        candidate_change: true,
      },
      reason: "section_candidate_limit_exceeded_preserve_last_known_good",
      aiReview: {
        provider: "none",
        model: null,
        result: null,
        error: null,
      },
    });
    report.review += 1;
    report.review_paths.push(toArchiveRelative(reviewPath));
  }

  if (queued > 0) {
    await markSharedSourceVisualCheckSucceeded(source, capture, report);
    console.log(`QUEUED section_visual_review_batch count=${queued} ${sourceLabel(source)}`);
    return { handled: true, reason: "section_candidates_queued" };
  }

  if (absorbed > 0 || existing > 0) {
    await markSharedSourceVisualCheckSucceeded(source, capture, report);
    if (existing === 0 && !keepUnchanged) removeGeneratedCaptureDir(capture.dir);
    console.log(`ABSORBED section_visual_evidence absorbed=${absorbed} existing=${existing} ${sourceLabel(source)}`);
    return { handled: true, reason: existing ? "section_candidates_existing" : "section_rejected_evidence_absorbed" };
  }

  if (unreviewedSectionPairs > 0) {
    await finishSafeDeterministicNoise({
      source,
      baseline,
      capture,
      report,
      reason: "section_candidate_limit_exceeded",
      decision: representativeNoiseDecision,
      countersAlreadyRecorded: true,
      textOnly: true,
      comparisonComplete: false,
    });
    return { handled: true, reason: "section_candidate_overflow_preserved" };
  }

  if (preservedLastKnownGood > 0) {
    await markSharedSourceVisualCheckSucceeded(source, capture, report);
    pruneTransientExpansionStateScreenshots(capture, report);
    if (!keepUnchanged) removeGeneratedCaptureDir(capture.dir);
    console.log(
      `PRESERVED last_known_good section_evidence count=${preservedLastKnownGood} ${sourceLabel(source)}`,
    );
    return { handled: true, reason: "section_last_known_good_preserved" };
  }

  if (rejectedAsNoise > 0) {
    const disposition = await finishSafeDeterministicNoise({
      source,
      baseline,
      capture,
      report,
      reason: "section_change_deterministic_noise",
      decision: representativeNoiseDecision,
      countersAlreadyRecorded: true,
      textOnly: true,
    });
    return {
      handled: true,
      reason: disposition.absorbed ? "section_noise_absorbed" : "section_noise_preserved",
    };
  }

  await markSharedSourceVisualCheckSucceeded(source, capture, report);
  if (!keepUnchanged) removeGeneratedCaptureDir(capture.dir);
  console.log(`NOISE section_changes_rejected count=${rejectedAsNoise} ${sourceLabel(source)}`);
  return { handled: true, reason: "section_noise_rejected" };
}

async function processOneSectionChange(
  source,
  baseline,
  previous,
  capture,
  report,
  { previousSection, section, presenceEvidence = null },
) {
  const beforeText = previousSection?.text || "";
  const afterText = section?.text || "";
  const displaySection = section || previousSection || {};
  const diff = {
    ...buildDiffSummary(beforeText, afterText, source),
    candidate_scope: "expandable_section",
    section_key: displaySection.section_key || null,
    section_label: displaySection.label || null,
    section_path: displaySection.section_path || null,
    previous_section_hash: previousSection?.text_hash || null,
    new_section_hash: section?.text_hash || null,
    exact_before_text: beforeText,
    exact_after_text: afterText,
    section_addition_confirmed: previousSection ? null : presenceEvidence?.confirmed === true,
    section_removal_confirmed: section ? null : presenceEvidence?.confirmed === true,
    section_presence_evidence: presenceEvidence,
  };
  const deterministic = {
    ...classifyDeterministicChange(diff, source),
    section_change: true,
    section_key: displaySection.section_key || null,
  };

  report.candidate_changes += 1;

  if ((!previousSection || !section) && presenceEvidence?.confirmed !== true) {
    report.deterministic_noise += 1;
    report.deterministic_noise_rejected += 1;
    report.text_only_noise_rejected += 1;
    report.section_change_candidates_blocked_unconfirmed += 1;
    return {
      outcome: "preserve_last_known_good",
      reason: "unconfirmed_section_presence",
    };
  }

  const sectionBaseline = {
    ...baseline,
    text_hash: previousSection?.text_hash || null,
    image_hash: baseline?.image_hash || null,
    file_hash: null,
  };
  const previousSectionCapture = {
    ...previous,
    text: beforeText,
    text_hash: previousSection?.text_hash || null,
    text_length: beforeText.length,
    section_key: displaySection.section_key || null,
    section_label: displaySection.label || null,
  };
  const currentSectionCapture = {
    ...capture,
    text: afterText,
    text_hash: section?.text_hash || null,
    text_length: afterText.length,
    section_key: displaySection.section_key || null,
    section_label: displaySection.label || null,
  };

  if (!deterministic.candidate_change) {
    report.deterministic_noise += 1;
    report.deterministic_noise_rejected += 1;
    report.text_only_noise_rejected += 1;
    return {
      outcome: "noise",
      decision: {
        label: deterministic.classification || "likely_noise",
        reason: deterministic.reason || "section_deterministic_noise",
        source_rejected: false,
      },
    };
  }

  const gate = gateVisualReviewCandidateForAi({
    source,
    baseline: sectionBaseline,
    previous: previousSectionCapture,
    capture: currentSectionCapture,
    diff,
    deterministic,
    report,
  });

  if (!gate.allowed) {
    return gate.decision?.source_rejected
      ? {
          outcome: "preserve_last_known_good",
          reason: gate.decision.reason || "section_source_rejected",
        }
      : {
          outcome: "noise",
          decision: gate.decision,
        };
  }

  if (!interpretVisualChanges || visualReviewMode !== "batch") {
    const reviewPath = saveReviewRecord({
      source,
      baseline: sectionBaseline,
      previous: previousSectionCapture,
      capture: currentSectionCapture,
      diff,
      deterministic: gate.deterministic,
      reason: "section_change_requires_batch_review",
      aiReview: {
        provider: "none",
        model: null,
        result: null,
        error: null,
      },
    });
    report.review += 1;
    report.review_paths.push(toArchiveRelative(reviewPath));
    return "queued";
  }

  const queueResult = await enqueueVisualReviewCandidate({
    source,
    baseline: sectionBaseline,
    previous: previousSectionCapture,
    capture: currentSectionCapture,
    diff,
    deterministic: gate.deterministic,
    report,
  });
  if (queueResult?.absorbed) return "absorbed";
  if (queueResult?.existing) return "existing";
  report.section_change_candidates_enqueued += 1;
  return "queued";
}

async function finishSafeDeterministicNoise({
  source,
  baseline,
  capture,
  report,
  reason,
  decision = null,
  countersAlreadyRecorded = false,
  textOnly = false,
  comparisonComplete = true,
}) {
  if (!countersAlreadyRecorded) {
    report.deterministic_noise += 1;
    report.deterministic_noise_rejected += 1;
    if (textOnly) report.text_only_noise_rejected += 1;
  }

  const baselineDisposition = deterministicNoiseBaselineDisposition({
    sourceRejected: Boolean(decision?.source_rejected),
    promote,
    acceptTextOnlyNoise,
    comparisonComplete,
  });
  let baselinePromoted = false;
  if (baselineDisposition.advance) {
    const monitoringDisposition = {
      classification: "deterministic_noise",
      label: decision?.label || null,
      reason,
      source_rejected: Boolean(decision?.source_rejected),
      text_only: textOnly,
    };
    capture.monitoring_disposition = monitoringDisposition;
    baselinePromoted = writeBaseline(source, capture, {
      reason: `deterministic_noise_absorbed:${reason}`,
      previous_baseline: baseline,
      previous_baseline_capture: baseline?.capture || null,
      baseline_facts: capture.baseline_facts || baseline?.summary_metadata?.baseline_facts || null,
      baseline_facts_metadata:
        capture.baseline_facts_metadata || baseline?.summary_metadata?.baseline_facts_metadata || null,
      monitoring_disposition: monitoringDisposition,
    });
    if (baselinePromoted) report.promoted += 1;
    if (baselinePromoted) {
      await maybeSyncR2Snapshot(source, capture, report, {
        reason: "deterministic_noise_absorbed",
        noise: textOnly,
        unchanged: textOnly,
      });
    }
  }

  await markSharedSourceVisualCheckSucceeded(source, capture, report);
  pruneTransientExpansionStateScreenshots(capture, report);
  if (!keepUnchanged && !baselinePromoted) removeGeneratedCaptureDir(capture.dir);
  if (baselinePromoted) {
    console.log(
      `ABSORBED deterministic_noise scope=${textOnly ? "text_only" : "whole_page"} ` +
        `reason=${reason || "deterministic_rejected"} ${sourceLabel(source)}`,
    );
  } else {
    console.log(
      `PRESERVED last_known_good deterministic_noise disposition=${baselineDisposition.reason} ` +
        `reason=${reason || "deterministic_rejected"} ${sourceLabel(source)}`,
    );
  }
  return { absorbed: baselinePromoted, disposition: baselineDisposition.reason };
}

async function enqueueVisualReviewCandidate({
  source,
  baseline,
  previous,
  capture,
  diff,
  deterministic,
  report,
}) {
  try {
    const monitoringPolicy = currentVisualReviewPolicyIdentity();
    const promptPayload = buildVisualReviewPromptPayload({
      source,
      baseline,
      previous,
      capture,
      diff,
      deterministic,
      promptChars,
      behaviorVersion: captureBehaviorVersion,
      behaviorName: captureBehaviorName,
      archiveRelative: toArchiveRelative,
    });
    const previousSnapshotRef = promptPayload.previous_snapshot_ref || null;
    const newSnapshotRef = promptPayload.new_snapshot_ref || null;
    const evidenceSignature = visualReviewEvidenceSignature({
      source,
      baseline,
      capture,
      previousSnapshotRef,
      newSnapshotRef,
      diff,
      deterministic,
      behaviorVersion: captureBehaviorVersion,
    });
    try {
      const ledger = await findVisualRejectionLedgerMatch(supabase, {
        sourceId: source?.id,
        evidenceSignature,
        policyHash: monitoringPolicy?.hash,
      });
      if (ledger.unavailable) {
        report.visual_rejection_ledger_unavailable += 1;
      } else if (ledger.match) {
        await touchVisualRejectionLedgerMatch(supabase, ledger.match);
        report.visual_review_rejected_evidence_absorbed += 1;
        return {
          absorbed: true,
          evidence_signature: evidenceSignature,
          rejection_reason: ledger.match.rejection_reason || "previously_policy_rejected",
        };
      }
    } catch (ledgerError) {
      report.visual_rejection_ledger_unavailable += 1;
      report.errors.push({
        source_id: source?.id || null,
        source_url: source?.url || null,
        message: `Visual rejection ledger lookup failed: ${errorMessage(ledgerError)}`,
      });
    }
    const candidateSignature = visualReviewCandidateSignature({
      source,
      baseline,
      capture,
      previousSnapshotRef,
      newSnapshotRef,
      diff,
      deterministic,
      behaviorVersion: captureBehaviorVersion,
    });
    const promptContext = buildVisualReviewPromptText(promptPayload);
    const row = {
      shared_award_id: source.shared_award_id,
      shared_award_source_id: source.id,
      candidate_signature: candidateSignature,
      source_url: source.url,
      source_title: source.title || null,
      source_page_type: source.page_type || null,
      previous_snapshot_ref: promptPayload.previous_snapshot_ref || {},
      new_snapshot_ref: promptPayload.new_snapshot_ref || {},
      previous_text_hash: baseline?.text_hash || null,
      new_text_hash: capture?.text_hash || null,
      previous_image_hash: baseline?.image_hash || null,
      new_image_hash: capture?.image_hash || null,
      previous_file_hash: baseline?.file_hash || null,
      new_file_hash: capture?.file_hash || null,
      deterministic_diff: diff || {},
      deterministic_classification: deterministic?.classification || deterministic?.reason || null,
      prompt_payload: promptPayload,
      prompt_context: promptContext,
      status: "pending",
      gemini_batch_request_key: candidateSignature,
      model: visualReviewBatchModel,
      estimated_cost_usd: null,
      actual_usage: {},
      worker_metadata: {
        queued_by: "capture-visual-snapshots",
        queued_at: new Date().toISOString(),
        worker_run_id: report.worker_run_id,
        capture_behavior_version: captureBehaviorVersion,
        capture_behavior_name: captureBehaviorName,
        visual_review_mode: visualReviewMode,
        monitoring_policy: monitoringPolicy,
        monitoring_policy_bundle: currentMonitoringPolicyAuditIdentity(),
        evidence_signature: evidenceSignature,
      },
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await supabase
      .from("shared_award_visual_review_candidates")
      .upsert(row, {
        onConflict: "candidate_signature",
        ignoreDuplicates: true,
      })
      .select("id,status")
      .maybeSingle();

    if (error) throw error;

    let candidate = data || null;
    if (!candidate?.id) {
      const { data: existingCandidate, error: existingError } = await supabase
        .from("shared_award_visual_review_candidates")
        .select("id,status")
        .eq("candidate_signature", candidateSignature)
        .maybeSingle();
      if (existingError) throw existingError;
      if (!existingCandidate?.id) {
        throw new Error(
          `Visual review candidate ${candidateSignature} was neither inserted nor found after duplicate-safe upsert.`,
        );
      }
      candidate = existingCandidate;
    }

    await recordVisualReviewCandidateRunObservation(candidate.id, report);

    if (data?.id) {
      capture.persist_expansion_state_screenshots = true;
      report.visual_review_candidates_queued += 1;
      await queueAwardReconciliationFromSource({
        source,
        report,
        reason: "visual_review_candidate",
        candidateIds: [candidate.id],
        priority: 80,
        metadata: {
          candidate_signature: candidateSignature,
          deterministic_classification: row.deterministic_classification,
          monitoring_policy: monitoringPolicy,
          monitoring_policy_bundle: currentMonitoringPolicyAuditIdentity(),
          evidence_signature: evidenceSignature,
          queued_by: "capture-visual-snapshots",
        },
      });
      return candidate;
    }

    report.visual_review_candidates_existing += 1;
    capture.persist_expansion_state_screenshots = true;
    return {
      id: candidate.id,
      status: candidate.status,
      existing: true,
      duplicate: true,
      candidate_signature: candidateSignature,
    };
  } catch (error) {
    report.visual_review_candidates_failed += 1;
    const message = `Visual review candidate enqueue failed: ${errorMessage(error)}`;
    report.errors.push({
      source_id: source.id,
      source_url: source.url,
      message,
    });
    console.log(`QUEUE FAILED ${message} ${sourceLabel(source)}`);
    throw error;
  }
}

async function recordVisualReviewCandidateRunObservation(candidateId, report) {
  if (!candidateId || observedVisualReviewCandidateIds.has(candidateId)) return;
  if (!report.worker_run_id) {
    report.visual_review_candidate_observation_failures += 1;
    throw new Error(
      "Cannot bind a visual review candidate to this capture because the durable worker run ID is unavailable.",
    );
  }
  const { error } = await supabase
    .from("shared_award_visual_review_candidate_run_observations")
    .upsert(
      {
        run_id: report.worker_run_id,
        candidate_id: candidateId,
      },
      {
        onConflict: "run_id,candidate_id",
        ignoreDuplicates: true,
      },
    );
  if (error) {
    report.visual_review_candidate_observation_failures += 1;
    throw new Error(
      `Visual review candidate run observation failed: ${error.message || String(error)}`,
    );
  }
  observedVisualReviewCandidateIds.add(candidateId);
  report.visual_review_candidate_observations += 1;
}

async function queueAwardReconciliationFromSource({
  source,
  report,
  reason,
  candidateIds = [],
  priority = 100,
  metadata = {},
}) {
  if (!source?.shared_award_id || !supabase) return null;
  try {
    const result = await enqueueAwardReconciliation(supabase, {
      awardId: source.shared_award_id,
      reason,
      sourceIds: [source.id],
      candidateIds,
      priority,
      metadata,
    });
    if (result.queued) report.awards_queued_for_reconciliation += 1;
    else report.award_reconciliation_queue_existing += 1;
    return result;
  } catch (error) {
    report.award_reconciliation_queue_failed += 1;
    report.errors.push({
      source_id: source.id,
      source_url: source.url,
      message: `Award reconciliation queue failed: ${errorMessage(error)}`,
    });
    console.log(`RECONCILE QUEUE FAILED ${errorMessage(error)} ${sourceLabel(source)}`);
    return null;
  }
}

async function processPdfComparison(source, baseline, previous, capture, report) {
  const previousHash = baseline.file_hash || baseline.image_hash;
  const fileChanged = capture.file_hash !== previousHash;
  const textChanged = capture.text_hash !== baseline.text_hash;

  if (!fileChanged) {
    report.unchanged += 1;
    report.pdf_unchanged += 1;
    await maybeRepairMissingR2Snapshot(source, capture, report, { reason: "pdf_unchanged" });
    await markSharedSourceVisualCheckSucceeded(source, capture, report);
    console.log(textChanged ? `UNCHANGED pdf_file_match_text_diff_ignored ${sourceLabel(source)}` : `UNCHANGED pdf_file_match ${sourceLabel(source)}`);
    if (!keepUnchanged) removeGeneratedCaptureDir(capture.dir);
    return;
  }

  const diff = buildDiffSummary(previous.text || "", capture.text || "", source);
  const deterministic = {
    classification: "candidate_change",
    reason: "pdf_file_hash_changed",
    candidate_change: true,
    previous_file_hash: previousHash || null,
    new_file_hash: capture.file_hash,
    previous_file_bytes: baseline.file_bytes || previous.meta?.file_bytes || null,
    new_file_bytes: capture.file_bytes,
  };

  report.candidate_changes += 1;
  report.pdf_changed += 1;

  if (!interpretVisualChanges) {
    await maybeRepairMissingR2Snapshot(source, capture, report, { reason: "pdf_visual_interpretation_disabled" });
    await markSharedSourceVisualCheckSucceeded(source, capture, report);
    if (!keepUnchanged) removeGeneratedCaptureDir(capture.dir);
    console.log(`SKIP visual_interpretation_disabled_pdf ${sourceLabel(source)}`);
    return;
  }

  if (!textChanged) {
    report.deterministic_noise += 1;
    report.deterministic_noise_rejected += 1;
    let baselinePromoted = false;
    if (promote) {
      baselinePromoted = writeBaseline(source, capture, {
        reason: "pdf_file_hash_changed_text_match_ignored",
        previous_baseline_capture: baseline.capture || null,
        baseline_facts: capture.baseline_facts || null,
        baseline_facts_metadata: capture.baseline_facts_metadata || null,
      });
      if (baselinePromoted) report.promoted += 1;
    }
    await markSharedSourceVisualCheckSucceeded(source, capture, report);
    console.log(`NOISE pdf_file_hash_changed_text_match_ignored ${sourceLabel(source)}`);
    if (!keepUnchanged && !baselinePromoted) removeGeneratedCaptureDir(capture.dir);
    return;
  }

  const gate = gateVisualReviewCandidateForAi({
    source,
    baseline,
    previous,
    capture,
    diff,
    deterministic,
    report,
  });
  if (!gate.allowed) {
    await markSharedSourceVisualCheckSucceeded(source, capture, report);
    if (!keepUnchanged) removeGeneratedCaptureDir(capture.dir);
    console.log(`NOISE deterministic_gate_pdf ${gate.decision.reason || gate.decision.label} ${sourceLabel(source)}`);
    return;
  }

  if (visualReviewMode === "batch") {
    const queueResult = await enqueueVisualReviewCandidate({
      source,
      baseline,
      previous,
      capture,
      diff,
      deterministic: gate.deterministic,
      report,
    });
    await markSharedSourceVisualCheckSucceeded(source, capture, report);
    if (queueResult?.absorbed) {
      if (!keepUnchanged) removeGeneratedCaptureDir(capture.dir);
      console.log(`ABSORBED visual_review_rejected_evidence_pdf ${sourceLabel(source)}`);
    } else if (queueResult?.existing) {
      console.log(`EXISTING visual_review_candidate_pdf ${sourceLabel(source)}`);
    } else {
      console.log(`QUEUED visual_review_batch_pdf ${sourceLabel(source)}`);
    }
    return;
  }

  const reviewPath = saveReviewRecord({
    source,
    baseline,
    previous,
    capture,
    diff,
    deterministic: gate.deterministic,
    reason: "pdf_file_hash_changed",
    aiReview: {
      provider: "none",
      model: null,
      result: null,
      error: null,
    },
  });

  report.review += 1;
  report.review_paths.push(toArchiveRelative(reviewPath));

  if (promote) {
    writeBaseline(source, capture, {
      reason: "pdf_file_hash_changed",
      previous_baseline_capture: baseline.capture || null,
    });
    report.promoted += 1;
    await maybeSyncR2Snapshot(source, capture, report, { reason: "pdf_review_promoted", unchanged: true });
  }
  await markSharedSourceVisualCheckSucceeded(source, capture, report);

  console.log(`REVIEW pdf_changed ${sourceLabel(source)}`);
}

async function capturePdfSource(source) {
  const capturedAt = new Date().toISOString();
  const captureStamp = timestampForPath(capturedAt);
  const sourceDir = join(archiveRoot, "sources", source.id);
  const captureDir = join(sourceDir, "captures", captureStamp);
  mkdirSync(captureDir, { recursive: true });

  const pdfPath = join(captureDir, "document.pdf");
  const textPath = join(captureDir, "text.txt");
  const metaPath = join(captureDir, "meta.json");
  const download = await fetchPdfSource(source.url);
  const fileHash = hashBuffer(download.buffer);
  const extracted = await extractPdfText(download.buffer);
  const text = normalizeVisibleText(extracted.text || "");
  const textHash = hashText(text);

  writeFileSync(pdfPath, download.buffer);
  writeFileSync(textPath, `${text}\n`, "utf8");

  const meta = {
    version: 1,
    kind: "pdf",
    source: sourceMetadata(source),
    captured_at: capturedAt,
    final_url: download.finalUrl,
    status_code: download.status,
    status_text: download.statusText,
    content_type: download.contentType,
    file_hash: fileHash,
    image_hash: fileHash,
    text_hash: textHash,
    text_length: text.length,
    file_bytes: download.buffer.length,
    page_title: source.title || null,
    page_count: extracted.pageCount,
    pdf_text_error: extracted.error,
    files: {
      pdf: toArchiveRelative(pdfPath),
      text: toArchiveRelative(textPath),
      meta: toArchiveRelative(metaPath),
    },
  };

  writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf8");

  return {
    ...meta,
    dir: captureDir,
    pdf_path: pdfPath,
    text_path: textPath,
    meta_path: metaPath,
    text,
  };
}

async function fetchPdfSource(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": crawlerUserAgent,
        Accept: "application/pdf,application/octet-stream,text/html;q=0.8,*/*;q=0.5",
      },
    });

    if (!response.ok) {
      throw new Error(`PDF download failed with HTTP ${response.status} ${response.statusText}`.trim());
    }

    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > maxPdfBytes) {
      throw new Error(`PDF is too large (${contentLength} bytes; limit ${maxPdfBytes} bytes)`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxPdfBytes) {
      throw new Error(`PDF is too large (${buffer.length} bytes; limit ${maxPdfBytes} bytes)`);
    }

    return {
      buffer,
      finalUrl: response.url || url,
      status: response.status,
      statusText: response.statusText,
      contentType: response.headers.get("content-type") || null,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function extractPdfText(buffer) {
  let parser = null;
  try {
    parser = new PDFParse({ data: new Uint8Array(buffer) });
    const result = await parser.getText();
    return {
      text: result.text || "",
      pageCount: result.total || null,
      error: null,
    };
  } catch (error) {
    return {
      text: "",
      pageCount: null,
      error: errorMessage(error),
    };
  } finally {
    await parser?.destroy().catch(() => null);
  }
}

async function captureSource(source, context, browserMeta, report, { baseline = null } = {}) {
  const capturedAt = new Date().toISOString();
  const captureStamp = timestampForPath(capturedAt);
  const sourceDir = join(archiveRoot, "sources", source.id);
  const captureDir = join(sourceDir, "captures", captureStamp);
  mkdirSync(captureDir, { recursive: true });

  const pagePath = join(captureDir, "page.jpg");
  const thumbPath = join(captureDir, "thumb.jpg");
  const textPath = join(captureDir, "text.txt");
  const expansionTextPath = join(captureDir, "expansion-text.txt");
  const sectionsTextPath = join(captureDir, "sections.txt");
  const sectionsJsonPath = join(captureDir, "sections.json");
  const layoutPath = join(captureDir, "layout.json");
  const metaPath = join(captureDir, "meta.json");
  const page = await context.newPage();

  let response = null;
  try {
    response = await page.goto(source.url, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });
    if (response && response.status() >= 400) {
      throw new Error(`Page load failed with HTTP ${response.status()} ${response.statusText()}`);
    }
    await page.waitForLoadState("networkidle", { timeout: Math.min(15_000, timeoutMs) }).catch(() => null);
    await page.evaluate(() => document.fonts?.ready).catch(() => null);
    if (delayMs > 0) await page.waitForTimeout(delayMs);
    const pageReadiness = await waitForMeaningfulPageContent(page);
    if (report) {
      if (pageReadiness.waited_ms > 0) report.page_ready_waits += 1;
      if (pageReadiness.timed_out) report.page_ready_timeouts += 1;
      report.page_ready_wait_ms += pageReadiness.waited_ms;
    }
    await page.addStyleTag({ content: stableCaptureCss }).catch(() => null);
    const initialHiddenNoise = await hideNoiseElements(page);
    // Capture each collapsed-section state before the whole-page expansion pass.
    // That keeps each candidate independent instead of inheriting panels forced
    // open for the main full-page capture.
    const expansionStateEvidence = await captureExpansionStateEvidence(page, context, captureDir, {
      source,
      profile: captureProfile,
    });
    if (report && expansionStateEvidence.error) {
      const message = `Capture geometry expansion-state evidence unavailable: ${expansionStateEvidence.error}`;
      report.errors.push({
        source_id: source.id,
        source_url: source.url,
        message,
      });
      console.log(`LOCALIZATION EVIDENCE ${message} ${sourceLabel(source)}`);
    }
    if (report && expansionStateEvidence.failures?.length) {
      for (const failure of expansionStateEvidence.failures) {
        const message =
          `Capture geometry expansion-state isolation unavailable for "${failure.label || failure.selector || "unknown control"}": ` +
          `${failure.error}`;
        report.errors.push({
          source_id: source.id,
          source_url: source.url,
          message,
          expansion_state_failure: failure,
        });
        console.log(`LOCALIZATION EVIDENCE ${message} ${sourceLabel(source)}`);
      }
    }
    if (report && expansionStateEvidence.states.length) {
      report.expanded_controls += expansionStateEvidence.states.length;
      report.expansion_screenshots_taken += expansionStateEvidence.states.length;
    }
    const expanded = await expandPageForSnapshot(page, {
      source,
      profile: captureProfile,
    });
    if (report) {
      report.expanded_controls +=
        (expanded?.details_opened || 0) +
        (expanded?.controls_clicked || 0) +
        (expanded?.panels_forced_open || 0);
    }
    await page.evaluate(() => {
      for (const video of document.querySelectorAll("video")) {
        video.pause?.();
        video.removeAttribute("autoplay");
      }
    }).catch(() => null);
    const initialScrollActivation = await activateScrollTriggeredContent(page, {
      source,
      profile: captureProfile,
    });
    await waitForPageSettledForSnapshot(page);

    let discoveredPdfLinks = [];
    let discoveredHtmlLinks = [];
    if (discoveryMode && discoverPdfSubpages) {
      discoveredPdfLinks = await discoverPdfLinksOnPage(page, source);
      await maybeRecordDiscoveredPdfSources(source, discoveredPdfLinks, expanded, report);
    }
    if (discoveryMode && discoverHtmlSubpages) {
      discoveredHtmlLinks = await discoverHtmlSubpageLinksOnPage(page, source);
      await maybeRecordDiscoveredHtmlSources(source, discoveredHtmlLinks, expanded, report);
    }

    // Expansion-state evidence and discovery can mutate page state. Re-establish the
    // final deterministic page once, then capture searchable text-node geometry and
    // the screenshot back-to-back so their coordinates cannot describe different DOMs.
    const finalExpanded = await expandPageForSnapshot(page, {
      source,
      profile: captureProfile,
    });
    expanded.final_state = finalExpanded;
    const scrollActivation = await activateScrollTriggeredContent(page, {
      source,
      profile: captureProfile,
    });
    const finalHiddenNoise = await hideNoiseElements(page);
    const hiddenNoise = mergeCountObjects(initialHiddenNoise, finalHiddenNoise);
    const counterStability = await waitForLikelyAnimatedCounterStability(page);
    const pageSettle = await waitForPageSettledForSnapshot(page);
    if (report) {
      if (!scrollActivation.skipped) report.scroll_activation_runs += 1;
      report.scroll_activation_steps += scrollActivation.steps || 0;
      report.scroll_activation_wait_ms += scrollActivation.waited_ms || 0;
      if (scrollActivation.changed || initialScrollActivation.changed) report.scroll_activation_changed += 1;
      if (pageSettle.waited_ms > 0) report.capture_settle_waits += 1;
      if (pageSettle.timed_out) report.capture_settle_timeouts += 1;
      report.capture_settle_wait_ms += pageSettle.waited_ms;
    }

    const pageTitle = await page.title().catch(() => "");
    const finalUrl = page.url();
    const dimensions = await page.evaluate(() => ({
      viewport_width: window.innerWidth,
      viewport_height: window.innerHeight,
      scroll_width: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth || 0),
      scroll_height: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0),
      device_pixel_ratio: window.devicePixelRatio || 1,
    }));
    const rawText = await page.evaluate(() => document.body?.innerText || "");
    const stableTextSamples = await extractStableTextBlockSamples(page);
    const textBlocks = buildStableTextBlocks({
      rawText,
      mainText: stableTextSamples.main_text,
      chromeText: stableTextSamples.nav_header_footer_text,
      expansionStates: expansionStateEvidence.states,
      profile: captureProfile,
    });
    const text = textBlocks.primary_text;
    const invalidCapture = classifyInvalidPageCapture({
      status: response?.status() || null,
      finalUrl,
      pageTitle,
      text,
      dimensions,
    });
    if (invalidCapture) {
      if (report) report.blocked_page_captures += 1;
      throw new Error(
        `Invalid capture page: ${invalidCapture.type} HTTP ${response?.status() || "unknown"} final_url=${finalUrl} title=${pageTitle || "untitled"} sample=${invalidCapture.sample}`,
      );
    }
    const textHash = textBlocks.text_hash;
    const finalTextGeometry = await captureStructuredVisibleTextGeometry(page, {
      capturedAt,
      stateId: "main",
    });
    const pageBuffer = await page.screenshot({
      path: pagePath,
      fullPage: true,
      type: "jpeg",
      quality: jpegQuality,
      timeout: timeoutMs,
    });
    const imageHash = hashBuffer(pageBuffer);
    const screenshotBinding = await screenshotBindingFromBuffer(pageBuffer, finalTextGeometry, {
      stateId: "main",
    });
    const textGeometry = bindVisualTextGeometry(finalTextGeometry, {
      capturedAt,
      imageHash,
      imageRef: toArchiveRelative(pagePath),
      screenshot: screenshotBinding,
    });
    writeFileSync(layoutPath, JSON.stringify(textGeometry, null, 2), "utf8");
    const thumbnail = await createThumbnail(context, pageBuffer);
    writeFileSync(thumbPath, thumbnail);
    writeFileSync(textPath, `${text}\n`, "utf8");
    if (textBlocks.expansion_text) {
      writeFileSync(expansionTextPath, `${textBlocks.expansion_text}\n`, "utf8");
    }
    const sections = extractExpandableSections
      ? await extractExpandableSectionsForCapture(page, captureDir, {
          source,
          baseline,
          profile: sectionExtractionProfile,
          captureEvidence: captureSectionEvidence,
        })
      : emptySectionExtractionResult(sectionExtractionProfile, "disabled");
    const sectionsText = sectionExtractionText(sections.sections);
    if (sectionsText) writeFileSync(sectionsTextPath, `${sectionsText}\n`, "utf8");
    writeFileSync(sectionsJsonPath, JSON.stringify(sections, null, 2), "utf8");
    if (report) {
      report.expandable_sections_detected += sections.detected || 0;
      report.expandable_sections_extracted += sections.extracted || 0;
      report.section_evidence_screenshots_taken += sections.evidence_screenshots_taken || 0;
    }

    const meta = {
      version: 1,
      kind: "webpage",
      capture_behavior_version: captureBehaviorVersion,
      capture_behavior_name: captureBehaviorName,
      source: sourceMetadata(source),
      captured_at: capturedAt,
      final_url: finalUrl,
      page_title: pageTitle,
      status_code: response?.status() || null,
      status_text: response?.statusText() || null,
      capture_profile: captureProfile,
      text_hash: textHash,
      body_text_hash: textBlocks.body_text_hash,
      main_content_hash: textBlocks.main_content_hash,
      nav_header_footer_hash: textBlocks.nav_header_footer_hash,
      expansion_hash: textBlocks.expansion_hash,
      section_extraction_profile: sectionExtractionProfile,
      expandable_section_extraction_enabled: extractExpandableSections,
      expandable_sections_detected: sections.detected || 0,
      expandable_sections_extracted: sections.extracted || 0,
      expandable_sections_hash: sections.sections_hash || null,
      section_text_included_in_main_hash: includeSectionTextInMainHash,
      section_text_included_in_baseline_facts: sectionExtractionConfig.includeInBaselineFacts,
      section_evidence_screenshots_taken: sections.evidence_screenshots_taken || 0,
      image_hash: imageHash,
      layout_hash: textGeometry.geometry_hash,
      text_length: text.length,
      body_text_length: textBlocks.body_text.length,
      main_content_text_length: textBlocks.main_content_text.length,
      nav_header_footer_text_length: textBlocks.nav_header_footer_text.length,
      expansion_text_length: textBlocks.expansion_text_length,
      page_bytes: pageBuffer.length,
      thumb_bytes: thumbnail.length,
      dimensions,
      browser: browserMeta,
      hidden_noise_counts: hiddenNoise,
      page_readiness: pageReadiness,
      scroll_activation: scrollActivation,
      page_settle: pageSettle,
      text_geometry: textGeometryReference(textGeometry, layoutPath),
      localization: captureLocalizationMetadata({
        kind: "webpage",
        capture_profile: captureProfile,
        capture_behavior_version: captureBehaviorVersion,
        captured_at: capturedAt,
        dimensions,
        page_settle: pageSettle,
        text_geometry: textGeometry,
      }),
      counter_stability: counterStability,
      expanded_content: expanded,
      expansion_state_candidates: expansionStateEvidence.candidates || 0,
      expansion_state_attempted: expansionStateEvidence.attempted || 0,
      expansion_text_in_primary_hash: captureProfileConfig.includeExpansionTextInPrimary,
      expansion_state_screenshots: expansionStateEvidence.states.map((state) => ({
        state_id: state.state_id,
        index: state.index,
        tag: state.tag || null,
        label: state.label,
        page: state.page,
        image_hash: state.image_hash,
        layout: state.layout,
        layout_hash: state.layout_hash,
        text_geometry: textGeometryReference(state.text_geometry, state.layout_path),
        text_hash: state.text_hash,
        text_length: state.text_length,
        page_bytes: state.page_bytes,
        isolation: state.isolation || null,
      })),
      expansion_state_error: expansionStateEvidence.error || null,
      expansion_state_failures: expansionStateEvidence.failures || [],
      discovered_pdf_links: discoveredPdfLinks.slice(0, 20),
      discovered_html_links: discoveredHtmlLinks.slice(0, 20),
      files: {
        page: toArchiveRelative(pagePath),
        thumb: toArchiveRelative(thumbPath),
        text: toArchiveRelative(textPath),
        expansion_text: textBlocks.expansion_text ? toArchiveRelative(expansionTextPath) : null,
        sections_text: sectionsText ? toArchiveRelative(sectionsTextPath) : null,
        sections_json: toArchiveRelative(sectionsJsonPath),
        layout: toArchiveRelative(layoutPath),
        meta: toArchiveRelative(metaPath),
        expansion_states: expansionStateEvidence.states.map((state) => ({
          state_id: state.state_id,
          label: state.label,
          page: state.page,
          layout: state.layout,
        })),
      },
    };

    writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf8");

    return {
      ...meta,
      dir: captureDir,
      page_path: pagePath,
      thumb_path: thumbPath,
      text_path: textPath,
      expansion_text_path: textBlocks.expansion_text ? expansionTextPath : null,
      layout_path: layoutPath,
      layout_hash: textGeometry.geometry_hash,
      text_geometry: textGeometry,
      meta_path: metaPath,
      sections_text_path: sectionsText ? sectionsTextPath : null,
      sections_json_path: sectionsJsonPath,
      expandable_sections: sections.sections,
      expandable_sections_hash: sections.sections_hash || null,
      section_extraction: sections,
      section_text_for_baseline_facts: sectionExtractionConfig.includeInBaselineFacts ? sectionsText : "",
      expansion_state_screenshots: expansionStateEvidence.states,
      text,
      body_text_hash: textBlocks.body_text_hash,
      main_content_hash: textBlocks.main_content_hash,
      nav_header_footer_hash: textBlocks.nav_header_footer_hash,
      expansion_hash: textBlocks.expansion_hash,
      body_text_length: textBlocks.body_text.length,
      main_content_text_length: textBlocks.main_content_text.length,
      nav_header_footer_text_length: textBlocks.nav_header_footer_text.length,
      expansion_text_length: textBlocks.expansion_text_length,
      section_text_length: sectionsText.length,
    };
  } finally {
    await page.close().catch(() => null);
  }
}

async function expandPageForSnapshot(page, { source = null, profile = captureProfile } = {}) {
  const configuredRelevanceMode = expansionRelevanceModeForSource(source, profile);
  const relevanceMode = configuredRelevanceMode === "none" && ["stable-daily", "localization-repair"].includes(profile)
    ? "award-content"
    : configuredRelevanceMode;
  if (relevanceMode === "none") {
    return {
      details_opened: 0,
      controls_clicked: 0,
      panels_forced_open: 0,
      passes: 0,
      skipped: true,
      reason: "capture_profile_minimal_expansion",
      capture_profile: profile,
    };
  }

  try {
    const result = await page.evaluate(async ({ relevanceMode }) => {
      const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
      const clickedKeys = new Set();
      const counts = {
        details_opened: 0,
        controls_clicked: 0,
        panels_forced_open: 0,
        passes: 0,
      };

      function textOf(element) {
        return (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
      }

      function signalFor(element) {
        return [
          element.id,
          element.className,
          element.getAttribute("aria-label"),
          element.getAttribute("aria-controls"),
          element.getAttribute("data-target"),
          element.getAttribute("data-bs-target"),
          element.getAttribute("data-toggle"),
          element.getAttribute("data-bs-toggle"),
          element.getAttribute("href"),
          textOf(element),
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
      }

      function isVisible(element) {
        if (!(element instanceof HTMLElement)) return false;
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          Number(style.opacity || 1) > 0
        );
      }

      function isSafeExpandableControl(element) {
        if (!(element instanceof HTMLElement)) return false;
        if (!isVisible(element)) return false;
        if (element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true") return false;

        const tag = element.tagName.toLowerCase();
        if (tag === "summary") return false;
        const href = element.getAttribute("href") || "";
        if (tag === "a" && href && !href.startsWith("#") && !href.toLowerCase().startsWith("javascript:")) {
          return false;
        }

        const signal = signalFor(element);
        if (/(menu|nav|navbar|search|login|log in|sign in|subscribe|newsletter|share|print|donate|cart|next|previous|prev|facebook|twitter|linkedin|instagram)/i.test(signal)) {
          return false;
        }

        const explicit =
          element.getAttribute("aria-expanded") === "false" ||
          /\bcollapse\b/.test(signal) ||
          /\baccordion\b/.test(signal) ||
          element.closest(".accordion, [class*='faq' i], [id*='faq' i]");

        const contentPattern =
          relevanceMode === "award-content"
            ? /\b(faq|question|answer|eligib|requirement|application|apply|guideline|instruction|document|pdf|form|materials?)\b/i
            : /\b(faq|question|answer|expand|show|more|details|eligib|requirement|application|apply|deadline|guideline|instruction|document|pdf|form|award|grant|materials?)\b/i;
        const targetSignal = panelTargetsFor(element).map((panel) => textOf(panel)).join(" ");
        const contentRelevant = contentPattern.test(`${signal} ${targetSignal}`);

        return Boolean(explicit && contentRelevant);
      }

      function openClosedDetails() {
        for (const details of document.querySelectorAll("details:not([open])")) {
          details.setAttribute("open", "");
          counts.details_opened += 1;
        }
      }

      function panelTargetsFor(element) {
        const selectors = [];
        for (const attr of ["aria-controls", "data-target", "data-bs-target", "href"]) {
          const value = element.getAttribute(attr);
          if (!value) continue;
          for (const token of value.split(/\s+/).filter(Boolean)) {
            if (token.startsWith("#") && token.length > 1) selectors.push(token);
            else if (/^[A-Za-z][\w:-]*$/.test(token)) selectors.push(`#${CSS.escape(token)}`);
          }
        }
        return selectors.flatMap((selector) => {
          try {
            return [...document.querySelectorAll(selector)];
          } catch {
            return [];
          }
        });
      }

      function forcePanelOpen(panel) {
        if (!(panel instanceof HTMLElement)) return;
        const before = panel.getAttribute("hidden") !== null || window.getComputedStyle(panel).display === "none";
        panel.hidden = false;
        panel.removeAttribute("hidden");
        panel.setAttribute("aria-hidden", "false");
        panel.classList.add("show", "open", "active");
        panel.style.setProperty("display", "block", "important");
        panel.style.setProperty("height", "auto", "important");
        panel.style.setProperty("max-height", "none", "important");
        panel.style.setProperty("visibility", "visible", "important");
        panel.style.setProperty("opacity", "1", "important");
        if (before) counts.panels_forced_open += 1;
      }

      // Accordion libraries commonly close an earlier item when a later item is
      // clicked. Re-open every safe target after all click side effects so the
      // final geometry and full-page screenshot include the relevant wording.
      const finalControls = [
        ...document.querySelectorAll(
          "button, [role='button'], a[data-toggle], a[data-bs-toggle], button[data-toggle], button[data-bs-toggle]",
        ),
      ].filter(isSafeExpandableControl);
      for (const control of finalControls.slice(0, 120)) {
        control.setAttribute("aria-expanded", "true");
        const details = control.closest("details");
        if (details) details.setAttribute("open", "");
        for (const panel of panelTargetsFor(control)) forcePanelOpen(panel);
      }
      openClosedDetails();

      for (let pass = 0; pass < 3; pass += 1) {
        counts.passes += 1;
        const controls = [
          ...document.querySelectorAll(
            "button, [role='button'], a[data-toggle], a[data-bs-toggle], button[data-toggle], button[data-bs-toggle]",
          ),
        ].filter(isSafeExpandableControl);

        for (const control of controls.slice(0, 120)) {
          const key = `${control.tagName}:${signalFor(control).slice(0, 220)}`;
          if (clickedKeys.has(key)) continue;
          clickedKeys.add(key);

          const beforeExpanded = control.getAttribute("aria-expanded");
          try {
            control.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
            control.click();
            control.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
            counts.controls_clicked += 1;
          } catch {
            // Continue opening other panels even if one control is custom and throws.
          }

          if (beforeExpanded === "false") control.setAttribute("aria-expanded", "true");
          for (const panel of panelTargetsFor(control)) {
            forcePanelOpen(panel);
          }
        }

        for (const panel of document.querySelectorAll(
          ".accordion-collapse:not(.show), .collapse:not(.show), [class*='faq' i] [hidden], [class*='accordion' i] [hidden]",
        )) {
          forcePanelOpen(panel);
        }

        openClosedDetails();
        await delay(180);
      }

      openClosedDetails();

      return counts;
    }, { relevanceMode });
    await page.waitForTimeout(350).catch(() => null);
    return {
      ...result,
      capture_profile: profile,
      relevance_mode: relevanceMode,
    };
  } catch (error) {
    return {
      details_opened: 0,
      controls_clicked: 0,
      panels_forced_open: 0,
      passes: 0,
      capture_profile: profile,
      relevance_mode: relevanceMode,
      error: errorMessage(error),
    };
  }
}

async function captureExpansionStateEvidence(page, context, captureDir, { source = null, profile = captureProfile } = {}) {
  if (maxExpansionStateScreenshots <= 0) {
    return { states: [], candidates: 0, attempted: 0, failures: [], error: null };
  }
  const configuredRelevanceMode = expansionRelevanceModeForSource(source, profile);
  const relevanceMode = configuredRelevanceMode === "none" && ["stable-daily", "localization-repair"].includes(profile)
    ? "award-content"
    : configuredRelevanceMode;
  if (!captureProfileSettings(profile).allowExpansionScreenshots && relevanceMode === "none") {
    return { states: [], candidates: 0, attempted: 0, failures: [], error: null, skipped: true };
  }
  if (relevanceMode === "none") {
    return { states: [], candidates: 0, attempted: 0, failures: [], error: null, skipped: true };
  }

  try {
    const setup = await page.evaluate(({ maxControls, relevanceMode }) => {
      function textOf(element) {
        return (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
      }

      function signalFor(element) {
        return [
          element.id,
          element.className,
          element.getAttribute("aria-label"),
          element.getAttribute("aria-controls"),
          element.getAttribute("data-target"),
          element.getAttribute("data-bs-target"),
          element.getAttribute("data-toggle"),
          element.getAttribute("data-bs-toggle"),
          element.getAttribute("href"),
          textOf(element),
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
      }

      function isVisible(element) {
        if (!(element instanceof HTMLElement)) return false;
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          Number(style.opacity || 1) > 0
        );
      }

      function controlledTextFor(element) {
        const values = [];
        for (const attr of ["aria-controls", "data-target", "data-bs-target", "href"]) {
          const value = element.getAttribute(attr);
          if (!value) continue;
          for (const token of value.split(/\s+/).filter(Boolean)) {
            const selector = token.startsWith("#")
              ? token
              : /^[A-Za-z][\w:-]*$/.test(token)
                ? `#${CSS.escape(token)}`
                : null;
            if (!selector) continue;
            try {
              for (const target of document.querySelectorAll(selector)) values.push(textOf(target));
            } catch {
              // Ignore malformed third-party selectors.
            }
          }
        }
        return values.join(" ");
      }

      function selectorFor(element) {
        if (element.id) return `#${CSS.escape(element.id)}`;
        const parts = [];
        let current = element;
        while (current && current !== document.documentElement) {
          const tag = current.tagName.toLowerCase();
          const siblings = current.parentElement
            ? [...current.parentElement.children].filter((sibling) => sibling.tagName === current.tagName)
            : [];
          const position = siblings.indexOf(current) + 1;
          parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${position})` : tag);
          current = current.parentElement;
        }
        return `html>${parts.join(">")}`;
      }

      function isExpandableStateControl(element) {
        if (!(element instanceof HTMLElement)) return false;
        if (!isVisible(element)) return false;
        if (element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true") return false;

        const tag = element.tagName.toLowerCase();
        const href = element.getAttribute("href") || "";
        if (tag === "a" && href && !href.startsWith("#") && !href.toLowerCase().startsWith("javascript:")) {
          return false;
        }

        const signal = signalFor(element);
        if (/(menu|nav|navbar|search|login|log in|sign in|subscribe|newsletter|share|print|donate|cart|next|previous|prev|facebook|twitter|linkedin|instagram)/i.test(signal)) {
          return false;
        }

        const explicit =
          tag === "summary" ||
          element.getAttribute("aria-expanded") !== null ||
          element.getAttribute("aria-controls") ||
          element.getAttribute("data-target") ||
          element.getAttribute("data-bs-target") ||
          element.getAttribute("data-toggle") ||
          element.getAttribute("data-bs-toggle") ||
          element.closest("details, .accordion, [class*='accordion' i], [class*='faq' i], [id*='faq' i], [role='tablist']");

        const contentPattern =
          relevanceMode === "award-content"
            ? /\b(faq|questions?|answers?|eligib(?:le|ility)?|requirements?|criteria|nominations?|applications?|process|apply|guidelines?|instructions?|documents?|pdf|forms?|materials?|amount|tuition|stipend)\b/i
            : /\b(faq|questions?|answers?|expand|show|more|details|eligib(?:le|ility)?|requirements?|criteria|nominations?|applications?|process|apply|deadlines?|guidelines?|instructions?|documents?|pdf|forms?|awards?|grants?|materials?|amount|tuition|stipend)\b/i;
        const contentRelevant = contentPattern.test(`${signal} ${controlledTextFor(element)}`);

        return Boolean(explicit && contentRelevant);
      }

      const controls = [
        ...document.querySelectorAll(
          [
            "summary",
            "details > :first-child",
            "button",
            "[role='button']",
            "[role='tab']",
            "a[href^='#']",
            "a[data-toggle]",
            "a[data-bs-toggle]",
            "button[data-toggle]",
            "button[data-bs-toggle]",
            "[onclick]",
            "[tabindex]",
            "[class*='accordion' i]",
            "[class*='toggle' i]",
            "[class*='elementor-tab-title' i]",
            "[class*='e-n-accordion-item-title' i]",
          ].join(", "),
        ),
      ]
        .filter(isExpandableStateControl)
        .slice(0, maxControls);

      return {
        candidates: controls.length,
        labels: controls.map((control, index) => ({
          index,
          tag: control.tagName,
          selector: selectorFor(control),
          id: control.id || null,
          label: textOf(control).slice(0, 120) || control.getAttribute("aria-label") || `Section ${index + 1}`,
          aria_controls: control.getAttribute("aria-controls") || null,
          data_target: control.getAttribute("data-target") || control.getAttribute("data-bs-target") || null,
          href: control.getAttribute("href") || null,
        })),
        base_text: document.body?.innerText || "",
      };
    }, { maxControls: maxExpansionStateScreenshots, relevanceMode });

    const states = [];
    const failures = [];
    const navigationUrl = cleanText(page.url()) || cleanText(source?.url);
    for (const candidate of setup.labels || []) {
      const stateNumber = states.length + 1;
      const stateId = `expansion-state-${String(stateNumber).padStart(2, "0")}`;
      const fileName = `expansion-state-${String(stateNumber).padStart(2, "0")}.jpg`;
      const pagePath = join(captureDir, fileName);
      const layoutPath = join(captureDir, `expansion-state-${String(stateNumber).padStart(2, "0")}-layout.json`);
      try {
        const state = await withIsolatedExpansionStatePage({
        context,
        url: navigationUrl,
        descriptor: candidate,
        descriptors: setup.labels,
        timeoutMs,
        preparePage: async (statePage) => {
          await statePage.waitForLoadState("networkidle", { timeout: Math.min(15_000, timeoutMs) }).catch(() => null);
          await statePage.evaluate(() => document.fonts?.ready).catch(() => null);
          if (delayMs > 0) await statePage.waitForTimeout(delayMs);
          await waitForMeaningfulPageContent(statePage);
          await statePage.addStyleTag({ content: stableCaptureCss }).catch(() => null);
          await hideNoiseElements(statePage);
          await statePage.evaluate(() => {
            for (const video of document.querySelectorAll("video")) {
              video.pause?.();
              video.removeAttribute("autoplay");
            }
          }).catch(() => null);
        },
        capture: async (statePage, openedIsolation) => {
          await activateScrollTriggeredContent(statePage, { source, profile });
          await hideNoiseElements(statePage);
          await waitForPageSettledForSnapshot(statePage);
          const isolation = await verifyExpansionStateIsolation(statePage, {
            descriptor: candidate,
            descriptors: setup.labels,
          });
          if (!isolation.verified) {
            throw new Error(
              `Capture geometry expansion state isolation failed for "${candidate.label}": ${isolation.reason}`,
            );
          }
          const stateCapturedAt = new Date().toISOString();
          const finalStateText = await statePage.evaluate(() => document.body?.innerText || "");
          const stateTextGeometry = await captureStructuredVisibleTextGeometry(statePage, {
            capturedAt: stateCapturedAt,
            stateId,
          });
          const pageBuffer = await statePage.screenshot({
            path: pagePath,
            fullPage: true,
            type: "jpeg",
            quality: jpegQuality,
            timeout: timeoutMs,
          });
          const imageHash = hashBuffer(pageBuffer);
          const screenshotBinding = await screenshotBindingFromBuffer(pageBuffer, stateTextGeometry, {
            stateId,
          });
          const textGeometry = bindVisualTextGeometry(stateTextGeometry, {
            capturedAt: stateCapturedAt,
            imageHash,
            imageRef: toArchiveRelative(pagePath),
            screenshot: screenshotBinding,
          });
          writeFileSync(layoutPath, JSON.stringify(textGeometry, null, 2), "utf8");

          const normalizedText = normalizeVisibleText(finalStateText);
          return {
            state_id: stateId,
            index: candidate.index,
            tag: candidate.tag || null,
            label: cleanText(candidate.label) || `Section ${stateNumber}`,
            page: toArchiveRelative(pagePath),
            page_path: pagePath,
            image_hash: imageHash,
            layout: toArchiveRelative(layoutPath),
            layout_path: layoutPath,
            layout_hash: textGeometry.geometry_hash,
            text_geometry: textGeometry,
            captured_at: stateCapturedAt,
            page_bytes: pageBuffer.length,
            text: normalizedText,
            text_hash: hashText(normalizedText),
            text_length: normalizedText.length,
            targets: candidate.aria_controls || candidate.data_target ? 1 : 0,
            isolation: {
              ...openedIsolation,
              ...isolation,
              fresh_page: true,
            },
          };
        },
        });
        states.push(state);
      } catch (error) {
        failures.push({
          index: candidate.index,
          label: candidate.label || null,
          selector: candidate.selector || null,
          error: errorMessage(error),
        });
      }
    }

    return {
      states,
      candidates: setup.candidates || 0,
      attempted: setup.labels?.length || 0,
      failures,
      error: null,
    };
  } catch (error) {
    return { states: [], candidates: 0, attempted: 0, failures: [], error: errorMessage(error) };
  }
}

function emptySectionExtractionResult(profile, reason) {
  return {
    profile,
    enabled: false,
    reason,
    detected: 0,
    extracted: 0,
    sections_hash: "",
    sections: [],
    evidence_screenshots_taken: 0,
    error: null,
  };
}

async function extractExpandableSectionsForCapture(
  page,
  captureDir,
  { source = null, baseline = null, profile = sectionExtractionProfile, captureEvidence = false } = {},
) {
  const settings = sectionExtractionProfileSettings(profile);
  const quality = sourceQualityDecision(source, { purpose: "monitoring" });
  if (!quality.allowed) {
    return emptySectionExtractionResult(profile, `source_quality_${quality.reason}`);
  }

  try {
    const raw = await page.evaluate(async ({ maxControls, allowForceOpenFallback, profileName }) => {
      const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

      function textOf(element) {
        return (element?.innerText || element?.textContent || "").replace(/\s+/g, " ").trim();
      }

      function visible(element) {
        if (!(element instanceof HTMLElement)) return false;
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          Number(style.opacity || 1) > 0
        );
      }

      function signalFor(element) {
        return [
          element.id,
          element.className,
          element.getAttribute("aria-label"),
          element.getAttribute("aria-controls"),
          element.getAttribute("data-target"),
          element.getAttribute("data-bs-target"),
          element.getAttribute("data-toggle"),
          element.getAttribute("data-bs-toggle"),
          element.getAttribute("href"),
          textOf(element),
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
      }

      function targetElementsFor(element) {
        const selectors = [];
        for (const attr of ["aria-controls", "data-target", "data-bs-target", "href"]) {
          const value = element.getAttribute(attr);
          if (!value) continue;
          for (const token of value.split(/\s+/).filter(Boolean)) {
            if (token.startsWith("#") && token.length > 1) selectors.push(token);
            else if (/^[A-Za-z][\w:-]*$/.test(token)) selectors.push(`#${CSS.escape(token)}`);
          }
        }
        return selectors.flatMap((selector) => {
          try {
            return [...document.querySelectorAll(selector)];
          } catch {
            return [];
          }
        });
      }

      function forcePanelOpen(panel) {
        if (!(panel instanceof HTMLElement)) return;
        panel.hidden = false;
        panel.removeAttribute("hidden");
        panel.setAttribute("aria-hidden", "false");
        panel.classList.add("show", "open", "active");
        panel.style.setProperty("display", "block", "important");
        panel.style.setProperty("height", "auto", "important");
        panel.style.setProperty("max-height", "none", "important");
        panel.style.setProperty("visibility", "visible", "important");
        panel.style.setProperty("opacity", "1", "important");
      }

      function isExpandableControl(element) {
        if (!(element instanceof HTMLElement)) return false;
        if (!visible(element)) return false;
        if (element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true") return false;
        const tag = element.tagName.toLowerCase();
        const href = element.getAttribute("href") || "";
        if (tag === "a" && href && !href.startsWith("#") && !href.toLowerCase().startsWith("javascript:")) {
          return false;
        }
        const interactive = ["button", "summary", "a"].includes(tag) ||
          ["button", "tab"].includes(element.getAttribute("role")) ||
          element.hasAttribute("onclick") || element.hasAttribute("tabindex") ||
          element.hasAttribute("aria-expanded") || element.hasAttribute("aria-controls") ||
          element.hasAttribute("data-target") || element.hasAttribute("data-bs-target") ||
          element.hasAttribute("data-toggle") || element.hasAttribute("data-bs-toggle");
        if (!interactive) return false;
        const signal = signalFor(element);
        if (/(menu|nav|navbar|search|login|log in|sign in|subscribe|newsletter|share|print|donate|cart|next|previous|prev|facebook|twitter|linkedin|instagram)/i.test(signal)) {
          return false;
        }
        const explicit =
          tag === "summary" ||
          element.getAttribute("aria-expanded") !== null ||
          element.getAttribute("aria-controls") ||
          element.getAttribute("data-target") ||
          element.getAttribute("data-bs-target") ||
          element.getAttribute("data-toggle") ||
          element.getAttribute("data-bs-toggle") ||
          element.closest("details, .accordion, [class*='accordion' i], [class*='faq' i], [id*='faq' i], [role='tablist']");
        const relevant =
          /\b(faq|question|answer|eligib|requirement|criteria|condition|nomination|application|process|apply|deadline|guideline|instruction|document|pdf|form|award|grant|materials?|amount|tuition|stipend|contact)\b/i.test(
            signal,
          );
        return Boolean(explicit && relevant);
      }

      function sectionContainerText(control, targets) {
        const targetText = targets.map(textOf).filter(Boolean).join("\n\n");
        if (targetText) return targetText;
        const details = control.closest("details");
        if (details) return textOf(details);
        const row = control.closest("li, section, article, .accordion-item, [class*='accordion' i], [class*='faq' i], div");
        return textOf(row).replace(textOf(control), "").trim();
      }

      const controls = [
        ...document.querySelectorAll(
          [
            "summary",
            "button",
            "[role='button']",
            "[role='tab']",
            "a[href^='#']",
            "a[data-toggle]",
            "a[data-bs-toggle]",
            "button[data-toggle]",
            "button[data-bs-toggle]",
            "[class*='accordion' i]",
            "[class*='toggle' i]",
            "[class*='elementor-tab-title' i]",
            "[class*='e-n-accordion-item-title' i]",
          ].join(", "),
        ),
      ].filter(isExpandableControl);

      const seen = new Set();
      const uniqueControls = controls.filter((control) => {
        const key = [
          control.tagName,
          control.id,
          control.getAttribute("aria-controls"),
          control.getAttribute("href"),
          textOf(control).slice(0, 140),
        ].join("|");
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }).slice(0, maxControls);

      uniqueControls.forEach((control, index) => {
        control.setAttribute("data-awardping-section-index", String(index));
      });

      const sections = [];
      for (const [index, control] of uniqueControls.entries()) {
        const beforeExpanded = control.getAttribute("aria-expanded");
        const beforeOpen = control.closest("details")?.hasAttribute("open") || false;
        const label = textOf(control).slice(0, 180) || control.getAttribute("aria-label") || `Section ${index + 1}`;
        const targetsBefore = targetElementsFor(control);

        control.scrollIntoView({ block: "center", inline: "nearest" });
        await delay(60);
        try {
          control.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
          control.click();
          control.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
        } catch {
          // Keep collecting other controls.
        }
        const details = control.closest("details");
        if (details) details.setAttribute("open", "");
        await delay(180);

        let targets = targetElementsFor(control);
        let text = sectionContainerText(control, targets);
        let usedFallback = false;
        if (allowForceOpenFallback && text.length < 40) {
          for (const panel of targetsBefore) forcePanelOpen(panel);
          if (details) details.setAttribute("open", "");
          await delay(120);
          targets = targetElementsFor(control);
          text = sectionContainerText(control, targets);
          usedFallback = true;
        }

        if (beforeExpanded === "false" && profileName === "stable-daily") {
          try {
            control.click();
          } catch {
            // Best-effort restore.
          }
          control.setAttribute("aria-expanded", "false");
        }
        if (!beforeOpen && details && profileName === "stable-daily") details.removeAttribute("open");

        sections.push({
          index,
          label,
          text,
          path: [
            control.tagName.toLowerCase(),
            control.id ? `#${control.id}` : null,
            control.getAttribute("aria-controls") ? `[aria-controls="${control.getAttribute("aria-controls")}"]` : null,
            control.getAttribute("href") ? `[href="${control.getAttribute("href")}"]` : null,
          ].filter(Boolean).join(""),
          target_count: targets.length,
          used_force_open_fallback: usedFallback,
        });
      }

      return {
        detected: uniqueControls.length,
        sections,
      };
    }, {
      maxControls: settings.maxControls,
      allowForceOpenFallback: settings.allowForceOpenFallback,
      profileName: settings.profile,
    });

    const sections = normalizeExtractedSections(raw.sections || []);
    const result = {
      profile,
      enabled: true,
      detected: raw.detected || 0,
      extracted: sections.length,
      sections_hash: hashSectionSnapshots(sections),
      sections,
      evidence_screenshots_taken: 0,
      error: null,
    };

    if (captureEvidence && baselineHasSectionSnapshots(baseline)) {
      const previousSections = baselineSectionMap(baseline);
      const changedSections = sections.filter((section) => {
        const previous = previousSections.get(section.section_key);
        return previous && previous.text_hash !== section.text_hash;
      });
      result.evidence = await captureSectionEvidenceScreenshots(page, captureDir, changedSections);
      result.evidence_screenshots_taken = result.evidence.length;
      const evidenceByKey = new Map(result.evidence.map((item) => [item.section_key, item]));
      result.sections = sections.map((section) => ({
        ...section,
        evidence: evidenceByKey.get(section.section_key) || null,
      }));
    }

    return result;
  } catch (error) {
    return {
      ...emptySectionExtractionResult(profile, "error"),
      enabled: true,
      error: errorMessage(error),
    };
  }
}

async function captureSectionEvidenceScreenshots(page, captureDir, sections) {
  if (!sections.length) return [];
  const evidenceDir = join(captureDir, "section-evidence");
  mkdirSync(evidenceDir, { recursive: true });
  const evidence = [];

  for (const section of sections.slice(0, 12)) {
    const result = await page.evaluate(async ({ index }) => {
      const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
      function targetElementsFor(element) {
        const selectors = [];
        for (const attr of ["aria-controls", "data-target", "data-bs-target", "href"]) {
          const value = element.getAttribute(attr);
          if (!value) continue;
          for (const token of value.split(/\s+/).filter(Boolean)) {
            if (token.startsWith("#") && token.length > 1) selectors.push(token);
            else if (/^[A-Za-z][\w:-]*$/.test(token)) selectors.push(`#${CSS.escape(token)}`);
          }
        }
        return selectors.flatMap((selector) => {
          try {
            return [...document.querySelectorAll(selector)];
          } catch {
            return [];
          }
        });
      }
      function forcePanelOpen(panel) {
        if (!(panel instanceof HTMLElement)) return;
        panel.hidden = false;
        panel.removeAttribute("hidden");
        panel.setAttribute("aria-hidden", "false");
        panel.classList.add("show", "open", "active");
        panel.style.setProperty("display", "block", "important");
        panel.style.setProperty("height", "auto", "important");
        panel.style.setProperty("max-height", "none", "important");
        panel.style.setProperty("visibility", "visible", "important");
        panel.style.setProperty("opacity", "1", "important");
      }
      function rectFor(element) {
        const rect = element.getBoundingClientRect();
        return {
          x: rect.left + window.scrollX,
          y: rect.top + window.scrollY,
          right: rect.right + window.scrollX,
          bottom: rect.bottom + window.scrollY,
        };
      }
      const control = document.querySelector(`[data-awardping-section-index="${index}"]`);
      if (!(control instanceof HTMLElement)) return null;
      control.scrollIntoView({ block: "center", inline: "nearest" });
      await delay(80);
      try {
        control.click();
      } catch {
        // Best-effort evidence only.
      }
      const details = control.closest("details");
      if (details) details.setAttribute("open", "");
      const targets = targetElementsFor(control);
      for (const target of targets) forcePanelOpen(target);
      await delay(200);
      const rects = [rectFor(control), ...targets.filter((target) => target instanceof HTMLElement).map(rectFor)];
      if (details) rects.push(rectFor(details));
      const left = Math.min(...rects.map((rect) => rect.x));
      const top = Math.min(...rects.map((rect) => rect.y));
      const right = Math.max(...rects.map((rect) => rect.right));
      const bottom = Math.max(...rects.map((rect) => rect.bottom));
      return {
        x: Math.max(0, Math.floor(left - 16)),
        y: Math.max(0, Math.floor(top - 16)),
        width: Math.max(120, Math.ceil(right - left + 32)),
        height: Math.max(80, Math.ceil(bottom - top + 32)),
      };
    }, { index: section.index });

    if (!result) continue;
    const fileName = `section-${String(evidence.length + 1).padStart(2, "0")}-${cleanSlug(section.section_key) || "section"}.jpg`;
    const path = join(evidenceDir, fileName);
    const clip = {
      x: result.x,
      y: result.y,
      width: Math.min(result.width, 1800),
      height: Math.min(result.height, 2200),
    };
    const buffer = await page.screenshot({
      path,
      clip,
      type: "jpeg",
      quality: jpegQuality,
      timeout: timeoutMs,
    });
    evidence.push({
      section_key: section.section_key,
      section_label: section.label,
      page: toArchiveRelative(path),
      page_path: path,
      image_hash: hashBuffer(buffer),
      page_bytes: buffer.length,
      clip,
    });
  }

  return evidence;
}

function normalizeExtractedSections(rawSections) {
  const normalized = rawSections
    .map((section, index) => {
      const label = cleanText(section.label) || `Section ${index + 1}`;
      const text = normalizeVisibleText(section.text || "");
      if (text.length < 20) return null;
      return {
        index: nonNegativeInt(section.index, index),
        label,
        section_path: cleanText(section.path) || null,
        text,
        text_hash: hashText(text),
        text_length: text.length,
        target_count: nonNegativeInt(section.target_count, 0),
        used_force_open_fallback: Boolean(section.used_force_open_fallback),
      };
    })
    .filter(Boolean);
  return canonicalizeExpandableSections(normalized);
}

function sectionExtractionText(sections = []) {
  return sections
    .map((section) => {
      const label = cleanText(section.label) || "Expandable section";
      const text = normalizeVisibleText(section.text || "");
      return text ? `${label}\n${text}` : "";
    })
    .filter(Boolean)
    .join("\n\n");
}

function hashSectionSnapshots(sections = []) {
  return hashText(
    canonicalizeExpandableSections(sections)
      .map((section) => `${section.section_key}\n${section.label}\n${section.text_hash}`)
      .join("\n\n"),
  );
}

function baselineHasSectionSnapshots(baseline) {
  return Array.isArray(baseline?.expandable_sections) && baseline.expandable_sections.length > 0;
}

function baselineSectionMap(baseline) {
  return new Map(
    canonicalizeExpandableSections(baseline?.expandable_sections)
      .filter((section) => section?.section_key)
      .map((section) => [section.section_key, section]),
  );
}

async function extractStableTextBlockSamples(page) {
  return page
    .evaluate(() => {
      function textOf(element) {
        return (element?.innerText || element?.textContent || "").replace(/\s+/g, " ").trim();
      }

      function visible(element) {
        if (!(element instanceof HTMLElement)) return false;
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          Number(style.opacity || 1) > 0
        );
      }

      const chromeSelectors = [
        "header",
        "nav",
        "footer",
        "aside",
        "[role='navigation']",
        "[role='banner']",
        "[role='contentinfo']",
        ".site-header",
        ".site-footer",
        ".navbar",
        ".navigation",
        ".menu",
        ".sidebar",
      ];
      const chromeText = [...document.querySelectorAll(chromeSelectors.join(","))]
        .filter(visible)
        .map(textOf)
        .filter(Boolean)
        .join("\n\n");

      const explicitMain = [...document.querySelectorAll("main, article, [role='main'], #main, #content, .main, .content")]
        .filter(visible)
        .map(textOf)
        .filter(Boolean)
        .sort((left, right) => right.length - left.length)[0];

      if (explicitMain && explicitMain.length >= 200) {
        return {
          main_text: explicitMain,
          nav_header_footer_text: chromeText,
        };
      }

      const clone = document.body?.cloneNode(true);
      if (clone instanceof HTMLElement) {
        for (const selector of chromeSelectors) {
          for (const element of clone.querySelectorAll(selector)) {
            element.remove();
          }
        }
        return {
          main_text: textOf(clone),
          nav_header_footer_text: chromeText,
        };
      }

      return {
        main_text: "",
        nav_header_footer_text: chromeText,
      };
    })
    .catch(() => ({
      main_text: "",
      nav_header_footer_text: "",
    }));
}

function textAddsMeaningfulExpansionContent(knownText, candidateText) {
  const known = normalizeVisibleText(knownText || "");
  const candidate = normalizeVisibleText(candidateText || "");
  if (candidate.length < 240) return false;
  if (!known) return true;
  if (known.includes(candidate.slice(0, Math.min(600, candidate.length)))) return false;

  const candidateShingles = textShingles(candidate);
  if (candidateShingles.length < 8) return candidate.length > known.length + 240;

  const knownShingles = new Set(textShingles(known));
  const newCount = candidateShingles.filter((shingle) => !knownShingles.has(shingle)).length;
  return newCount >= 8 && newCount / candidateShingles.length >= 0.08;
}

function textShingles(value) {
  const words = normalizeText(value)
    .split(/\s+/)
    .filter((word) => word.length >= 3)
    .slice(0, 5000);
  const shingles = [];
  for (let index = 0; index <= words.length - 6; index += 1) {
    shingles.push(words.slice(index, index + 6).join(" "));
  }
  return shingles;
}

async function waitForMeaningfulPageContent(page) {
  const startedAt = Date.now();
  const before = await pageReadinessSnapshot(page);
  const minTextLength = 500;

  if (before.text_length >= minTextLength && before.ready_state === "complete") {
    return {
      waited_ms: 0,
      timed_out: false,
      before,
      after: before,
    };
  }

  let timedOut = false;
  await page
    .waitForFunction(
      ({ minTextLength: requiredTextLength }) => {
        const text = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
        if (text.length >= requiredTextLength) return true;
        const mainText = [...document.querySelectorAll("main, article, [role='main'], #content, .content")]
          .map((element) => element.innerText || element.textContent || "")
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        return mainText.length >= requiredTextLength;
      },
      { minTextLength },
      { timeout: pageReadyTimeoutMs, polling: 500 },
    )
    .catch(() => {
      timedOut = true;
    });

  await page.waitForLoadState("networkidle", { timeout: Math.min(5_000, timeoutMs) }).catch(() => null);
  await page.waitForTimeout(250).catch(() => null);
  const after = await pageReadinessSnapshot(page);

  return {
    waited_ms: Date.now() - startedAt,
    timed_out: timedOut && after.text_length < minTextLength,
    before,
    after,
  };
}

async function activateScrollTriggeredContent(page, { source = null, profile = captureProfile } = {}) {
  const startedAt = Date.now();
  const before = await pageSettleSnapshot(page);
  const shouldActivate = shouldUseScrollActivationForSource(source, profile, captureScrollActivation);
  if (!shouldActivate) {
    return {
      skipped: true,
      reason: captureScrollActivation ? "capture_profile_scroll_activation_not_needed" : "capture_scroll_activation_disabled",
      capture_profile: profile,
      changed: false,
      steps: 0,
      waited_ms: 0,
      before: compactPageSettleSnapshot(before),
      after: compactPageSettleSnapshot(before),
    };
  }

  const result = await page
    .evaluate(
      async ({ finalWaitMs, maxSteps, stepRatio, waitMs }) => {
        const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
        const nextFrame = () => new Promise((resolveFrame) => requestAnimationFrame(() => resolveFrame()));
        const documentElement = document.documentElement;
        const body = document.body;
        const viewportHeight = Math.max(window.innerHeight || 0, 1);
        const stepSize = Math.max(120, Math.floor(viewportHeight * stepRatio));
        const startX = window.scrollX || 0;
        let scrollHeight = Math.max(documentElement.scrollHeight, body?.scrollHeight || 0, viewportHeight);
        let targetY = 0;
        let steps = 0;
        let maxScrollY = Math.max(0, scrollHeight - viewportHeight);

        const triggerAt = async (y) => {
          window.scrollTo(startX, Math.max(0, y));
          window.dispatchEvent(new Event("scroll"));
          document.dispatchEvent(new Event("scroll"));
          await nextFrame();
          await delay(waitMs);
        };

        await triggerAt(0);

        while (steps < maxSteps && targetY < maxScrollY) {
          targetY = Math.min(maxScrollY, targetY + stepSize);
          await triggerAt(targetY);
          steps += 1;
          scrollHeight = Math.max(documentElement.scrollHeight, body?.scrollHeight || 0, viewportHeight);
          maxScrollY = Math.max(0, scrollHeight - viewportHeight);
        }

        if (steps < maxSteps && targetY < scrollHeight) {
          await triggerAt(maxScrollY);
        }

        await delay(finalWaitMs);
        window.scrollTo(startX, 0);
        window.dispatchEvent(new Event("scroll"));
        document.dispatchEvent(new Event("scroll"));
        await nextFrame();
        await delay(Math.min(finalWaitMs, 500));

        return {
          steps,
          step_size: stepSize,
          viewport_height: viewportHeight,
          scroll_height: scrollHeight,
          hit_step_limit: steps >= maxSteps && targetY < maxScrollY,
        };
      },
      {
        finalWaitMs: captureScrollFinalWaitMs,
        maxSteps: captureScrollMaxSteps,
        stepRatio: captureScrollStepRatio,
        waitMs: captureScrollWaitMs,
      },
    )
    .catch((error) => ({
      steps: 0,
      step_size: 0,
      viewport_height: 0,
      scroll_height: 0,
      hit_step_limit: false,
      error: errorMessage(error),
    }));

  await page.waitForLoadState("networkidle", { timeout: Math.min(3_000, timeoutMs) }).catch(() => null);
  const forcedReveal = await forceScrollRevealElementsVisible(page);
  await page.waitForTimeout(Math.min(captureScrollWaitMs, 500)).catch(() => null);
  const after = await pageSettleSnapshot(page);
  const changed = before.signal !== after.signal;

  return {
    skipped: false,
    changed,
    waited_ms: Date.now() - startedAt,
    wait_ms: captureScrollWaitMs,
    final_wait_ms: captureScrollFinalWaitMs,
    capture_profile: profile,
    step_ratio: captureScrollStepRatio,
    max_steps: captureScrollMaxSteps,
    steps: result.steps || 0,
    step_size: result.step_size || 0,
    viewport_height: result.viewport_height || 0,
    scroll_height: result.scroll_height || 0,
    hit_step_limit: Boolean(result.hit_step_limit),
    forced_reveal_elements: forcedReveal.count || 0,
    forced_reveal_selectors: forcedReveal.selectors || [],
    error: result.error || null,
    before: compactPageSettleSnapshot(before),
    after: compactPageSettleSnapshot(after),
  };
}

async function forceScrollRevealElementsVisible(page) {
  return page
    .evaluate(() => {
      const selectors = [
        "[data-aos]",
        ".aos-init",
        ".aos-animate",
        ".elementor-invisible",
        ".animated",
        ".wow",
        ".slide-in-left",
        ".slide-in-right",
        ".slide-in-up",
        ".slide-in-down",
        ".fade-in",
        ".fadeIn",
        ".fadeInUp",
        ".fadeInDown",
        ".fadeInLeft",
        ".fadeInRight",
      ];
      const selector = selectors.join(",");
      let style = document.getElementById("awardping-scroll-reveal-visible-style");
      if (!style) {
        style = document.createElement("style");
        style.id = "awardping-scroll-reveal-visible-style";
        style.textContent = `
          ${selector} {
            opacity: 1 !important;
            transform: none !important;
            visibility: visible !important;
          }
          .elementor-invisible {
            visibility: visible !important;
          }
          [data-awardping-hidden-noise] {
            display: none !important;
            visibility: hidden !important;
          }
        `;
        (document.head || document.documentElement).appendChild(style);
      }

      let count = 0;
      const matchedSelectors = new Set();
      for (const element of document.querySelectorAll(selector)) {
        if (!(element instanceof HTMLElement)) continue;
        if (element.closest("[data-awardping-hidden-noise]")) continue;
        for (const candidate of selectors) {
          if (element.matches(candidate)) matchedSelectors.add(candidate);
        }
        element.classList.add("aos-animate");
        element.classList.remove("elementor-invisible");
        element.style.setProperty("opacity", "1", "important");
        element.style.setProperty("transform", "none", "important");
        element.style.setProperty("visibility", "visible", "important");
        count += 1;
      }

      return {
        count,
        selectors: [...matchedSelectors].slice(0, 20),
      };
    })
    .catch((error) => ({
      count: 0,
      selectors: [],
      error: errorMessage(error),
    }));
}

async function captureStructuredVisibleTextGeometry(page, { capturedAt = null, stateId = "main" } = {}) {
  try {
    return await captureVisibleTextGeometry(page, {
      capturedAt,
      stateId,
    });
  } catch (error) {
    throw new Error(`Capture geometry failed for screenshot state "${stateId}": ${errorMessage(error)}`, {
      cause: error,
    });
  }
}
async function screenshotBindingFromBuffer(buffer, geometry, { stateId = "main" } = {}) {
  try {
    const metadata = await sharp(buffer).metadata();
    const pixelWidth = positiveInt(metadata.width, 0);
    const pixelHeight = positiveInt(metadata.height, 0);
    if (!pixelWidth || !pixelHeight) {
      throw new Error("Sharp did not return positive JPEG dimensions.");
    }
    return screenshotBindingFromGeometry(geometry, {
      pixel_width: pixelWidth,
      pixel_height: pixelHeight,
    });
  } catch (error) {
    throw new Error(`Capture geometry image binding failed for screenshot state "${stateId}": ${errorMessage(error)}`, {
      cause: error,
    });
  }
}

function screenshotBindingFromGeometry(geometry, imageMetadata = {}) {
  const documentSize = geometry?.document || {};
  const devicePixelRatio = nonNegativeNumber(geometry?.device_pixel_ratio, 1) || 1;
  const cssWidth = nonNegativeNumber(documentSize.width, viewportWidth) || viewportWidth;
  const cssHeight = nonNegativeNumber(documentSize.height, viewportHeight) || viewportHeight;
  return {
    css_width: cssWidth,
    css_height: cssHeight,
    pixel_width: positiveInt(imageMetadata.pixel_width, Math.max(1, Math.round(cssWidth * devicePixelRatio))),
    pixel_height: positiveInt(imageMetadata.pixel_height, Math.max(1, Math.round(cssHeight * devicePixelRatio))),
  };
}

function textGeometryReference(geometry, layoutPath = null) {
  if (!geometry || typeof geometry !== "object") return null;
  return {
    version: geometry.version || 1,
    status: geometry.run_count > 0 ? "ready" : "unavailable_no_visible_text_nodes",
    geometry_hash: geometry.geometry_hash || null,
    coordinate_space: geometry.coordinate_space || "document-css-pixels",
    node_count: geometry.node_count || 0,
    run_count: geometry.run_count || 0,
    document: geometry.document || null,
    viewport: geometry.viewport || null,
    screenshot: geometry.screenshot || null,
    file: layoutPath ? toArchiveRelative(layoutPath) : null,
  };
}

function mergeCountObjects(...values) {
  const merged = {};
  for (const value of values) {
    for (const [key, count] of Object.entries(value || {})) {
      const number = Number(count);
      if (!Number.isFinite(number) || number <= 0) continue;
      merged[key] = (merged[key] || 0) + number;
    }
  }
  return merged;
}

async function waitForPageSettledForSnapshot(page) {
  const startedAt = Date.now();
  const before = await pageSettleSnapshot(page);
  let last = before;
  let lastChangedAt = startedAt;
  let changeCount = 0;

  while (Date.now() - startedAt < captureSettleMaxMs) {
    if (Date.now() - lastChangedAt >= captureSettleStableMs) {
      return {
        stable: true,
        timed_out: false,
        waited_ms: Date.now() - startedAt,
        stable_ms: captureSettleStableMs,
        max_ms: captureSettleMaxMs,
        poll_ms: captureSettlePollMs,
        change_count: changeCount,
        before: compactPageSettleSnapshot(before),
        after: compactPageSettleSnapshot(last),
        after_layout_sample: last.layout_sample || "",
      };
    }

    const remainingMaxMs = captureSettleMaxMs - (Date.now() - startedAt);
    const remainingStableMs = captureSettleStableMs - (Date.now() - lastChangedAt);
    const waitMs = Math.max(0, Math.min(captureSettlePollMs, remainingMaxMs, remainingStableMs));
    if (waitMs <= 0) break;
    await page.waitForTimeout(waitMs).catch(() => null);

    const current = await pageSettleSnapshot(page);
    if (current.signal !== last.signal) {
      changeCount += 1;
      lastChangedAt = Date.now();
    }
    last = current;
  }

  const stable = Date.now() - lastChangedAt >= captureSettleStableMs;
  return {
    stable,
    timed_out: !stable,
    waited_ms: Date.now() - startedAt,
    stable_ms: captureSettleStableMs,
    max_ms: captureSettleMaxMs,
    poll_ms: captureSettlePollMs,
    change_count: changeCount,
    before: compactPageSettleSnapshot(before),
    after: compactPageSettleSnapshot(last),
    after_layout_sample: last.layout_sample || "",
  };
}

async function waitForLikelyAnimatedCounterStability(page) {
  const startedAt = Date.now();
  const stableMs = 1_000;
  const maxMs = 5_000;
  const pollMs = 250;
  const before = await animatedCounterSnapshot(page);

  if (!before.has_likely_counter) {
    return {
      skipped: true,
      stable: true,
      waited_ms: 0,
      before,
      after: before,
    };
  }

  let last = before;
  let lastChangedAt = Date.now();

  while (Date.now() - startedAt < maxMs) {
    await page.waitForTimeout(pollMs).catch(() => null);
    const current = await animatedCounterSnapshot(page);
    if (current.hash !== last.hash || Math.abs(current.text_length - last.text_length) > 3) {
      last = current;
      lastChangedAt = Date.now();
      continue;
    }
    last = current;
    if (Date.now() - lastChangedAt >= stableMs) {
      return {
        skipped: false,
        stable: true,
        waited_ms: Date.now() - startedAt,
        before,
        after: current,
      };
    }
  }

  return {
    skipped: false,
    stable: false,
    waited_ms: Date.now() - startedAt,
    before,
    after: last,
  };
}

async function animatedCounterSnapshot(page) {
  const snapshot = await page
    .evaluate(() => {
      const visible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          Number(style.opacity || 1) > 0
        );
      };
      const counterSelector = [
        '[class*="counter" i]',
        '[id*="counter" i]',
        '[class*="countup" i]',
        '[id*="countup" i]',
        '[class*="stat" i]',
        '[id*="stat" i]',
        '[class*="metric" i]',
        '[id*="metric" i]',
        '[class*="number" i]',
        '[id*="number" i]',
        "[data-counter]",
        "[data-count]",
      ].join(",");
      const counterText = [...document.querySelectorAll(counterSelector)]
        .filter(visible)
        .map((element) => element.innerText || element.textContent || "")
        .join(" ");
      const bodyText = document.body?.innerText || "";
      const signalText = counterText || bodyText.slice(0, 12_000);
      const largeNumbers = signalText.match(/\b\d{3,}(?:,\d{3})*\b/g) || [];
      const hasCounterTerm =
        Boolean(counterText.trim()) ||
        /\b(counter|count[- ]?up|animated|animation|stat(?:istic)?s?|metric|kpi|impact number|number of|total number|participating universities|universities and colleges|scholarships awarded|awarded globally|total investment|investment amount)\b/i.test(
          signalText,
        );

      return {
        text: signalText.replace(/\s+/g, " ").trim().slice(0, 8_000),
        has_likely_counter: hasCounterTerm && largeNumbers.length >= 2,
        large_number_count: largeNumbers.length,
        counter_text_length: counterText.length,
      };
    })
    .catch(() => ({
      text: "",
      has_likely_counter: false,
      large_number_count: 0,
      counter_text_length: 0,
    }));

  const clean = normalizeText(snapshot.text || "");
  return {
    has_likely_counter: Boolean(snapshot.has_likely_counter),
    large_number_count: snapshot.large_number_count || 0,
    counter_text_length: snapshot.counter_text_length || 0,
    text_length: clean.length,
    hash: clean ? hashText(clean) : "",
  };
}

async function pageReadinessSnapshot(page) {
  return page
    .evaluate(() => {
      const text = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
      return {
        ready_state: document.readyState,
        text_length: text.length,
        link_count: document.links.length,
        image_count: document.images.length,
        script_count: document.scripts.length,
        scroll_height: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0),
        title: document.title || "",
      };
    })
    .catch((error) => ({
      ready_state: "unknown",
      text_length: 0,
      link_count: 0,
      image_count: 0,
      script_count: 0,
      scroll_height: 0,
      title: "",
      error: errorMessage(error),
    }));
}

async function pageSettleSnapshot(page) {
  const raw = await page
    .evaluate(() => {
      const body = document.body;
      const documentElement = document.documentElement;
      const bodyText = (body?.innerText || "").replace(/\s+/g, " ").trim();
      const textSample =
        bodyText.length > 32_000 ? `${bodyText.slice(0, 16_000)} ${bodyText.slice(-16_000)}` : bodyText;
      const scrollHeight = Math.max(documentElement.scrollHeight, body?.scrollHeight || 0);
      const scrollWidth = Math.max(documentElement.scrollWidth, body?.scrollWidth || 0, window.innerWidth);
      const layoutParts = [];
      let visibleElementCount = 0;
      let sampledElementCount = 0;
      const maxLayoutSamples = 1800;

      const addLayoutPart = (element, rect, style, forceSample = false) => {
        if (!forceSample && sampledElementCount >= maxLayoutSamples) return;
        if (forceSample && sampledElementCount >= maxLayoutSamples * 2) return;
        sampledElementCount += 1;
        const className = String(element.className || "")
          .replace(/\s+/g, ".")
          .slice(0, 80);
        const id = String(element.id || "").slice(0, 48);
        const label = `${element.tagName.toLowerCase()}${id ? `#${id}` : ""}${className ? `.${className}` : ""}`;
        const text = (element.innerText || element.textContent || "")
          .replace(/\s+/g, " ")
          .replace(/\|/g, " ")
          .trim()
          .slice(0, 220);
        const transform = style.transform && style.transform !== "none" ? style.transform.slice(0, 100) : "";
        layoutParts.push(
          [
            label,
            Math.round(rect.left + window.scrollX),
            Math.round(rect.top + window.scrollY),
            Math.round(rect.width),
            Math.round(rect.height),
            Math.round(Number(style.opacity || 1) * 100),
            style.position || "",
            transform,
            text,
          ].join(":"),
        );
      };

      for (const element of body ? body.querySelectorAll("*") : []) {
        if (!(element instanceof HTMLElement)) continue;
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        const opacity = Number(style.opacity || 1);
        if (
          rect.width <= 0 ||
          rect.height <= 0 ||
          style.display === "none" ||
          style.visibility === "hidden" ||
          opacity <= 0
        ) {
          continue;
        }

        visibleElementCount += 1;
        const tagName = element.tagName.toLowerCase();
        const elementText = (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
        const hasOwnText = Array.from(element.childNodes).some(
          (node) =>
            node.nodeType === Node.TEXT_NODE &&
            Boolean((node.textContent || "").replace(/\s+/g, " ").trim()),
        );
        const preferredTextElement =
          /^(h1|h2|h3|h4|h5|h6|p|li|dt|dd|td|th|caption|a|button|label|summary|figcaption|blockquote)$/i.test(
            tagName,
          );
        const transform = style.transform && style.transform !== "none";
        const fixedOrSticky = style.position === "fixed" || style.position === "sticky";
        const horizontalOffCanvas = rect.left < 0 || rect.right > window.innerWidth;
        const namedLikePanel = /\b(drawer|flyout|slide|side|sidebar|card|panel|modal|toast|popover)\b/i.test(
          `${element.id || ""} ${element.className || ""} ${element.getAttribute("role") || ""}`,
        );
        const shouldSampleText =
          elementText &&
          (preferredTextElement ||
            hasOwnText ||
            element.getAttribute("role") === "heading" ||
            element.childElementCount === 0);

        if (shouldSampleText || transform || fixedOrSticky || horizontalOffCanvas || namedLikePanel) {
          addLayoutPart(element, rect, style, transform || fixedOrSticky || horizontalOffCanvas || namedLikePanel);
        }
      }

      return {
        ready_state: document.readyState,
        text_length: bodyText.length,
        text_sample: textSample,
        link_count: document.links.length,
        image_count: document.images.length,
        script_count: document.scripts.length,
        visible_element_count: visibleElementCount,
        sampled_element_count: sampledElementCount,
        scroll_height: scrollHeight,
        scroll_width: scrollWidth,
        title: document.title || "",
        layout_sample: layoutParts.join("|").slice(0, 80_000),
      };
    })
    .catch((error) => ({
      ready_state: "unknown",
      text_length: 0,
      text_sample: "",
      link_count: 0,
      image_count: 0,
      script_count: 0,
      visible_element_count: 0,
      sampled_element_count: 0,
      scroll_height: 0,
      scroll_width: 0,
      title: "",
      layout_sample: "",
      error: errorMessage(error),
    }));

  const textHash = raw.text_sample ? hashText(normalizeText(raw.text_sample)) : "";
  const layoutHash = raw.layout_sample ? hashText(raw.layout_sample) : "";
  const signal = [
    raw.ready_state || "",
    raw.text_length || 0,
    textHash,
    layoutHash,
    raw.visible_element_count || 0,
    raw.link_count || 0,
    raw.image_count || 0,
    raw.scroll_height || 0,
    raw.scroll_width || 0,
    raw.title || "",
    raw.error || "",
  ].join("|");

  return {
    ...raw,
    text_hash: textHash,
    layout_hash: layoutHash,
    signal,
  };
}

function compactPageSettleSnapshot(snapshot) {
  return {
    ready_state: snapshot.ready_state || "unknown",
    text_length: snapshot.text_length || 0,
    text_hash: snapshot.text_hash || "",
    layout_hash: snapshot.layout_hash || "",
    link_count: snapshot.link_count || 0,
    image_count: snapshot.image_count || 0,
    script_count: snapshot.script_count || 0,
    visible_element_count: snapshot.visible_element_count || 0,
    sampled_element_count: snapshot.sampled_element_count || 0,
    scroll_height: snapshot.scroll_height || 0,
    scroll_width: snapshot.scroll_width || 0,
    title: snapshot.title || "",
    error: snapshot.error || null,
  };
}

function classifyInvalidPageCapture({ status, finalUrl, pageTitle, text, dimensions }) {
  const sample = truncate(text || "", 260);
  const haystack = [finalUrl, pageTitle, sample].filter(Boolean).join(" ").toLowerCase();
  const lowContent = normalizeText(text).length < 120;
  const viewportOnlyPage =
    dimensions?.scroll_height &&
    dimensions?.viewport_height &&
    dimensions.scroll_height <= dimensions.viewport_height + 80;

  if (
    haystack.includes("/.well-known/sgcaptcha/") ||
    haystack.includes("robot challenge screen") ||
    haystack.includes("checking the site connection security") ||
    haystack.includes("checking if the site connection is secure") ||
    haystack.includes("requires cookies to be enabled") ||
    haystack.includes("enable cookies") ||
    (haystack.includes("captcha") && /verify|challenge|security|human|robot/.test(haystack)) ||
    (haystack.includes("verify you are human") && haystack.includes("security"))
  ) {
    return { type: "security_challenge", sample };
  }

  if (
    status === 404 ||
    /\b(404|page not found|not found|this page doesn't exist|this page does not exist)\b/i.test(haystack) ||
    (lowContent && viewportOnlyPage && /\b(error|not found|unavailable)\b/i.test(haystack))
  ) {
    return { type: "soft_404", sample };
  }

  if (lowContent && viewportOnlyPage && /\b(access denied|forbidden|blocked|permission denied)\b/i.test(haystack)) {
    return { type: "access_blocked", sample };
  }

  return null;
}

async function discoverPdfLinksOnPage(page, source) {
  const rawLinks = await page
    .evaluate(() =>
      [...document.querySelectorAll("a[href]")].map((link) => ({
        href: link.getAttribute("href") || "",
        text: (link.innerText || link.textContent || "").replace(/\s+/g, " ").trim(),
        title: link.getAttribute("title") || "",
        ariaLabel: link.getAttribute("aria-label") || "",
        download: link.getAttribute("download") || "",
        contextText: (
          link.closest("article, section, li, tr, p, div")?.innerText ||
          link.parentElement?.innerText ||
          ""
        )
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 1200),
        inBoilerplateRegion: Boolean(
          link.closest(
            [
              "header",
              "footer",
              "nav",
              "aside",
              "[role='navigation']",
              "[role='contentinfo']",
              ".header",
              ".footer",
              ".site-header",
              ".site-footer",
              ".navbar",
              ".navigation",
              ".menu",
              ".mobile-menu",
              ".sidebar",
            ].join(","),
          ),
        ),
      })),
    )
    .catch(() => []);

  const seen = new Set();
  const candidates = [];

  for (const link of rawLinks) {
    const url = normalizeDiscoveredUrl(link.href, source.url);
    if (!url || seen.has(url)) continue;
    const signal = [url, link.text, link.title, link.ariaLabel, link.download]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    const pdfUrl = isPdfLikeUrl(url);
    const pdfText = /\bpdf\b/.test(signal);
    const documentSignal =
      /\b(application|guidelines?|instructions?|materials?|form|document|download)\b/.test(signal) &&
      /(\/files?\/|\/uploads?\/|\/documents?\/|\/media\/|download|attachment|pdf)/.test(signal);
    const title = readablePdfLinkTitle(link, source);
    const hygiene = shouldRejectDiscoveredSource({
      url,
      title,
      award_name: source.shared_awards?.name || "",
      page_type: "pdf",
      reason: signal,
    });

    if (!pdfUrl && !pdfText && !documentSignal) continue;
    if (hygiene.action === "review_later") continue;
    const consolidation = classifySourceForConsolidation(
      {
        url,
        title,
        page_type: "pdf",
        page_description: link.contextText,
        reason: signal,
      },
      source.shared_awards || {},
    );
    if (consolidation.action === "review_later") continue;
    if (!isRelevantDiscoveredPdfLink(link, url, source)) continue;
    seen.add(url);
    candidates.push({
      url,
      title,
      link_text: link.text || null,
      reason: pdfUrl ? "pdf_url" : pdfText ? "pdf_link_text" : "document_link_signal",
    });
  }

  return candidates.slice(0, 25);
}

function isRelevantDiscoveredPdfLink(link, url, source) {
  const awardName = source.shared_awards?.name || "";
  const sourceTitle = source.title || "";
  const title = readablePdfLinkTitle(link, source);
  const haystack = [
    url,
    title,
    link.text,
    link.title,
    link.ariaLabel,
    link.download,
    link.contextText,
  ]
    .filter(Boolean)
    .join(" ");

  if (isBoilerplatePdfLink(haystack)) return false;
  if (isLikelyDiscoveredPdfSpillover(haystack, source)) return false;

  const hasRelevantDiscoveryTerms = hasPdfDiscoveryRelevantTerms(haystack);
  if (link.inBoilerplateRegion && !hasRelevantDiscoveryTerms) return false;

  const awardTokens = distinctiveAwardTokens(`${awardName} ${sourceTitle}`);
  const matchingAwardTokens = awardTokens.filter((token) =>
    haystack.toLowerCase().includes(token),
  );
  const matchesAwardTokens =
    matchingAwardTokens.length >= Math.min(2, Math.max(1, awardTokens.length));

  if (matchesAwardTokens) return true;
  if (hasRelevantDiscoveryTerms) return true;
  if (source.page_type === "application" || source.page_type === "requirements") return true;

  return false;
}

function hasPdfDiscoveryRelevantTerms(value) {
  return /\b(deadline|due date|applications?\s+(?:open|close|due)|opens?|closes?|apply|application|eligible|eligibility|requirements?|recommendations?|nomination|nominations?|transcripts?|essays?|interviews?|funding|stipend|tuition|award amount|amount awarded|guidelines?|instructions?|materials?|selection|submit|submission|citizenship|gpa|portal)\b/i.test(
    String(value || ""),
  );
}

function isLikelyDiscoveredPdfSpillover(value, source = null) {
  const clean = String(value || "").toLowerCase();
  const awardContext = `${source?.shared_awards?.name || ""} ${source?.title || ""}`.toLowerCase();
  const isJspsSummerAward = /\bjsps\b/.test(awardContext) && /\bsummer\b/.test(awardContext);
  const isJspsSummerPath =
    /\/file\/storage\/j-fellow_summer/i.test(clean) ||
    /\/file\/storage\/j-fellow\/j-summer\//i.test(clean) ||
    /\/english\/e-summer\//i.test(clean) ||
    /\bsummer[-_\s]*program\b/i.test(clean);

  return (
    /\b(research reports?|reports? of former fellows?|former fellows?|feedback on fellowship|successful fellows?|program procedure|annual reports?|newsletter|leaflet|poster)\b/i.test(clean) ||
    /\/faq_j\d+\.pdf/i.test(clean) ||
    /\bjapanese[_\s-]*faq\b/i.test(clean) ||
    /\/file\/storage\/reports(?:_ippan)?\//i.test(clean) ||
    /\/file\/storage\/general\//i.test(clean) ||
    (!isJspsSummerAward && isJspsSummerPath) ||
    /\/english\/e-(?:inv|le|grants|lindau|chukaku)\//i.test(clean) ||
    /\/file\/storage\/(?:e-inv|j-invi|j-lindau)\//i.test(clean) ||
    /\bguideline_20(?:2[0-5])\//i.test(clean)
  );
}

function isBoilerplatePdfLink(value) {
  return /\b(login instructions?|log in|sign in|conflict of interest|coi|code of conduct|privacy policy|terms of use|bylaws?|annual report|tax form|form 990|media kit|press kit|brand guidelines?|sponsorship prospectus|advertising|invoice|receipt)\b/i.test(
    String(value || ""),
  );
}

function distinctiveAwardTokens(value) {
  const stop = new Set([
    "award",
    "awards",
    "fellow",
    "fellowship",
    "fellowships",
    "grant",
    "grants",
    "program",
    "programs",
    "scholar",
    "scholarship",
    "scholarships",
    "student",
    "students",
    "association",
    "american",
    "international",
    "japan",
    "japanese",
    "jsps",
    "postdoctoral",
    "research",
    "short",
    "term",
  ]);
  return String(value || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((token) => token.length >= 4 && !stop.has(token))
    .slice(0, 10);
}

function evaluateDiscoveredSourceCandidate(source, link, kind) {
  const candidate = discoveryCandidateSource(source, link, kind);
  const quality = sourceQualityDecision(candidate, { purpose: "discovery" });
  if (!quality.allowed) {
    return {
      allowed: false,
      rejection_type: "quality",
      reason: quality.reason,
      candidate,
      quality,
    };
  }

  const identity = discoveryIdentityDecision(source, candidate, link);
  if (!identity.allowed) {
    return {
      allowed: false,
      rejection_type: "identity",
      reason: identity.reason,
      candidate,
      quality,
    };
  }

  return {
    allowed: true,
    admin_review_status: identity.admin_review_status,
    reason: identity.reason,
    candidate,
    quality,
  };
}

function discoveryCandidateSource(source, link, kind) {
  const pageType = kind === "pdf" ? "pdf" : link.page_type || "other";
  return {
    id: null,
    shared_award_id: source.shared_award_id,
    url: link.url,
    title: link.title,
    display_title: link.title,
    page_type: pageType,
    confidence: kind === "pdf" ? 0.8 : link.confidence || 0.74,
    reason: link.reason || null,
    source: "admin",
    shared_awards: source.shared_awards || null,
    page_metadata: link.baseline_facts
      ? {
          kind: "source_page_outline",
          baseline_facts: link.baseline_facts,
        }
      : null,
  };
}

function discoveryIdentityDecision(source, candidate, link) {
  if (candidateHasCurrentAwardFacts(candidate)) {
    return { allowed: true, admin_review_status: "open", reason: "classified_current_award_source" };
  }

  const awardName = source.shared_awards?.name || "";
  const directSignal = [candidate.url, candidate.title, link.link_text, candidate.reason]
    .filter(Boolean)
    .join(" ");
  if (hasStrongAwardIdentityOverlap(awardName, directSignal)) {
    return {
      allowed: true,
      admin_review_status: discoveryReviewStatusForMissingFactsCandidate(candidate),
      reason: "award_token_overlap",
    };
  }

  if (parentSourceHasCurrentAwardFacts(source) && hasRelevantDiscoveryAnchor(link, candidate.url)) {
    return {
      allowed: true,
      admin_review_status: discoveryReviewStatusForMissingFactsCandidate(candidate),
      reason: "primary_source_relevant_anchor",
    };
  }

  if (parentSourceCanQueueDiscoveryCandidate(source) && hasRelevantDiscoveryAnchor(link, candidate.url)) {
    return { allowed: true, admin_review_status: "review_later", reason: "curated_source_relevant_anchor_pending" };
  }

  return { allowed: false, reason: "missing_award_identity_match" };
}

function discoveryReviewStatusForMissingFactsCandidate(candidate) {
  const pageType = normalizedDiscoveryFactKey(candidate.page_type);
  return ["homepage", "application", "deadline", "requirements", "eligibility", "pdf"].includes(pageType)
    ? "open"
    : "review_later";
}

function candidateHasCurrentAwardFacts(candidate) {
  const facts = sourceBaselineFacts(candidate);
  const awardRelevance = normalizedDiscoveryFactKey(facts.award_relevance);
  const cycleRelevance = normalizedDiscoveryFactKey(facts.cycle_relevance);
  return (
    ["primary", "supporting"].includes(awardRelevance) &&
    !["not_program_page", "archived_or_past", "unclear"].includes(cycleRelevance)
  );
}

function parentSourceHasCurrentAwardFacts(source) {
  const facts = sourceBaselineFacts(source);
  const awardRelevance = normalizedDiscoveryFactKey(facts.award_relevance);
  const cycleRelevance = normalizedDiscoveryFactKey(facts.cycle_relevance);
  return (
    ["primary", "supporting"].includes(awardRelevance) &&
    !["not_program_page", "archived_or_past", "unclear"].includes(cycleRelevance)
  );
}

function parentSourceCanQueueDiscoveryCandidate(source) {
  const quality = sourceQualityDecision(source, { purpose: "monitoring" });
  if (!quality.allowed) return false;
  const pageType = normalizedDiscoveryFactKey(source.page_type);
  return ["homepage", "application", "deadline", "requirements", "eligibility", "pdf", "faq"].includes(pageType);
}

function hasRelevantDiscoveryAnchor(link, url) {
  return /\b(home|homepage|apply|application|applicant|deadline|due date|eligib|requirements?|guidelines?|instructions?|faq|form|portal|nomination|materials?|documents?|pdf|download|submit|submission)\b/i.test(
    [url, link.title, link.link_text, link.reason].filter(Boolean).join(" "),
  );
}

function hasStrongAwardIdentityOverlap(awardName, value) {
  const tokens = distinctiveAwardTokens(awardName);
  if (!tokens.length) return false;
  const haystack = String(value || "").toLowerCase();
  const matches = tokens.filter((token) => haystack.includes(token)).length;
  const required = tokens.length <= 2 ? tokens.length : Math.max(2, Math.ceil(Math.min(tokens.length, 8) * 0.5));
  return matches >= required;
}

function normalizedDiscoveryFactKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function discoveredSourceRow(source, link, kind, expanded, decision) {
  const candidate = decision.candidate;
  const discoveredAt = new Date().toISOString();
  const reviewStatus = decision.admin_review_status || "review_later";
  return {
    shared_award_id: source.shared_award_id,
    url: candidate.url,
    title: candidate.title,
    page_type: candidate.page_type,
    confidence: candidate.confidence,
    reason: [
      "Found by an explicit discovery-mode visual snapshot run after expanding page content.",
      `Parent source: ${source.url}`,
      `Signal: ${link.reason}`,
      `Discovery gate: ${decision.reason}`,
      expanded?.controls_clicked ? `Expanded controls: ${expanded.controls_clicked}` : null,
    ]
      .filter(Boolean)
      .join(" "),
    source: "admin",
    admin_review_status: reviewStatus,
    admin_review_note:
      reviewStatus === "review_later"
        ? "Queued by discovery mode for source-quality/admin review before monitoring."
        : null,
    page_metadata: {
      version: 1,
      kind: "source_discovery_candidate",
      discovered_at: discoveredAt,
      discovery_mode: true,
      discovery_gate_reason: decision.reason,
      discovery_quality_reason: decision.quality?.reason || null,
      parent_source_id: source.id || null,
      parent_source_url: source.url || null,
      parent_source_title: source.title || null,
      link_text: link.link_text || null,
    },
    next_check_at: reviewStatus === "open" ? discoveredAt : null,
  };
}

function reserveDiscoveryCap(source, url, report) {
  const checks = [
    {
      key: String(source.shared_award_id || "unknown_award"),
      map: discoveryRunState.byAward,
      max: maxNewDiscoveriesPerAward,
      reportBucket: report?.discovery_cap_hits_by_award,
    },
    {
      key: String(source.id || source.url || "unknown_source"),
      map: discoveryRunState.bySource,
      max: maxNewDiscoveriesPerSource,
      reportBucket: report?.discovery_cap_hits_by_source,
    },
    {
      key: normalizedHost(url) || "unknown_domain",
      map: discoveryRunState.byDomain,
      max: maxNewDiscoveriesPerDomain,
      reportBucket: report?.discovery_cap_hits_by_domain,
    },
  ];

  for (const check of checks) {
    if ((check.map.get(check.key) || 0) >= check.max) {
      incrementCounterObject(check.reportBucket, check.key);
      return false;
    }
  }

  for (const check of checks) {
    check.map.set(check.key, (check.map.get(check.key) || 0) + 1);
  }
  return true;
}

function recordDiscoveryRejection(report, decision) {
  if (!report) return;
  if (decision.rejection_type === "quality") {
    report.discovery_rejected_by_quality += 1;
  } else {
    report.discovery_rejected_by_identity += 1;
  }
  incrementCounterObject(report.discovery_rejection_reasons, decision.reason || "unknown");
}

function incrementCounterObject(bucket, key) {
  if (!bucket) return;
  bucket[key] = (bucket[key] || 0) + 1;
}

async function maybeRecordDiscoveredPdfSources(source, pdfLinks, expanded, report) {
  if (!discoveryMode || !discoverPdfSubpages) return;
  if (!pdfLinks.length) return;
  if (report) {
    report.discovered_pdf_candidates += pdfLinks.length;
    report.discovery_candidates += pdfLinks.length;
  }

  const urls = [...new Set(pdfLinks.map((link) => link.url))];
  const { data: existing, error: existingError } = await supabase
    .from("shared_award_sources")
    .select("url")
    .eq("shared_award_id", source.shared_award_id)
    .in("url", urls);

  if (existingError) {
    if (report) {
      report.errors.push({
        source_id: source.id,
        source_url: source.url,
        message: `PDF source discovery lookup failed: ${existingError.message}`,
      });
    }
    return;
  }

  const existingUrls = new Set((existing || []).map((row) => row.url));
  const rows = [];
  for (const link of pdfLinks) {
    if (existingUrls.has(link.url)) {
      if (report) report.discovery_skipped_existing += 1;
      continue;
    }
    const decision = evaluateDiscoveredSourceCandidate(source, link, "pdf");
    if (!decision.allowed) {
      recordDiscoveryRejection(report, decision);
      continue;
    }
    if (!reserveDiscoveryCap(source, link.url, report)) continue;
    rows.push(discoveredSourceRow(source, link, "pdf", expanded, decision));
  }

  if (!rows.length) return;

  const { data, error } = await supabase
    .from("shared_award_sources")
    .upsert(rows, { onConflict: "shared_award_id,url", ignoreDuplicates: true })
    .select("id,url");

  if (error) {
    if (report) {
      report.errors.push({
        source_id: source.id,
        source_url: source.url,
        message: `PDF source discovery insert failed: ${error.message}`,
      });
    }
    return;
  }

  const insertedRows = insertedDiscoveryRows(rows, data);
  const inserted = insertedRows.length;
  if (report) {
    report.discovered_pdf_sources += inserted;
    report.discovery_inserted_open += insertedRows.filter((row) => row.admin_review_status === "open").length;
    report.discovery_inserted_pending += insertedRows.filter((row) => row.admin_review_status !== "open").length;
  }
  console.log(`DISCOVERED PDF SOURCES inserted=${inserted} parent=${sourceLabel(source)}`);
}

async function discoverHtmlSubpageLinksOnPage(page, source) {
  if (maxHtmlSubpageDiscoveries <= 0) return [];

  const rawLinks = await page
    .evaluate(() =>
      [...document.querySelectorAll("a[href]")].map((link) => ({
        href: link.getAttribute("href") || "",
        text: (link.innerText || link.textContent || "").replace(/\s+/g, " ").trim(),
        title: link.getAttribute("title") || "",
        ariaLabel: link.getAttribute("aria-label") || "",
        rel: link.getAttribute("rel") || "",
        target: link.getAttribute("target") || "",
        contextText: (
          link.closest("article, section, main, li, tr, p, div")?.innerText ||
          link.parentElement?.innerText ||
          ""
        )
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 1200),
        inBoilerplateRegion: Boolean(
          link.closest(
            [
              "header",
              "footer",
              "nav",
              "aside",
              "[role='navigation']",
              "[role='contentinfo']",
              ".header",
              ".footer",
              ".site-header",
              ".site-footer",
              ".navbar",
              ".navigation",
              ".menu",
              ".mobile-menu",
              ".sidebar",
            ].join(","),
          ),
        ),
      })),
    )
    .catch(() => []);

  const currentUrl = normalizeComparableUrl(source.url);
  const seen = new Set();
  const candidates = [];

  for (const link of rawLinks) {
    const url = normalizeDiscoveredUrl(link.href, source.url);
    if (!url || seen.has(url)) continue;
    if (normalizeComparableUrl(url) === currentUrl) continue;
    const title = readableHtmlLinkTitle(link, url);
    const pageType = inferHtmlSubpageType(link, url);
    const hygiene = shouldRejectDiscoveredSource({
      url,
      title,
      award_name: source.shared_awards?.name || "",
      page_type: pageType,
      reason: [link.text, link.title, link.ariaLabel, link.contextText].filter(Boolean).join(" "),
    });
    if (hygiene.action === "review_later") continue;
    const consolidation = classifySourceForConsolidation(
      {
        url,
        title,
        page_type: pageType,
        page_description: link.contextText,
        reason: [link.text, link.title, link.ariaLabel, link.contextText].filter(Boolean).join(" "),
      },
      source.shared_awards || {},
    );
    if (consolidation.action === "review_later") continue;
    if (!isRelevantDiscoveredHtmlLink(link, url, source)) continue;

    seen.add(url);
    candidates.push({
      url,
      title,
      page_type: pageType,
      confidence: confidenceForHtmlSubpage(link, url, pageType),
      reason: reasonForHtmlSubpage(link, url, pageType),
      link_text: link.text || null,
    });
  }

  return candidates
    .sort((left, right) => right.confidence - left.confidence || left.title.localeCompare(right.title))
    .slice(0, maxHtmlSubpageDiscoveries);
}

function isRelevantDiscoveredHtmlLink(link, url, source) {
  if (isPdfLikeUrl(url) || isLikelyDownloadUrl(url)) return false;
  if (!isSameDiscoveryHost(url, source.url)) return false;

  const title = readableHtmlLinkTitle(link, url);
  const directSignal = [url, title, link.text, link.title, link.ariaLabel]
    .filter(Boolean)
    .join(" ");
  const haystack = [url, title, link.text, link.title, link.ariaLabel, link.contextText]
    .filter(Boolean)
    .join(" ");

  if (isBoilerplateHtmlSubpageLink(haystack)) return false;
  if (isLikelyGenericHtmlSpillover(link, url, source)) return false;
  if (!hasHtmlDiscoveryRelevantTerms(haystack)) return false;
  const hasStrongDirectTerms = hasStrongHtmlDiscoveryTerms(directSignal);
  const hasStrongContextTerms = hasStrongHtmlDiscoveryTerms(haystack);
  if (link.inBoilerplateRegion && !hasStrongDirectTerms) return false;

  const awardTokens = distinctiveAwardTokens(`${source.shared_awards?.name || ""} ${source.title || ""}`);
  const matchingAwardTokens = awardTokens.filter((token) => haystack.toLowerCase().includes(token));
  const matchesAwardTokens =
    matchingAwardTokens.length >= Math.min(2, Math.max(1, awardTokens.length));

  if (matchesAwardTokens) return true;
  if (hasStrongDirectTerms) return true;
  if (
    hasStrongContextTerms &&
    ["application", "eligibility", "requirements", "deadline", "faq"].includes(source.page_type)
  ) {
    return true;
  }

  return false;
}

function isLikelyGenericHtmlSpillover(link, url, source) {
  const title = readableHtmlLinkTitle(link, url);
  const signal = [url, title, link.text, link.title, link.ariaLabel, link.contextText]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const awardContext = `${source.shared_awards?.name || ""} ${source.title || ""}`.toLowerCase();
  const hasAwardSignal =
    /\b(apply|application|applicant|eligib|deadline|due date|requirements?|materials?|guidelines?|nomination|portal|faq|fellowships?|scholarships?|grants?|awards?)\b/.test(
      signal,
    );

  if (hasRepeatedUrlSegment(url)) return true;

  if (
    /\b(recipes?|cooking school|nutrition facts?|egg safety|food safety|foodservice|manufacturers?|professional resources?|recertification|certification faqs?|on-demand|ceu bundle|training|course|webinar|podcast|content marketing|mobile marketing|marketing automation|influencer marketing|overview of marketing)\b/.test(
      signal,
    )
  ) {
    return true;
  }

  if (
    /\b(alumni|testimonials?|success stories|meet our fellows|fellows directory|recent fellows|grant recipients?|award recipients?|scholars housing|room \d{2,4}|center associate|mission areas|startup|tech transfer|activities and networking|lectures)\b/.test(
      signal,
    )
  ) {
    return true;
  }

  try {
    const pathname = new URL(url).pathname.toLowerCase();
    if (
      /\/(?:grantee|grantees|awardee|awardees|recipient|recipients?|fellows-directory|faculty\/research\/publications|faculty\/pages\/item\.aspx|university-ad)(?:\/|$)/.test(
        pathname,
      )
    ) {
      return true;
    }

    if (
      /\/(?:privacy-policy|cookie-policy|ferpa|subject-index|subject-indexing|calendar-conferences|announcements?)(?:\/|$)/.test(
        pathname,
      )
    ) {
      return true;
    }

    if (/\/news(?:\/|$)/.test(pathname) && !hasAwardSignal) {
      return true;
    }
  } catch {
    return true;
  }

  if (
    /\b(ferpa for students|subject index terms|submit your news|calendar of conferences|cookie policy|privacy policy|fellowship privacy statement|selection committees?|staff directory|committee members?)\b/.test(
      signal,
    )
  ) {
    return true;
  }

  if (/^\s*(read more|more|learn more|lire plus)\s*$/i.test(title) && !hasAwardSignal) {
    return true;
  }

  try {
    if (/(?:^|\/)(?:research|education|science|innovation|equal-opportunities)(?:\/|$)/i.test(new URL(url).pathname)) {
      return !/\b(application|apply|eligib|deadline|faq|requirements?|materials?|guidelines?|nomination|portal)\b/.test(signal);
    }
  } catch {
    return true;
  }

  if (/\bfaq\b/.test(title.toLowerCase()) && /\bfaq\b/.test(awardContext)) return false;

  return false;
}

function hasRepeatedUrlSegment(value) {
  try {
    const segments = new URL(value).pathname
      .split("/")
      .map((segment) => segment.trim().toLowerCase())
      .filter(Boolean);
    const counts = new Map();
    for (const segment of segments) {
      if (segment.length < 4) continue;
      const count = (counts.get(segment) || 0) + 1;
      counts.set(segment, count);
      if (count >= 3) return true;
    }
    return false;
  } catch {
    return false;
  }
}

async function maybeRecordDiscoveredHtmlSources(source, links, expanded, report) {
  if (!discoveryMode || !discoverHtmlSubpages) return;
  if (!links.length) return;
  if (report) {
    report.discovered_html_candidates += links.length;
    report.discovery_candidates += links.length;
  }

  const urls = [...new Set(links.map((link) => link.url))];
  const { data: existing, error: existingError } = await supabase
    .from("shared_award_sources")
    .select("url")
    .eq("shared_award_id", source.shared_award_id)
    .in("url", urls);

  if (existingError) {
    if (report) {
      report.errors.push({
        source_id: source.id,
        source_url: source.url,
        message: `HTML subpage discovery lookup failed: ${existingError.message}`,
      });
    }
    return;
  }

  const existingUrls = new Set((existing || []).map((row) => row.url));

  const seenUrls = new Set();
  const rows = [];
  for (const link of links) {
    const comparableUrl = normalizeComparableUrl(link.url);
    if (seenUrls.has(comparableUrl)) continue;
    seenUrls.add(comparableUrl);
    if (existingUrls.has(link.url)) {
      if (report) report.discovery_skipped_existing += 1;
      continue;
    }
    const decision = evaluateDiscoveredSourceCandidate(source, link, "html");
    if (!decision.allowed) {
      recordDiscoveryRejection(report, decision);
      continue;
    }
    if (!reserveDiscoveryCap(source, link.url, report)) continue;
    rows.push(discoveredSourceRow(source, link, "html", expanded, decision));
  }

  if (!rows.length) return;

  const { data, error } = await supabase
    .from("shared_award_sources")
    .upsert(rows, { onConflict: "shared_award_id,url", ignoreDuplicates: true })
    .select("id,url");

  if (error) {
    if (report) {
      report.errors.push({
        source_id: source.id,
        source_url: source.url,
        message: `HTML subpage discovery insert failed: ${error.message}`,
      });
    }
    return;
  }

  const insertedRows = insertedDiscoveryRows(rows, data);
  const inserted = insertedRows.length;
  if (report) {
    report.discovered_html_sources += inserted;
    report.discovery_inserted_open += insertedRows.filter((row) => row.admin_review_status === "open").length;
    report.discovery_inserted_pending += insertedRows.filter((row) => row.admin_review_status !== "open").length;
  }
  console.log(`DISCOVERED HTML SOURCES inserted=${inserted} parent=${sourceLabel(source)}`);
}

function isSameDiscoveryHost(value, baseValue) {
  const host = normalizedHost(value);
  const baseHost = normalizedHost(baseValue);
  if (!host || !baseHost) return false;
  return host === baseHost || host.endsWith(`.${baseHost}`) || baseHost.endsWith(`.${host}`);
}

function normalizedHost(value) {
  try {
    return new URL(value).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function normalizeComparableUrl(value) {
  try {
    const parsed = new URL(value);
    parsed.hash = "";
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.pathname = parsed.pathname.replace(/\/+$/g, "") || "/";
    return parsed.toString();
  } catch {
    return String(value || "");
  }
}

function isLikelyDownloadUrl(value) {
  try {
    const parsed = new URL(value);
    return /\.(?:docx?|xlsx?|pptx?|zip|rar|7z|jpg|jpeg|png|gif|webp|svg|ics|mp4|mp3|mov|avi)$/i.test(
      parsed.pathname,
    );
  } catch {
    return false;
  }
}

function inferHtmlSubpageType(link, url) {
  const signal = [url, link.text, link.title, link.ariaLabel, link.contextText].filter(Boolean).join(" ");
  if (/\b(faq|frequently asked questions?)\b/i.test(signal)) return "faq";
  if (/\b(eligible|eligibility|who should apply|citizenship|gpa|academic standing)\b/i.test(signal)) {
    return "eligibility";
  }
  if (/\b(deadline|due date|dates?|calendar|timeline|opens?|closes?)\b/i.test(signal)) return "deadline";
  if (/\b(apply|application|nomination|portal|submit|submission|how to apply)\b/i.test(signal)) {
    return "application";
  }
  if (/\b(requirements?|materials?|instructions?|guidelines?|essays?|transcripts?|recommendations?|selection)\b/i.test(signal)) {
    return "requirements";
  }
  return "other";
}

function confidenceForHtmlSubpage(link, url, pageType) {
  const signal = [url, link.text, link.title, link.ariaLabel].filter(Boolean).join(" ");
  let confidence = 0.74;
  if (pageType !== "other") confidence += 0.08;
  if (hasStrongHtmlDiscoveryTerms(signal)) confidence += 0.08;
  if (!link.inBoilerplateRegion) confidence += 0.04;
  return Math.min(0.93, Number(confidence.toFixed(2)));
}

function reasonForHtmlSubpage(link, url, pageType) {
  const title = readableHtmlLinkTitle(link, url);
  const terms = [];
  const signal = [url, title, link.text, link.title, link.ariaLabel].filter(Boolean).join(" ");
  if (/\bfaq|frequently asked questions?\b/i.test(signal)) terms.push("faq");
  if (/\beligib/i.test(signal)) terms.push("eligibility");
  if (/\bdeadlines?|due date|timeline\b/i.test(signal)) terms.push("deadline");
  if (/\bapply|application|nomination|portal|submit\b/i.test(signal)) terms.push("application");
  if (/\brequirements?|materials?|instructions?|guidelines?\b/i.test(signal)) terms.push("requirements");
  return `${pageType}_html_link${terms.length ? `:${terms.join(",")}` : ""}`;
}

function hasHtmlDiscoveryRelevantTerms(value) {
  return /\b(deadline|due date|dates?|timeline|calendar|applications?\s+(?:open|close|due)|opens?|closes?|apply|application|how to apply|eligible|eligibility|requirements?|recommendations?|nomination|nominations?|transcripts?|essays?|materials?|instructions?|guidelines?|selection|submit|submission|citizenship|gpa|portal|faq|frequently asked questions?|award amount|benefits?|funding|stipend|tuition)\b/i.test(
    String(value || ""),
  );
}

function hasStrongHtmlDiscoveryTerms(value) {
  return /\b(deadline|due date|how to apply|apply|application|eligible|eligibility|requirements?|materials?|instructions?|guidelines?|nomination|portal|faq|frequently asked questions?)\b/i.test(
    String(value || ""),
  );
}

function isBoilerplateHtmlSubpageLink(value) {
  const clean = String(value || "");
  const hasAwardSignal =
    /\b(apply|application|applicant|eligib|deadline|due date|requirements?|materials?|instructions?|guidelines?|nomination|portal|faq|frequently asked questions?|fellowships?|scholarships?|grants?|awards?)\b/i.test(
      clean,
    );
  if (
    /\b(login|log in|sign in|create account|privacy policy|terms of use|accessibility|copyright|donate|give now|store|shop|cart|checkout|subscribe|newsletter|staff|board|bylaws?|annual report|media kit|sponsorship|advertising|facebook|twitter|x\.com|instagram|linkedin|youtube|rss)\b/i.test(
      clean,
    )
  ) {
    return true;
  }
  return /\b(press release|newsroom|blog|events?|calendar of events|webinar)\b/i.test(clean) && !hasAwardSignal;
}

function readableHtmlLinkTitle(link, url) {
  const text = cleanText(link.text || link.title || link.ariaLabel);
  if (text) return text.slice(0, 180);
  try {
    const parsed = new URL(url);
    const segment = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop() || parsed.hostname);
    return segment.replace(/[-_]+/g, " ").slice(0, 180) || "Source page";
  } catch {
    return "Source page";
  }
}

function normalizeDiscoveredUrl(value, baseUrl) {
  if (!value || value.startsWith("mailto:") || value.startsWith("tel:")) return null;
  try {
    const parsed = new URL(value, baseUrl);
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    if (
      parsed.protocol === "http:" &&
      parsed.hostname.replace(/^www\./i, "").toLowerCase() === "jspsusa.org"
    ) {
      parsed.protocol = "https:";
    }
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

function isPdfLikeUrl(value) {
  try {
    const parsed = new URL(value);
    return /\.pdf$/i.test(parsed.pathname) || /\.pdf(?:$|[?&=/])/i.test(`${parsed.pathname}${parsed.search}`);
  } catch {
    return /\.pdf(?:$|[?#])/i.test(String(value || ""));
  }
}

function readablePdfLinkTitle(link, source) {
  const text = cleanText(link.text || link.title || link.ariaLabel || link.download);
  if (text) return text.slice(0, 180);
  try {
    const parsed = new URL(link.href, source.url);
    const fileName = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop() || "PDF document");
    return fileName.replace(/[-_]+/g, " ").replace(/\.pdf$/i, "").slice(0, 180) || "PDF document";
  } catch {
    return "PDF document";
  }
}

async function maybeSyncR2Snapshot(source, capture, report, options = {}) {
  if (!r2SnapshotSync) return;
  const reason = cleanText(options.reason) || "unspecified";
  const skipNoise = Boolean(options.noise) && !forceR2SnapshotRefresh;
  const skipUnchanged =
    Boolean(options.unchanged) &&
    !forceR2SnapshotRefresh &&
    !["initial_baseline", "baseline_refresh", "ai_approved_true_change"].includes(reason);

  if (skipNoise) {
    report.r2_uploads_skipped_noise += 1;
    console.log(`R2 SKIP noise reason=${reason} ${sourceLabel(source)}`);
    return false;
  }

  if (skipUnchanged) {
    report.r2_uploads_skipped_unchanged += 1;
    console.log(`R2 SKIP unchanged reason=${reason} ${sourceLabel(source)}`);
    return false;
  }

  try {
    const result = localizationRepair
      ? await syncR2LocalizationLatest(source, capture)
      : await syncR2SnapshotPair(source, capture);
    report.r2_uploaded += result.uploaded;
    report.r2_rotated += result.rotated;
    report.r2_previous_snapshots_reset += result.previousReset || 0;
    existingR2SnapshotSourceIds.add(source.id);
    console.log(`R2 SNAPSHOT uploaded=${result.uploaded} rotated=${result.rotated} ${sourceLabel(source)}`);
    return true;
  } catch (error) {
    report.r2_failed += 1;
    const message = `R2 snapshot sync failed: ${errorMessage(error)}`;
    report.errors.push({
      source_id: source.id,
      source_url: source.url,
      message,
    });
    console.log(`R2 FAILED ${message} ${sourceLabel(source)}`);
    return false;
  }
}

async function maybeRepairMissingR2Snapshot(source, capture, report, options = {}) {
  if (!r2SnapshotSync || !r2RepairMissingSnapshots) return false;
  if (existingR2SnapshotSourceIds.has(source.id)) return false;

  const repaired = await maybeSyncR2Snapshot(source, capture, report, {
    ...options,
    unchanged: true,
  });
  if (repaired) {
    report.r2_repaired_missing += 1;
    console.log(`R2 REPAIRED missing_snapshot ${sourceLabel(source)}`);
  }
  return repaired;
}

async function markSharedSourceVisualCheckSucceeded(source, capture, report = null) {
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("shared_award_sources")
    .update({
      last_hash: visualHashForCapture(capture),
      last_checked_at: now,
      next_check_at: nextVisualSourceCheckDate(),
      consecutive_failures: 0,
      last_error: null,
      ...sourcePageMetadataUpdate(source, capture),
      updated_at: now,
    })
    .eq("id", source.id);

  if (error) throw error;

  await maybeUpdateSafeRedirectUrl(source, capture, now, report);
}

async function markSharedSourceReviewLater(source, hygiene) {
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("shared_award_sources")
    .update({
      admin_review_status: "review_later",
      admin_review_note: hygiene.note || "Auto-cleaned before screenshot capture.",
      admin_reviewed_at: now,
      admin_reviewed_by: "awardping-visual-snapshot-worker",
      updated_at: now,
    })
    .eq("id", source.id);

  if (error) throw new Error(`shared_award_sources review_later update failed: ${error.message}`);
  console.log(`SOURCE_REVIEW_LATER pre_capture reason=${hygiene.reason} ${sourceLabel(source)}`);
}

async function markSharedSourceVisualCheckFailed(source, message) {
  const now = new Date().toISOString();
  const failures = nonNegativeInt(source.consecutive_failures, 0) + 1;
  const parsedStatus = parseHttpStatusFromMessage(message);
  const failureType = failureTypeFromMessage(message, parsedStatus.status_code);
  const hygiene = shouldAutoReviewLaterFailure(
    {
      ...source,
      award_name: source.shared_awards?.name || "",
      source_url: source.url,
      source_title: source.title,
    },
    {
      message,
      status_code: parsedStatus.status_code,
      failure_type: failureType,
    },
  );
  const finalHygiene =
    hygiene.action === "review_later" || !aiReviewEvidenceCapture || failures < 2
      ? hygiene
      : {
          action: "review_later",
          reason: "repeated_evidence_capture_failure",
          note: `Source could not provide the local evidence required for AI review after ${failures} attempts: ${message}`,
        };
  const update = {
    last_checked_at: now,
    next_check_at: nextVisualSourceCheckDate(),
    consecutive_failures: failures,
    last_error: truncate(message, 1000),
    updated_at: now,
  };

  if (finalHygiene.action === "review_later") {
    update.admin_review_status = "review_later";
    update.admin_review_note = truncate(
      `Auto-cleaned by visual worker (${finalHygiene.reason}): ${finalHygiene.note || message}`,
      1000,
    );
    update.admin_reviewed_at = now;
    update.admin_reviewed_by = "awardping-worker";
    console.log(`SOURCE_REVIEW_LATER reason=${finalHygiene.reason} ${sourceLabel(source)}`);
  }

  const { error } = await supabase
    .from("shared_award_sources")
    .update(update)
    .eq("id", source.id);

  if (error) throw error;
}

async function maybeUpdateSafeRedirectUrl(source, capture, now, report = null) {
  if (!safeRedirectUrlUpdate) return;

  const nextUrl = safeRedirectUrlForCapture(source, capture);
  if (!nextUrl) return;

  const { data: duplicate, error: duplicateError } = await supabase
    .from("shared_award_sources")
    .select("id")
    .eq("shared_award_id", source.shared_award_id)
    .eq("url", nextUrl)
    .neq("id", source.id)
    .limit(1)
    .maybeSingle();

  if (duplicateError) {
    if (report) report.safe_redirect_url_update_failed += 1;
    console.log(`SOURCE_URL_CANONICALIZE_CHECK_FAILED ${errorMessage(duplicateError)} ${sourceLabel(source)}`);
    return;
  }

  if (duplicate?.id) {
    if (report) report.safe_redirect_url_update_skipped += 1;
    console.log(`SOURCE_URL_CANONICALIZE_SKIPPED duplicate=${duplicate.id} next_url=${nextUrl} ${sourceLabel(source)}`);
    return;
  }

  const { error } = await supabase
    .from("shared_award_sources")
    .update({
      url: nextUrl,
      updated_at: now,
    })
    .eq("id", source.id);

  if (error) {
    if (report) report.safe_redirect_url_update_failed += 1;
    console.log(`SOURCE_URL_CANONICALIZE_FAILED ${errorMessage(error)} next_url=${nextUrl} ${sourceLabel(source)}`);
    return;
  }

  if (source.shared_award_id) {
    const { error: awardError } = await supabase
      .from("shared_awards")
      .update({
        official_homepage: nextUrl,
        updated_at: now,
      })
      .eq("id", source.shared_award_id)
      .eq("official_homepage", source.url);

    if (awardError) {
      console.log(`AWARD_HOMEPAGE_CANONICALIZE_FAILED ${errorMessage(awardError)} next_url=${nextUrl} ${sourceLabel(source)}`);
    }
  }

  if (report) report.safe_redirect_url_updates += 1;
  source.url = nextUrl;
  console.log(`SOURCE_URL_CANONICALIZED next_url=${nextUrl} ${sourceLabel(source)}`);
}

function safeRedirectUrlForCapture(source, capture) {
  const original = cleanText(source?.url);
  const finalUrl = cleanText(capture?.final_url);
  if (!original || !finalUrl || original === finalUrl) return null;

  try {
    const before = new URL(original);
    const after = new URL(finalUrl);
    if (!["http:", "https:"].includes(before.protocol) || !["http:", "https:"].includes(after.protocol)) {
      return null;
    }
    if (after.username || after.password) return null;

    const beforeHost = normalizeRedirectHost(before.hostname);
    const afterHost = normalizeRedirectHost(after.hostname);
    if (!beforeHost || beforeHost !== afterHost) return null;

    if (normalizeRedirectPath(before.pathname) !== normalizeRedirectPath(after.pathname)) return null;
    if (before.search !== after.search) return null;

    after.hash = "";
    const safeUrl = after.toString();
    return safeUrl !== original ? safeUrl : null;
  } catch {
    return null;
  }
}

function normalizeRedirectHost(hostname) {
  return String(hostname || "").toLowerCase().replace(/^www\./, "");
}

function normalizeRedirectPath(pathname) {
  const cleanPath = String(pathname || "/").replace(/\/+$/, "");
  return cleanPath || "/";
}

function sourcePageMetadataUpdate(source, capture) {
  const facts = capture?.baseline_facts ? normalizeBaselineFacts(capture.baseline_facts) : null;
  if (!facts) return {};

  const metadata = capture.baseline_facts_metadata || {};
  const generatedAt = metadata.extracted_at || new Date().toISOString();
  const sanity = baselineFactsMatchSource(source, capture, facts);
  if (!sanity.ok) {
    const update = {
      display_title: cleanNullable(capture.page_title) || cleanNullable(source.title) || null,
      page_description: null,
      page_metadata: {
        version: 1,
        kind: "source_page_outline",
        provider: metadata.provider || aiProvider,
        model: metadata.model || aiModel,
        generated_at: generatedAt,
        snapshot_hash: metadata.snapshot_hash || visualHashForCapture(capture),
        capture_kind: capture.kind || "webpage",
        final_url: capture.final_url || null,
        page_title: capture.page_title || null,
        baseline_facts_rejected: true,
        rejection_reason: sanity.reason,
        quality_flags: [...new Set([...(facts.quality_flags || []), "source-mismatch"])],
      },
      page_metadata_generated_at: generatedAt,
      page_metadata_model: metadata.model || aiModel,
    };

    if (shouldReviewLaterForBaselineFactsRejection(facts, sanity.reason)) {
      update.admin_review_status = "review_later";
      update.admin_review_note = truncate(
        `Auto-cleaned by baseline facts (${sanity.reason}): Gemini classified this page as award_relevance=${facts.award_relevance}, cycle_relevance=${facts.cycle_relevance}.`,
        1000,
      );
      update.admin_reviewed_at = generatedAt;
      update.admin_reviewed_by = "awardping-visual-snapshot-worker";
    }

    return update;
  }

  const displayTitle = facts.display_title || cleanNullable(capture.page_title) || cleanNullable(source.title);
  const description =
    facts.page_description ||
    facts.page_purpose ||
    facts.notes[0] ||
    facts.sections[0]?.description ||
    null;

  return {
    display_title: displayTitle,
    page_description: description ? truncate(description, 500) : null,
    page_metadata: {
      version: 1,
      kind: "source_page_outline",
      provider: metadata.provider || aiProvider,
      model: metadata.model || aiModel,
      generated_at: generatedAt,
      snapshot_hash: metadata.snapshot_hash || visualHashForCapture(capture),
      capture_kind: capture.kind || "webpage",
      final_url: capture.final_url || null,
      page_title: capture.page_title || null,
      baseline_facts: facts,
      baseline_facts_metadata: metadata,
    },
    page_metadata_generated_at: generatedAt,
    page_metadata_model: metadata.model || aiModel,
  };
}

function baselineFactsMatchSource(source, capture, facts) {
  if (cleanSlug(facts.status) === "failed") return { ok: false, reason: "facts_status_failed" };

  const awardRelevance = normalizeAwardRelevance(facts.award_relevance);
  const cycleRelevance = normalizeCycleRelevance(facts.cycle_relevance);
  if (awardRelevance === "unrelated") return { ok: false, reason: "award_relevance_unrelated" };
  if (awardRelevance === "unclear") return { ok: false, reason: "award_relevance_unclear" };
  if (cycleRelevance === "not_program_page") return { ok: false, reason: "cycle_relevance_not_program_page" };
  if (cycleRelevance === "archived_or_past") return { ok: false, reason: "cycle_relevance_archived_or_past" };
  if (cycleRelevance === "unclear") return { ok: false, reason: "cycle_relevance_unclear" };

  const evidenceQuotes = stringArray(facts.evidence_quotes);
  if (!evidenceQuotes.length) return { ok: false, reason: "missing_evidence_quotes" };

  const qualityFlags = stringArray(facts.quality_flags).map(cleanSlug);
  if (normalizeConfidence(facts.confidence) === "high" && qualityFlags.some(isContradictoryHighConfidenceFactFlag)) {
    return { ok: false, reason: "high_confidence_with_rejection_flags" };
  }

  const quality = sourceQualityDecision(
    {
      ...source,
      page_metadata: { baseline_facts: facts },
      page_metadata_generated_at: new Date().toISOString(),
    },
    { purpose: "monitoring" },
  );
  if (!quality.allowed) return { ok: false, reason: quality.reason };

  const expectedTokens = distinctiveSourceTokens([
    source.shared_awards?.name,
    source.title,
    capture.page_title,
  ].join(" "));
  if (!expectedTokens.length) return { ok: true };

  const factTokens = distinctiveSourceTokens([
    facts.display_title,
    facts.award_name,
    facts.page_description,
    facts.page_purpose,
    ...evidenceQuotes,
    ...(facts.sections || []).flatMap((section) => [section.title, section.description]),
  ].join(" "));
  const overlap = expectedTokens.filter((token) => factTokens.includes(token));

  if (overlap.length > 0) return { ok: true };
  return {
    ok: false,
    reason: `extracted facts did not match source tokens: ${expectedTokens.slice(0, 8).join(", ")}`,
  };
}

function distinctiveSourceTokens(value) {
  const stop = new Set([
    "about",
    "applicant",
    "applicants",
    "application",
    "applications",
    "apply",
    "award",
    "awards",
    "eligibility",
    "fellowship",
    "fellowships",
    "grant",
    "grants",
    "home",
    "homepage",
    "page",
    "program",
    "programs",
    "scholar",
    "scholars",
    "scholarship",
    "scholarships",
    "source",
    "student",
    "students",
    "the",
    "and",
    "for",
    "with",
  ]);
  return normalizeText(value)
    .split(/\s+/)
    .filter((token) => token.length >= 4 && !stop.has(token))
    .slice(0, 18);
}

async function syncR2SnapshotPair(source, capture) {
  const client = getR2Client();
  const existingRecord = await loadR2SnapshotRecord(source.id);
  const latestFiles = captureR2Files(capture);
  const latestKeys = await uploadR2CaptureFiles(
    client,
    source.id,
    latestFiles,
    immutableR2CaptureVersion(capture),
  );
  const history = rotatedVisualSnapshotHistory(existingRecord, latestKeys);
  const staleKeys = await upsertR2SnapshotRecord(source, capture, {
    expectedRecord: existingRecord,
    latestKeys,
    previousObjectKeys: history.previous_object_keys,
    previousHashes: history.previous_hashes,
    previousMetadata: history.previous_metadata,
    previousCapturedAt: history.previous_captured_at,
  });
  await Promise.all(staleKeys.map((key) => deleteR2Object(client, key)));

  return {
    uploaded: Object.keys(latestKeys).length,
    rotated: Object.keys(history.previous_object_keys).length,
  };
}

async function syncR2LocalizationLatest(source, capture) {
  const client = getR2Client();
  const existingRecord = await loadR2SnapshotRecord(source.id);
  const latestFiles = captureR2Files(capture);
  const latestKeys = await uploadR2CaptureFiles(
    client,
    source.id,
    latestFiles,
    immutableR2CaptureVersion(capture),
  );

  const hadPrevious = Object.keys(jsonObjectOrEmpty(existingRecord?.previous_object_keys)).length > 0;
  const history = refreshedLatestVisualSnapshotHistory(existingRecord, {
    resetPrevious: resetPreviousSnapshot,
  });

  const staleKeys = await upsertR2SnapshotRecord(source, capture, {
    expectedRecord: existingRecord,
    latestKeys,
    previousObjectKeys: history.previous_object_keys,
    previousHashes: history.previous_hashes,
    previousMetadata: history.previous_metadata,
    previousCapturedAt: history.previous_captured_at,
  });
  await Promise.all(staleKeys.map((key) => deleteR2Object(client, key)));

  return {
    uploaded: Object.keys(latestKeys).length,
    rotated: 0,
    previousReset: resetPreviousSnapshot && hadPrevious ? 1 : 0,
  };
}

async function syncR2BackfillLatestOnly(source, capture) {
  const client = getR2Client();
  const existingRecord = await loadR2SnapshotRecord(source.id);
  if (Object.keys(jsonObjectOrEmpty(existingRecord?.latest_object_keys)).length) {
    return { uploaded: 0, rotated: 0, skippedExisting: true };
  }
  const latestFiles = captureR2Files(capture);
  const latestKeys = await uploadR2CaptureFiles(
    client,
    source.id,
    latestFiles,
    immutableR2CaptureVersion(capture),
  );

  const staleKeys = await upsertR2SnapshotRecord(source, capture, {
    expectedRecord: existingRecord,
    latestKeys,
    previousObjectKeys: {},
    previousHashes: {},
    previousMetadata: {},
    previousCapturedAt: null,
  });
  await Promise.all(staleKeys.map((key) => deleteR2Object(client, key)));

  return {
    uploaded: Object.keys(latestKeys).length,
    rotated: 0,
  };
}

function getR2Client() {
  if (!r2Client) {
    r2Client = new S3Client({
      region: "auto",
      endpoint: r2Endpoint,
      forcePathStyle: true,
      credentials: {
        accessKeyId: r2AccessKeyId,
        secretAccessKey: r2SecretAccessKey,
      },
    });
  }

  return r2Client;
}

async function loadExistingR2SnapshotSourceIds(sourceIds) {
  const existing = new Set();
  // Supabase/PostgREST encodes `.in()` values in the GET query string. A
  // 500-item UUID batch can exceed proxy URL limits and surface as a generic
  // `fetch failed`, even while normal health queries succeed.
  const chunkSize = 100;

  for (let index = 0; index < sourceIds.length; index += chunkSize) {
    const chunk = sourceIds.slice(index, index + chunkSize);
    const { data, error } = await supabase
      .from("shared_award_source_visual_snapshots")
      .select("shared_award_source_id, latest_object_keys")
      .in("shared_award_source_id", chunk);

    if (error) {
      throw new Error(describeSupabaseError(error, "load existing R2 visual snapshot records"));
    }

    for (const row of data || []) {
      if (Object.keys(jsonObjectOrEmpty(row.latest_object_keys)).length) {
        existing.add(row.shared_award_source_id);
      }
    }
  }

  return existing;
}

async function loadR2SnapshotRecord(sourceId) {
  const { data, error } = await supabase
    .from("shared_award_source_visual_snapshots")
    .select(
      "shared_award_source_id, shared_award_id, kind, bucket, source_url, latest_captured_at, latest_object_keys, latest_hashes, latest_metadata, previous_captured_at, previous_object_keys, previous_hashes, previous_metadata, updated_at",
    )
    .eq("shared_award_source_id", sourceId)
    .maybeSingle();

  if (error) throw new Error(describeSupabaseError(error, "load R2 visual snapshot record"));
  return data || null;
}

async function uploadR2CaptureFiles(client, sourceId, files, version) {
  const uploaded = await Promise.all(files.map(async (file) => {
    const key = `visual-snapshots/sources/${sourceId}/captures/${version}/${file.fileName}`;
    await sendR2Command(
      client,
      () => new PutObjectCommand({
        Bucket: r2Bucket,
        Key: key,
        Body: readFileSync(file.path),
        ContentType: file.contentType,
      }),
      `put ${key}`,
    );
    return [file.name, key];
  }));

  return Object.fromEntries(uploaded);
}

function immutableR2CaptureVersion(capture) {
  return crypto.createHash("sha256").update(JSON.stringify({
    captured_at: capture?.captured_at || null,
    hashes: r2CaptureHashes(capture),
  })).digest("hex").slice(0, 32);
}

async function deleteR2Object(client, key) {
  try {
    await sendR2Command(
      client,
      () => new DeleteObjectCommand({
        Bucket: r2Bucket,
        Key: key,
      }),
      `delete ${key}`,
    );
  } catch (error) {
    if (!isR2NotFoundError(error)) throw error;
  }
}

async function upsertR2SnapshotRecord(source, capture, snapshot) {
  const snapshotRow = {
    shared_award_source_id: source.id,
    shared_award_id: source.shared_award_id,
    source_url: source.url,
    source_title: source.title || null,
    source_page_type: source.page_type || null,
    kind: capture.kind || "webpage",
    bucket: r2Bucket,
    latest_captured_at: capture.captured_at,
    latest_object_keys: snapshot.latestKeys,
    latest_hashes: r2CaptureHashes(capture),
    latest_metadata: r2CaptureMetadata(capture),
    previous_captured_at: snapshot.previousCapturedAt,
    previous_object_keys: snapshot.previousObjectKeys,
    previous_hashes: snapshot.previousHashes,
    previous_metadata: snapshot.previousMetadata,
    updated_at: new Date().toISOString(),
  };
  const advanced = await advanceVisualSnapshotPointer(supabase, {
    existing: snapshot.expectedRecord,
    snapshot: snapshotRow,
  });
  if (!advanced) {
    const current = await loadR2SnapshotRecord(source.id);
    const orphanKeys = visualSnapshotUploadedKeysToDeleteAfterLostCas({
      uploaded: snapshot.latestKeys,
      current,
    });
    await Promise.all(orphanKeys.map((key) => deleteR2Object(getR2Client(), key)));
    throw new Error("Visual snapshot pointer compare-and-set lost to another source writer.");
  }
  return visualSnapshotKeysToDeleteAfterCas({
    pointerAdvanced: advanced,
    existing: snapshot.expectedRecord,
    next: snapshotRow,
  });
}

function captureR2Files(capture) {
  const files = [];
  const addIfPresent = (name, fileName, path, contentType) => {
    if (!path || !existsSync(path)) return;
    files.push({ name, fileName, path, contentType });
  };

  addIfPresent("page", "page.jpg", capture.page_path, "image/jpeg");
  addIfPresent("thumb", "thumb.jpg", capture.thumb_path, "image/jpeg");
  addIfPresent("pdf", "document.pdf", capture.pdf_path, "application/pdf");
  addIfPresent("text", "text.txt", capture.text_path, "text/plain; charset=utf-8");
  addIfPresent("layout", "layout.json", capture.layout_path, "application/json; charset=utf-8");
  addIfPresent("meta", "meta.json", capture.meta_path, "application/json; charset=utf-8");
  if (capture.persist_expansion_state_screenshots) {
    for (const [index, state] of (capture.expansion_state_screenshots || []).entries()) {
      addIfPresent(
        `expansion_state_${String(index + 1).padStart(2, "0")}`,
        `expansion-state-${String(index + 1).padStart(2, "0")}.jpg`,
        state.page_path,
        "image/jpeg",
      );
      addIfPresent(
        `expansion_state_${String(index + 1).padStart(2, "0")}_layout`,
        `expansion-state-${String(index + 1).padStart(2, "0")}-layout.json`,
        state.layout_path,
        "application/json; charset=utf-8",
      );
    }
  }

  return files;
}

function r2CaptureHashes(capture) {
  return {
    image_hash: capture.image_hash || null,
    text_hash: capture.text_hash || null,
    body_text_hash: capture.body_text_hash || null,
    main_content_hash: capture.main_content_hash || null,
    nav_header_footer_hash: capture.nav_header_footer_hash || null,
    expansion_hash: capture.expansion_hash || null,
    layout_hash: capture.layout_hash || capture.text_geometry?.geometry_hash || null,
    file_hash: capture.file_hash || null,
  };
}

function r2CaptureMetadata(capture) {
  return {
    capture_profile: capture.capture_profile || null,
    final_url: capture.final_url || null,
    page_title: capture.page_title || null,
    status_code: capture.status_code || null,
    status_text: capture.status_text || null,
    content_type: capture.content_type || null,
    text_length: capture.text_length || 0,
    body_text_length: capture.body_text_length || 0,
    main_content_text_length: capture.main_content_text_length || 0,
    nav_header_footer_text_length: capture.nav_header_footer_text_length || 0,
    expansion_text_length: capture.expansion_text_length || 0,
    file_bytes: capture.file_bytes || null,
    page_bytes: capture.page_bytes || null,
    thumb_bytes: capture.thumb_bytes || null,
    dimensions: capture.dimensions || null,
    layout_hash: capture.layout_hash || capture.text_geometry?.geometry_hash || null,
    text_geometry: capture.text_geometry
      ? textGeometryReference(capture.text_geometry, capture.layout_path)
      : null,
    page_count: capture.page_count || null,
    expansion_state_count: capture.expansion_state_screenshots?.length || 0,
    expansion_state_screenshots:
      capture.expansion_state_screenshots?.map((state) => ({
        state_id: state.state_id || null,
        label: state.label,
        image_hash: state.image_hash,
        layout_hash: state.layout_hash || state.text_geometry?.geometry_hash || null,
        text_geometry: state.text_geometry
          ? textGeometryReference(state.text_geometry, state.layout_path)
          : null,
        text_hash: state.text_hash,
        text_length: state.text_length,
        page_bytes: state.page_bytes,
        isolation: state.isolation || null,
      })) || [],
    pdf_text_error: capture.pdf_text_error || null,
    baseline_facts: capture.baseline_facts || null,
    baseline_facts_metadata: capture.baseline_facts_metadata || null,
    monitoring_disposition: capture.monitoring_disposition || null,
    localization: capture.localization || captureLocalizationMetadata(capture),
  };
}

function captureLocalizationMetadata(capture) {
  const pageSettle = jsonObjectOrEmpty(capture.page_settle);
  const after = jsonObjectOrEmpty(pageSettle.after);
  const dimensions = jsonObjectOrEmpty(capture.dimensions);
  const textGeometry = jsonObjectOrEmpty(capture.text_geometry);
  const geometryScreenshot = jsonObjectOrEmpty(textGeometry.screenshot);
  const hasLayoutSample = Boolean(cleanText(pageSettle.after_layout_sample));
  const hasScrollHeight = Boolean(
    nonNegativeNumber(dimensions.scroll_height, 0) ||
      nonNegativeNumber(after.scroll_height, 0),
  );
  const geometryReady = Boolean(
    cleanText(textGeometry.geometry_hash) &&
      cleanText(geometryScreenshot.image_hash) &&
      nonNegativeNumber(textGeometry.run_count, 0) > 0,
  );
  const repairAttempted = cleanText(capture.capture_profile) === "localization-repair";
  return {
    status: capture.kind === "pdf"
      ? "not_applicable_pdf"
      : geometryReady
        ? "geometry_ready"
        : repairAttempted
          ? "capture_layout_unavailable"
          : "metadata_missing",
    exact: false,
    accounted_for: capture.kind === "pdf" || geometryReady || repairAttempted,
    geometry_ready: geometryReady,
    geometry_hash: cleanText(textGeometry.geometry_hash) || null,
    bound_image_hash: cleanText(geometryScreenshot.image_hash) || null,
    layout_sample_present: hasLayoutSample,
    scroll_height_present: hasScrollHeight,
    capture_behavior_version: capture.capture_behavior_version || null,
    captured_at: capture.captured_at || null,
  };
}

function jsonObjectOrEmpty(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function isR2NotFoundError(error) {
  return (
    error?.$metadata?.httpStatusCode === 404 ||
    error?.name === "NotFound" ||
    error?.Code === "NoSuchKey"
  );
}

async function sendR2Command(client, createCommand, label) {
  let attempt = 0;
  while (true) {
    try {
      return await client.send(createCommand());
    } catch (error) {
      attempt += 1;
      if (attempt > r2OperationRetries || !isTransientR2Error(error)) {
        throw error;
      }

      const waitMs = Math.min(10_000, 500 * 2 ** (attempt - 1));
      console.log(`R2 RETRY attempt=${attempt}/${r2OperationRetries} wait_ms=${waitMs} op=${label} message=${errorMessage(error)}`);
      await sleep(waitMs);
    }
  }
}

function isTransientR2Error(error) {
  if (isR2NotFoundError(error)) return false;
  const status = Number(error?.$metadata?.httpStatusCode || error?.statusCode || 0);
  if ([408, 429, 500, 502, 503, 504].includes(status)) return true;

  const name = String(error?.name || error?.code || "").toLowerCase();
  if (["timeout_error", "timeout", "throttling", "slowdown", "requesttimeout"].includes(name)) {
    return true;
  }

  const message = errorMessage(error).toLowerCase();
  return [
    "bad record mac",
    "econnreset",
    "etimedout",
    "socket hang up",
    "tls",
    "ssl",
    "network",
    "temporarily unavailable",
  ].some((part) => message.includes(part));
}

async function createThumbnail(context, pageBuffer) {
  const thumbPage = await context.newPage();
  try {
    await thumbPage.setViewportSize({ width: Math.min(thumbWidth, viewportWidth), height: 1200 });
    const dataUrl = `data:image/jpeg;base64,${pageBuffer.toString("base64")}`;
    await thumbPage.setContent(
      [
        "<!doctype html><html><head><meta charset=\"utf-8\">",
        "<style>html,body{margin:0;padding:0;background:white;overflow:hidden}</style>",
        "</head><body><img id=\"source\" alt=\"snapshot\" src=\"",
        dataUrl,
        "\"></body></html>",
      ].join(""),
      { waitUntil: "load" },
    );

    const data = await thumbPage.evaluate(
      async ({ width, quality }) => {
        const img = document.getElementById("source");
        await img.decode().catch(() => null);
        const maxHeight = 8000;
        const scale = Math.min(width / img.naturalWidth, maxHeight / img.naturalHeight, 1);
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
        const context2d = canvas.getContext("2d");
        context2d.fillStyle = "#ffffff";
        context2d.fillRect(0, 0, canvas.width, canvas.height);
        context2d.drawImage(img, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL("image/jpeg", quality);
      },
      { width: thumbWidth, quality: jpegQuality / 100 },
    );
    return Buffer.from(data.replace(/^data:image\/jpeg;base64,/, ""), "base64");
  } finally {
    await thumbPage.close().catch(() => null);
  }
}

async function hideNoiseElements(page) {
  return page.evaluate((keywords) => {
    const counts = {};
    const protectedMainSelectors = "main, article, [role='main'], .content, #content";
    const awardTerms =
      /\b(deadline|due|application|apply|eligib|requirement|recommendation|transcript|essay|interview|funding|stipend|tuition|award amount|nomination|guideline|pdf)\b/i;

    function textOf(element) {
      return (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
    }

    function selectorSignals(element) {
      return [
        element.id,
        element.className,
        element.getAttribute("aria-label"),
        element.getAttribute("role"),
        element.getAttribute("data-testid"),
        element.getAttribute("data-test"),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
    }

    function isProtectedMainContent(element, signal) {
      if (element.matches(protectedMainSelectors)) return true;
      if (element.closest("main, article, [role='main']") && awardTerms.test(textOf(element))) {
        return !/(cookie|consent|gdpr|popup|modal|newsletter|subscribe|chat|intercom|drift|crisp|ad|ads|advertisement|sponsor|carousel|slider|swiper|slick|marquee)/i.test(signal);
      }
      if (awardTerms.test(textOf(element))) {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        const overlayLike =
          style.position === "fixed" ||
          style.position === "sticky" ||
          rect.width * rect.height < window.innerWidth * window.innerHeight * 0.25;
        const explicitNoise = /(cookie|consent|gdpr|popup|modal|newsletter|subscribe|chat|intercom|drift|crisp|advertisement|ad-banner|social-share|sharebar)/i.test(
          signal,
        );
        const decorativeNoise = /(sponsor|carousel|slider|swiper|slick|marquee)/i.test(signal);
        if (!explicitNoise && !(decorativeNoise && overlayLike)) return true;
      }
      return false;
    }

    function hide(element, reason) {
      if (!(element instanceof HTMLElement)) return;
      if (element.hasAttribute("data-awardping-hidden-noise")) return;
      const signal = selectorSignals(element);
      if (isProtectedMainContent(element, signal)) return;
      counts[reason] = (counts[reason] || 0) + 1;
      element.setAttribute("data-awardping-hidden-noise", reason);
      element.style.setProperty("display", "none", "important");
      element.style.setProperty("visibility", "hidden", "important");
    }

    const selectorRules = [
      ["cookie", "[id*='cookie' i], [class*='cookie' i], [aria-label*='cookie' i]"],
      ["consent", "[id*='consent' i], [class*='consent' i], [aria-label*='consent' i]"],
      ["gdpr", "[id*='gdpr' i], [class*='gdpr' i]"],
      ["privacy-banner", "[id*='privacy-banner' i], [class*='privacy-banner' i]"],
      ["popup", "[id*='popup' i], [class*='popup' i]"],
      ["modal", "[id*='modal' i], [class*='modal' i], [role='dialog'], [aria-modal='true']"],
      ["newsletter", "[id*='newsletter' i], [class*='newsletter' i], [aria-label*='newsletter' i]"],
      ["subscribe", "[id*='subscribe' i], [class*='subscribe' i], [aria-label*='subscribe' i]"],
      ["intercom", "[id*='intercom' i], [class*='intercom' i]"],
      ["drift", "[id*='drift' i], [class*='drift' i]"],
      ["crisp", "[id*='crisp' i], [class*='crisp' i]"],
      ["chat", "[id*='chat' i], [class*='chat' i], [aria-label*='chat' i]"],
      ["chatbot", "[id*='chatbot' i], [class*='chatbot' i]"],
      ["ad", "[id='ad'], [class='ad'], [id*='advertisement' i], [class*='advertisement' i], [id*='ad-banner' i], [class*='ad-banner' i]"],
      ["ads", "[id*='ads' i], [class*='ads' i], [id*='google_ads' i], [class*='google_ads' i]"],
      ["sponsor", "[id*='sponsor' i], [class*='sponsor' i]"],
      ["dismissible-alert", "[class*='alert' i][class*='dismiss' i], [role='alert'][aria-live]"],
      ["sticky-social-share", "[id*='social-share' i], [class*='social-share' i], [id*='sharebar' i], [class*='sharebar' i]"],
    ];

    for (const [reason, selector] of selectorRules) {
      for (const element of document.querySelectorAll(selector)) {
        hide(element, reason);
      }
    }

    for (const element of document.querySelectorAll("body *")) {
      const signal = selectorSignals(element);
      if (!signal) continue;
      if (!keywords.some((keyword) => signal.includes(keyword))) continue;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const dynamicContent =
        /\b(carousel|slider|swiper|slick|marquee)\b/i.test(signal) ||
        /(?:^|[-_\s])(carousel|slider|swiper|slick|marquee)(?:$|[-_\s])/i.test(signal);
      const noisySignal =
        /(cookie|consent|gdpr|popup|modal|newsletter|subscribe|intercom|drift|crisp|chatbot|chat|advertisement|ad-banner|social-share|sharebar)/i.test(signal);
      if (dynamicContent && !noisySignal) continue;
      const overlayLike =
        style.position === "fixed" ||
        style.position === "sticky" ||
        (noisySignal && rect.width * rect.height < window.innerWidth * window.innerHeight * 0.35) ||
        noisySignal;
      if (overlayLike) hide(element, "keyword-noise");
    }

    for (const element of document.querySelectorAll("iframe[src], aside")) {
      const signal = selectorSignals(element) + " " + (element.getAttribute("src") || "");
      if (/(youtube|vimeo|doubleclick|googlesyndication|advertisement|ads|chat|intercom|drift|crisp|social|share)/i.test(signal)) {
        hide(element, "embedded-widget");
      }
    }

    return counts;
  }, noiseKeywords);
}

async function reviewCandidateWithAi(input) {
  assertAiAvailable("visual change review");
  if (aiProvider === "gemini-cli") return reviewWithGeminiCli(input);
  if (aiProvider === "gemini") return reviewWithGemini(input);
  if (aiProvider === "openai") return reviewWithOpenAI(input);
  throw new Error(`${missingAiMessage(requestedAiProvider)} Required for visual change review.`);
}

async function reviewWithGeminiCli(input) {
  ensureGeminiCliCallAvailable(input.report, "change_interpretation");
  const analysis = await runGeminiCliJsonAnalysis({
    cliPath: geminiCliPath,
    model: geminiCliModel,
    workspaceRoot: geminiCliWorkspaceRoot,
    timeoutMs: geminiCliTimeoutMs,
    safeModels: geminiCliSafeModels,
    allowUnsafeModel: allowUnsafeGeminiCliModel,
    runId: `diff-${timestampForPath(input.capture.captured_at)}-${input.source.id}`,
    prompt: geminiCliDiffPrompt(input),
    filePaths: geminiCliDiffFiles(input),
  });
  const result = normalizeAiReview(analysis.result, {
    source: input.source,
    diff: input.diff,
    provider: "gemini",
    model: geminiCliModel,
  });

  return {
    ok: true,
    provider: "gemini-cli",
    model: geminiCliModel,
    usage: analysis.usage,
    raw_text: analysis.raw_text,
    analysis_path: analysis.transcript_path || analysis.log_path,
    result,
  };
}

async function reviewWithGemini(input) {
  throw new Error("Immediate Gemini visual review is disabled. Use the Gemini Batch visual-review worker.");
}

async function reviewWithOpenAI(input) {
  const imageContent = openAiImageContent([input.previous.thumbPath, input.capture.thumb_path]);
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: aiModel,
      instructions: aiSystemPrompt,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: aiUserPrompt(input) },
            ...imageContent,
          ],
        },
      ],
      text: { format: { type: "json_object" } },
      max_output_tokens: 900,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) throw new Error(`OpenAI HTTP ${response.status}`);
  const data = await response.json();
  const rawText = extractResponseText(data);
  return {
    ok: true,
    provider: "openai",
    model: aiModel,
    raw_text: rawText,
    result: normalizeAiReview(rawText, {
      source: input.source,
      diff: input.diff,
      provider: "openai",
      model: aiModel,
    }),
  };
}

async function maybeExtractBaselineFacts(source, capture, report, options = {}) {
  if (!extractBaselineInfo) return null;
  assertAiAvailable("baseline fact extraction");

  try {
    const reason = options.reason || "baseline";
    const analysis =
      aiProvider === "gemini"
        ? await extractBaselineFactsWithGemini(source, capture, report, reason)
        : aiProvider === "gemini-cli"
          ? await extractBaselineFactsWithGeminiCli(source, capture, report, reason)
          : null;

    if (!analysis) {
      report.baseline_facts_skipped += 1;
      console.log(`FACTS SKIP provider=${aiProvider || "none"} ${sourceLabel(source)}`);
      return null;
    }

    attachBaselineFactsToCapture(capture, analysis.result, {
      reason,
      provider: analysis.provider,
      model: analysis.model,
      analysis_path: analysis.analysis_path || null,
      prompt_path: analysis.prompt_path || null,
    });
    report.baseline_facts_extracted += 1;
    console.log(`FACTS extracted confidence=${capture.baseline_facts?.confidence || "unknown"} ${sourceLabel(source)}`);
    return capture.baseline_facts;
  } catch (error) {
    if (error.geminiCliUsage) {
      recordGeminiCliUsage(report, source, capture, { usage: error.geminiCliUsage }, "baseline_facts");
    }
    if (error.aiUsage) {
      recordGeminiUsage(report, source, capture, { model: aiModel, usage: error.aiUsage }, "baseline_facts");
    }
    report.baseline_facts_failed += 1;
    const message = `Baseline facts extraction failed: ${errorMessage(error)}`;
    capture.baseline_facts_metadata = {
      status: "failed",
      reason: options.reason || "baseline",
      provider: aiProvider,
      model: aiModel,
      error: truncate(message, 800),
      extracted_at: new Date().toISOString(),
    };
    report.errors.push({
      source_id: source.id,
      source_url: source.url,
      message,
    });
    console.log(`FACTS FAILED ${message} ${sourceLabel(source)}`);
    return null;
  }
}

async function extractBaselineFactsWithGemini(source, capture, report, reason) {
  throw new Error("Immediate Gemini baseline extraction is disabled. Use the Gemini Batch baseline-facts worker.");
}

async function extractBaselineFactsWithGeminiCli(source, capture, report, reason) {
  if (!geminiCliCallAvailable(report)) {
    report.baseline_facts_skipped += 1;
    console.log(`FACTS SKIP gemini_cli_cap ${sourceLabel(source)}`);
    return null;
  }

  ensureGeminiCliCallAvailable(report, "baseline_facts");
  const analysis = await runGeminiCliJsonAnalysis({
    cliPath: geminiCliPath,
    model: geminiCliModel,
    workspaceRoot: geminiCliWorkspaceRoot,
    timeoutMs: geminiCliTimeoutMs,
    safeModels: geminiCliSafeModels,
    allowUnsafeModel: allowUnsafeGeminiCliModel,
    runId: `facts-${timestampForPath(capture.captured_at)}-${source.id}`,
    prompt: geminiCliBaselineFactsPrompt(source, capture, reason),
    filePaths: geminiCliBaselineFactFiles(capture),
  });
  recordGeminiCliUsage(report, source, capture, analysis, "baseline_facts");

  return {
    provider: "gemini-cli",
    model: geminiCliModel,
    usage: analysis.usage,
    raw_text: analysis.raw_text,
    analysis_path: analysis.transcript_path || analysis.log_path,
    prompt_path: analysis.prompt_path,
    result: analysis.result,
  };
}

function geminiCliBaselineFactsPrompt(source, capture, reason) {
  return [
    "You are extracting baseline page information for AwardPing from a captured official source page.",
    "Use the screenshot image when one is provided. Use the normalized visible text or PDF text as supporting context.",
    "Create a clean readable display_title and a short page_description for this exact source page, even when it is not an eligibility, deadline, or application page.",
    "Extract only facts that are visible or directly supported. Do not guess missing dates, amounts, or requirements.",
    "Return compact JSON with these keys:",
    "{status, display_title, page_description, page_category, award_name, award_name_seen, page_purpose, award_relevance, cycle_relevance, cycle_relevance_reason, application_cycle, deadline, opening_date, award_amounts, eligibility, requirements, application_materials, how_to_apply, important_dates, documents, contacts, notes, sections, confidence, evidence_quotes, quality_flags, rejection_reason}",
    "Use arrays for award_amounts, eligibility, requirements, application_materials, how_to_apply, important_dates, documents, contacts, notes, sections.",
    "Every important_dates item must include context plus the date, such as \"Application deadline: January 15, 2027\" or \"Award notifications: May 1\". Do not output bare dates.",
    "sections should list 0 to 8 visible scholarship concepts or page areas with {title, description, status}. Use status unchanged for baseline sections.",
    "award_relevance must be primary, supporting, unclear, or unrelated. Use primary only for the named award/program page or official application, deadline, eligibility, instruction, FAQ, portal, or document page for that same program. Use unrelated for sibling awards/programs, institutional resource/policy pages, event/seminar/news/archive/recipient pages, generic portals, payment/travel/logos/files, or pages that merely share the organization/domain.",
    "cycle_relevance must be current_or_upcoming, evergreen, archived_or_past, unclear, or not_program_page. Use current_or_upcoming for visible current/future cycle, year, deadline, or application instructions. Use evergreen for active official application information without a cycle year. Use archived_or_past for previous calls, past recipients/events, or stale years. Use not_program_page when the page is not about the named program application cycle.",
    "cycle_relevance_reason must be 12 words or fewer. application_cycle should be the visible year, term, or cycle name when present, otherwise null. confidence must be low, medium, or high.",
    "award_name_seen must be true only when the named award/program or an unmistakable abbreviation appears in the evidence. evidence_quotes must contain 1 to 5 short exact strings copied from the source text or screenshot that justify award_relevance, cycle_relevance, and any extracted facts.",
    "Default to award_relevance=unclear or cycle_relevance=unclear when uncertain. Default to rejection when uncertain: set status=rejected and rejection_reason when the page is unrelated, unclear, stale, a sibling award, a broad listing/search page, or lacks exact evidence quotes.",
    "Use null for unknown deadline/opening_date/page_purpose.",
    ...monitoringPolicyPromptLinesForScope("baseline_facts"),
    "",
    `Reason: ${reason}`,
    `Award name: ${source.shared_awards?.name || "Unknown award"}`,
    `Source title: ${source.title || "Unknown source"}`,
    `Source URL: ${source.url}`,
    `Page type: ${source.page_type || "unknown"}`,
    `Capture kind: ${capture.kind || "webpage"}`,
    "",
    "Capture metadata:",
    JSON.stringify({
      captured_at: capture.captured_at,
      final_url: capture.final_url,
      page_title: capture.page_title,
      status_code: capture.status_code || null,
      content_type: capture.content_type || null,
      page_count: capture.page_count || null,
      text_length: capture.text_length || 0,
      dimensions: capture.dimensions || null,
    }),
    "",
    "Normalized visible text excerpt:",
    String(capture.text || "").slice(0, promptChars),
    ...(capture.section_text_for_baseline_facts
      ? [
          "",
          "Structured expandable section text excerpt:",
          String(capture.section_text_for_baseline_facts || "").slice(0, 6000),
        ]
      : []),
  ].join("\n");
}

function geminiCliDiffPrompt({ source, baseline, previous, capture, diff, deterministic }) {
  const hasImages = geminiCliDiffFiles({ previous, capture }).length > 0;
  return [
    "You are judging official award source changes for scholarship advisors.",
    hasImages
      ? "Compare the two provided screenshot thumbnails first: previous then new. Use normalized text only as secondary context."
      : "This source is a PDF or has no screenshot image. Compare the extracted previous and new text carefully.",
    "Return strict compact JSON only with these keys:",
    "{is_true_change, is_alert_worthy, source_relevance, source_relevance_reason, changed_facts, exact_before, exact_after, evidence_location, noise_reason, reader_summary, advisor_impact, changed_section, confidence, before, after, change_type, structured_diff, noise_flags, quality_flags, rejection_reason, updated_baseline_facts}",
    "is_true_change must be true only for concrete award-relevant changes: deadlines, opening/closing dates, eligibility, requirements, nomination/recommendation instructions, documents/PDF/guidelines, award amount/funding, or application instructions.",
    "Default to rejection when uncertain. source_relevance must be primary or supporting to approve; use unrelated or unclear for sibling awards, broad listings/search pages, stale archives, or pages not clearly about this exact award.",
    "Reject cookie banners, carousels, ads, current-date-only changes, font/reflow/lazy-image changes, navigation/footer/sidebar changes, social widgets, featured-fellow/alumni/profile roster rotations, recipient/news churn, unrelated research/news pages, access/security/404 pages, and file-hash/file-size-only PDF or document changes.",
    ...monitoringPolicyPromptLinesForScope("visual_snapshot_gemini_cli"),
    "Do not treat page redesign, image changes, popups, navigation, staff/profile/fellow/news rotations, or file metadata as applicant-facing changes. Never use facts from sibling awards or broad search/listing pages.",
    "For PDFs, Word forms, and downloadable files, is_true_change must be false unless you can name the actual changed wording, date, requirement, amount, or applicant instruction. Do not approve a change just because the file bytes, hash, or size changed.",
    "changed_facts must list only applicant-facing facts. exact_before and exact_after must be exact strings from deterministic diff evidence, or null only when the change is one-sided and the other side is genuinely absent.",
    "Do not describe text as added if that same wording is already present in the previous capture. Do not describe text as removed if that same wording is still present in the new capture.",
    "For structured_diff, added_text must be exact wording present in the new capture and absent from the previous capture; removed_text must be exact wording present in the previous capture and absent from the new capture.",
    "reader_summary should be one or two plain-English advisor-facing sentences when true; otherwise null.",
    "advisor_impact should say what an advising office might need to check or update when true; otherwise null.",
    "confidence must be low, medium, or high. If confidence is low, set is_true_change=false.",
    "structured_diff should include arrays: added_text, removed_text, date_changes, amount_changes, noise_flags, plus likely_section and page_type.",
    "updated_baseline_facts should use the same baseline facts shape when the new page clearly exposes requirements/deadlines/etc.; otherwise null.",
    "",
    `Award name: ${source.shared_awards?.name || "Unknown award"}`,
    `Source title: ${source.title || "Unknown source"}`,
    `Source URL: ${source.url}`,
    `Page type: ${source.page_type || "unknown"}`,
    "",
    "Previous baseline metadata:",
    JSON.stringify({
      captured_at: baseline.captured_at,
      final_url: baseline.final_url,
      page_title: baseline.page_title,
      text_hash: baseline.text_hash,
      image_hash: baseline.image_hash,
      file_hash: baseline.file_hash || null,
      capture: baseline.capture,
    }),
    "",
    "New capture metadata:",
    JSON.stringify({
      captured_at: capture.captured_at,
      final_url: capture.final_url,
      page_title: capture.page_title,
      text_hash: capture.text_hash,
      image_hash: capture.image_hash,
      file_hash: capture.file_hash || null,
      hidden_noise_counts: capture.hidden_noise_counts,
      page_count: capture.page_count || null,
    }),
    "",
    "Deterministic classification:",
    JSON.stringify(deterministic),
    "",
    "Deterministic text/PDF diff summary:",
    JSON.stringify(diff),
    "",
    "Previous normalized text excerpt:",
    String(previous.text || "").slice(0, promptChars),
    "",
    "New normalized text excerpt:",
    String(capture.text || "").slice(0, promptChars),
  ].join("\n");
}

function geminiCliDiffFiles({ previous, capture }) {
  return [previous.thumbPath, capture.thumb_path].filter(Boolean);
}

function geminiCliBaselineFactFiles(capture) {
  return [capture.thumb_path].filter(Boolean);
}

function aiUserPrompt({ source, baseline, previous, capture, diff, deterministic }) {
  return [
    `Award name: ${source.shared_awards?.name || "Unknown award"}`,
    `Source title: ${source.title || "Unknown source"}`,
    `Source URL: ${source.url}`,
    `Page type: ${source.page_type || "unknown"}`,
    "",
    "Previous baseline metadata:",
    JSON.stringify({
      captured_at: baseline.captured_at,
      final_url: baseline.final_url,
      page_title: baseline.page_title,
      text_hash: baseline.text_hash,
      image_hash: baseline.image_hash,
      capture: baseline.capture,
    }),
    "",
    "New capture metadata:",
    JSON.stringify({
      captured_at: capture.captured_at,
      final_url: capture.final_url,
      page_title: capture.page_title,
      text_hash: capture.text_hash,
      image_hash: capture.image_hash,
      files: capture.files,
      hidden_noise_counts: capture.hidden_noise_counts,
    }),
    "",
    previous.thumbPath && capture.thumb_path
      ? "Screenshot comparison is the primary signal. The two attached images are the previous thumbnail and the new thumbnail. Normalized text is secondary context and may be incomplete or noisy."
      : "No comparable screenshot thumbnails are attached. Compare the extracted previous and new text carefully, which may come from a PDF or other non-screenshot source.",
    "",
    "Deterministic classification:",
    JSON.stringify(deterministic),
    "",
    "Deterministic diff summary:",
    JSON.stringify(diff),
    "",
    "Previous normalized text excerpt:",
    String(previous.text || "").slice(0, promptChars),
    "",
    "New normalized text excerpt:",
    String(capture.text || "").slice(0, promptChars),
    "",
    "Full screenshot paths for local human review:",
    JSON.stringify({
      previous_page: previous.pagePath ? toArchiveRelative(previous.pagePath) : null,
      new_page: capture.page_path ? toArchiveRelative(capture.page_path) : null,
      previous_thumb: previous.thumbPath ? toArchiveRelative(previous.thumbPath) : null,
      new_thumb: capture.thumb_path ? toArchiveRelative(capture.thumb_path) : null,
      previous_pdf: previous.pdfPath ? toArchiveRelative(previous.pdfPath) : null,
      new_pdf: capture.pdf_path ? toArchiveRelative(capture.pdf_path) : null,
    }),
    "",
    "Return one strict JSON object only.",
  ].join("\n");
}

function saveTrueChange({ source, baseline, previous, capture, diff, deterministic, aiReview }) {
  const changeDir = changeDirForCapture(capture, source.id);
  mkdirSync(changeDir, { recursive: true });
  const evidence = copyEvidenceFiles(changeDir, previous, capture);
  const changePath = join(changeDir, "change.json");
  const change = {
    version: 1,
    source_id: source.id,
    shared_award_id: source.shared_award_id,
    award_name: source.shared_awards?.name || null,
    source_title: source.title || null,
    source_url: source.url,
    page_type: source.page_type || null,
    detected_at: new Date().toISOString(),
    previous_baseline_capture_path: baseline.capture?.dir || null,
    new_capture_path: toArchiveRelative(capture.dir),
    previous_hashes: {
      text_hash: baseline.text_hash,
      image_hash: baseline.image_hash,
      file_hash: baseline.file_hash || null,
    },
    new_hashes: {
      text_hash: capture.text_hash,
      image_hash: capture.image_hash,
      file_hash: capture.file_hash || null,
    },
    deterministic_classification: deterministic,
    deterministic_diff: diff,
    ai_provider: aiReview.provider,
    ai_model: aiReview.model,
    ai_result: aiReview.result,
    reader_summary: aiReview.result.reader_summary,
    advisor_impact: aiReview.result.advisor_impact,
    changed_section: aiReview.result.changed_section,
    confidence: aiReview.result.confidence,
    promotion_status: promote ? "promoted" : "promotion_disabled",
    files: evidence,
  };
  writeFileSync(changePath, JSON.stringify(change, null, 2), "utf8");
  return changePath;
}

function saveReviewRecord({ source, baseline, previous, capture, diff, deterministic, reason, aiReview }) {
  const reviewDir = reviewDirForCapture(capture, source.id);
  mkdirSync(reviewDir, { recursive: true });
  const evidence = copyEvidenceFiles(reviewDir, previous, capture);
  const reviewPath = join(reviewDir, "review.json");
  writeFileSync(
    reviewPath,
    JSON.stringify(
      {
        version: 1,
        reason,
        source: sourceMetadata(source),
        detected_at: new Date().toISOString(),
        previous_baseline_capture_path: baseline.capture?.dir || null,
        new_capture_path: toArchiveRelative(capture.dir),
        previous_hashes: {
          text_hash: baseline.text_hash,
          image_hash: baseline.image_hash,
          file_hash: baseline.file_hash || null,
        },
        new_hashes: {
          text_hash: capture.text_hash,
          image_hash: capture.image_hash,
          file_hash: capture.file_hash || null,
        },
        deterministic_classification: deterministic,
        deterministic_diff: diff,
        ai_provider: aiReview.provider || aiProvider,
        ai_model: aiReview.model || aiModel,
        ai_result: aiReview.result || null,
        ai_error: aiReview.error || null,
        files: evidence,
      },
      null,
      2,
    ),
    "utf8",
  );
  return reviewPath;
}

function saveRejectedRecord({ source, baseline, previous, capture, diff, deterministic, aiReview }) {
  const rejectedDir = rejectedDirForCapture(capture, source.id);
  mkdirSync(rejectedDir, { recursive: true });
  const rejectedPath = join(rejectedDir, "rejected.json");
  writeFileSync(
    rejectedPath,
    JSON.stringify(
      {
        version: 1,
        source: sourceMetadata(source),
        detected_at: new Date().toISOString(),
        noise_reason: aiReview.result.noise_reason || "AI rejected the candidate change.",
        previous_baseline_capture_path: baseline.capture?.dir || null,
        new_capture_path: toArchiveRelative(capture.dir),
        previous_hashes: {
          text_hash: baseline.text_hash,
          image_hash: baseline.image_hash,
          file_hash: baseline.file_hash || null,
        },
        new_hashes: {
          text_hash: capture.text_hash,
          image_hash: capture.image_hash,
          file_hash: capture.file_hash || null,
        },
        deterministic_classification: deterministic,
        deterministic_diff: diff,
        ai_provider: aiReview.provider,
        ai_model: aiReview.model,
        ai_result: aiReview.result,
        paths: {
          previous_text: toArchiveRelative(previous.textPath),
          previous_thumb: toArchiveRelative(previous.thumbPath),
          new_text: toArchiveRelative(capture.text_path),
          new_thumb: toArchiveRelative(capture.thumb_path),
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  return rejectedPath;
}

function copyEvidenceFiles(targetDir, previous, capture) {
  const files = {};
  const copyIfPresent = (key, sourcePath, targetName) => {
    if (!sourcePath || !existsSync(sourcePath)) return;
    files[key] = join(targetDir, targetName);
    copyFileSync(sourcePath, files[key]);
  };

  copyIfPresent("previous_page", previous.pagePath, "previous-page.jpg");
  copyIfPresent("new_page", capture.page_path, "new-page.jpg");
  copyIfPresent("previous_thumb", previous.thumbPath, "previous-thumb.jpg");
  copyIfPresent("new_thumb", capture.thumb_path, "new-thumb.jpg");
  copyIfPresent("previous_pdf", previous.pdfPath, "previous-document.pdf");
  copyIfPresent("new_pdf", capture.pdf_path, "new-document.pdf");
  copyIfPresent("previous_text", previous.textPath, "previous-text.txt");
  copyIfPresent("new_text", capture.text_path, "new-text.txt");
  copyIfPresent("previous_sections_text", previous.sectionsTextPath, "previous-sections.txt");
  copyIfPresent("new_sections_text", capture.sections_text_path, "new-sections.txt");
  copyIfPresent("previous_sections_json", previous.sectionsJsonPath, "previous-sections.json");
  copyIfPresent("new_sections_json", capture.sections_json_path, "new-sections.json");
  copyIfPresent("previous_meta", previous.metaPath, "previous-meta.json");
  copyIfPresent("new_meta", capture.meta_path, "new-meta.json");

  return Object.fromEntries(
    Object.entries(files).map(([key, value]) => [key, toArchiveRelative(value)]),
  );
}

function writeBaseline(source, capture, details) {
  const baselinePath = baselinePathForSource(source.id);
  mkdirSync(dirname(baselinePath), { recursive: true });
  const existingBaseline = readJsonIfExists(baselinePath);
  const existingCapturedAt = Date.parse(String(existingBaseline?.captured_at || ""));
  const candidateCapturedAt = Date.parse(String(capture?.captured_at || ""));
  if (
    Number.isFinite(existingCapturedAt) &&
    Number.isFinite(candidateCapturedAt) &&
    existingCapturedAt > candidateCapturedAt
  ) {
    return false;
  }
  const existingSummary = existingBaseline?.summary_metadata || {};
  const baseline = {
    version: 1,
    kind: capture.kind || "webpage",
    capture_behavior_version: capture.kind === "pdf" ? null : captureBehaviorVersion,
    capture_behavior_name: capture.kind === "pdf" ? null : captureBehaviorName,
    capture_profile: capture.capture_profile || captureProfile,
    section_extraction_profile: capture.section_extraction_profile || sectionExtractionProfile,
    source: sourceMetadata(source),
    captured_at: capture.captured_at,
    final_url: capture.final_url,
    page_title: capture.page_title,
    text_hash: capture.text_hash,
    body_text_hash: capture.body_text_hash || null,
    main_content_hash: capture.main_content_hash || null,
    nav_header_footer_hash: capture.nav_header_footer_hash || null,
    expansion_hash: capture.expansion_hash || null,
    expandable_sections_hash: capture.expandable_sections_hash || null,
    image_hash: capture.image_hash,
    layout_hash: capture.layout_hash || capture.text_geometry?.geometry_hash || null,
    text_geometry: capture.text_geometry
      ? textGeometryReference(capture.text_geometry, capture.layout_path)
      : null,
    file_hash: capture.file_hash || null,
    file_bytes: capture.file_bytes || null,
    text_length: capture.text_length,
    body_text_length: capture.body_text_length || null,
    main_content_text_length: capture.main_content_text_length || null,
    nav_header_footer_text_length: capture.nav_header_footer_text_length || null,
    expansion_text_length: capture.expansion_text_length || null,
    section_text_length: capture.section_text_length || null,
    expandable_sections: Array.isArray(capture.expandable_sections) ? capture.expandable_sections : [],
    dimensions: capture.dimensions,
    hidden_noise_counts: capture.hidden_noise_counts,
    capture: {
      dir: toArchiveRelative(capture.dir),
      page: capture.page_path ? toArchiveRelative(capture.page_path) : null,
      thumb: capture.thumb_path ? toArchiveRelative(capture.thumb_path) : null,
      pdf: capture.pdf_path ? toArchiveRelative(capture.pdf_path) : null,
      text: toArchiveRelative(capture.text_path),
      expansion_text: capture.expansion_text_path ? toArchiveRelative(capture.expansion_text_path) : null,
      sections_text: capture.sections_text_path ? toArchiveRelative(capture.sections_text_path) : null,
      sections_json: capture.sections_json_path ? toArchiveRelative(capture.sections_json_path) : null,
      layout: capture.layout_path ? toArchiveRelative(capture.layout_path) : null,
      meta: toArchiveRelative(capture.meta_path),
      expansion_states: (capture.expansion_state_screenshots || []).map((state) => ({
        state_id: state.state_id || null,
        index: state.index,
        label: state.label || null,
        captured_at: state.captured_at || null,
        image_hash: state.image_hash || null,
        layout_hash: state.layout_hash || state.text_geometry?.geometry_hash || null,
        isolation: state.isolation || null,
        page: state.page_path ? toArchiveRelative(state.page_path) : state.page || null,
        layout: state.layout_path ? toArchiveRelative(state.layout_path) : state.layout || null,
      })),
    },
    summary_metadata: {
      reason: details.reason,
      updated_at: new Date().toISOString(),
      ai_provider: aiProvider,
      ai_model: aiModel,
      previous_baseline: details.previous_baseline
        ? {
            captured_at: details.previous_baseline.captured_at || null,
            text_hash: details.previous_baseline.text_hash || null,
            body_text_hash: details.previous_baseline.body_text_hash || null,
            main_content_hash: details.previous_baseline.main_content_hash || null,
            nav_header_footer_hash: details.previous_baseline.nav_header_footer_hash || null,
            expansion_hash: details.previous_baseline.expansion_hash || null,
            expandable_sections_hash: details.previous_baseline.expandable_sections_hash || null,
            image_hash: details.previous_baseline.image_hash || null,
            file_hash: details.previous_baseline.file_hash || null,
            capture: details.previous_baseline.capture || null,
          }
        : null,
      previous_baseline_capture: details.previous_baseline_capture || null,
      baseline_facts: details.baseline_facts || capture.baseline_facts || existingSummary.baseline_facts || null,
      baseline_facts_metadata:
        details.baseline_facts_metadata ||
        capture.baseline_facts_metadata ||
        existingSummary.baseline_facts_metadata ||
        null,
      monitoring_disposition: details.monitoring_disposition || null,
    },
  };
  atomicWriteJson(baselinePath, baseline);
  localBaselineEvidenceCache.set(source.id, true);
  return true;
}

function readBaselineEvidence(baseline) {
  const evidence = baselineEvidenceStatus(baseline);
  if (!evidence.ok) return evidence;
  return {
    ...evidence,
    text: readFileSync(evidence.textPath, "utf8"),
    meta: readJsonIfExists(evidence.metaPath),
  };
}

function baselineEvidenceStatus(baseline) {
  if (!baseline || typeof baseline !== "object") return { ok: false, missing: ["baseline"] };
  const capture = baseline.capture || {};
  const kind = baseline.kind || (capture.pdf ? "pdf" : "webpage");
  const r2LocalizationStatus = String(
    baseline.summary_metadata?.r2_local_rehydration?.localization_status || "",
  ).trim();
  const mainGeometryIntentionallyUnavailable =
    r2LocalizationStatus === "evidence_only_geometry_unavailable";
  const expansionGeometryIntentionallyIncomplete = new Set([
    "evidence_only_geometry_unavailable",
    "evidence_only_expansion_geometry_incomplete",
  ]).has(r2LocalizationStatus);
  const captureExpansionStates = Array.isArray(capture.expansion_states)
    ? capture.expansion_states
    : [];
  const paths = {
    pagePath: capture.page ? fromArchiveRelative(capture.page) : null,
    thumbPath: capture.thumb ? fromArchiveRelative(capture.thumb) : null,
    pdfPath: capture.pdf ? fromArchiveRelative(capture.pdf) : null,
    textPath: fromArchiveRelative(capture.text),
    expansionTextPath: capture.expansion_text ? fromArchiveRelative(capture.expansion_text) : null,
    sectionsTextPath: capture.sections_text ? fromArchiveRelative(capture.sections_text) : null,
    sectionsJsonPath: capture.sections_json ? fromArchiveRelative(capture.sections_json) : null,
    layoutPath: capture.layout ? fromArchiveRelative(capture.layout) : null,
    expansionStateScreenshots: captureExpansionStates
      .map((state) => ({
        ...state,
        page_path: state?.page ? fromArchiveRelative(state.page) : null,
        layout_path: state?.layout ? fromArchiveRelative(state.layout) : null,
      })),
    metaPath: fromArchiveRelative(capture.meta),
  };
  const requiredPaths = kind === "pdf"
    ? [
        ["pdf", paths.pdfPath],
        ["text", paths.textPath],
        ["meta", paths.metaPath],
      ]
    : [
        ["page", paths.pagePath],
        ["thumb", paths.thumbPath],
        ["text", paths.textPath],
        ["meta", paths.metaPath],
        ...(!mainGeometryIntentionallyUnavailable ? [["layout", paths.layoutPath]] : []),
      ];
  const missing = requiredPaths
    .filter(([, value]) => !value || !existsSync(value))
    .map(([label]) => label);

  const meta = paths.metaPath && existsSync(paths.metaPath)
    ? readJsonIfExists(paths.metaPath)
    : null;
  const metadataExpansionStates = Array.isArray(meta?.expansion_state_screenshots)
    ? meta.expansion_state_screenshots
    : [];
  const metadataFileExpansionStates = Array.isArray(meta?.files?.expansion_states)
    ? meta.files.expansion_states
    : [];
  const expectedExpansionStateCount = Math.max(
    captureExpansionStates.length,
    metadataExpansionStates.length,
    metadataFileExpansionStates.length,
    Number.isInteger(meta?.expansion_state_count) && meta.expansion_state_count >= 0
      ? meta.expansion_state_count
      : 0,
    Number.isInteger(baseline.summary_metadata?.r2_local_rehydration?.expected_expansion_states) &&
      baseline.summary_metadata.r2_local_rehydration.expected_expansion_states >= 0
      ? baseline.summary_metadata.r2_local_rehydration.expected_expansion_states
      : 0,
  );
  if (kind !== "pdf" && !expansionGeometryIntentionallyIncomplete) {
    for (let index = 0; index < expectedExpansionStateCount; index += 1) {
      const state = paths.expansionStateScreenshots[index];
      const suffix = String(index + 1).padStart(2, "0");
      if (!state?.page_path || !existsSync(state.page_path)) {
        missing.push(`expansion_state_${suffix}_page`);
      }
      if (!state?.layout_path || !existsSync(state.layout_path)) {
        missing.push(`expansion_state_${suffix}_layout`);
      }
    }
  }
  if (missing.length) return { ok: false, missing };

  return {
    ok: true,
    kind,
    localizationStatus: r2LocalizationStatus || "exact_geometry_available",
    ...paths,
  };
}

function captureFromBaseline(baseline) {
  if (!baseline) return null;
  const evidence = readBaselineEvidence(baseline);
  if (!evidence.ok) return null;

  const meta = evidence.meta || {};
  return {
    ...meta,
    kind: evidence.kind,
    dir: baseline.capture?.dir ? fromArchiveRelative(baseline.capture.dir) : dirname(evidence.metaPath),
    section_extraction_profile: baseline.section_extraction_profile || meta.section_extraction_profile || null,
    page_path: evidence.pagePath,
    thumb_path: evidence.thumbPath,
    pdf_path: evidence.pdfPath,
    text_path: evidence.textPath,
    expansion_text_path: evidence.expansionTextPath,
    sections_text_path: evidence.sectionsTextPath,
    sections_json_path: evidence.sectionsJsonPath,
    layout_path: evidence.layoutPath,
    expansion_state_screenshots: evidence.expansionStateScreenshots,
    meta_path: evidence.metaPath,
    text: evidence.text,
    captured_at: baseline.captured_at || meta.captured_at || null,
    final_url: baseline.final_url || meta.final_url || null,
    page_title: baseline.page_title || meta.page_title || null,
    text_hash: baseline.text_hash || meta.text_hash || null,
    image_hash: baseline.image_hash || meta.image_hash || baseline.file_hash || null,
    layout_hash: baseline.layout_hash || meta.layout_hash || null,
    file_hash: baseline.file_hash || meta.file_hash || null,
    file_bytes: baseline.file_bytes || meta.file_bytes || null,
    text_length: baseline.text_length || meta.text_length || 0,
    body_text_hash: baseline.body_text_hash || meta.body_text_hash || null,
    main_content_hash: baseline.main_content_hash || meta.main_content_hash || null,
    nav_header_footer_hash: baseline.nav_header_footer_hash || meta.nav_header_footer_hash || null,
    expansion_hash: baseline.expansion_hash || meta.expansion_hash || null,
    expandable_sections_hash: baseline.expandable_sections_hash || meta.expandable_sections_hash || null,
    body_text_length: baseline.body_text_length || meta.body_text_length || 0,
    main_content_text_length: baseline.main_content_text_length || meta.main_content_text_length || 0,
    nav_header_footer_text_length: baseline.nav_header_footer_text_length || meta.nav_header_footer_text_length || 0,
    expansion_text_length: baseline.expansion_text_length || meta.expansion_text_length || 0,
    section_text_length: baseline.section_text_length || meta.section_text_length || 0,
    expandable_sections:
      (Array.isArray(baseline.expandable_sections) && baseline.expandable_sections.length
        ? baseline.expandable_sections
        : Array.isArray(meta.expandable_sections)
          ? meta.expandable_sections
          : []),
    dimensions: baseline.dimensions || meta.dimensions || null,
    hidden_noise_counts: baseline.hidden_noise_counts || meta.hidden_noise_counts || null,
    baseline_facts: baseline.summary_metadata?.baseline_facts || meta.baseline_facts || null,
    baseline_facts_metadata:
      baseline.summary_metadata?.baseline_facts_metadata || meta.baseline_facts_metadata || null,
  };
}

function buildDiffSummary(previousText, nextText, source) {
  const previousClean = normalizeVisibleText(previousText);
  const nextClean = normalizeVisibleText(nextText);
  const previousSentences = sentenceCandidates(previousClean);
  const nextSentences = sentenceCandidates(nextClean);
  const previousKeys = new Set(previousSentences.map(sentenceKey));
  const nextKeys = new Set(nextSentences.map(sentenceKey));
  const addedText = dedupeText(
    nextSentences.filter((sentence) => !previousKeys.has(sentenceKey(sentence))).filter(isUsefulChangedSentence),
  ).slice(0, 10);
  const removedText = dedupeText(
    previousSentences.filter((sentence) => !nextKeys.has(sentenceKey(sentence))).filter(isUsefulChangedSentence),
  ).slice(0, 10);
  const previousDates = new Set(contextualDatePhrases(previousClean));
  const nextDates = new Set(contextualDatePhrases(nextClean));
  const previousAmounts = new Set(contextualMoneyPhrases(previousClean));
  const nextAmounts = new Set(contextualMoneyPhrases(nextClean));
  const addedDates = [...nextDates].filter((value) => !previousDates.has(value));
  const removedDates = [...previousDates].filter((value) => !nextDates.has(value));
  const addedAmounts = [...nextAmounts].filter((value) => !previousAmounts.has(value));
  const removedAmounts = [...previousAmounts].filter((value) => !nextAmounts.has(value));
  const changedText = [...addedText, ...removedText, ...addedDates, ...removedDates, ...addedAmounts, ...removedAmounts].join(" ");

  return {
    source_context: {
      award_name: source.shared_awards?.name || null,
      source_title: source.title || null,
      source_url: source.url,
      page_type: source.page_type || null,
    },
    added_text: addedText,
    removed_text: removedText,
    date_changes: [
      ...addedDates.map((value) => `Added ${value}`),
      ...removedDates.map((value) => `Removed ${value}`),
    ],
    amount_changes: [
      ...addedAmounts.map((value) => `Added ${value}`),
      ...removedAmounts.map((value) => `Removed ${value}`),
    ],
    likely_section: inferSection(changedText || source.title || ""),
    changed_text_excerpt: truncate(changedText, 2400),
    previous_text_length: previousClean.length,
    new_text_length: nextClean.length,
    text_length_delta: nextClean.length - previousClean.length,
  };
}

function classifyDeterministicChange(diff, source) {
  const changedText = [
    ...diff.added_text,
    ...diff.removed_text,
    ...diff.date_changes,
    ...diff.amount_changes,
  ].join(" ");

  if (!changedText.trim()) {
    return {
      classification: "likely_noise",
      reason: "no_useful_changed_text",
      candidate_change: false,
    };
  }

  const fragments = [...diff.added_text, ...diff.removed_text];
  if (fragments.length && fragments.every(isVolatileOrBoilerplateFragment)) {
    return {
      classification: "likely_noise",
      reason: "volatile_or_boilerplate_only",
      candidate_change: false,
    };
  }

  if (looksLikeRecipientNewsOrPressText(changedText)) {
    return {
      classification: "likely_noise",
      reason: "recipient_news_or_press_churn",
      candidate_change: false,
    };
  }

  if (
    !diff.date_changes.length &&
    !diff.amount_changes.length &&
    hasRelativeAgeOnlyTextDiff(diff.removed_text, diff.added_text)
  ) {
    return {
      classification: "likely_noise",
      reason: "relative_age_timestamp_churn",
      candidate_change: false,
    };
  }

  if (
    hasAwardRelevantTerms(changedText) ||
    diff.date_changes.length > 0 ||
    diff.amount_changes.length > 0 ||
    isProtectedAwardPageType(source.page_type)
  ) {
    return {
      classification: "candidate_change",
      reason: "award_relevant_terms_or_context",
      candidate_change: true,
    };
  }

  return {
    classification: "likely_noise",
    reason: "no_award_relevant_terms",
    candidate_change: false,
  };
}

function gateVisualReviewCandidateForAi({
  source,
  baseline,
  previous,
  capture,
  diff,
  deterministic,
  report,
}) {
  const decision = classifyVisualReviewCandidate({
    source,
    baseline,
    previous,
    capture,
    diff,
    deterministic,
  });

  if (!decision.allowed) {
    report.deterministic_noise += 1;
    if (decision.source_rejected) {
      report.deterministic_source_rejected += 1;
    } else {
      report.deterministic_noise_rejected += 1;
    }
    if (decision.candidate_kind === "text_only") {
      report.text_only_noise_rejected += 1;
    }
    return { allowed: false, decision };
  }

  if (decision.candidate_kind === "visual_only") {
    report.visual_only_candidate_enqueued += 1;
  } else {
    report.text_only_candidate_enqueued += 1;
  }

  return {
    allowed: true,
    decision,
    deterministic: {
      ...deterministic,
      classification: decision.label || deterministic?.classification || "candidate_change",
      reason: decision.reason || deterministic?.reason || "deterministic_candidate_gate_passed",
      deterministic_gate: {
        label: decision.label,
        reason: decision.reason,
        candidate_kind: decision.candidate_kind,
        evidence: decision.evidence || {},
      },
    },
  };
}

async function loadSources(pageLimit) {
  if (sourceIdsFilter.size) {
    return loadSourcesByIds(pageLimit);
  }
  let pageSize = Math.min(sourceLoadPageSize, pageLimit);
  const sources = [];

  for (let from = 0; sources.length < pageLimit; ) {
    const to = from + pageSize - 1;
    const requestedPageSize = pageSize;
    const { data, error } = await buildSourcesQuery().range(from, to);

    if (error) {
      if (isSupabaseStatementTimeoutLike(error) && pageSize > minSourceLoadPageSize) {
        pageSize = Math.max(minSourceLoadPageSize, Math.floor(pageSize / 2));
        console.warn(`SOURCE_LOAD_TIMEOUT retrying with page_size=${pageSize} from=${from}`);
        continue;
      }
      if (sources.length > 0 && isSupabaseTransientLoadError(error)) {
        if (runTrigger === "scheduled") {
          throw new Error(
            `Scheduled source load incomplete after ${sources.length} rows: ${describeSupabaseError(
              error,
              "load shared award sources",
            )}`,
          );
        }
        console.warn(
          `SOURCE_LOAD_PARTIAL using loaded=${sources.length} after ${describeSupabaseError(
            error,
            "load shared award sources",
          )}`,
        );
        break;
      }
      throw new Error(describeSupabaseError(error, "load shared award sources"));
    }

    const page = data || [];
    sources.push(...filterMonitorableSourcesForCapture(page.filter(sourceMatchesShard)));
    from += requestedPageSize;

    if (page.length < requestedPageSize) {
      break;
    }
  }

  return sources.slice(0, pageLimit);
}

async function loadSourcesByIds(pageLimit) {
  const ids = [...sourceIdsFilter].slice(0, pageLimit);
  const sources = [];
  for (let index = 0; index < ids.length; index += 100) {
    const chunk = ids.slice(index, index + 100);
    const { data, error } = await buildSourcesQuery(chunk).range(0, chunk.length - 1);
    if (error) throw new Error(describeSupabaseError(error, "load filtered shared award sources"));
    sources.push(...filterMonitorableSourcesForCapture((data || []).filter(sourceMatchesShard)));
  }
  return sources.slice(0, pageLimit);
}

function filterMonitorableSourcesForCapture(sources) {
  const accepted = [];
  const rejected = new Map();

  for (const source of sources) {
    const decision = aiReviewEvidenceCapture
      ? sourceQualityDecision(source, { purpose: "discovery" })
      : sourceQualityDecision(source, { purpose: "monitoring" });
    if (decision.allowed) {
      accepted.push(source);
      continue;
    }

    const reason = decision.reason;
    rejected.set(reason, (rejected.get(reason) || 0) + 1);
  }

  if (rejected.size) {
    console.log(
      `SOURCE_QUALITY_SKIP ${[...rejected.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([reason, count]) => `${reason}=${count}`)
        .join(" ")}`,
    );
  }

  return accepted;
}

function isSupabaseStatementTimeoutLike(error) {
  return /statement timeout|upstream request timeout|timeout/i.test(String(error?.message || ""));
}

function isSupabaseTransientLoadError(error) {
  return /schema cache|connection terminated|upstream request timeout|statement timeout|timeout/i.test(
    String(error?.message || ""),
  );
}

function sourceMatchesShard(source) {
  if (shardCount <= 1) return true;
  if (sourceIdFilter || sourceUrlFilter) return true;
  return shardIndexForSource(source) === shardIndex;
}

function shardIndexForSource(source) {
  const key = sourceShardKey(source);
  const hex = hashText(key).slice(0, 12);
  return Number.parseInt(hex, 16) % shardCount;
}

function sourceShardKey(source) {
  try {
    return new URL(source.url).hostname.toLowerCase().replace(/^www\./, "") || source.id;
  } catch {
    return source.id || source.url || "unknown";
  }
}

function formatShardLabel() {
  return shardCount > 1 ? `${shardIndex + 1}/${shardCount}` : "none";
}

function hasBaselineForSource(source) {
  if (localBaselineEvidenceCache.has(source.id)) {
    return localBaselineEvidenceCache.get(source.id);
  }
  const inspection = inspectLocalBaselineEvidence({
    archiveRoot,
    sourceId: source.id,
  });
  const baseline = inspection.evidence_complete === true
    ? readJsonIfExists(baselinePathForSource(source.id))
    : null;
  const complete = inspection.evidence_complete === true && baselineEvidenceStatus(baseline).ok;
  localBaselineEvidenceCache.set(source.id, complete);
  return complete;
}

function needsMissingBaselineCompletion(source) {
  return !hasBaselineForSource(source) || needsPublishedSnapshotRepair(source);
}

function needsPublishedSnapshotRepair(source) {
  return r2SnapshotSync && r2RepairMissingSnapshots && !existingR2SnapshotSourceIds.has(source.id);
}

function needsCaptureBehaviorRefresh(baseline, capture) {
  const baselineKind = baseline.kind || (baseline.capture?.pdf ? "pdf" : "webpage");
  const captureKind = capture.kind || "webpage";
  if (baselineKind === "pdf" || captureKind === "pdf") return false;
  const baselineVersion = Number(baseline.capture_behavior_version || 0);
  return !Number.isFinite(baselineVersion) || baselineVersion < captureBehaviorVersion;
}

function orderSourcesForBaselineCoverage(sources) {
  return [...sources].sort((left, right) => {
    const leftPriority = baselineCoveragePriority(left);
    const rightPriority = baselineCoveragePriority(right);
    if (leftPriority !== rightPriority) return leftPriority - rightPriority;
    return sourceSortKey(left).localeCompare(sourceSortKey(right));
  });
}

function orderSourcesForIssueRepair(sources) {
  return [...sources].sort((left, right) => {
    const leftPriority = sourceIssuePriority(left);
    const rightPriority = sourceIssuePriority(right);
    if (leftPriority !== rightPriority) return leftPriority - rightPriority;

    if (leftPriority !== 9) {
      const failureDelta =
        nonNegativeInt(right.consecutive_failures, 0) - nonNegativeInt(left.consecutive_failures, 0);
      if (failureDelta !== 0) return failureDelta;
    }

    return sourceSortKey(left).localeCompare(sourceSortKey(right));
  });
}

function summarizeBaselineCoverage(sources) {
  let existing = 0;
  let knownBrokenMissing = 0;
  for (const source of sources) {
    if (hasBaselineForSource(source)) {
      existing += 1;
    } else if (isKnownBrokenSource(source)) {
      knownBrokenMissing += 1;
    }
  }
  const missing = Math.max(0, sources.length - existing);
  return {
    loaded_sources: sources.length,
    existing_baselines: existing,
    missing_baselines: missing,
    actionable_missing_baselines: Math.max(0, missing - knownBrokenMissing),
    known_broken_missing_baselines: knownBrokenMissing,
  };
}

function formatBaselineCoverage(label, coverage) {
  return `${label} loaded=${coverage.loaded_sources} existing=${coverage.existing_baselines} missing=${coverage.missing_baselines} actionable_missing=${coverage.actionable_missing_baselines} known_broken_missing=${coverage.known_broken_missing_baselines}`;
}

function baselineCoveragePriority(source) {
  if (!hasBaselineForSource(source) && !isKnownBrokenSource(source)) return 0;
  if (hasBaselineForSource(source)) return 1;
  return 2;
}

function hasOpenSourceIssue(source) {
  return Boolean(cleanText(source?.last_error));
}

function sourceIssuePriority(source) {
  if (!hasOpenSourceIssue(source)) return 9;

  const issueType = classifySourceIssue(source.last_error);
  if (
    [
      "security_challenge",
      "access_blocked",
      "http_403",
      "http_429",
      "http_5xx",
      "timeout",
    ].includes(issueType)
  ) {
    return 0;
  }
  if (["dns", "ssl"].includes(issueType)) return 1;
  if (["soft_404", "http_404"].includes(issueType)) return 3;
  return 2;
}

function classifySourceIssue(message) {
  const text = String(message || "").toLowerCase();
  if (!text) return "none";
  if (
    text.includes("invalid capture page: security_challenge") ||
    text.includes("robot challenge") ||
    text.includes("captcha") ||
    text.includes("checking if the site connection is secure") ||
    text.includes("checking the site connection security")
  ) {
    return "security_challenge";
  }
  if (
    text.includes("invalid capture page: access_blocked") ||
    text.includes("access denied") ||
    text.includes("forbidden") ||
    text.includes("blocked")
  ) {
    return "access_blocked";
  }
  if (text.includes("http 403")) return "http_403";
  if (text.includes("http 404") || text.includes("page load failed with http 404")) return "http_404";
  if (text.includes("invalid capture page: soft_404") || text.includes("page not found")) return "soft_404";
  if (text.includes("http 429")) return "http_429";
  if (/\bhttp 5\d\d\b/.test(text)) return "http_5xx";
  if (text.includes("timeout") || text.includes("timed out")) return "timeout";
  if (text.includes("net::err_name_not_resolved") || text.includes("dns") || text.includes("enotfound")) return "dns";
  if (text.includes("ssl") || text.includes("certificate") || text.includes("net::err_cert")) return "ssl";
  return "other";
}

function isRetryableAccessBlockError(error) {
  return [
    "security_challenge",
    "access_blocked",
    "http_403",
    "http_429",
    "http_5xx",
  ].includes(classifySourceIssue(errorMessage(error)));
}

function isKnownBrokenSource(source) {
  return getKnownBrokenSourceIds().has(source.id);
}

function getKnownBrokenSourceIds() {
  if (knownBrokenSourceIds) return knownBrokenSourceIds;
  knownBrokenSourceIds = new Set();
  const current = readJsonIfExists(brokenSourcesCurrentPath) || {};
  for (const record of Object.values(current)) {
    if (record?.source_id) knownBrokenSourceIds.add(record.source_id);
  }
  return knownBrokenSourceIds;
}

function sourceSortKey(source) {
  return [
    source.next_check_at || "",
    source.created_at || "",
    source.shared_awards?.name || "",
    source.title || "",
    source.url || "",
    source.id || "",
  ].join("\t");
}

function buildSourcesQuery(sourceIds = []) {
  let query = supabase
    .from("shared_award_sources")
    .select(
      "id, shared_award_id, url, title, display_title, page_description, page_metadata, page_metadata_generated_at, page_metadata_model, page_type, source, reason, submitted_by_user_id, last_checked_at, next_check_at, consecutive_failures, last_error, created_at, shared_awards!inner(id, name, status, official_homepage)",
    )
    .eq("shared_awards.status", "active")
    .eq("admin_review_status", "open");

  if (sourceIds.length) {
    query = query.in("id", sourceIds);
  }

  if (localizationRepair) {
    query = query.order("id", { ascending: true });
  } else {
    query = query
      .order("next_check_at", { ascending: true })
      .order("created_at", { ascending: true });
  }

  if (!includeNotDue) {
    query = query.lte("next_check_at", new Date().toISOString());
  }
  if (sourceIdFilter) {
    query = query.eq("id", sourceIdFilter);
  }
  if (sourceUrlFilter) {
    query = query.eq("url", sourceUrlFilter);
  }
  if (awardFilter) {
    query = query.ilike("shared_awards.name", `%${escapeLike(awardFilter)}%`);
  }

  return query;
}

async function startWorkerRun(report) {
  const { data, error } = await supabase
    .from("local_worker_runs")
    .insert({
      worker_name: visualWorkerName(),
      status: "running",
      ai_provider: aiProvider,
      metadata: visualWorkerMetadata(report),
    })
    .select("id")
    .maybeSingle();

  if (error) {
    if (isMissingMetadataColumnError(error)) {
      return startWorkerRunWithoutMetadata();
    }
    console.log(`WORKER RUN LOG DISABLED | ${describeSupabaseError(error, "record visual worker run")}`);
    return null;
  }

  const runId = data?.id || null;
  await markSupersededVisualWorkerRuns(runId);
  return runId;
}

async function finishWorkerRun(runId, status, errorMessageValue, report) {
  if (!runId) return;

  const { error } = await supabase
    .from("local_worker_runs")
    .update({
      status,
      checked_count: report.checked,
      changed_count: report.ai_true_changes,
      unchanged_count: report.unchanged,
      initial_count: report.baselined,
      discovered_count: report.discovered_pdf_sources + report.discovered_html_sources,
      failed_count: report.failed,
      error: errorMessageValue ? errorMessageValue.slice(0, 1000) : null,
      metadata: visualWorkerMetadata(report),
      finished_at: new Date().toISOString(),
    })
    .eq("id", runId);

  if (error) {
    if (isMissingMetadataColumnError(error)) {
      await finishWorkerRunWithoutMetadata(runId, status, errorMessageValue, report);
      return;
    }
    console.log(`WORKER RUN LOG FAILED | ${error.message}`);
  }
}

async function maybeUpdateBaselineCoverageProgress(runId, report, sources) {
  if (!runId || !sources.length) return;

  const processed =
    report.checked + report.failed + report.skipped_existing_baseline + report.skipped_pdf;
  if (processed <= 0) return;

  const nowMs = Date.now();
  const processedDelta = processed - lastBaselineCoverageProgressProcessed;
  const elapsedMs = nowMs - lastBaselineCoverageProgressUpdateAt;
  if (processedDelta < 25 && elapsedMs < 60_000) return;

  lastBaselineCoverageProgressProcessed = processed;
  lastBaselineCoverageProgressUpdateAt = nowMs;
  report.baseline_coverage_progress = summarizeBaselineCoverage(sources);
  console.log(formatBaselineCoverage("BASELINE_COVERAGE progress", report.baseline_coverage_progress));
  await updateWorkerRunMetadata(runId, report);
}

async function updateWorkerRunMetadata(runId, report) {
  if (!runId) return;

  const { error } = await supabase
    .from("local_worker_runs")
    .update({
      checked_count: report.checked,
      changed_count: report.ai_true_changes,
      unchanged_count: report.unchanged,
      initial_count: report.baselined,
      discovered_count: report.discovered_pdf_sources + report.discovered_html_sources,
      failed_count: report.failed,
      metadata: visualWorkerMetadata(report),
    })
    .eq("id", runId);

  if (error && !isMissingMetadataColumnError(error)) {
    console.log(`WORKER RUN METADATA UPDATE FAILED | ${error.message}`);
  }
}

async function maybePruneSnapshotHistory(report) {
  const tasks = [
    {
      label: "shared_award_source_snapshots",
      rpc: "prune_shared_award_source_snapshot_history",
      params: {
        p_keep_per_source: snapshotHistoryPruneKeep,
        p_batch_size: snapshotHistoryPruneBatchSize,
        p_preserve_change_event_snapshots: true,
      },
    },
    {
      label: "monitor_snapshots",
      rpc: "prune_monitor_snapshot_history",
      params: {
        p_keep_per_monitor: snapshotHistoryPruneKeep,
        p_batch_size: snapshotHistoryPruneBatchSize,
        p_preserve_change_event_snapshots: true,
      },
    },
  ];

  report.snapshot_history_prune.started_at = new Date().toISOString();

  for (const task of tasks) {
    const tableSummary = {
      batches: 0,
      candidate_count: 0,
      deleted_count: 0,
      maybe_more_remaining: false,
    };
    report.snapshot_history_prune.tables[task.label] = tableSummary;

    try {
      for (let batch = 1; batch <= snapshotHistoryPruneMaxBatches; batch += 1) {
        const { data, error } = await supabase.rpc(task.rpc, {
          ...task.params,
          p_apply: true,
        });

        if (error) throw error;

        const row = Array.isArray(data) ? data[0] : data;
        const candidateCount = nonNegativeInt(row?.candidate_count, 0);
        const deletedCount = nonNegativeInt(row?.deleted_count, 0);

        tableSummary.batches += 1;
        tableSummary.candidate_count += candidateCount;
        tableSummary.deleted_count += deletedCount;

        console.log(
          `SNAPSHOT_HISTORY_PRUNE table=${task.label} batch=${batch} candidates=${candidateCount} deleted=${deletedCount}`,
        );

        if (candidateCount < snapshotHistoryPruneBatchSize || deletedCount === 0) break;
      }

      tableSummary.maybe_more_remaining = tableSummary.batches >= snapshotHistoryPruneMaxBatches;
    } catch (error) {
      const message = `Snapshot history prune failed for ${task.label}: ${errorMessage(error)}`;
      report.snapshot_history_prune.error = message;
      console.log(`SNAPSHOT_HISTORY_PRUNE_FAILED ${message}`);
      break;
    }
  }

  report.snapshot_history_prune.finished_at = new Date().toISOString();
}

async function startWorkerRunWithoutMetadata() {
  const { data, error } = await supabase
    .from("local_worker_runs")
    .insert({
      worker_name: visualWorkerName(),
      status: "running",
      ai_provider: aiProvider,
    })
    .select("id")
    .maybeSingle();

  if (error) {
    console.log(`WORKER RUN LOG DISABLED | ${describeSupabaseError(error, "record visual worker run")}`);
    return null;
  }

  const runId = data?.id || null;
  await markSupersededVisualWorkerRuns(runId);
  return runId;
}

async function markSupersededVisualWorkerRuns(currentRunId) {
  if (!currentRunId || !supabase) return;

  const { data, error } = await supabase
    .from("local_worker_runs")
    .select("id,metadata")
    .eq("worker_name", visualWorkerName())
    .eq("status", "running")
    .neq("id", currentRunId)
    .limit(25);

  if (error) {
    console.log(`STALE_RUN_SCAN_FAILED | ${describeSupabaseError(error, "scan stale visual worker runs")}`);
    return;
  }

  for (const row of data || []) {
    const metadata = jsonObjectOrEmpty(row.metadata);
    const staleMetadata = {
      ...metadata,
      stale_marked_at: new Date().toISOString(),
      stale_reason: "Superseded by a newer local visual snapshot worker run after the launcher restarted.",
      superseded_by_run_id: currentRunId,
    };
    const { error: updateError } = await supabase
      .from("local_worker_runs")
      .update({
        status: "failed",
        error: "Superseded by a newer local visual snapshot worker run after restart.",
        finished_at: new Date().toISOString(),
        metadata: staleMetadata,
      })
      .eq("id", row.id)
      .eq("status", "running");

    if (updateError) {
      console.log(`STALE_RUN_MARK_FAILED id=${row.id} | ${describeSupabaseError(updateError, "mark stale visual worker run")}`);
    } else {
      console.log(`STALE_RUN_MARKED id=${row.id} superseded_by=${currentRunId}`);
    }
  }
}

async function finishWorkerRunWithoutMetadata(runId, status, errorMessageValue, report) {
  const { error } = await supabase
    .from("local_worker_runs")
    .update({
      status,
      checked_count: report.checked,
      changed_count: report.ai_true_changes,
      unchanged_count: report.unchanged,
      initial_count: report.baselined,
      discovered_count: report.discovered_pdf_sources + report.discovered_html_sources,
      failed_count: report.failed,
      error: errorMessageValue ? errorMessageValue.slice(0, 1000) : null,
      finished_at: new Date().toISOString(),
    })
    .eq("id", runId);

  if (error) {
    console.log(`WORKER RUN LOG FAILED | ${error.message}`);
  }
}

function visualWorkerMetadata(report) {
  const structuredReport = buildVisualRunReportSummary(report);
  return {
    report_schema_version: 2,
    kind: "visual_snapshot",
    heartbeat_at: new Date().toISOString(),
    run_identity: report.run_identity,
    archive_root: report.archive_root,
    monitoring_policy: report.monitoring_policy || currentVisualReviewPolicyIdentity(),
    monitoring_policy_bundle:
      report.monitoring_policy_bundle || currentMonitoringPolicyAuditIdentity(),
    suppression_policy: report.suppression_policy || changeEventSuppressionPolicyIdentity,
    worker_revision:
      cleanText(env.AWARDPING_WORKER_REVISION || env.GIT_COMMIT_SHA) || null,
    matcher_digest: monitoringPromotionMatcherDigest,
    ai_provider: report.ai_provider,
    ai_model: report.ai_model,
    ai_required: report.ai_required,
    ai_disabled_reason: report.ai_disabled_reason,
    stop_reason: report.stop_reason,
    billing_blocked: Boolean(report.billing_blocked),
    blocking_reason: report.blocking_reason || null,
    options: report.options,
    counts: {
      candidate_changes: report.candidate_changes,
      ai_true_changes: report.ai_true_changes,
      ai_rejected: report.ai_rejected,
      text_only_ignored: report.text_only_ignored,
      text_only_candidates: report.text_only_candidates,
      deterministic_noise: report.deterministic_noise,
      deterministic_source_rejected: report.deterministic_source_rejected,
      deterministic_noise_rejected: report.deterministic_noise_rejected,
      text_only_candidate_enqueued: report.text_only_candidate_enqueued,
      text_only_noise_rejected: report.text_only_noise_rejected,
      text_only_published_or_queued: report.text_only_published_or_queued,
      visual_only_candidate_enqueued: report.visual_only_candidate_enqueued,
      visual_review_candidate_observations:
        report.visual_review_candidate_observations,
      visual_review_candidate_observation_failures:
        report.visual_review_candidate_observation_failures,
      visual_noise: report.visual_noise,
      review: report.review,
      skipped_existing_baseline: report.skipped_existing_baseline,
      skipped_pdf: report.skipped_pdf,
      capture_behavior_refreshed: report.capture_behavior_refreshed,
      blocked_page_captures: report.blocked_page_captures,
      page_ready_waits: report.page_ready_waits,
      page_ready_timeouts: report.page_ready_timeouts,
      page_ready_wait_ms: report.page_ready_wait_ms,
      capture_settle_waits: report.capture_settle_waits,
      capture_settle_timeouts: report.capture_settle_timeouts,
      capture_settle_wait_ms: report.capture_settle_wait_ms,
      scroll_activation_runs: report.scroll_activation_runs,
      scroll_activation_steps: report.scroll_activation_steps,
      scroll_activation_wait_ms: report.scroll_activation_wait_ms,
      scroll_activation_changed: report.scroll_activation_changed,
      issue_sources_loaded: report.issue_sources_loaded,
      issue_sources_cleared: report.issue_sources_cleared,
      issue_sources_still_failing: report.issue_sources_still_failing,
      issue_sources_new_failures: report.issue_sources_new_failures,
      access_block_retries: report.access_block_retries,
      safe_redirect_url_updates: report.safe_redirect_url_updates,
      safe_redirect_url_update_skipped: report.safe_redirect_url_update_skipped,
      safe_redirect_url_update_failed: report.safe_redirect_url_update_failed,
      pdf_checked: report.pdf_checked,
      pdf_unchanged: report.pdf_unchanged,
      pdf_changed: report.pdf_changed,
      capture_profile: report.capture_profile,
      section_extraction_profile: report.section_extraction_profile,
      expandable_section_extraction_enabled: report.expandable_section_extraction_enabled,
      section_baseline_created: report.section_baseline_created,
      expandable_sections_detected: report.expandable_sections_detected,
      expandable_sections_extracted: report.expandable_sections_extracted,
      expandable_sections_changed: report.expandable_sections_changed,
      expandable_sections_added: report.expandable_sections_added,
      expandable_sections_removed: report.expandable_sections_removed,
      expandable_section_identity_migrations: report.expandable_section_identity_migrations,
      section_addition_presence_conflicts: report.section_addition_presence_conflicts,
      section_removal_presence_conflicts: report.section_removal_presence_conflicts,
      section_change_candidates_blocked_unconfirmed: report.section_change_candidates_blocked_unconfirmed,
      section_change_candidates_enqueued: report.section_change_candidates_enqueued,
      section_change_candidates_overflow: report.section_change_candidates_overflow,
      section_evidence_screenshots_taken: report.section_evidence_screenshots_taken,
      section_text_included_in_main_hash: report.section_text_included_in_main_hash,
      section_text_included_in_baseline_facts: report.section_text_included_in_baseline_facts,
      expanded_controls: report.expanded_controls,
      expansion_screenshots_taken: report.expansion_screenshots_taken,
      expansion_screenshots_pruned: report.expansion_screenshots_pruned,
      r2_uploads_skipped_unchanged: report.r2_uploads_skipped_unchanged,
      r2_uploads_skipped_noise: report.r2_uploads_skipped_noise,
      main_content_hash_changed: report.main_content_hash_changed,
      chrome_only_hash_changed: report.chrome_only_hash_changed,
      discovered_pdf_candidates: report.discovered_pdf_candidates,
      discovered_pdf_sources: report.discovered_pdf_sources,
      discovered_html_candidates: report.discovered_html_candidates,
      discovered_html_sources: report.discovered_html_sources,
      discovery_mode: report.discovery_mode,
      discovery_candidates: report.discovery_candidates,
      discovery_rejected_by_quality: report.discovery_rejected_by_quality,
      discovery_rejected_by_identity: report.discovery_rejected_by_identity,
      discovery_skipped_existing: report.discovery_skipped_existing,
      discovery_inserted_pending: report.discovery_inserted_pending,
      discovery_inserted_open: report.discovery_inserted_open,
      promoted: report.promoted,
      r2_uploaded: report.r2_uploaded,
      r2_rotated: report.r2_rotated,
      r2_previous_snapshots_reset: report.r2_previous_snapshots_reset,
      r2_failed: report.r2_failed,
      r2_skipped_existing: report.r2_skipped_existing,
      r2_repaired_missing: report.r2_repaired_missing,
      r2_known_existing: report.r2_known_existing,
      r2_known_missing: report.r2_known_missing,
      r2_rehydrate_local_cache: report.r2_rehydrate_local_cache,
      r2_rehydrated_local: report.r2_rehydrated_local,
      r2_rehydrated_local_exact_geometry: report.r2_rehydrated_local_exact_geometry,
      r2_rehydrated_local_evidence_only: report.r2_rehydrated_local_evidence_only,
      r2_rehydrated_local_latest: report.r2_rehydrated_local_latest,
      r2_rehydrated_local_previous: report.r2_rehydrated_local_previous,
      r2_rehydration_refused: report.r2_rehydration_refused,
      r2_rehydration_failed: report.r2_rehydration_failed,
      r2_rehydration_reasons: report.r2_rehydration_reasons,
      localization_repair_synced: report.localization_repair_synced,
      localization_repair_baselined: report.localization_repair_baselined,
      localization_repair_skipped_changed: report.localization_repair_skipped_changed,
      localization_repair_skipped_missing_baseline: report.localization_repair_skipped_missing_baseline,
      localization_repair_skipped_pdf: report.localization_repair_skipped_pdf,
      baseline_facts_extracted: report.baseline_facts_extracted,
      baseline_facts_failed: report.baseline_facts_failed,
      baseline_facts_skipped: report.baseline_facts_skipped,
      baseline_facts_backfilled: report.baseline_facts_backfilled,
      visual_interpreted: report.visual_interpreted,
      visual_review_mode: report.visual_review_mode,
      visual_review_candidates_queued: report.visual_review_candidates_queued,
      visual_review_candidates_existing: report.visual_review_candidates_existing,
      visual_review_candidates_failed: report.visual_review_candidates_failed,
      visual_review_rejected_evidence_absorbed:
        report.visual_review_rejected_evidence_absorbed,
      visual_rejection_ledger_unavailable: report.visual_rejection_ledger_unavailable,
      awards_queued_for_reconciliation: report.awards_queued_for_reconciliation,
      award_reconciliation_queue_existing: report.award_reconciliation_queue_existing,
      award_reconciliation_queue_failed: report.award_reconciliation_queue_failed,
      published_updates: report.published_updates,
      publish_duplicates: report.publish_duplicates,
      publish_failed: report.publish_failed,
    },
    baseline_coverage: {
      start: report.baseline_coverage_start || null,
      progress: report.baseline_coverage_progress || null,
      finish: report.baseline_coverage_finish || null,
    },
    gemini_usage: report.gemini_usage,
    gemini_cli_usage: report.gemini_cli_usage,
    visual_pipeline: {
      capture: {
        checked: report.checked,
        baselined: report.baselined,
        unchanged: report.unchanged,
        failed: report.failed,
      },
      extraction: {
        enabled: extractBaselineInfo && ["gemini", "gemini-cli"].includes(aiProvider),
        provider: aiProvider,
        model: aiModel,
        backfill_enabled: backfillBaselineInfo,
        extracted: report.baseline_facts_extracted,
        failed: report.baseline_facts_failed,
        skipped: report.baseline_facts_skipped,
        backfilled: report.baseline_facts_backfilled,
      },
      comparison: {
        candidates: report.candidate_changes,
        text_only_candidates: report.text_only_candidates,
        deterministic_source_rejected: report.deterministic_source_rejected,
        deterministic_noise_rejected: report.deterministic_noise_rejected,
        text_only_candidate_enqueued: report.text_only_candidate_enqueued,
        text_only_noise_rejected: report.text_only_noise_rejected,
        text_only_published_or_queued: report.text_only_published_or_queued,
        visual_only_candidate_enqueued: report.visual_only_candidate_enqueued,
        interpreted: report.visual_interpreted,
        true_changes: report.ai_true_changes,
        rejected: report.ai_rejected,
        review: report.review,
      },
      publishing: {
        promoted: report.promoted,
        published_updates: report.published_updates,
        duplicate_updates: report.publish_duplicates,
        failed: report.publish_failed,
      },
      discovery: {
        enabled: report.discovery_mode,
        pdf_enabled: report.options.discover_pdf_subpages,
        html_enabled: report.options.discover_html_subpages,
        candidates: report.discovery_candidates,
        rejected_by_quality: report.discovery_rejected_by_quality,
        rejected_by_identity: report.discovery_rejected_by_identity,
        skipped_existing: report.discovery_skipped_existing,
        inserted_pending: report.discovery_inserted_pending,
        inserted_open: report.discovery_inserted_open,
        rejection_reasons: report.discovery_rejection_reasons,
        cap_hits_by_award: report.discovery_cap_hits_by_award,
        cap_hits_by_domain: report.discovery_cap_hits_by_domain,
        cap_hits_by_source: report.discovery_cap_hits_by_source,
      },
    },
    paths: {
      saved_changes: report.saved_change_paths.slice(0, 20),
      review: report.review_paths.slice(0, 20),
      rejected: report.rejected_paths.slice(0, 20),
    },
    run_health: structuredReport.run_health,
    failure_groups: structuredReport.failure_groups,
    repair_plan: structuredReport.repair_plan,
    errors: report.errors.slice(0, 20),
  };
}

function visualWorkerName() {
  const suffix = shardCount > 1 ? `-shard-${shardIndex + 1}-of-${shardCount}` : "";
  if (localizationRepair) return `local-visual-snapshot-worker-localization-repair${suffix}`;
  if (r2BackfillBaselines) return `local-visual-snapshot-worker-r2-backfill${suffix}`;
  if (completeMissingBaselines) return `local-visual-snapshot-worker-baseline-completion${suffix}`;
  if (baselineRefresh) return `local-visual-snapshot-worker-baseline-refresh${suffix}`;
  return `local-visual-snapshot-worker${suffix}`;
}

async function recordBrokenSourceFailure(source, message) {
  mkdirSync(brokenSourcesDir, { recursive: true });

  const parsed = parseHttpStatusFromMessage(message);
  const probe = parsed.status_code ? null : await probeHttpStatus(source.url).catch((error) => ({
    status_code: null,
    status_text: null,
    final_url: null,
    content_type: null,
    content_length: null,
    probe_error: errorMessage(error),
  }));
  const statusCode = parsed.status_code || probe?.status_code || null;
  const now = new Date().toISOString();
  const key = `${source.id}|${source.url}`;

  const releaseLock = await acquireFileLock(join(brokenSourcesDir, "broken-sources.lock"));
  try {
    const current = readJsonIfExists(brokenSourcesCurrentPath) || {};
    const previous = current[key] || null;
    const record = {
      key,
      first_seen_at: previous?.first_seen_at || now,
      last_seen_at: now,
      seen_count: (previous?.seen_count || 0) + 1,
      status_code: statusCode,
      status_text: parsed.status_text || probe?.status_text || null,
      failure_type: failureTypeFromMessage(message, statusCode),
      source_id: source.id,
      shared_award_id: source.shared_award_id,
      award_name: source.shared_awards?.name || null,
      source_title: source.title || null,
      source_url: source.url,
      final_url: probe?.final_url || null,
      page_type: source.page_type || null,
      error_message: message,
      content_type: probe?.content_type || null,
      content_length: probe?.content_length || null,
      probe_error: probe?.probe_error || null,
    };

    current[key] = record;
    if (knownBrokenSourceIds) {
      knownBrokenSourceIds.add(source.id);
    }
    writeFileSync(brokenSourcesCurrentPath, JSON.stringify(current, null, 2), "utf8");
    appendFileSync(brokenSourcesJsonlPath, `${JSON.stringify(record)}\n`, "utf8");
    writeBrokenSourcesCsv(Object.values(current));
  } finally {
    releaseLock();
  }
  console.log(`BROKEN_SOURCE recorded status=${statusCode || "unknown"} ${sourceLabel(source)}`);
}

function parseHttpStatusFromMessage(message) {
  const match = String(message || "").match(/\bHTTP\s+(\d{3})(?:\s+([^\n\r]+))?/i);
  return {
    status_code: match ? Number(match[1]) : null,
    status_text: match?.[2] ? match[2].trim() : null,
  };
}

function failureTypeFromMessage(message, statusCode) {
  const lower = String(message || "").toLowerCase();
  if (statusCode === 404 || lower.includes("http 404")) return "http_404";
  if (lower.includes("security_challenge") || lower.includes("robot challenge")) return "security_challenge";
  if (lower.includes("soft_404") || lower.includes("page not found")) return "soft_404";
  if (lower.includes("access_blocked") || lower.includes("access denied")) return "access_blocked";
  if (lower.includes("err_http_response_code_failure")) return "http_response_failure";
  if (lower.includes("timeout")) return "timeout";
  if (lower.includes("pdf download failed")) return "pdf_download_failed";
  if (lower.includes("net::err_name_not_resolved")) return "dns_error";
  if (lower.includes("net::err_connection")) return "connection_error";
  if (statusCode && statusCode >= 400) return `http_${statusCode}`;
  return "capture_failure";
}

async function probeHttpStatus(url) {
  const first = await fetchProbe(url, "HEAD");
  if (first.status_code && first.status_code !== 405) return first;
  return fetchProbe(url, "GET");
}

async function fetchProbe(url, method) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.min(15_000, sourceTimeoutMs));
  const headers = {
    "User-Agent": crawlerUserAgent,
    Accept: "text/html,application/pdf,application/octet-stream,*/*;q=0.5",
  };
  if (method === "GET") {
    headers.Range = "bytes=0-0";
  }

  try {
    const response = await fetch(url, {
      method,
      redirect: "follow",
      signal: controller.signal,
      headers,
    });

    return {
      status_code: response.status || null,
      status_text: response.statusText || null,
      final_url: response.url || url,
      content_type: response.headers.get("content-type") || null,
      content_length: numericHeader(response.headers.get("content-length")),
      probe_error: null,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function numericHeader(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function writeBrokenSourcesCsv(records) {
  const headers = [
    "first_seen_at",
    "last_seen_at",
    "seen_count",
    "status_code",
    "status_text",
    "failure_type",
    "award_name",
    "source_title",
    "source_url",
    "final_url",
    "page_type",
    "source_id",
    "shared_award_id",
    "error_message",
    "content_type",
    "content_length",
    "probe_error",
  ];
  const rows = records
    .slice()
    .sort((left, right) => String(right.last_seen_at).localeCompare(String(left.last_seen_at)))
    .map((record) => headers.map((header) => csvEscape(record[header])));
  const csv = [headers.map(csvEscape), ...rows].map((row) => row.join(",")).join("\n");
  writeFileSync(brokenSourcesCsvPath, `${csv}\n`, "utf8");
}

function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

function isMissingMetadataColumnError(error) {
  const message = `${error?.message || ""} ${error?.details || ""} ${error?.hint || ""}`.toLowerCase();
  return (
    error?.code === "PGRST204" ||
    error?.code === "42703" ||
    (message.includes("metadata") && (message.includes("column") || message.includes("schema cache")))
  );
}

async function launchBrowser() {
  const executablePath = findInstalledBrowserExecutable();
  const launchOptions = {
    headless: true,
    timeout: timeoutMs,
    args: [
      "--headless=new",
      "--no-startup-window",
      "--disable-gpu",
      "--start-minimized",
      "--window-position=-32000,-32000",
      `--window-size=${viewportWidth},${viewportHeight}`,
      "--disable-extensions",
      "--disable-component-extensions-with-background-pages",
      "--disable-background-networking",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-features=Translate,AutofillServerCommunication,MediaRouter",
      "--mute-audio",
    ],
  };

  if (executablePath) {
    launchOptions.executablePath = executablePath;
  }

  try {
    const browser = await chromium.launch(launchOptions);
    const version = browser.version();
    return {
      browser,
      browserMeta: {
        automation: "playwright-core",
        executable_path: executablePath || "playwright-default",
        browser_version: version,
        user_agent: crawlerUserAgent,
        viewport_width: viewportWidth,
        viewport_height: viewportHeight,
      },
    };
  } catch (error) {
    throw new Error(
      `Could not launch Chrome or Edge for visual snapshots. Install Chrome/Edge or set BROWSER_EXECUTABLE_PATH/CHROME_PATH/EDGE_PATH. ${errorMessage(error)}`,
    );
  }
}

async function createBrowserContext(browser) {
  const context = await browser.newContext({
    viewport: { width: viewportWidth, height: viewportHeight },
    userAgent: crawlerUserAgent,
    locale: "en-US",
    colorScheme: "light",
    ignoreHTTPSErrors: true,
    deviceScaleFactor: 1,
    extraHTTPHeaders: {
      "Accept-Language": "en-US,en;q=0.9",
      "Upgrade-Insecure-Requests": "1",
    },
  });

  await context.addInitScript({
    content: `
      (() => {
        const style = document.createElement("style");
        style.setAttribute("data-awardping-stable-capture", "true");
        style.textContent = ${JSON.stringify(stableCaptureCss)};
        const attach = () => (document.head || document.documentElement).appendChild(style.cloneNode(true));
        if (document.documentElement) attach();
        else document.addEventListener("DOMContentLoaded", attach, { once: true });
      })();
    `,
  });

  await context.route("**/*", async (route) => {
    const url = route.request().url().toLowerCase();
    if (/(doubleclick|googlesyndication|google-analytics|googletagmanager|adservice|adsystem|facebook\.net|hotjar|intercom|drift|crisp|optimizely|segment\.io)/i.test(url)) {
      await route.abort().catch(() => null);
      return;
    }
    await route.continue().catch(() => null);
  });

  return context;
}

function findInstalledBrowserExecutable() {
  const candidates = [
    args["browser-executable"],
    env.BROWSER_EXECUTABLE_PATH,
    env.CHROME_PATH,
    env.EDGE_PATH,
    ...findPlaywrightBrowserExecutables(),
    env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe") : null,
    env.PROGRAMFILES ? join(env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe") : null,
    env["ProgramFiles(x86)"] ? join(env["ProgramFiles(x86)"], "Google", "Chrome", "Application", "chrome.exe") : null,
    env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "Microsoft", "Edge", "Application", "msedge.exe") : null,
    env.PROGRAMFILES ? join(env.PROGRAMFILES, "Microsoft", "Edge", "Application", "msedge.exe") : null,
    env["ProgramFiles(x86)"] ? join(env["ProgramFiles(x86)"], "Microsoft", "Edge", "Application", "msedge.exe") : null,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/usr/bin/microsoft-edge",
  ].filter(Boolean);

  return candidates.find((candidate) => existsSync(candidate)) || null;
}

function findPlaywrightBrowserExecutables() {
  const roots = [
    env.PLAYWRIGHT_BROWSERS_PATH && env.PLAYWRIGHT_BROWSERS_PATH !== "0"
      ? resolve(env.PLAYWRIGHT_BROWSERS_PATH)
      : null,
    env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "ms-playwright") : null,
  ].filter(Boolean);

  const browserExecutables = [];
  for (const rootPath of roots) {
    if (!existsSync(rootPath)) continue;
    let entries = [];
    try {
      entries = readdirSync(rootPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const basePath = join(rootPath, entry.name);
      browserExecutables.push(
        join(basePath, "chrome-headless-shell-win64", "chrome-headless-shell.exe"),
        join(basePath, "chrome-win64", "chrome.exe"),
        join(basePath, "chrome-win", "headless_shell.exe"),
        join(basePath, "chrome-win", "chrome.exe"),
        join(basePath, "chrome-linux", "chrome"),
        join(basePath, "chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"),
      );
    }
  }
  return browserExecutables;
}

async function waitForDomain(value) {
  let hostname = "unknown";
  try {
    hostname = new URL(value).hostname.toLowerCase();
  } catch {
    return;
  }

  const previousQueue = hostWaitQueues.get(hostname) || Promise.resolve();
  let nextQueue;
  nextQueue = previousQueue
    .catch(() => null)
    .then(async () => {
      const previous = hostLastFetchAt.get(hostname) || 0;
      const elapsed = Date.now() - previous;
      if (elapsed < domainDelayMs) {
        await sleep(domainDelayMs - elapsed);
      }
      hostLastFetchAt.set(hostname, Date.now());
    })
    .finally(() => {
      if (hostWaitQueues.get(hostname) === nextQueue) {
        hostWaitQueues.delete(hostname);
      }
    });

  hostWaitQueues.set(hostname, nextQueue);
  await nextQueue;
}

function ensureArchiveDirectories() {
  for (const dir of [
    archiveRoot,
    join(archiveRoot, "sources"),
    join(archiveRoot, "changes"),
    join(archiveRoot, "review"),
    join(archiveRoot, "rejected"),
    join(archiveRoot, "usage"),
    join(root, "reports"),
  ]) {
    mkdirSync(dir, { recursive: true });
  }
}

function recordGeminiUsage(report, source, capture, aiReview, kind = "change_interpretation") {
  const usage = aiReview.usage || normalizeGeminiUsage(null);
  const actualPricingMode = normalizeGeminiPricingMode(geminiApiPricingMode, {
    endpoint: "generateContent",
  });
  const estimatedCostUsd = estimateGeminiCostUsd(aiReview.model || aiModel, usage, actualPricingMode);
  report.gemini_usage.calls += 1;
  report.gemini_usage.prompt_tokens += usage.prompt_tokens;
  report.gemini_usage.candidates_tokens += usage.candidates_tokens;
  report.gemini_usage.total_tokens += usage.total_tokens;
  report.gemini_usage.thoughts_tokens += usage.thoughts_tokens;
  report.gemini_usage.cached_content_tokens += usage.cached_content_tokens;
  report.gemini_usage.estimated_cost_usd = roundUsd(
    (report.gemini_usage.estimated_cost_usd || 0) + estimatedCostUsd,
  );
  report.gemini_usage.status = "ready";
  report.gemini_usage.last_success_at = new Date().toISOString();

  const usedAt = new Date().toISOString();
  const record = {
    used_at: usedAt,
    date: usedAt.slice(0, 10),
    month: usedAt.slice(0, 7),
    provider: "gemini",
    kind,
    model: aiReview.model,
    source_id: source.id,
    award_name: source.shared_awards?.name || null,
    source_title: source.title || null,
    source_url: source.url,
    capture_path: toArchiveRelative(capture.dir),
    usage,
    estimated_cost_usd: estimatedCostUsd,
    pricing_mode: actualPricingMode,
    configured_pricing_mode: geminiApiPricingMode,
  };
  const summary = appendGeminiUsageRecord(record);
  const today = summary.daily.find((day) => day.date === record.date);
  console.log(
    [
      "GEMINI_USAGE",
      `kind=${kind}`,
      `call_tokens=${usage.total_tokens}`,
      `call_estimated_usd=${estimatedCostUsd.toFixed(6)}`,
      `today_tokens=${today?.total_tokens || 0}`,
      `today_estimated_usd=${(today?.estimated_cost_usd || 0).toFixed(6)}`,
      `month_tokens=${summary.month_total.total_tokens}`,
      `month_estimated_usd=${summary.month_total.estimated_cost_usd.toFixed(6)}`,
      "account_spend_source=google_ai_studio_spend",
    ].join(" "),
  );
}

function recordGeminiApiError(report, kind, httpStatus, body, message) {
  if (!report?.gemini_usage) return;
  const parsed = parseJsonObject(body) || {};
  const error = jsonObjectOrEmpty(parsed.error);
  const providerMessage = cleanNullable(error.message) || cleanNullable(message) || "Gemini API request failed.";
  const blocked = isGeminiBillingBlocked(httpStatus, providerMessage);
  if (blocked) {
    markGeminiBillingBlocked({
      archiveRoot,
      kind,
      model: aiModel,
      httpStatus,
      providerStatus: cleanNullable(error.status),
      message: providerMessage,
    });
    report.billing_blocked = true;
    report.blocking_reason = truncate(providerMessage, 1000);
    report.stop_reason = "gemini_billing_or_quota_blocked";
  }
  report.gemini_usage.status = blocked ? "blocked" : "error";
  report.gemini_usage.last_error = {
    kind,
    model: aiModel,
    http_status: httpStatus,
    provider_status: cleanNullable(error.status),
    message: truncate(providerMessage, 500),
    blocked,
    checked_at: new Date().toISOString(),
  };
}

async function generateGeminiContentJson({
  model,
  requestBody,
  requestTimeoutMs,
  report,
  kind,
}) {
  void model;
  void requestBody;
  void requestTimeoutMs;
  void report;
  void kind;
  throw new Error("Synchronous Gemini generateContent is disabled. Use Gemini Batch mode with gemini-2.5-flash-lite.");
}

function geminiHttpErrorMessage(httpStatus, body) {
  const parsed = parseJsonObject(body) || {};
  const providerMessage = cleanNullable(jsonObjectOrEmpty(parsed.error).message);
  const message = providerMessage || truncate(body, 800) || "Gemini API request failed.";
  return `Gemini HTTP ${httpStatus}: ${truncate(message, 800)}`;
}

function isGeminiBillingBlocked(httpStatus, message) {
  const clean = String(message || "").toLowerCase();
  return httpStatus === 429 && /\b(prepay|prepayment|credits?\s+are\s+depleted|billing|resource_exhausted)\b/.test(clean);
}

function isRetryableGeminiApiFailure(httpStatus, body) {
  const parsed = parseJsonObject(body) || {};
  const message = cleanNullable(jsonObjectOrEmpty(parsed.error).message) || body;
  if (isGeminiBillingBlocked(httpStatus, message)) return false;
  return httpStatus === 408 || httpStatus === 429 || httpStatus >= 500;
}

function isRetryableGeminiNetworkFailure(error) {
  const message = errorMessage(error).toLowerCase();
  return /\b(timeout|temporar|econnreset|socket|network|fetch failed|tls|ssl|unavailable)\b/.test(message);
}

function recordAiReviewUsage(report, source, capture, aiReview) {
  if (aiReview.provider === "gemini" && aiReview.usage) {
    recordGeminiUsage(report, source, capture, aiReview, "change_interpretation");
    return;
  }
  if (aiReview.provider === "gemini-cli" && aiReview.usage) {
    recordGeminiCliUsage(report, source, capture, aiReview, "change_interpretation");
  }
}

function recordGeminiCliUsage(report, source, capture, analysis, kind) {
  const usage = analysis.usage || {};
  report.gemini_cli_usage.calls += 1;
  if (usage.success !== false) report.gemini_cli_usage.successes += 1;
  else report.gemini_cli_usage.failures += 1;
  report.gemini_cli_usage.image_files += nonNegativeInt(usage.image_files, 0);
  report.gemini_cli_usage.view_file_calls += nonNegativeInt(usage.view_file_calls, 0);
  report.gemini_cli_usage.stream_calls += nonNegativeInt(usage.stream_calls, 0);
  report.gemini_cli_usage.elapsed_ms += nonNegativeInt(usage.elapsed_ms, 0);

  const month = new Date().toISOString().slice(0, 7);
  const monthPath = join(archiveRoot, "usage", `gemini-cli-${month}.jsonl`);
  mkdirSync(dirname(monthPath), { recursive: true });
  appendFileSync(
    monthPath,
    `${JSON.stringify({
      provider: "gemini-cli",
      kind,
      model: geminiCliModel,
      source_id: source?.id || null,
      shared_award_id: source?.shared_award_id || null,
      source_url: source?.url || null,
      capture_kind: capture?.kind || null,
      capture_hash: capture ? visualHashForCapture(capture) : null,
      usage,
      recorded_at: new Date().toISOString(),
      note: "CLI usage does not include account quota or token totals.",
    })}\n`,
    "utf8",
  );
}

function geminiCliCallAvailable(report) {
  if (aiProvider !== "gemini-cli") return false;
  if (!geminiCliMaxCalls) return true;
  return report.gemini_cli_usage.calls < geminiCliMaxCalls;
}

function ensureGeminiCliCallAvailable(report, kind) {
  if (geminiCliCallAvailable(report)) return;
  throw new Error(
    `Gemini CLI call cap reached before ${kind}. Increase AWARDPING_GEMINI_CLI_MAX_CALLS or set it to 0 for no cap.`,
  );
}

function geminiApiCallAvailable(report) {
  if (aiProvider !== "gemini") return false;
  if (report.billing_blocked) return false;
  if (geminiApiMaxCalls && report.gemini_usage.calls >= geminiApiMaxCalls) return false;
  const guard = geminiSpendGuardStatus({
    archiveRoot,
    dailyCostCapUsd: geminiApiDailyCostCapUsd,
  });
  if (!guard.allowed) return false;
  if (
    geminiApiDailyCostCapUsd > 0 &&
    nonNegativeNumber(report.gemini_usage.estimated_cost_usd, 0) >= geminiApiDailyCostCapUsd
  ) {
    return false;
  }
  return true;
}

function ensureGeminiApiCallAvailable(report, kind) {
  if (geminiApiCallAvailable(report)) return;
  const calls = report.gemini_usage.calls || 0;
  const cost = nonNegativeNumber(report.gemini_usage.estimated_cost_usd, 0);
  const guard = geminiSpendGuardStatus({
    archiveRoot,
    dailyCostCapUsd: geminiApiDailyCostCapUsd,
  });
  if (guard.blocked) {
    report.billing_blocked = true;
    report.blocking_reason = guard.block?.message || guard.block?.note || "Gemini billing or quota is blocked.";
    report.stop_reason = "gemini_billing_or_quota_blocked";
  }
  const shared = guard.blocked
    ? ` billing_blocked=${guard.block?.path || "true"}`
    : guard.capReached
      ? ` shared_daily_estimated_usd=${guard.today.estimated_cost_usd.toFixed(4)}/${guard.cap}`
      : "";
  throw new Error(
    `Gemini API cap reached before ${kind}. calls=${calls}/${geminiApiMaxCalls || "unlimited"} estimated_usd=${cost.toFixed(4)}/${geminiApiDailyCostCapUsd || "unlimited"}.${shared}`,
  );
}

function attachBaselineFactsToCapture(capture, value, metadata = {}) {
  const facts = normalizeBaselineFacts(value);
  capture.baseline_facts = facts;
  capture.baseline_facts_metadata = {
    status: "succeeded",
    reason: metadata.reason || null,
    provider: metadata.provider || aiProvider,
    model: metadata.model || aiModel,
    analysis_path: metadata.analysis_path || null,
    prompt_path: metadata.prompt_path || null,
    extracted_at: new Date().toISOString(),
    snapshot_hash: visualHashForCapture(capture),
  };
}

function normalizeBaselineFacts(value) {
  const parsed = jsonObjectOrEmpty(value);
  return {
    status: cleanSlug(parsed.status) || "succeeded",
    display_title: cleanNullable(parsed.display_title || parsed.page_title || parsed.title),
    page_description: cleanNullable(parsed.page_description || parsed.short_description || parsed.description),
    page_category: cleanNullable(parsed.page_category || parsed.category),
    award_name: cleanNullable(parsed.award_name),
    award_name_seen: booleanOrNull(parsed.award_name_seen ?? parsed.awardNameSeen),
    page_purpose: cleanNullable(parsed.page_purpose),
    award_relevance: normalizeAwardRelevance(parsed.award_relevance || parsed.relevance),
    cycle_relevance: normalizeCycleRelevance(
      parsed.cycle_relevance || parsed.cycle_status || parsed.application_cycle_relevance,
    ),
    cycle_relevance_reason: cleanNullable(parsed.cycle_relevance_reason || parsed.cycle_reason),
    application_cycle: cleanNullable(parsed.application_cycle || parsed.cycle || parsed.application_year),
    deadline: cleanNullable(parsed.deadline || parsed.deadline_date),
    opening_date: cleanNullable(parsed.opening_date || parsed.opens_at || parsed.application_opens),
    award_amounts: stringArray(parsed.award_amounts || parsed.amounts || parsed.funding).slice(0, 12),
    eligibility: stringArray(parsed.eligibility).slice(0, 20),
    requirements: stringArray(parsed.requirements).slice(0, 24),
    application_materials: stringArray(parsed.application_materials || parsed.materials).slice(0, 20),
    how_to_apply: stringArray(parsed.how_to_apply || parsed.application_instructions).slice(0, 20),
    important_dates: stringArray(parsed.important_dates || parsed.dates).slice(0, 16),
    documents: stringArray(parsed.documents || parsed.pdfs || parsed.pdf_links).slice(0, 20),
    contacts: stringArray(parsed.contacts || parsed.contact_info).slice(0, 12),
    notes: stringArray(parsed.notes).slice(0, 12),
    sections: sectionArray(parsed.sections || parsed.page_sections || parsed.outline).slice(0, 12),
    confidence: normalizeConfidence(parsed.confidence) || "low",
    evidence_quotes: stringArray(parsed.evidence_quotes || parsed.evidence || parsed.quotes).slice(0, 5),
    quality_flags: stringArray(parsed.quality_flags).map(cleanSlug).filter(Boolean).slice(0, 20),
    rejection_reason: cleanNullable(parsed.rejection_reason || parsed.noise_reason),
  };
}

function appendGeminiUsageRecord(record) {
  const usageDir = join(archiveRoot, "usage");
  mkdirSync(usageDir, { recursive: true });
  const monthPath = join(usageDir, `gemini-usage-${record.month}.jsonl`);
  appendFileSync(monthPath, `${JSON.stringify(record)}\n`, "utf8");

  const summary = summarizeGeminiUsageMonth(monthPath, record.month);
  const summaryPath = join(usageDir, `gemini-usage-${record.month}-summary.json`);
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2), "utf8");
  writeFileSync(join(usageDir, "gemini-usage-current.json"), JSON.stringify(summary, null, 2), "utf8");
  return summary;
}

function summarizeGeminiUsageMonth(monthPath, month) {
  const daily = new Map();
  const monthTotal = emptyGeminiUsageTotal();

  if (existsSync(monthPath)) {
    for (const line of readFileSync(monthPath, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      let record = null;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (record.provider !== "gemini" || record.month !== month) continue;
      const usage = normalizeGeminiUsage(record.usage);
      const date = record.date || String(record.used_at || "").slice(0, 10) || "unknown";
      if (!daily.has(date)) daily.set(date, emptyGeminiUsageTotal());
      addGeminiUsage(daily.get(date), usage);
      daily.get(date).estimated_cost_usd = roundUsd(
        daily.get(date).estimated_cost_usd + nonNegativeNumber(record.estimated_cost_usd, 0),
      );
      addGeminiUsage(monthTotal, usage);
      monthTotal.estimated_cost_usd = roundUsd(
        monthTotal.estimated_cost_usd + nonNegativeNumber(record.estimated_cost_usd, 0),
      );
    }
  }

  const dailyRows = [...daily.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, total]) => ({ date, ...total }));

  return {
    provider: "gemini",
    month,
    updated_at: new Date().toISOString(),
    account_spend_source: "Google AI Studio Spend page",
    note: "This file tracks AwardPing Gemini API calls and tokens. Exact dollar spend/cap usage is shown in Google AI Studio and may lag by up to 24 hours.",
    month_total: monthTotal,
    daily: dailyRows,
    raw_records_path: toArchiveRelative(monthPath),
  };
}

function emptyGeminiUsageTotal() {
  return {
    calls: 0,
    prompt_tokens: 0,
    candidates_tokens: 0,
    total_tokens: 0,
    thoughts_tokens: 0,
    cached_content_tokens: 0,
    estimated_cost_usd: 0,
  };
}

function addGeminiUsage(total, usage) {
  total.calls += 1;
  total.prompt_tokens += usage.prompt_tokens;
  total.candidates_tokens += usage.candidates_tokens;
  total.total_tokens += usage.total_tokens;
  total.thoughts_tokens += usage.thoughts_tokens;
  total.cached_content_tokens += usage.cached_content_tokens;
}

function geminiInlineImageParts(filePaths) {
  return filePaths
    .filter((filePath) => filePath && existsSync(filePath))
    .map((filePath) => ({
      inlineData: {
        mimeType: imageMimeType(filePath),
        data: readFileSync(filePath).toString("base64"),
      },
    }));
}

function openAiImageContent(filePaths) {
  return filePaths
    .filter((filePath) => filePath && existsSync(filePath))
    .map((filePath) => ({
      type: "input_image",
      image_url: `data:${imageMimeType(filePath)};base64,${readFileSync(filePath).toString("base64")}`,
    }));
}

function imageMimeType(filePath) {
  if (/\.png$/i.test(filePath)) return "image/png";
  if (/\.webp$/i.test(filePath)) return "image/webp";
  return "image/jpeg";
}

function estimateGeminiCostUsd(model, usage, pricingMode = "standard") {
  return estimateGeminiCostUsdByMode(model, usage, pricingMode);
}

function roundUsd(value) {
  return Math.round(nonNegativeNumber(value, 0) * 1_000_000) / 1_000_000;
}

function baselinePathForSource(sourceId) {
  return join(archiveRoot, "sources", sourceId, "baseline.json");
}

function changeDirForCapture(capture, sourceId) {
  return join(archiveRoot, "changes", `${timestampForPath(capture.captured_at)}-${sourceId}`);
}

function reviewDirForCapture(capture, sourceId) {
  return join(archiveRoot, "review", `${timestampForPath(capture.captured_at)}-${sourceId}`);
}

function rejectedDirForCapture(capture, sourceId) {
  return join(archiveRoot, "rejected", `${timestampForPath(capture.captured_at)}-${sourceId}`);
}

function removeGeneratedCaptureDir(dir) {
  const resolvedDir = resolve(dir);
  if (!isPathInside(resolvedDir, archiveRoot)) {
    throw new Error(`Refusing to remove capture outside archive root: ${resolvedDir}`);
  }
  if (captureDirIsReferencedByCurrentBaseline(resolvedDir)) {
    console.log(`PRESERVE baseline_referenced_capture ${toArchiveRelative(resolvedDir)}`);
    return false;
  }
  rmSync(resolvedDir, { recursive: true, force: true });
  return true;
}

function captureDirIsReferencedByCurrentBaseline(captureDir) {
  const relativeDir = relative(archiveRoot, resolve(captureDir)).replace(/\\/g, "/");
  const match = relativeDir.match(/^sources\/([^/]+)\/captures\/[^/]+$/);
  if (!match) return false;
  const baseline = readJsonIfExists(baselinePathForSource(match[1]));
  const baselineCaptureDir = baseline?.capture?.dir;
  if (!baselineCaptureDir) return false;
  return (
    resolve(fromArchiveRelative(baselineCaptureDir)).toLowerCase() ===
    resolve(captureDir).toLowerCase()
  );
}

function pruneTransientExpansionStateScreenshots(capture, report = null) {
  if (!capture?.expansion_state_screenshots?.length) return 0;
  if (capture.persist_expansion_state_screenshots) return 0;

  let pruned = 0;
  for (const state of capture.expansion_state_screenshots) {
    let imagePruned = false;
    for (const filePath of [state?.page_path, state?.layout_path]) {
      if (!filePath || !existsSync(filePath)) continue;
      const resolvedPath = resolve(filePath);
      if (!isPathInside(resolvedPath, archiveRoot)) continue;
      rmSync(resolvedPath, { force: true });
      if (filePath === state?.page_path) imagePruned = true;
    }
    if (imagePruned) pruned += 1;
  }

  if (pruned > 0) {
    if (report) report.expansion_screenshots_pruned += pruned;
    capture.expansion_state_screenshots_pruned = pruned;
  }
  return pruned;
}

function isPathInside(candidate, parent) {
  const rel = relative(resolve(parent), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function sourceMetadata(source) {
  return {
    id: source.id,
    shared_award_id: source.shared_award_id,
    award_name: source.shared_awards?.name || null,
    title: source.title || null,
    display_title: source.display_title || null,
    page_description: source.page_description || null,
    page_metadata_generated_at: source.page_metadata_generated_at || null,
    page_metadata_model: source.page_metadata_model || null,
    url: source.url,
    page_type: source.page_type || null,
    last_checked_at: source.last_checked_at || null,
    next_check_at: source.next_check_at || null,
  };
}

function sourceLabel(source) {
  return `${source.shared_awards?.name || source.title || source.id} | ${source.title || source.page_type || "source"} | ${source.url}`;
}

function isPdfSource(source) {
  if (String(source.page_type || "").toLowerCase() === "pdf") return true;
  try {
    return new URL(source.url).pathname.toLowerCase().endsWith(".pdf");
  } catch {
    return false;
  }
}

function readJsonIfExists(path) {
  if (!path || !existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function toArchiveRelative(filePath) {
  return relative(archiveRoot, resolve(filePath)).replace(/\\/g, "/");
}

function fromArchiveRelative(value) {
  if (!value) return null;
  if (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\")) return value;
  return join(archiveRoot, value);
}

function normalizeVisibleText(value) {
  const lines = String(value || "")
    .replace(/\u0000/g, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .filter((line) => !isVolatileLine(line));

  const result = [];
  const seenRecent = new Set();
  for (const line of lines) {
    const key = line.toLowerCase();
    if (seenRecent.has(key) && !hasAwardRelevantTerms(line)) continue;
    result.push(line);
    seenRecent.add(key);
    if (seenRecent.size > 200) {
      const first = seenRecent.values().next().value;
      seenRecent.delete(first);
    }
  }

  return result.join("\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function isVolatileLine(line) {
  const clean = normalizeText(line);
  const lower = clean.toLowerCase();
  if (!clean) return true;
  if (hasAwardRelevantTerms(clean)) return false;
  if (/^(last updated|updated|modified|retrieved|accessed|current as of|as of)\s*:?\s*[\w,/: -]+$/i.test(clean)) return true;
  if (/^(today|yesterday|current date|local time)\s*:?\s*[\w,/: -]+$/i.test(clean)) return true;
  if (/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}$/i.test(clean)) return true;
  if (/^\d{1,2}:\d{2}(?::\d{2})?\s*(am|pm)?$/i.test(clean)) return true;
  if (/^\d+\s+(shares?|views?|likes?|comments?)$/i.test(clean)) return true;
  if (/^(slide|page)\s+\d+\s+(of|\/)\s+\d+$/i.test(clean)) return true;
  if (/\b(cookie|cookies|consent|gdpr|privacy preferences|accept all|reject all|manage preferences)\b/i.test(clean)) return true;
  if (/\b(facebook|instagram|linkedin|twitter|x\.com|youtube|share this|follow us|subscribe to our newsletter)\b/i.test(clean)) return true;
  if (/\b(skip to|toggle menu|open menu|close menu|search this site|breadcrumb|copyright|all rights reserved)\b/i.test(clean)) return true;
  if (lower.length <= 2) return true;
  return false;
}

function isVolatileOrBoilerplateFragment(value) {
  const clean = normalizeText(value);
  if (!clean) return true;
  if (hasAwardRelevantTerms(clean)) return false;
  return (
    isVolatileLine(clean) ||
    /\b(menu|navigation|footer|header|breadcrumb|subscribe|newsletter|social|share|cookie|privacy|advertisement|sponsor|carousel|slide|read more|learn more)\b/i.test(
      clean,
    ) ||
    looksLikeRecipientNewsOrPressText(clean)
  );
}

function hasAwardRelevantTerms(value) {
  return /\b(deadline|due date|applications?\s+(?:open|close|due)|opens?|closes?|apply|application|eligible|eligibility|requirements?|recommendations?|nomination|nominations?|transcripts?|essays?|interviews?|funding|stipend|tuition|award amount|amount awarded|guidelines?|instructions?|materials?|selection|submit|submission|citizenship|gpa|pdf|document|portal)\b/i.test(
    String(value || ""),
  );
}

function isProtectedAwardPageType(value) {
  return new Set(["homepage", "deadline", "application", "eligibility", "requirements", "faq"]).has(
    String(value || "").toLowerCase(),
  );
}

function sentenceCandidates(text) {
  return splitChangeSentences(normalizeText(text))
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 20 && sentence.length <= 620);
}

function splitChangeSentences(text) {
  return protectSentenceAbbreviations(text)
    .split(/(?<=[.!?])\s+|(?<=:)\s+(?=[A-Z0-9])/)
    .map(restoreSentenceAbbreviations);
}

function protectSentenceAbbreviations(value) {
  return String(value || "")
    .replace(/\bM\.\s*D\./g, `M${sentenceDotPlaceholder}D${sentenceDotPlaceholder}`)
    .replace(/\bPh\.\s*D\./gi, `Ph${sentenceDotPlaceholder}D${sentenceDotPlaceholder}`)
    .replace(/\bU\.\s*S\./g, `U${sentenceDotPlaceholder}S${sentenceDotPlaceholder}`)
    .replace(/\bU\.\s*K\./g, `U${sentenceDotPlaceholder}K${sentenceDotPlaceholder}`)
    .replace(/\bi\.\s*e\./gi, `i${sentenceDotPlaceholder}e${sentenceDotPlaceholder}`)
    .replace(/\be\.\s*g\./gi, `e${sentenceDotPlaceholder}g${sentenceDotPlaceholder}`);
}

function restoreSentenceAbbreviations(value) {
  return value.replaceAll(sentenceDotPlaceholder, ".");
}

function sentenceKey(sentence) {
  return sentence.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function isUsefulChangedSentence(sentence) {
  const clean = normalizeText(sentence);
  if (isVolatileOrBoilerplateFragment(clean)) return false;
  if (looksLikeSourceAccessError(clean)) return true;
  return clean.length >= 20;
}

function contextualDatePhrases(text) {
  return unique(sentenceCandidates(text).filter(isAwardDateContext).flatMap(datePhrases));
}

function datePhrases(text) {
  const month =
    "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
  const patterns = [
    new RegExp(`\\b(?:${month})\\.?\\s+\\d{1,2}(?:,\\s*\\d{4})?\\b`, "gi"),
    /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g,
    /\b\d{4}-\d{2}-\d{2}\b/g,
  ];
  return patterns.flatMap((pattern) => [...text.matchAll(pattern)].map((match) => normalizeText(match[0])));
}

function isAwardDateContext(sentence) {
  const lower = String(sentence || "").toLowerCase();
  if (looksLikeRecipientNewsOrPressText(lower)) return false;
  return /\b(deadline|due|application|apply|opens?|closes?|timeline|round|eligible|eligibility|interview|selection|notification|acceptance|nomination|submit|submission)\b/.test(
    lower,
  );
}

function contextualMoneyPhrases(text) {
  return unique(
    [...text.matchAll(/\$\s?\d[\d,]*(?:\.\d{2})?\b/g)]
      .filter((match) => hasFundingAmountContext(contextAroundMatch(text, match.index || 0)))
      .map((match) => normalizeText(match[0])),
  );
}

function contextAroundMatch(text, index) {
  return normalizeText(text.slice(Math.max(0, index - 180), index + 220));
}

function hasFundingAmountContext(value) {
  const lower = value.toLowerCase();
  if (/\b(cart|donate|donation|shop|store|subscribe|subscription|ticket|tickets|purchase|checkout|subtotal|merchandise|membership|sponsor|sponsorship)\b/.test(lower)) {
    return false;
  }
  return /\b(stipend|tuition|funding|funds?|grant|scholarships?|fellowships?|award amount|awards?:|amount awarded|prize|financial support|honorarium|living allowance|travel expenses?|research expenses?)\b/.test(
    lower,
  );
}

function inferSection(text) {
  const lower = String(text || "").toLowerCase();
  if (/\b(deadline|timeline|dates?)\b/.test(lower)) return "Dates and deadlines";
  if (/\b(eligible|eligibility|requirements?)\b/.test(lower)) return "Eligibility";
  if (/\b(apply|application|submit|submission)\b/.test(lower)) return "Application";
  if (/\b(recommendation|transcript|essay|materials?)\b/.test(lower)) return "Materials";
  if (/\b(funding|stipend|tuition|amount)\b/.test(lower)) return "Funding";
  if (/\b(pdf|document|guideline|instruction)\b/.test(lower)) return "Documents";
  return null;
}

function looksLikeRecipientNewsOrPressText(value) {
  return /\b(latest news|press release|news|blog|story|stories|recipient profile|past recipients?|received the .* award|receives the .* award|was awarded|has been awarded|photo by|getty images|staff|job posting|event calendar|upcoming events)\b/i.test(
    String(value || ""),
  );
}

function aiReviewLooksLikeProfileRosterChange(aiReview) {
  const result = aiReview?.result || {};
  const details =
    result.change_details && typeof result.change_details === "object" && !Array.isArray(result.change_details)
      ? result.change_details
      : {};
  const structuredDiff =
    details.structured_diff && typeof details.structured_diff === "object" && !Array.isArray(details.structured_diff)
      ? details.structured_diff
      : {};
  const sectionText = normalizeText([
    result.reader_summary,
    result.changed_section,
    details.reader_summary,
    details.section,
    structuredDiff.likely_section,
  ].join(" ")).toLowerCase();
  const evidenceText = normalizeText([
    result.before,
    result.after,
    details.before,
    details.after,
    ...stringArray(structuredDiff.added_text),
    ...stringArray(structuredDiff.removed_text),
  ].join(" ")).toLowerCase();
  const combined = `${sectionText} ${evidenceText}`;

  if (hasApplicantFacingAwardSignalText(evidenceText)) return false;

  const explicitProfileSection = /\b(featured fellows?|meet the fellows?|fellow highlights?|recipient profiles?|past recipients?|alumni profiles?)\b/.test(
    sectionText,
  );
  const rosterEvidence = /\b(fellowship awarded in \d{4} to support work towards|immigrant from|child of immigrants?|featured fellows?|recipient profile|past recipients?|alumni profile)\b/.test(
    combined,
  );
  const personProfileEvidence =
    /\b(ph\.?\s*d|m\.?\s*d|j\.?\s*d|m\.?\s*b\.?\s*a|assistant professor|founder|cto|ceo|university|college)\b/.test(
      evidenceText,
    ) && /\b(fellow|fellowship|recipient|alumni|immigrant)\b/.test(evidenceText);

  return (explicitProfileSection && (rosterEvidence || personProfileEvidence)) || (rosterEvidence && personProfileEvidence);
}

function aiReviewLooksLikeAnimatedCounterChange(aiReview) {
  const result = aiReview?.result || {};
  const details =
    result.change_details && typeof result.change_details === "object" && !Array.isArray(result.change_details)
      ? result.change_details
      : {};
  const structuredDiff =
    details.structured_diff && typeof details.structured_diff === "object" && !Array.isArray(details.structured_diff)
      ? details.structured_diff
      : {};

  return looksLikeAnimatedCounterChangeText(
    [
      result.reader_summary,
      result.advisor_impact,
      result.changed_section,
      result.before,
      result.after,
      details.reader_summary,
      details.advisor_impact,
      details.section,
      details.before,
      details.after,
      ...stringArray(structuredDiff.added_text),
      ...stringArray(structuredDiff.removed_text),
      ...stringArray(structuredDiff.date_changes),
      ...stringArray(structuredDiff.amount_changes),
    ].join(" "),
  );
}

function looksLikeAnimatedCounterChangeText(value) {
  const text = String(value || "");
  const normalized = normalizeText(text).toLowerCase();
  const numericValues = text.match(/\b\d{3,}(?:,\d{3})*\b/g) || [];

  if (numericValues.length < 2) return false;

  const hasCounterSignal =
    /\b(counter|count[- ]?up|animated|animation|stat(?:istic)?s?|metric|kpi|impact number|number of|total number)\b/.test(
      normalized,
    ) ||
    /\b(participating universities|universities and colleges|scholarships awarded|awarded globally|total investment|investment amount)\b/.test(
      normalized,
    );

  const hasCounterDrift =
    /\b(?:increased|decreased|changed|moved|went|dropped|rose|updated)\s+from\s+\d[\d,]*\s+to\s+\d[\d,]*/.test(
      normalized,
    ) || /\bfrom\s+\d[\d,]*\s+to\s+\d[\d,]*/.test(normalized);

  const hasApplicantFacingSignal = hasApplicantFacingAwardSignalText(normalized);

  return hasCounterSignal && hasCounterDrift && !hasApplicantFacingSignal;
}

function aiReviewLooksLikeDocumentMetadataOnlyChange(aiReview) {
  const result = aiReview?.result || {};
  const details =
    result.change_details && typeof result.change_details === "object" && !Array.isArray(result.change_details)
      ? result.change_details
      : {};
  const structuredDiff =
    details.structured_diff && typeof details.structured_diff === "object" && !Array.isArray(details.structured_diff)
      ? details.structured_diff
      : {};
  const summaryText = normalizeText([
    result.reader_summary,
    result.advisor_impact,
    result.changed_section,
    result.change_type,
    result.noise_reason,
    details.reader_summary,
    details.advisor_impact,
    details.section,
    details.change_type,
  ].join(" "));
  const evidence = [
    result.before,
    result.after,
    details.before,
    details.after,
    ...stringArray(structuredDiff.added_text),
    ...stringArray(structuredDiff.removed_text),
    ...stringArray(structuredDiff.date_changes),
    ...stringArray(structuredDiff.amount_changes),
  ].filter(Boolean);
  const evidenceText = normalizeText(evidence.join(" "));
  const combined = `${summaryText} ${evidenceText}`.toLowerCase();
  const pageType = cleanSlug(structuredDiff.page_type || details.source?.page_type || "");
  const documentContext =
    /^(pdf|document|application_pdf|materials?)$/.test(pageType) ||
    /\b(pdf|docx?|word version|document|file|form|download)\b/i.test(combined);

  if (!documentContext) return false;
  if (hasApplicantFacingAwardSignalText(evidenceText)) return false;
  if (stringArray(structuredDiff.date_changes).length || stringArray(structuredDiff.amount_changes).length) {
    return false;
  }

  const metadataOnlyLanguage =
    /\bspecific changes? (?:within|in) (?:the )?(?:pdf|document|file) (?:are|were) not detailed\b/.test(combined) ||
    /\bfile itself has changed\b/.test(combined) ||
    /\bfile size (?:has )?(?:increased|decreased|changed)\b/.test(combined) ||
    /\bpotential change in content or format\b/.test(combined) ||
    /\bdownload and review the updated\b/.test(combined) ||
    /\bupdated (?:pdf|document|file|form) for any changes\b/.test(combined);
  const genericDocumentUpdate =
    /\b(?:pdf|document|form|file)\b/.test(combined) &&
    /\b(?:has been updated|was updated|changed)\b/.test(combined) &&
    !hasApplicantFacingAwardSignalText(summaryText);
  const opaqueEvidence = evidence.length > 0 && evidence.every(isOpaqueDocumentEvidenceText);

  return (metadataOnlyLanguage || genericDocumentUpdate) && (opaqueEvidence || evidence.length === 0);
}

function aiReviewLooksLikeFundraisingOnlyChange(aiReview) {
  const result = aiReview?.result || {};
  const details =
    result.change_details && typeof result.change_details === "object" && !Array.isArray(result.change_details)
      ? result.change_details
      : {};
  const structuredDiff =
    details.structured_diff && typeof details.structured_diff === "object" && !Array.isArray(details.structured_diff)
      ? details.structured_diff
      : {};
  const text = normalizeText(
    [
      result.reader_summary,
      result.advisor_impact,
      result.changed_section,
      result.before,
      result.after,
      details.reader_summary,
      details.advisor_impact,
      details.section,
      details.before,
      details.after,
      ...stringArray(structuredDiff.added_text),
      ...stringArray(structuredDiff.removed_text),
      ...stringArray(structuredDiff.amount_changes),
    ].join(" "),
  ).toLowerCase();

  if (!/\b(donate|donation|donor|tribute|gift amount|one[- ]time donation|monthly gift|fundraising|cart|checkout|sponsor|sponsorship)\b/.test(text)) {
    return false;
  }

  const applicantText = normalizeText(
    [
      result.reader_summary,
      result.advisor_impact,
      result.before,
      result.after,
      details.reader_summary,
      details.advisor_impact,
      details.before,
      details.after,
      ...stringArray(structuredDiff.added_text),
      ...stringArray(structuredDiff.removed_text),
      ...stringArray(structuredDiff.amount_changes),
    ].join(" "),
  ).toLowerCase();

  return !hasApplicantFacingAwardSignalText(stripUnchangedApplicantReferences(applicantText));
}

function aiReviewLooksLikePublishedAuditNoise(aiReview, source) {
  const context = aiReviewAuditNoiseContext(aiReview, source);
  const { combined, sourceUrl, host, search, section, summary } = context;
  const strippedApplicantText = stripUnchangedApplicantReferences(context.evidenceText);
  const hasSubstantiveApplicantSignal = hasApplicantFacingAwardSignalText(strippedApplicantText);

  if (
    /\b(sitewide messages?|dismiss message|top of page notice|holiday notice|building getty|gallery access|page header|operating hours|hours[_ -]?change|today'?s hours|planned closings|open today|countdown timer|america'?s 250th|captcha|math problem|photo credit|view count|post id|application identifier|writer'?s id)\b/.test(
      combined,
    )
  ) {
    return {
      flag: "site_chrome_or_transient_notice",
      reason:
        "The apparent change is a sitewide notice, operating-hours widget, counter, CAPTCHA, view count, or other transient page chrome.",
    };
  }

  const looksLikeNavigationReorder =
    /\b(navigation menu|navigation\/links|navigation links?|left[- ]hand navigation|left sidebar|sidebar links?|menu items?|link order|page[_ -]?structure[_ -]?change|faq order|order of (?:the )?(?:main )?(?:navigation links|links|questions|menu items)|content[_ -]?reorder|ui[_ -]?change)\b/.test(
      combined,
    ) ||
    (/\b(?:navigation|sidebar|menu|links?)\b/.test(combined) &&
      /\b(?:reordered|swapped positions?|moved|positioned before|listed before|located below|distinct link)\b/.test(
        combined,
      ));
  const hasConcreteAwardFactChange =
    /\b(?:new|added|removed|changed|updated)\s+(?:application deadline|deadline|due date|award amount|stipend|tuition|funding amount)\b/.test(
      combined,
    ) ||
    /\b(?:applications?|nominations?)\s+(?:are|is)?\s*(?:now\s+)?(?:open|closed|due)\b/.test(
      combined,
    ) ||
    /\b(?:deadline|due date)\s+(?:is|was|has been|changed|moved|extended)\b/.test(combined) ||
    /\b(?:submit|apply|complete)\s+(?:by|before|no later than)\b/.test(combined);

  if (looksLikeNavigationReorder && !hasConcreteAwardFactChange) {
    return {
      flag: "navigation_or_reorder_only_change",
      reason: "Only navigation, sidebar, or FAQ item order changed; no applicant-facing award fact changed.",
    };
  }

  if (
    (/\boption=com_jevents\b/.test(search) ||
      /\btask=month\.calendar\b/.test(search) ||
      /\b(upcoming events?|admissions events?|calendar|conference|information session|open house|news & events?)\b/.test(
        `${section} ${summary} ${sourceUrl}`,
      )) &&
    !/\b(application deadline|deadline changed|applications? (?:open|close|due)|submit(?:ted)? by)\b/.test(combined)
  ) {
    return {
      flag: "calendar_event_noise",
      reason: "The change is calendar, conference, admissions-event, or news/event churn rather than award rules.",
    };
  }

  if (
    /\b(updated date|application papers updated date|update date|last updated|modified date|view count|writer'?s id|post id)\b/.test(
      combined,
    ) &&
    !/\b(applications? (?:is |are )?now open|application period (?:is )?open|deadline changed|eligibility changed|award amount changed)\b/.test(
      combined,
    )
  ) {
    return {
      flag: "metadata_only_update",
      reason: "Only an internal updated-date, view-count, post-id, writer-id, or similar metadata field changed.",
    };
  }

  if (
    /\b(?:active committee roster as of|displaying active committee roster|committee roster retrieval date|last retrieved on|refresh now)\b/.test(
      combined,
    ) &&
    /\broster\b/.test(combined) &&
    !hasSubstantiveApplicantSignal
  ) {
    return {
      flag: "metadata_only_roster_refresh",
      reason: "Only committee roster retrieval/as-of dates changed; no applicant-facing award fact changed.",
    };
  }

  if (
    host === "nifa.usda.gov" &&
    /\b(latest updates?|food and agriculture service learning program|food safety outreach program|successful institutions fy ?24|official publications and guidelines)\b/.test(
      combined,
    )
  ) {
    return {
      flag: "generic_latest_updates_block",
      reason: "A generic NIFA latest-updates/sidebar block changed for another opportunity.",
    };
  }

  if (
    /\b(file size and hash|specific changes? (?:within|in) (?:the )?(?:pdf|document|file) (?:are|were) not detailed|content of the pdf itself has changed, though the specific award details are not visible|file itself has changed)\b/.test(
      combined,
    ) &&
    !hasSubstantiveApplicantSignal
  ) {
    return {
      flag: "insufficient_document_semantic_diff",
      reason: "The document changed, but the worker did not identify a concrete award-relevant text change.",
    };
  }

  if (
    /\b(quote|testimonial|featured young leader|did you know\?|homepage introductory text|tagline|our impact statistics|program results|statistic(?:s)? update|profile carousel|featured scholar)\b/.test(
      combined,
    ) &&
    !hasSubstantiveApplicantSignal
  ) {
    return {
      flag: "marketing_or_rotating_content",
      reason: "Rotating quote, testimonial, marketing copy, featured profile, or impact-stat content changed.",
    };
  }

  if (sourceUrlLooksKnownBadForAwardChange(context)) {
    return {
      flag: "wrong_or_generic_source_shape",
      reason: "The source URL is a known generic, stale, calendar, donation, or cross-program source shape.",
    };
  }

  return null;
}

function aiReviewAuditNoiseContext(aiReview, source) {
  const result = aiReview?.result || {};
  const details =
    result.change_details && typeof result.change_details === "object" && !Array.isArray(result.change_details)
      ? result.change_details
      : {};
  const structuredDiff =
    details.structured_diff && typeof details.structured_diff === "object" && !Array.isArray(details.structured_diff)
      ? details.structured_diff
      : {};
  const sourceUrl = String(details.source?.source_url || source?.url || "");
  const parsed = safeUrlForAuditNoise(sourceUrl);
  const host = parsed?.hostname.replace(/^www\./i, "").toLowerCase() || "";
  const path = parsed?.pathname.toLowerCase() || "";
  const search = parsed?.search.toLowerCase() || "";
  const section = normalizeText(
    [
      result.changed_section,
      details.section,
      structuredDiff.likely_section,
      result.change_type,
      details.change_type,
    ].join(" "),
  ).toLowerCase();
  const summary = normalizeText(
    [
      result.reader_summary,
      result.advisor_impact,
      result.noise_reason,
      details.reader_summary,
      details.advisor_impact,
    ].join(" "),
  ).toLowerCase();
  const evidenceText = normalizeText(
    [
      result.before,
      result.after,
      details.before,
      details.after,
      ...stringArray(structuredDiff.added_text),
      ...stringArray(structuredDiff.removed_text),
      ...stringArray(structuredDiff.date_changes),
      ...stringArray(structuredDiff.amount_changes),
    ].join(" "),
  ).toLowerCase();
  const sourceText = normalizeText(
    [
      source?.shared_awards?.name,
      source?.title,
      source?.page_type,
      sourceUrl,
      details.source?.award_name,
      details.source?.source_title,
      details.source?.page_type,
    ].join(" "),
  ).toLowerCase();

  return {
    combined: `${summary} ${section} ${evidenceText} ${sourceText}`.trim(),
    evidenceText,
    host,
    path,
    search,
    section,
    summary,
    sourceText,
    sourceUrl,
  };
}

function sourceUrlLooksKnownBadForAwardChange(context) {
  const { host, path, search, sourceText, sourceUrl } = context;

  if (host === "fields.utoronto.ca" && path === "/activities/thematic") return true;
  if (host === "postdocs.ubc.ca" && path === "/awards-funding") return true;
  if (host === "ncbi.nlm.nih.gov" && /^\/books(?:\/|$)/.test(path)) return true;
  if (host === "ncbi.nlm.nih.gov" && /^\/medline\/publisherportal(?:\/|$)/.test(path)) return true;
  if (host === "www8.nationalacademies.org" && /\/pa\/managerequest\.aspx$/.test(path)) return true;
  if (host === "fastlane.nsf.gov" && path === "/fastlane.jsp") return true;
  if (host === "nsf.gov" && path === "/funding/programs.jsp" && /\borg=sbe\b/.test(search)) return true;
  if ((host === "nsf.gov" || host === "beta.nsf.gov") && /^\/geo\/(?:ags|ear)(?:\/|$)/.test(path)) {
    return true;
  }
  if (host === "croucher.org.hk" && /croucher-science-communication-studentships/.test(path)) {
    return !/\bscience communication\b/.test(sourceText);
  }
  if (host === "usascholarships.com" && /\/barbizon-college-tuition-scholarship-program(?:\/|$)/.test(path)) {
    return true;
  }
  if (host === "gerda-henkel-stiftung.de" && path === "/en/prize") return true;
  if (host === "aotf.org" && path === "/funding/") return true;
  if (host === "gsa.gov" && /^\/reference\/(?:civil-rights-programs|freedom-of-information-act-foia)(?:\/|$)/.test(path)) {
    return true;
  }
  if (host === "lung.org" && /^\/get-involved\/ways-to-give(?:\/|$)/.test(path)) return true;
  if (host === "seg.org" && /\/programs\/student-programs\/seg-evolve(?:\/|$)/.test(path)) {
    return /\bscholarships?\b/.test(sourceText);
  }
  if (/(^|\.)shafr\.org$/.test(host) && (/\boption=com_jevents\b/.test(search) || /\btask=month\.calendar\b/.test(search))) {
    return true;
  }
  if (host === "dowjonesnewsfund.org" && /\/news\/students-can-apply-for-2019-internships(?:\/|$)/.test(path)) {
    return true;
  }
  if (host === "pgfusa.org" && /\/2022-awards-program(?:\/|$)/.test(path)) return true;
  if (
    host === "costumesocietyamerica.com" &&
    /\bstella\b.*\bblum\b/.test(sourceText) &&
    !/stella|travel-research-grant/.test(path)
  ) {
    return true;
  }

  return /\/(?:tag|tags|category|categories|search|search-results?|site-search)(?:\/|$)/.test(path) ||
    /\b(?:search|keyword|keywords|search_api_fulltext)=/.test(search) ||
    /option=com_jevents|task=month\.calendar/.test(sourceUrl.toLowerCase());
}

function safeUrlForAuditNoise(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function hasApplicantFacingAwardSignalText(value) {
  return /\b(deadline|due|opening date|open(?:s|ing)?|closing date|closes?|eligible|eligibility|requirement|award conditions?|recommendation|transcript|essay|nomination|submit|submission|application (?:deadline|material|materials|portal|instructions?|opens?|closes?)|application materials?|application instructions?|how to apply|documents?|forms?|guidelines?|contact|email|phone|official cycle|cycle status|award amount|stipend|tuition|funding)\b/.test(
    String(value || "").toLowerCase(),
  );
}

function stripUnchangedApplicantReferences(value) {
  return String(value || "")
    .replace(
      /\b(?:award\s+)?(?:deadlines?|eligibility|requirements?|application(?:\s+instructions?)?|award amounts?|funding)\b[^.]{0,90}\b(?:remain(?:s)?|are|is|were|was)?\s*(?:unchanged|not changed|no change)\b/gi,
      " ",
    )
    .replace(
      /\b(?:no|not any)\s+(?:changes?|updates?)\s+(?:to|in)\s+(?:award\s+)?(?:deadlines?|eligibility|requirements?|application(?:\s+instructions?)?|award amounts?|funding)\b/gi,
      " ",
    )
    .replace(
      /\bno\b[^.]{0,140}\b(?:deadlines?|eligibility|requirements?|application(?:\s+instructions?)?|award amounts?|funding)\b[^.]{0,140}\b(?:changed|change|updated|updates?)\b/gi,
      " ",
    );
}

function markAiReviewAsNoise(aiReview, flag, reason) {
  const result = aiReview?.result || {};
  const details =
    result.change_details && typeof result.change_details === "object" && !Array.isArray(result.change_details)
      ? result.change_details
      : null;
  const structuredDiff =
    details?.structured_diff && typeof details.structured_diff === "object" && !Array.isArray(details.structured_diff)
      ? details.structured_diff
      : {};
  const cleanFlag = cleanSlug(flag);
  const qualityFlags = unique([
    ...stringArray(result.quality_flags).map(cleanSlug),
    ...stringArray(details?.quality_flags).map(cleanSlug),
    cleanFlag,
  ]).filter(Boolean);
  const noiseFlags = unique([
    ...stringArray(structuredDiff.noise_flags).map(cleanSlug),
    cleanFlag,
  ]).filter(Boolean);

  aiReview.result = {
    ...result,
    is_true_change: false,
    noise_reason: result.noise_reason || reason,
    reader_summary: null,
    advisor_impact: null,
    confidence: "high",
    quality_flags: qualityFlags,
    change_details: details
      ? {
          ...details,
          reader_summary: "No award-relevant visual change was detected.",
          advisor_impact: null,
          is_alert_worthy: false,
          confidence: "high",
          change_type: "noise",
          quality_flags: qualityFlags,
          structured_diff: {
            ...structuredDiff,
            noise_flags: noiseFlags,
          },
          generation_status: "rejected",
        }
      : result.change_details,
  };
}

function auditAiReviewAgainstTextEvidence({ source, previous, capture, diff, aiReview }) {
  const result = aiReview?.result || {};
  if (!result.is_true_change) {
    return { corrected: false, rejected: false, flags: [] };
  }

  const previousText = normalizeVisibleText(previous?.text || "");
  const currentText = normalizeVisibleText(capture?.text || "");
  if (!previousText || !currentText) {
    return { corrected: false, rejected: false, flags: [] };
  }

  const details =
    result.change_details && typeof result.change_details === "object" && !Array.isArray(result.change_details)
      ? result.change_details
      : {};
  const structuredDiff = normalizeVisualStructuredDiff(
    jsonObjectOrEmpty(details.structured_diff || result.structured_diff),
    diff,
    source,
  );
  const flags = [];
  const addedAudit = auditDirectionalTextEvidence(
    structuredDiff.added_text,
    "added",
    previousText,
    currentText,
  );
  const removedAudit = auditDirectionalTextEvidence(
    structuredDiff.removed_text,
    "removed",
    previousText,
    currentText,
  );
  const dateAudit = auditDirectionalValueEvidence(structuredDiff.date_changes, previousText, currentText);
  const amountAudit = auditDirectionalValueEvidence(structuredDiff.amount_changes, previousText, currentText);

  if (addedAudit.stripped.length) flags.push("unsupported_added_text");
  if (removedAudit.stripped.length) flags.push("unsupported_removed_text");
  if (dateAudit.stripped.length) flags.push("unsupported_date_change");
  if (amountAudit.stripped.length) flags.push("unsupported_amount_change");

  if (
    normalizeConfidence(result.confidence) === "high" &&
    (dateAudit.stripped.length || amountAudit.stripped.length)
  ) {
    return {
      corrected: false,
      rejected: true,
      flags: unique(flags.length ? flags : ["critical_evidence_mismatch"]),
      flag: "critical_evidence_mismatch",
      reason:
        "The AI described a high-confidence deadline, date, amount, or funding change, but the claimed value was not supported by exact added or removed evidence.",
    };
  }

  let before = cleanNullable(result.before || details.before);
  let after = cleanNullable(result.after || details.after);
  const beforeKey = sentenceKey(before || "");
  const afterKey = sentenceKey(after || "");
  const beforeStillPresent = Boolean(before && textContainsEvidenceSnippet(currentText, before));
  const afterAlreadyPresent = Boolean(after && textContainsEvidenceSnippet(previousText, after));
  const beforeWasPresent = Boolean(before && textContainsEvidenceSnippet(previousText, before));
  const afterIsPresent = Boolean(after && textContainsEvidenceSnippet(currentText, after));

  if (beforeKey && afterKey && beforeKey === afterKey) {
    flags.push("before_after_identical");
    before = null;
    after = null;
  } else {
    if (beforeStillPresent && !removedAudit.kept.some((value) => evidenceClaimsOverlap(value, before))) {
      flags.push("before_text_still_present");
      before = null;
    }
    if (afterAlreadyPresent && !addedAudit.kept.some((value) => evidenceClaimsOverlap(value, after))) {
      flags.push("after_text_already_present");
      after = null;
    }
    if (before && !beforeWasPresent && evidenceSnippetIsLocatable(before)) {
      flags.push("before_text_not_found");
      before = null;
    }
    if (after && !afterIsPresent && evidenceSnippetIsLocatable(after)) {
      flags.push("after_text_not_found");
      after = null;
    }
  }

  if (!before && removedAudit.kept.length && !addedAudit.kept.length) {
    before = removedAudit.kept[0];
  }
  if (!after && addedAudit.kept.length && !removedAudit.kept.length) {
    after = addedAudit.kept[0];
  }

  const nextStructuredDiff = {
    ...structuredDiff,
    added_text: addedAudit.kept,
    removed_text: removedAudit.kept,
    date_changes: dateAudit.kept,
    amount_changes: amountAudit.kept,
    noise_flags: unique([
      ...stringArray(structuredDiff.noise_flags).map(cleanSlug),
      ...flags.map(cleanSlug),
    ]).filter(Boolean),
  };

  const hasSupportedEvidence =
    nextStructuredDiff.added_text.length > 0 ||
    nextStructuredDiff.removed_text.length > 0 ||
    nextStructuredDiff.date_changes.length > 0 ||
    nextStructuredDiff.amount_changes.length > 0 ||
    Boolean(before && !textContainsEvidenceSnippet(currentText, before)) ||
    Boolean(after && !textContainsEvidenceSnippet(previousText, after));

  if (!hasSupportedEvidence) {
    return {
      corrected: false,
      rejected: true,
      flags: unique(flags.length ? flags : ["evidence_mismatch"]),
      flag: "evidence_mismatch",
      reason:
        "The AI described an award update, but the claimed changed wording was not supported by the previous and current capture text.",
    };
  }

  if (!flags.length) {
    return { corrected: false, rejected: false, flags: [] };
  }

  const qualityFlags = unique([
    ...stringArray(result.quality_flags).map(cleanSlug),
    ...stringArray(details.quality_flags).map(cleanSlug),
    "evidence_sanity_corrected",
    ...flags.map(cleanSlug),
  ]).filter(Boolean);
  const groundedSummary = evidenceGroundedChangeSummary({
    source,
    structuredDiff: nextStructuredDiff,
    before,
    after,
  });
  const groundedImpact = evidenceGroundedAdvisorImpact(nextStructuredDiff);
  const changeType = inferVisualChangeType(
    {
      ...result,
      before,
      after,
      changed_section: result.changed_section || details.section || nextStructuredDiff.likely_section,
      reader_summary: groundedSummary || result.reader_summary,
    },
    nextStructuredDiff,
  );

  aiReview.result = {
    ...result,
    before,
    after,
    change_type: changeType,
    reader_summary: groundedSummary || result.reader_summary,
    advisor_impact: groundedImpact || result.advisor_impact,
    quality_flags: qualityFlags,
    change_details: {
      ...details,
      reader_summary: groundedSummary || details.reader_summary || result.reader_summary,
      before,
      after,
      section: cleanNullable(details.section || result.changed_section || nextStructuredDiff.likely_section),
      change_type: changeType,
      advisor_impact: groundedImpact || details.advisor_impact || result.advisor_impact,
      is_alert_worthy: true,
      confidence: normalizeConfidence(details.confidence || result.confidence) || "medium",
      structured_diff: nextStructuredDiff,
      quality_flags: qualityFlags,
      generation_status: "generated",
    },
  };

  return { corrected: true, rejected: false, flags: qualityFlags.filter((flag) => flags.includes(flag)) };
}

function auditDirectionalTextEvidence(values, direction, previousText, currentText) {
  const kept = [];
  const stripped = [];

  for (const value of dedupeText(stringArray(values))) {
    const locatable = evidenceSnippetIsLocatable(value);
    if (!locatable) {
      kept.push(value);
      continue;
    }

    const inPrevious = textContainsEvidenceSnippet(previousText, value);
    const inCurrent = textContainsEvidenceSnippet(currentText, value);
    const supported = direction === "added" ? inCurrent && !inPrevious : inPrevious && !inCurrent;

    if (supported) {
      kept.push(value);
    } else {
      stripped.push({
        value,
        in_previous: inPrevious,
        in_current: inCurrent,
      });
    }
  }

  return { kept: kept.slice(0, 8), stripped };
}

function auditDirectionalValueEvidence(values, previousText, currentText) {
  const kept = [];
  const stripped = [];

  for (const value of dedupeText(stringArray(values))) {
    const clean = cleanText(value);
    const direction = directionalEvidencePrefix(clean);
    const phrase = directionalEvidencePhrase(clean);
    const phraseKey = sentenceKey(phrase);
    if (phraseKey.length < 4) {
      kept.push(clean);
      continue;
    }

    const inPrevious = textContainsEvidencePhrase(previousText, phrase);
    const inCurrent = textContainsEvidencePhrase(currentText, phrase);
    const supported =
      direction === "added"
        ? inCurrent && !inPrevious
        : direction === "removed"
          ? inPrevious && !inCurrent
          : !(inPrevious && inCurrent);

    if (supported) {
      kept.push(clean);
    } else {
      stripped.push({
        value: clean,
        in_previous: inPrevious,
        in_current: inCurrent,
      });
    }
  }

  return { kept: kept.slice(0, 8), stripped };
}

function evidenceSnippetIsLocatable(value) {
  return sentenceKey(value).length >= 25 || compactEvidenceKey(value).length >= 40;
}

function textContainsEvidenceSnippet(text, snippet) {
  if (!evidenceSnippetIsLocatable(snippet)) return false;
  const snippetKey = sentenceKey(snippet);
  const textKey = ` ${sentenceKey(text)} `;
  if (snippetKey.length >= 25 && textKey.includes(` ${snippetKey} `)) return true;

  const compactSnippet = compactEvidenceKey(snippet);
  return compactSnippet.length >= 40 && compactEvidenceKey(text).includes(compactSnippet);
}

function textContainsEvidencePhrase(text, phrase) {
  const phraseKey = sentenceKey(phrase);
  if (!phraseKey) return false;
  return ` ${sentenceKey(text)} `.includes(` ${phraseKey} `);
}

function compactEvidenceKey(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function directionalEvidencePrefix(value) {
  const match = cleanText(value).match(/^(added|new|removed|deleted|old|previous)\b/i);
  if (!match) return null;
  return ["added", "new"].includes(match[1].toLowerCase()) ? "added" : "removed";
}

function directionalEvidencePhrase(value) {
  return cleanText(value)
    .replace(/^(?:added|new|removed|deleted|old|previous|current)\s*:?\s*/i, "")
    .trim();
}

function evidenceClaimsOverlap(left, right) {
  const leftKey = sentenceKey(left);
  const rightKey = sentenceKey(right);
  if (!leftKey || !rightKey) return false;
  return leftKey.includes(rightKey) || rightKey.includes(leftKey);
}

function evidenceGroundedChangeSummary({ source, structuredDiff, before, after }) {
  const section = cleanNullable(structuredDiff.likely_section) || inferSection(
    [
      before,
      after,
      ...stringArray(structuredDiff.added_text),
      ...stringArray(structuredDiff.removed_text),
      ...stringArray(structuredDiff.date_changes),
      ...stringArray(structuredDiff.amount_changes),
    ].join(" "),
  );
  const sectionText = section ? `${section.toLowerCase()} ` : "";
  const sourceLabelText = source?.title ? "This source page" : "The source page";
  const added = stringArray(structuredDiff.added_text);
  const removed = stringArray(structuredDiff.removed_text);

  if (added.length && removed.length) {
    return `${sourceLabelText} changed ${sectionText}wording from "${truncate(removed[0], 160)}" to "${truncate(added[0], 160)}".`;
  }
  if (removed.length) {
    return `${sourceLabelText} no longer includes this ${sectionText}wording: "${truncate(removed[0], 200)}".`;
  }
  if (added.length) {
    return `${sourceLabelText} now includes this ${sectionText}wording: "${truncate(added[0], 200)}".`;
  }
  if (stringArray(structuredDiff.date_changes).length) {
    return `${sourceLabelText} has a supported date-related change: ${truncate(stringArray(structuredDiff.date_changes)[0], 180)}.`;
  }
  if (stringArray(structuredDiff.amount_changes).length) {
    return `${sourceLabelText} has a supported funding-related change: ${truncate(stringArray(structuredDiff.amount_changes)[0], 180)}.`;
  }
  return null;
}

function evidenceGroundedAdvisorImpact(structuredDiff) {
  const section = cleanNullable(structuredDiff.likely_section);
  if (stringArray(structuredDiff.removed_text).length) {
    return section
      ? `Review the ${section.toLowerCase()} wording because a previously captured statement is no longer present.`
      : "Review this source because a previously captured award statement is no longer present.";
  }
  if (stringArray(structuredDiff.added_text).length) {
    return section
      ? `Review the ${section.toLowerCase()} wording because the page now includes a new captured statement.`
      : "Review this source because the page now includes a new captured award statement.";
  }
  if (stringArray(structuredDiff.date_changes).length || stringArray(structuredDiff.amount_changes).length) {
    return "Review the source before advising applicants because a supported date or funding detail changed.";
  }
  return null;
}

function isOpaqueDocumentEvidenceText(value) {
  const clean = normalizeText(String(value || ""));
  if (!clean) return true;
  if (/^\d{1,10}$/.test(clean)) return true;
  const tokens = clean.match(/[a-z0-9]+/gi) || [];
  if (!tokens.length) return true;
  const hexTokenCount = tokens.filter((token) => /^[a-f0-9]{1,16}$/i.test(token)).length;
  const longHashCount = tokens.filter((token) => /^[a-f0-9]{16,}$/i.test(token)).length;
  const readableWordCount = tokens.filter((token) => /[g-z]/i.test(token) && token.length >= 4).length;

  return (
    longHashCount > 0 ||
    (tokens.length >= 6 && hexTokenCount / tokens.length >= 0.82 && readableWordCount === 0)
  );
}

function looksLikeSourceAccessError(value) {
  const clean = normalizeText(String(value || ""));
  return /\b(error\s*(?:401|403|404|410|429|50[0-4])|access denied|forbidden|not found|page not found|service unavailable|too many requests)\b/i.test(
    clean,
  );
}

function visualChangeDetailsFromReview({ source, diff, aiReview, parsed = null }) {
  const result = aiReview?.result || {};
  const structuredDiff = normalizeVisualStructuredDiff(
    jsonObjectOrEmpty(parsed?.structured_diff || result.structured_diff),
    diff,
    source,
  );
  const isAlertWorthy = Boolean(result.is_true_change);
  return {
    reader_summary:
      cleanNullable(result.reader_summary) ||
      (isAlertWorthy ? "A visual award source change was detected." : "No award-relevant visual change was detected."),
    before: cleanNullable(result.before || parsed?.before),
    after: cleanNullable(result.after || parsed?.after),
    section: cleanNullable(result.changed_section || parsed?.section || structuredDiff.likely_section),
    change_type: cleanSlug(result.change_type || parsed?.change_type) || inferVisualChangeType(parsed || result, diff),
    advisor_impact: cleanNullable(result.advisor_impact),
    is_alert_worthy: isAlertWorthy,
    confidence: normalizeConfidence(result.confidence) || "low",
    structured_diff: structuredDiff,
    source: {
      award_name: source?.shared_awards?.name || null,
      source_title: source?.title || null,
      source_url: source?.url || null,
      page_type: source?.page_type || null,
    },
    quality_flags: unique([
      "visual_snapshot_comparison",
      ...stringArray(result.quality_flags || parsed?.quality_flags).map(cleanSlug),
      ...structuredDiff.noise_flags,
    ]).filter(Boolean),
    generated_at: new Date().toISOString(),
    generation_provider: aiReview?.provider === "openai" ? "openai" : "gemini",
    generation_status: isAlertWorthy ? "generated" : "rejected",
    generation_model: aiReview?.model || aiModel,
  };
}

function normalizeVisualStructuredDiff(value, fallbackDiff = {}, source = null) {
  return {
    added_text: stringArray(value.added_text).length
      ? stringArray(value.added_text).slice(0, 8)
      : stringArray(fallbackDiff.added_text).slice(0, 8),
    removed_text: stringArray(value.removed_text).length
      ? stringArray(value.removed_text).slice(0, 8)
      : stringArray(fallbackDiff.removed_text).slice(0, 8),
    likely_section: cleanNullable(value.likely_section) || fallbackDiff.likely_section || inferSection(source?.title || ""),
    page_type: cleanNullable(value.page_type) || source?.page_type || fallbackDiff.page_type || null,
    date_changes: stringArray(value.date_changes).length
      ? stringArray(value.date_changes).slice(0, 8)
      : stringArray(fallbackDiff.date_changes).slice(0, 8),
    amount_changes: stringArray(value.amount_changes).length
      ? stringArray(value.amount_changes).slice(0, 8)
      : stringArray(fallbackDiff.amount_changes).slice(0, 8),
    noise_flags: unique(stringArray(value.noise_flags).map(cleanSlug).filter(Boolean)).slice(0, 20),
  };
}

function inferVisualChangeType(parsed, diff = {}) {
  const haystack = normalizeText(
    [
      parsed?.change_type,
      parsed?.changed_section,
      parsed?.reader_summary,
      parsed?.advisor_impact,
      ...(diff?.date_changes || []),
      ...(diff?.amount_changes || []),
      ...(diff?.added_text || []),
      ...(diff?.removed_text || []),
    ].join(" "),
  ).toLowerCase();
  if (/\b(deadline|date|opens?|closes?|due)\b/.test(haystack)) return "deadline";
  if (/\b(amount|funding|stipend|tuition|grant|award amount)\b/.test(haystack)) return "funding";
  if (/\b(eligible|eligibility|citizenship|gpa)\b/.test(haystack)) return "eligibility";
  if (/\b(apply|application|submit|submission|recommendation|transcript|essay|nomination)\b/.test(haystack)) return "application";
  if (/\b(pdf|document|guide|guideline|instruction)\b/.test(haystack)) return "document";
  return "other";
}

function normalizeAiReview(text, context = {}) {
  const parsed = typeof text === "string" ? parseJsonObject(text) : jsonObjectOrEmpty(text);
  if (!parsed) throw new Error("AI returned invalid JSON.");
  const confidence = normalizeConfidence(parsed.confidence);
  if (!confidence) {
    throw new Error("AI JSON is missing confidence.");
  }

  const isTrueChange =
    typeof parsed.is_true_change === "boolean"
      ? parsed.is_true_change
      : null;

  if (typeof isTrueChange !== "boolean") {
    throw new Error("AI JSON is missing is_true_change.");
  }
  if (typeof parsed.is_alert_worthy !== "boolean") {
    throw new Error("AI JSON is missing is_alert_worthy.");
  }
  const alertWorthy = Boolean(isTrueChange && parsed.is_alert_worthy);
  const sourceRelevance = normalizeAwardRelevance(parsed.source_relevance);
  const changedFacts = normalizeAiReviewChangedFacts(parsed.changed_facts || parsed.changed_award_facts);
  const exactBefore = cleanNullable(parsed.exact_before ?? parsed.before);
  const exactAfter = cleanNullable(parsed.exact_after ?? parsed.after);
  const evidenceLocation = cleanNullable(parsed.evidence_location);
  const noiseFlags = unique([
    ...stringArray(parsed.noise_flags).map(cleanSlug),
    ...stringArray(parsed.quality_flags).map(cleanSlug),
  ]).filter(Boolean);

  if (
    alertWorthy &&
    (!cleanNullable(parsed.reader_summary) || !cleanNullable(parsed.advisor_impact))
  ) {
    throw new Error("AI approved a true change without reader_summary or advisor_impact.");
  }
  if (alertWorthy && !["primary", "supporting"].includes(sourceRelevance)) {
    throw new Error(`AI approved a true change with source_relevance=${sourceRelevance}.`);
  }
  if (alertWorthy && !changedFacts.length) {
    throw new Error("AI approved a true change without changed_facts.");
  }
  if (alertWorthy && !changedFactsHaveApplicantFacingSignal(changedFacts, parsed, context.diff)) {
    throw new Error("AI approved a true change without applicant-facing changed_facts.");
  }
  if (alertWorthy && !changedFactsHaveExactEvidence({ changedFacts, exactBefore, exactAfter, parsed, diff: context.diff })) {
    throw new Error("AI approved a true change without exact deterministic evidence.");
  }

  const result = {
    is_true_change: alertWorthy,
    is_alert_worthy: alertWorthy,
    source_relevance: sourceRelevance,
    source_relevance_reason: cleanNullable(parsed.source_relevance_reason),
    changed_facts: changedFacts,
    exact_before: exactBefore,
    exact_after: exactAfter,
    evidence_location: evidenceLocation,
    noise_reason: cleanNullable(parsed.noise_reason || parsed.rejection_reason),
    reader_summary: cleanNullable(parsed.reader_summary),
    advisor_impact: cleanNullable(parsed.advisor_impact),
    changed_section: cleanNullable(parsed.changed_section),
    confidence,
    before: exactBefore || cleanNullable(parsed.before),
    after: exactAfter || cleanNullable(parsed.after),
    change_type: cleanSlug(parsed.change_type) || inferVisualChangeType(parsed, context.diff),
    updated_baseline_facts: jsonObjectOrNull(parsed.updated_baseline_facts),
    noise_flags: noiseFlags,
    rejection_reason: cleanNullable(parsed.rejection_reason),
    quality_flags: noiseFlags,
  };

  result.change_details = visualChangeDetailsFromReview({
    source: context.source,
    diff: context.diff,
    aiReview: {
      provider: context.provider || "gemini",
      model: context.model || aiModel,
      result,
    },
    parsed,
  });

  return result;
}

function normalizeAiReviewChangedFacts(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === "string") {
        return {
          fact: cleanNullable(item),
          before: null,
          after: null,
          added_text: null,
          removed_text: null,
          visual_evidence: null,
        };
      }
      const object = jsonObjectOrEmpty(item);
      return {
        fact: cleanNullable(object.fact || object.name || object.summary),
        before: cleanNullable(object.before),
        after: cleanNullable(object.after),
        added_text: cleanNullable(object.added_text || object.addedText),
        removed_text: cleanNullable(object.removed_text || object.removedText),
        visual_evidence: cleanNullable(object.visual_evidence || object.visualEvidence || object.evidence),
      };
    })
    .filter((fact) => fact.fact || fact.before || fact.after || fact.added_text || fact.removed_text || fact.visual_evidence)
    .slice(0, 12);
}

function changedFactsHaveApplicantFacingSignal(changedFacts, parsed, diff) {
  const text = [
    parsed?.change_type,
    parsed?.changed_section,
    parsed?.section,
    parsed?.reader_summary,
    parsed?.advisor_impact,
    ...(diff?.date_changes || []),
    ...(diff?.amount_changes || []),
    ...changedFacts.flatMap((fact) => [
      fact.fact,
      fact.before,
      fact.after,
      fact.added_text,
      fact.removed_text,
      fact.visual_evidence,
    ]),
  ].join(" ");
  return hasApplicantFacingAwardSignalText(text);
}

function changedFactsHaveExactEvidence({ changedFacts, exactBefore, exactAfter, parsed, diff }) {
  const addedEvidence = [
    ...stringArray(diff?.added_text),
    ...stringArray(diff?.date_changes).filter((value) => /^added\b/i.test(value)),
    ...stringArray(diff?.amount_changes).filter((value) => /^added\b/i.test(value)),
    ...stringArray(parsed?.structured_diff?.added_text),
    ...stringArray(parsed?.structured_diff?.date_changes).filter((value) => /^added\b/i.test(value)),
    ...stringArray(parsed?.structured_diff?.amount_changes).filter((value) => /^added\b/i.test(value)),
  ];
  const removedEvidence = [
    ...stringArray(diff?.removed_text),
    ...stringArray(diff?.date_changes).filter((value) => /^removed\b/i.test(value)),
    ...stringArray(diff?.amount_changes).filter((value) => /^removed\b/i.test(value)),
    ...stringArray(parsed?.structured_diff?.removed_text),
    ...stringArray(parsed?.structured_diff?.date_changes).filter((value) => /^removed\b/i.test(value)),
    ...stringArray(parsed?.structured_diff?.amount_changes).filter((value) => /^removed\b/i.test(value)),
  ];
  const hasVisualEvidence = changedFacts.some((fact) => cleanNullable(fact.visual_evidence)) || cleanNullable(parsed?.evidence_location);

  if (exactBefore && !evidenceArrayContains(removedEvidence, exactBefore)) return false;
  if (exactAfter && !evidenceArrayContains(addedEvidence, exactAfter)) return false;

  return changedFacts.every((fact) => {
    if (fact.removed_text && evidenceArrayContains(removedEvidence, fact.removed_text)) return true;
    if (fact.added_text && evidenceArrayContains(addedEvidence, fact.added_text)) return true;
    if (fact.before && evidenceArrayContains(removedEvidence, fact.before)) return true;
    if (fact.after && evidenceArrayContains(addedEvidence, fact.after)) return true;
    return Boolean(fact.visual_evidence && hasVisualEvidence);
  });
}

function evidenceArrayContains(haystackValues, needle) {
  const cleanNeedle = normalizeText(needle).toLowerCase();
  if (!cleanNeedle || cleanNeedle.length < 3) return false;
  return haystackValues
    .map((value) => normalizeText(value).toLowerCase())
    .filter(Boolean)
    .some((value) => value.includes(cleanNeedle) || cleanNeedle.includes(value));
}

function parseJsonObject(text) {
  const clean = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  if (!clean) return null;
  try {
    const parsed = JSON.parse(clean);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    const match = clean.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      const parsed = JSON.parse(match[0]);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
}

function extractGeminiText(data) {
  return (data?.candidates || [])
    .flatMap((candidate) => candidate?.content?.parts || [])
    .map((part) => part?.text || "")
    .join(" ")
    .trim();
}

function normalizeGeminiUsage(metadata) {
  const promptTokens = nonNegativeInt(metadata?.promptTokenCount ?? metadata?.prompt_tokens, 0);
  const candidatesTokens = nonNegativeInt(
    metadata?.candidatesTokenCount ?? metadata?.candidates_tokens,
    0,
  );
  const thoughtsTokens = nonNegativeInt(metadata?.thoughtsTokenCount ?? metadata?.thoughts_tokens, 0);
  const cachedContentTokens = nonNegativeInt(
    metadata?.cachedContentTokenCount ?? metadata?.cached_content_tokens,
    0,
  );
  const fallbackTotal = promptTokens + candidatesTokens + thoughtsTokens;
  return {
    prompt_tokens: promptTokens,
    candidates_tokens: candidatesTokens,
    total_tokens: nonNegativeInt(metadata?.totalTokenCount ?? metadata?.total_tokens, fallbackTotal),
    thoughts_tokens: thoughtsTokens,
    cached_content_tokens: cachedContentTokens,
  };
}

function extractResponseText(data) {
  if (typeof data?.output_text === "string") return data.output_text.trim();
  return (data?.output || [])
    .flatMap((item) => item?.content || [])
    .map((part) => part?.text || "")
    .join(" ")
    .trim();
}

function runRequiresAi() {
  return runRequiresAiFromOptions(aiRequirementOptions());
}

function aiDisabledReasonForRun() {
  return aiDisabledReasonForOptions(aiRequirementOptions());
}

function aiRequirementOptions() {
  return {
    visualReviewMode,
    extractBaselineInfo,
    backfillBaselineInfo,
    localizationRepair,
    r2SnapshotSync,
    r2RepairMissingSnapshots,
    r2BackfillBaselines,
    sourceQualityMode:
      args["source-quality-mode"] ||
      args["source-quality-ai-mode"] ||
      env.AWARDPING_SOURCE_QUALITY_MODE ||
      env.AWARDPING_SOURCE_QUALITY_AI_MODE,
  };
}

function assertAiAvailable(action) {
  if (!runRequiresAi()) {
    throw new Error(
      `AI is disabled for this visual snapshot run (${aiDisabledReason || "no_ai_calling_workflow_enabled"}), but code attempted ${action}.`,
    );
  }
  if (!aiProvider) {
    throw new Error(`${missingAiMessage(requestedAiProvider)} Required for ${action}.`);
  }
}

function missingAiMessage(requestedProvider) {
  return missingAiProviderMessage(requestedProvider);
}

function modelForProvider(provider) {
  if (provider === "gemini") {
    return geminiWorkerModel();
  }
  if (provider === "openai") return env.OPENAI_SUMMARY_MODEL || env.OPENAI_DISCOVERY_MODEL || "gpt-4.1-mini";
  if (provider === "gemini-cli") return geminiCliModel;
  return null;
}

function describeSupabaseError(error, action) {
  const message = error?.message || String(error);
  const details = error?.details ? ` ${error.details}` : "";
  const hint = error?.hint ? ` ${error.hint}` : "";
  const code = error?.code ? ` (${error.code})` : "";
  const fullText = `${message}${details}${hint}`.toLowerCase();

  if (fullText.includes("invalid api key")) {
    return "Invalid Supabase service_role key. Re-run the Windows installer and paste the Supabase project service_role key for the AwardPing Supabase project.";
  }
  if (
    fullText.includes("fetch failed") ||
    fullText.includes("failed to fetch") ||
    fullText.includes("econnrefused") ||
    fullText.includes("enotfound")
  ) {
    return `Could not reach Supabase while trying to ${action}. Check NEXT_PUBLIC_SUPABASE_URL in the worker env file. Current URL: ${supabaseUrl}.`;
  }
  if (
    fullText.includes("does not exist") ||
    fullText.includes("could not find the table") ||
    fullText.includes("schema cache") ||
    error?.code === "PGRST204" ||
    error?.code === "PGRST205"
  ) {
    return `${message}${code}. The Supabase schema is missing the shared-award/local-worker tables. Apply the AwardPing Supabase migrations.`;
  }

  return `${message}${details}${hint}${code} while trying to ${action}.`;
}

function hashText(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function hashBuffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function timestampForPath(value = new Date().toISOString()) {
  return new Date(value).toISOString().replace(/[:.]/g, "-");
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").replace(/\u0000/g, "").trim();
}

function cleanText(value) {
  return normalizeText(value).slice(0, 2000);
}

function cleanNullable(value) {
  const clean = cleanText(value);
  return clean || null;
}

function cleanSlug(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function stringArray(value) {
  if (Array.isArray(value)) {
    return value.map((item) => cleanText(item)).filter(Boolean);
  }
  const clean = cleanText(value);
  return clean ? [clean] : [];
}

function booleanOrNull(value) {
  if (typeof value === "boolean") return value;
  const clean = cleanSlug(value);
  if (["true", "yes", "1"].includes(clean)) return true;
  if (["false", "no", "0"].includes(clean)) return false;
  return null;
}

function sectionArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        const title = cleanText(item);
        return title ? { title, description: "", status: "unchanged" } : null;
      }
      const title = cleanText(item.title || item.name || item.label);
      const description = cleanText(item.description || item.summary || item.detail);
      const status = normalizeSectionStatus(item.status);
      if (!title && !description) return null;
      return {
        title: title || "Section",
        description,
        status,
      };
    })
    .filter(Boolean);
}

function normalizeSectionStatus(value) {
  const clean = cleanSlug(value);
  if (["changed", "new", "removed", "unchanged"].includes(clean)) return clean;
  if (clean === "needs_review" || clean === "review") return "needs_review";
  return "unchanged";
}

function normalizeConfidence(value) {
  const clean = cleanSlug(value);
  if (clean === "low" || clean === "medium" || clean === "high") return clean;
  return null;
}

function normalizeAwardRelevance(value) {
  const clean = cleanSlug(value);
  if (["primary", "supporting", "unclear", "unrelated"].includes(clean)) return clean;
  if (clean === "relevant") return "primary";
  return "unclear";
}

function normalizeCycleRelevance(value) {
  const clean = cleanSlug(value);
  if (["current_or_upcoming", "evergreen", "archived_or_past", "unclear", "not_program_page"].includes(clean)) {
    return clean;
  }
  if (["current", "upcoming", "current_upcoming", "active", "open"].includes(clean)) return "current_or_upcoming";
  if (["archive", "archived", "past", "past_cycle", "previous", "stale", "closed"].includes(clean)) {
    return "archived_or_past";
  }
  if (["unrelated", "not_a_program_page", "not_program", "not_program_application_page"].includes(clean)) {
    return "not_program_page";
  }
  return "unclear";
}

function isContradictoryHighConfidenceFactFlag(flag) {
  const clean = cleanSlug(flag).replace(/-/g, "_");
  return [
    "source_mismatch",
    "unclear",
    "unrelated",
    "unrelated_program",
    "sibling_program",
    "generic_listing",
    "search_results",
    "access_error",
    "spam",
    "hacked_page",
    "pharma_spam",
  ].includes(clean);
}

function shouldReviewLaterForBaselineFactsRejection(facts, reason) {
  const awardRelevance = normalizeAwardRelevance(facts?.award_relevance);
  const cycleRelevance = normalizeCycleRelevance(facts?.cycle_relevance);
  const flags = new Set(stringArray(facts?.quality_flags).map(cleanSlug));
  if ([...flags].some((flag) =>
    [
      "source_mismatch",
      "spam",
      "job_board",
      "career_page",
      "search_results",
      "generic_listing",
      "sibling_program",
      "access_error",
      "hacked_page",
      "pharma_spam",
      "unrelated_program",
    ].includes(flag)
  )) return true;
  if (awardRelevance === "unrelated") return true;
  if (awardRelevance === "unclear") return true;
  if (cycleRelevance === "not_program_page") return true;
  if (cycleRelevance === "archived_or_past") return true;
  return /^(award_relevance_|cycle_relevance_|quality_flag_|baseline_facts_rejected|url_)/.test(String(reason || ""));
}

function jsonObjectOrNull(value) {
  const object = jsonObjectOrEmpty(value);
  return Object.keys(object).length ? object : null;
}

function truncate(value, maxLength) {
  const clean = normalizeText(value);
  if (clean.length <= maxLength) return clean;
  const truncated = clean.slice(0, maxLength + 1);
  const boundary = truncated.lastIndexOf(" ");
  return `${truncated.slice(0, boundary > maxLength * 0.65 ? boundary : maxLength).trim()}...`;
}

function dedupeText(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const clean = normalizeText(value);
    if (!clean) continue;
    const key = sentenceKey(clean);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(clean);
  }
  return result;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function visualHashForCapture(capture) {
  const hash = capture?.file_hash || capture?.main_content_hash || capture?.image_hash || capture?.text_hash || "";
  return hash ? `visual:${hash}` : "";
}

function visualHashForBaseline(baseline) {
  const hash = baseline?.file_hash || baseline?.main_content_hash || baseline?.image_hash || baseline?.text_hash || "";
  return hash ? `visual:${hash}` : "";
}

function baselineHasFacts(baseline) {
  return Boolean(
    baseline?.summary_metadata?.baseline_facts &&
      baseline.summary_metadata.baseline_facts_metadata?.status !== "failed",
  );
}

function nextVisualSourceCheckDate() {
  return new Date(Date.now() + visualSourceCheckMinutes * 60 * 1000).toISOString();
}

function escapeLike(value) {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function loadSourceIdsFilter(value) {
  if (!value) return new Set();
  const path = isAbsolute(value) ? value : resolve(root, value);
  if (!existsSync(path)) throw new Error(`Source IDs file does not exist: ${path}`);
  const raw = readFileSync(path, "utf8").trim();
  if (!raw) return new Set();
  try {
    const parsed = JSON.parse(raw);
    const values = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.repair_source_ids)
        ? parsed.repair_source_ids
        : Array.isArray(parsed?.source_ids)
          ? parsed.source_ids
          : [];
    return new Set(values.map(cleanText).filter(Boolean));
  } catch {
    return new Set(raw.split(/\r?\n|,/).map(cleanText).filter(Boolean));
  }
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const [rawKey, inlineValue] = value.slice(2).split("=");
    if (inlineValue !== undefined) {
      parsed[rawKey] = inlineValue;
    } else if (values[index + 1] && !values[index + 1].startsWith("--")) {
      parsed[rawKey] = values[index + 1];
      index += 1;
    } else {
      parsed[rawKey] = "true";
    }
  }
  return parsed;
}

async function runConcurrent(items, concurrency, task) {
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);
  const workers = Array.from({ length: workerCount }, async (_unused, workerIndex) => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      await task(items[index], index, workerIndex);
    }
  });

  await Promise.all(workers);
}

function loadEnvFile(path) {
  if (!existsSync(path)) return {};
  const values = {};
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equalsIndex = line.indexOf("=");
    if (equalsIndex === -1) continue;
    const key = line.slice(0, equalsIndex).trim();
    let value = line.slice(equalsIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function boolArg(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).toLowerCase();
  if (["true", "1", "yes", "y"].includes(normalized)) return true;
  if (["false", "0", "no", "n"].includes(normalized)) return false;
  return fallback;
}

function listArg(value, fallback = []) {
  if (value === undefined || value === null || value === "") return fallback;
  if (Array.isArray(value)) return value.map((item) => cleanText(item)).filter(Boolean);
  return String(value)
    .split(",")
    .map((item) => cleanText(item))
    .filter(Boolean);
}

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function nonNegativeInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

function nonNegativeNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function boundedInt(value, fallback, min, max) {
  const number = positiveInt(value, fallback);
  return Math.min(max, Math.max(min, number));
}

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

function withTimeout(promise, milliseconds, message) {
  let timeout = null;
  let timedOut = false;
  const guarded = promise
    .catch((error) => {
      if (timedOut) return null;
      throw error;
    })
    .finally(() => {
      if (timeout) clearTimeout(timeout);
    });

  return Promise.race([
    guarded,
    new Promise((_, reject) => {
      timeout = setTimeout(() => {
        timedOut = true;
        const error = new Error(message);
        error.code = "AWARDPING_SOURCE_TIMEOUT";
        reject(error);
      }, milliseconds);
    }),
  ]);
}

function errorMessage(error) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) return String(error.message);
  return String(error || "Unknown error");
}

function isSourceTimeoutError(error) {
  return error?.code === "AWARDPING_SOURCE_TIMEOUT";
}

function isBrowserClosedError(error) {
  const message = errorMessage(error).toLowerCase();
  return (
    message.includes("target page, context or browser has been closed") ||
    message.includes("browser context was closed") ||
    message.includes("browser has been closed") ||
    message.includes("context has been closed") ||
    message.includes("session closed") ||
    message.includes("other side closed") ||
    message.includes("target closed")
  );
}

const noiseKeywords = [
  "cookie",
  "consent",
  "gdpr",
  "privacy-banner",
  "popup",
  "modal",
  "newsletter",
  "subscribe",
  "intercom",
  "drift",
  "crisp",
  "chatbot",
  "chat",
  "advertisement",
  "ad-banner",
  "sponsor",
  "carousel",
  "slider",
  "swiper",
  "slick",
  "marquee",
  "social-share",
  "sharebar",
];

const stableCaptureCss = `
*,
*::before,
*::after {
  animation-delay: 0s !important;
  animation-duration: 0s !important;
  animation-iteration-count: 1 !important;
  scroll-behavior: auto !important;
  transition-delay: 0s !important;
  transition-duration: 0s !important;
  caret-color: transparent !important;
}
video,
audio,
canvas[data-live],
[aria-live="polite"],
[aria-live="assertive"] {
  animation: none !important;
}
[data-awardping-hidden-noise] {
  display: none !important;
  visibility: hidden !important;
}
`;

const aiSystemPrompt = [
  "You are judging official award webpage screenshot changes for scholarship advisors.",
  "Return valid strict JSON only. Do not include markdown.",
  "Compare the two attached screenshot thumbnails first when images are provided. For PDFs or image-free inputs, compare the extracted previous and new text carefully.",
  "Use normalized text as secondary context for screenshots because it can be incomplete or noisy.",
  "Mark is_true_change=true only when a visible screenshot change shows that a concrete award-relevant fact changed.",
  "Default to rejection when uncertain.",
  "True changes include deadline changes, application opening or closing changes, eligibility changes, award conditions, nomination or recommendation changes, application materials, document/PDF/guideline changes, funding/stipend/tuition/award amount changes, contact changes, official cycle status changes, or application instruction changes.",
  "Reject cookie banners, carousels, ads, donation forms, fundraising widgets, checkout/cart changes, newsletter popups, current-date or last-updated-only changes, animated or count-up statistic counters, KPI or impact-number widgets, font/reflow/lazy-image changes, nav/footer/sidebar changes, social/share widgets, event/news/listing churn, featured-fellow/alumni/profile roster rotations, recipient-news churn, staff/job content, unrelated research/news pages, and unrelated page widgets unless award requirements changed.",
  ...monitoringPolicyPromptLinesForScope("visual_snapshot_ai"),
  "Also reject sitewide notices, holiday or operating-hours banners, countdown timers, view counts, post IDs, writer IDs, CAPTCHA/math changes, navigation or FAQ reordering, generic Latest Updates blocks, calendar/conference/admissions-event churn, stale archive pages, and document hash/file-size-only changes unless specific award-relevant text changed.",
  "Do not treat page redesign, image changes, popups, navigation, staff/profile/fellow/news rotations, or file metadata as applicant-facing changes.",
  "Never use facts from sibling awards or broad search/listing pages.",
  "source_relevance must be primary or supporting to approve. Use unrelated or unclear and reject when the page is a sibling award, broad listing/search page, stale archive, or not clearly about this exact award.",
  "changed_facts must list the exact applicant-facing facts that changed. exact_before and exact_after must be exact strings from deterministic diff evidence, or null only when the change is one-sided and the other side is genuinely absent.",
  "Do not describe text as added if that same wording is already present in the previous capture. Do not describe text as removed if that same wording is still present in the new capture.",
  "For structured_diff, added_text must be exact wording present in the new capture and absent from the previous capture; removed_text must be exact wording present in the previous capture and absent from the new capture.",
  "Do not infer relevance just because words like award, fellowship, grant, application, or deadline appear in unrelated content.",
  "reader_summary should be one or two sentences, plain English, advisor-facing.",
  "advisor_impact should say what an advising office might need to check or update.",
  "If confidence is low, set is_true_change=false unless the changed award fact is explicit.",
  "Required keys: is_true_change, is_alert_worthy, source_relevance, source_relevance_reason, changed_facts, exact_before, exact_after, evidence_location, noise_reason, reader_summary, advisor_impact, changed_section, confidence, noise_flags, rejection_reason.",
  "Use null for unavailable noise_reason, reader_summary, advisor_impact, or changed_section.",
  "confidence must be low, medium, or high.",
].join(" ");

const baselineFactsSystemPrompt = [
  "You are extracting a clean source-page outline for AwardPing scholarship advisors.",
  "Return valid strict JSON only. Do not include markdown.",
  "Every source page needs a readable display_title and a short page_description, even if the page is only a contact page, FAQ page, PDF, portal page, news page, or unclear/unrelated page.",
  "Extract only facts that are visible or directly supported by the screenshot, PDF text, or normalized page text.",
  "Classify whether the page is truly about the named program and whether it supports the current/upcoming application cycle, an active evergreen cycle, an archived/past cycle, an unclear cycle, or no program page at all.",
  "Default to rejection when uncertain. Missing award_relevance or cycle_relevance means unclear.",
  "Evidence_quotes must be exact short strings copied from the source that support relevance, cycle, and extracted facts.",
  "Never use facts from sibling awards or broad search/listing pages.",
  "Do not guess missing dates, amounts, eligibility, or requirements.",
  "Descriptions should be concise and useful in a page outline.",
].join(" ");

const aiResponseSchema = {
  type: "object",
  properties: {
    is_true_change: { type: "boolean" },
    is_alert_worthy: { type: "boolean" },
    source_relevance: { type: "string", enum: ["primary", "supporting", "unclear", "unrelated"] },
    source_relevance_reason: { type: "string", nullable: true },
    changed_facts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          fact: { type: "string" },
          before: { type: "string", nullable: true },
          after: { type: "string", nullable: true },
          added_text: { type: "string", nullable: true },
          removed_text: { type: "string", nullable: true },
          visual_evidence: { type: "string", nullable: true },
        },
      },
    },
    exact_before: { type: "string", nullable: true },
    exact_after: { type: "string", nullable: true },
    evidence_location: { type: "string", nullable: true },
    noise_reason: { type: "string", nullable: true },
    reader_summary: { type: "string", nullable: true },
    advisor_impact: { type: "string", nullable: true },
    changed_section: { type: "string", nullable: true },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    noise_flags: { type: "array", items: { type: "string" } },
    rejection_reason: { type: "string", nullable: true },
    before: { type: "string", nullable: true },
    after: { type: "string", nullable: true },
    change_type: { type: "string", nullable: true },
    structured_diff: {
      type: "object",
      nullable: true,
      properties: {
        added_text: { type: "array", items: { type: "string" } },
        removed_text: { type: "array", items: { type: "string" } },
        date_changes: { type: "array", items: { type: "string" } },
        amount_changes: { type: "array", items: { type: "string" } },
        noise_flags: { type: "array", items: { type: "string" } },
        likely_section: { type: "string", nullable: true },
        page_type: { type: "string", nullable: true },
      },
    },
    quality_flags: { type: "array", items: { type: "string" } },
    updated_baseline_facts: { type: "object", nullable: true },
  },
  required: [
    "is_true_change",
    "is_alert_worthy",
    "source_relevance",
    "source_relevance_reason",
    "changed_facts",
    "exact_before",
    "exact_after",
    "evidence_location",
    "noise_reason",
    "reader_summary",
    "advisor_impact",
    "changed_section",
    "confidence",
    "noise_flags",
    "rejection_reason",
  ],
};

const baselineFactsResponseSchema = {
  type: "object",
  properties: {
    status: { type: "string" },
    display_title: { type: "string" },
    page_description: { type: "string" },
    page_category: { type: "string" },
    award_name: { type: "string", nullable: true },
    award_name_seen: { type: "boolean", nullable: true },
    page_purpose: { type: "string", nullable: true },
    award_relevance: { type: "string", enum: ["primary", "supporting", "unclear", "unrelated"] },
    cycle_relevance: {
      type: "string",
      enum: ["current_or_upcoming", "evergreen", "archived_or_past", "unclear", "not_program_page"],
    },
    cycle_relevance_reason: { type: "string", nullable: true },
    application_cycle: { type: "string", nullable: true },
    deadline: { type: "string", nullable: true },
    opening_date: { type: "string", nullable: true },
    award_amounts: { type: "array", items: { type: "string" } },
    eligibility: { type: "array", items: { type: "string" } },
    requirements: { type: "array", items: { type: "string" } },
    application_materials: { type: "array", items: { type: "string" } },
    how_to_apply: { type: "array", items: { type: "string" } },
    important_dates: { type: "array", items: { type: "string" } },
    documents: { type: "array", items: { type: "string" } },
    contacts: { type: "array", items: { type: "string" } },
    notes: { type: "array", items: { type: "string" } },
    sections: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          status: { type: "string", enum: ["unchanged", "needs_review", "new", "changed", "removed"] },
        },
        required: ["title", "description", "status"],
      },
    },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    evidence_quotes: { type: "array", items: { type: "string" } },
    quality_flags: { type: "array", items: { type: "string" } },
    rejection_reason: { type: "string", nullable: true },
  },
  required: [
    "status",
    "display_title",
    "page_description",
    "page_category",
    "award_name",
    "award_name_seen",
    "page_purpose",
    "award_relevance",
    "cycle_relevance",
    "cycle_relevance_reason",
    "application_cycle",
    "deadline",
    "opening_date",
    "award_amounts",
    "eligibility",
    "requirements",
    "application_materials",
    "how_to_apply",
    "important_dates",
    "documents",
    "contacts",
    "notes",
    "sections",
    "confidence",
    "evidence_quotes",
    "quality_flags",
    "rejection_reason",
  ],
};

if (continuous) {
  while (true) {
    await runOnce().catch((error) => {
      console.error(errorMessage(error));
    });
    console.log(`Sleeping ${intervalMinutes} minutes before the next visual snapshot run.`);
    await sleep(intervalMinutes * 60 * 1000);
  }
} else {
  try {
    await runOnce();
    process.exit(0);
  } catch (error) {
    console.error(errorMessage(error));
    process.exit(1);
  }
}
