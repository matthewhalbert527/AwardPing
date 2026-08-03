-- Make a completed Stage 1 verification epoch durable while retaining live fail-closed checks.
--
-- Immutable evidence does not become false merely because 24 hours elapsed. The effective
-- award-level decision still requires every bound source to have a successful check in the
-- previous 24 hours, exact identity/hash bindings to the latest stored snapshot, no future-
-- dated evidence, the latest successful reconciliation, the latest passed deterministic audit,
-- an exact fact ledger, and no actionable quarantine. The national effective-release decision
-- and release-acceptance gate both require a current signed R2 recovery drill every 24 hours;
-- reviewed award promotion does not, avoiding a circular initial-promotion dependency.

create or replace function private.stage1_durable_verification_timestamp_valid(
  p_evidence_at timestamptz,
  p_evaluated_at timestamptz
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    p_evidence_at is not null
      and p_evaluated_at is not null
      and p_evidence_at <= p_evaluated_at + interval '5 minutes',
    false
  );
$$;

revoke all on function private.stage1_durable_verification_timestamp_valid(
  timestamptz, timestamptz
) from public, anon, authenticated, service_role;

create or replace function private.stage1_live_source_check_current(
  p_checked_at timestamptz,
  p_evaluated_at timestamptz
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    p_checked_at is not null
      and p_evaluated_at is not null
      and p_checked_at >= p_evaluated_at - interval '24 hours'
      and p_checked_at <= p_evaluated_at + interval '5 minutes',
    false
  );
$$;

revoke all on function private.stage1_live_source_check_current(
  timestamptz, timestamptz
) from public, anon, authenticated, service_role;

create or replace function private.stage1_safe_timestamptz(
  p_value text
)
returns timestamptz
language plpgsql
stable
set search_path = ''
as $$
begin
  if nullif(pg_catalog.btrim(p_value), '') is null then
    return null;
  end if;
  begin
    return p_value::timestamptz;
  exception when others then
    return null;
  end;
end;
$$;

revoke all on function private.stage1_safe_timestamptz(text)
  from public, anon, authenticated, service_role;

-- A reviewed source binding may point only at one immutable capture generation.
-- Every retained key must stay below that generation; moving /latest/ aliases,
-- mixed source IDs, mixed generations, and incomplete HTML/PDF core sets fail.
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
  v_text_key text;
  v_generation_prefix text;
begin
  if p_source_id is null
    or pg_catalog.jsonb_typeof(p_object_keys) <> 'object'
    or pg_catalog.jsonb_typeof(p_hashes) <> 'object'
    or pg_catalog.jsonb_typeof(p_metadata) <> 'object'
    or coalesce(p_metadata ->> 'text_object_bytes', '') !~ '^[1-9][0-9]*$'
    or coalesce(p_metadata ->> 'text_length', '') !~ '^[0-9]+$' then
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
      or coalesce(p_metadata ->> 'page_bytes', '') !~ '^[1-9][0-9]*$' then
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
      or coalesce(p_metadata ->> 'file_bytes', '') !~ '^[1-9][0-9]*$' then
      return false;
    end if;
    v_generation_prefix := pg_catalog.left(
      v_primary_key,
      pg_catalog.length(v_primary_key) - pg_catalog.length('document.pdf')
    );
  else
    return false;
  end if;

  v_text_key := p_object_keys ->> 'text';
  if v_text_key is distinct from (v_generation_prefix || 'text.txt') then
    return false;
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_each(p_object_keys) object_entry
    where pg_catalog.jsonb_typeof(object_entry.value) <> 'string'
      or pg_catalog.left(
        object_entry.value #>> '{}',
        pg_catalog.length(v_generation_prefix)
      ) is distinct from v_generation_prefix
      or pg_catalog.substr(
        object_entry.value #>> '{}',
        pg_catalog.length(v_generation_prefix) + 1
      ) !~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'
      or object_entry.value #>> '{}' ~* '(^|/)latest(/|$)'
      or case
        when object_entry.key = 'page' then
          object_entry.value #>> '{}' is distinct from
            v_generation_prefix || 'page.jpg'
        when object_entry.key = 'thumb' then
          object_entry.value #>> '{}' is distinct from
            v_generation_prefix || 'thumb.jpg'
        when object_entry.key = 'pdf' then
          object_entry.value #>> '{}' is distinct from
            v_generation_prefix || 'document.pdf'
        when object_entry.key = 'text' then
          object_entry.value #>> '{}' is distinct from
            v_generation_prefix || 'text.txt'
        when object_entry.key = 'layout' then
          object_entry.value #>> '{}' is distinct from
            v_generation_prefix || 'layout.json'
        when object_entry.key = 'meta' then
          object_entry.value #>> '{}' is distinct from
            v_generation_prefix || 'meta.json'
        when object_entry.key ~ '^expansion_state_[0-9]{2}$' then
          object_entry.value #>> '{}' is distinct from
            v_generation_prefix || 'expansion-state-' ||
            pg_catalog.substring(object_entry.key, '[0-9]{2}$') || '.jpg'
        when object_entry.key ~ '^expansion_state_[0-9]{2}_layout$' then
          object_entry.value #>> '{}' is distinct from
            v_generation_prefix || 'expansion-state-' ||
            pg_catalog.substring(object_entry.key, '[0-9]{2}') ||
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

  if p_kind = 'webpage' and exists (
    select 1
    from pg_catalog.jsonb_object_keys(p_object_keys) slot(slot_name)
    where (
      slot.slot_name ~ '^expansion_state_[0-9]{2}$'
      and not (
        p_object_keys ? (slot.slot_name || '_layout')
      )
    ) or (
      slot.slot_name ~ '^expansion_state_[0-9]{2}_layout$'
      and not (
        p_object_keys ? pg_catalog.regexp_replace(
          slot.slot_name, '_layout$', ''
        )
      )
    )
  ) then
    return false;
  end if;

  return true;
