import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {parse} from 'libpg-query';
import {buildProgramAwardExpansionBatchThreeRollback} from './test-support/program-award-expansion-batch-three-rollback.mjs';

const migration=readFileSync(new URL('../supabase/migrations/20261101050314_program_award_expansion_batch_three.sql',import.meta.url),'utf8');
describe('one additional reviewed five-award batch',()=>{
 it('contains explicit bounded declarations without mutating legacy identities or applying admissions',async()=>{
  expect((await parse(migration)).stmts.length).toBeGreaterThan(8);
  expect(migration).toContain('check(launch_rank between 1 and 40)');
  expect(migration).toContain('check(batch in (1,2,3))');
  expect(migration).toContain('jsonb_array_length(result) not in(0,5,10,15)');
  expect(migration).toContain('Expansion is bounded to fifteen awards.');
  expect(migration).not.toMatch(/execute\s+pg_get_functiondef|alter table public\.stage1_award_registry/i);
  expect(migration).not.toMatch(/^\s*(?:select|perform)\s+public\.(?:admit_program_award_expansion_batch|activate_program_award_expansion_batch|commit_program_basic_facts)/im);
 });
 it('requires all prior five-award batches and preserves source/history/publication gates',()=>{
  expect(migration.match(/generate_series\(1,p_batch-1\) previous\(batch\)/g)).toHaveLength(2);
  for(const retained of ["jsonb_array_length(p_awards)<>5","jsonb_array_length(w->'sources') not between 1 and 6",
   "actual_boundary is distinct from q->'url_alias_boundary'","q->'expected_text_monitoring_state' is distinct from '{}'::jsonb",
   'private.program_award_expansion_initial_ready(a.cohort_key,e)',"'baseline_only'","'server_first_capture_eligible',false",
   'Accepted first ten candidate values changed.','Existing bounded constraints changed.']) expect(migration).toContain(retained);
  expect(migration).toContain('program_award_expansion_get_form_authority');
  expect((migration.match(/launch_rank between 26 and 40/g)||[])).toHaveLength(3);
  expect(migration).toContain("m.status='active' and m.role in ('owner','admin') for share");
  expect(migration).not.toContain('CREATE OR REPLACE FUNCTION public.untrack_office_program_expansion_atomic');
  expect(migration).toContain('p.proacl::text is not distinct from');
  expect(migration).not.toMatch(/grant\s+execute[^;]+to\s+(?:public|anon|authenticated)/i);
 });
 it('keeps the exact next-five identity allowlist rather than permitting arbitrary rank40 records',()=>{
  for(const id of ['dc1674f0-0bd2-4546-afc8-1034ea213274','d80105aa-41c2-454d-9afa-a8639d63ce0a','ecc92ab9-beac-4771-8bd4-c7e305519dfc',
   'f7cea269-67b7-4372-bd68-4a995c096db4','fe11c501-8d14-41bf-8cc8-a7a2edb2ca50']) expect(migration).toContain(id);
  expect(migration).toContain("private.program_award_expansion_candidate('unreviewed_batch_four') is not null");
  const candidates=JSON.parse(migration.match(/\$candidates\$([\s\S]+?)\$candidates\$/)[1]);
  const next=candidates.filter(candidate=>candidate.batch===3);
  expect(next).toHaveLength(5);
  expect(next.flatMap(candidate=>candidate.source_urls)).toHaveLength(16);
  expect(next.find(candidate=>candidate.cohort_key==='nih_oxcam').source_urls).not.toContain('https://oxcam.gpp.nih.gov/');
  expect(next.find(candidate=>candidate.cohort_key==='princeton_africa').source_urls).not.toContain('https://www.princetoninafrica.org/');
 });
 it('does not shadow the activation loop record in the all-prior-batches predicate',()=>{
  const activation=migration.match(/CREATE OR REPLACE FUNCTION public\.activate_program_award_expansion_batch[\s\S]+?\$function\$;/)[0];
  expect(activation).toContain('declare a public.program_award_expansion_admissions%rowtype;');
  expect(activation).toContain('previous_admission.batch=previous.batch');
  expect(activation).toContain("previous_admission.status='active'");
  expect(activation).not.toMatch(/public\.program_award_expansion_admissions\s+a\s+where\s+a\.batch=previous\.batch/);
 });
 it('builds a rollback-only real-plan rehearsal with atomicity, backend-only access, repeat gating and replay preservation',async()=>{
  const awards=Array.from({length:5},(_,n)=>({cohort_key:'rollback_'+n,sources:[]}));
  const sql=buildProgramAwardExpansionBatchThreeRollback({migration,awards});
  expect(sql).toMatch(/^begin isolation level repeatable read;/);expect(sql).toMatch(/rollback;\s*$/);
  for(const text of ['Rejected plan left a partial third batch','Unauthenticated batch-three authority exposed','Exact admission replay reset retained history',
   'Unverified first coverage changed the public35','Uncollected or unsupported third batch activated','The accepted35 or historical source/fact bodies changed',
   'Unauthenticated office tracking was accepted','pending sources gained follow permission']) expect(sql).toContain(text);
  expect((await parse(sql)).stmts.length).toBeGreaterThan(15);
  const block=sql.split('do $batch_three_rollback_checks$')[1];
  const declarations=block.split('\nbegin\n')[0];
  const variables=new Set([...declarations.matchAll(/(?:declare|;)\s*(\w+)\s+(?:jsonb|text|boolean|integer|bigint|uuid|record)\b/g)].map(match=>match[1]));
  const aliases=[...block.matchAll(/(?:from|join)\s+[\w.]+\s+(?:as\s+)?([a-z_]\w*)/gi)].map(match=>match[1]);
  expect(variables.has('h')).toBe(true);
  expect(aliases.filter(alias=>variables.has(alias))).toEqual([]);
 });
 it('rejects a committing migration, missing declarations or an incomplete/duplicate plan',()=>{
  const awards=Array.from({length:5},(_,n)=>({cohort_key:'rollback_'+n,sources:[]}));
  expect(()=>buildProgramAwardExpansionBatchThreeRollback({migration:migration+'\ncommit;',awards})).toThrow('transaction-free');
  expect(()=>buildProgramAwardExpansionBatchThreeRollback({migration:'select 1;',awards})).toThrow('transaction-free');
  expect(()=>buildProgramAwardExpansionBatchThreeRollback({migration,awards:awards.slice(1)})).toThrow('five-award');
  expect(()=>buildProgramAwardExpansionBatchThreeRollback({migration,awards:Array(5).fill(awards[0])})).toThrow('five-award');
 });
});
