create table if not exists public.shared_award_visual_review_candidates (
  id uuid primary key default gen_random_uuid(),
  shared_award_id uuid not null references public.shared_awards(id) on delete cascade,
  shared_award_source_id uuid not null references public.shared_award_sources(id) on delete cascade,
  candidate_signature text not null unique,
  source_url text not null,
  source_title text,
  source_page_type text,
  previous_snapshot_ref jsonb not null default '{}'::jsonb,
  new_snapshot_ref jsonb not null default '{}'::jsonb,
  previous_text_hash text,
  new_text_hash text,
  previous_image_hash text,
  new_image_hash text,
  previous_file_hash text,
  new_file_hash text,
  deterministic_diff jsonb not null default '{}'::jsonb,
  deterministic_classification text,
  prompt_payload jsonb not null default '{}'::jsonb,
  prompt_context text,
  status text not null default 'pending' check (
    status in (
      'pending',
      'submitted',
      'processing',
      'succeeded',
      'rejected',
      'failed',
      'published',
      'superseded'
    )
  ),
  gemini_batch_name text,
  gemini_batch_request_key text,
  model text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  submitted_at timestamptz,
  completed_at timestamptz,
  published_at timestamptz,
  ai_result jsonb,
  rejection_reason text,
  estimated_cost_usd numeric(12,6),
  actual_usage jsonb not null default '{}'::jsonb,
  worker_metadata jsonb not null default '{}'::jsonb
);

alter table public.shared_award_visual_review_candidates enable row level security;

revoke all on table public.shared_award_visual_review_candidates from anon, authenticated;
grant all on table public.shared_award_visual_review_candidates to service_role;

create index if not exists shared_award_visual_review_candidates_status_idx
  on public.shared_award_visual_review_candidates (status, created_at asc);

create index if not exists shared_award_visual_review_candidates_batch_idx
  on public.shared_award_visual_review_candidates (gemini_batch_name, status)
  where gemini_batch_name is not null;

create index if not exists shared_award_visual_review_candidates_source_idx
  on public.shared_award_visual_review_candidates (shared_award_source_id, created_at desc);

create index if not exists shared_award_visual_review_candidates_award_idx
  on public.shared_award_visual_review_candidates (shared_award_id, created_at desc);
