-- Finite operator-reviewed quotation-ID recovery. No provider retry, source
-- baseline, publication, fact approval or old validator is changed here.
create table public.program_text_quote_id_recovery_journal (
 id uuid primary key default gen_random_uuid(),candidate_id uuid not null unique references public.shared_award_visual_review_candidates(id) on delete restrict,
 policy text not null check(policy='awardping.program-text-quote-id-recovery.v1'),preimage_hash text not null,projection_hash text not null,
 failed_candidate jsonb not null,source_identity_proof jsonb not null,original_responses jsonb not null,projected_responses jsonb not null,
 substitutions jsonb not null,actor_id uuid not null,reason text not null,approved_at timestamptz not null default clock_timestamp(),
 check(preimage_hash ~ '^[a-f0-9]{64}$' and projection_hash ~ '^[a-f0-9]{64}$'),check(length(btrim(reason)) between 20 and 2000)
);
alter table public.program_text_quote_id_recovery_journal enable row level security;
revoke all on public.program_text_quote_id_recovery_journal from public,anon,authenticated,service_role;
grant select on public.program_text_quote_id_recovery_journal to service_role;
create function private.awardping_reject_quote_id_recovery_mutation()
returns trigger language plpgsql security invoker set search_path='' as $$begin
 raise exception 'Quotation-ID recovery history is immutable.' using errcode='42501';
end $$;
revoke all on function private.awardping_reject_quote_id_recovery_mutation() from public,anon,authenticated,service_role;
create trigger program_text_quote_id_recovery_immutable before update or delete on public.program_text_quote_id_recovery_journal
 for each row execute function private.awardping_reject_quote_id_recovery_mutation();
create trigger program_text_quote_id_recovery_no_truncate before truncate on public.program_text_quote_id_recovery_journal
 for each statement execute function private.awardping_reject_quote_id_recovery_mutation();

create function private.awardping_program_quote_id_recovery_projection(p_candidate jsonb)
returns jsonb language plpgsql immutable security invoker set search_path='' as $$
declare original jsonb:=p_candidate#>'{ai_result,responses}';projected jsonb;comparison jsonb:=p_candidate#>'{prompt_payload,comparison}';
 plan jsonb:=p_candidate#>'{prompt_payload,packet_plan}';changed jsonb;side text;source_block jsonb;quote jsonb;quote_at integer;
 start_utf16 integer;end_utf16 integer;substitutions jsonb:='[]';full_text text;
