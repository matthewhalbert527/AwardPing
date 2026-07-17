-- Publish one deterministic award reconciliation as a single database commit.
-- The queue claim, immutable fact evidence, and public facts must never expose
-- mutually inconsistent states to readers.

alter table public.shared_award_reconciliation_queue
  add column if not exists generation bigint not null default 0;

create or replace function public.commit_award_reconciliation_publication(
  p_reconciliation_id uuid,
  p_shared_award_id uuid,
  p_expected_started_at timestamptz,
  p_expected_queue_generation bigint,
  p_expected_award_updated_at timestamptz,
  p_expected_public_facts jsonb,
  p_summary text,
  p_public_facts jsonb,
  p_confidence double precision,
  p_evidence_rows jsonb,
  p_source_ids uuid[],
  p_candidate_ids uuid[],
  p_generated_candidates jsonb,
  p_candidate_status_updates jsonb,
  p_audit_row jsonb
)
returns public.shared_award_reconciliation_queue
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_queue public.shared_award_reconciliation_queue%rowtype;
  v_award public.shared_awards%rowtype;
  v_now timestamptz := statement_timestamp();
  v_inserted_count integer := 0;
  v_evidence_source_ids uuid[];
  v_evidence_candidate_ids uuid[];
  v_generated_count integer := 0;
  v_updated_candidate_count integer := 0;
