import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, SourcePageRequestStatus } from "@/lib/database.types";

type AdminClient = SupabaseClient<Database>;
type LocalWorkerRun = Database["public"]["Tables"]["local_worker_runs"]["Row"];

export const sourceIntakeStatuses: SourcePageRequestStatus[] = [
  "pending",
  "queued",
  "validating",
  "capturing",
  "ai_review_pending",
  "ai_review_submitted",
  "ai_review_succeeded",
  "matching",
  "needs_manual_review",
  "added",
  "rejected",
  "failed",
];

export type SourceIntakeStageProgress = {
  eligible: number | null;
  loaded: number;
  selected: number | null;
  attempted: number;
  completed: number;
  deferred: number;
  windowed: boolean;
};

export type SourceIntakeStageCounts = Record<
  "poll" | "capture" | "submit" | "reconcile",
  SourceIntakeStageProgress
>;

export type SourceIntakeSummary = {
  configured: boolean;
  warning: string | null;
  statusCounts: Record<SourcePageRequestStatus, number>;
  pending: number;
  inProgress: number;
  added: number;
  rejected: number;
  needsManualReview: number;
  failed: number;
  latestWorker: {
    id: string | null;
    status: string;
    startedAt: string | null;
    finishedAt: string | null;
    requestsLoaded: number;
    captured: number;
    deterministicRejected: number;
    aiReviewPending: number;
    aiReviewSubmitted: number;
    aiReviewSucceeded: number;
    needsManualReview: number;
    matchedExistingAwards: number;
    createdAwards: number;
    createdOrUpdatedSources: number;
    factCandidatesInserted: number;
    awardsQueuedForReconciliation: number;
    failed: number;
    captureClaimConflicts: number;
    reconcileClaimConflicts: number;
    submissionClaimConflicts: number;
    submissionClaimsLostAfterBatchCreate: number;
    manualRecoveryRequired: number;
    staleCaptureRequestsRequeued: number;
    staleReconcileClaimsRequeued: number;
    staleMatchingRequestsFailedClosed: number;
    stageCounts: SourceIntakeStageCounts | null;
    billingBlocked: boolean;
    blockingReason: string | null;
  } | null;
  latestRequests: Array<{
    id: string;
    awardName: string;
    homepageUrl: string;
    status: string;
    statusReason: string | null;
    error: string | null;
    createdAt: string;
    updatedAt: string;
  }>;
};

export async function loadSourceIntakeSummary(
  admin: AdminClient,
  workerRuns: LocalWorkerRun[] = [],
): Promise<{ summary: SourceIntakeSummary; warnings: string[]; loadErrors: string[] }> {
  const rawAdmin = admin as unknown as SupabaseClient;
  const loadErrors: string[] = [];
  const warnings: string[] = [];
  const countResults = await Promise.all(
    sourceIntakeStatuses.map(async (status) => {
      const result = await rawAdmin
        .from("source_page_requests")
        .select("id", { count: "exact", head: true })
        .eq("status", status);
      return { status, count: result.count || 0, error: result.error };
    }),
  );
  const missingError = countResults.find((result) => result.error && isMissingRelationError(result.error.message));
  if (missingError) {
    const warning = "Source intake queue is not configured yet.";
    warnings.push(warning);
    return { summary: unavailableSummary(warning, workerRuns), warnings, loadErrors: [] };
  }
  const rows: Array<{ status: SourcePageRequestStatus; count: number }> = [];
  for (const result of countResults) {
    if (result.error?.message) loadErrors.push(result.error.message);
    rows.push({ status: result.status, count: result.count });
  }

  const latestResult = await rawAdmin
    .from("source_page_requests")
    .select("id,award_name,homepage_url,status,status_reason,error,created_at,updated_at")
    .order("updated_at", { ascending: false })
    .limit(12);
  if (latestResult.error?.message) {
    if (isMissingRelationError(latestResult.error.message)) {
      const warning = "Source intake queue is not configured yet.";
      warnings.push(warning);
      return { summary: unavailableSummary(warning, workerRuns), warnings, loadErrors };
    }
    loadErrors.push(latestResult.error.message);
  }

  return {
    summary: summarizeSourceIntake(
      rows,
      workerRuns,
      null,
      (latestResult.data || []) as Array<Record<string, unknown>>,
    ),
    warnings,
    loadErrors,
  };
}

