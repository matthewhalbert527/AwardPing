-- Immutable, event-specific visual evidence for published AwardPing updates.
--
-- The moving per-source latest/previous pointer remains useful for the current
-- baseline viewer, but it is not publication history. Published evidence uses
-- permanent `visual-snapshots/published/` object keys and is bound to the exact
-- review candidate and change event that produced it.

alter table public.shared_award_change_events
  add column if not exists visual_review_candidate_id uuid
    references public.shared_award_visual_review_candidates(id) on delete restrict;

create unique index if not exists shared_award_change_events_visual_candidate_idx
  on public.shared_award_change_events (visual_review_candidate_id)
  where visual_review_candidate_id is not null;

create table if not exists public.shared_award_change_event_visual_evidence (
  change_event_id uuid primary key
    references public.shared_award_change_events(id) on delete restrict,
  id uuid not null default gen_random_uuid() unique,
  shared_award_id uuid not null references public.shared_awards(id) on delete restrict,
  shared_award_source_id uuid references public.shared_award_sources(id) on delete restrict,
  visual_review_candidate_id uuid
    references public.shared_award_visual_review_candidates(id) on delete restrict,
  candidate_signature text,
  bucket text,
  evidence_status text not null check (
    evidence_status in (
      'verified',
      'unavailable_exact_text_missing',
      'unavailable_geometry_missing',
      'unavailable_image_missing',
      'unavailable_ambiguous',
      'historical_artifact_unrecoverable',
      'full_screenshot_fallback',
      'not_applicable_pdf'
    )
  ),
  previous_capture jsonb not null default '{}'::jsonb,
  current_capture jsonb not null default '{}'::jsonb,
  localization jsonb not null default '{}'::jsonb,
  evidence_schema_version text not null default 'visual-event-evidence-v1'
    check (length(btrim(evidence_schema_version)) > 0),
  created_at timestamptz not null default now(),
  verified_at timestamptz,
  backfilled_at timestamptz,
  constraint shared_award_change_event_visual_evidence_capture_objects_check check (
    jsonb_typeof(previous_capture) = 'object'
    and jsonb_typeof(current_capture) = 'object'
    and jsonb_typeof(localization) = 'object'
  ),
  constraint shared_award_change_event_visual_evidence_candidate_check check (
    (
      visual_review_candidate_id is not null
      and candidate_signature is not null
      and length(btrim(candidate_signature)) > 0
    )
    or (
      visual_review_candidate_id is null
      and backfilled_at is not null
      and verified_at is null
      and evidence_status <> 'verified'
    )
  ),
  constraint shared_award_change_event_visual_evidence_verification_check check (
    (
      evidence_status = 'verified'
      and verified_at is not null
      and visual_review_candidate_id is not null
      and (
        (
          jsonb_typeof(previous_capture -> 'crop') = 'object'
          and coalesce((previous_capture #>> '{crop,exact_overlap}')::boolean, false)
        )
        or (
          jsonb_typeof(current_capture -> 'crop') = 'object'
          and coalesce((current_capture #>> '{crop,exact_overlap}')::boolean, false)
        )
      )
    )
    or (
      evidence_status <> 'verified'
      and verified_at is null
    )
  ),
  constraint shared_award_change_event_visual_evidence_permanent_keys_check check (
    (
      previous_capture #>> '{full,object_key}' is null
      or previous_capture #>> '{full,object_key}' like 'visual-snapshots/published/%'
    )
    and (
      previous_capture #>> '{metadata,object_key}' is null
      or previous_capture #>> '{metadata,object_key}' like 'visual-snapshots/published/%'
    )
    and (
      previous_capture #>> '{crop,object_key}' is null
      or previous_capture #>> '{crop,object_key}' like 'visual-snapshots/published/%'
    )
    and (
      current_capture #>> '{full,object_key}' is null
      or current_capture #>> '{full,object_key}' like 'visual-snapshots/published/%'
    )
    and (
      current_capture #>> '{metadata,object_key}' is null
      or current_capture #>> '{metadata,object_key}' like 'visual-snapshots/published/%'
    )
    and (
      current_capture #>> '{crop,object_key}' is null
      or current_capture #>> '{crop,object_key}' like 'visual-snapshots/published/%'
    )
  ),
  constraint shared_award_change_event_visual_evidence_sha256_check check (
    (
      previous_capture #>> '{full,sha256}' is null
      or previous_capture #>> '{full,sha256}' ~ '^[0-9a-f]{64}$'
    )
    and (
      previous_capture #>> '{metadata,sha256}' is null
      or previous_capture #>> '{metadata,sha256}' ~ '^[0-9a-f]{64}$'
    )
    and (
      previous_capture #>> '{crop,sha256}' is null
      or previous_capture #>> '{crop,sha256}' ~ '^[0-9a-f]{64}$'
    )
    and (
      current_capture #>> '{full,sha256}' is null
      or current_capture #>> '{full,sha256}' ~ '^[0-9a-f]{64}$'
    )
    and (
      current_capture #>> '{metadata,sha256}' is null
      or current_capture #>> '{metadata,sha256}' ~ '^[0-9a-f]{64}$'
    )
    and (
      current_capture #>> '{crop,sha256}' is null
      or current_capture #>> '{crop,sha256}' ~ '^[0-9a-f]{64}$'
    )
  )
);

create unique index if not exists shared_award_change_event_visual_evidence_candidate_idx
  on public.shared_award_change_event_visual_evidence (visual_review_candidate_id)
  where visual_review_candidate_id is not null;

create index if not exists shared_award_change_event_visual_evidence_award_created_idx
  on public.shared_award_change_event_visual_evidence (shared_award_id, created_at desc);

create index if not exists shared_award_change_event_visual_evidence_source_created_idx
  on public.shared_award_change_event_visual_evidence (shared_award_source_id, created_at desc)
  where shared_award_source_id is not null;

alter table public.shared_award_change_event_visual_evidence enable row level security;
revoke all on table public.shared_award_change_event_visual_evidence
  from public, anon, authenticated;
revoke insert, update, delete, truncate
  on table public.shared_award_change_event_visual_evidence from service_role;
grant select on table public.shared_award_change_event_visual_evidence to service_role;

create or replace function public.awardping_validate_visual_evidence_insert()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_candidate public.shared_award_visual_review_candidates%rowtype;
  v_event public.shared_award_change_events%rowtype;
begin
  select * into strict v_event
  from public.shared_award_change_events event
  where event.id = new.change_event_id;

  if v_event.shared_award_id <> new.shared_award_id
    or v_event.shared_award_source_id is distinct from new.shared_award_source_id then
    raise exception using
      errcode = '23514',
      message = 'Visual evidence award/source identity does not match its change event.';
  end if;

  if new.evidence_status = 'historical_artifact_unrecoverable' and (
    coalesce(
      (new.localization ->> 'terminal_artifact_loss_confirmed')::boolean,
      false
    ) is not true
    or nullif(btrim(new.localization ->> 'terminal_artifact_loss_reason'), '') is null
    or new.localization #>> '{sides,previous,status}' is distinct from
      'historical_artifact_unrecoverable'
    or nullif(btrim(new.localization #>> '{sides,previous,reason}'), '') is null
    or new.localization #>> '{sides,current,status}' is distinct from
      'historical_artifact_unrecoverable'
    or nullif(btrim(new.localization #>> '{sides,current,reason}'), '') is null
  ) then
    raise exception using
      errcode = '23514',
      message = 'Unrecoverable visual history requires explicit terminal artifact-loss confirmation.';
  end if;

  if new.visual_review_candidate_id is null then
    if new.backfilled_at is null
      or new.evidence_status <> 'historical_artifact_unrecoverable'
      or new.previous_capture <> '{}'::jsonb
      or new.current_capture <> '{}'::jsonb
      or new.bucket is not null
      or coalesce(
        (new.localization ->> 'terminal_artifact_loss_confirmed')::boolean,
        false
      ) is not true
      or nullif(btrim(new.localization ->> 'terminal_artifact_loss_reason'), '') is null
      or new.localization #>> '{sides,previous,status}' is distinct from
        'historical_artifact_unrecoverable'
      or nullif(btrim(new.localization #>> '{sides,previous,reason}'), '') is null
      or new.localization #>> '{sides,current,status}' is distinct from
        'historical_artifact_unrecoverable'
      or nullif(btrim(new.localization #>> '{sides,current,reason}'), '') is null then
      raise exception using
        errcode = '23514',
        message = 'Candidate-free visual evidence is allowed only after explicit terminal artifact-loss confirmation.';
    end if;
    return new;
  end if;

  select * into strict v_candidate
  from public.shared_award_visual_review_candidates candidate
  where candidate.id = new.visual_review_candidate_id;

  if v_candidate.shared_award_id <> new.shared_award_id
    or v_candidate.shared_award_source_id is distinct from new.shared_award_source_id
    or v_candidate.candidate_signature <> new.candidate_signature then
    raise exception using
      errcode = '23514',
      message = 'Visual evidence identity does not match its review candidate.';
  end if;

  if v_event.visual_review_candidate_id is distinct from new.visual_review_candidate_id then
    raise exception using
      errcode = '23514',
      message = 'Visual evidence candidate does not match its change event binding.';
  end if;

  return new;
exception
  when no_data_found then
    raise exception using
      errcode = '23503',
      message = 'Visual evidence references a missing event or candidate.';
end;
$$;

create or replace function public.awardping_reject_visual_evidence_mutation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  raise exception using
    errcode = '55000',
    message = 'Published visual evidence is immutable; do not replace it in place.';
end;
$$;

create or replace function public.awardping_require_visual_event_evidence()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.visual_review_candidate_id is not null
    and not exists (
      select 1
      from public.shared_award_change_event_visual_evidence evidence
      where evidence.change_event_id = new.id
        and evidence.visual_review_candidate_id = new.visual_review_candidate_id
    ) then
    raise exception using
      errcode = '23514',
      message = 'A review-candidate-bound change event requires immutable visual evidence in the same transaction.';
  end if;
  return null;
end;
$$;

create or replace function public.awardping_preserve_visual_event_candidate_binding()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if old.visual_review_candidate_id is not null
    and new.visual_review_candidate_id is distinct from old.visual_review_candidate_id then
    raise exception using
      errcode = '55000',
      message = 'A published change event review-candidate binding is immutable.';
  end if;
  if (old.visual_review_candidate_id is not null or new.visual_review_candidate_id is not null)
    and (
      new.id is distinct from old.id
      or new.shared_award_id is distinct from old.shared_award_id
      or new.shared_award_source_id is distinct from old.shared_award_source_id
      or new.source_url is distinct from old.source_url
      or new.source_title is distinct from old.source_title
      or new.source_page_type is distinct from old.source_page_type
      or new.previous_snapshot_id is distinct from old.previous_snapshot_id
      or new.new_snapshot_id is distinct from old.new_snapshot_id
      or new.previous_hash is distinct from old.previous_hash
      or new.new_hash is distinct from old.new_hash
      or new.summary is distinct from old.summary
      or new.change_details is distinct from old.change_details
      or new.first_reported_by_office_id is distinct from old.first_reported_by_office_id
      or new.first_reported_by_monitor_id is distinct from old.first_reported_by_monitor_id
      or new.detected_at is distinct from old.detected_at
    ) then
    raise exception using
      errcode = '55000',
      message = 'A candidate-bound published change event identity is immutable; only suppression fields may change.';
  end if;
  return new;
end;
$$;

create or replace function public.awardping_preserve_published_visual_candidate_identity()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_has_evidence boolean := false;
begin
  select exists (
    select 1
    from public.shared_award_change_event_visual_evidence evidence
    where evidence.visual_review_candidate_id = old.id
  ) into v_has_evidence;

  if new.id is distinct from old.id
    or new.shared_award_id is distinct from old.shared_award_id
    or new.shared_award_source_id is distinct from old.shared_award_source_id
    or new.previous_snapshot_ref is distinct from old.previous_snapshot_ref
    or new.new_snapshot_ref is distinct from old.new_snapshot_ref
    or (
      old.prompt_payload ? 'previous_snapshot_ref'
      and new.prompt_payload -> 'previous_snapshot_ref' is distinct from
        old.prompt_payload -> 'previous_snapshot_ref'
    )
    or (
      old.prompt_payload ? 'new_snapshot_ref'
      and new.prompt_payload -> 'new_snapshot_ref' is distinct from
        old.prompt_payload -> 'new_snapshot_ref'
    )
    or (
      nullif(old.prompt_payload #>> '{hashes,previous_artifact_manifest_digest}', '') is not null
      and new.prompt_payload #>> '{hashes,previous_artifact_manifest_digest}' is distinct from
        old.prompt_payload #>> '{hashes,previous_artifact_manifest_digest}'
    )
    or (
      nullif(old.prompt_payload #>> '{hashes,new_artifact_manifest_digest}', '') is not null
      and new.prompt_payload #>> '{hashes,new_artifact_manifest_digest}' is distinct from
        old.prompt_payload #>> '{hashes,new_artifact_manifest_digest}'
    )
    or (
      nullif(old.worker_metadata ->> 'evidence_signature', '') is not null
      and new.worker_metadata ->> 'evidence_signature' is distinct from
        old.worker_metadata ->> 'evidence_signature'
    ) then
    raise exception using
      errcode = '55000',
      message = 'A visual review candidate snapshot and artifact-manifest binding is immutable after enqueue.';
  end if;

  if (old.status <> 'pending' or new.status <> 'pending' or v_has_evidence) and (
    new.candidate_signature is distinct from old.candidate_signature
    or new.source_url is distinct from old.source_url
    or new.source_title is distinct from old.source_title
    or new.source_page_type is distinct from old.source_page_type
    or new.previous_text_hash is distinct from old.previous_text_hash
    or new.new_text_hash is distinct from old.new_text_hash
    or new.previous_image_hash is distinct from old.previous_image_hash
    or new.new_image_hash is distinct from old.new_image_hash
    or new.previous_file_hash is distinct from old.previous_file_hash
    or new.new_file_hash is distinct from old.new_file_hash
    or new.deterministic_diff is distinct from old.deterministic_diff
    or new.deterministic_classification is distinct from old.deterministic_classification
    or new.prompt_payload is distinct from old.prompt_payload
    or new.prompt_context is distinct from old.prompt_context
    or new.gemini_batch_request_key is distinct from old.gemini_batch_request_key
  ) then
    raise exception using
      errcode = '55000',
      message = 'A submitted visual review candidate identity and deterministic evidence are immutable.';
  end if;

  if v_has_evidence and (
    new.id is distinct from old.id
    or new.model is distinct from old.model
    or new.gemini_batch_name is distinct from old.gemini_batch_name
    or new.ai_result is distinct from old.ai_result
  ) then
    raise exception using
      errcode = '55000',
      message = 'A published visual review candidate provider identity and review result are immutable.';
  end if;
  return new;
end;
$$;

drop trigger if exists awardping_validate_visual_evidence_insert_trigger
  on public.shared_award_change_event_visual_evidence;
create trigger awardping_validate_visual_evidence_insert_trigger
  before insert on public.shared_award_change_event_visual_evidence
  for each row execute function public.awardping_validate_visual_evidence_insert();

drop trigger if exists awardping_reject_visual_evidence_mutation_trigger
  on public.shared_award_change_event_visual_evidence;
create trigger awardping_reject_visual_evidence_mutation_trigger
  before update or delete on public.shared_award_change_event_visual_evidence
  for each row execute function public.awardping_reject_visual_evidence_mutation();

drop trigger if exists awardping_preserve_visual_event_candidate_binding_trigger
  on public.shared_award_change_events;
create trigger awardping_preserve_visual_event_candidate_binding_trigger
  before update on public.shared_award_change_events
  for each row execute function public.awardping_preserve_visual_event_candidate_binding();

drop trigger if exists awardping_require_visual_event_evidence_trigger
  on public.shared_award_change_events;
create constraint trigger awardping_require_visual_event_evidence_trigger
  after insert or update on public.shared_award_change_events
  deferrable initially deferred
  for each row execute function public.awardping_require_visual_event_evidence();

drop trigger if exists awardping_preserve_published_visual_candidate_identity_trigger
  on public.shared_award_visual_review_candidates;
create trigger awardping_preserve_published_visual_candidate_identity_trigger
  before update on public.shared_award_visual_review_candidates
  for each row execute function public.awardping_preserve_published_visual_candidate_identity();

create or replace function public.awardping_assert_permanent_visual_artifact(
  p_artifact jsonb,
  p_label text
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_artifact is null or jsonb_typeof(p_artifact) = 'null' then
    return;
  end if;
  if jsonb_typeof(p_artifact) <> 'object'
    or nullif(p_artifact ->> 'object_key', '') is null
    or p_artifact ->> 'object_key' not like 'visual-snapshots/published/%'
    or p_artifact ->> 'sha256' is null
    or p_artifact ->> 'sha256' !~ '^[0-9a-f]{64}$'
    or p_artifact ->> 'object_key' !~ (
      '/' || (p_artifact ->> 'sha256') || E'\\.[a-z0-9]+$'
    )
    or coalesce((p_artifact ->> 'byte_length')::bigint, 0) <= 0
    or nullif(btrim(p_artifact ->> 'content_type'), '') is null then
    raise exception using
      errcode = '23514',
      message = format('Visual evidence artifact %s is not a complete permanent manifest.', p_label);
  end if;
end;
$$;

create or replace function public.awardping_sha256_text(p_value text)
returns text
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_digest text;
begin
  if pg_catalog.to_regprocedure('extensions.digest(bytea,text)') is not null then
    execute
      'select pg_catalog.encode(extensions.digest(pg_catalog.convert_to($1, ''UTF8''), ''sha256''), ''hex'')'
      into v_digest
      using p_value;
  elsif pg_catalog.to_regprocedure('public.digest(bytea,text)') is not null then
    execute
      'select pg_catalog.encode(public.digest(pg_catalog.convert_to($1, ''UTF8''), ''sha256''), ''hex'')'
      into v_digest
      using p_value;
  else
    raise exception using
      errcode = '55000',
      message = 'pgcrypto digest(bytea,text) is required for visual artifact manifest validation.';
  end if;
  return v_digest;
end;
$$;

create or replace function public.awardping_validate_candidate_snapshot_manifest(
  p_direct_ref jsonb,
  p_prompt_ref jsonb,
  p_prompt_digest text,
  p_side text
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_artifact jsonb;
  v_artifact_json text;
  v_artifacts jsonb := '[]'::jsonb;
  v_computed_digest text;
  v_digest text;
  v_item jsonb;
  v_manifest jsonb;
  v_payload text;
  v_role text;
  v_sorted_artifacts jsonb;
  v_state jsonb;
  v_state_count integer := 0;
  v_unique_state_count integer := 0;
begin
  if p_side not in ('previous', 'current')
    or jsonb_typeof(p_direct_ref) <> 'object'
    or jsonb_typeof(p_prompt_ref) <> 'object'
    or p_direct_ref is distinct from p_prompt_ref then
    raise exception using
      errcode = '23514',
      message = format('Candidate %s direct and prompt snapshot references must match exactly.', p_side);
  end if;

  v_manifest := p_direct_ref -> 'artifact_manifest';
  v_digest := nullif(btrim(p_direct_ref ->> 'artifact_manifest_digest'), '');
  if jsonb_typeof(v_manifest) <> 'object'
    or v_manifest ->> 'version' is distinct from '1'
    or v_manifest ->> 'complete' is distinct from 'true'
    or jsonb_typeof(v_manifest -> 'missing_roles') <> 'array'
    or jsonb_array_length(v_manifest -> 'missing_roles') <> 0
    or jsonb_typeof(v_manifest -> 'artifacts') <> 'array'
    or jsonb_array_length(v_manifest -> 'artifacts') = 0
    or v_digest is null
    or v_digest !~ '^[0-9a-f]{64}$'
    or v_manifest ->> 'digest' is distinct from v_digest
    or p_prompt_ref ->> 'artifact_manifest_digest' is distinct from v_digest
    or p_prompt_ref #>> '{artifact_manifest,digest}' is distinct from v_digest
    or p_prompt_digest is distinct from v_digest then
    raise exception using
      errcode = '23514',
      message = format('Candidate %s snapshot artifact-manifest digests are incomplete or inconsistent.', p_side);
  end if;

  if p_direct_ref ? 'visual_states'
    and jsonb_typeof(p_direct_ref -> 'visual_states') <> 'array' then
    raise exception using errcode = '22023', message = 'Candidate visual_states must be a JSON array.';
  end if;
  if jsonb_typeof(p_direct_ref -> 'visual_states') = 'array' then
    select count(*), count(distinct nullif(btrim(state.value ->> 'state_id'), ''))
    into v_state_count, v_unique_state_count
    from jsonb_array_elements(p_direct_ref -> 'visual_states') as state(value);
    if v_state_count <> v_unique_state_count then
      raise exception using
        errcode = '23514',
        message = format('Candidate %s snapshot requires unique, non-empty visual state IDs.', p_side);
    end if;
  end if;

  foreach v_role in array array['page', 'thumb', 'pdf', 'text', 'layout', 'meta'] loop
    v_artifact := p_direct_ref #> array['local_paths', v_role];
    if v_artifact is not null and jsonb_typeof(v_artifact) <> 'null' then
      v_artifacts := v_artifacts || jsonb_build_array(jsonb_build_object(
        'role', v_role,
        'artifact', v_artifact
      ));
    end if;
  end loop;

  if jsonb_typeof(p_direct_ref -> 'visual_states') = 'array' then
    for v_state in
      select state.value
      from jsonb_array_elements(p_direct_ref -> 'visual_states') as state(value)
    loop
      foreach v_role in array array['image', 'layout'] loop
        v_artifact := v_state #> array['local_paths', v_role];
        if v_artifact is not null and jsonb_typeof(v_artifact) <> 'null' then
          v_artifacts := v_artifacts || jsonb_build_array(jsonb_build_object(
            'role', format('visual_state:%s:%s', v_state ->> 'state_id', v_role),
            'artifact', v_artifact
          ));
        end if;
      end loop;

      v_artifact := v_state #> '{local_paths,image}';
      if jsonb_typeof(v_artifact) = 'object' and (
        v_state ->> 'image_hash' is null
        or v_state ->> 'image_hash' !~ '^[0-9a-f]{64}$'
        or v_state ->> 'image_hash' is distinct from v_artifact ->> 'sha256'
      ) then
        raise exception using
          errcode = '23514',
          message = format('Candidate %s state %s image hash is not bound to its archived bytes.', p_side, v_state ->> 'state_id');
      end if;
      v_artifact := v_state #> '{local_paths,layout}';
      if jsonb_typeof(v_artifact) = 'object' and (
        v_state ->> 'geometry_hash' is null
        or v_state ->> 'geometry_hash' !~ '^[0-9a-f]{64}$'
        or v_state #>> '{metadata,screenshot,image_hash}' is distinct from v_state ->> 'image_hash'
      ) then
        raise exception using
          errcode = '23514',
          message = format('Candidate %s state %s geometry is not bound to its screenshot semantics.', p_side, v_state ->> 'state_id');
      end if;
    end loop;
  end if;

  v_artifact := p_direct_ref #> '{local_paths,page}';
  if jsonb_typeof(v_artifact) = 'object'
    and p_direct_ref ->> 'image_hash' is distinct from v_artifact ->> 'sha256' then
    raise exception using
      errcode = '23514',
      message = format('Candidate %s main image hash does not match its archived bytes.', p_side);
  end if;
  v_artifact := p_direct_ref #> '{local_paths,pdf}';
  if jsonb_typeof(v_artifact) = 'object'
    and p_direct_ref ->> 'file_hash' is distinct from v_artifact ->> 'sha256' then
    raise exception using
      errcode = '23514',
      message = format('Candidate %s PDF hash does not match its archived bytes.', p_side);
  end if;

  for v_item in
    select item.value
    from jsonb_array_elements(v_artifacts) as item(value)
  loop
    v_artifact := v_item -> 'artifact';
    if jsonb_typeof(v_artifact) <> 'object'
      or v_artifact ->> 'exists' is distinct from 'true'
      or v_artifact ->> 'sha256' is null
      or v_artifact ->> 'sha256' !~ '^[0-9a-f]{64}$'
      or v_artifact ->> 'byte_length' is null
      or v_artifact ->> 'byte_length' !~ '^[0-9]+$'
      or v_artifact ->> 'bytes' is null
      or v_artifact ->> 'bytes' !~ '^[0-9]+$' then
      raise exception using
        errcode = '23514',
        message = format('Candidate %s archived artifact %s lacks verified SHA/byte metadata.', p_side, v_item ->> 'role');
    end if;
    if (v_artifact ->> 'byte_length')::numeric > 9007199254740991
      or (v_artifact ->> 'bytes')::numeric > 9007199254740991
      or (v_artifact ->> 'byte_length')::numeric <> (v_artifact ->> 'bytes')::numeric then
      raise exception using
        errcode = '23514',
        message = format('Candidate %s archived artifact %s has inconsistent byte lengths.', p_side, v_item ->> 'role');
    end if;
    v_item := jsonb_build_object(
      'role', v_item ->> 'role',
      'sha256', v_artifact ->> 'sha256',
      'byte_length', (v_artifact ->> 'byte_length')::bigint
    );
    v_sorted_artifacts := coalesce(v_sorted_artifacts, '[]'::jsonb) || jsonb_build_array(v_item);
  end loop;

  select coalesce(jsonb_agg(item.value order by
    item.value ->> 'role',
    item.value ->> 'sha256',
    (item.value ->> 'byte_length')::bigint
  ), '[]'::jsonb)
  into v_sorted_artifacts
  from jsonb_array_elements(coalesce(v_sorted_artifacts, '[]'::jsonb)) as item(value);

  if v_manifest -> 'artifacts' is distinct from v_sorted_artifacts then
    raise exception using
      errcode = '23514',
      message = format('Candidate %s snapshot artifact manifest does not equal its flattened file references.', p_side);
  end if;

  select '[' || coalesce(string_agg(
    '{"byte_length":' || (item.value ->> 'byte_length') ||
      ',"role":' || pg_catalog.to_json(item.value ->> 'role')::text ||
      ',"sha256":' || pg_catalog.to_json(item.value ->> 'sha256')::text || '}',
    ',' order by
      item.value ->> 'role',
      item.value ->> 'sha256',
      (item.value ->> 'byte_length')::bigint
  ), '') || ']'
  into v_artifact_json
  from jsonb_array_elements(v_sorted_artifacts) as item(value);
  v_payload := '{"artifacts":' || v_artifact_json || ',"version":1}';
  v_computed_digest := public.awardping_sha256_text(v_payload);
  if v_computed_digest is distinct from v_digest then
    raise exception using
      errcode = '23514',
      message = format('Candidate %s snapshot artifact manifest digest does not match its canonical entries.', p_side);
  end if;
end;
$$;

create or replace function public.awardping_assert_candidate_artifact_matches(
  p_published_artifact jsonb,
  p_candidate_artifact jsonb,
  p_label text,
  p_required boolean
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_candidate_present boolean := jsonb_typeof(p_candidate_artifact) = 'object';
  v_published_present boolean := jsonb_typeof(p_published_artifact) = 'object';
begin
  if p_required and (not v_candidate_present or not v_published_present) then
    raise exception using
      errcode = '23514',
      message = format('Candidate-bound artifact %s is required on both archive and published manifests.', p_label);
  end if;
  if v_published_present and not v_candidate_present then
    raise exception using
      errcode = '23514',
      message = format('Published artifact %s has no candidate archive binding.', p_label);
  end if;
  if not v_published_present or not v_candidate_present then
    return;
  end if;
  if p_published_artifact ->> 'sha256' is distinct from p_candidate_artifact ->> 'sha256'
    or p_published_artifact ->> 'byte_length' is distinct from
      p_candidate_artifact ->> 'byte_length' then
    raise exception using
      errcode = '23514',
      message = format('Published artifact %s bytes do not match its candidate archive reference.', p_label);
  end if;
end;
$$;

create or replace function public.awardping_validate_candidate_capture_prefix(
  p_capture jsonb,
  p_candidate_id uuid,
  p_side text
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_artifact jsonb;
  v_expected_prefix text;
  v_role text;
  v_state jsonb;
begin
  if p_candidate_id is null or p_side not in ('previous', 'current') then
    raise exception using
      errcode = '22023',
      message = 'Candidate capture prefix validation requires a candidate and previous/current side.';
  end if;
  v_expected_prefix := format(
    'visual-snapshots/published/%s/%s/',
    p_candidate_id,
    p_side
  );

  foreach v_role in array array[
    'full',
    'metadata',
    'crop',
    'main_full',
    'thumbnail',
    'text',
    'layout'
  ] loop
    v_artifact := p_capture -> v_role;
    if jsonb_typeof(v_artifact) = 'object'
      and v_artifact ->> 'object_key' not like v_expected_prefix || '%' then
      raise exception using
        errcode = '23514',
        message = format(
          'Visual evidence %s.%s is outside its immutable candidate/side namespace.',
          p_side,
          v_role
        );
    end if;
  end loop;

  if jsonb_typeof(p_capture -> 'states') = 'array' then
    for v_state in
      select state.value
      from jsonb_array_elements(p_capture -> 'states') as state(value)
    loop
      foreach v_role in array array['image', 'geometry'] loop
        v_artifact := v_state -> v_role;
        if jsonb_typeof(v_artifact) = 'object'
          and v_artifact ->> 'object_key' not like v_expected_prefix || '%' then
          raise exception using
            errcode = '23514',
            message = format(
              'Visual evidence %s state %s %s is outside its immutable candidate/side namespace.',
              p_side,
              coalesce(v_state ->> 'state_id', '<missing>'),
              v_role
            );
        end if;
      end loop;
    end loop;
  end if;
end;
$$;

create or replace function public.awardping_validate_capture_state_binding(
  p_capture jsonb,
  p_side text
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_selected_state jsonb;
  v_main_state jsonb;
begin
  if p_capture #>> '{full,object_key}' is null
    or p_capture #>> '{full,content_type}' not like 'image/%' then
    return;
  end if;
  if nullif(btrim(p_capture ->> 'state_id'), '') is null
    or jsonb_typeof(p_capture -> 'states') <> 'array' then
    raise exception using
      errcode = '23514',
      message = format('Visual evidence %s full image is not bound to a retained capture state.', p_side);
  end if;

  select state.value into v_selected_state
  from jsonb_array_elements(p_capture -> 'states') as state(value)
  where state.value ->> 'state_id' = p_capture ->> 'state_id';
  if not found
    or v_selected_state #>> '{image,object_key}' is distinct from p_capture #>> '{full,object_key}'
    or v_selected_state #>> '{image,sha256}' is distinct from p_capture #>> '{full,sha256}'
    or v_selected_state #>> '{image,byte_length}' is distinct from p_capture #>> '{full,byte_length}'
    or v_selected_state #>> '{image,content_type}' is distinct from p_capture #>> '{full,content_type}'
    or v_selected_state #>> '{image,width}' is distinct from p_capture #>> '{full,width}'
    or v_selected_state #>> '{image,height}' is distinct from p_capture #>> '{full,height}' then
    raise exception using
      errcode = '23514',
      message = format('Visual evidence %s full image manifest does not equal its selected state image.', p_side);
  end if;

  if jsonb_typeof(p_capture -> 'layout') = 'object'
    or jsonb_typeof(v_selected_state -> 'geometry') = 'object' then
    if jsonb_typeof(p_capture -> 'layout') <> 'object'
      or jsonb_typeof(v_selected_state -> 'geometry') <> 'object'
      or v_selected_state #>> '{geometry,object_key}' is distinct from p_capture #>> '{layout,object_key}'
      or v_selected_state #>> '{geometry,sha256}' is distinct from p_capture #>> '{layout,sha256}'
      or v_selected_state #>> '{geometry,byte_length}' is distinct from p_capture #>> '{layout,byte_length}'
      or v_selected_state #>> '{geometry,content_type}' is distinct from p_capture #>> '{layout,content_type}'
      or v_selected_state ->> 'geometry_hash' is distinct from p_capture #>> '{layout,geometry_hash}' then
      raise exception using
        errcode = '23514',
        message = format('Visual evidence %s layout manifest does not equal its selected state geometry.', p_side);
    end if;
  end if;

  if jsonb_typeof(p_capture -> 'main_full') = 'object' then
    select state.value into v_main_state
    from jsonb_array_elements(p_capture -> 'states') as state(value)
    where state.value ->> 'kind' = 'main'
    limit 1;
    if not found
      or v_main_state #>> '{image,object_key}' is distinct from p_capture #>> '{main_full,object_key}'
      or v_main_state #>> '{image,sha256}' is distinct from p_capture #>> '{main_full,sha256}'
      or v_main_state #>> '{image,byte_length}' is distinct from p_capture #>> '{main_full,byte_length}'
      or v_main_state #>> '{image,content_type}' is distinct from p_capture #>> '{main_full,content_type}'
      or v_main_state #>> '{image,width}' is distinct from p_capture #>> '{main_full,width}'
      or v_main_state #>> '{image,height}' is distinct from p_capture #>> '{main_full,height}' then
      raise exception using
        errcode = '23514',
        message = format('Visual evidence %s main image manifest does not equal its retained main state.', p_side);
    end if;
  end if;
end;
$$;

create or replace function public.awardping_validate_capture_artifact_references(
  p_capture jsonb,
  p_side text
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_role text;
  v_state jsonb;
  v_state_count integer := 0;
  v_unique_state_count integer := 0;
begin
  if jsonb_typeof(p_capture) <> 'object' then
    raise exception using errcode = '22023', message = 'Visual capture manifest must be a JSON object.';
  end if;
  foreach v_role in array array[
    'full',
    'metadata',
    'crop',
    'main_full',
    'thumbnail',
    'text',
    'layout'
  ] loop
    perform public.awardping_assert_permanent_visual_artifact(
      p_capture -> v_role,
      format('%s.%s', p_side, v_role)
    );
  end loop;

  if p_capture ? 'states' and jsonb_typeof(p_capture -> 'states') <> 'array' then
    raise exception using errcode = '22023', message = 'Visual capture states must be a JSON array.';
  end if;
  if jsonb_typeof(p_capture -> 'states') = 'array' then
    select count(*), count(distinct state.value ->> 'state_id')
    into v_state_count, v_unique_state_count
    from jsonb_array_elements(p_capture -> 'states') as state(value);
    if v_state_count <> v_unique_state_count then
      raise exception using
        errcode = '23514',
        message = format('Visual evidence %s states require unique, non-empty state_id values.', p_side);
    end if;
    for v_state in
      select state.value
      from jsonb_array_elements(p_capture -> 'states') as state(value)
    loop
      if jsonb_typeof(v_state) <> 'object'
        or nullif(btrim(v_state ->> 'state_id'), '') is null
        or jsonb_typeof(v_state -> 'image') <> 'object' then
        raise exception using
          errcode = '23514',
          message = format('Visual evidence %s state is missing identity or image.', p_side);
      end if;
      perform public.awardping_assert_permanent_visual_artifact(
        v_state -> 'image',
        format('%s.states[%s].image', p_side, v_state ->> 'state_id')
      );
      perform public.awardping_assert_permanent_visual_artifact(
        v_state -> 'geometry',
        format('%s.states[%s].geometry', p_side, v_state ->> 'state_id')
      );
    end loop;
  end if;
end;
$$;

create or replace function public.awardping_validate_candidate_capture_binding(
  p_capture jsonb,
  p_candidate_snapshot_ref jsonb,
  p_candidate_main_image_hash text,
  p_candidate_id uuid,
  p_side text,
  p_require_complete boolean
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_candidate_main_state_count integer := 0;
  v_candidate_state jsonb;
  v_candidate_state_count integer := 0;
  v_candidate_unique_state_count integer := 0;
  v_capture_main_state_count integer := 0;
  v_capture_state_count integer := 0;
  v_expected_geometry_hash text;
  v_expected_image_hash text;
  v_state jsonb;
begin
  perform public.awardping_validate_candidate_capture_prefix(
    p_capture,
    p_candidate_id,
    p_side
  );

  perform public.awardping_assert_candidate_artifact_matches(
    p_capture -> 'metadata',
    p_candidate_snapshot_ref #> '{local_paths,meta}',
    format('%s.metadata', p_side),
    p_require_complete
  );
  perform public.awardping_assert_candidate_artifact_matches(
    p_capture -> 'thumbnail',
    p_candidate_snapshot_ref #> '{local_paths,thumb}',
    format('%s.thumbnail', p_side),
    p_require_complete
      and jsonb_typeof(p_candidate_snapshot_ref #> '{local_paths,thumb}') = 'object'
  );
  perform public.awardping_assert_candidate_artifact_matches(
    p_capture -> 'text',
    p_candidate_snapshot_ref #> '{local_paths,text}',
    format('%s.text', p_side),
    p_require_complete
      and jsonb_typeof(p_candidate_snapshot_ref #> '{local_paths,text}') = 'object'
  );

  if p_capture #>> '{full,object_key}' is null then
    return;
  end if;
  if p_capture ->> 'kind' = 'pdf'
    or p_capture #>> '{full,content_type}' like 'application/pdf%' then
    perform public.awardping_assert_candidate_artifact_matches(
      p_capture -> 'full',
      p_candidate_snapshot_ref #> '{local_paths,pdf}',
      format('%s.document', p_side),
      p_require_complete
    );
    return;
  end if;

  perform public.awardping_assert_candidate_artifact_matches(
    p_capture -> 'main_full',
    p_candidate_snapshot_ref #> '{local_paths,page}',
    format('%s.main_full', p_side),
    p_require_complete
  );

  perform public.awardping_validate_capture_state_binding(p_capture, p_side);

  if p_require_complete and (
    jsonb_typeof(p_capture -> 'main_full') <> 'object'
    or jsonb_typeof(p_capture -> 'capture_hashes') <> 'object'
    or p_capture #>> '{capture_hashes,image_hash}' !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(p_capture -> 'states') <> 'array'
    or jsonb_array_length(p_capture -> 'states') = 0
    or jsonb_typeof(p_candidate_snapshot_ref -> 'visual_states') <> 'array'
    or jsonb_array_length(p_candidate_snapshot_ref -> 'visual_states') = 0
  ) then
    raise exception using
      errcode = '23514',
      message = format(
        'Visual evidence %s requires the complete candidate-bound main image and capture-state manifest.',
        p_side
      );
  end if;

  if jsonb_typeof(p_capture -> 'main_full') = 'object' then
    if p_capture #>> '{capture_hashes,image_hash}' is null
      or p_capture #>> '{main_full,sha256}' is distinct from
        p_capture #>> '{capture_hashes,image_hash}'
      or nullif(btrim(p_candidate_main_image_hash), '') is null
      or p_capture #>> '{main_full,sha256}' is distinct from p_candidate_main_image_hash then
      raise exception using
        errcode = '23514',
        message = format(
          'Visual evidence %s retained main image does not match its capture and candidate hashes.',
          p_side
        );
    end if;
  elsif p_require_complete then
    raise exception using
      errcode = '23514',
      message = format('Visual evidence %s is missing its retained candidate main image.', p_side);
  end if;

  if jsonb_typeof(p_capture -> 'states') <> 'array' then
    return;
  end if;
  if jsonb_typeof(p_candidate_snapshot_ref -> 'visual_states') = 'array' then
    select
      count(*),
      count(distinct nullif(btrim(candidate_state.value ->> 'state_id'), '')),
      count(*) filter (where candidate_state.value ->> 'kind' = 'main')
    into
      v_candidate_state_count,
      v_candidate_unique_state_count,
      v_candidate_main_state_count
    from jsonb_array_elements(p_candidate_snapshot_ref -> 'visual_states') as candidate_state(value);
    if v_candidate_state_count <> v_candidate_unique_state_count then
      raise exception using
        errcode = '23514',
        message = format(
          'Visual evidence %s candidate snapshot has empty or duplicate visual state IDs.',
          p_side
        );
    end if;
    if v_candidate_main_state_count > 1 then
      raise exception using
        errcode = '23514',
        message = format('Visual evidence %s candidate snapshot has multiple main states.', p_side);
    end if;
  end if;
  select
    count(*),
    count(*) filter (where capture_state.value ->> 'kind' = 'main')
  into v_capture_state_count, v_capture_main_state_count
  from jsonb_array_elements(p_capture -> 'states') as capture_state(value);
  if v_capture_main_state_count > 1 then
    raise exception using
      errcode = '23514',
      message = format('Visual evidence %s capture has multiple main states.', p_side);
  end if;
  if p_require_complete and (
    v_capture_state_count <> v_candidate_state_count
    or v_candidate_main_state_count <> 1
    or exists (
      select 1
      from jsonb_array_elements(p_candidate_snapshot_ref -> 'visual_states') as candidate_state(value)
      where not exists (
        select 1
        from jsonb_array_elements(p_capture -> 'states') as capture_state(value)
        where capture_state.value ->> 'state_id' = candidate_state.value ->> 'state_id'
      )
    )
    or exists (
      select 1
      from jsonb_array_elements(p_capture -> 'states') as capture_state(value)
      where not exists (
        select 1
        from jsonb_array_elements(p_candidate_snapshot_ref -> 'visual_states') as candidate_state(value)
        where candidate_state.value ->> 'state_id' = capture_state.value ->> 'state_id'
      )
    )
  ) then
    raise exception using
      errcode = '23514',
      message = format(
        'Visual evidence %s capture-state set does not equal its candidate snapshot-state set.',
        p_side
      );
  end if;

  for v_state in
    select state.value
    from jsonb_array_elements(p_capture -> 'states') as state(value)
  loop
    v_candidate_state := null;
    if jsonb_typeof(p_candidate_snapshot_ref -> 'visual_states') = 'array' then
      select candidate_state.value into v_candidate_state
      from jsonb_array_elements(p_candidate_snapshot_ref -> 'visual_states') as candidate_state(value)
      where candidate_state.value ->> 'state_id' = v_state ->> 'state_id';
    end if;
    if v_candidate_state is null
      and (p_require_complete or v_state ->> 'kind' <> 'main') then
      raise exception using
        errcode = '23514',
        message = format(
          'Visual evidence %s state %s is absent from the immutable candidate snapshot reference.',
          p_side,
          coalesce(v_state ->> 'state_id', '<missing>')
        );
    end if;

    perform public.awardping_assert_candidate_artifact_matches(
      v_state -> 'image',
      v_candidate_state #> '{local_paths,image}',
      format('%s.states[%s].image', p_side, v_state ->> 'state_id'),
      true
    );
    perform public.awardping_assert_candidate_artifact_matches(
      v_state -> 'geometry',
      v_candidate_state #> '{local_paths,layout}',
      format('%s.states[%s].geometry', p_side, v_state ->> 'state_id'),
      p_require_complete
        and jsonb_typeof(v_candidate_state #> '{local_paths,layout}') = 'object'
    );

    v_expected_image_hash := coalesce(
      nullif(btrim(v_candidate_state ->> 'image_hash'), ''),
      nullif(btrim(v_candidate_state #>> '{metadata,screenshot,image_hash}'), ''),
      case
        when v_state ->> 'kind' = 'main' then nullif(btrim(p_candidate_main_image_hash), '')
        else null
      end
    );
    if v_expected_image_hash is null
      or v_expected_image_hash !~ '^[0-9a-f]{64}$'
      or v_state #>> '{image,sha256}' is distinct from v_expected_image_hash then
      raise exception using
        errcode = '23514',
        message = format(
          'Visual evidence %s state %s image hash does not match its candidate snapshot reference.',
          p_side,
          coalesce(v_state ->> 'state_id', '<missing>')
        );
    end if;

    v_expected_geometry_hash := coalesce(
      nullif(btrim(v_candidate_state ->> 'geometry_hash'), ''),
      nullif(btrim(v_candidate_state #>> '{metadata,text_geometry,geometry_hash}'), '')
    );
    if v_expected_geometry_hash is not null then
      if v_expected_geometry_hash !~ '^[0-9a-f]{64}$'
        or jsonb_typeof(v_state -> 'geometry') <> 'object'
        or v_state ->> 'geometry_hash' is distinct from v_expected_geometry_hash then
        raise exception using
          errcode = '23514',
          message = format(
            'Visual evidence %s state %s geometry hash does not match its candidate snapshot reference.',
            p_side,
            coalesce(v_state ->> 'state_id', '<missing>')
          );
      end if;
    elsif jsonb_typeof(v_state -> 'geometry') = 'object' then
      raise exception using
        errcode = '23514',
        message = format(
          'Visual evidence %s state %s geometry has no candidate snapshot hash binding.',
          p_side,
          coalesce(v_state ->> 'state_id', '<missing>')
        );
    end if;
  end loop;
end;
$$;

create or replace function public.awardping_visual_rectangles_overlap(
  p_rect jsonb,
  p_crop jsonb
)
returns boolean
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  v_rect_x numeric;
  v_rect_y numeric;
  v_rect_width numeric;
  v_rect_height numeric;
  v_crop_x numeric;
  v_crop_y numeric;
  v_crop_width numeric;
  v_crop_height numeric;
begin
  if jsonb_typeof(p_rect) <> 'object' or jsonb_typeof(p_crop) <> 'object' then
    return false;
  end if;
  v_rect_x := (p_rect ->> 'x')::numeric;
  v_rect_y := (p_rect ->> 'y')::numeric;
  v_rect_width := (p_rect ->> 'width')::numeric;
  v_rect_height := (p_rect ->> 'height')::numeric;
  v_crop_x := (p_crop ->> 'x')::numeric;
  v_crop_y := (p_crop ->> 'y')::numeric;
  v_crop_width := (p_crop ->> 'width')::numeric;
  v_crop_height := (p_crop ->> 'height')::numeric;
  return v_rect_width > 0
    and v_rect_height > 0
    and v_crop_width > 0
    and v_crop_height > 0
    and v_rect_x < v_crop_x + v_crop_width
    and v_rect_x + v_rect_width > v_crop_x
    and v_rect_y < v_crop_y + v_crop_height
    and v_rect_y + v_rect_height > v_crop_y;
exception
  when others then
    return false;
end;
$$;

create or replace function public.awardping_validate_exact_visual_evidence_side(
  p_capture jsonb,
  p_side_localization jsonb,
  p_side text
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_state_bound boolean := false;
  v_rect_overlap boolean := false;
  v_valid boolean := false;
begin
  if jsonb_typeof(p_capture -> 'states') = 'array' then
    select exists (
      select 1
      from jsonb_array_elements(p_capture -> 'states') as state(value)
      where state.value ->> 'state_id' = p_capture ->> 'state_id'
        and state.value #>> '{image,object_key}' = p_capture #>> '{full,object_key}'
        and state.value #>> '{image,sha256}' = p_capture #>> '{full,sha256}'
        and state.value #>> '{image,byte_length}' = p_capture #>> '{full,byte_length}'
        and state.value #>> '{geometry,object_key}' = p_capture #>> '{layout,object_key}'
    ) into v_state_bound;
  end if;
  if jsonb_typeof(p_side_localization -> 'matched_rects') = 'array'
    and jsonb_typeof(p_side_localization -> 'crop_rect') = 'object' then
    select coalesce(
      bool_and(public.awardping_visual_rectangles_overlap(rect.value, p_side_localization -> 'crop_rect')),
      false
    ) into v_rect_overlap
    from jsonb_array_elements(p_side_localization -> 'matched_rects') as rect(value);
  end if;

  v_valid :=
    p_side in ('previous', 'current')
    and p_side_localization ->> 'status' = 'verified'
    and nullif(btrim(p_side_localization ->> 'exact_text'), '') is not null
    and jsonb_typeof(p_side_localization -> 'matched_rects') = 'array'
    and jsonb_array_length(p_side_localization -> 'matched_rects') > 0
    and jsonb_typeof(p_side_localization -> 'crop_rect') = 'object'
    and jsonb_typeof(p_side_localization -> 'crop_rect_pixels') = 'object'
    and coalesce((p_side_localization ->> 'exact_overlap')::boolean, false)
    and p_side_localization ->> 'algorithm_version' = '1'
    and nullif(btrim(p_side_localization ->> 'state_id'), '') is not null
    and p_side_localization ->> 'state_id' = p_capture ->> 'state_id'
    and v_rect_overlap
    and jsonb_typeof(p_capture -> 'crop') = 'object'
    and p_capture #>> '{crop,object_key}' like 'visual-snapshots/published/%'
    and p_capture #>> '{crop,sha256}' ~ '^[0-9a-f]{64}$'
    and coalesce((p_capture #>> '{crop,byte_length}')::bigint, 0) > 0
    and p_capture #>> '{crop,content_type}' like 'image/%'
    and coalesce((p_capture #>> '{crop,width}')::integer, 0) > 0
    and coalesce((p_capture #>> '{crop,height}')::integer, 0) > 0
    and jsonb_typeof(p_capture #> '{crop,clip}') = 'object'
    and coalesce((p_capture #>> '{crop,clip,x}')::integer, -1) >= 0
    and coalesce((p_capture #>> '{crop,clip,y}')::integer, -1) >= 0
    and p_capture #>> '{crop,clip,width}' = p_capture #>> '{crop,width}'
    and p_capture #>> '{crop,clip,height}' = p_capture #>> '{crop,height}'
    and p_capture #>> '{crop,clip,x}' = p_side_localization #>> '{crop_rect_pixels,x}'
    and p_capture #>> '{crop,clip,y}' = p_side_localization #>> '{crop_rect_pixels,y}'
    and p_capture #>> '{crop,clip,width}' = p_side_localization #>> '{crop_rect_pixels,width}'
    and p_capture #>> '{crop,clip,height}' = p_side_localization #>> '{crop_rect_pixels,height}'
    and coalesce((p_capture #>> '{crop,exact_overlap}')::boolean, false)
    and p_capture #>> '{crop,state_id}' = p_capture ->> 'state_id'
    and p_capture #>> '{crop,source_image_object_key}' = p_capture #>> '{full,object_key}'
    and p_capture #>> '{crop,source_image_sha256}' = p_capture #>> '{full,sha256}'
    and p_capture #>> '{crop,source_image_byte_length}' = p_capture #>> '{full,byte_length}'
    and p_capture #> '{crop,css_clip}' = p_side_localization -> 'crop_rect'
    and jsonb_typeof(p_capture -> 'layout') = 'object'
    and p_capture #>> '{layout,object_key}' like 'visual-snapshots/published/%'
    and p_capture #>> '{layout,sha256}' ~ '^[0-9a-f]{64}$'
    and coalesce((p_capture #>> '{layout,byte_length}')::bigint, 0) > 0
    and p_capture #>> '{layout,content_type}' like 'application/json%'
    and p_capture #>> '{layout,state_id}' = p_capture ->> 'state_id'
    and p_capture #>> '{layout,geometry_hash}' ~ '^[0-9a-f]{64}$'
    and v_state_bound;

  if v_valid is not true then
    raise exception using
      errcode = '23514',
      message = format(
        'Verified %s evidence must bind exact text rectangles to the same immutable layout, screenshot, and overlapping CSS/pixel crop.',
        p_side
      );
  end if;
end;
$$;

create or replace function public.awardping_validate_exact_visual_evidence(
  p_previous_capture jsonb,
  p_current_capture jsonb,
  p_localization jsonb
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_direction text;
  v_previous_exact boolean := false;
  v_current_exact boolean := false;
  v_previous_state_bound boolean := false;
  v_current_state_bound boolean := false;
begin
  v_direction := nullif(btrim(p_localization ->> 'direction'), '');
  if v_direction is null or v_direction not in ('added', 'removed', 'changed', 'mixed') then
    raise exception using
      errcode = '23514',
      message = 'Verified evidence requires an added, removed, changed, or mixed localization direction.';
  end if;
  if v_direction in ('removed', 'changed', 'mixed') then
    perform public.awardping_validate_exact_visual_evidence_side(
      p_previous_capture,
      p_localization #> '{sides,previous}',
      'previous'
    );
  end if;
  if v_direction in ('added', 'changed', 'mixed') then
    perform public.awardping_validate_exact_visual_evidence_side(
      p_current_capture,
      p_localization #> '{sides,current}',
      'current'
    );
  end if;

  if jsonb_typeof(p_previous_capture -> 'states') = 'array' then
    select exists (
      select 1
      from jsonb_array_elements(p_previous_capture -> 'states') as state(value)
      where state.value ->> 'state_id' = p_previous_capture ->> 'state_id'
        and state.value #>> '{image,object_key}' = p_previous_capture #>> '{full,object_key}'
        and state.value #>> '{image,sha256}' = p_previous_capture #>> '{full,sha256}'
        and state.value #>> '{image,byte_length}' = p_previous_capture #>> '{full,byte_length}'
        and state.value #>> '{geometry,object_key}' = p_previous_capture #>> '{layout,object_key}'
    ) into v_previous_state_bound;
  end if;
  if jsonb_typeof(p_current_capture -> 'states') = 'array' then
    select exists (
      select 1
      from jsonb_array_elements(p_current_capture -> 'states') as state(value)
      where state.value ->> 'state_id' = p_current_capture ->> 'state_id'
        and state.value #>> '{image,object_key}' = p_current_capture #>> '{full,object_key}'
        and state.value #>> '{image,sha256}' = p_current_capture #>> '{full,sha256}'
        and state.value #>> '{image,byte_length}' = p_current_capture #>> '{full,byte_length}'
        and state.value #>> '{geometry,object_key}' = p_current_capture #>> '{layout,object_key}'
    ) into v_current_state_bound;
  end if;

  v_previous_exact :=
    jsonb_typeof(p_previous_capture -> 'crop') = 'object'
    and p_previous_capture #>> '{crop,object_key}' like 'visual-snapshots/published/%'
    and p_previous_capture #>> '{crop,sha256}' ~ '^[0-9a-f]{64}$'
    and coalesce((p_previous_capture #>> '{crop,byte_length}')::bigint, 0) > 0
    and coalesce((p_previous_capture #>> '{crop,width}')::integer, 0) > 0
    and coalesce((p_previous_capture #>> '{crop,height}')::integer, 0) > 0
    and jsonb_typeof(p_previous_capture #> '{crop,clip}') = 'object'
    and coalesce((p_previous_capture #>> '{crop,clip,x}')::integer, -1) >= 0
    and coalesce((p_previous_capture #>> '{crop,clip,y}')::integer, -1) >= 0
    and p_previous_capture #>> '{crop,clip,width}' = p_previous_capture #>> '{crop,width}'
    and p_previous_capture #>> '{crop,clip,height}' = p_previous_capture #>> '{crop,height}'
    and coalesce((p_previous_capture #>> '{crop,exact_overlap}')::boolean, false)
    and p_previous_capture #>> '{crop,state_id}' = p_previous_capture ->> 'state_id'
    and p_previous_capture #>> '{crop,source_image_object_key}' = p_previous_capture #>> '{full,object_key}'
    and p_previous_capture #>> '{crop,source_image_sha256}' = p_previous_capture #>> '{full,sha256}'
    and p_previous_capture #>> '{crop,source_image_byte_length}' = p_previous_capture #>> '{full,byte_length}'
    and p_previous_capture #> '{crop,css_clip}' = p_localization #> '{sides,previous,crop_rect}'
    and jsonb_typeof(p_previous_capture -> 'layout') = 'object'
    and p_previous_capture #>> '{layout,object_key}' like 'visual-snapshots/published/%'
    and p_previous_capture #>> '{layout,sha256}' ~ '^[0-9a-f]{64}$'
    and coalesce((p_previous_capture #>> '{layout,byte_length}')::bigint, 0) > 0
    and p_previous_capture #>> '{layout,content_type}' like 'application/json%'
    and p_previous_capture #>> '{layout,state_id}' = p_previous_capture ->> 'state_id'
    and p_previous_capture #>> '{layout,geometry_hash}' ~ '^[0-9a-f]{64}$'
    and v_previous_state_bound
    and p_localization #>> '{sides,previous,status}' = 'verified'
    and nullif(btrim(p_localization #>> '{sides,previous,exact_text}'), '') is not null
    and jsonb_typeof(p_localization #> '{sides,previous,matched_rects}') = 'array'
    and jsonb_array_length(p_localization #> '{sides,previous,matched_rects}') > 0
    and jsonb_typeof(p_localization #> '{sides,previous,crop_rect}') = 'object'
    and coalesce((p_localization #>> '{sides,previous,exact_overlap}')::boolean, false)
    and p_localization #>> '{sides,previous,algorithm_version}' = '1'
    and nullif(btrim(p_localization #>> '{sides,previous,state_id}'), '') is not null
    and p_localization #>> '{sides,previous,state_id}' is not distinct from
      p_previous_capture ->> 'state_id';

  v_current_exact :=
    jsonb_typeof(p_current_capture -> 'crop') = 'object'
    and p_current_capture #>> '{crop,object_key}' like 'visual-snapshots/published/%'
    and p_current_capture #>> '{crop,sha256}' ~ '^[0-9a-f]{64}$'
    and coalesce((p_current_capture #>> '{crop,byte_length}')::bigint, 0) > 0
    and coalesce((p_current_capture #>> '{crop,width}')::integer, 0) > 0
    and coalesce((p_current_capture #>> '{crop,height}')::integer, 0) > 0
    and jsonb_typeof(p_current_capture #> '{crop,clip}') = 'object'
    and coalesce((p_current_capture #>> '{crop,clip,x}')::integer, -1) >= 0
    and coalesce((p_current_capture #>> '{crop,clip,y}')::integer, -1) >= 0
    and p_current_capture #>> '{crop,clip,width}' = p_current_capture #>> '{crop,width}'
    and p_current_capture #>> '{crop,clip,height}' = p_current_capture #>> '{crop,height}'
    and coalesce((p_current_capture #>> '{crop,exact_overlap}')::boolean, false)
    and p_current_capture #>> '{crop,state_id}' = p_current_capture ->> 'state_id'
    and p_current_capture #>> '{crop,source_image_object_key}' = p_current_capture #>> '{full,object_key}'
    and p_current_capture #>> '{crop,source_image_sha256}' = p_current_capture #>> '{full,sha256}'
    and p_current_capture #>> '{crop,source_image_byte_length}' = p_current_capture #>> '{full,byte_length}'
    and p_current_capture #> '{crop,css_clip}' = p_localization #> '{sides,current,crop_rect}'
    and jsonb_typeof(p_current_capture -> 'layout') = 'object'
    and p_current_capture #>> '{layout,object_key}' like 'visual-snapshots/published/%'
    and p_current_capture #>> '{layout,sha256}' ~ '^[0-9a-f]{64}$'
    and coalesce((p_current_capture #>> '{layout,byte_length}')::bigint, 0) > 0
    and p_current_capture #>> '{layout,content_type}' like 'application/json%'
    and p_current_capture #>> '{layout,state_id}' = p_current_capture ->> 'state_id'
    and p_current_capture #>> '{layout,geometry_hash}' ~ '^[0-9a-f]{64}$'
    and v_current_state_bound
    and p_localization #>> '{sides,current,status}' = 'verified'
    and nullif(btrim(p_localization #>> '{sides,current,exact_text}'), '') is not null
    and jsonb_typeof(p_localization #> '{sides,current,matched_rects}') = 'array'
    and jsonb_array_length(p_localization #> '{sides,current,matched_rects}') > 0
    and jsonb_typeof(p_localization #> '{sides,current,crop_rect}') = 'object'
    and coalesce((p_localization #>> '{sides,current,exact_overlap}')::boolean, false)
    and p_localization #>> '{sides,current,algorithm_version}' = '1'
    and nullif(btrim(p_localization #>> '{sides,current,state_id}'), '') is not null
    and p_localization #>> '{sides,current,state_id}' is not distinct from
      p_current_capture ->> 'state_id';

  if v_direction = 'added' and v_current_exact is not true then
    raise exception using errcode = '23514', message = 'Added wording must be verified in the current crop.';
  end if;
  if v_direction = 'removed' and v_previous_exact is not true then
    raise exception using errcode = '23514', message = 'Removed wording must be verified in the previous crop.';
  end if;
  if v_direction in ('changed', 'mixed')
    and (v_previous_exact is not true or v_current_exact is not true) then
    raise exception using errcode = '23514', message = 'Changed wording must be verified in both event crops.';
  end if;
end;
$$;

create or replace function public.publish_shared_award_visual_event(
  p_event jsonb,
  p_evidence jsonb
)
returns table(change_event_id uuid, evidence_id uuid, inserted boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_award public.shared_awards%rowtype;
  v_candidate public.shared_award_visual_review_candidates%rowtype;
  v_existing_event public.shared_award_change_events%rowtype;
  v_existing_evidence public.shared_award_change_event_visual_evidence%rowtype;
  v_candidate_id uuid;
  v_award_id uuid;
  v_source_id uuid;
  v_evidence_candidate_id uuid;
  v_evidence_award_id uuid;
  v_evidence_source_id uuid;
  v_event_id uuid;
  v_evidence_id uuid;
  v_candidate_signature text;
  v_source_url text;
  v_source public.shared_award_sources%rowtype;
  v_previous_hash text;
  v_new_hash text;
  v_status text;
  v_bucket text;
  v_schema_version text;
  v_previous_capture jsonb;
  v_current_capture jsonb;
  v_localization jsonb;
  v_event_inserted boolean := false;
  v_evidence_inserted boolean := false;
  v_previous_full_key text;
  v_current_full_key text;
  v_previous_metadata_key text;
  v_current_metadata_key text;
  v_direction text;
  v_previous_exact boolean := false;
  v_current_exact boolean := false;
  v_previous_state_bound boolean := false;
  v_current_state_bound boolean := false;
  v_source_title text;
  v_source_page_type text;
  v_previous_snapshot_id uuid;
  v_new_snapshot_id uuid;
  v_summary text;
  v_change_details jsonb;
  v_office_id uuid;
  v_monitor_id uuid;
  v_detected_at timestamptz;
  v_detected_at_supplied boolean := false;
begin
  if jsonb_typeof(p_event) <> 'object' or jsonb_typeof(p_evidence) <> 'object' then
    raise exception using errcode = '22023', message = 'Event and evidence payloads must be JSON objects.';
  end if;

  begin
    v_candidate_id := nullif(p_event ->> 'visual_review_candidate_id', '')::uuid;
    v_award_id := nullif(p_event ->> 'shared_award_id', '')::uuid;
    v_source_id := nullif(p_event ->> 'shared_award_source_id', '')::uuid;
    v_previous_snapshot_id := nullif(p_event ->> 'previous_snapshot_id', '')::uuid;
    v_new_snapshot_id := nullif(p_event ->> 'new_snapshot_id', '')::uuid;
    v_office_id := nullif(p_event ->> 'first_reported_by_office_id', '')::uuid;
    v_monitor_id := nullif(p_event ->> 'first_reported_by_monitor_id', '')::uuid;
  exception
    when invalid_text_representation then
      raise exception using errcode = '22023', message = 'Event identifiers must be valid UUIDs.';
  end;

  if v_candidate_id is null then
    raise exception using
      errcode = '23514',
      message = 'New visual publication requires visual_review_candidate_id.';
  end if;

  select * into strict v_candidate
  from public.shared_award_visual_review_candidates candidate
  where candidate.id = v_candidate_id
  for update;

  v_candidate_signature := v_candidate.candidate_signature;
  if v_candidate.shared_award_id <> v_award_id
    or v_candidate.shared_award_source_id is distinct from v_source_id then
    raise exception using
      errcode = '23514',
      message = 'Event identity does not match the visual review candidate.';
  end if;

  -- This lock is identical to source retirement's lock. Publication
  -- first is subsequently suppressed by retirement; retirement first causes
  -- publication to observe review_later and fail closed.
  select source.* into strict v_source
  from public.shared_award_sources source
  where source.id = v_source_id
  for update;
  if v_source.shared_award_id <> v_award_id
    or v_source.admin_review_status <> 'open' then
    raise exception using
      errcode = '23514',
      message = 'Visual publication requires an open shared award source.';
  end if;

  select award.* into strict v_award
  from public.shared_awards award
  where award.id = v_award_id
  for share;
  if v_award.status <> 'active' then
    raise exception using
      errcode = '23514',
      message = 'Visual publication requires an active shared award.';
  end if;
  if nullif(p_event ->> 'candidate_signature', '') is not null
    and p_event ->> 'candidate_signature' <> v_candidate_signature then
    raise exception using
      errcode = '23514',
      message = 'Event candidate signature does not match the visual review candidate.';
  end if;
  begin
    v_evidence_candidate_id := nullif(p_evidence ->> 'visual_review_candidate_id', '')::uuid;
    v_evidence_award_id := nullif(p_evidence ->> 'shared_award_id', '')::uuid;
    v_evidence_source_id := nullif(p_evidence ->> 'shared_award_source_id', '')::uuid;
  exception
    when invalid_text_representation then
      raise exception using errcode = '22023', message = 'Evidence candidate, award, and source IDs must be valid UUIDs.';
  end;
  if v_evidence_candidate_id is distinct from v_candidate_id
    or v_evidence_award_id is distinct from v_award_id
    or v_evidence_source_id is distinct from v_source_id
    or nullif(btrim(p_evidence ->> 'candidate_signature'), '') is distinct from v_candidate_signature then
    raise exception using
      errcode = '23514',
      message = 'Evidence candidate signature/award/source identity does not match the event.';
  end if;
  if v_candidate.status not in ('succeeded', 'published') then
    raise exception using
      errcode = '23514',
      message = 'Only a successfully reviewed visual candidate can be published.';
  end if;
  if v_candidate.worker_metadata ->> 'evidence_signature' is null
    or v_candidate.worker_metadata ->> 'evidence_signature' !~ '^[0-9a-f]{64}$' then
    raise exception using
      errcode = '23514',
      message = 'Visual publication requires the immutable candidate evidence signature.';
  end if;

  v_source_url := nullif(btrim(p_event ->> 'source_url'), '');
  v_source_title := nullif(btrim(p_event ->> 'source_title'), '');
  v_source_page_type := nullif(btrim(p_event ->> 'source_page_type'), '');
  v_previous_hash := nullif(btrim(p_event ->> 'previous_hash'), '');
  v_new_hash := nullif(btrim(p_event ->> 'new_hash'), '');
  v_summary := nullif(btrim(p_event ->> 'summary'), '');
  v_change_details := coalesce(p_event -> 'change_details', '{}'::jsonb);
  if v_source_url is null or v_previous_hash is null or v_new_hash is null
    or v_summary is null then
    raise exception using
      errcode = '23514',
      message = 'Visual publication requires source_url, previous_hash, new_hash, and summary.';
  end if;
  if v_source_url is distinct from v_candidate.source_url
    or v_source_url is distinct from v_source.url
    or v_source_title is distinct from v_candidate.source_title
    or v_source_page_type is distinct from v_candidate.source_page_type then
    raise exception using
      errcode = '23514',
      message = 'Published event source identity does not match its locked candidate and source.';
  end if;
  if jsonb_typeof(v_change_details) <> 'object' then
    raise exception using errcode = '22023', message = 'Event change_details must be a JSON object.';
  end if;
  v_change_details := v_change_details
    || jsonb_build_object('candidate_signature', v_candidate_signature);
  v_detected_at_supplied := nullif(p_event ->> 'detected_at', '') is not null;
  begin
    v_detected_at := coalesce(
      nullif(p_event ->> 'detected_at', '')::timestamptz,
      now()
    );
  exception
    when invalid_datetime_format then
      raise exception using errcode = '22023', message = 'Event detected_at must be a valid timestamp.';
  end;

  v_status := nullif(btrim(p_evidence ->> 'evidence_status'), '');
  v_bucket := nullif(btrim(p_evidence ->> 'bucket'), '');
  v_schema_version := coalesce(
    nullif(btrim(p_evidence ->> 'evidence_schema_version'), ''),
    'visual-event-evidence-v1'
  );
  v_previous_capture := coalesce(p_evidence -> 'previous_capture', '{}'::jsonb);
  v_current_capture := coalesce(p_evidence -> 'current_capture', '{}'::jsonb);
  v_localization := coalesce(p_evidence -> 'localization', '{}'::jsonb);

  if v_status is null or v_status not in (
    'verified',
    'unavailable_exact_text_missing',
    'unavailable_geometry_missing',
    'unavailable_ambiguous',
    'full_screenshot_fallback',
    'not_applicable_pdf'
  ) then
    raise exception using
      errcode = '23514',
      message = 'New visual publication supplied an unavailable or historical-only evidence status.';
  end if;
  if jsonb_typeof(v_previous_capture) <> 'object'
    or jsonb_typeof(v_current_capture) <> 'object'
    or jsonb_typeof(v_localization) <> 'object' then
    raise exception using
      errcode = '22023',
      message = 'Capture and localization payloads must be JSON objects.';
  end if;
  perform public.awardping_validate_capture_artifact_references(v_previous_capture, 'previous');
  perform public.awardping_validate_capture_artifact_references(v_current_capture, 'current');
  perform public.awardping_validate_candidate_snapshot_manifest(
    v_candidate.previous_snapshot_ref,
    v_candidate.prompt_payload -> 'previous_snapshot_ref',
    v_candidate.prompt_payload #>> '{hashes,previous_artifact_manifest_digest}',
    'previous'
  );
  perform public.awardping_validate_candidate_snapshot_manifest(
    v_candidate.new_snapshot_ref,
    v_candidate.prompt_payload -> 'new_snapshot_ref',
    v_candidate.prompt_payload #>> '{hashes,new_artifact_manifest_digest}',
    'current'
  );
  perform public.awardping_validate_candidate_capture_binding(
    v_previous_capture,
    case
      when jsonb_typeof(v_candidate.previous_snapshot_ref) = 'object'
        and v_candidate.previous_snapshot_ref <> '{}'::jsonb
        then v_candidate.previous_snapshot_ref
      else coalesce(v_candidate.prompt_payload -> 'previous_snapshot_ref', '{}'::jsonb)
    end,
    coalesce(
      v_candidate.previous_image_hash,
      nullif(v_candidate.previous_snapshot_ref ->> 'image_hash', ''),
      nullif(v_candidate.prompt_payload #>> '{previous_snapshot_ref,image_hash}', ''),
      nullif(v_candidate.prompt_payload #>> '{hashes,previous_image_hash}', '')
    ),
    v_candidate_id,
    'previous',
    true
  );
  perform public.awardping_validate_candidate_capture_binding(
    v_current_capture,
    case
      when jsonb_typeof(v_candidate.new_snapshot_ref) = 'object'
        and v_candidate.new_snapshot_ref <> '{}'::jsonb
        then v_candidate.new_snapshot_ref
      else coalesce(v_candidate.prompt_payload -> 'new_snapshot_ref', '{}'::jsonb)
    end,
    coalesce(
      v_candidate.new_image_hash,
      nullif(v_candidate.new_snapshot_ref ->> 'image_hash', ''),
      nullif(v_candidate.prompt_payload #>> '{new_snapshot_ref,image_hash}', ''),
      nullif(v_candidate.prompt_payload #>> '{hashes,new_image_hash}', '')
    ),
    v_candidate_id,
    'current',
    true
  );
  if v_localization #>> '{sides,previous,status}' = 'verified' then
    perform public.awardping_validate_exact_visual_evidence_side(
      v_previous_capture,
      v_localization #> '{sides,previous}',
      'previous'
    );
  end if;
  if v_localization #>> '{sides,current,status}' = 'verified' then
    perform public.awardping_validate_exact_visual_evidence_side(
      v_current_capture,
      v_localization #> '{sides,current}',
      'current'
    );
  end if;

  v_previous_full_key := nullif(v_previous_capture #>> '{full,object_key}', '');
  v_current_full_key := nullif(v_current_capture #>> '{full,object_key}', '');
  v_previous_metadata_key := nullif(v_previous_capture #>> '{metadata,object_key}', '');
  v_current_metadata_key := nullif(v_current_capture #>> '{metadata,object_key}', '');
  if v_status <> 'not_applicable_pdf' then
    if v_bucket is null
      or v_previous_full_key is null
      or v_current_full_key is null
      or v_previous_metadata_key is null
      or v_current_metadata_key is null
      or jsonb_typeof(v_previous_capture -> 'capture_hashes') <> 'object'
      or jsonb_typeof(v_current_capture -> 'capture_hashes') <> 'object' then
      raise exception using
        errcode = '23514',
        message = 'Published webpage evidence requires bucket and immutable previous/current full images, metadata, and capture hashes.';
    end if;
    if nullif(btrim(v_previous_capture ->> 'captured_at'), '') is null
      or nullif(btrim(v_current_capture ->> 'captured_at'), '') is null
      or nullif(btrim(v_previous_capture ->> 'state_id'), '') is null
      or nullif(btrim(v_current_capture ->> 'state_id'), '') is null then
      raise exception using
        errcode = '23514',
        message = 'Published webpage evidence requires captured_at and state_id on both immutable captures.';
    end if;
  else
    if v_bucket is null
      or v_previous_full_key is null
      or v_current_full_key is null
      or v_previous_metadata_key is null
      or v_current_metadata_key is null
      or jsonb_typeof(v_previous_capture -> 'capture_hashes') <> 'object'
      or jsonb_typeof(v_current_capture -> 'capture_hashes') <> 'object'
      or nullif(btrim(v_previous_capture ->> 'captured_at'), '') is null
      or nullif(btrim(v_current_capture ->> 'captured_at'), '') is null
      or nullif(btrim(v_previous_capture ->> 'state_id'), '') is null
      or nullif(btrim(v_current_capture ->> 'state_id'), '') is null then
      raise exception using
        errcode = '23514',
        message = 'Published PDF evidence requires bucket, previous/current documents, metadata, capture hashes, timestamps, and state IDs.';
    end if;
  end if;

  if (
      v_previous_full_key is not null
      and v_previous_full_key not like 'visual-snapshots/published/%'
    ) or (
      v_current_full_key is not null
      and v_current_full_key not like 'visual-snapshots/published/%'
    ) or (
      v_previous_metadata_key is not null
      and v_previous_metadata_key not like 'visual-snapshots/published/%'
    ) or (
      v_current_metadata_key is not null
      and v_current_metadata_key not like 'visual-snapshots/published/%'
    ) then
    raise exception using
      errcode = '23514',
      message = 'Published evidence object keys must use the permanent published prefix.';
  end if;

  if v_status <> 'not_applicable_pdf' then
    if v_previous_capture #>> '{full,sha256}' is null
      or v_previous_capture #>> '{full,sha256}' !~ '^[0-9a-f]{64}$'
      or v_current_capture #>> '{full,sha256}' is null
      or v_current_capture #>> '{full,sha256}' !~ '^[0-9a-f]{64}$'
      or v_previous_capture #>> '{metadata,sha256}' is null
      or v_previous_capture #>> '{metadata,sha256}' !~ '^[0-9a-f]{64}$'
      or v_current_capture #>> '{metadata,sha256}' is null
      or v_current_capture #>> '{metadata,sha256}' !~ '^[0-9a-f]{64}$'
      or v_previous_capture #>> '{capture_hashes,image_hash}' is null
      or v_previous_capture #>> '{capture_hashes,image_hash}' !~ '^[0-9a-f]{64}$'
      or v_current_capture #>> '{capture_hashes,image_hash}' is null
      or v_current_capture #>> '{capture_hashes,image_hash}' !~ '^[0-9a-f]{64}$'
      or v_previous_capture #>> '{capture_hashes,text_hash}' is null
      or v_previous_capture #>> '{capture_hashes,text_hash}' !~ '^[0-9a-f]{64}$'
      or v_current_capture #>> '{capture_hashes,text_hash}' is null
      or v_current_capture #>> '{capture_hashes,text_hash}' !~ '^[0-9a-f]{64}$'
      or coalesce((v_previous_capture #>> '{full,byte_length}')::bigint, 0) <= 0
      or coalesce((v_current_capture #>> '{full,byte_length}')::bigint, 0) <= 0
      or coalesce((v_previous_capture #>> '{metadata,byte_length}')::bigint, 0) <= 0
      or coalesce((v_current_capture #>> '{metadata,byte_length}')::bigint, 0) <= 0
      or coalesce((v_previous_capture #>> '{full,width}')::integer, 0) <= 0
      or coalesce((v_previous_capture #>> '{full,height}')::integer, 0) <= 0
      or coalesce((v_current_capture #>> '{full,width}')::integer, 0) <= 0
      or coalesce((v_current_capture #>> '{full,height}')::integer, 0) <= 0
      or nullif(btrim(v_previous_capture #>> '{full,content_type}'), '') is null
      or v_previous_capture #>> '{full,content_type}' not like 'image/%'
      or nullif(btrim(v_current_capture #>> '{full,content_type}'), '') is null
      or v_current_capture #>> '{full,content_type}' not like 'image/%'
      or nullif(btrim(v_previous_capture #>> '{metadata,content_type}'), '') is null
      or v_previous_capture #>> '{metadata,content_type}' not like 'application/json%'
      or nullif(btrim(v_current_capture #>> '{metadata,content_type}'), '') is null
      or v_current_capture #>> '{metadata,content_type}' not like 'application/json%' then
      raise exception using
        errcode = '23514',
        message = 'Published webpage artifacts require verified SHA-256, byte lengths, and full-image dimensions.';
    end if;
  else
    if v_previous_capture #>> '{full,sha256}' is null
      or v_previous_capture #>> '{full,sha256}' !~ '^[0-9a-f]{64}$'
      or v_current_capture #>> '{full,sha256}' is null
      or v_current_capture #>> '{full,sha256}' !~ '^[0-9a-f]{64}$'
      or coalesce((v_previous_capture #>> '{full,byte_length}')::bigint, 0) <= 0
      or coalesce((v_current_capture #>> '{full,byte_length}')::bigint, 0) <= 0
      or v_previous_capture #>> '{metadata,sha256}' is null
      or v_previous_capture #>> '{metadata,sha256}' !~ '^[0-9a-f]{64}$'
      or v_current_capture #>> '{metadata,sha256}' is null
      or v_current_capture #>> '{metadata,sha256}' !~ '^[0-9a-f]{64}$'
      or coalesce((v_previous_capture #>> '{metadata,byte_length}')::bigint, 0) <= 0
      or coalesce((v_current_capture #>> '{metadata,byte_length}')::bigint, 0) <= 0
      or nullif(btrim(v_previous_capture #>> '{full,content_type}'), '') is null
      or v_previous_capture #>> '{full,content_type}' not like 'application/pdf%'
      or nullif(btrim(v_current_capture #>> '{full,content_type}'), '') is null
      or v_current_capture #>> '{full,content_type}' not like 'application/pdf%'
      or nullif(btrim(v_previous_capture #>> '{metadata,content_type}'), '') is null
      or v_previous_capture #>> '{metadata,content_type}' not like 'application/json%'
      or nullif(btrim(v_current_capture #>> '{metadata,content_type}'), '') is null
      or v_current_capture #>> '{metadata,content_type}' not like 'application/json%'
      or v_previous_capture ->> 'kind' is distinct from 'pdf'
      or v_current_capture ->> 'kind' is distinct from 'pdf'
      or v_previous_capture ->> 'state_id' is distinct from 'document'
      or v_current_capture ->> 'state_id' is distinct from 'document'
      or v_previous_capture #>> '{capture_hashes,file_hash}' is null
      or v_previous_capture #>> '{capture_hashes,file_hash}' !~ '^[0-9a-f]{64}$'
      or v_current_capture #>> '{capture_hashes,file_hash}' is null
      or v_current_capture #>> '{capture_hashes,file_hash}' !~ '^[0-9a-f]{64}$'
      or v_previous_capture #>> '{full,sha256}' is distinct from
        v_previous_capture #>> '{capture_hashes,file_hash}'
      or v_current_capture #>> '{full,sha256}' is distinct from
        v_current_capture #>> '{capture_hashes,file_hash}' then
      raise exception using
        errcode = '23514',
        message = 'Published PDF artifacts require verified SHA-256, byte lengths, content types, and file hashes.';
    end if;
  end if;

  if v_candidate.previous_image_hash is not null
    and v_previous_capture #>> '{capture_hashes,image_hash}' is distinct from v_candidate.previous_image_hash then
    raise exception using errcode = '23514', message = 'Previous capture image hash does not match the review candidate.';
  end if;
  if v_candidate.new_image_hash is not null
    and v_current_capture #>> '{capture_hashes,image_hash}' is distinct from v_candidate.new_image_hash then
    raise exception using errcode = '23514', message = 'Current capture image hash does not match the review candidate.';
  end if;
  if v_candidate.previous_text_hash is not null
    and v_previous_capture #>> '{capture_hashes,text_hash}' is distinct from v_candidate.previous_text_hash then
    raise exception using errcode = '23514', message = 'Previous capture text hash does not match the review candidate.';
  end if;
  if v_candidate.new_text_hash is not null
    and v_current_capture #>> '{capture_hashes,text_hash}' is distinct from v_candidate.new_text_hash then
    raise exception using errcode = '23514', message = 'Current capture text hash does not match the review candidate.';
  end if;
  if v_candidate.previous_file_hash is not null
    and v_previous_capture #>> '{capture_hashes,file_hash}' is distinct from v_candidate.previous_file_hash then
    raise exception using errcode = '23514', message = 'Previous capture file hash does not match the review candidate.';
  end if;
  if v_candidate.new_file_hash is not null
    and v_current_capture #>> '{capture_hashes,file_hash}' is distinct from v_candidate.new_file_hash then
    raise exception using errcode = '23514', message = 'Current capture file hash does not match the review candidate.';
  end if;

  if v_status = 'verified' then
    perform public.awardping_validate_exact_visual_evidence(
      v_previous_capture,
      v_current_capture,
      v_localization
    );
    v_direction := nullif(btrim(v_localization ->> 'direction'), '');
    if v_direction is null or v_direction not in ('added', 'removed', 'changed', 'mixed') then
      raise exception using
        errcode = '23514',
        message = 'Verified evidence requires an added, removed, changed, or mixed localization direction.';
    end if;

    if jsonb_typeof(v_previous_capture -> 'states') = 'array' then
      select exists (
        select 1
        from jsonb_array_elements(v_previous_capture -> 'states') as state(value)
        where state.value ->> 'state_id' = v_previous_capture ->> 'state_id'
          and state.value #>> '{image,object_key}' = v_previous_capture #>> '{full,object_key}'
          and state.value #>> '{geometry,object_key}' = v_previous_capture #>> '{layout,object_key}'
      ) into v_previous_state_bound;
    end if;
    if jsonb_typeof(v_current_capture -> 'states') = 'array' then
      select exists (
        select 1
        from jsonb_array_elements(v_current_capture -> 'states') as state(value)
        where state.value ->> 'state_id' = v_current_capture ->> 'state_id'
          and state.value #>> '{image,object_key}' = v_current_capture #>> '{full,object_key}'
          and state.value #>> '{geometry,object_key}' = v_current_capture #>> '{layout,object_key}'
      ) into v_current_state_bound;
    end if;

    v_previous_exact :=
      jsonb_typeof(v_previous_capture -> 'crop') = 'object'
      and v_previous_capture #>> '{crop,object_key}' like 'visual-snapshots/published/%'
      and v_previous_capture #>> '{crop,sha256}' ~ '^[0-9a-f]{64}$'
      and coalesce((v_previous_capture #>> '{crop,byte_length}')::bigint, 0) > 0
      and coalesce((v_previous_capture #>> '{crop,width}')::integer, 0) > 0
      and coalesce((v_previous_capture #>> '{crop,height}')::integer, 0) > 0
      and jsonb_typeof(v_previous_capture #> '{crop,clip}') = 'object'
      and coalesce((v_previous_capture #>> '{crop,clip,x}')::integer, -1) >= 0
      and coalesce((v_previous_capture #>> '{crop,clip,y}')::integer, -1) >= 0
      and v_previous_capture #>> '{crop,clip,width}' = v_previous_capture #>> '{crop,width}'
      and v_previous_capture #>> '{crop,clip,height}' = v_previous_capture #>> '{crop,height}'
      and coalesce((v_previous_capture #>> '{crop,exact_overlap}')::boolean, false)
      and v_previous_capture #>> '{crop,state_id}' = v_previous_capture ->> 'state_id'
      and v_previous_capture #> '{crop,css_clip}' = v_localization #> '{sides,previous,crop_rect}'
      and jsonb_typeof(v_previous_capture -> 'layout') = 'object'
      and v_previous_capture #>> '{layout,object_key}' like 'visual-snapshots/published/%'
      and v_previous_capture #>> '{layout,sha256}' ~ '^[0-9a-f]{64}$'
      and coalesce((v_previous_capture #>> '{layout,byte_length}')::bigint, 0) > 0
      and v_previous_capture #>> '{layout,content_type}' like 'application/json%'
      and v_previous_capture #>> '{layout,state_id}' = v_previous_capture ->> 'state_id'
      and v_previous_state_bound
      and v_localization #>> '{sides,previous,status}' = 'verified'
      and nullif(btrim(v_localization #>> '{sides,previous,exact_text}'), '') is not null
      and jsonb_typeof(v_localization #> '{sides,previous,matched_rects}') = 'array'
      and jsonb_array_length(v_localization #> '{sides,previous,matched_rects}') > 0
      and jsonb_typeof(v_localization #> '{sides,previous,crop_rect}') = 'object'
      and coalesce((v_localization #>> '{sides,previous,exact_overlap}')::boolean, false)
      and nullif(btrim(v_localization #>> '{sides,previous,algorithm_version}'), '') is not null
      and nullif(btrim(v_localization #>> '{sides,previous,state_id}'), '') is not null
      and v_localization #>> '{sides,previous,state_id}' is not distinct from
        v_previous_capture ->> 'state_id';

    v_current_exact :=
      jsonb_typeof(v_current_capture -> 'crop') = 'object'
      and v_current_capture #>> '{crop,object_key}' like 'visual-snapshots/published/%'
      and v_current_capture #>> '{crop,sha256}' ~ '^[0-9a-f]{64}$'
      and coalesce((v_current_capture #>> '{crop,byte_length}')::bigint, 0) > 0
      and coalesce((v_current_capture #>> '{crop,width}')::integer, 0) > 0
      and coalesce((v_current_capture #>> '{crop,height}')::integer, 0) > 0
      and jsonb_typeof(v_current_capture #> '{crop,clip}') = 'object'
      and coalesce((v_current_capture #>> '{crop,clip,x}')::integer, -1) >= 0
      and coalesce((v_current_capture #>> '{crop,clip,y}')::integer, -1) >= 0
      and v_current_capture #>> '{crop,clip,width}' = v_current_capture #>> '{crop,width}'
      and v_current_capture #>> '{crop,clip,height}' = v_current_capture #>> '{crop,height}'
      and coalesce((v_current_capture #>> '{crop,exact_overlap}')::boolean, false)
      and v_current_capture #>> '{crop,state_id}' = v_current_capture ->> 'state_id'
      and v_current_capture #> '{crop,css_clip}' = v_localization #> '{sides,current,crop_rect}'
      and jsonb_typeof(v_current_capture -> 'layout') = 'object'
      and v_current_capture #>> '{layout,object_key}' like 'visual-snapshots/published/%'
      and v_current_capture #>> '{layout,sha256}' ~ '^[0-9a-f]{64}$'
      and coalesce((v_current_capture #>> '{layout,byte_length}')::bigint, 0) > 0
      and v_current_capture #>> '{layout,content_type}' like 'application/json%'
      and v_current_capture #>> '{layout,state_id}' = v_current_capture ->> 'state_id'
      and v_current_state_bound
      and v_localization #>> '{sides,current,status}' = 'verified'
      and nullif(btrim(v_localization #>> '{sides,current,exact_text}'), '') is not null
      and jsonb_typeof(v_localization #> '{sides,current,matched_rects}') = 'array'
      and jsonb_array_length(v_localization #> '{sides,current,matched_rects}') > 0
      and jsonb_typeof(v_localization #> '{sides,current,crop_rect}') = 'object'
      and coalesce((v_localization #>> '{sides,current,exact_overlap}')::boolean, false)
      and nullif(btrim(v_localization #>> '{sides,current,algorithm_version}'), '') is not null
      and nullif(btrim(v_localization #>> '{sides,current,state_id}'), '') is not null
      and v_localization #>> '{sides,current,state_id}' is not distinct from
        v_current_capture ->> 'state_id';

    if v_direction = 'added' and v_current_exact is not true then
      raise exception using errcode = '23514', message = 'Added wording must be verified in the current crop.';
    end if;
    if v_direction = 'removed' and v_previous_exact is not true then
      raise exception using errcode = '23514', message = 'Removed wording must be verified in the previous crop.';
    end if;
    if v_direction in ('changed', 'mixed')
      and (v_previous_exact is not true or v_current_exact is not true) then
      raise exception using errcode = '23514', message = 'Changed wording must be verified in both event crops.';
    end if;
  end if;

  insert into public.shared_award_change_events (
    shared_award_id,
    shared_award_source_id,
    source_url,
    source_title,
    source_page_type,
    previous_snapshot_id,
    new_snapshot_id,
    previous_hash,
    new_hash,
    summary,
    change_details,
    first_reported_by_office_id,
    first_reported_by_monitor_id,
    detected_at,
    visual_review_candidate_id
  ) values (
    v_award_id,
    v_source_id,
    v_source_url,
    v_source_title,
    v_source_page_type,
    v_previous_snapshot_id,
    v_new_snapshot_id,
    v_previous_hash,
    v_new_hash,
    v_summary,
    v_change_details,
    v_office_id,
    v_monitor_id,
    v_detected_at,
    v_candidate_id
  )
  on conflict (shared_award_id, source_url, previous_hash, new_hash) do nothing
  returning id into v_event_id;
  v_event_inserted := found;

  if v_event_id is null then
    select event.* into strict v_existing_event
    from public.shared_award_change_events event
    where event.shared_award_id = v_award_id
      and event.source_url = v_source_url
      and event.previous_hash = v_previous_hash
      and event.new_hash = v_new_hash
    for update;

    if v_existing_event.shared_award_source_id is distinct from v_source_id
      or v_existing_event.visual_review_candidate_id is distinct from v_candidate_id
      or v_existing_event.source_title is distinct from v_source_title
      or v_existing_event.source_page_type is distinct from v_source_page_type
      or v_existing_event.previous_snapshot_id is distinct from v_previous_snapshot_id
      or v_existing_event.new_snapshot_id is distinct from v_new_snapshot_id
      or v_existing_event.summary is distinct from v_summary
      or v_existing_event.change_details is distinct from v_change_details
      or v_existing_event.first_reported_by_office_id is distinct from v_office_id
      or v_existing_event.first_reported_by_monitor_id is distinct from v_monitor_id
      or (
        v_detected_at_supplied
        and v_existing_event.detected_at is distinct from v_detected_at
      ) then
      raise exception using
        errcode = '23514',
        message = 'Existing change event identity conflicts with this visual publication.';
    end if;
    v_event_id := v_existing_event.id;
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
    v_event_id,
    v_award_id,
    v_source_id,
    v_candidate_id,
    v_candidate_signature,
    v_bucket,
    v_status,
    v_previous_capture,
    v_current_capture,
    v_localization,
    v_schema_version,
    case when v_status = 'verified' then now() else null end,
    null
  )
  on conflict on constraint shared_award_change_event_visual_evidence_pkey do nothing
  returning id into v_evidence_id;
  v_evidence_inserted := found;

  if v_evidence_id is null then
    select evidence.* into strict v_existing_evidence
    from public.shared_award_change_event_visual_evidence evidence
    where evidence.change_event_id = v_event_id;

    if v_existing_evidence.shared_award_id <> v_award_id
      or v_existing_evidence.shared_award_source_id is distinct from v_source_id
      or v_existing_evidence.visual_review_candidate_id is distinct from v_candidate_id
      or v_existing_evidence.candidate_signature is distinct from v_candidate_signature
      or v_existing_evidence.bucket is distinct from v_bucket
      or v_existing_evidence.evidence_status <> v_status
      or v_existing_evidence.previous_capture <> v_previous_capture
      or v_existing_evidence.current_capture <> v_current_capture
      or v_existing_evidence.localization <> v_localization
      or v_existing_evidence.evidence_schema_version <> v_schema_version
      or v_existing_evidence.backfilled_at is not null then
      raise exception using
        errcode = '23514',
        message = 'Existing immutable visual evidence conflicts with this publication retry.';
    end if;
    v_evidence_id := v_existing_evidence.id;
  end if;

  change_event_id := v_event_id;
  evidence_id := v_evidence_id;
  inserted := v_event_inserted or v_evidence_inserted;
  return next;
exception
  when no_data_found then
    raise exception using
      errcode = '23503',
      message = 'Visual publication references a missing event or candidate.';
end;
$$;

create or replace function public.backfill_shared_award_visual_event_evidence(
  p_event_id uuid,
  p_evidence jsonb
)
returns table(change_event_id uuid, evidence_id uuid, inserted boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event public.shared_award_change_events%rowtype;
  v_candidate public.shared_award_visual_review_candidates%rowtype;
  v_existing public.shared_award_change_event_visual_evidence%rowtype;
  v_candidate_id uuid;
  v_payload_event_id uuid;
  v_payload_award_id uuid;
  v_payload_source_id uuid;
  v_reverse_event_id uuid;
  v_candidate_signature text;
  v_event_signature text;
  v_reverse_event_text text;
  v_status text;
  v_bucket text;
  v_schema_version text;
  v_previous_capture jsonb;
  v_current_capture jsonb;
  v_localization jsonb;
  v_previous_full_key text;
  v_current_full_key text;
  v_previous_metadata_key text;
  v_current_metadata_key text;
  v_evidence_id uuid;
  v_direct_binding boolean := false;
  v_signature_binding boolean := false;
  v_reverse_binding boolean := false;
begin
  if p_event_id is null or jsonb_typeof(p_evidence) <> 'object' then
    raise exception using
      errcode = '22023',
      message = 'Historical visual backfill requires an event ID and JSON evidence object.';
  end if;

  select event.* into strict v_event
  from public.shared_award_change_events event
  where event.id = p_event_id
  for update;

  begin
    v_candidate_id := nullif(p_evidence ->> 'visual_review_candidate_id', '')::uuid;
    v_payload_event_id := nullif(p_evidence ->> 'change_event_id', '')::uuid;
    v_payload_award_id := nullif(p_evidence ->> 'shared_award_id', '')::uuid;
    v_payload_source_id := nullif(p_evidence ->> 'shared_award_source_id', '')::uuid;
  exception
    when invalid_text_representation then
      raise exception using errcode = '22023', message = 'Historical evidence identifiers must be valid UUIDs.';
  end;

  if v_payload_event_id is not null and v_payload_event_id <> p_event_id then
    raise exception using errcode = '23514', message = 'Historical evidence change_event_id does not match the locked event.';
  end if;
  if v_payload_award_id is distinct from v_event.shared_award_id
    or v_payload_source_id is distinct from v_event.shared_award_source_id then
    raise exception using errcode = '23514', message = 'Historical evidence award/source identity does not match the event.';
  end if;

  v_status := nullif(btrim(p_evidence ->> 'evidence_status'), '');
  v_bucket := nullif(btrim(p_evidence ->> 'bucket'), '');
  v_schema_version := coalesce(
    nullif(btrim(p_evidence ->> 'evidence_schema_version'), ''),
    'visual-event-evidence-v1'
  );
  v_previous_capture := coalesce(p_evidence -> 'previous_capture', '{}'::jsonb);
  v_current_capture := coalesce(p_evidence -> 'current_capture', '{}'::jsonb);
  v_localization := coalesce(p_evidence -> 'localization', '{}'::jsonb);

  if v_status is null or v_status not in (
    'verified',
    'unavailable_exact_text_missing',
    'unavailable_geometry_missing',
    'unavailable_image_missing',
    'unavailable_ambiguous',
    'historical_artifact_unrecoverable',
    'full_screenshot_fallback',
    'not_applicable_pdf'
  ) then
    raise exception using errcode = '23514', message = 'Historical evidence supplied an unknown status.';
  end if;
  if jsonb_typeof(v_previous_capture) <> 'object'
    or jsonb_typeof(v_current_capture) <> 'object'
    or jsonb_typeof(v_localization) <> 'object' then
    raise exception using errcode = '22023', message = 'Historical capture and localization payloads must be JSON objects.';
  end if;
  if v_status = 'historical_artifact_unrecoverable' and (
    coalesce(
      (v_localization ->> 'terminal_artifact_loss_confirmed')::boolean,
      false
    ) is not true
    or nullif(btrim(v_localization ->> 'terminal_artifact_loss_reason'), '') is null
    or v_localization #>> '{sides,previous,status}' is distinct from
      'historical_artifact_unrecoverable'
    or nullif(btrim(v_localization #>> '{sides,previous,reason}'), '') is null
    or v_localization #>> '{sides,current,status}' is distinct from
      'historical_artifact_unrecoverable'
    or nullif(btrim(v_localization #>> '{sides,current,reason}'), '') is null
  ) then
    raise exception using
      errcode = '23514',
      message = 'Historical artifact loss must be explicitly confirmed before immutable backfill.';
  end if;
  perform public.awardping_validate_capture_artifact_references(v_previous_capture, 'previous');
  perform public.awardping_validate_capture_artifact_references(v_current_capture, 'current');
  if v_localization #>> '{sides,previous,status}' = 'verified' then
    perform public.awardping_validate_exact_visual_evidence_side(
      v_previous_capture,
      v_localization #> '{sides,previous}',
      'previous'
    );
  end if;
  if v_localization #>> '{sides,current,status}' = 'verified' then
    perform public.awardping_validate_exact_visual_evidence_side(
      v_current_capture,
      v_localization #> '{sides,current}',
      'current'
    );
  end if;

  v_candidate_signature := nullif(btrim(p_evidence ->> 'candidate_signature'), '');
  v_event_signature := nullif(btrim(v_event.change_details ->> 'candidate_signature'), '');
  if v_candidate_id is null then
    if v_status <> 'historical_artifact_unrecoverable'
      or v_previous_capture <> '{}'::jsonb
      or v_current_capture <> '{}'::jsonb
      or v_bucket is not null
      or coalesce(
        (v_localization ->> 'terminal_artifact_loss_confirmed')::boolean,
        false
      ) is not true
      or nullif(btrim(v_localization ->> 'terminal_artifact_loss_reason'), '') is null
      or v_localization #>> '{sides,previous,status}' is distinct from
        'historical_artifact_unrecoverable'
      or nullif(btrim(v_localization #>> '{sides,previous,reason}'), '') is null
      or v_localization #>> '{sides,current,status}' is distinct from
        'historical_artifact_unrecoverable'
      or nullif(btrim(v_localization #>> '{sides,current,reason}'), '') is null
      or v_localization #>> '{sides,previous,status}' = 'verified'
      or v_localization #>> '{sides,current,status}' = 'verified' then
      raise exception using
        errcode = '23514',
        message = 'Candidate-free historical evidence requires explicit terminal artifact-loss confirmation and empty unrecoverable manifests.';
    end if;
    if v_event.visual_review_candidate_id is not null then
      raise exception using errcode = '23514', message = 'Candidate-free backfill conflicts with the event review-candidate binding.';
    end if;
    if v_candidate_signature is not null
      and v_event_signature is distinct from v_candidate_signature then
      raise exception using errcode = '23514', message = 'Historical candidate signature conflicts with the event signature.';
    end if;
  else
    select candidate.* into strict v_candidate
    from public.shared_award_visual_review_candidates candidate
    where candidate.id = v_candidate_id
    for update;

    if v_candidate.shared_award_id <> v_event.shared_award_id
      or v_candidate.shared_award_source_id is distinct from v_event.shared_award_source_id
      or v_candidate_signature is distinct from v_candidate.candidate_signature then
      raise exception using errcode = '23514', message = 'Historical candidate signature/award/source identity mismatch.';
    end if;
    if v_candidate.status not in ('succeeded', 'published') then
      raise exception using errcode = '23514', message = 'Historical evidence requires a successfully reviewed candidate.';
    end if;
    if v_event.visual_review_candidate_id is not null
      and v_event.visual_review_candidate_id <> v_candidate_id then
      raise exception using errcode = '23514', message = 'Historical candidate conflicts with the event candidate binding.';
    end if;
    if v_event_signature is not null and v_event_signature <> v_candidate.candidate_signature then
      raise exception using errcode = '23514', message = 'Historical candidate conflicts with the event signature.';
    end if;

    v_reverse_event_text := nullif(btrim(v_candidate.worker_metadata ->> 'change_event_id'), '');
    if v_reverse_event_text is not null then
      begin
        v_reverse_event_id := v_reverse_event_text::uuid;
      exception
        when invalid_text_representation then
          raise exception using errcode = '23514', message = 'Historical candidate has an invalid reverse event binding.';
      end;
      if v_reverse_event_id <> p_event_id then
        raise exception using errcode = '23514', message = 'Historical candidate reverse event binding conflicts with the event.';
      end if;
    end if;

    v_direct_binding := v_event.visual_review_candidate_id = v_candidate_id;
    v_signature_binding := v_event_signature = v_candidate.candidate_signature;
    v_reverse_binding := v_reverse_event_id = p_event_id;
    if not coalesce(v_direct_binding or v_signature_binding or v_reverse_binding, false) then
      raise exception using
        errcode = '23514',
        message = 'Historical candidate has no exact direct, signature, or reverse event binding.';
    end if;
    if v_status <> 'historical_artifact_unrecoverable' then
      if v_candidate.worker_metadata ->> 'evidence_signature' is null
        or v_candidate.worker_metadata ->> 'evidence_signature' !~ '^[0-9a-f]{64}$' then
        raise exception using
          errcode = '23514',
          message = 'Recoverable historical evidence requires the immutable candidate evidence signature.';
      end if;
      perform public.awardping_validate_candidate_snapshot_manifest(
        v_candidate.previous_snapshot_ref,
        v_candidate.prompt_payload -> 'previous_snapshot_ref',
        v_candidate.prompt_payload #>> '{hashes,previous_artifact_manifest_digest}',
        'previous'
      );
      perform public.awardping_validate_candidate_snapshot_manifest(
        v_candidate.new_snapshot_ref,
        v_candidate.prompt_payload -> 'new_snapshot_ref',
        v_candidate.prompt_payload #>> '{hashes,new_artifact_manifest_digest}',
        'current'
      );
    end if;
    perform public.awardping_validate_candidate_capture_binding(
      v_previous_capture,
      case
        when jsonb_typeof(v_candidate.previous_snapshot_ref) = 'object'
          and v_candidate.previous_snapshot_ref <> '{}'::jsonb
          then v_candidate.previous_snapshot_ref
        else coalesce(v_candidate.prompt_payload -> 'previous_snapshot_ref', '{}'::jsonb)
      end,
      coalesce(
        v_candidate.previous_image_hash,
        nullif(v_candidate.previous_snapshot_ref ->> 'image_hash', ''),
        nullif(v_candidate.prompt_payload #>> '{previous_snapshot_ref,image_hash}', ''),
        nullif(v_candidate.prompt_payload #>> '{hashes,previous_image_hash}', '')
      ),
      v_candidate_id,
      'previous',
      v_status in ('verified', 'not_applicable_pdf')
    );
    perform public.awardping_validate_candidate_capture_binding(
      v_current_capture,
      case
        when jsonb_typeof(v_candidate.new_snapshot_ref) = 'object'
          and v_candidate.new_snapshot_ref <> '{}'::jsonb
          then v_candidate.new_snapshot_ref
        else coalesce(v_candidate.prompt_payload -> 'new_snapshot_ref', '{}'::jsonb)
      end,
      coalesce(
        v_candidate.new_image_hash,
        nullif(v_candidate.new_snapshot_ref ->> 'image_hash', ''),
        nullif(v_candidate.prompt_payload #>> '{new_snapshot_ref,image_hash}', ''),
        nullif(v_candidate.prompt_payload #>> '{hashes,new_image_hash}', '')
      ),
      v_candidate_id,
      'current',
      v_status in ('verified', 'not_applicable_pdf')
    );
  end if;

  if v_status = 'historical_artifact_unrecoverable' then
    if v_previous_capture <> '{}'::jsonb
      or v_current_capture <> '{}'::jsonb
      or v_bucket is not null then
      raise exception using
        errcode = '23514',
        message = 'Unrecoverable historical evidence must use empty captures and no artifact bucket.';
    end if;
  else
    v_previous_full_key := nullif(v_previous_capture #>> '{full,object_key}', '');
    v_current_full_key := nullif(v_current_capture #>> '{full,object_key}', '');
    v_previous_metadata_key := nullif(v_previous_capture #>> '{metadata,object_key}', '');
    v_current_metadata_key := nullif(v_current_capture #>> '{metadata,object_key}', '');
    if v_bucket is null then
      raise exception using errcode = '23514', message = 'Recoverable historical evidence requires an artifact bucket.';
    end if;
    if v_status in (
      'verified',
      'unavailable_exact_text_missing',
      'unavailable_geometry_missing',
      'unavailable_ambiguous',
      'full_screenshot_fallback'
    ) and (
      v_previous_full_key is null
      or v_current_full_key is null
      or v_previous_metadata_key is null
      or v_current_metadata_key is null
    ) then
      raise exception using
        errcode = '23514',
        message = 'Historical full-screenshot evidence requires both event images and metadata objects.';
    end if;
    if v_status = 'unavailable_image_missing'
      and v_previous_full_key is null
      and v_current_full_key is null then
      raise exception using
        errcode = '23514',
        message = 'History with no retained image must be marked historical_artifact_unrecoverable.';
    end if;
    if v_status = 'not_applicable_pdf'
      and (v_previous_full_key is null or v_current_full_key is null) then
      raise exception using
        errcode = '23514',
        message = 'Historical PDF evidence requires both retained immutable documents.';
    end if;
    if (v_previous_full_key is null) is distinct from (v_previous_metadata_key is null)
      or (v_current_full_key is null) is distinct from (v_current_metadata_key is null) then
      raise exception using
        errcode = '23514',
        message = 'Each retained historical full artifact requires its matching metadata object.';
    end if;
    if (
      v_previous_full_key is not null
      and (
        v_previous_full_key not like 'visual-snapshots/published/%'
        or v_previous_capture #>> '{full,sha256}' is null
        or v_previous_capture #>> '{full,sha256}' !~ '^[0-9a-f]{64}$'
        or coalesce((v_previous_capture #>> '{full,byte_length}')::bigint, 0) <= 0
      )
    ) or (
      v_current_full_key is not null
      and (
        v_current_full_key not like 'visual-snapshots/published/%'
        or v_current_capture #>> '{full,sha256}' is null
        or v_current_capture #>> '{full,sha256}' !~ '^[0-9a-f]{64}$'
        or coalesce((v_current_capture #>> '{full,byte_length}')::bigint, 0) <= 0
      )
    ) then
      raise exception using errcode = '23514', message = 'Historical full artifacts failed permanent-key/hash/size validation.';
    end if;
    if (
      v_previous_metadata_key is not null
      and (
        v_previous_metadata_key not like 'visual-snapshots/published/%'
        or v_previous_capture #>> '{metadata,sha256}' is null
        or v_previous_capture #>> '{metadata,sha256}' !~ '^[0-9a-f]{64}$'
        or coalesce((v_previous_capture #>> '{metadata,byte_length}')::bigint, 0) <= 0
      )
    ) or (
      v_current_metadata_key is not null
      and (
        v_current_metadata_key not like 'visual-snapshots/published/%'
        or v_current_capture #>> '{metadata,sha256}' is null
        or v_current_capture #>> '{metadata,sha256}' !~ '^[0-9a-f]{64}$'
        or coalesce((v_current_capture #>> '{metadata,byte_length}')::bigint, 0) <= 0
      )
    ) then
      raise exception using errcode = '23514', message = 'Historical metadata artifacts failed permanent-key/hash/size validation.';
    end if;
    if v_status = 'not_applicable_pdf' and (
      nullif(btrim(v_previous_capture #>> '{full,content_type}'), '') is null
      or v_previous_capture #>> '{full,content_type}' not like 'application/pdf%'
      or nullif(btrim(v_current_capture #>> '{full,content_type}'), '') is null
      or v_current_capture #>> '{full,content_type}' not like 'application/pdf%'
      or nullif(btrim(v_previous_capture #>> '{metadata,content_type}'), '') is null
      or v_previous_capture #>> '{metadata,content_type}' not like 'application/json%'
      or nullif(btrim(v_current_capture #>> '{metadata,content_type}'), '') is null
      or v_current_capture #>> '{metadata,content_type}' not like 'application/json%'
      or v_previous_capture #>> '{capture_hashes,file_hash}' is null
      or v_previous_capture #>> '{capture_hashes,file_hash}' !~ '^[0-9a-f]{64}$'
      or v_current_capture #>> '{capture_hashes,file_hash}' is null
      or v_current_capture #>> '{capture_hashes,file_hash}' !~ '^[0-9a-f]{64}$'
      or v_previous_capture #>> '{full,sha256}' is distinct from
        v_previous_capture #>> '{capture_hashes,file_hash}'
      or v_current_capture #>> '{full,sha256}' is distinct from
        v_current_capture #>> '{capture_hashes,file_hash}'
    ) then
      raise exception using
        errcode = '23514',
        message = 'Historical PDF documents must match their file hashes and carry PDF/JSON content types.';
    end if;
    if v_previous_full_key is not null
      and (
        v_previous_capture ->> 'kind' = 'pdf'
        or v_previous_capture #>> '{full,content_type}' like 'application/pdf%'
      ) and (
        v_previous_capture ->> 'kind' is distinct from 'pdf'
        or v_previous_capture #>> '{full,content_type}' not like 'application/pdf%'
        or v_previous_capture #>> '{metadata,content_type}' not like 'application/json%'
        or v_previous_capture #>> '{capture_hashes,file_hash}' is null
        or v_previous_capture #>> '{capture_hashes,file_hash}' !~ '^[0-9a-f]{64}$'
        or v_previous_capture #>> '{full,sha256}' is distinct from
          v_previous_capture #>> '{capture_hashes,file_hash}'
      ) then
      raise exception using
        errcode = '23514',
        message = 'The retained previous historical PDF side failed document/metadata/file-hash validation.';
    end if;
    if v_current_full_key is not null
      and (
        v_current_capture ->> 'kind' = 'pdf'
        or v_current_capture #>> '{full,content_type}' like 'application/pdf%'
      ) and (
        v_current_capture ->> 'kind' is distinct from 'pdf'
        or v_current_capture #>> '{full,content_type}' not like 'application/pdf%'
        or v_current_capture #>> '{metadata,content_type}' not like 'application/json%'
        or v_current_capture #>> '{capture_hashes,file_hash}' is null
        or v_current_capture #>> '{capture_hashes,file_hash}' !~ '^[0-9a-f]{64}$'
        or v_current_capture #>> '{full,sha256}' is distinct from
          v_current_capture #>> '{capture_hashes,file_hash}'
      ) then
      raise exception using
        errcode = '23514',
        message = 'The retained current historical PDF side failed document/metadata/file-hash validation.';
    end if;
  end if;

  if v_candidate_id is not null and v_status <> 'historical_artifact_unrecoverable' then
    if v_previous_full_key is not null and (
      (
        v_candidate.previous_image_hash is not null
        and v_previous_capture #>> '{capture_hashes,image_hash}' is distinct from v_candidate.previous_image_hash
      ) or (
        v_candidate.previous_text_hash is not null
        and v_previous_capture #>> '{capture_hashes,text_hash}' is distinct from v_candidate.previous_text_hash
      ) or (
        v_candidate.previous_file_hash is not null
        and v_previous_capture #>> '{capture_hashes,file_hash}' is distinct from v_candidate.previous_file_hash
      )
    ) then
      raise exception using errcode = '23514', message = 'Historical previous capture hashes do not match the candidate.';
    end if;
    if v_current_full_key is not null and (
      (
        v_candidate.new_image_hash is not null
        and v_current_capture #>> '{capture_hashes,image_hash}' is distinct from v_candidate.new_image_hash
      ) or (
        v_candidate.new_text_hash is not null
        and v_current_capture #>> '{capture_hashes,text_hash}' is distinct from v_candidate.new_text_hash
      ) or (
        v_candidate.new_file_hash is not null
        and v_current_capture #>> '{capture_hashes,file_hash}' is distinct from v_candidate.new_file_hash
      )
    ) then
      raise exception using errcode = '23514', message = 'Historical current capture hashes do not match the candidate.';
    end if;
  end if;

  if v_status = 'verified' then
    if v_candidate_id is null then
      raise exception using errcode = '23514', message = 'Verified historical evidence requires a bound candidate.';
    end if;
    if nullif(btrim(v_previous_capture ->> 'captured_at'), '') is null
      or nullif(btrim(v_current_capture ->> 'captured_at'), '') is null
      or nullif(btrim(v_previous_capture ->> 'state_id'), '') is null
      or nullif(btrim(v_current_capture ->> 'state_id'), '') is null
      or v_previous_capture #>> '{capture_hashes,image_hash}' is null
      or v_previous_capture #>> '{capture_hashes,image_hash}' !~ '^[0-9a-f]{64}$'
      or v_current_capture #>> '{capture_hashes,image_hash}' is null
      or v_current_capture #>> '{capture_hashes,image_hash}' !~ '^[0-9a-f]{64}$'
      or v_previous_capture #>> '{capture_hashes,text_hash}' is null
      or v_previous_capture #>> '{capture_hashes,text_hash}' !~ '^[0-9a-f]{64}$'
      or v_current_capture #>> '{capture_hashes,text_hash}' is null
      or v_current_capture #>> '{capture_hashes,text_hash}' !~ '^[0-9a-f]{64}$'
      or coalesce((v_previous_capture #>> '{full,width}')::integer, 0) <= 0
      or coalesce((v_previous_capture #>> '{full,height}')::integer, 0) <= 0
      or coalesce((v_current_capture #>> '{full,width}')::integer, 0) <= 0
      or coalesce((v_current_capture #>> '{full,height}')::integer, 0) <= 0
      or nullif(btrim(v_previous_capture #>> '{full,content_type}'), '') is null
      or v_previous_capture #>> '{full,content_type}' not like 'image/%'
      or nullif(btrim(v_current_capture #>> '{full,content_type}'), '') is null
      or v_current_capture #>> '{full,content_type}' not like 'image/%'
      or nullif(btrim(v_previous_capture #>> '{metadata,content_type}'), '') is null
      or v_previous_capture #>> '{metadata,content_type}' not like 'application/json%'
      or nullif(btrim(v_current_capture #>> '{metadata,content_type}'), '') is null
      or v_current_capture #>> '{metadata,content_type}' not like 'application/json%' then
      raise exception using
        errcode = '23514',
        message = 'Verified historical evidence requires the complete new-format image/text/state manifest.';
    end if;
    perform public.awardping_validate_exact_visual_evidence(
      v_previous_capture,
      v_current_capture,
      v_localization
    );
  end if;

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
      or v_existing.backfilled_at is null then
      raise exception using
        errcode = '23514',
        message = 'Existing immutable visual evidence conflicts with this historical backfill retry.';
    end if;
    change_event_id := p_event_id;
    evidence_id := v_existing.id;
    inserted := false;
    return next;
    return;
  end if;

  if v_candidate_id is not null and v_event.visual_review_candidate_id is null then
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
    case when v_status = 'verified' then now() else null end,
    now()
  )
  returning id into v_evidence_id;

  change_event_id := p_event_id;
  evidence_id := v_evidence_id;
  inserted := true;
  return next;
exception
  when no_data_found then
    raise exception using
      errcode = '23503',
      message = 'Historical visual backfill references a missing event or candidate.';
end;
$$;

create or replace function public.retire_shared_award_source_preserving_visual_history(
  p_source_id uuid,
  p_reason text,
  p_actor text
)
returns table(
  source_id uuid,
  matched_event_count integer,
  newly_suppressed_event_count integer,
  already_suppressed_event_count integer,
  already_retired boolean,
  homepage_cleared boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor text := nullif(btrim(p_actor), '');
  v_already_retired boolean := false;
  v_homepage_clear_count integer := 0;
  v_matched_event_count integer := 0;
  v_newly_suppressed_event_count integer := 0;
  v_reason text := nullif(btrim(p_reason), '');
  v_source public.shared_award_sources%rowtype;
  v_suppressed_before_count integer := 0;
  v_now timestamptz := now();
begin
  if p_source_id is null or v_reason is null or v_actor is null then
    raise exception using
      errcode = '22023',
      message = 'Source retirement requires a source ID, non-empty reason, and non-empty actor.';
  end if;

  select source.* into strict v_source
  from public.shared_award_sources source
  where source.id = p_source_id
  for update;

  v_already_retired := v_source.admin_review_status = 'review_later'
    and v_source.admin_review_note is not distinct from v_reason
    and v_source.admin_reviewed_by is not distinct from v_actor;

  perform event.id
  from public.shared_award_change_events event
  where event.shared_award_source_id = v_source.id
    or (
      event.shared_award_id = v_source.shared_award_id
      and event.source_url = v_source.url
    )
  for update;

  select
    count(*)::integer,
    count(*) filter (where event.suppressed_at is not null)::integer
  into v_matched_event_count, v_suppressed_before_count
  from public.shared_award_change_events event
  where event.shared_award_source_id = v_source.id
    or (
      event.shared_award_id = v_source.shared_award_id
      and event.source_url = v_source.url
    );

  update public.shared_award_change_events event
  set
    suppressed_at = v_now,
    suppression_reason = v_reason,
    suppression_source = 'source_retirement'
  where (
    event.shared_award_source_id = v_source.id
    or (
      event.shared_award_id = v_source.shared_award_id
      and event.source_url = v_source.url
    )
  )
    and event.suppressed_at is null;
  get diagnostics v_newly_suppressed_event_count = row_count;

  if not v_already_retired then
    update public.shared_award_sources source
    set
      admin_review_status = 'review_later',
      admin_review_note = v_reason,
      admin_reviewed_at = v_now,
      admin_reviewed_by = v_actor,
      updated_at = v_now
    where source.id = v_source.id;
  end if;

  update public.shared_awards award
  set
    official_homepage = null,
    updated_at = v_now
  where award.id = v_source.shared_award_id
    and award.official_homepage = v_source.url;
  get diagnostics v_homepage_clear_count = row_count;

  source_id := v_source.id;
  matched_event_count := v_matched_event_count;
  newly_suppressed_event_count := v_newly_suppressed_event_count;
  already_suppressed_event_count := v_suppressed_before_count;
  already_retired := v_already_retired;
  homepage_cleared := v_homepage_clear_count = 1;
  return next;
exception
  when no_data_found then
    raise exception using
      errcode = '23503',
      message = 'Source retirement references a missing shared award source.';
end;
$$;

revoke all on function public.awardping_validate_visual_evidence_insert()
  from public, anon, authenticated;
revoke all on function public.awardping_reject_visual_evidence_mutation()
  from public, anon, authenticated;
revoke all on function public.awardping_preserve_visual_event_candidate_binding()
  from public, anon, authenticated;
revoke all on function public.awardping_preserve_published_visual_candidate_identity()
  from public, anon, authenticated;
revoke all on function public.awardping_require_visual_event_evidence()
  from public, anon, authenticated;
revoke all on function public.awardping_assert_permanent_visual_artifact(jsonb, text)
  from public, anon, authenticated, service_role;
revoke all on function public.awardping_sha256_text(text)
  from public, anon, authenticated, service_role;
revoke all on function public.awardping_validate_candidate_snapshot_manifest(jsonb, jsonb, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.awardping_assert_candidate_artifact_matches(jsonb, jsonb, text, boolean)
  from public, anon, authenticated, service_role;
revoke all on function public.awardping_validate_capture_artifact_references(jsonb, text)
  from public, anon, authenticated, service_role;
revoke all on function public.awardping_validate_candidate_capture_prefix(jsonb, uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function public.awardping_validate_capture_state_binding(jsonb, text)
  from public, anon, authenticated, service_role;
revoke all on function public.awardping_validate_candidate_capture_binding(jsonb, jsonb, text, uuid, text, boolean)
  from public, anon, authenticated, service_role;
revoke all on function public.awardping_visual_rectangles_overlap(jsonb, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.awardping_validate_exact_visual_evidence_side(jsonb, jsonb, text)
  from public, anon, authenticated, service_role;
revoke all on function public.awardping_validate_exact_visual_evidence(jsonb, jsonb, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.publish_shared_award_visual_event(jsonb, jsonb)
  from public, anon, authenticated;
revoke all on function public.backfill_shared_award_visual_event_evidence(uuid, jsonb)
  from public, anon, authenticated;
revoke all on function public.retire_shared_award_source_preserving_visual_history(uuid, text, text)
  from public, anon, authenticated;

grant execute on function public.awardping_validate_visual_evidence_insert()
  to service_role;
grant execute on function public.awardping_reject_visual_evidence_mutation()
  to service_role;
grant execute on function public.awardping_preserve_visual_event_candidate_binding()
  to service_role;
grant execute on function public.awardping_preserve_published_visual_candidate_identity()
  to service_role;
grant execute on function public.awardping_require_visual_event_evidence()
  to service_role;
grant execute on function public.publish_shared_award_visual_event(jsonb, jsonb)
  to service_role;
grant execute on function public.backfill_shared_award_visual_event_evidence(uuid, jsonb)
  to service_role;
grant execute on function public.retire_shared_award_source_preserving_visual_history(uuid, text, text)
  to service_role;

comment on table public.shared_award_change_event_visual_evidence is
  'Immutable, event-specific visual evidence bound to the review candidate archive manifest. Object keys use the permanent published prefix and never depend on the moving source snapshot pointer.';
comment on column public.shared_award_change_event_visual_evidence.previous_capture is
  'Versioned previous-side manifest: full/metadata/crop immutable objects, candidate byte hashes, captured_at, expansion state identity, and the crop source-image binding.';
comment on column public.shared_award_change_event_visual_evidence.current_capture is
  'Versioned current-side manifest: full/metadata/crop immutable objects, candidate byte hashes, captured_at, expansion state identity, and the crop source-image binding.';
comment on column public.shared_award_change_event_visual_evidence.localization is
  'Exact-text localization result with side-specific text-node rectangles, crop rectangles, overlap proof, algorithm version, and honest unavailable reason.';
comment on function public.publish_shared_award_visual_event(jsonb, jsonb) is
  'Atomically binds a new visual change event to its review candidate and immutable per-event evidence; equivalent retries succeed and mismatches fail closed.';
comment on function public.backfill_shared_award_visual_event_evidence(uuid, jsonb) is
  'Insert-once historical evidence backfill. Recoverable artifacts require an exact candidate binding and permanent byte manifests; all unrecoverable rows require explicit terminal-loss confirmation, and candidate-free rows must also use empty captures.';
comment on function public.retire_shared_award_source_preserving_visual_history(uuid, text, text) is
  'Atomically retires a shared source without deleting history: suppresses direct and exact legacy URL events, marks the source review_later, and clears only its exact public homepage URL.';
