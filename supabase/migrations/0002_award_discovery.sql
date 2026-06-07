create table if not exists public.awards (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  official_homepage text,
  summary text,
  confidence numeric not null default 0 check (confidence >= 0 and confidence <= 1),
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.award_sources (
  id uuid primary key default gen_random_uuid(),
  award_id uuid not null references public.awards(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  url text not null,
  title text not null,
  page_type text not null default 'other' check (
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
  selected boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.monitors
  add column if not exists award_id uuid references public.awards(id) on delete set null,
  add column if not exists page_type text check (
    page_type is null or page_type in (
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
  add column if not exists source_label text;

alter table public.awards enable row level security;
alter table public.award_sources enable row level security;

create policy "awards are user owned" on public.awards
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "award sources are user owned" on public.award_sources
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create index if not exists awards_user_created_idx
  on public.awards (user_id, created_at desc);

create index if not exists award_sources_award_idx
  on public.award_sources (award_id, created_at asc);

create index if not exists award_sources_user_idx
  on public.award_sources (user_id);

create index if not exists monitors_award_idx
  on public.monitors (award_id);
