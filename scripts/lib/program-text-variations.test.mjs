import { describe, it, expect, vi } from 'vitest';
import { PROGRAM_FACT_FIELDS } from './program-text-facts.mjs';
import { buildProgramTextCapture } from './program-text-capture.mjs';
import { programTextReference } from './program-text-storage.mjs';
import { validateVariationScope, validateVariationSupport, validateVariationUnit, validateVariationManifest, variationContextRoles, variationContentHash } from './program-text-variations.mjs';

const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function fixture() {
  const epoch = id(1), award = id(2), source = { id: id(3), shared_award_id: award, url: 'https://example.org/program', title: 'Program', page_type: 'application', admin_review_status: 'open' };
  const text = '🎓 Example Award supports all applicants. All published program rules on this page apply to every applicant group. The U.S. deadline is January 31, 2027.';
  const capture = buildProgramTextCapture({ source, acquisition: 'http_html', raw_bytes: Buffer.from(`<html><body>${text}</body></html>`), content_type: 'text/html', text,
    blocks: [{ id: 'body', text, start_utf16: 0, end_utf16: text.length }], extractor: { name: 'fixture', version: '1' }, captured_at: '2026-10-24T01:00:00.000Z' });
  const ref = programTextReference(capture);
  const current = { ...source, text_monitoring_state: { schema: 'awardping.program-text-state.v1', epoch, status: 'baseline_ready', baseline_ref: ref, latest_ref: ref,
    successful_checks: 2, first_captured_at: '2026-10-23T01:00:00.000Z', last_checked_at: ref.captured_at } };
  const role = { source_role: 'application_materials', revision: id(4), source_ids: [source.id], manifest_status: 'reviewed_text',
    evidence: { schema: 'awardping.program-text-source-role.v1', source_bindings: { [source.id]: { source_url: source.url, shared_award_id: award,
      authority_url: source.url, review_note: 'Reviewed current official provider index and its exact published scope.' } } } };
  const quote = value => ({ source_id: source.id, capture_id: capture.capture_id, block_id: 'body', start_utf16: text.indexOf(value), end_utf16: text.indexOf(value) + value.length, text: value });
  const applicability = quote('All published program rules on this page apply to every applicant group.');
  const attributes = { country: null, course: null, track: null, applicant_group: null };
  const common = { scope_key: 'common', label: 'Shared rules', attributes, source_roles: [role], provider_support: [applicability], retired: false };
  const variant = { ...structuredClone(common), scope_key: 'us-research', label: 'U.S. research', attributes: { ...attributes, country: 'United States', track: 'Research' } };
  const inventory = { id: id(5), revision: id(6), content_hash: 'a'.repeat(64), cohort_key: 'example', cycle: '2027 intake', status: 'sealed', expected_variants: 1 };
  const decisions = PROGRAM_FACT_FIELDS.map(field => ({ field, mode: 'replace', decision: { field, status: 'not_published', items: [], note: 'All relevant official source material was reviewed; no distinct value is published.' } }));
  decisions.find(d => d.field === 'overview').decision = { field: 'overview', status: 'verified', items: [{ value: 'Example Award supports all applicants.', track: null, support: [quote('Example Award supports all applicants.')] }], note: '' };
  const unit = { schema: 'awardping.program-variation-unit.v1', inventory_id: inventory.id, scope_key: 'common', shared_review_id: null, shared_hash: null,
    reviewed_all_sources: true, capture_refs: [ref], decisions };
  const context = { inventory, scopes: [common, variant], shared: null, registry: { cohort_key: 'example', canonical_shared_award_id: award }, sources: [current], memberIds: [award], epoch,
    loadCapture: vi.fn(async () => capture) };
  return { context, unit, common, variant, applicability, quote, capture, current, ref };
}
async function childFixture() {
  const f = fixture(), envelope = await validateVariationUnit(f.unit, f.context);
  const shared = { id: id(7), inventory_id: f.context.inventory.id, scope_key: 'common', content_hash: 'b'.repeat(64), validation: envelope.validation, blockers: [] };
  const child = { ...f.unit, scope_key: 'us-research', shared_review_id: shared.id, shared_hash: shared.content_hash,
    decisions: PROGRAM_FACT_FIELDS.map(field => ({ field, mode: 'inherit', support: [f.applicability] })) };
  return { ...f, child, shared, context: { ...f.context, shared } };
}
describe('bounded provider variation reviews', () => {
  it('validates exact provider scope ownership and scope-prefixed role revisions', () => {
    const f = fixture(); expect(validateVariationScope(f.common, { sources: [f.current], memberIds: f.context.memberIds, cohort: 'example', epoch: f.context.epoch })).toBe(f.common);
    expect(variationContextRoles(f.context.scopes, 'us-research').map(r => r.source_role)).toEqual(['common/application_materials', 'us-research/application_materials']);
  });
  it.each(['wrong-owner', 'wrong-url', 'unapproved', 'legacy-evidence', 'extra-role-field'])('rejects invalid source authority (%s)', kind => {
    const f = fixture();
    if (kind === 'wrong-owner') f.current.shared_award_id = id(99);
    if (kind === 'wrong-url') f.common.source_roles[0].evidence.source_bindings[f.current.id].source_url += '/other';
    if (kind === 'unapproved') f.current.admin_review_status = 'review_later';
    if (kind === 'legacy-evidence') f.common.source_roles[0].evidence.schema = 'visual';
    if (kind === 'extra-role-field') f.common.source_roles[0].authority = true;
    expect(() => validateVariationScope(f.common, { sources: [f.current], memberIds: f.context.memberIds, cohort: 'example', epoch: f.context.epoch })).toThrow();
  });
  it('cold-validates shared and inherited child fields through the unchanged21-field contract', async () => {
    const f = await childFixture(); const result = await validateVariationUnit(f.child, f.context);
    expect(result.validation.blockers).toEqual([]); expect(result.validation.review.fields).toHaveLength(21);
    expect(result.validation.public_facts.overview).toBe('Example Award supports all applicants.');
  });
  it.each(['missing-field', 'duplicate-field', 'stale-shared-hash', 'no-applicability', 'invented-quote', 'extra-property', 'missing-reference'])('fails closed on %s', async kind => {
    const f = await childFixture();
    if (kind === 'missing-field') f.child.decisions.pop();
    if (kind === 'duplicate-field') f.child.decisions[1] = f.child.decisions[0];
    if (kind === 'stale-shared-hash') f.child.shared_hash = 'c'.repeat(64);
    if (kind === 'no-applicability') f.child.decisions[0].support = [];
    if (kind === 'invented-quote') f.child.decisions[0].support = [{ ...f.applicability, text: 'This rule applies to a different country.' }];
    if (kind === 'extra-property') f.child.approved = true;
    if (kind === 'missing-reference') f.child.capture_refs = [];
    await expect(validateVariationUnit(f.child, f.context)).rejects.toThrow();
  });
  it('does not replace an explicitly unresolved child field with a shared value', async () => {
    const f = await childFixture(); f.child.decisions[2] = { field: 'deadline', mode: 'replace', decision: { field: 'deadline', status: 'unresolved', items: [], note: 'The current provider pages give contradictory deadline dates.' } };
    const result = await validateVariationUnit(f.child, f.context); expect(result.validation.blockers).toEqual(['deadline']); expect(result.validation.public_facts.deadline).toBeNull();
  });
  it('does not inherit an unresolved shared field', async () => {
    const f = await childFixture(); f.shared.validation.review.fields[2] = { field: 'deadline', status: 'unresolved', items: [], note: 'The official deadlines remain contradictory for this cycle.' };
    await expect(validateVariationUnit(f.child, f.context)).rejects.toThrow('unresolved_shared_field_cannot_inherit');
  });
  it('binds applicability to UTF16 original offsets, not matching text elsewhere', () => {
    const f = fixture(); validateVariationSupport(f.applicability, new Map([[f.current.id, f.capture]]));
    expect(() => validateVariationSupport({ ...f.applicability, start_utf16: f.applicability.start_utf16 - 1 }, new Map([[f.current.id, f.capture]]))).toThrow();
  });
  it.each(['missing', 'duplicate', 'stale-shared', 'unresolved', 'outside-inventory'])('rejects incomplete aggregate manifests: %s', async kind => {
    const f = await childFixture(); const child = { id: id(8), inventory_id: f.context.inventory.id, scope_key: 'us-research', content_hash: 'd'.repeat(64), shared_review_id: f.shared.id, shared_hash: f.shared.content_hash, blockers: [] };
    const children = [child];
    if (kind === 'missing') children.pop(); if (kind === 'duplicate') children.push(child); if (kind === 'stale-shared') child.shared_hash = 'e'.repeat(64);
    if (kind === 'unresolved') child.blockers.push('deadline'); if (kind === 'outside-inventory') child.scope_key = 'unlisted';
    expect(() => validateVariationManifest(f.context.inventory, f.context.scopes, f.shared, children)).toThrow();
  });
  it('pins the complete inventory and exact child/shared hashes', async () => {
    const f = await childFixture(), child = { id: id(8), inventory_id: f.context.inventory.id, scope_key: 'us-research', content_hash: 'd'.repeat(64), shared_review_id: f.shared.id, shared_hash: f.shared.content_hash, blockers: [] };
    const manifest = validateVariationManifest(f.context.inventory, f.context.scopes, f.shared, [child]);
    expect(manifest.inventory_revision).toBe(f.context.inventory.revision); expect(manifest.variants).toHaveLength(1);
    expect(variationContentHash(manifest)).toBe(variationContentHash(structuredClone(manifest)));
  });
});
