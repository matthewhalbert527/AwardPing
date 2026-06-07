create table if not exists public.job_runs (
  id uuid primary key default gen_random_uuid(),
  job_name text not null check (job_name in ('check-monitors', 'send-digests')),
  status text not null default 'running' check (status in ('running', 'succeeded', 'failed')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  processed_count int not null default 0 check (processed_count >= 0),
  error text,
  metadata jsonb not null default '{}'::jsonb
);

alter table public.job_runs enable row level security;

create index if not exists job_runs_name_started_idx
  on public.job_runs (job_name, started_at desc);

create index if not exists job_runs_status_started_idx
  on public.job_runs (status, started_at desc);
