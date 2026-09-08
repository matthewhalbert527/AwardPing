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
    expect(anonymous).toContain('<button class="award-search-clear" type="button">');
    expect(searchOptionHrefs(anonymous)).toEqual([]);
    expect(anonymous).not.toContain("award-search-option");
    expectNativeSearchSemantics(anonymous);
    expect(anonymous).not.toContain("aria-expanded");
    expect(browseRowHrefs(anonymous)).toEqual([]);
  });

  it("returns focus to the search field before clearing, so Clear never drops focus to the document", () => {
    // There is no DOM in this test environment, so focus movement itself is
    // checked in a browser. What is pinned here is the contract that makes it
    // deterministic: the field is focused first, so its synchronous onFocus,
    // which still sees the old query, is queued before the resets.
    const source = readFileSync(new URL("./award-discovery-workspace.tsx", import.meta.url), "utf8");
    const start = source.indexOf('className="award-search-clear"');
    const handler = source.slice(start, source.indexOf("</button>", start));

    expect(source.match(/useRef<HTMLInputElement>\(null\)/g)).toHaveLength(1);
    expect(source).toContain("ref={searchInputRef}");
    expect(handler).toMatch(
      /onClick=\{\(\) => \{[\s\S]*?searchInputRef\.current\?\.focus\(\);\s*setQuery\(""\);\s*setSearchOpen\(false\);\s*\}\}/,
    );
    // Search Clear and filter reset both restore this stable field's focus.
    expect(source.match(/searchInputRef\.current\?\.focus\(\)/g)).toHaveLength(2);
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

function renderRows(rows: SharedAwardCard[], presets: unknown[] = [], isAuthenticated = false) {
  searchState.presets = [...presets];
  try {
    const html = renderToStaticMarkup(
      createElement(AwardDiscoveryWorkspace, {
        canManage: isAuthenticated,
        isAuthenticated,
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

// Five awards under "G", listed alphabetically: an old date, no deadline, a
// blank deadline, a current date, and free text.
const gaither = directoryRow({
  id: "7007882c-af99-4919-ad2c-2672ffcccfaf",
  name: "Gaither Junior Fellows Program",
  publicPath: "/james-c-gaither-junior-fellows-program",
  changeCount: 0,
});
const deadlineRows: SharedAwardCard[] = [
  { ...gaither, deadline: "January 15, 2019" },
  { ...gates, deadline: null },
  { ...gilman, deadline: "" },
  { ...goldwaterRow, deadline: "January 29, 2026" },
  {
    ...directoryRow({
      id: "1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b",
      name: "Graduate Rolling Award",
      publicPath: "/graduate-rolling-award",
      changeCount: 0,
    }),
    deadline: "Rolling; check the official page",
  },
];
// Same state slots as above; only the deadline filter is changed from its default.
const DEADLINE_LISTED_PRESETS: unknown[] = ["", false, true, "A", 30, 0, "all", "all", "all", "listed", "all"];
const DEADLINE_MISSING_PRESETS: unknown[] = ["", false, true, "A", 30, 0, "all", "all", "all", "missing", "all"];

function deadlineCells(html: string) {
  return [...html.matchAll(/<div class="award-row-deadline"><span>Deadline<\/span><strong>([^<]*)<\/strong><\/div>/g)].map(
    (match) => match[1],
  );
}

describe("AwardDiscoveryWorkspace deadline wording", () => {
  it("says Not listed for a missing or blank deadline and renders listed deadlines verbatim", () => {
    const html = renderRows(deadlineRows);

    expect(browseRowHrefs(html)).toEqual([
      "/james-c-gaither-junior-fellows-program",
      "/gates-cambridge-scholarship",
      "/gilman-international-scholarship",
      "/goldwater-scholarship",
      "/graduate-rolling-award",
    ]);
    expect(deadlineCells(html)).toEqual([
      "January 15, 2019",
      "Not listed",
      "Not listed",
      "January 29, 2026",
      "Rolling; check the official page",
    ]);
    // Nothing is inferred about timing: no pending, upcoming or closed wording.
    expect(html).not.toContain("<strong>Pending</strong>");
    expect(html).not.toContain("Deadline pending");
    expect(html).not.toMatch(/upcoming|closed|past due|expired/i);
  });

  it("labels the Boren program separately from its deadline on the directory card", () => {
    const row = { ...goldwater, name: "Boren Scholarships and Fellowships", deadline: "January 27, 2027 (Boren Scholarships)" };
    const before = JSON.stringify(row);
    const html = renderRows([row]);
    expect(html).toContain('<span>Scholarships deadline</span><strong>January 27, 2027</strong>');
    expect(html).not.toContain("(Boren Scholarships)");
    expect(JSON.stringify(row)).toBe(before);
  });

  it("renders a raw machine deadline in the house style without touching the filter", () => {
    const rows = [
      { ...gaither, deadline: "2026-03-27T17:00:00-05:00" },
      { ...gates, deadline: "Last Friday in January, 5:00 p.m. Central Time" },
      { ...gilman, deadline: "2026-03-27" },
      { ...goldwaterRow, deadline: "2026-02-30" },
    ];

    const html = renderRows(rows);

    expect(deadlineCells(html)).toEqual([
      "March 27, 2026 at 5:00 p.m. (UTC-05:00)",
      "Last Friday in January, 5:00 p.m. Central Time",
      "March 27, 2026",
      // An impossible date is shown as stored, never rolled into March 2.
      "2026-02-30",
    ]);
    expect(html).not.toContain("T17:00:00");
    // Formatting is display only: every row still counts as having a listed
    // deadline, so the filter partitions them exactly as before.
    const matchCount = (markup: string) => markup.match(/\d+ of \d+ monitored awards match/)?.[0];
    expect(matchCount(html)).toBe("4 of 4 monitored awards match");
    expect(matchCount(renderRows(rows, DEADLINE_LISTED_PRESETS))).toBe("4 of 4 monitored awards match");
    // None is "not listed", so the missing filter leaves nothing to browse.
    expect(browseRowHrefs(renderRows(rows, DEADLINE_MISSING_PRESETS))).toEqual([]);
  });

  it("labels the deadline filter by what the data establishes and keeps its behavior in both auth states", () => {
    const unfiltered = renderRows(deadlineRows);
    expect(unfiltered).toContain(
      '<option value="all" selected="">Any deadline</option><option value="listed">Deadline listed</option><option value="missing">Deadline not listed</option>',
    );
    expect(unfiltered).toContain("5 of 5 monitored awards match.");

    const listed = renderRows(deadlineRows, DEADLINE_LISTED_PRESETS);
    expect(listed).toContain('<option value="listed" selected="">Deadline listed</option>');
    expect(listed).toContain("3 of 5 monitored awards match.");
    expect(browseRowHrefs(listed)).toEqual([
      "/james-c-gaither-junior-fellows-program",
      "/goldwater-scholarship",
      "/graduate-rolling-award",
    ]);
    expect(deadlineCells(listed)).not.toContain("Not listed");

    const missing = renderRows(deadlineRows, DEADLINE_MISSING_PRESETS);
    expect(missing).toContain('<option value="missing" selected="">Deadline not listed</option>');
    expect(missing).toContain("2 of 5 monitored awards match.");
    expect(browseRowHrefs(missing)).toEqual(["/gates-cambridge-scholarship", "/gilman-international-scholarship"]);
    expect(deadlineCells(missing)).toEqual(["Not listed", "Not listed"]);

    // Sign-in state changes neither the wording nor the filtering.
    expect(renderRows(deadlineRows, DEADLINE_MISSING_PRESETS, true)).toBe(missing);
    expect(renderRows(deadlineRows, DEADLINE_LISTED_PRESETS, true)).toBe(listed);
  });
});

// Fictional catalog rows for size boundaries. Zero-padded numbers keep the
// alphabetical order equal to the numeric order, and every generated name
// starts with "F" unless a test overrides it.
function fictionalRow(index: number, overrides: Partial<SharedAwardCard> = {}): SharedAwardCard {
  const number = String(index).padStart(3, "0");
  return {
    ...directoryRow({
      id: `f1c71000-0000-4000-8000-${number.padStart(12, "0")}`,
      name: `Fictional Award ${number}`,
      publicPath: `/fictional-award-${number}`,
      changeCount: 0,
    }),
    ...overrides,
  };
}

function fictionalRows(count: number) {
  return Array.from({ length: count }, (_, index) => fictionalRow(index + 1));
}

function fictionalHrefs(from: number, to: number) {
  return Array.from({ length: to - from + 1 }, (_, index) => `/fictional-award-${String(from + index).padStart(3, "0")}`);
}

// Browse presets in state-slot order: query, results open, browse open,
// letter, page size, page index, then the academic level filter. Later
// filters keep their defaults. These preset the derived render only; they do
// not exercise the click handlers themselves.
function browsePresets({ letter = "A", pageSize = 30, pageIndex = 0, level = "all" } = {}): unknown[] {
  return ["", false, true, letter, pageSize, pageIndex, level];
}

// The "Showing a-b of n awards under X." line renders above and below the list.
function showingLines(html: string) {
  return [...html.matchAll(/Showing \d+-\d+ of \d+ awards under [A-Z#]\./g)].map((match) => match[0]);
}

function pager(html: string) {
  const previous = html.match(
    /<button class="button-secondary px-3 py-3" type="button"( disabled="")?><svg[^>]*>[\s\S]*?<\/svg>Previous<\/button>/,
  );
  const next = html.match(/<button class="button-secondary px-3 py-3" type="button"( disabled="")?>Next<svg/);
  if (!previous || !next) throw new Error("pager buttons missing");
  return { previousDisabled: previous[1] === ' disabled=""', nextDisabled: next[1] === ' disabled=""' };
}

function alphaButton(html: string, letter: string) {
  const match = html.match(
    new RegExp(
      `<button class="award-alpha-letter ?(award-alpha-letter-active)?"( disabled="")? type="button" aria-pressed="(true|false)">${letter}</button>`,
    ),
  );
  if (!match) throw new Error(`letter button ${letter} missing`);
  return { active: Boolean(match[1]), disabled: match[2] === ' disabled=""', pressed: match[3] === "true" };
}

describe("AwardDiscoveryWorkspace large catalogs (fictional rows)", () => {
  it("keeps the letter boxes with a clear hover treatment and hand cursor", () => {
    const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
    const rule = (selector: string) => css.split(`${selector} {`)[1]?.split("}")[0] ?? "";

    expect(rule(".award-alpha-letter")).toContain("cursor: pointer;");
    expect(rule(".award-alpha-letter")).toContain("border: 1px solid var(--border);");
    expect(rule(".award-alpha-letter:hover:not(:disabled)")).toContain("background: var(--accent);");
    expect(rule(".award-alpha-letter:hover:not(:disabled)")).toContain("color: var(--accent-contrast);");
    expect(rule(".award-alpha-letter:disabled")).toContain("cursor: default;");
    expect(rule(".award-alpha-letter:focus-visible")).toContain("outline: 2px solid var(--accent);");

    const html = renderRows(fictionalRows(2));
    expect(alphaButton(html, "F")).toEqual({ active: true, disabled: false, pressed: true });
    expect(alphaButton(html, "A")).toEqual({ active: false, disabled: true, pressed: false });
  });

  it("pages 31 same-letter awards as 30 then 1 at page size 30, with exact links, counts and pager states", () => {
    const rows = fictionalRows(31);

    const first = renderRows(rows);
    expect(first).toContain("31 of 31 monitored awards match.");
    expect(browseRowHrefs(first)).toEqual(fictionalHrefs(1, 30));
    expect(showingLines(first)).toEqual(["Showing 1-30 of 31 awards under F.", "Showing 1-30 of 31 awards under F."]);
    expect(pager(first)).toEqual({ previousDisabled: true, nextDisabled: false });
    expect(alphaButton(first, "F")).toEqual({ active: true, disabled: false, pressed: true });
    expect(alphaButton(first, "A")).toEqual({ active: false, disabled: true, pressed: false });

    const second = renderRows(rows, browsePresets({ letter: "F", pageIndex: 1 }));
    expect(browseRowHrefs(second)).toEqual(["/fictional-award-031"]);
    expect(showingLines(second)).toEqual(["Showing 31-31 of 31 awards under F.", "Showing 31-31 of 31 awards under F."]);
    expect(pager(second)).toEqual({ previousDisabled: false, nextDisabled: true });

    // A stale page index past the end clamps to the last page, never to nothing.
    const clamped = renderRows(rows, browsePresets({ letter: "F", pageIndex: 7 }));
    expect(browseRowHrefs(clamped)).toEqual(["/fictional-award-031"]);
    expect(pager(clamped)).toEqual({ previousDisabled: false, nextDisabled: true });
  });

  it("pages 101 same-letter awards as 100 then 1 at page size 100", () => {
    const rows = fictionalRows(101);

    const first = renderRows(rows, browsePresets({ letter: "F", pageSize: 100 }));
    expect(first).toContain("101 of 101 monitored awards match.");
    expect(first).toContain('<option value="100" selected="">100</option>');
    expect(browseRowHrefs(first)).toEqual(fictionalHrefs(1, 100));
    expect(showingLines(first)).toEqual(["Showing 1-100 of 101 awards under F.", "Showing 1-100 of 101 awards under F."]);
    expect(pager(first)).toEqual({ previousDisabled: true, nextDisabled: false });

    const second = renderRows(rows, browsePresets({ letter: "F", pageSize: 100, pageIndex: 1 }));
    expect(browseRowHrefs(second)).toEqual(["/fictional-award-101"]);
    expect(showingLines(second)).toEqual(["Showing 101-101 of 101 awards under F.", "Showing 101-101 of 101 awards under F."]);
    expect(pager(second)).toEqual({ previousDisabled: false, nextDisabled: true });
  });

  it("falls back to the first remaining letter when a filter removes the selected letter", () => {
    const rows = [
      ...fictionalRows(3).map((row) => ({ ...row, academicLevels: ["Graduate"] })),
      fictionalRow(4, { name: "Mock Fellowship 004", publicPath: "/mock-fellowship-004", academicLevels: ["Undergraduate"] }),
      fictionalRow(5, { name: "Mock Fellowship 005", publicPath: "/mock-fellowship-005", academicLevels: ["Undergraduate"] }),
      fictionalRow(6, { name: "Zeta Fictional Prize", publicPath: "/zeta-fictional-prize", academicLevels: ["Undergraduate"] }),
    ];

    const html = renderRows(rows, browsePresets({ letter: "F", level: "Undergraduate" }));

    expect(html).toContain("3 of 6 monitored awards match.");
    expect(browseRowHrefs(html)).toEqual(["/mock-fellowship-004", "/mock-fellowship-005"]);
    expect(showingLines(html)).toEqual(["Showing 1-2 of 2 awards under M.", "Showing 1-2 of 2 awards under M."]);
    expect(alphaButton(html, "F")).toEqual({ active: false, disabled: true, pressed: false });
    expect(alphaButton(html, "M")).toEqual({ active: true, disabled: false, pressed: true });
    expect(alphaButton(html, "Z")).toEqual({ active: false, disabled: false, pressed: false });
    expect(pager(html)).toEqual({ previousDisabled: true, nextDisabled: true });
  });

  it("clamps a stale second page to the only remaining page when a filter shrinks the letter", () => {
    const rows = fictionalRows(35).map((row, index) => ({
      ...row,
      academicLevels: [index === 34 ? "Undergraduate" : "Graduate"],
    }));

    const graduate = renderRows(rows, browsePresets({ letter: "F", pageIndex: 1, level: "Graduate" }));
    expect(graduate).toContain("34 of 35 monitored awards match.");
    expect(browseRowHrefs(graduate)).toEqual(fictionalHrefs(31, 34));
    expect(showingLines(graduate)).toEqual(["Showing 31-34 of 34 awards under F.", "Showing 31-34 of 34 awards under F."]);
    expect(pager(graduate)).toEqual({ previousDisabled: false, nextDisabled: true });

    const undergraduate = renderRows(rows, browsePresets({ letter: "F", pageIndex: 1, level: "Undergraduate" }));
    expect(undergraduate).toContain("1 of 35 monitored awards match.");
    expect(browseRowHrefs(undergraduate)).toEqual(["/fictional-award-035"]);
    expect(showingLines(undergraduate)).toEqual(["Showing 1-1 of 1 awards under F.", "Showing 1-1 of 1 awards under F."]);
    expect(pager(undergraduate)).toEqual({ previousDisabled: true, nextDisabled: true });
  });

  it("lets search reach an award beyond the first page and beyond the open letter, at its canonical link", () => {
    const rows = [
      ...fictionalRows(30),
      fictionalRow(31, { name: "Fictional Award 031 Omega", publicPath: "/fictional-award-031" }),
      fictionalRow(32, { name: "Zeta Fictional Prize", publicPath: "/zeta-fictional-prize" }),
    ];

    const beyondPage = renderRows(rows, ["omega", true]);
    expect(beyondPage).toContain('<p role="status">1 matching award</p>');
    expect(searchOptionHrefs(beyondPage)).toEqual(["/fictional-award-031"]);

    const beyondLetter = renderRows(rows, ["zeta", true]);
    expect(searchOptionHrefs(beyondLetter)).toEqual(["/zeta-fictional-prize"]);
    // The browse list stays hidden while results are open.
    expect(browseRowHrefs(beyondLetter)).toEqual([]);
  });

  it("searches the whole catalog rather than the open letter or page, listing at most 100 while counting every match", () => {
    const rows = fictionalRows(101);

    const capped = renderRows(rows, ["fictional award", true]);
    expect(capped).toContain('<p role="status">Showing 100 of 101 matching awards</p>');
    expect(searchOptionHrefs(capped)).toEqual(fictionalHrefs(1, 100));
    expect(capped).not.toContain("/fictional-award-101");

    // Exactly the cap is not capped, and reads as before.
    const exact = renderRows(fictionalRows(100), ["fictional award", true]);
    expect(exact).toContain('<p role="status">100 matching awards</p>');
    expect(exact).not.toContain("Showing 100 of");
    expect(searchOptionHrefs(exact)).toEqual(fictionalHrefs(1, 100));

    // Totals are counted after the current filters, not before them.
    const filteredRows = rows.map((row, index) => ({
      ...row,
      academicLevels: [index === 100 ? "Undergraduate" : "Graduate"],
    }));
    const graduate = renderRows(filteredRows, ["fictional award", true, true, "A", 30, 0, "Graduate"]);
    expect(graduate).toContain('<p role="status">100 matching awards</p>');
    expect(searchOptionHrefs(graduate)).toEqual(fictionalHrefs(1, 100));
    const undergraduate = renderRows(filteredRows, ["fictional award", true, true, "A", 30, 0, "Undergraduate"]);
    expect(undergraduate).toContain('<p role="status">1 matching award</p>');
    expect(searchOptionHrefs(undergraduate)).toEqual(["/fictional-award-101"]);
  });
});
