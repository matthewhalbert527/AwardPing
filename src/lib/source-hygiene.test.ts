import { describe, expect, it } from "vitest";
import {
  shouldAutoReviewLaterFailure,
  shouldRejectDiscoveredSource,
} from "../../scripts/source-hygiene.mjs";

describe("source hygiene classifier", () => {
  it("rejects social share links during discovery", () => {
    expect(
      shouldRejectDiscoveredSource({
        url: "https://www.facebook.com/sharer.php?u=https://example.org/application.pdf",
        title: "Share",
      }),
    ).toMatchObject({ action: "review_later", reason: "social_or_share_link" });
  });

  it("moves private Google Docs failures out of the daily queue", () => {
    expect(
      shouldAutoReviewLaterFailure(
        {
          url: "https://docs.google.com/document/d/private/edit",
          title: "Application notes",
        },
        { status_code: 401, failure_type: "http_401", message: "PDF download failed with HTTP 401" },
      ),
    ).toMatchObject({ action: "review_later", reason: "private_document" });
  });

  it("moves oversized files out of the daily queue", () => {
    expect(
      shouldAutoReviewLaterFailure(
        {
          url: "https://example.org/video.mp4",
          title: "Download Video",
        },
        { status_code: 200, failure_type: "http_200", message: "PDF is too large (109682195 bytes)" },
      ),
    ).toMatchObject({ action: "review_later", reason: "media_or_archive_file" });
  });

  it("keeps a normal award application page", () => {
    expect(
      shouldRejectDiscoveredSource({
        url: "https://example.org/fellowship/how-to-apply",
        title: "How to Apply",
        page_type: "application",
      }),
    ).toMatchObject({ action: "keep" });
  });

  it("rejects generic marketing and training spillover pages", () => {
    expect(
      shouldRejectDiscoveredSource({
        url: "https://www.ama.org/on-demand/content-marketing/",
        title: "Content Marketing",
        award_name: "American Marketing Association Valuing Diversity Ph.D. Scholarships",
      }),
    ).toMatchObject({ action: "review_later", reason: "non_award_source" });
  });

  it("rejects food, recipe, and manufacturer pages discovered from award sites", () => {
    expect(
      shouldRejectDiscoveredSource({
        url: "https://www.incredibleegg.org/professionals/foodservice/egg-safety-handling/",
        title: "Egg Safety & Handling",
        award_name: "Young Investigator Award",
      }),
    ).toMatchObject({ action: "review_later", reason: "non_award_source" });
  });

  it("rejects alumni, testimonial, recipient, and profile pages", () => {
    expect(
      shouldRejectDiscoveredSource({
        url: "https://www.bioinspired-materials.ch/en/education/summerschool/summer-alumni/",
        title: "Alumni",
        award_name: "NCCR Bio-Inspired Materials Internship in Switzerland",
      }),
    ).toMatchObject({ action: "review_later", reason: "non_award_source" });

    expect(
      shouldRejectDiscoveredSource({
        url: "https://wennergren.org/grantee/amany-abd-el-hameed/",
        title: "Abd El Hameed, Amany",
        award_name: "Wenner-Gren Foundation Engaged Research Grant",
      }),
    ).toMatchObject({ action: "review_later", reason: "non_award_source" });
  });

  it("rejects high-confidence policy, calendar, and unrelated news spillover", () => {
    expect(
      shouldRejectDiscoveredSource({
        url: "https://www.gilmanscholarship.org/cookie-policy",
        title: "Cookie Policy",
        award_name: "Gilman Scholarship",
      }),
    ).toMatchObject({ action: "review_later", reason: "non_award_source" });

    expect(
      shouldRejectDiscoveredSource({
        url: "https://studentprivacy.ed.gov/resources/eligible-student-guide-family-educational-rights-and-privacy-act-ferpa",
        title: "FERPA for Students",
        award_name: "Javits Fellowship",
      }),
    ).toMatchObject({ action: "review_later", reason: "non_award_source" });

    expect(
      shouldRejectDiscoveredSource({
        url: "https://www.eit.org/news/professor-hagan-bayley-to-lead-bold-new-institute",
        title: "Professor Hagan Bayley to Lead Bold New Institute",
        award_name: "Ellison Scholars",
      }),
    ).toMatchObject({ action: "review_later", reason: "non_award_source" });

    expect(
      shouldRejectDiscoveredSource({
        url: "https://www.amphilsoc.org/news/cnair-oaxaca-following-paths-archival-materials",
        title: "CNAIR in Oaxaca: Following the Paths of Archival Materials",
        award_name:
          "American Philosophical Society / Mellon Foundation - Native American Scholars Initiative Digital Knowledge Sharing Fellowships",
      }),
    ).toMatchObject({ action: "review_later" });
  });

  it("keeps application-related news or tips pages", () => {
    expect(
      shouldRejectDiscoveredSource({
        url: "https://pattillmanfoundation.org/news-media/tillman-scholar-application-tips/",
        title: "GET TIPS FOR THE ANNUAL APPLICATION PROCESS",
        award_name: "Tillman Military Scholarship",
      }),
    ).toMatchObject({ action: "keep" });
  });

  it("rejects generic tag, category, and search result source shapes", () => {
    expect(
      shouldRejectDiscoveredSource({
        url: "https://usascholarships.com/category/scholarships/scholarships-by-major/engineering/",
        title: "engineering",
        award_name: "US Pharmacopeia Research Fellowship",
      }),
    ).toMatchObject({ action: "review_later", reason: "generic_source_shape" });

    expect(
      shouldRejectDiscoveredSource({
        url: "https://example.org/tag/scholarship/",
        title: "Scholarship",
        award_name: "Example Scholarship",
      }),
    ).toMatchObject({ action: "review_later", reason: "generic_source_shape" });

    expect(
      shouldRejectDiscoveredSource({
        url: "https://www.nlm.nih.gov/services/guidelinesearch.html",
        title: "details",
        award_name: "Associate Fellowship Program",
      }),
    ).toMatchObject({ action: "review_later", reason: "generic_source_shape" });

    expect(
      shouldRejectDiscoveredSource({
        url: "https://example.org/?s=fellowship",
        title: "Search results",
        award_name: "Example Fellowship",
      }),
    ).toMatchObject({ action: "review_later", reason: "generic_source_shape" });

    expect(
      shouldRejectDiscoveredSource({
        url: "https://centerformodernhealth.org/research.php",
        title: "Research",
        award_name: "Center for Modern Health Summer Fellowship",
      }),
    ).toMatchObject({ action: "keep" });

    expect(
      shouldRejectDiscoveredSource({
        url: "https://www.daad.org/de/foerderung-finden/stipendiendatenbank/?type=a&q=&detail_to_show=50026200",
        title: "Studienstipendien - Masterstudium",
        award_name: "Graduate Study Scholarship Master Studies in Germany",
      }),
    ).toMatchObject({ action: "keep" });
  });

  it("rejects publication, transcript, catalog collection, and general article spillover", () => {
    expect(
      shouldRejectDiscoveredSource({
        url: "https://www.mainsheet.mysticseaport.org/",
        title: "Mainsheet",
        award_name: "Mystic Seaport - Munson Institute - Paul Cuffe Memorial Fellowship",
      }),
    ).toMatchObject({ action: "review_later", reason: "non_award_source" });

    expect(
      shouldRejectDiscoveredSource({
        url: "https://grants.thomafoundation.org/research/transcript-nm-education-funders-southern-summit-nonprofit-leader-panel/",
        title: "Transcript: NM Southern Summit Nonprofit Leader Panel",
        award_name: "Thoma Foundation - Spanish Colonial Art Fellowships and Research/Travel Grants",
      }),
    ).toMatchObject({ action: "review_later", reason: "non_award_source" });

    expect(
      shouldRejectDiscoveredSource({
        url: "https://catalog.lindahall.org/discovery/collectionDiscovery?vid=01LINDAHALL_INST%3ALHL&collectionId=81117989130005961",
        title: "COLLECTION Charles S. Peirce Collection",
        award_name: "Linda Hall Library - Science, Engineering & Technology Doctoral and Postdoctoral Fellowships",
      }),
    ).toMatchObject({ action: "review_later", reason: "non_award_source" });

    expect(
      shouldRejectDiscoveredSource({
        url: "https://hbswk.hbs.edu/item/inside-one-startups-journey-to-break-down-hiring-and-funding-barriers",
        title: "INSIDE ONE STARTUP'S JOURNEY TO BREAK DOWN HIRING (AND FUNDING) BARRIERS",
        award_name: "Harvard Business School - The Summer Venture in Management",
      }),
    ).toMatchObject({ action: "review_later", reason: "non_award_source" });

    expect(
      shouldRejectDiscoveredSource({
        url: "https://www.getty.edu/calendar/educator-wellness-day-2026/",
        title: "educator wellness day 2026",
        award_name: "Getty Research Institute - Dissertation & Postdoctoral Fellowships in Art History & Visual Studies",
      }),
    ).toMatchObject({ action: "review_later", reason: "non_award_source" });

    expect(
      shouldRejectDiscoveredSource({
        url: "https://www.getty.edu/projects/concrete-art-argentina-brazil/",
        title: "Concrete Art in Argentina and Brazil",
        award_name: "Getty Research Institute - Dissertation & Postdoctoral Fellowships in Art History & Visual Studies",
      }),
    ).toMatchObject({ action: "review_later", reason: "non_award_source" });

    expect(
      shouldRejectDiscoveredSource({
        url: "https://studentaid.alberta.ca/policy/student-aid-policy-manual/eligibility-for-student-aid/types-of-funding/",
        title: "Types of Funding",
        award_name: "Government of Alberta - Alberta Student Aid - Sir James Lougheed Graduate Scholarships",
      }),
    ).toMatchObject({ action: "review_later", reason: "non_award_source" });

    expect(
      shouldRejectDiscoveredSource({
        url: "https://arcsfoundation.org/national/meet-rochearcs-scholars",
        title: "ARCS Roche scholars",
        award_name: "ARCS Foundation Scholar Awards for UIUC Students in STEM",
      }),
    ).toMatchObject({ action: "review_later", reason: "non_award_source" });

    expect(
      shouldRejectDiscoveredSource({
        url: "https://www2.ed.gov/grants-and-programs/apply-grant/available-grants?page=1",
        title: "2",
        award_name: "Foreign Language and Area Studies Fellowship",
      }),
    ).toMatchObject({ action: "review_later", reason: "cross_program_source" });

    expect(
      shouldRejectDiscoveredSource({
        url: "https://home.treasury.gov/system/files/131/Ironworkers-Local-17-Pension-Fund-Notification-Letter.pdf",
        title: "Ironworkers Local 17 Pension Fund Notification Letter.pdf",
        award_name: "US Treasury International Affairs Junior Fellowship",
        page_type: "pdf",
      }),
    ).toMatchObject({ action: "review_later", reason: "non_award_source" });

    expect(
      shouldRejectDiscoveredSource({
        url: "https://www.lung.org/research",
        title: "Research & Reports",
        award_name: "American Lung Association Research Grants",
      }),
    ).toMatchObject({ action: "review_later", reason: "non_award_source" });

    expect(
      shouldRejectDiscoveredSource({
        url: "https://www.sas.rochester.edu/aas/about/contact.html",
        title: "contact the director of undergraduate studies",
        award_name: "University of Rochester - Frederick Douglass Institute for African & African-American Studies - Postdoctoral Fellowship",
      }),
    ).toMatchObject({ action: "review_later", reason: "non_award_source" });

    expect(
      shouldRejectDiscoveredSource({
        url: "https://www.awma.org/ev_calendar_day.asp?eventid=327&date=6/21/2026",
        title: "Daily",
        award_name: "Air & Waste Management Association (A&WMA) - Graduate Scholarships",
      }),
    ).toMatchObject({ action: "review_later", reason: "non_award_source" });

    expect(
      shouldRejectDiscoveredSource({
        url: "https://www.jpf.go.jp/e/about/citizen/",
        title: "The Japan Foundation Prizes for Global Citizenship",
        award_name: "Japanese Studies Fellowship Program for Doctoral Candidates",
      }),
    ).toMatchObject({ action: "review_later", reason: "non_award_source" });

    expect(
      shouldRejectDiscoveredSource({
        url: "https://acf.gov/css/employers/child-support-portal",
        title: "Child Support Portal",
        award_name: "U.S. Department of Health and Human Services (HHS) - Administration for Children and Families - Behavioral Interventions Scholars Grant",
      }),
    ).toMatchObject({ action: "review_later", reason: "non_award_source" });
  });

  it("rejects recursive crawler URLs", () => {
    expect(
      shouldRejectDiscoveredSource({
        url: "https://www.orau.gov/doe-fes-postdoc/applicants/applicants/applicants/index.html",
        title: "Applicant Information",
        award_name: "DOE Fusion Energy Sciences Postdoctoral Research Program",
      }),
    ).toMatchObject({ action: "review_later", reason: "recursive_or_cyclic_url" });
  });

  it("keeps real eligibility and FAQ pages", () => {
    expect(
      shouldRejectDiscoveredSource({
        url: "https://pdsoros.org/eligibility/",
        title: "Eligibility Requirements",
        award_name: "Soros Fellowships for New Americans",
      }),
    ).toMatchObject({ action: "keep" });

    expect(
      shouldRejectDiscoveredSource({
        url: "https://example.edu/scholarship/frequently-asked-questions",
        title: "Frequently Asked Questions",
        award_name: "Example Scholarship",
      }),
    ).toMatchObject({ action: "keep" });
  });

  it("keeps direct application pages even when the parent reason mentions generic sections", () => {
    expect(
      shouldRejectDiscoveredSource({
        url: "https://rotarypeacecenternc.org/home-2/how-to-apply-2/",
        title: "How To Apply",
        page_type: "application",
        award_name: "Rotary Peace Master's Degree Fellowships",
        reason: "Parent source: https://rotarypeacecenternc.org/class/alumni/ Signal: application_html_link:application",
      }),
    ).toMatchObject({ action: "keep" });

    expect(
      shouldRejectDiscoveredSource({
        url: "https://www.ciee.org/go-abroad/college-study-abroad/get-started/how-apply",
        title: "apply for your CIEE program",
        page_type: "faq",
        award_name: "Douglass-O'Connell Global Internship",
        reason:
          "Found by the visual snapshot worker after expanding page content. Parent source: https://www.ciee.org/go-abroad/college-study-abroad/blog/how-study-abroad-5-steps-apply-ciee Signal: faq_html_link:application",
      }),
    ).toMatchObject({ action: "keep" });
  });

  it("keeps scholarship FAQ PDFs hosted under generic media folders", () => {
    expect(
      shouldRejectDiscoveredSource({
        url: "https://www.acfe.com/-/media/files/acfe/pdfs/ritchie-jennings-memorial-scholarship-program-faqs.pdf",
        title: "Scholarship FAQs",
        page_type: "pdf",
        award_name: "Ritchie Jennings Memorial Scholarship",
      }),
    ).toMatchObject({ action: "keep" });
  });

  it("keeps Simons source pages that match the specific ecology and evolution fellowship", () => {
    expect(
      shouldRejectDiscoveredSource({
        url: "https://www.simonsfoundation.org/grant/simons-graduate-fellowships-in-ecology-and-evolution/",
        title: "Simons Graduate Fellowships in Ecology and Evolution",
        page_type: "homepage",
        award_name: "Simons Foundation - Graduate Fellowship in Ecology and Evolution",
      }),
    ).toMatchObject({ action: "keep" });

    expect(
      shouldRejectDiscoveredSource({
        url: "https://www.simonsfoundation.org/grant/simons-graduate-fellowships-in-ecology-and-evolution/?tab=how-to-apply",
        title: "How to Apply",
        page_type: "application",
        award_name: "Simons Foundation - Graduate Fellowship in Ecology and Evolution",
      }),
    ).toMatchObject({ action: "keep" });
  });

  it("rejects broad Simons RFA and sibling program pages for a specific award", () => {
    expect(
      shouldRejectDiscoveredSource({
        url: "https://www.simonsfoundation.org/mathematics-physical-sciences/funding/request-for-applications/",
        title: "Request for Applications",
        page_type: "application",
        award_name: "Simons Foundation - Graduate Fellowship in Ecology and Evolution",
      }),
    ).toMatchObject({ action: "review_later", reason: "cross_program_source" });

    expect(
      shouldRejectDiscoveredSource({
        url: "https://www.simonsfoundation.org/funding-opportunities/fellows-to-faculty/",
        title: "Fellows-to-Faculty Award - Simons Foundation",
        page_type: "application",
        award_name: "Simons Foundation - Graduate Fellowship in Ecology and Evolution",
      }),
    ).toMatchObject({ action: "review_later", reason: "cross_program_source" });
  });

  it("keeps CEAIE Teach in China pages and rejects IIE tax/navigation spillover", () => {
    expect(
      shouldRejectDiscoveredSource({
        url: "https://www.iie.org/programs/ceaie-teach-in-china/eligibility/",
        title: "CEAIE Teach In China Program Eligibility",
        page_type: "eligibility",
        award_name: "CEAIE Teach In China Program",
      }),
    ).toMatchObject({ action: "keep" });

    expect(
      shouldRejectDiscoveredSource({
        url: "https://www.iie.org/connect/students/participant-tax-service-information/faq/",
        title: "Participant Tax Service Information FAQ",
        page_type: "faq",
        award_name: "CEAIE Teach In China Program",
      }),
    ).toMatchObject({ action: "review_later", reason: "non_award_source" });

    expect(
      shouldRejectDiscoveredSource({
        url: "https://www.iie.org/get-involved/become-an-iienetwork-member/iie-heiskell-awards/nomination-and-selection/",
        title: "Eligibility & Nomination",
        page_type: "eligibility",
        award_name: "CEAIE Teach In China Program",
      }),
    ).toMatchObject({ action: "review_later", reason: "cross_program_source" });
  });

  it("rejects recent bad source shapes found in published update audits", () => {
    const crossProgramExamples = [
      {
        url: "https://www.fields.utoronto.ca/activities/thematic",
        title: "thematic programs",
        award_name: "The Fields Institute for Research in Mathematical Sciences - Postdoctoral Fellowships",
      },
      {
        url: "https://www.nsf.gov/funding/programs.jsp?org=SBE",
        title: "NSF Directorate of Social, Behavioral and Economic Sciences",
        award_name: "National Science Foundation (NSF) - Arctic Doctoral Dissertation Improvement Grant",
      },
      {
        url: "https://www.fastlane.nsf.gov/fastlane.jsp",
        title: "FastLane",
        award_name: "National Science Foundation (NSF) - Atmospheric and Geospace Sciences (AGS) Postdoctoral Fellowships",
      },
      {
        url: "https://www.ncbi.nlm.nih.gov/books/n/cd/standards/",
        title: "Standards and Guidelines",
        award_name: "Associate Fellowship Program",
      },
      {
        url: "https://www.postdocs.ubc.ca/awards-funding",
        title: "Awards & Funding",
        award_name: "University of British Columbia (UBC) - Killam Postdoctoral Fellowship",
      },
      {
        url: "https://croucher.org.hk/hk/funding/study-awards/croucher-science-communication-studentships",
        title: "Croucher Science Communication Studentships",
        award_name: "Croucher Foundation - Doctoral Scholarship for Students from Hong Kong",
      },
      {
        url: "https://www.costumesocietyamerica.com/csa-betty-kirke-excellence-in-research-award",
        title: "Betty Kirke Excellence In Research Award",
        award_name: "Costume Society of America (CSA) - Stella Blum Student Research Travel Grant",
      },
      {
        url: "https://pgfusa.org/2022-awards-program/",
        title: "2022 Awards Program",
        award_name: "Princess Grace Awards Program",
      },
      {
        url: "https://www.lung.org/get-involved/ways-to-give/donation-faq?form=FUNUKYZBMGT",
        title: "Monthly",
        award_name: "American Lung Association Research Grants",
      },
      {
        url: "https://seg.org/programs/student-programs/seg-evolve/",
        title: "SEG EVOLVE Carbon Solutions Application",
        award_name: "Society of Exploration Geophysicists (SEG) Foundation - Scholarships",
      },
    ];

    for (const example of crossProgramExamples) {
      expect(shouldRejectDiscoveredSource(example)).toMatchObject({
        action: "review_later",
        reason: "cross_program_source",
      });
    }

    expect(
      shouldRejectDiscoveredSource({
        url: "https://members.shafr.org/index.php?option=com_jevents&task=month.calendar&Itemid=115&year=2026&month=06&day=03",
        title: "Upcoming Events",
        award_name: "Society for Historians of American Foreign Relations (SHAFR) - Dissertation Grants",
      }),
    ).toMatchObject({ action: "review_later", reason: "non_award_source" });
  });
});
