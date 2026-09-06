import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Stage1PublicationEntry, Stage1PublicationIndex } from "@/lib/stage1-publication";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  getOfficeContext: vi.fn(),
  hasSupabaseAdminConfig: vi.fn(),
  hasSupabaseConfig: vi.fn(),
  loadEligiblePublicChangeEvents: vi.fn(),
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

// A notice state frames the heading, intro and footer around the notice and
// shows nothing that belongs to a loaded catalog.
function expectNoticeFrame(html: string) {
  expect(html).toContain("Every monitored award, in one place");
  expect(html).toContain("Open any award to see its official sources and updates.");
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
  });

  it("describes opening an award, which is what every row and search result does", async () => {
    const html = await renderDirectory();

    expect(html).toContain(
      "Search the awards AwardPing already checks. Open any award to see its official sources and updates.",
    );
    expect(html).not.toContain("Expand any award");
    expect(html).toContain("Every monitored award, in one place");
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
  });

  it("shows the empty notice when the index is available but nothing is published right now", async () => {
    mocks.loadStage1PublicationIndex.mockResolvedValue(closedIndex());

    const html = await renderDirectory();

    expect(html.split(EMPTY_NOTICE)).toHaveLength(2);
    expect(html).not.toContain(UNAVAILABLE_NOTICE);
    expectNoticeFrame(html);
    expect(mocks.loadEligiblePublicChangeEvents).not.toHaveBeenCalled();
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
