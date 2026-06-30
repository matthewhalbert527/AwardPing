import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PublicAwardWorkspace } from "@/components/public-award-workspace";

describe("PublicAwardWorkspace", () => {
  it("renders the award outline sidebar with pluralized counts", () => {
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
              publicPath: "/example-fellowship",
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
            {
              id: "source-2",
              sourceSlug: "apply",
              publicPath: "/example-fellowship",
              title: "Application portal",
              description: "Apply for the fellowship.",
              url: "https://example.edu/fellowship/apply",
              pageType: "application",
              lastCheckedAt: "2026-06-26T12:00:00.000Z",
              facts: {
                overview: "Application portal.",
                deadline: null,
                openingDate: null,
                awardAmount: null,
                eligibility: [],
                requirements: [],
                applicationMaterials: [],
                howToApply: ["Submit the application form."],
                importantDates: [],
                documents: [],
                contacts: [],
                academicLevels: [],
                disciplines: [],
                citizenship: [],
                confidence: null,
              },
            },
            {
              id: "source-3",
              sourceSlug: "contact",
              publicPath: "/example-fellowship",
              title: "Contact the program",
              description: "Email and phone support.",
              url: "https://example.edu/fellowship/contact",
              pageType: "other",
              lastCheckedAt: "2026-06-26T12:00:00.000Z",
              facts: {
                overview: "Program contact page.",
                deadline: null,
                openingDate: null,
                awardAmount: null,
                eligibility: [],
                requirements: [],
                applicationMaterials: [],
                howToApply: [],
                importantDates: [],
                documents: [],
                contacts: ["fellowships@example.edu"],
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
              sourceId: "source-2",
              sourceTitle: "Application portal",
              sourceUrl: "https://example.edu/fellowship/apply",
              sourcePageType: "application",
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
    expect(sidebarHtml).toContain("Award profile");
    expect(sidebarHtml).toContain("4 fields");
    expect(sidebarHtml).not.toContain("Key details");
    expect(sidebarHtml).toContain("Recent changes");
    expect(sidebarHtml).toContain("1 update");
    expect(sidebarHtml).toContain("Sources");
    expect(sidebarHtml).toContain("Application");
    expect(sidebarHtml).toContain("Application / 1 update");
    expect(sidebarHtml).toContain("Contact");
    expect(sidebarHtml).toContain("Other source / 0 updates");
    expect(sidebarHtml).toContain("Checked Jun 26, 2026");
    expect(sidebarHtml).toContain("public-award-source-group");
    expect(sidebarHtml).not.toContain("public-award-sidebar-page-card");
    expect(sidebarHtml).not.toContain("public-award-sidebar-last-checked");
    expect(sidebarHtml).not.toContain('<details class="public-award-source-group" open');
    expect(sidebarHtml).not.toContain("1 sources");
    expect(sidebarHtml).not.toContain("1 updates");
    expect(sidebarHtml).not.toContain("1 recent updates");

    const mainHtml = html.slice(html.indexOf("</aside>"));
    const headerHtml = mainHtml.slice(
      mainHtml.indexOf('<header class="public-award-console-header">'),
      mainHtml.indexOf("</header>"),
    );
    expect(mainHtml).not.toContain("public-award-console-breadcrumb");
    expect(headerHtml).toContain("Example Fellowship");
    expect(headerHtml).toContain("3 source pages");
    expect(headerHtml).toContain("A fellowship for testing.");
    expect(headerHtml.indexOf("Example Fellowship")).toBeLessThan(headerHtml.indexOf("3 source pages"));
    expect(headerHtml.indexOf("3 source pages")).toBeLessThan(headerHtml.indexOf("A fellowship for testing."));
    expect(headerHtml).not.toContain("1 recent updates");
    expect(headerHtml).not.toContain("high confidence");
    expect(headerHtml).toContain("Official homepage");
    expect(headerHtml).toContain("Add to watchlist");
    expect(headerHtml.indexOf("Official homepage")).toBeLessThan(headerHtml.indexOf("Add to watchlist"));
    expect(mainHtml).toContain("Overview");
    expect(mainHtml).toContain("Deadline");
    expect(mainHtml).toContain("Eligibility");
    expect(mainHtml).toContain("Academic level");
    expect(mainHtml).not.toContain("Official source pages");
    expect(mainHtml).not.toContain("Stable");
  });
});
