#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { monitoringPolicyPromptLinesForScope } from "./lib/award-monitoring-policy.mjs";
import { runGeminiCliJsonAnalysis } from "./lib/gemini-cli-analysis.mjs";
import {
  geminiSpendGuardStatus,
  markGeminiBillingBlocked,
} from "./lib/gemini-spend-guard.mjs";
import {
  activeBatchRequestKeys,
  batchJobsAwaitingReconciliation,
  baselineFactsPromptCharLimit,
  batchInputModeForRequests,
  estimateGeminiCostUsd as estimateGeminiCostUsdByMode,
  estimateTextTokens,
  extractGeminiBatchInlineResponses as extractGeminiBatchInlineResponsesShared,
  extractGeminiUsageMetadata,
  geminiBatchInlineResponseMap as geminiBatchInlineResponseMapShared,
  geminiBatchJsonlRequest,
  geminiBatchOutputFileNames,
  geminiInlineError,
  geminiInlineResponsePayload,
  mergeBatchJobRecord,
  latestRequestKeysByBatchJob,
  shouldAttachBaselineFactsImage,
  submittedRequestCapReached,
  unfinishedBatchJobs,
} from "./lib/gemini-batch-support.mjs";
import {
  sourceQualityDecision,
} from "./lib/source-quality.mjs";
import {
  baselineFactsRejectionDisposition,
  baselineReviewPreflightDecision,
} from "./lib/baseline-facts-candidates.mjs";
import {
  geminiWorkerModel,
  normalizeGeminiBatchMode,
} from "./lib/gemini-worker-policy.mjs";
import { enqueueAwardReconciliation } from "./lib/award-fact-reconciliation.mjs";
import { checkSupabaseHealth } from "./lib/supabase-health.mjs";
import { createSupabaseServiceClient } from "./supabase-service-client.mjs";

const root = resolve(import.meta.dirname, "..");
const defaultArchiveRoot = "D:\\AwardPingVisualSnapshots";
const promptChars = 12_000;
const args = parseArgs(process.argv.slice(2));
const envPath = args.env ? resolve(root, String(args.env)) : resolve(root, ".env.local");
const env = {
  ...loadEnvFile(envPath),
  ...process.env,
};

const archiveRoot = resolve(String(env.AWARDPING_VISUAL_SNAPSHOT_DIR || args["archive-dir"] || defaultArchiveRoot));
const requestedAiProvider = String(args["ai-provider"] || env.AI_PROVIDER || "auto").toLowerCase();
const geminiCliPath = cleanText(
  args["gemini-cli-path"] ||
    env.AWARDPING_GEMINI_CLI_PATH ||
    env.GEMINI_CLI_PATH ||
    (env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "agy", "bin", "agy.exe") : "agy"),
);
const geminiCliModel = geminiWorkerModel();
const geminiCliWorkspaceRoot = resolve(
  String(args["gemini-cli-workspace"] || env.AWARDPING_GEMINI_CLI_WORKSPACE || join(archiveRoot, "gemini-cli-workspace", "baseline-facts")),
);
const geminiCliTimeoutMs = positiveInt(args["gemini-cli-timeout-ms"] || env.AWARDPING_GEMINI_CLI_TIMEOUT_MS, 120_000);
const geminiCliMaxCalls = nonNegativeInt(
  args["gemini-cli-max-calls"] ||
    (["gemini-cli", "antigravity", "agy"].includes(requestedAiProvider) ? args["max-calls"] : undefined) ||
    env.AWARDPING_GEMINI_CLI_MAX_CALLS,
  100,
);
const geminiCliSafeModels = [geminiWorkerModel()];
const allowUnsafeGeminiCliModel = boolArg(args["allow-unsafe-gemini-cli-model"] ?? env.AWARDPING_ALLOW_UNSAFE_GEMINI_CLI_MODEL, false);
const aiProvider = selectAiProvider(requestedAiProvider);
const geminiApiModel = geminiWorkerModel();
const dailyCostCapUsd = nonNegativeNumber(
  args["gemini-api-daily-cost-cap-usd"] || env.AWARDPING_GEMINI_API_DAILY_COST_CAP_USD,
  15,
);
const geminiApiMaxRequests = nonNegativeInt(
  args["gemini-api-max-requests"] || args["max-calls"] || env.AWARDPING_GEMINI_API_MAX_REQUESTS,
  0,
);
const geminiApiMaxSubmittedRequests = nonNegativeInt(
  args["gemini-api-max-submitted-requests"] ||
    env.AWARDPING_GEMINI_API_MAX_SUBMITTED_REQUESTS ||
    geminiApiMaxRequests,
  geminiApiMaxRequests,
);
const geminiApiMode = normalizeGeminiBatchMode(
  args["gemini-api-mode"] || env.AWARDPING_GEMINI_API_MODE || "batch",
  { context: "Baseline facts" },
);
const baselineFactsMaxOutputTokens = boundedInt(
  args["baseline-facts-max-output-tokens"] || env.AWARDPING_BASELINE_FACTS_MAX_OUTPUT_TOKENS,
  1600,
  600,
  2400,
);
const geminiBatchMaxRequests = positiveInt(
  args["gemini-batch-max-requests"] || env.AWARDPING_GEMINI_BATCH_MAX_REQUESTS,
  25,
);
const geminiBatchParallelJobs = positiveInt(
  args["gemini-batch-parallel-jobs"] || env.AWARDPING_GEMINI_BATCH_PARALLEL_JOBS,
  4,
);
const geminiBatchMaxInlineBytes = positiveInt(
  args["gemini-batch-max-inline-mb"] || env.AWARDPING_GEMINI_BATCH_MAX_INLINE_MB,
  14,
) * 1024 * 1024;
const geminiBatchInlineRequestThreshold = positiveInt(
  args["gemini-batch-inline-threshold"] || env.AWARDPING_GEMINI_BATCH_INLINE_THRESHOLD,
  100,
);
const geminiBatchStatePath = resolve(
  String(
    args["gemini-batch-state-file"] ||
      env.AWARDPING_BASELINE_FACTS_BATCH_STATE_FILE ||
      join(archiveRoot, "usage", "baseline-facts-gemini-batch-jobs.json"),
  ),
);
const geminiBatchJsonlDir = resolve(
  String(
    args["gemini-batch-jsonl-dir"] ||
      env.AWARDPING_BASELINE_FACTS_BATCH_JSONL_DIR ||
      join(archiveRoot, "usage", "baseline-facts-gemini-batch-jsonl"),
  ),
);
const geminiBatchPollSeconds = positiveInt(
  args["gemini-batch-poll-seconds"] || env.AWARDPING_GEMINI_BATCH_POLL_SECONDS,
  30,
);
const geminiBatchTimeoutMinutes = positiveInt(
  args["gemini-batch-timeout-minutes"] || env.AWARDPING_GEMINI_BATCH_TIMEOUT_MINUTES,
  24 * 60,
);
const limit = positiveInt(args.limit, 100);
const applyUpdates = boolArg(args.apply, true);
const force = boolArg(args.force, false);
const verboseSkips = boolArg(args["verbose-skips"], false);
const includePdf = boolArg(args["include-pdf"], true);
const includeWeb = boolArg(args["include-web"], true);
const sourceIdFilter = cleanText(args["source-id"]);
const sourceIdsFileFilter = sourceIdsFileSet(args["source-ids-file"]);
const shardCount = positiveInt(args["shard-count"], 1);
const shardIndex = nonNegativeInt(args["shard-index"], 0);
const useGeminiBatchApi = aiProvider === "gemini";

if (shardIndex >= shardCount) {
  console.error(`--shard-index must be less than --shard-count. Received ${shardIndex}/${shardCount}.`);
  process.exit(1);
}

if (aiProvider === "gemini" && !env.GEMINI_API_KEY) {
  console.error("GEMINI_API_KEY is required when --ai-provider=gemini.");
  process.exit(1);
}

if (!aiProvider) {
  console.error("GEMINI_API_KEY is required for Gemini Batch baseline facts backfill.");
  process.exit(1);
}

const supabase =
  env.NEXT_PUBLIC_SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY
    ? createSupabaseServiceClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
    : null;

