-- Keep the database Stage 1 release gate in exact parity with the worker's
-- canonical expansion-state coverage contract. Retained accordion artifacts
-- prove what survived; they do not prove discovery or capture completeness.

create or replace function private.stage1_expansion_capture_coverage_valid(
  p_kind text,
  p_metadata jsonb
)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_max_safe_integer constant numeric := 9007199254740991;
  v_coverage jsonb;
  v_complete boolean;
  v_status text;
  v_raw_count numeric;
  v_logical_count numeric;
  v_attempted_count numeric;
  v_retained_count numeric;
  v_capture_limit numeric;
  v_truncated boolean;
  v_truncated_count numeric;
  v_failure_count numeric;
  v_raw_exact boolean;
  v_logical_exact boolean;
  v_truncated_exact boolean;
begin
  if pg_catalog.jsonb_typeof(p_metadata) is distinct from 'object' then
    return false;
  end if;

  v_coverage := p_metadata -> 'expansion_state_capture_coverage';
  if p_kind = 'pdf' then
    return v_coverage is null
      or pg_catalog.jsonb_typeof(v_coverage) = 'null';
  end if;
  if p_kind is distinct from 'webpage'
    or pg_catalog.jsonb_typeof(v_coverage) is distinct from 'object'
    or v_coverage ->> 'schema' is distinct from
      'awardping.expansion-state-capture-coverage.v1'
    or pg_catalog.jsonb_typeof(v_coverage -> 'status')
      is distinct from 'string'
    or not coalesce(v_coverage ->> 'status', '') = any(array[
      'verified_complete',
      'incomplete_discovery',
      'incomplete_truncated',
      'incomplete_failures',
      'incomplete_state_count',
      'skipped_disabled',
      'skipped_profile',
      'skipped_relevance',
      'unavailable_error'
    ]::text[])
  then
    return false;
  end if;

  if exists (
    select 1
    from pg_catalog.unnest(array[
      'attempted_count',
      'capture_limit',
      'failure_count',
      'logical_candidate_count',
      'raw_candidate_count',
      'retained_state_count',
      'truncated_count'
    ]::text[]) field_name
    where pg_catalog.jsonb_typeof(v_coverage -> field_name)
        is distinct from 'number'
      or coalesce(v_coverage ->> field_name, '') !~ '^(0|[1-9][0-9]*)$'
      or (case
        when pg_catalog.jsonb_typeof(v_coverage -> field_name) = 'number'
          and coalesce(v_coverage ->> field_name, '')
            ~ '^(0|[1-9][0-9]*)$'
          then (v_coverage ->> field_name)::numeric > v_max_safe_integer
        else false
      end)
  ) or exists (
    select 1
    from pg_catalog.unnest(array[
      'complete',
      'logical_candidate_count_exact',
      'raw_candidate_count_exact',
      'truncated',
      'truncated_count_exact'
    ]::text[]) field_name
    where pg_catalog.jsonb_typeof(v_coverage -> field_name)
      is distinct from 'boolean'
  ) then
    return false;
  end if;

  v_complete := (v_coverage ->> 'complete')::boolean;
  v_status := v_coverage ->> 'status';
  v_raw_count := (v_coverage ->> 'raw_candidate_count')::numeric;
  v_logical_count := (v_coverage ->> 'logical_candidate_count')::numeric;
  v_attempted_count := (v_coverage ->> 'attempted_count')::numeric;
  v_retained_count := (v_coverage ->> 'retained_state_count')::numeric;
  v_capture_limit := (v_coverage ->> 'capture_limit')::numeric;
  v_truncated := (v_coverage ->> 'truncated')::boolean;
  v_truncated_count := (v_coverage ->> 'truncated_count')::numeric;
  v_failure_count := (v_coverage ->> 'failure_count')::numeric;
  v_raw_exact := (v_coverage ->> 'raw_candidate_count_exact')::boolean;
  v_logical_exact :=
    (v_coverage ->> 'logical_candidate_count_exact')::boolean;
  v_truncated_exact := (v_coverage ->> 'truncated_count_exact')::boolean;

  if v_raw_count < v_logical_count
    or v_attempted_count > v_logical_count
    or v_attempted_count > v_capture_limit
    or v_retained_count > v_attempted_count
    or v_failure_count > v_attempted_count
    or pg_catalog.jsonb_typeof(p_metadata -> 'expansion_state_count')
      is distinct from 'number'
    or coalesce(p_metadata ->> 'expansion_state_count', '')
      !~ '^(0|[1-9][0-9]*)$'
    or (case
      when pg_catalog.jsonb_typeof(p_metadata -> 'expansion_state_count') = 'number'
        and coalesce(p_metadata ->> 'expansion_state_count', '')
          ~ '^(0|[1-9][0-9]*)$'
        then (p_metadata ->> 'expansion_state_count')::numeric
          is distinct from v_retained_count
      else false
    end)
    or pg_catalog.jsonb_typeof(
      p_metadata #> '{retained_artifact_projection,authoritative,expansion_state_count}'
    ) is distinct from 'number'
    or coalesce(
      p_metadata #>>
        '{retained_artifact_projection,authoritative,expansion_state_count}',
      ''
    ) !~ '^(0|[1-9][0-9]*)$'
    or (case
      when pg_catalog.jsonb_typeof(
        p_metadata #> '{retained_artifact_projection,authoritative,expansion_state_count}'
      ) = 'number'
        and coalesce(
          p_metadata #>>
            '{retained_artifact_projection,authoritative,expansion_state_count}',
          ''
        ) ~ '^(0|[1-9][0-9]*)$'
        then (
          p_metadata #>>
            '{retained_artifact_projection,authoritative,expansion_state_count}'
        )::numeric is distinct from v_retained_count
      else false
    end)
    or (
      v_logical_exact
      and v_truncated_exact
      and v_truncated_count is distinct from
        greatest(0, v_logical_count - v_attempted_count)
    )
    or (
      v_logical_exact
      and v_logical_count > v_attempted_count
      and not v_truncated
    )
    or v_complete is distinct from (v_status = 'verified_complete')
  then
    return false;
  end if;

  -- Stage 1 publication requires verified completeness. Incomplete legacy
  -- recovery verdicts remain recoverable locally/R2 but cannot satisfy release.
  return v_complete
    and v_raw_exact
    and v_logical_exact
    and not v_truncated
    and v_truncated_count = 0
    and v_truncated_exact
    and v_attempted_count = v_logical_count
    and v_retained_count = v_attempted_count
    and v_failure_count = 0;
