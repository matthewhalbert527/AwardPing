-- Serve the last computed publication snapshot while a refresh is pending.
--
-- get_stage1_publication_snapshot() recomputed inline whenever the registry
-- high-water moved past the cache. The effective-publication compute now
-- validates the signed release artifacts, so that inline recompute takes
-- minutes - and every SSR request repeated it concurrently (no single-flight),
-- so each registry change turned every award page into a 404 dogpile until an
-- out-of-band refresh landed (observed 2026-08-31: multi-hour outages of all
-- 25 award pages).
--
-- The page-serving read now returns the previous snapshot immediately when the
-- cache exists but is stale; private.stage1_publication_snapshot_refresh()
-- (operator- and scheduler-driven) remains the sole recomputer. Inline compute
-- survives only for the empty-cache first boot.
--
-- Deliberately NOT changed: public.list_stage1_effective_publication() keeps
-- its exact high-water match and inline recompute - the release gate,
-- acceptance, and activation read through it and must never act on stale
-- effectiveness. Bounded staleness on the page path is acceptable because the
-- change-event delivery path re-asserts release currency against the live
-- release row on every read (assertStage1PublicationReleaseCurrent), and
-- page-level demotion visibility lags by at most one refresh interval instead
-- of hard-failing every page during the recompute.

create or replace function public.get_stage1_publication_snapshot()
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
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
  if found then
    -- Fresh or stale: serve what was last computed. A stale row means a
    -- registry change is awaiting the out-of-band refresher; recomputing here
    -- would stall every concurrent page request for the full derivation.
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
$$;
