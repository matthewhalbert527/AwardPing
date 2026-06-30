import { describe, expect, it } from "vitest";
import { buildPostCrawlCleanupModel, cleanupActions } from "../../scripts/source-cleanup-core.mjs";
import { classifySourceForConsolidation } from "../../scripts/source-consolidation-core.mjs";

const award = {
  id: "award-1",
  name: "National Institutes of Health (NIH) - Aging Research Dissertation Awards to Increase Diversity (R36)",
  official_homepage: null,
  status: "active",
};

function source(overrides: Record<string, unknown>) {
  return {
    id: "source-1",
    shared_award_id: award.id,
    url: "https://example.org/award",
    title: "Award page",
    page_type: "homepage",
    confidence: 0.9,
    source: "admin",
    last_error: null,
    last_checked_at: null,
    next_check_at: null,
    consecutive_failures: 0,
    updated_at: null,
    ...overrides,
  };
}

function actionFor(sources: Array<Record<string, unknown>>, sourceId: string) {
  const model = buildPostCrawlCleanupModel({ awards: [award], sources });
  return model.sourceRows.find((row: { source: { id: string } }) => row.source.id === sourceId);
}

describe("post-crawl source cleanup classification", () => {
  it("keeps blocked 403 and 429 sources", () => {
    expect(
      actionFor([source({ id: "blocked", last_error: "Fetch failed with HTTP 403." })], "blocked")?.action,
    ).toBe(cleanupActions.keepButBlocked);

    expect(
      actionFor([source({ id: "limited", last_error: "Fetch failed with HTTP 429." })], "limited")?.action,
    ).toBe(cleanupActions.keepButBlocked);
  });

  it("removes dead sources only when another useful source remains", () => {
    const rows = [
      source({ id: "dead", url: "https://example.org/old", last_error: "Fetch failed with HTTP 404." }),
      source({ id: "good", url: "https://example.org/current", last_error: null }),
    ];

    expect(actionFor(rows, "dead")?.action).toBe(cleanupActions.safeToRemove);
    expect(actionFor([rows[0]], "dead")?.action).toBe(cleanupActions.needsReplacement);
  });

  it("marks dead DNS only-source rows for replacement", () => {
    expect(
      actionFor([source({ id: "dns", url: "https://missing.example", last_error: "getaddrinfo ENOTFOUND missing.example" })], "dns")
        ?.action,
    ).toBe(cleanupActions.needsReplacement);
  });

  it("removes duplicate canonical URLs", () => {
    const rows = [
      source({ id: "keep", url: "https://www.pickeringfellowship.org/faq", confidence: 0.9 }),
      source({ id: "remove", url: "http://pickeringfellowship.org/faq/", confidence: 0.3 }),
    ];

    expect(actionFor(rows, "remove")?.action).toBe(cleanupActions.safeToRemove);
  });

  it("marks broad root agency homepages for replacement unless an award page remains", () => {
    const broadRoot = source({ id: "root", url: "https://www.nih.gov/", title: "National Institutes of Health" });
    const specific = source({
      id: "specific",
      url: "https://www.nia.nih.gov/research/training/r36-aging-research-dissertation-awards-promote-diversity",
      title: "R36 Aging Research Dissertation Awards",
    });

    expect(actionFor([broadRoot], "root")?.action).toBe(cleanupActions.needsReplacement);
    expect(actionFor([broadRoot, specific], "root")?.action).toBe(cleanupActions.safeToRemove);
  });

  it("keeps no-readable-text sources for manual review", () => {
    expect(
      actionFor([source({ id: "js", last_error: "No readable text was found on this URL." })], "js")?.action,
    ).toBe(cleanupActions.keepButBlocked);
  });

  it("does not remove trusted application or deadline sources because of generic URL shape", () => {
    const rows = [
      source({
        id: "deadline",
        url: "https://example.org/events/application-deadline",
        title: "Application Deadline",
        page_type: "deadline",
      }),
      source({ id: "good", url: "https://example.org/current", title: "Current award page" }),
    ];

    expect(actionFor(rows, "deadline")?.action).toBe(cleanupActions.noAction);
  });

  it("removes obvious boilerplate PDFs even though PDFs are protected source types", () => {
    const rows = [
      source({
        id: "login-pdf",
        url: "https://example.org/wp-content/uploads/Login-Instructions.pdf",
        title: "Login Instructions",
        page_type: "pdf",
      }),
      source({ id: "good", url: "https://example.org/current", title: "Current award page" }),
    ];

    expect(actionFor(rows, "login-pdf")?.action).toBe(cleanupActions.safeToRemove);
  });

  it("removes duplicate DAAD scholarship database PDF exports", () => {
    const rows = [
      source({
        id: "daad-pdf-export",
        url: "https://www.daad.de/deutschland/stipendium/datenbank/en/21148-scholarship-database.pdf?status=4&origin=44&detail=57742121",
        title: "as PDF",
        page_type: "pdf",
      }),
      source({ id: "good", url: "https://example.org/current", title: "Current award page" }),
    ];

    expect(actionFor(rows, "daad-pdf-export")?.action).toBe(cleanupActions.safeToRemove);
    expect(actionFor(rows, "daad-pdf-export")?.reason).toBe("duplicate_pdf_export");
  });

  it("removes broad DAAD scholarship brochures", () => {
    const rows = [
      source({
        id: "daad-brochure",
        url: "https://www.studieren-weltweit.de/content/uploads/2020/06/mit-stipendium-ins-ausland.pdf",
        title: "Mit Stipendium ins Ausland",
        page_type: "pdf",
      }),
      source({ id: "good", url: "https://example.org/current", title: "Current award page" }),
    ];

    expect(actionFor(rows, "daad-brochure")?.action).toBe(cleanupActions.safeToRemove);
    expect(actionFor(rows, "daad-brochure")?.reason).toBe("broad_scholarship_brochure");
  });

  it("removes generic category and search shaped sources even with award-ish words", () => {
    const rows = [
      source({
        id: "category",
        url: "https://usascholarships.com/category/scholarships/scholarships-by-major/engineering/",
        title: "engineering",
        page_type: "homepage",
      }),
      source({
        id: "search",
        url: "https://example.org/?s=fellowship",
        title: "Search results",
        page_type: "application",
      }),
      source({ id: "good", url: "https://example.org/current", title: "Current award page" }),
    ];

    expect(actionFor(rows, "category")?.action).toBe(cleanupActions.safeToRemove);
    expect(actionFor(rows, "category")?.reason).toBe("generic_source_shape");
    expect(actionFor(rows, "search")?.action).toBe(cleanupActions.safeToRemove);
    expect(actionFor(rows, "search")?.reason).toBe("generic_source_shape");
  });

  it("does not mistake research pages or detail URLs for generic search shapes", () => {
    const rows = [
      source({
        id: "research",
        url: "https://centerformodernhealth.org/research.php",
        title: "Research",
        page_type: "other",
      }),
      source({
        id: "daad-detail",
        url: "https://www.daad.org/de/foerderung-finden/stipendiendatenbank/?type=a&q=&detail_to_show=50026200",
        title: "Studienstipendien - Masterstudium",
        page_type: "other",
      }),
      source({ id: "good", url: "https://example.org/current", title: "Current award page" }),
    ];

    expect(actionFor(rows, "research")?.action).toBe(cleanupActions.noAction);
    expect(actionFor(rows, "daad-detail")?.action).toBe(cleanupActions.noAction);
  });
});

