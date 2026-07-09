alter table public.source_page_requests
  add column if not exists intake_type text not null default 'unknown' check (
    intake_type in ('award_homepage', 'official_source', 'sponsor_site', 'unknown')
  ),
  add column if not exists submitted_url text,
  add column if not exists normalized_url text,
  add column if not exists detected_award_name text,
  add column if not exists detected_sponsor text,
  add column if not exists matched_shared_award_id uuid references public.shared_awards(id) on delete set null,
  add column if not exists created_shared_award_id uuid references public.shared_awards(id) on delete set null,
  add column if not exists created_source_ids uuid[],
  add column if not exists status_reason text,
  add column if not exists ai_review jsonb not null default '{}'::jsonb,
  add column if not exists deterministic_review jsonb not null default '{}'::jsonb,
  add column if not exists discovered_links jsonb not null default '[]'::jsonb,
  add column if not exists capture_metadata jsonb not null default '{}'::jsonb,
  add column if not exists worker_run_id uuid,
  add column if not exists processed_at timestamptz,
  add column if not exists failed_at timestamptz,
  add column if not exists error text;

update public.source_page_requests
set
  submitted_url = coalesce(submitted_url, homepage_url),
  normalized_url = coalesce(normalized_url, lower(regexp_replace(regexp_replace(homepage_url, '#.*$', ''), '/+$', '')))
where submitted_url is null
   or normalized_url is null;

alter table public.source_page_requests
  drop constraint if exists source_page_requests_status_check;

alter table public.source_page_requests
  add constraint source_page_requests_status_check
  check (
    status in (
      'pending',
      'queued',
      'validating',
      'capturing',
      'ai_review_pending',
      'ai_review_submitted',
      'ai_review_succeeded',
      'matching',
      'needs_manual_review',
      'added',
      'rejected',
      'failed'
    )
  );

create index if not exists source_page_requests_normalized_idx
  on public.source_page_requests (normalized_url);

create index if not exists source_page_requests_worker_status_idx
  on public.source_page_requests (status, updated_at asc);

create index if not exists source_page_requests_matched_award_idx
  on public.source_page_requests (matched_shared_award_id)
  where matched_shared_award_id is not null;

create index if not exists source_page_requests_ai_batch_idx
  on public.source_page_requests ((ai_review ->> 'gemini_batch_name'))
  where ai_review ? 'gemini_batch_name';

create unique index if not exists source_page_requests_active_normalized_award_idx
  on public.source_page_requests (
    normalized_url,
    lower(coalesce(nullif(award_name, ''), ''))
  )
  where status in (
    'pending',
    'queued',
    'validating',
    'capturing',
    'ai_review_pending',
    'ai_review_submitted',
    'ai_review_succeeded',
    'matching',
    'needs_manual_review'
  );

grant all on table public.source_page_requests to service_role;
