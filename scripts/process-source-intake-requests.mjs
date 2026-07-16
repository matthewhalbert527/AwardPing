#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  baselineFactsFromIntakeReview,
  buildSourceAcquisitionProposal,
  buildGeminiIntakeRequest,
  captureIntakePage,
  deterministicSourceIntakeReview,
  factCandidateRowsFromIntake,
  matchSourceToExistingAward,
  normalizeGeminiIntakeResult,
  normalizeSharedAwardPageType,
  normalizeSourceIntakeUrl,
  parseJsonObject,
  persistSourceIntakeFactCandidates,
  sourceLikeFromIntake,
  sourceQualityForIntakeSource,
  shouldCreateNewAwardFromIntake,
  validateIntakeAiDecision,
} from "./lib/source-intake.mjs";
import { enqueueAwardReconciliation } from "./lib/award-fact-reconciliation.mjs";
import {
  extractGeminiBatchInlineResponses,
  geminiBatchExactMappingComplete,
  geminiBatchUsageAccounting,
  geminiBatchInlineResponseMap,
  geminiInlineError,
  geminiInlineResponsePayload,
} from "./lib/gemini-batch-support.mjs";
import {
  GEMINI_PAID_LANES,
  GeminiBudgetUnavailableError,
  estimateGeminiMaximumBatchRequestsCostUsd,
  geminiActiveWorkReservation,
  loadGeminiSpendReservation,
  markGeminiSpendCreateStarted,
  releaseGeminiSpendReservation,
  releaseUnsubmittedGeminiSpendReservationByKey,
  reserveGeminiSpend,
  settleGeminiSpendReservation,
  submitGeminiSpendReservation,
  terminalGeminiSettlement,
} from "./lib/gemini-spend-ledger.mjs";
import {
  geminiWorkerModel,
  normalizeGeminiBatchMode,
} from "./lib/gemini-worker-policy.mjs";
import {
  IntakeArtifactRetentionError,
  POST_RETENTION_CAPTURE_FAILURE_REASON,
  POST_RETENTION_CAPTURE_PERSISTENCE_UNVERIFIED_REASON,
  persistPostRetentionCaptureFailure,
  requiresFirstObservationArtifactRetention,
  retainFirstObservationIntakePdfArtifact,
  resumeFirstObservationIntakeArtifactRetention,
  serializableRetainedCaptureMetadata,
  validateRetainedIntakeArtifactManifest,
} from "./lib/intake-artifact-retention.mjs";
import {
  INITIAL_OFFICIAL_DOCUMENT_SCOPE,
  initialOfficialDocumentPublicationDecision,
} from "./lib/initial-official-document.mjs";
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
const initialDocumentMaterializationTimeoutMs = positiveInt(
  args["initial-document-materialization-timeout-ms"],
  120_000,
);
const pollBatchLimit = positiveInt(args["poll-batch-limit"], 25);
const timeBudgetMs = positiveInt(args["time-budget-ms"], 15 * 60_000);
const deadlineAtMs = Date.now() + timeBudgetMs;
const hardDeadlineGraceMs = 2_000;
const staleInFlightMs = positiveInt(args["stale-in-flight-ms"], 30 * 60_000);
const maxBatchAgeMs = positiveInt(args["max-batch-age-ms"], 72 * 60 * 60_000);
const reportDir = args["report-dir"] ? resolve(root, String(args["report-dir"])) : join(root, "reports");
const archiveRoot = resolve(
  String(env.AWARDPING_VISUAL_SNAPSHOT_DIR || args["archive-dir"] || "D:\\AwardPingVisualSnapshots"),
);
const r2Bucket = cleanNullable(args["r2-bucket"] || env.R2_BUCKET) || "awardping-snapshots";
const r2AccountId = cleanNullable(args["r2-account-id"] || env.R2_ACCOUNT_ID);
const r2Endpoint = cleanNullable(
  args["r2-endpoint"] || env.R2_ENDPOINT ||
  (r2AccountId ? `https://${r2AccountId}.r2.cloudflarestorage.com` : null),
);
const r2AccessKeyId = cleanNullable(args["r2-access-key-id"] || env.R2_ACCESS_KEY_ID);
const r2SecretAccessKey = cleanNullable(args["r2-secret-access-key"] || env.R2_SECRET_ACCESS_KEY);
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
    initial_document_materialization_timeout_ms: initialDocumentMaterializationTimeoutMs,
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
  budget_deferred_requests: 0,
  active_work_deferred_requests: 0,
  spend_reservations_created: 0,
  spend_reservations_settled: 0,
  manual_recovery_required: 0,
  provider_batch_bindings_recovered: 0,
  stale_submission_claims_requeued: 0,
  stale_capture_requests_requeued: 0,
  stale_reconcile_claims_requeued: 0,
  stale_free_reconciliation_claims_requeued: 0,
  stale_matching_requests_failed_closed: 0,
  needs_manual_review: 0,
  matched_existing_awards: 0,
  created_awards: 0,
  created_or_updated_sources: 0,
  source_acquisitions_created: 0,
  source_acquisitions_first_capture_candidate: 0,
  source_acquisitions_baseline_only: 0,
  source_acquisitions_manual_review: 0,
  live_first_capture_preflight_manual_review: 0,
  initial_document_materialization_attempted: 0,
  initial_document_materialization_subprocess_started: 0,
  initial_document_materialization_candidate_existing: 0,
  initial_document_materialization_succeeded: 0,
  initial_document_materialization_failed: 0,
  source_acquisitions_skipped_preexisting: 0,
  intake_artifacts_retained: 0,
  intake_artifacts_resumed: 0,
  intake_artifact_retention_failed: 0,
  post_retention_failures_quarantined: 0,
  post_retention_persistence_unverified: 0,
  stale_protected_captures_recovered: 0,
  stale_protected_completed_captures_resumed: 0,
  stale_protected_staged_captures_resumed: 0,
  reconciliation_only_retries_loaded: 0,
  reconciliation_only_retries_completed: 0,
  reconciliation_only_retries_failed: 0,
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
  if (apply && hasTimeBudget("reconciliation_only_retry")) {
    await processRequestedReconciliationRetries();
  }
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

