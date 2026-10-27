import test from "node:test";
import assert from "node:assert/strict";
import { PAPPG_CANONICAL_SOURCE_ID as selected,PAPPG_CANONICAL_OWNER_ID as owner,PAPPG_CANONICAL_URL as url,
  PAPPG_PRESERVED_SOURCE_IDS as foreign,needsProgramTextCanonicalUrlAdmission,
  attachProgramTextCanonicalUrlAdmissions,assertCurrentCanonicalUrlAdmission } from "./program-text-canonical-url-admission.mjs";
import { hasProgramTextSourceAccess,attachProgramTextSourceApprovals } from "./program-text-source-access.mjs";
const epoch="ec349339-df53-4ea7-97e0-bc52e4ac24eb",revision="11111111-1111-4111-8111-111111111111";
const source=()=>({id:selected,shared_award_id:owner,url,admin_review_status:"open"});
const admission=(s=source(),current=true)=>({schema:"awardping.program-text-canonical-url-admission.v1",source_id:s.id,
  shared_award_id:s.shared_award_id,source_url:s.url,cohort_key:"nsf_grfp",epoch,selected_source_id:selected,
  revision,content_hash:"a".repeat(64),current});
const ready=()=>({...source(),canonical_url_admission:admission()});
const page=(sources,proofs)=>({schema:"awardping.program-text-canonical-url-admission-page.v1",epoch,
  source_ids:sources.map(s=>s.id),admissions:proofs??sources.map(s=>admission(s))});
