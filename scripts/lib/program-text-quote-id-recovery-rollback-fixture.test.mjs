import {readFileSync} from 'node:fs';
import {describe,it,expect} from 'vitest';
import {parse} from 'libpg-query';
import {programTextQuoteIdRecoveryRollbackFixture} from './program-text-quote-id-recovery-rollback-fixture.mjs';
const migration=readFileSync(new URL('../../supabase/migrations/20261027003046_program_text_quote_id_recovery.sql',import.meta.url),'utf8');
describe('finite actual-row recovery rollback rehearsal',()=>{
 it('generates a parseable explicit outer rollback and never executes a DB operation',async()=>{
  const sql=programTextQuoteIdRecoveryRollbackFixture({migration});expect(sql.startsWith('BEGIN;')).toBe(true);expect(sql.trimEnd().endsWith('ROLLBACK;')).toBe(true);
  expect((await parse(sql)).stmts.length).toBeGreaterThan(24);expect(sql).not.toMatch(/\bCOMMIT\s*;/i);expect(sql).toContain(migration);
 });
 it('uses the actual failed saved response and exact pair, never fabricating a provider result',()=>{
  const sql=programTextQuoteIdRecoveryRollbackFixture({migration});expect(sql).toContain('fixture_before#>\'{ai_result,responses}\'');
  expect(sql).toContain('Projection changed something other than the two proven IDs');expect(sql).not.toContain('INSERT INTO public.shared_award_visual_review_candidates');
  expect(sql).toContain('Force a failure after the journal insert');expect(sql).toContain('Late transition failure left partial recovery');
  expect(sql).toContain("((fixture_after->'ai_result')-'responses')");
  expect(sql).toContain("((fixture_after->'worker_metadata')-'program_text_quote_id_recovery')");
  expect(sql).not.toContain("->'ai_result'-'responses'");
 });
 it('covers stale proof, privilege boundaries, exact replay, immutable history and zero spending/fact writes',()=>{
  const sql=programTextQuoteIdRecoveryRollbackFixture({migration});for(const text of ['Changed current capture pair','Changed current epoch','Changed roster version',
   'Unauthenticated recovery','Journal UPDATE','Journal DELETE','Journal TRUNCATE','Identical replay repeated a live transition',
   'gemini_spend_reservations','program_text_fact_reviews','program_variation_award_approvals','shared_award_change_events','fixture_source_before'])expect(sql).toContain(text);
  expect(sql).not.toContain('jsonb_agg(to_jsonb(c))');
 });
 it.each(['',migration+'\nCOMMIT;',migration+'\nROLLBACK;'])('rejects missing or transaction-escaping migration text',value=>{
  expect(()=>programTextQuoteIdRecoveryRollbackFixture({migration:value})).toThrow();
 });
});
