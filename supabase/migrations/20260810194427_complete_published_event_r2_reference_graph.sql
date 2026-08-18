-- Verify the complete immutable object-reference graph for every retained
-- Stage 1 published-event evidence row.  Legacy events without visual evidence
-- remain release-blocking in the canonical crop-coverage gate; they have no R2
-- object to GET and therefore are not fabricated as recovery objects here.
-- The embedded 20260810184524 compatibility aliases intentionally retain the
-- names applied to the live database; this file's version matches migration history.
-- One physical R2 object can legitimately be
-- referenced by several capture fields (for example full/main_full/state
-- image), so v4 canonicalizes by bucket/key while signing every logical
-- reference.  Suppression never removes already-published evidence from this
-- recovery set.

create or replace function private.stage1_jsonb_r2_reference_key_count(
  p_value jsonb
)
returns bigint
language sql
immutable
set search_path = ''
as $$
  with recursive walk(value) as (
    select p_value
    union all
    select child.value
    from walk
    cross join lateral (
      select object_child.value
      from pg_catalog.jsonb_each(
        case
          when pg_catalog.jsonb_typeof(walk.value) = 'object' then walk.value
          else '{}'::jsonb
        end
      ) object_child
      union all
      select array_child.value
      from pg_catalog.jsonb_array_elements(
        case
          when pg_catalog.jsonb_typeof(walk.value) = 'array' then walk.value
          else '[]'::jsonb
        end
      ) array_child
    ) child
  )
  select pg_catalog.count(*)
  from walk
  cross join lateral pg_catalog.jsonb_each(
    case
      when pg_catalog.jsonb_typeof(walk.value) = 'object' then walk.value
      else '{}'::jsonb
    end
  ) entry
  where entry.key = 'object_key'
    or pg_catalog.right(entry.key, 11) = '_object_key';
$$;

revoke all on function private.stage1_jsonb_r2_reference_key_count(jsonb)
  from public, anon, authenticated, service_role;

create or replace function private.stage1_published_capture_reference_graph_valid(
  p_capture jsonb
)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_role text;
  v_value jsonb;
  v_state jsonb;
  v_selected_state jsonb;
  v_main_state jsonb;
  v_state_count bigint := 0;
  v_unique_state_count bigint := 0;
  v_main_state_count bigint := 0;
begin
  if pg_catalog.jsonb_typeof(p_capture) is distinct from 'object' then
    return false;
  end if;

  foreach v_role in array array[
    'full', 'metadata', 'crop', 'main_full', 'thumbnail', 'text', 'layout',
    'attestation'
  ] loop
    v_value := p_capture -> v_role;
    if v_value is not null
      and pg_catalog.jsonb_typeof(v_value) not in ('object', 'null') then
      return false;
    end if;
  end loop;

  if p_capture ? 'states'
    and pg_catalog.jsonb_typeof(p_capture -> 'states') not in ('array', 'null') then
    return false;
  end if;

  if p_capture ->> 'kind' = 'webpage' then
    if pg_catalog.jsonb_typeof(p_capture -> 'full') is distinct from 'object'
      or p_capture #>> array['full', 'content_type'] is distinct from 'image/jpeg'
      or pg_catalog.jsonb_typeof(p_capture -> 'metadata') is distinct from 'object'
      or pg_catalog.jsonb_typeof(p_capture -> 'main_full') is distinct from 'object'
      or pg_catalog.jsonb_typeof(p_capture -> 'thumbnail') is distinct from 'object'
      or pg_catalog.jsonb_typeof(p_capture -> 'text') is distinct from 'object'
      or pg_catalog.jsonb_typeof(p_capture -> 'layout') is distinct from 'object'
      or pg_catalog.jsonb_typeof(p_capture -> 'attestation') = 'object'
      or pg_catalog.jsonb_typeof(p_capture -> 'states') is distinct from 'array' then
      return false;
    end if;
    if pg_catalog.jsonb_array_length(p_capture -> 'states') < 1 then
      return false;
    end if;
  elsif p_capture ->> 'kind' = 'pdf' then
    if pg_catalog.jsonb_typeof(p_capture -> 'full') is distinct from 'object'
      or p_capture #>> array['full', 'content_type'] is distinct from 'application/pdf'
      or pg_catalog.jsonb_typeof(p_capture -> 'metadata') is distinct from 'object'
      or pg_catalog.jsonb_typeof(p_capture -> 'text') is distinct from 'object'
      or pg_catalog.jsonb_typeof(p_capture -> 'layout') = 'object'
      or pg_catalog.jsonb_typeof(p_capture -> 'main_full') = 'object'
      or pg_catalog.jsonb_typeof(p_capture -> 'crop') = 'object'
      or pg_catalog.jsonb_typeof(p_capture -> 'attestation') = 'object' then
      return false;
    end if;
    if pg_catalog.jsonb_typeof(p_capture -> 'states') = 'array'
      and pg_catalog.jsonb_array_length(p_capture -> 'states') > 0 then
      return false;
    end if;
  elsif p_capture ->> 'kind' = 'first_observation_attestation' then
    if pg_catalog.jsonb_typeof(p_capture -> 'metadata') is distinct from 'object'
      or pg_catalog.jsonb_typeof(p_capture -> 'attestation') is distinct from 'object'
      or pg_catalog.jsonb_typeof(p_capture -> 'full') = 'object'
      or pg_catalog.jsonb_typeof(p_capture -> 'text') = 'object'
      or pg_catalog.jsonb_typeof(p_capture -> 'thumbnail') = 'object'
      or pg_catalog.jsonb_typeof(p_capture -> 'layout') = 'object'
      or pg_catalog.jsonb_typeof(p_capture -> 'main_full') = 'object'
      or pg_catalog.jsonb_typeof(p_capture -> 'crop') = 'object' then
      return false;
    end if;
    if pg_catalog.jsonb_typeof(p_capture -> 'states') = 'array'
      and pg_catalog.jsonb_array_length(p_capture -> 'states') > 0 then
      return false;
    end if;
  else
    return false;
  end if;

  if pg_catalog.jsonb_typeof(p_capture -> 'states') = 'array' then
    select
      pg_catalog.count(*),
      pg_catalog.count(distinct state.value ->> 'state_id'),
      pg_catalog.count(*) filter (where state.value ->> 'kind' = 'main')
    into v_state_count, v_unique_state_count, v_main_state_count
    from pg_catalog.jsonb_array_elements(p_capture -> 'states') state(value);
    if v_state_count <> v_unique_state_count then
      return false;
    end if;
    for v_state in
      select state.value
      from pg_catalog.jsonb_array_elements(p_capture -> 'states') state(value)
    loop
      if pg_catalog.jsonb_typeof(v_state) is distinct from 'object'
        or nullif(pg_catalog.btrim(v_state ->> 'state_id'), '') is null
        or v_state ->> 'state_id' !~ '^[A-Za-z0-9._-]+$'
        or v_state ->> 'kind' is null
        or v_state ->> 'kind' not in ('main', 'expansion_state') then
        return false;
      end if;
      foreach v_role in array array['image', 'geometry'] loop
        v_value := v_state -> v_role;
        if v_value is not null
          and pg_catalog.jsonb_typeof(v_value) not in ('object', 'null') then
          return false;
        end if;
      end loop;
      if p_capture ->> 'kind' = 'webpage'
        and (
          pg_catalog.jsonb_typeof(v_state -> 'image') is distinct from 'object'
          or pg_catalog.jsonb_typeof(v_state -> 'geometry') is distinct from 'object'
        ) then
        return false;
      end if;
    end loop;
  end if;

  if p_capture #>> array['full', 'content_type'] = 'image/jpeg' then
    if nullif(pg_catalog.btrim(p_capture ->> 'state_id'), '') is null
      or pg_catalog.jsonb_typeof(p_capture -> 'states') is distinct from 'array' then
      return false;
    end if;
    select state.value into v_selected_state
    from pg_catalog.jsonb_array_elements(p_capture -> 'states') state(value)
    where state.value ->> 'state_id' = p_capture ->> 'state_id'
    limit 1;
    if v_selected_state is null
      or v_selected_state #>> array['image', 'object_key'] is distinct from
        p_capture #>> array['full', 'object_key']
      or v_selected_state #>> array['image', 'sha256'] is distinct from
        p_capture #>> array['full', 'sha256']
      or v_selected_state #>> array['image', 'byte_length'] is distinct from
        p_capture #>> array['full', 'byte_length']
      or v_selected_state #>> array['image', 'content_type'] is distinct from
        p_capture #>> array['full', 'content_type']
      or v_selected_state #>> array['image', 'width'] is distinct from
        p_capture #>> array['full', 'width']
      or v_selected_state #>> array['image', 'height'] is distinct from
        p_capture #>> array['full', 'height'] then
      return false;
    end if;

    if pg_catalog.jsonb_typeof(p_capture -> 'layout') = 'object'
      or pg_catalog.jsonb_typeof(v_selected_state -> 'geometry') = 'object' then
       if pg_catalog.jsonb_typeof(p_capture -> 'layout') is distinct from 'object'
         or pg_catalog.jsonb_typeof(v_selected_state -> 'geometry') is distinct from 'object'
        or v_selected_state #>> array['geometry', 'object_key'] is distinct from
          p_capture #>> array['layout', 'object_key']
        or v_selected_state #>> array['geometry', 'sha256'] is distinct from
          p_capture #>> array['layout', 'sha256']
        or v_selected_state #>> array['geometry', 'byte_length'] is distinct from
          p_capture #>> array['layout', 'byte_length']
        or v_selected_state #>> array['geometry', 'content_type'] is distinct from
          p_capture #>> array['layout', 'content_type']
        or v_selected_state ->> 'geometry_hash' is distinct from
          p_capture #>> array['layout', 'geometry_hash'] then
        return false;
      end if;
    end if;
  elsif pg_catalog.jsonb_typeof(p_capture -> 'layout') = 'object'
    or pg_catalog.jsonb_typeof(p_capture -> 'main_full') = 'object'
    or pg_catalog.jsonb_typeof(p_capture -> 'crop') = 'object' then
    return false;
  end if;

  if pg_catalog.jsonb_typeof(p_capture -> 'main_full') = 'object' then
    if v_main_state_count <> 1 then
      return false;
    end if;
    select state.value into v_main_state
    from pg_catalog.jsonb_array_elements(p_capture -> 'states') state(value)
    where state.value ->> 'kind' = 'main'
    limit 1;
    if v_main_state #>> array['image', 'object_key'] is distinct from
        p_capture #>> array['main_full', 'object_key']
      or v_main_state #>> array['image', 'sha256'] is distinct from
        p_capture #>> array['main_full', 'sha256']
      or v_main_state #>> array['image', 'byte_length'] is distinct from
        p_capture #>> array['main_full', 'byte_length']
      or v_main_state #>> array['image', 'content_type'] is distinct from
        p_capture #>> array['main_full', 'content_type']
      or v_main_state #>> array['image', 'width'] is distinct from
        p_capture #>> array['main_full', 'width']
      or v_main_state #>> array['image', 'height'] is distinct from
        p_capture #>> array['main_full', 'height'] then
      return false;
    end if;
  end if;

  if pg_catalog.jsonb_typeof(p_capture -> 'crop') = 'object' then
    if p_capture #>> array['full', 'content_type'] is distinct from 'image/jpeg'
      or p_capture #>> array['crop', 'source_image_object_key'] is distinct from
        p_capture #>> array['full', 'object_key']
      or p_capture #>> array['crop', 'source_image_sha256'] is distinct from
        p_capture #>> array['full', 'sha256']
      or p_capture #>> array['crop', 'source_image_byte_length'] is distinct from
        p_capture #>> array['full', 'byte_length']
      or p_capture #>> array['crop', 'state_id'] is distinct from
        p_capture ->> 'state_id' then
      return false;
    end if;
  end if;
  return true;
