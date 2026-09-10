import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  loadEligiblePublicChangeEvents: vi.fn(),
  loadStage1PublicationIndex: vi.fn(),
  unreadSharedChangeIdsForUser: vi.fn(),
  isPublicAwardSource: vi.fn(),
  isStage1SourceIdentityExcluded: vi.fn(),
  sourceRows: [] as unknown[],
  queriedTables: [] as string[],
  sourceQueryError: null as { message: string } | null,
}));

// Only the loader is replaced; the exact newest-first comparator the merge
// uses is the real one.
vi.mock("@/lib/public-change-events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/public-change-events")>()),
  loadEligiblePublicChangeEvents: mocks.loadEligiblePublicChangeEvents,
}));
vi.mock("@/lib/stage1-publication", () => ({
  loadStage1PublicationIndex: mocks.loadStage1PublicationIndex,
  isStage1SourceIdentityExcluded: mocks.isStage1SourceIdentityExcluded,
}));
vi.mock("@/lib/update-read-state", () => ({
  unreadSharedChangeIdsForUser: mocks.unreadSharedChangeIdsForUser,
}));
vi.mock("@/lib/source-quality", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/source-quality")>()),
  isPublicAwardSource: mocks.isPublicAwardSource,
}));
// @/lib/source-url-policy is deliberately NOT mocked: the real trackability
// predicate is part of what these tests exercise at this boundary.
vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: () => ({
    from(table: string) {
      mocks.queriedTables.push(table);
      if (table !== "shared_award_sources") throw new Error(`Unexpected table ${table}`);
      const builder: Record<string, unknown> = {
        then(resolve: (value: unknown) => unknown) {
          return Promise.resolve({ data: mocks.sourceRows, error: mocks.sourceQueryError }).then(resolve);
        },
      };
      for (const method of ["select", "in", "order"]) builder[method] = () => builder;
      return builder;
    },
  }),
}));

import { PublicAwardWorkspace } from "@/components/public-award-workspace";
import {
  getPublicAwardPageBySlug,
  getPublicAwardPageResolutionBySlug,
  mergeRequestedPublicChangeEvents,
} from "@/lib/public-award-pages";
import type { EligiblePublicChangeEvent } from "@/lib/public-change-events";
import type { Stage1PublicationEntry, Stage1PublicationIndex } from "@/lib/stage1-publication";

const AWARD_ID = "10000000-0000-4000-8000-000000000001";
const SOURCE_HOME = "30000000-0000-4000-8000-000000000001";
const SOURCE_APPLY = "30000000-0000-4000-8000-000000000002";
const NINTH_CHANGE_ID = eventId(9);

