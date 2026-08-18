-- Scheduled regression scans are durable observations, not fact-publication
-- commits. Keep them idempotent and atomic while reserving deterministic
-- reconciliation audits as the canonical Stage 1 ledger binding. A blocking
-- observation is nevertheless a fail-closed publication invalidation: the
-- affected award, national release epoch, and any unconsumed acceptance must
-- stop being usable in the same transaction that records the observation.

create table if not exists public.shared_award_regression_audit_state (
  shared_award_id uuid primary key references public.shared_awards(id) on delete cascade,
  last_attempted_at timestamptz,
  last_succeeded_at timestamptz,
  last_evaluated_at timestamptz,
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  next_retry_at timestamptz not null default '-infinity'::timestamptz,
  last_operational_error text,
  last_audit_error text,
  last_audit_id uuid references public.shared_award_page_audits(id) on delete set null,
  last_observation_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (last_operational_error is null or pg_catalog.length(last_operational_error) <= 1000),
  check (last_audit_error is null or pg_catalog.length(last_audit_error) <= 1000)
);

alter table public.shared_award_regression_audit_state
  add column if not exists last_evaluated_at timestamptz;

alter table public.shared_award_regression_audit_state enable row level security;
revoke all on table public.shared_award_regression_audit_state from public, anon, authenticated;
grant all on table public.shared_award_regression_audit_state to service_role;

create index if not exists shared_award_regression_audit_state_rotation_idx
  on public.shared_award_regression_audit_state (
    next_retry_at asc,
    last_attempted_at asc nulls first,
    shared_award_id asc
  );

create or replace function private.regression_audit_stable_value(
  p_value jsonb,
  p_parent_key text default null
)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if p_value is null then
    return null;
  end if;

  if pg_catalog.jsonb_typeof(p_value) = 'object' then
    select coalesce(
      pg_catalog.jsonb_object_agg(
        entry.key,
        private.regression_audit_stable_value(entry.value, entry.key)
        order by entry.key
      ),
      '{}'::jsonb
    )
    into v_result
    from pg_catalog.jsonb_each(p_value) entry
    where entry.key <> 'observation_key'
      and not (
        coalesce(p_parent_key = 'public_page_snapshot', false)
        and entry.key = 'evaluated_at'
      )
      and not (
        coalesce(p_parent_key = 'reconciliation', false)
        and entry.key = 'generated_at'
      );
    return v_result;
  end if;

  if pg_catalog.jsonb_typeof(p_value) = 'array' then
    select coalesce(
      pg_catalog.jsonb_agg(
        private.regression_audit_stable_value(entry.value, p_parent_key)
        order by entry.ordinality
      ),
      '[]'::jsonb
    )
    into v_result
    from pg_catalog.jsonb_array_elements(p_value) with ordinality entry(value, ordinality);
    return v_result;
  end if;

  return p_value;
end;
$$;

revoke all on function private.regression_audit_stable_value(jsonb, text)
  from public, anon, authenticated, service_role;

-- A regression evaluation must consume one complete, deterministic database
-- snapshot. The same basis is hashed by the selector and recomputed by the
-- writer after it has locked the award and every one of its source rows.
create or replace function private.regression_audit_evaluation_basis(
  p_shared_award_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'contract_version', 'stage1-regression-evaluation-v1',
    'award', pg_catalog.jsonb_build_object(
      'id', award.id,
      'name', award.name,
      'slug', award.slug,
      'official_homepage', award.official_homepage,
      'summary', award.summary,
      'public_facts', award.public_facts,
      'confidence', award.confidence,
      'status', award.status
    ),
    'sources', coalesce(source_inputs.value, '[]'::jsonb)
  )
  from public.shared_awards award
  left join lateral (
    select pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'id', source_row.id,
        'shared_award_id', source_row.shared_award_id,
        'url', source_row.url,
        'title', source_row.title,
        'display_title', source_row.display_title,
        'page_description', source_row.page_description,
        'page_metadata', source_row.page_metadata,
        'page_metadata_generated_at', case
          when source_row.page_metadata_generated_at is null then null
          else pg_catalog.to_char(
            source_row.page_metadata_generated_at at time zone 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
          )
        end,
        'page_metadata_model', source_row.page_metadata_model,
        'page_type', source_row.page_type,
        'source', source_row.source,
        'reason', source_row.reason,
        'submitted_by_user_id', source_row.submitted_by_user_id,
        'admin_review_status', source_row.admin_review_status,
        'confidence', source_row.confidence
      )
      order by
        source_row.page_metadata_generated_at desc nulls last,
        source_row.id asc
    ) as value
    from public.shared_award_sources source_row
    where source_row.shared_award_id = award.id
      and source_row.admin_review_status = 'open'
  ) source_inputs on true
  where award.id = p_shared_award_id;
