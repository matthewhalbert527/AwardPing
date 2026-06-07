create extension if not exists "pgcrypto";

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  plan text not null default 'free' check (plan in ('free', 'pro')),
  status text not null default 'inactive',
  stripe_customer_id text unique,
  stripe_subscription_id text unique,
  current_period_end timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id)
);

create table if not exists public.monitors (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  label text not null,
  url text not null,
  content_type text not null default 'auto' check (content_type in ('auto', 'html', 'pdf')),
  cadence text not null default 'daily' check (cadence in ('daily', 'hourly')),
  status text not null default 'active' check (status in ('active', 'paused', 'error')),
  last_hash text,
  last_checked_at timestamptz,
  next_check_at timestamptz not null default now(),
  consecutive_failures int not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.monitor_snapshots (
  id uuid primary key default gen_random_uuid(),
  monitor_id uuid not null references public.monitors(id) on delete cascade,
  hash text not null,
  text_sample text not null,
  byte_length int not null default 0,
  status_code int,
  content_type text,
  created_at timestamptz not null default now()
);

create table if not exists public.change_events (
  id uuid primary key default gen_random_uuid(),
  monitor_id uuid not null references public.monitors(id) on delete cascade,
  previous_hash text,
  new_hash text not null,
  summary text not null,
  detected_at timestamptz not null default now(),
  notified_at timestamptz
);

create table if not exists public.alert_deliveries (
  id uuid primary key default gen_random_uuid(),
  change_event_id uuid references public.change_events(id) on delete set null,
  user_id uuid not null references auth.users(id) on delete cascade,
  channel text not null default 'email',
  recipient text not null,
  status text not null,
  error text,
  created_at timestamptz not null default now()
);

create table if not exists public.free_checks (
  id uuid primary key default gen_random_uuid(),
  ip_hash text,
  url text not null,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
alter table public.subscriptions enable row level security;
alter table public.monitors enable row level security;
alter table public.monitor_snapshots enable row level security;
alter table public.change_events enable row level security;
alter table public.alert_deliveries enable row level security;
alter table public.free_checks enable row level security;

create policy "profiles are user owned" on public.profiles
  for all using (auth.uid() = id) with check (auth.uid() = id);

create policy "subscriptions are user owned" on public.subscriptions
  for select using (auth.uid() = user_id);

create policy "monitors are user owned" on public.monitors
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "snapshots visible through owned monitor" on public.monitor_snapshots
  for select using (
    exists (
      select 1 from public.monitors
      where monitors.id = monitor_snapshots.monitor_id
      and monitors.user_id = auth.uid()
    )
  );

create policy "events visible through owned monitor" on public.change_events
  for select using (
    exists (
      select 1 from public.monitors
      where monitors.id = change_events.monitor_id
      and monitors.user_id = auth.uid()
    )
  );

create policy "alert deliveries are user owned" on public.alert_deliveries
  for select using (auth.uid() = user_id);

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

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

create index if not exists monitors_due_idx
  on public.monitors (next_check_at)
  where status = 'active';

create index if not exists monitors_user_idx on public.monitors (user_id);
create index if not exists snapshots_monitor_created_idx on public.monitor_snapshots (monitor_id, created_at desc);
create index if not exists events_monitor_detected_idx on public.change_events (monitor_id, detected_at desc);
