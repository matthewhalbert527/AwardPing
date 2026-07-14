#!/usr/bin/env node
import { spawn } from "node:child_process";
import {
  closeSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { enqueueAwardReconciliation } from "./lib/award-fact-reconciliation.mjs";
import { geminiSpendGuardStatus } from "./lib/gemini-spend-guard.mjs";
import {
  estimateOneTimeCatchup,
  ONE_TIME_CATCHUP_BATCH_MODE,
  ONE_TIME_CATCHUP_MODEL,
  summarizeOneTimeCatchupBacklog,
} from "./lib/one-time-catchup.mjs";
import { createSupabaseServiceClient } from "./supabase-service-client.mjs";

class CatchupPausedError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "CatchupPausedError";
    this.status = status;
  }
}

const root = resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
if (boolArg(args.help, false)) {
  printHelp();
  process.exit(0);
}

const envPath = args.env
  ? resolve(root, String(args.env))
  : existsSync(resolve(root, ".env.worker.local"))
    ? resolve(root, ".env.worker.local")
    : resolve(root, ".env.local");
const env = { ...loadEnvFile(envPath), ...process.env };
const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceRoleKey) {
  console.error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  process.exit(1);
}

const apply = boolArg(args.apply, false);
const forecastOnly = boolArg(args["forecast-only"], !apply);
const resume = boolArg(args.resume, true);
const json = boolArg(args.json, false);
const pollSeconds = boundedInt(args["poll-seconds"], 120, 15, 3_600);
const maxRuntimeHours = positiveNumber(args["max-runtime-hours"], 36);
const maxNoProgressCycles = boundedInt(args["max-no-progress-cycles"], 5, 1, 20);
const dailyCostCapUsd = nonNegativeNumber(
  args["daily-cost-cap-usd"] || env.AWARDPING_GEMINI_API_DAILY_COST_CAP_USD,
  15,
);
const waitForBudgetReset = boolArg(args["wait-for-budget-reset"], true);
const sourceBatchSize = boundedInt(args["source-batch-size"], 250, 1, 500);
const sourceParallelJobs = boundedInt(args["source-parallel-jobs"], 4, 1, 8);
const sourceMaxBatchRequests = positiveInt(args["source-max-batch-requests"], 50_000);
const reconcileBatchSize = boundedInt(args["reconcile-batch-size"], 500, 1, 2_000);
const pageAuditBatchSize = boundedInt(args["page-audit-batch-size"], 100, 1, 250);
const pageAuditLimit = boundedInt(args["page-audit-limit"], 2_000, 1, 10_000);
const visualReviewLimit = boundedInt(args["visual-review-limit"], 2_000, 1, 10_000);
// R2 repair loads the current snapshot index before capture. Keep this stage
// serialized so parallel repair shards do not contend for the same Supabase
// connection path and turn transient fetch failures into false no-progress.
const visualShards = boundedInt(args["visual-shards"], 1, 1, 8);
const visualMissingBatchLimit = boundedInt(args["visual-missing-batch-limit"], 250, 1, 1_000);
const includeHousekeeping = boolArg(args["include-housekeeping"], true);
const archiveRoot = resolve(String(env.AWARDPING_VISUAL_SNAPSHOT_DIR || "D:\\AwardPingVisualSnapshots"));
const reportDir = args["report-dir"] ? resolve(root, String(args["report-dir"])) : join(root, "reports");
const statePath = args.state
  ? resolve(root, String(args.state))
  : join(reportDir, "one-time-catchup-state.json");
const reportPath = args.report
  ? resolve(root, String(args.report))
  : join(reportDir, `one-time-catchup-${timestampForPath(new Date().toISOString())}.json`);
const latestReportPath = join(reportDir, "one-time-catchup-latest.json");
const logDir = args["log-dir"]
  ? resolve(String(args["log-dir"]))
  : process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, "AwardPingWorker", "logs")
    : join(reportDir, "logs");
const lockPath = args.lock ? resolve(root, String(args.lock)) : join(reportDir, "one-time-catchup.lock");
const baselineBatchStatePath = resolve(String(
  env.AWARDPING_GEMINI_BATCH_STATE_FILE ||
  join(archiveRoot, "usage", "baseline-facts-gemini-batch-jobs.json"),
));

