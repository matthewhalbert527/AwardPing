create table if not exists public.discovery_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  ip_hash text not null,
  query text not null,
  created_at timestamptz not null default now()
);

alter table public.discovery_requests enable row level security;

create index if not exists discovery_requests_created_idx
  on public.discovery_requests (created_at desc);

create index if not exists discovery_requests_user_created_idx
  on public.discovery_requests (user_id, created_at desc);

create index if not exists discovery_requests_ip_created_idx
  on public.discovery_requests (ip_hash, created_at desc);
