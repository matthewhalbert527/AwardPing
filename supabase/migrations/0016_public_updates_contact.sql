create table if not exists public.public_update_subscribers (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  status text not null default 'pending' check (
    status in ('pending', 'active', 'unsubscribed')
  ),
  confirmation_token_hash text unique,
  unsubscribe_token_hash text not null unique,
  confirmation_sent_at timestamptz,
  confirmed_at timestamptz,
  unsubscribed_at timestamptz,
  last_digest_sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.public_update_deliveries (
  id uuid primary key default gen_random_uuid(),
  subscriber_id uuid not null references public.public_update_subscribers(id) on delete cascade,
  digest_key text not null,
  change_event_ids uuid[] not null default '{}'::uuid[],
  recipient text not null,
  status text not null check (status in ('sent', 'failed')),
  error text,
  sent_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (subscriber_id, digest_key)
);

create table if not exists public.public_form_rate_limits (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('subscribe', 'contact')),
  ip_hash text not null,
  created_at timestamptz not null default now()
);

alter table public.public_update_subscribers enable row level security;
alter table public.public_update_deliveries enable row level security;
alter table public.public_form_rate_limits enable row level security;

create index if not exists public_update_subscribers_status_idx
  on public.public_update_subscribers (status, created_at desc);

create index if not exists public_update_subscribers_confirmation_idx
  on public.public_update_subscribers (confirmation_token_hash)
  where confirmation_token_hash is not null;

create index if not exists public_update_subscribers_unsubscribe_idx
  on public.public_update_subscribers (unsubscribe_token_hash);

create index if not exists public_update_deliveries_digest_idx
  on public.public_update_deliveries (digest_key, status);

create index if not exists public_form_rate_limits_kind_ip_created_idx
  on public.public_form_rate_limits (kind, ip_hash, created_at desc);
