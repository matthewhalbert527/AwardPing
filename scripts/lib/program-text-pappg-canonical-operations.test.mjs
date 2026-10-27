// Synthetic retained inputs and mocked service RPCs; no operational client.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { PAPPG_CANONICAL_SOURCE_ID as selected,PAPPG_CANONICAL_OWNER_ID as owner,
  PAPPG_CANONICAL_URL as url,PAPPG_PRESERVED_SOURCE_IDS } from "./program-text-canonical-url-admission.mjs";
const moduleRoot=path.resolve(import.meta.dirname,"../..");
const release=fs.existsSync(path.join(moduleRoot,"package.json"))?moduleRoot:path.resolve(import.meta.dirname,"../../../../release-date-card-20260908");
const releaseLib=pathToFileURL(path.join(release,"scripts/lib/"));
function overlay(file,overrides={}) {
  const source=fs.readFileSync(new URL(file,import.meta.url),"utf8").replace(/(\bfrom\s+)(["'])([^"']+)\2/g,(_m,p,_q,s)=>
    p+JSON.stringify(overrides[s]||(s.startsWith(".")?new URL(s,releaseLib).href:s)));
  return "data:text/javascript;base64,"+Buffer.from(source).toString("base64");
}
const approval=overlay("./program-text-source-approval.mjs",{
  "./program-text-source-access.mjs":new URL("./program-text-source-access.mjs",import.meta.url).href,
  "./program-text-canonical-url-admission.mjs":new URL("./program-text-canonical-url-admission.mjs",import.meta.url).href});
const operations=await import(overlay("./program-text-pappg-canonical-operations.mjs",{
  "./program-text-source-approval.mjs":approval,
  "./program-text-canonical-url-admission.mjs":new URL("./program-text-canonical-url-admission.mjs",import.meta.url).href}));
const {buildProgramTextCapture}=await import(new URL("program-text-capture-contract.mjs",releaseLib));
const {programTextReference}=await import(new URL("program-text-artifacts.mjs",releaseLib));
const epoch="ec349339-ff62-4d2e-a610-8c361b4044ec",id="11111111-1111-4111-8111-111111111111",actor="22222222-2222-4222-8222-222222222222";
function fixture() {
  const index={id:"c49e85e3-3b19-4052-891f-c2bc67e8b8f6",shared_award_id:owner,
    url:"https://www.nsf.gov/funding/opportunities/grfp-nsf-graduate-research-fellowship-program/nsf26-526/solicitation",title:"SYNTHETIC NSF index",page_type:"other"};
  const body="The synthetic official program index incorporates its governing application policies and procedures.";
  const text=body,html='<html><body><main><p>'+body+'</p><a href="/policies/pappg">PAPPG</a></main></body></html>';
  const capture=buildProgramTextCapture({source:index,acquisition:"http_html",captured_at:"2026-10-27T20:00:00.000Z",
    extractor:{name:"synthetic",version:"1"},content_type:"text/html",raw_bytes:Buffer.from(html),text,
    blocks:[{id:"program",text:body,start_utf16:0,end_utf16:body.length}]});
  const proposal={schema:"awardping.program-text-source-pending-request.v2",id,cohort_key:"nsf_grfp",epoch,expected_canonical_shared_award_id:owner,
    source:{id:selected,shared_award_id:owner,url,title:"Proposal & Award Policies & Procedures Guide",page_type:"other",create:true,
      expected_member_kind:"canonical",expected_admin_review_status:null,expected_text_monitoring_state:{}},
    authority_ref:programTextReference(capture),link_proof:{kind:"retained_raw_html_anchor.v1",anchor_start_utf16:html.indexOf('<a '),target_page_url:url},registration_scope:{kind:"legacy_roles"},
    roles:[{source_role:"current_documents",expected_revision:epoch,expected_source_ids:[index.id],next_source_ids:[index.id,selected]}]};
  const context={epoch,loadCapture:async()=>capture};
  const inspection={schema:"awardping.program-text-pappg-canonical-inspection.v1",epoch,context_hash:"a".repeat(64),
    context:{synthetic:true,foreign_identities:PAPPG_PRESERVED_SOURCE_IDS,authority_ref:proposal.authority_ref,role_revision:epoch}};
  const disposition={schema:"awardping.program-text-pappg-canonical-disposition.v1",context_hash:inspection.context_hash,
    context:inspection.context,reason:"Explicit synthetic disposition preserves all nine foreign histories and grants no alias membership."};
  const calls=[];const db={async rpc(name,p){calls.push({name,p});if(name==="inspect_program_text_pappg_canonical")return {data:inspection};
    if(name==="prepare_program_text_pappg_canonical")return {data:{id,content_hash:"b".repeat(64)}};throw Error("unexpectedRPC");},from(){throw Error("no direct table mutation");}};
  return {proposal,context,capture,inspection,disposition,db,calls};
}
test("finite preparation reuses real retained-link validation and sends separate disposition to the sole wrapper",async()=>{
  const f=fixture(),before=structuredClone(f.proposal);const r=await operations.prepareProgramTextPappgCanonicalOperation(f.db,f.proposal,f.disposition,actor,f.context);
  assert.equal(r.id,id);assert.deepEqual(f.proposal,before);assert.deepEqual(f.calls.map(c=>c.name),["inspect_program_text_pappg_canonical","prepare_program_text_pappg_canonical"]);
  const sent=f.calls[1].p;assert.deepEqual(sent.p_validation.proposal,f.proposal);assert.equal(sent.p_validation.source_text.length,1);
  assert.equal(sent.p_validation.provider_link.resolved_url,url);assert.equal(sent.p_disposition.schema,f.disposition.schema);
  assert.equal(sent.p_proposal.source.expected_admin_review_status,null);assert.deepEqual(sent.p_proposal.source.expected_text_monitoring_state,{});
  assert.equal(sent.p_actor,actor);assert.ok(!Object.hasOwn(sent.p_validation,"url_alias_boundary"));
});
for(const [name,mutate] of [
  ["foreign owner",f=>{f.proposal.source.shared_award_id=actor;}],["different UUID",f=>{f.proposal.source.id=actor;}],
  ["normalized but nonliteral URL",f=>{f.proposal.source.url+="/";}],["alias target",f=>{f.proposal.source.expected_member_kind="alias";}],
  ["nonempty history",f=>{f.proposal.source.expected_text_monitoring_state={pretend:true};}],
  ["nonempty legacy permission",f=>{f.proposal.source.expected_admin_review_status="open";}],
  ["unreviewed direct caller",f=>{f.actor="not-an-admin-id";}],
  ["fabricated provider link",f=>{f.proposal.link_proof.anchor_start_utf16=0;}],
  ["legacy source-link exception",f=>{f.proposal.schema="awardping.program-text-source-pending-request.v1";}],
  ["unreviewed role",f=>{f.proposal.roles[0].source_role="funding";}],
])test("finite prepare refuses "+name+" before a write RPC",async()=>{
  const f=fixture();mutate(f);await assert.rejects(operations.prepareProgramTextPappgCanonicalOperation(f.db,f.proposal,f.disposition,f.actor??actor,f.context));
  assert.ok(!f.calls.some(c=>c.name==="prepare_program_text_pappg_canonical"));
});
test("fresh context hash and whole context are both required; matching hashes do not excuse changed catalogue evidence",async()=>{
  for(const kind of ["hash","context"]) {const f=fixture();f.disposition=structuredClone(f.disposition);
    if(kind==="hash")f.disposition.context_hash="b".repeat(64);else f.disposition.context.foreign_identities.pop();
    await assert.rejects(operations.prepareProgramTextPappgCanonicalOperation(f.db,f.proposal,f.disposition,actor,f.context));assert.equal(f.calls.length,1);}
});
test("inspection never returns whole raw bytes and does not accept a missing/oversized service envelope",async()=>{
  for(const mutate of [x=>{x.context.raw_base64="private-original";},x=>{delete x.context_hash;},x=>{x.context.overflow="x".repeat(201*1024);}]) {
    const f=fixture();mutate(f.inspection);await assert.rejects(operations.inspectProgramTextPappgCanonicalOperation(f.db,f.context));}
});
test("ordinary receipt loads add no disposition RPC",async()=>{
  const f=fixture();assert.equal(await operations.loadProgramTextPappgCanonicalDisposition(f.db,id,{epoch,source:{id:actor,url:"https://example.org"}}),null);assert.equal(f.calls.length,0);
});
test("historical finite disposition is readable with current=false but cannot assert another current epoch",async()=>{
  const record={schema:"awardping.program-text-pappg-canonical-disposition-record.v1",pending_id:id,epoch:actor,selected_source_id:selected,
    source_url:url,shared_award_id:owner,cohort_key:"nsf_grfp",revision:actor,content_hash:"c".repeat(64),current:false,context:{synthetic:true},
    reason:"Preserved explicit reviewed disposition.",approval_id:null};
  const db={rpc:async()=>({data:record})};const opts={epoch,source:{id:selected,url}};
  assert.equal((await operations.loadProgramTextPappgCanonicalDisposition(db,id,opts)).current,false);
  record.current=true;await assert.rejects(operations.loadProgramTextPappgCanonicalDisposition(db,id,opts));
  record.current=false;record.context.raw_base64="not-for-client";await assert.rejects(operations.loadProgramTextPappgCanonicalDisposition(db,id,opts));
});