async function runOnce() {
  mkdirSync(geminiCliWorkspaceRoot, { recursive: true });
  mkdirSync(join(root, "reports"), { recursive: true });

  const startedAt = new Date().toISOString();
  const runStamp = timestampForPath(startedAt);
  const reportPath = join(root, "reports", `baseline-facts-${runStamp}.json`);
  const latestReportPath = join(root, "reports", "baseline-facts-latest.json");
  const report = {
    archive_root: archiveRoot,
    started_at: startedAt,
    finished_at: null,
    status: "running",
    ai_provider: aiProvider,
    ai_model: aiProvider === "gemini" ? geminiApiModel : geminiCliModel,
    env_path: envPath,
    options: {
      limit,
      apply: applyUpdates,
      force,
      verbose_skips: verboseSkips,
      include_pdf: includePdf,
      include_web: includeWeb,
      source_id: sourceIdFilter || null,
      source_ids_file: cleanText(args["source-ids-file"]) || null,
      shard_count: shardCount,
      shard_index: shardIndex,
      gemini_cli_model: geminiCliModel,
      gemini_cli_safe_models: geminiCliSafeModels,
      allow_unsafe_gemini_cli_model: allowUnsafeGeminiCliModel,
      gemini_cli_max_calls: aiProvider === "gemini-cli" ? geminiCliMaxCalls || null : null,
      gemini_api_max_requests: aiProvider === "gemini" ? geminiApiMaxRequests || null : null,
      gemini_api_max_submitted_requests: aiProvider === "gemini" ? geminiApiMaxSubmittedRequests || null : null,
      gemini_api_daily_cost_cap_usd: aiProvider === "gemini" ? dailyCostCapUsd : null,
      gemini_api_mode: aiProvider === "gemini" ? geminiApiMode : null,
      baseline_facts_max_output_tokens: aiProvider === "gemini" ? baselineFactsMaxOutputTokens : null,
      gemini_batch_max_requests: useGeminiBatchApi ? geminiBatchMaxRequests : null,
      gemini_batch_parallel_jobs: useGeminiBatchApi ? geminiBatchParallelJobs : null,
      gemini_batch_max_inline_bytes: useGeminiBatchApi ? geminiBatchMaxInlineBytes : null,
      gemini_batch_inline_threshold: useGeminiBatchApi ? geminiBatchInlineRequestThreshold : null,
      gemini_batch_state_file: useGeminiBatchApi ? geminiBatchStatePath : null,
      gemini_batch_poll_seconds: useGeminiBatchApi ? geminiBatchPollSeconds : null,
      gemini_batch_timeout_minutes: useGeminiBatchApi ? geminiBatchTimeoutMinutes : null,
    },
    loaded_baselines: 0,
    loaded_source_records: 0,
    missing_local_baselines: 0,
    scanned_targets: 0,
    eligible_candidates: 0,
    checked: 0,
    extracted: 0,
    applied: 0,
    awards_queued_for_reconciliation: 0,
    award_reconciliation_queue_existing: 0,
    award_reconciliation_queue_failed: 0,
    skipped_existing: 0,
    skipped_ineligible: 0,
    skip_reasons: {},
    failed: 0,
    stop_reason: null,
    billing_blocked: false,
    blocking_reason: null,
    gemini_cli_usage: {
      calls: 0,
      successes: 0,
      failures: 0,
      image_files: 0,
      view_file_calls: 0,
      stream_calls: 0,
      elapsed_ms: 0,
      model: geminiCliModel,
      note: "Gemini CLI / Antigravity does not expose exact account quota usage in worker logs.",
    },
    gemini_usage: {
      calls: 0,
      prompt_tokens: 0,
      candidates_tokens: 0,
      total_tokens: 0,
      thoughts_tokens: 0,
      cached_content_tokens: 0,
      estimated_cost_usd: 0,
      model: aiProvider === "gemini" ? geminiApiModel : null,
      api_mode: aiProvider === "gemini" ? geminiApiMode : null,
      max_requests: aiProvider === "gemini" ? geminiApiMaxRequests || null : null,
      max_submitted_requests: aiProvider === "gemini" ? geminiApiMaxSubmittedRequests || null : null,
      batch_jobs: 0,
      batch_requests: 0,
      batch_submitted_requests: 0,
      batch_failures: 0,
      batch_parallel_jobs: useGeminiBatchApi ? geminiBatchParallelJobs : null,
      batch_state_file: useGeminiBatchApi ? geminiBatchStatePath : null,
    },
    saved_sources: [],
    errors: [],
  };

  let runId = null;
  try {
    const supabaseHealth = await checkSupabaseHealth(supabase);
    if (!supabaseHealth.ok) {
      report.status = "blocked";
      report.stop_reason = "supabase_unavailable";
      report.errors.push({
        message: supabaseHealth.message,
      });
      console.log(
        `SUPABASE_UNAVAILABLE reason=${supabaseHealth.reason} message=${truncate(supabaseHealth.message, 500)}`,
      );
      return;
    }

    runId = await startWorkerRun(report);
    const sourceRecords = await loadBaselineReviewSources();
    report.loaded_source_records = sourceRecords?.size || 0;
    const targets = loadBaselineTargets(sourceRecords);
    report.loaded_baselines = targets.length;
    report.missing_local_baselines = Math.max(0, report.loaded_source_records - targets.length);
    const capLabel =
      aiProvider === "gemini"
        ? `api_max_requests=${geminiApiMaxRequests || "none"} api_max_submitted_requests=${geminiApiMaxSubmittedRequests || "none"}`
        : `cli_max_calls=${geminiCliMaxCalls || "none"}`;
    console.log(
      `BASELINE_FACTS loaded=${targets.length} limit=${limit} provider=${aiProvider} model="${report.ai_model}" mode=${aiProvider === "gemini" ? geminiApiMode : "interactive"} ${capLabel} apply=${applyUpdates}`,
    );

    if (useGeminiBatchApi) {
      await processGeminiApiBatchTargets(targets, report, runId);
      report.status = report.billing_blocked ? "blocked" : "succeeded";
      await finishWorkerRun(
        runId,
        report.billing_blocked ? "failed" : "succeeded",
        report.billing_blocked ? report.blocking_reason : null,
        report,
      );
      return;
    }

    for (const target of targets) {
      if (report.checked >= limit) break;
      if (geminiCliMaxCalls && totalAiCalls(report) >= geminiCliMaxCalls) {
        report.stop_reason = "ai_call_cap_reached";
        console.log("BASELINE_FACTS cap_reached");
        break;
      }
      if (geminiApiDailyCapReached(report)) {
        report.stop_reason = "gemini_api_cost_cap_reached";
        console.log("BASELINE_FACTS gemini_api_cost_cap_reached");
        break;
      }
      if (report.billing_blocked) break;

      report.scanned_targets += 1;
      const baseline = readJsonIfExists(target.baselinePath);
      const source = target.source || sourceFromBaseline(baseline);
      if (!baseline || !source) {
        report.skipped_ineligible += 1;
        recordSkipReason(report, "missing_baseline_or_source");
        await maybeUpdateWorkerRun(runId, report);
        continue;
      }
      const preflight = baselineReviewPreflightDecision({
        source,
        hasExistingFacts: baselineHasFacts(baseline),
        force,
      });
      if (!preflight.shouldReview) {
        recordPreflightSkip(report, preflight.reason, source);
        await maybeUpdateWorkerRun(runId, report);
        continue;
      }
      const capture = captureFromBaseline(baseline);
      if (!capture) {
        report.skipped_ineligible += 1;
        recordSkipReason(report, "missing_capture_files");
        await maybeUpdateWorkerRun(runId, report);
        continue;
      }

      report.eligible_candidates += 1;
      report.checked += 1;
      try {
        const analysis =
          aiProvider === "gemini"
            ? await runGeminiApiBaselineFactsAnalysis(source, capture)
            : await runGeminiCliJsonAnalysis({
                cliPath: geminiCliPath,
                model: geminiCliModel,
                workspaceRoot: geminiCliWorkspaceRoot,
                timeoutMs: geminiCliTimeoutMs,
                safeModels: geminiCliSafeModels,
                allowUnsafeModel: allowUnsafeGeminiCliModel,
                runId: `baseline-facts-${timestampForPath(new Date().toISOString())}-${source.id}`,
                prompt: geminiCliBaselineFactsPrompt(source, capture, "baseline_facts_backfill"),
                filePaths: geminiCliBaselineFactFiles(capture),
              });
        if (aiProvider === "gemini") recordGeminiApiUsage(report, source, capture, analysis);
        else recordGeminiCliUsage(report, source, capture, analysis);

        const facts = normalizeBaselineFacts(analysis.result);
        const metadata = {
          status: "succeeded",
          reason: "baseline_facts_backfill",
          provider: aiProvider,
          model: analysis.model || report.ai_model,
          analysis_path: analysis.transcript_path || analysis.log_path || null,
          prompt_path: analysis.prompt_path || null,
          extracted_at: new Date().toISOString(),
          snapshot_hash: capture.image_hash || capture.file_hash || null,
        };
        const sanity = baselineFactsMatchSource(source, capture, facts);
        if (!sanity.ok) {
          if (applyUpdates) await rejectFactsInSupabaseSource(source, facts, metadata, capture, sanity.reason, report);
          throw new Error(`Baseline facts rejected: ${sanity.reason}`);
        }

        if (applyUpdates) {
          applyFactsToBaseline(target.baselinePath, baseline, facts, metadata);
          await applyFactsToSupabaseSource(source, facts, metadata, capture, report);
          report.applied += 1;
        }
        report.extracted += 1;
        report.saved_sources.push({
          source_id: source.id,
          award_name: source.shared_awards?.name || null,
          source_title: source.title || null,
          source_url: source.url || null,
          confidence: facts.confidence,
        });
        console.log(`BASELINE_FACTS extracted confidence=${facts.confidence} ${sourceLabel(source)}`);
      } catch (error) {
        if (error.geminiCliUsage) {
          recordGeminiCliUsage(report, source, capture, { usage: error.geminiCliUsage });
        }
        const message = errorMessage(error);
        if (isGeminiBillingOrQuotaErrorMessage(message)) {
          markReportBillingBlocked(report, message);
          console.log(`BASELINE_FACTS billing_blocked ${truncate(message, 800)}`);
          break;
        }
        report.failed += 1;
        report.errors.push({
          source_id: source.id,
          source_url: source.url,
          message,
        });
        console.log(`BASELINE_FACTS failed ${truncate(message, 800)} ${sourceLabel(source)}`);
      }

      await maybeUpdateWorkerRun(runId, report);
    }

    report.status = report.billing_blocked ? "blocked" : "succeeded";
    await finishWorkerRun(
      runId,
      report.billing_blocked ? "failed" : "succeeded",
      report.billing_blocked ? report.blocking_reason : null,
      report,
    );
  } catch (error) {
    report.status = "failed";
    report.errors.push({ message: errorMessage(error) });
    await finishWorkerRun(runId, "failed", errorMessage(error), report);
    throw error;
  } finally {
    report.finished_at = new Date().toISOString();
    writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
    writeFileSync(latestReportPath, JSON.stringify(report, null, 2), "utf8");
    console.log(`BASELINE_FACTS_REPORT ${reportPath}`);
  }
}

async function loadBaselineReviewSources() {
  if (!supabase) return null;

  const rows = [];
  for (let from = 0; ; from += 1000) {
    let query = supabase
      .from("shared_award_sources")
      .select(
        "id,shared_award_id,url,title,display_title,page_description,page_metadata,page_metadata_generated_at,page_metadata_model,page_type,source,reason,submitted_by_user_id,admin_review_status,created_at",
      )
      .order("id", { ascending: true })
      .range(from, from + 999);
    if (sourceIdFilter) query = query.eq("id", sourceIdFilter);
    else query = query.eq("admin_review_status", "open");

    const { data, error } = await query;
    if (error) throw new Error(`Load baseline review sources failed: ${error.message}`);
    for (const source of data || []) {
      if (sourceIdsFileFilter && !sourceIdsFileFilter.has(source.id)) continue;
      rows.push(source);
    }
    if (!data || data.length < 1000 || sourceIdFilter) break;
  }

  return new Map(rows.map((source) => [source.id, source]));
}

function loadBaselineTargets(sourceRecords = null) {
  const sourcesRoot = join(archiveRoot, "sources");
  if (!existsSync(sourcesRoot)) return [];

  const targets = [];
  const entries = sourceRecords
    ? [...sourceRecords.entries()].map(([sourceId, source]) => ({ sourceId, source }))
    : readdirSync(sourcesRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => ({ sourceId: entry.name, source: null }));

  for (const entry of entries) {
    if (sourceIdFilter && entry.sourceId !== sourceIdFilter) continue;
    if (sourceIdsFileFilter && !sourceIdsFileFilter.has(entry.sourceId)) continue;
    if (shardCount > 1 && stableShard(entry.sourceId, shardCount) !== shardIndex) continue;
    const baselinePath = join(sourcesRoot, entry.sourceId, "baseline.json");
    if (!existsSync(baselinePath)) continue;

    const baseline = readJsonIfExists(baselinePath);
    const kind = baseline?.kind || (baseline?.capture?.pdf ? "pdf" : "webpage");
    if (!includePdf && kind === "pdf") continue;
    if (!includeWeb && kind !== "pdf") continue;
    const baselineSource = sourceFromBaseline(baseline);
    const source = entry.source
      ? {
          ...baselineSource,
          ...entry.source,
          shared_awards: baselineSource?.shared_awards || null,
        }
      : baselineSource;
    targets.push({
      sourceId: entry.sourceId,
      baselinePath,
      source,
      sortKey: [
        baselineHasFacts(baseline) ? "1" : "0",
        source?.shared_awards?.name || baseline?.source?.award_name || "",
        source?.title || baseline?.source?.title || "",
        source?.url || baseline?.source?.url || "",
        entry.sourceId,
      ].join("\t"),
    });
  }

  return targets.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
}

function stableShard(value, count) {
  let hash = 2166136261;
  for (const char of String(value || "")) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % count;
}