if (String(env.AWARDPING_GEMINI_API_MODE || "batch").toLowerCase() !== "batch") {
  console.error("One-time catch-up requires Gemini Batch mode. Immediate Gemini is disabled by policy.");
  process.exit(1);
}
if (env.AWARDPING_GEMINI_API_MODEL && env.AWARDPING_GEMINI_API_MODEL !== ONE_TIME_CATCHUP_MODEL) {
  console.error(`One-time catch-up requires ${ONE_TIME_CATCHUP_MODEL}.`);
  process.exit(1);
}
if (apply && !env.GEMINI_API_KEY) {
  console.error("GEMINI_API_KEY is required when --apply=true.");
  process.exit(1);
}

mkdirSync(reportDir, { recursive: true });
mkdirSync(logDir, { recursive: true });
const supabase = createSupabaseServiceClient(supabaseUrl, serviceRoleKey);
const startedAtMs = Date.now();
let lockFd = null;
let workerRunId = null;
let state = resume ? readJsonIfExists(statePath) : null;
if (
  !state ||
  ["succeeded", "complete", "complete_with_safe_manual_review", "forecast_only"].includes(state.status)
) {
  state = newState();
} else {
  state.resumed_at = new Date().toISOString();
  state.status = "running";
}

try {
  const initial = await liveSnapshot();
  state.initial_backlog ||= initial.summary.backlog;
  state.current_backlog = initial.summary.backlog;
  state.forecast = initial.forecast;
  state.updated_at = new Date().toISOString();
  writeState();
  printForecast(initial);

  if (forecastOnly || !apply) {
    state.status = "forecast_only";
    state.finished_at = new Date().toISOString();
    writeState();
    writeFinalReport();
    if (json) console.log(JSON.stringify(finalReport(), null, 2));
    process.exit(0);
  }

  acquireLock();
  workerRunId = await createWorkerRun();
  await runStage("health", async () => {
    await runChild("health", ["scripts/check-supabase-health.mjs", `--env=${envPath}`]);
  });
  await runStage("missing-visual-baselines-before-ai", drainMissingVisualBaselines);
  await runStage("source-ai-review", drainSourceAiReview);
  await runStage("source-quality-cleanup", async () => {
    await runChild("source-quality-cleanup", [
      "scripts/cleanup-open-sources-by-baseline-facts.mjs",
      `--env=${envPath}`,
      "--apply=true",
      "--limit=100000",
    ]);
  });
  await runStage("missing-visual-baselines-after-ai", drainMissingVisualBaselines);
  await runStage("seed-active-awards", seedAllActiveAwards);
  await runStage("award-reconciliation", drainAwardReconciliation);
  await runStage("visual-review-batch", drainVisualReviewBatch);
  await runStage("page-audit-batch", drainPageAuditBatch);
  if (includeHousekeeping) {
    await runStage("change-event-noise", async () => {
      await runChild("change-event-noise", [
        "scripts/cleanup-change-event-noise.mjs",
        `--env=${envPath}`,
        "--apply=true",
        "--limit=100000",
      ]);
    });
    await runStage("snapshot-retention", async () => {
      await runChild("snapshot-retention", [
        "scripts/prune-snapshot-history.mjs",
        `--env=${envPath}`,
        "--apply=true",
        "--keep=2",
        "--max-batches=100",
      ]);
    });
  }

  const final = await liveSnapshot();
  state.current_backlog = final.summary.backlog;
  state.completion = final.summary.completion;
  state.status = final.summary.completion.status;
  state.finished_at = new Date().toISOString();
  state.updated_at = state.finished_at;
  writeState();
  await updateWorkerRun("succeeded");
  writeFinalReport();
  printCompletion(final);
  if (json) console.log(JSON.stringify(finalReport(), null, 2));
} catch (error) {
  const paused = error instanceof CatchupPausedError;
  state.status = paused ? error.status : "failed";
  state.error = errorMessage(error);
  state.finished_at = new Date().toISOString();
  state.updated_at = state.finished_at;
  writeState();
  await updateWorkerRun(paused ? "succeeded" : "failed", errorMessage(error)).catch(() => null);
  writeFinalReport();
  console.error(`ONE_TIME_CATCHUP_${paused ? "PAUSED" : "FAILED"} ${errorMessage(error)}`);
  if (!paused) process.exitCode = 1;
} finally {
  releaseLock();
}

