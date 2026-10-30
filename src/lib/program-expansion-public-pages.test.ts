import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import cohort from "../../config/program-award-expansion.json";
import monitoring from "../../config/program-text-monitoring.json";
import type { Stage1PublicationEntry } from "./stage1-publication";

const mocks = vi.hoisted(() => ({ index: vi.fn(), rpc: vi.fn(), excluded: vi.fn(), events: vi.fn(), user: vi.fn(), office: vi.fn(), quality: vi.fn(), from: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ hasSupabaseConfig: () => true, hasSupabaseAdminConfig: () => true }));
vi.mock("@/lib/auth", () => ({ getCurrentUser: mocks.user }));
vi.mock("@/lib/offices", () => ({ getOfficeContext: mocks.office }));
vi.mock("@/lib/stage1-publication", () => ({ loadStage1PublicationIndex: mocks.index, isStage1SourceIdentityExcluded: mocks.excluded }));
vi.mock("@/lib/public-change-events", async original => ({ ...(await original<typeof import("./public-change-events")>()), loadEligiblePublicChangeEvents: mocks.events }));
vi.mock("@/lib/source-quality", async original => ({ ...(await original<typeof import("./source-quality")>()), isPublicAwardSource: mocks.quality }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: () => ({ rpc: mocks.rpc, from: mocks.from }) }));
vi.mock("@/lib/update-read-state", () => ({ unreadSharedChangeIdsForUser: vi.fn() }));
import { GET } from "../app/api/shared-awards/[id]/route";
import { getPublicAwardPageResolutionBySlug } from "./public-award-pages";
import { PublicAwardWorkspace } from "../components/public-award-workspace";

function fixture(key = "ppia_jsi") {
  const award = cohort.awards.find(a => a.cohort_key === key)!;
  const sourceId = "11111111-1111-4111-8111-111111111111";
  const source = { id: sourceId, shared_award_id: award.canonical_shared_award_id, url: award.official_homepage,
    title: "Official programme guidance", page_type: "homepage", confidence: 0.95, reason: "Private review note",
    admin_review_status: "review_later", updated_at: "2026-10-30T10:00:00.000Z" };
  const publication = { registry: { ...award, policy_version: "program-basic-expansion-v1", release_epoch: null,
    last_verified_at: null, updated_at: "2026-10-30T10:00:00.000Z" }, effectivelyVerified: true,
    canonicalAwardId: award.canonical_shared_award_id, memberAwardIds: [award.canonical_shared_award_id], allowedSourceIds: [sourceId], allowedSourceIdSet: new Set([sourceId]),
    officialHomepageSourceId: sourceId, officialHomepageUrl: award.official_homepage, publishedFacts: { overview: "Source-supported basic programme information." },
    basicFactSnapshot: { current: true, verifiedAt: "2026-10-30T10:00:00.000Z" }, sourceIdentityRules: [],
    approvedTextAlertSourceBindings: { [sourceId]: { url: source.url, shared_award_id: source.shared_award_id, epoch: monitoring.epoch } },
  } as unknown as Stage1PublicationEntry;
  const context = { schema: "awardping.program-award-expansion-tracking.v1", cohort_key: key, canonical_shared_award_id: award.canonical_shared_award_id,
    admission_id: "22222222-2222-4222-8222-222222222222", epoch: monitoring.epoch, source_ids: [sourceId], sources: [source] };
  mocks.index.mockResolvedValue({ available: true, entries: [publication], verifiedEntries: [publication],
    entryByMemberAwardId: new Map([[award.canonical_shared_award_id, publication]]), entryByCohortKey: new Map([[key, publication]]) });
  mocks.rpc.mockResolvedValue({ data: context, error: null });
  return { award, source, sourceId, publication, context };
}
function request(id: string) { return GET(new Request(`https://awardping.com/api/shared-awards/${id}`), { params: Promise.resolve({ id }) }); }

