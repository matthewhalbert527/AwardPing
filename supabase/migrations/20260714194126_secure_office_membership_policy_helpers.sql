-- Keep membership checks available to RLS without exposing a privileged RPC in
-- the public Data API schema. The helper derives the caller from auth.uid(), so
-- it cannot be used to inspect another user's office membership.
create schema if not exists private;
revoke all on schema private from public;

create or replace function private.is_office_member(target_office_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.office_members member
    where member.office_id = target_office_id
      and member.user_id = (select auth.uid())
      and member.status = 'active'
  );
$$;

create or replace function private.is_office_admin(target_office_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.office_members member
    where member.office_id = target_office_id
      and member.user_id = (select auth.uid())
      and member.role in ('owner', 'admin')
      and member.status = 'active'
  );
$$;

revoke execute on function private.is_office_member(uuid)
  from public, anon, authenticated, service_role;
revoke execute on function private.is_office_admin(uuid)
  from public, anon, authenticated, service_role;
grant usage on schema private to anon, authenticated, service_role;
grant execute on function private.is_office_member(uuid)
  to anon, authenticated, service_role;
grant execute on function private.is_office_admin(uuid)
  to anon, authenticated, service_role;

-- SELECT policies originally created in 0003_offices_notifications.sql.
alter policy "offices visible to members" on public.offices
  using (private.is_office_member(offices.id));

alter policy "office members visible to members" on public.office_members
  using (private.is_office_member(office_members.office_id));

alter policy "office invites visible to admins" on public.office_invites
  using (private.is_office_admin(office_invites.office_id));

alter policy "awards are office visible" on public.awards
  using (
    office_id is not null
    and private.is_office_member(awards.office_id)
  );

alter policy "award sources are office visible" on public.award_sources
  using (
    office_id is not null
    and private.is_office_member(award_sources.office_id)
  );

alter policy "monitors are office visible" on public.monitors
  using (
    office_id is not null
    and private.is_office_member(monitors.office_id)
  );

alter policy "snapshots visible through office monitor" on public.monitor_snapshots
  using (
    exists (
      select 1
      from public.monitors
      where monitors.id = monitor_snapshots.monitor_id
        and monitors.office_id is not null
        and private.is_office_member(monitors.office_id)
    )
  );

alter policy "events visible through office monitor" on public.change_events
  using (
    exists (
      select 1
      from public.monitors
      where monitors.id = change_events.monitor_id
        and monitors.office_id is not null
        and private.is_office_member(monitors.office_id)
    )
  );

alter policy "alert deliveries visible to office members" on public.alert_deliveries
  using (
    office_id is not null
    and private.is_office_member(alert_deliveries.office_id)
  );

-- INSERT/UPDATE policies originally created in 0005_award_pipeline.sql.
alter policy "awards workflow editable by office members" on public.awards
  using (
    office_id is not null
    and private.is_office_member(awards.office_id)
  )
  with check (
    office_id is not null
    and private.is_office_member(awards.office_id)
  );

alter policy "award notes visible to office members" on public.award_notes
  using (private.is_office_member(award_notes.office_id));

alter policy "award notes created by office members" on public.award_notes
  with check (
    author_user_id = (select auth.uid())
    and private.is_office_member(award_notes.office_id)
  );

alter policy "award tasks visible to office members" on public.award_tasks
  using (private.is_office_member(award_tasks.office_id));

alter policy "award tasks created by office members" on public.award_tasks
  with check (
    created_by_user_id = (select auth.uid())
    and private.is_office_member(award_tasks.office_id)
  );

alter policy "award tasks editable by office members" on public.award_tasks
  using (private.is_office_member(award_tasks.office_id))
  with check (private.is_office_member(award_tasks.office_id));

-- Every policy dependency now points at the unexposed helpers. RESTRICT (the
-- default) makes this migration fail if an unreviewed dependency still exists.
drop function public.is_office_admin(uuid, uuid);
drop function public.is_office_member(uuid, uuid);

-- Post-apply verification (run manually in a transaction):
--   select to_regprocedure('public.is_office_member(uuid,uuid)') is null;
--   select count(*) = 15
--   from pg_policies
--   where coalesce(qual, '') like '%private.is_office_%'
--      or coalesce(with_check, '') like '%private.is_office_%';
--   begin;
--   set local role anon;
--   select count(*) from public.offices; -- completes without permission error
--   rollback;
