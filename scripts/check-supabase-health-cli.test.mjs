import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// check-supabase-health.mjs must exit nonzero whenever its reported health
// result is unhealthy, so a caller that judges only the child exit code
// (run-awardping-maintenance's blockOnFailure health phase, the one-time
// catchup) cannot mistake an unreachable database for a healthy one.
//
// This suite spawns the CLI only into its guaranteed no-client missing-config
// branch: a unique, definitely nonexistent --env path, with both Supabase
// env vars explicitly blanked in the child so no developer config and no
// network request are possible. The configured-result branch is pinned
// structurally below instead, without creating a client or a network mock.

const scriptPath = resolve(import.meta.dirname, "check-supabase-health.mjs");
const source = readFileSync(scriptPath, "utf8").replace(/\r\n?/g, "\n");

describe("check-supabase-health CLI exit status", () => {
  it("exits 1 and reports missing_supabase_config when Supabase credentials are absent", () => {
    const uniqueMissingEnvPath = `definitely-nonexistent-env-${Date.now()}-${Math.random().toString(36).slice(2)}.local`;
    const result = spawnSync(process.execPath, [scriptPath, `--env=${uniqueMissingEnvPath}`], {
      cwd: resolve(import.meta.dirname, ".."),
      encoding: "utf8",
      env: {
        ...process.env,
        NEXT_PUBLIC_SUPABASE_URL: "",
        SUPABASE_SERVICE_ROLE_KEY: "",
      },
      timeout: 10_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    const health = JSON.parse(result.stdout);
    expect(health).toEqual({
      ok: false,
      reason: "missing_supabase_config",
      message: "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.",
    });
  });

  it("derives exit status from health.ok on the configured-result path, computed once for both branches", () => {
    // Both branches assign to the same `health` binding, printed once, with
    // one common exit-status line after that print - never a per-branch
    // console.log or exitCode assignment.
    expect(source.match(/console\.log\(JSON\.stringify\(health, null, 2\)\);/g)).toHaveLength(1);
    expect(source.match(/process\.exitCode\s*=/g)).toHaveLength(1);
    const printIndex = source.indexOf("console.log(JSON.stringify(health, null, 2));");
    const exitIndex = source.indexOf("process.exitCode =");
    expect(printIndex).toBeGreaterThan(0);
    expect(exitIndex).toBeGreaterThan(printIndex);

    // The predicate itself: extract the assigned expression as a pure
    // function of a health object and prove it treats ok:true as the only
    // success case, with every ok:false shape (missing config, or an
    // awaited checkSupabaseHealth query/timeout/network failure) mapped to
    // a nonzero exit - no live client or network request involved.
    const assignmentLine = source.slice(exitIndex, source.indexOf(";", exitIndex) + 1);
    const expression = assignmentLine.match(/^process\.exitCode\s*=\s*(.+);$/)?.[1];
    expect(expression, `exit-status expression: ${assignmentLine}`).toBeTruthy();
    const computeExitCode = new Function("health", `return (${expression});`);
    expect(computeExitCode({ ok: true, reason: "ok", message: "Supabase is reachable." })).toBe(0);
    expect(computeExitCode({ ok: false, reason: "missing_supabase_config", message: "x" })).toBe(1);
    expect(computeExitCode({ ok: false, reason: "query_failed", message: "x" })).toBe(1);
    expect(computeExitCode({ ok: false, reason: "timed_out", message: "x" })).toBe(1);
    expect(computeExitCode({ ok: false })).toBe(1);
  });
});
