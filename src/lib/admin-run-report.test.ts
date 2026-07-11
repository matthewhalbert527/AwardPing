import { describe, expect, it } from "vitest";
import {
  buildAdminRunReportFeed,
  type WorkerRun,
} from "@/lib/admin-run-report";

function workerRun(
  overrides: Partial<WorkerRun> = {},
  metadata: Record<string, unknown> = {},
): WorkerRun {
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
    metadata: metadata as WorkerRun["metadata"],
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

  it("reports the latest completed overnight daily run and its child work", () => {
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
    const visual = workerRun(
      {
        id: "daily-visual",
        status: "succeeded",
        checked_count: 1_200,
        failed_count: 7,
        started_at: "2026-07-09T23:00:02.000Z",
        finished_at: "2026-07-10T05:55:00.000Z",
      },
      {
        kind: "visual_snapshot",
        counts: { candidate_changes: 12, published_updates: 2 },
      },
    );

    const feed = buildAdminRunReportFeed([parent, visual], new Date("2026-07-10T12:00:00.000Z"));

    expect(feed.current).toBeNull();
    expect(feed.overnight?.summary).toContain("checked 1,200 source pages");
    expect(feed.overnight?.summary).toContain("published 2 verified updates");
    expect(feed.overnight?.items.find((item) => item.key === "failures")?.value).toBe(7);
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
});
