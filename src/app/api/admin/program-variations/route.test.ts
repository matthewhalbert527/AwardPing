import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ getCurrentUser: vi.fn(), isSiteAdminEmail: vi.fn(), loadProgramVariationBatch: vi.fn(), loadProgramVariationPage: vi.fn(),
  loadProgramVariationUnit: vi.fn(), createProgramVariationInventory: vi.fn(), appendProgramVariationScopes: vi.fn(), sealProgramVariationInventory: vi.fn(),
  saveProgramVariationUnit: vi.fn(), approveProgramVariationAward: vi.fn(), publishProgramVariationBatch: vi.fn(), reviseProgramVariationExpectedCount: vi.fn(), setProgramVariationInventoryGaps: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth', () => mocks);
vi.mock('@/lib/program-variation-review.server', async importOriginal => ({ ...mocks,
  validProgramVariationCoverageGaps: (await importOriginal<typeof import('@/lib/program-variation-review.server')>()).validProgramVariationCoverageGaps }));
import { GET, POST } from './route';
const id = (n = 1) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`, hash = 'a'.repeat(64);
const req = (body: unknown, origin: string | null = 'https://awardping.com') => new Request('https://awardping.com/api/admin/program-variations', {
  method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify(body) });
beforeEach(() => { vi.resetAllMocks(); mocks.getCurrentUser.mockResolvedValue({ id: id(), email: 'admin@example.test' }); mocks.isSiteAdminEmail.mockReturnValue(true);
  mocks.loadProgramVariationUnit.mockResolvedValue({}); mocks.loadProgramVariationPage.mockResolvedValue({}); });
describe('provider variation administrator API', () => {
  it.each([GET, POST])('authenticates before private service work', async method => {
    mocks.getCurrentUser.mockResolvedValue(null); expect((await method(req({ action: 'publish' }))).status).toBe(401);
    expect(mocks.loadProgramVariationBatch).not.toHaveBeenCalled(); expect(mocks.publishProgramVariationBatch).not.toHaveBeenCalled();
  });
  it('denies non-administrators', async () => { mocks.isSiteAdminEmail.mockReturnValue(false); expect((await GET(req({}))).status).toBe(403); });
  it.each([null, 'https://attacker.example'])('requires same-origin mutations (%s)', async origin => {
    expect((await POST(req({ action: 'publish' }, origin))).status).toBe(403); expect(mocks.getCurrentUser).not.toHaveBeenCalled();
  });
  it('loads the compact exact25 board without a bulk original dump', async () => {
    mocks.loadProgramVariationBatch.mockResolvedValue({ awards: [] }); expect((await GET(new Request('https://awardping.com/api/admin/program-variations'))).status).toBe(200);
    expect(mocks.loadProgramVariationBatch).toHaveBeenCalledExactlyOnceWith(); expect(mocks.loadProgramVariationUnit).not.toHaveBeenCalled();
  });
  it('loads only a selected bounded unit/template', async () => {
    const response = await GET(new Request(`https://awardping.com/api/admin/program-variations?cohort=fulbright_us_student&inventory=${id()}&scope=france-research`));
    expect(response.status).toBe(200); expect(mocks.loadProgramVariationUnit).toHaveBeenCalledWith('fulbright_us_student', id(), 'france-research', undefined);
  });
  it.each(['?cohort=a&cohort=b', '?anything=1', '?cohort=a&scope=common', '?cohort=a&inventory=wrong', '?cohort=a&inventory='+id()+'&scope=common&cursor=abc'])('rejects ambiguous query %s', async query => {
    expect((await GET(new Request(`https://awardping.com/api/admin/program-variations${query}`))).status).toBe(400);
  });
  it('creates a private inventory with explicit version, count and actor', async () => {
    const input = { action: 'create_inventory', cohort: 'fulbright_us_student', cycle: '2027–2028', expected_variants: 100, previous_revision: null };
    expect((await POST(req(input))).status).toBe(200); expect(mocks.createProgramVariationInventory).toHaveBeenCalledWith(input, id());
    expect(mocks.approveProgramVariationAward).not.toHaveBeenCalled();
  });
  it('passes exact aggregate hashes without declaring publication', async () => {
    const input = { action: 'approve_award', inventory_id: id(), expected_inventory_hash: hash, shared_review_id: id(2), shared_hash: hash,
      child_reviews: { france: { id: id(3), content_hash: hash } } };
    expect((await POST(req(input))).status).toBe(200); expect(mocks.approveProgramVariationAward).toHaveBeenCalledWith(input, id()); expect(mocks.publishProgramVariationBatch).not.toHaveBeenCalled();
  });
  it('revises a discovered route count only with an exact draft version and a recorded reason', async () => {
    const input = { action: 'revise_expected_variants', inventory_id: id(), expected_revision: id(2), expected_hash: hash,
      expected_variants: 117, reason: 'The official index adds a separately governed applicant route.' };
    expect((await POST(req(input))).status).toBe(200);
    expect(mocks.reviseProgramVariationExpectedCount).toHaveBeenCalledWith(input, id());
    expect(mocks.sealProgramVariationInventory).not.toHaveBeenCalled();
    expect(mocks.approveProgramVariationAward).not.toHaveBeenCalled();
    for (const invalid of [{ ...input, reason: 'more' }, { ...input, expected_variants: -1 }, { ...input, expected_hash: null }, { ...input, actor: 'forged' }]) {
      expect((await POST(req(invalid))).status).toBe(400);
    }
    expect(mocks.reviseProgramVariationExpectedCount).toHaveBeenCalledTimes(1);
  });
  it('requires25 distinct approvals for publication', async () => {
    const input = { action: 'publish', expected_revision: id(), approval_ids: Object.fromEntries(Array.from({ length: 25 }, (_, n) => [`award_${n}`, id(n+2)])) };
    expect((await POST(req(input))).status).toBe(200); expect(mocks.publishProgramVariationBatch).toHaveBeenCalledWith(input, id());
    expect((await POST(req({ ...input, approval_ids: { one: id() } }))).status).toBe(400);
  });
  it('sets a bounded private gap list with exact draft versions and an administrator-supplied reason', async () => {
    const input = { action: 'set_inventory_gaps', inventory_id: id(), expected_revision: id(2), expected_hash: hash,
      coverage_gaps: [{ key: 'current-guide', label: 'Review the current applicant instructions.', source_url: 'https://www.nsf.gov/rules' }],
      reason: 'Current annual guidance still needs to be collected and reviewed.' };
    const response = await POST(req(input)); expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(mocks.setProgramVariationInventoryGaps).toHaveBeenCalledExactlyOnceWith(input, id());
    expect(mocks.appendProgramVariationScopes).not.toHaveBeenCalled(); expect(mocks.saveProgramVariationUnit).not.toHaveBeenCalled();
    expect(mocks.sealProgramVariationInventory).not.toHaveBeenCalled(); expect(mocks.approveProgramVariationAward).not.toHaveBeenCalled();
    expect(mocks.publishProgramVariationBatch).not.toHaveBeenCalled();
    for (const invalid of [{ ...input, reason: 'fixed' }, { ...input, expected_hash: null }, { ...input, expected_revision: null },
      { ...input, actor: 'forged' }, { ...input, coverage_gaps: [{ ...input.coverage_gaps[0], resolved: true }] },
      { ...input, coverage_gaps: [input.coverage_gaps[0], input.coverage_gaps[0]] },
      { ...input, coverage_gaps: [{ ...input.coverage_gaps[0], source_url: 'https://localhost/private' }] },
      { ...input, reason: 'unsafe\nreview reason with controls' }]) expect((await POST(req(invalid))).status).toBe(400);
    expect(mocks.setProgramVariationInventoryGaps).toHaveBeenCalledTimes(1);
  });
  it('requires the same audited action when removing every open gap', async () => {
    const input = { action: 'set_inventory_gaps', inventory_id: id(), expected_revision: id(2), expected_hash: hash, coverage_gaps: [],
      reason: 'The governing document was collected, repeated and independently reviewed.' };
    expect((await POST(req(input))).status).toBe(200); expect(mocks.setProgramVariationInventoryGaps).toHaveBeenCalledWith(input, id());
  });
  it.each([{ action: 'approve_all' }, { action: 'create_inventory', cohort: 'a', cycle: '2027', expected_variants: 0, previous_revision: null, actor: 'forged' },
    { action: 'save_unit', unit: { inventory_id: id(), scope_key: 'common' } }])('rejects incomplete or expanded bodies %j', async body => { expect((await POST(req(body))).status).toBe(400); });
  it('does not hide failed atomic operations as success or leak private errors', async () => {
    mocks.createProgramVariationInventory.mockRejectedValue(new Error('private token'));
    const response = await POST(req({ action: 'create_inventory', cohort: 'a', cycle: '2027', expected_variants: 0, previous_revision: null }));
    expect(response.status).toBe(409); expect(await response.text()).not.toContain('token'); expect(response.headers.get('cache-control')).toContain('no-store');
  });
  it('bounds streamed input before JSON parsing', async () => { expect((await POST(req({ action: 'save_unit', text: 'x'.repeat(4*1024*1024) }))).status).toBe(413); });
});
