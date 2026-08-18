import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/20260717105043_harden_stage1_vault_service_role.sql",
    import.meta.url,
  ),
  "utf8",
);
const compactMigration = migration.replace(/\s+/g, " ");

function occurrenceCount(value, needle) {
  return value.split(needle).length - 1;
}

describe("Stage 1 Vault least-privilege migration", () => {
  it("removes every browser and PUBLIC Vault access surface", () => {
    const revokes = [
      "revoke all on schema vault from public, anon, authenticated;",
      "revoke all on all tables in schema vault from public, anon, authenticated;",
    ];
    let prior = -1;
    for (const revoke of revokes) {
      expect(occurrenceCount(compactMigration, revoke)).toBe(1);
      const index = compactMigration.indexOf(revoke);
      expect(index).toBeGreaterThan(prior);
      prior = index;
    }
    expect(migration).not.toContain(
      "revoke execute on all functions in schema vault",
    );
    expect(migration).toContain(
      "$awardping_stage1_vault_function_acl_cleanup$",
    );
    expect(migration).toContain(
      "array['anon', 'authenticated']::text[]",
    );
    expect(migration).toContain(
      "role.role_name, procedure.oid, 'EXECUTE'",
    );
    expect(migration).toContain(
      "'postgres', v_function_oid, 'EXECUTE WITH GRANT OPTION'",
    );
    expect(compactMigration).toContain(
      "'revoke execute on function %s from public, anon, authenticated', v_function_oid::pg_catalog.regprocedure",
    );
    expect(migration).not.toMatch(
      /^\s*grant\s+[\s\S]{0,80}\s+on\s+[\s\S]{0,80}\bvault\b/im,
    );
    expect(migration).not.toMatch(/alter default privileges/i);
  });

  it("uses one private predicate for browser access and unexpected Vault RPCs", () => {
    expect(migration).toContain(
      "create or replace function private.stage1_vault_access_contract_safe()",
    );
    expect(migration).toContain(
      "foreach v_role in array array['anon', 'authenticated'] loop",
    );
    for (const inquiry of [
      "pg_catalog.has_schema_privilege",
      "pg_catalog.has_table_privilege",
      "pg_catalog.has_any_column_privilege",
      "pg_catalog.has_function_privilege",
    ]) {
      expect(migration).toContain(inquiry);
    }
    expect(migration).toContain("v_vault_oid, 'USAGE'");
    expect(migration).toContain("v_vault_oid, 'CREATE'");
    expect(migration).toContain("current_setting('server_version_num')");
    expect(migration).toContain("v_table_privileges, 'MAINTAIN'");
    expect(migration).toContain("procedure.pronamespace <> v_vault_oid");
    expect(migration).toContain("pg_catalog.pg_get_functiondef(procedure.oid)");
    expect(migration).toContain(
      "array['anon', 'authenticated', 'service_role']::text[]",
    );
    expect(migration).not.toContain("pg_catalog.aclexplode");

    expect(migration).toContain(
      "alter function private.stage1_vault_access_contract_safe() owner to postgres;",
    );
    expect(compactMigration).toContain(
      "revoke all on function private.stage1_vault_access_contract_safe() from public, anon, authenticated, service_role;",
    );
    expect(migration).toContain("stable\nsecurity definer\nset search_path = ''");
    expect(migration).toContain("exception when others then\n  return false;");
  });

  it("binds the signed service-profile denial into gate failure, basis, and state hash", () => {
    expect(migration).toContain(
      "$awardping_stage1_vault_runtime_evidence_rewrite$",
    );
    expect(migration).toContain("awardping.stage1.hosted-runtime-identity.v2");
    expect(migration).toContain("vault_profile_http_status");
    expect(migration).toContain("vault_profile_postgrest_code");
    expect(migration).toContain("PGRST106");
    expect(migration).toContain("vault_profile_response_sha256");
    expect(migration).toContain("$awardping_stage1_vault_gate_rewrite$");
    expect(migration).toContain("v_vault_access_contract_safe boolean := false;");
    expect(migration).toContain("v_vault_service_profile_blocked boolean := false;");
    expect(migration).toContain(
      "v_vault_access_contract_safe := private.stage1_vault_access_contract_safe()",
    );
    expect(migration).toContain("vault_access_contract_failed");
    expect(migration).toContain(
      "''vault_security'', pg_catalog.jsonb_build_object(",
    );
    expect(migration).toContain(
      "''api_surface_safe'', v_vault_access_contract_safe",
    );
    expect(migration).toContain(
      "''service_role_data_api_profile_blocked'', v_vault_service_profile_blocked",
    );
    expect(migration).toContain(
      "private.stage1_6pm_shard_healthy(latest_runs.worker_run)",
    );
    expect(migration).toContain(
      "foreach v_anchor in array array[\n    v_old_declaration, v_old_assignment, v_old_failure, v_old_basis",
    );

    for (const preserved of [
      "procedure.oid = v_gate_oid",
      "procedure.proowner = v_owner",
      "procedure.proacl is not distinct from v_acl",
      "procedure.prosecdef = v_security_definer",
      "procedure.provolatile = v_volatility",
      "procedure.proconfig is not distinct from v_proconfig",
    ]) {
      expect(migration).toContain(preserved);
    }
    expect(compactMigration).toContain(
      "revoke all on function private.stage1_release_gate_snapshot(timestamptz) from public, anon, authenticated, service_role;",
    );
    expect(migration).toContain(
      "v_gate_snapshot #>> '{vault_security,api_surface_safe}'",
    );
    expect(migration).toContain(
      "'{vault_security,service_role_data_api_profile_blocked}'",
    );
    expect(migration).toContain("v_gate_snapshot ->> 'state_hash'");
  });

  it("preserves postgres-owned Vault readers and narrow service entrypoints", () => {
    for (const signature of [
      "private.stage1_release_artifact_signature_valid(uuid,timestamp with time zone)",
      "private.insert_stage1_external_release_artifact(text,text,text,text,text,text,text,jsonb,text,text,text,text,timestamp with time zone,timestamp with time zone,timestamp with time zone,text)",
      "public.record_stage1_hosted_runtime_identity_artifact(text,text,jsonb,text,text,text,text,timestamp with time zone,timestamp with time zone,timestamp with time zone,text)",
      "public.record_stage1_rollback_drill_artifact(text,text,jsonb,text,text,text,text,timestamp with time zone,timestamp with time zone,timestamp with time zone,text)",
      "public.record_stage1_non_cohort_leak_crawl_artifact(text,text,jsonb,text,text,text,text,timestamp with time zone,timestamp with time zone,timestamp with time zone,text)",
      "public.record_stage1_r2_recovery_drill_artifact(text,text,jsonb,text,text,text,text,timestamp with time zone,timestamp with time zone,timestamp with time zone,text)",
      "public.get_stage1_release_gate_snapshot()",
      "public.activate_stage1_release_from_acceptance(uuid,text,text,text)",
    ]) {
      expect(migration).toContain(`'${signature}'`);
    }
    expect(migration).toContain("procedure.proowner = v_postgres_oid");
    expect(migration).toContain("procedure.prosecdef");
    expect(migration).toContain("search_path=\"\"");
    expect(migration).toContain(
      "Vault hardening unexpectedly removed postgres Vault access.",
    );
    expect(compactMigration).toContain(
      "pg_catalog.has_table_privilege( 'postgres', 'vault.decrypted_secrets', 'SELECT' )",
    );
    expect(migration).not.toMatch(
      /not pg_catalog\.has_function_privilege\(\s*'postgres', procedure\.oid, 'EXECUTE'/,
    );
    expect(migration).not.toMatch(/revoke[\s\S]{0,80}from postgres/i);
  });

  it("requires the deployed contract before changing ACLs and fails closed", () => {
    expect(migration).toContain("to_regnamespace('vault')");
    expect(migration).toContain("to_regclass('vault.decrypted_secrets')");
    expect(migration).toContain("pg_catalog.pg_get_functiondef");
    expect(migration).toContain("'vault.decrypted_secrets'");
    expect(migration).toContain("$awardping_stage1_vault_precondition$");
    expect(migration).toContain("$awardping_stage1_vault_postcondition$");
    expect(migration.match(/errcode = '(?:55000|42883)'/g)?.length).toBeGreaterThanOrEqual(
      10,
    );
  });
});
