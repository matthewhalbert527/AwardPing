import {describe,it,expect,vi} from 'vitest';
import {buildProgramTextCapture} from './program-text-capture-contract.mjs';
import {programTextReference} from './program-text-artifacts.mjs';
import {buildProgramTextComparison,buildProgramTextReviewPackets} from './program-text-review.mjs';
import {emptyProgramFactReview,validateCurrentBasicFactReview} from './program-text-facts.mjs';
import {prepareCurrentBasicRepeat} from './current-basic-source-proof.mjs';
import {programTextDeterministicNoChange} from './program-text-deterministic-no-change.mjs';
import {prepareBasicFactPublication} from './basic-award-publication.mjs';
import {REVIEWED_BASIC_REPEAT_KIND as kind,REVIEWED_BASIC_REPEAT_INSPECTION_SCHEMA,REVIEWED_BASIC_CANDIDATE_KEYS,prepareCurrentBasicReviewedRepeat,reviewedBasicCandidateSnapshot,reviewedBasicHash,reviewedBasicSupportProjection,validateCurrentBasicReviewedRepeatEvidence,reviewedBasicDeterministicRules,prepareBasicContinuity,basicContinuityPair,BASIC_CONTINUITY_ACTOR} from './current-basic-reviewed-repeat.mjs';
import {createProgramTextRepository,listBasicContinuityWork} from './program-text-repository.mjs';
import {review as runOrdinaryReview} from '../program-text-worker.mjs';

function continuityFixture({anchorLabel='URL',previousLabel='Company',currentLabel='LinkedIn',anchorBody=sentence,currentBody=sentence,visible=false,identical=false,emailChange=false}={}){
 const source={id:'f322a07c-f78c-47fd-aafb-ab6422a4248f',shared_award_id:'dd23afbb-299e-489f-8a0b-e4d7506848de',url:'https://www.schwarzmanscholars.org/admissions/application-instructions/',title:'Application Instructions',page_type:'application',admin_review_status:'open',text_collection_quality:null};
 const make=(label,date,body=sentence)=>{
  const prompt=label+' This field is for validation purposes and should be left unchanged.';
  const href=encoded('admissions@schwarzmanscholars.org',date.includes('20:00:')?3:41);
  const raw='<html><body><p>'+body+'</p><div id="gform_wrapper_5" style="display:'+(visible?'block':'none')+'"><form id="gform_5" method="post" data-formid="5" action="/admissions/application-instructions/#gf_5" target="gform_ajax_frame_5"><ul id="gform_fields_5"><li id="field_5_10" class="gfield gfield--type-honeypot gform_validation_container"><label id="gfield_label_5_10" for="input_5_10"><span class="gform-field-label__text">'+label+'</span></label><div><input name="input_10" id="input_5_10" type="text" value="" autocomplete="new-password"/></div><div class="gfield_description" id="gfield_description_5_10">This field is for validation purposes and should be left unchanged.</div></li></ul><input type="hidden" name="state_5" value="runtime-'+date+'"/></form></div>'+(emailChange?'<a href="'+href+'">Contact</a>':'')+'</body></html>';
  let text=body+'\n'+prompt;
  const blocks=[{id:'body',kind:'p',heading:'Program',context:{heading_path:[{level:1,text:'Program'}]},text:body,start_utf16:0,end_utf16:body.length},{id:'hidden',kind:'li',heading:'Stay Connected',context:{heading_path:[{level:3,text:'Stay Connected'}]},text:prompt,start_utf16:body.length+1,end_utf16:text.length}];
  if(emailChange){text+='\n'+href;blocks.push({id:'email',kind:'source_link',heading:'Contact',context:{source_attribute:'href',link_text:'Contact'},text:href,start_utf16:text.length-href.length,end_utf16:text.length});}
  return buildProgramTextCapture({source,captured_at:date,acquisition:'http_html',extractor:{name:'fixture',version:'1'},content_type:'text/html',raw_bytes:Buffer.from(raw),text,blocks});
 };
 const anchor=make(anchorLabel,'2026-10-31T20:00:00.000Z',anchorBody),previous=make(previousLabel,'2026-10-31T20:01:00.000Z',currentBody),current=make(identical?anchorLabel:currentLabel,'2026-10-31T20:02:00.000Z',currentBody),ref=programTextReference(current),anchorRef=programTextReference(anchor);
 source.text_monitoring_state={schema:'awardping.program-text-state.v1',epoch,status:'baseline_ready',baseline_ref:ref,latest_ref:ref,successful_checks:8,first_captured_at:anchor.captured_at,last_checked_at:current.captured_at};
 const role={source_role:'application',revision:epoch,source_ids:[source.id],manifest_status:'reviewed_text',evidence:{schema:'awardping.program-text-source-role.v1',source_bindings:{[source.id]:{source_url:source.url,shared_award_id:source.shared_award_id}}}};
 const context={registry:{cohort_key:'schwarzman',canonical_shared_award_id:source.shared_award_id},roles:[role],sources:[source],memberIds:[source.shared_award_id],epoch,pending_alert_reviews:[]};
 const approved=emptyProgramFactReview({...context,cycle:'2027'});approved.capture_refs=[anchorRef];
 Object.assign(approved.fields.find(f=>f.field==='overview'),{status:'verified',items:[{value:'Example Award supports graduate study.',track:null,support:[{source_id:source.id,capture_id:anchor.capture_id,block_id:'body',start_utf16:0,end_utf16:37,text:anchor.text.slice(0,37)}]}]});
 const comparison=buildProgramTextComparison(previous,current,{epoch,cycle_id:null}),plan=buildProgramTextReviewPackets(comparison);
 const responses=plan.packets.map(p=>({schema:'awardping.program-text-review.v1',comparison_id:comparison.comparison_id,packet_id:p.packet_id,...comparison.context,blocks:p.blocks.map(b=>({id:b.id,disposition:'no_program_change',reason:'Hidden anti-spam prompt rotated.',changes:[]}))}));
 const candidate={...Object.fromEntries(REVIEWED_BASIC_CANDIDATE_KEYS.map(k=>[k,null])),id:candidateId,shared_award_id:source.shared_award_id,shared_award_source_id:source.id,source_url:source.url,candidate_scope:'program_text_change',status:'rejected',rejection_reason:'no_program_change',candidate_signature:comparison.comparison_id,previous_snapshot_ref:programTextReference(previous),new_snapshot_ref:ref,worker_metadata:{epoch,monitoring_contract:'program-text-v1',evidence_signature:comparison.comparison_id,gemini_spend_reservation_id:reservationId,gemini_spend_attempt_token:attempt,provider_request_keys:plan.packets.map(p=>p.packet_id)},prompt_payload:{comparison,packet_plan:plan},ai_result:{responses,program_text_validation:{status:'no_program_change',comparison_id:comparison.comparison_id,reasons:[],changes:[]}},model:'gemini-fixture',gemini_batch_name:'batches/fixture',submitted_at:'2026-10-31T20:02:01.000Z',completed_at:'2026-10-31T20:03:00.000Z',actual_usage:{}};
 const paid={id:reservationId,status:'settled',attempt_token:attempt,model:candidate.model,provider_batch_name:candidate.gemini_batch_name,lane_key:'changed_page_review',worker_source:'program-text-review',metadata:{candidate_id:candidateId,monitoring_contract:'program-text-v1'},work_fingerprint:`program-text:${candidate.candidate_signature}:${candidate.model}`,request_count:plan.packets.length,settled_at:'2026-10-31T20:02:59.000Z',spent_source:'bounded-provider-settlement'};
 const inspection={schema:'awardping.program-basic-continuity-inspection.v1',status:'ready',cohort_key:'schwarzman',source_id:source.id,epoch,expected_head:head,snapshot_hash:'a'.repeat(64),input_review_hash:'b'.repeat(64),source_version:{source_id:source.id,owner_id:source.shared_award_id,url:source.url,epoch},anchor_ref:anchorRef,current_ref:ref,repeat_ref:identical?anchorRef:programTextReference(previous),unchanged_basis:null,approved_review:approved,selected_fields:['overview'],context,candidate:identical?null:candidate,candidate_hash:identical?null:reviewedBasicHash(candidate),paid_reservation:identical?null:paid};
 const captures=new Map([anchor,previous,current].map(c=>[c.capture_id,c])),loadCapture=vi.fn(async r=>captures.get(r.capture_id));
 return{inspection,source,anchor,previous,current,candidate,paid,loadCapture};
}

