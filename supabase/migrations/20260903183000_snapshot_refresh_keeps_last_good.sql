-- Keep-last-good guard for the publication snapshot cache (defense in depth
-- under the owner directive 2026-09-02/03). While the national release is
-- activated, a refresh that would replace an effectively-released snapshot
-- with one that is not released ONLY because a cohort's epoch no longer
-- matches (cohort_release_epoch_mismatch) leaves the cache untouched and
-- raises a notice. Identity drift, an explicit yank (release row no longer
-- activated) and every other reason still overwrite the cache exactly as
-- before, so fail-closed behaviour is preserved where it matters. The
-- effective-publication cache is still refreshed so operators see the
-- underlying evaluation.

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
  v_current private.stage1_publication_snapshot_cache%rowtype;
  v_release public.stage1_publication_release_state%rowtype;
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

  select * into v_current
  from private.stage1_publication_snapshot_cache cache
  where cache.id = 1;

  select * into v_release
  from public.stage1_publication_release_state release_state
  where release_state.release_key = 'stage1-national-25';

  if found
    and v_release.activated_at is not null
    and v_release.release_state = 'verified_beta'
    and v_release.release_epoch is not null
    and v_current.id is not null
    and (v_current.snapshot -> 'release' ->> 'effectively_released') = 'true'
    and (v_snapshot -> 'release' ->> 'effectively_released') is distinct from 'true'
    and (v_snapshot -> 'release' ->> 'effective_reason') = 'cohort_release_epoch_mismatch'
  then
    raise notice 'stage1_publication_snapshot_refresh: kept the last effectively-released snapshot (computed %); the new evaluation reads cohort_release_epoch_mismatch while the release is activated.',
      v_current.computed_at;
    return;
  end if;

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
