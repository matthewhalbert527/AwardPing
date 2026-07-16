-- Verified, append-audited promotion workflow for false-update feedback.
-- Immediate event suppression remains owned by record_monitoring_false_positive;
-- this migration only replaces the broader-rule promotion shortcut.

create table if not exists public.shared_award_visual_review_candidate_run_observations (
  run_id uuid not null,
  candidate_id uuid not null,
  observed_at timestamptz not null default now(),
  constraint visual_review_candidate_run_observations_pkey
    primary key (run_id, candidate_id),
  constraint visual_review_candidate_run_observations_run_fkey
    foreign key (run_id)
    references public.local_worker_runs(id) on delete restrict,
  constraint visual_review_candidate_run_observations_candidate_fkey
    foreign key (candidate_id)
    references public.shared_award_visual_review_candidates(id) on delete restrict
);

comment on table public.shared_award_visual_review_candidate_run_observations is
  'Append-only many-to-many evidence that an exact local visual worker run observed a candidate, including candidates reused by an upsert.';

create index if not exists visual_review_candidate_run_observations_candidate_idx
  on public.shared_award_visual_review_candidate_run_observations (
    candidate_id,
    observed_at,
    run_id
  );

create table if not exists public.monitoring_feedback_promotion_clusters (
  id uuid primary key default gen_random_uuid(),
  cluster_key text not null
    check (cluster_key ~ '^[0-9a-f]{64}$'),
  evidence_signature text not null
    check (evidence_signature ~ '^[0-9a-f]{64}$'),
  domain_template text not null
    check (char_length(domain_template) between 3 and 1000),
  reason_code text not null
    check (
      reason_code in (
        'capture_noise',
        'content_churn',
        'duplicate_update',
        'out_of_scope',
        'not_applicant_facing',
        'other'
      )
    ),
  current_stage text not null default 'triaged'
    check (
      current_stage in (
        'triaged',
        'similar_feedback_clustered',
        'rule_drafted',
        'historical_shadow_test',
        'regression_tests_pass',
        'app_worker_hashes_match',
        'six_pm_canary',
        'retroactive_sweep',
        'resolved'
      )
    ),
  proposed_rule_id text
    check (
      proposed_rule_id is null
      or char_length(proposed_rule_id) between 1 and 160
    ),
  evidence_revision bigint not null default 0
    check (evidence_revision >= 0),
  activation_status text not null default 'inactive'
    check (
      activation_status in (
        'inactive',
        'armed',
        'blocked_late_evidence',
        'rollback_required',
        'sweep_completed'
      )
    ),
  activation_blocked_at timestamptz,
  stage_artifacts jsonb not null default '{}'::jsonb
    check (jsonb_typeof(stage_artifacts) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz,
  constraint monitoring_feedback_promotion_clusters_resolution_check check (
    (current_stage = 'resolved' and resolved_at is not null)
    or (current_stage <> 'resolved' and resolved_at is null)
  )
);

comment on table public.monitoring_feedback_promotion_clusters is
  'Durable promotion cases clustered by a normalized evidence-pattern signature, normalized domain template, and operator reason. Exact visual occurrence signatures remain in member evidence. current_stage is the latest successfully completed stage.';
comment on column public.monitoring_feedback_promotion_clusters.stage_artifacts is
  'Accepted evidence keyed by the exact completed stage ID. Failed attempts remain append-only in monitoring_feedback_promotion_transitions.';

drop index if exists public.monitoring_feedback_promotion_clusters_triaged_key_idx;
drop index if exists public.monitoring_feedback_promotion_clusters_unresolved_key_idx;
create unique index monitoring_feedback_promotion_clusters_unresolved_key_idx
  on public.monitoring_feedback_promotion_clusters (cluster_key)
  where resolved_at is null;
create unique index if not exists monitoring_feedback_promotion_clusters_unresolved_rule_idx
  on public.monitoring_feedback_promotion_clusters (proposed_rule_id)
  where proposed_rule_id is not null and resolved_at is null;
create index if not exists monitoring_feedback_promotion_clusters_stage_created_idx
  on public.monitoring_feedback_promotion_clusters (current_stage, created_at, id);

create table if not exists public.monitoring_feedback_promotion_worker_leases (
  cluster_id uuid primary key
    references public.monitoring_feedback_promotion_clusters(id) on delete restrict,
  last_polled_at timestamptz not null,
  poll_count bigint not null default 1
    check (poll_count >= 1)
);

comment on table public.monitoring_feedback_promotion_worker_leases is
  'Internal fair-dequeue state. Every worker queue read advances the selected clusters so waiting or idempotently failed work cannot monopolize the bounded queue.';

create table if not exists public.monitoring_feedback_promotion_sweep_reversal_audit (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null,
  request_payload_digest text not null
    check (request_payload_digest ~ '^[0-9a-f]{64}$'),
  cluster_id uuid not null,
  activation_cycle_id uuid not null,
  evidence_revision bigint not null check (evidence_revision >= 1),
  event_id uuid not null,
  reversal_action text not null
    check (
      reversal_action in (
        'unsuppressed',
        'retained_feedback',
        'retained_other_policy'
      )
    ),
  previous_suppressed_at timestamptz not null,
  previous_suppression_reason text,
  previous_suppression_source text,
  resulting_suppressed_at timestamptz,
  resulting_suppression_reason text,
  resulting_suppression_source text,
  created_at timestamptz not null default now(),
  constraint monitoring_feedback_promotion_sweep_reversal_request_event_key
    unique (request_id, event_id),
  constraint monitoring_feedback_promotion_sweep_reversal_cycle_event_key
    unique (cluster_id, activation_cycle_id, event_id),
  constraint monitoring_feedback_promotion_sweep_reversal_cluster_fkey
    foreign key (cluster_id)
    references public.monitoring_feedback_promotion_clusters(id) on delete restrict,
  constraint monitoring_feedback_promotion_sweep_reversal_event_fkey
    foreign key (event_id)
    references public.shared_award_change_events(id) on delete restrict,
  constraint monitoring_feedback_promotion_sweep_reversal_result_check check (
    (
      reversal_action = 'unsuppressed'
      and resulting_suppressed_at is null
      and resulting_suppression_reason is null
      and resulting_suppression_source is null
    )
    or (
      reversal_action in ('retained_feedback', 'retained_other_policy')
      and resulting_suppressed_at is not null
      and resulting_suppression_reason is not null
      and resulting_suppression_source is not null
    )
  )
);

comment on table public.monitoring_feedback_promotion_sweep_reversal_audit is
  'Append-only, event-level proof that suppressions attributable to a blocked candidate were cleared or safely re-attributed before activation rollback.';

create index if not exists monitoring_feedback_promotion_sweep_reversal_cluster_created_idx
  on public.monitoring_feedback_promotion_sweep_reversal_audit (
    cluster_id,
    activation_cycle_id,
    created_at,
    event_id
  );

create table if not exists public.monitoring_feedback_promotion_cluster_members (
  cluster_id uuid not null
    references public.monitoring_feedback_promotion_clusters(id) on delete restrict,
  feedback_id uuid not null unique
    references public.monitoring_feedback(id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (cluster_id, feedback_id)
);

comment on table public.monitoring_feedback_promotion_cluster_members is
  'Append-only membership assigning each unresolved feedback row to one deterministic active promotion cluster.';

create index if not exists monitoring_feedback_promotion_cluster_members_cluster_created_idx
  on public.monitoring_feedback_promotion_cluster_members (cluster_id, created_at, feedback_id);

create table if not exists public.monitoring_feedback_promotion_transitions (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique,
  cluster_id uuid not null
    references public.monitoring_feedback_promotion_clusters(id) on delete restrict,
  from_stage text not null,
  requested_stage text not null,
  resulting_stage text not null,
  accepted boolean not null,
  transition_kind text not null default 'stage_attempt'
    check (
      transition_kind in ('stage_attempt', 'evidence_restart', 'operator_restart')
      or transition_kind in (
        'activation_drift',
        'activation_rollback_required',
        'activation_rollback'
      )
    ),
  evidence_revision bigint not null
    check (evidence_revision >= 1),
  failure_reason text,
  actor_user_id uuid not null,
  actor_email text not null
    check (char_length(actor_email) between 3 and 320),
  policy_rule_id text,
  policy_identity text,
  policy_version text,
  policy_hash text,
  policy_config_version integer,
  decision_memory_version integer,
  evidence jsonb not null default '{}'::jsonb
    check (jsonb_typeof(evidence) = 'object'),
  note text
    check (note is null or char_length(note) <= 1000),
  promotion_count integer not null default 0
    check (promotion_count >= 0),
  recurrence_count bigint not null default 1
    check (recurrence_count >= 1),
  created_at timestamptz not null default now(),
  constraint monitoring_feedback_promotion_transitions_stage_check check (
    from_stage in (
      'triaged',
      'similar_feedback_clustered',
      'rule_drafted',
      'historical_shadow_test',
      'regression_tests_pass',
      'app_worker_hashes_match',
      'six_pm_canary',
      'retroactive_sweep',
      'resolved'
    )
    and requested_stage in (
      'triaged',
      'similar_feedback_clustered',
      'rule_drafted',
      'historical_shadow_test',
      'regression_tests_pass',
      'app_worker_hashes_match',
      'six_pm_canary',
      'retroactive_sweep',
      'resolved'
    )
    and resulting_stage in (
      'triaged',
      'similar_feedback_clustered',
      'rule_drafted',
      'historical_shadow_test',
      'regression_tests_pass',
      'app_worker_hashes_match',
      'six_pm_canary',
      'retroactive_sweep',
      'resolved'
    )
  ),
  constraint monitoring_feedback_promotion_transitions_result_check check (
    (
      transition_kind = 'stage_attempt'
      and (
        (accepted and resulting_stage = requested_stage and failure_reason is null)
        or (
          not accepted
          and resulting_stage = from_stage
          and failure_reason is not null
        )
      )
    )
    or (
      transition_kind = 'evidence_restart'
      and accepted
      and failure_reason is null
      and promotion_count = 0
      and (
        (
          from_stage in ('triaged', 'similar_feedback_clustered')
          and requested_stage = from_stage
          and resulting_stage = from_stage
        )
        or (
          from_stage in (
            'rule_drafted',
            'historical_shadow_test',
            'regression_tests_pass',
            'app_worker_hashes_match',
            'six_pm_canary',
            'retroactive_sweep'
          )
          and requested_stage = 'similar_feedback_clustered'
          and resulting_stage = 'similar_feedback_clustered'
        )
      )
    )
    or (
      transition_kind = 'operator_restart'
      and accepted
      and failure_reason is null
      and promotion_count = 0
      and from_stage in (
        'rule_drafted',
        'historical_shadow_test',
        'regression_tests_pass',
        'app_worker_hashes_match'
      )
      and requested_stage = 'similar_feedback_clustered'
      and resulting_stage = 'similar_feedback_clustered'
    )
    or (
      transition_kind = 'activation_drift'
      and accepted
      and failure_reason is null
      and promotion_count = 0
      and from_stage in ('six_pm_canary', 'retroactive_sweep')
      and requested_stage = from_stage
      and resulting_stage = from_stage
    )
    or (
      transition_kind = 'activation_rollback_required'
      and accepted
      and failure_reason is null
      and promotion_count = 0
      and from_stage in ('six_pm_canary', 'retroactive_sweep')
      and requested_stage = from_stage
      and resulting_stage = from_stage
    )
    or (
      transition_kind = 'activation_rollback'
      and accepted
      and failure_reason is null
      and promotion_count = 0
      and from_stage in ('six_pm_canary', 'retroactive_sweep')
      and requested_stage = 'similar_feedback_clustered'
      and resulting_stage = 'similar_feedback_clustered'
    )
  )
);

comment on table public.monitoring_feedback_promotion_transitions is
  'Append-only accepted and rejected promotion-stage attempts plus explicit evidence-restart records. A failed verification records its artifacts without advancing the cluster.';

create index if not exists monitoring_feedback_promotion_transitions_cluster_created_idx
  on public.monitoring_feedback_promotion_transitions (cluster_id, created_at desc, id desc);
create index if not exists monitoring_feedback_promotion_transitions_cluster_stage_idx
  on public.monitoring_feedback_promotion_transitions (
    cluster_id,
    requested_stage,
    created_at desc,
    id desc
  );

alter table public.monitoring_feedback_promotion_sweep_reversal_audit
  add constraint monitoring_feedback_promotion_sweep_reversal_cycle_fkey
  foreign key (activation_cycle_id)
  references public.monitoring_feedback_promotion_transitions(id) on delete restrict;

alter table public.monitoring_feedback_promotions
  add column if not exists promotion_cluster_id uuid
    references public.monitoring_feedback_promotion_clusters(id) on delete restrict,
  add column if not exists promotion_transition_id uuid
    references public.monitoring_feedback_promotion_transitions(id) on delete restrict;

create index if not exists monitoring_feedback_promotions_cluster_idx
  on public.monitoring_feedback_promotions (promotion_cluster_id, created_at, feedback_id);

create or replace function private.monitoring_feedback_promotion_stage_ordinal(
  p_stage text
)
returns integer
language sql
immutable
strict
set search_path = ''
as $function$
  select case p_stage
    when 'triaged' then 1
    when 'similar_feedback_clustered' then 2
    when 'rule_drafted' then 3
    when 'historical_shadow_test' then 4
    when 'regression_tests_pass' then 5
    when 'app_worker_hashes_match' then 6
    when 'six_pm_canary' then 7
    when 'retroactive_sweep' then 8
    when 'resolved' then 9
    else null
  end;
$function$;

create or replace function private.monitoring_feedback_promotion_next_stage(
  p_stage text
)
returns text
language sql
immutable
strict
set search_path = ''
as $function$
  select case p_stage
    when 'triaged' then 'similar_feedback_clustered'
    when 'similar_feedback_clustered' then 'rule_drafted'
    when 'rule_drafted' then 'historical_shadow_test'
    when 'historical_shadow_test' then 'regression_tests_pass'
    when 'regression_tests_pass' then 'app_worker_hashes_match'
    when 'app_worker_hashes_match' then 'six_pm_canary'
    when 'six_pm_canary' then 'retroactive_sweep'
    when 'retroactive_sweep' then 'resolved'
    else null
  end;
$function$;

create or replace function private.monitoring_feedback_json_boolean(
  p_value jsonb,
  p_key text
)
returns boolean
language plpgsql
immutable
set search_path = ''
as $function$
begin
  if pg_catalog.jsonb_typeof(coalesce(p_value, '{}'::jsonb) -> p_key)
      is distinct from 'boolean' then
    return false;
  end if;
  return (p_value ->> p_key)::boolean;
end;
$function$;

create or replace function private.monitoring_feedback_json_nonnegative_bigint(
  p_value jsonb,
  p_key text
)
returns bigint
language plpgsql
immutable
set search_path = ''
as $function$
declare
  v_text text;
begin
  if pg_catalog.jsonb_typeof(coalesce(p_value, '{}'::jsonb) -> p_key)
      is distinct from 'number' then
    return null;
  end if;
  v_text := p_value ->> p_key;
  if v_text !~ '^[0-9]+$' then
    return null;
  end if;
  return v_text::bigint;
exception
  when numeric_value_out_of_range then
    return null;
end;
$function$;

create or replace function private.monitoring_feedback_json_array_length(
  p_value jsonb,
  p_key text
)
returns bigint
language plpgsql
immutable
set search_path = ''
as $function$
begin
  if pg_catalog.jsonb_typeof(coalesce(p_value, '{}'::jsonb) -> p_key)
      is distinct from 'array' then
    return null;
  end if;
  return pg_catalog.jsonb_array_length(p_value -> p_key)::bigint;
end;
$function$;

create or replace function private.monitoring_feedback_sorted_unique_uuid_array_valid(
  p_value jsonb
)
returns boolean
language sql
immutable
set search_path = ''
as $function$
  select coalesce(
    pg_catalog.jsonb_typeof(p_value) = 'array'
    and pg_catalog.jsonb_array_length(p_value) >= 1
    and not exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_value) item(value)
      where pg_catalog.jsonb_typeof(item.value) is distinct from 'string'
        or item.value #>> '{}' !~
          '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    )
    and p_value = (
      select pg_catalog.jsonb_agg(distinct_value.value order by distinct_value.value)
      from (
        select distinct item.value #>> '{}' as value
        from pg_catalog.jsonb_array_elements(p_value) item(value)
      ) distinct_value
    ),
    false
  );
$function$;

create index if not exists local_worker_runs_promotion_resolution_lookup_idx
on public.local_worker_runs (
  (metadata ->> 'cluster_id'),
  (metadata ->> 'evidence_revision'),
  (metadata ->> 'sweep_completed_at'),
  finished_at,
  id
)
where worker_name = 'local-monitoring-feedback-promotion-worker'
  and metadata ->> 'kind' =
    'monitoring_feedback_promotion_resolution_attestation'
  and metadata ->> 'report_schema_version' = '1'
  and metadata ->> 'attestation_source' = 'hourly_downstream_queue'
  and metadata ->> 'api_charge' = 'false'
  and ai_provider is null
  and status = 'succeeded'
  and failed_count = 0;

create or replace function private.monitoring_feedback_worker_attestation_runs_valid(
  p_report jsonb,
  p_not_before timestamptz
)
returns boolean
language plpgsql
stable
set search_path = ''
as $function$
declare
  v_completed_at timestamptz;
  v_array_count bigint;
  v_distinct_count bigint;
  v_valid_count bigint;
begin
  if coalesce(p_report ->> 'completed_at', '') !~
      '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?Z$'
    or p_not_before is null
    or pg_catalog.jsonb_typeof(p_report -> 'worker_run_ids') is distinct from 'array' then
    return false;
  end if;

  v_completed_at := (p_report ->> 'completed_at')::timestamptz;
  if v_completed_at <= p_not_before then
    return false;
  end if;

  select
    pg_catalog.count(*)::bigint,
    pg_catalog.count(distinct run_item.value #>> '{}') filter (
      where pg_catalog.jsonb_typeof(run_item.value) = 'string'
        and pg_catalog.btrim(run_item.value #>> '{}') <> ''
    )::bigint
  into v_array_count, v_distinct_count
  from pg_catalog.jsonb_array_elements(p_report -> 'worker_run_ids') run_item(value);

  if v_array_count < 1 or v_distinct_count is distinct from v_array_count then
    return false;
  end if;

  select pg_catalog.count(*)::bigint
  into v_valid_count
  from public.local_worker_runs worker_run
  join pg_catalog.jsonb_array_elements(p_report -> 'worker_run_ids') run_item(value)
    on pg_catalog.jsonb_typeof(run_item.value) = 'string'
    and worker_run.id::text = run_item.value #>> '{}'
  where worker_run.status = 'succeeded'
    and worker_run.failed_count = 0
    and worker_run.finished_at > p_not_before
    and worker_run.finished_at <= v_completed_at
    and worker_run.metadata ->> 'worker_revision' = p_report ->> 'worker_revision'
    and worker_run.metadata #>> '{monitoring_policy_bundle,hash}' =
      p_report ->> 'worker_policy_hash'
    and worker_run.metadata #>> '{monitoring_policy,hash}' =
      p_report ->> 'worker_batch_policy_hash'
    and worker_run.metadata #>> '{suppression_policy,hash}' =
      p_report ->> 'worker_suppression_policy_hash'
    and worker_run.metadata ->> 'matcher_digest' =
      p_report ->> 'worker_matcher_digest'
    and (
      (
        worker_run.worker_name like 'local-visual-snapshot-worker%'
        and worker_run.metadata ->> 'kind' = 'visual_snapshot'
      )
      or (
        worker_run.worker_name = 'local-monitoring-feedback-promotion-worker'
        and worker_run.metadata ->> 'kind' =
          'monitoring_feedback_promotion_resolution_attestation'
        and worker_run.metadata ->> 'cluster_id' = p_report ->> 'cluster_id'
        and worker_run.metadata ->> 'evidence_revision' =
          p_report ->> 'evidence_revision'
      )
    );

  return v_valid_count = v_array_count;
exception
  when invalid_datetime_format or datetime_field_overflow then
    return false;
end;
$function$;

create or replace function private.find_monitoring_feedback_resolution_worker_run(
  p_cluster_id uuid,
  p_expected_evidence_revision bigint,
  p_not_before timestamptz,
  p_worker_revision text,
  p_worker_policy_hash text,
  p_worker_batch_policy_hash text,
  p_worker_suppression_policy_hash text,
  p_worker_matcher_digest text
)
returns table (
  worker_run_id uuid,
  finished_at timestamptz,
  worker_revision text,
  worker_policy_hash text,
  worker_batch_policy_hash text,
  worker_suppression_policy_hash text,
  worker_matcher_digest text
)
language sql
stable
set search_path = ''
as $function$
  select
    worker_run.id,
    worker_run.finished_at,
    worker_run.metadata ->> 'worker_revision',
    worker_run.metadata #>> '{monitoring_policy_bundle,hash}',
    worker_run.metadata #>> '{monitoring_policy,hash}',
    worker_run.metadata #>> '{suppression_policy,hash}',
    worker_run.metadata ->> 'matcher_digest'
  from public.local_worker_runs worker_run
  where worker_run.status = 'succeeded'
    and worker_run.failed_count = 0
    and worker_run.finished_at > p_not_before
    and worker_run.metadata ->> 'worker_revision' = p_worker_revision
    and worker_run.metadata #>> '{monitoring_policy_bundle,hash}' = p_worker_policy_hash
    and worker_run.metadata #>> '{monitoring_policy,hash}' = p_worker_batch_policy_hash
    and worker_run.metadata #>> '{suppression_policy,hash}' = p_worker_suppression_policy_hash
    and worker_run.metadata ->> 'matcher_digest' = p_worker_matcher_digest
    and worker_run.worker_name = 'local-monitoring-feedback-promotion-worker'
    and worker_run.metadata ->> 'kind' =
      'monitoring_feedback_promotion_resolution_attestation'
    and worker_run.metadata ->> 'report_schema_version' = '1'
    and worker_run.metadata ->> 'attestation_source' =
      'hourly_downstream_queue'
    and worker_run.metadata ->> 'api_charge' = 'false'
    and worker_run.ai_provider is null
    and worker_run.metadata ->> 'cluster_id' = p_cluster_id::text
    and worker_run.metadata ->> 'evidence_revision' =
      p_expected_evidence_revision::text
    and coalesce(worker_run.metadata ->> 'sweep_completed_at', '') ~
      '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?Z$'
    and (worker_run.metadata ->> 'sweep_completed_at')::timestamptz
      is not distinct from p_not_before
  order by worker_run.finished_at asc, worker_run.id asc
  limit 1;
$function$;

create or replace function private.monitoring_feedback_resolution_attestation_run_valid(
  p_report jsonb,
  p_cluster_id uuid,
  p_evidence_revision bigint,
  p_not_before timestamptz
)
returns boolean
language plpgsql
stable
set search_path = ''
as $function$
declare
  v_completed_at timestamptz;
  v_valid boolean := false;
begin
  if p_cluster_id is null
    or p_evidence_revision is null
    or p_not_before is null
    or p_report ->> 'cluster_id' is distinct from p_cluster_id::text
    or p_report ->> 'evidence_revision' is distinct from p_evidence_revision::text
    or coalesce(p_report ->> 'completed_at', '') !~
      '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?Z$'
    or pg_catalog.jsonb_typeof(p_report -> 'worker_run_ids') is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_report -> 'worker_run_ids') <> 1 then
    return false;
  end if;

  v_completed_at := (p_report ->> 'completed_at')::timestamptz;
  select
    p_report -> 'worker_run_ids' =
      pg_catalog.jsonb_build_array(resolution_run.worker_run_id::text)
    and resolution_run.finished_at is not distinct from v_completed_at
  into v_valid
  from private.find_monitoring_feedback_resolution_worker_run(
    p_cluster_id,
    p_evidence_revision,
    p_not_before,
    p_report ->> 'worker_revision',
    p_report ->> 'worker_policy_hash',
    p_report ->> 'worker_batch_policy_hash',
    p_report ->> 'worker_suppression_policy_hash',
    p_report ->> 'worker_matcher_digest'
  ) resolution_run;

  return coalesce(v_valid, false);
exception
  when invalid_datetime_format or datetime_field_overflow then
    return false;
end;
$function$;

create or replace function public.find_monitoring_feedback_resolution_worker_run(
  p_cluster_id uuid,
  p_expected_evidence_revision bigint,
  p_not_before timestamptz,
  p_worker_revision text,
  p_worker_policy_hash text,
  p_worker_batch_policy_hash text,
  p_worker_suppression_policy_hash text,
  p_worker_matcher_digest text
)
returns table (
  worker_run_id uuid,
  finished_at timestamptz,
  worker_revision text,
  worker_policy_hash text,
  worker_batch_policy_hash text,
  worker_suppression_policy_hash text,
  worker_matcher_digest text
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_cluster public.monitoring_feedback_promotion_clusters%rowtype;
  v_sweep_completed_at timestamptz;
begin
  select cluster.*
  into v_cluster
  from public.monitoring_feedback_promotion_clusters cluster
  where cluster.id = p_cluster_id;

  if not found then
    raise exception using errcode = 'P0002', message = 'monitoring feedback promotion cluster not found';
  end if;
  if v_cluster.evidence_revision is distinct from p_expected_evidence_revision
    or v_cluster.current_stage <> 'retroactive_sweep'
    or v_cluster.activation_status <> 'sweep_completed'
    or v_cluster.resolved_at is not null then
    raise exception using errcode = '40001', message = 'resolution worker attestation state is stale';
  end if;
  if coalesce(v_cluster.stage_artifacts #>> '{retroactive_sweep,completed_at}', '') !~
      '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?Z$' then
    raise exception using errcode = '22023', message = 'completed retroactive sweep timestamp is missing';
  end if;
  v_sweep_completed_at :=
    (v_cluster.stage_artifacts #>> '{retroactive_sweep,completed_at}')::timestamptz;
  if p_not_before is distinct from v_sweep_completed_at then
    raise exception using errcode = '40001', message = 'resolution attestation boundary is stale';
  end if;
  if p_worker_revision is distinct from
      v_cluster.stage_artifacts #>> '{retroactive_sweep,activation_attestation,worker_revision}'
    or p_worker_policy_hash is distinct from
      v_cluster.stage_artifacts #>> '{retroactive_sweep,activation_attestation,worker_policy_hash}'
    or p_worker_batch_policy_hash is distinct from
      v_cluster.stage_artifacts #>> '{retroactive_sweep,activation_attestation,worker_batch_policy_hash}'
    or p_worker_suppression_policy_hash is distinct from
      v_cluster.stage_artifacts #>> '{retroactive_sweep,activation_attestation,worker_suppression_policy_hash}'
    or p_worker_matcher_digest is distinct from
      v_cluster.stage_artifacts #>> '{retroactive_sweep,activation_attestation,worker_matcher_digest}' then
    raise exception using errcode = '40001', message = 'resolution deployment identity drifted after the sweep';
  end if;

  return query
  select resolution_run.*
  from private.find_monitoring_feedback_resolution_worker_run(
    p_cluster_id,
    p_expected_evidence_revision,
    v_sweep_completed_at,
    p_worker_revision,
    p_worker_policy_hash,
    p_worker_batch_policy_hash,
    p_worker_suppression_policy_hash,
    p_worker_matcher_digest
  ) resolution_run;
end;
$function$;

create or replace function public.replay_monitoring_feedback_promotion_resolution(
  p_request_id uuid,
  p_cluster_id uuid,
  p_expected_evidence_revision bigint,
  p_actor_user_id uuid,
  p_actor_email text,
  p_policy_rule_id text
)
returns table (
  transition_id uuid,
  advanced_cluster_id uuid,
  previous_stage text,
  current_stage text,
  requested_stage text,
  accepted boolean,
  advanced boolean,
  failure_reason text,
  promotion_count integer,
  recurrence_count bigint,
  current_evidence_revision bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_cluster public.monitoring_feedback_promotion_clusters%rowtype;
  v_transition public.monitoring_feedback_promotion_transitions%rowtype;
  v_actor_email text :=
    pg_catalog.lower(pg_catalog.btrim(coalesce(p_actor_email, '')));
  v_promotion_count integer := 0;
begin
  select cluster.*
  into v_cluster
  from public.monitoring_feedback_promotion_clusters cluster
  where cluster.id = p_cluster_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'monitoring feedback promotion cluster not found';
  end if;

  select transition.*
  into v_transition
  from public.monitoring_feedback_promotion_transitions transition
  where transition.request_id = p_request_id;
  if not found
    or v_transition.cluster_id is distinct from p_cluster_id
    or v_transition.requested_stage <> 'resolved'
    or v_transition.resulting_stage <> 'resolved'
    or not v_transition.accepted
    or v_transition.evidence_revision is distinct from
      p_expected_evidence_revision
    or v_transition.actor_user_id is distinct from p_actor_user_id
    or pg_catalog.lower(v_transition.actor_email) is distinct from v_actor_email
    or v_transition.policy_rule_id is distinct from p_policy_rule_id
    or v_cluster.current_stage <> 'resolved'
    or v_cluster.resolved_at is null
    or v_cluster.evidence_revision is distinct from
      p_expected_evidence_revision
    or v_cluster.proposed_rule_id is distinct from p_policy_rule_id then
    raise exception using
      errcode = 'P0001',
      message = 'resolved promotion replay does not match the original accepted request, cluster, actor, revision, and rule';
  end if;

  select pg_catalog.count(*)::integer
  into v_promotion_count
  from public.monitoring_feedback_promotions promotion
  where promotion.promotion_transition_id = v_transition.id;

  return query select
    v_transition.id,
    v_cluster.id,
    v_transition.from_stage,
    v_cluster.current_stage,
    v_transition.requested_stage,
    true,
    false,
    null::text,
    v_promotion_count,
    v_transition.recurrence_count,
    v_cluster.evidence_revision;
end;
$function$;

create or replace function private.monitoring_feedback_canonical_json(
  p_value jsonb
)
returns text
language plpgsql
immutable
set search_path = ''
as $function$
declare
  v_type text := pg_catalog.jsonb_typeof(p_value);
  v_result text;
begin
  if v_type is null or v_type = 'null' then
    return 'null';
  elsif v_type in ('boolean', 'number', 'string') then
    return p_value::text;
  elsif v_type = 'array' then
    select '[' || coalesce(
      pg_catalog.string_agg(
        private.monitoring_feedback_canonical_json(item.value),
        ','
        order by item.ordinality
      ),
      ''
    ) || ']'
    into v_result
    from pg_catalog.jsonb_array_elements(p_value) with ordinality
      as item(value, ordinality);
    return v_result;
  elsif v_type = 'object' then
    select '{' || coalesce(
      pg_catalog.string_agg(
        pg_catalog.to_jsonb(entry.key)::text || ':' ||
          private.monitoring_feedback_canonical_json(entry.value),
        ','
        order by entry.key
      ),
      ''
    ) || '}'
    into v_result
    from pg_catalog.jsonb_each(p_value) entry;
    return v_result;
  end if;

  return 'null';
end;
$function$;

create or replace function private.monitoring_feedback_promotion_report_valid(
  p_value jsonb,
  p_schema_version text,
  p_cluster_key text,
  p_rule_id text,
  p_draft_hash text
)
returns boolean
language sql
immutable
set search_path = ''
as $function$
  select coalesce(
    pg_catalog.jsonb_typeof(coalesce(p_value, '{}'::jsonb)) = 'object'
    and p_value ->> 'schema_version' = p_schema_version
    and coalesce(p_value ->> 'report_id', '')
      ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    and coalesce(p_value ->> 'digest', '') ~ '^[0-9a-f]{64}$'
    and coalesce(p_value ->> 'completed_at', '')
      ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?Z$'
    and p_value ->> 'cluster_key' = p_cluster_key
    and p_value ->> 'rule_id' = p_rule_id
    and p_value ->> 'draft_hash' = p_draft_hash
    and public.awardping_sha256_text(
      private.monitoring_feedback_canonical_json(p_value - 'digest')
    ) = p_value ->> 'digest',
    false
  );
$function$;

create or replace function private.monitoring_feedback_normalize_pattern_text(
  p_value text
)
returns text
language plpgsql
immutable
set search_path = ''
as $function$
declare
  v_value text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_value, '')));
begin
  v_value := pg_catalog.regexp_replace(
    v_value,
    'https?://[^[:space:]"<>]+',
    '<url>',
    'gi'
  );
  v_value := pg_catalog.regexp_replace(
    v_value,
    '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}',
    '<uuid>',
    'gi'
  );
  v_value := pg_catalog.regexp_replace(
    v_value,
    '(^|[^0-9a-f])[0-9a-f]{32,}([^0-9a-f]|$)',
    '\1<hash>\2',
    'gi'
  );
  v_value := pg_catalog.regexp_replace(
    v_value,
    '[0-9]{4}[-/][0-9]{1,2}[-/][0-9]{1,2}',
    '<date>',
    'g'
  );
  v_value := pg_catalog.regexp_replace(
    v_value,
    '(^|[^a-z0-9])[0-9]+([.,][0-9]+)?([^a-z0-9]|$)',
    '\1<n>\3',
    'g'
  );
  return pg_catalog.regexp_replace(v_value, '[[:space:]]+', ' ', 'g');
end;
$function$;

create or replace function private.monitoring_feedback_sorted_pattern_text_array(
  p_value jsonb
)
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  select coalesce(
    pg_catalog.jsonb_agg(normalized.value order by normalized.value),
    '[]'::jsonb
  )
  from (
    select distinct private.monitoring_feedback_normalize_pattern_text(
      item.value #>> '{}'
    ) as value
    from pg_catalog.jsonb_array_elements(
      case
        when pg_catalog.jsonb_typeof(coalesce(p_value, 'null'::jsonb)) = 'array'
          then p_value
        else '[]'::jsonb
      end
    ) item(value)
    where pg_catalog.jsonb_typeof(item.value) = 'string'
      and private.monitoring_feedback_normalize_pattern_text(
        item.value #>> '{}'
      ) <> ''
  ) normalized;
$function$;

create or replace function private.monitoring_feedback_json_pattern_shape(
  p_value jsonb
)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $function$
declare
  v_result jsonb := '{}'::jsonb;
  v_key text;
  v_item jsonb;
  v_type text;
begin
  if pg_catalog.jsonb_typeof(coalesce(p_value, 'null'::jsonb)) <> 'object' then
    return '{}'::jsonb;
  end if;

  for v_key, v_item in
    select entry.key, entry.value
    from pg_catalog.jsonb_each(p_value) entry
    order by entry.key
  loop
    if v_key in ('snapshot', 'monitoring_policy', 'monitoring_policy_bundle')
      or v_key ~ '(^id$|_id$|_ids$|hash|url|uri|object_key|_path$|_ref$|captured_at$|detected_at$|created_at$|updated_at$)' then
      continue;
    end if;

    v_type := pg_catalog.jsonb_typeof(v_item);
    v_result := v_result || pg_catalog.jsonb_build_object(
      v_key,
      case
        when v_type = 'object'
          then private.monitoring_feedback_json_pattern_shape(v_item)
        else pg_catalog.to_jsonb(coalesce(v_type, 'null'))
      end
    );
  end loop;

  return v_result;
end;
$function$;

create or replace function private.monitoring_feedback_pattern_signature(
  p_event_evidence jsonb,
  p_event_summary text,
  p_page_type text,
  p_candidate_classification text,
  p_candidate_diff jsonb
)
returns text
language plpgsql
immutable
set search_path = ''
as $function$
declare
  v_evidence jsonb := coalesce(p_event_evidence, '{}'::jsonb);
  v_diff jsonb := coalesce(p_candidate_diff, '{}'::jsonb);
  v_classification text := private.monitoring_feedback_normalize_pattern_text(
    p_candidate_classification
  );
  v_noise_flags jsonb := private.monitoring_feedback_sorted_pattern_text_array(
    private.monitoring_feedback_sorted_pattern_text_array(
      v_evidence #> '{structured_diff,noise_flags}'
    ) || private.monitoring_feedback_sorted_pattern_text_array(
      v_diff -> 'noise_flags'
    )
  );
  v_quality_flags jsonb := private.monitoring_feedback_sorted_pattern_text_array(
    v_evidence -> 'quality_flags'
  );
  v_change_type text := private.monitoring_feedback_normalize_pattern_text(
    coalesce(
      v_evidence ->> 'change_type',
      v_evidence #>> '{structured_diff,change_type}',
      v_diff ->> 'change_type'
    )
  );
  v_payload jsonb;
begin
  if v_classification <> '' or pg_catalog.jsonb_array_length(v_noise_flags) > 0 then
    v_payload := pg_catalog.jsonb_strip_nulls(
      pg_catalog.jsonb_build_object(
        'schema', 'monitoring-feedback-pattern-v1',
        'mode', 'canonical_policy_noise',
        'classification', nullif(v_classification, ''),
        'change_type', nullif(v_change_type, ''),
        'noise_flags', v_noise_flags,
        'quality_flags', v_quality_flags,
        'candidate_scope', nullif(
          private.monitoring_feedback_normalize_pattern_text(
            v_diff ->> 'candidate_scope'
          ),
          ''
        ),
        'deterministic_shape', private.monitoring_feedback_json_pattern_shape(v_diff),
        'page_type', nullif(
          private.monitoring_feedback_normalize_pattern_text(p_page_type),
          ''
        )
      )
    );
  else
    v_payload := pg_catalog.jsonb_strip_nulls(
      pg_catalog.jsonb_build_object(
        'schema', 'monitoring-feedback-pattern-v1',
        'mode', 'normalized_evidence_fallback',
        'evidence_shape', private.monitoring_feedback_json_pattern_shape(v_evidence),
        'summary', nullif(
          private.monitoring_feedback_normalize_pattern_text(p_event_summary),
          ''
        ),
        'change_type', nullif(v_change_type, ''),
        'page_type', nullif(
          private.monitoring_feedback_normalize_pattern_text(p_page_type),
          ''
        )
      )
    );
  end if;

  return public.awardping_sha256_text(v_payload::text);
end;
$function$;

create or replace function private.monitoring_feedback_domain_template(
  p_url text,
  p_page_type text
)
returns text
language plpgsql
immutable
set search_path = ''
as $function$
declare
  v_value text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_url, '')));
  v_authority text;
  v_host text;
  v_path text;
  v_page_type text;
