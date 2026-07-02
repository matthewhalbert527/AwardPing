#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { runGeminiCliJsonAnalysis } from "./lib/gemini-cli-analysis.mjs";
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
const geminiCliPath = cleanText(
  args["gemini-cli-path"] ||
    env.AWARDPING_GEMINI_CLI_PATH ||
    env.GEMINI_CLI_PATH ||
    (env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "agy", "bin", "agy.exe") : "agy"),
);
const geminiCliModel = cleanText(args["gemini-cli-model"] || env.AWARDPING_GEMINI_CLI_MODEL || "Gemini 3.5 Flash (Low)");
const geminiCliWorkspaceRoot = resolve(
  String(args["gemini-cli-workspace"] || env.AWARDPING_GEMINI_CLI_WORKSPACE || join(archiveRoot, "gemini-cli-workspace", "baseline-facts")),
);
const geminiCliTimeoutMs = positiveInt(args["gemini-cli-timeout-ms"] || env.AWARDPING_GEMINI_CLI_TIMEOUT_MS, 120_000);
const geminiCliMaxCalls = nonNegativeInt(args["gemini-cli-max-calls"] || args["max-calls"] || env.AWARDPING_GEMINI_CLI_MAX_CALLS, 100);
const geminiCliSafeModels = listArg(args["gemini-cli-safe-models"] || env.AWARDPING_SAFE_GEMINI_CLI_MODELS, ["Gemini 3.5 Flash (Low)"]);
const allowUnsafeGeminiCliModel = boolArg(args["allow-unsafe-gemini-cli-model"] ?? env.AWARDPING_ALLOW_UNSAFE_GEMINI_CLI_MODEL, false);
const requestedAiProvider = String(args["ai-provider"] || env.AI_PROVIDER || "auto").toLowerCase();
const aiProvider = selectAiProvider(requestedAiProvider);
const geminiApiModel = cleanText(
  args.model ||
    env.AWARDPING_BASELINE_FACTS_GEMINI_MODEL ||
    env.GEMINI_MODEL ||
    env.GEMINI_SUMMARY_MODEL ||
    "gemini-2.5-flash-lite",
);
const geminiApiDailyCostCapUsd = nonNegativeNumber(
  args["gemini-api-daily-cost-cap-usd"] || env.AWARDPING_GEMINI_API_DAILY_COST_CAP_USD,
  10,
);
const geminiApiMode = cleanSlug(args["gemini-api-mode"] || env.AWARDPING_GEMINI_API_MODE || "batch") || "batch";
const geminiBatchMaxRequests = positiveInt(
  args["gemini-batch-max-requests"] || env.AWARDPING_GEMINI_BATCH_MAX_REQUESTS,
  250,
);
const geminiBatchParallelJobs = positiveInt(
  args["gemini-batch-parallel-jobs"] || env.AWARDPING_GEMINI_BATCH_PARALLEL_JOBS,
  4,
);
const geminiBatchMaxInlineBytes = positiveInt(
  args["gemini-batch-max-inline-mb"] || env.AWARDPING_GEMINI_BATCH_MAX_INLINE_MB,
  14,
) * 1024 * 1024;
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
const includePdf = boolArg(args["include-pdf"], true);
const includeWeb = boolArg(args["include-web"], true);
const sourceIdFilter = cleanText(args["source-id"]);
const shardCount = positiveInt(args["shard-count"], 1);
const shardIndex = nonNegativeInt(args["shard-index"], 0);
const useGeminiBatchApi = aiProvider === "gemini" && geminiApiMode !== "immediate";

if (shardIndex >= shardCount) {
  console.error(`--shard-index must be less than --shard-count. Received ${shardIndex}/${shardCount}.`);
  process.exit(1);
}

if (aiProvider === "gemini-cli" && !geminiCliPath) {
  console.error("AWARDPING_GEMINI_CLI_PATH must point to agy.exe.");
  process.exit(1);
}

if (aiProvider === "gemini" && !env.GEMINI_API_KEY) {
  console.error("GEMINI_API_KEY is required when --ai-provider=gemini.");
  process.exit(1);
}