describe("published expansion page and details API", () => {
  beforeEach(() => { vi.resetAllMocks(); mocks.user.mockResolvedValue(null); mocks.excluded.mockReturnValue(false); mocks.events.mockResolvedValue([]);
    mocks.quality.mockReturnValue(false); mocks.from.mockImplementation(() => { throw Error("No legacy/broad source query allowed for expansion"); }); });
  it.each(cohort.awards.filter(a => a.batch === 1).map(a => [a.cohort_key]))("serves %s through exact current admission despite null legacy epoch/review_later", async key => {
    const f = fixture(key), response = await request(f.award.canonical_shared_award_id), body = await response.json();
    expect(response.status).toBe(200); expect(body.award).toMatchObject({ id: f.award.canonical_shared_award_id, sourceCount: 1, detailsLoaded: true, hasApplicationRoutes: false });
    expect(body.award.sources[0]).toMatchObject({ id: f.sourceId, url: f.award.official_homepage, title: "Official programme guidance", pageType: "homepage" });
    expect(mocks.quality).not.toHaveBeenCalled(); expect(mocks.from).not.toHaveBeenCalled(); expect(JSON.stringify(body)).not.toContain("Private review note");
  });
  it("serves the exact DAAD database programme URL without admitting a generic listing", async () => {
    const f = fixture("daad_study"), response = await request(f.award.canonical_shared_award_id);
    expect(response.status).toBe(200); expect((await response.json()).award.sources[0].url).toBe(f.award.official_homepage);
    f.source.url = "https://www.daad.org/en/find-funding/scholarship-database/";
    expect((await request(f.award.canonical_shared_award_id)).status).toBe(500);
  });
  it.each(["wrong_owner", "changed_url", "missing_source", "wrong_epoch", "closed", "revoked"])("holds details when exact source authority is %s", async failure => {
    const f = fixture(); if (failure === "wrong_owner") f.source.shared_award_id = "33333333-3333-4333-8333-333333333333";
    if (failure === "changed_url") f.source.url += "/different"; if (failure === "missing_source") f.context.sources = [];
    if (failure === "wrong_epoch") f.context.epoch = "33333333-3333-4333-8333-333333333333"; if (failure === "closed") f.source.admin_review_status = "closed";
    if (failure === "revoked") f.publication.approvedTextAlertSourceBindings = {};
    const response = await request(f.award.canonical_shared_award_id); expect(response.status).toBe(500); expect(await response.json()).toEqual({ error: "Shared award details are unavailable right now." });
  });
  it.each(cohort.awards.filter(a => a.batch === 1).map(a => [a.cohort_key]))("renders the %s award page with admitted source links and no private metadata", async key => {
    const f = fixture(key), result = await getPublicAwardPageResolutionBySlug(f.award.canonical_slug);
    expect(result.kind).toBe("published"); if (result.kind !== "published") throw Error("Published page required");
    expect(result.data.sources).toHaveLength(1); expect(result.data.sources[0].url).toBe(f.award.official_homepage);
    const html = renderToStaticMarkup(createElement(PublicAwardWorkspace, { data: result.data }));
    expect(html).toContain(f.award.canonical_name.replaceAll("&", "&amp;")); expect(html).not.toContain("Private review note"); expect(html).not.toContain("source-snapshot-viewer");
    expect(mocks.quality).not.toHaveBeenCalled(); expect(mocks.from).not.toHaveBeenCalled();
  });
  it("keeps approved identity/source links available while basic details await a real-change review", async () => {
    const f = fixture(); f.publication.basicFactSnapshot!.current = false;
    expect((await request(f.award.canonical_shared_award_id)).status).toBe(200);
    const page = await getPublicAwardPageResolutionBySlug(f.award.canonical_slug); expect(page.kind).toBe("published");
    if (page.kind === "published") expect(page.data.factsNeedReview).toBe(true);
  });
});
