import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { load } from "cheerio";
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { formatCentralDateTime } from "@/lib/time-zone";
import type { Json } from "@/lib/database.types";
import type { PublicAwardPageData } from "@/lib/public-award-pages";
import { publicAwardFactsFromAward } from "@/lib/public-award-facts";
import { PublicAwardWorkspace, AwardSourcesPanel, AwardFactsPanel, filterAwardSources, changeIdsToMarkRead } from "@/components/public-award-workspace";
import { PUBLIC_AWARD_PANEL_HEADING_ID } from "@/lib/public-award-panel-focus";
import * as SnapshotViewer from "@/components/source-snapshot-viewer";
import * as ChangeEvidence from "@/components/change-evidence-panel";

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
            // Two reviewed items, as the normalizer produces them. A single
            // array item carrying a semicolon is one criterion and is no
            // longer split by the renderer; that case is covered separately.
            requirements: ["Recipients must submit a final report", "Awardees may not hold another fellowship"],
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

    for (const label of ["Overview", "Eligibility", "Dates &amp; deadlines", "How to apply", "Updates", "Official sources"]) {
      expect(sidebarHtml).toContain(`<strong>${label}</strong>`);
    }
    expect(sidebarHtml).toContain('href="/award-directory"');
    expect(sidebarHtml).toContain("On this award");
    expect(sidebarHtml).toContain("1 update shown");
    expect(sidebarHtml).toContain("3 source pages");
    expect(sidebarHtml).toContain("Last source check Jun 26, 2026");
    expect(sidebarHtml).not.toContain("Application portal");
    expect(sidebarHtml).not.toContain("Program guide");
    expect(sidebarHtml).not.toContain("more tracked pages");
    expect(outlineButtons(html)).toHaveLength(6);

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

  it.each([[0, "0 source pages"], [1, "1 source page"], [4, "4 source pages"]] as const)(
    "keeps the header and Official sources sidebar counts consistent for %i recorded sources",
    (count, expected) => {
      const sources = Array.from({ length: count }, (_, index) => makeSource({
        id: `source-count-${index}`,
        title: `Official page ${index}`,
        url: `https://example.edu/fellowship/source-${index}`,
      }));
      const $ = load(renderToStaticMarkup(createElement(PublicAwardWorkspace, {
        data: makePageData({ sources, changes: [] }),
      })));
      const headerCount = $("header.public-award-console-header .public-award-meta-line > span");
      const sourcesButton = $('aside button[title="Official sources"]');
      const sidebarCount = sourcesButton.find(".public-award-nav-text > small");
      expect(headerCount).toHaveLength(1);
      expect(sourcesButton).toHaveLength(1);
      expect(sidebarCount).toHaveLength(1);
      expect(sidebarCount.text()).toBe(expected);
      expect(sourcesButton.attr("aria-label")).toBe(`Official sources, ${expected}`);
      expect(headerCount.text()).toBe(expected);
      expect(headerCount.text()).toBe(sidebarCount.text());
    },
  );

  it("keeps every source reachable in the searchable source panel", () => {
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
      createElement(AwardSourcesPanel, {
        onSelectSource: () => {},
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

    const sidebarHtml = html;

    expect(sidebarHtml).toContain("1935-1936 - Vol 66");
    expect(sidebarHtml).not.toContain("Application / 1 update");
    expect(sidebarHtml).not.toContain("more tracked pages");
    expect(sidebarHtml).toContain("Generic filler L");
    expect(sidebarHtml.match(/class="public-award-source-choice"/g) || []).toHaveLength(13);
    expect(sidebarHtml).toContain("13 of 13 source pages");
  });

  it("lists the award landing page source even when it is classified as application", () => {
    const html = renderToStaticMarkup(
      createElement(AwardSourcesPanel, {
        onSelectSource: () => {},
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

    const sidebarHtml = html;
    const mainHtml = html;

    expect(sidebarHtml).toContain("Official sources");
    expect(sidebarHtml).toContain("Find a source page");
    expect(sidebarHtml).toContain("Homepage");
    expect(sidebarHtml).not.toContain("Application / 0 updates");
    expect(mainHtml).toContain("1 source page");
    expect(sidebarHtml).toContain("<strong>Homepage</strong>");
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
      createElement(AwardSourcesPanel, {
        onSelectSource: () => {},
        data,
      }),
    );

    const sidebarHtml = html;

    expect(sidebarHtml).toContain("Homepage");
    expect(sidebarHtml).toContain("Conflict of Interest Guidelines");
    expect(sidebarHtml).toContain("Advice for Nominators and Endorsers");
    expect(sidebarHtml).toContain("<span>PDF guide</span>");
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
      createElement(AwardSourcesPanel, {
        onSelectSource: () => {},
        data,
      }),
    );

    const sidebarHtml = html;

    expect(sidebarHtml).toContain("Application and Review Process");
    expect(sidebarHtml).toContain("2026 Q&amp;A Office Hour Presentation");
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
      createElement(AwardSourcesPanel, {
        onSelectSource: () => {},
        data,
      }),
    );

    const sidebarHtml = html;

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

    expect(mainHtml).toContain("Updates shown for this source");
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

    expect(mainHtml).toContain("Updates shown for this source");
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

    expect(mainHtml).toContain("Updates shown for this source");
    expect(mainHtml).toContain('<h2 id="public-award-panel-heading">Application Instructions</h2>');
    expectSingleHighlightedChange(mainHtml, "The application instructions changed.");
    expect(html).toContain('aria-label="Example Fellowship page outline"');
    expect(html).toContain('aria-label="Award sections"');
    expect(html).toContain('aria-label="Official sources, 2 source pages"');
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

    expect(mainHtml).toContain('<h2 id="public-award-panel-heading">Updates</h2>');
    expect(mainHtml).not.toContain("Updates shown for this source");
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
      { props: { initialChangeId: "change-orphan" }, pressedLabel: "Updates" },
      { props: { initialSourceId: "source-apply", initialChangeId: "change-apply" }, pressedLabel: "Official sources" },
    ];
    for (const { props, pressedLabel } of cases) {
      const html = renderToStaticMarkup(
        createElement(PublicAwardWorkspace, { data: makeDeepLinkPageData(), ...props }),
      );
      const buttons = outlineButtons(html);

      expect(buttons.length, JSON.stringify(props)).toBe(6);
      expect(buttons.filter((button) => button.includes('aria-pressed="true"')), JSON.stringify(props)).toHaveLength(1);
      expect(buttons.filter((button) => button.includes('aria-pressed="false"')), JSON.stringify(props)).toHaveLength(5);
      expect(buttons.filter((button) => button.includes('aria-controls="public-award-panel"')), JSON.stringify(props)).toHaveLength(6);
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
      { props: { initialChangeId: "change-orphan" }, heading: "Updates" },
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
    for (const kind of ["eligibility", "dates", "application", "sources"] as const) {
      expect(changeIdsToMarkRead(data, noneRead, { kind })).toEqual([]);
    }
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
      "  useEffect(() => {\n    if (!shouldRevealPanel(activation.revealSequence)) return;\n    revealSelectedPanel(panelRef.current, readPanelRevealEnvironment(), activationOrigin.current);\n  }, [activation.revealSequence]);",
    );
    const activation = source.slice(source.indexOf("const activatePanel = "), source.indexOf("useEffect(() => {"));
    expect(activation).toContain("markChangesRead(changeIdsToMarkRead(data, readChangeIds, next));");
    expect(activation).toContain(
      "setActivation((state) => activatePanelSelection(state, next, (panel) => isKnownPanel(data, panel)));",
    );
    expect(source.match(/setActivation\(/g)).toHaveLength(1);
    expect(source).not.toContain("setSelected");
    expect(source.match(/revealSelectedPanel\(/g)).toHaveLength(1);
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
    const textSelector = ".public-award-console-collapsed .public-award-nav-text {";
    const desktopHide = css.search(
      /\.public-award-console-collapsed \.public-award-nav-text \{\s*display: none;\s*\}/,
    );
    expect(desktopHide).toBeGreaterThan(0);

    const compactStart = css.indexOf("@media (max-width: 720px) {", css.indexOf("grid-area: panel;"));
    expect(compactStart).toBeGreaterThan(desktopHide);
    const compactEnd = css.slice(compactStart).search(/\r?\n\}/) + compactStart;
    const compact = css.slice(compactStart, compactEnd);

    // The text wrapper belongs to a compact rule whose body restores display,
    // and that rule comes after the desktop hide, so the cascade restores it.
    const selectorAt = compact.indexOf(textSelector);
    expect(selectorAt).toBeGreaterThan(0);
    const ruleOpen = compact.indexOf("{", selectorAt);
    expect(compact.slice(selectorAt, ruleOpen)).not.toContain("}");
    const body = compact.slice(ruleOpen, compact.indexOf("}", ruleOpen));
    expect(body).toMatch(/^\{\s*display: grid;\s*$/);
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

describe("public award source identity", () => {
  const documentA = "https://nspires.nasaprs.com/external/viewrepositorydocument?cmdocumentid=1075626";
  const documentB = "https://nspires.nasaprs.com/external/viewrepositorydocument?cmdocumentid=1138353";

  function identityData(firstUrl: string, secondUrl: string): PublicAwardPageData {
    const data: PublicAwardPageData = makeDeepLinkPageData();
    data.sources[0].title = "First document";
    data.sources[0].url = firstUrl;
    data.sources[1].title = "Second document";
    data.sources[1].url = secondUrl;
    data.changes = data.changes.slice(0, 2);
    data.changes[0].sourceUrl = firstUrl;
    data.changes[1].sourceUrl = secondUrl;
    return data;
  }

  function selectedSourcePanel(data: PublicAwardPageData, sourceId = "source-apply") {
    return panelMarkup(renderToStaticMarkup(createElement(PublicAwardWorkspace, {
      data, initialSourceId: sourceId,
    })));
  }

  it("keeps query-addressed documents' histories and unread changes separate", () => {
    const data = identityData(documentA, documentB);
    const panel = selectedSourcePanel(data);
    expect(panel).toContain("The application instructions changed.");
    expect(panel).not.toContain("The homepage changed.");
    expect(changeIdsToMarkRead(data, new Set(), { kind: "source", sourceId: "source-apply" }))
      .toEqual(["change-apply"]);
  });

  it("opens the exact source ID for a change-only link even when another source has the same URL", () => {
    const data = identityData(documentA, documentA);
    const panel = panelMarkup(renderToStaticMarkup(createElement(PublicAwardWorkspace, {
      data, initialChangeId: "change-apply",
    })));
    expect(panel).toContain('<h2 id="public-award-panel-heading">Second document</h2>');
    expect(panel).not.toContain("The homepage changed.");
    expectSingleHighlightedChange(panel, "The application instructions changed.");
    expect(changeIdsToMarkRead(data, new Set(), { kind: "source", sourceId: "source-apply" }))
      .toEqual(["change-apply"]);
  });

  it("does not highlight another source's change when the requested source shares its URL", () => {
    const data = identityData(documentA, documentA);
    const panel = panelMarkup(renderToStaticMarkup(createElement(PublicAwardWorkspace, {
      data, initialSourceId: "source-home", initialChangeId: "change-apply",
    })));
    expect(panel).toContain("The homepage changed.");
    expect(panel).not.toContain("The application instructions changed.");
    expect(panel).not.toContain("Selected update");
  });

  it("leaves a change with a retired source ID in Updates even when a listed source shares its URL", () => {
    const data = identityData(documentA, documentB);
    data.changes[1].sourceId = "source-retired";
    data.changes[1].sourceUrl = documentA;
    const panel = panelMarkup(renderToStaticMarkup(createElement(PublicAwardWorkspace, {
      data, initialChangeId: "change-apply",
    })));
    expect(panel).toContain('<h2 id="public-award-panel-heading">Updates</h2>');
    expectSingleHighlightedChange(panel, "The application instructions changed.");
    expect(changeIdsToMarkRead(data, new Set(), { kind: "source", sourceId: "source-home" }))
      .toEqual(["change-home"]);
  });

  it.each([
    ["query document IDs", documentA, documentB],
    ["path case", "https://example.edu/Guide.pdf", "https://example.edu/guide.pdf"],
    ["query value case", "https://example.edu/document?id=Guide", "https://example.edu/document?id=guide"],
    ["query key case", "https://example.edu/document?ID=1", "https://example.edu/document?id=1"],
    ["query order", "https://example.edu/document?id=1&view=full", "https://example.edu/document?view=full&id=1"],
    ["trailing slashes", "https://example.edu/document/", "https://example.edu/document"],
  ])("preserves %s when a legacy change has no source ID", (_label, firstUrl, secondUrl) => {
    const data = identityData(firstUrl, secondUrl);
    data.changes.forEach((change) => { change.sourceId = null; });
    const panel = panelMarkup(renderToStaticMarkup(createElement(PublicAwardWorkspace, {
      data, initialChangeId: "change-apply",
    })));
    expect(panel).toContain('<h2 id="public-award-panel-heading">Second document</h2>');
    expect(panel).not.toContain("The homepage changed.");
    expectSingleHighlightedChange(panel, "The application instructions changed.");
    expect(changeIdsToMarkRead(data, new Set(), { kind: "source", sourceId: "source-apply" }))
      .toEqual(["change-apply"]);
  });

  it.each(["", "not a URL", "javascript:alert(1)"])("never associates absent IDs through an invalid URL (%s)", (url) => {
    const data = identityData(documentA, url);
    data.changes[1].sourceId = null;
    const panel = selectedSourcePanel(data);
    expect(panel).not.toContain("The application instructions changed.");
    expect(changeIdsToMarkRead(data, new Set(), { kind: "source", sourceId: "source-apply" }))
      .toEqual([]);
  });

  it.each([null, ""])("supports fragment-only URL differences for an absent source ID (%s) without overriding a known ID", (sourceId) => {
    const data = identityData(documentA, documentB);
    data.changes[1].sourceId = sourceId;
    data.changes[1].sourceUrl = `${documentB}#page=2`;
    expect(selectedSourcePanel(data)).toContain("The application instructions changed.");
    expect(changeIdsToMarkRead(data, new Set(), { kind: "source", sourceId: "source-apply" }))
      .toEqual(["change-apply"]);
    data.changes[1].sourceId = "source-home";
    expect(changeIdsToMarkRead(data, new Set(), { kind: "source", sourceId: "source-apply" }))
      .toEqual([]);
  });

  it("uses the known source ID even when its recorded URL differs", () => {
    const data = identityData(documentA, documentB);
    data.changes[1].sourceUrl = "https://example.edu/previous-address";
    expect(selectedSourcePanel(data)).toContain("The application instructions changed.");
    expect(changeIdsToMarkRead(data, new Set(), { kind: "source", sourceId: "source-apply" }))
      .toEqual(["change-apply"]);
  });

  it("does not label a query-addressed source as the homepage of another document", () => {
    const data = identityData(documentA, documentB);
    data.officialHomepage = documentA;
    expect(selectedSourcePanel(data)).toContain('<h2 id="public-award-panel-heading">Second document</h2>');
    expect(filterAwardSources([...data.sources].reverse(), "", data.officialHomepage).map((source) => source.id))
      .toEqual(["source-home", "source-apply"]);
  });
});

describe("public award update source display titles", () => {
  const targetSummary = "The target application deadline changed.";
  const recordedTitle = "Recorded publisher title before source review";
  const sharedUrl = "https://example.edu/fellowship/shared";
  const listedSources = () => [
    makeSource({ id: "source-faq", title: "Example Fellowship Frequently Asked Questions", url: sharedUrl }),
    makeSource({ id: "source-application", title: "Example Fellowship | Application Process", url: sharedUrl }),
  ];

  function namingData(
    sources: ReturnType<typeof makeSource>[],
    change: Partial<PublicAwardPageData["changes"][number]> = {},
  ): PublicAwardPageData {
    const data: PublicAwardPageData = makePageData({ sources, changes: [] });
    data.changes = [
      {
        id: "change-target", sourceId: sources[0]?.id ?? null,
        sourceTitle: recordedTitle, sourceUrl: sources[0]?.url ?? sharedUrl,
        sourcePageType: "application", summary: targetSummary, changeDetails: {},
        detectedAt: "2026-07-04T12:00:00.000Z", ...change,
      },
      {
        id: "change-unlisted", sourceId: "source-retired",
        sourceTitle: "Retired source", sourceUrl: "https://example.edu/retired",
        sourcePageType: "application", summary: "The retired guidance changed.", changeDetails: {},
        detectedAt: "2026-07-03T12:00:00.000Z",
      },
    ];
    return data;
  }

  function updatePanel(data: PublicAwardPageData, sourceId?: string) {
    const html = panelMarkup(renderToStaticMarkup(createElement(PublicAwardWorkspace, {
      data,
      ...(sourceId ? { initialSourceId: sourceId } : { initialChangeId: "change-unlisted" }),
    })));
    // The real deep-link path must select the intended panel, not Overview.
    expect(html).toContain(`<h2 id="${PUBLIC_AWARD_PANEL_HEADING_ID}">`);
    expect(html).toContain(sourceId ? "Updates shown for this source" : `<h2 id="${PUBLIC_AWARD_PANEL_HEADING_ID}">Updates</h2>`);
    return html;
  }

  function targetRow(html: string) {
    const rows = [...html.matchAll(/<article\b[^>]*>[\s\S]*?<\/article>/g)]
      .map(([row]) => row)
      .filter((row) => row.includes(`<p>${targetSummary}</p>`));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain('class="public-award-change-line"');
    return rows[0];
  }

  function expectTargetHeading(html: string, title: string) {
    const row = targetRow(html);
    expect(row.match(/<h3>([\s\S]*?)<\/h3>/)?.[1]).toBe(title);
  }

  it.each([
    ["homepage", "Example Fellowship Application", "https://example.edu/fellowship", "Homepage"],
    ["FAQ", "Example Fellowship Frequently Asked Questions", "https://example.edu/fellowship/faq", "FAQ"],
    ["piped application", "Example Fellowship | Application Process", "https://example.edu/fellowship/apply", "Application Process"],
  ])("uses the Official sources %s title in both update contexts", (_label, title, url, expected) => {
    const data = namingData([makeSource({ id: "source-target", title, url })], { sourceTitle: title });
    const original = structuredClone(data);
    const sourceList = renderToStaticMarkup(createElement(AwardSourcesPanel, { data, onSelectSource: () => {} }));
    expect(sourceList).toContain(`<strong>${expected}</strong>`);
    for (const panel of [updatePanel(data, "source-target"), updatePanel(data)]) {
      expectTargetHeading(panel, expected);
    }
    expect(data).toEqual(original);
  });

  it.each([false, true])("uses the retained ID despite duplicate URLs (reversed=%s)", (reverse) => {
    const sources = listedSources();
    if (reverse) sources.reverse();
    const data = namingData(sources, { sourceId: "source-application" });
    expectTargetHeading(updatePanel(data, "source-application"), "Application Process");
    expectTargetHeading(updatePanel(data), "Application Process");
    expect(updatePanel(data, "source-faq")).not.toContain(`<p>${targetSummary}</p>`);
  });

  it("uses a retained ID's listed title even when the recorded URL points elsewhere", () => {
    const data = namingData(listedSources(), {
      sourceId: "source-faq", sourceUrl: "https://example.edu/older-document",
    });
    expectTargetHeading(updatePanel(data, "source-faq"), "FAQ");
    expectTargetHeading(updatePanel(data), "FAQ");
  });

  it("keeps an unlisted retained ID's recorded title despite a matching listed URL", () => {
    const data = namingData(listedSources(), { sourceId: "source-no-longer-listed" });
    expectTargetHeading(updatePanel(data), recordedTitle);
    for (const source of data.sources) {
      expect(updatePanel(data, source.id)).not.toContain(`<p>${targetSummary}</p>`);
    }
  });

  it.each([
    [null, ""], [null, "#requirements"], ["", ""], ["", "#requirements"],
  ])("uses a unique document match for an absent ID (%s, %s)", (sourceId, fragment) => {
    const source = listedSources()[1];
    const data = namingData([source], { sourceId, sourceUrl: `${source.url}${fragment}` });
    expectTargetHeading(updatePanel(data, source.id), "Application Process");
    expectTargetHeading(updatePanel(data), "Application Process");
  });

  it.each([
    [false, "source-faq"], [false, "source-application"], [false, undefined],
    [true, "source-faq"], [true, "source-application"], [true, undefined],
  ] as const)("keeps an idless ambiguous title using the full roster (reversed=%s, panel=%s)", (reverse, panelSourceId) => {
    const sources = listedSources();
    if (reverse) sources.reverse();
    const data = namingData(sources, { sourceId: null, sourceUrl: `${sharedUrl}#deadline` });
    // Both source panels legitimately include this legacy URL-attributed event;
    // neither selected source makes its *display-name* attribution unique.
    expectTargetHeading(updatePanel(data, panelSourceId), recordedTitle);
  });

  it.each([
    ["empty URL", "", ""],
    ["malformed URL", "not a URL", "not a URL"],
    ["non-HTTP URL", "javascript:alert(1)", "javascript:alert(1)"],
    ["query document", "https://example.edu/document?id=1", "https://example.edu/document?id=2"],
    ["path case", "https://example.edu/Guide.pdf", "https://example.edu/guide.pdf"],
    ["query key case", "https://example.edu/document?ID=1", "https://example.edu/document?id=1"],
    ["query value case", "https://example.edu/document?id=Guide", "https://example.edu/document?id=guide"],
    ["query order", "https://example.edu/document?id=1&view=full", "https://example.edu/document?view=full&id=1"],
    ["trailing slash", "https://example.edu/document/", "https://example.edu/document"],
  ])("does not relabel an idless event through a nonmatching %s", (_label, listedUrl, eventUrl) => {
    const data = namingData([makeSource({ id: "source-target", title: "Example Fellowship | Application Process", url: listedUrl })], {
      sourceId: null, sourceUrl: eventUrl,
    });
    expectTargetHeading(updatePanel(data), recordedTitle);
    expect(updatePanel(data, "source-target")).not.toContain(`<p>${targetSummary}</p>`);
  });

  it("changes only the heading, preserving recorded data and evidence/preview props", () => {
    const data = namingData([listedSources()[1]]);
    data.changes[0].changeDetails = {
      before: "Applications close April 1.", after: "Applications close April 15.",
      reader_summary: targetSummary, confidence: "high", change_type: "deadline_change",
      structured_diff: { added_text: ["Applications close April 15."], removed_text: ["Applications close April 1."] },
    };
    const original = structuredClone(data);
    // Spies call the real components; the SSR tree and evidence remain real.
    const preview = vi.spyOn(SnapshotViewer, "SourceSnapshotInlinePreview");
    const evidence = vi.spyOn(ChangeEvidence, "ChangeEvidencePanel");
    try {
      const panel = updatePanel(data, "source-application");
      expectTargetHeading(panel, "Application Process");
      const expectedProps = {
        changeEventId: "change-target", sourceId: "source-application",
        sourceTitle: recordedTitle, sourceUrl: sharedUrl,
        changeDetails: data.changes[0].changeDetails,
      };
      const previewProps = preview.mock.calls.find(([props]) => props.changeEventId === "change-target")?.[0];
      const evidenceProps = evidence.mock.calls.find(([props]) => props.changeEventId === "change-target")?.[0];
      expect(previewProps).toMatchObject({ ...expectedProps, changeSummary: targetSummary });
      expect(evidenceProps).toMatchObject({ ...expectedProps, summary: targetSummary });
      expect(previewProps?.changeDetails).toBe(data.changes[0].changeDetails);
      expect(evidenceProps?.changeDetails).toBe(data.changes[0].changeDetails);
      expect(targetRow(panel)).toContain("Loading screenshot preview...");
      expect(targetRow(panel)).toContain(">Snapshot</button>");
      expect(targetRow(panel)).toContain("Open source");
      expect(targetRow(panel)).not.toContain("View change explanation");
      expect(load(targetRow(panel))(".change-summary p").text()).toBe(targetSummary);
      expect(data).toEqual(original);
    } finally {
      preview.mockRestore();
      evidence.mockRestore();
    }
  });
});

describe("focused award sections", () => {
  it("separates program scope from the date without losing either Boren program", () => {
    const data: PublicAwardPageData = makeDeepLinkPageData();
    data.award.name = "Boren Scholarships and Fellowships";
    data.facts.deadline = "January 27, 2027 (Boren Scholarships)";
    data.facts.importantDates = ["January 20, 2027 (Boren Fellowships)"];
    const before = JSON.stringify(data);
    const overview = renderToStaticMarkup(createElement(PublicAwardWorkspace, { data }));
    const dates = renderToStaticMarkup(createElement(AwardFactsPanel, {
      facts: data.facts, awardName: data.award.name, section: "dates", onViewSources: () => {},
    }));
    for (const html of [overview, dates]) {
      expect(html).toContain("Scholarships deadline</dt><dd>January 27, 2027</dd>");
      expect(html).toContain("Fellowships: January 20, 2027");
      expect(html).not.toContain("(Boren Scholarships)");
      expect(html).not.toContain("(Boren Fellowships)");
    }
    expect(JSON.stringify(data)).toBe(before);
  });

  it("organizes existing facts without inferring new eligibility or deadlines", () => {
    const facts = {
      ...makeDeepLinkPageData().facts,
      howToApply: ["Apply through the official portal."],
      requirements: ["An institutional nomination is required."],
      applicationMaterials: ["Two references."],
      importantDates: ["Institutional deadlines vary."],
    };
    const renderSection = (section: "eligibility" | "dates" | "application") =>
      renderToStaticMarkup(createElement(AwardFactsPanel, { facts, section, onViewSources: () => {} }));
    const eligibility = renderSection("eligibility");
    expect(eligibility).toContain("Graduate students");
    expect(eligibility).not.toContain("institutional nomination");
    expect(eligibility).not.toContain("January 29, 2026");
    const dates = renderSection("dates");
    expect(dates).toContain("January 29, 2026");
    expect(dates).toContain("Institutional deadlines vary.");
    expect(dates).not.toContain("Two references.");
    const application = renderSection("application");
    expect(application).toContain("An institutional nomination is required.");
    expect(application).toContain("Apply through the official portal.");
    expect(application).toContain("Two references.");
    expect(application).not.toContain("Graduate students");
  });

  // The reported screenshot rendered this stored value verbatim on the card.
  const RAW_DEADLINE = "2026-03-27T17:00:00-05:00";
  const READABLE_DEADLINE = "March 27, 2026 at 5:00 p.m. (UTC-05:00)";
  const REVIEWED_PROSE = "Last Friday in January, 5:00 p.m. Central Time";

  function datesPanel(overrides: Partial<PublicAwardPageData["facts"]>) {
    return renderToStaticMarkup(createElement(AwardFactsPanel, {
      facts: { ...makeDeepLinkPageData().facts, ...overrides },
      section: "dates",
      onViewSources: () => {},
    }));
  }

  // Read the exact value text across inline zone spans, scoped to its own
  // labelled row rather than accepting a matching date elsewhere on the page.
  function factValue(markup: string, label: string) {
    const $ = load(markup);
    const rows = $(".public-award-key-fact, .public-award-fact-line")
      .filter((_index, row) => $(row).children("dt").text() === label);
    expect(rows.length, `Exactly one ${label} fact row`).toBe(1);
    return rows.children("dd");
  }
  const deadlineText = (markup: string) => factValue(markup, "Deadline").text();

  it.each(["Overview", "Dates"] as const)("renders Rhodes' day-first opening beside its existing deadline in %s", (panel) => {
    const data: PublicAwardPageData = makeDeepLinkPageData();
    // The date pair is from the saved public Rhodes projection, not a live read.
    data.award.name = "Rhodes Scholarship (United States)";
    data.canonicalPath = "/rhodes-scholarship";
    data.facts.openingDate = "1 July 2026";
    data.facts.deadline = "7 October 2026, 11:59 PM Eastern Time";
    const before = structuredClone(data);
    const html = panel === "Overview"
      ? renderToStaticMarkup(createElement(PublicAwardWorkspace, { data }))
      : renderToStaticMarkup(createElement(AwardFactsPanel, {
        facts: data.facts, awardName: data.award.name, section: "dates", onViewSources: () => {},
      }));
    expect(deadlineText(html)).toBe("October 7, 2026 at 11:59 p.m. (Eastern Time)");
    const opening = factValue(html, "Opening date");
    expect(opening.text()).toBe("July 1, 2026");
    expect(opening.find(".award-date-zone").length).toBe(0);
    expect(data).toEqual(before);
  });

  it.each(["Overview", "Dates"] as const)("groups only UTC tokens in %s date facts without changing ASCII text", (panel) => {
    const data: PublicAwardPageData = makeDeepLinkPageData();
    data.facts.deadline = RAW_DEADLINE;
    data.facts.openingDate = "2026-01-05T09:30:00+05:30";
    data.facts.importantDates = [
      "Notification: 2026-04-15T17:00:00Z",
      "2026-04-16T09:00:00+01:00: Interview note (UTC-09:00)",
    ];
    const before = structuredClone(data);
    const html = panel === "Overview"
      ? renderToStaticMarkup(createElement(PublicAwardWorkspace, { data }))
      : renderToStaticMarkup(createElement(AwardFactsPanel, {
        facts: data.facts, section: "dates", onViewSources: () => {},
      }));

    for (const [label, text, zone] of [
      ["Deadline", READABLE_DEADLINE, "(UTC-05:00)"],
      ["Opening date", "January 5, 2026 at 9:30 a.m. (UTC+05:30)", "(UTC+05:30)"],
    ]) {
      const value = factValue(html, label);
      expect(value.text()).toBe(text);
      expect(value.find("span.award-date-zone").length).toBe(1);
      expect(value.find("span.award-date-zone").text()).toBe(zone);
      expect(value.text()).not.toMatch(/[\u00a0\u2011]/);
    }
    const timeline = factValue(html, "Important dates");
    const $ = load(timeline.html() || "");
    expect($("li").map((_index, item) => $(item).text()).get()).toEqual([
      "Notification: April 15, 2026 at 5:00 p.m. (UTC)",
      "April 16, 2026 at 9:00 a.m. (UTC+01:00): Interview note (UTC-09:00)",
    ]);
    expect($("li > span.award-date-zone").map((_index, item) => $(item).text()).get())
      .toEqual(["(UTC)", "(UTC+01:00)"]);
    expect(data).toEqual(before);
  });

  it("does not group date-shaped text in non-date fact rows", () => {
    const data: PublicAwardPageData = makeDeepLinkPageData();
    data.facts.awardAmount = READABLE_DEADLINE;
    data.facts.eligibility = [READABLE_DEADLINE, "Policy note (UTC+05:30)"];
    data.facts.requirements = [READABLE_DEADLINE];
    const before = structuredClone(data);
    const html = renderToStaticMarkup(createElement(PublicAwardWorkspace, { data }));
    for (const label of ["Award amount", "Eligibility", "Requirements"]) {
      expect(factValue(html, label).find(".award-date-zone").length).toBe(0);
    }
    expect(factValue(html, "Award amount").text()).toBe(READABLE_DEADLINE);
    expect(factValue(html, "Requirements").text()).toBe(READABLE_DEADLINE);
    expect(factValue(html, "Eligibility").find("li").map((_index, item) => load(item).root().text()).get())
      .toEqual([READABLE_DEADLINE, "Policy note (UTC+05:30)"]);
    expect(data).toEqual(before);
  });

  it("groups semicolon-separated Important dates itemwise while keeping the separate prose item literal", () => {
    const importantDates = ["Interviews: 2026-03-27T09:00:00Z; Office note (UTC-05:00)"];
    const before = [...importantDates];
    const value = factValue(datesPanel({ importantDates }), "Important dates");
    const $ = load(value.html() || "");
    const items = $("ul.public-award-fact-list > li");
    expect(items.length).toBe(2);
    expect(items.map((_index, item) => $(item).text()).get()).toEqual([
      "Interviews: March 27, 2026 at 9:00 a.m. (UTC)", "Office note (UTC-05:00)",
    ]);
    expect(items.eq(0).find("span.award-date-zone").length).toBe(1);
    expect(items.eq(0).find("span.award-date-zone").text()).toBe("(UTC)");
    expect(items.eq(1).find(".award-date-zone").length).toBe(0);
    expect(importantDates).toEqual(before);
  });

  it.each([
    "March 27, 2026 at 5:00 p.m. (UTC-05:00) (tentative)",
    "February 30, 2026 at 5:00 p.m. (UTC-05:00)",
    "March 27, 2026 at 5:00 p.m. (UTC-00:00)",
    "If eligible, March 27, 2026 at 5:00 p.m. (UTC-05:00)",
    "2026-02-30: March 27, 2026 at 5:00 p.m. (UTC-05:00)",
  ])("keeps unsupported date prose ungrouped: %s", (deadline) => {
    const value = factValue(datesPanel({ deadline }), "Deadline");
    expect(value.text()).toBe(deadline);
    expect(value.find(".award-date-zone").length).toBe(0);
  });

  it.each(["Overview", "Dates"] as const)("formats a recurring numeric-zone deadline and groups only its canonical UTC token in %s", (panel) => {
    const data: PublicAwardPageData = makeDeepLinkPageData();
    data.facts.deadline = "Last Friday in January, 5:00 p.m. (UTC-05:00)";
    const before = structuredClone(data);
    const html = panel === "Overview"
      ? renderToStaticMarkup(createElement(PublicAwardWorkspace, { data }))
      : renderToStaticMarkup(createElement(AwardFactsPanel, {
        facts: data.facts, section: "dates", onViewSources: () => {},
      }));
    const value = factValue(html, "Deadline");
    expect(value.text()).toBe("Last Friday in January at 5:00 p.m. (UTC-05:00)");
    expect(value.find("span.award-date-zone").length).toBe(1);
    expect(value.find("span.award-date-zone").text()).toBe("(UTC-05:00)");
    expect(data).toEqual(before);
  });

  it("renders a raw machine deadline in the reviewed house style, in both panels", () => {
    const data: PublicAwardPageData = makeDeepLinkPageData();
    const html = renderToStaticMarkup(createElement(PublicAwardWorkspace, {
      data: { ...data, facts: { ...data.facts, deadline: RAW_DEADLINE } },
    }));

    expect(deadlineText(html)).toBe(READABLE_DEADLINE);
    expect(html).not.toContain(RAW_DEADLINE);
    expect(html).not.toContain("T17:00:00");
    expect(deadlineText(datesPanel({ deadline: RAW_DEADLINE }))).toBe(READABLE_DEADLINE);
  });

  it("gives Gilman's screenshot deadline the same time typography in Overview and Dates without changing the fact", () => {
    const data: PublicAwardPageData = makeDeepLinkPageData();
    data.award.name = "Benjamin A. Gilman International Scholarship";
    data.facts.deadline = "October 1, 2026 at 11:59PM PT";
    const before = structuredClone(data);
    const overview = renderToStaticMarkup(createElement(PublicAwardWorkspace, { data }));
    const dates = renderToStaticMarkup(createElement(AwardFactsPanel, {
      facts: data.facts, awardName: data.award.name, section: "dates", onViewSources: () => {},
    }));

    for (const html of [overview, dates]) {
      expect(deadlineText(html)).toBe("October 1, 2026 at 11:59 p.m. (PT)");
      expect(html).not.toContain("11:59PM");
    }
    expect(data).toEqual(before);
    expect(data.facts.deadline).toBe("October 1, 2026 at 11:59PM PT");
  });

  it.each(["Overview", "Dates"] as const)("renders SMART's clock-first recurrence in %s while retaining its explicit year and raw fact", (panel) => {
    const data: PublicAwardPageData = makeDeepLinkPageData();
    data.award.name = "SMART Scholarship-for-Service Program";
    data.facts.deadline = "5:00 p.m. EST on the first Friday in December 2026";
    const before = structuredClone(data);
    const html = panel === "Overview"
      ? renderToStaticMarkup(createElement(PublicAwardWorkspace, { data }))
      : renderToStaticMarkup(createElement(AwardFactsPanel, {
        facts: data.facts, awardName: data.award.name, section: "dates", onViewSources: () => {},
      }));

    expect(deadlineText(html)).toBe("First Friday in December 2026 at 5:00 p.m. (EST)");
    expect(factValue(html, "Deadline").find(".award-date-zone").length).toBe(0);
    expect(data).toEqual(before);
  });

  it.each(["Overview", "Dates"] as const)("gives Goldwater's recurring deadline and labeled timeline the shared style in %s without changing reviewed facts", (panel) => {
    const data: PublicAwardPageData = makeDeepLinkPageData();
    data.award.name = "Barry Goldwater Scholarship";
    data.facts.deadline = REVIEWED_PROSE;
    data.facts.openingDate = "Opens each September";
    data.facts.importantDates = [
      `Nomination deadline: ${REVIEWED_PROSE}`,
      "Institutional deadlines vary.",
    ];
    const before = structuredClone(data);
    const html = panel === "Overview"
      ? renderToStaticMarkup(createElement(PublicAwardWorkspace, { data }))
      : renderToStaticMarkup(createElement(AwardFactsPanel, {
        facts: data.facts, awardName: data.award.name, section: "dates", onViewSources: () => {},
      }));

    expect(deadlineText(html)).toBe("Last Friday in January at 5:00 p.m. (Central Time)");
    expect(factValue(html, "Deadline").find(".award-date-zone").length).toBe(0);
    expect(factValue(html, "Opening date").text()).toBe("Opens each September");
    const timeline = factValue(html, "Important dates");
    const $ = load(timeline.html() || "");
    expect($("li").map((_index, item) => $(item).text()).get()).toEqual([
      "Nomination deadline: Last Friday in January at 5:00 p.m. (Central Time)",
      "Institutional deadlines vary.",
    ]);
    expect(data).toEqual(before);
    expect(data.facts.deadline).toBe(REVIEWED_PROSE);
  });

  it.each([
    // A date with no time keeps its day and gains no invented hour or zone.
    { label: "a date-only deadline", deadline: "2026-03-27", expected: "March 27, 2026" },
    { label: "a UTC instant", deadline: "2026-03-27T17:00:00Z", expected: "March 27, 2026 at 5:00 p.m. (UTC)" },
    // An impossible date is never rolled forward into a plausible deadline.
    { label: "an impossible date", deadline: "2026-02-30", expected: "2026-02-30" },
    { label: "unknown prose", deadline: "TBA", expected: "TBA" },
    { label: "a rolling deadline", deadline: "Rolling", expected: "Rolling" },
  ])("renders $label as $expected", ({ deadline, expected }) => {
    expect(deadlineText(datesPanel({ deadline }))).toBe(expected);
  });

  it("styles opening dates and important-date items the same way", () => {
    const html = datesPanel({
      deadline: null,
      openingDate: "2026-01-05",
      importantDates: ["Interviews: 2026-03-27T09:00:00Z", "Institutional deadlines vary."],
    });

    expect(html).toContain("January 5, 2026");
    const dates = factValue(html, "Important dates");
    expect(dates.find("li").map((_index, item) => load(item).root().text()).get()).toEqual([
      "Interviews: March 27, 2026 at 9:00 a.m. (UTC)", "Institutional deadlines vary.",
    ]);
    expect(html).toContain("Institutional deadlines vary.");
    expect(html).not.toContain("2026-01-05");
    expect(html).not.toContain("T09:00:00");
  });

  it("formats each semicolon-separated timeline item without losing an event label", () => {
    const html = datesPanel({ importantDates: ["Interviews: 2027-03-01; Ceremony: 2027-05-01"] });
    expect(html).toContain("<li>Interviews: March 1, 2027</li>");
    expect(html).toContain("<li>Ceremony: May 1, 2027</li>");
  });

  it("explains missing details and offers sources instead of inventing a value", () => {
    const html = renderToStaticMarkup(createElement(AwardFactsPanel, {
      facts: makeDeepLinkPageData().facts, section: "application", onViewSources: () => {},
    }));
    expect(html).toContain("These details are not available yet.");
    expect(html).toContain("View official sources");
    expect(html).not.toContain("January 29, 2026");
  });

  it.each([
    { lastCheckedAt: null, dateText: "Source check date unavailable" },
    { lastCheckedAt: "2026-06-26T12:00:00.000Z", dateText: "Last source check Jun 26, 2026" },
  ])("keeps the six sections and labels the empty overview's date: $dateText", ({ lastCheckedAt, dateText }) => {
    const fixture = makeDeepLinkPageData();
    const data: PublicAwardPageData = {
      ...fixture, facts: fixture.sources[0].facts, sources: [], changes: [], lastCheckedAt,
    };
    const before = structuredClone(data);
    const html = renderToStaticMarkup(createElement(PublicAwardWorkspace, { data }));
    const dateSpan = asideMarkup(html).match(
      /<div class="public-award-sidebar-header"><div class="min-w-0"><p>On this award<\/p><span>([^<]*)<\/span>/,
    );
    expect(dateSpan, "The sidebar-header source-check date span must exist").not.toBeNull();
    expect(dateSpan?.[1]).toBe(dateText);
    expect(panelMarkup(html)).toContain("Award details are not available yet.");
    expect(asideMarkup(html)).toContain("0 source pages");
    expect(asideMarkup(html).match(/aria-pressed=/g)).toHaveLength(6);
    expect(html).not.toContain("January 29, 2026");
    expect(data).toEqual(before);
  });

  it("searches all sources by title, type and address and restores them when cleared", () => {
    const sources = [
      ...makeDeepLinkPageData().sources,
      makeSource({ id: "pdf", pageType: "pdf", title: "Program guide", url: "https://example.edu/documents/guide.pdf" }),
    ];
    expect(filterAwardSources(sources, "  PDF GUIDE ").map((source) => source.id)).toEqual(["pdf"]);
    expect(filterAwardSources(sources, "instructions").map((source) => source.id)).toEqual(["source-apply"]);
    expect(filterAwardSources(sources, "documents").map((source) => source.id)).toEqual(["pdf"]);
    expect(filterAwardSources(sources, "not-a-source")).toEqual([]);
    expect(filterAwardSources(sources, " ")).toEqual(sources);
    expect(sources).toHaveLength(3);
  });

  it("wires Clear search to restore input focus before removing the recovery button", () => {
    // This pins event wiring, not browser focus behavior; the latter is checked
    // with a keyboard in the local fictional-data preview.
    const source = readFileSync(new URL("./public-award-workspace.tsx", import.meta.url), "utf8");
    const panel = source.slice(source.indexOf("export function AwardSourcesPanel("), source.indexOf("function OverviewPanel("));
    expect(panel).toContain("const searchInputRef = useRef<HTMLInputElement>(null)");
    expect(panel).toContain('id="award-source-search" ref={searchInputRef} type="search"');
    expect(panel).toMatch(/onClick=\{\(\) => \{[\s\S]*?searchInputRef\.current\?\.focus\(\);\s*setQuery\(""\);\s*\}\}>Clear search<\/button>/);
  });

  it("puts the reviewed homepage first without dropping or mutating sources", () => {
    const data = makeDeepLinkPageData();
    const sources = [...data.sources].reverse();
    const originalIds = sources.map((source) => source.id);
    const sorted = filterAwardSources(sources, "", data.officialHomepage);
    expect(sorted.map((source) => source.id)).toEqual(["source-home", "source-apply"]);
    expect(sources.map((source) => source.id)).toEqual(originalIds);
    expect(filterAwardSources(sources, "instructions", data.officialHomepage).map((source) => source.id)).toEqual(["source-apply"]);
  });

  it("describes the bounded update window without claiming lifetime history totals", () => {
    const data = makeDeepLinkPageData();
    data.changes = Array.from({ length: 8 }, (_, index) => ({ ...data.changes[0], id: `recent-${index}` }));
    const html = renderToStaticMarkup(createElement(PublicAwardWorkspace, { data }));
    expect(asideMarkup(html)).toContain("8 updates shown");
    expect(asideMarkup(html)).not.toContain("recorded update");
    const sourceHtml = renderToStaticMarkup(createElement(AwardSourcesPanel, {
      data, onSelectSource: () => {}, sourceChangeCounts: new Map([["source-home", 8]]),
    }));
    expect(sourceHtml).toContain("8 updates shown");
    expect(sourceHtml).toContain("0 updates shown");
    expect(sourceHtml).not.toContain("recorded update");
    const emptySource = renderToStaticMarkup(createElement(PublicAwardWorkspace, { data, initialSourceId: "source-apply" }));
    expect(emptySource).toContain("No updates for this source are included in this view.");
    expect(emptySource).not.toContain("No meaningful updates have been recorded");
    const populatedSource = renderToStaticMarkup(createElement(PublicAwardWorkspace, { data, initialSourceId: "source-home" }));
    for (const sourceHtml of [emptySource, populatedSource]) {
      expect(panelMarkup(sourceHtml)).toContain("<h2>Updates shown for this source</h2>");
      expect(panelMarkup(sourceHtml)).not.toContain("<h2>Source update history</h2>");
    }
  });
});

describe("public award source labels", () => {
  const AWARD_NAME = "Example Fellowship";
  const NON_HOMEPAGE_URL = "https://example.edu/admissions.htm";

  function sourceRows(sources: ReturnType<typeof makeSource>[]) {
    const data = makePageData({ sources, changes: [] });
    const original = structuredClone(data);
    const $ = load(
      renderToStaticMarkup(createElement(AwardSourcesPanel, { data, onSelectSource: () => {} })),
    );
    // Labelling is display work, so every loader row must come back untouched:
    // identifier, slug, public path and the address with its query intact.
    expect(data).toEqual(original);
    return $(".public-award-source-choice")
      .map((_index, node) => ({
        label: $(node).find("strong").text(),
        purpose: $(node).find(".public-award-source-purpose span").first().text(),
        address: $(node).find(".public-award-source-address").text(),
        titleAttribute: $(node).attr("title"),
      }))
      .get();
  }

  // A stored title that is exactly the award name names the program, not the
  // page, so it cannot tell one document from another. Calling such a page the
  // homepage was wrong; the address is the only thing left that identifies it.
  it.each([
    ["exactly", AWARD_NAME],
    ["in lower case", "example fellowship"],
    ["in upper case", "EXAMPLE FELLOWSHIP"],
    ["with surrounding space", "  Example Fellowship  "],
  ])("labels a non-homepage source from its address when the title is the award name %s", (_case, title) => {
    const [row] = sourceRows([
      makeSource({ id: "source-admissions", pageType: "other", title, url: NON_HOMEPAGE_URL }),
    ]);

    expect(row.label).toBe("Admissions");
    expect(row.purpose).toBe("Other source");
    expect(row.address).toBe(NON_HOMEPAGE_URL);
    expect(row.titleAttribute).toBe(title);
  });

  it.each<[string, "homepage" | "other", string]>([
    ["the homepage page type at another address", "homepage", "https://example.edu/other-page"],
    ["the official homepage address", "other", "https://example.edu/fellowship"],
    ["the official homepage at the homepage page type", "homepage", "https://example.edu/fellowship"],
  ])("still labels %s as Homepage", (_case, pageType, url) => {
    const [row] = sourceRows([makeSource({ id: "source-home", pageType, title: AWARD_NAME, url })]);

    expect(row.label).toBe("Homepage");
  });

  it.each([
    ["a shorter fragment of the award name", "Example", "Example"],
    ["a specific document title", "Example Fellowship | Application Process", "Application Process"],
    ["a title unrelated to the award name", "Selection Committee Charter", "Selection Committee Charter"],
    ["a title the existing shortener already trims", "Example Fellowship Admissions", "Admissions"],
  ])("keeps the existing label for %s", (_case, title, expected) => {
    const [row] = sourceRows([
      makeSource({ id: "source-other", pageType: "other", title, url: NON_HOMEPAGE_URL }),
    ]);

    expect(row.label).toBe(expected);
  });

  it.each([
    ["a query string", "https://example.edu/admissions.htm?cycle=2027&ref=a%20b"],
    ["a fragment", "https://example.edu/admissions.htm#deadlines"],
    ["a path segment the address reader skips", "https://example.edu/programs/admissions.htm"],
  ])("keeps the exact address and identifiers for %s", (_case, url) => {
    const source = makeSource({ id: "source-admissions", pageType: "other", title: AWARD_NAME, url });
    const [row] = sourceRows([source]);

    expect(row.label).toBe("Admissions");
    expect(row.address).toBe(url);
    expect(source.id).toBe("source-admissions");
    expect(source.sourceSlug).toBe("source-admissions");
    expect(source.publicPath).toBe("/example-fellowship");
    expect(source.url).toBe(url);
  });

  it.each([
    ["an empty address", ""],
    ["an address that is not a URL", "not-a-url"],
    ["a generic programs path", "https://example.edu/programs/"],
    ["a generic resources index", "https://example.edu/resources/index.htm"],
    ["a root address that is not the official homepage", "https://another.example.edu/"],
  ])("uses the existing generic label for %s", (_case, url) => {
    const [row] = sourceRows([
      makeSource({ id: "source-broken", pageType: "other", title: AWARD_NAME, url }),
    ]);

    expect(row.label).toBe("Source");
    expect(row.address).toBe(url);
  });

  it("normalizes an all-capital admissions label without changing the original address or title", () => {
    const [row] = sourceRows([
      makeSource({
        id: "source-shouting",
        pageType: "other",
        title: AWARD_NAME,
        url: "https://example.edu/ADMISSIONS.htm",
      }),
    ]);

    expect(row.label).toBe("Admissions");
    expect(row.address).toBe("https://example.edu/ADMISSIONS.htm");
    expect(row.titleAttribute).toBe(AWARD_NAME);
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
  pageType?: "application" | "pdf" | "homepage" | "other";
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

/**
 * Criterion boundaries on the award page.
 *
 * The fact normalizer already decides where one criterion ends: reviewed
 * arrays arrive as whole items, and the legacy summary-derived fields are
 * split by `splitFact` before they leave `publicAwardFactsFromAward`. The
 * renderer therefore keeps the array items it is given. Re-splitting them
 * here broke a reviewed criterion that contains a semicolon into two rules,
 * the second starting mid-sentence.
 *
 * Scalar values keep the existing split, so dates and a single award amount
 * render exactly as before.
 */
describe("award page criterion boundaries", () => {
  // A reviewed criterion whose own wording contains a semicolon. This exact
  // string is a registered whole value in the directory filter taxonomy.
  const PROVISO = "Applicants must be non-Chinese citizens with a valid passport; former citizens of the Chinese Mainland, Hong Kong, Macao or Taiwan must present a valid passport or citizenship documents dating from before April 30, 2021, along with proof of cancellation of Chinese nationality.";

  const reviewed = (publicFacts: Record<string, Json>) => publicAwardFactsFromAward({ publicFacts });

  function renderSection(facts: PublicAwardPageData["facts"], section: "eligibility" | "dates" | "application") {
    return renderToStaticMarkup(
      createElement(AwardFactsPanel, { facts, section, onViewSources: vi.fn() }),
    );
  }

  /** Rendered criterion texts for one labelled row, list items or the single value. */
  function factItems(markup: string, label: string) {
    const $ = load(markup);
    const rows = $(".public-award-key-fact, .public-award-fact-line")
      .filter((_index, row) => $(row).children("dt").text() === label);
    expect(rows.length, `Exactly one ${label} fact row`).toBe(1);
    const value = rows.children("dd");
    const items = value.find("li");
    return items.length
      ? items.map((_index, item) => load(item).root().text()).get()
      : [value.text()];
  }

  /** [row label, public_facts key, facts key, section] */
  const LIST_FIELDS = [
    ["Eligibility", "eligibility", "eligibility", "eligibility"],
    ["Academic level", "academic_levels", "academicLevels", "eligibility"],
    ["Discipline", "disciplines", "disciplines", "eligibility"],
    ["Citizenship", "citizenship", "citizenship", "eligibility"],
    ["How to apply", "how_to_apply", "howToApply", "application"],
    ["Requirements", "requirements", "requirements", "application"],
    ["Application materials", "application_materials", "applicationMaterials", "application"],
    ["Documents", "documents", "documents", "application"],
    ["Contact", "contacts", "contacts", "application"],
  ] as const;

  it.each(LIST_FIELDS)("keeps one reviewed %s criterion whole", (label, key, factsKey, section) => {
    const facts = reviewed({ [key]: [PROVISO] });
    // The normalizer hands the renderer one item; the renderer must not split it.
    expect(facts[factsKey]).toEqual([PROVISO]);
    expect(factItems(renderSection(facts, section), label)).toEqual([PROVISO]);
  });

  it.each(LIST_FIELDS)("renders a compound %s criterion beside another as two, not three", (label, key, _factsKey, section) => {
    const facts = reviewed({ [key]: [PROVISO, "U.S. citizens"] });
    const markup = renderSection(facts, section);
    expect(factItems(markup, label)).toEqual([PROVISO, "U.S. citizens"]);
    expect(load(markup)("ul.public-award-fact-list > li")).toHaveLength(2);
  });

  it("renders a single reviewed criterion as plain text rather than a one-item list", () => {
    const markup = renderSection(reviewed({ citizenship: [PROVISO] }), "eligibility");
    expect(load(markup)("ul.public-award-fact-list")).toHaveLength(0);
    expect(factItems(markup, "Citizenship")).toEqual([PROVISO]);
  });

  it("still splits a legacy summary-derived eligibility at the normalizer", () => {
    const facts = publicAwardFactsFromAward({ summary: "An award. Eligibility: Alpha rule; Beta rule." });
    expect(facts.eligibility).toEqual(["Alpha rule", "Beta rule"]);
    expect(factItems(renderSection(facts, "eligibility"), "Eligibility")).toEqual(["Alpha rule", "Beta rule"]);
  });

  it("leaves the compound award amount split where the normalizer already splits it", () => {
    expect(publicAwardFactsFromAward({ publicFacts: { award_amounts: ["Full tuition; Living stipend"] } }).awardAmount)
      .toEqual(["Full tuition", "Living stipend"]);
  });

  it("leaves a scalar date value splitting exactly as before", () => {
    const one = renderSection(reviewed({ deadline: "March 1, 2027" }), "dates");
    const two = renderSection(reviewed({ deadline: "March 1; March 15" }), "dates");
    expect(load(one)("ul.public-award-fact-list > li")).toHaveLength(0);
    expect(load(two)("ul.public-award-fact-list > li")).toHaveLength(2);
  });

  it("omits the row entirely for empty and whitespace-only criteria", () => {
    for (const citizenship of [[], ["", "   "]]) {
      const markup = renderSection(reviewed({ citizenship }), "eligibility");
      const $ = load(markup);
      expect($(".public-award-fact-line").filter((_index, row) => $(row).children("dt").text() === "Citizenship"))
        .toHaveLength(0);
      expect($("li")).toHaveLength(0);
    }
  });

  it("drops a blank entry without dropping the criteria beside it", () => {
    const facts = reviewed({ citizenship: ["U.S. citizens", "   ", "DACA recipients"] });
    expect(factItems(renderSection(facts, "eligibility"), "Citizenship"))
      .toEqual(["U.S. citizens", "DACA recipients"]);
  });

  it("escapes criterion wording rather than emitting markup", () => {
    const value = "Students in R&D <programs> for \"applied\" work";
    const markup = renderSection(reviewed({ citizenship: [value, "U.S. citizens"] }), "eligibility");
    expect(markup).toContain("R&amp;D &lt;programs&gt;");
    expect(markup).not.toContain("<programs>");
    expect(factItems(markup, "Citizenship")).toEqual([value, "U.S. citizens"]);
  });
});
