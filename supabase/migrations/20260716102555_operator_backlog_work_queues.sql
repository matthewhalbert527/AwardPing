-- Replace capped operator lists with an exact, clustered, paginated backlog.
-- All mutation contracts are service-role-only and intentionally exclude retry
-- and resolution actions so a bulk operation can never create an API charge or
-- silently clear evidence-bound work.

create table public.manual_quarantine_operator_assignments (
  quarantine_id uuid primary key
    references public.manual_quarantine_registry(id) on delete cascade,
  assigned_to_user_id uuid not null references auth.users(id) on delete cascade,
  assigned_to_email text not null check (
    char_length(assigned_to_email) <= 320
    and assigned_to_email = lower(btrim(assigned_to_email))
    and assigned_to_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  ),
  assigned_by_user_id uuid references auth.users(id) on delete set null,
  assigned_by_email text not null check (
    char_length(assigned_by_email) <= 320
    and assigned_by_email = lower(btrim(assigned_by_email))
    and assigned_by_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  ),
  assigned_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index manual_quarantine_operator_assignments_owner_idx
  on public.manual_quarantine_operator_assignments (
    assigned_to_email,
    assigned_at,
    quarantine_id
  );

create index manual_quarantine_operator_assignments_assigned_user_idx
  on public.manual_quarantine_operator_assignments (assigned_to_user_id);

create index manual_quarantine_operator_assignments_assigned_by_idx
  on public.manual_quarantine_operator_assignments (assigned_by_user_id)
  where assigned_by_user_id is not null;

create table public.manual_quarantine_saved_views (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  user_email text not null check (
    char_length(user_email) <= 320
    and user_email = lower(btrim(user_email))
    and user_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  ),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  name_key text generated always as (lower(btrim(name))) stored,
  filters jsonb not null default '{}'::jsonb check (
    jsonb_typeof(filters) = 'object'
    and pg_catalog.octet_length(filters::text) <= 65536
  ),
  group_by text not null default 'repair_group' check (
    group_by in (
      'repair_group',
      'domain',
      'evidence_failure',
      'policy_reason',
      'likely_repair'
    )
  ),
  sort_key text not null default 'oldest' check (
    sort_key in ('oldest', 'newest', 'priority', 'domain')
  ),
  page_size integer not null default 25 check (page_size between 10 and 100),
  view_version text not null default 'manual-quarantine-view-v1',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, name_key)
);

create index manual_quarantine_saved_views_user_idx
  on public.manual_quarantine_saved_views (user_id, updated_at desc, id);

create table public.manual_quarantine_operator_action_events (
  id bigint generated always as identity primary key,
  request_id uuid not null,
  quarantine_id uuid not null
    references public.manual_quarantine_registry(id) on delete restrict,
  action text not null check (
    action in ('assign_to_me', 'unassign', 'start_review')
  ),
  actor_user_id uuid references auth.users(id) on delete set null,
  actor_email text not null check (
    char_length(actor_email) <= 320
    and actor_email = lower(btrim(actor_email))
    and actor_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  ),
  previous_status text not null check (
    previous_status in ('quarantined', 'in_review')
  ),
  next_status text not null check (
    next_status in ('quarantined', 'in_review')
  ),
  previous_assignee_email text check (
    previous_assignee_email is null
    or (
      char_length(previous_assignee_email) <= 320
      and previous_assignee_email = lower(btrim(previous_assignee_email))
      and previous_assignee_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    )
  ),
  next_assignee_email text check (
    next_assignee_email is null
    or (
      char_length(next_assignee_email) <= 320
      and next_assignee_email = lower(btrim(next_assignee_email))
      and next_assignee_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    )
  ),
  selection_hash text not null check (selection_hash ~ '^[0-9a-f]{64}$'),
  changed boolean not null,
  metadata jsonb not null default '{}'::jsonb check (
    jsonb_typeof(metadata) = 'object'
    and pg_catalog.octet_length(metadata::text) <= 65536
  ),
  created_at timestamptz not null default now(),
  unique (request_id, quarantine_id)
);

create table public.manual_quarantine_backlog_state (
  state_key text primary key check (state_key = 'operator_backlog'),
  revision bigint not null default 1 check (revision > 0),
  updated_at timestamptz not null default now()
);

insert into public.manual_quarantine_backlog_state (state_key, revision)
values ('operator_backlog', 1);

create index manual_quarantine_operator_action_events_case_idx
  on public.manual_quarantine_operator_action_events (
    quarantine_id,
    created_at desc,
    id desc
  );

create index manual_quarantine_operator_action_events_actor_idx
  on public.manual_quarantine_operator_action_events (actor_user_id)
  where actor_user_id is not null;

alter table public.manual_quarantine_operator_assignments enable row level security;
alter table public.manual_quarantine_saved_views enable row level security;
alter table public.manual_quarantine_operator_action_events enable row level security;
alter table public.manual_quarantine_backlog_state enable row level security;

revoke all on table public.manual_quarantine_operator_assignments
  from public, anon, authenticated, service_role;
revoke all on table public.manual_quarantine_saved_views
  from public, anon, authenticated, service_role;
revoke all on table public.manual_quarantine_operator_action_events
  from public, anon, authenticated, service_role;
revoke all on table public.manual_quarantine_backlog_state
  from public, anon, authenticated, service_role;
grant select, insert, update, delete
  on table public.manual_quarantine_operator_assignments to service_role;
grant select, insert, update, delete
  on table public.manual_quarantine_saved_views to service_role;
grant select, insert on table public.manual_quarantine_operator_action_events
  to service_role;
grant select on table public.manual_quarantine_backlog_state to service_role;
revoke all on sequence public.manual_quarantine_operator_action_events_id_seq
  from public, anon, authenticated, service_role;
grant usage, select on sequence public.manual_quarantine_operator_action_events_id_seq
  to service_role;

create or replace function public.bump_manual_quarantine_backlog_revision()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.manual_quarantine_backlog_state as state (
    state_key,
    revision,
    updated_at
  ) values (
    'operator_backlog',
    1,
    pg_catalog.clock_timestamp()
  )
  on conflict (state_key) do update set
    revision = state.revision + 1,
    updated_at = excluded.updated_at;
  return null;
end;
$$;

revoke all on function public.bump_manual_quarantine_backlog_revision()
  from public, anon, authenticated, service_role;

create or replace function public.return_unowned_manual_quarantine_to_queue()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- This also runs for the assignment FK's auth-user delete cascade. Keeping the
  -- update inside that transaction makes owner deletion fail closed if the case
  -- cannot be returned to the queue.
  update public.manual_quarantine_registry registry
  set status = 'quarantined'
  where registry.id = old.quarantine_id
    and registry.requires_action
    and registry.status = 'in_review';
  return old;
