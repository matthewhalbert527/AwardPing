import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {buildProgramTextCapture} from './program-text-capture-contract.mjs';
import {programTextReference} from './program-text-artifacts.mjs';
import {PAPPG_CANONICAL_SOURCE_ID as selected,PAPPG_CANONICAL_OWNER_ID as owner,PAPPG_CANONICAL_URL as url,
 PAPPG_PRESERVED_SOURCE_IDS} from './program-text-canonical-url-admission.mjs';
import {PAPPG_REVALIDATION_SCHEMA as schema,PAPPG_REVALIDATION_INSPECTION_SCHEMA as inspectionSchema,
 PAPPG_FOOTER_REMOVAL as removed,validateProgramTextPappgRevalidation,assertPappgFooterOnlyRevalidation,
 inspectProgramTextPappgRevalidation,revalidateProgramTextPappgCanonical} from './program-text-pappg-revalidation.mjs';
import {pappgRevalidationRollbackSql,pappgRevalidationEmptySliceProbe,pappgRevalidationSingleRollbackSql} from '../test-support/pappg-revalidation-rollback.mjs';

const epoch='ec349339-ff62-4d2e-a610-8c361b4044ec',actor='22222222-2222-4222-8222-222222222222',
 revision='33333333-3333-4333-8333-333333333333',id='44444444-4444-4444-8444-444444444444';
const source={id:'c49e85e3-3b19-4052-891f-c2bc67e8b8f6',shared_award_id:owner,page_type:'other',title:'Synthetic NSF solicitation',
 url:'https://www.nsf.gov/funding/opportunities/grfp-nsf-graduate-research-fellowship-program/nsf26-526/solicitation'};
const now=Date.parse('2026-10-31T21:30:00.000Z');
const originalFooter='Print: Required Policy Links '+removed+'Tel: (703) 292-5111 Publication date: August 25, 2026 Last updated: October 2, 2026 Footer About Us';
function capture(footer,date,htmlOverride,body='Applicants must meet all official fellowship requirements.'){
 const text=body+'\n'+footer,html=htmlOverride??'<html><body><main><p>'+body+'</p><a href="/policies/pappg">PAPPG</a><p>'+footer+'</p></main></body></html>';
 return buildProgramTextCapture({source,acquisition:'http_html',captured_at:date,extractor:{name:'synthetic',version:'1'},
  content_type:'text/html; charset=utf-8',raw_bytes:Buffer.from(html),text,blocks:[{id:'program',text:body,start_utf16:0,end_utf16:body.length},
   {id:'footer',text:footer,start_utf16:body.length+1,end_utf16:text.length}]});
}
function fixture(){
 const before=capture(originalFooter,'2026-10-30T20:00:00.000Z'),after=capture(originalFooter.replace(removed,''),'2026-10-31T21:20:00.000Z');
 const ref=programTextReference(after),original=programTextReference(before);
 const context={schema:'awardping.program-text-pappg-canonical-context.v1',epoch,cohort_key:'nsf_grfp',shared_award_id:owner,
  selected_source_id:selected,selected_source:{id:selected,shared_award_id:owner,url},catalogue:PAPPG_PRESERVED_SOURCE_IDS.map(id=>({id})),
  collisions:[...PAPPG_PRESERVED_SOURCE_IDS,selected].map(id=>({id})),
  roles:Array.from({length:8},(_,n)=>({source_role:'role_'+n,revision:epoch,source_ids:[source.id,selected]})),
  authority:{...source,text_monitoring_state:{epoch,status:'baseline_ready',successful_checks:3,latest_ref:ref,baseline_ref:ref}}};
 const inspection={schema:inspectionSchema,epoch,disposition_revision:revision,previous_revision:revision,original_authority_ref:original,
  inspection:{schema:'awardping.program-text-pappg-canonical-inspection.v1',epoch,context,context_hash:'a'.repeat(64)}};
 const proposal={schema,id,epoch,cohort_key:'nsf_grfp',source_id:selected,disposition_revision:revision,expected_previous_revision:revision,
  expected_context:structuredClone(inspection),authority_ref:ref,link_proof:{kind:'retained_raw_html_anchor.v1',
   anchor_start_utf16:after.raw_source.bytes.toString('utf8').indexOf('<a '),target_page_url:url},
  review:{actor_id:actor,reason:'Explicitly reviewed removal of a duplicated postal address in the complete NSF footer; the official PAPPG destination remains unchanged.',reviewed_at:'2026-10-31T21:29:00.000Z'}};
 const calls=[],db={rpc:async(name,params)=>{calls.push({name,params});return name==='inspect_program_text_pappg_revalidation'?{data:inspection}:
  name==='revalidate_program_text_pappg_canonical'?{data:{id,source_id:selected,content_hash:'b'.repeat(64),idempotent:false}}:{error:{message:'unexpected RPC'}};},from(){throw Error('No direct mutation');}};
 const loadCapture=async ref=>ref.capture_id===original.capture_id?before:ref.capture_id===programTextReference(after).capture_id?after:Promise.reject(Error('Unknown retained original'));
 return {proposal,inspection,before,after,actor,loadCapture,now,db,calls};
}

