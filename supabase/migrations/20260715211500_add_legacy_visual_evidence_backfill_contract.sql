-- One-time compatibility contract for visual candidates published before the
-- immutable artifact-manifest rollout. This migration snapshots eligibility;
-- the RPC never infers a new legacy candidate after this migration runs.

create table public.shared_award_legacy_visual_evidence_eligibility (
  visual_review_candidate_id uuid primary key
    references public.shared_award_visual_review_candidates(id) on delete restrict,
  change_event_id uuid not null unique
    references public.shared_award_change_events(id) on delete restrict,
  shared_award_id uuid not null references public.shared_awards(id) on delete restrict,
  shared_award_source_id uuid not null
    references public.shared_award_sources(id) on delete restrict,
  candidate_signature text not null,
  candidate_created_at timestamptz not null,
  previous_image_hash text not null check (previous_image_hash ~ '^[0-9a-f]{64}$'),
  current_image_hash text not null check (current_image_hash ~ '^[0-9a-f]{64}$'),
  previous_text_hash text,
  current_text_hash text,
  candidate_identity_sha256 text not null check (candidate_identity_sha256 ~ '^[0-9a-f]{64}$'),
  event_identity_sha256 text not null check (event_identity_sha256 ~ '^[0-9a-f]{64}$'),
  eligibility_seal_sha256 text not null check (eligibility_seal_sha256 ~ '^[0-9a-f]{64}$'),
  previous_snapshot_inventory jsonb not null,
  current_snapshot_inventory jsonb not null,
  snapshotted_at timestamptz not null default now(),
  constraint shared_award_legacy_visual_eligibility_cutoff_check
    check (candidate_created_at < '2026-07-15 20:15:00+00'::timestamptz),
  constraint shared_award_legacy_visual_eligibility_inventory_check
    check (
      jsonb_typeof(previous_snapshot_inventory) = 'object'
      and jsonb_typeof(current_snapshot_inventory) = 'object'
    )
);

alter table public.shared_award_legacy_visual_evidence_eligibility enable row level security;
revoke all on table public.shared_award_legacy_visual_evidence_eligibility
  from public, anon, authenticated, service_role;
grant select on table public.shared_award_legacy_visual_evidence_eligibility to service_role;

create or replace function public.awardping_legacy_visual_candidate_identity_sha256(
  p_candidate public.shared_award_visual_review_candidates
)
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  select public.awardping_sha256_text(jsonb_build_object(
    'id', p_candidate.id,
    'shared_award_id', p_candidate.shared_award_id,
    'shared_award_source_id', p_candidate.shared_award_source_id,
    'candidate_signature', p_candidate.candidate_signature,
    'source_url', p_candidate.source_url,
    'source_title', p_candidate.source_title,
    'source_page_type', p_candidate.source_page_type,
    'previous_snapshot_ref', p_candidate.previous_snapshot_ref,
    'new_snapshot_ref', p_candidate.new_snapshot_ref,
    'previous_text_hash', p_candidate.previous_text_hash,
    'new_text_hash', p_candidate.new_text_hash,
    'previous_image_hash', p_candidate.previous_image_hash,
    'new_image_hash', p_candidate.new_image_hash,
    'previous_file_hash', p_candidate.previous_file_hash,
    'new_file_hash', p_candidate.new_file_hash,
    'deterministic_diff', p_candidate.deterministic_diff,
    'deterministic_classification', p_candidate.deterministic_classification,
    'prompt_payload', p_candidate.prompt_payload,
    'prompt_context', p_candidate.prompt_context,
    'status', p_candidate.status,
    'gemini_batch_name', p_candidate.gemini_batch_name,
    'gemini_batch_request_key', p_candidate.gemini_batch_request_key,
    'model', p_candidate.model,
    'created_at', p_candidate.created_at,
    'submitted_at', p_candidate.submitted_at,
    'completed_at', p_candidate.completed_at,
    'published_at', p_candidate.published_at,
    'ai_result', p_candidate.ai_result,
    'worker_metadata', p_candidate.worker_metadata
  )::text);