end;
$$;

revoke all on function public.return_unowned_manual_quarantine_to_queue()
  from public, anon, authenticated, service_role;

create trigger touch_manual_quarantine_operator_assignments
before update on public.manual_quarantine_operator_assignments
for each row execute function public.touch_manual_quarantine_registry();

create trigger return_unowned_manual_quarantine_to_queue
after delete on public.manual_quarantine_operator_assignments
for each row execute function public.return_unowned_manual_quarantine_to_queue();

create trigger bump_manual_quarantine_backlog_after_assignment_mutation
after insert or update or delete on public.manual_quarantine_operator_assignments
for each statement execute function public.bump_manual_quarantine_backlog_revision();

create trigger bump_manual_quarantine_backlog_after_registry_mutation
after insert or update or delete on public.manual_quarantine_registry
for each statement execute function public.bump_manual_quarantine_backlog_revision();

-- These live join fields affect source-domain clustering, filtering, search,
-- or display copy even when the quarantine registry row itself is unchanged.
create trigger bump_manual_quarantine_backlog_after_source_join_update
after update of url
on public.shared_award_sources
for each statement execute function public.bump_manual_quarantine_backlog_revision();

create trigger bump_manual_quarantine_backlog_after_candidate_source_update
after update of source_url
on public.shared_award_visual_review_candidates
for each statement execute function public.bump_manual_quarantine_backlog_revision();

create trigger bump_manual_quarantine_backlog_after_award_join_update
after update of name, slug, official_homepage
on public.shared_awards
for each statement execute function public.bump_manual_quarantine_backlog_revision();

create trigger touch_manual_quarantine_saved_views
before update on public.manual_quarantine_saved_views
for each row execute function public.touch_manual_quarantine_registry();

create or replace function public.manual_quarantine_source_domain(p_url text)
returns text
language sql
immutable
strict
parallel safe
security invoker
set search_path = ''
as $$
  with without_scheme as (
    select pg_catalog.regexp_replace(
      pg_catalog.btrim(p_url),
      '^[a-z][a-z0-9+.-]*://',
      '',
      'i'
    ) as value
  ),
  without_protocol_relative_prefix as (
    select pg_catalog.regexp_replace(value, '^//', '') as value
    from without_scheme
  ),
  authority as (
    select pg_catalog.split_part(
      pg_catalog.split_part(
        pg_catalog.split_part(value, '/', 1),
        '?',
        1
      ),
      '#',
      1
    ) as value
    from without_protocol_relative_prefix
  ),
  host as (
    select pg_catalog.regexp_replace(value, '^.*@', '') as value
    from authority
  )
  select nullif(
    pg_catalog.regexp_replace(
      pg_catalog.regexp_replace(
        pg_catalog.lower(
          pg_catalog.regexp_replace(value, ':[0-9]+$', '')
        ),
        '^www\.',
        '',
        'i'
      ),
      '[.]$',
      ''
    ),
    ''
  )
  from host;
$$;

create or replace function public.manual_quarantine_evidence_failure_code(
  p_category text,
  p_reason_code text
)
returns text
language sql
immutable
parallel safe
security invoker
set search_path = ''
as $$
  select case
    when p_category = 'visual_review'
      and lower(coalesce(p_reason_code, '')) like 'invalid_ai_json:%'
      then 'invalid_ai_json'
    when p_category = 'visual_review'
      and lower(coalesce(p_reason_code, '')) =
        'manual_recovery_required_possible_external_batch_created'
      then 'possible_external_batch'
    when coalesce(nullif(btrim(p_reason_code), ''), '') <> '' then
      btrim(
        pg_catalog.regexp_replace(
          lower(p_reason_code),
          '[^a-z0-9]+',
          '_',
          'g'
        ),
        '_'
      )
    when p_category = 'visual_review' then 'visual_review_terminal_failure'
    else 'unknown_evidence_failure'
  end;
$$;

create or replace function public.manual_quarantine_policy_reason_code(
  p_category text,
  p_public_impact text
)
returns text
language sql
immutable
parallel safe
security invoker
set search_path = ''
as $$
  select case
    when p_public_impact = 'protected' then 'last_known_good_protection'
    when p_category = 'visual_review' and p_public_impact = 'delayed'
      then 'changed_page_publication_hold'
    when p_public_impact = 'blocked' then 'unsafe_publication_blocked'
    when p_public_impact = 'unknown' then 'public_impact_verification'
    when p_public_impact = 'none' then 'evidence_retention_only'
    else 'operator_policy_review'
  end;
$$;

create or replace function public.manual_quarantine_likely_repair_code(
  p_category text,
  p_reason_code text
)
returns text
language sql
immutable
parallel safe
security invoker
set search_path = ''
as $$
  select case
    when p_category = 'visual_review'
      and lower(coalesce(p_reason_code, '')) =
        'manual_recovery_required_possible_external_batch_created'
      then 'reconcile_existing_paid_batch'
    when p_category = 'visual_review'
      and lower(coalesce(p_reason_code, '')) like 'invalid_ai_json:%'
      then 'inspect_invalid_visual_review_result'
    when p_category = 'visual_review'
      then 'inspect_visual_evidence_before_paid_retry'
    when p_reason_code = 'latest_reconciliation_failed'
      then 'repair_award_then_reconcile'
    when p_reason_code in (
      'latest_page_audit_requires_review',
      'page_audit_retry_limit_reached'
    ) then 'repair_page_evidence_then_audit'
    else 'inspect_evidence_then_repair_one_case'
  end;
$$;

revoke all on function public.manual_quarantine_source_domain(text)
  from public, anon, authenticated, service_role;