async function drainSourceAiReview() {
  let stagnantCycles = 0;
  for (let cycle = 1; ; cycle += 1) {
    ensureRuntimeAvailable();
    const before = await liveSnapshot();
    const beforeCount = before.summary.backlog.source_ai_reviews + before.summary.backlog.sources_to_review_later;
    if (!beforeCount) return;
    if (captureBaselineBacklog(before) > 0) await drainMissingVisualBaselines();
    await ensureGeminiBudget();

    const child = await runChild(`source-ai-review-cycle-${cycle}`, [
      "scripts/backfill-open-source-ai-determinations.mjs",
      `--env=${envPath}`,
      "--apply=true",
      "--only-open=true",
      "--gemini-api-mode=batch",
      `--max-batch-requests=${sourceMaxBatchRequests}`,
      `--gemini-batch-max-requests=${sourceBatchSize}`,
      `--gemini-batch-parallel-jobs=${sourceParallelJobs}`,
      `--daily-cost-cap-usd=${dailyCostCapUsd}`,
      "--resume=true",
      "--reconcile=false",
      "--force-ai=true",
    ]);
    const after = await liveSnapshot();
    const afterCount = after.summary.backlog.source_ai_reviews + after.summary.backlog.sources_to_review_later;
    const activeBatches = activeBaselineBatchJobs();
    const submitted = numberFromLatestReport(
      join(reportDir, "open-source-ai-review-coverage-backfill-latest.json"),
      "submitted_to_gemini_batch",
    );
    recordCycle("source-ai-review", {
      cycle,
      before: beforeCount,
      after: afterCount,
      active_batches: activeBatches,
      submitted,
      exit_code: child.exitCode,
    });
    await updateTicker("source-ai-review", after);
    if (!afterCount) return;
    if (afterCount < beforeCount) stagnantCycles = 0;
    else if (!activeBatches && !submitted) stagnantCycles += 1;
    if (stagnantCycles >= maxNoProgressCycles) {
      throw new CatchupPausedError(
        "paused_no_progress",
        `Source AI review made no progress for ${stagnantCycles} cycles; ${afterCount} sources remain.`,
      );
    }
    await sleep(pollSeconds * 1_000);
  }
}

async function drainMissingVisualBaselines() {
  let stagnantCycles = 0;
  for (let cycle = 1; ; cycle += 1) {
    ensureRuntimeAvailable();
    const before = await liveSnapshot();
    const beforeCount = captureBaselineBacklog(before);
    if (!beforeCount) return;
    await runChild(`missing-visual-baselines-${cycle}`, [
      "scripts/run-awardping-maintenance.mjs",
      `--env=${envPath}`,
      "--phases=visual-missing",
      "--apply=true",
      `--visual-shards=${visualShards}`,
      "--visual-limit=50000",
      `--visual-complete-missing-batch-limit=${visualMissingBatchLimit}`,
      "--continue-on-error=false",
    ]);
    const after = await liveSnapshot();
    const afterCount = captureBaselineBacklog(after);
    recordCycle("missing-visual-baselines", { cycle, before: beforeCount, after: afterCount });
    await updateTicker("missing-visual-baselines", after);
    if (!afterCount) return;
    stagnantCycles = afterCount < beforeCount ? 0 : stagnantCycles + 1;
    if (stagnantCycles >= 2) {
      throw new CatchupPausedError(
        "paused_missing_visuals",
        `${afterCount} monitor-eligible sources still lack visual baselines after ${cycle} repair cycles.`,
      );
    }
  }
}

async function seedAllActiveAwards() {
  const awards = await loadRows("shared_awards", "id,name,slug,status", (query) => query.eq("status", "active"));
  const activeRows = await loadRows(
    "shared_award_reconciliation_queue",
    "id,shared_award_id,status",
    (query) => query.in("status", ["pending", "processing"]),
  );
  const activeIds = new Set(activeRows.map((row) => row.shared_award_id));
  const targets = awards.filter((award) => !activeIds.has(award.id));
  let queued = 0;
  let coalesced = 0;
  await promisePool(targets, 10, async (award) => {
    const result = await enqueueAwardReconciliation(supabase, {
      awardId: award.id,
      reason: "one_time_catchup",
      priority: 20,
      metadata: {
        queued_by: "run-one-time-catchup",
        catchup_started_at: state.started_at,
      },
    });
    if (result.queued) queued += 1;
    else if (result.coalesced) coalesced += 1;
  });
  state.seed = { active_awards: awards.length, already_active: activeRows.length, queued, coalesced };
  writeState();
}