describe('head-preserving basic technical continuity',()=>{
 it('proves the real normal pair and approved anchor directly without changing approval/facts/dates',async()=>{
  const f=continuityFixture(),before=JSON.stringify(f.inspection),v=(await prepareBasicContinuity(f.inspection,{loadCapture:f.loadCapture})).p_validation;
  expect(v.actor).toBe(BASIC_CONTINUITY_ACTOR);expect(v.kind).toBe('ordinary_no_program_change');expect(v.expected_head).toBe(head);
  expect(v.anchor_document.reference.capture_id).toBe(f.anchor.capture_id);expect(v.previous_document.reference.capture_id).toBe(f.previous.capture_id);
  expect(v.support_projection[0].repeat_quote.capture_id).toBe(f.anchor.capture_id);expect(v.normal_validation.candidate_id).toBe(candidateId);
  expect(f.loadCapture).toHaveBeenCalledTimes(3);expect(JSON.stringify(f.inspection)).toBe(before);
  expect(Object.hasOwn(v,'public_facts')).toBe(false);expect(Object.hasOwn(v,'reviewed_at')).toBe(false);
 });
 it('also binds a second independent rotation to the SAME approved anchor, without chained proof authority',async()=>{
  const first=continuityFixture(),second=continuityFixture({previousLabel:'LinkedIn',currentLabel:'Instagram'});
  const a=(await prepareBasicContinuity(first.inspection,{loadCapture:first.loadCapture})).p_validation,b=(await prepareBasicContinuity(second.inspection,{loadCapture:second.loadCapture})).p_validation;
  expect(a.expected_head).toBe(b.expected_head);expect(a.anchor_document.reference).toEqual(b.anchor_document.reference);
  expect(a.current_document.reference.text_sha256).not.toBe(b.current_document.reference.text_sha256);
  expect(a.support_projection.map(x=>x.value)).toEqual(b.support_projection.map(x=>x.value));
 });
 it('uses truthful independent unchanged-capture provenance without a fake candidate',async()=>{
  const f=continuityFixture({identical:true}),v=(await prepareBasicContinuity(f.inspection,{loadCapture:f.loadCapture})).p_validation;
  expect(v.kind).toBe('ordinary_unchanged');expect(v.normal_validation).toBeNull();expect(v.previous_document.reference).toEqual(v.anchor_ref);expect(v.anchor_pair.identity_markers).toHaveLength(1);
  expect(v.anchor_ref.artifacts.raw.sha256).not.toBe(v.current_ref.artifacts.raw.sha256);
 });
 it('preserves continuity for an identical recapture after a prior approved noise observation without chaining authority',async()=>{
  const f=continuityFixture({previousLabel:'LinkedIn',currentLabel:'LinkedIn'}),i=f.inspection;
  i.candidate=null;i.candidate_hash=null;i.paid_reservation=null;i.repeat_ref=programTextReference(f.previous);
  i.unchanged_basis={observation_id:observationId,content_hash:'c'.repeat(64),repeat_ref:i.repeat_ref};
  const v=(await prepareBasicContinuity(i,{loadCapture:f.loadCapture})).p_validation;
  expect(v.kind).toBe('ordinary_unchanged');expect(v.anchor_pair.mode).toBe('profiled_ancillary_change');
  expect(v.anchor_document.reference.capture_id).toBe(f.anchor.capture_id);expect(v.previous_document.reference.capture_id).toBe(f.previous.capture_id);
  expect(v.current_document.reference.capture_id).toBe(f.current.capture_id);expect(v.normal_validation).toBeNull();
 });
 it('still validates the exact hidden witness when only protected-email encoding rotates from the approved anchor',async()=>{
  const f=continuityFixture({currentLabel:'URL',emailChange:true}),v=(await prepareBasicContinuity(f.inspection,{loadCapture:f.loadCapture})).p_validation;
  expect(v.anchor_pair.rules.map(r=>r.kind)).toEqual(['identical_protected_email_destination']);expect(v.anchor_pair.identity_markers).toHaveLength(1);
 });
 it.each([
  ['earlier real eligibility change',()=>continuityFixture({anchorBody:sentence+' Only citizens qualify.'})],
  ['new real deadline',()=>continuityFixture({currentBody:sentence.replace('January 31','February 1')})],
  ['visible hidden field',()=>continuityFixture({visible:true})],
  ['unknown prompt',()=>continuityFixture({currentLabel:'Application Deadline'})],
 ])('holds %s even when the latest ordinary candidate claims no change',async(name,make)=>{const f=make();await expect(prepareBasicContinuity(f.inspection,{loadCapture:f.loadCapture})).rejects.toThrow();});
 it.each([
  ['source owner',f=>{f.inspection.source_version.owner_id=head;}],['epoch',f=>{f.inspection.epoch=head;}],
  ['roster revision',f=>{f.inspection.context.roles[0].revision=head;}],['pending owner alert',f=>{f.source.text_monitoring_state.status='awaiting_review';}],
  ['failed provider',f=>{f.paid.status='failed';}],['changed candidate',f=>{f.candidate.status='failed';}],
  ['unknown cohort',f=>{f.inspection.cohort_key='other';}],['unselected facts',f=>{f.inspection.selected_fields.push('nomination');}],
  ['incomplete original',f=>{f.current.completeness={status:'incomplete',reasons:['missing_text']};}],
 ])('refuses stale/unsupported %s',async(name,edit)=>{const f=continuityFixture();edit(f);await expect(prepareBasicContinuity(f.inspection,{loadCapture:f.loadCapture})).rejects.toThrow();});
 it('does not let a text-identical newly visible field borrow approval',()=>{
  const f=continuityFixture({visible:true,identical:true});expect(()=>basicContinuityPair(f.anchor,f.current,{epoch,cohort_key:'schwarzman'})).toThrow();
 });
 it('recovers a committed but lost response by readback without a second write',async()=>{
  const f=continuityFixture();let writes=0,reads=0;
  const db={rpc:vi.fn(async name=>{
   if(name==='inspect_program_basic_continuity')return{data:++reads===1?f.inspection:{schema:f.inspection.schema,source_id:f.source.id,status:'skipped',reason:'already_current',expected_head:head,current_ref:f.inspection.current_ref}};
   if(name==='attest_program_basic_continuity'){writes++;return{error:{code:'transport'}};}
   throw Error('Unexpected operation');
  })};
  const repo=createProgramTextRepository(db,{loadCapture:f.loadCapture});
  expect(await repo.reconcileBasicContinuity(f.source.id)).toEqual({source_id:f.source.id,status:'current',already_applied:true});expect(writes).toBe(1);expect(reads).toBe(2);
 });
 it('skips an already-proved source before cold reading and never touches an unreviewed source',async()=>{
  const cold=vi.fn(),db={rpc:vi.fn(async()=>({data:{schema:'awardping.program-basic-continuity-inspection.v1',source_id:'f322a07c-f78c-47fd-aafb-ab6422a4248f',status:'skipped',reason:'already_current'}}))},repo=createProgramTextRepository(db,{loadCapture:cold});
  expect((await repo.reconcileBasicContinuity('f322a07c-f78c-47fd-aafb-ab6422a4248f')).status).toBe('skipped');expect((await repo.reconcileBasicContinuity(head)).status).toBe('skipped');expect(db.rpc).toHaveBeenCalledTimes(1);expect(cold).not.toHaveBeenCalled();
 });
 it('does not confirm an uncertain mutation from a different concurrent head',async()=>{
  const f=continuityFixture();let reads=0,writes=0;
  const db={rpc:async name=>name==='attest_program_basic_continuity'?(writes++,{error:{code:'transport'}}):{data:++reads===1?f.inspection:{schema:f.inspection.schema,source_id:f.source.id,status:'skipped',reason:'already_current',expected_head:candidateId,current_ref:f.inspection.current_ref}}};
  const repo=createProgramTextRepository(db,{loadCapture:f.loadCapture});expect((await repo.reconcileBasicContinuity(f.source.id)).status).toBe('held');expect(writes).toBe(1);
 });
 it('limits durable recovery to seven actual profile identities and the requested epoch/scope',async()=>{
  const id='f322a07c-f78c-47fd-aafb-ab6422a4248f',db={rpc:async()=>({data:{schema:'awardping.program-basic-continuity-work.v1',sources:[{source_id:id,epoch}]}})};
  expect(await listBasicContinuityWork(db,{epoch})).toHaveLength(1);expect(await listBasicContinuityWork(db,{epoch:head})).toEqual([]);
  await expect(listBasicContinuityWork({rpc:async()=>({data:{schema:'awardping.program-basic-continuity-work.v1',sources:[{source_id:head,epoch}]}})})).rejects.toThrow();
 });
 it('hooks the actual ordinary review only AFTER baseline CAS and terminal rejection, preserving the approved head across two cycles',async()=>{
  const facts={head,verified_at:'2026-10-31T19:00:00.000Z',values:{overview:'Example Award supports graduate study.'}},before=structuredClone(facts),events=[];
  for(const labels of [['Company','LinkedIn'],['LinkedIn','Instagram']]){
   const f=continuityFixture({previousLabel:labels[0],currentLabel:labels[1]}),order=[];
   f.source.text_monitoring_state={...f.source.text_monitoring_state,status:'awaiting_review',baseline_ref:programTextReference(f.previous)};
   const row={...structuredClone(f.candidate),status:'succeeded'};
   const rpc={rpc:async(name,args)=>{
    if(name==='inspect_program_basic_continuity'){expect(f.candidate.status).toBe('rejected');expect(f.source.text_monitoring_state.status).toBe('baseline_ready');order.push('inspect');return{data:f.inspection};}
    if(name==='attest_program_basic_continuity'){expect(args.p_validation.expected_head).toBe(facts.head);order.push('attest');events.push({kind:'technical_continuity',head:args.p_validation.expected_head});return{data:{ok:true,id:observationId,already_applied:false}};}
    throw Error('No other database operation allowed');
   }};
   const technical=createProgramTextRepository(rpc,{loadCapture:f.loadCapture}),repository={listCandidates:async()=>[row],verifyCandidate:async()=>{},
    recordReviewResult:async()=>{order.push('saved_validation');return true;},finishNoChange:async()=>{order.push('rejected');f.candidate.status='rejected';return true;},
    reconcileBasicContinuity:technical.reconcileBasicContinuity};
   const callbacks={loadCapture:f.loadCapture,readState:async()=>f.source.text_monitoring_state,
    compareAndSetState:async({expected_state,next_state})=>{expect(f.source.text_monitoring_state).toEqual(expected_state);order.push('baseline');f.source.text_monitoring_state=next_state;return next_state;},
    publishProgramChange:()=>{throw Error('No alert publication permitted');}};
   const result=await runOrdinaryReview(repository,{},callbacks,1,{source_ids:[f.source.id],epoch});
   expect(result[0].status).toBe('no_program_change');expect(order).toEqual(['saved_validation','baseline','rejected','inspect','attest']);
  }
  expect(events).toHaveLength(2);expect(events.every(e=>e.kind==='technical_continuity')).toBe(true);expect(facts).toEqual(before);
 });
});

