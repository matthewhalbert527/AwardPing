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
            updated_at: "2026-06-26T12:00:00.000Z",
          },
          canonicalPath: "/example-fellowship",
          redirectPath: null,
          facts: {
            overview: "A fellowship for testing.",
            deadline: "January 29, 2026",
            openingDate: null,
            awardAmount: "$1,000; Travel stipend",
            eligibility: ["Graduate students"],
            requirements: ["Recipients must submit a final report; Awardees may not hold another fellowship"],
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
              title: "Program guide",
              description: "Official PDF guide.",
              url: "https://example.edu/fellowship/program-guide.pdf",
              pageType: "pdf",
              lastCheckedAt: "2026-06-26T12:00:00.000Z",
              facts: {
                overview: "Program guide.",
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
              changeDetails: {
                before: "Applications close January 29, 2026.",
                after: "Applications close February 5, 2026.",
                reader_summary: "The application deadline moved later.",
                confidence: "high",
                change_type: "deadline_change",
                structured_diff: {
                  added_text: ["Applications close February 5, 2026."],
                  removed_text: ["Applications close January 29, 2026."],
                },
              },
              detectedAt: "2026-06-26T12:00:00.000Z",
            },
          ],
        },
      }),
    );

    const sidebarHtml = html.slice(0, html.indexOf("</aside>"));

    expect(sidebarHtml).toContain("Overview");
    expect(sidebarHtml).toContain("Award profile");
    expect(sidebarHtml).toContain("5 fields");
    expect(sidebarHtml).not.toContain("Key details");
    expect(sidebarHtml).toContain("Recent changes");
    expect(sidebarHtml).toContain("1 update");
    expect(sidebarHtml).toContain("Sources");
    expect(sidebarHtml).toContain("Homepage");
    expect(sidebarHtml).toContain("Application portal");
    expect(sidebarHtml).toContain("Program guide");
    expect(sidebarHtml).toContain("<span>PDF</span>");
    expect(sidebarHtml).not.toContain("Application / 1 update");
    expect(sidebarHtml).not.toContain("PDF guide / 0 updates");
    expect(sidebarHtml).not.toContain("Award conditions");
    expect(sidebarHtml).not.toContain("Other source / 0 updates");
    expect(sidebarHtml).not.toContain("Homepage / 0 updates");
    expect(sidebarHtml).not.toContain("<span>Overview</span><small>1 source</small>");
    expect(sidebarHtml).toContain("Checked Jun 26, 2026");
    expect(sidebarHtml).toContain("public-award-source-flat-list");
    expect(sidebarHtml).not.toContain("public-award-source-group");
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
    expect(headerHtml).toContain("public-award-meta-line");
    expect(headerHtml).not.toContain("award-detail");
    expect(headerHtml.indexOf("Example Fellowship")).toBeLessThan(headerHtml.indexOf("3 source pages"));
    expect(headerHtml.indexOf("3 source pages")).toBeLessThan(headerHtml.indexOf("A fellowship for testing."));
    expect(headerHtml).not.toContain("1 recent updates");
    expect(headerHtml).not.toContain("high confidence");
    expect(headerHtml).toContain("Official homepage");
    expect(headerHtml).toContain("Add to watchlist");
    expect(headerHtml.indexOf("Official homepage")).toBeLessThan(headerHtml.indexOf("Add to watchlist"));
    expect(mainHtml).not.toContain("public-award-overview-strip");
    expect(mainHtml).not.toContain("Last checked");
    expect(mainHtml).toContain("Overview");
    expect(mainHtml).toContain("Deadline");
    expect(mainHtml).toContain("Eligibility");
    expect(mainHtml).toContain("Award conditions");
    expect(mainHtml).not.toContain("Requirements");
    expect(mainHtml).toContain("Academic level");
    expect(mainHtml).toContain('<ul class="public-award-fact-list">');
    expect(mainHtml).toContain("<li>$1,000</li>");
    expect(mainHtml).toContain("<li>Travel stipend</li>");
    expect(mainHtml).toContain("<li>Recipients must submit a final report</li>");
    expect(mainHtml).toContain("<li>Awardees may not hold another fellowship</li>");
    expect(mainHtml).not.toContain("$1,000; Travel stipend");
    expect(mainHtml).not.toContain("Recipients must submit a final report; Awardees may not hold another fellowship");
    expect(mainHtml).not.toContain("Official source pages");
    expect(mainHtml).not.toContain("Stable");
  });

  it("keeps oversized source groups compact while preserving updated sources", () => {
    const noisyUpdatedSource = makeSource({
      id: "source-updated-noise",
      title: "1935-1936 - Vol 66",
      url: "https://portal.sds.ox.ac.uk/articles/online_resource/1935-1936_-_Vol_66/25432207",
    });
    const sources = [
      noisyUpdatedSource,
      ...["A", "B", "C", "D", "E", "F", "G"].map((suffix) =>
        makeSource({
          id: `source-detail-${suffix}`,
          title: `Application detail ${suffix}`,
          url: `https://example.edu/fellowship/application/${suffix.toLowerCase()}`,
        }),
      ),
      ...["H", "I", "J", "K", "L"].map((suffix) =>
        makeSource({
          id: `source-generic-${suffix}`,
          title: `Generic filler ${suffix}`,
          url: `https://example.edu/fellowship/generic/${suffix.toLowerCase()}`,
        }),
      ),
    ];
    const html = renderToStaticMarkup(
      createElement(PublicAwardWorkspace, {
        data: makePageData({
          sources,
          changes: [
            {
              id: "change-updated-noise",
              sourceId: noisyUpdatedSource.id,
              sourceTitle: noisyUpdatedSource.title,
              sourceUrl: noisyUpdatedSource.url,
              sourcePageType: "application",
              summary: "The application detail changed.",
              changeDetails: {},
              detectedAt: "2026-06-26T12:00:00.000Z",
            },
          ],
        }),
      }),
    );

    const sidebarHtml = html.slice(0, html.indexOf("</aside>"));

    expect(sidebarHtml).toContain("1935-1936 - Vol 66");
    expect(sidebarHtml).not.toContain("Application / 1 update");
    expect(sidebarHtml).toContain("3 more tracked pages");
    expect(sidebarHtml).not.toContain("Generic filler L");
    expect(sidebarHtml.match(/public-award-nav-button-source/g) || []).toHaveLength(10);
  });

  it("lists the award landing page source even when it is classified as application", () => {
    const html = renderToStaticMarkup(
      createElement(PublicAwardWorkspace, {
        data: makePageData({
          sources: [
            makeSource({
              id: "source-landing",
              title: "Example Fellowship Application",
              url: "https://example.edu/fellowship",
            }),
          ],
          changes: [],
        }),
      }),
    );

    const sidebarHtml = html.slice(0, html.indexOf("</aside>"));
    const mainHtml = html.slice(html.indexOf("</aside>"));

    expect(sidebarHtml).toContain("Award profile");
    expect(sidebarHtml).toContain("Sources");
    expect(sidebarHtml).toContain("Homepage");
    expect(sidebarHtml).not.toContain("Example Fellowship Application");
    expect(sidebarHtml).not.toContain("Application / 0 updates");
    expect(mainHtml).toContain("1 source page");
    expect(mainHtml).toContain("Official homepage");
    expect(mainHtml).not.toContain("Official source");
  });

  it("uses concise source titles within the award context", () => {
    const data = makePageData({
      sources: [
        makeSource({
          id: "source-home",
          title: "ACM Doctoral Dissertation Award Nominations",
          url: "https://awards.acm.org/doctoral-dissertation/nominations#h-eligibility",
        }),
        makeSource({
          id: "source-conflict",
          title: "ACM Awards Committee Conflict of Interest Guidelines",
          url: "https://awards.acm.org/award-committee-conflict-guidelines",
        }),
        makeSource({
          id: "source-advice",
          pageType: "pdf",
          title: "ACM Awards: Advice for Nominators and Endorsers [Download]",
          url: "https://awards.acm.org/acm-awards-advice-for-nominators.pdf",
        }),
      ],
      changes: [],
    });
    data.award.name = "Association for Computing Machinery (ACM) - Doctoral Dissertation Award";
    data.award.official_homepage = "https://awards.acm.org/doctoral-dissertation/nominations";
    data.officialHomepage = "https://awards.acm.org/doctoral-dissertation/nominations";

    const html = renderToStaticMarkup(
      createElement(PublicAwardWorkspace, {
        data,
      }),
    );

    const sidebarHtml = html.slice(0, html.indexOf("</aside>"));

    expect(sidebarHtml).toContain("Homepage");
    expect(sidebarHtml).toContain("Conflict of Interest Guidelines");
    expect(sidebarHtml).toContain("Advice for Nominators and Endorsers");
    expect(sidebarHtml).toContain("<span>PDF</span>");
    expect(sidebarHtml).not.toContain("ACM Doctoral Dissertation Award Nominations");
    expect(sidebarHtml).not.toContain("ACM Awards Committee Conflict");
    expect(sidebarHtml).not.toContain("ACM Awards: Advice");
    expect(sidebarHtml).not.toContain("[Download]");
  });

  it("shortens National Academies Gulf fellowship source titles", () => {
    const data = makePageData({
      sources: [
        makeSource({
          id: "source-gulf-application",
          title: "National Academies Gulf Research Program Science Policy Fellowships Application and Review Process",
          url: "https://www.nationalacademies.org/programs/GULF-GULFEO-14-01/application-process",
        }),
        makeSource({
          id: "source-gulf-office-hour",
          pageType: "pdf",
          title: "2026 Science Policy Fellowship Q&A Office Hour Presentation Applicant Resource",
          url: "https://www.nationalacademies.org/cdn/materials/a1127513-8528-483f-a66a-eae8136ed637",
        }),
      ],
      changes: [],
    });
    data.award.name = "Gulf Research Program Science Policy Fellowship";

    const html = renderToStaticMarkup(
      createElement(PublicAwardWorkspace, {
        data,
      }),
    );

    const sidebarHtml = html.slice(0, html.indexOf("</aside>"));

    expect(sidebarHtml).toContain("Application and Review Process");
    expect(sidebarHtml).toContain("2026 Q&amp;A Office Hour Presentation");
    expect(sidebarHtml).not.toContain("National Academies Gulf Research Program");
    expect(sidebarHtml).not.toContain("Applicant Resource");
  });

  it("keeps noisy updated source labels compact without clipped ellipses", () => {
    const data = makePageData({
      sources: [
        makeSource({
          id: "source-nofo",
          title: "a NOFO of up to $50 million",
          url: "https://energy.gov/nofo",
        }),
        makeSource({
          id: "source-instructions",
          title: "Instructions on submitting applications for this funding opportunity",
          url: "https://energy.gov/instructions",
        }),
        makeSource({
          id: "source-payment",
          title: "online payment link",
          url: "https://energy.gov/payment",
        }),
        makeSource({
          id: "source-announcement",
          title: "announced a series of funding opportunities for workforce development",
          url: "https://energy.gov/announcement",
        }),
      ],
      changes: [],
    });
    data.award.name =
      "U.S. Department of Energy (DOE) - Oak Ridge Institute for Science & Education (ORISE) - Graduate, Post-Master's & Postdoctoral Fellowships";

    const html = renderToStaticMarkup(
      createElement(PublicAwardWorkspace, {
        data,
      }),
    );

    const sidebarHtml = html.slice(0, html.indexOf("</aside>"));

    expect(sidebarHtml).toContain("NOFO up to $50M");
    expect(sidebarHtml).toContain("Submission Instructions");
    expect(sidebarHtml).toContain("Online Payment");
    expect(sidebarHtml).toContain("Funding Announcements");
    expect(sidebarHtml).not.toContain("...");
    expect(sidebarHtml).not.toContain("…");
  });
  it("opens the requested source panel from canonical award page query state", () => {
    const data = makePageData({
      sources: [
        makeSource({
          id: "source-home",
          pageType: "application",
          title: "Homepage",
          url: "https://example.edu/fellowship",
        }),
        makeSource({
          id: "source-apply",
          pageType: "application",
          title: "Application Instructions",
          url: "https://example.edu/fellowship/apply",
        }),
      ],
      changes: [
        {
          id: "change-apply",
          sourceId: "source-apply",
          sourceTitle: "Application Instructions",
          sourceUrl: "https://example.edu/fellowship/apply",
          sourcePageType: "application",
          summary: "The application instructions changed.",
          changeDetails: {},
          detectedAt: "2026-07-03T12:00:00.000Z",
        },
      ],
    });

    const html = renderToStaticMarkup(
      createElement(PublicAwardWorkspace, {
        data,
        initialSourceId: "source-apply",
      }),
    );
    const mainHtml = html.slice(html.indexOf("</aside>"));

    expect(mainHtml).toContain("Source update history");
    expect(mainHtml).toContain("Application Instructions");
    expect(mainHtml).toContain("The application instructions changed.");
    expect(mainHtml).not.toContain("<h2>Overview</h2>");
  });
});

function makePageData({
  sources,
  changes,
}: {
  sources: ReturnType<typeof makeSource>[];
  changes: Array<{
    id: string;
    sourceId: string;
    sourceTitle: string;
    sourceUrl: string;
    sourcePageType: "application";
    summary: string;
    changeDetails: Record<string, never>;
    detectedAt: string;
  }>;
}) {
  return {
    award: {
      id: "award-1",
      name: "Example Fellowship",
      slug: "example-fellowship",
      official_homepage: "https://example.edu/fellowship",
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
    sources,
    changes,
  };
}

function makeSource({
  id,
  pageType = "application",
  title,
  url,
}: {
  id: string;
  pageType?: "application" | "pdf";
  title: string;
  url: string;
}) {
  return {
    id,
    sourceSlug: id,
    publicPath: "/example-fellowship",
    title,
    description: null,
    url,
    pageType,
    lastCheckedAt: "2026-06-26T12:00:00.000Z",
    facts: {
      overview: null,
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
  };
}
