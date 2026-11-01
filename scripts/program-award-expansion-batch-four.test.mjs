import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {parse} from 'libpg-query';
import {buildProgramAwardExpansionBatchFourRollback} from './test-support/program-award-expansion-batch-four-rollback.mjs';
const migration=readFileSync(new URL('../supabase/migrations/20261101155527_program_award_expansion_batch_four.sql',import.meta.url),'utf8');
function plan(){const reviewed_at='2026-11-01T16:00:00.000Z';return{awards:Array.from({length:5},(_,index)=>({cohort_key:'offline_'+index,reviewed_at,sources:Array.from({length:3},(_,source)=>({id:'offline_source_'+index+'_'+source,url_alias_boundary:[]}))})),ownerPlan:{schema:'awardping.batch4-owner-creation-plan.v1',batch:4,reviewed_at,owners:[{cohort_key:'ellison_graduate'},{cohort_key:'rales'}]}};}
describe('one additional bounded five-award batch4',()=>{
 it('parses explicit declarations with cumulative45/20/four bounds and no live admission',async()=>{
  expect((await parse(migration)).stmts.length).toBeGreaterThan(12);
  for(const value of ['check(launch_rank between 1 and 45)','check(batch in (1,2,3,4))','jsonb_array_length(result) not in(0,5,10,15,20)','Expansion is bounded to twenty awards.'])expect(migration).toContain(value);
  expect(migration).not.toMatch(/execute\s+pg_get_functiondef|alter table public\.stage1_award_registry/i);
  expect(migration).not.toMatch(/^\s*(?:select|perform) public\.(?:create_program_award_expansion_batch_four_owners|admit_program_award_expansion_batch|activate_program_award_expansion_batch)/m);
 });
 it('contains exactly the reviewed20 candidates and final three sources for each new award',()=>{
  const candidates=JSON.parse(migration.match(/\$candidates\$([\s\S]+?)\$candidates\$/)[1]);
  expect(candidates).toHaveLength(20);expect(candidates.slice(0,15).map(row=>row.launch_rank)).toEqual(Array.from({length:15},(_,n)=>26+n));
  expect(candidates.slice(15).map(row=>row.cohort_key)).toEqual(['astronaut','watson','mccall_macbain','ellison_graduate','rales']);
  expect(candidates.slice(15).map(row=>row.source_urls.length)).toEqual([3,3,3,3,3]);
  expect(migration).toContain("private.program_award_expansion_candidate('unreviewed_batch_five') is not null");
 });
 it('preserves previous batch, source history, original25 and permission boundaries',()=>{
  expect(migration.match(/generate_series\(1,p_batch-1\) previous\(batch\)/g)).toHaveLength(2);
  expect(migration).toContain('previous_admission.batch=previous.batch');
  expect(migration.match(/launch_rank between 26 and 45/g)).toHaveLength(3);
  for(const value of ['Accepted first15 candidate values changed.',"q->'expected_text_monitoring_state' is distinct from '{}'::jsonb",'actual_boundary is distinct from',"'baseline_only'",'private.program_award_expansion_initial_ready(a.cohort_key,e)','p.proacl::text is not distinct from','p.proconfig is not distinct from'])expect(migration).toContain(value);
  expect(migration).not.toContain('CREATE OR REPLACE FUNCTION public.untrack_office_program_expansion_atomic');
  expect(migration).not.toContain('CREATE OR REPLACE FUNCTION private.program_award_expansion_get_form_authority');
 });
 it('creates only the exact two blank canonical identities through a backend-only atomic RPC',()=>{
  const owner=migration.match(/CREATE OR REPLACE FUNCTION public\.create_program_award_expansion_batch_four_owners[\s\S]+?\$function\$;/)[0];
  for(const value of ['3ed2ee95-7e6c-4f75-800e-6d42f5288dbb','56f2136d-1ecf-44e3-be75-61e49c93f571','lock table public.shared_awards in share row exclusive mode','v_existing=2 and v_exact=2','v_exact<>2',"inserted.public_facts='{}'::jsonb"])expect(owner).toContain(value);
  expect(owner).not.toMatch(/\bupdate\s+public\.|insert into public\.(?:shared_award_sources|program_award_members|program_basic_fact)/i);
  expect(migration).toContain('revoke all on function public.create_program_award_expansion_batch_four_owners(jsonb,text,text) from public,anon,authenticated,service_role');
  expect(migration).toContain('grant execute on function public.create_program_award_expansion_batch_four_owners(jsonb,text,text) to service_role');
 });
 it('builds an unconditional rollback rehearsal covering owner atomicity/partial absence, ACL denial, silent admission and all40 history',async()=>{
  const sql=buildProgramAwardExpansionBatchFourRollback({migration,...plan()});
  expect(sql).toMatch(/^begin isolation level repeatable read;/);expect(sql).toMatch(/rollback;\s*$/);expect((await parse(sql)).stmts.length).toBeGreaterThan(20);
  for(const value of ['Invalid two-owner plan was partially inserted','Partial existing owner was reused, changed or completed','Owner replay changed rows','Unauthenticated batch4 backend authority exposed','Rejected plan left a partial fourth batch','Uncollected unsupported fourth batch activated','Admission replay reset retained history','The accepted40, undergraduate Ellison or retained source/approval/fact bodies changed'])expect(sql).toContain(value);
 });
 it('has no PLpgSQL declaration/table-alias collisions in the rollback checker',()=>{
  const block=buildProgramAwardExpansionBatchFourRollback({migration,...plan()}).split('do $batch_four_rollback_checks$')[1],declarations=block.split('\nbegin\n')[0];
  const variables=new Set([...declarations.matchAll(/(?:declare|;)\s*(\w+)\s+(?:jsonb|text|boolean|integer|bigint|uuid|record)\b/g)].map(match=>match[1]));
  const aliases=[...block.matchAll(/(?:from|join)\s+[\w.]+\s+(?:as\s+)?([a-z_]\w*)/gi)].map(match=>match[1]);expect(variables.has('v_plan_hash')).toBe(true);expect(aliases.filter(alias=>variables.has(alias))).toEqual([]);
 });
 it('rejects committing migrations, wrong source counts and owner timestamps unbound from the actual review',()=>{
  const input=plan();expect(()=>buildProgramAwardExpansionBatchFourRollback({migration:migration+'\ncommit;',...input})).toThrow('transaction-free');
  input.awards[0].sources.pop();expect(()=>buildProgramAwardExpansionBatchFourRollback({migration,...input})).toThrow('15-source');
  const other=plan();other.ownerPlan.reviewed_at='2026-11-01T17:00:00.000Z';expect(()=>buildProgramAwardExpansionBatchFourRollback({migration,...other})).toThrow('same actual fresh metadata');
 });
});
