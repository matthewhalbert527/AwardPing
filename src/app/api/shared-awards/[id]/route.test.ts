import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  hasSupabaseConfig: vi.fn(),
  hasSupabaseAdminConfig: vi.fn(),
  loadStage1PublicationIndex: vi.fn(),
  getCurrentUser: vi.fn(),
  getOfficeContext: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
  loadEligiblePublicChangeEvents: vi.fn(),
  order: vi.fn(),
}));

vi.mock("@/lib/config", () => ({
  hasSupabaseConfig: mocks.hasSupabaseConfig,
  hasSupabaseAdminConfig: mocks.hasSupabaseAdminConfig,
}));
vi.mock("@/lib/auth", () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock("@/lib/offices", () => ({ getOfficeContext: mocks.getOfficeContext }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: mocks.createSupabaseAdminClient }));
vi.mock("@/lib/stage1-publication", () => ({
  loadStage1PublicationIndex: mocks.loadStage1PublicationIndex,
  isStage1SourceIdentityExcluded: () => false,
}));
vi.mock("@/lib/public-change-events", () => ({ loadEligiblePublicChangeEvents: mocks.loadEligiblePublicChangeEvents }));
vi.mock("@/lib/source-url-policy", () => ({ filterTrackableOfficialSources: (sources: unknown[]) => sources }));
vi.mock("@/lib/source-quality", () => ({ isPublicAwardSource: () => true }));
vi.mock("@/lib/public-award-facts", () => ({ publicAwardFactsFromAward: () => ({ overview: "Reviewed overview" }) }));
vi.mock("@/lib/change-summary", () => ({ displayChangeSummary: (summary: string) => summary }));

import { GET } from "./route";

const awardId = "20000000-0000-4000-8000-000000000002";
const sourceId = "30000000-0000-4000-8000-000000000003";
const homepage = "https://example.test/award";

function verifiedPublication() {
  return {
    effectivelyVerified: true,
    canonicalAwardId: awardId,
    memberAwardIds: [awardId],
    allowedSourceIdSet: new Set([sourceId]),
    officialHomepageSourceId: sourceId,
    officialHomepageUrl: homepage,
    registry: { canonical_name: "Example award", official_homepage: homepage },
    publishedFacts: {},
  };
}

function requestAward() {
  return GET(new Request(`https://example.test/api/shared-awards/${awardId}`), {
    params: Promise.resolve({ id: awardId }),
  });
}

function expectNoDetailLookups() {
  expect(mocks.getCurrentUser).not.toHaveBeenCalled();
  expect(mocks.getOfficeContext).not.toHaveBeenCalled();
  expect(mocks.createSupabaseAdminClient).not.toHaveBeenCalled();
  expect(mocks.loadEligiblePublicChangeEvents).not.toHaveBeenCalled();
}

describe("shared award detail availability", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.hasSupabaseConfig.mockReturnValue(true);
    mocks.hasSupabaseAdminConfig.mockReturnValue(true);
    mocks.getCurrentUser.mockResolvedValue(null);
    mocks.loadStage1PublicationIndex.mockResolvedValue({
      available: true,
      entryByMemberAwardId: new Map([[awardId, verifiedPublication()]]),
    });
    const query = {
      select: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: mocks.order,
    };
    mocks.createSupabaseAdminClient.mockReturnValue({ from: vi.fn().mockReturnValue(query) });
    mocks.order.mockResolvedValue({ data: [{ id: sourceId, url: homepage, title: "Official page", page_type: "homepage" }], error: null });
    mocks.loadEligiblePublicChangeEvents.mockResolvedValue([]);
  });

  it.each([false, true])("returns generic 503 for an unavailable index (retained entry: %s)", async (retainedEntry) => {
    mocks.loadStage1PublicationIndex.mockResolvedValue({
      available: false,
      unavailableReason: "Internal RPC/schema diagnostics must stay private",
      entryByMemberAwardId: new Map(retainedEntry ? [[awardId, verifiedPublication()]] : []),
    });
    const response = await requestAward();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Shared award directory is unavailable right now." });
    expectNoDetailLookups();
  });

  it.each(["missing", "unverified"])("keeps a %s award private when the index is available", async (state) => {
    mocks.loadStage1PublicationIndex.mockResolvedValue({
      available: true,
      entryByMemberAwardId: new Map(state === "missing" ? [] : [[awardId, { ...verifiedPublication(), effectivelyVerified: false }]]),
    });
    const response = await requestAward();
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Shared award was not found." });
    expectNoDetailLookups();
  });

  it("still returns a verified award whose reviewed homepage is present", async () => {
    const response = await requestAward();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ award: { id: awardId, sourceCount: 1, changeCount: 0, detailsLoaded: true } });
    expect(mocks.loadEligiblePublicChangeEvents).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ memberAwardIds: [awardId] }));
  });

  it("still refuses a verified entry without its reviewed homepage source", async () => {
    mocks.order.mockResolvedValue({ data: [], error: null });
    const response = await requestAward();
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Shared award was not found." });
  });

  it.each(["hasSupabaseConfig", "hasSupabaseAdminConfig"] as const)("preserves the early configuration guard for %s", async (config) => {
    mocks[config].mockReturnValue(false);
    expect((await requestAward()).status).toBe(503);
    expect(mocks.loadStage1PublicationIndex).not.toHaveBeenCalled();
    expectNoDetailLookups();
  });
});
