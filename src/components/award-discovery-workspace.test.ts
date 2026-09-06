import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AwardDiscoveryWorkspace,
  awardDirectoryHref,
  type SharedAwardCard,
} from "@/components/award-discovery-workspace";
import { dashboardAwardPath } from "@/lib/award-slugs";

// A static render cannot type into the search box, so the component's own
// first two state slots (the search query, then whether the results panel is
// open) can be preset for one render. The real search path then runs:
// matching, ordering and the search-option links exactly as in the browser.
const searchState = vi.hoisted(() => ({ presets: [] as unknown[] }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const useState = ((initial: unknown) =>
    actual.useState(searchState.presets.length ? searchState.presets.shift() : initial)) as typeof actual.useState;
  return { ...actual, useState };
});

// The catalog row carries no slug of its own, so the dashboard path helper
// falls back to a name-and-id path that differs from the canonical public
// path. Any auth-conditional routing would therefore surface as a different
// href than the canonical one.
const goldwater: SharedAwardCard = {
  id: "63298584-f2f8-41b7-87a8-7892af8b642a",
  name: "Goldwater Scholarship",
  slug: null,
  publicPath: "/goldwater-scholarship",
  officialHomepage: "https://goldwaterscholarship.gov",
  summary: "Supports undergraduate STEM researchers.",
  deadline: "January 29, 2026",
  academicLevels: ["Undergraduate"],
  disciplines: ["STEM"],
  citizenship: ["U.S. citizens"],
  lastCheckedAt: "2026-06-24T12:00:00.000Z",
  recentlyUpdated: true,
  sourceCount: 4,
  sourceIssueCount: null,
  changeCount: 2,
  tracked: true,
  detailsLoaded: false,
  sources: [],
  changes: [],
};

const truman: SharedAwardCard = {
  ...goldwater,
  id: "7b1e2d3c-4f5a-4b6c-8d9e-0f1a2b3c4d5e",
  name: "Truman Scholarship",
  slug: "truman-scholarship",
  publicPath: "/truman-scholarship",
  officialHomepage: "https://truman.gov",
  summary: "Supports public service leaders.",
  tracked: false,
};

const dashboardPath = dashboardAwardPath(goldwater.slug, goldwater.name, goldwater.id);

function render(isAuthenticated: boolean, options: { search?: string } = {}) {
  searchState.presets = options.search ? [options.search, true] : [];
  try {
    return renderToStaticMarkup(
      createElement(AwardDiscoveryWorkspace, {
        canManage: isAuthenticated,
        isAuthenticated,
        sharedAwards: [goldwater, truman],
      }),
    );
  } finally {
    searchState.presets = [];
  }
}

function browseRowHrefs(html: string) {
  return [...html.matchAll(/<a class="award-row-summary block" href="([^"]*)">/g)].map((match) => match[1]);
}

function searchOptionHrefs(html: string) {
  return [...html.matchAll(/<a class="award-search-option" role="option" aria-selected="false" href="([^"]*)">/g)].map(
    (match) => match[1],
  );
}

afterEach(() => {
  searchState.presets = [];
});

describe("AwardDiscoveryWorkspace", () => {
  it("renders the same canonical browse links for anonymous and signed-in visitors", () => {
    expect(dashboardPath).not.toBe(goldwater.publicPath);

    const anonymous = render(false);
    const signedIn = render(true);

    // The letter view opens on "G": only the Goldwater row is listed.
    expect(browseRowHrefs(anonymous)).toEqual(["/goldwater-scholarship"]);
    expect(browseRowHrefs(signedIn)).toEqual(["/goldwater-scholarship"]);
    expect(signedIn).toBe(anonymous);
    expect(anonymous).toContain("<span>Goldwater Scholarship</span>");
    expect(anonymous).not.toContain(dashboardPath);
  });

  it("lists search results at the canonical public path for both auth states", () => {
    const anonymous = render(false, { search: "Goldwater" });
    const signedIn = render(true, { search: "Goldwater" });

    expect(anonymous).toContain("1 matching award");
    expect(anonymous).toContain('aria-expanded="true"');
    expect(searchOptionHrefs(anonymous)).toEqual(["/goldwater-scholarship"]);
    expect(searchOptionHrefs(signedIn)).toEqual(["/goldwater-scholarship"]);
    expect(signedIn).toBe(anonymous);
    expect(anonymous).toContain('<span class="award-search-option-title">Goldwater Scholarship</span>');
    expect(anonymous).not.toContain(dashboardPath);
    // The browse list is hidden while results are shown.
    expect(browseRowHrefs(anonymous)).toEqual([]);

    const broader = render(true, { search: "Scholarship" });
    expect(searchOptionHrefs(broader)).toEqual(["/goldwater-scholarship", "/truman-scholarship"]);
  });

  it("renders no secondary row action or duplicate award destination in either state", () => {
    for (const isAuthenticated of [false, true]) {
      const html = render(isAuthenticated);

      expect(html, `authenticated=${isAuthenticated}`).not.toContain("award-row-actions");
      expect(html, `authenticated=${isAuthenticated}`).not.toContain("Public page");
      expect(html, `authenticated=${isAuthenticated}`).not.toContain("Manage in dashboard");
      expect(html, `authenticated=${isAuthenticated}`).not.toContain("lucide-layout-dashboard");
      expect(html, `authenticated=${isAuthenticated}`).not.toContain("lucide-external-link");
      expect(html, `authenticated=${isAuthenticated}`).not.toContain(dashboardPath);
      // One link per listed award, nothing else pointing at the award page.
      expect(html.split('href="/goldwater-scholarship"'), `authenticated=${isAuthenticated}`).toHaveLength(2);
    }
  });

  it("routes through one auth-free helper at both call sites", () => {
    expect(awardDirectoryHref(goldwater)).toBe("/goldwater-scholarship");
    expect(awardDirectoryHref(truman)).toBe("/truman-scholarship");
    expect(awardDirectoryHref.length).toBe(1);

    const source = readFileSync(new URL("./award-discovery-workspace.tsx", import.meta.url), "utf8");
    expect(source.match(/href=\{awardDirectoryHref\(award\)\}/g)).toHaveLength(2);
    expect(source).not.toMatch(/isAuthenticated\s*\?/);
    expect(source).not.toContain("dashboardAwardPath");
  });

  it("keeps the search combobox and browse controls for both auth states", () => {
    for (const isAuthenticated of [false, true]) {
      const html = render(isAuthenticated);

      expect(html, `authenticated=${isAuthenticated}`).toContain(
        'id="award-directory-search" class="input input-with-leading-icon award-search-input" placeholder="Goldwater, Fulbright, NSF GRFP..." role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="award-search-results"',
      );
      expect(html, `authenticated=${isAuthenticated}`).toContain('aria-label="Alphabetical award pages"');
      expect(html, `authenticated=${isAuthenticated}`).toContain('aria-label="Browse all awards"');
      expect(html, `authenticated=${isAuthenticated}`).toContain("2 of 2 monitored awards match.");
    }
  });
});