exception when others then
  return false;
end;
$$;

revoke all on function private.stage1_published_capture_reference_graph_valid(jsonb)
  from public, anon, authenticated, service_role;

create or replace function private.stage1_published_event_r2_reference_binding_valid(
  p_source_id uuid,
  p_candidate_id uuid,
  p_side_name text,
  p_logical_role text,
  p_state_id text,
  p_state_kind text,
  p_object_key text,
  p_sha256 text,
  p_hash_mode text,
  p_byte_length text,
  p_semantic_length text,
  p_content_type text
)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_prefix text;
  v_role text;
  v_extension text;
begin
  if p_source_id is not null
    or p_candidate_id is null
    or p_side_name is null
    or p_side_name not in ('previous', 'current')
    or nullif(pg_catalog.btrim(p_logical_role), '') is null
    or nullif(pg_catalog.btrim(p_object_key), '') is null
    or nullif(pg_catalog.btrim(p_content_type), '') is null
    or coalesce(p_object_key, '') ~* '(^|/)latest(/|$)'
    or coalesce(p_sha256, '') !~ '^[0-9a-f]{64}$'
    or coalesce(p_byte_length, '') !~ '^[1-9][0-9]*$'
    or p_hash_mode is distinct from 'raw_sha256'
    or p_semantic_length is not null then
    return false;
  end if;
  v_prefix := 'visual-snapshots/published/' || p_candidate_id::text || '/' ||
    p_side_name || '/';

  case p_logical_role
    when 'full' then
      if p_content_type = 'application/pdf' then
        if p_state_id is not null or p_state_kind is not null then return false; end if;
        v_role := 'document';
        v_extension := 'pdf';
      elsif p_content_type = 'image/jpeg'
        and p_state_kind in ('main', 'expansion_state')
        and coalesce(p_state_id, '') ~ '^[A-Za-z0-9._-]+$' then
        v_role := case
          when p_state_kind = 'main' then 'main-full'
          else pg_catalog.regexp_replace(
            pg_catalog.regexp_replace(
              'state-' || p_state_id, '[^a-zA-Z0-9._-]', '-', 'g'
            ), '^-+|-+$', '', 'g'
          )
        end;
        v_extension := 'jpg';
      else return false;
      end if;
    when 'metadata' then
      if p_content_type is distinct from 'application/json; charset=utf-8'
        or p_state_id is not null
        or p_state_kind is not null then return false; end if;
      v_extension := 'json';
      if p_object_key = v_prefix || 'metadata/' || p_sha256 || '.json' then
        v_role := 'metadata';
      elsif p_object_key = v_prefix || 'recovery-metadata/' || p_sha256 || '.json' then
        v_role := 'recovery-metadata';
      elsif p_side_name = 'previous'
        and p_object_key = v_prefix || 'first-observation-attestation/' ||
          p_sha256 || '.json' then
        v_role := 'first-observation-attestation';
      else return false;
      end if;
    when 'crop' then
      if p_content_type is distinct from 'image/jpeg'
        or p_state_id is not null
        or p_state_kind is not null then return false; end if;
      v_role := 'changed-section-crop';
      v_extension := 'jpg';
    when 'main_full' then
      if p_content_type is distinct from 'image/jpeg'
        or p_state_kind is distinct from 'main'
        or coalesce(p_state_id, '') !~ '^[A-Za-z0-9._-]+$' then return false; end if;
      v_role := 'main-full';
      v_extension := 'jpg';
    when 'thumbnail' then
      if p_content_type is distinct from 'image/jpeg'
        or p_state_id is not null
        or p_state_kind is not null then return false; end if;
      v_role := 'thumbnail';
      v_extension := 'jpg';
    when 'text' then
      if p_content_type is distinct from 'text/plain; charset=utf-8'
        or p_state_id is not null
        or p_state_kind is not null then return false; end if;
      v_role := 'text';
      v_extension := 'txt';
    when 'layout', 'state.geometry' then
      if p_content_type is distinct from 'application/json; charset=utf-8'
        or p_state_kind is null
        or p_state_kind not in ('main', 'expansion_state')
        or coalesce(p_state_id, '') !~ '^[A-Za-z0-9._-]+$' then return false; end if;
      v_role := pg_catalog.regexp_replace(
        pg_catalog.regexp_replace(
          'geometry-' || p_state_id, '[^a-zA-Z0-9._-]', '-', 'g'
        ), '^-+|-+$', '', 'g'
      );
      v_extension := 'json';
    when 'state.image', 'crop.source_image' then
      if p_content_type is distinct from 'image/jpeg'
        or p_state_kind is null
        or p_state_kind not in ('main', 'expansion_state')
        or coalesce(p_state_id, '') !~ '^[A-Za-z0-9._-]+$' then return false; end if;
      v_role := case
        when p_state_kind = 'main' then 'main-full'
        else pg_catalog.regexp_replace(
          pg_catalog.regexp_replace(
            'state-' || p_state_id, '[^a-zA-Z0-9._-]', '-', 'g'
          ), '^-+|-+$', '', 'g'
        )
      end;
      v_extension := 'jpg';
    else return false;
  end case;

  if p_logical_role = 'metadata' then return true; end if;
  return coalesce(
    p_object_key = v_prefix || v_role || '/' || p_sha256 || '.' || v_extension,
    false
  );
exception when others then
  return false;
end;
$$;

revoke all on function private.stage1_published_event_r2_reference_binding_valid(
  uuid, uuid, text, text, text, text, text, text, text, text, text, text
) from public, anon, authenticated, service_role;