function captureFromBaseline(baseline) {
  if (!baseline) return null;
  const capture = baseline.capture || {};
  const kind = baseline.kind || (capture.pdf ? "pdf" : "webpage");
  const paths = {
    pagePath: capture.page ? fromArchiveRelative(capture.page) : null,
    thumbPath: capture.thumb ? fromArchiveRelative(capture.thumb) : null,
    pdfPath: capture.pdf ? fromArchiveRelative(capture.pdf) : null,
    textPath: capture.text ? fromArchiveRelative(capture.text) : null,
    sectionsTextPath: capture.sections_text ? fromArchiveRelative(capture.sections_text) : null,
    sectionsJsonPath: capture.sections_json ? fromArchiveRelative(capture.sections_json) : null,
    metaPath: capture.meta ? fromArchiveRelative(capture.meta) : null,
  };
  const required = kind === "pdf" ? [paths.pdfPath, paths.textPath, paths.metaPath] : [paths.pagePath, paths.thumbPath, paths.textPath, paths.metaPath];
  if (required.some((filePath) => !filePath || !existsSync(filePath))) return null;

  const meta = readJsonIfExists(paths.metaPath) || {};
  return {
    ...meta,
    kind,
    dir: capture.dir ? fromArchiveRelative(capture.dir) : dirname(paths.metaPath),
    page_path: paths.pagePath,
    thumb_path: paths.thumbPath,
    pdf_path: paths.pdfPath,
    text_path: paths.textPath,
    sections_text_path: paths.sectionsTextPath,
    sections_json_path: paths.sectionsJsonPath,
    meta_path: paths.metaPath,
    text: readFileSync(paths.textPath, "utf8"),
    section_text_for_baseline_facts:
      paths.sectionsTextPath && existsSync(paths.sectionsTextPath)
        ? readFileSync(paths.sectionsTextPath, "utf8")
        : "",
    captured_at: baseline.captured_at || meta.captured_at || null,
    final_url: baseline.final_url || meta.final_url || null,
    page_title: baseline.page_title || meta.page_title || null,
    image_hash: baseline.image_hash || meta.image_hash || baseline.file_hash || null,
    file_hash: baseline.file_hash || meta.file_hash || null,
    text_length: baseline.text_length || meta.text_length || 0,
    dimensions: baseline.dimensions || meta.dimensions || null,
    status_code: meta.status_code || null,
    content_type: meta.content_type || null,
    page_count: meta.page_count || null,
  };
}

function sourceFromBaseline(baseline) {
  const source = baseline?.source;
  if (!source?.id || !source?.url) return null;
  return {
    id: source.id,
    shared_award_id: source.shared_award_id || null,
    title: source.title || null,
    url: source.url,
    page_type: source.page_type || null,
    source: source.source || null,
    reason: source.reason || null,
    submitted_by_user_id: source.submitted_by_user_id || null,
    page_metadata: baseline?.summary_metadata?.baseline_facts
      ? {
          baseline_facts: baseline.summary_metadata.baseline_facts,
          baseline_facts_metadata: baseline.summary_metadata.baseline_facts_metadata || null,
        }
      : null,
    shared_awards: {
      name: source.award_name || null,
    },
  };
}

function geminiCliBaselineFactsPrompt(source, capture, reason, options = {}) {
  const textCharLimit = positiveInt(options.maxTextChars, promptChars);
  return [
    "You are extracting baseline page information for AwardPing from a captured official source page.",
    "Use the screenshot image when one is provided. Use the normalized visible text or PDF text as supporting context.",
    "Create a clean readable display_title and a short page_description for this exact source page, even when it is not an eligibility, deadline, or application page.",
    "display_title must include the most distinctive visible organization, award, program, or page-title words for this source page.",
    "Extract only facts that are visible or directly supported. Do not guess missing dates, amounts, or requirements.",
    "Keep output very short. page_description must be 20 words or fewer. Each array must have at most 3 items. Each item must be a short phrase, not a sentence.",
    "Prefer null or [] over verbose explanations. Do not include extra keys, markdown, comments, or prose outside the JSON object.",
    "If a PDF or page is mostly unrelated background, policy, reporting, data documentation, or a generic portal, summarize its purpose briefly and leave scholarship-specific fields empty.",
    "Return compact JSON with these keys:",
    "{status, display_title, page_description, page_category, award_name, award_name_seen, page_purpose, award_relevance, cycle_relevance, cycle_relevance_reason, application_cycle, deadline, opening_date, award_amounts, eligibility, requirements, application_materials, how_to_apply, important_dates, documents, contacts, notes, sections, confidence, evidence_quotes, quality_flags, rejection_reason}",
    "Use arrays for award_amounts, eligibility, requirements, application_materials, how_to_apply, important_dates, documents, contacts, notes, sections.",
    "Every important_dates item must include context plus the date, such as \"Application deadline: January 15, 2027\" or \"Award notifications: May 1\". Do not output bare dates.",
    "sections should list 0 to 5 visible scholarship concepts or page areas with {title, description, status}. Use status unchanged for baseline sections.",
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
    String(capture.text || "").slice(0, textCharLimit),
    ...(capture.section_text_for_baseline_facts
      ? [
          "",
          "Structured expandable section text excerpt:",
          String(capture.section_text_for_baseline_facts || "").slice(0, Math.min(6000, textCharLimit)),
        ]
      : []),
  ].join("\n");
}

function geminiCliBaselineFactFiles(capture) {
  return [capture.thumb_path].filter(Boolean);
}

async function processGeminiApiBatchTargets(targets, report, runId) {
  let batchState = loadGeminiBatchState();
  const reconciliation = await reconcileUnfinishedGeminiBatchJobs(batchState, targets, report, runId);
  batchState = reconciliation.state;
  const activeRequestKeys = new Set([
    ...activeBatchRequestKeys(batchState),
    ...reconciliation.reconciledRequestKeys,
  ]);
  const activeJobs = unfinishedBatchJobs(batchState);
  const availableJobSlots = Math.max(0, geminiBatchParallelJobs - activeJobs.length);
  if (availableJobSlots === 0) {
    report.stop_reason = "gemini_batch_jobs_processing";
    console.log(`BASELINE_FACTS_BATCH processing jobs=${activeJobs.length} no_submission_slots=true`);
    return;
  }
  let chunk = [];
  let chunkBytes = geminiBatchEnvelopeBytes([]);
  const pendingChunks = [];

  const queueChunk = () => {
    if (!chunk.length) return;
    pendingChunks.push(chunk);
    chunk = [];
    chunkBytes = geminiBatchEnvelopeBytes([]);
  };

  for (const target of targets) {
    if (pendingChunks.length >= availableJobSlots) break;
    if (report.checked >= limit) break;
    if (report.billing_blocked) break;
    if (geminiApiMaxRequests && report.checked >= geminiApiMaxRequests) {
      report.stop_reason = "gemini_api_request_cap_reached";
      console.log("BASELINE_FACTS gemini_api_request_cap_reached");
      break;
    }
    if (geminiApiSubmittedCapReached(report, pendingGeminiBatchRequestCount(pendingChunks, chunk))) {
      report.stop_reason = "gemini_api_submitted_request_cap_reached";
      console.log("BASELINE_FACTS gemini_api_submitted_request_cap_reached");
      break;
    }
    if (geminiApiDailyCapReached(report)) {
      report.stop_reason = "gemini_api_cost_cap_reached";
      console.log("BASELINE_FACTS gemini_api_cost_cap_reached");
      break;
    }

    report.scanned_targets += 1;
    const baseline = readJsonIfExists(target.baselinePath);
    const source = target.source || sourceFromBaseline(baseline);
    if (!baseline || !source) {
      report.skipped_ineligible += 1;
      recordSkipReason(report, "missing_baseline_or_source");
      await maybeUpdateWorkerRun(runId, report);
      continue;
    }
    const preflight = baselineReviewPreflightDecision({
      source,
      hasExistingFacts: baselineHasFacts(baseline),
      force,
      activeBatchRequest: activeRequestKeys.has(source.id),
    });
    if (!preflight.shouldReview) {
      recordPreflightSkip(report, preflight.reason, source);
      await maybeUpdateWorkerRun(runId, report);
      continue;
    }
    const capture = captureFromBaseline(baseline);
    if (!capture) {
      report.skipped_ineligible += 1;
      recordSkipReason(report, "missing_capture_files");
      await maybeUpdateWorkerRun(runId, report);
      continue;
    }

    report.eligible_candidates += 1;
    const batchEntry = geminiBatchEntryForBaselineFacts(source, capture);
    const batchEntryBytes = Buffer.byteLength(JSON.stringify(batchEntry), "utf8") + 2;
    if (batchEntryBytes > geminiBatchMaxInlineBytes * 4) {
      report.failed += 1;
      const message = `Gemini batch request is too large even for file batch mode (${batchEntryBytes} bytes).`;
      report.errors.push({ source_id: source.id, source_url: source.url, message });
      console.log(`BASELINE_FACTS failed ${message} ${sourceLabel(source)}`);
      continue;
    }

    if (
      chunk.length > 0 &&
      (chunk.length >= geminiBatchMaxRequests || chunkBytes + batchEntryBytes > geminiBatchMaxInlineBytes)
    ) {
      queueChunk();

      if (pendingChunks.length >= availableJobSlots) break;

      if (report.billing_blocked) break;
      if (geminiApiDailyCapReached(report)) {
        report.stop_reason = "gemini_api_cost_cap_reached";
        console.log("BASELINE_FACTS gemini_api_cost_cap_reached");
        break;
      }
    }

    report.checked += 1;
    chunk.push({ target, baseline, capture, source, batchEntry });
    chunkBytes += batchEntryBytes;
    if (chunk.length >= geminiBatchMaxRequests || chunkBytes >= geminiBatchMaxInlineBytes) {
      queueChunk();
    }
    await maybeUpdateWorkerRun(runId, report);
  }

  if (chunk.length && pendingChunks.length < availableJobSlots) queueChunk();
  if (pendingChunks.length && !report.billing_blocked) {
    await processGeminiApiBatchChunkGroup(pendingChunks, report, runId, { waitForCompletion: false });
    if (report.gemini_usage.batch_submitted_requests > 0) {
      report.stop_reason = "gemini_batch_jobs_submitted";
    }
  }
}

async function processGeminiApiBatchChunkGroup(chunks, report, runId, { waitForCompletion = true } = {}) {
  if (!chunks.length) return;
  if (geminiApiDailyCapReached(report)) {
    report.stop_reason = "gemini_api_cost_cap_reached";
    console.log("BASELINE_FACTS gemini_api_cost_cap_reached");
    return;
  }
  console.log(
    `BASELINE_FACTS_BATCH_GROUP submitting jobs=${chunks.length} requests=${chunks.reduce(
      (sum, entries) => sum + entries.length,
      0,
    )}`,
  );
  await Promise.all(
    chunks.map((entries) =>
      processGeminiApiBatchChunkSafely(entries, report, runId, { waitForCompletion })
    ),
  );
}

