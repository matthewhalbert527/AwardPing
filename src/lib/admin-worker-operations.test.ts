import { describe, expect, it } from "vitest";
import { loadAdminWorkerOperations } from "@/lib/admin-worker-operations";

describe("admin worker operations loader", () => {
  it("normalizes the authoritative budget source and complete lane timing state", async () => {
    const admin = fakeAdmin({
      list_gemini_budget_status: [{
        lane_key: "new_page_review",
        cap_micro_usd: 5_000_000,
        reserved_micro_usd: 750_000,
        spent_micro_usd: 1_250_000,
        remaining_micro_usd: 3_000_000,
        reset_at: "2026-07-17T00:00:00.000Z",
        source: "postgres_atomic_budget_v1",
      }],
      list_monitoring_downstream_lane_status: [{
        lane_key: "nightly_report",
        display_name: "6 PM capture report",
        creates_api_charge: false,
        enabled: false,
        claimable: false,
        timeout_seconds: 240,
        lease_ttl_seconds: 360,
        sla_seconds: 900,
        oldest_item_sla_seconds: null,
        queue_depth: 0,
        oldest_item_at: null,
        next_sla_due_at: "2026-07-16T23:15:00.000Z",
        sla_breached: true,
        lease_owner: "pc-worker-2",
        lease_expires_at: "2026-07-16T23:14:00.000Z",
        lease_expired: true,
        next_eligible_at: "2026-07-16T23:20:00.000Z",
        consecutive_failures: 1,
        status: "backoff",
        last_error: "Report finalization timed out.",
        last_started_at: "2026-07-16T23:10:00.000Z",
        last_finished_at: "2026-07-16T23:16:00.000Z",
        last_succeeded_at: "2026-07-15T23:14:00.000Z",
        last_failed_at: "2026-07-16T23:16:00.000Z",
        source: "postgres_lane_scheduler_v1",
      }],
    });

    const result = await loadAdminWorkerOperations(admin as never, []);

    expect(result.loadErrors).toEqual([]);
    expect(result.budgets[0]).toMatchObject({
      capUsd: 5,
      reservedUsd: 0.75,
      spentUsd: 1.25,
      remainingUsd: 3,
      configurationSource: "postgres_atomic_budget_v1",
    });
    expect(result.lanes[0]).toMatchObject({
      enabled: false,
      claimable: false,
      timeoutSeconds: 240,
      leaseTtlSeconds: 360,
      oldestItemSlaSeconds: 900,
      nextSlaDueAt: "2026-07-16T23:15:00.000Z",
      slaBreached: true,
      leaseOwner: "pc-worker-2",
      leaseExpiresAt: "2026-07-16T23:14:00.000Z",
      leaseExpired: true,
      nextRetryAt: "2026-07-16T23:20:00.000Z",
      lastStartedAt: "2026-07-16T23:10:00.000Z",
      lastFinishedAt: "2026-07-16T23:16:00.000Z",
      lastSucceededAt: "2026-07-15T23:14:00.000Z",
      policySource: "postgres_lane_scheduler_v1",
    });
  });

  it("preserves recovery-history load errors for the operator inbox", async () => {
    const result = await loadAdminWorkerOperations(
      fakeAdmin(emptyRpcResults()) as never,
      [],
      ["The exact scheduled-shard reports could not be loaded."],
      new Date("2026-07-16T23:45:00.000Z"),
    );

    expect(result.loadErrors).toEqual([
      "The exact scheduled-shard reports could not be loaded.",
    ]);
    expect(result.recoveryLoadErrors).toEqual(result.loadErrors);
    expect(result.operationsLoadErrors).toEqual([]);
    expect(result.evidenceRecovery.enabled).toBeNull();
  });

  it("requires all three exact scheduled shards in the current cohort before reporting recovery ready", async () => {
    const current = visualRun(0, "visual-nightly:2026-07-16", "2026-07-16T23:30:00.000Z", {
      enabled: true,
      attempts: 2,
      recovered: 1,
    });
    const olderComplete = [0, 1, 2].map((shardIndex) => visualRun(
      shardIndex,
      "visual-nightly:2026-07-15",
      `2026-07-15T23:3${shardIndex}:00.000Z`,
      { enabled: true, attempts: 50, recovered: 50 },
    ));
    const maintenance = visualRun(1, "visual-maintenance:2026-07-16", "2026-07-16T23:35:00.000Z", {
      enabled: true,
      attempts: 80,
      recovered: 80,
      trigger: "maintenance",
    });

    const result = await loadAdminWorkerOperations(
      fakeAdmin(emptyRpcResults()) as never,
      [maintenance, current, ...olderComplete] as never,
      [],
      new Date("2026-07-16T23:45:00.000Z"),
    );

    expect(result.evidenceRecovery).toMatchObject({
      enabled: null,
      expectedShards: 3,
      reportingShards: 1,
      missingShardNumbers: [2, 3],
      attempts: 2,
      recovered: 1,
    });
    expect(result.evidenceRecovery.statusReason).toContain("shards 2, 3");
    expect(result.evidenceRecovery.safeAction).toContain("rerun only the missing shard");
  });

  it("reports complete enabled settings, attempts, refusals, failures, and their reasons only from the current cohort", async () => {
    const runs = [
      visualRun(0, "visual-nightly:2026-07-16", "2026-07-16T23:31:00.000Z", {
        enabled: true,
        attempts: 2,
        recovered: 1,
        refused: 1,
        reasons: { immutable_hash_mismatch: 1 },
      }),
      visualRun(1, "visual-nightly:2026-07-16", "2026-07-16T23:32:00.000Z", {
        enabled: true,
        attempts: 3,
        recovered: 2,
        failed: 1,
        reasons: { r2_download_failed: 1 },
      }),
      visualRun(2, "visual-nightly:2026-07-16", "2026-07-16T23:33:00.000Z", {
        enabled: true,
        attempts: 0,
        recovered: 0,
      }),
    ];

    const result = await loadAdminWorkerOperations(
      fakeAdmin(emptyRpcResults()) as never,
      runs as never,
      [],
      new Date("2026-07-16T23:45:00.000Z"),
    );

    expect(result.evidenceRecovery).toMatchObject({
      enabled: true,
      reportingShards: 3,
      missingShardNumbers: [],
      disabledShardNumbers: [],
      unknownShardNumbers: [],
      attempts: 5,
      recovered: 3,
      refused: 1,
      failed: 1,
      reasons: [
        { code: "immutable_hash_mismatch", count: 1 },
        { code: "r2_download_failed", count: 1 },
      ],
    });
    expect(result.evidenceRecovery.statusReason).toContain("reported 1 failure and 1 refused restore");
    expect(result.evidenceRecovery.safeAction).toContain("R2 credentials and connectivity");
  });

  it("does not report ready when even one current scheduled shard explicitly disables recovery", async () => {
    const runs = [0, 1, 2].map((shardIndex) => visualRun(
      shardIndex,
      "visual-nightly:2026-07-16",
      `2026-07-16T23:3${shardIndex}:00.000Z`,
      { enabled: shardIndex !== 1, attempts: 0, recovered: 0 },
    ));

    const result = await loadAdminWorkerOperations(
      fakeAdmin(emptyRpcResults()) as never,
      runs as never,
      [],
      new Date("2026-07-16T23:45:00.000Z"),
    );

    expect(result.evidenceRecovery).toMatchObject({
      enabled: false,
      reportingShards: 3,
      disabledShardNumbers: [2],
    });
    expect(result.evidenceRecovery.statusReason).toContain("disabled on shard 2");
    expect(result.evidenceRecovery.safeAction).toContain("AWARDPING_R2_SNAPSHOT_SYNC=true");
  });

  it("treats a null recovery setting from a reported shard as unknown, not ready", async () => {
    const runs = [0, 1, 2].map((shardIndex) => visualRun(
      shardIndex,
      "visual-nightly:2026-07-16",
      `2026-07-16T23:3${shardIndex}:00.000Z`,
      { enabled: shardIndex === 2 ? null : true, attempts: 0, recovered: 0 },
    ));

    const result = await loadAdminWorkerOperations(
      fakeAdmin(emptyRpcResults()) as never,
      runs as never,
      [],
      new Date("2026-07-16T23:45:00.000Z"),
    );

    expect(result.evidenceRecovery).toMatchObject({
      enabled: null,
      reportingShards: 3,
      unknownShardNumbers: [3],
    });
    expect(result.evidenceRecovery.statusReason).toContain("shard 3 did not report whether");
  });
});

