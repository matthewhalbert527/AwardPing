-- Hosted migration ledger version: 20260810203715.
-- Initial official-document publications deliberately retain an immutable
-- first-observation attestation on the previous side and the real PDF on the
-- current side.  They are valid PDF evidence, but only when the complete
-- candidate, acquisition, event, localization, hash, and R2 role graph remains
-- exact.  Ordinary PDF evidence keeps its existing candidate-bound
-- not_applicable_pdf contract; every other PDF shape remains release-blocking.

create or replace function private.stage1_initial_document_pdf_evidence_valid(
  p_event public.shared_award_change_events,
  p_evidence public.shared_award_change_event_visual_evidence
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_candidate public.shared_award_visual_review_candidates%rowtype;
  v_acquisition public.shared_award_source_acquisitions%rowtype;
  v_attestation_json text;
  v_attestation_sha256 text;
  v_current_sha256 text;
  v_exact_after text;
  v_first_observed_at timestamptz;
begin
  if p_event.id is null
    or p_evidence.change_event_id is distinct from p_event.id
    or p_event.suppressed_at is not null
    or p_event.source_page_type is distinct from 'pdf'
    or p_event.previous_snapshot_id is not null
    or p_event.new_snapshot_id is not null
    or p_event.visual_review_candidate_id is null
    or p_evidence.id is null
    or p_evidence.shared_award_id is distinct from p_event.shared_award_id
    or p_evidence.shared_award_source_id is distinct from
      p_event.shared_award_source_id
    or p_evidence.visual_review_candidate_id is distinct from
      p_event.visual_review_candidate_id
    or p_evidence.evidence_status is distinct from
      'not_applicable_new_document'
    or p_evidence.evidence_schema_version not in (
      'visual-event-evidence-v1',
      'visual-event-evidence-v2'
    )
    or p_evidence.verified_at is not null
    or p_evidence.backfilled_at is not null
    or p_evidence.bucket is distinct from (
      private.stage1_release_production_target_snapshot() ->> 'r2_bucket'
    ) then
    return false;
  end if;

  select candidate.* into v_candidate
  from public.shared_award_visual_review_candidates candidate
  where candidate.id = p_event.visual_review_candidate_id;
  if not found then return false; end if;

  select acquisition.* into v_acquisition
  from public.shared_award_source_acquisitions acquisition
  where acquisition.id = v_candidate.source_acquisition_id;
  if not found then return false; end if;

  v_exact_after := nullif(pg_catalog.btrim(
    p_event.change_details ->> 'exact_after'
  ), '');
  v_attestation_json := nullif(
    v_candidate.prompt_payload #>>
      '{first_observation_attestation,canonical_json}',
    ''
  );
  v_attestation_sha256 := nullif(pg_catalog.btrim(
    p_evidence.previous_capture #>> '{metadata,sha256}'
  ), '');
  v_current_sha256 := nullif(pg_catalog.btrim(
    p_evidence.current_capture #>> '{full,sha256}'
  ), '');
  v_first_observed_at := private.stage1_safe_timestamptz(
    p_event.change_details ->> 'first_observed_at'
  );

  if v_candidate.candidate_scope is distinct from 'initial_official_document'
    or v_candidate.status is distinct from 'published'
    or v_candidate.source_acquisition_id is null
    or v_candidate.shared_award_id is distinct from p_event.shared_award_id
    or v_candidate.shared_award_source_id is distinct from
      p_event.shared_award_source_id
    or v_candidate.candidate_signature is distinct from
      p_evidence.candidate_signature
    or v_candidate.source_url is distinct from p_event.source_url
    or v_candidate.source_title is distinct from p_event.source_title
    or v_candidate.source_page_type is distinct from 'pdf'
    or v_candidate.previous_file_hash is distinct from p_event.previous_hash
    or v_candidate.new_file_hash is distinct from p_event.new_hash
    or coalesce(p_event.previous_hash, '') !~ '^[0-9a-f]{64}$'
    or coalesce(p_event.new_hash, '') !~ '^[0-9a-f]{64}$'
    or p_event.detected_at is distinct from v_candidate.created_at
    or v_candidate.model is not null
    or v_candidate.gemini_batch_name is not null
    or v_candidate.gemini_batch_request_key is not null
    or v_candidate.estimated_cost_usd is not null
    or coalesce(v_candidate.actual_usage, '{}'::jsonb) <> '{}'::jsonb
    or v_candidate.ai_result #>> '{review_execution,creates_api_charge}'
      is distinct from 'false'
    or v_candidate.ai_result #>> '{review_execution,api_review_required}'
      is distinct from 'false'
    or v_candidate.ai_result ->> 'candidate_scope'
      is distinct from 'initial_official_document'
    or v_candidate.ai_result ->> 'observation_kind'
      is distinct from 'first_observation'
    or v_candidate.deterministic_diff ->> 'candidate_scope'
      is distinct from 'initial_official_document'
    or v_candidate.deterministic_diff -> 'first_observation'
      is distinct from 'true'::jsonb
    or v_candidate.deterministic_diff -> 'candidate_change'
      is distinct from 'true'::jsonb
    or v_candidate.deterministic_diff ->> 'reviewed_capture_file_sha256'
      is distinct from v_candidate.new_file_hash then
    return false;
  end if;

  if pg_catalog.jsonb_typeof(p_event.change_details) is distinct from 'object'
    or v_exact_after is null
    or p_event.change_details ->> 'event_kind'
      is distinct from 'new_official_document'
    or p_event.change_details ->> 'change_type'
      is distinct from 'new_official_document'
    or p_event.change_details ->> 'candidate_scope'
      is distinct from 'initial_official_document'
    or p_event.change_details ->> 'observation_kind'
      is distinct from 'first_observation'
    or p_event.change_details -> 'first_observation'
      is distinct from 'true'::jsonb
    or p_event.change_details -> 'exact_before' is distinct from 'null'::jsonb
    or p_event.change_details ->> 'candidate_signature'
      is distinct from v_candidate.candidate_signature
    or p_event.change_details ->> 'source_acquisition_id'
      is distinct from v_candidate.source_acquisition_id::text
    or p_event.change_details #>> '{source,source_url}'
      is distinct from p_event.source_url
    or p_event.change_details #>> '{source,source_title}'
      is distinct from p_event.source_title
    or p_event.change_details #>> '{source,page_type}' is distinct from 'pdf'
    or v_exact_after is distinct from
      v_candidate.ai_result ->> 'exact_after'
    or v_exact_after is distinct from
      v_candidate.deterministic_diff ->> 'exact_after'
    or pg_catalog.jsonb_typeof(
      p_event.change_details #> '{structured_diff,added_text}'
    ) is distinct from 'array'
    or not (
      p_event.change_details #> '{structured_diff,added_text}'
        @> pg_catalog.jsonb_build_array(v_exact_after)
    )
    or coalesce(
      p_event.change_details #> '{structured_diff,removed_text}',
      'null'::jsonb
    ) is distinct from '[]'::jsonb
    or private.stage1_safe_timestamptz(
      p_event.change_details ->> 'recognized_at'
    ) is distinct from v_candidate.created_at
    or private.stage1_safe_timestamptz(
      p_event.change_details ->> 'generated_at'
    ) is distinct from v_candidate.created_at then
    return false;
  end if;

  if v_acquisition.shared_award_source_id is distinct from
      p_event.shared_award_source_id
    or v_acquisition.notification_mode is distinct from
      'first_capture_candidate'
    or v_acquisition.onboarding_batch_id is not null
    or v_acquisition.review_seal -> 'sealed' is distinct from 'true'::jsonb
    or v_acquisition.review_seal ->> 'status' is distinct from 'accepted'
    or v_acquisition.review_seal ->> 'page_type' is distinct from 'pdf'
    or v_acquisition.review_seal ->> 'capture_file_hash'
      is distinct from v_candidate.new_file_hash
    or v_acquisition.review_seal ->> 'capture_final_url'
      is distinct from p_event.source_url
    or pg_catalog.jsonb_typeof(
      v_acquisition.review_seal -> 'evidence_quotes'
    ) is distinct from 'array'
    or not (
      v_acquisition.review_seal -> 'evidence_quotes'
        @> pg_catalog.jsonb_build_array(v_exact_after)
    ) then
    return false;
  end if;

  if v_attestation_json is null
    or coalesce(v_attestation_sha256, '') !~ '^[0-9a-f]{64}$'
    or pg_catalog.jsonb_typeof(
      v_candidate.prompt_payload #> '{first_observation_attestation,body}'
    ) is distinct from 'object'
    or v_attestation_json::jsonb is distinct from
      v_candidate.prompt_payload #> '{first_observation_attestation,body}'
    or public.awardping_sha256_text(v_attestation_json)
      is distinct from v_attestation_sha256
    or v_candidate.prompt_payload #>>
      '{first_observation_attestation,sha256}'
      is distinct from v_attestation_sha256
    or v_candidate.prompt_payload #>>
      '{hashes,first_observation_attestation_sha256}'
      is distinct from v_attestation_sha256
    or v_candidate.prompt_payload #>>
      '{first_observation_attestation,body,source,id}'
      is distinct from p_event.shared_award_source_id::text
    or v_candidate.prompt_payload #>>
      '{first_observation_attestation,body,source,shared_award_id}'
      is distinct from p_event.shared_award_id::text
    or v_candidate.prompt_payload #>>
      '{first_observation_attestation,body,source,url}'
      is distinct from p_event.source_url
    or v_candidate.prompt_payload #>>
      '{first_observation_attestation,body,acquisition,id}'
      is distinct from v_candidate.source_acquisition_id::text
    or v_candidate.prompt_payload #>>
      '{first_observation_attestation,body,capture,final_url}'
      is distinct from p_event.source_url
    or v_candidate.prompt_payload #>>
      '{first_observation_attestation,body,sealed_review,capture_final_url}'
      is distinct from p_event.source_url
    or v_candidate.prompt_payload #>>
      '{first_observation_attestation,body,capture,file_sha256}'
      is distinct from v_candidate.new_file_hash
    or v_candidate.prompt_payload #>>
      '{first_observation_attestation,body,sealed_review,capture_file_sha256}'
      is distinct from v_candidate.new_file_hash
    or v_candidate.prompt_payload #>>
      '{first_observation_attestation,body,applicant_evidence_quote}'
      is distinct from v_exact_after
    or v_candidate.prompt_payload #>> '{source,id}'
      is distinct from p_event.shared_award_source_id::text
    or v_candidate.prompt_payload #>> '{source,shared_award_id}'
      is distinct from p_event.shared_award_id::text
    or v_candidate.prompt_payload #>> '{source,acquisition_id}'
      is distinct from v_candidate.source_acquisition_id::text
    or v_candidate.prompt_payload #>> '{source,url}'
      is distinct from p_event.source_url
    or v_candidate.prompt_payload #>> '{source,page_type}' is distinct from 'pdf'
    or v_candidate.prompt_payload #>> '{hashes,new_file_hash}'
      is distinct from v_candidate.new_file_hash
    or v_candidate.prompt_payload #>> '{hashes,previous_file_hash}'
      is distinct from v_attestation_sha256 then
    return false;
  end if;

  if private.stage1_published_capture_reference_graph_valid(
      p_evidence.previous_capture
    ) is not true
    or p_evidence.previous_capture ->> 'kind'
      is distinct from 'first_observation_attestation'
    or p_evidence.previous_capture ->> 'state_id'
      is distinct from 'first-observation'
    or pg_catalog.jsonb_typeof(p_evidence.previous_capture -> 'full')
      is distinct from 'null'
    or pg_catalog.jsonb_typeof(p_evidence.previous_capture -> 'metadata')
      is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_evidence.previous_capture -> 'attestation')
      is distinct from 'object'
    or p_evidence.previous_capture #>> '{metadata,object_key}'
      is distinct from (
        'visual-snapshots/published/' ||
        p_event.visual_review_candidate_id::text ||
        '/previous/first-observation-attestation/' ||
        v_attestation_sha256 || '.json'
      )
    or p_evidence.previous_capture #>> '{metadata,content_type}'
      is distinct from 'application/json; charset=utf-8'
    or coalesce(
      p_evidence.previous_capture #>> '{metadata,byte_length}', ''
    ) !~ '^[1-9][0-9]*$'
    or p_evidence.previous_capture #>> '{capture_hashes,file_hash}'
      is distinct from v_attestation_sha256
    or p_evidence.previous_capture #>> '{capture_hashes,attestation_hash}'
      is distinct from v_attestation_sha256
    or p_evidence.previous_capture #>>
      '{capture_hashes,attestation_sha256}'
      is distinct from v_attestation_sha256
    or p_evidence.previous_capture #>> '{attestation,schema_version}'
      is distinct from 'awardping.first_observation.v1'
    or p_evidence.previous_capture #>> '{attestation,prior_evidence_state}'
      is distinct from 'no_prior_baseline_supplied'
    or p_evidence.previous_capture #>> '{attestation,binding,candidate_id}'
      is distinct from p_event.visual_review_candidate_id::text
    or p_evidence.previous_capture #>>
      '{attestation,binding,candidate_signature}'
      is distinct from v_candidate.candidate_signature
    or p_evidence.previous_capture #>>
      '{attestation,binding,source_acquisition_id}'
      is distinct from v_candidate.source_acquisition_id::text
    or p_evidence.previous_capture #>>
      '{attestation,binding,first_observation_attestation_sha256}'
      is distinct from v_attestation_sha256
    or p_evidence.previous_capture #>>
      '{attestation,binding,current_file_sha256}'
      is distinct from v_candidate.new_file_hash
    or private.stage1_safe_timestamptz(
      p_evidence.previous_capture ->> 'captured_at'
    ) is distinct from v_first_observed_at
    or private.stage1_safe_timestamptz(
      v_candidate.prompt_payload #>>
        '{first_observation_attestation,body,capture,captured_at}'
    ) is distinct from v_first_observed_at
    or p_event.previous_hash is distinct from v_attestation_sha256 then
    return false;
  end if;

  if private.stage1_published_capture_reference_graph_valid(
      p_evidence.current_capture
    ) is not true
    or coalesce(v_current_sha256, '') !~ '^[0-9a-f]{64}$'
    or p_evidence.current_capture ->> 'kind' is distinct from 'pdf'
    or p_evidence.current_capture ->> 'state_id' is distinct from 'document'
    or pg_catalog.jsonb_typeof(p_evidence.current_capture -> 'full')
      is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_evidence.current_capture -> 'metadata')
      is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_evidence.current_capture -> 'text')
      is distinct from 'object'
    or p_evidence.current_capture #>> '{full,object_key}'
      is distinct from (
        'visual-snapshots/published/' ||
        p_event.visual_review_candidate_id::text ||
        '/current/document/' || v_current_sha256 || '.pdf'
      )
    or p_evidence.current_capture #>> '{full,content_type}'
      is distinct from 'application/pdf'
    or coalesce(
      p_evidence.current_capture #>> '{full,byte_length}', ''
    ) !~ '^[1-9][0-9]*$'
    or p_evidence.current_capture #>> '{metadata,object_key}'
      is distinct from (
        'visual-snapshots/published/' ||
        p_event.visual_review_candidate_id::text ||
        '/current/metadata/' ||
        (p_evidence.current_capture #>> '{metadata,sha256}') || '.json'
      )
    or coalesce(
      p_evidence.current_capture #>> '{metadata,sha256}', ''
    ) !~ '^[0-9a-f]{64}$'
    or p_evidence.current_capture #>> '{metadata,content_type}'
      is distinct from 'application/json; charset=utf-8'
    or coalesce(
      p_evidence.current_capture #>> '{metadata,byte_length}', ''
    ) !~ '^[1-9][0-9]*$'
    or p_evidence.current_capture #>> '{text,object_key}'
      is distinct from (
        'visual-snapshots/published/' ||
        p_event.visual_review_candidate_id::text ||
        '/current/text/' ||
        (p_evidence.current_capture #>> '{text,sha256}') || '.txt'
      )
    or coalesce(
      p_evidence.current_capture #>> '{text,sha256}', ''
    ) !~ '^[0-9a-f]{64}$'
    or p_evidence.current_capture #>> '{text,content_type}'
      is distinct from 'text/plain; charset=utf-8'
    or coalesce(
      p_evidence.current_capture #>> '{text,byte_length}', ''
    ) !~ '^[1-9][0-9]*$'
    or p_evidence.current_capture #>> '{capture_hashes,file_hash}'
      is distinct from v_current_sha256
    or p_evidence.current_capture #>> '{capture_hashes,image_hash}'
      is distinct from v_current_sha256
    or private.stage1_safe_timestamptz(
      p_evidence.current_capture ->> 'captured_at'
    ) is distinct from v_first_observed_at
    or v_candidate.new_file_hash is distinct from v_current_sha256
    or p_event.new_hash is distinct from v_current_sha256 then
    return false;
  end if;

  if pg_catalog.jsonb_typeof(p_evidence.localization) is distinct from 'object'
    or p_evidence.localization ->> 'direction' is distinct from 'added'
    or p_evidence.localization #>> '{sides,previous,status}'
      is distinct from 'not_applicable_first_observation'
    or p_evidence.localization #> '{sides,previous,required}'
      is distinct from 'false'::jsonb
    or p_evidence.localization #> '{sides,previous,exact_overlap}'
      is distinct from 'false'::jsonb
    or p_evidence.localization #> '{sides,previous,matched_rects}'
      is distinct from '[]'::jsonb
    or p_evidence.localization #>> '{sides,current,status}'
      is distinct from 'not_applicable_pdf'
    or p_evidence.localization #> '{sides,current,required}'
      is distinct from 'false'::jsonb
    or p_evidence.localization #> '{sides,current,exact_overlap}'
      is distinct from 'false'::jsonb
    or p_evidence.localization #> '{sides,current,matched_rects}'
      is distinct from '[]'::jsonb then
    return false;
  end if;

  return true;
exception when others then
  return false;
end;
$$;

revoke all on function private.stage1_initial_document_pdf_evidence_valid(
  public.shared_award_change_events,
  public.shared_award_change_event_visual_evidence
) from public, anon, authenticated, service_role;

-- Preserve the existing HTML crop calculation and v4 canonical R2 graph, then
-- replace only the PDF failure calculation with a deterministic per-event
-- contract.  The new coverage hash signs the prior complete event payload plus
-- the exact PDF classifications and their validation results.
create or replace function private.stage1_visual_crop_coverage_snapshot()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with coverage as (
    select private.stage1_crop_coverage_pre_r2_graph_20260810184524() as value
  ), objects as (
    select private.stage1_visual_r2_object_set_snapshot() as value
  ), pdf_events as (
    select
      event.id,
      event.visual_review_candidate_id,
      evidence.id as evidence_id,
      evidence.visual_review_candidate_id as evidence_candidate_id,
      evidence.evidence_status,
      evidence.evidence_schema_version,
      evidence.previous_capture,
      evidence.current_capture,
      evidence.localization,
      case
        when evidence.evidence_status = 'not_applicable_pdf' then
          evidence.id is not null
          and event.visual_review_candidate_id is not null
          and evidence.visual_review_candidate_id =
            event.visual_review_candidate_id
        when evidence.evidence_status = 'not_applicable_new_document' then
          private.stage1_initial_document_pdf_evidence_valid(event, evidence)
        else false
      end as pdf_evidence_valid,
      case
        when evidence.evidence_status = 'not_applicable_pdf'
          then 'candidate_bound_not_applicable_pdf'
        when evidence.evidence_status = 'not_applicable_new_document'
          then 'exact_initial_official_document'
        else 'invalid_pdf_evidence'
      end as pdf_evidence_kind
    from public.shared_award_change_events event
    left join public.shared_award_change_event_visual_evidence evidence
      on evidence.change_event_id = event.id
    where event.suppressed_at is null
      and event.source_page_type = 'pdf'
      and exists (
        select 1
        from public.stage1_award_members member
        where member.shared_award_id = event.shared_award_id
      )
  ), pdf_payload as (
    select coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'event_id', pdf.id,
          'candidate_id', pdf.visual_review_candidate_id,
          'evidence_id', pdf.evidence_id,
          'evidence_candidate_id', pdf.evidence_candidate_id,
          'status', pdf.evidence_status,
          'schema', pdf.evidence_schema_version,
          'pdf_evidence_kind', pdf.pdf_evidence_kind,
          'pdf_evidence_valid', pdf.pdf_evidence_valid,
          'previous_kind', pdf.previous_capture ->> 'kind',
          'previous_state_id', pdf.previous_capture ->> 'state_id',
          'previous_sha256', pdf.previous_capture #>> '{metadata,sha256}',
          'current_kind', pdf.current_capture ->> 'kind',
          'current_state_id', pdf.current_capture ->> 'state_id',
          'current_sha256', pdf.current_capture #>> '{full,sha256}',
          'direction', pdf.localization ->> 'direction',
          'previous_localization_status',
            pdf.localization #>> '{sides,previous,status}',
          'current_localization_status',
            pdf.localization #>> '{sides,current,status}'
        ) order by pdf.id
      ),
      '[]'::jsonb
    ) as value
    from pdf_events pdf
  ), pdf_counts as (
    select
      pg_catalog.count(*) as pdf_event_count,
      pg_catalog.count(*) filter (where pdf_evidence_valid)
        as verified_pdf_events,
      pg_catalog.count(*) filter (where not pdf_evidence_valid)
        as pdf_evidence_failures,
      pg_catalog.count(*) filter (
        where evidence_status = 'not_applicable_new_document'
      ) as initial_document_pdf_events,
      pg_catalog.count(*) filter (
        where evidence_status = 'not_applicable_new_document'
          and pdf_evidence_valid
      ) as verified_initial_document_pdf_events,
      pg_catalog.count(*) filter (
        where evidence_status = 'not_applicable_new_document'
          and not pdf_evidence_valid
      ) as initial_document_pdf_failures
    from pdf_events
  )
  select coverage.value || pg_catalog.jsonb_build_object(
    'reference_schema', 'awardping.r2.canonical-object-references.v1',
    'visual_object_count', objects.value -> 'visual_object_count',
    'visual_reference_count', objects.value -> 'visual_reference_count',
    'published_event_object_count',
      objects.value -> 'published_event_object_count',
    'published_event_reference_count',
      objects.value -> 'published_event_reference_count',
    'manifest_source_object_count',
      objects.value -> 'manifest_source_object_count',
    'manifest_source_reference_count',
      objects.value -> 'manifest_source_reference_count',
    'alias_reference_count', objects.value -> 'alias_reference_count',
    'aliased_object_count', objects.value -> 'aliased_object_count',
    'reference_set_hash', objects.value -> 'reference_set_hash',
    'visual_object_set_hash', objects.value -> 'visual_object_set_hash',
    'pdf_evidence_contract',
      'awardping.stage1.pdf-evidence-coverage.v1',
    'pdf_event_count', pdf_counts.pdf_event_count,
    'verified_pdf_events', pdf_counts.verified_pdf_events,
    'pdf_evidence_failures', pdf_counts.pdf_evidence_failures,
    'initial_document_pdf_events', pdf_counts.initial_document_pdf_events,
    'verified_initial_document_pdf_events',
      pdf_counts.verified_initial_document_pdf_events,
    'initial_document_pdf_failures',
      pdf_counts.initial_document_pdf_failures,
    'coverage_set_hash', public.stage1_publication_evidence_hash(
      pg_catalog.jsonb_build_object(
        'prior_coverage_set_hash', coverage.value ->> 'coverage_set_hash',
        'pdf_evidence_contract',
          'awardping.stage1.pdf-evidence-coverage.v1',
        'pdf_events', pdf_payload.value
      )
    )
  )
  from coverage
  cross join objects
  cross join pdf_payload
  cross join pdf_counts;