$$;

revoke all on function private.regression_audit_evaluation_basis(uuid)
  from public, anon, authenticated, service_role;

-- Legacy audit rows predate the immutable evaluation envelope. Treat an
-- invalid timestamp conservatively as the row creation time when deciding
-- whether a later accepted pass may resolve it.
create or replace function private.regression_audit_evaluated_at(
  p_snapshot jsonb,
  p_fallback timestamptz
)
returns timestamptz
language plpgsql
stable
set search_path = ''
as $$
begin
  if pg_catalog.jsonb_typeof(p_snapshot) = 'object'
    and nullif(pg_catalog.btrim(p_snapshot ->> 'evaluated_at'), '') is not null then
    begin
      return (p_snapshot ->> 'evaluated_at')::timestamptz;
    exception when others then
      return p_fallback;
    end;
  end if;
  return p_fallback;
end;
$$;

revoke all on function private.regression_audit_evaluated_at(jsonb, timestamptz)
  from public, anon, authenticated, service_role;

create or replace function public.list_shared_awards_for_regression_audit(
  p_limit integer default 25,
  p_slugs text[] default null,
  p_include_deferred boolean default false
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.to_jsonb(candidate)
      order by
        candidate.regression_last_attempted_at asc nulls first,
        candidate.created_at asc,
        candidate.id asc
    ),
    '[]'::jsonb
  )
  from (
    select
      award.id,
      award.name,
      award.slug,
      award.official_homepage,
      award.summary,
      award.public_facts,
      award.confidence,
      award.status,
      award.created_at,
      pg_catalog.jsonb_build_object(
        'contract_version', evaluation_basis.value ->> 'contract_version',
        'revision', public.stage1_publication_evidence_hash(evaluation_basis.value),
        'selected_at', pg_catalog.to_char(
          pg_catalog.statement_timestamp() at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        ),
        'source_count', pg_catalog.jsonb_array_length(
          evaluation_basis.value -> 'sources'
        ),
        'award', evaluation_basis.value -> 'award',
        'sources', evaluation_basis.value -> 'sources'
      ) as regression_evaluation,
      state.last_attempted_at as regression_last_attempted_at,
      state.next_retry_at as regression_next_retry_at,
      state.consecutive_failures as regression_consecutive_failures
    from public.shared_awards award
    cross join lateral (
      select private.regression_audit_evaluation_basis(award.id) as value
    ) evaluation_basis
    left join public.shared_award_regression_audit_state state
      on state.shared_award_id = award.id
    where award.status = 'active'
      and evaluation_basis.value is not null
      and (
        p_slugs is null
        or pg_catalog.cardinality(p_slugs) = 0
        or award.slug = any(p_slugs)
      )
      and (
        p_include_deferred
        or state.next_retry_at is null
        or state.next_retry_at <= pg_catalog.statement_timestamp()
      )
    order by
      state.last_attempted_at asc nulls first,
      award.created_at asc,
      award.id asc
    limit greatest(1, least(coalesce(p_limit, 25), 250))
  ) candidate;
$$;

