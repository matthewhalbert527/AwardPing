import { beforeEach, describe, expect, it, vi } from "vitest";
import expansion from "../../../../config/program-award-expansion.json";
import monitoring from "../../../../config/program-text-monitoring.json";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ user: vi.fn(), office: vi.fn(), manage: vi.fn(), config: vi.fn(), adminConfig: vi.fn(), publication: vi.fn(), admin: vi.fn(), server: vi.fn(), legacyTrack: vi.fn(), legacyUntrack: vi.fn(), legacySourceUntrack: vi.fn(), excluded: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getCurrentUser: mocks.user }));
vi.mock("@/lib/config", () => ({ hasSupabaseConfig: mocks.config, hasSupabaseAdminConfig: mocks.adminConfig }));
vi.mock("@/lib/offices", () => ({ canManageOffice: mocks.manage, requireOfficeContext: mocks.office }));
vi.mock("@/lib/stage1-publication", () => ({ getStage1PublicationEntryForAward: mocks.publication, isStage1SourceIdentityExcluded: mocks.excluded }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: mocks.admin }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: mocks.server }));
vi.mock("@/lib/shared-awards", () => ({ trackSharedAwardForOffice: mocks.legacyTrack, untrackSharedAwardForOffice: mocks.legacyUntrack, untrackSharedAwardSourceForOffice: mocks.legacySourceUntrack }));
import { POST as awardPost, DELETE as awardDelete } from "./[id]/track/route";
import { POST as sourcePost, DELETE as sourceDelete } from "./[id]/sources/[sourceId]/track/route";
const id = (n: number) => `90000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const identity = expansion.awards[0], owner = identity.canonical_shared_award_id;
const adminRpc = vi.fn(), userRpc = vi.fn(), legacyQuery = vi.fn();
let publication: Record<string, unknown>, context: Record<string, unknown>, sources: Array<Record<string, unknown>>;
type Kind = "award-post" | "source-post" | "award-delete" | "source-delete";
function call(kind: Kind, origin = "https://awardping.test") {
  const request = new Request("https://awardping.test/api/shared-awards/follow", { method: kind.endsWith("post") ? "POST" : "DELETE", headers: { origin, "content-type": "application/json" }, ...(kind.endsWith("post") ? { body: JSON.stringify({ cadence: "daily", officeId: id(999) }) } : {}) });
  const params = Promise.resolve({ id: owner, sourceId: id(100) });
  return ({ "award-post": awardPost, "source-post": sourcePost, "award-delete": awardDelete, "source-delete": sourceDelete })[kind](request, { params });
}
beforeEach(() => {
  vi.resetAllMocks(); mocks.config.mockReturnValue(true); mocks.adminConfig.mockReturnValue(true); mocks.user.mockResolvedValue({ id: id(9) });
  mocks.office.mockResolvedValue({ current: { officeId: id(10), role: "owner", personal: true } }); mocks.manage.mockReturnValue(true); mocks.excluded.mockReturnValue(false);
  sources = [100, 101].map(n => ({ id: id(n), shared_award_id: owner, url: `https://example.test/official/${n}`, title: "Official programme guidance", page_type: "application", confidence: 1, reason: null, admin_review_status: "review_later", updated_at: "2026-10-30T10:00:00.000Z" }));
  publication = { effectivelyVerified: true, canonicalAwardId: owner, memberAwardIds: [owner], allowedSourceIds: sources.map(s => s.id), allowedSourceIdSet: new Set(sources.map(s => s.id)), registry: { cohort_key: identity.cohort_key, canonical_shared_award_id: owner, policy_version: "program-basic-expansion-v1", release_epoch: null }, basicFactSnapshot: { current: true }, approvedTextAlertSourceBindings: Object.fromEntries(sources.map(s => [s.id, { url: s.url, shared_award_id: owner, epoch: monitoring.epoch }])) };
  context = { schema: "awardping.program-award-expansion-tracking.v1", cohort_key: identity.cohort_key, canonical_shared_award_id: owner, admission_id: id(3), epoch: monitoring.epoch, source_ids: sources.map(s => s.id), sources };
  mocks.publication.mockResolvedValue(publication); adminRpc.mockImplementation(async () => ({ data: context, error: null })); mocks.admin.mockReturnValue({ rpc: adminRpc, from: legacyQuery });
  userRpc.mockImplementation(async (name: string) => ({ data: name.startsWith("untrack") ? { ok: true, removedSources: 2 } : { award: { id: id(11) }, sources: [], monitors: [], alreadyTracked: false }, error: null })); mocks.server.mockResolvedValue({ rpc: userRpc });
  mocks.legacyUntrack.mockResolvedValue({ ok: true }); mocks.legacySourceUntrack.mockResolvedValue({ ok: true });
});
describe.each<Kind>(["award-post", "source-post", "award-delete", "source-delete"])("expansion %s", kind => {
  it("uses current admission with the authenticated office client and no fabricated legacy epoch", async () => {
    const response = await call(kind); expect(response.status).toBe(200);
    expect(adminRpc).toHaveBeenCalledExactlyOnceWith("get_program_award_expansion_tracking_context", { p_shared_award_id: owner });
    const name = kind.endsWith("post") ? "track_office_program_expansion_atomic" : "untrack_office_program_expansion_atomic";
    expect(userRpc).toHaveBeenCalledExactlyOnceWith(name, expect.objectContaining({ p_office_id: id(10), p_cohort_key: identity.cohort_key, p_expected_admission_id: id(3), p_expected_epoch: monitoring.epoch }));
    const parameters = userRpc.mock.calls[0][1]; expect(parameters).not.toHaveProperty("p_expected_release_epoch"); expect(parameters).not.toHaveProperty("p_expected_member_shared_award_ids");
    if (kind.endsWith("post")) expect(parameters.p_expected_source_bindings).toEqual(kind.startsWith("source") ? [sources[0]] : sources);
    else expect(parameters.p_source_id).toBe(kind.startsWith("source") ? id(100) : null);
    expect(legacyQuery).not.toHaveBeenCalled(); expect(mocks.legacyTrack).not.toHaveBeenCalled(); expect(mocks.legacyUntrack).not.toHaveBeenCalled(); expect(mocks.legacySourceUntrack).not.toHaveBeenCalled(); expect(sources[0].admin_review_status).toBe("review_later");
  });
  it.each(["origin", "signed_out", "office_member", "config"])("preserves the %s boundary", async boundary => {
    if (boundary === "signed_out") mocks.user.mockResolvedValue(null); if (boundary === "office_member") mocks.manage.mockReturnValue(false); if (boundary === "config") mocks.config.mockReturnValue(false);
    const response = await call(kind, boundary === "origin" ? "https://attacker.test" : undefined); expect(response.status).toBe(boundary === "signed_out" ? 401 : boundary === "config" ? 503 : 403); expect(adminRpc).not.toHaveBeenCalled(); expect(userRpc).not.toHaveBeenCalled();
  });
  it.each(["epoch", "admission", "canonical", "scope", "duplicate_source"])("rejects changed %s context before mutation", async change => {
    if (change === "epoch") context.epoch = "not-an-epoch"; if (change === "admission") context.admission_id = "not-an-admission"; if (change === "canonical") context.canonical_shared_award_id = id(90); if (change === "scope") context.cohort_key = "other"; if (change === "duplicate_source") context.source_ids = [id(100), id(100)];
    expect((await call(kind)).status).toBe(409); expect(userRpc).not.toHaveBeenCalled();
  });
  it("preserves authenticated SQL denial and hides private diagnostics", async () => { userRpc.mockResolvedValue({ data: null, error: { code: "42501", message: "Private office membership details" } }); const r = await call(kind); expect(r.status).toBe(403); expect(JSON.stringify(await r.json())).not.toContain("Private office"); });
  it("keeps stale-admission SQL rejection visible as conflict without fallback", async () => { userRpc.mockResolvedValue({ data: null, error: { code: "40001", message: "Private admission details" } }); expect((await call(kind)).status).toBe(409); expect(mocks.legacyTrack).not.toHaveBeenCalled(); });
});
describe.each<Kind>(["award-post", "source-post"])("modern %s source permission", kind => {
  it.each(["url", "owner", "closed", "unapproved", "binding_epoch", "excluded", "unsafe_url", "unverified", "stale_epoch"])("rejects %s", async change => {
    if (change === "url") sources[0].url = "https://example.test/changed"; if (change === "owner") sources[0].shared_award_id = id(90); if (change === "closed") sources[0].admin_review_status = "closed"; if (change === "unapproved") (publication.allowedSourceIdSet as Set<string>).clear(); if (change === "binding_epoch") (publication.approvedTextAlertSourceBindings as Record<string, { epoch: string }>)[id(100)].epoch = id(90); if (change === "excluded") mocks.excluded.mockReturnValue(true); if (change === "unsafe_url") { sources[0].url = "https://user:password@example.test/official"; (publication.approvedTextAlertSourceBindings as Record<string, { url: string }>)[id(100)].url = sources[0].url as string; } if (change === "unverified") publication.effectivelyVerified = false; if (change === "stale_epoch") context.epoch = id(90);
    expect((await call(kind)).status).toBe(change === "unverified" ? 404 : 409); expect(userRpc).not.toHaveBeenCalled();
  });
  it("does not turn stale basic facts into an inability to follow current monitoring", async () => { publication.basicFactSnapshot = { current: false }; expect((await call(kind)).status).toBe(200); });
});
describe.each<Kind>(["award-delete", "source-delete"])("modern %s unsubscribe", kind => {
  it("allows unsubscribe after source permission or facts became stale", async () => { publication.effectivelyVerified = false; publication.basicFactSnapshot = { current: false }; publication.approvedTextAlertSourceBindings = {}; sources[0].admin_review_status = "closed"; sources[0].url = "https://example.test/changed"; expect((await call(kind)).status).toBe(200); });
  it("can remove a follow from its immutable earlier epoch without granting new tracking", async () => { context.epoch = id(90); expect((await call(kind)).status).toBe(200); expect(userRpc.mock.calls[0][1].p_expected_epoch).toBe(id(90)); });
  it("keeps legacy deletion path for an original release entry", async () => { (publication.registry as Record<string, unknown>).policy_version = "stage1-publication-v1"; (publication.registry as Record<string, unknown>).release_epoch = id(2); expect((await call(kind)).status).toBe(200); expect(adminRpc).not.toHaveBeenCalled(); expect(userRpc).not.toHaveBeenCalled(); expect(kind === "award-delete" ? mocks.legacyUntrack : mocks.legacySourceUntrack).toHaveBeenCalledOnce(); });
});
