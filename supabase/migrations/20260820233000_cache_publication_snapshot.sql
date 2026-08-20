-- get_stage1_publication_snapshot canonical-hashes the full multi-megabyte
-- snapshot on every call (~24s once the first promoted cohort's manifest
-- evidence landed), which timed out every award-page load at the PostgREST
-- statement limit. Computation unchanged (moved verbatim to
-- private.stage1_publication_snapshot_compute); the public function serves a
-- 60-second cache invalidated whenever any stage1_award_registry row changes.
CREATE OR REPLACE FUNCTION private.stage1_publication_snapshot_compute()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with evaluated as (
    select statement_timestamp() as evaluated_at
  ),
  identity_payload as (
    select pg_catalog.string_agg(
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
    ) as value
    from public.stage1_award_registry registry
  ),
  effective_rows as (
    select * from public.list_stage1_effective_publication()
  ),
  cohort_rows as (
    select
      registry.launch_rank,
      pg_catalog.jsonb_build_object(
        'registry', pg_catalog.to_jsonb(registry),
        'effectively_verified', effective.effectively_verified,
        'effective_reason', effective.effective_reason,
        'cohort_ready', effective.cohort_ready,
        'cohort_readiness_reason', effective.cohort_readiness_reason,
        'evaluated_at', effective.evaluated_at,
        'members', coalesce((
          select pg_catalog.jsonb_agg(
            pg_catalog.to_jsonb(member)
            order by member.member_kind, member.shared_award_id
          )
          from public.stage1_award_members member
          where member.cohort_key = registry.cohort_key
        ), '[]'::jsonb),
        'identity_rules', coalesce((
          select pg_catalog.jsonb_agg(
            pg_catalog.to_jsonb(identity_rule)
            order by identity_rule.rule_key, identity_rule.id
          )
          from public.stage1_award_source_identity_rules identity_rule
          where identity_rule.cohort_key = registry.cohort_key
        ), '[]'::jsonb),
        'allowed_source_ids', coalesce((
          select pg_catalog.jsonb_agg(
            allowed.source_id
            order by allowed.source_id
          )
          from (
            select distinct unnest(manifest.source_ids) as source_id
            from public.stage1_award_source_manifest manifest
            where manifest.cohort_key = registry.cohort_key
          ) allowed
        ), '[]'::jsonb),
        'reviewed_homepage', (
          select pg_catalog.jsonb_build_object(
            'source_id', source.id,
            'url', source.url
          )
          from public.stage1_award_source_manifest manifest
          join public.shared_award_sources source
            on cardinality(manifest.source_ids) = 1
            and source.id = manifest.source_ids[1]
          where manifest.cohort_key = registry.cohort_key
            and manifest.source_role = 'identity_home'
            and manifest.manifest_status in ('present', 'combined')
            and source.url = registry.official_homepage
            and manifest.evidence ->> 'source_url' = registry.official_homepage
            and manifest.evidence #>> array[
              'source_bindings', source.id::text, 'source_url'
            ] = registry.official_homepage
        ),
        'published_facts', coalesce((
          select pg_catalog.jsonb_object_agg(
            ledger.field_name,
            ledger.public_value
            order by ledger.field_name
          )
          from public.stage1_award_fact_publication_ledger ledger
          where ledger.cohort_key = registry.cohort_key
            and ledger.verification_batch_id = registry.fact_ledger_batch_id
        ), '{}'::jsonb)
      ) as payload
    from public.stage1_award_registry registry
    join effective_rows effective on effective.cohort_key = registry.cohort_key
  )
  select pg_catalog.jsonb_build_object(
    'schema_version', 3,
    'cohort_identity_version', 'stage1-national-25-v2',
    'cohort_identity_hash', public.stage1_publication_evidence_hash(
      pg_catalog.to_jsonb(identity_payload.value)
    ),
    'evaluated_at', evaluated.evaluated_at,
    'release', pg_catalog.jsonb_build_object(
      'release_key', release_state.release_key,
      'release_state', release_state.release_state,
      'release_epoch', release_state.release_epoch,
      'policy_version', release_state.policy_version,
      'cohort_identity_version', release_state.cohort_identity_version,
      'cohort_identity_hash', release_state.cohort_identity_hash,
      'activated_at', release_state.activated_at,
      'effectively_released', coalesce((
        select count(*) = 25 and bool_and(effective.effectively_verified)
        from effective_rows effective
      ), false),
      'effective_reason', coalesce((
        select min(effective.effective_reason)
        from effective_rows effective
      ), 'cohort_release_rows_missing'),
      'ready_cohort_count', coalesce((
        select count(*) filter (where effective.cohort_ready)
        from effective_rows effective
      ), 0)
    ),
    'cohorts', coalesce(
      (
        select pg_catalog.jsonb_agg(
          cohort_rows.payload
          order by cohort_rows.launch_rank
        )
        from cohort_rows
      ),
      '[]'::jsonb
    )
  )
  from evaluated
  cross join identity_payload
  cross join public.stage1_publication_release_state release_state
  where release_state.release_key = 'stage1-national-25';
$function$
;

create table if not exists private.stage1_publication_snapshot_cache (
  id integer primary key check (id = 1),
  computed_at timestamptz not null,
  registry_high_water timestamptz not null,
  snapshot jsonb not null
);
revoke all on table private.stage1_publication_snapshot_cache
  from public, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_stage1_publication_snapshot()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_cache private.stage1_publication_snapshot_cache%rowtype;
  v_registry_high_water timestamptz;
  v_snapshot jsonb;
begin
  select coalesce(max(registry.updated_at), '-infinity'::timestamptz)
  into v_registry_high_water
  from public.stage1_award_registry registry;

  select * into v_cache
  from private.stage1_publication_snapshot_cache cache
  where cache.id = 1;
  if found
    and v_cache.computed_at > now() - interval '60 seconds'
    and v_cache.registry_high_water = v_registry_high_water then
    return v_cache.snapshot;
  end if;

  v_snapshot := private.stage1_publication_snapshot_compute();

  insert into private.stage1_publication_snapshot_cache
    (id, computed_at, registry_high_water, snapshot)
  values (1, now(), v_registry_high_water, v_snapshot)
  on conflict (id) do update
    set computed_at = excluded.computed_at,
        registry_high_water = excluded.registry_high_water,
        snapshot = excluded.snapshot;

  return v_snapshot;
end;
$function$;
