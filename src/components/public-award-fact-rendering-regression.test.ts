import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { load } from "cheerio";
import { describe, expect, it } from "vitest";
import { AwardFactsPanel, PublicAwardWorkspace } from "@/components/public-award-workspace";
import { publicAwardFactsFromAward } from "@/lib/public-award-facts";
import type { PublicAwardPageData } from "@/lib/public-award-pages";

function pageData(facts: PublicAwardPageData["facts"]): PublicAwardPageData {
  return {
    award: { id: "criterion-fixture", name: "Example Award", slug: "example-award", official_homepage: "https://example.edu/award", updated_at: "2026-09-09T00:00:00Z" },
    canonicalPath: "/example-award", redirectPath: null, facts,
    metaDescription: "Synthetic rendering fixture, not a published award.",
    officialHomepage: "https://example.edu/award", lastCheckedAt: null,
    sources: [], changes: [],
  };
}

function overview(facts: PublicAwardPageData["facts"]) {
  return renderToStaticMarkup(createElement(PublicAwardWorkspace, { data: pageData(facts) }));
}

function values(markup: string, label: string) {
  const $ = load(markup);
  const row = $(".public-award-key-fact, .public-award-fact-line")
    .filter((_index, element) => $(element).children("dt").text() === label);
  expect(row, `One ${label} row`).toHaveLength(1);
  const dd = row.children("dd");
  const items = dd.children("ul").children("li");
  return items.length ? items.map((_index, item) => $(item).text()).get() : [dd.text()];
}

describe("normalized fact boundaries in the main overview", () => {
  const fields = [
    ["academic_levels", "Academic level"], ["disciplines", "Discipline"],
    ["citizenship", "Citizenship"], ["eligibility", "Eligibility"],
    ["requirements", "Requirements"], ["application_materials", "Application materials"],
    ["how_to_apply", "How to apply"], ["documents", "Documents"], ["contacts", "Contact"],
  ] as const;

  it.each(fields)("keeps the original %s item and its qualification together", (field, label) => {
    // Synthetic strings exercise rendering boundaries, not eligibility meaning.
    const compound = "Primary requirement; an exception applies only after approval.";
    const sibling = "A separate condition remains separate.";
    for (const items of [[compound], [compound, sibling]]) {
      const publicFacts = { [field]: items };
      const facts = publicAwardFactsFromAward({ publicFacts });
      const before = structuredClone({ publicFacts, facts });
      const markup = overview(facts);
      expect(values(markup, label)).toEqual(items);
      expect({ publicFacts, facts }).toEqual(before);
    }
  });

  it("renders funding components already separated by the normalizer", () => {
    const facts = publicAwardFactsFromAward({ publicFacts: { award_amounts: ["Full tuition; Living stipend"] } });
    expect(facts.awardAmount).toEqual(["Full tuition", "Living stipend"]);
    const markup = overview(facts);
    expect(values(markup, "Award amount")).toEqual(["Full tuition", "Living stipend"]);
    expect(load(markup)(".public-award-key-facts li")).toHaveLength(2);
  });

  it.each(["overview", "dates"] as const)("keeps normalized important-date item boundaries in %s", (surface) => {
    const facts = publicAwardFactsFromAward({ publicFacts: {
      important_dates: ["Interviews: March 1, 2027; Decisions: April 1, 2027"],
    } });
    expect(facts.importantDates).toEqual(["Interviews: March 1, 2027", "Decisions: April 1, 2027"]);
    const markup = surface === "overview" ? overview(facts) : renderToStaticMarkup(createElement(AwardFactsPanel, {
      facts, section: "dates", onViewSources: () => {},
    }));
    expect(values(markup, "Important dates")).toEqual(facts.importantDates);
  });

  it.each(["overview", "eligibility"] as const)("ignores blank direct array entries without changing nonempty wording in %s", (surface) => {
    for (const citizenship of [["", "  "], ["", "A condition; its exception.", "  ", "Another condition."]]) {
      // Direct inputs exercise the renderer guard, independently of the
      // normalizer which already removes these blanks in production.
      const facts = { ...publicAwardFactsFromAward({}), citizenship };
      const before = structuredClone(facts);
      const markup = surface === "overview" ? overview(facts) : renderToStaticMarkup(createElement(AwardFactsPanel, {
        facts, section: "eligibility", onViewSources: () => {},
      }));
      const $ = load(markup);
      if (citizenship.length === 2) {
        expect($("dt").filter((_index, node) => $(node).text() === "Citizenship")).toHaveLength(0);
      } else {
        expect(values(markup, "Citizenship")).toEqual(["A condition; its exception.", "Another condition."]);
      }
      expect(facts).toEqual(before);
      expect($("li").filter((_index, node) => $(node).text().trim() === "")).toHaveLength(0);
    }
  });
});