revoke all on function public.list_shared_awards_for_regression_audit(integer, text[], boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.list_shared_awards_for_regression_audit(integer, text[], boolean)
  to service_role;

create unique index if not exists shared_award_page_audits_regression_observation_idx
  on public.shared_award_page_audits (
    shared_award_id,
    ((public_page_snapshot ->> 'observation_key'))
  )
  where audit_kind = 'regression'
    and public_page_snapshot ->> 'observation_key' is not null
    and resolved_at is null;

create or replace function private.invalidate_stage1_release_for_regression_audit(
  p_shared_award_id uuid,
  p_regression_audit_id uuid,
  p_observation_key text,
  p_blocked_at timestamptz
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_cohort_key text;
  v_registry public.stage1_award_registry%rowtype;
  v_release public.stage1_publication_release_state%rowtype;
  v_regression_audit public.shared_award_page_audits%rowtype;
  v_deterministic_audit_id uuid;
  v_award_invalidated boolean := false;
  v_release_invalidated boolean := false;
  v_rejected_acceptances integer := 0;
  v_cleared_release_epochs integer := 0;
  v_additional_cleared_release_epochs integer := 0;
  v_reason text;
  v_evidence jsonb;
begin
  if p_shared_award_id is null
    or p_regression_audit_id is null
    or p_observation_key is null
    or p_observation_key !~ '^[0-9a-f]{64}$'
    or p_blocked_at is null then
    raise exception using
      errcode = '22023',
      message = 'Stage 1 regression invalidation requires an award, audit, observation key, and timestamp.';
  end if;

  -- Always take the national fence before an audit, award, registry, or
  -- release row lock. The caller normally already owns it, so this is a
  -- cheap re-entrant guard that also makes the private helper safe in
  -- isolation.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('stage1-national-25-release', 0)
  );

  select * into v_regression_audit
  from public.shared_award_page_audits audit
  where audit.id = p_regression_audit_id
    and audit.shared_award_id = p_shared_award_id
    and audit.audit_kind = 'regression'
    and audit.resolved_at is null
    and audit.public_page_snapshot ->> 'observation_key' = p_observation_key
    and (
      audit.audit_status in ('failed', 'needs_review')
      or audit.severity in ('error', 'critical')
    )
  for update;
  if not found then
    raise exception using
      errcode = '23514',
      message = 'Stage 1 regression invalidation requires the exact unresolved blocking regression observation.';
  end if;

  select member.cohort_key
  into v_cohort_key
  from public.stage1_award_members member
  where member.shared_award_id = p_shared_award_id;

  if v_cohort_key is null then
    return pg_catalog.jsonb_build_object(
      'affected_stage1_cohort', false,
      'award_invalidated', false,
      'national_release_invalidated', false,
      'ready_acceptances_rejected', 0,
      'release_epochs_cleared', 0
    );
  end if;

  select * into v_registry
  from public.stage1_award_registry registry
  where registry.cohort_key = v_cohort_key
  for update;
  if not found then
    raise exception using
      errcode = '23503',
      message = 'The affected Stage 1 registry row does not exist.';
  end if;

  select * into v_release
  from public.stage1_publication_release_state release_state
  where release_state.release_key = 'stage1-national-25'
  for update;
  if not found then
    raise exception using
      errcode = '23514',
      message = 'The authoritative Stage 1 national release row does not exist.';
  end if;

  select audit.id
  into v_deterministic_audit_id
  from public.shared_award_page_audits audit
  where audit.shared_award_id = v_registry.canonical_shared_award_id
    and audit.audit_kind = 'deterministic'
  order by audit.created_at desc, audit.id desc
  limit 1;

  update public.stage1_release_acceptance_records acceptance
  set status = 'rejected'
  where acceptance.release_key = 'stage1-national-25'
    and acceptance.status = 'ready';
  get diagnostics v_rejected_acceptances = row_count;

  v_reason := pg_catalog.format(
    'Blocking regression audit %s requires verified Stage 1 revalidation.',
    p_regression_audit_id
  );
  v_evidence := pg_catalog.jsonb_build_object(
    'invalidation_contract', 'stage1-blocking-regression-v1',
    'blocked_at', p_blocked_at,
    'cohort_key', v_cohort_key,
    'affected_shared_award_id', p_shared_award_id,
    'regression', pg_catalog.jsonb_build_object(
      'audit_id', p_regression_audit_id,
      'audit_kind', v_regression_audit.audit_kind,
      'audit_status', v_regression_audit.audit_status,
      'severity', v_regression_audit.severity,
      'observation_key', p_observation_key
    ),
    'deterministic_publication', pg_catalog.jsonb_build_object(
      'canonical_shared_award_id', v_registry.canonical_shared_award_id,
      'audit_kind', 'deterministic',
      'page_audit_id', v_deterministic_audit_id,
      'fact_ledger_batch_id', v_registry.fact_ledger_batch_id,
      'evidence_checked_at', v_registry.evidence_checked_at,
      'last_verified_at', v_registry.last_verified_at
    ),
    'previous_award_state', v_registry.publication_state,
    'previous_award_release_epoch', v_registry.release_epoch,
    'previous_national_state', v_release.release_state,
    'previous_national_release_epoch', v_release.release_epoch,
    'ready_acceptances_rejected', v_rejected_acceptances
  );

  if v_registry.publication_state = 'verified_beta' then
    if v_registry.release_epoch is not null then
      v_cleared_release_epochs := 1;
    end if;
    update public.stage1_award_registry registry
    set
      publication_state = 'revalidation_pending',
      state_reason = v_reason,
      release_epoch = null,
      updated_at = p_blocked_at
    where registry.cohort_key = v_cohort_key;
    v_award_invalidated := true;

    insert into public.stage1_award_publication_events (
      cohort_key,
      previous_state,
      next_state,
      reason,
      policy_version,
      evidence_snapshot,
      evidence_hash,
      actor
    ) values (
      v_cohort_key,
      v_registry.publication_state,
      'revalidation_pending',
      v_reason,
      v_registry.policy_version,
      v_evidence,
      public.stage1_publication_evidence_hash(v_evidence),
      'scheduled_regression_audit'
    );
  end if;

  if v_release.release_state = 'verified_beta' then
    update public.stage1_award_registry registry
    set release_epoch = null, updated_at = p_blocked_at
    where registry.release_epoch is not null;
    get diagnostics v_additional_cleared_release_epochs = row_count;
    v_cleared_release_epochs :=
      v_cleared_release_epochs + v_additional_cleared_release_epochs;

    update public.stage1_publication_release_state release_state
    set
      release_state = 'revalidation_pending',
      release_epoch = null,
      reason = v_reason,
      activated_at = null,
      updated_at = p_blocked_at
    where release_state.release_key = 'stage1-national-25';
    v_release_invalidated := true;

    v_evidence := v_evidence || pg_catalog.jsonb_build_object(
      'release_epochs_cleared', v_cleared_release_epochs
    );
    insert into public.stage1_publication_release_events (
      release_key,
      previous_state,
      next_state,
      release_epoch,
      reason,
      policy_version,
      cohort_identity_version,
      cohort_identity_hash,
      evidence_snapshot,
      evidence_hash,
      actor
    ) values (
      'stage1-national-25',
      v_release.release_state,
      'revalidation_pending',
      null,
      v_reason,
      v_release.policy_version,
      v_release.cohort_identity_version,
      v_release.cohort_identity_hash,
      v_evidence,
      public.stage1_publication_evidence_hash(v_evidence),
      'scheduled_regression_audit'
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'affected_stage1_cohort', true,
    'cohort_key', v_cohort_key,
    'award_invalidated', v_award_invalidated,
    'national_release_invalidated', v_release_invalidated,
    'ready_acceptances_rejected', v_rejected_acceptances,
    'release_epochs_cleared', v_cleared_release_epochs,
    'deterministic_page_audit_id', v_deterministic_audit_id,
    'deterministic_fact_ledger_batch_id', v_registry.fact_ledger_batch_id,
    'regression_audit_id', p_regression_audit_id,
    'regression_observation_key', p_observation_key
  );
end;
$$;

revoke all on function private.invalidate_stage1_release_for_regression_audit(
  uuid, uuid, text, timestamptz
) from public, anon, authenticated, service_role;

create or replace function public.record_shared_award_regression_audit(
  p_shared_award_id uuid,
  p_audit_row jsonb,
  p_audit_outcome_error text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_snapshot jsonb;
  v_evaluation_basis jsonb;
  v_expected_revision text;
  v_current_revision text;
  v_expected_source_count integer;
  v_current_source_count integer;
  v_evaluated_at timestamptz;
  v_latest_evaluated_at timestamptz;
  v_previous_state_evaluated_at timestamptz;
  v_previous_state_error text;
  v_state_advanced boolean;
  v_observation_basis jsonb;
  v_observation_key text;
  v_audit_id uuid;
  v_inserted boolean := false;
  v_resolved_prior integer := 0;
  v_status_blocks boolean;
  v_severity_blocks boolean;
  v_should_block boolean;
  v_stage1_invalidation jsonb := pg_catalog.jsonb_build_object(
    'affected_stage1_cohort', false,
    'award_invalidated', false,
    'national_release_invalidated', false,
    'ready_acceptances_rejected', 0,
    'release_epochs_cleared', 0
  );
begin
  if p_shared_award_id is null
    or pg_catalog.jsonb_typeof(p_audit_row) is distinct from 'object'
    or p_audit_row ->> 'audit_kind' is distinct from 'regression'
    or p_audit_row ->> 'audit_status' is null
    or p_audit_row ->> 'audit_status' not in ('passed', 'warnings', 'failed', 'needs_review')
    or p_audit_row ->> 'severity' is null
    or p_audit_row ->> 'severity' not in ('info', 'warning', 'error', 'critical')
    or pg_catalog.jsonb_typeof(p_audit_row -> 'findings') is distinct from 'array'
    or pg_catalog.jsonb_typeof(p_audit_row -> 'suggested_fixes') is distinct from 'array'
    or pg_catalog.jsonb_typeof(p_audit_row -> 'field_conflicts') is distinct from 'array'
    or pg_catalog.jsonb_typeof(p_audit_row -> 'source_rejections') is distinct from 'array'
    or pg_catalog.jsonb_typeof(p_audit_row -> 'selected_fact_summary') is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_audit_row -> 'public_page_snapshot') is distinct from 'object'
    or p_audit_row -> 'public_page_snapshot' -> 'observation_only' is distinct from 'true'::jsonb
    or p_audit_row -> 'public_page_snapshot' -> 'applied_to_public' is distinct from 'false'::jsonb then
    raise exception using
      errcode = '22023',
      message = 'A regression audit requires complete observation-only evidence and may not claim publication.';
  end if;

  v_status_blocks := p_audit_row ->> 'audit_status' in ('failed', 'needs_review');
  v_severity_blocks := p_audit_row ->> 'severity' in ('error', 'critical');
  v_should_block := v_status_blocks or v_severity_blocks;

  if v_status_blocks is distinct from v_severity_blocks then
    raise exception using
      errcode = '22023',
      message = 'Regression audit status and severity must agree on whether publication is blocked.';
  end if;

  if (
    v_should_block
    and nullif(pg_catalog.btrim(p_audit_outcome_error), '') is null
  ) or (
    not v_should_block
    and p_audit_outcome_error is not null
  ) then
    raise exception using
      errcode = '22023',
      message = 'Regression audit error state must agree with the blocking audit outcome.';
  end if;

  if p_audit_outcome_error is not null
    and pg_catalog.length(p_audit_outcome_error) > 1000 then
    raise exception using
      errcode = '22023',
      message = 'Regression scan errors are limited to 1000 characters.';
  end if;

  v_snapshot := p_audit_row -> 'public_page_snapshot';
  v_expected_revision := v_snapshot ->> 'evaluation_revision';
  if v_snapshot ->> 'evaluation_contract_version'
      is distinct from 'stage1-regression-evaluation-v1'
    or v_expected_revision is null
    or v_expected_revision !~ '^[0-9a-f]{64}$'
    or coalesce(v_snapshot ->> 'evaluation_source_count' ~ '^[0-9]+$', false)
      is not true
    or coalesce(
      v_snapshot ->> 'evaluated_at'
        ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T.+Z$',
      false
    ) is not true then
    raise exception using
      errcode = '22023',
      message = 'Regression audit persistence requires the immutable Stage 1 evaluation revision, source count, and selection time.';
  end if;

  begin
    v_expected_source_count := (v_snapshot ->> 'evaluation_source_count')::integer;
    v_evaluated_at := (v_snapshot ->> 'evaluated_at')::timestamptz;
  exception when others then
    raise exception using
      errcode = '22023',
      message = 'Regression audit evaluation metadata is malformed.';
  end;

  if v_expected_source_count < 0
    or v_evaluated_at > v_now + interval '5 minutes' then
    raise exception using
      errcode = '22023',
      message = 'Regression audit evaluation metadata is outside the accepted range.';
  end if;

  -- This fence is unconditional: membership can change concurrently, and no
  -- award or audit row may be locked before the national serialization point.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('stage1-national-25-release', 0)
  );

  perform 1
  from public.shared_awards award
  where award.id = p_shared_award_id
  for update;
  if not found then
    raise exception using
      errcode = '23503',
      message = 'The regression audit award does not exist.';
  end if;

  -- The parent FOR UPDATE lock blocks new source inserts through the source
  -- foreign key. Lock every existing source (including non-open rows) in a
  -- deterministic order so status changes, updates, and deletes cannot create
  -- a phantom evaluation input before this transaction commits.
  perform source_row.id
  from public.shared_award_sources source_row
  where source_row.shared_award_id = p_shared_award_id
  order by source_row.id asc
  for share;

  v_evaluation_basis :=
    private.regression_audit_evaluation_basis(p_shared_award_id);
  if v_evaluation_basis is null then
    raise exception using
      errcode = '23503',
      message = 'The regression audit evaluation basis no longer exists.';
  end if;
  v_current_revision := public.stage1_publication_evidence_hash(
    v_evaluation_basis
  );
  v_current_source_count := pg_catalog.jsonb_array_length(
    v_evaluation_basis -> 'sources'
  );

  if v_expected_revision is distinct from v_current_revision
    or v_expected_source_count is distinct from v_current_source_count then
    raise exception using
      errcode = '40001',
      message = 'Regression evaluation became stale because the award or its complete source inputs changed; select and evaluate it again.';
  end if;

  v_snapshot := v_snapshot || pg_catalog.jsonb_build_object(
    'evaluation_contract_version', 'stage1-regression-evaluation-v1',
    'evaluation_revision', v_current_revision,
    'evaluation_source_count', v_current_source_count,
    'evaluated_at', pg_catalog.to_char(
      v_evaluated_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    )
  );
  v_observation_basis := private.regression_audit_stable_value(
    pg_catalog.jsonb_build_object(
      'audit_kind', p_audit_row -> 'audit_kind',
      'audit_status', p_audit_row -> 'audit_status',
      'severity', p_audit_row -> 'severity',
      'findings', p_audit_row -> 'findings',
      'suggested_fixes', p_audit_row -> 'suggested_fixes',
      'field_conflicts', p_audit_row -> 'field_conflicts',
      'source_rejections', p_audit_row -> 'source_rejections',
      'selected_fact_summary', p_audit_row -> 'selected_fact_summary',
      'public_page_snapshot', v_snapshot,
      'model', p_audit_row -> 'model'
    )
  );
  v_observation_key := public.stage1_publication_evidence_hash(
    v_observation_basis
  );
  v_snapshot := v_snapshot || pg_catalog.jsonb_build_object(
    'observation_key', v_observation_key
  );

  select audit.id
  into v_audit_id
  from public.shared_award_page_audits audit
  where audit.shared_award_id = p_shared_award_id
    and audit.audit_kind = 'regression'
    and audit.public_page_snapshot ->> 'observation_key' = v_observation_key
    and audit.resolved_at is null
  order by audit.created_at desc, audit.id desc
  limit 1;

  if v_audit_id is null then
    insert into public.shared_award_page_audits (
      shared_award_id,
      audit_kind,
      audit_status,
      severity,
      findings,
      suggested_fixes,
      field_conflicts,
      source_rejections,
      selected_fact_summary,
      public_page_snapshot,
      model
    ) values (
      p_shared_award_id,
      'regression',
      p_audit_row ->> 'audit_status',
      p_audit_row ->> 'severity',
      p_audit_row -> 'findings',
      p_audit_row -> 'suggested_fixes',
      p_audit_row -> 'field_conflicts',
      p_audit_row -> 'source_rejections',
      p_audit_row -> 'selected_fact_summary',
      v_snapshot,
      nullif(pg_catalog.btrim(p_audit_row ->> 'model'), '')
    )
    returning id into v_audit_id;
    v_inserted := true;
  else
    select private.regression_audit_evaluated_at(
      audit.public_page_snapshot,
      audit.created_at
    )
    into v_latest_evaluated_at
    from public.shared_award_page_audits audit
    where audit.id = v_audit_id;

    -- The observation key intentionally ignores evaluated_at. Preserve the
    -- newest accepted occurrence when identical evidence is evaluated by
    -- overlapping workers, even if an older worker commits last.
    if v_latest_evaluated_at > v_evaluated_at then
      v_snapshot := pg_catalog.jsonb_set(
        v_snapshot,
        '{evaluated_at}',
        pg_catalog.to_jsonb(pg_catalog.to_char(
          v_latest_evaluated_at at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        )),
        true
      );
    end if;
    update public.shared_award_page_audits audit
    set public_page_snapshot = v_snapshot
    where audit.id = v_audit_id;
  end if;

  if not v_should_block then
    update public.shared_award_page_audits audit
    set
      resolved_at = v_now,
      resolved_by = 'scheduled_regression_pass',
      resolution_note = 'A later no-charge regression scan passed and superseded this observation.'
    where audit.shared_award_id = p_shared_award_id
      and audit.audit_kind = 'regression'
      and audit.id <> v_audit_id
      and audit.resolved_at is null
      and (
        audit.audit_status in ('failed', 'needs_review')
        or audit.severity in ('error', 'critical')
      )
      and private.regression_audit_evaluated_at(
        audit.public_page_snapshot,
        audit.created_at
      ) < v_evaluated_at;
    get diagnostics v_resolved_prior = row_count;
  else
    v_stage1_invalidation :=
      private.invalidate_stage1_release_for_regression_audit(
        p_shared_award_id,
        v_audit_id,
        v_observation_key,
        v_now
      );
  end if;

  select
    state.last_evaluated_at,
    state.last_audit_error
  into
    v_previous_state_evaluated_at,
    v_previous_state_error
  from public.shared_award_regression_audit_state state
  where state.shared_award_id = p_shared_award_id
  for update;
  v_state_advanced := v_previous_state_evaluated_at is null
    or v_evaluated_at > v_previous_state_evaluated_at
    or (
      v_previous_state_error is null
      and p_audit_outcome_error is not null
    );

  insert into public.shared_award_regression_audit_state (
    shared_award_id,
    last_attempted_at,
    last_succeeded_at,
    last_evaluated_at,
    consecutive_failures,
    next_retry_at,
    last_operational_error,
    last_audit_error,
    last_audit_id,
    last_observation_key,
    updated_at
  ) values (
    p_shared_award_id,
    v_now,
    v_now,
    v_evaluated_at,
    0,
    v_now,
    null,
    p_audit_outcome_error,
    v_audit_id,
    v_observation_key,
    v_now
  )
  on conflict (shared_award_id) do update
  set
    last_attempted_at = excluded.last_attempted_at,
    last_succeeded_at = case
      when v_state_advanced then excluded.last_succeeded_at
      else shared_award_regression_audit_state.last_succeeded_at
    end,
    last_evaluated_at = case
      when v_state_advanced then excluded.last_evaluated_at
      else shared_award_regression_audit_state.last_evaluated_at
    end,
    consecutive_failures = 0,
    next_retry_at = excluded.next_retry_at,
    last_operational_error = null,
    last_audit_error = case
      when v_state_advanced then excluded.last_audit_error
      else shared_award_regression_audit_state.last_audit_error
    end,
    last_audit_id = case
      when v_state_advanced then excluded.last_audit_id
      else shared_award_regression_audit_state.last_audit_id
    end,
    last_observation_key = case
      when v_state_advanced then excluded.last_observation_key
      else shared_award_regression_audit_state.last_observation_key
    end,
    updated_at = excluded.updated_at;

  return pg_catalog.jsonb_build_object(
    'audit_id', v_audit_id,
    'inserted', v_inserted,
    'observation_key', v_observation_key,
    'evaluation_revision', v_current_revision,
    'evaluation_accepted_at', v_evaluated_at,
    'latest_state_advanced', v_state_advanced,
    'resolved_prior_failures', v_resolved_prior,
    'scan_recorded_at', v_now,
    'consecutive_failures', 0,
    'next_retry_at', v_now,
    'stage1_invalidation', v_stage1_invalidation
  );
