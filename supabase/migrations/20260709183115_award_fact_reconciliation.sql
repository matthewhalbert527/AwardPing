create table if not exists public.shared_award_fact_candidates (
  id uuid primary key default gen_random_uuid(),
  shared_award_id uuid not null references public.shared_awards(id) on delete cascade,
  shared_award_source_id uuid references public.shared_award_sources(id) on delete set null,
  source_url text,
  source_title text,
  source_role text,
  source_quality_decision jsonb not null default '{}'::jsonb,
  field_name text not null,
  raw_value text,
  normalized_value jsonb not null default 'null'::jsonb,
  evidence_quote text,
  evidence_location text,
  extracted_at timestamptz,
  model text,
  confidence text,
  candidate_status text not null default 'pending' check (
    candidate_status in ('pending', 'selected', 'rejected', 'conflicted', 'superseded')
  ),
  rejection_reason text,
  selected_reason text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.shared_award_fact_candidates enable row level security;
revoke all on table public.shared_award_fact_candidates from anon, authenticated;
grant all on table public.shared_award_fact_candidates to service_role;

create index if not exists shared_award_fact_candidates_award_field_idx
  on public.shared_award_fact_candidates (shared_award_id, field_name);

create index if not exists shared_award_fact_candidates_source_idx
  on public.shared_award_fact_candidates (shared_award_source_id);

create index if not exists shared_award_fact_candidates_status_idx
  on public.shared_award_fact_candidates (candidate_status);

create index if not exists shared_award_fact_candidates_rejection_idx
  on public.shared_award_fact_candidates (rejection_reason)
  where rejection_reason is not null;

create table if not exists public.shared_award_page_audits (
  id uuid primary key default gen_random_uuid(),
  shared_award_id uuid not null references public.shared_awards(id) on delete cascade,
  audit_kind text not null check (audit_kind in ('deterministic', 'gemini_batch', 'manual', 'regression')),
  audit_status text not null check (audit_status in ('passed', 'warnings', 'failed', 'needs_review')),
  severity text not null check (severity in ('info', 'warning', 'error', 'critical')),
  findings jsonb not null default '[]'::jsonb,
  suggested_fixes jsonb not null default '[]'::jsonb,
  field_conflicts jsonb not null default '[]'::jsonb,
  source_rejections jsonb not null default '[]'::jsonb,
  selected_fact_summary jsonb not null default '{}'::jsonb,
  public_page_snapshot jsonb not null default '{}'::jsonb,
  model text,
  gemini_batch_name text,
  gemini_batch_request_key text,
  ai_result jsonb,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by text,
  resolution_note text
);

alter table public.shared_award_page_audits enable row level security;
revoke all on table public.shared_award_page_audits from anon, authenticated;
grant all on table public.shared_award_page_audits to service_role;

create index if not exists shared_award_page_audits_award_created_idx
  on public.shared_award_page_audits (shared_award_id, created_at desc);

create index if not exists shared_award_page_audits_status_idx
  on public.shared_award_page_audits (audit_status, severity, created_at desc);

create index if not exists shared_award_page_audits_batch_idx
  on public.shared_award_page_audits (gemini_batch_name)
  where gemini_batch_name is not null;

create table if not exists public.shared_award_reconciliation_queue (
  id uuid primary key default gen_random_uuid(),
  shared_award_id uuid not null references public.shared_awards(id) on delete cascade,
  reason text not null,
  source_ids uuid[],
  candidate_ids uuid[],
  status text not null default 'pending' check (status in ('pending', 'processing', 'succeeded', 'failed', 'skipped')),
  priority integer not null default 100,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  error text,
  metadata jsonb not null default '{}'::jsonb
);

alter table public.shared_award_reconciliation_queue enable row level security;
revoke all on table public.shared_award_reconciliation_queue from anon, authenticated;
grant all on table public.shared_award_reconciliation_queue to service_role;

create unique index if not exists shared_award_reconciliation_queue_pending_reason_idx
  on public.shared_award_reconciliation_queue (shared_award_id, reason, status);

create index if not exists shared_award_reconciliation_queue_status_priority_idx
  on public.shared_award_reconciliation_queue (status, priority asc, created_at asc);

create index if not exists shared_award_reconciliation_queue_award_idx
  on public.shared_award_reconciliation_queue (shared_award_id, created_at desc);