revoke all on function public.manual_quarantine_evidence_failure_code(text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.manual_quarantine_policy_reason_code(text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.manual_quarantine_likely_repair_code(text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.manual_quarantine_source_domain(text)
  to service_role;
grant execute on function public.manual_quarantine_evidence_failure_code(text, text)
  to service_role;
grant execute on function public.manual_quarantine_policy_reason_code(text, text)
  to service_role;
grant execute on function public.manual_quarantine_likely_repair_code(text, text)
  to service_role;

create or replace function public.list_manual_quarantine_backlog(
  p_page integer default 1,
  p_page_size integer default 25,
  p_cluster_page integer default 1,
  p_cluster_page_size integer default 12,
  p_group_by text default 'repair_group',
  p_sort text default 'oldest',
  p_domains text[] default null,
  p_evidence_failures text[] default null,
  p_policy_reasons text[] default null,
  p_repairs text[] default null,
  p_owners text[] default null,
  p_statuses text[] default null,
  p_age_bucket text default null,
  p_search text default null,
  p_expected_synced_at timestamptz default null,
  p_expected_revision bigint default null,
  p_as_of_at timestamptz default null
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_now timestamptz := statement_timestamp();
  v_as_of_at timestamptz := coalesce(p_as_of_at, v_now);
  v_page integer := greatest(1, coalesce(p_page, 1));
  v_page_size integer := least(100, greatest(10, coalesce(p_page_size, 25)));
  v_cluster_page integer := greatest(1, coalesce(p_cluster_page, 1));
  v_cluster_page_size integer := least(
    48,
    greatest(6, coalesce(p_cluster_page_size, 12))
  );
  v_group_by text := case
    when p_group_by in (
      'repair_group',
      'domain',
      'evidence_failure',
      'policy_reason',
      'likely_repair'
    )
      then p_group_by
    else 'repair_group'
  end;
  v_sort text := case
    when p_sort in ('oldest', 'newest', 'priority', 'domain') then p_sort
    else 'oldest'
  end;
  v_registry_state_total bigint;
  v_registry_synced_at timestamptz;
  v_backlog_revision bigint;
begin
  if p_group_by is null or p_group_by not in (
    'repair_group',
    'domain',
    'evidence_failure',
    'policy_reason',
    'likely_repair'
  ) then
    raise exception using
      errcode = '22023',
      message = 'Unknown manual-quarantine grouping.';
  end if;
  if p_sort is null or p_sort not in ('oldest', 'newest', 'priority', 'domain') then
    raise exception using
      errcode = '22023',
      message = 'Unknown manual-quarantine sort.';
  end if;
  if p_age_bucket is not null and p_age_bucket not in (
    'under_24h',
    'one_to_three_days',
    'four_to_seven_days',
    'eight_to_thirty_days',
    'over_thirty_days'
  ) then
    raise exception using
      errcode = '22023',
      message = 'Unknown manual-quarantine age bucket.';
  end if;
  if greatest(
    coalesce(cardinality(p_domains), 0),
    coalesce(cardinality(p_evidence_failures), 0),
    coalesce(cardinality(p_policy_reasons), 0),
    coalesce(cardinality(p_repairs), 0),
    coalesce(cardinality(p_owners), 0),
    coalesce(cardinality(p_statuses), 0)
  ) > 20 then
    raise exception using
      errcode = '22023',
      message = 'Manual-quarantine filters accept at most 20 values per facet.';
  end if;
  if exists (
    select 1
    from (
      select unnest(coalesce(p_domains, '{}'::text[])) as value
      union all
      select unnest(coalesce(p_evidence_failures, '{}'::text[]))
      union all
      select unnest(coalesce(p_policy_reasons, '{}'::text[]))
      union all
      select unnest(coalesce(p_repairs, '{}'::text[]))
      union all
      select unnest(coalesce(p_owners, '{}'::text[]))
    ) requested
    where requested.value is null
      or pg_catalog.char_length(pg_catalog.btrim(requested.value)) not between 1 and 320
  ) then
    raise exception using
      errcode = '22023',
      message = 'Manual-quarantine filter values must be 1–320 characters.';
  end if;
  if exists (
    select 1
    from unnest(coalesce(p_statuses, '{}'::text[])) requested(status)
    where requested.status is null
      or requested.status not in ('quarantined', 'in_review')
  ) then
    raise exception using
      errcode = '22023',
      message = 'Unknown manual-quarantine status filter.';
  end if;
  if pg_catalog.char_length(pg_catalog.btrim(coalesce(p_search, ''))) > 160 then
    raise exception using
      errcode = '22023',
      message = 'Manual-quarantine search is limited to 160 characters.';
  end if;
  if p_expected_revision is not null and p_expected_revision <= 0 then
    raise exception using
      errcode = '22023',
      message = 'Manual-quarantine backlog revision must be positive.';
  end if;
  if not pg_catalog.isfinite(v_as_of_at)
    or v_as_of_at > v_now + interval '5 minutes' then
    raise exception using
      errcode = '22023',
      message = 'Manual-quarantine as-of time must be finite and no more than five minutes in the future.';
  end if;

  select state.quarantined_work_remaining, state.last_synced_at
  into v_registry_state_total, v_registry_synced_at
  from public.manual_quarantine_registry_state state
  where state.registry_key = 'one_time_catchup';

  select state.revision
  into v_backlog_revision
  from public.manual_quarantine_backlog_state state
  where state.state_key = 'operator_backlog';

  if v_backlog_revision is null then
    raise exception using
      errcode = '55000',
      message = 'The manual-quarantine backlog revision is not initialized.';
  end if;
  if p_expected_revision is not null
    and v_backlog_revision is distinct from p_expected_revision then
    raise exception using
      errcode = '40001',
      message = 'The quarantine backlog changed while this page was open. Refresh before paging or acting.';
  end if;

  if p_expected_synced_at is not null
    and v_registry_synced_at is distinct from p_expected_synced_at then
    raise exception using
      errcode = '40001',
      message = 'The quarantine registry changed while this backlog was open. Refresh before paging or acting.';
  end if;

  return (
    with normalized as (
      select
        registry.id,
        registry.quarantine_key,
        registry.case_key,
        registry.category,
        registry.status,
        registry.terminal,
        registry.terminal_failure_count,
        registry.severity,
        registry.public_impact,
        registry.owner as functional_owner,
        registry.retry_mode,
        registry.retry_charge,
        registry.title,
        registry.reason_code,
        registry.reason,
        registry.recommended_action,
        registry.shared_award_id,
        registry.shared_award_source_id,
        registry.visual_review_candidate_id,
        registry.evidence_record_count,
        registry.evidence_hash,
        registry.policy_id,
        registry.policy_version,
        registry.policy_hash,
        registry.first_observed_at,
        registry.last_observed_at,
        registry.updated_at,
        award.name as award_name,
        award.slug as award_slug,
        coalesce(
          nullif(visual_candidate.source_url, ''),
          nullif(source.url, ''),
          nullif(award.official_homepage, ''),
          nullif(registry.evidence #>> '{award,official_homepage}', '')
        ) as source_url,
        case
          when nullif(visual_candidate.source_url, '') is not null
            then 'event_specific_source'
          when nullif(source.url, '') is not null then 'current_source'
          when coalesce(
            nullif(award.official_homepage, ''),
            nullif(registry.evidence #>> '{award,official_homepage}', '')
          ) is not null
            then 'award_homepage_fallback'
          else 'unknown'
        end as source_domain_basis,
        coalesce(
          public.manual_quarantine_source_domain(
            coalesce(
              nullif(visual_candidate.source_url, ''),
              nullif(source.url, ''),
              nullif(award.official_homepage, ''),
              nullif(registry.evidence #>> '{award,official_homepage}', '')
            )
          ),
          'unknown-domain'
        ) as source_domain,
        public.manual_quarantine_evidence_failure_code(
          registry.category,
          registry.reason_code
        ) as evidence_failure_code,
        public.manual_quarantine_policy_reason_code(
          registry.category,
          registry.public_impact
        ) as policy_reason_kind,
        concat_ws(
          ':',
          registry.policy_id,
          registry.policy_version,
          public.manual_quarantine_policy_reason_code(
            registry.category,
            registry.public_impact
          )
        ) as policy_reason_code,
        public.manual_quarantine_likely_repair_code(
          registry.category,
          registry.reason_code
        ) as likely_repair_code,
        assignment.assigned_to_user_id,
        assignment.assigned_to_email,
        assignment.assigned_at,
        coalesce(assignment.assigned_to_email, 'unassigned') as owner_key,
        greatest(
          0,
          floor(
            extract(epoch from (v_as_of_at - registry.first_observed_at)) / 86400
          )::integer
        ) as age_days,
        case
          when v_as_of_at - registry.first_observed_at < interval '24 hours'
            then 'under_24h'
          when v_as_of_at - registry.first_observed_at < interval '4 days'
            then 'one_to_three_days'
          when v_as_of_at - registry.first_observed_at < interval '8 days'
            then 'four_to_seven_days'
          when v_as_of_at - registry.first_observed_at < interval '31 days'
            then 'eight_to_thirty_days'
          else 'over_thirty_days'
        end as age_bucket
      from public.manual_quarantine_registry registry
      left join public.manual_quarantine_operator_assignments assignment
        on assignment.quarantine_id = registry.id
      left join public.shared_award_visual_review_candidates visual_candidate
        on visual_candidate.id = registry.visual_review_candidate_id
      left join public.shared_award_sources source
        on source.id = registry.shared_award_source_id
      left join public.shared_awards award
        on award.id = registry.shared_award_id
      where registry.requires_action
        and registry.status in ('quarantined', 'in_review')
    ),
    labeled as (
      select
        normalized.*,
        case normalized.evidence_failure_code
          when 'latest_reconciliation_failed' then 'Latest reconciliation failed'
          when 'latest_page_audit_requires_review' then 'Page audit needs review'
          when 'page_audit_retry_limit_reached' then 'Deterministic page audit retry limit'
          when 'invalid_ai_json' then 'Changed-page review returned invalid JSON'
          when 'possible_external_batch' then 'A paid batch may already exist'
          when 'visual_review_terminal_failure' then 'Changed-page review reached a terminal failure'
          when 'unknown_evidence_failure' then 'Evidence failure needs classification'
          else initcap(replace(normalized.evidence_failure_code, '_', ' '))
        end as evidence_failure_label,
        (
          case normalized.policy_reason_kind
          when 'last_known_good_protection' then 'Keep last-known-good public facts'
          when 'changed_page_publication_hold' then 'Hold the changed update until evidence is verified'
          when 'unsafe_publication_blocked' then 'Block an unsafe public update'
          when 'public_impact_verification' then 'Verify public impact before changing facts'
          when 'evidence_retention_only' then 'Retain evidence without a public change'
          else 'Operator policy review'
          end
        ) || ' · ' || normalized.policy_id || ' v' || normalized.policy_version
          as policy_reason_label,
        case normalized.likely_repair_code
          when 'reconcile_existing_paid_batch' then 'Reconcile the existing paid batch before any retry'
          when 'inspect_invalid_visual_review_result' then 'Inspect the invalid AI result before any paid retry'
          when 'inspect_visual_evidence_before_paid_retry' then 'Inspect immutable evidence before any paid retry'
          when 'repair_award_then_reconcile' then 'Repair award data, then rerun no-cost reconciliation'
          when 'repair_page_evidence_then_audit' then 'Repair page evidence, then confirm cost before rerunning the audit'
          else 'Inspect evidence, then repair this one case'
        end as likely_repair_label
      from normalized
    ),
    filtered as (
      select *
      from labeled
      where (
          coalesce(cardinality(p_domains), 0) = 0
          or source_domain = any(p_domains)
        )
        and (
          coalesce(cardinality(p_evidence_failures), 0) = 0
          or evidence_failure_code = any(p_evidence_failures)
        )
        and (
          coalesce(cardinality(p_policy_reasons), 0) = 0
          or policy_reason_code = any(p_policy_reasons)
        )
        and (
          coalesce(cardinality(p_repairs), 0) = 0
          or likely_repair_code = any(p_repairs)
        )
        and (
          coalesce(cardinality(p_owners), 0) = 0
          or owner_key = any(p_owners)
        )
        and (
          coalesce(cardinality(p_statuses), 0) = 0
          or status = any(p_statuses)
        )
        and (p_age_bucket is null or age_bucket = p_age_bucket)
        and (
          nullif(btrim(coalesce(p_search, '')), '') is null
          or position(
            lower(btrim(p_search)) in lower(
              concat_ws(
                ' ',
                title,
                award_name,
                source_domain,
                evidence_failure_label,
                policy_reason_label,
                likely_repair_label,
                reason,
                assigned_to_email,
                functional_owner
              )
            )
          ) > 0
        )
    ),
    totals as (
      select
        count(*)::bigint as exact_total,
        coalesce(sum(evidence_record_count), 0)::bigint as evidence_records,
        count(*) filter (where terminal)::bigint as terminal_cases,
        count(*) filter (where assigned_to_email is null)::bigint as unassigned_cases,
        count(*) filter (where retry_charge <> 'none')::bigint as charge_gated_cases,
        min(first_observed_at) as oldest_observed_at
      from filtered
    ),
    page_meta as (
      select
        totals.*,
        greatest(
          1,
          ceil(totals.exact_total::numeric / v_page_size)::integer
        ) as page_count,
        least(
          v_page,
          greatest(
            1,
            ceil(totals.exact_total::numeric / v_page_size)::integer
          )
        ) as current_page
      from totals
    ),
    ordered_items as (
      select filtered.*
      from filtered
      order by
        case when v_sort = 'oldest' then first_observed_at end asc,
        case when v_sort = 'newest' then last_observed_at end desc,
        case when v_sort = 'domain' then source_domain end asc,
        case when v_sort = 'priority' then
          case severity when 'high' then 3 when 'medium' then 2 else 1 end
        end desc,
        case when v_sort = 'priority' then terminal::integer end desc,
        first_observed_at asc,
        id asc
      offset (
        select (page_meta.current_page - 1) * v_page_size
        from page_meta
      )
      limit v_page_size
    ),
    grouped as (
      select
        case v_group_by
          when 'repair_group' then concat_ws(
            '|',
            source_domain,
            evidence_failure_code,
            policy_reason_code,
            likely_repair_code
          )
          when 'domain' then source_domain
          when 'evidence_failure' then evidence_failure_code
          when 'policy_reason' then policy_reason_code
          else likely_repair_code
        end as cluster_key,
        min(
          case v_group_by
            when 'repair_group' then likely_repair_label
            when 'domain' then source_domain
            when 'evidence_failure' then evidence_failure_label
            when 'policy_reason' then policy_reason_label
            else likely_repair_label
          end
        ) as cluster_label,
        min(source_domain) as source_domain,
        min(evidence_failure_code) as evidence_failure_code,
        min(evidence_failure_label) as evidence_failure_label,
        min(policy_reason_code) as policy_reason_code,
        min(policy_reason_label) as policy_reason_label,
        min(likely_repair_code) as likely_repair_code,
        min(likely_repair_label) as likely_repair_label,
        count(*)::bigint as cases,
        sum(evidence_record_count)::bigint as evidence_records,
        count(*) filter (where terminal)::bigint as terminal_cases,
        count(*) filter (where assigned_to_email is null)::bigint as unassigned_cases,
        count(*) filter (where retry_charge <> 'none')::bigint as charge_gated_cases,
        min(first_observed_at) as oldest_observed_at
      from filtered
      group by 1
    ),
    cluster_meta as (
      select
        count(*)::bigint as exact_cluster_total,
        greatest(
          1,
          ceil(count(*)::numeric / v_cluster_page_size)::integer
        ) as cluster_page_count,
        least(
          v_cluster_page,
          greatest(
            1,
            ceil(count(*)::numeric / v_cluster_page_size)::integer
          )
        ) as current_cluster_page
      from grouped
    ),
    cluster_page as (
      select grouped.*
      from grouped
      order by
        cases desc,
        oldest_observed_at asc,
        cluster_label asc,
        cluster_key asc
      offset (
        select (cluster_meta.current_cluster_page - 1) * v_cluster_page_size
        from cluster_meta
      )
      limit v_cluster_page_size
    ),
    domain_facets as (
      select source_domain as key, source_domain as label, count(*)::bigint as cases
      from labeled
      group by source_domain
    ),
    evidence_facets as (
      select
        evidence_failure_code as key,
        min(evidence_failure_label) as label,
        count(*)::bigint as cases
      from labeled
      group by evidence_failure_code
    ),
    policy_facets as (
      select
        policy_reason_code as key,
        min(policy_reason_label) as label,
        count(*)::bigint as cases
      from labeled
      group by policy_reason_code
    ),
    repair_facets as (
      select
        likely_repair_code as key,
        min(likely_repair_label) as label,
        count(*)::bigint as cases
      from labeled
      group by likely_repair_code
    ),
    owner_facets as (
      select
        owner_key as key,
        case when owner_key = 'unassigned' then 'Unassigned' else owner_key end as label,
        count(*)::bigint as cases
      from labeled
      group by owner_key
    ),
    status_facets as (
      select
        status as key,
        case status when 'in_review' then 'In review' else 'Quarantined' end as label,
        count(*)::bigint as cases
      from labeled
      group by status
    ),
    age_facets as (
      select
        age_bucket as key,
        case age_bucket
          when 'under_24h' then 'Under 24 hours'
          when 'one_to_three_days' then '1–3 days'
          when 'four_to_seven_days' then '4–7 days'
          when 'eight_to_thirty_days' then '8–30 days'
          else 'Over 30 days'
        end as label,
        count(*)::bigint as cases
      from labeled
      group by age_bucket
    )
    select jsonb_build_object(
      'schema_version', 'manual-quarantine-backlog-v1',
      'as_of', v_as_of_at,
      'as_of_at', v_as_of_at,
      'backlog_revision', v_backlog_revision,
      'registry_synced_at', v_registry_synced_at,
      'registry_state_total', v_registry_state_total,
      'registry_fresh', coalesce(
        v_now - v_registry_synced_at <= interval '2 hours',
        false
      ),
      'counts_match', coalesce(
        v_registry_state_total = (select count(*)::bigint from labeled),
        false
      ),
      'group_by', v_group_by,
      'sort', v_sort,
      'unfiltered_exact_total', (select count(*)::bigint from labeled),
      'exact_total', page_meta.exact_total,
      'evidence_records', page_meta.evidence_records,
      'terminal_cases', page_meta.terminal_cases,
      'unassigned_cases', page_meta.unassigned_cases,
      'charge_gated_cases', page_meta.charge_gated_cases,
      'oldest_observed_at', page_meta.oldest_observed_at,
      'page', page_meta.current_page,
      'page_size', v_page_size,
      'page_count', page_meta.page_count,
      'cluster_page', cluster_meta.current_cluster_page,
      'cluster_page_size', v_cluster_page_size,
      'cluster_page_count', cluster_meta.cluster_page_count,
      'exact_cluster_total', cluster_meta.exact_cluster_total,
      'clusters', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'key', cluster_key,
            'label', cluster_label,
            'source_domain', source_domain,
            'evidence_failure_code', evidence_failure_code,
            'evidence_failure_label', evidence_failure_label,
            'policy_reason_code', policy_reason_code,
            'policy_reason_label', policy_reason_label,
            'likely_repair_code', likely_repair_code,
            'likely_repair_label', likely_repair_label,
            'cases', cases,
            'evidence_records', evidence_records,
            'terminal_cases', terminal_cases,
            'unassigned_cases', unassigned_cases,
            'charge_gated_cases', charge_gated_cases,
            'oldest_observed_at', oldest_observed_at
          )
          order by
            cases desc,
            oldest_observed_at asc,
            cluster_label asc,
            cluster_key asc
        )
        from cluster_page
      ), '[]'::jsonb),
      'items', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id', id,
            'quarantine_key', quarantine_key,
            'case_key', case_key,
            'category', category,
            'status', status,
            'terminal', terminal,
            'terminal_failure_count', terminal_failure_count,
            'severity', severity,
            'public_impact', public_impact,
            'functional_owner', functional_owner,
            'assigned_to_user_id', assigned_to_user_id,
            'assigned_to_email', assigned_to_email,
            'assigned_at', assigned_at,
            'retry_mode', retry_mode,
            'retry_charge', retry_charge,
            'title', title,
            'reason_code', reason_code,
            'reason', reason,
            'recommended_action', recommended_action,
            'award_id', shared_award_id,
            'award_name', award_name,
            'award_slug', award_slug,
            'source_id', shared_award_source_id,
            'source_url', source_url,
            'source_domain', source_domain,
            'source_domain_basis', source_domain_basis,
            'visual_candidate_id', visual_review_candidate_id,
            'evidence_record_count', evidence_record_count,
            'evidence_hash', evidence_hash,
            'policy_id', policy_id,
            'policy_version', policy_version,
            'policy_hash', policy_hash,
            'evidence_failure_code', evidence_failure_code,
            'evidence_failure_label', evidence_failure_label,
            'policy_reason_code', policy_reason_code,
            'policy_reason_label', policy_reason_label,
            'likely_repair_code', likely_repair_code,
            'likely_repair_label', likely_repair_label,
            'first_observed_at', first_observed_at,
            'last_observed_at', last_observed_at,
            'updated_at', updated_at,
            'age_days', age_days,
            'age_bucket', age_bucket,
            'safe_actions', jsonb_build_object(
              'assign_to_me', true,
              'unassign', assigned_to_email is not null,
              'start_review',
                status = 'quarantined' and assigned_to_user_id is not null,
              'creates_api_charge', false,
              'can_retry', false,
              'can_resolve', false
            )
          )
          order by
            case when v_sort = 'oldest' then first_observed_at end asc,
            case when v_sort = 'newest' then last_observed_at end desc,
            case when v_sort = 'domain' then source_domain end asc,
            case when v_sort = 'priority' then
              case severity when 'high' then 3 when 'medium' then 2 else 1 end
            end desc,
            case when v_sort = 'priority' then terminal::integer end desc,
            first_observed_at asc,
            id asc
        )
        from ordered_items
      ), '[]'::jsonb),
      'facets', jsonb_build_object(
        'domains', coalesce((
          select jsonb_agg(
            jsonb_build_object('key', key, 'label', label, 'cases', cases)
            order by cases desc, label asc
          ) from domain_facets
        ), '[]'::jsonb),
        'evidence_failures', coalesce((
          select jsonb_agg(
            jsonb_build_object('key', key, 'label', label, 'cases', cases)
            order by cases desc, label asc
          ) from evidence_facets
        ), '[]'::jsonb),
        'policy_reasons', coalesce((
          select jsonb_agg(
            jsonb_build_object('key', key, 'label', label, 'cases', cases)
            order by cases desc, label asc
          ) from policy_facets
        ), '[]'::jsonb),
        'repairs', coalesce((
          select jsonb_agg(
            jsonb_build_object('key', key, 'label', label, 'cases', cases)
            order by cases desc, label asc
          ) from repair_facets
        ), '[]'::jsonb),
        'owners', coalesce((
          select jsonb_agg(
            jsonb_build_object('key', key, 'label', label, 'cases', cases)
            order by cases desc, label asc
          ) from owner_facets
        ), '[]'::jsonb),
        'statuses', coalesce((
          select jsonb_agg(
            jsonb_build_object('key', key, 'label', label, 'cases', cases)
            order by cases desc, label asc
          ) from status_facets
        ), '[]'::jsonb),
        'ages', coalesce((
          select jsonb_agg(
            jsonb_build_object('key', key, 'label', label, 'cases', cases)
            order by case key
              when 'under_24h' then 1
              when 'one_to_three_days' then 2
              when 'four_to_seven_days' then 3
              when 'eight_to_thirty_days' then 4
              else 5
            end
          ) from age_facets
        ), '[]'::jsonb)
      )
    )
    from page_meta
    cross join cluster_meta
  );