end;
$$;

revoke all on function private.stage1_manifest_source_capture_binding_valid(
  uuid, text, jsonb, jsonb, jsonb
) from public, anon, authenticated, service_role;

-- The signed R2 drill covers both published change-event images and the core
-- capture objects that the reviewed source-role manifests bind. Manifest rows
-- are read before promotion and do not depend on publication_state or a prior
-- signed artifact, so initial promotion remains non-circular.
-- The acceptance envelope retains the historical r2_full_get_sha256_v1 label:
-- v1 means a full GetObject followed by the hash_mode declared on each row.
-- raw_sha256 hashes the bytes directly; text mode removes exactly one stored
-- terminal LF/CRLF before comparing the semantic text_hash.
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
      exists (
        select 1
        from public.stage1_award_members member
        join public.shared_award_sources source
          on source.shared_award_id = member.shared_award_id
        where member.cohort_key = manifest.cohort_key
          and source.id = source_id
      )
        and snapshot.shared_award_source_id is not null
        and manifest.evidence #> array[
          'source_bindings', source_id::text, 'object_keys'
        ] = snapshot.latest_object_keys
        and manifest.evidence #> array[
          'source_bindings', source_id::text, 'hashes'
        ] = snapshot.latest_hashes
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
      snapshot.latest_hashes as hashes,
      snapshot.latest_metadata as metadata
    from public.stage1_award_source_manifest manifest
    cross join unnest(manifest.source_ids) source_id
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
      hashes,
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
      artifact.sha256,
      artifact.hash_mode,
      artifact.byte_length,
      artifact.semantic_length,
      artifact.content_type
    from manifest_sources source
    cross join lateral (values
      (
        'page'::text,
        source.object_keys ->> 'page',
        source.hashes ->> 'image_hash',
        'raw_sha256'::text,
        source.metadata ->> 'page_bytes',
        null::text,
        'image/jpeg'::text,
        source.kind = 'webpage'
      ),
      (
        'pdf'::text,
        source.object_keys ->> 'pdf',
        source.hashes ->> 'file_hash',
        'raw_sha256'::text,
        source.metadata ->> 'file_bytes',
        null::text,
        'application/pdf'::text,
        source.kind = 'pdf'
      ),
      (
        'text'::text,
        source.object_keys ->> 'text',
        source.hashes ->> 'text_hash',
        'utf8_text_single_trailing_newline_v1'::text,
        source.metadata ->> 'text_object_bytes',
        source.metadata ->> 'text_length',
        'text/plain; charset=utf-8'::text,
        true
      )
    ) as artifact(
      artifact_name, object_key, sha256, hash_mode, byte_length,
      semantic_length, content_type, included
    )
    where artifact.included
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
              or coalesce(object_row.content_type, '') !~ '^(image/|application/json)'
            when 'manifest_source' then
              object_row.source_id is null
              or object_row.object_key !~ (
                '^visual-snapshots/sources/' || object_row.source_id::text ||
                '/captures/[0-9a-f]{32}/'
              )
              or object_row.object_key ~* '(^|/)latest(/|$)'
              or case object_row.artifact_name
                when 'page' then
                  object_row.object_key !~ '/page[.]jpg$'
                  or object_row.hash_mode <> 'raw_sha256'
                  or object_row.content_type <> 'image/jpeg'
                when 'pdf' then
                  object_row.object_key !~ '/document[.]pdf$'
                  or object_row.hash_mode <> 'raw_sha256'
                  or object_row.content_type <> 'application/pdf'
                when 'text' then
                  object_row.object_key !~ '/text[.]txt$'
                  or object_row.hash_mode <>
                    'utf8_text_single_trailing_newline_v1'
                  or coalesce(object_row.semantic_length, '') !~ '^[0-9]+$'
                  or coalesce(object_row.content_type, '') !~ '^text/plain'
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
    'schema_version', 'awardping.stage1.r2-verification-manifest.v2',
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
  with evaluated as (
    select statement_timestamp() as evaluated_at
  ),
  r2_object_set as (
    select private.stage1_visual_r2_object_set_snapshot() as value
  ),
  r2_release_proof as (
    select exists (
      select 1
      from private.stage1_current_valid_release_artifact(
        'r2_recovery_drill', evaluated.evaluated_at
      ) artifact
      where r2_object_set.value ->> 'unexpected_bucket_count' = '0'
        and r2_object_set.value ->> 'malformed_object_count' = '0'
        and r2_object_set.value ->> 'manifest_binding_error_count' = '0'
        and artifact.evidence ->> 'visual_object_set_hash' =
          r2_object_set.value ->> 'visual_object_set_hash'
        and artifact.evidence ->> 'visual_objects_checked' =
          r2_object_set.value ->> 'visual_object_count'
        and artifact.evidence ->> 'published_event_objects_checked' =
          r2_object_set.value ->> 'published_event_object_count'
        and artifact.evidence ->> 'manifest_source_objects_checked' =
          r2_object_set.value ->> 'manifest_source_object_count'
    ) as current
    from evaluated
    cross join r2_object_set
  ),
  identity_payload as (
    select
      count(*) as cohort_count,
      public.stage1_publication_evidence_hash(pg_catalog.to_jsonb(
        pg_catalog.string_agg(
          pg_catalog.concat_ws(
            '|',
            registry.launch_rank::text,
            registry.cohort_key,
            registry.canonical_name,
            registry.canonical_shared_award_id::text,
            registry.canonical_slug,
            registry.official_homepage
          ),
          E'\n'
          order by registry.launch_rank
        )
      )) as identity_hash
    from public.stage1_award_registry registry
  ),
  cohort_reasons as (
    select
      registry.launch_rank,
      registry.cohort_key,
      registry.release_epoch as registry_release_epoch,
      reason.value as readiness_reason
    from public.stage1_award_registry registry
    cross join evaluated
    cross join lateral (
      select public.stage1_effective_publication_reason(
        registry.cohort_key,
        evaluated.evaluated_at
      ) as value
    ) reason
  ),
  release_decision as (
    select
      release_state.*,
      evaluated.evaluated_at,
      r2_release_proof.current,
      identity_payload.cohort_count,
      identity_payload.identity_hash,
      count(*) filter (where cohort_reasons.readiness_reason = 'verified') as ready_count,
      count(*) filter (
        where cohort_reasons.registry_release_epoch is distinct from release_state.release_epoch
      ) as epoch_mismatch_count,
      case
        when identity_payload.cohort_count <> 25
          or identity_payload.identity_hash <> '60261d07d5918554d0fb0b4ab895dbef3d57973f0a5b8d277ad0b128611d801e'
          or release_state.cohort_identity_version <> 'stage1-national-25-v1'
          or release_state.cohort_identity_hash <> identity_payload.identity_hash
          or release_state.policy_version <> 'stage1-publication-v1'
          then 'cohort_release_identity_mismatch'
        when not r2_release_proof.current
          then 'signed_r2_recovery_artifact_not_current'
        when release_state.release_state <> 'verified_beta'
          then 'cohort_release_not_activated'
        when count(*) filter (where cohort_reasons.readiness_reason = 'verified') <> 25
          then 'cohort_release_not_ready'
        when release_state.release_epoch is null
          or count(*) filter (
            where cohort_reasons.registry_release_epoch is distinct from release_state.release_epoch
          ) <> 0
          then 'cohort_release_epoch_mismatch'
        else 'verified'
      end as decision_reason
    from public.stage1_publication_release_state release_state
    cross join evaluated
    cross join r2_release_proof
    cross join identity_payload
    cross join cohort_reasons
    where release_state.release_key = 'stage1-national-25'
    group by
      release_state.release_key,
      release_state.release_state,
      release_state.release_epoch,
      release_state.reason,
      release_state.policy_version,
      release_state.cohort_identity_version,
      release_state.cohort_identity_hash,
      release_state.activated_at,
      release_state.updated_at,
      evaluated.evaluated_at,
      r2_release_proof.current,
      identity_payload.cohort_count,
      identity_payload.identity_hash
  )
  select
    cohort_reasons.cohort_key,
    release_decision.decision_reason = 'verified' as effectively_verified,
    release_decision.decision_reason as effective_reason,
    release_decision.evaluated_at,
    cohort_reasons.readiness_reason = 'verified' as cohort_ready,
    cohort_reasons.readiness_reason as cohort_readiness_reason,
    release_decision.release_epoch,
    release_decision.release_state,
    release_decision.policy_version as release_policy_version,
    release_decision.cohort_identity_version as release_identity_version,
    release_decision.cohort_identity_hash as release_identity_hash
  from cohort_reasons
  cross join release_decision
  order by cohort_reasons.launch_rank;
