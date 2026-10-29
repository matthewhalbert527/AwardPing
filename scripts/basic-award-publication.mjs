#!/usr/bin/env node
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
export const CLI_BASIC_FIELDS=Object.freeze(['overview','opening_date','deadline','cycle_status','important_dates','eligibility','citizenship','academic_levels','disciplines','award_amounts','stipend','tuition','travel_research_allowance','tenure','application_url']);
const check=(v,c)=>{if(!v)throw Error('Basic publication CLI: '+c);};
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export function parseBasicPublicationArgs(argv){
 if(!argv.length||argv.length===1&&argv[0]==='--help')return{mode:'inert'};
 check(['--prepare','--publish'].includes(argv[0]),'explicit_mode_required');const mode=argv[0]==='--prepare'?'prepare':'publish',o={mode};
 const allowed=mode==='prepare'?['--draft-id','--fields','--output','--env']:['--plan','--expected-plan-hash','--output','--env'];
 check(argv.length===9,'exact_parameters_required');
 for(let i=1;i<argv.length;i+=2){check(allowed.includes(argv[i])&&!Object.hasOwn(o,argv[i])&&typeof argv[i+1]==='string'&&argv[i+1]&&!argv[i+1].startsWith('--'),'unknown_or_duplicate_argument');o[argv[i]]=argv[i+1];}
 check(allowed.every(k=>Object.hasOwn(o,k)),'all_parameters_required');
 if(mode==='prepare'){check(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(o['--draft-id']),'draft_uuid');const fields=o['--fields'].split(',');check(/^[a-z_]+(?:,[a-z_]+)*$/.test(o['--fields'])&&fields.includes('overview')&&fields.length<=15&&new Set(fields).size===fields.length&&fields.every(x=>CLI_BASIC_FIELDS.includes(x)),'explicit_fields');}
 else check(hash(o['--expected-plan-hash']),'frozen_plan_hash');return o;
}
async function productionDependencies(envFile){
 process.loadEnvFile(resolve(envFile));
 const env=process.env;check(env.NEXT_PUBLIC_SUPABASE_URL&&env.SUPABASE_SERVICE_ROLE_KEY&&env.R2_ACCESS_KEY_ID&&env.R2_SECRET_ACCESS_KEY&&(env.R2_ENDPOINT||env.R2_ACCOUNT_ID),'service_configuration_missing');
 const [{S3Client},{createSupabaseServiceClient,closeSupabaseServiceTransport},{loadProgramTextCapture}]=await Promise.all([
  import('@aws-sdk/client-s3'),import('./supabase-service-client.mjs'),import('./lib/program-text-artifacts.mjs'),
 ]);
 const {createBasicPublicationRpcAdapter}=await import('./lib/basic-award-publication.mjs');
 const client=new S3Client({region:'auto',endpoint:env.R2_ENDPOINT||`https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,forcePathStyle:true,maxAttempts:1,credentials:{accessKeyId:env.R2_ACCESS_KEY_ID,secretAccessKey:env.R2_SECRET_ACCESS_KEY}});
 const db=createSupabaseServiceClient(env.NEXT_PUBLIC_SUPABASE_URL,env.SUPABASE_SERVICE_ROLE_KEY),bucket=env.R2_BUCKET||'awardping-snapshots';
 return{...createBasicPublicationRpcAdapter(db,ref=>loadProgramTextCapture(ref,{client,bucket})),close:async()=>{client.destroy();await closeSupabaseServiceTransport();}};
}
export async function basicPublicationMain(argv=process.argv.slice(2),factory=productionDependencies){
 const o=parseBasicPublicationArgs(argv);if(o.mode==='inert')return{status:'INERT_EXPLICIT_PREPARE_OR_FROZEN_PLAN_PUBLICATION_REQUIRED',database_writes:0,provider_calls:0};
 const output=resolve(o['--output']);check(!existsSync(output),'fresh_output_required');
 const {prepareBasicFactPublication,publishBasicFactPublication,basicPublicationHash}=await import('./lib/basic-award-publication.mjs');
 let plan;
 if(o.mode==='publish'){const b=readFileSync(resolve(o['--plan']));check(b.length<=8*1024*1024,'bounded_plan_required');plan=JSON.parse(b);check(basicPublicationHash(plan)===o['--expected-plan-hash'],'frozen_plan_hash_changed');}
 const deps=await factory(o['--env']);
 try{
  const result=o.mode==='prepare'?await prepareBasicFactPublication({draft_id:o['--draft-id'],selected_fields:o['--fields'].split(',')},deps):await publishBasicFactPublication(plan,o['--expected-plan-hash'],deps);
  writeFileSync(output,JSON.stringify(o.mode==='prepare'?result.plan:result,null,2)+'\n',{flag:'wx',mode:0o600});
  return o.mode==='prepare'?{status:'PREPARED_NOT_PUBLISHED',kind:result.plan.kind,plan_hash:result.plan_hash,receipt_hash:result.plan.receipt_hash,public_preview:result.public_preview,output,database_writes:0,provider_calls:0}:
   {status:'BASIC_SNAPSHOT_PUBLISHED',...result,output,provider_calls:0};
 }finally{await deps.close?.();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){basicPublicationMain().then(r=>console.log(JSON.stringify(r))).catch(()=>{console.error(JSON.stringify({status:'HELD_BASIC_PUBLICATION_UNCONFIRMED',message:'No successful basic snapshot was confirmed. Inspect current state before retrying.'}));process.exitCode=1;});}
