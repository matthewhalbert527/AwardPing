-- Explicit recovery of an already-paid saved document-reference response after
-- a corrected local field validator. No candidate IDs are embedded in DDL.
-- Root supplies a separately reviewed finite candidate/preimage/plan. This is
-- not a paid retry, source reset, alert approval or publication operation.
create table public.program_text_document_recovery_journal (
 id uuid primary key default gen_random_uuid(),
 candidate_id uuid not null unique references public.shared_award_visual_review_candidates(id) on delete restrict,
 policy text not null check(policy='awardping.program-text-document-reference-recovery.v1'),
 preimage_hash text not null check(preimage_hash ~ '^[a-f0-9]{64}$'),
 responses_hash text not null check(responses_hash ~ '^[a-f0-9]{64}$'),
 root_plan_hash text not null check(root_plan_hash ~ '^[a-f0-9]{64}$'),
 failed_candidate jsonb not null,source_identity_proof jsonb not null,paid_reservation jsonb not null,paid_events jsonb not null,
 original_responses jsonb not null,actor text not null check(actor='codex_operator:user_authorized_saved_response_recovery'),
 reason text not null check(length(btrim(reason)) between 20 and 2000),recovered_at timestamptz not null default clock_timestamp()
);
alter table public.program_text_document_recovery_journal enable row level security;
revoke all on public.program_text_document_recovery_journal from public,anon,authenticated,service_role;
grant select on public.program_text_document_recovery_journal to service_role;
create function private.awardping_reject_document_recovery_mutation()
returns trigger language plpgsql security invoker set search_path='' as $$begin
 raise exception 'Saved document review recovery history is immutable.' using errcode='42501';
end $$;
revoke all on function private.awardping_reject_document_recovery_mutation() from public,anon,authenticated,service_role;
create trigger program_text_document_recovery_immutable before update or delete on public.program_text_document_recovery_journal
 for each row execute function private.awardping_reject_document_recovery_mutation();
create trigger program_text_document_recovery_no_truncate before truncate on public.program_text_document_recovery_journal
 for each statement execute function private.awardping_reject_document_recovery_mutation();

create function private.awardping_document_recovery_shape(p_candidate jsonb)
returns jsonb language plpgsql immutable security invoker set search_path='' as $$
declare original jsonb:=p_candidate#>'{ai_result,responses}';comparison jsonb:=p_candidate#>'{prompt_payload,comparison}';
 plan jsonb:=p_candidate#>'{prompt_payload,packet_plan}';changed jsonb;block jsonb;quote jsonb;framing jsonb;title text;base_title text;valid_framing boolean:=false;
