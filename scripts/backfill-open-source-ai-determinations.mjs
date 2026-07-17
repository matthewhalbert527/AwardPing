#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  buildSourceAiCoverageRow,
  cleanText,
  countBy,
  geminiBillingBlockReason,
  objectValue,
  sortedEntries,
  summarizeAiReviewCoverage,
  workerHasGeminiBlocker,
  workerUsesGemini,
} from "./lib/ai-review-coverage.mjs";
import { enqueueAwardReconciliation } from "./lib/award-fact-reconciliation.mjs";
import {
  applyAscendingAwardKeyset,
  awardCursorAfterPage,
} from "./lib/award-keyset-pagination.mjs";
import { readGeminiBillingBlock } from "./lib/gemini-spend-guard.mjs";
import { createSupabaseServiceClient } from "./supabase-service-client.mjs";

const root = resolve(import.meta.dirname, "..");
const defaultArchiveRoot = "D:\\AwardPingVisualSnapshots";
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

const supabase = createSupabaseServiceClient(supabaseUrl, serviceRoleKey);
const archiveRoot = resolve(String(args["archive-dir"] || env.AWARDPING_VISUAL_SNAPSHOT_DIR || defaultArchiveRoot));
const apply = boolArg(args.apply, false);
const dryRun = boolArg(args["dry-run"], !apply);
const limit = nonNegativeInt(args.limit, 0);
const awardIdFilter = cleanText(args["award-id"]);
const sourceIdFilter = cleanText(args["source-id"]);
const onlyOpen = boolArg(args["only-open"], true);
const geminiApiMode = cleanSlug(args["gemini-api-mode"] || "batch") || "batch";
const maxBatchRequests = nonNegativeInt(args["max-batch-requests"], 0);
const geminiBatchMaxRequests = positiveInt(args["gemini-batch-max-requests"], 250);
const geminiBatchParallelJobs = positiveInt(args["gemini-batch-parallel-jobs"], 4);
const dailyCostCapUsd = nonNegativeNumber(
  args["daily-cost-cap-usd"] || env.AWARDPING_GEMINI_API_DAILY_COST_CAP_USD,
  5,
);
const resume = boolArg(args.resume, true);
const outputJson = boolArg(args.json, false);
const outputCsv = boolArg(args.csv, false);
const reconcile = boolArg(args.reconcile, true);
const reconcileLimit = positiveInt(args["reconcile-limit"], 500);
const forceAi = boolArg(args["force-ai"], true);
const LEGACY_PAID_SUBMISSION_RETIRED = true;
const paidSubmissionRequested =
  apply && maxBatchRequests > 0 && geminiApiMode !== "none";
if (LEGACY_PAID_SUBMISSION_RETIRED && paidSubmissionRequested) {
  console.error(
    "Open-source AI completion can no longer submit paid provider work. Run it read-only, or send genuinely new pages through the New Page Review lane.",
  );
  process.exit(2);
}
const runStamp = timestampForPath(new Date().toISOString());
const reportDir = args["report-dir"] ? resolve(root, String(args["report-dir"])) : join(root, "reports");
const reportPath = args.report
  ? resolve(root, String(args.report))
  : join(reportDir, `open-source-ai-review-coverage-backfill-${runStamp}.json`);
const latestReportPath = join(reportDir, "open-source-ai-review-coverage-backfill-latest.json");
const csvPath = join(reportDir, `open-source-ai-review-coverage-backfill-${runStamp}.csv`);
const sourceIdsPath = join(reportDir, `open-source-ai-review-coverage-backfill-source-ids-${runStamp}.txt`);
mkdirSync(reportDir, { recursive: true });

