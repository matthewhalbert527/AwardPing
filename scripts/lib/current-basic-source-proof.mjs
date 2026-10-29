import { createHash } from 'node:crypto';
import { validateProgramTextReference, programTextReference } from './program-text-artifacts.mjs';
import { validateProgramTextCapture } from './program-text-capture-contract.mjs';
import { hasProgramTextSourceAccess } from './program-text-source-access.mjs';
import { hasUnclearedProgramTextCollectionFailure } from './program-text-collection-quality.mjs';

export const CURRENT_BASIC_VALIDATION_SCHEMA='awardping.current-basic-fact-validation.v1';
export const CURRENT_BASIC_RECEIPT_SCHEMA='awardping.current-basic-award-fact-review.v1';
export const CURRENT_BASIC_FIELDS=Object.freeze(['overview','opening_date','deadline','cycle_status','important_dates','eligibility','citizenship','academic_levels','disciplines','award_amounts','stipend','tuition','travel_research_allowance','tenure','application_url']);
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const canonical=x=>Array.isArray(x)?x.map(canonical):object(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
export const currentBasicHash=x=>createHash('sha256').update(JSON.stringify(canonical(x))).digest('hex');
export const currentBasicEqual=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(x)&&!/^0{8}(?:-0{4}){3}-0{12}$/.test(x);
const sha=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const check=(x,m)=>{if(!x)throw Error('Current basic facts: '+m);};

/** Content identity ignores a new observation's clock/key, never its text/scope.
 * Binary PDF changes remain a hold even when extracted text happens to match. */
export function currentBasicContentIdentity(ref){
 validateProgramTextReference(ref);
 return {source:{id:ref.source.id,shared_award_id:ref.source.shared_award_id,url:ref.source.url},final_url:ref.final_url,
  acquisition:ref.acquisition,extractor:ref.extractor,text_sha256:ref.text_sha256,blocks_sha256:ref.blocks_sha256,
  pdf_raw_sha256:ref.acquisition.startsWith('pdf_')?ref.artifacts.raw.sha256:null};
}

export function assertCurrentBasicSource(source,ref,{registry,epoch,pending_alert_reviews=[]}){
 validateProgramTextReference(ref);const s=source?.text_monitoring_state;
 check(hasProgramTextSourceAccess(source,{epoch,cohort:registry.cohort_key})&&s?.schema==='awardping.program-text-state.v1'&&s.epoch===epoch&&
  Number.isInteger(s.successful_checks)&&s.successful_checks>=2&&currentBasicEqual(s.latest_ref,ref)&&
  ref.source.id===source.id&&ref.source.shared_award_id===source.shared_award_id&&ref.source.url===source.url&&
  Date.parse(s.first_captured_at)<Date.parse(ref.captured_at)&&Date.parse(ref.captured_at)<=Date.parse(s.last_checked_at),'current_source_identity_or_repeat_history');
 check(!hasUnclearedProgramTextCollectionFailure(source,epoch),'current_source_quality_hold');
 if(s.status==='baseline_ready'){check(currentBasicEqual(s.baseline_ref,s.latest_ref),'ready_source_pair_differs');return null;}
 check(s.status==='awaiting_review','source_not_ready_or_owner_pending');
 const rows=pending_alert_reviews.filter(r=>r.source_id===source.id);
 check(rows.length===1,'exact_pending_owner_review_required');const p=rows[0];
 check(uuid(p.id)&&p.id===p.candidate_id&&p.candidate_scope==='program_text_change'&&p.candidate_status==='succeeded'&&p.review_status==='pending'&&
  p.owner_id===source.shared_award_id&&p.source_url===source.url&&p.epoch===epoch&&sha(p.candidate_signature)&&sha(p.content_hash)&&
  p.content_hash===p.expected_content_hash&&currentBasicEqual(p.previous_ref,s.baseline_ref)&&currentBasicEqual(p.current_ref,ref),
  'pending_owner_review_is_not_current_and_verified');
 return {id:p.id,content_hash:p.content_hash};
}

export function currentBasicSourceProof(source,ref,context){
 const pending=assertCurrentBasicSource(source,ref,context),selected=context.repeat_observation_ids?.filter(r=>r.source_id===source.id)||[];
 check(selected.length===1&&uuid(selected[0].id),'explicit_retained_repeat_required');
 const rows=context.repeat_observations?.filter(r=>r.id===selected[0].id)||[];check(rows.length===1,'retained_repeat_ledger_missing');const r=rows[0];
 check(r.cohort_key===context.registry.cohort_key&&r.source_id===source.id&&r.epoch===context.epoch&&
  currentBasicEqual(r.content_identity,currentBasicContentIdentity(ref))&&currentBasicEqual(currentBasicContentIdentity(r.current_ref),r.content_identity)&&
  currentBasicEqual(currentBasicContentIdentity(r.repeat_ref),r.content_identity)&&r.current_ref.capture_id!==r.repeat_ref.capture_id&&
  r.current_ref.captured_at!==r.repeat_ref.captured_at&&r.current_ref.artifacts.metadata.object_key!==r.repeat_ref.artifacts.metadata.object_key&&
  Number.isFinite(Date.parse(r.verified_at))&&Date.parse(r.verified_at)>=Math.max(Date.parse(r.current_ref.captured_at),Date.parse(r.repeat_ref.captured_at)),
  'retained_repeat_does_not_prove_current_content');
 return {source_id:source.id,repeat_observation_id:r.id,pending_alert_review_id:pending?.id||null,pending_alert_review_hash:pending?.content_hash||null};
}

/** Prepare one service-only repeat attestation from two genuinely retained,
 * complete originals. No capture, database mutation, model or alert operation. */
export async function prepareCurrentBasicRepeat({current_ref,repeat_ref,verified_at},context){
 const source=context.sources.find(s=>s.id===current_ref?.source?.id);assertCurrentBasicSource(source,current_ref,context);
 check(typeof context.loadCapture==='function'&&typeof verified_at==='string'&&new Date(verified_at).toISOString()===verified_at,'cold_reader_and_clock_required');
 check(current_ref.capture_id!==repeat_ref?.capture_id&&current_ref.captured_at!==repeat_ref?.captured_at&&
  current_ref.artifacts.metadata.object_key!==repeat_ref?.artifacts?.metadata?.object_key&&
  currentBasicEqual(currentBasicContentIdentity(current_ref),currentBasicContentIdentity(repeat_ref)),'independent_same_content_repeat_required');
 check(Date.parse(verified_at)>=Math.max(Date.parse(current_ref.captured_at),Date.parse(repeat_ref.captured_at)),'repeat_attestation_precedes_capture');
 const documents=[];
 for(const ref of [current_ref,repeat_ref]){const c=await context.loadCapture(ref);validateProgramTextCapture(c,{source});
  check(c.completeness.status==='complete'&&currentBasicEqual(programTextReference(c),ref),'repeat_original_incomplete_or_changed');
  documents.push({reference:ref,text:c.text,blocks:c.blocks,blocks_json:JSON.stringify(canonical(c.blocks))});}
 check(Buffer.byteLength(JSON.stringify(documents))<=32*1024*1024,'bounded_repeat_originals_required');
 return {p_cohort_key:context.registry.cohort_key,p_current_ref:current_ref,p_repeat_document:documents[1],p_verified_at:verified_at};
}
