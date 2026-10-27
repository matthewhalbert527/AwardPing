import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), load: vi.fn(), validate: vi.fn(), validateBase: vi.fn(), attach: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/supabase/admin', () => ({ createSupabaseAdminClient: () => ({ rpc: mocks.rpc, from: mocks.from }) }));
vi.mock('@/lib/r2', () => ({ createR2Client: () => ({}), getR2Bucket: () => 'private-originals' }));
vi.mock('../../scripts/lib/program-text-artifacts.mjs', () => ({ loadProgramTextCapture: mocks.load }));
vi.mock('../../scripts/lib/program-text-source-access.mjs', () => ({ attachProgramTextSourceApprovals: mocks.attach }));
vi.mock('../../scripts/lib/program-text-facts.mjs', async importOriginal => ({ ...await importOriginal<typeof import('../../scripts/lib/program-text-facts.mjs')>(), validateProgramFactReview: mocks.validateBase }));
vi.mock('../../scripts/lib/program-text-variations.mjs', () => ({ validateVariationUnit: mocks.validate, validateVariationScope: vi.fn(), validateVariationSupport: vi.fn(),
  variationScopeKey: (x: unknown) => typeof x === 'string' && /^[a-z0-9][a-z0-9_-]{0,127}$/.test(x) && x !== 'legacy_common',
  variationContextRoles: () => [{ source_role: 'common/application', revision: '10000000-0000-4000-8000-000000000001', source_ids: ['10000000-0000-4000-8000-000000000003'] }] }));
import { loadPublishedVariationBatch, loadPublishedVariationContext, loadProgramVariationPage, loadProgramVariationUnit,
  saveProgramVariationUnit, approveProgramVariationAward, publishProgramVariationBatch, setProgramVariationInventoryGaps, validProgramVariationCoverageGaps } from './program-variation-review.server';
