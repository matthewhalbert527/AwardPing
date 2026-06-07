alter table public.award_sources
  add column if not exists shared_award_source_id uuid references public.shared_award_sources(id) on delete set null;

alter table public.monitors
  add column if not exists shared_award_source_id uuid references public.shared_award_sources(id) on delete set null;

alter table public.shared_award_sources
  add column if not exists last_hash text,
  add column if not exists last_checked_at timestamptz,
  add column if not exists next_check_at timestamptz not null default now(),
  add column if not exists consecutive_failures int not null default 0,
  add column if not exists last_error text;

alter table public.shared_awards
  add column if not exists last_structure_scan_at timestamptz,
  add column if not exists next_structure_scan_at timestamptz not null default now(),
  add column if not exists structure_scan_error text;

create table if not exists public.shared_award_source_snapshots (
  id uuid primary key default gen_random_uuid(),
  shared_award_id uuid not null references public.shared_awards(id) on delete cascade,
  shared_award_source_id uuid references public.shared_award_sources(id) on delete set null,
  source_url text not null,
  source_title text,
  source_page_type text check (
    source_page_type is null or source_page_type in (
      'homepage',
      'deadline',
      'application',
      'eligibility',
      'requirements',
      'pdf',
      'faq',
      'other'
    )
  ),
  hash text not null,
  text_sample text not null,
  byte_length int not null default 0,
  status_code int,
  content_type text,
  created_at timestamptz not null default now(),
  unique (shared_award_id, source_url, hash)
);

create table if not exists public.shared_award_change_events (
  id uuid primary key default gen_random_uuid(),
  shared_award_id uuid not null references public.shared_awards(id) on delete cascade,
  shared_award_source_id uuid references public.shared_award_sources(id) on delete set null,
  source_url text not null,
  source_title text,
  source_page_type text check (
    source_page_type is null or source_page_type in (
      'homepage',
      'deadline',
      'application',
      'eligibility',
      'requirements',
      'pdf',
      'faq',
      'other'
    )
  ),
  previous_snapshot_id uuid references public.shared_award_source_snapshots(id) on delete set null,
  new_snapshot_id uuid references public.shared_award_source_snapshots(id) on delete set null,
  previous_hash text not null,
  new_hash text not null,
  summary text not null,
  first_reported_by_office_id uuid references public.offices(id) on delete set null,
  first_reported_by_monitor_id uuid references public.monitors(id) on delete set null,
  detected_at timestamptz not null default now(),
  unique (shared_award_id, source_url, previous_hash, new_hash)
);

alter table public.shared_award_source_snapshots enable row level security;
alter table public.shared_award_change_events enable row level security;

drop policy if exists "shared award snapshots visible to authenticated users" on public.shared_award_source_snapshots;
create policy "shared award snapshots visible to authenticated users" on public.shared_award_source_snapshots
  for select using (
    auth.uid() is not null
    and exists (
      select 1 from public.shared_awards
      where shared_awards.id = shared_award_source_snapshots.shared_award_id
      and shared_awards.status = 'active'
    )
  );

drop policy if exists "shared award history visible to authenticated users" on public.shared_award_change_events;
create policy "shared award history visible to authenticated users" on public.shared_award_change_events
  for select using (
    auth.uid() is not null
    and exists (
      select 1 from public.shared_awards
      where shared_awards.id = shared_award_change_events.shared_award_id
      and shared_awards.status = 'active'
    )
  );

update public.award_sources source
set shared_award_source_id = shared_source.id
from public.awards award,
  public.shared_award_sources shared_source
where source.award_id = award.id
  and award.shared_award_id = shared_source.shared_award_id
  and source.url = shared_source.url
  and source.shared_award_source_id is null;

update public.monitors monitor
set shared_award_source_id = shared_source.id
from public.awards award,
  public.shared_award_sources shared_source
where monitor.award_id = award.id
  and award.shared_award_id = shared_source.shared_award_id
  and monitor.url = shared_source.url
  and monitor.shared_award_source_id is null;

insert into public.shared_award_source_snapshots (
  shared_award_id,
  shared_award_source_id,
  source_url,
  source_title,
  source_page_type,
  hash,
  text_sample,
  byte_length,
  status_code,
  content_type,
  created_at
)
select
  award.shared_award_id,
  shared_source.id,
  monitor.url,
  coalesce(monitor.source_label, monitor.label),
  monitor.page_type,
  snapshot.hash,
  snapshot.text_sample,
  snapshot.byte_length,
  snapshot.status_code,
  snapshot.content_type,
  snapshot.created_at
from public.monitor_snapshots snapshot
join public.monitors monitor on monitor.id = snapshot.monitor_id
join public.awards award on award.id = monitor.award_id
join public.shared_award_sources shared_source
  on shared_source.shared_award_id = award.shared_award_id
  and shared_source.url = monitor.url
where award.shared_award_id is not null
on conflict (shared_award_id, source_url, hash) do nothing;

insert into public.shared_award_change_events (
  shared_award_id,
  shared_award_source_id,
  source_url,
  source_title,
  source_page_type,
  previous_snapshot_id,
  new_snapshot_id,
  previous_hash,
  new_hash,
  summary,
  first_reported_by_office_id,
  first_reported_by_monitor_id,
  detected_at
)
select
  award.shared_award_id,
  shared_source.id,
  monitor.url,
  coalesce(monitor.source_label, monitor.label),
  monitor.page_type,
  previous_shared_snapshot.id,
  new_shared_snapshot.id,
  event.previous_hash,
  event.new_hash,
  event.summary,
  monitor.office_id,
  monitor.id,
  event.detected_at
from public.change_events event
join public.monitors monitor on monitor.id = event.monitor_id
join public.awards award on award.id = monitor.award_id
join public.shared_award_sources shared_source
  on shared_source.shared_award_id = award.shared_award_id
  and shared_source.url = monitor.url
left join public.shared_award_source_snapshots previous_shared_snapshot
  on previous_shared_snapshot.shared_award_id = award.shared_award_id
  and previous_shared_snapshot.source_url = monitor.url
  and previous_shared_snapshot.hash = event.previous_hash
left join public.shared_award_source_snapshots new_shared_snapshot
  on new_shared_snapshot.shared_award_id = award.shared_award_id
  and new_shared_snapshot.source_url = monitor.url
  and new_shared_snapshot.hash = event.new_hash
where award.shared_award_id is not null
  and event.previous_hash is not null
on conflict (shared_award_id, source_url, previous_hash, new_hash) do nothing;

create index if not exists award_sources_shared_source_idx
  on public.award_sources (shared_award_source_id);

create index if not exists monitors_shared_source_idx
  on public.monitors (shared_award_source_id);

create index if not exists shared_award_sources_due_idx
  on public.shared_award_sources (next_check_at, created_at asc);

create index if not exists shared_awards_structure_due_idx
  on public.shared_awards (status, next_structure_scan_at, created_at asc);

create index if not exists shared_snapshots_award_source_created_idx
  on public.shared_award_source_snapshots (shared_award_id, source_url, created_at desc);

create index if not exists shared_changes_award_detected_idx
  on public.shared_award_change_events (shared_award_id, detected_at desc);

create index if not exists shared_changes_source_detected_idx
  on public.shared_award_change_events (shared_award_source_id, detected_at desc);
