import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Stage1PublicationEntry, Stage1PublicationIndex } from "@/lib/stage1-publication";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  getOfficeContext: vi.fn(),
  loadEligiblePublicChangeEvents: vi.fn(),
  loadStage1PublicationIndex: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  getCurrentUser: mocks.getCurrentUser,
}));
// The config module imports "server-only", which cannot load under vitest,
// so the page tree gets exactly the exports it uses.
vi.mock("@/lib/config", () => ({
  hasSupabaseConfig: () => true,
  hasSupabaseAdminConfig: () => true,
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

async function renderDirectory() {
  return renderToStaticMarkup(await AwardDirectoryPage());
}

describe("award directory page", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.getCurrentUser.mockResolvedValue(null);
    mocks.getOfficeContext.mockResolvedValue(null);
    mocks.loadStage1PublicationIndex.mockResolvedValue(publicationIndex());
    mocks.loadEligiblePublicChangeEvents.mockResolvedValue([]);
  });

  it("describes opening an award, which is what every row and search result does", async () => {
    const html = await renderDirectory();

    expect(html).toContain(
      "Search the awards AwardPing already checks. Open any award to see its official source tree and recent update history.",
    );
    expect(html).not.toContain("Expand any award");
    expect(html).toContain("Every monitored award, in one place");
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
});