const epoch='33333333-3333-4333-8333-333333333333',head='44444444-4444-4444-8444-444444444444',candidateId='55555555-5555-4555-8555-555555555555',observationId='66666666-6666-4666-8666-666666666666',reservationId='77777777-7777-4777-8777-777777777777',attempt='88888888-8888-4888-8888-888888888888';
const encoded=(address,key)=>'/cdn-cgi/l/email-protection#'+Buffer.from([key,...[...Buffer.from(address)].map(b=>b^key)]).toString('hex');
const sentence='Example Award supports graduate study. The deadline is January 31, 2027.';
function capture(source,date,href,body=sentence,extra=[],rawOverride){
 const rows=[{id:'body',text:body,kind:'p',heading:'Program',context:{heading_path:[{text:'Program',level:1}]}},{id:'email',text:href,kind:'source_link',heading:'Program > Contact',context:{source_attribute:'href',link_text:'Contact',base_hrefs:[],heading_path:[{text:'Program',level:1}]}} ,...extra];
 let text='';const blocks=rows.map(b=>{if(text)text+='\n';const start=text.length;text+=b.text;return{...b,start_utf16:start,end_utf16:text.length};});
 return buildProgramTextCapture({source,captured_at:date,acquisition:'http_html',extractor:{name:'fixture',version:'1'},content_type:'text/html; charset=utf-8',raw_bytes:Buffer.from(rawOverride??'<html><body><main><p>'+body+'</p><a href="'+href+'">Contact</a></main></body></html>'),text,blocks});
}
function fixture(){
 const source={id:'11111111-1111-4111-8111-111111111111',shared_award_id:'22222222-2222-4222-8222-222222222222',url:'https://example.org/award',title:'Example Award',page_type:'application',admin_review_status:'open',text_collection_quality:null};
 const repeat=capture(source,'2026-10-31T20:00:00.000Z',encoded('support@example.org',3)),current=capture(source,'2026-10-31T20:01:00.000Z',encoded('support@example.org',41)),ref=programTextReference(current),previousRef=programTextReference(repeat);
 source.text_monitoring_state={schema:'awardping.program-text-state.v1',epoch,status:'baseline_ready',baseline_ref:ref,latest_ref:ref,successful_checks:5,first_captured_at:repeat.captured_at,last_checked_at:current.captured_at};
 const role={source_role:'application',revision:epoch,source_ids:[source.id],manifest_status:'reviewed_text',evidence:{schema:'awardping.program-text-source-role.v1',source_bindings:{[source.id]:{source_url:source.url,shared_award_id:source.shared_award_id}}}};
 const base={registry:{cohort_key:'example',canonical_shared_award_id:source.shared_award_id},roles:[role],sources:[source],memberIds:[source.shared_award_id],epoch,pending_alert_reviews:[],repeat_observations:[],reviewed_repeat_observations:[],repeat_observation_ids:[],basic_fact_head_id:head};
 const context={...base,loadCapture:vi.fn(async r=>r.capture_id===ref.capture_id?current:r.capture_id===previousRef.capture_id?repeat:Promise.reject(Error('Unknown capture')))};
 const overview='Example Award supports graduate study.',review=emptyProgramFactReview({...context,cycle:'2027'}),quote={source_id:source.id,capture_id:ref.capture_id,block_id:'body',start_utf16:0,end_utf16:overview.length,text:overview};
 Object.assign(review.fields.find(f=>f.field==='overview'),{status:'verified',items:[{value:quote.text,track:null,support:[quote]}]});
 const comparison=buildProgramTextComparison(repeat,current,{epoch,cycle_id:null}),plan=buildProgramTextReviewPackets(comparison);
 const responses=plan.packets.map(p=>({schema:'awardping.program-text-review.v1',comparison_id:comparison.comparison_id,packet_id:p.packet_id,...comparison.context,blocks:p.blocks.map(b=>({id:b.id,disposition:'no_program_change',reason:'Only unchanged protected-email destination encoding changed.',changes:[]}))}));
 const candidate={...Object.fromEntries(REVIEWED_BASIC_CANDIDATE_KEYS.map(k=>[k,null])),id:candidateId,shared_award_id:source.shared_award_id,shared_award_source_id:source.id,source_url:source.url,candidate_scope:'program_text_change',status:'rejected',rejection_reason:'no_program_change',candidate_signature:comparison.comparison_id,previous_snapshot_ref:previousRef,new_snapshot_ref:ref,
  worker_metadata:{epoch,monitoring_contract:'program-text-v1',evidence_signature:comparison.comparison_id,gemini_spend_reservation_id:reservationId,gemini_spend_attempt_token:attempt,provider_request_keys:plan.packets.map(p=>p.packet_id)},prompt_payload:{comparison,packet_plan:plan},ai_result:{responses,program_text_validation:{status:'no_program_change',comparison_id:comparison.comparison_id,reasons:[],changes:[]}},model:'gemini-3.8-flash',gemini_batch_name:'batches/fixture',submitted_at:'2026-10-31T20:01:01.000Z',completed_at:'2026-10-31T20:02:00.000Z',actual_usage:{}};
 const paid={id:reservationId,status:'settled',attempt_token:attempt,model:candidate.model,provider_batch_name:candidate.gemini_batch_name,lane_key:'changed_page_review',worker_source:'program-text-review',metadata:{candidate_id:candidateId,monitoring_contract:'program-text-v1'},work_fingerprint:`program-text:${comparison.comparison_id}:${candidate.model}`,request_count:plan.packets.length,settled_at:'2026-10-31T20:01:59.000Z',spent_source:'bounded-provider-settlement'};
 const inspection={schema:REVIEWED_BASIC_REPEAT_INSPECTION_SCHEMA,packet:{schema:'awardping.current-basic-award-context.v1',head_id:head,context:base},candidate,candidate_hash:reviewedBasicHash(candidate),paid_reservation:paid};
 return{source,current,repeat,ref,previousRef,context,review,candidate,paid,inspection};
}
async function prepared(f){return(await prepareCurrentBasicReviewedRepeat({inspection:f.inspection,review:f.review,verified_at:new Date().toISOString()},f.context)).p_validation;}
function ledger(validation,f){return{id:observationId,...validation,current_ref:validation.current_document.reference,repeat_ref:validation.repeat_document.reference,content_hash:'e'.repeat(64)};}

