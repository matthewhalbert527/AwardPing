import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PublicAwardWorkspace } from "@/components/public-award-workspace";

describe("PublicAwardWorkspace", () => {
  it("keeps public award outline labels free of numeric counts", () => {
    const html = renderToStaticMarkup(
      createElement(PublicAwardWorkspace, {
        data: {
          award: {
            id: "award-1",
            name: "Example Fellowship",
            slug: "example-fellowship",
            official_homepage: "https://example.edu/fellowship",
            summary: "A fellowship for testing.",
            public_facts: {},
            public_facts_generated_at: "2026-06-26T12:00:00.000Z",
            updated_at: "2026-06-26T12:00:00.000Z",
          },
          canonicalPath: "/example-fellowship",
          redirectPath: null,
          facts: {
            overview: "A fellowship for testing.",
            deadline: "January 29, 2026",
            openingDate: null,
            awardAmount: "$1,000",
            eligibility: ["Graduate students"],
            requirements: [],
            applicationMaterials: [],
            howToApply: [],
            importantDates: [],
            documents: [],
            contacts: [],
            academicLevels: ["Graduate"],
            disciplines: [],
            citizenship: [],
            confidence: "high",
          },
          metaDescription: "Example fellowship details.",
          officialHomepage: "https://example.edu/fellowship",
          lastCheckedAt: "2026-06-26T12:00:00.000Z",
          sources: [
            {
              id: "source-1",
              sourceSlug: "homepage",
              publicPath: "/example-fellowship/homepage",
              title: "Homepage",
              description: "Official homepage.",
              url: "https://example.edu/fellowship",
              pageType: "homepage",
              lastCheckedAt: "2026-06-26T12:00:00.000Z",
              facts: {
                overview: "Official homepage.",
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
              },
            },
          ],
          changes: [
            {
              id: "change-1",
              sourceId: "source-1",
              sourceTitle: "Homepage",
              sourceUrl: "https://example.edu/fellowship",
              sourcePageType: "homepage",
              summary: "The deadline changed.",
              changeDetails: {},
              detectedAt: "2026-06-26T12:00:00.000Z",
            },
          ],
        },
      }),
    );

    const sidebarHtml = html.slice(0, html.indexOf("</aside>"));

    expect(sidebarHtml).toContain("Overview");
    expect(sidebarHtml).toContain("Profile");
    expect(sidebarHtml).toContain("Recent changes");
    expect(sidebarHtml).toContain("Updates");
    expect(sidebarHtml).not.toContain("1 sources");
    expect(sidebarHtml).not.toContain("1 updates");
    expect(sidebarHtml).not.toContain("1 recent updates");
  });
});
