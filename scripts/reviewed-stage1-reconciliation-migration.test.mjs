import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/20260717150000_reviewed_stage1_reconciliation.sql",
    import.meta.url,
  ),
  "utf8",
);
const rollbackProbe = readFileSync(
  new URL("./sql/stage1-pending-migration-rollback-probe.sql", import.meta.url),
  "utf8",
);
const fn = migration.slice(
  migration.indexOf(
    "create or replace function public.commit_reviewed_stage1_reconciliation_publication(",
  ),
  migration.indexOf(
    "revoke execute on function public.commit_reviewed_stage1_reconciliation_publication(",
  ),
);
const successGuard = migration.slice(
  migration.indexOf(
    "create or replace function private.enforce_stage1_reviewed_reconciliation_success()",
  ),
  migration.indexOf(
    "revoke all on function private.enforce_stage1_reviewed_reconciliation_success()",
  ),
);
const rootRegistry = section(
  migration,
  "create table private.stage1_human_review_roots (",
  "create or replace function private.prevent_stage1_human_review_root_mutation()",
);
const rootMutationGuard = section(
  migration,
  "create or replace function private.prevent_stage1_human_review_root_mutation()",
  "create trigger prevent_stage1_human_review_root_mutation",
);
const rootReader = section(
  migration,
  "create or replace function public.get_stage1_human_review_root(",
  "revoke execute on function public.get_stage1_human_review_root(text)",
);
const bijectionValidator = section(
  migration,
  "create or replace function private.stage1_review_fact_bijection_valid(",
  "revoke all on function private.stage1_review_fact_bijection_valid(",
);
const authorizationRegistry = section(
  migration,
  "create table private.stage1_reviewed_reconciliation_authorizations (",
  "alter table private.stage1_human_review_roots enable row level security;",
);

