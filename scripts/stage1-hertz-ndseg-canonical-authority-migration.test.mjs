import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/20260717153000_hertz_ndseg_canonical_authority.sql",
    import.meta.url,
  ),
  "utf8",
);
const readiness = readFileSync(
  new URL("./lib/stage1-cohort-readiness.mjs", import.meta.url),
  "utf8",
);
const seeds = readFileSync(
  new URL("../src/lib/award-seeds.ts", import.meta.url),
  "utf8",
);
const identity = readFileSync(
  new URL("../src/lib/stage1-cohort-identity.ts", import.meta.url),
  "utf8",
);

describe("Hertz and NDSEG reviewed canonical-authority migration", () => {
  it("uses parseable schema-qualified string function calls", () => {
    expect(migration).toContain(
      "pg_catalog.substring(p_source_url, '^https://([^/:?#]+)')",
    );
    expect(migration).toContain(
      "pg_catalog.substring(p_canonical_homepage, '^https://([^/:?#]+)')",
    );
    expect(migration).toContain("pg_catalog.strpos(v_definition, v_anchor)");
    expect(migration).not.toContain("pg_catalog.position(");
    expect(migration).not.toMatch(
      /pg_catalog\.(?:substring|position)\([^\n]*(?:\sfrom\s|\sin\s)/i,
    );
  });

  it("changes Hertz identity while preserving canonical NDSEG at ndseg.org", () => {
    for (const source of [migration, readiness, seeds, identity]) {
      expect(source).toContain("https://www.hertzfoundation.org/hertz-fellowship");
      expect(source).toContain("https://ndseg.org/");
    }
    expect(readiness).toContain('host: "ndseg.sysplus.com"');
    expect(readiness).toContain('classification: "official_contractor_host"');
    expect(readiness).toContain('evidenceUrl: "https://ndseg.org/apply-link"');
    expect(identity).not.toContain("https://ndseg.sysplus.com/NDSEG/");
    expect(identity).toContain('stage1CohortIdentityVersion = "stage1-national-25-v3"');
    expect(migration).toContain(
      "6e7dd7ee1372671cbfb22b17b862d867145a93c7dc0b73d49afc11f504ee6c8f",
    );
  });

  it("retains immutable previous/current authority evidence instead of erasing history", () => {
    expect(migration).toContain(
      "create table if not exists private.stage1_canonical_identity_evidence",
    );
    expect(migration).toContain("previous_homepage text not null");
    expect(migration).toContain("current_homepage text not null");
    expect(migration).toContain("authority_evidence_url text not null");
    expect(migration).toContain("https://www.hertzfoundation.org/the-fellowship/");
    expect(migration).toContain("https://ndseg.org/");
    expect(migration).toContain("https://ndseg.org/apply-link");
    expect(migration).toContain(
      "create table if not exists private.stage1_delegated_source_authority_evidence",
    );
    expect(migration).toContain("Reviewed Stage 1 canonical-identity evidence is immutable.");
    expect(migration).toContain("on conflict (identity_key) do nothing");
    expect(migration).toContain("on conflict (authority_key) do nothing");
    expect(migration).toContain("collides with different evidence");
    expect(migration).toContain("retained.evidence = v_hertz_evidence");
    expect(migration).toContain("retained.evidence = v_ndseg_authority_evidence");
    expect(migration).toContain("stage1_publication_evidence_hash(v_hertz_evidence)");
    expect(migration).toContain("stage1_publication_evidence_hash(v_ndseg_authority_evidence)");
  });

  it("fails closed on unexpected identity drift and invalidates prior release evidence", () => {
    expect(migration).toContain("pg_advisory_xact_lock");
    expect(migration).toContain("changed outside the reviewed migration fence");
    expect(migration).toContain("fact_ledger_batch_id = null");
    expect(migration).toContain("release_epoch = null");
    expect(migration).toContain("evidence_checked_at = null");
    expect(migration).toContain("last_verified_at = null");
    expect(migration).toContain("public.invalidate_stage1_cohort_release(");
    expect(migration).toContain("stage1-national-25-v2");
  });

  it("upgrades every current embedded identity guard without rewriting history rows", () => {
    expect(migration).toContain("pg_catalog.pg_get_functiondef(procedure.oid)");
    expect(migration).toContain("procedure.prokind = 'f'");
    expect(migration).toContain("execute v_definition");
    expect(migration).toContain("still embeds the retired cohort identity");
    for (const reviewedFunction of [
      "transition_stage1_cohort_release",
      "list_stage1_effective_publication",
      "get_stage1_publication_snapshot",
      "stage1_release_contract_state_hash",
      "stage1_release_external_signing_preflight",
      "insert_stage1_external_release_artifact",
      "stage1_current_valid_release_artifact",
      "record_stage1_hosted_runtime_identity_artifact",
      "record_stage1_rollback_drill_artifact",
      "record_stage1_non_cohort_leak_crawl_artifact",
      "record_stage1_r2_recovery_drill_artifact",
      "record_stage1_visual_crop_coverage_artifact",
      "stage1_release_gate_snapshot",
      "stage1_gate_without_contact_fence_20260717123000",
      "record_stage1_release_acceptance",
    ]) expect(migration).toContain(`'${reviewedFunction}'`);
    expect(migration).toContain("namespace.nspname = 'public'");
    expect(migration).toContain("namespace.nspname = 'private'");
    expect(migration).not.toMatch(/update\s+public\.stage1_release_acceptance_artifacts/i);
    expect(migration).not.toMatch(/update\s+public\.stage1_publication_release_events/i);
  });

  it("makes delegated authority an enforced release-gate rule", () => {
    expect(migration).toContain(
      "create or replace function private.stage1_manifest_source_authority_valid(",
    );
    expect(migration).toContain("p_source_role = 'identity_home'");
    expect(migration).toContain("p_source_url = p_canonical_homepage");
    expect(migration).toContain("v_source_host = v_canonical_host");
    expect(migration).toContain("authority.delegated_host = v_source_host");
    expect(migration).toContain("authority.authority_status = 'active'");
    expect(migration).toContain("authority.policy_version = p_policy_version");
    expect(migration).toContain(
      "v_binding_identity ->> 'classification' = 'canonical_program_host'",
    );
    expect(migration).toContain(
      "v_replacement constant text := E'or not private.stage1_manifest_source_authority_valid(",
    );
    expect(migration).toContain("\\n          p_cohort_key,");
    expect(migration).toContain(
      "The authoritative Stage 1 source-identity gate anchor drifted or is ambiguous.",
    );
    expect(readiness).toContain("stage1ManifestSourceAuthority({");
    expect(readiness).toContain("source_authority_unreviewed:");
    expect(readiness).toContain("identity_home_not_exact_canonical:");
  });

  it("keeps the NDSEG date unavailable in durable operator quarantine", () => {
    expect(migration).toContain("stage1:ndseg:official-deadline-conflict:2026-07-17");
    expect(migration).toContain("reported_cycle', 'FY2027'");
    expect(migration).toContain("reported_open_date', 'August 3, 2026'");
    expect(migration).toContain("October 30, 2026 (5 PM Eastern)");
    expect(migration).toContain("reported_open_date', 'August 15'");
    expect(migration).toContain("November 15");
    expect(migration).not.toContain("November 17 at 5 PM Eastern");
    expect(migration).toContain("'publication_decision', 'not_published'");
    expect(migration).not.toContain("'retry_charge',");
    expect(migration).toContain(
      "'none',\n  'NDSEG official application-cycle date conflict'",
    );
    expect(migration).toContain("on conflict (quarantine_key) do nothing");
    expect(migration).toContain("quarantine.status = 'quarantined'");
    expect(migration).toContain("quarantine.evidence = v_ndseg_conflict_evidence");
    expect(migration).toContain(
      "manual_quarantine_evidence_hash(v_ndseg_conflict_evidence)",
    );
    expect(migration).toContain(
      "quarantine.evidence ->> 'publication_decision' = 'not_published'",
    );
    expect(migration).toContain(
      "quarantine.policy_id = 'awardping-stage1-official-source-conflict'",
    );
  });
});
