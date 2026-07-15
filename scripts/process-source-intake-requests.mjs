#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  baselineFactsFromIntakeReview,
  buildGeminiIntakeRequest,
  captureIntakePage,
  deterministicSourceIntakeReview,
  factCandidateRowsFromIntake,
  matchSourceToExistingAward,
  normalizeGeminiIntakeResult,
  normalizeSharedAwardPageType,
  normalizeSourceIntakeUrl,
  parseJsonObject,
  sourceLikeFromIntake,
  sourceQualityForIntakeSource,
  shouldCreateNewAwardFromIntake,
  validateIntakeAiDecision,
} from "./lib/source-intake.mjs";
import { enqueueAwardReconciliation } from "./lib/award-fact-reconciliation.mjs";
import {
  extractGeminiBatchInlineResponses,
  geminiBatchInlineResponseMap,
  geminiInlineError,
  geminiInlineResponsePayload,
} from "./lib/gemini-batch-support.mjs";
import {
  geminiWorkerModel,
  normalizeGeminiBatchMode,
} from "./lib/gemini-worker-policy.mjs";
import { createSupabaseServiceClient } from "./supabase-service-client.mjs";

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
const geminiApiKey = env.GEMINI_API_KEY;
const limit = positiveInt(args.limit, 100);
const requestId = cleanNullable(args["request-id"]);
const statuses = csvList(args.status).length
  ? csvList(args.status)
  : ["pending", "queued"];
const unsupportedCaptureStatuses = statuses.filter((status) => !new Set(["pending", "queued"]).has(status));
if (unsupportedCaptureStatuses.length) {
  console.error(
    `Source intake capture only accepts pending or queued requests. Resolve ${unsupportedCaptureStatuses.join(", ")} through an explicit operator action first.`,
  );
  process.exit(1);
}
const dryRun = boolArg(args["dry-run"], !boolArg(args.apply, false));
const apply = boolArg(args.apply, !dryRun);
const geminiApiMode = normalizeGeminiBatchMode(args["gemini-api-mode"] || "batch", {
  allowNone: true,
  context: "Source intake",
});
const createAwards = boolArg(args["create-awards"], true);
const autoApproveThreshold = numberArg(args["auto-approve-threshold"], 0.85);
const manualReviewThreshold = numberArg(args["manual-review-threshold"], 0.55);
const submit = boolArg(args.submit, true);
const poll = boolArg(args.poll, true);
const pollOnly = boolArg(args["poll-only"], false);
const submitOnly = boolArg(args["submit-only"], false);
const model = geminiWorkerModel();
const maxRequestsPerBatch = positiveInt(args["max-requests-per-batch"], 100);
const requestTimeoutMs = positiveInt(args["request-timeout-ms"], 120_000);
const captureTimeoutMs = positiveInt(args["capture-timeout-ms"], 30_000);
const pollBatchLimit = positiveInt(args["poll-batch-limit"], 25);
const timeBudgetMs = positiveInt(args["time-budget-ms"], 15 * 60_000);
const deadlineAtMs = Date.now() + timeBudgetMs;
const hardDeadlineGraceMs = 2_000;
const staleInFlightMs = positiveInt(args["stale-in-flight-ms"], 30 * 60_000);
const maxBatchAgeMs = positiveInt(args["max-batch-age-ms"], 72 * 60 * 60_000);
const reportDir = args["report-dir"] ? resolve(root, String(args["report-dir"])) : join(root, "reports");
const reportPath = args.report
  ? resolve(root, String(args.report))
  : join(reportDir, `source-intake-${timestampForPath(new Date().toISOString())}.json`);
const workerRunId = randomUUID();

if (!supabaseUrl || !serviceRoleKey) {
  console.error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  process.exit(1);
}
if (geminiApiMode !== "none" && (submit || poll) && !geminiApiKey) {
  console.error("GEMINI_API_KEY is required for source intake Gemini review.");
  process.exit(1);
}

mkdirSync(reportDir, { recursive: true });
const supabase = createSupabaseServiceClient(supabaseUrl, serviceRoleKey);
const report = {
  started_at: new Date().toISOString(),
  finished_at: null,
  status: "running",
  env_path: envPath,
  report_path: reportPath,
  worker_run_id: workerRunId,
  options: {
    limit,
    request_id: requestId,
    statuses,
    dry_run: dryRun,
    apply,
    gemini_api_mode: geminiApiMode,
    create_awards: createAwards,
    auto_approve_threshold: autoApproveThreshold,
    manual_review_threshold: manualReviewThreshold,
    model,
    max_requests_per_batch: maxRequestsPerBatch,
    poll_batch_limit: pollBatchLimit,
    time_budget_ms: timeBudgetMs,
    stale_in_flight_ms: staleInFlightMs,
    max_batch_age_ms: maxBatchAgeMs,
  },
  requests_loaded: 0,
  captured: 0,
  deterministic_rejected: 0,
  deterministic_manual_review: 0,
  ai_review_pending: 0,
  ai_review_submitted: 0,
  ai_review_succeeded: 0,
  ai_review_rejected: 0,
  capture_claim_conflicts: 0,
  reconcile_claim_conflicts: 0,
  submission_claim_conflicts: 0,
  submission_claims_lost_after_batch_create: 0,
  manual_recovery_required: 0,
  stale_capture_requests_requeued: 0,
  stale_reconcile_claims_requeued: 0,
  stale_matching_requests_failed_closed: 0,
  needs_manual_review: 0,
  matched_existing_awards: 0,
  created_awards: 0,
  created_or_updated_sources: 0,
  fact_candidates_inserted: 0,
  awards_queued_for_reconciliation: 0,
  rejected: 0,
  failed: 0,
  time_budget_exhausted: false,
  hard_deadline_forced: false,
  stop_reason: null,
  stage_counts: {
    poll: { eligible: null, loaded: 0, selected: 0, attempted: 0, completed: 0, deferred: 0, windowed: true },
    capture: { eligible: null, loaded: 0, attempted: 0, completed: 0, deferred: 0, windowed: false },
    submit: { eligible: null, loaded: 0, attempted: 0, completed: 0, deferred: 0, windowed: false },
    reconcile: { eligible: null, loaded: 0, attempted: 0, completed: 0, deferred: 0, windowed: true },
  },
  batches: [],
  warnings: [],
  errors: [],
  requests: [],
};

let workerRun = null;
let hardBudgetStopStarted = false;
const hardBudgetTimer = setTimeout(() => {
  void finishHardBudgetStop();
}, Math.max(1, deadlineAtMs - Date.now() + hardDeadlineGraceMs));
hardBudgetTimer.unref();

workerRun = await createWorkerRun().catch((error) => {
  console.warn(`SOURCE_INTAKE_WORKER_RUN_UNAVAILABLE ${errorMessage(error)}`);
  return null;
});

writeReport();
try {
  if (apply && hasTimeBudget("recover_stale_in_flight")) await recoverStaleInFlightRequests();
  if (hasTimeBudget("load_backlog_counts")) await loadStageBacklogCounts();
  if (poll && !submitOnly && geminiApiMode === "batch" && hasTimeBudget("poll")) await pollSubmittedBatches();
  if (!pollOnly && !submitOnly && hasTimeBudget("capture")) await capturePendingRequests();
  if (submit && !pollOnly && geminiApiMode === "batch" && hasTimeBudget("submit")) await submitPendingAiRequests();
  report.status = finalReportStatus();
} catch (error) {
  if (isTimeBudgetExhaustion(error)) {
    report.status = finalReportStatus();
  } else {
    report.status = "failed";
    report.errors.push({ message: errorMessage(error) });
    await syncWorkerRun("failed", errorMessage(error));
    throw error;
  }
} finally {
  clearTimeout(hardBudgetTimer);
  report.finished_at = new Date().toISOString();
  writeReport();
  const workerStatus = reportStatusSucceeded(report.status) ? "succeeded" : "failed";
  await syncWorkerRun(workerStatus, workerStatus === "succeeded" ? null : reportFailureMessage());
  if (workerStatus === "failed") process.exitCode = 1;
  console.log(`SOURCE_INTAKE_REPORT ${reportPath}`);
}

async function capturePendingRequests() {
  const rows = await loadTargetRows();
  report.requests_loaded = rows.length;
  report.stage_counts.capture.loaded = rows.length;
  report.stage_counts.capture.eligible = Math.max(report.stage_counts.capture.eligible || 0, rows.length);
  for (const row of rows) {
    if (!hasTimeBudget("capture")) break;
    report.stage_counts.capture.attempted += 1;
    const completed = await processCaptureStage(row);
    if (completed) report.stage_counts.capture.completed += 1;
    writeReport();
  }
}

