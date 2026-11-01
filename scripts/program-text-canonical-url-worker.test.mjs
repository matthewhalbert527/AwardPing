// Offline current25 dispatch regression. The synthetic runtime lives only in
// this private task directory and imports exact worker/helper bytes. All capture,
// storage, provider and database mutations are replaced by rejecting stubs.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, realpathSync, lstatSync } from "node:fs";
import { resolve, dirname, basename, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { PAPPG_CANONICAL_SOURCE_ID as selectedId, PAPPG_CANONICAL_OWNER_ID as ownerId,
  PAPPG_CANONICAL_URL as url, PAPPG_PRESERVED_SOURCE_IDS as preservedIds } from "./lib/program-text-canonical-url-admission.mjs";

const privateRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../tmp");
const epoch = "33333333-3333-4333-8333-333333333333", revision = "44444444-4444-4444-8444-444444444444";
const contentHash = "a".repeat(64);
let runtime, fixtureNumber = 0;
const store = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text, { flag: "wx" }); };
before(() => {
  mkdirSync(privateRoot, { recursive: true });
  runtime = mkdtempSync(join(privateRoot, "test-runtime-"));
  assert.equal(dirname(realpathSync(runtime)), realpathSync(privateRoot));
  for (const path of ["program-text-worker.mjs", "lib/program-text-canonical-url-admission.mjs", "lib/program-text-source-access.mjs", "lib/program-text-collection-quality.mjs"])
    store(join(runtime, "scripts", path), readFileSync(new URL(path, import.meta.url)));
  store(join(runtime, "config/program-text-monitoring.json"), JSON.stringify({ schema: "awardping.program-text-monitoring.v1", enabled: true, epoch }));
  store(join(runtime, "sdk-loader.mjs"), `
export async function resolve(specifier, context, next) {
  if (specifier === "@aws-sdk/client-s3") return { url: new URL("./sdk-stub.mjs", import.meta.url).href, shortCircuit: true };
  return next(specifier, context);
}
`);
  store(join(runtime, "sdk-stub.mjs"), `export class S3Client { send() { globalThis.forbidden.storage++; throw Error("forbidden_storage"); } destroy() {} }`);
  store(join(runtime, "scripts/lib/program-text-review-queue.mjs"), `export async function hasPotentialProgramTextReview() { throw Error("forbidden_review_probe"); }`);
  store(join(runtime, "scripts/lib/program-text-host-pacing.mjs"), `export const createProgramTextHostPacer = () => ({run: async (_urls, action) => action()});`);
  store(join(runtime, "scripts/lib/scrapling-capture.mjs"), `export const createScraplingBrowserSessionPool = () => ({close: async () => {}});`);
  store(join(runtime, "scripts/lib/program-text-cycle-runner.mjs"), `export const scheduledCollectionCycleStore = () => null; export async function requestInstalledCoverageReport() { throw Error("forbidden_scheduler"); }`);
  store(join(runtime, "scripts/lib/program-text-monitor.mjs"), `
export const observed = [];
export async function monitorProgramTextSource(input) {
  observed.push({ source_id: input.source.id, admission: input.source.canonical_url_admission ?? null, cohorts: input.source.cohorts });
  return { status: "baseline_ready", initial_coverage: true, creates_update: false };
}
export async function finalizeProgramTextReview() { throw Error("forbidden_review"); }
`);
  store(join(runtime, "scripts/lib/program-text-storage.mjs"), `
const forbidden = () => { globalThis.forbidden.storage++; throw Error("forbidden_storage"); };
export const retainProgramTextCapture = forbidden, uploadProgramTextCapture = forbidden, loadProgramTextCapture = forbidden;
export function validateProgramTextReference() { throw Error("unexpected_reference_validation_in_empty_state_fixture"); }
`);
  store(join(runtime, "scripts/lib/program-text-repository.mjs"), `
export function createProgramTextRepository() { return {}; }
export function programTextCandidateWork() { throw Error("forbidden_candidate_work"); }
`);
  store(join(runtime, "scripts/lib/program-text-provider.mjs"), `
export async function submitProgramTextBatch() { globalThis.forbidden.provider++; throw Error("forbidden_provider"); }
export async function pollProgramTextBatch() { globalThis.forbidden.provider++; throw Error("forbidden_provider"); }
`);
  store(join(runtime, "scripts/lib/program-text-browser.mjs"), `export const findProgramTextBrowserExecutable = () => "private-offline-fixture.exe";`);
  store(join(runtime, "scripts/lib/program-text-capture-contract.mjs"), `
export function validateProgramTextCapture() { throw Error("unexpected_capture_validation_in_empty_state_fixture"); }
export const isKnownProgramTextHtmlShellReference = () => false;
export const isKnownProgramTextFooterOnlyPdfReference = () => false;
`);
  store(join(runtime, "scripts/lib/program-text-artifacts.mjs"), `export function validateProgramTextReference() { throw Error("unexpected_reference_validation_in_empty_state_fixture"); }`);
  store(join(runtime, "scripts/lib/program-text-deterministic-no-change.mjs"), `export const programTextDeterministicNoChange = () => null;`);
  store(join(runtime, "scripts/supabase-service-client.mjs"), `
import { createHash } from "node:crypto";
let fixture;
export const calls = [];
export function configure(value) { fixture = value; }
const cmp = (a,b) => {
  const x=Array.isArray(a)?a:[a],y=Array.isArray(b)?b:[b];
  for(let i=0;i<x.length;i++) if(x[i]!==y[i]) return x[i]<y[i]?-1:1;
  return 0;
};
export function createSupabaseServiceClient() { return {
  from() { globalThis.forbidden.table++; throw Error("forbidden_table_access"); },
  async rpc(name, params={}) {
    calls.push({ name, params });
    if(name==="get_program_text_worker_roster_page") {
      const roles=fixture.roles.map(r=>({ scope_key:"legacy_common",...r })).sort((a,b)=>cmp([a.cohort_key,a.scope_key,a.source_role],[b.cohort_key,b.scope_key,b.source_role]));
      const sources=fixture.sources.map(source=>({text_collection_quality:null,...source})).sort((a,b)=>cmp(a.id,b.id));
      const seal=createHash("sha256").update(JSON.stringify({roles,sources:sources.map(({text_monitoring_state,text_collection_quality,...identity})=>identity)})).digest("hex");
      if(params.p_expected_roster_seal && params.p_expected_roster_seal!==seal) throw Error("fixture_seal_changed");
      const all=params.p_kind==="roles"?roles:params.p_kind==="sources"?sources:[];
      const key=row=>params.p_kind==="roles"?[row.cohort_key,row.scope_key,row.source_role]:row.id;
      const tail=all.filter(row=>params.p_after===null||cmp(key(row),params.p_after)>0),entries=tail.slice(0,params.p_limit);
      return {data:{schema:"awardping.program-text-worker-roster-page.v1",roster_seal:seal,role_count:roles.length,
        source_count:new Set(roles.flatMap(r=>r.source_ids)).size,cohort_count:new Set(roles.map(r=>r.cohort_key)).size,entries,
        next_cursor:tail.length>entries.length?key(entries.at(-1)):null},error:null};
    }
    if(name==="get_program_text_fact_review_batch") return {data:[],error:null};
    if(name==="get_program_variation_admin_batch") return {data:{schema:"awardping.program-variation-admin-batch.v1",
      awards:Array.from({length:25},(_,i)=>({cohort_key:i===0?"nsf_grfp":"fixture_"+i}))},error:null};
    if(name==="get_program_text_canonical_url_admissions") {
      if(fixture.fresh_error) return {data:null,error:{code:"fixture_stale"}};
      const rows=params.p_source_ids.map(id=>fixture.sources.find(s=>s.id===id)?.canonical_url_admission).filter(Boolean).map(p=>({...p,...fixture.fresh_patch}));
      return {data:{schema:"awardping.program-text-canonical-url-admission-page.v1",epoch:params.p_epoch,
        source_ids:params.p_source_ids,admissions:fixture.fresh_missing?[]:rows},error:null};
    }
    if(name==="program_text_source_is_approved") return {data:fixture.generic_current!==false,error:fixture.generic_error?{code:"fixture_stale"}:null};
    globalThis.forbidden.rpc++; throw Error("forbidden_rpc:"+name);
  }
}; }
export async function closeSupabaseServiceTransport() {}
`);
  store(join(runtime, "driver.mjs"), `
import { readFileSync } from "node:fs";
import { configure, calls, createSupabaseServiceClient } from "./scripts/supabase-service-client.mjs";
import { observed } from "./scripts/lib/program-text-monitor.mjs";
import { runProgramTextWorker, loadProgramTextSources } from "./scripts/program-text-worker.mjs";
globalThis.forbidden={storage:0,provider:0,table:0,rpc:0,network:0};
globalThis.fetch = () => { globalThis.forbidden.network++; throw Error("forbidden_network"); };
const fixture=JSON.parse(readFileSync(process.argv[2],"utf8"));configure(fixture);
const reports=[];
if(fixture.action==="roster") reports.push(await loadProgramTextSources(createSupabaseServiceClient(),{epoch:fixture.epoch}));
else for(const args of fixture.runs ?? [["--mode=collect","--apply=true","--domain-delay-ms=0"]]) reports.push(await runProgramTextWorker(args));
process.stdout.write(JSON.stringify({reports,observed,calls,forbidden:globalThis.forbidden}));
`);
});
after(() => {
  if (!runtime) return;
  // Only this newly created canonical-private fixture may be removed.
  assert.equal(dirname(realpathSync(runtime)), realpathSync(privateRoot));
  assert.ok(basename(runtime).startsWith("test-runtime-"));
  assert.equal(lstatSync(runtime).isSymbolicLink(), false);
  rmSync(runtime, { recursive: true, force: false });
});
function execute(fixture) {
  const input = join(runtime, `input-${++fixtureNumber}.json`); store(input, JSON.stringify({ epoch, ...fixture }));
  const env = Object.fromEntries(["SystemRoot","WINDIR","TEMP","TMP","PATH","COMSPEC"].filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]]));
  Object.assign(env, { NEXT_PUBLIC_SUPABASE_URL:"https://offline.invalid", SUPABASE_SERVICE_ROLE_KEY:"offline-fixture",
    R2_BUCKET:"offline", R2_ENDPOINT:"https://offline.invalid", R2_ACCESS_KEY_ID:"offline", R2_SECRET_ACCESS_KEY:"offline", NODE_OPTIONS:"" });
  const child = spawnSync(process.execPath, ["--no-warnings", "--experimental-loader", pathToFileURL(join(runtime,"sdk-loader.mjs")).href,join(runtime,"driver.mjs"),input],
    { cwd:runtime, env, windowsHide:true, encoding:"utf8", timeout:10000, maxBuffer:1024*1024 });
  assert.equal(child.error, undefined); assert.equal(child.signal, null); assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.deepEqual(result.forbidden, { storage:0,provider:0,table:0,rpc:0,network:0 });
  return result;
}
const proof = (source, extra={}) => ({ schema:"awardping.program-text-canonical-url-admission.v1", source_id:source.id,
  shared_award_id:source.shared_award_id, source_url:source.url, cohort_key:"nsf_grfp", epoch, selected_source_id:selectedId,
  revision, content_hash:contentHash, current:true, ...extra });
