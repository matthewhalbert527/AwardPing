import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicAwardPageData } from "@/lib/public-award-pages";

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  getPublicAwardPageResolutionBySlug: vi.fn(),
  hasSupabaseAdminConfig: vi.fn(),
  notFound: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  getCurrentUser: mocks.getCurrentUser,
}));
vi.mock("@/lib/public-award-pages", () => ({
  getPublicAwardPageResolutionBySlug: mocks.getPublicAwardPageResolutionBySlug,
}));
// The config module imports "server-only", which cannot load under vitest,
// so the page tree gets exactly the exports it uses.
vi.mock("@/lib/config", () => ({
  appConfig: { url: "https://awardping.example" },
  hasSupabaseAdminConfig: mocks.hasSupabaseAdminConfig,
}));
vi.mock("@/components/site-header", () => ({
  SiteHeader: () => null,
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    mocks.notFound();
    throw new Error("NOT_FOUND");
  },
  redirect: (url: string) => {
    mocks.redirect(url);
    throw new Error(`REDIRECT ${url}`);
  },
}));

import SlugPage, { generateMetadata } from "@/app/[slug]/page";

const SOURCE_HOME = "3f1d3a2e-9d3b-4c5e-8a7f-1b2c3d4e5f60";
const SOURCE_APPLY = "5d7c9b1a-3e2f-4a6b-9c8d-7e6f5a4b3c2d";
const CHANGE_HOME = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const CHANGE_APPLY = "8c2b1a0f-6e5d-4c3b-9a8f-7e6d5c4b3a21";

function emptyFacts(): PublicAwardPageData["facts"] {
  return {
    overview: null,
    deadline: null,
    openingDate: null,
    awardAmount: null,
    eligibility: [],
    requirements: [],
    applicationMaterials: [],
    howToApply: [],
    importantDates: [],
    documents: [],
    contacts: [],
    academicLevels: [],
    disciplines: [],
    citizenship: [],
    confidence: null,
  };
}

function makeAwardPage(overrides: Partial<PublicAwardPageData> = {}): PublicAwardPageData {
  return {
    award: {
      id: "award-1",
      name: "Example Fellowship",
      slug: "example-fellowship",
      official_homepage: "https://example.edu/fellowship",
      updated_at: "2026-06-26T12:00:00.000Z",
    },
    canonicalPath: "/example-fellowship",
    redirectPath: null,
    facts: { ...emptyFacts(), overview: "A fellowship for testing.", confidence: "high" },
    metaDescription: "Example fellowship details.",
    officialHomepage: "https://example.edu/fellowship",
    lastCheckedAt: "2026-06-26T12:00:00.000Z",
    sources: [
      {
        id: SOURCE_HOME,
        sourceSlug: "overview",
        publicPath: "/example-fellowship",
        title: "Homepage",
        description: null,
        url: "https://example.edu/fellowship",
        pageType: "homepage",
        lastCheckedAt: "2026-06-26T12:00:00.000Z",
        facts: emptyFacts(),
      },
      {
        id: SOURCE_APPLY,
        sourceSlug: "apply",
        publicPath: "/example-fellowship",
        title: "Application Instructions",
        description: null,
        url: "https://example.edu/fellowship/apply",
        pageType: "application",
        lastCheckedAt: "2026-06-26T12:00:00.000Z",
        facts: emptyFacts(),
      },
    ],
    changes: [
      {
        id: CHANGE_HOME,
        sourceId: SOURCE_HOME,
        sourceTitle: "Homepage",
        sourceUrl: "https://example.edu/fellowship",
        sourcePageType: "homepage",
        summary: "The homepage changed.",
        changeDetails: {},
        detectedAt: "2026-07-04T12:00:00.000Z",
      },
      {
        id: CHANGE_APPLY,
        sourceId: SOURCE_APPLY,
        sourceTitle: "Application Instructions",
        sourceUrl: "https://example.edu/fellowship/apply",
        sourcePageType: "application",
        summary: "The application instructions changed.",
        changeDetails: {},
        detectedAt: "2026-07-03T12:00:00.000Z",
      },
    ],
    ...overrides,
  };
}