if (!aiProvider) {
  console.error("GEMINI_API_KEY or AWARDPING_GEMINI_CLI_PATH is required for baseline facts backfill.");
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
      include_pdf: includePdf,
      include_web: includeWeb,
      source_id: sourceIdFilter || null,
      shard_count: shardCount,
      shard_index: shardIndex,
      gemini_cli_model: geminiCliModel,
      gemini_cli_safe_models: geminiCliSafeModels,
      allow_unsafe_gemini_cli_model: allowUnsafeGeminiCliModel,
      gemini_cli_max_calls: aiProvider === "gemini-cli" ? geminiCliMaxCalls || null : null,
      gemini_api_max_calls: aiProvider === "gemini" ? geminiCliMaxCalls || null : null,
      gemini_api_daily_cost_cap_usd: aiProvider === "gemini" ? geminiApiDailyCostCapUsd : null,
      gemini_api_mode: aiProvider === "gemini" ? geminiApiMode : null,
      gemini_batch_max_requests: useGeminiBatchApi ? geminiBatchMaxRequests : null,
      gemini_batch_parallel_jobs: useGeminiBatchApi ? geminiBatchParallelJobs : null,
      gemini_batch_max_inline_bytes: useGeminiBatchApi ? geminiBatchMaxInlineBytes : null,
      gemini_batch_poll_seconds: useGeminiBatchApi ? geminiBatchPollSeconds : null,
      gemini_batch_timeout_minutes: useGeminiBatchApi ? geminiBatchTimeoutMinutes : null,
    },
    loaded_baselines: 0,
    checked: 0,
    extracted: 0,
    applied: 0,
    skipped_existing: 0,
    skipped_ineligible: 0,
    failed: 0,
    stop_reason: null,
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
      batch_jobs: 0,
      batch_requests: 0,
      batch_failures: 0,
      batch_parallel_jobs: useGeminiBatchApi ? geminiBatchParallelJobs : null,
    },
    saved_sources: [],
    errors: [],
  };

  const runId = await startWorkerRun(report);
  try {
    const targets = loadBaselineTargets();
    report.loaded_baselines = targets.length;
    console.log(
      `BASELINE_FACTS loaded=${targets.length} limit=${limit} provider=${aiProvider} model="${report.ai_model}" mode=${aiProvider === "gemini" ? geminiApiMode : "interactive"} max_calls=${geminiCliMaxCalls || "none"} apply=${applyUpdates}`,
    );

    if (useGeminiBatchApi) {
      await processGeminiApiBatchTargets(targets, report, runId);
      report.status = "succeeded";
      await finishWorkerRun(runId, "succeeded", null, report);
      return;
    }

    for (const target of targets) {
      if (report.checked >= limit) break;
      if (geminiCliMaxCalls && totalAiCalls(report) >= geminiCliMaxCalls) {
        report.stop_reason = "ai_call_cap_reached";
        console.log("BASELINE_FACTS cap_reached");
        break;
      }
      if (
        aiProvider === "gemini" &&
        geminiApiDailyCostCapUsd > 0 &&
        report.gemini_usage.estimated_cost_usd >= geminiApiDailyCostCapUsd
      ) {
        report.stop_reason = "gemini_api_cost_cap_reached";
        console.log("BASELINE_FACTS gemini_api_cost_cap_reached");
        break;
      }

      const baseline = readJsonIfExists(target.baselinePath);
      const capture = captureFromBaseline(baseline);
      const source = sourceFromBaseline(baseline);
      if (!baseline || !capture || !source) {
        report.skipped_ineligible += 1;
        continue;
      }
      if (!force && baselineHasFacts(baseline)) {
        report.skipped_existing += 1;
        continue;
      }

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
          if (applyUpdates) await rejectFactsInSupabaseSource(source, facts, metadata, capture, sanity.reason);
          throw new Error(`Baseline facts rejected: ${sanity.reason}`);
        }

        if (applyUpdates) {
          applyFactsToBaseline(target.baselinePath, baseline, facts, metadata);
          await applyFactsToSupabaseSource(source, facts, metadata, capture);
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
        report.failed += 1;
        const message = errorMessage(error);
        report.errors.push({
          source_id: source.id,
          source_url: source.url,
          message,
        });
        console.log(`BASELINE_FACTS failed ${truncate(message, 800)} ${sourceLabel(source)}`);
      }

      await maybeUpdateWorkerRun(runId, report);
    }

    report.status = "succeeded";
    await finishWorkerRun(runId, "succeeded", null, report);
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