$$;

revoke all on function private.stage1_visual_crop_coverage_snapshot()
  from public, anon, authenticated, service_role;

create or replace function private.stage1_visual_crop_derivation_contract_hash()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select public.stage1_publication_evidence_hash(
    pg_catalog.jsonb_build_object(
      'contract', 'awardping.stage1.visual-crop-db-derivation.v4',
      'event_scope', 'unsuppressed_stage1_change_events',
      'html_requirement', 'visual-event-evidence-v2-exact-text-overlap',
      'pdf_requirement',
        'candidate-bound-not-applicable-pdf-or-exact-initial-document-v1',
      'object_requirement',
        'current-signed-r2-canonical-object-reference-graph-v4'
    )
  );
$$;

revoke all on function private.stage1_visual_crop_derivation_contract_hash()
  from public, anon, authenticated, service_role;

-- Artifacts are immutable, so do not update or delete historical evidence.
-- Requiring the current derivation hash and PDF contract makes every prior crop
-- artifact ineligible immediately.  Existing READY acceptance records also
-- recompute the gate at activation and therefore cannot replay the old proof.
create or replace function private.stage1_release_artifact_evidence_valid(
  p_artifact_kind text,
  p_evidence jsonb
)
returns boolean
language sql
stable
set search_path = ''
as $$
  select private.stage1_release_artifact_valid_pre_r2_graph_20260810184524(
    p_artifact_kind, p_evidence
  )
  and case p_artifact_kind
    when 'r2_recovery_drill' then
      private.stage1_r2_recovery_evidence_matches_snapshot(
        p_evidence,
        pg_catalog.jsonb_build_object(
          'visual_object_count', p_evidence -> 'visual_objects_checked',
          'visual_reference_count', p_evidence -> 'visual_references_checked',
          'published_event_object_count',
            p_evidence -> 'published_event_objects_checked',
          'published_event_reference_count',
            p_evidence -> 'published_event_references_checked',
          'manifest_source_object_count',
            p_evidence -> 'manifest_source_objects_checked',
          'manifest_source_reference_count',
            p_evidence -> 'manifest_source_references_checked',
          'alias_reference_count', p_evidence -> 'alias_references_checked',
          'aliased_object_count', p_evidence -> 'aliased_objects_checked',
          'visual_object_set_hash', p_evidence -> 'visual_object_set_hash',
          'reference_set_hash', p_evidence -> 'reference_set_hash',
          'unexpected_bucket_count', 0,
          'malformed_object_count', 0,
          'manifest_binding_error_count', 0,
          'duplicate_object_key_count', 0,
          'reference_binding_error_count', 0,
          'inconsistent_alias_count', 0,
          'unclassified_reference_count', 0
        )
      )
    when 'visual_crop_coverage' then
      p_evidence ->> 'reference_schema' =
        'awardping.r2.canonical-object-references.v1'
      and p_evidence ->> 'pdf_evidence_contract' =
        'awardping.stage1.pdf-evidence-coverage.v1'
      and p_evidence ->> 'derivation_contract_hash' =
        private.stage1_visual_crop_derivation_contract_hash()
      and p_evidence ->> 'pdf_event_count' ~ '^[0-9]+$'
      and p_evidence ->> 'verified_pdf_events' ~ '^[0-9]+$'
      and p_evidence ->> 'initial_document_pdf_events' ~ '^[0-9]+$'
      and p_evidence ->> 'verified_initial_document_pdf_events'
        ~ '^[0-9]+$'
      and p_evidence ->> 'initial_document_pdf_failures' ~ '^[0-9]+$'
      and p_evidence ->> 'visual_object_count' ~ '^[0-9]+$'
      and p_evidence ->> 'visual_reference_count' ~ '^[0-9]+$'
      and p_evidence ->> 'published_event_object_count' ~ '^[0-9]+$'
      and p_evidence ->> 'published_event_reference_count' ~ '^[0-9]+$'
      and p_evidence ->> 'manifest_source_object_count' ~ '^[0-9]+$'
      and p_evidence ->> 'manifest_source_reference_count' ~ '^[0-9]+$'
      and p_evidence ->> 'alias_reference_count' ~ '^[0-9]+$'
      and p_evidence ->> 'aliased_object_count' ~ '^[0-9]+$'
      and p_evidence ->> 'reference_set_hash' ~ '^[0-9a-f]{64}$'
      and p_evidence ->> 'visual_object_set_hash' ~ '^[0-9a-f]{64}$'
    else true
  end;
$$;

revoke all on function private.stage1_release_artifact_evidence_valid(
  text, jsonb
) from public, anon, authenticated, service_role;
