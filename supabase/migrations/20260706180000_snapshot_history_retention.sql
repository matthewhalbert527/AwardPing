create index if not exists shared_award_source_snapshots_source_created_idx
  on public.shared_award_source_snapshots (shared_award_source_id, created_at desc, id desc)
  where shared_award_source_id is not null;

create index if not exists shared_award_change_events_previous_snapshot_idx
  on public.shared_award_change_events (previous_snapshot_id)
  where previous_snapshot_id is not null;

create index if not exists shared_award_change_events_new_snapshot_idx
  on public.shared_award_change_events (new_snapshot_id)
  where new_snapshot_id is not null;

create index if not exists change_events_previous_snapshot_idx
  on public.change_events (previous_snapshot_id)
  where previous_snapshot_id is not null;

create index if not exists change_events_new_snapshot_idx
  on public.change_events (new_snapshot_id)
  where new_snapshot_id is not null;

create or replace function public.prune_shared_award_source_snapshot_history(
  p_keep_per_source integer default 2,
  p_batch_size integer default 10000,
  p_apply boolean default false,
  p_preserve_change_event_snapshots boolean default true
)
returns table(candidate_count integer, deleted_count integer)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_keep integer := greatest(coalesce(p_keep_per_source, 2), 1);
  v_batch integer := least(greatest(coalesce(p_batch_size, 10000), 1), 100000);
  v_preserve boolean := coalesce(p_preserve_change_event_snapshots, true);
begin
  create temp table if not exists tmp_shared_snapshot_prune_candidates (
    id uuid primary key
  ) on commit drop;

  truncate tmp_shared_snapshot_prune_candidates;

  insert into tmp_shared_snapshot_prune_candidates (id)
  select ranked.id
  from (
    select
      snapshot.id,
      snapshot.created_at,
      row_number() over (
        partition by coalesce(
          snapshot.shared_award_source_id::text,
          snapshot.shared_award_id::text || '|' || snapshot.source_url
        )
        order by snapshot.created_at desc, snapshot.id desc
      ) as snapshot_rank
    from public.shared_award_source_snapshots snapshot
  ) ranked
  where ranked.snapshot_rank > v_keep
    and (
      not v_preserve
      or (
        not exists (
          select 1
          from public.shared_award_change_events event
          where event.previous_snapshot_id = ranked.id
        )
        and not exists (
          select 1
          from public.shared_award_change_events event
          where event.new_snapshot_id = ranked.id
        )
      )
    )
  order by ranked.created_at asc, ranked.id asc
  limit v_batch;

  select count(*)::integer
  into candidate_count
  from tmp_shared_snapshot_prune_candidates;

  if p_apply then
    delete from public.shared_award_source_snapshots snapshot
    using tmp_shared_snapshot_prune_candidates candidate
    where snapshot.id = candidate.id;

    get diagnostics deleted_count = row_count;
  else
    deleted_count := 0;
  end if;

  return next;
end;
$$;

create or replace function public.prune_monitor_snapshot_history(
  p_keep_per_monitor integer default 2,
  p_batch_size integer default 10000,
  p_apply boolean default false,
  p_preserve_change_event_snapshots boolean default true
)
returns table(candidate_count integer, deleted_count integer)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_keep integer := greatest(coalesce(p_keep_per_monitor, 2), 1);
  v_batch integer := least(greatest(coalesce(p_batch_size, 10000), 1), 100000);
  v_preserve boolean := coalesce(p_preserve_change_event_snapshots, true);
begin
  create temp table if not exists tmp_monitor_snapshot_prune_candidates (
    id uuid primary key
  ) on commit drop;

  truncate tmp_monitor_snapshot_prune_candidates;

  insert into tmp_monitor_snapshot_prune_candidates (id)
  select ranked.id
  from (
    select
      snapshot.id,
      snapshot.created_at,
      row_number() over (
        partition by snapshot.monitor_id
        order by snapshot.created_at desc, snapshot.id desc
      ) as snapshot_rank
    from public.monitor_snapshots snapshot
  ) ranked
  where ranked.snapshot_rank > v_keep
    and (
      not v_preserve
      or (
        not exists (
          select 1
          from public.change_events event
          where event.previous_snapshot_id = ranked.id
        )
        and not exists (
          select 1
          from public.change_events event
          where event.new_snapshot_id = ranked.id
        )
      )
    )
  order by ranked.created_at asc, ranked.id asc
  limit v_batch;

  select count(*)::integer
  into candidate_count
  from tmp_monitor_snapshot_prune_candidates;

  if p_apply then
    delete from public.monitor_snapshots snapshot
    using tmp_monitor_snapshot_prune_candidates candidate
    where snapshot.id = candidate.id;

    get diagnostics deleted_count = row_count;
  else
    deleted_count := 0;
  end if;

  return next;
end;
$$;

revoke all on function public.prune_shared_award_source_snapshot_history(integer, integer, boolean, boolean)
  from public, anon, authenticated;
grant execute on function public.prune_shared_award_source_snapshot_history(integer, integer, boolean, boolean)
  to service_role;

revoke all on function public.prune_monitor_snapshot_history(integer, integer, boolean, boolean)
  from public, anon, authenticated;
grant execute on function public.prune_monitor_snapshot_history(integer, integer, boolean, boolean)
  to service_role;
