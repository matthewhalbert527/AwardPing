import { describe, expect, it, vi } from "vitest";
import type { Database } from "@/lib/database.types";

vi.mock("server-only", () => ({}));

import { summarizeSourceIntake } from "@/lib/admin-source-intake";

type WorkerRun = Database["public"]["Tables"]["local_worker_runs"]["Row"];

function workerRun(metadata: Record<string, unknown>): WorkerRun {
  return {
    id: "run-intake",
    worker_name: "source-intake-worker",
    status: "failed",
    ai_provider: "gemini",
    checked_count: 6,
    changed_count: 2,
    unchanged_count: 1,
    initial_count: 3,
    discovered_count: 1,
    failed_count: 1,
    error: "Gemini credits are depleted",
    metadata: metadata as WorkerRun["metadata"],
    started_at: "2026-07-09T00:00:00.000Z",
    finished_at: "2026-07-09T00:10:00.000Z",
  };
}

describe("admin source intake summary", () => {
  it("counts intake statuses and latest worker metadata", () => {
    const summary = summarizeSourceIntake(
      [
        { status: "pending", count: 2 },
        { status: "capturing", count: 1 },
        { status: "ai_review_submitted", count: 3 },
        { status: "needs_manual_review", count: 4 },
        { status: "added", count: 5 },
        { status: "failed", count: 1 },
      ],
      [
        workerRun({
          kind: "source_intake",
          status: "failed",
          requests_loaded: 6,
          captured: 2,
          ai_review_submitted: 3,
          needs_manual_review: 4,
          created_or_updated_sources: 2,
          awards_queued_for_reconciliation: 2,
          billing_blocked: true,
          blocking_reason: "credits are depleted",
        }),
      ],
    );

    expect(summary.pending).toBe(2);
    expect(summary.inProgress).toBe(4);
    expect(summary.needsManualReview).toBe(4);
    expect(summary.added).toBe(5);
    expect(summary.failed).toBe(1);
    expect(summary.latestWorker).toMatchObject({
      requestsLoaded: 6,
      createdOrUpdatedSources: 2,
      awardsQueuedForReconciliation: 2,
      billingBlocked: true,
      blockingReason: "credits are depleted",
    });
  });

  it("reads the counters shape emitted by the source-intake worker", () => {
    const summary = summarizeSourceIntake([], [
      workerRun({
        kind: "source_intake",
        status: "succeeded_with_deferred_work",
        counters: {
          requests_loaded: 9,
          captured: 8,
          deterministic_rejected: 2,
          ai_review_pending: 3,
          ai_review_submitted: 4,
          ai_review_succeeded: 5,
          needs_manual_review: 1,
          matched_existing_awards: 6,
          created_awards: 2,
          created_or_updated_sources: 7,
          fact_candidates_inserted: 11,
          awards_queued_for_reconciliation: 6,
          failed: 3,
          capture_claim_conflicts: 2,
          reconcile_claim_conflicts: 1,
          submission_claim_conflicts: 4,
          submission_claims_lost_after_batch_create: 1,
          manual_recovery_required: 3,
          stale_capture_requests_requeued: 2,
          stale_reconcile_claims_requeued: 1,
          stale_matching_requests_failed_closed: 1,
        },
        stage_counts: {
          poll: { eligible: null, loaded: 5, selected: 3, attempted: 3, completed: 3, deferred: 2, windowed: true },
          capture: { eligible: 9, loaded: 9, attempted: 5, completed: 5, deferred: 4, windowed: false },
          submit: { eligible: 8, loaded: 4, attempted: 4, completed: 4, deferred: 4, windowed: false },
          reconcile: { eligible: null, loaded: 6, attempted: 2, completed: 2, deferred: 4, windowed: true },
        },
        stop_reason: "time_budget_exhausted:capture",
      }),
    ]);

    expect(summary.latestWorker).toMatchObject({
      status: "succeeded_with_deferred_work",
      requestsLoaded: 9,
      captured: 8,
      deterministicRejected: 2,
      aiReviewSubmitted: 4,
      aiReviewSucceeded: 5,
      factCandidatesInserted: 11,
      awardsQueuedForReconciliation: 6,
      failed: 3,
      captureClaimConflicts: 2,
      reconcileClaimConflicts: 1,
      submissionClaimConflicts: 4,
      submissionClaimsLostAfterBatchCreate: 1,
      manualRecoveryRequired: 3,
      staleCaptureRequestsRequeued: 2,
      staleReconcileClaimsRequeued: 1,
      staleMatchingRequestsFailedClosed: 1,
      stageCounts: {
        poll: { eligible: null, loaded: 5, selected: 3, attempted: 3, completed: 3, deferred: 2, windowed: true },
        capture: { eligible: 9, loaded: 9, selected: null, attempted: 5, completed: 5, deferred: 4, windowed: false },
        submit: { eligible: 8, loaded: 4, selected: null, attempted: 4, completed: 4, deferred: 4, windowed: false },
        reconcile: { eligible: null, loaded: 6, selected: null, attempted: 2, completed: 2, deferred: 4, windowed: true },
      },
      blockingReason: "time_budget_exhausted:capture",
    });
  });
});
