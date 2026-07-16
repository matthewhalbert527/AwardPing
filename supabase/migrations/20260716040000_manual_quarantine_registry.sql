-- Durable, case-grouped accounting for work that automation cannot truthfully
-- call complete. The registry keeps current evidence plus append-only history.

create table if not exists public.manual_quarantine_registry (
  id uuid primary key default gen_random_uuid(),
  quarantine_key text not null unique,
  case_key text not null,
  classification text not null check (
    classification in ('actionable_quarantine', 'historical_limitation')
  ),
  category text not null check (
    category in ('public_page', 'visual_review', 'historical_localization')
  ),
  status text not null default 'quarantined' check (
    status in ('quarantined', 'in_review', 'resolved')
  ),
  requires_action boolean not null,
  terminal boolean not null default false,
  terminal_failure_count integer not null default 0 check (terminal_failure_count >= 0),
  severity text not null check (severity in ('high', 'medium', 'low')),
  public_impact text not null check (
    public_impact in ('blocked', 'delayed', 'protected', 'none', 'unknown')
  ),
  owner text not null,
  retry_mode text not null,
  retry_charge text not null check (
    retry_charge in ('none', 'will_charge', 'may_charge', 'unknown')
  ),
  title text not null,
  reason_code text not null,
  reason text not null,
  recommended_action text not null,
  shared_award_id uuid references public.shared_awards(id) on delete set null,
  shared_award_source_id uuid references public.shared_award_sources(id) on delete set null,
  visual_review_candidate_id uuid
    references public.shared_award_visual_review_candidates(id) on delete set null,
  primary_source_table text not null,
  primary_source_record_id uuid not null,
  evidence_record_count integer not null default 1 check (evidence_record_count > 0),
  evidence jsonb not null default '{}'::jsonb,
  evidence_hash text not null check (evidence_hash ~ '^[0-9a-f]{64}$'),
  policy_id text not null default 'awardping-manual-quarantine',
  policy_version text not null default '1',
  policy_hash text not null default
    '4a12c7a0c4e088bca3b5c4b9ef28c6ddb8b108ac8b324c23dbde4aa5e0646ae4'
    check (policy_hash ~ '^[0-9a-f]{64}$'),
  first_observed_at timestamptz not null,
  last_observed_at timestamptz not null,
  quarantined_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by text,
  resolution_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint manual_quarantine_registry_resolution_check check (
    (status = 'resolved' and resolved_at is not null)
    or (status <> 'resolved' and resolved_at is null)
  ),
  constraint manual_quarantine_registry_classification_action_check check (
    (classification = 'actionable_quarantine' and requires_action)
    or (classification = 'historical_limitation' and not requires_action and not terminal)
  ),
  constraint manual_quarantine_registry_classification_category_check check (
    (classification = 'actionable_quarantine' and category in ('public_page', 'visual_review'))
    or (classification = 'historical_limitation' and category = 'historical_localization')
  ),
  constraint manual_quarantine_registry_terminal_count_check check (
    (terminal and terminal_failure_count > 0)
    or (not terminal and terminal_failure_count = 0)
  ),
  constraint manual_quarantine_registry_terminal_category_count_check check (
    (category = 'public_page' and terminal_failure_count between 0 and 2)
    or (category = 'visual_review' and terminal_failure_count = 1)
    or (category = 'historical_localization' and terminal_failure_count = 0)
  )
);

create index if not exists manual_quarantine_registry_open_idx
  on public.manual_quarantine_registry (classification, category, first_observed_at, id)
  where status in ('quarantined', 'in_review');

create index if not exists manual_quarantine_registry_award_idx
  on public.manual_quarantine_registry (shared_award_id, updated_at desc)
  where shared_award_id is not null;

create index if not exists manual_quarantine_registry_source_idx
  on public.manual_quarantine_registry (shared_award_source_id, updated_at desc)
  where shared_award_source_id is not null;

create index if not exists manual_quarantine_registry_visual_candidate_idx
  on public.manual_quarantine_registry (visual_review_candidate_id)
  where visual_review_candidate_id is not null;

