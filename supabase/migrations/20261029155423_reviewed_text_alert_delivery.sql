-- PRIVATE PROPOSAL ONLY. Put in a CLI-created reviewed migration before use.
-- Alert-source authority is independent of exhaustive fact/variation approvals.
-- This grants neither facts nor source-card publication and changes no tables.
create function public.get_program_text_public_alert_source_bindings(p_epoch uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_active_epoch uuid; v_input_count integer; v_bindings jsonb;
begin
 if p_epoch is null or p_epoch='00000000-0000-0000-0000-000000000000'::uuid then
  raise exception 'A current text monitoring epoch is required.' using errcode='23514';
 end if;
 select epoch into strict v_active_epoch from public.program_text_source_authority_epochs where active;
 if p_epoch is distinct from v_active_epoch then
  raise exception 'Text source authority epoch changed.' using errcode='40001';
 end if;

 -- Bound actual current text observations before invoking source authority.
 -- The existing helper already covers common, registered and active scoped
 -- sources, URL ownership, current approvals and finite canonical fences.
 select count(*)::integer into v_input_count from (
  select source.id from public.shared_award_sources source
  join public.stage1_award_members member on member.shared_award_id=source.shared_award_id
  where source.text_monitoring_state->>'schema'='awardping.program-text-state.v1'
   and source.text_monitoring_state->>'epoch'=p_epoch::text
   and source.admin_review_status in ('open','review_later')
  limit 50001
 ) bounded;
 if v_input_count>50000 then
  raise exception 'Public alert source scope exceeds its bounded limit.' using errcode='23514';
 end if;
 with eligible as (
  select member.cohort_key,source.id as source_id,source.shared_award_id,source.url
  from public.shared_award_sources source
  join public.stage1_award_members member on member.shared_award_id=source.shared_award_id
  join public.stage1_award_registry registry on registry.cohort_key=member.cohort_key
  join public.stage1_award_members canonical_member on canonical_member.cohort_key=registry.cohort_key
   and canonical_member.shared_award_id=registry.canonical_shared_award_id and canonical_member.member_kind='canonical'
  join public.shared_awards owner on owner.id=source.shared_award_id and owner.status='active'
  join public.shared_awards canonical on canonical.id=registry.canonical_shared_award_id and canonical.status='active'
  where source.text_monitoring_state->>'schema'='awardping.program-text-state.v1'
   and source.text_monitoring_state->>'epoch'=p_epoch::text
   and source.admin_review_status in ('open','review_later')
   and private.awardping_program_source_allowed(source.id)
 )
 select coalesce(jsonb_agg(jsonb_build_object('cohort_key',cohort_key,'source_id',source_id,
  'shared_award_id',shared_award_id,'url',url,'epoch',p_epoch)
  order by cohort_key collate "C",source_id),'[]'::jsonb) into v_bindings from eligible;
 if jsonb_array_length(v_bindings)>50000 then
  raise exception 'Public alert source output exceeds its bounded limit.' using errcode='23514';
 end if;
 return jsonb_build_object('schema','awardping.program-text-public-alert-sources.v1','epoch',p_epoch,
  'source_count',jsonb_array_length(v_bindings),'bindings',v_bindings);
end;
$$;
revoke all on function public.get_program_text_public_alert_source_bindings(uuid) from public,anon,authenticated;
grant execute on function public.get_program_text_public_alert_source_bindings(uuid) to service_role;

-- PRIVATE PROPOSAL ONLY. Root read the actual definition without changing it.
-- Actual root preimage: actual-digest-guard-preimage.json; exact3706-byte definition.
-- Review the exact two-predicate diff and verify this preimage again before apply.
do $digest_preimage$
declare expected constant text := 'd1781c151d01401899fb5a490afcf72b5a9a7f22912f6b95b503e5bb9a93a437';actual text;
begin
 if expected !~ '^[a-f0-9]{64}$' then
  raise exception 'Read and review the actual digest-function preimage before applying this proposal.' using errcode='40001';
 end if;
 actual:=encode(pg_catalog.sha256(convert_to(pg_get_functiondef('private.public_digest_events_are_current(jsonb)'::regprocedure),'UTF8')),'hex');
 if actual is distinct from expected then raise exception 'Digest-function preimage changed.' using errcode='40001';end if;
end;
$digest_preimage$;

create function private.public_digest_reviewed_text_source_current(p_event_id uuid)
returns boolean language plpgsql stable security definer set search_path='' as $$
declare event public.shared_award_change_events%rowtype;source public.shared_award_sources%rowtype;
 candidate public.shared_award_visual_review_candidates%rowtype;evidence public.shared_award_change_event_visual_evidence%rowtype;
 review public.program_text_alert_reviews%rowtype;active_epoch uuid;cohort text;
begin
 select * into strict event from public.shared_award_change_events where id=p_event_id;
 select * into strict source from public.shared_award_sources where id=event.shared_award_source_id;
 select * into strict candidate from public.shared_award_visual_review_candidates where id=event.visual_review_candidate_id;
 select * into strict evidence from public.shared_award_change_event_visual_evidence where change_event_id=event.id;
 select * into strict review from public.program_text_alert_reviews where id=candidate.id;
 select epoch into strict active_epoch from public.program_text_source_authority_epochs where active;
 select member.cohort_key into strict cohort from public.stage1_award_members member
 join public.stage1_award_registry registry on registry.cohort_key=member.cohort_key
 join public.stage1_award_members canonical_member on canonical_member.cohort_key=registry.cohort_key
  and canonical_member.shared_award_id=registry.canonical_shared_award_id and canonical_member.member_kind='canonical'
 join public.shared_awards owner on owner.id=member.shared_award_id and owner.status='active'
 join public.shared_awards canonical on canonical.id=registry.canonical_shared_award_id and canonical.status='active'
 where member.shared_award_id=source.shared_award_id;
 if source.shared_award_id is distinct from event.shared_award_id or source.url is distinct from event.source_url
  or not coalesce(source.admin_review_status in ('open','review_later'),false)
  or candidate.candidate_scope is distinct from 'program_text_change' or candidate.status is distinct from 'published'
  or candidate.published_at is null or candidate.shared_award_id is distinct from event.shared_award_id
  or candidate.shared_award_source_id is distinct from source.id or candidate.source_url is distinct from source.url
  or candidate.worker_metadata->>'change_event_id' is distinct from event.id::text
  or candidate.worker_metadata->>'admin_alert_review_id' is distinct from candidate.id::text
  or candidate.worker_metadata->>'epoch' is distinct from active_epoch::text
  or source.text_monitoring_state->>'schema' is distinct from 'awardping.program-text-state.v1'
  or source.text_monitoring_state->>'epoch' is distinct from active_epoch::text
  or evidence.evidence_status is distinct from 'verified_text'
  or evidence.evidence_schema_version is distinct from 'program-text-event-evidence-v1'
  or evidence.shared_award_id is distinct from event.shared_award_id
  or evidence.shared_award_source_id is distinct from source.id
  or evidence.visual_review_candidate_id is distinct from candidate.id
  or evidence.candidate_signature is distinct from candidate.candidate_signature
  or evidence.previous_capture is distinct from candidate.previous_snapshot_ref
  or evidence.current_capture is distinct from candidate.new_snapshot_ref
  or review.status is distinct from 'approved' or review.event_id is distinct from event.id
  or review.reviewed_at is null or review.reviewed_by is null
  or review.candidate_signature is distinct from candidate.candidate_signature
  or review.details is distinct from event.change_details or review.localization is distinct from evidence.localization
  or review.content_hash is distinct from private.program_text_alert_hash(candidate,review.details,review.localization)
 then return false;end if;
 if not coalesce(private.awardping_program_source_allowed(source.id),false) then return false;end if;
 -- Reuse current common/registered/scoped authority. Public eligibility does
 -- not claim that every provider role or application variation is complete.
 -- Reuse the complete production validator: exact quote/block/source/epoch and
 -- accepted saved-response bindings stay in force. A claimed visual/text row
 -- without this immutable evidence and approved owner decision cannot pass.
 perform public.awardping_validate_program_text_evidence(to_jsonb(evidence),to_jsonb(candidate),event.change_details);
 return true;
exception when others then return false;
end;
$$;
revoke all on function private.public_digest_reviewed_text_source_current(uuid) from public,anon,authenticated,service_role;

-- The existing digest function follows. ONLY its two source-authority predicates
-- are combined with the narrowly reviewed-text alternative; no recipient,
-- binding, release, suppression, retry, payload or delivery predicate changes.
create or replace function private.public_digest_events_are_current(
  p_event_bindings jsonb
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  with bindings as (
    select binding.value
    from pg_catalog.jsonb_array_elements(p_event_bindings) binding(value)
  ), validated as (
    select change_event.id
    from bindings binding
    join public.shared_award_change_events change_event
      on change_event.id = (binding.value ->> 'eventId')::uuid
    join public.shared_award_sources source
      on source.id = change_event.shared_award_source_id
      and source.shared_award_id = change_event.shared_award_id
    join public.stage1_award_members member
      on member.shared_award_id = change_event.shared_award_id
    join public.stage1_award_registry registry
      on registry.cohort_key = member.cohort_key
    join public.shared_award_change_event_visual_evidence evidence
      on evidence.change_event_id = change_event.id
    where change_event.shared_award_id = (binding.value ->> 'memberAwardId')::uuid
      and registry.canonical_shared_award_id = (binding.value ->> 'awardId')::uuid
      and registry.canonical_name = binding.value ->> 'awardName'
      and change_event.shared_award_source_id = (binding.value ->> 'sourceId')::uuid
      and change_event.source_url = binding.value ->> 'sourceUrl'
      and coalesce(pg_catalog.to_jsonb(change_event.source_title), 'null'::jsonb) =
        coalesce(binding.value -> 'eventSourceTitle', 'null'::jsonb)
      and coalesce(pg_catalog.to_jsonb(change_event.source_page_type), 'null'::jsonb) =
        coalesce(binding.value -> 'eventSourcePageType', 'null'::jsonb)
      and change_event.summary = binding.value ->> 'eventSummary'
      and coalesce(change_event.change_details, 'null'::jsonb) =
        coalesce(binding.value -> 'eventChangeDetails', 'null'::jsonb)
      and source.url = change_event.source_url
      and change_event.detected_at = (binding.value ->> 'detectedAt')::timestamptz
      and change_event.suppressed_at is null
      and nullif(pg_catalog.btrim(change_event.change_details ->> 'suppressed_at'), '') is null
      and nullif(pg_catalog.btrim(change_event.change_details ->> 'suppression_reason'), '') is null
      and change_event.visual_review_candidate_id is not distinct from
        nullif(binding.value ->> 'visualReviewCandidateId', '')::uuid
      and evidence.id = (binding.value ->> 'visualEvidenceId')::uuid
      and evidence.shared_award_id = change_event.shared_award_id
      and evidence.shared_award_source_id is not distinct from change_event.shared_award_source_id
      and evidence.visual_review_candidate_id is not distinct from
        change_event.visual_review_candidate_id
      and evidence.evidence_status = binding.value ->> 'visualEvidenceStatus'
      and evidence.evidence_schema_version = binding.value ->> 'visualEvidenceSchemaVersion'
      and evidence.candidate_signature is not distinct from
        nullif(binding.value ->> 'visualEvidenceCandidateSignature', '')
      and (
        (source.admin_review_status = 'open' and exists (
          select 1
          from public.stage1_award_source_manifest manifest
          where manifest.cohort_key = registry.cohort_key
            and change_event.shared_award_source_id = any(manifest.source_ids)
        ))
        or private.public_digest_reviewed_text_source_current(change_event.id)
      )
  )
  select coalesce(
    pg_catalog.jsonb_typeof(p_event_bindings) = 'array'
    and pg_catalog.jsonb_array_length(p_event_bindings) between 1 and 12
    and (select count(*) from bindings) =
      (select count(distinct binding.value ->> 'eventId') from bindings binding)
    and (select count(*) from validated) = (select count(*) from bindings),
    false
  );
$$;

revoke all on function private.public_digest_events_are_current(jsonb)
  from public, anon, authenticated, service_role;
