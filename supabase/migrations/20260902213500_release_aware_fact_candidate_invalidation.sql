-- Release-aware fact-candidate invalidation (owner-directed 2026-09-02):
-- same split as the source-change trigger - released cohorts keep serving
-- while flagged for re-verification; unreleased cohorts demote as before.

CREATE OR REPLACE FUNCTION public.invalidate_stage1_publication_on_fact_candidate_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_award_ids uuid[] := '{}'::uuid[];
  v_cohort_keys text[] := '{}'::text[];
  v_invalidated_at timestamptz := pg_catalog.clock_timestamp();
  v_invalidated_count integer := 0;
  v_evidence jsonb;
begin
  if tg_op = 'UPDATE' and not (
    old.shared_award_id is distinct from new.shared_award_id
    or old.shared_award_source_id is distinct from new.shared_award_source_id
    or old.source_url is distinct from new.source_url
    or old.source_title is distinct from new.source_title
    or old.source_role is distinct from new.source_role
    or old.source_quality_decision is distinct from new.source_quality_decision
    or old.field_name is distinct from new.field_name
    or old.raw_value is distinct from new.raw_value
    or old.normalized_value is distinct from new.normalized_value
    or old.evidence_quote is distinct from new.evidence_quote
    or old.evidence_location is distinct from new.evidence_location
    or old.extracted_at is distinct from new.extracted_at
    or old.model is distinct from new.model
    or old.confidence is distinct from new.confidence
    or old.candidate_status is distinct from new.candidate_status
    -- Disposition reasons are reviewed provenance. A changed ranking or
    -- rejection rationale must invalidate the reviewed release even when the
    -- candidate value and public text remain byte-for-byte equal.
    or old.selected_reason is distinct from new.selected_reason
    or old.rejection_reason is distinct from new.rejection_reason
    or old.source_page_request_id is distinct from new.source_page_request_id
    or old.intake_value_sha256 is distinct from new.intake_value_sha256
    or old.metadata is distinct from new.metadata
  ) then
    return new;
  end if;

  if tg_op <> 'DELETE' then
    v_award_ids := pg_catalog.array_append(v_award_ids, new.shared_award_id);
  end if;
  if tg_op <> 'INSERT' then
    v_award_ids := pg_catalog.array_append(v_award_ids, old.shared_award_id);
  end if;

  select coalesce(
    pg_catalog.array_agg(distinct member.cohort_key order by member.cohort_key),
    '{}'::text[]
  )
  into v_cohort_keys
  from public.stage1_award_members member
  where member.shared_award_id = any(v_award_ids);

  if pg_catalog.cardinality(v_cohort_keys) = 0 then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  v_evidence := pg_catalog.jsonb_build_object(
    'trigger_table', tg_table_name,
    'operation', tg_op,
    'candidate_id', case when tg_op = 'DELETE' then old.id else new.id end,
    'cohort_keys', pg_catalog.to_jsonb(v_cohort_keys),
    'invalidated_at', v_invalidated_at
  );

  with refreshed_released as (
    -- OWNER DIRECTIVE 2026-09-02: released cohorts keep serving the last
    -- verified publication while an evidence-binding change re-verifies
    -- (same split as invalidate_stage1_publication_on_source_change).
    update public.stage1_award_registry registry
    set
      state_reason = 'A fact-candidate evidence binding changed after release; re-verification is scheduled while the last verified publication stays live.',
      evidence_checked_at = null,
      updated_at = v_invalidated_at
    where registry.cohort_key = any(v_cohort_keys)
      and registry.publication_state = 'verified_beta'
      and registry.release_epoch is not null
    returning registry.cohort_key
  ), invalidated as (
    update public.stage1_award_registry registry
    set
      publication_state = 'revalidation_pending',
      release_epoch = null,
      state_reason = 'A fact-candidate evidence binding changed; fresh Stage 1 verification is required.',
      evidence_checked_at = null,
      updated_at = v_invalidated_at
    where registry.cohort_key = any(v_cohort_keys)
      and registry.publication_state = 'verified_beta'
      and registry.release_epoch is null
    returning registry.cohort_key, registry.policy_version
  )
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
  select
    invalidated.cohort_key,
    'verified_beta',
    'revalidation_pending',
    'A fact-candidate evidence binding changed; fresh Stage 1 verification is required.',
    invalidated.policy_version,
    v_evidence,
    public.stage1_publication_evidence_hash(v_evidence),
    'database-trigger'
  from invalidated;

  get diagnostics v_invalidated_count = row_count;

  if v_invalidated_count > 0 then
    perform public.invalidate_stage1_cohort_release(
      'A Stage 1 fact-candidate evidence binding changed; the 25-award release requires revalidation.',
      'database-trigger'
    );
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$function$