end;
$$;

revoke all on function public.record_shared_award_regression_audit(uuid, jsonb, text)
  from public, anon, authenticated, service_role;
grant execute on function public.record_shared_award_regression_audit(uuid, jsonb, text)
  to service_role;

create or replace function public.record_shared_award_regression_audit_attempt_failure(
  p_shared_award_id uuid,
  p_operational_error text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_current_failures integer := 0;
  v_consecutive_failures integer;
  v_delay_seconds integer;
  v_next_retry_at timestamptz;
begin
  if p_shared_award_id is null
    or nullif(pg_catalog.btrim(p_operational_error), '') is null
    or pg_catalog.length(p_operational_error) > 1000 then
    raise exception using
      errcode = '22023',
      message = 'A regression audit attempt failure requires an award and an error of at most 1000 characters.';
  end if;

  -- Keep every regression-lane award lock behind the same unconditional
  -- national fence, including retry-state writes after a rejected revision.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('stage1-national-25-release', 0)
  );

  perform 1
  from public.shared_awards award
  where award.id = p_shared_award_id
  for update;
  if not found then
    raise exception using
      errcode = '23503',
      message = 'The failed regression audit award does not exist.';
  end if;

  select state.consecutive_failures
  into v_current_failures
  from public.shared_award_regression_audit_state state
  where state.shared_award_id = p_shared_award_id
  for update;
  v_current_failures := coalesce(v_current_failures, 0);
  v_consecutive_failures := v_current_failures + 1;
  v_delay_seconds := least(
    21600,
    (
      300 * pg_catalog.power(
        2::numeric,
        least(v_consecutive_failures - 1, 7)
      )
    )::integer
  );
  v_next_retry_at := v_now + pg_catalog.make_interval(secs => v_delay_seconds);

  insert into public.shared_award_regression_audit_state (
    shared_award_id,
    last_attempted_at,
    consecutive_failures,
    next_retry_at,
    last_operational_error,
    updated_at
  ) values (
    p_shared_award_id,
    v_now,
    v_consecutive_failures,
    v_next_retry_at,
    p_operational_error,
    v_now
  )
  on conflict (shared_award_id) do update
  set
    last_attempted_at = excluded.last_attempted_at,
    consecutive_failures = excluded.consecutive_failures,
    next_retry_at = excluded.next_retry_at,
    last_operational_error = excluded.last_operational_error,
    updated_at = excluded.updated_at;

  return pg_catalog.jsonb_build_object(
    'shared_award_id', p_shared_award_id,
    'attempt_recorded_at', v_now,
    'consecutive_failures', v_consecutive_failures,
    'next_retry_at', v_next_retry_at,
    'last_operational_error', p_operational_error
  );
