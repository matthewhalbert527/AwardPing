import{describe,it,expect}from'vitest';import{readFileSync}from'node:fs';import{parse}from'libpg-query';import{reviewedPdfFirstCoverageRollbackFixture as build}from'./reviewed-pdf-first-coverage-rollback-fixture.mjs';
const migration=readFileSync(new URL('../../supabase/migrations/20261029194502_reviewed_visible_pdf_first_coverage.sql',import.meta.url),'utf8');
const document={reference:{source:{id:'11111111-1111-4111-8111-111111111111'}},text:"quoted ' text"};
describe('strictly rollback-only reviewed PDF native rehearsal',()=>{
 it('generates parseable exact-source transaction with actual-role/idempotence/provenance checks',async()=>{const sql=build({migration,document,review_receipt:{}});expect(sql.startsWith('BEGIN;')).toBe(true);expect(sql.endsWith('ROLLBACK;\n')).toBe(true);expect(sql).toContain("quoted '' text");expect(sql).toContain("SET LOCAL ROLE service_role");expect(sql).toContain('reviewed_pdf_native_checks');expect((await parse(sql)).stmts.length).toBe(36);});
 it('rejects injected identity and nested transaction inputs',()=>{expect(()=>build({migration,document:{reference:{source:{id:"x';commit;"}}}})).toThrow();expect(()=>build({migration:migration+'COMMIT;',document})).toThrow();});
});
