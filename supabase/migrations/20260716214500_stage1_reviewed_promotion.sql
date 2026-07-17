-- A reviewed Stage 1 promotion is intentionally a two-step operator action:
-- preview returns a hash of every mutable input, then apply compares that hash
-- while holding the cohort rows and promotes either one cohort or all 25 in one
-- database transaction. No partial 2..24 cohort release is accepted.

create or replace function private.stage1_promotion_review_snapshot(
  p_cohort_key text
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'schema_version', 1,
    'cohort_key', registry.cohort_key,
    'registry', pg_catalog.to_jsonb(registry),
    'canonical_award', (
      select pg_catalog.to_jsonb(award)
      from public.shared_awards award
      where award.id = registry.canonical_shared_award_id
    ),
    'members', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.to_jsonb(member)
        order by member.member_kind, member.shared_award_id
      )
      from public.stage1_award_members member
      where member.cohort_key = registry.cohort_key
    ), '[]'::jsonb),
    'identity_rules', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.to_jsonb(identity_rule)
        order by identity_rule.rule_key, identity_rule.id
      )
      from public.stage1_award_source_identity_rules identity_rule
      where identity_rule.cohort_key = registry.cohort_key
    ), '[]'::jsonb),
    'manifests', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.to_jsonb(manifest)
        order by manifest.source_role
      )
      from public.stage1_award_source_manifest manifest
      where manifest.cohort_key = registry.cohort_key
    ), '[]'::jsonb),
    'bound_sources', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'source', pg_catalog.to_jsonb(source),
          'visual_snapshot', pg_catalog.to_jsonb(snapshot)
        )
        order by source.id
      )
      from (
        select distinct unnest(manifest.source_ids) as source_id
        from public.stage1_award_source_manifest manifest
        where manifest.cohort_key = registry.cohort_key
      ) requested
      join public.shared_award_sources source on source.id = requested.source_id
      left join public.shared_award_source_visual_snapshots snapshot
        on snapshot.shared_award_source_id = source.id
    ), '[]'::jsonb),
    'bound_candidates', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.to_jsonb(candidate)
        order by candidate.id
      )
      from (
        select distinct case
          when raw.candidate_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          then raw.candidate_id::uuid
          else null
        end as candidate_id
        from public.stage1_award_source_manifest manifest
        cross join lateral pg_catalog.jsonb_array_elements_text(
          coalesce(manifest.evidence -> 'fact_candidate_ids', '[]'::jsonb)
        ) raw(candidate_id)
        where manifest.cohort_key = registry.cohort_key
      ) requested
      join public.shared_award_fact_candidates candidate
        on candidate.id = requested.candidate_id
    ), '[]'::jsonb),
    'latest_reconciliation', (
      select pg_catalog.to_jsonb(queue)
      from public.shared_award_reconciliation_queue queue
      where queue.shared_award_id = registry.canonical_shared_award_id
      order by queue.created_at desc, queue.id desc
      limit 1
    ),
    'latest_page_audit', (
      select pg_catalog.to_jsonb(audit)
      from public.shared_award_page_audits audit
      where audit.shared_award_id = registry.canonical_shared_award_id
      order by audit.created_at desc, audit.id desc
      limit 1
    ),
    'blocking_page_audits', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.to_jsonb(audit)
        order by audit.created_at desc, audit.id desc
      )
      from public.shared_award_page_audits audit
      join public.stage1_award_members member
        on member.shared_award_id = audit.shared_award_id
      where member.cohort_key = registry.cohort_key
        and audit.resolved_at is null
        and (
          audit.audit_status in ('failed', 'needs_review')
          or audit.severity = 'critical'
        )
    ), '[]'::jsonb),
    'reconciled_fact_evidence', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.to_jsonb(materialization)
        order by materialization.field_name, materialization.id
      )
      from public.stage1_award_reconciled_fact_evidence materialization
      where materialization.shared_award_id = registry.canonical_shared_award_id
        and materialization.reconciliation_id = (
          select queue.id
          from public.shared_award_reconciliation_queue queue
          where queue.shared_award_id = registry.canonical_shared_award_id
          order by queue.created_at desc, queue.id desc
          limit 1
        )
    ), '[]'::jsonb),
    'actionable_quarantine', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.to_jsonb(quarantine)
        order by quarantine.id
      )
      from public.manual_quarantine_registry quarantine
      left join public.shared_award_sources quarantine_source
        on quarantine_source.id = quarantine.shared_award_source_id
      join public.stage1_award_members member
        on member.shared_award_id = coalesce(
          quarantine.shared_award_id,
          quarantine_source.shared_award_id
        )
      where member.cohort_key = registry.cohort_key
        and quarantine.classification = 'actionable_quarantine'
        and quarantine.status in ('quarantined', 'in_review')
    ), '[]'::jsonb)
  )
  from public.stage1_award_registry registry
  where registry.cohort_key = p_cohort_key;