const report = {
  started_at: new Date().toISOString(),
  finished_at: null,
  status: "running",
  env_path: envPath,
  report_path: reportPath,
  dry_run: dryRun,
  apply,
  options: {
    limit: limit || null,
    award_id: awardIdFilter || null,
    source_id: sourceIdFilter || null,
    only_open: onlyOpen,
    gemini_api_mode: geminiApiMode,
    max_batch_requests: maxBatchRequests,
    gemini_batch_max_requests: geminiBatchMaxRequests,
    gemini_batch_parallel_jobs: geminiBatchParallelJobs,
    daily_cost_cap_usd: dailyCostCapUsd,
    resume,
    reconcile,
    reconcile_limit: reconcileLimit,
    force_ai: forceAi,
  },
  total_open_sources_scanned: 0,
  total_sources_scanned: 0,
  complete_accepted: 0,
  complete_rejected: 0,
  unreviewed: 0,
  incomplete: 0,
  unclear: 0,
  unrelated_but_open: 0,
  sibling_but_open: 0,
  archived_but_open: 0,
  not_program_page_but_open: 0,
  access_error_but_open: 0,
  generic_listing_but_open: 0,
  missing_cycle_relevance: 0,
  missing_evidence: 0,
  needs_capture_baseline: 0,
  review_failed: 0,
  needs_manual_review: 0,
  queued_for_capture: 0,
  queued_for_ai_review: 0,
  submitted_to_gemini_batch: 0,
  moved_to_review_later: 0,
  marked_needs_manual_review: 0,
  awards_queued_for_reconciliation: 0,
  award_reconciliation_queue_existing: 0,
  award_reconciliation_queue_failed: 0,
  awards_reconciled: 0,
  public_pages_blocked: 0,
  last_known_good_preserved: 0,
  billing_blocked: false,
  blocking_reason: null,
  completion_passed: false,
  source_ids_file: null,
  category_counts: {},
  planned_action_counts: {},
  initial_summary: null,
  final_summary: null,
  baseline_facts_worker: null,
  reconciliation_worker: null,
  rows: [],
  errors: [],
};

writeReport();
const workerRunId = await startWorkerRun().catch((error) => {
  report.errors.push({ message: `worker_run_start_failed: ${errorMessage(error)}` });
  return null;
});
let lastWorkerUpdateAt = 0;

try {
  const initial = await loadCoverage();
  report.initial_summary = initial.summary;
  const billingBlock = detectBillingBlock(initial.workerRuns.rows);
  if (billingBlock) {
    report.billing_blocked = true;
    report.blocking_reason = billingBlock;
  }

  const targetRows = filterRows(initial.rows);
  report.rows = targetRows;
  applyCategoryCounters(targetRows);
  report.total_sources_scanned = targetRows.length;
  report.total_open_sources_scanned = targetRows.filter((row) => row.admin_review_status === "open").length;
  report.queued_for_capture = targetRows.filter((row) => row.category === "needs_capture_baseline").length;
  const aiRows = targetRows.filter((row) => row.planned_action === "queue_ai_review");
  report.queued_for_ai_review = aiRows.length;

  if (apply && targetRows.length) {
    for (const row of targetRows) {
      if (row.planned_action === "move_to_review_later") await moveSourceToReviewLater(row);
      else if (row.planned_action === "queue_ai_review") await markSourceQueuedForAiReview(row);
      await maybeUpdateWorkerRun(workerRunId);
    }
  }

  if (apply && aiRows.length && maxBatchRequests > 0 && geminiApiMode !== "none") {
    await submitBaselineFactsBatch(aiRows.slice(0, maxBatchRequests));
  }

  if (apply && reconcile) await runReconciliation();

  const finalCoverage = apply ? await loadCoverage() : initial;
  report.final_summary = finalCoverage.summary;
  report.completion_passed = finalCoverage.summary.completion_passed && !report.billing_blocked;
  report.status = report.completion_passed ? "succeeded" : "completed_with_blockers";
} catch (error) {
  report.status = "failed";
  report.errors.push({ message: errorMessage(error) });
  throw error;
} finally {
  report.finished_at = new Date().toISOString();
  writeReport();
  if (outputCsv) writeCsv();
  await finishWorkerRun(workerRunId, report.status === "failed" ? "failed" : "succeeded", report.status === "failed" ? report.errors.at(-1)?.message : null).catch((error) => {
    console.warn(`AI_COVERAGE_WORKER_FINISH_FAILED ${errorMessage(error)}`);
  });
  if (outputJson) console.log(JSON.stringify(report, null, 2));
  else printHuman();
}

