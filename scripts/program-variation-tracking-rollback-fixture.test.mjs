import {describe,it,expect} from 'vitest';import {parse} from 'libpg-query';
import {buildProgramVariationTrackingRollbackFixture} from './lib/program-variation-tracking-rollback-fixture.mjs';
const registries=Array.from({length:25},(_,n)=>({cohort_key:`award_${n}`,canonical_shared_award_id:`10000000-0000-4000-8000-${String(n+1).padStart(12,'0')}`}));
describe('normal authenticated office tracking rollback rehearsal',()=>{
 it('generates a bounded exact25 synthetic release and normal-owner tracking proof with one final rollback',async()=>{
  const sql=await buildProgramVariationTrackingRollbackFixture(registries,'ec349339-ff62-4d2e-a610-8c361b4044ec');expect((await parse(sql)).stmts).toHaveLength(7);
  expect(sql.trimEnd().endsWith('ROLLBACK;')).toBe(true);expect(sql).not.toMatch(/\bCOMMIT;/i);expect(Buffer.byteLength(sql)).toBeLessThan(1000000);
  for(const guard of ['Normal authenticated tracking did not preserve approved facts/title/type.','Independent review_later follow was blocked, faked OPEN or duplicated.',
   'Wrong office was authorized','Ordinary office member was authorized','Unauthenticated follow was authorized','Wrong member set was accepted','Wrong original release epoch was accepted',
   'Stale variation release was accepted','Stale approval hash was accepted','Unapproved source was admitted','Unapproved source URL was admitted','Wrong award owner was admitted',
   'Revoked text authority was admitted','Inactive publication was admitted','A failed follow left partial office writes','Authenticated tracking privilege boundary changed','Legacy tracking was changed',
   'Default follow escaped the bounded common review','Explicit follow escaped its one pinned source','Stale inventory revision was accepted','Stale mutable source proof was accepted','Different exact document history was silently reassigned'])expect(sql).toContain(guard);
 });
});
