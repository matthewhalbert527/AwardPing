import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/20260717101505_fix_stage1_release_gate_worker_run_composite.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("Stage 1 release gate composite-row migration", () => {
  it("retains the exact table composite and changes only the health-call boundary", () => {
    expect(migration).toContain("run as worker_run");
    expect(migration).toContain(
      "private.stage1_6pm_shard_healthy(latest_runs.worker_run)",
    );
    expect(migration).toContain(
      "private.stage1_6pm_shard_healthy(latest_runs)",
    );
    expect(migration).toContain("v_old_base_count <> 1");
    expect(migration).toContain("v_old_health_count <> 1");
    expect(migration).toContain("execute v_updated_definition");
  });

  it("fails closed unless the known-bad definition is an exact one-time match", () => {
    expect(migration).toContain("pg_catalog.pg_get_functiondef");
    expect(migration).toContain("errcode = '42883'");
    expect(migration.match(/errcode = '55000'/g)).toHaveLength(3);
    expect(migration).toContain(
      "did not match the exact known-bad composite-row contract",
    );
    expect(migration).toContain(
      "did not preserve its definition and security contract",
    );
  });

  it("preserves ownership, ACL, volatility, SECURITY DEFINER, and search_path", () => {
    for (const contract of [
      "procedure.proowner = v_owner",
      "procedure.proacl is not distinct from v_acl",
      "procedure.prosecdef = v_security_definer",
      "procedure.provolatile = v_volatility",
      "procedure.proconfig is not distinct from v_proconfig",
      "procedure.prosecdef",
      "procedure.provolatile = 'v'",
      "search_path=\"\"",
    ]) {
      expect(migration).toContain(contract);
    }
    expect(migration).toMatch(
      /revoke all on function private\.stage1_release_gate_snapshot\(timestamptz\)[\s\S]*from public, anon, authenticated, service_role;/,
    );
    for (const role of ["anon", "authenticated", "service_role"]) {
      expect(migration).toContain(`'${role}',`);
    }
  });
});
