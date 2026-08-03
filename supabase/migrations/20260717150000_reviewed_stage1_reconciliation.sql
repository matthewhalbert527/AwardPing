-- Commit an explicitly human-reviewed Stage 1 candidate selection while
-- preserving the existing atomic reconciliation publication boundary.

create or replace function private.stage1_canonical_json_text(p_value jsonb)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select case pg_catalog.jsonb_typeof(p_value)
    when 'object' then (
      select '{' || coalesce(pg_catalog.string_agg(
        pg_catalog.to_jsonb(entry.key)::text || ':' ||
          private.stage1_canonical_json_text(entry.value),
        ',' order by entry.key collate "C"
      ), '') || '}'
      from pg_catalog.jsonb_each(p_value) entry
    )
    when 'array' then (
      select '[' || coalesce(pg_catalog.string_agg(
        private.stage1_canonical_json_text(entry.value),
        ',' order by entry.ordinality
      ), '') || ']'
      from pg_catalog.jsonb_array_elements(p_value)
        with ordinality entry(value, ordinality)
    )
    else p_value::text
  end
$$;

create or replace function private.stage1_canonical_json_sha256(p_value jsonb)
returns text
language sql
stable
strict
set search_path = ''
as $$
  select private.stage1_pgcrypto_sha256(
    pg_catalog.convert_to(private.stage1_canonical_json_text(p_value), 'UTF8')
  )
$$;

create or replace function private.stage1_text_sha256(p_value text)
returns text
language sql
stable
strict
set search_path = ''
as $$
  select private.stage1_pgcrypto_sha256(pg_catalog.convert_to(p_value, 'UTF8'))
$$;

revoke all on function private.stage1_canonical_json_text(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function private.stage1_canonical_json_sha256(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function private.stage1_text_sha256(text)
  from public, anon, authenticated, service_role;

create or replace function private.stage1_safe_uuid(p_value text)
returns uuid
language plpgsql
immutable
set search_path = ''
as $$
begin
  if coalesce(p_value, '') !~*
    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return null;
  end if;
  return p_value::uuid;
exception when invalid_text_representation then
  return null;
end;
$$;

revoke all on function private.stage1_safe_uuid(text)
  from public, anon, authenticated, service_role;

create or replace function private.stage1_review_fact_bijection_valid(
  p_public_facts jsonb,
  p_field_choices jsonb,
  p_evidence_rows jsonb,
  p_candidate_ids uuid[]
)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_allowed_fields constant text[] := array[
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
  ]::text[];
  v_choice jsonb;
  v_evidence_row jsonb;
  v_field_name text;
  v_composition_method text;
  v_public_value jsonb;
  v_choice_candidate_ids jsonb;
  v_choice_candidate_evidence jsonb;
  v_candidate_count integer;
  v_candidate_index integer;
  v_candidate_id text;
  v_matching_evidence_count integer;
  v_non_empty_fact_count integer;
  v_candidate_occurrence_count integer := 0;
  v_distinct_candidate_count integer;
begin
  if pg_catalog.jsonb_typeof(p_public_facts) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_field_choices) is distinct from 'array'
    or pg_catalog.jsonb_typeof(p_evidence_rows) is distinct from 'array'
    or pg_catalog.cardinality(p_candidate_ids) is null
    or pg_catalog.cardinality(p_candidate_ids) = 0 then
    return false;
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_object_keys(p_public_facts) fact(field_name)
    where not (fact.field_name = any(v_allowed_fields))
  ) then
    return false;
  end if;

  select pg_catalog.count(*)::integer
  into v_non_empty_fact_count
  from pg_catalog.jsonb_each(p_public_facts) fact(field_name, public_value)
  where fact.field_name = any(v_allowed_fields)
    and fact.public_value not in (
      'null'::jsonb,
      '""'::jsonb,
      '[]'::jsonb,
      '{}'::jsonb
    );

  if v_non_empty_fact_count = 0
    or pg_catalog.jsonb_array_length(p_field_choices) <> v_non_empty_fact_count
    or pg_catalog.jsonb_array_length(p_evidence_rows) <> v_non_empty_fact_count then
    return false;
  end if;

  for v_evidence_row in
    select evidence.row_value
    from pg_catalog.jsonb_array_elements(p_evidence_rows) evidence(row_value)
  loop
    if not private.stage1_jsonb_has_exact_keys(
      v_evidence_row,
      array[
        'field_name',
        'public_value',
        'candidate_ids',
        'source_ids',
        'evidence'
      ]::text[]
    )
      or nullif(pg_catalog.btrim(v_evidence_row ->> 'field_name'), '') is null
      or not (v_evidence_row ? 'public_value')
      or pg_catalog.jsonb_typeof(
        v_evidence_row -> 'candidate_ids'
      ) is distinct from 'array'
      or pg_catalog.jsonb_typeof(
        v_evidence_row #> array['evidence', 'candidate_bindings']
      ) is distinct from 'object' then
      return false;
    end if;

    v_field_name := v_evidence_row ->> 'field_name';
    if not (v_field_name = any(v_allowed_fields))
      or not (p_public_facts ? v_field_name)
      or p_public_facts -> v_field_name in (
        'null'::jsonb,
        '""'::jsonb,
        '[]'::jsonb,
        '{}'::jsonb
      )
      or v_evidence_row -> 'public_value' is distinct from
        p_public_facts -> v_field_name
      or (
        select pg_catalog.count(*)
        from pg_catalog.jsonb_array_elements(p_field_choices) choice(row_value)
        where choice.row_value ->> 'field_name' = v_field_name
      ) <> 1 then
      return false;
    end if;
  end loop;

  for v_choice in
    select choice.row_value
    from pg_catalog.jsonb_array_elements(p_field_choices) choice(row_value)
  loop
    if not private.stage1_jsonb_has_exact_keys(
      v_choice,
      array[
        'field_name',
        'candidate_ids',
        'composition_method',
        'candidate_evidence'
      ]::text[]
    ) then
      return false;
    end if;

    v_field_name := nullif(pg_catalog.btrim(v_choice ->> 'field_name'), '');
    v_composition_method := v_choice ->> 'composition_method';
    v_choice_candidate_ids := v_choice -> 'candidate_ids';
    v_choice_candidate_evidence := v_choice -> 'candidate_evidence';

    if v_field_name is null
      or not (v_field_name = any(v_allowed_fields))
      or not (p_public_facts ? v_field_name)
      or p_public_facts -> v_field_name in (
        'null'::jsonb,
        '""'::jsonb,
        '[]'::jsonb,
        '{}'::jsonb
      )
      or pg_catalog.jsonb_typeof(v_choice_candidate_ids) is distinct from 'array'
      or pg_catalog.jsonb_typeof(
        v_choice_candidate_evidence
      ) is distinct from 'array' then
      return false;
    end if;

    v_public_value := p_public_facts -> v_field_name;
    v_candidate_count := pg_catalog.jsonb_array_length(v_choice_candidate_ids);
    if v_candidate_count = 0
      or pg_catalog.jsonb_array_length(v_choice_candidate_evidence) <>
        v_candidate_count
      or (
        v_composition_method = 'direct_exact'
        and v_candidate_count <> 1
      )
      or (
        v_composition_method = 'ordered_array_items'
        and (
          pg_catalog.jsonb_typeof(v_public_value) is distinct from 'array'
          or pg_catalog.jsonb_array_length(v_public_value) <> v_candidate_count
        )
      )
      or v_composition_method not in ('direct_exact', 'ordered_array_items') then
      return false;
    end if;

    select pg_catalog.count(*)::integer
    into v_matching_evidence_count
    from pg_catalog.jsonb_array_elements(p_evidence_rows) evidence(row_value)
    where evidence.row_value ->> 'field_name' = v_field_name
      and evidence.row_value -> 'public_value' is not distinct from v_public_value;

    if v_matching_evidence_count <> 1 then
      return false;
    end if;

    select evidence.row_value
    into v_evidence_row
    from pg_catalog.jsonb_array_elements(p_evidence_rows) evidence(row_value)
    where evidence.row_value ->> 'field_name' = v_field_name
      and evidence.row_value -> 'public_value' is not distinct from v_public_value;

    if v_evidence_row -> 'candidate_ids' is distinct from v_choice_candidate_ids
      or (
        select pg_catalog.count(*)
        from pg_catalog.jsonb_object_keys(
          v_evidence_row #> array['evidence', 'candidate_bindings']
        ) binding(candidate_id)
      ) <> v_candidate_count then
      return false;
    end if;

    for v_candidate_index in 0..(v_candidate_count - 1)
    loop
      v_candidate_id := v_choice_candidate_ids ->> v_candidate_index;
      if private.stage1_safe_uuid(v_candidate_id) is null
        or not (private.stage1_safe_uuid(v_candidate_id) = any(p_candidate_ids))
        or not private.stage1_jsonb_has_exact_keys(
          v_choice_candidate_evidence -> v_candidate_index,
          array[
            'candidate_id',
            'source_id',
            'evidence_quote',
            'evidence_location',
            'capture_text_sha256',
            'capture_text_object_key'
          ]::text[]
        )
        or v_choice_candidate_evidence -> v_candidate_index ->> 'candidate_id'
          is distinct from v_candidate_id
        or not (
          v_evidence_row #> array['evidence', 'candidate_bindings'] ?
            v_candidate_id
        )
        or pg_catalog.jsonb_typeof(
          v_evidence_row #> array[
            'evidence', 'candidate_bindings', v_candidate_id
          ]
        ) is distinct from 'object' then
        return false;
      end if;
    end loop;

    v_candidate_occurrence_count := v_candidate_occurrence_count +
      v_candidate_count;
  end loop;

  select pg_catalog.count(distinct selected.candidate_id)::integer
  into v_distinct_candidate_count
  from pg_catalog.jsonb_array_elements(p_field_choices) choice(row_value)
  cross join lateral pg_catalog.jsonb_array_elements_text(
    choice.row_value -> 'candidate_ids'
  ) selected(candidate_id);

  return v_candidate_occurrence_count = pg_catalog.cardinality(p_candidate_ids)
    and v_distinct_candidate_count = pg_catalog.cardinality(p_candidate_ids);
end;
$$;

revoke all on function private.stage1_review_fact_bijection_valid(
  jsonb, jsonb, jsonb, uuid[]
) from public, anon, authenticated, service_role;

create or replace function private.stage1_reviewed_evidence_rows_sha256(
  p_evidence_rows jsonb
)
returns text
language sql
stable
strict
set search_path = ''
as $$
  select private.stage1_canonical_json_sha256(
    coalesce(
      (
        select pg_catalog.jsonb_agg(
          evidence.row_value
          order by (evidence.row_value ->> 'field_name') collate "C"
        )
        from pg_catalog.jsonb_array_elements(p_evidence_rows) evidence(row_value)
      ),
      '[]'::jsonb
    )
  )
$$;