async function processGeminiApiBatchChunkSafely(entries, report, runId, { waitForCompletion = true } = {}) {
  const maxAttempts = 6;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await processGeminiApiBatchChunk(entries, report, runId, { waitForCompletion });
      return;
    } catch (error) {
      const message = errorMessage(error);
      if (isGeminiBillingOrQuotaErrorMessage(message)) {
        markReportBillingBlocked(report, message);
        console.log(`BASELINE_FACTS_BATCH billing_blocked requests=${entries.length} message=${truncate(message, 500)}`);
        return;
      }
      if (attempt < maxAttempts && isRetryableGeminiBatchSubmissionFailure(message)) {
        const waitMs = geminiBatchRetryDelayMs(attempt);
        console.log(
          `BASELINE_FACTS_BATCH retry_unhandled requests=${entries.length} attempt=${attempt}/${maxAttempts} wait_ms=${waitMs} message=${truncate(message, 500)}`,
        );
        await sleep(waitMs);
        continue;
      }

      report.failed += entries.length;
      report.gemini_usage.batch_failures += entries.length;
      for (const entry of entries) {
        report.errors.push({ source_id: entry.source.id, source_url: entry.source.url, message });
      }
      console.log(`BASELINE_FACTS_BATCH failed_unhandled requests=${entries.length} message=${truncate(message, 500)}`);
      await maybeUpdateWorkerRun(runId, report);
      return;
    }
  }
}

function isRetryableGeminiBatchSubmissionFailure(message) {
  const clean = String(message || "").toLowerCase();
  if (/\b(prepay|prepayment|credits?\s+are\s+depleted|billing)\b/.test(clean)) return false;
  return /\b(408|429|500|502|503|504|rate.?limit|quota|temporar|timeout|unavailable|econnreset|network|fetch failed)\b/.test(
    clean,
  );
}

function geminiBatchRetryDelayMs(attempt) {
  const baseMs = Math.min(15 * 60_000, 60_000 * 2 ** Math.max(0, attempt - 1));
  const jitterMs = Math.floor(Math.random() * 20_000);
  return baseMs + jitterMs;
}

function loadGeminiBatchState() {
  if (!existsSync(geminiBatchStatePath)) return { version: 1, jobs: [] };
  try {
    const parsed = JSON.parse(readFileSync(geminiBatchStatePath, "utf8"));
    return {
      version: 1,
      jobs: Array.isArray(parsed?.jobs) ? parsed.jobs : [],
    };
  } catch {
    return { version: 1, jobs: [] };
  }
}

function saveGeminiBatchState(state) {
  mkdirSync(dirname(geminiBatchStatePath), { recursive: true });
  writeFileSync(geminiBatchStatePath, `${JSON.stringify({ version: 1, jobs: state.jobs || [] }, null, 2)}\n`, "utf8");
}

function upsertGeminiBatchStateJob(record) {
  const state = mergeBatchJobRecord(loadGeminiBatchState(), record);
  saveGeminiBatchState(state);
  return state;
}

async function reconcileUnfinishedGeminiBatchJobs(state, targets, report, runId) {
  const awaiting = batchJobsAwaitingReconciliation(state);
  if (!awaiting.length) return { state, reconciledRequestKeys: new Set() };

  const targetsBySourceId = new Map(targets.map((target) => [target.sourceId, target]));
  const latestKeysByJob = latestRequestKeysByBatchJob(awaiting);
  const ordered = [...awaiting].sort((left, right) =>
    String(right?.submitted_at || "").localeCompare(String(left?.submitted_at || "")),
  );
  const reconciledRequestKeys = new Set();
  let nextState = state;
  for (const job of ordered) {
    if (!job.batch_name) continue;
    const latestRequestKeys = latestKeysByJob.get(job.batch_name) || [];
    if (!latestRequestKeys.length) {
      nextState = mergeBatchJobRecord(nextState, {
        ...job,
        status: "succeeded",
        reconciled_at: new Date().toISOString(),
        reconciliation_status: "superseded_duplicate_requests",
        superseded_request_count: Array.isArray(job.request_keys) ? job.request_keys.length : 0,
      });
      saveGeminiBatchState(nextState);
      console.log(`BASELINE_FACTS_BATCH existing_superseded job=${job.batch_name}`);
      continue;
    }
    const completed = await fetchGeminiBatchJson(
      `https://generativelanguage.googleapis.com/v1beta/${job.batch_name}`,
      { method: "GET", kind: "batch_poll_existing" },
    );
    const stateValue = geminiBatchState(completed);
    if (!isGeminiBatchDone(stateValue)) {
      nextState = mergeBatchJobRecord(nextState, {
        ...job,
        status: "processing",
      });
      saveGeminiBatchState(nextState);
      console.log(`BASELINE_FACTS_BATCH existing_processing job=${job.batch_name} state=${stateValue || "unknown"}`);
      continue;
    }

    if (!isGeminiBatchSucceeded(stateValue)) {
      const message = `Gemini batch ${job.batch_name} finished with ${stateValue || "unknown state"}: ${geminiBatchErrorMessage(completed)}`;
      report.gemini_usage.batch_failures += nonNegativeInt(job.request_count, 0);
      report.errors.push({ batch_name: job.batch_name, message });
      nextState = mergeBatchJobRecord(nextState, {
        ...job,
        status: "failed",
        completed_at: new Date().toISOString(),
        output_ref: geminiBatchOutputRef(completed),
        error: message,
      });
      saveGeminiBatchState(nextState);
      console.log(`BASELINE_FACTS_BATCH existing_failed job=${job.batch_name} message=${truncate(message, 500)}`);
      continue;
    }

    const entries = entriesForBatchStateJob(job, targetsBySourceId, new Set(latestRequestKeys));
    if (!entries.length) {
      nextState = mergeBatchJobRecord(nextState, {
        ...job,
        status: "succeeded",
        completed_at: new Date().toISOString(),
        output_ref: geminiBatchOutputRef(completed),
        reconciled_at: new Date().toISOString(),
        reconciliation_status: "no_local_entries",
      });
      saveGeminiBatchState(nextState);
      console.log(`BASELINE_FACTS_BATCH existing_no_local_entries job=${job.batch_name}`);
      continue;
    }

    report.checked += entries.length;
    let reconciliationResult;
    try {
      reconciliationResult = await applyGeminiApiBatchResponses({
        batchName: job.batch_name,
        completed,
        entries,
        report,
        runId,
      });
    } catch (error) {
      const message = errorMessage(error);
      nextState = mergeBatchJobRecord(nextState, {
        ...job,
        status: "processing",
        output_ref: geminiBatchOutputRef(completed),
        error: message,
      });
      saveGeminiBatchState(nextState);
      report.errors.push({ batch_name: job.batch_name, message });
      console.log(`BASELINE_FACTS_BATCH existing_reconcile_deferred job=${job.batch_name} message=${truncate(message, 500)}`);
      continue;
    }
    for (const entry of entries) reconciledRequestKeys.add(entry.source.id);
    nextState = mergeBatchJobRecord(nextState, {
      ...job,
      status: "succeeded",
      completed_at: new Date().toISOString(),
      output_ref: geminiBatchOutputRef(completed),
      reconciled_at: new Date().toISOString(),
      reconciliation_status: reconciliationResult.failed > 0 ? "completed_with_item_failures" : "completed",
      reconciliation_result: reconciliationResult,
      error: null,
    });
    saveGeminiBatchState(nextState);
    console.log(`BASELINE_FACTS_BATCH existing_reconciled job=${job.batch_name} requests=${entries.length}`);
    await maybeUpdateWorkerRun(runId, report);
  }

  saveGeminiBatchState(nextState);
  return { state: nextState, reconciledRequestKeys };
}

function entriesForBatchStateJob(job, targetsBySourceId, allowedKeys = null) {
  const entries = [];
  const contexts = Array.isArray(job.request_contexts) ? job.request_contexts : [];
  const keys = Array.isArray(job.request_keys) ? job.request_keys : [];
  for (const key of keys) {
    if (allowedKeys && !allowedKeys.has(key)) continue;
    const context = contexts.find((item) => item?.source_id === key) || {};
    const target = targetsBySourceId.get(key) || (context.baseline_path ? { sourceId: key, baselinePath: context.baseline_path } : null);
    if (!target?.baselinePath || !existsSync(target.baselinePath)) continue;
    const baseline = readJsonIfExists(target.baselinePath);
    const capture = captureFromBaseline(baseline);
    const source = target.source || sourceFromBaseline(baseline);
    if (!baseline || !capture || !source) continue;
    entries.push({
      target,
      baseline,
      capture,
      source,
      batchEntry: geminiBatchEntryForBaselineFacts(source, capture),
    });
  }
  return entries;
}

function isGeminiBatchDone(state) {
  return new Set([
    "JOB_STATE_SUCCEEDED",
    "JOB_STATE_FAILED",
    "JOB_STATE_CANCELLED",
    "JOB_STATE_EXPIRED",
    "BATCH_STATE_SUCCEEDED",
    "BATCH_STATE_FAILED",
    "BATCH_STATE_CANCELLED",
    "BATCH_STATE_EXPIRED",
  ]).has(state);
}

function isGeminiBatchSucceeded(state) {
  return new Set(["JOB_STATE_SUCCEEDED", "BATCH_STATE_SUCCEEDED"]).has(state);
}

