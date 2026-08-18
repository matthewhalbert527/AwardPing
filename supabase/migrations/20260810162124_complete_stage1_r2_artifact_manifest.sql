-- Require one raw-byte recovery binding for every immutable object referenced
-- by a reviewed Stage 1 source snapshot. The prior v2 recovery manifest signed
-- only the primary page/PDF and semantic text objects, so thumbnails, retained
-- metadata, layouts, and expanded-state evidence could be absent from R2 while
-- a recovery drill still passed.

create or replace function private.stage1_manifest_source_capture_binding_valid(
  p_source_id uuid,
  p_kind text,
  p_object_keys jsonb,
  p_hashes jsonb,
  p_metadata jsonb
)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_primary_key text;
  v_generation_prefix text;
  v_expansion_page_count integer := 0;
  v_expansion_layout_count integer := 0;
  v_layout_present boolean := false;
begin
  if p_source_id is null
    or pg_catalog.jsonb_typeof(p_object_keys) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_hashes) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_metadata) is distinct from 'object'
    or p_metadata ->> 'artifact_bindings_schema' is distinct from
      'awardping.r2.capture-artifact-bindings.v1'
    or pg_catalog.jsonb_typeof(p_metadata -> 'artifact_bindings')
      is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_metadata -> 'text_object_bytes')
      is distinct from 'number'
    or coalesce(p_metadata ->> 'text_object_bytes', '') !~ '^[1-9][0-9]*$'
    or pg_catalog.jsonb_typeof(p_metadata -> 'text_length')
      is distinct from 'number'
    or coalesce(p_metadata ->> 'text_length', '') !~ '^(0|[1-9][0-9]*)$'
  then
    return false;
  end if;

  -- The artifact map is exact: it has neither missing nor additional slots.
  if exists (
    select 1
    from pg_catalog.jsonb_object_keys(p_object_keys) object_slot(slot_name)
    where not ((p_metadata -> 'artifact_bindings') ? object_slot.slot_name)
  ) or exists (
    select 1
    from pg_catalog.jsonb_object_keys(
      p_metadata -> 'artifact_bindings'
    ) binding_slot(slot_name)
    where not (p_object_keys ? binding_slot.slot_name)
  ) then
    return false;
  end if;

  -- Every binding has exactly four typed fields and hashes the retained raw
  -- bytes. Content type is part of the signed contract, not inferred by R2.
  if exists (
    select 1
    from pg_catalog.jsonb_each(
      p_metadata -> 'artifact_bindings'
    ) binding(slot_name, value)
    where pg_catalog.jsonb_typeof(binding.value) is distinct from 'object'
      or not (binding.value ?& array[
        'sha256', 'byte_length', 'content_type', 'hash_mode'
      ])
      or (
        select pg_catalog.count(*)
        from pg_catalog.jsonb_object_keys(
          case
            when pg_catalog.jsonb_typeof(binding.value) = 'object'
              then binding.value
            else '{}'::jsonb
          end
        ) binding_field(field_name)
      ) <> 4
      or pg_catalog.jsonb_typeof(binding.value -> 'sha256')
        is distinct from 'string'
      or coalesce(binding.value ->> 'sha256', '') !~ '^[0-9a-f]{64}$'
      or pg_catalog.jsonb_typeof(binding.value -> 'byte_length')
        is distinct from 'number'
      or coalesce(binding.value ->> 'byte_length', '') !~ '^[1-9][0-9]*$'
      or pg_catalog.jsonb_typeof(binding.value -> 'content_type')
        is distinct from 'string'
      or pg_catalog.jsonb_typeof(binding.value -> 'hash_mode')
        is distinct from 'string'
      or binding.value ->> 'hash_mode' is distinct from 'raw_sha256'
      or binding.value ->> 'content_type' is distinct from case
        when binding.slot_name in ('page', 'thumb')
          or binding.slot_name ~ '^expansion_state_[0-9]{2}$'
          then 'image/jpeg'
        when binding.slot_name = 'pdf' then 'application/pdf'
        when binding.slot_name = 'text' then 'text/plain; charset=utf-8'
        when binding.slot_name in ('layout', 'meta')
          or binding.slot_name ~ '^expansion_state_[0-9]{2}_layout$'
          then 'application/json; charset=utf-8'
        else null
      end
  ) then
    return false;
  end if;

  if p_kind = 'webpage' then
    v_primary_key := p_object_keys ->> 'page';
    if coalesce(v_primary_key, '') !~ (
      '^visual-snapshots/sources/' || p_source_id::text ||
      '/captures/[0-9a-f]{32}/page[.]jpg$'
    )
      or not (p_object_keys ?& array['page', 'thumb', 'text', 'meta'])
      or p_object_keys ? 'pdf'
      or coalesce(p_hashes ->> 'image_hash', '') !~ '^[0-9a-f]{64}$'
      or coalesce(p_hashes ->> 'text_hash', '') !~ '^[0-9a-f]{64}$'
      or pg_catalog.jsonb_typeof(p_metadata -> 'page_bytes')
        is distinct from 'number'
      or coalesce(p_metadata ->> 'page_bytes', '') !~ '^[1-9][0-9]*$'
      or pg_catalog.jsonb_typeof(p_metadata -> 'thumb_bytes')
        is distinct from 'number'
      or coalesce(p_metadata ->> 'thumb_bytes', '') !~ '^[1-9][0-9]*$'
      or p_metadata #>> '{artifact_bindings,page,sha256}'
        is distinct from p_hashes ->> 'image_hash'
      or p_metadata #>> '{artifact_bindings,page,byte_length}'
        is distinct from p_metadata ->> 'page_bytes'
      or p_metadata #>> '{artifact_bindings,thumb,byte_length}'
        is distinct from p_metadata ->> 'thumb_bytes'
    then
      return false;
    end if;
    v_generation_prefix := pg_catalog.left(
      v_primary_key,
      pg_catalog.length(v_primary_key) - pg_catalog.length('page.jpg')
    );
  elsif p_kind = 'pdf' then
    v_primary_key := p_object_keys ->> 'pdf';
    if coalesce(v_primary_key, '') !~ (
      '^visual-snapshots/sources/' || p_source_id::text ||
      '/captures/[0-9a-f]{32}/document[.]pdf$'
    )
      or not (p_object_keys ?& array['pdf', 'text', 'meta'])
      or p_object_keys ?| array['page', 'thumb', 'layout']
      or exists (
        select 1
        from pg_catalog.jsonb_object_keys(p_object_keys) slot(slot_name)
        where slot.slot_name ~ '^expansion_state_'
      )
      or coalesce(p_hashes ->> 'file_hash', '') !~ '^[0-9a-f]{64}$'
      or coalesce(p_hashes ->> 'text_hash', '') !~ '^[0-9a-f]{64}$'
      or pg_catalog.jsonb_typeof(p_metadata -> 'file_bytes')
        is distinct from 'number'
      or coalesce(p_metadata ->> 'file_bytes', '') !~ '^[1-9][0-9]*$'
      or p_metadata #>> '{artifact_bindings,pdf,sha256}'
        is distinct from p_hashes ->> 'file_hash'
      or p_metadata #>> '{artifact_bindings,pdf,byte_length}'
        is distinct from p_metadata ->> 'file_bytes'
    then
      return false;
    end if;
    v_generation_prefix := pg_catalog.left(
      v_primary_key,
      pg_catalog.length(v_primary_key) - pg_catalog.length('document.pdf')
    );
  else
    return false;
  end if;

  if p_object_keys ->> 'text' is distinct from
      (v_generation_prefix || 'text.txt')
    or p_metadata #>> '{artifact_bindings,text,byte_length}'
      is distinct from p_metadata ->> 'text_object_bytes'
  then
    return false;
  end if;

  -- Every object remains under the one immutable source/generation prefix and
  -- has the exact kind-aware filename for its slot.
  if exists (
    select 1
    from pg_catalog.jsonb_each(p_object_keys) object_entry(slot_name, value)
    where pg_catalog.jsonb_typeof(object_entry.value) is distinct from 'string'
      or pg_catalog.left(
        object_entry.value #>> '{}',
        pg_catalog.length(v_generation_prefix)
      ) is distinct from v_generation_prefix
      or object_entry.value #>> '{}' ~* '(^|/)(latest|previous)(/|$)'
      or object_entry.value #>> '{}' ~ '[\\]'
      or object_entry.value #>> '{}' ~ '(^|/)[.][.](/|$)'
      or case
        when object_entry.slot_name = 'page' then
          object_entry.value #>> '{}' is distinct from
            v_generation_prefix || 'page.jpg'
        when object_entry.slot_name = 'thumb' then
          object_entry.value #>> '{}' is distinct from
            v_generation_prefix || 'thumb.jpg'
        when object_entry.slot_name = 'pdf' then
          object_entry.value #>> '{}' is distinct from
            v_generation_prefix || 'document.pdf'
        when object_entry.slot_name = 'text' then
          object_entry.value #>> '{}' is distinct from
            v_generation_prefix || 'text.txt'
        when object_entry.slot_name = 'layout' then
          object_entry.value #>> '{}' is distinct from
            v_generation_prefix || 'layout.json'
        when object_entry.slot_name = 'meta' then
          object_entry.value #>> '{}' is distinct from
            v_generation_prefix || 'meta.json'
        when object_entry.slot_name ~ '^expansion_state_[0-9]{2}$' then
          object_entry.value #>> '{}' is distinct from
            v_generation_prefix || 'expansion-state-' ||
            pg_catalog.substring(object_entry.slot_name, '[0-9]{2}$') || '.jpg'
        when object_entry.slot_name ~ '^expansion_state_[0-9]{2}_layout$' then
          object_entry.value #>> '{}' is distinct from
            v_generation_prefix || 'expansion-state-' ||
            pg_catalog.substring(object_entry.slot_name, '[0-9]{2}') ||
            '-layout.json'
        else true
      end
  ) then
    return false;
  end if;

  if (
    select pg_catalog.count(*)
    from pg_catalog.jsonb_each_text(p_object_keys) object_entry
  ) <> (
    select pg_catalog.count(distinct object_entry.value)
    from pg_catalog.jsonb_each_text(p_object_keys) object_entry
  ) then
    return false;
  end if;

  if p_kind = 'pdf' then
    return true;
  end if;

  select pg_catalog.count(*)::integer
  into v_expansion_page_count
  from pg_catalog.jsonb_object_keys(p_object_keys) slot(slot_name)
  where slot.slot_name ~ '^expansion_state_[0-9]{2}$';

  select pg_catalog.count(*)::integer
  into v_expansion_layout_count
  from pg_catalog.jsonb_object_keys(p_object_keys) slot(slot_name)
  where slot.slot_name ~ '^expansion_state_[0-9]{2}_layout$';

  if v_expansion_page_count <> v_expansion_layout_count
    or pg_catalog.jsonb_typeof(p_metadata -> 'expansion_state_count')
      is distinct from 'number'
    or coalesce(p_metadata ->> 'expansion_state_count', '')
      !~ '^(0|[1-9][0-9]*)$'
    or pg_catalog.jsonb_typeof(p_metadata -> 'expansion_state_screenshots')
      is distinct from 'array'
  then
    return false;
  end if;

  if p_metadata ->> 'expansion_state_count' is distinct from
      v_expansion_page_count::text
    or pg_catalog.jsonb_array_length(
      p_metadata -> 'expansion_state_screenshots'
    ) <> v_expansion_page_count
  then
    return false;
  end if;

  -- Pair every expanded screenshot with its layout and require 01..N without
  -- gaps. JSON object keys are unique, so membership in that range plus count
  -- equality proves contiguity.
  if exists (
    select 1
    from pg_catalog.jsonb_object_keys(p_object_keys) slot(slot_name)
    where slot.slot_name ~ '^expansion_state_[0-9]{2}$'
      and (
        not (p_object_keys ? (slot.slot_name || '_layout'))
        or pg_catalog.substring(slot.slot_name, '[0-9]{2}$')::integer < 1
        or pg_catalog.substring(slot.slot_name, '[0-9]{2}$')::integer
          > v_expansion_page_count
      )
  ) or exists (
    select 1
    from pg_catalog.jsonb_object_keys(p_object_keys) slot(slot_name)
    where slot.slot_name ~ '^expansion_state_[0-9]{2}_layout$'
      and not (
        p_object_keys ? pg_catalog.regexp_replace(slot.slot_name, '_layout$', '')
      )
  ) then
    return false;
  end if;

  -- Expansion metadata binds its page bytes and geometry identity. Layout JSON
  -- itself is recovered by its independent raw-byte artifact binding.
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(
      p_metadata -> 'expansion_state_screenshots'
    ) with ordinality state(value, array_index)
    cross join lateral (
      select pg_catalog.lpad(state.array_index::text, 2, '0') as suffix
    ) expected
    where pg_catalog.jsonb_typeof(state.value) is distinct from 'object'
      or state.value ->> 'state_id' is distinct from
        ('expansion-state-' || expected.suffix)
      or coalesce(state.value ->> 'image_hash', '') !~ '^[0-9a-f]{64}$'
      or coalesce(state.value ->> 'layout_hash', '') !~ '^[0-9a-f]{64}$'
      or coalesce(state.value ->> 'text_hash', '') !~ '^[0-9a-f]{64}$'
      or pg_catalog.jsonb_typeof(state.value -> 'page_bytes')
        is distinct from 'number'
      or coalesce(state.value ->> 'page_bytes', '') !~ '^[1-9][0-9]*$'
      or pg_catalog.jsonb_typeof(state.value -> 'text_length')
        is distinct from 'number'
      or coalesce(state.value ->> 'text_length', '') !~ '^(0|[1-9][0-9]*)$'
      or state.value #>> '{text_geometry,geometry_hash}'
        is distinct from state.value ->> 'layout_hash'
      or state.value #>> '{text_geometry,screenshot,image_hash}'
        is distinct from state.value ->> 'image_hash'
      or p_metadata #>> array[
        'artifact_bindings',
        'expansion_state_' || expected.suffix,
        'sha256'
      ] is distinct from state.value ->> 'image_hash'
      or p_metadata #>> array[
        'artifact_bindings',
        'expansion_state_' || expected.suffix,
        'byte_length'
      ] is distinct from state.value ->> 'page_bytes'
  ) then
    return false;
  end if;

  v_layout_present := p_object_keys ? 'layout';
  if v_layout_present then
    if coalesce(p_hashes ->> 'layout_hash', '') !~ '^[0-9a-f]{64}$'
      or p_metadata ->> 'layout_hash' is distinct from
        p_hashes ->> 'layout_hash'
      or p_metadata #>> '{text_geometry,geometry_hash}' is distinct from
        p_hashes ->> 'layout_hash'
      or p_metadata #>> '{text_geometry,screenshot,image_hash}' is distinct from
        p_hashes ->> 'image_hash'
      or pg_catalog.jsonb_typeof(p_metadata -> 'localization')
        is distinct from 'object'
      or p_metadata #>> '{localization,status}' is distinct from 'geometry_ready'
      or p_metadata #> '{localization,geometry_ready}' is distinct from
        'true'::jsonb
      or p_metadata #> '{localization,accounted_for}' is distinct from
        'true'::jsonb
      or nullif(pg_catalog.btrim(
        coalesce(p_metadata #>> '{localization,unavailable_reason}', '')
      ), '') is not null
      or p_metadata #>> '{localization,geometry_hash}' is distinct from
        p_hashes ->> 'layout_hash'
      or p_metadata #>> '{localization,bound_image_hash}' is distinct from
        p_hashes ->> 'image_hash'
      or p_metadata #>> '{localization,semantic_crop_contract}' is distinct from
        'visual-exact-text-binding-v2'
    then
      return false;
    end if;
  else
    -- A missing main layout is accepted only as explicit, non-contradictory
    -- unavailability. It cannot coexist with expansion layouts or geometry/hash
    -- claims that imply retained localization evidence exists.
    if v_expansion_page_count <> 0
      or nullif(pg_catalog.btrim(coalesce(p_hashes ->> 'layout_hash', '')), '')
        is not null
      or nullif(pg_catalog.btrim(coalesce(p_metadata ->> 'layout_hash', '')), '')
        is not null
      or nullif(pg_catalog.btrim(coalesce(
        p_metadata #>> '{text_geometry,geometry_hash}', ''
      )), '') is not null
      or nullif(pg_catalog.btrim(coalesce(
        p_metadata #>> '{text_geometry,screenshot,image_hash}', ''
      )), '') is not null
      or (
        p_metadata ? 'text_geometry'
        and pg_catalog.jsonb_typeof(p_metadata -> 'text_geometry')
          not in ('object', 'null')
      )
      or (
        pg_catalog.jsonb_typeof(p_metadata -> 'text_geometry') = 'object'
        and not coalesce((
          p_metadata #>> '{text_geometry,status}' = 'unavailable'
          or p_metadata #>> '{text_geometry,status}' ~ '^unavailable_'
        ), false)
      )
      or pg_catalog.jsonb_typeof(p_metadata -> 'localization')
        is distinct from 'object'
      or not coalesce((
        p_metadata #>> '{localization,status}' = 'unavailable'
        or p_metadata #>> '{localization,status}' ~ '^unavailable_'
        or p_metadata #>> '{localization,status}' =
          'capture_layout_unavailable'
        or p_metadata #>> '{localization,status}' =
          'evidence_only_geometry_unavailable'
      ), false)
      or p_metadata #> '{localization,geometry_ready}' is distinct from
        'false'::jsonb
      or p_metadata #> '{localization,accounted_for}' is distinct from
        'true'::jsonb
      or nullif(pg_catalog.btrim(coalesce(
        p_metadata #>> '{localization,unavailable_reason}', ''
      )), '') is null
      or nullif(pg_catalog.btrim(coalesce(
        p_metadata #>> '{localization,geometry_hash}', ''
      )), '') is not null
      or nullif(pg_catalog.btrim(coalesce(
        p_metadata #>> '{localization,bound_image_hash}', ''
      )), '') is not null
    then
      return false;
    end if;
  end if;

  return true;
end;
$$;

revoke all on function private.stage1_manifest_source_capture_binding_valid(
  uuid, text, jsonb, jsonb, jsonb
) from public, anon, authenticated, service_role;

-- Produce one recovery row per exact latest_object_keys slot for every valid
-- reviewed source, plus the immutable artifacts used by published events.
create or replace function private.stage1_visual_r2_object_set_snapshot()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with stage1_events as (
    select evidence.*
    from public.shared_award_change_event_visual_evidence evidence
    join public.shared_award_change_events event
      on event.id = evidence.change_event_id
    where event.suppressed_at is null
      and exists (
        select 1
        from public.stage1_award_members member
        where member.shared_award_id = event.shared_award_id
      )
  ), event_artifact_values as (
    select
      event.bucket,
      side.side_name,
      artifact.artifact_name,
      artifact.value
    from stage1_events event
    cross join lateral (values
      ('previous'::text, event.previous_capture),
      ('current'::text, event.current_capture)
    ) as side(side_name, capture)
    cross join lateral (values
      ('full'::text, side.capture -> 'full'),
      ('metadata'::text, side.capture -> 'metadata'),
      ('layout'::text, side.capture -> 'layout'),
      ('crop'::text, side.capture -> 'crop')
    ) as artifact(artifact_name, value)
    where nullif(pg_catalog.btrim(artifact.value ->> 'object_key'), '') is not null
  ), event_object_rows as (
    select distinct
      event.bucket,
      'published_event'::text as object_scope,
      null::uuid as source_id,
      event.side_name,
      event.artifact_name,
      event.value ->> 'object_key' as object_key,
      event.value ->> 'sha256' as sha256,
      'raw_sha256'::text as hash_mode,
      event.value ->> 'byte_length' as byte_length,
      null::text as semantic_length,
      event.value ->> 'content_type' as content_type
    from event_artifact_values event
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
    cross join unnest(manifest.source_ids) source_id
    left join public.shared_award_sources source
      on source.id = source_id
    left join public.shared_award_source_visual_snapshots snapshot
      on snapshot.shared_award_source_id = source_id
  ), manifest_binding_quality as (
    select pg_catalog.count(*) filter (
      where binding_valid is not true
    ) as error_count
    from manifest_bindings
  ), manifest_sources as (
    select distinct
      source_id,
      bucket,
      kind,
      object_keys,
      metadata
    from manifest_bindings
    where binding_valid
  ), manifest_object_rows as (
    select
      source.bucket,
      'manifest_source'::text as object_scope,
      source.source_id,
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
      ] as content_type
    from manifest_sources source
    cross join lateral pg_catalog.jsonb_each_text(source.object_keys)
      artifact(artifact_name, object_key)
  ), object_rows as (
    select * from event_object_rows
    union
    select * from manifest_object_rows
  ), object_payload as (
    select coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'bucket', object_row.bucket,
          'scope', object_row.object_scope,
          'source_id', object_row.source_id,
          'side', object_row.side_name,
          'artifact', object_row.artifact_name,
          'object_key', object_row.object_key,
          'sha256', object_row.sha256,
          'hash_mode', object_row.hash_mode,
          'byte_length', object_row.byte_length,
          'semantic_length', object_row.semantic_length,
          'content_type', object_row.content_type
        ) order by
          object_row.object_scope,
          object_row.bucket,
          object_row.source_id,
          object_row.object_key,
          object_row.side_name,
          object_row.artifact_name
      ),
      '[]'::jsonb
    ) as value
    from object_rows object_row
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
          or case object_row.object_scope
            when 'published_event' then
              coalesce(object_row.object_key, '') !~ '^visual-snapshots/published/'
              or object_row.hash_mode <> 'raw_sha256'
              or coalesce(object_row.content_type, '')
                !~ '^(image/|application/json)'
            when 'manifest_source' then
              object_row.source_id is null
              or object_row.object_key !~ (
                '^visual-snapshots/sources/' || object_row.source_id::text ||
                '/captures/[0-9a-f]{32}/'
              )
              or object_row.object_key !~ (
                '^visual-snapshots/sources/' || object_row.source_id::text ||
                '/captures/[0-9a-f]{32}/[^/]+$'
              )
              or object_row.object_key ~* '(^|/)(latest|previous)(/|$)'
              or object_row.hash_mode is distinct from 'raw_sha256'
              or case
                when object_row.artifact_name = 'page' then
                  object_row.object_key !~ '/page[.]jpg$'
                  or object_row.content_type <> 'image/jpeg'
                  or object_row.semantic_length is not null
                when object_row.artifact_name = 'thumb' then
                  object_row.object_key !~ '/thumb[.]jpg$'
                  or object_row.content_type <> 'image/jpeg'
                  or object_row.semantic_length is not null
                when object_row.artifact_name = 'pdf' then
                  object_row.object_key !~ '/document[.]pdf$'
                  or object_row.content_type <> 'application/pdf'
                  or object_row.semantic_length is not null
                when object_row.artifact_name = 'text' then
                  object_row.object_key !~ '/text[.]txt$'
                  or object_row.content_type <>
                    'text/plain; charset=utf-8'
                  or object_row.semantic_length is not null
                when object_row.artifact_name = 'layout' then
                  object_row.object_key !~ '/layout[.]json$'
                  or object_row.content_type <>
                    'application/json; charset=utf-8'
                  or object_row.semantic_length is not null
                when object_row.artifact_name = 'meta' then
                  object_row.object_key !~ '/meta[.]json$'
                  or object_row.content_type <>
                    'application/json; charset=utf-8'
                  or object_row.semantic_length is not null
                when object_row.artifact_name ~
                  '^expansion_state_[0-9]{2}$' then
                  object_row.object_key !~
                    '/expansion-state-[0-9]{2}[.]jpg$'
                  or object_row.content_type <> 'image/jpeg'
                  or object_row.semantic_length is not null
                when object_row.artifact_name ~
                  '^expansion_state_[0-9]{2}_layout$' then
                  object_row.object_key !~
                    '/expansion-state-[0-9]{2}-layout[.]json$'
                  or object_row.content_type <>
                    'application/json; charset=utf-8'
                  or object_row.semantic_length is not null
                else true
              end
            else true
          end
      ) as malformed_object_count,
      pg_catalog.count(*) filter (
        where object_row.object_scope = 'published_event'
      ) as published_event_object_count,
      pg_catalog.count(*) filter (
        where object_row.object_scope = 'manifest_source'
      ) as manifest_source_object_count
    from object_rows object_row
  )
  select pg_catalog.jsonb_build_object(
    'visual_object_count', pg_catalog.jsonb_array_length(object_payload.value),
    'published_event_object_count', object_quality.published_event_object_count,
    'manifest_source_object_count', object_quality.manifest_source_object_count,
    'visual_object_set_hash', public.stage1_publication_evidence_hash(
      object_payload.value
    ),
    'unexpected_bucket_count', object_quality.unexpected_bucket_count,
    'malformed_object_count',
      object_quality.malformed_object_count + manifest_binding_quality.error_count,
    'manifest_binding_error_count', manifest_binding_quality.error_count,
    'objects', object_payload.value
  )
  from object_payload
  cross join object_quality
  cross join manifest_binding_quality;
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
    'schema_version', 'awardping.stage1.r2-verification-manifest.v3',
    'artifact_bindings_schema',
      'awardping.r2.capture-artifact-bindings.v1',
    'target', v_target,
    'visual_object_count', v_manifest -> 'visual_object_count',
    'published_event_object_count',
      v_manifest -> 'published_event_object_count',
    'manifest_source_object_count',
      v_manifest -> 'manifest_source_object_count',
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