async function drainAwardReconciliation() {
  let stagnantCycles = 0;
  for (let cycle = 1; ; cycle += 1) {
    ensureRuntimeAvailable();
    const before = await countReconciliationStatus(["pending", "processing"]);
    if (!before) return;
    await runChild(`award-reconciliation-${cycle}`, [
      "scripts/reconcile-impacted-award-pages.mjs",
      `--env=${envPath}`,
      "--apply=true",
      "--only-pending=true",
      `--limit=${reconcileBatchSize}`,
      "--include-warnings=true",
    ]);
    const after = await countReconciliationStatus(["pending", "processing"]);
    recordCycle("award-reconciliation", { cycle, before, after });
    await updateTicker("award-reconciliation", await liveSnapshot());
    if (!after) return;
    stagnantCycles = after < before ? 0 : stagnantCycles + 1;
    if (stagnantCycles >= maxNoProgressCycles) {
      throw new CatchupPausedError(
        "paused_reconciliation",
        `Reconciliation made no progress for ${stagnantCycles} cycles; ${after} active rows remain.`,
      );
    }
  }
}

async function drainVisualReviewBatch() {
  let stagnantCycles = 0;
  for (let cycle = 1; ; cycle += 1) {
    ensureRuntimeAvailable();
    const before = await liveSnapshot();
    const beforeCount = before.summary.backlog.visual_review_queue;
    if (!beforeCount) return;
    await ensureGeminiBudget();
    await runChild(`visual-review-batch-${cycle}`, [
      "scripts/process-visual-review-batch.mjs",
      `--env=${envPath}`,
      `--limit=${visualReviewLimit}`,
      "--max-requests-per-batch=250",
      "--inline-threshold=100",
      "--apply=true",
    ]);
    const after = await liveSnapshot();
    const afterCount = after.summary.backlog.visual_review_queue;
    recordCycle("visual-review-batch", { cycle, before: beforeCount, after: afterCount });
    await updateTicker("visual-review-batch", after);
    if (!afterCount) return;
    stagnantCycles = afterCount < beforeCount ? 0 : stagnantCycles + 1;
    if (stagnantCycles >= maxNoProgressCycles) {
      throw new CatchupPausedError("paused_visual_review", `${afterCount} visual reviews remain queued.`);
    }
    await sleep(pollSeconds * 1_000);
  }
}

async function drainPageAuditBatch() {
  let stagnantCycles = 0;
  for (let cycle = 1; ; cycle += 1) {
    ensureRuntimeAvailable();
    await ensureGeminiBudget();
    const before = await liveSnapshot();
    const child = await runChild(`page-audit-batch-${cycle}`, [
      "scripts/process-page-audit-batch.mjs",
      `--env=${envPath}`,
      "--apply=true",
      `--limit=${pageAuditLimit}`,
      `--max-requests-per-batch=${pageAuditBatchSize}`,
    ]);
    const childReport = readReportFromOutput(child.output, /PAGE_AUDIT_BATCH_REPORT\s+(.+)$/m);
    const candidates = nonNegativeInt(childReport?.page_audit_batch_candidates, 0);
    const submitted = nonNegativeInt(childReport?.submitted_audits, 0);
    const after = await liveSnapshot();
    const inFlight = after.summary.backlog.page_audit_batch_in_flight;
    recordCycle("page-audit-batch", {
      cycle,
      candidates,
      submitted,
      reconciled: nonNegativeInt(childReport?.reconciled, 0),
      in_flight: inFlight,
    });
    await updateTicker("page-audit-batch", after);
    if (!candidates && !submitted && !inFlight) return;
    const beforeInFlight = before.summary.backlog.page_audit_batch_in_flight;
    stagnantCycles = inFlight < beforeInFlight || submitted > 0 ? 0 : stagnantCycles + 1;
    if (stagnantCycles >= maxNoProgressCycles) {
      throw new CatchupPausedError("paused_page_audit", `${inFlight} page audits remain in flight.`);
    }
    await sleep(pollSeconds * 1_000);
  }
}

async function runStage(name, action) {
  const previous = state.stages[name];
  if (resume && previous?.status === "succeeded") {
    console.log(`ONE_TIME_CATCHUP_STAGE_SKIP name=${name} reason=already_succeeded`);
    return;
  }
  state.current_stage = name;
  state.stages[name] = {
    ...(previous || {}),
    status: "running",
    started_at: previous?.started_at || new Date().toISOString(),
    finished_at: null,
    error: null,
  };
  writeState();
  await updateTicker(name, await liveSnapshot());
  console.log(`ONE_TIME_CATCHUP_STAGE_START name=${name}`);
  try {
    await action();
    state.stages[name].status = "succeeded";
    state.stages[name].finished_at = new Date().toISOString();
    state.current_stage = null;
    writeState();
    console.log(`ONE_TIME_CATCHUP_STAGE_DONE name=${name}`);
  } catch (error) {
    state.stages[name].status = error instanceof CatchupPausedError ? "paused" : "failed";
    state.stages[name].finished_at = new Date().toISOString();
    state.stages[name].error = errorMessage(error);
    writeState();
    throw error;
  }
}

