import {buildProgramTextCapture} from './program-text-capture-contract.mjs';
import {programTextReference} from './program-text-artifacts.mjs';
import {emptyProgramFactReview,validateCurrentBasicFactReview} from './program-text-facts.mjs';
import {currentBasicContentIdentity} from './current-basic-source-proof.mjs';
const literal=x=>"'"+JSON.stringify(x).replaceAll("'","''")+"'::jsonb";

/** Native-schema rehearsal only. Synthetic captures/rows are explicitly labelled,
 * confined to the generated BEGIN/ROLLBACK, and never represent provider evidence.
 * All 23 genuine existing heads are checked before and after additive DDL. */
export async function currentBasicFactsRollbackFixture({migration,epoch,award_id}){
 if(typeof migration!=='string'||!migration.includes('create function public.attest_program_basic_repeat(')||/\b(?:commit|rollback)\s*;/i.test(migration)||
  ![epoch,award_id].every(x=>/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(x)))throw Error('Exact additive migration and actual fixture ownership required');
 const source={id:'11111111-1111-4111-8111-111111111111',shared_award_id:award_id,url:'https://carnegieendowment.org/awardping-rollback-fixture',title:'ROLLBACK ONLY synthetic basic-facts fixture',page_type:'application',admin_review_status:'open',text_collection_quality:null};
 const text='ROLLBACK ONLY synthetic award supports graduate study. The deadline is January 31, 2027.';
 const make=(at,body=text)=>buildProgramTextCapture({source,acquisition:'http_html',raw_bytes:Buffer.from('<main>'+body+'</main>'),content_type:'text/html',text:body,
  blocks:[{id:'body',text:body,start_utf16:0,end_utf16:body.length}],extractor:{name:'rollback-only-fixture',version:'1'},captured_at:at});
 const capture=make('2026-10-28T18:00:00.000Z'),repeat=make('2026-10-28T19:00:00.000Z'),old=make('2026-10-27T18:00:00.000Z','ROLLBACK ONLY previous synthetic wording.');
 const ref=programTextReference(capture),repeatRef=programTextReference(repeat),oldRef=programTextReference(old),candidate='66666666-6666-4666-8666-666666666666';
 source.text_monitoring_state={schema:'awardping.program-text-state.v1',epoch,status:'baseline_ready',baseline_ref:ref,latest_ref:ref,successful_checks:99,first_captured_at:old.captured_at,last_checked_at:ref.captured_at};
 const role={source_role:'application',revision:epoch,source_ids:[source.id],manifest_status:'reviewed_text',evidence:{schema:'awardping.program-text-source-role.v1',source_bindings:{[source.id]:{source_url:source.url,shared_award_id:award_id}}}};
 const context={registry:{cohort_key:'gaither',canonical_shared_award_id:award_id},roles:[role],sources:[source],memberIds:[award_id],epoch,pending_alert_reviews:[],
  repeat_observation_ids:[{source_id:source.id,id:'44444444-4444-4444-8444-444444444444'}],repeat_observations:[{id:'44444444-4444-4444-8444-444444444444',cohort_key:'gaither',source_id:source.id,epoch,current_ref:ref,repeat_ref:repeatRef,content_identity:currentBasicContentIdentity(ref),verified_at:'2026-10-29T00:00:00.000Z'}],
  loadCapture:async r=>r.capture_id===ref.capture_id?capture:repeat};
 const review=emptyProgramFactReview({...context,cycle:'ROLLBACK ONLY 2027'}),q=value=>({source_id:source.id,capture_id:ref.capture_id,block_id:'body',start_utf16:text.indexOf(value),end_utf16:text.indexOf(value)+value.length,text:value});
 Object.assign(review.fields[0],{status:'verified',items:[{value:'ROLLBACK ONLY synthetic award supports graduate study.',track:null,support:[q('ROLLBACK ONLY synthetic award supports graduate study.')]}]});
 const validation=await validateCurrentBasicFactReview(review,context),doc={reference:repeatRef,text:repeat.text,blocks:repeat.blocks,blocks_json:JSON.stringify(repeat.blocks)};
 // The source SQL validator hashes canonical blocks, not a differently ordered JSON string.
 doc.blocks_json=validation.source_text[0].blocks_json;
 return `BEGIN;
SET LOCAL statement_timeout='45s';SET LOCAL lock_timeout='3s';
CREATE TEMP TABLE current_basic_fixture_result(result jsonb);
CREATE TEMP TABLE current_basic_before_heads AS SELECT h.cohort_key,h.snapshot_id,private.awardping_basic_fact_current(h.snapshot_id) current FROM public.program_basic_fact_heads h;
CREATE TEMP TABLE current_basic_before_roster AS SELECT * FROM public.program_text_source_roster WHERE cohort_key='gaither';
${migration}
DO $fixture$ DECLARE
 sid constant uuid:='${source.id}';cid constant uuid:='${candidate}';owner constant uuid:='${award_id}';e constant uuid:='${epoch}';
 v jsonb:=${literal(validation)};ref jsonb:=${literal(ref)};rep jsonb:=${literal(doc)};old_ref jsonb:=${literal(oldRef)};
 state jsonb:=${literal(source.text_monitoring_state)};c public.shared_award_visual_review_candidates%rowtype;
 p jsonb;sv jsonb;receipt jsonb;result jsonb;repeat_id uuid;draft_id uuid;draft_hash text;head uuid;rh text;review_at text;pending_hash text;
 failed boolean;fn text;name text;count_checks integer:=0;n bigint;before_sources text;before_alerts bigint;before_events bigint;before_outbox bigint;
 BEGIN
 IF (SELECT count(*) FROM current_basic_before_heads)<>23 OR EXISTS(SELECT 1 FROM current_basic_before_heads WHERE NOT current)
 OR EXISTS(SELECT 1 FROM current_basic_before_heads b WHERE private.awardping_basic_fact_current(b.snapshot_id) IS DISTINCT FROM b.current) THEN RAISE EXCEPTION 'Existing 23 basic getters changed after additive DDL';END IF;count_checks:=count_checks+1;
 SELECT count(*) INTO before_alerts FROM public.program_text_alert_reviews;SELECT count(*) INTO before_events FROM public.shared_award_change_events;SELECT count(*) INTO before_outbox FROM public.public_digest_outbox;
 FOREACH fn IN ARRAY ARRAY['public.attest_program_basic_repeat(text,jsonb,jsonb,timestamptz,text)','public.save_current_program_basic_fact_review(jsonb,text)','public.commit_current_program_basic_facts(uuid,text,uuid,jsonb,text,text)','public.inspect_current_program_basic_award(text)','public.inspect_current_basic_fact_draft(uuid)'] LOOP
  IF has_function_privilege('anon',fn,'EXECUTE') OR has_function_privilege('authenticated',fn,'EXECUTE') OR NOT has_function_privilege('service_role',fn,'EXECUTE') THEN RAISE EXCEPTION 'Unauthorized role boundary failed';END IF;count_checks:=count_checks+1;
 END LOOP;
 IF EXISTS(SELECT 1 FROM public.shared_award_sources WHERE id=sid) OR EXISTS(SELECT 1 FROM public.shared_award_visual_review_candidates WHERE id=cid) THEN RAISE EXCEPTION 'Synthetic fixture ID collision';END IF;
 INSERT INTO public.shared_award_sources(id,shared_award_id,url,title,page_type,admin_review_status,text_monitoring_state) VALUES(sid,owner,'${source.url}','${source.title}','application','open',state);
 DELETE FROM public.program_text_source_roster WHERE cohort_key='gaither';
 INSERT INTO public.program_text_source_roster(cohort_key,source_role,source_ids,evidence,revision,reviewed_by) VALUES('gaither','application',ARRAY[sid],${literal(role.evidence)},e,'ROLLBACK ONLY synthetic fixture');
 -- Lifetime check counts cannot replace an independent retained observation.
 failed:=false;BEGIN PERFORM public.attest_program_basic_repeat('gaither',ref,jsonb_set(rep,'{reference}',ref),clock_timestamp(),'ROLLBACK ONLY');EXCEPTION WHEN check_violation THEN failed:=true;END;IF NOT failed THEN RAISE EXCEPTION 'Same observation accepted as repeat';END IF;count_checks:=count_checks+1;
 BEGIN
  UPDATE public.shared_award_sources SET text_monitoring_state=state-'baseline_ref' WHERE id=sid;
  IF private.awardping_current_basic_source_ready(sid,'gaither',e,ref) IS DISTINCT FROM false THEN RAISE EXCEPTION 'Missing baseline returned nullable readiness';END IF;
  RAISE EXCEPTION 'ROLLBACK ONLY missing baseline simulation' USING ERRCODE='P0099';EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;END;count_checks:=count_checks+1;
 state:=state||jsonb_build_object('status','awaiting_review','baseline_ref',old_ref);UPDATE public.shared_award_sources SET text_monitoring_state=state WHERE id=sid;
 IF private.awardping_current_basic_source_ready(sid,'gaither',e,ref) THEN RAISE EXCEPTION 'Arbitrary pending state became current';END IF;count_checks:=count_checks+1;
 INSERT INTO public.shared_award_visual_review_candidates(id,shared_award_id,shared_award_source_id,candidate_signature,source_url,previous_snapshot_ref,new_snapshot_ref,status,candidate_scope,worker_metadata,ai_result)
 VALUES(cid,owner,sid,repeat('a',64),'${source.url}',old_ref,ref,'failed','program_text_change',jsonb_build_object('monitoring_contract','program-text-v1','epoch',e,'evidence_signature',repeat('a',64),'admin_alert_review_id',cid),'{}');
 IF private.awardping_current_basic_source_ready(sid,'gaither',e,ref) THEN RAISE EXCEPTION 'Failed provider candidate became current';END IF;count_checks:=count_checks+1;
 UPDATE public.shared_award_visual_review_candidates SET status='succeeded',ai_result='{"program_text_validation":{"status":"accepted"}}' WHERE id=cid;
 IF private.awardping_current_basic_source_ready(sid,'gaither',e,ref) THEN RAISE EXCEPTION 'No owner-review proof accepted';END IF;count_checks:=count_checks+1;
 SELECT * INTO c FROM public.shared_award_visual_review_candidates WHERE id=cid;pending_hash:=private.program_text_alert_hash(c,'{}','{}');
 INSERT INTO public.program_text_alert_reviews(id,content_hash,candidate_signature,details,localization) VALUES(cid,pending_hash,c.candidate_signature,'{}','{}');
 IF NOT private.awardping_current_basic_source_ready(sid,'gaither',e,ref) THEN RAISE EXCEPTION 'Exact accepted owner-pending source rejected';END IF;count_checks:=count_checks+1;
 BEGIN
  UPDATE public.shared_award_visual_review_candidates SET ai_result='{}' WHERE id=cid;
  IF private.awardping_current_basic_source_ready(sid,'gaither',e,ref) THEN RAISE EXCEPTION 'Intermediate recovery without accepted revalidation became current';END IF;
  RAISE EXCEPTION 'ROLLBACK ONLY incomplete revalidation simulation' USING ERRCODE='P0099';EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;END;count_checks:=count_checks+1;
 BEGIN
  UPDATE public.program_text_alert_reviews SET content_hash=repeat('f',64) WHERE id=cid;
  IF private.awardping_current_basic_source_ready(sid,'gaither',e,ref) THEN RAISE EXCEPTION 'Stale owner-review hash became current';END IF;
  RAISE EXCEPTION 'ROLLBACK ONLY stale owner proof simulation' USING ERRCODE='P0099';EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;END;count_checks:=count_checks+1;
 result:=public.attest_program_basic_repeat('gaither',ref,rep,clock_timestamp(),'ROLLBACK ONLY cold-retention boundary simulation');repeat_id:=(result->>'id')::uuid;
 v:=jsonb_set(v,'{current_source_proofs}',jsonb_build_array(jsonb_build_object('source_id',sid,'repeat_observation_id',repeat_id,'pending_alert_review_id',cid,'pending_alert_review_hash',pending_hash)));
 IF NOT private.awardping_current_basic_validation_valid(v) OR private.awardping_program_fact_validation_valid(v,false) THEN RAISE EXCEPTION 'Separate current-basic validation boundary failed';END IF;count_checks:=count_checks+1;
 FOREACH name IN ARRAY ARRAY['update','delete','truncate'] LOOP
  failed:=false;BEGIN
   IF name='update' THEN UPDATE public.program_basic_repeat_observations SET actor='tampered' WHERE id=repeat_id;
   ELSIF name='delete' THEN DELETE FROM public.program_basic_repeat_observations WHERE id=repeat_id;
   ELSE TRUNCATE public.program_basic_repeat_observations;END IF;
  EXCEPTION WHEN check_violation THEN failed:=true;END;IF NOT failed THEN RAISE EXCEPTION 'Repeat ledger mutation accepted: %',name;END IF;count_checks:=count_checks+1;
 END LOOP;
 failed:=false;BEGIN PERFORM public.save_current_program_basic_fact_review(jsonb_set(v,'{current_source_proofs,0,repeat_observation_id}',to_jsonb(gen_random_uuid())),'ROLLBACK ONLY');EXCEPTION WHEN check_violation THEN failed:=true;END;IF NOT failed THEN RAISE EXCEPTION 'Caller-forged repeat ledger accepted';END IF;count_checks:=count_checks+1;
 failed:=false;BEGIN PERFORM public.save_current_program_basic_fact_review(jsonb_set(v,'{review,epoch}',to_jsonb(gen_random_uuid())),'ROLLBACK ONLY');EXCEPTION WHEN check_violation THEN failed:=true;END;IF NOT failed THEN RAISE EXCEPTION 'Stale epoch accepted';END IF;count_checks:=count_checks+1;
 failed:=false;BEGIN PERFORM public.save_current_program_basic_fact_review(jsonb_set(v,'{source_text,0,blocks,0,text}','"forged"'),'ROLLBACK ONLY');EXCEPTION WHEN check_violation THEN failed:=true;END;IF NOT failed THEN RAISE EXCEPTION 'Changed block accepted';END IF;count_checks:=count_checks+1;
 BEGIN
  UPDATE public.shared_award_sources SET url=url||'?identity-drift' WHERE id=sid;
  IF private.awardping_current_basic_validation_valid(v) THEN RAISE EXCEPTION 'Source URL authority drift accepted';END IF;
  RAISE EXCEPTION 'ROLLBACK ONLY identity drift simulation' USING ERRCODE='P0099';EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;END;count_checks:=count_checks+1;
 sv:=public.save_current_program_basic_fact_review(v,'ROLLBACK ONLY synthetic review');draft_id:=(sv->>'id')::uuid;draft_hash:=sv->>'content_hash';
 review_at:=to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
 receipt:=jsonb_build_object('schema','awardping.current-basic-award-fact-review.v1','cohort_key','gaither','award_id',owner,'epoch',e,'cycle',v#>'{review,cycle}',
 'input_review_id',draft_id,'input_review_hash',draft_hash,'selected_fields','["overview"]'::jsonb,'reviewed_at',review_at,'roster',v#>'{review,roster}',
 'supporting_capture_refs',v#>'{review,capture_refs}','current_capture_refs',v#>'{review,capture_refs}','public_facts',private.awardping_basic_fact_selection(v,'["overview"]'),'current_source_proofs',v->'current_source_proofs');
 rh:=encode(extensions.digest(convert_to(private.monitoring_feedback_canonical_json(receipt),'UTF8'),'sha256'),'hex');SELECT snapshot_id INTO head FROM public.program_basic_fact_heads WHERE cohort_key='gaither';
 failed:=false;BEGIN PERFORM public.commit_current_program_basic_facts(draft_id,draft_hash,gen_random_uuid(),receipt,rh,repeat('d',64));EXCEPTION WHEN serialization_failure THEN failed:=true;END;IF NOT failed THEN RAISE EXCEPTION 'Wrong head CAS accepted';END IF;count_checks:=count_checks+1;
 failed:=false;BEGIN PERFORM public.commit_current_program_basic_facts(draft_id,draft_hash,head,jsonb_set(receipt,'{public_facts,overview}','"forged"'),rh,repeat('d',64));EXCEPTION WHEN check_violation THEN failed:=true;END;IF NOT failed THEN RAISE EXCEPTION 'Forged public projection accepted';END IF;count_checks:=count_checks+1;
 SELECT count(*) INTO n FROM public.program_basic_fact_snapshots;
 CREATE OR REPLACE FUNCTION pg_temp.fail_basic_head() RETURNS trigger LANGUAGE plpgsql AS 'begin raise exception ''ROLLBACK ONLY forced late failure'' using errcode=''23514'';end';
 CREATE TRIGGER rollback_basic_atomicity BEFORE UPDATE ON public.program_basic_fact_heads FOR EACH ROW EXECUTE FUNCTION pg_temp.fail_basic_head();
 failed:=false;BEGIN PERFORM public.commit_current_program_basic_facts(draft_id,draft_hash,head,receipt,rh,repeat('d',64));EXCEPTION WHEN check_violation THEN failed:=true;END;
 IF NOT failed OR (SELECT count(*) FROM public.program_basic_fact_snapshots)<>n OR (SELECT snapshot_id FROM public.program_basic_fact_heads WHERE cohort_key='gaither')<>head THEN RAISE EXCEPTION 'Late failure left a partial snapshot/head';END IF;count_checks:=count_checks+1;
 DROP TRIGGER rollback_basic_atomicity ON public.program_basic_fact_heads;
 result:=public.commit_current_program_basic_facts(draft_id,draft_hash,head,receipt,rh,repeat('d',64));
 IF result->>'ok'<>'true' OR NOT private.awardping_basic_fact_current((result->>'snapshot_id')::uuid) THEN RAISE EXCEPTION 'Independent current snapshot is not current';END IF;count_checks:=count_checks+1;
 IF public.commit_current_program_basic_facts(draft_id,draft_hash,head,receipt,rh,repeat('d',64))->>'already_applied'<>'true' THEN RAISE EXCEPTION 'Identical replay not recognized';END IF;count_checks:=count_checks+1;
 -- A normal owner dismissal of this same exact content must not erase the basic snapshot.
 BEGIN
  UPDATE public.program_text_alert_reviews SET status='dismissed',reviewed_at=clock_timestamp(),reviewed_by=(SELECT id FROM auth.users ORDER BY created_at LIMIT 1) WHERE id=cid;
  UPDATE public.shared_award_visual_review_candidates SET status='rejected',rejection_reason='admin_dismissed_program_change' WHERE id=cid;
  UPDATE public.shared_award_sources SET text_monitoring_state=state||jsonb_build_object('status','baseline_ready','baseline_ref',ref) WHERE id=sid;
  IF NOT private.awardping_basic_fact_current((result->>'snapshot_id')::uuid) THEN RAISE EXCEPTION 'Same-content owner decision erased independent basics';END IF;
  RAISE EXCEPTION 'ROLLBACK ONLY decision simulation' USING ERRCODE='P0099';EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;END;count_checks:=count_checks+1;
 BEGIN
  UPDATE public.shared_award_sources SET text_monitoring_state=jsonb_set(state,'{latest_ref,text_sha256}',to_jsonb(repeat('f',64))) WHERE id=sid;
  IF private.awardping_basic_fact_current((result->>'snapshot_id')::uuid) THEN RAISE EXCEPTION 'Changed current content preserved snapshot';END IF;
  RAISE EXCEPTION 'ROLLBACK ONLY changed-content simulation' USING ERRCODE='P0099';EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;END;count_checks:=count_checks+1;
 IF (SELECT count(*) FROM public.shared_award_change_events)<>before_events OR (SELECT count(*) FROM public.public_digest_outbox)<>before_outbox
 OR (SELECT count(*) FROM public.program_text_alert_reviews)<>before_alerts+1 OR (SELECT text_monitoring_state FROM public.shared_award_sources WHERE id=sid)<>state
 OR (SELECT status FROM public.program_text_alert_reviews WHERE id=cid)<>'pending' THEN RAISE EXCEPTION 'Basic path changed outgoing alerts or source baseline';END IF;count_checks:=count_checks+1;
 DELETE FROM public.program_text_source_roster WHERE cohort_key='gaither';
 INSERT INTO public.program_text_source_roster(cohort_key,source_role,source_ids,evidence,revision,reviewed_by,reviewed_at)
 SELECT cohort_key,source_role,source_ids,evidence,revision,reviewed_by,reviewed_at FROM current_basic_before_roster;
 IF EXISTS(SELECT 1 FROM current_basic_before_heads b WHERE private.awardping_basic_fact_current(b.snapshot_id) IS DISTINCT FROM b.current) THEN RAISE EXCEPTION 'Original 23 snapshot getters regressed';END IF;count_checks:=count_checks+1;
 IF private.awardping_basic_fact_current((result->>'snapshot_id')::uuid) THEN RAISE EXCEPTION 'Stale source inventory preserved current basics';END IF;count_checks:=count_checks+1;
 INSERT INTO current_basic_fixture_result VALUES(jsonb_build_object('ok',true,'checks',count_checks,'original_current_heads',23,'synthetic_fixture_only',true,'all_mutations','ROLLBACK'));
 END;$fixture$;
SELECT result FROM current_basic_fixture_result;
ROLLBACK;
`;
}
