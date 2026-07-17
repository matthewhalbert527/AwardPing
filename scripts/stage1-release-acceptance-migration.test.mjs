import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/20260716224000_stage1_release_acceptance.sql",
    import.meta.url,
  ),
  "utf8",
);
const promotion = readFileSync(
  new URL(
    "../supabase/migrations/20260716214500_stage1_reviewed_promotion.sql",
    import.meta.url,
  ),
  "utf8",
);

function functionBody(name) {
  const match = migration.match(
    new RegExp(`create or replace function ${name}\\([\\s\\S]*?\\n\\$\\$;`, "i"),
  );
  expect(match, `${name} should exist`).toBeTruthy();
  return match[0];
}

describe("Stage 1 release acceptance migration", () => {
  it("separates five immutable proof kinds into signed external and DB-derived producers", () => {
    for (const kind of [
      "hosted_runtime_identity",
      "rollback_drill",
      "non_cohort_leak_crawl",
      "r2_recovery_drill",
      "visual_crop_coverage",
    ]) {
      expect(migration).toContain(`'${kind}'`);
    }
    expect(migration).toContain("producer_kind in ('external_signed', 'database_derived')");
    expect(migration).toContain("stage1_release_acceptance_artifacts_immutable");
    expect(migration).toContain("stage1_release_acceptance_links_immutable");
    expect(migration).not.toContain("public.record_stage1_release_acceptance_artifact(");
  });

  it("uses Vault-backed HMACs and gives service_role no signer or secret path", () => {
    expect(migration).toContain("private.stage1_release_evidence_signers");
    expect(migration).toContain("vault.decrypted_secrets");
    expect(migration).toContain("private.stage1_release_hmac_sha256");
    expect(migration).toContain("private.stage1_release_artifact_signature_valid");
    expect(migration).toContain(
      "revoke all on table private.stage1_release_evidence_signers",
    );
    expect(migration).not.toMatch(
      /grant\s+(?:select|insert|update|delete|all)[\s\S]{0,100}private\.stage1_release_evidence_signers[\s\S]{0,40}service_role/i,
    );
    expect(functionBody("private.insert_stage1_external_release_artifact")).toContain(
      "External artifact signature verification failed.",
    );
  });

  it("binds every external proof to one direct-admin-owned production target", () => {
    expect(migration).toContain("private.stage1_release_production_targets");
    expect(migration).toContain(
      "revoke all on table private.stage1_release_production_targets",
    );
    expect(migration).not.toMatch(
      /grant\s+(?:select|insert|update|delete|all)[\s\S]{0,100}private\.stage1_release_production_targets[\s\S]{0,40}service_role/i,
    );
    expect(migration).not.toMatch(
      /insert\s+into\s+private\.stage1_release_production_targets/i,
    );
    const target = functionBody(
      "private.stage1_release_production_target_snapshot",
    );
    for (const identity of [
      "app_origin",
      "supabase_origin",
      "supabase_project_ref",
      "deployment_project_id",
      "deployment_team_slug",
      "r2_account_id",
      "r2_bucket",
    ]) {
      expect(target).toContain(`'${identity}'`);
    }
    expect(migration).toContain("target_config_version bigint not null");
    expect(migration).toContain("target_config_hash text not null");
    expect(functionBody("private.stage1_release_artifact_signature_valid")).toContain(
      "private.stage1_release_evidence_matches_target",
    );
  });

  it("offers only kind-specific producer preflights and pins producer source hashes", () => {
    expect(migration).not.toContain(
      "public.get_stage1_release_external_signing_payload",
    );
    expect(migration).toContain("producer_source_sha256 text not null");
    for (const name of [
      "public.prepare_stage1_hosted_runtime_identity_artifact",
      "public.prepare_stage1_rollback_drill_artifact",
      "public.prepare_stage1_non_cohort_leak_crawl_artifact",
      "public.prepare_stage1_r2_recovery_drill_artifact",
    ]) {
      expect(functionBody(name)).toContain(
        "private.stage1_release_external_signing_preflight",
      );
    }
    const preflight = functionBody(
      "private.stage1_release_external_signing_preflight",
    );
    expect(preflight).toContain("signer.producer_source_sha256");
    expect(preflight).toContain("private.stage1_release_evidence_matches_target");
    expect(preflight).toContain("private.stage1_release_external_envelope_valid");
  });

  it("binds measured_at to the signed window at preflight, insert, and revalidation", () => {
    const envelope = functionBody(
      "private.stage1_release_external_envelope_valid",
    );
    expect(envelope).toContain("(p_evidence ->> 'measured_at')::timestamptz");
    expect(envelope).toContain("p_started_at - interval '5 minutes'");
    expect(envelope).toContain("p_completed_at + interval '5 minutes'");
    for (const name of [
      "private.stage1_release_external_signing_preflight",
      "private.insert_stage1_external_release_artifact",
      "private.stage1_release_artifact_signature_valid",
    ]) {
      expect(functionBody(name)).toContain(
        "private.stage1_release_external_envelope_valid",
      );
    }
    expect(envelope).toContain("else false");
    for (const name of [
      "private.stage1_release_external_signing_preflight",
      "private.insert_stage1_external_release_artifact",
    ]) {
      const body = functionBody(name);
      expect(body).toContain(
        "when 'non_cohort_leak_crawl' then interval '24 hours'",
      );
      expect(body).toContain(
        "when 'r2_recovery_drill' then interval '24 hours'",
      );
      expect(body).toContain("when 'rollback_drill' then interval '7 days'");
    }
  });

  it("uses the exact Supabase origin for the hosted Auth settings probe", () => {
    const evidenceContract = functionBody(
      "private.stage1_release_artifact_evidence_valid",
    );
    const recorder = functionBody(
      "public.record_stage1_hosted_runtime_identity_artifact",
    );
    expect(evidenceContract).toContain(
      "p_evidence ->> 'supabase_origin' || '/auth/v1/settings'",
    );
    expect(recorder).toContain(
      "pg_catalog.rtrim(p_evidence ->> 'supabase_origin', '/') || '/auth/v1/settings'",
    );
    expect(recorder).not.toContain(
      "pg_catalog.rtrim(p_evidence ->> 'base_url', '/') || '/auth/v1/settings'",
    );
  });

  it("makes a newer validly signed failure supersede an older passing proof", () => {
    const current = functionBody(
      "private.stage1_current_valid_release_artifact",
    );
    expect(current).toContain("pg_catalog.row_number() over");
    expect(current).toContain(
      "order by artifact.completed_at desc, artifact.id desc",
    );
    expect(current).toContain("where candidate.recency_rank = 1");
    const recencyIndex = current.indexOf("where candidate.recency_rank = 1");
    const passIndex = current.indexOf("where latest.status = 'passed'");
    expect(recencyIndex).toBeGreaterThan(0);
    expect(passIndex).toBeGreaterThan(recencyIndex);
    expect(current.slice(0, recencyIndex)).not.toContain(
      "artifact.status = 'passed'",
    );
    expect(current.slice(0, recencyIndex)).not.toContain(
      "artifact.valid_until > p_evaluated_at",
    );
    expect(current).toContain("latest.valid_until > p_evaluated_at");
    expect(current).toContain("private.stage1_release_artifact_signature_valid");
  });

  it("exposes only kind-specific signed recorders and derives crop coverage from event rows", () => {
    for (const name of [
      "public.record_stage1_hosted_runtime_identity_artifact",
      "public.record_stage1_rollback_drill_artifact",
      "public.record_stage1_non_cohort_leak_crawl_artifact",
      "public.record_stage1_r2_recovery_drill_artifact",
    ]) {
      expect(functionBody(name)).toContain("private.insert_stage1_external_release_artifact");
    }
    const cropRecorder = functionBody(
      "public.record_stage1_visual_crop_coverage_artifact",
    );
    expect(cropRecorder).toContain("private.stage1_visual_crop_coverage_snapshot()");
    expect(cropRecorder).toContain("producer_kind");
    expect(cropRecorder).toContain("'database_derived'");
    expect(cropRecorder).not.toContain("p_evidence");

    const coverage = functionBody("private.stage1_visual_crop_coverage_snapshot");
    expect(coverage).toContain("shared_award_change_event_visual_evidence");
    expect(coverage).toContain("visual-event-evidence-v2");
    expect(coverage).toContain("visual-exact-text-binding-v2");
    expect(coverage).toContain("{sides,previous,algorithm_version}");
    expect(coverage).toContain("{sides,current,algorithm_version}");
    expect(coverage).toContain("{sides,previous,semantic_binding,algorithm_version}");
    expect(coverage).toContain("{sides,current,semantic_binding,algorithm_version}");
    expect(coverage).toContain("{crop,semantic_binding_sha256}");
    expect(coverage).toContain("private.stage1_visual_event_has_semantic_side");
    expect(coverage).toContain("crop_verified");
    expect(coverage).toContain("pdf_evidence_failures");
  });

  it("builds acceptance from a DB-owned snapshot instead of caller assertions", () => {
    const recorder = functionBody("public.record_stage1_release_acceptance");
    expect(recorder).toContain("private.stage1_release_gate_snapshot(v_now)");
    expect(recorder).toContain("p_expected_gate_state_hash");
    expect(recorder).toContain("v_summary ->> 'state' <> 'READY'");
    expect(recorder).toContain("gate_state_hash");
    expect(recorder).not.toContain("p_summary");
    expect(migration).toContain("expires_at <= generated_at + interval '15 minutes'");
  });

  it("derives every feasible release gate from durable database evidence", () => {
    const gate = functionBody("private.stage1_release_gate_snapshot");
    for (const required of [
      "public.stage1_effective_publication_reason(",
      "public.manual_quarantine_registry",
      "public.office_invite_security_reissues",
      "public.get_awardping_release_contract_status()",
      "pg_catalog.has_function_privilege",
      "public.local_worker_runs",
      "public.list_gemini_budget_status()",
      "public.list_monitoring_downstream_lane_status()",
      "private.stage1_visual_crop_coverage_snapshot()",
      "private.stage1_visual_r2_object_set_snapshot()",
    ]) {
      expect(gate).toContain(required);
    }
    expect(gate).toContain("v_ready_count <> 25");
    expect(gate).toContain("v_quarantine_count <> 0");
    expect(gate).toContain("v_invite_reissue_count <> 0");
    expect(gate).toContain("v_budget_count = 2 and v_budget_valid_count = 2");
    expect(gate).toContain("v_lane_count = 8 and v_lane_valid_count = 8");
  });

  it("requires normal 6 PM identities, exact inventories, three cohorts, and a 24-hour soak", () => {
    const identity = functionBody("private.stage1_normal_6pm_monitoring_date");
    for (const exclusion of [
      "baseline_refresh",
      "localization_repair",
      "source_id",
      "historical_onboarding",
      "skip_existing_baseline",
    ]) {
      expect(identity).toContain(exclusion);
    }
    const inventory = functionBody("private.stage1_6pm_inventory_proof_valid");
    expect(inventory).toContain("global_source_ids_sha256");
    expect(inventory).toContain("loaded_shard_source_ids_sha256");
    expect(inventory).toContain("proof_complete");

    const gate = functionBody("private.stage1_release_gate_snapshot");
    expect(gate).toContain("'required_acceptance_cohorts', 3");
    expect(gate).toContain("v_now - finished_at >= interval '24 hours'");
    expect(gate).toContain("'healthy_required_calendar_dates' = '4'");
    expect(gate).toContain("'app_worker_identity_mismatches' = '0'");
    expect(gate).toContain("'r2_enabled_current_shards' = '3'");
  });

  it("recomputes the complete gate and revalidates each linked proof at activation", () => {
    const activation = functionBody("public.activate_stage1_release_from_acceptance");
    expect(activation).toContain("private.stage1_release_gate_snapshot(v_now)");
    expect(activation).toContain("v_current ->> 'state' <> 'READY'");
    expect(activation).toContain("v_acceptance.gate_state_hash");
    expect(activation).toContain("private.stage1_release_artifact_signature_valid");
    expect(activation).toContain("private.stage1_release_artifact_evidence_valid");
    expect(activation).toContain("public.transition_stage1_cohort_release(");
  });

  it("makes acceptance activation the only service-role upgrade path", () => {
    expect(promotion).not.toContain("perform public.transition_stage1_cohort_release(");
    expect(migration).toContain("activate_stage1_release_from_acceptance");
    expect(migration).toContain(
      "revoke execute on function public.transition_stage1_cohort_release(",
    );
    expect(migration).toContain("from service_role;");
    expect(migration).toContain("public.suspend_stage1_release(");
  });
});