async function loadStageBacklogCounts() {
  let captureCountQuery = supabase
    .from("source_page_requests")
    .select("id", { count: "exact", head: true });
  captureCountQuery = requestId
    ? captureCountQuery.eq("id", requestId)
    : captureCountQuery.in("status", statuses);
  const [captureResult, submitResult] = await Promise.all([
    captureCountQuery,
    supabase
      .from("source_page_requests")
      .select("id", { count: "exact", head: true })
      .eq("status", "ai_review_pending"),
  ]);
  if (captureResult.error) {
    report.warnings.push({ stage: "capture_count", message: captureResult.error.message });
    report.stage_counts.capture.windowed = true;
  } else {
    report.stage_counts.capture.eligible = captureResult.count || 0;
  }
  if (submitResult.error) {
    report.warnings.push({ stage: "submit_count", message: submitResult.error.message });
    report.stage_counts.submit.windowed = true;
  } else {
    report.stage_counts.submit.eligible = submitResult.count || 0;
  }
}

async function recoverStaleInFlightRequests() {
  const cutoff = new Date(Date.now() - staleInFlightMs).toISOString();
  const { data, error } = await supabase
    .from("source_page_requests")
    .select("id,status,updated_at")
    .in("status", ["validating", "capturing", "ai_review_succeeded", "matching"])
    .lt("updated_at", cutoff)
    .order("updated_at", { ascending: true })
    .limit(limit);
  if (error) throw new Error(`Load stale source intake requests failed: ${error.message}`);

  for (const row of data || []) {
    if (!hasTimeBudget("recover_stale_in_flight")) break;
    const matching = row.status === "matching";
    const reconcileClaim = row.status === "ai_review_succeeded";
    const now = new Date().toISOString();
    const patch = matching
      ? {
          status: "needs_manual_review",
          status_reason: "stale_matching_failed_closed_operator_retry_required",
          worker_run_id: null,
          failed_at: now,
          error: "Source intake stopped while applying an accepted AI result. Review the partial state, then choose Rerun AI if safe.",
          updated_at: now,
        }
      : reconcileClaim
        ? {
            status: "ai_review_submitted",
            status_reason: "stale_ai_review_succeeded_claim_requeued",
            worker_run_id: null,
            failed_at: null,
            error: null,
            updated_at: now,
          }
      : {
          status: "pending",
          status_reason: `stale_${row.status}_requeued_after_worker_stop`,
          worker_run_id: null,
          failed_at: null,
          error: null,
          updated_at: now,
        };
    let recoverQuery = supabase
      .from("source_page_requests")
      .update(patch)
      .eq("id", row.id)
      .eq("status", row.status);
    recoverQuery = withObservedUpdatedAt(recoverQuery, row.updated_at);
    const { data: recovered, error: recoverError } = await recoverQuery
      .select("id")
      .maybeSingle();
    if (recoverError) throw new Error(`Recover stale source intake request ${row.id} failed: ${recoverError.message}`);
    if (!recovered) continue;
    if (matching) {
      report.stale_matching_requests_failed_closed += 1;
      report.needs_manual_review += 1;
      report.errors.push({
        request_id: row.id,
        stage: "matching",
        message: "Stale matching work was failed closed for operator review.",
      });
    } else if (reconcileClaim) {
      report.stale_reconcile_claims_requeued += 1;
    } else {
      report.stale_capture_requests_requeued += 1;
    }
  }

  const { data: staleClaims, error: staleClaimError } = await supabase
    .from("source_page_requests")
    .select("id,ai_review")
    .eq("status", "needs_manual_review")
    .eq("status_reason", "gemini_batch_submission_in_progress_fail_closed")
    .lt("updated_at", cutoff)
    .order("updated_at", { ascending: true })
    .limit(limit);
  if (staleClaimError) throw new Error(`Load stale source intake submission claims failed: ${staleClaimError.message}`);
  for (const row of staleClaims || []) {
    if (!hasTimeBudget("recover_stale_submission_claims")) break;
    const now = new Date().toISOString();
    const { data: recovered, error: recoverError } = await supabase
      .from("source_page_requests")
      .update({
        status_reason: "manual_recovery_required_possible_external_batch_created",
        ai_review: {
          ...objectValue(row.ai_review),
          submission_claim_failed_closed_at: now,
          possible_external_batch_error: "Worker stopped before Gemini Batch creation could be confirmed.",
        },
        failed_at: now,
        error: "Worker stopped during Gemini Batch creation. Inspect the recorded display name; generic retry is blocked to prevent duplicate spend.",
        updated_at: now,
      })
      .eq("id", row.id)
      .eq("status", "needs_manual_review")
      .eq("status_reason", "gemini_batch_submission_in_progress_fail_closed")
      .select("id")
      .maybeSingle();
    if (recoverError) throw new Error(`Recover stale source intake submission claim ${row.id} failed: ${recoverError.message}`);
    if (!recovered) continue;
    report.manual_recovery_required += 1;
    report.needs_manual_review += 1;
    report.errors.push({
      request_id: row.id,
      stage: "source_intake_batch_submission_claim",
      message: "Stale Gemini Batch submission claim was failed closed for operator recovery.",
    });
  }
}

async function loadTargetRows() {
  let query = supabase
    .from("source_page_requests")
    .select("*")
    .order("updated_at", { ascending: true })
    .limit(limit);
  if (requestId) query = query.eq("id", requestId);
  query = query.in("status", statuses);
  const { data, error } = await query;
  if (error) throw new Error(`Load source intake requests failed: ${error.message}`);
  return data || [];
}

async function processCaptureStage(row) {
  const summary = {
    id: row.id,
    submitted_url: row.submitted_url || row.homepage_url,
    status: "processing",
    reason: null,
  };
  report.requests.push(summary);
  let ownedStatus = null;

  try {
    if (apply) {
      const claimed = await claimIdleRequest(row);
      if (!claimed) {
        report.capture_claim_conflicts += 1;
        summary.status = "skipped";
        summary.reason = "request_changed_before_capture_claim";
        return false;
      }
      row = claimed;
      ownedStatus = "validating";
    }
    const normalizedUrl = normalizeSourceIntakeUrl(row.normalized_url || row.homepage_url || row.submitted_url);
    if (apply) {
      row = await requireOwnedRequestUpdate(row.id, "validating", {
        normalized_url: normalizedUrl,
        homepage_url: normalizedUrl,
        submitted_url: row.submitted_url || row.homepage_url || normalizedUrl,
        status: "capturing",
      });
      ownedStatus = "capturing";
    }

    const capture = await captureIntakePage(normalizedUrl, { timeoutMs: captureTimeoutMs });
    report.captured += 1;
    const deterministicReview = deterministicSourceIntakeReview({
      url: capture.canonical_url || capture.final_url || normalizedUrl,
      title: capture.title,
      text: capture.text,
      requestedAwardName: row.award_name,
      contentType: capture.content_type,
    });
    summary.reason = deterministicReview.reason;

    const captureMetadata = {
      ...capture,
      text_excerpt: String(capture.text || "").slice(0, 20_000),
      text_length: String(capture.text || "").length,
      links: undefined,
      pdf_links: undefined,
    };
    const discoveredLinks = {
      links: capture.links || [],
      pdf_links: capture.pdf_links || [],
    };

    if (apply) {
      await requireOwnedRequestUpdate(row.id, "capturing", {
        normalized_url: deterministicReview.normalizedUrl || capture.canonical_url || normalizedUrl,
        detected_award_name: row.detected_award_name || null,
        deterministic_review: deterministicReview,
        capture_metadata: captureMetadata,
        discovered_links: discoveredLinks,
      });
    }

    if (deterministicReview.status === "rejected") {
      report.deterministic_rejected += 1;
      report.rejected += 1;
      summary.status = "rejected";
      if (apply) {
        await requireOwnedRequestUpdate(row.id, "capturing", {
          status: "rejected",
          status_reason: deterministicReview.reason,
          worker_run_id: null,
          processed_at: new Date().toISOString(),
        });
      }
      return true;
    }

    if (deterministicReview.status === "needs_manual_review") {
      report.deterministic_manual_review += 1;
      report.needs_manual_review += 1;
      summary.status = "needs_manual_review";
      if (apply) {
        await requireOwnedRequestUpdate(row.id, "capturing", {
          status: "needs_manual_review",
          status_reason: deterministicReview.reason,
          worker_run_id: null,
          processed_at: new Date().toISOString(),
        });
      }
      return true;
    }

    if (geminiApiMode === "none") {
      report.needs_manual_review += 1;
      summary.status = "needs_manual_review";
      if (apply) {
        await requireOwnedRequestUpdate(row.id, "capturing", {
          status: "needs_manual_review",
          status_reason: "gemini_review_disabled",
          worker_run_id: null,
          processed_at: new Date().toISOString(),
        });
      }
      return true;
    }

    report.ai_review_pending += 1;
    summary.status = "ai_review_pending";
    if (apply) {
      await requireOwnedRequestUpdate(row.id, "capturing", {
        status: "ai_review_pending",
        status_reason: "ready_for_gemini_batch_review",
        worker_run_id: null,
      });
    }
    return true;
  } catch (error) {
    if (isSourceIntakeOwnershipLost(error)) {
      report.capture_claim_conflicts += 1;
      summary.status = "skipped";
      summary.reason = errorMessage(error);
      report.warnings.push({ request_id: row.id, stage: "capture_ownership", message: errorMessage(error) });
      return false;
    }
    report.failed += 1;
    summary.status = "failed";
    summary.reason = errorMessage(error);
    report.errors.push({ request_id: row.id, message: errorMessage(error) });
    let failurePersisted = !apply;
    if (apply && ownedStatus) {
      try {
        const failed = await updateOwnedRequest(row.id, ownedStatus, {
          status: "failed",
          status_reason: "source_intake_processing_failed",
          worker_run_id: null,
          failed_at: new Date().toISOString(),
          error: errorMessage(error).slice(0, 1000),
        });
        failurePersisted = Boolean(failed);
        if (!failed) {
          report.warnings.push({
            request_id: row.id,
            stage: "capture_failure_persistence",
            message: "Capture failed after request ownership changed; the newer request state was preserved.",
          });
        }
      } catch (updateError) {
        report.errors.push({
          request_id: row.id,
          stage: "capture_failure_persistence",
          message: errorMessage(updateError),
        });
      }
    }
    return failurePersisted;
  }
}

