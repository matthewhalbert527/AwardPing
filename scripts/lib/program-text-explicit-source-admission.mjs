import {validateProgramTextCapture} from './program-text-capture-contract.mjs';
import {programTextReference,validateProgramTextReference} from './program-text-artifacts.mjs';

export const EXPLICIT_SOURCE_ADMISSION_SCHEMA='awardping.explicit-official-source-admission.v1';
export const EXPLICIT_SOURCE_ADMISSION_VALIDATION_SCHEMA='awardping.explicit-official-source-admission-validation.v1';
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const exact=(x,keys)=>object(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(x)&&!/^0{8}(?:-0{4}){3}-0{12}$/.test(x);
const canonical=x=>Array.isArray(x)?x.map(canonical):object(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const equal=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
const check=(ok,reason)=>{if(!ok)throw Error('Explicit official source admission: '+reason);};
function url(value){
 check(typeof value==='string'&&value.length<=4096&&/^https:\/\/[a-z0-9.-]+(?:\/[A-Za-z0-9_./-]*)?$/.test(value)&&!value.includes('/../')&&!value.includes('/./'),'conservative_exact_https_url_required');
 const parsed=new URL(value);check(parsed.href===value&&!parsed.username&&!parsed.password&&!parsed.port&&!parsed.hash&&!parsed.search,'canonical_https_url_required');return parsed;
}

/** Explicit human review is independent of hyperlink provenance. No network,
 * database, source membership, baseline or fact publication operation occurs. */
export async function validateExplicitOfficialSourceAdmission(proposal,{registry,epoch,roles,actor,target_ref,loadCapture,now=Date.now()}){
 check(exact(proposal,['schema','id','cohort_key','epoch','expected_canonical_shared_award_id','expected_official_homepage','source','roles','registration_scope','review'])&&
  proposal.schema===EXPLICIT_SOURCE_ADMISSION_SCHEMA&&uuid(proposal.id)&&uuid(proposal.epoch)&&proposal.epoch===epoch&&
  uuid(proposal.expected_canonical_shared_award_id)&&/^[a-z0-9_-]{1,80}$/.test(proposal.cohort_key||'')&&
  Buffer.byteLength(JSON.stringify(proposal))<=262144,'explicit_request_shape');
 const source=proposal.source,review=proposal.review;
 check(exact(source,['id','shared_award_id','url','title','page_type'])&&uuid(source.id)&&uuid(source.shared_award_id)&&
  typeof source.title==='string'&&source.title.trim().length>=1&&source.title.length<=1000&&
  ['homepage','deadline','eligibility','application','requirements','faq','pdf','other'].includes(source.page_type),'new_canonical_source_shape');
 check(registry?.cohort_key===proposal.cohort_key&&registry.canonical_shared_award_id===proposal.expected_canonical_shared_award_id&&
  source.shared_award_id===registry.canonical_shared_award_id&&registry.official_homepage===proposal.expected_official_homepage&&
  url(source.url).origin===url(proposal.expected_official_homepage).origin,'exact_registry_official_origin_required');
 check(exact(proposal.registration_scope,['kind'])&&proposal.registration_scope.kind==='legacy_roles','legacy_role_scope_only');
 check(exact(review,['actor_id','reason','purpose','reviewed_at'])&&uuid(actor)&&review.actor_id===actor&&
  typeof review.reason==='string'&&review.reason.trim().length>=20&&review.reason.length<=2000&&
  typeof review.purpose==='string'&&review.purpose.trim().length>=20&&review.purpose.length<=2000&&
  typeof review.reviewed_at==='string'&&Number.isFinite(Date.parse(review.reviewed_at))&&new Date(review.reviewed_at).toISOString()===review.reviewed_at&&
  Date.parse(review.reviewed_at)<=now&&now-Date.parse(review.reviewed_at)<=15*60*1000,'fresh_explicit_actor_reason_and_purpose_required');
 check(Array.isArray(roles)&&roles.length>=1&&roles.length<=50&&Array.isArray(proposal.roles)&&proposal.roles.length===roles.length&&
  new Set(proposal.roles.map(r=>r?.source_role)).size===roles.length,'entire_current_role_snapshot_required');
 let additions=0;
 for(const next of proposal.roles){
  const before=roles.find(r=>r.source_role===next.source_role);
  check(exact(next,['source_role','expected_revision','expected_source_ids','next_source_ids'])&&before&&uuid(next.expected_revision)&&
   next.expected_revision===before.revision&&equal(next.expected_source_ids,before.source_ids)&&
   /^[a-z][a-z0-9_]{0,79}$/.test(next.source_role)&&[next.expected_source_ids,next.next_source_ids].every(ids=>Array.isArray(ids)&&ids.length>=1&&ids.length<=50&&ids.every(uuid)&&new Set(ids).size===ids.length)&&
   !next.expected_source_ids.includes(source.id)&&
   (equal(next.next_source_ids,next.expected_source_ids)||equal(next.next_source_ids,[...next.expected_source_ids,source.id])),'exact_add_only_role_cas_required');
  if(next.next_source_ids.length>next.expected_source_ids.length)additions++;
 }
 check(additions>0,'at_least_one_reviewed_role_addition_required');
 validateProgramTextReference(target_ref);check(typeof loadCapture==='function','cold_original_reader_required');
 const capture=await loadCapture(target_ref);validateProgramTextCapture(capture,{source});
 check(capture.completeness.status==='complete'&&capture.completeness.reasons.length===0&&equal(programTextReference(capture),target_ref)&&
  equal(target_ref.source,source)&&target_ref.final_url===source.url&&['http_html','pdf_text'].includes(target_ref.acquisition)&&
  Date.parse(target_ref.captured_at)<=Date.parse(review.reviewed_at)&&now-Date.parse(target_ref.captured_at)<=7*86400000,'complete_fresh_exact_target_original_required');
 const document={reference:target_ref,text:capture.text,blocks:capture.blocks,blocks_json:JSON.stringify(canonical(capture.blocks))};
 check(Buffer.byteLength(JSON.stringify(document))<=16*1024*1024,'bounded_complete_document_required');
 return{schema:EXPLICIT_SOURCE_ADMISSION_VALIDATION_SCHEMA,proposal:structuredClone(proposal),target_document:document};
}
