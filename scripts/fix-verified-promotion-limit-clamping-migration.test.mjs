import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/20260716055058_fix_verified_promotion_limit_clamping.sql",
    import.meta.url,
  ),
  "utf8",
);

const repairedSignatures = [
  "public.list_monitoring_feedback_promotion_clusters(integer,boolean)",
  "public.list_monitoring_feedback_promotion_worker_queue(integer)",
  "public.checkpoint_monitoring_feedback_promotion_sweep(uuid,bigint,text,text,text,timestamptz,uuid,bigint,timestamptz,timestamptz)",
];

describe("verified promotion limit-clamping forward migration", () => {
  it("targets only the three reviewed SECURITY DEFINER functions", () => {
    for (const signature of repairedSignatures) {
      expect(migration).toContain(`'${signature}'`);
    }
    expect(migration).toContain("procedure.prosecdef");
    expect(migration).toContain("procedure.proconfig");
    expect(migration).toContain("'search_path=\"\"' = any(v_config)");
    expect(migration).toContain(
      "v_expected_least constant integer[] := array[1, 1, 0]",
    );
    expect(migration).toContain(
      "v_expected_greatest constant integer[] := array[1, 1, 1]",
    );
  });

  it("replaces every invalid qualified special expression and fails closed", () => {
    expect(migration).toContain(
      "pg_catalog.replace(v_definition, v_qualified_least, 'least(')",
    );
    expect(migration).toContain("'greatest('");
    expect(migration).toContain(
      "promotion clamp repair shape changed for % (least %, greatest %)",
    );
    expect(migration).toContain("promotion clamp repair was incomplete for %");
    expect(migration).toContain("required promotion function is missing: %");
    expect(migration).toContain("execute v_patched_definition;");
  });

  it("qualifies the worker lease conflict and returned column", () => {
    expect(migration).toContain(
      "'on conflict on constraint monitoring_feedback_promotion_worker_leases_pkey'",
    );
    expect(migration).toContain("'returning lease.cluster_id'");
    expect(migration).toContain(
      "promotion worker lease qualification shape changed",
    );
  });

  it("reasserts service-role-only execution for every repaired function", () => {
    for (const functionName of [
      "list_monitoring_feedback_promotion_clusters",
      "list_monitoring_feedback_promotion_worker_queue",
      "checkpoint_monitoring_feedback_promotion_sweep",
    ]) {
      expect(migration).toContain(
        `revoke execute on function public.${functionName}(`,
      );
      expect(migration).toContain(
        `grant execute on function public.${functionName}(`,
      );
    }
    expect(migration.match(/from public, anon, authenticated;/g)).toHaveLength(3);
    expect(migration.match(/to service_role;/g)).toHaveLength(3);
  });
});
