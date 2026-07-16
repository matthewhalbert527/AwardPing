import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  commandForDownstreamLane,
  downstreamLaneDefinitions,
  laneClaimRpcParameters,
  laneCompletionRpcParameters,
  laneExecutionFailureReason,
  normalizeDownstreamLaneKey,
} from "./run-downstream-lane.mjs";

describe("independent downstream lane runner", () => {
  it("defines exactly two paid-review commands and six no-cost operational commands", () => {
    expect(Object.keys(downstreamLaneDefinitions)).toEqual([
      "new_page_review",
      "changed_page_review",
      "feedback_promotion",
      "suppression",
      "reconciliation",
      "page_audit",
      "manual_quarantine",
      "nightly_report",
    ]);
  });

  it("uses deterministic page auditing and never the paid Gemini page-audit worker", () => {
    const command = commandForDownstreamLane("page-audit");
    expect(command.args[0]).toMatch(/evaluate-public-page-audit-canaries\.mjs$/);
    expect(command.args.join(" ")).not.toContain("process-page-audit-batch");
    expect(command.args.join(" ")).not.toContain("--submit=true");
  });

  it("normalizes task-friendly lane keys and bounds the new-page child budget", () => {
    expect(normalizeDownstreamLaneKey("New-Page-Review")).toBe("new_page_review");
    const command = commandForDownstreamLane("new-page-review", { timeBudgetMs: 600_000 });
    expect(command.args).toContain("--time-budget-ms=585000");
  });

  it("uses the exact lane claim and completion RPC contracts", () => {
    expect(
      laneClaimRpcParameters({
        laneKey: "suppression",
        workerSource: "worker-1",
        metadata: { worker_revision: "abc" },
      }),
    ).toEqual({
      p_lane_key: "suppression",
      p_worker_source: "worker-1",
      p_worker_run_id: null,
      p_metadata: { worker_revision: "abc" },
    });

    expect(
      laneCompletionRpcParameters({
        laneKey: "suppression",
        runId: "run-1",
        claimToken: "claim-1",
        succeeded: true,
        result: { status: "succeeded" },
      }),
    ).toEqual({
      p_lane_key: "suppression",
      p_run_id: "run-1",
      p_claim_token: "claim-1",
      p_succeeded: true,
      p_result: { status: "succeeded" },
      p_error: null,
    });
  });

  it("terminates the full Windows process tree when a lane times out", () => {
    const source = readFileSync(resolve(import.meta.dirname, "run-downstream-lane.mjs"), "utf8");
    expect(source).toContain('spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"]');
    expect(source).toContain('detached: process.platform !== "win32"');
    expect(source).toContain("process.kill(-child.pid, signal)");
  });

  it("records actionable timeout and child-exit failure reasons", () => {
    expect(laneExecutionFailureReason({
      result: { exitCode: 1, timedOut: true },
      timeBudgetMs: 585_000,
    })).toBe("lane_timed_out_after_585000ms");
    expect(laneExecutionFailureReason({
      result: { exitCode: 7, timedOut: false, aborted: false, error: null },
    })).toBe("child_exit_code_7");
  });

  it("fails closed and terminates the child when the lane heartbeat loses its lease", () => {
    const source = readFileSync(resolve(import.meta.dirname, "run-downstream-lane.mjs"), "utf8");
    expect(source).toContain("heartbeatStatus?.heartbeat !== true");
    expect(source).toContain("executionAbort.abort(heartbeatError)");
    expect(source).toContain('status = result.timedOut');
    expect(source).toContain('"lease_lost"');
    expect(source).toContain('signal?.addEventListener("abort", abortHandler');
  });
});
