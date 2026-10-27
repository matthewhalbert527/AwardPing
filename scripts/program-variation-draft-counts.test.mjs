import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'libpg-query';
const sql = readFileSync(new URL('../supabase/migrations/20261026231051_program_variation_draft_counts.sql', import.meta.url), 'utf8');
describe('audited draft-only variation count revision', () => {
  it('parses as PostgreSQL with one service-only serialized mutation', async () => {
    expect((await parse(sql)).stmts).toHaveLength(4);
    expect(sql).toContain("pg_advisory_xact_lock(pg_catalog.hashtextextended('stage1-national-25-release',0))");
    expect(sql).toContain("security definer set search_path=''"); expect(sql).toContain('from public,anon,authenticated'); expect(sql).toContain('to service_role');
  });
  it('requires exact hash, revision and current draft head before every possible write', () => {
    for (const guard of ["inventory_row.status<>'draft'", 'inventory_row.revision is distinct from p_expected_revision',
      'private.awardping_variation_inventory_hash(inventory_row.id) is distinct from p_expected_hash', 'public.program_variation_inventory_draft_heads',
      'h.revision=inventory_row.revision']) expect(sql.indexOf(guard)).toBeLessThan(sql.indexOf('update public.program_variation_inventories'));
    expect(sql).toContain("using errcode='40001'"); expect(sql).not.toMatch(/exception\s+when/i);
  });
  it('never hides existing active routes and records old/new count and revision', () => {
    expect(sql).toContain("scope.scope_key<>'common' and not scope.retired"); expect(sql).toContain('p_expected_variants<active_count');
    expect(sql).toContain('p_expected_variants<0'); expect(sql).toContain("not between 20 and 2000");
    expect(sql).toContain("values('draft_count_revised'"); expect(sql).toContain("'previous_count',previous_count"); expect(sql).toContain("'previous_revision',previous_revision");
  });
  it('only revises a changed count and cannot edit cycle, scopes, sealed content or approval records', () => {
    expect(sql).toContain('if p_expected_variants<>inventory_row.expected_variants then');
    expect(sql).toContain('set expected_variants=p_expected_variants,revision=gen_random_uuid()');
    expect(sql).not.toMatch(/(?:update|delete from) public\.(?:shared_award|program_variation_scopes|program_variation_unit_reviews|program_variation_award_approvals|program_variation_release)/);
    expect(sql).not.toMatch(/set\s+(?:cycle|status|content_hash)\s*=/i);
  });
});
