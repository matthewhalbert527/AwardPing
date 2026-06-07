create table if not exists public.local_worker_runs (
  id uuid primary key default gen_random_uuid(),
  worker_name text not null default 'local-source-worker',
  status text not null check (status in ('running', 'succeeded', 'failed')),
  ai_provider text,
  checked_count int not null default 0,
  changed_count int not null default 0,
  unchanged_count int not null default 0,
  initial_count int not null default 0,
  discovered_count int not null default 0,
  failed_count int not null default 0,
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

alter table public.local_worker_runs enable row level security;

drop policy if exists "local worker runs visible to authenticated users" on public.local_worker_runs;
create policy "local worker runs visible to authenticated users" on public.local_worker_runs
  for select using (auth.uid() is not null);

create index if not exists local_worker_runs_started_idx
  on public.local_worker_runs (started_at desc);

create index if not exists local_worker_runs_status_started_idx
  on public.local_worker_runs (status, started_at desc);
