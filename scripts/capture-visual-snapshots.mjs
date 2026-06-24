#!/usr/bin/env node
import crypto from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { PDFParse } from "pdf-parse";
import { chromium } from "playwright-core";
import { runGeminiCliJsonAnalysis } from "./lib/gemini-cli-analysis.mjs";
import { createSupabaseServiceClient } from "./supabase-service-client.mjs";

const root = resolve(import.meta.dirname, "..");
const defaultArchiveRoot = "D:\\AwardPingVisualSnapshots";
const sentenceDotPlaceholder = "__AP_SENTENCE_DOT__";
const promptChars = 12_000;
const captureBehaviorVersion = 2;
const captureBehaviorName = "expand-details-without-summary-toggle";
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
const brokenSourcesDir = join(archiveRoot, "broken-sources");
const brokenSourcesCurrentPath = join(brokenSourcesDir, "broken-sources-current.json");
const brokenSourcesJsonlPath = join(brokenSourcesDir, "broken-sources-events.jsonl");
const brokenSourcesCsvPath = join(brokenSourcesDir, "broken-sources-current.csv");
const limit = positiveInt(args.limit, 25);
const includeNotDue = boolArg(args.all, false) || boolArg(args["include-not-due"], false);
const sourceIdFilter = cleanText(args["source-id"]);
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
const reviewOnAiFailure = boolArg(args["review-on-ai-failure"], true);
const requestedAiProvider = String(args["ai-provider"] || env.AI_PROVIDER || "auto").toLowerCase();
const defaultGeminiCliPath = env.LOCALAPPDATA
  ? join(env.LOCALAPPDATA, "agy", "bin", "agy.exe")
  : "agy";
const geminiCliPath = cleanText(
  args["gemini-cli-path"] || env.AWARDPING_GEMINI_CLI_PATH || env.GEMINI_CLI_PATH || defaultGeminiCliPath,
);
const geminiCliModel = cleanText(
  args["gemini-cli-model"] || env.AWARDPING_GEMINI_CLI_MODEL || "Gemini 3.5 Flash (Low)",
);
const geminiCliWorkspaceRoot = resolve(
  String(args["gemini-cli-workspace"] || env.AWARDPING_GEMINI_CLI_WORKSPACE || join(archiveRoot, "gemini-cli-workspace")),
);
const geminiCliTimeoutMs = positiveInt(args["gemini-cli-timeout-ms"] || env.AWARDPING_GEMINI_CLI_TIMEOUT_MS, 120_000);
const geminiCliMaxCalls = nonNegativeInt(args["gemini-cli-max-calls"] || env.AWARDPING_GEMINI_CLI_MAX_CALLS, 100);
const geminiCliSafeModels = listArg(
  args["gemini-cli-safe-models"] || env.AWARDPING_SAFE_GEMINI_CLI_MODELS,
  ["Gemini 3.5 Flash (Low)"],
);
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
  10,
);
const geminiApiPricingMode = cleanSlug(
  args["gemini-api-pricing-mode"] || env.AWARDPING_GEMINI_API_PRICING_MODE || "standard",
) || "standard";
const extractBaselineInfo = boolArg(args["extract-baseline-info"] ?? env.AWARDPING_EXTRACT_BASELINE_INFO, true);
const backfillBaselineInfo = boolArg(args["backfill-baseline-info"] ?? env.AWARDPING_BACKFILL_BASELINE_INFO, false);
const viewportWidth = positiveInt(args["viewport-width"], 1365);
const viewportHeight = positiveInt(args["viewport-height"], 1600);
const jpegQuality = boundedInt(args["jpeg-quality"], 72, 30, 95);
const thumbWidth = positiveInt(args["thumb-width"], 900);
const timeoutMs = positiveInt(args["timeout-ms"], 60_000);
const sourceTimeoutMs = positiveInt(args["source-timeout-ms"], Math.max(timeoutMs + 30_000, 90_000));
const pageReadyTimeoutMs = positiveInt(args["page-ready-timeout-ms"] || env.AWARDPING_PAGE_READY_TIMEOUT_MS, 15_000);
const delayMs = nonNegativeInt(args["delay-ms"], 0);
const domainDelayMs = Math.max(1_500, nonNegativeInt(args["domain-delay-ms"], 1_500));
const heartbeatMinutes = positiveInt(args["heartbeat-minutes"] || env.AWARDPING_WORKER_HEARTBEAT_MINUTES, 5);
const maxSourcesPerBrowser = positiveInt(args["max-sources-per-browser"], 250);
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
  r2BackfillBaselines,
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
const aiProvider = selectAiProvider(requestedAiProvider, {
  gemini: env.GEMINI_API_KEY,
  openai: env.OPENAI_API_KEY,
  geminiCli: geminiCliPath,
});
const aiModel = modelForProvider(aiProvider);
let supabase = null;
let r2Client = null;
const hostLastFetchAt = new Map();
const hostWaitQueues = new Map();
let existingR2SnapshotSourceIds = new Set();
let knownBrokenSourceIds = null;
let lastBaselineCoverageProgressUpdateAt = 0;
let lastBaselineCoverageProgressProcessed = 0;
const r2SnapshotSlots = [
  { name: "page", fileName: "page.jpg", contentType: "image/jpeg" },
  { name: "thumb", fileName: "thumb.jpg", contentType: "image/jpeg" },
  { name: "pdf", fileName: "document.pdf", contentType: "application/pdf" },
  { name: "text", fileName: "text.txt", contentType: "text/plain; charset=utf-8" },
  { name: "meta", fileName: "meta.json", contentType: "application/json; charset=utf-8" },
];
const crawlerUserAgent =
  cleanText(args["crawler-user-agent"] || env.AWARDPING_CRAWLER_USER_AGENT) ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

if (!supabaseUrl || !serviceRoleKey) {
  console.error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  process.exit(1);
}

