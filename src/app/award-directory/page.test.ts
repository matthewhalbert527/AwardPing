import { renderToStaticMarkup } from "react-dom/server";
import { load } from "cheerio";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicChangeEventRow } from "@/lib/public-change-events";
import type { Stage1PublicationEntry, Stage1PublicationIndex } from "@/lib/stage1-publication";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  getOfficeContext: vi.fn(),
  hasSupabaseAdminConfig: vi.fn(),
  hasSupabaseConfig: vi.fn(),
  loadEligiblePublicChangeEvents: vi.fn(),
  loadFirstPublishedCaptureDates: vi.fn(),
  loadStage1PublicationIndex: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  getCurrentUser: mocks.getCurrentUser,
}));
// The config module imports "server-only", which cannot load under vitest,
// so the page tree gets exactly the exports it uses.
vi.mock("@/lib/config", () => ({
  hasSupabaseConfig: mocks.hasSupabaseConfig,
  hasSupabaseAdminConfig: mocks.hasSupabaseAdminConfig,
}));
vi.mock("@/lib/offices", () => ({
  canManageOffice: () => false,
  getOfficeContext: mocks.getOfficeContext,
}));
vi.mock("@/lib/public-change-events", () => ({
  loadEligiblePublicChangeEvents: mocks.loadEligiblePublicChangeEvents,
}));
vi.mock("@/lib/award-first-capture", () => ({
  loadFirstPublishedCaptureDates: mocks.loadFirstPublishedCaptureDates,
}));
vi.mock("@/lib/stage1-publication", () => ({
  loadStage1PublicationIndex: mocks.loadStage1PublicationIndex,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: () => ({
    from() {
      throw new Error("The directory must not query tables for a visitor without an office.");
    },
  }),
}));
vi.mock("@/components/site-header", () => ({
  SiteHeader: () => null,
}));

import AwardDirectoryPage from "@/app/award-directory/page";

const AWARD_ID = "10000000-0000-4000-8000-000000000001";
const ALIAS_ID = "10000000-0000-4000-8000-000000000002";
const FIRST_CAPTURE = "2026-08-20T23:53:54.992Z";

function publicationIndex(): Stage1PublicationIndex {
  const entry = {
    canonicalAwardId: AWARD_ID,
    memberAwardIds: [AWARD_ID],
    registry: {
      canonical_name: "Example Fellowship",
      canonical_slug: "example-fellowship",
      official_homepage: "https://example.edu/fellowship",
      last_verified_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-01T00:00:00.000Z",
    },
    publishedFacts: { overview: "A fellowship for testing." },
    effectivelyVerified: true,
  } as unknown as Stage1PublicationEntry;
  return {
    available: true,
    unavailableReason: null,
    entries: [entry],
    entryByMemberAwardId: new Map([[AWARD_ID, entry]]),
    verifiedEntries: [entry],
    verifiedCanonicalAwardIds: [AWARD_ID],
    verifiedMemberAwardIds: [AWARD_ID],
  } as unknown as Stage1PublicationIndex;
}

// The publication surface is closed or malformed: nothing may be listed, and
// nothing may be described as empty either.
function unavailableIndex(): Stage1PublicationIndex {
  return {
    available: false,
    unavailableReason: "Stage 1 release epoch did not verify all 25 awards.",
    entries: [],
    entryByMemberAwardId: new Map(),
    verifiedEntries: [],
    verifiedCanonicalAwardIds: [],
    verifiedMemberAwardIds: [],
  } as unknown as Stage1PublicationIndex;
}

// The publication surface answered, but no award is published right now.
function closedIndex(): Stage1PublicationIndex {
  return {
    ...publicationIndex(),
    verifiedEntries: [],
    verifiedCanonicalAwardIds: [],
    verifiedMemberAwardIds: [],
  };
}

const EMPTY_NOTICE = "No awards are published right now.";
const UNAVAILABLE_NOTICE = "The award directory is unavailable right now. Please check back soon.";

async function renderDirectory() {
  return renderToStaticMarkup(await AwardDirectoryPage());
}

