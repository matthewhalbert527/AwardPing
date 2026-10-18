import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { load } from "cheerio";
import { describe, expect, it } from "vitest";
import { PublicAwardWorkspace } from "@/components/public-award-workspace";
import type { PublicAwardPageData } from "@/lib/public-award-pages";

type CssBlock = { header: string; body: string };

// Small test-only block reader: keep at-rule scopes and ignore braces inside
// strings/comments. Missing or unbalanced blocks fail instead of empty slices.
function cssBlocks(source: string): CssBlock[] {
  const blocks: CssBlock[] = [];
  let depth = 0;
  let start = 0;
  let opening = -1;
  let header = "";
  let quote = "";
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      if (end < 0) throw new Error("Unclosed CSS comment");
      index = end + 1;
      continue;
    }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (character === ";" && depth === 0) start = index + 1;
    if (character === "{") {
      if (depth === 0) {
        header = source.slice(start, index).replace(/\/\*[\s\S]*?\*\//g, "").trim();
        opening = index;
      }
      depth += 1;
    }
    if (character === "}") {
      depth -= 1;
      if (depth < 0) throw new Error("Unexpected closing CSS brace");
      if (depth === 0) {
        blocks.push({ header, body: source.slice(opening + 1, index) });
        start = index + 1;
      }
    }
  }
  if (depth !== 0 || quote) throw new Error("Unclosed CSS block or string");
  return blocks;
}

function flatten(blocks: CssBlock[]): CssBlock[] {
  return blocks.flatMap((block) => block.header.startsWith("@")
    ? [block, ...flatten(cssBlocks(block.body))] : [block]);
}
function normalize(value: string) { return value.replace(/\s+/g, " ").replace(/\s*>\s*/g, " > ").trim(); }
function hasSelector(block: CssBlock, selector: string) {
  return !block.header.startsWith("@") && block.header.split(",").some((item) => normalize(item) === normalize(selector));
}
function rule(blocks: CssBlock[], selector: string) {
  const found = blocks.filter((block) => hasSelector(block, selector));
  expect(found, `Exactly one scoped rule for ${selector}`).toHaveLength(1);
  return found[0];
}
function declarations(block: CssBlock) {
  return new Map(block.body.replace(/\/\*[\s\S]*?\*\//g, "").split(";").flatMap((entry) => {
    const colon = entry.indexOf(":");
    return colon < 0 ? [] : [[entry.slice(0, colon).trim(), normalize(entry.slice(colon + 1))]];
  }));
}

const roots = cssBlocks(readFileSync(new URL("../app/globals.css", import.meta.url), "utf8"));
const allBlocks = flatten(roots);
const factGrid = ".public-award-key-facts";
const directFact = ".public-award-key-facts > .public-award-key-fact";