create or replace function private.stage1_reviewed_audit_row_sha256(
  p_audit_row jsonb
)
returns text
language sql
stable
strict
set search_path = ''
as $$
  select private.stage1_canonical_json_sha256(p_audit_row)
$$;

revoke all on function private.stage1_reviewed_evidence_rows_sha256(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function private.stage1_reviewed_audit_row_sha256(jsonb)
  from public, anon, authenticated, service_role;

create table private.stage1_human_review_roots (
  root_sha256 text primary key,
  schema_version text not null,
  policy_version text not null,
  cohort_key text not null,
  canonical_shared_award_id uuid not null,
  public_facts_sha256 text not null,
  summary_sha256 text not null,
  confidence_sha256 text not null,
  evidence_rows_sha256 text not null,
  audit_row_sha256 text not null,
  review_root jsonb not null,
  reviewed_at timestamptz not null,
  created_at timestamptz not null default pg_catalog.statement_timestamp(),
  constraint stage1_human_review_root_hash_check check (
    root_sha256 ~ '^[0-9a-f]{64}$'
    and public_facts_sha256 ~ '^[0-9a-f]{64}$'
    and summary_sha256 ~ '^[0-9a-f]{64}$'
    and confidence_sha256 ~ '^[0-9a-f]{64}$'
    and evidence_rows_sha256 ~ '^[0-9a-f]{64}$'
    and audit_row_sha256 ~ '^[0-9a-f]{64}$'
  ),
  constraint stage1_human_review_root_schema_check check (
    schema_version = 'awardping.stage1.human-review-root.v1'
    and policy_version = 'stage1-publication-v1'
  ),
  constraint stage1_human_review_root_payload_check check (
    case
      when pg_catalog.jsonb_typeof(review_root) = 'object'
        and pg_catalog.jsonb_typeof(review_root -> 'cohorts') = 'array'
      then review_root ->> 'schema_version' = schema_version
        and review_root ->> 'policy_version' = policy_version
        and pg_catalog.jsonb_array_length(review_root -> 'cohorts') = 1
        and review_root #>> array['cohorts', '0', 'cohort_key'] = cohort_key
        and private.stage1_canonical_json_sha256(
          review_root #> array['cohorts', '0', 'public_facts']
        ) = public_facts_sha256
        and private.stage1_jsonb_has_exact_keys(
          review_root #> array['cohorts', '0', 'publication'],
          array['summary', 'confidence']::text[]
        ) is true
        and nullif(pg_catalog.btrim(review_root #>> array[
          'cohorts', '0', 'publication', 'summary'
        ]), '') is not null
        and pg_catalog.jsonb_typeof(review_root #> array[
          'cohorts', '0', 'publication', 'confidence'
        ]) = 'number'
        and private.stage1_text_sha256(
          review_root #>> array['cohorts', '0', 'publication', 'summary']
        ) = summary_sha256
        and private.stage1_canonical_json_sha256(
          review_root #> array['cohorts', '0', 'publication', 'confidence']
        ) = confidence_sha256
        and review_root #>> array[
          'cohorts', '0', 'canonical_award', 'id'
        ] = canonical_shared_award_id::text
      else false
    end
  ),
  constraint stage1_human_review_root_cohort_fk foreign key (cohort_key)
    references public.stage1_award_registry(cohort_key) on delete restrict,
  constraint stage1_human_review_root_award_fk foreign key (
    canonical_shared_award_id
  ) references public.shared_awards(id) on delete restrict
);

create table private.stage1_reviewed_reconciliation_authorizations (
  reconciliation_id uuid primary key,
  canonical_shared_award_id uuid not null,
  root_sha256 text not null,
  public_facts_sha256 text not null,
  summary_sha256 text not null,
  confidence_sha256 text not null,
  evidence_rows_sha256 text not null,
  audit_row_sha256 text not null,
  created_at timestamptz not null default pg_catalog.statement_timestamp(),
  constraint stage1_reviewed_reconciliation_authorization_hash_check check (
    root_sha256 ~ '^[0-9a-f]{64}$'
    and public_facts_sha256 ~ '^[0-9a-f]{64}$'
    and summary_sha256 ~ '^[0-9a-f]{64}$'
    and confidence_sha256 ~ '^[0-9a-f]{64}$'
    and evidence_rows_sha256 ~ '^[0-9a-f]{64}$'
    and audit_row_sha256 ~ '^[0-9a-f]{64}$'
  ),
  constraint stage1_reviewed_reconciliation_authorization_queue_fk
    foreign key (reconciliation_id)
    references public.shared_award_reconciliation_queue(id) on delete cascade,
  constraint stage1_reviewed_reconciliation_authorization_award_fk
    foreign key (canonical_shared_award_id)
    references public.shared_awards(id) on delete restrict,
  constraint stage1_reviewed_reconciliation_authorization_root_fk
    foreign key (root_sha256)
    references private.stage1_human_review_roots(root_sha256) on delete restrict
);

alter table private.stage1_human_review_roots enable row level security;
revoke all on table private.stage1_human_review_roots
  from public, anon, authenticated, service_role;
grant select on table private.stage1_human_review_roots to service_role;
create policy stage1_human_review_roots_service_read
on private.stage1_human_review_roots
for select
to service_role
using (true);

alter table private.stage1_reviewed_reconciliation_authorizations
  enable row level security;
revoke all on table private.stage1_reviewed_reconciliation_authorizations
  from public, anon, authenticated, service_role;

create or replace function private.prevent_stage1_human_review_root_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception using
    errcode = '55000',
    message = 'Stage 1 human-review roots are immutable.';
end;
$$;

revoke all on function private.prevent_stage1_human_review_root_mutation()
  from public, anon, authenticated, service_role;

create trigger prevent_stage1_human_review_root_mutation
before update or delete on private.stage1_human_review_roots
for each row
execute function private.prevent_stage1_human_review_root_mutation();

comment on table private.stage1_human_review_roots is
  'Private immutable full human-review roots bound to the exact public facts, derived summary/confidence projection, evidence rows, and deterministic audit row. Public records retain only non-sensitive hashes and bindings; service_role has read-only audit access.';

comment on table private.stage1_reviewed_reconciliation_authorizations is
  'Private one-time queue/root/payload capabilities inserted only by the reviewed wrapper and atomically consumed by the Stage 1 success trigger. No API role receives table privileges.';

create or replace function public.get_stage1_human_review_root(
  p_root_sha256 text
)
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_stored private.stage1_human_review_roots%rowtype;
  v_recomputed text;
begin
  if coalesce(p_root_sha256, '') !~ '^[0-9a-f]{64}$' then
    raise exception using
      errcode = '22023',
      message = 'A lowercase 64-hex Stage 1 human-review root hash is required.';
  end if;

  select stored.*
  into v_stored
  from private.stage1_human_review_roots stored
  where stored.root_sha256 = p_root_sha256;

  if not found then
    return null;
  end if;
  v_recomputed := private.stage1_canonical_json_sha256(v_stored.review_root);
  return pg_catalog.jsonb_build_object(
    'schema_version', 'awardping.stage1.human-review-root-retrieval.v1',
    'root_sha256', v_stored.root_sha256,
    'recomputed_sha256', v_recomputed,
    'hash_matches', v_recomputed = v_stored.root_sha256,
    'cohort_key', v_stored.cohort_key,
    'canonical_shared_award_id', v_stored.canonical_shared_award_id,
    'public_facts_sha256', v_stored.public_facts_sha256,
    'summary_sha256', v_stored.summary_sha256,
    'confidence_sha256', v_stored.confidence_sha256,
    'evidence_rows_sha256', v_stored.evidence_rows_sha256,
    'audit_row_sha256', v_stored.audit_row_sha256,
    'reviewed_at', v_stored.reviewed_at,
    'created_at', v_stored.created_at,
    'review_root', v_stored.review_root
  );
end;
$$;

revoke execute on function public.get_stage1_human_review_root(text)
  from public, anon, authenticated;
grant execute on function public.get_stage1_human_review_root(text)
  to service_role;

comment on function public.get_stage1_human_review_root(text) is
  'Service-only recovery/audit reader for one exact private immutable human-review root. Recomputes the canonical hash before returning the full root; browser roles have no access.';