$$;

revoke all on function public.list_stage1_effective_publication()
  from public, anon, authenticated, service_role;
grant execute on function public.list_stage1_effective_publication()
  to service_role;

comment on function public.list_stage1_effective_publication() is
  'Authoritative national Stage 1 publication decision. Award readiness remains durable, while public visibility dynamically requires the current signed R2 recovery proof and one exact atomic 25-award release epoch.';

create or replace function public.stage1_effective_publication_reason(
  p_cohort_key text,
  p_evaluated_at timestamptz default now()
)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_registry public.stage1_award_registry%rowtype;
  v_latest_reconciliation public.shared_award_reconciliation_queue%rowtype;
  v_latest_audit public.shared_award_page_audits%rowtype;
  v_public_fact_count integer;
  v_ledger_count integer;
begin
  -- This function is service-only. Even an internal caller cannot move the
  -- evaluation clock forward to legitimize future-dated evidence.
  if p_evaluated_at is null
    or p_evaluated_at > pg_catalog.statement_timestamp() + interval '5 minutes' then
    return 'evaluation_time_invalid';
  end if;

  select * into v_registry
  from public.stage1_award_registry registry
  where registry.cohort_key = p_cohort_key;

  if not found then return 'registry_missing'; end if;
  if v_registry.publication_state <> 'verified_beta' then
    return 'state_' || v_registry.publication_state;
  end if;
  if v_registry.policy_version <> 'stage1-publication-v1' then
    return 'policy_version_mismatch';
  end if;
  if not private.stage1_durable_verification_timestamp_valid(
    v_registry.evidence_checked_at, p_evaluated_at
  ) or not private.stage1_durable_verification_timestamp_valid(
    v_registry.last_verified_at, p_evaluated_at
  ) then
    return 'registry_evidence_stale';
  end if;
  if not exists (
    select 1
    from public.shared_awards award
    where award.id = v_registry.canonical_shared_award_id
      and award.status = 'active'
      and award.name = v_registry.canonical_name
      and award.slug = v_registry.canonical_slug
      and award.official_homepage = v_registry.official_homepage
  ) then
    return 'canonical_award_identity_changed_or_inactive';
  end if;

  if (
    select count(*)
    from public.stage1_award_source_manifest manifest
    where manifest.cohort_key = p_cohort_key
      and private.stage1_durable_verification_timestamp_valid(
        manifest.checked_at, p_evaluated_at
      )
      and private.stage1_durable_verification_timestamp_valid(
        private.stage1_safe_timestamptz(
          manifest.evidence ->> 'r2_verified_at'
        ),
        p_evaluated_at
      )
      and private.stage1_durable_verification_timestamp_valid(
        private.stage1_safe_timestamptz(
          manifest.evidence ->> 'local_verified_at'
        ),
        p_evaluated_at
      )
      and manifest.policy_version = v_registry.policy_version
      and public.stage1_manifest_evidence_complete(
        manifest.manifest_status,
        manifest.evidence,
        v_registry.policy_version
      )
  ) <> 8 then
    return 'source_manifest_incomplete_or_stale';
  end if;

  if not exists (
    select 1
    from public.stage1_award_source_manifest manifest
    join public.shared_award_sources source
      on cardinality(manifest.source_ids) = 1
      and source.id = manifest.source_ids[1]
    where manifest.cohort_key = p_cohort_key
      and manifest.source_role = 'identity_home'
      and manifest.manifest_status in ('present', 'combined')
      and source.url = v_registry.official_homepage
      and manifest.evidence ->> 'source_url' = v_registry.official_homepage
      and manifest.evidence #>> array[
        'source_bindings', source.id::text, 'source_url'
      ] = v_registry.official_homepage
  ) then
    return 'identity_home_not_allowlisted';
  end if;

  if exists (
    select 1
    from public.stage1_award_source_manifest manifest
    cross join unnest(manifest.source_ids) source_id
    left join public.shared_award_sources source on source.id = source_id
    left join public.shared_award_source_visual_snapshots snapshot
      on snapshot.shared_award_source_id = source.id
    left join public.stage1_award_members member
      on member.shared_award_id = source.shared_award_id
      and member.cohort_key = p_cohort_key
    where manifest.cohort_key = p_cohort_key
      and (
        source.id is null
        or member.shared_award_id is null
        or source.admin_review_status <> 'open'
        or not private.stage1_live_source_check_current(
          source.last_checked_at, p_evaluated_at
        )
        or nullif(pg_catalog.btrim(source.last_error), '') is not null
        or exists (
          select 1
          from public.stage1_award_source_identity_rules identity_rule
          where identity_rule.cohort_key = p_cohort_key
            and (
              (
                identity_rule.url_pattern is not null
                and source.url ~* identity_rule.url_pattern
              )
              or (
                identity_rule.title_pattern is not null
                and concat_ws(' ', source.title, source.display_title) ~*
                  identity_rule.title_pattern
              )
            )
        )
        or snapshot.shared_award_source_id is null
        or not private.stage1_durable_verification_timestamp_valid(
          snapshot.latest_captured_at, p_evaluated_at
        )
        or snapshot.latest_object_keys = '{}'::jsonb
        or snapshot.latest_hashes = '{}'::jsonb
        or not private.stage1_manifest_source_capture_binding_valid(
          source.id,
          snapshot.kind,
          snapshot.latest_object_keys,
          snapshot.latest_hashes,
          snapshot.latest_metadata
        )
        or manifest.evidence #>> array['source_bindings', source_id::text, 'source_url']
          is distinct from source.url
        or manifest.evidence #> array['source_bindings', source_id::text, 'object_keys']
          is distinct from snapshot.latest_object_keys
        or manifest.evidence #> array['source_bindings', source_id::text, 'hashes']
          is distinct from snapshot.latest_hashes
        or manifest.evidence #> array['source_bindings', source_id::text, 'r2_hashes']
          is distinct from snapshot.latest_hashes
        or manifest.evidence #> array['source_bindings', source_id::text, 'local_hashes']
          is distinct from snapshot.latest_hashes
        or private.stage1_safe_timestamptz(
          manifest.evidence #>> array['source_bindings', source_id::text, 'captured_at']
        ) is distinct from snapshot.latest_captured_at
      )
  ) then
    return 'source_or_snapshot_identity_invalid';
  end if;

  if exists (
    select 1
    from public.stage1_award_source_manifest manifest
    cross join lateral (
      select case
        when raw.candidate_id_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        then raw.candidate_id_text::uuid
        else null
      end as candidate_id
      from pg_catalog.jsonb_array_elements_text(
        manifest.evidence -> 'fact_candidate_ids'
      ) raw(candidate_id_text)
    ) requested
    left join public.shared_award_fact_candidates candidate
      on candidate.id = requested.candidate_id
    left join public.shared_award_sources candidate_source
      on candidate_source.id = candidate.shared_award_source_id
    left join public.stage1_award_members candidate_member
      on candidate_member.shared_award_id = candidate.shared_award_id
      and candidate_member.cohort_key = p_cohort_key
    where manifest.cohort_key = p_cohort_key
      and manifest.manifest_status in ('present', 'combined')
      and (
        requested.candidate_id is null
        or candidate.id is null
        or candidate.candidate_status <> 'selected'
        or candidate_member.shared_award_id is null
        or candidate.shared_award_source_id is null
        or not (candidate.shared_award_source_id = any(manifest.source_ids))
        or candidate_source.id is null
        or candidate_source.shared_award_id <> candidate.shared_award_id
        or manifest.evidence #>> array[
          'candidate_bindings', candidate.id::text, 'source_id'
        ] is distinct from candidate.shared_award_source_id::text
        or manifest.evidence #>> array[
          'candidate_bindings', candidate.id::text, 'candidate_source_role'
        ] is distinct from candidate.source_role
        or manifest.evidence #>> array[
          'candidate_bindings', candidate.id::text, 'source_role'
        ] is distinct from manifest.source_role
        or manifest.evidence #>> array[
          'candidate_bindings', candidate.id::text, 'field_name'
        ] is distinct from candidate.field_name
        or manifest.evidence #> array[
          'candidate_bindings', candidate.id::text, 'normalized_value'
        ] is distinct from candidate.normalized_value
        or manifest.evidence #>> array[
          'candidate_bindings', candidate.id::text, 'evidence_quote'
        ] is distinct from candidate.evidence_quote
        or manifest.evidence #>> array[
          'candidate_bindings', candidate.id::text, 'evidence_location'
        ] is distinct from candidate.evidence_location
        or manifest.evidence #>> array[
          'candidate_bindings', candidate.id::text, 'intake_value_sha256'
        ] is distinct from candidate.intake_value_sha256
      )
  ) then
    return 'fact_candidate_binding_invalid';
  end if;

  if exists (
    select 1
    from public.manual_quarantine_registry quarantine
    left join public.shared_award_sources quarantine_source
      on quarantine_source.id = quarantine.shared_award_source_id
    join public.stage1_award_members member
      on member.shared_award_id = coalesce(
        quarantine.shared_award_id,
        quarantine_source.shared_award_id
      )
    where member.cohort_key = p_cohort_key
      and quarantine.classification = 'actionable_quarantine'
      and quarantine.status in ('quarantined', 'in_review')
  ) then
    return 'actionable_quarantine_open';
  end if;

  if exists (
    select 1
    from public.shared_award_page_audits audit
    join public.stage1_award_members member
      on member.shared_award_id = audit.shared_award_id
    where member.cohort_key = p_cohort_key
      and audit.resolved_at is null
      and (
        audit.audit_status in ('failed', 'needs_review')
        or audit.severity = 'critical'
      )
  ) then
    return 'page_audit_failure_open';
  end if;

  select * into v_latest_reconciliation
  from public.shared_award_reconciliation_queue queue
  where queue.shared_award_id = v_registry.canonical_shared_award_id
  order by queue.created_at desc, queue.id desc
  limit 1;
  if not found
    or v_latest_reconciliation.status <> 'succeeded'
    or not private.stage1_durable_verification_timestamp_valid(
      v_latest_reconciliation.completed_at, p_evaluated_at
    )
    or v_latest_reconciliation.source_ids is null
    or v_latest_reconciliation.candidate_ids is null then
    return 'canonical_reconciliation_not_fresh_success';
  end if;

  -- Reconciliation source_ids are exact fact contributors. A reviewed manifest
  -- may additionally retain monitor-only evidence (including not_published
  -- roles), which is validated above but must not become fact provenance.
  if exists (
    select 1
    from unnest(v_latest_reconciliation.source_ids) source_id
    left join public.shared_award_sources source on source.id = source_id
    left join public.stage1_award_members member
      on member.shared_award_id = source.shared_award_id
      and member.cohort_key = p_cohort_key
    where source.id is null
      or member.shared_award_id is null
      or not exists (
        select 1
        from public.stage1_award_source_manifest manifest
        where manifest.cohort_key = p_cohort_key
          and source_id = any(manifest.source_ids)
      )
      or not exists (
        select 1
        from public.shared_award_fact_candidates contributor
        join public.stage1_award_source_manifest manifest
          on manifest.cohort_key = p_cohort_key
          and source_id = any(manifest.source_ids)
          and (manifest.evidence -> 'fact_candidate_ids') ? contributor.id::text
        where contributor.id = any(v_latest_reconciliation.candidate_ids)
          and contributor.shared_award_source_id = source_id
      )
  ) or exists (
    select 1
    from public.stage1_award_source_manifest manifest
    cross join lateral (
      select case
        when raw.value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        then raw.value::uuid
        else null
      end as candidate_id
      from pg_catalog.jsonb_array_elements_text(
        manifest.evidence -> 'fact_candidate_ids'
      ) raw(value)
    ) manifest_candidate
    where manifest.cohort_key = p_cohort_key
      and (
        manifest_candidate.candidate_id is null
        or not (
          manifest_candidate.candidate_id = any(v_latest_reconciliation.candidate_ids)
        )
      )
  ) or exists (
    select 1
    from unnest(v_latest_reconciliation.candidate_ids) candidate_id
    left join public.shared_award_fact_candidates candidate
      on candidate.id = candidate_id
    left join public.shared_award_sources source
      on source.id = candidate.shared_award_source_id
    left join public.stage1_award_members member
      on member.shared_award_id = candidate.shared_award_id
      and member.cohort_key = p_cohort_key
    where candidate.id is null
      or candidate.candidate_status <> 'selected'
      or member.shared_award_id is null
      or source.id is null
      or source.shared_award_id <> candidate.shared_award_id
      or not (source.id = any(v_latest_reconciliation.source_ids))
      or not exists (
        select 1
        from public.stage1_award_source_manifest manifest
        where manifest.cohort_key = p_cohort_key
          and source.id = any(manifest.source_ids)
          and (manifest.evidence -> 'fact_candidate_ids') ? candidate.id::text
      )
  ) then
    return 'canonical_reconciliation_identity_set_mismatch';
  end if;

  select * into v_latest_audit
  from public.shared_award_page_audits audit
  where audit.shared_award_id = v_registry.canonical_shared_award_id
    and audit.audit_kind = 'deterministic'
  order by audit.created_at desc, audit.id desc
  limit 1;
  if not found
    or v_latest_audit.audit_status <> 'passed'
    or not private.stage1_durable_verification_timestamp_valid(
      v_latest_audit.created_at, p_evaluated_at
    ) then
    return 'canonical_page_audit_not_fresh_pass';
  end if;

  if v_registry.fact_ledger_batch_id is null then
    return 'fact_ledger_missing';
  end if;

  select count(*)
  into v_public_fact_count
  from public.shared_awards award
  cross join lateral pg_catalog.jsonb_each(award.public_facts) fact
  where award.id = v_registry.canonical_shared_award_id
    and fact.key in (
      'overview',
      'deadline',
      'opening_date',
      'award_amounts',
      'eligibility',
      'requirements',
      'application_materials',
      'how_to_apply',
      'important_dates',
      'documents',
      'contacts',
      'academic_levels',
      'disciplines',
      'citizenship',
      'confidence'
    )
    and fact.value not in (
      'null'::jsonb,
      '""'::jsonb,
      '[]'::jsonb,
      '{}'::jsonb
    );

  select count(*)
  into v_ledger_count
  from public.stage1_award_fact_publication_ledger ledger
  where ledger.cohort_key = p_cohort_key
    and ledger.verification_batch_id = v_registry.fact_ledger_batch_id;

  if v_public_fact_count = 0 or v_ledger_count <> v_public_fact_count then
    return 'fact_ledger_field_count_mismatch';
  end if;

  if not exists (
    select 1
    from public.stage1_award_fact_publication_ledger ledger
    where ledger.cohort_key = p_cohort_key
      and ledger.verification_batch_id = v_registry.fact_ledger_batch_id
      and ledger.field_name = 'overview'
  ) then
    return 'fact_ledger_overview_missing';
  end if;

  if exists (
    select 1
    from public.stage1_award_fact_publication_ledger ledger
    left join public.shared_award_fact_candidates candidate
      on candidate.id = ledger.candidate_id
    left join public.stage1_award_reconciled_fact_evidence materialization
      on materialization.id = ledger.materialization_id
    left join public.shared_award_sources source
      on source.id = ledger.source_id
    left join public.stage1_award_members candidate_member
      on candidate_member.shared_award_id = candidate.shared_award_id
      and candidate_member.cohort_key = p_cohort_key
    left join public.shared_award_source_visual_snapshots snapshot
      on snapshot.shared_award_source_id = ledger.source_id
    left join public.shared_awards award
      on award.id = v_registry.canonical_shared_award_id
    where ledger.cohort_key = p_cohort_key
      and ledger.verification_batch_id = v_registry.fact_ledger_batch_id
      and (
        ledger.policy_version <> v_registry.policy_version
        or ledger.reconciliation_id <> v_latest_reconciliation.id
        or ledger.page_audit_id <> v_latest_audit.id
        or v_latest_reconciliation.candidate_ids is null
        or not (ledger.candidate_id = any(v_latest_reconciliation.candidate_ids))
        or v_latest_reconciliation.source_ids is null
        or not (ledger.source_id = any(v_latest_reconciliation.source_ids))
        or v_latest_audit.public_page_snapshot -> ledger.field_name
          is distinct from ledger.public_value
        or candidate.id is null
        or materialization.id is null
        or materialization.shared_award_id <> v_registry.canonical_shared_award_id
        or materialization.reconciliation_id <> v_latest_reconciliation.id
        or materialization.field_name <> ledger.field_name
        or materialization.public_value <> ledger.public_value
        or materialization.candidate_ids <> ledger.contributing_candidate_ids
        or materialization.source_ids <> ledger.contributing_source_ids
        or materialization.evidence_hash <>
          public.stage1_publication_evidence_hash(materialization.evidence)
        or materialization.evidence -> 'public_value' <> ledger.public_value
        or materialization.evidence -> 'candidate_ids' <>
          pg_catalog.to_jsonb(materialization.candidate_ids)
        or materialization.evidence -> 'source_ids' <>
          pg_catalog.to_jsonb(materialization.source_ids)
        or exists (
          select 1
          from unnest(ledger.contributing_candidate_ids) contributor_id
          left join public.shared_award_fact_candidates contributor
            on contributor.id = contributor_id
          left join public.shared_award_sources contributor_source
            on contributor_source.id = contributor.shared_award_source_id
          left join public.stage1_award_members contributor_member
            on contributor_member.shared_award_id = contributor.shared_award_id
            and contributor_member.cohort_key = p_cohort_key
          where contributor.id is null
            or contributor.candidate_status <> 'selected'
            or contributor_member.shared_award_id is null
            or contributor_source.id is null
            or contributor_source.shared_award_id <> contributor.shared_award_id
            or not (contributor_source.id = any(ledger.contributing_source_ids))
            or not (contributor.id = any(v_latest_reconciliation.candidate_ids))
            or not (contributor_source.id = any(v_latest_reconciliation.source_ids))
            or materialization.evidence #>> array[
              'candidate_bindings', contributor.id::text, 'source_id'
            ] is distinct from contributor.shared_award_source_id::text
            or materialization.evidence #>> array[
              'candidate_bindings', contributor.id::text, 'field_name'
            ] is distinct from contributor.field_name
            or materialization.evidence #> array[
              'candidate_bindings', contributor.id::text, 'normalized_value'
            ] is distinct from contributor.normalized_value
            or materialization.evidence #>> array[
              'candidate_bindings', contributor.id::text, 'evidence_quote'
            ] is distinct from contributor.evidence_quote
            or materialization.evidence #>> array[
              'candidate_bindings', contributor.id::text, 'evidence_location'
            ] is distinct from contributor.evidence_location
            or materialization.evidence #>> array[
              'candidate_bindings', contributor.id::text, 'intake_value_sha256'
            ] is distinct from contributor.intake_value_sha256
        )
        or candidate_member.shared_award_id is null
        or source.id is null
        or source.shared_award_id <> candidate.shared_award_id
        or source.url <> ledger.source_url
        or snapshot.shared_award_source_id is null
        or snapshot.latest_hashes is distinct from ledger.source_snapshot_hashes
        or snapshot.latest_captured_at is distinct from ledger.source_captured_at
        or candidate.candidate_status <> 'selected'
        or candidate.shared_award_source_id <> ledger.source_id
        or ledger.normalized_value <> ledger.public_value
        or award.public_facts -> ledger.field_name is distinct from ledger.public_value
        or not exists (
          select 1
          from public.stage1_award_source_manifest manifest
          where manifest.cohort_key = p_cohort_key
            and manifest.source_role = ledger.source_role
            and ledger.source_id = any(manifest.source_ids)
            and (manifest.evidence -> 'fact_candidate_ids') ? ledger.candidate_id::text
            and manifest.evidence #>> array[
              'candidate_bindings', ledger.candidate_id::text, 'candidate_source_role'
            ] is not distinct from candidate.source_role
            and manifest.evidence #>> array[
              'candidate_bindings', ledger.candidate_id::text, 'evidence_quote'
            ] = ledger.supporting_text
            and manifest.evidence #>> array[
              'candidate_bindings', ledger.candidate_id::text, 'evidence_location'
            ] is not distinct from candidate.evidence_location
            and manifest.evidence #>> array[
              'candidate_bindings', ledger.candidate_id::text, 'intake_value_sha256'
            ] is not distinct from candidate.intake_value_sha256
            and manifest.evidence #>> array[
              'source_bindings',
              ledger.source_id::text,
              'source_url'
            ] = ledger.source_url
            and manifest.evidence #> array[
              'source_bindings',
              ledger.source_id::text,
              'hashes'
            ] = ledger.source_snapshot_hashes
            and private.stage1_safe_timestamptz(
              manifest.evidence #>> array[
                'source_bindings',
                ledger.source_id::text,
                'captured_at'
              ]
            ) = ledger.source_captured_at
        )
      )
  ) then
    return 'fact_ledger_binding_invalid';
  end if;

  return 'verified';
end;
$$;

revoke all on function public.stage1_effective_publication_reason(text, timestamptz)
  from public, anon, authenticated, service_role;

comment on function public.stage1_effective_publication_reason(text, timestamptz) is
  'Fail-closed Stage 1 award-readiness decision. Immutable verification epochs remain valid while live source checks, exact latest snapshot/candidate/reconciliation/audit/ledger identity, future-date fences, and quarantine remain healthy. National effective release separately requires the daily signed R2 proof.';