export function summarizeSourceIntake(
  rows: Array<Record<string, unknown>>,
  workerRuns: LocalWorkerRun[] = [],
  warning: string | null = null,
  latestRequests: Array<Record<string, unknown>> = [],
): SourceIntakeSummary {
  if (warning) return unavailableSummary(warning, workerRuns);
  const statusCounts = emptyStatusCounts();
  for (const row of rows) {
    const status = cleanSourceIntakeStatus(row.status);
    if (!status) continue;
    statusCounts[status] += numberValue(row.count || 1);
  }
  return {
    configured: true,
    warning: null,
    statusCounts,
    pending: statusCounts.pending + statusCounts.queued,
    inProgress:
      statusCounts.validating +
      statusCounts.capturing +
      statusCounts.ai_review_pending +
      statusCounts.ai_review_submitted +
      statusCounts.ai_review_succeeded +
      statusCounts.matching,
    added: statusCounts.added,
    rejected: statusCounts.rejected,
    needsManualReview: statusCounts.needs_manual_review,
    failed: statusCounts.failed,
    latestWorker: latestSourceIntakeWorker(workerRuns),
    latestRequests: latestRequests.map((row) => ({
      id: cleanText(row.id),
      awardName: cleanText(row.award_name),
      homepageUrl: cleanText(row.homepage_url),
      status: cleanText(row.status),
      statusReason: cleanText(row.status_reason) || null,
      error: cleanText(row.error) || null,
      createdAt: cleanText(row.created_at),
      updatedAt: cleanText(row.updated_at),
    })),
  };
}

export function latestSourceIntakeWorker(workerRuns: LocalWorkerRun[]): SourceIntakeSummary["latestWorker"] {
  const run = (workerRuns || []).find((candidate) => {
    const metadata = objectValue(candidate.metadata);
    if (candidate.worker_name.includes("source-intake")) return true;
    if (metadata.kind === "source_intake") return true;
    if (metadata.kind === "maintenance") {
      return maintenancePhases(metadata).some((phase) => cleanText(phase.name) === "source-intake");
    }
    return false;
  });
  if (!run) return null;
  const metadata = objectValue(run.metadata);
  const counters = objectValue(metadata.counters);
  const counts = objectValue(metadata.counts);
  const stageCounts = objectValue(metadata.stage_counts);
  return {
    id: run.id,
    status: cleanText(metadata.status) || run.status,
    startedAt: cleanText(run.started_at || metadata.started_at) || null,
    finishedAt: cleanText(run.finished_at || metadata.finished_at) || null,
    requestsLoaded: numberFromAny(metadata.requests_loaded, counters.requests_loaded, counts.requests_loaded, run.checked_count),
    captured: numberFromAny(metadata.captured, counters.captured, counts.captured),
    deterministicRejected: numberFromAny(metadata.deterministic_rejected, counters.deterministic_rejected, counts.deterministic_rejected),
    aiReviewPending: numberFromAny(metadata.ai_review_pending, counters.ai_review_pending, counts.ai_review_pending, run.initial_count),
    aiReviewSubmitted: numberFromAny(metadata.ai_review_submitted, counters.ai_review_submitted, counts.ai_review_submitted),
    aiReviewSucceeded: numberFromAny(metadata.ai_review_succeeded, counters.ai_review_succeeded, counts.ai_review_succeeded),
    needsManualReview: numberFromAny(metadata.needs_manual_review, counters.needs_manual_review, counts.needs_manual_review, run.unchanged_count),
    matchedExistingAwards: numberFromAny(metadata.matched_existing_awards, counters.matched_existing_awards, counts.matched_existing_awards),
    createdAwards: numberFromAny(metadata.created_awards, counters.created_awards, counts.created_awards, run.discovered_count),
    createdOrUpdatedSources: numberFromAny(metadata.created_or_updated_sources, counters.created_or_updated_sources, counts.created_or_updated_sources, run.changed_count),
    factCandidatesInserted: numberFromAny(metadata.fact_candidates_inserted, counters.fact_candidates_inserted, counts.fact_candidates_inserted),
    awardsQueuedForReconciliation: numberFromAny(metadata.awards_queued_for_reconciliation, counters.awards_queued_for_reconciliation, counts.awards_queued_for_reconciliation),
    failed: numberFromAny(metadata.failed, counters.failed, counts.failed, run.failed_count),
    captureClaimConflicts: numberFromAny(metadata.capture_claim_conflicts, counters.capture_claim_conflicts),
    reconcileClaimConflicts: numberFromAny(metadata.reconcile_claim_conflicts, counters.reconcile_claim_conflicts),
    submissionClaimConflicts: numberFromAny(metadata.submission_claim_conflicts, counters.submission_claim_conflicts),
    submissionClaimsLostAfterBatchCreate: numberFromAny(
      metadata.submission_claims_lost_after_batch_create,
      counters.submission_claims_lost_after_batch_create,
    ),
    manualRecoveryRequired: numberFromAny(metadata.manual_recovery_required, counters.manual_recovery_required),
    staleCaptureRequestsRequeued: numberFromAny(
      metadata.stale_capture_requests_requeued,
      counters.stale_capture_requests_requeued,
    ),
    staleReconcileClaimsRequeued: numberFromAny(
      metadata.stale_reconcile_claims_requeued,
      counters.stale_reconcile_claims_requeued,
    ),
    staleMatchingRequestsFailedClosed: numberFromAny(
      metadata.stale_matching_requests_failed_closed,
      counters.stale_matching_requests_failed_closed,
    ),
    stageCounts: Object.keys(stageCounts).length
      ? {
          poll: sourceIntakeStageProgress(stageCounts.poll),
          capture: sourceIntakeStageProgress(stageCounts.capture),
          submit: sourceIntakeStageProgress(stageCounts.submit),
          reconcile: sourceIntakeStageProgress(stageCounts.reconcile),
        }
      : null,
    billingBlocked: Boolean(metadata.billing_blocked),
    blockingReason: cleanText(metadata.blocking_reason || metadata.stop_reason || run.error) || null,
  };
}

