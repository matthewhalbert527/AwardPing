import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { load } from "cheerio";
import { describe, expect, it } from "vitest";
import { ChangeSummaryDisplay } from "./change-summary-display";
import { FIRST_OBSERVED_OFFICIAL_DOCUMENT_SUMMARY } from "@/lib/change-details";
import { PublicUpdateCard } from "./public-update-card";
import type { LiveUpdateItem } from "@/lib/live-updates";

describe("consistent reader summaries", () => {
  it("shows the retained description once without a repeated category badge", () => {
    const props = {
      summary: "Outdated fallback.",
      changeDetails: {
        reader_summary: "The application deadline moved from March 1 to March 15.",
        change_type: "deadline", before: "March 1", after: "March 15",
      },
    };
    const original = structuredClone(props);
    const $ = load(renderToStaticMarkup(createElement(ChangeSummaryDisplay, props)));
    expect($(".change-summary p")).toHaveLength(1);
    expect($("p").text()).toBe(props.changeDetails.reader_summary);
    expect($(".change-summary-label")).toHaveLength(0);
    expect($.text()).not.toContain("Outdated fallback");
    expect(props).toEqual(original);
  });

  it("allows an explicit label where the surrounding view has none", () => {
    const $ = load(renderToStaticMarkup(createElement(ChangeSummaryDisplay, {
      summary: "Applications now require two references.", showLabel: true,
    })));
    expect($(".change-summary-label")).toHaveLength(1);
  });

  it("never turns a first saved document into a publication announcement or arbitrary quote", () => {
    const $ = load(renderToStaticMarkup(createElement(ChangeSummaryDisplay, {
      summary: 'A document includes "Candidates must choose two courses."',
      changeDetails: {
        event_kind: "new_official_document",
        reader_summary: 'The document includes "Candidates must choose two courses."',
      },
    })));
    expect($("p").text()).toBe(FIRST_OBSERVED_OFFICIAL_DOCUMENT_SUMMARY);
    expect($.text()).not.toContain("choose two courses");
  });

  it("preserves factual qualifications instead of shortening by character clipping", () => {
    const summary = "Applicants may submit without a nomination only if their institution does not participate.";
    const $ = load(renderToStaticMarkup(createElement(ChangeSummaryDisplay, { summary, compact: true })));
    expect($("p").text()).toBe(summary);
  });

  it("uses concise presentation once while retaining both sides and conditions", () => {
    const $ = load(renderToStaticMarkup(createElement(ChangeSummaryDisplay, {
      summary: 'Applicant eligibility changed from “Applicants must be enrolled full-time.” to “Applicants may be enrolled part-time only if their institution approves.”.',
    })));
    expect($("p")).toHaveLength(1);
    expect($("p").text()).toBe("Eligibility — previously: Applicants must be enrolled full-time. Now: Applicants may be enrolled part-time only if their institution approves.");
    expect($.text()).not.toContain("Applicant eligibility changed from");
    expect($("h2,h3,h4")).toHaveLength(0);
  });
  it("renders all complete short fact pairs without losing month, audience or admission-stage qualifiers", () => {
    const pairs = [
      ["no later than August 31 of the year in which you wish to enroll.", "no later than August of the intended enrollment year."],
      ["International candidates can attend interviews online or in person.", "International candidates will be interviewed online."],
      ["Those who accept our offers will then be approved through an internal process at Peking University, and receive their official acceptance letters in the summer before enrollment.",
        "Candidates who accept our offers must complete internal procedures at Peking University before being pre-admitted. Final admission will be confirmed through the official Peking University acceptance letter, issued in the summer prior to enrollment."],
    ];
    const changeDetails = { reader_summary: "A short stored summary previously omitted the later admission condition.",
      generation_status: "generated", is_alert_worthy: true, quality_flags: [], confidence: "high", change_type: "requirements",
      before: pairs[0][0], after: pairs[0][1],
      structured_diff: { removed_text: pairs.map(pair => pair[0]), added_text: pairs.map(pair => pair[1]) },
      changed_facts: pairs.map(([before, after]) => ({ fact: "Application requirements", before, after,
        removed_text: before, added_text: after, visual_evidence: null })) };
    const original = structuredClone(changeDetails);
    const $ = load(renderToStaticMarkup(createElement(ChangeSummaryDisplay, { summary: null, changeDetails, compact: true })));
    expect($(".change-summary p")).toHaveLength(3);
    const paragraphs = $("p").map((_i, node) => $(node).text()).get();
    expect(paragraphs).toEqual(pairs.map(([before, after]) => `Award information — previously: ${before} Now: ${after}`));
    expect(paragraphs[0].split("Now: ")[1]).not.toContain("August 31");
    expect(paragraphs[1]).toContain("International candidates will be interviewed online.");
    expect(paragraphs[2]).toContain("before being pre-admitted. Final admission will be confirmed through the official Peking University acceptance letter, issued in the summer prior to enrollment.");
    expect(changeDetails).toEqual(original);
  });
  it("shows an honest unavailable summary beside the real official-source link, never a promised full comparison", () => {
    const update: LiveUpdateItem = { id: "synthetic-change", awardId: "synthetic-award", awardName: "Yenching Academy", awardSlug: "yenching-academy",
      sourceId: "synthetic-source", sourceTitle: "Frequently Asked Questions", sourcePageType: "faq",
      sourceUrl: "https://yenchingacademy.pku.edu.cn/ADMISSIONS/Frequently_Asked_Questions.htm",
      summary: "Applicants must complete all listed requirements. ".repeat(40),
      changeDetails: { reader_summary: "Applicants must complete all listed requirements. ".repeat(40) },
      detectedAt: "2026-10-18T15:54:48.294Z", detectedDateTime: "2026-10-18T15:54:48.294Z",
      detectedLabel: "Oct 18", detectedTitle: "Oct 18, 2026", changeTypeLabel: "Update" };
    const original = structuredClone(update), $ = load(renderToStaticMarkup(createElement(PublicUpdateCard, { update })));
    expect($(".change-summary p")).toHaveLength(1);
    expect($(".change-summary").text()).toBe("A complete concise summary is unavailable. Review the official source.");
    expect($(".public-live-update-source-link").text()).toBe("Official source");
    expect($(".public-live-update-source-link").attr("href")).toBe(update.sourceUrl);
    expect($(".public-live-update-source-link").attr("target")).toBe("_blank");
    expect($.text()).not.toMatch(/complete comparison|all (?:four|4) facts (?:shown|available)|Applicants must complete/);
    expect(update).toEqual(original);
  });
  it("renders complete source qualifiers, B1/B2/H1B codes and meaningful read-duration/URL text literally", () => {
    const pairs = [
      ["Applicants with H1B status must complete the original 5 min read at https://example.edu/B1?route=old before applying.",
        "Applicants with H1B status must complete the revised 5 min read at https://example.edu/B2?route=new before applying."],
      ["Applicants must hold a B1 language certificate.", "Applicants must hold a B2 language certificate."],
    ];
    const changeDetails = { reader_summary: "The source revised its application requirements.", generation_status: "generated", is_alert_worthy: true,
      quality_flags: [], confidence: "high", change_type: "requirements", before: pairs[0][0], after: pairs[0][1],
      structured_diff: { removed_text: pairs.map(pair => pair[0]), added_text: pairs.map(pair => pair[1]) },
      changed_facts: pairs.map(([before, after]) => ({ fact: "Application requirements", before, after, removed_text: before, added_text: after, visual_evidence: null })) };
    const original = structuredClone(changeDetails);
    const $ = load(renderToStaticMarkup(createElement(ChangeSummaryDisplay, { summary: null, changeDetails, compact: true })));
    expect($("p").map((_i, node) => $(node).text()).get()).toEqual(pairs.map(([before, after]) => `Award information — previously: ${before} Now: ${after}`));
    expect($.text()).toContain("H1B"); expect($.text()).toContain("5 min read"); expect($.text()).toContain("https://example.edu/B2?route=new");
    expect($.text()).not.toMatch(/\bB [12]\b|\bH 1 B\b/); expect(changeDetails).toEqual(original);
  });
});
