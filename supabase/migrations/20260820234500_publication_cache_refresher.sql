-- Request-path calls must never pay the ~24s evidence recompute: the first
-- request after the 60s TTL did, and died at the PostgREST statement timeout,
-- so award pages kept 404ing. Requests now always serve the cache while the
-- registry is unchanged, and a pg_cron job recomputes both caches every
-- minute in the background. A registry change (promotion, release transition)
-- still forces an inline recompute so operator flows see it immediately.

create extension if not exists pg_cron;

create or replace function private.stage1_publication_snapshot_refresh()
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_registry_high_water timestamptz;
  v_rows jsonb;
  v_snapshot jsonb;
begin
  select coalesce(max(registry.updated_at), '-infinity'::timestamptz)
  into v_registry_high_water
  from public.stage1_award_registry registry;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(computed)), '[]'::jsonb)
  into v_rows
  from private.stage1_effective_publication_compute() computed;

  insert into private.stage1_effective_publication_cache
    (id, computed_at, registry_high_water, rows)
  values (1, now(), v_registry_high_water, v_rows)
  on conflict (id) do update
    set computed_at = excluded.computed_at,
        registry_high_water = excluded.registry_high_water,
        rows = excluded.rows;

  v_snapshot := private.stage1_publication_snapshot_compute();

  insert into private.stage1_publication_snapshot_cache
    (id, computed_at, registry_high_water, snapshot)
  values (1, now(), v_registry_high_water, v_snapshot)
  on conflict (id) do update
    set computed_at = excluded.computed_at,
        registry_high_water = excluded.registry_high_water,
        snapshot = excluded.snapshot;
end;
$function$;
revoke all on function private.stage1_publication_snapshot_refresh()
  from public, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.list_stage1_effective_publication()
 RETURNS TABLE(cohort_key text, effectively_verified boolean, effective_reason text, evaluated_at timestamp with time zone, cohort_ready boolean, cohort_readiness_reason text, release_epoch uuid, release_state text, release_policy_version text, release_identity_version text, release_identity_hash text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_cache private.stage1_effective_publication_cache%rowtype;
  v_registry_high_water timestamptz;
  v_rows jsonb;
begin
  select coalesce(max(registry.updated_at), '-infinity'::timestamptz)
  into v_registry_high_water
  from public.stage1_award_registry registry;

  select * into v_cache
  from private.stage1_effective_publication_cache cache
  where cache.id = 1;
  if found and v_cache.registry_high_water = v_registry_high_water then
    return query
    select *
    from pg_catalog.jsonb_to_recordset(v_cache.rows)
      as cached(cohort_key text, effectively_verified boolean, effective_reason text, evaluated_at timestamp with time zone, cohort_ready boolean, cohort_readiness_reason text, release_epoch uuid, release_state text, release_policy_version text, release_identity_version text, release_identity_hash text);
    return;
  end if;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(computed)), '[]'::jsonb)
  into v_rows
  from private.stage1_effective_publication_compute() computed;

  insert into private.stage1_effective_publication_cache
    (id, computed_at, registry_high_water, rows)
  values (1, now(), v_registry_high_water, v_rows)
  on conflict (id) do update
    set computed_at = excluded.computed_at,
        registry_high_water = excluded.registry_high_water,
        rows = excluded.rows;

  return query
  select *
  from pg_catalog.jsonb_to_recordset(v_rows)
    as computed_rows(cohort_key text, effectively_verified boolean, effective_reason text, evaluated_at timestamp with time zone, cohort_ready boolean, cohort_readiness_reason text, release_epoch uuid, release_state text, release_policy_version text, release_identity_version text, release_identity_hash text);
end;
$function$;

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
  if found and v_cache.registry_high_water = v_registry_high_water then
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

select cron.schedule(
  'stage1-publication-cache-refresh',
  '* * * * *',
  'select private.stage1_publication_snapshot_refresh()'
)
where not exists (
  select 1 from cron.job where jobname = 'stage1-publication-cache-refresh'
);