$$;

revoke all on function private.stage1_promotion_review_snapshot(text)
  from public, anon, authenticated, service_role;

create or replace function public.get_stage1_promotion_review_snapshot(
  p_cohort_keys text[]
)
returns table (
  cohort_key text,
  review_hash text,
  snapshot jsonb
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    requested.cohort_key,
    public.stage1_publication_evidence_hash(
      private.stage1_promotion_review_snapshot(requested.cohort_key)
    ),
    private.stage1_promotion_review_snapshot(requested.cohort_key)
  from (
    select distinct pg_catalog.btrim(raw.cohort_key) as cohort_key
    from unnest(coalesce(p_cohort_keys, '{}'::text[])) raw(cohort_key)
    where nullif(pg_catalog.btrim(raw.cohort_key), '') is not null
  ) requested
  join public.stage1_award_registry registry
    on registry.cohort_key = requested.cohort_key
  order by registry.launch_rank;
$$;

revoke all on function public.get_stage1_promotion_review_snapshot(text[])
  from public, anon, authenticated, service_role;
grant execute on function public.get_stage1_promotion_review_snapshot(text[])
  to service_role;

create or replace function public.apply_stage1_reviewed_promotion(
  p_cohort_keys text[],
  p_expected_review_hashes jsonb,
  p_manifest_entries jsonb,
  p_reason text,
  p_policy_version text,
  p_actor text
)
returns setof public.stage1_award_registry
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cohort_keys text[];
  v_all_cohort_keys text[];
  v_target_count integer;
  v_locked_count integer;
  v_manifest_count integer;
  v_distinct_manifest_count integer;
  v_cohort_key text;
  v_expected_hash text;
  v_actual_hash text;
  v_entry jsonb;
  v_source_ids uuid[];
  v_checked_at timestamptz;
begin
  if nullif(pg_catalog.btrim(p_reason), '') is null
    or nullif(pg_catalog.btrim(p_policy_version), '') is null
    or nullif(pg_catalog.btrim(p_actor), '') is null then
    raise exception using
      errcode = '22023',
      message = 'Reviewed promotion requires an explicit reason, policy version, and actor.';
  end if;
  if pg_catalog.jsonb_typeof(p_expected_review_hashes) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_manifest_entries) is distinct from 'array' then
    raise exception using
      errcode = '22023',
      message = 'Reviewed promotion requires expected review hashes and a manifest-entry array.';
  end if;

  select coalesce(pg_catalog.array_agg(requested.cohort_key order by requested.cohort_key), '{}'::text[])
  into v_cohort_keys
  from (
    select distinct pg_catalog.btrim(raw.cohort_key) as cohort_key
    from unnest(coalesce(p_cohort_keys, '{}'::text[])) raw(cohort_key)
    where nullif(pg_catalog.btrim(raw.cohort_key), '') is not null
  ) requested;
  v_target_count := cardinality(v_cohort_keys);
  if v_target_count not in (1, 25)
    or v_target_count <> cardinality(coalesce(p_cohort_keys, '{}'::text[])) then
    raise exception using
      errcode = '22023',
      message = 'Reviewed promotion targets exactly one cohort or the exact national 25; duplicates and partial batches are forbidden.';
  end if;

  if (
      select count(*)
      from pg_catalog.jsonb_object_keys(p_expected_review_hashes) hash_key(value)
    ) <> v_target_count
    or exists (
      select 1
      from pg_catalog.jsonb_object_keys(p_expected_review_hashes) hash_key(value)
      where not (hash_key.value = any(v_cohort_keys))
    ) then
    raise exception using
      errcode = '22023',
      message = 'Expected review hashes must contain exactly one key for every requested cohort and no extras.';
  end if;

  select pg_catalog.array_agg(registry.cohort_key order by registry.cohort_key)
  into v_all_cohort_keys
  from public.stage1_award_registry registry;
  if v_target_count = 25 and (
    cardinality(v_all_cohort_keys) <> 25
    or v_cohort_keys is distinct from v_all_cohort_keys
  ) then
    raise exception using
      errcode = '23514',
      message = 'The all-awards promotion target does not exactly match the registered national 25.';
  end if;

  -- Match the release functions' canonical lock order before any promotion or
  -- table lock, so reviewed promotion cannot deadlock cohort activation.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('stage1-national-25-release', 0)
  );

  -- Serialize reviewed promotions, then briefly freeze every table that can
  -- change the reviewed snapshot or the downstream transition decision. The
  -- 10-second timeout fails safely instead of starving an active worker. The
  -- apply path is rare and explicit; correctness is more important than
  -- allowing captures/reconciliation to race a publication decision.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('awardping:stage1-promotion:' || requested.cohort_key, 0)
  )
  from unnest(v_cohort_keys) requested(cohort_key)
  order by requested.cohort_key;

  perform pg_catalog.set_config('lock_timeout', '10s', true);
  -- Registry and reviewed-evidence mutations take the national advisory lock
  -- before touching rows. Do not request conflicting table locks here: a DML
  -- statement obtains RowExclusive before its BEFORE STATEMENT trigger, which
  -- would otherwise invert the lock order and deadlock promotion.
  lock table
    public.shared_award_source_visual_snapshots,
    public.shared_award_fact_candidates,
    public.shared_award_reconciliation_queue,
    public.shared_award_page_audits,
    public.stage1_award_reconciled_fact_evidence,
    public.manual_quarantine_registry
  in share mode;

  perform registry.cohort_key
  from public.stage1_award_registry registry
  where registry.cohort_key = any(v_cohort_keys)
  order by registry.cohort_key
  for update;
  get diagnostics v_locked_count = row_count;
  if v_locked_count <> v_target_count then
    raise exception using errcode = '22023', message = 'One or more Stage 1 promotion cohorts do not exist.';
  end if;

  perform manifest.cohort_key
  from public.stage1_award_source_manifest manifest
  where manifest.cohort_key = any(v_cohort_keys)
  order by manifest.cohort_key, manifest.source_role
  for update;

  foreach v_cohort_key in array v_cohort_keys loop
    v_expected_hash := p_expected_review_hashes ->> v_cohort_key;
    v_actual_hash := public.stage1_publication_evidence_hash(
      private.stage1_promotion_review_snapshot(v_cohort_key)
    );
    if v_expected_hash is null
      or v_expected_hash !~ '^[0-9a-f]{64}$'
      or v_actual_hash is distinct from v_expected_hash then
      raise exception using
        errcode = '40001',
        message = format(
          'Stage 1 reviewed promotion is stale for %s; generate a new dry-run preview before applying.',
          v_cohort_key
        );
    end if;
  end loop;

  v_manifest_count := pg_catalog.jsonb_array_length(p_manifest_entries);
  select count(distinct concat_ws(E'\x1f', entry.value ->> 'cohort_key', entry.value ->> 'source_role'))
  into v_distinct_manifest_count
  from pg_catalog.jsonb_array_elements(p_manifest_entries) entry(value);
  if v_manifest_count <> v_target_count * 8
    or v_distinct_manifest_count <> v_manifest_count
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_manifest_entries) entry(value)
      where entry.value ->> 'cohort_key' is null
        or not ((entry.value ->> 'cohort_key') = any(v_cohort_keys))
        or entry.value ->> 'source_role' is null
        or entry.value ->> 'source_role' not in (
          'identity_home',
          'eligibility',
          'application_materials',
          'dates_cycle',
          'funding',
          'faq',
          'selection_interviews',
          'current_documents'
        )
        or entry.value ->> 'manifest_status' is null
        or entry.value ->> 'manifest_status' not in ('present', 'combined', 'not_published')
        or entry.value ->> 'policy_version' is distinct from p_policy_version
        or pg_catalog.jsonb_typeof(entry.value -> 'source_ids') is distinct from 'array'
        or pg_catalog.jsonb_typeof(entry.value -> 'evidence') is distinct from 'object'
        or nullif(pg_catalog.btrim(entry.value ->> 'checked_at'), '') is null
    )
    or exists (
      select 1
      from unnest(v_cohort_keys) requested(cohort_key)
      cross join (
        values
          ('identity_home'),
          ('eligibility'),
          ('application_materials'),
          ('dates_cycle'),
          ('funding'),
          ('faq'),
          ('selection_interviews'),
          ('current_documents')
      ) required(source_role)
      where not exists (
        select 1
        from pg_catalog.jsonb_array_elements(p_manifest_entries) entry(value)
        where entry.value ->> 'cohort_key' = requested.cohort_key
          and entry.value ->> 'source_role' = required.source_role
      )
    ) then
    raise exception using
      errcode = '23514',
      message = 'Every target requires exactly one complete reviewed entry for each of the eight Stage 1 source roles.';
  end if;

  for v_entry in
    select entry.value
    from pg_catalog.jsonb_array_elements(p_manifest_entries) entry(value)
    order by entry.value ->> 'cohort_key', entry.value ->> 'source_role'
  loop
    begin
      v_checked_at := (v_entry ->> 'checked_at')::timestamptz;
      select coalesce(pg_catalog.array_agg(source_id order by source_id), '{}'::uuid[])
      into v_source_ids
      from (
        select distinct raw.source_id::uuid as source_id
        from pg_catalog.jsonb_array_elements_text(v_entry -> 'source_ids') raw(source_id)
      ) normalized;
    exception when others then
      raise exception using
        errcode = '22023',
        message = format(
          'Manifest entry %s/%s has an invalid checked_at or source UUID.',
          v_entry ->> 'cohort_key',
          v_entry ->> 'source_role'
        );
    end;
    if pg_catalog.jsonb_array_length(v_entry -> 'source_ids')
      <> cardinality(v_source_ids) then
      raise exception using
        errcode = '22023',
        message = format(
          'Manifest entry %s/%s contains duplicate source UUIDs.',
          v_entry ->> 'cohort_key',
          v_entry ->> 'source_role'
        );
    end if;

    perform public.set_stage1_award_manifest_entry(
      v_entry ->> 'cohort_key',
      v_entry ->> 'source_role',
      v_entry ->> 'manifest_status',
      v_source_ids,
      v_entry -> 'evidence',
      v_checked_at,
      p_policy_version
    );
  end loop;

  -- Existing transition logic remains the final authority for source freshness,
  -- R2/local hashes, selected candidates, canonical reconciliation, page audit,
  -- quarantine, and exact fact-ledger materialization. In a 25-award call any
  -- failure rolls the entire transaction back.
  foreach v_cohort_key in array v_cohort_keys loop
    perform public.transition_stage1_award_publication(
      v_cohort_key,
      'verified_beta',
      pg_catalog.btrim(p_reason),
      p_policy_version,
      pg_catalog.btrim(p_actor)
    );
  end loop;

  return query
  select registry.*
  from public.stage1_award_registry registry
  where registry.cohort_key = any(v_cohort_keys)
  order by registry.launch_rank;
end;
$$;

revoke all on function public.apply_stage1_reviewed_promotion(
  text[], jsonb, jsonb, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.apply_stage1_reviewed_promotion(
  text[], jsonb, jsonb, text, text, text
) to service_role;

comment on function public.get_stage1_promotion_review_snapshot(text[]) is
  'Read-only Stage 1 promotion preview. Its hash is the CAS token consumed by apply_stage1_reviewed_promotion.';
comment on function public.apply_stage1_reviewed_promotion(text[], jsonb, jsonb, text, text, text) is
  'Atomically applies reviewed manifests and award-level verification after a fresh preview-hash comparison. It never activates the public release; activation requires separate accepted release-gate evidence.';