$$;

create or replace function public.awardping_legacy_visual_event_identity_sha256(
  p_event public.shared_award_change_events
)
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  select public.awardping_sha256_text(jsonb_build_object(
    'id', p_event.id,
    'shared_award_id', p_event.shared_award_id,
    'shared_award_source_id', p_event.shared_award_source_id,
    'source_url', p_event.source_url,
    'source_title', p_event.source_title,
    'source_page_type', p_event.source_page_type,
    'previous_snapshot_id', p_event.previous_snapshot_id,
    'new_snapshot_id', p_event.new_snapshot_id,
    'previous_hash', p_event.previous_hash,
    'new_hash', p_event.new_hash,
    'summary', p_event.summary,
    'change_details', p_event.change_details,
    'first_reported_by_office_id', p_event.first_reported_by_office_id,
    'first_reported_by_monitor_id', p_event.first_reported_by_monitor_id,
    'detected_at', p_event.detected_at
  )::text);
$$;

insert into public.shared_award_legacy_visual_evidence_eligibility (
  visual_review_candidate_id,
  change_event_id,
  shared_award_id,
  shared_award_source_id,
  candidate_signature,
  candidate_created_at,
  previous_image_hash,
  current_image_hash,
  previous_text_hash,
  current_text_hash,
  candidate_identity_sha256,
  event_identity_sha256,
  eligibility_seal_sha256,
  previous_snapshot_inventory,
  current_snapshot_inventory
)
select
  candidate.id,
  event.id,
  candidate.shared_award_id,
  candidate.shared_award_source_id,
  candidate.candidate_signature,
  candidate.created_at,
  candidate.previous_image_hash,
  candidate.new_image_hash,
  candidate.previous_text_hash,
  candidate.new_text_hash,
  identity.candidate_sha256,
  identity.event_sha256,
  public.awardping_sha256_text(jsonb_build_object(
    'version', 1,
    'contract', 'pre-immutable-visual-candidate-eligibility-v1',
    'cutoff', '2026-07-15T20:15:00.000Z',
    'candidate_id', candidate.id,
    'event_id', event.id,
    'candidate_identity_sha256', identity.candidate_sha256,
    'event_identity_sha256', identity.event_sha256
  )::text),
  jsonb_build_object(
    'snapshot_ref', candidate.previous_snapshot_ref,
    'image_hash', candidate.previous_image_hash,
    'text_hash', candidate.previous_text_hash,
    'file_hash', candidate.previous_file_hash,
    'manifest_missing', true
  ),
  jsonb_build_object(
    'snapshot_ref', candidate.new_snapshot_ref,
    'image_hash', candidate.new_image_hash,
    'text_hash', candidate.new_text_hash,
    'file_hash', candidate.new_file_hash,
    'manifest_missing', true
  )
from public.shared_award_visual_review_candidates candidate
join public.shared_award_change_events event
  on nullif(btrim(candidate.worker_metadata ->> 'change_event_id'), '') = event.id::text
