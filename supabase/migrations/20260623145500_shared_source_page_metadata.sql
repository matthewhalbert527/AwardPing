alter table public.shared_award_sources
  add column if not exists display_title text,
  add column if not exists page_description text,
  add column if not exists page_metadata jsonb not null default '{}'::jsonb,
  add column if not exists page_metadata_generated_at timestamptz,
  add column if not exists page_metadata_model text;

create index if not exists shared_award_sources_page_metadata_generated_idx
  on public.shared_award_sources (page_metadata_generated_at desc);