if (!aiProvider) {
  console.error(missingAiMessage(requestedAiProvider));
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
  ensureArchiveDirectories();

  const startedAt = new Date().toISOString();
  const runStamp = timestampForPath(startedAt);
  const reportPath = join(root, "reports", `visual-snapshot-run-${runStamp}.json`);
  const report = {
    archive_root: archiveRoot,
    started_at: startedAt,
    finished_at: null,
    status: "running",
    ai_provider: aiProvider,
    ai_model: aiModel,
    env_path: envPath,
    options: {
      limit,
      include_not_due: includeNotDue,
      source_id: sourceIdFilter || null,
      source_url: sourceUrlFilter || null,
      award: awardFilter || null,
      baseline_refresh: baselineRefresh,
      promote,
      pdf_only: pdfOnly,
      web_only: webOnly,
      complete_missing_baselines: completeMissingBaselines,
      complete_missing_batch_limit: completeMissingBatchLimit || null,
      prioritize_missing_baselines: prioritizeMissingBaselines,
      prioritize_issue_sources: prioritizeIssueSources,
      skip_existing_baseline: skipExistingBaseline,
      keep_unchanged: keepUnchanged,
      keep_rejected: keepRejected,
      review_on_ai_failure: reviewOnAiFailure,
      viewport_width: viewportWidth,
      viewport_height: viewportHeight,
      jpeg_quality: jpegQuality,
      thumb_width: thumbWidth,
      timeout_ms: timeoutMs,
      page_ready_timeout_ms: pageReadyTimeoutMs,
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
      r2_bucket: r2SnapshotSync ? r2Bucket : null,
      gemini_cli_path: aiProvider === "gemini-cli" ? geminiCliPath : null,
      gemini_cli_model: aiProvider === "gemini-cli" ? geminiCliModel : null,
      gemini_cli_safe_models: aiProvider === "gemini-cli" ? geminiCliSafeModels : [],
      allow_unsafe_gemini_cli_model: allowUnsafeGeminiCliModel,
      gemini_cli_max_calls: geminiCliMaxCalls || null,
      gemini_api_max_calls: aiProvider === "gemini" ? geminiApiMaxCalls || null : null,
      gemini_api_daily_cost_cap_usd: aiProvider === "gemini" ? geminiApiDailyCostCapUsd : null,
      gemini_api_pricing_mode: aiProvider === "gemini" ? geminiApiPricingMode : null,
      extract_baseline_info: extractBaselineInfo,
      backfill_baseline_info: backfillBaselineInfo,
    },
    checked: 0,
    baselined: 0,
    unchanged: 0,
    candidate_changes: 0,
    ai_true_changes: 0,
    ai_rejected: 0,
    text_only_ignored: 0,
    deterministic_noise: 0,
    visual_noise: 0,
    review: 0,
    skipped_existing_baseline: 0,
    skipped_pdf: 0,
    capture_behavior_refreshed: 0,
    blocked_page_captures: 0,
    page_ready_waits: 0,
    page_ready_timeouts: 0,
    page_ready_wait_ms: 0,
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
    expanded_controls: 0,
    discovered_pdf_candidates: 0,
    discovered_pdf_sources: 0,
    r2_uploaded: 0,
    r2_rotated: 0,
    r2_failed: 0,
    r2_skipped_existing: 0,
    r2_repaired_missing: 0,
    r2_known_existing: 0,
    r2_known_missing: 0,
    baseline_facts_extracted: 0,
    baseline_facts_failed: 0,
    baseline_facts_skipped: 0,
    baseline_facts_backfilled: 0,
    visual_interpreted: 0,
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
    saved_change_paths: [],
    review_paths: [],
    rejected_paths: [],
  };

  const heartbeat = startRunHeartbeat(report);
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
    workerRunId = await startWorkerRun(report);
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
      sources = missingTargets.filter((source) => !isKnownBrokenSource(source));
      const totalMissingTargets = missingTargets.length;
      const knownBrokenMissingTargets = totalMissingTargets - sources.length;
      if (completeMissingBatchLimit && sources.length > completeMissingBatchLimit) {
        sources = sources.slice(0, completeMissingBatchLimit);
      }
      report.baseline_completion = {
        total_missing_targets: totalMissingTargets,
        actionable_missing_targets: totalMissingTargets - knownBrokenMissingTargets,
        known_broken_missing_targets: knownBrokenMissingTargets,
        batch_targets: sources.length,
        batch_limit: completeMissingBatchLimit || null,
      };
      console.log(
        `BASELINE_COMPLETION targets=${sources.length} total_missing_targets=${totalMissingTargets} actionable_missing_targets=${totalMissingTargets - knownBrokenMissingTargets} known_broken_missing_targets=${knownBrokenMissingTargets} batch_limit=${completeMissingBatchLimit || "all"}`,
      );
    }

    report.issue_sources_loaded = sources.filter(hasOpenSourceIssue).length;
    if (report.issue_sources_loaded > 0) {
      console.log(`ISSUE_REPAIR_QUEUE loaded=${report.issue_sources_loaded} total_sources=${sources.length}`);
    }
    await updateWorkerRunMetadata(workerRunId, report);

    if (visualWebConcurrency > 1) {
      console.log(`WEB_CONCURRENCY workers=${visualWebConcurrency} domain_delay_ms=${domainDelayMs}`);
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
    report.finished_at = new Date().toISOString();
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
    console.log(`REPORT ${reportPath}`);
  }
}

