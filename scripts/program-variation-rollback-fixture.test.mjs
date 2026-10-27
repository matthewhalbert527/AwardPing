import { describe, it, expect } from 'vitest';
import { parse } from 'libpg-query';
import { buildProgramVariationRollbackFixture } from './lib/program-variation-rollback-fixture.mjs';
const registries=Array.from({length:25},(_,i)=>({cohort_key:`award_${i}`,canonical_shared_award_id:`10000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`}));
describe('portable rollback-only full variation rehearsal',()=>{
 it('generates parseable synthetic25-award approval/publication proof with outer rollback',async()=>{
  const sql=await buildProgramVariationRollbackFixture(registries,'ec349339-ff62-4d2e-a610-8c361b4044ec');
  expect(sql).toContain('BEGIN;');expect(sql.trimEnd().endsWith('ROLLBACK;')).toBe(true);expect(sql).not.toMatch(/\bCOMMIT\s*;/i);
  const parsed=await parse(sql);expect(parsed.stmts).toHaveLength(5);
  for(const guard of ['Late append did not roll back atomically','Wrong inventory hash accepted','Missing variant accepted','Unresolved child accepted','Invalid quote accepted','Stale shared hash accepted',
   'No-change approval was lost','Substantive change did not stale approval','Revoked source admission remained current','Exact25 publication failed','Unknown variation silently fell back','Anonymous execution was accepted',
   'Draft count increase changed retained scopes','Equal draft count was not idempotent','Stale draft count revision accepted','Wrong draft count hash accepted','Draft count hid an active route',
   'Unaudited draft count revision accepted','Counted missing route was silently sealed','Reviewed draft count reduction failed','Sealed draft count mutation accepted'])expect(sql).toContain(guard);
  expect(Buffer.byteLength(sql)).toBeLessThan(1024*1024);
 });
 it('rejects incomplete or duplicate registry scopes before generating any SQL',async()=>{
  await expect(buildProgramVariationRollbackFixture(registries.slice(1),'ec349339-ff62-4d2e-a610-8c361b4044ec')).rejects.toThrow();
  await expect(buildProgramVariationRollbackFixture(registries.map((r,i)=>i?registries[0]:r),'ec349339-ff62-4d2e-a610-8c361b4044ec')).rejects.toThrow();
 });
});