function lastUpdate(html: string) {
  const $ = load(html);
  const field = $('.award-row-card dd[data-field="updates"]');
  expect(field.length).toBe(1);
  expect(field.siblings("dt").text()).toBe("Last update");
  return { value: field.text(), dateTime: field.find("time").attr("datetime") };
}

function publicEvent(id: string, detectedAt: string, awardId = AWARD_ID): PublicChangeEventRow {
  return {
    id,
    shared_award_id: awardId,
    shared_award_source_id: null,
    source_title: "Application instructions",
    source_url: `https://example.edu/fellowship/${id}`,
    source_page_type: "application",
    summary: `The application deadline for the ${id} cycle is now October 1, 2026.`,
    change_details: null,
    suppressed_at: null,
    suppression_reason: null,
    suppression_source: null,
    visual_review_candidate_id: null,
    detected_at: detectedAt,
  };
}

// A notice state frames the heading, intro and footer around the notice and
// shows nothing that belongs to a loaded catalog.
function expectNoticeFrame(html: string) {
  const $ = load(html);
  expect($("h1").text()).toBe("Award directory");
  expect(html).toContain("Find an award, check its deadline, and see what changed.");
  expect(html).not.toContain("Every monitored award, in one place");
  expect(html).toContain('<a href="/contact">Contact</a>');
  expect(html).not.toContain('id="award-directory-search"');
  expect(html).not.toContain("monitored awards match");
  expect(html).not.toContain("awards under");
  expect(html).not.toContain("award-row-summary");
  expect(html).not.toContain("0 of 0");
}

