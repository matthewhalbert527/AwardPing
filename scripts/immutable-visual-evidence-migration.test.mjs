import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/20260715143000_immutable_change_event_visual_evidence.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("immutable change-event visual evidence migration", () => {
  it("binds each new visual event to one review candidate and evidence row", () => {
    expect(migration).toContain(
      "add column if not exists visual_review_candidate_id uuid",
    );
    expect(migration).toContain(
      "create table if not exists public.shared_award_change_event_visual_evidence",
    );
    expect(migration).toContain(
      "change_event_id uuid primary key",
    );
    expect(migration).toContain(
      "visual_review_candidate_id uuid\n    references public.shared_award_visual_review_candidates(id) on delete restrict",
    );
    expect(migration).toContain(
      "shared_award_change_event_visual_evidence_candidate_idx",
    );
    expect(migration).toContain("where visual_review_candidate_id is not null");
  });

  it("stores permanent, versioned side manifests and honest localization states", () => {
    for (const column of [
      "previous_capture jsonb",
      "current_capture jsonb",
      "localization jsonb",
      "evidence_schema_version text",
      "verified_at timestamptz",
      "backfilled_at timestamptz",
    ]) {
      expect(migration).toContain(column);
    }
    for (const status of [
      "verified",
      "unavailable_exact_text_missing",
      "unavailable_geometry_missing",
      "unavailable_image_missing",
      "unavailable_ambiguous",
      "historical_artifact_unrecoverable",
      "full_screenshot_fallback",
      "not_applicable_pdf",
    ]) {
      expect(migration).toContain(`'${status}'`);
    }
    expect(migration).toContain("visual-snapshots/published/%");
    expect(migration).toContain("^[0-9a-f]{64}$");
    expect(migration).toContain(
      "'/' || (p_artifact ->> 'sha256') || E'\\\\.[a-z0-9]+$'",
    );
    expect(migration).toContain("crop,exact_overlap");
    expect(migration).toContain(
      "create or replace function public.awardping_validate_capture_artifact_references(",
    );
    expect(migration).toContain("'main_full'");
    expect(migration).toContain("from jsonb_array_elements(p_capture -> 'states')");
    expect(migration).toContain("count(distinct state.value ->> 'state_id')");
    expect(migration).toContain(
      "states require unique, non-empty state_id values.",
    );
  });

  it("permits candidate-free rows only as truthful non-verified historical backfill", () => {
    expect(migration).toContain("visual_review_candidate_id is null");
    expect(migration).toContain("backfilled_at is not null");
    expect(migration).toContain("verified_at is null");
    expect(migration).toContain("evidence_status <> 'verified'");
    expect(migration).toContain(
      "Candidate-free visual evidence is allowed only after explicit terminal artifact-loss confirmation.",
    );
  });

  it("publishes the event and immutable evidence atomically and fails closed on mismatch", () => {
    expect(migration).toContain(
      "create or replace function public.publish_shared_award_visual_event(\n  p_event jsonb,\n  p_evidence jsonb",
    );
    expect(migration).toContain(
      "returns table(change_event_id uuid, evidence_id uuid, inserted boolean)",
    );
    expect(migration).toContain(
      "New visual publication requires visual_review_candidate_id.",
    );
    expect(migration).toContain(
      "on conflict (shared_award_id, source_url, previous_hash, new_hash) do nothing",
    );
    expect(migration).toContain(
      "on conflict on constraint shared_award_change_event_visual_evidence_pkey do nothing",
    );
    expect(migration).toContain(
      "Existing immutable visual evidence conflicts with this publication retry.",
    );
    expect(migration).toContain(
      "v_existing_evidence.previous_capture <> v_previous_capture",
    );
    expect(migration).toContain(
      "v_existing_evidence.localization <> v_localization",
    );
    expect(migration).toContain(
      "v_existing_event.summary is distinct from v_summary",
    );
    expect(migration).toContain(
      "v_existing_event.change_details is distinct from v_change_details",
    );
    expect(migration).toContain(
      "Only a successfully reviewed visual candidate can be published.",
    );
    expect(migration).toContain(
      "Evidence candidate signature/award/source identity does not match the event.",
    );
  });

  it("requires complete immutable manifests and direction-specific exact crops", () => {
    expect(migration).toContain(
      "Published webpage evidence requires bucket and immutable previous/current full images, metadata, and capture hashes.",
    );
    expect(migration).toContain("{capture_hashes,image_hash}");
    expect(migration).toContain("{capture_hashes,text_hash}");
    expect(migration).toContain("{layout,object_key}");
    expect(migration).toContain("jsonb_array_elements(v_previous_capture -> 'states')");
    expect(migration).toContain(
      "Added wording must be verified in the current crop.",
    );
    expect(migration).toContain(
      "Removed wording must be verified in the previous crop.",
    );
    expect(migration).toContain(
      "Changed wording must be verified in both event crops.",
    );
    expect(migration).toContain("v_current_exact is not true");
    expect(migration).toContain("v_previous_exact is not true");
    expect(migration).toContain(
      "create or replace function public.awardping_validate_exact_visual_evidence(",
    );
    expect(migration).toContain("{layout,geometry_hash}");
    expect(migration).toContain(
      "perform public.awardping_validate_exact_visual_evidence(",
    );
    expect(migration).toContain(
      "create or replace function public.awardping_visual_rectangles_overlap(",
    );
    expect(migration).toContain(
      "bool_and(public.awardping_visual_rectangles_overlap",
    );
    expect(migration).toContain(
      "p_capture #>> '{crop,clip,width}' = p_side_localization #>> '{crop_rect_pixels,width}'",
    );
    expect(migration).toContain(
      "p_capture #>> '{crop,source_image_object_key}' = p_capture #>> '{full,object_key}'",
    );
    expect(migration).toContain(
      "p_capture #>> '{crop,source_image_sha256}' = p_capture #>> '{full,sha256}'",
    );
    expect(migration).toContain(
      "p_capture #>> '{crop,source_image_byte_length}' = p_capture #>> '{full,byte_length}'",
    );
    expect(migration).toContain(
      "p_capture #>> '{crop,source_image_object_key}' = p_capture #>> '{full,object_key}'",
    );
    expect(migration).toContain(
      "p_capture #>> '{crop,source_image_sha256}' = p_capture #>> '{full,sha256}'",
    );
    expect(migration).toContain(
      "p_capture #>> '{crop,source_image_byte_length}' = p_capture #>> '{full,byte_length}'",
    );
    expect(migration).toContain(
      "Verified %s evidence must bind exact text rectangles to the same immutable layout, screenshot, and overlapping CSS/pixel crop.",
    );
    expect(migration.match(/awardping_validate_exact_visual_evidence_side\(/g)?.length).toBeGreaterThanOrEqual(7);
    expect(migration).toContain(
      "Published PDF evidence requires bucket, previous/current documents, metadata, capture hashes, timestamps, and state IDs.",
    );
    expect(migration).toContain(
      "v_previous_capture #>> '{full,sha256}' is distinct from\n        v_previous_capture #>> '{capture_hashes,file_hash}'",
    );
  });

  it("backfills history insert-once without overstating missing artifacts", () => {
    expect(migration).toContain(
      "create or replace function public.backfill_shared_award_visual_event_evidence(\n  p_event_id uuid,\n  p_evidence jsonb",
    );
    expect(migration).toContain(
      "returns table(change_event_id uuid, evidence_id uuid, inserted boolean)",
    );
    expect(migration).toContain(
      "Candidate-free historical evidence requires explicit terminal artifact-loss confirmation and empty unrecoverable manifests.",
    );
    expect(migration).toContain("terminal_artifact_loss_confirmed");
    expect(migration).toContain("terminal_artifact_loss_reason");
    expect(migration).toContain(
      "Unrecoverable historical evidence must use empty captures and no artifact bucket.",
    );
    expect(migration).toContain(
      "Historical candidate has no exact direct, signature, or reverse event binding.",
    );
    expect(migration).toContain(
      "Existing immutable visual evidence conflicts with this historical backfill retry.",
    );
    expect(migration).toContain(
      "Historical PDF documents must match their file hashes and carry PDF/JSON content types.",
    );
    expect(migration).toContain(
      "The retained previous historical PDF side failed document/metadata/file-hash validation.",
    );
    expect(migration).toContain(
      "The retained current historical PDF side failed document/metadata/file-hash validation.",
    );
    expect(migration).toContain("backfilled_at");
  });

  it("binds every candidate artifact, selected state, and state hash to the immutable candidate", () => {
    expect(migration).toContain(
      "create or replace function public.awardping_validate_candidate_snapshot_manifest(",
    );
    expect(migration).toContain("artifact_manifest_digest");
    expect(migration).toContain("previous_artifact_manifest_digest");
    expect(migration).toContain("new_artifact_manifest_digest");
    expect(migration).toContain(
      "snapshot artifact manifest does not equal its flattened file references.",
    );
    expect(migration).toContain(
      "snapshot artifact manifest digest does not match its canonical entries.",
    );
    expect(migration).toContain(
      "create or replace function public.awardping_assert_candidate_artifact_matches(",
    );
    expect(migration).toContain(
      "bytes do not match its candidate archive reference.",
    );
    expect(migration).toContain(
      "create or replace function public.awardping_validate_candidate_capture_prefix(",
    );
    expect(migration).toContain(
      "'visual-snapshots/published/%s/%s/'",
    );
    expect(migration).toContain(
      "is outside its immutable candidate/side namespace.",
    );
    expect(migration).toContain(
      "create or replace function public.awardping_validate_capture_state_binding(",
    );
    expect(migration).toContain(
      "full image manifest does not equal its selected state image.",
    );
    expect(migration).toContain(
      "layout manifest does not equal its selected state geometry.",
    );
    expect(migration).toContain(
      "retained main image does not match its capture and candidate hashes.",
    );
    expect(migration).toContain(
      "state %s image hash does not match its candidate snapshot reference.",
    );
    expect(migration).toContain(
      "state %s geometry hash does not match its candidate snapshot reference.",
    );
    expect(
      migration.match(/awardping_validate_candidate_capture_binding\(/g)?.length,
    ).toBeGreaterThanOrEqual(6);
  });

  it("makes evidence immutable and forces candidate-bound events to carry it", () => {
    expect(migration).toContain(
      "before update or delete on public.shared_award_change_event_visual_evidence",
    );
    expect(migration).toContain(
      "Published visual evidence is immutable; do not replace it in place.",
    );
    expect(migration).toContain(
      "A published change event review-candidate binding is immutable.",
    );
    expect(migration).toContain(
      "A candidate-bound published change event identity is immutable; only suppression fields may change.",
    );
    expect(migration).toContain(
      "before update on public.shared_award_change_events",
    );
    expect(migration).toContain(
      "new.change_details is distinct from old.change_details",
    );
    expect(migration).toContain(
      "create constraint trigger awardping_require_visual_event_evidence_trigger",
    );
    expect(migration).toContain("deferrable initially deferred");
    expect(migration).toContain(
      "requires immutable visual evidence in the same transaction.",
    );
    expect(migration).toContain(
      "create or replace function public.awardping_preserve_published_visual_candidate_identity()",
    );
    expect(migration).toContain(
      "before update on public.shared_award_visual_review_candidates",
    );
    expect(migration).toContain(
      "A visual review candidate snapshot and artifact-manifest binding is immutable after enqueue.",
    );
    expect(migration).toContain(
      "A submitted visual review candidate identity and deterministic evidence are immutable.",
    );
    expect(migration).toContain(
      "A published visual review candidate provider identity and review result are immutable.",
    );
    for (const identityField of [
      "new.previous_snapshot_ref is distinct from old.previous_snapshot_ref",
      "new.new_snapshot_ref is distinct from old.new_snapshot_ref",
      "new.previous_image_hash is distinct from old.previous_image_hash",
      "new.new_image_hash is distinct from old.new_image_hash",
      "new.deterministic_diff is distinct from old.deterministic_diff",
      "new.prompt_payload is distinct from old.prompt_payload",
      "new.model is distinct from old.model",
      "new.gemini_batch_name is distinct from old.gemini_batch_name",
      "new.ai_result is distinct from old.ai_result",
    ]) {
      expect(migration).toContain(identityField);
    }
    expect(migration).toContain(
      "old.status <> 'pending' or new.status <> 'pending' or v_has_evidence",
    );
  });

  it("retires sources atomically without deleting immutable or user-owned history", () => {
    expect(migration).toContain(
      "create or replace function public.retire_shared_award_source_preserving_visual_history(",
    );
    expect(migration).toContain(
      "returns table(\n  source_id uuid,\n  matched_event_count integer,\n  newly_suppressed_event_count integer,\n  already_suppressed_event_count integer,\n  already_retired boolean,\n  homepage_cleared boolean\n)",
    );
    expect(migration).toContain("suppression_source = 'source_retirement'");
    expect(migration).toContain("admin_review_status = 'review_later'");
    expect(migration).toContain("and award.official_homepage = v_source.url");
    expect(migration).toContain("get diagnostics v_homepage_clear_count = row_count;");
    expect(migration).toContain("for update;");
    expect(migration).toContain("for share;");
    expect(migration).toContain(
      "Visual publication requires an open shared award source.",
    );
    expect(migration).toContain(
      "Visual publication requires an active shared award.",
    );
    expect(migration).toContain(
      "grant execute on function public.retire_shared_award_source_preserving_visual_history(uuid, text, text)\n  to service_role;",
    );

    const retirementFunction = migration.slice(
      migration.indexOf("create or replace function public.retire_shared_award_source_preserving_visual_history("),
      migration.indexOf("revoke all on function public.awardping_validate_visual_evidence_insert()"),
    );
    expect(retirementFunction).not.toMatch(/delete\s+from/i);
    expect(retirementFunction).not.toContain("public.monitors");
    expect(retirementFunction).not.toContain("public.award_sources");
  });

  it("exposes reads and the atomic RPC to service role without direct evidence writes", () => {
    expect(migration).toContain(
      "alter table public.shared_award_change_event_visual_evidence enable row level security;",
    );
    expect(migration).toContain(
      "revoke all on table public.shared_award_change_event_visual_evidence\n  from public, anon, authenticated;",
    );
    expect(migration).toContain(
      "revoke insert, update, delete, truncate\n  on table public.shared_award_change_event_visual_evidence from service_role;",
    );
    expect(migration).toContain(
      "grant select on table public.shared_award_change_event_visual_evidence to service_role;",
    );
    expect(migration).toContain(
      "grant execute on function public.publish_shared_award_visual_event(jsonb, jsonb)\n  to service_role;",
    );
    expect(migration).toContain(
      "grant execute on function public.backfill_shared_award_visual_event_evidence(uuid, jsonb)\n  to service_role;",
    );
    expect(migration).toContain("security definer");
    expect(migration).toContain("security invoker");
    expect(migration).toContain("set search_path = ''");
  });
});