describe("reviewed Stage 1 reconciliation migration", () => {
  it("stores the full root only in an immutable private service-read registry", () => {
    expect(rootRegistry).toContain("root_sha256 text primary key");
    expect(rootRegistry).toContain("review_root jsonb not null");
    expect(rootRegistry).toContain("canonical_shared_award_id uuid not null");
    expect(rootRegistry).toContain("public_facts_sha256 text not null");
    expect(rootRegistry).toContain("summary_sha256 text not null");
    expect(rootRegistry).toContain("confidence_sha256 text not null");
    expect(rootRegistry).toContain("evidence_rows_sha256 text not null");
    expect(rootRegistry).toContain("audit_row_sha256 text not null");
    expect(rootRegistry).toContain(
      "alter table private.stage1_human_review_roots enable row level security",
    );
    expect(rootRegistry).toContain(
      "revoke all on table private.stage1_human_review_roots",
    );
    expect(rootRegistry).toContain(
      "grant select on table private.stage1_human_review_roots to service_role",
    );
    expect(rootRegistry).not.toMatch(/grant (?:insert|update|delete|all)/i);
    expect(rootMutationGuard).toContain("Stage 1 human-review roots are immutable.");
    expect(migration).toContain(
      "before update or delete on private.stage1_human_review_roots",
    );
  });

  it("keeps wrapper authorization private, one-time, and payload-bound", () => {
    for (const field of [
      "reconciliation_id uuid primary key",
      "root_sha256 text not null",
      "public_facts_sha256 text not null",
      "summary_sha256 text not null",
      "confidence_sha256 text not null",
      "evidence_rows_sha256 text not null",
      "audit_row_sha256 text not null",
    ]) expect(authorizationRegistry).toContain(field);
    expect(migration).toContain(
      "alter table private.stage1_reviewed_reconciliation_authorizations\n  enable row level security;",
    );
    expect(migration).toContain(
      "revoke all on table private.stage1_reviewed_reconciliation_authorizations\n  from public, anon, authenticated, service_role;",
    );
    expect(migration).not.toMatch(
      /grant\s+[^;]+on table private\.stage1_reviewed_reconciliation_authorizations/i,
    );
    expect(fn).toContain(
      "insert into private.stage1_reviewed_reconciliation_authorizations (",
    );
    expect(successGuard).toContain(
      "join private.stage1_reviewed_reconciliation_authorizations authz",
    );
    expect(successGuard).toContain(
      "delete from private.stage1_reviewed_reconciliation_authorizations authz",
    );
    expect(migration).not.toMatch(
      /stage1_reviewed_reconciliation_authorizations\s+authorization\b/i,
    );
    expect(successGuard).toContain("v_consumed_authorization is null");
    expect(successGuard).toContain(
      "The reviewed Stage 1 payload authorization was absent or already consumed.",
    );
  });

  it("binds immutable roots and the success trigger to exact payload hashes", () => {
    for (const hashField of [
      "public_facts_sha256",
      "summary_sha256",
      "confidence_sha256",
      "evidence_rows_sha256",
      "audit_row_sha256",
    ]) {
      expect(fn).toContain(`v_stored_review_root.${hashField} is distinct from`);
      expect(successGuard).toContain(`review_root.${hashField}`);
      expect(successGuard).toContain(`authz.${hashField}`);
    }
    expect(fn).toContain(
      "v_public_facts_sha256 := private.stage1_canonical_json_sha256(p_public_facts)",
    );
    expect(fn).toContain(
      "private.stage1_reviewed_evidence_rows_sha256(p_evidence_rows)",
    );
    expect(migration).toContain(
      "order by (evidence.row_value ->> 'field_name') collate \"C\"",
    );
    expect(fn).toContain(
      "v_audit_row_sha256 := private.stage1_reviewed_audit_row_sha256(\n    v_expected_audit_row",
    );
    for (const metadataHash of [
      "stage1_reviewed_public_facts_sha256",
      "stage1_reviewed_summary_sha256",
      "stage1_reviewed_confidence_sha256",
      "stage1_reviewed_evidence_rows_sha256",
      "stage1_reviewed_audit_row_sha256",
    ]) {
      expect(fn).toContain(metadataHash);
      expect(successGuard).toContain(metadataHash);
    }
    expect(successGuard).toContain(
      "select private.stage1_canonical_json_sha256(award.public_facts)",
    );
    expect(successGuard).toContain(
      "select private.stage1_text_sha256(award.summary)",
    );
    expect(successGuard).toContain(
      "pg_catalog.to_jsonb(award.confidence)",
    );
    expect(successGuard).toContain(
      "from public.stage1_award_reconciled_fact_evidence evidence",
    );
    expect(successGuard).toContain(
      "from public.shared_award_page_audits audit",
    );
    expect(successGuard).toContain(
      "private.stage1_reviewed_evidence_rows_sha256(",
    );
    expect(successGuard).toContain(
      "private.stage1_reviewed_audit_row_sha256(",
    );
  });

  it("derives the complete public projection and audit from the immutable root", () => {
    expect(fn).toContain(
      "'review_root', 'cohorts', '0', 'publication', 'summary'",
    );
    expect(fn).toContain(
      "'review_root', 'cohorts', '0', 'publication', 'confidence'",
    );
    expect(fn).toContain("v_expected_audit_base := pg_catalog.jsonb_build_object(");
    expect(fn).toContain("v_expected_audit_row := v_expected_audit_base ||");
    expect(fn).toContain(
      "v_expected_audit_projection := pg_catalog.jsonb_build_object(",
    );
    for (const projectionHash of [
      "stage1_reviewed_public_facts_sha256",
      "stage1_reviewed_summary_sha256",
      "stage1_reviewed_confidence_sha256",
      "stage1_reviewed_evidence_rows_sha256",
    ]) expect(fn).toContain(projectionHash);
    expect(fn).toContain(
      ") || v_expected_audit_projection\n  into v_expected_selected_fact_summary",
    );
    expect(fn).toContain("'public_page_snapshot', p_public_facts,");
    expect(fn).toContain("if p_audit_row is distinct from v_expected_audit_row then");
    expect(fn).toContain(
      "The deterministic audit row is not the exact projection of the immutable human-review root.",
    );
    expect(fn).toContain("into v_audit_id, v_persisted_audit_row_sha256");
    expect(fn).toContain(
      "v_persisted_audit_row_sha256 is distinct from v_audit_row_sha256",
    );
    expect(fn).toContain(
      "The final deterministic reviewed audit row differs from its immutable authorization.",
    );
    expect(fn).not.toContain("update public.shared_award_page_audits audit");
  });

  it("enforces a reverse bijection for every fact, ordered item, and evidence row", () => {
    expect(bijectionValidator).toContain("jsonb_object_keys(p_public_facts)");
    expect(bijectionValidator).toContain(
      "jsonb_array_length(p_field_choices) <> v_non_empty_fact_count",
    );
    expect(bijectionValidator).toContain(
      "jsonb_array_length(p_evidence_rows) <> v_non_empty_fact_count",
    );
    expect(bijectionValidator).toContain(
      "v_composition_method = 'ordered_array_items'",
    );
    expect(bijectionValidator).toContain(
      "jsonb_array_length(v_public_value) <> v_candidate_count",
    );
    expect(bijectionValidator).toContain(
      "v_evidence_row -> 'candidate_ids' is distinct from v_choice_candidate_ids",
    );
    expect(bijectionValidator).toContain(
      "v_candidate_occurrence_count = pg_catalog.cardinality(p_candidate_ids)",
    );
    const guardAt = fn.indexOf(
      "or not private.stage1_review_fact_bijection_valid(",
    );
    const rootAt = fn.indexOf("insert into private.stage1_human_review_roots (");
    const coreAt = fn.indexOf(
      "v_result := public.commit_award_reconciliation_publication(",
    );
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(rootAt);
    expect(rootAt).toBeLessThan(coreAt);
  });

  it("keeps live rollback controls for uncovered facts and stored-root replay", () => {
    expect(rollbackProbe).toContain(
      "reviewed bijection accepted a non-empty fact with no reviewed field choice",
    );
    expect(rollbackProbe).toContain(
      "Stored-root replay probe must fail.",
    );
    expect(rollbackProbe).toContain(
      "when sqlstate '23514' then\n      v_stored_root_replay_rejected := true;",
    );
    expect(rollbackProbe).toContain(
      "stored review-root replay was accepted or left partial publication state",
    );
    expect(rollbackProbe).toContain(
      "not exists (\n        select 1\n        from private.stage1_reviewed_reconciliation_authorizations authz",
    );
  });

  it("persists and collision-checks the exact root before public commit", () => {
    const insertAt = fn.indexOf("insert into private.stage1_human_review_roots (");
    const collisionAt = fn.indexOf(
      "human-review root hash collides with different immutable evidence",
    );
    const coreAt = fn.indexOf(
      "v_result := public.commit_award_reconciliation_publication(",
    );
    expect(insertAt).toBeGreaterThan(-1);
    expect(fn).toContain("on conflict (root_sha256) do nothing");
    expect(fn).toContain("v_stored_review_root.review_root is distinct from");
    expect(collisionAt).toBeGreaterThan(insertAt);
    expect(coreAt).toBeGreaterThan(collisionAt);
    const publicMetadataWrites = fn.slice(fn.indexOf("-- Bind the reviewed contract"));
    expect(publicMetadataWrites).not.toContain("'reviewed_by'");
    expect(publicMetadataWrites).not.toContain("'review_reason'");
  });

  it("provides only service_role an exact-hash recovery and verification path", () => {
    expect(rootReader).toContain("coalesce(p_root_sha256, '') !~ '^[0-9a-f]{64}$'");
    expect(rootReader).toContain(
      "private.stage1_canonical_json_sha256(v_stored.review_root)",
    );
    expect(rootReader).toContain("'hash_matches', v_recomputed = v_stored.root_sha256");
    expect(rootReader).toContain("'review_root', v_stored.review_root");
    expect(migration).toContain(
      "revoke execute on function public.get_stage1_human_review_root(text)\n  from public, anon, authenticated",
    );
    expect(migration).toContain(
      "grant execute on function public.get_stage1_human_review_root(text)\n  to service_role",
    );
  });

  it("locks and validates exact canonical candidate/source/snapshot state", () => {
    expect(fn).toContain("stage1-national-25-release");
    expect(fn).toContain("for share of source, snapshot");
    expect(fn).toContain("for share of candidate");
    expect(fn).toContain("snapshot.latest_object_keys");
    expect(fn).toContain("snapshot.latest_hashes");
    expect(fn).toContain("snapshot.latest_metadata");
    expect(fn).toContain("private.stage1_manifest_source_capture_binding_valid(");
    expect(fn).toContain("p_review_binding -> 'review_source_ids'");
    expect(fn).toContain("p_review_binding -> 'source_ids'");
    expect(fn).toContain("p_review_binding #> array['review_root', 'cohorts', '0', 'roles']");
    expect(fn).toContain("source.last_checked_at < v_now - interval '24 hours'");
    expect(fn).toContain("binding.value ->> 'candidate_status' is distinct from candidate.candidate_status");
    expect(fn).toContain("mutation.value ->> 'candidate_status' is distinct from 'selected'");
    expect(fn).toContain("candidate.shared_award_source_id = any(p_source_ids)");
  });

  it("keeps source relevance separate and enforces exact composition", () => {
    expect(fn).toContain("candidate.source_role not in ('primary', 'supporting')");
    expect(fn).toContain(
      "binding.value ->> 'source_relevance' is distinct from candidate.source_role",
    );
    expect(fn).toContain("binding.value ->> 'reviewed_stage1_source_role'");
    expect(fn).toContain("choice.value ->> 'composition_method' = 'direct_exact'");
    expect(fn).toContain("choice.value ->> 'composition_method' = 'ordered_array_items'");
    expect(fn).toContain("selected.composition_ordinality - 1");
    expect(fn).not.toContain(
      "role.value ->> 'source_role' = candidate.source_role",
    );
  });

  it("requires signed per-candidate immutable text evidence", () => {
    expect(migration).toContain(
      "create or replace function private.stage1_text_sha256(p_value text)",
    );
    expect(fn).toContain("choice.value -> 'candidate_evidence'");
    expect(fn).toContain("'awardping.stage1.candidate-immutable-evidence.v1'");
    expect(fn).toContain("'verification_method', 'exact_local_text_substring'");
    expect(fn).toContain("private.stage1_text_sha256(candidate.evidence_quote)");
    expect(fn).toContain("'snapshot', 'hashes', 'text_hash'");
    expect(fn).toContain("'snapshot', 'object_keys', 'text'");
    expect(fn).toContain("evidence_binding.value -> 'immutable_evidence'");
  });

  it("requires every candidate to come from the private reviewed-import ledger", () => {
    expect(fn).toContain(
      "left join private.stage1_reviewed_candidate_import_items imported_item",
    );
    expect(fn).toContain(
      "left join private.stage1_reviewed_candidate_import_bundles imported_bundle",
    );
    expect(fn).toContain(
      "'awardping.stage1.reviewed-candidate-import-item.v1'",
    );
    expect(fn).toContain(
      "imported_item.item_sha256 is null",
    );
    expect(fn).toContain(
      "imported_bundle.confirmation_sha256",
    );
    expect(fn).toContain(
      ") is distinct from imported_item.item_sha256",
    );
    expect(fn).toContain(
      "imported_bundle.candidate_count is distinct from",
    );
    expect(fn).toContain(
      "private.stage1_canonical_json_sha256(\n        imported_bundle.review_bundle",
    );
    expect(fn).toContain(
      "private.stage1_canonical_json_sha256(\n        imported_bundle.source_bindings",
    );
    expect(fn).toContain(
      "imported_bundle.confirmation_payload ->> 'candidates_sha256'",
    );
    expect(fn).toContain("persisted_source(value)");
    expect(fn).toContain("persisted_item(value)");
    expect(fn).toContain(
      "binding.value -> 'candidate_import' is distinct from",
    );
    expect(fn).toContain("candidate.source_page_request_id is not null");
    expect(fn).toContain("candidate.intake_value_sha256 is not null");
    expect(fn).toContain(
      "evidence_binding.value -> 'candidate_import' is not distinct from",
    );
    expect(fn).toContain(
      "imported_item.canonical_shared_award_id is distinct from p_shared_award_id",
    );
    expect(fn).toContain(
      "'canonical_shared_award_id', p_shared_award_id::text",
    );
    expect(fn).toContain(
      "persisted_source.value ->> 'shared_award_id' =\n            candidate.shared_award_id::text",
    );
  });

  it("recomputes the canonical review-root hash server-side", () => {
    expect(migration).toContain(
      "create or replace function private.stage1_canonical_json_text(p_value jsonb)",
    );
    expect(migration).toContain(
      "create or replace function private.stage1_canonical_json_sha256(p_value jsonb)",
    );
    expect(fn).toContain(
      "private.stage1_canonical_json_sha256(\n      p_review_binding -> 'review_root'",
    );
    expect(fn).toContain(
      "is distinct from p_review_binding ->> 'stage1_review_root_sha256'",
    );
    expect(migration).toContain("private.stage1_pgcrypto_sha256(");
    expect(migration).not.toContain("public.digest(");
  });

  it("blocks automatic Stage 1 success and exact-array drift at the database boundary", () => {
    expect(successGuard).toContain("new.status = 'succeeded'");
    expect(successGuard).toContain("registry.canonical_shared_award_id = new.shared_award_id");
    expect(successGuard).toContain("awardping.stage1.human-review-root.v1");
    expect(successGuard).toContain("reviewed_contributor_source_ids");
    expect(successGuard).toContain("reviewed_candidate_ids");
    expect(successGuard).toContain("pg_catalog.to_jsonb(new.source_ids)");
    expect(successGuard).toContain("pg_catalog.to_jsonb(new.candidate_ids)");
    expect(successGuard).toContain(
      "from private.stage1_human_review_roots review_root",
    );
    expect(successGuard).toContain(
      "review_root.canonical_shared_award_id = new.shared_award_id",
    );
    expect(successGuard).toContain(
      "registry.cohort_key = review_root.cohort_key",
    );
    expect(successGuard).toContain(
      "pg_catalog.cardinality(new.candidate_ids)",
    );
    expect(successGuard).toContain("reviewed_choice.value -> 'candidate_ids'");
    expect(successGuard).toContain("pg_catalog.cardinality(new.source_ids)");
    expect(successGuard).toContain(
      "reviewed_choice.value -> 'candidate_evidence'",
    );
    expect(successGuard).toContain(
      "private.stage1_safe_uuid(reviewed_candidate.value)",
    );
    expect(migration).toContain(
      "create trigger enforce_stage1_reviewed_reconciliation_success",
    );
    expect(migration).toContain(
      "before update of status on public.shared_award_reconciliation_queue",
    );
  });

  it("forbids materialization and delegates to the existing atomic commit", () => {
    expect(fn).toContain("pg_catalog.jsonb_array_length(p_generated_candidates) <> 0");
    expect(fn).toContain("v_result := public.commit_award_reconciliation_publication(");
    expect(fn).toContain("p_generated_candidates,");
    expect(fn).toContain("p_candidate_status_updates,");
    expect(fn.indexOf("for share of source, snapshot")).toBeLessThan(
      fn.indexOf("public.commit_award_reconciliation_publication("),
    );
    const metadataBind = fn.indexOf(
      "'stage1_review_root_schema_version',",
    );
    const coreCommit = fn.indexOf(
      "v_result := public.commit_award_reconciliation_publication(",
    );
    expect(metadataBind).toBeGreaterThan(-1);
    expect(metadataBind).toBeLessThan(coreCommit);
    expect(fn).toContain("and queue.status = 'processing'");
    expect(fn).toContain("and queue.generation = p_expected_queue_generation");
    expect(fn).toContain("and queue.source_ids = p_source_ids");
    expect(fn).toContain("and queue.candidate_ids = p_candidate_ids");
  });

  it("records the review root in reconciliation and immutable audit evidence", () => {
    for (const contract of [
      "selection_mode', 'explicit_human_review'",
      "selection_sha256",
      "selection_state_hash",
      "stage1_review_root_schema_version",
      "stage1_review_root_sha256",
      "reviewed_contributor_source_ids",
      "reviewed_candidate_ids",
      "reviewed_at",
      "paid_api_calls', 0",
      "ranked_candidates_accepted', 0",
      "monitoring_sources_retired', 0",
    ]) {
      expect(fn).toContain(contract);
    }
    expect(fn).toContain("v_expected_audit_projection");
    expect(fn).toContain("into v_audit_id, v_persisted_audit_row_sha256");
    expect(fn).not.toContain("update public.shared_award_page_audits audit");
  });

  it("is service-only and uses an empty definer search path", () => {
    expect(fn).toContain("security definer");
    expect(fn).toContain("set search_path = ''");
    expect(migration).toContain(") from public, anon, authenticated;");
    expect(migration).toContain(") to service_role;");
    expect(migration).not.toMatch(
      /grant execute on function public\.commit_reviewed_stage1_reconciliation_publication\([\s\S]+?\) to (?:public|anon|authenticated);/i,
    );
  });
});

function section(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  if (startIndex < 0 || endIndex < 0) {
    throw new Error(`Missing migration section: ${start}`);
  }
  return source.slice(startIndex, endIndex);
}