function loadBaselineTargets() {
  const sourcesRoot = join(archiveRoot, "sources");
  if (!existsSync(sourcesRoot)) return [];

  const targets = [];
  for (const entry of readdirSync(sourcesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (sourceIdFilter && entry.name !== sourceIdFilter) continue;
    if (shardCount > 1 && stableShard(entry.name, shardCount) !== shardIndex) continue;
    const baselinePath = join(sourcesRoot, entry.name, "baseline.json");
    if (!existsSync(baselinePath)) continue;

    const baseline = readJsonIfExists(baselinePath);
    const kind = baseline?.kind || (baseline?.capture?.pdf ? "pdf" : "webpage");
    if (!includePdf && kind === "pdf") continue;
    if (!includeWeb && kind !== "pdf") continue;
    targets.push({
      sourceId: entry.name,
      baselinePath,
      sortKey: [
        baselineHasFacts(baseline) ? "1" : "0",
        baseline?.source?.award_name || "",
        baseline?.source?.title || "",
        baseline?.source?.url || "",
        entry.name,
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
    meta_path: paths.metaPath,
    text: readFileSync(paths.textPath, "utf8"),
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
    shared_awards: {
      name: source.award_name || null,
    },
  };
}

function geminiCliBaselineFactsPrompt(source, capture, reason) {
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
    "{status, display_title, page_description, page_category, award_name, page_purpose, award_relevance, deadline, opening_date, award_amounts, eligibility, requirements, application_materials, how_to_apply, important_dates, documents, contacts, notes, sections, confidence, quality_flags}",
    "Use arrays for award_amounts, eligibility, requirements, application_materials, how_to_apply, important_dates, documents, contacts, notes, sections.",
    "Every important_dates item must include context plus the date, such as \"Application deadline: January 15, 2027\" or \"Award notifications: May 1\". Do not output bare dates.",
    "sections should list 0 to 5 visible scholarship concepts or page areas with {title, description, status}. Use status unchanged for baseline sections.",
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

function geminiCliBaselineFactFiles(capture) {
  return [capture.thumb_path].filter(Boolean);
}

async function processGeminiApiBatchTargets(targets, report, runId) {
  let chunk = [];
  let chunkBytes = geminiBatchEnvelopeBytes([]);
  let pendingChunks = [];

  const queueChunk = async () => {
    if (!chunk.length) return;
    pendingChunks.push(chunk);
    chunk = [];
    chunkBytes = geminiBatchEnvelopeBytes([]);

    if (pendingChunks.length >= geminiBatchParallelJobs) {
      await processGeminiApiBatchChunkGroup(pendingChunks, report, runId);
      pendingChunks = [];
    }
  };

  for (const target of targets) {
    if (report.checked >= limit) break;
    if (geminiCliMaxCalls && report.checked >= geminiCliMaxCalls) {
      report.stop_reason = "ai_call_cap_reached";
      console.log("BASELINE_FACTS cap_reached");
      break;
    }
    if (
      geminiApiDailyCostCapUsd > 0 &&
      report.gemini_usage.estimated_cost_usd >= geminiApiDailyCostCapUsd
    ) {
      report.stop_reason = "gemini_api_cost_cap_reached";
      console.log("BASELINE_FACTS gemini_api_cost_cap_reached");
      break;
    }

    const baseline = readJsonIfExists(target.baselinePath);
    const capture = captureFromBaseline(baseline);
    const source = sourceFromBaseline(baseline);
    if (!baseline || !capture || !source) {
      report.skipped_ineligible += 1;
      continue;
    }
    if (!force && baselineHasFacts(baseline)) {
      report.skipped_existing += 1;
      continue;
    }

    const batchEntry = geminiBatchEntryForBaselineFacts(source, capture);
    const batchEntryBytes = Buffer.byteLength(JSON.stringify(batchEntry), "utf8") + 2;
    if (batchEntryBytes > geminiBatchMaxInlineBytes) {
      report.failed += 1;
      const message = `Gemini batch request is too large for inline batch mode (${batchEntryBytes} bytes).`;
      report.errors.push({ source_id: source.id, source_url: source.url, message });
      console.log(`BASELINE_FACTS failed ${message} ${sourceLabel(source)}`);
      continue;
    }

    if (
      chunk.length > 0 &&
      (chunk.length >= geminiBatchMaxRequests || chunkBytes + batchEntryBytes > geminiBatchMaxInlineBytes)
    ) {
      await queueChunk();

      if (
        geminiApiDailyCostCapUsd > 0 &&
        report.gemini_usage.estimated_cost_usd >= geminiApiDailyCostCapUsd
      ) {
        report.stop_reason = "gemini_api_cost_cap_reached";
        console.log("BASELINE_FACTS gemini_api_cost_cap_reached");
        break;
      }
    }

    report.checked += 1;
    chunk.push({ target, baseline, capture, source, batchEntry });
    chunkBytes += batchEntryBytes;
  }

  if (chunk.length) {
    await queueChunk();
  }
  if (pendingChunks.length) {
    await processGeminiApiBatchChunkGroup(pendingChunks, report, runId);
  }
}

async function processGeminiApiBatchChunkGroup(chunks, report, runId) {
  if (!chunks.length) return;
  console.log(
    `BASELINE_FACTS_BATCH_GROUP submitting jobs=${chunks.length} requests=${chunks.reduce(
      (sum, entries) => sum + entries.length,
      0,
    )}`,
  );
  await Promise.all(chunks.map((entries) => processGeminiApiBatchChunkSafely(entries, report, runId)));
}

async function processGeminiApiBatchChunkSafely(entries, report, runId) {
  const maxAttempts = 6;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await processGeminiApiBatchChunk(entries, report, runId);
      return;
    } catch (error) {
      const message = errorMessage(error);
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

async function processGeminiApiBatchChunk(entries, report, runId) {
  const displayName = `awardping-baseline-facts-${timestampForPath(new Date().toISOString())}`;
  const requests = entries.map((entry) => entry.batchEntry);
  const created = await createGeminiBatchJob({ requests, displayName });
  const batchName = geminiBatchJobName(created);
  if (!batchName) {
    throw new Error(`Gemini Batch API did not return a batch name: ${truncate(JSON.stringify(created), 600)}`);
  }

  report.gemini_usage.batch_jobs += 1;
  report.gemini_usage.batch_requests += entries.length;
  console.log(`BASELINE_FACTS_BATCH submitted job=${batchName} requests=${entries.length}`);
  await maybeUpdateWorkerRun(runId, report);

  const completed = await waitForGeminiBatchJob(batchName);
  const state = geminiBatchState(completed);
  if (!["JOB_STATE_SUCCEEDED", "BATCH_STATE_SUCCEEDED"].includes(state)) {
    const message = `Gemini batch ${batchName} finished with ${state || "unknown state"}: ${geminiBatchErrorMessage(completed)}`;
    report.failed += entries.length;
    report.gemini_usage.batch_failures += entries.length;
    for (const entry of entries) {
      report.errors.push({ source_id: entry.source.id, source_url: entry.source.url, message });
    }
    console.log(`BASELINE_FACTS_BATCH failed job=${batchName} requests=${entries.length} message=${truncate(message, 500)}`);
    await maybeUpdateWorkerRun(runId, report);
    return;
  }

  const responses = extractGeminiBatchInlineResponses(completed);
  const responseByKey = geminiBatchInlineResponseMap(responses);
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
      if (inlineResponse.error) {
        throw new Error(`Gemini batch item error: ${geminiInlineErrorMessage(inlineResponse.error)}`);
      }
      const response = inlineResponse.response;
      if (!response) throw new Error("Gemini batch response did not include a generateContent response.");

      const usage = normalizeGeminiUsage(response.usageMetadata || response.usage_metadata);
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
          cost_multiplier: 0.5,
        },
      );

      if (!sanity.ok) {
        if (applyUpdates) {
          await rejectFactsInSupabaseSource(entry.source, facts, metadata, entry.capture, sanity.reason);
        }
        throw new Error(`Baseline facts rejected: ${sanity.reason}`);
      }

      if (applyUpdates) {
        applyFactsToBaseline(entry.target.baselinePath, entry.baseline, facts, metadata);
        await applyFactsToSupabaseSource(entry.source, facts, metadata, entry.capture);
        report.applied += 1;
      }
      report.extracted += 1;
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
  return {
    systemInstruction: {
      parts: [
        {
          text: "Extract a compact source-page outline for AwardPing scholarship advisors. Return strict JSON only. Keep descriptions short enough to avoid truncation. Every source page needs a readable display_title and page_description, even if it is only a contact page, FAQ, PDF, portal, news page, or unclear page. Extract only facts directly supported by the screenshot, PDF text, or normalized text.",
        },
      ],
    },
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
      maxOutputTokens: 8192,
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

async function createGeminiBatchJob({ requests, displayName }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    geminiApiModel,
  )}:batchGenerateContent`;
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
    kind: "batch_create",
  });
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
  const response = jsonObjectOrEmpty(data?.response);
  const output = jsonObjectOrEmpty(response.output || response.dest);
  const direct =
    response.inlinedResponses ||
    response.inlined_responses ||
    output.inlinedResponses ||
    output.inlined_responses ||
    data?.dest?.inlinedResponses ||
    data?.dest?.inlined_responses;
  if (Array.isArray(direct)) return direct;
  if (Array.isArray(direct?.inlinedResponses)) return direct.inlinedResponses;
  if (Array.isArray(direct?.inlined_responses)) return direct.inlined_responses;
  return [];
}

function geminiBatchInlineResponseMap(responses) {
  const mapped = new Map();
  const duplicateKeys = [];
  let missingKeys = 0;

  for (const response of responses) {
    const key = geminiBatchInlineResponseKey(response);
    if (!key) {
      missingKeys += 1;
      continue;
    }
    if (mapped.has(key)) duplicateKeys.push(key);
    mapped.set(key, response);
  }

  return { responses: mapped, missingKeys, duplicateKeys: new Set(duplicateKeys) };
}

function geminiBatchInlineResponseKey(response) {
  return cleanText(
    response?.metadata?.key ||
      response?.metadata?.request_key ||
      response?.metadata?.source_id ||
      response?.requestMetadata?.key ||
      response?.request_metadata?.key ||
      response?.key,
  );
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
  const maxJsonAttempts = 3;
  let retryUsage = emptyGeminiUsage();

  for (let attempt = 1; attempt <= maxJsonAttempts; attempt += 1) {
    const data = await generateGeminiContentJson({
      model: geminiApiModel,
      requestBody: geminiApiBaselineFactsRequest(source, capture, "baseline_facts_backfill"),
      requestTimeoutMs: geminiCliTimeoutMs,
      kind: "baseline_facts",
    });
    const usage = normalizeGeminiUsage(data.usageMetadata);
    const rawText = extractGeminiText(data);
    const parsed = parseJsonObject(rawText);
    if (parsed) {
      return {
        provider: "gemini",
        model: geminiApiModel,
        result: parsed,
        raw_text: rawText,
        usage: addGeminiUsage(retryUsage, usage),
      };
    }

    retryUsage = addGeminiUsage(retryUsage, usage);
    if (attempt < maxJsonAttempts) {
      const waitMs = 1_000 * attempt;
      console.log(
        `GEMINI_RETRY kind=baseline_facts_json attempt=${attempt}/${maxJsonAttempts} wait_ms=${waitMs} message=invalid_json raw=${logSnippet(rawText, 240)}`,
      );
      await sleep(waitMs);
      continue;
    }

    throw new Error(`Gemini API returned invalid JSON: ${truncate(rawText, 500) || "empty response"}`);
  }

  throw new Error(`Gemini API returned invalid JSON after ${maxJsonAttempts} attempts.`);
}

async function generateGeminiContentJson({ model, requestBody, requestTimeoutMs, kind }) {
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
        console.log(
          `GEMINI_RETRY kind=${kind} attempt=${attempt}/${maxAttempts} wait_ms=${waitMs} message=${truncate(message, 240)}`,
        );
        await sleep(waitMs);
        continue;
      }

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

async function applyFactsToSupabaseSource(source, facts, metadata, capture) {
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
}

async function rejectFactsInSupabaseSource(source, facts, metadata, capture, reason) {
  if (!supabase) return;
  const displayTitle = cleanPageTitle(capture.page_title) || cleanText(source.title) || "Source page";
  const { error } = await supabase
    .from("shared_award_sources")
    .update({
      display_title: displayTitle,
      page_description: null,
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
        baseline_facts_rejected: true,
        rejection_reason: reason,
        quality_flags: [...new Set([...(facts.quality_flags || []), "source-mismatch"])],
      },
      page_metadata_generated_at: metadata.extracted_at,
      page_metadata_model: metadata.model,
      updated_at: new Date().toISOString(),
    })
    .eq("id", source.id)
    .eq("admin_review_status", "open");
  if (error) throw new Error(`shared_award_sources rejected metadata update failed: ${error.message}`);
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

function baselineFactsMatchSource(source, capture, facts) {
  if (cleanSlug(facts.status) === "failed") return { ok: false, reason: "facts_status_failed" };

  const factText = [
    facts.display_title,
    facts.award_name,
    facts.page_description,
    facts.page_purpose,
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

  if (facts.award_relevance !== "primary") {
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
  return Boolean(
    baseline?.summary_metadata?.baseline_facts &&
      baseline.summary_metadata.baseline_facts_metadata?.status !== "failed",
  );
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
  const estimatedCostUsd = roundUsd(estimateGeminiCostUsd(analysis.model || geminiApiModel, usage) * costMultiplier);
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
      cost_multiplier: costMultiplier,
      usage,
      estimated_cost_usd: estimatedCostUsd,
      used_at: usedAt,
      date: usedAt.slice(0, 10),
      month: usedAt.slice(0, 7),
    })}\n`,
    "utf8",
  );
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
      checked: report.checked,
      extracted: report.extracted,
      applied: report.applied,
      skipped_existing: report.skipped_existing,
      skipped_ineligible: report.skipped_ineligible,
      failed: report.failed,
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
  if (["gemini-cli", "antigravity", "agy"].includes(requested)) return geminiCliPath ? "gemini-cli" : null;
  if (requested !== "auto") return null;
  if (env.GEMINI_API_KEY) return "gemini";
  if (geminiCliPath) return "gemini-cli";
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

function estimateGeminiCostUsd(model, usage) {
  const rates = geminiPricePerMillion(model);
  const inputTokens = usage.prompt_tokens || 0;
  const outputTokens = (usage.candidates_tokens || 0) + (usage.thoughts_tokens || 0);
  return roundUsd((inputTokens / 1_000_000) * rates.input + (outputTokens / 1_000_000) * rates.output);
}

function geminiPricePerMillion(model) {
  const name = String(model || "").toLowerCase();
  if (name.includes("3.1-flash-lite")) return { input: 0.25, output: 1.5 };
  if (name.includes("3-flash") || name.includes("3.1-flash")) return { input: 0.5, output: 3 };
  if (name.includes("2.5-flash-lite")) return { input: 0.1, output: 0.4 };
  if (name.includes("2.5-flash")) return { input: 0.3, output: 2.5 };
  if (name.includes("flash-lite")) return { input: 0.1, output: 0.4 };
  return { input: 0.3, output: 2.5 };
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
