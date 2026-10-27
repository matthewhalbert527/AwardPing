import {beforeEach,describe,expect,it,vi} from 'vitest';
const state=vi.hoisted(()=>({signedIn:true,siteAdmin:true,originAllowed:true,queries:0,inserts:0}));
vi.mock('server-only',()=>({}));
vi.mock('@/lib/admin-request-security',()=>({validateSameOriginAdminMutation:()=>state.originAllowed?null:Response.json({error:'origin'},{status:403})}));
vi.mock('@/lib/auth',()=>({getCurrentUser:async()=>state.signedIn?{email:'admin@example.test'}:null,isSiteAdminEmail:()=>state.siteAdmin}));
vi.mock('@/lib/config',()=>({hasSupabaseAdminConfig:()=>true,hasSupabaseConfig:()=>true}));
vi.mock('@/lib/supabase/admin',()=>({createSupabaseAdminClient:()=>({from:()=>{
 state.queries++;
 const q={select:()=>q,eq:()=>q,ilike:()=>q,in:()=>q,order:()=>q,limit:()=>q,maybeSingle:async()=>({data:null,error:null}),insert:()=>{state.inserts++;return q;}};
 return q;
}})}));
import {POST} from './route';
const url='https://awardping.com/api/admin/source-intake';
const request=(body:unknown)=>new Request(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
beforeEach(()=>Object.assign(state,{signedIn:true,siteAdmin:true,originAllowed:true,queries:0,inserts:0}));
describe('bounded admin source intake',()=>{
 it('retains the full permitted 200 URL dry run without writes',async()=>{
  const response=await POST(request({urls:Array.from({length:200},(_,i)=>'https://www.nsf.gov/example/'+i),dryRun:true}));
  expect(response.status).toBe(200);expect((await response.json()).results).toHaveLength(200);expect(state.inserts).toBe(0);
 });
 it('rejects oversized arrays and combined or pasted batches instead of silently discarding URLs',async()=>{
  const urls=Array.from({length:201},(_,i)=>'https://www.nsf.gov/example/'+i);
  for(const body of [{urls,dryRun:true},{url:urls[200],urls:urls.slice(0,200),dryRun:true},{urls:urls.join('\n'),dryRun:true}]){
   expect((await POST(request(body))).status).toBe(400);expect(state.queries).toBe(0);
  }
 });
 it('bounds individual URL strings before any intake query',async()=>{
  for(const body of [{url:'https://www.nsf.gov/'+ 'x'.repeat(2048)},{urls:['x'.repeat(2049)]}]){
   expect((await POST(request(body))).status).toBe(400);expect(state.queries).toBe(0);
  }
 });
 it('cancels a chunked oversized body even with understated Content-Length',async()=>{
  let pulls=0,cancelled=false;
  const stream=new ReadableStream<Uint8Array>({pull(controller){pulls++;controller.enqueue(new Uint8Array(300*1024).fill(32));},cancel(){cancelled=true;}},{highWaterMark:0});
  const response=await POST(new Request(url,{method:'POST',headers:{'content-length':'1'},body:stream,duplex:'half'} as RequestInit & {duplex:'half'}));
  expect(response.status).toBe(413);expect(cancelled).toBe(true);expect(pulls).toBe(2);expect(state.queries).toBe(0);
 });
 it('rejects a declared oversized request without reading its body',async()=>{
  const r=request({url:'https://www.nsf.gov/'});r.headers.set('content-length',String(512*1024+1));
  expect((await POST(r)).status).toBe(413);expect(r.bodyUsed).toBe(false);expect(state.queries).toBe(0);
 });
 it('checks origin, login and admin access before reading request bytes',async()=>{
  for(const [field,status] of [['originAllowed',403],['signedIn',401],['siteAdmin',403]] as const){
   state[field]=false;const r=request({urls:Array(201).fill('x')});
   expect((await POST(r)).status).toBe(status);expect(r.bodyUsed).toBe(false);expect(state.queries).toBe(0);state[field]=true;
  }
 });
 it('rejects malformed JSON and UTF8 without intake writes',async()=>{
  for(const body of ['{',new Uint8Array([0xc3,0x28])]){
   expect((await POST(new Request(url,{method:'POST',body}))).status).toBe(400);expect(state.queries).toBe(0);
  }
 });
});
