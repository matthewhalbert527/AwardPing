-- Bind every published-event recovery row to the exact candidate, side, role,
-- MIME, content-addressed filename, and extension emitted by
-- scripts/lib/visual-event-evidence.mjs. This admits legitimate full PDF
-- documents while rejecting cross-role or unbound image/JSON/PDF objects.

create or replace function private.stage1_published_event_r2_object_binding_valid(
  p_source_id uuid,
  p_candidate_id uuid,
  p_side_name text,
  p_artifact_name text,
  p_object_key text,
  p_sha256 text,
  p_hash_mode text,
  p_byte_length text,
  p_semantic_length text,
  p_content_type text
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    p_source_id is null
      and p_candidate_id is not null
      and coalesce(p_side_name, '') in ('previous', 'current')
      and coalesce(p_object_key, '') !~* '(^|/)latest(/|$)'
      and coalesce(p_sha256, '') ~ '^[0-9a-f]{64}$'
      and coalesce(p_byte_length, '') ~ '^[1-9][0-9]*$'
      and coalesce(p_hash_mode, '') = 'raw_sha256'
      and p_semantic_length is null
      and (
        (
          coalesce(p_artifact_name, '') = 'full'
          and (
            (
              coalesce(p_content_type, '') = 'application/pdf'
              and coalesce(p_object_key, '') ~ (
                '^visual-snapshots/published/' || p_candidate_id::text || '/' ||
                coalesce(p_side_name, '') || '/document/' ||
                coalesce(p_sha256, '') || '[.]pdf$'
              )
            )
            or (
              coalesce(p_content_type, '') = 'image/jpeg'
              and coalesce(p_object_key, '') ~ (
                '^visual-snapshots/published/' || p_candidate_id::text || '/' ||
                coalesce(p_side_name, '') ||
                '/(main-full|state-[A-Za-z0-9._-]+)/' ||
                coalesce(p_sha256, '') || '[.]jpg$'
              )
            )
          )
        )
        or (
          coalesce(p_artifact_name, '') = 'crop'
          and coalesce(p_content_type, '') = 'image/jpeg'
          and coalesce(p_object_key, '') ~ (
            '^visual-snapshots/published/' || p_candidate_id::text || '/' ||
            coalesce(p_side_name, '') || '/changed-section-crop/' ||
            coalesce(p_sha256, '') || '[.]jpg$'
          )
        )
        or (
          coalesce(p_artifact_name, '') = 'layout'
          and coalesce(p_content_type, '') =
            'application/json; charset=utf-8'
          and coalesce(p_object_key, '') ~ (
            '^visual-snapshots/published/' || p_candidate_id::text || '/' ||
            coalesce(p_side_name, '') || '/geometry-[A-Za-z0-9._-]+/' ||
            coalesce(p_sha256, '') || '[.]json$'
          )
        )
        or (
          coalesce(p_artifact_name, '') = 'metadata'
          and coalesce(p_content_type, '') =
            'application/json; charset=utf-8'
          and (
            coalesce(p_object_key, '') ~ (
              '^visual-snapshots/published/' || p_candidate_id::text || '/' ||
              coalesce(p_side_name, '') || '/(metadata|recovery-metadata)/' ||
              coalesce(p_sha256, '') || '[.]json$'
            )
            or (
              coalesce(p_side_name, '') = 'previous'
              and coalesce(p_object_key, '') ~ (
                '^visual-snapshots/published/' || p_candidate_id::text ||
                '/previous/first-observation-attestation/' ||
                coalesce(p_sha256, '') || '[.]json$'
              )
            )
          )
        )
      ),
    false
  );
$$;

revoke all on function private.stage1_published_event_r2_object_binding_valid(
  uuid, uuid, text, text, text, text, text, text, text, text
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
      event.visual_review_candidate_id as published_candidate_id
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
      event.published_candidate_id as candidate_id,
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
    where artifact.value is not null
      and pg_catalog.jsonb_typeof(artifact.value) is distinct from 'null'
  ), event_object_rows as (
    select
      event.bucket,
      'published_event'::text as object_scope,
      null::uuid as source_id,
      event.candidate_id,
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
      ] as content_type
    from manifest_sources source
    cross join lateral pg_catalog.jsonb_each_text(source.object_keys)
      artifact(artifact_name, object_key)
  ), object_rows as (
    select * from event_object_rows
    union all
    select * from manifest_object_rows
  ), duplicate_object_keys as (
    select
      object_row.bucket,
      object_row.object_key,
      pg_catalog.count(*) as reuse_count
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
          object_row.candidate_id,
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
              not private.stage1_published_event_r2_object_binding_valid(
                object_row.source_id,
                object_row.candidate_id,
                object_row.side_name,
                object_row.artifact_name,
                object_row.object_key,
                object_row.sha256,
                object_row.hash_mode,
                object_row.byte_length,
                object_row.semantic_length,
                object_row.content_type
              )
            when 'manifest_source' then
              object_row.source_id is null
              or object_row.candidate_id is not null
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
    'duplicate_object_key_count',
      object_key_quality.duplicate_object_key_count,
    'visual_object_set_hash', public.stage1_publication_evidence_hash(
      object_payload.value
    ),
    'unexpected_bucket_count', object_quality.unexpected_bucket_count,
    'malformed_object_count',
      object_quality.malformed_object_count +
      manifest_binding_quality.error_count +
      object_key_quality.duplicate_object_key_count,
    'manifest_binding_error_count', manifest_binding_quality.error_count,
    'objects', object_payload.value
  )
  from object_payload
  cross join object_quality
  cross join manifest_binding_quality
  cross join object_key_quality;
$$;

revoke all on function private.stage1_visual_r2_object_set_snapshot()
  from public, anon, authenticated, service_role;

-- The public service-role wrapper enumerates snapshot fields explicitly, so
-- carry the duplicate-key counter through the v3 manifest as a required
-- fail-closed quality signal. CREATE OR REPLACE preserves its existing ACL.
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
    'duplicate_object_key_count',
      v_manifest -> 'duplicate_object_key_count',
    'visual_object_set_hash', v_manifest -> 'visual_object_set_hash',
    'unexpected_bucket_count', v_manifest -> 'unexpected_bucket_count',
    'malformed_object_count', v_manifest -> 'malformed_object_count',
    'manifest_binding_error_count',
      v_manifest -> 'manifest_binding_error_count',
    'objects', v_manifest -> 'objects'
  );
end;
$$;
