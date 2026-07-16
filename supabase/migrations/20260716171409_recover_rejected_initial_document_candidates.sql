-- Re-open only the historical deterministic first-document candidates that
-- were rejected by the narrower generic applicant-signal vocabulary. The
-- worker re-runs the immutable first-document guard and current global policy
-- before calling this RPC. The database then CAS-checks every durable identity
-- and keeps the quarantine open until normal atomic publication succeeds.

create or replace function public.recover_rejected_initial_official_document_candidate(
  p_candidate_id uuid,
  p_acquisition_id uuid,
  p_expected_candidate_signature text,
  p_expected_candidate_evidence_signature text,
  p_expected_quarantine_evidence_hash text,
  p_policy_guard jsonb
)
returns table(candidate_id uuid, recovered boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_candidate public.shared_award_visual_review_candidates%rowtype;
  v_acquisition public.shared_award_source_acquisitions%rowtype;
  v_source public.shared_award_sources%rowtype;
  v_award public.shared_awards%rowtype;
  v_quarantine public.manual_quarantine_registry%rowtype;
  v_recovered_id uuid;
  v_exact_after text;
  v_attestation_json text;
  v_attestation_sha256 text;
begin
  if p_candidate_id is null
    or p_acquisition_id is null
    or coalesce(p_expected_candidate_signature, '') !~ '^[0-9a-f]{64}$'
    or coalesce(p_expected_candidate_evidence_signature, '') !~ '^[0-9a-f]{64}$'
    or coalesce(p_expected_quarantine_evidence_hash, '') !~ '^[0-9a-f]{64}$'
    or p_policy_guard is null
    or jsonb_typeof(p_policy_guard) <> 'object'
    or p_policy_guard ->> 'allowed' is distinct from 'true'
    or p_policy_guard ->> 'reason' is distinct from 'approved'
    or p_policy_guard ->> 'guard' is distinct from 'latest_policy'
    or jsonb_typeof(p_policy_guard -> 'policy_identity') <> 'object'
    or nullif(btrim(p_policy_guard #>> '{policy_identity,id}'), '') is null
    or length(p_policy_guard #>> '{policy_identity,id}') > 512
    or nullif(btrim(p_policy_guard #>> '{policy_identity,version}'), '') is null
    or length(p_policy_guard #>> '{policy_identity,version}') > 200
    or coalesce(p_policy_guard #>> '{policy_identity,hash}', '')
      !~ '^fnv1a32x2-utf16:[0-9a-f]{16}$' then
    raise exception using
      errcode = '22023',
      message = 'A complete current-policy recovery attestation and expected evidence identity are required.';
  end if;

  select candidate.* into strict v_candidate
  from public.shared_award_visual_review_candidates candidate
  where candidate.id = p_candidate_id
  for update;

  if v_candidate.candidate_scope <> 'initial_official_document'
    or v_candidate.source_acquisition_id is distinct from p_acquisition_id
    or v_candidate.status <> 'rejected'
    or v_candidate.rejection_reason is distinct from 'missing_deterministic_applicant_fact_signal'
    or v_candidate.candidate_signature is distinct from p_expected_candidate_signature
    or v_candidate.worker_metadata ->> 'evidence_signature'
      is distinct from p_expected_candidate_evidence_signature
    or v_candidate.publication_claim_token is not null
    or v_candidate.publication_claimed_at is not null
    or v_candidate.model is not null
    or v_candidate.gemini_batch_name is not null
    or v_candidate.gemini_batch_request_key is not null
    or v_candidate.estimated_cost_usd is not null
    or coalesce(v_candidate.actual_usage, '{}'::jsonb) <> '{}'::jsonb
    or v_candidate.ai_result #>> '{review_execution,api_review_required}' is distinct from 'false'
    or v_candidate.ai_result #>> '{review_execution,creates_api_charge}' is distinct from 'false'
    or v_candidate.ai_result ->> 'candidate_scope' is distinct from 'initial_official_document'
    or v_candidate.ai_result ->> 'observation_kind' is distinct from 'first_observation'
    or v_candidate.deterministic_diff ->> 'candidate_scope' is distinct from 'initial_official_document'
    or v_candidate.deterministic_diff ->> 'first_observation' is distinct from 'true'
    or v_candidate.deterministic_diff ->> 'candidate_change' is distinct from 'true'
    or coalesce(v_candidate.new_file_hash, '') !~ '^[0-9a-f]{64}$' then
    raise exception using
      errcode = '23514',
      message = 'Only the exact zero-charge rejected first-document candidate is recoverable.';
  end if;

  if exists (
    select 1
    from public.shared_award_change_events event
    where event.visual_review_candidate_id = v_candidate.id
  ) or exists (
    select 1
    from public.shared_award_change_event_visual_evidence evidence
    where evidence.visual_review_candidate_id = v_candidate.id
  ) then
    raise exception using
      errcode = '23514',
      message = 'A candidate with a published event or evidence row cannot use rejected-candidate recovery.';
  end if;

  select acquisition.* into strict v_acquisition
  from public.shared_award_source_acquisitions acquisition
  where acquisition.id = p_acquisition_id
  for share;

  if v_acquisition.shared_award_source_id is distinct from v_candidate.shared_award_source_id
    or v_acquisition.notification_mode <> 'first_capture_candidate'
    or v_acquisition.onboarding_batch_id is not null
    or v_acquisition.review_seal ->> 'sealed' is distinct from 'true'
    or v_acquisition.review_seal ->> 'status' is distinct from 'accepted'
    or v_acquisition.review_seal ->> 'page_type' is distinct from 'pdf'
    or v_acquisition.review_seal ->> 'capture_file_hash' is distinct from v_candidate.new_file_hash then
    raise exception using
      errcode = '23514',
      message = 'Rejected-candidate recovery requires the same eligible immutable source acquisition.';
  end if;

  select source.* into strict v_source
  from public.shared_award_sources source
  where source.id = v_candidate.shared_award_source_id
  for share;
  if v_source.shared_award_id is distinct from v_candidate.shared_award_id
    or v_source.admin_review_status <> 'open'
    or v_source.url is distinct from v_candidate.source_url
    or v_source.page_type is distinct from 'pdf'
    or v_candidate.source_page_type is distinct from 'pdf'
    or v_acquisition.review_seal ->> 'capture_final_url' is distinct from v_source.url
    or v_candidate.prompt_payload #>> '{first_observation_attestation,body,source,url}'
      is distinct from v_source.url
    or v_candidate.prompt_payload #>> '{first_observation_attestation,body,capture,final_url}'
      is distinct from v_source.url
    or v_candidate.prompt_payload #>> '{first_observation_attestation,body,sealed_review,capture_final_url}'
      is distinct from v_source.url then
    raise exception using
      errcode = '23514',
      message = 'Rejected-candidate recovery requires the same open monitored source identity.';
  end if;

  select award.* into strict v_award
  from public.shared_awards award
  where award.id = v_candidate.shared_award_id
  for share;
  if v_award.status <> 'active' then
    raise exception using
      errcode = '23514',
      message = 'Rejected-candidate recovery requires the same active award as publication.';
  end if;

  v_exact_after := nullif(btrim(v_candidate.ai_result ->> 'exact_after'), '');
  v_attestation_json := nullif(
    v_candidate.prompt_payload #>> '{first_observation_attestation,canonical_json}',
    ''
  );
  v_attestation_sha256 := nullif(
    btrim(v_candidate.prompt_payload #>> '{first_observation_attestation,sha256}'),
    ''
  );
  if v_exact_after is null
    or v_candidate.ai_result ->> 'exact_before' is not null
    or v_candidate.deterministic_diff ->> 'exact_before' is not null
    or v_candidate.deterministic_diff ->> 'exact_after' is distinct from v_exact_after
    or not coalesce(
      v_candidate.deterministic_diff -> 'added_text' @> jsonb_build_array(v_exact_after),
      false
    )
    or v_candidate.prompt_payload #>> '{first_observation_attestation,body,applicant_evidence_quote}'
      is distinct from v_exact_after
    or v_candidate.prompt_payload #>> '{first_observation_attestation,body,acquisition,id}'
      is distinct from p_acquisition_id::text
    or v_candidate.prompt_payload #>> '{first_observation_attestation,body,source,id}'
      is distinct from v_candidate.shared_award_source_id::text
    or v_candidate.prompt_payload #>> '{first_observation_attestation,body,source,shared_award_id}'
      is distinct from v_candidate.shared_award_id::text
    or v_candidate.prompt_payload #>> '{first_observation_attestation,body,capture,file_sha256}'
      is distinct from v_candidate.new_file_hash
    or v_candidate.prompt_payload #>> '{first_observation_attestation,body,sealed_review,capture_file_sha256}'
      is distinct from v_candidate.new_file_hash
    or v_candidate.prompt_payload #>> '{hashes,first_observation_attestation_sha256}'
      is distinct from v_attestation_sha256
    or v_candidate.previous_file_hash is distinct from v_attestation_sha256
    or v_attestation_sha256 !~ '^[0-9a-f]{64}$'
    or v_attestation_json is null
    or public.awardping_sha256_text(v_attestation_json) is distinct from v_attestation_sha256
    or v_attestation_json::jsonb is distinct from
      v_candidate.prompt_payload #> '{first_observation_attestation,body}'
    or not coalesce(
      v_acquisition.review_seal -> 'evidence_quotes' @> jsonb_build_array(v_exact_after),
      false
    ) then
    raise exception using
      errcode = '23514',
      message = 'Rejected-candidate recovery evidence no longer matches its immutable attestation and sealed review.';
  end if;

  select registry.* into strict v_quarantine
  from public.manual_quarantine_registry registry
  where registry.quarantine_key = 'initial-document:' || p_acquisition_id::text
  for update;

  if v_quarantine.category <> 'initial_document'
    or v_quarantine.status <> 'quarantined'
    or v_quarantine.reason_code <> 'missing_deterministic_applicant_fact_signal'
    or v_quarantine.evidence_hash is distinct from p_expected_quarantine_evidence_hash
    or v_quarantine.evidence_hash is distinct from
      public.manual_quarantine_evidence_hash(v_quarantine.evidence)
    or v_quarantine.shared_award_id is distinct from v_candidate.shared_award_id
    or v_quarantine.shared_award_source_id is distinct from v_candidate.shared_award_source_id
    or v_quarantine.primary_source_record_id is distinct from p_acquisition_id
    or v_quarantine.evidence #>> '{failure,reason_code}'
      is distinct from 'missing_deterministic_applicant_fact_signal'
    or v_quarantine.evidence #>> '{failure,details,failure_stage}'
      is distinct from 'current_policy_validation'
    or v_quarantine.evidence #>> '{failure,details,candidate,id}'
      is distinct from p_candidate_id::text
    or v_quarantine.evidence #>> '{failure,details,candidate,signature}'
      is distinct from p_expected_candidate_signature
    or v_quarantine.evidence #>> '{failure,details,candidate,new_file_hash}'
      is distinct from v_candidate.new_file_hash then
    raise exception using
      errcode = '23514',
      message = 'Rejected-candidate recovery quarantine evidence changed or is not the exact known failure.';
  end if;

  if exists (
    select 1
    from public.manual_quarantine_operator_assignments assignment
    where assignment.quarantine_id = v_quarantine.id
  ) then
    raise exception using
      errcode = '23514',
      message = 'An assigned initial-document quarantine cannot be recovered automatically.';
  end if;

  update public.shared_award_visual_review_candidates candidate
  set
    status = 'succeeded',
    rejection_reason = null,
    worker_metadata = candidate.worker_metadata || jsonb_build_object(
      'initial_document_zero_charge_recovery', jsonb_build_object(
        'recovered_at', v_now,
        'from_status', 'rejected',
        'from_reason', 'missing_deterministic_applicant_fact_signal',
        'candidate_signature', p_expected_candidate_signature,
        'candidate_evidence_signature', p_expected_candidate_evidence_signature,
        'quarantine_id', v_quarantine.id,
        'quarantine_evidence_hash', p_expected_quarantine_evidence_hash,
        'policy_guard', p_policy_guard,
        'creates_api_charge', false,
        'submits_ai', false,
        'quarantine_resolves_only_after_publication', true
      ),
      'rejection_disposition', 'actionable_initial_document_quarantine_recovery_pending',
      'creates_api_charge', false
    ),
    updated_at = v_now
  where candidate.id = v_candidate.id
    and candidate.status = 'rejected'
    and candidate.rejection_reason = 'missing_deterministic_applicant_fact_signal'
    and candidate.candidate_signature = p_expected_candidate_signature
    and candidate.worker_metadata ->> 'evidence_signature' =
      p_expected_candidate_evidence_signature
  returning candidate.id into v_recovered_id;

  if v_recovered_id is null then
    raise exception using
      errcode = '40001',
      message = 'Rejected first-document candidate changed during zero-charge recovery.';
  end if;

  candidate_id := v_recovered_id;
  recovered := true;
  return next;
exception
  when no_data_found then
    raise exception using
      errcode = '23503',
      message = 'Rejected-candidate recovery references missing durable candidate, acquisition, source, or quarantine provenance.';
end;
$$;

revoke all on function public.recover_rejected_initial_official_document_candidate(
  uuid, uuid, text, text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.recover_rejected_initial_official_document_candidate(
  uuid, uuid, text, text, text, jsonb
) to service_role;

comment on function public.recover_rejected_initial_official_document_candidate(
  uuid, uuid, text, text, text, jsonb
) is
  'CAS-bound, zero-charge recovery for initial-document candidates rejected solely by the corrected generic applicant-signal guard; immutable quarantine remains open until publication.';
