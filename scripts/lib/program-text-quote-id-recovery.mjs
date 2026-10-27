import {buildProgramTextComparison,buildProgramTextReviewPackets,validateProgramTextReviewResult} from './program-text-review.mjs';
import {validateProgramTextCapture} from './program-text-capture-contract.mjs';
import {programTextReference} from './program-text-artifacts.mjs';
export const PROGRAM_TEXT_QUOTE_ID_RECOVERY_POLICY='awardping.program-text-quote-id-recovery.v1';
export const PROGRAM_TEXT_QUOTE_ID_RECOVERY_CANDIDATE='8d40add5-89ea-4f96-9c31-f1f68c1fa472';
export const PROGRAM_TEXT_QUOTE_ID_RECOVERY_SOURCE='d4509d97-da9b-4e12-bbe9-45129e6ce1c1';
export const PROGRAM_TEXT_QUOTE_ID_RECOVERY_AWARD='d955a846-cee1-4c01-932e-e3cb7215f3fb';
export const PROGRAM_TEXT_QUOTE_ID_RECOVERY_WARNING='Approving resumes the existing worker; it may publish this scoped update after the unchanged normal checks. It does not approve current award facts.';
const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
export const quoteIdRecoveryEqual=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
const requireEqual=(a,b)=>{if(!quoteIdRecoveryEqual(a,b))throw Error('Recovery original or comparison changed.');};
const fail=()=>{throw Error('This saved response is outside the finite quotation-ID recovery policy.');};

/** Derive only the two known outer-row -> nested-side ID substitutions. This
 * never edits prose, values, labels, fields, confidence, ordering or prompts. */
export async function prepareProgramTextQuoteIdRecovery(candidate,{loadCapture}={}){
 if(!candidate||candidate.id!==PROGRAM_TEXT_QUOTE_ID_RECOVERY_CANDIDATE||candidate.shared_award_source_id!==PROGRAM_TEXT_QUOTE_ID_RECOVERY_SOURCE||
  candidate.shared_award_id!==PROGRAM_TEXT_QUOTE_ID_RECOVERY_AWARD||candidate.candidate_scope!=='program_text_change'||candidate.status!=='failed'||
  candidate.rejection_reason!=='manual_review_required:quote_not_bound_to_changed_block'||candidate.worker_metadata?.monitoring_contract!=='program-text-v1'||
  candidate.worker_metadata?.evidence_signature!==candidate.candidate_signature||typeof loadCapture!=='function')fail();
 const previous=await loadCapture(candidate.previous_snapshot_ref),current=await loadCapture(candidate.new_snapshot_ref);
 validateProgramTextCapture(previous);validateProgramTextCapture(current);
 requireEqual(programTextReference(previous),candidate.previous_snapshot_ref);requireEqual(programTextReference(current),candidate.new_snapshot_ref);
 const comparison=buildProgramTextComparison(previous,current,{epoch:candidate.worker_metadata.epoch,cycle_id:candidate.prompt_payload?.comparison?.context?.cycle_id});
 requireEqual(comparison,candidate.prompt_payload?.comparison);if(comparison.comparison_id!==candidate.candidate_signature)fail();
 const plan=buildProgramTextReviewPackets(comparison,candidate.prompt_payload?.packet_plan?.limits);requireEqual(plan,candidate.prompt_payload?.packet_plan);
 const original=candidate.ai_result?.responses,held=validateProgramTextReviewResult(comparison,plan,original);
 if(held.status!=='held'||!quoteIdRecoveryEqual(held.reasons,['quote_not_bound_to_changed_block'])||
  !Array.isArray(original)||original.length!==1||!Array.isArray(original[0]?.blocks)||original[0].blocks.length!==1||
  !Array.isArray(original[0].blocks[0]?.changes)||original[0].blocks[0].changes.length!==1||plan.packets?.length!==1||
  plan.packets[0].packet_id!==original[0].packet_id||comparison.changed_blocks?.length!==1)fail();
 const row=comparison.changed_blocks[0],response=original[0].blocks[0];if(response.id!==row.id||plan.packets[0].blocks?.length!==1||plan.packets[0].blocks[0].id!==row.id)fail();
 const projected=structuredClone(original),changes=[];
 for(const side of ['previous','current']){
  const block=row[side],quote=response.changes[0][side+'_quote'];
  if(!block||!quote||quote.block_id!==row.id||block.id===row.id||typeof quote.text!=='string'||!quote.text.length)fail();
  const start=block.text.indexOf(quote.text);if(start<0||block.text.indexOf(quote.text,start+1)>=0)fail();
  projected[0].blocks[0].changes[0][side+'_quote'].block_id=block.id;
  changes.push({path:`/0/blocks/0/changes/0/${side}_quote/block_id`,side,old_block_id:quote.block_id,new_block_id:block.id,quote:quote.text});
 }
 const validation=validateProgramTextReviewResult(comparison,plan,projected);if(validation.status!=='accepted')fail();
 if([row.previous.text,row.current.text].some(text=>Buffer.byteLength(text)>128000))fail();
 return{policy:PROGRAM_TEXT_QUOTE_ID_RECOVERY_POLICY,projected_responses:projected,changes,validation,
  summary:validation.details.summary,source:{id:current.source.id,url:current.source.url,title:current.source.title||null,final_url:current.final_url},
  changed_text:{previous:row.previous.text,current:row.current.text},warning:PROGRAM_TEXT_QUOTE_ID_RECOVERY_WARNING};
}
