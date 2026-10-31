import { validateCurrentBasicFactReview, PROGRAM_FACT_FIELDS, programFactPublicValues } from './program-text-facts.mjs';
import { CURRENT_BASIC_RECEIPT_SCHEMA, CURRENT_BASIC_FIELDS, currentBasicEqual, currentBasicHash } from './current-basic-source-proof.mjs';
import { quotedApplicationDestination } from './basic-award-facts.mjs';
import {currentBasicProofSelection} from './current-basic-reviewed-repeat.mjs';

const check=(ok,reason)=>{if(!ok)throw Error('Current basic publication: '+reason);};
/** Independent facts purpose; never decides a queued alert or advances a source. */
export async function prepareCurrentBasicAwardFactReview(draft,{selected_fields,reviewed_at},context){
 check(Array.isArray(selected_fields)&&selected_fields.length>0&&selected_fields.length<=15&&selected_fields.includes('overview')&&
  new Set(selected_fields).size===selected_fields.length&&selected_fields.every(f=>CURRENT_BASIC_FIELDS.includes(f)), 'explicit_basic_selection');
 const validated=await validateCurrentBasicFactReview(draft.validation.review,{...context,forApproval:false,
  repeat_observation_ids:draft.validation.current_source_proofs?.map(currentBasicProofSelection)});
 check(currentBasicEqual(validated,draft.validation),'saved_validation_or_current_sources_changed');
 const review=validated.review;
 check(review.fields.filter(f=>selected_fields.includes(f.field)).length===selected_fields.length&&
  review.fields.filter(f=>selected_fields.includes(f.field)).every(f=>f.status==='verified'),'selected_field_not_verified');
 const overview=review.fields.find(f=>f.field==='overview');check(overview.items.length===1&&overview.items[0].track===null,'shared_overview_required');
 for(const field of review.fields.filter(f=>selected_fields.includes(f.field)))for(const item of field.items){
  if(['deadline','opening_date'].includes(field.field)){const years=new Set(item.support.flatMap(q=>q.text.match(/\b(?:19|20)\d{2}\b/g)||[]));
   check(!(item.value.match(/\b(?:19|20)\d{2}\b/g)||[]).some(y=>!years.has(y)),'unquoted_date_year');}
  if(field.field==='application_url')check(quotedApplicationDestination(item,validated.source_text),'application_destination_not_quoted');
 }
 const selected=new Set(selected_fields),public_facts=programFactPublicValues({...review,fields:PROGRAM_FACT_FIELDS.map(field=>selected.has(field)?
  review.fields.find(f=>f.field===field):{field,status:'unresolved',items:[],note:'Outside this selected basic-information snapshot.'})});
 const receipt={schema:CURRENT_BASIC_RECEIPT_SCHEMA,cohort_key:review.cohort_key,award_id:review.award_id,epoch:review.epoch,cycle:review.cycle,
  input_review_id:draft.id,input_review_hash:draft.content_hash,selected_fields:CURRENT_BASIC_FIELDS.filter(f=>selected.has(f)),reviewed_at,
  roster:review.roster,supporting_capture_refs:review.capture_refs,current_capture_refs:review.capture_refs,public_facts,
  current_source_proofs:validated.current_source_proofs};
 return{receipt,content_hash:currentBasicHash(receipt)};
}
