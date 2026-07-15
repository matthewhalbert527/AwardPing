import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/20260715211500_add_legacy_visual_evidence_backfill_contract.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("legacy visual evidence backfill compatibility migration", () => {
  it("snapshots eligibility exactly once before installing insert/update/delete/truncate rejection", () => {
    const seed = migration.indexOf("insert into public.shared_award_legacy_visual_evidence_eligibility");
    const rejection = migration.indexOf("before insert or update or delete on public.shared_award_legacy_visual_evidence_eligibility");
    expect(seed).toBeGreaterThan(0);
    expect(rejection).toBeGreaterThan(seed);
    expect(migration).toContain("before truncate on public.shared_award_legacy_visual_evidence_eligibility");
    expect(migration).toContain("revoke all on table public.shared_award_legacy_visual_evidence_eligibility");
    expect(migration).toContain("grant select on table public.shared_award_legacy_visual_evidence_eligibility to service_role");
  });

  it("admits only the migration-time published, pre-cutoff, signature-and-reverse-bound set", () => {
    expect(migration).toContain("candidate.created_at < '2026-07-15 20:15:00+00'::timestamptz");
    expect(migration).toContain("candidate.status = 'published'");
    expect(migration).toContain("candidate.worker_metadata ->> 'change_event_id'");
    expect(migration).toContain("event.change_details ->> 'candidate_signature'");
    expect(migration).toContain("candidate.shared_award_id = event.shared_award_id");
    expect(migration).toContain("candidate.shared_award_source_id = event.shared_award_source_id");
    expect(migration).toContain("candidate.previous_image_hash ~ '^[0-9a-f]{64}$'");
    expect(migration).toContain("candidate.new_image_hash ~ '^[0-9a-f]{64}$'");
    expect(migration).toContain("manifest_missing', true");
  });

  it("freezes full candidate/event identities and rejects drift at RPC time", () => {
    for (const field of [
      "previous_snapshot_ref",
      "new_snapshot_ref",
      "deterministic_diff",
      "prompt_payload",
      "gemini_batch_name",
      "model",
      "ai_result",
      "worker_metadata",
    ]) {
      expect(migration).toContain(`'${field}', p_candidate.${field}`);
    }
    expect(migration).toContain("awardping_legacy_visual_event_identity_sha256");
    expect(migration).toContain("Legacy visual candidate/event identity changed after the eligibility snapshot.");
    expect(migration).toContain("Legacy visual backfill is not in the immutable eligibility snapshot.");
  });

  it("keeps all post-migration publication on the complete modern manifest contract", () => {
    expect(migration).toContain(
      "A post-migration visual candidate cannot be inserted directly in published status.",
    );
    expect(migration).toContain(
      "before insert or update on public.shared_award_visual_review_candidates",
    );
    expect(migration).toContain("old.status <> 'published' and new.status = 'published'");
    expect(migration).toContain("cannot enter published status before its exact immutable event evidence exists");
    expect(migration).toContain("cannot enter published status without its evidence signature");
    expect(migration.match(/awardping_validate_candidate_snapshot_manifest\(/g)?.length).toBe(2);
    expect(migration).toContain("A published visual candidate status and reverse event binding are immutable.");
  });

  it("allows only full-only non-verified webpage fallback with candidate-bound retained bytes", () => {
    expect(migration).toContain("create or replace function public.backfill_legacy_shared_award_visual_event_evidence(");
    expect(migration).not.toContain("v_status not in (\n    'verified'");
    expect(migration).toContain(
      "Legacy evidence is restricted to the exact full-screenshot fallback shapes emitted by the recovery worker.",
    );
    expect(migration).toContain(
      "Legacy %s evidence requires the exact truthful, full-only, non-verified localization shape.",
    );
    expect(migration).toContain(
      "Legacy evidence cannot report unavailable_image_missing when both screenshots are retained.",
    );
    expect(migration).toContain(
      "Retained legacy %s capture cannot be reported as unavailable_image_missing.",
    );
    expect(migration).toContain(
      "nullif(btrim(v_localization #>> array['sides', v_side, 'reason']), '') is null",
    );
    for (const status of ["full_screenshot_fallback", "unavailable_image_missing"]) {
      expect(migration).toContain(`'${status}'`);
    }
    expect(migration).toContain(
      "coalesce(v_localization #> array['sides', v_side, 'required'], 'null'::jsonb) <> 'true'::jsonb",
    );
    expect(migration).toContain(
      "coalesce(v_localization #> array['sides', v_side, 'exact_text'], 'null'::jsonb) <> 'null'::jsonb",
    );
    expect(migration).toContain(
      "coalesce(v_localization #> array['sides', v_side, 'matched_rects'], '[]'::jsonb) <> '[]'::jsonb",
    );
    expect(migration).toContain(
      "coalesce(v_localization #> array['sides', v_side, 'crop_rect'], 'null'::jsonb) <> 'null'::jsonb",
    );
    expect(migration).toContain(
      "coalesce(v_localization #> array['sides', v_side, 'crop_rect_pixels'], 'null'::jsonb) <> 'null'::jsonb",
    );
    expect(migration).toContain(
      "coalesce(v_localization #> array['sides', v_side, 'exact_overlap'], 'null'::jsonb) <> 'false'::jsonb",
    );
    expect(migration).toContain(
      "coalesce(v_localization #> array['sides', v_side, 'algorithm_version'], 'null'::jsonb) <> 'null'::jsonb",
    );
    expect(migration).toContain(
      "coalesce(v_localization #> array['sides', v_side, 'state_id'], 'null'::jsonb) <> 'null'::jsonb",
    );
    expect(migration).toContain(
      "coalesce(v_capture -> 'crop', 'null'::jsonb) <> 'null'::jsonb",
    );
    expect(migration).toContain(
      "coalesce(v_capture -> 'layout', 'null'::jsonb) <> 'null'::jsonb",
    );
    expect(migration).toContain(
      "coalesce(v_capture #> '{states,0,geometry}', 'null'::jsonb) <> 'null'::jsonb",
    );
    expect(migration).toContain(
      "coalesce(v_capture #> '{states,0,geometry_hash}', 'null'::jsonb) <> 'null'::jsonb",
    );
    expect(migration).toContain("v_localization ->> 'direction' is distinct from 'mixed'");
    expect(migration).toContain("v_capture ->> 'state_id' is distinct from 'main'");
    expect(migration).toContain("jsonb_array_length(v_capture -> 'states') <> 1");
    expect(migration).toContain("v_capture #>> '{states,0,kind}' is distinct from 'main'");
    expect(migration).toContain("v_capture #>> '{full,sha256}' is distinct from v_expected_image_hash");
    expect(migration).toContain("v_capture #>> '{main_full,sha256}' is distinct from v_expected_image_hash");
    expect(migration).toContain("perform public.awardping_validate_candidate_capture_prefix");
    expect(migration).toContain("text_identity_status");
  });

  it("adds a deterministic database seal over the bucket, schema, pre-seal localization, and captures", () => {
    expect(migration).toContain("previous_capture_sha256");
    expect(migration).toContain("current_capture_sha256");
    expect(migration).toContain("preseal_localization_sha256");
    expect(migration).toContain("'bucket', v_bucket");
    expect(migration).toContain("'evidence_schema_version', v_schema_version");
    expect(migration).toContain("v_localization - 'legacy_candidate_seal'");
    expect(migration).toContain("'seal_sha256', public.awardping_sha256_text(v_seal_basis::text)");
    expect(migration).toContain("verified_at,\n    backfilled_at");
  });

  it("exposes only the dedicated compatibility RPC to service role", () => {
    expect(migration).toContain(
      "revoke all on function public.backfill_legacy_shared_award_visual_event_evidence(uuid, jsonb)\n  from public, anon, authenticated;",
    );
    expect(migration).toContain(
      "grant execute on function public.backfill_legacy_shared_award_visual_event_evidence(uuid, jsonb) to service_role;",
    );
    expect(migration).not.toContain("create or replace function public.backfill_shared_award_visual_event_evidence(");
    expect(migration).not.toContain("create or replace function public.publish_shared_award_visual_event(");
  });
});
