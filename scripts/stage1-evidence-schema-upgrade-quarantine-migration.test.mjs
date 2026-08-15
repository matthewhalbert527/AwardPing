import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadModule, parseSync } from "libpg-query";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/20260814211159_stage1_evidence_schema_upgrade_failure_quarantine.sql",
    import.meta.url,
  ),
  "utf8",
);
const smoke = readFileSync(
  new URL(
    "../supabase/tests/stage1_evidence_schema_upgrade_failure_quarantine_smoke.sql",
    import.meta.url,
  ),
  "utf8",
);

const rpcStart = migration.indexOf(
  "create function public.quarantine_stage1_evidence_schema_upgrade_failure(",
);
const rpcEnd = migration.indexOf(
  "alter function public.quarantine_stage1_evidence_schema_upgrade_failure(",
  rpcStart,
);
const rpc = migration.slice(rpcStart, rpcEnd);

describe("Stage 1 evidence-schema-upgrade quarantine migration", () => {
  it("is parseable PostgreSQL and adds no migration-time application rows", async () => {
    await loadModule();
    expect(() => parseSync(migration)).not.toThrow();
    expect(() => parseSync(smoke)).not.toThrow();
    expect(rpcStart).toBeGreaterThanOrEqual(0);
    expect(rpcEnd).toBeGreaterThan(rpcStart);
    expect(migration.match(/create function public\./giu)).toHaveLength(1);
    expect(migration.slice(0, rpcStart)).not.toMatch(
      /^\s*(?:insert|update|delete|truncate)\b/imu,
    );
  });

  it("creates an append-only private failure audit with exact content seals", () => {
    for (const contract of [
      "create table private.stage1_evidence_schema_upgrade_failures",
      "submitted_evidence_sha256 text not null unique",
      "stage1_evidence_schema_upgrade_failure_hash_check",
      "stage1_evidence_schema_upgrade_failure_evidence_seal_check",
      "private.stage1_evidence_schema_upgrade_quarantine_json_sha256(evidence)",
      "prevent_stage1_evidence_schema_upgrade_failure_mutation",
      "before update or delete",
      "enable row level security",
      "for select to service_role using (true)",
      "for insert to service_role with check (true)",
      "grant select, insert on table",
    ]) {
      expect(migration).toContain(contract);
    }
    expect(migration).not.toMatch(
      /grant\s+(?:all|update|delete|truncate).*stage1_evidence_schema_upgrade_failures/isu,
    );
  });

  it("keeps the exposed RPC service-role-only and SECURITY INVOKER", () => {
    expect(rpc).toMatch(
      /returns jsonb\s+language plpgsql\s+volatile\s+security invoker\s+set search_path = ''/iu,
    );
    expect(rpc).not.toMatch(/security definer/iu);
    expect(migration).toContain(
      "alter function public.quarantine_stage1_evidence_schema_upgrade_failure(\n  uuid, uuid, uuid, text, jsonb\n) owner to postgres;",
    );
    expect(migration).toContain(
      "revoke all on function public.quarantine_stage1_evidence_schema_upgrade_failure(\n  uuid, uuid, uuid, text, jsonb\n) from public, anon, authenticated, service_role;",
    );
    expect(migration).toContain(
      "grant execute on function public.quarantine_stage1_evidence_schema_upgrade_failure(\n  uuid, uuid, uuid, text, jsonb\n) to service_role;",
    );
    expect(migration).toContain("and not target.prosecdef");
    expect(migration).toContain("privilege.grantee = 0");
  });

  it("confines the two definer helpers to private canonical and byte hashing", () => {
    const definers = migration.match(/security definer/giu) ?? [];
    expect(definers).toHaveLength(2);
    expect(migration).toMatch(
      /create function private\.stage1_evidence_schema_upgrade_quarantine_json_sha256\([\s\S]*?security definer[\s\S]*?set search_path = ''/iu,
    );
    expect(migration).toContain(
      "revoke all on function\n  private.stage1_evidence_schema_upgrade_quarantine_json_sha256(jsonb)\nfrom public, anon, authenticated, service_role;",
    );
    expect(migration).toContain(
      "grant execute on function\n  private.stage1_evidence_schema_upgrade_quarantine_json_sha256(jsonb)\nto service_role;",
    );
    expect(migration).toMatch(
      /create function private\.stage1_evidence_schema_upgrade_quarantine_base64_sha256\([\s\S]*?security definer[\s\S]*?set search_path = ''/iu,
    );
    expect(migration).toContain(
      "private.stage1_evidence_schema_upgrade_quarantine_json_domain_valid",
    );
  });

  it("requires the exact reviewed-nine manifest, disposition bundle, and finalization", () => {
    for (const digest of [
      "f2a16adec57b3a66c3e467599bbf962cf02c94d1f6ded1daf5db09bf980c0184",
      "8a1c1d9aa8ccbdf1dcdbb7b2f4b83ac19c99dd9557a8949dff5f63dd22d1026f",
      "a3825703fd736cea3ca38a3294a7d0378c94316b828820ee138336ecc6777acb",
      "b967506e8cb67f1f9315d9b9ece9a5a8bd658e34bb5452c769e801c8f7703866",
    ]) {
      expect(rpc).toContain(digest);
    }
    for (const sourceId of [
      "c30778fe-43d7-57be-842a-e046d84baaee",
      "2ea41875-5c88-5794-81b3-afa8ddaf31c1",
      "af1367b5-0cb0-5b21-8e78-7dc195dd996f",
      "b9407ce4-71f8-5c97-8f98-8466d640d4de",
      "5ec9a453-fd62-53e5-b885-726b21ce7247",
      "fa4088a7-706e-4ad3-ae12-3653751dd5e1",
      "664d38ba-c717-5d51-b7ce-9e3a27f41fec",
      "719ffd9e-f97c-5c6d-8a5a-71b617cadf49",
      "c28878c0-6a8b-5fa8-b99b-ec826b86d8f2",
    ]) {
      expect(rpc).toContain(`when '${sourceId}'::uuid`);
    }
    expect(rpc).not.toContain("c5961d93-9f1f-504e-8dd4-c4ec06a833a2");
    expect(rpc).toContain("item.decision = 'approve_baseline_only'");
    expect(rpc).toContain("private.stage1_source_baseline_activation_finalizations");
    expect(rpc).toContain("v_finalization.finalization_receipt_sha256");
  });

  it("validates and seals every applicable evidence layer", () => {
    for (const contract of [
      "p_evidence - 'evidence_sha256'",
      "v_validation",
      "p_evidence ->> 'validation_sha256'",
      "awardping.stage1.evidence-schema-upgrade-validation.v1",
      "v_r2 - 'receipt_sha256'",
      "pointer_identity', 'pointer_sha256",
      "previous_pointer', 'projection_sha256",
      "p_evidence ->> 'r2_binding_sha256'",
      "p_evidence ->> 'candidate_artifacts_sha256'",
      "candidate-artifact bindings are malformed, duplicated, unsorted, or not exactly pointer bound",
      "v_validation #>> array['evidence', 'kind'] is distinct from",
      "v_validation #>> array['evidence', 'capture', 'captured_at']",
      "v_validation #> array['evidence', 'capture', 'text_hash']",
      "v_validation #> array['evidence', 'capture', 'image_hash']",
      "v_validation #> array['evidence', 'capture', 'file_hash']",
      "v_validation #> array['evidence', 'capture', 'layout_hash']",
      "'candidate_signature'",
      "before_candidate_enqueue",
      "fresh_observation_only",
      "observed_candidate_identity",
      "v_expected_safe_action",
      "reconcile the exact visual-review candidate signature",
      "awardping.stage1.evidence-schema-upgrade-mutation-accounting.v1",
      "v_mutation_failure ->> 'operation' = 'candidate_enqueue'",
      "v_mutation_failure ->> 'operation' = 'pointer_commit'",
      "v_mutation_accounting - 'accounting_sha256'",
      "pg_catalog.jsonb_typeof(category.value) <> 'string'",
      "journal_read_unavailable",
      "durable_upgrade_journal_read_unavailable",
      "v_journal_read_absent",
      "verified_absent",
      "v_recovery <> 'null'::jsonb",
      "awardping.visual-snapshot.pointer-identity.v1",
      "awardping.capture-retained-artifact-projection.v1",
      "visual-snapshots/sources/",
      "artifact_bindings_schema",
      "p_evidence ->> 'commit_recovery_sha256'",
      "recovery_required",
      "invalid journal identity, history, candidate pointer, or seal",
      "candidate-baseline bytes are not exactly sealed",
      "evidence_availability",
      "creates_api_charge' is distinct from 'false'::jsonb",
      "public_fact_authority' is distinct from 'false'::jsonb",
      "public_award_update_created' is distinct from",
    ]) {
      expect(rpc.toLowerCase()).toContain(contract.toLowerCase());
    }
  });

  it("performs the audit, source hold, and quarantine upsert in one RPC transaction", () => {
    const audit = rpc.indexOf(
      "insert into private.stage1_evidence_schema_upgrade_failures",
    );
    const hold = rpc.indexOf("update public.shared_award_sources source", audit);
    const quarantine = rpc.indexOf(
      "insert into public.manual_quarantine_registry",
      hold,
    );
    const receipt = rpc.indexOf("v_receipt :=", quarantine);
    expect(audit).toBeGreaterThanOrEqual(0);
    expect(hold).toBeGreaterThan(audit);
    expect(quarantine).toBeGreaterThan(hold);
    expect(receipt).toBeGreaterThan(quarantine);
    expect(rpc).toContain("stage1_evidence_schema_upgrade_failed:");
    expect(rpc).toContain("stage1-evidence-schema-upgrade-quarantine");
    expect(rpc).toContain("'stage1:evidence-schema-upgrade:' || p_source_id::text");
    expect(rpc).toContain("'Stage 1 evidence-schema upgrade failed'");
    expect(rpc).toContain("'awardping-stage1-evidence-schema-upgrade-quarantine'");
    expect(rpc).toContain("retry_charge = 'none'");
    expect(rpc).toContain("terminal_failure_count = 1");
    expect(rpc).not.toContain(
      "public.manual_quarantine_registry.terminal_failure_count\n      + case when v_audit_inserted then 1 else 0 end",
    );
    expect(rpc).toContain("case when v_audit_inserted then 1 else 0 end");
  });

  it("returns a sealed exact zero-charge receipt", () => {
    for (const field of [
      "schema_version",
      "status",
      "quarantine_id",
      "failure_sha256",
      "evidence_sha256",
      "shared_award_source_id",
      "source_acquisition_id",
      "source_page_request_id",
      "reason_code",
      "failure_stage",
      "mutation_count_scope",
      "mutation_counts",
      "release_safety",
      "source_reheld",
      "audit_inserted",
      "creates_api_charge",
      "public_fact_authority",
      "public_award_update_created",
      "recorded_at",
      "observed_at",
    ]) {
      expect(rpc).toContain(`'${field}'`);
    }
    expect(rpc).toContain("'receipt_sha256', v_receipt_sha256");
    expect(rpc).toContain(
      "awardping.stage1.evidence-schema-upgrade-quarantine-receipt.v1",
    );
  });

  it("uses global-first locks, allows owned reason evolution, and counts safety triggers honestly", () => {
    const globalLock = rpc.indexOf("'stage1-national-25-release'");
    const operationLock = rpc.indexOf(
      "'stage1-evidence-schema-upgrade-quarantine:'",
      globalLock,
    );
    const sourceLock = rpc.indexOf("for update of source", operationLock);
    expect(globalLock).toBeGreaterThanOrEqual(0);
    expect(operationLock).toBeGreaterThan(globalLock);
    expect(sourceLock).toBeGreaterThan(operationLock);
    for (const contract of [
      "stage1_evidence_schema_upgrade_failed:%",
      "v_source.admin_reviewed_at is distinct from v_finalization.finalized_at",
      "v_finalization.receipt ->> 'status' is distinct from 'finalized_open'",
      "v_observed_at := pg_catalog.clock_timestamp()",
      "stage1_award_publication_event_writes",
      "stage1_release_event_writes",
      "manual_quarantine_backlog_state_writes",
      "'database_writes', v_database_writes",
      "'quarantine_writes', 3",
      "'mutation_count_scope', 'quarantine_rpc_only'",
    ]) {
      expect(rpc).toContain(contract);
    }
  });

  it("smokes role boundaries and proves rejected calls have exact zero delta", () => {
    for (const contract of [
      "set role anon;",
      "set role authenticated;",
      "set role service_role;",
      "exception when insufficient_privilege",
      "exception when sqlstate '22023'",
      "The service role did not reach the exact quarantine evidence validator.",
      "awardping_stage1_upgrade_quarantine_smoke_baseline",
      "stage1_evidence_schema_upgrade_has_exact_keys(jsonb,text[])",
      "v_exact_keys_oid",
      "p_value jsonb, p_keys text[]",
      "source_state_sha256",
      "scaled_integer",
      "v_after is distinct from v_before",
      "Rejected Stage 1 evidence-schema-upgrade quarantine calls changed application state.",
    ]) {
      expect(smoke).toContain(contract);
    }
    expect(smoke.match(/reset role;/gu)).toHaveLength(3);
  });
});
