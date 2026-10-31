import {readFileSync} from 'node:fs';
import {describe,it,expect,vi} from 'vitest';
import {parse} from 'libpg-query';
import {buildProgramTextCapture} from './program-text-capture-contract.mjs';
import {programTextReference} from './program-text-artifacts.mjs';
import {hasProgramTextSourceAccess} from './program-text-source-access.mjs';
import {validateExplicitOfficialSourceAdmission,EXPLICIT_SOURCE_ADMISSION_SCHEMA} from './program-text-explicit-source-admission.mjs';
import {explicitSourceAdmissionRollbackSql} from '../test-support/explicit-source-admission-rollback.mjs';
const actor='40000000-0000-4000-8000-000000000001',epoch='40000000-0000-4000-8000-000000000002';
const owner='40000000-0000-4000-8000-000000000003',sourceId='40000000-0000-4000-8000-000000000004';
const oldId='40000000-0000-4000-8000-000000000005',other='40000000-0000-4000-8000-000000000006';
function fixture(){
 const source={id:sourceId,shared_award_id:owner,url:'https://example.org/award/eligibility/',title:'Synthetic current eligibility',page_type:'eligibility'};
 const registry={cohort_key:'example',canonical_shared_award_id:owner,official_homepage:'https://example.org/award/'};
 const roles=['eligibility','funding'].map(source_role=>({source_role,revision:epoch,source_ids:[oldId]}));
 const proposal={schema:EXPLICIT_SOURCE_ADMISSION_SCHEMA,id:other,cohort_key:'example',epoch,expected_canonical_shared_award_id:owner,
  expected_official_homepage:registry.official_homepage,source,roles:roles.map((r,i)=>({source_role:r.source_role,expected_revision:r.revision,
   expected_source_ids:[...r.source_ids],next_source_ids:i===0?[oldId,sourceId]:[oldId]})),registration_scope:{kind:'legacy_roles'},
  review:{actor_id:actor,reason:'Human requested this current official eligibility source be monitored.',purpose:'Core eligibility guidance for this specific award and current competition.',reviewed_at:'2026-10-31T18:00:00.000Z'}};
 const text='Synthetic complete official guidance explains eligibility and funding for the current award competition. No hyperlink witness is supplied.';
 const capture=buildProgramTextCapture({source,captured_at:'2026-10-31T17:59:00.000Z',final_url:source.url,acquisition:'http_html',extractor:{name:'fixture',version:'1'},
  raw_bytes:Buffer.from('<main>'+text+'</main>'),content_type:'text/html',text,blocks:[{id:'body',text,start_utf16:0,end_utf16:text.length}]});
 const context={registry,epoch,roles,actor,target_ref:programTextReference(capture),loadCapture:vi.fn(async()=>capture),now:Date.parse('2026-10-31T18:01:00.000Z')};
 return{proposal,context,capture};
}
describe('explicit reviewed official source admission',()=>{
 it('cold-validates an unlinked exact official target independently of legacy hyperlink proof',async()=>{
  const f=fixture(),result=await validateExplicitOfficialSourceAdmission(f.proposal,f.context);
  expect(result.schema).toBe('awardping.explicit-official-source-admission-validation.v1');
  expect(result.target_document.reference).toEqual(f.context.target_ref);expect(result.target_document.text).toBe(f.capture.text);
  expect(result).not.toHaveProperty('provider_link');expect(f.context.loadCapture).toHaveBeenCalledExactlyOnceWith(f.context.target_ref);
 });
 it.each([
  f=>{f.proposal.source.url='https://other.example/award/eligibility/';},
  f=>{f.proposal.source.url='https://sub.example.org/award/eligibility/';},
  f=>{f.proposal.source.url+='?cycle=2027';},f=>{f.proposal.source.url+='#details';},
  f=>{f.proposal.source.url='http://example.org/award/eligibility/';},
  f=>{f.proposal.source.url='https://user@example.org/award/eligibility/';},
  f=>{f.proposal.source.url='https://example.org:443/award/eligibility/';},
  f=>{f.proposal.source.url='https://example.org/award/%65ligibility/';},
  f=>{f.proposal.source.url='https://example.org/award/../eligibility/';},
  f=>{f.proposal.source.shared_award_id=other;},f=>{f.proposal.epoch=other;},
  f=>{f.proposal.expected_official_homepage='https://example.org/another-award/';},
  f=>{f.proposal.registration_scope={kind:'variation_inventory',inventory_id:other};},
  f=>{f.proposal.review.actor_id=other;},f=>{f.proposal.review.reason='too short';},
  f=>{f.proposal.review.purpose='too short';},
  f=>{f.proposal.review.reviewed_at='2026-10-31T17:00:00.000Z';},
  f=>{f.proposal.review.reviewed_at='2026-10-31T19:00:00.000Z';},
  f=>{f.proposal.review.reviewed_at='2026-10-31T17:58:00.000Z';},
  f=>{f.proposal.roles.pop();},f=>{f.proposal.roles.push(f.proposal.roles[0]);},
  f=>{f.proposal.roles[0].expected_revision=other;},
  f=>{f.proposal.roles[0].expected_source_ids=[other];},
  f=>{f.proposal.roles[0].next_source_ids=[sourceId];},
  f=>{f.proposal.roles[0].next_source_ids=[oldId,sourceId,other];},
  f=>{f.proposal.roles[0].next_source_ids=[sourceId,oldId];},
  f=>{f.proposal.roles[0].next_source_ids=[oldId];},
  f=>{f.proposal.provider_link={resolved_url:f.proposal.source.url};},
  f=>{f.context.target_ref.final_url='https://example.org/redirected/';},
  f=>{f.capture.completeness={status:'incomplete',reasons:['incomplete_page']};},
  f=>{f.context.loadCapture=async()=>({...f.capture,text:f.capture.text+'tampered'});},
 ])('rejects unauthorized scope, incomplete originals, stale review and role changes %#',async mutate=>{
  const f=fixture();mutate(f);await expect(validateExplicitOfficialSourceAdmission(f.proposal,f.context)).rejects.toThrow();
 });
 it('uses the unchanged standard DTO for review_later collection authority',()=>{
  const f=fixture(),source={...f.proposal.source,admin_review_status:'review_later',text_source_approvals:[{schema:'awardping.program-text-source-approval.v1',
   id:other,source_id:sourceId,shared_award_id:owner,source_url:f.proposal.source.url,cohort_key:'example',epoch,content_hash:'a'.repeat(64),current:true}]};
  expect(hasProgramTextSourceAccess(source,{cohort:'example',epoch})).toBe(true);
  expect(hasProgramTextSourceAccess(source,{cohort:'other',epoch})).toBe(false);
 });
 it('adds one service-only atomic RPC without changing legacy link functions or state',async()=>{
  const sql=readFileSync(new URL('../../supabase/migrations/20261031201414_program_text_explicit_official_source_admission.sql',import.meta.url),'utf8');
  const ast=await parse(sql),functions=ast.stmts.map(x=>x.stmt.CreateFunctionStmt).filter(Boolean);
  expect(functions).toHaveLength(1);expect(functions[0].funcname.map(x=>x.String.sval).join('.')).toBe('public.admit_reviewed_official_program_text_source');
  expect(sql).toContain("from public,anon,authenticated,service_role");expect(sql).toContain('to service_role;');
  expect(sql).toContain('Entire current role snapshot required');expect(sql).toContain('Only exact ordered source append is permitted');
  expect(sql).toContain('private.awardping_program_source_approval_document_valid(p_document) is distinct from true');
  expect(sql).toContain('private.awardping_pappg_canonical_known(source_id,source_url)');
  expect(sql).not.toMatch(/(?:update|delete from) public\.shared_award_sources/i);
  expect(sql).not.toMatch(/update .*text_monitoring_state|insert into public\.program_text_source_pending_requests/i);
 });
 it('generates parseable rollback-only native tests from caller-provided complete originals',async()=>{
  const f=fixture(),proof=await validateExplicitOfficialSourceAdmission(f.proposal,f.context);
  const sql=explicitSourceAdmissionRollbackSql({proposal:f.proposal,document:proof.target_document,actor});
  expect(sql.trimEnd().endsWith('ROLLBACK;')).toBe(true);expect(sql).not.toContain('COMMIT;');
  expect(sql).toContain('SET LOCAL ROLE authenticated;');expect(sql).toContain('SET LOCAL ROLE anon;');
  expect(sql).toContain('revoke_program_text_source_approval');
  expect(sql).toContain('Revoked admission was silently reactivated');
  await expect(parse(sql)).resolves.toHaveProperty('stmts');
  const migration=readFileSync(new URL('../../supabase/migrations/20261031201414_program_text_explicit_official_source_admission.sql',import.meta.url),'utf8');
  await expect(parse(sql.replace('BEGIN;',()=>`BEGIN;\n${migration}`))).resolves.toHaveProperty('stmts');
  expect(()=>explicitSourceAdmissionRollbackSql({proposal:f.proposal,document:proof.target_document,actor:"invalid'actor"})).toThrow('UUID');
 });
});
