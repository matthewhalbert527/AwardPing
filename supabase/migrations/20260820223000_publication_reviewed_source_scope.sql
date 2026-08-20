-- The publication transition compared manifest-bound sources against the
-- reconciliation queue row's source_ids column, which the reviewed commit
-- deliberately limits to fact-contributing sources. Reviewed roots also bind
-- role-only sources (for example a reviewed applications page whose candidate
-- quotes live in a sibling document), recorded by the reviewed commit in queue
-- metadata review_source_ids. Compare against that full reviewed set, falling
-- back to the column for pre-reviewed rows. Deployed definition with only the
-- v_review_source_ids substitution.
CREATE OR REPLACE FUNCTION public.transition_stage1_award_publication(p_cohort_key text, p_next_state text, p_reason text, p_policy_version text, p_actor text)
 RETURNS stage1_award_registry
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_registry public.stage1_award_registry%rowtype;
  v_previous_state text;
  v_evidence jsonb;
  v_checked_at timestamptz;
  v_reconciliation jsonb;
  v_review_source_ids jsonb;
  v_page_audit jsonb;
  v_ledger_batch_id uuid;
  v_public_fact_count integer;
  v_ledger_count integer;
begin
  if p_next_state not in ('pending', 'verified_beta', 'revalidation_pending', 'suspended') then
    raise exception using errcode = '22023', message = 'Invalid Stage 1 publication state.';
  end if;
  if nullif(pg_catalog.btrim(p_reason), '') is null
    or nullif(pg_catalog.btrim(p_policy_version), '') is null
    or nullif(pg_catalog.btrim(p_actor), '') is null then
    raise exception using
      errcode = '22023',
      message = 'Publication transitions require a reason, policy version, and actor.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('stage1-national-25-release', 0)
  );

  select * into v_registry
  from public.stage1_award_registry registry
  where registry.cohort_key = p_cohort_key
  for update;

  if not found then
    raise exception using errcode = '22023', message = 'Unknown Stage 1 cohort key.';
  end if;

  v_previous_state := v_registry.publication_state;

  select
    pg_catalog.jsonb_object_agg(
      manifest.source_role,
      pg_catalog.jsonb_build_object(
        'status', manifest.manifest_status,
        'source_ids', manifest.source_ids,
        'evidence', manifest.evidence,
        'checked_at', manifest.checked_at,
        'policy_version', manifest.policy_version
      )
      order by manifest.source_role
    ),
    min(manifest.checked_at)
  into v_evidence, v_checked_at
  from public.stage1_award_source_manifest manifest
  where manifest.cohort_key = p_cohort_key;

  if p_next_state = 'verified_beta' then
    if v_registry.canonical_shared_award_id is null
      or not exists (
        select 1
        from public.shared_awards award
        where award.id = v_registry.canonical_shared_award_id
          and award.status = 'active'
          and award.name = v_registry.canonical_name
          and award.slug = v_registry.canonical_slug
          and award.official_homepage = v_registry.official_homepage
      ) then
      raise exception using
        errcode = '23514',
        message = 'The canonical Stage 1 award identity is missing, inactive, or differs from the reviewed registry.';
    end if;

    if (
      select count(*)
      from public.stage1_award_source_manifest manifest
      where manifest.cohort_key = p_cohort_key
        and manifest.manifest_status in ('present', 'combined', 'not_published')
        and manifest.checked_at >= now() - interval '24 hours'
        and (manifest.evidence ->> 'r2_verified_at')::timestamptz
          between now() - interval '24 hours' and now() + interval '5 minutes'
        and (manifest.evidence ->> 'local_verified_at')::timestamptz
          between now() - interval '24 hours' and now() + interval '5 minutes'
        and manifest.policy_version = p_policy_version
        and public.stage1_manifest_evidence_complete(
          manifest.manifest_status,
          manifest.evidence,
          p_policy_version
        )
    ) <> 8 then
      raise exception using
        errcode = '23514',
        message = 'All eight Stage 1 source roles require fresh, complete, matching evidence.';
    end if;

    if not exists (
      select 1
      from public.stage1_award_source_manifest manifest
      join public.shared_award_sources source
        on cardinality(manifest.source_ids) = 1
        and source.id = manifest.source_ids[1]
      where manifest.cohort_key = p_cohort_key
        and manifest.source_role = 'identity_home'
        and manifest.manifest_status in ('present', 'combined')
        and source.url = v_registry.official_homepage
        and manifest.evidence ->> 'source_url' = v_registry.official_homepage
        and manifest.evidence #>> array[
          'source_bindings', source.id::text, 'source_url'
        ] = v_registry.official_homepage
    ) then
      raise exception using
        errcode = '23514',
        message = 'The identity_home manifest does not exactly bind the reviewed registry homepage.';
    end if;

    if exists (
      select 1
      from public.stage1_award_source_manifest manifest
      cross join unnest(manifest.source_ids) source_id
      left join public.shared_award_sources source on source.id = source_id
      left join public.shared_award_source_visual_snapshots snapshot
        on snapshot.shared_award_source_id = source.id
      left join public.stage1_award_members member
        on member.shared_award_id = source.shared_award_id
        and member.cohort_key = p_cohort_key
      where manifest.cohort_key = p_cohort_key
        and (
          source.id is null
          or member.shared_award_id is null
          or source.admin_review_status <> 'open'
          or source.last_checked_at is null
          or source.last_checked_at < now() - interval '24 hours'
          or nullif(pg_catalog.btrim(source.last_error), '') is not null
          or exists (
            select 1
            from public.stage1_award_source_identity_rules identity_rule
            where identity_rule.cohort_key = p_cohort_key
              and (
                (
                  identity_rule.url_pattern is not null
                  and source.url ~* identity_rule.url_pattern
                )
                or (
                  identity_rule.title_pattern is not null
                  and concat_ws(' ', source.title, source.display_title) ~*
                    identity_rule.title_pattern
                )
              )
          )
          or snapshot.shared_award_source_id is null
          or snapshot.latest_captured_at is null
          or snapshot.latest_captured_at < now() - interval '24 hours'
          or snapshot.latest_object_keys = '{}'::jsonb
          or snapshot.latest_hashes = '{}'::jsonb
          or manifest.evidence #>> array['source_bindings', source_id::text, 'source_url']
            is distinct from source.url
          or manifest.evidence #> array['source_bindings', source_id::text, 'object_keys']
            is distinct from snapshot.latest_object_keys
          or manifest.evidence #> array['source_bindings', source_id::text, 'hashes']
            is distinct from snapshot.latest_hashes
          or manifest.evidence #> array['source_bindings', source_id::text, 'r2_hashes']
            is distinct from snapshot.latest_hashes
          or manifest.evidence #> array['source_bindings', source_id::text, 'local_hashes']
            is distinct from snapshot.latest_hashes
          or (
            manifest.evidence #>> array['source_bindings', source_id::text, 'captured_at']
          )::timestamptz is distinct from snapshot.latest_captured_at
        )
    ) then
      raise exception using
        errcode = '23514',
        message = 'A Stage 1 manifest source is stale, failed, closed, or belongs to another award.';
    end if;

    if exists (
      select 1
      from public.stage1_award_source_manifest manifest
      cross join lateral (
        select case
          when raw.candidate_id_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          then raw.candidate_id_text::uuid
          else null
        end as candidate_id
        from pg_catalog.jsonb_array_elements_text(
          manifest.evidence -> 'fact_candidate_ids'
        ) raw(candidate_id_text)
      ) requested
      left join public.shared_award_fact_candidates candidate
        on candidate.id = requested.candidate_id
      left join public.shared_award_sources candidate_source
        on candidate_source.id = candidate.shared_award_source_id
      left join public.stage1_award_members candidate_member
        on candidate_member.shared_award_id = candidate.shared_award_id
        and candidate_member.cohort_key = p_cohort_key
      where manifest.cohort_key = p_cohort_key
        and manifest.manifest_status in ('present', 'combined')
        and (
          requested.candidate_id is null
          or candidate.id is null
          or candidate.candidate_status <> 'selected'
          or candidate_member.shared_award_id is null
          or candidate.shared_award_source_id is null
          or not (candidate.shared_award_source_id = any(manifest.source_ids))
          or candidate_source.id is null
          or candidate_source.shared_award_id <> candidate.shared_award_id
          or manifest.evidence #>> array[
            'candidate_bindings', candidate.id::text, 'source_id'
          ] is distinct from candidate.shared_award_source_id::text
          or manifest.evidence #>> array[
            'candidate_bindings', candidate.id::text, 'candidate_source_role'
          ] is distinct from candidate.source_role
          or manifest.evidence #>> array[
            'candidate_bindings', candidate.id::text, 'source_role'
          ] is distinct from manifest.source_role
          or manifest.evidence #>> array[
            'candidate_bindings', candidate.id::text, 'field_name'
          ] is distinct from candidate.field_name
          or manifest.evidence #> array[
            'candidate_bindings', candidate.id::text, 'normalized_value'
          ] is distinct from candidate.normalized_value
          or manifest.evidence #>> array[
            'candidate_bindings', candidate.id::text, 'evidence_quote'
          ] is distinct from candidate.evidence_quote
          or manifest.evidence #>> array[
            'candidate_bindings', candidate.id::text, 'evidence_location'
          ] is distinct from candidate.evidence_location
          or manifest.evidence #>> array[
            'candidate_bindings', candidate.id::text, 'intake_value_sha256'
          ] is distinct from candidate.intake_value_sha256
        )
    ) then
      raise exception using
        errcode = '23514',
        message = 'A Stage 1 candidate no longer matches its reviewed role, wording, location, intake hash, or source.';
    end if;

    if exists (
      select 1
      from public.manual_quarantine_registry quarantine
      left join public.shared_award_sources quarantine_source
        on quarantine_source.id = quarantine.shared_award_source_id
      join public.stage1_award_members member
        on member.shared_award_id = coalesce(
          quarantine.shared_award_id,
          quarantine_source.shared_award_id
        )
      where member.cohort_key = p_cohort_key
        and quarantine.classification = 'actionable_quarantine'
        and quarantine.status in ('quarantined', 'in_review')
    ) then
      raise exception using
        errcode = '23514',
        message = 'Unresolved manual quarantine blocks Stage 1 publication.';
    end if;

    if exists (
      select 1
      from public.shared_award_page_audits audit
      join public.stage1_award_members member
        on member.shared_award_id = audit.shared_award_id
      where member.cohort_key = p_cohort_key
        and audit.resolved_at is null
        and (
          audit.audit_status in ('failed', 'needs_review')
          or audit.severity = 'critical'
        )
    ) then
      raise exception using
        errcode = '23514',
        message = 'An unresolved critical or failed page audit blocks Stage 1 publication.';
    end if;

    select to_jsonb(queue)
    into v_reconciliation
    from public.shared_award_reconciliation_queue queue
    where queue.shared_award_id = v_registry.canonical_shared_award_id
    order by queue.created_at desc, queue.id desc
    limit 1;
    v_review_source_ids := coalesce(
      case
        when pg_catalog.jsonb_typeof(
          v_reconciliation #> array['metadata', 'review_source_ids']
        ) = 'array'
        then v_reconciliation #> array['metadata', 'review_source_ids']
      end,
      v_review_source_ids
    );

    if v_reconciliation is null
      or v_reconciliation ->> 'status' <> 'succeeded'
      or v_reconciliation ->> 'completed_at' is null
      or (v_reconciliation ->> 'completed_at')::timestamptz < now() - interval '24 hours'
      or pg_catalog.jsonb_typeof(v_review_source_ids) <> 'array'
      or pg_catalog.jsonb_typeof(v_reconciliation -> 'candidate_ids') <> 'array' then
      raise exception using
        errcode = '23514',
        message = 'A fresh successful canonical reconciliation with exact source and candidate identities is required.';
    end if;

    if exists (
      select 1
      from public.stage1_award_source_manifest manifest
      cross join unnest(manifest.source_ids) source_id
      where manifest.cohort_key = p_cohort_key
        and not ((v_review_source_ids) ? source_id::text)
    ) or exists (
      select 1
      from (
        select case
          when raw.value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          then raw.value::uuid
          else null
        end as source_id
        from pg_catalog.jsonb_array_elements_text(
          v_review_source_ids
        ) raw(value)
      ) reconciled
      left join public.shared_award_sources source on source.id = reconciled.source_id
      left join public.stage1_award_members member
        on member.shared_award_id = source.shared_award_id
        and member.cohort_key = p_cohort_key
      where reconciled.source_id is null
        or source.id is null
        or member.shared_award_id is null
        or not exists (
          select 1
          from public.stage1_award_source_manifest manifest
          where manifest.cohort_key = p_cohort_key
            and reconciled.source_id = any(manifest.source_ids)
        )
    ) or exists (
      select 1
      from public.stage1_award_source_manifest manifest
      cross join lateral pg_catalog.jsonb_array_elements_text(
        manifest.evidence -> 'fact_candidate_ids'
      ) manifest_candidate(value)
      where manifest.cohort_key = p_cohort_key
        and not ((v_reconciliation -> 'candidate_ids') ? manifest_candidate.value)
    ) or exists (
      select 1
      from (
        select case
          when raw.value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          then raw.value::uuid
          else null
        end as candidate_id
        from pg_catalog.jsonb_array_elements_text(
          v_reconciliation -> 'candidate_ids'
        ) raw(value)
      ) reconciled
      left join public.shared_award_fact_candidates candidate
        on candidate.id = reconciled.candidate_id
      left join public.shared_award_sources source
        on source.id = candidate.shared_award_source_id
      left join public.stage1_award_members member
        on member.shared_award_id = candidate.shared_award_id
        and member.cohort_key = p_cohort_key
      where reconciled.candidate_id is null
        or candidate.id is null
        or candidate.candidate_status <> 'selected'
        or member.shared_award_id is null
        or source.id is null
        or source.shared_award_id <> candidate.shared_award_id
        or not ((v_review_source_ids) ? source.id::text)
        or not exists (
          select 1
          from public.stage1_award_source_manifest manifest
          where manifest.cohort_key = p_cohort_key
            and source.id = any(manifest.source_ids)
            and (manifest.evidence -> 'fact_candidate_ids') ? candidate.id::text
        )
    ) then
      raise exception using
        errcode = '23514',
        message = 'Canonical reconciliation identities must exactly equal the reviewed manifest sources and candidates.';
    end if;

    select to_jsonb(audit)
    into v_page_audit
    from public.shared_award_page_audits audit
    where audit.shared_award_id = v_registry.canonical_shared_award_id
      and audit.audit_kind = 'deterministic'
    order by audit.created_at desc, audit.id desc
    limit 1;

    if v_page_audit is null
      or v_page_audit ->> 'audit_status' <> 'passed'
      or (v_page_audit ->> 'created_at')::timestamptz < now() - interval '24 hours'
      or pg_catalog.jsonb_typeof(v_page_audit -> 'public_page_snapshot') <> 'object' then
      raise exception using
        errcode = '23514',
        message = 'A fresh passed canonical page audit with an exact public-page snapshot is required.';
    end if;

    select count(*)
    into v_public_fact_count
    from public.shared_awards award
    cross join lateral pg_catalog.jsonb_each(award.public_facts) fact
    where award.id = v_registry.canonical_shared_award_id
      and fact.key in (
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
      and fact.value not in (
        'null'::jsonb,
        '""'::jsonb,
        '[]'::jsonb,
        '{}'::jsonb
      );

    if v_public_fact_count = 0 or not exists (
      select 1
      from public.shared_awards award
      where award.id = v_registry.canonical_shared_award_id
        and award.public_facts -> 'overview' not in (
          'null'::jsonb,
          '""'::jsonb,
          '[]'::jsonb,
          '{}'::jsonb
        )
    ) then
      raise exception using
        errcode = '23514',
        message = 'Stage 1 publication requires a reconciled, evidence-bound public overview.';
    end if;

    v_ledger_batch_id := gen_random_uuid();

    insert into public.stage1_award_fact_publication_ledger (
      verification_batch_id,
      cohort_key,
      field_name,
      materialization_id,
      candidate_id,
      source_id,
      source_url,
      source_role,
      contributing_candidate_ids,
      contributing_source_ids,
      supporting_text,
      source_snapshot_hashes,
      source_captured_at,
      reconciliation_id,
      page_audit_id,
      normalized_value,
      public_value,
      cycle,
      policy_version,
      evidence_hash
    )
    select distinct on (fact.key)
      v_ledger_batch_id,
      p_cohort_key,
      fact.key,
      materialization.id,
      candidate.id,
      candidate.shared_award_source_id,
      source.url,
      manifest.source_role,
      materialization.candidate_ids,
      materialization.source_ids,
      manifest.evidence #>> array[
        'candidate_bindings', candidate.id::text, 'evidence_quote'
      ],
      manifest.evidence #> array[
        'source_bindings',
        candidate.shared_award_source_id::text,
        'hashes'
      ],
      (
        manifest.evidence #>> array[
          'source_bindings',
          candidate.shared_award_source_id::text,
          'captured_at'
        ]
      )::timestamptz,
      (v_reconciliation ->> 'id')::uuid,
      (v_page_audit ->> 'id')::uuid,
      materialization.public_value,
      fact.value,
      manifest.evidence ->> 'cycle',
      p_policy_version,
      public.stage1_publication_evidence_hash(
        pg_catalog.jsonb_build_object(
          'cohort_key', p_cohort_key,
          'field_name', fact.key,
          'materialization_id', materialization.id,
          'candidate_id', candidate.id,
          'source_id', candidate.shared_award_source_id,
          'source_url', source.url,
          'source_role', manifest.source_role,
          'contributing_candidate_ids', materialization.candidate_ids,
          'contributing_source_ids', materialization.source_ids,
          'supporting_text', manifest.evidence #>> array[
            'candidate_bindings', candidate.id::text, 'evidence_quote'
          ],
          'source_snapshot_hashes', manifest.evidence #> array[
            'source_bindings',
            candidate.shared_award_source_id::text,
            'hashes'
          ],
          'source_captured_at', manifest.evidence #>> array[
            'source_bindings',
            candidate.shared_award_source_id::text,
            'captured_at'
          ],
          'reconciliation_id', v_reconciliation ->> 'id',
          'page_audit_id', v_page_audit ->> 'id',
          'normalized_value', materialization.public_value,
          'public_value', fact.value,
          'cycle', manifest.evidence ->> 'cycle',
          'policy_version', p_policy_version
        )
      )
    from public.shared_awards award
    cross join lateral pg_catalog.jsonb_each(award.public_facts) fact
    join public.stage1_award_reconciled_fact_evidence materialization
      on materialization.shared_award_id = v_registry.canonical_shared_award_id
      and materialization.reconciliation_id = (v_reconciliation ->> 'id')::uuid
      and materialization.field_name = fact.key
      and materialization.public_value = fact.value
      and materialization.materialized_at >= now() - interval '24 hours'
      and materialization.evidence_hash =
        public.stage1_publication_evidence_hash(materialization.evidence)
    join public.shared_award_fact_candidates candidate
      on candidate.id = materialization.candidate_ids[1]
      and candidate.candidate_status = 'selected'
      and candidate.shared_award_source_id is not null
      and candidate.id = any(materialization.candidate_ids)
      and candidate.shared_award_source_id = any(materialization.source_ids)
      and (v_reconciliation -> 'candidate_ids') ? candidate.id::text
      and (v_review_source_ids) ? candidate.shared_award_source_id::text
      and v_page_audit -> 'public_page_snapshot' -> fact.key = fact.value
    join public.stage1_award_source_manifest manifest
      on manifest.cohort_key = p_cohort_key
      and candidate.shared_award_source_id = any(manifest.source_ids)
      and (manifest.evidence -> 'fact_candidate_ids') ? candidate.id::text
    join public.shared_award_sources source
      on source.id = candidate.shared_award_source_id
    where award.id = v_registry.canonical_shared_award_id
      and fact.key in (
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
      and fact.value not in (
        'null'::jsonb,
        '""'::jsonb,
        '[]'::jsonb,
        '{}'::jsonb
      )
      and materialization.evidence ->> 'award_id'
        = v_registry.canonical_shared_award_id::text
      and materialization.evidence ->> 'reconciliation_id'
        = (v_reconciliation ->> 'id')
      and materialization.evidence ->> 'field_name' = fact.key
      and materialization.evidence -> 'public_value' = fact.value
      and materialization.evidence -> 'candidate_ids'
        = pg_catalog.to_jsonb(materialization.candidate_ids)
      and materialization.evidence -> 'source_ids'
        = pg_catalog.to_jsonb(materialization.source_ids)
      and not exists (
        select 1
        from unnest(materialization.candidate_ids) contributor_id
        left join public.shared_award_fact_candidates contributor
          on contributor.id = contributor_id
        left join public.shared_award_sources contributor_source
          on contributor_source.id = contributor.shared_award_source_id
        left join public.stage1_award_members contributor_member
          on contributor_member.shared_award_id = contributor.shared_award_id
          and contributor_member.cohort_key = p_cohort_key
        where contributor.id is null
          or contributor.candidate_status <> 'selected'
          or contributor_member.shared_award_id is null
          or contributor_source.id is null
          or contributor_source.shared_award_id <> contributor.shared_award_id
          or not (contributor_source.id = any(materialization.source_ids))
          or not ((v_reconciliation -> 'candidate_ids') ? contributor.id::text)
          or not ((v_review_source_ids) ? contributor_source.id::text)
          or materialization.evidence #>> array[
            'candidate_bindings', contributor.id::text, 'source_id'
          ] is distinct from contributor.shared_award_source_id::text
          or materialization.evidence #>> array[
            'candidate_bindings', contributor.id::text, 'field_name'
          ] is distinct from contributor.field_name
          or materialization.evidence #> array[
            'candidate_bindings', contributor.id::text, 'normalized_value'
          ] is distinct from contributor.normalized_value
          or materialization.evidence #>> array[
            'candidate_bindings', contributor.id::text, 'evidence_quote'
          ] is distinct from contributor.evidence_quote
          or materialization.evidence #>> array[
            'candidate_bindings', contributor.id::text, 'evidence_location'
          ] is distinct from contributor.evidence_location
          or materialization.evidence #>> array[
            'candidate_bindings', contributor.id::text, 'intake_value_sha256'
          ] is distinct from contributor.intake_value_sha256
      )
    order by
      fact.key,
      materialization.materialized_at desc,
      materialization.id desc;

    select count(*) into v_ledger_count
    from public.stage1_award_fact_publication_ledger ledger
    where ledger.verification_batch_id = v_ledger_batch_id;

    if v_ledger_count <> v_public_fact_count then
      raise exception using
        errcode = '23514',
        message = format(
          'Only %s of %s published fact fields have exact selected-candidate evidence.',
          v_ledger_count,
          v_public_fact_count
        );
    end if;
  end if;

  if p_next_state = 'verified_beta' then
    v_evidence := pg_catalog.jsonb_build_object(
      'source_manifest', coalesce(v_evidence, '{}'::jsonb),
      'reconciliation', v_reconciliation,
      'page_audit', v_page_audit,
      'fact_ledger_batch_id', v_ledger_batch_id,
      'evaluated_at', now()
    );
  end if;

  update public.stage1_award_registry registry
  set
    publication_state = p_next_state,
    state_reason = pg_catalog.btrim(p_reason),
    policy_version = p_policy_version,
    fact_ledger_batch_id = case
      when p_next_state = 'verified_beta' then v_ledger_batch_id
      else registry.fact_ledger_batch_id
    end,
    release_epoch = null,
    evidence_checked_at = case
      when p_next_state = 'verified_beta' then v_checked_at
      else registry.evidence_checked_at
    end,
    last_verified_at = case
      when p_next_state = 'verified_beta' then now()
      else registry.last_verified_at
    end,
    updated_at = now()
  where registry.cohort_key = p_cohort_key
  returning * into v_registry;

  perform public.invalidate_stage1_cohort_release(
    'A Stage 1 award publication state changed; the 25-award release requires a new atomic activation.',
    p_actor
  );

  insert into public.stage1_award_publication_events (
    cohort_key,
    previous_state,
    next_state,
    reason,
    policy_version,
    evidence_snapshot,
    evidence_hash,
    actor
  )
  values (
    p_cohort_key,
    v_previous_state,
    p_next_state,
    pg_catalog.btrim(p_reason),
    p_policy_version,
    coalesce(v_evidence, '{}'::jsonb),
    public.stage1_publication_evidence_hash(coalesce(v_evidence, '{}'::jsonb)),
    pg_catalog.btrim(p_actor)
  );

  return v_registry;
end;
$function$
;