begin
  v_value := pg_catalog.regexp_replace(
    v_value,
    '^[a-z][a-z0-9+.-]*://',
    '',
    'i'
  );
  v_value := pg_catalog.split_part(pg_catalog.split_part(v_value, '#', 1), '?', 1);
  v_authority := pg_catalog.split_part(v_value, '/', 1);
  v_host := pg_catalog.regexp_replace(v_authority, '^.*@', '');
  v_host := pg_catalog.regexp_replace(v_host, ':[0-9]+$', '');
  v_host := pg_catalog.regexp_replace(v_host, '^www[.]', '');
  if v_host = '' then
    v_host := 'unknown-host';
  end if;

  v_path := pg_catalog.substr(v_value, pg_catalog.char_length(v_authority) + 1);
  v_path := '/' || pg_catalog.ltrim(coalesce(v_path, ''), '/');
  v_path := pg_catalog.regexp_replace(v_path, '/+', '/', 'g');
  v_path := pg_catalog.regexp_replace(
    v_path,
    '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(/|$)',
    '/:id\1',
    'g'
  );
  v_path := pg_catalog.regexp_replace(
    v_path,
    '/[0-9a-f]{16,}(/|$)',
    '/:id\1',
    'g'
  );
  v_path := pg_catalog.regexp_replace(
    v_path,
    '/[0-9]{2,}(/|$)',
    '/:n\1',
    'g'
  );
  if v_path <> '/' then
    v_path := pg_catalog.regexp_replace(v_path, '/+$', '');
  end if;

  v_page_type := pg_catalog.regexp_replace(
    pg_catalog.lower(pg_catalog.btrim(coalesce(p_page_type, 'unknown'))),
    '[^a-z0-9]+',
    '_',
    'g'
  );
  v_page_type := pg_catalog.btrim(v_page_type, '_');
  if v_page_type = '' then
    v_page_type := 'unknown';
  end if;

  return pg_catalog.left(v_host || v_path || '|' || v_page_type, 1000);
end;
$function$;

create or replace function private.sync_monitoring_feedback_promotion_clusters()
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_item record;
  v_cluster public.monitoring_feedback_promotion_clusters%rowtype;
  v_inserted_feedback_id uuid;
  v_resulting_stage text;
  v_activation_protected boolean;
begin
  with unresolved as (
    select
      feedback.id as feedback_id,
      feedback.request_id as feedback_request_id,
      feedback.actor_user_id,
      feedback.actor_email,
      feedback.requested_scope,
      feedback.reason_code,
      feedback.created_at,
      case
        when candidate.worker_metadata ->> 'evidence_signature' ~ '^[0-9a-f]{64}$'
          then candidate.worker_metadata ->> 'evidence_signature'
        else null
      end as visual_occurrence_signature,
      private.monitoring_feedback_pattern_signature(
        feedback.event_evidence,
        feedback.event_summary,
        feedback.event_source_page_type,
        candidate.deterministic_classification,
        candidate.deterministic_diff
      ) as evidence_signature,
      private.monitoring_feedback_domain_template(
        feedback.event_source_url,
        feedback.event_source_page_type
      ) as domain_template
    from public.monitoring_feedback feedback
    left join public.shared_award_change_events change_event
      on change_event.id = feedback.event_id
    left join public.shared_award_visual_review_candidates candidate
      on candidate.id = change_event.visual_review_candidate_id
    where feedback.promotion_status = 'pending_review'
      and not exists (
        select 1
        from public.monitoring_feedback_promotions promotion
        where promotion.feedback_id = feedback.id
      )
      and not exists (
        select 1
        from public.monitoring_feedback_promotion_cluster_members member
        where member.feedback_id = feedback.id
      )
  ), classified as (
    select
      unresolved.*,
      public.awardping_sha256_text(
        pg_catalog.jsonb_build_array(
          unresolved.evidence_signature,
          unresolved.domain_template,
          unresolved.reason_code
        )::text
      ) as cluster_key
    from unresolved
  )
  insert into public.monitoring_feedback_promotion_clusters (
    cluster_key,
    evidence_signature,
    domain_template,
    reason_code,
    current_stage,
    stage_artifacts,
    created_at,
    updated_at
  )
  select distinct on (classified.cluster_key)
    classified.cluster_key,
    classified.evidence_signature,
    classified.domain_template,
    classified.reason_code,
    'triaged',
    pg_catalog.jsonb_build_object(
      'triaged',
      pg_catalog.jsonb_build_object(
        'action', 'not_an_update_submitted',
        'feedback_id', classified.feedback_id,
        'feedback_request_id', classified.feedback_request_id,
        'actor_user_id', classified.actor_user_id,
        'actor_email', classified.actor_email,
        'requested_scope', classified.requested_scope,
        'visual_occurrence_signature', classified.visual_occurrence_signature,
        'evidence_revision', 1,
        'submitted_at', classified.created_at,
        'completed_at', pg_catalog.clock_timestamp(),
        'clustering_version', 'normalized-pattern-domain-reason-v2'
      )
    ),
    classified.created_at,
    pg_catalog.clock_timestamp()
  from classified
  where not exists (
    select 1
    from public.monitoring_feedback_promotion_clusters existing
    where existing.cluster_key = classified.cluster_key
      and existing.resolved_at is null
  )
  order by classified.cluster_key, classified.created_at, classified.feedback_id
  on conflict do nothing;

  for v_item in
    with unresolved as (
      select
        feedback.id as feedback_id,
        feedback.actor_user_id,
        feedback.actor_email,
        feedback.request_id as feedback_request_id,
        feedback.created_at,
        feedback.reason_code,
        case
          when candidate.worker_metadata ->> 'evidence_signature' ~ '^[0-9a-f]{64}$'
            then candidate.worker_metadata ->> 'evidence_signature'
          else null
        end as visual_occurrence_signature,
        private.monitoring_feedback_pattern_signature(
          feedback.event_evidence,
          feedback.event_summary,
          feedback.event_source_page_type,
          candidate.deterministic_classification,
          candidate.deterministic_diff
        ) as evidence_signature,
        private.monitoring_feedback_domain_template(
          feedback.event_source_url,
          feedback.event_source_page_type
        ) as domain_template
      from public.monitoring_feedback feedback
      left join public.shared_award_change_events change_event
        on change_event.id = feedback.event_id
      left join public.shared_award_visual_review_candidates candidate
        on candidate.id = change_event.visual_review_candidate_id
      where feedback.promotion_status = 'pending_review'
        and not exists (
          select 1
          from public.monitoring_feedback_promotions promotion
          where promotion.feedback_id = feedback.id
        )
        and not exists (
          select 1
          from public.monitoring_feedback_promotion_cluster_members member
          where member.feedback_id = feedback.id
        )
    )
    select
      unresolved.*,
      public.awardping_sha256_text(
        pg_catalog.jsonb_build_array(
          unresolved.evidence_signature,
          unresolved.domain_template,
          unresolved.reason_code
        )::text
      ) as cluster_key
    from unresolved
    order by unresolved.created_at, unresolved.feedback_id
  loop
    select cluster.*
    into v_cluster
    from public.monitoring_feedback_promotion_clusters cluster
    where cluster.cluster_key = v_item.cluster_key
      and cluster.resolved_at is null
    for update;

    if not found then
      raise exception 'unresolved promotion cluster disappeared during evidence sync'
        using errcode = '40001';
    end if;

    v_inserted_feedback_id := null;
    insert into public.monitoring_feedback_promotion_cluster_members (
      cluster_id,
      feedback_id
    ) values (
      v_cluster.id,
      v_item.feedback_id
    )
    on conflict (feedback_id) do nothing
    returning feedback_id into v_inserted_feedback_id;

    if v_inserted_feedback_id is null then
      continue;
    end if;

    v_activation_protected :=
      v_cluster.current_stage in ('six_pm_canary', 'retroactive_sweep')
      and v_cluster.activation_status in (
        'armed',
        'blocked_late_evidence',
        'rollback_required',
        'sweep_completed'
      );

    v_resulting_stage := case
      when v_activation_protected then v_cluster.current_stage
      when private.monitoring_feedback_promotion_stage_ordinal(
        v_cluster.current_stage
      ) >= private.monitoring_feedback_promotion_stage_ordinal('rule_drafted')
        then 'similar_feedback_clustered'
      else v_cluster.current_stage
    end;

    update public.monitoring_feedback_promotion_clusters cluster
    set
      evidence_revision = v_cluster.evidence_revision + 1,
      current_stage = v_resulting_stage,
      proposed_rule_id = case
        when v_resulting_stage = 'similar_feedback_clustered'
          and v_cluster.current_stage <> 'similar_feedback_clustered'
          then null
        else cluster.proposed_rule_id
      end,
      stage_artifacts = case
        when not v_activation_protected
          and v_resulting_stage = 'similar_feedback_clustered'
          and v_cluster.current_stage <> 'similar_feedback_clustered'
          then cluster.stage_artifacts - array[
            'rule_drafted',
            'historical_shadow_test',
            'regression_tests_pass',
            'app_worker_hashes_match',
            'six_pm_canary',
            'retroactive_sweep',
            'resolved'
          ]::text[]
        else cluster.stage_artifacts
      end,
      activation_status = case
        when v_activation_protected
          and v_cluster.activation_status = 'rollback_required'
          then 'rollback_required'
        when v_activation_protected then 'blocked_late_evidence'
        else 'inactive'
      end,
      activation_blocked_at = case
        when v_activation_protected
          then coalesce(cluster.activation_blocked_at, pg_catalog.clock_timestamp())
        else null
      end,
      updated_at = pg_catalog.clock_timestamp()
    where cluster.id = v_cluster.id;

    if v_cluster.evidence_revision > 0 then
      insert into public.monitoring_feedback_promotion_transitions (
        request_id,
        cluster_id,
        from_stage,
        requested_stage,
        resulting_stage,
        accepted,
        transition_kind,
        evidence_revision,
        recurrence_count,
        actor_user_id,
        actor_email,
        policy_rule_id,
        evidence,
        note
      ) values (
        gen_random_uuid(),
        v_cluster.id,
        v_cluster.current_stage,
        v_resulting_stage,
        v_resulting_stage,
        true,
        case
          when v_activation_protected then 'activation_drift'
          else 'evidence_restart'
        end,
        v_cluster.evidence_revision + 1,
        v_cluster.evidence_revision + 1,
        v_item.actor_user_id,
        v_item.actor_email,
        v_cluster.proposed_rule_id,
        pg_catalog.jsonb_build_object(
          'event', 'feedback_evidence_changed',
          'feedback_id', v_item.feedback_id,
          'feedback_request_id', v_item.feedback_request_id,
          'visual_occurrence_signature', v_item.visual_occurrence_signature,
          'previous_evidence_revision', v_cluster.evidence_revision,
          'evidence_revision', v_cluster.evidence_revision + 1,
          'previous_stage', v_cluster.current_stage,
          'resulting_stage', v_resulting_stage,
          'invalidated_completed_gates',
            v_cluster.current_stage <> v_resulting_stage,
          'recorded_at', pg_catalog.clock_timestamp()
        ),
        case
          when v_activation_protected
            then 'Late evidence blocked activation or sweep mutation without discarding the reviewed rule and audit.'
          else 'New same-pattern feedback changed the evidence set; later gates must be re-sealed.'
        end
      );
    end if;
  end loop;
end;
$function$;

create or replace function private.sync_monitoring_feedback_promotion_clusters_after_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.sync_monitoring_feedback_promotion_clusters();
  return new;
end;
$function$;

