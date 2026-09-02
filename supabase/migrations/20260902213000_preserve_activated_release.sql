-- Preserve an activated Stage 1 release through routine invalidation
-- signals (owner-directed 2026-09-02): thirteen minutes after launch, a
-- fact-candidate binding change on one homepage yanked the whole 25-award
-- release. Cohort-level flags and the reconciliation queue carry the
-- re-verification work; the release now survives unless it was never
-- activated or an operator suspends it. Generated from the live definition
-- with only the early-return guard added.

CREATE OR REPLACE FUNCTION public.invalidate_stage1_cohort_release(p_reason text, p_actor text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_release public.stage1_publication_release_state%rowtype;
  v_evidence jsonb;
  v_invalidated_at timestamptz := now();
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('stage1-national-25-release', 0)
  );

  select * into v_release
  from public.stage1_publication_release_state release_state
  where release_state.release_key = 'stage1-national-25'
  for update;

  if not found then
    raise exception using
      errcode = '23514',
      message = 'The authoritative Stage 1 cohort release row is missing.';
  end if;

  -- OWNER DIRECTIVE 2026-09-02 (publish now, refine daily): an ACTIVATED
  -- release stays live through routine invalidation signals. Cohort-level
  -- re-verification flags and the reconciliation queue carry the work; the
  -- release and its epochs are yanked only pre-activation (fail-closed
  -- launch semantics unchanged) or by explicit operator action.
  if v_release.activated_at is not null and v_release.release_state = 'verified_beta' then
    update public.stage1_publication_release_state release_state
    set reason = pg_catalog.btrim(p_reason)
      || ' [recorded while the activated release stayed live, '
      || pg_catalog.to_char(v_invalidated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
      || ']',
      updated_at = v_invalidated_at
    where release_state.release_key = 'stage1-national-25';
    return;
  end if;

  update public.stage1_award_registry registry
  set
    release_epoch = null,
    updated_at = v_invalidated_at
  where registry.release_epoch is not null;

  if v_release.release_state = 'verified_beta' or v_release.release_epoch is not null then
    v_evidence := pg_catalog.jsonb_build_object(
      'prior_release_epoch', v_release.release_epoch,
      'invalidated_at', v_invalidated_at,
      'reason', pg_catalog.btrim(p_reason)
    );

    update public.stage1_publication_release_state release_state
    set
      release_state = 'revalidation_pending',
      release_epoch = null,
      reason = pg_catalog.btrim(p_reason),
      activated_at = null,
      updated_at = v_invalidated_at
    where release_state.release_key = 'stage1-national-25';

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
      v_release.release_epoch,
      pg_catalog.btrim(p_reason),
      v_release.policy_version,
      v_release.cohort_identity_version,
      v_release.cohort_identity_hash,
      v_evidence,
      public.stage1_publication_evidence_hash(v_evidence),
      coalesce(nullif(pg_catalog.btrim(p_actor), ''), 'database-trigger')
    );
  end if;
end;
$function$