create or replace function private.enforce_stage1_reviewed_reconciliation_success()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_consumed_authorization uuid;
begin
  if new.status = 'succeeded'
    and old.status is distinct from 'succeeded'
    and exists (
      select 1
      from public.stage1_award_registry registry
      where registry.canonical_shared_award_id = new.shared_award_id
    ) then
    if new.reason is distinct from 'explicit_human_review'
      or new.metadata ->> 'processor' is distinct from
        'reconcile-reviewed-stage1-selection'
      or new.metadata ->> 'selection_mode' is distinct from
        'explicit_human_review'
      or new.metadata ->> 'stage1_review_root_schema_version' is distinct from
        'awardping.stage1.human-review-root.v1'
      or coalesce(new.metadata ->> 'stage1_review_root_sha256', '')
        !~ '^[0-9a-f]{64}$'
      or coalesce(
        new.metadata ->> 'stage1_reviewed_public_facts_sha256', ''
      ) !~ '^[0-9a-f]{64}$'
      or coalesce(
        new.metadata ->> 'stage1_reviewed_summary_sha256', ''
      ) !~ '^[0-9a-f]{64}$'
      or coalesce(
        new.metadata ->> 'stage1_reviewed_confidence_sha256', ''
      ) !~ '^[0-9a-f]{64}$'
      or coalesce(
        new.metadata ->> 'stage1_reviewed_evidence_rows_sha256', ''
      ) !~ '^[0-9a-f]{64}$'
      or coalesce(
        new.metadata ->> 'stage1_reviewed_audit_row_sha256', ''
      ) !~ '^[0-9a-f]{64}$'
      or coalesce(
        new.metadata ->> 'stage1_reviewed_audit_signature', ''
      ) !~ '^[0-9a-f]{64}$'
      or pg_catalog.jsonb_typeof(
        new.metadata -> 'reviewed_contributor_source_ids'
      ) is distinct from 'array'
      or pg_catalog.jsonb_typeof(
        new.metadata -> 'reviewed_candidate_ids'
      ) is distinct from 'array'
      or new.metadata -> 'reviewed_contributor_source_ids'
        is distinct from pg_catalog.to_jsonb(new.source_ids)
      or new.metadata -> 'reviewed_candidate_ids'
        is distinct from pg_catalog.to_jsonb(new.candidate_ids)
      or not exists (
        select 1
        from private.stage1_human_review_roots review_root
        join private.stage1_reviewed_reconciliation_authorizations authz
          on authz.root_sha256 = review_root.root_sha256
          and authz.reconciliation_id = new.id
          and authz.canonical_shared_award_id = new.shared_award_id
          and authz.public_facts_sha256 =
            review_root.public_facts_sha256
          and authz.summary_sha256 = review_root.summary_sha256
          and authz.confidence_sha256 = review_root.confidence_sha256
          and authz.evidence_rows_sha256 =
            review_root.evidence_rows_sha256
          and authz.audit_row_sha256 = review_root.audit_row_sha256
        where review_root.root_sha256 =
            new.metadata ->> 'stage1_review_root_sha256'
          and review_root.schema_version =
            'awardping.stage1.human-review-root.v1'
          and review_root.policy_version = 'stage1-publication-v1'
          and review_root.canonical_shared_award_id = new.shared_award_id
          and review_root.public_facts_sha256 =
            new.metadata ->> 'stage1_reviewed_public_facts_sha256'
          and review_root.summary_sha256 =
            new.metadata ->> 'stage1_reviewed_summary_sha256'
          and review_root.confidence_sha256 =
            new.metadata ->> 'stage1_reviewed_confidence_sha256'
          and review_root.evidence_rows_sha256 =
            new.metadata ->> 'stage1_reviewed_evidence_rows_sha256'
          and review_root.audit_row_sha256 =
            new.metadata ->> 'stage1_reviewed_audit_row_sha256'
          and review_root.public_facts_sha256 = (
            select private.stage1_canonical_json_sha256(award.public_facts)
            from public.shared_awards award
            where award.id = new.shared_award_id
          )
          and review_root.summary_sha256 = (
            select private.stage1_text_sha256(award.summary)
            from public.shared_awards award
            where award.id = new.shared_award_id
          )
          and review_root.confidence_sha256 = (
            select private.stage1_canonical_json_sha256(
              pg_catalog.to_jsonb(award.confidence)
            )
            from public.shared_awards award
            where award.id = new.shared_award_id
          )
          and review_root.evidence_rows_sha256 =
            private.stage1_reviewed_evidence_rows_sha256(
              coalesce(
                (
                  select pg_catalog.jsonb_agg(
                    pg_catalog.jsonb_build_object(
                      'field_name', evidence.field_name,
                      'public_value', evidence.public_value,
                      'candidate_ids', pg_catalog.to_jsonb(evidence.candidate_ids),
                      'source_ids', pg_catalog.to_jsonb(evidence.source_ids),
                      'evidence', evidence.evidence
                    )
                    order by evidence.field_name
                  )
                  from public.stage1_award_reconciled_fact_evidence evidence
                  where evidence.reconciliation_id = new.id
                    and evidence.shared_award_id = new.shared_award_id
                ),
                '[]'::jsonb
              )
            )
          and review_root.audit_row_sha256 = (
            select private.stage1_reviewed_audit_row_sha256(
              pg_catalog.jsonb_build_object(
                'shared_award_id', audit.shared_award_id,
                'audit_kind', audit.audit_kind,
                'audit_status', audit.audit_status,
                'severity', audit.severity,
                'findings', audit.findings,
                'suggested_fixes', audit.suggested_fixes,
                'field_conflicts', audit.field_conflicts,
                'source_rejections', audit.source_rejections,
                'selected_fact_summary', audit.selected_fact_summary,
                'public_page_snapshot', audit.public_page_snapshot,
                'model', audit.model
              )
            )
            from public.shared_award_page_audits audit
            where audit.shared_award_id = new.shared_award_id
              and audit.audit_kind = 'deterministic'
              and audit.public_page_snapshot ->> 'reconciliation_audit_signature'
                = new.metadata ->> 'stage1_reviewed_audit_signature'
            order by audit.created_at desc, audit.id desc
            limit 1
          )
          and exists (
            select 1
            from public.stage1_award_registry registry
            where registry.cohort_key = review_root.cohort_key
              and registry.canonical_shared_award_id = new.shared_award_id
              and registry.policy_version = review_root.policy_version
          )
          and pg_catalog.cardinality(new.candidate_ids) = (
            select pg_catalog.count(distinct reviewed_candidate.value)
            from pg_catalog.jsonb_array_elements(
              review_root.review_root -> 'cohorts'
            ) reviewed_cohort(value)
            cross join lateral pg_catalog.jsonb_array_elements(
              reviewed_cohort.value -> 'field_choices'
            ) reviewed_choice(value)
            cross join lateral pg_catalog.jsonb_array_elements_text(
              reviewed_choice.value -> 'candidate_ids'
            ) reviewed_candidate(value)
          )
          and not exists (
            select 1
            from pg_catalog.jsonb_array_elements(
              review_root.review_root -> 'cohorts'
            ) reviewed_cohort(value)
            cross join lateral pg_catalog.jsonb_array_elements(
              reviewed_cohort.value -> 'field_choices'
            ) reviewed_choice(value)
            cross join lateral pg_catalog.jsonb_array_elements_text(
              reviewed_choice.value -> 'candidate_ids'
            ) reviewed_candidate(value)
            where private.stage1_safe_uuid(reviewed_candidate.value) is null
              or not (
                private.stage1_safe_uuid(reviewed_candidate.value) =
                  any(new.candidate_ids)
              )
          )
          and pg_catalog.cardinality(new.source_ids) = (
            select pg_catalog.count(distinct reviewed_evidence.value ->> 'source_id')
            from pg_catalog.jsonb_array_elements(
              review_root.review_root -> 'cohorts'
            ) reviewed_cohort(value)
            cross join lateral pg_catalog.jsonb_array_elements(
              reviewed_cohort.value -> 'field_choices'
            ) reviewed_choice(value)
            cross join lateral pg_catalog.jsonb_array_elements(
              reviewed_choice.value -> 'candidate_evidence'
            ) reviewed_evidence(value)
          )
          and not exists (
            select 1
            from pg_catalog.jsonb_array_elements(
              review_root.review_root -> 'cohorts'
            ) reviewed_cohort(value)
            cross join lateral pg_catalog.jsonb_array_elements(
              reviewed_cohort.value -> 'field_choices'
            ) reviewed_choice(value)
            cross join lateral pg_catalog.jsonb_array_elements(
              reviewed_choice.value -> 'candidate_evidence'
            ) reviewed_evidence(value)
            where private.stage1_safe_uuid(
                reviewed_evidence.value ->> 'source_id'
              ) is null
              or not (
                private.stage1_safe_uuid(
                  reviewed_evidence.value ->> 'source_id'
                ) = any(new.source_ids)
              )
          )
      ) then
      raise exception using
        errcode = '23514',
        message = 'Stage 1 reconciliation success requires the exact reviewed human-review-root workflow and one-time payload authorization.';
    end if;

    delete from private.stage1_reviewed_reconciliation_authorizations authz
    using private.stage1_human_review_roots review_root
    where authz.reconciliation_id = new.id
      and authz.canonical_shared_award_id = new.shared_award_id
      and authz.root_sha256 =
        new.metadata ->> 'stage1_review_root_sha256'
      and authz.public_facts_sha256 =
        new.metadata ->> 'stage1_reviewed_public_facts_sha256'
      and authz.summary_sha256 =
        new.metadata ->> 'stage1_reviewed_summary_sha256'
      and authz.confidence_sha256 =
        new.metadata ->> 'stage1_reviewed_confidence_sha256'
      and authz.evidence_rows_sha256 =
        new.metadata ->> 'stage1_reviewed_evidence_rows_sha256'
      and authz.audit_row_sha256 =
        new.metadata ->> 'stage1_reviewed_audit_row_sha256'
      and review_root.root_sha256 = authz.root_sha256
      and review_root.public_facts_sha256 = authz.public_facts_sha256
      and review_root.summary_sha256 = authz.summary_sha256
      and review_root.confidence_sha256 = authz.confidence_sha256
      and review_root.evidence_rows_sha256 = authz.evidence_rows_sha256
      and review_root.audit_row_sha256 = authz.audit_row_sha256
    returning authz.reconciliation_id into v_consumed_authorization;

    if v_consumed_authorization is null then
      raise exception using
        errcode = '23514',
        message = 'The reviewed Stage 1 payload authorization was absent or already consumed.';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function private.enforce_stage1_reviewed_reconciliation_success()
  from public, anon, authenticated, service_role;

drop trigger if exists enforce_stage1_reviewed_reconciliation_success
  on public.shared_award_reconciliation_queue;
create trigger enforce_stage1_reviewed_reconciliation_success
before update of status on public.shared_award_reconciliation_queue
for each row
execute function private.enforce_stage1_reviewed_reconciliation_success();

