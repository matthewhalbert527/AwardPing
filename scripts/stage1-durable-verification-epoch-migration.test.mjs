import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/20260717133922_durable_stage1_verification_epoch.sql",
    import.meta.url,
  ),
  "utf8",
);

const effectiveFunction = migration.slice(
  migration.indexOf(
    "create or replace function public.stage1_effective_publication_reason(",
  ),
  migration.indexOf(
    "revoke all on function public.stage1_effective_publication_reason(",
  ),
);
const effectiveListFunction = migration.slice(
  migration.indexOf(
    "create or replace function public.list_stage1_effective_publication()",
  ),
  migration.indexOf(
    "revoke all on function public.list_stage1_effective_publication()",
  ),
);
const durableTimestampFunction = migration.slice(
  migration.indexOf(
    "create or replace function private.stage1_durable_verification_timestamp_valid(",
  ),
  migration.indexOf(
    "revoke all on function private.stage1_durable_verification_timestamp_valid(",
  ),
);
const liveSourceTimestampFunction = migration.slice(
  migration.indexOf(
    "create or replace function private.stage1_live_source_check_current(",
  ),
  migration.indexOf(
    "revoke all on function private.stage1_live_source_check_current(",
  ),
);
const sourceCaptureBindingFunction = migration.slice(
  migration.indexOf(
    "create or replace function private.stage1_manifest_source_capture_binding_valid(",
  ),
  migration.indexOf(
    "revoke all on function private.stage1_manifest_source_capture_binding_valid(",
  ),
);
const safeTimestampFunction = migration.slice(
  migration.indexOf(
    "create or replace function private.stage1_safe_timestamptz(",
  ),
  migration.indexOf(
    "revoke all on function private.stage1_safe_timestamptz(",
  ),
);
const r2ObjectSetFunction = migration.slice(
  migration.indexOf(
    "create or replace function private.stage1_visual_r2_object_set_snapshot()",
  ),
  migration.indexOf(
    "revoke all on function private.stage1_visual_r2_object_set_snapshot()",
  ),
);
const r2ManifestFunction = migration.slice(
  migration.indexOf(
    "create or replace function public.get_stage1_release_r2_verification_manifest()",
  ),
  migration.indexOf(
    "revoke all on function public.get_stage1_release_r2_verification_manifest()",
  ),
);