function unavailableSummary(warning: string, workerRuns: LocalWorkerRun[]): SourceIntakeSummary {
  return {
    configured: false,
    warning,
    statusCounts: emptyStatusCounts(),
    pending: 0,
    inProgress: 0,
    added: 0,
    rejected: 0,
    needsManualReview: 0,
    failed: 0,
    latestWorker: latestSourceIntakeWorker(workerRuns),
    latestRequests: [],
  };
}

function emptyStatusCounts() {
  return Object.fromEntries(sourceIntakeStatuses.map((status) => [status, 0])) as Record<SourcePageRequestStatus, number>;
}

function cleanSourceIntakeStatus(value: unknown): SourcePageRequestStatus | null {
  const status = cleanText(value);
  return sourceIntakeStatuses.includes(status as SourcePageRequestStatus) ? (status as SourcePageRequestStatus) : null;
}

function maintenancePhases(metadata: Record<string, unknown>) {
  return (Array.isArray(metadata.phases) ? metadata.phases : []).map((phase) => objectValue(phase));
}

function sourceIntakeStageProgress(value: unknown): SourceIntakeStageProgress {
  const stage = objectValue(value);
  return {
    eligible: nullableNumber(stage.eligible),
    loaded: numberFromAny(stage.loaded),
    selected: nullableNumber(stage.selected),
    attempted: numberFromAny(stage.attempted),
    completed: numberFromAny(stage.completed),
    deferred: numberFromAny(stage.deferred),
    windowed: Boolean(stage.windowed),
  };
}

function numberFromAny(...values: unknown[]) {
  for (const value of values) {
    const number = nullableNumber(value);
    if (number !== null) return number;
  }
  return 0;
}

function numberValue(value: unknown) {
  return nullableNumber(value) || 0;
}

function nullableNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function isMissingRelationError(message: string) {
  return /schema cache|does not exist|could not find the table|could not find.*column|column .* does not exist|42P01|42703|PGRST/i.test(
    message,
  );
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function cleanText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}