test('complete observed footer removal preserves both cold originals and exact active DOM anchor',async()=>{
 const f=fixture(),before=structuredClone(f.proposal);const v=await validateProgramTextPappgRevalidation(f.proposal,f);
 assert.deepEqual(f.proposal,before);assert.equal(v.previous_document.text,f.before.text);assert.equal(v.authority_document.text,f.after.text);
 assert.equal(v.provider_link.resolved_url,url);assert.equal(v.provider_link.anchor.literal_href,'/policies/pappg');
 assert.equal(Buffer.from(v.provider_link.raw_base64,'base64').equals(f.after.raw_source.bytes),true);
 assert.equal(v.proposal.source_id,selected);assert.ok(!Object.hasOwn(v.proposal,'source'));assert.equal(f.calls.length,0);
});

for(const [label,mutate] of [
 ['different source',f=>{f.proposal.source_id=actor;}],['wrong epoch',f=>{f.proposal.epoch=actor;}],
 ['wrong predecessor',f=>{f.proposal.expected_previous_revision=actor;}],['different disposition',f=>{f.proposal.disposition_revision=actor;}],
 ['invented create permission',f=>{f.proposal.source={create:true};}],['missing role',f=>{f.inspection.inspection.context.roles.pop();f.proposal.expected_context=structuredClone(f.inspection);}],
 ['foreign catalogue omission',f=>{f.inspection.inspection.context.catalogue.pop();f.proposal.expected_context=structuredClone(f.inspection);}],
 ['different actor',f=>{f.proposal.review.actor_id=revision;}],['stale explicit review',f=>{f.proposal.review.reviewed_at='2026-10-31T20:00:00.000Z';}],
 ['review before capture',f=>{f.proposal.review.reviewed_at='2026-10-31T21:19:00.000Z';}],
 ['future review',f=>{f.proposal.review.reviewed_at='2026-10-31T21:31:00.000Z';}],
 ['fabricated raw anchor',f=>{f.proposal.link_proof.anchor_start_utf16=0;}],
 ['pending authority',f=>{f.inspection.inspection.context.authority.text_monitoring_state.status='awaiting_review';f.proposal.expected_context=structuredClone(f.inspection);}],
 ['incomplete cold original',f=>{f.after.completeness={status:'partial',reasons:['synthetic missing block']};}],
 ['cold original changed',f=>{f.loadCapture=async()=>f.before;}],
])test('revalidation rejects '+label+' before a write',async()=>{const f=fixture();mutate(f);await assert.rejects(validateProgramTextPappgRevalidation(f.proposal,f));assert.equal(f.calls.length,0);});

test('address removal cannot hide an eligibility change, context change, extra deletion or different address',()=>{
 for(const next of [
  capture(originalFooter.replace(removed,'').replace('Tel:','New condition: Tel:'),'2026-10-31T21:20:00.000Z'),
  capture(originalFooter.replace(removed,'').replace('Footer About Us','Footer Changed'),'2026-10-31T21:20:00.000Z'),
  capture(originalFooter.replace('401 Dulany Street','999 Other Street'),'2026-10-31T21:20:00.000Z'),
 ])assert.throws(()=>assertPappgFooterOnlyRevalidation(fixture().before,next));
 const f=fixture();f.after.blocks[1].heading='Eligibility';assert.throws(()=>assertPappgFooterOnlyRevalidation(f.before,f.after));
});
test('the same address elsewhere stays unchanged; only the exact complete footer block loses its duplicate',()=>{
 const body='Unchanged contact: '+removed+'Official fellowship requirements remain unchanged.';
 const before=capture(originalFooter,'2026-10-30T20:00:00.000Z',undefined,body);
 const after=capture(originalFooter.replace(removed,''),'2026-10-31T21:20:00.000Z',undefined,body);
 assert.equal(before.text.split(removed).length,3);assert.equal(after.text.split(removed).length,2);
 assert.doesNotThrow(()=>assertPappgFooterOnlyRevalidation(before,after));
 const wrong=capture(originalFooter.replace(removed,''),'2026-10-31T21:20:00.000Z',undefined,body.replace(removed,''));
 assert.throws(()=>assertPappgFooterOnlyRevalidation(before,wrong));
});

test('an anchor in inert content is refused even with the exact href bytes',async()=>{
 const f=fixture(),raw='<html><body><main><script><a href="/policies/pappg">PAPPG</a></script></main></body></html>';
 f.after=capture(originalFooter.replace(removed,''),'2026-10-31T21:20:00.000Z',raw);
 f.proposal.authority_ref=programTextReference(f.after);f.proposal.link_proof.anchor_start_utf16=raw.indexOf('<a ');
 f.inspection.inspection.context.authority.text_monitoring_state.latest_ref=f.proposal.authority_ref;
 f.inspection.inspection.context.authority.text_monitoring_state.baseline_ref=f.proposal.authority_ref;
 f.proposal.expected_context=structuredClone(f.inspection);f.loadCapture=async ref=>ref.capture_id===programTextReference(f.before).capture_id?f.before:f.after;
 await assert.rejects(validateProgramTextPappgRevalidation(f.proposal,f),/DOM_anchor/);
});