async function liveSnapshot() {
  const [awards, sources, audits, queueRows, visualCandidates, visualSnapshots, workerRuns] = await Promise.all([
    loadRows("shared_awards", "id,name,slug,status,public_facts,public_facts_generated_at"),
    loadRows(
      "shared_award_sources",
      "id,shared_award_id,url,title,display_title,page_description,page_metadata,page_metadata_generated_at,page_metadata_model,page_type,source,reason,submitted_by_user_id,admin_review_status,last_checked_at,last_error,created_at",
      (query) => query.eq("admin_review_status", "open"),
    ),
    loadRows(
      "shared_award_page_audits",
      "id,shared_award_id,audit_kind,audit_status,severity,gemini_batch_name,ai_result,resolved_at,created_at",
    ),
    loadRows(
      "shared_award_reconciliation_queue",
      "id,shared_award_id,reason,status,priority,created_at,started_at,completed_at,error",
    ),
    loadRows(
      "shared_award_visual_review_candidates",
      "id,shared_award_id,shared_award_source_id,status,estimated_cost_usd,created_at",
      null,
      { optional: true },
    ),
    loadRows(
      "shared_award_source_visual_snapshots",
      "shared_award_source_id,latest_object_keys,updated_at",
      null,
      { optional: true },
    ),
    loadRows(
      "local_worker_runs",
      "id,worker_name,status,ai_provider,metadata,started_at,finished_at",
      (query) => query.eq("worker_name", "local-baseline-facts-worker").order("started_at", { ascending: false }),
      { limit: 20 },
    ),
  ]);
  const visualSnapshotSourceIds = new Set(
    visualSnapshots
      .filter((row) => objectHasKeys(row.latest_object_keys))
      .map((row) => row.shared_award_source_id),
  );
  const summary = summarizeOneTimeCatchupBacklog({
    awards,
    sources,
    pageAudits: audits,
    reconciliationQueue: queueRows,
    visualReviewCandidates: visualCandidates,
    visualSnapshotSourceIds,
  });
  const spend = geminiSpendGuardStatus({ archiveRoot, dailyCostCapUsd });
  const forecast = estimateOneTimeCatchup({
    backlog: summary.backlog,
    recentBaselineWorkerRuns: workerRuns,
    currentGeminiSpendUsd: spend.today.estimated_cost_usd,
    dailyCostCapUsd,
    sourceBatchSize,
    sourceParallelJobs,
    pageAuditBatchSize,
  });
  return { summary, forecast, spend };
}