async function submitPendingAiRequests() {
  const { data, error } = await supabase
    .from("source_page_requests")
    .select("*")
    .eq("status", "ai_review_pending")
    .order("updated_at", { ascending: true })
    .limit(limit);
  if (error) throw new Error(`Load pending source intake AI reviews failed: ${error.message}`);

  const rows = data || [];
  report.stage_counts.submit.loaded = rows.length;
  report.stage_counts.submit.eligible = Math.max(report.stage_counts.submit.eligible || 0, rows.length);
  for (const chunk of chunks(rows, maxRequestsPerBatch)) {
    if (!hasTimeBudget("submit")) break;
    report.stage_counts.submit.attempted += chunk.length;
    report.stage_counts.submit.completed += await submitAiReviewChunk(chunk);
  }
}

async function submitAiReviewChunk(rows) {
  if (!rows.length) return 0;
  const claimToken = randomUUID();
  const claimedAt = new Date().toISOString();
  const displayName = `awardping-source-intake-${timestampForPath(claimedAt)}-${claimToken.slice(0, 8)}-${model.replace(/[^a-z0-9._-]+/gi, "-")}`;
  const claimedRows = await claimSourceIntakeSubmissionRows(rows, {
    claimToken,
    claimedAt,
    displayName,
  });
  if (!claimedRows.length) return 0;

  const requests = claimedRows.map((row) => {
    const capture = captureFromRow(row);
    const deterministicReview = objectValue(row.deterministic_review);
    return buildGeminiIntakeRequest(row, capture, deterministicReview, model);
  });
  if (!apply) {
    report.batches.push({
      name: null,
      model,
      requested_requests: claimedRows.length,
      submitted_requests: 0,
      display_name: displayName,
      mode: "dry_run",
    });
    return claimedRows.length;
  }

  let batch;
  try {
    batch = await fetchGeminiJson(geminiBatchUrl(model), {
      method: "POST",
      body: JSON.stringify({ batch: { displayName, inputConfig: { requests: { requests } } } }),
      kind: "source_intake_batch_create",
    });
  } catch (error) {
    await failSourceIntakeSubmissionClaimsClosed(claimedRows, claimToken, displayName, error);
    throw error;
  }
  const batchName = geminiBatchJobName(batch);
  if (!batchName) {
    const error = new Error(`Gemini source intake batch did not return a batch name: ${JSON.stringify(batch).slice(0, 500)}`);
    await failSourceIntakeSubmissionClaimsClosed(claimedRows, claimToken, displayName, error);
    throw error;
  }

  const now = new Date().toISOString();
  let submittedRequests = 0;
  let completedRequests = 0;
  for (const row of claimedRows) {
    try {
      const submitted = await persistSourceIntakeSubmittedClaim({
        row,
        claimToken,
        batchName,
        displayName,
        submittedAt: now,
      });
      if (submitted) {
        submittedRequests += 1;
        completedRequests += 1;
      } else {
        const resolution = await failLostSubmissionClaimAfterBatchCreate({
          row,
          claimToken,
          batchName,
          displayName,
        });
        if (resolution === "submitted") submittedRequests += 1;
        if (resolution !== "missing" && resolution !== "unresolved") completedRequests += 1;
        if (resolution !== "submitted") report.submission_claims_lost_after_batch_create += 1;
      }
    } catch (error) {
      const resolution = await failLostSubmissionClaimAfterBatchCreate({
        row,
        claimToken,
        batchName,
        displayName,
      }).catch((recoveryError) => {
        report.errors.push({
          request_id: row.id,
          batch_name: batchName,
          stage: "source_intake_batch_submission_claim",
          message: `Persisting the created Gemini Batch failed (${errorMessage(error)}), then fail-closed recovery also failed: ${errorMessage(recoveryError)}`,
        });
        return "unresolved";
      });
      if (resolution === "submitted") submittedRequests += 1;
      if (resolution !== "missing" && resolution !== "unresolved") completedRequests += 1;
      if (resolution !== "submitted") report.submission_claims_lost_after_batch_create += 1;
    }
  }

  report.ai_review_submitted += submittedRequests;
  report.batches.push({
    name: batchName,
    model,
    requested_requests: claimedRows.length,
    submitted_requests: submittedRequests,
    lost_claims: claimedRows.length - submittedRequests,
    display_name: displayName,
    mode: "inline",
  });
  return completedRequests;
}

async function claimSourceIntakeSubmissionRows(rows, { claimToken, claimedAt, displayName }) {
  if (!apply) return rows;
  const claimedRows = [];
  for (const row of rows) {
    const { data, error } = await supabase
      .from("source_page_requests")
      .update({
        status: "needs_manual_review",
        status_reason: "gemini_batch_submission_in_progress_fail_closed",
        ai_review: {
          ...objectValue(row.ai_review),
          submission_claim_token: claimToken,
          submission_claimed_at: claimedAt,
          submission_claimed_by: "process-source-intake-requests",
          batch_display_name: displayName,
          batch_create_started_at: claimedAt,
        },
        updated_at: claimedAt,
      })
      .eq("id", row.id)
      .eq("status", "ai_review_pending")
      .select("*")
      .maybeSingle();
    if (error) throw new Error(`Claim source intake request ${row.id} for Batch submission failed: ${error.message}`);
    if (data) claimedRows.push(data);
    else report.submission_claim_conflicts += 1;
  }
  return claimedRows;
}

async function persistSourceIntakeSubmittedClaim({ row, claimToken, batchName, displayName, submittedAt }) {
  let lastError = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const { data, error } = await supabase
      .from("source_page_requests")
      .update({
        status: "ai_review_submitted",
        status_reason: "submitted_to_gemini_batch",
        ai_review: {
          ...objectValue(row.ai_review),
          submission_claim_token: claimToken,
          gemini_batch_name: batchName,
          gemini_batch_request_key: row.id,
          model,
          submitted_at: submittedAt,
          display_name: displayName,
        },
        error: null,
        failed_at: null,
        updated_at: submittedAt,
      })
      .eq("id", row.id)
      .eq("status", "needs_manual_review")
      .contains("ai_review", { submission_claim_token: claimToken })
      .select("id")
      .maybeSingle();
    if (!error && data) return data;
    if (!error) {
      const current = await loadSourceIntakeRequestState(row.id);
      if (cleanNullable(objectValue(current?.ai_review).gemini_batch_name) === batchName) return current;
      return null;
    }
    lastError = error;
    if (attempt < 4) await new Promise((resolvePromise) => setTimeout(resolvePromise, attempt * 500));
  }
  const current = await loadSourceIntakeRequestState(row.id).catch(() => null);
  if (cleanNullable(objectValue(current?.ai_review).gemini_batch_name) === batchName) return current;
  throw new Error(`Persist source intake Batch ${batchName} request ${row.id} failed after retries: ${lastError?.message || "unknown error"}`);
}