create or replace function private.protect_monitoring_feedback_promotion_cluster()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if tg_op = 'DELETE' then
    raise exception 'monitoring_feedback_promotion_clusters cannot be deleted'
      using errcode = '55000';
  end if;

  if new.id is distinct from old.id
    or new.cluster_key is distinct from old.cluster_key
    or new.evidence_signature is distinct from old.evidence_signature
    or new.domain_template is distinct from old.domain_template
    or new.reason_code is distinct from old.reason_code
    or new.created_at is distinct from old.created_at then
    raise exception 'monitoring feedback promotion cluster identity is immutable'
      using errcode = '55000';
  end if;

  if new.evidence_revision = old.evidence_revision + 1 then
    if old.current_stage in ('six_pm_canary', 'retroactive_sweep')
      and old.activation_status in (
        'armed',
        'blocked_late_evidence',
        'rollback_required',
        'sweep_completed'
      ) then
      if new.current_stage is distinct from old.current_stage
        or new.proposed_rule_id is distinct from old.proposed_rule_id
        or new.stage_artifacts is distinct from old.stage_artifacts
        or new.resolved_at is distinct from old.resolved_at
        or new.activation_status is distinct from (case
          when old.activation_status = 'rollback_required'
            then 'rollback_required'
          else 'blocked_late_evidence'
        end)
        or new.activation_blocked_at is null then
        raise exception 'late activation evidence must block mutation without discarding audit artifacts'
          using errcode = '22023';
      end if;
      return new;
    end if;

    if private.monitoring_feedback_promotion_stage_ordinal(old.current_stage)
        >= private.monitoring_feedback_promotion_stage_ordinal('rule_drafted') then
      if new.current_stage is distinct from 'similar_feedback_clustered'
        or new.proposed_rule_id is not null
        or new.resolved_at is not null
        or new.activation_status is distinct from 'inactive'
        or new.activation_blocked_at is not null
        or new.stage_artifacts ?| array[
          'rule_drafted',
          'historical_shadow_test',
          'regression_tests_pass',
          'app_worker_hashes_match',
          'six_pm_canary',
          'retroactive_sweep',
          'resolved'
        ]::text[] then
        raise exception 'late evidence must reset the workflow to a clean clustered stage'
          using errcode = '22023';
      end if;
    elsif new.current_stage is distinct from old.current_stage
      or new.proposed_rule_id is distinct from old.proposed_rule_id
      or new.stage_artifacts is distinct from old.stage_artifacts
      or new.resolved_at is distinct from old.resolved_at
      or new.activation_status is distinct from old.activation_status
      or new.activation_blocked_at is distinct from old.activation_blocked_at then
      raise exception 'early evidence absorption may only bump the evidence revision'
        using errcode = '22023';
    end if;
    return new;
  elsif new.evidence_revision is distinct from old.evidence_revision then
    raise exception 'monitoring feedback evidence revisions must increment exactly once'
      using errcode = '22023';
  end if;

  if new.evidence_revision = old.evidence_revision
    and old.current_stage in ('six_pm_canary', 'retroactive_sweep')
    and old.activation_status in ('blocked_late_evidence', 'rollback_required')
    and new.current_stage = 'similar_feedback_clustered' then
    if new.proposed_rule_id is not null
      or new.resolved_at is not null
      or new.activation_status is distinct from 'inactive'
      or new.activation_blocked_at is not null
      or new.stage_artifacts is distinct from old.stage_artifacts - array[
        'rule_drafted',
        'historical_shadow_test',
        'regression_tests_pass',
        'app_worker_hashes_match',
        'six_pm_canary',
        'retroactive_sweep',
        'resolved'
      ]::text[]
      or not exists (
        select 1
        from public.monitoring_feedback_promotion_transitions transition
        where transition.id = (
          select latest.id
          from public.monitoring_feedback_promotion_transitions latest
          where latest.cluster_id = old.id
            and latest.evidence_revision = old.evidence_revision
          order by latest.created_at desc, latest.id desc
          limit 1
        )
          and transition.transition_kind = 'activation_rollback'
          and transition.accepted
          and transition.from_stage = old.current_stage
          and transition.requested_stage = 'similar_feedback_clustered'
          and transition.resulting_stage = 'similar_feedback_clustered'
      ) then
      raise exception 'activation rollback must retain a matching immutable audit transition'
        using errcode = '22023';
    end if;
    return new;
  end if;

  if new.evidence_revision = old.evidence_revision
    and old.current_stage in ('six_pm_canary', 'retroactive_sweep')
    and old.activation_status in ('armed', 'sweep_completed')
    and new.current_stage = old.current_stage
    and new.activation_status = 'rollback_required' then
    if new.proposed_rule_id is distinct from old.proposed_rule_id
      or new.resolved_at is distinct from old.resolved_at
      or new.stage_artifacts is distinct from old.stage_artifacts
      or new.activation_blocked_at is null
      or not exists (
        select 1
        from public.monitoring_feedback_promotion_transitions transition
        where transition.id = (
          select latest.id
          from public.monitoring_feedback_promotion_transitions latest
          where latest.cluster_id = old.id
            and latest.evidence_revision = old.evidence_revision
          order by latest.created_at desc, latest.id desc
          limit 1
        )
          and transition.transition_kind = 'activation_rollback_required'
          and transition.accepted
          and transition.from_stage = old.current_stage
          and transition.requested_stage = old.current_stage
          and transition.resulting_stage = old.current_stage
      ) then
      raise exception 'rollback-required activation state needs a matching immutable audit transition'
        using errcode = '22023';
    end if;
    return new;
  end if;

  if new.evidence_revision = old.evidence_revision
    and old.current_stage in (
      'rule_drafted',
      'historical_shadow_test',
      'regression_tests_pass',
      'app_worker_hashes_match'
    )
    and new.current_stage = 'similar_feedback_clustered' then
    if new.proposed_rule_id is not null
      or new.resolved_at is not null
      or old.activation_status is distinct from 'inactive'
      or new.activation_status is distinct from 'inactive'
      or new.activation_blocked_at is not null
      or new.stage_artifacts is distinct from old.stage_artifacts - array[
        'rule_drafted',
        'historical_shadow_test',
        'regression_tests_pass',
        'app_worker_hashes_match',
        'six_pm_canary',
        'retroactive_sweep',
        'resolved'
      ]::text[]
      or not exists (
        select 1
        from public.monitoring_feedback_promotion_transitions transition
        where transition.id = (
          select latest.id
          from public.monitoring_feedback_promotion_transitions latest
          where latest.cluster_id = old.id
            and latest.evidence_revision = old.evidence_revision
          order by latest.created_at desc, latest.id desc
          limit 1
        )
          and transition.transition_kind = 'operator_restart'
          and transition.accepted
          and transition.from_stage = old.current_stage
          and transition.requested_stage = 'similar_feedback_clustered'
          and transition.resulting_stage = 'similar_feedback_clustered'
      ) then
      raise exception 'operator restart must retain a matching immutable audit transition'
        using errcode = '22023';
    end if;
    return new;
  end if;

  if private.monitoring_feedback_promotion_stage_ordinal(new.current_stage)
      <> private.monitoring_feedback_promotion_stage_ordinal(old.current_stage) + 1 then
    raise exception 'monitoring feedback promotion stages must advance exactly once'
      using errcode = '22023';
  end if;

  if new.current_stage = 'six_pm_canary' then
    if old.activation_status is distinct from 'inactive'
      or new.activation_status is distinct from 'armed'
      or new.activation_blocked_at is not null then
      raise exception 'a passing canary must arm exactly one inactive candidate'
        using errcode = '22023';
    end if;
  elsif new.current_stage = 'retroactive_sweep' then
    if old.activation_status is distinct from 'armed'
      or new.activation_status is distinct from 'sweep_completed'
      or new.activation_blocked_at is not null then
      raise exception 'a retroactive sweep may complete only from an unblocked armed candidate'
        using errcode = '22023';
    end if;
  elsif new.current_stage = 'resolved' then
    if old.activation_status is distinct from 'sweep_completed'
      or new.activation_status is distinct from 'sweep_completed'
      or new.activation_blocked_at is not null then
      raise exception 'resolution requires an unblocked completed sweep'
        using errcode = '22023';
    end if;
  elsif new.activation_status is distinct from old.activation_status
    or new.activation_blocked_at is distinct from old.activation_blocked_at then
    raise exception 'promotion activation state cannot change outside guarded gates'
      using errcode = '22023';
  end if;

  if old.proposed_rule_id is not null
    and new.proposed_rule_id is distinct from old.proposed_rule_id then
    raise exception 'the proposed monitoring rule is immutable after drafting'
      using errcode = '55000';
  end if;

  if not (new.stage_artifacts ? new.current_stage) then
    raise exception 'the completed stage must retain its verification artifacts'
      using errcode = '22023';
  end if;

  return new;
end;
$function$;

drop trigger if exists monitoring_feedback_promotion_clusters_guard
  on public.monitoring_feedback_promotion_clusters;
create trigger monitoring_feedback_promotion_clusters_guard
before update or delete on public.monitoring_feedback_promotion_clusters
for each row execute function private.protect_monitoring_feedback_promotion_cluster();

drop trigger if exists monitoring_feedback_promotion_clusters_sync_after_feedback
  on public.monitoring_feedback;
create trigger monitoring_feedback_promotion_clusters_sync_after_feedback
after insert on public.monitoring_feedback
for each row
execute function private.sync_monitoring_feedback_promotion_clusters_after_insert();

drop trigger if exists monitoring_feedback_promotion_cluster_members_append_only
  on public.monitoring_feedback_promotion_cluster_members;
create trigger monitoring_feedback_promotion_cluster_members_append_only
before update or delete on public.monitoring_feedback_promotion_cluster_members
for each row execute function private.prevent_monitoring_feedback_mutation();

drop trigger if exists visual_review_candidate_run_observations_append_only
  on public.shared_award_visual_review_candidate_run_observations;
create trigger visual_review_candidate_run_observations_append_only
before update or delete
on public.shared_award_visual_review_candidate_run_observations
for each row execute function private.prevent_monitoring_feedback_mutation();

drop trigger if exists monitoring_feedback_promotion_transitions_append_only
  on public.monitoring_feedback_promotion_transitions;
create trigger monitoring_feedback_promotion_transitions_append_only
before update or delete on public.monitoring_feedback_promotion_transitions
for each row execute function private.prevent_monitoring_feedback_mutation();

drop trigger if exists monitoring_feedback_promotion_sweep_reversal_append_only
  on public.monitoring_feedback_promotion_sweep_reversal_audit;
create trigger monitoring_feedback_promotion_sweep_reversal_append_only
before update or delete on public.monitoring_feedback_promotion_sweep_reversal_audit
for each row execute function private.prevent_monitoring_feedback_mutation();

alter table public.monitoring_feedback_promotion_clusters enable row level security;
alter table public.monitoring_feedback_promotion_cluster_members enable row level security;
alter table public.monitoring_feedback_promotion_transitions enable row level security;
alter table public.monitoring_feedback_promotion_worker_leases enable row level security;
alter table public.monitoring_feedback_promotion_sweep_reversal_audit
  enable row level security;
alter table public.shared_award_visual_review_candidate_run_observations
  enable row level security;

revoke all on table public.monitoring_feedback_promotion_clusters
  from public, anon, authenticated, service_role;
revoke all on table public.monitoring_feedback_promotion_cluster_members
  from public, anon, authenticated, service_role;
revoke all on table public.monitoring_feedback_promotion_transitions
  from public, anon, authenticated, service_role;
revoke all on table public.monitoring_feedback_promotion_worker_leases
  from public, anon, authenticated, service_role;
revoke all on table public.monitoring_feedback_promotion_sweep_reversal_audit
  from public, anon, authenticated, service_role;
revoke all on table public.shared_award_visual_review_candidate_run_observations
  from public, anon, authenticated, service_role;
grant select, insert
  on table public.shared_award_visual_review_candidate_run_observations
  to service_role;

-- Remove the old one-click bypass. The guarded cluster transition is now the
-- only service-role path that can append a final promotion.
revoke insert, update, delete on table public.monitoring_feedback_promotions
  from service_role;
revoke execute on function public.record_monitoring_feedback_promotion(
  uuid,
  uuid,
  uuid,
  text,
  text,
  text,
  text,
  text,
  integer,
  integer,
  text
) from public, anon, authenticated, service_role;

