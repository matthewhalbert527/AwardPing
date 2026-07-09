import { describe, expect, it } from "vitest";
import {
  compactAwardDirectorySummary,
  defaultAwardPlaceholderSummary,
  displayAwardSummary,
} from "@/lib/award-summary";
import { awardSeeds } from "@/lib/award-seeds";
import { awardSourceOverrides } from "@/lib/award-source-overrides";
import { normalizeSharedAwardKey } from "@/lib/shared-awards-core";
import {
  displayHomepageForAward,
  filterTrackableOfficialSources,
  isClearlyNonAwardSourceUrl,
  isInstitutionalDiscoveryUrl,
  isMonitorableOfficialSource,
  isTrackableOfficialSourceUrl,
} from "@/lib/source-url-policy";

describe("shared awards", () => {
  it("normalizes award names for shared catalog de-duplication", () => {
    expect(normalizeSharedAwardKey("  Goldwater   Scholarship ")).toBe(
      "goldwater scholarship",
    );
  });

  it("normalizes NSF GRFP name variants to one shared award key", () => {
    expect(normalizeSharedAwardKey("National Science Foundation Graduate Research Fellowship")).toBe(
      "nsf graduate research fellowship program",
    );
    expect(
      normalizeSharedAwardKey("National Science Foundation Graduate Research Fellowship Program"),
    ).toBe("nsf graduate research fellowship program");
    expect(normalizeSharedAwardKey("NSF Graduate Research Fellowship")).toBe(
      "nsf graduate research fellowship program",
    );
  });

  it("keeps the backend seed catalog de-duplicated by shared award key", () => {
    const keys = awardSeeds.map((award) => normalizeSharedAwardKey(award.name));

    expect(new Set(keys).size).toBe(keys.length);
  });

  it("includes awards imported from the ASU, Illinois, and NAFA source lists", () => {
    const names = new Set(awardSeeds.map((award) => award.name));

    expect(names.has("FAO Schwarz Fellowship")).toBe(true);
    expect(
      names.has("Academy of Natural Sciences of Philadelphia - Jessup Short-Term Research Awards"),
    ).toBe(true);
    expect(names.has("Ellison Scholars")).toBe(true);
  });

  it("includes a deeper curated Udall source set", () => {
    const udall = awardSourceOverrides.find((award) => award.awardName === "Udall Scholarship");
    expect(udall?.sources.length).toBeGreaterThanOrEqual(12);

    const urls = udall?.sources.map((source) => source.url) || [];
    expect(new Set(urls).size).toBe(urls.length);
    expect(urls).toContain("https://www.udall.gov/OurPrograms/Scholarship/ImportantDates");
    expect(urls).toContain("https://www.udall.gov/documents/pdf/2026%20Eligibility%20Criteria.pdf");
  });

  it("treats campus award databases as discovery-only sources", () => {
    expect(isInstitutionalDiscoveryUrl("https://onsa.asu.edu/scholarship/mitchell-scholarship")).toBe(true);
    expect(isInstitutionalDiscoveryUrl("https://fellowship-finder.grad.illinois.edu/SearchResult/Fellowship/3581")).toBe(true);

    const sources = filterTrackableOfficialSources([
      { url: "https://onsa.asu.edu/scholarship/mitchell-scholarship" },
      { url: "https://us-irelandalliance.org/mitchellscholarship" },
    ]);

    expect(sources).toEqual([
      { url: "https://us-irelandalliance.org/mitchellscholarship" },
    ]);
  });

  it("deduplicates official source pages by canonical URL", () => {
    const sources = filterTrackableOfficialSources([
      { url: "http://www.truman.gov/" },
      { url: "https://www.truman.gov" },
      { url: "https://pickeringfellowship.org/faq/" },
      { url: "https://pickeringfellowship.org/faq" },
      { url: "https://www.smartscholarship.org/smart?id=about_smart" },
      { url: "https://www.smartscholarship.org/smart?id=kb_article&sys_id=33b85cb7db754300b67330ca7c961911" },
      { url: "https://carnegieendowment.org/junior-fellows-program-faq?lang=en" },
      { url: "https://carnegieendowment.org/junior-fellows-program-faq" },
    ]);

    expect(sources).toEqual([
      { url: "https://www.truman.gov" },
      { url: "https://pickeringfellowship.org/faq/" },
      { url: "https://www.smartscholarship.org/smart?id=about_smart" },
      { url: "https://www.smartscholarship.org/smart?id=kb_article&sys_id=33b85cb7db754300b67330ca7c961911" },
      { url: "https://carnegieendowment.org/junior-fellows-program-faq" },
    ]);
  });

  it("deduplicates sorted update URL variants against the canonical page", () => {
    const sources = filterTrackableOfficialSources([
      { url: "https://www.nationalacademies.org/programs/GULF-GULFEO-14-01/updates?sort=asc" },
      { url: "https://www.nationalacademies.org/programs/GULF-GULFEO-14-01/updates" },
      { url: "https://www.nationalacademies.org/programs/GULF-GULFEO-14-01/updates?sort=desc" },
    ]);

    expect(sources).toEqual([
      { url: "https://www.nationalacademies.org/programs/GULF-GULFEO-14-01/updates" },
    ]);
  });

  it("filters clearly non-award source URLs including award-like news/listing paths", () => {
    expect(isClearlyNonAwardSourceUrl("https://onsa.asu.edu/apply")).toBe(false);
    expect(isInstitutionalDiscoveryUrl("https://onsa.asu.edu/apply")).toBe(true);
    expect(isClearlyNonAwardSourceUrl("https://example.org/wp-login.php?redirect_to=/scholarship")).toBe(true);
    expect(isClearlyNonAwardSourceUrl("https://www.180medical.com/termsofuse/")).toBe(true);
    expect(isClearlyNonAwardSourceUrl("https://aas.org/jobregister/ad/db728362")).toBe(true);
    expect(isClearlyNonAwardSourceUrl("https://isi.org/faculty/+18005267022")).toBe(true);
    expect(isClearlyNonAwardSourceUrl("tel:+18005267022")).toBe(true);
    expect(isClearlyNonAwardSourceUrl("https://www.tylenol.com/news/scholarship")).toBe(true);
    expect(isClearlyNonAwardSourceUrl("https://get.adobe.com/reader/")).toBe(true);
  });

  it("hard-blocks National Academies utility and unrelated project spillover", () => {
    const blocked = [
      "https://www.nationalacademies.org/",
      "https://www.nationalacademies.org/current-operating-status",
      "https://www.nationalacademies.org/members",
      "https://www.nationalacademies.org/advancing-a-robust-us-economy",
      "https://www.nationalacademies.org/projects/HMD-HCS-25-14/event/46980",
      "https://www8.nationalacademies.org/pa/managerequest.aspx?key=HMD-HCS-25-14",
      "https://www8.nationalacademies.org/pa/feedback.aspx?type=project&key=HMD-HCS-25-14",
    ];

    for (const url of blocked) {
      expect(isClearlyNonAwardSourceUrl(url)).toBe(true);
      expect(isTrackableOfficialSourceUrl(url)).toBe(false);
      expect(isMonitorableOfficialSource({ url, page_type: "requirements" })).toBe(false);
    }

    expect(isTrackableOfficialSourceUrl("https://www.nationalacademies.org/programs/GULF-GULFEO-14-01/resources")).toBe(
      true,
    );
    expect(isTrackableOfficialSourceUrl("https://www.nationalacademies.org/cdn/materials/a1127513-8528-483f-a66a-eae8136ed637")).toBe(
      true,
    );
  });

  it("keeps official application, deadline, and PDF source pages monitorable", () => {
    const officialSources = [
      {
        url: "https://knight-hennessy.stanford.edu/admission",
        page_type: "application",
      },
      {
        url: "https://knight-hennessy.stanford.edu/admission/preparing-your-applications/application-deadlines",
        page_type: "deadline",
      },
      {
        url: "https://www.udall.gov/documents/pdf/2026%20Eligibility%20Criteria.pdf",
        page_type: "pdf",
      },
    ];

    for (const source of officialSources) {
      expect(isClearlyNonAwardSourceUrl(source.url)).toBe(false);
      expect(isTrackableOfficialSourceUrl(source.url)).toBe(true);
      expect(isMonitorableOfficialSource(source)).toBe(true);
    }
  });

  it("hides duplicate DAAD scholarship database PDF exports while keeping real DAAD PDFs", () => {
    const duplicateExport = {
      url: "https://www.daad.de/deutschland/stipendium/datenbank/en/21148-scholarship-database.pdf?status=4&origin=44&detail=57742121",
      page_type: "pdf",
    };
    const checklist = {
      url: "https://www2.daad.de/bundles/daadadminlbh/uploads/live/5129.pdf",
      page_type: "pdf",
    };
    const broadBrochure = {
      url: "https://www.studieren-weltweit.de/content/uploads/2020/06/mit-stipendium-ins-ausland.pdf",
      page_type: "pdf",
    };

    expect(isClearlyNonAwardSourceUrl(duplicateExport.url)).toBe(true);
    expect(isTrackableOfficialSourceUrl(duplicateExport.url)).toBe(false);
    expect(isMonitorableOfficialSource(duplicateExport)).toBe(false);
    expect(isMonitorableOfficialSource(broadBrochure)).toBe(false);
    expect(isMonitorableOfficialSource(checklist)).toBe(true);
  });

  it("hard-blocks open-data listing and facet URLs from public source outlines", () => {
    const openDataFacet = {
      url: "https://open.alberta.ca/publications?pubtype=Reference+Material&tags=Alberta+Made+Production+Grant",
      page_type: "deadline",
    };
    const openDataSearch = {
      url: "https://open.alberta.ca/dataset?q=%22Employment%20forecasting--Alberta--Periodicals%22",
      page_type: "deadline",
    };
    const openDataPage = {
      url: "https://open.alberta.ca/opendata?audience=General+Public&page=2",
      page_type: "deadline",
    };
    const openDataBoilerplate = {
      url: "https://open.alberta.ca/licence",
      page_type: "deadline",
    };
    const openDataResourcePdf = {
      url: "https://open.alberta.ca/dataset/e934cad0-06a0-4e7b-a462-74f9423fed61/resource/ef91890d-186c-4c7f-8e8e-de6b9aa22892/download/ae-alberta-tuition-framework-version-2-1-2021-12.pdf",
      page_type: "pdf",
    };
    const openDataDetail = {
      url: "https://open.alberta.ca/publications/albertas-occupational-outlook",
      page_type: "deadline",
    };

    expect(isClearlyNonAwardSourceUrl(openDataFacet.url)).toBe(true);
    expect(isMonitorableOfficialSource(openDataFacet)).toBe(false);
    expect(isMonitorableOfficialSource(openDataSearch)).toBe(false);
    expect(isMonitorableOfficialSource(openDataPage)).toBe(false);
    expect(isMonitorableOfficialSource(openDataBoilerplate)).toBe(false);
    expect(isMonitorableOfficialSource(openDataResourcePdf)).toBe(false);
    expect(isMonitorableOfficialSource(openDataDetail)).toBe(true);
  });

  it("does not let trusted source page types override generic listing or hard-block heuristics", () => {
    expect(
      isMonitorableOfficialSource({
        url: "https://example.org/events/application-deadline",
        page_type: "deadline",
      }),
    ).toBe(false);
    expect(
      isMonitorableOfficialSource({
        url: "https://example.org/wp-login.php?redirect_to=/scholarship",
        page_type: "application",
      }),
    ).toBe(false);
  });

  it("uses official sources instead of institutional discovery pages for display", () => {
    const homepage = displayHomepageForAward(
      "https://onsa.asu.edu/scholarship/mitchell-scholarship",
      [
        {
          url: "https://us-irelandalliance.org/mitchellscholarship",
          page_type: "homepage",
        },
      ],
    );

    expect(homepage).toBe("https://us-irelandalliance.org/mitchellscholarship");
  });

  it("hides placeholder summaries used by earlier default watchlist seeds", () => {
    expect(displayAwardSummary(defaultAwardPlaceholderSummary)).toBeNull();
    expect(displayAwardSummary("The NO")).toBeNull();
    expect(displayAwardSummary("Scholarship")).toBeNull();
    expect(displayAwardSummary("  Real award summary.  ")).toBe("Real award summary.");
    expect(
      displayAwardSummary(
        "The exhibits focus on presidential decision-making processes.Palo Alto, CA Truman Library Institute.",
      ),
    ).toBe(
      "The exhibits focus on presidential decision-making processes. Palo Alto, CA Truman Library Institute.",
    );
    expect(
      displayAwardSummary(
        "The Application page added the following wording: applicants should upload the new form.",
      ),
    ).toBeNull();
    expect(
      displayAwardSummary(
        "The FAQ page provides information and resources about eligibility and application requirements.",
      ),
    ).toBeNull();
    expect(
      displayAwardSummary(
        "Skip to main content Toggle Menu Apply Learn More Privacy Policy Cookie Policy Contact Us.",
      ),
    ).toBeNull();
  });

  it("compacts award summaries for the directory payload", () => {
    expect(
      compactAwardDirectorySummary(
        "The Goldwater Scholarship supports undergraduate researchers in STEM fields. Deadline: January 29, 2026. Eligibility: U.S. citizen undergraduate students.",
        "Goldwater Scholarship",
      ),
    ).toBe("The Goldwater Scholarship supports undergraduate researchers in STEM fields.");

    expect(
      compactAwardDirectorySummary(
        defaultAwardPlaceholderSummary,
        "Seed Award",
      ),
    ).toBeNull();
  });

  it("includes a deeper curated Mitchell source set from the official organization site", () => {
    const mitchell = awardSourceOverrides.find((award) => award.awardName === "Mitchell Scholarship");
    expect(mitchell?.sources.length).toBeGreaterThanOrEqual(10);

    const urls = mitchell?.sources.map((source) => source.url) || [];
    expect(new Set(urls).size).toBe(urls.length);
    expect(urls).toContain("https://us-irelandalliance.org/mitchellscholarship/applicants/eligibility");
    expect(urls).not.toContain("https://onsa.asu.edu/scholarship/mitchell-scholarship");
  });

  it("includes a compact current FINESST source set", () => {
    const finesst = awardSourceOverrides.find(
      (award) => award.awardName === "Future Investigators in NASA Earth and Space Science and Technology",
    );
    const urls = finesst?.sources.map((source) => source.url) || [];

    expect(finesst?.sources.length).toBe(6);
    expect(new Set(urls).size).toBe(urls.length);
    expect(urls[0]).toContain("F9C7B701-6405-FD55-6705-EB4B190646B8");
  });
});
