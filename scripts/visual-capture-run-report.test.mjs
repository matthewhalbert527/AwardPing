import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  acquireFileLock,
  buildNightlyVisualReport,
  buildVisualRunReportSummary,
  classifyVisualCaptureFailure,
  monitoringDateForTimestamp,
  monitoringDateForVisualReportFilename,
  shouldReplaceLatestNightlyReport,
} from "./lib/visual-capture-run-report.mjs";

function shardReport(shardIndex, overrides = {}) {
  return {
    started_at: `2026-07-14T23:00:0${shardIndex}.000Z`,
    finished_at: `2026-07-14T23:30:0${shardIndex}.000Z`,
    status: "succeeded",
    options: {
      shard_count: 3,
      shard_index: shardIndex,
      run_trigger: "scheduled",
      baseline_refresh: false,
      complete_missing_baselines: false,
      localization_repair: false,
      r2_backfill_baselines: false,
      discovery_mode: false,
      source_id: null,
      source_url: null,
      award: null,
    },
    checked: 100,
    failed: 0,
    baseline_coverage_start: { loaded_sources: 100 },
    errors: [],
    ...overrides,
  };
}

describe("visual capture run reporting", () => {
  it("marks process success with source failures as degraded and supplies a guarded repair", () => {
    const summary = buildVisualRunReportSummary({
      status: "succeeded",
      checked: 99,
      failed: 1,
      baseline_coverage_start: { loaded_sources: 100 },
      errors: [{
        source_id: "source-1",
        source_url: "https://example.org/award",
        message: "Baseline exists but evidence is missing (page.jpg).",
      }],
    });

    expect(summary.run_health).toMatchObject({
      status: "degraded",
      execution_status: "succeeded",
      loaded_sources: 100,
      pages_captured: 99,
      source_failures: 1,
      failure_rate_percent: 1,
      requires_attention: true,
    });
    expect(summary.failure_groups[0]).toMatchObject({
      code: "baseline_evidence_missing_or_invalid",
      count: 1,
      retry_mode: "operator_guarded",
    });
    expect(summary.repair_plan.actions[0].solution).toContain("never refresh a baseline merely to clear this error");
  });

  it("does not let an HTTP 200 observation mask a baseline or timeout failure", () => {
    expect(classifyVisualCaptureFailure({
      message: "Baseline exists but evidence is missing. Probe returned HTTP 200.",
    }).code).toBe("baseline_evidence_missing_or_invalid");
    expect(classifyVisualCaptureFailure({
      message: "page.goto: Timeout 60000ms exceeded. Probe returned HTTP 200.",
    }).code).toBe("network_transient");
  });

  it("prioritizes the failed stage over a provider named in the message", () => {
    expect(classifyVisualCaptureFailure({
      message: "Visual review candidate enqueue failed: Supabase request timed out.",
    }).code).toBe("downstream_persistence_failed");
    expect(classifyVisualCaptureFailure({
      message: "R2 snapshot upload failed after a Supabase lookup.",
    }).code).toBe("storage_sync_failed");
  });

  it("routes shared AI quota failures to account repair instead of source backoff", () => {
    expect(classifyVisualCaptureFailure({
      message: "Gemini API cap reached after HTTP 429 quota exceeded.",
    })).toMatchObject({
      code: "ai_quota_or_billing_blocked",
      repair_code: "restore_ai_quota_then_restart",
      retry_mode: "repair_then_restart_shard",
    });
  });

  it("always supplies a repair path when failure counters exceed error events", () => {
    const summary = buildVisualRunReportSummary({
      status: "succeeded",
      checked: 10,
      failed: 2,
      errors: [],
    });

    expect(summary.failure_groups).toEqual([
      expect.objectContaining({
        code: "unknown_failure",
        count: 2,
        repair_code: "classify_before_retry",
      }),
    ]);
  });

  it("uses the Chicago 6 PM boundary for the monitoring date", () => {
    expect(monitoringDateForTimestamp("2026-07-14T22:59:59.000Z")).toBe("2026-07-13");
    expect(monitoringDateForTimestamp("2026-07-14T23:00:00.000Z")).toBe("2026-07-14");
  });

  it("derives monitoring windows from report filenames before parsing files", () => {
    expect(monitoringDateForVisualReportFilename(
      "visual-snapshot-run-2026-07-14T22-59-59-999Z.json",
    )).toBe("2026-07-13");
    expect(monitoringDateForVisualReportFilename(
      "visual-snapshot-run-2026-07-14T23-00-00-000Z-shard-1-deadbeef.json",
    )).toBe("2026-07-14");
  });

  it("serializes nightly report writers with the shared lock", async () => {
    const directory = mkdtempSync(join(tmpdir(), "awardping-report-lock-"));
    const lockPath = join(directory, "visual-nightly-report.lock");
    try {
      const releaseFirst = await acquireFileLock(lockPath, 1_000);
      let secondAcquired = false;
      const second = acquireFileLock(lockPath, 1_000).then((release) => {
        secondAcquired = true;
        return release;
      });
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      expect(secondAcquired).toBe(false);
      releaseFirst();
      const releaseSecond = await second;
      expect(secondAcquired).toBe(true);
      releaseSecond();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("skips a fresh-install false alarm before 6 PM and reports a total launch failure after grace", () => {
    const directory = mkdtempSync(join(tmpdir(), "awardping-report-cli-"));
    const cli = resolve(import.meta.dirname, "report-visual-nightly.mjs");
    try {
      writeFileSync(join(
        directory,
        "visual-snapshot-run-2026-07-14T23-00-00-000Z-manual.json",
      ), JSON.stringify({
        started_at: "2026-07-14T23:00:00.000Z",
        status: "succeeded",
        options: { shard_count: 3, shard_index: 0, run_trigger: "manual" },
      }), "utf8");
      const beforeDue = spawnSync(process.execPath, [
        cli,
        "--reports-dir", directory,
        "--now=2026-07-15T17:00:00.000Z",
        "--write=true",
      ], { encoding: "utf8" });
      expect(beforeDue.status).toBe(0);
      expect(beforeDue.stdout).toContain("No 6 PM scan is due yet");
      expect(existsSync(join(directory, "visual-nightly-report-latest.json"))).toBe(false);

      const afterGrace = spawnSync(process.execPath, [
        cli,
        "--reports-dir", directory,
        "--now=2026-07-16T00:05:00.000Z",
        "--write=true",
      ], { encoding: "utf8" });
      expect(afterGrace.status).toBe(0);
      const report = JSON.parse(readFileSync(
        join(directory, "visual-nightly-report-2026-07-15.json"),
        "utf8",
      ));
      expect(report).toMatchObject({
        status: "incomplete",
        missing_shards: [1, 2, 3],
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not let a historical rebuild replace the latest nightly report", () => {
    expect(shouldReplaceLatestNightlyReport(
      { monitoring_date: "2026-07-15" },
      { monitoring_date: "2026-07-14" },
    )).toBe(false);
    expect(shouldReplaceLatestNightlyReport(
      { monitoring_date: "2026-07-15" },
      { monitoring_date: "2026-07-15" },
    )).toBe(true);
  });

  it("requires all three canonical shards and reports missing shards", () => {
    const report = buildNightlyVisualReport([
      shardReport(0),
      shardReport(2),
    ], { monitoringDate: "2026-07-14", generatedAt: "2026-07-15T00:00:00.000Z" });

    expect(report).toMatchObject({
      status: "incomplete",
      expected_shards: 3,
      observed_shards: 2,
      missing_shards: [2],
    });
    expect(report.summary).toContain("Missing shard 2");
    expect(report.failure_groups).toEqual([
      expect.objectContaining({ code: "missing_shard", count: 1 }),
    ]);
    expect(report.repair_plan.actions[0]).toMatchObject({
      repair_code: "inspect_task_then_start_missing_shard",
      affected_count: 1,
    });
  });

  it("synthesizes a repairable report when no shard launches", () => {
    const report = buildNightlyVisualReport([], {
      monitoringDate: "2026-07-14",
      generatedAt: "2026-07-15T01:00:00.000Z",
    });

    expect(report).toMatchObject({
      status: "incomplete",
      observed_shards: 0,
      missing_shards: [1, 2, 3],
    });
    expect(report.failure_groups).toEqual([
      expect.objectContaining({ code: "missing_shard", count: 3 }),
    ]);
  });

  it("distinguishes a live shard heartbeat from a stalled shard", () => {
    const fresh = shardReport(0, {
      status: "running",
      finished_at: null,
      heartbeat_at: "2026-07-15T00:55:00.000Z",
    });
    const liveReport = buildNightlyVisualReport([fresh, shardReport(1), shardReport(2)], {
      monitoringDate: "2026-07-14",
      generatedAt: "2026-07-15T01:00:00.000Z",
    });
    expect(liveReport.status).toBe("running");
    expect(liveReport.shards[0]).toMatchObject({ stalled: false, operational_status: "running" });

    const stalledReport = buildNightlyVisualReport([fresh, shardReport(1), shardReport(2)], {
      monitoringDate: "2026-07-14",
      generatedAt: "2026-07-15T01:11:00.000Z",
    });
    expect(stalledReport.status).toBe("failed");
    expect(stalledReport.shards[0]).toMatchObject({ stalled: true, operational_status: "failed" });
    expect(stalledReport.failure_groups).toContainEqual(
      expect.objectContaining({ code: "stalled_shard", count: 1 }),
    );
  });

  it("reports a complete triad with any failure as degraded and aggregates solutions", () => {
    const report = buildNightlyVisualReport([
      shardReport(0, {
        checked: 98,
        failed: 2,
        errors: [
          { source_id: "a", message: "Page load failed with HTTP 429" },
          { source_id: "b", message: "Page load failed with HTTP 429" },
        ],
      }),
      shardReport(1),
      shardReport(2),
    ], { monitoringDate: "2026-07-14", generatedAt: "2026-07-15T00:00:00.000Z" });

    expect(report).toMatchObject({
      status: "degraded",
      expected_shards: 3,
      completed_shards: 3,
      missing_shards: [],
      totals: {
        loaded_sources: 300,
        pages_captured: 298,
        source_failures: 2,
      },
    });
    expect(report.failure_groups).toEqual([
      expect.objectContaining({ code: "rate_limited", count: 2 }),
    ]);
    expect(report.repair_plan.actions[0]).toMatchObject({
      repair_code: "backoff_then_retry",
      affected_count: 2,
    });
  });

  it("keeps only the newest attempt for each shard", () => {
    const olderFailure = shardReport(0, {
      started_at: "2026-07-14T23:00:00.000Z",
      finished_at: "2026-07-14T23:10:00.000Z",
      status: "failed",
      checked: 0,
      failed: 1,
      errors: [{ message: "Supabase request failed" }],
    });
    const retry = shardReport(0, {
      started_at: "2026-07-15T00:00:00.000Z",
      finished_at: "2026-07-15T00:20:00.000Z",
    });
    const report = buildNightlyVisualReport([
      olderFailure,
      retry,
      shardReport(1),
      shardReport(2),
    ], { monitoringDate: "2026-07-14" });

    expect(report.status).toBe("healthy");
    expect(report.shards).toHaveLength(3);
    expect(report.totals.source_failures).toBe(0);
  });

  it("does not let a later untagged catch-up cohort replace the scheduled triad", () => {
    const catchup = [0, 1, 2].map((shardIndex) => shardReport(shardIndex, {
      started_at: `2026-07-15T04:43:0${shardIndex}.000Z`,
      finished_at: `2026-07-15T04:50:0${shardIndex}.000Z`,
      checked: shardIndex === 0 ? 10 : 0,
      options: {
        ...shardReport(shardIndex).options,
        run_trigger: "",
      },
    }));
    const report = buildNightlyVisualReport([
      shardReport(0),
      shardReport(1),
      shardReport(2),
      ...catchup,
    ], { monitoringDate: "2026-07-14" });

    expect(report).toMatchObject({
      status: "healthy",
      observed_shards: 3,
      totals: { pages_captured: 300 },
    });
  });

  it("retains legacy untagged shards launched during the actual 6 PM hour", () => {
    const legacyScheduled = [0, 1, 2].map((shardIndex) => {
      const report = shardReport(shardIndex);
      report.options.run_trigger = "";
      return report;
    });

    expect(buildNightlyVisualReport(legacyScheduled, {
      monitoringDate: "2026-07-14",
    })).toMatchObject({
      status: "healthy",
      observed_shards: 3,
      totals: { pages_captured: 300 },
    });
  });

  it("excludes manual and maintenance shard runs from the scheduled nightly cohort", () => {
    const manual = shardReport(0);
    manual.options.run_trigger = "manual";
    const maintenance = shardReport(1);
    maintenance.options.run_trigger = "maintenance";
    const scheduled = shardReport(2);

    const report = buildNightlyVisualReport([manual, maintenance, scheduled], {
      monitoringDate: "2026-07-14",
    });

    expect(report.observed_shards).toBe(1);
    expect(report.missing_shards).toEqual([1, 2]);
  });
});