create or replace function private.stage1_visual_r2_object_set_snapshot()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with stage1_events as (
    select
      evidence.*,
      event.id as published_change_event_id,
      event.visual_review_candidate_id as published_candidate_id,
      event.suppressed_at is not null as event_suppressed,
      evidence.visual_review_candidate_id is distinct from
        event.visual_review_candidate_id as candidate_binding_invalid
    from public.shared_award_change_event_visual_evidence evidence
    join public.shared_award_change_events event
      on event.id = evidence.change_event_id
    -- Candidate-free historical_artifact_unrecoverable rows truthfully carry
    -- no R2 objects.  Crop coverage/quarantine retains that limitation; this
    -- manifest verifies only reference-bearing evidence.
    where evidence.visual_review_candidate_id is not null
      and exists (
      select 1
      from public.stage1_award_members member
      where member.shared_award_id = event.shared_award_id
    )
  ), event_sides as (
    select
      event.bucket,
      event.published_change_event_id as change_event_id,
      event.published_candidate_id as candidate_id,
      event.event_suppressed,
      event.candidate_binding_invalid,
      side.side_name,
      side.capture,
      side.capture ->> 'state_id' as selected_state_id,
      (
        select state.value ->> 'kind'
        from pg_catalog.jsonb_array_elements(
          case
            when pg_catalog.jsonb_typeof(side.capture -> 'states') = 'array'
              then side.capture -> 'states'
            else '[]'::jsonb
          end
        ) state(value)
        where state.value ->> 'state_id' = side.capture ->> 'state_id'
        limit 1
      ) as selected_state_kind,
      (
        select state.value ->> 'state_id'
        from pg_catalog.jsonb_array_elements(
          case
            when pg_catalog.jsonb_typeof(side.capture -> 'states') = 'array'
              then side.capture -> 'states'
            else '[]'::jsonb
          end
        ) state(value)
        where state.value ->> 'kind' = 'main'
        limit 1
      ) as main_state_id
    from stage1_events event
    cross join lateral (values
      ('previous'::text, event.previous_capture),
      ('current'::text, event.current_capture)
    ) side(side_name, capture)
  ), event_fixed_references as (
    select
      side.bucket,
      'published_event'::text as object_scope,
      null::uuid as source_id,
      side.change_event_id,
      side.candidate_id,
      side.side_name,
      reference.logical_role,
      reference.logical_path,
      reference.state_id,
      reference.state_kind,
      side.event_suppressed,
      reference.value ->> 'object_key' as object_key,
      reference.value ->> 'sha256' as sha256,
      'raw_sha256'::text as hash_mode,
      reference.value ->> 'byte_length' as byte_length,
      null::text as semantic_length,
      reference.value ->> 'content_type' as content_type,
      reference.value ->> 'width' as width,
      reference.value ->> 'height' as height,
      reference.value ->> 'geometry_hash' as geometry_hash,
      pg_catalog.jsonb_typeof(reference.value) = 'object'
        and reference.value ? 'object_key' as reference_key_present
    from event_sides side
    cross join lateral (values
      ('full'::text, '$.full.object_key'::text, side.capture -> 'full',
        case
          when side.capture #>> array['full', 'content_type'] = 'application/pdf'
            then null::text
          else side.selected_state_id
        end,
        case
          when side.capture #>> array['full', 'content_type'] = 'application/pdf'
            then null::text
          else side.selected_state_kind
        end),
      ('metadata'::text, '$.metadata.object_key'::text,
        side.capture -> 'metadata', null::text, null::text),
      ('crop'::text, '$.crop.object_key'::text, side.capture -> 'crop',
        null::text, null::text),
      ('main_full'::text, '$.main_full.object_key'::text,
        side.capture -> 'main_full', side.main_state_id, 'main'::text),
      ('thumbnail'::text, '$.thumbnail.object_key'::text,
        side.capture -> 'thumbnail', null::text, null::text),
      ('text'::text, '$.text.object_key'::text, side.capture -> 'text',
        null::text, null::text),
      ('layout'::text, '$.layout.object_key'::text, side.capture -> 'layout',
        side.selected_state_id, side.selected_state_kind)
    ) reference(logical_role, logical_path, value, state_id, state_kind)
    where reference.value is not null
      and pg_catalog.jsonb_typeof(reference.value) is distinct from 'null'
  ), event_state_references as (
    select
      side.bucket,
      'published_event'::text as object_scope,
      null::uuid as source_id,
      side.change_event_id,
      side.candidate_id,
      side.side_name,
      reference.logical_role,
      pg_catalog.format(
        '$.states[%s].%s.object_key', state.ordinality - 1, reference.slot_name
      ) as logical_path,
      state.value ->> 'state_id' as state_id,
      state.value ->> 'kind' as state_kind,
      side.event_suppressed,
      reference.value ->> 'object_key' as object_key,
      reference.value ->> 'sha256' as sha256,
      'raw_sha256'::text as hash_mode,
      reference.value ->> 'byte_length' as byte_length,
      null::text as semantic_length,
      reference.value ->> 'content_type' as content_type,
      reference.value ->> 'width' as width,
      reference.value ->> 'height' as height,
      case
        when reference.slot_name = 'geometry' then state.value ->> 'geometry_hash'
        else null
      end as geometry_hash,
      pg_catalog.jsonb_typeof(reference.value) = 'object'
        and reference.value ? 'object_key' as reference_key_present
    from event_sides side
    cross join lateral pg_catalog.jsonb_array_elements(
      case
        when pg_catalog.jsonb_typeof(side.capture -> 'states') = 'array'
          then side.capture -> 'states'
        else '[]'::jsonb
      end
    ) with ordinality state(value, ordinality)
    cross join lateral (values
      ('state.image'::text, 'image'::text, state.value -> 'image'),
      ('state.geometry'::text, 'geometry'::text, state.value -> 'geometry')
    ) reference(logical_role, slot_name, value)
    where reference.value is not null
      and pg_catalog.jsonb_typeof(reference.value) is distinct from 'null'
  ), event_crop_source_references as (
    select
      side.bucket,
      'published_event'::text as object_scope,
      null::uuid as source_id,
      side.change_event_id,
      side.candidate_id,
      side.side_name,
      'crop.source_image'::text as logical_role,
      '$.crop.source_image_object_key'::text as logical_path,
      side.selected_state_id as state_id,
      side.selected_state_kind as state_kind,
      side.event_suppressed,
      side.capture #>> array['crop', 'source_image_object_key'] as object_key,
      side.capture #>> array['crop', 'source_image_sha256'] as sha256,
      'raw_sha256'::text as hash_mode,
      side.capture #>> array['crop', 'source_image_byte_length'] as byte_length,
      null::text as semantic_length,
      'image/jpeg'::text as content_type,
      null::text as width,
      null::text as height,
      null::text as geometry_hash,
      side.capture -> 'crop' ? 'source_image_object_key' as reference_key_present
    from event_sides side
    where pg_catalog.jsonb_typeof(side.capture -> 'crop') = 'object'
      and side.capture -> 'crop' ?| array[
        'source_image_object_key', 'source_image_sha256',
        'source_image_byte_length'
      ]
  ), event_reference_rows as (
    select * from event_fixed_references
    union all
    select * from event_state_references
    union all
    select * from event_crop_source_references
  ), event_side_quality as (
    select
      pg_catalog.count(*) filter (
        where side.candidate_binding_invalid
      ) as candidate_binding_error_count,
      pg_catalog.count(*) filter (
        where private.stage1_published_capture_reference_graph_valid(
          side.capture
        ) is not true
      ) as capture_alias_error_count,
      coalesce(pg_catalog.sum(
        private.stage1_jsonb_r2_reference_key_count(side.capture)
      ), 0) as recursive_reference_key_count
    from event_sides side
  ), event_reference_quality as (
    select
      pg_catalog.count(*) as logical_reference_count,
      pg_catalog.count(*) filter (where reference.event_suppressed)
        as suppressed_reference_count,
      pg_catalog.count(*) filter (where not reference.event_suppressed)
        as unsuppressed_reference_count,
      pg_catalog.count(*) filter (where reference.reference_key_present)
        as classified_reference_key_count,
      pg_catalog.count(*) filter (
        where private.stage1_published_event_r2_reference_binding_valid(
          reference.source_id,
          reference.candidate_id,
          reference.side_name,
          reference.logical_role,
          reference.state_id,
          reference.state_kind,
          reference.object_key,
          reference.sha256,
          reference.hash_mode,
          reference.byte_length,
          reference.semantic_length,
          reference.content_type
        ) is not true
      ) as reference_binding_error_count
    from event_reference_rows reference
  ), state_role_collisions as (
    select
      reference.candidate_id,
      reference.side_name,
      reference.logical_role,
      pg_catalog.split_part(reference.object_key, '/', 5) as storage_role
    from event_reference_rows reference
    where reference.logical_role in ('state.image', 'state.geometry')
      and nullif(pg_catalog.btrim(reference.object_key), '') is not null
    group by
      reference.candidate_id,
      reference.side_name,
      reference.logical_role,
      pg_catalog.split_part(reference.object_key, '/', 5)
    having pg_catalog.count(distinct reference.state_id) > 1
  ), state_role_quality as (
    select pg_catalog.count(*) as collision_count
    from state_role_collisions
  ), event_physical_groups as (
    select
      reference.bucket,
      reference.object_key,
      pg_catalog.min(reference.candidate_id::text)::uuid as candidate_id,
      pg_catalog.min(reference.side_name) as side_name,
      pg_catalog.split_part(reference.object_key, '/', 5) as artifact_name,
      pg_catalog.min(reference.sha256) as sha256,
      pg_catalog.min(reference.hash_mode) as hash_mode,
      pg_catalog.min(reference.byte_length) as byte_length,
      pg_catalog.min(reference.semantic_length) as semantic_length,
      pg_catalog.min(reference.content_type) as content_type,
      pg_catalog.count(*) as reference_count,
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'scope', reference.object_scope,
          'change_event_id', reference.change_event_id,
          'source_id', reference.source_id,
          'candidate_id', reference.candidate_id,
          'side', reference.side_name,
          'role', reference.logical_role,
          'logical_path', reference.logical_path,
          'state_id', reference.state_id,
          'state_kind', reference.state_kind,
          'suppressed', reference.event_suppressed
        ) order by
          reference.change_event_id,
          reference.side_name,
          reference.logical_path,
          reference.logical_role,
          reference.state_id
      ) as references,
      (
        pg_catalog.count(distinct reference.candidate_id) <> 1
        or pg_catalog.count(distinct reference.side_name) <> 1
        or pg_catalog.count(distinct reference.sha256) <> 1
        or pg_catalog.count(distinct reference.hash_mode) <> 1
        or pg_catalog.count(distinct reference.byte_length) <> 1
        or pg_catalog.count(distinct reference.semantic_length) filter (
          where reference.semantic_length is not null
        ) > 1
        or pg_catalog.count(distinct reference.content_type) <> 1
        or pg_catalog.count(distinct reference.width) filter (
          where reference.width is not null
        ) > 1
        or pg_catalog.count(distinct reference.height) filter (
          where reference.height is not null
        ) > 1
        or pg_catalog.count(distinct reference.geometry_hash) filter (
          where reference.geometry_hash is not null
        ) > 1
      ) as descriptor_conflict
    from event_reference_rows reference
    where nullif(pg_catalog.btrim(reference.object_key), '') is not null
    group by reference.bucket, reference.object_key
  ), event_alias_quality as (
    select
      pg_catalog.count(*) filter (where physical.descriptor_conflict)
        as inconsistent_alias_count,
      pg_catalog.count(*) filter (where physical.reference_count > 1)
        as aliased_object_count
    from event_physical_groups physical
  ), event_object_rows as (
    select
      physical.bucket,
      'published_event'::text as object_scope,
      null::uuid as source_id,
      physical.candidate_id,
      physical.side_name,
      physical.artifact_name,
      physical.object_key,
      physical.sha256,
      physical.hash_mode,
      physical.byte_length,
      physical.semantic_length,
      physical.content_type,
      physical.reference_count,
      physical.references
    from event_physical_groups physical
  ), manifest_bindings as (
    select distinct
      manifest.cohort_key,
      source_id,
      source.id is not null
        and exists (
          select 1
          from public.stage1_award_members member
          where member.cohort_key = manifest.cohort_key
            and member.shared_award_id = source.shared_award_id
        )
        and snapshot.shared_award_source_id is not null
        and snapshot.shared_award_id = source.shared_award_id
        and snapshot.source_url = source.url
        and manifest.evidence #>> array[
          'source_bindings', source_id::text, 'source_url'
        ] = source.url
        and private.stage1_safe_timestamptz(
          manifest.evidence #>> array[
            'source_bindings', source_id::text, 'captured_at'
          ]
        ) = snapshot.latest_captured_at
        and manifest.evidence #> array[
          'source_bindings', source_id::text, 'object_keys'
        ] = snapshot.latest_object_keys
        and manifest.evidence #> array[
          'source_bindings', source_id::text, 'hashes'
        ] = snapshot.latest_hashes
        and manifest.evidence #> array[
          'source_bindings', source_id::text, 'metadata'
        ] = snapshot.latest_metadata
        and manifest.evidence #> array[
          'source_bindings', source_id::text, 'r2_hashes'
        ] = snapshot.latest_hashes
        and private.stage1_manifest_source_capture_binding_valid(
          source_id,
          snapshot.kind,
          snapshot.latest_object_keys,
          snapshot.latest_hashes,
          snapshot.latest_metadata
        ) as binding_valid,
      snapshot.bucket,
      snapshot.kind,
      snapshot.latest_object_keys as object_keys,
      snapshot.latest_metadata as metadata
    from public.stage1_award_source_manifest manifest
    cross join pg_catalog.unnest(manifest.source_ids) source_id
    left join public.shared_award_sources source
      on source.id = source_id
    left join public.shared_award_source_visual_snapshots snapshot
      on snapshot.shared_award_source_id = source_id
  ), manifest_binding_quality as (
    select pg_catalog.count(*) filter (where binding_valid is not true)
      as error_count
    from manifest_bindings
  ), manifest_sources as (
    select distinct source_id, bucket, kind, object_keys, metadata
    from manifest_bindings
    where binding_valid
  ), manifest_object_rows as (
    select
      source.bucket,
      'manifest_source'::text as object_scope,
      source.source_id,
      null::uuid as candidate_id,
      'current'::text as side_name,
      artifact.artifact_name,
      artifact.object_key,
      source.metadata #>> array[
        'artifact_bindings', artifact.artifact_name, 'sha256'
      ] as sha256,
      source.metadata #>> array[
        'artifact_bindings', artifact.artifact_name, 'hash_mode'
      ] as hash_mode,
      source.metadata #>> array[
        'artifact_bindings', artifact.artifact_name, 'byte_length'
      ] as byte_length,
      null::text as semantic_length,
      source.metadata #>> array[
        'artifact_bindings', artifact.artifact_name, 'content_type'
      ] as content_type,
      1::bigint as reference_count,
      pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'scope', 'manifest_source',
        'change_event_id', null,
        'source_id', source.source_id,
        'candidate_id', null,
        'side', 'current',
        'role', artifact.artifact_name,
        'logical_path', '$.object_keys.' || artifact.artifact_name,
        'state_id', null,
        'state_kind', null,
        'suppressed', null
      )) as references
    from manifest_sources source
    cross join lateral pg_catalog.jsonb_each_text(source.object_keys)
      artifact(artifact_name, object_key)
  ), object_rows as (
    select * from event_object_rows
    union all
    select * from manifest_object_rows
  ), duplicate_object_keys as (
    select object_row.bucket, object_row.object_key
    from object_rows object_row
    where nullif(pg_catalog.btrim(object_row.object_key), '') is not null
    group by object_row.bucket, object_row.object_key
    having pg_catalog.count(*) > 1
  ), object_key_quality as (
    select pg_catalog.count(*) as duplicate_object_key_count
    from duplicate_object_keys
  ), object_payload as (
    select coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'bucket', object_row.bucket,
          'scope', object_row.object_scope,
          'source_id', object_row.source_id,
          'candidate_id', object_row.candidate_id,
          'side', object_row.side_name,
          'storage_role', object_row.artifact_name,
          'object_key', object_row.object_key,
          'sha256', object_row.sha256,
          'hash_mode', object_row.hash_mode,
          'byte_length', object_row.byte_length,
          'semantic_length', object_row.semantic_length,
          'content_type', object_row.content_type,
          'reference_count', object_row.reference_count,
          'references', object_row.references
        ) order by
          object_row.object_scope,
          object_row.bucket,
          object_row.source_id,
          object_row.candidate_id,
          object_row.object_key
      ),
      '[]'::jsonb
    ) as value
    from object_rows object_row
  ), reference_payload as (
    select coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'bucket', object_row.bucket,
          'object_key', object_row.object_key,
          'reference', reference.value
        ) order by
          object_row.object_scope,
          object_row.bucket,
          object_row.source_id,
          object_row.candidate_id,
          object_row.object_key,
          reference.ordinality
      ),
      '[]'::jsonb
    ) as value
    from object_rows object_row
    cross join lateral pg_catalog.jsonb_array_elements(object_row.references)
      with ordinality reference(value, ordinality)
  ), object_quality as (
    select
      pg_catalog.count(*) filter (
        where object_row.bucket is distinct from (
          private.stage1_release_production_target_snapshot() ->> 'r2_bucket'
        )
      ) as unexpected_bucket_count,
      pg_catalog.count(*) filter (
        where object_row.object_key is null
          or coalesce(object_row.sha256, '') !~ '^[0-9a-f]{64}$'
          or coalesce(object_row.byte_length, '') !~ '^[1-9][0-9]*$'
          or object_row.reference_count < 1
          or pg_catalog.jsonb_typeof(object_row.references) <> 'array'
          or pg_catalog.jsonb_array_length(object_row.references) < 1
          or case object_row.object_scope
            when 'published_event' then
              object_row.source_id is not null
              or object_row.candidate_id is null
              or object_row.hash_mode is distinct from 'raw_sha256'
              or object_row.semantic_length is not null
            when 'manifest_source' then
              object_row.source_id is null
              or object_row.candidate_id is not null
              or object_row.object_key !~ (
                '^visual-snapshots/sources/' || object_row.source_id::text ||
                '/captures/[0-9a-f]{32}/[^/]+$'
              )
              or object_row.object_key ~* '(^|/)(latest|previous)(/|$)'
              or object_row.hash_mode is distinct from 'raw_sha256'
              or object_row.semantic_length is not null
              or case
                when object_row.artifact_name = 'page' then
                  object_row.object_key !~ '/page[.]jpg$'
                  or object_row.content_type <> 'image/jpeg'
                when object_row.artifact_name = 'thumb' then
                  object_row.object_key !~ '/thumb[.]jpg$'
                  or object_row.content_type <> 'image/jpeg'
                when object_row.artifact_name = 'pdf' then
                  object_row.object_key !~ '/document[.]pdf$'
                  or object_row.content_type <> 'application/pdf'
                when object_row.artifact_name = 'text' then
                  object_row.object_key !~ '/text[.]txt$'
                  or object_row.content_type <> 'text/plain; charset=utf-8'
                when object_row.artifact_name = 'layout' then
                  object_row.object_key !~ '/layout[.]json$'
                  or object_row.content_type <>
                    'application/json; charset=utf-8'
                when object_row.artifact_name = 'meta' then
                  object_row.object_key !~ '/meta[.]json$'
                  or object_row.content_type <>
                    'application/json; charset=utf-8'
                when object_row.artifact_name ~
                  '^expansion_state_[0-9]{2}$' then
                  object_row.object_key !~
                    '/expansion-state-[0-9]{2}[.]jpg$'
                  or object_row.content_type <> 'image/jpeg'
                when object_row.artifact_name ~
                  '^expansion_state_[0-9]{2}_layout$' then
                  object_row.object_key !~
                    '/expansion-state-[0-9]{2}-layout[.]json$'
                  or object_row.content_type <>
                    'application/json; charset=utf-8'
                else true
              end
            else true
          end
      ) as base_malformed_object_count,
      pg_catalog.count(*) filter (
        where object_row.object_scope = 'published_event'
      ) as published_event_object_count,
      pg_catalog.count(*) filter (
        where object_row.object_scope = 'manifest_source'
      ) as manifest_source_object_count
    from object_rows object_row
  ), aggregate_quality as (
    select
      event_reference_quality.reference_binding_error_count,
      event_alias_quality.inconsistent_alias_count +
        event_side_quality.capture_alias_error_count +
        state_role_quality.collision_count as inconsistent_alias_count,
      greatest(
        event_side_quality.recursive_reference_key_count -
          event_reference_quality.classified_reference_key_count,
        0
      ) as unrecognized_reference_count,
      event_reference_quality.logical_reference_count,
      event_reference_quality.suppressed_reference_count,
      event_reference_quality.unsuppressed_reference_count,
      event_alias_quality.aliased_object_count,
      event_side_quality.candidate_binding_error_count
    from event_reference_quality
    cross join event_alias_quality
    cross join event_side_quality
    cross join state_role_quality
  )
  select pg_catalog.jsonb_build_object(
    'visual_object_count', pg_catalog.jsonb_array_length(object_payload.value),
    'visual_reference_count',
      aggregate_quality.logical_reference_count +
      object_quality.manifest_source_object_count,
    'published_event_object_count', object_quality.published_event_object_count,
    'published_event_reference_count', aggregate_quality.logical_reference_count,
    'suppressed_published_event_reference_count',
      aggregate_quality.suppressed_reference_count,
    'unsuppressed_published_event_reference_count',
      aggregate_quality.unsuppressed_reference_count,
    'alias_reference_count',
      aggregate_quality.logical_reference_count -
      object_quality.published_event_object_count,
    'aliased_object_count', aggregate_quality.aliased_object_count,
    'manifest_source_object_count', object_quality.manifest_source_object_count,
    'manifest_source_reference_count', object_quality.manifest_source_object_count,
    'duplicate_object_key_count', object_key_quality.duplicate_object_key_count,
    'reference_binding_error_count',
      aggregate_quality.reference_binding_error_count,
    'inconsistent_alias_count', aggregate_quality.inconsistent_alias_count,
    'unclassified_reference_count', aggregate_quality.unrecognized_reference_count,
    'reference_set_hash', public.stage1_publication_evidence_hash(
      reference_payload.value
    ),
    'visual_object_set_hash', public.stage1_publication_evidence_hash(
      object_payload.value
    ),
    'unexpected_bucket_count', object_quality.unexpected_bucket_count,
    'malformed_object_count',
      object_quality.base_malformed_object_count +
      manifest_binding_quality.error_count +
      object_key_quality.duplicate_object_key_count +
      aggregate_quality.reference_binding_error_count +
      aggregate_quality.inconsistent_alias_count +
      aggregate_quality.unrecognized_reference_count +
      aggregate_quality.candidate_binding_error_count,
    'manifest_binding_error_count', manifest_binding_quality.error_count,
    'objects', object_payload.value
  )
  from object_payload
  cross join reference_payload
  cross join object_quality
  cross join manifest_binding_quality
  cross join object_key_quality
  cross join aggregate_quality;