describe("award directory page", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.hasSupabaseConfig.mockReturnValue(true);
    mocks.hasSupabaseAdminConfig.mockReturnValue(true);
    mocks.getCurrentUser.mockResolvedValue(null);
    mocks.getOfficeContext.mockResolvedValue(null);
    mocks.loadStage1PublicationIndex.mockResolvedValue(publicationIndex());
    mocks.loadEligiblePublicChangeEvents.mockResolvedValue([]);
    mocks.loadFirstPublishedCaptureDates.mockResolvedValue(new Map([[AWARD_ID, FIRST_CAPTURE]]));
  });

  it("shows the first published capture as Last update when there are no public events", async () => {
    const index = publicationIndex();
    mocks.loadStage1PublicationIndex.mockResolvedValue(index);

    const html = await renderDirectory();

    expect(lastUpdate(html)).toEqual({ value: "August 20, 2026", dateTime: FIRST_CAPTURE });
    expect(html).not.toContain("None recorded");
    expect(mocks.loadFirstPublishedCaptureDates).toHaveBeenCalledExactlyOnceWith({
      admin: expect.objectContaining({ from: expect.any(Function) }),
      publicationIndex: index,
    });
    expect(mocks.loadEligiblePublicChangeEvents).toHaveBeenCalledWith({
      admin: expect.objectContaining({ from: expect.any(Function) }),
      publicationIndex: index,
      limit: null,
    });
  });

  it("prefers the newest eligible public event over the first capture and an older event", async () => {
    const index = publicationIndex();
    mocks.loadStage1PublicationIndex.mockResolvedValue(index);
    // The eligible-event loader's contract is newest-first, independent of
    // registry verification and of the initial captured source timestamp.
    mocks.loadEligiblePublicChangeEvents.mockResolvedValue([
      { event: publicEvent("latest", "2026-09-07T18:00:00.000Z"), publication: index.verifiedEntries[0] },
      { event: publicEvent("older", "2026-09-03T18:00:00.000Z"), publication: index.verifiedEntries[0] },
    ]);

    expect(lastUpdate(await renderDirectory())).toEqual({
      value: "September 7, 2026", dateTime: "2026-09-07T18:00:00.000Z",
    });
  });

  it("looks up the first capture by canonical award ID rather than an alias", async () => {
    const index = publicationIndex();
    const entry = index.verifiedEntries[0];
    entry.memberAwardIds = [AWARD_ID, ALIAS_ID];
    index.entryByMemberAwardId.set(ALIAS_ID, entry);
    index.verifiedMemberAwardIds = [AWARD_ID, ALIAS_ID];
    mocks.loadStage1PublicationIndex.mockResolvedValue(index);
    mocks.loadFirstPublishedCaptureDates.mockResolvedValue(new Map([
      [AWARD_ID, FIRST_CAPTURE], [ALIAS_ID, "2026-08-25T18:00:00.000Z"],
    ]));

    const html = await renderDirectory();
    expect(lastUpdate(html)).toEqual({ value: "August 20, 2026", dateTime: FIRST_CAPTURE });
    expect(load(html)(".award-row-summary").attr("href")).toBe("/example-fellowship");
  });

  it("attributes an eligible alias event to the canonical award before selecting Last update", async () => {
    const index = publicationIndex();
    const entry = index.verifiedEntries[0];
    entry.memberAwardIds = [AWARD_ID, ALIAS_ID];
    index.entryByMemberAwardId.set(ALIAS_ID, entry);
    index.verifiedMemberAwardIds = [AWARD_ID, ALIAS_ID];
    mocks.loadStage1PublicationIndex.mockResolvedValue(index);
    mocks.loadEligiblePublicChangeEvents.mockResolvedValue([
      { event: publicEvent("alias-event", "2026-09-03T18:00:00.000Z", ALIAS_ID), publication: entry },
    ]);

    expect(lastUpdate(await renderDirectory())).toEqual({
      value: "September 3, 2026", dateTime: "2026-09-03T18:00:00.000Z",
    });
  });

  it.each([null, "not a date", "2026-02-30T12:00:00.000Z"])(
    "does not replace unavailable first-capture data %s with registry verification or update dates",
    async (capture) => {
      mocks.loadFirstPublishedCaptureDates.mockResolvedValue(capture === null ? new Map() : new Map([[AWARD_ID, capture]]));
      const html = await renderDirectory();
      expect(lastUpdate(html)).toEqual({ value: "Not available", dateTime: undefined });
      expect(html).not.toContain("None recorded");
    },
  );

  it("introduces the directory with one compact heading and its useful tasks", async () => {
    const html = await renderDirectory();
    const $ = load(html);

    expect(html).toContain(
      "Find an award, check its deadline, and see what changed.",
    );
    expect(html).not.toContain("Expand any award");
    expect($("h1")).toHaveLength(1);
    expect($("h1").text()).toBe("Award directory");
    expect(html).not.toContain("Every monitored award, in one place");
    expect(html).not.toContain("Search the awards AwardPing already checks.");
    // A loaded catalog shows the workspace and no notice.
    expect(html).not.toContain(EMPTY_NOTICE);
    expect(html).not.toContain(UNAVAILABLE_NOTICE);
    // The directory workspace is composed with the published award linking to
    // its canonical public page.
    expect(html).toContain('id="award-directory-search"');
    expect(html).toContain('<a class="award-row-summary block" href="/example-fellowship">');
    expect(html).toContain("<span>Example Fellowship</span>");
  });

  it("renders the same directory for a signed-in visitor without an office", async () => {
    const anonymous = await renderDirectory();
    mocks.getCurrentUser.mockResolvedValue({ id: "user-1", email: "person@example.edu" });

    const signedIn = await renderDirectory();

    expect(signedIn).toBe(anonymous);
    expect(mocks.getOfficeContext).toHaveBeenCalledWith({ id: "user-1", email: "person@example.edu" });
  });

  it("shows the unavailable notice, not a zero count or search, when the publication index is unavailable", async () => {
    mocks.loadStage1PublicationIndex.mockResolvedValue(unavailableIndex());

    const html = await renderDirectory();

    expect(html.split(UNAVAILABLE_NOTICE)).toHaveLength(2);
    expect(html).not.toContain(EMPTY_NOTICE);
    expectNoticeFrame(html);
    expect(mocks.loadEligiblePublicChangeEvents).not.toHaveBeenCalled();
    expect(mocks.loadFirstPublishedCaptureDates).not.toHaveBeenCalled();
  });

  it("shows the empty notice when the index is available but nothing is published right now", async () => {
    mocks.loadStage1PublicationIndex.mockResolvedValue(closedIndex());

    const html = await renderDirectory();

    expect(html.split(EMPTY_NOTICE)).toHaveLength(2);
    expect(html).not.toContain(UNAVAILABLE_NOTICE);
    expectNoticeFrame(html);
    expect(mocks.loadEligiblePublicChangeEvents).not.toHaveBeenCalled();
    expect(mocks.loadFirstPublishedCaptureDates).not.toHaveBeenCalled();
  });

  it("keeps the page up with the unavailable notice, and the session lookup intact, when a catalog load throws", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    mocks.loadStage1PublicationIndex.mockRejectedValue(new Error("connection refused"));
    const indexFailure = await renderDirectory();
    expect(indexFailure.split(UNAVAILABLE_NOTICE)).toHaveLength(2);
    expect(indexFailure).not.toContain(EMPTY_NOTICE);
    expect(indexFailure).not.toContain("connection refused");
    expectNoticeFrame(indexFailure);
    expect(mocks.getCurrentUser).toHaveBeenCalledTimes(1);

    mocks.loadStage1PublicationIndex.mockResolvedValue(publicationIndex());
    mocks.loadEligiblePublicChangeEvents.mockRejectedValue(new Error("timeout"));
    const eventsFailure = await renderDirectory();
    expect(eventsFailure.split(UNAVAILABLE_NOTICE)).toHaveLength(2);
    expect(eventsFailure).not.toContain("timeout");
    expectNoticeFrame(eventsFailure);

    expect(consoleError).toHaveBeenCalledTimes(2);
    consoleError.mockRestore();
  });

  it("short-circuits before any session or office lookup when public configuration is missing", async () => {
    mocks.hasSupabaseConfig.mockReturnValue(false);
    mocks.getCurrentUser.mockRejectedValue(new Error("session lookup must not run"));
    mocks.getOfficeContext.mockRejectedValue(new Error("office lookup must not run"));

    const html = await renderDirectory();

    expect(html.split(UNAVAILABLE_NOTICE)).toHaveLength(2);
    expect(html).not.toContain(EMPTY_NOTICE);
    expect(html).not.toContain("Environment setup needed");
    expect(html).not.toContain(".env");
    expectNoticeFrame(html);
    expect(mocks.getCurrentUser).not.toHaveBeenCalled();
    expect(mocks.getOfficeContext).not.toHaveBeenCalled();
    expect(mocks.loadStage1PublicationIndex).not.toHaveBeenCalled();
    expect(mocks.loadEligiblePublicChangeEvents).not.toHaveBeenCalled();
  });

  it("short-circuits the same way when only the admin key is missing, even for a signed-in visitor", async () => {
    mocks.hasSupabaseAdminConfig.mockReturnValue(false);
    mocks.getCurrentUser.mockResolvedValue({ id: "user-1", email: "person@example.edu" });
    mocks.getOfficeContext.mockRejectedValue(new Error("office lookup must not run"));

    const html = await renderDirectory();

    expect(html.split(UNAVAILABLE_NOTICE)).toHaveLength(2);
    expect(html).not.toContain(EMPTY_NOTICE);
    expectNoticeFrame(html);
    expect(mocks.getCurrentUser).not.toHaveBeenCalled();
    expect(mocks.getOfficeContext).not.toHaveBeenCalled();
    expect(mocks.loadStage1PublicationIndex).not.toHaveBeenCalled();
  });

  it("propagates a configured session lookup failure instead of showing a notice", async () => {
    mocks.getCurrentUser.mockRejectedValue(new Error("session store unavailable"));

    await expect(renderDirectory()).rejects.toThrow("session store unavailable");
    // The session is resolved before the catalog is requested.
    expect(mocks.loadStage1PublicationIndex).not.toHaveBeenCalled();
  });

  it("propagates a configured office lookup failure for a signed-in visitor", async () => {
    mocks.getCurrentUser.mockResolvedValue({ id: "user-1", email: "person@example.edu" });
    mocks.getOfficeContext.mockRejectedValue(new Error("office lookup failed"));

    await expect(renderDirectory()).rejects.toThrow("office lookup failed");
  });
});
