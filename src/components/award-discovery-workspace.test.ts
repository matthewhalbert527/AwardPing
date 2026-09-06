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
  return [...html.matchAll(/<a class="award-search-option" href="([^"]*)">/g)].map((match) => match[1]);
}

// The search is a labeled native field whose results are ordinary links: no
// combobox, listbox, option or selection state is claimed anywhere.
function expectNativeSearchSemantics(html: string) {
  expect(html).toContain('<label class="sr-only" for="award-directory-search">Search awards</label>');
  expect(html).toContain(
    '<input id="award-directory-search" class="input input-with-leading-icon award-search-input" type="search" placeholder="Goldwater, Fulbright, NSF GRFP..."',
  );
  for (const claim of [
    'role="combobox"',
    'role="listbox"',
    'role="option"',
    "aria-selected",
    "aria-autocomplete",
    "aria-controls",
    "aria-activedescendant",
  ]) {
    expect(html).not.toContain(claim);
  }
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

    expect(anonymous).toContain('<p role="status">1 matching award</p>');
    expect(anonymous).toContain(
      '<div class="award-search-results"><a class="award-search-option" href="/goldwater-scholarship">',
    );
    expectNativeSearchSemantics(anonymous);
    // With results open, the browse disclosure is hidden, so no expanded state remains at all.
    expect(anonymous).not.toContain("aria-expanded");
    expect(searchOptionHrefs(anonymous)).toEqual(["/goldwater-scholarship"]);
    expect(searchOptionHrefs(signedIn)).toEqual(["/goldwater-scholarship"]);
    expect(signedIn).toBe(anonymous);
    expect(anonymous).toContain('<span class="award-search-option-title">Goldwater Scholarship</span>');
    expect(anonymous).not.toContain(dashboardPath);
    // The browse list is hidden while results are shown.
    expect(browseRowHrefs(anonymous)).toEqual([]);

    const broader = render(true, { search: "Scholarship" });
    expect(broader).toContain('<p role="status">2 matching awards</p>');
    expect(searchOptionHrefs(broader)).toEqual(["/goldwater-scholarship", "/truman-scholarship"]);
    expectNativeSearchSemantics(broader);
  });

  it("reports no matches as plain text, keeps the typed query, and claims no selection", () => {
    const anonymous = render(false, { search: "Zebra" });
    const signedIn = render(true, { search: "Zebra" });

    expect(signedIn).toBe(anonymous);
    expect(anonymous).toContain('<p role="status">No matches</p>');
    expect(anonymous).toContain('<p class="award-search-empty">No matching award yet.</p>');
    expect(anonymous).toContain('placeholder="Goldwater, Fulbright, NSF GRFP..." value="Zebra"/>');
    expect(searchOptionHrefs(anonymous)).toEqual([]);
    expect(anonymous).not.toContain("award-search-option");
    expectNativeSearchSemantics(anonymous);
    expect(anonymous).not.toContain("aria-expanded");
    expect(browseRowHrefs(anonymous)).toEqual([]);
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

  it("keeps a plain labeled search field and the browse controls for both auth states", () => {
    for (const isAuthenticated of [false, true]) {
      const html = render(isAuthenticated);

      expectNativeSearchSemantics(html);
      expect(html, `authenticated=${isAuthenticated}`).toContain(
        '<input id="award-directory-search" class="input input-with-leading-icon award-search-input" type="search" placeholder="Goldwater, Fulbright, NSF GRFP..." value=""/>',
      );
      // The only expanded/collapsed state left is the browse disclosure button.
      expect(html.split("aria-expanded="), `authenticated=${isAuthenticated}`).toHaveLength(2);
      expect(html, `authenticated=${isAuthenticated}`).toContain(
        '<button class="button-secondary" type="button" aria-expanded="true">',
      );
      expect(html, `authenticated=${isAuthenticated}`).toContain('aria-label="Alphabetical award pages"');
      expect(html, `authenticated=${isAuthenticated}`).toContain('aria-label="Browse all awards"');
      expect(html, `authenticated=${isAuthenticated}`).toContain("2 of 2 monitored awards match.");
    }
  });
});

// Production-shaped directory rows: the directory page supplies a recorded
// public update count for every award and never a source count.
function directoryRow(
  row: Pick<SharedAwardCard, "id" | "name" | "publicPath" | "changeCount">,
): SharedAwardCard {
  return {
    slug: null,
    officialHomepage: null,
    summary: null,
    deadline: null,
    academicLevels: [],
    disciplines: [],
    citizenship: [],
    lastCheckedAt: null,
    recentlyUpdated: (row.changeCount ?? 0) > 0,
    sourceCount: null,
    sourceIssueCount: null,
    tracked: false,
    detailsLoaded: false,
    sources: [],
    changes: [],
    ...row,
  };
}