describe("award key-facts scoped responsive layout", () => {
  it("makes only the key-facts dl the named inline-size query container", () => {
    const base = declarations(rule(roots, factGrid));
    if (base.has("container")) {
      expect(base.get("container")).toMatch(/^award-key-facts\s*\/\s*inline-size$/);
    } else {
      expect(base.get("container-name")).toBe("award-key-facts");
      expect(base.get("container-type")).toBe("inline-size");
    }
  });

  it("stacks exact direct fact children in a positive-rem named-container query", () => {
    const queries = allBlocks.filter((block) => /^@container\s+award-key-facts\b/.test(block.header));
    expect(queries, "The local key-facts query must exist").toHaveLength(1);
    // The browser comparison selected 48rem over 32rem for readable dates and
    // amounts. This pins that choice; it does not replace rendered-width QA.
    const threshold = queries[0].header.match(/^@container\s+award-key-facts\s*\((?:max-width\s*:\s*|width\s*<=\s*)(\d+(?:\.\d+)?)rem\)$/);
    expect(threshold, "Use an upper-bound rem query for available fact width").not.toBeNull();
    expect(Number(threshold![1])).toBe(48);
    const scoped = cssBlocks(queries[0].body);
    expect(scoped.map((block) => normalize(block.header)).sort()).toEqual([
      directFact, `${directFact}:first-child`,
    ].sort());
    const child = declarations(rule(scoped, directFact));
    expect(child.get("grid-column")?.replace(/\s/g, "")).toBe("1/-1");
    expect(child.get("border-left")).toBe("0");
    expect(child.get("border-top")).toBe("1px solid var(--border-subtle)");
    expect(declarations(rule(scoped, `${directFact}:first-child`)).get("border-top")).toBe("0");
  });

  it("preserves the wide three-column base and the 720px stacking fallback", () => {
    const base = declarations(rule(roots, factGrid));
    expect(base.get("display")).toBe("grid");
    expect(base.get("grid-template-columns")).toBe("repeat(3, minmax(0, 1fr))");
    expect(declarations(rule(roots, ".public-award-key-fact")).get("border-left"))
      .toBe("1px solid var(--border-subtle)");
    expect(declarations(rule(roots, ".public-award-key-fact:first-child")).get("border-left")).toBe("0");
    const mobileRules = allBlocks.filter((block) => /^@media\s*\(max-width:\s*720px\)$/.test(block.header))
      .flatMap((block) => cssBlocks(block.body));
    expect(declarations(rule(mobileRules, factGrid)).get("grid-template-columns")).toBe("1fr");
    const mobileFact = declarations(rule(mobileRules, ".public-award-key-fact"));
    expect(mobileFact.get("border-left")).toBe("0");
    expect(mobileFact.get("border-top")).toBe("1px solid var(--border-subtle)");
    expect(declarations(rule(mobileRules, ".public-award-key-fact:first-child")).get("border-top")).toBe("0");
  });

  it.each([
    ["one", `${factGrid}:where(:has(> .public-award-key-fact:only-child))`, "minmax(0, 1fr)"],
    ["two", `${factGrid}:where(:has(> .public-award-key-fact:nth-child(2):last-child))`, "repeat(2, minmax(0, 1fr))"],
  ])("uses only occupied columns for %s fact without outranking the mobile fallback", (_count, selector, columns) => {
    // :where keeps the override at one-class specificity. The later mobile
    // grid rule can still stack it; geometry is verified separately in a browser.
    const override = rule(roots, selector);
    expect([...declarations(override)]).toEqual([["grid-template-columns", columns]]);
    const mobileIndex = roots.findIndex((block) => /^@media\s*\(max-width:\s*720px\)$/.test(block.header)
      && cssBlocks(block.body).some((candidate) => hasSelector(candidate, factGrid)));
    expect(mobileIndex).toBeGreaterThan(roots.indexOf(override));
  });

  it("does not introduce container containment on the current modal ancestors", () => {
    for (const selector of [".public-award-console-panel", ".public-award-panel-stack"]) {
      const matches = allBlocks.filter((block) => hasSelector(block, selector));
      expect(matches.length, `${selector} must actually be checked`).toBeGreaterThan(0);
      for (const match of matches) {
        const values = declarations(match);
        expect([...values.keys()].filter((name) => /^(container|container-type|container-name)$/.test(name)))
          .toEqual([]);
      }
    }
  });
});

const factValues = [
  { key: "awardAmount", label: "Award amount", raw: ["$1,000", "Travel stipend"], text: "$1,000Travel stipend" },
  { key: "academicLevels", label: "Academic level", raw: ["Graduate students"], text: "Graduate students" },
  { key: "citizenship", label: "Citizenship", raw: ["US citizens; an exception applies only with prior approval."], text: "US citizens; an exception applies only with prior approval." },
] satisfies Array<{ key: "awardAmount" | "academicLevels" | "citizenship"; label: string; raw: string[]; text: string }>;

function pageData(mask: number): PublicAwardPageData {
  const facts: PublicAwardPageData["facts"] = {
    overview: null, deadline: null, openingDate: null, awardAmount: null,
    eligibility: [], requirements: [], applicationMaterials: [], howToApply: [], importantDates: [],
    documents: [], contacts: [], academicLevels: [], disciplines: [], citizenship: [], confidence: null,
  };
  factValues.forEach((fact, index) => { if (mask & (1 << index)) facts[fact.key] = fact.raw; });
  return {
    award: { id: "fictional-key-facts", name: "Fictional Fellowship", slug: "fictional-fellowship",
      official_homepage: "https://example.edu/fellowship", updated_at: "2026-09-08T00:00:00Z" },
    canonicalPath: "/fictional-fellowship", redirectPath: null, facts, metaDescription: "Layout fixture",
    officialHomepage: "https://example.edu/fellowship", lastCheckedAt: null, sources: [], changes: [],
  };
}

