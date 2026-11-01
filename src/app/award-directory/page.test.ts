import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
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
  loadDirectoryPublicationIndex: vi.fn(),
  assertCurrentRelease: vi.fn(),
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
  assertStage1PublicationReleaseCurrent: mocks.assertCurrentRelease,
}));
vi.mock("@/lib/award-first-capture", () => ({
  loadFirstPublishedCaptureDates: mocks.loadFirstPublishedCaptureDates,
}));
vi.mock("@/lib/public-render-publication", () => ({
  loadPublicRenderPublicationIndex: mocks.loadStage1PublicationIndex,
  loadPublicRenderDirectoryPublicationIndex: mocks.loadDirectoryPublicationIndex,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: () => ({
    from() {
      throw new Error("The directory must not query tables for a visitor without an office.");
    },
  }),
}));
vi.mock("@/components/site-header", () => ({
  SiteHeader: () => createElement("header", { "data-session-header": "" }),
}));

import AwardDirectoryPage from "@/app/award-directory/page";
import { emptyBasicAwardFacts } from "@/lib/program-basic-facts.server";

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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function expectNoCardDateMetadata(html: string) {
  const $ = load(html);
  const card = $('.award-row-card');
  expect(card).toHaveLength(1);
  expect(card.find('dl[aria-label="Award information dates"], [data-field="details"], [data-field="updates"]')).toHaveLength(0);
  expect(card.text()).not.toMatch(/Details checked|Last reported change|No changes reported/);
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
  it("passes scoped application deadlines from reviewed important dates to directory cards", async () => {
    const index = publicationIndex();
    index.verifiedEntries[0].publishedFacts = {
      overview: "A fellowship for testing.",
      important_dates: [
        "US citizens resident in the USA round — Wednesday 14 October 2026 at 11:59 p.m. GMT: Application deadline",
        "All other eligible applicants round — Tuesday 8 December 2026 or Wednesday 6 January 2027 at 11:59 p.m. GMT (dependent on course): Application deadline",
        "US citizens resident in the USA round — Monday 14 December 2026: Notification of application outcome",
      ],
    };
    mocks.loadStage1PublicationIndex.mockResolvedValue(index);
    const html = await renderDirectory();
    const $ = load(html);
    const card = $(".award-row-deadline");
    expect(card.children("div")).toHaveLength(2);
    expect(card.find("dt").map((_index, element) => $(element).text()).get()).toEqual(["Application", "Application"]);
    expect(card.text()).toContain("Wednesday 14 October 2026 at 11:59 p.m. GMT");
    expect(card.text()).toContain("Tuesday 8 December 2026 or Wednesday 6 January 2027 at 11:59 p.m. GMT");
    expect(card.text()).toContain("US citizens resident in the USA round");
    expect(card.text()).toContain("All other eligible applicants round");
    expect(card.text()).toContain("(dependent on course)");
    expect(card.text()).not.toContain("Not listed");
    expect(card.text()).not.toContain("Notification");
  });

  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.hasSupabaseConfig.mockReturnValue(true);
    mocks.hasSupabaseAdminConfig.mockReturnValue(true);
    mocks.getCurrentUser.mockResolvedValue(null);
    mocks.getOfficeContext.mockResolvedValue(null);
    mocks.loadStage1PublicationIndex.mockResolvedValue(publicationIndex());
    // Most presentation fixtures use the same authority and hydrated entries.
    // Timing/failure tests below supply the two snapshots independently.
    mocks.loadDirectoryPublicationIndex.mockImplementation(async () => mocks.loadStage1PublicationIndex.mock.results.at(-1)?.value);
    mocks.assertCurrentRelease.mockResolvedValue("current-release-epoch");
    mocks.loadEligiblePublicChangeEvents.mockResolvedValue([]);
    mocks.loadFirstPublishedCaptureDates.mockResolvedValue(new Map([[AWARD_ID, FIRST_CAPTURE]]));
  });
  it("starts one facts hydration and the event lane together only after thin authority completes", async () => {
    const thin = deferred<Stage1PublicationIndex>(), facts = deferred<Stage1PublicationIndex>();
    const events = deferred<Array<{ event: PublicChangeEventRow; publication: Stage1PublicationEntry }>>();
    const authority = publicationIndex(), entry = authority.verifiedEntries[0];
    entry.publishedFacts = emptyBasicAwardFacts(); entry.basicFactsUnavailable = true;
    entry.allowedSourceIds = ["30000000-0000-4000-8000-000000000001"];
    entry.allowedSourceIdSet = new Set(entry.allowedSourceIds);
    entry.approvedTextAlertSourceBindings = { [entry.allowedSourceIds[0]]: { url: "https://example.edu/fellowship", shared_award_id: AWARD_ID, epoch: "current-epoch" } };
    const before = structuredClone(authority);
    const hydrated = structuredClone(authority), approved = hydrated.verifiedEntries[0];
    approved.publishedFacts = { ...emptyBasicAwardFacts(), reviewed_cycle: "2027", overview: "Fresh approved basic details.", deadline: "January 31, 2027" };
    approved.basicFactsUnavailable = false;
    approved.basicFactSnapshot = { id: AWARD_ID, kind: "automated_source_verified_basics", current: true, verifiedAt: "2026-10-28T12:00:00.000Z" };
    const completed: string[] = [];
    mocks.loadStage1PublicationIndex.mockReturnValue(thin.promise);
    mocks.loadDirectoryPublicationIndex.mockImplementation(() => facts.promise.then(value => { completed.push("facts"); return value; }));
    mocks.loadEligiblePublicChangeEvents.mockImplementation(() => events.promise.then(value => { completed.push("events"); return value; }));
    mocks.assertCurrentRelease.mockImplementation(async () => { completed.push("release"); return "current-release"; });
    const rendering = renderDirectory();
    expect(mocks.loadDirectoryPublicationIndex).not.toHaveBeenCalled(); expect(mocks.loadEligiblePublicChangeEvents).not.toHaveBeenCalled();
    thin.resolve(authority);
    await vi.waitFor(() => expect(mocks.loadEligiblePublicChangeEvents).toHaveBeenCalledOnce());
    expect(mocks.loadDirectoryPublicationIndex).toHaveBeenCalledOnce();
    expect(mocks.loadEligiblePublicChangeEvents.mock.calls[0][0]).toMatchObject({ publicationIndex: authority, limit: null });
    expect(mocks.loadEligiblePublicChangeEvents.mock.calls[0][0].publicationIndex).toBe(authority);
    expect(mocks.assertCurrentRelease).not.toHaveBeenCalled();
    events.resolve([]); await vi.waitFor(() => expect(completed).toEqual(["events"]));
    expect(mocks.assertCurrentRelease).not.toHaveBeenCalled();
    facts.resolve(hydrated);
    const html = await rendering;
    // Cards intentionally show the name/deadline, not the overview text.
    expect(html).toContain("January 31, 2027");
    expect(completed).toEqual(["events", "facts", "release"]);
    expect(mocks.loadDirectoryPublicationIndex).toHaveBeenCalledOnce();
    expect(mocks.loadStage1PublicationIndex).toHaveBeenCalledOnce();
    expect(mocks.assertCurrentRelease).toHaveBeenCalledExactlyOnceWith(expect.anything(), authority);
    expect(authority).toEqual(before);
  });

  it.each(["unavailable", "empty"])("starts neither lane for a thin %s publication result", async kind => {
    mocks.loadStage1PublicationIndex.mockResolvedValue(kind === "unavailable" ? unavailableIndex() : closedIndex());
    const html = await renderDirectory();
    expect(html).toContain(kind === "unavailable" ? UNAVAILABLE_NOTICE : EMPTY_NOTICE);
    expect(mocks.loadDirectoryPublicationIndex).not.toHaveBeenCalled();
    expect(mocks.loadEligiblePublicChangeEvents).not.toHaveBeenCalled();
    expect(mocks.assertCurrentRelease).not.toHaveBeenCalled();
  });

  it("fails closed if the release is suspended after events finish but while facts are loading", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const facts = deferred<Stage1PublicationIndex>();
      mocks.loadDirectoryPublicationIndex.mockReturnValue(facts.promise);
      const rendering = renderDirectory();
      await vi.waitFor(() => expect(mocks.loadEligiblePublicChangeEvents).toHaveBeenCalledOnce());
      expect(mocks.assertCurrentRelease).not.toHaveBeenCalled();
      mocks.assertCurrentRelease.mockRejectedValue(Error("Stage 1 public release changed while updates were loading."));
      facts.resolve(publicationIndex());
      const html = await rendering;
      expect(html).toContain(UNAVAILABLE_NOTICE); expect(html).not.toContain(EMPTY_NOTICE);
      expect(html).not.toContain("Example Fellowship"); expect(html).not.toContain("Stage 1 public release changed");
      expect(mocks.assertCurrentRelease).toHaveBeenCalledOnce();
    } finally { consoleError.mockRestore(); }
  });

  it("preserves source authority and shows unavailable basic fields without reviving retired facts", async () => {
    const authority = publicationIndex(), hydrated = structuredClone(authority);
    for (const entry of hydrated.entries) {
      entry.publishedFacts = emptyBasicAwardFacts(); entry.basicFactsUnavailable = true;
    }
    mocks.loadStage1PublicationIndex.mockResolvedValue(authority);
    mocks.loadDirectoryPublicationIndex.mockResolvedValue(hydrated);
    const html = await renderDirectory();
    expect(html).toContain("Example Fellowship"); expect(html).toContain("Not listed");
    expect(html).not.toContain("A fellowship for testing."); expect(html).not.toContain(UNAVAILABLE_NOTICE);
    expect(mocks.loadEligiblePublicChangeEvents.mock.calls[0][0].publicationIndex).toBe(authority);
    expect(mocks.assertCurrentRelease).toHaveBeenCalledOnce();
  });
  it("shows the current application deadline without verification or change metadata", async () => {
    const index = publicationIndex(), entry = index.verifiedEntries[0];
    entry.publishedFacts = { ...emptyBasicAwardFacts(), reviewed_cycle: "2027", overview: "Current official basic details.", deadline: "January 31, 2027" };
    entry.basicFactSnapshot = { id: AWARD_ID, kind: "automated_source_verified_basics", current: true, verifiedAt: "2026-10-28T12:00:00.000Z" };
    mocks.loadStage1PublicationIndex.mockResolvedValue(index);
    const html = await renderDirectory();
    expect(html).toContain("January 31, 2027"); expect(html).not.toContain("January 31, 2026");
    expectNoCardDateMetadata(html);
    expect(html).not.toContain("October 28, 2026"); expect(html).not.toContain("Application routes");
  });
  it("carries reviewed application status and expected month-only opening into the public card", async () => {
    const index = publicationIndex(), entry = index.verifiedEntries[0];
    entry.publishedFacts = { ...emptyBasicAwardFacts(), reviewed_cycle: "AY 2027–28",
      overview: "Current official basic details.", cycle_status: "AY 2026–27 applications are closed.",
      opening_date: "AY 2027–28 applications are expected to open in February 2027." };
    entry.basicFactSnapshot = { id: AWARD_ID, kind: "automated_source_verified_basics", current: true, verifiedAt: "2026-10-28T12:00:00.000Z" };
    mocks.loadStage1PublicationIndex.mockResolvedValue(index);
    const $ = load(await renderDirectory()), card = $(".award-row-deadline");
    expect(card.find("[data-application-context='status'] dd").text()).toBe("AY 2026–27 applications are closed.");
    expect(card.find("[data-application-context='opening'] dd").text()).toBe("AY 2027–28 applications are expected to open in February 2027.");
    expect(card.find("[data-deadline-status]")).toHaveLength(0);
    expect(card.text()).not.toMatch(/Unconfirmed|Not listed|January 31, 2026|February 1, 2027/);
  });
  it.each(["stale", "unavailable"])("keeps a %s basic snapshot card visible without reviving old fields or inventing updates", async kind => {
    const index = publicationIndex(), entry = index.verifiedEntries[0]; entry.publishedFacts = emptyBasicAwardFacts();
    if (kind === "stale") entry.basicFactSnapshot = { id: AWARD_ID, kind: "automated_source_verified_basics", current: false, verifiedAt: "2026-10-28T12:00:00.000Z" };
    else entry.basicFactsUnavailable = true;
    mocks.loadStage1PublicationIndex.mockResolvedValue(index);
    const html = await renderDirectory();
    expect(html).toContain("Example Fellowship"); expect(html).not.toContain("January 31, 2026"); expect(html).not.toContain("January 31, 2027");
    expectNoCardDateMetadata(html);
  });

  it("omits date metadata when there are no eligible public events", async () => {
    const index = publicationIndex();
    mocks.loadStage1PublicationIndex.mockResolvedValue(index);

    const html = await renderDirectory();

    expectNoCardDateMetadata(html);
    expect(html).not.toContain("None recorded");
    expect(mocks.loadFirstPublishedCaptureDates).not.toHaveBeenCalled();
    expect(mocks.loadEligiblePublicChangeEvents).toHaveBeenCalledWith({
      admin: expect.objectContaining({ from: expect.any(Function) }),
      publicationIndex: index,
      limit: null,
    });
  });

  it.each([false, true])("keeps date metadata off cards with public events (alias source: %s)", async alias => {
    const index = publicationIndex(), entry = index.verifiedEntries[0];
    entry.basicFactSnapshot = { id: AWARD_ID, kind: "automated_source_verified_basics", current: true, verifiedAt: "2026-10-29T12:00:00.000Z" };
    if (alias) {
      entry.memberAwardIds = [AWARD_ID, ALIAS_ID];
      index.entryByMemberAwardId.set(ALIAS_ID, entry);
      index.verifiedMemberAwardIds = [AWARD_ID, ALIAS_ID];
    }
    mocks.loadStage1PublicationIndex.mockResolvedValue(index);
    mocks.loadEligiblePublicChangeEvents.mockResolvedValue([
      { event: publicEvent("latest", "2026-09-07T18:00:00.000Z", alias ? ALIAS_ID : AWARD_ID), publication: entry },
      { event: publicEvent("older", "2026-09-03T18:00:00.000Z"), publication: entry },
    ]);
    const html = await renderDirectory();
    expectNoCardDateMetadata(html);
    expect(load(html)(".award-row-summary").attr("href")).toBe("/example-fellowship");
    expect(html).not.toMatch(/October 29, 2026|September 7, 2026|September 3, 2026/);
  });

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
    expect($(".award-row-summary span").filter((_index, element) => $(element).text() === "Example Fellowship")).toHaveLength(1);
  });

  it("renders the same directory for a signed-in visitor without an office", async () => {
    const anonymous = await renderDirectory();
    mocks.getCurrentUser.mockResolvedValue({ id: "user-1", email: "person@example.edu" });

    const signedIn = await renderDirectory();

    expect(signedIn).toBe(anonymous);
    expect(mocks.getCurrentUser).not.toHaveBeenCalled();
    expect(mocks.getOfficeContext).not.toHaveBeenCalled();
    expect(load(signedIn)("[data-session-header]")).toHaveLength(1);
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

  it("keeps the page up with its authenticated header and unavailable notice when a catalog load throws", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    mocks.loadStage1PublicationIndex.mockRejectedValue(new Error("connection refused"));
    const indexFailure = await renderDirectory();
    expect(indexFailure.split(UNAVAILABLE_NOTICE)).toHaveLength(2);
    expect(indexFailure).not.toContain(EMPTY_NOTICE);
    expect(indexFailure).not.toContain("connection refused");
    expectNoticeFrame(indexFailure);
    expect(mocks.getCurrentUser).not.toHaveBeenCalled();
    expect(load(indexFailure)("[data-session-header]")).toHaveLength(1);

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

  it("does not run a duplicate session lookup for public browse results", async () => {
    mocks.getCurrentUser.mockRejectedValue(new Error("session store unavailable"));

    const html = await renderDirectory();
    expect(html).toContain("Example Fellowship");
    expect(load(html)("[data-session-header]")).toHaveLength(1);
    expect(mocks.getCurrentUser).not.toHaveBeenCalled();
    expect(mocks.loadStage1PublicationIndex).toHaveBeenCalledTimes(1);
  });

  it("does not query unused office memberships or tracking rows for a signed-in visitor", async () => {
    mocks.getCurrentUser.mockResolvedValue({ id: "user-1", email: "person@example.edu" });
    mocks.getOfficeContext.mockRejectedValue(new Error("office lookup failed"));

    const html = await renderDirectory();
    expect(html).toContain("Example Fellowship");
    expect(mocks.getOfficeContext).not.toHaveBeenCalled();
    // The mock admin client rejects table reads: the public catalog still
    // succeeds, without reading the office's private awards/tracking table.
    expect(load(html)("[data-session-header]")).toHaveLength(1);
  });
});