begin
 if p_candidate->>'id' is distinct from '8d40add5-89ea-4f96-9c31-f1f68c1fa472'
  or p_candidate->>'shared_award_source_id' is distinct from 'd4509d97-da9b-4e12-bbe9-45129e6ce1c1'
  or p_candidate->>'shared_award_id' is distinct from 'd955a846-cee1-4c01-932e-e3cb7215f3fb'
  or p_candidate->>'candidate_scope' is distinct from 'program_text_change' or p_candidate->>'status' is distinct from 'failed'
  or p_candidate->>'rejection_reason' is distinct from 'manual_review_required:quote_not_bound_to_changed_block'
  or p_candidate#>'{ai_result,program_text_validation,reasons}' is distinct from '["quote_not_bound_to_changed_block"]'::jsonb
  or p_candidate#>>'{ai_result,program_text_validation,status}' is distinct from 'held'
  -- Pin the actual reviewed saved JSONB response as well as its candidate.
  -- This digest is PostgreSQL jsonb::text, not provider wire bytes or JS JSON.
  or encode(extensions.digest(convert_to(original::text,'UTF8'),'sha256'),'hex') is distinct from 'f2685822df09e002dc13da27189d6cb2ad7dc6583a84301cecfe7f9c36b6edaf'
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
  or not private.awardping_program_text_reference_valid(p_candidate->'previous_snapshot_ref')
  or not private.awardping_program_text_reference_valid(p_candidate->'new_snapshot_ref')
 then raise exception 'Outside the finite saved quotation-ID recovery policy.' using errcode='23514';end if;
 changed:=comparison#>'{changed_blocks,0}';
 if changed->>'id' is distinct from original#>>'{0,blocks,0,id}' or changed is distinct from plan#>'{packets,0,blocks,0}'
 then raise exception 'Saved response is not bound to its original changed row.' using errcode='23514';end if;
 projected:=original;
 foreach side in array array['previous','current'] loop
  source_block:=changed->side;quote:=original#>array['0','blocks','0','changes','0',side||'_quote'];full_text:=comparison->>(side||'_text');
  if not private.awardping_program_exact_object(quote,array['block_id','text']) or quote->>'block_id' is distinct from changed->>'id'
   or source_block->>'id'=changed->>'id' or private.awardping_program_block_valid(source_block,full_text) is distinct from true
   or jsonb_typeof(quote->'text') is distinct from 'string' or length(quote->>'text') not between 1 and 4000
   or encode(extensions.digest(convert_to(full_text,'UTF8'),'sha256'),'hex') is distinct from p_candidate#>>array[case when side='previous' then 'previous_snapshot_ref' else 'new_snapshot_ref' end,'text_sha256']
   then raise exception 'Only exact source-bound quotation-ID substitutions are permitted.' using errcode='23514';end if;
  quote_at:=strpos(source_block->>'text',quote->>'text');
  if quote_at<1 or strpos(substr(source_block->>'text',quote_at+1),quote->>'text')>0
   then raise exception 'Quote is absent or ambiguous in its exact source block.' using errcode='23514';end if;
  start_utf16:=(source_block->>'start_utf16')::integer+private.awardping_program_utf16_length(substr(source_block->>'text',1,quote_at-1));
  end_utf16:=start_utf16+private.awardping_program_utf16_length(quote->>'text');
  if private.awardping_program_utf16_slice(full_text,start_utf16,end_utf16) is distinct from quote->>'text'
   then raise exception 'Exact quotation UTF16 proof failed.' using errcode='23514';end if;
  projected:=jsonb_set(projected,array['0','blocks','0','changes','0',side||'_quote','block_id'],source_block->'id',false);
  substitutions:=substitutions||jsonb_build_array(jsonb_build_object('path','/0/blocks/0/changes/0/'||side||'_quote/block_id','side',side,
   'old_block_id',quote->'block_id','new_block_id',source_block->'id','quote',quote->'text'));
 end loop;
 return jsonb_build_object('projected_responses',projected,'changes',substitutions);
end $$;
revoke all on function private.awardping_program_quote_id_recovery_projection(jsonb) from public,anon,authenticated;
grant execute on function private.awardping_program_quote_id_recovery_projection(jsonb) to service_role;

