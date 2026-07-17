import { describe, expect, it } from "vitest";
import {
  buildAdminRunReportFeed,
  type WorkerRun,
} from "@/lib/admin-run-report";
import { buildVisualSourceInventoryProof } from "../../scripts/lib/visual-source-inventory-proof.mjs";

function workerRun(
  overrides: Partial<WorkerRun> = {},
  metadata: Record<string, unknown> = {},
): WorkerRun {
  const runIdentity = metadata.run_identity as Record<string, unknown> | undefined;
  const normalizedMetadata = runIdentity?.trigger === "scheduled"
    ? {
        ...metadata,
        source_inventory: metadata.source_inventory || inventoryProof(
          Number(runIdentity.shard_index || 0),
        ),
        options: {
          include_not_due: true,
          limit: 50_000,
          discovery_mode: true,
          discovery_intent: "live_recurring",
          discovery_onboarding_batch_id: null,
          ...((metadata.options as Record<string, unknown> | undefined) || {}),
        },
      }
    : metadata;
  return {
    id: overrides.id || "run-1",
    worker_name: overrides.worker_name || "local-visual-snapshot-worker-shard-1-of-3",
    status: overrides.status || "succeeded",
    ai_provider: null,
    checked_count: 0,
    changed_count: 0,
    unchanged_count: 0,
    initial_count: 0,
    discovered_count: 0,
    failed_count: 0,
    error: null,
    metadata: normalizedMetadata as WorkerRun["metadata"],
    started_at: overrides.started_at || "2026-07-09T23:00:00.000Z",
    finished_at: overrides.finished_at === undefined
      ? "2026-07-10T06:00:00.000Z"
      : overrides.finished_at,
    ...overrides,
  };
}

