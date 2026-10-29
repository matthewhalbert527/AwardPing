import {readFileSync} from 'node:fs';
import {describe,it,expect} from 'vitest';
import {parse} from 'libpg-query';
import {currentBasicFactsRollbackFixture} from './current-basic-facts-rollback-fixture.mjs';
const migration=readFileSync(new URL('../../supabase/migrations/20261029192859_current_capture_basic_facts.sql',import.meta.url),'utf8');
const input={migration,epoch:'ec349339-ff62-4d2e-a610-8c361b4044ec',award_id:'7007882c-af99-4919-ad2c-2672ffcccfaf'};
describe('inert native-schema current-basic rehearsal',()=>{
 it('confines all explicit synthetic fixtures and additive DDL to outer rollback',async()=>{const sql=await currentBasicFactsRollbackFixture(input);expect(sql.startsWith('BEGIN;')).toBe(true);expect(sql.trimEnd().endsWith('ROLLBACK;')).toBe(true);expect(sql).not.toMatch(/\bCOMMIT\s*;/i);expect((await parse(sql)).stmts.length).toBeGreaterThan(25);expect(sql).toContain('synthetic_fixture_only');expect(sql).toContain(migration);});
 it('covers real23 legacy getters plus pending-owner, immutable repeats, stale identity and atomic publication',async()=>{const sql=await currentBasicFactsRollbackFixture(input);for(const value of ['Existing 23 basic getters changed','Original 23 snapshot getters regressed','Intermediate recovery without accepted revalidation','Stale owner-review hash','Source URL authority drift','Same observation accepted','Caller-forged repeat ledger','Repeat ledger mutation accepted','Unauthorized role boundary','Late failure left a partial snapshot/head','Identical replay not recognized','Same-content owner decision erased','Changed current content preserved','Stale source inventory preserved','Basic path changed outgoing alerts'])expect(sql).toContain(value);});
 it.each(['',migration+'\nCOMMIT;',migration+'\nROLLBACK;'])('rejects missing or transaction-escaping schema',async value=>{await expect(currentBasicFactsRollbackFixture({...input,migration:value})).rejects.toThrow();});
});