create or replace function public.list_monitoring_feedback_promotion_clusters(
  p_limit integer default 100,
  p_include_resolved boolean default false
)
returns table (
  cluster_id uuid,
  cluster_key text,
  evidence_signature text,
  domain_template text,
  reason_code text,
  current_stage text,
  proposed_rule_id text,
  evidence_revision bigint,
  activation_status text,
  activation_blocked_at timestamptz,
  stage_artifacts jsonb,
  recurrence_count bigint,
  source_count bigint,
  sample_evidence jsonb,
  legitimate_collision_count bigint,
  legitimate_collisions jsonb,
  latest_attempt_stage text,
  latest_attempt_accepted boolean,
  latest_attempt_failure_reason text,
  latest_attempt_created_at timestamptz,
  latest_attempt_evidence jsonb,
  latest_blocking_transition_kind text,
  latest_blocking_transition_created_at timestamptz,
  latest_blocking_transition_evidence jsonb,
  created_at timestamptz,
  updated_at timestamptz,
  resolved_at timestamptz,
  resolution_ready boolean,
  resolution_worker_run_id uuid,
  resolution_attested_at timestamptz,
  total_clusters bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform private.sync_monitoring_feedback_promotion_clusters();

  return query
  with selected as (
    select cluster.*
    from public.monitoring_feedback_promotion_clusters cluster
    where coalesce(p_include_resolved, false) or cluster.resolved_at is null
  )
  select
    selected.id,
    selected.cluster_key,
    selected.evidence_signature,
    selected.domain_template,
    selected.reason_code,
    selected.current_stage,
    selected.proposed_rule_id,
    selected.evidence_revision,
    selected.activation_status,
    selected.activation_blocked_at,
    selected.stage_artifacts,
    stats.recurrence_count,
    stats.source_count,
    samples.sample_evidence,
    coalesce(
      private.monitoring_feedback_json_nonnegative_bigint(
        shadow_attempt.evidence,
        'legitimate_updates_suppressed'
      ),
      pg_catalog.jsonb_array_length(
        case
          when pg_catalog.jsonb_typeof(
            shadow_attempt.evidence -> 'legitimate_updates'
          ) = 'array'
            then shadow_attempt.evidence -> 'legitimate_updates'
          else '[]'::jsonb
        end
      )::bigint,
      0::bigint
    ),
    case
      when pg_catalog.jsonb_typeof(
        shadow_attempt.evidence -> 'legitimate_updates'
      ) = 'array'
        then shadow_attempt.evidence -> 'legitimate_updates'
      else '[]'::jsonb
    end,
    latest_attempt.requested_stage,
    latest_attempt.accepted,
    latest_attempt.failure_reason,
    latest_attempt.created_at,
    latest_attempt.evidence,
    latest_blocker.transition_kind,
    latest_blocker.created_at,
    latest_blocker.evidence,
    selected.created_at,
    selected.updated_at,
    selected.resolved_at,
    resolution_run.worker_run_id is not null,
    resolution_run.worker_run_id,
    resolution_run.finished_at,
    pg_catalog.count(*) over ()
  from selected
  join lateral (
    select
      pg_catalog.count(*)::bigint as recurrence_count,
      pg_catalog.count(distinct feedback.source_id)::bigint as source_count
    from public.monitoring_feedback_promotion_cluster_members member
    join public.monitoring_feedback feedback
      on feedback.id = member.feedback_id
    where member.cluster_id = selected.id
  ) stats on true
  join lateral (
    select coalesce(
      pg_catalog.jsonb_agg(
        sample.payload
        order by sample.submitted_at, sample.feedback_id
      ),
      '[]'::jsonb
    ) as sample_evidence
    from (
      select
        feedback.id as feedback_id,
        feedback.created_at as submitted_at,
        pg_catalog.jsonb_build_object(
          'feedback_id', feedback.id,
          'event_id', feedback.event_id,
          'source_id', feedback.source_id,
          'award_id', feedback.award_id,
          'source_title', feedback.event_source_title,
          'source_url', feedback.event_source_url,
          'source_page_type', feedback.event_source_page_type,
          'event_summary', feedback.event_summary,
          'event_evidence', feedback.event_evidence,
          'visual_occurrence_signature', case
            when sample_candidate.worker_metadata ->> 'evidence_signature'
              ~ '^[0-9a-f]{64}$'
              then sample_candidate.worker_metadata ->> 'evidence_signature'
            else null
          end,
          'requested_scope', feedback.requested_scope,
          'note', feedback.note,
          'actor_email', feedback.actor_email,
          'submitted_at', feedback.created_at
        ) as payload
      from public.monitoring_feedback_promotion_cluster_members member
      join public.monitoring_feedback feedback
        on feedback.id = member.feedback_id
      left join public.shared_award_change_events sample_event
        on sample_event.id = feedback.event_id
      left join public.shared_award_visual_review_candidates sample_candidate
        on sample_candidate.id = sample_event.visual_review_candidate_id
      where member.cluster_id = selected.id
      order by feedback.created_at, feedback.id
      limit 3
    ) sample
  ) samples on true
  left join lateral (
    select transition.*
    from public.monitoring_feedback_promotion_transitions transition
    where transition.cluster_id = selected.id
      and transition.evidence_revision = selected.evidence_revision
      and transition.transition_kind = 'stage_attempt'
      and transition.resulting_stage = selected.current_stage
      and not exists (
        select 1
        from public.monitoring_feedback_promotion_transitions reset_transition
        where reset_transition.cluster_id = transition.cluster_id
          and reset_transition.evidence_revision = transition.evidence_revision
          and reset_transition.transition_kind in (
            'evidence_restart',
            'operator_restart',
            'activation_rollback'
          )
          and (reset_transition.created_at, reset_transition.id) >
            (transition.created_at, transition.id)
      )
    order by transition.created_at desc, transition.id desc
    limit 1
  ) latest_attempt on true
  left join lateral (
    select
      transition.transition_kind,
      transition.created_at,
      transition.evidence
    from public.monitoring_feedback_promotion_transitions transition
    where transition.cluster_id = selected.id
      and transition.evidence_revision = selected.evidence_revision
      and transition.accepted
      and transition.transition_kind in (
        'activation_drift',
        'activation_rollback_required'
      )
    order by transition.created_at desc, transition.id desc
    limit 1
  ) latest_blocker on true
  left join lateral (
    select transition.evidence
    from public.monitoring_feedback_promotion_transitions transition
    where transition.cluster_id = selected.id
      and transition.evidence_revision = selected.evidence_revision
      and transition.transition_kind = 'stage_attempt'
      and transition.requested_stage = 'historical_shadow_test'
      and not exists (
        select 1
        from public.monitoring_feedback_promotion_transitions reset_transition
        where reset_transition.cluster_id = transition.cluster_id
          and reset_transition.evidence_revision = transition.evidence_revision
          and reset_transition.transition_kind in (
            'evidence_restart',
            'operator_restart',
            'activation_rollback'
          )
          and (reset_transition.created_at, reset_transition.id) >
            (transition.created_at, transition.id)
      )
    order by transition.created_at desc, transition.id desc
    limit 1
  ) shadow_attempt on true
  left join lateral (
    select ready_run.*
    from private.find_monitoring_feedback_resolution_worker_run(
      selected.id,
      selected.evidence_revision,
      case
        when coalesce(
          selected.stage_artifacts #>> '{retroactive_sweep,completed_at}',
          ''
        ) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?Z$'
          then (
            selected.stage_artifacts #>> '{retroactive_sweep,completed_at}'
          )::timestamptz
        else null
      end,
      selected.stage_artifacts #>> '{retroactive_sweep,activation_attestation,worker_revision}',
      selected.stage_artifacts #>> '{retroactive_sweep,activation_attestation,worker_policy_hash}',
      selected.stage_artifacts #>> '{retroactive_sweep,activation_attestation,worker_batch_policy_hash}',
      selected.stage_artifacts #>> '{retroactive_sweep,activation_attestation,worker_suppression_policy_hash}',
      selected.stage_artifacts #>> '{retroactive_sweep,activation_attestation,worker_matcher_digest}'
    ) ready_run
    where selected.current_stage = 'retroactive_sweep'
      and selected.activation_status = 'sweep_completed'
      and selected.resolved_at is null
  ) resolution_run on true
  order by
    case when selected.resolved_at is null then 0 else 1 end,
    selected.created_at,
    selected.id
  limit pg_catalog.greatest(1, pg_catalog.least(coalesce(p_limit, 100), 500));
end;
$function$;

create or replace function public.list_monitoring_feedback_promotion_worker_queue(
  p_limit integer default 100
)
returns table (
  cluster_id uuid,
  cluster_key text,
  current_stage text,
  proposed_rule_id text,
  evidence_revision bigint,
  activation_status text,
  updated_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform private.sync_monitoring_feedback_promotion_clusters();

  return query
  with eligible as materialized (
    select
      cluster.id,
      cluster.cluster_key,
      cluster.current_stage,
      cluster.proposed_rule_id,
      cluster.evidence_revision,
      cluster.activation_status,
      cluster.updated_at,
      lease.last_polled_at
    from public.monitoring_feedback_promotion_clusters cluster
    left join public.monitoring_feedback_promotion_worker_leases lease
      on lease.cluster_id = cluster.id
    where cluster.resolved_at is null
      and cluster.current_stage in (
        'rule_drafted',
        'historical_shadow_test',
        'regression_tests_pass',
        'app_worker_hashes_match',
        'six_pm_canary',
        'retroactive_sweep'
      )
      and (
        cluster.current_stage <> 'retroactive_sweep'
        or cluster.activation_status in (
          'blocked_late_evidence',
          'rollback_required',
          'sweep_completed'
        )
      )
    order by
      coalesce(lease.last_polled_at, '-infinity'::timestamptz),
      cluster.updated_at,
      cluster.id
    limit pg_catalog.greatest(1, pg_catalog.least(coalesce(p_limit, 100), 500))
    for update of cluster skip locked
  ), touched as (
    insert into public.monitoring_feedback_promotion_worker_leases as lease (
      cluster_id,
      last_polled_at,
      poll_count
    )
    select
      eligible.id,
      pg_catalog.clock_timestamp(),
      1
    from eligible
    on conflict (cluster_id) do update
    set
      last_polled_at = excluded.last_polled_at,
      poll_count = lease.poll_count + 1
    returning cluster_id
  )
  select
    eligible.id,
    eligible.cluster_key,
    eligible.current_stage,
    eligible.proposed_rule_id,
    eligible.evidence_revision,
    eligible.activation_status,
    eligible.updated_at
  from eligible
  join touched on touched.cluster_id = eligible.id
  order by
    coalesce(eligible.last_polled_at, '-infinity'::timestamptz),
    eligible.updated_at,
    eligible.id;
end;
$function$;

create or replace function public.list_unresolved_monitoring_feedback_promotion_rule_ids()
returns table (
  policy_rule_id text
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  -- Fail closed in the general sweep: every drafted-but-unresolved candidate is
  -- excluded, without pagination, until it either resolves or is rolled back.
  perform private.sync_monitoring_feedback_promotion_clusters();

  return query
  select distinct cluster.proposed_rule_id
  from public.monitoring_feedback_promotion_clusters cluster
  where cluster.resolved_at is null
    and cluster.proposed_rule_id is not null
  order by cluster.proposed_rule_id;
end;
$function$;

create or replace function public.get_monitoring_feedback_promotion_cluster(
  p_cluster_id uuid
)
returns table (
  cluster_id uuid,
  cluster_key text,
  evidence_signature text,
  domain_template text,
  reason_code text,
  current_stage text,
  proposed_rule_id text,
  evidence_revision bigint,
  activation_status text,
  activation_blocked_at timestamptz,
  stage_artifacts jsonb,
  recurrence_count bigint,
  source_count bigint,
  sample_evidence jsonb,
  legitimate_collision_count bigint,
  legitimate_collisions jsonb,
  latest_attempt_stage text,
  latest_attempt_accepted boolean,
  latest_attempt_failure_reason text,
  latest_attempt_created_at timestamptz,
  latest_attempt_evidence jsonb,
  latest_blocking_transition_kind text,
  latest_blocking_transition_created_at timestamptz,
  latest_blocking_transition_evidence jsonb,
  created_at timestamptz,
  updated_at timestamptz,
  resolved_at timestamptz,
  resolution_ready boolean,
  resolution_worker_run_id uuid,
  resolution_attested_at timestamptz,
  total_clusters bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  if p_cluster_id is null then
    raise exception 'promotion cluster ID is required'
      using errcode = '22004';
  end if;

  perform private.sync_monitoring_feedback_promotion_clusters();

  if not exists (
    select 1
    from public.monitoring_feedback_promotion_clusters cluster
    where cluster.id = p_cluster_id
  ) then
    raise exception 'monitoring feedback promotion cluster was not found'
      using errcode = 'P0002';
  end if;

  return query
  select
    selected.id,
    selected.cluster_key,
    selected.evidence_signature,
    selected.domain_template,
    selected.reason_code,
    selected.current_stage,
    selected.proposed_rule_id,
    selected.evidence_revision,
    selected.activation_status,
    selected.activation_blocked_at,
    selected.stage_artifacts,
    stats.recurrence_count,
    stats.source_count,
    samples.sample_evidence,
    coalesce(
      private.monitoring_feedback_json_nonnegative_bigint(
        shadow_attempt.evidence,
        'legitimate_updates_suppressed'
      ),
      pg_catalog.jsonb_array_length(
        case
          when pg_catalog.jsonb_typeof(
            shadow_attempt.evidence -> 'legitimate_updates'
          ) = 'array'
            then shadow_attempt.evidence -> 'legitimate_updates'
          else '[]'::jsonb
        end
      )::bigint,
      0::bigint
    ),
    case
      when pg_catalog.jsonb_typeof(
        shadow_attempt.evidence -> 'legitimate_updates'
      ) = 'array'
        then shadow_attempt.evidence -> 'legitimate_updates'
      else '[]'::jsonb
    end,
    latest_attempt.requested_stage,
    latest_attempt.accepted,
    latest_attempt.failure_reason,
    latest_attempt.created_at,
    latest_attempt.evidence,
    latest_blocker.transition_kind,
    latest_blocker.created_at,
    latest_blocker.evidence,
    selected.created_at,
    selected.updated_at,
    selected.resolved_at,
    resolution_run.worker_run_id is not null,
    resolution_run.worker_run_id,
    resolution_run.finished_at,
    1::bigint
  from public.monitoring_feedback_promotion_clusters selected
  join lateral (
    select
      pg_catalog.count(*)::bigint as recurrence_count,
      pg_catalog.count(distinct feedback.source_id)::bigint as source_count
    from public.monitoring_feedback_promotion_cluster_members member
    join public.monitoring_feedback feedback
      on feedback.id = member.feedback_id
    where member.cluster_id = selected.id
  ) stats on true
  join lateral (
    select coalesce(
      pg_catalog.jsonb_agg(
        sample.payload
        order by sample.submitted_at, sample.feedback_id
      ),
      '[]'::jsonb
    ) as sample_evidence
    from (
      select
        feedback.id as feedback_id,
        feedback.created_at as submitted_at,
        pg_catalog.jsonb_build_object(
          'feedback_id', feedback.id,
          'event_id', feedback.event_id,
          'source_id', feedback.source_id,
          'award_id', feedback.award_id,
          'source_title', feedback.event_source_title,
          'source_url', feedback.event_source_url,
          'source_page_type', feedback.event_source_page_type,
          'event_summary', feedback.event_summary,
          'event_evidence', feedback.event_evidence,
          'visual_occurrence_signature', case
            when sample_candidate.worker_metadata ->> 'evidence_signature'
              ~ '^[0-9a-f]{64}$'
              then sample_candidate.worker_metadata ->> 'evidence_signature'
            else null
          end,
          'requested_scope', feedback.requested_scope,
          'note', feedback.note,
          'actor_email', feedback.actor_email,
          'submitted_at', feedback.created_at
        ) as payload
      from public.monitoring_feedback_promotion_cluster_members member
      join public.monitoring_feedback feedback
        on feedback.id = member.feedback_id
      left join public.shared_award_change_events sample_event
        on sample_event.id = feedback.event_id
      left join public.shared_award_visual_review_candidates sample_candidate
        on sample_candidate.id = sample_event.visual_review_candidate_id
      where member.cluster_id = selected.id
      order by feedback.created_at, feedback.id
      limit 3
    ) sample
  ) samples on true
  left join lateral (
    select transition.*
    from public.monitoring_feedback_promotion_transitions transition
    where transition.cluster_id = selected.id
      and transition.evidence_revision = selected.evidence_revision
      and transition.transition_kind = 'stage_attempt'
      and transition.resulting_stage = selected.current_stage
      and not exists (
        select 1
        from public.monitoring_feedback_promotion_transitions reset_transition
        where reset_transition.cluster_id = transition.cluster_id
          and reset_transition.evidence_revision = transition.evidence_revision
          and reset_transition.transition_kind in (
            'evidence_restart',
            'operator_restart',
            'activation_rollback'
          )
          and (reset_transition.created_at, reset_transition.id) >
            (transition.created_at, transition.id)
      )
    order by transition.created_at desc, transition.id desc
    limit 1
  ) latest_attempt on true
  left join lateral (
    select
      transition.transition_kind,
      transition.created_at,
      transition.evidence
    from public.monitoring_feedback_promotion_transitions transition
    where transition.cluster_id = selected.id
      and transition.evidence_revision = selected.evidence_revision
      and transition.accepted
      and transition.transition_kind in (
        'activation_drift',
        'activation_rollback_required'
      )
    order by transition.created_at desc, transition.id desc
    limit 1
  ) latest_blocker on true
  left join lateral (
    select transition.evidence
    from public.monitoring_feedback_promotion_transitions transition
    where transition.cluster_id = selected.id
      and transition.evidence_revision = selected.evidence_revision
      and transition.transition_kind = 'stage_attempt'
      and transition.requested_stage = 'historical_shadow_test'
      and not exists (
        select 1
        from public.monitoring_feedback_promotion_transitions reset_transition
        where reset_transition.cluster_id = transition.cluster_id
          and reset_transition.evidence_revision = transition.evidence_revision
          and reset_transition.transition_kind in (
            'evidence_restart',
            'operator_restart',
            'activation_rollback'
          )
          and (reset_transition.created_at, reset_transition.id) >
            (transition.created_at, transition.id)
      )
    order by transition.created_at desc, transition.id desc
    limit 1
  ) shadow_attempt on true
  left join lateral (
    select ready_run.*
    from private.find_monitoring_feedback_resolution_worker_run(
      selected.id,
      selected.evidence_revision,
      case
        when coalesce(
          selected.stage_artifacts #>> '{retroactive_sweep,completed_at}',
          ''
        ) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?Z$'
          then (
            selected.stage_artifacts #>> '{retroactive_sweep,completed_at}'
          )::timestamptz
        else null
      end,
      selected.stage_artifacts #>> '{retroactive_sweep,activation_attestation,worker_revision}',
      selected.stage_artifacts #>> '{retroactive_sweep,activation_attestation,worker_policy_hash}',
      selected.stage_artifacts #>> '{retroactive_sweep,activation_attestation,worker_batch_policy_hash}',
      selected.stage_artifacts #>> '{retroactive_sweep,activation_attestation,worker_suppression_policy_hash}',
      selected.stage_artifacts #>> '{retroactive_sweep,activation_attestation,worker_matcher_digest}'
    ) ready_run
    where selected.current_stage = 'retroactive_sweep'
      and selected.activation_status = 'sweep_completed'
      and selected.resolved_at is null
  ) resolution_run on true
  where selected.id = p_cluster_id;
end;
$function$;

create or replace function public.list_monitoring_feedback_promotion_cluster_evidence(
  p_cluster_id uuid
)
returns table (
  cluster_id uuid,
  cluster_key text,
  evidence_signature text,
  domain_template text,
  reason_code text,
  current_stage text,
  proposed_rule_id text,
  evidence_revision bigint,
  feedback_id uuid,
  visual_occurrence_signature text,
  feedback_payload jsonb,
  event_payload jsonb,
  source_payload jsonb,
  member_created_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  if p_cluster_id is null then
    raise exception 'promotion cluster ID is required'
      using errcode = '22004';
  end if;

  perform private.sync_monitoring_feedback_promotion_clusters();

  if not exists (
    select 1
    from public.monitoring_feedback_promotion_clusters cluster
    where cluster.id = p_cluster_id
  ) then
    raise exception 'monitoring feedback promotion cluster was not found'
      using errcode = 'P0002';
  end if;

  return query
  select
    cluster.id,
    cluster.cluster_key,
    cluster.evidence_signature,
    cluster.domain_template,
    cluster.reason_code,
    cluster.current_stage,
    cluster.proposed_rule_id,
    cluster.evidence_revision,
    feedback.id,
    case
      when candidate.worker_metadata ->> 'evidence_signature' ~ '^[0-9a-f]{64}$'
        then candidate.worker_metadata ->> 'evidence_signature'
      else null
    end,
    pg_catalog.to_jsonb(feedback),
    case
      when change_event.id is not null then pg_catalog.to_jsonb(change_event)
      else pg_catalog.jsonb_build_object(
        'id', feedback.event_id,
        'shared_award_id', feedback.award_id,
        'shared_award_source_id', feedback.source_id,
        'source_url', feedback.event_source_url,
        'source_title', feedback.event_source_title,
        'source_page_type', feedback.event_source_page_type,
        'summary', feedback.event_summary,
        'change_details', feedback.event_evidence,
        'detected_at', feedback.event_detected_at,
        'retained_feedback_snapshot', true
      )
    end,
    case
      when source.id is not null then pg_catalog.to_jsonb(source)
      else null::jsonb
    end,
    member.created_at
  from public.monitoring_feedback_promotion_clusters cluster
  join public.monitoring_feedback_promotion_cluster_members member
    on member.cluster_id = cluster.id
  join public.monitoring_feedback feedback
    on feedback.id = member.feedback_id
  left join public.shared_award_change_events change_event
    on change_event.id = feedback.event_id
  left join public.shared_award_visual_review_candidates candidate
    on candidate.id = change_event.visual_review_candidate_id
  left join public.shared_award_sources source
    on source.id = coalesce(change_event.shared_award_source_id, feedback.source_id)
  where cluster.id = p_cluster_id
  order by feedback.created_at, feedback.id;
end;
$function$;

create or replace function public.record_monitoring_feedback_promotion_worker_failure(
  p_request_id uuid,
  p_cluster_id uuid,
  p_expected_evidence_revision bigint,
  p_expected_current_stage text,
  p_failure_stage text,
  p_actor_user_id uuid,
  p_actor_email text,
  p_failure_reason text,
  p_evidence jsonb,
  p_safe_action text,
  p_note text default null
)
returns table (
  failure_transition_id uuid,
  recorded_cluster_id uuid,
  current_stage text,
  current_activation_status text,
  failed_stage text,
  recorded boolean,
  current_evidence_revision bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_cluster public.monitoring_feedback_promotion_clusters%rowtype;
  v_existing public.monitoring_feedback_promotion_transitions%rowtype;
  v_transition_id uuid := gen_random_uuid();
  v_expected_current_stage text := pg_catalog.lower(
    pg_catalog.btrim(coalesce(p_expected_current_stage, ''))
  );
  v_failure_stage text := pg_catalog.lower(
    pg_catalog.btrim(coalesce(p_failure_stage, ''))
  );
  v_expected_failure_stage text;
  v_actor_email text := pg_catalog.lower(
    pg_catalog.btrim(coalesce(p_actor_email, ''))
  );
  v_failure_reason text := nullif(
    pg_catalog.btrim(coalesce(p_failure_reason, '')),
    ''
  );
  v_safe_action text := nullif(
    pg_catalog.btrim(coalesce(p_safe_action, '')),
    ''
  );
  v_note text := nullif(pg_catalog.btrim(coalesce(p_note, '')), '');
  v_evidence jsonb := coalesce(p_evidence, '{}'::jsonb);
  v_recurrence_count bigint;
begin
  if p_request_id is null
    or p_cluster_id is null
    or p_expected_evidence_revision is null
    or p_actor_user_id is null then
    raise exception 'request, cluster, evidence revision, and actor IDs are required'
      using errcode = '22004';
  end if;
  if p_expected_evidence_revision < 1 then
    raise exception 'a positive expected evidence revision is required'
      using errcode = '22023';
  end if;
  if private.monitoring_feedback_promotion_stage_ordinal(
      v_expected_current_stage
    ) is null
    or private.monitoring_feedback_promotion_stage_ordinal(v_failure_stage) is null then
    raise exception 'valid current and failed promotion stages are required'
      using errcode = '22023';
  end if;
  if pg_catalog.char_length(v_actor_email) < 3
    or pg_catalog.char_length(v_actor_email) > 320 then
    raise exception 'a valid actor email is required'
      using errcode = '22023';
  end if;
  if pg_catalog.char_length(coalesce(v_failure_reason, '')) < 3
    or pg_catalog.char_length(v_failure_reason) > 2000 then
    raise exception 'a bounded concrete worker failure reason is required'
      using errcode = '22023';
  end if;
  if pg_catalog.char_length(coalesce(v_safe_action, '')) < 3
    or pg_catalog.char_length(v_safe_action) > 2000 then
    raise exception 'a bounded worker failure safe action is required'
      using errcode = '22023';
  end if;
  if pg_catalog.char_length(coalesce(v_note, '')) > 1000 then
    raise exception 'worker failure note is too long'
      using errcode = '22023';
  end if;
  if pg_catalog.jsonb_typeof(v_evidence) is distinct from 'object'
    or v_evidence ->> 'schema_version' is distinct from
      'monitoring-promotion-worker-failure-v1'
    or v_evidence ->> 'status' is distinct from 'failed'
    or v_evidence ->> 'current_stage' is distinct from v_expected_current_stage
    or v_evidence ->> 'failure_stage' is distinct from v_failure_stage
    or private.monitoring_feedback_json_nonnegative_bigint(
      v_evidence,
      'evidence_revision'
    ) is distinct from p_expected_evidence_revision
    or v_evidence ->> 'safe_action' is distinct from v_safe_action
    or coalesce(v_evidence ->> 'digest', '') !~ '^[0-9a-f]{64}$'
    or public.awardping_sha256_text(
      private.monitoring_feedback_canonical_json(v_evidence - 'digest')
    ) is distinct from v_evidence ->> 'digest'
    or pg_catalog.jsonb_typeof(v_evidence -> 'errors') is distinct from 'array'
    or pg_catalog.jsonb_array_length(v_evidence -> 'errors') < 1 then
    raise exception 'worker failure evidence is incomplete or targets another state'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_request_id::text, 0)
  );

  select transition.*
  into v_existing
  from public.monitoring_feedback_promotion_transitions transition
  where transition.request_id = p_request_id;

  if found then
    if v_existing.transition_kind is distinct from 'stage_attempt'
      or v_existing.accepted
      or v_existing.cluster_id is distinct from p_cluster_id
      or v_existing.from_stage is distinct from v_expected_current_stage
      or v_existing.requested_stage is distinct from v_failure_stage
      or v_existing.resulting_stage is distinct from v_expected_current_stage
      or v_existing.evidence_revision is distinct from p_expected_evidence_revision
      or v_existing.actor_user_id is distinct from p_actor_user_id
      or v_existing.actor_email is distinct from v_actor_email
      or v_existing.failure_reason is distinct from v_failure_reason
      or v_existing.evidence is distinct from v_evidence
      or v_existing.note is distinct from v_note then
      raise exception 'request ID was already used for a different worker failure'
        using errcode = '22023';
    end if;

    return query select
      v_existing.id,
      v_existing.cluster_id,
      v_existing.resulting_stage,
      coalesce(
        (
          select cluster.activation_status
          from public.monitoring_feedback_promotion_clusters cluster
          where cluster.id = v_existing.cluster_id
        ),
        'inactive'
      ),
      v_existing.requested_stage,
      false,
      v_existing.evidence_revision;
    return;
  end if;

  perform private.sync_monitoring_feedback_promotion_clusters();

  select cluster.*
  into v_cluster
  from public.monitoring_feedback_promotion_clusters cluster
  where cluster.id = p_cluster_id
  for update;

  if not found then
    raise exception 'monitoring feedback promotion cluster was not found'
      using errcode = 'P0002';
  end if;
  if p_expected_evidence_revision is distinct from v_cluster.evidence_revision then
    raise exception 'promotion evidence revision is stale; expected %, current %',
      p_expected_evidence_revision,
      v_cluster.evidence_revision
      using errcode = '40001';
  end if;
  if v_cluster.current_stage is distinct from v_expected_current_stage
    or v_cluster.resolved_at is not null then
    raise exception 'worker failure state is stale or already resolved'
      using errcode = '40001';
  end if;

  v_expected_failure_stage := case
    when v_cluster.current_stage = 'retroactive_sweep'
      or v_cluster.activation_status in (
        'blocked_late_evidence',
        'rollback_required',
        'sweep_completed'
      ) then 'retroactive_sweep'
    else private.monitoring_feedback_promotion_next_stage(
      v_cluster.current_stage
    )
  end;
  if v_expected_failure_stage is null then
    v_expected_failure_stage := v_cluster.current_stage;
  end if;
  if v_failure_stage is distinct from v_expected_failure_stage then
    raise exception 'worker failure must be recorded at stage %, not %',
      v_expected_failure_stage,
      v_failure_stage
      using errcode = '22023';
  end if;

  select pg_catalog.count(*)::bigint
  into v_recurrence_count
  from public.monitoring_feedback_promotion_cluster_members member
  where member.cluster_id = v_cluster.id;
  if v_recurrence_count < 1 then
    raise exception 'promotion cluster has no feedback evidence'
      using errcode = 'P0001';
  end if;

  insert into public.monitoring_feedback_promotion_transitions (
    id,
    request_id,
    cluster_id,
    from_stage,
    requested_stage,
    resulting_stage,
    accepted,
    transition_kind,
    evidence_revision,
    failure_reason,
    actor_user_id,
    actor_email,
    policy_rule_id,
    evidence,
    note,
    recurrence_count,
    created_at
  ) values (
    v_transition_id,
    p_request_id,
    v_cluster.id,
    v_cluster.current_stage,
    v_failure_stage,
    v_cluster.current_stage,
    false,
    'stage_attempt',
    v_cluster.evidence_revision,
    v_failure_reason,
    p_actor_user_id,
    v_actor_email,
    v_cluster.proposed_rule_id,
    v_evidence,
    v_note,
    v_recurrence_count,
    pg_catalog.clock_timestamp()
  );

  return query select
    v_transition_id,
    v_cluster.id,
    v_cluster.current_stage,
    v_cluster.activation_status,
    v_failure_stage,
    true,
    v_cluster.evidence_revision;
end;
$function$;

create or replace function public.apply_monitoring_feedback_promotion_sweep_event(
  p_cluster_id uuid,
  p_expected_evidence_revision bigint,
  p_policy_rule_id text,
  p_event_id uuid,
  p_suppressed_at timestamptz,
  p_suppression_reason text
)
returns table (
  sweep_event_id uuid,
  applied boolean,
  already_applied boolean,
  mutation_at timestamptz,
  current_evidence_revision bigint,
  current_activation_status text
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_cluster public.monitoring_feedback_promotion_clusters%rowtype;
  v_event public.shared_award_change_events%rowtype;
  v_rule_id text := nullif(pg_catalog.btrim(coalesce(p_policy_rule_id, '')), '');
  v_reason text := nullif(pg_catalog.btrim(coalesce(p_suppression_reason, '')), '');
  v_source text;
  v_mutation_at timestamptz;
begin
  if p_cluster_id is null
    or p_expected_evidence_revision is null
    or p_event_id is null then
    raise exception 'cluster, evidence revision, and event IDs are required'
      using errcode = '22004';
  end if;
  if p_expected_evidence_revision < 1 then
    raise exception 'a positive expected evidence revision is required'
      using errcode = '22023';
  end if;
  if v_rule_id is null or pg_catalog.char_length(v_rule_id) > 160 then
    raise exception 'the immutable promoted rule ID is required'
      using errcode = '22023';
  end if;
  if v_reason is null or pg_catalog.char_length(v_reason) > 1000 then
    raise exception 'a bounded sweep suppression reason is required'
      using errcode = '22023';
  end if;
  if p_suppressed_at is not null then
    raise exception 'guarded promotion suppression timestamps are assigned by the database'
      using errcode = '22023';
  end if;

  perform private.sync_monitoring_feedback_promotion_clusters();

  select cluster.*
  into v_cluster
  from public.monitoring_feedback_promotion_clusters cluster
  where cluster.id = p_cluster_id
  for update;

  if not found then
    raise exception 'monitoring feedback promotion cluster was not found'
      using errcode = 'P0002';
  end if;
  if p_expected_evidence_revision is distinct from v_cluster.evidence_revision then
    raise exception 'promotion evidence revision is stale; expected %, current %',
      p_expected_evidence_revision,
      v_cluster.evidence_revision
      using errcode = '40001';
  end if;
  if v_cluster.current_stage is distinct from 'six_pm_canary'
    or v_cluster.activation_status is distinct from 'armed'
    or v_cluster.activation_blocked_at is not null
    or v_cluster.proposed_rule_id is distinct from v_rule_id
    or v_cluster.stage_artifacts #>> '{six_pm_canary,status}' is distinct from 'passed' then
    raise exception 'the promotion sweep is not armed or late evidence blocked mutation'
      using errcode = '55000';
  end if;

  v_source := 'verified-promotion:' || v_cluster.id::text;

  select change_event.*
  into v_event
  from public.shared_award_change_events change_event
  where change_event.id = p_event_id
  for update;

  if not found then
    raise exception 'sweep event was not found'
      using errcode = 'P0002';
  end if;
  if v_event.suppressed_at is null
    and (
      nullif(
        pg_catalog.btrim(
          coalesce(v_event.change_details ->> 'suppressed_at', '')
        ),
        ''
      ) is not null
      or nullif(
        pg_catalog.btrim(
          coalesce(v_event.change_details ->> 'suppression_reason', '')
        ),
        ''
      ) is not null
    ) then
    raise exception 'sweep event is already logically suppressed by retained legacy evidence'
      using errcode = '55000';
  end if;
  if v_event.suppressed_at is not null then
    if v_event.suppression_source is distinct from v_source then
      raise exception 'sweep event was already suppressed by another decision'
        using errcode = '55000';
    end if;

    return query select
      v_event.id,
      false,
      true,
      v_event.suppressed_at,
      v_cluster.evidence_revision,
      v_cluster.activation_status;
    return;
  end if;

  update public.shared_award_change_events change_event
  set
    suppressed_at = pg_catalog.clock_timestamp(),
    suppression_reason = v_reason,
    suppression_source = v_source
  where change_event.id = v_event.id
    and change_event.suppressed_at is null
  returning change_event.suppressed_at into v_mutation_at;

  if not found then
    raise exception 'sweep event changed during guarded suppression'
      using errcode = '40001';
  end if;

  return query select
    v_event.id,
    true,
    false,
    v_mutation_at,
    v_cluster.evidence_revision,
    v_cluster.activation_status;
end;
$function$;

create or replace function public.checkpoint_monitoring_feedback_promotion_sweep(
  p_cluster_id uuid,
  p_expected_evidence_revision bigint,
  p_policy_rule_id text,
  p_sweep_key text,
  p_state_policy_hash text,
  p_cursor_detected_at timestamptz,
  p_cursor_event_id uuid,
  p_scanned_count bigint,
  p_not_before timestamptz,
  p_cycle_started_at timestamptz default null
)
returns table (
  checkpoint_sweep_key text,
  checkpoint_at timestamptz,
  checkpoint_cursor_detected_at timestamptz,
  checkpoint_cursor_event_id uuid,
  checkpoint_scanned_count bigint,
  checkpoint_cycle_started_at timestamptz,
  checkpoint_previous_at timestamptz,
  checkpoint_last_mutation_at timestamptz,
  current_evidence_revision bigint,
  current_activation_status text
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_cluster public.monitoring_feedback_promotion_clusters%rowtype;
  v_rule_id text := nullif(pg_catalog.btrim(coalesce(p_policy_rule_id, '')), '');
  v_sweep_key text := nullif(pg_catalog.btrim(coalesce(p_sweep_key, '')), '');
  v_state_policy_hash text :=
    pg_catalog.lower(nullif(pg_catalog.btrim(coalesce(p_state_policy_hash, '')), ''));
  v_checkpoint_at timestamptz;
  v_cycle_started_at timestamptz;
  v_previous_checkpoint_at timestamptz;
  v_last_mutation_at timestamptz;
begin
  if p_cluster_id is null
    or p_expected_evidence_revision is null
    or p_scanned_count is null then
    raise exception 'cluster, evidence revision, and scanned count are required'
      using errcode = '22004';
  end if;
  if p_expected_evidence_revision < 1 or p_scanned_count < 0 then
    raise exception 'positive evidence revision and nonnegative scanned count are required'
      using errcode = '22023';
  end if;
  if v_rule_id is null or pg_catalog.char_length(v_rule_id) > 160 then
    raise exception 'the immutable promoted rule ID is required'
      using errcode = '22023';
  end if;
  if v_sweep_key is null
    or pg_catalog.char_length(v_sweep_key) > 500
    or v_sweep_key not like
      'monitoring-feedback-promotion:' || p_cluster_id::text || ':%' then
    raise exception 'the cluster-bound promotion sweep key is invalid'
      using errcode = '22023';
  end if;
  if v_state_policy_hash is null
    or v_state_policy_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'the promotion sweep state policy hash is invalid'
      using errcode = '22023';
  end if;
  if (p_cursor_detected_at is null) is distinct from
    (p_cursor_event_id is null) then
    raise exception 'the promotion sweep cursor timestamp and event ID must be paired'
      using errcode = '22023';
  end if;

  perform private.sync_monitoring_feedback_promotion_clusters();

  select cluster.*
  into v_cluster
  from public.monitoring_feedback_promotion_clusters cluster
  where cluster.id = p_cluster_id
  for update;

  if not found then
    raise exception 'monitoring feedback promotion cluster was not found'
      using errcode = 'P0002';
  end if;
  if p_expected_evidence_revision is distinct from v_cluster.evidence_revision then
    raise exception 'promotion evidence revision is stale; expected %, current %',
      p_expected_evidence_revision,
      v_cluster.evidence_revision
      using errcode = '40001';
  end if;
  if v_cluster.current_stage is distinct from 'six_pm_canary'
    or v_cluster.activation_status is distinct from 'armed'
    or v_cluster.activation_blocked_at is not null
    or v_cluster.proposed_rule_id is distinct from v_rule_id
    or v_cluster.stage_artifacts #>> '{six_pm_canary,status}' is distinct from 'passed' then
    raise exception 'the promotion sweep is not armed or late evidence blocked checkpointing'
      using errcode = '55000';
  end if;

  select sweep_state.updated_at
  into v_previous_checkpoint_at
  from public.monitoring_policy_sweep_state sweep_state
  where sweep_state.sweep_key = v_sweep_key;

  select pg_catalog.max(change_event.suppressed_at)
  into v_last_mutation_at
  from public.shared_award_change_events change_event
  where change_event.suppression_source =
    'verified-promotion:' || v_cluster.id::text;

  v_checkpoint_at := pg_catalog.greatest(
    pg_catalog.clock_timestamp(),
    p_not_before + interval '1 microsecond',
    v_previous_checkpoint_at + interval '1 microsecond',
    v_last_mutation_at + interval '1 microsecond'
  );
  v_cycle_started_at := coalesce(p_cycle_started_at, v_checkpoint_at);

  insert into public.monitoring_policy_sweep_state as sweep_state (
    sweep_key,
    policy_hash,
    cursor_detected_at,
    cursor_event_id,
    scanned_count,
    cycle_started_at,
    created_at,
    updated_at
  ) values (
    v_sweep_key,
    v_state_policy_hash,
    p_cursor_detected_at,
    p_cursor_event_id,
    p_scanned_count,
    v_cycle_started_at,
    v_checkpoint_at,
    v_checkpoint_at
  )
  on conflict (sweep_key) do update
  set
    policy_hash = excluded.policy_hash,
    cursor_detected_at = excluded.cursor_detected_at,
    cursor_event_id = excluded.cursor_event_id,
    scanned_count = excluded.scanned_count,
    cycle_started_at = case
      when sweep_state.policy_hash is distinct from excluded.policy_hash
        then excluded.cycle_started_at
      else sweep_state.cycle_started_at
    end,
    updated_at = excluded.updated_at
  returning
    sweep_state.updated_at,
    sweep_state.cycle_started_at
  into v_checkpoint_at, v_cycle_started_at;

  return query select
    v_sweep_key,
    v_checkpoint_at,
    p_cursor_detected_at,
    p_cursor_event_id,
    p_scanned_count,
    v_cycle_started_at,
    v_previous_checkpoint_at,
    v_last_mutation_at,
    v_cluster.evidence_revision,
    v_cluster.activation_status;
end;
$function$;

create or replace function public.mark_monitoring_feedback_promotion_rollback_required(
  p_request_id uuid,
  p_cluster_id uuid,
  p_expected_evidence_revision bigint,
  p_actor_user_id uuid,
  p_actor_email text,
  p_reason text,
  p_evidence jsonb,
  p_note text default null
)
returns table (
  marker_transition_id uuid,
  marked_cluster_id uuid,
  current_stage text,
  current_activation_status text,
  marked boolean,
  current_evidence_revision bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_cluster public.monitoring_feedback_promotion_clusters%rowtype;
  v_existing public.monitoring_feedback_promotion_transitions%rowtype;
  v_transition_id uuid := gen_random_uuid();
  v_actor_email text := pg_catalog.lower(
    pg_catalog.btrim(coalesce(p_actor_email, ''))
  );
  v_reason text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_reason, '')));
  v_note text := nullif(pg_catalog.btrim(coalesce(p_note, '')), '');
  v_evidence jsonb := coalesce(p_evidence, '{}'::jsonb);
  v_recurrence_count bigint;
begin
  if p_request_id is null
    or p_cluster_id is null
    or p_expected_evidence_revision is null
    or p_actor_user_id is null then
    raise exception 'request, cluster, evidence revision, and actor IDs are required'
      using errcode = '22004';
  end if;
  if p_expected_evidence_revision < 1 then
    raise exception 'a positive expected evidence revision is required'
      using errcode = '22023';
  end if;
  if pg_catalog.char_length(v_actor_email) < 3
    or pg_catalog.char_length(v_actor_email) > 320 then
    raise exception 'a valid actor email is required'
      using errcode = '22023';
  end if;
  if v_reason not in (
    'activation_attestation_failed',
    'retroactive_sweep_failed',
    'operator_deactivated'
  ) then
    raise exception 'a supported activation rollback reason is required'
      using errcode = '22023';
  end if;
  if pg_catalog.jsonb_typeof(v_evidence) is distinct from 'object'
    or v_evidence = '{}'::jsonb then
    raise exception 'nonempty structured rollback-required evidence is required'
      using errcode = '22023';
  end if;
  if pg_catalog.char_length(coalesce(v_note, '')) > 1000 then
    raise exception 'rollback-required note is too long'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_request_id::text, 0)
  );

  select transition.*
  into v_existing
  from public.monitoring_feedback_promotion_transitions transition
  where transition.request_id = p_request_id;

  if found then
    if v_existing.transition_kind is distinct from 'activation_rollback_required'
      or not v_existing.accepted
      or v_existing.cluster_id is distinct from p_cluster_id
      or v_existing.evidence_revision is distinct from p_expected_evidence_revision
      or v_existing.actor_user_id is distinct from p_actor_user_id
      or v_existing.actor_email is distinct from v_actor_email
      or v_existing.evidence is distinct from (
        v_evidence || pg_catalog.jsonb_build_object('rollback_reason', v_reason)
      )
      or v_existing.note is distinct from v_note then
      raise exception 'request ID was already used for a different rollback-required marker'
        using errcode = '22023';
    end if;

    return query select
      v_existing.id,
      v_existing.cluster_id,
      v_existing.resulting_stage,
      'rollback_required'::text,
      false,
      v_existing.evidence_revision;
    return;
  end if;

  perform private.sync_monitoring_feedback_promotion_clusters();

  select cluster.*
  into v_cluster
  from public.monitoring_feedback_promotion_clusters cluster
  where cluster.id = p_cluster_id
  for update;

  if not found then
    raise exception 'monitoring feedback promotion cluster was not found'
      using errcode = 'P0002';
  end if;
  if p_expected_evidence_revision is distinct from v_cluster.evidence_revision then
    raise exception 'promotion evidence revision is stale; expected %, current %',
      p_expected_evidence_revision,
      v_cluster.evidence_revision
      using errcode = '40001';
  end if;
  if v_cluster.current_stage not in ('six_pm_canary', 'retroactive_sweep')
    or v_cluster.activation_status not in ('armed', 'sweep_completed')
    or v_cluster.proposed_rule_id is null
    or v_cluster.resolved_at is not null then
    raise exception 'only an active unresolved candidate can require rollback'
      using errcode = '22023';
  end if;

  select pg_catalog.count(*)::bigint
  into v_recurrence_count
  from public.monitoring_feedback_promotion_cluster_members member
  where member.cluster_id = v_cluster.id;

  insert into public.monitoring_feedback_promotion_transitions (
    id,
    request_id,
    cluster_id,
    from_stage,
    requested_stage,
    resulting_stage,
    accepted,
    transition_kind,
    evidence_revision,
    recurrence_count,
    actor_user_id,
    actor_email,
    policy_rule_id,
    evidence,
    note,
    created_at
  ) values (
    v_transition_id,
    p_request_id,
    v_cluster.id,
    v_cluster.current_stage,
    v_cluster.current_stage,
    v_cluster.current_stage,
    true,
    'activation_rollback_required',
    v_cluster.evidence_revision,
    v_recurrence_count,
    p_actor_user_id,
    v_actor_email,
    v_cluster.proposed_rule_id,
    v_evidence || pg_catalog.jsonb_build_object('rollback_reason', v_reason),
    v_note,
    pg_catalog.clock_timestamp()
  );

  update public.monitoring_feedback_promotion_clusters cluster
  set
    activation_status = 'rollback_required',
    activation_blocked_at = pg_catalog.clock_timestamp(),
    updated_at = pg_catalog.clock_timestamp()
  where cluster.id = v_cluster.id;

  return query select
    v_transition_id,
    v_cluster.id,
    v_cluster.current_stage,
    'rollback_required'::text,
    true,
    v_cluster.evidence_revision;
end;
$function$;

create or replace function public.revert_monitoring_feedback_promotion_sweep_events(
  p_request_id uuid,
  p_cluster_id uuid,
  p_expected_evidence_revision bigint,
  p_event_actions jsonb
)
returns table (
  processed_count bigint,
  unsuppressed_count bigint,
  retained_feedback_count bigint,
  retained_other_policy_count bigint,
  remaining_attributable_count bigint,
  current_activation_status text
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_cluster public.monitoring_feedback_promotion_clusters%rowtype;
  v_activation_cycle_id uuid;
  v_request_payload_digest text;
  v_event public.shared_award_change_events%rowtype;
  v_feedback public.monitoring_feedback%rowtype;
  v_existing_audit public.monitoring_feedback_promotion_sweep_reversal_audit%rowtype;
  v_action record;
  v_action_count bigint;
  v_invalid_count bigint;
  v_distinct_event_count bigint;
  v_existing_request_count bigint;
  v_processed_count bigint;
  v_unsuppressed_count bigint;
  v_retained_feedback_count bigint;
  v_retained_other_policy_count bigint;
  v_remaining_count bigint;
  v_target_source text;
  v_target_reason text;
  v_decision text;
  v_replacement_source text;
  v_replacement_reason text;
  v_reversal_action text;
  v_resulting_suppressed_at timestamptz;
  v_resulting_reason text;
  v_resulting_source text;
begin
  if p_request_id is null
    or p_cluster_id is null
    or p_expected_evidence_revision is null then
    raise exception 'request, cluster, and evidence revision are required'
      using errcode = '22004';
  end if;
  if p_expected_evidence_revision < 1 then
    raise exception 'a positive expected evidence revision is required'
      using errcode = '22023';
  end if;
  if pg_catalog.jsonb_typeof(p_event_actions) is distinct from 'array' then
    raise exception 'event reversal actions must be a JSON array'
      using errcode = '22023';
  end if;

  v_action_count := pg_catalog.jsonb_array_length(p_event_actions)::bigint;
  if v_action_count < 1 or v_action_count > 500 then
    raise exception 'each reversal batch must contain between 1 and 500 events'
      using errcode = '22023';
  end if;

  v_request_payload_digest := public.awardping_sha256_text(
    private.monitoring_feedback_canonical_json(p_event_actions)
  );

  select
    pg_catalog.count(*) filter (
      where pg_catalog.jsonb_typeof(action.value) is distinct from 'object'
        or coalesce(action.value ->> 'event_id', '') !~
          '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        or action.value ->> 'decision' not in ('unsuppress', 'retain_other_policy')
        or (
          action.value ->> 'decision' = 'retain_other_policy'
          and (
            nullif(pg_catalog.btrim(coalesce(action.value ->> 'replacement_source', '')), '') is null
            or nullif(pg_catalog.btrim(coalesce(action.value ->> 'replacement_reason', '')), '') is null
            or pg_catalog.char_length(action.value ->> 'replacement_source') > 160
            or pg_catalog.char_length(action.value ->> 'replacement_reason') > 1000
          )
        )
    )::bigint,
    pg_catalog.count(distinct action.value ->> 'event_id')::bigint
  into v_invalid_count, v_distinct_event_count
  from pg_catalog.jsonb_array_elements(p_event_actions) action(value);

  if v_invalid_count <> 0 or v_distinct_event_count is distinct from v_action_count then
    raise exception 'reversal actions require unique lowercase UUID event IDs and valid decisions'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_request_id::text, 0)
  );
  perform private.sync_monitoring_feedback_promotion_clusters();

  select cluster.*
  into v_cluster
  from public.monitoring_feedback_promotion_clusters cluster
  where cluster.id = p_cluster_id
  for update;

  if not found then
    raise exception 'monitoring feedback promotion cluster was not found'
      using errcode = 'P0002';
  end if;
  if p_expected_evidence_revision is distinct from v_cluster.evidence_revision then
    raise exception 'promotion evidence revision is stale; expected %, current %',
      p_expected_evidence_revision,
      v_cluster.evidence_revision
      using errcode = '40001';
  end if;
  if v_cluster.current_stage not in ('six_pm_canary', 'retroactive_sweep')
    or v_cluster.activation_status not in ('blocked_late_evidence', 'rollback_required')
    or v_cluster.activation_blocked_at is null
    or v_cluster.proposed_rule_id is null then
    raise exception 'sweep reversal requires a blocked post-canary activation'
      using errcode = '55000';
  end if;

  v_target_source := 'verified-promotion:' || v_cluster.id::text;
  v_target_reason := 'policy_flag_' || v_cluster.proposed_rule_id;

  select transition.id
  into v_activation_cycle_id
  from public.monitoring_feedback_promotion_transitions transition
  where transition.cluster_id = v_cluster.id
    and transition.evidence_revision = v_cluster.evidence_revision
    and transition.accepted
    and transition.transition_kind in (
      'activation_drift',
      'activation_rollback_required'
    )
  order by transition.created_at desc, transition.id desc
  limit 1;

  if not found then
    raise exception 'blocked activation is missing its immutable cycle marker'
      using errcode = '55000';
  end if;

  select pg_catalog.count(*)::bigint
  into v_existing_request_count
  from public.monitoring_feedback_promotion_sweep_reversal_audit audit
  where audit.request_id = p_request_id;

  if v_existing_request_count > 0 then
    if v_existing_request_count is distinct from v_action_count
      or exists (
        select 1
        from public.monitoring_feedback_promotion_sweep_reversal_audit audit
        where audit.request_id = p_request_id
          and (
            audit.cluster_id is distinct from v_cluster.id
            or audit.evidence_revision is distinct from v_cluster.evidence_revision
            or audit.activation_cycle_id is distinct from v_activation_cycle_id
            or audit.request_payload_digest is distinct from v_request_payload_digest
          )
      )
      or exists (
        select 1
        from pg_catalog.jsonb_array_elements(p_event_actions) action(value)
        where not exists (
          select 1
          from public.monitoring_feedback_promotion_sweep_reversal_audit audit
          where audit.request_id = p_request_id
            and audit.event_id::text = action.value ->> 'event_id'
        )
      ) then
      raise exception 'request ID was already used for a different reversal batch'
        using errcode = '22023';
    end if;
  else
    for v_action in
      select action.value
      from pg_catalog.jsonb_array_elements(p_event_actions) action(value)
      order by action.value ->> 'event_id'
    loop
      select audit.*
      into v_existing_audit
      from public.monitoring_feedback_promotion_sweep_reversal_audit audit
      where audit.cluster_id = v_cluster.id
        and audit.activation_cycle_id = v_activation_cycle_id
        and audit.event_id::text = v_action.value ->> 'event_id';

      if found then
        raise exception 'event % was already reversed by another request in this activation cycle',
          v_action.value ->> 'event_id'
          using errcode = '22023';
      end if;

      select change_event.*
      into v_event
      from public.shared_award_change_events change_event
      where change_event.id::text = v_action.value ->> 'event_id'
      for update;

      if not found then
        raise exception 'reversal event % was not found', v_action.value ->> 'event_id'
          using errcode = 'P0002';
      end if;
      if v_event.suppressed_at is null
        or not (
          v_event.suppression_source = v_target_source
          or (
            v_event.suppression_source = 'scheduled-downstream-policy-sweep'
            and v_event.suppression_reason = v_target_reason
          )
        ) then
        raise exception 'event % is not suppressed by this candidate', v_event.id
          using errcode = '22023';
      end if;

      select feedback.*
      into v_feedback
      from public.monitoring_feedback feedback
      where feedback.event_id = v_event.id
      order by feedback.created_at desc, feedback.id desc
      limit 1;

      v_decision := v_action.value ->> 'decision';
      v_replacement_source := nullif(
        pg_catalog.btrim(coalesce(v_action.value ->> 'replacement_source', '')),
        ''
      );
      v_replacement_reason := nullif(
        pg_catalog.btrim(coalesce(v_action.value ->> 'replacement_reason', '')),
        ''
      );

      if found then
        v_reversal_action := 'retained_feedback';
        v_resulting_suppressed_at := v_event.suppressed_at;
        v_resulting_reason := 'admin_feedback:' || v_feedback.reason_code;
        v_resulting_source := 'admin_feedback';
      elsif v_decision = 'retain_other_policy' then
        if v_replacement_source is distinct from 'scheduled-downstream-policy-sweep'
          or v_replacement_reason = v_target_reason then
          raise exception 'retained events require an independent downstream-policy attribution'
            using errcode = '22023';
        end if;
        v_reversal_action := 'retained_other_policy';
        v_resulting_suppressed_at := v_event.suppressed_at;
        v_resulting_reason := v_replacement_reason;
        v_resulting_source := v_replacement_source;
      else
        v_reversal_action := 'unsuppressed';
        v_resulting_suppressed_at := null;
        v_resulting_reason := null;
        v_resulting_source := null;
      end if;

      update public.shared_award_change_events change_event
      set
        suppressed_at = v_resulting_suppressed_at,
        suppression_reason = v_resulting_reason,
        suppression_source = v_resulting_source
      where change_event.id = v_event.id
        and change_event.suppressed_at is not distinct from v_event.suppressed_at
        and change_event.suppression_reason is not distinct from v_event.suppression_reason
        and change_event.suppression_source is not distinct from v_event.suppression_source;

      if not found then
        raise exception 'reversal event changed during guarded cleanup'
          using errcode = '40001';
      end if;

      insert into public.monitoring_feedback_promotion_sweep_reversal_audit (
        request_id,
        request_payload_digest,
        cluster_id,
        activation_cycle_id,
        evidence_revision,
        event_id,
        reversal_action,
        previous_suppressed_at,
        previous_suppression_reason,
        previous_suppression_source,
        resulting_suppressed_at,
        resulting_suppression_reason,
        resulting_suppression_source
      ) values (
        p_request_id,
        v_request_payload_digest,
        v_cluster.id,
        v_activation_cycle_id,
        v_cluster.evidence_revision,
        v_event.id,
        v_reversal_action,
        v_event.suppressed_at,
        v_event.suppression_reason,
        v_event.suppression_source,
        v_resulting_suppressed_at,
        v_resulting_reason,
        v_resulting_source
      );
    end loop;
  end if;

  select
    pg_catalog.count(*)::bigint,
    pg_catalog.count(*) filter (
      where audit.reversal_action = 'unsuppressed'
    )::bigint,
    pg_catalog.count(*) filter (
      where audit.reversal_action = 'retained_feedback'
    )::bigint,
    pg_catalog.count(*) filter (
      where audit.reversal_action = 'retained_other_policy'
    )::bigint
  into
    v_processed_count,
    v_unsuppressed_count,
    v_retained_feedback_count,
    v_retained_other_policy_count
  from public.monitoring_feedback_promotion_sweep_reversal_audit audit
  where audit.request_id = p_request_id
    and audit.cluster_id = v_cluster.id
    and audit.activation_cycle_id = v_activation_cycle_id;

  select pg_catalog.count(*)::bigint
  into v_remaining_count
  from public.shared_award_change_events change_event
  where change_event.suppressed_at is not null
    and (
      change_event.suppression_source = v_target_source
      or (
        change_event.suppression_source = 'scheduled-downstream-policy-sweep'
        and change_event.suppression_reason = v_target_reason
      )
    );

  return query select
    v_processed_count,
    v_unsuppressed_count,
    v_retained_feedback_count,
    v_retained_other_policy_count,
    v_remaining_count,
    v_cluster.activation_status;
end;
$function$;

create or replace function public.rollback_monitoring_feedback_promotion_activation(
  p_request_id uuid,
  p_cluster_id uuid,
  p_expected_evidence_revision bigint,
  p_actor_user_id uuid,
  p_actor_email text,
  p_evidence jsonb,
  p_note text default null
)
returns table (
  rollback_transition_id uuid,
  rolled_back_cluster_id uuid,
  previous_stage text,
  current_stage text,
  rolled_back boolean,
  rollback_evidence_revision bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_cluster public.monitoring_feedback_promotion_clusters%rowtype;
  v_existing public.monitoring_feedback_promotion_transitions%rowtype;
  v_transition_id uuid := gen_random_uuid();
  v_actor_email text := pg_catalog.lower(
    pg_catalog.btrim(coalesce(p_actor_email, ''))
  );
  v_note text := nullif(pg_catalog.btrim(coalesce(p_note, '')), '');
  v_evidence jsonb := coalesce(p_evidence, '{}'::jsonb);
  v_hashes jsonb;
  v_recurrence_count bigint;
  v_attributable_suppression_count bigint;
begin
  if p_request_id is null
    or p_cluster_id is null
    or p_expected_evidence_revision is null
    or p_actor_user_id is null then
    raise exception 'request, cluster, evidence revision, and actor IDs are required'
      using errcode = '22004';
  end if;
  if p_expected_evidence_revision < 1 then
    raise exception 'a positive expected evidence revision is required'
      using errcode = '22023';
  end if;
  if pg_catalog.char_length(v_actor_email) < 3
    or pg_catalog.char_length(v_actor_email) > 320 then
    raise exception 'a valid actor email is required'
      using errcode = '22023';
  end if;
  if pg_catalog.jsonb_typeof(v_evidence) is distinct from 'object' then
    raise exception 'rollback evidence must be a JSON object'
      using errcode = '22023';
  end if;
  if pg_catalog.char_length(coalesce(v_note, '')) > 1000 then
    raise exception 'activation rollback note is too long'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_request_id::text, 0)
  );

  select transition.*
  into v_existing
  from public.monitoring_feedback_promotion_transitions transition
  where transition.request_id = p_request_id;

  if found then
    if v_existing.transition_kind is distinct from 'activation_rollback'
      or not v_existing.accepted
      or v_existing.cluster_id is distinct from p_cluster_id
      or v_existing.evidence_revision is distinct from p_expected_evidence_revision
      or v_existing.actor_user_id is distinct from p_actor_user_id
      or v_existing.actor_email is distinct from v_actor_email
      or v_existing.evidence is distinct from v_evidence
      or v_existing.note is distinct from v_note then
      raise exception 'request ID was already used for a different activation rollback'
        using errcode = '22023';
    end if;

    return query select
      v_existing.id,
      v_existing.cluster_id,
      v_existing.from_stage,
      v_existing.resulting_stage,
      true,
      v_existing.evidence_revision;
    return;
  end if;

  perform private.sync_monitoring_feedback_promotion_clusters();

  select cluster.*
  into v_cluster
  from public.monitoring_feedback_promotion_clusters cluster
  where cluster.id = p_cluster_id
  for update;

  if not found then
    raise exception 'monitoring feedback promotion cluster was not found'
      using errcode = 'P0002';
  end if;
  if p_expected_evidence_revision is distinct from v_cluster.evidence_revision then
    raise exception 'promotion evidence revision is stale; expected %, current %',
      p_expected_evidence_revision,
      v_cluster.evidence_revision
      using errcode = '40001';
  end if;
  if v_cluster.activation_status not in ('blocked_late_evidence', 'rollback_required')
    or v_cluster.activation_blocked_at is null
    or v_cluster.current_stage not in ('six_pm_canary', 'retroactive_sweep')
    or v_cluster.proposed_rule_id is null then
    raise exception 'only a blocked or rollback-required activation can be rolled back'
      using errcode = '22023';
  end if;

  select pg_catalog.count(*)::bigint
  into v_attributable_suppression_count
  from public.shared_award_change_events change_event
  where change_event.suppressed_at is not null
    and (
      change_event.suppression_source = 'verified-promotion:' || v_cluster.id::text
      or (
        change_event.suppression_source = 'scheduled-downstream-policy-sweep'
        and change_event.suppression_reason =
          'policy_flag_' || v_cluster.proposed_rule_id
      )
    );

  if v_attributable_suppression_count <> 0 then
    raise exception 'activation rollback is blocked by % attributable suppression rows',
      v_attributable_suppression_count
      using errcode = '55000';
  end if;

  v_hashes := v_cluster.stage_artifacts -> 'app_worker_hashes_match';
  if not private.monitoring_feedback_promotion_report_valid(
    v_evidence,
    'monitoring-promotion-hash-attestation-v1',
    v_cluster.cluster_key,
    v_cluster.proposed_rule_id,
    v_cluster.stage_artifacts #>> '{rule_drafted,draft_hash}'
  ) then
    raise exception 'rollback attestation envelope is invalid or targets another draft'
      using errcode = '22023';
  elsif v_evidence ->> 'status' is distinct from 'passed'
    or pg_catalog.jsonb_typeof(v_evidence -> 'rule_active') is distinct from 'boolean'
    or private.monitoring_feedback_json_boolean(v_evidence, 'rule_active') then
    raise exception 'rollback requires a passing attestation that the rule is inactive'
      using errcode = '22023';
  elsif nullif(pg_catalog.btrim(coalesce(v_evidence ->> 'app_revision', '')), '') is null
    or v_evidence ->> 'app_revision' is distinct from v_evidence ->> 'worker_revision'
    or v_evidence ->> 'app_policy_hash' is distinct from v_evidence ->> 'worker_policy_hash'
    or v_evidence ->> 'app_batch_policy_hash' is distinct from
      v_evidence ->> 'worker_batch_policy_hash'
    or v_evidence ->> 'app_suppression_policy_hash' is distinct from
      v_evidence ->> 'worker_suppression_policy_hash'
    or v_evidence ->> 'app_matcher_digest' is distinct from
      v_evidence ->> 'worker_matcher_digest' then
    raise exception 'rollback app and worker identities must match exactly'
      using errcode = '22023';
  elsif v_evidence ->> 'app_policy_hash' is distinct from v_hashes ->> 'app_policy_hash'
    or v_evidence ->> 'app_batch_policy_hash' is distinct from
      v_hashes ->> 'app_batch_policy_hash'
    or v_evidence ->> 'app_suppression_policy_hash' is distinct from
      v_hashes ->> 'app_suppression_policy_hash'
    or v_evidence ->> 'app_matcher_digest' is distinct from
      v_cluster.stage_artifacts #>> '{rule_drafted,rule,matcher_digest}' then
    raise exception 'rollback did not restore the reviewed inactive deployment identity'
      using errcode = '22023';
  elsif private.monitoring_feedback_json_array_length(
    v_evidence,
    'comparisons'
  ) is distinct from 5::bigint
    or not private.monitoring_feedback_worker_attestation_runs_valid(
      v_evidence,
      v_cluster.activation_blocked_at
    ) then
    raise exception 'rollback requires five comparisons and a later matching durable worker run'
      using errcode = '22023';
  end if;

  select pg_catalog.count(*)::bigint
  into v_recurrence_count
  from public.monitoring_feedback_promotion_cluster_members member
  where member.cluster_id = v_cluster.id;

  insert into public.monitoring_feedback_promotion_transitions (
    id,
    request_id,
    cluster_id,
    from_stage,
    requested_stage,
    resulting_stage,
    accepted,
    transition_kind,
    evidence_revision,
    recurrence_count,
    actor_user_id,
    actor_email,
    policy_rule_id,
    evidence,
    note,
    created_at
  ) values (
    v_transition_id,
    p_request_id,
    v_cluster.id,
    v_cluster.current_stage,
    'similar_feedback_clustered',
    'similar_feedback_clustered',
    true,
    'activation_rollback',
    v_cluster.evidence_revision,
    v_recurrence_count,
    p_actor_user_id,
    v_actor_email,
    v_cluster.proposed_rule_id,
    v_evidence,
    v_note,
    pg_catalog.clock_timestamp()
  );

  update public.monitoring_feedback_promotion_clusters cluster
  set
    current_stage = 'similar_feedback_clustered',
    proposed_rule_id = null,
    stage_artifacts = cluster.stage_artifacts - array[
      'rule_drafted',
      'historical_shadow_test',
      'regression_tests_pass',
      'app_worker_hashes_match',
      'six_pm_canary',
      'retroactive_sweep',
      'resolved'
    ]::text[],
    activation_status = 'inactive',
    activation_blocked_at = null,
    updated_at = pg_catalog.clock_timestamp()
  where cluster.id = v_cluster.id;

  return query select
    v_transition_id,
    v_cluster.id,
    v_cluster.current_stage,
    'similar_feedback_clustered'::text,
    true,
    v_cluster.evidence_revision;