$$;

revoke all on function private.stage1_visual_r2_object_set_snapshot()
  from public, anon, authenticated, service_role;

create or replace function public.get_stage1_release_r2_verification_manifest()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_target jsonb := private.stage1_release_production_target_snapshot();
  v_manifest jsonb := private.stage1_visual_r2_object_set_snapshot();
begin
  if v_target ->> 'configured' <> 'true' then
    raise exception using errcode = '55000',
      message = 'The administrator-owned production target is not configured.';
  end if;
  return pg_catalog.jsonb_build_object(
    'schema_version', 'awardping.stage1.r2-verification-manifest.v4',
    'artifact_bindings_schema',
      'awardping.r2.capture-artifact-bindings.v1',
    'reference_schema', 'awardping.r2.canonical-object-references.v1',
    'target', v_target,
    'visual_object_count', v_manifest -> 'visual_object_count',
    'visual_reference_count', v_manifest -> 'visual_reference_count',
    'published_event_object_count',
      v_manifest -> 'published_event_object_count',
    'published_event_reference_count',
      v_manifest -> 'published_event_reference_count',
    'suppressed_published_event_reference_count',
      v_manifest -> 'suppressed_published_event_reference_count',
    'unsuppressed_published_event_reference_count',
      v_manifest -> 'unsuppressed_published_event_reference_count',
    'alias_reference_count', v_manifest -> 'alias_reference_count',
    'aliased_object_count', v_manifest -> 'aliased_object_count',
    'manifest_source_object_count',
      v_manifest -> 'manifest_source_object_count',
    'manifest_source_reference_count',
      v_manifest -> 'manifest_source_reference_count',
    'duplicate_object_key_count',
      v_manifest -> 'duplicate_object_key_count',
    'reference_binding_error_count',
      v_manifest -> 'reference_binding_error_count',
    'inconsistent_alias_count', v_manifest -> 'inconsistent_alias_count',
    'unclassified_reference_count',
      v_manifest -> 'unclassified_reference_count',
    'reference_set_hash', v_manifest -> 'reference_set_hash',
    'visual_object_set_hash', v_manifest -> 'visual_object_set_hash',
    'unexpected_bucket_count', v_manifest -> 'unexpected_bucket_count',
    'malformed_object_count', v_manifest -> 'malformed_object_count',
    'manifest_binding_error_count',
      v_manifest -> 'manifest_binding_error_count',
    'objects', v_manifest -> 'objects'
  );