create function private.awardping_program_quote_id_recovery_source_proof(p_candidate jsonb)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare source_row public.shared_award_sources%rowtype;registry_row public.stage1_award_registry%rowtype;active_epoch uuid;
begin
 select * into strict source_row from public.shared_award_sources where id='d4509d97-da9b-4e12-bbe9-45129e6ce1c1';
 select * into strict registry_row from public.stage1_award_registry where cohort_key='nsf_grfp';
 select epoch into strict active_epoch from public.program_text_source_authority_epochs where active;
 if source_row.id::text is distinct from p_candidate->>'shared_award_source_id'
  or source_row.shared_award_id::text is distinct from p_candidate->>'shared_award_id' or source_row.url is distinct from p_candidate->>'source_url'
  or registry_row.canonical_shared_award_id<>source_row.shared_award_id
  or source_row.text_monitoring_state->>'epoch' is distinct from active_epoch::text
  or p_candidate#>>'{worker_metadata,epoch}' is distinct from active_epoch::text
  or source_row.text_monitoring_state->'baseline_ref' is distinct from p_candidate->'previous_snapshot_ref'
  or source_row.text_monitoring_state->'latest_ref' is distinct from p_candidate->'new_snapshot_ref'
  or not private.awardping_program_text_source_access(source_row.id,registry_row.cohort_key,active_epoch)
  or not private.awardping_program_source_allowed(source_row.id)
  or not exists(select 1 from public.shared_awards award where award.id=source_row.shared_award_id and award.status='active'
   and jsonb_build_object('award_id',award.id,'award_name',award.name,'source_url',source_row.url,'source_title',source_row.title)
     =p_candidate#>'{prompt_payload,program_identity}')
 then raise exception 'Current source pair, identity or text authority changed.' using errcode='40001';end if;
 return jsonb_build_object('source',jsonb_build_object('id',source_row.id,'shared_award_id',source_row.shared_award_id,'url',source_row.url,
  'title',source_row.title,'page_type',source_row.page_type,'admin_review_status',source_row.admin_review_status,'text_monitoring_state',source_row.text_monitoring_state),
  'epoch',active_epoch,'registry',to_jsonb(registry_row),
  'members',(select jsonb_agg(to_jsonb(m) order by m.shared_award_id) from public.stage1_award_members m where m.cohort_key=registry_row.cohort_key),
  'roles',(select jsonb_agg(to_jsonb(r) order by r.source_role) from public.program_text_source_roster r where r.cohort_key=registry_row.cohort_key),
  'exclusions',coalesce((select jsonb_agg(to_jsonb(e) order by e.id) from public.stage1_award_source_identity_rules e where e.cohort_key=registry_row.cohort_key),'[]'::jsonb),
  'source_authority',private.awardping_program_text_source_approval_dto(source_row.id),
  'variation_head',(select to_jsonb(h) from public.program_variation_inventory_heads h where h.cohort_key=registry_row.cohort_key),
  'variation_draft_head',(select to_jsonb(h) from public.program_variation_inventory_draft_heads h where h.cohort_key=registry_row.cohort_key),
  'variation_publication',(select jsonb_build_object('revision',r.revision,'approval_id',r.approval_ids->registry_row.cohort_key)
   from public.program_variation_release r where r.is_active));
end $$;
revoke all on function private.awardping_program_quote_id_recovery_source_proof(jsonb) from public,anon,authenticated;
grant execute on function private.awardping_program_quote_id_recovery_source_proof(jsonb) to service_role;

create function public.inspect_program_text_quote_id_recovery(p_candidate uuid)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare candidate_row public.shared_award_visual_review_candidates%rowtype;prior public.program_text_quote_id_recovery_journal%rowtype;
 failed_snapshot jsonb;source_proof jsonb;projection jsonb;preimage text;projection_hash text;
begin
 if p_candidate is distinct from '8d40add5-89ea-4f96-9c31-f1f68c1fa472'::uuid then raise exception 'Unsupported recovery candidate.' using errcode='23514';end if;
 select * into prior from public.program_text_quote_id_recovery_journal where candidate_id=p_candidate;
 if found then return jsonb_build_object('already_applied',true,'receipt',jsonb_build_object('journal_id',prior.id,'candidate_id',prior.candidate_id,
  'approved_at',prior.approved_at,'status','historical_receipt'));end if;
 select * into strict candidate_row from public.shared_award_visual_review_candidates where id=p_candidate;
 failed_snapshot:=to_jsonb(candidate_row);projection:=private.awardping_program_quote_id_recovery_projection(failed_snapshot);
 source_proof:=private.awardping_program_quote_id_recovery_source_proof(failed_snapshot);
 preimage:=encode(extensions.digest(convert_to(jsonb_build_object('failed_candidate',failed_snapshot,'source_identity_proof',source_proof)::text,'UTF8'),'sha256'),'hex');
 projection_hash:=encode(extensions.digest(convert_to((projection->'projected_responses')::text,'UTF8'),'sha256'),'hex');
 return jsonb_build_object('already_applied',false,'candidate',failed_snapshot,'source_identity_proof',source_proof,'preimage_hash',preimage,
  'projection_hash',projection_hash,'projected_responses',projection->'projected_responses','changes',projection->'changes');
end $$;
revoke all on function public.inspect_program_text_quote_id_recovery(uuid) from public,anon,authenticated;
grant execute on function public.inspect_program_text_quote_id_recovery(uuid) to service_role;

create function public.approve_program_text_quote_id_recovery(p_candidate uuid,p_preimage_hash text,p_projection_hash text,p_reason text,p_actor uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare candidate_row public.shared_award_visual_review_candidates%rowtype;prior public.program_text_quote_id_recovery_journal%rowtype;
 snapshot jsonb;projection jsonb;source_proof jsonb;inspection jsonb;journal_id uuid:=gen_random_uuid();approved_at timestamptz:=clock_timestamp();changed_count integer;
begin
 if p_candidate is distinct from '8d40add5-89ea-4f96-9c31-f1f68c1fa472'::uuid or coalesce(p_preimage_hash,'') !~ '^[a-f0-9]{64}$'
  or coalesce(p_projection_hash,'') !~ '^[a-f0-9]{64}$' or length(btrim(coalesce(p_reason,''))) not between 20 and 2000
  or p_actor is null or not exists(select 1 from auth.users actor where actor.id=p_actor)
 then raise exception 'Exact administrator review and recovery versions are required.' using errcode='23514';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('stage1-national-25-release',0));
 select * into prior from public.program_text_quote_id_recovery_journal where candidate_id=p_candidate;
 if found then
  if prior.preimage_hash is distinct from p_preimage_hash or prior.projection_hash is distinct from p_projection_hash or prior.reason is distinct from p_reason
   then raise exception 'A different recovery already exists; history is immutable.' using errcode='40001';end if;
  return jsonb_build_object('journal_id',prior.id,'candidate_id',prior.candidate_id,'approved_at',prior.approved_at,'already_applied',true,'status','historical_receipt');
 end if;
 perform 1 from public.shared_award_sources where id='d4509d97-da9b-4e12-bbe9-45129e6ce1c1' for share nowait;
 select * into strict candidate_row from public.shared_award_visual_review_candidates where id=p_candidate for update nowait;
 -- The read helper runs again after row locks, using the transaction's current
 -- source, exact full failed row, role revisions, epoch and approval records.
 inspection:=public.inspect_program_text_quote_id_recovery(p_candidate);
 if inspection->>'preimage_hash' is distinct from p_preimage_hash or inspection->>'projection_hash' is distinct from p_projection_hash
  or inspection->>'already_applied' is distinct from 'false' then raise exception 'Recovery state changed after preview.' using errcode='40001';end if;
 snapshot:=to_jsonb(candidate_row);source_proof:=inspection->'source_identity_proof';projection:=private.awardping_program_quote_id_recovery_projection(snapshot);
 insert into public.program_text_quote_id_recovery_journal(id,candidate_id,policy,preimage_hash,projection_hash,failed_candidate,source_identity_proof,
  original_responses,projected_responses,substitutions,actor_id,reason,approved_at)
 values(journal_id,p_candidate,'awardping.program-text-quote-id-recovery.v1',p_preimage_hash,p_projection_hash,snapshot,source_proof,
  snapshot#>'{ai_result,responses}',projection->'projected_responses',projection->'changes',p_actor,p_reason,approved_at);
 update public.shared_award_visual_review_candidates set status='succeeded',ai_result=jsonb_set(ai_result,'{responses}',projection->'projected_responses',false),
  rejection_reason=null,updated_at=approved_at,
  worker_metadata=worker_metadata||jsonb_build_object('program_text_quote_id_recovery',jsonb_build_object('journal_id',journal_id,'policy','awardping.program-text-quote-id-recovery.v1'))
 where id=p_candidate and status='failed' and to_jsonb(shared_award_visual_review_candidates)=snapshot;
 get diagnostics changed_count=row_count;
 if changed_count<>1 then raise exception 'Failed candidate changed before its recovery transition.' using errcode='40001';end if;
 return jsonb_build_object('journal_id',journal_id,'candidate_id',p_candidate,'approved_at',approved_at,'already_applied',false,'status','succeeded');
end $$;
revoke all on function public.approve_program_text_quote_id_recovery(uuid,text,text,text,uuid) from public,anon,authenticated;
grant execute on function public.approve_program_text_quote_id_recovery(uuid,text,text,text,uuid) to service_role;
notify pgrst,'reload schema';
