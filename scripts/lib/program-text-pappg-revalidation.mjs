import {validateProgramTextCapture} from './program-text-capture-contract.mjs';
import {programTextReference,validateProgramTextReference} from './program-text-artifacts.mjs';
import {buildProgramTextRawAnchorProviderLink} from './program-text-source-raw-anchor.mjs';
import {PAPPG_CANONICAL_SOURCE_ID as selected,PAPPG_CANONICAL_OWNER_ID as owner,
 PAPPG_CANONICAL_URL as url,PAPPG_PRESERVED_SOURCE_IDS as preserved} from './program-text-canonical-url-admission.mjs';

export const PAPPG_REVALIDATION_SCHEMA='awardping.pappg-canonical-revalidation.v1';
export const PAPPG_REVALIDATION_VALIDATION_SCHEMA='awardping.pappg-canonical-revalidation-validation.v1';
export const PAPPG_REVALIDATION_INSPECTION_SCHEMA='awardping.pappg-canonical-revalidation-inspection.v1';
export const PAPPG_FOOTER_REMOVAL='Randolph Building, 401 Dulany Street, Alexandria, VA 22314 ';
const authorityId='c49e85e3-3b19-4052-891f-c2bc67e8b8f6';
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const exact=(x,keys)=>object(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(x)&&!/^0{8}(?:-0{4}){3}-0{12}$/.test(x);
const canonical=x=>Array.isArray(x)?x.map(canonical):object(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const equal=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
const check=(ok,reason)=>{if(!ok)throw Error('PAPPG revalidation: '+reason);};
const document=c=>({reference:programTextReference(c),text:c.text,blocks:c.blocks,blocks_json:JSON.stringify(canonical(c.blocks))});
const privatePayload=x=>Array.isArray(x)?x.some(privatePayload):object(x)&&Object.entries(x).some(([k,v])=>
 ['raw_base64','raw_source','raw_bytes','source_text','blocks_json'].includes(k)||privatePayload(v));

export async function inspectProgramTextPappgRevalidation(db,{epoch}){
 check(uuid(epoch),'current_epoch_required');
 const {data,error}=await db.rpc('inspect_program_text_pappg_revalidation',{p_epoch:epoch});
 check(!error&&exact(data,['schema','epoch','disposition_revision','previous_revision','original_authority_ref','inspection'])&&
  data.schema===PAPPG_REVALIDATION_INSPECTION_SCHEMA&&data.epoch===epoch&&uuid(data.disposition_revision)&&uuid(data.previous_revision)&&
  data.inspection?.schema==='awardping.program-text-pappg-canonical-inspection.v1'&&data.inspection.epoch===epoch&&
  /^[a-f0-9]{64}$/.test(data.inspection.context_hash||'')&&!privatePayload(data)&&Buffer.byteLength(JSON.stringify(data))<=1200*1024,
  'bounded_current_inspection_required');
 validateProgramTextReference(data.original_authority_ref);return data;
}

/** The sole permitted change is removal of this already duplicated postal
 * address from the retained footer. This is no general source reapproval. */
export function assertPappgFooterOnlyRevalidation(previous,current){
 for(const c of [previous,current])validateProgramTextCapture(c);
 check(equal(previous.source,current.source)&&previous.source.id===authorityId&&previous.source.shared_award_id===owner&&
  previous.final_url===current.final_url&&previous.acquisition===current.acquisition&&equal(previous.extractor,current.extractor)&&
  previous.completeness.status==='complete'&&current.completeness.status==='complete'&&
  previous.completeness.reasons.length===0&&current.completeness.reasons.length===0&&
  Date.parse(current.captured_at)>Date.parse(previous.captured_at),'complete_same_authority_pair_required');
 check(previous.text!==current.text&&previous.blocks.length===current.blocks.length,'only_reviewed_duplicate_footer_address_removal_allowed');
 let changes=0,expectedText=null;
 for(let i=0;i<previous.blocks.length;i++){
  const before=previous.blocks[i],after=current.blocks[i];
  const meaning=b=>{const {id,start_utf16,end_utf16,text,...rest}=b;return rest;};
  check(before.id===after.id&&equal(meaning(before),meaning(after)),'block_structure_or_context_changed');
  if(before.text!==after.text){
   changes++;
   check(before.text.split(PAPPG_FOOTER_REMOVAL).length===2&&before.text.replace(PAPPG_FOOTER_REMOVAL,'')===after.text&&
    before.text.includes('Print: Required Policy Links')&&before.text.includes('Publication date:')&&
    before.text.includes('Last updated:')&&before.text.includes('Footer About Us'),'changed_block_is_not_reviewed_footer');
   expectedText=previous.text.slice(0,before.start_utf16)+after.text+previous.text.slice(before.end_utf16);
  }
 }
 check(changes===1&&expectedText===current.text,'one_complete_footer_change_required');
}

export async function validateProgramTextPappgRevalidation(proposal,{inspection,actor,loadCapture,now=Date.now()}){
 check(exact(proposal,['schema','id','epoch','cohort_key','source_id','disposition_revision','expected_previous_revision','expected_context','authority_ref','link_proof','review'])&&
  proposal.schema===PAPPG_REVALIDATION_SCHEMA&&uuid(proposal.id)&&uuid(proposal.epoch)&&proposal.cohort_key==='nsf_grfp'&&
  proposal.source_id===selected&&uuid(proposal.disposition_revision)&&uuid(proposal.expected_previous_revision)&&
  equal(proposal.expected_context,inspection)&&proposal.epoch===inspection?.epoch&&
  proposal.disposition_revision===inspection.disposition_revision&&proposal.expected_previous_revision===inspection.previous_revision,
  'exact_existing_source_and_predecessor_required');
 const review=proposal.review,context=inspection.inspection?.context,source=context?.selected_source,authority=context?.authority;
 check(inspection.schema===PAPPG_REVALIDATION_INSPECTION_SCHEMA&&context?.cohort_key==='nsf_grfp'&&context.shared_award_id===owner&&
  context.selected_source_id===selected&&source?.id===selected&&source.shared_award_id===owner&&source.url===url&&
  Array.isArray(context.roles)&&context.roles.length===8&&new Set(context.roles.map(r=>r.source_role)).size===8&&
  Array.isArray(context.catalogue)&&context.catalogue.length===9&&equal(context.catalogue.map(s=>s.id??s.source_id).sort(),[...preserved].sort())&&
  authority?.id===authorityId&&authority.text_monitoring_state?.status==='baseline_ready'&&authority.text_monitoring_state.successful_checks>=2&&
  equal(authority.text_monitoring_state.latest_ref,authority.text_monitoring_state.baseline_ref)&&
  equal(proposal.authority_ref,authority.text_monitoring_state.latest_ref),'complete_current_finite_context_required');
 check(exact(review,['actor_id','reason','reviewed_at'])&&uuid(actor)&&review.actor_id===actor&&typeof review.reason==='string'&&
  review.reason.trim().length>=40&&review.reason.length<=2000&&typeof review.reviewed_at==='string'&&
  Number.isFinite(Date.parse(review.reviewed_at))&&new Date(review.reviewed_at).toISOString()===review.reviewed_at&&
  Date.parse(review.reviewed_at)<=now&&now-Date.parse(review.reviewed_at)<=15*60*1000,'fresh_explicit_review_required');
 check(typeof loadCapture==='function','cold_reader_required');validateProgramTextReference(proposal.authority_ref);
 const [previous,current]=await Promise.all([loadCapture(inspection.original_authority_ref),loadCapture(proposal.authority_ref)]);
 check(equal(programTextReference(previous),inspection.original_authority_ref)&&equal(programTextReference(current),proposal.authority_ref)&&
  Date.parse(current.captured_at)<=Date.parse(review.reviewed_at)&&now-Date.parse(current.captured_at)<=7*86400000,'cold_original_or_review_clock_changed');
 assertPappgFooterOnlyRevalidation(previous,current);
 const linkProposal={cohort_key:'nsf_grfp',expected_canonical_shared_award_id:owner,
  source:{id:selected,shared_award_id:owner,url,page_type:'other',expected_member_kind:'canonical'},
  authority_ref:proposal.authority_ref,link_proof:proposal.link_proof};
 const result={schema:PAPPG_REVALIDATION_VALIDATION_SCHEMA,proposal:structuredClone(proposal),previous_document:document(previous),
  authority_document:document(current),provider_link:buildProgramTextRawAnchorProviderLink(linkProposal,current)};
 check(Buffer.byteLength(JSON.stringify(result))<=16*1024*1024,'complete_validation_exceeds_bound');return result;
}

/** Explicit service caller only; importing this module never opens a client. */
export async function revalidateProgramTextPappgCanonical(db,proposal,actor,context){
 const fresh=await inspectProgramTextPappgRevalidation(db,{epoch:proposal?.epoch});
 check(equal(fresh,context.inspection),'reviewed_context_changed');
 const validation=await validateProgramTextPappgRevalidation(proposal,{...context,inspection:fresh,actor});
 const {data,error}=await db.rpc('revalidate_program_text_pappg_canonical',{p_proposal:proposal,p_validation:validation,p_actor:actor});
 check(!error&&data?.id===proposal.id&&data.source_id===selected&&/^[a-f0-9]{64}$/.test(data.content_hash||'')&&typeof data.idempotent==='boolean','service_receipt_unavailable');
 return data;
}