async function processGeminiApiBatchChunk(entries, report, runId, { waitForCompletion = true } = {}) {
  const displayName = `awardping-baseline-facts-${timestampForPath(new Date().toISOString())}`;
  const requests = entries.map((entry) => entry.batchEntry);
  const inputMode = batchInputModeForRequests(requests, {
    inlineThreshold: geminiBatchInlineRequestThreshold,
    maxInlineBytes: geminiBatchMaxInlineBytes,
  });
  const estimatedCostUsd = estimateGeminiBatchEntriesCostUsd(entries);
  const created = await createGeminiBatchJob({ requests, displayName, mode: inputMode });
  const batchName = geminiBatchJobName(created);
  if (!batchName) {
    throw new Error(`Gemini Batch API did not return a batch name: ${truncate(JSON.stringify(created), 600)}`);
  }

  upsertGeminiBatchStateJob({
    batch_name: batchName,
    display_name: displayName,
    request_keys: entries.map((entry) => entry.source.id),
    request_contexts: entries.map((entry) => ({
      source_id: entry.source.id,
      shared_award_id: entry.source.shared_award_id || null,
      baseline_path: entry.target.baselinePath,
      source_url: entry.source.url,
    })),
    model: geminiApiModel,
    status: "submitted",
    submitted_at: new Date().toISOString(),
    completed_at: null,
    output_ref: null,
    request_count: entries.length,
    estimated_cost_usd: estimatedCostUsd,
    input_mode: inputMode,
  });
  recordGeminiApiBatchSubmission(report, entries, {
    batchName,
    displayName,
    inputMode,
    estimatedCostUsd,
  });
  console.log(`BASELINE_FACTS_BATCH submitted job=${batchName} requests=${entries.length} mode=${inputMode}`);
  await maybeUpdateWorkerRun(runId, report);
  if (!waitForCompletion) return;

  let completed;
  try {
    completed = await waitForGeminiBatchJob(batchName);
  } catch (error) {
    const message = errorMessage(error);
    upsertGeminiBatchStateJob({
      batch_name: batchName,
      status: "processing",
      error: message,
    });
    report.errors.push({ batch_name: batchName, message });
    console.log(`BASELINE_FACTS_BATCH poll_deferred job=${batchName} message=${truncate(message, 500)}`);
    await maybeUpdateWorkerRun(runId, report);
    return;
  }
  const state = geminiBatchState(completed);
  if (!["JOB_STATE_SUCCEEDED", "BATCH_STATE_SUCCEEDED"].includes(state)) {
    const message = `Gemini batch ${batchName} finished with ${state || "unknown state"}: ${geminiBatchErrorMessage(completed)}`;
    report.failed += entries.length;
    report.gemini_usage.batch_failures += entries.length;
    for (const entry of entries) {
      report.errors.push({ source_id: entry.source.id, source_url: entry.source.url, message });
    }
    console.log(`BASELINE_FACTS_BATCH failed job=${batchName} requests=${entries.length} message=${truncate(message, 500)}`);
    upsertGeminiBatchStateJob({
      batch_name: batchName,
      status: "failed",
      completed_at: new Date().toISOString(),
      output_ref: geminiBatchOutputRef(completed),
      error: message,
    });
    await maybeUpdateWorkerRun(runId, report);
    return;
  }

  let reconciliationResult;
  try {
    reconciliationResult = await applyGeminiApiBatchResponses({
      batchName,
      completed,
      entries,
      report,
      runId,
    });
  } catch (error) {
    const message = errorMessage(error);
    upsertGeminiBatchStateJob({
      batch_name: batchName,
      status: "processing",
      output_ref: geminiBatchOutputRef(completed),
      error: message,
    });
    report.errors.push({ batch_name: batchName, message });
    console.log(`BASELINE_FACTS_BATCH reconcile_deferred job=${batchName} message=${truncate(message, 500)}`);
    await maybeUpdateWorkerRun(runId, report);
    return;
  }
  upsertGeminiBatchStateJob({
    batch_name: batchName,
    status: "succeeded",
    completed_at: new Date().toISOString(),
    output_ref: geminiBatchOutputRef(completed),
    reconciled_at: new Date().toISOString(),
    reconciliation_status: reconciliationResult.failed > 0 ? "completed_with_item_failures" : "completed",
    reconciliation_result: reconciliationResult,
    error: null,
  });
}

async function applyGeminiApiBatchResponses({ batchName, completed, entries, report, runId }) {
  const responses = await geminiBatchResponses(completed);
  const responseByKey = geminiBatchInlineResponseMap(responses);
  const missingEntryKeys = entries
    .map((entry) => entry.source.id)
    .filter((key) => !responseByKey.responses.has(key));
  const duplicateEntryKeys = entries
    .map((entry) => entry.source.id)
    .filter((key) => responseByKey.duplicateKeys.has(key));
  if (!responses.length) {
    throw new Error(`Gemini batch ${batchName} returned no readable inline or file responses.`);
  }
  if (missingEntryKeys.length || duplicateEntryKeys.length) {
    throw new Error(
      `Gemini batch ${batchName} response mapping failed: missing=${missingEntryKeys.length} duplicate=${duplicateEntryKeys.length}.`,
    );
  }
  if (responses.length !== entries.length) {
    console.log(
      `BASELINE_FACTS_BATCH response_count_mismatch job=${batchName} expected=${entries.length} actual=${responses.length}`,
    );
  }
  if (responseByKey.missingKeys > 0 || responseByKey.duplicateKeys.size > 0) {
    console.log(
      `BASELINE_FACTS_BATCH response_key_warning job=${batchName} responses=${responses.length} missing_keys=${responseByKey.missingKeys} duplicate_keys=${responseByKey.duplicateKeys.size}`,
    );
  }

  const result = { processed: entries.length, extracted: 0, applied: 0, failed: 0 };
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const inlineResponse = responseByKey.responses.get(entry.source.id) || null;
    try {
      if (!inlineResponse) {
        throw new Error(`Gemini batch response missing matching metadata key for source ${entry.source.id}.`);
      }
      if (responseByKey.duplicateKeys.has(entry.source.id)) {
        throw new Error(`Gemini batch response had duplicate metadata keys for source ${entry.source.id}.`);
      }
      const itemError = geminiInlineError(inlineResponse);
      if (itemError) {
        throw new Error(`Gemini batch item error: ${geminiInlineErrorMessage(itemError)}`);
      }
      const response = geminiInlineResponsePayload(inlineResponse);
      if (!response) throw new Error("Gemini batch response did not include a generateContent response.");

      const usage = normalizeGeminiUsage(extractGeminiUsageMetadata(inlineResponse));
      const rawText = extractGeminiText(response);
      const parsed = parseJsonObject(rawText);
      if (!parsed) {
        throw new Error(`Gemini batch returned invalid JSON: ${truncate(rawText, 500) || "empty response"}`);
      }

      const facts = normalizeBaselineFacts(parsed);
      const metadata = {
        status: "succeeded",
        reason: "baseline_facts_backfill",
        provider: "gemini",
        model: geminiApiModel,
        api_mode: "batch",
        batch_job_name: batchName,
        batch_request_key: entry.source.id,
        extracted_at: new Date().toISOString(),
        snapshot_hash: entry.capture.image_hash || entry.capture.file_hash || null,
      };
      const sanity = baselineFactsMatchSource(entry.source, entry.capture, facts);

      recordGeminiApiUsage(
        report,
        entry.source,
        entry.capture,
        {
          provider: "gemini",
          model: geminiApiModel,
          usage,
          raw_text: rawText,
          result: facts,
          api_mode: "batch",
          batch_job_name: batchName,
          cost_multiplier: 0,
          cost_note: "batch_cost_recorded_at_submission",
        },
      );

      if (!sanity.ok) {
        if (applyUpdates) {
          await rejectFactsInSupabaseSource(entry.source, facts, metadata, entry.capture, sanity.reason, report);
        }
        throw new Error(`Baseline facts rejected: ${sanity.reason}`);
      }

      if (applyUpdates) {
        applyFactsToBaseline(entry.target.baselinePath, entry.baseline, facts, metadata);
        await applyFactsToSupabaseSource(entry.source, facts, metadata, entry.capture, report);
        report.applied += 1;
        result.applied += 1;
      }
      report.extracted += 1;
      result.extracted += 1;
      report.saved_sources.push({
        source_id: entry.source.id,
        award_name: entry.source.shared_awards?.name || null,
        source_title: entry.source.title || null,
        source_url: entry.source.url || null,
        confidence: facts.confidence,
      });
      console.log(`BASELINE_FACTS extracted confidence=${facts.confidence} ${sourceLabel(entry.source)}`);
    } catch (error) {
      report.failed += 1;
      result.failed += 1;
      report.gemini_usage.batch_failures += 1;
      const message = errorMessage(error);
      report.errors.push({
        source_id: entry.source.id,
        source_url: entry.source.url,
        message,
      });
      console.log(`BASELINE_FACTS failed ${truncate(message, 800)} ${sourceLabel(entry.source)}`);
    }
  }

  await maybeUpdateWorkerRun(runId, report);
  return result;
}

function geminiBatchEntryForBaselineFacts(source, capture) {
  return {
    request: geminiApiBaselineFactsRequest(source, capture, "baseline_facts_backfill"),
    metadata: {
      key: source.id,
      shared_award_id: source.shared_award_id || null,
      source_url: source.url,
    },
  };
}

function geminiApiBaselineFactsRequest(source, capture, reason) {
  const initialPrompt = geminiCliBaselineFactsPrompt(source, capture, reason);
  const includeImage = shouldAttachBaselineFactsImage({ capture, promptText: initialPrompt });
  const prompt = geminiCliBaselineFactsPrompt(source, capture, reason, {
    maxTextChars: baselineFactsPromptCharLimit(capture, { includeImage }),
  });
  return {
    systemInstruction: {
      parts: [
        {
          text: "Extract a compact source-page outline for AwardPing scholarship advisors. Return strict JSON only. Keep descriptions short enough to avoid truncation. Every source page needs a readable display_title and page_description, even if it is only a contact page, FAQ, PDF, portal, news page, or unclear page. Extract only facts directly supported by the screenshot, PDF text, or normalized text. Classify whether the page is truly about the named program and whether it supports the current/upcoming application cycle, an active evergreen cycle, an archived/past cycle, an unclear cycle, or no program page at all. Default to rejection when uncertain. Missing award_relevance or cycle_relevance means unclear. evidence_quotes must be exact short strings copied from the source. Never use facts from sibling awards or broad search/listing pages.",
        },
      ],
    },
    contents: [
      {
        role: "user",
        parts: [
          { text: prompt },
          ...(includeImage ? geminiInlineImageParts(geminiCliBaselineFactFiles(capture)) : []),
        ],
      },
    ],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: baselineFactsMaxOutputTokens,
      responseMimeType: "application/json",
    },
  };
}

function geminiBatchEnvelopeBytes(requests) {
  return Buffer.byteLength(
    JSON.stringify({
      batch: {
        displayName: "awardping-baseline-facts-size-check",
        inputConfig: { requests: { requests } },
      },
    }),
    "utf8",
  );
}

async function createGeminiBatchJob({ requests, displayName, mode }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    geminiApiModel,
  )}:batchGenerateContent`;
  if (mode === "jsonl_file") {
    const fileName = await uploadGeminiJsonlRequests({ requests, displayName });
    return fetchGeminiBatchJson(url, {
      method: "POST",
      body: JSON.stringify({
        batch: {
          displayName,
          inputConfig: { fileName },
        },
      }),
      kind: "batch_create_file",
    });
  }
  return fetchGeminiBatchJson(url, {
    method: "POST",
    body: JSON.stringify({
      batch: {
        displayName,
        inputConfig: {
          requests: { requests },
        },
      },
    }),
    kind: "batch_create_inline",
  });
}

async function uploadGeminiJsonlRequests({ requests, displayName }) {
  mkdirSync(geminiBatchJsonlDir, { recursive: true });
  const jsonlPath = join(geminiBatchJsonlDir, `${displayName}.jsonl`);
  const body = requests.map((request) => JSON.stringify(geminiBatchJsonlRequest(request))).join("\n") + "\n";
  writeFileSync(jsonlPath, body, "utf8");
  const bytes = Buffer.from(body, "utf8");
  const startResponse = await fetch(
    `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${encodeURIComponent(env.GEMINI_API_KEY)}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-upload-protocol": "resumable",
        "x-goog-upload-command": "start",
        "x-goog-upload-header-content-length": String(bytes.length),
        "x-goog-upload-header-content-type": "application/jsonl",
      },
      body: JSON.stringify({
        file: {
          display_name: displayName,
          mime_type: "application/jsonl",
        },
      }),
      signal: AbortSignal.timeout(geminiCliTimeoutMs),
    },
  );
  if (!startResponse.ok) {
    throw new Error(`Gemini file upload start failed: ${startResponse.status} ${await startResponse.text().catch(() => "")}`);
  }
  const uploadUrl = startResponse.headers.get("x-goog-upload-url");
  if (!uploadUrl) throw new Error("Gemini file upload did not return x-goog-upload-url.");

  const uploadResponse = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "content-length": String(bytes.length),
      "x-goog-upload-offset": "0",
      "x-goog-upload-command": "upload, finalize",
    },
    body: bytes,
    signal: AbortSignal.timeout(geminiCliTimeoutMs),
  });
  const uploadBody = await uploadResponse.text().catch(() => "");
  if (!uploadResponse.ok) {
    throw new Error(`Gemini file upload finalize failed: ${uploadResponse.status} ${uploadBody}`);
  }
  const parsed = parseJsonObject(uploadBody) || {};
  const fileName = parsed.file?.name || parsed.name;
  if (!fileName) throw new Error(`Gemini file upload did not return a file name: ${truncate(uploadBody, 500)}`);
  return fileName;
}