end;
$$;

revoke all on function public.get_stage1_release_r2_verification_manifest()
  from public, anon, authenticated, service_role;
grant execute on function public.get_stage1_release_r2_verification_manifest()
  to service_role;

comment on function public.get_stage1_release_r2_verification_manifest() is
  'Service-role-only v4 manifest of every distinct Stage 1 visual R2 object and every immutable published-event reference, including retained suppressed updates.';

create or replace function private.stage1_r2_recovery_evidence_matches_snapshot(
  p_evidence jsonb,
  p_snapshot jsonb
)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_count_text text;
  v_visual_objects bigint;
  v_visual_references bigint;
  v_published_objects bigint;
  v_published_references bigint;
  v_source_objects bigint;
  v_source_references bigint;
  v_alias_references bigint;
  v_aliased_objects bigint;
begin
  if pg_catalog.jsonb_typeof(p_evidence) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_snapshot) is distinct from 'object'
    or p_evidence ->> 'schema_version' is distinct from
      'awardping.stage1.r2-recovery-drill.v1'
    or p_evidence ->> 'reference_schema' is distinct from
      'awardping.r2.canonical-object-references.v1'
    or p_evidence ->> 'measurement_method' is distinct from
      'r2_full_get_sha256_v1'
    or p_evidence ->> 'hash_mode_contract' is distinct from
      'db_manifest_declared_hash_modes_v1'
    or p_evidence ->> 'hash_verified' is distinct from 'true'
    or p_evidence ->> 'failed_objects' is distinct from '0'
    or p_evidence ->> 'refused_objects' is distinct from '0'
    or p_evidence ->> 'failure_count' is distinct from '0'
    or p_evidence ->> 'failure_set_hash' is distinct from
      '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945'
    or coalesce(p_evidence ->> 'visual_object_set_hash', '') !~
      '^[0-9a-f]{64}$'
    or coalesce(p_evidence ->> 'reference_set_hash', '') !~
      '^[0-9a-f]{64}$'
    or coalesce(p_snapshot ->> 'visual_object_set_hash', '') !~
      '^[0-9a-f]{64}$'
    or coalesce(p_snapshot ->> 'reference_set_hash', '') !~
      '^[0-9a-f]{64}$'
    or p_snapshot ->> 'unexpected_bucket_count' is distinct from '0'
    or p_snapshot ->> 'malformed_object_count' is distinct from '0'
    or p_snapshot ->> 'manifest_binding_error_count' is distinct from '0'
    or p_snapshot ->> 'duplicate_object_key_count' is distinct from '0'
    or p_snapshot ->> 'reference_binding_error_count' is distinct from '0'
    or p_snapshot ->> 'inconsistent_alias_count' is distinct from '0'
    or p_snapshot ->> 'unclassified_reference_count' is distinct from '0' then
    return false;
  end if;

  foreach v_count_text in array array[
    p_snapshot ->> 'visual_object_count',
    p_snapshot ->> 'visual_reference_count',
    p_snapshot ->> 'published_event_object_count',
    p_snapshot ->> 'published_event_reference_count',
    p_snapshot ->> 'manifest_source_object_count',
    p_snapshot ->> 'manifest_source_reference_count',
    p_snapshot ->> 'alias_reference_count',
    p_snapshot ->> 'aliased_object_count',
    p_evidence ->> 'recovered_objects',
    p_evidence ->> 'visual_objects_checked',
    p_evidence ->> 'visual_references_checked',
    p_evidence ->> 'published_event_objects_checked',
    p_evidence ->> 'published_event_references_checked',
    p_evidence ->> 'manifest_source_objects_checked',
    p_evidence ->> 'manifest_source_references_checked',
    p_evidence ->> 'alias_references_checked',
    p_evidence ->> 'aliased_objects_checked'
  ] loop
    if coalesce(v_count_text, '') !~ '^[0-9]+$' then return false; end if;
  end loop;

  v_visual_objects := (p_snapshot ->> 'visual_object_count')::bigint;
  v_visual_references := (p_snapshot ->> 'visual_reference_count')::bigint;
  v_published_objects := (p_snapshot ->> 'published_event_object_count')::bigint;
  v_published_references :=
    (p_snapshot ->> 'published_event_reference_count')::bigint;
  v_source_objects := (p_snapshot ->> 'manifest_source_object_count')::bigint;
  v_source_references :=
    (p_snapshot ->> 'manifest_source_reference_count')::bigint;
  v_alias_references := (p_snapshot ->> 'alias_reference_count')::bigint;
  v_aliased_objects := (p_snapshot ->> 'aliased_object_count')::bigint;

  return v_visual_objects > 0
    and v_visual_objects = v_published_objects + v_source_objects
    and v_visual_references = v_published_references + v_source_references
    and v_alias_references = v_visual_references - v_visual_objects
    and v_alias_references >= 0
    and v_aliased_objects >= 0
    and p_evidence ->> 'visual_object_set_hash' =
      p_snapshot ->> 'visual_object_set_hash'
    and p_evidence ->> 'reference_set_hash' =
      p_snapshot ->> 'reference_set_hash'
    and p_evidence ->> 'recovered_objects' = v_visual_objects::text
    and p_evidence ->> 'visual_objects_checked' = v_visual_objects::text
    and p_evidence ->> 'visual_references_checked' = v_visual_references::text
    and p_evidence ->> 'published_event_objects_checked' =
      v_published_objects::text
    and p_evidence ->> 'published_event_references_checked' =
      v_published_references::text
    and p_evidence ->> 'manifest_source_objects_checked' =
      v_source_objects::text
    and p_evidence ->> 'manifest_source_references_checked' =
      v_source_references::text
    and p_evidence ->> 'alias_references_checked' = v_alias_references::text
    and p_evidence ->> 'aliased_objects_checked' = v_aliased_objects::text;