end;
$$;

revoke all on function private.stage1_expansion_capture_coverage_valid(
  text, jsonb
) from public, anon, authenticated, service_role;

-- Permit complete retained accordion evidence when only the main-page geometry
-- is explicitly unavailable. Each expansion screenshot/layout pair remains
-- contiguous, exactly named, and independently raw-byte/hash bound. All other
-- source-capture validation remains fail closed.

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
  v_max_safe_integer constant numeric := 9007199254740991;
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
    or pg_catalog.jsonb_typeof(
      p_metadata -> 'retained_artifact_projection'
    ) is distinct from 'object'
    or p_metadata #>> '{retained_artifact_projection,schema}' is distinct from
      'awardping.capture-retained-artifact-projection.v1'
    or p_metadata #>> '{retained_artifact_projection,kind}' is distinct from
      p_kind
    or pg_catalog.jsonb_typeof(
      p_metadata #> '{retained_artifact_projection,authoritative}'
    ) is distinct from 'object'
    or pg_catalog.jsonb_typeof(
      p_metadata #> '{retained_artifact_projection,authoritative,layout_retained}'
    ) is distinct from 'boolean'
    or pg_catalog.jsonb_typeof(
      p_metadata #> '{retained_artifact_projection,authoritative,expansion_state_count}'
    ) is distinct from 'number'
    or coalesce(p_metadata #>>
      '{retained_artifact_projection,authoritative,expansion_state_count}', ''
    ) !~ '^(0|[1-9][0-9]*)$'
    or (case
      when pg_catalog.jsonb_typeof(
        p_metadata #> '{retained_artifact_projection,authoritative,expansion_state_count}'
      ) = 'number'
        then (p_metadata #>>
          '{retained_artifact_projection,authoritative,expansion_state_count}'
        )::numeric > v_max_safe_integer
      else false
    end)
    or not private.stage1_expansion_capture_coverage_valid(
      p_kind, p_metadata
    )
    or pg_catalog.jsonb_typeof(p_metadata -> 'text_object_bytes')
      is distinct from 'number'
    or coalesce(p_metadata ->> 'text_object_bytes', '') !~ '^[1-9][0-9]*$'
    or (case
      when pg_catalog.jsonb_typeof(p_metadata -> 'text_object_bytes') = 'number'
        then (p_metadata ->> 'text_object_bytes')::numeric > v_max_safe_integer
      else false
    end)
    or pg_catalog.jsonb_typeof(p_metadata -> 'text_length')
      is distinct from 'number'
    or coalesce(p_metadata ->> 'text_length', '') !~ '^(0|[1-9][0-9]*)$'
    or (case
      when pg_catalog.jsonb_typeof(p_metadata -> 'text_length') = 'number'
        then (p_metadata ->> 'text_length')::numeric > v_max_safe_integer
      else false
    end)
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
      or (case
        when pg_catalog.jsonb_typeof(binding.value -> 'byte_length') = 'number'
          then (binding.value ->> 'byte_length')::numeric > v_max_safe_integer
        else false
      end)
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
      or (case
        when pg_catalog.jsonb_typeof(p_metadata -> 'page_bytes') = 'number'
          then (p_metadata ->> 'page_bytes')::numeric > v_max_safe_integer
        else false
      end)
      or pg_catalog.jsonb_typeof(p_metadata -> 'thumb_bytes')
        is distinct from 'number'
      or coalesce(p_metadata ->> 'thumb_bytes', '') !~ '^[1-9][0-9]*$'
      or (case
        when pg_catalog.jsonb_typeof(p_metadata -> 'thumb_bytes') = 'number'
          then (p_metadata ->> 'thumb_bytes')::numeric > v_max_safe_integer
        else false
      end)
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
      or (case
        when pg_catalog.jsonb_typeof(p_metadata -> 'file_bytes') = 'number'
          then (p_metadata ->> 'file_bytes')::numeric > v_max_safe_integer
        else false
      end)
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
      or (case
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
      end)
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
    if p_metadata #>> '{retained_artifact_projection,localization_status}'
        is distinct from 'not_applicable_pdf'
      or p_metadata #> '{retained_artifact_projection,authoritative,layout_retained}'
        is distinct from 'false'::jsonb
      or p_metadata #> '{retained_artifact_projection,authoritative,layout_hash}'
        is distinct from 'null'::jsonb
      or p_metadata #>>
        '{retained_artifact_projection,authoritative,expansion_state_count}'
        is distinct from '0'
    then
      return false;
    end if;
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
    or (case
      when pg_catalog.jsonb_typeof(p_metadata -> 'expansion_state_count') = 'number'
        then (p_metadata ->> 'expansion_state_count')::numeric > v_max_safe_integer
      else false
    end)
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

  -- Expansion metadata binds each screenshot to its image hash and byte length,
  -- and each layout to its geometry hash. Every retained object also carries
  -- its own independent raw-byte artifact binding above.
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
      or (case
        when pg_catalog.jsonb_typeof(state.value -> 'page_bytes') = 'number'
          then (state.value ->> 'page_bytes')::numeric > v_max_safe_integer
        else false
      end)
      or pg_catalog.jsonb_typeof(state.value -> 'text_length')
        is distinct from 'number'
      or coalesce(state.value ->> 'text_length', '') !~ '^(0|[1-9][0-9]*)$'
      or (case
        when pg_catalog.jsonb_typeof(state.value -> 'text_length') = 'number'
          then (state.value ->> 'text_length')::numeric > v_max_safe_integer
        else false
      end)
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
      or p_metadata #>> '{retained_artifact_projection,localization_status}'
        is distinct from 'exact_geometry_available'
      or p_metadata #> '{retained_artifact_projection,authoritative,layout_retained}'
        is distinct from 'true'::jsonb
      or p_metadata #>> '{retained_artifact_projection,authoritative,layout_hash}'
        is distinct from p_hashes ->> 'layout_hash'
      or p_metadata #>>
        '{retained_artifact_projection,authoritative,expansion_state_count}'
        is distinct from v_expansion_page_count::text
    then
      return false;
    end if;
  else
    -- A missing main layout is accepted only as explicit, non-contradictory
    -- unavailability. Main-capture geometry/hash claims remain forbidden, but
    -- complete expansion screenshot/layout pairs retain independent authority.
    if nullif(pg_catalog.btrim(coalesce(p_hashes ->> 'layout_hash', '')), '')
        is not null
      or nullif(pg_catalog.btrim(coalesce(p_metadata ->> 'layout_hash', '')), '')
        is not null
      or nullif(pg_catalog.btrim(coalesce(
        p_metadata #>> '{text_geometry,geometry_hash}', ''
      )), '') is not null
      or nullif(pg_catalog.btrim(coalesce(
        p_metadata #>> '{text_geometry,screenshot,image_hash}', ''
      )), '') is not null
      or nullif(pg_catalog.btrim(coalesce(
        p_metadata #>> '{text_geometry,file}', ''
      )), '') is not null
      or nullif(pg_catalog.btrim(coalesce(
        p_metadata #>> '{text_geometry,screenshot,image_ref}', ''
      )), '') is not null
      or (
        p_metadata #> '{text_geometry,node_count}' is not null
        and p_metadata #> '{text_geometry,node_count}' is distinct from
          'null'::jsonb
        and p_metadata #> '{text_geometry,node_count}' <> '0'::jsonb
      )
      or (
        p_metadata #> '{text_geometry,run_count}' is not null
        and p_metadata #> '{text_geometry,run_count}' is distinct from
          'null'::jsonb
        and p_metadata #> '{text_geometry,run_count}' <> '0'::jsonb
      )
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
      or (
        pg_catalog.jsonb_typeof(p_metadata -> 'text_geometry') = 'object'
        and nullif(pg_catalog.btrim(coalesce(
          p_metadata #>> '{text_geometry,unavailable_reason}', ''
        )), '') is null
      )
      or (
        nullif(pg_catalog.btrim(coalesce(
          p_metadata #>> '{text_geometry,availability_status}', ''
        )), '') is not null
        and not coalesce((
          p_metadata #>> '{text_geometry,availability_status}' = 'unavailable'
          or p_metadata #>> '{text_geometry,availability_status}' ~
            '^unavailable_'
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
      or p_metadata #> '{localization,exact}' is distinct from
        'false'::jsonb
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
      or p_metadata #>> '{retained_artifact_projection,localization_status}'
        is distinct from 'evidence_only_geometry_unavailable'
      or p_metadata #> '{retained_artifact_projection,authoritative,layout_retained}'
        is distinct from 'false'::jsonb
      or p_metadata #> '{retained_artifact_projection,authoritative,layout_hash}'
        is distinct from 'null'::jsonb
      or p_metadata #>>
        '{retained_artifact_projection,authoritative,expansion_state_count}'
        is distinct from v_expansion_page_count::text
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