async function loadRows(table, select, configure = null, options = {}) {
  const rows = [];
  const pageSize = 1_000;
  const limit = options.limit || 100_000;
  for (let from = 0; rows.length < limit; from += pageSize) {
    let query = supabase.from(table).select(select).range(from, Math.min(from + pageSize - 1, limit - 1));
    if (configure) query = configure(query);
    const { data, error } = await query;
    if (error) {
      if (options.optional && isMissingTableError(error)) return [];
      throw new Error(`Load ${table} failed: ${error.message}`);
    }
    const page = data || [];
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows.slice(0, limit);
}

async function countReconciliationStatus(statuses) {
  const { count, error } = await supabase
    .from("shared_award_reconciliation_queue")
    .select("id", { count: "exact", head: true })
    .in("status", statuses);
  if (error) throw new Error(`Count reconciliation queue failed: ${error.message}`);
  return count || 0;
}

async function ensureGeminiBudget() {
  const spend = geminiSpendGuardStatus({ archiveRoot, dailyCostCapUsd });
  if (spend.blocked) {
    throw new CatchupPausedError("paused_gemini_billing", spend.block?.message || "Gemini billing is blocked.");
  }
  if (!spend.capReached) return;
  if (!waitForBudgetReset) {
    throw new CatchupPausedError(
      "paused_cost_cap",
      `Gemini daily cost cap of $${dailyCostCapUsd.toFixed(2)} has been reached.`,
    );
  }
  const nextUtcDay = new Date();
  nextUtcDay.setUTCDate(nextUtcDay.getUTCDate() + 1);
  nextUtcDay.setUTCHours(0, 2, 0, 0);
  const waitMs = nextUtcDay.getTime() - Date.now();
  if (Date.now() + waitMs > startedAtMs + maxRuntimeHours * 60 * 60 * 1_000) {
    throw new CatchupPausedError("paused_cost_cap", "The next Gemini budget window is beyond max runtime.");
  }
  console.log(`ONE_TIME_CATCHUP_BUDGET_WAIT until=${nextUtcDay.toISOString()}`);
  await sleep(waitMs);
}

async function runChild(name, commandArgs) {
  ensureRuntimeAvailable();
  const logPath = join(logDir, `one-time-catchup-${timestampForPath(new Date().toISOString())}-${safePathPart(name)}.log`);
  const log = createWriteStream(logPath, { flags: "a" });
  const startedAt = new Date().toISOString();
  console.log(`ONE_TIME_CATCHUP_COMMAND_START name=${name} log=${logPath}`);
  const result = await new Promise((resolveChild, rejectChild) => {
    const child = spawn(process.execPath, commandArgs, {
      cwd: root,
      env: { ...process.env, ...env },
      windowsHide: true,
    });
    let output = "";
    const record = (chunk, target) => {
      target.write(chunk);
      log.write(chunk);
      output = `${output}${chunk}`.slice(-2_000_000);
    };
    child.stdout.on("data", (chunk) => record(chunk, process.stdout));
    child.stderr.on("data", (chunk) => record(chunk, process.stderr));
    child.once("error", rejectChild);
    child.once("exit", (code, signal) => resolveChild({ exitCode: signal ? 1 : code ?? 1, output }));
  });
  log.end();
  const entry = {
    name,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    exit_code: result.exitCode,
    log_path: logPath,
  };
  state.commands.push(entry);
  writeState();
  if (result.exitCode !== 0) throw new Error(`${name} failed with exit code ${result.exitCode}; see ${logPath}`);
  console.log(`ONE_TIME_CATCHUP_COMMAND_DONE name=${name}`);
  return result;
}

function activeBaselineBatchJobs() {
  const batchState = readJsonIfExists(baselineBatchStatePath);
  return (batchState?.jobs || []).filter((job) =>
    ["submitted", "processing", "pending", "running"].includes(String(job.status || "").toLowerCase()),
  ).length;
}

function captureBaselineBacklog(snapshot) {
  const backlog = snapshot?.summary?.backlog || {};
  return (
    nonNegativeInt(backlog.monitor_eligible_missing_visuals, 0) +
    nonNegativeInt(backlog.sources_needing_capture_baseline, 0)
  );
}

function recordCycle(stage, cycle) {
  state.cycles.push({ stage, recorded_at: new Date().toISOString(), ...cycle });
  state.cycles = state.cycles.slice(-500);
  writeState();
}

async function createWorkerRun() {
  const snapshot = await liveSnapshot();
  const { data, error } = await supabase
    .from("local_worker_runs")
    .insert({
      worker_name: "local-one-time-catchup-processor",
      status: "running",
      ai_provider: "gemini",
      initial_count: snapshot.summary.backlog.source_ai_reviews,
      metadata: workerMetadata("starting", snapshot),
    })
    .select("id")
    .maybeSingle();
  if (error) throw new Error(`Create catch-up worker run failed: ${error.message}`);
  return data?.id || null;
}

async function updateTicker(stage, snapshot) {
  state.current_stage = stage;
  state.current_backlog = snapshot.summary.backlog;
  state.forecast = snapshot.forecast;
  state.updated_at = new Date().toISOString();
  writeState();
  if (!workerRunId) return;
  const { error } = await supabase
    .from("local_worker_runs")
    .update({
      status: "running",
      checked_count: state.commands.length,
      changed_count: completedStageCount(),
      failed_count: failedStageCount(),
      metadata: workerMetadata(stage, snapshot),
    })
    .eq("id", workerRunId);
  if (error) console.warn(`ONE_TIME_CATCHUP_TICKER_FAILED ${error.message}`);
}

async function updateWorkerRun(status, errorMessageValue = null) {
  if (!workerRunId) return;
  const snapshot = await liveSnapshot().catch(() => null);
  const { error } = await supabase
    .from("local_worker_runs")
    .update({
      status,
      checked_count: state.commands.length,
      changed_count: completedStageCount(),
      failed_count: failedStageCount(),
      error: errorMessageValue,
      finished_at: new Date().toISOString(),
      metadata: workerMetadata(state.current_stage || state.status, snapshot),
    })
    .eq("id", workerRunId);
  if (error) console.warn(`ONE_TIME_CATCHUP_WORKER_FINISH_FAILED ${error.message}`);
}

function workerMetadata(stage, snapshot) {
  return {
    kind: "one_time_catchup",
    model: ONE_TIME_CATCHUP_MODEL,
    gemini_mode: ONE_TIME_CATCHUP_BATCH_MODE,
    apply,
    stage,
    pid: process.pid,
    report_path: reportPath,
    state_path: statePath,
    started_at: state.started_at,
    updated_at: new Date().toISOString(),
    completed_stages: completedStageCount(),
    total_stages: includeHousekeeping ? 11 : 9,
    backlog: snapshot?.summary?.backlog || state.current_backlog || null,
    forecast: snapshot?.forecast || state.forecast || null,
    completion: snapshot?.summary?.completion || state.completion || null,
  };
}

function acquireLock() {
  if (existsSync(lockPath)) {
    const existing = readJsonIfExists(lockPath);
    if (existing?.pid && processIsRunning(existing.pid)) {
      throw new Error(`Another one-time catch-up processor is running with PID ${existing.pid}.`);
    }
    unlinkSync(lockPath);
  }
  mkdirSync(dirname(lockPath), { recursive: true });
  lockFd = openSync(lockPath, "wx");
  writeFileSync(lockFd, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }), "utf8");
}

