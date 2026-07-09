import { describe, expect, it, vi } from "vitest";
import type { Database } from "@/lib/database.types";

vi.mock("server-only", () => ({}));

import { summarizeAwardReconciliation } from "@/lib/admin-reconciliation";

type WorkerRun = Database["public"]["Tables"]["local_worker_runs"]["Row"];

function workerRun(metadata: Record<string, unknown>): WorkerRun {
  return {
    id: "run-reconcile",
    worker_name: "award-page-reconciliation",
    status: "succeeded",
    ai_provider: null,
    checked_count: 0,
    changed_count: 0,
    unchanged_count: 0,
    initial_count: 0,
    discovered_count: 0,
    failed_count: 0,
    error: null,
    metadata: metadata as WorkerRun["metadata"],
    started_at: "2026-07-09T00:00:00.000Z",
    finished_at: "2026-07-09T00:10:00.000Z",
  };
}

describe("admin reconciliation summary", () => {
  it("counts queue statuses and latest reconciliation run fields", () => {
    const summary = summarizeAwardReconciliation(
      [
        { id: "queue-1", shared_award_id: "award-1", status: "pending", reason: "source_changed" },
        { id: "queue-2", shared_award_id: "award-2", status: "failed", reason: "audit_failed", error: "deadline conflict" },
      ],
      [
        workerRun({
          kind: "award_page_reconciliation",
          status: "succeeded",
          counts: {
            awards_reconciled: 12,
            awards_publication_blocked: 2,
            awards_used_last_known_good: 2,
            sibling_sources_rejected: 4,
            deadline_conflicts_detected: 3,
            stale_cycle_states_corrected: 5,
            facts_published: 10,
          },
        }),
      ],
    );

    expect(summary.queueCounts.pending).toBe(1);
    expect(summary.queueCounts.failed).toBe(1);
    expect(summary.latestRun).toMatchObject({
      awardsReconciled: 12,
      awardsPublicationBlocked: 2,
      awardsUsedLastKnownGood: 2,
      siblingSourcesRejected: 4,
      deadlineConflictsDetected: 3,
      staleCycleStatesCorrected: 5,
      factsPublished: 10,
    });
  });
});
