import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PublicAwardWorkspace } from "@/components/public-award-workspace";
import type { PublicAwardPageData } from "@/lib/public-award-pages";

// The award console header once used two grid tracks, `minmax(0, 1fr) auto`.
// The `auto` track is sized by the action links' own text, so it claimed its
// full width before the title track got anything. Once the outline column
// turns on at 721px there was not enough left: the title column measured
// nothing at all at 721px and about 20px at 768px, the award name wrapped
// onto eight lines across the buttons, and the kicker was cut mid-word. It
// did not depend on the award name — a one-word title collapsed identically.
//
// These assertions pin the shape of the fix rather than any one width: the
// header is a wrapping row, the title block asks for a readable minimum
// before the actions may share its row, and nothing was made to fit by
// shrinking or clipping text.

// globals.css is mostly CRLF; normalising here keeps the multi-line selectors
// below readable and the assertions independent of line endings.
const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8").replace(/\r\n/g, "\n");

/** The body of the first rule with exactly this selector. */
function rule(selector: string, source = css) {
  const body = source.split(`${selector} {`)[1]?.split("}")[0];
  expect(body, selector).toBeDefined();
  return body as string;
}

function measure(source: string, pattern: RegExp) {
  const match = source.match(pattern);
  expect(match, String(pattern)).not.toBeNull();
  return Number(match![1]);
}

// The one-column rules for this console, scoped the way the sibling suites
// scope them: the first 720px block after the panel's own grid area.
const compact = css.slice(css.indexOf("@media (max-width: 720px) {", css.indexOf("grid-area: panel;"))).split(/\n@media /)[0];

const HEADER = ".public-award-console-header";
const TITLE_BLOCK = `${HEADER} > :not(.public-award-console-actions)`;
const ACTIONS = ".public-award-console-actions";

describe("award console header layout", () => {
  it("is a wrapping row, so the actions can leave the title's line", () => {
    const header = rule(HEADER);

    expect(header).toContain("display: flex;");
    expect(header).toContain("flex-wrap: wrap;");
    expect(header).toContain("align-items: start;");
    // A track sized by the actions' own text is what starved the title.
    expect(header).not.toContain("grid-template-columns");
    expect(header).not.toContain("display: grid;");
  });

  it("guarantees the title a readable width before the actions may share its row", () => {
    const basis = measure(css, /> :not\(\.public-award-console-actions\) \{[^}]*flex: 1 1 ([\d.]+)rem;/);
    const outlineMax = measure(
      rule(".public-award-console"),
      /grid-template-columns: minmax\([\d.]+rem, ([\d.]+)rem\) minmax\(0, 1fr\);/,
    );

    // The award name and its summary share this column. Below roughly this
    // width the name runs to five lines or more, which is what the two-track
    // header produced; the actions wrap away instead.
    expect(basis).toBeGreaterThanOrEqual(24);
    // And the title is never asked to be narrower than the outline beside it.
    expect(basis).toBeGreaterThan(outlineMax);

    // A basis, not a floor: once the actions have wrapped away the title
    // still shrinks with the viewport instead of forcing a sideways scroll.
    expect(rule(TITLE_BLOCK)).toContain("min-width: 0;");
    expect(rule(TITLE_BLOCK)).not.toContain(`min-width: ${basis}`);
  });

  it("fixes the header without shrinking the outline column", () => {
    // Widening the title by narrowing the outline would trade one problem for
    // another; the console grid must be exactly what it was.
    expect(rule(".public-award-console")).toContain(
      "grid-template-columns: minmax(15.5rem, 17.5rem) minmax(0, 1fr);",
    );
    expect(rule(".public-award-console-collapsed")).toContain("grid-template-columns: 3.4rem minmax(0, 1fr);");
  });

  it("fixes the header without shrinking or clipping any text", () => {
    // The title keeps the type scale it had at every width.
    expect(rule(`${HEADER} h1`)).toContain("font-size: clamp(2rem, 3.8vw, 2.7rem);");
    expect(compact).toContain("font-size: clamp(1.28rem, 6.4vw, 1.62rem);");

    // Neither rule may hide the overflow it is supposed to prevent.
    for (const selector of [HEADER, TITLE_BLOCK]) {
      const body = rule(selector);
      expect(body, selector).not.toContain("overflow");
      expect(body, selector).not.toContain("text-overflow");
      expect(body, selector).not.toContain("line-clamp");
      expect(body, selector).not.toContain("white-space: nowrap");
    }
  });

  it("keeps both action links reachable when they wrap onto their own row", () => {
    // On a narrow row the two links stack rather than overflow sideways.
    expect(rule(ACTIONS)).toContain("flex-wrap: wrap;");
    expect(rule(`${ACTIONS} .button-primary,\n${ACTIONS} .button-secondary`)).toContain("min-height: 2.35rem;");
  });

  it("keeps the one-column layout the phone widths already had", () => {
    // `grid-template-columns` says nothing on a flex container, so the full
    // width the stretched buttons need now comes from the actions' own row.
    expect(/\.public-award-console-header\s*\{[^}]*grid-template-columns:/.test(compact)).toBe(false);

    const compactActions = rule(`${HEADER} > ${ACTIONS}`, compact);
    expect(compactActions).toContain("flex: 1 1 100%;");
    expect(rule(ACTIONS, compact)).toContain("justify-content: stretch;");
    // This class also belongs to the Official source action outside the header.
    expect(rule(ACTIONS, compact)).not.toContain("flex:");
    expect(rule(`${ACTIONS} .button-primary,\n  ${ACTIONS} .button-secondary`, compact)).toContain(
      "flex: 1 1 12rem;",
    );
  });

  it("matches the two direct children the title selector addresses", () => {
    const html = renderToStaticMarkup(createElement(PublicAwardWorkspace, { data: headerFixture() }));

    // The title block is addressed by exclusion, so the header must hold
    // exactly one actions element and open with the title block beside it.
    expect(html.match(/class="public-award-console-actions"/g)).toHaveLength(1);
    expect(html).toContain('<header class="public-award-console-header"><div>');
    expect(html).toContain("<h1>An Award Whose Name Runs Well Past One Line</h1>");
  });
});

function headerFixture(): PublicAwardPageData {
  const noFacts = {
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

  return {
    award: {
      id: "award-1",
      name: "An Award Whose Name Runs Well Past One Line",
      slug: "example-fellowship",
      official_homepage: "https://example.edu/fellowship",
      updated_at: "2026-06-26T12:00:00.000Z",
    },
    canonicalPath: "/example-fellowship",
    redirectPath: null,
    facts: { ...noFacts, overview: "A fellowship for testing." },
    metaDescription: "Example fellowship details.",
    officialHomepage: "https://example.edu/fellowship",
    lastCheckedAt: "2026-06-26T12:00:00.000Z",
    sources: [
      {
        id: "apply",
        sourceSlug: "apply",
        publicPath: "/example-fellowship/apply",
        title: "Application instructions",
        description: null,
        url: "https://example.edu/fellowship/apply",
        pageType: "application",
        lastCheckedAt: "2026-06-26T12:00:00.000Z",
        facts: { ...noFacts },
      },
    ],
    changes: [],
  };
}