describe("source consolidation classification", () => {
  it("rejects campus and broad directory spillover while keeping the actual award path", () => {
    expect(
      classifySourceForConsolidation(
        source({
          id: "music",
          url: "https://www.sc.edu/study/colleges_schools/music/apply/index.php",
          title: "Apply",
          page_type: "application",
        }),
        {
          ...award,
          name: "National Resource Center - Fidler Research Grant for the Study of College Students in Transition",
        },
      ),
    ).toMatchObject({ action: "review_later", reason: "campus_program_spillover" });

    expect(
      classifySourceForConsolidation(
        source({
          id: "fidler",
          url: "https://sc.edu/about/offices_and_divisions/national_resource_center/award_recognition_programs/fidler_research_grant/application_requirements/index.php",
          title: "Application Requirements",
          page_type: "application",
        }),
        {
          ...award,
          name: "National Resource Center - Fidler Research Grant for the Study of College Students in Transition",
        },
      ).action,
    ).toBe("keep");
  });

  it("rejects agency archive, policy, and professional-resource spillover", () => {
    expect(
      classifySourceForConsolidation(
        source({
          id: "ed",
          url: "https://www2.ed.gov/grants-and-programs/grants-birth-grade-12/well-rounded-education-grants/american-history-and-civics-national-activities-grants-84422b",
          title: "American History and Civics-National Activities Grants (84.422B)",
          page_type: "deadline",
        }),
        { ...award, name: "Foreign Language and Area Studies Fellowship" },
      ),
    ).toMatchObject({ action: "review_later", reason: "broad_grants_listing_spillover" });

    expect(
      classifySourceForConsolidation(
        source({
          id: "nsf",
          url: "https://www.nsf.gov/awards/report-your-outcomes",
          title: "Report your progress",
          page_type: "requirements",
        }),
        { ...award, name: "National Science Foundation (NSF) - Postdoctoral Research Fellowships in Biology (PRFB)" },
      ),
    ).toMatchObject({ action: "review_later", reason: "agency_policy_spillover" });

    expect(
      classifySourceForConsolidation(
        source({
          id: "gfoa",
          url: "https://www.gfoa.org/materials/topic/budgeting-and-forecasting",
          title: "Budgeting and Forecasting",
          page_type: "requirements",
        }),
        { ...award, name: "Government Finance Officers Association (GFOA) - Scholarships" },
      ),
    ).toMatchObject({ action: "review_later", reason: "professional_material_spillover" });
  });

  it("rejects PDF and profile spillover that bloats source outlines", () => {
    expect(
      classifySourceForConsolidation(
        source({
          id: "nasa",
          url: "https://www.nasa.gov/wp-content/uploads/2023/01/presrep2006.pdf?emrc=6a3ae1e6b2426",
          title: "Download Fiscal Year 2006",
          page_type: "pdf",
        }),
        {
          ...award,
          name:
            "American Historical Association (AHA) and the National Aeronautics & Space Administration (NASA) - Doctoral & Postdoctoral Fellowships in Aerospace History",
        },
      ),
    ).toMatchObject({ action: "review_later", reason: "archive_pdf_spillover" });

    expect(
      classifySourceForConsolidation(
        source({
          id: "daad",
          url: "https://www.daad.de/rise/files/2024/09/AB-KhanMonoshizMahbub-ABBAG-2024.pdf",
          title: "Monoshiz Mahbub Khan",
          page_type: "pdf",
        }),
        { ...award, name: "DAAD-Research Internships in Science and Engineering (RISE)" },
      ),
    ).toMatchObject({ action: "review_later", reason: "participant_report_spillover" });

    expect(
      classifySourceForConsolidation(
        source({
          id: "daad-export",
          url: "https://www.daad.de/deutschland/stipendium/datenbank/en/21148-scholarship-database.pdf?status=4&origin=44&detail=57742121",
          title: "as PDF",
          page_type: "pdf",
        }),
        { ...award, name: "DAAD (German Academic Exchange Service) - Doctoral Research Grants" },
      ),
    ).toMatchObject({ action: "review_later", reason: "duplicate_pdf_export" });

    expect(
      classifySourceForConsolidation(
        source({
          id: "daad-static",
          url: "https://static.daad.de/media/daad_de/pdfs_nicht_barrierefrei/in-deutschland-studieren-forschen-lehren/790_2023-01-01_daad_merkblatt_tarif_790-d_extern.pdf",
          title: "these conditions [pdf-file]",
          page_type: "pdf",
          reason: "Parent source: https://www.daad.de/en/studying-in-germany/living-in-germany/health-insurance/",
        }),
        { ...award, name: "DAAD (German Academic Exchange Service) - Doctoral Research Grants" },
      ),
    ).toMatchObject({ action: "review_later", reason: "academic_policy_pdf_spillover" });

    expect(
      classifySourceForConsolidation(
        source({
          id: "daad-brochure",
          url: "https://www.studieren-weltweit.de/content/uploads/2020/06/mit-stipendium-ins-ausland.pdf",
          title: "Mit Stipendium ins Ausland",
          page_type: "pdf",
        }),
        { ...award, name: "DAAD (German Academic Exchange Service) - Doctoral Research Grants" },
      ),
    ).toMatchObject({ action: "review_later", reason: "broad_scholarship_brochure" });

    expect(
      classifySourceForConsolidation(
        source({
          id: "eja",
          url: "https://equaljusticeamerica.org/index.php/fordham-university-school-of-law",
          title: "Fordham University School of Law",
          page_type: "other",
        }),
        { ...award, name: "Equal Justice America - Fellowships for Law Students" },
      ),
    ).toMatchObject({ action: "review_later", reason: "profile_or_school_spillover" });
  });

  it("rejects generic category and search shaped sources while keeping tabbed award details", () => {
    expect(
      classifySourceForConsolidation(
        source({
          id: "category",
          url: "https://usascholarships.com/category/scholarships/scholarships-by-major/engineering/",
          title: "engineering",
          page_type: "homepage",
        }),
        { ...award, name: "US Pharmacopeia Research Fellowship" },
      ),
    ).toMatchObject({ action: "review_later", reason: "generic_source_shape" });

    expect(
      classifySourceForConsolidation(
        source({
          id: "search",
          url: "https://www.nlm.nih.gov/services/guidelinesearch.html",
          title: "details",
          page_type: "other",
        }),
        { ...award, name: "Associate Fellowship Program" },
      ),
    ).toMatchObject({ action: "review_later", reason: "generic_source_shape" });

    expect(
      classifySourceForConsolidation(
        source({
          id: "tab",
          url: "https://www.simonsfoundation.org/grant/simons-graduate-fellowships-in-ecology-and-evolution/?tab=how-to-apply",
          title: "How to Apply",
          page_type: "application",
        }),
        { ...award, name: "Simons Foundation - Graduate Fellowship in Ecology and Evolution" },
      ).action,
    ).toBe("keep");

    expect(
      classifySourceForConsolidation(
        source({
          id: "research",
          url: "https://centerformodernhealth.org/research.php",
          title: "Research",
          page_type: "other",
        }),
        { ...award, name: "Center for Modern Health Summer Fellowship" },
      ).action,
    ).toBe("keep");

    expect(
      classifySourceForConsolidation(
        source({
          id: "daad-detail",
          url: "https://www.daad.org/de/foerderung-finden/stipendiendatenbank/?type=a&q=&detail_to_show=50026200",
          title: "Studienstipendien - Masterstudium",
          page_type: "other",
        }),
        { ...award, name: "Graduate Study Scholarship Master Studies in Germany" },
      ).action,
    ).toBe("keep");
  });
});
