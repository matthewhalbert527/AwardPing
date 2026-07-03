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

  it("rejects open-data search and facet pages discovered as award subpages", () => {
    expect(
      shouldRejectDiscoveredSource({
        url: "https://open.alberta.ca/publications?pubtype=Reference+Material&tags=Alberta+Made+Production+Grant",
        title: "Alberta Made Production Grant",
        page_type: "deadline",
        award_name:
          "Government of Alberta - Alberta Student Aid - Sir James Lougheed Graduate Scholarships",
      }),
    ).toMatchObject({ action: "review_later", reason: "generic_source_shape" });

    expect(
      shouldRejectDiscoveredSource({
        url: "https://open.alberta.ca/dataset?q=%22Employment%20forecasting--Alberta--Periodicals%22",
        title: "Employment forecasting--Alberta--Periodicals",
        page_type: "deadline",
        award_name:
          "Government of Alberta - Alberta Student Aid - Sir James Lougheed Graduate Scholarships",
      }),
    ).toMatchObject({ action: "review_later", reason: "generic_source_shape" });

    expect(
      shouldRejectDiscoveredSource({
        url: "https://open.alberta.ca/opendata?audience=General+Public&page=2",
        title: "2",
        page_type: "deadline",
        award_name:
          "Government of Alberta - Alberta Student Aid - Sir James Lougheed Graduate Scholarships",
      }),
    ).toMatchObject({ action: "review_later", reason: "generic_source_shape" });

    expect(
      shouldRejectDiscoveredSource({
        url: "https://open.alberta.ca/dataset/e934cad0-06a0-4e7b-a462-74f9423fed61/resource/ef91890d-186c-4c7f-8e8e-de6b9aa22892/download/ae-alberta-tuition-framework-version-2-1-2021-12.pdf",
        title: "Alberta tuition framework",
        page_type: "pdf",
        award_name: "University of Alberta - Killam and Notley Postdoctoral Fellowships",
      }),
    ).toMatchObject({ action: "review_later", reason: "generic_source_shape" });

    expect(
      shouldRejectDiscoveredSource({
        url: "https://open.alberta.ca/publications/2009-economic-update",
        title: "2008-2009 economic update",
        page_type: "deadline",
        reason:
          "Found by the visual snapshot worker after expanding page content. Parent source: https://open.alberta.ca/dataset?tags=economic+outlook&page=3 Signal: deadline_html_link",
        award_name:
          "Government of Alberta - Alberta Student Aid - Sir James Lougheed Graduate Scholarships",
      }),
    ).toMatchObject({ action: "review_later", reason: "generic_source_shape" });

    expect(
      shouldRejectDiscoveredSource({
        url: "https://open.alberta.ca/publications/albertas-occupational-outlook",
        title: "Alberta's occupational outlook",
        page_type: "deadline",
        award_name: "Alberta Occupational Outlook",
      }),
    ).toMatchObject({ action: "keep" });
  });

  it("rejects Alberta career and sibling student-aid spillover", () => {
    const awardName =
      "Government of Alberta - Alberta Student Aid - Sir James Lougheed Graduate Scholarships";

    expect(
      shouldRejectDiscoveredSource({
        url: "https://alis.alberta.ca/occinfo/alberta-job-postings/electrician/49818269/",
        title: "Electrician",
        page_type: "deadline",
        award_name: awardName,
      }),
    ).toMatchObject({ action: "review_later", reason: "cross_program_source" });

    expect(
      shouldRejectDiscoveredSource({
        url: "https://studentaid.alberta.ca/scholarships/new-beginnings-bursary/",
        title: "Apply",
        page_type: "application",
        award_name: awardName,
      }),
    ).toMatchObject({ action: "review_later", reason: "cross_program_source" });

    expect(
      shouldRejectDiscoveredSource({
        url: "https://studentaid.alberta.ca/scholarships/sir-james-lougheed-award-of-distinction/",
        title: "Sir James Lougheed Award Eligibility",
        page_type: "homepage",
        award_name: awardName,
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

  it("rejects broad DOE official-domain spillover while keeping ORISE fellowship sources", () => {
    const awardName =
      "U.S. Department of Energy (DOE) - Oak Ridge Institute for Science & Education (ORISE) - Graduate, Post-Master's & Postdoctoral Fellowships";

    const broadDoeExamples = [
      {
        url: "https://www.energy.gov/articles/fact-sheet-energy-department-prevented-blackouts-saved-american-lives-during-winter-storms",
        title: "FACT SHEET: Energy Department Prevented Blackouts & Saved American Lives During Winter Storms",
        page_type: "other",
      },
      {
        url: "https://www.energy.gov/fe/submitting-electronic-payment",
        title: "online payment link",
        page_type: "application",
      },
      {
        url: "https://www.energy.gov/cmei/ammto/critical-minerals-and-materials-accelerator-0",
        title: "a NOFO of up to $50 million",
        page_type: "requirements",
      },
      {
        url: "https://infrastructure-exchange.energy.gov/Default.aspx",
        title: "a NOFO of up to $135 million",
        page_type: "requirements",
      },
      {
        url: "https://www.energy.gov/sites/default/files/2022-03/doe-fy2023-budget-in-brief-v2.pdf",
        title: "FY 2023 Budget in Brief",
        page_type: "pdf",
      },
      {
        url: "https://www.energy.gov/doe-affiliated-nobel-prize-laureates",
        title: "DOE-affiliated Nobel Prize Laureates",
        page_type: "other",
        reason: "Local worker discovered this other page from https://www.energy.gov/internships-fellowships.",
      },
      {
        url: "https://www.energy.gov/apprenticeships-workforce-development",
        title: "Apprenticeships & Workforce Development",
        page_type: "other",
        reason: "Local worker discovered this other page from https://www.energy.gov/internships-fellowships.",
      },
      {
        url: "https://www.usajobs.gov/Help/faq/application/documents/resume/what-to-include/",
        title: "What to Include in Your Federal Resume",
        page_type: "pdf",
        reason:
          "Found by the visual snapshot worker after expanding page content. Parent source: https://www.energy.gov/work-us-department-energy Signal: document_link_signal",
      },
      {
        url: "https://www.fedconnect.net/FedConnect/default.aspx?ReturnUrl=%2ffedconnect%3fdoc%3dDE-FOA-0003105%26agency%3dDOE&doc=DE-FOA-0003105&agency=DOE",
        title: "Download the full funding opportunity on FedConnect.",
        page_type: "pdf",
        reason:
          "Found by the visual snapshot worker after expanding page content. Parent source: https://www.energy.gov/cmei/mining/funding-notice-critical-material-innovation-efficiency-and-alternatives Signal: document_link_signal",
      },
      {
        url: "https://pubs.usgs.gov/periodicals/mcs2024/mcs2024.pdf",
        title: "U.S. Geological Survey",
        page_type: "pdf",
        reason:
          "Found by the visual snapshot worker after expanding page content. Parent source: https://www.energy.gov/cmei/articles/does-office-critical-minerals-and-energy-innovation-announces-over-45-million-support Signal: pdf_url",
      },
      {
        url: "https://infrastructure-exchange.energy.gov/FileContent.aspx?FileID=26f78413-b753-4ca1-8998-e231770c6e7e",
        title: "Application for Federal Assistance (SF 424) - updated 1-28-24",
        page_type: "application",
        reason:
          "Found by the visual snapshot worker after expanding page content. Parent source: https://infrastructure-exchange.energy.gov/Default.aspx Signal: application_html_link:application",
      },
      {
        url: "https://www.energy.gov/sites/default/files/2025-03/258%20-%20Order%20on%20Motion%20for%20Contempt.pdf",
        title: "Order on Motion for Contempt (March 17, 2025)",
        page_type: "pdf",
        reason:
          "Found by the visual snapshot worker after expanding page content. Parent source: https://www.energy.gov/notice-court-orders Signal: pdf_url",
      },
      {
        url: "https://fossil.energy.gov/fergas-fe/docs/Portal_User_Manual_v_1_2.pdf",
        title: "Portal User Manual",
        page_type: "pdf",
        reason:
          "Found by the visual snapshot worker after expanding page content. Parent source: https://fossil.energy.gov/fergas-fe/main.html Signal: pdf_url",
      },
      {
        url: "https://eere-exchange.energy.gov/FAQ.aspx?FoaId=9b0fa116-6f34-4078-9891-a3421679962e",
        title: "FAQs webpage",
        page_type: "faq",
        reason:
          "Found by the visual snapshot worker after expanding page content. Parent source: https://eere-exchange.energy.gov/Default.aspx?Search=3589&SearchType= Signal: faq_html_link:faq",
      },
      {
        url: "https://eere-exchange.energy.gov/Default.aspx",
        title: "Default",
        page_type: "application",
        reason:
          "Found by the visual snapshot worker after expanding page content. Parent source: https://eere-exchange.energy.gov/FAQ.aspx?FoaId=9b0fa116-6f34-4078-9891-a3421679962e Signal: application_html_link",
      },
      {
        url: "https://www.justice.gov/oip/amendment-s2488.pdf",
        title: "Open Government Act",
        page_type: "pdf",
        reason:
          "Found by the visual snapshot worker after expanding page content. Parent source: https://www.energy.gov/gc/foia-frequently-asked-questions-faqs Signal: pdf_url",
      },
      {
        url: "https://arpa-e.energy.gov/programs-and-initiatives/search-all-projects/pure-harves2t-produced-water-utilization-recovery-energy-materials-high-value-advanced-resource-valorization-using-emerging-switchable-solvent-technologies",
        title: "Learn More",
        page_type: "requirements",
        reason:
          "Found by the visual snapshot worker after expanding page content. Parent source: https://arpa-e.energy.gov/programs-and-initiatives/view-all-programs/recover Signal: requirements_html_link:requirements",
      },
      {
        url: "https://science.osti.gov/-/media/grants/pdf/foas/2024/DE-FOA-0003444.pdf",
        title: "DE FOA 0003444",
        page_type: "pdf",
        reason:
          "Found by the visual snapshot worker after expanding page content. Parent source: https://www.energy.gov/cmei/ammto/articles/apply-grants-fund-materials-and-advanced-manufacturing-research-development-and Signal: pdf_url",
      },
      {
        url: "https://www.nrel.gov/docs/fy23osti/81483.pdf",
        title: "Materials Used in U.S. Wind Energy Technologies: Quantities and Availability for Two Future Scenarios",
        page_type: "pdf",
        reason:
          "Found by the visual snapshot worker after expanding page content. Parent source: https://www.energy.gov/cmm/critical-minerals-materials-program Signal: pdf_url Expanded controls: 1",
      },
      {
        url: "https://docs.google.com/document/d/1zZIL6snPer_N9UjWY7w7_xnRUSXWQRjEk7Ehl7sAf44/edit?usp=sharing",
        title: "TCU Career Consortium History",
        page_type: "pdf",
        reason:
          "Found by the visual snapshot worker after expanding page content. Parent source: https://www.energy.gov/cmm/critical-materials-collaborative Signal: document_link_signal",
      },
      {
        url: "https://www.energy.gov/sites/default/files/2026-06/DOE-OIG-26-38.pdf",
        title: "OIG-26-38.pdf",
        page_type: "pdf",
        reason:
          "Found by the visual snapshot worker after expanding page content. Parent source: https://www.energy.gov/ig/articles/additional-action-would-assist-advanced-research-projects-agency-energy-fulfill-us Signal: pdf_url",
      },
      {
        url: "https://www.energy.gov/sites/prod/files/2013/07/f2/Area.pdf",
        title: "Table 2",
        page_type: "pdf",
        reason:
          "Found by the visual snapshot worker after expanding page content. Parent source: https://www.energy.gov/hgeo/guidelines-filing-monthly-reports Signal: pdf_url",
      },
      {
        url: "https://www.energy.gov/science-innovation/innovation/hubs",
        title: "Energy Innovation Hub",
        page_type: "requirements",
        reason:
          "Found by the visual snapshot worker after expanding page content. Parent source: https://www.energy.gov/cmei/ammto/articles/doe-energy-innovation-hub-announces-10-million-early-stage-research-development Signal: requirements_html_link",
      },
      {
        url: "https://www.energy.gov/node/4827873",
        title: "Learn more about Conductivity-Enhanced Materials",
        page_type: "requirements",
        reason:
          "Found by the visual snapshot worker after expanding page content. Parent source: https://www.energy.gov/cmei/ammto/next-generation-materials-and-processes Signal: requirements_html_link:requirements Expanded controls: 3",
      },
      {
        url: "https://www.energy.gov/eere/ammto/funding-selections-ammto-large-wind-turbine-materials-and-manufacturing-funding",
        title: "Learn more about the selections",
        page_type: "requirements",
        reason:
          "Found by the visual snapshot worker after expanding page content. Parent source: https://www.energy.gov/cmei/ammto/articles/three-new-selections-will-advance-materials-and-manufacturing-offshore-wind Signal: requirements_html_link:requirements",
      },
    ];

    for (const example of broadDoeExamples) {
      expect(
        shouldRejectDiscoveredSource({
          ...example,
          award_name: awardName,
        }),
      ).toMatchObject({ action: "review_later", reason: "official_domain_spillover" });
    }

    expect(
      shouldRejectDiscoveredSource({
        url: "https://www.energy.gov/internships-fellowships",
        title: "Internships & Fellowships - Department of Energy",
        page_type: "homepage",
        award_name: awardName,
      }),
    ).toMatchObject({ action: "keep" });

    expect(
      shouldRejectDiscoveredSource({
        url: "https://www.energy.gov/sites/default/files/2026-01/orise-postdoctoral-fellowship-application-guide.pdf",
        title: "ORISE Postdoctoral Fellowship Application Guide",
        page_type: "pdf",
        award_name: awardName,
      }),
    ).toMatchObject({ action: "keep" });

    expect(
      shouldRejectDiscoveredSource({
        url: "https://www.energy.gov/sites/default/files/2026-03/OEA_WashingtonDC.pdf",
        title: "Office of Enterprise Assessments - Washington DC",
        page_type: "pdf",
        award_name:
          "U.S. Department of Energy (DOE) - Office of Energy Efficiency & Renewable Energy (EERE) - Post-Master's and Postdoctoral Science & Technology Policy (STP) Fellowship",
      }),
    ).toMatchObject({ action: "keep" });

    expect(
      shouldRejectDiscoveredSource({
        url: "https://science.osti.gov/wdts/suli/How-to-Apply/Workshop-Archive",
        title: "SULI Workshop Archive",
        page_type: "application",
        award_name: "Department of Energy Science Undergraduate Laboratory Internship (SULI)",
      }),
    ).toMatchObject({ action: "keep" });

    expect(
      shouldRejectDiscoveredSource({
        url: "https://science.osti.gov/wdts/scgsr/How-to-Apply/DOE-Lab-POCs",
        title: "participating DOE National Laboratories and User Facilities.",
        page_type: "application",
        award_name:
          "U.S. Department of Energy (DOE) - Office of Science Graduate Student Research (SCGSR) Program",
      }),
    ).toMatchObject({ action: "keep" });

    const suliAwardName = "Department of Energy Science Undergraduate Laboratory Internship (SULI)";
    for (const url of [
      "https://science.osti.gov/sbir/Anonymous-Feedback",
      "https://science.osti.gov/User-Facilities/Frequently-Asked-Questions",
      "https://science.osti.gov/-/media/_/pdf/user-facilities/memoranda/Office_of_Science_User_Facility_Definition_Memo.pdf",
      "https://science.osti.gov/sbir",
      "https://science.osti.gov/Leaving-Office-of-Science?url=http%3a%2f%2fwww.ameslab.gov%2f&external=true",
    ]) {
      expect(
        shouldRejectDiscoveredSource({
          url,
          title: "Office of Science sibling section",
          page_type: "other",
          award_name: suliAwardName,
        }),
      ).toMatchObject({ action: "review_later", reason: "official_domain_spillover" });
    }
  });

  it("rejects DAAD duplicate print PDFs and broad academic PDF spillover", () => {
    expect(
      shouldRejectDiscoveredSource({
        url: "https://www.daad.de/deutschland/stipendium/datenbank/en/21148-scholarship-database.pdf?status=4&origin=44&detail=57742121",
        title: "as PDF",
        page_type: "pdf",
        award_name: "DAAD (German Academic Exchange Service) - Doctoral Research Grants",
      }),
    ).toMatchObject({ action: "review_later", reason: "duplicate_pdf_export" });

    expect(
      shouldRejectDiscoveredSource({
        url: "https://static.daad.de/media/daad_de/pdfs_nicht_barrierefrei/in-deutschland-studieren-forschen-lehren/790_2023-01-01_daad_merkblatt_tarif_790-d_extern.pdf",
        title: "these conditions [pdf-file]",
        page_type: "pdf",
        award_name: "DAAD (German Academic Exchange Service) - Doctoral Research Grants",
        reason: "Parent source: https://www.daad.de/en/studying-in-germany/living-in-germany/health-insurance/",
      }),
    ).toMatchObject({ action: "review_later", reason: "cross_program_source" });

    expect(
      shouldRejectDiscoveredSource({
        url: "https://www2.daad.de/bundles/daadadminlbh/uploads/live/5129.pdf",
        title: "DAAD Doctoral Research Grants Application Checklist",
        page_type: "pdf",
        award_name: "DAAD (German Academic Exchange Service) - Doctoral Research Grants",
      }),
    ).toMatchObject({ action: "keep" });

    expect(
      shouldRejectDiscoveredSource({
        url: "https://static.daad.de/media/daad_de/pdfs_nicht_barrierefrei/in-deutschland-studieren-forschen-lehren/hsk_hwk_faq.pdf",
        title: "FAQs",
        display_title: "FAQs - University Summer Course Grant",
        page_type: "pdf",
        award_name: "University Summer Course Grant",
      }),
    ).toMatchObject({ action: "keep" });

    expect(
      shouldRejectDiscoveredSource({
        url: "https://static.daad.de/media/daad_de/pdfs_nicht_barrierefrei/in-deutschland-studieren-forschen-lehren/daad_hsk_kursanbieterliste.pdf",
        title: "Kursliste (Course List) 2026",
        page_type: "pdf",
        award_name: "University Summer Course Grant",
      }),
    ).toMatchObject({ action: "keep" });

    expect(
      shouldRejectDiscoveredSource({
        url: "https://www.studieren-weltweit.de/content/uploads/2020/06/mit-stipendium-ins-ausland.pdf",
        title: "Mit Stipendium ins Ausland",
        page_type: "pdf",
        award_name: "DAAD (German Academic Exchange Service) - Doctoral Research Grants",
      }),
    ).toMatchObject({ action: "review_later", reason: "cross_program_source" });
  });

  it("rejects NSPIRES ROSES sibling spillover while keeping FINESST-specific sources", () => {
    const awardName = "Future Investigators in NASA Earth and Space Science and Technology";

    expect(
      shouldRejectDiscoveredSource({
        url: "https://nspires.nasaprs.com/external/solicitations/summary.do?solId={BD18A167-6DE8-1A35-A0ED-96F16AC6DE49}&path=&method=init",
        title: "Space Weather Science Applications Operations 2 Research",
        page_type: "application",
        award_name: awardName,
        reason:
          "Parent source: https://nspires.nasaprs.com/external/viewrepositorydocument?cmdocumentid=660371&solicitationId={E16CD59F-29DD-06C0-8971-CE1A9C252FD4}&viewSolicitationDocument=1",
      }),
    ).toMatchObject({ action: "review_later", reason: "cross_program_source" });

    expect(
      shouldRejectDiscoveredSource({
        url: "https://nspires.nasaprs.com/external/viewrepositorydocument?cmdocumentid=1041497&solicitationId={44C4B6D5-A499-3314-7172-3435A7ED59C6}&viewSolicitationDocument=1",
        title:
          "DUE DATES: Table 2 lists and links to all program elements in due date order as amended on 05202026 (.HTML)",
        page_type: "deadline",
        award_name: awardName,
      }),
    ).toMatchObject({ action: "review_later", reason: "cross_program_source" });

    expect(
      shouldRejectDiscoveredSource({
        url: "https://nspires.nasaprs.com/external/viewrepositorydocument?cmdocumentid=1075626&solicitationId=%7BF9C7B701-6405-FD55-6705-EB4B190646B8%7D&viewSolicitationDocument=1",
        title: "F.5 Future Investigators in NASA Earth and Space Science and Technology",
        page_type: "pdf",
        award_name: awardName,
      }),
    ).toMatchObject({ action: "keep" });

    expect(
      shouldRejectDiscoveredSource({
        url: "https://get.adobe.com/reader/",
        title: "Download Adobe Acrobat Reader",
        page_type: "pdf",
        award_name: awardName,
      }),
    ).toMatchObject({ action: "review_later", reason: "software_download" });
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