describe('separate reviewed nonidentical complete source repeats',()=>{
 it('cold-replays the actual terminal normal review and settled attempt without altering either original',async()=>{const f=fixture(),before=JSON.stringify(f.candidate),v=await prepared(f);expect(v.kind).toBe(kind);expect(v.current_document.reference.text_sha256).not.toBe(v.repeat_document.reference.text_sha256);expect(v.rules).toEqual([{change_id:f.candidate.prompt_payload.comparison.changed_blocks[0].id,kind:'identical_protected_email_destination',decoded_hex:Buffer.from('support@example.org').toString('hex')}]);expect(v.support_projection).toHaveLength(1);expect(v.support_hash).toBe(reviewedBasicHash(v.support_projection));expect(f.context.loadCapture).toHaveBeenCalledTimes(2);expect(JSON.stringify(f.candidate)).toBe(before);});
 it('keeps the old byte-equal attestation preparation strict',async()=>{const f=fixture();await expect(prepareCurrentBasicRepeat({current_ref:f.ref,repeat_ref:f.previousRef,verified_at:new Date().toISOString()},f.context)).rejects.toThrow('independent_same_content');});
 it('uses an explicit proof kind and cold-validates both full originals before a draft',async()=>{const f=fixture(),v=await prepared(f),row=ledger(v,f);f.context.reviewed_repeat_observations=[row];f.context.repeat_observation_ids=[{source_id:f.source.id,id:row.id,kind}];const draft=await validateCurrentBasicFactReview(f.review,f.context);expect(draft.current_source_proofs).toEqual([{source_id:f.source.id,repeat_observation_id:null,pending_alert_review_id:null,pending_alert_review_hash:null,kind,reviewed_repeat_observation_id:observationId,reviewed_repeat_hash:row.content_hash}]);expect(f.source.text_monitoring_state.status).toBe('baseline_ready');});
 it('cold-rechecks the same kind through independent publication preparation and records the parent head',async()=>{const f=fixture(),v=await prepared(f),row=ledger(v,f);f.context.reviewed_repeat_observations=[row];f.context.repeat_observation_ids=[{source_id:f.source.id,id:row.id,kind}];const validation=await validateCurrentBasicFactReview(f.review,f.context),draft={id:candidateId,content_hash:'a'.repeat(64),validation},at=new Date().toISOString(),deps={inspect:async()=>({schema:'awardping.basic-fact-draft-context.v1',draft,context:f.context,head_id:head}),loadCapture:f.context.loadCapture,now:()=>Date.parse(at)};const result=await prepareBasicFactPublication({draft_id:draft.id,selected_fields:['overview'],reviewed_at:at},deps);expect(result.plan.expected_head_id).toBe(head);expect(result.plan.receipt.current_source_proofs[0].kind).toBe(kind);});
 it('rejects a proof made for another parent head before publication',async()=>{const f=fixture(),v=await prepared(f);f.context.reviewed_repeat_observations=[ledger(v,f)];f.context.repeat_observation_ids=[{source_id:f.source.id,id:observationId,kind}];f.context.basic_fact_head_id=candidateId;await expect(validateCurrentBasicFactReview(f.review,f.context)).rejects.toThrow('parent_head');});
 it.each([
  ['nonterminal candidate',f=>{f.candidate.status='submitted';}],['real program change',f=>{f.candidate.ai_result.program_text_validation.status='accepted';}],['missing paid provenance',f=>{f.inspection.paid_reservation=null;}],['unsettled paid attempt',f=>{f.paid.status='submitted';}],['wrong paid attempt',f=>{f.paid.attempt_token=epoch;}],['wrong candidate provenance',f=>{f.paid.metadata.candidate_id=head;}],['wrong source URL',f=>{f.candidate.source_url='https://example.org/other';}],['wrong epoch',f=>{f.candidate.worker_metadata.epoch=head;}],['wrong candidate hash',f=>{f.inspection.candidate_hash='0'.repeat(64);}],['response omitted',f=>{f.candidate.ai_result.responses=[];}],['not current source',f=>{f.source.text_monitoring_state.status='held';}],
 ])('rejects %s',async(name,mutate)=>{const f=fixture();mutate(f);if(name!=='wrong candidate hash')f.inspection.candidate_hash=reviewedBasicHash(f.candidate);await expect(prepared(f)).rejects.toThrow();});
 it('requires all published support full semantic blocks unchanged, beyond the quoted substring',()=>{const f=fixture(),changed=capture(f.source,f.repeat.captured_at,f.repeat.blocks[1].text,sentence+' Other applicants are excluded.');expect(()=>reviewedBasicSupportProjection(f.review,f.source.id,f.current,changed)).toThrow('full_semantic_block_changed');});
 it('binds field value and support selection hash, not only the same literal',async()=>{const f=fixture(),v=await prepared(f);f.context.reviewed_repeat_observations=[ledger(v,f)];f.context.repeat_observation_ids=[{source_id:f.source.id,id:observationId,kind}];f.review.fields.find(x=>x.field==='overview').items[0].value='Invented different benefit.';await expect(validateCurrentBasicFactReview(f.review,f.context)).rejects.toThrow('published_support_changed');});
 it('refuses a changed field/heading/context even when the email payload is identical',async()=>{const f=fixture(),row=ledger(await prepared(f),f);row.rules[0].decoded_hex='00';expect(()=>validateCurrentBasicReviewedRepeatEvidence(row,{current:f.current,repeat:f.repeat})).toThrow('rule_proof_changed');});
 it('can replay truthful stored deterministic provenance without inventing a paid attempt',async()=>{const f=fixture(),pending={...f.candidate,status:'pending',ai_result:null,model:null,gemini_batch_name:null,submitted_at:null,completed_at:null,rejection_reason:null,worker_metadata:{epoch,monitoring_contract:'program-text-v1',evidence_signature:f.candidate.candidate_signature,bucket:'private'},updated_at:'2026-10-31T20:01:00.000Z'};const local=programTextDeterministicNoChange(pending);expect(local).not.toBeNull();Object.assign(f.candidate,{model:null,gemini_batch_name:null,submitted_at:null,worker_metadata:pending.worker_metadata,ai_result:{responses:local.responses,program_text_validation:local.validation,program_text_review_provenance:local.provenance}});f.inspection.paid_reservation=null;f.inspection.candidate_hash=reviewedBasicHash(f.candidate);expect((await prepared(f)).paid_reservation).toBeNull();});
 it('candidate hash excludes unrelated mutable bookkeeping while binding saved evidence',()=>{const f=fixture(),snap=reviewedBasicCandidateSnapshot({...f.candidate,updated_at:'changed',estimated_cost_usd:99});expect(snap).toEqual(f.candidate);});
});

