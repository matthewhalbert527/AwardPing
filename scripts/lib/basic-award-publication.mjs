import {createHash} from 'node:crypto';
import {prepareBasicAwardFactReview,BASIC_AWARD_FACT_FIELDS} from './basic-award-facts.mjs';
export const BASIC_PUBLICATION_KIND='automated_source_verified_basics';
export const BASIC_PUBLICATION_PLAN_SCHEMA='awardping.basic-fact-publication-plan.v1';
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(v,keys)=>object(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v)&&!/^0{8}(?:-0{4}){3}-0{12}$/.test(v);
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const canonical=v=>Array.isArray(v)?v.map(canonical):object(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
export const basicPublicationHash=v=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
const equal=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
const check=(v,c)=>{if(!v)throw Error('Basic fact publication: '+c);};
export function assertBasicPublicationPlan(plan){
 check(exact(plan,['schema','kind','draft_id','input_review_hash','expected_head_id','selected_fields','prepared_at','receipt','receipt_hash'])&&
  plan.schema===BASIC_PUBLICATION_PLAN_SCHEMA&&plan.kind===BASIC_PUBLICATION_KIND&&uuid(plan.draft_id)&&hash(plan.input_review_hash)&&
  (plan.expected_head_id===null||uuid(plan.expected_head_id))&&Array.isArray(plan.selected_fields)&&plan.selected_fields.length>=1&&
  plan.selected_fields.length<=15&&new Set(plan.selected_fields).size===plan.selected_fields.length&&plan.selected_fields.includes('overview')&&
  plan.selected_fields.every(x=>BASIC_AWARD_FACT_FIELDS.includes(x))&&typeof plan.prepared_at==='string'&&
  Number.isFinite(Date.parse(plan.prepared_at))&&new Date(plan.prepared_at).toISOString()===plan.prepared_at&&object(plan.receipt)&&
  hash(plan.receipt_hash)&&basicPublicationHash(plan.receipt)===plan.receipt_hash&&plan.receipt.input_review_id===plan.draft_id&&
  plan.receipt.input_review_hash===plan.input_review_hash&&plan.receipt.reviewed_at===plan.prepared_at&&
  equal(plan.receipt.selected_fields,plan.selected_fields)&&Buffer.byteLength(JSON.stringify(plan))<=8*1024*1024,'invalid_frozen_plan');
 return plan;
}
async function inspect(draftId,deps){
 check(uuid(draftId)&&typeof deps.inspect==='function'&&typeof deps.loadCapture==='function','explicit_draft_and_cold_reader_required');
 const value=await deps.inspect(draftId);
 check(exact(value,['schema','draft','context','head_id'])&&value.schema==='awardping.basic-fact-draft-context.v1'&&value.draft?.id===draftId&&
  hash(value.draft.content_hash)&&object(value.context)&&(value.head_id===null||uuid(value.head_id)),'saved_draft_context_unconfirmed');
 return value;
}
/** Explicit selected fields only. Existing verified labels never select themselves. */
export async function prepareBasicFactPublication({draft_id,selected_fields,reviewed_at=new Date().toISOString()},deps){
 check(Array.isArray(selected_fields)&&selected_fields.length>=1&&selected_fields.length<=15&&new Set(selected_fields).size===selected_fields.length&&selected_fields.includes('overview')&&selected_fields.every(x=>BASIC_AWARD_FACT_FIELDS.includes(x)),'explicit_basic_selection_required');
 const value=await inspect(draft_id,deps);
 const prepared=await prepareBasicAwardFactReview(value.draft,{selected_fields,reviewed_at},{...value.context,loadCapture:deps.loadCapture});
 const plan=assertBasicPublicationPlan({schema:BASIC_PUBLICATION_PLAN_SCHEMA,kind:BASIC_PUBLICATION_KIND,draft_id,
  input_review_hash:value.draft.content_hash,expected_head_id:value.head_id,selected_fields:prepared.receipt.selected_fields,
  prepared_at:reviewed_at,receipt:prepared.receipt,receipt_hash:prepared.content_hash});
 return{plan,plan_hash:basicPublicationHash(plan),public_preview:plan.receipt.public_facts};
}
/** Rebuild from saved draft and cold originals immediately before ONE CAS call. */
export async function publishBasicFactPublication(plan,expectedPlanHash,deps){
 assertBasicPublicationPlan(plan);
 check(hash(expectedPlanHash)&&basicPublicationHash(plan)===expectedPlanHash,'root_frozen_plan_hash_changed');
 const now=deps.now?deps.now():Date.now(),at=Date.parse(plan.prepared_at);
 check(at<=now&&now-at<=15*60*1000,'fresh_prepared_plan_required');
 const value=await inspect(plan.draft_id,deps);
 check(value.draft.content_hash===plan.input_review_hash,'saved_draft_changed');
 const fresh=await prepareBasicAwardFactReview(value.draft,{selected_fields:plan.selected_fields,reviewed_at:plan.prepared_at},{...value.context,loadCapture:deps.loadCapture});
 check(fresh.content_hash===plan.receipt_hash&&equal(fresh.receipt,plan.receipt),'cold_source_or_projection_changed');
 check(typeof deps.commit==='function','service_cas_required');
 const result=await deps.commit({p_draft_id:plan.draft_id,p_expected_draft_hash:plan.input_review_hash,p_expected_head_id:plan.expected_head_id,
  p_receipt:fresh.receipt,p_receipt_hash:fresh.content_hash,p_plan_hash:expectedPlanHash});
 check(object(result)&&result.ok===true&&uuid(result.snapshot_id)&&typeof result.already_applied==='boolean'&&result.kind===BASIC_PUBLICATION_KIND,'publication_not_confirmed_do_not_repeat_blindly');
 return{snapshot_id:result.snapshot_id,kind:result.kind,already_applied:result.already_applied,plan_hash:expectedPlanHash};
}

export function createBasicPublicationRpcAdapter(db,loadCapture){
 check(typeof db?.rpc==='function'&&typeof loadCapture==='function','service_client_required');
 return{loadCapture,
  inspect:async id=>{const result=await db.rpc('inspect_program_basic_fact_draft',{p_id:id});check(!result.error&&result.data,'draft_context_unavailable');return result.data;},
  commit:async parameters=>{const result=await db.rpc('commit_program_basic_facts',parameters);check(!result.error&&result.data,'publication_not_confirmed_do_not_repeat_blindly');return result.data;},
 };
}

/** Explicit opt-in. The legacy adapter and all full-approval APIs remain strict. */
export function createCurrentBasicPublicationRpcAdapter(db,loadCapture){
 check(typeof db?.rpc==='function'&&typeof loadCapture==='function','service_client_required');
 return{loadCapture,
  inspect:async id=>{const r=await db.rpc('inspect_current_basic_fact_draft',{p_id:id});check(!r.error&&r.data,'current_draft_context_unavailable');return r.data;},
  commit:async p=>{const r=await db.rpc('commit_current_program_basic_facts',p);check(!r.error&&r.data,'current_publication_not_confirmed_do_not_repeat_blindly');return r.data;},
 };
}
