create table if not exists public.offices (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.office_members (
  id uuid primary key default gen_random_uuid(),
  office_id uuid not null references public.offices(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  email text,
  role text not null default 'member' check (role in ('owner', 'admin', 'member')),
  notification_preference text not null default 'immediate' check (
    notification_preference in ('immediate', 'daily_digest', 'both', 'none')
  ),
  status text not null default 'active' check (status in ('active', 'invited')),
  joined_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (office_id, user_id)
);

create table if not exists public.office_invites (
  id uuid primary key default gen_random_uuid(),
  office_id uuid not null references public.offices(id) on delete cascade,
  email text not null,
  role text not null default 'member' check (role in ('admin', 'member')),
  token_hash text not null unique,
  invited_by uuid references auth.users(id) on delete set null,
  accepted_by uuid references auth.users(id) on delete set null,
  accepted_at timestamptz,
  expires_at timestamptz not null default (now() + interval '14 days'),
  created_at timestamptz not null default now()
);

alter table public.awards
  add column if not exists office_id uuid references public.offices(id) on delete cascade;

alter table public.award_sources
  add column if not exists office_id uuid references public.offices(id) on delete cascade;

alter table public.monitors
  add column if not exists office_id uuid references public.offices(id) on delete cascade;

alter table public.monitor_snapshots
  add column if not exists office_id uuid references public.offices(id) on delete cascade;

alter table public.change_events
  add column if not exists office_id uuid references public.offices(id) on delete cascade,
  add column if not exists previous_snapshot_id uuid references public.monitor_snapshots(id) on delete set null,
  add column if not exists new_snapshot_id uuid references public.monitor_snapshots(id) on delete set null;

alter table public.alert_deliveries
  add column if not exists office_id uuid references public.offices(id) on delete cascade,
  add column if not exists office_member_id uuid references public.office_members(id) on delete set null,
  add column if not exists delivery_type text not null default 'immediate' check (
    delivery_type in ('immediate', 'digest')
  ),
  add column if not exists digest_key text;

alter table public.offices enable row level security;
alter table public.office_members enable row level security;
alter table public.office_invites enable row level security;

create or replace function public.ensure_default_office_for_user(target_user_id uuid, target_email text)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  default_office_id uuid;
begin
  select om.office_id into default_office_id
  from public.office_members om
  where om.user_id = target_user_id
  order by om.created_at asc
  limit 1;

  if default_office_id is not null then
    return default_office_id;
  end if;

  insert into public.offices (name, created_by)
  values (
    coalesce(nullif(split_part(target_email, '@', 1), ''), 'Advisor') || '''s office',
    target_user_id
  )
  returning id into default_office_id;

  insert into public.office_members (office_id, user_id, email, role, notification_preference, status)
  values (default_office_id, target_user_id, target_email, 'owner', 'immediate', 'active')
  on conflict (office_id, user_id) do nothing;

  return default_office_id;
end;
$$;

do $$
declare
  profile_row record;
  default_office_id uuid;
begin
  for profile_row in select id, email from public.profiles loop
    default_office_id := public.ensure_default_office_for_user(profile_row.id, profile_row.email);

    update public.awards award
      set office_id = default_office_id
      where award.user_id = profile_row.id and award.office_id is null;

    update public.award_sources source
      set office_id = default_office_id
      where source.user_id = profile_row.id and source.office_id is null;

    update public.monitors monitor
      set office_id = default_office_id
      where monitor.user_id = profile_row.id and monitor.office_id is null;
  end loop;
end $$;

update public.monitor_snapshots snapshot
set office_id = monitor.office_id
from public.monitors monitor
where snapshot.monitor_id = monitor.id and snapshot.office_id is null;

update public.change_events event
set office_id = monitor.office_id
from public.monitors monitor
where event.monitor_id = monitor.id and event.office_id is null;

update public.alert_deliveries delivery
set office_id = event.office_id
from public.change_events event
where delivery.change_event_id = event.id and delivery.office_id is null;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do update set email = excluded.email, updated_at = now();

  insert into public.subscriptions (user_id, plan, status)
  values (new.id, 'free', 'active')
  on conflict (user_id) do nothing;

  perform public.ensure_default_office_for_user(new.id, new.email);

  return new;
end;
$$;

create or replace function public.is_office_member(target_office_id uuid, target_user_id uuid)
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists (
    select 1 from public.office_members
    where office_id = target_office_id
    and user_id = target_user_id
    and status = 'active'
  );
$$;

create or replace function public.is_office_admin(target_office_id uuid, target_user_id uuid)
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists (
    select 1 from public.office_members
    where office_id = target_office_id
    and user_id = target_user_id
    and role in ('owner', 'admin')
    and status = 'active'
  );
$$;

drop policy if exists "offices visible to members" on public.offices;
create policy "offices visible to members" on public.offices
  for select using (public.is_office_member(offices.id, auth.uid()));

drop policy if exists "office members visible to members" on public.office_members;
create policy "office members visible to members" on public.office_members
  for select using (public.is_office_member(office_members.office_id, auth.uid()));

drop policy if exists "office invites visible to admins" on public.office_invites;
create policy "office invites visible to admins" on public.office_invites
  for select using (public.is_office_admin(office_invites.office_id, auth.uid()));

drop policy if exists "awards are office visible" on public.awards;
create policy "awards are office visible" on public.awards
  for select using (
    office_id is not null and public.is_office_member(awards.office_id, auth.uid())
  );

drop policy if exists "award sources are office visible" on public.award_sources;
create policy "award sources are office visible" on public.award_sources
  for select using (
    office_id is not null and public.is_office_member(award_sources.office_id, auth.uid())
  );

drop policy if exists "monitors are office visible" on public.monitors;
create policy "monitors are office visible" on public.monitors
  for select using (
    office_id is not null and public.is_office_member(monitors.office_id, auth.uid())
  );

drop policy if exists "snapshots visible through office monitor" on public.monitor_snapshots;
create policy "snapshots visible through office monitor" on public.monitor_snapshots
  for select using (
    exists (
      select 1 from public.monitors
      where monitors.id = monitor_snapshots.monitor_id
      and monitors.office_id is not null
      and public.is_office_member(monitors.office_id, auth.uid())
    )
  );

drop policy if exists "events visible through office monitor" on public.change_events;
create policy "events visible through office monitor" on public.change_events
  for select using (
    exists (
      select 1 from public.monitors
      where monitors.id = change_events.monitor_id
      and monitors.office_id is not null
      and public.is_office_member(monitors.office_id, auth.uid())
    )
  );

drop policy if exists "alert deliveries visible to office members" on public.alert_deliveries;
create policy "alert deliveries visible to office members" on public.alert_deliveries
  for select using (
    office_id is not null and public.is_office_member(alert_deliveries.office_id, auth.uid())
  );

create index if not exists offices_created_by_idx on public.offices (created_by);
create index if not exists office_members_user_idx on public.office_members (user_id);
create index if not exists office_members_office_idx on public.office_members (office_id);
create index if not exists office_invites_token_idx on public.office_invites (token_hash);
create index if not exists office_invites_office_idx on public.office_invites (office_id, created_at desc);
create index if not exists awards_office_created_idx on public.awards (office_id, created_at desc);
create index if not exists award_sources_office_idx on public.award_sources (office_id);
create index if not exists monitors_office_idx on public.monitors (office_id, created_at desc);
create index if not exists monitor_snapshots_office_idx on public.monitor_snapshots (office_id, created_at desc);
create index if not exists change_events_office_detected_idx on public.change_events (office_id, detected_at desc);
create index if not exists alert_deliveries_digest_idx on public.alert_deliveries (office_member_id, delivery_type, change_event_id);