async function processRequestedReconciliationRetries() {
  const { data, error } = await supabase
    .from("source_page_requests")
    .select("*")
    .eq("status", "ai_review_succeeded")
    .eq("status_reason", "manual_reconciliation_retry_requested")
    .is("worker_run_id", null)
    .order("updated_at", { ascending: true })
    .limit(limit);
  if (error) throw new Error(`Load reconciliation-only source intake retries failed: ${error.message}`);
  report.reconciliation_only_retries_loaded += (data || []).length;

  for (const requested of data || []) {
    if (!hasTimeBudget("reconciliation_only_retry")) break;
    let claimed = null;
    try {
      const capture = captureFromRow(requested);
      const retainedArtifact = validateRetainedIntakeArtifactManifest(capture.retained_artifact, {
        requestId: requested.id,
        fileHash: capture.capture_file_hash,
        finalUrl: capture.canonical_url || capture.final_url,
        requireR2Verified: true,
      });
      const storedReview = objectValue(requested.ai_review);
      if (cleanNullable(storedReview.status) !== "accepted") {
        throw new Error("Reconciliation-only retry requires a stored accepted AI review.");
      }
      if (!retainedArtifact.r2_verified_at) {
        throw new Error("Reconciliation-only retry requires completed immutable R2 retention.");
      }
      const now = new Date().toISOString();
      let claimQuery = supabase
        .from("source_page_requests")
        .update({
          worker_run_id: workerRunId,
          status_reason: "manual_reconciliation_retry_claimed_no_charge",
          failed_at: null,
          error: null,
          updated_at: now,
        })
        .eq("id", requested.id)
        .eq("status", "ai_review_succeeded")
        .eq("status_reason", "manual_reconciliation_retry_requested")
        .is("worker_run_id", null);
      claimQuery = withObservedUpdatedAt(claimQuery, requested.updated_at);
      const claimResult = await claimQuery.select("*").maybeSingle();
      if (claimResult.error) {
        throw new Error(`Claim reconciliation-only source intake retry failed: ${claimResult.error.message}`);
      }
      claimed = claimResult.data;
      if (!claimed) continue;

      await finalizeReviewedRequest(
        claimed,
        { ...capture, retained_artifact: retainedArtifact },
        objectValue(claimed.deterministic_review),
        Object.keys(objectValue(storedReview.raw)).length ? storedReview.raw : storedReview,
      );
      report.reconciliation_only_retries_completed += 1;
      report.requests.push({
        id: claimed.id,
        submitted_url: claimed.submitted_url || claimed.homepage_url,
        status: "reconciliation_retry_completed",
        reason: "stored_capture_and_ai_review_replayed_no_charge",
        creates_api_charge: false,
      });
    } catch (retryError) {
      report.reconciliation_only_retries_failed += 1;
      report.needs_manual_review += 1;
      report.errors.push({
        request_id: requested.id,
        stage: "reconciliation_only_retry",
        message: errorMessage(retryError),
        solution:
          "Repair the verified retained-artifact manifest or atomic registration dependency, then request the same reconciliation-only retry. Do not recapture the URL or rerun Gemini.",
        creates_api_charge: false,
      });
      if (claimed?.id) {
        await failOwnedReconciliation(claimed.id, errorMessage(retryError));
      } else if (apply) {
        let failPreclaim = supabase
          .from("source_page_requests")
          .update({
            status: "needs_manual_review",
            status_reason: "reconciliation_retry_preflight_failed_no_charge",
            worker_run_id: null,
            failed_at: new Date().toISOString(),
            error: `${errorMessage(retryError)} Safe action: repair retained evidence, then retry reconciliation only.`.slice(0, 1000),
            updated_at: new Date().toISOString(),
          })
          .eq("id", requested.id)
          .eq("status", "ai_review_succeeded")
          .eq("status_reason", "manual_reconciliation_retry_requested")
          .is("worker_run_id", null);
        failPreclaim = withObservedUpdatedAt(failPreclaim, requested.updated_at);
        const { error: failError } = await failPreclaim.select("id").maybeSingle();
        if (failError) {
          report.errors.push({
            request_id: requested.id,
            stage: "reconciliation_only_retry_preflight_failure_persistence",
            message: failError.message,
          });
        }
      }
    }
  }
}