function startRunHeartbeat(report) {
  const intervalMs = heartbeatMinutes * 60 * 1000;
  const startedAtMs = Date.now();
  const timer = setInterval(() => {
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
  const baseline = readJsonIfExists(baselinePathForSource(source.id));
  const capture = captureFromBaseline(baseline);
  if (!capture) {
    report.failed += 1;
    const message = "Baseline exists but could not be loaded for R2 backfill.";
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
  const pdfSource = isPdfSource(source);
  const capture = pdfSource
    ? await capturePdfSource(source)
    : await captureSource(source, context, browserMeta, report);
  report.checked += 1;
  if (capture.kind === "pdf") {
    report.pdf_checked += 1;
  }

  const baselinePath = baselinePathForSource(source.id);
  const baseline = readJsonIfExists(baselinePath);

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
    await maybeSyncR2Snapshot(source, capture, report);
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
    await maybeSyncR2Snapshot(source, capture, report);
    await markSharedSourceVisualCheckSucceeded(source, capture, report);
    console.log(
      `BASELINE capture_behavior_refresh from=${baseline.capture_behavior_version || 0} to=${captureBehaviorVersion} ${sourceLabel(source)}`,
    );
    return;
  }

  const previous = readBaselineEvidence(baseline);
  if (!previous.ok) {
    throw new Error(
      `Baseline exists but evidence is missing (${previous.missing.join(", ")}). Rerun with --baseline-refresh=true after confirming the source.`,
    );
  }

  if (capture.kind === "pdf" || previous.kind === "pdf") {
    await processPdfComparison(source, baseline, previous, capture, report);
    return;
  }

  const screenshotChanged = capture.image_hash !== baseline.image_hash;
  const textChanged = capture.text_hash !== baseline.text_hash;

  if (!screenshotChanged) {
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
        await maybeSyncR2Snapshot(source, capture, report);
      }
    }
    await maybeRepairMissingR2Snapshot(source, capture, report);
    await markSharedSourceVisualCheckSucceeded(source, capture, report);
    if (textChanged) {
      report.text_only_ignored += 1;
      console.log(`UNCHANGED screenshot_match_text_diff_ignored ${sourceLabel(source)}`);
    } else {
      console.log(`UNCHANGED ${sourceLabel(source)}`);
    }
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
  if (!deterministic.candidate_change) {
    report.deterministic_noise += 1;
    await markSharedSourceVisualCheckSucceeded(source, capture, report);
    if (!keepUnchanged) removeGeneratedCaptureDir(capture.dir);
    console.log(`NOISE deterministic ${deterministic.reason || "local_diff_rejected"} ${sourceLabel(source)}`);
    return;
  }

  await reviewAndApplyCandidateChange({
    source,
    baseline,
    previous,
    capture,
    diff,
    deterministic,
    report,
  });
}

async function reviewAndApplyCandidateChange({
  source,
  baseline,
  previous,
  capture,
  diff,
  deterministic,
  report,
}) {
  const aiReview = await reviewCandidateWithAi({
    source,
    baseline,
    previous,
    capture,
    diff,
    deterministic,
    report,
  }).catch((error) => ({
    ok: false,
    error: errorMessage(error),
    provider: aiProvider,
    model: aiModel,
    usage: error.aiUsage || error.geminiCliUsage || null,
    raw_text: error.geminiCliRawText || null,
  }));

  recordAiReviewUsage(report, source, capture, aiReview);

  if (!aiReview.ok) {
    if (reviewOnAiFailure) {
      const reviewPath = saveReviewRecord({
        source,
        baseline,
        previous,
        capture,
        diff,
        deterministic,
        reason: `ai_failure: ${aiReview.error}`,
        aiReview,
      });
      report.review += 1;
      report.review_paths.push(toArchiveRelative(reviewPath));
      await markSharedSourceVisualCheckSucceeded(source, capture, report);
      console.log(`REVIEW ai_failure ${sourceLabel(source)}`);
    } else {
      await markSharedSourceVisualCheckSucceeded(source, capture, report);
      if (!keepUnchanged) removeGeneratedCaptureDir(capture.dir);
    }
    return;
  }

  report.visual_interpreted += 1;

  if (aiReview.result.updated_baseline_facts) {
    attachBaselineFactsToCapture(capture, aiReview.result.updated_baseline_facts, {
      reason: "change_interpretation",
      provider: aiReview.provider,
      model: aiReview.model,
      analysis_path: aiReview.analysis_path || null,
    });
  }

  if (aiReview.result.confidence === "low") {
    const reviewPath = saveReviewRecord({
      source,
      baseline,
      previous,
      capture,
      diff,
      deterministic,
      reason: "low_confidence",
      aiReview,
    });
    report.review += 1;
    report.review_paths.push(toArchiveRelative(reviewPath));
    await markSharedSourceVisualCheckSucceeded(source, capture, report);
    console.log(`REVIEW low_confidence ${sourceLabel(source)}`);
    return;
  }

  if (aiReview.result.is_true_change) {
    const changePath = saveTrueChange({
      source,
      baseline,
      previous,
      capture,
      diff,
      deterministic,
      aiReview,
    });
    report.ai_true_changes += 1;
    report.saved_change_paths.push(toArchiveRelative(changePath));

    await publishVisualChangeEvent({
      source,
      baseline,
      capture,
      aiReview,
      report,
    });

    if (promote) {
      writeBaseline(source, capture, {
        reason: "ai_approved_true_change",
        previous_baseline_capture: baseline.capture || null,
        baseline_facts: capture.baseline_facts || null,
        baseline_facts_metadata: capture.baseline_facts_metadata || null,
      });
      report.promoted += 1;
      await maybeSyncR2Snapshot(source, capture, report);
    }

    await markSharedSourceVisualCheckSucceeded(source, capture, report);
    console.log(`AI TRUE ${aiReview.result.reader_summary || sourceLabel(source)}`);
    return;
  }

  report.ai_rejected += 1;
  await markSharedSourceVisualCheckSucceeded(source, capture, report);
  if (keepRejected) {
    const rejectedPath = saveRejectedRecord({
      source,
      baseline,
      previous,
      capture,
      diff,
      deterministic,
      aiReview,
    });
    report.rejected_paths.push(toArchiveRelative(rejectedPath));
  } else if (!keepUnchanged) {
    removeGeneratedCaptureDir(capture.dir);
  }
  console.log(`AI REJECTED ${aiReview.result.noise_reason || "not award-relevant"} ${sourceLabel(source)}`);
}

async function processPdfComparison(source, baseline, previous, capture, report) {
  const previousHash = baseline.file_hash || baseline.image_hash;
  const fileChanged = capture.file_hash !== previousHash;
  const textChanged = capture.text_hash !== baseline.text_hash;

  if (!fileChanged) {
    report.unchanged += 1;
    report.pdf_unchanged += 1;
    await maybeRepairMissingR2Snapshot(source, capture, report);
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

  if (["gemini-cli", "gemini", "openai"].includes(aiProvider)) {
    await reviewAndApplyCandidateChange({
      source,
      baseline,
      previous,
      capture,
      diff,
      deterministic,
      report,
    });
    return;
  }

  const reviewPath = saveReviewRecord({
    source,
    baseline,
    previous,
    capture,
    diff,
    deterministic,
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
    await maybeSyncR2Snapshot(source, capture, report);
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

async function captureSource(source, context, browserMeta, report) {
  const capturedAt = new Date().toISOString();
  const captureStamp = timestampForPath(capturedAt);
  const sourceDir = join(archiveRoot, "sources", source.id);
  const captureDir = join(sourceDir, "captures", captureStamp);
  mkdirSync(captureDir, { recursive: true });

  const pagePath = join(captureDir, "page.jpg");
  const thumbPath = join(captureDir, "thumb.jpg");
  const textPath = join(captureDir, "text.txt");
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
    const hiddenNoise = await hideNoiseElements(page);
    const expanded = await expandPageForSnapshot(page);
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
    await page.waitForTimeout(250).catch(() => null);
    const discoveredPdfLinks = await discoverPdfLinksOnPage(page, source);
    await maybeRecordDiscoveredPdfSources(source, discoveredPdfLinks, expanded, report);

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
    const text = normalizeVisibleText(rawText);
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
    const textHash = hashText(text);
    const pageBuffer = await page.screenshot({
      path: pagePath,
      fullPage: true,
      type: "jpeg",
      quality: jpegQuality,
      timeout: timeoutMs,
    });
    const imageHash = hashBuffer(pageBuffer);
    const thumbnail = await createThumbnail(context, pageBuffer);
    writeFileSync(thumbPath, thumbnail);
    writeFileSync(textPath, `${text}\n`, "utf8");

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
      text_hash: textHash,
      image_hash: imageHash,
      text_length: text.length,
      page_bytes: pageBuffer.length,
      thumb_bytes: thumbnail.length,
      dimensions,
      browser: browserMeta,
      hidden_noise_counts: hiddenNoise,
      page_readiness: pageReadiness,
      expanded_content: expanded,
      discovered_pdf_links: discoveredPdfLinks.slice(0, 20),
      files: {
        page: toArchiveRelative(pagePath),
        thumb: toArchiveRelative(thumbPath),
        text: toArchiveRelative(textPath),
        meta: toArchiveRelative(metaPath),
      },
    };

    writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf8");

    return {
      ...meta,
      dir: captureDir,
      page_path: pagePath,
      thumb_path: thumbPath,
      text_path: textPath,
      meta_path: metaPath,
      text,
    };
  } finally {
    await page.close().catch(() => null);
  }
}

async function expandPageForSnapshot(page) {
  try {
    const result = await page.evaluate(async () => {
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

        const contentRelevant =
          /\b(faq|question|answer|expand|show|more|details|eligib|requirement|application|apply|deadline|guideline|instruction|document|pdf|form|award|grant|materials?)\b/i.test(signal);

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
    });
    await page.waitForTimeout(350).catch(() => null);
    return result;
  } catch (error) {
    return {
      details_opened: 0,
      controls_clicked: 0,
      panels_forced_open: 0,
      passes: 0,
      error: errorMessage(error),
    };
  }
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

    if (!pdfUrl && !pdfText && !documentSignal) continue;
    if (!isRelevantDiscoveredPdfLink(link, url, source)) continue;
    seen.add(url);
    candidates.push({
      url,
      title: readablePdfLinkTitle(link, source),
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

async function maybeRecordDiscoveredPdfSources(source, pdfLinks, expanded, report) {
  if (!pdfLinks.length) return;
  if (report) report.discovered_pdf_candidates += pdfLinks.length;

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
  const rows = pdfLinks
    .filter((link) => !existingUrls.has(link.url))
    .map((link) => ({
      shared_award_id: source.shared_award_id,
      url: link.url,
      title: link.title,
      page_type: "pdf",
      confidence: 0.8,
      reason: [
        "Found by the visual snapshot worker after expanding page content.",
        `Parent source: ${source.url}`,
        `Signal: ${link.reason}`,
        expanded?.controls_clicked ? `Expanded controls: ${expanded.controls_clicked}` : null,
      ]
        .filter(Boolean)
        .join(" "),
      source: "seed",
      next_check_at: new Date().toISOString(),
    }));

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

  const inserted = data?.length || rows.length;
  if (report) report.discovered_pdf_sources += inserted;
  console.log(`DISCOVERED PDF SOURCES inserted=${inserted} parent=${sourceLabel(source)}`);
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

async function maybeSyncR2Snapshot(source, capture, report) {
  if (!r2SnapshotSync) return;

  try {
    const result = await syncR2SnapshotPair(source, capture);
    report.r2_uploaded += result.uploaded;
    report.r2_rotated += result.rotated;
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

async function maybeRepairMissingR2Snapshot(source, capture, report) {
  if (!r2SnapshotSync || !r2RepairMissingSnapshots) return false;
  if (existingR2SnapshotSourceIds.has(source.id)) return false;

  const repaired = await maybeSyncR2Snapshot(source, capture, report);
  if (repaired) {
    report.r2_repaired_missing += 1;
    console.log(`R2 REPAIRED missing_snapshot ${sourceLabel(source)}`);
  }
  return repaired;
}

async function publishVisualChangeEvent({ source, baseline, capture, aiReview, report }) {
  const detectedAt = new Date().toISOString();

  try {
    const changeDetails = aiReview.result.change_details || visualChangeDetailsFromReview({
      source,
      diff: {},
      aiReview,
    });
    const { data, error } = await supabase
      .from("shared_award_change_events")
      .upsert(
        {
          shared_award_id: source.shared_award_id,
          shared_award_source_id: source.id,
          source_url: source.url,
          source_title: source.title || null,
          source_page_type: source.page_type || null,
          previous_snapshot_id: null,
          new_snapshot_id: null,
          previous_hash: visualHashForBaseline(baseline),
          new_hash: visualHashForCapture(capture),
          summary: aiReview.result.reader_summary || changeDetails.reader_summary,
          change_details: changeDetails,
          detected_at: detectedAt,
        },
        {
          onConflict: "shared_award_id,source_url,previous_hash,new_hash",
          ignoreDuplicates: true,
        },
      )
      .select("id")
      .maybeSingle();

    if (error) throw error;

    if (data?.id) {
      report.published_updates += 1;
      console.log(`PUBLISHED visual_update id=${data.id} ${sourceLabel(source)}`);
    } else {
      report.publish_duplicates += 1;
      console.log(`PUBLISHED duplicate_ignored ${sourceLabel(source)}`);
    }
  } catch (error) {
    report.publish_failed += 1;
    const message = `Visual change publish failed: ${errorMessage(error)}`;
    report.errors.push({
      source_id: source.id,
      source_url: source.url,
      message,
    });
    console.log(`PUBLISH FAILED ${message} ${sourceLabel(source)}`);
  }
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

async function markSharedSourceVisualCheckFailed(source, message) {
  const now = new Date().toISOString();
  const failures = nonNegativeInt(source.consecutive_failures, 0) + 1;
  const { error } = await supabase
    .from("shared_award_sources")
    .update({
      last_checked_at: now,
      next_check_at: nextVisualSourceCheckDate(),
      consecutive_failures: failures,
      last_error: truncate(message, 1000),
      updated_at: now,
    })
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
    return {
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
  const rotatedKeys = await rotateR2LatestToPrevious(client, source.id);
  const latestFiles = captureR2Files(capture);
  const latestKeys = await uploadR2CaptureFiles(client, source.id, latestFiles);
  await deleteR2LatestObjectsNotInCapture(client, source.id, latestKeys);

  const existingLatestKeys = jsonObjectOrEmpty(existingRecord?.latest_object_keys);
  const previousObjectKeys = Object.keys(rotatedKeys).length
    ? Object.keys(existingLatestKeys).length
      ? existingLatestKeys
      : rotatedKeys
    : {};
  const previousHashes = Object.keys(rotatedKeys).length
    ? jsonObjectOrEmpty(existingRecord?.latest_hashes)
    : {};
  const previousMetadata = Object.keys(rotatedKeys).length
    ? jsonObjectOrEmpty(existingRecord?.latest_metadata)
    : {};

  await upsertR2SnapshotRecord(source, capture, {
    latestKeys,
    previousObjectKeys,
    previousHashes,
    previousMetadata,
    previousCapturedAt: Object.keys(rotatedKeys).length
      ? existingRecord?.latest_captured_at || null
      : null,
  });

  return {
    uploaded: Object.keys(latestKeys).length,
    rotated: Object.keys(rotatedKeys).length,
  };
}

async function syncR2BackfillLatestOnly(source, capture) {
  const client = getR2Client();
  const latestFiles = captureR2Files(capture);
  const latestKeys = await uploadR2CaptureFiles(client, source.id, latestFiles);

  await upsertR2SnapshotRecord(source, capture, {
    latestKeys,
    previousObjectKeys: {},
    previousHashes: {},
    previousMetadata: {},
    previousCapturedAt: null,
  });

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
  const chunkSize = 500;

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
      "latest_captured_at, latest_object_keys, latest_hashes, latest_metadata",
    )
    .eq("shared_award_source_id", sourceId)
    .maybeSingle();

  if (error) throw new Error(describeSupabaseError(error, "load R2 visual snapshot record"));
  return data || null;
}

async function rotateR2LatestToPrevious(client, sourceId) {
  const rotatedKeys = {};

  for (const slot of r2SnapshotSlots) {
    const latestKey = r2SnapshotKey(sourceId, "latest", slot.fileName);
    const previousKey = r2SnapshotKey(sourceId, "previous", slot.fileName);

    if (await r2ObjectExists(client, latestKey)) {
      await sendR2Command(
        client,
        () => new CopyObjectCommand({
          Bucket: r2Bucket,
          CopySource: `${r2Bucket}/${latestKey}`,
          Key: previousKey,
          ContentType: slot.contentType,
          MetadataDirective: "COPY",
        }),
        `copy ${latestKey}`,
      );
      rotatedKeys[slot.name] = previousKey;
    } else {
      await deleteR2Object(client, previousKey);
    }
  }

  return rotatedKeys;
}

async function uploadR2CaptureFiles(client, sourceId, files) {
  const uploaded = await Promise.all(files.map(async (file) => {
    const key = r2SnapshotKey(sourceId, "latest", file.fileName);
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

async function deleteR2LatestObjectsNotInCapture(client, sourceId, latestKeys) {
  const activeFileNames = new Set(
    Object.values(latestKeys).map((key) => String(key).split("/").pop()),
  );

  for (const slot of r2SnapshotSlots) {
    if (activeFileNames.has(slot.fileName)) continue;
    await deleteR2Object(client, r2SnapshotKey(sourceId, "latest", slot.fileName));
  }
}

async function r2ObjectExists(client, key) {
  try {
    await sendR2Command(
      client,
      () => new HeadObjectCommand({
        Bucket: r2Bucket,
        Key: key,
      }),
      `head ${key}`,
    );
    return true;
  } catch (error) {
    if (isR2NotFoundError(error)) return false;
    throw error;
  }
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
  const { error } = await supabase
    .from("shared_award_source_visual_snapshots")
    .upsert(
      {
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
      },
      { onConflict: "shared_award_source_id" },
    );

  if (error) throw new Error(describeSupabaseError(error, "upsert R2 visual snapshot record"));
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
  addIfPresent("meta", "meta.json", capture.meta_path, "application/json; charset=utf-8");

  return files;
}

function r2CaptureHashes(capture) {
  return {
    image_hash: capture.image_hash || null,
    text_hash: capture.text_hash || null,
    file_hash: capture.file_hash || null,
  };
}

function r2CaptureMetadata(capture) {
  return {
    final_url: capture.final_url || null,
    page_title: capture.page_title || null,
    status_code: capture.status_code || null,
    status_text: capture.status_text || null,
    content_type: capture.content_type || null,
    text_length: capture.text_length || 0,
    file_bytes: capture.file_bytes || null,
    page_bytes: capture.page_bytes || null,
    thumb_bytes: capture.thumb_bytes || null,
    dimensions: capture.dimensions || null,
    page_count: capture.page_count || null,
    pdf_text_error: capture.pdf_text_error || null,
    baseline_facts: capture.baseline_facts || null,
    baseline_facts_metadata: capture.baseline_facts_metadata || null,
  };
}

function r2SnapshotKey(sourceId, version, fileName) {
  return `visual-snapshots/sources/${sourceId}/${version}/${fileName}`;
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
      return false;
    }

    function hide(element, reason) {
      if (!(element instanceof HTMLElement)) return;
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
  if (aiProvider === "gemini-cli") return reviewWithGeminiCli(input);
  if (aiProvider === "gemini") return reviewWithGemini(input);
  if (aiProvider === "openai") return reviewWithOpenAI(input);
  throw new Error("No AI provider is available.");
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
  ensureGeminiApiCallAvailable(input.report, "change_interpretation");
  const imageParts = geminiInlineImageParts([input.previous.thumbPath, input.capture.thumb_path]);
  const data = await generateGeminiContentJson({
    model: aiModel,
    requestBody: {
      systemInstruction: { parts: [{ text: aiSystemPrompt }] },
      contents: [
        {
          role: "user",
          parts: [
            { text: aiUserPrompt(input) },
            ...imageParts,
          ],
        },
      ],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 900,
        responseMimeType: "application/json",
        responseSchema: aiResponseSchema,
      },
    },
    requestTimeoutMs: timeoutMs,
    report: input.report,
    kind: "change_interpretation",
  });
  const usage = normalizeGeminiUsage(data.usageMetadata);
  const rawText = extractGeminiText(data);
  let result = null;
  try {
    result = normalizeAiReview(rawText, {
      source: input.source,
      diff: input.diff,
      provider: "gemini",
      model: aiModel,
    });
  } catch (error) {
    error.aiUsage = usage;
    throw error;
  }

  return {
    ok: true,
    provider: "gemini",
    model: aiModel,
    usage,
    raw_text: rawText,
    result,
  };
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
  ensureGeminiApiCallAvailable(report, "baseline_facts");
  const data = await generateGeminiContentJson({
    model: aiModel,
    requestBody: {
      systemInstruction: { parts: [{ text: baselineFactsSystemPrompt }] },
      contents: [
        {
          role: "user",
          parts: [
            { text: geminiCliBaselineFactsPrompt(source, capture, reason) },
            ...geminiInlineImageParts(geminiCliBaselineFactFiles(capture)),
          ],
        },
      ],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 1100,
        responseMimeType: "application/json",
        responseSchema: baselineFactsResponseSchema,
      },
    },
    requestTimeoutMs: timeoutMs,
    report,
    kind: "baseline_facts",
  });
  const usage = normalizeGeminiUsage(data.usageMetadata);
  const rawText = extractGeminiText(data);
  let result = null;
  try {
    result = normalizeBaselineFacts(parseJsonObject(rawText) || rawText);
  } catch (error) {
    error.aiUsage = usage;
    throw error;
  }

  const analysis = {
    provider: "gemini",
    model: aiModel,
    usage,
    raw_text: rawText,
    result,
  };
  recordGeminiUsage(report, source, capture, analysis, "baseline_facts");
  return analysis;
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
    "{status, display_title, page_description, page_category, award_name, page_purpose, award_relevance, deadline, opening_date, award_amounts, eligibility, requirements, application_materials, how_to_apply, important_dates, documents, contacts, notes, sections, confidence, quality_flags}",
    "Use arrays for award_amounts, eligibility, requirements, application_materials, how_to_apply, important_dates, documents, contacts, notes, sections.",
    "sections should list 0 to 8 visible scholarship concepts or page areas with {title, description, status}. Use status unchanged for baseline sections.",
    "award_relevance must be primary, supporting, unclear, or unrelated. confidence must be low, medium, or high.",
    "Use null for unknown deadline/opening_date/page_purpose.",
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
    "{is_true_change, noise_reason, reader_summary, advisor_impact, changed_section, confidence, before, after, change_type, structured_diff, quality_flags, updated_baseline_facts}",
    "is_true_change must be true only for concrete award-relevant changes: deadlines, opening/closing dates, eligibility, requirements, nomination/recommendation instructions, documents/PDF/guidelines, award amount/funding, or application instructions.",
    "Reject cookie banners, carousels, ads, current-date-only changes, font/reflow/lazy-image changes, navigation/footer/sidebar changes, social widgets, recipient/news churn, unrelated research/news pages, and access/security/404 pages.",
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
  copyIfPresent("previous_meta", previous.metaPath, "previous-meta.json");
  copyIfPresent("new_meta", capture.meta_path, "new-meta.json");

  return Object.fromEntries(
    Object.entries(files).map(([key, value]) => [key, toArchiveRelative(value)]),
  );
}

function writeBaseline(source, capture, details) {
  const baselinePath = baselinePathForSource(source.id);
  mkdirSync(dirname(baselinePath), { recursive: true });
  const existingSummary = readJsonIfExists(baselinePath)?.summary_metadata || {};
  const baseline = {
    version: 1,
    kind: capture.kind || "webpage",
    capture_behavior_version: capture.kind === "pdf" ? null : captureBehaviorVersion,
    capture_behavior_name: capture.kind === "pdf" ? null : captureBehaviorName,
    source: sourceMetadata(source),
    captured_at: capture.captured_at,
    final_url: capture.final_url,
    page_title: capture.page_title,
    text_hash: capture.text_hash,
    image_hash: capture.image_hash,
    file_hash: capture.file_hash || null,
    file_bytes: capture.file_bytes || null,
    text_length: capture.text_length,
    dimensions: capture.dimensions,
    hidden_noise_counts: capture.hidden_noise_counts,
    capture: {
      dir: toArchiveRelative(capture.dir),
      page: capture.page_path ? toArchiveRelative(capture.page_path) : null,
      thumb: capture.thumb_path ? toArchiveRelative(capture.thumb_path) : null,
      pdf: capture.pdf_path ? toArchiveRelative(capture.pdf_path) : null,
      text: toArchiveRelative(capture.text_path),
      meta: toArchiveRelative(capture.meta_path),
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
    },
  };
  writeFileSync(baselinePath, JSON.stringify(baseline, null, 2), "utf8");
}

function readBaselineEvidence(baseline) {
  const capture = baseline.capture || {};
  const kind = baseline.kind || (capture.pdf ? "pdf" : "webpage");
  const paths = {
    pagePath: capture.page ? fromArchiveRelative(capture.page) : null,
    thumbPath: capture.thumb ? fromArchiveRelative(capture.thumb) : null,
    pdfPath: capture.pdf ? fromArchiveRelative(capture.pdf) : null,
    textPath: fromArchiveRelative(capture.text),
    metaPath: fromArchiveRelative(capture.meta),
  };
  const requiredPaths =
    kind === "pdf" ? [paths.pdfPath, paths.textPath, paths.metaPath] : [paths.pagePath, paths.thumbPath, paths.textPath, paths.metaPath];
  const missing = requiredPaths.filter((value) => !value || !existsSync(value));
  if (missing.length) return { ok: false, missing };

  return {
    ok: true,
    kind,
    ...paths,
    text: readFileSync(paths.textPath, "utf8"),
    meta: readJsonIfExists(paths.metaPath),
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
    page_path: evidence.pagePath,
    thumb_path: evidence.thumbPath,
    pdf_path: evidence.pdfPath,
    text_path: evidence.textPath,
    meta_path: evidence.metaPath,
    text: evidence.text,
    captured_at: baseline.captured_at || meta.captured_at || null,
    final_url: baseline.final_url || meta.final_url || null,
    page_title: baseline.page_title || meta.page_title || null,
    text_hash: baseline.text_hash || meta.text_hash || null,
    image_hash: baseline.image_hash || meta.image_hash || baseline.file_hash || null,
    file_hash: baseline.file_hash || meta.file_hash || null,
    file_bytes: baseline.file_bytes || meta.file_bytes || null,
    text_length: baseline.text_length || meta.text_length || 0,
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

async function loadSources(pageLimit) {
  const pageSize = Math.min(1_000, pageLimit);
  const sources = [];

  for (let from = 0; sources.length < pageLimit; from += pageSize) {
    const to = Math.min(from + pageSize - 1, pageLimit - 1);
    const { data, error } = await buildSourcesQuery().range(from, to);

    if (error) throw new Error(describeSupabaseError(error, "load shared award sources"));

    const page = data || [];
    sources.push(...page);

    if (page.length < to - from + 1) {
      break;
    }
  }

  return sources.slice(0, pageLimit);
}

function hasBaselineForSource(source) {
  return existsSync(baselinePathForSource(source.id));
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

function buildSourcesQuery() {
  let query = supabase
    .from("shared_award_sources")
    .select(
      "id, shared_award_id, url, title, display_title, page_description, page_metadata, page_metadata_generated_at, page_metadata_model, page_type, last_checked_at, next_check_at, consecutive_failures, last_error, created_at, shared_awards!inner(id, name, status)",
    )
    .eq("shared_awards.status", "active")
    .eq("admin_review_status", "open")
    .order("next_check_at", { ascending: true })
    .order("created_at", { ascending: true });

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
      discovered_count: report.discovered_pdf_sources,
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
      discovered_count: report.discovered_pdf_sources,
      failed_count: report.failed,
      metadata: visualWorkerMetadata(report),
    })
    .eq("id", runId);

  if (error && !isMissingMetadataColumnError(error)) {
    console.log(`WORKER RUN METADATA UPDATE FAILED | ${error.message}`);
  }
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
      discovered_count: report.discovered_pdf_sources,
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
  return {
    kind: "visual_snapshot",
    archive_root: report.archive_root,
    ai_model: report.ai_model,
    options: report.options,
    counts: {
      candidate_changes: report.candidate_changes,
      ai_true_changes: report.ai_true_changes,
      ai_rejected: report.ai_rejected,
      text_only_ignored: report.text_only_ignored,
      deterministic_noise: report.deterministic_noise,
      visual_noise: report.visual_noise,
      review: report.review,
      skipped_existing_baseline: report.skipped_existing_baseline,
      skipped_pdf: report.skipped_pdf,
      capture_behavior_refreshed: report.capture_behavior_refreshed,
      blocked_page_captures: report.blocked_page_captures,
      page_ready_waits: report.page_ready_waits,
      page_ready_timeouts: report.page_ready_timeouts,
      page_ready_wait_ms: report.page_ready_wait_ms,
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
      expanded_controls: report.expanded_controls,
      discovered_pdf_candidates: report.discovered_pdf_candidates,
      discovered_pdf_sources: report.discovered_pdf_sources,
      promoted: report.promoted,
      r2_uploaded: report.r2_uploaded,
      r2_rotated: report.r2_rotated,
      r2_failed: report.r2_failed,
      r2_skipped_existing: report.r2_skipped_existing,
      r2_repaired_missing: report.r2_repaired_missing,
      r2_known_existing: report.r2_known_existing,
      r2_known_missing: report.r2_known_missing,
      baseline_facts_extracted: report.baseline_facts_extracted,
      baseline_facts_failed: report.baseline_facts_failed,
      baseline_facts_skipped: report.baseline_facts_skipped,
      baseline_facts_backfilled: report.baseline_facts_backfilled,
      visual_interpreted: report.visual_interpreted,
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
    },
    paths: {
      saved_changes: report.saved_change_paths.slice(0, 20),
      review: report.review_paths.slice(0, 20),
      rejected: report.rejected_paths.slice(0, 20),
    },
    errors: report.errors.slice(0, 20),
  };
}

function visualWorkerName() {
  if (r2BackfillBaselines) return "local-visual-snapshot-worker-r2-backfill";
  if (completeMissingBaselines) return "local-visual-snapshot-worker-baseline-completion";
  if (baselineRefresh) return "local-visual-snapshot-worker-baseline-refresh";
  return "local-visual-snapshot-worker";
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
  if (statusCode) return `http_${statusCode}`;
  if (lower.includes("err_http_response_code_failure")) return "http_response_failure";
  if (lower.includes("timeout")) return "timeout";
  if (lower.includes("pdf download failed")) return "pdf_download_failed";
  if (lower.includes("net::err_name_not_resolved")) return "dns_error";
  if (lower.includes("net::err_connection")) return "connection_error";
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
  const estimatedCostUsd = estimateGeminiCostUsd(aiReview.model || aiModel, usage);
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
    pricing_mode: geminiApiPricingMode,
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
  const maxAttempts = 4;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model,
  )}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      const body = await response.text().catch(() => "");

      if (response.ok) {
        return JSON.parse(body);
      }

      const message = geminiHttpErrorMessage(response.status, body);
      if (attempt < maxAttempts && isRetryableGeminiApiFailure(response.status, body)) {
        const waitMs = 1_500 * attempt;
        console.log(`GEMINI_RETRY kind=${kind} attempt=${attempt}/${maxAttempts} wait_ms=${waitMs} message=${truncate(message, 240)}`);
        await sleep(waitMs);
        continue;
      }

      recordGeminiApiError(report, kind, response.status, body, message);
      throw new Error(message);
    } catch (error) {
      if (attempt < maxAttempts && isRetryableGeminiNetworkFailure(error)) {
        const waitMs = 1_500 * attempt;
        console.log(`GEMINI_RETRY kind=${kind} attempt=${attempt}/${maxAttempts} wait_ms=${waitMs} message=${truncate(errorMessage(error), 240)}`);
        await sleep(waitMs);
        continue;
      }
      throw error;
    }
  }

  throw new Error(`Gemini API failed after ${maxAttempts} attempts.`);
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
  if (geminiApiMaxCalls && report.gemini_usage.calls >= geminiApiMaxCalls) return false;
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
  throw new Error(
    `Gemini API cap reached before ${kind}. calls=${calls}/${geminiApiMaxCalls || "unlimited"} estimated_usd=${cost.toFixed(4)}/${geminiApiDailyCostCapUsd || "unlimited"}.`,
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
    page_purpose: cleanNullable(parsed.page_purpose),
    award_relevance: normalizeAwardRelevance(parsed.award_relevance || parsed.relevance),
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
    quality_flags: stringArray(parsed.quality_flags).map(cleanSlug).filter(Boolean).slice(0, 20),
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

function estimateGeminiCostUsd(model, usage) {
  const rates = geminiPricePerMillion(model);
  const inputTokens = usage.prompt_tokens || 0;
  const outputTokens = (usage.candidates_tokens || 0) + (usage.thoughts_tokens || 0);
  return roundUsd((inputTokens / 1_000_000) * rates.input + (outputTokens / 1_000_000) * rates.output);
}

function geminiPricePerMillion(model) {
  const name = String(model || "").toLowerCase();
  const batch = geminiApiPricingMode === "batch" || geminiApiPricingMode === "flex";
  if (name.includes("3.1-flash-lite")) {
    return batch ? { input: 0.125, output: 0.75 } : { input: 0.25, output: 1.5 };
  }
  if (name.includes("3-flash") || name.includes("3.1-flash")) {
    return batch ? { input: 0.25, output: 1.5 } : { input: 0.5, output: 3 };
  }
  if (name.includes("2.5-flash-lite")) {
    return batch ? { input: 0.05, output: 0.2 } : { input: 0.1, output: 0.4 };
  }
  if (name.includes("2.5-flash")) {
    return batch ? { input: 0.15, output: 1.25 } : { input: 0.3, output: 2.5 };
  }
  return batch ? { input: 0.5, output: 2.5 } : { input: 1, output: 5 };
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
  rmSync(resolvedDir, { recursive: true, force: true });
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
      : typeof parsed.is_alert_worthy === "boolean"
        ? parsed.is_alert_worthy
        : null;

  if (typeof isTrueChange !== "boolean") {
    throw new Error("AI JSON is missing is_true_change.");
  }

  if (
    isTrueChange &&
    (!cleanNullable(parsed.reader_summary) || !cleanNullable(parsed.advisor_impact))
  ) {
    throw new Error("AI approved a true change without reader_summary or advisor_impact.");
  }

  const result = {
    is_true_change: isTrueChange,
    noise_reason: cleanNullable(parsed.noise_reason),
    reader_summary: cleanNullable(parsed.reader_summary),
    advisor_impact: cleanNullable(parsed.advisor_impact),
    changed_section: cleanNullable(parsed.changed_section),
    confidence,
    before: cleanNullable(parsed.before),
    after: cleanNullable(parsed.after),
    change_type: cleanSlug(parsed.change_type) || inferVisualChangeType(parsed, context.diff),
    updated_baseline_facts: jsonObjectOrNull(parsed.updated_baseline_facts),
    quality_flags: stringArray(parsed.quality_flags).map(cleanSlug).filter(Boolean),
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

function selectAiProvider(requestedProvider, keys) {
  const requested = String(requestedProvider || "auto").toLowerCase();
  if (["gemini-cli", "antigravity", "agy"].includes(requested)) return keys.geminiCli ? "gemini-cli" : null;
  if (requested === "gemini") return keys.gemini ? "gemini" : null;
  if (requested === "openai") return keys.openai ? "openai" : null;
  if (requested !== "auto") return null;
  if (keys.gemini) return "gemini";
  if (keys.openai) return "openai";
  if (keys.geminiCli) return "gemini-cli";
  return null;
}

function missingAiMessage(requestedProvider) {
  if (["gemini-cli", "antigravity", "agy"].includes(requestedProvider)) {
    return "AWARDPING_GEMINI_CLI_PATH must point to agy.exe when --ai-provider=gemini-cli. AI review is mandatory; refusing to run.";
  }
  if (requestedProvider === "gemini") {
    return "GEMINI_API_KEY is required when --ai-provider=gemini. AI review is mandatory; refusing to run.";
  }
  if (requestedProvider === "openai") {
    return "OPENAI_API_KEY is required when --ai-provider=openai. AI review is mandatory; refusing to run.";
  }
  return "GEMINI_API_KEY or OPENAI_API_KEY is required for visual snapshot AI review. AI review is mandatory; refusing to run.";
}

function modelForProvider(provider) {
  if (provider === "gemini") {
    return (
      env.AWARDPING_VISUAL_GEMINI_MODEL ||
      env.GEMINI_MODEL ||
      env.GEMINI_SUMMARY_MODEL ||
      "gemini-2.5-flash-lite"
    );
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
  const hash = capture?.file_hash || capture?.image_hash || capture?.text_hash || "";
  return hash ? `visual:${hash}` : "";
}

function visualHashForBaseline(baseline) {
  const hash = baseline?.file_hash || baseline?.image_hash || baseline?.text_hash || "";
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
  "True changes include deadline changes, application opening or closing changes, eligibility changes, requirement changes, nomination or recommendation changes, document/PDF/guideline changes, funding/stipend/tuition/award amount changes, or application instruction changes.",
  "Reject cookie banners, carousels, ads, newsletter popups, current-date or last-updated-only changes, font/reflow/lazy-image changes, nav/footer/sidebar changes, social/share widgets, event/news/listing churn, recipient-news churn, staff/job content, unrelated research/news pages, and unrelated page widgets unless award requirements changed.",
  "Do not infer relevance just because words like award, fellowship, grant, application, or deadline appear in unrelated content.",
  "reader_summary should be one or two sentences, plain English, advisor-facing.",
  "advisor_impact should say what an advising office might need to check or update.",
  "If confidence is low, set is_true_change=false unless the changed award fact is explicit.",
  "Required keys: is_true_change, noise_reason, reader_summary, advisor_impact, changed_section, confidence.",
  "Use null for unavailable noise_reason, reader_summary, advisor_impact, or changed_section.",
  "confidence must be low, medium, or high.",
].join(" ");

const baselineFactsSystemPrompt = [
  "You are extracting a clean source-page outline for AwardPing scholarship advisors.",
  "Return valid strict JSON only. Do not include markdown.",
  "Every source page needs a readable display_title and a short page_description, even if the page is only a contact page, FAQ page, PDF, portal page, news page, or unclear/unrelated page.",
  "Extract only facts that are visible or directly supported by the screenshot, PDF text, or normalized page text.",
  "Do not guess missing dates, amounts, eligibility, or requirements.",
  "Descriptions should be concise and useful in a page outline.",
].join(" ");

const aiResponseSchema = {
  type: "object",
  properties: {
    is_true_change: { type: "boolean" },
    noise_reason: { type: "string", nullable: true },
    reader_summary: { type: "string", nullable: true },
    advisor_impact: { type: "string", nullable: true },
    changed_section: { type: "string", nullable: true },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
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
    "noise_reason",
    "reader_summary",
    "advisor_impact",
    "changed_section",
    "confidence",
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
    page_purpose: { type: "string", nullable: true },
    award_relevance: { type: "string", enum: ["primary", "supporting", "unclear", "unrelated"] },
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
    quality_flags: { type: "array", items: { type: "string" } },
  },
  required: [
    "status",
    "display_title",
    "page_description",
    "page_category",
    "award_name",
    "page_purpose",
    "award_relevance",
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
    "quality_flags",
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
  } catch (error) {
    console.error(errorMessage(error));
    process.exit(1);
  }
}
