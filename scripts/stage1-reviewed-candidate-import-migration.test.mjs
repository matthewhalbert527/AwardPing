import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/20260717144500_stage1_reviewed_candidate_import.sql",
    import.meta.url,
  ),
  "utf8",
);
const pendingChainGuardName =
  "20260717070000_incremental_manual_quarantine_sync.sql";
const pendingChainGuard = readFileSync(
  new URL(
    `../supabase/migrations/${pendingChainGuardName}`,
    import.meta.url,
  ),
  "utf8",
);
const digestHelper = section(
  migration,
  "create or replace function private.stage1_pgcrypto_sha256(p_value bytea)",
  "create or replace function private.stage1_canonical_json_sha256(p_value jsonb)",
);
const fn = section(
  migration,
  "create or replace function public.import_reviewed_stage1_fact_candidates(",
  "revoke execute on function public.import_reviewed_stage1_fact_candidates(",
);
const bundles = section(
  migration,
  "create table private.stage1_reviewed_candidate_import_bundles (",
  "create table private.stage1_reviewed_candidate_import_items (",
);

describe("reviewed Stage 1 candidate-import migration", () => {
  it("uses ordinary function-call syntax for schema-qualified URL parsing", () => {
    expect(migration).toContain(
      "pg_catalog.substring(p_url, '^https://([^/:?#]+)')",
    );
    expect(migration).not.toMatch(
      /pg_catalog\.substring\([^\n]*\sfrom\s/i,
    );
    expect(migration).toContain(
      "v_candidate ->> 'raw_value' is distinct from (case",
    );
    expect(migration).not.toContain(
      "v_candidate ->> 'raw_value' is distinct from case",
    );
  });

  it("guards the full pending hash-helper chain before any downstream use", () => {
    expect(pendingChainGuard).toContain(
      "revoke create on schema public from public;",
    );
    expect(pendingChainGuard).toContain("from pg_catalog.pg_extension ext");
    expect(pendingChainGuard).toContain("join pg_catalog.pg_depend dep");
    expect(pendingChainGuard).toContain("dep.deptype = 'e'");
    expect(pendingChainGuard).toContain("proc.proowner = ext.extowner");
    expect(pendingChainGuard).toContain(
      "pg_catalog.cardinality(v_extension_digest_oids) is distinct from 1",
    );
    expect(pendingChainGuard).toContain(
      "v_resolved_digest_oid is distinct from v_extension_digest_oid",
    );
    for (const downstreamMigration of [
      "20260717071500_stage1_regression_audit_observations.sql",
      "20260717073548_reconciliation_disposition_atomicity.sql",
      "20260717123000_legacy_contact_ciphertext_quarantine.sql",
      "20260717133922_durable_stage1_verification_epoch.sql",
      "20260717144500_stage1_reviewed_candidate_import.sql",
      "20260717150000_reviewed_stage1_reconciliation.sql",
    ]) {
      expect(downstreamMigration > pendingChainGuardName).toBe(true);
    }
  });

  it("hashes only through the exact extension-owned pgcrypto routine", () => {
    expect(digestHelper).toContain("from pg_catalog.pg_extension ext");
    expect(digestHelper).toContain("join pg_catalog.pg_depend dep");
    expect(digestHelper).toContain("dep.deptype = 'e'");
    expect(digestHelper).toContain("proc.proowner = ext.extowner");
    expect(digestHelper).toContain("having pg_catalog.count(*) = 1");
    expect(digestHelper).toContain("execute pg_catalog.format(");
    expect(digestHelper).toContain(
      "The exact extension-owned pgcrypto digest(bytea,text) function is required.",
    );
    expect(migration).not.toContain("public.digest(");
  });

  it("keeps existing private-schema grants intact and secures only new objects", () => {
    expect(migration).toContain("revoke all on schema private from public;");
    expect(migration).not.toMatch(
      /revoke all on schema private from[^;]*(?:anon|authenticated)/i,
    );
    expect(migration).toContain(
      "revoke all on table\n  private.stage1_reviewed_candidate_import_bundles,",
    );
    expect(migration).toContain(
      ") from public, anon, authenticated;\ngrant execute on function public.import_reviewed_stage1_fact_candidates(",
    );
  });

  it("persists the exact private review proof and immutable hashes", () => {
    for (const proof of [
      "review_bundle jsonb not null",
      "source_bindings jsonb not null",
      "source_bindings_sha256 text not null",
      "candidates_sha256 text not null",
      "confirmation_payload jsonb not null",
      "import_binding_sha256 text not null",
      "private.stage1_canonical_json_sha256(review_bundle) = bundle_sha256",
      "private.stage1_canonical_json_sha256(source_bindings) = source_bindings_sha256",
      "private.stage1_canonical_json_sha256(confirmation_payload) = confirmation_sha256",
    ]) expect(bundles).toContain(proof);
    expect(fn).toContain("v_existing_bundle.review_bundle is distinct from v_bundle");
    expect(migration).toContain(
      "private.stage1_canonical_json_sha256(source_bindings) = source_bindings_sha256",
    );
    expect(migration).toContain("source.value - 'local_verified_at'");
    expect(fn).toContain(
      "private.stage1_stable_source_bindings(v_existing_bundle.source_bindings)",
    );
  });

  it("rejects malformed and cross-award direct service calls", () => {
    expect(fn).toContain("private.stage1_jsonb_has_exact_keys(p_import_binding");
    expect(fn).toContain("private.stage1_jsonb_has_exact_keys(v_candidate");
    expect(fn).toContain(
      "v_candidate ->> 'shared_award_id' is distinct from\n        v_source_binding ->> 'shared_award_id'",
    );
    expect(fn).toContain(
      "'canonical_shared_award_id', v_award_id::text",
    );
    expect(fn).toContain("source.shared_award_id = (v_source_binding ->> 'shared_award_id')::uuid");
    expect(fn).toContain("award.search_key = v_bundle #>> array['cohort', 'canonical_award', 'search_key']");
    expect(fn).toContain("award.official_homepage = v_bundle #>> array['cohort', 'canonical_award', 'official_homepage']");
    expect(fn).toContain("member.member_kind = 'canonical'");
  });

  it("rejects extra, duplicate, unused, and stale reviewed sources", () => {
    expect(fn).toContain("jsonb_array_length(p_import_binding -> 'source_bindings') <> v_source_count");
    expect(fn).toContain("count(distinct source ->> 'source_id')");
    expect(fn).toContain("where not exists (\n        select 1 from pg_catalog.jsonb_array_elements(v_bundle -> 'sources')");
    expect(fn).toContain("where item ->> 'source_id' = reviewed_source ->> 'source_id'");
    expect(fn).toContain("last_checked_at')::timestamptz < v_now - interval '24 hours'");
    expect(fn).toContain("local_verified_at')::timestamptz > v_now + interval '5 minutes'");
    expect(fn).toContain("source.last_checked_at =");
    expect(fn).toContain("snapshot.latest_captured_at =");
  });

  it("recomputes canonical item identity and rejects forged evidence/metadata", () => {
    expect(fn).toContain("v_expected_item_sha := private.stage1_canonical_json_sha256(");
    for (const identityField of [
      "'canonical_shared_award_id', v_award_id::text",
      "'source_relevance', v_bundle_item ->> 'source_relevance'",
      "'normalized_value', v_bundle_item -> 'normalized_value'",
      "'capture_text_sha256', v_source_binding ->> 'capture_text_sha256'",
      "'capture_text_object_key', v_source_binding ->> 'capture_text_object_key'",
    ]) expect(fn).toContain(identityField);
    expect(fn).toContain("v_item_sha is distinct from v_expected_item_sha");
    expect(fn).toContain("private.stage1_candidate_uuid_from_sha256(v_item_sha)");
    expect(fn).toContain("private.stage1_text_sha256(\n        v_candidate ->> 'evidence_quote'");
    expect(fn).toContain("private.stage1_evidence_location_is_valid(");
  });

  it("collision-checks every immutable candidate and ledger field", () => {
    for (const field of [
      "source_url",
      "source_title",
      "source_role",
      "source_quality_decision",
      "field_name",
      "raw_value",
      "normalized_value",
      "evidence_quote",
      "evidence_location",
      "extracted_at",
      "model",
      "confidence",
      "metadata",
    ]) expect(fn).toContain(`v_existing_candidate.${field}`);
    for (const field of [
      "item_sha256",
      "bundle_sha256",
      "candidate_id",
      "canonical_shared_award_id",
      "source_id",
      "field_name",
    ]) expect(fn).toContain(`v_existing_ledger.${field}`);
  });

  it("allows exact replay after downstream candidate lifecycle changes", () => {
    const replay = section(
      fn,
      "if found then\n      select ledger.* into v_existing_ledger",
      "    insert into public.shared_award_fact_candidates (",
    );
    expect(replay).not.toContain("candidate_status is distinct from 'pending'");
    expect(replay).not.toContain("selected_reason is not null");
    expect(replay).not.toContain("rejection_reason is not null");
    expect(replay).toContain("downstream lifecycle fields");
    expect(replay).toContain("continue;");
  });

  it("retains the first complete local proof but permits a freshly reverified retry", () => {
    expect(bundles).toContain("source_bindings jsonb not null");
    expect(bundles).toContain("source_bindings_sha256 text not null");
    expect(bundles).toContain("import_binding_sha256 text not null");
    expect(fn).toContain("'official_identity', 'local_verified_at'");
    expect(fn).toContain("local_verified_at')::timestamptz < v_now - interval '24 hours'");
    expect(fn).toContain("local_verified_at')::timestamptz > v_now + interval '5 minutes'");
    expect(fn.match(/private\.stage1_stable_source_bindings\(/g)).toHaveLength(4);
    expect(fn).not.toContain(
      "v_existing_bundle.source_bindings is distinct from\n        p_import_binding -> 'source_bindings'",
    );
  });

  it("returns and restricts a complete zero-paid, zero-side-effect proof", () => {
    for (const proof of [
      "'confirmation_sha256', p_confirmation_sha256",
      "'inserted_count', v_inserted",
      "'existing_count', v_existing",
      "'paid_api_calls', 0",
      "'source_mutations', 0",
      "'release_mutations', 0",
      "'reconciliation_mutations', 0",
      "'publication_mutations', 0",
    ]) expect(fn).toContain(proof);
    expect(fn).toContain("security definer");
    expect(fn).toContain("set search_path = ''");
    expect(migration).toContain(
      "grant execute on function public.import_reviewed_stage1_fact_candidates(\n  jsonb,\n  text\n) to service_role;",
    );
  });
});

function section(source, start, end) {
  const startAt = source.indexOf(start);
  const endAt = source.indexOf(end, startAt + start.length);
  if (startAt < 0 || endAt < 0) throw new Error(`Missing migration section: ${start}`);
  return source.slice(startAt, endAt);
}
