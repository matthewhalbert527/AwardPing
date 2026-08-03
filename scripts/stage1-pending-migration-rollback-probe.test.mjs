import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  renderStage1PendingMigrationRollbackProbe,
  STAGE1_PENDING_MIGRATIONS,
} from "./render-stage1-pending-migration-rollback-probe.mjs";

describe("Stage 1 pending migration rollback probe renderer", () => {
  const sql = renderStage1PendingMigrationRollbackProbe();

  it("embeds each exact pending migration once and in order", () => {
    expect(STAGE1_PENDING_MIGRATIONS).toEqual([
      "20260717070000_incremental_manual_quarantine_sync.sql",
      "20260717071500_stage1_regression_audit_observations.sql",
      "20260717073548_reconciliation_disposition_atomicity.sql",
      "20260717101505_fix_stage1_release_gate_worker_run_composite.sql",
      "20260717105043_harden_stage1_vault_service_role.sql",
      "20260717113112_preserve_legacy_personal_data_for_reentry.sql",
      "20260717114500_rhodes_us_source_identity_fence.sql",
      "20260717114600_gilman_source_identity_fence.sql",
      "20260717121500_source_cleanup_compare_and_swap.sql",
      "20260717123000_legacy_contact_ciphertext_quarantine.sql",
      "20260717133922_durable_stage1_verification_epoch.sql",
      "20260717144500_stage1_reviewed_candidate_import.sql",
      "20260717150000_reviewed_stage1_reconciliation.sql",
      "20260717153000_hertz_ndseg_canonical_authority.sql",
    ]);
    let prior = -1;
    for (const name of STAGE1_PENDING_MIGRATIONS) {
      const start = sql.indexOf(`-- BEGIN EXACT MIGRATION ${name}`);
      expect(start).toBeGreaterThan(prior);
      expect(
        sql.match(new RegExp(`BEGIN EXACT MIGRATION ${name}`, "g")),
      ).toHaveLength(1);
      const exactSql = readFileSync(
        new URL(`../supabase/migrations/${name}`, import.meta.url),
        "utf8",
      )
        .trim()
        .replace(/\r\n/g, "\n");
      const sha256 = createHash("sha256")
        .update(exactSql, "utf8")
        .digest("hex");
      expect(sql).toContain(
        `-- BEGIN EXACT MIGRATION ${name} sha256=${sha256}\n${exactSql}\n` +
          `-- END EXACT MIGRATION ${name}`,
      );
      prior = start;
    }
    expect(sql).not.toContain("__AWARDPING_PENDING_MIGRATIONS__");
    expect(sql).toContain("14 as exact_migration_count");
    expect(sql.endsWith("\n")).toBe(true);
    expect(sql).not.toContain("\r");
  });

  it("wraps all fixture writes in an explicit rollback and checks post-state", () => {
    const applyStart = sql.indexOf("-- MIGRATION TRANSACTION START");
    const rollback = sql.indexOf("rollback;\n-- MIGRATION TRANSACTION END");
    const postcheck = sql.indexOf("-- POST-ROLLBACK VERIFICATION START");
    expect(applyStart).toBeGreaterThan(-1);
    expect(rollback).toBeGreaterThan(applyStart);
    expect(postcheck).toBeGreaterThan(rollback);
    expect(sql).toContain(
      "awardping_stage1_pending_migration_rollback_probe_passed",
    );
    expect(sql.slice(applyStart, rollback)).not.toMatch(/^\s*commit\s*;/m);
  });

  it("executes and immediately rolls back real privacy RPC behavior fixtures", () => {
    const contract = sql.slice(
      sql.indexOf("do $privacy_rpc_contract$"),
      sql.indexOf("$privacy_rpc_contract$;")
        + "$privacy_rpc_contract$;".length,
    );
    for (const expected of [
      "public.quarantine_legacy_contact_ciphertext(",
      "public.recover_legacy_contact_ciphertext(",
      "public.get_personal_data_legacy_contact_export(",
      "public.erase_personal_data_for_privacy_request(",
      "privacy-app-data-erasure-v1",
      "public.awardping_sha256_text(v_marker_basis)",
      "canonical subscriber recovery did not scrub and resolve every linked outbox",
      "a prior privacy tombstone did not defeat later legacy recovery",
      "legacy recovery did not fail closed around an active provider lease",
      "exception when sqlstate 'AP001'",
      "exception when sqlstate 'AP002'",
    ]) {
      expect(contract).toContain(expected);
    }
    expect(contract.indexOf("details -> 'app_data_erasure' = v_marker")).toBeLessThan(
      contract.indexOf("rollback privacy RPC behavior fixtures"),
    );
    expect(contract).toContain(
      "privacy RPC behavior fixture subtransaction did not roll back cleanly",
    );
    expect(contract).toContain(
      "active-lease privacy fixture or temporary constraint change leaked state",
    );
  });

  it("executes the optimized quarantine sync twice without replay drift", () => {
    const contract = sql.slice(
      sql.indexOf("do $quarantine_incremental_contract$"),
      sql.indexOf("$quarantine_incremental_contract$;")
        + "$quarantine_incremental_contract$;".length,
    );
    expect(contract.match(/public\.sync_manual_quarantine_registry\(\)/g)).toHaveLength(2);
    expect(contract).toContain("v_events_after_second = v_events_after_first");
    expect(contract).toContain("v_rows_after_second = v_rows_after_first");
    expect(contract).toContain(
      "v_backlog_revision_after_second = v_backlog_revision_after_first",
    );
    expect(contract).toContain(
      "v_backlog_updated_after_second = v_backlog_updated_after_first",
    );
    expect(contract).toContain("v_custom_after_first = v_custom_before");
    expect(contract).toContain("v_custom_after_second = v_custom_before");
    expect(sql).toContain("awardping-stage1-rollback-probe-generic-resolution");
    expect(contract).toContain("quarantine.status = 'resolved'");
    expect(contract).toContain(
      "quarantine sync did not preserve the custom NDSEG case while resolving a generic case",
    );
    expect(sql).toContain(
      "private.awardping_stage1_probe_quarantine_events_seq",
    );
    expect(sql).toContain(
      "manual-quarantine audit event sequence changed despite rollback",
    );
    expect(sql).toContain(
      "public.bump_manual_quarantine_backlog_for_changed_registry_rows()",
    );
    expect(sql.indexOf(
      "alter table public.manual_quarantine_registry_events alter column id drop identity",
    )).toBeLessThan(sql.indexOf(
      "-- BEGIN EXACT MIGRATION 20260717070000_incremental_manual_quarantine_sync.sql",
    ));
  });

  it("proves Hertz canonical migration and NDSEG delegated-authority quarantine", () => {
    const contract = sql.slice(
      sql.indexOf("do $canonical_authority_contract$"),
      sql.indexOf("$canonical_authority_contract$;")
        + "$canonical_authority_contract$;".length,
    );
    expect(contract).toContain("https://www.hertzfoundation.org/the-fellowship/");
    expect(contract).toContain("https://www.hertzfoundation.org/hertz-fellowship/");
    expect(contract).toContain("https://ndseg.org/");
    expect(contract).toContain("official_contractor_host");
    expect(contract).toContain("https://ndseg.org/apply-link");
    expect(contract).toContain("August 3, 2026");
    expect(contract).toContain("October 30, 2026 (5 PM Eastern)");
    expect(contract).toContain("August 15");
    expect(contract).toContain("November 15");
    expect(contract).toContain("stage1-national-25-v2");
    expect(contract).toContain(
      "6e7dd7ee1372671cbfb22b17b862d867145a93c7dc0b73d49afc11f504ee6c8f",
    );
    expect(contract).toContain("publication_decision' = 'not_published");
    expect(contract).toContain(
      "private.stage1_manifest_source_authority_valid(",
    );
    expect(contract).toContain(
      "exact canonical NDSEG identity_home was rejected by the authority gate",
    );
    expect(contract).toContain(
      "exact reviewed SysPlus non-identity source was rejected by the authority gate",
    );
    expect(contract).toContain(
      "an unrelated NDSEG-owned source host bypassed delegated authority",
    );
    expect(contract).toContain(
      "the SysPlus contractor source was accepted as NDSEG identity_home",
    );
    expect(contract).toContain(
      "the authoritative Stage 1 publication reason does not enforce source authority",
    );
    expect(contract).toContain("exception when sqlstate '55000'");
    expect(contract).toContain(
      "canonical-authority evidence was mutable or a failed mutation leaked state",
    );
    const postRollback = sql.slice(sql.indexOf("do $post_rollback$"));
    expect(postRollback).toContain("v_baseline.canonical_identity_rows");
    expect(postRollback).toContain("private.stage1_canonical_identity_evidence");
    expect(postRollback).toContain("private.stage1_delegated_source_authority_evidence");
    expect(postRollback).toContain(
      "private.stage1_manifest_source_authority_valid(text,text,text,text,text,jsonb)",
    );
  });

  it("probes the security, audit, CAS, invalidation, and sequence rollback contracts", () => {
    for (const contract of [
      "statement_timeout=60s",
      "relrowsecurity",
      "has_function_privilege",
      "record_shared_award_regression_audit_attempt_failure",
      "stage1-regression-evaluation-v1",
      "evaluation_revision",
      "regression selector did not return a complete immutable evaluation envelope",
      "private.invalidate_stage1_release_for_regression_audit",
      "private regression release invalidator security settings or grants changed",
      "resolved_prior_failures",
      "stage1-blocking-regression-v1",
      "stage1_invalidation",
      "ready acceptance remained activatable after the blocking regression transaction",
      "awardping_enforce_fact_candidate_status_lifecycle",
      "candidate_invalidation_contract",
      "candidate evidence invalidation was not constraint-safe and exactly once",
      "shared_award_fact_candidate_terminal_archive",
      "rejected-candidate-fk-lifecycle-v1",
      "service role can bypass candidate lifecycle triggers or owns evidence tables",
      "candidate lifecycle table ACLs did not return to their exact pre-probe state",
      "source ON DELETE SET NULL did not preserve and detach rejected evidence",
      "award ON DELETE CASCADE did not preserve rejected candidate evidence",
      "commit_award_reconciliation_blocked",
      "finish_or_requeue_award_reconciliation_claim",
      "stage1_award_publication_events",
      "stage1_publication_release_events",
      "commit_award_reconciliation_publication_unfenced_20260716221500",
      "private.stage1_6pm_shard_healthy(latest_runs.worker_run)",
      "revoke all on schema vault from public, anon, authenticated",
      "revoke all on all tables in schema vault from public, anon, authenticated",
      "$awardping_stage1_vault_function_acl_cleanup$",
      "EXECUTE WITH GRANT OPTION",
      "revoke execute on function %s from public, anon, authenticated",
      "private.stage1_vault_access_contract_safe()",
      "pg_catalog.has_schema_privilege",
      "pg_catalog.has_table_privilege",
      "pg_catalog.has_any_column_privilege",
      "pg_catalog.has_function_privilege",
      "vault_access_contract_failed",
      "{vault_security,api_surface_safe}",
      "{vault_security,service_role_data_api_profile_blocked}",
      "awardping.stage1.hosted-runtime-identity.v2",
      "direct_no_redirect_https_and_vault_profile_get_v2",
      "vault_profile_postgrest_code",
      "a later Vault regrant did not force HOLD and change the signed state hash",
      "v_baseline.vault_schema_acl",
      "v_baseline.vault_relation_acls",
      "v_baseline.vault_function_acls",
      "personal_data_legacy_ciphertext_archive",
      "personal_data_reentry_required",
      "personal_data_legacy_contact_quarantine",
      "personal_data_erasure_tombstones",
      "recover_legacy_contact_ciphertext",
      "erase_personal_data_for_privacy_request",
      "delete from public.source_page_requests",
      "delete from public.discovery_requests",
      "delete from public.alert_deliveries",
      "update public.shared_awards award",
      "update public.shared_award_sources source",
      "v_linked_outbox_ids",
      "Legacy canonical merge did not resolve every linked outbox quarantine row.",
      "public.erase_public_update_subscriber(text,text)",
      "v_baseline.legacy_erasure_acl",
      "legacy subscriber erasure ACL did not return to its exact pre-probe state",
      "legacy_contact_ciphertext_not_safe",
      "profiles_personal_data_reentry_state_check",
      "erase_personal_data_legacy_archive_for_privacy_request",
      "preserve_legacy_personal_data_archive_rows",
      "exclude_rhodes_non_us_constituencies",
      "exclude_gilman_mccain",
      "awardping-source-retirement-cas-v1",
      "Award source cleanup retirement CAS affected an unexpected row count; requeue cleanup.",
      "apply_shared_award_source_cleanup_plan",
      "manual source-retirement function did not return to its exact pre-probe state",
      "Stage 1 source-identity fence rows survived rollback",
      "Stage 1 gate did not execute to a fail-closed signed snapshot",
      "durable Stage 1 verification epoch policy changed",
      "durable timestamp or live-source freshness behavior changed",
      "immutable Stage 1 manifest source-capture binding behavior changed",
      "signed R2 proof is not isolated to national effective publication",
      "signed_r2_recovery_artifact_not_current",
      "immutable Stage 1 verification function did not return to its exact pre-probe state",
      "national effective publication function did not return to its exact pre-probe state",
      "signed release-artifact selector did not return to its exact pre-probe state",
      "visual R2 object-set function did not return to its exact pre-probe state",
      "public R2 verification-manifest function did not return to its exact pre-probe state",
      "durable Stage 1 verification helper functions survived rollback",
      "current R2 proof did not permit one exact effective public release",
      "changed R2 object set did not invalidate the still-age-valid signed proof",
      "expired R2 proof did not close public release while retaining cohort readiness",
      "v_baseline.gate_definition",
      "v_baseline.gate_proconfig",
      "v_baseline.gate_acl",
      "v_baseline.gate_oid",
      "v_baseline.gate_owner",
      "v_baseline.gate_security_definer",
      "v_baseline.gate_volatility",
      "pg_get_functiondef",
      "sequence_state",
    ]) {
      expect(sql).toContain(contract);
    }
  });

  it("resolves the service-role identity inside the schema-contract block before use", () => {
    const schemaContract = sql.slice(
      sql.indexOf("do $schema_contract$"),
      sql.indexOf("$schema_contract$;") + "$schema_contract$;".length,
    );
    const declaration = schemaContract.indexOf("v_service_role_oid oid;");
    const resolution = schemaContract.indexOf("into strict v_service_role_oid");
    const firstUse = schemaContract.indexOf("where role.oid = v_service_role_oid");
    expect(declaration).toBeGreaterThan(-1);
    expect(resolution).toBeGreaterThan(declaration);
    expect(firstUse).toBeGreaterThan(resolution);
  });

  it("checks trigger semantics from the catalog instead of rendered SQL text", () => {
    const schemaContract = sql.slice(
      sql.indexOf("do $schema_contract$"),
      sql.indexOf("$schema_contract$;") + "$schema_contract$;".length,
    );
    const triggerContract = schemaContract.slice(
      schemaContract.indexOf("candidate lifecycle trigger security settings or grants changed"),
      schemaContract.indexOf("candidate parent lock fences or archive immutability trigger changed"),
    );

    expect(triggerContract).toContain("trigger.tgtype = 10");
    expect(triggerContract).toContain("trigger.tgtype = 27");
    expect(triggerContract).toContain(
      "trigger.tgfoid = pg_catalog.to_regprocedure(\n" +
        "            'public.stage1_evidence_release_fence_before_statement()'",
    );
    expect(triggerContract).toContain(
      "trigger.tgrelid = 'public.shared_awards'::pg_catalog.regclass",
    );
    expect(triggerContract).toContain(
      "trigger.tgrelid = 'public.shared_award_sources'::pg_catalog.regclass",
    );
    expect(triggerContract).not.toContain("pg_get_triggerdef");
  });

  it("proves a later Vault regrant changes the signed gate to HOLD", () => {
    const schemaContract = sql.slice(
      sql.indexOf("do $schema_contract$"),
      sql.indexOf("$schema_contract$;") + "$schema_contract$;".length,
    );
    const safeSnapshotAt = schemaContract.indexOf(
      "v_gate_snapshot := private.stage1_release_gate_snapshot(",
    );
    const grantAt = schemaContract.indexOf(
      "grant usage on schema vault to authenticated;",
    );
    const driftSnapshotAt = schemaContract.indexOf(
      "v_gate_after_regrant := private.stage1_release_gate_snapshot(",
    );
    const holdAt = schemaContract.indexOf(
      "v_gate_after_regrant ->> 'state' = 'HOLD'",
    );
    const revokeAt = schemaContract.indexOf(
      "revoke usage on schema vault from authenticated;",
      grantAt,
    );

    expect(safeSnapshotAt).toBeGreaterThan(-1);
    expect(grantAt).toBeGreaterThan(safeSnapshotAt);
    expect(driftSnapshotAt).toBeGreaterThan(grantAt);
    expect(holdAt).toBeGreaterThan(driftSnapshotAt);
    expect(revokeAt).toBeGreaterThan(holdAt);
    expect(schemaContract).toContain(
      "v_gate_after_regrant #>> '{vault_security,api_surface_safe}' = 'false'",
    );
    expect(schemaContract).toContain(
      `@> '["vault_access_contract_failed"]'::jsonb`,
    );
    expect(schemaContract).toContain("<> v_gate_snapshot ->> 'state_hash'");
    expect(sql.slice(sql.indexOf("do $post_rollback$"))).toContain(
      "'private.stage1_vault_access_contract_safe()'\n      ) is null",
    );
  });

  it("proves a blocking regression immediately closes publication and acceptance", () => {
    const regression = sql.slice(
      sql.indexOf("do $regression_contract$"),
      sql.indexOf("$regression_contract$;") + "$regression_contract$;".length,
    );
    const readyAcceptanceAt = regression.indexOf(
      "insert into public.stage1_release_acceptance_records",
    );
    const blockingRpcAt = regression.indexOf(
      "v_result_1 := public.record_shared_award_regression_audit(",
    );
    const atomicAssertionAt = regression.indexOf(
      "'blocking regression did not atomically invalidate publication, acceptance, and provenance'",
    );
    const rejectedActivationAt = regression.indexOf(
      "perform public.activate_stage1_release_from_acceptance(",
    );

    expect(readyAcceptanceAt).toBeGreaterThan(-1);
    expect(blockingRpcAt).toBeGreaterThan(readyAcceptanceAt);
    expect(atomicAssertionAt).toBeGreaterThan(blockingRpcAt);
    expect(rejectedActivationAt).toBeGreaterThan(atomicAssertionAt);
    expect(regression).toContain("stage1-blocking-regression-v1");
    expect(regression).toContain("v_evaluation ->> 'revision'");
    expect(regression).toContain("'evaluation_source_count'");
    expect(regression).toContain("v_evaluation_selected_at - interval '4 minutes'");
    expect(
      regression.match(/'YYYY-MM-DD"T"HH24:MI:SS\.US"Z"'/g),
    ).toHaveLength(3);
    expect(regression).toContain("stage1_effective_publication_reason(");
    expect(regression).toContain("= 'state_revalidation_pending'");
    expect(regression).toContain("acceptance.status = 'rejected'");
    expect(regression).toContain(
      "registry.fact_ledger_batch_id is not distinct from",
    );
    expect(regression).toContain("{deterministic_publication,page_audit_id}");
    expect(regression).toContain("{deterministic_publication,audit_kind}");
    expect(regression).toContain("{regression,audit_kind}");
    expect(regression).toContain("{regression,observation_key}");
    expect(regression).toContain("v_activation_blocked");
    expect(regression).not.toContain("sync_manual_quarantine");
  });

  it("executes reviewed Stage 1 success while rejecting a pre-shaped direct-core bypass", () => {
    const contract = sql.slice(
      sql.indexOf("do $reviewed_reconciliation_contract$"),
      sql.indexOf("$reviewed_reconciliation_contract$;") +
        "$reviewed_reconciliation_contract$;".length,
    );
    const automaticAt = contract.indexOf(
      "perform public.commit_award_reconciliation_publication(",
    );
    const automaticRejectedAt = contract.indexOf(
      "pre-shaped direct core success bypassed private-root enforcement or left partial writes",
    );
    const reviewedAt = contract.indexOf(
      "public.commit_reviewed_stage1_reconciliation_publication(",
    );
    const reviewedPassedAt = contract.indexOf(
      "reviewed Stage 1 wrapper did not pass its trigger with exact root-bound evidence",
    );

    expect(automaticAt).toBeGreaterThan(-1);
    expect(automaticRejectedAt).toBeGreaterThan(automaticAt);
    expect(reviewedAt).toBeGreaterThan(automaticRejectedAt);
    expect(reviewedPassedAt).toBeGreaterThan(reviewedAt);
    expect(contract).toContain("exception when sqlstate '23514'");
    expect(contract).toContain(
      "Pre-shaped direct core rootless bypass must fail.",
    );
    expect(contract).toContain(
      "public.import_reviewed_stage1_fact_candidates(",
    );
    expect(contract).toContain(
      "reviewed candidate import did not retain alias source ownership with canonical durable proof",
    );
    expect(contract).toContain("'shared_award_id', v_source.shared_award_id");
    expect(contract).toContain("item.canonical_shared_award_id = v_award.id");
    expect(contract).toContain(
      "candidate.shared_award_id = v_source.shared_award_id",
    );
    expect(contract).toContain(
      "reviewed candidate import replay rejected an exact selected lifecycle row",
    );
    expect(contract).toContain("private.stage1_reviewed_candidate_import_bundles");
    expect(contract).toContain("private.stage1_reviewed_candidate_import_items");
    expect(contract).toContain("candidate_import");
    expect(contract).toContain("stage1_review_root_schema_version");
    expect(contract).toContain("stage1_review_root_sha256");
    expect(contract).toContain("replacement_summary_sha256");
    expect(contract).toContain("replacement_confidence_sha256");
    expect(contract).toContain("stage1_reviewed_summary_sha256");
    expect(contract).toContain("stage1_reviewed_confidence_sha256");
    expect(contract).toContain("stage1_reviewed_public_facts_sha256");
    expect(contract).toContain("stage1_reviewed_evidence_rows_sha256");
    expect(contract).toContain("stage1_reviewed_audit_row_sha256");
    expect(contract).toContain("v_audit_projection :=");
    expect(contract).toContain(
      "private.stage1_reviewed_audit_row_sha256(v_audit)",
    );
    expect(contract).toContain(
      "Rebind the signed\n  -- evidence hash and audit signature",
    );
    expect(contract).toContain(
      "audit.public_page_snapshot -\n              'reconciliation_audit_signature'",
    );
    expect(contract).toContain(
      "v_root_hash := private.stage1_canonical_json_sha256(v_review_root)",
    );
    expect(contract).toContain(
      "server did not recompute the exact canonical human-review root hash",
    );
    expect(contract).toContain("review_source_ids");
    expect(contract).toContain("official_identity");
    expect(contract).toContain("reviewed_contributor_source_ids");
    expect(contract).toContain("reviewed_candidate_ids");
    expect(contract).not.toContain("manifest_mapping_sha256");
    expect(sql).toContain("statement_timestamp() - interval '30 days'");
    expect(contract).toContain(
      "reviewed reconciliation fixture did not separate live checks from durable capture evidence",
    );
    expect(contract).toContain("private.stage1_human_review_roots");
    expect(contract).toContain("stage1_human_review_roots_service_read");
    expect(contract).toContain(
      "reviewed wrapper accepted a colliding immutable human-review root",
    );
    expect(contract).toContain(
      "failed reviewed commit retained its inserted root or queue metadata",
    );
    expect(contract).toContain(
      "Reviewed wrapper accepted a generic evidence quote.",
    );
    expect(contract).toContain(
      "Reviewed wrapper accepted a missing immutable marker.",
    );
    expect(contract).toContain(
      "Reviewed wrapper accepted a candidate under the wrong role.",
    );
    expect(contract).toContain(
      "Reviewed wrapper accepted a direct candidate composition index.",
    );
    expect(contract).toContain("v_generic_quote_rejected");
    expect(contract).toContain("v_missing_marker_rejected");
    expect(contract).toContain("v_wrong_role_rejected");
    expect(contract).toContain("v_wrong_order_rejected");
    expect(contract).toContain("v_projection_rejected");
    expect(contract).toContain("v_audit_projection_rejected");
    expect(contract).toContain("Unsigned summary substitution must fail.");
    expect(contract).toContain("'{severity}'");
    expect(contract).toContain(
      "reviewed candidate negative checks accepted a substitution or leaked partial writes",
    );
    expect(contract).toContain(
      "exact immutable human-review root was not inserted and readable",
    );
    expect(contract).toContain(
      "service recovery reader did not return an exact hash-matched root or null for missing evidence",
    );
    expect(contract).toContain(
      "service recovery reader accepted an invalid root hash",
    );
    expect(contract).toContain(
      "immutable human-review root registry allowed update or delete",
    );
    expect(contract).toContain(
      "public.get_stage1_human_review_root(v_root_hash)",
    );
    expect(contract).toContain("exception when sqlstate '55000'");
    expect(sql.slice(sql.indexOf("do $post_rollback$"))).toContain(
      "reviewed Stage 1 import/reconciliation function, registry, ledger, or trigger survived rollback",
    );
    expect(sql.slice(sql.indexOf("do $post_rollback$"))).toContain(
      "'public.import_reviewed_stage1_fact_candidates(jsonb,text)'",
    );
    expect(sql.slice(sql.indexOf("do $post_rollback$"))).toContain(
      "'private.stage1_reviewed_candidate_import_bundles'",
    );
    expect(sql.slice(sql.indexOf("do $post_rollback$"))).toContain(
      "'private.stage1_reviewed_candidate_import_items'",
    );
    expect(sql.slice(sql.indexOf("do $post_rollback$"))).toContain(
      "'private.stage1_canonical_json_sha256(jsonb)'\n      ) is null",
    );
    expect(sql.slice(sql.indexOf("do $post_rollback$"))).toContain(
      "'public.get_stage1_human_review_root(text)'\n      ) is null",
    );
    expect(sql.slice(sql.indexOf("do $post_rollback$"))).toContain(
      "'private.stage1_human_review_roots'\n      ) is null",
    );
  });

  it("proves R2 expiry closes only national visibility, not reviewed cohort readiness", () => {
    const contract = sql.slice(
      sql.indexOf("do $durable_epoch_release_contract$"),
      sql.indexOf("$durable_epoch_release_contract$;") +
        "$durable_epoch_release_contract$;".length,
    );
    const currentAt = contract.indexOf(
      "'awardping.stage1_probe_r2_current', 'on', true",
    );
    const currentAssertionAt = contract.indexOf(
      "'current R2 proof did not permit one exact effective public release'",
    );
    const expiredAt = contract.indexOf(
      "'awardping.stage1_probe_r2_current', 'off', true",
    );
    const driftAssertionAt = contract.indexOf(
      "'changed R2 object set did not invalidate the still-age-valid signed proof'",
    );
    const expiredAssertionAt = contract.indexOf(
      "'expired R2 proof did not close public release while retaining cohort readiness'",
    );

    expect(currentAt).toBeGreaterThan(-1);
    expect(currentAssertionAt).toBeGreaterThan(currentAt);
    expect(driftAssertionAt).toBeGreaterThan(currentAssertionAt);
    expect(expiredAt).toBeGreaterThan(driftAssertionAt);
    expect(expiredAssertionAt).toBeGreaterThan(expiredAt);
    expect(contract).toContain("v_ready_count = 25");
    expect(contract).toContain("v_visible_count = 25");
    expect(contract).toContain("v_visible_count = 0");
    expect(contract).toContain(
      "'signed_r2_recovery_artifact_not_current'",
    );
    expect(contract).toContain(
      "v_snapshot #>> '{release,ready_cohort_count}' = '25'",
    );
  });

  it("requires every candidate and terminal invalidation probe to clear its release epoch", () => {
    expect(
      sql.match(
        /publication_state = 'revalidation_pending' and release_epoch is null/g,
      ),
    ).toHaveLength(4);
    expect(
      sql.match(
        /release_state = 'revalidation_pending' and release_epoch is null/g,
      ),
    ).toHaveLength(4);
  });

  it("proves rejected evidence survives source and award FK lifecycle actions", () => {
    const lifecycle = sql.slice(
      sql.indexOf("do $candidate_fk_lifecycle_contract$"),
      sql.indexOf("$candidate_fk_lifecycle_contract$;") +
        "$candidate_fk_lifecycle_contract$;".length,
    );
    const directDetachAt = lifecycle.indexOf(
      "update public.shared_award_fact_candidates\n" +
        "    set shared_award_source_id = null",
    );
    const sourceDeleteAt = lifecycle.indexOf(
      "delete from public.shared_award_sources source",
    );
    const sourceArchiveAssertionAt = lifecycle.indexOf(
      "'source ON DELETE SET NULL did not preserve and detach rejected evidence'",
    );
    const awardDeleteAt = lifecycle.indexOf(
      "delete from public.shared_awards award",
    );
    const awardArchiveAssertionAt = lifecycle.indexOf(
      "'award ON DELETE CASCADE did not preserve rejected candidate evidence'",
    );

    expect(directDetachAt).toBeGreaterThan(-1);
    expect(sourceDeleteAt).toBeGreaterThan(directDetachAt);
    expect(sourceArchiveAssertionAt).toBeGreaterThan(sourceDeleteAt);
    expect(awardDeleteAt).toBeGreaterThan(sourceArchiveAssertionAt);
    expect(awardArchiveAssertionAt).toBeGreaterThan(awardDeleteAt);
    expect(lifecycle).toContain(
      "archive.candidate_snapshot = v_source_candidate_before",
    );
    expect(lifecycle).toContain(
      "archive.candidate_snapshot = v_award_candidate_before",
    );
    expect(lifecycle).toContain(
      "public.stage1_publication_evidence_hash(\n              archive.candidate_snapshot",
    );
    expect(lifecycle).toContain("archive.trigger_depth > 1");
    expect(lifecycle).toContain("'terminal candidate archive was mutable'");
    expect(lifecycle).toContain("'terminal candidate archive was deletable'");
  });

  it("restores the production digest trigger before every synthetic outcome RPC", () => {
    const outcome = sql.slice(
      sql.indexOf("do $stage1_outcome_contract$"),
      sql.indexOf("$stage1_outcome_contract$;"),
    );
    const disable =
      "disable trigger supersede_stale_public_digest_reservations_on_release_trigger;";
    const enable =
      "enable trigger supersede_stale_public_digest_reservations_on_release_trigger;";
    const parts = outcome.split(disable);

    expect(parts).toHaveLength(4);
    expect(outcome.match(new RegExp(enable, "g"))).toHaveLength(3);
    for (const afterDisable of parts.slice(1)) {
      const enableAt = afterDisable.indexOf(enable);
      const blockedRpcAt = afterDisable.indexOf(
        "public.commit_award_reconciliation_blocked(",
      );
      const finishRpcAt = afterDisable.indexOf(
        "public.finish_or_requeue_award_reconciliation_claim(",
      );
      const rpcAt = [blockedRpcAt, finishRpcAt]
        .filter((index) => index >= 0)
        .sort((left, right) => left - right)[0];
      expect(enableAt).toBeGreaterThan(-1);
      expect(rpcAt).toBeGreaterThan(enableAt);
      expect(afterDisable.slice(0, enableAt)).not.toContain(
        "insert into public.shared_award_reconciliation_queue",
      );
    }
  });

  it("removes the exact pending fixture before terminal queue probes", () => {
    const pendingAssertion = sql.indexOf(
      "'pending retry incorrectly invalidated the Stage 1 release'",
    );
    const pendingDelete = sql.indexOf(
      "delete from public.shared_award_reconciliation_queue\n" +
        "  where id = '00000000-0000-4000-8000-00000000a007'::uuid",
      pendingAssertion,
    );
    const deleteAssertion = sql.indexOf("v_deleted_count = 1", pendingDelete);
    const terminalLoop = sql.indexOf(
      "foreach v_status in array array['failed', 'skipped'] loop",
      deleteAssertion,
    );

    expect(pendingAssertion).toBeGreaterThan(-1);
    expect(pendingDelete).toBeGreaterThan(pendingAssertion);
    expect(deleteAssertion).toBeGreaterThan(pendingDelete);
    expect(terminalLoop).toBeGreaterThan(deleteAssertion);
  });

  it("redirects event sequences before every synthetic behavior probe", () => {
    const transactionStart = sql.indexOf("-- MIGRATION TRANSACTION START");
    const firstMigration = sql.indexOf(
      "-- BEGIN EXACT MIGRATION 20260717070000_incremental_manual_quarantine_sync.sql",
    );
    const awardSequenceRedirect = sql.indexOf(
      "alter table public.stage1_award_publication_events alter column id drop identity;",
      transactionStart,
    );
    const releaseSequenceRedirect = sql.indexOf(
      "alter table public.stage1_publication_release_events alter column id drop identity;",
      transactionStart,
    );
    const quarantineSequenceRedirect = sql.indexOf(
      "alter table public.manual_quarantine_registry_events alter column id drop identity;",
      transactionStart,
    );
    const fixtureAward = sql.indexOf(
      "insert into public.shared_awards (",
      firstMigration,
    );
    const firstAuditRpc = sql.indexOf(
      "public.record_shared_award_regression_audit_attempt_failure(",
      firstMigration,
    );
    const firstCandidateMutation = sql.indexOf(
      "insert into public.shared_award_fact_candidates (",
      firstMigration,
    );
    const firstOutcomeRpc = sql.indexOf(
      "public.commit_award_reconciliation_blocked(",
      firstMigration,
    );

    expect(transactionStart).toBeGreaterThan(-1);
    expect(awardSequenceRedirect).toBeGreaterThan(transactionStart);
    expect(releaseSequenceRedirect).toBeGreaterThan(transactionStart);
    expect(quarantineSequenceRedirect).toBeGreaterThan(transactionStart);
    expect(firstMigration).toBeGreaterThan(awardSequenceRedirect);
    expect(firstMigration).toBeGreaterThan(releaseSequenceRedirect);
    expect(firstMigration).toBeGreaterThan(quarantineSequenceRedirect);
    for (const behaviorAt of [
      fixtureAward,
      firstAuditRpc,
      firstCandidateMutation,
      firstOutcomeRpc,
    ]) {
      expect(behaviorAt).toBeGreaterThan(awardSequenceRedirect);
      expect(behaviorAt).toBeGreaterThan(releaseSequenceRedirect);
      expect(behaviorAt).toBeGreaterThan(quarantineSequenceRedirect);
    }
    expect(
      sql.match(
        /alter table public\.stage1_award_publication_events alter column id drop identity;/g,
      ),
    ).toHaveLength(1);
    expect(
      sql.match(
        /alter table public\.stage1_publication_release_events alter column id drop identity;/g,
      ),
    ).toHaveLength(1);
    expect(
      sql.match(
        /alter table public\.manual_quarantine_registry_events alter column id drop identity;/g,
      ),
    ).toHaveLength(1);
  });
});
