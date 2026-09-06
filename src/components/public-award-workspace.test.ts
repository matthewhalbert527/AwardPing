import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { formatCentralDateTime } from "@/lib/time-zone";
import { PublicAwardWorkspace, changeIdsToMarkRead } from "@/components/public-award-workspace";

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

    const sidebarHtml = asideMarkup(html);

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

    const mainHtml = mainMarkup(html);
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
    expect(headerHtml).toContain('<a class="button-primary" href="/updates">View all updates<svg');
    expect(headerHtml.indexOf("Official homepage")).toBeLessThan(headerHtml.indexOf("View all updates"));
    expect(html).not.toContain("Get in touch");
    expect(mainHtml).not.toContain("public-award-overview-strip");
    expect(mainHtml).not.toContain("Last checked");
    expect(mainHtml).toContain("Overview");
    expect(mainHtml).toContain("Deadline");
    expect(mainHtml).toContain("Eligibility");
    expect(mainHtml).toContain("Requirements");
    expect(mainHtml).not.toContain("Award conditions");
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

    const sidebarHtml = asideMarkup(html);

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

    const sidebarHtml = asideMarkup(html);
    const mainHtml = mainMarkup(html);

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

    const sidebarHtml = asideMarkup(html);

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

    const sidebarHtml = asideMarkup(html);

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

    const sidebarHtml = asideMarkup(html);

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
    const mainHtml = mainMarkup(html);

    expect(mainHtml).toContain("Source update history");
    expect(mainHtml).toContain("Application Instructions");
    expect(mainHtml).toContain("The application instructions changed.");
    expect(mainHtml).not.toContain('<h2 id="public-award-panel-heading">Overview</h2>');
  });

  it("opens the exact change's source and marks that change when only the change id is known", () => {
    const html = renderToStaticMarkup(
      createElement(PublicAwardWorkspace, {
        data: makeDeepLinkPageData(),
        initialChangeId: "change-apply",
      }),
    );
    const mainHtml = mainMarkup(html);

    expect(mainHtml).toContain("Source update history");
    expect(mainHtml).toContain('<h2 id="public-award-panel-heading">Application Instructions</h2>');
    expect(mainHtml).toContain("The application instructions changed.");
    expect(mainHtml).not.toContain("The homepage changed.");
    expect(mainHtml).not.toContain('<h2 id="public-award-panel-heading">Overview</h2>');
    expectSingleHighlightedChange(mainHtml, "The application instructions changed.");
  });

  it("opens the feed's source and change context on first load and keeps the outline labels", () => {
    const html = renderToStaticMarkup(
      createElement(PublicAwardWorkspace, {
        data: makeDeepLinkPageData(),
        initialChangeId: "change-apply",
        initialSourceId: "source-apply",
      }),
    );
    const mainHtml = mainMarkup(html);

    expect(mainHtml).toContain("Source update history");
    expect(mainHtml).toContain('<h2 id="public-award-panel-heading">Application Instructions</h2>');
    expectSingleHighlightedChange(mainHtml, "The application instructions changed.");
    expect(html).toContain('aria-label="Example Fellowship page outline"');
    expect(html).toContain('aria-label="Award profile"');
    expect(html).toContain('aria-label="Official sources"');
    expect(html).toContain('aria-label="Collapse page outline"');
    expect(html).toContain("<h1>Example Fellowship</h1>");
  });

  it("keeps the requested source when the change belongs to another source and marks nothing", () => {
    const html = renderToStaticMarkup(
      createElement(PublicAwardWorkspace, {
        data: makeDeepLinkPageData(),
        initialChangeId: "change-home",
        initialSourceId: "source-apply",
      }),
    );
    const mainHtml = mainMarkup(html);

    expect(mainHtml).toContain('<h2 id="public-award-panel-heading">Application Instructions</h2>');
    expect(mainHtml).not.toContain("The homepage changed.");
    expect(mainHtml).not.toContain('data-highlighted="true"');
    expect(mainHtml).not.toContain("Selected update");
  });

  it("shows an eligible change in recent changes when its source is no longer listed", () => {
    const html = renderToStaticMarkup(
      createElement(PublicAwardWorkspace, {
        data: makeDeepLinkPageData(),
        initialChangeId: "change-orphan",
        initialSourceId: "source-gone",
      }),
    );
    const mainHtml = mainMarkup(html);

    expect(mainHtml).toContain('<h2 id="public-award-panel-heading">Recent changes</h2>');
    expect(mainHtml).not.toContain("Source update history");
    expect(mainHtml).toContain("The retired page changed.");
    expectSingleHighlightedChange(mainHtml, "The retired page changed.");
    expect(html).toContain("<h1>Example Fellowship</h1>");
  });

  it("falls back to the award overview for unknown or stale ids without marking anything", () => {
    for (const query of [
      { initialChangeId: "change-unknown", initialSourceId: "source-unknown" },
      { initialChangeId: "change-unknown" },
      { initialSourceId: "source-unknown" },
      { initialChangeId: "", initialSourceId: "" },
      { initialChangeId: null, initialSourceId: null },
    ]) {
      const html = renderToStaticMarkup(
        createElement(PublicAwardWorkspace, { data: makeDeepLinkPageData(), ...query }),
      );
      const mainHtml = mainMarkup(html);

      expect(mainHtml, JSON.stringify(query)).toContain('<h2 id="public-award-panel-heading">Overview</h2>');
      expect(mainHtml, JSON.stringify(query)).toContain("A fellowship for testing.");
      expect(html, JSON.stringify(query)).toContain("<h1>Example Fellowship</h1>");
      expect(html, JSON.stringify(query)).not.toContain('data-highlighted="true"');
      expect(html, JSON.stringify(query)).not.toContain('aria-current="true"');
      expect(html, JSON.stringify(query)).not.toContain("Selected update");
    }
  });

  it("never marks an id the award loader did not return, such as a stale, suppressed or unverified update", () => {
    // The award loader fetches a deep-linked update through the public gates
    // and merges it into data.changes, so an id missing from the data is one
    // the gates rejected: the requested source still opens, nothing is marked.
    const data = makeDeepLinkPageData();
    const html = renderToStaticMarkup(
      createElement(PublicAwardWorkspace, {
        data,
        initialChangeId: "change-not-on-page",
        initialSourceId: "source-apply",
      }),
    );
    const mainHtml = mainMarkup(html);

    expect(mainHtml).toContain('<h2 id="public-award-panel-heading">Application Instructions</h2>');
    expect(mainHtml).toContain("The application instructions changed.");
    expect(mainHtml).not.toContain('data-highlighted="true"');
    expect(mainHtml).not.toContain("Selected update");
    expect(html).not.toContain("change-not-on-page");
  });

  it("reads header and H1 first, then the outline, then the selected panel, with no nested main", () => {
    for (const props of [
      {},
      { initialSourceId: "source-apply" },
      { initialChangeId: "change-orphan" },
    ]) {
      const html = renderToStaticMarkup(
        createElement(PublicAwardWorkspace, { data: makeDeepLinkPageData(), ...props }),
      );
      const consoleStart = html.indexOf('<div class="public-award-console');
      const headerStart = html.indexOf('<header class="public-award-console-header">');
      const headingStart = html.indexOf("<h1>Example Fellowship</h1>");
      const asideStart = html.indexOf("<aside ");
      const panelStart = html.indexOf('<section class="public-award-console-panel"');

      expect(consoleStart, JSON.stringify(props)).toBeGreaterThanOrEqual(0);
      expect(headerStart, JSON.stringify(props)).toBeGreaterThan(consoleStart);
      expect(headingStart, JSON.stringify(props)).toBeGreaterThan(headerStart);
      expect(asideStart, JSON.stringify(props)).toBeGreaterThan(html.indexOf("</header>"));
      expect(panelStart, JSON.stringify(props)).toBeGreaterThan(html.indexOf("</aside>"));
      expect(html, JSON.stringify(props)).not.toContain("<main");
      expect(html.split("<header ").length - 1, JSON.stringify(props)).toBe(1);
      expect(html.split("<aside ").length - 1, JSON.stringify(props)).toBe(1);
      // Header, aside and panel are direct siblings: the panel closes the console.
      expect(html.trimEnd().endsWith("</section></div>"), JSON.stringify(props)).toBe(true);
    }
  });

  it("marks exactly one outline button as pressed and points every outline button at the stable panel", () => {
    const cases: Array<{ props: Record<string, string>; pressedLabel: string }> = [
      { props: {}, pressedLabel: "Overview" },
      { props: { initialChangeId: "change-orphan" }, pressedLabel: "Recent changes" },
      { props: { initialSourceId: "source-apply", initialChangeId: "change-apply" }, pressedLabel: "Application Instructions" },
    ];
    for (const { props, pressedLabel } of cases) {
      const html = renderToStaticMarkup(
        createElement(PublicAwardWorkspace, { data: makeDeepLinkPageData(), ...props }),
      );
      const buttons = outlineButtons(html);

      expect(buttons.length, JSON.stringify(props)).toBe(4);
      expect(buttons.filter((button) => button.includes('aria-pressed="true"')), JSON.stringify(props)).toHaveLength(1);
      expect(buttons.filter((button) => button.includes('aria-pressed="false"')), JSON.stringify(props)).toHaveLength(3);
      expect(buttons.filter((button) => button.includes('aria-controls="public-award-panel"')), JSON.stringify(props)).toHaveLength(4);
      const pressed = buttons.find((button) => button.includes('aria-pressed="true"')) || "";
      expect(pressed, JSON.stringify(props)).toContain(`<strong>${pressedLabel}</strong>`);
      expect(pressed, JSON.stringify(props)).toContain("public-award-nav-button-active");
      expect(html.split("public-award-nav-button-active").length - 1, JSON.stringify(props)).toBe(1);
    }
  });

  it("exposes the selected panel as one stable, focusable region named by its visible heading", () => {
    const regionOpen =
      '<section class="public-award-console-panel" id="public-award-panel" role="region" aria-labelledby="public-award-panel-heading" tabindex="-1">';
    const cases: Array<{ props: Record<string, string>; heading: string }> = [
      { props: {}, heading: "Overview" },
      { props: { initialChangeId: "change-orphan" }, heading: "Recent changes" },
      { props: { initialSourceId: "source-apply" }, heading: "Application Instructions" },
    ];
    for (const { props, heading } of cases) {
      const html = renderToStaticMarkup(
        createElement(PublicAwardWorkspace, { data: makeDeepLinkPageData(), ...props }),
      );

      expect(html.split(regionOpen).length - 1, JSON.stringify(props)).toBe(1);
      expect(html.split('id="public-award-panel-heading"').length - 1, JSON.stringify(props)).toBe(1);
      expect(panelMarkup(html), JSON.stringify(props)).toContain(
        `<h2 id="public-award-panel-heading">${heading}</h2>`,
      );
      expect(html.split('id="public-award-panel"').length - 1, JSON.stringify(props)).toBe(1);
    }
  });

  it("marks as read exactly what an activation is about to show", () => {
    const data = makeDeepLinkPageData();
    const noneRead = new Set<string>();

    expect(changeIdsToMarkRead(data, noneRead, { kind: "overview" })).toEqual([]);
    expect(changeIdsToMarkRead(data, noneRead, { kind: "changes" })).toEqual([
      "change-home",
      "change-apply",
      "change-orphan",
    ]);
    expect(changeIdsToMarkRead(data, noneRead, { kind: "source", sourceId: "source-apply" })).toEqual([
      "change-apply",
    ]);
    expect(changeIdsToMarkRead(data, noneRead, { kind: "source", sourceId: "source-home" })).toEqual([
      "change-home",
    ]);
    expect(changeIdsToMarkRead(data, noneRead, { kind: "source", sourceId: "source-gone" })).toEqual([]);
    // Already-read changes are never marked again.
    expect(
      changeIdsToMarkRead(data, new Set(["change-apply"]), { kind: "source", sourceId: "source-apply" }),
    ).toEqual([]);
    expect(changeIdsToMarkRead(data, new Set(["change-home"]), { kind: "changes" })).toEqual([
      "change-apply",
      "change-orphan",
    ]);
  });

  it("reveals the panel only through the activation sequence, never on mount or deep links", () => {
    // The handoff cannot run without a DOM; its wiring is pinned here and the
    // sequence and reveal semantics are covered by the focus helper tests.
    const source = readFileSync(new URL("./public-award-workspace.tsx", import.meta.url), "utf8");

    expect(source).toContain("const [activation, setActivation] = useState<PanelActivationState<SelectedPanel>>(() => ({");
    expect(source).toContain("    selected: initialContext.panel,\n    revealSequence: 0,\n  }));");
    expect(source).toContain(
      "  useEffect(() => {\n    if (!shouldRevealPanel(activation.revealSequence)) return;\n    revealSelectedPanel(panelRef.current, readPanelRevealEnvironment());\n  }, [activation.revealSequence]);",
    );
    const activation = source.slice(source.indexOf("const activatePanel = "), source.indexOf("useEffect(() => {"));
    expect(activation).toContain("markChangesRead(changeIdsToMarkRead(data, readChangeIds, next));");
    expect(activation).toContain(
      "setActivation((state) => activatePanelSelection(state, next, (panel) => isKnownPanel(data, panel)));",
    );
    expect(source.match(/setActivation\(/g)).toHaveLength(1);
    expect(source).not.toContain("setSelected");
    expect(source.match(/revealSelectedPanel\(/g)).toHaveLength(1);
    expect(source.match(/activatePanel\(\{ kind: /g)).toHaveLength(3);
  });

  it("keeps the one-column scroll offset above every mobile header contributor and the focus ring", () => {
    // Derived from the header, profile-menu and focus-ring sources, so a
    // taller header row or a larger focus extent fails here until the panel
    // margin grows with it.
    const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
    const profileMenu = readFileSync(new URL("./profile-menu.tsx", import.meta.url), "utf8");
    const measure = (source: string, pattern: RegExp) => {
      const match = source.match(pattern);
      expect(match, String(pattern)).not.toBeNull();
      return Number(match![1]);
    };
    const narrowHeader = css.slice(css.indexOf("@media (max-width: 760px) {"));
    const headerPaddingTop = measure(narrowHeader, /\.app-header \{\s*padding: ([\d.]+)rem [\d.]+rem 0;/);
    const barGap = measure(narrowHeader, /\.app-header-bar \{[^}]*?gap: ([\d.]+)rem;/);
    const barPadding = measure(narrowHeader, /\.app-header-bar \{[^}]*?padding: ([\d.]+)rem;/);
    const brandRow = measure(narrowHeader, /\.app-header-brand \.brand-logo \{[^}]*?height: ([\d.]+)rem;/);
    const buttonRow = measure(css, /\.app-header-actions \.button-secondary \{\s*min-height: ([\d.]+)rem;/);
    // The signed-in profile menu trigger is a Tailwind h-12 control: 12 × 0.25rem.
    const profileMenuRow = measure(profileMenu, /className="inline-flex h-(\d+) w-\d+ /) * 0.25;
    expect(profileMenuRow).toBe(3);
    const headerBorderPx = measure(css, /\.app-header \{[^}]*?border-bottom: (\d+)px/);
    const focusWidthPx = measure(css, /\.public-award-console-panel:focus-visible \{\s*outline: (\d+)px/);
    const focusOffsetPx = measure(css, /\.public-award-console-panel:focus-visible \{[^}]*?outline-offset: (\d+)px/);
    const requiredRem =
      headerPaddingTop +
      barPadding +
      brandRow +
      barGap +
      Math.max(buttonRow, profileMenuRow) +
      barPadding +
      (headerBorderPx + focusWidthPx + focusOffsetPx) / 16;

    const compact = css.slice(css.indexOf("@media (max-width: 720px) {", css.indexOf("grid-area: panel;")));
    const token = compact.match(
      /\.public-award-console-panel \{\s*--public-award-compact-scroll-margin: ([\d.]+)rem;\s*scroll-margin-top: var\(--public-award-compact-scroll-margin\);/,
    );
    expect(token).not.toBeNull();
    const margin = Number(token![1]);
    expect(margin).toBeGreaterThanOrEqual(requiredRem);
    expect(margin).toBeLessThanOrEqual(requiredRem + 1);
    expect(css.match(/\.public-award-console-panel \{[^}]*scroll-margin-top: ([\d.]+)rem;/)?.[1]).toBe("5.4");
  });
  it("keeps compact outline buttons named after a desktop collapse while the compact toggle stays hidden", () => {
    // A visitor who collapsed the outline on a wide window and then narrows
    // it keeps the collapsed class, but the toggle is hidden below 720px, so
    // the compact override must bring the button labels back.
    const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
    const strongSelector = ".public-award-console-collapsed .public-award-nav-text strong";
    const desktopHide = css.search(
      /\.public-award-console-collapsed \.public-award-nav-text strong \{\s*display: none;\s*\}/,
    );
    expect(desktopHide).toBeGreaterThan(0);

    const compactStart = css.indexOf("@media (max-width: 720px) {", css.indexOf("grid-area: panel;"));
    expect(compactStart).toBeGreaterThan(desktopHide);
    const compactEnd = css.slice(compactStart).search(/\r?\n\}/) + compactStart;
    const compact = css.slice(compactStart, compactEnd);

    // The strong label belongs to a compact rule whose body restores display,
    // and that rule comes after the desktop hide, so the cascade restores it.
    const selectorAt = compact.indexOf(strongSelector);
    expect(selectorAt).toBeGreaterThan(0);
    const ruleOpen = compact.indexOf("{", selectorAt);
    expect(compact.slice(selectorAt, ruleOpen)).not.toContain("}");
    const body = compact.slice(ruleOpen, compact.indexOf("}", ruleOpen));
    expect(body).toMatch(/^\{\s*display: initial;\s*$/);
    // The compact toggle stays hidden, so the restore is the only way back.
    expect(compact).toMatch(/\.public-award-sidebar-toggle \{\s*display: none;\s*\}/);
  });
  it("gives each change row a machine-readable Central timestamp", () => {
    const html = renderToStaticMarkup(
      createElement(PublicAwardWorkspace, { data: makeDeepLinkPageData(), initialSourceId: "source-apply" }),
    );
    const full = formatCentralDateTime("2026-07-03T12:00:00.000Z");

    expect(full).toMatch(/^Jul 3, 2026, 7:00.AM CDT$/);
    expect(panelMarkup(html)).toContain(
      `<time dateTime="2026-07-03T12:00:00.000Z" title="${full}">Jul 3, 2026<span class="sr-only"> (${full})</span></time>`,
    );
    expect(html).not.toContain("<time>");
  });

  it("renders one plain notice, and no <time>, for a change whose timestamp is not a date", () => {
    const data = makeDeepLinkPageData();
    data.changes[1] = { ...data.changes[1], detectedAt: "not-a-date" };

    const html = renderToStaticMarkup(
      createElement(PublicAwardWorkspace, { data, initialSourceId: "source-apply" }),
    );
    const panel = panelMarkup(html);

    expect(panel).toContain(
      '<article class="public-award-change-line"><span>Date unavailable</span><div><h3>Application Instructions</h3>',
    );
    expect(panel.split("Date unavailable")).toHaveLength(2);
    expect(panel).not.toContain("<time");
    // A valid change in another render still gets its time element.
    const valid = panelMarkup(
      renderToStaticMarkup(
        createElement(PublicAwardWorkspace, { data: makeDeepLinkPageData(), initialSourceId: "source-home" }),
      ),
    );
    expect(valid).toContain('<time dateTime="2026-07-04T12:00:00.000Z"');
    expect(valid).not.toMatch(/<time(?![^>]*dateTime=)/);
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

function makeDeepLinkPageData() {
  return makePageData({
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
        id: "change-home",
        sourceId: "source-home",
        sourceTitle: "Homepage",
        sourceUrl: "https://example.edu/fellowship",
        sourcePageType: "application",
        summary: "The homepage changed.",
        changeDetails: {},
        detectedAt: "2026-07-04T12:00:00.000Z",
      },
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
      {
        id: "change-orphan",
        sourceId: "source-gone",
        sourceTitle: "Retired page",
        sourceUrl: "https://example.edu/fellowship/retired",
        sourcePageType: "application",
        summary: "The retired page changed.",
        changeDetails: {},
        detectedAt: "2026-07-02T12:00:00.000Z",
      },
    ],
  });
}

function expectSingleHighlightedChange(mainHtml: string, summary: string) {
  const rows = mainHtml.split(
    '<article aria-current="true" class="public-award-change-line" data-highlighted="true">',
  );
  expect(rows).toHaveLength(2);
  const row = rows[1].slice(0, rows[1].indexOf("</article>"));
  expect(row).toContain("Selected update");
  expect(row).toContain(summary);
  expect(mainHtml.split("Selected update")).toHaveLength(2);
  expect(mainHtml.split('aria-current="true"')).toHaveLength(2);
}

// The award outline, wherever it sits in the document.
function asideMarkup(html: string) {
  const start = html.indexOf("<aside ");
  const end = html.indexOf("</aside>") + "</aside>".length;
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return html.slice(start, end);
}

// Everything except the outline: the award header and the selected panel.
function mainMarkup(html: string) {
  const start = html.indexOf("<aside ");
  const end = html.indexOf("</aside>") + "</aside>".length;
  expect(start).toBeGreaterThanOrEqual(0);
  return html.slice(0, start) + html.slice(end);
}

// The selected-panel region only.
function panelMarkup(html: string) {
  const start = html.indexOf('<section class="public-award-console-panel"');
  expect(start).toBeGreaterThanOrEqual(0);
  return html.slice(start);
}

function outlineButtons(html: string) {
  return [...html.matchAll(/<button [^>]*class="public-award-nav-button [^"]*"[^>]*>[\s\S]*?<\/button>/g)].map(
    (match) => match[0],
  );
}

describe("PublicAwardWorkspace header action", () => {
  // The official homepage link is byte-for-byte what it was; the one public
  // action follows it.
  const OFFICIAL_HOMEPAGE_LINK =
    '<a class="button-secondary" href="https://example.edu/fellowship" rel="noreferrer" target="_blank">';
  const VIEW_ALL_UPDATES_LINK = '<a class="button-primary" href="/updates">View all updates<svg';

  function headerActions(html: string) {
    const header = html.slice(
      html.indexOf('<header class="public-award-console-header">'),
      html.indexOf("</header>"),
    );
    const start = header.indexOf('<div class="public-award-console-actions">');
    expect(start).toBeGreaterThanOrEqual(0);
    return header.slice(start);
  }

  it("offers one public action, View all updates, after the unchanged official homepage link", () => {
    const html = renderToStaticMarkup(
      createElement(PublicAwardWorkspace, { data: makeDeepLinkPageData() }),
    );
    const actions = headerActions(html);

    expect(actions.startsWith(`<div class="public-award-console-actions">${OFFICIAL_HOMEPAGE_LINK}`)).toBe(true);
    expect(actions).toContain(`Official homepage</a>${VIEW_ALL_UPDATES_LINK}`);
    expect(actions).toMatch(/View all updates<svg[^>]*lucide-arrow-right[^>]*>[\s\S]*<\/svg><\/a><\/div>$/);
    expect(actions.split('class="button-primary"')).toHaveLength(2);
    expect(actions.split("<a ")).toHaveLength(3);
    expect(html).not.toContain('href="/contact"');
    expect(html).not.toContain("Get in touch");
  });

  it("keeps the single public action when an award has no official homepage", () => {
    const html = renderToStaticMarkup(
      createElement(PublicAwardWorkspace, {
        data: { ...makeDeepLinkPageData(), officialHomepage: null },
      }),
    );
    const actions = headerActions(html);

    expect(actions.startsWith(`<div class="public-award-console-actions">${VIEW_ALL_UPDATES_LINK}`)).toBe(true);
    expect(actions.split("<a ")).toHaveLength(2);
    expect(actions).not.toContain("Official homepage");
    expect(html).not.toContain('href="/contact"');
  });

  it("leaves no contact destination in the workspace source", () => {
    const source = readFileSync(new URL("./public-award-workspace.tsx", import.meta.url), "utf8");
    expect(source).not.toContain('"/contact"');
    expect(source).not.toContain("Get in touch");
    expect(source.match(/href="\/updates"/g)).toHaveLength(1);
  });
});
