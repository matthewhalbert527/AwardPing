import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'libpg-query';
const path = new URL('../supabase/migrations/20261026231036_program_variation_reviews.sql', import.meta.url);
const sql = readFileSync(path, 'utf8');
function body(name) {
  const start = sql.search(new RegExp(`create(?: or replace)? function ${name.replaceAll('.', '\\.')}\\(`));
  if (start < 0) throw new Error(`Missing function ${name}`);
  const open = sql.indexOf('$$', start), end = sql.indexOf('$$;', open + 2);
  if (end < 0) throw new Error('Unclosed function');
  return sql.slice(start, end + 3);
}
const mutators = ['create_program_variation_inventory', 'append_program_variation_scopes', 'seal_program_variation_inventory',
  'save_program_variation_unit', 'approve_program_variation_award', 'publish_program_variation_batch'];
describe('variation schema authority and transaction wiring', () => {
  it('parses every new statement as PostgreSQL17 syntax', async () => { const parsed = await parse(sql); expect(parsed.stmts.length).toBeGreaterThan(30); });
  it('retains bounded v1 full-original, UTF16, quote, date-year and21-field checks', () => {
    const validation = body('private.awardping_variation_fact_validation_valid');
    for (const guard of ['octet_length(p_validation::text)>33554432', 'cardinality(v_ids) not between 1 and 500', "jsonb_array_length(v_review->'fields')<>21",
      "private.awardping_program_utf16_length(v_doc->>'text')", "v_ref->>'text_sha256'", "v_ref->>'blocks_sha256'", 'private.awardping_program_block_valid',
      'private.awardping_program_utf16_slice', 'v_supported_years', "jsonb_array_length(v_item->'support') not between 1 and 12", "jsonb_array_length(v_field->'items')>64",
      'private.awardping_program_fact_known_html_shell', 'private.awardping_program_fact_known_footer_only_pdf', 'private.awardping_program_fact_source_ready']) expect(validation).toContain(guard);
    const original = readFileSync(new URL('../supabase/migrations/20261025175832_program_text_footer_only_pdf_hold.sql', import.meta.url), 'utf8');
    const marker = " if (select count(distinct value->>'field') from jsonb_array_elements(v_review->'fields'))<>21";
    const end = '\nexception when others then return false;';
    expect(validation.slice(validation.indexOf(marker), validation.indexOf(end))).toBe(original.slice(original.indexOf(marker), original.indexOf(end)));
  });
  it.each(mutators)('keeps %s one serialized transaction with no swallowed partial mutation', name => {
    const fn = body(`public.${name}`); expect(fn).toContain("pg_advisory_xact_lock(pg_catalog.hashtextextended('stage1-national-25-release',0))");
    expect(fn).not.toMatch(/exception\s+when/i); expect(fn).not.toMatch(/\b(?:commit|rollback)\s*;/i); expect(fn).toContain("set search_path='' ");
  });
  it('applies default-deny function grants only after every function is created', () => {
    const acl = sql.indexOf('-- All privileged entry points'); expect(acl).toBeGreaterThan(sql.lastIndexOf('create function'));
    expect(sql.slice(acl)).toContain('revoke all on function %s from public,anon,authenticated');
    expect(sql.slice(acl)).toContain('grant execute on function %s to service_role');
    for (const name of [...mutators, 'get_program_variation_admin_page','get_program_variation_admin_batch','get_program_variation_publication','get_program_variation_public_context']) expect(sql.slice(acl)).toContain(`'${name}'`);
    expect(sql).toContain('enable row level security'); expect(sql).toContain('revoke all on public.%I from public,anon,authenticated,service_role');
  });
  it('requires provider-index original proof, exact source ownership and bounded scope roles', () => {
    const fn = body('public.append_program_variation_scopes');
    for (const guard of ['private.awardping_variation_provider_proof_valid(p_provider_validation,i.cohort_key)', 'private.awardping_variation_quote_valid',
      'private.awardping_program_text_source_access', 'stage1_award_members', 'stage1_award_source_identity_rules', "jsonb_array_length(p_scopes) not between 1 and 25",
      "jsonb_array_length(r->'source_ids') not between 1 and 50", "source_url' is distinct from src.url"]) expect(fn).toContain(guard);
    expect(fn).not.toMatch(/update\s+public\.shared_award_sources/i);
  });
  it('seals only a counted, hash-pinned complete inventory and preserves retired identities', () => {
    const fn = body('public.seal_program_variation_inventory');
    for (const guard of ['actual_hash is distinct from p_expected_hash','p_complete_provider_inventory_reviewed is distinct from true', 'h is distinct from i.previous_revision',
      '<>i.expected_variants','oldscope.scope_key','ns.scope_key=oldscope.scope_key','private.awardping_variation_inventory_sources_current']) expect(fn).toContain(guard);
  });
  it('independently reconstructs inheritance and rejects unresolved substitutes', () => {
    const fn = body('public.save_program_variation_unit');
    expect(fn).toContain("d->'decision' is distinct from f"); expect(fn).toContain("f->>'status'='unresolved'");
    expect(fn).toContain('parent.content_hash is distinct from'); expect(fn).toContain('private.awardping_variation_quote_valid');
    expect(fn).toContain("u->'capture_refs' is distinct from v#>'{review,capture_refs}'");
  });
  it('rejects missing/extra/stale child reviews before recording per-award approval', () => {
    const fn = body('public.approve_program_variation_award');
    for (const guard of ['jsonb_object_keys(p_child_reviews)', '<>i.expected_variants', "'id','content_hash'", 'child.scope_key<>entry.scope_key',
      'child.shared_hash is distinct from parent.content_hash', "f->>'status'='unresolved'", 'private.awardping_variation_unit_current(child.id,child.created_at,true)']) expect(fn).toContain(guard);
  });
  it('retains approval across validated no-program-change baselines, but not substantive changes', () => {
    const current = body('private.awardping_variation_unit_current');
    expect(current).toContain("last_program_update_at')::timestamptz>p_at");
    expect(current).toContain("p_strict_hash and s.text_monitoring_state#>>'{latest_ref,text_sha256}'");
    const publicCurrent = body('private.awardping_variation_award_current'); expect(publicCurrent).toContain('a.reviewed_at,false');
  });
  it('requires an exact complete25-approved manifest and blocks the flat v1 bypass', () => {
    const fn = body('public.publish_program_variation_batch'); expect(fn).toContain('jsonb_object_keys(p_approval_ids))<>25');
    expect(fn).toContain('private.awardping_variation_award_current(a.id)'); expect(fn).toContain('p_expected_revision is distinct from r.revision');
    const old = body('public.publish_program_text_fact_batch'); expect(old).toContain('New factual publication requires all25 complete provider-variation manifests');
    expect(old).not.toMatch(/update\s+public\.program_text_fact_release/i);
  });
  it('exposes only pinned published unit values and fails on an unknown selection', () => {
    const fn = body('public.get_program_variation_public_context'); expect(fn).toContain('if not release.is_active then return null');
    expect(fn).toContain("raise exception 'Unknown approved variation.'"); expect(fn).toContain('release.approval_ids'); expect(fn).toContain('limit 25');
    expect(fn).toContain("i.revision::text||':'||last_key"); expect(fn).not.toContain("u.validation->'source_text'");
  });
  it('pins public source URLs and owner identities to the approved unit and inventory', () => {
    const context = body('public.get_program_variation_public_context');
    expect(context).toContain("'source_bindings'"); expect(context).toContain("u.validation#>'{review,capture_refs}'");
    expect(context).toContain("value#>>'{source,url}'"); expect(context).toContain("value#>>'{source,shared_award_id}'");
    expect(context).toContain("'selected_option',selected_meta"); expect(context).toContain("scope_key=selected");
    const publication = body('public.get_program_variation_publication'); expect(publication).toContain("'source_bindings'");
    expect(publication).toContain("role#>array['evidence','source_bindings',source_id]");
    expect(publication).toContain("'variant_count',i.expected_variants");
  });
});