begin
  if p_reconciliation_id is null
    or p_shared_award_id is null
    or p_expected_started_at is null
    or p_expected_queue_generation is null
    or p_expected_award_updated_at is null then
    raise exception using
      errcode = '22004',
      message = 'Reconciliation, award, claim, and award-version identities are required.';
  end if;

  if pg_catalog.jsonb_typeof(p_expected_public_facts) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_public_facts) is distinct from 'object' then
    raise exception using
      errcode = '22023',
      message = 'Expected and replacement public facts must be JSON objects.';
  end if;

  if p_confidence is null or p_confidence not between 0 and 1 then
    raise exception using
      errcode = '22023',
      message = 'Published confidence must be between zero and one.';
  end if;

  if pg_catalog.cardinality(p_source_ids) is null
    or pg_catalog.cardinality(p_source_ids) = 0
    or pg_catalog.cardinality(p_candidate_ids) is null
    or pg_catalog.cardinality(p_candidate_ids) = 0
    or pg_catalog.array_position(p_source_ids, null) is not null
    or pg_catalog.array_position(p_candidate_ids, null) is not null then
    raise exception using
      errcode = '22023',
      message = 'Successful reconciliation requires non-empty source and candidate identity sets.';
  end if;

  if pg_catalog.cardinality(p_source_ids) <>
      (
        select pg_catalog.count(distinct source_set.source_id)
        from pg_catalog.unnest(p_source_ids) as source_set(source_id)
      )
    or pg_catalog.cardinality(p_candidate_ids) <>
      (
        select pg_catalog.count(distinct candidate_set.candidate_id)
        from pg_catalog.unnest(p_candidate_ids) as candidate_set(candidate_id)
      ) then
    raise exception using
      errcode = '22023',
      message = 'Source and candidate identity sets cannot contain duplicates.';
  end if;

  if pg_catalog.jsonb_typeof(p_evidence_rows) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_evidence_rows) = 0 then
    raise exception using
      errcode = '22023',
      message = 'Successful reconciliation requires at least one evidence-bound public fact.';
  end if;

  if pg_catalog.jsonb_typeof(p_generated_candidates) is distinct from 'array'
    or pg_catalog.jsonb_typeof(p_candidate_status_updates) is distinct from 'array'
    or pg_catalog.jsonb_typeof(p_audit_row) is distinct from 'object' then
    raise exception using
      errcode = '22023',
      message = 'Candidate mutations must be arrays and the deterministic audit must be an object.';
  end if;

  -- Stage 1 public_facts updates can invalidate the national release. Match
  -- the release/promotion lock order before taking queue or award locks while
  -- leaving non-Stage-1 reconciliations independent.
  if exists (
    select 1
    from public.stage1_award_registry registry
    where registry.canonical_shared_award_id = p_shared_award_id
  ) then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('stage1-national-25-release', 0)
    );
  end if;

  select queue.*
  into v_queue
  from public.shared_award_reconciliation_queue queue
  where queue.id = p_reconciliation_id
  for update;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'Reconciliation queue row does not exist.';
  end if;

  if v_queue.shared_award_id <> p_shared_award_id
    or v_queue.status <> 'processing'
    or v_queue.started_at is distinct from p_expected_started_at
    or v_queue.completed_at is not null then
    raise exception using
      errcode = '40001',
      message = 'Reconciliation claim is stale or is no longer owned by this worker.';
  end if;

  -- A source/candidate trigger can arrive after this worker loaded its inputs.
  -- The enqueuer advances generation under CAS. Requeue the merged work here
  -- without publishing the stale computation; the caller treats a non-
  -- succeeded return as an intentional follow-up rather than success.
  if v_queue.generation is distinct from p_expected_queue_generation then
    update public.shared_award_reconciliation_queue queue
    set
      status = 'pending',
      started_at = null,
      completed_at = null,
      error = 'requeued_after_trigger_during_processing'
    where queue.id = p_reconciliation_id
      and queue.status = 'processing'
      and queue.started_at = p_expected_started_at
    returning queue.* into v_queue;

    if not found then
      raise exception using
        errcode = '40001',
        message = 'Reconciliation claim changed before its follow-up could be preserved.';
    end if;
    return v_queue;
  end if;

  select award.*
  into v_award
  from public.shared_awards award
  where award.id = p_shared_award_id
  for update;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'Shared award does not exist.';
  end if;

  if v_award.updated_at is distinct from p_expected_award_updated_at
    or v_award.public_facts is distinct from p_expected_public_facts then
    raise exception using
      errcode = '40001',
      message = 'Shared award changed after reconciliation began; retry with fresh inputs.';
  end if;

  -- Validate every worker-authored mutation before writing anything. UUID
  -- syntax is checked in a separate pass so later casts cannot turn malformed
  -- JSON into an incidental database error.
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_generated_candidates) generated(value)
    where pg_catalog.jsonb_typeof(generated.value) is distinct from 'object'
      or coalesce(generated.value ->> 'id', '') !~*
        '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or coalesce(generated.value ->> 'shared_award_id', '') !~*
        '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or coalesce(generated.value ->> 'shared_award_source_id', '') !~*
        '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or nullif(pg_catalog.btrim(generated.value ->> 'field_name'), '') is null
      or generated.value ->> 'candidate_status' not in (
        'pending', 'selected', 'rejected', 'conflicted', 'superseded'
      )
      or not (generated.value ? 'normalized_value')
      or pg_catalog.jsonb_typeof(
        generated.value -> 'source_quality_decision'
      ) is distinct from 'object'
      or pg_catalog.jsonb_typeof(generated.value -> 'metadata') is distinct from 'object'
      or coalesce(generated.value -> 'source_page_request_id', 'null'::jsonb)
        is distinct from 'null'::jsonb
      or coalesce(generated.value -> 'intake_value_sha256', 'null'::jsonb)
        is distinct from 'null'::jsonb
  ) then
    raise exception using
      errcode = '22023',
      message = 'A generated fact candidate is malformed or claims a paid-intake identity.';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_candidate_status_updates) mutation(value)
    where pg_catalog.jsonb_typeof(mutation.value) is distinct from 'object'
      or coalesce(mutation.value ->> 'id', '') !~*
        '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or mutation.value ->> 'expected_status' not in (
        'pending', 'selected', 'rejected', 'conflicted', 'superseded'
      )
      or mutation.value ->> 'candidate_status' not in (
        'pending', 'selected', 'rejected', 'conflicted', 'superseded'
      )
      or nullif(mutation.value ->> 'expected_updated_at', '') is null
  ) then
    raise exception using
      errcode = '22023',
      message = 'A fact candidate status mutation is malformed.';
  end if;

  if (
    select pg_catalog.count(*)
    from pg_catalog.jsonb_array_elements(p_generated_candidates) generated(value)
  ) <> (
    select pg_catalog.count(distinct generated.value ->> 'id')
    from pg_catalog.jsonb_array_elements(p_generated_candidates) generated(value)
  ) or (
    select pg_catalog.count(*)
    from pg_catalog.jsonb_array_elements(p_candidate_status_updates) mutation(value)
  ) <> (
    select pg_catalog.count(distinct mutation.value ->> 'id')
    from pg_catalog.jsonb_array_elements(p_candidate_status_updates) mutation(value)
  ) or exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_generated_candidates) generated(value)
    join pg_catalog.jsonb_array_elements(p_candidate_status_updates) mutation(value)
      on mutation.value ->> 'id' = generated.value ->> 'id'
  ) then
    raise exception using
      errcode = '22023',
      message = 'Candidate mutation identities must be unique and disjoint.';
  end if;

  if coalesce(p_audit_row ->> 'shared_award_id', '') !~*
      '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or (p_audit_row ->> 'shared_award_id')::uuid <> p_shared_award_id
    or p_audit_row ->> 'audit_kind' is distinct from 'deterministic'
    or p_audit_row ->> 'audit_status' not in (
      'passed', 'warnings', 'failed', 'needs_review'
    )
    or p_audit_row ->> 'severity' not in (
      'info', 'warning', 'error', 'critical'
    )
    or pg_catalog.jsonb_typeof(p_audit_row -> 'findings') is distinct from 'array'
    or pg_catalog.jsonb_typeof(p_audit_row -> 'suggested_fixes') is distinct from 'array'
    or pg_catalog.jsonb_typeof(p_audit_row -> 'field_conflicts') is distinct from 'array'
    or pg_catalog.jsonb_typeof(p_audit_row -> 'source_rejections') is distinct from 'array'
    or pg_catalog.jsonb_typeof(p_audit_row -> 'selected_fact_summary') is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_audit_row -> 'public_page_snapshot') is distinct from 'object'
    or coalesce(
      p_audit_row #>> array[
        'public_page_snapshot',
        'reconciliation_audit_signature'
      ],
      ''
    ) !~ '^[0-9a-f]{64}$'
    or (p_audit_row -> 'public_page_snapshot') -
      'reconciliation_audit_signature' is distinct from p_public_facts then
    raise exception using
      errcode = '22023',
      message = 'The deterministic audit is malformed or is not bound to the replacement public facts.';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_generated_candidates) generated(value)
    left join public.shared_award_sources source
      on source.id = (generated.value ->> 'shared_award_source_id')::uuid
    left join public.shared_award_fact_candidates existing_candidate
      on existing_candidate.id = (generated.value ->> 'id')::uuid
    where existing_candidate.id is not null
      or source.id is null
      or source.shared_award_id is distinct from
        (generated.value ->> 'shared_award_id')::uuid
      or not (
        source.shared_award_id = p_shared_award_id
        or exists (
          select 1
          from public.stage1_award_members target_member
          join public.stage1_award_members source_member
            on source_member.cohort_key = target_member.cohort_key
          where target_member.shared_award_id = p_shared_award_id
            and source_member.shared_award_id = source.shared_award_id
        )
      )
  ) then
    raise exception using
      errcode = '23503',
      message = 'A generated candidate identity or source is missing or outside the reconciled award scope.';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_candidate_status_updates) mutation(value)
    left join public.shared_award_fact_candidates candidate
      on candidate.id = (mutation.value ->> 'id')::uuid
    where candidate.id is null
      or not (
        candidate.shared_award_id = p_shared_award_id
        or exists (
          select 1
          from public.stage1_award_members target_member
          join public.stage1_award_members candidate_member
            on candidate_member.cohort_key = target_member.cohort_key
          where target_member.shared_award_id = p_shared_award_id
            and candidate_member.shared_award_id = candidate.shared_award_id
        )
      )
  ) then
    raise exception using
      errcode = '23503',
      message = 'A candidate status mutation targets a missing or out-of-scope candidate.';
  end if;

  insert into public.shared_award_fact_candidates (
    id,
    shared_award_id,
    shared_award_source_id,
    source_url,
    source_title,
    source_role,
    source_quality_decision,
    field_name,
    raw_value,
    normalized_value,
    evidence_quote,
    evidence_location,
    extracted_at,
    model,
    confidence,
    candidate_status,
    rejection_reason,
    selected_reason,
    source_page_request_id,
    intake_value_sha256,
    metadata,
    created_at,
    updated_at
  )
  select
    generated.id,
    generated.shared_award_id,
    generated.shared_award_source_id,
    generated.source_url,
    generated.source_title,
    generated.source_role,
    generated.source_quality_decision,
    generated.field_name,
    generated.raw_value,
    generated.normalized_value,
    generated.evidence_quote,
    generated.evidence_location,
    generated.extracted_at,
    generated.model,
    generated.confidence,
    generated.candidate_status,
    generated.rejection_reason,
    generated.selected_reason,
    generated.source_page_request_id,
    generated.intake_value_sha256,
    generated.metadata,
    v_now,
    v_now
  from pg_catalog.jsonb_to_recordset(p_generated_candidates) as generated(
    id uuid,
    shared_award_id uuid,
    shared_award_source_id uuid,
    source_url text,
    source_title text,
    source_role text,
    source_quality_decision jsonb,
    field_name text,
    raw_value text,
    normalized_value jsonb,
    evidence_quote text,
    evidence_location text,
    extracted_at timestamptz,
    model text,
    confidence text,
    candidate_status text,
    rejection_reason text,
    selected_reason text,
    source_page_request_id uuid,
    intake_value_sha256 text,
    metadata jsonb
  );

  get diagnostics v_generated_count = row_count;
  if v_generated_count <> pg_catalog.jsonb_array_length(p_generated_candidates) then
    raise exception using
      errcode = 'P0001',
      message = 'Not every generated fact candidate was persisted.';
  end if;

  update public.shared_award_fact_candidates candidate
  set
    candidate_status = mutation.candidate_status,
    selected_reason = mutation.selected_reason,
    rejection_reason = mutation.rejection_reason,
    updated_at = v_now
  from pg_catalog.jsonb_to_recordset(p_candidate_status_updates) as mutation(
    id uuid,
    expected_status text,
    expected_updated_at timestamptz,
    candidate_status text,
    selected_reason text,
    rejection_reason text
  )
  where candidate.id = mutation.id
    and candidate.candidate_status = mutation.expected_status
    and candidate.updated_at = mutation.expected_updated_at;

  get diagnostics v_updated_candidate_count = row_count;
  if v_updated_candidate_count <>
      pg_catalog.jsonb_array_length(p_candidate_status_updates) then
    raise exception using
      errcode = '40001',
      message = 'A fact candidate changed before the atomic publication commit.';
  end if;

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
  )
  values (
    p_shared_award_id,
    p_audit_row ->> 'audit_kind',
    p_audit_row ->> 'audit_status',
    p_audit_row ->> 'severity',
    p_audit_row -> 'findings',
    p_audit_row -> 'suggested_fixes',
    p_audit_row -> 'field_conflicts',
    p_audit_row -> 'source_rejections',
    p_audit_row -> 'selected_fact_summary',
    p_audit_row -> 'public_page_snapshot',
    p_audit_row ->> 'model'
  );

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_evidence_rows) evidence_row(value)
    where pg_catalog.jsonb_typeof(evidence_row.value) is distinct from 'object'
      or nullif(pg_catalog.btrim(evidence_row.value ->> 'field_name'), '') is null
      or evidence_row.value ->> 'field_name' not in (
        'overview',
        'deadline',
        'opening_date',
        'award_amounts',
        'eligibility',
        'requirements',
        'application_materials',
        'how_to_apply',
        'important_dates',
        'documents',
        'contacts',
        'academic_levels',
        'disciplines',
        'citizenship',
        'confidence'
      )
      or not (evidence_row.value ? 'public_value')
      or pg_catalog.jsonb_typeof(evidence_row.value -> 'candidate_ids') is distinct from 'array'
      or pg_catalog.jsonb_array_length(evidence_row.value -> 'candidate_ids') = 0
      or pg_catalog.jsonb_typeof(evidence_row.value -> 'source_ids') is distinct from 'array'
      or pg_catalog.jsonb_array_length(evidence_row.value -> 'source_ids') = 0
      or pg_catalog.jsonb_typeof(evidence_row.value -> 'evidence') is distinct from 'object'
      or pg_catalog.jsonb_typeof(
        evidence_row.value -> 'evidence' -> 'candidate_bindings'
      ) is distinct from 'object'
      or evidence_row.value -> 'evidence' ->> 'award_id' is distinct from p_shared_award_id::text
      or evidence_row.value -> 'evidence' ->> 'reconciliation_id' is distinct from p_reconciliation_id::text
      or evidence_row.value -> 'evidence' ->> 'field_name' is distinct from
        evidence_row.value ->> 'field_name'
      or not (p_public_facts ? (evidence_row.value ->> 'field_name'))
      or p_public_facts -> (evidence_row.value ->> 'field_name') is distinct from
        evidence_row.value -> 'public_value'
      or evidence_row.value -> 'evidence' -> 'public_value' is distinct from
        evidence_row.value -> 'public_value'
      or evidence_row.value -> 'evidence' -> 'candidate_ids' is distinct from
        evidence_row.value -> 'candidate_ids'
      or evidence_row.value -> 'evidence' -> 'source_ids' is distinct from
        evidence_row.value -> 'source_ids'
      or pg_catalog.jsonb_array_length(evidence_row.value -> 'candidate_ids') <>
        (
          select pg_catalog.count(distinct candidate_identity.value)
          from pg_catalog.jsonb_array_elements_text(
            evidence_row.value -> 'candidate_ids'
          ) candidate_identity(value)
        )
      or pg_catalog.jsonb_array_length(evidence_row.value -> 'source_ids') <>
        (
          select pg_catalog.count(distinct source_identity.value)
          from pg_catalog.jsonb_array_elements_text(
            evidence_row.value -> 'source_ids'
          ) source_identity(value)
        )
  ) then
    raise exception using
      errcode = '22023',
      message = 'A reconciled fact evidence row is incomplete or internally inconsistent.';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_each(p_public_facts) published_fact(field_name, value)
    where published_fact.field_name in (
        'overview',
        'deadline',
        'opening_date',
        'award_amounts',
        'eligibility',
        'requirements',
        'application_materials',
        'how_to_apply',
        'important_dates',
        'documents',
        'contacts',
        'academic_levels',
        'disciplines',
        'citizenship',
        'confidence'
      )
      and published_fact.value not in (
        'null'::jsonb,
        '""'::jsonb,
        '[]'::jsonb,
        '{}'::jsonb
      )
      and not exists (
        select 1
        from pg_catalog.jsonb_array_elements(p_evidence_rows) evidence_row(value)
        where evidence_row.value ->> 'field_name' = published_fact.field_name
          and evidence_row.value -> 'public_value' = published_fact.value
      )
  ) then
    raise exception using
      errcode = '23514',
      message = 'Every non-empty publishable fact requires exact reconciled evidence in the same commit.';
  end if;

  if (
    select pg_catalog.count(*)
    from pg_catalog.jsonb_array_elements(p_evidence_rows) evidence_row(value)
  ) <> (
    select pg_catalog.count(distinct evidence_row.value ->> 'field_name')
    from pg_catalog.jsonb_array_elements(p_evidence_rows) evidence_row(value)
  ) then
    raise exception using
      errcode = '22023',
      message = 'Reconciled fact evidence field names must be unique.';
  end if;

  select coalesce(
    pg_catalog.array_agg(identity_set.source_id order by identity_set.source_id),
    '{}'::uuid[]
  )
  into v_evidence_source_ids
  from (
    select distinct source_identity.value::uuid as source_id
    from pg_catalog.jsonb_array_elements(p_evidence_rows) evidence_row(value)
    cross join lateral pg_catalog.jsonb_array_elements_text(
      evidence_row.value -> 'source_ids'
    ) source_identity(value)
  ) identity_set;

  select coalesce(
    pg_catalog.array_agg(identity_set.candidate_id order by identity_set.candidate_id),
    '{}'::uuid[]
  )
  into v_evidence_candidate_ids
  from (
    select distinct candidate_identity.value::uuid as candidate_id
    from pg_catalog.jsonb_array_elements(p_evidence_rows) evidence_row(value)
    cross join lateral pg_catalog.jsonb_array_elements_text(
      evidence_row.value -> 'candidate_ids'
    ) candidate_identity(value)
  ) identity_set;

  if not (
    v_evidence_source_ids @> p_source_ids
    and p_source_ids @> v_evidence_source_ids
    and v_evidence_candidate_ids @> p_candidate_ids
    and p_candidate_ids @> v_evidence_candidate_ids
  ) then
    raise exception using
      errcode = '22023',
      message = 'Queue success identities must exactly match reconciled fact evidence identities.';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_evidence_rows) evidence_row(value)
    cross join lateral pg_catalog.jsonb_array_elements_text(
      evidence_row.value -> 'candidate_ids'
    ) candidate_identity(value)
    left join public.shared_award_fact_candidates candidate
      on candidate.id = candidate_identity.value::uuid
    left join public.shared_award_sources candidate_source
      on candidate_source.id = candidate.shared_award_source_id
    where candidate.id is null
      or candidate.candidate_status not in ('selected', 'conflicted')
      or candidate.shared_award_source_id is null
      or candidate_source.id is null
      or candidate_source.shared_award_id is distinct from candidate.shared_award_id
      or not (
        candidate_source.shared_award_id = p_shared_award_id
        or exists (
          select 1
          from public.stage1_award_members target_member
          join public.stage1_award_members source_member
            on source_member.cohort_key = target_member.cohort_key
          where target_member.shared_award_id = p_shared_award_id
            and source_member.shared_award_id = candidate_source.shared_award_id
        )
      )
      or not (
        candidate.shared_award_source_id = any(
          array(
            select source_identity.value::uuid
            from pg_catalog.jsonb_array_elements_text(
              evidence_row.value -> 'source_ids'
            ) source_identity(value)
          )
        )
      )
      or evidence_row.value #>> array[
        'evidence',
        'candidate_bindings',
        candidate_identity.value,
        'source_id'
      ] is distinct from candidate.shared_award_source_id::text
      or evidence_row.value #>> array[
        'evidence',
        'candidate_bindings',
        candidate_identity.value,
        'source_role'
      ] is distinct from candidate.source_role
      or evidence_row.value #>> array[
        'evidence',
        'candidate_bindings',
        candidate_identity.value,
        'field_name'
      ] is distinct from candidate.field_name
      or nullif(pg_catalog.btrim(evidence_row.value #>> array[
        'evidence',
        'candidate_bindings',
        candidate_identity.value,
        'canonical_field_name'
      ]), '') is null
      or evidence_row.value #>> array[
        'evidence',
        'candidate_bindings',
        candidate_identity.value,
        'contributes_to_field'
      ] is distinct from evidence_row.value ->> 'field_name'
      or evidence_row.value #>> array[
        'evidence',
        'candidate_bindings',
        candidate_identity.value,
        'contribution_kind'
      ] is distinct from case
        when evidence_row.value ->> 'field_name' = 'confidence'
          then 'aggregate_confidence'
        else 'direct_selected_value'
      end
      or (
        evidence_row.value ->> 'field_name' <> 'confidence'
        and evidence_row.value #>> array[
          'evidence',
          'candidate_bindings',
          candidate_identity.value,
          'canonical_field_name'
        ] is distinct from evidence_row.value ->> 'field_name'
      )
      or evidence_row.value #> array[
        'evidence',
        'candidate_bindings',
        candidate_identity.value,
        'normalized_value'
      ] is distinct from candidate.normalized_value
      or evidence_row.value #> array[
        'evidence',
        'candidate_bindings',
        candidate_identity.value,
        'selected_value'
      ] is distinct from evidence_row.value -> 'public_value'
      or evidence_row.value #>> array[
        'evidence',
        'candidate_bindings',
        candidate_identity.value,
        'evidence_quote'
      ] is distinct from candidate.evidence_quote
      or evidence_row.value #>> array[
        'evidence',
        'candidate_bindings',
        candidate_identity.value,
        'evidence_location'
      ] is distinct from candidate.evidence_location
      or evidence_row.value #>> array[
        'evidence',
        'candidate_bindings',
        candidate_identity.value,
        'intake_value_sha256'
      ] is distinct from candidate.intake_value_sha256
      or (
        evidence_row.value #>> array[
          'evidence',
          'candidate_bindings',
          candidate_identity.value,
          'extracted_at'
        ]
      )::timestamptz is distinct from candidate.extracted_at
      or evidence_row.value #>> array[
        'evidence',
        'candidate_bindings',
        candidate_identity.value,
        'model'
      ] is distinct from candidate.model
  ) then
    raise exception using
      errcode = '23514',
      message = 'Reconciled fact evidence references a missing or unselected candidate/source binding.';
  end if;

  if exists (
    select 1
    from pg_catalog.unnest(p_source_ids) as source_set(source_id)
    left join public.shared_award_sources source
      on source.id = source_set.source_id
    where source.id is null
      or not (
        source.shared_award_id = p_shared_award_id
        or exists (
          select 1
          from public.stage1_award_members target_member
          join public.stage1_award_members source_member
            on source_member.cohort_key = target_member.cohort_key
          where target_member.shared_award_id = p_shared_award_id
            and source_member.shared_award_id = source.shared_award_id
        )
      )
  ) then
    raise exception using
      errcode = '23503',
      message = 'Reconciled fact evidence references a missing or out-of-scope source.';
  end if;

  delete from public.stage1_award_reconciled_fact_evidence evidence
  where evidence.reconciliation_id = p_reconciliation_id;

  insert into public.stage1_award_reconciled_fact_evidence (
    shared_award_id,
    reconciliation_id,
    field_name,
    public_value,
    candidate_ids,
    source_ids,
    evidence,
    evidence_hash,
    materialized_at
  )
  select
    p_shared_award_id,
    p_reconciliation_id,
    evidence_row.value ->> 'field_name',
    evidence_row.value -> 'public_value',
    array(
      select candidate_identity.value::uuid
      from pg_catalog.jsonb_array_elements_text(
        evidence_row.value -> 'candidate_ids'
      ) candidate_identity(value)
    ),
    array(
      select source_identity.value::uuid
      from pg_catalog.jsonb_array_elements_text(
        evidence_row.value -> 'source_ids'
      ) source_identity(value)
    ),
    evidence_row.value -> 'evidence',
    public.stage1_publication_evidence_hash(evidence_row.value -> 'evidence'),
    v_now
  from pg_catalog.jsonb_array_elements(p_evidence_rows) evidence_row(value);

  get diagnostics v_inserted_count = row_count;
  if v_inserted_count <> pg_catalog.jsonb_array_length(p_evidence_rows) then
    raise exception using
      errcode = 'P0001',
      message = 'Not every reconciled fact evidence row was persisted.';
  end if;

  update public.shared_awards award
  set
    summary = p_summary,
    public_facts = p_public_facts,
    public_facts_generated_at = v_now,
    public_facts_model = 'award-fact-reconciliation',
    confidence = p_confidence,
    last_structure_scan_at = v_now,
    structure_scan_error = null,
    updated_at = v_now
  where award.id = p_shared_award_id
    and award.updated_at = p_expected_award_updated_at
    and award.public_facts = p_expected_public_facts;

  if not found then
    raise exception using
      errcode = '40001',
      message = 'Shared award version changed before publication commit.';
  end if;

  update public.shared_award_reconciliation_queue queue
  set
    status = 'succeeded',
    source_ids = p_source_ids,
    candidate_ids = p_candidate_ids,
    completed_at = v_now,
    error = null
  where queue.id = p_reconciliation_id
    and queue.shared_award_id = p_shared_award_id
    and queue.status = 'processing'
    and queue.started_at = p_expected_started_at
    and queue.completed_at is null
  returning queue.* into v_queue;

  if not found then
    raise exception using
      errcode = '40001',
      message = 'Reconciliation claim changed before publication commit.';
  end if;

  return v_queue;
end;
$$;

revoke execute on function public.commit_award_reconciliation_publication(
  uuid,
  uuid,
  timestamptz,
  bigint,
  timestamptz,
  jsonb,
  text,
  jsonb,
  double precision,
  jsonb,
  uuid[],
  uuid[],
  jsonb,
  jsonb,
  jsonb
) from public, anon, authenticated;

grant execute on function public.commit_award_reconciliation_publication(
  uuid,
  uuid,
  timestamptz,
  bigint,
  timestamptz,
  jsonb,
  text,
  jsonb,
  double precision,
  jsonb,
  uuid[],
  uuid[],
  jsonb,
  jsonb,
  jsonb
) to service_role;

comment on function public.commit_award_reconciliation_publication(
  uuid,
  uuid,
  timestamptz,
  bigint,
  timestamptz,
  jsonb,
  text,
  jsonb,
  double precision,
  jsonb,
  uuid[],
  uuid[],
  jsonb,
  jsonb,
  jsonb
) is
  'CAS-protected atomic commit for candidate materialization/disposition, deterministic audit, reconciled public facts, immutable fact evidence, and queue success. Service role only.';