describe("admin run report", () => {
  it("combines live visual shards and setup progress into one ticker", () => {
    const runs = [
      workerRun(
        {
          id: "visual-1",
          status: "running",
          checked_count: 400,
          failed_count: 2,
          finished_at: null,
          started_at: "2026-07-10T23:00:00.000Z",
        },
        {
          kind: "visual_snapshot",
          counts: {
            candidate_changes: 3,
            deterministic_noise_rejected: 2,
            expandable_sections_extracted: 120,
            published_updates: 1,
          },
        },
      ),
      workerRun(
        {
          id: "visual-2",
          worker_name: "local-visual-snapshot-worker-shard-2-of-3",
          status: "running",
          checked_count: 300,
          failed_count: 1,
          finished_at: null,
          started_at: "2026-07-10T23:00:01.000Z",
        },
        {
          kind: "visual_snapshot",
          counts: {
            candidate_changes: 2,
            deterministic_source_rejected: 1,
            expandable_sections_extracted: 80,
            published_updates: 0,
          },
        },
      ),
      workerRun(
        {
          id: "coverage",
          worker_name: "local-open-source-ai-coverage-backfill",
          status: "running",
          checked_count: 15_000,
          changed_count: 9_000,
          initial_count: 6_000,
          finished_at: null,
          started_at: "2026-07-10T20:00:00.000Z",
        },
        {
          kind: "open_source_ai_review_coverage_backfill",
          counters: {
            moved_to_review_later: 9_000,
            queued_for_ai_review: 6_000,
          },
        },
      ),
      workerRun(
        {
          id: "maintenance",
          worker_name: "local-maintenance-runner",
          status: "running",
          finished_at: null,
          started_at: "2026-07-10T20:00:00.000Z",
        },
        { kind: "maintenance", profile: "catchup" },
      ),
    ];

    const feed = buildAdminRunReportFeed(runs, new Date("2026-07-10T23:20:00.000Z"));

    expect(feed.current?.title).toBe("Daily check and setup are running");
    expect(feed.current?.summary).toContain("700 source pages checked so far");
    expect(feed.current?.summary).toContain("9,000 irrelevant or unclear sources excluded");
    expect(Object.fromEntries(feed.current?.items.map((item) => [item.key, item.value]) || [])).toMatchObject({
      checked: 700,
      candidates: 5,
      published: 1,
      noise: 3,
      sections: 200,
      failures: 3,
      excluded: 9_000,
      "batch-ready": 6_000,
    });
  });

  it("keeps completed phase totals while the parent maintenance run continues", () => {
    const runs = [
      workerRun(
        {
          id: "maintenance",
          worker_name: "local-maintenance-runner",
          status: "running",
          finished_at: null,
          started_at: "2026-07-10T20:00:00.000Z",
        },
        { kind: "maintenance", profile: "catchup" },
      ),
      workerRun(
        {
          id: "coverage-complete",
          worker_name: "local-open-source-ai-coverage-backfill",
          status: "succeeded",
          checked_count: 15_681,
          finished_at: "2026-07-10T22:00:00.000Z",
          started_at: "2026-07-10T20:01:00.000Z",
        },
        {
          kind: "open_source_ai_review_coverage_backfill",
          counters: {
            moved_to_review_later: 9_036,
            queued_for_ai_review: 6_645,
          },
        },
      ),
      workerRun(
        {
          id: "daily-visual-complete",
          worker_name: "local-visual-snapshot-worker-shard-1-of-3",
          status: "succeeded",
          checked_count: 1_000,
          finished_at: "2026-07-10T23:45:00.000Z",
          started_at: "2026-07-10T23:00:00.000Z",
        },
        {
          kind: "visual_snapshot",
          counts: {
            candidate_changes: 4,
            deterministic_noise_rejected: 3,
            expandable_sections_extracted: 548,
          },
        },
      ),
      workerRun(
        {
          id: "baseline-active",
          worker_name: "local-baseline-facts-worker",
          status: "running",
          finished_at: null,
          started_at: "2026-07-10T23:50:00.000Z",
        },
        { kind: "baseline_facts", counts: { checked: 0, extracted: 0 } },
      ),
    ];

    const feed = buildAdminRunReportFeed(runs, new Date("2026-07-11T00:00:00.000Z"));

    expect(feed.current?.title).toBe("Daily check completed; setup is running");
    expect(feed.current?.summary).toContain("1,000 source pages checked so far");
    expect(feed.current?.summary).toContain("9,036 irrelevant or unclear sources excluded");
    expect(feed.current?.summary).toContain("6,645 sources prepared for Batch review");
    expect(Object.fromEntries(feed.current?.items.map((reportItem) => [reportItem.key, reportItem.value]) || []))
      .toMatchObject({
        checked: 1_000,
        candidates: 4,
        noise: 3,
        sections: 548,
        excluded: 9_036,
        "batch-ready": 6_645,
      });
  });

  it("reports the completed 6 PM triad without mixing in maintenance work", () => {
    const parent = workerRun(
      {
        id: "daily-parent",
        worker_name: "local-maintenance-runner",
        status: "succeeded",
        started_at: "2026-07-09T23:00:00.000Z",
        finished_at: "2026-07-10T06:00:00.000Z",
      },
      { kind: "maintenance", profile: "daily" },
    );
    const visuals = [0, 1, 2].map((shardIndex) => workerRun(
      {
        id: `daily-visual-${shardIndex}`,
        worker_name: `local-visual-snapshot-worker-shard-${shardIndex + 1}-of-3`,
        status: "succeeded",
        checked_count: 400,
        failed_count: shardIndex === 0 ? 7 : 0,
        started_at: `2026-07-09T23:00:0${shardIndex}.000Z`,
        finished_at: `2026-07-10T05:5${shardIndex}:00.000Z`,
      },
      {
        kind: "visual_snapshot",
        run_identity: { trigger: "scheduled", shard_count: 3, shard_index: shardIndex },
        baseline_coverage: { start: { loaded_sources: 400 + (shardIndex === 0 ? 7 : 0) } },
        source_inventory: inventoryProof(shardIndex, [407, 400, 400]),
      },
    ));

    const feed = buildAdminRunReportFeed([parent, ...visuals], new Date("2026-07-10T12:00:00.000Z"));

    expect(feed.current).toBeNull();
    expect(feed.overnight?.summary).toContain("captured 1,200 pages");
    expect(feed.overnight?.summary).toContain("7 source failures");
    expect(feed.overnight?.items.find((item) => item.key === "failures")?.value).toBe(7);
    expect(feed.overnight?.status).toBe("degraded");
  });

  it("plainly reports an overnight run that recorded no useful work", () => {
    const parent = workerRun(
      {
        id: "daily-parent",
        worker_name: "local-maintenance-runner",
        status: "succeeded",
      },
      { kind: "maintenance", profile: "daily" },
    );
    const baseline = workerRun(
      {
        id: "baseline",
        worker_name: "local-baseline-facts-worker",
        status: "succeeded",
        started_at: "2026-07-09T23:00:01.000Z",
      },
      { kind: "baseline_facts", counts: { checked: 0, extracted: 0, applied: 0 } },
    );

    const feed = buildAdminRunReportFeed([parent, baseline], new Date("2026-07-10T12:00:00.000Z"));

    expect(feed.overnight?.items).toEqual([]);
    expect(feed.overnight?.summary).toBe(
      "The last overnight run completed, but it recorded no source-page checks, new AI interpretations, or public updates.",
    );
  });

  it("does not treat an old orphaned running row as current work", () => {
    const stale = workerRun(
      {
        id: "stale",
        status: "running",
        finished_at: null,
        started_at: "2026-07-01T23:00:00.000Z",
      },
      { kind: "visual_snapshot" },
    );

    expect(buildAdminRunReportFeed([stale], new Date("2026-07-10T12:00:00.000Z")).current).toBeNull();
  });

  it("reports the complete scheduled triad as degraded and includes safe repairs", () => {
    const runs = [0, 1, 2].map((shardIndex) => workerRun(
      {
        id: `shard-${shardIndex}`,
        worker_name: `local-visual-snapshot-worker-shard-${shardIndex + 1}-of-3`,
        checked_count: shardIndex === 0 ? 98 : 100,
        failed_count: shardIndex === 0 ? 2 : 0,
        started_at: `2026-07-14T23:00:0${shardIndex}.000Z`,
        finished_at: `2026-07-14T23:30:0${shardIndex}.000Z`,
      },
      {
        kind: "visual_snapshot",
        run_identity: { trigger: "scheduled", shard_count: 3, shard_index: shardIndex },
        options: {
          discovery_mode: true,
          discovery_intent: "live_recurring",
          discovery_onboarding_batch_id: null,
        },
        run_health: {
          status: shardIndex === 0 ? "degraded" : "healthy",
          incident_count: shardIndex === 0 ? 2 : 0,
        },
        baseline_coverage: { start: { loaded_sources: 100 } },
        failure_groups: shardIndex === 0 ? [{
          code: "rate_limited",
          label: "Source rate-limited the scan",
          severity: "warning",
          count: 2,
          source_id_count: 2,
          retry_mode: "automatic_next_scan",
          repair_code: "backoff_then_retry",
          solution: "Allow the next scheduled retry with backoff.",
        }] : [],
      },
    ));

    const report = buildAdminRunReportFeed(
      runs,
      new Date("2026-07-15T12:00:00.000Z"),
    ).visualNightly;

    expect(report).toMatchObject({
      monitoringDate: "2026-07-14",
      status: "degraded",
      expectedShards: 3,
      observedShards: 3,
      completedShards: 3,
      missingShards: [],
      loaded: 300,
      checked: 298,
      failed: 2,
      incidents: 2,
    });
    expect(report?.failureGroups).toEqual([
      expect.objectContaining({
        code: "rate_limited",
        count: 2,
        retryMode: "automatic_next_scan",
        solution: "Allow the next scheduled retry with backoff.",
      }),
    ]);
  });

  it("does not call a nightly scan successful when a shard is missing", () => {
    const runs = [0, 2].map((shardIndex) => workerRun(
      {
        id: `shard-${shardIndex}`,
        worker_name: `local-visual-snapshot-worker-shard-${shardIndex + 1}-of-3`,
        checked_count: 100,
        started_at: `2026-07-14T23:00:0${shardIndex}.000Z`,
        finished_at: `2026-07-14T23:30:0${shardIndex}.000Z`,
      },
      {
        kind: "visual_snapshot",
        run_identity: { trigger: "scheduled", shard_count: 3, shard_index: shardIndex },
        run_health: { status: "healthy", incident_count: 0 },
      },
    ));

    const report = buildAdminRunReportFeed(
      runs,
      new Date("2026-07-15T04:30:00.000Z"),
    ).visualNightly;

    expect(report).toMatchObject({
      status: "incomplete",
      completedShards: 2,
      missingShards: [2],
    });
  });

  it("fails a complete triad whose authoritative global inventory hashes disagree", () => {
    const runs = [0, 1, 2].map((shardIndex) => workerRun(
      {
        id: `proof-${shardIndex}`,
        worker_name: `local-visual-snapshot-worker-shard-${shardIndex + 1}-of-3`,
        checked_count: 100,
        started_at: `2026-07-14T23:00:0${shardIndex}.000Z`,
        finished_at: `2026-07-14T23:30:0${shardIndex}.000Z`,
      },
      {
        kind: "visual_snapshot",
        run_identity: { trigger: "scheduled", shard_count: 3, shard_index: shardIndex },
        baseline_coverage: { start: { loaded_sources: 100 } },
      },
    ));
    const thirdMetadata = runs[2].metadata as Record<string, unknown>;
    thirdMetadata.source_inventory = {
      ...(thirdMetadata.source_inventory as Record<string, unknown>),
      global_source_ids_sha256: "f".repeat(64),
    };

    const report = buildAdminRunReportFeed(
      runs,
      new Date("2026-07-15T12:00:00.000Z"),
    ).visualNightly;

    expect(report).toMatchObject({
      status: "failed",
      inventoryComplete: false,
      inventoryProofComplete: false,
    });
    expect(report?.failureGroups).toContainEqual(expect.objectContaining({
      code: "source_inventory_proof_missing_or_mismatched",
    }));
    expect(report?.summary).toContain("inventory proofs");
  });

  it("uses only the latest attempt per shard and ignores maintenance shards", () => {
    const olderFailure = workerRun(
      {
        id: "old-failure",
        worker_name: "local-visual-snapshot-worker-shard-1-of-3",
        status: "failed",
        failed_count: 1,
        started_at: "2026-07-14T23:00:00.000Z",
        finished_at: "2026-07-14T23:10:00.000Z",
      },
      {
        kind: "visual_snapshot",
        run_identity: { trigger: "scheduled", shard_count: 3, shard_index: 0 },
      },
    );
    const retry = workerRun(
      {
        id: "retry",
        worker_name: "local-visual-snapshot-worker-shard-1-of-3",
        checked_count: 100,
        started_at: "2026-07-15T00:00:00.000Z",
        finished_at: "2026-07-15T00:20:00.000Z",
      },
      {
        kind: "visual_snapshot",
        run_identity: { trigger: "scheduled", shard_count: 3, shard_index: 0 },
      },
    );
    const shardTwo = workerRun(
      {
        id: "shard-two",
        worker_name: "local-visual-snapshot-worker-shard-2-of-3",
        checked_count: 100,
        started_at: "2026-07-14T23:00:01.000Z",
      },
      { kind: "visual_snapshot", run_identity: { trigger: "scheduled", shard_count: 3, shard_index: 1 } },
    );
    const shardThree = workerRun(
      {
        id: "shard-three",
        worker_name: "local-visual-snapshot-worker-shard-3-of-3",
        checked_count: 100,
        started_at: "2026-07-14T23:00:02.000Z",
      },
      { kind: "visual_snapshot", run_identity: { trigger: "scheduled", shard_count: 3, shard_index: 2 } },
    );
    const maintenance = workerRun(
      {
        id: "maintenance-shard",
        worker_name: "local-visual-snapshot-worker-shard-2-of-3",
        checked_count: 999,
        started_at: "2026-07-15T01:00:00.000Z",
      },
      { kind: "visual_snapshot", run_identity: { trigger: "maintenance", shard_count: 3, shard_index: 1 } },
    );
    const untaggedCatchup = workerRun(
      {
        id: "untagged-catchup",
        worker_name: "local-visual-snapshot-worker-shard-1-of-3",
        checked_count: 999,
        started_at: "2026-07-15T04:43:00.000Z",
      },
      { kind: "visual_snapshot" },
    );
    const onboardingDiscovery = workerRun(
      {
        id: "historical-onboarding-shard",
        worker_name: "local-visual-snapshot-worker-shard-3-of-3",
        checked_count: 999,
        started_at: "2026-07-15T01:30:00.000Z",
      },
      {
        kind: "visual_snapshot",
        run_identity: { trigger: "scheduled", shard_count: 3, shard_index: 2 },
        options: {
          discovery_mode: true,
          discovery_intent: "historical_onboarding",
          discovery_onboarding_batch_id: "bulk-2026-07-14",
        },
      },
    );

    const report = buildAdminRunReportFeed(
      [
        olderFailure,
        retry,
        shardTwo,
        shardThree,
        maintenance,
        untaggedCatchup,
        onboardingDiscovery,
      ],
      new Date("2026-07-15T12:00:00.000Z"),
    ).visualNightly;

    expect(report).toMatchObject({ status: "healthy", checked: 300, failed: 0 });
    expect(report?.shards.find((shard) => shard.shardNumber === 1)?.runId).toBe("retry");
  });

  it("reports the latest due window as missed instead of showing a stale success", () => {
    const prior = [0, 1, 2].map((shardIndex) => workerRun(
      {
        id: `prior-${shardIndex}`,
        worker_name: `local-visual-snapshot-worker-shard-${shardIndex + 1}-of-3`,
        checked_count: 100,
        started_at: `2026-07-13T23:00:0${shardIndex}.000Z`,
      },
      { kind: "visual_snapshot", run_identity: { trigger: "scheduled", shard_count: 3, shard_index: shardIndex } },
    ));

    const report = buildAdminRunReportFeed(
      prior,
      new Date("2026-07-15T12:00:00.000Z"),
    ).visualNightly;

    expect(report).toMatchObject({
      monitoringDate: "2026-07-14",
      status: "missed",
      observedShards: 0,
      missingShards: [1, 2, 3],
    });
    expect(report?.failureGroups).toEqual([
      expect.objectContaining({ code: "missing_shard", count: 3 }),
    ]);
  });

  it("marks a running shard with a stale heartbeat as stalled and failed", () => {
    const stalled = workerRun(
      {
        id: "stalled-shard",
        worker_name: "local-visual-snapshot-worker-shard-1-of-3",
        status: "running",
        finished_at: null,
        started_at: "2026-07-14T23:00:00.000Z",
      },
      {
        kind: "visual_snapshot",
        heartbeat_at: "2026-07-15T04:00:00.000Z",
        run_identity: { trigger: "scheduled", shard_count: 3, shard_index: 0 },
      },
    );

    const feed = buildAdminRunReportFeed(
      [stalled],
      new Date("2026-07-15T04:30:00.000Z"),
    );
    const report = feed.visualNightly;

    expect(feed.current).toBeNull();
    expect(report?.status).toBe("failed");
    expect(report?.shards[0]).toMatchObject({ status: "failed", stalled: true });
    expect(report?.failureGroups).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "stalled_shard", count: 1 }),
      expect.objectContaining({ code: "source_inventory_empty_or_incomplete", count: 1 }),
    ]));
  });
});

function inventoryProof(shardIndex: number, partitionCounts = [100, 100, 100]) {
  const sources = partitionCounts.flatMap((count, partition) =>
    Array.from({ length: count }, (_, index) => ({
      id: `source-${partition}-${String(index).padStart(4, "0")}`,
      partition,
    })),
  );
  return buildVisualSourceInventoryProof({
    eligibleSources: sources,
    loadedSources: sources.filter((source) => source.partition === shardIndex),
    shardCount: 3,
    shardIndex,
    shardIndexForSource: (source) => Number(source.partition),
    capturedAt: "2026-07-14T22:59:59.000Z",
  });
}