create or replace function public.commit_reviewed_stage1_reconciliation_publication(
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
  p_audit_row jsonb,
  p_review_binding jsonb
)
returns public.shared_award_reconciliation_queue
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cohort_key text;
  v_audit_id uuid;
  v_public_facts_sha256 text;
  v_summary_sha256 text;
  v_confidence_sha256 text;
  v_evidence_rows_sha256 text;
  v_audit_row_sha256 text;
  v_persisted_audit_row_sha256 text;
  v_expected_audit_projection jsonb;
  v_expected_audit_base jsonb;
  v_expected_audit_row jsonb;
  v_expected_selected_fact_summary jsonb;
  v_stored_review_root private.stage1_human_review_roots%rowtype;
  v_result public.shared_award_reconciliation_queue%rowtype;
  v_now timestamptz := statement_timestamp();
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('stage1-national-25-release', 0)
  );

  if pg_catalog.jsonb_typeof(p_review_binding) is distinct from 'object'
    or p_review_binding ->> 'schema_version' is distinct from
      'awardping.stage1.reviewed-reconciliation-commit.v1'
    or p_review_binding ->> 'policy_version' is distinct from
      'stage1-publication-v1'
    or p_review_binding ->> 'canonical_shared_award_id' is distinct from
      p_shared_award_id::text
    or p_review_binding -> 'public_facts' is distinct from p_public_facts
    or coalesce(p_review_binding ->> 'selection_sha256', '') !~ '^[0-9a-f]{64}$'
    or p_review_binding ->> 'stage1_review_root_schema_version' is distinct from
      'awardping.stage1.human-review-root.v1'
    or coalesce(p_review_binding ->> 'stage1_review_root_sha256', '')
      !~ '^[0-9a-f]{64}$'
    or p_review_binding ->> 'stage1_review_root_sha256' is distinct from
      p_review_binding ->> 'selection_sha256'
    or pg_catalog.jsonb_typeof(p_review_binding -> 'review_root') is distinct from
      'object'
    or p_review_binding #>> array['review_root', 'schema_version'] is distinct from
      'awardping.stage1.human-review-root.v1'
    or p_review_binding #>> array['review_root', 'policy_version'] is distinct from
      'stage1-publication-v1'
    or private.stage1_canonical_json_sha256(
      p_review_binding -> 'review_root'
    ) is distinct from p_review_binding ->> 'stage1_review_root_sha256'
    or pg_catalog.jsonb_typeof(
      p_review_binding #> array['review_root', 'cohorts']
    ) is distinct from 'array'
    or pg_catalog.jsonb_array_length(
      p_review_binding #> array['review_root', 'cohorts']
    ) <> 1
    or p_review_binding #>> array['review', 'selection_method'] is distinct from
      'explicit_human_review'
    or p_review_binding #> array[
      'review', 'auto_accept_ranked_candidates'
    ] is distinct from
      'false'::jsonb
    or p_review_binding #> array['review', 'materialize_candidates'] is distinct from
      'false'::jsonb
    or nullif(pg_catalog.btrim(p_review_binding #>> array['review', 'reviewed_by']), '')
      is null
    or nullif(pg_catalog.btrim(p_review_binding #>> array['review', 'reason']), '')
      is null
    or pg_catalog.jsonb_typeof(p_review_binding -> 'source_ids') is distinct from
      'array'
    or pg_catalog.jsonb_typeof(
      p_review_binding -> 'review_source_ids'
    ) is distinct from 'array'
    or pg_catalog.jsonb_typeof(p_review_binding -> 'candidate_ids') is distinct from
      'array'
    or pg_catalog.jsonb_typeof(p_review_binding -> 'source_snapshots') is distinct from
      'array'
    or pg_catalog.jsonb_typeof(p_review_binding -> 'candidate_versions') is distinct from
      'array'
    or pg_catalog.jsonb_typeof(p_evidence_rows) is distinct from 'array'
    or p_review_binding #>> array['award', 'id'] is distinct from
      p_shared_award_id::text
    or private.stage1_safe_timestamptz(
      p_review_binding #>> array['award', 'updated_at']
    ) is distinct from p_expected_award_updated_at
    or p_review_binding #> array['award', 'current_public_facts']
      is distinct from p_expected_public_facts
    or p_review_binding #> array['award', 'replacement_public_facts']
      is distinct from p_public_facts
    or p_review_binding #>> array['award', 'replacement_summary']
      is distinct from p_summary
    or p_review_binding #> array['award', 'replacement_confidence']
      is distinct from pg_catalog.to_jsonb(p_confidence)
    or p_review_binding #>> array[
      'review_root', 'cohorts', '0', 'publication', 'summary'
    ] is distinct from p_summary
    or p_review_binding #> array[
      'review_root', 'cohorts', '0', 'publication', 'confidence'
    ] is distinct from pg_catalog.to_jsonb(p_confidence)
    or coalesce(p_review_binding #>> array[
      'award', 'current_public_facts_sha256'
    ], '') !~ '^[0-9a-f]{64}$'
    or coalesce(p_review_binding #>> array[
      'award', 'replacement_public_facts_sha256'
    ], '') !~ '^[0-9a-f]{64}$'
    or coalesce(p_review_binding #>> array[
      'award', 'replacement_summary_sha256'
    ], '') !~ '^[0-9a-f]{64}$'
    or coalesce(p_review_binding #>> array[
      'award', 'replacement_confidence_sha256'
    ], '') !~ '^[0-9a-f]{64}$'
    or private.stage1_canonical_json_sha256(
      p_review_binding #> array['award', 'current_public_facts']
    ) is distinct from p_review_binding #>> array[
      'award', 'current_public_facts_sha256'
    ]
    or private.stage1_canonical_json_sha256(
      p_review_binding #> array['award', 'replacement_public_facts']
    ) is distinct from p_review_binding #>> array[
      'award', 'replacement_public_facts_sha256'
    ]
    or private.stage1_text_sha256(
      p_review_binding #>> array['award', 'replacement_summary']
    ) is distinct from p_review_binding #>> array[
      'award', 'replacement_summary_sha256'
    ]
    or private.stage1_canonical_json_sha256(
      p_review_binding #> array['award', 'replacement_confidence']
    ) is distinct from p_review_binding #>> array[
      'award', 'replacement_confidence_sha256'
    ]
    or private.stage1_jsonb_has_exact_keys(
      p_audit_row,
      array[
        'shared_award_id',
        'audit_kind',
        'audit_status',
        'severity',
        'findings',
        'suggested_fixes',
        'field_conflicts',
        'source_rejections',
        'selected_fact_summary',
        'public_page_snapshot',
        'model'
      ]::text[]
    ) is distinct from true
    or p_audit_row #>> array[
      'selected_fact_summary', 'stage1_review_root_schema_version'
    ] is distinct from p_review_binding ->> 'stage1_review_root_schema_version'
    or p_audit_row #>> array[
      'selected_fact_summary', 'stage1_review_root_sha256'
    ] is distinct from p_review_binding ->> 'stage1_review_root_sha256'
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_evidence_rows) evidence(row_value)
      where evidence.row_value #>> array[
          'evidence', 'stage1_review_root_schema_version'
        ] is distinct from
          p_review_binding ->> 'stage1_review_root_schema_version'
        or evidence.row_value #>> array[
          'evidence', 'stage1_review_root_sha256'
        ] is distinct from p_review_binding ->> 'stage1_review_root_sha256'
    )
    or pg_catalog.jsonb_typeof(p_generated_candidates) is distinct from 'array'
    or pg_catalog.jsonb_typeof(p_candidate_status_updates) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_generated_candidates) <> 0 then
    raise exception using
      errcode = '22023',
      message = 'The reviewed Stage 1 selection binding is incomplete or permits automatic materialization.';
  end if;

  v_public_facts_sha256 := private.stage1_canonical_json_sha256(p_public_facts);
  v_summary_sha256 := private.stage1_text_sha256(p_summary);
  v_confidence_sha256 := private.stage1_canonical_json_sha256(
    pg_catalog.to_jsonb(p_confidence)
  );
  v_evidence_rows_sha256 :=
    private.stage1_reviewed_evidence_rows_sha256(p_evidence_rows);
  if v_public_facts_sha256 is distinct from p_review_binding #>> array[
    'award', 'replacement_public_facts_sha256'
  ]
    or v_summary_sha256 is distinct from p_review_binding #>> array[
      'award', 'replacement_summary_sha256'
    ]
    or v_confidence_sha256 is distinct from p_review_binding #>> array[
      'award', 'replacement_confidence_sha256'
    ] then
    raise exception using
      errcode = '22023',
      message = 'The reviewed Stage 1 publication projection changed before commit.';
  end if;

  v_expected_audit_projection := pg_catalog.jsonb_build_object(
    'stage1_review_root_schema_version',
      p_review_binding ->> 'stage1_review_root_schema_version',
    'stage1_review_root_sha256',
      p_review_binding ->> 'stage1_review_root_sha256',
    'stage1_reviewed_public_facts_sha256', v_public_facts_sha256,
    'stage1_reviewed_summary_sha256', v_summary_sha256,
    'stage1_reviewed_confidence_sha256', v_confidence_sha256,
    'stage1_reviewed_evidence_rows_sha256', v_evidence_rows_sha256
  );

  select coalesce(
    pg_catalog.jsonb_object_agg(
      choice.row_value ->> 'field_name',
      choice.row_value -> 'candidate_ids'
    ),
    '{}'::jsonb
  ) || v_expected_audit_projection
  into v_expected_selected_fact_summary
  from pg_catalog.jsonb_array_elements(
    p_review_binding #> array[
      'review_root', 'cohorts', '0', 'field_choices'
    ]
  ) choice(row_value);

  v_expected_audit_base := pg_catalog.jsonb_build_object(
    'shared_award_id', p_shared_award_id,
    'audit_kind', 'deterministic',
    'audit_status', 'passed',
    'severity', 'info',
    'findings', '[]'::jsonb,
    'suggested_fixes', '[]'::jsonb,
    'field_conflicts', '[]'::jsonb,
    'source_rejections', '[]'::jsonb,
    'selected_fact_summary', v_expected_selected_fact_summary,
    'public_page_snapshot', p_public_facts,
    'model', 'explicit-human-reviewed-stage1-reconciliation'
  );
  v_expected_audit_row := v_expected_audit_base ||
    pg_catalog.jsonb_build_object(
      'public_page_snapshot',
      (v_expected_audit_base -> 'public_page_snapshot') ||
        pg_catalog.jsonb_build_object(
        'reconciliation_audit_signature',
        private.stage1_canonical_json_sha256(v_expected_audit_base)
      )
    );

  if p_audit_row is distinct from v_expected_audit_row then
    raise exception using
      errcode = '22023',
      message = 'The deterministic audit row is not the exact projection of the immutable human-review root.';
  end if;
  v_audit_row_sha256 := private.stage1_reviewed_audit_row_sha256(
    v_expected_audit_row
  );

  if private.stage1_safe_timestamptz(
      p_review_binding #>> array['review', 'reviewed_at']
    ) is null
    or private.stage1_safe_timestamptz(
      p_review_binding #>> array['review', 'reviewed_at']
    ) < v_now - interval '24 hours'
    or private.stage1_safe_timestamptz(
      p_review_binding #>> array['review', 'reviewed_at']
    ) > v_now + interval '5 minutes' then
    raise exception using
      errcode = '22023',
      message = 'The reviewed Stage 1 selection is stale, invalid, or future-dated.';
  end if;

  v_cohort_key := nullif(pg_catalog.btrim(p_review_binding ->> 'cohort_key'), '');
  if v_cohort_key is null
    or p_review_binding #>> array['review_root', 'cohorts', '0', 'cohort_key']
      is distinct from v_cohort_key
    or p_review_binding #>> array[
      'review_root', 'cohorts', '0', 'canonical_award', 'id'
    ] is distinct from p_shared_award_id::text
    or p_review_binding #> array[
      'review_root', 'cohorts', '0', 'public_facts'
    ] is distinct from p_public_facts
    or p_review_binding #> array['review_root', 'review']
      is distinct from p_review_binding -> 'review'
    or not exists (
    select 1
    from public.stage1_award_registry registry
    join public.stage1_award_members member
      on member.cohort_key = registry.cohort_key
      and member.shared_award_id = registry.canonical_shared_award_id
      and member.member_kind = 'canonical'
    join public.shared_awards award
      on award.id = registry.canonical_shared_award_id
    where registry.cohort_key = v_cohort_key
      and registry.canonical_shared_award_id = p_shared_award_id
      and registry.policy_version = 'stage1-publication-v1'
      and award.status = 'active'
      and award.name = registry.canonical_name
      and award.official_homepage = registry.official_homepage
  ) then
    raise exception using
      errcode = '23514',
      message = 'The reviewed reconciliation is not bound to an exact Stage 1 canonical identity.';
  end if;

  if pg_catalog.cardinality(p_source_ids) is null
    or pg_catalog.cardinality(p_source_ids) = 0
    or pg_catalog.cardinality(p_candidate_ids) is null
    or pg_catalog.cardinality(p_candidate_ids) = 0
    or pg_catalog.jsonb_array_length(p_review_binding -> 'source_ids') <>
      pg_catalog.cardinality(p_source_ids)
    or pg_catalog.jsonb_array_length(p_review_binding -> 'candidate_ids') <>
      pg_catalog.cardinality(p_candidate_ids)
    or pg_catalog.jsonb_array_length(p_review_binding -> 'source_snapshots') <>
      pg_catalog.jsonb_array_length(p_review_binding -> 'review_source_ids')
    or pg_catalog.jsonb_array_length(p_review_binding -> 'candidate_versions') <>
      pg_catalog.cardinality(p_candidate_ids)
    or pg_catalog.jsonb_array_length(p_candidate_status_updates) <>
      pg_catalog.cardinality(p_candidate_ids)
    or exists (
      select 1
      from pg_catalog.unnest(p_source_ids) expected(id)
      where not (p_review_binding -> 'source_ids' ? expected.id::text)
    )
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements_text(
        p_review_binding -> 'source_ids'
      ) actual(value)
      where actual.value !~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        or not (private.stage1_safe_uuid(actual.value) = any(p_source_ids))
    )
    or pg_catalog.jsonb_array_length(
      p_review_binding -> 'review_source_ids'
    ) = 0
    or (
      select pg_catalog.count(*)
      from pg_catalog.jsonb_array_elements_text(
        p_review_binding -> 'review_source_ids'
      ) reviewed(value)
    ) <> (
      select pg_catalog.count(distinct reviewed.value)
      from pg_catalog.jsonb_array_elements_text(
        p_review_binding -> 'review_source_ids'
      ) reviewed(value)
    )
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements_text(
        p_review_binding -> 'review_source_ids'
      ) reviewed(value)
      where reviewed.value !~*
        '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    )
    or exists (
      select 1
      from pg_catalog.unnest(p_source_ids) contributor(id)
      where not (
        p_review_binding -> 'review_source_ids' ? contributor.id::text
      )
    )
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(
        p_review_binding #> array['review_root', 'cohorts', '0', 'roles']
      ) role(value)
      cross join lateral pg_catalog.jsonb_array_elements(
        role.value -> 'sources'
      ) root_source(value)
      where coalesce(root_source.value ->> 'source_id', '') !~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        or not (
          p_review_binding -> 'review_source_ids' ?
            (root_source.value ->> 'source_id')
        )
    )
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements_text(
        p_review_binding -> 'review_source_ids'
      ) reviewed(value)
      where not exists (
        select 1
        from pg_catalog.jsonb_array_elements(
          p_review_binding #> array['review_root', 'cohorts', '0', 'roles']
        ) role(value)
        cross join lateral pg_catalog.jsonb_array_elements(
          role.value -> 'sources'
        ) root_source(value)
        where root_source.value ->> 'source_id' = reviewed.value
      )
    )
    or exists (
      select 1
      from pg_catalog.unnest(p_candidate_ids) expected(id)
      where not (p_review_binding -> 'candidate_ids' ? expected.id::text)
    )
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements_text(
        p_review_binding -> 'candidate_ids'
      ) actual(value)
      where actual.value !~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        or not (private.stage1_safe_uuid(actual.value) = any(p_candidate_ids))
    )
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(
        p_review_binding #> array['review_root', 'cohorts', '0', 'roles']
      ) role(value)
      cross join lateral pg_catalog.jsonb_array_elements_text(
        role.value -> 'fact_candidate_ids'
      ) reviewed_candidate(value)
      where not (
        p_review_binding -> 'candidate_ids' ? reviewed_candidate.value
      )
    )
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(
        p_review_binding #> array[
          'review_root', 'cohorts', '0', 'field_choices'
        ]
      ) choice(value)
      cross join lateral pg_catalog.jsonb_array_elements_text(
        choice.value -> 'candidate_ids'
      ) reviewed_candidate(value)
      where not (
        p_review_binding -> 'candidate_ids' ? reviewed_candidate.value
      )
    ) then
    raise exception using
      errcode = '22023',
      message = 'Reviewed source and candidate identity sets must be exact and duplicate-free.';
  end if;

  if (
    select pg_catalog.count(*)
    from pg_catalog.jsonb_each(p_public_facts) fact(field_name, public_value)
    where fact.public_value not in (
      'null'::jsonb,
      '""'::jsonb,
      '[]'::jsonb,
      '{}'::jsonb
    )
  ) <> pg_catalog.jsonb_array_length(
    p_review_binding #> array[
      'review_root', 'cohorts', '0', 'field_choices'
    ]
  )
    or (
      select pg_catalog.count(*)
      from pg_catalog.jsonb_each(p_public_facts) fact(field_name, public_value)
      where fact.public_value not in (
        'null'::jsonb,
        '""'::jsonb,
        '[]'::jsonb,
        '{}'::jsonb
      )
    ) <> pg_catalog.jsonb_array_length(p_evidence_rows)
    or not private.stage1_review_fact_bijection_valid(
    p_public_facts,
    p_review_binding #> array[
      'review_root', 'cohorts', '0', 'field_choices'
    ],
    p_evidence_rows,
    p_candidate_ids
  ) then
    raise exception using
      errcode = '23514',
      message = 'Every non-empty reviewed fact and ordered item requires exactly one field choice, candidate occurrence, and evidence row.';
  end if;

  if (
    select pg_catalog.count(distinct binding.value ->> 'source_id')
    from pg_catalog.jsonb_array_elements(
      p_review_binding -> 'source_snapshots'
    ) binding(value)
  ) <> pg_catalog.jsonb_array_length(p_review_binding -> 'review_source_ids')
    or (
      select pg_catalog.count(distinct binding.value ->> 'candidate_id')
      from pg_catalog.jsonb_array_elements(
        p_review_binding -> 'candidate_versions'
      ) binding(value)
    ) <> pg_catalog.cardinality(p_candidate_ids)
    or (
      select pg_catalog.count(distinct mutation.value ->> 'id')
      from pg_catalog.jsonb_array_elements(p_candidate_status_updates) mutation(value)
    ) <> pg_catalog.cardinality(p_candidate_ids) then
    raise exception using
      errcode = '22023',
      message = 'Reviewed state bindings and candidate CAS mutations must be exact and unique.';
  end if;

  -- Lock every selected source and immutable snapshot pointer before validating
  -- them. The existing core RPC then locks the queue/award and CAS-updates only
  -- the explicitly selected candidates in this same transaction.
  perform source.id
  from public.shared_award_sources source
  join public.shared_award_source_visual_snapshots snapshot
    on snapshot.shared_award_source_id = source.id
  where source.id in (
    select private.stage1_safe_uuid(reviewed.value)
    from pg_catalog.jsonb_array_elements_text(
      p_review_binding -> 'review_source_ids'
    ) reviewed(value)
  )
  order by source.id
  for share of source, snapshot;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements_text(
      p_review_binding -> 'review_source_ids'
    ) reviewed(value)
    cross join lateral (
      select private.stage1_safe_uuid(reviewed.value) as source_id
    ) expected
    left join public.shared_award_sources source on source.id = expected.source_id
    left join public.shared_award_source_visual_snapshots snapshot
      on snapshot.shared_award_source_id = source.id
    left join public.stage1_award_members member
      on member.shared_award_id = source.shared_award_id
      and member.cohort_key = v_cohort_key
    left join lateral (
      select binding.value
      from pg_catalog.jsonb_array_elements(
        p_review_binding -> 'source_snapshots'
      ) binding(value)
      where binding.value ->> 'source_id' = expected.source_id::text
    ) binding on true
    where source.id is null
      or snapshot.shared_award_source_id is null
      or member.shared_award_id is null
      or source.admin_review_status <> 'open'
      or nullif(pg_catalog.btrim(source.last_error), '') is not null
      or source.last_checked_at < v_now - interval '24 hours'
      or source.last_checked_at > v_now + interval '5 minutes'
      or binding.value is null
      or binding.value ->> 'shared_award_id' is distinct from
        source.shared_award_id::text
      or binding.value ->> 'source_url' is distinct from source.url
      or private.stage1_safe_timestamptz(
        binding.value ->> 'source_updated_at'
      ) is distinct from
        source.updated_at
      or private.stage1_safe_timestamptz(
        binding.value ->> 'last_checked_at'
      ) is distinct from
        source.last_checked_at
      or binding.value ->> 'bucket' is distinct from snapshot.bucket
      or binding.value ->> 'kind' is distinct from snapshot.kind
      or private.stage1_safe_timestamptz(
        binding.value ->> 'snapshot_updated_at'
      ) is distinct from
        snapshot.updated_at
      or private.stage1_safe_timestamptz(
        binding.value ->> 'captured_at'
      ) is distinct from
        snapshot.latest_captured_at
      or binding.value -> 'object_keys' is distinct from snapshot.latest_object_keys
      or binding.value -> 'hashes' is distinct from snapshot.latest_hashes
      or binding.value -> 'metadata' is distinct from snapshot.latest_metadata
      or not private.stage1_manifest_source_capture_binding_valid(
        source.id,
        snapshot.kind,
        snapshot.latest_object_keys,
        snapshot.latest_hashes,
        snapshot.latest_metadata
      )
      or exists (
        select 1
        from pg_catalog.jsonb_array_elements(
          p_review_binding #> array['review_root', 'cohorts', '0', 'roles']
        ) role(value)
        cross join lateral pg_catalog.jsonb_array_elements(
          role.value -> 'sources'
        ) root_source(value)
        where root_source.value ->> 'source_id' = expected.source_id::text
          and (
            root_source.value ->> 'source_url' is distinct from source.url
            or pg_catalog.jsonb_typeof(
              root_source.value -> 'official_identity'
            ) is distinct from 'object'
            or root_source.value #>> array['official_identity', 'host']
              is distinct from pg_catalog.lower(pg_catalog.regexp_replace(
                source.url,
                '^https://([^/:?#]+).*$','\1'
              ))
            or root_source.value #>> array[
              'official_identity', 'classification'
            ] not in (
              'canonical_program_host',
              'official_authority_host',
              'official_contractor_host'
            )
            or (
              root_source.value #>> array[
                'official_identity', 'classification'
              ] = 'canonical_program_host'
              and root_source.value #>> array['official_identity', 'host']
                is distinct from pg_catalog.lower(pg_catalog.regexp_replace(
                  p_review_binding #>> array[
                    'review_root', 'cohorts', '0',
                    'canonical_award', 'official_homepage'
                  ],
                  '^https://([^/:?#]+).*$','\1'
                ))
            )
            or (
              root_source.value #>> array[
                'official_identity', 'classification'
              ] <> 'canonical_program_host'
              and (
                coalesce(root_source.value #>> array[
                  'official_identity', 'evidence_url'
                ], '') !~ '^https://'
                or nullif(pg_catalog.btrim(root_source.value #>> array[
                  'official_identity', 'reviewed_reason'
                ]), '') is null
              )
            )
            or private.stage1_safe_timestamptz(
              root_source.value ->> 'last_checked_at'
            ) is distinct from source.last_checked_at
            or private.stage1_safe_timestamptz(
              root_source.value #>> array['snapshot', 'captured_at']
            ) is distinct from snapshot.latest_captured_at
            or root_source.value #>> array['snapshot', 'kind']
              is distinct from snapshot.kind
            or root_source.value #> array['snapshot', 'object_keys']
              is distinct from snapshot.latest_object_keys
            or root_source.value #> array['snapshot', 'hashes']
              is distinct from snapshot.latest_hashes
            or root_source.value #> array['snapshot', 'metadata']
              is distinct from snapshot.latest_metadata
            or root_source.value #> array['r2', 'hashes']
              is distinct from snapshot.latest_hashes
            or root_source.value #> array['local', 'hashes']
              is distinct from snapshot.latest_hashes
            or private.stage1_safe_timestamptz(
              root_source.value #>> array['snapshot', 'captured_at']
            ) is null
            or private.stage1_safe_timestamptz(
              root_source.value #>> array['r2', 'verified_at']
            ) is null
            or private.stage1_safe_timestamptz(
              root_source.value #>> array['local', 'verified_at']
            ) is null
            or private.stage1_safe_timestamptz(
              root_source.value #>> array['snapshot', 'captured_at']
            ) > v_now + interval '5 minutes'
            or private.stage1_safe_timestamptz(
              root_source.value #>> array['r2', 'verified_at']
            ) < private.stage1_safe_timestamptz(
              root_source.value #>> array['snapshot', 'captured_at']
            )
            or private.stage1_safe_timestamptz(
              root_source.value #>> array['r2', 'verified_at']
            ) > v_now + interval '5 minutes'
            or private.stage1_safe_timestamptz(
              root_source.value #>> array['local', 'verified_at']
            ) < private.stage1_safe_timestamptz(
              root_source.value #>> array['snapshot', 'captured_at']
            )
            or private.stage1_safe_timestamptz(
              root_source.value #>> array['local', 'verified_at']
            ) > v_now + interval '5 minutes'
            or private.stage1_safe_timestamptz(
              root_source.value #>> array['r2', 'verified_at']
            ) > private.stage1_safe_timestamptz(
              p_review_binding #>> array['review', 'reviewed_at']
            )
            or private.stage1_safe_timestamptz(
              root_source.value #>> array['local', 'verified_at']
            ) > private.stage1_safe_timestamptz(
              p_review_binding #>> array['review', 'reviewed_at']
            )
            or source.last_checked_at > private.stage1_safe_timestamptz(
              p_review_binding #>> array['review', 'reviewed_at']
            )
          )
      )
  ) then
    raise exception using
      errcode = '40001',
      message = 'A reviewed role source or immutable snapshot changed before commit.';
  end if;

  perform candidate.id
  from public.shared_award_fact_candidates candidate
  where candidate.id = any(p_candidate_ids)
  order by candidate.id
  for share of candidate;

  if exists (
    select 1
    from pg_catalog.unnest(p_candidate_ids) expected(candidate_id)
    left join public.shared_award_fact_candidates candidate
      on candidate.id = expected.candidate_id
    left join public.stage1_award_members member
      on member.shared_award_id = candidate.shared_award_id
      and member.cohort_key = v_cohort_key
    left join private.stage1_reviewed_candidate_import_items imported_item
      on imported_item.candidate_id = candidate.id
    left join private.stage1_reviewed_candidate_import_bundles imported_bundle
      on imported_bundle.bundle_sha256 = imported_item.bundle_sha256
    left join lateral (
      select binding.value
      from pg_catalog.jsonb_array_elements(
        p_review_binding -> 'candidate_versions'
      ) binding(value)
      where binding.value ->> 'candidate_id' = expected.candidate_id::text
    ) binding on true
    left join lateral (
      select mutation.value
      from pg_catalog.jsonb_array_elements(p_candidate_status_updates) mutation(value)
      where mutation.value ->> 'id' = expected.candidate_id::text
    ) mutation on true
    where candidate.id is null
      or member.shared_award_id is null
      or binding.value is null
      or mutation.value is null
      or candidate.candidate_status = 'rejected'
      or binding.value ->> 'shared_award_id' is distinct from
        candidate.shared_award_id::text
      or binding.value ->> 'source_id' is distinct from
        candidate.shared_award_source_id::text
      or binding.value ->> 'field_name' is distinct from candidate.field_name
      or candidate.source_role is null
      or candidate.source_role not in ('primary', 'supporting')
      or binding.value ->> 'source_relevance' is distinct from candidate.source_role
      or binding.value ->> 'reviewed_stage1_source_role' not in (
        'identity_home',
        'eligibility',
        'application_materials',
        'dates_cycle',
        'funding',
        'faq',
        'selection_interviews',
        'current_documents'
      )
      or binding.value ->> 'candidate_status' is distinct from candidate.candidate_status
      or binding.value -> 'normalized_value' is distinct from candidate.normalized_value
      or binding.value ->> 'evidence_quote' is distinct from candidate.evidence_quote
      or binding.value -> 'evidence_location' is distinct from
        coalesce(pg_catalog.to_jsonb(candidate.evidence_location), 'null'::jsonb)
      or binding.value -> 'immutable_evidence' is distinct from
        candidate.metadata -> 'stage1_immutable_evidence'
      or imported_item.item_sha256 is null
      or imported_bundle.bundle_sha256 is null
      or candidate.metadata #>> array[
        'stage1_candidate_import', 'schema_version'
      ] is distinct from
        'awardping.stage1.reviewed-candidate-import-item.v1'
      or coalesce(candidate.metadata #>> array[
        'stage1_candidate_import', 'item_sha256'
      ], '') !~ '^[0-9a-f]{64}$'
      or coalesce(candidate.metadata #>> array[
        'stage1_candidate_import', 'bundle_sha256'
      ], '') !~ '^[0-9a-f]{64}$'
      or candidate.metadata #>> array[
        'stage1_candidate_import', 'item_sha256'
      ] is distinct from imported_item.item_sha256
      or candidate.metadata #>> array[
        'stage1_candidate_import', 'bundle_sha256'
      ] is distinct from imported_item.bundle_sha256
      or imported_item.bundle_sha256 is distinct from imported_bundle.bundle_sha256
      or imported_item.canonical_shared_award_id is distinct from p_shared_award_id
      or imported_item.source_id is distinct from candidate.shared_award_source_id
      or imported_item.field_name is distinct from candidate.field_name
      or private.stage1_canonical_json_sha256(
        pg_catalog.jsonb_build_object(
          'schema_version',
            'awardping.stage1.reviewed-candidate-import-item.v1',
          'policy_version', 'stage1-publication-v1',
          'canonical_shared_award_id', p_shared_award_id::text,
          'source_id', candidate.shared_award_source_id::text,
          'source_url', candidate.source_url,
          'source_relevance', candidate.source_role,
          'field_name', candidate.field_name,
          'normalized_value', candidate.normalized_value,
          'evidence_quote', candidate.evidence_quote,
          'evidence_location', candidate.evidence_location,
          'capture_text_sha256', candidate.metadata #>> array[
            'stage1_immutable_evidence', 'capture_text_sha256'
          ],
          'capture_text_object_key', candidate.metadata #>> array[
            'stage1_immutable_evidence', 'capture_text_object_key'
          ]
        )
      ) is distinct from imported_item.item_sha256
      or imported_bundle.cohort_key is distinct from v_cohort_key
      or imported_bundle.canonical_shared_award_id is distinct from p_shared_award_id
      or coalesce(imported_bundle.confirmation_sha256, '') !~ '^[0-9a-f]{64}$'
      or coalesce(imported_bundle.source_bindings_sha256, '')
        !~ '^[0-9a-f]{64}$'
      or coalesce(imported_bundle.candidates_sha256, '') !~ '^[0-9a-f]{64}$'
      or coalesce(imported_bundle.import_binding_sha256, '')
        !~ '^[0-9a-f]{64}$'
      or private.stage1_canonical_json_sha256(
        imported_bundle.review_bundle
      ) is distinct from imported_bundle.bundle_sha256
      or private.stage1_canonical_json_sha256(
        imported_bundle.source_bindings
      ) is distinct from imported_bundle.source_bindings_sha256
      or private.stage1_canonical_json_sha256(
        imported_bundle.confirmation_payload
      ) is distinct from imported_bundle.confirmation_sha256
      or imported_bundle.review_bundle #>> array[
        'cohort', 'cohort_key'
      ] is distinct from v_cohort_key
      or imported_bundle.review_bundle #>> array[
        'cohort', 'canonical_award', 'id'
      ] is distinct from p_shared_award_id::text
      or imported_bundle.review_bundle #>> array[
        'review', 'reviewed_by'
      ] is distinct from imported_bundle.reviewed_by
      or imported_bundle.review_bundle #>> array[
        'review', 'reason'
      ] is distinct from imported_bundle.review_reason
      or private.stage1_safe_timestamptz(
        imported_bundle.review_bundle #>> array['review', 'reviewed_at']
      ) is distinct from imported_bundle.reviewed_at
      or imported_bundle.confirmation_payload ->> 'bundle_sha256'
        is distinct from imported_bundle.bundle_sha256
      or imported_bundle.confirmation_payload ->> 'candidates_sha256'
        is distinct from imported_bundle.candidates_sha256
      or imported_bundle.confirmation_payload ->> 'candidate_count'
        is distinct from imported_bundle.candidate_count::text
      or imported_bundle.confirmation_payload ->> 'reviewed_by'
        is distinct from imported_bundle.reviewed_by
      or private.stage1_safe_timestamptz(
        imported_bundle.confirmation_payload ->> 'reviewed_at'
      ) is distinct from imported_bundle.reviewed_at
      or not (
        imported_bundle.confirmation_payload -> 'candidate_ids' ?
          candidate.id::text
      )
      or not exists (
        select 1
        from pg_catalog.jsonb_array_elements(
          imported_bundle.source_bindings
        ) persisted_source(value)
        where persisted_source.value ->> 'source_id' =
            candidate.shared_award_source_id::text
          and persisted_source.value ->> 'shared_award_id' =
            candidate.shared_award_id::text
          and persisted_source.value ->> 'source_url' = candidate.source_url
          and persisted_source.value ->> 'capture_text_sha256' =
            candidate.metadata #>> array[
              'stage1_immutable_evidence', 'capture_text_sha256'
            ]
          and persisted_source.value ->> 'capture_text_object_key' =
            candidate.metadata #>> array[
              'stage1_immutable_evidence', 'capture_text_object_key'
            ]
      )
      or not exists (
        select 1
        from pg_catalog.jsonb_array_elements(
          imported_bundle.review_bundle -> 'items'
        ) persisted_item(value)
        where persisted_item.value ->> 'item_key' = candidate.metadata #>> array[
            'stage1_candidate_import', 'item_key'
          ]
          and persisted_item.value ->> 'source_id' =
            candidate.shared_award_source_id::text
          and persisted_item.value ->> 'source_relevance' = candidate.source_role
          and persisted_item.value ->> 'field_name' = candidate.field_name
          and persisted_item.value -> 'normalized_value' is not distinct from
            candidate.normalized_value
          and persisted_item.value ->> 'evidence_quote' =
            candidate.evidence_quote
          and persisted_item.value ->> 'evidence_location' =
            candidate.evidence_location
      )
      or imported_bundle.candidate_count <= 0
      or imported_bundle.candidate_count is distinct from (
        select pg_catalog.count(*)
        from private.stage1_reviewed_candidate_import_items bundle_item
        where bundle_item.bundle_sha256 = imported_bundle.bundle_sha256
      )
      or candidate.metadata #>> array[
        'stage1_candidate_import', 'reviewed_by'
      ] is distinct from imported_bundle.reviewed_by
      or candidate.metadata #>> array[
        'stage1_candidate_import', 'review_reason'
      ] is distinct from imported_bundle.review_reason
      or private.stage1_safe_timestamptz(candidate.metadata #>> array[
        'stage1_candidate_import', 'reviewed_at'
      ]) is distinct from imported_bundle.reviewed_at
      or imported_bundle.reviewed_at is distinct from candidate.extracted_at
      or imported_bundle.reviewed_at > private.stage1_safe_timestamptz(
        p_review_binding #>> array['review', 'reviewed_at']
      )
      or candidate.metadata #> array[
        'stage1_candidate_import', 'paid_api_calls'
      ] is distinct from '0'::jsonb
      or candidate.source_page_request_id is not null
      or candidate.intake_value_sha256 is not null
      or binding.value -> 'candidate_import' is distinct from
        pg_catalog.jsonb_build_object(
          'schema_version',
            'awardping.stage1.reviewed-candidate-import-item.v1',
          'bundle_sha256', imported_bundle.bundle_sha256,
          'item_sha256', imported_item.item_sha256
        )
      or binding.value -> 'intake_value_sha256' is distinct from
        coalesce(pg_catalog.to_jsonb(candidate.intake_value_sha256), 'null'::jsonb)
      or private.stage1_safe_timestamptz(
        binding.value ->> 'extracted_at'
      ) is distinct from candidate.extracted_at
      or binding.value -> 'model' is distinct from
        coalesce(pg_catalog.to_jsonb(candidate.model), 'null'::jsonb)
      or private.stage1_safe_timestamptz(
        binding.value ->> 'updated_at'
      ) is distinct from
        candidate.updated_at
      or mutation.value ->> 'expected_status' is distinct from candidate.candidate_status
      or private.stage1_safe_timestamptz(
        mutation.value ->> 'expected_updated_at'
      ) is distinct from
        candidate.updated_at
      or mutation.value ->> 'candidate_status' is distinct from 'selected'
      or mutation.value ->> 'selected_reason' is distinct from
        'explicit_human_review:' ||
          (p_review_binding ->> 'stage1_review_root_sha256')
      or not (candidate.shared_award_source_id = any(p_source_ids))
      or not exists (
        select 1
        from pg_catalog.jsonb_array_elements(
          p_review_binding #> array['review_root', 'cohorts', '0', 'roles']
        ) role(value)
        where role.value ->> 'source_role' =
            binding.value ->> 'reviewed_stage1_source_role'
          and role.value -> 'fact_candidate_ids' ? candidate.id::text
          and exists (
            select 1
            from pg_catalog.jsonb_array_elements(role.value -> 'sources') source(value)
            where source.value ->> 'source_id' =
              candidate.shared_award_source_id::text
          )
      )
      or not exists (
        select 1
        from pg_catalog.jsonb_array_elements(
          p_review_binding #> array[
            'review_root', 'cohorts', '0', 'field_choices'
          ]
        ) choice(value)
        cross join lateral pg_catalog.jsonb_array_elements_text(
          choice.value -> 'candidate_ids'
        ) with ordinality selected(candidate_id, composition_ordinality)
        cross join lateral pg_catalog.jsonb_array_elements(
          choice.value -> 'candidate_evidence'
        ) with ordinality reviewed_evidence(value, evidence_ordinality)
        where choice.value ->> 'field_name' = candidate.field_name
          and selected.candidate_id = candidate.id::text
          and reviewed_evidence.evidence_ordinality =
            selected.composition_ordinality
          and reviewed_evidence.value ->> 'candidate_id' = candidate.id::text
          and reviewed_evidence.value ->> 'source_id' =
            candidate.shared_award_source_id::text
          and reviewed_evidence.value ->> 'evidence_quote' =
            candidate.evidence_quote
          and reviewed_evidence.value ->> 'evidence_location' =
            candidate.evidence_location
          and binding.value ->> 'composition_method' =
            choice.value ->> 'composition_method'
          and (
            (
              choice.value ->> 'composition_method' = 'direct_exact'
              and pg_catalog.jsonb_array_length(
                choice.value -> 'candidate_ids'
              ) = 1
              and binding.value -> 'composition_index' = 'null'::jsonb
              and p_review_binding #> array[
                'review_root', 'cohorts', '0', 'public_facts',
                candidate.field_name
              ] is not distinct from candidate.normalized_value
            )
            or (
              choice.value ->> 'composition_method' = 'ordered_array_items'
              and pg_catalog.jsonb_typeof(
                p_review_binding #> array[
                  'review_root', 'cohorts', '0', 'public_facts',
                  candidate.field_name
                ]
              ) = 'array'
              and pg_catalog.jsonb_array_length(
                choice.value -> 'candidate_ids'
              ) = pg_catalog.jsonb_array_length(
                p_review_binding #> array[
                  'review_root', 'cohorts', '0', 'public_facts',
                  candidate.field_name
                ]
              )
              and binding.value ->> 'composition_index' =
                (selected.composition_ordinality - 1)::text
              and (
                p_review_binding #> array[
                  'review_root', 'cohorts', '0', 'public_facts',
                  candidate.field_name
                ] -> ((selected.composition_ordinality - 1)::integer)
              ) is not distinct from candidate.normalized_value
            )
          )
          and reviewed_evidence.value ->> 'capture_text_sha256' =
            binding.value #>> array['immutable_evidence', 'capture_text_sha256']
          and reviewed_evidence.value ->> 'capture_text_object_key' =
            binding.value #>> array[
              'immutable_evidence', 'capture_text_object_key'
            ]
          and binding.value #>> array['immutable_evidence', 'schema_version'] =
            'awardping.stage1.candidate-immutable-evidence.v1'
          and binding.value #>> array['immutable_evidence', 'source_id'] =
            candidate.shared_award_source_id::text
          and binding.value #>> array[
            'immutable_evidence', 'evidence_quote_sha256'
          ] = private.stage1_text_sha256(candidate.evidence_quote)
          and binding.value #>> array[
            'immutable_evidence', 'verification_method'
          ] = 'exact_local_text_substring'
          and binding.value -> 'immutable_evidence' =
            pg_catalog.jsonb_build_object(
              'schema_version',
                'awardping.stage1.candidate-immutable-evidence.v1',
              'source_id', candidate.shared_award_source_id::text,
              'capture_text_sha256',
                reviewed_evidence.value ->> 'capture_text_sha256',
              'capture_text_object_key',
                reviewed_evidence.value ->> 'capture_text_object_key',
              'evidence_quote_sha256',
                private.stage1_text_sha256(candidate.evidence_quote),
              'verification_method', 'exact_local_text_substring'
            )
          and exists (
            select 1
            from pg_catalog.jsonb_array_elements(
              p_review_binding #> array[
                'review_root', 'cohorts', '0', 'roles'
              ]
            ) evidence_role(value)
            cross join lateral pg_catalog.jsonb_array_elements(
              evidence_role.value -> 'sources'
            ) evidence_source(value)
            where evidence_role.value ->> 'source_role' =
                binding.value ->> 'reviewed_stage1_source_role'
              and evidence_source.value ->> 'source_id' =
                candidate.shared_award_source_id::text
              and evidence_source.value #>> array[
                'snapshot', 'hashes', 'text_hash'
              ] = reviewed_evidence.value ->> 'capture_text_sha256'
              and evidence_source.value #>> array[
                'snapshot', 'object_keys', 'text'
              ] = reviewed_evidence.value ->> 'capture_text_object_key'
          )
      )
      or not exists (
        select 1
        from pg_catalog.jsonb_array_elements(p_evidence_rows) evidence(row_value)
        cross join lateral (
          select evidence.row_value #> array[
            'evidence', 'candidate_bindings', candidate.id::text
          ] as value
        ) evidence_binding
        where evidence.row_value ->> 'field_name' = candidate.field_name
          and evidence.row_value -> 'public_value' is not distinct from
            p_public_facts -> candidate.field_name
          and evidence.row_value -> 'candidate_ids' ? candidate.id::text
          and evidence.row_value -> 'source_ids' ?
            candidate.shared_award_source_id::text
          and evidence_binding.value ->> 'source_id' =
            candidate.shared_award_source_id::text
          and evidence_binding.value ->> 'source_role' = candidate.source_role
          and evidence_binding.value ->> 'source_relevance' =
            candidate.source_role
          and evidence_binding.value ->> 'reviewed_stage1_source_role' =
            binding.value ->> 'reviewed_stage1_source_role'
          and evidence_binding.value ->> 'field_name' = candidate.field_name
          and evidence_binding.value ->> 'composition_method' =
            binding.value ->> 'composition_method'
          and evidence_binding.value -> 'composition_index' is not distinct from
            binding.value -> 'composition_index'
          and evidence_binding.value -> 'normalized_value' is not distinct from
            candidate.normalized_value
          and evidence_binding.value -> 'composed_value' is not distinct from
            candidate.normalized_value
          and evidence_binding.value -> 'selected_value' is not distinct from
            p_public_facts -> candidate.field_name
          and evidence_binding.value -> 'public_field_value' is not distinct from
            p_public_facts -> candidate.field_name
          and evidence_binding.value ->> 'evidence_quote' =
            candidate.evidence_quote
          and evidence_binding.value ->> 'evidence_location' =
            candidate.evidence_location
          and evidence_binding.value -> 'immutable_evidence' is not distinct from
            candidate.metadata -> 'stage1_immutable_evidence'
          and evidence_binding.value -> 'candidate_import' is not distinct from
            binding.value -> 'candidate_import'
          and evidence_binding.value ->> 'capture_text_sha256' =
            binding.value #>> array[
              'immutable_evidence', 'capture_text_sha256'
            ]
          and evidence_binding.value ->> 'capture_text_object_key' =
            binding.value #>> array[
              'immutable_evidence', 'capture_text_object_key'
            ]
          and evidence_binding.value ->> 'reviewed_contribution_kind' = case
            when binding.value ->> 'composition_method' = 'ordered_array_items'
              then 'ordered_array_item'
            when candidate.field_name = 'confidence'
              then 'aggregate_confidence'
            else 'direct_selected_value'
          end
      )
  ) or exists (
    select 1
    from pg_catalog.unnest(p_source_ids) source_id
    where not exists (
      select 1
      from public.shared_award_fact_candidates candidate
      where candidate.id = any(p_candidate_ids)
        and candidate.shared_award_source_id = source_id
    )
  ) then
    raise exception using
      errcode = '40001',
      message = 'A reviewed candidate version, owner, source, or exact CAS mutation changed before commit.';
  end if;

  insert into private.stage1_human_review_roots (
    root_sha256,
    schema_version,
    policy_version,
    cohort_key,
    canonical_shared_award_id,
    public_facts_sha256,
    summary_sha256,
    confidence_sha256,
    evidence_rows_sha256,
    audit_row_sha256,
    review_root,
    reviewed_at
  ) values (
    p_review_binding ->> 'stage1_review_root_sha256',
    p_review_binding ->> 'stage1_review_root_schema_version',
    p_review_binding ->> 'policy_version',
    v_cohort_key,
    p_shared_award_id,
    v_public_facts_sha256,
    v_summary_sha256,
    v_confidence_sha256,
    v_evidence_rows_sha256,
    v_audit_row_sha256,
    p_review_binding -> 'review_root',
    private.stage1_safe_timestamptz(
      p_review_binding #>> array['review', 'reviewed_at']
    )
  )
  on conflict (root_sha256) do nothing;

  select stored.*
  into v_stored_review_root
  from private.stage1_human_review_roots stored
  where stored.root_sha256 =
    p_review_binding ->> 'stage1_review_root_sha256'
  for share;

  if not found
    or v_stored_review_root.schema_version is distinct from
      p_review_binding ->> 'stage1_review_root_schema_version'
    or v_stored_review_root.policy_version is distinct from
      p_review_binding ->> 'policy_version'
    or v_stored_review_root.cohort_key is distinct from v_cohort_key
    or v_stored_review_root.canonical_shared_award_id is distinct from
      p_shared_award_id
    or v_stored_review_root.public_facts_sha256 is distinct from
      v_public_facts_sha256
    or v_stored_review_root.summary_sha256 is distinct from v_summary_sha256
    or v_stored_review_root.confidence_sha256 is distinct from
      v_confidence_sha256
    or v_stored_review_root.evidence_rows_sha256 is distinct from
      v_evidence_rows_sha256
    or v_stored_review_root.audit_row_sha256 is distinct from
      v_audit_row_sha256
    or v_stored_review_root.review_root is distinct from
      p_review_binding -> 'review_root'
    or v_stored_review_root.reviewed_at is distinct from
      private.stage1_safe_timestamptz(
        p_review_binding #>> array['review', 'reviewed_at']
      ) then
    raise exception using
      errcode = '23505',
      message = 'The Stage 1 human-review root hash collides with different immutable evidence.';
  end if;

  -- Bind the reviewed contract while this wrapper owns the processing row and
  -- before the core RPC performs its guarded transition to succeeded. This is
  -- part of the same transaction, so any later validation or commit failure
  -- rolls the metadata write back with every other publication mutation.
  update public.shared_award_reconciliation_queue queue
  set metadata = coalesce(queue.metadata, '{}'::jsonb) ||
    pg_catalog.jsonb_build_object(
      'processor', 'reconcile-reviewed-stage1-selection',
      'selection_mode', 'explicit_human_review',
      'stage1_review_root_schema_version',
        'awardping.stage1.human-review-root.v1',
      'stage1_review_root_sha256',
        p_review_binding ->> 'stage1_review_root_sha256',
      'review_source_ids', p_review_binding -> 'review_source_ids',
      'reviewed_contributor_source_ids', pg_catalog.to_jsonb(p_source_ids),
      'reviewed_candidate_ids', pg_catalog.to_jsonb(p_candidate_ids),
      'expected_award_updated_at', p_expected_award_updated_at,
      'current_public_facts_sha256',
        p_review_binding #>> array['award', 'current_public_facts_sha256'],
      'replacement_public_facts_sha256',
        p_review_binding #>> array['award', 'replacement_public_facts_sha256'],
      'stage1_reviewed_public_facts_sha256', v_public_facts_sha256,
      'stage1_reviewed_summary_sha256', v_summary_sha256,
      'stage1_reviewed_confidence_sha256', v_confidence_sha256,
      'stage1_reviewed_evidence_rows_sha256', v_evidence_rows_sha256,
      'stage1_reviewed_audit_row_sha256', v_audit_row_sha256,
      'stage1_reviewed_audit_signature', p_audit_row #>> array[
        'public_page_snapshot', 'reconciliation_audit_signature'
      ]
    )
  where queue.id = p_reconciliation_id
    and queue.shared_award_id = p_shared_award_id
    and queue.reason = 'explicit_human_review'
    and queue.status = 'processing'
    and queue.started_at = p_expected_started_at
    and queue.completed_at is null
    and queue.generation = p_expected_queue_generation
    and queue.source_ids = p_source_ids
    and queue.candidate_ids = p_candidate_ids;

  if not found then
    raise exception using
      errcode = '40001',
      message = 'The exact reviewed reconciliation queue changed before commit.';
  end if;

  insert into private.stage1_reviewed_reconciliation_authorizations (
    reconciliation_id,
    canonical_shared_award_id,
    root_sha256,
    public_facts_sha256,
    summary_sha256,
    confidence_sha256,
    evidence_rows_sha256,
    audit_row_sha256
  ) values (
    p_reconciliation_id,
    p_shared_award_id,
    p_review_binding ->> 'stage1_review_root_sha256',
    v_public_facts_sha256,
    v_summary_sha256,
    v_confidence_sha256,
    v_evidence_rows_sha256,
    v_audit_row_sha256
  );

  v_result := public.commit_award_reconciliation_publication(
    p_reconciliation_id,
    p_shared_award_id,
    p_expected_started_at,
    p_expected_queue_generation,
    p_expected_award_updated_at,
    p_expected_public_facts,
    p_summary,
    p_public_facts,
    p_confidence,
    p_evidence_rows,
    p_source_ids,
    p_candidate_ids,
    p_generated_candidates,
    p_candidate_status_updates,
    p_audit_row
  );

  if v_result.status <> 'succeeded' then
    delete from private.stage1_reviewed_reconciliation_authorizations authz
    where authz.reconciliation_id = p_reconciliation_id;
    return v_result;
  end if;

  select
    audit.id,
    private.stage1_reviewed_audit_row_sha256(
      pg_catalog.jsonb_build_object(
        'shared_award_id', audit.shared_award_id,
        'audit_kind', audit.audit_kind,
        'audit_status', audit.audit_status,
        'severity', audit.severity,
        'findings', audit.findings,
        'suggested_fixes', audit.suggested_fixes,
        'field_conflicts', audit.field_conflicts,
        'source_rejections', audit.source_rejections,
        'selected_fact_summary', audit.selected_fact_summary,
        'public_page_snapshot', audit.public_page_snapshot,
        'model', audit.model
      )
    )
  into v_audit_id, v_persisted_audit_row_sha256
  from public.shared_award_page_audits audit
  where audit.shared_award_id = p_shared_award_id
    and audit.audit_kind = 'deterministic'
    and audit.public_page_snapshot ->> 'reconciliation_audit_signature'
      is not distinct from p_audit_row #>> array[
        'public_page_snapshot', 'reconciliation_audit_signature'
      ]
  order by audit.created_at desc, audit.id desc
  limit 1
  for share;

  if v_audit_id is null
    or v_persisted_audit_row_sha256 is distinct from v_audit_row_sha256 then
    raise exception using
      errcode = '40001',
      message = 'The final deterministic reviewed audit row differs from its immutable authorization.';
  end if;

  update public.shared_award_reconciliation_queue queue
  set metadata = coalesce(queue.metadata, '{}'::jsonb) ||
    pg_catalog.jsonb_build_object(
      'processor', 'reconcile-reviewed-stage1-selection',
      'selection_mode', 'explicit_human_review',
      'review_contract_version',
        'awardping.stage1.reviewed-reconciliation-commit.v1',
      'selection_sha256', p_review_binding ->> 'selection_sha256',
      'stage1_review_root_schema_version',
        p_review_binding ->> 'stage1_review_root_schema_version',
      'stage1_review_root_sha256',
        p_review_binding ->> 'stage1_review_root_sha256',
      'review_source_ids', p_review_binding -> 'review_source_ids',
      'reviewed_contributor_source_ids', pg_catalog.to_jsonb(p_source_ids),
      'reviewed_candidate_ids', pg_catalog.to_jsonb(p_candidate_ids),
      'expected_award_updated_at', p_expected_award_updated_at,
      'current_public_facts_sha256',
        p_review_binding #>> array['award', 'current_public_facts_sha256'],
      'replacement_public_facts_sha256',
        p_review_binding #>> array['award', 'replacement_public_facts_sha256'],
      'stage1_reviewed_public_facts_sha256', v_public_facts_sha256,
      'stage1_reviewed_summary_sha256', v_summary_sha256,
      'stage1_reviewed_confidence_sha256', v_confidence_sha256,
      'stage1_reviewed_evidence_rows_sha256', v_evidence_rows_sha256,
      'stage1_reviewed_audit_row_sha256', v_audit_row_sha256,
      'stage1_reviewed_audit_signature', p_audit_row #>> array[
        'public_page_snapshot', 'reconciliation_audit_signature'
      ],
      'selection_state_hash',
        public.stage1_publication_evidence_hash(p_review_binding),
      'reviewed_at', p_review_binding #>> array['review', 'reviewed_at'],
      'paid_api_calls', 0,
      'ranked_candidates_accepted', 0,
      'monitoring_sources_retired', 0
    )
  where queue.id = p_reconciliation_id
    and queue.status = 'succeeded'
  returning queue.* into v_result;

  if not found then
    raise exception using
      errcode = '40001',
      message = 'Reviewed reconciliation metadata could not be bound to its succeeded queue row.';
  end if;
  return v_result;
end;
$$;

revoke execute on function public.commit_reviewed_stage1_reconciliation_publication(
  uuid, uuid, timestamptz, bigint, timestamptz, jsonb, text, jsonb,
  double precision, jsonb, uuid[], uuid[], jsonb, jsonb, jsonb, jsonb
) from public, anon, authenticated;

grant execute on function public.commit_reviewed_stage1_reconciliation_publication(
  uuid, uuid, timestamptz, bigint, timestamptz, jsonb, text, jsonb,
  double precision, jsonb, uuid[], uuid[], jsonb, jsonb, jsonb, jsonb
) to service_role;

comment on function public.commit_reviewed_stage1_reconciliation_publication(
  uuid, uuid, timestamptz, bigint, timestamptz, jsonb, text, jsonb,
  double precision, jsonb, uuid[], uuid[], jsonb, jsonb, jsonb, jsonb
) is
  'Service-only exact human-reviewed Stage 1 reconciliation. Verifies immutable reviewed-import ledgers, per-item text evidence, role attribution, ordered composition, and selected candidate/source/snapshot identities; forbids materialization; delegates the atomic publication commit; and records immutable review hashes without modifying unrelated monitoring evidence.';
