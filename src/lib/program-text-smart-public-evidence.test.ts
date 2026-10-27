import {describe,it,expect,vi} from 'vitest';
vi.mock('server-only',()=>({}));
import {SMART_GUIDE_KB_SOURCE_PROFILES,SMART_GUIDE_AUTHORITY_PROFILES} from '../../scripts/lib/program-text-smart-guide-profiles.mjs';
import {hasPublishableProgramTextEvidence} from './program-text-event-evidence';
import {isPublicChangeEvent,hasPublishableEventEvidence,type PublicChangeEventVisualEvidence} from '@/lib/public-change-event';
import type {Stage1PublicationEntry} from '@/lib/stage1-publication';
import type {Json} from '@/lib/database.types';

// Synthetic reference/wording fixtures only. No provider capture, approved fact
// or source grant is manufactured. Existing publication gates are exercised.
const owner='d7d4d117-f312-456f-a75c-3dbd5d372c99';
type Profile={id:string;shared_award_id:string;url:string;title:string;page_type:string;version:string};
const authority=SMART_GUIDE_AUTHORITY_PROFILES as readonly Profile[];
const guides=SMART_GUIDE_KB_SOURCE_PROFILES as readonly Profile[];
const profiles=[...authority,...guides];
const record=(value:unknown)=>value as Record<string,Json>;
function fixture(p:Profile){
 const previous='SMART application deadline: October 1, 2027.',current='SMART application deadline: October 15, 2027.';
 const block=(text:string)=>({id:'programme-prose',text,start_utf16:0,end_utf16:text.length,heading:'Application deadline',page:null,kind:'paragraph',context:{representation:'publisher_text',verbatim:true}});
 const reference=(text:string,day:number,id:string)=>({schema:'awardping.program-text-reference.v1',kind:'program_text',capture_id:id,
  source:{id:p.id,shared_award_id:p.shared_award_id,url:p.url,title:p.title,page_type:p.page_type},final_url:p.url,captured_at:`2026-10-${day}T12:00:00.000Z`,
  acquisition:'publisher_json',extractor:{name:'smart-publisher-json',version:p.version},text_sha256:'c'.repeat(64),text_length:text.length,blocks_sha256:'d'.repeat(64),
  completeness:{status:'complete',reasons:[]},artifacts:Object.fromEntries(['raw','text','metadata'].map(role=>[role,{object_key:`program-text/sources/${p.id}/${id}/${role==='raw'?'original.json':role==='text'?'text.txt':'metadata.json'}`,
   sha256:role==='text'?'c'.repeat(64):'e'.repeat(64),byte_length:role==='text'?text.length:200,content_type:role==='text'?'text/plain; charset=utf-8':'application/json'}]))});
 const quote=(text:string)=>({block_id:'programme-prose',start_utf16:0,end_utf16:text.length,text});
 const changes=[{field:'deadline',operation:'replace',summary:'The application deadline moved to October 15, 2027.',previous_quote:quote(previous),current_quote:quote(current)}];
 const details={schema:'awardping.program-change.v1',event_kind:'program_details_changed',summary:'The SMART application deadline moved to October 15, 2027.',program_changes:changes};
 const event={id:'3a710000-0000-4000-8000-000000000001',shared_award_id:p.shared_award_id,shared_award_source_id:p.id,source_url:p.url,source_title:p.title,
  source_page_type:p.page_type,summary:details.summary,change_details:details,visual_review_candidate_id:'3a710000-0000-4000-8000-000000000002'};
 const evidence={id:'3a710000-0000-4000-8000-000000000003',change_event_id:event.id,shared_award_id:p.shared_award_id,shared_award_source_id:p.id,
  visual_review_candidate_id:event.visual_review_candidate_id,candidate_signature:'f'.repeat(64),bucket:'SYNTHETIC-OFFLINE-TEST',evidence_schema_version:'program-text-event-evidence-v1',evidence_status:'verified_text',
  previous_capture:reference(previous,10,'a'.repeat(64)),current_capture:reference(current,11,'b'.repeat(64)),localization:{schema:'awardping.program-text-publication.v1',epoch:'ec349339-ff62-4d2e-a610-8c361b4044ec',comparison_id:'f'.repeat(64),program_changes:changes,supporting_blocks:{previous:[block(previous)],current:[block(current)]}},
  created_at:'2026-10-11T12:05:00.000Z',verified_at:'2026-10-11T12:05:00.000Z',backfilled_at:null} as unknown as PublicChangeEventVisualEvidence;
 const publication={canonicalAwardId:owner,memberAwardIds:[owner,'1efa2a75-e6b8-4bf6-80be-85ef2f6b3108'],allowedSourceIds:[p.id],allowedSourceIdSet:new Set([p.id]),publishedFacts:{},sourceIdentityRules:[],effectivelyVerified:true} as unknown as Stage1PublicationEntry;
 return{event,evidence,source:{...p,admin_review_status:'open'},publication,award:{id:owner,name:'SMART Scholarship',status:'active'}};
}
describe('finite SMART public text programme changes',()=>{
 it('keeps exactly6 previous identities and12 new reviewed guides',()=>{expect(SMART_GUIDE_AUTHORITY_PROFILES).toHaveLength(6);expect(SMART_GUIDE_KB_SOURCE_PROFILES).toHaveLength(12);expect(new Set(profiles.map(p=>p.id)).size).toBe(18);});
 it.each(profiles.map(p=>[p.id,p] as const))('permits exact prose evidence for source %s through shared feed predicate',(_,p)=>{
  const f=fixture(p);expect(hasPublishableProgramTextEvidence(f.event,f.evidence)).toBe(true);expect(hasPublishableEventEvidence(f.event,f.evidence)).toBe(true);expect(isPublicChangeEvent(f)).toBe(true);
 });
 it.each(['owner','type','query','final_query','source_id','extractor','version','unknown_id'] as const)('rejects altered finite identity %s',field=>{
  const f=fixture(profiles.at(-1)!);for(const value of [f.evidence.previous_capture,f.evidence.current_capture]){const r=record(value),s=record(r.source);
   if(field==='owner')s.shared_award_id='3a710000-0000-4000-8000-000000000090';
   if(field==='type')s.page_type='other';if(field==='query')s.url+='&extra=1';if(field==='final_query')r.final_url+='&extra=1';
   if(field==='source_id')s.id=profiles[0].id;if(field==='extractor')record(r.extractor).name='unreviewed';if(field==='version')record(r.extractor).version='unreviewed';
   if(field==='unknown_id')s.id='3a710000-0000-4000-8000-000000000091';}
  expect(hasPublishableProgramTextEvidence(f.event,f.evidence)).toBe(false);
 });
 it.each(guides.map(p=>[p.id,p] as const))('requires exact title for new guide %s',(_,p)=>{
  const f=fixture(p);record(record(f.evidence.current_capture).source).title+=' changed';expect(hasPublishableProgramTextEvidence(f.event,f.evidence)).toBe(false);
 });
 it('preserves original2 title behavior and alias ownership',()=>{
  for(const p of authority.filter(p=>['58aefec0-0d42-4b7b-9887-60d25940b3d0','c33cc2f4-2cbd-458c-b630-537eb3d50f72'].includes(p.id))){const f=fixture(p);for(const r of [f.evidence.previous_capture,f.evidence.current_capture])record(record(r).source).title='Historical reviewed title';expect(hasPublishableProgramTextEvidence(f.event,f.evidence)).toBe(true);}
  const alias=fixture(authority.find(p=>p.shared_award_id!==owner)!);for(const r of [alias.evidence.previous_capture,alias.evidence.current_capture])record(record(r).source).shared_award_id=owner;expect(hasPublishableProgramTextEvidence(alias.event,alias.evidence)).toBe(false);
 });
 it.each(['kind','context'] as const)('never quotes generated publisher_data (%s)',mode=>{
  const f=fixture(profiles.at(-1)!);const blocks=record(record(f.evidence.localization).supporting_blocks).current as Json[];const block=record(blocks[0]);if(mode==='kind')block.kind='publisher_data';else block.context={representation:'publisher_data',verbatim:false};expect(hasPublishableProgramTextEvidence(f.event,f.evidence)).toBe(false);
 });
 it.each(['html_tag','guide_html'] as const)('rejects publisher identity masquerade %s',mode=>{
  const f=fixture(profiles.at(-1)!);for(const value of [f.evidence.previous_capture,f.evidence.current_capture]){const r=record(value);r.acquisition='http_html';for(const [role,a]of Object.entries(record(r.artifacts)))if(role==='raw'){record(a).object_key=String(record(a).object_key).replace('original.json','original.html');record(a).content_type='text/html';}if(mode==='guide_html')r.extractor={name:'plain-html',version:'1'};}expect(hasPublishableProgramTextEvidence(f.event,f.evidence)).toBe(false);
 });
 it('still requires source publication, exact variant binding and non-suppressed event',()=>{
  const f=fixture(profiles.at(-1)!);f.publication.allowedSourceIdSet.clear();expect(isPublicChangeEvent(f)).toBe(false);
  const held=fixture(profiles.at(-1)!);held.source.admin_review_status='review_later';expect(isPublicChangeEvent(held)).toBe(false);
  held.publication.textFactReview={id:'approved',reviewedAt:'2026-10-11T12:05:00Z',current:true,releaseRevision:'release',variationInventoryId:'inventory'};
  held.publication.approvedTextSourceBindings={[held.source.id]:{url:held.source.url,shared_award_id:held.source.shared_award_id}};expect(isPublicChangeEvent(held)).toBe(true);
  held.publication.approvedTextSourceBindings[held.source.id].url+='&changed=1';expect(isPublicChangeEvent(held)).toBe(false);
  expect(isPublicChangeEvent({...fixture(profiles.at(-1)!),event:{...fixture(profiles.at(-1)!).event,suppressed_at:'2026-10-11T12:06:00Z'}})).toBe(false);
 });
});