// All three open the letter view on "G", listed alphabetically.
const gates = directoryRow({
  id: "9d3a5f4e-2b1c-4d8e-9f0a-1b2c3d4e5f60",
  name: "Gates Cambridge Scholarship",
  publicPath: "/gates-cambridge-scholarship",
  changeCount: 0,
});
const gilman = directoryRow({
  id: "0e4b6a5f-3c2d-4e9f-8a1b-2c3d4e5f6a71",
  name: "Gilman International Scholarship",
  publicPath: "/gilman-international-scholarship",
  changeCount: 1,
});
const goldwaterRow = directoryRow({
  id: goldwater.id,
  name: goldwater.name,
  publicPath: goldwater.publicPath,
  changeCount: 12,
});

// The component's state slots in declaration order: query, results open,
// browse open, letter, page size, page index, level, discipline, citizenship,
// deadline, updates. Only the last one is changed from its default here.
const UPDATES_FILTER_PRESETS: unknown[] = ["", false, true, "A", 30, 0, "all", "all", "all", "all", "recent"];

function renderRows(rows: SharedAwardCard[], presets: unknown[] = []) {
  searchState.presets = [...presets];
  try {
    const html = renderToStaticMarkup(
      createElement(AwardDiscoveryWorkspace, {
        canManage: false,
        isAuthenticated: false,
        sharedAwards: rows,
      }),
    );
    if (searchState.presets.length) {
      throw new Error(`${searchState.presets.length} state preset(s) were not consumed`);
    }
    return html;
  } finally {
    searchState.presets = [];
  }
}

// The first chip of each listed award's meta row, in listing order.
function statusChips(html: string) {
  return [...html.matchAll(/<div class="award-directory-row-meta"><span>([^<]*)<\/span>/g)].map(
    (match) => match[1],
  );
}

describe("AwardDiscoveryWorkspace update status", () => {
  it("states each award's recorded update count beside the source guidance when the source count is unknown", () => {
    const html = renderRows([gates, gilman, goldwaterRow]);

    expect(browseRowHrefs(html)).toEqual([
      "/gates-cambridge-scholarship",
      "/gilman-international-scholarship",
      "/goldwater-scholarship",
    ]);
    expect(statusChips(html)).toEqual([
      "0 recorded updates · Open to view source pages",
      "1 recorded update · Open to view source pages",
      "12 recorded updates · Open to view source pages",
    ]);
    // Nothing the directory does not know is claimed.
    expect(html).not.toContain("source page ·");
    expect(html).not.toContain("source pages ·");
    expect(html).not.toContain("Source search pending");
    expect(html).not.toContain("Recently updated");
    expect(html).not.toContain("Last checked");
  });

  it("states nothing about updates for a row that carries no recorded count", () => {
    const html = renderRows([{ ...gates, changeCount: null }]);

    expect(statusChips(html)).toEqual(["Open to view source pages"]);
    // No count is stated anywhere in the listing; the filter label is the
    // only place the phrase appears.
    expect(html).not.toMatch(/\d recorded update/);
  });

  it("keeps the wording for rows that do carry a source count", () => {
    const html = renderRows([
      { ...gates, sourceCount: 0, changeCount: 0 },
      { ...gilman, sourceCount: 1, changeCount: 1 },
      { ...goldwaterRow, sourceCount: 4, changeCount: 2 },
    ]);

    expect(statusChips(html)).toEqual([
      "Source search pending · 0 recorded updates",
      "1 source page · 1 recorded update",
      "4 source pages · 2 recorded updates",
    ]);
    expect(html).not.toContain("Open to view source pages");
  });

  it("labels the Updates filter by what it does and keeps what it does", () => {
    const rows = [gates, gilman, goldwaterRow];

    const unfiltered = renderRows(rows);
    expect(unfiltered).toContain(
      '<option value="all" selected="">All awards</option><option value="recent">Has recorded updates</option>',
    );
    expect(unfiltered).not.toContain("Recently updated");
    expect(unfiltered).toContain("3 of 3 monitored awards match.");

    const filtered = renderRows(rows, UPDATES_FILTER_PRESETS);
    expect(filtered).toContain(
      '<option value="all">All awards</option><option value="recent" selected="">Has recorded updates</option>',
    );
    expect(filtered).toContain("2 of 3 monitored awards match.");
    // Exactly the awards whose chips show a non-zero recorded count remain.
    expect(browseRowHrefs(filtered)).toEqual([
      "/gilman-international-scholarship",
      "/goldwater-scholarship",
    ]);
    expect(statusChips(filtered)).toEqual([
      "1 recorded update · Open to view source pages",
      "12 recorded updates · Open to view source pages",
    ]);
  });

  it("leaves search results without a status line while the source count is unknown", () => {
    const html = renderRows([gates, gilman, goldwaterRow], ["Scholarship", true]);

    expect(html).toContain("3 matching awards");
    expect(searchOptionHrefs(html)).toEqual([
      "/gates-cambridge-scholarship",
      "/gilman-international-scholarship",
      "/goldwater-scholarship",
    ]);
    expect(html).not.toContain("award-search-option-meta");
  });
});
