import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { load } from "cheerio";
import { describe, expect, it } from "vitest";
import { PublicAwardWorkspace } from "@/components/public-award-workspace";
import type { PublicAwardPageData } from "@/lib/public-award-pages";
import { stage1CohortIdentity } from "@/lib/stage1-cohort-identity";

// These are identity/template fixtures, NOT real award facts, a production
// crawl, source verification or proof that the 25 awards are ready to publish.
// Every identity receives the same deliberately EMPTY facts/sources/changes.
const sections = [
  { section: "overview", selection: "overview", title: "Overview", empty: "Award details are not available yet. Check the official sources before applying." },
  { section: "updates", selection: "changes", title: "Updates", empty: "No updates are available in this view yet." },
  { section: "applying", selection: "application", title: "Eligibility & applying", empty: "These details are not available yet. Check the official sources before applying." },
  { section: "sources", selection: "sources", title: "Sources", empty: "No official source pages are available for this award yet." },
] as const;

function emptyIdentityFixture(identity: typeof stage1CohortIdentity[number]): PublicAwardPageData {
  const [, , name, id, slug, homepage] = identity;
  return {
    award: { id, name, slug, official_homepage: homepage, updated_at: "2026-10-17T12:00:00Z" },
    canonicalPath: `/${slug}`,
    redirectPath: null,
    officialHomepage: homepage,
    metaDescription: "Synthetic empty-data template fixture; not factual award verification.",
    presentationAsOf: "2026-10-17T12:00:00Z",
    lastCheckedAt: null,
    facts: {
      overview: null, deadline: null, openingDate: null, awardAmount: null,
      eligibility: [], requirements: [], applicationMaterials: [], howToApply: [],
      importantDates: [], documents: [], contacts: [], academicLevels: [],
      disciplines: [], citizenship: [], confidence: null,
    },
    sources: [],
    changes: [],
  };
}

const cases = stage1CohortIdentity.flatMap((identity) => sections.map((section) => ({
  identity, name: identity[2], ...section,
})));

describe("all 25 identities × four sections: synthetic empty template coverage, not award factual verification", () => {
  it("covers exactly 25 unique canonical identities and 100 section states", () => {
    expect(stage1CohortIdentity).toHaveLength(25);
    expect(new Set(stage1CohortIdentity.map((identity) => identity[3])).size).toBe(25);
    expect(new Set(stage1CohortIdentity.map((identity) => identity[4])).size).toBe(25);
    expect(cases).toHaveLength(100);
  });

  it.each(cases)("renders $name / $section with consistent navigation and honest empty data", ({ identity, section, selection, title, empty }) => {
    const data = emptyIdentityFixture(identity);
    const before = structuredClone(data);
    const $ = load(renderToStaticMarkup(createElement(PublicAwardWorkspace, { data, initialSection: section })));

    expect($("h1")).toHaveLength(1);
    expect($("h1").text()).toBe(identity[2]);
    const official = $(".public-award-console-actions a");
    expect(official).toHaveLength(1);
    expect(official.text().trim()).toBe("Official award site");
    expect(official.attr("href")).toBe(identity[5]);
    expect(official.attr("target")).toBe("_blank");
    expect(official.attr("rel")).toContain("noreferrer");

    const buttons = $("nav[aria-label='Award sections'] > button");
    expect(buttons).toHaveLength(4);
    expect(buttons.map((_index, button) => $(button).attr("aria-label")).get())
      .toEqual(sections.map((item) => item.title));
    expect(buttons.filter("[aria-pressed='true']")).toHaveLength(1);
    expect(buttons.filter("[aria-pressed='false']")).toHaveLength(3);
    expect(buttons.filter("[aria-pressed='true']").attr("aria-label")).toBe(title);
    expect(buttons.filter("[type='button']")).toHaveLength(4);
    expect($("[role='checkbox'], input[type='checkbox']")).toHaveLength(0);

    const mobile = $(".public-award-mobile-navigation select");
    expect(mobile).toHaveLength(1);
    expect(mobile.find("option")).toHaveLength(4);
    expect(mobile.find("option[selected]")).toHaveLength(1);
    expect(mobile.find("option[selected]").attr("value")).toBe(selection);
    expect(mobile.find("option[selected]").text()).toBe(title);
    expect($(`label[for='${mobile.attr("id")}']`).text()).toBe("On this award");

    const panel = $(".public-award-console-panel[role='region']");
    expect(panel).toHaveLength(1);
    expect(panel.attr("tabindex")).toBe("-1");
    const headingId = panel.attr("aria-labelledby");
    expect(headingId).toBeTruthy();
    expect($(`[id='${headingId}']`)).toHaveLength(1);
    expect(panel.find(`h2[id='${headingId}']`).text()).toBe(title);
    expect(buttons.map((_index, button) => $(button).attr("aria-controls")).get())
      .toEqual(Array(4).fill(panel.attr("id")));
    expect(mobile.attr("aria-controls")).toBe(panel.attr("id"));

    const ids = $("[id]").map((_index, element) => $(element).attr("id")).get();
    expect(new Set(ids).size).toBe(ids.length);
    expect(panel.text()).toContain(empty);
    expect($(".public-award-key-facts, .public-award-fact-line, .public-award-change-line, .public-award-source-choice")).toHaveLength(0);
    expect($(".public-award-update-count, .public-award-past-date")).toHaveLength(0);
    if (section === "overview") {
      expect(panel.text()).toContain("No application deadline is recorded here. Check the official award site.");
      expect(panel.text()).toContain("No updates are available in this view yet. This does not confirm that the official pages have stayed unchanged.");
    }
    expect(data).toEqual(before);
  });
});