describe('actual raw hidden honeypot marker boundary',()=>{
 function pair({hidden=true,sourceId='f322a07c-f78c-47fd-aafb-ab6422a4248f',sourceOwner='dd23afbb-299e-489f-8a0b-e4d7506848de',sourceUrl='https://www.schwarzmanscholars.org/admissions/application-instructions/',formAction='/admissions/application-instructions/#gf_5',labels=['URL','LinkedIn'],extra='',inert=false,programmeChange=false,linkChange=false,inputValue='',visiblePrompt=false}={}){
  const source={id:sourceId,shared_award_id:sourceOwner,url:sourceUrl,title:'Application Instructions',page_type:'application'};
  const make=(label,key,date)=>{const isCurrent=key===21,body=isCurrent&&programmeChange?sentence+' Applicants must be citizens.':sentence,href=encoded(isCurrent&&linkChange?'changed@schwarzmanscholars.org':'admissions@schwarzmanscholars.org',key),li='<li id="field_5_10" class="gfield gfield--type-honeypot gform_validation_container"><label id="gfield_label_5_10" for="input_5_10"><span class="gform-field-label__text">'+label+'</span></label><div><input name="input_10" id="input_5_10" type="text" value="'+inputValue+'" autocomplete="new-password"/></div><div class="gfield_description" id="gfield_description_5_10">This field is for validation purposes and should be left unchanged.</div>'+extra+'</li>';
   const prompt=label+' This field is for validation purposes and should be left unchanged.',html='<html><body><main><div id="gform_wrapper_5" style="display:'+(hidden?'none':'block')+'"><form id="gform_5" method="post" data-formid="5" action="'+formAction+'" target="gform_ajax_frame_5"><ul id="gform_fields_5">'+(inert?'<template>':'')+li+(inert?'</template>':'')+'</ul></form></div><a href="'+href+'">Contact</a>'+(visiblePrompt?'<ul><li>'+prompt+'</li></ul>':'')+'</main></body></html>';
   const hiddenBlock={id:'hidden',kind:'li',heading:'Stay Connected',context:{heading_path:[{level:3,text:'Stay Connected'}]},text:prompt};
   return capture(source,date,href,body,[hiddenBlock,...(visiblePrompt?[{...hiddenBlock,id:'visible-prompt'}]:[])],html);
  };
  const previous=make(labels[0],13,'2026-10-31T20:00:00.000Z'),current=make(labels[1],21,'2026-10-31T20:01:00.000Z');return{previous,current,comparison:buildProgramTextComparison(previous,current,{epoch,cycle_id:null})};
 }
 it('proves raw DOM/hidden wrapper/source-specific label scope and exact full-text reconstruction',()=>{const f=pair(),{rules}=reviewedBasicDeterministicRules(f.previous,f.current,f.comparison);expect(rules.map(r=>r.kind)).toContain('hidden_gravityforms_honeypot_label');expect(rules.find(r=>r.kind==='hidden_gravityforms_honeypot_label').current_marker.label).toBe('LinkedIn');});
 it.each([{hidden:false},{sourceId:candidateId},{extra:'Application opens tomorrow.'},{inert:true}])('refuses missing hidden/source/content/DOM proof %#',options=>{const f=pair(options);expect(()=>reviewedBasicDeterministicRules(f.previous,f.current,f.comparison)).toThrow();});
 const profiles=[{sourceId:'434c57c2-4f87-4c5e-bc88-24cb59f4b1e7',sourceOwner:'19135163-d9dd-4fc2-b2ae-7d0bb8449735',sourceUrl:'https://www.schwarzmanscholars.org/admissions/',formAction:'/admissions/#gf_5',labels:['LinkedIn','Company']},{sourceId:'db04bc7a-d0fd-40a5-8922-30921b02a7e2',sourceUrl:'https://www.schwarzmanscholars.org/admissions/',formAction:'/admissions/#gf_5',labels:['LinkedIn','Company']},{sourceId:'5bf1f780-ffc1-49e1-88d7-7da3ebd943cf',sourceOwner:'19135163-d9dd-4fc2-b2ae-7d0bb8449735',sourceUrl:'https://www.schwarzmanscholars.org/',formAction:'/#gf_5',labels:['Facebook','Instagram']}];
 it.each(profiles)('admits the observed daily source-specific hidden label pair $sourceId with all previous raw/full-text checks',options=>{const f=pair(options),proof=reviewedBasicDeterministicRules(f.previous,f.current,f.comparison),rule=proof.rules.find(r=>r.kind==='hidden_gravityforms_honeypot_label');expect(rule.previous_marker.label).toBe(options.labels[0]);expect(rule.current_marker.label).toBe(options.labels[1]);expect(rule.previous_marker.form_start_tag).toContain('action="'+options.formAction+'"');});
 it.each(profiles)('rejects foreign URL/action/unknown labels and visible content for daily profile $sourceId',profile=>{for(const override of[{sourceOwner:candidateId},{sourceUrl:'https://www.schwarzmanscholars.org/other/'},{formAction:'/admissions/application-instructions/#gf_5'},{labels:['Eligibility','Deadline']},{hidden:false},{extra:'Eligibility changes.'},{inert:true}]){const f=pair({...profile,...override});expect(()=>reviewedBasicDeterministicRules(f.previous,f.current,f.comparison)).toThrow();}});
 const admittedProfiles=[{},...profiles],observedLabels=['Company','Facebook','Instagram','LinkedIn','URL','X/Twitter'];
 it.each(admittedProfiles)('handles every observed rotating label on this exact hidden publisher field %#',profile=>{
  for(const before of observedLabels)for(const after of observedLabels){if(before===after)continue;const f=pair({...profile,labels:[before,after]}),proof=reviewedBasicDeterministicRules(f.previous,f.current,f.comparison),rule=proof.rules.find(r=>r.kind==='hidden_gravityforms_honeypot_label');expect(rule.previous_marker.label).toBe(before);expect(rule.current_marker.label).toBe(after);}
 });
 it.each(admittedProfiles)('keeps programme facts, destinations, visible labels and unknown prompts outside the rotating-label allowance %#',profile=>{
  for(const override of[{labels:['Company','Application deadline']},{labels:['Company','January 31, 2027']},{labels:['Company','U.S. citizens only']},{labels:['Company','Unobserved']},{labels:['Company','Instagram'],programmeChange:true},{labels:['Company','Instagram'],linkChange:true},{labels:['Company','Instagram'],hidden:false},{labels:['Company','Instagram'],inputValue:'changed'},{labels:['Company','Instagram'],extra:'<a href="https://example.org/apply">Apply here</a>'}]){const f=pair({...profile,...override});expect(()=>reviewedBasicDeterministicRules(f.previous,f.current,f.comparison)).toThrow();}
 });
 it.each(admittedProfiles)('rejects a visible prompt that tries to borrow the hidden field witness %#',profile=>{const f=pair({...profile,labels:['Company','Instagram'],visiblePrompt:true});expect(()=>reviewedBasicDeterministicRules(f.previous,f.current,f.comparison)).toThrow('honeypot_block_not_unique_to_hidden_field');});
});

