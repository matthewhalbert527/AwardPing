create table if not exists public.source_page_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  office_id uuid references public.offices(id) on delete set null,
  award_name text not null,
  homepage_url text not null,
  notes text,
  status text not null default 'pending' check (
    status in ('pending', 'queued', 'added', 'rejected')
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.source_page_requests enable row level security;

create index if not exists source_page_requests_status_created_idx
  on public.source_page_requests (status, created_at asc);

create index if not exists source_page_requests_office_created_idx
  on public.source_page_requests (office_id, created_at desc);

alter table public.public_form_rate_limits
  drop constraint if exists public_form_rate_limits_kind_check;

alter table public.public_form_rate_limits
  add constraint public_form_rate_limits_kind_check
  check (kind in ('subscribe', 'contact', 'source_request'));