async function loadCoverage() {
  const [awards, sources, pageAudits, workerRuns] = await Promise.all([
    loadAwards(),
    loadSources(),
    loadLatestPageAudits(),
    loadLatestWorkerRuns(),
  ]);
  const awardById = new Map(awards.map((award) => [award.id, award]));
  const rows = sources.map((source) => buildSourceAiCoverageRow(source, awardById.get(source.shared_award_id) || null));
  return {
    awards,
    sources,
    rows,
    pageAudits,
    workerRuns,
    summary: summarizeAiReviewCoverage({ awards, rows, pageAudits: pageAudits.rows, workerRuns: workerRuns.rows }),
  };
}

async function loadAwards() {
  const rows = [];
  const pageSize = 1000;
  let cursor = null;
  for (;;) {
    let query = supabase
      .from("shared_awards")
      .select("id,name,slug,status,public_facts,public_facts_generated_at");
    if (awardIdFilter) query = query.eq("id", awardIdFilter);
    query = applyAscendingAwardKeyset(query, "name", cursor).limit(pageSize);
    const { data, error } = await query;
    if (error) throw new Error(`Load shared awards failed: ${error.message}`);
    const page = data || [];
    rows.push(...page);
    if (page.length < pageSize) break;
    cursor = awardCursorAfterPage(page, "name", cursor);
  }
  return rows;
}

async function loadSources() {
  const rows = [];
  let cursor = null;
  for (;;) {
    let query = supabase
      .from("shared_award_sources")
      .select(
        "id,shared_award_id,url,title,display_title,page_description,page_metadata,page_metadata_generated_at,page_metadata_model,page_type,source,reason,submitted_by_user_id,admin_review_status,last_checked_at,last_error,created_at",
      )
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(1000);
    if (awardIdFilter) query = query.eq("shared_award_id", awardIdFilter);
    if (sourceIdFilter) query = query.eq("id", sourceIdFilter);
    if (onlyOpen) query = query.eq("admin_review_status", "open");
    if (cursor) {
      const createdAt = JSON.stringify(cursor.createdAt);
      query = query.or(
        `created_at.gt.${createdAt},and(created_at.eq.${createdAt},id.gt.${cursor.id})`,
      );
    }
    const { data, error } = await query;
    if (error) throw new Error(`Load shared award sources failed: ${error.message}`);
    const page = data || [];
    rows.push(...page);
    if (page.length < 1000) break;
    const last = page.at(-1);
    cursor = { createdAt: last.created_at, id: last.id };
  }
  return rows;
}

async function loadLatestPageAudits() {
  const { data, error } = await supabase
    .from("shared_award_page_audits")
    .select("id,shared_award_id,audit_status,severity,resolved_at,created_at")
    .order("created_at", { ascending: false })
    .limit(2000);
  if (error) return { rows: [], error: error.message };
  return { rows: data || [], error: null };
}

async function loadLatestWorkerRuns() {
  const { data, error } = await supabase
    .from("local_worker_runs")
    .select("id,worker_name,status,ai_provider,checked_count,changed_count,failed_count,error,metadata,started_at,finished_at")
    .order("started_at", { ascending: false })
    .limit(150);
  if (error) return { rows: [], error: error.message };
  return { rows: data || [], error: null };
}

function filterRows(rows) {
  const selected = rows.filter((row) => categoryFilterAllows(row));
  return limit > 0 ? selected.slice(0, limit) : selected;
}

function categoryFilterAllows(row) {
  if (boolArg(args["only-unreviewed"], false)) return row.category === "unreviewed" || row.category === "needs_capture_baseline";
  if (boolArg(args["only-incomplete"], false)) return row.category === "incomplete_review";
  if (boolArg(args["only-unclear"], false)) return row.category === "unclear" || row.category === "needs_manual_review";
  if (boolArg(args["only-unrelated"], false)) return row.category === "unrelated_but_open";
  if (boolArg(args["only-missing-cycle-relevance"], false)) return row.category === "missing_cycle_relevance";
  return true;
}