describe('source-bound raw ancillary widgets',()=>{
 function pair({outsideChange=false,wrongSource=false,wrongClass=false,duplicateOutside=false,sourceId,sourceUrl,duplicateHrefOutside=false,duplicateAnchorOutside=false}={}){
  const source={id:wrongSource?candidateId:sourceId||'bd79bc43-dd42-4f0b-8323-7c981587b261',shared_award_id:'3cf7c610-0246-4dfb-b26c-289254e40ce6',url:sourceUrl||'https://pdsoros.org/pd-soros-recommendations-a-guide-for-applicants/',title:'Recommendations',page_type:'application'};
  const make=(name,date)=>{const body=outsideChange?sentence+' '+name+' applicants only.':duplicateOutside?sentence+' '+name+' earned a PhD.':sentence,href=encoded('contact@pdsoros.org',7),cards=[{name,slug:name.toLowerCase()},{name:'Shared Fellow',slug:'shared-fellow'}];
   const outsideLabel=duplicateAnchorOutside?'NewFellow earned a PhD.':'Article fellow link',outsideAnchor=(duplicateHrefOutside||duplicateAnchorOutside)?'<a href="https://pdsoros.org/fellows/newfellow/">'+outsideLabel+'</a>':'';
   const html='<html><body><main><p>'+body+'</p><a href="'+href+'">Contact</a>'+outsideAnchor+'<section><h2>Featured Fellows</h2><div class="'+(wrongClass?'unreviewed-widget':'align wp-block-acf-featured-fellows')+'"><ul class="fellow-list fellow-list--stacked">'+cards.map(c=>'<li><article class="p-person-card is-fellow"><a class="p-person-card__inner" href="https://pdsoros.org/fellows/'+c.slug+'/"><p>'+c.name+' earned a PhD.</p></a></article></li>').join('')+'</ul></div></section></main></body></html>';
   const extra=cards.map((c,i)=>({id:'card-'+i,kind:'li',heading:'Recommendations > Featured Fellows',context:{heading_path:[{text:'Recommendations',level:1},{text:'Featured Fellows',level:2}]},text:c.name+' earned a PhD.'}));
   if(outsideAnchor){extra.push({id:'outside-link',kind:'source_link',text:'https://pdsoros.org/fellows/newfellow/',heading:'Recommendations',context:{source_attribute:'href',link_text:outsideLabel}});for(const[c,i]of cards.map((c,i)=>[c,i]))extra.push({id:'card-link-'+i,kind:'source_link',text:'https://pdsoros.org/fellows/'+c.slug+'/',heading:'Recommendations > Featured Fellows',context:{source_attribute:'href',link_text:c.name+' earned a PhD.'}});}
   return capture(source,date,href,body,extra,html);
  };
  const previous=make('OldFellow','2026-10-31T20:00:00.000Z'),current=make('NewFellow','2026-10-31T20:01:00.000Z');return{source,previous,current,comparison:buildProgramTextComparison(previous,current,{epoch,cycle_id:null})};
 }
 it('binds actual source, parsed widget, card class/count and exact remaining capture text',()=>{const f=pair(),proof=reviewedBasicDeterministicRules(f.previous,f.current,f.comparison);expect(proof.widget_proofs).toHaveLength(1);expect(proof.rules.every(r=>r.kind==='raw_marked_ancillary_widget')).toBe(true);expect(proof.widget_proofs[0].current_marker.excluded_support_block_ids).toContain('card-1');});
 it.each([{outsideChange:true},{wrongSource:true},{wrongClass:true},{duplicateOutside:true}])('refuses changed programme/outside/ambiguous/unreviewed widget evidence %#',options=>{const f=pair(options);expect(()=>reviewedBasicDeterministicRules(f.previous,f.current,f.comparison)).toThrow();});
 it('refuses public support in an unchanged card inside the excluded widget',()=>{const f=pair(),proof=reviewedBasicDeterministicRules(f.previous,f.current,f.comparison),block=f.current.blocks.find(b=>b.id==='card-1'),review={fields:[{field:'overview',status:'verified',items:[{value:block.text,track:null,support:[{source_id:f.source.id,capture_id:f.current.capture_id,block_id:block.id,start_utf16:block.start_utf16,end_utf16:block.end_utf16,text:block.text}]}]}]};expect(()=>reviewedBasicSupportProjection(review,f.source.id,f.current,f.previous,proof.widget_proofs)).toThrow('widget_cannot_support_public_facts');});
 const musician={sourceId:'4e4cfa3e-fb2a-4ea7-a792-6da5df9ee6b4',sourceUrl:'https://pdsoros.org/musicians-applying-for-the-pd-soros-fellowship/'};
 it('binds the finite musicians card anchor by href plus complete raw text while preserving an article anchor to the same href',()=>{const f=pair({...musician,duplicateHrefOutside:true}),proof=reviewedBasicDeterministicRules(f.previous,f.current,f.comparison),ids=proof.widget_proofs[0].current_marker.excluded_support_block_ids;expect(ids).toContain('card-link-0');expect(ids).not.toContain('outside-link');});
 it('still rejects a musicians anchor whose same href and complete raw card text also appear outside the widget',()=>{const f=pair({...musician,duplicateAnchorOutside:true});expect(()=>reviewedBasicDeterministicRules(f.previous,f.current,f.comparison)).toThrow();});
});

