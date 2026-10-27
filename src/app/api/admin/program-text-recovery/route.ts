import {NextResponse} from "next/server";
import {getCurrentUser,isSiteAdminEmail} from "@/lib/auth";
import {validateSameOriginAdminMutation} from "@/lib/admin-request-security";
import {loadProgramTextQuoteIdRecovery,approveProgramTextQuoteIdRecovery} from "@/lib/program-text-quote-id-recovery.server";
import {PROGRAM_TEXT_QUOTE_ID_RECOVERY_CANDIDATE} from "../../../../../scripts/lib/program-text-quote-id-recovery.mjs";
export const runtime="nodejs";
const headers={"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"};
const reply=(value:unknown,status=200)=>NextResponse.json(value,{status,headers});
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==="object"&&!Array.isArray(value);
const hash=(value:unknown):value is string=>typeof value==="string"&&/^[a-f0-9]{64}$/.test(value);
async function authorize(){const user=await getCurrentUser();return!user?{error:reply({error:"Sign in to review this saved response."},401),actor:null}:
 !isSiteAdminEmail(user.email)?{error:reply({error:"Administrator access required."},403),actor:null}:{error:null,actor:user.id};}
async function body(request:Request){
 if(request.headers.get("content-type")?.split(";")[0].trim().toLowerCase()!=="application/json")throw Error("json");
 const limit=16384;if(Number(request.headers.get("content-length"))>limit)throw Error("size");
 const reader=request.body?.getReader();if(!reader)throw Error("json");const chunks:Uint8Array[]=[];let length=0;
 try{for(;;){const part=await reader.read();if(part.done)break;length+=part.value.byteLength;if(length>limit){await reader.cancel();throw Error("size");}chunks.push(part.value);}}
 finally{reader.releaseLock();}return JSON.parse(Buffer.concat(chunks).toString("utf8"))as unknown;
}
export async function GET(request:Request){
 const auth=await authorize();if(auth.error)return auth.error;const query=new URL(request.url).searchParams;
 if([...query.keys()].some(key=>key!=="candidate")||query.getAll("candidate").length!==1||query.get("candidate")!==PROGRAM_TEXT_QUOTE_ID_RECOVERY_CANDIDATE)
  return reply({error:"Choose the supported saved response."},404);
 try{return reply(await loadProgramTextQuoteIdRecovery(PROGRAM_TEXT_QUOTE_ID_RECOVERY_CANDIDATE));}
 catch{return reply({error:"The current failed response and its complete retained originals could not be confirmed."},409);}
}
export async function POST(request:Request){
 const origin=validateSameOriginAdminMutation(request);if(origin){Object.entries(headers).forEach(([k,v])=>origin.headers.set(k,v));return origin;}
 const auth=await authorize();if(auth.error)return auth.error;let value:unknown;
 try{value=await body(request);}catch(error){return reply({error:"Submit one bounded JSON recovery review."},error instanceof Error&&error.message==="size"?413:400);}
 if(!object(value)||Object.keys(value).length!==4||!["candidate_id","preimage_hash","projection_hash","reason"].every(key=>Object.hasOwn(value,key))||
  value.candidate_id!==PROGRAM_TEXT_QUOTE_ID_RECOVERY_CANDIDATE||!hash(value.preimage_hash)||!hash(value.projection_hash)||
  typeof value.reason!=="string"||value.reason.trim().length<20||value.reason.length>2000)return reply({error:"Exact preview hashes and an explicit review reason are required."},400);
 try{return reply({ok:true,result:await approveProgramTextQuoteIdRecovery({candidate_id:value.candidate_id,preimage_hash:value.preimage_hash,projection_hash:value.projection_hash,reason:value.reason},auth.actor!)});}
 catch{return reply({error:"Recovery versions, authority or original evidence changed. No successful recovery was confirmed."},409);}
}
