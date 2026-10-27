import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {createSupabaseAdminClient} from "@/lib/supabase/admin";
import {createR2Client,getR2Bucket} from "@/lib/r2";
import monitoring from "../../config/program-text-monitoring.json";
import {loadProgramTextCapture} from "../../scripts/lib/program-text-artifacts.mjs";
import {createProgramTextRepository} from "../../scripts/lib/program-text-repository.mjs";
import {prepareProgramTextQuoteIdRecovery,quoteIdRecoveryEqual,PROGRAM_TEXT_QUOTE_ID_RECOVERY_CANDIDATE} from "../../scripts/lib/program-text-quote-id-recovery.mjs";
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==="object"&&!Array.isArray(value);
const hash=(value:unknown):value is string=>typeof value==="string"&&/^[a-f0-9]{64}$/.test(value);
export type QuoteIdRecoveryApproval={candidate_id:string;preimage_hash:string;projection_hash:string;reason:string};

async function inspection(candidateId:string){
 if(candidateId!==PROGRAM_TEXT_QUOTE_ID_RECOVERY_CANDIDATE)throw Error("Unsupported recovery candidate.");
 const db=createSupabaseAdminClient();const result=await(db as SupabaseClient).rpc("inspect_program_text_quote_id_recovery",{p_candidate:candidateId});
 const value:unknown=result.data;if(result.error||!object(value)||typeof value.already_applied!=="boolean")throw Error("Recovery state unavailable.");
 if(value.already_applied){if(!object(value.receipt)||value.receipt.candidate_id!==candidateId)throw Error("Invalid historical receipt.");return{db,value,preview:{candidate_id:candidateId,already_applied:true,receipt:value.receipt}};}
 if(!hash(value.preimage_hash)||!hash(value.projection_hash)||!object(value.candidate)||!object(value.source_identity_proof)||value.source_identity_proof.epoch!==monitoring.epoch)throw Error("Recovery state changed.");
 const client=createR2Client(),bucket=getR2Bucket(),cache=new Map<string,Promise<Awaited<ReturnType<typeof loadProgramTextCapture>>>>();
 const loadCapture=(ref:Parameters<typeof loadProgramTextCapture>[0])=>{const key=JSON.stringify(ref);if(!cache.has(key))cache.set(key,loadProgramTextCapture(ref,{client,bucket}));return cache.get(key)!;};
 const repository=createProgramTextRepository(db,{loadCapture,bucket});await repository.verifyCandidate(value.candidate);
 const prepared=await prepareProgramTextQuoteIdRecovery(value.candidate,{loadCapture});
 if(!quoteIdRecoveryEqual(prepared.projected_responses,value.projected_responses)||!quoteIdRecoveryEqual(prepared.changes,value.changes))throw Error("Independent recovery projections disagree.");
 return{db,value,preview:{schema:"awardping.program-text-quote-id-recovery-preview.v1",candidate_id:candidateId,already_applied:false,
  preimage_hash:value.preimage_hash,projection_hash:value.projection_hash,summary:prepared.summary,source:prepared.source,changed_text:prepared.changed_text,
  changes:prepared.changes,validation:prepared.validation,warning:prepared.warning}};
}
export async function loadProgramTextQuoteIdRecovery(candidateId:string){return(await inspection(candidateId)).preview;}
/** Called only by the authenticated, same-origin admin endpoint. */
export async function approveProgramTextQuoteIdRecovery(input:QuoteIdRecoveryApproval,actor:string){
 const prepared=await inspection(input.candidate_id);
 if(!prepared.value.already_applied&&(prepared.value.preimage_hash!==input.preimage_hash||prepared.value.projection_hash!==input.projection_hash))throw Error("Recovery preview changed.");
 const result=await(prepared.db as SupabaseClient).rpc("approve_program_text_quote_id_recovery",{p_candidate:input.candidate_id,p_preimage_hash:input.preimage_hash,
  p_projection_hash:input.projection_hash,p_reason:input.reason,p_actor:actor});
 if(result.error||!object(result.data)||result.data.candidate_id!==input.candidate_id||typeof result.data.already_applied!=="boolean")throw Error("No recovery transition was confirmed.");
 return result.data;
}