function selected(extra={}) {
  const source={id:selectedId,shared_award_id:ownerId,url,title:"PAPPG",page_type:"requirements",admin_review_status:"open",text_monitoring_state:{},...extra};
  return {...source,canonical_url_admission:proof(source)};
}
const role = (source, name="current_documents", cohort="nsf_grfp") => ({cohort_key:cohort,source_role:name,source_ids:[source.id],manifest_status:"reviewed_text",revision,
  evidence:{schema:"awardping.program-text-source-role.v1",source_bindings:{[source.id]:{source_url:source.url,shared_award_id:source.shared_award_id}}}});
const ordinary = (id="00000001-0000-4000-8000-000000000001") => ({id,shared_award_id:ownerId,url:"https://example.org/ordinary",title:"Ordinary source",page_type:"other",admin_review_status:"open",text_monitoring_state:{}});
const admissionCalls = value => value.calls.filter(c=>c.name==="get_program_text_canonical_url_admissions"||c.name==="program_text_source_is_approved");

test("sealed roster preserves the exact canonical DTO and deduplicates one selected UUID across shared roles",()=>{
  const source=selected(),result=execute({action:"roster",sources:[source],roles:[role(source),role(source,"application_materials")]});
  assert.equal(result.reports[0].sources.length,1);assert.equal(result.reports[0].manifest.length,2);
  assert.deepEqual(result.reports[0].sources[0].canonical_url_admission,source.canonical_url_admission);
  assert.equal(result.reports[0].sources[0].manifest_bound,true);assert.deepEqual(admissionCalls(result),[]);
});
test("one selected UUID is dispatched exactly once across three normal sorted-ID shards despite shared roles",()=>{
  const source=selected(),left=ordinary(),right=ordinary("ffffffff-ffff-4fff-8fff-ffffffffffff");
  const result=execute({sources:[source,right,left],roles:[role(source),role(source,"application_materials"),role(left,"left"),role(right,"right")],
    runs:[0,1,2].map(i=>["--mode=collect","--apply=true","--domain-delay-ms=0","--shard-count=3",`--shard-index=${i}`])});
  assert.equal(result.observed.filter(row=>row.source_id===selectedId).length,1);
  assert.equal(result.observed.length,3);assert.deepEqual(admissionCalls(result).map(c=>c.name),["get_program_text_canonical_url_admissions","program_text_source_is_approved"]);
  assert.deepEqual(result.observed.find(row=>row.source_id===selectedId).admission,source.canonical_url_admission);
});
test("selected review_later source retains its separate ordinary source approval requirement",()=>{
  const source=selected({admin_review_status:"review_later"});
  source.text_source_approvals=[{schema:"awardping.program-text-source-approval.v1",id:"77777777-7777-4777-8777-777777777777",source_id:selectedId,
    shared_award_id:ownerId,source_url:url,cohort_key:"nsf_grfp",epoch,content_hash:"c".repeat(64),current:true}];
  const result=execute({sources:[source],roles:[role(source)]});assert.equal(result.observed.length,1);
});
test("all nine preserved OPEN records remain required but never dispatch after owner/cohort revival",()=>{
  const sources=preservedIds.map((id,index)=>({id,shared_award_id:`${String(index+1).repeat(8)}-1111-4111-8111-111111111111`,url,title:"Preserved foreign PAPPG",page_type:"requirements",admin_review_status:"open",text_monitoring_state:{}}));
  for(const source of sources)source.canonical_url_admission=proof(source,{current:false});
  const result=execute({sources,roles:sources.map((source,i)=>role(source,"revived_"+i,"revived_"+i))});
  assert.deepEqual(result.observed,[]);assert.deepEqual(admissionCalls(result),[]);
  assert.equal(result.reports[0].results.length,9);assert.ok(result.reports[0].results.every(r=>r.status==="held"));
  assert.equal(result.reports[0].coverage.reduce((n,r)=>n+r.required_sources,0),9);assert.ok(result.reports[0].coverage.every(r=>r.collection_complete===false));
});
for (const [name,extra] of [
  ["revoked current proof",{fresh_patch:{current:false}}],
  ["new collision/changed reservation hash",{fresh_patch:{content_hash:"b".repeat(64)}}],
  ["changed reservation revision",{fresh_patch:{revision:"55555555-5555-4555-8555-555555555555"}}],
  ["missing fresh admission row",{fresh_missing:true}],
  ["fresh admission RPC error",{fresh_error:true}],
  ["generic role/source approval revoked",{generic_current:false}],
  ["generic role/source approval RPC error",{generic_error:true}],
]) test(name+" holds before monitor/capture/provider/retention",()=>{
  const source=selected(),result=execute({sources:[source],roles:[role(source)],...extra});
  assert.deepEqual(result.observed,[]);assert.deepEqual(result.reports[0].results,[{source_id:selectedId,status:"held",reason:"canonical_url_admission_changed"}]);
});
test("ordinary collection retains its existing dispatch and performs no extra admission or source-approval RPC",()=>{
  const source=ordinary(),result=execute({sources:[source],roles:[role(source)]});
  assert.deepEqual(result.observed.map(row=>row.source_id),[source.id]);assert.deepEqual(admissionCalls(result),[]);
});