async function failLostSubmissionClaimAfterBatchCreate({ row, claimToken, batchName, displayName }) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const current = await loadSourceIntakeRequestState(row.id);
    if (!current) {
      report.errors.push({
        request_id: row.id,
        batch_name: batchName,
        stage: "source_intake_batch_submission_claim",
        message: `Gemini Batch ${batchName} was created, but source intake request ${row.id} no longer exists.`,
      });
      return "missing";
    }
    if (cleanNullable(objectValue(current.ai_review).gemini_batch_name) === batchName) return "submitted";
    if (new Set(["added", "rejected"]).has(current.status)) {
      report.warnings.push({
        request_id: row.id,
        batch_name: batchName,
        stage: "source_intake_batch_submission_claim",
        message: `Gemini Batch ${batchName} was created after the request became ${current.status}; the terminal request state was preserved.`,
      });
      return "terminal";
    }

    const now = new Date().toISOString();
    let query = supabase
      .from("source_page_requests")
      .update({
        status: "needs_manual_review",
        status_reason: "manual_recovery_required_external_batch_created_after_claim_loss",
        worker_run_id: null,
        ai_review: {
          ...objectValue(current.ai_review),
          submission_claim_token: claimToken,
          batch_display_name: displayName,
          possible_external_batch_name: batchName,
          submission_claim_failed_closed_at: now,
        },
        failed_at: now,
        error: `Gemini Batch ${batchName} was created after request ownership changed. Resolve the external Batch before retrying.`,
        updated_at: now,
      })
      .eq("id", row.id)
      .eq("status", current.status);
    query = withObservedUpdatedAt(query, current.updated_at);
    const { data, error } = await query.select("id").maybeSingle();
    if (error) throw new Error(`Fail lost source intake Batch claim ${row.id} closed failed: ${error.message}`);
    if (!data) continue;
    report.manual_recovery_required += 1;
    report.needs_manual_review += 1;
    report.errors.push({
      request_id: row.id,
      batch_name: batchName,
      stage: "source_intake_batch_submission_claim",
      message: `Gemini Batch ${batchName} was created after its request claim was lost; the request was failed closed for operator recovery.`,
    });
    return "manual_recovery";
  }

  report.errors.push({
    request_id: row.id,
    batch_name: batchName,
    stage: "source_intake_batch_submission_claim",
    message: `Gemini Batch ${batchName} was created, and the request could not be failed closed after repeated ownership conflicts.`,
  });
  return "unresolved";
}

async function loadSourceIntakeRequestState(id) {
  const { data, error } = await supabase
    .from("source_page_requests")
    .select("id,status,updated_at,ai_review")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`Reload source intake request ${id} failed: ${error.message}`);
  return data || null;
}

async function failSourceIntakeSubmissionClaimsClosed(rows, claimToken, displayName, cause, batchName = null) {
  const now = new Date().toISOString();
  const message = errorMessage(cause).slice(0, 1000);
  for (const row of rows) {
    const { data, error } = await supabase
      .from("source_page_requests")
      .update({
        status: "needs_manual_review",
        status_reason: "manual_recovery_required_possible_external_batch_created",
        ai_review: {
          ...objectValue(row.ai_review),
          submission_claim_token: claimToken,
          batch_display_name: displayName,
          possible_external_batch_name: batchName,
          submission_claim_failed_closed_at: now,
          possible_external_batch_error: message,
        },
        failed_at: now,
        error: message,
        updated_at: now,
      })
      .eq("id", row.id)
      .eq("status", "needs_manual_review")
      .contains("ai_review", { submission_claim_token: claimToken })
      .select("id")
      .maybeSingle();
    if (error) {
      report.errors.push({
        request_id: row.id,
        stage: "source_intake_batch_submission_claim",
        message: `Fail ambiguous source intake Batch claim closed failed: ${error.message}`,
      });
      continue;
    }
    if (data) {
      report.manual_recovery_required += 1;
      report.needs_manual_review += 1;
    }
  }
  report.errors.push({
    stage: "source_intake_batch_create",
    batch_display_name: displayName,
    batch_name: batchName,
    message: batchName
      ? `Manual recovery required because Gemini Batch ${batchName} was created but request state could not be persisted: ${message}`
      : `Manual recovery required because Gemini Batch creation may have succeeded: ${message}`,
  });
}

async function pollSubmittedBatches() {
  await failExpiredSubmittedBacklog();
  if (!hasTimeBudget("poll_load")) return;
  const { data, error } = await supabase
    .from("source_page_requests")
    .select("id,ai_review")
    .eq("status", "ai_review_submitted")
    .order("updated_at", { ascending: true })
    .limit(Math.max(pollBatchLimit * maxRequestsPerBatch, pollBatchLimit));
  if (error) throw new Error(`Load submitted source intake batches failed: ${error.message}`);

  const rowsByBatch = new Map();
  for (const row of data || []) {
    const batchName = cleanNullable(objectValue(row.ai_review).gemini_batch_name);
    if (!batchName) continue;
    if (!rowsByBatch.has(batchName)) rowsByBatch.set(batchName, []);
    rowsByBatch.get(batchName).push(row);
  }
  const loadedBatchNames = [...rowsByBatch.keys()];
  const batchNames = loadedBatchNames.slice(0, pollBatchLimit);
  report.stage_counts.poll.loaded = loadedBatchNames.length;
  report.stage_counts.poll.selected = batchNames.length;
  for (const batchName of batchNames) {
    if (!hasTimeBudget("poll")) break;
    report.stage_counts.poll.attempted += 1;
    try {
      await pollSubmittedBatch(batchName, rowsByBatch.get(batchName) || []);
      report.stage_counts.poll.completed += 1;
    } catch (error) {
      if (isTimeBudgetExhaustion(error)) throw error;
      report.errors.push({
        batch_name: batchName,
        stage: "source_intake_batch_poll",
        message: errorMessage(error),
      });
      const batchReport = {
        name: batchName,
        state: "poll_failed",
        reconciled: 0,
        failed: 0,
        poll_errors: 1,
        rejected: 0,
        mode: "poll",
        error: errorMessage(error),
      };
      report.batches.push(batchReport);
      const failedClosedCount = await failExpiredSubmittedBatch(
        batchName,
        rowsByBatch.get(batchName) || [],
        errorMessage(error),
      );
      batchReport.failed += failedClosedCount;
      if (!failedClosedCount) await touchSubmittedBatchRows(batchName).catch((touchError) => {
        report.errors.push({
          batch_name: batchName,
          stage: "source_intake_batch_poll_rotation",
          message: errorMessage(touchError),
        });
      });
    }
  }
}

async function failExpiredSubmittedBacklog() {
  const cutoff = new Date(Date.now() - maxBatchAgeMs).toISOString();
  while (hasTimeBudget("expire_stale_submitted_batches")) {
    const { data, error } = await supabase
      .from("source_page_requests")
      .select("id,updated_at,ai_review")
      .eq("status", "ai_review_submitted")
      .filter("ai_review->>submitted_at", "lt", cutoff)
      .order("updated_at", { ascending: true })
      .limit(1_000);
    if (error) throw new Error(`Load expired source intake batches failed: ${error.message}`);
    if (!(data || []).length) return;

    const rowsByBatch = new Map();
    const malformedRows = [];
    for (const row of data || []) {
      const batchName = cleanNullable(objectValue(row.ai_review).gemini_batch_name);
      if (!batchName) {
        malformedRows.push(row);
        continue;
      }
      if (!rowsByBatch.has(batchName)) rowsByBatch.set(batchName, []);
      rowsByBatch.get(batchName).push(row);
    }
    let affected = await failMalformedExpiredSubmittedRows(malformedRows);
    for (const [batchName, rows] of rowsByBatch) {
      affected += await failExpiredSubmittedBatch(
        batchName,
        rows,
        "Gemini Batch exceeded the maximum source-intake age before its normal poll turn.",
      );
    }
    if (!apply || affected === 0) return;
  }
}

