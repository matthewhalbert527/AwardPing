import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../", import.meta.url);

function read(relativePath) {
  return readFileSync(new URL(relativePath, root), "utf8");
}

describe("retired user-level monitor checker", () => {
  it("does not expose or smoke-test the retired cron route", () => {
    expect(existsSync(new URL("src/app/api/cron/check-monitors/route.ts", root))).toBe(false);

    const launchCheck = read("scripts/check-private-beta.mjs");
    const smoke = read("scripts/smoke-private-beta.mjs");

    expect(launchCheck).not.toContain("/api/cron/check-monitors");
    expect(smoke).not.toContain("/api/cron/check-monitors");
    expect(launchCheck).toContain('/api/cron/send-digests');
    expect(smoke).toContain('/api/cron/send-digests');
  });

  it("uses shared-source, worker, and lane state for operations health", () => {
    const ops = read("src/app/dashboard/ops/page.tsx");

    expect(ops).not.toContain('.from("monitors")');
    expect(ops).not.toContain('job_name === "check-monitors"');
    expect(ops).not.toContain("Monitor errors");
    expect(ops).not.toContain('label="Due now"');
    expect(ops).toContain('.from("shared_award_sources")');
    expect(ops).toContain('rpc("list_monitoring_downstream_lane_status")');
    expect(ops).toContain("Downstream lanes");
    expect(ops).not.toContain('lastWorkerRun?.status || "running"');
  });

  it("documents the local worker as the monitoring authority", () => {
    const readme = read("README.md");
    const launchRunbook = read("docs/private-beta-launch.md");

    expect(readme).not.toContain("monitor and digest cron routes");
    expect(readme).toContain("local 6 PM visual-capture shards");
    expect(launchRunbook).not.toContain("due monitor/digest work");
    expect(launchRunbook).toContain("Historical user-level monitor timestamps and errors are not worker health signals.");
  });
});