describe('finite DAAD country-guide sponsored carousel',()=>{
 const source={id:'8d654c9d-e572-4488-94a3-e4238e7b1155',shared_award_id:'440d6985-ece9-48c4-ac30-65a739f60d65',url:'https://www.daad.org/en/find-funding/country-specific-information-for-us-applicants/',title:'Country guide',page_type:'application'},heading='Advertisements by German Universities';
 function pair(options={}){
  const make=(name,date)=>{
   const src={...source,...options.source},numbers=Array.from({length:options.count??11},(_,i)=>i===0?name:String(i)),id='headline-'+(name==='old'?'11111111':'22222222');
   const body=options.programmeChange?sentence+' '+name+' applicants only.':options.deadlineChange?sentence.replace('January 31',name==='old'?'January 31':'February 1'):sentence;
   const notice='Programme application deadline: '+name+'.',noticeHtml='<p>'+notice+'</p>',applyUrl='https://www.daad.org/application-'+name+'/';
   const html='<html><body><main><p>'+body+'</p>'+(options.awardLink?'<a href="'+applyUrl+'">Apply</a>':'')+'<div class="bg-lightgrey u-p-medium '+(options.wrongClass?'unknown-slider':'js-ad-slider')+' is-relative" role="region" aria-roledescription="Karussell" aria-labelledby="'+id+'"><div class="u-flex-space-between"><h2 id="'+id+'">'+(options.wrongHeading?'Programme conditions':heading)+'</h2>'+(options.noticePosition==='header'?noticeHtml:'')+'<span class="u-size-copy u-weight-semibold"><span class="js-slide-count">1</span>/'+numbers.length+'</span></div><div class="u-mb-medium"><div class="js-ad-slider-track">'+numbers.map(n=>'<div class="u-position-relative"><div class="u-mb-medium"><img alt=""></div><div><p class="u-dateline">'+heading+'</p><h3 class="u-size-large">University '+n+'</h3><p class="u-size-teaser">University '+n+' sponsored advertisement.</p>'+(options.noticePosition==='card'?noticeHtml:'')+'<a class="o-more-link o-more-link--stretched" href="'+(options.foreignAdLink?'https://www.daad.org/application-'+name+'/':'https://www.daad.org/en/university-ad/card-'+n+'/')+'">Read more</a></div></div>').join('')+'</div></div></div>'+(options.noticePosition==='outside'?noticeHtml:'')+'</main></body></html>';
   const extra=numbers.map((n,i)=>({id:'card-'+i,text:'University '+n+' sponsored advertisement.',kind:'p',heading:'Country guide > '+heading,context:{heading_path:[{text:'Country guide',level:1},{text:heading,level:2}]}}));
   if(options.noticePosition)extra.push({id:'notice',text:notice,kind:'p',heading:'Country guide',context:{heading_path:[{text:'Country guide',level:1}]}});
   if(options.awardLink)extra.push({id:'award-link',text:applyUrl,kind:'source_link',heading:'Country guide',context:{source_attribute:'href',link_text:'Apply',heading_path:[{text:'Country guide',level:1}]}});
   return capture(src,date,encoded('info@daad.org',7),body,extra,html);
  };
  const previous=make('old','2026-10-31T20:00:00.000Z'),current=make('new','2026-10-31T20:01:00.000Z');return{previous,current,comparison:buildProgramTextComparison(previous,current,{epoch,cycle_id:null})};
 }
 it('binds exactly the reviewed source/owner/URL, eleven actual cards, raw heading reference and unchanged residual',()=>{const f=pair(),proof=reviewedBasicDeterministicRules(f.previous,f.current,f.comparison);expect(proof.widget_proofs[0].profile).toBe('daad_sponsored_university_carousel.v1');expect(proof.widget_proofs[0].current_marker.card_count).toBe(11);expect(proof.widget_proofs[0].current_marker.heading).toBe(heading);expect(proof.rules.every(r=>r.kind==='raw_marked_ancillary_widget')).toBe(true);});
 it.each([{source:{id:candidateId}},{source:{shared_award_id:candidateId}},{source:{url:'https://www.daad.org/en/other/'}},{count:33},{wrongClass:true},{wrongHeading:true},{programmeChange:true}])('rejects any different source/scope/card structure or programme change %#',options=>{const f=pair(options);expect(()=>reviewedBasicDeterministicRules(f.previous,f.current,f.comparison)).toThrow();});
 it.each([1,9,10,12,32])('accepts only the bounded publisher-sponsored inventory structure at %i cards',count=>{const f=pair({count}),p=reviewedBasicDeterministicRules(f.previous,f.current,f.comparison);expect(p.widget_proofs[0].previous_marker.card_count).toBe(count);expect(p.widget_proofs[0].current_marker.card_count).toBe(count);});
 it.each([{deadlineChange:true},{awardLink:true},{noticePosition:'header'},{noticePosition:'card'},{noticePosition:'outside'},{foreignAdLink:true}])('rejects real programme or unmarked notice/link changes despite the sponsored wrapper %#',options=>{const f=pair(options);expect(()=>reviewedBasicDeterministicRules(f.previous,f.current,f.comparison)).toThrow();});
 it('forbids every sponsored advertisement from supporting a public programme fact',()=>{const f=pair({count:10}),p=reviewedBasicDeterministicRules(f.previous,f.current,f.comparison),b=f.current.blocks.find(b=>b.id==='card-1'),review={fields:[{field:'overview',status:'verified',items:[{value:b.text,track:null,support:[{source_id:source.id,capture_id:f.current.capture_id,block_id:b.id,start_utf16:b.start_utf16,end_utf16:b.end_utf16,text:b.text}]}]}]};expect(()=>reviewedBasicSupportProjection(review,source.id,f.current,f.previous,p.widget_proofs)).toThrow('widget_cannot_support_public_facts');});
});