import type { VariationUnit } from './program-variation-review-types';
const id = (n = 1) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const inventory = { id: id(5), cohort_key: 'example', cycle: '2027', revision: id(6), status: 'sealed', content_hash: 'a'.repeat(64), expected_variants: 0 };
const ref = { source: { id: id(3) }, capture_id: 'b'.repeat(64) };
const source = { id: id(3), shared_award_id: id(2), url: 'https://example.org/rules', title: 'Rules', admin_review_status: 'open', text_monitoring_state: { latest_ref: ref } };
let tables: Record<string, unknown>;
function chain(table: string) {
  const builder: Record<string, unknown> = {};
  for (const method of ['select','eq','in','order','limit']) builder[method] = vi.fn(() => builder);
  const response = () => ({ data: tables[table], error: null });
  builder.single = vi.fn(async () => response()); builder.maybeSingle = vi.fn(async () => response());
  builder.then = (resolve: (x: unknown) => unknown) => Promise.resolve(response()).then(resolve);
  return builder;
}
beforeEach(() => {
  vi.resetAllMocks(); tables = { program_variation_inventories: inventory, program_variation_scopes: [{ scope_key: 'common', retired: false, source_roles: [] }],
    program_variation_unit_reviews: null, stage1_award_registry: { cohort_key: 'example', canonical_shared_award_id: id(2) },
    stage1_award_members: [{ shared_award_id: id(2) }], shared_award_sources: [source] };
  mocks.from.mockImplementation(chain); mocks.attach.mockImplementation(async (_db, rows) => rows);
  mocks.load.mockResolvedValue({ text: 'Complete original program rules.', blocks: [{ id: 'body' }], capture_id: ref.capture_id });
  mocks.validateBase.mockResolvedValue({ source_text: [{ reference: { ...ref, source: { id: source.id, url: source.url } }, text: 'Complete original program rules.', blocks: [{ id: 'body' }] }] });
  mocks.rpc.mockResolvedValue({ data: {}, error: null });
});
describe('variation review service boundaries', () => {
  it('returns no v2 facts before publication is active', async () => {
    mocks.rpc.mockResolvedValue({ data: { schema: 'awardping.program-variation-publication.v1', revision: id(), active: false, cohorts: [] }, error: null });
    expect(await loadPublishedVariationBatch()).toBeNull(); expect(mocks.from).not.toHaveBeenCalled(); expect(mocks.load).not.toHaveBeenCalled();
  });
  it.each([24,26])('rejects incomplete active public batch count%s', async count => {
    mocks.rpc.mockResolvedValue({ data: { schema: 'awardping.program-variation-publication.v1', revision: id(), active: true, cohorts: Array(count).fill({}) }, error: null });
    await expect(loadPublishedVariationBatch()).rejects.toThrow('Incomplete');
  });
  it('fails closed when the public RPC is unavailable', async () => { mocks.rpc.mockResolvedValue({ data: null, error: { code: 'missing' } }); await expect(loadPublishedVariationBatch()).rejects.toThrow('checks failed'); });
  it('never substitutes common facts for an unknown requested variant', async () => {
    mocks.rpc.mockResolvedValue({ data: { inventory_id: id(5), revision: id(6), options: [], source_ids: [id(3)], current: true, selected_scope_key: 'common' }, error: null });
    await expect(loadPublishedVariationContext('example', { scopeKey: 'missing' })).rejects.toThrow('incomplete');
  });
  it('rejects a pagination continuation from a different inventory version', async () => {
    mocks.rpc.mockResolvedValue({ data: { inventory_id: id(5), revision: id(9), options: [], source_ids: [id(3)], current: true, selected_scope_key: 'common' }, error: null });
    await expect(loadPublishedVariationContext('example', { cursor: `${id(6)}:france` })).rejects.toThrow('changed');
  });
  it('bounds the selected public evidence scope while allowing paginated inventory options', async () => {
    const value = { inventory_id: id(5), revision: id(6), options: [], source_ids: [id(3)], source_bindings: { [id(3)]: { url: source.url, shared_award_id: source.shared_award_id, title: source.title, page_type: 'application' } },
      current: true, selected_scope_key: 'common', selected_option: { scope_key: 'common', label: 'Shared rules', attributes: { country: null, course: null, track: null, applicant_group: null } } };
    mocks.rpc.mockResolvedValue({ data: value, error: null }); expect(await loadPublishedVariationContext('example')).toEqual(value);
    mocks.rpc.mockResolvedValue({ data: { ...value, source_ids: Array(501).fill(id(3)) }, error: null }); await expect(loadPublishedVariationContext('example')).rejects.toThrow();
  });
  it('pins admin pagination to the inventory revision', async () => {
    mocks.rpc.mockResolvedValue({ data: { inventory: { revision: id(9), coverage_gaps: [] }, scopes: [] }, error: null });
    await expect(loadProgramVariationPage('example', id(5), `${id(6)}:france`)).rejects.toThrow('changed');
  });
  it('prepares a read-only unresolved template without saving or inferring facts', async () => {
    const value = await loadProgramVariationUnit('example', id(5), 'common');
    expect(value.unit.reviewed_all_sources).toBe(false); expect(value.unit.decisions).toHaveLength(21);
    expect(value.unit.decisions.every(d => d.mode === 'replace' && (d.decision as { status: string }).status === 'unresolved')).toBe(true);
    expect(value.sources[0].text).toBe('Complete original program rules.'); expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it('sends only server-produced immutable validation to the save RPC', async () => {
    const unit = { inventory_id: id(5), scope_key: 'common', shared_review_id: null } as VariationUnit;
    const envelope = { schema: 'server-cold-validated', unit }; mocks.validate.mockResolvedValue(envelope);
    await saveProgramVariationUnit(unit, 'reviewer');
    expect(mocks.validate).toHaveBeenCalled(); expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith('save_program_variation_unit', { p_envelope: envelope, p_actor: 'reviewer' });
  });
  it('never saves when original/quote validation fails', async () => {
    mocks.validate.mockRejectedValue(new Error('Original changed'));
    await expect(saveProgramVariationUnit({ inventory_id: id(5), scope_key: 'common', shared_review_id: null } as VariationUnit, 'reviewer')).rejects.toThrow('Original changed');
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it('keeps separate expected-version award approval and atomic25 publication operations', async () => {
    const input = { inventory_id: id(5), expected_inventory_hash: 'a'.repeat(64), shared_review_id: id(7), shared_hash: 'b'.repeat(64), child_reviews: {} };
    await approveProgramVariationAward(input, 'reviewer'); expect(mocks.rpc.mock.calls[0][0]).toBe('approve_program_variation_award');
    await publishProgramVariationBatch({ expected_revision: id(8), approval_ids: {} }, 'reviewer'); expect(mocks.rpc.mock.calls[1][0]).toBe('publish_program_variation_batch');
  });
  it('keeps private gap updates separate from original loading, source approval and fact publication', async () => {
    const input = { action: 'set_inventory_gaps', inventory_id: id(5), expected_revision: id(6), expected_hash: 'a'.repeat(64),
      coverage_gaps: [{ key: 'annual-guidance', label: 'Review the current annual applicant guidance.', source_url: 'https://www.nsf.gov/rules' }],
      reason: 'The current source set lacks the annual applicant guidance.' };
    await setProgramVariationInventoryGaps(input, 'reviewer');
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith('set_program_variation_inventory_gaps', { p_inventory: id(5), p_expected_revision: id(6),
      p_expected_hash: 'a'.repeat(64), p_coverage_gaps: input.coverage_gaps, p_reason: input.reason, p_actor: 'reviewer' });
    expect(mocks.from).not.toHaveBeenCalled(); expect(mocks.load).not.toHaveBeenCalled(); expect(mocks.validate).not.toHaveBeenCalled();
  });
  it('accepts an explicit empty gap list but still requires a reason and exact expected versions', async () => {
    const input = { action: 'set_inventory_gaps', inventory_id: id(5), expected_revision: id(6), expected_hash: 'a'.repeat(64), coverage_gaps: [],
      reason: 'Current official guidance was reviewed and closes the recorded gaps.' };
    await setProgramVariationInventoryGaps(input, 'reviewer');
    for (const invalid of [{ ...input, reason: 'done' }, { ...input, expected_hash: null }, { ...input, expected_revision: null }, { ...input, coverage_gaps: null }]) {
      await expect(setProgramVariationInventoryGaps(invalid, 'reviewer')).rejects.toThrow('Invalid private');
    }
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });
  it('exposes private gap labels only on the authenticated inventory page', async () => {
    const value = { inventory: { ...inventory, coverage_gaps: [{ key: 'governing-source', label: 'Current governing source is not yet reviewed.', source_url: null }] }, scopes: [] };
    mocks.rpc.mockResolvedValue({ data: value, error: null }); expect(await loadProgramVariationPage('example')).toEqual(value);
    mocks.rpc.mockResolvedValue({ data: { ...value, inventory: { ...value.inventory, coverage_gaps: [{ key: 'unknown' }] } }, error: null });
    await expect(loadProgramVariationPage('example')).rejects.toThrow('Invalid private');
  });
  it('validates all gap shapes and bounds without fetching references', () => {
    const gap = { key: 'current-guide', label: 'Review current applicant rules.', source_url: 'https://www.nsf.gov/rules?year=2027' };
    expect(validProgramVariationCoverageGaps([])).toBe(true); expect(validProgramVariationCoverageGaps([gap])).toBe(true);
    expect(validProgramVariationCoverageGaps(Array.from({ length: 50 }, (_, n) => ({ ...gap, key: `gap-${n}` })))).toBe(true);
    for (const invalid of [null, {}, [gap, gap], Array.from({ length: 51 }, (_, n) => ({ ...gap, key: `gap-${n}` })),
      [{ ...gap, key: 'Gap' }], [{ ...gap, key: 'g'.repeat(81) }], [{ ...gap, label: ' ' }], [{ ...gap, label: ' leading' }],
      [{ ...gap, label: 'x'.repeat(501) }], [{ ...gap, label: 'unsafe\nlabel' }], [{ ...gap, label: 'unsafe\u007flabel' }],
      [{ ...gap, source_url: 'http://www.nsf.gov/rules' }], [{ ...gap, source_url: 'https://127.0.0.1/rules' }],
      [{ ...gap, source_url: 'https://[::1]/rules' }], [{ ...gap, source_url: 'https://localhost/rules' }],
      [{ ...gap, source_url: 'https://program.internal/rules' }], [{ ...gap, source_url: 'https://admin:pass@www.nsf.gov/rules' }],
      [{ ...gap, source_url: 'https://www.nsf.gov:8443/rules' }], [{ ...gap, source_url: 'https://www.nsf.gov/rules#private' }],
      [{ ...gap, source_url: 'https://www.nsf.gov\\attacker.org/rules' }], [{ ...gap, source_url: 'https://www.nsf.gov/rules\n' }],
      [{ ...gap, source_url: 1 }], [{ ...gap, approved: true }]]) expect(validProgramVariationCoverageGaps(invalid)).toBe(false);
    expect(validProgramVariationCoverageGaps([{ ...gap, source_url: null }])).toBe(true);
    expect(mocks.load).not.toHaveBeenCalled(); expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
