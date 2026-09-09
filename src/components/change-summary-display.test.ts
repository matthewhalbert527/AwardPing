import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { load } from "cheerio";
import { describe, expect, it } from "vitest";
import { ChangeSummaryDisplay } from "./change-summary-display";
import { FIRST_OBSERVED_OFFICIAL_DOCUMENT_SUMMARY } from "@/lib/change-details";

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
});