async function failMalformedExpiredSubmittedRows(rows) {
  if (!rows.length) return 0;
  if (!apply) {
    report.warnings.push({
      stage: "source_intake_batch_poll",
      message: `Dry run: ${rows.length} expired submitted request(s) without a Gemini Batch name would be failed closed.`,
    });
    return 0;
  }

  let affected = 0;
  for (const row of rows) {
    const now = new Date().toISOString();
    let query = supabase
      .from("source_page_requests")
      .update({
        status: "needs_manual_review",
        status_reason: "stale_submitted_missing_gemini_batch_operator_recovery_required",
        worker_run_id: null,
        failed_at: now,
        error: "Expired submitted source intake request has no Gemini Batch name. Inspect provider history before retrying.",
        updated_at: now,
      })
      .eq("id", row.id)
      .eq("status", "ai_review_submitted");
    query = withObservedUpdatedAt(query, row.updated_at);
    const { data, error } = await query.select("id").maybeSingle();
    if (error) throw new Error(`Fail malformed submitted source intake request ${row.id} closed failed: ${error.message}`);
    if (data) affected += 1;
  }
  if (affected > 0) {
    report.failed += affected;
    report.needs_manual_review += affected;
    report.manual_recovery_required += affected;
    report.errors.push({
      stage: "source_intake_batch_poll",
      message: `${affected} expired submitted source intake request(s) without a Gemini Batch name were failed closed.`,
    });
  }
  return affected;
}

async function pollSubmittedBatch(batchName, batchRows) {
  const job = await fetchGeminiJson(`https://generativelanguage.googleapis.com/v1beta/${batchName}`, {
    method: "GET",
    kind: "source_intake_batch_poll",
  });
  const state = geminiBatchState(job);
  const batchReport = { name: batchName, state, reconciled: 0, failed: 0, rejected: 0, mode: "poll" };
  report.batches.push(batchReport);
  if (!isGeminiBatchDone(state)) {
    const failedClosedCount = await failExpiredSubmittedBatch(
      batchName,
      batchRows,
      `Gemini Batch remained nonterminal in state ${state || "unknown"}.`,
    );
    batchReport.failed += failedClosedCount;
    if (!failedClosedCount) await touchSubmittedBatchRows(batchName);
    return;
  }
  if (!isGeminiBatchSucceeded(state)) {
    const batchError = geminiBatchErrorMessage(job);
    if (!apply) {
      batchReport.proposed_failed = batchRows.length;
      report.warnings.push({
        batch_name: batchName,
        stage: "source_intake_batch_poll",
        message: `Dry run: terminal Gemini Batch would fail ${batchRows.length} submitted source intake request(s): ${batchError}`,
      });
      return;
    }
    const failedRows = await markBatchRowsFailed(batchName, batchError);
    batchReport.failed += failedRows;
    report.failed += failedRows;
    if (failedRows > 0) {
      report.errors.push({
        batch_name: batchName,
        stage: "source_intake_batch_poll",
        message: `Gemini Batch failed for ${failedRows} source intake request(s): ${batchError}`,
      });
    } else {
      report.warnings.push({
        batch_name: batchName,
        stage: "source_intake_batch_poll",
        message: "Gemini Batch was terminally failed, but no submitted request rows remained to update.",
      });
    }
    return;
  }

  const responseMap = await geminiBatchResponseMap(job);
  const { data: rows, error: rowError } = await supabase
    .from("source_page_requests")
    .select("*")
    .eq("status", "ai_review_submitted")
    .filter("ai_review->>gemini_batch_name", "eq", batchName)
    .order("updated_at", { ascending: true })
    .limit(maxRequestsPerBatch);
  if (rowError) throw new Error(`Load source intake rows for batch failed: ${rowError.message}`);
  report.stage_counts.reconcile.loaded += (rows || []).length;

  for (const row of rows || []) {
    if (!hasTimeBudget("reconcile")) break;
    report.stage_counts.reconcile.attempted += 1;
    const responseItem = responseMap.get(row.id) || responseMap.get(cleanNullable(objectValue(row.ai_review).gemini_batch_request_key));
    if (!responseItem) {
      const message = "Gemini batch completed but no response was returned for this request.";
      const failed = await failSubmittedResponse(row, batchName, {
        status: "failed",
        status_reason: "missing_gemini_batch_response",
        failed_at: new Date().toISOString(),
        error: message,
      });
      if (failed) {
        report.failed += 1;
        batchReport.failed += 1;
        report.errors.push({ request_id: row.id, batch_name: batchName, stage: "reconcile", message });
        report.stage_counts.reconcile.completed += 1;
      } else {
        report.reconcile_claim_conflicts += 1;
      }
      continue;
    }
    const itemError = geminiInlineError(responseItem);
    if (itemError) {
      const message = cleanNullable(itemError.message) || `Gemini Batch item failed: ${JSON.stringify(itemError).slice(0, 500)}`;
      const failed = await failSubmittedResponse(row, batchName, {
        status: "failed",
        status_reason: "gemini_batch_item_error",
        ai_review: { ...(objectValue(row.ai_review)), gemini_item_error: itemError },
        failed_at: new Date().toISOString(),
        error: message.slice(0, 1000),
      });
      if (failed) {
        report.failed += 1;
        batchReport.failed += 1;
        report.errors.push({ request_id: row.id, batch_name: batchName, stage: "reconcile", message });
        report.stage_counts.reconcile.completed += 1;
      } else {
        report.reconcile_claim_conflicts += 1;
      }
      continue;
    }
    const rawText = extractGeminiText(geminiInlineResponsePayload(responseItem));
    const parsed = parseJsonObject(rawText);
    if (!parsed) {
      const message = "Gemini did not return valid intake JSON.";
      const failed = await failSubmittedResponse(row, batchName, {
        status: "failed",
        status_reason: "invalid_gemini_intake_json",
        ai_review: { ...(objectValue(row.ai_review)), raw_text: rawText, parse_error: "invalid_json" },
        failed_at: new Date().toISOString(),
        error: message,
      });
      if (failed) {
        report.failed += 1;
        batchReport.failed += 1;
        report.errors.push({ request_id: row.id, batch_name: batchName, stage: "reconcile", message });
        report.stage_counts.reconcile.completed += 1;
      } else {
        report.reconcile_claim_conflicts += 1;
      }
      continue;
    }
    const claimedRow = await claimSubmittedResponse(row, batchName);
    if (!claimedRow) {
      report.reconcile_claim_conflicts += 1;
      continue;
    }
    const capture = captureFromRow(claimedRow);
    const deterministicReview = objectValue(claimedRow.deterministic_review);
    try {
      await finalizeReviewedRequest(claimedRow, capture, deterministicReview, parsed);
      report.ai_review_succeeded += 1;
      batchReport.reconciled += 1;
      report.stage_counts.reconcile.completed += 1;
    } catch (error) {
      const message = errorMessage(error);
      const failedClosed = await failOwnedReconciliation(claimedRow.id, message).catch((persistenceError) => {
        report.errors.push({
          request_id: claimedRow.id,
          batch_name: batchName,
          stage: "matching_failure_persistence",
          message: errorMessage(persistenceError),
        });
        return null;
      });
      report.failed += 1;
      if (failedClosed) {
        report.needs_manual_review += 1;
        report.stage_counts.reconcile.completed += 1;
      }
      else {
        report.warnings.push({
          request_id: claimedRow.id,
          batch_name: batchName,
          stage: "matching_ownership",
          message: "Matching failed after request ownership changed; the newer request state was preserved.",
        });
      }
      batchReport.failed += 1;
      report.errors.push({
        request_id: claimedRow.id,
        batch_name: batchName,
        stage: "matching",
        message,
      });
    }
  }
}

async function failSubmittedResponse(row, batchName, patch) {
  if (!apply) return row;
  let query = supabase
    .from("source_page_requests")
    .update({ ...patch, worker_run_id: null, updated_at: new Date().toISOString() })
    .eq("id", row.id)
    .eq("status", "ai_review_submitted")
    .filter("ai_review->>gemini_batch_name", "eq", batchName);
  query = withObservedUpdatedAt(query, row.updated_at);
  const { data, error } = await query.select("*").maybeSingle();
  if (error) throw new Error(`Fail source intake response ${row.id} closed failed: ${error.message}`);
  return data || null;
}

async function claimSubmittedResponse(row, batchName) {
  if (!apply) return { ...row, status: "ai_review_succeeded", worker_run_id: workerRunId };
  const now = new Date().toISOString();
  let query = supabase
    .from("source_page_requests")
    .update({
      status: "ai_review_succeeded",
      status_reason: "gemini_batch_response_claimed_for_reconciliation",
      worker_run_id: workerRunId,
      error: null,
      failed_at: null,
      updated_at: now,
    })
    .eq("id", row.id)
    .eq("status", "ai_review_submitted")
    .filter("ai_review->>gemini_batch_name", "eq", batchName);
  query = withObservedUpdatedAt(query, row.updated_at);
  const { data, error } = await query.select("*").maybeSingle();
  if (error) throw new Error(`Claim source intake response ${row.id} failed: ${error.message}`);
  return data || null;
}

