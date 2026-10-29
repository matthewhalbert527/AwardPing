import {describe,it,expect,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {parse} from 'libpg-query';
import {buildProgramTextCapture} from './program-text-capture-contract.mjs';
import {programTextReference} from './program-text-artifacts.mjs';
import {emptyProgramFactReview,validateCurrentBasicFactReview,validateProgramFactReview} from './program-text-facts.mjs';
import {CURRENT_BASIC_VALIDATION_SCHEMA,CURRENT_BASIC_RECEIPT_SCHEMA,currentBasicContentIdentity,prepareCurrentBasicRepeat} from './current-basic-source-proof.mjs';
import {prepareBasicFactPublication,publishBasicFactPublication,createCurrentBasicPublicationRpcAdapter} from './basic-award-publication.mjs';

const epoch='33333333-3333-4333-8333-333333333333',rid='44444444-4444-4444-8444-444444444444',draftId='55555555-5555-4555-8555-555555555555',pendingId='66666666-6666-4666-8666-666666666666',at='2026-10-29T20:00:00.000Z';
function fixture(pending=false){
 const source={id:'11111111-1111-4111-8111-111111111111',shared_award_id:'22222222-2222-4222-8222-222222222222',url:'https://example.org/award',title:'Example Award',page_type:'application',admin_review_status:'open',text_collection_quality:null};
 const text='Example Award supports graduate study. The deadline is January 31, 2027.';
 const make=(captured_at,body=text)=>buildProgramTextCapture({source,acquisition:'http_html',raw_bytes:Buffer.from('<main>'+body+'</main>'),content_type:'text/html',text:body,
  blocks:[{id:'body',text:body,start_utf16:0,end_utf16:body.length}],extractor:{name:'fixture',version:'1'},captured_at});
 const capture=make('2026-10-29T18:00:00.000Z'),repeat=make('2026-10-29T19:00:00.000Z'),old=make('2026-10-28T18:00:00.000Z','Example Award previously supported study.');
 const ref=programTextReference(capture),repeatRef=programTextReference(repeat),oldRef=programTextReference(old);
 source.text_monitoring_state={schema:'awardping.program-text-state.v1',epoch,status:pending?'awaiting_review':'baseline_ready',baseline_ref:pending?oldRef:ref,latest_ref:ref,successful_checks:30,first_captured_at:old.captured_at,last_checked_at:ref.captured_at};
 const role={source_role:'application',revision:epoch,source_ids:[source.id],manifest_status:'reviewed_text',evidence:{schema:'awardping.program-text-source-role.v1',source_bindings:{[source.id]:{source_url:source.url,shared_award_id:source.shared_award_id}}}};
 const captures=new Map([capture,repeat,old].map(c=>[c.capture_id,c]));
 const context={registry:{cohort_key:'example',canonical_shared_award_id:source.shared_award_id},roles:[role],sources:[source],memberIds:[source.shared_award_id],epoch,forApproval:false,
  repeat_observation_ids:[{source_id:source.id,id:rid}],repeat_observations:[{id:rid,cohort_key:'example',source_id:source.id,epoch,current_ref:ref,repeat_ref:repeatRef,content_identity:currentBasicContentIdentity(ref),verified_at:at}],
  pending_alert_reviews:pending?[{id:pendingId,candidate_id:pendingId,source_id:source.id,owner_id:source.shared_award_id,source_url:source.url,epoch,candidate_scope:'program_text_change',candidate_status:'succeeded',candidate_signature:'a'.repeat(64),previous_ref:oldRef,current_ref:ref,review_status:'pending',content_hash:'b'.repeat(64),expected_content_hash:'b'.repeat(64)}]:[],
  loadCapture:vi.fn(async r=>captures.get(r.capture_id))};
 const review=emptyProgramFactReview({...context,cycle:'2027'}),quote=value=>({source_id:source.id,capture_id:ref.capture_id,block_id:'body',start_utf16:text.indexOf(value),end_utf16:text.indexOf(value)+value.length,text:value});
 for(const [name,value,support] of [['overview','Example Award supports graduate study.','Example Award supports graduate study.'],['deadline','January 31, 2027','The deadline is January 31, 2027.']])Object.assign(review.fields.find(f=>f.field===name),{status:'verified',items:[{value,track:null,support:[quote(support)]}]});
 return{source,capture,repeat,ref,repeatRef,context,review};
}

describe('separate current-basic purpose with retained current-content repeats',()=>{
 it.each([false,true])('cold-validates the full source set including a separately held owner alert: %s',async pending=>{const f=fixture(pending),v=await validateCurrentBasicFactReview(f.review,f.context);expect(v.schema).toBe(CURRENT_BASIC_VALIDATION_SCHEMA);expect(v.current_source_proofs).toEqual([{source_id:f.source.id,repeat_observation_id:rid,pending_alert_review_id:pending?pendingId:null,pending_alert_review_hash:pending?'b'.repeat(64):null}]);expect(f.context.loadCapture).toHaveBeenCalledTimes(2);expect(f.source.text_monitoring_state.status).toBe(pending?'awaiting_review':'baseline_ready');expect(f.review.reviewed_all_sources).toBe(false);});
 it('keeps the full legacy approval path strict',async()=>{const f=fixture(true);await expect(validateProgramFactReview(f.review,f.context)).rejects.toThrow('source_not_current');await expect(validateCurrentBasicFactReview(f.review,{...f.context,forApproval:true})).rejects.toThrow('not_full_approval');});
 it.each([
  f=>{f.context.pending_alert_reviews=[];},f=>{f.context.pending_alert_reviews[0].candidate_status='failed';},f=>{f.context.pending_alert_reviews[0].review_status='approved';},
  f=>{f.context.pending_alert_reviews[0].expected_content_hash='c'.repeat(64);},f=>{f.context.pending_alert_reviews[0].current_ref=f.repeatRef;},f=>{f.context.pending_alert_reviews[0].owner_id=epoch;},
  f=>{f.context.pending_alert_reviews[0].source_url+='?other';},f=>{f.context.pending_alert_reviews[0].epoch=pendingId;},f=>{f.context.pending_alert_reviews.push(f.context.pending_alert_reviews[0]);},
  f=>{f.source.text_monitoring_state.status='held';},f=>{f.source.text_collection_quality=undefined;},f=>{f.context.roles[0].manifest_status='review_pending';},
  f=>{f.context.repeat_observation_ids=[];},f=>{f.context.repeat_observation_ids.push(f.context.repeat_observation_ids[0]);},f=>{f.context.repeat_observations=[];},
  f=>{f.context.repeat_observations[0].cohort_key='other';},f=>{f.context.repeat_observations[0].epoch=pendingId;},f=>{f.context.repeat_observations[0].repeat_ref=f.ref;},
  f=>{f.context.repeat_observations[0].content_identity.text_sha256='c'.repeat(64);},f=>{f.context.repeat_observations[0].verified_at='2020-01-01T00:00:00.000Z';},
  f=>{f.review.capture_refs=[];},f=>{f.review.fields[0].items[0].support[0].text+=' fabricated';},
  f=>{f.review.fields.find(x=>x.field==='contacts').status='not_published';},f=>{f.review.reviewed_all_sources=true;},
 ])('rejects failed/stale/foreign/omitted evidence %#',async mutate=>{const f=fixture(true);mutate(f);await expect(validateCurrentBasicFactReview(f.review,f.context)).rejects.toThrow();});
 it.each(['current','repeat'])('rejects changed retained originals: %s',async which=>{const f=fixture(),original=f.context.loadCapture;f.context.loadCapture=async r=>{const c=await original(r);return r.capture_id===(which==='current'?f.ref:f.repeatRef).capture_id?{...c,text:c.text+' changed'}:c;};await expect(validateCurrentBasicFactReview(f.review,f.context)).rejects.toThrow();});
 it('prepares a ledger request only after cold-validating both independent originals',async()=>{const f=fixture(true),p=await prepareCurrentBasicRepeat({current_ref:f.ref,repeat_ref:f.repeatRef,verified_at:at},f.context);expect(p.p_repeat_document.text).toBe(f.repeat.text);expect(f.context.loadCapture).toHaveBeenCalledTimes(2);expect(Object.keys(p)).toEqual(['p_cohort_key','p_current_ref','p_repeat_document','p_verified_at']);});
 it('rejects lifetime count alone, same observation and an attestation preceding the captures',async()=>{const f=fixture();await expect(prepareCurrentBasicRepeat({current_ref:f.ref,repeat_ref:f.ref,verified_at:at},f.context)).rejects.toThrow();await expect(prepareCurrentBasicRepeat({current_ref:f.ref,repeat_ref:f.repeatRef,verified_at:'2026-10-29T17:00:00.000Z'},f.context)).rejects.toThrow('precedes_capture');});
 it('prepares and cold-rechecks one independent snapshot without deciding the outgoing alert',async()=>{const f=fixture(true),validation=await validateCurrentBasicFactReview(f.review,f.context),draft={id:draftId,content_hash:'d'.repeat(64),validation};
  const deps={inspect:vi.fn(async()=>({schema:'awardping.basic-fact-draft-context.v1',draft,context:f.context,head_id:null})),loadCapture:f.context.loadCapture,commit:vi.fn(async()=>({ok:true,snapshot_id:rid,already_applied:false,kind:'automated_source_verified_basics'})),now:()=>Date.parse(at)+1000};
  const p=await prepareBasicFactPublication({draft_id:draftId,selected_fields:['overview','deadline'],reviewed_at:at},deps);expect(p.plan.receipt.schema).toBe(CURRENT_BASIC_RECEIPT_SCHEMA);expect(p.public_preview.deadline).toBe('January 31, 2027');await publishBasicFactPublication(p.plan,p.plan_hash,deps);expect(deps.commit).toHaveBeenCalledOnce();expect(f.source.text_monitoring_state.status).toBe('awaiting_review');expect(f.context.pending_alert_reviews[0].review_status).toBe('pending');});
 it('exposes only new service inspect/CAS RPCs through explicit opt-in',async()=>{const rpc=vi.fn(async()=>({data:{ok:true},error:null})),a=createCurrentBasicPublicationRpcAdapter({rpc},async()=>{});await a.inspect(draftId);await a.commit({});expect(rpc.mock.calls.map(x=>x[0])).toEqual(['inspect_current_basic_fact_draft','commit_current_program_basic_facts']);});
});

describe('service-only current-basic migration boundary',()=>{
 const sql=readFileSync(new URL('../../supabase/migrations/20261029192859_current_capture_basic_facts.sql',import.meta.url),'utf8');
 it('parses the complete additive migration',async()=>{expect((await parse(sql)).stmts.length).toBeGreaterThan(20);});
 it('retains the exact legacy getter implementation behind schema dispatch',()=>{const old=readFileSync(new URL('../../supabase/migrations/20261029162139_program_basic_fact_publication.sql',import.meta.url),'utf8').replace(/\r\n/g,'\n');const extract=(s,name)=>{const start=s.indexOf('function private.'+name+'('),body=s.indexOf('as $$',start),end=s.indexOf('$$;',body+5);return s.slice(body,end+3);};expect(extract(sql,'awardping_basic_fact_current_v1')).toBe(extract(old,'awardping_basic_fact_current'));});
 it('does not redefine legacy full review/approval/publication or write alerts/baselines/spend',()=>{expect(sql).not.toMatch(/(?:create|replace) function (?:private\.awardping_program_fact_validation_valid|public\.(?:save_program_fact_review|approve_program_fact_review|commit_program_basic_facts))\(/i);expect(sql).not.toMatch(/(?:update|insert into|delete from) public\.(?:shared_award_sources|program_text_alert_reviews|shared_award_visual_review_candidates|shared_award_change_events|notification_outbox|gemini_spend_\w+)\b/i);expect(sql).not.toContain('set_config(');});
 it('requires independent ledger proofs and binds the manual owner review without approving it',()=>{for(const value of ['before truncate','retained_repeat','program_basic_repeat_observations','pending_alert_review_hash',"r.status='pending'","c.status='succeeded'",'private.program_text_alert_hash','current_basic_is_not_full_approval'])if(value==='current_basic_is_not_full_approval')expect(sql).toContain("reviewed_all_sources' is distinct from 'false'");else if(value!=='retained_repeat')expect(sql).toContain(value);expect(sql).toContain('limit 8');expect(sql).toContain('to service_role');expect(sql).toContain('from public,anon,authenticated,service_role');});
});