async function recoverStaleInFlightRequests() {
  const cutoff = new Date(Date.now() - staleInFlightMs).toISOString();
  const { data, error } = await supabase
    .from("source_page_requests")
    .select("id,status,status_reason,updated_at,acquisition_kind,notification_mode,onboarding_batch_id,capture_metadata")
    .in("status", ["validating", "capturing", "ai_review_succeeded", "matching"])
    .lt("updated_at", cutoff)
    .order("updated_at", { ascending: true })
    .limit(limit);
  if (error) throw new Error(`Load stale source intake requests failed: ${error.message}`);

  for (const row of data || []) {
    if (!hasTimeBudget("recover_stale_in_flight")) break;
    const matching = row.status === "matching";
    const reconcileClaim = row.status === "ai_review_succeeded";
    const freeReconciliationClaim =
      reconcileClaim && row.status_reason === "manual_reconciliation_retry_claimed_no_charge";
    const protectedCapture = isProtectedLiveFirstCaptureRow(row) && row.status === "capturing";
    const retainedCapturePersisted = protectedCapture && hasProvenRetainedCaptureMetadata(row);
    const stagedCapturePersisted = protectedCapture
      && !retainedCapturePersisted
      && hasProvenStagedCaptureMetadata(row);
    const now = new Date().toISOString();
    const patch = matching
      ? {
          status: "needs_manual_review",
          status_reason: "stale_matching_failed_closed_operator_retry_required",
          worker_run_id: null,
          failed_at: now,
          error: "Source intake stopped while applying an accepted AI result. Review the partial state. Use the $0 retained-result retry when offered; otherwise use a generic rerun only after confirming it is safe and may create an API charge.",
          updated_at: now,
        }
      : protectedCapture
        ? {
            status: retainedCapturePersisted
              ? "ai_review_pending"
              : stagedCapturePersisted
                ? "pending"
                : "needs_manual_review",
            status_reason: retainedCapturePersisted
              ? "stale_protected_capture_resuming_from_verified_retained_artifact"
              : stagedCapturePersisted
                ? "stale_protected_capture_resuming_staged_artifact"
                : POST_RETENTION_CAPTURE_PERSISTENCE_UNVERIFIED_REASON,
            worker_run_id: null,
            failed_at: retainedCapturePersisted || stagedCapturePersisted ? null : now,
            error: retainedCapturePersisted
              ? null
              : stagedCapturePersisted
                ? null
                : "Source intake stopped after capture began and retained-artifact persistence cannot be proven. Inspect immutable storage and bind the exact capture manually; automated URL refetch is blocked.",
            updated_at: now,
          }
      : freeReconciliationClaim
        ? {
            status: "ai_review_succeeded",
            status_reason: "manual_reconciliation_retry_requested",
            worker_run_id: null,
            failed_at: null,
            error: null,
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
    } else if (protectedCapture) {
      report.stale_protected_captures_recovered += 1;
      if (retainedCapturePersisted) {
        report.stale_protected_completed_captures_resumed += 1;
        report.warnings.push({
          request_id: row.id,
          stage: "protected_first_capture_recovery",
          message: "Stale first-capture work resumed at AI review from its verified retained artifact without a URL refetch.",
          creates_api_charge_on_recovery: false,
          downstream_review_may_charge: true,
        });
      } else if (stagedCapturePersisted) {
        report.stale_protected_staged_captures_resumed += 1;
        report.warnings.push({
          request_id: row.id,
          stage: "protected_first_capture_recovery",
          message: "Stale first-capture work requeued its exact staged artifact for retention resume without a URL refetch.",
          creates_api_charge_on_recovery: false,
          downstream_review_may_charge: true,
        });
      } else {
        report.needs_manual_review += 1;
        report.errors.push({
          request_id: row.id,
          stage: "protected_first_capture_recovery",
          message: "Stale first-capture work has unproven retained identity and was made manual-only without a URL refetch.",
          creates_api_charge: false,
        });
      }
    } else if (freeReconciliationClaim) {
      report.stale_free_reconciliation_claims_requeued += 1;
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
    const review = objectValue(row.ai_review);
    const claimToken = cleanNullable(review.submission_claim_token);
    let reservation = null;
    try {
      reservation = await loadSourceIntakeSpendReservation(review);
      const journaledBatchName = cleanNullable(review.possible_external_batch_name);
      if (
        reservation?.status === "creating"
        && !reservation.provider_batch_name
        && journaledBatchName
        && claimToken
      ) {
        await submitGeminiSpendReservation({
          supabase,
          reservationId: reservation.id,
          attemptToken: claimToken,
          providerBatchName: journaledBatchName,
        });
        reservation = await loadSourceIntakeSpendReservation(review);
      }
    } catch (error) {
      report.errors.push({
        request_id: row.id,
        stage: "source_intake_spend_reservation_recovery",
        message: errorMessage(error),
      });
    }
    if (
      reservation?.provider_batch_name
      && new Set(["submitted", "settled"]).has(reservation.status)
    ) {
      const { data: restored, error: restoreError } = await supabase
        .from("source_page_requests")
        .update({
          status: "ai_review_submitted",
          status_reason: "gemini_batch_binding_recovered_from_spend_ledger",
          worker_run_id: null,
          ai_review: {
            ...review,
            gemini_batch_name: reservation.provider_batch_name,
            gemini_batch_request_key: row.id,
            model: reservation.model || model,
            submitted_at: reservation.submitted_at || now,
            gemini_spend_reservation_id: reservation.id,
            gemini_spend_reservation_key: reservation.reservation_key,
            gemini_spend_attempt_token: reservation.attempt_token,
            provider_binding_recovered_at: now,
          },
          failed_at: null,
          error: null,
          updated_at: now,
        })
        .eq("id", row.id)
        .eq("status", "needs_manual_review")
        .eq("status_reason", "gemini_batch_submission_in_progress_fail_closed")
        .select("id")
        .maybeSingle();
      if (restoreError) throw new Error(`Restore source intake provider binding failed: ${restoreError.message}`);
      if (restored) report.provider_batch_bindings_recovered += 1;
      continue;
    }
    const definitelyPreCreate = !review.batch_create_started_at
      || reservation?.status === "reserved"
      || reservation?.status === "released";
    if (definitelyPreCreate) {
      try {
        const reservationKey = cleanNullable(review.gemini_spend_reservation_key)
          || (claimToken ? `new-page-review:${claimToken}` : null);
        if (reservationKey) {
          await releaseUnsubmittedGeminiSpendReservationByKey({
            supabase,
            reservationKey,
            reason: "stale_claim_recovered_before_provider_create",
          });
        }
        const { data: requeued, error: requeueError } = await supabase
          .from("source_page_requests")
          .update({
            status: "ai_review_pending",
            status_reason: "stale_pre_create_claim_recovered",
            ai_review: {
              ...review,
              submission_claim_token: null,
              submission_claim_released_at: now,
              submission_claim_release_reason: "Worker stopped before provider create started.",
              gemini_spend_attempt_token: null,
              gemini_spend_reservation_id: null,
              gemini_spend_reservation_key: null,
            },
            failed_at: null,
            error: null,
            updated_at: now,
          })
          .eq("id", row.id)
          .eq("status", "needs_manual_review")
          .eq("status_reason", "gemini_batch_submission_in_progress_fail_closed")
          .lt("updated_at", cutoff)
          .select("id")
          .maybeSingle();
        if (requeueError) throw new Error(`Requeue stale pre-create source intake claim ${row.id} failed: ${requeueError.message}`);
        if (requeued) report.stale_submission_claims_requeued += 1;
        continue;
      } catch (error) {
        report.errors.push({
          request_id: row.id,
          stage: "source_intake_pre_create_reservation_recovery",
          message: errorMessage(error),
        });
      }
    }
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

async function loadSourceIntakeSpendReservation(review) {
  const reservationId = cleanNullable(review?.gemini_spend_reservation_id);
  const reservationKey = cleanNullable(review?.gemini_spend_reservation_key);
  if (!reservationId && !reservationKey) return null;
  let query = supabase
    .from("gemini_spend_reservations")
    .select("id,reservation_key,attempt_token,status,provider_batch_name,submitted_at,model");
  query = reservationId ? query.eq("id", reservationId) : query.eq("reservation_key", reservationKey);
  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(`Load source intake spend reservation failed: ${error.message}`);
  if (data && reservationKey && data.reservation_key !== reservationKey) {
    throw new Error("Source intake spend reservation identity mismatch.");
  }
  return data || null;
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
  let artifactRetentionRequired = false;
  let capturedForRetention = null;
  let completedCaptureMetadata = null;
  let completedDiscoveredLinks = null;

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

    const priorCaptureMetadata = objectValue(row.capture_metadata);
    const stagedManifest = objectValue(priorCaptureMetadata.retained_artifact_staged);
    const stagedRetentionRequired =
      apply &&
      Object.keys(stagedManifest).length > 0 &&
      requiresFirstObservationArtifactRetention(row, captureFromRow(row));
    artifactRetentionRequired = stagedRetentionRequired;
    let capture;
    if (stagedRetentionRequired) {
      capturedForRetention = captureFromRow(row);
      const retainedArtifact = await resumeFirstObservationIntakeArtifactRetention({
        stagedManifest,
        archiveRoot,
        bucket: r2Bucket,
        config: {
          bucket: r2Bucket,
          endpoint: r2Endpoint,
          accessKeyId: r2AccessKeyId,
          secretAccessKey: r2SecretAccessKey,
        },
      });
      capture = {
        ...capturedForRetention,
        retained_artifact: retainedArtifact,
      };
      report.intake_artifacts_resumed += 1;
    } else {
      capture = await captureIntakePage(normalizedUrl, { timeoutMs: captureTimeoutMs });
    }
    capturedForRetention = capture;
    report.captured += 1;
    const deterministicReview = deterministicSourceIntakeReview({
      url: capture.canonical_url || capture.final_url || normalizedUrl,
      title: capture.title,
      text: capture.text,
      requestedAwardName: row.award_name,
      contentType: capture.content_type,
    });
    summary.reason = deterministicReview.reason;

    artifactRetentionRequired =
      apply &&
      deterministicReview.status !== "rejected" &&
      deterministicReview.status !== "needs_manual_review" &&
      geminiApiMode !== "none" &&
      requiresFirstObservationArtifactRetention(row, capture);
    const retainedArtifact = artifactRetentionRequired
      ? capture.retained_artifact || await retainFirstObservationIntakePdfArtifact({
          request: row,
          capture,
          archiveRoot,
          bucket: r2Bucket,
          config: {
            bucket: r2Bucket,
            endpoint: r2Endpoint,
            accessKeyId: r2AccessKeyId,
            secretAccessKey: r2SecretAccessKey,
          },
        })
      : null;
    if (retainedArtifact) report.intake_artifacts_retained += 1;

    const captureMetadata = serializableRetainedCaptureMetadata(capture, retainedArtifact);
    const discoveredLinks = {
      links: capture.links || [],
      pdf_links: capture.pdf_links || [],
    };
    if (retainedArtifact) {
      completedCaptureMetadata = captureMetadata;
      completedDiscoveredLinks = discoveredLinks;
    }

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
    if (completedCaptureMetadata && apply && ownedStatus) {
      const quarantine = await persistPostRetentionCaptureFailure({
        persist: (patch) => updateOwnedRequest(row.id, ownedStatus, patch),
        captureMetadata: completedCaptureMetadata,
        discoveredLinks: completedDiscoveredLinks,
        processingError: error,
      });
      report.needs_manual_review += 1;
      summary.status = "needs_manual_review";
      if (quarantine.persisted) {
        report.post_retention_failures_quarantined += 1;
        summary.reason = POST_RETENTION_CAPTURE_FAILURE_REASON;
        report.errors.push({
          request_id: row.id,
          stage: "post_retention_capture_processing",
          reason_code: POST_RETENTION_CAPTURE_FAILURE_REASON,
          message: errorMessage(error),
          solution: "Continue from the verified retained capture. Do not fetch the source URL again.",
          creates_api_charge_on_recovery: false,
          downstream_review_may_charge: true,
        });
        return true;
      }

      report.post_retention_persistence_unverified += 1;
      summary.reason = POST_RETENTION_CAPTURE_PERSISTENCE_UNVERIFIED_REASON;
      report.errors.push({
        request_id: row.id,
        stage: "post_retention_capture_failure_persistence",
        reason_code: POST_RETENTION_CAPTURE_PERSISTENCE_UNVERIFIED_REASON,
        message: quarantine.persistenceError
          ? errorMessage(quarantine.persistenceError)
          : "The fail-closed retained-capture quarantine write returned no owned row.",
        solution: "Do not refetch. Stale recovery will make this protected first capture manual-only so immutable storage can be inspected and rebound.",
        creates_api_charge: false,
      });
      return false;
    }
    if (isSourceIntakeOwnershipLost(error)) {
      report.capture_claim_conflicts += 1;
      summary.status = "skipped";
      summary.reason = errorMessage(error);
      report.warnings.push({ request_id: row.id, stage: "capture_ownership", message: errorMessage(error) });
      return false;
    }
    if (artifactRetentionRequired && error instanceof IntakeArtifactRetentionError) {
      report.intake_artifact_retention_failed += 1;
      report.needs_manual_review += 1;
      summary.status = "needs_manual_review";
      summary.reason = error.code;
      report.errors.push({
        request_id: row.id,
        stage: "intake_artifact_retention",
        reason_code: error.code,
        message: errorMessage(error),
        solution: error.solution,
        creates_api_charge: false,
      });
      if (apply && ownedStatus) {
        const stagedArtifact = objectValue(error?.details).staged_manifest
          || objectValue(capturedForRetention?.retained_artifact_staged)
          || null;
        const failedCaptureMetadata = capturedForRetention
          ? {
              ...capturedForRetention,
              artifact_bytes: undefined,
              retained_artifact: null,
              retained_artifact_staged: stagedArtifact,
              text_excerpt: String(capturedForRetention.text || "").slice(0, 20_000),
              text_length: String(capturedForRetention.text || "").length,
              links: undefined,
              pdf_links: undefined,
            }
          : undefined;
        const quarantine = await persistPostRetentionCaptureFailure({
          persist: (patch) => updateOwnedRequest(row.id, ownedStatus, patch),
          captureMetadata: failedCaptureMetadata,
          discoveredLinks: capturedForRetention
            ? {
                links: capturedForRetention.links || [],
                pdf_links: capturedForRetention.pdf_links || [],
              }
            : null,
          processingError: error,
          statusReason: error.code,
          solution: error.solution,
        });
        if (!quarantine.persisted) {
          report.post_retention_persistence_unverified += 1;
          report.errors.push({
            request_id: row.id,
            stage: "intake_artifact_retention_quarantine_persistence",
            reason_code: POST_RETENTION_CAPTURE_PERSISTENCE_UNVERIFIED_REASON,
            message: quarantine.persistenceError
              ? errorMessage(quarantine.persistenceError)
              : "The staged retained-capture quarantine write returned no owned row.",
            solution: "Do not refetch. Stale recovery will make this protected first capture manual-only so immutable local/R2 state can be inspected and rebound.",
            creates_api_charge: false,
          });
          return false;
        }
      }
      return true;
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

  const estimatedCostUsd = estimateGeminiMaximumBatchRequestsCostUsd(model, requests, {
    maxOutputTokensPerRequest: 1_600,
  });
  const reservationKey = `new-page-review:${claimToken}`;
  const workFingerprint = paidReviewWorkFingerprint(
    "new-page-review",
    model,
    claimedRows.map((row) => row.id),
  );
  let spendReservation;
  try {
    spendReservation = await reserveGeminiSpend({
      supabase,
      laneKey: GEMINI_PAID_LANES.NEW_PAGE_REVIEW,
      reservationKey,
      attemptToken: claimToken,
      workFingerprint,
      estimatedCostUsd,
      workerSource: "process-source-intake-requests",
      workerRunId,
      requestCount: claimedRows.length,
      model,
      metadata: {
        claim_token: claimToken,
        display_name: displayName,
        request_ids: claimedRows.map((row) => row.id),
        work_fingerprint: workFingerprint,
        reservation_basis: "text_utf8_and_image_tile_upper_bound_standard_rates_max_output",
      },
    });
    report.spend_reservations_created += 1;
  } catch (error) {
    const activeWork = geminiActiveWorkReservation(error);
    let activeDisposition = null;
    try {
      await releaseUnsubmittedGeminiSpendReservationByKey({
        supabase,
        reservationKey,
        reason: `reservation_response_failed_before_provider_create:${errorMessage(error)}`.slice(0, 500),
      });
      if (activeWork) {
        activeDisposition = await deferSourceIntakeClaimsForActiveWork(claimedRows, claimToken, activeWork);
      } else {
        await releaseSourceIntakeSubmissionClaims(claimedRows, claimToken, error, {
          budgetDeferred: error instanceof GeminiBudgetUnavailableError,
        });
      }
    } catch (recoveryError) {
      await failSourceIntakeSubmissionClaimsClosed(
        claimedRows,
        claimToken,
        displayName,
        new Error(`Gemini reservation recovery failed before provider create: ${errorMessage(recoveryError)}`),
      );
      throw recoveryError;
    }
    if (!(error instanceof GeminiBudgetUnavailableError)) throw error;
    if (activeWork) {
      report.active_work_deferred_requests += claimedRows.length;
      if (activeDisposition?.manualRecoveryRequired) {
        report.manual_recovery_required += claimedRows.length;
        report.needs_manual_review += claimedRows.length;
      }
      report.batches.push({
        name: null,
        model,
        requested_requests: claimedRows.length,
        submitted_requests: 0,
        display_name: displayName,
        mode: activeDisposition?.manualRecoveryRequired ? "active_work_manual_recovery" : "active_work_in_flight",
        estimated_cost_usd: estimatedCostUsd,
        active_work: { ...error.status, recovered_status: activeDisposition?.status || activeWork.status },
      });
      return claimedRows.length;
    }
    report.budget_deferred_requests += claimedRows.length;
    report.batches.push({
      name: null,
      model,
      requested_requests: claimedRows.length,
      submitted_requests: 0,
      display_name: displayName,
      mode: "budget_deferred",
      estimated_cost_usd: estimatedCostUsd,
      budget: error.status,
    });
    return claimedRows.length;
  }

  try {
    await markSourceIntakeClaimsCreateStarted({
      rows: claimedRows,
      claimToken,
      spendReservation,
      reservationKey,
      estimatedCostUsd,
    });
    await markGeminiSpendCreateStarted({
      supabase,
      reservationId: spendReservation.reservation_id,
      attemptToken: claimToken,
      metadata: { display_name: displayName, request_ids: claimedRows.map((row) => row.id) },
    });
  } catch (error) {
    await releaseGeminiSpendReservation({
      supabase,
      reservationId: spendReservation.reservation_id,
      reason: `provider_create_not_reached:${errorMessage(error)}`.slice(0, 500),
      expectedAttemptToken: claimToken,
    });
    await releaseSourceIntakeSubmissionClaims(claimedRows, claimToken, error);
    throw error;
  }

  let batch;
  try {
    batch = await fetchGeminiJson(geminiBatchUrl(model), {
      method: "POST",
      body: JSON.stringify({ batch: { displayName, inputConfig: { requests: { requests } } } }),
      kind: "source_intake_batch_create",
    });
  } catch (error) {
    if (error?.possibleExternalBatchCreated === false) {
      await releaseGeminiSpendReservation({
        supabase,
        reservationId: spendReservation.reservation_id,
        reason: `provider_create_definitively_failed:${errorMessage(error)}`.slice(0, 500),
        expectedStatus: "creating",
        expectedAttemptToken: claimToken,
      });
      await releaseSourceIntakeSubmissionClaims(claimedRows, claimToken, error);
    } else {
      await failSourceIntakeSubmissionClaimsClosed(claimedRows, claimToken, displayName, error);
    }
    throw error;
  }
  const batchName = geminiBatchJobName(batch);
  if (!batchName) {
    const error = new Error(`Gemini source intake batch did not return a batch name: ${JSON.stringify(batch).slice(0, 500)}`);
    await failSourceIntakeSubmissionClaimsClosed(claimedRows, claimToken, displayName, error);
    throw error;
  }
  try {
    await journalSourceIntakeProviderBatchName(claimedRows, claimToken, batchName);
  } catch (error) {
    error.possibleExternalBatchCreated = true;
    await failSourceIntakeSubmissionClaimsClosed(claimedRows, claimToken, displayName, error, batchName);
    throw error;
  }

  try {
    await submitGeminiSpendReservation({
      supabase,
      reservationId: spendReservation.reservation_id,
      attemptToken: claimToken,
      providerBatchName: batchName,
    });
  } catch (error) {
    await failSourceIntakeSubmissionClaimsClosed(claimedRows, claimToken, displayName, error, batchName);
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
        spendReservation,
        estimatedCostUsd,
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
    estimated_cost_usd: estimatedCostUsd,
    spend_reservation_id: spendReservation.reservation_id,
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

async function markSourceIntakeClaimsCreateStarted({
  rows,
  claimToken,
  spendReservation,
  reservationKey,
  estimatedCostUsd,
}) {
  const startedAt = new Date().toISOString();
  for (const row of rows) {
    const nextReview = {
      ...objectValue(row.ai_review),
      batch_create_started_at: startedAt,
      gemini_spend_reservation_id: spendReservation.reservation_id,
      gemini_spend_reservation_key: reservationKey,
      gemini_spend_attempt_token: claimToken,
      gemini_spend_lane: GEMINI_PAID_LANES.NEW_PAGE_REVIEW,
      gemini_spend_estimated_cost_usd: estimatedCostUsd,
    };
    const { data, error } = await supabase
      .from("source_page_requests")
      .update({ ai_review: nextReview, updated_at: startedAt })
      .eq("id", row.id)
      .eq("status", "needs_manual_review")
      .contains("ai_review", { submission_claim_token: claimToken })
      .select("ai_review")
      .maybeSingle();
    if (error) throw new Error(`Mark source intake Batch create start ${row.id} failed: ${error.message}`);
    if (!data) throw new Error(`Source intake Batch claim ${row.id} was lost before provider create.`);
    row.ai_review = data.ai_review;
  }
}

async function journalSourceIntakeProviderBatchName(rows, claimToken, batchName) {
  const returnedAt = new Date().toISOString();
  for (const row of rows) {
    const nextReview = {
      ...objectValue(row.ai_review),
      possible_external_batch_name: batchName,
      provider_batch_returned_at: returnedAt,
    };
    const { data, error } = await supabase
      .from("source_page_requests")
      .update({ ai_review: nextReview, updated_at: returnedAt })
      .eq("id", row.id)
      .eq("status", "needs_manual_review")
      .contains("ai_review", { submission_claim_token: claimToken })
      .select("ai_review")
      .maybeSingle();
    if (error) throw new Error(`Journal source intake provider Batch ${batchName} failed: ${error.message}`);
    if (!data) throw new Error(`Source intake Batch claim ${row.id} was lost after provider create.`);
    row.ai_review = data.ai_review;
  }
}

async function deferSourceIntakeClaimsForActiveWork(rows, claimToken, activeWork) {
  if (!apply) return;
  const now = new Date().toISOString();
  const reservation = await loadGeminiSpendReservation({
    supabase,
    reservationId: activeWork.reservationId,
  });
  const providerBound = new Set(["submitted", "settled"]).has(reservation.status)
    && cleanNullable(reservation.provider_batch_name);
  const manualRecovery = reservation.status === "creating" && !providerBound;
  for (const row of rows) {
    const nextReview = {
      ...objectValue(row.ai_review),
      submission_claim_token: providerBound ? null : reservation.attempt_token,
      submission_claim_released_at: now,
      submission_claim_release_reason: `Equivalent Gemini review already has an active ${reservation.status} reservation.`.slice(0, 500),
      batch_create_started_at: manualRecovery ? reservation.create_started_at || now : null,
      gemini_spend_reservation_id: reservation.id,
      gemini_spend_reservation_key: reservation.reservation_key,
      gemini_spend_attempt_token: reservation.attempt_token,
      active_work_reservation_id: reservation.id,
      active_work_status: reservation.status,
      active_work_detected_at: now,
      retry_creates_api_charge: true,
      automatic_retry_after_budget_reset: false,
      automatic_retry_after_active_work: !manualRecovery,
      active_work_recovery: providerBound
        ? "automatic_provider_poll"
        : manualRecovery
          ? "manual_provider_create_recovery"
          : "automatic_stale_pre_create_recovery",
    };
    if (providerBound) {
      nextReview.gemini_batch_name = reservation.provider_batch_name;
      nextReview.gemini_batch_request_key = row.id;
      nextReview.model = reservation.model || model;
      nextReview.submitted_at = reservation.submitted_at || now;
      nextReview.provider_binding_recovered_at = now;
    }
    const { data, error } = await supabase
      .from("source_page_requests")
      .update({
        status: providerBound ? "ai_review_submitted" : "needs_manual_review",
        status_reason: providerBound
          ? "gemini_equivalent_review_binding_recovered"
          : manualRecovery
            ? "manual_recovery_required_equivalent_review_create_started"
            : "gemini_batch_submission_in_progress_fail_closed",
        worker_run_id: null,
        ai_review: nextReview,
        failed_at: manualRecovery ? now : null,
        error: manualRecovery
          ? "Equivalent Gemini provider-create work already started, but no provider Batch name is recoverable. Generic retry is blocked."
          : null,
        updated_at: now,
      })
      .eq("id", row.id)
      .eq("status", "needs_manual_review")
      .contains("ai_review", { submission_claim_token: claimToken })
      .select("id")
      .maybeSingle();
    if (error) throw new Error(`Defer source intake active-work claim ${row.id} failed: ${error.message}`);
    if (!data) report.submission_claim_conflicts += 1;
    else if (providerBound) report.provider_batch_bindings_recovered += 1;
  }
  if (manualRecovery) {
    report.errors.push({
      stage: "source_intake_active_work_recovery",
      message: `Equivalent Gemini provider-create reservation ${reservation.id} requires manual recovery; a second paid call was not created.`,
    });
  }
  return {
    status: reservation.status,
    manualRecoveryRequired: manualRecovery,
    providerBound: Boolean(providerBound),
  };
}

async function releaseSourceIntakeSubmissionClaims(
  rows,
  claimToken,
  cause,
  { budgetDeferred = false } = {},
) {
  if (!apply) return;
  const now = new Date().toISOString();
  for (const row of rows) {
    const { data, error } = await supabase
      .from("source_page_requests")
      .update({
        status: "ai_review_pending",
        status_reason: budgetDeferred
          ? "gemini_daily_budget_deferred"
          : "gemini_submission_claim_released_before_provider_create",
        worker_run_id: null,
        ai_review: {
          ...objectValue(row.ai_review),
          submission_claim_token: null,
          submission_claim_released_at: now,
          submission_claim_release_reason: errorMessage(cause).slice(0, 500),
          batch_create_started_at: null,
          gemini_spend_reservation_id: null,
          gemini_spend_reservation_key: null,
          gemini_spend_attempt_token: null,
          retry_creates_api_charge: true,
          automatic_retry_after_budget_reset: budgetDeferred,
        },
        failed_at: null,
        error: null,
        updated_at: now,
      })
      .eq("id", row.id)
      .eq("status", "needs_manual_review")
      .contains("ai_review", { submission_claim_token: claimToken })
      .select("id")
      .maybeSingle();
    if (error) throw new Error(`Release source intake budget claim ${row.id} failed: ${error.message}`);
    if (!data) report.submission_claim_conflicts += 1;
  }
}

async function persistSourceIntakeSubmittedClaim({
  row,
  claimToken,
  batchName,
  displayName,
  submittedAt,
  spendReservation,
  estimatedCostUsd,
}) {
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
          gemini_spend_reservation_id: spendReservation.reservation_id,
          gemini_spend_lane: GEMINI_PAID_LANES.NEW_PAGE_REVIEW,
          gemini_spend_estimated_cost_usd: estimatedCostUsd,
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
  const knownBatchName = cleanNullable(batchName);
  for (const row of rows) {
    const { data, error } = await supabase
      .from("source_page_requests")
      .update({
        status: knownBatchName ? "ai_review_submitted" : "needs_manual_review",
        status_reason: knownBatchName
          ? "gemini_batch_binding_recovery_pending"
          : "manual_recovery_required_possible_external_batch_created",
        ai_review: {
          ...objectValue(row.ai_review),
          submission_claim_token: claimToken,
          batch_display_name: displayName,
          gemini_batch_name: knownBatchName,
          gemini_batch_request_key: knownBatchName ? row.id : null,
          submitted_at: knownBatchName ? now : null,
          possible_external_batch_name: knownBatchName,
          provider_binding_recovery_required: Boolean(knownBatchName),
          submission_claim_failed_closed_at: now,
          possible_external_batch_error: message,
        },
        failed_at: knownBatchName ? null : now,
        error: knownBatchName ? null : message,
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
    if (data && !knownBatchName) {
      report.manual_recovery_required += 1;
      report.needs_manual_review += 1;
    }
  }
  report.errors.push({
    stage: "source_intake_batch_create",
    batch_display_name: displayName,
    batch_name: knownBatchName,
    message: knownBatchName
      ? `Gemini Batch ${knownBatchName} was created and queued for durable spend-ledger binding recovery: ${message}`
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
    await settleSourceIntakeBatchSpend(batchName, batchRows, {
      terminalState: state,
    });
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

  const batchResponses = await geminiBatchResponseMap(
    job,
    batchRows.map((row) => cleanNullable(objectValue(row.ai_review).gemini_batch_request_key) || row.id),
  );
  const responseMap = batchResponses.responses;
  // Provider spend becomes final when the Batch is terminal. Settle the
  // account-wide reservation before mutating any request row so a crash while
  // publishing results cannot hide charged work or strand the reservation.
  await settleSourceIntakeBatchSpend(batchName, batchRows, {
    terminalState: state,
    accounting: batchResponses.accounting,
  });
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

async function settleSourceIntakeBatchSpend(
  batchName,
  batchRows,
  { terminalState, accounting = null } = {},
) {
  const rows = Array.isArray(batchRows) ? batchRows : [];
  const reservationIds = unique(rows.map((row) => cleanNullable(objectValue(row.ai_review).gemini_spend_reservation_id)));
  if (!reservationIds.length) return null; // Historical Batch created before account-wide reservations.
  if (reservationIds.length !== 1) {
    throw new Error(`Source intake Batch ${batchName} is bound to ${reservationIds.length} spend reservations.`);
  }
  const terminalAccounting = accounting || geminiBatchUsageAccounting([]);
  const usage = terminalAccounting.usage;
  let reservation = await loadGeminiSpendReservation({
    supabase,
    reservationId: reservationIds[0],
  });
  if (reservation.status === "settled") {
    return { settled: true, already_settled: true, reservation_id: reservation.id };
  }
  const attemptTokens = unique(rows.map((row) =>
    cleanNullable(objectValue(row.ai_review).gemini_spend_attempt_token)
  ));
  if (
    reservation.status === "creating"
    && !reservation.provider_batch_name
    && attemptTokens.length === 1
  ) {
    await submitGeminiSpendReservation({
      supabase,
      reservationId: reservation.id,
      attemptToken: attemptTokens[0],
      providerBatchName: batchName,
    });
    reservation = await loadGeminiSpendReservation({
      supabase,
      reservationId: reservation.id,
    });
    report.provider_batch_bindings_recovered += 1;
  }
  const settlement = terminalGeminiSettlement({
    model,
    usage,
    reservation,
    responseCount: terminalAccounting.responseCount,
    usageResponseCount: terminalAccounting.usageResponseCount,
    mappingComplete: terminalAccounting.mappingComplete,
  });
  const settled = await settleGeminiSpendReservation({
    supabase,
    reservationId: reservationIds[0],
    spentCostUsd: settlement.spentCostUsd,
    usage: {
      ...usage,
      coverage: settlement.coverage,
      provider_batch_name: batchName,
      terminal_state: terminalState || null,
    },
    spentSource: settlement.spentSource,
  });
  report.spend_reservations_settled += settled ? 1 : 0;
  return settled;
}

function paidReviewWorkFingerprint(kind, modelName, identities) {
  const digest = createHash("sha256")
    .update(JSON.stringify({
      kind,
      model: modelName,
      identities: [...new Set((identities || []).map((value) => String(value || "").trim()).filter(Boolean))].sort(),
    }))
    .digest("hex");
  return `${kind}:${digest}`;
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

  const acquisitionPreflight = buildSourceAcquisitionProposal({
    request: row,
    source: { url: sourceLike.url },
    review: normalizedReview,
    capture,
    awardCreated: awardResult.created,
    workerRunId,
  });
  const liveFirstCaptureRequested =
    cleanNullable(row.notification_mode) === "first_capture_candidate"
    && cleanNullable(row.acquisition_kind) === "live_discovery"
    && !awardResult.created
    && !cleanNullable(row.onboarding_batch_id);
  if (
    liveFirstCaptureRequested
    && acquisitionPreflight.notification_mode !== "first_capture_candidate"
  ) {
    report.live_first_capture_preflight_manual_review += 1;
    await finalizeLiveFirstCaptureManualReview({
      row,
      awardResult,
      aiReview,
      now,
      dispositionReason: acquisitionPreflight.reason,
      source: null,
      phase: "client_preflight",
    });
    return;
  }

  const sourceWrite = apply
    ? await registerAcceptedSource(awardResult.award.id, sourceLike, row, {
        capture,
        review: normalizedReview,
        awardCreated: awardResult.created,
        acquisitionProposal: acquisitionPreflight,
      })
    : {
        source: { id: "dry-run-source-id" },
        inserted: true,
        acquisition: acquisitionPreflight,
      };
  const source = sourceWrite.source;
  report.created_or_updated_sources += 1;
  if (sourceWrite.acquisition?.create) {
    report.source_acquisitions_created += 1;
    if (sourceWrite.acquisition.notification_mode === "first_capture_candidate") {
      report.source_acquisitions_first_capture_candidate += 1;
    } else if (sourceWrite.acquisition.notification_mode === "baseline_only") {
      report.source_acquisitions_baseline_only += 1;
    } else if (sourceWrite.acquisition.notification_mode === "manual_review") {
      report.source_acquisitions_manual_review += 1;
    }
  } else if (!sourceWrite.inserted) {
    report.source_acquisitions_skipped_preexisting += 1;
  }

  if (
    liveFirstCaptureRequested
    && sourceWrite.acquisition?.create
    && sourceWrite.acquisition.notification_mode === "manual_review"
  ) {
    const dispositionReason = cleanNullable(sourceWrite.acquisition.reason)
      || "source_acquisition_requires_manual_review";
    if (apply) {
      const quarantineMessage =
        `Unexpected server downgrade blocked first-capture publication (${dispositionReason}). ` +
        "The source remains review_later until its retained intake evidence is repaired.";
      const { error: sourceQuarantineError } = await supabase
        .from("shared_award_sources")
        .update({
          admin_review_status: "review_later",
          last_error: quarantineMessage,
          updated_at: now,
        })
        .eq("id", source.id);
      if (sourceQuarantineError) {
        throw new Error(`Quarantine downgraded live source failed: ${sourceQuarantineError.message}`);
      }
    }
    await finalizeLiveFirstCaptureManualReview({
      row,
      awardResult,
      aiReview,
      now,
      dispositionReason,
      source,
      phase: "server_downgrade",
    });
    return;
  }

  if (
    apply &&
    liveFirstCaptureRequested &&
    sourceWrite.acquisition?.id &&
    sourceWrite.acquisition.notification_mode === "first_capture_candidate"
  ) {
    await ensureInitialOfficialDocumentCandidateMaterialized({
      row,
      award: awardResult.award,
      source,
      acquisition: sourceWrite.acquisition,
    });
  }

  const candidateRows = factCandidateRowsFromIntake({
    awardId: awardResult.award.id,
    sourceId: source.id,
    sourcePageRequestId: row.id,
    sourceLike,
    review: normalizedReview,
  });

  if (apply && candidateRows.length) {
    const persistedFacts = await persistSourceIntakeFactCandidates(supabase, candidateRows);
    report.fact_candidates_inserted += persistedFacts.inserted;
  } else {
    report.fact_candidates_inserted += candidateRows.length;
  }

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

async function finalizeLiveFirstCaptureManualReview({
  row,
  awardResult,
  aiReview,
  now,
  dispositionReason,
  source = null,
  phase,
}) {
  const reason = cleanNullable(dispositionReason) || "live_first_capture_requires_manual_review";
  const sourceDisposition = source?.id
    ? "The newly inserted source was quarantined as review_later."
    : "No source was registered from this request.";
  const message =
    `The requested live first-capture notification failed safe evidence or provenance validation ` +
    `(${reason}). ${sourceDisposition} Repair the retained request evidence before retrying; ` +
    "do not absorb this document as a healthy baseline.";
  report.needs_manual_review += 1;
  report.errors.push({
    source_page_request_id: row.id,
    source_id: source?.id || null,
    stage: `live_first_capture_${phase}`,
    message,
    solution:
      "Inspect the captured final URL, PDF hash, exact evidence quote, parent source, and worker/request provenance. Retry the retained evidence after repair; request another paid review only if the retained intake bytes themselves are invalid.",
  });
  if (!apply) return;
  await requireOwnedRequestUpdate(row.id, "matching", {
    status: "needs_manual_review",
    status_reason: reason,
    worker_run_id: null,
    matched_shared_award_id: awardResult.created ? null : awardResult.award.id,
    created_shared_award_id: awardResult.created ? awardResult.award.id : null,
    created_source_ids: source?.id ? [source.id] : [],
    ai_review: aiReview,
    processed_at: now,
    failed_at: now,
    error: message.slice(0, 1000),
  });
}

async function ensureInitialOfficialDocumentCandidateMaterialized({
  row,
  award,
  source,
  acquisition,
}) {
  report.initial_document_materialization_attempted += 1;
  try {
    const existing = await loadInitialOfficialDocumentCandidate(acquisition.id);
    if (existing) {
      verifyInitialOfficialDocumentCandidate({ existing, award, source, acquisition });
      await resolveInitialOfficialDocumentMaterializationQuarantine(acquisition.id, existing.id);
      report.initial_document_materialization_candidate_existing += 1;
      report.initial_document_materialization_succeeded += 1;
      return existing;
    }

    const deadlineMarginMs = 5_000;
    const remainingLaneBudgetMs = deadlineAtMs - Date.now() - deadlineMarginMs;
    if (remainingLaneBudgetMs < 5_000) {
      throw new Error(
        "The source-intake lane lacks enough time to safely materialize and verify the sealed first observation.",
      );
    }
    const timeoutMs = Math.min(initialDocumentMaterializationTimeoutMs, remainingLaneBudgetMs);
    report.initial_document_materialization_subprocess_started += 1;
    const execution = await runInitialOfficialDocumentMaterialization({
      row,
      source,
      acquisition,
      timeoutMs,
    });
    const candidate = await loadInitialOfficialDocumentCandidate(acquisition.id);
    if (!candidate) {
      const missing = new Error(
        "The sealed-artifact worker completed without creating the required initial-document candidate.",
      );
      missing.materialization_output = execution;
      throw missing;
    }
    verifyInitialOfficialDocumentCandidate({ existing: candidate, award, source, acquisition });
    await resolveInitialOfficialDocumentMaterializationQuarantine(acquisition.id, candidate.id);
    report.initial_document_materialization_succeeded += 1;
    return candidate;
  } catch (error) {
    let message = errorMessage(error);
    try {
      const recovered = await loadInitialOfficialDocumentCandidate(acquisition.id);
      if (recovered) {
        verifyInitialOfficialDocumentCandidate({ existing: recovered, award, source, acquisition });
        await resolveInitialOfficialDocumentMaterializationQuarantine(acquisition.id, recovered.id);
        report.initial_document_materialization_candidate_existing += 1;
        report.initial_document_materialization_succeeded += 1;
        return recovered;
      }
    } catch (recoveryError) {
      message = `${message} Post-failure candidate verification also failed: ${errorMessage(recoveryError)}`;
    }
    report.initial_document_materialization_failed += 1;
    const output = objectValue(error?.materialization_output);
    const quarantineId = await recordSourceIntakeMaterializationQuarantine({
      row,
      source,
      acquisition,
      message,
      output,
    });
    report.errors.push({
      request_id: row.id,
      source_id: source.id,
      source_acquisition_id: acquisition.id,
      quarantine_id: quarantineId,
      stage: "initial_document_same_pass_materialization",
      message,
      solution:
        "Retry the stored capture and accepted review through reconciliation-only recovery. The retry uses the immutable retained PDF, does not fetch the URL, and creates no Gemini charge.",
      creates_api_charge: false,
    });
    const failure = new Error(
      `The accepted source was not finalized because its exact first-observation candidate could not be verified. ` +
      `Quarantine ${quarantineId}; retry the retained result without charge. ${message}`,
    );
    failure.code = "INITIAL_DOCUMENT_SAME_PASS_MATERIALIZATION_FAILED";
    throw failure;
  }
}

async function loadInitialOfficialDocumentCandidate(acquisitionId) {
  const { data, error } = await supabase
    .from("shared_award_visual_review_candidates")
    .select("*")
    .eq("source_acquisition_id", acquisitionId)
    .eq("candidate_scope", INITIAL_OFFICIAL_DOCUMENT_SCOPE)
    .maybeSingle();
  if (error) {
    throw new Error(`Load exact initial-document candidate failed: ${error.message}`);
  }
  return data || null;
}

async function resolveInitialOfficialDocumentMaterializationQuarantine(acquisitionId, candidateId) {
  const { error } = await supabase.rpc(
    "resolve_initial_official_document_quarantine",
    {
      p_acquisition_id: acquisitionId,
      p_candidate_id: candidateId,
    },
  );
  if (error) {
    throw new Error(`Resolve initial-document materialization quarantine failed: ${error.message}`);
  }
}

function verifyInitialOfficialDocumentCandidate({ existing, award, source, acquisition }) {
  const candidate = objectValue(existing);
  const expected = {
    award_id: cleanNullable(award?.id),
    source_id: cleanNullable(source?.id),
    acquisition_id: cleanNullable(acquisition?.id),
    source_url: cleanNullable(source?.url),
    file_hash: cleanNullable(objectValue(acquisition?.row).review_seal?.capture_file_hash)?.toLowerCase(),
  };
  const mismatches = [];
  if (candidate.candidate_scope !== INITIAL_OFFICIAL_DOCUMENT_SCOPE) mismatches.push("scope");
  if (cleanNullable(candidate.shared_award_id) !== expected.award_id) mismatches.push("award");
  if (cleanNullable(candidate.shared_award_source_id) !== expected.source_id) mismatches.push("source");
  if (cleanNullable(candidate.source_acquisition_id) !== expected.acquisition_id) mismatches.push("acquisition");
  if (cleanNullable(candidate.source_url) !== expected.source_url) mismatches.push("source_url");
  if (cleanNullable(candidate.new_file_hash)?.toLowerCase() !== expected.file_hash) mismatches.push("file_hash");
  if (!["succeeded", "published"].includes(cleanNullable(candidate.status))) mismatches.push("status");
  if (mismatches.length) {
    throw new Error(
      `Initial-document candidate failed exact sealed identity verification (${mismatches.join(", ")}).`,
    );
  }

  const decision = initialOfficialDocumentPublicationDecision({
    candidate,
    source: {
      ...source,
      shared_award_id: expected.award_id,
    },
    result: objectValue(candidate.ai_result),
  });
  if (!decision.allowed) {
    throw new Error(
      `Initial-document candidate failed deterministic publication verification (${decision.reason}).`,
    );
  }
  return candidate;
}

async function runInitialOfficialDocumentMaterialization({ row, source, acquisition, timeoutMs }) {
  const sourceTimeoutMs = Math.max(4_000, timeoutMs - 1_000);
  const commandArgs = [
    join(root, "scripts", "capture-visual-snapshots.mjs"),
    `--env=${envPath}`,
    `--archive-dir=${archiveRoot}`,
    "--limit=1",
    "--all=true",
    `--source-id=${source.id}`,
    "--pdf-only=true",
    "--web-only=false",
    "--promote=true",
    "--visual-review-mode=batch",
    "--extract-baseline-info=false",
    "--backfill-baseline-info=false",
    "--capture-section-evidence=false",
    "--discovery-mode=false",
    "--discover-pdf-subpages=false",
    "--discover-html-subpages=false",
    "--r2-snapshot-sync=true",
    "--r2-repair-missing-snapshots=false",
    "--snapshot-history-prune=false",
    "--source-quality-mode=deterministic",
    "--run-trigger=manual",
    `--run-cohort-id=source-intake:${row.id}`,
    "--initial-official-document-materialization=true",
    `--initial-official-document-acquisition-id=${acquisition.id}`,
    `--source-timeout-ms=${sourceTimeoutMs}`,
  ];

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, commandArgs, {
      cwd: root,
      env: process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const appendTail = (current, chunk) => `${current}${chunk}`.slice(-16_000);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout = appendTail(stdout, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = appendTail(stderr, chunk);
    });

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectPromise(error);
      else resolvePromise(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      const error = new Error(
        `Sealed first-observation materialization exceeded its ${timeoutMs}ms lane reservation.`,
      );
      error.materialization_output = { stdout_tail: stdout, stderr_tail: stderr, timed_out: true };
      finish(error);
    }, timeoutMs);

    child.once("error", (spawnError) => {
      const error = new Error(`Start sealed first-observation materialization failed: ${errorMessage(spawnError)}`);
      error.materialization_output = { stdout_tail: stdout, stderr_tail: stderr, start_failed: true };
      finish(error);
    });
    child.once("close", (code, signal) => {
      const result = {
        exit_code: code,
        signal: signal || null,
        stdout_tail: stdout,
        stderr_tail: stderr,
        timed_out: false,
      };
      if (code === 0) {
        finish(null, result);
        return;
      }
      const error = new Error(
        `Sealed first-observation materialization exited with code ${code ?? "unknown"}` +
        `${signal ? ` (${signal})` : ""}.`,
      );
      error.materialization_output = result;
      finish(error);
    });
  });
}

async function recordSourceIntakeMaterializationQuarantine({
  row,
  source,
  acquisition,
  message,
  output,
}) {
  const evidence = {
    message,
    failure_stage: "source_intake_same_pass_materialization",
    candidate_scope: INITIAL_OFFICIAL_DOCUMENT_SCOPE,
    source_page_request_id: row.id,
    source_intake_worker_run_id: workerRunId,
    materialization_output: {
      exit_code: output.exit_code ?? null,
      signal: output.signal ?? null,
      timed_out: output.timed_out === true,
      start_failed: output.start_failed === true,
      stdout_tail: cleanNullable(output.stdout_tail)?.slice(-4_000) || null,
      stderr_tail: cleanNullable(output.stderr_tail)?.slice(-4_000) || null,
    },
    repair: {
      retry_mode: "reconciliation_only_retained_result_replay",
      creates_api_charge: false,
      fetches_source_url: false,
      preserves_acquisition_identity: true,
      safe_action:
        "Retry the stored capture and accepted review after repairing the local/R2 materialization dependency.",
    },
  };
  const { data: quarantineId, error } = await supabase.rpc(
    "record_initial_official_document_quarantine",
    {
      p_source_id: source.id,
      p_acquisition_id: acquisition.id,
      p_reason_code: "source_intake_same_pass_materialization_failed",
      p_evidence: evidence,
    },
  );
  if (error || !quarantineId) {
    throw new Error(
      `Initial-document materialization failed and durable quarantine persistence also failed: ` +
      `${error?.message || "missing quarantine id"}. Original failure: ${message}`,
    );
  }
  return quarantineId;
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

async function registerAcceptedSource(awardId, sourceLike, row, {
  capture,
  review,
  awardCreated,
  acquisitionProposal: preflightAcquisitionProposal = null,
}) {
  const baselineFacts = baselineFactsFromIntakeReview(objectValue(sourceLike.page_metadata).intake_review || objectValue(row.ai_review));
  const sourcePayload = {
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
  };
  const acquisitionProposal = preflightAcquisitionProposal || buildSourceAcquisitionProposal({
    request: row,
    source: { url: sourceLike.url },
    review,
    capture,
    awardCreated,
    workerRunId,
  });
  const { data, error } = await supabase.rpc("register_shared_award_source_from_intake", {
    p_source: sourcePayload,
    p_acquisition: acquisitionProposal.row,
  });
  if (error) throw new Error(`Register accepted source and acquisition failed: ${error.message}`);
  const registration = Array.isArray(data) ? data[0] : data;
  if (!registration?.source_id) {
    throw new Error("Accepted source registration did not return a source id.");
  }
  const inserted = registration.source_inserted === true;
  const effectiveNotificationMode = cleanNullable(registration.effective_notification_mode)
    || "baseline_only";
  const effectiveDispositionReason = cleanNullable(registration.effective_disposition_reason)
    || (effectiveNotificationMode === acquisitionProposal.notification_mode
      ? acquisitionProposal.reason
      : `server_${effectiveNotificationMode}_policy_decision`);
  const acquisition = registration.acquisition_id
    ? {
        ...acquisitionProposal,
        id: registration.acquisition_id,
        notification_mode: effectiveNotificationMode,
        reason: effectiveDispositionReason,
        row: {
          ...acquisitionProposal.row,
          notification_mode: effectiveNotificationMode,
        },
      }
    : {
        create: false,
        reason: inserted
          ? "acquisition_registration_missing"
          : "preexisting_source_not_reacquired",
        acquisition_kind: acquisitionProposal.acquisition_kind,
        notification_mode: effectiveNotificationMode,
        row: null,
      };
  if (inserted && !registration.acquisition_id) {
    throw new Error("A newly inserted source registration did not create immutable acquisition provenance.");
  }

  return {
    source: {
      id: registration.source_id,
      shared_award_id: awardId,
      url: sourceLike.url,
      title: sourceLike.title,
    },
    inserted,
    acquisition,
  };
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
      provider_batch_bindings_recovered: report.provider_batch_bindings_recovered,
      stale_submission_claims_requeued: report.stale_submission_claims_requeued,
      stale_capture_requests_requeued: report.stale_capture_requests_requeued,
      stale_reconcile_claims_requeued: report.stale_reconcile_claims_requeued,
      stale_free_reconciliation_claims_requeued: report.stale_free_reconciliation_claims_requeued,
      stale_matching_requests_failed_closed: report.stale_matching_requests_failed_closed,
      needs_manual_review: report.needs_manual_review,
      matched_existing_awards: report.matched_existing_awards,
      created_awards: report.created_awards,
      created_or_updated_sources: report.created_or_updated_sources,
      source_acquisitions_created: report.source_acquisitions_created,
      source_acquisitions_first_capture_candidate: report.source_acquisitions_first_capture_candidate,
      source_acquisitions_baseline_only: report.source_acquisitions_baseline_only,
      source_acquisitions_manual_review: report.source_acquisitions_manual_review,
      live_first_capture_preflight_manual_review: report.live_first_capture_preflight_manual_review,
      initial_document_materialization_attempted: report.initial_document_materialization_attempted,
      initial_document_materialization_subprocess_started:
        report.initial_document_materialization_subprocess_started,
      initial_document_materialization_candidate_existing:
        report.initial_document_materialization_candidate_existing,
      initial_document_materialization_succeeded: report.initial_document_materialization_succeeded,
      initial_document_materialization_failed: report.initial_document_materialization_failed,
      source_acquisitions_skipped_preexisting: report.source_acquisitions_skipped_preexisting,
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

function isProtectedLiveFirstCaptureRow(row) {
  return cleanNullable(row?.acquisition_kind) === "live_discovery"
    && cleanNullable(row?.notification_mode) === "first_capture_candidate"
    && !cleanNullable(row?.onboarding_batch_id);
}

function hasProvenRetainedCaptureMetadata(row) {
  return hasProvenCaptureArtifact(row, "retained_artifact", true);
}

function hasProvenStagedCaptureMetadata(row) {
  return hasProvenCaptureArtifact(row, "retained_artifact_staged", false);
}

function hasProvenCaptureArtifact(row, artifactField, requireR2Verified) {
  const capture = captureFromRow(row);
  try {
    validateRetainedIntakeArtifactManifest(capture[artifactField], {
      requestId: row.id,
      fileHash: capture.capture_file_hash,
      finalUrl: capture.canonical_url || capture.final_url,
      requireR2Verified,
      allowUnboundR2Target: !requireR2Verified,
    });
    return true;
  } catch {
    return false;
  }
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
    if (kind === "source_intake_batch_create" && error && typeof error === "object") {
      error.possibleExternalBatchCreated = true;
    }
    throw error;
  }
  if (!response.ok) {
    const error = new Error(`Gemini ${kind} failed: ${response.status} ${text.slice(0, 500)}`);
    if (kind === "source_intake_batch_create") {
      error.possibleExternalBatchCreated = isAmbiguousBatchCreateHttpStatus(response.status);
    }
    throw error;
  }
  return JSON.parse(text);
}

function isAmbiguousBatchCreateHttpStatus(status) {
  const value = Number(status);
  return value === 408 || value === 409 || value === 429 || value >= 500;
}

async function geminiBatchResponseMap(job, expectedKeys = []) {
  const rawResponses = extractGeminiBatchInlineResponses(job);
  const mapped = geminiBatchInlineResponseMap(rawResponses);
  const mappingComplete = geminiBatchExactMappingComplete(rawResponses, mapped, expectedKeys);
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
  return {
    responses: mapped.responses,
    accounting: geminiBatchUsageAccounting(rawResponses, { mappingComplete }),
  };
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
  --initial-document-materialization-timeout-ms=120000
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

function unique(values) {
  return [...new Set(values.filter(Boolean))];
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