end;
$function$;

create or replace function public.restart_monitoring_feedback_promotion_cluster(
  p_request_id uuid,
  p_cluster_id uuid,
  p_expected_evidence_revision bigint,
  p_actor_user_id uuid,
  p_actor_email text,
  p_note text default null
)
returns table (
  transition_id uuid,
  restarted_cluster_id uuid,
  previous_stage text,
  current_stage text,
  restarted boolean,
  restart_evidence_revision bigint,
  failed_transition_id uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_cluster public.monitoring_feedback_promotion_clusters%rowtype;
  v_existing public.monitoring_feedback_promotion_transitions%rowtype;
  v_failed public.monitoring_feedback_promotion_transitions%rowtype;
  v_transition_id uuid := gen_random_uuid();
  v_actor_email text := pg_catalog.lower(
    pg_catalog.btrim(coalesce(p_actor_email, ''))
  );
  v_note text := nullif(pg_catalog.btrim(coalesce(p_note, '')), '');
  v_evidence jsonb;
  v_recurrence_count bigint;
begin
  if p_request_id is null
    or p_cluster_id is null
    or p_expected_evidence_revision is null
    or p_actor_user_id is null then
    raise exception 'request, cluster, evidence revision, and actor IDs are required'
      using errcode = '22004';
  end if;
  if p_expected_evidence_revision < 1 then
    raise exception 'a positive expected evidence revision is required'
      using errcode = '22023';
  end if;
  if pg_catalog.char_length(v_actor_email) < 3
    or pg_catalog.char_length(v_actor_email) > 320 then
    raise exception 'a valid actor email is required'
      using errcode = '22023';
  end if;
  if pg_catalog.char_length(coalesce(v_note, '')) > 1000 then
    raise exception 'promotion restart note is too long'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_request_id::text, 0)
  );

  select transition.*
  into v_existing
  from public.monitoring_feedback_promotion_transitions transition
  where transition.request_id = p_request_id;

  if found then
    if v_existing.transition_kind is distinct from 'operator_restart'
      or not v_existing.accepted
      or v_existing.cluster_id is distinct from p_cluster_id
      or v_existing.evidence_revision is distinct from p_expected_evidence_revision
      or v_existing.actor_user_id is distinct from p_actor_user_id
      or v_existing.actor_email is distinct from v_actor_email
      or v_existing.note is distinct from v_note then
      raise exception 'request ID was already used for a different promotion restart'
        using errcode = '22023';
    end if;

    return query select
      v_existing.id,
      v_existing.cluster_id,
      v_existing.from_stage,
      v_existing.resulting_stage,
      true,
      v_existing.evidence_revision,
      (v_existing.evidence ->> 'failed_transition_id')::uuid;
    return;
  end if;

  perform private.sync_monitoring_feedback_promotion_clusters();

  select cluster.*
  into v_cluster
  from public.monitoring_feedback_promotion_clusters cluster
  where cluster.id = p_cluster_id
  for update;

  if not found then
    raise exception 'monitoring feedback promotion cluster was not found'
      using errcode = 'P0002';
  end if;
  if p_expected_evidence_revision is distinct from v_cluster.evidence_revision then
    raise exception 'promotion evidence revision is stale; expected %, current %',
      p_expected_evidence_revision,
      v_cluster.evidence_revision
      using errcode = '40001';
  end if;
  if v_cluster.activation_status in ('blocked_late_evidence', 'rollback_required') then
    raise exception 'late feedback blocked activation; rollback and restart are required'
      using errcode = '55000';
  end if;
  if v_cluster.resolved_at is not null
    or v_cluster.activation_status is distinct from 'inactive'
    or v_cluster.current_stage not in (
      'rule_drafted',
      'historical_shadow_test',
      'regression_tests_pass',
      'app_worker_hashes_match'
    ) then
    raise exception 'only a failed preactivation gate can be restarted'
      using errcode = '22023';
  end if;

  select transition.*
  into v_failed
  from public.monitoring_feedback_promotion_transitions transition
  where transition.cluster_id = v_cluster.id
    and transition.evidence_revision = v_cluster.evidence_revision
    and transition.transition_kind = 'stage_attempt'
  order by transition.created_at desc, transition.id desc
  limit 1;

  if not found
    or v_failed.accepted
    or v_failed.from_stage is distinct from v_cluster.current_stage
    or v_failed.resulting_stage is distinct from v_cluster.current_stage then
    raise exception 'the latest current-revision gate attempt is not a restartable failure'
      using errcode = '22023';
  end if;

  v_evidence := pg_catalog.jsonb_build_object(
    'event', 'operator_restart',
    'failed_transition_id', v_failed.id,
    'failed_requested_stage', v_failed.requested_stage,
    'failure_reason', v_failed.failure_reason,
    'previous_stage', v_cluster.current_stage,
    'resulting_stage', 'similar_feedback_clustered',
    'evidence_revision', v_cluster.evidence_revision,
    'restarted_at', pg_catalog.clock_timestamp()
  );

  select pg_catalog.count(*)::bigint
  into v_recurrence_count
  from public.monitoring_feedback_promotion_cluster_members member
  where member.cluster_id = v_cluster.id;

  insert into public.monitoring_feedback_promotion_transitions (
    id,
    request_id,
    cluster_id,
    from_stage,
    requested_stage,
    resulting_stage,
    accepted,
    transition_kind,
    evidence_revision,
    recurrence_count,
    actor_user_id,
    actor_email,
    policy_rule_id,
    evidence,
    note,
    created_at
  ) values (
    v_transition_id,
    p_request_id,
    v_cluster.id,
    v_cluster.current_stage,
    'similar_feedback_clustered',
    'similar_feedback_clustered',
    true,
    'operator_restart',
    v_cluster.evidence_revision,
    v_recurrence_count,
    p_actor_user_id,
    v_actor_email,
    v_cluster.proposed_rule_id,
    v_evidence,
    v_note,
    pg_catalog.clock_timestamp()
  );

  update public.monitoring_feedback_promotion_clusters cluster
  set
    current_stage = 'similar_feedback_clustered',
    proposed_rule_id = null,
    stage_artifacts = cluster.stage_artifacts - array[
      'rule_drafted',
      'historical_shadow_test',
      'regression_tests_pass',
      'app_worker_hashes_match',
      'six_pm_canary',
      'retroactive_sweep',
      'resolved'
    ]::text[],
    updated_at = pg_catalog.clock_timestamp()
  where cluster.id = v_cluster.id;

  return query select
    v_transition_id,
    v_cluster.id,
    v_cluster.current_stage,
    'similar_feedback_clustered'::text,
    true,
    v_cluster.evidence_revision,
    v_failed.id;