describe('one conserved James Madison footer alignment witness',()=>{
 function pair(options={}){
  const source={id:'0f217532-3638-4cc4-8548-7ae9f4eec489',shared_award_id:'592d1ab0-7eff-402a-82ba-90d19559aa7f',url:'https://www.jamesmadison.gov/fellowship-information/fellowship-eligibility',title:'Eligibility',page_type:'eligibility'},prefix=[{level:2,text:'Sidebar Menu Fellowship Information'}];
  const make=(name,date,isCurrent)=>{const names=['First Fellow','Second Fellow',name],rows=[{id:'programme',text:sentence,kind:'p',heading:'Programme',context:{heading_path:[{level:1,text:'Programme'}]}}];for(const[n,i]of names.map((n,i)=>[n,i])){const path=[...prefix,{level:4,text:n},{level:5,text:'State Fellow'}];rows.push({id:'heading-'+i,text:n,kind:'heading',heading:[...prefix.map(h=>h.text),n].join(' > '),context:{heading_path:path.slice(0,-1),list_path:[],table_row:[]}}, {id:'state-'+i,text:'State Fellow',kind:'heading',heading:path.map(h=>h.text).join(' > '),context:{heading_path:path,list_path:[],table_row:[]}}, {id:'reflection-'+i,text:'A teaching reflection '+i+'.',kind:'p',heading:path.map(h=>h.text).join(' > '),context:{heading_path:path,list_path:[],table_row:[]}});}
   const footerText=isCurrent&&options.footerChanged?'Follow Us today':'Follow Us',path=[...prefix,{level:4,text:options.wrongInherited&&isCurrent?'Wrong person':name},{level:5,text:'State Fellow'}];rows.push({id:'follow',text:footerText,kind:'p',heading:path.map(h=>h.text).join(' > '),context:{heading_path:path,list_path:isCurrent&&options.otherContextChanged?['Changed context']:[],table_row:[]}});
   let text='';const blocks=rows.map(row=>{if(text)text+='\n';const start=text.length;text+=row.text;return{...row,start_utf16:start,end_utf16:text.length};});
   const footer='<footer class="flex-grow-0 bg-blue-dark border-blue border-top-3 text-center text-lg-left"><div id="jmf1-social-links-container"><p'+(options.rawParagraphChanged?' class="changed"':'')+'>'+footerText+'</p></div></footer>',html='<html><body><main><p>'+sentence+'</p><div id="block-views-block-testimonial-block-block-1" class="views-element-container">'+names.map((n,i)=>'<div class="jmf1-sidebar-testimonial"><div class="jmf-identity"><img class="testimonial-headshot"><h4>'+n+'</h4><h5>State Fellow</h5></div><p>A teaching reflection '+i+'.</p></div>').join('')+(options.footerInsideWidget?footer:'')+'</div></main>'+(options.footerInsideWidget?'':footer)+(options.duplicateRaw?'<aside><p>Follow Us</p></aside>':'')+'</body></html>';
   return buildProgramTextCapture({source,captured_at:date,acquisition:'http_html',extractor:{name:'fixture',version:'1'},content_type:'text/html',raw_bytes:Buffer.from(html),text,blocks});};
  const previous=make('Thomas Ng','2026-10-31T20:00:00.000Z',false),current=make('Ethan Rettew','2026-10-31T20:01:00.000Z',true),comparison={status:'review_required',changed_blocks:[{id:'coupled-a',previous:previous.blocks.find(b=>b.id==='heading-2'),current:current.blocks.find(b=>b.id==='follow')},{id:'coupled-b',previous:previous.blocks.find(b=>b.id==='follow'),current:null}]};return{source,previous,current,comparison};
 }
 it('binds the exact coupled changes to both raw footer paragraphs and last testimonial headings without excluding footer text',()=>{const f=pair(),proof=reviewedBasicDeterministicRules(f.previous,f.current,f.comparison),rules=proof.rules.filter(r=>r.kind==='raw_bound_static_alignment');expect(rules).toHaveLength(2);expect(rules[0].change_ids).toEqual(['coupled-a','coupled-b']);expect(rules[0].previous_marker.html).toBe('<p>Follow Us</p>');expect(rules[0].previous_marker.inherited_headings.map(h=>h.text)).toEqual(['Thomas Ng','State Fellow']);expect(rules[0].current_marker.inherited_headings.map(h=>h.text)).toEqual(['Ethan Rettew','State Fellow']);expect(proof.widget_proofs[0].previous_marker.excluded_support_block_ids).not.toContain('follow');expect(proof.widget_proofs[0].current_marker.excluded_support_block_ids).not.toContain('follow');});
 it.each([{footerChanged:true},{wrongInherited:true},{otherContextChanged:true},{rawParagraphChanged:true},{footerInsideWidget:true},{duplicateRaw:true}])('rejects changed/ambiguous/unbound/static semantic content %#',options=>{const f=pair(options);expect(()=>reviewedBasicDeterministicRules(f.previous,f.current,f.comparison)).toThrow();});
 it('requires both exact coupled comparison changes',()=>{const f=pair();f.comparison.changed_blocks.pop();expect(()=>reviewedBasicDeterministicRules(f.previous,f.current,f.comparison)).toThrow('coupled_static_alignment');});
 it('does not permit the inherited-heading footer block to support public facts',()=>{const f=pair(),b=f.current.blocks.find(b=>b.id==='follow'),review={fields:[{field:'eligibility',status:'verified',items:[{value:'Follow Us',track:null,support:[{source_id:f.source.id,capture_id:f.current.capture_id,block_id:b.id,start_utf16:b.start_utf16,end_utf16:b.end_utf16,text:b.text}]}]}]};expect(()=>reviewedBasicSupportProjection(review,f.source.id,f.current,f.previous)).toThrow('full_semantic_block_changed');});
});

describe('literal Tillman campus-directory CF payloads',()=>{
 const source={id:'7f3621f2-1422-40e5-b2da-8f1f15b51c04',shared_award_id:'cb8740aa-4585-4e1c-a939-35fc854cb12b',url:'https://pattillmanfoundation.org/apply/',title:'Apply',page_type:'application'};
 function pair(a,b,otherSource=false){const make=(payload,key,date)=>{const target=otherSource?{...source,id:candidateId}:source,href=encoded(payload,key),text=sentence+'\n'+href;return buildProgramTextCapture({source:target,captured_at:date,acquisition:'http_html',extractor:{name:'fixture',version:'1'},content_type:'text/html',raw_bytes:Buffer.from('<html><body><p>'+sentence+'</p><a href="'+href+'"></a></body></html>'),text,blocks:[{id:'body',text:sentence,start_utf16:0,end_utf16:sentence.length},{id:'campus-email',kind:'source_link',text:href,start_utf16:sentence.length+1,end_utf16:text.length,heading:'Tillman Scholars Study at These Universities',context:{source_attribute:'href',link_text:'',heading_path:[{level:2,text:'Tillman Scholars Study at These Universities'}]}}]});};const previous=make(a,19,'2026-10-31T20:00:00.000Z'),current=make(b,29,'2026-10-31T20:01:00.000Z');return{previous,current,comparison:buildProgramTextComparison(previous,current,{epoch,cycle_id:null})};}
 it('preserves literal encoded spaces in the complete decoded equality value',()=>{const value='%20campus@example.edu%20',f=pair(value,value),proof=reviewedBasicDeterministicRules(f.previous,f.current,f.comparison);expect(proof.rules[0].decoded_hex).toBe(Buffer.from(value).toString('hex'));});
 it.each([['%20a@example.edu%20','%20b@example.edu%20',false],['a@example.edu%20','a@example.edu%20',true],['a@example.edu%20','a@example.edu',false]])('rejects real destination/source/payload-byte changes %#',(a,b,other)=>{const f=pair(a,b,other);expect(()=>reviewedBasicDeterministicRules(f.previous,f.current,f.comparison)).toThrow();});
});