async function waitForGeminiBatchJob(batchName) {
  const completedStates = new Set([
    "JOB_STATE_SUCCEEDED",
    "JOB_STATE_FAILED",
    "JOB_STATE_CANCELLED",
    "JOB_STATE_EXPIRED",
    "BATCH_STATE_SUCCEEDED",
    "BATCH_STATE_FAILED",
    "BATCH_STATE_CANCELLED",
    "BATCH_STATE_EXPIRED",
  ]);
  const deadlineAt = Date.now() + geminiBatchTimeoutMinutes * 60_000;
  let pollCount = 0;

  while (Date.now() < deadlineAt) {
    const data = await fetchGeminiBatchJson(
      `https://generativelanguage.googleapis.com/v1beta/${batchName}`,
      { method: "GET", kind: "batch_poll" },
    );
    const state = geminiBatchState(data);
    if (completedStates.has(state)) {
      console.log(`BASELINE_FACTS_BATCH completed job=${batchName} state=${state} polls=${pollCount}`);
      return data;
    }

    pollCount += 1;
    console.log(`BASELINE_FACTS_BATCH polling job=${batchName} state=${state || "unknown"} poll=${pollCount}`);
    await sleep(geminiBatchPollSeconds * 1000);
  }

  throw new Error(`Gemini batch ${batchName} did not finish within ${geminiBatchTimeoutMinutes} minutes.`);
}

async function fetchGeminiBatchJson(url, { method, body, kind }) {
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        method,
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": env.GEMINI_API_KEY,
        },
        body,
        signal: AbortSignal.timeout(geminiCliTimeoutMs),
      });
      const responseBody = await response.text().catch(() => "");
      if (response.ok) return JSON.parse(responseBody);

      const message = geminiHttpErrorMessage(response.status, responseBody);
      if (attempt < maxAttempts && isRetryableGeminiApiFailure(response.status, responseBody)) {
        const waitMs = 1_500 * attempt;
        console.log(
          `GEMINI_RETRY kind=${kind} attempt=${attempt}/${maxAttempts} wait_ms=${waitMs} message=${truncate(message, 240)}`,
        );
        await sleep(waitMs);
        continue;
      }
      recordGeminiApiBillingBlock(kind, geminiApiModel, response.status, responseBody, message);
      throw new Error(message);
    } catch (error) {
      if (attempt < maxAttempts && isRetryableGeminiNetworkFailure(error)) {
        const waitMs = 1_500 * attempt;
        console.log(
          `GEMINI_RETRY kind=${kind} attempt=${attempt}/${maxAttempts} wait_ms=${waitMs} message=${truncate(errorMessage(error), 240)}`,
        );
        await sleep(waitMs);
        continue;
      }
      throw error;
    }
  }

  throw new Error(`Gemini Batch API ${kind} failed after ${maxAttempts} attempts.`);
}

function geminiBatchJobName(data) {
  const candidates = [
    data?.name,
    data?.metadata?.name,
    data?.metadata?.batch,
    data?.response?.name,
    data?.response?.metadata?.name,
  ];
  return candidates.find((value) => typeof value === "string" && value.startsWith("batches/")) || null;
}

function geminiBatchState(data) {
  return cleanText(
    data?.metadata?.state ||
      data?.response?.state ||
      data?.state ||
      data?.metadata?.batchState ||
      data?.metadata?.batch_state,
  );
}

function extractGeminiBatchInlineResponses(data) {
  return extractGeminiBatchInlineResponsesShared(data);
}

function geminiBatchInlineResponseMap(responses) {
  return geminiBatchInlineResponseMapShared(responses);
}

async function geminiBatchResponses(data) {
  const responses = [...extractGeminiBatchInlineResponses(data)];
  for (const fileName of geminiBatchOutputFileNames(data)) {
    const text = await downloadGeminiFileText(fileName);
    for (const line of text.split(/\r?\n/)) {
      const parsed = parseJsonObject(line);
      if (parsed) responses.push(parsed);
    }
  }
  return responses;
}

async function downloadGeminiFileText(fileName) {
  const urls = [
    `https://generativelanguage.googleapis.com/v1beta/${fileName}:download?alt=media&key=${encodeURIComponent(env.GEMINI_API_KEY)}`,
    `https://generativelanguage.googleapis.com/v1beta/${fileName}?alt=media&key=${encodeURIComponent(env.GEMINI_API_KEY)}`,
  ];
  let lastError = null;
  for (const url of urls) {
    const response = await fetch(url, { method: "GET", signal: AbortSignal.timeout(geminiCliTimeoutMs) });
    const text = await response.text().catch(() => "");
    if (response.ok) return text;
    lastError = `${response.status} ${text}`;
  }
  throw new Error(`Gemini file download failed for ${fileName}: ${lastError || "unknown error"}`);
}

function geminiBatchOutputRef(data) {
  const fileNames = geminiBatchOutputFileNames(data);
  if (fileNames.length) return { files: fileNames };
  const inlineCount = extractGeminiBatchInlineResponses(data).length;
  return inlineCount ? { inline_responses: inlineCount } : null;
}

function geminiBatchErrorMessage(data) {
  const error = data?.error || data?.response?.error || data?.metadata?.error;
  if (!error) return "No error details returned.";
  return geminiInlineErrorMessage(error);
}

function geminiInlineErrorMessage(error) {
  if (typeof error === "string") return error;
  if (!error || typeof error !== "object") return String(error || "Unknown Gemini batch item error.");
  return cleanText(error.message || error.status || JSON.stringify(error));
}

async function runGeminiApiBaselineFactsAnalysis(source, capture) {
  void source;
  void capture;
  throw new Error("Immediate Gemini baseline facts analysis is disabled. Use Gemini Batch mode with gemini-2.5-flash-lite.");
}

