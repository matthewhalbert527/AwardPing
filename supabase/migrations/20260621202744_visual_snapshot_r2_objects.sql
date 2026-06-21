create table if not exists public.shared_award_source_visual_snapshots (
  shared_award_source_id uuid primary key references public.shared_award_sources(id) on delete cascade,
  shared_award_id uuid not null references public.shared_awards(id) on delete cascade,
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
  kind text not null default 'webpage' check (kind in ('webpage', 'pdf')),
  bucket text not null,
  latest_captured_at timestamptz,
  latest_object_keys jsonb not null default '{}'::jsonb,
  latest_hashes jsonb not null default '{}'::jsonb,
  latest_metadata jsonb not null default '{}'::jsonb,
  previous_captured_at timestamptz,
  previous_object_keys jsonb not null default '{}'::jsonb,
  previous_hashes jsonb not null default '{}'::jsonb,
  previous_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.shared_award_source_visual_snapshots enable row level security;

revoke all on table public.shared_award_source_visual_snapshots from anon, authenticated;
grant all on table public.shared_award_source_visual_snapshots to service_role;

create index if not exists shared_award_source_visual_snapshots_award_idx
  on public.shared_award_source_visual_snapshots (shared_award_id, updated_at desc);

create index if not exists shared_award_source_visual_snapshots_latest_idx
  on public.shared_award_source_visual_snapshots (latest_captured_at desc);
