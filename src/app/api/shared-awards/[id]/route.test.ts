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

// Two official documents that a repository addresses only by query id: the
// path is identical, so any key that drops the query merges them.
const documentA = "https://nspires.nasaprs.com/external/viewrepositorydocument?cmdocumentid=1075626";
const documentB = "https://nspires.nasaprs.com/external/viewrepositorydocument?cmdocumentid=1138353";
const sourceA = "40000000-0000-4000-8000-000000000004";
const sourceB = "50000000-0000-4000-8000-000000000005";

const changeDefaults = {
  id: "change-default",
  shared_award_source_id: null as string | null,
  source_title: "Official document",
  source_url: documentA,
  source_page_type: "application",
  summary: "The document changed.",
  change_details: {},
  suppressed_at: null,
  suppression_reason: null,
  suppression_source: null,
  detected_at: "2026-07-04T12:00:00.000Z",
};

// The reviewed homepage source is always listed so the award stays published;
// the documents under test are listed beside it.
function useCatalog(
  documents: Array<{ id: string; url: string }>,
  events: Array<Partial<typeof changeDefaults>>,
) {
  mocks.loadStage1PublicationIndex.mockResolvedValue({
    available: true,
    entryByMemberAwardId: new Map([[awardId, {
      ...verifiedPublication(),
      allowedSourceIdSet: new Set([sourceId, ...documents.map((document) => document.id)]),
    }]]),
  });
  mocks.order.mockResolvedValue({
    data: [
      { id: sourceId, url: homepage, title: "Official page", page_type: "homepage" },
      ...documents.map((document) => ({ ...document, title: "Official document", page_type: "application" })),
    ],
    error: null,
  });
  mocks.loadEligiblePublicChangeEvents.mockResolvedValue(
    events.map((event) => ({ event: { ...changeDefaults, ...event } })),
  );
}

async function awardBody() {
  const response = await requestAward();
  expect(response.status).toBe(200);
  return response.json();
}

async function latestChangeIdsBySource() {
  const body = await awardBody();
  return Object.fromEntries(
    body.award.sources.map((source: { id: string; latestChanges: Array<{ id: string }> }) => [
      source.id,
      source.latestChanges.map((change) => change.id),
    ]),
  );
}

describe("shared award change source identity", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.hasSupabaseConfig.mockReturnValue(true);
    mocks.hasSupabaseAdminConfig.mockReturnValue(true);
    mocks.getCurrentUser.mockResolvedValue(null);
    const query = {
      select: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: mocks.order,
    };
    mocks.createSupabaseAdminClient.mockReturnValue({ from: vi.fn().mockReturnValue(query) });
    useCatalog([], []);
  });

  it("keeps two query-addressed documents' updates apart", async () => {
    useCatalog(
      [{ id: sourceA, url: documentA }, { id: sourceB, url: documentB }],
      [
        { id: "change-a", shared_award_source_id: sourceA, source_url: documentA },
        { id: "change-b", shared_award_source_id: sourceB, source_url: documentB },
      ],
    );

    expect(await latestChangeIdsBySource()).toEqual({
      [sourceId]: [],
      [sourceA]: ["change-a"],
      [sourceB]: ["change-b"],
    });
  });

  it("never re-attaches an identified change to another source that shares its URL", async () => {
    useCatalog(
      [{ id: sourceA, url: documentA }, { id: sourceB, url: documentA }],
      [{ id: "change-b", shared_award_source_id: sourceB, source_url: documentA }],
    );

    expect(await latestChangeIdsBySource()).toEqual({
      [sourceId]: [],
      [sourceA]: [],
      [sourceB]: ["change-b"],
    });
  });

  it("keeps a change on its recorded source ID even when the stored URL differs", async () => {
    useCatalog(
      [{ id: sourceA, url: documentA }, { id: sourceB, url: documentB }],
      [{ id: "change-b", shared_award_source_id: sourceB, source_url: "https://example.edu/previous-address" }],
    );

    expect(await latestChangeIdsBySource()).toEqual({
      [sourceId]: [],
      [sourceA]: [],
      [sourceB]: ["change-b"],
    });
  });

  // The ID-less cases below exercise the defensive URL fallback. Today's
  // loader cannot emit an ID-less change to this route (loadEligiblePublicChangeEvents
  // filters on shared_award_source_id), so these pin the fallback's policy for
  // parity with the public award workspace rather than a live code path.
  it.each([
    { label: "the exact document address", sourceUrl: documentB, changeUrl: documentB, matches: true },
    { label: "a fragment inside the same document", sourceUrl: documentB, changeUrl: `${documentB}#page=2`, matches: true },
    { label: "another document's query id", sourceUrl: documentB, changeUrl: documentA, matches: false },
    { label: "path case", sourceUrl: "https://example.edu/guide.pdf", changeUrl: "https://example.edu/Guide.pdf", matches: false },
    { label: "query value case", sourceUrl: "https://example.edu/document?id=guide", changeUrl: "https://example.edu/document?id=Guide", matches: false },
    { label: "query key case", sourceUrl: "https://example.edu/document?id=1", changeUrl: "https://example.edu/document?ID=1", matches: false },
    { label: "query order", sourceUrl: "https://example.edu/document?id=1&view=full", changeUrl: "https://example.edu/document?view=full&id=1", matches: false },
    { label: "a trailing slash", sourceUrl: "https://example.edu/document", changeUrl: "https://example.edu/document/", matches: false },
    { label: "a blank address", sourceUrl: "https://example.edu/document", changeUrl: "", matches: false },
    { label: "an unparseable address", sourceUrl: "https://example.edu/document", changeUrl: "not a URL", matches: false },
    { label: "a non-HTTP scheme", sourceUrl: "https://example.edu/document", changeUrl: "javascript:alert(1)", matches: false },
  ])("resolves an ID-less change against $label", async ({ sourceUrl, changeUrl, matches }) => {
    useCatalog(
      [{ id: sourceB, url: sourceUrl }],
      [{ id: "change-legacy", shared_award_source_id: null, source_url: changeUrl }],
    );

    expect(await latestChangeIdsBySource()).toEqual({
      [sourceId]: [],
      [sourceB]: matches ? ["change-legacy"] : [],
    });
  });

  // Both sides unusable is the case the old key got wrong: it collapsed every
  // unparseable address to one string, so two unrelated rows matched.
  it.each(["", "   ", "not a URL", "javascript:alert(1)"])(
    "never attaches an ID-less change when both addresses are unusable (%s)",
    async (unusable) => {
      useCatalog(
        [{ id: sourceB, url: unusable }],
        [{ id: "change-legacy", shared_award_source_id: null, source_url: unusable }],
      );

      expect(await latestChangeIdsBySource()).toEqual({ [sourceId]: [], [sourceB]: [] });
    },
  );

  it("keeps the two-latest cap per source and the award's full change list", async () => {
    useCatalog(
      [{ id: sourceB, url: documentB }],
      [
        { id: "change-1", shared_award_source_id: sourceB, source_url: documentB },
        { id: "change-2", shared_award_source_id: sourceB, source_url: documentB },
        { id: "change-3", shared_award_source_id: sourceB, source_url: documentB },
      ],
    );

    const body = await awardBody();
    expect(await latestChangeIdsBySource()).toEqual({
      [sourceId]: [],
      [sourceB]: ["change-1", "change-2"],
    });
    expect(body.award.changes.map((change: { id: string }) => change.id))
      .toEqual(["change-1", "change-2", "change-3"]);
    expect(body.award.changeCount).toBe(3);
    expect(body.award.sourceCount).toBe(2);
  });
});