end;
$function$;

create or replace function public.advance_monitoring_feedback_promotion_cluster(
  p_request_id uuid,
  p_cluster_id uuid,
  p_expected_evidence_revision bigint,
  p_to_stage text,
  p_actor_user_id uuid,
  p_actor_email text,
  p_evidence jsonb,
  p_policy_rule_id text default null,
  p_policy_identity text default null,
  p_policy_version text default null,
  p_policy_hash text default null,
  p_policy_config_version integer default null,
  p_decision_memory_version integer default null,
  p_note text default null
)
returns table (
  transition_id uuid,
  advanced_cluster_id uuid,
  previous_stage text,
  current_stage text,
  requested_stage text,
  accepted boolean,
  advanced boolean,
  failure_reason text,
  promotion_count integer,
  recurrence_count bigint,
  current_evidence_revision bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_cluster public.monitoring_feedback_promotion_clusters%rowtype;
  v_existing public.monitoring_feedback_promotion_transitions%rowtype;
  v_draft_transition public.monitoring_feedback_promotion_transitions%rowtype;
  v_transition_id uuid := gen_random_uuid();
  v_to_stage text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_to_stage, '')));
  v_expected_stage text;
  v_actor_email text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_actor_email, '')));
  v_rule_id text := nullif(pg_catalog.btrim(coalesce(p_policy_rule_id, '')), '');
  v_policy_identity text := nullif(pg_catalog.btrim(coalesce(p_policy_identity, '')), '');
  v_policy_version text := nullif(pg_catalog.btrim(coalesce(p_policy_version, '')), '');
  v_policy_hash text := nullif(pg_catalog.btrim(coalesce(p_policy_hash, '')), '');
  v_note text := nullif(pg_catalog.btrim(coalesce(p_note, '')), '');
  v_evidence jsonb := coalesce(p_evidence, '{}'::jsonb);
  v_failure text;
  v_recurrence_count bigint;
  v_distinct_event_count bigint;
  v_distinct_event_ids jsonb;
  v_source_count bigint;
  v_unresolved_count bigint := 0;
  v_inserted_count integer := 0;
  v_shadow jsonb;
  v_hashes jsonb;
  v_retro jsonb;
  v_activation jsonb;
  v_collision_count bigint;
  v_collision_array_count bigint;
  v_distinct_run_count bigint;
  v_binding_count bigint;
  v_invalid_binding_count bigint;
  v_distinct_binding_event_count bigint;
  v_distinct_binding_candidate_count bigint;
  v_expected_candidate_count bigint;
  v_bound_candidate_count bigint;
  v_bound_event_count bigint;
  v_observation_count bigint;
  v_observed_candidate_count bigint;
  v_candidate_status_invalid_count bigint;
  v_candidate_status_total numeric;
  v_nonterminal_candidate_count numeric;
  v_published_candidate_count numeric;
  v_actual_candidate_status_counts jsonb;
  v_canary_invalid_run_count bigint;
  v_canary_distinct_shard_count bigint;
  v_canary_metadata_observation_count numeric;
  v_canary_metadata_enqueued_count numeric;
  v_regression_negative_ids jsonb;
  v_regression_negative_invalid_count bigint;
  v_regression_positive_ids jsonb;
  v_regression_positive_invalid_count bigint;
  v_required_gate_count integer;
  v_live_sweep_mutation_at timestamptz;
