import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SourcePageTree } from "@/components/source-page-tree";

describe("SourcePageTree", () => {
  it("renders readable source titles and latest update dates in collapsed rows", () => {
    const html = renderToStaticMarkup(
      createElement(SourcePageTree, {
        sources: [
          {
            id: "home",
            title: "https://agbell.org/financial-aid/",
            url: "https://agbell.org/financial-aid/",
            pageType: "homepage",
            lastCheckedAt: "2026-05-27T19:44:12.000Z",
            latestChanges: [
              {
                id: "change-1",
                sourceTitle: "Financial Aid",
                sourceUrl: "https://agbell.org/financial-aid/",
                sourcePageType: "homepage",
                summary: "The Financial Aid page added application deadline wording.",
                detectedAt: "2026-05-28T20:00:00.000Z",
              },
            ],
          },
          {
            id: "root",
            title: "/",
            url: "https://agbell.org/",
            pageType: "other",
            lastCheckedAt: "2026-05-27T22:53:52.000Z",
            latestChanges: [],
          },
        ],
      }),
    );

    expect(html).toContain("Financial Aid");
    expect(html).toContain("Homepage");
    expect(html).toContain("Expand all");
    expect(html).toContain("Collapse all");
    expect(html).toContain("Latest update:");
    expect(html).toContain("None recorded");
    expect(html).not.toContain("https://agbell.org/financial-aid/</span>");
    expect(html).not.toContain("&gt;/&lt;");
  });

  it("renders a split outline with selected page details", () => {
    const html = renderToStaticMarkup(
      createElement(SourcePageTree, {
        layout: "split",
        sources: [
          {
            id: "eligibility",
            title: "Eligibility",
            displayTitle: "Eligibility",
            pageDescription: "Eligibility rules for the scholarship.",
            url: "https://example.edu/scholarship/eligibility",
            pageType: "eligibility",
            pageMetadataGeneratedAt: "2026-06-23T15:00:00.000Z",
            pageMetadataModel: "gemini-2.5-flash-lite",
            pageMetadata: {
              baseline_facts: {
                page_category: "Eligibility",
                award_relevance: "primary",
                deadline: "January 29, 2026",
                eligibility: ["Sophomores and juniors"],
                sections: [
                  {
                    title: "Citizenship",
                    description: "Applicants must meet citizenship requirements.",
                    status: "unchanged",
                  },
                ],
              },
            },
            latestChanges: [],
          },
        ],
      }),
    );

    expect(html).toContain("source-tree-split");
    expect(html).toContain("source-tree-detail-panel");
    expect(html).toContain("Eligibility rules for the scholarship.");
    expect(html).toContain("Citizenship");
    expect(html).toContain("January 29, 2026");
    expect(html).toContain("Page outline updated");
    expect(html).not.toContain("gemini-2.5-flash-lite");
  });

  it("starts split source branches collapsed while keeping the detail panel ready", () => {
    const html = renderToStaticMarkup(
      createElement(SourcePageTree, {
        layout: "split",
        sources: [
          {
            id: "citizenship",
            title: "Citizenship",
            displayTitle: "Citizenship",
            pageDescription: "Citizenship requirements.",
            url: "https://example.edu/scholarship/eligibility/citizenship",
            pageType: "other",
            pageMetadata: {
              baseline_facts: {
                page_category: "Eligibility",
                award_relevance: "primary",
              },
            },
            latestChanges: [],
          },
          {
            id: "standing",
            title: "Academic standing",
            displayTitle: "Academic standing",
            pageDescription: "Academic standing requirements.",
            url: "https://example.edu/scholarship/eligibility/standing",
            pageType: "other",
            pageMetadata: {
              baseline_facts: {
                page_category: "Eligibility",
                award_relevance: "primary",
              },
            },
            latestChanges: [],
          },
        ],
      }),
    );

    expect(html).toContain("source-tree-split");
    expect(html).toContain("aria-expanded=\"false\"");
    expect(html).toContain("Eligibility");
    expect(html).toContain("Academic standing requirements.");
    expect(html).not.toContain("Citizenship requirements.");
  });

  it("summarizes branch-level page status counts", () => {
    const html = renderToStaticMarkup(
      createElement(SourcePageTree, {
        layout: "split",
        sources: [
          {
            id: "deadline",
            title: "Deadline",
            displayTitle: "Deadline",
            url: "https://example.edu/scholarship/dates/deadline",
            pageType: "other",
            pageMetadata: {
              baseline_facts: {
                page_category: "Deadlines",
              },
            },
            latestChanges: [
              {
                id: "change-1",
                sourceTitle: "Deadline",
                sourceUrl: "https://example.edu/scholarship/dates/deadline",
                sourcePageType: "deadline",
                summary: "The campus deadline moved later.",
                detectedAt: "2026-06-23T15:00:00.000Z",
              },
            ],
          },
          {
            id: "calendar",
            title: "Calendar",
            displayTitle: "Calendar",
            url: "https://example.edu/scholarship/dates/calendar",
            pageType: "other",
            pageMetadata: {
              baseline_facts: {
                page_category: "Deadlines",
              },
            },
            lastError: "Capture timed out.",
            latestChanges: [],
          },
        ],
      }),
    );

    expect(html).toContain("2 pages / 1 changed / 1 needs review");
  });
});
