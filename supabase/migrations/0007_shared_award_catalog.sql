create table if not exists public.shared_awards (
  id uuid primary key default gen_random_uuid(),
  search_key text not null unique,
  name text not null,
  official_homepage text,
  summary text,
  confidence numeric not null default 0 check (confidence >= 0 and confidence <= 1),
  status text not null default 'active' check (status in ('active', 'archived')),
  source text not null default 'seed' check (source in ('seed', 'user', 'admin')),
  submitted_by_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.shared_award_sources (
  id uuid primary key default gen_random_uuid(),
  shared_award_id uuid not null references public.shared_awards(id) on delete cascade,
  url text not null,
  title text not null,
  page_type text not null default 'homepage' check (
    page_type in (
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
  confidence numeric not null default 0 check (confidence >= 0 and confidence <= 1),
  reason text,
  source text not null default 'seed' check (source in ('seed', 'user', 'admin')),
  submitted_by_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (shared_award_id, url)
);

alter table public.awards
  add column if not exists shared_award_id uuid references public.shared_awards(id) on delete set null;

alter table public.shared_awards enable row level security;
alter table public.shared_award_sources enable row level security;

create policy "shared awards visible to authenticated users" on public.shared_awards
  for select using (auth.uid() is not null and status = 'active');

create policy "shared award sources visible to authenticated users" on public.shared_award_sources
  for select using (
    auth.uid() is not null
    and exists (
      select 1 from public.shared_awards
      where shared_awards.id = shared_award_sources.shared_award_id
      and shared_awards.status = 'active'
    )
  );

create index if not exists shared_awards_name_idx
  on public.shared_awards (name);

create index if not exists shared_awards_status_name_idx
  on public.shared_awards (status, name);

create index if not exists shared_award_sources_award_idx
  on public.shared_award_sources (shared_award_id, created_at asc);

create index if not exists shared_award_sources_url_idx
  on public.shared_award_sources (url);

create index if not exists awards_shared_award_idx
  on public.awards (shared_award_id);
