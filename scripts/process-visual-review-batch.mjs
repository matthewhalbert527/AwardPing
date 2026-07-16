#!/usr/bin/env node
import crypto from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  buildVisualReviewPromptText,
  changeDetailsFromVisualBatchResult,
  currentMonitoringPolicyAuditIdentity,
  currentVisualReviewPolicyIdentity,
  expandableSectionCandidateRejectReason,
  fileToInlineGeminiPart,
  latestVisualReviewPolicyDecision,
  normalizeVisualBatchResult,
  rebuildInitialOfficialDocumentCandidateForCurrentPolicy,
  rebuildVisualReviewCandidateForCurrentPolicy,
  refreshVisualReviewPromptPayloadPolicy,
  visualHashFromCandidate,
  visualReviewBatchCreateFailureDisposition,
  visualReviewBatchPollFailureDisposition,
  visualReviewFailureRetryDecision,
  visualReviewResponseSchema,
  visualReviewConditionalSourceApplicantEscape,
  visualReviewSourceIdentityFreshness,
  visualReviewStaleClaimRecoveryDecision,
} from "./lib/visual-review-queue.mjs";
import { assertVisualReviewBatchPolicyCoverage } from "./lib/award-monitoring-policy.mjs";
import { recordVisualRejectionLedger } from "./lib/visual-rejection-ledger.mjs";
import { acquireVisualReviewPublicationClaim } from "./lib/visual-publication-claim.mjs";
import { persistVisualChangeAndReconciliation } from "./lib/visual-change-publication.mjs";
import {
  isDeterministicVisualArtifactError,
  preparePublishedInitialOfficialDocumentEvidence,
  preparePublishedVisualEventEvidence,
} from "./lib/visual-event-evidence.mjs";
import {
  restoreInitialOfficialDocumentCandidateArtifactsFromR2,
} from "./lib/r2-baseline-rehydration.mjs";
import {
  restoreInitialOfficialDocumentCandidateArtifactsFromAcquisition,
} from "./lib/intake-artifact-retention.mjs";
import {
  INITIAL_OFFICIAL_DOCUMENT_SCOPE,
  initialOfficialDocumentEventTimes,
  initialOfficialDocumentPublicationDecision,
  initialOfficialDocumentSourceIdentityDecision,
} from "./lib/initial-official-document.mjs";
import {
  compareVisualCandidateOrder,
  findBlockingPriorVisualPublication,
} from "./lib/visual-publication-order.mjs";
import { sourceQualityDecision } from "./lib/source-quality.mjs";
import { enqueueAwardReconciliation } from "./lib/award-fact-reconciliation.mjs";
import {
  captureFromVisualReviewCandidate,
  promoteApprovedVisualBaselineLocal,
  promoteApprovedVisualBaselineR2,
  visualBaselinePublicationDecision,
} from "./lib/visual-baseline-promotion.mjs";
import { withVisualBaselineLockAsync } from "./lib/visual-baseline-lock.mjs";
import {
  extractGeminiBatchInlineResponses,
  extractGeminiUsageMetadata,
  geminiBatchExactMappingComplete,
  geminiBatchUsageAccounting,
  geminiBatchInlineResponseMap,
  geminiBatchJsonlRequest,
  geminiBatchOutputFileNames,
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
import { geminiWorkerModel } from "./lib/gemini-worker-policy.mjs";
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
const env = {
  ...loadEnvFile(envPath),
  ...process.env,
};

const defaultArchiveRoot = "D:\\AwardPingVisualSnapshots";

const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
const geminiApiKey = env.GEMINI_API_KEY;
const archiveRoot = resolve(
  String(env.AWARDPING_VISUAL_SNAPSHOT_DIR || args["archive-dir"] || defaultArchiveRoot),
);
const r2SnapshotSync = boolArg(
  args["r2-snapshot-sync"] ?? env.AWARDPING_R2_SNAPSHOT_SYNC ?? env.R2_SNAPSHOT_SYNC,
  false,
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
const limit = positiveInt(args.limit, 250);
const maxRequestsPerBatch = positiveInt(args["max-requests-per-batch"], 250);
const inlineThreshold = positiveInt(args["inline-threshold"], 100);
const poll = boolArg(args.poll, true);
const submit = boolArg(args.submit, true);
const apply = boolArg(args.apply, true);
const pollOnly = boolArg(args["poll-only"], false);
const submitOnly = boolArg(args["submit-only"], false);
const recoverMissingBatchResponses = boolArg(args["recover-missing-batch-responses"], true);
const maxFailureRetries = nonNegativeInt(args["max-failure-retries"], 3);
const staleClaimMinutes = positiveInt(args["stale-claim-minutes"], 15);
const publicationClaimStaleMinutes = positiveInt(
  args["publication-claim-stale-minutes"],
  30,
);
const requestTimeoutMs = positiveInt(args["request-timeout-ms"], 120_000);
const reportDir = args["report-dir"]
  ? resolve(root, String(args["report-dir"]))
  : join(root, "reports");
const runStamp = timestampForPath(new Date().toISOString());
const reportPath = args["report"]
  ? resolve(root, String(args.report))
  : join(reportDir, `visual-review-batch-${runStamp}.json`);
const jsonlDir = args["jsonl-dir"]
  ? resolve(root, String(args["jsonl-dir"]))
  : join(reportDir, "visual-review-batch-jsonl");
const model = geminiWorkerModel();
const monitoringPolicy = currentVisualReviewPolicyIdentity();
const monitoringPolicyBundle = currentMonitoringPolicyAuditIdentity();

assertVisualReviewBatchPolicyCoverage();

if (!supabaseUrl || !serviceRoleKey) {
  console.error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  process.exit(1);
}

if (!geminiApiKey) {
  console.error("GEMINI_API_KEY is required to process visual review batches.");
  process.exit(1);
}

if (r2SnapshotSync && (!r2Bucket || !r2Endpoint || !r2AccessKeyId || !r2SecretAccessKey)) {
  console.error(
    "R2 baseline promotion is enabled, but R2_BUCKET, R2_ACCOUNT_ID/R2_ENDPOINT, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY are required.",
  );
  process.exit(1);
}

if (
  apply && poll && !submitOnly &&
  (!r2Bucket || !r2Endpoint || !r2AccessKeyId || !r2SecretAccessKey)
) {
  console.error(
    "Publishing visual changes requires R2_BUCKET, R2_ACCOUNT_ID/R2_ENDPOINT, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY so immutable event evidence can be retained.",
  );
  process.exit(1);
}

mkdirSync(reportDir, { recursive: true });
mkdirSync(jsonlDir, { recursive: true });

const supabase = createSupabaseServiceClient(supabaseUrl, serviceRoleKey);
const report = {
  started_at: new Date().toISOString(),
  finished_at: null,
  status: "running",
  env_path: envPath,
  report_path: reportPath,
  monitoring_policy: monitoringPolicy,
  monitoring_policy_bundle: monitoringPolicyBundle,
  baseline_advancement: {
    rejected_candidates_advance_baseline: false,
    approved_whole_page_candidates_advance_baseline: true,
    expandable_section_candidates_advance_enclosing_whole_page_baseline: true,
    reason: "advance_enclosing_full_capture_after_any_approved_candidate_preserve_rejected_only_captures",
    archive_root: archiveRoot,
    r2_snapshot_sync: r2SnapshotSync,
    local_promoted: 0,
    local_already_current: 0,
    local_skipped: 0,
    local_failed: 0,
    r2_promoted: 0,
    r2_already_current: 0,
    r2_skipped: 0,
    r2_failed: 0,
  },
  options: {
    limit,
    max_requests_per_batch: maxRequestsPerBatch,
    inline_threshold: inlineThreshold,
    poll,
    submit,
    apply,
    recover_missing_batch_responses: recoverMissingBatchResponses,
    max_failure_retries: maxFailureRetries,
    stale_claim_minutes: staleClaimMinutes,
    publication_claim_stale_minutes: publicationClaimStaleMinutes,
  },
  pending_visual_reviews: 0,
  submitted_jobs: 0,
  submitted_candidates: 0,
  processing_jobs: 0,
  succeeded: 0,
  rejected: 0,
  failed: 0,
  published: 0,
  publish_duplicates: 0,
  superseded: 0,
  requeued_for_current_policy: 0,
  requeued_for_current_source_context: 0,
  rejection_ledger_recorded: 0,
  rejection_ledger_unavailable: 0,
  recovered_missing_batch_responses: 0,
  retried_failed_candidates: 0,
  retry_exhausted_candidates: 0,
  recovered_stale_submission_claims: 0,
  provider_batch_bindings_recovered: 0,
  manual_recovery_required_claims: 0,
  submission_claim_conflicts: 0,
  submission_claims_released: 0,
  submission_claims_lost_after_batch_create: 0,
  publication_claims_acquired: 0,
  publication_claim_conflicts: 0,
  recovered_stale_publication_claims: 0,
  stored_publication_retry_errors: 0,
  source_url_changed_since_capture: 0,
  baseline_promotion_pending: 0,
  event_evidence_verified: 0,
  event_evidence_full_fallback: 0,
  event_evidence_upload_failed: 0,
  initial_official_documents_published: 0,
  initial_official_document_duplicates: 0,
  initial_official_document_rejected: 0,
  initial_official_document_quarantined: 0,
  initial_official_document_retry_pending: 0,
  initial_official_document_r2_restore_attempted: 0,
  initial_official_document_r2_artifacts_restored: 0,
  initial_official_document_r2_restore_failed: 0,
  initial_official_document_acquisition_restore_attempted: 0,
  initial_official_document_acquisition_restore_succeeded: 0,
  initial_official_document_acquisition_restore_failed: 0,
  verified_event_crop_sides: 0,
  unavailable_event_crop_sides: 0,
  event_evidence_failures: [],
  awards_queued_for_reconciliation: 0,
  award_reconciliation_queue_existing: 0,
  award_reconciliation_queue_failed: 0,
  estimated_batch_cost_usd: 0,
  budget_deferred_candidates: 0,
  active_work_deferred_candidates: 0,
  spend_reservations_created: 0,
  spend_reservations_settled: 0,
  actual_usage: emptyGeminiUsage(),
  batches: [],
  errors: [],
};

writeReport();

try {
  if (poll && !submitOnly) {
    await pollExistingBatches();
  }

  if (submit && !pollOnly) {
    await submitPendingCandidates();
  }

  await refreshStatusCounts();
  report.status = "succeeded";
} catch (error) {
  report.status = "failed";
  report.error = errorMessage(error);
  throw error;
} finally {
  report.finished_at = new Date().toISOString();
  writeReport();
  console.log(`VISUAL_REVIEW_BATCH_REPORT ${reportPath}`);
}

async function pollExistingBatches() {
  if (apply) await reconcileStoredSucceededCandidates();
  const { data, error } = await supabase
    .from("shared_award_visual_review_candidates")
    .select("gemini_batch_name,model,status,rejection_reason")
    .in(
      "status",
      recoverMissingBatchResponses
        ? ["submitted", "processing", "failed"]
        : ["submitted", "processing"],
    )
    .not("gemini_batch_name", "is", null)
    .limit(10_000);
  if (error) throw new Error(`Load submitted visual review batches failed: ${error.message}`);

  const batchNames = unique((data || [])
    .filter((row) => row.status !== "failed" || row.rejection_reason === "missing_batch_response")
    .map((row) => row.gemini_batch_name));
  for (const batchName of batchNames) {
    const batchReport = {
      name: batchName,
      state: null,
      reconciled: 0,
      rejected: 0,
      failed: 0,
      published: 0,
      publication_claim_conflicts: 0,
      mode: "poll",
    };
    report.batches.push(batchReport);
    try {
      const job = await fetchGeminiJson(`https://generativelanguage.googleapis.com/v1beta/${batchName}`, {
        method: "GET",
        kind: "batch_poll",
      });
      const state = geminiBatchState(job);
      batchReport.state = state;

      if (!isGeminiBatchDone(state)) {
        report.processing_jobs += 1;
        await markBatchRowsProcessing(batchName);
        console.log(`VISUAL_REVIEW_BATCH processing job=${batchName} state=${state || "unknown"}`);
        continue;
      }

      if (!isGeminiBatchSucceeded(state)) {
        const message = geminiBatchErrorMessage(job);
        await settleVisualBatchSpend(batchName, { terminalState: state });
        await markBatchRowsFailed(batchName, message);
        batchReport.failed += 1;
        report.failed += 1;
        console.log(`VISUAL_REVIEW_BATCH failed job=${batchName} state=${state} message=${truncate(message, 240)}`);
        continue;
      }

      await reconcileCompletedBatch(batchName, job, batchReport);
    } catch (error) {
      const message = errorMessage(error);
      const pollFailure = visualReviewBatchPollFailureDisposition({
        kind: error?.geminiRequestKind || "batch_poll",
        httpStatus: error?.geminiHttpStatus,
      });
      if (pollFailure.action === "fail_for_bounded_retry") {
        const missingReason = `gemini_batch_permanently_missing_http_${pollFailure.http_status}`;
        await markBatchRowsFailed(batchName, missingReason);
        batchReport.state = missingReason;
      } else {
        batchReport.state = "poll_error";
      }
      batchReport.error = message;
      batchReport.failed += 1;
      report.failed += 1;
      report.errors.push({
        batch_name: batchName,
        stage: "batch_poll_or_reconcile",
        message,
      });
      console.error(
        `VISUAL_REVIEW_BATCH_POLL_FAILED job=${batchName} message=${truncate(message, 240)}`,
      );
    }
  }
}

async function reconcileStoredSucceededCandidates() {
  const staleBefore = new Date(
    Date.now() - publicationClaimStaleMinutes * 60_000,
  ).toISOString();
  const { data, error } = await supabase
    .from("shared_award_visual_review_candidates")
    .select("*")
    .eq("status", "succeeded")
    .not("ai_result", "is", null)
    // Rows finalized as retry-pending receive a new updated_at. Ordering by
    // that retry timestamp rotates an old failing window behind untouched
    // results, while fresh cross-process claims do not consume the window.
    .or(
      `publication_claim_token.is.null,publication_claimed_at.is.null,publication_claimed_at.lt.${staleBefore}`,
    )
    .order("updated_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(Math.max(limit, 500));
  if (error) throw new Error(`Load stored visual publication retries failed: ${error.message}`);
  const candidates = (data || []).filter((candidate) =>
    Object.keys(objectValue(candidate.ai_result)).length,
  );
  const sources = await loadSourcesById(
    candidates.map((candidate) => candidate.shared_award_source_id),
  );
  for (const candidate of candidates) {
    try {
      const usage = candidate.candidate_scope === INITIAL_OFFICIAL_DOCUMENT_SCOPE
        ? {}
        : normalizeGeminiUsage(candidate.actual_usage);
      const result = candidate.ai_result;
      const claim = await claimCompletedCandidatePublication(candidate, result, usage);
      if (!claim.acquired) {
        report.publication_claim_conflicts += 1;
        continue;
      }
      report.publication_claims_acquired += 1;
      if (claim.recovered) report.recovered_stale_publication_claims += 1;
      const publishResult = await publishCandidateResult({
        candidate: claim.candidate,
        source: sources.get(candidate.shared_award_source_id),
        result,
        usage,
        publicationClaimToken: claim.claim_token,
      });
      if (publishResult.status === "published") report.published += 1;
      else if (publishResult.status === "duplicate") report.publish_duplicates += 1;
      else if (publishResult.status === "superseded") report.superseded += 1;
      else if (publishResult.status === "rejected") report.rejected += 1;
      else if (publishResult.status === "requeued") {
        if (publishResult.reason === "source_context_changed_since_batch_submission") {
          report.requeued_for_current_source_context += 1;
        } else {
          report.requeued_for_current_policy += 1;
        }
      }
      else if (publishResult.status === "retry_pending") {
        report.baseline_promotion_pending += 1;
        report.succeeded += 1;
      } else report.succeeded += 1;
    } catch (error) {
      // Leave any acquired claim intact. Its stale-claim lease is the
      // fail-closed recovery boundary, and one broken source must not prevent
      // later stored results from being reconciled in this run.
      report.stored_publication_retry_errors += 1;
      report.errors.push({
        candidate_id: candidate.id,
        source_id: candidate.shared_award_source_id,
        stage: "stored_publication_retry",
        message: errorMessage(error),
      });
      console.error(
        `VISUAL_REVIEW_STORED_RETRY_FAILED candidate=${candidate.id} source=${candidate.shared_award_source_id} message=${truncate(errorMessage(error), 240)}`,
      );
    }
  }
}

async function submitPendingCandidates() {
  await recoverStaleSubmissionClaims();
  await requeueRetryableFailures();

  const { data, error, count } = await supabase
    .from("shared_award_visual_review_candidates")
    .select("*", { count: "exact" })
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) throw new Error(`Load pending visual review candidates failed: ${error.message}`);

  report.pending_visual_reviews = count || 0;
  const candidates = data || [];
  if (!candidates.length) {
    console.log("VISUAL_REVIEW_BATCH no_pending_candidates");
    return;
  }

  const sourcesById = await loadSourcesById(candidates.map((candidate) => candidate.shared_award_source_id));
  const eligible = [];
  for (const loadedCandidate of candidates) {
    const source = sourcesById.get(loadedCandidate.shared_award_source_id);
    const sourceIdentity = visualReviewSourceIdentityFreshness(loadedCandidate, source);
    if (!sourceIdentity.allowed) {
      await markCandidate(loadedCandidate.id, {
        status: "superseded",
        rejection_reason: sourceIdentity.reason,
        worker_metadata: workerMetadataForCandidate(loadedCandidate, {
          source_identity_guard: sourceIdentity,
          baseline_advanced: false,
          recapture_required: true,
        }),
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      report.superseded += 1;
      report.source_url_changed_since_capture += 1;
      continue;
    }
    const rejectReason = preSubmissionRejectReason(loadedCandidate, source);
    if (rejectReason) {
      await markCandidate(loadedCandidate.id, {
        status: "rejected",
        rejection_reason: rejectReason,
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      report.rejected += 1;
      continue;
    }
    const candidate = await persistPendingCandidateForCurrentPolicy(loadedCandidate, source);
    if (!candidate) continue;
    eligible.push(candidate);
  }

  const byModel = groupBy(eligible, () => model);
  for (const [modelName, modelCandidates] of byModel) {
    for (const chunk of chunks(modelCandidates, maxRequestsPerBatch)) {
      await submitCandidateChunk(modelName, chunk);
    }
  }
}

async function recoverStaleSubmissionClaims() {
  const cutoff = new Date(Date.now() - staleClaimMinutes * 60_000).toISOString();
  const { data, error } = await supabase
    .from("shared_award_visual_review_candidates")
    .select("*")
    .eq("status", "processing")
    .is("gemini_batch_name", null)
    .lt("updated_at", cutoff)
    .limit(Math.max(limit, 500));
  if (error) throw new Error(`Load stale visual submission claims failed: ${error.message}`);

  for (const candidate of data || []) {
    const now = new Date().toISOString();
    let reservation = null;
    let reservationLoadFailed = false;
    try {
      reservation = await loadVisualSpendReservation(candidate.worker_metadata);
      const journaledBatchName = cleanNullable(candidate.worker_metadata?.possible_external_batch_name);
      const claimToken = cleanNullable(candidate.worker_metadata?.submission_claim_token);
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
        reservation = await loadVisualSpendReservation(candidate.worker_metadata);
      }
    } catch (reservationError) {
      reservationLoadFailed = true;
      report.errors.push({
        candidate_id: candidate.id,
        message: `Load visual spend reservation for stale-claim recovery failed: ${errorMessage(reservationError)}`,
      });
    }
    if (
      reservation?.provider_batch_name
      && new Set(["submitted", "settled"]).has(reservation.status)
    ) {
      const { data: restored, error: restoreError } = await supabase
        .from("shared_award_visual_review_candidates")
        .update({
          status: "submitted",
          gemini_batch_name: reservation.provider_batch_name,
          model: reservation.model || candidate.model || geminiWorkerModel(),
          submitted_at: reservation.submitted_at || now,
          completed_at: null,
          rejection_reason: null,
          worker_metadata: workerMetadataForCandidate(candidate, {
            gemini_spend_reservation_id: reservation.id,
            gemini_spend_reservation_key: reservation.reservation_key,
            gemini_spend_attempt_token: reservation.attempt_token,
            provider_binding_recovered_at: now,
          }),
          updated_at: now,
        })
        .eq("id", candidate.id)
        .eq("status", "processing")
        .is("gemini_batch_name", null)
        .lt("updated_at", cutoff)
        .select("id")
        .maybeSingle();
      if (restoreError) throw new Error(`Restore visual provider binding failed: ${restoreError.message}`);
      if (restored) report.provider_batch_bindings_recovered += 1;
      continue;
    }
    const recoveryDecision = reservationLoadFailed
      || (reservation && !new Set(["reserved", "released"]).has(reservation.status))
      ? { action: "fail_closed", reason: `spend_reservation_${reservation?.status || "unavailable"}` }
      : reservation
        ? { action: "requeue", reason: `spend_reservation_${reservation.status}_before_create` }
        : visualReviewStaleClaimRecoveryDecision(candidate);
    if (recoveryDecision.action === "fail_closed") {
      const { data: failedClosed, error: failClosedError } = await supabase
        .from("shared_award_visual_review_candidates")
        .update({
          status: "failed",
          rejection_reason: "manual_recovery_required_possible_external_batch_created",
          worker_metadata: workerMetadataForCandidate(candidate, {
            stale_submission_claim_failed_closed_at: now,
            submission_claim_recovery: recoveryDecision,
          }),
          completed_at: now,
          updated_at: now,
        })
        .eq("id", candidate.id)
        .eq("status", "processing")
        .is("gemini_batch_name", null)
        .lt("updated_at", cutoff)
        .select("id")
        .maybeSingle();
      if (failClosedError) throw new Error(`Fail stale visual submission claim closed failed: ${failClosedError.message}`);
      if (failedClosed) report.manual_recovery_required_claims += 1;
      continue;
    }
    if (recoveryDecision.action !== "requeue") continue;
    const staleClaimToken = cleanNullable(candidate.worker_metadata?.submission_claim_token);
    try {
      const reservationKey = cleanNullable(candidate.worker_metadata?.gemini_spend_reservation_key)
        || (staleClaimToken ? `changed-page-review:${staleClaimToken}` : null);
      if (reservationKey) {
        await releaseUnsubmittedGeminiSpendReservationByKey({
          supabase,
          reservationKey,
          reason: "stale_claim_recovered_before_provider_create",
        });
      }
    } catch (reservationError) {
      const { data: failedClosed, error: failClosedError } = await supabase
        .from("shared_award_visual_review_candidates")
        .update({
          status: "failed",
          rejection_reason: "manual_recovery_required_spend_reservation_state",
          worker_metadata: workerMetadataForCandidate(candidate, {
            stale_submission_claim_failed_closed_at: now,
            spend_reservation_recovery_error: truncate(errorMessage(reservationError), 800),
          }),
          completed_at: now,
          updated_at: now,
        })
        .eq("id", candidate.id)
        .eq("status", "processing")
        .is("gemini_batch_name", null)
        .lt("updated_at", cutoff)
        .select("id")
        .maybeSingle();
      if (failClosedError) throw new Error(`Fail unsafe stale visual reservation closed failed: ${failClosedError.message}`);
      if (failedClosed) report.manual_recovery_required_claims += 1;
      continue;
    }
    const { data: recovered, error: recoverError } = await supabase
      .from("shared_award_visual_review_candidates")
      .update({
        status: "pending",
        worker_metadata: workerMetadataForCandidate(candidate, {
          stale_submission_claim_recovered_at: now,
          stale_submission_claim_token: candidate.worker_metadata?.submission_claim_token || null,
          submission_claim_token: null,
          gemini_spend_attempt_token: null,
          gemini_spend_reservation_id: null,
          gemini_spend_reservation_key: null,
        }),
        updated_at: now,
      })
      .eq("id", candidate.id)
      .eq("status", "processing")
      .is("gemini_batch_name", null)
      .lt("updated_at", cutoff)
      .select("id")
      .maybeSingle();
    if (recoverError) throw new Error(`Recover stale visual submission claim failed: ${recoverError.message}`);
    if (recovered) report.recovered_stale_submission_claims += 1;
  }
}

async function loadVisualSpendReservation(workerMetadata) {
  const reservationId = cleanNullable(workerMetadata?.gemini_spend_reservation_id);
  const reservationKey = cleanNullable(workerMetadata?.gemini_spend_reservation_key);
  if (!reservationId && !reservationKey) return null;
  let query = supabase
    .from("gemini_spend_reservations")
    .select("id,reservation_key,attempt_token,status,provider_batch_name,submitted_at,model");
  query = reservationId ? query.eq("id", reservationId) : query.eq("reservation_key", reservationKey);
  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(`Load visual spend reservation failed: ${error.message}`);
  if (data && reservationKey && data.reservation_key !== reservationKey) {
    throw new Error("Visual spend reservation identity mismatch.");
  }
  return data || null;
}

async function requeueRetryableFailures() {
  const { data, error } = await supabase
    .from("shared_award_visual_review_candidates")
    .select("*")
    .eq("status", "failed")
    .order("updated_at", { ascending: true })
    .limit(Math.max(limit, 500));
  if (error) throw new Error(`Load failed visual review candidates failed: ${error.message}`);

  for (const candidate of data || []) {
    const decision = visualReviewFailureRetryDecision(candidate, {
      maxRetries: maxFailureRetries,
    });
    if (!decision.retry) {
      if (decision.reason === "failure_retry_limit_reached") {
        report.retry_exhausted_candidates += 1;
      }
      continue;
    }
    const now = new Date().toISOString();
    const failureHistory = [
      ...(Array.isArray(candidate.worker_metadata?.failure_history)
        ? candidate.worker_metadata.failure_history
        : []),
      {
        failed_at: candidate.completed_at || candidate.updated_at || null,
        reason: candidate.rejection_reason || "unknown_failure",
        batch_name: candidate.gemini_batch_name || null,
        model: candidate.model || null,
      },
    ].slice(-10);
    const { data: requeued, error: requeueError } = await supabase
      .from("shared_award_visual_review_candidates")
      .update({
        status: "pending",
        gemini_batch_name: null,
        model: null,
        submitted_at: null,
        completed_at: null,
        published_at: null,
        ai_result: null,
        actual_usage: {},
        rejection_reason: null,
        worker_metadata: workerMetadataForCandidate(candidate, {
          failure_retry_count: decision.next_retry_count,
          failure_history: failureHistory,
          failure_requeued_at: now,
          submission_claim_token: null,
        }),
        updated_at: now,
      })
      .eq("id", candidate.id)
      .eq("status", "failed")
      .select("id")
      .maybeSingle();
    if (requeueError) throw new Error(`Requeue failed visual review candidate failed: ${requeueError.message}`);
    if (requeued) report.retried_failed_candidates += 1;
  }
}

async function persistPendingCandidateForCurrentPolicy(candidate, source) {
  const rebuilt = rebuildVisualReviewCandidateForCurrentPolicy(candidate, { source });
  const storedPolicy = objectValue(candidate?.prompt_payload?.monitoring_policy);
  const storedPolicyBundle = objectValue(candidate?.prompt_payload?.monitoring_policy_bundle);
  const policyNeedsRefresh =
    cleanText(storedPolicy.hash) !== cleanText(monitoringPolicy.hash);
  const effectiveContextNeedsRefresh =
    candidate.candidate_signature !== rebuilt.candidate_signature ||
    candidate.gemini_batch_request_key !== rebuilt.candidate_signature ||
    policyNeedsRefresh ||
    candidate.prompt_context !== rebuilt.prompt_context;
  const needsRefresh =
    effectiveContextNeedsRefresh ||
    cleanText(storedPolicyBundle.hash) !== cleanText(monitoringPolicyBundle.hash);
  if (!needsRefresh) return candidate;

  const conflict = await findCandidateWithSignature(
    rebuilt.candidate_signature,
    candidate.id,
  );
  if (conflict) {
    await markCandidate(candidate.id, {
      status: "superseded",
      rejection_reason: `current_policy_candidate_exists:${conflict.id}`,
      worker_metadata: workerMetadataForCandidate(candidate, {
        superseded_by_candidate_id: conflict.id,
        superseded_during_pending_policy_refresh: true,
      }),
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    report.superseded += 1;
    return null;
  }

  const now = new Date().toISOString();
  const patch = {
    candidate_signature: rebuilt.candidate_signature,
    gemini_batch_request_key: rebuilt.candidate_signature,
    source_url: rebuilt.source_context.url || candidate.source_url,
    source_title: rebuilt.source_context.title || candidate.source_title,
    source_page_type: rebuilt.source_context.page_type || candidate.source_page_type,
    prompt_payload: rebuilt.prompt_payload,
    prompt_context: rebuilt.prompt_context,
    worker_metadata: workerMetadataForCandidate(candidate, {
      pending_policy_refreshed_at: now,
      pending_policy_refreshed_from: storedPolicy,
      prompt_rebuilt_from_current_policy: true,
    }),
    updated_at: now,
  };
  const { data, error } = await supabase
    .from("shared_award_visual_review_candidates")
    .update(patch)
    .eq("id", candidate.id)
    .eq("status", "pending")
    .select("*")
    .maybeSingle();
  if (error) {
    if (error.code === "23505") {
      const racedConflict = await findCandidateWithSignature(
        rebuilt.candidate_signature,
        candidate.id,
      );
      if (racedConflict) {
        await markCandidate(candidate.id, {
          status: "superseded",
          rejection_reason: `current_policy_candidate_exists:${racedConflict.id}`,
          worker_metadata: workerMetadataForCandidate(candidate, {
            superseded_by_candidate_id: racedConflict.id,
            superseded_during_pending_policy_refresh: true,
          }),
          completed_at: now,
          updated_at: now,
        });
        report.superseded += 1;
        return null;
      }
    }
    throw new Error(`Refresh pending visual candidate policy failed: ${error.message}`);
  }
  if (!data) return null;
  if (effectiveContextNeedsRefresh) {
    if (policyNeedsRefresh) report.requeued_for_current_policy += 1;
    else report.requeued_for_current_source_context += 1;
  }
  return data;
}

async function findCandidateWithSignature(candidateSignature, excludedId) {
  const { data, error } = await supabase
    .from("shared_award_visual_review_candidates")
    .select("id,status")
    .eq("candidate_signature", candidateSignature)
    .neq("id", excludedId)
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new Error(`Check current-policy visual candidate failed: ${error.message}`);
  }
  return data || null;
}

async function submitCandidateChunk(model, candidates) {
  const claimToken = crypto.randomUUID();
  const claimedAt = new Date().toISOString();
  const displayName = `awardping-visual-review-${timestampForPath(claimedAt)}-${claimToken.slice(0, 8)}-${model.replace(/[^a-z0-9._-]+/gi, "-")}`;
  const claimedCandidates = [];
  for (const candidate of candidates) {
    const { data: claimed, error: claimError } = await supabase
      .from("shared_award_visual_review_candidates")
      .update({
        status: "processing",
        worker_metadata: workerMetadataForCandidate(candidate, {
          submission_claim_token: claimToken,
          submission_claimed_at: claimedAt,
          submission_claimed_by: "process-visual-review-batch",
          batch_display_name: displayName,
        }),
        updated_at: claimedAt,
      })
      .eq("id", candidate.id)
      .eq("status", "pending")
      .is("gemini_batch_name", null)
      .select("*")
      .maybeSingle();
    if (claimError) throw new Error(`Claim visual review candidate ${candidate.id} failed: ${claimError.message}`);
    if (claimed) claimedCandidates.push(claimed);
    else report.submission_claim_conflicts += 1;
  }
  if (!claimedCandidates.length) return;

  const requests = claimedCandidates.map((candidate) => geminiBatchRequestForCandidate(candidate));
  const mode = requests.length > inlineThreshold ? "jsonl_file" : "inline";
  const estimated = estimateGeminiMaximumBatchRequestsCostUsd(model, requests, {
    maxOutputTokensPerRequest: 900,
  });
  const reservationKey = `changed-page-review:${claimToken}`;
  const workFingerprint = paidReviewWorkFingerprint(
    "changed-page-review",
    model,
    claimedCandidates.map((candidate) => candidate.candidate_signature || candidate.id),
  );
  let spendReservation = null;
  try {
    spendReservation = await reserveGeminiSpend({
      supabase,
      laneKey: GEMINI_PAID_LANES.CHANGED_PAGE_REVIEW,
      reservationKey,
      attemptToken: claimToken,
      workFingerprint,
      estimatedCostUsd: estimated,
      workerSource: "process-visual-review-batch",
      requestCount: claimedCandidates.length,
      model,
      metadata: {
        claim_token: claimToken,
        display_name: displayName,
        candidate_ids: claimedCandidates.map((candidate) => candidate.id),
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
        activeDisposition = await deferVisualSubmissionClaimsForActiveWork(claimedCandidates, claimToken, activeWork);
      } else {
        await releaseSubmissionClaims(claimedCandidates, claimToken, error);
      }
    } catch (recoveryError) {
      await failSubmissionClaimsClosed(claimedCandidates, claimToken, recoveryError);
      throw recoveryError;
    }
    if (!(error instanceof GeminiBudgetUnavailableError)) throw error;
    if (activeWork) {
      report.active_work_deferred_candidates += claimedCandidates.length;
      if (activeDisposition?.manualRecoveryRequired) {
        report.manual_recovery_required_claims += claimedCandidates.length;
      }
      report.batches.push({
        name: null,
        model,
        mode: activeDisposition?.manualRecoveryRequired ? "active_work_manual_recovery" : "active_work_in_flight",
        requested_candidates: claimedCandidates.length,
        estimated_cost_usd: roundUsd(estimated),
        active_work: { ...error.status, recovered_status: activeDisposition?.status || activeWork.status },
      });
      console.log(
        `VISUAL_REVIEW_ACTIVE_WORK candidates=${claimedCandidates.length} status=${activeDisposition?.status || activeWork.status} reservation=${activeWork.reservationId}`,
      );
      return;
    }
    report.budget_deferred_candidates += claimedCandidates.length;
    report.batches.push({
      name: null,
      model,
      mode: "budget_deferred",
      requested_candidates: claimedCandidates.length,
      estimated_cost_usd: roundUsd(estimated),
      budget: error.status,
    });
    console.log(
      `VISUAL_REVIEW_BUDGET_DEFERRED candidates=${claimedCandidates.length} remaining_usd=${error.status?.remaining_usd ?? 0} reset_at=${error.status?.reset_at || "unknown"}`,
    );
    return;
  }
  let batch;
  try {
    batch = await createGeminiBatchJob({
      model,
      requests,
      displayName,
      mode,
      beforeCreate: () => markSubmissionClaimsCreateStarted(claimedCandidates, claimToken, {
        spendReservation,
        reservationKey,
        estimatedCostUsd: estimated,
      }),
    });
  } catch (error) {
    if (error?.possibleExternalBatchCreated) {
      await failSubmissionClaimsClosed(claimedCandidates, claimToken, error);
    } else {
      await releaseGeminiSpendReservation({
        supabase,
        reservationId: spendReservation.reservation_id,
        reason: `${error?.safeToReleaseBatchClaim ? "provider_create_definitively_failed" : "provider_create_not_reached"}:${errorMessage(error)}`.slice(0, 500),
        expectedStatus: error?.safeToReleaseBatchClaim ? "creating" : null,
        expectedAttemptToken: claimToken,
      });
      await releaseSubmissionClaims(claimedCandidates, claimToken, error);
    }
    throw error;
  }
  const batchName = geminiBatchJobName(batch);
  if (!batchName) {
    const error = new Error(`Gemini batch creation did not return a batch name: ${JSON.stringify(batch).slice(0, 500)}`);
    error.possibleExternalBatchCreated = true;
    await failSubmissionClaimsClosed(claimedCandidates, claimToken, error);
    throw error;
  }
  try {
    await journalVisualProviderBatchName(claimedCandidates, claimToken, batchName);
  } catch (error) {
    error.possibleExternalBatchCreated = true;
    await failSubmissionClaimsClosed(claimedCandidates, claimToken, error, batchName);
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
    error.possibleExternalBatchCreated = true;
    await failSubmissionClaimsClosed(claimedCandidates, claimToken, error, batchName);
    throw error;
  }

  const now = new Date().toISOString();
  const submittedCandidates = [];
  for (const candidate of claimedCandidates) {
    const submittedCandidate = await persistSubmittedClaim({
      candidate,
      claimToken,
      batchName,
      model,
      mode,
      displayName,
      submittedAt: now,
      spendReservation,
      estimatedCostUsd: estimated,
    });
    if (submittedCandidate) submittedCandidates.push(submittedCandidate);
    else report.submission_claims_lost_after_batch_create += 1;
  }

  report.submitted_jobs += 1;
  report.submitted_candidates += submittedCandidates.length;
  report.estimated_batch_cost_usd = roundUsd(report.estimated_batch_cost_usd + estimated);
  report.batches.push({
    name: batchName,
    model,
    mode,
    requested_candidates: claimedCandidates.length,
    submitted_candidates: submittedCandidates.length,
    lost_claims: claimedCandidates.length - submittedCandidates.length,
    estimated_cost_usd: roundUsd(estimated),
  });
  console.log(`VISUAL_REVIEW_BATCH submitted job=${batchName} model=${model} candidates=${submittedCandidates.length}/${claimedCandidates.length} mode=${mode}`);
}

async function persistSubmittedClaim({
  candidate,
  claimToken,
  batchName,
  model,
  mode,
  displayName,
  submittedAt,
  spendReservation,
  estimatedCostUsd,
}) {
  let lastError = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const { data, error } = await supabase
      .from("shared_award_visual_review_candidates")
      .update({
        status: "submitted",
        gemini_batch_name: batchName,
        model,
        submitted_at: submittedAt,
        updated_at: submittedAt,
        worker_metadata: workerMetadataForCandidate(candidate, {
          submitted_by: "process-visual-review-batch",
          submitted_at: submittedAt,
          batch_input_mode: mode,
          display_name: displayName,
          batch_display_name: displayName,
          submission_claim_token: claimToken,
          gemini_spend_reservation_id: spendReservation.reservation_id,
          gemini_spend_lane: GEMINI_PAID_LANES.CHANGED_PAGE_REVIEW,
          gemini_spend_estimated_cost_usd: roundUsd(estimatedCostUsd),
          prompt_rebuilt_from_current_policy: true,
        }),
      })
      .eq("id", candidate.id)
      .eq("status", "processing")
      .is("gemini_batch_name", null)
      .contains("worker_metadata", { submission_claim_token: claimToken })
      .select("*")
      .maybeSingle();
    if (!error) return data || null;
    lastError = error;
    if (attempt < 4) await sleep(attempt * 500);
  }
  throw new Error(
    `Persist Gemini batch ${batchName} candidate ${candidate.id} failed after retries: ${lastError?.message || "unknown error"}`,
  );
}

async function markSubmissionClaimsCreateStarted(
  candidates,
  claimToken,
  { spendReservation, reservationKey, estimatedCostUsd },
) {
  const startedAt = new Date().toISOString();
  for (const candidate of candidates) {
    const { data, error } = await supabase
      .from("shared_award_visual_review_candidates")
      .update({
        worker_metadata: workerMetadataForCandidate(candidate, {
          batch_create_started_at: startedAt,
          gemini_spend_reservation_id: spendReservation.reservation_id,
          gemini_spend_reservation_key: reservationKey,
          gemini_spend_attempt_token: claimToken,
          gemini_spend_lane: GEMINI_PAID_LANES.CHANGED_PAGE_REVIEW,
          gemini_spend_estimated_cost_usd: estimatedCostUsd,
        }),
        updated_at: startedAt,
      })
      .eq("id", candidate.id)
      .eq("status", "processing")
      .is("gemini_batch_name", null)
      .contains("worker_metadata", { submission_claim_token: claimToken })
      .select("id,worker_metadata")
      .maybeSingle();
    if (error) {
      throw new Error(`Mark Gemini create start for ${candidate.id} failed: ${error.message}`);
    }
    if (!data) {
      throw new Error(`Submission claim ${candidate.id} was lost before Gemini create POST.`);
    }
    candidate.worker_metadata = data.worker_metadata;
  }
  await markGeminiSpendCreateStarted({
    supabase,
    reservationId: spendReservation.reservation_id,
    attemptToken: claimToken,
    metadata: {
      reservation_key: reservationKey,
      candidate_ids: candidates.map((candidate) => candidate.id),
    },
  });
}

async function journalVisualProviderBatchName(candidates, claimToken, batchName) {
  const returnedAt = new Date().toISOString();
  for (const candidate of candidates) {
    const { data, error } = await supabase
      .from("shared_award_visual_review_candidates")
      .update({
        worker_metadata: workerMetadataForCandidate(candidate, {
          possible_external_batch_name: batchName,
          provider_batch_returned_at: returnedAt,
        }),
        updated_at: returnedAt,
      })
      .eq("id", candidate.id)
      .eq("status", "processing")
      .is("gemini_batch_name", null)
      .contains("worker_metadata", { submission_claim_token: claimToken })
      .select("worker_metadata")
      .maybeSingle();
    if (error) throw new Error(`Journal visual provider Batch ${batchName} failed: ${error.message}`);
    if (!data) throw new Error(`Visual submission claim ${candidate.id} was lost after provider create.`);
    candidate.worker_metadata = data.worker_metadata;
  }
}

async function deferVisualSubmissionClaimsForActiveWork(candidates, claimToken, activeWork) {
  const now = new Date().toISOString();
  const reservation = await loadGeminiSpendReservation({
    supabase,
    reservationId: activeWork.reservationId,
  });
  const providerBound = new Set(["submitted", "settled"]).has(reservation.status)
    && cleanNullable(reservation.provider_batch_name);
  const manualRecovery = reservation.status === "creating" && !providerBound;
  for (const candidate of candidates) {
    const metadata = workerMetadataForCandidate(candidate, {
      submission_claim_token: providerBound ? null : reservation.attempt_token,
      submission_claim_released_at: now,
      submission_claim_release_reason: `Equivalent Gemini review already has an active ${reservation.status} reservation.`,
      batch_create_started_at: manualRecovery ? reservation.create_started_at || now : null,
      gemini_spend_attempt_token: reservation.attempt_token,
      gemini_spend_reservation_id: reservation.id,
      gemini_spend_reservation_key: reservation.reservation_key,
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
      provider_binding_recovered_at: providerBound ? now : null,
    });
    const { data, error } = await supabase
      .from("shared_award_visual_review_candidates")
      .update({
        status: providerBound ? "submitted" : manualRecovery ? "failed" : "processing",
        gemini_batch_name: providerBound ? reservation.provider_batch_name : null,
        model: reservation.model || candidate.model || geminiWorkerModel(),
        submitted_at: providerBound ? reservation.submitted_at || now : candidate.submitted_at || null,
        completed_at: manualRecovery ? now : null,
        rejection_reason: manualRecovery
          ? "manual_recovery_required_equivalent_review_create_started"
          : null,
        worker_metadata: metadata,
        updated_at: now,
      })
      .eq("id", candidate.id)
      .eq("status", "processing")
      .is("gemini_batch_name", null)
      .contains("worker_metadata", { submission_claim_token: claimToken })
      .select("id")
      .maybeSingle();
    if (error) throw new Error(`Defer visual active-work claim ${candidate.id} failed: ${error.message}`);
    if (!data) report.submission_claim_conflicts += 1;
    else if (providerBound) report.provider_batch_bindings_recovered += 1;
  }
  if (manualRecovery) {
    report.errors.push({
      stage: "visual_active_work_recovery",
      message: `Equivalent Gemini provider-create reservation ${reservation.id} requires manual recovery; a second paid call was not created.`,
    });
  }
  return {
    status: reservation.status,
    manualRecoveryRequired: manualRecovery,
    providerBound: Boolean(providerBound),
  };
}

async function releaseSubmissionClaims(candidates, claimToken, cause) {
  const now = new Date().toISOString();
  for (const candidate of candidates) {
    const { data, error } = await supabase
      .from("shared_award_visual_review_candidates")
      .update({
        status: "pending",
        worker_metadata: workerMetadataForCandidate(candidate, {
          submission_claim_token: null,
          submission_claim_released_at: now,
          submission_claim_release_reason: truncate(errorMessage(cause), 800),
          batch_create_started_at: null,
          batch_create_failed_at: now,
          gemini_spend_attempt_token: null,
          gemini_spend_reservation_id: null,
          gemini_spend_reservation_key: null,
        }),
        updated_at: now,
      })
      .eq("id", candidate.id)
      .eq("status", "processing")
      .is("gemini_batch_name", null)
      .contains("worker_metadata", { submission_claim_token: claimToken })
      .select("id")
      .maybeSingle();
    if (error) {
      report.errors.push({
        candidate_id: candidate.id,
        message: `Release visual submission claim failed: ${error.message}`,
      });
      continue;
    }
    if (data) report.submission_claims_released += 1;
  }
}

async function failSubmissionClaimsClosed(candidates, claimToken, cause, providerBatchName = null) {
  const now = new Date().toISOString();
  for (const candidate of candidates) {
    const knownBatchName = cleanNullable(providerBatchName);
    const { data, error } = await supabase
      .from("shared_award_visual_review_candidates")
      .update({
        status: knownBatchName ? "submitted" : "failed",
        gemini_batch_name: knownBatchName,
        submitted_at: knownBatchName ? now : candidate.submitted_at || null,
        rejection_reason: knownBatchName
          ? null
          : "manual_recovery_required_possible_external_batch_created",
        worker_metadata: workerMetadataForCandidate(candidate, {
          submission_claim_failed_closed_at: now,
          possible_external_batch_error: truncate(errorMessage(cause), 800),
          possible_external_batch_name: knownBatchName,
          provider_binding_recovery_required: Boolean(knownBatchName),
          manual_recovery_batch_display_name:
            candidate.worker_metadata?.batch_display_name || null,
        }),
        completed_at: knownBatchName ? null : now,
        updated_at: now,
      })
      .eq("id", candidate.id)
      .eq("status", "processing")
      .is("gemini_batch_name", null)
      .contains("worker_metadata", { submission_claim_token: claimToken })
      .select("id")
      .maybeSingle();
    if (error) {
      report.errors.push({
        candidate_id: candidate.id,
        message: `Fail ambiguous visual submission claim closed failed: ${error.message}`,
      });
      continue;
    }
    if (data && !knownBatchName) report.manual_recovery_required_claims += 1;
  }
}

async function reconcileCompletedBatch(batchName, job, batchReport) {
  const { data, error } = await supabase
    .from("shared_award_visual_review_candidates")
    .select("*")
    .eq("gemini_batch_name", batchName)
    .in("status", recoverMissingBatchResponses ? ["submitted", "processing", "succeeded", "failed"] : ["submitted", "processing", "succeeded"])
    .order("created_at", { ascending: true });
  if (error) throw new Error(`Load visual review candidates for ${batchName} failed: ${error.message}`);

  const candidates = (data || []).filter((candidate) =>
    candidate.status !== "failed" || candidate.rejection_reason === "missing_batch_response"
  );
  const sourcesById = await loadSourcesById(candidates.map((candidate) => candidate.shared_award_source_id));
  const batchResponses = await geminiBatchResponseMap(
    job,
    candidates.map((candidate) => candidate.id),
  );
  const responseMap = batchResponses.responses;
  // Settle terminal provider spend before changing any candidate/publication
  // state. Retrying after a crash is safe because settlement is idempotent.
  await settleVisualBatchSpend(batchName, {
    terminalState: geminiBatchState(job),
    accounting: batchResponses.accounting,
  });

  for (const candidate of candidates) {
    const recoveringMissingResponse = candidate.status === "failed" && candidate.rejection_reason === "missing_batch_response";
    const storedResult = candidate.status === "succeeded" &&
      Object.keys(objectValue(candidate.ai_result)).length
      ? candidate.ai_result
      : null;
    let usage = normalizeGeminiUsage(candidate.actual_usage);
    let result = storedResult;
    if (!storedResult) {
      const responseItem = responseMap.get(candidate.id) || responseMap.get(candidate.gemini_batch_request_key);
      if (!responseItem) {
        await markCandidate(candidate.id, {
          status: "failed",
          rejection_reason: "missing_batch_response",
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
        report.failed += 1;
        batchReport.failed += 1;
        continue;
      }

      if (recoveringMissingResponse) report.recovered_missing_batch_responses += 1;
      const itemError = geminiInlineError(responseItem);
      if (itemError) {
        await markCandidate(candidate.id, {
          status: "failed",
          rejection_reason: geminiInlineErrorMessage(itemError),
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
        report.failed += 1;
        batchReport.failed += 1;
        continue;
      }

      usage = normalizeGeminiUsage(extractUsageMetadata(responseItem));
      const rawText = extractGeminiText(geminiInlineResponsePayload(responseItem));
      try {
        result = normalizeVisualBatchResult(rawText, {
          candidate,
          source: sourcesById.get(candidate.shared_award_source_id),
        });
      } catch (error) {
        await markCandidate(candidate.id, {
          status: "failed",
          ai_result: {
            raw_text: rawText,
            parse_error: errorMessage(error),
          },
          rejection_reason: `invalid_ai_json: ${errorMessage(error)}`,
          actual_usage: usage,
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
        report.failed += 1;
        batchReport.failed += 1;
        continue;
      }
    }

    let publicationClaim = null;
    if (apply) {
      publicationClaim = await claimCompletedCandidatePublication(candidate, result, usage);
      if (!publicationClaim.acquired) {
        report.publication_claim_conflicts += 1;
        batchReport.publication_claim_conflicts += 1;
        continue;
      }
      report.publication_claims_acquired += 1;
      if (publicationClaim.recovered) {
        report.recovered_stale_publication_claims += 1;
      }
    }

    addUsage(report.actual_usage, usage);
    const publishCandidate = publicationClaim?.candidate || candidate;
    const source = sourcesById.get(candidate.shared_award_source_id);
    const publishResult = apply
      ? await publishCandidateResult({
          candidate: publishCandidate,
          source,
          result,
          usage,
          publicationClaimToken: publicationClaim.claim_token,
        })
      : await markCandidateSucceededDryRun({ candidate, result, usage });
    batchReport.reconciled += 1;
    if (publishResult.status === "published") {
      report.published += 1;
      batchReport.published += 1;
    } else if (publishResult.status === "duplicate") {
      report.publish_duplicates += 1;
    } else if (publishResult.status === "superseded") {
      report.superseded += 1;
    } else if (publishResult.status === "rejected") {
      report.rejected += 1;
      batchReport.rejected += 1;
    } else if (publishResult.status === "requeued") {
      if (publishResult.reason === "source_context_changed_since_batch_submission") {
        report.requeued_for_current_source_context += 1;
      } else {
        report.requeued_for_current_policy += 1;
      }
    } else if (publishResult.status === "retry_pending") {
      report.baseline_promotion_pending += 1;
      report.succeeded += 1;
    } else {
      report.succeeded += 1;
    }
  }
}

async function claimCompletedCandidatePublication(candidate, result, usage) {
  const now = new Date().toISOString();
  return acquireVisualReviewPublicationClaim({
    candidate,
    claimToken: crypto.randomUUID(),
    now,
    staleAfterMs: publicationClaimStaleMinutes * 60_000,
    metadata: {
      monitoring_policy: monitoringPolicy,
      monitoring_policy_bundle: monitoringPolicyBundle,
    },
    candidatePatch: {
      ai_result: result,
      actual_usage: usage,
      completed_at: now,
    },
    compareAndSet: async ({ expected, patch }) => {
      let query = supabase
        .from("shared_award_visual_review_candidates")
        .update(patch)
        .eq("id", expected.id)
        .eq("status", expected.status)
        .eq("updated_at", expected.updated_at);
      query = expected.publication_claim_token
        ? query.eq("publication_claim_token", expected.publication_claim_token)
        : query.is("publication_claim_token", null);
      const { data, error } = await query.select("*").maybeSingle();
      if (error) {
        if (error.code === "23505") return null;
        throw new Error(`Claim completed visual candidate publication failed: ${error.message}`);
      }
      return data || null;
    },
  });
}

async function publishCandidateResult(args) {
  const sourceId = args?.source?.id || args?.candidate?.shared_award_source_id;
  if (!sourceId) return publishCandidateResultUnlocked(args);
  return withVisualBaselineLockAsync({
    archiveRoot,
    sourceId,
    timeoutMs: 5 * 60_000,
    operation: () => publishCandidateResultUnlocked(args),
  });
}

async function publishCandidateResultUnlocked({
  candidate,
  source,
  result,
  usage,
  publicationClaimToken,
}) {
  const now = new Date().toISOString();
  if (!source) {
    await markPublicationCandidate(candidate, publicationClaimToken, {
      status: "rejected",
      ai_result: result,
      actual_usage: usage,
      rejection_reason: "missing_source",
      completed_at: now,
      updated_at: now,
    });
    return { status: "rejected", reason: "missing_source" };
  }

  if (source.admin_review_status && source.admin_review_status !== "open") {
    await markPublicationCandidate(candidate, publicationClaimToken, {
      status: "rejected",
      ai_result: result,
      actual_usage: usage,
      rejection_reason: `source_not_open_${source.admin_review_status}`,
      completed_at: now,
      updated_at: now,
    });
    return { status: "rejected", reason: "source_not_open" };
  }

  const initialDocumentCandidate = candidate.candidate_scope === INITIAL_OFFICIAL_DOCUMENT_SCOPE;
  const sourceIdentity = initialDocumentCandidate
    ? initialOfficialDocumentSourceIdentityDecision({ candidate, source })
    : visualReviewSourceIdentityFreshness(candidate, source);
  if (!sourceIdentity.allowed) {
    if (initialDocumentCandidate) {
      const quarantineId = await recordInitialOfficialDocumentPublicationQuarantine({
        candidate,
        source,
        result,
        reason: sourceIdentity.reason,
        failureStage: "source_identity",
        publicationDecision: { allowed: false, source_identity: sourceIdentity },
      });
      await markPublicationCandidate(candidate, publicationClaimToken, {
        status: "succeeded",
        ai_result: result,
        actual_usage: {},
        rejection_reason: `publish_retry_pending:${sourceIdentity.reason}`,
        worker_metadata: workerMetadataForCandidate(candidate, {
          source_identity_guard: sourceIdentity,
          baseline_advanced: false,
          recapture_required: false,
          reuse_completed_batch_response: true,
          rejection_disposition: "actionable_initial_document_quarantine",
          manual_quarantine_id: quarantineId,
          creates_api_charge: false,
        }),
        completed_at: now,
        updated_at: now,
      });
      report.source_url_changed_since_capture += 1;
      report.initial_official_document_retry_pending += 1;
      return { status: "retry_pending", reason: sourceIdentity.reason };
    }
    await markPublicationCandidate(candidate, publicationClaimToken, {
      status: "superseded",
      ai_result: result,
      actual_usage: usage,
      rejection_reason: sourceIdentity.reason,
      worker_metadata: workerMetadataForCandidate(candidate, {
        source_identity_guard: sourceIdentity,
        baseline_advanced: false,
        recapture_required: true,
      }),
      completed_at: now,
      updated_at: now,
    });
    report.source_url_changed_since_capture += 1;
    return { status: "superseded", reason: sourceIdentity.reason };
  }

  const priorPublication = await findPriorNonterminalPublication(candidate);
  if (priorPublication) {
    await markPublicationCandidate(candidate, publicationClaimToken, {
      status: "succeeded",
      ai_result: result,
      actual_usage: usage,
      rejection_reason: `source_publication_order_pending:${priorPublication.id}`,
      worker_metadata: workerMetadataForCandidate(candidate, {
        baseline_advanced: false,
        blocked_by_prior_publication_candidate_id: priorPublication.id,
        source_publication_order_guard: true,
        reuse_completed_batch_response: true,
      }),
      completed_at: now,
      updated_at: now,
    });
    return { status: "retry_pending", reason: "prior_source_publication_pending" };
  }

  if (candidate.candidate_scope === INITIAL_OFFICIAL_DOCUMENT_SCOPE) {
    return publishInitialOfficialDocumentCandidate({
      candidate,
      source,
      result,
      publicationClaimToken,
      now,
    });
  }

  const currentContextCandidate = rebuildVisualReviewCandidateForCurrentPolicy(candidate, {
    source,
  });
  if (currentContextCandidate.candidate_signature !== candidate.candidate_signature) {
    return requeueCandidateForCurrentPolicy({
      candidate,
      source,
      policyDecision: {
        allowed: false,
        reason: "source_context_changed_since_batch_submission",
        policy_identity: monitoringPolicy,
        guard: "source_context_freshness",
      },
      usage,
      now,
      publicationClaimToken,
    });
  }

  const eventDetectedAt =
    candidate?.new_snapshot_ref?.captured_at ||
    candidate?.prompt_payload?.new_snapshot_ref?.captured_at ||
    candidate?.created_at ||
    now;
  const changeDetails = {
    ...changeDetailsFromVisualBatchResult({
      candidate,
      source,
      result,
      model: candidate.model,
    }),
    generated_at: eventDetectedAt,
  };
  const policyDecision = latestVisualReviewPolicyDecision({
    candidate,
    source,
    result,
    changeDetails,
  });
  if (!policyDecision.allowed) {
    if (policyDecision.guard === "policy_freshness") {
      return requeueCandidateForCurrentPolicy({
        candidate,
        source,
        policyDecision,
        usage,
        now,
        publicationClaimToken,
      });
    }
    let ledgerResult = null;
    try {
      ledgerResult = await recordVisualRejectionLedger(supabase, {
        candidate,
        policyIdentity: monitoringPolicy,
        rejectionReason: policyDecision.reason,
        now,
      });
      if (ledgerResult.recorded) report.rejection_ledger_recorded += 1;
      else if (ledgerResult.reason === "ledger_table_missing") {
        report.rejection_ledger_unavailable += 1;
      }
    } catch (ledgerError) {
      report.rejection_ledger_unavailable += 1;
      report.errors.push({
        candidate_id: candidate.id,
        source_id: candidate.shared_award_source_id,
        message: `Visual rejection ledger write failed: ${errorMessage(ledgerError)}`,
      });
    }
    // A rejected capture can be a transient access page or incomplete render. Keep the
    // last-known-good local/R2 baseline; the policy-aware signature prevents identical
    // evidence from being resubmitted until either the evidence or policy changes.
    await markPublicationCandidate(candidate, publicationClaimToken, {
      status: "rejected",
      ai_result: {
        ...result,
        policy_guard: policyDecision,
        rejection_ledger: ledgerResult,
      },
      actual_usage: usage,
      rejection_reason: policyDecision.reason,
      worker_metadata: workerMetadataForCandidate(candidate, {
        policy_guard: policyDecision,
        baseline_advanced: false,
        baseline_advancement_reason: "preserve_last_known_good_local_and_r2_baseline",
      }),
      completed_at: now,
      updated_at: now,
    });
    return { status: "rejected", reason: policyDecision.reason };
  }

  const baselinePromotion = await promoteApprovedBaselineForCandidate({
    candidate,
    source,
    now,
  });
  const baselinePublication = visualBaselinePublicationDecision({
    candidate,
    local: baselinePromotion.local,
    r2: baselinePromotion.r2,
    r2Required: r2SnapshotSync,
  });
  if (baselinePublication.action === "supersede") {
    await markPublicationCandidate(candidate, publicationClaimToken, {
      status: "superseded",
      ai_result: result,
      actual_usage: usage,
      rejection_reason: `baseline_promotion_superseded:${baselinePublication.reason}`,
      worker_metadata: workerMetadataForCandidate(candidate, {
        policy_guard: policyDecision,
        baseline_advanced: false,
        baseline_promotion: baselinePromotion,
        baseline_publication_guard: baselinePublication,
      }),
      completed_at: now,
      updated_at: now,
    });
    return { status: "superseded", reason: baselinePublication.reason };
  }
  if (baselinePublication.action === "retry") {
    await markPublicationCandidate(candidate, publicationClaimToken, {
      status: "succeeded",
      ai_result: result,
      actual_usage: usage,
      rejection_reason: `baseline_promotion_pending:${baselinePublication.reason}`,
      worker_metadata: workerMetadataForCandidate(candidate, {
        policy_guard: policyDecision,
        baseline_advanced: false,
        baseline_promotion: baselinePromotion,
        baseline_publication_guard: baselinePublication,
        reuse_completed_batch_response: true,
      }),
      completed_at: now,
      updated_at: now,
    });
    return { status: "retry_pending", reason: baselinePublication.reason };
  }

  let eventEvidence;
  try {
    eventEvidence = await preparePublishedVisualEventEvidence({
      candidate,
      source,
      changeDetails,
      archiveRoot,
      now,
      config: {
        bucket: r2Bucket,
        endpoint: r2Endpoint,
        accessKeyId: r2AccessKeyId,
        secretAccessKey: r2SecretAccessKey,
      },
    });
  } catch (error) {
    const message = errorMessage(error);
    report.event_evidence_upload_failed += 1;
    report.event_evidence_failures.push({
      candidate_id: candidate.id,
      source_id: candidate.shared_award_source_id,
      stage: "prepare_and_verify_permanent_artifacts",
      reason: message,
      solution: visualEventEvidenceFailureSolution(message),
    });
    report.errors.push({
      candidate_id: candidate.id,
      source_id: candidate.shared_award_source_id,
      message: `Permanent visual event evidence failed: ${message}`,
    });
    await markPublicationCandidate(candidate, publicationClaimToken, {
      status: "succeeded",
      ai_result: result,
      actual_usage: usage,
      rejection_reason: "publish_retry_pending:event_evidence_not_durable",
      worker_metadata: workerMetadataForCandidate(candidate, {
        policy_guard: policyDecision,
        baseline_advanced: true,
        baseline_promotion: baselinePromotion,
        event_evidence_error: message,
        reuse_completed_batch_response: true,
      }),
      completed_at: now,
      updated_at: now,
    });
    return { status: "retry_pending", reason: "event_evidence_not_durable" };
  }
  const eventEvidenceSides = Object.values(eventEvidence.localization?.sides || {});
  const requiredEvidenceSides = eventEvidenceSides.filter((side) => side?.required === true);
  const verifiedEvidenceSideCount = requiredEvidenceSides.filter(
    (side) => side?.status === "verified" && side?.exact_overlap === true,
  ).length;
  const unavailableEvidenceSideCount = requiredEvidenceSides.filter(
    (side) => side?.status !== "verified" || side?.exact_overlap !== true,
  ).length;

  const previousHash = visualHashFromCandidate(candidate, "previous");
  const newHash = visualHashFromCandidate(candidate, "new");
  const eventIdentity = {
    shared_award_id: candidate.shared_award_id,
    source_url: source.url || candidate.source_url,
    previous_hash: previousHash,
    new_hash: newHash,
  };
  const publication = await persistVisualChangeAndReconciliation({
    eventIdentity,
    publishEventWithEvidence: async () => {
      const { data, error } = await supabase.rpc("publish_shared_award_visual_event", {
        p_event: {
          visual_review_candidate_id: candidate.id,
          shared_award_id: candidate.shared_award_id,
          shared_award_source_id: candidate.shared_award_source_id,
          source_url: eventIdentity.source_url,
          source_title: source.title || candidate.source_title || null,
          source_page_type: source.page_type || candidate.source_page_type || null,
          previous_snapshot_id: null,
          new_snapshot_id: null,
          previous_hash: previousHash,
          new_hash: newHash,
          summary: changeDetails.reader_summary,
          change_details: changeDetails,
          detected_at: eventDetectedAt,
        },
        p_evidence: eventEvidence,
      });
      if (error) throw new Error(`Atomic visual event/evidence publication failed: ${error.message}`);
      return Array.isArray(data) ? data[0] || null : data || null;
    },
    enqueueReconciliation: async (eventId) => queueAwardReconciliationForCandidate({
      candidate,
      source,
      reason: "visual_change_published",
      candidateIds: [candidate.id],
      metadata: {
        change_event_id: eventId,
        batch_candidate_status: "publication_claimed",
      },
    }),
  });

  if (publication.action !== "publish") {
    if (publication.reason === "change_event_evidence_publication_error") {
      report.event_evidence_failures.push({
        candidate_id: candidate.id,
        source_id: candidate.shared_award_source_id,
        stage: "atomic_event_evidence_binding",
        reason: publication.error || publication.reason,
        solution: visualEventEvidenceFailureSolution(publication.error || publication.reason),
      });
    }
    await markPublicationCandidate(candidate, publicationClaimToken, {
      status: "succeeded",
      ai_result: result,
      actual_usage: usage,
      rejection_reason: `publish_retry_pending:${publication.reason}`,
      worker_metadata: workerMetadataForCandidate(candidate, {
        policy_guard: policyDecision,
        baseline_advanced: true,
        baseline_promotion: baselinePromotion,
        change_event_id: publication.event_id || null,
        change_event_evidence_id: publication.evidence_id || null,
        change_event_publication: publication,
        reuse_completed_batch_response: true,
      }),
      completed_at: now,
      updated_at: now,
    });
    report.errors.push({
      candidate_id: candidate.id,
      source_id: candidate.shared_award_source_id,
      message: `Publish visual review candidate retry pending: ${publication.error || publication.reason}`,
    });
    return { status: "retry_pending", reason: publication.reason };
  }

  report.verified_event_crop_sides += verifiedEvidenceSideCount;
  report.unavailable_event_crop_sides += unavailableEvidenceSideCount;
  if (eventEvidence.evidence_status === "verified") report.event_evidence_verified += 1;
  else report.event_evidence_full_fallback += 1;

  await markPublicationCandidate(candidate, publicationClaimToken, {
    status: "published",
    ai_result: result,
    actual_usage: usage,
    worker_metadata: workerMetadataForCandidate(candidate, {
      policy_guard: policyDecision,
      baseline_advanced: Boolean(
        baselinePromotion.local?.promoted || baselinePromotion.local?.already_current,
      ),
      baseline_promotion: baselinePromotion,
      change_event_id: publication.event_id,
      change_event_evidence_id: publication.evidence_id,
      reconciliation: publication.reconciliation,
    }),
    completed_at: now,
    published_at: now,
    updated_at: now,
  });

  return publication.duplicate
    ? { status: "duplicate", event_id: publication.event_id }
    : { status: "published", event_id: publication.event_id };
}

async function publishInitialOfficialDocumentCandidate({
  candidate,
  source,
  result,
  publicationClaimToken,
  now,
}) {
  const decision = initialOfficialDocumentPublicationDecision({ candidate, source, result });
  if (!decision.allowed) {
    const quarantineId = await recordInitialOfficialDocumentPublicationQuarantine({
      candidate,
      source,
      result,
      reason: decision.reason,
      failureStage: "publication_guard",
      publicationDecision: decision,
    });
    report.initial_official_document_rejected += 1;
    await markPublicationCandidate(candidate, publicationClaimToken, {
      status: "rejected",
      ai_result: result,
      actual_usage: {},
      rejection_reason: decision.reason,
      worker_metadata: workerMetadataForCandidate(candidate, {
        initial_document_publication_guard: decision,
        baseline_advanced: false,
        rejection_disposition: "actionable_initial_document_quarantine",
        manual_quarantine_id: quarantineId,
      }),
      completed_at: now,
      updated_at: now,
    });
    return { status: "rejected", reason: decision.reason };
  }

  const eventTimes = initialOfficialDocumentEventTimes({ candidate });
  const eventDetectedAt = eventTimes.detected_at;
  const changeDetails = {
    ...decision.change_details,
    first_observed_at: eventTimes.first_observed_at,
    recognized_at: eventTimes.recognized_at,
    generated_at: eventTimes.generated_at,
  };
  const policyDecision = latestVisualReviewPolicyDecision({
    candidate,
    source,
    result,
    changeDetails,
  });
  if (!policyDecision.allowed) {
    if (policyDecision.guard === "policy_freshness") {
      return requeueInitialDocumentCandidateForCurrentPolicy({
        candidate,
        policyDecision,
        now,
        publicationClaimToken,
      });
    }

    let ledgerResult = null;
    try {
      ledgerResult = await recordVisualRejectionLedger(supabase, {
        candidate,
        policyIdentity: monitoringPolicy,
        rejectionReason: policyDecision.reason,
        now,
      });
      if (ledgerResult.recorded) report.rejection_ledger_recorded += 1;
      else if (ledgerResult.reason === "ledger_table_missing") {
        report.rejection_ledger_unavailable += 1;
      }
    } catch (ledgerError) {
      report.rejection_ledger_unavailable += 1;
      report.errors.push({
        candidate_id: candidate.id,
        source_id: candidate.shared_award_source_id,
        message: `Initial-document rejection ledger write failed: ${errorMessage(ledgerError)}`,
      });
    }

    const intentionallySuppressed = policyDecision.guard === "change_event_suppression";
    const quarantineId = intentionallySuppressed
      ? null
      : await recordInitialOfficialDocumentPublicationQuarantine({
          candidate,
          source,
          result,
          reason: policyDecision.reason,
          failureStage: "current_policy_validation",
          publicationDecision: decision,
          policyDecision,
        });

    report.initial_official_document_rejected += 1;
    await markPublicationCandidate(candidate, publicationClaimToken, {
      status: "rejected",
      ai_result: {
        ...result,
        policy_guard: policyDecision,
        rejection_ledger: ledgerResult,
      },
      actual_usage: {},
      rejection_reason: policyDecision.reason,
      worker_metadata: workerMetadataForCandidate(candidate, {
        initial_document_publication_guard: decision,
        policy_guard: policyDecision,
        baseline_advanced: false,
        rejection_disposition: intentionallySuppressed
          ? "intentional_policy_suppression_non_actionable"
          : "actionable_initial_document_quarantine",
        manual_quarantine_id: quarantineId,
      }),
      completed_at: now,
      updated_at: now,
    });
    return { status: "rejected", reason: policyDecision.reason };
  }

  let eventEvidence;
  let candidateArtifactRestore = null;
  const prepareInitialDocumentEvidence = () =>
    preparePublishedInitialOfficialDocumentEvidence({
      candidate,
      source,
      archiveRoot,
      now,
      config: {
        bucket: r2Bucket,
        endpoint: r2Endpoint,
        accessKeyId: r2AccessKeyId,
        secretAccessKey: r2SecretAccessKey,
      },
    });
  try {
    try {
      eventEvidence = await prepareInitialDocumentEvidence();
    } catch (error) {
      if (
        !isDeterministicVisualArtifactError(error) ||
        error.code !== "visual_artifact_missing"
      ) {
        throw error;
      }

      report.initial_official_document_r2_restore_attempted += 1;
      try {
        const snapshotRecord = await loadInitialOfficialDocumentR2SnapshotRecord(
          candidate.shared_award_source_id,
        );
        candidateArtifactRestore = await restoreInitialOfficialDocumentCandidateArtifactsFromR2({
          archiveRoot,
          source,
          candidate,
          snapshotRecord,
          bucket: r2Bucket,
          config: {
            bucket: r2Bucket,
            endpoint: r2Endpoint,
            accessKeyId: r2AccessKeyId,
            secretAccessKey: r2SecretAccessKey,
          },
        });
      } catch (restoreError) {
        candidateArtifactRestore = {
          restored: false,
          reason: "r2_snapshot_pointer_load_failed",
          detail: errorMessage(restoreError),
        };
      }

      if (!candidateArtifactRestore?.restored) {
        report.initial_official_document_acquisition_restore_attempted += 1;
        const rotatingSnapshotFailure = candidateArtifactRestore;
        try {
          const acquisition = await loadInitialOfficialDocumentSourceAcquisition(
            candidate.source_acquisition_id,
          );
          candidateArtifactRestore = await restoreInitialOfficialDocumentCandidateArtifactsFromAcquisition({
            archiveRoot,
            source,
            acquisition,
            candidate,
            bucket: r2Bucket,
            config: {
              bucket: r2Bucket,
              endpoint: r2Endpoint,
              accessKeyId: r2AccessKeyId,
              secretAccessKey: r2SecretAccessKey,
            },
          });
          candidateArtifactRestore.rotating_snapshot_restore = rotatingSnapshotFailure;
        } catch (acquisitionRestoreError) {
          candidateArtifactRestore = {
            restored: false,
            reason: "acquisition_intake_artifact_load_failed",
            detail: errorMessage(acquisitionRestoreError),
            rotating_snapshot_restore: rotatingSnapshotFailure,
          };
        }
        if (candidateArtifactRestore?.restored) {
          report.initial_official_document_acquisition_restore_succeeded += 1;
        } else {
          report.initial_official_document_acquisition_restore_failed += 1;
        }
      }

      if (!candidateArtifactRestore?.restored) {
        report.initial_official_document_r2_restore_failed += 1;
        const restoreError = new Error(
          `Candidate-bound R2 artifact restore refused (${candidateArtifactRestore?.reason || "unknown"}): ` +
          `${candidateArtifactRestore?.detail || "No exact immutable generation was restored."}`,
        );
        restoreError.initialDocumentCandidateArtifactRestore = candidateArtifactRestore;
        throw restoreError;
      }
      report.initial_official_document_r2_artifacts_restored += Number(
        candidateArtifactRestore.artifact_count || 0,
      );
      eventEvidence = await prepareInitialDocumentEvidence();
    }
  } catch (error) {
    const message = errorMessage(error);
    const restoreEvidence =
      error?.initialDocumentCandidateArtifactRestore || candidateArtifactRestore;
    const evidenceFailureStage = restoreEvidence?.restored === false
      ? "candidate_artifact_recovery"
      : "permanent_evidence_preparation";
    let quarantineId = null;
    let quarantineWriteError = null;
    try {
      quarantineId = await recordInitialOfficialDocumentPublicationQuarantine({
        candidate,
        source,
        result,
        reason:
          restoreEvidence?.reason ||
          error?.code ||
          "initial_document_evidence_not_durable",
        failureStage: evidenceFailureStage,
        publicationDecision: decision,
        policyDecision,
        candidateArtifactRestore: restoreEvidence,
      });
    } catch (quarantineError) {
      quarantineWriteError = errorMessage(quarantineError);
      report.errors.push({
        candidate_id: candidate.id,
        source_id: candidate.shared_award_source_id,
        stage: "record_initial_document_evidence_quarantine",
        message: quarantineWriteError,
        solution:
          "Restore the initial-document quarantine RPC/migration and retry this same zero-charge publication result; do not create a replacement candidate.",
      });
    }
    report.event_evidence_upload_failed += 1;
    report.initial_official_document_retry_pending += 1;
    report.event_evidence_failures.push({
      candidate_id: candidate.id,
      source_id: candidate.shared_award_source_id,
      stage: evidenceFailureStage,
      reason: message,
      candidate_artifact_restore: restoreEvidence,
      quarantine_id: quarantineId,
      quarantine_write_error: quarantineWriteError,
      solution: restoreEvidence?.restored === false
        ? initialDocumentCandidateRestoreFailureSolution(restoreEvidence)
        : visualEventEvidenceFailureSolution(message),
    });
    await markPublicationCandidate(candidate, publicationClaimToken, {
      status: "succeeded",
      ai_result: result,
      actual_usage: {},
      rejection_reason: "publish_retry_pending:initial_document_evidence_not_durable",
      worker_metadata: workerMetadataForCandidate(candidate, {
        initial_document_publication_guard: decision,
        policy_guard: policyDecision,
        baseline_advanced: false,
        event_evidence_error: message,
        initial_document_candidate_artifact_restore: restoreEvidence,
        initial_document_evidence_failure_stage: evidenceFailureStage,
        rejection_disposition: "actionable_initial_document_quarantine",
        manual_quarantine_id: quarantineId,
        manual_quarantine_write_error: quarantineWriteError,
        creates_api_charge: false,
        reuse_completed_batch_response: true,
      }),
      completed_at: now,
      updated_at: now,
    });
    return { status: "retry_pending", reason: "initial_document_evidence_not_durable" };
  }

  const eventIdentity = {
    shared_award_id: candidate.shared_award_id,
    source_url: decision.source_identity?.event_source_url || source.url,
    previous_hash: decision.previous_hash,
    new_hash: decision.new_hash,
  };
  const publication = await persistVisualChangeAndReconciliation({
    eventIdentity,
    publishEventWithEvidence: async () => {
      const { data, error } = await supabase.rpc("publish_shared_award_initial_document_event", {
        p_event: {
          visual_review_candidate_id: candidate.id,
          source_acquisition_id: candidate.source_acquisition_id,
          shared_award_id: candidate.shared_award_id,
          shared_award_source_id: candidate.shared_award_source_id,
          source_url: decision.source_identity?.event_source_url || source.url,
          source_title: candidate.source_title || null,
          source_page_type: candidate.source_page_type || null,
          previous_hash: decision.previous_hash,
          new_hash: decision.new_hash,
          summary: changeDetails.reader_summary,
          change_details: changeDetails,
          detected_at: eventDetectedAt,
        },
        p_evidence: eventEvidence,
      });
      if (error) {
        throw new Error(`Atomic initial-document event/evidence publication failed: ${error.message}`);
      }
      return Array.isArray(data) ? data[0] || null : data || null;
    },
    enqueueReconciliation: async (eventId) => queueAwardReconciliationForCandidate({
      candidate,
      source,
      reason: "initial_official_document_published",
      candidateIds: [candidate.id],
      metadata: {
        change_event_id: eventId,
        source_acquisition_id: candidate.source_acquisition_id,
        event_kind: "new_official_document",
        review_mode: "deterministic_sealed_acquisition_review",
      },
    }),
  });

  if (publication.action !== "publish") {
    const publicationPersistenceFailed =
      initialDocumentPublicationPersistenceFailed(publication);
    let publicationQuarantineId = null;
    let publicationQuarantineWriteError = null;
    if (publicationPersistenceFailed) {
      try {
        publicationQuarantineId = await recordInitialOfficialDocumentPublicationQuarantine({
          candidate,
          source,
          result,
          reason: publication.reason || "change_event_evidence_not_durable",
          failureStage: "publication_persistence",
          publicationDecision: decision,
          policyDecision,
          publicationFailure: publication,
          retryMode: "automatic_zero_charge_publication_retry",
        });
      } catch (quarantineError) {
        publicationQuarantineWriteError = errorMessage(quarantineError);
        report.errors.push({
          candidate_id: candidate.id,
          source_id: candidate.shared_award_source_id,
          stage: "record_initial_document_publication_persistence_quarantine",
          message: publicationQuarantineWriteError,
          solution:
            "Restore the initial-document quarantine RPC/migration and retry this same zero-charge publication result; do not create a replacement candidate.",
        });
      }
      report.event_evidence_upload_failed += 1;
      report.event_evidence_failures.push({
        candidate_id: candidate.id,
        source_id: candidate.shared_award_source_id,
        stage: "publication_persistence",
        reason: publication.error || publication.reason,
        quarantine_id: publicationQuarantineId,
        quarantine_write_error: publicationQuarantineWriteError,
        solution:
          "Verify the atomic initial-document publication RPC, migration, and database availability, then let the worker retry this retained candidate automatically without charge.",
      });
    }
    report.initial_official_document_retry_pending += 1;
    await markPublicationCandidate(candidate, publicationClaimToken, {
      status: "succeeded",
      ai_result: result,
      actual_usage: {},
      rejection_reason: `publish_retry_pending:${publication.reason}`,
      worker_metadata: workerMetadataForCandidate(candidate, {
        initial_document_publication_guard: decision,
        policy_guard: policyDecision,
        baseline_advanced: false,
        change_event_id: publication.event_id || null,
        change_event_evidence_id: publication.evidence_id || null,
        change_event_publication: publication,
        ...(publicationPersistenceFailed ? {
          initial_document_evidence_failure_stage: "publication_persistence",
          rejection_disposition: "actionable_initial_document_quarantine",
          manual_quarantine_id: publicationQuarantineId,
          manual_quarantine_write_error: publicationQuarantineWriteError,
          retry_mode: "automatic_zero_charge_publication_retry",
          creates_api_charge: false,
        } : {}),
        reuse_completed_batch_response: true,
      }),
      completed_at: now,
      updated_at: now,
    });
    report.errors.push({
      candidate_id: candidate.id,
      source_id: candidate.shared_award_source_id,
      stage: publicationPersistenceFailed
        ? "publication_persistence"
        : "award_reconciliation_enqueue",
      quarantine_id: publicationQuarantineId,
      message: `Publish initial official document retry pending: ${publication.error || publication.reason}`,
      solution: publicationPersistenceFailed
        ? "Repair the atomic event/evidence publication dependency and allow the same zero-charge candidate to retry automatically."
        : "Repair the award reconciliation queue and retry; the event and evidence are already durable, so do not create an initial-document evidence quarantine.",
    });
    return { status: "retry_pending", reason: publication.reason };
  }

  if (publication.duplicate) report.initial_official_document_duplicates += 1;
  else report.initial_official_documents_published += 1;
  await markPublicationCandidate(candidate, publicationClaimToken, {
    status: "published",
    ai_result: result,
    actual_usage: {},
    rejection_reason: null,
    worker_metadata: workerMetadataForCandidate(candidate, {
      initial_document_publication_guard: decision,
      policy_guard: policyDecision,
      baseline_advanced: false,
      change_event_id: publication.event_id,
      change_event_evidence_id: publication.evidence_id,
      reconciliation: publication.reconciliation,
      creates_api_charge: false,
    }),
    completed_at: now,
    published_at: now,
    updated_at: now,
  });
  await resolveInitialOfficialDocumentPublicationQuarantine(candidate);

  return publication.duplicate
    ? { status: "duplicate", event_id: publication.event_id }
    : { status: "published", event_id: publication.event_id };
}

async function loadInitialOfficialDocumentR2SnapshotRecord(sourceId) {
  const { data, error } = await supabase
    .from("shared_award_source_visual_snapshots")
    .select(
      "shared_award_source_id, shared_award_id, kind, bucket, source_url, latest_captured_at, latest_object_keys, latest_hashes, latest_metadata, previous_captured_at, previous_object_keys, previous_hashes, previous_metadata, updated_at",
    )
    .eq("shared_award_source_id", sourceId)
    .maybeSingle();
  if (error) {
    throw new Error(`Load initial-document R2 snapshot pointer failed: ${error.message}`);
  }
  return data || null;
}

function initialDocumentPublicationPersistenceFailed(publication) {
  if (publication?.action === "publish") return false;
  // The publication coordinator reaches reconciliation only after both IDs
  // are durable. A retry carrying both IDs is therefore reconciliation-only
  // and must not be mislabeled as an initial-document evidence failure.
  return !publication?.event_id || !publication?.evidence_id;
}

async function resolveInitialOfficialDocumentPublicationQuarantine(candidate) {
  const { error } = await supabase.rpc("resolve_initial_official_document_quarantine", {
    p_acquisition_id: candidate.source_acquisition_id,
    p_candidate_id: candidate.id,
  });
  if (error) {
    report.errors.push({
      candidate_id: candidate.id,
      source_id: candidate.shared_award_source_id,
      stage: "resolve_initial_document_publication_quarantine",
      message: `Published initial-document quarantine resolution failed: ${error.message}`,
    });
  }
}

async function recordInitialOfficialDocumentPublicationQuarantine({
  candidate,
  source,
  result,
  reason,
  failureStage,
  publicationDecision = null,
  policyDecision = null,
  candidateArtifactRestore = null,
  publicationFailure = null,
  retryMode = "manual_candidate_evidence_repair",
}) {
  const reasonCode = cleanText(reason)
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 200) || "unknown_initial_document_publication_failure";
  const message =
    `The first-observation candidate failed safe ${failureStage.replace(/_/g, " ")} ` +
    `validation: ${reasonCode}.`;
  const { data: quarantineId, error } = await supabase.rpc(
    "record_initial_official_document_quarantine",
    {
      p_source_id: source?.id || candidate.shared_award_source_id,
      p_acquisition_id: candidate.source_acquisition_id,
      p_reason_code: reasonCode,
      p_evidence: {
        message,
        failure_stage: failureStage,
        candidate_scope: INITIAL_OFFICIAL_DOCUMENT_SCOPE,
        candidate: {
          id: candidate.id,
          signature: candidate.candidate_signature,
          status: candidate.status,
          source_url: candidate.source_url,
          new_file_hash: candidate.new_file_hash,
        },
        result: {
          candidate_scope: result?.candidate_scope || null,
          observation_kind: result?.observation_kind || null,
          is_true_change: result?.is_true_change === true,
          is_alert_worthy: result?.is_alert_worthy === true,
          exact_before: result?.exact_before ?? result?.before ?? null,
          exact_after: result?.exact_after ?? result?.after ?? null,
          review_execution: objectValue(result?.review_execution),
        },
        publication_guard: publicationDecision,
        policy_guard: policyDecision,
        candidate_artifact_restore: candidateArtifactRestore,
        publication_failure: publicationFailure,
        repair: {
          retry_mode: retryMode,
          creates_api_charge: false,
          preserves_candidate_identity: true,
          resolves_only_after_publication: true,
        },
      },
    },
  );
  if (error || !quarantineId) {
    throw new Error(
      `Record initial-document publication quarantine failed: ${error?.message || "missing quarantine id"}`,
    );
  }
  report.initial_official_document_quarantined += 1;
  report.errors.push({
    candidate_id: candidate.id,
    source_id: candidate.shared_award_source_id,
    source_acquisition_id: candidate.source_acquisition_id,
    quarantine_id: quarantineId,
    stage: failureStage,
    message,
    solution: failureStage === "source_identity"
      ? "Restore the source URL to the candidate URL or the exact final URL sealed by the retained capture. This retry is free and must not replace immutable candidate evidence."
      : failureStage === "publication_persistence"
        ? "Verify the atomic event/evidence publication RPC, migration, and database availability. AwardPing will retry this retained candidate automatically without charge; do not create a replacement review."
      : new Set(["candidate_artifact_recovery", "permanent_evidence_preparation"]).has(failureStage)
        ? "Inspect the candidate-bound paths, artifact manifest, exact R2 generation, and permanent-evidence dependency. Repairing and retrying this candidate is free; never substitute another document or rewrite candidate identity."
        : "Inspect the sealed acquisition, retained PDF, and deterministic candidate. Repairing candidate evidence is free; approve another paid new-page review only if the sealed intake review itself must be replaced.",
  });
  return quarantineId;
}

async function queueAwardReconciliationForCandidate({
  candidate,
  source,
  reason,
  candidateIds = [],
  metadata = {},
}) {
  if (!candidate?.shared_award_id) return null;
  try {
    const result = await enqueueAwardReconciliation(supabase, {
      awardId: candidate.shared_award_id,
      reason,
      sourceIds: [source?.id || candidate.shared_award_source_id].filter(Boolean),
      candidateIds,
      priority: 70,
      metadata: {
        ...metadata,
        queued_by: "process-visual-review-batch",
        visual_candidate_id: candidate.id,
      },
    });
    if (result.queued) report.awards_queued_for_reconciliation += 1;
    else if (result.id) report.award_reconciliation_queue_existing += 1;
    else {
      report.award_reconciliation_queue_failed += 1;
      report.errors.push({
        candidate_id: candidate.id,
        source_id: candidate.shared_award_source_id,
        message: `Award reconciliation queue not durable: ${result.reason || "missing_queue_id"}`,
      });
    }
    return result;
  } catch (error) {
    report.award_reconciliation_queue_failed += 1;
    report.errors.push({
      candidate_id: candidate.id,
      source_id: candidate.shared_award_source_id,
      message: `Award reconciliation queue failed: ${errorMessage(error)}`,
    });
    return null;
  }
}

async function promoteApprovedBaselineForCandidate({ candidate, source, now }) {
  let localRaw;
  try {
    localRaw = promoteApprovedVisualBaselineLocal({
      candidate,
      source,
      archiveRoot,
      approved: true,
      now,
    });
  } catch (error) {
    report.baseline_advancement.local_failed += 1;
    report.errors.push({
      candidate_id: candidate.id,
      source_id: source.id,
      message: `Approved local baseline promotion failed: ${errorMessage(error)}`,
    });
    return {
      local: { promoted: false, reason: "local_promotion_error", error: errorMessage(error) },
      r2: { promoted: false, reason: "local_promotion_required" },
    };
  }

  const local = compactBaselinePromotionResult(localRaw);
  if (localRaw.promoted) report.baseline_advancement.local_promoted += 1;
  else if (localRaw.already_current) report.baseline_advancement.local_already_current += 1;
  else if (localRaw.reason === "approved_snapshot_files_missing") {
    report.baseline_advancement.local_failed += 1;
  } else {
    report.baseline_advancement.local_skipped += 1;
  }

  if (!localRaw.promoted && !localRaw.already_current) {
    return {
      local,
      r2: { promoted: false, reason: "whole_page_local_baseline_not_advanced" },
    };
  }

  let capture = localRaw.capture;
  if (!capture) {
    try {
      capture = captureFromVisualReviewCandidate(candidate, archiveRoot);
    } catch (error) {
      report.baseline_advancement.r2_failed += r2SnapshotSync ? 1 : 0;
      return {
        local,
        r2: {
          promoted: false,
          reason: "capture_reconstruction_failed",
          error: errorMessage(error),
        },
      };
    }
  }

  try {
    const r2Raw = await promoteApprovedVisualBaselineR2({
      candidate,
      source,
      capture,
      supabase,
      approved: true,
      now,
      config: {
        enabled: r2SnapshotSync,
        bucket: r2Bucket,
        endpoint: r2Endpoint,
        accessKeyId: r2AccessKeyId,
        secretAccessKey: r2SecretAccessKey,
      },
    });
    const r2 = compactBaselinePromotionResult(r2Raw);
    if (r2Raw.promoted) report.baseline_advancement.r2_promoted += 1;
    else if (r2Raw.already_current) report.baseline_advancement.r2_already_current += 1;
    else report.baseline_advancement.r2_skipped += 1;
    return { local, r2 };
  } catch (error) {
    report.baseline_advancement.r2_failed += 1;
    report.errors.push({
      candidate_id: candidate.id,
      source_id: source.id,
      message: `Approved R2 baseline promotion failed: ${errorMessage(error)}`,
    });
    return {
      local,
      r2: { promoted: false, reason: "r2_promotion_error", error: errorMessage(error) },
    };
  }
}

function compactBaselinePromotionResult(value) {
  return {
    promoted: Boolean(value?.promoted),
    already_current: Boolean(value?.already_current),
    reason: value?.reason || null,
    baseline_path: value?.baseline_path || null,
    missing_paths: Array.isArray(value?.missing_paths) ? value.missing_paths : undefined,
    uploaded: Number(value?.uploaded || 0),
    rotated: Number(value?.rotated || 0),
  };
}

async function markCandidateSucceededDryRun({ candidate, result, usage }) {
  const now = new Date().toISOString();
  await markCandidate(candidate.id, {
    status: "succeeded",
    ai_result: result,
    actual_usage: usage,
    completed_at: now,
    rejection_reason: "apply_false_not_published",
    updated_at: now,
  });
  return { status: "succeeded", reason: "apply_false" };
}

function geminiBatchRequestForCandidate(candidate) {
  const promptPayload = refreshVisualReviewPromptPayloadPolicy(candidate.prompt_payload || {});
  const promptText = buildVisualReviewPromptText(promptPayload);
  const parts = [{ text: promptText }];
  if (promptPayload.include_images) {
    for (const path of [
      promptPayload.previous_snapshot_ref?.local_paths?.thumb?.path,
      promptPayload.new_snapshot_ref?.local_paths?.thumb?.path,
    ]) {
      const imagePart = fileToInlineGeminiPart(path);
      if (imagePart) parts.push(imagePart);
    }
  }

  return {
    request: {
      systemInstruction: {
        parts: [
          {
            text: "You are a strict scholarship award source-change reviewer. Return JSON only. Reject all noise unless exact evidence supports an applicant-facing award fact change.",
          },
        ],
      },
      contents: [
        {
          role: "user",
          parts,
        },
      ],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 900,
        thinkingConfig: { thinkingBudget: 0 },
        responseMimeType: "application/json",
        responseSchema: visualReviewResponseSchema,
      },
    },
    metadata: {
      key: candidate.id,
      candidate_signature: candidate.candidate_signature,
      monitoring_policy_id: monitoringPolicy?.id || null,
      monitoring_policy_version: monitoringPolicy?.version || null,
      monitoring_policy_hash: monitoringPolicy?.hash || null,
    },
  };
}

async function createGeminiBatchJob({ model, requests, displayName, mode, beforeCreate }) {
  if (mode === "jsonl_file") {
    const fileName = await uploadGeminiJsonlRequests({ requests, displayName });
    await beforeCreate();
    return fetchGeminiJson(geminiBatchUrl(model), {
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

  await beforeCreate();
  return fetchGeminiJson(geminiBatchUrl(model), {
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
  const path = join(jsonlDir, `${displayName}.jsonl`);
  const body = requests.map((request) => JSON.stringify(geminiBatchJsonlRequest(request))).join("\n") + "\n";
  writeFileSync(path, body, "utf8");
  const bytes = Buffer.from(body, "utf8");
  const startResponse = await fetch(
    `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${encodeURIComponent(geminiApiKey)}`,
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
      signal: AbortSignal.timeout(requestTimeoutMs),
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
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  const uploadBody = await uploadResponse.text().catch(() => "");
  if (!uploadResponse.ok) {
    throw new Error(`Gemini file upload finalize failed: ${uploadResponse.status} ${uploadBody}`);
  }
  const parsed = parseJsonObject(uploadBody) || {};
  const fileName = parsed.file?.name || parsed.name;
  if (!fileName) throw new Error(`Gemini file upload did not return a file name: ${uploadBody.slice(0, 500)}`);
  return fileName;
}

async function geminiBatchResponseMap(job, expectedKeys = []) {
  const responses = [...extractGeminiBatchInlineResponses(job)];
  for (const fileName of geminiBatchOutputFileNames(job)) {
    const text = await downloadGeminiFileText(fileName);
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      responses.push(parseJsonObject(line) || { awardping_unparseable_batch_line: true });
    }
  }

  const mapped = geminiBatchInlineResponseMap(responses);
  const mappingComplete = geminiBatchExactMappingComplete(responses, mapped, expectedKeys);
  if (mapped.missingKeys > 0) {
    report.errors.push({
      stage: "visual_batch_response_mapping",
      message: `${mapped.missingKeys} Gemini Batch response item(s) had no candidate key and could not be reconciled.`,
    });
  }
  for (const duplicateKey of mapped.duplicateKeys) {
    mapped.responses.delete(duplicateKey);
    report.errors.push({
      candidate_id: duplicateKey,
      stage: "visual_batch_response_mapping",
      message: `Gemini Batch returned duplicate response key ${duplicateKey}; the candidate was failed closed instead of choosing an ambiguous response.`,
    });
  }
  return {
    responses: mapped.responses,
    accounting: geminiBatchUsageAccounting(responses, { mappingComplete }),
  };
}

async function downloadGeminiFileText(fileName) {
  const urls = [
    `https://generativelanguage.googleapis.com/v1beta/${fileName}:download?alt=media&key=${encodeURIComponent(geminiApiKey)}`,
    `https://generativelanguage.googleapis.com/v1beta/${fileName}?alt=media&key=${encodeURIComponent(geminiApiKey)}`,
  ];
  let lastError = null;
  for (const url of urls) {
    const response = await fetch(url, { method: "GET", signal: AbortSignal.timeout(requestTimeoutMs) });
    const text = await response.text().catch(() => "");
    if (response.ok) return text;
    lastError = `${response.status} ${text}`;
  }
  throw new Error(`Gemini file download failed for ${fileName}: ${lastError || "unknown error"}`);
}

async function fetchGeminiJson(url, { method, body, kind }) {
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        method,
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": geminiApiKey,
        },
        body,
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      const responseBody = await response.text().catch(() => "");
      if (response.ok) return JSON.parse(responseBody);

      const message = geminiHttpErrorMessage(response.status, responseBody);
      const createDisposition = visualReviewBatchCreateFailureDisposition({
        kind,
        httpStatus: response.status,
      });
      if (createDisposition.action === "fail_closed") {
        throw possibleExternalBatchCreatedError(message, {
          kind,
          httpStatus: response.status,
        });
      }
      if (attempt < maxAttempts && isRetryableGeminiFailure(response.status, responseBody)) {
        const waitMs = attempt * 1500;
        console.log(`GEMINI_RETRY kind=${kind} attempt=${attempt}/${maxAttempts} wait_ms=${waitMs} message=${truncate(message, 240)}`);
        await sleep(waitMs);
        continue;
      }
      const definiteError = new Error(message);
      definiteError.safeToReleaseBatchClaim = true;
      definiteError.geminiHttpStatus = Number(response.status);
      definiteError.geminiRequestKind = cleanText(kind);
      throw definiteError;
    } catch (error) {
      if (error?.possibleExternalBatchCreated) throw error;
      if (
        /^batch_create(?:_|$)/.test(cleanText(kind)) &&
        !error?.safeToReleaseBatchClaim
      ) {
        throw possibleExternalBatchCreatedError(errorMessage(error), { kind });
      }
      if (attempt < maxAttempts && isRetryableNetworkFailure(error)) {
        const waitMs = attempt * 1500;
        console.log(`GEMINI_RETRY kind=${kind} attempt=${attempt}/${maxAttempts} wait_ms=${waitMs} message=${truncate(errorMessage(error), 240)}`);
        await sleep(waitMs);
        continue;
      }
      throw error;
    }
  }
  throw new Error(`Gemini request failed after ${maxAttempts} attempts.`);
}

function possibleExternalBatchCreatedError(message, metadata = {}) {
  const error = new Error(
    `Gemini Batch create outcome is ambiguous; manual recovery is required: ${message}`,
  );
  error.possibleExternalBatchCreated = true;
  error.batchCreateMetadata = metadata;
  return error;
}

async function loadSourcesById(ids) {
  const uniqueIds = unique(ids).filter(Boolean);
  const map = new Map();
  for (const idChunk of chunks(uniqueIds, 500)) {
    const { data, error } = await supabase
      .from("shared_award_sources")
      .select("id,shared_award_id,url,title,page_type,source,reason,page_metadata,page_metadata_generated_at,page_metadata_model,submitted_by_user_id,admin_review_status,shared_awards(name)")
      .in("id", idChunk);
    if (error) throw new Error(`Load shared award sources failed: ${error.message}`);
    for (const row of data || []) map.set(row.id, row);
  }
  return map;
}

async function loadInitialOfficialDocumentSourceAcquisition(acquisitionId) {
  const id = cleanNullable(acquisitionId);
  if (!id) throw new Error("Initial-document candidate is missing its source acquisition id.");
  const { data, error } = await supabase
    .from("shared_award_source_acquisitions")
    .select(
      "id,shared_award_source_id,acquisition_kind,notification_mode,origin_source_page_request_id,origin_worker_run_id,parent_shared_award_source_id,onboarding_batch_id,review_seal,metadata,acquired_at,created_at",
    )
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`Load initial-document source acquisition failed: ${error.message}`);
  if (!data?.id) throw new Error("Initial-document source acquisition no longer exists.");
  return data;
}

async function findPriorNonterminalPublication(candidate) {
  const { data, error } = await supabase
    .from("shared_award_visual_review_candidates")
    .select("id,status,created_at,rejection_reason,worker_metadata,new_snapshot_ref,new_file_hash,new_image_hash,prompt_payload")
    .eq("shared_award_source_id", candidate.shared_award_source_id)
    .in("status", ["pending", "submitted", "processing", "succeeded", "failed"])
    .neq("id", candidate.id)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(1000);
  if (error) {
    throw new Error(`Check prior visual publication retries failed: ${error.message}`);
  }
  const eligible = (data || []).filter((earlierCandidate) =>
    compareVisualCandidateOrder(earlierCandidate, candidate) < 0 && (
      earlierCandidate.status !== "failed" || (
        recoverMissingBatchResponses &&
        earlierCandidate.rejection_reason === "missing_batch_response"
      )
    ),
  );
  return findBlockingPriorVisualPublication(candidate, eligible);
}

function preSubmissionRejectReason(candidate, source) {
  if (!source) return "missing_source";
  if (source.admin_review_status && source.admin_review_status !== "open") return `source_not_open_${source.admin_review_status}`;
  const quality = sourceQualityDecision(source, { purpose: "monitoring" });
  const applicantSourceEscape = visualReviewConditionalSourceApplicantEscape({
    source,
    candidate,
    quality,
  });
  if (!quality.allowed && !applicantSourceEscape.allowed) {
    return `source_quality_${quality.reason}`;
  }
  const sectionRejectReason = expandableSectionCandidateRejectReason(candidate);
  if (sectionRejectReason) return sectionRejectReason;
  if (
    !candidate.prompt_payload ||
    typeof candidate.prompt_payload !== "object" ||
    Array.isArray(candidate.prompt_payload)
  ) return "missing_prompt_payload";
  return null;
}

async function markBatchRowsProcessing(batchName) {
  const { error } = await supabase
    .from("shared_award_visual_review_candidates")
    .update({
      status: "processing",
      updated_at: new Date().toISOString(),
    })
    .eq("gemini_batch_name", batchName)
    .eq("status", "submitted");
  if (error) throw new Error(`Mark visual batch processing failed: ${error.message}`);
}

async function markBatchRowsFailed(batchName, message) {
  const { error } = await supabase
    .from("shared_award_visual_review_candidates")
    .update({
      status: "failed",
      rejection_reason: message,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("gemini_batch_name", batchName)
    .in("status", ["submitted", "processing"]);
  if (error) throw new Error(`Mark visual batch failed failed: ${error.message}`);
}

async function markCandidate(id, patch) {
  const { error } = await supabase
    .from("shared_award_visual_review_candidates")
    .update(patch)
    .eq("id", id);
  if (error) throw new Error(`Update visual review candidate ${id} failed: ${error.message}`);
}

async function markPublicationCandidate(candidate, publicationClaimToken, patch) {
  const token = cleanText(publicationClaimToken);
  if (!token) {
    throw new Error(`Publication claim token is required for candidate ${candidate?.id || "unknown"}.`);
  }
  const guardedPatch = publicationFinalizationPatch(candidate, token, patch);
  const { data, error } = await supabase
    .from("shared_award_visual_review_candidates")
    .update(guardedPatch)
    .eq("id", candidate.id)
    .eq("status", "succeeded")
    .eq("publication_claim_token", token)
    .select("id")
    .maybeSingle();
  if (error) {
    throw new Error(`Finalize visual publication claim ${candidate.id} failed: ${error.message}`);
  }
  if (!data) {
    throw new Error(`Visual publication claim ${candidate.id} was lost before finalization.`);
  }
  return data;
}

function publicationFinalizationPatch(candidate, publicationClaimToken, patch) {
  const completedAt = patch?.updated_at || new Date().toISOString();
  return {
    ...patch,
    publication_claim_token: null,
    publication_claimed_at: null,
    worker_metadata: workerMetadataForCandidate(candidate, {
      ...objectValue(patch?.worker_metadata),
      publication_claim_token: null,
      publication_claim_last_token: publicationClaimToken,
      publication_claim_completed_at: completedAt,
      publication_claim_outcome: patch?.status || null,
    }),
  };
}

async function refreshStatusCounts() {
  const statuses = ["pending", "submitted", "processing", "succeeded", "rejected", "failed", "published", "superseded"];
  report.status_counts = {};
  for (const status of statuses) {
    const { count, error } = await supabase
      .from("shared_award_visual_review_candidates")
      .select("id", { count: "exact", head: true })
      .eq("status", status);
    if (error) throw new Error(`Count visual review candidates status=${status} failed: ${error.message}`);
    report.status_counts[status] = count || 0;
  }
}

async function settleVisualBatchSpend(
  batchName,
  { terminalState, accounting = null } = {},
) {
  const { data, error } = await supabase
    .from("shared_award_visual_review_candidates")
    .select("model,actual_usage,worker_metadata")
    .eq("gemini_batch_name", batchName);
  if (error) throw new Error(`Load visual spend reservation for ${batchName} failed: ${error.message}`);
  const rows = data || [];
  const reservationIds = unique(rows.map((row) => cleanNullable(objectValue(row.worker_metadata).gemini_spend_reservation_id)));
  if (!reservationIds.length) return null; // Historical Batch created before account-wide reservations.
  if (reservationIds.length !== 1) {
    throw new Error(`Gemini Batch ${batchName} is bound to ${reservationIds.length} spend reservations.`);
  }
  const terminalAccounting = accounting || geminiBatchUsageAccounting([]);
  const usage = terminalAccounting.usage;
  const modelName = cleanNullable(rows.find((row) => row.model)?.model) || geminiWorkerModel();
  let reservation = await loadGeminiSpendReservation({
    supabase,
    reservationId: reservationIds[0],
  });
  if (reservation.status === "settled") {
    return { settled: true, already_settled: true, reservation_id: reservation.id };
  }
  const attemptTokens = unique(rows.map((row) =>
    cleanNullable(objectValue(row.worker_metadata).gemini_spend_attempt_token)
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
    model: modelName,
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
      terminal_state: terminalState || null,
      provider_batch_name: batchName,
    },
    spentSource: settlement.spentSource,
  });
  report.spend_reservations_settled += settled ? 1 : 0;
  return settled;
}

function paidReviewWorkFingerprint(kind, modelName, identities) {
  const digest = crypto.createHash("sha256")
    .update(JSON.stringify({
      kind,
      model: modelName,
      identities: [...new Set((identities || []).map((value) => String(value || "").trim()).filter(Boolean))].sort(),
    }))
    .digest("hex");
  return `${kind}:${digest}`;
}

function geminiBatchUrl(model) {
  const modelName = String(model || "").replace(/^models\//, "");
  return `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:batchGenerateContent`;
}

function geminiBatchJobName(data) {
  return [
    data?.name,
    data?.metadata?.name,
    data?.response?.name,
    data?.response?.metadata?.name,
  ].find((value) => typeof value === "string" && value.startsWith("batches/")) || null;
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

function geminiBatchErrorMessage(data) {
  return geminiInlineErrorMessage(data?.error || data?.response?.error || data?.metadata?.error);
}

function geminiInlineErrorMessage(error) {
  if (!error) return "No error details returned.";
  if (typeof error === "string") return error;
  return cleanText(error.message || error.status || JSON.stringify(error));
}

function extractGeminiText(data) {
  return (data?.candidates || [])
    .flatMap((candidate) => candidate?.content?.parts || [])
    .map((part) => part?.text || "")
    .join("\n")
    .trim();
}

function extractUsageMetadata(responseItem) {
  return extractGeminiUsageMetadata(responseItem);
}

function normalizeGeminiUsage(metadata) {
  return {
    prompt_tokens: nonNegativeInt(metadata?.promptTokenCount ?? metadata?.prompt_tokens, 0),
    candidates_tokens: nonNegativeInt(metadata?.candidatesTokenCount ?? metadata?.candidates_tokens, 0),
    total_tokens: nonNegativeInt(metadata?.totalTokenCount ?? metadata?.total_tokens, 0),
    thoughts_tokens: nonNegativeInt(metadata?.thoughtsTokenCount ?? metadata?.thoughts_tokens, 0),
    cached_content_tokens: nonNegativeInt(metadata?.cachedContentTokenCount ?? metadata?.cached_content_tokens, 0),
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

function addUsage(target, usage) {
  target.prompt_tokens += usage.prompt_tokens || 0;
  target.candidates_tokens += usage.candidates_tokens || 0;
  target.total_tokens += usage.total_tokens || 0;
  target.thoughts_tokens += usage.thoughts_tokens || 0;
  target.cached_content_tokens += usage.cached_content_tokens || 0;
  return target;
}

function geminiBatchPricePerMillion(model) {
  const name = String(model || "").toLowerCase();
  if (name.includes("2.5-flash-lite")) return { input: 0.05, output: 0.2 };
  if (name.includes("2.5-flash")) return { input: 0.15, output: 1.25 };
  if (name.includes("3.1-flash-lite")) return { input: 0.125, output: 0.75 };
  if (name.includes("3-flash") || name.includes("3.1-flash")) return { input: 0.25, output: 1.5 };
  return { input: 0.5, output: 2.5 };
}

function geminiHttpErrorMessage(httpStatus, body) {
  const parsed = parseJsonObject(body) || {};
  const providerMessage = cleanNullable(objectValue(parsed.error).message);
  return `Gemini HTTP ${httpStatus}: ${truncate(providerMessage || body || "Gemini API request failed.", 800)}`;
}

function isRetryableGeminiFailure(httpStatus, body) {
  if ([408, 409, 429, 500, 502, 503, 504].includes(Number(httpStatus))) return true;
  return /(temporarily unavailable|try again|rate|quota|timeout|overloaded|high demand)/i.test(String(body || ""));
}

function isRetryableNetworkFailure(error) {
  return /(fetch failed|network|timeout|econnreset|etimedout|socket|temporarily unavailable)/i.test(errorMessage(error));
}

function groupBy(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

function chunks(items, size) {
  const result = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
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

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function nonNegativeInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function cleanNullable(value) {
  const clean = cleanText(value);
  return clean || null;
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function workerMetadataForCandidate(candidate, patch = {}) {
  return {
    ...objectValue(candidate?.worker_metadata),
    ...patch,
    monitoring_policy: monitoringPolicy,
    monitoring_policy_bundle: monitoringPolicyBundle,
  };
}

async function requeueInitialDocumentCandidateForCurrentPolicy({
  candidate,
  policyDecision,
  now,
  publicationClaimToken,
}) {
  const rebuilt = rebuildInitialOfficialDocumentCandidateForCurrentPolicy(candidate);
  const existing = await findCandidateWithSignature(rebuilt.candidate_signature, candidate.id);
  if (existing) {
    await markPublicationCandidate(candidate, publicationClaimToken, {
      status: "superseded",
      ai_result: {
        ...objectValue(candidate.ai_result),
        stale_policy_guard: policyDecision,
      },
      actual_usage: {},
      rejection_reason: `current_policy_candidate_exists:${existing.id}`,
      worker_metadata: workerMetadataForCandidate(candidate, {
        policy_guard: policyDecision,
        superseded_by_candidate_id: existing.id,
        deterministic_initial_document_policy_refresh: true,
        creates_api_charge: false,
      }),
      completed_at: now,
      updated_at: now,
    });
    return { status: "superseded", reason: "current_policy_candidate_exists" };
  }

  const { data, error } = await supabase.rpc(
    "refresh_shared_award_initial_document_candidate_policy",
    {
      p_candidate_id: candidate.id,
      p_publication_claim_token: publicationClaimToken,
      p_candidate_signature: rebuilt.candidate_signature,
      p_monitoring_policy: rebuilt.monitoring_policy,
      p_monitoring_policy_bundle: rebuilt.prompt_payload.monitoring_policy_bundle,
      p_policy_guard: policyDecision,
    },
  );
  if (error) {
    if (error.code === "23505") {
      const racedConflict = await findCandidateWithSignature(
        rebuilt.candidate_signature,
        candidate.id,
      );
      if (racedConflict) {
        await markPublicationCandidate(candidate, publicationClaimToken, {
          status: "superseded",
          ai_result: {
            ...objectValue(candidate.ai_result),
            stale_policy_guard: policyDecision,
          },
          actual_usage: {},
          rejection_reason: `current_policy_candidate_exists:${racedConflict.id}`,
          worker_metadata: workerMetadataForCandidate(candidate, {
            policy_guard: policyDecision,
            superseded_by_candidate_id: racedConflict.id,
            deterministic_initial_document_policy_refresh: true,
            creates_api_charge: false,
          }),
          completed_at: now,
          updated_at: now,
        });
        return { status: "superseded", reason: "current_policy_candidate_exists" };
      }
    }
    throw new Error(`Refresh initial-document candidate policy failed: ${error.message}`);
  }
  const refreshed = Array.isArray(data) ? data[0] || null : data || null;
  if (!refreshed?.candidate_id || refreshed.candidate_signature !== rebuilt.candidate_signature) {
    throw new Error(
      `Initial-document publication claim ${candidate.id} was not refreshed atomically.`,
    );
  }
  return { status: "requeued", reason: policyDecision.reason };
}

async function requeueCandidateForCurrentPolicy({
  candidate,
  policyDecision,
  usage,
  now,
  publicationClaimToken,
}) {
  const patch = publicationFinalizationPatch(candidate, publicationClaimToken, {
    status: "pending",
    gemini_batch_name: null,
    model: null,
    submitted_at: null,
    completed_at: null,
    published_at: null,
    ai_result: {
      stale_policy_guard: policyDecision,
    },
    actual_usage: usage,
    rejection_reason: null,
    worker_metadata: workerMetadataForCandidate(candidate, {
      requeued_at: now,
      requeued_from_batch: candidate.gemini_batch_name || null,
      requeue_reason: policyDecision.reason,
      prompt_rebuilt_from_current_policy: true,
    }),
    updated_at: now,
  });
  const { data, error } = await supabase
    .from("shared_award_visual_review_candidates")
    .update(patch)
    .eq("id", candidate.id)
    .eq("status", "succeeded")
    .eq("publication_claim_token", publicationClaimToken)
    .select("id")
    .maybeSingle();
  if (error) {
    throw new Error(`Requeue visual candidate for current policy failed: ${error.message}`);
  }
  if (!data) {
    throw new Error(`Visual publication claim ${candidate.id} was lost before policy requeue.`);
  }
  return { status: "requeued", reason: policyDecision.reason };
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
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

function truncate(value, maxLength) {
  const text = String(value || "");
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || "Unknown error");
}

function initialDocumentCandidateRestoreFailureSolution(restore) {
  const reason = cleanText(restore?.reason).toLowerCase();
  if (/target_conflict|direct_path_conflict|directory_unsafe|artifact_path_unsafe/.test(reason)) {
    return "Keep the candidate unpublished and preserve the conflicting local path for audit. Verify the configured archive root and remove or relocate bytes only after confirming they are not the immutable candidate artifact; the retry will restore the exact candidate-bound path without overwriting it.";
  }
  if (/hash|manifest|source_mismatch|award_mismatch|key_|generation_ambiguous/.test(reason)) {
    return "Quarantine the pointer/object mismatch, preserve both local and R2 bytes, and verify the source ID, immutable object keys, timestamp, SHA-256 values, and candidate manifest. Do not relink the candidate or overwrite either copy; recapture through the normal scan only if the exact generation cannot be proven.";
  }
  if (/snapshot_record_missing|snapshot_pointer_load_failed|exact_r2_generation_unavailable/.test(reason)) {
    return "Verify that R2 snapshot sync retained this candidate's exact capture as the latest or previous source generation. Repair or backfill only that immutable pointer when the object hashes prove identity; otherwise leave the event quarantined and recapture through the normal scan.";
  }
  if (/download|credentials|invalid_candidate_restore_input/.test(reason)) {
    return "Verify the worker's R2 bucket, endpoint, credentials, read permission, and snapshot pointer query, then retry the same candidate. The recovery is hash-verified and creates no new review charge.";
  }
  return "Inspect the candidate artifact manifest, exact R2 generation, local archive path, and restore detail in this report. Repair the failed dependency and retry the same candidate without changing candidate identity or substituting another document.";
}

function visualEventEvidenceFailureSolution(value) {
  const message = cleanText(value).toLowerCase();
  if (/hash mismatch|identity mismatch|conflicts with this publication/.test(message)) {
    return "Quarantine this candidate, preserve its files for audit, and recapture the source through the normal 6 PM review path. Never relink it to a different screenshot or overwrite immutable evidence.";
  }
  if (/missing|no .*snapshot reference|not retained/.test(message)) {
    return "Keep the update unpublished, verify the candidate archive paths, and recapture the source through normal review if the exact candidate artifacts cannot be restored.";
  }
  if (/r2|permanent visual evidence verification|bucket|credentials|headobject|putobject/.test(message)) {
    return "Verify the worker R2 bucket, endpoint, credentials, and object write/read permissions, then retry the same candidate; content-addressed uploads are safe to repeat.";
  }
  if (/publish_shared_award_visual_event|atomic visual event/.test(message)) {
    return "Verify the immutable-evidence migration is applied, inspect the candidate/event identity mismatch, and retry without editing an existing evidence row.";
  }
  return "Inspect the candidate's immutable full images, metadata, geometry binding, and R2 verification result; repair the failed dependency and retry the same candidate without substituting source-pointer images.";
}

function printHelp() {
  console.log(`Process Gemini Batch visual-review candidates.

Options:
  --limit=250
  --max-requests-per-batch=250
  --inline-threshold=100
  --poll=true
  --submit=true
  --poll-only=false
  --submit-only=false
  --apply=true
  --max-failure-retries=3
  --stale-claim-minutes=15
  --publication-claim-stale-minutes=30
  --archive-dir=D:\\AwardPingVisualSnapshots
  --r2-snapshot-sync=false
  --env=.env.worker.local
`);
}

function roundUsd(value) {
  return Math.round(Math.max(0, Number(value) || 0) * 1_000_000) / 1_000_000;
}

function timestampForPath(value) {
  return String(value || new Date().toISOString()).replace(/[:.]/g, "-");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeReport() {
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