function applyCategoryCounters(rows) {
  const categoryCounts = countBy(rows, (row) => row.category);
  report.category_counts = categoryCounts;
  report.planned_action_counts = countBy(rows, (row) => row.planned_action);
  report.complete_accepted = categoryCounts.complete_accepted || 0;
  report.complete_rejected = categoryCounts.complete_rejected || 0;
  report.unreviewed = categoryCounts.unreviewed || 0;
  report.incomplete = categoryCounts.incomplete_review || 0;
  report.unclear = categoryCounts.unclear || 0;
  report.unrelated_but_open = categoryCounts.unrelated_but_open || 0;
  report.sibling_but_open = categoryCounts.sibling_but_open || 0;
  report.archived_but_open = categoryCounts.archived_but_open || 0;
  report.not_program_page_but_open = categoryCounts.not_program_page_but_open || 0;
  report.access_error_but_open = categoryCounts.access_error_but_open || 0;
  report.generic_listing_but_open = categoryCounts.generic_listing_but_open || 0;
  report.missing_cycle_relevance = categoryCounts.missing_cycle_relevance || 0;
  report.missing_evidence = categoryCounts.missing_evidence || 0;
  report.needs_capture_baseline = categoryCounts.needs_capture_baseline || 0;
  report.review_failed = categoryCounts.review_failed || 0;
  report.needs_manual_review = categoryCounts.needs_manual_review || 0;
}

async function moveSourceToReviewLater(row) {
  const source = await loadSourceById(row.source_id);
  if (!source) return;
  const now = new Date().toISOString();
  const metadata = objectValue(source.page_metadata);
  const note = truncate(`AI coverage backfill moved source out of open: ${row.category}; ${row.action_reason || row.rejection_reason || row.source_quality_reason || "not eligible"}.`, 1000);
  const { error } = await supabase
    .from("shared_award_sources")
    .update({
      admin_review_status: "review_later",
      admin_review_note: note,
      admin_reviewed_at: now,
      admin_reviewed_by: "open-source-ai-coverage-backfill",
      page_metadata: {
        ...metadata,
        ai_review_coverage_backfill: {
          at: now,
          action: "move_to_review_later",
          category: row.category,
          previous_admin_review_status: source.admin_review_status || null,
          reason: row.action_reason || row.rejection_reason || row.source_quality_reason || null,
        },
      },
      updated_at: now,
    })
    .eq("id", row.source_id)
    .eq("admin_review_status", "open");
  if (error) throw new Error(`Move source ${row.source_id} to review_later failed: ${error.message}`);
  report.moved_to_review_later += 1;
  if (row.category === "unclear" || row.category === "needs_manual_review") report.marked_needs_manual_review += 1;
  await queueAward(row, `source_rejected_${row.category}`);
}

async function markSourceQueuedForAiReview(row) {
  const source = await loadSourceById(row.source_id);
  if (!source) return;
  const now = new Date().toISOString();
  const metadata = objectValue(source.page_metadata);
  const { error } = await supabase
    .from("shared_award_sources")
    .update({
      page_metadata: {
        ...metadata,
        ai_review_coverage_backfill: {
          at: now,
          action: "queue_ai_review",
          category: row.category,
          reason: row.action_reason || row.rejection_reason || null,
        },
      },
      updated_at: now,
    })
    .eq("id", row.source_id)
    .eq("admin_review_status", "open");
  if (error) throw new Error(`Mark source ${row.source_id} queued for AI review failed: ${error.message}`);
  await queueAward(row, `source_review_queued_${row.category}`);
}

async function loadSourceById(sourceId) {
  const { data, error } = await supabase
    .from("shared_award_sources")
    .select("id,shared_award_id,admin_review_status,page_metadata")
    .eq("id", sourceId)
    .maybeSingle();
  if (error) throw new Error(`Load source ${sourceId} failed: ${error.message}`);
  return data || null;
}

async function queueAward(row, reason) {
  if (!row.award_id) return;
  try {
    const result = await enqueueAwardReconciliation(supabase, {
      awardId: row.award_id,
      reason: `backfill_ai_review_coverage_${reason}`,
      sourceIds: [row.source_id].filter(Boolean),
      priority: 50,
      metadata: {
        queued_by: "backfill-open-source-ai-determinations",
        source_category: row.category,
        source_ai_status: row.ai_status,
      },
    });
    if (result.queued) report.awards_queued_for_reconciliation += 1;
    else report.award_reconciliation_queue_existing += 1;
  } catch (error) {
    report.award_reconciliation_queue_failed += 1;
    report.errors.push({ source_id: row.source_id, message: `reconciliation_queue_failed: ${errorMessage(error)}` });
  }
}