function releaseLock() {
  if (lockFd !== null) {
    closeSync(lockFd);
    lockFd = null;
  }
  if (existsSync(lockPath)) {
    const current = readJsonIfExists(lockPath);
    if (!current?.pid || current.pid === process.pid) unlinkSync(lockPath);
  }
}

function processIsRunning(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

function ensureRuntimeAvailable() {
  if (Date.now() - startedAtMs <= maxRuntimeHours * 60 * 60 * 1_000) return;
  throw new CatchupPausedError("paused_max_runtime", `Maximum runtime of ${maxRuntimeHours} hours reached.`);
}

function printForecast(snapshot) {
  const { backlog } = snapshot.summary;
  const forecast = snapshot.forecast;
  console.log("ONE_TIME_CATCHUP_FORECAST");
  console.log(`  open_sources=${backlog.open_sources} source_ai_reviews=${backlog.source_ai_reviews} move_review_later=${backlog.sources_to_review_later}`);
  console.log(`  monitor_sources=${backlog.monitor_eligible_sources} missing_visuals=${backlog.monitor_eligible_missing_visuals}`);
  console.log(`  active_awards=${backlog.active_awards} missing_public_facts=${backlog.awards_missing_public_facts} never_reconciled=${backlog.awards_never_reconciled}`);
  console.log(`  latest_failed_reconciliations=${backlog.reconciliation_latest_failed_awards} unresolved_audit_errors=${backlog.latest_unresolved_audit_errors}`);
  console.log(`  gemini_model=${forecast.model} mode=${forecast.gemini_mode} estimated_cost=$${forecast.estimated_total_cost_usd.toFixed(2)} range=$${forecast.estimated_cost_range_usd.low.toFixed(2)}-$${forecast.estimated_cost_range_usd.high.toFixed(2)}`);
  console.log(`  expected_time=${forecast.expected_time_hours.low}-${forecast.expected_time_hours.high}h conservative_external_batch_sla=${forecast.conservative_external_batch_sla_hours}h`);
}

function printCompletion(snapshot) {
  console.log(`ONE_TIME_CATCHUP_COMPLETE status=${snapshot.summary.completion.status}`);
  console.log(`  automated_complete=${snapshot.summary.completion.automated_complete} manual_review_items=${snapshot.summary.completion.safe_manual_review_items}`);
  console.log(`  report=${reportPath}`);
}

function newState() {
  return {
    version: 1,
    started_at: new Date().toISOString(),
    resumed_at: null,
    finished_at: null,
    updated_at: new Date().toISOString(),
    status: "running",
    current_stage: null,
    options: {
      apply,
      forecast_only: forecastOnly,
      model: ONE_TIME_CATCHUP_MODEL,
      gemini_mode: ONE_TIME_CATCHUP_BATCH_MODE,
      daily_cost_cap_usd: dailyCostCapUsd,
      poll_seconds: pollSeconds,
      max_runtime_hours: maxRuntimeHours,
      source_batch_size: sourceBatchSize,
      source_parallel_jobs: sourceParallelJobs,
      visual_shards: visualShards,
    },
    stages: {},
    commands: [],
    cycles: [],
    initial_backlog: null,
    current_backlog: null,
    forecast: null,
    completion: null,
    error: null,
  };
}

function writeState() {
  state.updated_at = new Date().toISOString();
  atomicWriteJson(statePath, state);
}

function finalReport() {
  return {
    ...state,
    report_path: reportPath,
    state_path: statePath,
  };
}

function writeFinalReport() {
  atomicWriteJson(reportPath, finalReport());
  atomicWriteJson(latestReportPath, finalReport());
}

function atomicWriteJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2), "utf8");
  renameSync(temporary, path);
}