end;
$$;

revoke all on function public.list_manual_quarantine_backlog(
  integer,
  integer,
  integer,
  integer,
  text,
  text,
  text[],
  text[],
  text[],
  text[],
  text[],
  text[],
  text,
  text,
  timestamptz,
  bigint,
  timestamptz
) from public, anon, authenticated, service_role;
grant execute on function public.list_manual_quarantine_backlog(
  integer,
  integer,
  integer,
  integer,
  text,
  text,
  text[],
  text[],
  text[],
  text[],
  text[],
  text[],
  text,
  text,
  timestamptz,
  bigint,
  timestamptz
) to service_role;

create or replace function public.apply_manual_quarantine_bulk_action(
  p_request_id uuid,
  p_cases jsonb,
  p_action text,
  p_actor_user_id uuid,
  p_actor_email text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_ids uuid[];
  v_existing_ids uuid[];
  v_existing_action text;
  v_existing_selection_hash text;
  v_existing_actor_user_id uuid;
  v_existing_actor_email text;
  v_selection jsonb;
  v_selection_hash text;
  v_found integer := 0;
  v_changed integer := 0;
  v_previous_assignee text;
  v_next_assignee text;
  v_previous_status text;
  v_next_status text;
  v_row record;
  v_row_changed boolean;
  v_actor_email text := lower(btrim(coalesce(p_actor_email, '')));
  v_now timestamptz := clock_timestamp();
begin
  if p_request_id is null or p_actor_user_id is null then
    raise exception using errcode = '22004', message = 'Bulk action identity is required.';
  end if;
  if pg_catalog.char_length(v_actor_email) > 320
    or v_actor_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception using errcode = '22023', message = 'Bulk action actor email is invalid.';
  end if;
  if p_action is null or p_action not in ('assign_to_me', 'unassign', 'start_review') then
    raise exception using
      errcode = '22023',
      message = 'Only no-charge assignment and start-review bulk actions are allowed.';
  end if;

  if jsonb_typeof(coalesce(p_cases, 'null'::jsonb)) <> 'array' then
    raise exception using errcode = '22023', message = 'Bulk action cases must be a JSON array.';
  end if;
  if pg_catalog.octet_length(p_cases::text) > 262144 then
    raise exception using errcode = '22023', message = 'Bulk action payload is too large.';
  end if;

  select
    coalesce(array_agg(selected.id order by selected.id), '{}'::uuid[]),
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', selected.id,
          'evidence_hash', selected.evidence_hash,
          'status', selected.status,
          'assigned_to_email', selected.assigned_to_email
        )
        order by selected.id
      ),
      '[]'::jsonb
    )
  into v_ids, v_selection
  from (
    select distinct on (parsed.id)
      parsed.id,
      lower(parsed.evidence_hash) as evidence_hash,
      parsed.status,
      nullif(lower(btrim(parsed.assigned_to_email)), '') as assigned_to_email
    from jsonb_to_recordset(p_cases) as parsed(
      id uuid,
      evidence_hash text,
      status text,
      assigned_to_email text
    )
    order by parsed.id
  ) selected;

  if cardinality(v_ids) = 0 or cardinality(v_ids) > 100 then
    raise exception using
      errcode = '22023',
      message = 'Select between 1 and 100 quarantine cases.';
  end if;
  if cardinality(v_ids) <> jsonb_array_length(p_cases) then
    raise exception using errcode = '22023', message = 'Duplicate quarantine case IDs are not allowed.';
  end if;
  if exists (
    select 1
    from jsonb_to_recordset(v_selection) as selected(
      id uuid,
      evidence_hash text,
      status text,
      assigned_to_email text
    )
    where selected.id is null
      or selected.evidence_hash is null
      or selected.evidence_hash !~ '^[0-9a-f]{64}$'
      or selected.status is null
      or selected.status not in ('quarantined', 'in_review')
      or (
        selected.assigned_to_email is not null
        and (
          pg_catalog.char_length(selected.assigned_to_email) > 320
          or selected.assigned_to_email !~
            '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
        )
      )
  ) then
    raise exception using
      errcode = '22023',
      message = 'Every selected case needs an ID, evidence hash, open status, and valid owner snapshot.';
  end if;
  v_selection_hash := public.manual_quarantine_evidence_hash(v_selection);

  perform pg_catalog.pg_advisory_xact_lock(
    hashtext('manual-quarantine-bulk:' || p_request_id::text)
  );

  select
    array_agg(event.quarantine_id order by event.quarantine_id),
    min(event.action),
    min(event.selection_hash),
    min(event.actor_user_id::text)::uuid,
    min(event.actor_email)
  into
    v_existing_ids,
    v_existing_action,
    v_existing_selection_hash,
    v_existing_actor_user_id,
    v_existing_actor_email
  from public.manual_quarantine_operator_action_events event
  where event.request_id = p_request_id;

  if coalesce(cardinality(v_existing_ids), 0) > 0 then
    if v_existing_ids is distinct from v_ids
      or v_existing_action is distinct from p_action
      or v_existing_selection_hash is distinct from v_selection_hash
      or v_existing_actor_user_id is distinct from p_actor_user_id
      or v_existing_actor_email is distinct from v_actor_email then
      raise exception using
        errcode = '40001',
        message = 'This bulk request ID was already used for a different action or case set.';
    end if;
    return jsonb_build_object(
      'accepted', true,
      'replayed', true,
      'request_id', p_request_id,
      'action', p_action,
      'requested', cardinality(v_ids),
      'changed', (
        select count(*)
        from public.manual_quarantine_operator_action_events event
        where event.request_id = p_request_id and event.changed
      ),
      'creates_api_charge', false,
      'can_retry', false,
      'can_resolve', false
    );
  end if;

  for v_row in select unnest(v_ids) as id order by id loop
    perform pg_catalog.pg_advisory_xact_lock(
      hashtext('manual-quarantine-case:' || v_row.id::text)
    );
  end loop;

  perform 1
  from public.manual_quarantine_registry registry
  join jsonb_to_recordset(v_selection) as selected(
    id uuid,
    evidence_hash text,
    status text,
    assigned_to_email text
  ) on selected.id = registry.id
  left join public.manual_quarantine_operator_assignments assignment
    on assignment.quarantine_id = registry.id
  where registry.id = any(v_ids)
    and registry.requires_action
    and registry.status in ('quarantined', 'in_review')
    and registry.status = selected.status
    and registry.evidence_hash = selected.evidence_hash
    and coalesce(assignment.assigned_to_email, '') =
      coalesce(selected.assigned_to_email, '')
  order by registry.id
  for update of registry;
  get diagnostics v_found = row_count;

  if v_found <> cardinality(v_ids) then
    raise exception using
      errcode = '40001',
      message = 'One or more selected cases changed or are no longer actionable. Refresh the queue.';
  end if;

  -- The auth UUID is the ownership authority. Email is a display/audit snapshot
  -- and may legitimately change for the same operator.
  if p_action = 'assign_to_me' and exists (
    select 1
    from public.manual_quarantine_operator_assignments assignment
    where assignment.quarantine_id = any(v_ids)
      and assignment.assigned_to_user_id <> p_actor_user_id
  ) then
    raise exception using
      errcode = '40001',
      message = 'A selected case is already assigned to another operator. Refresh or ask them to clear it first.';
  end if;
  if p_action = 'unassign' and exists (
    select 1
    from unnest(v_ids) selected(id)
    left join public.manual_quarantine_operator_assignments assignment
      on assignment.quarantine_id = selected.id
    where assignment.assigned_to_user_id is distinct from p_actor_user_id
  ) then
    raise exception using
      errcode = '40001',
      message = 'Only cases assigned to you can be cleared in bulk.';
  end if;
  if p_action = 'start_review' and exists (
    select 1
    from unnest(v_ids) selected(id)
    left join public.manual_quarantine_operator_assignments assignment
      on assignment.quarantine_id = selected.id
    where assignment.assigned_to_user_id is distinct from p_actor_user_id
  ) then
    raise exception using
      errcode = '40001',
      message = 'Assign every selected case to yourself before starting review.';
  end if;

  for v_row in
    select
      registry.id,
      registry.status,
      assignment.assigned_to_user_id,
      assignment.assigned_to_email
    from public.manual_quarantine_registry registry
    left join public.manual_quarantine_operator_assignments assignment
      on assignment.quarantine_id = registry.id
    where registry.id = any(v_ids)
    order by registry.id
  loop
    v_previous_status := v_row.status;
    v_next_status := v_row.status;
    v_previous_assignee := v_row.assigned_to_email;
    v_next_assignee := v_row.assigned_to_email;
    v_row_changed := false;

    if p_action = 'assign_to_me' then
      v_next_assignee := v_actor_email;
      v_row_changed :=
        v_row.assigned_to_user_id is distinct from p_actor_user_id
        or v_previous_assignee is distinct from v_actor_email;
      if v_row_changed then
        insert into public.manual_quarantine_operator_assignments (
          quarantine_id,
          assigned_to_user_id,
          assigned_to_email,
          assigned_by_user_id,
          assigned_by_email,
          assigned_at
        ) values (
          v_row.id,
          p_actor_user_id,
          v_actor_email,
          p_actor_user_id,
          v_actor_email,
          v_now
        )
        on conflict (quarantine_id) do update set
          assigned_to_user_id = excluded.assigned_to_user_id,
          assigned_to_email = excluded.assigned_to_email,
          assigned_by_user_id = excluded.assigned_by_user_id,
          assigned_by_email = excluded.assigned_by_email,
          assigned_at = excluded.assigned_at;
      end if;
    elsif p_action = 'unassign' then
      v_next_assignee := null;
      -- An in-review case may never become ownerless. Clearing ownership puts it
      -- back in the quarantined queue in the same transaction.
      if v_previous_status = 'in_review' then
        v_next_status := 'quarantined';
        update public.manual_quarantine_registry registry
        set status = 'quarantined'
        where registry.id = v_row.id and registry.status = 'in_review';
      end if;
      v_row_changed := v_previous_assignee is not null;
      delete from public.manual_quarantine_operator_assignments assignment
      where assignment.quarantine_id = v_row.id;
    else
      v_next_assignee := v_actor_email;
      v_next_status := 'in_review';
      v_row_changed :=
        v_previous_status is distinct from 'in_review'
        or v_previous_assignee is distinct from v_actor_email;
      if v_previous_assignee is distinct from v_actor_email then
        update public.manual_quarantine_operator_assignments assignment
        set assigned_to_email = v_actor_email
        where assignment.quarantine_id = v_row.id
          and assignment.assigned_to_user_id = p_actor_user_id;
      end if;
      update public.manual_quarantine_registry registry
      set status = 'in_review'
      where registry.id = v_row.id and registry.status = 'quarantined';
    end if;

    if v_row_changed then v_changed := v_changed + 1; end if;

    insert into public.manual_quarantine_operator_action_events (
      request_id,
      quarantine_id,
      action,
      actor_user_id,
      actor_email,
      previous_status,
      next_status,
      previous_assignee_email,
      next_assignee_email,
      selection_hash,
      changed,
      metadata
    ) values (
      p_request_id,
      v_row.id,
      p_action,
      p_actor_user_id,
      v_actor_email,
      v_previous_status,
      v_next_status,
      v_previous_assignee,
      v_next_assignee,
      v_selection_hash,
      v_row_changed,
      jsonb_build_object(
        'creates_api_charge', false,
        'can_retry', false,
        'can_resolve', false,
        'policy_version', 'manual-quarantine-bulk-v1'
      )
    );
  end loop;

  return jsonb_build_object(
    'accepted', true,
    'replayed', false,
    'request_id', p_request_id,
    'action', p_action,
    'requested', cardinality(v_ids),
    'changed', v_changed,
    'creates_api_charge', false,
    'can_retry', false,
    'can_resolve', false
  );
