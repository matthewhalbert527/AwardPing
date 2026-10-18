import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  bindLaneFailureReceipt,
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
    expect(command.args).toContain("--env=.env.worker.local");
    expect(command.args).not.toContain("--env");
    expect(command.args.join(" ")).not.toContain("process-page-audit-batch");
    expect(command.args.join(" ")).not.toContain("--submit=true");
  });

  it("explicitly authorizes mutation for the scheduled quarantine sync", () => {
    const command = commandForDownstreamLane("manual-quarantine");

    expect(command.args[0]).toMatch(/sync-manual-quarantine-registry\.mjs$/);
    expect(command.args).toContain("--apply=true");
  });

  it("makes the scheduled --all page audit rotate a bounded full-catalog batch", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "evaluate-public-page-audit-canaries.mjs"),
      "utf8",
    );

    expect(source).toContain('supabase.rpc("list_shared_awards_for_regression_audit"');
    expect(source).toContain("p_include_deferred: dryRun || slugs.length > 0");
    expect(source).toContain("await persistAuditResult(award, reconciliation, audit)");
    expect(source).toContain('supabase.rpc("record_shared_award_regression_audit"');
    expect(source).toContain("observation_only: true");
    expect(source).toContain("applied_to_public: false");
    expect(source).not.toContain("async function publishReconciledFacts");
    expect(source).not.toContain("public_facts: reconciliation.selectedFacts");
    expect(source).not.toContain("last_structure_scan_at");
    expect(source).not.toContain("structure_scan_error");
    expect(source).toContain("record_shared_award_regression_audit_attempt_failure");
    expect(source).toContain('report.status = "succeeded_with_deferred_failures"');
  });

  it("normalizes task-friendly lane keys and bounds the new-page child budget", () => {
    expect(normalizeDownstreamLaneKey("New-Page-Review")).toBe("new_page_review");
    const command = commandForDownstreamLane("new-page-review", { timeBudgetMs: 600_000 });
    expect(command.args[0]).toMatch(/process-new-page-review-lane\.mjs$/);
    expect(command.args).toContain("--time-budget-ms=585000");
    const changed = commandForDownstreamLane("changed-page-review");
    expect(changed.args[0]).toMatch(/process-visual-review-batch\.mjs$/);
    expect(changed.args).toContain("--paid-lane=changed_page_review");
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
    expect(laneExecutionFailureReason({
      result: {
        exitCode: 1,
        timedOut: false,
        aborted: false,
        error: null,
        failureReceipt: { failure_code: "database_statement_timeout" },
      },
    })).toBe("lane_child_failure:database_statement_timeout");
  });

  it("binds structured child failures to the lane that actually ran", () => {
    const receipt = {
      lane_key: "manual_quarantine",
      failure_code: "database_statement_timeout",
    };
    expect(bindLaneFailureReceipt("manual-quarantine", receipt)).toEqual({
      receipt,
      error: null,
    });
    expect(bindLaneFailureReceipt("suppression", receipt)).toEqual({
      receipt: null,
      error: "failure_receipt_lane_mismatch:manual_quarantine",
    });
  });

  it("fails closed when a child emits a bound failure receipt even if it exits zero", () => {
    const source = readFileSync(resolve(import.meta.dirname, "run-downstream-lane.mjs"), "utf8");
    expect(source).toContain("!heartbeatError && !result.failureReceipt");
    expect(laneExecutionFailureReason({
      result: {
        exitCode: 0,
        timedOut: false,
        aborted: false,
        error: null,
        failureReceipt: { failure_code: "registry_sync_failed" },
      },
    })).toBe("lane_child_failure:registry_sync_failed");
  });

  it("fails closed and terminates the child when the lane heartbeat loses its lease", () => {
    const source = readFileSync(resolve(import.meta.dirname, "run-downstream-lane.mjs"), "utf8");
    expect(source).toContain("heartbeatStatus?.heartbeat !== true");
    expect(source).toContain("executionAbort.abort(heartbeatError)");
    expect(source).toContain('status = result.timedOut');
    expect(source).toContain('"lease_lost"');
    expect(source).toContain('signal?.addEventListener("abort", abortHandler');
  });

  it("closes its shared Supabase transport before the scheduled process exits", () => {
    const source = readFileSync(resolve(import.meta.dirname, "run-downstream-lane.mjs"), "utf8");
    expect(source).toContain("await closeSupabaseServiceTransport();");
    expect(source).toContain("try {\n    await main();\n  } finally {");
  });

  it("tees child output while retaining only a bounded structured stderr receipt", () => {
    const source = readFileSync(resolve(import.meta.dirname, "run-downstream-lane.mjs"), "utf8");
    expect(source).toContain('stdio: ["ignore", "pipe", "pipe"]');
    expect(source).toContain("child.stderr?.pipe(process.stderr, { end: false })");
    expect(source).toContain("appendBoundedTail(stderrTail, chunk, 32_768)");
    expect(source).toContain("failureReceipt: parseLaneFailureReceipt(stderrTail)");
  });
});
