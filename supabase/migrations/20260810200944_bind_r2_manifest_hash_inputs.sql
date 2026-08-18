-- Hosted migration ledger version: 20260810200944.
-- Bind the v4 producer's checked object/reference payloads to the exact
-- PostgreSQL jsonb text used for the authoritative database hashes. Also make
-- the published-event PDF role set exact by refusing webpage thumbnails.

do $migration$
declare
  v_definition text;
  v_old text := $old$
      or pg_catalog.jsonb_typeof(p_capture -> 'crop') = 'object'
      or pg_catalog.jsonb_typeof(p_capture -> 'attestation') = 'object' then
$old$;
  v_new text := $new$
      or pg_catalog.jsonb_typeof(p_capture -> 'crop') = 'object'
      or pg_catalog.jsonb_typeof(p_capture -> 'thumbnail') = 'object'
      or pg_catalog.jsonb_typeof(p_capture -> 'attestation') = 'object' then
$new$;
begin
  select pg_catalog.pg_get_functiondef(
    pg_catalog.to_regprocedure(
      'private.stage1_published_capture_reference_graph_valid(jsonb)'
    )
  ) into v_definition;
  if v_definition is null then
    raise exception using errcode = '55000',
      message = 'The published-capture graph validator is missing.';
  end if;
  if pg_catalog.strpos(v_definition, v_new) > 0 then
    null;
  elsif pg_catalog.strpos(v_definition, v_old) > 0 then
    execute pg_catalog.replace(v_definition, v_old, v_new);
  else
    raise exception using errcode = '55000',
      message = 'The published-capture PDF contract could not be tightened safely.';
  end if;
end;
$migration$;

revoke all on function private.stage1_published_capture_reference_graph_valid(jsonb)
  from public, anon, authenticated, service_role;

create or replace function private.stage1_r2_reference_set_hash_input(
  p_objects jsonb
)
returns text
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'bucket', object_row.value -> 'bucket',
        'object_key', object_row.value -> 'object_key',
        'reference', logical_reference.value
      ) order by object_row.ordinality, logical_reference.ordinality
    ),
    '[]'::jsonb
  )::text
  from pg_catalog.jsonb_array_elements(
    case
      when pg_catalog.jsonb_typeof(p_objects) = 'array' then p_objects
      else '[]'::jsonb
    end
  ) with ordinality object_row(value, ordinality)
  cross join lateral pg_catalog.jsonb_array_elements(
    case
      when pg_catalog.jsonb_typeof(object_row.value -> 'references') = 'array'
        then object_row.value -> 'references'
      else '[]'::jsonb
    end
  ) with ordinality logical_reference(value, ordinality);
$$;

revoke all on function private.stage1_r2_reference_set_hash_input(jsonb)
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
  v_reference_hash_input text := private.stage1_r2_reference_set_hash_input(
    v_manifest -> 'objects'
  );
  v_object_hash_input text := (v_manifest -> 'objects')::text;
begin
  if v_target ->> 'configured' <> 'true' then
    raise exception using errcode = '55000',
      message = 'The administrator-owned production target is not configured.';
  end if;
  if public.stage1_publication_evidence_hash(v_reference_hash_input::jsonb)
      is distinct from v_manifest ->> 'reference_set_hash'
    or public.stage1_publication_evidence_hash(v_object_hash_input::jsonb)
      is distinct from v_manifest ->> 'visual_object_set_hash' then
    raise exception using errcode = '55000',
      message = 'The canonical R2 hash inputs do not match the live object graph.';
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
    'reference_set_hash_input', v_reference_hash_input,
    'visual_object_set_hash', v_manifest -> 'visual_object_set_hash',
    'visual_object_set_hash_input', v_object_hash_input,
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
  'Service-role-only v4 manifest with canonical PostgreSQL hash inputs for every physical object and logical reference.';
