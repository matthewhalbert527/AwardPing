alter table public.local_worker_runs
  add column if not exists metadata jsonb not null default '{}'::jsonb;

create index if not exists local_worker_runs_metadata_gin_idx
  on public.local_worker_runs using gin (metadata);