async function failOwnedReconciliation(id, message) {
  if (!apply) return { id };
  const { data, error } = await supabase
    .from("source_page_requests")
    .update({
      status: "needs_manual_review",
      status_reason: "matching_failed_closed_operator_retry_required",
      worker_run_id: null,
      failed_at: new Date().toISOString(),
      error: message.slice(0, 1000),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .in("status", ["ai_review_succeeded", "matching"])
    .eq("worker_run_id", workerRunId)
    .select("id")
    .maybeSingle();
  if (error) throw new Error(`Fail owned source intake reconciliation ${id} closed failed: ${error.message}`);
  return data || null;
}

async function touchSubmittedBatchRows(batchName) {
  if (!apply) return;
  const { error } = await supabase
    .from("source_page_requests")
    .update({ updated_at: new Date().toISOString() })
    .eq("status", "ai_review_submitted")
    .filter("ai_review->>gemini_batch_name", "eq", batchName);
  if (error) throw new Error(`Rotate submitted source intake batch ${batchName} failed: ${error.message}`);
}

async function failExpiredSubmittedBatch(batchName, rows, reason) {
  const submittedTimes = rows
    .map((row) => Date.parse(cleanNullable(objectValue(row.ai_review).submitted_at) || ""))
    .filter(Number.isFinite);
  if (!submittedTimes.length || Date.now() - Math.min(...submittedTimes) < maxBatchAgeMs) return 0;

  const now = new Date().toISOString();
  const message = `Gemini Batch ${batchName} exceeded the ${maxBatchAgeMs}ms intake age limit. ${reason}`.slice(0, 1000);
  if (!apply) {
    report.warnings.push({
      batch_name: batchName,
      stage: "source_intake_batch_poll",
      message: `Dry run: ${message}`,
    });
    return 0;
  }
  const { data, error } = await supabase
    .from("source_page_requests")
    .update({
      status: "needs_manual_review",
      status_reason: "stale_gemini_batch_operator_recovery_required",
      failed_at: now,
      error: message,
      updated_at: now,
    })
    .eq("status", "ai_review_submitted")
    .filter("ai_review->>gemini_batch_name", "eq", batchName)
    .select("id");
  if (error) throw new Error(`Fail stale source intake batch ${batchName} closed failed: ${error.message}`);
  const affected = (data || []).length;
  report.failed += affected;
  report.needs_manual_review += affected;
  report.manual_recovery_required += affected;
  if (affected > 0) {
    report.errors.push({
      batch_name: batchName,
      stage: "source_intake_batch_poll",
      message,
    });
  } else {
    report.warnings.push({
      batch_name: batchName,
      stage: "source_intake_batch_poll",
      message: "Stale Gemini Batch had no submitted request rows left to fail closed.",
    });
  }
  return affected;
}

async function finalizeReviewedRequest(row, capture, deterministicReview, rawResult) {
  const normalizedReview = normalizeGeminiIntakeResult(rawResult);
  const validation = validateIntakeAiDecision(normalizedReview);
  const now = new Date().toISOString();
  const aiReview = {
    ...(objectValue(row.ai_review)),
    ...normalizedReview,
    raw: rawResult,
    completed_at: now,
  };

  if (!validation.accepted) {
    const status = validation.manual ? "needs_manual_review" : "rejected";
    if (validation.manual) report.needs_manual_review += 1;
    else {
      report.ai_review_rejected += 1;
      report.rejected += 1;
    }
    if (apply) {
      await requireOwnedRequestUpdate(row.id, "ai_review_succeeded", {
        status,
        status_reason: validation.reason,
        worker_run_id: null,
        ai_review: aiReview,
        detected_award_name: normalizedReview.detected_award_name,
        detected_sponsor: normalizedReview.detected_sponsor,
        processed_at: now,
      });
    }
    return;
  }

  if (apply) {
    row = await requireOwnedRequestUpdate(row.id, "ai_review_succeeded", {
      status: "matching",
      status_reason: "ai_review_accepted_matching_award",
      ai_review: aiReview,
      detected_award_name: normalizedReview.detected_award_name,
      detected_sponsor: normalizedReview.detected_sponsor,
    });
  }

  const awardResult = await resolveAwardForRequest(row, capture, deterministicReview, normalizedReview);
  if (!awardResult.award) {
    report.needs_manual_review += 1;
    if (apply) {
      await requireOwnedRequestUpdate(row.id, "matching", {
        status: "needs_manual_review",
        status_reason: awardResult.reason,
        worker_run_id: null,
        ai_review: aiReview,
        processed_at: now,
      });
    }
    return;
  }

  const sourceLike = sourceLikeFromIntake({ request: row, capture, review: normalizedReview });
  sourceLike.shared_award_id = awardResult.award.id;
  const sourceQuality = sourceQualityForIntakeSource(sourceLike);
  if (!sourceQuality.allowed) {
    report.needs_manual_review += 1;
    if (apply) {
      await requireOwnedRequestUpdate(row.id, "matching", {
        status: "needs_manual_review",
        status_reason: `source_quality_${sourceQuality.reason}`,
        worker_run_id: null,
        ai_review: aiReview,
        processed_at: now,
      });
    }
    return;
  }

  const source = apply
    ? await upsertAcceptedSource(awardResult.award.id, sourceLike, row)
    : { id: "dry-run-source-id" };
  report.created_or_updated_sources += 1;

  const candidateRows = factCandidateRowsFromIntake({
    awardId: awardResult.award.id,
    sourceId: source.id,
    sourceLike,
    review: normalizedReview,
  }).map((candidate) => ({
    ...candidate,
    metadata: {
      ...(objectValue(candidate.metadata)),
      source_page_request_id: row.id,
    },
  }));

  if (apply && candidateRows.length) {
    const { error } = await supabase.from("shared_award_fact_candidates").insert(candidateRows);
    if (error) throw new Error(`Insert intake fact candidates failed: ${error.message}`);
  }
  report.fact_candidates_inserted += candidateRows.length;

  if (apply) {
    const queueResult = await enqueueAwardReconciliation(supabase, {
      awardId: awardResult.award.id,
      reason: "source_intake_accepted",
      sourceIds: [source.id],
      priority: 35,
      metadata: {
        source_page_request_id: row.id,
        intake_review_status: normalizedReview.status,
        source_url: sourceLike.url,
      },
    });
    if (queueResult?.created) report.awards_queued_for_reconciliation += 1;
    await requireOwnedRequestUpdate(row.id, "matching", {
      status: "added",
      status_reason: awardResult.created ? "created_award_and_added_source" : "matched_award_and_added_source",
      worker_run_id: null,
      matched_shared_award_id: awardResult.created ? null : awardResult.award.id,
      created_shared_award_id: awardResult.created ? awardResult.award.id : null,
      created_source_ids: [source.id],
      ai_review: aiReview,
      processed_at: now,
      error: null,
    });
  }
}

async function resolveAwardForRequest(row, capture, deterministicReview, review) {
  if (row.matched_shared_award_id) {
    const award = await loadAward(row.matched_shared_award_id);
    if (award) {
      report.matched_existing_awards += 1;
      return { award, created: false, reason: "manual_matched_award" };
    }
  }

  const awards = await loadExistingAwards();
  const match = matchSourceToExistingAward({ awards, request: row, capture, review });
  if (match?.award && match.score >= autoApproveThreshold) {
    report.matched_existing_awards += 1;
    return { award: match.award, created: false, reason: `matched_existing_award_${match.score.toFixed(2)}` };
  }
  if (match?.award && match.score >= manualReviewThreshold) {
    return { award: null, created: false, reason: `possible_existing_award_match_${match.score.toFixed(2)}` };
  }

  const createDecision = shouldCreateNewAwardFromIntake({
    review,
    deterministicReview,
    request: row,
    capture,
    threshold: autoApproveThreshold,
  });
  if (!createAwards || !createDecision.create) {
    return { award: null, created: false, reason: createDecision.reason };
  }

  if (!apply) {
    return {
      award: {
        id: "dry-run-award-id",
        name: review.detected_award_name || row.award_name,
        slug: null,
        official_homepage: capture.canonical_url || capture.final_url || row.normalized_url || row.homepage_url,
        summary: review.facts?.description || capture.page_description || null,
        confidence: 0.85,
        status: "active",
      },
      created: true,
      reason: "dry_run_create_new_award",
    };
  }

  const award = await createSharedAwardFromIntake(row, capture, review);
  report.created_awards += 1;
  return { award, created: true, reason: "created_new_award" };
}

async function loadExistingAwards() {
  const { data, error } = await supabase
    .from("shared_awards")
    .select("id,name,slug,official_homepage,summary,confidence,status")
    .eq("status", "active")
    .limit(20_000);
  if (error) throw new Error(`Load shared awards failed: ${error.message}`);
  return data || [];
}

async function loadAward(id) {
  const { data, error } = await supabase
    .from("shared_awards")
    .select("id,name,slug,official_homepage,summary,confidence,status")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`Load matched award failed: ${error.message}`);
  return data;
}

async function createSharedAwardFromIntake(row, capture, review) {
  const normalized = normalizeGeminiIntakeResult(review);
  const name = normalized.detected_award_name || row.award_name;
  const url = capture.canonical_url || capture.final_url || row.normalized_url || row.homepage_url;
  const searchKey = normalizeSharedAwardKey(name);
  const slug = slugify(name);
  const { data, error } = await supabase
    .from("shared_awards")
    .upsert({
      search_key: searchKey,
      name,
      slug,
      official_homepage: url,
      summary: normalized.facts.description || capture.page_description || null,
      public_facts: {},
      confidence: 0.85,
      status: "active",
      source: "admin",
    }, { onConflict: "search_key" })
    .select("id,name,slug,official_homepage,summary,confidence,status")
    .maybeSingle();
  if (error) throw new Error(`Create shared award failed: ${error.message}`);
  if (!data) throw new Error("Create shared award did not return a row.");
  return data;
}

async function upsertAcceptedSource(awardId, sourceLike, row) {
  const baselineFacts = baselineFactsFromIntakeReview(objectValue(sourceLike.page_metadata).intake_review || objectValue(row.ai_review));
  const { data, error } = await supabase
    .from("shared_award_sources")
    .upsert({
      shared_award_id: awardId,
      url: sourceLike.url,
      title: sourceLike.title,
      display_title: sourceLike.display_title || null,
      page_description: sourceLike.page_description || null,
      page_type: normalizeSharedAwardPageType(sourceLike.page_type),
      confidence: sourceLike.confidence || 0.75,
      reason: "Accepted through source intake workflow",
      source: "admin",
      submitted_by_user_id: row.user_id || null,
      admin_review_status: "open",
      page_metadata: {
        ...(objectValue(sourceLike.page_metadata)),
        baseline_facts: baselineFacts,
        source_intake_request_id: row.id,
      },
      page_metadata_generated_at: new Date().toISOString(),
      page_metadata_model: sourceLike.page_metadata_model || model,
      last_error: null,
      consecutive_failures: 0,
    }, { onConflict: "shared_award_id,url" })
    .select("id,shared_award_id,url,title")
    .maybeSingle();
  if (error) throw new Error(`Upsert accepted source failed: ${error.message}`);
  if (!data) throw new Error("Upsert accepted source did not return a row.");
  return data;
}

async function markBatchRowsFailed(batchName, message) {
  if (!apply) return 0;
  const { data, error } = await supabase
    .from("source_page_requests")
    .update({
      status: "failed",
      status_reason: "gemini_batch_failed",
      failed_at: new Date().toISOString(),
      error: message.slice(0, 1000),
    })
    .eq("status", "ai_review_submitted")
    .filter("ai_review->>gemini_batch_name", "eq", batchName)
    .select("id");
  if (error) throw new Error(`Mark source intake batch failed failed: ${error.message}`);
  return (data || []).length;
}

async function createWorkerRun() {
  if (!apply) return null;
  const { data, error } = await supabase
    .from("local_worker_runs")
    .insert({
      id: workerRunId,
      worker_name: "source-intake-processor",
      status: "running",
      ai_provider: geminiApiMode === "none" ? null : "gemini",
      metadata: workerMetadata(),
    })
    .select("id")
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

async function syncWorkerRun(status = "running", error = null) {
  if (!apply || !workerRun) return;
  const finished = status === "succeeded" || status === "failed";
  const { error: updateError } = await supabase
    .from("local_worker_runs")
    .update({
      status,
      checked_count: report.requests_loaded,
      changed_count: report.created_or_updated_sources,
      unchanged_count: report.needs_manual_review,
      initial_count: report.ai_review_pending,
      discovered_count: report.created_awards,
      failed_count: report.failed,
      error,
      metadata: workerMetadata(),
      finished_at: finished ? report.finished_at || new Date().toISOString() : null,
    })
    .eq("id", workerRunId);
  if (updateError) console.warn(`SOURCE_INTAKE_WORKER_SYNC_FAILED ${updateError.message}`);
}

function workerMetadata() {
  return {
    kind: "source_intake",
    report_path: reportPath,
    env_path: envPath,
    options: report.options,
    status: report.status,
    counters: {
      requests_loaded: report.requests_loaded,
      captured: report.captured,
      deterministic_rejected: report.deterministic_rejected,
      ai_review_pending: report.ai_review_pending,
      ai_review_submitted: report.ai_review_submitted,
      ai_review_succeeded: report.ai_review_succeeded,
      capture_claim_conflicts: report.capture_claim_conflicts,
      reconcile_claim_conflicts: report.reconcile_claim_conflicts,
      submission_claim_conflicts: report.submission_claim_conflicts,
      submission_claims_lost_after_batch_create: report.submission_claims_lost_after_batch_create,
      manual_recovery_required: report.manual_recovery_required,
      stale_capture_requests_requeued: report.stale_capture_requests_requeued,
      stale_reconcile_claims_requeued: report.stale_reconcile_claims_requeued,
      stale_matching_requests_failed_closed: report.stale_matching_requests_failed_closed,
      needs_manual_review: report.needs_manual_review,
      matched_existing_awards: report.matched_existing_awards,
      created_awards: report.created_awards,
      created_or_updated_sources: report.created_or_updated_sources,
      fact_candidates_inserted: report.fact_candidates_inserted,
      awards_queued_for_reconciliation: report.awards_queued_for_reconciliation,
      failed: report.failed,
    },
    stage_counts: report.stage_counts,
    batches: report.batches,
    time_budget_exhausted: report.time_budget_exhausted,
    hard_deadline_forced: report.hard_deadline_forced,
    stop_reason: report.stop_reason,
    updated_at: new Date().toISOString(),
  };
}

async function claimIdleRequest(row) {
  const now = new Date().toISOString();
  let query = supabase
    .from("source_page_requests")
    .update({
      status: "validating",
      worker_run_id: workerRunId,
      error: null,
      failed_at: null,
      updated_at: now,
    })
    .eq("id", row.id)
    .eq("status", row.status);
  query = withObservedUpdatedAt(query, row.updated_at);
  const { data, error } = await query.select("*").maybeSingle();
  if (error) throw new Error(`Claim source intake request ${row.id} for capture failed: ${error.message}`);
  return data || null;
}

async function requireOwnedRequestUpdate(id, expectedStatus, patch) {
  const data = await updateOwnedRequest(id, expectedStatus, patch);
  if (!data) throw sourceIntakeOwnershipLost(id, expectedStatus);
  return data;
}

async function updateOwnedRequest(id, expectedStatus, patch) {
  const { data, error } = await supabase
    .from("source_page_requests")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", expectedStatus)
    .eq("worker_run_id", workerRunId)
    .select("*")
    .maybeSingle();
  if (error) throw new Error(`Update owned source intake request ${id} failed: ${error.message}`);
  return data || null;
}

function withObservedUpdatedAt(query, observedUpdatedAt) {
  return observedUpdatedAt ? query.eq("updated_at", observedUpdatedAt) : query.is("updated_at", null);
}

function sourceIntakeOwnershipLost(id, expectedStatus) {
  const error = new Error(`Source intake request ${id} is no longer owned by this run in ${expectedStatus}.`);
  error.code = "SOURCE_INTAKE_OWNERSHIP_LOST";
  return error;
}

function isSourceIntakeOwnershipLost(error) {
  return error && typeof error === "object" && error.code === "SOURCE_INTAKE_OWNERSHIP_LOST";
}

function captureFromRow(row) {
  const capture = objectValue(row.capture_metadata);
  const links = objectValue(row.discovered_links);
  return {
    ...capture,
    final_url: cleanNullable(capture.final_url) || row.normalized_url || row.homepage_url,
    canonical_url: cleanNullable(capture.canonical_url) || row.normalized_url || row.homepage_url,
    title: cleanNullable(capture.title) || row.award_name,
    page_description: cleanNullable(capture.page_description),
    text: cleanNullable(capture.text) || cleanNullable(capture.text_excerpt),
    links: Array.isArray(links.links) ? links.links : [],
    pdf_links: Array.isArray(links.pdf_links) ? links.pdf_links : [],
  };
}

function geminiBatchUrl(value) {
  const modelName = String(value || "").replace(/^models\//, "");
  return `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:batchGenerateContent`;
}

async function fetchGeminiJson(url, { method, body, kind }) {
  if (!hasTimeBudget(kind)) {
    throw timeBudgetExhaustion(kind);
  }
  const remainingBudgetMs = Math.max(1, deadlineAtMs - Date.now());
  const timeoutMs = Math.min(requestTimeoutMs, remainingBudgetMs);
  const deadlineLimited = remainingBudgetMs <= requestTimeoutMs;
  let response;
  let text;
  try {
    response = await fetch(url, {
      method,
      headers: { "content-type": "application/json", "x-goog-api-key": geminiApiKey },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await response.text();
  } catch (error) {
    if (deadlineLimited && isAbortTimeout(error)) {
      markTimeBudgetExhausted(kind);
      throw timeBudgetExhaustion(kind, error);
    }
    throw error;
  }
  if (!response.ok) throw new Error(`Gemini ${kind} failed: ${response.status} ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

async function geminiBatchResponseMap(job) {
  const mapped = geminiBatchInlineResponseMap(extractGeminiBatchInlineResponses(job));
  if (mapped.missingKeys > 0) {
    report.errors.push({
      stage: "source_intake_batch_response_mapping",
      message: `${mapped.missingKeys} Gemini Batch response item(s) had no request key and could not be reconciled.`,
    });
  }
  for (const duplicateKey of mapped.duplicateKeys) {
    mapped.responses.delete(duplicateKey);
    report.errors.push({
      request_id: duplicateKey,
      stage: "source_intake_batch_response_mapping",
      message: `Gemini Batch returned duplicate response key ${duplicateKey}; the request was failed closed instead of choosing an ambiguous response.`,
    });
  }
  return mapped.responses;
}

function geminiBatchJobName(data) {
  return [data?.name, data?.metadata?.name, data?.response?.name].find((value) => typeof value === "string" && value.startsWith("batches/")) || null;
}

function geminiBatchState(data) {
  return cleanNullable(data?.metadata?.state || data?.response?.state || data?.state || data?.metadata?.batchState || data?.metadata?.batch_state);
}

function isGeminiBatchDone(state) {
  return new Set(["JOB_STATE_SUCCEEDED", "JOB_STATE_FAILED", "JOB_STATE_CANCELLED", "JOB_STATE_EXPIRED", "BATCH_STATE_SUCCEEDED", "BATCH_STATE_FAILED", "BATCH_STATE_CANCELLED", "BATCH_STATE_EXPIRED"]).has(state);
}

function isGeminiBatchSucceeded(state) {
  return new Set(["JOB_STATE_SUCCEEDED", "BATCH_STATE_SUCCEEDED"]).has(state);
}

function geminiBatchErrorMessage(job) {
  return cleanNullable(job?.error?.message || job?.metadata?.error?.message || job?.response?.error?.message) || "Gemini source intake batch failed.";
}

function extractGeminiText(payload) {
  const parts = payload?.candidates?.[0]?.content?.parts || payload?.response?.candidates?.[0]?.content?.parts || [];
  return parts.map((part) => part.text || "").join("\n").trim();
}

function writeReport() {
  updateDeferredStageCounts();
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
}

function updateDeferredStageCounts() {
  for (const stage of Object.values(report.stage_counts)) {
    const denominator = Number.isFinite(stage.eligible) ? stage.eligible : stage.loaded;
    stage.deferred = Math.max(0, denominator - stage.completed);
  }
}

function hasTimeBudget(stage) {
  if (Date.now() < deadlineAtMs) return true;
  markTimeBudgetExhausted(stage);
  return false;
}

function markTimeBudgetExhausted(stage) {
  if (!report.time_budget_exhausted) {
    report.time_budget_exhausted = true;
    report.stop_reason = `time_budget_exhausted:${stage}`;
    console.log(`SOURCE_INTAKE_TIME_BUDGET_EXHAUSTED stage=${stage} budget_ms=${timeBudgetMs}`);
    writeReport();
  }
}

async function finishHardBudgetStop() {
  if (hardBudgetStopStarted) return;
  hardBudgetStopStarted = true;
  report.hard_deadline_forced = true;
  markTimeBudgetExhausted("hard_deadline");
  report.status = finalReportStatus();
  report.finished_at = new Date().toISOString();
  writeReport();
  console.log(`SOURCE_INTAKE_HARD_DEADLINE_STOP budget_ms=${timeBudgetMs} grace_ms=${hardDeadlineGraceMs}`);
  const workerStatus = reportStatusSucceeded(report.status) ? "succeeded" : "failed";
  const workerError = workerStatus === "succeeded" ? null : reportFailureMessage();
  await Promise.race([
    syncWorkerRun(workerStatus, workerError),
    new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000)),
  ]).catch(() => {});
  process.exit(workerStatus === "succeeded" ? 0 : 1);
}

function finalReportStatus() {
  if (report.errors.length || report.failed > 0 || report.submission_claims_lost_after_batch_create > 0) {
    return "completed_with_errors";
  }
  return report.time_budget_exhausted ? "succeeded_with_deferred_work" : "succeeded";
}

function reportFailureMessage() {
  return report.errors.at(-1)?.message
    || (report.failed > 0 ? `${report.failed} source intake request(s) failed.` : null)
    || (report.submission_claims_lost_after_batch_create > 0
      ? `${report.submission_claims_lost_after_batch_create} source intake submission claim(s) were lost after Batch creation.`
      : null);
}

function reportStatusSucceeded(status) {
  return status === "succeeded" || status === "succeeded_with_deferred_work";
}

function timeBudgetExhaustion(stage, cause) {
  const error = new Error(`Source intake time budget exhausted during ${stage}.`, { cause });
  error.code = "SOURCE_INTAKE_TIME_BUDGET_EXHAUSTED";
  return error;
}

function isTimeBudgetExhaustion(error) {
  return error && typeof error === "object" && error.code === "SOURCE_INTAKE_TIME_BUDGET_EXHAUSTED";
}

function isAbortTimeout(error) {
  return error && typeof error === "object" && new Set(["AbortError", "TimeoutError"]).has(error.name);
}

function printHelp() {
  console.log(`Usage: node scripts/process-source-intake-requests.mjs [options]

Options:
  --limit=100
  --request-id=<uuid>
  --status=pending,queued
  --apply=true|false
  --dry-run=true|false
  --gemini-api-mode=batch|none
  --create-awards=true|false
  --auto-approve-threshold=0.85
  --manual-review-threshold=0.55
  --poll=true|false
  --submit=true|false
  --poll-only=true
  --submit-only=true
  --poll-batch-limit=25
  --request-timeout-ms=120000
  --capture-timeout-ms=30000
  --time-budget-ms=900000
  --stale-in-flight-ms=1800000
  --max-batch-age-ms=259200000
`);
}

function normalizeSharedAwardKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function slugify(value) {
  return normalizeSharedAwardKey(value).replace(/\s+/g, "-").replace(/^-+|-+$/g, "").slice(0, 160) || `award-${Date.now()}`;
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const withoutPrefix = value.slice(2);
    const equalsIndex = withoutPrefix.indexOf("=");
    if (equalsIndex !== -1) parsed[withoutPrefix.slice(0, equalsIndex)] = withoutPrefix.slice(equalsIndex + 1);
    else {
      const next = values[index + 1];
      if (next && !next.startsWith("--")) {
        parsed[withoutPrefix] = next;
        index += 1;
      } else parsed[withoutPrefix] = "true";
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

function csvList(value) {
  if (!value) return [];
  return String(value).split(",").map((item) => item.trim()).filter(Boolean);
}

function chunks(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

function boolArg(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return /^(1|true|yes|y|on)$/i.test(String(value).trim());
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function numberArg(value, fallback) {
  const parsed = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function cleanNullable(value) {
  const text = String(value || "").trim();
  return text || null;
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function timestampForPath(value) {
  return String(value || new Date().toISOString()).replace(/[:.]/g, "-");
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || "Unknown error");
}