async function renderSlugPage(searchParams?: Record<string, string | string[] | undefined>) {
  return renderToStaticMarkup(
    await SlugPage({
      params: Promise.resolve({ slug: "example-fellowship" }),
      searchParams: searchParams ? Promise.resolve(searchParams) : undefined,
    }),
  );
}

// The award header and the selected panel: everything except the outline.
function mainMarkup(html: string) {
  const asideStart = html.indexOf("<aside ");
  const asideEnd = html.indexOf("</aside>") + "</aside>".length;
  expect(asideStart).toBeGreaterThanOrEqual(0);
  return html.slice(0, asideStart) + html.slice(asideEnd);
}

function expectSelectedApplyChange(html: string) {
  const main = mainMarkup(html);
  expect(html).toContain("<h1>Example Fellowship</h1>");
  expect(main).toContain("Updates shown for this source");
  expect(main).toContain('<h2 id="public-award-panel-heading">Application Instructions</h2>');
  expect(main).not.toContain('<h2 id="public-award-panel-heading">Overview</h2>');
  expect(main).not.toContain("The homepage changed.");
  const rows = main.split(
    '<article aria-current="true" class="public-award-change-line" data-highlighted="true">',
  );
  expect(rows).toHaveLength(2);
  const row = rows[1].slice(0, rows[1].indexOf("</article>"));
  expect(row).toContain("Selected update");
  expect(row).toContain("The application instructions changed.");
}