create table if not exists public.manual_quarantine_registry_events (
  id bigint generated always as identity primary key,
  quarantine_id uuid not null
    references public.manual_quarantine_registry(id) on delete restrict,
  event_type text not null check (
    event_type in (
      'opened',
      'reopened',
      'evidence_refreshed',
      'case_refreshed',
      'status_changed'
    )
  ),
  previous_status text,
  next_status text not null,
  evidence_hash text not null check (evidence_hash ~ '^[0-9a-f]{64}$'),
  snapshot jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists manual_quarantine_registry_events_case_idx
  on public.manual_quarantine_registry_events (quarantine_id, created_at desc, id desc);

create table if not exists public.manual_quarantine_registry_state (
  registry_key text primary key check (registry_key = 'one_time_catchup'),
  schema_version text not null default 'manual-quarantine-registry-v1',
  automated_work_clear boolean,
  automated_blockers jsonb not null default '{}'::jsonb,
  quarantined_work_remaining bigint not null default 0 check (quarantined_work_remaining >= 0),
  quarantine_evidence_records bigint not null default 0 check (quarantine_evidence_records >= 0),
  historical_limitations bigint check (historical_limitations is null or historical_limitations >= 0),
  historical_inventory_status text not null default 'not_imported' check (
    historical_inventory_status in ('not_imported', 'complete')
  ),
  terminal_failures_requiring_action bigint not null default 0
    check (terminal_failures_requiring_action >= 0),
  by_category jsonb not null default '{}'::jsonb,
  completion_status text not null default 'not_reported' check (
    completion_status in ('not_reported', 'automated_work_remaining', 'automated_work_clear')
  ),
  source_worker_run_id uuid references public.local_worker_runs(id) on delete set null,
  completion_reported_at timestamptz,
  historical_inventory_reported_at timestamptz,
  historical_inventory_digest text check (
    historical_inventory_digest is null
    or historical_inventory_digest ~ '^[0-9a-f]{64}$'
  ),
  last_synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.manual_quarantine_registry enable row level security;
alter table public.manual_quarantine_registry_events enable row level security;
alter table public.manual_quarantine_registry_state enable row level security;

revoke all on table public.manual_quarantine_registry from public, anon, authenticated;
revoke all on table public.manual_quarantine_registry_events from public, anon, authenticated, service_role;
revoke all on table public.manual_quarantine_registry_state from public, anon, authenticated;
grant all on table public.manual_quarantine_registry to service_role;
grant select, insert on table public.manual_quarantine_registry_events to service_role;
grant all on table public.manual_quarantine_registry_state to service_role;
revoke all on sequence public.manual_quarantine_registry_events_id_seq
  from public, anon, authenticated, service_role;
grant usage, select on sequence public.manual_quarantine_registry_events_id_seq to service_role;

create or replace function public.manual_quarantine_evidence_hash(p_evidence jsonb)
returns text
language plpgsql
stable
strict
set search_path = ''
as $$
declare
  v_digest text;
begin
  if pg_catalog.to_regprocedure('extensions.digest(bytea,text)') is not null then
    execute
      'select pg_catalog.encode(extensions.digest(pg_catalog.convert_to($1, ''UTF8''), ''sha256''), ''hex'')'
      into v_digest
      using p_evidence::text;
  elsif pg_catalog.to_regprocedure('public.digest(bytea,text)') is not null then
    execute
      'select pg_catalog.encode(public.digest(pg_catalog.convert_to($1, ''UTF8''), ''sha256''), ''hex'')'
      into v_digest
      using p_evidence::text;
  else
    raise exception using
      errcode = '55000',
      message = 'pgcrypto digest(bytea,text) is required for manual quarantine evidence hashing.';
  end if;
  return v_digest;
end;
$$;

revoke all on function public.manual_quarantine_evidence_hash(jsonb)
  from public, anon, authenticated;
grant execute on function public.manual_quarantine_evidence_hash(jsonb)
  to service_role;

create or replace function public.touch_manual_quarantine_registry()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create or replace function public.audit_manual_quarantine_registry()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_event_type text;
begin
  if tg_op = 'INSERT' then
    v_event_type := 'opened';
  elsif old.status is distinct from new.status then
    v_event_type := case
      when old.status = 'resolved' and new.status <> 'resolved' then 'reopened'
      else 'status_changed'
    end;
  elsif old.evidence_hash is distinct from new.evidence_hash then
    v_event_type := 'evidence_refreshed';
  elsif row(
    old.case_key,
    old.classification,
    old.category,
    old.requires_action,
    old.terminal,
    old.terminal_failure_count,
    old.severity,
    old.public_impact,
    old.owner,
    old.retry_mode,
    old.retry_charge,
    old.title,
    old.reason_code,
    old.reason,
    old.recommended_action,
    old.shared_award_id,
    old.shared_award_source_id,
    old.visual_review_candidate_id,
    old.primary_source_table,
    old.primary_source_record_id,
    old.evidence_record_count,
    old.policy_id,
    old.policy_version,
    old.policy_hash,
    old.first_observed_at,
    old.last_observed_at
  ) is distinct from row(
    new.case_key,
    new.classification,
    new.category,
    new.requires_action,
    new.terminal,
    new.terminal_failure_count,
    new.severity,
    new.public_impact,
    new.owner,
    new.retry_mode,
    new.retry_charge,
    new.title,
    new.reason_code,
    new.reason,
    new.recommended_action,
    new.shared_award_id,
    new.shared_award_source_id,
    new.visual_review_candidate_id,
    new.primary_source_table,
    new.primary_source_record_id,
    new.evidence_record_count,
    new.policy_id,
    new.policy_version,
    new.policy_hash,
    new.first_observed_at,
    new.last_observed_at
  ) then
    v_event_type := 'case_refreshed';
  else
    return new;
  end if;

  insert into public.manual_quarantine_registry_events (
    quarantine_id,
    event_type,
    previous_status,
    next_status,
    evidence_hash,
    snapshot
  ) values (
    new.id,
    v_event_type,
    case when tg_op = 'UPDATE' then old.status else null end,
    new.status,
    new.evidence_hash,
    to_jsonb(new)
  );
  return new;
end;
$$;

drop trigger if exists touch_manual_quarantine_registry
  on public.manual_quarantine_registry;
create trigger touch_manual_quarantine_registry
  before update on public.manual_quarantine_registry
  for each row execute function public.touch_manual_quarantine_registry();

drop trigger if exists audit_manual_quarantine_registry
  on public.manual_quarantine_registry;
create trigger audit_manual_quarantine_registry
  after insert or update on public.manual_quarantine_registry
  for each row execute function public.audit_manual_quarantine_registry();

create or replace function public.refresh_manual_quarantine_registry_state(
  p_synced_at timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actionable bigint := 0;
  v_evidence_records bigint := 0;
  v_historical bigint := 0;
  v_terminal_failures bigint := 0;
  v_by_category jsonb := '{}'::jsonb;
  v_state public.manual_quarantine_registry_state%rowtype;
begin
  with open_registry as materialized (
    select *
    from public.manual_quarantine_registry
    where status in ('quarantined', 'in_review')
  ),
  totals as (
    select
      count(*) filter (where classification = 'actionable_quarantine') as actionable,
      coalesce(sum(evidence_record_count) filter (
        where classification = 'actionable_quarantine'
      ), 0) as evidence_records,
      count(*) filter (where classification = 'historical_limitation') as historical,
      coalesce(sum(terminal_failure_count) filter (
        where classification = 'actionable_quarantine'
      ), 0) as terminal_failures
    from open_registry
  ),
  categories as (
    select
      category,
      jsonb_build_object(
        'cases', count(*),
        'evidence_records', coalesce(sum(evidence_record_count), 0),
        'terminal_cases', count(*) filter (where terminal),
        'terminal_failures', coalesce(sum(terminal_failure_count), 0),
        'oldest_observed_at', min(first_observed_at),
        'unknown_public_impact_cases', count(*) filter (where public_impact = 'unknown')
      ) as category_summary
    from open_registry
    group by category
  ),
  category_map as (
    select coalesce(jsonb_object_agg(category, category_summary), '{}'::jsonb) as value
    from categories
  )
  select
    totals.actionable,
    totals.evidence_records,
    totals.historical,
    totals.terminal_failures,
    category_map.value
  into v_actionable, v_evidence_records, v_historical, v_terminal_failures, v_by_category
  from totals
  cross join category_map;

  insert into public.manual_quarantine_registry_state (
    registry_key,
    quarantined_work_remaining,
    quarantine_evidence_records,
    historical_limitations,
    terminal_failures_requiring_action,
    by_category,
    last_synced_at,
    updated_at
  ) values (
    'one_time_catchup',
    v_actionable,
    v_evidence_records,
    null,
    v_terminal_failures,
    v_by_category,
    p_synced_at,
    p_synced_at
  )
  on conflict (registry_key) do update set
    quarantined_work_remaining = excluded.quarantined_work_remaining,
    quarantine_evidence_records = excluded.quarantine_evidence_records,
    historical_limitations = case
      when public.manual_quarantine_registry_state.historical_inventory_status = 'complete'
        then v_historical
      else null
    end,
    terminal_failures_requiring_action = excluded.terminal_failures_requiring_action,
    by_category = excluded.by_category,
    completion_status = case
      when public.manual_quarantine_registry_state.automated_work_clear is null
        then 'not_reported'
      when public.manual_quarantine_registry_state.automated_work_clear
        then 'automated_work_clear'
      else 'automated_work_remaining'
    end,
    last_synced_at = excluded.last_synced_at,
    updated_at = excluded.updated_at;

  select * into v_state
  from public.manual_quarantine_registry_state
  where registry_key = 'one_time_catchup';
  return to_jsonb(v_state);
end;
$$;

revoke all on function public.refresh_manual_quarantine_registry_state(timestamptz)
  from public, anon, authenticated, service_role;

create or replace function public.sync_manual_quarantine_registry()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_result jsonb;
  v_write_count bigint := 0;
begin
  perform pg_advisory_xact_lock(hashtext('awardping-manual-quarantine-sync'));

  with active_awards as (
    select
      award.id,
      award.name,
      award.slug,
      award.official_homepage
    from public.shared_awards award
    where award.status = 'active'
  ),
  latest_audit as (
    select distinct on (audit.shared_award_id)
      audit.*
    from public.shared_award_page_audits audit
    join active_awards award
      on award.id = audit.shared_award_id
    order by audit.shared_award_id, audit.created_at desc, audit.id desc
  ),
  latest_reconciliation as (
    select distinct on (queue.shared_award_id)
      queue.*
    from public.shared_award_reconciliation_queue queue
    join active_awards award
      on award.id = queue.shared_award_id
    order by queue.shared_award_id, queue.created_at desc, queue.id desc
  ),
  page_audit_batch_request_state as (
    select
      attempt.gemini_batch_request_key,
      count(*) filter (
        where attempt.ai_result is null
           or jsonb_typeof(attempt.ai_result) = 'null'
      ) as active_attempt_count,
      count(*) filter (
        where attempt.ai_result is not null
          and jsonb_typeof(attempt.ai_result) <> 'null'
          and attempt.ai_result ->> 'error' in ('invalid_json', 'missing_batch_response')
      ) as retryable_failure_count,
      count(*) filter (
        where attempt.ai_result is not null
          and jsonb_typeof(attempt.ai_result) <> 'null'
          and coalesce(attempt.ai_result ->> 'error', '') not in (
            'invalid_json',
            'missing_batch_response'
          )
      ) as successful_attempt_count,
      jsonb_agg(
        jsonb_build_object(
          'id', attempt.id,
          'audit_status', attempt.audit_status,
          'severity', attempt.severity,
          'model', attempt.model,
          'gemini_batch_name', attempt.gemini_batch_name,
          'gemini_batch_request_key', attempt.gemini_batch_request_key,
          'ai_result', attempt.ai_result,
          'created_at', attempt.created_at,
          'resolved_at', attempt.resolved_at
        )
        order by attempt.created_at, attempt.id
      ) as attempts
    from public.shared_award_page_audits attempt
    where attempt.audit_kind = 'gemini_batch'
      and attempt.gemini_batch_request_key is not null
    group by attempt.gemini_batch_request_key
  ),
  public_page_candidates as (
    select
      award.id as shared_award_id,
      award.name as award_name,
      award.slug as award_slug,
      award.official_homepage,
      audit.id as audit_id,
      audit.audit_kind,
      audit.audit_status,
      audit.severity as audit_severity,
      audit.resolved_at as audit_resolved_at,
      audit.created_at as audit_created_at,
      audit.findings,
      audit.suggested_fixes,
      audit.field_conflicts,
      audit.selected_fact_summary,
      audit.public_page_snapshot,
      audit.model as audit_model,
      audit.gemini_batch_name,
      audit.gemini_batch_request_key,
      audit.ai_result,
      reconciliation.id as reconciliation_id,
      reconciliation.status as reconciliation_status,
      reconciliation.reason as reconciliation_reason,
      reconciliation.error as reconciliation_error,
      reconciliation.metadata as reconciliation_metadata,
      reconciliation.created_at as reconciliation_created_at,
      reconciliation.completed_at as reconciliation_completed_at,
      coalesce(batch_state.active_attempt_count, 0) as audit_active_attempt_count,
      coalesce(batch_state.retryable_failure_count, 0) as audit_retryable_failure_count,
      coalesce(batch_state.successful_attempt_count, 0) as audit_successful_attempt_count,
      coalesce(batch_state.attempts, '[]'::jsonb) as audit_batch_attempts,
      audit.id is not null
        and audit.resolved_at is null
        and audit.audit_status in ('failed', 'needs_review')
        and audit.severity in ('error', 'critical') as audit_requires_action,
      reconciliation.id is not null
        and reconciliation.status = 'failed' as reconciliation_requires_action,
      audit.id is not null
        and audit.audit_kind = 'gemini_batch'
        and audit.gemini_batch_request_key is not null
        and audit.resolved_at is null
        and audit.audit_status in ('failed', 'needs_review')
        and audit.severity in ('error', 'critical')
        and coalesce(batch_state.retryable_failure_count, 0) >= 2
        and coalesce(batch_state.active_attempt_count, 0) = 0
        and coalesce(batch_state.successful_attempt_count, 0) = 0 as audit_terminal
    from active_awards award
    left join latest_audit audit
      on audit.shared_award_id = award.id
    left join latest_reconciliation reconciliation
      on reconciliation.shared_award_id = award.id
    left join page_audit_batch_request_state batch_state
      on batch_state.gemini_batch_request_key = audit.gemini_batch_request_key
  ),
  public_page_cases as (
    select
      'public-page:' || candidate.shared_award_id::text as quarantine_key,
      'public-page:' || candidate.shared_award_id::text as case_key,
      candidate.*,
      candidate.reconciliation_requires_action or candidate.audit_terminal as terminal,
      jsonb_build_object(
        'audit', case
          when candidate.audit_requires_action then jsonb_build_object(
            'id', candidate.audit_id,
            'kind', candidate.audit_kind,
            'status', candidate.audit_status,
            'severity', candidate.audit_severity,
            'findings', candidate.findings,
            'suggested_fixes', candidate.suggested_fixes,
            'field_conflicts', candidate.field_conflicts,
            'selected_fact_summary', candidate.selected_fact_summary,
            'public_page_snapshot', candidate.public_page_snapshot,
            'model', candidate.audit_model,
            'gemini_batch_name', candidate.gemini_batch_name,
            'gemini_batch_request_key', candidate.gemini_batch_request_key,
            'ai_result', candidate.ai_result,
            'created_at', candidate.audit_created_at
          )
          else null
        end,
        'page_audit_batch_attempts', case
          when candidate.audit_kind = 'gemini_batch'
            and candidate.gemini_batch_request_key is not null then jsonb_build_object(
              'request_key', candidate.gemini_batch_request_key,
              'active_attempt_count', candidate.audit_active_attempt_count,
              'retryable_failure_count', candidate.audit_retryable_failure_count,
              'successful_attempt_count', candidate.audit_successful_attempt_count,
              'retry_limit_reached', candidate.audit_terminal,
              'attempts', candidate.audit_batch_attempts
            )
          else null
        end,
        'latest_reconciliation', case
          when not candidate.reconciliation_requires_action then null
          else jsonb_build_object(
            'id', candidate.reconciliation_id,
            'status', candidate.reconciliation_status,
            'reason', candidate.reconciliation_reason,
            'error', candidate.reconciliation_error,
            'metadata', candidate.reconciliation_metadata,
            'created_at', candidate.reconciliation_created_at,
            'completed_at', candidate.reconciliation_completed_at
          )
        end,
        'award', jsonb_build_object(
          'id', candidate.shared_award_id,
          'name', candidate.award_name,
          'slug', candidate.award_slug,
          'official_homepage', candidate.official_homepage
        )
      ) as evidence
    from public_page_candidates candidate
    where candidate.audit_requires_action
       or candidate.reconciliation_requires_action
  ),
  upserted_public_pages as (
    insert into public.manual_quarantine_registry (
      quarantine_key,
      case_key,
      classification,
      category,
      status,
      requires_action,
      terminal,
      terminal_failure_count,
      severity,
      public_impact,
      owner,
      retry_mode,
      retry_charge,
      title,
      reason_code,
      reason,
      recommended_action,
      shared_award_id,
      primary_source_table,
      primary_source_record_id,
      evidence_record_count,
      evidence,
      evidence_hash,
      first_observed_at,
      last_observed_at,
      quarantined_at,
      resolved_at,
      resolved_by,
      resolution_note
    )
    select
      page.quarantine_key,
      page.case_key,
      'actionable_quarantine',
      'public_page',
      'quarantined',
      true,
      page.terminal,
      case when page.reconciliation_requires_action then 1 else 0 end
        + case when page.audit_terminal then 1 else 0 end,
      'high',
      case when page.reconciliation_requires_action then 'protected' else 'unknown' end,
      'Public page review',
      'operator_after_repair',
      'may_charge',
      coalesce(nullif(page.award_name, ''), 'Unknown award') || ': public page needs review',
      case
        when page.reconciliation_requires_action then 'latest_reconciliation_failed'
        when page.audit_terminal then 'page_audit_retry_limit_reached'
        else 'latest_page_audit_requires_review'
      end,
      coalesce(
        nullif(page.reconciliation_error, ''),
        nullif(page.reconciliation_reason, ''),
        nullif(page.evidence -> 'audit' -> 'findings' -> 0 ->> 'message', ''),
        case
          when page.audit_terminal then
            'The latest page audit exhausted two Gemini Batch attempts with retryable response failures.'
          when page.audit_requires_action then 'The latest public-page audit remains unresolved.'
          else 'The latest public-page reconciliation failed.'
        end
      ),
      case
        when page.reconciliation_requires_action and page.audit_requires_action then
          'Inspect the linked audit and reconciliation evidence, repair this award only, then rerun reconciliation and its page audit.'
        when page.reconciliation_requires_action then
          'Inspect the reconciliation evidence, repair this award only, then rerun reconciliation and its page audit.'
        when page.audit_terminal then
          'Inspect the two failed page-audit attempts before explicitly approving another Gemini Batch attempt; retrying may create a charge.'
        else
          'Verify whether the critical audit affected published facts, repair this award only, then rerun reconciliation and its page audit.'
      end,
      page.shared_award_id,
      case
        when page.audit_requires_action then 'shared_award_page_audits'
        else 'shared_award_reconciliation_queue'
      end,
      case
        when page.audit_requires_action then page.audit_id
        else page.reconciliation_id
      end,
      case when page.audit_requires_action then 1 else 0 end
        + case when page.reconciliation_requires_action then 1 else 0 end,
      page.evidence,
      public.manual_quarantine_evidence_hash(page.evidence),
      case
        when page.audit_requires_action and page.reconciliation_requires_action then
          least(page.audit_created_at, page.reconciliation_created_at)
        when page.audit_requires_action then page.audit_created_at
        else page.reconciliation_created_at
      end,
      case
        when page.audit_requires_action and page.reconciliation_requires_action then greatest(
          page.audit_created_at,
          coalesce(page.reconciliation_completed_at, page.reconciliation_created_at)
        )
        when page.audit_requires_action then page.audit_created_at
        else coalesce(page.reconciliation_completed_at, page.reconciliation_created_at)
      end,
      v_now,
      null,
      null,
      null
    from public_page_cases page
    on conflict (quarantine_key) do update set
      case_key = excluded.case_key,
      classification = excluded.classification,
      category = excluded.category,
      status = case
        when public.manual_quarantine_registry.status = 'in_review' then 'in_review'
        else 'quarantined'
      end,
      requires_action = excluded.requires_action,
      terminal = excluded.terminal,
      terminal_failure_count = excluded.terminal_failure_count,
      severity = excluded.severity,
      public_impact = excluded.public_impact,
      owner = excluded.owner,
      retry_mode = excluded.retry_mode,
      retry_charge = excluded.retry_charge,
      title = excluded.title,
      reason_code = excluded.reason_code,
      reason = excluded.reason,
      recommended_action = excluded.recommended_action,
      policy_id = 'awardping-manual-quarantine',
      policy_version = '1',
      policy_hash = '4a12c7a0c4e088bca3b5c4b9ef28c6ddb8b108ac8b324c23dbde4aa5e0646ae4',
      shared_award_id = excluded.shared_award_id,
      primary_source_table = excluded.primary_source_table,
      primary_source_record_id = excluded.primary_source_record_id,
      evidence_record_count = excluded.evidence_record_count,
      evidence = excluded.evidence,
      evidence_hash = excluded.evidence_hash,
      first_observed_at = least(
        public.manual_quarantine_registry.first_observed_at,
        excluded.first_observed_at
      ),
      last_observed_at = excluded.last_observed_at,
      quarantined_at = case
        when public.manual_quarantine_registry.status = 'resolved' then v_now
        else public.manual_quarantine_registry.quarantined_at
      end,
      resolved_at = null,
      resolved_by = null,
      resolution_note = null
    returning id
  )
  select count(*) into v_write_count
  from upserted_public_pages;

  with terminal_visuals as (
    select
      candidate.*,
      award.name as award_name,
      award.slug as award_slug,
      source.title as current_source_title,
      source.display_title as current_display_title,
      source.url as current_source_url,
      coalesce(
        case
          when candidate.worker_metadata ->> 'failure_retry_count' ~ '^[0-9]+$'
            then (candidate.worker_metadata ->> 'failure_retry_count')::integer
        end,
        0
      ) as retry_count
    from public.shared_award_visual_review_candidates candidate
    join public.shared_awards award
      on award.id = candidate.shared_award_id
     and award.status = 'active'
    left join public.shared_award_sources source
      on source.id = candidate.shared_award_source_id
    where candidate.status = 'failed'
      and case
        when lower(btrim(coalesce(candidate.rejection_reason, ''))) = 'missing_batch_response'
          then false
        when lower(btrim(coalesce(candidate.rejection_reason, ''))) =
          'manual_recovery_required_possible_external_batch_created'
          then true
        when coalesce(
          case
            when candidate.worker_metadata ->> 'failure_retry_count' ~ '^[0-9]+$'
              then (candidate.worker_metadata ->> 'failure_retry_count')::integer
          end,
          0
        ) >= 3 then true
        else false
      end
  ),
  visual_cases as (
    select
      visual.*,
      jsonb_build_object(
        'candidate', jsonb_build_object(
          'id', visual.id,
          'candidate_signature', visual.candidate_signature,
          'status', visual.status,
          'rejection_reason', visual.rejection_reason,
          'gemini_batch_name', visual.gemini_batch_name,
          'gemini_batch_request_key', visual.gemini_batch_request_key,
          'model', visual.model,
          'submitted_at', visual.submitted_at,
          'completed_at', visual.completed_at,
          'published_at', visual.published_at,
          'ai_result', visual.ai_result,
          'actual_usage', visual.actual_usage,
          'retry_count', visual.retry_count,
          'estimated_cost_usd', visual.estimated_cost_usd,
          'worker_metadata', visual.worker_metadata,
          'previous_snapshot_ref', visual.previous_snapshot_ref,
          'new_snapshot_ref', visual.new_snapshot_ref,
          'previous_text_hash', visual.previous_text_hash,
          'new_text_hash', visual.new_text_hash,
          'previous_image_hash', visual.previous_image_hash,
          'new_image_hash', visual.new_image_hash,
          'previous_file_hash', visual.previous_file_hash,
          'new_file_hash', visual.new_file_hash,
          'deterministic_diff', visual.deterministic_diff,
          'deterministic_classification', visual.deterministic_classification,
          'prompt_payload', visual.prompt_payload,
          'prompt_context', visual.prompt_context,
          'publication_claim_token', visual.publication_claim_token,
          'publication_claimed_at', visual.publication_claimed_at,
          'created_at', visual.created_at,
          'updated_at', visual.updated_at
        ),
        'award', jsonb_build_object(
          'id', visual.shared_award_id,
          'name', visual.award_name,
          'slug', visual.award_slug
        ),
        'source', jsonb_build_object(
          'id', visual.shared_award_source_id,
          'title', coalesce(
            nullif(visual.current_display_title, ''),
            nullif(visual.current_source_title, ''),
            nullif(visual.source_title, '')
          ),
          'url', coalesce(nullif(visual.current_source_url, ''), visual.source_url)
        )
      ) as evidence
    from terminal_visuals visual
  ),
  upserted_visuals as (
    insert into public.manual_quarantine_registry (
      quarantine_key,
      case_key,
      classification,
      category,
      status,
      requires_action,
      terminal,
      terminal_failure_count,
      severity,
      public_impact,
      owner,
      retry_mode,
      retry_charge,
      title,
      reason_code,
      reason,
      recommended_action,
      shared_award_id,
      shared_award_source_id,
      visual_review_candidate_id,
      primary_source_table,
      primary_source_record_id,
      evidence_record_count,
      evidence,
      evidence_hash,
      first_observed_at,
      last_observed_at,
      quarantined_at,
      resolved_at,
      resolved_by,
      resolution_note
    )
    select
      'visual-review:' || visual.id::text,
      'visual-review:' || visual.id::text,
      'actionable_quarantine',
      'visual_review',
      'quarantined',
      true,
      true,
      1,
      'high',
      'delayed',
      'AI review',
      case
        when lower(btrim(coalesce(visual.rejection_reason, ''))) =
          'manual_recovery_required_possible_external_batch_created'
          then 'operator_before_retry'
        else 'retry_limit_reached'
      end,
      case
        when lower(btrim(coalesce(visual.rejection_reason, ''))) =
          'manual_recovery_required_possible_external_batch_created'
          then 'unknown'
        else 'will_charge'
      end,
      coalesce(
        nullif(visual.current_display_title, ''),
        nullif(visual.current_source_title, ''),
        nullif(visual.source_title, ''),
        visual.source_url,
        'Visual review candidate'
      ) || ': visual review is quarantined',
      coalesce(nullif(visual.rejection_reason, ''), 'visual_review_terminal_failure'),
      coalesce(
        nullif(visual.rejection_reason, ''),
        'The visual review reached a terminal failure without a recorded reason.'
      ),
      case
        when lower(btrim(coalesce(visual.rejection_reason, ''))) =
          'manual_recovery_required_possible_external_batch_created'
          then 'Reconcile the possible existing Gemini Batch before any new submission; a blind retry could duplicate a charge.'
        else 'Inspect the immutable candidate evidence and failure history before explicitly approving another paid visual-review attempt.'
      end,
      visual.shared_award_id,
      visual.shared_award_source_id,
      visual.id,
      'shared_award_visual_review_candidates',
      visual.id,
      1,
      visual.evidence,
      public.manual_quarantine_evidence_hash(visual.evidence),
      visual.created_at,
      visual.updated_at,
      v_now,
      null,
      null,
      null
    from visual_cases visual
    on conflict (quarantine_key) do update set
      case_key = excluded.case_key,
      classification = excluded.classification,
      category = excluded.category,
      status = case
        when public.manual_quarantine_registry.status = 'in_review' then 'in_review'
        else 'quarantined'
      end,
      requires_action = true,
      terminal = true,
      terminal_failure_count = 1,
      severity = excluded.severity,
      public_impact = excluded.public_impact,
      owner = excluded.owner,
      retry_mode = excluded.retry_mode,
      retry_charge = excluded.retry_charge,
      title = excluded.title,
      reason_code = excluded.reason_code,
      reason = excluded.reason,
      recommended_action = excluded.recommended_action,
      policy_id = 'awardping-manual-quarantine',
      policy_version = '1',
      policy_hash = '4a12c7a0c4e088bca3b5c4b9ef28c6ddb8b108ac8b324c23dbde4aa5e0646ae4',
      shared_award_id = excluded.shared_award_id,
      shared_award_source_id = excluded.shared_award_source_id,
      visual_review_candidate_id = excluded.visual_review_candidate_id,
      primary_source_table = excluded.primary_source_table,
      primary_source_record_id = excluded.primary_source_record_id,
      evidence_record_count = excluded.evidence_record_count,
      evidence = excluded.evidence,
      evidence_hash = excluded.evidence_hash,
      first_observed_at = least(
        public.manual_quarantine_registry.first_observed_at,
        excluded.first_observed_at
      ),
      last_observed_at = excluded.last_observed_at,
      quarantined_at = case
        when public.manual_quarantine_registry.status = 'resolved' then v_now
        else public.manual_quarantine_registry.quarantined_at
      end,
      resolved_at = null,
      resolved_by = null,
      resolution_note = null
    returning id
  )
  select count(*) into v_write_count
  from upserted_visuals;

  with public_resolution_cases as (
    select
      registry.id,
      case
        when award.id is null then 'The award record is no longer available.'
        when award.status <> 'active' then 'The award is no longer active.'
        else 'Newer safe page-audit and reconciliation states superseded this quarantine.'
      end as resolution_note,
      registry.evidence || jsonb_build_object(
        'resolution',
        jsonb_strip_nulls(jsonb_build_object(
          'resolved_at', v_now,
          'reason', case
            when award.id is null then 'award_missing'
            when award.status <> 'active' then 'award_inactive'
            else 'newer_safe_page_states'
          end,
          'award_status', award.status,
          'latest_page_audit', case when audit.id is null then null else jsonb_build_object(
            'id', audit.id,
            'audit_status', audit.audit_status,
            'severity', audit.severity,
            'resolved_at', audit.resolved_at,
            'created_at', audit.created_at
          ) end,
          'latest_reconciliation', case when reconciliation.id is null then null else jsonb_build_object(
            'id', reconciliation.id,
            'status', reconciliation.status,
            'reason', reconciliation.reason,
            'error', reconciliation.error,
            'created_at', reconciliation.created_at,
            'completed_at', reconciliation.completed_at
          ) end
        ))
      ) as resolved_evidence
    from public.manual_quarantine_registry registry
    left join public.shared_awards award
      on award.id = registry.shared_award_id
    left join lateral (
      select audit.*
      from public.shared_award_page_audits audit
      where audit.shared_award_id = registry.shared_award_id
      order by audit.created_at desc, audit.id desc
      limit 1
    ) audit on true
    left join lateral (
      select queue.*
      from public.shared_award_reconciliation_queue queue
      where queue.shared_award_id = registry.shared_award_id
      order by queue.created_at desc, queue.id desc
      limit 1
    ) reconciliation on true
    where registry.category = 'public_page'
      and registry.status in ('quarantined', 'in_review')
      and not coalesce((
        award.status = 'active'
        and (
          (
            audit.id is not null
            and audit.resolved_at is null
            and audit.audit_status in ('failed', 'needs_review')
            and audit.severity in ('error', 'critical')
          )
          or (
            reconciliation.id is not null
            and reconciliation.status = 'failed'
          )
        )
      ), false)
  )
  update public.manual_quarantine_registry registry
  set
    status = 'resolved',
    resolved_at = v_now,
    resolved_by = 'manual-quarantine-sync',
    resolution_note = resolution.resolution_note,
    evidence = resolution.resolved_evidence,
    evidence_hash = public.manual_quarantine_evidence_hash(resolution.resolved_evidence)
  from public_resolution_cases resolution
  where registry.id = resolution.id;

  with visual_resolution_cases as (
    select
      registry.id,
      case
        when candidate.id is null then 'The visual candidate is no longer available.'
        when award.id is null then 'The award record is no longer available.'
        when award.status <> 'active' then 'The award is no longer active.'
        else 'The visual candidate left its terminal failed state.'
      end as resolution_note,
      registry.evidence || jsonb_build_object(
        'resolution',
        jsonb_strip_nulls(jsonb_build_object(
          'resolved_at', v_now,
          'reason', case
            when candidate.id is null then 'visual_candidate_missing'
            when award.id is null then 'award_missing'
            when award.status <> 'active' then 'award_inactive'
            else 'visual_candidate_left_terminal_state'
          end,
          'award_status', award.status,
          'candidate', case when candidate.id is null then null else jsonb_build_object(
            'id', candidate.id,
            'status', candidate.status,
            'rejection_reason', candidate.rejection_reason,
            'failure_retry_count', case
              when candidate.worker_metadata ->> 'failure_retry_count' ~ '^[0-9]+$'
                then (candidate.worker_metadata ->> 'failure_retry_count')::integer
              else 0
            end,
            'worker_metadata', candidate.worker_metadata,
            'updated_at', candidate.updated_at
          ) end
        ))
      ) as resolved_evidence
    from public.manual_quarantine_registry registry
    left join public.shared_award_visual_review_candidates candidate
      on candidate.id = registry.primary_source_record_id
    left join public.shared_awards award
      on award.id = registry.shared_award_id
    where registry.category = 'visual_review'
      and registry.status in ('quarantined', 'in_review')
      and not coalesce((
        award.status = 'active'
        and candidate.status = 'failed'
        and case
          when lower(btrim(coalesce(candidate.rejection_reason, ''))) = 'missing_batch_response'
            then false
          when lower(btrim(coalesce(candidate.rejection_reason, ''))) =
            'manual_recovery_required_possible_external_batch_created'
            then true
          when coalesce(
            case
              when candidate.worker_metadata ->> 'failure_retry_count' ~ '^[0-9]+$'
                then (candidate.worker_metadata ->> 'failure_retry_count')::integer
            end,
            0
          ) >= 3 then true
          else false
        end
      ), false)
  )
  update public.manual_quarantine_registry registry
  set
    status = 'resolved',
    resolved_at = v_now,
    resolved_by = 'manual-quarantine-sync',
    resolution_note = resolution.resolution_note,
    evidence = resolution.resolved_evidence,
    evidence_hash = public.manual_quarantine_evidence_hash(resolution.resolved_evidence)
  from visual_resolution_cases resolution
  where registry.id = resolution.id;

  v_result := public.refresh_manual_quarantine_registry_state(v_now);
  return v_result;
end;
$$;

revoke all on function public.sync_manual_quarantine_registry()
  from public, anon, authenticated;
grant execute on function public.sync_manual_quarantine_registry()
  to service_role;

create or replace function public.replace_manual_quarantine_historical_limitations(
  p_source_ids uuid[],
  p_reported_at timestamptz,
  p_report_digest text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_requested bigint := 0;
  v_bound bigint := 0;
  v_result jsonb;
  v_write_count bigint := 0;
  v_existing_reported_at timestamptz;
  v_existing_digest text;
begin
  if p_source_ids is null then
    raise exception 'Historical source IDs are required; pass an explicit empty UUID array for a verified empty inventory.';
  end if;
  if array_position(p_source_ids, null) is not null then
    raise exception 'Historical source IDs cannot contain null values.';
  end if;
  if p_reported_at is null then
    raise exception 'A historical localization report timestamp is required.';
  end if;
  if p_reported_at > v_now + interval '5 minutes' then
    raise exception 'Historical localization report timestamp cannot be more than five minutes in the future.';
  end if;
  if p_report_digest is null or p_report_digest !~ '^[0-9a-f]{64}$' then
    raise exception 'A lowercase SHA-256 historical localization report digest is required.';
  end if;

  perform pg_advisory_xact_lock(hashtext('awardping-manual-quarantine-sync'));

  select
    state.historical_inventory_reported_at,
    state.historical_inventory_digest
  into v_existing_reported_at, v_existing_digest
  from public.manual_quarantine_registry_state state
  where state.registry_key = 'one_time_catchup'
  for update;

  if v_existing_reported_at is not null and p_reported_at < v_existing_reported_at then
    raise exception
      'Historical localization inventory timestamp % is older than the current inventory timestamp %.',
      p_reported_at,
      v_existing_reported_at;
  end if;
  if v_existing_reported_at is not null and p_reported_at = v_existing_reported_at then
    if p_report_digest is distinct from v_existing_digest then
      raise exception
        'Historical localization inventory timestamp % was already recorded with a different digest.',
        p_reported_at;
    end if;
    select to_jsonb(state) into v_result
    from public.manual_quarantine_registry_state state
    where state.registry_key = 'one_time_catchup';
    return v_result;
  end if;

  select count(*) into v_requested
  from (
    select distinct requested.source_id
    from unnest(p_source_ids) requested(source_id)
  ) requested;

  -- Keep the retained previous artifact pointers stable between validation and
  -- evidence capture. Monitoring snapshot rotation must wait for this import.
  perform 1
  from public.shared_award_source_visual_snapshots snapshot
  where snapshot.shared_award_source_id = any(p_source_ids)
  for share;

  select count(*) into v_bound
  from (
    select distinct requested.source_id
    from unnest(coalesce(p_source_ids, '{}'::uuid[])) requested(source_id)
    join public.shared_award_source_visual_snapshots snapshot
      on snapshot.shared_award_source_id = requested.source_id
    where jsonb_typeof(snapshot.previous_object_keys) = 'object'
      and jsonb_typeof(snapshot.previous_hashes) = 'object'
      and snapshot.previous_object_keys <> '{}'::jsonb
      and snapshot.previous_hashes <> '{}'::jsonb
      and snapshot.previous_captured_at is not null
      and snapshot.updated_at <= p_reported_at
      and snapshot.previous_captured_at <= p_reported_at
  ) bound;

  if v_bound <> v_requested then
    raise exception
      'Historical localization inventory could bind only % of % source IDs to retained previous object keys and hashes.',
      v_bound,
      v_requested;
  end if;

  with requested as (
    select distinct item.source_id
    from unnest(p_source_ids) item(source_id)
  ),
  historical_cases as (
    select
      requested.source_id,
      snapshot.shared_award_id,
      snapshot.previous_object_keys,
      snapshot.previous_hashes,
      snapshot.previous_metadata,
      snapshot.previous_captured_at,
      snapshot.updated_at as snapshot_updated_at,
      source.url as source_url,
      coalesce(nullif(source.display_title, ''), nullif(source.title, ''), source.url) as source_title,
      award.name as award_name,
      award.slug as award_slug,
      jsonb_build_object(
        'source_id', requested.source_id,
        'award_id', snapshot.shared_award_id,
        'previous_object_keys', snapshot.previous_object_keys,
        'previous_hashes', snapshot.previous_hashes,
        'previous_metadata', snapshot.previous_metadata,
        'previous_captured_at', snapshot.previous_captured_at,
        'snapshot_updated_at', snapshot.updated_at,
        'source_url', source.url,
        'source_title', coalesce(
          nullif(source.display_title, ''),
          nullif(source.title, ''),
          source.url
        ),
        'award_name', award.name,
        'award_slug', award.slug,
        'inventory_reported_at', p_reported_at,
        'inventory_report_digest', p_report_digest
      ) as evidence
    from requested
    join public.shared_award_source_visual_snapshots snapshot
      on snapshot.shared_award_source_id = requested.source_id
    left join public.shared_award_sources source
      on source.id = requested.source_id
    left join public.shared_awards award
      on award.id = snapshot.shared_award_id
  ),
  upserted as (
    insert into public.manual_quarantine_registry (
      quarantine_key,
      case_key,
      classification,
      category,
      status,
      requires_action,
      terminal,
      terminal_failure_count,
      severity,
      public_impact,
      owner,
      retry_mode,
      retry_charge,
      title,
      reason_code,
      reason,
      recommended_action,
      shared_award_id,
      shared_award_source_id,
      primary_source_table,
      primary_source_record_id,
      evidence_record_count,
      evidence,
      evidence_hash,
      first_observed_at,
      last_observed_at,
      quarantined_at,
      resolved_at,
      resolved_by,
      resolution_note
    )
    select
      'historical-snapshot:' || historical.source_id::text,
      'historical-snapshot:' || historical.source_id::text,
      'historical_limitation',
      'historical_localization',
      'quarantined',
      false,
      false,
      0,
      'low',
      'protected',
      'AwardPing evidence history',
      'not_retryable',
      'none',
      coalesce(nullif(historical.source_title, ''), 'Historical screenshot') ||
        ': exact historical location unavailable',
      'historical_layout_unavailable',
      coalesce(
        nullif(historical.previous_metadata -> 'localization' ->> 'reason', ''),
        'This retained previous screenshot predates exact text-rectangle metadata and cannot be reconstructed truthfully from the current page.'
      ),
      'Keep the retained event-specific screenshot and its honest unavailable status; do not substitute a current-page crop.',
      historical.shared_award_id,
      historical.source_id,
      'shared_award_source_visual_snapshots',
      historical.source_id,
      1,
      historical.evidence,
      public.manual_quarantine_evidence_hash(historical.evidence),
      coalesce(historical.previous_captured_at, p_reported_at),
      greatest(historical.snapshot_updated_at, p_reported_at),
      v_now,
      null,
      null,
      null
    from historical_cases historical
    on conflict (quarantine_key) do update set
      case_key = excluded.case_key,
      classification = excluded.classification,
      category = excluded.category,
      status = 'quarantined',
      requires_action = excluded.requires_action,
      terminal = excluded.terminal,
      terminal_failure_count = excluded.terminal_failure_count,
      severity = excluded.severity,
      public_impact = excluded.public_impact,
      owner = excluded.owner,
      retry_mode = excluded.retry_mode,
      retry_charge = excluded.retry_charge,
      title = excluded.title,
      reason_code = excluded.reason_code,
      reason = excluded.reason,
      recommended_action = excluded.recommended_action,
      policy_id = 'awardping-manual-quarantine',
      policy_version = '1',
      policy_hash = '4a12c7a0c4e088bca3b5c4b9ef28c6ddb8b108ac8b324c23dbde4aa5e0646ae4',
      shared_award_id = excluded.shared_award_id,
      shared_award_source_id = excluded.shared_award_source_id,
      visual_review_candidate_id = null,
      primary_source_table = excluded.primary_source_table,
      primary_source_record_id = excluded.primary_source_record_id,
      evidence_record_count = excluded.evidence_record_count,
      evidence = excluded.evidence,
      evidence_hash = excluded.evidence_hash,
      first_observed_at = least(
        public.manual_quarantine_registry.first_observed_at,
        excluded.first_observed_at
      ),
      last_observed_at = excluded.last_observed_at,
      quarantined_at = case
        when public.manual_quarantine_registry.status = 'resolved' then v_now
        else public.manual_quarantine_registry.quarantined_at
      end,
      resolved_at = null,
      resolved_by = null,
      resolution_note = null
    returning id
  )
  select count(*) into v_write_count
  from upserted;

  update public.manual_quarantine_registry registry
  set
    status = 'resolved',
    resolved_at = v_now,
    resolved_by = 'historical-localization-inventory',
    resolution_note = 'A newer complete historical inventory no longer reports this limitation.',
    evidence = registry.evidence || jsonb_build_object(
      'resolution',
      jsonb_build_object(
        'resolved_at', v_now,
        'reason', 'not_in_newer_complete_inventory',
        'inventory_reported_at', p_reported_at,
        'inventory_report_digest', p_report_digest
      )
    ),
    evidence_hash = public.manual_quarantine_evidence_hash(
      registry.evidence || jsonb_build_object(
        'resolution',
        jsonb_build_object(
          'resolved_at', v_now,
          'reason', 'not_in_newer_complete_inventory',
          'inventory_reported_at', p_reported_at,
          'inventory_report_digest', p_report_digest
        )
      )
    )
  where registry.category = 'historical_localization'
    and registry.status in ('quarantined', 'in_review')
    and not exists (
      select 1
      from unnest(p_source_ids) requested(source_id)
      where requested.source_id = registry.shared_award_source_id
    );

  v_result := public.refresh_manual_quarantine_registry_state(v_now);

  update public.manual_quarantine_registry_state
  set
    historical_inventory_status = 'complete',
    historical_limitations = v_requested,
    historical_inventory_reported_at = p_reported_at,
    historical_inventory_digest = p_report_digest,
    last_synced_at = v_now,
    updated_at = v_now
  where registry_key = 'one_time_catchup';

  select to_jsonb(state) into v_result
  from public.manual_quarantine_registry_state state
  where state.registry_key = 'one_time_catchup';
  return v_result;
end;
$$;

revoke all on function public.replace_manual_quarantine_historical_limitations(uuid[], timestamptz, text)
  from public, anon, authenticated;
grant execute on function public.replace_manual_quarantine_historical_limitations(uuid[], timestamptz, text)
  to service_role;

create or replace function public.record_manual_quarantine_completion(
  p_automated_work_clear boolean,
  p_automated_blockers jsonb,
  p_source_worker_run_id uuid default null,
  p_reported_at timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
  v_state public.manual_quarantine_registry_state%rowtype;
begin
  if p_automated_work_clear is null then
    raise exception 'Automated-work state is required.';
  end if;
  if p_reported_at is null then
    raise exception 'Completion report timestamp is required.';
  end if;
  if p_reported_at > clock_timestamp() + interval '5 minutes' then
    raise exception 'Completion report timestamp cannot be more than five minutes in the future.';
  end if;

  v_result := public.sync_manual_quarantine_registry();

  select * into v_state
  from public.manual_quarantine_registry_state state
  where state.registry_key = 'one_time_catchup'
  for update;

  if v_state.completion_reported_at is not null
    and p_reported_at < v_state.completion_reported_at then
    raise exception
      'Completion report timestamp % is older than the current report timestamp %.',
      p_reported_at,
      v_state.completion_reported_at;
  end if;
  if v_state.completion_reported_at is not null
    and p_reported_at = v_state.completion_reported_at then
    if v_state.automated_work_clear is distinct from p_automated_work_clear
      or v_state.automated_blockers is distinct from coalesce(p_automated_blockers, '{}'::jsonb)
      or v_state.source_worker_run_id is distinct from p_source_worker_run_id then
      raise exception
        'Completion report timestamp % was already recorded with different state.',
        p_reported_at;
    end if;
    return to_jsonb(v_state);
  end if;

  update public.manual_quarantine_registry_state
  set
    automated_work_clear = p_automated_work_clear,
    automated_blockers = coalesce(p_automated_blockers, '{}'::jsonb),
    completion_status = case
      when p_automated_work_clear then 'automated_work_clear'
      else 'automated_work_remaining'
    end,
    source_worker_run_id = p_source_worker_run_id,
    completion_reported_at = p_reported_at,
    updated_at = clock_timestamp()
  where registry_key = 'one_time_catchup';

  select to_jsonb(state) into v_result
  from public.manual_quarantine_registry_state state
  where state.registry_key = 'one_time_catchup';
  return v_result;
end;
$$;

revoke all on function public.record_manual_quarantine_completion(boolean, jsonb, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.record_manual_quarantine_completion(boolean, jsonb, uuid, timestamptz)
  to service_role;

-- Backfill all database-backed current cases now. Historical source IDs are
-- intentionally imported separately from the exact local audit report; zero
-- is never used as a substitute for a missing inventory.
select public.sync_manual_quarantine_registry();

do $$
declare
  v_run public.local_worker_runs%rowtype;
  v_completion jsonb;
  v_clear boolean;
begin
  select * into v_run
  from public.local_worker_runs
  where worker_name = 'local-one-time-catchup-processor'
  order by started_at desc, id desc
  limit 1;

  if found then
    v_completion := coalesce(v_run.metadata -> 'completion', '{}'::jsonb);
    v_clear := case
      when lower(coalesce(v_completion ->> 'automated_work_clear', '')) = 'true' then true
      when lower(coalesce(v_completion ->> 'automated_work_clear', '')) = 'false' then false
      when lower(coalesce(v_completion ->> 'automated_complete', '')) = 'true' then true
      when lower(coalesce(v_completion ->> 'automated_complete', '')) = 'false' then false
      else null
    end;
    if v_clear is not null then
      perform public.record_manual_quarantine_completion(
        v_clear,
        coalesce(v_completion -> 'automated_blockers', '{}'::jsonb),
        v_run.id,
        coalesce(v_run.finished_at, v_run.started_at, now())
      );
    end if;
  end if;
end;
$$;

comment on table public.manual_quarantine_registry is
  'Durable current quarantine cases. Linked audit and reconciliation evidence share one public-page case, while terminal visual candidates and historical limitations retain their own cases.';
comment on table public.manual_quarantine_registry_events is
  'Append-only snapshots for every quarantine opening, reopening, evidence revision, and status transition.';
comment on table public.manual_quarantine_registry_state is
  'Truthful catch-up accounting: automated work, actionable quarantine, imported historical limitations, and terminal failures are reported independently.';
