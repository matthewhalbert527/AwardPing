import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { load } from "cheerio";
import { describe, expect, it } from "vitest";
import { PublicUpdateCard } from "@/components/public-update-card";
import { FIRST_OBSERVED_OFFICIAL_DOCUMENT_SUMMARY } from "@/lib/change-details";
import { changeSummaryPresentation } from "@/lib/change-summary";
import type { LiveUpdateItem } from "@/lib/live-updates";

function update(overrides: Partial<LiveUpdateItem> = {}): LiveUpdateItem {
  return {
    id: "change-fixture", awardId: "award-fixture", awardName: "Example Award", awardSlug: "example-award",
    sourceId: "source-fixture", sourceTitle: "Application instructions", sourceUrl: "https://example.edu/award/apply",
    sourcePageType: "application", summary: "Applications open on September 1, 2027, only for institutional nominees.",
    changeDetails: { change_type: "date", reader_summary: "Applications open on September 1, 2027, only for institutional nominees." },
    detectedAt: "2026-10-17T12:00:00Z", detectedDateTime: "2026-10-17T12:00:00Z",
    detectedLabel: "Oct 17", detectedTitle: "Oct 17, 2026, 7:00 AM CDT", changeTypeLabel: "Deadline",
    ...overrides,
  };
}

describe("consistent public update cards shared by home and global Updates", () => {
  it("uses the award-page presentation title and preserves non-PDF source attribution", () => {
    const item = update();
    const before = structuredClone(item);
    const $ = load(renderToStaticMarkup(createElement(PublicUpdateCard, { update: item })));
    const parts = changeSummaryPresentation(item.summary, item.sourceUrl, item.sourceTitle, item.changeDetails);
    expect($("h3 a").text()).toBe("Example Award");
    expect($(".public-live-update-time > strong").text()).toBe(parts.title);
    expect(parts.title).toBe("Application dates changed");
    expect($(".public-live-update-time").text()).not.toContain("Deadline");
    expect($(".public-live-update-source").text()).toBe("Application instructions");
    expect($(".change-summary").text()).toBe(parts.text);
    expect($(".change-summary")).toHaveLength(1);
    expect($(".change-summary-label, .badge")).toHaveLength(0);
    expect($("h3 a").attr("href")).toBe("/example-award?source=source-fixture&change=change-fixture");
    expect($(".public-live-update-detail-link").attr("href")).toBe($("h3 a").attr("href"));
    expect($(".public-live-update-source-link").attr("href")).toBe(item.sourceUrl);
    expect($(".public-live-update-source-link").attr("aria-label")).toBe("Official source: Application instructions");
    expect($(".public-live-update-source-link").attr("rel")).toBe("noreferrer");
    expect($("time").attr("datetime")).toBe(item.detectedAt);
    expect(item).toEqual(before);
  });

  it("shows the same concise cycle explanation without duplicating its body or dropping old years", () => {
    const summary = 'Applicant eligibility changed from “2026 Eligibility Requirements” to “2027 Eligibility Requirements”. Applicant-facing award information changed from “Be a college junior pursuing a bachelor’s degree during the 2025-2026 academic year.” to “Be a college junior pursuing a bachelor’s degree during the 2026-2027 academic year.”.';
    const item = update({ summary, changeTypeLabel: "Eligibility", changeDetails: { reader_summary: summary, change_type: "eligibility" } });
    const $ = load(renderToStaticMarkup(createElement(PublicUpdateCard, { update: item })));
    expect($(".public-live-update-time > strong").text()).toBe("Eligibility criteria updated for 2027");
    const paragraphs = $(".change-summary p").map((_index, node) => $(node).text()).get();
    expect(paragraphs).toEqual([
      "Eligibility criteria now cover 2027 (previously 2026).",
      "College juniors pursuing a bachelor’s degree: 2026–2027 academic year (previously 2025–2026).",
    ]);
    expect($.text()).not.toContain("Applicant eligibility changed from");
  });

  it("calls first-observed PDFs recorded documents, never new publications", () => {
    const item = update({
      sourceTitle: "2027 Candidate Guide", sourceUrl: "https://example.edu/guide.pdf", sourcePageType: "pdf",
      summary: "The publisher posted this new document today.", changeTypeLabel: "New official document",
      changeDetails: { event_kind: "new_official_document", reader_summary: "The publisher posted this new document today." },
    });
    const $ = load(renderToStaticMarkup(createElement(PublicUpdateCard, { update: item })));
    expect($(".public-live-update-time > strong").text()).toBe("Official document first recorded");
    expect($(".public-live-update-source").text()).toBe("2027 Candidate Guide");
    expect($(".change-summary").text()).toBe(FIRST_OBSERVED_OFFICIAL_DOCUMENT_SUMMARY);
    expect($.text()).not.toContain("New official document");
    expect($.text()).not.toContain("posted this new document today");
    expect($(".change-summary p")).toHaveLength(1);
  });

  it("omits neutral and exact body-duplicate headings instead of over-labelling", () => {
    for (const item of [
      update({ summary: "Applicants may participate only if the institution approves.", changeDetails: {} }),
      update({ summary: "Application dates changed.", changeDetails: { reader_summary: "Application dates changed.", change_type: "date" } }),
    ]) {
      const $ = load(renderToStaticMarkup(createElement(PublicUpdateCard, { update: item })));
      expect($(".public-live-update-time > strong")).toHaveLength(0);
      expect($(".change-summary").text()).toBe(item.summary);
      expect($(".public-live-update-source").text()).toBe(item.sourceTitle);
    }
  });

  it("preserves qualified fallback prose and an unreadable date without inventing a timestamp", () => {
    const summary = "Applicants may submit without a nomination only if their institution does not participate. This does not establish whether earlier applicants could do so.";
    const $ = load(renderToStaticMarkup(createElement(PublicUpdateCard, { update: update({
      summary, changeDetails: {}, detectedAt: "not-a-date", detectedDateTime: null,
      detectedLabel: "Date unavailable", detectedTitle: "Date unavailable",
    }) })));
    expect($(".change-summary").text()).toBe(summary);
    expect($("time")).toHaveLength(0);
    expect($(".public-live-update-time").text()).toBe("Date unavailable");
  });
});
