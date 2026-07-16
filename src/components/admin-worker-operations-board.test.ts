import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AdminWorkerOperationsBoard } from "@/components/admin-worker-operations-board";
import type {
  AdminDownstreamLane,
  AdminWorkerOperations,
} from "@/lib/admin-worker-operations";

describe("AdminWorkerOperationsBoard", () => {
  it("shows missing recovery reports as not verified with counts, reason, and a safe action", () => {
    const result = operationsResult();
    const html = renderToStaticMarkup(createElement(AdminWorkerOperationsBoard, {
      result,
      view: "recovery",
      now: "2026-07-16T23:45:00.000Z",
    }));

    expect(html).toContain("Recovery not verified");
    expect(html).toContain("Scheduled shards reporting");
    expect(html).toContain("1 / 3");
    expect(html).toContain("Recovery attempts");
    expect(html).toContain(">2<");
    expect(html).toContain("Scheduled shards 2, 3 did not report");
    expect(html).toContain("Safe action: Check the Scheduled Task");
    expect(html).toContain("immutable hash mismatch (1)");
    expect(html).not.toContain("Fail-closed recovery ready");
  });

  it("shows the database SLA deadline and breach independently from queue age", () => {
    const result = operationsResult();
    result.lanes = [downstreamLane({
      laneKey: "nightly_report",
      label: "6 PM capture report",
      timeoutSeconds: 240,
      oldestItemSlaSeconds: 0,
      queueDepth: 0,
      nextSlaDueAt: "2026-07-16T23:15:00.000Z",
      slaBreached: true,
      nextRetryAt: "2026-07-16T23:20:00.000Z",
      consecutiveFailures: 1,
      lastStatus: "backoff",
      lastError: "Report finalization timed out.",
      lastFailedAt: "2026-07-16T23:16:00.000Z",
    })];

    const html = renderToStaticMarkup(createElement(AdminWorkerOperationsBoard, {
      result,
      view: "operations",
      now: "2026-07-16T23:45:00.000Z",
    }));

    expect(html).toContain("No waiting item");
    expect(html).toContain("SLA breached; unclaimed");
    expect(html).toContain("Timeout 4m");
    expect(html).toContain("Lease TTL 6m");
    expect(html).toContain("Lease owner None");
    expect(html).toContain("Retry was due");
    expect(html).toContain("Report finalization timed out.");
  });

  it("flags disabled and expired lanes with their owner and run evidence", () => {
    const result = operationsResult();
    result.lanes = [
      downstreamLane({
        laneKey: "suppression",
        label: "Suppression",
        enabled: false,
        claimable: false,
      }),
      downstreamLane({
        laneKey: "reconciliation",
        label: "Reconciliation",
        claimable: false,
        leaseOwner: "pc-worker-2",
        leaseExpiresAt: "2026-07-16T23:30:00.000Z",
        leaseExpired: true,
        lastStatus: "claimed",
        lastFinishedAt: "2026-07-16T22:45:00.000Z",
        lastSucceededAt: "2026-07-16T21:45:00.000Z",
      }),
    ];

    const html = renderToStaticMarkup(createElement(AdminWorkerOperationsBoard, {
      result,
      view: "operations",
      now: "2026-07-16T23:45:00.000Z",
    }));

    expect(html).toContain("Disabled");
    expect(html).toContain("Lane disabled; no worker can claim it");
    expect(html).toContain("Lease expired");
    expect(html).toContain("Lease owner pc-worker-2");
    expect(html).toContain("Last finished");
    expect(html).toContain("Last success");
  });
});

function downstreamLane(
  overrides: Partial<AdminDownstreamLane> = {},
): AdminDownstreamLane {
  return {
    laneKey: "page_audit",
    label: "Page audit",
    paid: false,
    enabled: true,
    claimable: true,
    timeoutSeconds: 600,
    leaseTtlSeconds: 360,
    oldestItemSlaSeconds: 3_600,
    queueDepth: 0,
    oldestItemAt: null,
    nextSlaDueAt: "2026-07-17T00:00:00.000Z",
    slaBreached: false,
    leaseOwner: null,
    leaseExpiresAt: null,
    leaseExpired: false,
    nextRetryAt: null,
    consecutiveFailures: 0,
    lastStatus: "idle",
    lastError: null,
    lastStartedAt: null,
    lastFinishedAt: null,
    lastSucceededAt: null,
    lastFailedAt: null,
    policySource: "postgres_lane_scheduler_v1",
    ...overrides,
  };
}

function operationsResult(): AdminWorkerOperations {
  return {
    budgets: [],
    lanes: [],
    evidenceRecovery: {
      enabled: null,
      expectedShards: 3,
      reportingShards: 1,
      missingShardNumbers: [2, 3],
      disabledShardNumbers: [],
      unknownShardNumbers: [],
      attempts: 2,
      recovered: 1,
      exactGeometryRecovered: 1,
      evidenceOnlyRecovered: 0,
      refused: 1,
      failed: 0,
      reasons: [{ code: "immutable_hash_mismatch", count: 1 }],
      statusReason: "Scheduled shards 2, 3 did not report in the current 6 PM cohort.",
      safeAction: "Check the Scheduled Task and wrapper log for shards 2, 3, then rerun only the missing shard.",
      lastReportedAt: "2026-07-16T23:30:00.000Z",
      configurationSource: "Immutable R2 generation + current scheduled cohort visual-nightly:2026-07-16",
    },
    recoveryLoadErrors: [],
    operationsLoadErrors: [],
    loadErrors: [],
  };
}