begin
 if p_candidate->>'candidate_scope' is distinct from 'program_text_change' or p_candidate->>'status' is distinct from 'failed'
  or p_candidate->>'rejection_reason' is distinct from 'manual_review_required:unsupported_program_field_evidence'
  or p_candidate#>'{ai_result,program_text_validation,reasons}' is distinct from '["unsupported_program_field_evidence"]'::jsonb
  or p_candidate#>>'{ai_result,program_text_validation,status}' is distinct from 'held'
  or jsonb_typeof(original) is distinct from 'array' or jsonb_array_length(original)<>1
  or jsonb_typeof(original#>'{0,blocks}') is distinct from 'array' or jsonb_array_length(original#>'{0,blocks}')<>1
  or jsonb_typeof(original#>'{0,blocks,0,changes}') is distinct from 'array' or jsonb_array_length(original#>'{0,blocks,0,changes}')<>1
  or jsonb_typeof(comparison->'changed_blocks') is distinct from 'array' or jsonb_array_length(comparison->'changed_blocks')<>1
  or jsonb_typeof(plan->'packets') is distinct from 'array' or jsonb_array_length(plan->'packets')<>1
  or jsonb_typeof(plan#>'{packets,0,blocks}') is distinct from 'array' or jsonb_array_length(plan#>'{packets,0,blocks}')<>1
  or p_candidate#>>'{worker_metadata,monitoring_contract}' is distinct from 'program-text-v1'
  or p_candidate#>>'{worker_metadata,evidence_signature}' is distinct from p_candidate->>'candidate_signature'
  or comparison->>'comparison_id' is distinct from p_candidate->>'candidate_signature'
  or original#>>'{0,comparison_id}' is distinct from p_candidate->>'candidate_signature'
  or original#>>'{0,epoch}' is distinct from p_candidate#>>'{worker_metadata,epoch}'
  or original#>>'{0,source_id}' is distinct from p_candidate->>'shared_award_source_id'
  or original#>>'{0,award_id}' is distinct from p_candidate->>'shared_award_id'
  or original#>>'{0,packet_id}' is distinct from plan#>>'{packets,0,packet_id}'
  or original#>>'{0,blocks,0,disposition}' is distinct from 'program_change'
  or original#>>'{0,blocks,0,changes,0,field}' is distinct from 'documents'
  or original#>>'{0,blocks,0,changes,0,operation}' is distinct from 'remove'
  or original#>'{0,blocks,0,changes,0,current_quote}' is distinct from 'null'::jsonb
  or original#>'{0,blocks,0,changes,0,applicant_impact}' is distinct from 'true'::jsonb
  or not private.awardping_program_text_reference_valid(p_candidate->'previous_snapshot_ref')
  or not private.awardping_program_text_reference_valid(p_candidate->'new_snapshot_ref')
  or p_candidate->'publication_claim_token' is distinct from 'null'::jsonb
  or p_candidate->'published_at' is distinct from 'null'::jsonb
 then raise exception 'Outside the saved document-reference recovery policy.' using errcode='23514';end if;
 changed:=comparison#>'{changed_blocks,0}';block:=changed->'previous';quote:=original#>'{0,blocks,0,changes,0,previous_quote}';
 if changed->>'id' is distinct from original#>>'{0,blocks,0,id}' or changed is distinct from plan#>'{packets,0,blocks,0}'
  or changed->'current' is distinct from 'null'::jsonb or block->>'kind' is distinct from 'li'
  or not private.awardping_program_exact_object(quote,array['block_id','text'])
  or quote->>'block_id' is distinct from block->>'id' or quote->>'text' is distinct from block->>'text'
  or private.awardping_program_block_valid(block,comparison->>'previous_text') is distinct from true
  or jsonb_typeof(block#>'{context,heading_path}') is distinct from 'array' or jsonb_array_length(block#>'{context,heading_path}')=0
  or length(btrim(coalesce(block->>'heading','')))=0
  or jsonb_typeof(changed->'previous_context') is distinct from 'array'
  or encode(extensions.digest(convert_to(comparison->>'previous_text','UTF8'),'sha256'),'hex') is distinct from p_candidate#>>'{previous_snapshot_ref,text_sha256}'
  or encode(extensions.digest(convert_to(comparison->>'current_text','UTF8'),'sha256'),'hex') is distinct from p_candidate#>>'{new_snapshot_ref,text_sha256}'
 then raise exception 'Complete original source block and quotation are required.' using errcode='23514';end if;
 title:=btrim(regexp_replace(block->>'text','[[:space:]]+',' ','g'));
 if title !~* '^Information for (Candidates|Applicants)([[:space:]]+[-–—][[:space:]]+[[:alnum:]][[:alnum:] .''’()&,-]{0,100})?$'
  or strpos(regexp_replace(comparison->>'current_text','[[:space:]]+',' ','g'),title)>0
 then raise exception 'The complete qualified reference must be absent from current text.' using errcode='23514';end if;
 base_title:=case when title ~* '^Information for Candidates' then 'Information for Candidates' else 'Information for Applicants' end;
 for framing in select value from jsonb_array_elements(changed->'previous_context') loop
  if framing->>'kind'='p' and framing->>'heading'=block->>'heading'
   and framing#>'{context,heading_path}'=block#>'{context,heading_path}'
   and private.awardping_program_block_valid(framing,comparison->>'previous_text')
   and (block->>'start_utf16')::integer-(framing->>'end_utf16')::integer between 1 and 2
   and private.awardping_program_utf16_slice(comparison->>'previous_text',(framing->>'end_utf16')::integer,(block->>'start_utf16')::integer) ~ '^[[:space:]]{1,2}$'
   and regexp_replace(framing->>'text','[[:space:]]+',' ','g') ~* ('\mread[[:space:]]+(the[[:space:]]+)?'||base_title||'[[:space:]]+carefully[.!]')
   and regexp_replace(framing->>'text','[[:space:]]+',' ','g') ~* '\mThese documents can all be accessed below[.!]'
  then valid_framing:=true;end if;
 end loop;
 if not valid_framing then raise exception 'Immediate same-scope official document framing is required.' using errcode='23514';end if;
 return jsonb_build_object('policy','awardping.program-text-document-reference-recovery.v1','scope','page_document_reference_removed',
  'title',title,'derived_summary','The page no longer lists “'||title||'”.','original_responses',original);
end $$;
revoke all on function private.awardping_document_recovery_shape(jsonb) from public,anon,authenticated;
grant execute on function private.awardping_document_recovery_shape(jsonb) to service_role;

create function private.awardping_document_recovery_source_proof(p_candidate jsonb)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare source_row public.shared_award_sources%rowtype;registry_row public.stage1_award_registry%rowtype;active_epoch uuid;
begin
 select * into strict source_row from public.shared_award_sources where id=(p_candidate->>'shared_award_source_id')::uuid;
 select * into strict registry_row from public.stage1_award_registry r
  where exists(select 1 from public.stage1_award_members m where m.cohort_key=r.cohort_key and m.shared_award_id=source_row.shared_award_id)
   and exists(select 1 from public.program_text_source_roster roster_role where roster_role.cohort_key=r.cohort_key and source_row.id=any(roster_role.source_ids) and roster_role.manifest_status='reviewed_text');
 select epoch into strict active_epoch from public.program_text_source_authority_epochs where active;
 if source_row.shared_award_id::text is distinct from p_candidate->>'shared_award_id' or source_row.url is distinct from p_candidate->>'source_url'
  or source_row.text_monitoring_state->>'schema' is distinct from 'awardping.program-text-state.v1'
  or source_row.text_monitoring_state->>'status' is distinct from 'awaiting_review'
  or source_row.text_monitoring_state->>'epoch' is distinct from active_epoch::text
  or p_candidate#>>'{worker_metadata,epoch}' is distinct from active_epoch::text
  or source_row.text_monitoring_state->'baseline_ref' is distinct from p_candidate->'previous_snapshot_ref'
  or source_row.text_monitoring_state->'latest_ref' is distinct from p_candidate->'new_snapshot_ref'
  or p_candidate#>>'{previous_snapshot_ref,source,id}' is distinct from source_row.id::text
  or p_candidate#>>'{new_snapshot_ref,source,id}' is distinct from source_row.id::text
  or p_candidate#>>'{previous_snapshot_ref,source,shared_award_id}' is distinct from source_row.shared_award_id::text
  or p_candidate#>>'{new_snapshot_ref,source,shared_award_id}' is distinct from source_row.shared_award_id::text
  or p_candidate#>>'{previous_snapshot_ref,source,url}' is distinct from source_row.url
  or p_candidate#>>'{new_snapshot_ref,source,url}' is distinct from source_row.url
  or not private.awardping_program_text_source_access(source_row.id,registry_row.cohort_key,active_epoch)
  or not private.awardping_program_text_collection_quality_ready(source_row.id,active_epoch)
  or not exists(select 1 from public.program_text_source_roster r where r.cohort_key=registry_row.cohort_key and source_row.id=any(r.source_ids)
   and r.manifest_status='reviewed_text' and r.evidence#>>array['source_bindings',source_row.id::text,'source_url']=source_row.url
   and r.evidence#>>array['source_bindings',source_row.id::text,'shared_award_id']=source_row.shared_award_id::text)
  or not exists(select 1 from public.shared_awards award where award.id=source_row.shared_award_id and award.status='active'
   and jsonb_build_object('award_id',award.id,'award_name',award.name,'source_url',source_row.url,'source_title',source_row.title)=p_candidate#>'{prompt_payload,program_identity}')
  or exists(select 1 from public.program_text_alert_reviews a where a.id=(p_candidate->>'id')::uuid)
 then raise exception 'Current source pair, quality, text authority or owner changed.' using errcode='40001';end if;
 return jsonb_build_object('source',to_jsonb(source_row),'epoch',active_epoch,'registry',to_jsonb(registry_row),
  'members',(select jsonb_agg(to_jsonb(m) order by m.shared_award_id) from public.stage1_award_members m where m.cohort_key=registry_row.cohort_key),
  'roles',(select jsonb_agg(to_jsonb(r) order by r.source_role) from public.program_text_source_roster r where r.cohort_key=registry_row.cohort_key),
  'exclusions',coalesce((select jsonb_agg(to_jsonb(e) order by e.id) from public.stage1_award_source_identity_rules e where e.cohort_key=registry_row.cohort_key),'[]'::jsonb),
  'source_authority',private.awardping_program_text_source_approval_dto(source_row.id));
end $$;
revoke all on function private.awardping_document_recovery_source_proof(jsonb) from public,anon,authenticated;
grant execute on function private.awardping_document_recovery_source_proof(jsonb) to service_role;

create function public.inspect_program_text_document_recovery(p_candidate uuid)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare candidate_row public.shared_award_visual_review_candidates%rowtype;prior public.program_text_document_recovery_journal%rowtype;
 snapshot jsonb;source_proof jsonb;paid_row public.gemini_spend_reservations%rowtype;events jsonb;preimage text;response_hash text;shape jsonb;
begin
 select * into prior from public.program_text_document_recovery_journal where candidate_id=p_candidate;
 if found then return jsonb_build_object('schema','awardping.program-text-document-recovery-inspection.v1','already_applied',true,
  'receipt',jsonb_build_object('journal_id',prior.id,'candidate_id',prior.candidate_id,'root_plan_hash',prior.root_plan_hash,
   'preimage_hash',prior.preimage_hash,'responses_hash',prior.responses_hash,'actor',prior.actor,'reason',prior.reason,'recovered_at',prior.recovered_at,'status','historical_receipt'));end if;
 select * into strict candidate_row from public.shared_award_visual_review_candidates where id=p_candidate;
 snapshot:=to_jsonb(candidate_row);shape:=private.awardping_document_recovery_shape(snapshot);
 source_proof:=private.awardping_document_recovery_source_proof(snapshot);
 select * into strict paid_row from public.gemini_spend_reservations where id=(snapshot#>>'{worker_metadata,gemini_spend_reservation_id}')::uuid;
 if paid_row.status<>'settled' or paid_row.request_count<>1 or paid_row.model is distinct from candidate_row.model
  or paid_row.provider_batch_name is distinct from candidate_row.gemini_batch_name
  or paid_row.attempt_token::text is distinct from snapshot#>>'{worker_metadata,gemini_spend_attempt_token}'
  or paid_row.work_fingerprint is distinct from 'program-text:'||candidate_row.candidate_signature||':'||candidate_row.model
  or paid_row.metadata->>'candidate_id' is distinct from candidate_row.id::text
  or exists(select 1 from public.gemini_spend_reservations r where r.metadata->>'candidate_id'=candidate_row.id::text and r.status in ('reserved','creating','submitted'))
 then raise exception 'Original settled paid review and no active provider attempt are required.' using errcode='23514';end if;
 select coalesce(jsonb_agg(to_jsonb(e) order by e.id),'[]'::jsonb) into events from public.gemini_spend_events e where e.reservation_id=paid_row.id;
 if not exists(select 1 from public.gemini_spend_events e where e.reservation_id=paid_row.id and e.event_type='settled')
 then raise exception 'Original settled paid history is missing.' using errcode='23514';end if;
 preimage:=encode(extensions.digest(convert_to(jsonb_build_object('failed_candidate',snapshot,'source_identity_proof',source_proof,'paid_reservation',to_jsonb(paid_row),'paid_events',events)::text,'UTF8'),'sha256'),'hex');
 response_hash:=encode(extensions.digest(convert_to((snapshot#>'{ai_result,responses}')::text,'UTF8'),'sha256'),'hex');
 return jsonb_build_object('schema','awardping.program-text-document-recovery-inspection.v1','already_applied',false,'candidate',snapshot,
  'source_identity_proof',source_proof,'paid_reservation',to_jsonb(paid_row),'paid_events',events,'preimage_hash',preimage,'responses_hash',response_hash,'scope',shape->>'scope','derived_summary',shape->>'derived_summary');
end $$;
revoke all on function public.inspect_program_text_document_recovery(uuid) from public,anon,authenticated;
grant execute on function public.inspect_program_text_document_recovery(uuid) to service_role;

create function public.commit_program_text_document_recovery(p_candidate uuid,p_preimage_hash text,p_responses_hash text,p_root_plan_hash text,p_reason text,p_actor text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare candidate_row public.shared_award_visual_review_candidates%rowtype;prior public.program_text_document_recovery_journal%rowtype;
 snapshot jsonb;inspection jsonb;journal_id uuid:=gen_random_uuid();recovered_at timestamptz:=clock_timestamp();changed_count integer;
begin
 if p_candidate is null or coalesce(p_preimage_hash,'') !~ '^[a-f0-9]{64}$' or coalesce(p_responses_hash,'') !~ '^[a-f0-9]{64}$'
  or coalesce(p_root_plan_hash,'') !~ '^[a-f0-9]{64}$' or length(btrim(coalesce(p_reason,''))) not between 20 and 2000
  or p_actor is distinct from 'codex_operator:user_authorized_saved_response_recovery'
 then raise exception 'Exact operator-reviewed saved response and recovery versions are required.' using errcode='23514';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('stage1-national-25-release',0));
 select * into prior from public.program_text_document_recovery_journal where candidate_id=p_candidate;
 if found then
  if prior.preimage_hash is distinct from p_preimage_hash or prior.responses_hash is distinct from p_responses_hash or prior.root_plan_hash is distinct from p_root_plan_hash
   or prior.reason is distinct from p_reason or prior.actor is distinct from p_actor
  then raise exception 'A different immutable recovery already exists.' using errcode='40001';end if;
  return jsonb_build_object('journal_id',prior.id,'candidate_id',prior.candidate_id,'recovered_at',prior.recovered_at,'already_applied',true,'status','succeeded');
 end if;
 select * into strict candidate_row from public.shared_award_visual_review_candidates where id=p_candidate for update nowait;
 perform 1 from public.shared_award_sources where id=candidate_row.shared_award_source_id for share nowait;
 perform 1 from public.program_text_source_authority_epochs where active for share nowait;
 perform 1 from public.gemini_spend_reservations where id=(candidate_row.worker_metadata->>'gemini_spend_reservation_id')::uuid for share nowait;
 inspection:=public.inspect_program_text_document_recovery(p_candidate);
 if inspection->>'already_applied' is distinct from 'false' or inspection->>'preimage_hash' is distinct from p_preimage_hash or inspection->>'responses_hash' is distinct from p_responses_hash
 then raise exception 'Recovery state, original responses, authority or paid history changed after preview.' using errcode='40001';end if;
 snapshot:=to_jsonb(candidate_row);
 insert into public.program_text_document_recovery_journal(id,candidate_id,policy,preimage_hash,responses_hash,root_plan_hash,failed_candidate,source_identity_proof,paid_reservation,paid_events,original_responses,actor,reason,recovered_at)
 values(journal_id,p_candidate,'awardping.program-text-document-reference-recovery.v1',p_preimage_hash,p_responses_hash,p_root_plan_hash,snapshot,
  inspection->'source_identity_proof',inspection->'paid_reservation',inspection->'paid_events',snapshot#>'{ai_result,responses}',p_actor,p_reason,recovered_at);
 update public.shared_award_visual_review_candidates set status='succeeded',rejection_reason=null,updated_at=recovered_at,
  worker_metadata=worker_metadata||jsonb_build_object('program_text_document_recovery',jsonb_build_object('journal_id',journal_id,'policy','awardping.program-text-document-reference-recovery.v1'))
 where id=p_candidate and status='failed' and to_jsonb(shared_award_visual_review_candidates)=snapshot;
 get diagnostics changed_count=row_count;
 if changed_count<>1 then raise exception 'Failed candidate changed before its recovery transition.' using errcode='40001';end if;
 return jsonb_build_object('journal_id',journal_id,'candidate_id',p_candidate,'recovered_at',recovered_at,'already_applied',false,'status','succeeded');
end $$;
revoke all on function public.commit_program_text_document_recovery(uuid,text,text,text,text,text) from public,anon,authenticated;
grant execute on function public.commit_program_text_document_recovery(uuid,text,text,text,text,text) to service_role;
notify pgrst,'reload schema';
