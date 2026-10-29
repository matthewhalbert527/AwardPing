import{createHash}from'node:crypto';
import{buildProgramTextComparison,buildProgramTextReviewPackets,validateProgramTextReviewResult,qualifiedProgramDocumentReference}from'./program-text-review.mjs';
import{validateProgramTextCapture}from'./program-text-capture-contract.mjs';
import{programTextReference}from'./program-text-artifacts.mjs';

export const PROGRAM_TEXT_DOCUMENT_RECOVERY_POLICY='awardping.program-text-document-reference-recovery.v1';
export const PROGRAM_TEXT_DOCUMENT_RECOVERY_ACTOR='codex_operator:user_authorized_saved_response_recovery';
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const canonical=x=>Array.isArray(x)?x.map(canonical):object(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
export const documentRecoveryHash=x=>createHash('sha256').update(JSON.stringify(canonical(x))).digest('hex');
const equal=(a,b)=>documentRecoveryHash(a)===documentRecoveryHash(b);
const exact=(x,keys)=>object(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(x);
const hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const check=(x,m)=>{if(!x)throw Error('Saved document review recovery: '+m);};
const targetKeys=['candidate_id','source_id','award_id','source_url','epoch','comparison_id','original_responses_hash','previous_reference_hash','current_reference_hash','reservation_id','provider_batch_name'];

export function assertProgramTextDocumentRecoveryTarget(target){
 check(exact(target,targetKeys)&&['candidate_id','source_id','award_id','epoch','reservation_id'].every(k=>uuid(target[k]))&&
  ['comparison_id','original_responses_hash','previous_reference_hash','current_reference_hash'].every(k=>hex(target[k]))&&
  typeof target.source_url==='string'&&target.source_url.startsWith('https://')&&typeof target.provider_batch_name==='string'&&/^batches\/[a-z0-9]+$/i.test(target.provider_batch_name),'explicit finite reviewed target required');
 return target;
}

function assertFailedTarget(candidate,target){
 assertProgramTextDocumentRecoveryTarget(target);
 check(candidate?.id===target.candidate_id&&candidate.shared_award_source_id===target.source_id&&candidate.shared_award_id===target.award_id&&candidate.source_url===target.source_url&&
  candidate.candidate_scope==='program_text_change'&&candidate.status==='failed'&&candidate.rejection_reason==='manual_review_required:unsupported_program_field_evidence'&&
  candidate.worker_metadata?.monitoring_contract==='program-text-v1'&&candidate.worker_metadata.epoch===target.epoch&&candidate.candidate_signature===target.comparison_id&&
  candidate.worker_metadata.evidence_signature===target.comparison_id&&candidate.worker_metadata.gemini_spend_reservation_id===target.reservation_id&&candidate.gemini_batch_name===target.provider_batch_name&&
  candidate.ai_result?.program_text_validation?.status==='held'&&equal(candidate.ai_result.program_text_validation.reasons,['unsupported_program_field_evidence'])&&
  documentRecoveryHash(candidate.ai_result.responses)===target.original_responses_hash&&documentRecoveryHash(candidate.previous_snapshot_ref)===target.previous_reference_hash&&documentRecoveryHash(candidate.new_snapshot_ref)===target.current_reference_hash,
  'failed row differs from the exact reviewed target');
}

/** No model call or write. Restores both originals and replays the untouched
 * response against a narrow, source-framed document-reference policy. */
export async function validateSavedProgramTextDocumentRecovery(candidate,target,{loadCapture}={}){
 assertFailedTarget(candidate,target);check(typeof loadCapture==='function','cold original loader required');
 const previous=await loadCapture(candidate.previous_snapshot_ref),current=await loadCapture(candidate.new_snapshot_ref);
 for(const[ref,capture]of[[candidate.previous_snapshot_ref,previous],[candidate.new_snapshot_ref,current]]){
  validateProgramTextCapture(capture);check(capture.completeness.status==='complete'&&equal(programTextReference(capture),ref),'cold original or completeness changed');
  check(capture.source.id===target.source_id&&capture.source.shared_award_id===target.award_id&&capture.source.url===target.source_url,'cold source ownership or URL changed');
 }
 const comparison=buildProgramTextComparison(previous,current,{epoch:target.epoch,cycle_id:candidate.prompt_payload?.comparison?.context?.cycle_id});
 check(equal(comparison,candidate.prompt_payload?.comparison)&&comparison.comparison_id===target.comparison_id,'saved comparison differs from its originals');
 const packets=buildProgramTextReviewPackets(comparison,candidate.prompt_payload?.packet_plan?.limits);
 check(equal(packets,candidate.prompt_payload?.packet_plan)&&packets.status==='ready'&&packets.packets.length===1&&comparison.changed_blocks.length===1,'complete one-reference comparison required');
 const responses=candidate.ai_result.responses,row=comparison.changed_blocks[0];
 check(Array.isArray(responses)&&responses.length===1&&responses[0]?.blocks?.length===1&&responses[0].blocks[0]?.changes?.length===1,'one exact saved response required');
 const change=responses[0].blocks[0].changes[0];
 check(change.field==='documents'&&change.operation==='remove'&&change.current_quote===null,'only the reviewed removed document reference is recoverable');
 const reference=qualifiedProgramDocumentReference(change.previous_quote,null,row);
 check(reference?.side==='previous','source-framed complete document title required');
 const validation=validateProgramTextReviewResult(comparison,packets,responses);
 check(validation.status==='accepted'&&validation.details.program_changes.length===1&&validation.description_projections?.length===1&&validation.details.summary===`The page no longer lists “${reference.title}”.`,'corrected validation must retain page-scoped provenance');
 check(documentRecoveryHash(responses)===target.original_responses_hash,'saved response was changed');
 return{policy:PROGRAM_TEXT_DOCUMENT_RECOVERY_POLICY,validation,previous_reference:candidate.previous_snapshot_ref,current_reference:candidate.new_snapshot_ref,
  original_responses_hash:target.original_responses_hash,scope:'page_document_reference_removed',warning:'This resumes the existing saved review only. An owner decision is still required before any public update or notification.'};
}

function assertInspection(value,target){
 check(value?.schema==='awardping.program-text-document-recovery-inspection.v1'&&value.already_applied===false&&hex(value.preimage_hash)&&hex(value.responses_hash),'current service inspection required');
 assertFailedTarget(value.candidate,target);
 const proof=value.source_identity_proof,source=proof?.source,res=value.paid_reservation;
 check(proof?.epoch===target.epoch&&source?.id===target.source_id&&source.shared_award_id===target.award_id&&source.url===target.source_url&&
  source.text_monitoring_state?.status==='awaiting_review'&&equal(source.text_monitoring_state.baseline_ref,value.candidate.previous_snapshot_ref)&&equal(source.text_monitoring_state.latest_ref,value.candidate.new_snapshot_ref),'current source identity, authority or pair changed');
 check(res?.id===target.reservation_id&&res.status==='settled'&&res.provider_batch_name===target.provider_batch_name&&res.model===value.candidate.model&&res.request_count===1&&
  res.metadata?.candidate_id===target.candidate_id&&res.attempt_token===value.candidate.worker_metadata.gemini_spend_attempt_token&&res.work_fingerprint===`program-text:${target.comparison_id}:${value.candidate.model}`,'existing settled paid attempt required');
}

export async function prepareProgramTextDocumentRecovery({target,reason,prepared_at=new Date().toISOString()},deps){
 assertProgramTextDocumentRecoveryTarget(target);check(typeof reason==='string'&&reason.trim().length>=20&&reason.length<=2000,'explicit operator review reason required');
 check(typeof deps?.inspect==='function'&&typeof deps.loadCapture==='function'&&typeof prepared_at==='string'&&new Date(prepared_at).toISOString()===prepared_at,'service inspection and cold reader required');
 const value=await deps.inspect(target.candidate_id);assertInspection(value,target);
 const proof=await validateSavedProgramTextDocumentRecovery(value.candidate,target,deps);
 const again=await deps.inspect(target.candidate_id);assertInspection(again,target);
 check(again.preimage_hash===value.preimage_hash&&again.responses_hash===value.responses_hash,'authority or paid history changed during cold replay');
 const plan={schema:'awardping.program-text-document-recovery-plan.v1',policy:PROGRAM_TEXT_DOCUMENT_RECOVERY_POLICY,target,preimage_hash:value.preimage_hash,responses_hash:value.responses_hash,
  actor:PROGRAM_TEXT_DOCUMENT_RECOVERY_ACTOR,reason,prepared_at,proof};
 return{plan,plan_hash:documentRecoveryHash(plan),public_preview:proof.validation.details,creates_update:false,provider_calls:0};
}

/** One explicit atomic transition; never transport-retry an uncertain commit.
 * Exact idempotent receipts are history only and cannot reset a later source. */
export async function executeProgramTextDocumentRecovery(plan,expectedHash,deps){
 check(plan?.schema==='awardping.program-text-document-recovery-plan.v1'&&plan.policy===PROGRAM_TEXT_DOCUMENT_RECOVERY_POLICY&&plan.actor===PROGRAM_TEXT_DOCUMENT_RECOVERY_ACTOR&&hex(expectedHash)&&documentRecoveryHash(plan)===expectedHash,'frozen root-reviewed plan required');
 const now=deps.now?deps.now():Date.now(),at=Date.parse(plan.prepared_at);check(Number.isFinite(at)&&at<=now&&now-at<=15*60*1000,'fresh recovery plan required');
 const current=await deps.inspect(plan.target.candidate_id);
 if(current.already_applied===true){const r=current.receipt;check(r?.root_plan_hash===expectedHash&&r.preimage_hash===plan.preimage_hash&&r.responses_hash===plan.responses_hash&&r.actor===plan.actor&&r.reason===plan.reason,'a different recovery already exists');return{...r,already_applied:true,status:'historical_receipt'};}
 const fresh=await prepareProgramTextDocumentRecovery({target:plan.target,reason:plan.reason,prepared_at:plan.prepared_at},deps);
 check(fresh.plan_hash===expectedHash,'cold replay or exact recovery state changed');check(typeof deps.commit==='function','service-only atomic commit required');
 const result=await deps.commit({p_candidate:plan.target.candidate_id,p_preimage_hash:plan.preimage_hash,p_responses_hash:plan.responses_hash,p_root_plan_hash:expectedHash,p_reason:plan.reason,p_actor:plan.actor});
 check(result?.status==='succeeded'&&result.candidate_id===plan.target.candidate_id&&uuid(result.journal_id)&&typeof result.already_applied==='boolean','recovery not confirmed; inspect saved state before retrying');
 return{...result,creates_update:false,provider_calls:0,next_action:'ordinary_saved_response_review_then_owner_alert_decision'};
}