async function generateGeminiContentJson({ model, requestBody, requestTimeoutMs, kind }) {
  void model;
  void requestBody;
  void requestTimeoutMs;
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

function isGeminiBillingOrQuotaErrorMessage(message) {
  const clean = String(message || "").toLowerCase();
  return /\b(prepay|prepayment|credits?\s+are\s+depleted|billing|resource_exhausted|quota exceeded|quota_exceeded|insufficient.*credits?)\b/.test(
    clean,
  );
}

function markReportBillingBlocked(report, message) {
  report.billing_blocked = true;
  report.blocking_reason = truncate(message, 1000);
  report.stop_reason = "gemini_billing_or_quota_blocked";
  report.gemini_usage.status = "blocked";
  report.gemini_usage.last_error = {
    message: report.blocking_reason,
    blocked: true,
    checked_at: new Date().toISOString(),
  };
  report.errors.push({
    message: report.blocking_reason,
    billing_blocked: true,
  });
}

function recordGeminiApiBillingBlock(kind, model, httpStatus, body, message) {
  const parsed = parseJsonObject(body) || {};
  const error = jsonObjectOrEmpty(parsed.error);
  const providerMessage = cleanNullable(error.message) || cleanNullable(message) || "Gemini API request failed.";
  if (!isGeminiBillingBlocked(httpStatus, providerMessage)) return;
  markGeminiBillingBlocked({
    archiveRoot,
    kind,
    model,
    httpStatus,
    providerStatus: cleanNullable(error.status),
    message: providerMessage,
  });
}

function geminiApiDailyCapReached(report) {
  if (aiProvider !== "gemini" || dailyCostCapUsd <= 0) return false;
  if (report.gemini_usage.estimated_cost_usd >= dailyCostCapUsd) return true;
  return !geminiSpendGuardStatus({
    archiveRoot,
    dailyCostCapUsd,
  }).allowed;
}

function geminiApiSubmittedCapReached(report, pendingRequests = 0) {
  if (aiProvider !== "gemini") return false;
  return submittedRequestCapReached({
    submitted: report.gemini_usage.batch_submitted_requests,
    pending: pendingRequests,
    cap: geminiApiMaxSubmittedRequests,
  });
}

function pendingGeminiBatchRequestCount(pendingChunks, chunk) {
  return pendingChunks.reduce((sum, entries) => sum + entries.length, 0) + chunk.length;
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

async function applyFactsToSupabaseSource(source, facts, metadata, capture, report = null) {
  if (!supabase) return;
  const displayTitle = facts.display_title || capture.page_title || source.title || "Source page";
  const description =
    facts.page_description ||
    facts.page_purpose ||
    facts.notes?.[0] ||
    facts.sections?.[0]?.description ||
    null;
  const { error } = await supabase
    .from("shared_award_sources")
    .update({
      display_title: displayTitle,
      page_description: description ? truncate(description, 500) : null,
      page_metadata: {
        version: 1,
        kind: "source_page_outline",
        provider: metadata.provider,
        model: metadata.model,
        generated_at: metadata.extracted_at,
        snapshot_hash: metadata.snapshot_hash,
        capture_kind: capture.kind || "webpage",
        final_url: capture.final_url || null,
        page_title: capture.page_title || null,
        baseline_facts: facts,
        baseline_facts_metadata: metadata,
      },
      page_metadata_generated_at: metadata.extracted_at,
      page_metadata_model: metadata.model,
      updated_at: new Date().toISOString(),
    })
    .eq("id", source.id)
    .eq("admin_review_status", "open");
  if (error) throw new Error(`shared_award_sources metadata update failed: ${error.message}`);
  await queueAwardReconciliationFromBaselineSource({
    source,
    report,
    reason: "baseline_facts_updated",
    priority: 60,
    metadata: {
      baseline_facts_model: metadata.model,
      baseline_facts_generated_at: metadata.extracted_at,
      award_relevance: facts.award_relevance || null,
      cycle_relevance: facts.cycle_relevance || null,
    },
  });
}

async function rejectFactsInSupabaseSource(source, facts, metadata, capture, reason, report = null) {
  if (!supabase) return;
  const displayTitle = cleanPageTitle(capture.page_title) || cleanText(source.title) || "Source page";
  const now = new Date().toISOString();
  const disposition = baselineFactsRejectionDisposition({ facts, reason });
  const existingMetadata = source.page_metadata && typeof source.page_metadata === "object" && !Array.isArray(source.page_metadata)
    ? source.page_metadata
    : {};
  const existingQualityFlags = stringArray(existingMetadata.quality_flags);
  const qualityFlags = [
    ...existingQualityFlags,
    ...stringArray(facts.quality_flags),
    ...(disposition.addSourceMismatch ? ["source-mismatch"] : []),
  ];
  const update = {
    display_title: displayTitle,
    page_description: null,
    page_metadata: {
      ...existingMetadata,
      version: 1,
      kind: "source_page_outline",
      provider: metadata.provider,
      model: metadata.model,
      generated_at: metadata.extracted_at,
      snapshot_hash: metadata.snapshot_hash,
      capture_kind: capture.kind || "webpage",
      final_url: capture.final_url || null,
      page_title: capture.page_title || null,
      baseline_facts: null,
      baseline_facts_rejected: true,
      baseline_facts_review_status: disposition.status,
      rejection_reason: reason,
      quality_flags: [...new Set(qualityFlags)],
    },
    page_metadata_generated_at: metadata.extracted_at,
    page_metadata_model: metadata.model,
    updated_at: now,
  };

  if (disposition.reviewLater) {
    update.admin_review_status = "review_later";
    update.admin_review_note = truncate(
      `Auto-cleaned by baseline facts (${reason}): Gemini classified this page as award_relevance=${facts.award_relevance}, cycle_relevance=${facts.cycle_relevance}.`,
      1000,
    );
    update.admin_reviewed_at = now;
    update.admin_reviewed_by = "awardping-baseline-facts-worker";
  }

  const { error } = await supabase
    .from("shared_award_sources")
    .update(update)
    .eq("id", source.id)
    .eq("admin_review_status", "open");
  if (error) throw new Error(`shared_award_sources rejected metadata update failed: ${error.message}`);
  await queueAwardReconciliationFromBaselineSource({
    source,
    report,
    reason: "baseline_facts_rejected",
    priority: 55,
    metadata: {
      rejection_reason: reason,
      baseline_facts_model: metadata.model,
      baseline_facts_generated_at: metadata.extracted_at,
      award_relevance: facts.award_relevance || null,
      cycle_relevance: facts.cycle_relevance || null,
    },
  });
}

async function queueAwardReconciliationFromBaselineSource({
  source,
  report,
  reason,
  priority = 100,
  metadata = {},
}) {
  if (!supabase || !source?.shared_award_id) return null;
  try {
    const result = await enqueueAwardReconciliation(supabase, {
      awardId: source.shared_award_id,
      reason,
      sourceIds: [source.id],
      priority,
      metadata: {
        ...metadata,
        queued_by: "backfill-baseline-facts",
      },
    });
    if (report) {
      if (result.queued) report.awards_queued_for_reconciliation += 1;
      else report.award_reconciliation_queue_existing += 1;
    }
    return result;
  } catch (error) {
    if (report) {
      report.award_reconciliation_queue_failed += 1;
      report.errors.push({
        source_id: source.id,
        source_url: source.url,
        message: `Award reconciliation queue failed: ${errorMessage(error)}`,
      });
    }
    return null;
  }
}

function applyFactsToBaseline(baselinePath, baseline, facts, metadata) {
  const summary = {
    ...(baseline.summary_metadata || {}),
    reason: baseline.summary_metadata?.reason || "baseline_facts_batch_test",
    updated_at: new Date().toISOString(),
    ai_provider: metadata.provider || aiProvider,
    ai_model: metadata.model || (aiProvider === "gemini" ? geminiApiModel : geminiCliModel),
    baseline_facts: facts,
    baseline_facts_metadata: metadata,
  };
  const nextBaseline = {
    ...baseline,
    summary_metadata: summary,
  };
  writeFileSync(baselinePath, JSON.stringify(nextBaseline, null, 2), "utf8");

  const metaPath = baseline.capture?.meta ? fromArchiveRelative(baseline.capture.meta) : null;
  if (metaPath && existsSync(metaPath)) {
    const meta = readJsonIfExists(metaPath) || {};
    writeFileSync(metaPath, JSON.stringify({ ...meta, baseline_facts: facts, baseline_facts_metadata: metadata }, null, 2), "utf8");
  }
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
      page_metadata_model: geminiApiModel,
    },
    { purpose: "monitoring" },
  );
  if (!quality.allowed) return { ok: false, reason: quality.reason };

  const factText = [
    facts.display_title,
    facts.award_name,
    facts.page_description,
    facts.page_purpose,
    ...evidenceQuotes,
    ...(facts.sections || []).flatMap((section) => [section.title, section.description]),
  ].join(" ");
  const expectedTokens = distinctiveSourceTokens([
    source.shared_awards?.name,
    source.title,
    capture.page_title,
  ].join(" "));
  if (!expectedTokens.length) return { ok: true };

  const factTokens = distinctiveSourceTokens(factText);
  const overlap = expectedTokens.filter((token) => factTokens.includes(token));

  if (overlap.length > 0) return { ok: true };

  if (awardRelevance !== "primary") {
    const urlTokens = distinctiveUrlTokens(source.url);
    const factIdentityTokens = distinctiveIdentityTokens(factText);
    if (urlTokens.some((token) => factIdentityTokens.includes(token))) return { ok: true };
  }

  return {
    ok: false,
    reason: `extracted facts did not match source tokens: ${expectedTokens.slice(0, 8).join(", ")}`,
  };
}

function distinctiveUrlTokens(value) {
  if (!value) return [];
  try {
    const url = new URL(value);
    return distinctiveIdentityTokens([url.hostname.replace(/^www\./i, ""), url.pathname].join(" "));
  } catch {
    return distinctiveIdentityTokens(value);
  }
}

function distinctiveIdentityTokens(value) {
  const stop = new Set([
    "about",
    "apply",
    "application",
    "applications",
    "award",
    "awards",
    "com",
    "contact",
    "edu",
    "eligibility",
    "form",
    "gov",
    "grant",
    "grants",
    "home",
    "html",
    "http",
    "https",
    "index",
    "org",
    "page",
    "pages",
    "pdf",
    "program",
    "programs",
    "scholarship",
    "scholarships",
    "source",
    "www",
  ]);
  return normalizeText(value)
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !/^\d+$/.test(token) && !stop.has(token))
    .slice(0, 18);
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
    "foundation",
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
    "sources",
    "student",
    "students",
    "college",
    "com",
    "community",
    "department",
    "edu",
    "form",
    "gov",
    "home",
    "html",
    "http",
    "https",
    "institute",
    "org",
    "official",
    "portal",
    "research",
    "school",
    "university",
    "website",
    "the",
    "and",
    "for",
    "with",
    "www",
  ]);
  return normalizeText(value)
    .split(/\s+/)
    .filter((token) => token.length >= 3 && token.length <= 40 && !stop.has(token))
    .slice(0, 18);
}

function baselineHasFacts(baseline) {
  const facts = baseline?.summary_metadata?.baseline_facts;
  if (!facts || baseline.summary_metadata.baseline_facts_metadata?.status === "failed") return false;
  return Boolean(normalizeCycleRelevance(facts.cycle_relevance) !== "unclear" || cleanNullable(facts.cycle_relevance));
}

function recordGeminiCliUsage(report, source, capture, analysis) {
  const usage = analysis.usage || {};
  report.gemini_cli_usage.calls += 1;
  if (usage.success !== false) report.gemini_cli_usage.successes += 1;
  else report.gemini_cli_usage.failures += 1;
  report.gemini_cli_usage.image_files += nonNegativeInt(usage.image_files, 0);
  report.gemini_cli_usage.view_file_calls += nonNegativeInt(usage.view_file_calls, 0);
  report.gemini_cli_usage.stream_calls += nonNegativeInt(usage.stream_calls, 0);
  report.gemini_cli_usage.elapsed_ms += nonNegativeInt(usage.elapsed_ms, 0);

  const monthPath = join(archiveRoot, "usage", `gemini-cli-${new Date().toISOString().slice(0, 7)}.jsonl`);
  mkdirSync(dirname(monthPath), { recursive: true });
  appendFileSync(
    monthPath,
    `${JSON.stringify({
      provider: "gemini-cli",
      kind: "baseline_facts_batch",
      model: geminiCliModel,
      source_id: source?.id || null,
      shared_award_id: source?.shared_award_id || null,
      source_url: source?.url || null,
      capture_kind: capture?.kind || null,
      usage,
      recorded_at: new Date().toISOString(),
      note: "CLI usage does not include account quota or token totals.",
    })}\n`,
    "utf8",
  );
}

function recordGeminiApiUsage(report, source, capture, analysis) {
  const usage = normalizeGeminiUsage(analysis.usage);
  const costMultiplier = nonNegativeNumber(analysis.cost_multiplier ?? analysis.costMultiplier, 1);
  const pricingMode = analysis.api_mode === "batch" ? "batch" : analysis.api_mode === "flex" ? "flex" : "standard";
  const estimatedCostUsd = roundUsd(estimateGeminiCostUsd(analysis.model || geminiApiModel, usage, pricingMode) * costMultiplier);
  report.gemini_usage.calls += 1;
  report.gemini_usage.prompt_tokens += usage.prompt_tokens;
  report.gemini_usage.candidates_tokens += usage.candidates_tokens;
  report.gemini_usage.total_tokens += usage.total_tokens;
  report.gemini_usage.thoughts_tokens += usage.thoughts_tokens;
  report.gemini_usage.cached_content_tokens += usage.cached_content_tokens;
  report.gemini_usage.estimated_cost_usd = roundUsd(report.gemini_usage.estimated_cost_usd + estimatedCostUsd);

  const monthPath = join(archiveRoot, "usage", `gemini-usage-${new Date().toISOString().slice(0, 7)}.jsonl`);
  mkdirSync(dirname(monthPath), { recursive: true });
  const usedAt = new Date().toISOString();
  appendFileSync(
    monthPath,
    `${JSON.stringify({
      provider: "gemini",
      kind: "baseline_facts_backfill",
      model: analysis.model || geminiApiModel,
      source_id: source?.id || null,
      shared_award_id: source?.shared_award_id || null,
      source_url: source?.url || null,
      capture_kind: capture?.kind || null,
      api_mode: analysis.api_mode || geminiApiMode,
      batch_job_name: analysis.batch_job_name || null,
      pricing_mode: pricingMode,
      cost_multiplier: costMultiplier,
      cost_note: analysis.cost_note || null,
      usage,
      estimated_cost_usd: estimatedCostUsd,
      used_at: usedAt,
      date: usedAt.slice(0, 10),
      month: usedAt.slice(0, 7),
    })}\n`,
    "utf8",
  );
}

function recordGeminiApiBatchSubmission(report, entries, batch) {
  const estimatedUsage = estimateGeminiBatchEntriesUsage(entries);
  const estimatedCostUsd = roundUsd(nonNegativeNumber(batch.estimatedCostUsd, 0));
  report.gemini_usage.batch_jobs += 1;
  report.gemini_usage.batch_requests += entries.length;
  report.gemini_usage.batch_submitted_requests += entries.length;
  report.gemini_usage.estimated_cost_usd = roundUsd(report.gemini_usage.estimated_cost_usd + estimatedCostUsd);

  const monthPath = join(archiveRoot, "usage", `gemini-usage-${new Date().toISOString().slice(0, 7)}.jsonl`);
  mkdirSync(dirname(monthPath), { recursive: true });
  const usedAt = new Date().toISOString();
  appendFileSync(
    monthPath,
    `${JSON.stringify({
      provider: "gemini",
      kind: "baseline_facts_batch_submission",
      model: geminiApiModel,
      api_mode: "batch",
      pricing_mode: "batch",
      batch_job_name: batch.batchName,
      batch_display_name: batch.displayName,
      batch_input_mode: batch.inputMode,
      request_count: entries.length,
      request_keys: entries.map((entry) => entry.source.id),
      usage: estimatedUsage,
      estimated_cost_usd: estimatedCostUsd,
      used_at: usedAt,
      date: usedAt.slice(0, 10),
      month: usedAt.slice(0, 7),
      note: "Estimated batch cost is counted at submission time so daily caps include outstanding jobs.",
    })}\n`,
    "utf8",
  );
}