describe("public award page", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.hasSupabaseAdminConfig.mockReturnValue(true);
    mocks.getCurrentUser.mockResolvedValue(null);
    mocks.getPublicAwardPageResolutionBySlug.mockResolvedValue({
      kind: "published",
      data: makeAwardPage(),
    });
  });

  it("opens the linked source and marks the linked change for an anonymous visitor", async () => {
    const html = await renderSlugPage({ source: SOURCE_APPLY, change: CHANGE_APPLY });

    expectSelectedApplyChange(html);
    expect(mocks.getPublicAwardPageResolutionBySlug).toHaveBeenCalledWith("example-fellowship", {
      changeId: CHANGE_APPLY,
    });
    expect(mocks.getPublicAwardPageResolutionBySlug).toHaveBeenCalledTimes(1);
    expect(html).toContain('aria-label="Example Fellowship page outline"');
    expect(html).toContain('aria-label="Award sections"');
    expect(html).toContain('aria-label="Official sources, 2 source pages"');
    // The route's main is the only main landmark; the award header and H1
    // come before the outline and the selected panel.
    expect(html.split("<main")).toHaveLength(2);
    expect(html.indexOf("<h1>Example Fellowship</h1>")).toBeLessThan(html.indexOf("<aside"));
    expect(html.indexOf("<aside")).toBeLessThan(html.indexOf('id="public-award-panel"'));
  });

  it("keeps the same update context for a signed-in visitor", async () => {
    mocks.getCurrentUser.mockResolvedValue({ id: "user-1", email: "person@example.edu" });

    const html = await renderSlugPage({ source: SOURCE_APPLY, change: CHANGE_APPLY });

    expectSelectedApplyChange(html);
    expect(mocks.getPublicAwardPageResolutionBySlug).toHaveBeenLastCalledWith("example-fellowship", {
      userId: "user-1",
      changeId: CHANGE_APPLY,
    });
  });

  it.each(["unavailable", "thrown"])("shows a retry notice, not a 404, for an %s initial load", async (failure) => {
    if (failure === "thrown") {
      mocks.getPublicAwardPageResolutionBySlug.mockRejectedValue(new Error("Private database diagnostic"));
    } else {
      mocks.getPublicAwardPageResolutionBySlug.mockResolvedValue({ kind: "unavailable" });
    }

    const html = await renderSlugPage({ source: SOURCE_APPLY, change: CHANGE_APPLY });

    expect(html).toContain("Award details are unavailable right now. Please try again.");
    expect(html).toContain('<meta name="robots" content="noindex, nofollow"/>');
    expect(html).toContain(`href="/example-fellowship?source=${SOURCE_APPLY}&amp;change=${CHANGE_APPLY}"`);
    expect(html).toContain("Try again</a>");
    expect(html).not.toContain("Private database diagnostic");
    expect(html).not.toContain("Under verification");
    expect(html).not.toContain("public-award-console");
    expect(mocks.notFound).not.toHaveBeenCalled();
    expect(mocks.getCurrentUser).not.toHaveBeenCalled();
  });

  it("drops malformed and repeated query context from the retry link", async () => {
    mocks.getPublicAwardPageResolutionBySlug.mockResolvedValue({ kind: "unavailable" });

    const html = await renderSlugPage({ source: "//evil.example", change: [CHANGE_APPLY] });

    expect(html).toContain('href="/example-fellowship"');
    expect(html).not.toContain("evil.example");
    expect(html).not.toContain("?source=");
    expect(html).not.toContain("?change=");
  });

  it("shows unavailable configuration without looking up or exposing award data", async () => {
    mocks.hasSupabaseAdminConfig.mockReturnValue(false);

    const html = await renderSlugPage();

    expect(html).toContain("Award details are unavailable right now. Please try again.");
    expect(html).toContain('<meta name="robots" content="noindex, nofollow"/>');
    expect(mocks.notFound).not.toHaveBeenCalled();
    expect(mocks.getPublicAwardPageResolutionBySlug).not.toHaveBeenCalled();
  });

  it.each(["unavailable", "thrown"])("does not use the first load as stale fallback when a signed-in second load is %s", async (failure) => {
    mocks.getCurrentUser.mockResolvedValue({ id: "user-1", email: "person@example.edu" });
    mocks.getPublicAwardPageResolutionBySlug.mockResolvedValueOnce({ kind: "published", data: makeAwardPage() });
    if (failure === "thrown") {
      mocks.getPublicAwardPageResolutionBySlug.mockRejectedValueOnce(new Error("Private signed-in diagnostic"));
    } else {
      mocks.getPublicAwardPageResolutionBySlug.mockResolvedValueOnce({ kind: "unavailable" });
    }

    const html = await renderSlugPage({ source: SOURCE_APPLY, change: CHANGE_APPLY });

    expect(html).toContain("Award details are unavailable right now. Please try again.");
    expect(html).toContain(`href="/example-fellowship?source=${SOURCE_APPLY}&amp;change=${CHANGE_APPLY}"`);
    expect(html).not.toContain("A fellowship for testing.");
    expect(html).not.toContain("Private signed-in diagnostic");
    expect(html).not.toContain("public-award-console");
    expect(mocks.notFound).not.toHaveBeenCalled();
  });

  it.each(["under_verification", "missing"])("preserves the %s gate when the signed-in second load changes", async (kind) => {
    mocks.getCurrentUser.mockResolvedValue({ id: "user-1", email: "person@example.edu" });
    mocks.getPublicAwardPageResolutionBySlug
      .mockResolvedValueOnce({ kind: "published", data: makeAwardPage() })
      .mockResolvedValueOnce({ kind });

    if (kind === "missing") {
      await expect(renderSlugPage()).rejects.toThrow("NOT_FOUND");
    } else {
      const html = await renderSlugPage();
      expect(html).toContain("Under verification");
      expect(html).not.toContain("public-award-console");
      expect(html).not.toContain("unavailable right now");
    }
  });

  it.each(["unavailable", "thrown"])("uses generic non-indexable metadata for an %s load", async (failure) => {
    if (failure === "thrown") {
      mocks.getPublicAwardPageResolutionBySlug.mockRejectedValue(new Error("Private metadata diagnostic"));
    } else {
      mocks.getPublicAwardPageResolutionBySlug.mockResolvedValue({ kind: "unavailable" });
    }

    const metadata = await generateMetadata({ params: Promise.resolve({ slug: "example-fellowship" }) });

    expect(metadata).toEqual({
      title: "Award details unavailable",
      robots: { index: false, follow: false },
    });
  });

  it("keeps an unavailable body non-indexable even when its separate metadata load succeeded", async () => {
    mocks.getPublicAwardPageResolutionBySlug
      .mockResolvedValueOnce({ kind: "published", data: makeAwardPage() })
      .mockResolvedValueOnce({ kind: "unavailable" });

    const metadata = await generateMetadata({ params: Promise.resolve({ slug: "example-fellowship" }) });
    const html = await renderSlugPage();

    expect(metadata.title).toBe("Example Fellowship");
    expect(html).toContain('<meta name="robots" content="noindex, nofollow"/>');
    expect(html).toContain("Award details are unavailable right now. Please try again.");
    expect(mocks.notFound).not.toHaveBeenCalled();
  });

  it("opens the change's own source when only the change id is linked", async () => {
    const html = await renderSlugPage({ change: CHANGE_APPLY });

    expectSelectedApplyChange(html);
  });

  it("falls back to the award overview for unknown, repeated or malformed ids", async () => {
    // `loaderChangeId` is what the page may hand to the loader: a well-formed
    // but unknown id is looked up (and rejected by the gates), while a
    // repeated, empty or malformed value never reaches it.
    for (const { query, loaderChangeId } of [
      {
        query: { source: "7e6d5c4b-3a21-4f0e-9d8c-7b6a5f4e3d2c", change: "0e1f2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b" },
        loaderChangeId: "0e1f2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b",
      },
      { query: { source: [SOURCE_APPLY, SOURCE_HOME], change: [CHANGE_APPLY] }, loaderChangeId: undefined },
      { query: { source: "<script>alert(1)</script>", change: "https://evil.example" }, loaderChangeId: undefined },
      { query: { source: "", change: "" }, loaderChangeId: undefined },
    ]) {
      const html = await renderSlugPage(query);
      const main = mainMarkup(html);

      expect(html, JSON.stringify(query)).toContain("<h1>Example Fellowship</h1>");
      expect(main, JSON.stringify(query)).toContain('<h2 id="public-award-panel-heading">Overview</h2>');
      expect(main, JSON.stringify(query)).toContain("A fellowship for testing.");
      expect(html, JSON.stringify(query)).not.toContain('data-highlighted="true"');
      expect(html, JSON.stringify(query)).not.toContain("Selected update");
      expect(html, JSON.stringify(query)).not.toContain("<script>");
      expect(html, JSON.stringify(query)).not.toContain("evil.example");
      expect(mocks.getPublicAwardPageResolutionBySlug, JSON.stringify(query)).toHaveBeenLastCalledWith(
        "example-fellowship",
        { changeId: loaderChangeId },
      );
    }
    expect(mainMarkup(await renderSlugPage())).toContain('<h2 id="public-award-panel-heading">Overview</h2>');
    expect(mocks.getPublicAwardPageResolutionBySlug).toHaveBeenLastCalledWith("example-fellowship", {
      changeId: undefined,
    });
  });

  it("carries only well-formed context through the canonical redirect of an alias slug", async () => {
    mocks.getPublicAwardPageResolutionBySlug.mockResolvedValue({
      kind: "published",
      data: makeAwardPage({ redirectPath: "/example-fellowship" }),
    });

    await expect(renderSlugPage({ source: SOURCE_APPLY, change: CHANGE_APPLY })).rejects.toThrow(
      `REDIRECT /example-fellowship?source=${SOURCE_APPLY}&change=${CHANGE_APPLY}`,
    );
    await expect(renderSlugPage({ source: SOURCE_APPLY, change: "not a valid id" })).rejects.toThrow(
      `REDIRECT /example-fellowship?source=${SOURCE_APPLY}`,
    );
    await expect(renderSlugPage({ source: "//evil.example", change: [CHANGE_APPLY] })).rejects.toThrow(
      "REDIRECT /example-fellowship",
    );
    for (const url of mocks.redirect.mock.calls.map((call) => String(call[0]))) {
      expect(url.startsWith("/example-fellowship")).toBe(true);
      expect(new URL(url, "https://awardping.example").origin).toBe("https://awardping.example");
    }
  });

  it("keeps awards under verification and missing awards out of the workspace", async () => {
    mocks.getPublicAwardPageResolutionBySlug.mockResolvedValue({ kind: "under_verification" });

    const html = await renderSlugPage({ source: SOURCE_APPLY, change: CHANGE_APPLY });

    expect(html).toContain("Under verification");
    expect(html).not.toContain("public-award-console");
    expect(mocks.getCurrentUser).not.toHaveBeenCalled();

    mocks.getPublicAwardPageResolutionBySlug.mockResolvedValue({ kind: "missing" });
    await expect(renderSlugPage({ source: SOURCE_APPLY, change: CHANGE_APPLY })).rejects.toThrow(
      "NOT_FOUND",
    );
  });
});