cross join lateral (
  select
    public.awardping_legacy_visual_candidate_identity_sha256(candidate) as candidate_sha256,
    public.awardping_legacy_visual_event_identity_sha256(event) as event_sha256
) identity
where candidate.created_at < '2026-07-15 20:15:00+00'::timestamptz
  and candidate.status = 'published'
  and candidate.shared_award_id = event.shared_award_id
  and candidate.shared_award_source_id = event.shared_award_source_id
  and nullif(btrim(event.change_details ->> 'candidate_signature'), '') =
    candidate.candidate_signature
  and (event.visual_review_candidate_id is null or event.visual_review_candidate_id = candidate.id)
  and candidate.previous_image_hash ~ '^[0-9a-f]{64}$'
  and candidate.new_image_hash ~ '^[0-9a-f]{64}$'
  and (candidate.previous_text_hash is null or candidate.previous_text_hash ~ '^[0-9a-f]{64}$')
  and (candidate.new_text_hash is null or candidate.new_text_hash ~ '^[0-9a-f]{64}$')
  and coalesce(candidate.previous_snapshot_ref -> 'artifact_manifest', '{}'::jsonb) = '{}'::jsonb
  and coalesce(candidate.new_snapshot_ref -> 'artifact_manifest', '{}'::jsonb) = '{}'::jsonb
  and nullif(btrim(candidate.previous_snapshot_ref ->> 'artifact_manifest_digest'), '') is null
  and nullif(btrim(candidate.new_snapshot_ref ->> 'artifact_manifest_digest'), '') is null
  and coalesce(candidate.prompt_payload #> '{previous_snapshot_ref,artifact_manifest}', '{}'::jsonb) = '{}'::jsonb
  and coalesce(candidate.prompt_payload #> '{new_snapshot_ref,artifact_manifest}', '{}'::jsonb) = '{}'::jsonb
  and nullif(btrim(candidate.prompt_payload #>> '{previous_snapshot_ref,artifact_manifest_digest}'), '') is null
  and nullif(btrim(candidate.prompt_payload #>> '{new_snapshot_ref,artifact_manifest_digest}'), '') is null
  and nullif(btrim(candidate.prompt_payload #>> '{hashes,previous_artifact_manifest_digest}'), '') is null
  and nullif(btrim(candidate.prompt_payload #>> '{hashes,new_artifact_manifest_digest}'), '') is null
  and not exists (
    select 1
    from public.shared_award_visual_review_candidates other
    where other.id <> candidate.id
      and nullif(btrim(other.worker_metadata ->> 'change_event_id'), '') = event.id::text
      and other.created_at < '2026-07-15 20:15:00+00'::timestamptz
      and other.status = 'published'
      and other.shared_award_id = event.shared_award_id
      and other.shared_award_source_id = event.shared_award_source_id
      and other.candidate_signature = candidate.candidate_signature
  )
on conflict do nothing;

create or replace function public.awardping_reject_legacy_visual_eligibility_mutation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  raise exception using
    errcode = '55000',
    message = 'Legacy visual evidence eligibility is a one-time immutable migration snapshot.';
end;
$$;

create trigger awardping_reject_legacy_visual_eligibility_row_mutation_trigger
  before insert or update or delete on public.shared_award_legacy_visual_evidence_eligibility
  for each row execute function public.awardping_reject_legacy_visual_eligibility_mutation();

create trigger awardping_reject_legacy_visual_eligibility_truncate_trigger
  before truncate on public.shared_award_legacy_visual_evidence_eligibility
  for each statement execute function public.awardping_reject_legacy_visual_eligibility_mutation();

create or replace function public.awardping_freeze_published_visual_candidate_event_binding()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.status = 'published' then
      raise exception using
        errcode = '23514',
        message = 'A post-migration visual candidate cannot be inserted directly in published status.';
    end if;
    return new;
  end if;

  if old.status <> 'published' and new.status = 'published' then
    if nullif(btrim(new.worker_metadata ->> 'change_event_id'), '') is null
      or (
        nullif(btrim(old.worker_metadata ->> 'change_event_id'), '') is not null
        and new.worker_metadata ->> 'change_event_id' is distinct from
          old.worker_metadata ->> 'change_event_id'
      ) then
      raise exception using
        errcode = '55000',
        message = 'A visual candidate must enter published status with its existing exact reverse event binding.';
    end if;

    if not exists (
      select 1
      from public.shared_award_change_event_visual_evidence evidence
      where evidence.visual_review_candidate_id = new.id
        and evidence.change_event_id::text = new.worker_metadata ->> 'change_event_id'
    ) then
      raise exception using
        errcode = '23514',
        message = 'A visual candidate cannot enter published status before its exact immutable event evidence exists.';
    end if;

    if new.worker_metadata ->> 'evidence_signature' is null
      or new.worker_metadata ->> 'evidence_signature' !~ '^[0-9a-f]{64}$' then
      raise exception using
        errcode = '23514',
        message = 'A modern visual candidate cannot enter published status without its evidence signature.';
    end if;
    perform public.awardping_validate_candidate_snapshot_manifest(
      new.previous_snapshot_ref,
      new.prompt_payload -> 'previous_snapshot_ref',
      new.prompt_payload #>> '{hashes,previous_artifact_manifest_digest}',
      'previous'
    );
    perform public.awardping_validate_candidate_snapshot_manifest(
      new.new_snapshot_ref,
      new.prompt_payload -> 'new_snapshot_ref',
      new.prompt_payload #>> '{hashes,new_artifact_manifest_digest}',
      'current'
    );
  end if;

  if old.status = 'published' and (
    new.status is distinct from old.status
    or new.worker_metadata ->> 'change_event_id' is distinct from
      old.worker_metadata ->> 'change_event_id'
  ) then
    raise exception using
      errcode = '55000',
      message = 'A published visual candidate status and reverse event binding are immutable.';
  end if;
  return new;
end;
$$;

create trigger awardping_freeze_published_visual_candidate_event_binding_trigger
  before insert or update on public.shared_award_visual_review_candidates
  for each row execute function public.awardping_freeze_published_visual_candidate_event_binding();

create or replace function public.backfill_legacy_shared_award_visual_event_evidence(
  p_event_id uuid,
  p_evidence jsonb
)
returns table(change_event_id uuid, evidence_id uuid, inserted boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_candidate public.shared_award_visual_review_candidates%rowtype;
  v_eligibility public.shared_award_legacy_visual_evidence_eligibility%rowtype;
  v_event public.shared_award_change_events%rowtype;
  v_existing public.shared_award_change_event_visual_evidence%rowtype;
  v_candidate_id uuid;
  v_payload_event_id uuid;
  v_payload_award_id uuid;
  v_payload_source_id uuid;
  v_candidate_signature text;
  v_status text;
  v_bucket text;
  v_schema_version text;
  v_previous_capture jsonb;
  v_current_capture jsonb;
  v_localization jsonb;
  v_side text;
  v_capture jsonb;
  v_expected_image_hash text;
  v_expected_text_hash text;
  v_candidate_identity_sha256 text;
  v_event_identity_sha256 text;
  v_seal_basis jsonb;
  v_legacy_seal jsonb;
  v_preseal_localization_sha256 text;
  v_evidence_id uuid;
begin
  if p_event_id is null or jsonb_typeof(p_evidence) <> 'object' then
    raise exception using errcode = '22023', message = 'Legacy visual backfill requires an event ID and JSON evidence object.';
  end if;

  begin
    v_candidate_id := nullif(p_evidence ->> 'visual_review_candidate_id', '')::uuid;
    v_payload_event_id := nullif(p_evidence ->> 'change_event_id', '')::uuid;
    v_payload_award_id := nullif(p_evidence ->> 'shared_award_id', '')::uuid;
    v_payload_source_id := nullif(p_evidence ->> 'shared_award_source_id', '')::uuid;
  exception
    when invalid_text_representation then
      raise exception using errcode = '22023', message = 'Legacy visual evidence identifiers must be valid UUIDs.';
  end;
  if v_candidate_id is null then
    raise exception using errcode = '23514', message = 'Legacy recoverable evidence requires a candidate ID.';
  end if;

  select event.* into strict v_event
  from public.shared_award_change_events event
  where event.id = p_event_id
  for update;

  select candidate.* into strict v_candidate
  from public.shared_award_visual_review_candidates candidate
  where candidate.id = v_candidate_id
  for update;

  select eligibility.* into strict v_eligibility
  from public.shared_award_legacy_visual_evidence_eligibility eligibility
  where eligibility.change_event_id = p_event_id
    and eligibility.visual_review_candidate_id = v_candidate_id;

  v_candidate_identity_sha256 := public.awardping_legacy_visual_candidate_identity_sha256(v_candidate);
  v_event_identity_sha256 := public.awardping_legacy_visual_event_identity_sha256(v_event);
  if v_candidate_identity_sha256 is distinct from v_eligibility.candidate_identity_sha256
    or v_event_identity_sha256 is distinct from v_eligibility.event_identity_sha256 then
    raise exception using errcode = '23514', message = 'Legacy visual candidate/event identity changed after the eligibility snapshot.';
  end if;

  v_candidate_signature := nullif(btrim(p_evidence ->> 'candidate_signature'), '');
  if v_payload_event_id is distinct from p_event_id
    or v_payload_award_id is distinct from v_event.shared_award_id
    or v_payload_source_id is distinct from v_event.shared_award_source_id
    or v_candidate.shared_award_id is distinct from v_event.shared_award_id
    or v_candidate.shared_award_source_id is distinct from v_event.shared_award_source_id
    or v_candidate_signature is distinct from v_candidate.candidate_signature
    or v_candidate_signature is distinct from v_event.change_details ->> 'candidate_signature'
    or v_candidate_signature is distinct from v_eligibility.candidate_signature
    or nullif(btrim(v_candidate.worker_metadata ->> 'change_event_id'), '') is distinct from p_event_id::text
    or v_candidate.status is distinct from 'published'
    or v_candidate.created_at >= '2026-07-15 20:15:00+00'::timestamptz
    or (v_event.visual_review_candidate_id is not null and v_event.visual_review_candidate_id <> v_candidate_id) then
    raise exception using errcode = '23514', message = 'Legacy evidence failed its snapshotted candidate/event binding.';
  end if;

  v_status := nullif(btrim(p_evidence ->> 'evidence_status'), '');
  if v_status is null or v_status not in (
    'full_screenshot_fallback',
    'unavailable_image_missing'
  ) then
    raise exception using errcode = '23514', message = 'Legacy evidence is restricted to the exact full-screenshot fallback shapes emitted by the recovery worker.';
  end if;
  v_bucket := nullif(btrim(p_evidence ->> 'bucket'), '');
  v_schema_version := coalesce(nullif(btrim(p_evidence ->> 'evidence_schema_version'), ''), 'visual-event-evidence-v1');
  v_previous_capture := coalesce(p_evidence -> 'previous_capture', '{}'::jsonb);
  v_current_capture := coalesce(p_evidence -> 'current_capture', '{}'::jsonb);
  v_localization := coalesce(p_evidence -> 'localization', '{}'::jsonb);
  if v_bucket is null
    or v_schema_version <> 'visual-event-evidence-v1'
    or jsonb_typeof(v_previous_capture) <> 'object'
    or jsonb_typeof(v_current_capture) <> 'object'
    or jsonb_typeof(v_localization) <> 'object'
    or jsonb_typeof(v_localization -> 'sides') <> 'object'
    or v_localization ->> 'direction' is distinct from 'mixed' then
    raise exception using errcode = '22023', message = 'Legacy fallback requires a bucket and object capture/localization manifests.';
  end if;
  if v_previous_capture = '{}'::jsonb and v_current_capture = '{}'::jsonb then
    raise exception using errcode = '23514', message = 'Legacy recoverable fallback requires at least one retained screenshot.';
  end if;
  if (v_previous_capture = '{}'::jsonb or v_current_capture = '{}'::jsonb)
    and v_status <> 'unavailable_image_missing' then
    raise exception using errcode = '23514', message = 'A missing legacy side must be reported as unavailable_image_missing.';
  end if;
  if v_previous_capture <> '{}'::jsonb
    and v_current_capture <> '{}'::jsonb
    and v_status = 'unavailable_image_missing' then
    raise exception using errcode = '23514', message = 'Legacy evidence cannot report unavailable_image_missing when both screenshots are retained.';
  end if;

  foreach v_side in array array['previous', 'current'] loop
    v_capture := case when v_side = 'previous' then v_previous_capture else v_current_capture end;
    v_expected_image_hash := case when v_side = 'previous' then v_eligibility.previous_image_hash else v_eligibility.current_image_hash end;
    v_expected_text_hash := case when v_side = 'previous' then v_eligibility.previous_text_hash else v_eligibility.current_text_hash end;

    if v_localization #>> array['sides', v_side, 'status'] is null
      or v_localization #>> array['sides', v_side, 'status'] not in (
        'full_screenshot_fallback',
        'unavailable_image_missing'
      )
      or coalesce(v_localization #> array['sides', v_side, 'required'], 'null'::jsonb) <> 'true'::jsonb
      or nullif(btrim(v_localization #>> array['sides', v_side, 'reason']), '') is null
      or coalesce(v_localization #> array['sides', v_side, 'exact_text'], 'null'::jsonb) <> 'null'::jsonb
      or coalesce(v_localization #> array['sides', v_side, 'matched_rects'], '[]'::jsonb) <> '[]'::jsonb
      or coalesce(v_localization #> array['sides', v_side, 'crop_rect'], 'null'::jsonb) <> 'null'::jsonb
      or coalesce(v_localization #> array['sides', v_side, 'crop_rect_pixels'], 'null'::jsonb) <> 'null'::jsonb
      or coalesce(v_localization #> array['sides', v_side, 'exact_overlap'], 'null'::jsonb) <> 'false'::jsonb
      or coalesce(v_localization #> array['sides', v_side, 'algorithm_version'], 'null'::jsonb) <> 'null'::jsonb
      or coalesce(v_localization #> array['sides', v_side, 'state_id'], 'null'::jsonb) <> 'null'::jsonb
      or coalesce(v_capture -> 'crop', 'null'::jsonb) <> 'null'::jsonb then
      raise exception using errcode = '23514', message = format('Legacy %s evidence requires the exact truthful, full-only, non-verified localization shape.', v_side);
    end if;

    if v_capture = '{}'::jsonb then
      if v_localization #>> array['sides', v_side, 'status'] is distinct from 'unavailable_image_missing' then
        raise exception using errcode = '23514', message = format('Missing legacy %s capture is not reported truthfully.', v_side);
      end if;
      continue;
    end if;
    if v_localization #>> array['sides', v_side, 'status'] = 'unavailable_image_missing' then
      raise exception using errcode = '23514', message = format('Retained legacy %s capture cannot be reported as unavailable_image_missing.', v_side);
    end if;

    perform public.awardping_validate_capture_artifact_references(v_capture, v_side);
    perform public.awardping_validate_candidate_capture_prefix(v_capture, v_candidate_id, v_side);
    perform public.awardping_validate_capture_state_binding(v_capture, v_side);

    if v_capture ->> 'kind' is distinct from 'webpage'
      or jsonb_typeof(v_capture -> 'full') <> 'object'
      or jsonb_typeof(v_capture -> 'main_full') <> 'object'
      or jsonb_typeof(v_capture -> 'metadata') <> 'object'
      or v_capture #>> '{full,sha256}' is distinct from v_expected_image_hash
      or v_capture #>> '{main_full,sha256}' is distinct from v_expected_image_hash
      or v_capture #>> '{capture_hashes,image_hash}' is distinct from v_expected_image_hash
      or v_capture #>> '{full,content_type}' not like 'image/%'
      or v_capture #>> '{main_full,content_type}' not like 'image/%'
      or v_capture #>> '{metadata,content_type}' not like 'application/json%'
      or coalesce((v_capture #>> '{full,width}')::integer, 0) <= 0
      or coalesce((v_capture #>> '{full,height}')::integer, 0) <= 0
      or coalesce((v_capture #>> '{main_full,width}')::integer, 0) <= 0
      or coalesce((v_capture #>> '{main_full,height}')::integer, 0) <= 0
      or nullif(btrim(v_capture ->> 'captured_at'), '') is null
      or v_capture ->> 'state_id' is distinct from 'main'
      or jsonb_typeof(v_capture -> 'states') <> 'array'
      or jsonb_array_length(v_capture -> 'states') <> 1
      or v_capture #>> '{states,0,kind}' is distinct from 'main'
      or v_capture #>> '{states,0,state_id}' is distinct from v_capture ->> 'state_id'
      or v_capture #>> '{states,0,image,sha256}' is distinct from v_expected_image_hash
      or coalesce(v_capture #> '{states,0,geometry}', 'null'::jsonb) <> 'null'::jsonb
      or coalesce(v_capture #> '{states,0,geometry_hash}', 'null'::jsonb) <> 'null'::jsonb
      or coalesce(v_capture -> 'layout', 'null'::jsonb) <> 'null'::jsonb
      or v_capture #>> '{legacy_recovery,original_metadata_status}' is null
      or v_capture #>> '{legacy_recovery,original_metadata_status}' not in (
        'missing',
        'byte_length_mismatch',
        'sha256_mismatch',
        'unreadable_json',
        'retained_untrusted_pre_manifest'
      ) then
      raise exception using errcode = '23514', message = format('Legacy %s capture does not match its snapshotted image/text identity.', v_side);
    end if;

    if v_expected_text_hash is null then
      if jsonb_typeof(v_capture -> 'text') = 'object'
        or nullif(v_capture #>> '{capture_hashes,text_hash}', '') is not null
        or v_capture #>> '{legacy_recovery,text_identity_status}' is distinct from 'not_recorded' then
        raise exception using errcode = '23514', message = format('Legacy %s capture claims an unsnapshotted text identity.', v_side);
      end if;
    elsif jsonb_typeof(v_capture -> 'text') = 'object' then
      if v_capture #>> '{text,sha256}' is distinct from v_expected_text_hash
        or v_capture #>> '{capture_hashes,text_hash}' is distinct from v_expected_text_hash
        or v_capture #>> '{legacy_recovery,expected_text_hash}' is distinct from v_expected_text_hash
        or v_capture #>> '{legacy_recovery,actual_text_hash}' is distinct from v_expected_text_hash
        or v_capture #>> '{legacy_recovery,text_identity_status}' is distinct from 'verified' then
        raise exception using errcode = '23514', message = format('Legacy %s retained text does not match its snapshotted hash.', v_side);
      end if;
    elsif nullif(v_capture #>> '{capture_hashes,text_hash}', '') is not null
      or v_capture #>> '{legacy_recovery,expected_text_hash}' is distinct from v_expected_text_hash
      or v_capture #>> '{legacy_recovery,text_identity_status}' is null
      or v_capture #>> '{legacy_recovery,text_identity_status}' not in ('missing', 'sha256_mismatch') then
      raise exception using errcode = '23514', message = format('Legacy %s unavailable text identity is not reported truthfully.', v_side);
    end if;
  end loop;

  v_preseal_localization_sha256 := public.awardping_sha256_text(
    (v_localization - 'legacy_candidate_seal')::text
  );
  v_seal_basis := jsonb_build_object(
    'version', 1,
    'contract', 'pre-immutable-visual-candidate-fallback-v1',
    'eligibility_seal_sha256', v_eligibility.eligibility_seal_sha256,
    'candidate_identity_sha256', v_eligibility.candidate_identity_sha256,
    'event_identity_sha256', v_eligibility.event_identity_sha256,
    'candidate_id', v_candidate_id,
    'event_id', p_event_id,
    'candidate_created_at', v_eligibility.candidate_created_at,
    'candidate_signature', v_candidate_signature,
    'previous_image_hash', v_eligibility.previous_image_hash,
    'current_image_hash', v_eligibility.current_image_hash,
    'previous_capture_sha256', public.awardping_sha256_text(v_previous_capture::text),
    'current_capture_sha256', public.awardping_sha256_text(v_current_capture::text),
    'preseal_localization_sha256', v_preseal_localization_sha256,
    'bucket', v_bucket,
    'evidence_schema_version', v_schema_version,
    'evidence_status', v_status
  );
  v_legacy_seal := v_seal_basis || jsonb_build_object(
    'seal_sha256', public.awardping_sha256_text(v_seal_basis::text)
  );
  v_localization := jsonb_set(
    v_localization - 'legacy_candidate_seal',
    '{legacy_candidate_seal}',
    v_legacy_seal,
    true
  );

  select evidence.* into v_existing
  from public.shared_award_change_event_visual_evidence evidence
  where evidence.change_event_id = p_event_id;
  if found then
    if v_existing.shared_award_id <> v_event.shared_award_id
      or v_existing.shared_award_source_id is distinct from v_event.shared_award_source_id
      or v_existing.visual_review_candidate_id is distinct from v_candidate_id
      or v_existing.candidate_signature is distinct from v_candidate_signature
      or v_existing.bucket is distinct from v_bucket
      or v_existing.evidence_status is distinct from v_status
      or v_existing.previous_capture <> v_previous_capture
      or v_existing.current_capture <> v_current_capture
      or v_existing.localization <> v_localization
      or v_existing.evidence_schema_version <> v_schema_version
      or v_existing.verified_at is not null
      or v_existing.backfilled_at is null then
      raise exception using errcode = '23514', message = 'Existing immutable evidence conflicts with this legacy backfill retry.';
    end if;
    change_event_id := p_event_id;
    evidence_id := v_existing.id;
    inserted := false;
    return next;
    return;
  end if;

  if v_event.visual_review_candidate_id is null then
    update public.shared_award_change_events event
    set visual_review_candidate_id = v_candidate_id
    where event.id = p_event_id;
  end if;

  insert into public.shared_award_change_event_visual_evidence (
    change_event_id,
    shared_award_id,
    shared_award_source_id,
    visual_review_candidate_id,
    candidate_signature,
    bucket,
    evidence_status,
    previous_capture,
    current_capture,
    localization,
    evidence_schema_version,
    verified_at,
    backfilled_at
  ) values (
    p_event_id,
    v_event.shared_award_id,
    v_event.shared_award_source_id,
    v_candidate_id,
    v_candidate_signature,
    v_bucket,
    v_status,
    v_previous_capture,
    v_current_capture,
    v_localization,
    v_schema_version,
    null,
    now()
  ) returning id into v_evidence_id;

  change_event_id := p_event_id;
  evidence_id := v_evidence_id;
  inserted := true;
  return next;
exception
  when no_data_found then
    raise exception using errcode = '23503', message = 'Legacy visual backfill is not in the immutable eligibility snapshot.';
end;
$$;

revoke all on function public.awardping_legacy_visual_candidate_identity_sha256(public.shared_award_visual_review_candidates)
  from public, anon, authenticated, service_role;
revoke all on function public.awardping_legacy_visual_event_identity_sha256(public.shared_award_change_events)
  from public, anon, authenticated, service_role;
revoke all on function public.awardping_reject_legacy_visual_eligibility_mutation()
  from public, anon, authenticated;
revoke all on function public.awardping_freeze_published_visual_candidate_event_binding()
  from public, anon, authenticated;
revoke all on function public.backfill_legacy_shared_award_visual_event_evidence(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.awardping_reject_legacy_visual_eligibility_mutation() to service_role;
grant execute on function public.awardping_freeze_published_visual_candidate_event_binding() to service_role;
grant execute on function public.backfill_legacy_shared_award_visual_event_evidence(uuid, jsonb) to service_role;

comment on table public.shared_award_legacy_visual_evidence_eligibility is
  'One-time immutable inventory of exact pre-manifest candidate/event pairs eligible for honest full-screenshot historical fallback. No row may be added after this migration snapshot.';
comment on function public.backfill_legacy_shared_award_visual_event_evidence(uuid, jsonb) is
  'Legacy-only insert-once backfill gated by the migration-time eligibility registry. It permits only permanent, candidate-hash-bound, non-verified webpage fallback and adds a deterministic database seal.';
