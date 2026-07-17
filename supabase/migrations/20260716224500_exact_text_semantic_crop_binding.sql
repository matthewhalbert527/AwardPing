-- Bind every newly verified visual crop to exact directional wording in the
-- immutable change event. Existing visual-event-evidence-v1 rows remain
-- immutable; application and coverage readers intentionally downgrade their
-- crops to event-specific full-screenshot fallbacks.

create or replace function public.awardping_normalize_visual_exact_text(p_value text)
returns text
language sql
immutable
security invoker
set search_path = ''
as $$
  select btrim(
    pg_catalog.regexp_replace(
      pg_catalog.regexp_replace(
        pg_catalog.regexp_replace(
          normalize(coalesce(p_value, ''), NFKC),
          '[‘’‚‛′]',
          '''',
          'g'
        ),
        '[“”„‟″]',
        '"',
        'g'
      ),
      '[[:space:]   ]+',
      ' ',
      'g'
    )
  );
$$;

create or replace function public.awardping_visual_json_text_values(p_value jsonb)
returns setof text
language sql
immutable
security invoker
set search_path = ''
as $$
  select p_value #>> '{}'
  where pg_catalog.jsonb_typeof(p_value) = 'string'
  union all
  select item.value #>> '{}'
  from pg_catalog.jsonb_array_elements(
    case when pg_catalog.jsonb_typeof(p_value) = 'array' then p_value else '[]'::jsonb end
  ) as item(value)
  where pg_catalog.jsonb_typeof(item.value) = 'string';
$$;

create or replace function public.awardping_visual_semantic_text_allowed(
  p_change_details jsonb,
  p_side text,
  p_source text,
  p_exact_text text
)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $$
  with details as (
    select case
      when pg_catalog.jsonb_typeof(p_change_details) = 'object' then p_change_details
      else '{}'::jsonb
    end as value
  ), candidates as (
    select
      case when p_side = 'previous'
        then 'change_details.exact_before'
        else 'change_details.exact_after'
      end as source,
      exact_value.value as wording
    from details
    cross join lateral public.awardping_visual_json_text_values(
      case when p_side = 'previous'
        then details.value -> 'exact_before'
        else details.value -> 'exact_after'
      end
    ) as exact_value(value)
    union all
    select
      'change_details.changed_facts.' ||
        case when p_side = 'previous' then 'removed_text' else 'added_text' end,
      fact_value.value
    from details
    cross join lateral pg_catalog.jsonb_array_elements(
      coalesce(
        case when pg_catalog.jsonb_typeof(details.value -> 'changed_facts') = 'array'
          then details.value -> 'changed_facts' end,
        '[]'::jsonb
      ) || coalesce(
        case when pg_catalog.jsonb_typeof(details.value -> 'changed_award_facts') = 'array'
          then details.value -> 'changed_award_facts' end,
        '[]'::jsonb
      )
    ) as fact(value)
    cross join lateral public.awardping_visual_json_text_values(
      fact.value -> case when p_side = 'previous' then 'removed_text' else 'added_text' end
    ) as fact_value(value)
    union all
    select
      'change_details.structured_diff.' ||
        case when p_side = 'previous' then 'removed_text' else 'added_text' end,
      structured_value.value
    from details
    cross join lateral public.awardping_visual_json_text_values(
      details.value -> 'structured_diff' ->
        case when p_side = 'previous' then 'removed_text' else 'added_text' end
    ) as structured_value(value)
  )
  select p_side in ('previous', 'current')
    and exists (
      select 1
      from candidates
      where candidates.source = p_source
        and public.awardping_normalize_visual_exact_text(candidates.wording) =
          public.awardping_normalize_visual_exact_text(p_exact_text)
        and public.awardping_normalize_visual_exact_text(candidates.wording) <> ''
    );
$$;

-- Directional presence is checked across every allowed exact wording source so
-- a publisher cannot omit one side of a mixed event.
create or replace function public.awardping_visual_event_has_semantic_side(
  p_change_details jsonb,
  p_side text
)
returns boolean
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  v_fact jsonb;
  v_value text;
begin
  if p_side not in ('previous', 'current') or pg_catalog.jsonb_typeof(p_change_details) <> 'object' then
    return false;
  end if;
  for v_value in
    select value from public.awardping_visual_json_text_values(
      case when p_side = 'previous'
        then p_change_details -> 'exact_before'
        else p_change_details -> 'exact_after'
      end
    )
  loop
    if public.awardping_normalize_visual_exact_text(v_value) <> '' then return true; end if;
  end loop;
  for v_value in
    select value from public.awardping_visual_json_text_values(
      p_change_details -> 'structured_diff' ->
        case when p_side = 'previous' then 'removed_text' else 'added_text' end
    )
  loop
    if public.awardping_normalize_visual_exact_text(v_value) <> '' then return true; end if;
  end loop;
  for v_fact in
    select value
    from pg_catalog.jsonb_array_elements(
      coalesce(
        case when pg_catalog.jsonb_typeof(p_change_details -> 'changed_facts') = 'array'
          then p_change_details -> 'changed_facts' end,
        '[]'::jsonb
      ) || coalesce(
        case when pg_catalog.jsonb_typeof(p_change_details -> 'changed_award_facts') = 'array'
          then p_change_details -> 'changed_award_facts' end,
        '[]'::jsonb
      )
    )
  loop
    for v_value in
      select value from public.awardping_visual_json_text_values(
        v_fact -> case when p_side = 'previous' then 'removed_text' else 'added_text' end
      )
    loop
      if public.awardping_normalize_visual_exact_text(v_value) <> '' then return true; end if;
    end loop;
  end loop;
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
  v_binding jsonb := coalesce(p_side_localization -> 'semantic_binding', '{}'::jsonb);
  v_state_bound boolean := false;
  v_rect_overlap boolean := false;
begin
  if pg_catalog.jsonb_typeof(p_capture -> 'states') = 'array' then
    select exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_capture -> 'states') as state(value)
      where state.value ->> 'state_id' = p_capture ->> 'state_id'
        and state.value #>> '{image,object_key}' = p_capture #>> '{full,object_key}'
        and state.value #>> '{image,sha256}' = p_capture #>> '{full,sha256}'
        and state.value #>> '{image,byte_length}' = p_capture #>> '{full,byte_length}'
        and state.value #>> '{geometry,object_key}' = p_capture #>> '{layout,object_key}'
    ) into v_state_bound;
  end if;
  if pg_catalog.jsonb_typeof(p_side_localization -> 'matched_rects') = 'array'
    and pg_catalog.jsonb_typeof(p_side_localization -> 'crop_rect') = 'object' then
    select coalesce(
      pg_catalog.bool_and(
        public.awardping_visual_rectangles_overlap(rect.value, p_side_localization -> 'crop_rect')
      ),
      false
    ) into v_rect_overlap
    from pg_catalog.jsonb_array_elements(p_side_localization -> 'matched_rects') as rect(value);
  end if;

  if not (
    p_side in ('previous', 'current')
    and p_side_localization ->> 'status' = 'verified'
    and p_side_localization ->> 'algorithm_version' = '3'
    and coalesce((p_side_localization ->> 'semantic_verified')::boolean, false)
    and nullif(btrim(p_side_localization ->> 'exact_text'), '') is not null
    and pg_catalog.jsonb_typeof(p_side_localization -> 'matched_rects') = 'array'
    and pg_catalog.jsonb_array_length(p_side_localization -> 'matched_rects') > 0
    and pg_catalog.jsonb_typeof(p_side_localization -> 'crop_rect') = 'object'
    and pg_catalog.jsonb_typeof(p_side_localization -> 'crop_rect_pixels') = 'object'
    and coalesce((p_side_localization ->> 'exact_overlap')::boolean, false)
    and nullif(btrim(p_side_localization ->> 'state_id'), '') is not null
    and p_side_localization ->> 'state_id' = p_capture ->> 'state_id'
    and v_rect_overlap
    and v_binding ->> 'contract' = 'visual-exact-text-binding-v2'
    and v_binding ->> 'algorithm_version' = '3'
    and v_binding ->> 'side' = p_side
    and v_binding ->> 'state_id' = p_capture ->> 'state_id'
    and v_binding ->> 'wording_source' in (
      'change_details.exact_before',
      'change_details.exact_after',
      'change_details.changed_facts.removed_text',
      'change_details.changed_facts.added_text',
      'change_details.structured_diff.removed_text',
      'change_details.structured_diff.added_text'
    )
    and v_binding ->> 'exact_text_sha256' = public.awardping_sha256_text(
      public.awardping_normalize_visual_exact_text(p_side_localization ->> 'exact_text')
    )
    and v_binding ->> 'candidates_sha256' ~ '^[0-9a-f]{64}$'
    and v_binding ->> 'change_semantics_sha256' ~ '^[0-9a-f]{64}$'
    and v_binding ->> 'matched_rects_sha256' ~ '^[0-9a-f]{64}$'
    and v_binding ->> 'crop_rect_sha256' ~ '^[0-9a-f]{64}$'
    and v_binding ->> 'crop_rect_pixels_sha256' ~ '^[0-9a-f]{64}$'
    and v_binding ->> 'binding_sha256' ~ '^[0-9a-f]{64}$'
    and pg_catalog.jsonb_typeof(p_capture -> 'crop') = 'object'
    and p_capture #>> '{crop,object_key}' like 'visual-snapshots/published/%'
    and p_capture #>> '{crop,sha256}' ~ '^[0-9a-f]{64}$'
    and coalesce((p_capture #>> '{crop,byte_length}')::bigint, 0) > 0
    and p_capture #>> '{crop,content_type}' like 'image/%'
    and coalesce((p_capture #>> '{crop,width}')::integer, 0) > 0
    and coalesce((p_capture #>> '{crop,height}')::integer, 0) > 0
    and pg_catalog.jsonb_typeof(p_capture #> '{crop,clip}') = 'object'
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
    and p_capture #>> '{crop,semantic_binding_sha256}' = v_binding ->> 'binding_sha256'
    and p_capture #>> '{crop,exact_text_sha256}' = v_binding ->> 'exact_text_sha256'
    and p_capture #>> '{crop,geometry_sha256}' = v_binding ->> 'geometry_sha256'
    and pg_catalog.jsonb_typeof(p_capture -> 'layout') = 'object'
    and p_capture #>> '{layout,object_key}' like 'visual-snapshots/published/%'
    and p_capture #>> '{layout,sha256}' ~ '^[0-9a-f]{64}$'
    and coalesce((p_capture #>> '{layout,byte_length}')::bigint, 0) > 0
    and p_capture #>> '{layout,content_type}' like 'application/json%'
    and p_capture #>> '{layout,state_id}' = p_capture ->> 'state_id'
    and p_capture #>> '{layout,geometry_hash}' = v_binding ->> 'geometry_sha256'
    and p_capture #>> '{layout,geometry_hash}' ~ '^[0-9a-f]{64}$'
    and v_state_bound
  ) then
    raise exception using
      errcode = '23514',
      message = format(
        'Verified %s evidence must use v3 contiguous-flow event-semantic exact-text, geometry, and crop bindings.',
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
  v_direction text := nullif(btrim(p_localization ->> 'direction'), '');
begin
  if p_localization ->> 'semantic_contract' is distinct from 'visual-exact-text-binding-v2'
    or p_localization ->> 'change_semantics_sha256' !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '23514', message = 'Verified evidence requires a v2 semantic contract.';
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
  if v_direction not in ('added', 'removed', 'changed', 'mixed')
    or (v_direction in ('changed', 'mixed') and (
      p_localization #>> '{sides,previous,status}' is distinct from 'verified'
      or p_localization #>> '{sides,current,status}' is distinct from 'verified'
    )) then
    raise exception using errcode = '23514', message = 'Verified evidence direction is incomplete.';
  end if;
end;
$$;

create or replace function public.awardping_validate_visual_evidence_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_candidate public.shared_award_visual_review_candidates%rowtype;
  v_event public.shared_award_change_events%rowtype;
  v_direction text;
  v_previous_required boolean;
  v_current_required boolean;
  v_previous_localization jsonb;
  v_current_localization jsonb;
begin
  select * into strict v_event
  from public.shared_award_change_events event
  where event.id = new.change_event_id;

  if v_event.shared_award_id <> new.shared_award_id
    or v_event.shared_award_source_id is distinct from new.shared_award_source_id then
    raise exception using errcode = '23514',
      message = 'Visual evidence award/source identity does not match its change event.';
  end if;

  if new.evidence_status = 'historical_artifact_unrecoverable' and (
    coalesce((new.localization ->> 'terminal_artifact_loss_confirmed')::boolean, false) is not true
    or nullif(btrim(new.localization ->> 'terminal_artifact_loss_reason'), '') is null
    or new.localization #>> '{sides,previous,status}' is distinct from 'historical_artifact_unrecoverable'
    or nullif(btrim(new.localization #>> '{sides,previous,reason}'), '') is null
    or new.localization #>> '{sides,current,status}' is distinct from 'historical_artifact_unrecoverable'
    or nullif(btrim(new.localization #>> '{sides,current,reason}'), '') is null
  ) then
    raise exception using errcode = '23514',
      message = 'Unrecoverable visual history requires explicit terminal artifact-loss confirmation.';
  end if;

  if new.visual_review_candidate_id is null then
    if new.backfilled_at is null
      or new.evidence_status <> 'historical_artifact_unrecoverable'
      or new.previous_capture <> '{}'::jsonb
      or new.current_capture <> '{}'::jsonb
      or new.bucket is not null
      or coalesce((new.localization ->> 'terminal_artifact_loss_confirmed')::boolean, false) is not true
      or nullif(btrim(new.localization ->> 'terminal_artifact_loss_reason'), '') is null
      or new.localization #>> '{sides,previous,status}' is distinct from 'historical_artifact_unrecoverable'
      or nullif(btrim(new.localization #>> '{sides,previous,reason}'), '') is null
      or new.localization #>> '{sides,current,status}' is distinct from 'historical_artifact_unrecoverable'
      or nullif(btrim(new.localization #>> '{sides,current,reason}'), '') is null then
      raise exception using errcode = '23514',
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
    raise exception using errcode = '23514',
      message = 'Visual evidence identity does not match its review candidate.';
  end if;
  if v_event.visual_review_candidate_id is distinct from new.visual_review_candidate_id then
    raise exception using errcode = '23514',
      message = 'Visual evidence candidate does not match its change event binding.';
  end if;

  if new.evidence_status = 'verified' then
    if new.evidence_schema_version <> 'visual-event-evidence-v2' then
      raise exception using errcode = '23514',
        message = 'New verified crops require visual-event-evidence-v2; v1 crops are full-screenshot fallback only.';
    end if;
    perform public.awardping_validate_exact_visual_evidence(
      new.previous_capture,
      new.current_capture,
      new.localization
    );
    v_direction := new.localization ->> 'direction';
    v_previous_required := public.awardping_visual_event_has_semantic_side(v_event.change_details, 'previous');
    v_current_required := public.awardping_visual_event_has_semantic_side(v_event.change_details, 'current');
    if (v_previous_required and v_current_required and v_direction not in ('changed', 'mixed'))
      or (v_previous_required and not v_current_required and v_direction <> 'removed')
      or (v_current_required and not v_previous_required and v_direction <> 'added')
      or (not v_previous_required and not v_current_required) then
      raise exception using errcode = '23514',
        message = 'Verified crop direction does not match the exact directional wording in the event.';
    end if;
    v_previous_localization := new.localization #> '{sides,previous}';
    v_current_localization := new.localization #> '{sides,current}';
    if v_previous_required and not public.awardping_visual_semantic_text_allowed(
      v_event.change_details,
      'previous',
      v_previous_localization #>> '{semantic_binding,wording_source}',
      v_previous_localization ->> 'exact_text'
    ) then
      raise exception using errcode = '23514',
        message = 'Previous crop wording is not an exact removed value from this event.';
    end if;
    if v_current_required and not public.awardping_visual_semantic_text_allowed(
      v_event.change_details,
      'current',
      v_current_localization #>> '{semantic_binding,wording_source}',
      v_current_localization ->> 'exact_text'
    ) then
      raise exception using errcode = '23514',
        message = 'Current crop wording is not an exact added value from this event.';
    end if;
    if new.localization ->> 'change_semantics_sha256' is distinct from
        coalesce(v_previous_localization #>> '{semantic_binding,change_semantics_sha256}',
          v_current_localization #>> '{semantic_binding,change_semantics_sha256}')
      or (v_previous_required and v_current_required and
        v_previous_localization #>> '{semantic_binding,change_semantics_sha256}' is distinct from
          v_current_localization #>> '{semantic_binding,change_semantics_sha256}') then
      raise exception using errcode = '23514',
        message = 'Required crop sides do not share the event semantic manifest hash.';
    end if;
  end if;
  return new;
exception
  when no_data_found then
    raise exception using errcode = '23503',
      message = 'Visual evidence references a missing event or candidate.';
end;
$$;

revoke all on function public.awardping_normalize_visual_exact_text(text)
  from public, anon, authenticated, service_role;
revoke all on function public.awardping_visual_json_text_values(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.awardping_visual_semantic_text_allowed(jsonb, text, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.awardping_visual_event_has_semantic_side(jsonb, text)
  from public, anon, authenticated, service_role;
revoke all on function public.awardping_validate_exact_visual_evidence_side(jsonb, jsonb, text)
  from public, anon, authenticated, service_role;
revoke all on function public.awardping_validate_exact_visual_evidence(jsonb, jsonb, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.awardping_validate_visual_evidence_insert()
  from public, anon, authenticated;
grant execute on function public.awardping_validate_visual_evidence_insert()
  to service_role;

comment on function public.awardping_validate_visual_evidence_insert() is
  'Insert-only event-evidence guard. Verified webpage crops require the v2 semantic contract and exact directional wording from the immutable event; v1 crops remain retained but are presentation fallbacks.';