end;
$$;

revoke all on function public.record_shared_award_regression_audit_attempt_failure(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.record_shared_award_regression_audit_attempt_failure(uuid, text)
  to service_role;

do $migration$
declare
  v_target record;
  v_definition text;
  v_match_count integer;
  v_snapshot_old text := $old$      from public.shared_award_page_audits audit
      where audit.shared_award_id = registry.canonical_shared_award_id
      order by audit.created_at desc, audit.id desc
      limit 1$old$;
  v_snapshot_new text := $new$      from public.shared_award_page_audits audit
      where audit.shared_award_id = registry.canonical_shared_award_id
        and audit.audit_kind = 'deterministic'
      order by audit.created_at desc, audit.id desc
      limit 1$new$;
  v_canonical_old text := $old$    from public.shared_award_page_audits audit
    where audit.shared_award_id = v_registry.canonical_shared_award_id
    order by audit.created_at desc, audit.id desc
    limit 1$old$;
  v_canonical_new text := $new$    from public.shared_award_page_audits audit
    where audit.shared_award_id = v_registry.canonical_shared_award_id
      and audit.audit_kind = 'deterministic'
    order by audit.created_at desc, audit.id desc
    limit 1$new$;
  v_effective_old text := $old$  from public.shared_award_page_audits audit
  where audit.shared_award_id = v_registry.canonical_shared_award_id
  order by audit.created_at desc, audit.id desc
  limit 1$old$;
  v_effective_new text := $new$  from public.shared_award_page_audits audit
  where audit.shared_award_id = v_registry.canonical_shared_award_id
    and audit.audit_kind = 'deterministic'
  order by audit.created_at desc, audit.id desc
  limit 1$new$;
begin
  for v_target in
    select *
    from (values
      (
        'private.stage1_promotion_review_snapshot(text)'::text,
        v_snapshot_old,
        v_snapshot_new
      ),
      (
        'public.transition_stage1_award_publication(text,text,text,text,text)'::text,
        v_canonical_old,
        v_canonical_new
      ),
      (
        'public.stage1_effective_publication_reason(text,timestamp with time zone)'::text,
        v_effective_old,
        v_effective_new
      )
    ) spec(signature, old_fragment, new_fragment)
  loop
    if pg_catalog.to_regprocedure(v_target.signature) is null then
      raise exception 'Required Stage 1 function % does not exist.', v_target.signature;
    end if;
    v_definition := pg_catalog.pg_get_functiondef(
      pg_catalog.to_regprocedure(v_target.signature)
    );
    v_match_count := (
      pg_catalog.length(v_definition)
      - pg_catalog.length(pg_catalog.replace(v_definition, v_target.old_fragment, ''))
    ) / pg_catalog.length(v_target.old_fragment);
    if v_match_count <> 1 then
      raise exception
        'Expected one canonical page-audit selector in %, found %.',
        v_target.signature,
        v_match_count;
    end if;
    execute pg_catalog.replace(
      v_definition,
      v_target.old_fragment,
      v_target.new_fragment
    );
  end loop;
end;
$migration$;