async function submitBaselineFactsBatch(rows) {
  if (report.billing_blocked) return;
  if (!env.GEMINI_API_KEY) {
    report.billing_blocked = true;
    report.blocking_reason = "missing_gemini_api_key_for_batch_submission";
    return;
  }
  const ids = rows.map((row) => row.source_id).filter(Boolean);
  if (!ids.length) return;
  writeFileSync(sourceIdsPath, `${ids.join("\n")}\n`, "utf8");
  report.source_ids_file = sourceIdsPath;
  const baselineArgs = [
    join(root, "scripts", "backfill-baseline-facts.mjs"),
    `--env=${envPath}`,
    "--ai-provider=gemini",
    "--gemini-api-mode=batch",
    `--gemini-api-max-requests=${ids.length}`,
    `--gemini-api-max-submitted-requests=${ids.length}`,
    `--gemini-batch-max-requests=${Math.min(ids.length, geminiBatchMaxRequests)}`,
    `--gemini-batch-parallel-jobs=${geminiBatchParallelJobs}`,
    `--gemini-api-daily-cost-cap-usd=${dailyCostCapUsd}`,
    `--limit=${ids.length}`,
    `--source-ids-file=${sourceIdsPath}`,
    `--apply=${apply ? "true" : "false"}`,
    `--force=${forceAi ? "true" : "false"}`,
  ];
  const result = spawnSync(process.execPath, baselineArgs, {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  report.baseline_facts_worker = {
    command: `${process.execPath} ${baselineArgs.map(shellQuote).join(" ")}`,
    status: result.status,
    signal: result.signal,
    stdout_tail: tail(result.stdout, 4000),
    stderr_tail: tail(result.stderr, 4000),
  };
  const latestBaselinePath = join(root, "reports", "baseline-facts-latest.json");
  if (existsSync(latestBaselinePath)) {
    const baselineReport = readJsonIfExists(latestBaselinePath);
    report.baseline_facts_worker.report = {
      report_path: baselineReport?.report_path || latestBaselinePath,
      status: baselineReport?.status || null,
      batch_requests: baselineReport?.gemini_usage?.batch_requests || 0,
      batch_submitted_requests: baselineReport?.gemini_usage?.batch_submitted_requests || 0,
      billing_blocked: Boolean(baselineReport?.billing_blocked),
      blocking_reason: baselineReport?.blocking_reason || baselineReport?.stop_reason || null,
    };
    report.submitted_to_gemini_batch = baselineReport?.gemini_usage?.batch_submitted_requests || 0;
    const billingBlockReason = geminiBillingBlockReason(baselineReport);
    if (billingBlockReason) {
      report.billing_blocked = true;
      report.blocking_reason = billingBlockReason;
    }
  }
  if (result.status !== 0) {
    const message = `${result.stderr || result.stdout || "baseline facts worker failed"}`;
    const billingBlockReason = geminiBillingBlockReason({ provider_error: message });
    if (billingBlockReason) {
      report.billing_blocked = true;
      report.blocking_reason = truncate(billingBlockReason, 500);
      return;
    }
    throw new Error(`Baseline facts batch worker failed with status ${result.status}: ${truncate(message, 1000)}`);
  }
}

async function runReconciliation() {
  const reconcileArgs = [
    join(root, "scripts", "reconcile-impacted-award-pages.mjs"),
    `--env=${envPath}`,
    "--apply=true",
    "--only-pending=true",
    `--limit=${reconcileLimit}`,
    "--json=true",
  ];
  const result = spawnSync(process.execPath, reconcileArgs, {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  report.reconciliation_worker = {
    command: `${process.execPath} ${reconcileArgs.map(shellQuote).join(" ")}`,
    status: result.status,
    signal: result.signal,
    stdout_tail: tail(result.stdout, 4000),
    stderr_tail: tail(result.stderr, 4000),
  };
  const parsed = parseLastJsonObject(result.stdout);
  if (parsed) {
    report.awards_reconciled = parsed.awards_reconciled || 0;
    report.public_pages_blocked = parsed.awards_publication_blocked || 0;
    report.last_known_good_preserved = parsed.awards_used_last_known_good || 0;
  }
  if (result.status !== 0) throw new Error(`Reconciliation worker failed with status ${result.status}: ${truncate(result.stderr || result.stdout, 1000)}`);
}

function detectBillingBlock(workerRuns) {
  const fileBlock = readGeminiBillingBlock(archiveRoot);
  if (fileBlock) return fileBlock.message || `Gemini billing block file exists: ${fileBlock.path}`;
  const run = (workerRuns || []).find(workerUsesGemini);
  if (!workerHasGeminiBlocker(run)) return null;
  return objectValue(run.metadata).blocking_reason || objectValue(run.metadata).stop_reason || run.error || "gemini_billing_or_quota_blocker_found";
}

async function startWorkerRun() {
  if (!apply) return null;
  const { data, error } = await supabase
    .from("local_worker_runs")
    .insert({
      worker_name: "local-open-source-ai-coverage-backfill",
      status: "running",
      ai_provider: geminiApiMode === "none" ? null : "gemini",
      metadata: workerMetadata(),
    })
    .select("id")
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data?.id || null;
}

async function maybeUpdateWorkerRun(runId) {
  if (!runId) return;
  const now = Date.now();
  if (now - lastWorkerUpdateAt < 30_000) return;
  lastWorkerUpdateAt = now;
  const { error } = await supabase
    .from("local_worker_runs")
    .update({
      checked_count: report.total_sources_scanned,
      changed_count: report.moved_to_review_later,
      unchanged_count: report.complete_accepted,
      initial_count: report.queued_for_ai_review,
      failed_count: report.errors.length,
      metadata: workerMetadata(),
    })
    .eq("id", runId);
  if (error) console.warn(`AI_COVERAGE_WORKER_UPDATE_FAILED ${error.message}`);
}

async function finishWorkerRun(runId, status, errorMessageValue) {
  if (!runId) return;
  const { error } = await supabase
    .from("local_worker_runs")
    .update({
      status,
      checked_count: report.total_sources_scanned,
      changed_count: report.moved_to_review_later,
      unchanged_count: report.complete_accepted,
      initial_count: report.queued_for_ai_review,
      failed_count: report.errors.length,
      error: errorMessageValue ? errorMessageValue.slice(0, 1000) : null,
      metadata: workerMetadata(),
      finished_at: new Date().toISOString(),
    })
    .eq("id", runId);
  if (error) throw new Error(error.message);
}

function workerMetadata() {
  return {
    kind: "open_source_ai_review_coverage_backfill",
    report_path: reportPath,
    status: report.status,
    dry_run: dryRun,
    apply,
    options: report.options,
    counters: {
      total_open_sources_scanned: report.total_open_sources_scanned,
      complete_accepted: report.complete_accepted,
      complete_rejected: report.complete_rejected,
      unreviewed: report.unreviewed,
      incomplete: report.incomplete,
      unclear: report.unclear,
      unrelated_but_open: report.unrelated_but_open,
      sibling_but_open: report.sibling_but_open,
      missing_cycle_relevance: report.missing_cycle_relevance,
      queued_for_capture: report.queued_for_capture,
      queued_for_ai_review: report.queued_for_ai_review,
      submitted_to_gemini_batch: report.submitted_to_gemini_batch,
      moved_to_review_later: report.moved_to_review_later,
      awards_queued_for_reconciliation: report.awards_queued_for_reconciliation,
      awards_reconciled: report.awards_reconciled,
      public_pages_blocked: report.public_pages_blocked,
    },
    billing_blocked: report.billing_blocked,
    blocking_reason: report.blocking_reason,
    completion_passed: report.completion_passed,
  };
}

function writeReport() {
  writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
  writeFileSync(latestReportPath, JSON.stringify(report, null, 2), "utf8");
}

function writeCsv() {
  const columns = [
    "source_id",
    "award_id",
    "award_name",
    "admin_review_status",
    "category",
    "planned_action",
    "ai_status",
    "rejection_reason",
    "source_quality_reason",
    "award_relevance",
    "cycle_relevance",
    "confidence",
    "title",
    "url",
  ];
  const lines = [columns.join(",")];
  for (const row of report.rows) lines.push(columns.map((column) => csvCell(row[column])).join(","));
  writeFileSync(csvPath, `${lines.join("\n")}\n`, "utf8");
}

function printHuman() {
  console.log("Open Source AI Review Coverage Backfill");
  console.log(`Report: ${reportPath}`);
  console.log(`Mode: ${apply ? "APPLY" : "DRY RUN"}`);
  console.log(`Status: ${report.status}`);
  console.log(`Completion: ${report.completion_passed ? "PASS" : "FAIL"}`);
  console.log(`Scanned: open=${report.total_open_sources_scanned} total=${report.total_sources_scanned}`);
  console.log(`Accepted complete=${report.complete_accepted} queued_ai=${report.queued_for_ai_review} queued_capture=${report.queued_for_capture}`);
  console.log(`Moved review_later=${report.moved_to_review_later} awards_queued=${report.awards_queued_for_reconciliation}`);
  console.log(`Gemini batch submitted=${report.submitted_to_gemini_batch} billing_blocked=${report.billing_blocked}`);
  if (report.blocking_reason) console.log(`Blocking reason: ${report.blocking_reason}`);
  console.log("Category counts:");
  for (const [category, count] of sortedEntries(report.category_counts)) console.log(`  ${category}: ${count}`);
  const blockers = report.final_summary?.completion_blockers || report.initial_summary?.completion_blockers || {};
  if (Object.values(blockers).some(Boolean)) {
    console.log("Completion blockers:");
    for (const [key, value] of Object.entries(blockers)) if (value) console.log(`  ${key}: ${value}`);
  }
  if (!apply) {
    console.log("New pages that need provider review must enter the New Page Review lane:");
    console.log("  node scripts/process-new-page-review-lane.mjs --env=.env.worker.local");
  }
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

function boolArg(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  return /^(1|true|yes|y|on)$/i.test(String(value));
}

function nonNegativeInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

function nonNegativeNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function cleanSlug(value) {
  return String(value || "").trim().toLowerCase().replace(/[\s_]+/g, "-").replace(/[^a-z0-9-]+/g, "").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
}

function timestampForPath(value) {
  return String(value || new Date().toISOString()).replace(/[:.]/g, "-");
}

function readJsonIfExists(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function parseLastJsonObject(value) {
  const text = String(value || "").trim();
  const start = text.lastIndexOf("\n{");
  const jsonText = start === -1 ? text : text.slice(start + 1);
  try {
    return JSON.parse(jsonText);
  } catch {
    return null;
  }
}

function tail(value, maxLength) {
  const text = String(value || "");
  return text.length <= maxLength ? text : text.slice(text.length - maxLength);
}

function truncate(value, maxLength) {
  const clean = String(value || "").replace(/\s+/g, " ").trim();
  return clean.length <= maxLength ? clean : `${clean.slice(0, Math.max(0, maxLength - 3))}...`;
}

function errorMessage(error) {
  return error?.message || String(error || "Unknown error");
}

function shellQuote(value) {
  const text = String(value || "");
  return /\s/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
}

function csvCell(value) {
  if (Array.isArray(value)) return csvCell(value.join("|"));
  if (value === null || value === undefined) return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  if (!/[",\r\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function printHelp() {
  console.log(`Usage: node scripts/backfill-open-source-ai-determinations.mjs [options]

Legacy coverage report and deterministic source-status cleanup. This command
cannot submit provider work; genuinely new pages use New Page Review.

Options:
  --dry-run=true                         Preview changes only (default)
  --apply=true                           Apply safe cleanup/status changes
  --limit=<n>                            Limit sources scanned after filters
  --award-id=<uuid>                      Limit to one award
  --source-id=<uuid>                     Limit to one source
  --only-open=true                       Scan open sources only (default)
  --only-unreviewed                      Only unreviewed / needs baseline sources
  --only-incomplete                      Only incomplete metadata sources
  --only-unclear                         Only unclear/manual-review sources
  --only-unrelated                       Only unrelated-but-open sources
  --only-missing-cycle-relevance         Only sources missing cycle relevance
  --gemini-api-mode=none                 Explicitly keep provider submission disabled
  --max-batch-requests=0                 Required; paid legacy backfill is retired
  --reconcile=true                       Run reconciliation after applying
  --reconcile-limit=<n>                  Limit reconciliation queue processing
  --json                                 Print JSON report
  --csv                                  Write CSV detail report
  --env=<path>                           Env file path
`);
}
