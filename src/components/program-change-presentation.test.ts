import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { load } from "cheerio";
import { describe, expect, it } from "vitest";
import { ChangeSummaryDisplay } from "./change-summary-display";
import { PublicUpdateCard } from "./public-update-card";
import { SourcePageTree } from "./source-page-tree";
import type { LiveUpdateItem } from "@/lib/live-updates";

const summary = "The deadline moved from April 1 to April 15. Applicants must still submit all documents by 5 p.m. Eastern Time.";
const text = (value: string) => ({ block_id: "deadline", start_utf16: 0, end_utf16: value.length, text: value });
const details = {
  schema: "awardping.program-change.v1", event_kind: "program_details_changed", summary,
  program_changes: [{ field: "deadline", operation: "replace", summary: "The deadline moved from April 1 to April 15.",
    previous_quote: text("Submit all documents by April 1 at 5 p.m. Eastern Time."),
    current_quote: text("Submit all documents by April 15 at 5 p.m. Eastern Time.") }],
};
const update: LiveUpdateItem = {
  id: "change-1", awardId: "award-1", awardName: "Example Fellowship", awardSlug: "example-fellowship",
  sourceId: "source-1", sourceTitle: "Application deadlines", sourceUrl: "https://example.edu/apply",
  sourcePageType: "deadline", summary: "Legacy summary must not override the new program contract.",
  changeDetails: details, detectedAt: "2026-10-23T12:00:00Z", detectedDateTime: "2026-10-23T12:00:00Z",
  detectedLabel: "Oct 23", detectedTitle: "Oct 23, 2026, 7:00 AM CDT", changeTypeLabel: "Deadline",
};

describe("program-change presentation across reader surfaces", () => {
  it("uses the complete accepted description in home/feed cards and the shared summary component", () => {
    const before = structuredClone(update);
    const card = load(renderToStaticMarkup(createElement(PublicUpdateCard, { update })));
    const standalone = load(renderToStaticMarkup(createElement(ChangeSummaryDisplay, {
      summary: update.summary, changeDetails: details,
    })));
    expect(card(".change-summary").text()).toBe(summary);
    expect(standalone(".change-summary").text()).toBe(summary);
    expect(card(".public-live-update-time strong").text()).toBe("Deadline changed");
    expect(card("img, iframe, object, [role='dialog']")).toHaveLength(0);
    expect(card(".public-live-update-source-link").attr("href")).toBe(update.sourceUrl);
    expect(card(".public-live-update-detail-link").attr("href")).toBe("/example-fellowship?source=source-1&change=change-1");
    expect(update).toEqual(before);
  });

  it("shows only program wording and the publisher source in watchlist page details", () => {
    const $ = load(renderToStaticMarkup(createElement(SourcePageTree, {
      layout: "split",
      sources: [{ id: update.sourceId!, title: update.sourceTitle!, url: update.sourceUrl,
        pageType: "deadline", latestChanges: [{
          id: update.id, sourceTitle: update.sourceTitle, sourceUrl: update.sourceUrl,
          sourcePageType: "deadline", summary: update.summary, changeDetails: details, detectedAt: update.detectedAt,
        }] }],
    })));
    expect($(".change-summary").text()).toBe(summary);
    expect($(".program-change-wording > summary").text()).toBe("Exact wording");
    expect($(".program-change-wording").attr("open")).toBeUndefined();
    expect($("blockquote").map((_index, node) => $(node).text()).get()).toEqual([
      details.program_changes[0].previous_quote.text, details.program_changes[0].current_quote.text,
    ]);
    expect($(".change-evidence-source-link").attr("href")).toBe(update.sourceUrl);
    expect($("img, iframe, object, [role='dialog'], .source-snapshot-trigger")).toHaveLength(0);
    expect($.text()).not.toMatch(/View evidence|Open image|Open PDF|Loading screenshot|Legacy summary/);
  });
});