function dbFor(sources,{proofs,approved=true,alter}={}) {
  const calls=[]; return {calls,async rpc(name,args){calls.push({name,args});
    if(name==="get_program_text_canonical_url_admissions") {const value=page(sources,proofs);return {data:alter?alter(value):value,error:null};}
    if(name==="program_text_source_is_approved") return {data:approved,error:null};
    throw Error("Unexpected RPC "+name);
  }};
}
test("ordinary OPEN admission is unchanged and adds no RPC",async()=>{
  const s={id:"22222222-2222-4222-8222-222222222222",shared_award_id:owner,url:"https://www.nsf.gov/ordinary",admin_review_status:"open"};
  assert.equal(hasProgramTextSourceAccess(s),true);const db=dbFor([]);
  assert.deepEqual(await attachProgramTextSourceApprovals(db,[s],{epoch}),[{...s,text_source_approvals:[]}]);
  assert.equal(await assertCurrentCanonicalUrlAdmission(db,s,{epoch}),true);assert.equal(db.calls.length,0);
});
test("selected OPEN cannot bypass missing, denied or revoked finite authority",()=>{
  assert.equal(hasProgramTextSourceAccess(source(),{epoch}),false);
  assert.equal(hasProgramTextSourceAccess({...source(),canonical_url_admission:admission(source(),false)},{epoch}),false);
  assert.equal(hasProgramTextSourceAccess(ready(),{epoch,cohort:"nsf_grfp"}),true);
  assert.equal(hasProgramTextSourceAccess(ready(),{epoch,cohort:"other_award"}),false);
});
test("finite admission is an outer guard for normal scoped approval too",()=>{
  const proof={schema:"awardping.program-text-source-approval.v1",id:revision,source_id:selected,shared_award_id:owner,
    source_url:url,cohort_key:"nsf_grfp",epoch,content_hash:"b".repeat(64),current:true};
  const s={...source(),admin_review_status:"review_later",text_source_approvals:[proof]};
  assert.equal(hasProgramTextSourceAccess(s,{epoch}),false);
  assert.equal(hasProgramTextSourceAccess({...s,canonical_url_admission:admission()},{epoch}),true);
  assert.equal(hasProgramTextSourceAccess({...ready(),admin_review_status:"review_later",text_source_approvals:[]},{epoch}),false);
});
for(const id of foreign) test("preserved foreign identity stays denied after OPEN/scoped/member revival: "+id,()=>{
  const s={...ready(),id,shared_award_id:"33333333-3333-4333-8333-333333333333",cohorts:["nsf_grfp"],manifest_bound:true};
  s.canonical_url_admission=admission(s,true);
  assert.equal(hasProgramTextSourceAccess(s,{epoch}),false);
  s.admin_review_status="review_later";s.text_source_approvals=[{schema:"awardping.program-text-source-approval.v1",id:revision,
    source_id:id,shared_award_id:s.shared_award_id,source_url:url,cohort_key:"nsf_grfp",epoch,content_hash:"b".repeat(64),current:true}];
  assert.equal(hasProgramTextSourceAccess(s,{epoch}),false);
});
test("unknown normalized collisions, selected owner/URL drift and known-ID retargets fail closed",()=>{
  for(const s of [{...ready(),id:revision},{...ready(),shared_award_id:revision},{...ready(),url:url+"/"},
    {...ready(),id:foreign[0],url:"https://www.nsf.gov/new-page"}])assert.equal(hasProgramTextSourceAccess(s,{epoch}),false);
  assert.equal(needsProgramTextCanonicalUrlAdmission({id:revision,url:url.toUpperCase()+"/#fragment"}),true);
});
test("OPEN hydration still reads explicit finite authority and replaces caller metadata",async()=>{
  const s=ready(),db=dbFor([s],{proofs:[admission(s,false)]});
  const [value]=await attachProgramTextSourceApprovals(db,[s],{epoch});
  assert.equal(db.calls.length,1);assert.equal(db.calls[0].name,"get_program_text_canonical_url_admissions");
  assert.equal(hasProgramTextSourceAccess(value,{epoch}),false);
});
test("fresh pre-capture check binds the same revision and current required-role authority",async()=>{
  const s=ready(),db=dbFor([s]);assert.equal(await assertCurrentCanonicalUrlAdmission(db,s,{epoch}),true);
  assert.deepEqual(db.calls.map(c=>c.name),["get_program_text_canonical_url_admissions","program_text_source_is_approved"]);
  for(const change of [p=>({...p,current:false}),p=>({...p,revision:"44444444-4444-4444-8444-444444444444"}),
    p=>({...p,content_hash:"c".repeat(64)})]) {
    const denied=dbFor([s],{proofs:[change(admission())]});
    await assert.rejects(assertCurrentCanonicalUrlAdmission(denied,s,{epoch}));assert.equal(denied.calls.length,1);
  }
  await assert.rejects(assertCurrentCanonicalUrlAdmission(dbFor([s],{approved:false}),s,{epoch}));
});
for(const [name,alter] of [
  ["omitted",p=>({...p,admissions:[]})],["duplicate",p=>({...p,admissions:[p.admissions[0],p.admissions[0]]})],
  ["wrong source",p=>({...p,admissions:[{...p.admissions[0],source_id:revision}]})],
  ["wrong epoch",p=>({...p,admissions:[{...p.admissions[0],epoch:revision}]})],
  ["extra permission",p=>({...p,admissions:[{...p.admissions[0],approved_by_client:true}]})],
  ["missing selected pin",p=>({...p,admissions:[{...p.admissions[0],selected_source_id:revision}]})],
  ["truncated request scope",p=>({...p,source_ids:[]})],
])test("hydration rejects "+name+" authority",async()=>{
  await assert.rejects(attachProgramTextCanonicalUrlAdmissions(dbFor([source()],{alter}),[source()],{epoch}));
});
test("pre-reservation denial is explicit and never falls back to OPEN",async()=>{
  const s=source(),db=dbFor([s],{proofs:[{...admission(s,false),revision:null,content_hash:null}]});
  const [value]=await attachProgramTextCanonicalUrlAdmissions(db,[s],{epoch});
  assert.equal(hasProgramTextSourceAccess(value,{epoch}),false);
});
