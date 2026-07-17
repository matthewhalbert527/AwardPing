import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/20260716214500_stage1_reviewed_promotion.sql",
    import.meta.url,
  ),
  "utf8",
);
const applyFunction = migration.slice(
  migration.indexOf(
    "create or replace function public.apply_stage1_reviewed_promotion(",
  ),
  migration.indexOf(
    "revoke all on function public.apply_stage1_reviewed_promotion(",
  ),
);
const promotionTableLock = applyFunction.slice(
  applyFunction.indexOf("lock table"),
  applyFunction.indexOf("in share mode;") + "in share mode;".length,
);
const cli = readFileSync(
  new URL("./promote-stage1-cohort.mjs", import.meta.url),
  "utf8",
);

describe("Stage 1 reviewed promotion migration", () => {
  it("exposes a read-only evidence snapshot and a service-only apply RPC", () => {
    expect(migration).toContain(
      "create or replace function public.get_stage1_promotion_review_snapshot(",
    );
    expect(migration).toContain("private.stage1_promotion_review_snapshot");
    expect(migration).toContain("'bound_sources'");
    expect(migration).toContain("'bound_candidates'");
    expect(migration).toContain("'reconciled_fact_evidence'");
    expect(migration).toContain("'actionable_quarantine'");
    expect(migration).toContain(
      "grant execute on function public.get_stage1_promotion_review_snapshot(text[])\n  to service_role;",
    );
    expect(migration).toContain(
      ") from public, anon, authenticated, service_role;\ngrant execute on function public.apply_stage1_reviewed_promotion(",
    );
  });

  it("rejects stale, duplicate, partial, and incomplete promotion requests", () => {
    expect(applyFunction).toContain("v_target_count not in (1, 25)");
    expect(applyFunction).toContain("v_target_count <> cardinality");
    expect(applyFunction).toContain("v_cohort_keys is distinct from v_all_cohort_keys");
    expect(applyFunction).toContain("pg_catalog.pg_advisory_xact_lock");
    expect(applyFunction.indexOf("stage1-national-25-release")).toBeLessThan(
      applyFunction.indexOf("awardping:stage1-promotion:"),
    );
    expect(applyFunction.indexOf("awardping:stage1-promotion:")).toBeLessThan(
      applyFunction.indexOf("lock table"),
    );
    expect(
      applyFunction.indexOf("'stage1-national-25-release'"),
    ).toBeLessThan(
      applyFunction.indexOf("'awardping:stage1-promotion:'"),
    );
    expect(
      applyFunction.indexOf("'stage1-national-25-release'"),
    ).toBeLessThan(applyFunction.indexOf("lock table"));
    expect(applyFunction).toContain("pg_catalog.set_config('lock_timeout', '10s', true)");
    expect(promotionTableLock).not.toContain("public.stage1_award_registry");
    expect(promotionTableLock).not.toContain("public.stage1_award_source_manifest");
    expect(promotionTableLock).not.toContain("public.shared_award_sources");
    expect(applyFunction).toContain("public.shared_award_fact_candidates,");
    expect(applyFunction).toContain("public.manual_quarantine_registry");
    expect(applyFunction).toContain("for update;");
    expect(applyFunction).toContain("v_actual_hash is distinct from v_expected_hash");
    expect(applyFunction).toContain("errcode = '40001'");
    expect(applyFunction).toContain(
      "Expected review hashes must contain exactly one key for every requested cohort and no extras.",
    );
    expect(applyFunction).toContain("v_manifest_count <> v_target_count * 8");
    expect(applyFunction).toContain("v_distinct_manifest_count <> v_manifest_count");
    expect(applyFunction).toContain("contains duplicate source UUIDs");
  });

  it("uses validated manifest and award transitions without activating the public release", () => {
    expect(applyFunction).toContain(
      "perform public.set_stage1_award_manifest_entry(",
    );
    expect(applyFunction).toContain(
      "perform public.transition_stage1_award_publication(",
    );
    expect(applyFunction).not.toContain(
      "perform public.transition_stage1_cohort_release(",
    );
    expect(applyFunction).not.toMatch(/update\s+public\.stage1_award_registry/i);
    expect(applyFunction).not.toMatch(/insert\s+into\s+public\.stage1_award_source_manifest/i);
    expect(applyFunction).toContain("p_actor");
    expect(applyFunction).toContain("p_reason");
    expect(applyFunction).toContain("p_policy_version");
  });

  it("keeps dry-run read-only and requires the reviewed hash before the apply RPC", () => {
    const confirmationIndex = cli.lastIndexOf(
      "assertStage1PromotionConfirmation(plan, args[\"confirm-hash\"])",
    );
    const applyIndex = cli.indexOf('"apply_stage1_reviewed_promotion"');
    expect(confirmationIndex).toBeGreaterThan(0);
    expect(applyIndex).toBeGreaterThan(confirmationIndex);
    expect(cli).toContain("if (!apply)");
    expect(cli).toContain("remote_mutations: 0");
    expect(cli).toContain("apply_blocked_before_mutation");
    expect(cli).toContain("database_commit_status");
  });
});