test('service wrapper rechecks whole current inspection before its only write RPC',async()=>{
 const f=fixture();const r=await revalidateProgramTextPappgCanonical(f.db,f.proposal,actor,f);
 assert.equal(r.id,id);assert.deepEqual(f.calls.map(c=>c.name),['inspect_program_text_pappg_revalidation','revalidate_program_text_pappg_canonical']);
 assert.equal(f.calls[1].params.p_actor,actor);assert.equal(f.calls[1].params.p_validation.provider_link.resolved_url,url);
});
test('same inspection hash cannot mask changed complete context',async()=>{
 const f=fixture();f.proposal.expected_context.inspection.context.roles[0].revision=actor;
 await assert.rejects(revalidateProgramTextPappgCanonical(f.db,f.proposal,actor,f));assert.equal(f.calls.length,1);
});
test('inspection rejects private raw bodies and malformed service envelopes',async()=>{
 for(const change of [i=>{i.original_authority_ref.raw_base64='secret';},i=>{delete i.previous_revision;},i=>{i.epoch=actor;}]){
  const f=fixture();change(f.inspection);await assert.rejects(inspectProgramTextPappgRevalidation(f.db,{epoch}));
 }
});
test('SQL keeps immutable rows, null-safe validation, strict predecessor CAS and service-only authority',()=>{
 const sql=fs.readFileSync(new URL('../../supabase/migrations/20261031215145_program_text_pappg_canonical_revalidation.sql',import.meta.url),'utf8');
 assert.match(sql,/unique\(disposition_revision,previous_revision\)/);assert.match(sql,/before update or delete/);
 assert.match(sql,/from auth\.users where id=p_actor for key share/);assert.match(sql,/p->'expected_context' is distinct from fresh/);
 assert.match(sql,/revalidation_documents_valid\(p,p_validation,d\.proposal->'authority_ref'\) is distinct from true/);
 assert.match(sql,/from public,anon,authenticated,service_role/);assert.match(sql,/grant execute on function public\.revalidate_program_text_pappg_canonical\(jsonb,jsonb,uuid\) to service_role/);
 assert.doesNotMatch(sql,/update public\.shared_award_sources|insert into public\.shared_award_sources|update public\.program_text_source_roster/i);
});
test('native renderer is rollback-only, tags its own backend and bounds preservation checks to eleven finite sources',async()=>{
 const f=fixture(),validation=await validateProgramTextPappgRevalidation(f.proposal,f);
 const sql=pappgRevalidationRollbackSql({proposal:f.proposal,validation,actor});
 assert.ok(sql.startsWith('BEGIN;'));assert.ok(sql.trimEnd().endsWith('ROLLBACK;'));
 assert.ok(sql.includes("SET LOCAL application_name='ap-pappg-reval-"+id+"'"));
 assert.match(sql,/cardinality\(source_ids\)=11/);assert.doesNotMatch(sql,/jsonb_agg\(to_jsonb\(s\)/);
 const edge=pappgRevalidationEmptySliceProbe();assert.equal(edge.validation.previous_document.blocks[0].start_utf16,0);
 assert.equal(edge.validation.previous_document.blocks[0].end_utf16,edge.validation.previous_document.reference.text_length);
 assert.throws(()=>pappgRevalidationRollbackSql({proposal:{...f.proposal,id:"';COMMIT;--"},validation,actor}));
});
test('each split native case has its own rollback, short timeout, unique safe backend tag and data-safe body delimiter',async()=>{
 const f=fixture(),validation=await validateProgramTextPappgRevalidation(f.proposal,f),tags=[];
 for(const case_name of ['success','bad_role','bad_raw_anchor','unauthorized','revocation','replay']){
  const sql=pappgRevalidationSingleRollbackSql({proposal:f.proposal,validation,actor,case_name});
  assert.ok(sql.startsWith('BEGIN;'));assert.ok(sql.trimEnd().endsWith('ROLLBACK;'));
  assert.ok(sql.includes("statement_timeout='20s'"));tags.push(sql.match(/application_name='([^']+)'/)[1]);
  assert.ok(sql.includes("SELECT 'PASS "+case_name+"' AS native_case"));
 }
 assert.equal(new Set(tags).size,6);assert.ok(tags.every(t=>t.length<=63));
 const hostile={...f.proposal,review:{...f.proposal.review,reason:'Untrusted $pappg_revalidation_rehearsal$ should never terminate an enclosing SQL body.'}};
 assert.throws(()=>pappgRevalidationRollbackSql({proposal:hostile,validation,actor}),/delimiter collision/);
 assert.doesNotThrow(()=>pappgRevalidationSingleRollbackSql({proposal:hostile,validation,actor}));
});