exception when others then
  return false;
end;
$$;

revoke all on function private.stage1_r2_recovery_evidence_matches_snapshot(
  jsonb, jsonb
) from public, anon, authenticated, service_role;

alter function private.stage1_visual_crop_coverage_snapshot()
  rename to stage1_crop_coverage_pre_r2_graph_20260810184524;

revoke all on function private.stage1_crop_coverage_pre_r2_graph_20260810184524()
  from public, anon, authenticated, service_role;

create or replace function private.stage1_visual_crop_coverage_snapshot()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with coverage as (
    select private.stage1_crop_coverage_pre_r2_graph_20260810184524() as value
  ), objects as (
    select private.stage1_visual_r2_object_set_snapshot() as value
  )
  select coverage.value || pg_catalog.jsonb_build_object(
    'reference_schema', 'awardping.r2.canonical-object-references.v1',
    'visual_object_count', objects.value -> 'visual_object_count',
    'visual_reference_count', objects.value -> 'visual_reference_count',
    'published_event_object_count',
      objects.value -> 'published_event_object_count',
    'published_event_reference_count',
      objects.value -> 'published_event_reference_count',
    'manifest_source_object_count',
      objects.value -> 'manifest_source_object_count',
    'manifest_source_reference_count',
      objects.value -> 'manifest_source_reference_count',
    'alias_reference_count', objects.value -> 'alias_reference_count',
    'aliased_object_count', objects.value -> 'aliased_object_count',
    'reference_set_hash', objects.value -> 'reference_set_hash',
    'visual_object_set_hash', objects.value -> 'visual_object_set_hash'
  )
  from coverage
  cross join objects;
$$;

revoke all on function private.stage1_visual_crop_coverage_snapshot()
  from public, anon, authenticated, service_role;

create or replace function private.stage1_visual_crop_derivation_contract_hash()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select public.stage1_publication_evidence_hash(
    pg_catalog.jsonb_build_object(
      'contract', 'awardping.stage1.visual-crop-db-derivation.v3',
      'event_scope', 'unsuppressed_stage1_change_events',
      'html_requirement', 'visual-event-evidence-v2-exact-text-overlap',
      'pdf_requirement', 'candidate-bound-not-applicable-pdf',
      'object_requirement',
        'current-signed-r2-canonical-object-reference-graph-v4'
    )
  );
$$;

revoke all on function private.stage1_visual_crop_derivation_contract_hash()
  from public, anon, authenticated, service_role;

-- Preserve the already-hardened hosted/Auth/Vault and other artifact checks
-- exactly, then layer the v4 R2/reference requirements onto the canonical
-- validator.  The prior function was amended by the Vault migration, so
-- cloning its live definition avoids regressing that independent contract.
do $$
declare
  v_definition text;
  v_old_name text :=
    'FUNCTION private.stage1_release_artifact_evidence_valid(';
  v_new_name text :=
    'FUNCTION private.stage1_release_artifact_valid_pre_r2_graph_20260810184524(';
begin
  select pg_catalog.pg_get_functiondef(
    pg_catalog.to_regprocedure(
      'private.stage1_release_artifact_evidence_valid(text,jsonb)'
    )
  ) into v_definition;
  if v_definition is null
    or pg_catalog.strpos(v_definition, v_old_name) = 0 then
    raise exception using errcode = '55000',
      message = 'The current release-artifact validator could not be preserved.';
  end if;
  execute pg_catalog.replace(v_definition, v_old_name, v_new_name);
end;
$$;

revoke all on function
  private.stage1_release_artifact_valid_pre_r2_graph_20260810184524(
    text, jsonb
  ) from public, anon, authenticated, service_role;