begin
  if p_request_id is null
    or p_cluster_id is null
    or p_actor_user_id is null
    or p_expected_evidence_revision is null then
    raise exception 'request, cluster, evidence revision, and actor IDs are required'
      using errcode = '22004';
  end if;
  if p_expected_evidence_revision < 1 then
    raise exception 'a positive expected evidence revision is required'
      using errcode = '22023';
  end if;
  if char_length(v_actor_email) < 3 or char_length(v_actor_email) > 320 then
    raise exception 'a valid actor email is required'
      using errcode = '22023';
  end if;
  if pg_catalog.jsonb_typeof(v_evidence) is distinct from 'object' then
    raise exception 'promotion stage evidence must be a JSON object'
      using errcode = '22023';
  end if;
  if char_length(coalesce(v_note, '')) > 1000 then
    raise exception 'promotion transition note is too long'
      using errcode = '22023';
  end if;
  if v_rule_id is not null and char_length(v_rule_id) > 160 then
    raise exception 'monitoring policy rule ID is too long'
      using errcode = '22023';
  end if;

  -- Serialize idempotency keys even when two different clusters are targeted.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_request_id::text, 0)
  );
  perform private.sync_monitoring_feedback_promotion_clusters();

  select cluster.*
  into v_cluster
  from public.monitoring_feedback_promotion_clusters cluster
  where cluster.id = p_cluster_id
  for update;

  if not found then
    raise exception 'monitoring feedback promotion cluster was not found'
      using errcode = 'P0002';
  end if;

  if v_rule_id is null and v_cluster.proposed_rule_id is not null then
    v_rule_id := v_cluster.proposed_rule_id;
  end if;

  select transition.*
  into v_existing
  from public.monitoring_feedback_promotion_transitions transition
  where transition.request_id = p_request_id;

  if found then
    if v_rule_id is null and v_existing.policy_rule_id is not null then
      v_rule_id := v_existing.policy_rule_id;
    end if;
    if v_existing.cluster_id is distinct from p_cluster_id
      or v_existing.requested_stage is distinct from v_to_stage
      or v_existing.evidence_revision is distinct from p_expected_evidence_revision
      or v_existing.actor_user_id is distinct from p_actor_user_id
      or v_existing.actor_email is distinct from v_actor_email
      or v_existing.policy_rule_id is distinct from v_rule_id
      or v_existing.policy_identity is distinct from v_policy_identity
      or v_existing.policy_version is distinct from v_policy_version
      or v_existing.policy_hash is distinct from v_policy_hash
      or v_existing.policy_config_version is distinct from p_policy_config_version
      or v_existing.decision_memory_version is distinct from p_decision_memory_version
      or v_existing.evidence is distinct from v_evidence
      or v_existing.note is distinct from v_note then
      raise exception 'request ID was already used for a different promotion transition'
        using errcode = '22023';
    end if;

    return query select
      v_existing.id,
      v_existing.cluster_id,
      v_existing.from_stage,
      v_existing.resulting_stage,
      v_existing.requested_stage,
      v_existing.accepted,
      v_existing.accepted,
      v_existing.failure_reason,
      v_existing.promotion_count,
      v_existing.recurrence_count,
      v_existing.evidence_revision;
    return;
  end if;

  if p_expected_evidence_revision is distinct from v_cluster.evidence_revision then
    raise exception 'promotion evidence revision is stale; expected %, current %',
      p_expected_evidence_revision,
      v_cluster.evidence_revision
      using errcode = '40001';
  end if;
  if v_cluster.activation_status in ('blocked_late_evidence', 'rollback_required') then
    raise exception 'late feedback blocked activation; rollback and restart are required'
      using errcode = '55000';
  end if;

  v_expected_stage := private.monitoring_feedback_promotion_next_stage(
    v_cluster.current_stage
  );
  if v_expected_stage is null or v_to_stage is distinct from v_expected_stage then
    raise exception 'promotion stages must advance sequentially from % to %',
      v_cluster.current_stage,
      coalesce(v_expected_stage, 'no later stage')
      using errcode = '22023';
  end if;

  select
    pg_catalog.count(*)::bigint,
    pg_catalog.count(distinct feedback.event_id)::bigint,
    pg_catalog.count(distinct feedback.source_id)::bigint
  into v_recurrence_count, v_distinct_event_count, v_source_count
  from public.monitoring_feedback_promotion_cluster_members member
  join public.monitoring_feedback feedback
    on feedback.id = member.feedback_id
  where member.cluster_id = v_cluster.id;

  if v_recurrence_count < 1 then
    raise exception 'promotion cluster has no feedback evidence'
      using errcode = 'P0001';
  elsif v_recurrence_count is distinct from v_cluster.evidence_revision then
    raise exception 'promotion evidence revision does not match append-only membership'
      using errcode = '40001';
  end if;

  select coalesce(
    pg_catalog.jsonb_agg(
      distinct_event.event_id
      order by distinct_event.event_id
    ),
    '[]'::jsonb
  )
  into v_distinct_event_ids
  from (
    select distinct feedback.event_id::text as event_id
    from public.monitoring_feedback_promotion_cluster_members member
    join public.monitoring_feedback feedback
      on feedback.id = member.feedback_id
    where member.cluster_id = v_cluster.id
      and feedback.event_id is not null
  ) distinct_event;

  if pg_catalog.jsonb_array_length(v_distinct_event_ids)
      is distinct from v_distinct_event_count then
    raise exception 'distinct promotion event evidence is inconsistent'
      using errcode = '40001';
  end if;

  if v_cluster.proposed_rule_id is not null
    and v_rule_id is not null
    and v_rule_id is distinct from v_cluster.proposed_rule_id then
    v_failure := 'The transition names a different rule than the immutable drafted rule.';
  end if;

  if v_to_stage = 'similar_feedback_clustered' then
    if not private.monitoring_feedback_json_boolean(v_evidence, 'cluster_reviewed') then
      v_failure := 'Confirm that the similar-feedback cluster was reviewed.';
    elsif private.monitoring_feedback_json_nonnegative_bigint(
      v_evidence,
      'recurrence_count'
    ) is distinct from v_recurrence_count then
      v_failure := 'The reviewed recurrence count does not match cluster membership.';
    elsif private.monitoring_feedback_json_nonnegative_bigint(
      v_evidence,
      'source_count'
    ) is distinct from v_source_count then
      v_failure := 'The reviewed source count does not match cluster membership.';
    elsif v_evidence ->> 'evidence_signature' is distinct from v_cluster.evidence_signature
      or v_evidence ->> 'domain_template' is distinct from v_cluster.domain_template
      or v_evidence ->> 'reason_code' is distinct from v_cluster.reason_code then
      v_failure := 'The reviewed clustering keys do not match the durable cluster identity.';
    end if;

  elsif v_to_stage = 'rule_drafted' then
    if v_rule_id is not null then
      perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('monitoring-promotion-rule:' || v_rule_id, 0)
      );
    end if;
    if v_rule_id is null then
      v_failure := 'A stable proposed policy rule ID is required.';
    elsif exists (
      select 1
      from public.monitoring_feedback_promotion_clusters other_cluster
      where other_cluster.id <> v_cluster.id
        and other_cluster.resolved_at is null
        and other_cluster.proposed_rule_id = v_rule_id
    ) then
      v_failure := 'Another unresolved promotion cluster already owns this proposed rule ID.';
    elsif v_evidence ->> 'rule_id' is distinct from v_rule_id then
      v_failure := 'The draft artifact rule ID does not match the proposed rule.';
    elsif coalesce(v_evidence ->> 'draft_hash', '') !~ '^[0-9a-f]{64}$' then
      v_failure := 'A deterministic SHA-256 draft hash is required.';
    elsif pg_catalog.jsonb_typeof(v_evidence -> 'rule') is distinct from 'object' then
      v_failure := 'The structured draft rule artifact is required.';
    elsif public.awardping_sha256_text(
      private.monitoring_feedback_canonical_json(v_evidence -> 'rule')
    ) is distinct from v_evidence ->> 'draft_hash' then
      v_failure := 'The draft hash does not match the canonical structured rule artifact.';
    elsif v_evidence #>> '{rule,id}' is distinct from v_rule_id then
      v_failure := 'The structured candidate rule ID does not match the proposed rule.';
    elsif coalesce(v_evidence #>> '{rule,matcher_digest}', '') !~ '^[0-9a-f]{64}$' then
      v_failure := 'The candidate rule must seal its executable matcher digest.';
    elsif v_evidence #>> '{rule,promotion_test_mode}' is distinct from 'deterministic' then
      v_failure := 'The candidate rule must expose a deterministic promotion test mode.';
    elsif pg_catalog.jsonb_typeof(v_evidence -> 'candidate_active') is distinct from 'boolean'
      or private.monitoring_feedback_json_boolean(v_evidence, 'candidate_active') then
      v_failure := 'The drafted candidate must remain globally inactive before its canary.';
    elsif not private.monitoring_feedback_json_boolean(
      v_evidence -> 'rule',
      'alert_blocking'
    ) then
      v_failure := 'The drafted candidate must be an implemented alert-blocking rule.';
    elsif not private.monitoring_feedback_json_boolean(
      v_evidence -> 'rule',
      'persistent'
    ) then
      v_failure := 'The drafted candidate must persistently filter stored change evidence.';
    elsif pg_catalog.jsonb_typeof(v_evidence #> '{rule,prompt}')
        is distinct from 'string'
      or nullif(
        pg_catalog.btrim(coalesce(v_evidence #>> '{rule,prompt}', '')),
        ''
      ) is null then
      v_failure := 'The drafted candidate must include a nonempty operator prompt.';
    elsif pg_catalog.jsonb_typeof(v_evidence #> '{rule,prompt_scopes}')
        is distinct from 'array'
      or not (v_evidence #> '{rule,prompt_scopes}' ? 'visual_review_batch') then
      v_failure := 'The drafted candidate must be visible to the visual review Batch prompt.';
    elsif not private.monitoring_feedback_sorted_unique_uuid_array_valid(
      v_evidence -> 'legitimate_negative_event_ids'
    ) then
      v_failure := 'The draft requires independently chosen, ordered, unique legitimate negative event IDs.';
    elsif exists (
      select 1
      from pg_catalog.jsonb_array_elements_text(
        v_evidence -> 'legitimate_negative_event_ids'
      ) negative_event(event_id)
      where not exists (
        select 1
        from public.shared_award_change_events change_event
        where change_event.id::text = negative_event.event_id
      )
        or exists (
          select 1
          from public.monitoring_feedback_promotion_cluster_members member
          join public.monitoring_feedback feedback
            on feedback.id = member.feedback_id
          where member.cluster_id = v_cluster.id
            and feedback.event_id::text = negative_event.event_id
        )
    ) then
      v_failure := 'Legitimate negative fixtures must be retained events outside the clustered recurrences.';
    elsif v_policy_identity is null
      or v_policy_version is null
      or v_policy_hash is null
      or p_policy_config_version is null
      or p_decision_memory_version is null then
      v_failure := 'The candidate draft must be bound to the complete app policy identity.';
    end if;

  elsif v_to_stage = 'historical_shadow_test' then
    v_collision_count := private.monitoring_feedback_json_nonnegative_bigint(
      v_evidence,
      'legitimate_updates_suppressed'
    );
    v_collision_array_count := case
      when pg_catalog.jsonb_typeof(v_evidence -> 'legitimate_updates') = 'array'
        then pg_catalog.jsonb_array_length(
          v_evidence -> 'legitimate_updates'
        )::bigint
      else null
    end;
    if not private.monitoring_feedback_promotion_report_valid(
      v_evidence,
      'monitoring-promotion-shadow-v1',
      v_cluster.cluster_key,
      v_cluster.proposed_rule_id,
      v_cluster.stage_artifacts #>> '{rule_drafted,draft_hash}'
    ) then
      v_failure := 'The historical shadow report envelope is invalid or targets another draft.';
    elsif v_evidence ->> 'matcher_digest' is distinct from
      v_cluster.stage_artifacts #>> '{rule_drafted,rule,matcher_digest}' then
      v_failure := 'The shadow test did not execute the reviewed matcher.';
    elsif pg_catalog.jsonb_typeof(v_evidence -> 'rule_active') is distinct from 'boolean'
      or private.monitoring_feedback_json_boolean(v_evidence, 'rule_active') then
      v_failure := 'Historical shadow testing requires the candidate to remain globally inactive.';
    elsif not private.monitoring_feedback_json_boolean(v_evidence, 'history_complete') then
      v_failure := 'The historical shadow scan was truncated and cannot authorize promotion.';
    elsif v_evidence ->> 'status' is distinct from 'passed' then
      v_failure := 'The historical shadow test did not pass.';
    elsif private.monitoring_feedback_json_nonnegative_bigint(
      v_evidence,
      'total_history_checked'
    ) is null
      or private.monitoring_feedback_json_nonnegative_bigint(
      v_evidence,
      'total_history_checked'
      ) < v_distinct_event_count then
      v_failure := 'The historical shadow test did not scan enough evidence.';
    elsif private.monitoring_feedback_json_nonnegative_bigint(
      v_evidence,
      'feedback_event_count'
    ) is distinct from v_distinct_event_count then
      v_failure := 'The historical shadow report does not cover every distinct cluster event.';
    elsif v_evidence -> 'feedback_event_ids' is distinct from
        v_distinct_event_ids then
      v_failure := 'The historical shadow report names different cluster events.';
    elsif private.monitoring_feedback_json_nonnegative_bigint(
      v_evidence,
      'recurrence_matches'
    ) is distinct from v_distinct_event_count then
      v_failure := 'The proposed rule did not match every distinct event in the cluster.';
    elsif v_evidence -> 'matched_feedback_event_ids' is distinct from
        v_distinct_event_ids then
      v_failure := 'The proposed rule did not prove every distinct cluster event match.';
    elsif private.monitoring_feedback_json_nonnegative_bigint(
      v_evidence,
      'proposed_rule_matches'
    ) is null
      or private.monitoring_feedback_json_nonnegative_bigint(
        v_evidence,
        'proposed_rule_matches'
      ) < v_distinct_event_count then
      v_failure := 'The historical shadow report has inconsistent proposed-rule match counts.';
    elsif v_collision_count is null
      or v_collision_array_count is null
      or v_collision_count is distinct from v_collision_array_count then
      v_failure := 'The legitimate collision count and collision evidence list must agree.';
    elsif v_collision_count <> 0 then
      v_failure := 'The proposed rule would suppress legitimate historical updates.';
    end if;

  elsif v_to_stage = 'regression_tests_pass' then
    select
      coalesce(
        pg_catalog.jsonb_agg(
          regression_item.value ->> 'fixture_id'
          order by regression_item.value ->> 'fixture_id'
        ) filter (
          where regression_item.value ->> 'expected' = 'visible'
        ),
        '[]'::jsonb
      ),
      pg_catalog.count(*) filter (
        where regression_item.value ->> 'expected' = 'visible'
          and (
            pg_catalog.jsonb_typeof(regression_item.value) is distinct from 'object'
            or coalesce(regression_item.value ->> 'fixture_id', '') !~
              '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            or pg_catalog.jsonb_typeof(regression_item.value -> 'matched')
              is distinct from 'boolean'
            or private.monitoring_feedback_json_boolean(
              regression_item.value,
              'matched'
            )
          )
      )::bigint,
      coalesce(
        pg_catalog.jsonb_agg(
          regression_item.value ->> 'fixture_id'
          order by regression_item.value ->> 'fixture_id'
        ) filter (
          where regression_item.value ->> 'expected' = 'suppressed'
        ),
        '[]'::jsonb
      ),
      pg_catalog.count(*) filter (
        where regression_item.value ->> 'expected' = 'suppressed'
          and (
            pg_catalog.jsonb_typeof(regression_item.value) is distinct from 'object'
            or coalesce(regression_item.value ->> 'fixture_id', '') !~
              '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            or pg_catalog.jsonb_typeof(regression_item.value -> 'matched')
              is distinct from 'boolean'
            or not private.monitoring_feedback_json_boolean(
              regression_item.value,
              'matched'
            )
          )
      )::bigint
    into
      v_regression_negative_ids,
      v_regression_negative_invalid_count,
      v_regression_positive_ids,
      v_regression_positive_invalid_count
    from pg_catalog.jsonb_array_elements(
      case
        when pg_catalog.jsonb_typeof(v_evidence -> 'fixture_results') = 'array'
          then v_evidence -> 'fixture_results'
        else '[]'::jsonb
      end
    ) regression_item(value);

    if not private.monitoring_feedback_promotion_report_valid(
      v_evidence,
      'monitoring-promotion-regression-v1',
      v_cluster.cluster_key,
      v_cluster.proposed_rule_id,
      v_cluster.stage_artifacts #>> '{rule_drafted,draft_hash}'
    ) then
      v_failure := 'The regression report envelope is invalid or targets another draft.';
    elsif v_evidence ->> 'matcher_digest' is distinct from
      v_cluster.stage_artifacts #>> '{rule_drafted,rule,matcher_digest}' then
      v_failure := 'Regression tests did not execute the reviewed matcher.';
    elsif pg_catalog.jsonb_typeof(v_evidence -> 'rule_active') is distinct from 'boolean'
      or private.monitoring_feedback_json_boolean(v_evidence, 'rule_active') then
      v_failure := 'Regression testing requires the candidate to remain globally inactive.';
    elsif v_evidence ->> 'status' is distinct from 'passed' then
      v_failure := 'Regression tests did not pass.';
    elsif private.monitoring_feedback_json_nonnegative_bigint(
      v_evidence,
      'positive_fixture_count'
    ) is distinct from v_distinct_event_count
      or v_evidence -> 'positive_fixture_event_ids' is distinct from
        v_distinct_event_ids
      or v_regression_positive_ids is distinct from v_distinct_event_ids
      or v_regression_positive_invalid_count <> 0 then
      v_failure := 'Regression positives must exactly match every distinct clustered event and prove matched=true.';
    elsif private.monitoring_feedback_json_nonnegative_bigint(
      v_evidence,
      'negative_fixture_count'
    ) is null
      or private.monitoring_feedback_json_nonnegative_bigint(
        v_evidence,
        'negative_fixture_count'
      ) < 1 then
      v_failure := 'Regression tests require at least one legitimate negative fixture.';
    elsif v_evidence -> 'legitimate_negative_event_ids' is distinct from
        v_cluster.stage_artifacts #> '{rule_drafted,legitimate_negative_event_ids}'
      or v_regression_negative_ids is distinct from
        v_cluster.stage_artifacts #> '{rule_drafted,legitimate_negative_event_ids}'
      or v_regression_negative_invalid_count <> 0
      or private.monitoring_feedback_json_array_length(
        v_evidence,
        'legitimate_negative_event_ids'
      ) is distinct from private.monitoring_feedback_json_nonnegative_bigint(
        v_evidence,
        'negative_fixture_count'
      ) then
      v_failure := 'Regression negatives must exactly match the independently chosen immutable fixtures.';
    elsif private.monitoring_feedback_json_nonnegative_bigint(
      v_evidence,
      'failure_count'
    ) is distinct from 0::bigint then
      v_failure := 'Regression tests must complete with zero fixture failures.';
    elsif private.monitoring_feedback_json_array_length(
      v_evidence,
      'fixture_results'
    ) is distinct from
      private.monitoring_feedback_json_nonnegative_bigint(
        v_evidence,
        'positive_fixture_count'
      ) + private.monitoring_feedback_json_nonnegative_bigint(
        v_evidence,
        'negative_fixture_count'
      ) then
      v_failure := 'The regression fixture totals and retained results must agree.';
    end if;

  elsif v_to_stage = 'app_worker_hashes_match' then
    select transition.*
    into v_draft_transition
    from public.monitoring_feedback_promotion_transitions transition
    where transition.cluster_id = v_cluster.id
      and transition.requested_stage = 'rule_drafted'
      and transition.accepted
      and transition.transition_kind = 'stage_attempt'
      and transition.evidence_revision = v_cluster.evidence_revision
    order by transition.created_at desc, transition.id desc
    limit 1;

    if not found then
      v_failure := 'The immutable candidate draft transition is missing.';
    elsif not private.monitoring_feedback_promotion_report_valid(
      v_evidence,
      'monitoring-promotion-hash-attestation-v1',
      v_cluster.cluster_key,
      v_cluster.proposed_rule_id,
      v_cluster.stage_artifacts #>> '{rule_drafted,draft_hash}'
    ) then
      v_failure := 'The candidate hash attestation envelope is invalid or targets another draft.';
    elsif v_evidence ->> 'status' is distinct from 'passed' then
      v_failure := 'App and worker hashes were not verified as matching.';
    elsif pg_catalog.jsonb_typeof(v_evidence -> 'rule_active') is distinct from 'boolean'
      or private.monitoring_feedback_json_boolean(v_evidence, 'rule_active') then
      v_failure := 'The candidate rule must remain globally inactive during pre-canary attestation.';
    elsif nullif(pg_catalog.btrim(coalesce(v_evidence ->> 'app_revision', '')), '') is null
      or nullif(pg_catalog.btrim(coalesce(v_evidence ->> 'worker_revision', '')), '') is null
      or pg_catalog.lower(v_evidence ->> 'app_revision') = 'unavailable'
      or pg_catalog.lower(v_evidence ->> 'worker_revision') = 'unavailable'
      or v_evidence ->> 'app_revision' is distinct from v_evidence ->> 'worker_revision' then
      v_failure := 'App and worker attestations must name the same concrete deployed revision.';
    elsif nullif(pg_catalog.btrim(coalesce(v_evidence ->> 'app_policy_hash', '')), '') is null
      or nullif(pg_catalog.btrim(coalesce(v_evidence ->> 'app_batch_policy_hash', '')), '') is null
      or nullif(pg_catalog.btrim(coalesce(v_evidence ->> 'app_suppression_policy_hash', '')), '') is null
      or coalesce(v_evidence ->> 'app_matcher_digest', '') !~ '^[0-9a-f]{64}$' then
      v_failure := 'Full, Batch, suppression, and executable matcher hashes are all required.';
    elsif v_evidence ->> 'app_policy_hash' is distinct from
        v_evidence ->> 'worker_policy_hash'
      or v_evidence ->> 'app_batch_policy_hash' is distinct from
        v_evidence ->> 'worker_batch_policy_hash'
      or v_evidence ->> 'app_suppression_policy_hash' is distinct from
        v_evidence ->> 'worker_suppression_policy_hash'
      or v_evidence ->> 'app_matcher_digest' is distinct from
        v_evidence ->> 'worker_matcher_digest' then
      v_failure := 'App and worker revision, policy, and matcher hashes must match exactly.';
    elsif v_evidence ->> 'app_matcher_digest' is distinct from
      v_cluster.stage_artifacts #>> '{rule_drafted,rule,matcher_digest}' then
      v_failure := 'The deployed executable matcher differs from the reviewed candidate.';
    elsif v_evidence ->> 'app_policy_hash' is distinct from v_draft_transition.policy_hash then
      v_failure := 'The candidate deployment does not match the policy identity bound to the draft.';
    elsif private.monitoring_feedback_json_array_length(
      v_evidence,
      'comparisons'
    ) is distinct from 5::bigint then
      v_failure := 'The hash attestation must retain revision, three policies, and matcher comparisons.';
    elsif private.monitoring_feedback_json_array_length(
      v_evidence,
      'worker_run_ids'
    ) is null
      or private.monitoring_feedback_json_array_length(
        v_evidence,
        'worker_run_ids'
      ) < 1 then
      v_failure := 'At least one worker observation is required for hash verification.';
    elsif not private.monitoring_feedback_worker_attestation_runs_valid(
      v_evidence,
      (v_cluster.stage_artifacts #>> '{regression_tests_pass,completed_at}')::timestamptz
    ) then
      v_failure := 'Hash attestation run IDs are not distinct, durable, later matching worker runs.';
    end if;

  elsif v_to_stage = 'six_pm_canary' then
    v_hashes := v_cluster.stage_artifacts -> 'app_worker_hashes_match';
    v_collision_count := private.monitoring_feedback_json_nonnegative_bigint(
      v_evidence,
      'legitimate_updates_suppressed'
    );
    v_collision_array_count := case
      when pg_catalog.jsonb_typeof(v_evidence -> 'legitimate_updates') = 'array'
        then pg_catalog.jsonb_array_length(v_evidence -> 'legitimate_updates')::bigint
      else null
    end;
    select pg_catalog.count(distinct pg_catalog.btrim(item.value #>> '{}'))::bigint
    into v_distinct_run_count
    from pg_catalog.jsonb_array_elements(
      case
        when pg_catalog.jsonb_typeof(v_evidence -> 'run_ids') = 'array'
          then v_evidence -> 'run_ids'
        else '[]'::jsonb
      end
    ) item(value)
    where pg_catalog.jsonb_typeof(item.value) = 'string'
      and pg_catalog.btrim(item.value #>> '{}') <> '';

    select
      pg_catalog.count(*)::bigint,
      pg_catalog.count(
        distinct nullif(
          pg_catalog.btrim(coalesce(binding.value ->> 'event_id', '')),
          ''
        )
      )::bigint,
      pg_catalog.count(
        distinct nullif(
          pg_catalog.btrim(coalesce(binding.value ->> 'candidate_id', '')),
          ''
        )
      )::bigint,
      pg_catalog.count(*) filter (
        where pg_catalog.jsonb_typeof(binding.value) is distinct from 'object'
          or nullif(
            pg_catalog.btrim(coalesce(binding.value ->> 'worker_run_id', '')),
            ''
          ) is null
          or not (
            (v_evidence -> 'run_ids') ? (binding.value ->> 'worker_run_id')
          )
          or nullif(
            pg_catalog.btrim(coalesce(binding.value ->> 'candidate_id', '')),
            ''
          ) is null
          or nullif(
            pg_catalog.btrim(coalesce(binding.value ->> 'event_id', '')),
            ''
          ) is null
          or not exists (
            select 1
            from public.shared_award_visual_review_candidate_run_observations observation
            where observation.run_id::text = binding.value ->> 'worker_run_id'
              and observation.candidate_id::text = binding.value ->> 'candidate_id'
          )
          or not exists (
            select 1
            from public.shared_award_change_events change_event
            where change_event.id::text = binding.value ->> 'event_id'
              and change_event.visual_review_candidate_id::text =
                binding.value ->> 'candidate_id'
          )
      )::bigint
    into
      v_binding_count,
      v_distinct_binding_event_count,
      v_distinct_binding_candidate_count,
      v_invalid_binding_count
    from pg_catalog.jsonb_array_elements(
      case
        when pg_catalog.jsonb_typeof(v_evidence -> 'event_run_bindings') = 'array'
          then v_evidence -> 'event_run_bindings'
        else '[]'::jsonb
      end
    ) binding(value);

    v_expected_candidate_count :=
      private.monitoring_feedback_json_nonnegative_bigint(
        v_evidence,
        'expected_candidate_count'
      );
    v_bound_candidate_count :=
      private.monitoring_feedback_json_nonnegative_bigint(
        v_evidence,
        'bound_candidate_count'
      );
    v_bound_event_count := private.monitoring_feedback_json_nonnegative_bigint(
      v_evidence,
      'bound_event_count'
    );

    select
      pg_catalog.count(*) filter (
        where status_count.key not in (
          'pending',
          'submitted',
          'processing',
          'succeeded',
          'rejected',
          'failed',
          'published',
          'superseded',
          'unknown'
        )
          or pg_catalog.jsonb_typeof(status_count.value) is distinct from 'number'
          or status_count.value #>> '{}' !~ '^[0-9]+$'
      )::bigint,
      coalesce(
        pg_catalog.sum(
          case
            when pg_catalog.jsonb_typeof(status_count.value) = 'number'
              and status_count.value #>> '{}' ~ '^[0-9]+$'
              then (status_count.value #>> '{}')::numeric
            else 0::numeric
          end
        ),
        0::numeric
      ),
      coalesce(
        pg_catalog.sum(
          case
            when status_count.key in (
              'pending',
              'submitted',
              'processing',
              'succeeded',
              'failed',
              'superseded',
              'unknown'
            )
              and pg_catalog.jsonb_typeof(status_count.value) = 'number'
              and status_count.value #>> '{}' ~ '^[0-9]+$'
              then (status_count.value #>> '{}')::numeric
            else 0::numeric
          end
        ),
        0::numeric
      ),
      coalesce(
        pg_catalog.sum(
          case
            when status_count.key = 'published'
              and pg_catalog.jsonb_typeof(status_count.value) = 'number'
              and status_count.value #>> '{}' ~ '^[0-9]+$'
              then (status_count.value #>> '{}')::numeric
            else 0::numeric
          end
        ),
        0::numeric
      )
    into
      v_candidate_status_invalid_count,
      v_candidate_status_total,
      v_nonterminal_candidate_count,
      v_published_candidate_count
    from pg_catalog.jsonb_each(
      case
        when pg_catalog.jsonb_typeof(v_evidence -> 'candidate_status_counts') = 'object'
          then v_evidence -> 'candidate_status_counts'
        else '{}'::jsonb
      end
    ) status_count;

    select
      pg_catalog.count(*)::bigint,
      pg_catalog.count(distinct observation.candidate_id)::bigint
    into v_observation_count, v_observed_candidate_count
    from public.shared_award_visual_review_candidate_run_observations observation
    join pg_catalog.jsonb_array_elements(
      case
        when pg_catalog.jsonb_typeof(v_evidence -> 'run_ids') = 'array'
          then v_evidence -> 'run_ids'
        else '[]'::jsonb
      end
    ) selected_run(value)
      on pg_catalog.jsonb_typeof(selected_run.value) = 'string'
      and observation.run_id::text = selected_run.value #>> '{}';

    select coalesce(
      pg_catalog.jsonb_object_agg(
        status_summary.status,
        status_summary.status_count
        order by status_summary.status
      ),
      '{}'::jsonb
    )
    into v_actual_candidate_status_counts
    from (
      select
        candidate.status::text as status,
        pg_catalog.count(*)::bigint as status_count
      from (
        select distinct observation.candidate_id
        from public.shared_award_visual_review_candidate_run_observations observation
        join pg_catalog.jsonb_array_elements(
          case
            when pg_catalog.jsonb_typeof(v_evidence -> 'run_ids') = 'array'
              then v_evidence -> 'run_ids'
            else '[]'::jsonb
          end
        ) selected_run(value)
          on pg_catalog.jsonb_typeof(selected_run.value) = 'string'
          and observation.run_id::text = selected_run.value #>> '{}'
      ) observed_candidate
      join public.shared_award_visual_review_candidates candidate
        on candidate.id = observed_candidate.candidate_id
      group by candidate.status
    ) status_summary;

    select
      pg_catalog.count(*) filter (
        where pg_catalog.jsonb_typeof(selected_run.value) is distinct from 'string'
          or selected_run.value #>> '{}' !~
            '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          or worker_run.id is null
          or worker_run.status is distinct from 'succeeded'
          or worker_run.failed_count <> 0
          or worker_run.worker_name not like 'local-visual-snapshot-worker%'
          or worker_run.metadata #>> '{run_identity,workflow}' is distinct from
            'visual_capture'
          or worker_run.metadata #>> '{run_identity,trigger}' is distinct from
            'scheduled'
          or worker_run.metadata #>> '{run_identity,cohort_id}' is distinct from
            v_evidence ->> 'cohort_id'
          or worker_run.metadata #>> '{run_identity,monitoring_date}' is distinct from
            v_evidence ->> 'monitoring_date'
          or worker_run.metadata #>> '{run_identity,shard_count}' is distinct from '3'
          or coalesce(worker_run.metadata #>> '{run_identity,shard_index}', '')
            !~ '^[0-2]$'
          or coalesce(
            worker_run.metadata #>> '{counts,visual_review_candidate_observations}',
            ''
          ) !~ '^[0-9]+$'
          or worker_run.metadata #>> '{counts,visual_review_candidate_observation_failures}'
            is distinct from '0'
          or coalesce(
            worker_run.metadata #>> '{counts,text_only_candidate_enqueued}',
            ''
          ) !~ '^[0-9]+$'
          or coalesce(
            worker_run.metadata #>> '{counts,visual_only_candidate_enqueued}',
            ''
          ) !~ '^[0-9]+$'
          or coalesce(
            worker_run.metadata #>> '{counts,section_change_candidates_enqueued}',
            ''
          ) !~ '^[0-9]+$'
          or worker_run.started_at <=
            (v_hashes ->> 'completed_at')::timestamptz
          or worker_run.finished_at is null
          or worker_run.finished_at < worker_run.started_at
          or worker_run.finished_at > case
            when coalesce(v_evidence ->> 'completed_at', '') ~
              '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?Z$'
              then (v_evidence ->> 'completed_at')::timestamptz
            else null::timestamptz
          end
          or worker_run.metadata ->> 'worker_revision' is distinct from
            v_hashes ->> 'worker_revision'
          or worker_run.metadata #>> '{monitoring_policy_bundle,hash}' is distinct from
            v_hashes ->> 'worker_policy_hash'
          or worker_run.metadata #>> '{monitoring_policy,hash}' is distinct from
            v_hashes ->> 'worker_batch_policy_hash'
          or worker_run.metadata #>> '{suppression_policy,hash}' is distinct from
            v_hashes ->> 'worker_suppression_policy_hash'
          or worker_run.metadata ->> 'matcher_digest' is distinct from
            v_hashes ->> 'worker_matcher_digest'
      )::bigint,
      pg_catalog.count(
        distinct case
          when worker_run.metadata #>> '{run_identity,shard_index}' ~ '^[0-2]$'
            then (worker_run.metadata #>> '{run_identity,shard_index}')::integer
          else null
        end
      )::bigint,
      coalesce(
        pg_catalog.sum(
          case
            when worker_run.metadata #>> '{counts,visual_review_candidate_observations}'
                ~ '^[0-9]+$'
              then (
                worker_run.metadata #>> '{counts,visual_review_candidate_observations}'
              )::numeric
            else 0::numeric
          end
        ),
        0::numeric
      ),
      coalesce(
        pg_catalog.sum(
          case
            when worker_run.metadata #>> '{counts,text_only_candidate_enqueued}'
                ~ '^[0-9]+$'
              and worker_run.metadata #>> '{counts,visual_only_candidate_enqueued}'
                ~ '^[0-9]+$'
              and worker_run.metadata #>> '{counts,section_change_candidates_enqueued}'
                ~ '^[0-9]+$'
              then
                (worker_run.metadata #>> '{counts,text_only_candidate_enqueued}')::numeric
                + (worker_run.metadata #>> '{counts,visual_only_candidate_enqueued}')::numeric
                + (worker_run.metadata #>> '{counts,section_change_candidates_enqueued}')::numeric
            else 0::numeric
          end
        ),
        0::numeric
      )
    into
      v_canary_invalid_run_count,
      v_canary_distinct_shard_count,
      v_canary_metadata_observation_count,
      v_canary_metadata_enqueued_count
    from pg_catalog.jsonb_array_elements(
      case
        when pg_catalog.jsonb_typeof(v_evidence -> 'run_ids') = 'array'
          then v_evidence -> 'run_ids'
        else '[]'::jsonb
      end
    ) selected_run(value)
    left join public.local_worker_runs worker_run
      on pg_catalog.jsonb_typeof(selected_run.value) = 'string'
      and worker_run.id::text = selected_run.value #>> '{}';

    if not private.monitoring_feedback_promotion_report_valid(
      v_evidence,
      'monitoring-promotion-six-pm-canary-v1',
      v_cluster.cluster_key,
      v_cluster.proposed_rule_id,
      v_cluster.stage_artifacts #>> '{rule_drafted,draft_hash}'
    ) then
      v_failure := 'The 6 PM canary report envelope is invalid or targets another draft.';
    elsif v_evidence ->> 'status' is distinct from 'passed' then
      v_failure := 'The 6 PM canary did not pass.';
    elsif pg_catalog.jsonb_typeof(v_evidence -> 'rule_active') is distinct from 'boolean'
      or private.monitoring_feedback_json_boolean(v_evidence, 'rule_active') then
      v_failure := 'The canary must run the candidate while it is still globally inactive.';
    elsif coalesce(v_evidence ->> 'monitoring_date', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
      v_failure := 'A valid 6 PM monitoring date is required.';
    elsif v_evidence ->> 'not_before' is distinct from v_hashes ->> 'completed_at' then
      v_failure := 'The canary must start after the accepted hash attestation.';
    elsif v_evidence ->> 'cohort_id' is distinct from
        'visual-nightly:' || (v_evidence ->> 'monitoring_date') then
      v_failure := 'The canary must use the exact scheduled nightly cohort identity.';
    elsif private.monitoring_feedback_json_nonnegative_bigint(
      v_evidence,
      'expected_shards'
    ) is distinct from 3::bigint
      or private.monitoring_feedback_json_nonnegative_bigint(
        v_evidence,
        'observed_shards'
      ) is distinct from 3::bigint
      or private.monitoring_feedback_json_nonnegative_bigint(
        v_evidence,
        'completed_shards'
      ) is distinct from 3::bigint then
      v_failure := 'All three scheduled 6 PM shards must complete.';
    elsif not private.monitoring_feedback_json_boolean(v_evidence, 'policy_hashes_match') then
      v_failure := 'The 6 PM canary worker hashes did not match the candidate deployment.';
    elsif private.monitoring_feedback_json_array_length(
      v_evidence,
      'run_ids'
    ) is distinct from 3::bigint
      or v_distinct_run_count is distinct from 3::bigint then
      v_failure := 'Three distinct, nonempty scheduled worker run IDs are required.';
    elsif v_canary_invalid_run_count <> 0
      or v_canary_distinct_shard_count is distinct from 3::bigint then
      v_failure := 'Canary run IDs must be the exact three later, successful scheduled visual shards with matching deployed identities.';
    elsif v_evidence -> 'shard_indices' is distinct from '[0, 1, 2]'::jsonb then
      v_failure := 'The canary must prove the exact scheduled shard set 0, 1, and 2.';
    elsif v_expected_candidate_count is null
      or v_bound_candidate_count is null
      or v_expected_candidate_count is distinct from v_bound_candidate_count
      or v_expected_candidate_count::numeric is distinct from
        v_canary_metadata_observation_count
      or private.monitoring_feedback_json_nonnegative_bigint(
        v_evidence,
        'expected_enqueued_count'
      ) is null
      or private.monitoring_feedback_json_nonnegative_bigint(
        v_evidence,
        'expected_enqueued_count'
      )::numeric is distinct from v_canary_metadata_enqueued_count
      or v_canary_metadata_enqueued_count > v_canary_metadata_observation_count then
      v_failure := 'Expected and observed exact-cohort candidate counts must agree.';
    elsif pg_catalog.jsonb_typeof(v_evidence -> 'candidate_status_counts')
        is distinct from 'object'
      or private.monitoring_feedback_json_array_length(
        v_evidence,
        'candidate_terminal_failures'
      ) is distinct from 0::bigint then
      v_failure := 'Canary candidate readiness evidence is missing or has terminal failures.';
    elsif v_candidate_status_invalid_count <> 0
      or v_candidate_status_total is distinct from v_bound_candidate_count::numeric
      or v_nonterminal_candidate_count <> 0::numeric
      or v_evidence -> 'candidate_status_counts' is distinct from
        v_actual_candidate_status_counts then
      v_failure := 'Every exact-cohort candidate must have one safe terminal status.';
    -- A no-work cohort is explicitly valid only when the scheduled run metadata,
    -- durable observations, statuses, events, and bindings all consistently report zero.
    elsif v_observation_count is distinct from v_expected_candidate_count
      or v_observed_candidate_count is distinct from v_bound_candidate_count then
      v_failure := 'Durable run/candidate observations do not match the sealed canary cohort.';
    elsif v_bound_event_count is null
      or v_published_candidate_count > v_bound_event_count::numeric then
      v_failure := 'Every published canary candidate must retain a bound event.';
    elsif v_binding_count is distinct from v_bound_event_count
      or v_distinct_binding_event_count is distinct from v_binding_count
      or v_distinct_binding_candidate_count is distinct from v_binding_count
      or v_invalid_binding_count <> 0 then
      v_failure := 'Every retained canary event must be bound to one of the three selected runs.';
    elsif v_evidence ->> 'full_hash' is distinct from v_hashes ->> 'app_policy_hash'
      or v_evidence ->> 'batch_hash' is distinct from
        v_hashes ->> 'app_batch_policy_hash'
      or v_evidence ->> 'suppression_hash' is distinct from
        v_hashes ->> 'app_suppression_policy_hash'
      or v_evidence ->> 'matcher_digest' is distinct from
        v_hashes ->> 'app_matcher_digest'
      or v_evidence ->> 'matcher_digest' is distinct from
        v_cluster.stage_artifacts #>> '{rule_drafted,rule,matcher_digest}' then
      v_failure := 'The 6 PM canary did not run the verified policy and executable matcher.';
    elsif v_collision_count is null
      or v_collision_array_count is null
      or v_collision_count is distinct from v_collision_array_count then
      v_failure := 'The canary collision count and retained evidence list must agree.';
    elsif v_collision_count <> 0 then
      v_failure := 'The 6 PM canary would suppress a legitimate update.';
    end if;

  elsif v_to_stage = 'retroactive_sweep' then
    v_hashes := v_cluster.stage_artifacts -> 'app_worker_hashes_match';
    v_activation := v_evidence -> 'activation_attestation';

    -- The cluster row remains locked through this transition. Guarded sweep
    -- mutation also locks that row first, so this is the stable database truth
    -- until the stage change commits and later mutation attempts are rejected.
    select pg_catalog.max(change_event.suppressed_at)
    into v_live_sweep_mutation_at
    from public.shared_award_change_events change_event
    where change_event.suppression_source =
      'verified-promotion:' || v_cluster.id::text;

    if v_cluster.activation_status is distinct from 'armed' then
      v_failure := 'The activated sweep is not armed or late evidence blocked it.';
    elsif not private.monitoring_feedback_promotion_report_valid(
      v_evidence,
      'monitoring-promotion-retroactive-sweep-v1',
      v_cluster.cluster_key,
      v_cluster.proposed_rule_id,
      v_cluster.stage_artifacts #>> '{rule_drafted,draft_hash}'
    ) then
      v_failure := 'The activated sweep report envelope is invalid or targets another draft.';
    elsif v_evidence ->> 'status' is distinct from 'completed' then
      v_failure := 'The retroactive sweep did not complete.';
    elsif coalesce(v_evidence ->> 'completed_at', '') !~
        '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?Z$'
      or v_evidence ->> 'checkpoint_at' is distinct from
        v_evidence ->> 'completed_at' then
      v_failure := 'The retroactive sweep completion boundary is not its durable checkpoint time.';
    elsif nullif(pg_catalog.btrim(coalesce(v_evidence ->> 'last_mutation_at', '')), '')
        is not null
      and coalesce(v_evidence ->> 'last_mutation_at', '') !~
        '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?Z$' then
      v_failure := 'The durable sweep last-mutation timestamp is invalid.';
    elsif nullif(pg_catalog.btrim(coalesce(v_evidence ->> 'last_mutation_at', '')), '')
        is not null
      and (v_evidence ->> 'last_mutation_at')::timestamptz >=
        (v_evidence ->> 'checkpoint_at')::timestamptz then
      v_failure := 'The durable sweep checkpoint must be later than its last mutation.';
    elsif v_live_sweep_mutation_at is distinct from
        nullif(
          pg_catalog.btrim(coalesce(v_evidence ->> 'last_mutation_at', '')),
          ''
        )::timestamptz then
      v_failure := 'The final sweep report does not match the latest database mutation.';
    elsif coalesce(v_evidence ->> 'state_policy_hash', '') !~ '^[0-9a-f]{64}$'
      or v_evidence ->> 'sweep_key' not like
        'monitoring-feedback-promotion:' || v_cluster.id::text || ':%'
      or pg_catalog.jsonb_typeof(v_evidence -> 'cursor') is distinct from 'object'
      or not private.monitoring_feedback_json_boolean(
        v_evidence -> 'cursor',
        'end_of_history'
      )
      or pg_catalog.jsonb_typeof(
        v_evidence #> '{cursor,detected_at}'
      ) is distinct from 'null'
      or pg_catalog.jsonb_typeof(
        v_evidence #> '{cursor,event_id}'
      ) is distinct from 'null'
      or not exists (
        select 1
        from public.monitoring_policy_sweep_state sweep_state
        where sweep_state.sweep_key = v_evidence ->> 'sweep_key'
          and sweep_state.policy_hash = v_evidence ->> 'state_policy_hash'
          and sweep_state.updated_at =
            (v_evidence ->> 'checkpoint_at')::timestamptz
          and sweep_state.scanned_count =
            private.monitoring_feedback_json_nonnegative_bigint(
              v_evidence,
              'scanned_count'
            )
          and sweep_state.cursor_detected_at is null
          and sweep_state.cursor_event_id is null
      ) then
      v_failure := 'The final sweep report is not bound to its durable checkpoint row.';
    elsif not private.monitoring_feedback_json_boolean(v_evidence, 'rule_active') then
      v_failure := 'The retroactive sweep must attest that the verified candidate is now active.';
    elsif v_evidence ->> 'active_rule_definition_hash' is distinct from
      v_cluster.stage_artifacts #>> '{rule_drafted,draft_hash}' then
      v_failure := 'The activated rule definition differs from the immutable reviewed draft.';
    elsif not private.monitoring_feedback_promotion_report_valid(
      v_activation,
      'monitoring-promotion-hash-attestation-v1',
      v_cluster.cluster_key,
      v_cluster.proposed_rule_id,
      v_cluster.stage_artifacts #>> '{rule_drafted,draft_hash}'
    ) then
      v_failure := 'The post-activation hash attestation is missing or targets another draft.';
    elsif v_activation ->> 'status' is distinct from 'passed' then
      v_failure := 'The activated app and worker policy identities do not match.';
    elsif nullif(pg_catalog.btrim(coalesce(v_activation ->> 'app_revision', '')), '') is null
      or nullif(pg_catalog.btrim(coalesce(v_activation ->> 'worker_revision', '')), '') is null
      or pg_catalog.lower(v_activation ->> 'app_revision') = 'unavailable'
      or pg_catalog.lower(v_activation ->> 'worker_revision') = 'unavailable'
      or v_activation ->> 'app_revision' is distinct from
        v_activation ->> 'worker_revision' then
      v_failure := 'The activated app and worker must attest the same concrete revision.';
    elsif nullif(pg_catalog.btrim(coalesce(v_activation ->> 'app_policy_hash', '')), '') is null
      or nullif(pg_catalog.btrim(coalesce(v_activation ->> 'app_batch_policy_hash', '')), '') is null
      or nullif(pg_catalog.btrim(coalesce(v_activation ->> 'app_suppression_policy_hash', '')), '') is null
      or coalesce(v_activation ->> 'app_matcher_digest', '') !~ '^[0-9a-f]{64}$' then
      v_failure := 'The activated full, Batch, suppression, and matcher hashes are all required.';
    elsif v_activation ->> 'app_policy_hash' is distinct from
        v_activation ->> 'worker_policy_hash'
      or v_activation ->> 'app_batch_policy_hash' is distinct from
        v_activation ->> 'worker_batch_policy_hash'
      or v_activation ->> 'app_suppression_policy_hash' is distinct from
        v_activation ->> 'worker_suppression_policy_hash'
      or v_activation ->> 'app_matcher_digest' is distinct from
        v_activation ->> 'worker_matcher_digest' then
      v_failure := 'Activated app and worker revision, policy, and matcher hashes must match exactly.';
    elsif v_activation ->> 'app_matcher_digest' is distinct from
        v_hashes ->> 'app_matcher_digest'
      or v_activation ->> 'app_matcher_digest' is distinct from
        v_cluster.stage_artifacts #>> '{rule_drafted,rule,matcher_digest}' then
      v_failure := 'Activation changed the reviewed executable matcher.';
    elsif private.monitoring_feedback_json_array_length(
      v_activation,
      'comparisons'
    ) is distinct from 5::bigint
      or private.monitoring_feedback_json_array_length(
        v_activation,
        'worker_run_ids'
      ) is null
      or private.monitoring_feedback_json_array_length(
        v_activation,
        'worker_run_ids'
      ) < 1 then
      v_failure := 'The activated deployment requires five comparisons and a worker observation.';
    elsif not private.monitoring_feedback_worker_attestation_runs_valid(
      v_activation,
      (v_cluster.stage_artifacts #>> '{six_pm_canary,completed_at}')::timestamptz
    ) then
      v_failure := 'Activation attestation is not backed by later matching durable worker runs.';
    elsif v_activation ->> 'app_policy_hash' is not distinct from
        v_hashes ->> 'app_policy_hash'
      or v_activation ->> 'app_batch_policy_hash' is not distinct from
        v_hashes ->> 'app_batch_policy_hash'
      or v_activation ->> 'app_suppression_policy_hash' is not distinct from
        v_hashes ->> 'app_suppression_policy_hash' then
      v_failure := 'Activation must produce distinct full, Batch, and suppression policy hashes.';
    elsif v_evidence ->> 'policy_hash' is distinct from
        v_activation ->> 'app_suppression_policy_hash'
      or v_evidence ->> 'expected_policy_hash' is distinct from
        v_activation ->> 'app_suppression_policy_hash' then
      v_failure := 'The sweep did not use the activated suppression policy hash.';
    elsif not private.monitoring_feedback_json_boolean(v_evidence, 'cursor_complete')
      or pg_catalog.jsonb_typeof(v_evidence -> 'cursor') is distinct from 'object' then
      v_failure := 'The retroactive sweep and its durable cursor must be complete.';
    elsif private.monitoring_feedback_json_nonnegative_bigint(
      v_evidence,
      'error_count'
    ) is distinct from 0::bigint then
      v_failure := 'The retroactive sweep must complete with zero failures.';
    elsif private.monitoring_feedback_json_nonnegative_bigint(
      v_evidence,
      'scanned_count'
    ) is null
      or private.monitoring_feedback_json_nonnegative_bigint(
        v_evidence,
        'suppressed_count'
      ) is null then
      v_failure := 'Retroactive scan and suppression counts are required.';
    elsif nullif(pg_catalog.btrim(coalesce(v_evidence ->> 'sweep_run_id', '')), '') is null then
      v_failure := 'The retroactive sweep run identity is required.';
    end if;

  elsif v_to_stage = 'resolved' then
    v_shadow := v_cluster.stage_artifacts -> 'historical_shadow_test';
    v_hashes := v_cluster.stage_artifacts -> 'app_worker_hashes_match';
    v_retro := v_cluster.stage_artifacts -> 'retroactive_sweep';
    select pg_catalog.count(distinct transition.requested_stage)::integer
    into v_required_gate_count
    from public.monitoring_feedback_promotion_transitions transition
    where transition.cluster_id = v_cluster.id
      and transition.accepted
      and transition.evidence_revision = v_cluster.evidence_revision
      and transition.requested_stage in (
        'similar_feedback_clustered',
        'rule_drafted',
        'historical_shadow_test',
        'regression_tests_pass',
        'app_worker_hashes_match',
        'six_pm_canary',
        'retroactive_sweep'
      );

    if not private.monitoring_feedback_json_boolean(v_evidence, 'confirmed') then
      v_failure := 'Final resolution must be explicitly confirmed.';
    elsif v_required_gate_count <> 7 then
      v_failure := 'Every verified promotion gate must have an accepted audit transition.';
    elsif v_shadow ->> 'status' is distinct from 'passed'
      or private.monitoring_feedback_json_nonnegative_bigint(
        v_shadow,
        'legitimate_updates_suppressed'
      ) is distinct from 0::bigint then
      v_failure := 'Historical shadow verification is missing or has legitimate collisions.';
    elsif v_cluster.stage_artifacts #>> '{regression_tests_pass,status}'
      is distinct from 'passed' then
      v_failure := 'Passing regression evidence is missing.';
    elsif v_hashes ->> 'status' is distinct from 'passed'
      or private.monitoring_feedback_json_boolean(v_hashes, 'rule_active') then
      v_failure := 'Matching app and worker hash evidence is missing.';
    elsif v_cluster.stage_artifacts #>> '{six_pm_canary,status}'
      is distinct from 'passed'
      or private.monitoring_feedback_json_boolean(
        v_cluster.stage_artifacts -> 'six_pm_canary',
        'rule_active'
      ) then
      v_failure := 'Passing 6 PM canary evidence is missing.';
    elsif v_retro ->> 'status' is distinct from 'completed'
      or not private.monitoring_feedback_json_boolean(v_retro, 'rule_active')
      or not private.monitoring_feedback_json_boolean(v_retro, 'cursor_complete')
      or private.monitoring_feedback_json_nonnegative_bigint(
        v_retro,
        'error_count'
      ) is distinct from 0::bigint then
      v_failure := 'Completed retroactive sweep evidence is missing.';
    elsif v_rule_id is null or v_rule_id is distinct from v_cluster.proposed_rule_id then
      v_failure := 'Final resolution must use the immutable drafted rule ID.';
    elsif v_policy_identity is null
      or v_policy_version is null
      or v_policy_hash is null
      or p_policy_config_version is null
      or p_decision_memory_version is null then
      v_failure := 'Final policy identity, version, hash, and policy versions are required.';
    elsif coalesce(v_retro ->> 'completed_at', '') !~
        '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?Z$' then
      v_failure := 'The immutable retroactive sweep completion time is missing.';
    elsif v_evidence ->> 'cluster_id' is distinct from v_cluster.id::text
      or v_evidence ->> 'evidence_revision' is distinct from
        v_cluster.evidence_revision::text then
      v_failure := 'The final worker attestation belongs to a different cluster revision.';
    elsif nullif(pg_catalog.btrim(coalesce(v_evidence ->> 'app_revision', '')), '') is null
      or nullif(pg_catalog.btrim(coalesce(v_evidence ->> 'worker_revision', '')), '') is null
      or coalesce(v_evidence ->> 'app_policy_hash', '') !~ '^[0-9a-f]{64}$'
      or coalesce(v_evidence ->> 'worker_policy_hash', '') !~ '^[0-9a-f]{64}$'
      or coalesce(v_evidence ->> 'app_batch_policy_hash', '') !~ '^[0-9a-f]{64}$'
      or coalesce(v_evidence ->> 'worker_batch_policy_hash', '') !~ '^[0-9a-f]{64}$'
      or coalesce(v_evidence ->> 'app_suppression_policy_hash', '') !~ '^[0-9a-f]{64}$'
      or coalesce(v_evidence ->> 'worker_suppression_policy_hash', '') !~ '^[0-9a-f]{64}$'
      or coalesce(v_evidence ->> 'app_matcher_digest', '') !~ '^[0-9a-f]{64}$'
      or coalesce(v_evidence ->> 'worker_matcher_digest', '') !~ '^[0-9a-f]{64}$' then
      v_failure := 'Final app and worker revision, policy, and matcher identities are required.';
    elsif v_evidence ->> 'app_revision' is distinct from
        v_evidence ->> 'worker_revision'
      or v_evidence ->> 'app_policy_hash' is distinct from
        v_evidence ->> 'worker_policy_hash'
      or v_evidence ->> 'app_batch_policy_hash' is distinct from
        v_evidence ->> 'worker_batch_policy_hash'
      or v_evidence ->> 'app_suppression_policy_hash' is distinct from
        v_evidence ->> 'worker_suppression_policy_hash'
      or v_evidence ->> 'app_matcher_digest' is distinct from
        v_evidence ->> 'worker_matcher_digest' then
      v_failure := 'The final app and worker revision, policy, and matcher hashes must match exactly.';
    elsif v_policy_hash is distinct from v_evidence ->> 'app_policy_hash'
      or v_evidence ->> 'app_policy_hash' is distinct from
        v_retro #>> '{activation_attestation,app_policy_hash}'
      or v_evidence ->> 'app_revision' is distinct from
        v_retro #>> '{activation_attestation,app_revision}'
      or v_evidence ->> 'app_batch_policy_hash' is distinct from
        v_retro #>> '{activation_attestation,app_batch_policy_hash}'
      or v_evidence ->> 'app_suppression_policy_hash' is distinct from
        v_retro #>> '{activation_attestation,app_suppression_policy_hash}'
      or v_evidence ->> 'app_matcher_digest' is distinct from
        v_retro #>> '{activation_attestation,app_matcher_digest}' then
      v_failure := 'The app revision, policy set, or matcher drifted after the activated sweep.';
    elsif not private.monitoring_feedback_resolution_attestation_run_valid(
      v_evidence,
      v_cluster.id,
      v_cluster.evidence_revision,
      (v_retro ->> 'completed_at')::timestamptz
    ) then
      v_failure := 'Wait for the next successful matching hourly worker attestation completed after the retroactive sweep.';
    end if;
  end if;

  if v_failure is not null then
    insert into public.monitoring_feedback_promotion_transitions (
      id,
      request_id,
      cluster_id,
      from_stage,
      requested_stage,
      resulting_stage,
      accepted,
      evidence_revision,
      recurrence_count,
      failure_reason,
      actor_user_id,
      actor_email,
      policy_rule_id,
      policy_identity,
      policy_version,
      policy_hash,
      policy_config_version,
      decision_memory_version,
      evidence,
      note
    ) values (
      v_transition_id,
      p_request_id,
      v_cluster.id,
      v_cluster.current_stage,
      v_to_stage,
      v_cluster.current_stage,
      false,
      v_cluster.evidence_revision,
      v_recurrence_count,
      v_failure,
      p_actor_user_id,
      v_actor_email,
      v_rule_id,
      v_policy_identity,
      v_policy_version,
      v_policy_hash,
      p_policy_config_version,
      p_decision_memory_version,
      v_evidence,
      v_note
    );

    return query select
      v_transition_id,
      v_cluster.id,
      v_cluster.current_stage,
      v_cluster.current_stage,
      v_to_stage,
      false,
      false,
      v_failure,
      0,
      v_recurrence_count,
      v_cluster.evidence_revision;
    return;
  end if;

  if v_to_stage = 'resolved' then
    select pg_catalog.count(*)::bigint
    into v_unresolved_count
    from public.monitoring_feedback_promotion_cluster_members member
    join public.monitoring_feedback feedback
      on feedback.id = member.feedback_id
    where member.cluster_id = v_cluster.id
      and feedback.promotion_status = 'pending_review'
      and not exists (
        select 1
        from public.monitoring_feedback_promotions promotion
        where promotion.feedback_id = feedback.id
      );

    if v_unresolved_count < 1 then
      raise exception 'promotion cluster has no unresolved feedback rows'
        using errcode = 'P0001';
    end if;
  end if;

  insert into public.monitoring_feedback_promotion_transitions (
    id,
    request_id,
    cluster_id,
    from_stage,
    requested_stage,
    resulting_stage,
    accepted,
    evidence_revision,
    recurrence_count,
    actor_user_id,
    actor_email,
    policy_rule_id,
    policy_identity,
    policy_version,
    policy_hash,
    policy_config_version,
    decision_memory_version,
    evidence,
    note,
    promotion_count
  ) values (
    v_transition_id,
    p_request_id,
    v_cluster.id,
    v_cluster.current_stage,
    v_to_stage,
    v_to_stage,
    true,
    v_cluster.evidence_revision,
    v_recurrence_count,
    p_actor_user_id,
    v_actor_email,
    coalesce(v_rule_id, v_cluster.proposed_rule_id),
    v_policy_identity,
    v_policy_version,
    v_policy_hash,
    p_policy_config_version,
    p_decision_memory_version,
    v_evidence,
    v_note,
    case when v_to_stage = 'resolved' then v_unresolved_count::integer else 0 end
  );

  if v_to_stage = 'resolved' then
    insert into public.monitoring_feedback_promotions (
      request_id,
      feedback_id,
      actor_user_id,
      actor_email,
      policy_rule_id,
      policy_identity,
      policy_version,
      policy_hash,
      policy_config_version,
      decision_memory_version,
      note,
      promotion_cluster_id,
      promotion_transition_id
    )
    select
      gen_random_uuid(),
      feedback.id,
      p_actor_user_id,
      v_actor_email,
      v_cluster.proposed_rule_id,
      v_policy_identity,
      v_policy_version,
      v_policy_hash,
      p_policy_config_version,
      p_decision_memory_version,
      v_note,
      v_cluster.id,
      v_transition_id
    from public.monitoring_feedback_promotion_cluster_members member
    join public.monitoring_feedback feedback
      on feedback.id = member.feedback_id
    where member.cluster_id = v_cluster.id
      and feedback.promotion_status = 'pending_review'
      and not exists (
        select 1
        from public.monitoring_feedback_promotions promotion
        where promotion.feedback_id = feedback.id
      );

    get diagnostics v_inserted_count = row_count;
    if v_inserted_count <> v_unresolved_count then
      raise exception 'final promotion did not resolve every cluster member'
        using errcode = '40001';
    end if;
  end if;

  update public.monitoring_feedback_promotion_clusters cluster
  set
    current_stage = v_to_stage,
    proposed_rule_id = case
      when v_to_stage = 'rule_drafted' then v_rule_id
      else cluster.proposed_rule_id
    end,
    stage_artifacts = cluster.stage_artifacts ||
      pg_catalog.jsonb_build_object(v_to_stage, v_evidence),
    activation_status = case
      when v_to_stage = 'six_pm_canary' then 'armed'
      when v_to_stage = 'retroactive_sweep' then 'sweep_completed'
      else cluster.activation_status
    end,
    activation_blocked_at = case
      when v_to_stage in ('six_pm_canary', 'retroactive_sweep', 'resolved') then null
      else cluster.activation_blocked_at
    end,
    updated_at = pg_catalog.clock_timestamp(),
    resolved_at = case
      when v_to_stage = 'resolved' then pg_catalog.clock_timestamp()
      else null
    end
  where cluster.id = v_cluster.id;

  return query select
    v_transition_id,
    v_cluster.id,
    v_cluster.current_stage,
    v_to_stage,
    v_to_stage,
    true,
    true,
    null::text,
    v_inserted_count,
    v_recurrence_count,
    v_cluster.evidence_revision;
end;
$function$;

revoke all on function private.monitoring_feedback_promotion_stage_ordinal(text)
  from public, anon, authenticated, service_role;
revoke all on function private.monitoring_feedback_promotion_next_stage(text)
  from public, anon, authenticated, service_role;
revoke all on function private.monitoring_feedback_json_boolean(jsonb, text)
  from public, anon, authenticated, service_role;
revoke all on function private.monitoring_feedback_json_nonnegative_bigint(jsonb, text)
  from public, anon, authenticated, service_role;
revoke all on function private.monitoring_feedback_json_array_length(jsonb, text)
  from public, anon, authenticated, service_role;
revoke all on function private.monitoring_feedback_sorted_unique_uuid_array_valid(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function private.monitoring_feedback_worker_attestation_runs_valid(jsonb, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function private.find_monitoring_feedback_resolution_worker_run(
  uuid,
  bigint,
  timestamptz,
  text,
  text,
  text,
  text,
  text
) from public, anon, authenticated, service_role;
revoke all on function private.monitoring_feedback_resolution_attestation_run_valid(
  jsonb,
  uuid,
  bigint,
  timestamptz
) from public, anon, authenticated, service_role;
revoke all on function private.monitoring_feedback_canonical_json(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function private.monitoring_feedback_promotion_report_valid(
  jsonb,
  text,
  text,
  text,
  text
) from public, anon, authenticated, service_role;
revoke all on function private.monitoring_feedback_normalize_pattern_text(text)
  from public, anon, authenticated, service_role;
revoke all on function private.monitoring_feedback_sorted_pattern_text_array(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function private.monitoring_feedback_json_pattern_shape(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function private.monitoring_feedback_pattern_signature(
  jsonb,
  text,
  text,
  text,
  jsonb
) from public, anon, authenticated, service_role;
revoke all on function private.monitoring_feedback_domain_template(text, text)
  from public, anon, authenticated, service_role;
revoke all on function private.sync_monitoring_feedback_promotion_clusters()
  from public, anon, authenticated, service_role;
revoke all on function private.sync_monitoring_feedback_promotion_clusters_after_insert()
  from public, anon, authenticated, service_role;
revoke all on function private.protect_monitoring_feedback_promotion_cluster()
  from public, anon, authenticated, service_role;

revoke execute on function public.list_monitoring_feedback_promotion_clusters(integer, boolean)
  from public, anon, authenticated;
grant execute on function public.list_monitoring_feedback_promotion_clusters(integer, boolean)
  to service_role;

revoke execute on function public.list_monitoring_feedback_promotion_worker_queue(integer)
  from public, anon, authenticated;
grant execute on function public.list_monitoring_feedback_promotion_worker_queue(integer)
  to service_role;

revoke execute on function public.list_unresolved_monitoring_feedback_promotion_rule_ids()
  from public, anon, authenticated;
grant execute on function public.list_unresolved_monitoring_feedback_promotion_rule_ids()
  to service_role;

revoke execute on function public.get_monitoring_feedback_promotion_cluster(uuid)
  from public, anon, authenticated;
grant execute on function public.get_monitoring_feedback_promotion_cluster(uuid)
  to service_role;

revoke execute on function public.list_monitoring_feedback_promotion_cluster_evidence(uuid)
  from public, anon, authenticated;
grant execute on function public.list_monitoring_feedback_promotion_cluster_evidence(uuid)
  to service_role;

revoke execute on function public.record_monitoring_feedback_promotion_worker_failure(
  uuid,
  uuid,
  bigint,
  text,
  text,
  uuid,
  text,
  text,
  jsonb,
  text,
  text
) from public, anon, authenticated;
grant execute on function public.record_monitoring_feedback_promotion_worker_failure(
  uuid,
  uuid,
  bigint,
  text,
  text,
  uuid,
  text,
  text,
  jsonb,
  text,
  text
) to service_role;

revoke execute on function public.apply_monitoring_feedback_promotion_sweep_event(
  uuid,
  bigint,
  text,
  uuid,
  timestamptz,
  text
) from public, anon, authenticated;
grant execute on function public.apply_monitoring_feedback_promotion_sweep_event(
  uuid,
  bigint,
  text,
  uuid,
  timestamptz,
  text
) to service_role;

revoke execute on function public.checkpoint_monitoring_feedback_promotion_sweep(
  uuid,
  bigint,
  text,
  text,
  text,
  timestamptz,
  uuid,
  bigint,
  timestamptz,
  timestamptz
) from public, anon, authenticated;
grant execute on function public.checkpoint_monitoring_feedback_promotion_sweep(
  uuid,
  bigint,
  text,
  text,
  text,
  timestamptz,
  uuid,
  bigint,
  timestamptz,
  timestamptz
) to service_role;

revoke execute on function public.mark_monitoring_feedback_promotion_rollback_required(
  uuid,
  uuid,
  bigint,
  uuid,
  text,
  text,
  jsonb,
  text
) from public, anon, authenticated;
grant execute on function public.mark_monitoring_feedback_promotion_rollback_required(
  uuid,
  uuid,
  bigint,
  uuid,
  text,
  text,
  jsonb,
  text
) to service_role;

revoke execute on function public.revert_monitoring_feedback_promotion_sweep_events(
  uuid,
  uuid,
  bigint,
  jsonb
) from public, anon, authenticated;
grant execute on function public.revert_monitoring_feedback_promotion_sweep_events(
  uuid,
  uuid,
  bigint,
  jsonb
) to service_role;

revoke execute on function public.rollback_monitoring_feedback_promotion_activation(
  uuid,
  uuid,
  bigint,
  uuid,
  text,
  jsonb,
  text
) from public, anon, authenticated;
grant execute on function public.rollback_monitoring_feedback_promotion_activation(
  uuid,
  uuid,
  bigint,
  uuid,
  text,
  jsonb,
  text
) to service_role;

revoke execute on function public.restart_monitoring_feedback_promotion_cluster(
  uuid,
  uuid,
  bigint,
  uuid,
  text,
  text
) from public, anon, authenticated;
grant execute on function public.restart_monitoring_feedback_promotion_cluster(
  uuid,
  uuid,
  bigint,
  uuid,
  text,
  text
) to service_role;

revoke execute on function public.advance_monitoring_feedback_promotion_cluster(
  uuid,
  uuid,
  bigint,
  text,
  uuid,
  text,
  jsonb,
  text,
  text,
  text,
  text,
  integer,
  integer,
  text
) from public, anon, authenticated;

revoke execute on function public.find_monitoring_feedback_resolution_worker_run(
  uuid,
  bigint,
  timestamptz,
  text,
  text,
  text,
  text,
  text
) from public, anon, authenticated;
grant execute on function public.find_monitoring_feedback_resolution_worker_run(
  uuid,
  bigint,
  timestamptz,
  text,
  text,
  text,
  text,
  text
) to service_role;

revoke execute on function public.replay_monitoring_feedback_promotion_resolution(
  uuid,
  uuid,
  bigint,
  uuid,
  text,
  text
) from public, anon, authenticated;
grant execute on function public.replay_monitoring_feedback_promotion_resolution(
  uuid,
  uuid,
  bigint,
  uuid,
  text,
  text
) to service_role;

grant execute on function public.advance_monitoring_feedback_promotion_cluster(
  uuid,
  uuid,
  bigint,
  text,
  uuid,
  text,
  jsonb,
  text,
  text,
  text,
  text,
  integer,
  integer,
  text
) to service_role;

notify pgrst, 'reload schema';