describe("durable Stage 1 verification epoch migration", () => {
  it("expires only live bound-source checks on the rolling 24-hour clock", () => {
    expect(effectiveFunction).not.toContain("interval '24 hours'");
    expect(liveSourceTimestampFunction).toContain(
      "p_checked_at >= p_evaluated_at - interval '24 hours'",
    );
    expect(effectiveFunction).toContain(
      "private.stage1_live_source_check_current(\n          source.last_checked_at, p_evaluated_at",
    );

    for (const expiredImmutableCheck of [
      "v_registry.evidence_checked_at < p_evaluated_at - interval '24 hours'",
      "v_registry.last_verified_at < p_evaluated_at - interval '24 hours'",
      "manifest.checked_at >= p_evaluated_at - interval '24 hours'",
      "snapshot.latest_captured_at < p_evaluated_at - interval '24 hours'",
      "v_latest_reconciliation.completed_at < p_evaluated_at - interval '24 hours'",
      "v_latest_audit.created_at < p_evaluated_at - interval '24 hours'",
    ]) {
      expect(effectiveFunction).not.toContain(expiredImmutableCheck);
    }
  });

  it("keeps signed R2 out of award promotion and inside national public release", () => {
    expect(effectiveFunction).not.toContain(
      "private.stage1_current_valid_release_artifact(",
    );
    expect(effectiveFunction).not.toContain(
      "signed_r2_recovery_artifact_not_current",
    );
    expect(effectiveListFunction).toContain(
      "private.stage1_current_valid_release_artifact(",
    );
    expect(effectiveListFunction).toContain(
      "'r2_recovery_drill', evaluated.evaluated_at",
    );
    for (const exactCurrentObjectSetFence of [
      "private.stage1_visual_r2_object_set_snapshot() as value",
      "artifact.evidence ->> 'visual_object_set_hash'",
      "r2_object_set.value ->> 'visual_object_set_hash'",
      "artifact.evidence ->> 'visual_objects_checked'",
      "r2_object_set.value ->> 'visual_object_count'",
      "r2_object_set.value ->> 'unexpected_bucket_count' = '0'",
      "r2_object_set.value ->> 'malformed_object_count' = '0'",
      "r2_object_set.value ->> 'manifest_binding_error_count' = '0'",
    ]) {
      expect(effectiveListFunction).toContain(exactCurrentObjectSetFence);
    }
    expect(effectiveListFunction).toContain(
      "then 'signed_r2_recovery_artifact_not_current'",
    );
    expect(effectiveListFunction).toContain(
      "cohort_reasons.readiness_reason = 'verified' as cohort_ready",
    );
    expect(effectiveListFunction).toContain(
      "release_decision.decision_reason = 'verified' as effectively_verified",
    );
  });

  it("accepts only complete immutable source capture generations", () => {
    for (const contract of [
      "'/captures/[0-9a-f]{32}/page[.]jpg$'",
      "'/captures/[0-9a-f]{32}/document[.]pdf$'",
      "not (p_object_keys ?& array['page', 'thumb', 'text', 'meta'])",
      "not (p_object_keys ?& array['pdf', 'text', 'meta'])",
      "object_entry.value #>> '{}' ~* '(^|/)latest(/|$)'",
      "when object_entry.key = 'thumb'",
      "v_generation_prefix || 'thumb.jpg'",
      "when object_entry.key = 'meta'",
      "v_generation_prefix || 'meta.json'",
      "when object_entry.key ~ '^expansion_state_[0-9]{2}$'",
      "when object_entry.key ~ '^expansion_state_[0-9]{2}_layout$'",
      "else true",
      "count(distinct object_entry.value)",
      "coalesce(p_metadata ->> 'text_object_bytes', '') !~ '^[1-9][0-9]*$'",
      "v_text_key is distinct from (v_generation_prefix || 'text.txt')",
    ]) {
      expect(sourceCaptureBindingFunction).toContain(contract);
    }
    expect(effectiveFunction).toContain(
      "private.stage1_manifest_source_capture_binding_valid(",
    );
  });

  it("unions published events with every manifest-bound core source object", () => {
    for (const contract of [
      "from public.stage1_award_source_manifest manifest",
      "cross join unnest(manifest.source_ids) source_id",
      "left join public.shared_award_source_visual_snapshots snapshot",
      "binding_valid is not true",
      "'published_event'::text as object_scope",
      "'manifest_source'::text as object_scope",
      "source.object_keys ->> 'page'",
      "source.hashes ->> 'image_hash'",
      "source.object_keys ->> 'pdf'",
      "source.hashes ->> 'file_hash'",
      "source.object_keys ->> 'text'",
      "source.hashes ->> 'text_hash'",
      "'utf8_text_single_trailing_newline_v1'::text",
      "source.metadata ->> 'text_object_bytes'",
      "'manifest_binding_error_count'",
    ]) {
      expect(r2ObjectSetFunction).toContain(contract);
    }
    expect(r2ObjectSetFunction).not.toContain("publication_state");
    expect(r2ObjectSetFunction).not.toContain(
      "stage1_current_valid_release_artifact",
    );
    expect(r2ObjectSetFunction).not.toContain(
      "private.stage1_visual_r2_object_set_snapshot() as value",
    );
    expect(r2ManifestFunction).toContain(
      "'awardping.stage1.r2-verification-manifest.v2'",
    );
    expect(r2ManifestFunction).toContain("'manifest_source_object_count'");
  });

  it("retains future-date fences for every durable evidence timestamp", () => {
    expect(durableTimestampFunction).toContain(
      "p_evidence_at <= p_evaluated_at + interval '5 minutes'",
    );
    expect(liveSourceTimestampFunction).toContain(
      "p_checked_at <= p_evaluated_at + interval '5 minutes'",
    );
    for (const durableTimestamp of [
      "v_registry.evidence_checked_at, p_evaluated_at",
      "v_registry.last_verified_at, p_evaluated_at",
      "manifest.checked_at, p_evaluated_at",
      "manifest.evidence ->> 'r2_verified_at'",
      "manifest.evidence ->> 'local_verified_at'",
      "snapshot.latest_captured_at, p_evaluated_at",
      "v_latest_reconciliation.completed_at, p_evaluated_at",
      "v_latest_audit.created_at, p_evaluated_at",
    ]) {
      expect(effectiveFunction).toContain(durableTimestamp);
    }
    expect(effectiveFunction).toContain("return 'evaluation_time_invalid';");
    expect(effectiveFunction).toContain(
      "p_evaluated_at > pg_catalog.statement_timestamp() + interval '5 minutes'",
    );
  });

  it("turns malformed evidence timestamps into blockers instead of SQL exceptions", () => {
    expect(safeTimestampFunction).toContain("exception when others then");
    expect(safeTimestampFunction).toContain("return null;");
    expect(effectiveFunction).not.toContain(")::timestamptz");
    expect(effectiveFunction.match(/private\.stage1_safe_timestamptz\(/g)).toHaveLength(4);
    expect(migration).not.toMatch(
      /grant execute on function private\.stage1_safe_timestamptz/i,
    );
  });

  it("still closes on live failures, newer failed work, identity drift, or quarantine", () => {
    for (const failClosedContract of [
      "source.admin_review_status <> 'open'",
      "nullif(pg_catalog.btrim(source.last_error), '') is not null",
      "snapshot.latest_object_keys",
      "snapshot.latest_hashes",
      "is distinct from snapshot.latest_captured_at",
      "candidate.candidate_status <> 'selected'",
      "order by queue.created_at desc, queue.id desc",
      "v_latest_reconciliation.status <> 'succeeded'",
      "order by audit.created_at desc, audit.id desc",
      "and audit.audit_kind = 'deterministic'",
      "v_latest_audit.audit_status <> 'passed'",
      "page_audit_failure_open",
      "actionable_quarantine_open",
      "ledger.reconciliation_id <> v_latest_reconciliation.id",
      "ledger.page_audit_id <> v_latest_audit.id",
      "snapshot.latest_hashes is distinct from ledger.source_snapshot_hashes",
      "fact_ledger_binding_invalid",
    ]) {
      expect(effectiveFunction).toContain(failClosedContract);
    }
  });

  it("separates the full reviewed source allowlist from exact reconciliation contributors", () => {
    expect(effectiveFunction).toContain(
      "A reviewed manifest\n  -- may additionally retain monitor-only evidence",
    );
    expect(effectiveFunction).not.toContain(
      "cross join unnest(manifest.source_ids) source_id\n    where manifest.cohort_key = p_cohort_key\n      and not (source_id = any(v_latest_reconciliation.source_ids))",
    );

    for (const contributorFence of [
      "from unnest(v_latest_reconciliation.source_ids) source_id",
      "member.shared_award_id = source.shared_award_id",
      "source_id = any(manifest.source_ids)",
      "from public.shared_award_fact_candidates contributor",
      "contributor.id = any(v_latest_reconciliation.candidate_ids)",
      "contributor.shared_award_source_id = source_id",
      "(manifest.evidence -> 'fact_candidate_ids') ? contributor.id::text",
      "not (source.id = any(v_latest_reconciliation.source_ids))",
    ]) {
      expect(effectiveFunction).toContain(contributorFence);
    }
  });

  it("preserves the service-only fail-closed function contract", () => {
    expect(effectiveFunction).toContain("stable");
    expect(effectiveFunction).toContain("security definer");
    expect(effectiveFunction).toContain("set search_path = ''");
    expect(migration).toMatch(
      /revoke all on function public\.stage1_effective_publication_reason\(text, timestamptz\)\s+from public, anon, authenticated, service_role;/,
    );
    expect(migration).not.toMatch(
      /grant execute on function public\.stage1_effective_publication_reason/i,
    );
    expect(migration).not.toMatch(
      /grant execute on function private\.stage1_(?:durable_verification_timestamp_valid|live_source_check_current)/i,
    );
  });
});
