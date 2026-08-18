import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadModule, parseSync } from "libpg-query";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/20260803170658_stage1_source_disposition_activation.sql",
    import.meta.url,
  ),
  "utf8",
);

const applyRpc = section(
  migration,
  "create or replace function public.apply_reviewed_stage1_source_dispositions(",
  "revoke all on function public.apply_reviewed_stage1_source_dispositions(",
);
const prepareRpc = section(
  migration,
  "create or replace function public.record_stage1_source_baseline_activation(",
  "revoke all on function public.record_stage1_source_baseline_activation(",
);
const finalizeRpc = section(
  migration,
  "create or replace function public.finalize_stage1_source_baseline_activation(",
  "revoke all on function public.finalize_stage1_source_baseline_activation(",
);
const failureRpc = section(
  migration,
  "create or replace function public.fail_stage1_source_baseline_activation(",
  "revoke all on function public.fail_stage1_source_baseline_activation(",
);
const sourceFence = section(
  migration,
  "create or replace function public.preserve_stage1_baseline_monitoring_approval()",
  "revoke all on function public.preserve_stage1_baseline_monitoring_approval()",
);

describe("Stage 1 reviewed baseline-source disposition activation migration", () => {
  it("is parseable as PostgreSQL and installs the normalized identity invariant", async () => {
    await loadModule();
    expect(() => parseSync(migration)).not.toThrow();
    expect(migration).not.toContain("pg_catalog.extract(");
    expect(migration).not.toMatch(/is distinct from case\b/i);
    expect(migration).toContain(
      "create unique index if not exists shared_award_sources_award_normalized_url_uidx",
    );
    expect(migration).toContain("Duplicate normalized shared-award source identities");
    expect(migration).toContain("pg_catalog.split_part(url, '#', 1)");
  });

  it("hard-binds the exact reviewed 10+1 plan, state, review, and zero-work contract", () => {
    expect(applyRpc).toContain(
      "8a1c1d9aa8ccbdf1dcdbb7b2f4b83ac19c99dd9557a8949dff5f63dd22d1026f",
    );
    expect(applyRpc).toContain(
      "5773e66daa7726642f6c4442f5ad1db581ed598aaf2584d5ac5db141d141915a",
    );
    expect(applyRpc).toContain(
      "302bbdd44cd2366bcf811ad0c7ea75b8a2b901c5e235ef6925b08bdfcd8ea1c9",
    );
    expect(applyRpc).toContain("2026-08-03T17:17:45.549Z");
    expect(applyRpc).toContain(
      "Approve baseline-only for items 1–6 and 8–11. Keep item 7, Luce funding, quarantined. The other task is finished.",
    );
    expect(applyRpc).toContain("v_approved_count <> 10");
    expect(applyRpc).toContain("v_quarantined_count <> 1");
    expect(applyRpc).toContain(
      "v_safety -> 'source_activation_before_visual_baseline'\n      is distinct from '0'::jsonb",
    );
    expect(applyRpc).toContain("'application_mode', 'atomic_10_plus_1'");
    expect(applyRpc).toContain("'paid_api_calls', 0");
    expect(applyRpc).toContain("'public_fact_writes', 0");
    expect(applyRpc).toContain("'fact_candidates', 0");
    expect(applyRpc).toContain("'reconciliation_requests', 0");
    expect(applyRpc).toContain("'first_observation_notifications', 0");
  });

  it("uses an acyclic item hash and exact locked request/source/acquisition CAS", () => {
    for (const excluded of [
      "- 'decision_item_sha256'",
      "- 'source_payload'",
      "- 'acquisition_payload'",
      "- 'request_patch'",
    ]) expect(applyRpc).toContain(excluded);
    expect(migration).toContain("decision_payload\n        - 'decision_item_sha256'");
    expect(migration).toContain("- 'request_patch'\n    ) = decision_item_sha256");
    expect(applyRpc).toContain("for update;");
    expect(applyRpc).toContain("request.updated_at = v_request.updated_at");
    expect(applyRpc).toContain("source.updated_at = v_source.updated_at");
    expect(migration).toContain(
      "shared_award_sources_award_normalized_url_uidx",
    );
    expect(applyRpc).toContain("private.stage1_source_disposition_uuid('source'");
    expect(applyRpc).toContain("private.stage1_source_disposition_uuid(\n        'acquisition'");
    expect(applyRpc).toContain("'fa4088a7-706e-4ad3-ae12-3653751dd5e1'::uuid");
  });

  it("terminates the ten approved intake requests but leaves every source held", () => {
    expect(applyRpc).toContain("v_request_patch ->> 'status' is distinct from 'added'");
    expect(applyRpc).toContain(
      "stage1_baseline_source_added_pending_exact_visual_activation",
    );
    expect(applyRpc).toContain("then array[v_source_id]::uuid[]");
    expect(applyRpc).toContain("processed_at = case");
    expect(applyRpc).toContain("admin_review_status = 'review_later'");
    expect(applyRpc).toContain("approved_pending_exact_first_visual_baseline");
    expect(applyRpc).toContain("stage1-baseline-source-disposition");
    expect(applyRpc).not.toContain("admin_review_status = 'open'");
  });

  it("retains monitoring-only metadata and strips stale NDSEG fact metadata", () => {
    expect(migration).toContain("awardping.stage1.baseline-monitoring-approval.v1");
    expect(migration).toContain("p_approval -> 'public_fact_authority' = 'false'::jsonb");
    expect(migration).toContain("p_approval -> 'fact_candidate_authority' = 'false'::jsonb");
    expect(applyRpc).toContain("- 'baseline_facts'");
    expect(applyRpc).toContain("- 'baseline_facts_metadata'");
    expect(applyRpc).toContain("page_metadata = v_source_payload -> 'page_metadata'");
    expect(sourceFence).toContain("current_setting(");
    expect(sourceFence).toContain("stage1_source_disposition_confirmation");
    expect(sourceFence).toContain("cannot be deleted");
    expect(sourceFence).toContain("stage1_source_baseline_activation_finalizations");
    expect(migration).toContain(
      "before insert or update of page_metadata, shared_award_id, url, admin_review_status or delete",
    );
  });

  it("creates immutable bundle, item, prepare, finalization, and failure ledgers", () => {
    for (const table of [
      "stage1_source_disposition_bundles",
      "stage1_source_disposition_items",
      "stage1_source_baseline_activation_receipts",
      "stage1_source_baseline_activation_finalizations",
      "stage1_source_baseline_activation_failures",
    ]) {
      expect(migration).toContain(`create table private.${table}`);
      expect(migration).toContain(`private.${table}`);
    }
    expect(migration).toContain(
      "Reviewed Stage 1 source disposition and activation receipts are immutable.",
    );
    expect(migration).toContain(
      "before update or delete on private.stage1_source_baseline_activation_finalizations",
    );
    expect(migration).toContain(
      "private.stage1_canonical_json_sha256(receipt) = prepare_receipt_sha256",
    );
    expect(migration).toContain(
      "private.stage1_canonical_json_sha256(receipt) = finalization_receipt_sha256",
    );
  });

  it("keeps Luce source-free and acquisition-free in durable operator quarantine", () => {
    expect(applyRpc).toContain("The quarantined Luce decision may not carry source or acquisition payloads.");
    expect(applyRpc).toContain("stage1:source-intake:luce-funding:");
    expect(applyRpc).toContain("stage1_human_source_quarantined_role_mismatch");
    expect(applyRpc).toContain("'actionable_quarantine'");
    expect(applyRpc).toContain("'public_page'");
    expect(applyRpc).toContain("'retry_charge', 'none'");
    expect(applyRpc).toContain("public.manual_quarantine_evidence_hash");
  });

  it("separates prepare from persistence-backed finalization", () => {
    expect(prepareRpc).toContain("'status', 'prepared_not_open'");
    expect(prepareRpc).toContain("'prepare_receipt_sha256'");
    expect(prepareRpc).not.toContain("admin_review_status = 'open'");
    expect(finalizeRpc).toContain(
      "private.stage1_activation_persistence_evidence_valid(",
    );
    expect(migration).toContain("p_evidence -> 'local_baseline_written'");
    expect(migration).toContain("p_evidence -> 'r2_sync_succeeded'");
    expect(finalizeRpc).toContain("v_source.last_checked_at is null");
    const ledgerInsert = finalizeRpc.indexOf(
      "insert into private.stage1_source_baseline_activation_finalizations",
    );
    const openCas = finalizeRpc.lastIndexOf("admin_review_status = 'open'");
    expect(ledgerInsert).toBeGreaterThan(-1);
    expect(openCas).toBeGreaterThan(ledgerInsert);
    expect(finalizeRpc).toContain("exact_first_visual_baseline_verified");
  });

  it("re-holds failures, preserves post-persistence proof, and opens visual quarantine", () => {
    expect(failureRpc).toContain("p_evidence -> 'persistence_evidence'");
    expect(failureRpc).toContain("baseline_written");
    expect(failureRpc).toContain("r2_sync_succeeded");
    expect(failureRpc).toContain("admin_review_status = 'review_later'");
    expect(failureRpc).toContain("stage1_baseline_activation_failed:");
    expect(failureRpc).toContain("last_error = 'Stage 1 baseline activation failed:");
    expect(failureRpc).toContain("'visual_review'");
    expect(failureRpc).toContain("'quarantined'");
    expect(failureRpc).toContain("'creates_api_charge', false");
    expect(failureRpc).toContain("'public_event_created', false");
  });

  it("exposes every mutating RPC only to service_role", () => {
    for (const signature of [
      "public.apply_reviewed_stage1_source_dispositions(\n  jsonb, text\n)",
      "public.record_stage1_source_baseline_activation(\n  uuid, uuid, text, text\n)",
      "public.finalize_stage1_source_baseline_activation(\n  uuid, uuid, text, text, text, jsonb\n)",
      "public.fail_stage1_source_baseline_activation(\n  uuid, uuid, uuid, text, jsonb\n)",
    ]) {
      expect(migration).toContain(`revoke all on function ${signature}`);
      expect(migration).toContain(`grant execute on function ${signature}`);
    }
    expect(migration).not.toMatch(/grant execute on function[\s\S]+?to authenticated;/);
  });
});

function section(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  if (from < 0 || to < 0) throw new Error(`Missing section ${start}`);
  return source.slice(from, to);
}