function eventId(suffix: number) {
  return `40000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
}

function publication(): Stage1PublicationEntry {
  return {
    registry: {
      canonical_slug: "example-fellowship",
      canonical_name: "Example Fellowship",
      official_homepage: "https://example.edu/fellowship",
      last_verified_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-01T00:00:00.000Z",
    },
    canonicalAwardId: AWARD_ID,
    memberAwardIds: [AWARD_ID],
    allowedSourceIds: [SOURCE_HOME, SOURCE_APPLY],
    allowedSourceIdSet: new Set([SOURCE_HOME, SOURCE_APPLY]),
    publishedFacts: {},
    officialHomepageSourceId: SOURCE_HOME,
    officialHomepageUrl: "https://example.edu/fellowship",
    sourceIdentityRules: [],
    effectiveReason: "verified",
    evaluatedAt: "2026-07-01T00:00:00.000Z",
    effectivelyVerified: true,
  } as unknown as Stage1PublicationEntry;
}

function publicationIndex(entry = publication()): Stage1PublicationIndex {
  return {
    available: true,
    unavailableReason: null,
    release: {
      releaseKey: "stage1-national-25",
      releaseState: "verified_beta",
      releaseEpoch: "60000000-0000-4000-8000-000000000001",
      policyVersion: "stage1-publication-v1",
      cohortIdentityVersion: "stage1-national-25-v1",
      cohortIdentityHash: "a".repeat(64),
      activatedAt: "2026-07-01T00:00:00.000Z",
      effectivelyReleased: true,
      effectiveReason: "verified",
    },
    entries: [entry],
    entryByCohortKey: new Map([["example", entry]]),
    entryByMemberAwardId: new Map([[AWARD_ID, entry]]),
    verifiedEntries: [entry],
    verifiedCanonicalAwardIds: [AWARD_ID],
    verifiedMemberAwardIds: [AWARD_ID],
  } as unknown as Stage1PublicationIndex;
}

function sourceRow(id: string, url: string, title: string, pageType: string, awardId = AWARD_ID) {
  return {
    id,
    shared_award_id: awardId,
    url,
    title,
    display_title: title,
    page_description: null,
    page_metadata: {},
    page_metadata_generated_at: "2026-07-01T00:00:00.000Z",
    page_metadata_model: "test",
    page_type: pageType,
    source: "official",
    reason: null,
    submitted_by_user_id: null,
    admin_review_status: "open",
    last_checked_at: "2026-07-01T00:00:00.000Z",
  };
}

function eligibleEvent(suffix: number, detectedAt: string, sourceId = SOURCE_APPLY): EligiblePublicChangeEvent {
  return {
    event: {
      id: eventId(suffix),
      shared_award_id: AWARD_ID,
      shared_award_source_id: sourceId,
      source_title: sourceId === SOURCE_HOME ? "Homepage" : "Application Instructions",
      source_url: sourceId === SOURCE_HOME ? "https://example.edu/fellowship" : "https://example.edu/fellowship/apply",
      source_page_type: sourceId === SOURCE_HOME ? "homepage" : "application",
      summary: `Material update ${suffix}`,
      change_details: {},
      suppressed_at: null,
      suppression_reason: null,
      suppression_source: null,
      visual_review_candidate_id: null,
      detected_at: detectedAt,
    },
    source: {} as EligiblePublicChangeEvent["source"],
    publication: publication(),
    evidence: {} as EligiblePublicChangeEvent["evidence"],
  };
}

// Eight recent events, newest first, then the ninth (older) one that the
// global /updates feed can still list.
const recentEvents = Array.from({ length: 8 }, (_, index) =>
  eligibleEvent(8 - index, `2026-07-${String(20 - index).padStart(2, "0")}T12:00:00.000Z`),
);
const ninthEvent = eligibleEvent(9, "2026-07-05T12:00:00.000Z");

describe("public award page deep links", () => {
  beforeEach(() => {
    mocks.loadEligiblePublicChangeEvents.mockReset();
    mocks.loadStage1PublicationIndex.mockReset();
    mocks.unreadSharedChangeIdsForUser.mockReset();
    mocks.isPublicAwardSource.mockReset().mockReturnValue(true);
    mocks.isStage1SourceIdentityExcluded.mockReset().mockReturnValue(false);
    mocks.loadStage1PublicationIndex.mockResolvedValue(publicationIndex());
    mocks.queriedTables = [];
    mocks.sourceQueryError = null;
    mocks.sourceRows = [
      sourceRow(SOURCE_HOME, "https://example.edu/fellowship", "Homepage", "homepage"),
      sourceRow(SOURCE_APPLY, "https://example.edu/fellowship/apply", "Application Instructions", "application"),
    ];
    mocks.loadEligiblePublicChangeEvents.mockImplementation(
      async (input: { eventIds?: string[] }) => {
        if (!input.eventIds) return recentEvents;
        return input.eventIds.includes(NINTH_CHANGE_ID) ? [ninthEvent] : [];
      },
    );
  });

  it.each([false, true])("distinguishes an unavailable index from a missing award (retained entry: %s)", async (retainedEntry) => {
    const index = publicationIndex();
    mocks.loadStage1PublicationIndex.mockResolvedValue({
      ...index,
      available: false,
      unavailableReason: "Private registry diagnostic",
      entries: retainedEntry ? index.entries : [],
    });

    expect(await getPublicAwardPageResolutionBySlug("example-fellowship")).toEqual({ kind: "unavailable" });
    expect(mocks.queriedTables).toEqual([]);
    expect(mocks.loadEligiblePublicChangeEvents).not.toHaveBeenCalled();
  });

  it("keeps an empty slug missing without loading the publication index", async () => {
    expect(await getPublicAwardPageResolutionBySlug("")).toEqual({ kind: "missing" });
    expect(mocks.loadStage1PublicationIndex).not.toHaveBeenCalled();
  });

  it("keeps an unverified award out of public data loading", async () => {
    mocks.loadStage1PublicationIndex.mockResolvedValue(publicationIndex({ ...publication(), effectivelyVerified: false }));

    expect(await getPublicAwardPageResolutionBySlug("example-fellowship")).toEqual({ kind: "under_verification" });
    expect(mocks.queriedTables).toEqual([]);
    expect(mocks.loadEligiblePublicChangeEvents).not.toHaveBeenCalled();
  });

  it("keeps a missing reviewed homepage under verification", async () => {
    mocks.sourceRows = [];

    expect(await getPublicAwardPageResolutionBySlug("example-fellowship")).toEqual({ kind: "under_verification" });
  });

  it("propagates source-query failures for the route's unavailable handling", async () => {
    mocks.sourceQueryError = { message: "Private source query diagnostic" };

    await expect(getPublicAwardPageResolutionBySlug("example-fellowship")).rejects.toThrow("Public award source query failed");
  });

  it("loads a deep-linked ninth event through the gates, merges it after the recent eight, and the workspace selects it", async () => {
    const resolution = await getPublicAwardPageResolutionBySlug("example-fellowship", {
      changeId: NINTH_CHANGE_ID,
    });

    expect(resolution.kind).toBe("published");
    if (resolution.kind !== "published") return;
    const data = resolution.data;
    expect(data.changes.map((change) => change.id)).toEqual([
      ...recentEvents.map((entry) => entry.event.id),
      NINTH_CHANGE_ID,
    ]);
    expect(new Set(data.changes.map((change) => change.id)).size).toBe(9);
    expect(data.changes.at(-1)).toMatchObject({
      id: NINTH_CHANGE_ID,
      sourceId: SOURCE_APPLY,
      summary: "Material update 9",
      detectedAt: "2026-07-05T12:00:00.000Z",
    });

    // Both loads go through the single public gate with this award's members
    // (they run concurrently, so the order of the two calls is not asserted).
    const calls = mocks.loadEligiblePublicChangeEvents.mock.calls.map((call) => call[0]);
    expect(calls).toHaveLength(2);
    const shapes = calls.map((input) => ({ limit: input.limit, eventIds: input.eventIds, members: input.memberAwardIds }));
    expect(shapes).toContainEqual({ limit: 8, eventIds: undefined, members: [AWARD_ID] });
    expect(shapes).toContainEqual({ limit: 1, eventIds: [NINTH_CHANGE_ID], members: [AWARD_ID] });
    for (const input of calls) {
      expect(input.publicationIndex).toBe(await mocks.loadStage1PublicationIndex.mock.results[0].value);
    }

    const html = renderToStaticMarkup(
      createElement(PublicAwardWorkspace, { data, initialChangeId: NINTH_CHANGE_ID, initialSourceId: SOURCE_APPLY }),
    );
    const main = html.slice(html.indexOf("</aside>"));
    expect(main).toContain('<h2 id="public-award-panel-heading">Application Instructions</h2>');
    expect(main).toContain('href="https://example.edu/fellowship/apply"');
    expect(main).not.toContain('<h2 id="public-award-panel-heading">Overview</h2>');
    const rows = main.split('<article aria-current="true" class="public-award-change-line" data-highlighted="true">');
    expect(rows).toHaveLength(2);
    expect(rows[1].slice(0, rows[1].indexOf("</article>"))).toContain("Material update 9");
    expect(main.split("Selected update")).toHaveLength(2);
  });

  it("keeps the recent list unchanged when the gates return nothing for the requested id", async () => {
    const rejectedId = eventId(77);

    const resolution = await getPublicAwardPageResolutionBySlug("example-fellowship", {
      changeId: rejectedId,
    });

    expect(resolution.kind).toBe("published");
    if (resolution.kind !== "published") return;
    expect(resolution.data.changes.map((change) => change.id)).toEqual(
      recentEvents.map((entry) => entry.event.id),
    );
    expect(mocks.loadEligiblePublicChangeEvents).toHaveBeenCalledTimes(2);
    const requestedCall = mocks.loadEligiblePublicChangeEvents.mock.calls
      .map((call) => call[0])
      .find((input) => input.eventIds);
    expect(requestedCall).toMatchObject({
      limit: 1,
      eventIds: [rejectedId],
      memberAwardIds: [AWARD_ID],
    });

    const html = renderToStaticMarkup(
      createElement(PublicAwardWorkspace, { data: resolution.data, initialChangeId: rejectedId }),
    );
    expect(html).toContain("<h1>Example Fellowship</h1>");
    expect(html.slice(html.indexOf("</aside>"))).toContain('<h2 id="public-award-panel-heading">Overview</h2>');
    expect(html).not.toContain('data-highlighted="true"');
  });

  it("does not duplicate a requested event that is already among the recent eight", async () => {
    const recentId = recentEvents[3].event.id;
    mocks.loadEligiblePublicChangeEvents.mockImplementation(
      async (input: { eventIds?: string[] }) =>
        input.eventIds ? recentEvents.filter((entry) => input.eventIds?.includes(entry.event.id)) : recentEvents,
    );

    const data = await getPublicAwardPageBySlug("example-fellowship", { changeId: recentId });

    expect(data?.changes.map((change) => change.id)).toEqual(recentEvents.map((entry) => entry.event.id));
  });

  it("issues no requested-event lookup without a change id", async () => {
    const data = await getPublicAwardPageBySlug("example-fellowship");

    expect(data?.changes).toHaveLength(8);
    expect(mocks.loadEligiblePublicChangeEvents).toHaveBeenCalledTimes(1);
    expect(mocks.loadEligiblePublicChangeEvents.mock.calls[0][0].eventIds).toBeUndefined();
  });

  it("threads the change id for signed-in loads and computes unread state over the merged list", async () => {
    mocks.unreadSharedChangeIdsForUser.mockResolvedValue(new Set([NINTH_CHANGE_ID]));

    const data = await getPublicAwardPageBySlug("example-fellowship", {
      userId: "user-1",
      changeId: NINTH_CHANGE_ID,
    });

    expect(data?.changes).toHaveLength(9);
    expect(mocks.unreadSharedChangeIdsForUser).toHaveBeenCalledTimes(1);
    const [userId, changes] = mocks.unreadSharedChangeIdsForUser.mock.calls[0];
    expect(userId).toBe("user-1");
    expect(changes.map((change: { id: string }) => change.id)).toContain(NINTH_CHANGE_ID);
    expect(data?.changes.find((change) => change.id === NINTH_CHANGE_ID)?.unread).toBe(true);
    expect(data?.changes.find((change) => change.id === eventId(8))?.unread).toBe(false);
  });

  it("keeps adjacent PostgreSQL microseconds in exact order instead of letting the UUID decide", () => {
    // Date.parse would tie these two at the millisecond and then reverse them
    // by UUID; the exact comparison keeps the newer microsecond first.
    const newerSmallerId = eligibleEvent(1, "2026-07-16T18:00:00.123456Z");
    const olderLargerId = eligibleEvent(9, "2026-07-16T18:00:00.123455Z");

    expect(
      mergeRequestedPublicChangeEvents([newerSmallerId], [olderLargerId]).map((entry) => entry.event.id),
    ).toEqual([newerSmallerId.event.id, olderLargerId.event.id]);
    expect(
      mergeRequestedPublicChangeEvents([olderLargerId], [newerSmallerId]).map((entry) => entry.event.id),
    ).toEqual([newerSmallerId.event.id, olderLargerId.event.id]);

    // A requested update between two recent ones that differ by one
    // microsecond lands exactly between them.
    const newest = eligibleEvent(2, "2026-07-16T18:00:00.123457Z");
    expect(
      mergeRequestedPublicChangeEvents([newest, olderLargerId], [newerSmallerId]).map((entry) => entry.event.id),
    ).toEqual([newest.event.id, newerSmallerId.event.id, olderLargerId.event.id]);
  });

  it("returns the recent list untouched when nothing was requested", () => {
    const recent = [
      eligibleEvent(3, "2026-07-16T18:00:00.123457Z"),
      eligibleEvent(1, "2026-07-16T18:00:00.123456Z"),
      eligibleEvent(9, "2026-07-16T18:00:00.123455Z"),
    ];

    const merged = mergeRequestedPublicChangeEvents(recent, []);

    expect(merged).not.toBe(recent);
    expect(merged).toEqual(recent);
    expect(merged.map((entry) => entry.event.id)).toEqual(recent.map((entry) => entry.event.id));
  });

  it("merges by id and keeps newest-first order", () => {
    const merged = mergeRequestedPublicChangeEvents(recentEvents, [ninthEvent]);
    expect(merged.map((entry) => entry.event.id)).toEqual([
      ...recentEvents.map((entry) => entry.event.id),
      NINTH_CHANGE_ID,
    ]);

    const newer = eligibleEvent(10, "2026-07-16T12:00:00.000Z");
    expect(mergeRequestedPublicChangeEvents(recentEvents, [newer]).map((entry) => entry.event.id)).toEqual([
      eventId(8),
      eventId(7),
      eventId(6),
      eventId(5),
      eventId(10),
      eventId(4),
      eventId(3),
      eventId(2),
      eventId(1),
    ]);
    expect(mergeRequestedPublicChangeEvents(recentEvents, [recentEvents[0]])).toHaveLength(8);
    expect(mergeRequestedPublicChangeEvents([], [])).toEqual([]);
  });
});

// Both source-row uniqueness constraints are per award — `unique (shared_award_id, url)`
// and the normalized-url index — so a second row for the same document is
// reachable two ways, and only these two are used below:
//   * on an ALIAS MEMBER award, where any identical URL is permitted; and
//   * within one award, where a "www." or dropped-parameter variant is a
//     distinct URL to the database but collapses under the canonical key.
const ALIAS_AWARD_ID = "10000000-0000-4000-8000-000000000002";
const SOURCE_ALIAS = "30000000-0000-4000-8000-000000000003";
const SOURCE_VARIANT = "30000000-0000-4000-8000-000000000004";
const DOCUMENT_A = "https://nspires.nasaprs.com/external/viewrepositorydocument?cmdocumentid=1075626";
const DOCUMENT_B = "https://nspires.nasaprs.com/external/viewrepositorydocument?cmdocumentid=1138353";

function listingPublication(allowed: string[]) {
  return publicationIndex({
    ...publication(),
    memberAwardIds: [AWARD_ID, ALIAS_AWARD_ID],
    allowedSourceIds: allowed,
    allowedSourceIdSet: new Set(allowed),
  } as unknown as Stage1PublicationEntry);
}

async function listedSources(): Promise<Array<{ id: string; url: string }>> {
  const resolution = await getPublicAwardPageResolutionBySlug("example-fellowship");
  expect(resolution.kind).toBe("published");
  if (resolution.kind !== "published") throw new Error("expected a published award");
  return resolution.data.sources.map((source) => ({ id: source.id, url: source.url }));
}

describe("public award source listing keeps every eligible source ID", () => {
  beforeEach(() => {
    mocks.loadEligiblePublicChangeEvents.mockReset().mockResolvedValue([]);
    mocks.loadStage1PublicationIndex.mockReset();
    mocks.unreadSharedChangeIdsForUser.mockReset();
    mocks.isPublicAwardSource.mockReset().mockReturnValue(true);
    mocks.isStage1SourceIdentityExcluded.mockReset().mockReturnValue(false);
    mocks.queriedTables = [];
    mocks.sourceQueryError = null;
    mocks.loadStage1PublicationIndex.mockResolvedValue(
      listingPublication([SOURCE_HOME, SOURCE_APPLY, SOURCE_ALIAS, SOURCE_VARIANT]),
    );
    mocks.sourceRows = [];
  });

  it("retains two allowed alias-member rows that share one document URL", async () => {
    mocks.sourceRows = [
      sourceRow(SOURCE_HOME, "https://example.edu/fellowship", "Homepage", "homepage"),
      sourceRow(SOURCE_APPLY, "https://example.edu/fellowship/apply", "Application Instructions", "application"),
      sourceRow(SOURCE_ALIAS, "https://example.edu/fellowship/apply", "Application Instructions", "application", ALIAS_AWARD_ID),
    ];

    expect((await listedSources()).map((source) => source.id))
      .toEqual([SOURCE_HOME, SOURCE_APPLY, SOURCE_ALIAS]);
  });

  it("retains an alias-member row that differs only by a trailing slash", async () => {
    mocks.sourceRows = [
      sourceRow(SOURCE_HOME, "https://example.edu/fellowship", "Homepage", "homepage"),
      sourceRow(SOURCE_APPLY, "https://example.edu/fellowship/apply", "Application Instructions", "application"),
      sourceRow(SOURCE_VARIANT, "https://example.edu/fellowship/apply/", "Application Instructions", "application", ALIAS_AWARD_ID),
    ];

    expect((await listedSources()).map((source) => source.url)).toEqual([
      "https://example.edu/fellowship",
      "https://example.edu/fellowship/apply",
      "https://example.edu/fellowship/apply/",
    ]);
  });

  // Distinct URLs to the database, one canonical key: "www." is stripped and
  // "view" is dropped when the canonical key is built.
  it.each([
    { label: "a www. host variant", url: "https://www.example.edu/fellowship/apply" },
    { label: "a dropped query parameter", url: "https://example.edu/fellowship/apply?view=full" },
  ])("retains $label of a sibling on the same award", async ({ url }) => {
    mocks.sourceRows = [
      sourceRow(SOURCE_HOME, "https://example.edu/fellowship", "Homepage", "homepage"),
      sourceRow(SOURCE_VARIANT, url, "Application Instructions", "application"),
      sourceRow(SOURCE_APPLY, "https://example.edu/fellowship/apply", "Application Instructions", "application"),
    ];

    expect((await listedSources()).map((source) => source.id))
      .toEqual([SOURCE_HOME, SOURCE_VARIANT, SOURCE_APPLY]);
  });

  it("retains two documents addressed only by query id", async () => {
    mocks.sourceRows = [
      sourceRow(SOURCE_HOME, "https://example.edu/fellowship", "Homepage", "homepage"),
      sourceRow(SOURCE_APPLY, DOCUMENT_A, "First document", "application"),
      sourceRow(SOURCE_ALIAS, DOCUMENT_B, "Second document", "application"),
    ];

    expect((await listedSources()).map((source) => source.url))
      .toEqual(["https://example.edu/fellowship", DOCUMENT_A, DOCUMENT_B]);
  });

  // Each earlier duplicate below would previously have won the canonical-URL
  // dedupe and then been dropped by its own gate, emptying the document from
  // the list entirely. The gates must reject only the offending row.
  it.each([
    {
      label: "an unallowed",
      allowed: [SOURCE_HOME, SOURCE_APPLY],
      prepare: () => {},
    },
    {
      label: "a held (not open)",
      allowed: [SOURCE_HOME, SOURCE_APPLY, SOURCE_ALIAS],
      prepare: () => {
        (mocks.sourceRows[1] as { admin_review_status: string }).admin_review_status = "review_later";
      },
    },
    {
      label: "an identity-excluded",
      allowed: [SOURCE_HOME, SOURCE_APPLY, SOURCE_ALIAS],
      prepare: () => {
        mocks.isStage1SourceIdentityExcluded.mockImplementation(
          (_publication: unknown, source: { id: string }) => source.id === SOURCE_ALIAS,
        );
      },
    },
    {
      label: "a public-quality-rejected",
      allowed: [SOURCE_HOME, SOURCE_APPLY, SOURCE_ALIAS],
      prepare: () => {
        mocks.isPublicAwardSource.mockImplementation((source: { id: string }) => source.id !== SOURCE_ALIAS);
      },
    },
  ])("keeps the eligible sibling when $label earlier duplicate is rejected", async ({ allowed, prepare }) => {
    mocks.loadStage1PublicationIndex.mockResolvedValue(listingPublication(allowed));
    mocks.sourceRows = [
      sourceRow(SOURCE_HOME, "https://example.edu/fellowship", "Homepage", "homepage"),
      // The rejected alias-member duplicate is ordered FIRST, which is what
      // used to win the canonical-URL dedupe.
      sourceRow(SOURCE_ALIAS, "https://example.edu/fellowship/apply", "Application Instructions", "application", ALIAS_AWARD_ID),
      sourceRow(SOURCE_APPLY, "https://example.edu/fellowship/apply", "Application Instructions", "application"),
    ];
    prepare();

    expect((await listedSources()).map((source) => source.id)).toEqual([SOURCE_HOME, SOURCE_APPLY]);
  });

  it("still lists the exact reviewed homepage when a slash variant is also eligible", async () => {
    mocks.sourceRows = [
      // The alias member's variant sorts first, so it previously won the
      // dedupe and the pinned exact URL disappeared from the list.
      sourceRow(SOURCE_VARIANT, "https://example.edu/fellowship/", "Homepage", "homepage", ALIAS_AWARD_ID),
      sourceRow(SOURCE_HOME, "https://example.edu/fellowship", "Homepage", "homepage"),
    ];

    expect(await listedSources()).toEqual([
      { id: SOURCE_VARIANT, url: "https://example.edu/fellowship/" },
      { id: SOURCE_HOME, url: "https://example.edu/fellowship" },
    ]);
  });

  it.each([
    { label: "held for review", prepare: (row: Record<string, unknown>) => { row.admin_review_status = "review_later"; } },
    {
      label: "rejected by the public-quality gate",
      prepare: () => {
        mocks.isPublicAwardSource.mockImplementation((source: { id: string }) => source.id !== SOURCE_HOME);
      },
    },
  ])("validates the award through a pinned homepage $label without listing it", async ({ prepare }) => {
    const homepageRow = sourceRow(SOURCE_HOME, "https://example.edu/fellowship", "Homepage", "homepage");
    mocks.sourceRows = [
      homepageRow,
      sourceRow(SOURCE_APPLY, "https://example.edu/fellowship/apply", "Application Instructions", "application"),
    ];
    prepare(homepageRow as unknown as Record<string, unknown>);

    // The award still publishes, and the hidden homepage row is never listed.
    expect((await listedSources()).map((source) => source.id)).toEqual([SOURCE_APPLY]);
  });

  it("keeps an untrackable row out of the list without disturbing its siblings", async () => {
    mocks.sourceRows = [
      sourceRow(SOURCE_HOME, "https://example.edu/fellowship", "Homepage", "homepage"),
      sourceRow(SOURCE_ALIAS, "https://example.edu/fellowship/login", "Sign in", "application"),
      sourceRow(SOURCE_APPLY, "https://example.edu/fellowship/apply", "Application Instructions", "application"),
    ];

    expect((await listedSources()).map((source) => source.id)).toEqual([SOURCE_HOME, SOURCE_APPLY]);
  });

  it("gives same-URL siblings distinct slugs, and a source deep link opens the exact ID", async () => {
    mocks.sourceRows = [
      sourceRow(SOURCE_HOME, "https://example.edu/fellowship", "Homepage", "homepage"),
      sourceRow(SOURCE_APPLY, "https://example.edu/fellowship/apply", "Application Instructions", "application"),
      sourceRow(SOURCE_ALIAS, "https://example.edu/fellowship/apply", "Mirrored Instructions", "application", ALIAS_AWARD_ID),
    ];

    const resolution = await getPublicAwardPageResolutionBySlug("example-fellowship");
    expect(resolution.kind).toBe("published");
    if (resolution.kind !== "published") return;
    const slugs = resolution.data.sources.map((source) => source.sourceSlug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(resolution.data.sources.map((source) => source.id))
      .toEqual([SOURCE_HOME, SOURCE_APPLY, SOURCE_ALIAS]);

    // The deep link resolves in the workspace: the second same-URL row is
    // reachable, and it is the one that opens.
    const markup = renderToStaticMarkup(
      createElement(PublicAwardWorkspace, { data: resolution.data, initialSourceId: SOURCE_ALIAS }),
    );
    expect(markup).toContain('<h2 id="public-award-panel-heading">Mirrored Instructions</h2>');
    expect(markup).not.toContain('<h2 id="public-award-panel-heading">Application Instructions</h2>');
  });
});