describe("award key-facts actual rendered content", () => {
  it.each(Array.from({ length: 8 }, (_, mask) => ({
    mask, labels: factValues.filter((_fact, index) => mask & (1 << index)).map((fact) => fact.label).join(" + ") || "no facts",
  })))("preserves $labels without changing facts or adding actions", ({ mask }) => {
    const data = pageData(mask);
    const before = structuredClone(data);
    const $ = load(renderToStaticMarkup(createElement(PublicAwardWorkspace, { data })));
    const expected = factValues.filter((_fact, index) => mask & (1 << index));
    const dl = $("dl.public-award-key-facts");
    expect(dl.length).toBe(expected.length ? 1 : 0);
    expect($(".public-award-key-facts").length).toBe(dl.length);
    expect(dl.children().length).toBe(expected.length);
    const children = dl.children(".public-award-key-fact");
    expect(children.length).toBe(expected.length);
    expect(children.map((_index, child) => $(child).children("dt").text()).get())
      .toEqual(expected.map((fact) => fact.label));
    expect(children.map((_index, child) => $(child).children("dd").text()).get())
      .toEqual(expected.map((fact) => fact.text));
    if (mask & 1) {
      expect(dl.find("dd > ul.public-award-fact-list > li").map((_index, item) => $(item).text()).get())
        .toEqual(["$1,000", "Travel stipend"]);
    } else expect(dl.find("li").length).toBe(0);
    expect(dl.find("a, button, input, select, textarea, summary, iframe, object, embed, [tabindex], [contenteditable], [role=button], [role=link]").length)
      .toBe(0);
    expect(data).toEqual(before);
  });

  it.each([
    ["awardAmount", "Award amount", "View funding details"],
    ["academicLevels", "Academic level", "View full criteria"],
    ["citizenship", "Citizenship", "View full criteria"],
  ] as const)("moves a long %s value to full details without showing a clipped prefix", (key, label, action) => {
    const qualification = "Applicants must meet every condition listed by the official award source. ".repeat(4) + "An exception is allowed only after written approval; no automatic waiver applies.";
    const data = pageData(0);
    data.facts[key] = [qualification];
    const before = structuredClone(data);
    const $ = load(renderToStaticMarkup(createElement(PublicAwardWorkspace, { data })));
    const row = $(".public-award-key-fact").filter((_index, element) => $(element).children("dt").text() === label);
    expect(row).toHaveLength(1);
    expect(row.find("button").text()).toBe(action + " ");
    expect(row.find("button").attr("type")).toBe("button");
    expect(row.text()).not.toContain("Applicants must meet");
    const full = load(renderToStaticMarkup(createElement(PublicAwardWorkspace, { data, initialSection: "applying" })));
    const detail = full(".public-award-fact-line").filter((_index, element) => full(element).children("dt").text() === label);
    expect(detail.children("dd").text()).toBe(qualification);
    expect(data).toEqual(before);
  });

  it("separates the deadline from compact key facts and honestly labels an elapsed listed date", () => {
    const data = pageData(7);
    data.facts.deadline = "2026-03-27T17:00:00-05:00";
    data.facts.openingDate = "2026-01-05";
    data.presentationAsOf = "2026-10-17T12:00:00Z";
    const $ = load(renderToStaticMarkup(createElement(PublicAwardWorkspace, { data })));
    expect($(".public-award-key-facts dt").map((_index, item) => $(item).text()).get())
      .toEqual(["Award amount", "Academic level", "Citizenship"]);
    expect($(".public-award-deadlines .public-award-deadline-list li")).toHaveLength(1);
    expect($(".public-award-deadlines").text()).toContain("March 27, 2026 at 5:00 p.m. (UTC-05:00)");
    expect($(".public-award-deadlines .public-award-past-date").text()).toBe("Date passed");
    expect($(".public-award-deadlines").text()).toContain("A later deadline is not confirmed here.");
    expect($(".public-award-deadlines").text()).not.toContain("Applications closed");
    expect($(".public-award-deadlines").text()).not.toContain("January 5");
  });

  it("shows applicant-specific application dates from the full schedule without dropping course conditions", () => {
    const data = pageData(0);
    data.facts.importantDates = [
      "October 14, 2026 (US citizens living in the US): Application deadline",
      "December 8, 2026 or January 6, 2027 (course-dependent; check the Course Directory): Application deadline",
      "April 1, 2027: Interviews",
    ];
    const before = structuredClone(data);
    const $ = load(renderToStaticMarkup(createElement(PublicAwardWorkspace, { data })));
    const deadline = $(".public-award-deadlines");
    expect(deadline.find("li")).toHaveLength(2);
    expect(deadline.text()).toContain("US citizens living in the US");
    expect(deadline.text()).toContain("December 8, 2026 or January 6, 2027");
    expect(deadline.text()).toContain("course-dependent; check the Course Directory");
    expect(deadline.text()).not.toContain("Interviews");
    expect(deadline.text()).not.toContain("No application deadline");
    expect(data).toEqual(before);
  });

  it("does not mistake an interview date for an application deadline", () => {
    const data = pageData(0);
    data.facts.importantDates = ["April 1, 2027: Interviews"];
    const $ = load(renderToStaticMarkup(createElement(PublicAwardWorkspace, { data })));
    expect($(".public-award-deadlines li")).toHaveLength(0);
    expect($(".public-award-deadlines").text()).toContain("No application deadline is recorded here. Check the official award site.");
  });
});
