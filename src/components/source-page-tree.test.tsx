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
});