function estimateGeminiBatchEntriesCostUsd(entries) {
  return estimateGeminiCostUsd(geminiApiModel, estimateGeminiBatchEntriesUsage(entries), "batch");
}

function estimateGeminiBatchEntriesUsage(entries) {
  const promptTokens = entries.reduce(
    (sum, entry) => sum + estimateTextTokens(JSON.stringify(entry.batchEntry?.request || {})),
    0,
  );
  const candidatesTokens = entries.length * Math.min(baselineFactsMaxOutputTokens, 900);
  return {
    prompt_tokens: promptTokens,
    candidates_tokens: candidatesTokens,
    total_tokens: promptTokens + candidatesTokens,
    thoughts_tokens: 0,
    cached_content_tokens: 0,
  };
}

async function startWorkerRun(report) {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("local_worker_runs")
    .insert({
      worker_name: "local-baseline-facts-worker",
      status: "running",
      ai_provider: aiProvider,
      metadata: workerMetadata(report),
    })
    .select("id")
    .maybeSingle();
  if (error) {
    console.log(`WORKER RUN LOG DISABLED | ${error.message}`);
    return null;
  }
  return data?.id || null;
}

let lastWorkerUpdateAt = 0;
let lastWorkerUpdateChecked = 0;

async function maybeUpdateWorkerRun(runId, report) {
  const now = Date.now();
  if (report.checked - lastWorkerUpdateChecked < 10 && now - lastWorkerUpdateAt < 60_000) return;
  lastWorkerUpdateChecked = report.checked;
  lastWorkerUpdateAt = now;
  await updateWorkerRun(runId, report);
}

async function updateWorkerRun(runId, report) {
  if (!runId || !supabase) return;
  const { error } = await supabase
    .from("local_worker_runs")
    .update({
      checked_count: report.checked,
      changed_count: report.applied,
      unchanged_count: report.skipped_existing,
      initial_count: report.extracted,
      failed_count: report.failed,
      metadata: workerMetadata(report),
    })
    .eq("id", runId);
  if (error) console.log(`WORKER RUN UPDATE FAILED | ${error.message}`);
}

async function finishWorkerRun(runId, status, errorMessageValue, report) {
  if (!runId || !supabase) return;
  const { error } = await supabase
    .from("local_worker_runs")
    .update({
      status,
      checked_count: report.checked,
      changed_count: report.applied,
      unchanged_count: report.skipped_existing,
      initial_count: report.extracted,
      failed_count: report.failed,
      error: errorMessageValue ? errorMessageValue.slice(0, 1000) : null,
      metadata: workerMetadata(report),
      finished_at: new Date().toISOString(),
    })
    .eq("id", runId);
  if (error) console.log(`WORKER RUN FINISH FAILED | ${error.message}`);
}

function workerMetadata(report) {
  return {
    kind: "baseline_facts",
    archive_root: report.archive_root,
    ai_model: report.ai_model,
    options: report.options,
    counts: {
      loaded_baselines: report.loaded_baselines,
      loaded_source_records: report.loaded_source_records,
      missing_local_baselines: report.missing_local_baselines,
      scanned_targets: report.scanned_targets,
      eligible_candidates: report.eligible_candidates,
      checked: report.checked,
      extracted: report.extracted,
      applied: report.applied,
      skipped_existing: report.skipped_existing,
      skipped_ineligible: report.skipped_ineligible,
      failed: report.failed,
      skip_reasons: report.skip_reasons,
    },
    visual_pipeline: {
      extraction: {
        enabled: true,
        backfill_enabled: true,
        extracted: report.extracted,
        failed: report.failed,
        skipped: report.skipped_existing + report.skipped_ineligible,
        backfilled: report.applied,
      },
    },
    gemini_usage: report.gemini_usage,
    gemini_cli_usage: report.gemini_cli_usage,
    saved_sources: report.saved_sources.slice(-20),
    errors: report.errors.slice(-20),
    stop_reason: report.stop_reason,
    billing_blocked: Boolean(report.billing_blocked),
    blocking_reason: report.blocking_reason || null,
  };
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const withoutPrefix = value.slice(2);
    const equalsIndex = withoutPrefix.indexOf("=");
    if (equalsIndex !== -1) {
      parsed[withoutPrefix.slice(0, equalsIndex)] = withoutPrefix.slice(equalsIndex + 1);
      continue;
    }
    const next = values[index + 1];
    if (next && !next.startsWith("--")) {
      parsed[withoutPrefix] = next;
      index += 1;
    } else {
      parsed[withoutPrefix] = "true";
    }
  }
  return parsed;
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

function sourceIdsFileSet(value) {
  const filePath = cleanText(value);
  if (!filePath) return null;
  const resolved = resolve(root, filePath);
  if (!existsSync(resolved)) {
    console.error(`--source-ids-file does not exist: ${resolved}`);
    process.exit(1);
  }
  const ids = readFileSync(resolved, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  return new Set(ids);
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

function selectAiProvider(requestedProvider) {
  const requested = String(requestedProvider || "auto").toLowerCase();
  if (requested === "gemini") return env.GEMINI_API_KEY ? "gemini" : null;
  if (["gemini-cli", "antigravity", "agy"].includes(requested)) return null;
  if (requested !== "auto") return null;
  if (env.GEMINI_API_KEY) return "gemini";
  return null;
}

function totalAiCalls(report) {
  return report.gemini_usage.calls + report.gemini_cli_usage.calls;
}

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function nonNegativeInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

function boundedInt(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function nonNegativeNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function readJsonIfExists(path) {
  if (!path || !existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function fromArchiveRelative(value) {
  if (!value) return null;
  if (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\")) return value;
  return join(archiveRoot, value);
}

function sourceLabel(source) {
  return `${source.shared_awards?.name || source.title || source.id} | ${source.title || source.page_type || "source"} | ${source.url}`;
}

function timestampForPath(value) {
  return new Date(value).toISOString().replace(/[:.]/g, "-");
}

function jsonObjectOrEmpty(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function parseJsonObject(text) {
  const clean = String(text || "").trim().replace(/^\uFEFF/, "");
  if (!clean) return null;

  for (const candidate of jsonObjectCandidates(clean)) {
    try {
      const parsed = JSON.parse(candidate);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch {
      // Try the next candidate.
    }
  }

  return null;
}

function jsonObjectCandidates(text) {
  const candidates = [text];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  candidates.push(...balancedJsonObjectCandidates(text));
  return [...new Set(candidates.filter(Boolean))];
}

function balancedJsonObjectCandidates(text) {
  const candidates = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }

    if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        candidates.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }

  return candidates;
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

function emptyGeminiUsage() {
  return {
    prompt_tokens: 0,
    candidates_tokens: 0,
    total_tokens: 0,
    thoughts_tokens: 0,
    cached_content_tokens: 0,
  };
}

function addGeminiUsage(left, right) {
  return {
    prompt_tokens: nonNegativeInt(left?.prompt_tokens, 0) + nonNegativeInt(right?.prompt_tokens, 0),
    candidates_tokens:
      nonNegativeInt(left?.candidates_tokens, 0) + nonNegativeInt(right?.candidates_tokens, 0),
    total_tokens: nonNegativeInt(left?.total_tokens, 0) + nonNegativeInt(right?.total_tokens, 0),
    thoughts_tokens: nonNegativeInt(left?.thoughts_tokens, 0) + nonNegativeInt(right?.thoughts_tokens, 0),
    cached_content_tokens:
      nonNegativeInt(left?.cached_content_tokens, 0) + nonNegativeInt(right?.cached_content_tokens, 0),
  };
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

function imageMimeType(filePath) {
  if (/\.png$/i.test(filePath)) return "image/png";
  if (/\.webp$/i.test(filePath)) return "image/webp";
  return "image/jpeg";
}

function estimateGeminiCostUsd(model, usage, pricingMode = "standard") {
  return estimateGeminiCostUsdByMode(model, usage, pricingMode);
}

function recordPreflightSkip(report, reason, source) {
  if (reason === "existing_complete_ai_review" || reason === "active_batch_request") {
    report.skipped_existing += 1;
  } else {
    report.skipped_ineligible += 1;
  }
  recordSkipReason(report, reason);
  if (verboseSkips) {
    console.log(`BASELINE_FACTS skipped reason=${reason} ${sourceLabel(source)}`);
  }
}

function recordSkipReason(report, reason) {
  const key = cleanSlug(reason) || "unknown";
  report.skip_reasons[key] = (report.skip_reasons[key] || 0) + 1;
}

function roundUsd(value) {
  return Math.round(nonNegativeNumber(value, 0) * 1_000_000) / 1_000_000;
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

function stringArray(value) {
  if (Array.isArray(value)) {
    return value.map((item) => cleanText(arrayItemText(item))).filter(Boolean);
  }
  const clean = cleanText(arrayItemText(value));
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

function arrayItemText(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const direct = value.text || value.value || value.summary || value.description || value.title || value.name;
  if (direct) return direct;
  const date = value.date || value.deadline || value.opening_date || value.label;
  const note = value.note || value.detail || value.details || value.event;
  if (date && note) return `${date}: ${note}`;
  if (date) return date;
  if (note) return note;
  return Object.entries(value)
    .filter((entry) => ["string", "number", "boolean"].includes(typeof entry[1]))
    .map(([key, item]) => `${key}: ${item}`)
    .join("; ");
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

function booleanOrNull(value) {
  if (typeof value === "boolean") return value;
  const clean = cleanSlug(value);
  if (["true", "yes", "1"].includes(clean)) return true;
  if (["false", "no", "0"].includes(clean)) return false;
  return null;
}

function normalizeText(value) {
  return cleanText(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function cleanPageTitle(value) {
  return cleanText(value)
    .replace(/\s+[|-]\s+US-Ireland Alliance$/i, "")
    .replace(/\s+[|-]\s+AwardPing$/i, "")
    .trim();
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").replace(/\u0000/g, "").trim().slice(0, 2_000);
}

function truncate(value, maxLength) {
  const clean = String(value || "");
  return clean.length > maxLength ? `${clean.slice(0, maxLength - 1)}...` : clean;
}

function logSnippet(value, maxLength) {
  return truncate(String(value || "").replace(/\s+/g, " ").trim(), maxLength);
}

function errorMessage(error) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) return String(error.message);
  return String(error || "Unknown error");
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

await runOnce().catch((error) => {
  console.error(`BASELINE_FACTS_FATAL ${errorMessage(error)}`);
  process.exit(1);
});