end;
$$;

revoke all on function public.apply_manual_quarantine_bulk_action(
  uuid,
  jsonb,
  text,
  uuid,
  text
) from public, anon, authenticated, service_role;
grant execute on function public.apply_manual_quarantine_bulk_action(
  uuid,
  jsonb,
  text,
  uuid,
  text
) to service_role;

create or replace function public.save_manual_quarantine_saved_view(
  p_user_id uuid,
  p_user_email text,
  p_name text,
  p_filters jsonb,
  p_group_by text,
  p_sort text,
  p_page_size integer,
  p_view_id uuid default null
)
returns table (
  saved_view_id uuid,
  saved_view_name text,
  saved_filters jsonb,
  saved_group_by text,
  saved_sort text,
  saved_page_size integer,
  saved_updated_at timestamptz
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_email text := lower(btrim(coalesce(p_user_email, '')));
  v_name text := btrim(coalesce(p_name, ''));
  v_view public.manual_quarantine_saved_views%rowtype;
begin
  if p_user_id is null then
    raise exception using errcode = '22004', message = 'Saved-view user identity is required.';
  end if;
  if pg_catalog.char_length(v_email) > 320
    or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception using errcode = '22023', message = 'Saved-view user email is invalid.';
  end if;
  if char_length(v_name) not between 1 and 80 then
    raise exception using errcode = '22023', message = 'Saved-view name must be 1–80 characters.';
  end if;
  if jsonb_typeof(coalesce(p_filters, '{}'::jsonb)) <> 'object' then
    raise exception using errcode = '22023', message = 'Saved-view filters must be a JSON object.';
  end if;
  if pg_catalog.octet_length(coalesce(p_filters, '{}'::jsonb)::text) > 65536 then
    raise exception using errcode = '22023', message = 'Saved-view filters are too large.';
  end if;
  if p_group_by not in (
    'repair_group',
    'domain',
    'evidence_failure',
    'policy_reason',
    'likely_repair'
  ) then
    raise exception using errcode = '22023', message = 'Saved-view grouping is invalid.';
  end if;
  if p_sort not in ('oldest', 'newest', 'priority', 'domain') then
    raise exception using errcode = '22023', message = 'Saved-view sort is invalid.';
  end if;
  if p_page_size not between 10 and 100 then
    raise exception using errcode = '22023', message = 'Saved-view page size must be 10–100.';
  end if;

  if p_view_id is not null then
    update public.manual_quarantine_saved_views saved
    set
      user_email = v_email,
      name = v_name,
      filters = coalesce(p_filters, '{}'::jsonb),
      group_by = p_group_by,
      sort_key = p_sort,
      page_size = p_page_size
    where saved.id = p_view_id and saved.user_id = p_user_id
    returning saved.* into v_view;
    if v_view.id is null then
      raise exception using errcode = 'P0002', message = 'Saved backlog view was not found.';
    end if;
  else
    insert into public.manual_quarantine_saved_views (
      user_id,
      user_email,
      name,
      filters,
      group_by,
      sort_key,
      page_size
    ) values (
      p_user_id,
      v_email,
      v_name,
      coalesce(p_filters, '{}'::jsonb),
      p_group_by,
      p_sort,
      p_page_size
    )
    returning public.manual_quarantine_saved_views.* into v_view;
  end if;

  return query select
    v_view.id,
    v_view.name,
    v_view.filters,
    v_view.group_by,
    v_view.sort_key,
    v_view.page_size,
    v_view.updated_at;
end;
$$;

revoke all on function public.save_manual_quarantine_saved_view(
  uuid,
  text,
  text,
  jsonb,
  text,
  text,
  integer,
  uuid
) from public, anon, authenticated, service_role;
grant execute on function public.save_manual_quarantine_saved_view(
  uuid,
  text,
  text,
  jsonb,
  text,
  text,
  integer,
  uuid
) to service_role;

create or replace function public.delete_manual_quarantine_saved_view(
  p_view_id uuid,
  p_user_id uuid
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  delete from public.manual_quarantine_saved_views saved
  where saved.id = p_view_id and saved.user_id = p_user_id;
  get diagnostics v_deleted = row_count;
  return v_deleted = 1;
end;
$$;

revoke all on function public.delete_manual_quarantine_saved_view(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.delete_manual_quarantine_saved_view(uuid, uuid)
  to service_role;

comment on table public.manual_quarantine_operator_assignments is
  'Durable person-level ownership for current quarantine cases; deleting ownership or the auth user returns in-review work to the quarantined queue.';
comment on table public.manual_quarantine_saved_views is
  'Per-operator saved filters for the exact, clustered manual-quarantine backlog.';
comment on table public.manual_quarantine_operator_action_events is
  'Append-only audit evidence for idempotent, no-charge bulk assignment and start-review actions.';
comment on function public.return_unowned_manual_quarantine_to_queue() is
  'Fail-closed delete trigger that prevents actionable in-review quarantine work from becoming ownerless.';
comment on function public.list_manual_quarantine_backlog(
  integer,
  integer,
  integer,
  integer,
  text,
  text,
  text[],
  text[],
  text[],
  text[],
  text[],
  text[],
  text,
  text,
  timestamptz,
  bigint,
  timestamptz
) is
  'Returns exact totals, facets, deterministic clusters, and bounded pages without mistaking a result cap for the real backlog.';

notify pgrst, 'reload schema';