function readReportFromOutput(output, pattern) {
  const match = String(output || "").match(pattern);
  return match?.[1] ? readJsonIfExists(match[1].trim()) : null;
}

function numberFromLatestReport(path, key) {
  return nonNegativeInt(readJsonIfExists(path)?.[key], 0);
}

async function promisePool(items, concurrency, worker) {
  let nextIndex = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await worker(items[index]);
    }
  });
  await Promise.all(runners);
}

function completedStageCount() {
  return Object.values(state.stages).filter((stage) => stage.status === "succeeded").length;
}

function failedStageCount() {
  return Object.values(state.stages).filter((stage) => ["failed", "paused"].includes(stage.status)).length;
}

function readJsonIfExists(path) {
  if (!path || !existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function loadEnvFile(path) {
  if (!path || !existsSync(path)) return {};
  const values = {};
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equalsIndex = line.indexOf("=");
    if (equalsIndex === -1) continue;
    const key = line.slice(0, equalsIndex).trim();
    let value = line.slice(equalsIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[key] = value;
  }
  return values;
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const withoutPrefix = value.slice(2);
    const equalsIndex = withoutPrefix.indexOf("=");
    if (equalsIndex !== -1) parsed[withoutPrefix.slice(0, equalsIndex)] = withoutPrefix.slice(equalsIndex + 1);
    else if (values[index + 1] && !values[index + 1].startsWith("--")) {
      parsed[withoutPrefix] = values[index + 1];
      index += 1;
    } else parsed[withoutPrefix] = "true";
  }
  return parsed;
}

function boolArg(value, fallback) {
  if (value === undefined) return fallback;
  return !["false", "0", "no", "off"].includes(String(value).trim().toLowerCase());
}

function boundedInt(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(number)));
}

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function nonNegativeInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function nonNegativeNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function objectHasKeys(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length);
}

function safePathPart(value) {
  return String(value || "phase").replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "phase";
}

function timestampForPath(value) {
  return String(value).replace(/[:.]/g, "-");
}

function isMissingTableError(error) {
  return /does not exist|schema cache|relation .* not found/i.test(error?.message || "");
}

function errorMessage(error) {
  if (error && typeof error === "object" && "message" in error) return String(error.message);
  return String(error || "Unknown error");
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function printHelp() {
  console.log(`Usage: node scripts/run-one-time-catchup.mjs [options]

Resumable one-time processor that drains AwardPing's setup/repair backlog and
returns the system to normal daily monitoring. Gemini is restricted to Batch API
with gemini-2.5-flash-lite.

Options:
  --forecast-only=true            Read live backlog and estimate time/cost (default without --apply)
  --apply=true                    Run the catch-up processor
  --resume=true                   Resume the durable state file (default)
  --daily-cost-cap-usd=15         Maximum estimated Gemini Batch spend per UTC day
  --wait-for-budget-reset=true    Wait for the next budget window when needed
  --max-runtime-hours=36          Pause safely after this runtime
  --poll-seconds=120              Poll interval for durable Gemini Batch jobs
  --source-batch-size=250         Requests per source-fact Batch job
  --source-parallel-jobs=4        Parallel source-fact Batch jobs
  --reconcile-batch-size=500      Awards reconciled per deterministic pass
  --page-audit-batch-size=100     Requests per page-audit Batch job
  --visual-shards=1               Serialized R2 missing-baseline repair shard
  --include-housekeeping=true     Suppress historical noise and prune snapshots
  --state=<path>                  Durable resume state path
  --report=<path>                 Final report path
  --env=<path>                    Worker environment file
  --json                          Print the final report JSON
`);
}
