import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(
    import.meta.dirname,
    "../supabase/migrations/20260803184500_fix_stage1_activation_failure_counter.sql",
  ),
  "utf8",
);

describe("Stage 1 activation failure counter migration", () => {
  it("repairs exactly one schema-qualified GREATEST expression and fails closed", () => {
    expect(migration).toContain(
      "'public.fail_stage1_source_baseline_activation(uuid,uuid,uuid,text,jsonb)'::regprocedure",
    );
    expect(migration).toContain(
      "'pg_catalog.greatest(source.consecutive_failures, 1)'",
    );
    expect(migration).toContain("'greatest(source.consecutive_failures, 1)'");
    expect(migration).toContain("does not contain exactly one expected broken GREATEST expression");
    expect(migration).toContain("execute v_updated");
  });

  it("preserves service-only execution and contains no transaction control", () => {
    expect(migration).toContain("service-only failure RPC");
    expect(migration).toContain(
      "revoke all on function public.fail_stage1_source_baseline_activation(",
    );
    expect(migration).toContain("grant execute on function public.fail_stage1_source_baseline_activation(");
    expect(migration).not.toMatch(/^\s*(?:begin|commit|rollback)\s*;/imu);
  });
});