create or replace function private.stage1_release_artifact_evidence_valid(
  p_artifact_kind text,
  p_evidence jsonb
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select private.stage1_release_artifact_valid_pre_r2_graph_20260810184524(
    p_artifact_kind, p_evidence
  )
  and case p_artifact_kind
    when 'r2_recovery_drill' then
      private.stage1_r2_recovery_evidence_matches_snapshot(
        p_evidence,
        pg_catalog.jsonb_build_object(
          'visual_object_count', p_evidence -> 'visual_objects_checked',
          'visual_reference_count', p_evidence -> 'visual_references_checked',
          'published_event_object_count',
            p_evidence -> 'published_event_objects_checked',
          'published_event_reference_count',
            p_evidence -> 'published_event_references_checked',
          'manifest_source_object_count',
            p_evidence -> 'manifest_source_objects_checked',
          'manifest_source_reference_count',
            p_evidence -> 'manifest_source_references_checked',
          'alias_reference_count', p_evidence -> 'alias_references_checked',
          'aliased_object_count', p_evidence -> 'aliased_objects_checked',
          'visual_object_set_hash', p_evidence -> 'visual_object_set_hash',
          'reference_set_hash', p_evidence -> 'reference_set_hash',
          'unexpected_bucket_count', 0,
          'malformed_object_count', 0,
          'manifest_binding_error_count', 0,
          'duplicate_object_key_count', 0,
          'reference_binding_error_count', 0,
          'inconsistent_alias_count', 0,
          'unclassified_reference_count', 0
        )
      )
    when 'visual_crop_coverage' then
      p_evidence ->> 'reference_schema' =
        'awardping.r2.canonical-object-references.v1'
      and p_evidence ->> 'visual_object_count' ~ '^[0-9]+$'
      and p_evidence ->> 'visual_reference_count' ~ '^[0-9]+$'
      and p_evidence ->> 'published_event_object_count' ~ '^[0-9]+$'
      and p_evidence ->> 'published_event_reference_count' ~ '^[0-9]+$'
      and p_evidence ->> 'manifest_source_object_count' ~ '^[0-9]+$'
      and p_evidence ->> 'manifest_source_reference_count' ~ '^[0-9]+$'
      and p_evidence ->> 'alias_reference_count' ~ '^[0-9]+$'
      and p_evidence ->> 'aliased_object_count' ~ '^[0-9]+$'
      and p_evidence ->> 'reference_set_hash' ~ '^[0-9a-f]{64}$'
      and p_evidence ->> 'visual_object_set_hash' ~ '^[0-9a-f]{64}$'
    else true
  end;
$$;

revoke all on function private.stage1_release_artifact_evidence_valid(
  text, jsonb
) from public, anon, authenticated, service_role;

create or replace function public.record_stage1_r2_recovery_drill_artifact(
  p_status text,
  p_app_revision text,
  p_evidence jsonb,
  p_expected_evidence_hash text,
  p_signer_key_id text,
  p_expected_signed_payload_hash text,
  p_signature text,
  p_started_at timestamptz,
  p_completed_at timestamptz,
  p_valid_until timestamptz,
  p_actor text
)
returns public.stage1_release_acceptance_artifacts
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_runtime public.stage1_release_acceptance_artifacts%rowtype;
  v_objects jsonb;
begin
  if p_status = 'passed' then
    select * into v_runtime
    from private.stage1_current_valid_release_artifact(
      'hosted_runtime_identity', pg_catalog.clock_timestamp()
    )
    limit 1;
    v_objects := private.stage1_visual_r2_object_set_snapshot();
    if v_runtime.id is null
      or v_runtime.app_revision <> pg_catalog.btrim(p_app_revision)
      or not private.stage1_r2_recovery_evidence_matches_snapshot(
        p_evidence, v_objects
      ) then
      raise exception using errcode = '23514',
        message = 'R2 proof did not verify the complete current Stage 1 canonical object-reference graph.';
    end if;
  end if;
  return private.insert_stage1_external_release_artifact(
    'r2_recovery_drill', 'production', p_status,
    'stage1-national-25-v2',
    '6e7dd7ee1372671cbfb22b17b862d867145a93c7dc0b73d49afc11f504ee6c8f',
    'stage1-publication-v1', p_app_revision, p_evidence,
    p_expected_evidence_hash, p_signer_key_id,
    p_expected_signed_payload_hash, p_signature,
    p_started_at, p_completed_at, p_valid_until, p_actor
  );
end;
$$;

revoke all on function public.record_stage1_r2_recovery_drill_artifact(
  text, text, jsonb, text, text, text, text,
  timestamptz, timestamptz, timestamptz, text
) from public, anon, authenticated, service_role;
grant execute on function public.record_stage1_r2_recovery_drill_artifact(
  text, text, jsonb, text, text, text, text,
  timestamptz, timestamptz, timestamptz, text
) to service_role;

create or replace function public.record_stage1_visual_crop_coverage_artifact(
  p_actor text
)
returns public.stage1_release_acceptance_artifacts
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_target jsonb := private.stage1_release_production_target_snapshot();
  v_runtime public.stage1_release_acceptance_artifacts%rowtype;
  v_r2 public.stage1_release_acceptance_artifacts%rowtype;
  v_objects jsonb;
  v_coverage jsonb;
  v_evidence jsonb;
  v_status text;
  v_artifact public.stage1_release_acceptance_artifacts%rowtype;
begin
  if nullif(pg_catalog.btrim(p_actor), '') is null then
    raise exception using errcode = '22023',
      message = 'A crop-coverage actor is required.';
  end if;
  if v_target ->> 'configured' <> 'true' then
    raise exception using errcode = '55000',
      message = 'The administrator-owned production target is not configured.';
  end if;
  select * into v_runtime
  from private.stage1_current_valid_release_artifact(
    'hosted_runtime_identity', v_now
  )
  limit 1;
  if v_runtime.id is null
    or v_runtime.completed_at < v_now - interval '1 hour' then
    raise exception using errcode = '23514',
      message = 'Current signed hosted runtime identity is required before deriving crop coverage.';
  end if;

  v_objects := private.stage1_visual_r2_object_set_snapshot();
  select * into v_r2
  from private.stage1_current_valid_release_artifact(
    'r2_recovery_drill', v_now
  ) artifact
  where artifact.app_revision = v_runtime.app_revision
    and private.stage1_r2_recovery_evidence_matches_snapshot(
      artifact.evidence, v_objects
    )
  limit 1;
  v_coverage := private.stage1_visual_crop_coverage_snapshot();
  v_evidence := v_coverage || pg_catalog.jsonb_build_object(
    'producer_contract', 'awardping.stage1.database-derived-release-evidence.v2',
    'derivation_contract_hash',
      private.stage1_visual_crop_derivation_contract_hash(),
    'measured_at', v_now,
    'target_config_version', (v_target ->> 'config_version')::bigint,
    'target_config_hash', v_target ->> 'target_config_hash',
    'production_app_origin', v_target ->> 'app_origin',
    'supabase_origin', v_target ->> 'supabase_origin',
    'supabase_project_ref', v_target ->> 'supabase_project_ref',
    'r2_hashes_verified', v_r2.id is not null,
    'r2_artifact_id', v_r2.id,
    'derived_at', v_now
  );
  v_status := case
    when v_evidence ->> 'unverified_publishable_events' = '0'
      and v_evidence ->> 'terminal_failures' = '0'
      and v_evidence ->> 'pdf_evidence_failures' = '0'
      and v_r2.id is not null
      then 'passed'
    else 'failed'
  end;

  insert into public.stage1_release_acceptance_artifacts (
    artifact_kind,
    producer_kind,
    environment,
    status,
    cohort_identity_version,
    cohort_identity_hash,
    policy_version,
    app_revision,
    target_config_version,
    target_config_hash,
    evidence,
    evidence_hash,
    started_at,
    completed_at,
    valid_until,
    actor
  ) values (
    'visual_crop_coverage',
    'database_derived',
    'production',
    v_status,
    'stage1-national-25-v2',
    '6e7dd7ee1372671cbfb22b17b862d867145a93c7dc0b73d49afc11f504ee6c8f',
    'stage1-publication-v1',
    v_runtime.app_revision,
    (v_target ->> 'config_version')::bigint,
    v_target ->> 'target_config_hash',
    v_evidence,
    public.stage1_publication_evidence_hash(v_evidence),
    v_now,
    v_now,
    v_now + interval '24 hours',
    pg_catalog.btrim(p_actor)
  ) returning * into v_artifact;
  return v_artifact;
end;
$$;

revoke all on function public.record_stage1_visual_crop_coverage_artifact(text)
  from public, anon, authenticated, service_role;
grant execute on function public.record_stage1_visual_crop_coverage_artifact(text)
  to service_role;

alter function public.list_stage1_effective_publication()
  rename to stage1_effective_pub_pre_r2_graph_20260810184524;

revoke all on function public.stage1_effective_pub_pre_r2_graph_20260810184524()
  from public, anon, authenticated, service_role;

create or replace function public.list_stage1_effective_publication()
returns table (
  cohort_key text,
  effectively_verified boolean,
  effective_reason text,
  evaluated_at timestamptz,
  cohort_ready boolean,
  cohort_readiness_reason text,
  release_epoch uuid,
  release_state text,
  release_policy_version text,
  release_identity_version text,
  release_identity_hash text
)
language sql
stable
security definer
set search_path = ''
as $$
  with evaluation as (
    select pg_catalog.statement_timestamp() as evaluated_at
  ), base as (
    select *
    from public.stage1_effective_pub_pre_r2_graph_20260810184524()
  ), objects as (
    select private.stage1_visual_r2_object_set_snapshot() as value
  ), coverage as (
    select private.stage1_visual_crop_coverage_snapshot() as value
  ), runtime_artifact as (
    select artifact.*
    from evaluation
    cross join lateral private.stage1_current_valid_release_artifact(
      'hosted_runtime_identity', evaluation.evaluated_at
    ) artifact
    where artifact.completed_at >=
      evaluation.evaluated_at - interval '1 hour'
    limit 1
  ), r2_artifact as (
    select artifact.*
    from evaluation
    cross join objects
    cross join runtime_artifact runtime
    cross join lateral private.stage1_current_valid_release_artifact(
      'r2_recovery_drill', evaluation.evaluated_at
    ) artifact
    where artifact.app_revision = runtime.app_revision
      and private.stage1_r2_recovery_evidence_matches_snapshot(
        artifact.evidence, objects.value
      )
    limit 1
  ), r2_release_proof as (
    select exists (select 1 from r2_artifact) as current
  ), crop_artifact as (
    select artifact.*
    from evaluation
    cross join objects
    cross join coverage
    cross join runtime_artifact runtime
    cross join r2_artifact r2
    cross join lateral private.stage1_current_valid_release_artifact(
      'visual_crop_coverage', evaluation.evaluated_at
    ) artifact
    where artifact.producer_kind = 'database_derived'
      and artifact.app_revision = runtime.app_revision
      and artifact.evidence ->> 'eligible_events' =
        coverage.value ->> 'eligible_events'
      and artifact.evidence ->> 'verified_events' =
        coverage.value ->> 'verified_events'
      and artifact.evidence ->> 'unverified_publishable_events' =
        coverage.value ->> 'unverified_publishable_events'
      and artifact.evidence ->> 'terminal_failures' =
        coverage.value ->> 'terminal_failures'
      and artifact.evidence ->> 'pdf_evidence_failures' =
        coverage.value ->> 'pdf_evidence_failures'
      and artifact.evidence ->> 'coverage_set_hash' =
        coverage.value ->> 'coverage_set_hash'
      and artifact.evidence ->> 'reference_schema' =
        coverage.value ->> 'reference_schema'
      and artifact.evidence ->> 'visual_object_count' =
        objects.value ->> 'visual_object_count'
      and artifact.evidence ->> 'visual_reference_count' =
        objects.value ->> 'visual_reference_count'
      and artifact.evidence ->> 'published_event_object_count' =
        objects.value ->> 'published_event_object_count'
      and artifact.evidence ->> 'published_event_reference_count' =
        objects.value ->> 'published_event_reference_count'
      and artifact.evidence ->> 'manifest_source_object_count' =
        objects.value ->> 'manifest_source_object_count'
      and artifact.evidence ->> 'manifest_source_reference_count' =
        objects.value ->> 'manifest_source_reference_count'
      and artifact.evidence ->> 'alias_reference_count' =
        objects.value ->> 'alias_reference_count'
      and artifact.evidence ->> 'aliased_object_count' =
        objects.value ->> 'aliased_object_count'
      and artifact.evidence ->> 'reference_set_hash' =
        objects.value ->> 'reference_set_hash'
      and artifact.evidence ->> 'visual_object_set_hash' =
        objects.value ->> 'visual_object_set_hash'
      and artifact.evidence ->> 'derivation_contract_hash' =
        private.stage1_visual_crop_derivation_contract_hash()
      and artifact.evidence ->> 'r2_hashes_verified' = 'true'
      and artifact.evidence ->> 'r2_artifact_id' = r2.id::text
    limit 1
  ), crop_release_proof as (
    select exists (select 1 from crop_artifact) as current
  )
  select
    base.cohort_key,
    base.effectively_verified
      and r2_release_proof.current
      and crop_release_proof.current,
    case
      when not r2_release_proof.current
        then 'signed_r2_recovery_artifact_not_current'
      when not crop_release_proof.current
        then 'database_derived_crop_artifact_not_current'
      else base.effective_reason
    end,
    base.evaluated_at,
    base.cohort_ready,
    base.cohort_readiness_reason,
    base.release_epoch,
    base.release_state,
    base.release_policy_version,
    base.release_identity_version,
    base.release_identity_hash
  from base
  join public.stage1_award_registry registry
    on registry.cohort_key = base.cohort_key
  cross join r2_release_proof
  cross join crop_release_proof
  order by registry.launch_rank;
$$;

revoke all on function public.list_stage1_effective_publication()
  from public, anon, authenticated, service_role;
grant execute on function public.list_stage1_effective_publication()
  to service_role;

comment on function public.list_stage1_effective_publication() is
  'Authoritative Stage 1 publication decision; visibility requires current runtime-bound v4 R2 and database-derived exact-crop evidence.';

create or replace function private.stage1_release_gate_snapshot(
  p_evaluated_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inner jsonb;
  v_contact jsonb;
  v_failures jsonb;
  v_objects jsonb;
  v_coverage jsonb;
  v_runtime public.stage1_release_acceptance_artifacts%rowtype;
  v_r2 public.stage1_release_acceptance_artifacts%rowtype;
  v_crop public.stage1_release_acceptance_artifacts%rowtype;
  v_vault_access_contract_safe boolean := false;
  v_vault_service_profile_blocked boolean := false;
  v_r2_bound boolean := false;
  v_crop_bound boolean := false;
  v_basis jsonb;
begin
  if p_evaluated_at is null then
    raise exception using errcode = '22023',
      message = 'A release evaluation timestamp is required.';
  end if;
  v_inner := private.stage1_gate_without_contact_fence_20260717123000(
    p_evaluated_at
  );
  v_contact := private.personal_data_legacy_contact_gate_snapshot();
  v_objects := private.stage1_visual_r2_object_set_snapshot();
  v_coverage := private.stage1_visual_crop_coverage_snapshot();

  select * into v_runtime
  from private.stage1_current_valid_release_artifact(
    'hosted_runtime_identity', p_evaluated_at
  ) artifact
  where artifact.completed_at >= p_evaluated_at - interval '1 hour'
  limit 1;
  select * into v_r2
  from private.stage1_current_valid_release_artifact(
    'r2_recovery_drill', p_evaluated_at
  )
  limit 1;
  select * into v_crop
  from private.stage1_current_valid_release_artifact(
    'visual_crop_coverage', p_evaluated_at
  )
  limit 1;

  -- The inherited pre-contact gate evaluated the runtime profile before it
  -- loaded v_runtime.  Recompute that read-only Vault proof here so the
  -- canonical gate neither fails permanently nor waives a missing runtime.
  v_vault_access_contract_safe := coalesce(
    private.stage1_vault_access_contract_safe(), false
  );
  v_vault_service_profile_blocked :=
    coalesce(v_runtime.evidence ->> 'vault_profile_http_status', '') = '406'
    and coalesce(v_runtime.evidence ->> 'vault_profile_postgrest_code', '') =
      'PGRST106'
    and coalesce(v_runtime.evidence ->> 'vault_profile_exposed', '') = 'false'
    and coalesce(v_runtime.evidence ->> 'vault_profile_redirected', '') = 'false';

  v_r2_bound := coalesce((
    v_runtime.id is not null
    and v_r2.id is not null
    and v_r2.app_revision = v_runtime.app_revision
    and private.stage1_r2_recovery_evidence_matches_snapshot(
      v_r2.evidence, v_objects
    )
  ), false);
  v_crop_bound := coalesce((
    v_runtime.id is not null
    and v_crop.id is not null
    and v_crop.producer_kind = 'database_derived'
    and v_crop.app_revision = v_runtime.app_revision
    and v_crop.evidence ->> 'eligible_events' =
      v_coverage ->> 'eligible_events'
    and v_crop.evidence ->> 'verified_events' =
      v_coverage ->> 'verified_events'
    and v_crop.evidence ->> 'unverified_publishable_events' =
      v_coverage ->> 'unverified_publishable_events'
    and v_crop.evidence ->> 'terminal_failures' =
      v_coverage ->> 'terminal_failures'
    and v_crop.evidence ->> 'pdf_evidence_failures' =
      v_coverage ->> 'pdf_evidence_failures'
    and v_crop.evidence ->> 'coverage_set_hash' =
      v_coverage ->> 'coverage_set_hash'
    and v_crop.evidence ->> 'reference_schema' =
      v_coverage ->> 'reference_schema'
    and v_crop.evidence ->> 'visual_object_count' =
      v_objects ->> 'visual_object_count'
    and v_crop.evidence ->> 'visual_reference_count' =
      v_objects ->> 'visual_reference_count'
    and v_crop.evidence ->> 'published_event_object_count' =
      v_objects ->> 'published_event_object_count'
    and v_crop.evidence ->> 'published_event_reference_count' =
      v_objects ->> 'published_event_reference_count'
    and v_crop.evidence ->> 'manifest_source_object_count' =
      v_objects ->> 'manifest_source_object_count'
    and v_crop.evidence ->> 'manifest_source_reference_count' =
      v_objects ->> 'manifest_source_reference_count'
    and v_crop.evidence ->> 'alias_reference_count' =
      v_objects ->> 'alias_reference_count'
    and v_crop.evidence ->> 'aliased_object_count' =
      v_objects ->> 'aliased_object_count'
    and v_crop.evidence ->> 'reference_set_hash' =
      v_objects ->> 'reference_set_hash'
    and v_crop.evidence ->> 'visual_object_set_hash' =
      v_objects ->> 'visual_object_set_hash'
    and v_crop.evidence ->> 'derivation_contract_hash' =
      private.stage1_visual_crop_derivation_contract_hash()
    and v_crop.evidence ->> 'r2_hashes_verified' = 'true'
    and v_crop.evidence ->> 'r2_artifact_id' = v_r2.id::text
    and v_r2_bound
  ), false);

  if pg_catalog.jsonb_typeof(v_inner) is distinct from 'object' then
    v_inner := '{}'::jsonb;
    v_failures := '["inherited_release_gate_invalid"]'::jsonb;
  elsif pg_catalog.jsonb_typeof(v_inner -> 'failures') = 'array' then
    v_failures := v_inner -> 'failures';
  else
    v_failures := '["inherited_release_gate_invalid"]'::jsonb;
  end if;
  if v_vault_access_contract_safe and v_vault_service_profile_blocked then
    v_failures := v_failures - 'vault_access_contract_failed';
  elsif not v_failures @> '["vault_access_contract_failed"]'::jsonb then
    v_failures := v_failures || '["vault_access_contract_failed"]'::jsonb;
  end if;
  if not v_r2_bound
    and not v_failures @>
      '["signed_r2_recovery_or_object_set_failed"]'::jsonb then
    v_failures := v_failures ||
      '["signed_r2_recovery_or_object_set_failed"]'::jsonb;
  end if;
  if not v_crop_bound
    and not v_failures @>
      '["database_derived_exact_crop_coverage_failed"]'::jsonb then
    v_failures := v_failures ||
      '["database_derived_exact_crop_coverage_failed"]'::jsonb;
  end if;
  if (not v_r2_bound or not v_crop_bound)
    and not v_failures @> '["release_artifact_set_failed"]'::jsonb then
    v_failures := v_failures || '["release_artifact_set_failed"]'::jsonb;
  end if;
  if v_contact ->> 'state' is distinct from 'SAFE'
    and not v_failures @>
      '["legacy_contact_ciphertext_not_safe"]'::jsonb then
    v_failures := v_failures ||
      '["legacy_contact_ciphertext_not_safe"]'::jsonb;
  end if;

  v_basis := (
    v_inner - 'generated_at' - 'state' - 'state_hash' - 'failures' -
      'r2_recovery' - 'visual_crop_coverage' -
      'personal_data_legacy_contacts' - 'vault_security'
  ) || pg_catalog.jsonb_build_object(
    'r2_recovery', coalesce(v_inner -> 'r2_recovery', '{}'::jsonb) ||
      pg_catalog.jsonb_build_object(
        'artifact_id', v_r2.id,
        'artifact_evidence_hash', v_r2.evidence_hash,
        'current_object_set', v_objects,
        'bound', v_r2_bound
      ),
    'visual_crop_coverage', v_coverage || pg_catalog.jsonb_build_object(
      'artifact_id', v_crop.id,
      'artifact_evidence_hash', v_crop.evidence_hash,
      'r2_hashes_verified', v_r2_bound,
      'bound', v_crop_bound
    ),
    'personal_data_legacy_contacts', v_contact,
    'vault_security', pg_catalog.jsonb_build_object(
      'api_surface_safe', v_vault_access_contract_safe,
      'service_role_data_api_profile_blocked',
        v_vault_service_profile_blocked,
      'profile_http_status',
        v_runtime.evidence -> 'vault_profile_http_status',
      'profile_postgrest_code',
        v_runtime.evidence -> 'vault_profile_postgrest_code'
    ),
    'failures', v_failures
  );
  return v_basis || pg_catalog.jsonb_build_object(
    'generated_at', p_evaluated_at,
    'state', case
      when pg_catalog.jsonb_array_length(v_failures) = 0 then 'READY'
      else 'HOLD'
    end,
    'state_hash', public.stage1_publication_evidence_hash(v_basis)
  );
end;
$$;

revoke all on function private.stage1_release_gate_snapshot(timestamptz)
  from public, anon, authenticated, service_role;