function emptyRpcResults() {
  return {
    list_gemini_budget_status: [],
    list_monitoring_downstream_lane_status: [],
  };
}

function fakeAdmin(results: Record<string, unknown>) {
  const admin = {
    async rpc(this: unknown, name: string) {
      expect(this).toBe(admin);
      return { data: results[name] ?? null, error: null };
    },
  };
  return admin;
}

function visualRun(
  shardIndex: number,
  cohortId: string,
  finishedAt: string,
  options: {
    enabled: boolean | null;
    attempts: number;
    recovered: number;
    refused?: number;
    failed?: number;
    reasons?: Record<string, number>;
    trigger?: string;
  },
) {
  return {
    id: `${cohortId}:${shardIndex}:${finishedAt}`,
    worker_name: `local-visual-snapshot-worker-shard-${shardIndex + 1}-of-3`,
    started_at: finishedAt,
    finished_at: finishedAt,
    metadata: {
      kind: "visual_snapshot",
      run_identity: {
        trigger: options.trigger || "scheduled",
        cohort_id: cohortId,
        monitoring_date: cohortId.split(":").at(-1),
        shard_count: 3,
        shard_index: shardIndex,
      },
      options: {
        r2_rehydrate_local_cache: options.enabled,
        r2_snapshot_sync: true,
      },
      counts: {
        r2_rehydrate_local_cache: options.attempts,
        r2_rehydrated_local: options.recovered,
        r2_rehydration_refused: options.refused || 0,
        r2_rehydration_failed: options.failed || 0,
        r2_rehydration_reasons: options.reasons || {},
      },
    },
  };
}
