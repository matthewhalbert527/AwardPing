import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migrationName = "20260716181500_secure_visual_candidate_publication_trigger.sql";
const migration = readFileSync(
  new URL(`../supabase/migrations/${migrationName}`, import.meta.url),
  "utf8",
);
const predecessor = readFileSync(
  new URL(
    "../supabase/migrations/20260715211500_add_legacy_visual_evidence_backfill_contract.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("published visual-candidate trigger privilege repair", () => {
  it("sorts after the initial-document evidence-contract repair", () => {
    expect(migrationName.localeCompare(
      "20260716174800_fix_initial_document_publication_evidence_contract.sql",
    )).toBeGreaterThan(0);
  });

  it("repairs the exact security-invoker trigger that calls private validators", () => {
    expect(predecessor).toContain(
      "create or replace function public.awardping_freeze_published_visual_candidate_event_binding()",
    );
    expect(predecessor).toMatch(
      /awardping_freeze_published_visual_candidate_event_binding\(\)[\s\S]+?security invoker[\s\S]+?awardping_validate_candidate_snapshot_manifest/,
    );
    expect(predecessor).toContain(
      "create trigger awardping_freeze_published_visual_candidate_event_binding_trigger",
    );
    expect(migration).toContain(
      "create or replace function public.awardping_freeze_published_visual_candidate_event_binding()",
    );
    expect(migration).toContain(
      "security definer\nset search_path = ''",
    );
  });

  it("fails closed unless the immutable publication guards remain present", () => {
    for (const contract of [
      "pg_catalog.to_regprocedure(\n    'public.awardping_freeze_published_visual_candidate_event_binding()'",
      "public.awardping_validate_candidate_snapshot_manifest(jsonb,jsonb,text,text)",
      "pg_catalog.pg_get_functiondef(proc.oid)",
      "pg_catalog.pg_get_function_result(proc.oid)",
      "pg_catalog.strpos(\n      v_definition,",
      "v_owner_oid is distinct from v_validator_owner_oid",
      "old.status <> ''published'' and new.status = ''published''",
      "shared_award_change_event_visual_evidence",
      "awardping_validate_candidate_snapshot_manifest",
      "old.status = ''published''",
      "Published visual-candidate freeze trigger does not match the guarded immutable-evidence or private-validator ownership contract.",
    ]) {
      expect(migration).toContain(contract);
    }
    expect(migration).toContain("v_owner in ('anon', 'authenticated', 'service_role')");
  });

  it("keeps ordinary two-manifest validation and models first observation truthfully", () => {
    expect(migration).toContain(
      "if new.candidate_scope = 'initial_official_document' then",
    );
    for (const contract of [
      "first_observation_attestation",
      "first_observation_attestation_sha256",
      "new.source_acquisition_id::text",
      "coalesce(\n          new.previous_snapshot_ref ->> 'byte_length' ~ '^[1-9][0-9]*$',\n          false\n        ) is not true",
      "new.prompt_payload #>> '{first_observation_attestation,byte_length}'",
      "new.prompt_payload #>>\n            '{first_observation_attestation,body,capture,captured_at}'",
      "previous_artifact_manifest_digest",
      "not_applicable_new_document",
      "first-observation",
      "{attestation,binding,candidate_id}",
      "{attestation,binding,candidate_signature}",
      "{attestation,binding,source_acquisition_id}",
      "{attestation,binding,first_observation_attestation_sha256}",
      "{attestation,binding,current_file_sha256}",
      "evidence.current_capture #>> '{full,sha256}' = new.new_file_hash",
    ]) {
      expect(migration).toContain(contract);
    }
    expect(migration).toMatch(
      /if new\.candidate_scope = 'initial_official_document'[\s\S]+?perform public\.awardping_validate_candidate_snapshot_manifest\([\s\S]+?'current'[\s\S]+?else[\s\S]+?previous_snapshot_ref[\s\S]+?'previous'[\s\S]+?new_snapshot_ref[\s\S]+?'current'/,
    );
    const initialBranch = migration.slice(
      migration.indexOf("if new.candidate_scope = 'initial_official_document' then"),
      migration.indexOf("\n    else\n", migration.indexOf(
        "if new.candidate_scope = 'initial_official_document' then",
      )),
    );
    expect(initialBranch).not.toMatch(
      /awardping_validate_candidate_snapshot_manifest\([\s\S]+?previous_snapshot_ref[\s\S]+?'previous'/,
    );
  });

  it("does not expose private manifest helpers to service_role", () => {
    expect(migration).not.toMatch(
      /grant\s+execute\s+on\s+function\s+public\.awardping_validate_candidate_snapshot_manifest/i,
    );
    expect(migration).not.toMatch(
      /grant\s+execute\s+on\s+function\s+public\.awardping_sha256_text/i,
    );
    expect(migration).toContain(
      "revoke all on function public.awardping_freeze_published_visual_candidate_event_binding()\n  from public, anon, authenticated;",
    );
    expect(migration).toContain(
      "grant execute on function public.awardping_freeze_published_visual_candidate_event_binding()\n  to service_role;",
    );
  });
});
