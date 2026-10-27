import { validateProgramTextSourcePending } from "./program-text-source-approval.mjs";
import { PAPPG_CANONICAL_SOURCE_ID as selected,PAPPG_CANONICAL_OWNER_ID as owner,
  PAPPG_CANONICAL_URL as url,PAPPG_CANONICAL_COHORT as cohort,
  needsProgramTextCanonicalUrlAdmission } from "./program-text-canonical-url-admission.mjs";
const uuid=x=>typeof x==="string"&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(x)&&!/^0{8}(?:-0{4}){3}-0{12}$/.test(x);
const hash=x=>typeof x==="string"&&/^[a-f0-9]{64}$/.test(x);
const plain=x=>x!==null&&typeof x==="object"&&!Array.isArray(x);
const exact=(x,keys)=>plain(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
const canonical=x=>Array.isArray(x)?x.map(canonical):plain(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const equal=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
const fail=()=>{throw new Error("The finite PAPPG catalogue disposition could not be confirmed");};
const privatePayload=x=>Array.isArray(x)?x.some(privatePayload):plain(x)&&Object.entries(x).some(([key,value])=>
  ["raw_base64","raw_bytes","raw_source","source_text","blocks_json"].includes(key)||privatePayload(value));
async function result(query){const {data,error}=await query;if(error)fail();return data;}
export async function inspectProgramTextPappgCanonicalOperation(db,{epoch}={}) {
  if(!uuid(epoch))fail();
  const value=await result(db.rpc("inspect_program_text_pappg_canonical",{p_epoch:epoch}));
  if(!exact(value,["schema","epoch","context","context_hash"])||value.schema!=="awardping.program-text-pappg-canonical-inspection.v1"||
      value.epoch!==epoch||!plain(value.context)||privatePayload(value.context)||!hash(value.context_hash)||Buffer.byteLength(JSON.stringify(value))>200*1024)fail();
  return value;
}
export async function prepareProgramTextPappgCanonicalOperation(db,proposal,disposition,actor,context) {
  if(!uuid(actor)||!exact(disposition,["schema","context_hash","context","reason"])||
      disposition.schema!=="awardping.program-text-pappg-canonical-disposition.v1"||!hash(disposition.context_hash)||!plain(disposition.context)||
      typeof disposition.reason!=="string"||disposition.reason.trim().length<40||disposition.reason.length>2000||
      Buffer.byteLength(JSON.stringify(disposition))>200*1024||proposal?.schema!=="awardping.program-text-source-pending-request.v2"||
      proposal?.cohort_key!==cohort||proposal?.expected_canonical_shared_award_id!==owner||
      proposal?.source?.id!==selected||proposal.source.shared_award_id!==owner||proposal.source.url!==url||proposal.source.create!==true)fail();
  if(proposal.registration_scope?.kind!=="legacy_roles"||!Array.isArray(proposal.roles)||proposal.roles.length<1||proposal.roles.length>2||
      proposal.roles.some(role=>!["application_materials","current_documents"].includes(role?.source_role)))fail();
  // Ordinary retained RAW/provider-link, complete source context and role CAS
  // validation remain unchanged. The separate disposition is never an alias.
  const validation=await validateProgramTextSourcePending(proposal,context);
  const fresh=await inspectProgramTextPappgCanonicalOperation(db,context);
  if(fresh.context_hash!==disposition.context_hash||!equal(fresh.context,disposition.context))fail();
  return result(db.rpc("prepare_program_text_pappg_canonical",{p_proposal:proposal,p_validation:validation,
    p_disposition:disposition,p_actor:actor}));
}
export async function loadProgramTextPappgCanonicalDisposition(db,pendingId,{epoch,source}={}) {
  if(!needsProgramTextCanonicalUrlAdmission(source))return null;
  if(!uuid(pendingId)||!uuid(epoch))fail();
  const value=await result(db.rpc("get_program_text_pappg_canonical_disposition",{p_pending_id:pendingId,p_epoch:epoch}));
  if(value===null)return null;
  if(!exact(value,["schema","pending_id","epoch","selected_source_id","source_url","shared_award_id","cohort_key","revision","content_hash","current","context","reason","approval_id"])||
      value.schema!=="awardping.program-text-pappg-canonical-disposition-record.v1"||value.pending_id!==pendingId||!uuid(value.epoch)||
      value.selected_source_id!==selected||value.shared_award_id!==owner||value.source_url!==url||value.cohort_key!==cohort||
      !uuid(value.revision)||!hash(value.content_hash)||typeof value.current!=="boolean"||value.epoch!==epoch&&value.current||
      value.approval_id!==null&&!uuid(value.approval_id)||!plain(value.context)||privatePayload(value.context)||
      typeof value.reason!=="string"||value.reason.length>2000||Buffer.byteLength(JSON.stringify(value))>220*1024)fail();
  return value;
}
