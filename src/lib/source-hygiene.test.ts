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
    ).toMatchObject({ action: "review_later", reason: "official_domain_spillover" });

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

  it("rejects high-volume official-domain spillover discovered in source count audits", () => {
    expect(
      shouldRejectDiscoveredSource({
        url: "https://www.sahr.org.uk/electronic-journal-faq.php?sid=fb9d7a",
        title: "Electronic Journal FAQs",
        page_type: "faq",
        award_name: "Society for Army Historical Research - University Research Travel Grants",
      }),
    ).toMatchObject({ action: "review_later", reason: "official_domain_spillover" });

    expect(
      shouldRejectDiscoveredSource({
        url: "https://www.sahr.org.uk/university-research-travel-grants.php",
        title: "University Research Travel Grants",
        page_type: "homepage",
        award_name: "Society for Army Historical Research - University Research Travel Grants",
      }),
    ).toMatchObject({ action: "keep" });

    for (const example of [
      {
        url: "https://pubmed.ncbi.nlm.nih.gov/32662519/",
        title: "A published PubMed article",
        award_name: "National Library of Medicine (NLM) - Postgraduate Fellowship Program for Librarians",
      },
      {
        url: "https://www.ncbi.nlm.nih.gov/portal/utils/pageresolver.fcgi?recordid=123",
        title: "NCBI Page Resolver",
        award_name: "Associate Fellowship Program",
      },
      {
        url: "https://www.ncbi.nlm.nih.gov/mesh/limits?term=Guideline%20Adherence",
        title: "MeSH limits",
        award_name: "Associate Fellowship Program",
      },
      {
        url: "https://www.ncbi.nlm.nih.gov/RefSeq/",
        title: "Reference Sequences",
        award_name: "Associate Fellowship Program",
      },
      {
        url: "https://www.nlm.nih.gov/portals/librarians.html",
        title: "For Librarians",
        award_name: "National Library of Medicine (NLM) - Postgraduate Fellowship Program for Librarians",
      },
      {
        url: "https://techbull.nlm.nih.gov/vivisimo/cgi-bin/query-meta?v%3Aproject=technical-bulletin-date&binning-state=product==PubMed",
        title: "PUBMED",
        award_name: "National Library of Medicine (NLM) - Postgraduate Fellowship Program for Librarians",
      },
      {
        url: "https://github.com/ncbi/sra-tools/wiki/01.-Downloading-SRA-Toolkit",
        title: "Download SRA Toolkit",
        award_name: "Associate Fellowship Program",
      },
    ]) {
      expect(shouldRejectDiscoveredSource(example)).toMatchObject({
        action: "review_later",
        reason: "official_domain_spillover",
      });
    }

    expect(
      shouldRejectDiscoveredSource({
        url: "https://www.nlm.nih.gov/about/training/associate/",
        title: "NLM Associate Fellowship Program",
        page_type: "homepage",
        award_name: "Associate Fellowship Program",
      }),
    ).toMatchObject({ action: "keep" });

    for (const example of [
      {
        url: "https://services.ku.edu/TDClient/818/Portal/KB/ArticleDet?ID=21168",
        title: "Faculty Code",
        award_name:
          "University of Kansas - Accessible Teaching, Learning, and Assessment Systems (ATLAS) - Research Fellowship",
      },
      {
        url: "https://ku.edu/admissions",
        title: "Apply",
        award_name:
          "University of Kansas - Accessible Teaching, Learning, and Assessment Systems (ATLAS) - Research Fellowship",
      },
      {
        url: "https://www.cisa.gov/sites/default/files/publications/GETS-WPS%20User%20Organization%20Responsibilities_0.pdf",
        title: "GETS-WPS User Organization Responsibilities",
        page_type: "pdf",
        award_name:
          "University of Kansas - Accessible Teaching, Learning, and Assessment Systems (ATLAS) - Research Fellowship",
      },
      {
        url: "https://kansas.sharepoint.com/teams/our-resources/Course%20%20Room%20Scheduling%20Resources/Forms/AllItems.aspx",
        title: "Instruction Mode Help Sheet",
        page_type: "pdf",
        award_name:
          "University of Kansas - Accessible Teaching, Learning, and Assessment Systems (ATLAS) - Research Fellowship",
      },
      {
        url: "https://helpdesk.fau.edu/TDClient/2061/Portal/KB/ArticleDet?ID=123",
        title: "How to connect to Wi-Fi",
        award_name: "Florida Atlantic-Huntington Library Short-Term Fellowship for Doctoral Candidates",
      },
      {
        url: "https://www.canada.ca/en/immigration-refugees-citizenship/services/study-canada/work/after-graduation.html",
        title: "Work in Canada after graduation",
        award_name: "Social Science and Humanities Research Council of Canada (SSHRC) - Doctoral Fellowships",
      },
      {
        url: "https://ircc.canada.ca/english/helpcentre/answer.asp?qnum=514",
        title: "Help Centre answer",
        award_name: "Social Science and Humanities Research Council of Canada (SSHRC) - Doctoral Fellowships",
      },
      {
        url: "https://www.canada.ca/en/services/benefits/education/student-aid.html",
        title: "Apply for student loans and grants",
        award_name: "Social Science and Humanities Research Council of Canada (SSHRC) - Doctoral Fellowships",
      },
      {
        url: "https://nserc-crsng.canada.ca/sites/default/files/2026-04/grant-amendment-form-e.pdf",
        title: "Grant Amendment Form",
        page_type: "pdf",
        award_name: "Social Science and Humanities Research Council of Canada (SSHRC) - Doctoral Fellowships",
      },
    ]) {
      expect(shouldRejectDiscoveredSource(example)).toMatchObject({
        action: "review_later",
        reason: "official_domain_spillover",
      });
    }

    expect(
      shouldRejectDiscoveredSource({
        url: "https://www.sshrc-crsh.gc.ca/funding-financement/programs-programmes/fellowships/doctoral-doctorat-eng.aspx",
        title: "SSHRC Doctoral Fellowships",
        page_type: "homepage",
        award_name: "Social Science and Humanities Research Council of Canada (SSHRC) - Doctoral Fellowships",
      }),
    ).toMatchObject({ action: "keep" });
  });

  it("rejects high-count crawler spillover without removing the real award source", () => {
    for (const example of [
      {
        url: "https://portal.sds.ox.ac.uk/ndownloader/files/43521618",
        title: "Download file",
        page_type: "pdf",
        award_name: "Ertegun Graduate Scholarship Programme in the Humanities",
      },
      {
        url: "https://portal.sds.ox.ac.uk/stats?groupId=47136",
        title: "more stats...",
        award_name: "Ertegun Graduate Scholarship Programme in the Humanities",
      },
      {
        url: "https://www.earth.ox.ac.uk/themes/planetary-evolution-and-materials?page-4743376=1",
        title: "previous",
        award_name: "Ertegun Graduate Scholarship Programme in the Humanities",
      },
      {
        url: "https://societyforhealthpsychology.org/read/articles-resources/f-ces-or-communications-or-diversity-multiculturalism-or-member-benefits/",
        title: "Diversity & Multiculturalism",
        award_name: "Society for Health Psychology Graduate Student Research Awards",
      },
      {
        url: "https://societyforhealthpsychology.org/articles-resources/student-advisory-council/overview-of-the-internship-application-process/",
        title: "overview of the internship application process",
        award_name: "Society for Health Psychology Graduate Student Research Awards",
      },
      {
        url: "https://www.usda.gov/guidance?f%5B0%5D=topic%3A8488&f%5B1%5D=topic%3A9046",
        title: "Application Processing (1)",
        award_name:
          "U.S. Department of Agriculture National Institute of Food and Agriculture (USDA-NIFA) - Agriculture and Food Research Initiative - Dissertation & Postdoctoral Fellowships",
      },
      {
        url: "https://www.nrcs.usda.gov/resources/guides-and-instructions/access-road-ft-560-conservation-practice-standard",
        title: "Access Road (Ft.) (560)",
        award_name:
          "U.S. Department of Agriculture National Institute of Food and Agriculture (USDA-NIFA) - Agriculture and Food Research Initiative - Dissertation & Postdoctoral Fellowships",
      },
      {
        url: "https://www.nist.gov/document/nist2015diffusionworkshop-nasapptx",
        title: "Developing Diffusion Experiments for Space: Possibilities",
        page_type: "pdf",
        award_name:
          "National Institutes of Standards and Technology Summer Undergraduate Research Fellowship",
      },
      {
        url: "https://mgi.nist.gov/webform/page_feedback?page=https://www.nist.gov/mgi",
        title: "Was this page helpful?",
        award_name:
          "National Institutes of Standards and Technology Summer Undergraduate Research Fellowship",
      },
      {
        url: "https://www.nist.gov/webform/page_feedback?page=https://www.nist.gov/mml/materials-science-and-engineering-division",
        title: "Was this page helpful?",
        award_name:
          "National Institutes of Standards and Technology Summer Undergraduate Research Fellowship",
      },
      {
        url: "https://www.ala.org/cite?query=node/12074&title=Guidelines%20for%20University%20Library%20Services",
        title: "CITE",
        award_name: "American Library Association (ALA) Scholarships",
      },
      {
        url: "https://www.ala.org/rusa/guidelines/interlibrary",
        title: "Interlibrary Loan Code for the United States.",
        award_name: "American Library Association (ALA) Scholarships",
      },
      {
        url: "https://journals.ala.org/index.php/rusq/article/download/3159/3291",
        title: "Download this PDF file",
        page_type: "pdf",
        award_name: "American Library Association (ALA) Scholarships",
      },
      {
        url: "https://portal.zedat.fu-berlin.de/idp-fub/profile/SAML2/Redirect/SSO;__Host-JSESSIONID=123?execution=e1s1&lang=en",
        title: "English",
        award_name:
          "Freie Universitat Berlin - Berlin Program for Advanced German and European Studies - Dissertation & Postdoctoral Fellowships",
      },
      {
        url: "https://identity.fu-berlin.de/themen/e-research/news-thema-e-research/2026-06-19-comute-workshop.html",
        title: "COMUTE Workshop",
        award_name:
          "Freie Universitat Berlin - Berlin Program for Advanced German and European Studies - Dissertation & Postdoctoral Fellowships",
      },
      {
        url: "https://www.fu-berlin.de/studium/bewerbung/immatrikulation/FAQ/Promotion/index.html?irq=0&next=en",
        title: "English",
        award_name:
          "Freie Universitat Berlin - Berlin Program for Advanced German and European Studies - Dissertation & Postdoctoral Fellowships",
      },
      {
        url: "https://www.exeter.ac.uk/study/accommodation/room-finder/penncourt/",
        title: "Pennsylvania Court",
        award_name: "University of Exeter Global Excellence Scholarship",
      },
      {
        url: "https://www.exeter.ac.uk/our-campuses/streatham-campus/",
        title: "Streatham Campus in Exeter",
        award_name: "University of Exeter Global Excellence Scholarship",
      },
      {
        url: "https://funding.exeter.ac.uk/apply/step1/?award=2750",
        title: "Apply here",
        award_name: "University of Exeter Global Excellence Scholarship",
      },
      {
        url: "https://nij.ojp.gov/funding/O-NIJ-2024-171966.pdf",
        title: "O NIJ 2024 171966",
        page_type: "pdf",
        award_name: "NIJ Graduate Research Fellowship",
      },
      {
        url: "https://nij.ojp.gov/funding/opportunities/o-nij-2025-172615",
        title: "NIJ FY25 Research and Evaluation of Artificial Intelligence for Criminal Justice Purposes",
        award_name: "NIJ Graduate Research Fellowship",
      },
      {
        url: "https://bja.ojp.gov/program/it/global",
        title: "Global Justice Information Sharing Initiative",
        award_name: "NIJ Graduate Research Fellowship",
      },
      {
        url: "https://ec.europa.eu/info/funding-tenders/opportunities/portal/screen/how-to-participate/person-profile/n003dhsk",
        title: "Christos VAITSIS, Mr",
        award_name: "Erasmus Mundus Joint Masters Degrees",
      },
      {
        url: "https://ec.europa.eu/info/funding-tenders/opportunities/portal/screen/support/faq/21983",
        title: "Funding & Tenders Portal two-factor authentication",
        award_name: "Erasmus Mundus Joint Masters Degrees",
      },
      {
        url: "https://www.eacea.ec.europa.eu/scholarships/erasmus-mundus-catalogue_de",
        title: "Erasmus Mundus Catalogue",
        award_name: "Erasmus Mundus Joint Masters Degrees",
      },
      {
        url: "https://erasmus-plus.ec.europa.eu/bg/programme-guide/part-c/how-to-apply/step-4-application-form",
        title: "Step 4: application form",
        award_name: "Erasmus Mundus Joint Masters Degrees",
      },
      {
        url: "https://www.eacea.ec.europa.eu/contacts/erasmus-mundus-and-intra-africa-academic-mobility-programme-students-complaints-form_en",
        title: "Submit a complaint",
        award_name: "Erasmus Mundus Joint Masters Degrees",
      },
      {
        url: "https://library.arce.org/portal/Author/Home?author=Amiet%2C+Pierre%2C",
        title: "Amiet, Pierre",
        award_name:
          "American Research Center in Egypt (ARCE) / CAORC - Pre-Dissertation Travel Grants",
      },
      {
        url: "https://arce.org/arce-annual-meeting-student-access-grant/",
        title: "2026 Student Access Grant",
        award_name:
          "American Research Center in Egypt (ARCE) / CAORC - Pre-Dissertation Travel Grants",
      },
      {
        url: "https://arce.org/wp-content/uploads/2025/11/2026-AEF-1-Year-Grant-Instructions.pdf",
        title: "2026 Short Term Grant: Application Guidelines",
        page_type: "pdf",
        award_name:
          "American Research Center in Egypt (ARCE) / CAORC - Pre-Dissertation Travel Grants",
      },
      {
        url: "https://pds.mcp.nasa.gov/portal/instruments/urn--nasa--pds--context--instrument--hirise---mro/data",
        title: "Mars Reconnaissance Orbiter High Resolution Imaging Science Experiment",
        award_name:
          "National Aeronautics & Space Administration (NASA) - Space Technology Graduate Research Fellowship (NSTGRO)",
      },
      {
        url: "https://www.nasa.gov/directorates/stmd/space-tech-research-grants/2d-materials-for-energy-harvesting-and-sensing/",
        title: "2 D Materials for Energy Harvesting and Sensing",
        award_name:
          "National Aeronautics & Space Administration (NASA) - Space Technology Graduate Research Fellowship (NSTGRO)",
      },
      {
        url: "https://www.earthdata.nasa.gov/engage/data-management-guidance/create-maintain-open-science-data-management-plan",
        title: "How to Create and Maintain an Open Science and Data Management Plan",
        award_name:
          "National Aeronautics & Space Administration (NASA) - Space Technology Graduate Research Fellowship (NSTGRO)",
      },
      {
        url: "https://github.com/nasa/AppEEARS-Data-Resources/blob/main/guides/How-to-bulk-download-AppEEARS-outputs.md",
        title: "How to bulk download AppEEARS outputs",
        award_name:
          "National Aeronautics & Space Administration (NASA) - Space Technology Graduate Research Fellowship (NSTGRO)",
      },
      {
        url: "https://issnationallab.org/research-and-science/research-opportunities-and-results/research-reports/",
        title: "Read and Download Reports",
        award_name:
          "National Aeronautics & Space Administration (NASA) - Space Technology Graduate Research Fellowship (NSTGRO)",
      },
      {
        url: "https://www.federalregister.gov/documents/2016/10/27/2016-26014/revisions-to-uniform-administrative-requirements-cost-principles-and-audit-requirements-for-federal",
        title: "Uniform Administrative Requirements",
        award_name:
          "National Aeronautics & Space Administration (NASA) - Space Technology Graduate Research Fellowship (NSTGRO)",
      },
      {
        url: "https://pds.mcp.nasa.gov/portal/investigations/urn--nasa--pds--context--investigation--mission---cassini-huygens/instruments",
        title: "Cassini",
        award_name:
          "National Aeronautics and Space Administration (NASA) - Jet Propulsion Laboratory (JPL) - Planetary Science Summer School",
      },
      {
        url: "https://science.nasa.gov/researchers/sara/faqs/prc-faq-roses/",
        title: "PRC FAQ for ROSES",
        award_name:
          "National Aeronautics and Space Administration (NASA) - Jet Propulsion Laboratory (JPL) - Planetary Science Summer School",
      },
      {
        url: "https://www.nasa.gov/stem/murep/projects/ncas.html",
        title: "NCAS program website",
        award_name:
          "National Aeronautics and Space Administration (NASA) - Jet Propulsion Laboratory (JPL) - Planetary Science Summer School",
      },
      {
        url: "https://www.jpl.nasa.gov/edu/internships/apply/nasaipac-teacher-archive-research-program/",
        title: "IPAC Teacher Archive Research Program",
        award_name:
          "National Aeronautics and Space Administration (NASA) - Jet Propulsion Laboratory (JPL) - Planetary Science Summer School",
      },
      {
        url: "https://www.earthdata.nasa.gov/data/tools/appeears",
        title: "Application for Extracting and Exploring Analysis Ready Samples (AppEEARS)",
        award_name:
          "National Aeronautics and Space Administration (NASA) - Jet Propulsion Laboratory (JPL) - Planetary Science Summer School",
      },
      {
        url: "http://www.jpl.nasa.gov/edu/pdfs/siri_resume_template_spring2022.pdf",
        title: "SIRI Resume Guidelines",
        page_type: "pdf",
        award_name:
          "National Aeronautics and Space Administration (NASA) - Jet Propulsion Laboratory (JPL) - Planetary Science Summer School",
      },
      {
        url: "https://grants.nih.gov/grants/guide/WeeklyIndex.cfm?04-24-26",
        title: "NIH Guide: Weekly Index for April 24, 2026",
        award_name: "MARC Undergraduate Student Training in Academic Research",
      },
      {
        url: "https://grants.nih.gov/policy-and-compliance",
        title: "Policy & Compliance | NIH Grants & Funding",
        award_name: "MARC Undergraduate Student Training in Academic Research",
      },
      {
        url: "https://public.csr.nih.gov/sites/default/files/2022-11/CSRAC_Fellowship_review_WG_report_September_2022_final.pdf",
        title: "Final Report of the CSR Advisory Council Working Group on Peer Review of NRSA Fellowship Applications",
        page_type: "pdf",
        award_name: "MARC Undergraduate Student Training in Academic Research",
      },
      {
        url: "https://www.era.nih.gov/files/ASSIST_user_guide.pdf",
        title: "ASSIST User Guide",
        page_type: "pdf",
        award_name: "MARC Undergraduate Student Training in Academic Research",
      },
      {
        url: "https://www.gpo.gov/fdsys/pkg/FR-2010-09-14/pdf/2010-22705.pdf",
        title: "Requirements for Federal Funding Accountability and Transparency Act Implementation",
        page_type: "pdf",
        award_name: "MARC Undergraduate Student Training in Academic Research",
      },
      {
        url: "https://www.wilsoncenter.org/research-fellowship",
        title: "Wilson Center Research Fellowship",
        award_name:
          "Wilson Center / Kennan Institute - Short-Term Travel Grants for Research on Russia & the Former Soviet Union",
      },
      {
        url: "https://www.wilsoncenter.org/article/infographic-russias-illegal-annexation-crimea",
        title: "Infographic | Russia's Illegal Annexation of Crimea",
        award_name:
          "Wilson Center / Kennan Institute - Short-Term Travel Grants for Research on Russia & the Former Soviet Union",
      },
      {
        url: "https://www.wilsoncenter.org/sites/default/files/media/uploads/documents/FY2020_Audited_Financial_Statement.pdf",
        title: "FY 2020 Audited Financial Statement",
        page_type: "pdf",
        award_name:
          "Wilson Center / Kennan Institute - Short-Term Travel Grants for Research on Russia & the Former Soviet Union",
      },
      {
        url: "https://www.osce.org/files/f/documents/e/2/13380.pdf",
        title: "2002 OSCE budget",
        page_type: "pdf",
        award_name:
          "Wilson Center / Kennan Institute - Short-Term Travel Grants for Research on Russia & the Former Soviet Union",
      },
      {
        url: "https://www.salliemae.com/college-planning/financial-aid/fafsa/",
        title: "FAFSA 2026-27 - Sallie Mae",
        award_name:
          "Sallie Mae Fund / Thurgood Marshall College Fund (TMCF) - Bridging the Dream Scholarship Program for Graduate Students",
      },
      {
        url: "https://apply2.salliemae.com/s/who-are-you?dtd_cell=SMLRSOPANLNLEFOTAGZ1005N030013",
        title: "Apply for a loan",
        award_name:
          "Sallie Mae Fund / Thurgood Marshall College Fund (TMCF) - Bridging the Dream Scholarship Program for Graduate Students",
      },
      {
        url: "https://46610517.fs1.hubspotusercontent-na1.net/hubfs/46610517/2K-scholarship/2K-No-Essay-Scholarship-by-Sallie-Sweepstakes-Official-Rules.pdf",
        title: "Official Rules",
        page_type: "pdf",
        award_name:
          "Sallie Mae Fund / Thurgood Marshall College Fund (TMCF) - Bridging the Dream Scholarship Program for Graduate Students",
      },
      {
        url: "https://www.irs.gov/pub/irs-prior/p970--2024.pdf",
        title: "Tax Benefits for Education",
        page_type: "pdf",
        award_name:
          "Sallie Mae Fund / Thurgood Marshall College Fund (TMCF) - Bridging the Dream Scholarship Program for Graduate Students",
      },
      {
        url: "https://higherlogicdownload.s3.amazonaws.com/AAFCS/UploadedImages/Resources/Resource_Page_on_Website_Graphics__5_.pdf",
        title: "Atrial Fibrillation Strategic Research Network Report",
        page_type: "pdf",
        award_name: "American Association of Family and Consumer Sciences (AAFCS) - Graduate Fellowships",
      },
      {
        url: "https://www.aafcs.org/blogs/aafcs-team/2026/04/15/apply-for-bok-network?hlmlt=BL",
        title: "Bring the FCS Body of Knowledge to Life: Apply for the BOK Resource Network",
        award_name: "American Association of Family and Consumer Sciences (AAFCS) - Graduate Fellowships",
      },
      {
        url: "https://www.aafcs.org/resources/careers",
        title: "Access Resources Here",
        award_name: "American Association of Family and Consumer Sciences (AAFCS) - Graduate Fellowships",
      },
      {
        url: "https://online.aafcs.org/aafcsssa/censsacustmast.insert_page",
        title: "Create a profile",
        award_name: "American Association of Family and Consumer Sciences (AAFCS) - Graduate Fellowships",
      },
      {
        url: "https://myplate-prod.azureedge.us/sites/default/files/2024-05/create-your-own-myplate-menu.pdf",
        title: "Create Your Own MyPlate Menu",
        page_type: "pdf",
        award_name: "American Association of Family and Consumer Sciences (AAFCS) - Graduate Fellowships",
      },
      {
        url: "https://www.fau.edu/admissions/documents/international-student-guide.pdf",
        title: "International Student Guide",
        page_type: "pdf",
        award_name: "Florida Atlantic-Huntington Library Short-Term Fellowship for Doctoral Candidates",
      },
      {
        url: "https://www.fau.edu/uas/pdf/DARS.pdf",
        title: "pdf instructions",
        page_type: "pdf",
        award_name: "Florida Atlantic-Huntington Library Short-Term Fellowship for Doctoral Candidates",
      },
    ]) {
      expect(shouldRejectDiscoveredSource(example)).toMatchObject({
        action: "review_later",
        reason: "official_domain_spillover",
      });
    }

    for (const example of [
      {
        url: "https://www.ox.ac.uk/ertegun",
        title: "Ertegun Graduate Scholarship Programme",
        page_type: "homepage",
        award_name: "Ertegun Graduate Scholarship Programme in the Humanities",
      },
      {
        url: "https://societyforhealthpsychology.org/awards/graduate-student-research-awards/",
        title: "Graduate Student Research Awards",
        page_type: "homepage",
        award_name: "Society for Health Psychology Graduate Student Research Awards",
      },
      {
        url: "https://www.nifa.usda.gov/grants/programs/agriculture-food-research-initiative-afri",
        title: "Agriculture and Food Research Initiative",
        page_type: "homepage",
        award_name:
          "U.S. Department of Agriculture National Institute of Food and Agriculture (USDA-NIFA) - Agriculture and Food Research Initiative - Dissertation & Postdoctoral Fellowships",
      },
      {
        url: "https://www.nist.gov/surf",
        title: "Summer Undergraduate Research Fellowship (SURF)",
        page_type: "homepage",
        award_name:
          "National Institutes of Standards and Technology Summer Undergraduate Research Fellowship",
      },
      {
        url: "https://www.ala.org/educationcareers/scholarships",
        title: "ALA Scholarships",
        page_type: "homepage",
        award_name: "American Library Association (ALA) Scholarships",
      },
      {
        url: "https://www.ala.org/aboutala/offices/hrdr/scholarshipprgm/faqalascholarship",
        title: "Frequently Asked Questions (FAQ)",
        page_type: "faq",
        award_name: "American Library Association (ALA) Scholarships",
      },
      {
        url: "https://www.fu-berlin.de/sites/bprogram/",
        title: "Berlin Program for Advanced German and European Studies",
        page_type: "homepage",
        award_name:
          "Freie Universitat Berlin - Berlin Program for Advanced German and European Studies - Dissertation & Postdoctoral Fellowships",
      },
      {
        url: "https://www.exeter.ac.uk/study/funding/award/?id=5612",
        title: "Exeter Excellence Scholarships",
        page_type: "homepage",
        award_name: "University of Exeter Global Excellence Scholarship",
      },
      {
        url: "https://nij.ojp.gov/funding/opportunities/graduate-research-fellowship",
        title: "NIJ Graduate Research Fellowship",
        page_type: "homepage",
        award_name: "NIJ Graduate Research Fellowship",
      },
      {
        url: "https://erasmus-plus.ec.europa.eu/opportunities/opportunities-for-individuals/students/erasmus-mundus-joint-masters",
        title: "Erasmus Mundus Joint Masters",
        page_type: "homepage",
        award_name: "Erasmus Mundus Joint Masters Degrees",
      },
      {
        url: "https://erasmus-plus.ec.europa.eu/opportunities/individuals/students/erasmus-mundus-joint-masters-scholarships",
        title: "Erasmus Mundus Joint Masters (students)",
        page_type: "homepage",
        award_name: "Erasmus Mundus Joint Masters Degrees",
      },
      {
        url: "https://www.eacea.ec.europa.eu/scholarships/erasmus-mundus-catalogue_en",
        title: "Erasmus Mundus Catalogue",
        page_type: "homepage",
        award_name: "Erasmus Mundus Joint Masters Degrees",
      },
      {
        url: "https://www.eacea.ec.europa.eu/scholarships_en",
        title: "EACEA Scholarships Overview and General Information",
        page_type: "faq",
        award_name: "Erasmus Mundus Joint Masters Degrees",
      },
      {
        url: "https://arce.org/fellowship/arce-caorc-research-fellowships/",
        title: "ARCE-CAORC Research Fellowships",
        page_type: "homepage",
        award_name:
          "American Research Center in Egypt (ARCE) / CAORC - Pre-Dissertation Travel Grants",
      },
      {
        url: "https://arce.org/fellowships-landing/",
        title: "Opportunities",
        page_type: "other",
        award_name:
          "American Research Center in Egypt (ARCE) / CAORC - Pre-Dissertation Travel Grants",
      },
      {
        url: "https://www.nasa.gov/directorates/spacetech/strg/nstgro",
        title: "NASA Space Technology Graduate Research Opportunities (NSTGRO)",
        page_type: "homepage",
        award_name:
          "National Aeronautics & Space Administration (NASA) - Space Technology Graduate Research Fellowship (NSTGRO)",
      },
      {
        url: "https://www.nasa.gov/nasa-space-technology-graduate-research-opportunities-nstgro/",
        title: "Space Tech Graduate Research",
        page_type: "homepage",
        award_name:
          "National Aeronautics & Space Administration (NASA) - Space Technology Graduate Research Fellowship (NSTGRO)",
      },
      {
        url: "https://www.jpl.nasa.gov/edu/intern/apply/nasa-science-mission-design-schools/",
        title: "NASA Science Mission Design Schools",
        page_type: "application",
        award_name:
          "National Aeronautics and Space Administration (NASA) - Jet Propulsion Laboratory (JPL) - Planetary Science Summer School",
      },
      {
        url: "https://www.jpl.nasa.gov/edu/internships/apply/nasa-science-mission-design-schools/",
        title: "Science Mission Design Schools",
        page_type: "application",
        award_name:
          "National Aeronautics and Space Administration (NASA) - Jet Propulsion Laboratory (JPL) - Planetary Science Summer School",
      },
      {
        url: "https://d2pn8kiwq2w21t.cloudfront.net/documents/NASA_SMDS_FAQ.pdf",
        title: "Frequently Asked Questions",
        page_type: "pdf",
        award_name:
          "National Aeronautics and Space Administration (NASA) - Jet Propulsion Laboratory (JPL) - Planetary Science Summer School",
      },
      {
        url: "https://d2pn8kiwq2w21t.cloudfront.net/documents/smds_financialsupport_01.2026.pdf",
        title: "Financial Support Requirements",
        page_type: "pdf",
        award_name:
          "National Aeronautics and Space Administration (NASA) - Jet Propulsion Laboratory (JPL) - Planetary Science Summer School",
      },
      {
        url: "https://grants.gov/search-results-detail/353267",
        title: "Maximizing Access to Research Careers (MARC) (T34)",
        page_type: "homepage",
        award_name: "MARC Undergraduate Student Training in Academic Research",
      },
      {
        url: "https://grants.nih.gov/grants/guide/pa-files/PAR-24-138.html",
        title: "Maximizing Access to Research Careers (MARC) (T34)",
        page_type: "homepage",
        award_name: "MARC Undergraduate Student Training in Academic Research",
      },
      {
        url: "http://www.wilsoncenter.org/opportunity/kennan-institute-short-term-grant",
        title: "Kennan Institute Short-Term Grant",
        page_type: "homepage",
        award_name:
          "Wilson Center / Kennan Institute - Short-Term Travel Grants for Research on Russia & the Former Soviet Union",
      },
      {
        url: "https://www.wilsoncenter.org/opportunity/kennan-institute-title-viii-supported-short-term-grant",
        title: "Kennan Institute Title VIII-Supported Short-Term Grant",
        page_type: "homepage",
        award_name:
          "Wilson Center / Kennan Institute - Short-Term Travel Grants for Research on Russia & the Former Soviet Union",
      },
      {
        url: "https://www.salliemae.com/landing/bridging-the-dream-for-graduates/",
        title: "Bridging the Dream Scholarship Program",
        page_type: "homepage",
        award_name:
          "Sallie Mae Fund / Thurgood Marshall College Fund (TMCF) - Bridging the Dream Scholarship Program for Graduate Students",
      },
      {
        url: "https://www.salliemae.com/content/dam/slm/writtencontent/Corporate/2026-2027_BTD_Grad_Official_Rules.pdf",
        title: "Official Rules",
        page_type: "pdf",
        award_name:
          "Sallie Mae Fund / Thurgood Marshall College Fund (TMCF) - Bridging the Dream Scholarship Program for Graduate Students",
      },
      {
        url: "https://www.aafcs.org/resources/recognition/fellowships",
        title: "Graduate Fellowships",
        page_type: "homepage",
        award_name: "American Association of Family and Consumer Sciences (AAFCS) - Graduate Fellowships",
      },
      {
        url: "https://www.fau.edu/artsandletters/huntington-library-short-term-fellowship/",
        title: "Huntington Library Short-Term Fellowship for Doctoral Candidates",
        page_type: "homepage",
        award_name: "Florida Atlantic-Huntington Library Short-Term Fellowship for Doctoral Candidates",
      },
    ]) {
      expect(shouldRejectDiscoveredSource(example)).toMatchObject({ action: "keep" });
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

  it("rejects UAlberta institutional spillover while keeping the Killam/Notley homepage", () => {
    const award_name = "University of Alberta - Killam and Notley Postdoctoral Fellowships";

    expect(
      shouldRejectDiscoveredSource({
        url: "https://www.ualberta.ca/research/research-support/post-doctoral-office/awards-funding/u-of-a-fellowships/index.html",
        title: "Homepage",
        page_type: "homepage",
        award_name,
      }),
    ).toMatchObject({ action: "keep" });

    for (const example of [
      {
        url: "https://calendar.ualberta.ca/content.php?catoid=69&navoid=20884",
        title: "Academic Schedule",
        page_type: "deadline",
      },
      {
        url: "https://docs.google.com/document/d/127klE0AU6e3FSUcaZopkS5OkRra9gURXAu20YSZqX1o/template/preview",
        title: "Noise Management Program",
        page_type: "pdf",
      },
      {
        url: "https://apply.ualberta.ca/account/register?r=https%3a%2f%2fapply.ualberta.ca%2fapply%2f",
        title: "Create an account",
        page_type: "application",
      },
      {
        url: "https://www.ualberta.ca/admissions-programs/exchange-programs/incoming-exchange-application-guide/admission-requirements/possible-exchange-programs.html",
        title: "Admission Requirements",
        page_type: "eligibility",
      },
    ]) {
      expect(shouldRejectDiscoveredSource({ ...example, award_name })).toMatchObject({
        action: "review_later",
        reason: "cross_program_source",
      });
    }
  });

  it("rejects NASA and NSF system pages that are not award sources", () => {
    const examples = [
      {
        url: "https://www.nasa.gov/open/data.html",
        title: ".gov/Open/Data",
        page_type: "deadline",
        award_name: "National Aeronautics & Space Administration (NASA) - Space Technology Graduate Research Fellowship (NSTGRO)",
      },
      {
        url: "http://materialsinspace.nasa.gov/",
        title: "Materials In Space",
        page_type: "requirements",
        award_name: "National Aeronautics & Space Administration (NASA) - Space Technology Graduate Research Fellowship (NSTGRO)",
      },
      {
        url: "http://science.nasa.gov/oss-guidance",
        title: "OSS Guidance",
        page_type: "eligibility",
        award_name: "Future Investigators in NASA Earth and Space Science and Technology",
      },
      {
        url: "http://research.gov/common/attachment/Desktop/NSFProjectReportTemplate.docx",
        title: "Download a project report template (DOCX).",
        page_type: "pdf",
        award_name: "National Science Foundation (NSF) - Postdoctoral Research Fellowships in Biology (PRFB)",
      },
    ];

    for (const example of examples) {
      expect(shouldRejectDiscoveredSource(example)).toMatchObject({
        action: "review_later",
        reason: "cross_program_source",
      });
    }
  });

  it("rejects Marquette institutional spillover while keeping the Mitchem homepage", () => {
    const award_name = "Marquette University - Mitchem Dissertation Completion Fellowships";

    expect(
      shouldRejectDiscoveredSource({
        url: "http://www.marquette.edu/provost/mitchem-dissertation-program.shtml",
        title: "Mitchem Dissertation Fellowship Program",
        page_type: "homepage",
        award_name,
      }),
    ).toMatchObject({ action: "keep" });

    for (const example of [
      {
        url: "https://admissions.marquette.edu/apply/",
        title: "Apply to Marquette",
        page_type: "application",
      },
      {
        url: "https://bulletin.marquette.edu/business-administration/business-administration.pdf",
        title: "2025-2026 Bulletin",
        page_type: "pdf",
      },
      {
        url: "https://www.marquette.edu/provost/policies-and-guidelines.php",
        title: "Policies and Guidelines",
        page_type: "requirements",
      },
      {
        url: "https://studentaid.gov/sites/default/files/attestation-and-validation-of-identity.pdf",
        title: "Attestation & Validation of Identity",
        page_type: "pdf",
      },
    ]) {
      expect(shouldRejectDiscoveredSource({ ...example, award_name })).toMatchObject({
        action: "review_later",
        reason: "cross_program_source",
      });
    }
  });

  it("rejects Rochester institutional spillover while keeping the Frederick Douglass postdoctoral page", () => {
    const award_name =
      "University of Rochester - Frederick Douglass Institute for African & African-American Studies - Postdoctoral Fellowship";

    expect(
      shouldRejectDiscoveredSource({
        url: "https://www.sas.rochester.edu/aas/fellowships/postdoctoral.html",
        title: "Postdoctoral Fellowship Overview",
        page_type: "homepage",
        award_name,
      }),
    ).toMatchObject({ action: "keep" });

    for (const example of [
      {
        url: "https://www.rochester.edu/college/gradstudies/prospective/apply.html",
        title: "How to Apply",
        page_type: "application",
      },
      {
        url: "https://www.sas.rochester.edu/aas/assets/pdf/PARTI-FDIInternalFacultyFellowship-applicant.pdf",
        title: "Faculty Fellowship Applicant Form",
        page_type: "pdf",
      },
      {
        url: "https://www.sas.rochester.edu/aas/undergraduate/douglass-prize.html",
        title: "Frederick Douglass Prize",
        page_type: "other",
      },
      {
        url: "https://www.urmc.rochester.edu/education/md/undergraduate-programs.cfm",
        title: "Summer Undergraduate Research Fellowship (SURF)",
        page_type: "application",
      },
    ]) {
      expect(shouldRejectDiscoveredSource({ ...example, award_name })).toMatchObject({
        action: "review_later",
        reason: "cross_program_source",
      });
    }
  });

  it("rejects Oxford institutional spillover while keeping Pershing Square scholarship pages", () => {
    const award_name = "Oxford Pershing Square Graduate Scholarship";

    for (const example of [
      {
        url: "https://www.sbs.ox.ac.uk/oxford-experience/scholarships-and-funding/oxford-pershing-square-graduate-scholarships",
        title: "Oxford Pershing Square Graduate Scholarships",
        page_type: "homepage",
      },
      {
        url: "http://www.sbs.oxford.edu/1plus1",
        title: "Oxford 1+1 MBA",
        page_type: "application",
      },
    ]) {
      expect(shouldRejectDiscoveredSource({ ...example, award_name })).toMatchObject({
        action: "keep",
      });
    }

    for (const example of [
      {
        url: "https://www.ox.ac.uk/admissions/graduate",
        title: "Graduate admissions",
        page_type: "application",
      },
      {
        url: "https://www.sbs.ox.ac.uk/oxford-experience/scholarships-and-funding/laidlaw-scholarships",
        title: "Laidlaw Scholarships",
        page_type: "other",
      },
      {
        url: "https://www.sbs.ox.ac.uk/oxford-experience/scholarships-and-funding/oxford-pershing-square-scholarship/oxford-pershing-square-graduate-scholarships-profiles",
        title: "Oxford Pershing Square Graduate Scholarships profiles",
        page_type: "other",
      },
      {
        url: "https://www.physics.ox.ac.uk/study/undergraduates/how-apply",
        title: "How to Apply",
        page_type: "application",
      },
    ]) {
      expect(shouldRejectDiscoveredSource({ ...example, award_name })).toMatchObject({
        action: "review_later",
        reason: "cross_program_source",
      });
    }
  });

  it("rejects SSHRC catalog spillover while keeping postdoctoral fellowship sources", () => {
    const award_name =
      "Social Science and Humanities Research Council of Canada (SSHRC) - Postdoctoral Fellowships";

    for (const example of [
      {
        url: "http://www.sshrc-crsh.gc.ca/funding-financement/programs-programmes/fellowships/postdoctoral-postdoctorale-eng.aspx",
        title: "SSHRC Postdoctoral Fellowships",
        page_type: "homepage",
      },
      {
        url: "http://www.sshrc-crsh.gc.ca/funding-financement/apply-demande/guides/doctoral_postdoctoral_edi_guide-doctorat_postdoctorales_guide_edi-eng.aspx",
        title: "Guide to Including Diversity Considerations in Research Design for Doctoral and Postdoctoral Award Applicants",
        page_type: "application",
      },
    ]) {
      expect(shouldRejectDiscoveredSource({ ...example, award_name })).toMatchObject({
        action: "keep",
      });
    }

    for (const example of [
      {
        url: "http://www.sshrc-crsh.gc.ca/funding-financement/nfrf-fnfr/exploration/2026/competition-concours-eng.aspx",
        title: "2026 Exploration Competition",
        page_type: "other",
      },
      {
        url: "https://www.sshrc-crsh.gc.ca/funding-financement/cbrf-frbc/stage2-etape2/competition-concours/4-eligibility-eng.aspx",
        title: "4. Eligibility",
        page_type: "eligibility",
      },
      {
        url: "http://www.sshrc-crsh.gc.ca/en/funding/opportunities/canada-graduate-research-scholarships/doctoral-program.aspx",
        title: "Canada Graduate Research Scholarship-Doctoral program",
        page_type: "application",
      },
      {
        url: "https://portal-portail.sshrc-crsh.gc.ca/?pedisable=true",
        title: "Basic HTML version",
        page_type: "application",
      },
      {
        url: "https://www.nserc-crsng.gc.ca/InterAgency-Interorganismes/RS-SR/_doc/Attestation_e.pdf",
        title: "Attestation forms",
        page_type: "pdf",
      },
    ]) {
      expect(shouldRejectDiscoveredSource({ ...example, award_name })).toMatchObject({
        action: "review_later",
        reason: "cross_program_source",
      });
    }
  });

  it("rejects NIH/NIA R36 spillover while keeping Aging Dissertation award sources", () => {
    const award_name =
      "National Institutes of Health (NIH) - National Institute of Aging (NIA) - Aging Research Dissertation Awards to Increase Diversity (R36)";

    for (const example of [
      {
        url: "https://www.nia.nih.gov/research/training/r36-aging-research-dissertation-awards-promote-diversity",
        title: "R36 Aging Research Dissertation Awards to Promote Diversity",
        page_type: "homepage",
      },
      {
        url: "https://www.nia.nih.gov/research/training/r36-aging-research-dissertation-awards-increase-diversity",
        title: "R36 Aging Research Dissertation Awards to Increase Diversity",
        page_type: "homepage",
      },
      {
        url: "https://grants.nih.gov/grants/guide/pa-files/PAR-24-183.html",
        title: "Aging Research Dissertation Awards to Promote Diversity (R36 Clinical Trial Not Allowed)",
        page_type: "homepage",
      },
    ]) {
      expect(shouldRejectDiscoveredSource({ ...example, award_name })).toMatchObject({
        action: "keep",
      });
    }

    for (const example of [
      {
        url: "https://grants.nih.gov/grants/guide/notice-files/NOT-OD-09-114.html",
        title: "Applicants eligible for continuous submission",
        page_type: "eligibility",
      },
      {
        url: "https://www.era.nih.gov/reviewers/access-meeting-materials.htm",
        title: "Access Meeting Materials",
        page_type: "requirements",
      },
      {
        url: "https://www.nia.nih.gov/research/grants-funding/funding-policies-and-paylines",
        title: "Funding line policies",
        page_type: "application",
      },
      {
        url: "https://cdn.clinicaltrials.gov/documents/ACT_Checklist.pdf",
        title: "Checklist for Evaluating Whether a Clinical Trial or Study is an Applicable Clinical Trial",
        page_type: "pdf",
      },
    ]) {
      expect(shouldRejectDiscoveredSource({ ...example, award_name })).toMatchObject({
        action: "review_later",
        reason: "cross_program_source",
      });
    }
  });

  it("rejects NSF EAR-PF spillover while keeping Earth Sciences postdoctoral pages", () => {
    const award_name = "National Science Foundation (NSF) - Division of Earth Sciences (EAR) Postdoctoral Fellowships";

    for (const example of [
      {
        url: "https://www.nsf.gov/funding/opportunities/ear-postdoctoral-fellowships-ear-pf",
        title: "EAR-PF Solicitation",
        page_type: "homepage",
      },
      {
        url: "https://beta.nsf.gov/funding/opportunities/ear-postdoctoral-fellowships-ear-pf",
        title: "Earth Sciences Postdoctoral Fellowships (EAR-PF)",
        page_type: "homepage",
      },
    ]) {
      expect(shouldRejectDiscoveredSource({ ...example, award_name })).toMatchObject({
        action: "keep",
      });
    }

    for (const example of [
      {
        url: "https://www.nsf.gov/funding/opportunities/dmref-designing-materials-revolutionize-engineer-our-future/nsf23-530/solicitation",
        title: "Designing Materials to Revolutionize and Engineer our Future (DMREF)",
        page_type: "requirements",
      },
      {
        url: "https://www.nsf.gov/publications/pub_summ.jsp?ods_key=nsf25020",
        title: "Division of Earth Sciences (EAR) Realignment FAQs",
        page_type: "faq",
      },
      {
        url: "https://seedfund.nsf.gov/apply/",
        title: "Apply for funding",
        page_type: "application",
      },
      {
        url: "https://resources.research.gov/common/attachment/Common/Grants_govProposal_Processing_in_Research.pdf",
        title: "Grants.gov Proposal Processing in Research.gov",
        page_type: "pdf",
      },
    ]) {
      expect(shouldRejectDiscoveredSource({ ...example, award_name })).toMatchObject({
        action: "review_later",
        reason: "cross_program_source",
      });
    }
  });

  it("rejects NSF PRFB crawler spillover while keeping PRFB-specific sources", () => {
    const award_name = "National Science Foundation (NSF) - Postdoctoral Research Fellowships in Biology (PRFB)";

    for (const example of [
      {
        url: "https://www.nsf.gov/funding/opportunities/prfb-postdoctoral-research-fellowships-biology",
        title: "Postdoctoral Research Fellowships in Biology (PRFB)",
        page_type: "homepage",
      },
      {
        url: "https://www.nsf.gov/funding/opportunities/prfb-postdoctoral-research-fellowships-biology/nsf26-504/solicitation",
        title: "26-504",
        page_type: "other",
      },
      {
        url: "https://www.nsf.gov/policies/document/postdoctoral-research-fellowships-biology-prfb",
        title: "(PRFB) Administrative Guide (NSF 25-032)",
        page_type: "other",
      },
      {
        url: "https://www.nsf.gov/bio/prfb/applicant_how_to_apply_prfb.pdf",
        title: "How to Apply for Fellowship Applicants",
        page_type: "pdf",
      },
      {
        url: "https://nsf-gov-resources.nsf.gov/files/Postdoc_Reference_Letter_Submission_Guide_Sept_2024_Final_508%201_0.pdf",
        title: "Reference Letter Author Submission Guide",
        page_type: "pdf",
      },
    ]) {
      expect(shouldRejectDiscoveredSource({ ...example, award_name })).toMatchObject({
        action: "keep",
      });
    }

    for (const example of [
      {
        url: "https://seedfund.nsf.gov/apply/",
        title: "Apply for funding",
        page_type: "application",
      },
      {
        url: "https://www.nsf.gov/bfa/dias/policy/rppr/",
        title: "Research Performance Progress Report",
        page_type: "requirements",
      },
      {
        url: "https://new.nsf.gov/policies/document/nsf-grantsgov-application-guide",
        title: "Grants.gov Application Guide",
        page_type: "pdf",
      },
      {
        url: "https://www.whitehouse.gov/wp-content/uploads/2025/07/Americas-AI-Action-Plan.pdf",
        title: "America's AI Action Plan",
        page_type: "pdf",
      },
      {
        url: "https://www.sbir.gov/sites/default/files/elig_size_compliance_guide.pdf",
        title: "Guide to SBIR/STTR Program Eligibility",
        page_type: "pdf",
      },
      {
        url: "https://www..nsf.gov/funding/opportunities/postdoctoral-research-fellowships-biology-prfb",
        title: "Page",
        page_type: "application",
      },
      {
        url: "https://nsf-gov-resources.nsf.gov/files/Postdoc_Reference_Letter_Submission_Guide_Sept_2024_Final_508%201_0.pdf?VersionId=cwogsX4E2fvH1cd_I6vRY5ADeQ218BSL",
        title: "Reference Letter Author Submission Guide",
        page_type: "pdf",
      },
      {
        url: "https://www.nsf.gov/funding/opportunities/prfb-postdoctoral-research-fellowships-biology/503622/nsf22-623/solicitation",
        title: "22-623",
        page_type: "other",
      },
    ]) {
      expect(shouldRejectDiscoveredSource({ ...example, award_name })).toMatchObject({
        action: "review_later",
        reason: "cross_program_source",
      });
    }
  });

  it("rejects NSF AGS-PRF crawler spillover while keeping AGS-specific sources", () => {
    const award_name =
      "National Science Foundation (NSF) - Atmospheric and Geospace Sciences (AGS) Postdoctoral Fellowships";

    for (const example of [
      {
        url: "http://www.nsf.gov/funding/pgm_summ.jsp?pims_id=12779&org=NSF",
        title: "Atmospheric and Geospace Sciences Postdoctoral Research Fellowships (AGS-PRF)",
        page_type: "homepage",
      },
      {
        url: "https://www.nsf.gov/funding/opportunities/ags-prf-atmospheric-geospace-sciences-postdoctoral-research",
        title: "Atmospheric and Geospace Sciences Postdoctoral Research Fellowships (AGS-PRF)",
        page_type: "other",
      },
      {
        url: "https://www.nsf.gov/funding/opportunities/ags-prf-atmospheric-geospace-sciences-postdoctoral-research/nsf22-639/solicitation",
        title: "22-639",
        page_type: "other",
      },
      {
        url: "https://www.nsf.gov/funding/information/faq-program-solicitation-nsf-22-639-atmospheric-geospace",
        title: "Atmospheric and Geospace Sciences Postdoctoral Research Fellowships (AGS-PRF) (NSF 22-639)",
        page_type: "faq",
      },
    ]) {
      expect(shouldRejectDiscoveredSource({ ...example, award_name })).toMatchObject({
        action: "keep",
      });
    }

    for (const example of [
      {
        url: "https://www.nsf.gov/geo/programs",
        title: "GEO Programs - Directorate for Geosciences (GEO)",
        page_type: "other",
      },
      {
        url: "https://nsf-gov-resources.nsf.gov/2023-11/TMT_FAQs.website.11.08.23.pdf",
        title: "Frequently Asked Questions, including",
        page_type: "pdf",
      },
      {
        url: "https://seedfund.nsf.gov/apply/",
        title: "Apply for funding",
        page_type: "application",
      },
      {
        url: "https://resources.research.gov/common/attachment/Common/Grants_govProposal_Processing_in_Research.pdf",
        title: "Grants.gov Proposal Processing in Research.gov",
        page_type: "pdf",
      },
      {
        url: "https://ceq.doe.gov/docs/get-involved/citizens-guide-to-nepa-2021.pdf",
        title: "A Citizen's Guide to NEPA",
        page_type: "pdf",
      },
      {
        url: "https://www.nsf.gov/funding/opportunities/ags-prf-atmospheric-geospace-sciences-postdoctoral-research/nsf19-574/solicitation",
        title: "19-574",
        page_type: "other",
      },
    ]) {
      expect(shouldRejectDiscoveredSource({ ...example, award_name })).toMatchObject({
        action: "review_later",
        reason: "cross_program_source",
      });
    }
  });

  it("rejects Trinity crawler spillover while keeping the Ann Plato fellowship page", () => {
    const award_name = "Trinity College - Ann Plato Postdoctoral/Post-MFA Fellowship";

    expect(
      shouldRejectDiscoveredSource({
        url: "https://www.trincoll.edu/dean-of-faculty/faculty-development/faculty-diversity/ann-plato/",
        title: "Ann Plato Postdoctoral/Post-MFA Fellowship",
        page_type: "homepage",
        award_name,
      }),
    ).toMatchObject({ action: "keep" });

    for (const example of [
      {
        url: "https://www.trincoll.edu/admissions/apply/",
        title: "Admissions Application",
        page_type: "application",
      },
      {
        url: "https://bulletin.trincoll.edu/programs/AHIS/requirements-krhha",
        title: "Art history major requirements",
        page_type: "requirements",
      },
      {
        url: "https://forms.trincoll.edu/dofo/finalist-search-form-form-3/",
        title: "Finalist Search Form",
        page_type: "application",
      },
      {
        url: "https://www.trincoll.edu/dean-of-faculty/faculty-development/faculty-hiring/",
        title: "Faculty Hiring",
        page_type: "application",
      },
      {
        url: "https://www.trincoll.edu/dean-of-faculty/wp-content/uploads/sites/52/2020/10/BiasBrochure.pdf",
        title: "Reviewing Applicants: Research on Bias and Assumptions",
        page_type: "pdf",
      },
      {
        url: "https://internet3.trincoll.edu/FacMan/FacultyManual.pdf",
        title: "Faculty Manual",
        page_type: "pdf",
      },
    ]) {
      expect(shouldRejectDiscoveredSource({ ...example, award_name })).toMatchObject({
        action: "review_later",
        reason: "official_domain_spillover",
      });
    }
  });

  it("rejects Department of Education crawler spillover while keeping FLAS program pages", () => {
    const award_name = "Foreign Language and Area Studies Fellowship";

    for (const example of [
      {
        url: "https://iris.ed.gov/programs/flas",
        title: "Foreign Language and Area Studies Fellowships Program",
        page_type: "homepage",
      },
      {
        url: "https://www2.ed.gov/programs/iegpsflasf/index.html",
        title: "Foreign Language and Area Studies Fellowships Program",
        page_type: "homepage",
      },
    ]) {
      expect(shouldRejectDiscoveredSource({ ...example, award_name })).toMatchObject({
        action: "keep",
      });
    }

    for (const example of [
      {
        url: "https://www2.ed.gov/laws-and-policy/laws-preschool-grade-12-education/birth-grade-12-policy-documents",
        title: "Birth to Grade 12 Policy Documents",
        page_type: "requirements",
      },
      {
        url: "https://www2.ed.gov/sites/ed/files/fund/grant/apply/appforms/sf424b.pdf",
        title: "SF-424 Assurances Form",
        page_type: "pdf",
      },
      {
        url: "https://www2.ed.gov/grants-and-programs/grants-higher-education/international-and-foreign-language-education/centers-aligned-areas-national-need-caann-program-84015c",
        title: "Centers Aligned with Areas of National Need Program",
        page_type: "deadline",
      },
      {
        url: "https://www.ed.gov/grants-and-programs",
        title: "U.S. Department of Education Grants and Programs",
        page_type: "eligibility",
      },
      {
        url: "https://whitehouse.gov/wp-content/uploads/2019/10/M-20-02-Guidance-Memo.pdf",
        title: "OMB Memorandum M-20-02",
        page_type: "pdf",
      },
    ]) {
      expect(shouldRejectDiscoveredSource({ ...example, award_name })).toMatchObject({
        action: "review_later",
        reason: "official_domain_spillover",
      });
    }
  });

  it("rejects NOAA Hollings crawler spillover while keeping real Hollings pages", () => {
    const award_name = "Ernest F. Hollings Undergraduate Scholarship (NOAA)";

    for (const example of [
      {
        url: "https://www.noaa.gov/office-education/hollings-scholarship",
        title: "Ernest F. Hollings Undergraduate Scholarship",
        page_type: "homepage",
      },
      {
        url: "https://www.noaa.gov/office-education/hollings-scholarship/prospective/faq",
        title: "Frequently Asked Questions for Applicants",
        page_type: "faq",
      },
      {
        url: "https://www.noaa.gov/node/15665",
        title: "Hollings Scholarship Student Manual",
        page_type: "deadline",
      },
      {
        url: "https://www.noaa.gov/sites/default/files/legacy/document/2019/Jun/hollings_travel_request_form.pdf",
        title: "Travel Request Form",
        page_type: "pdf",
      },
      {
        url: "https://oedwebdbapps.iso.noaa.gov/uspa/",
        title: "Undergraduate Scholarship Programs Application",
        page_type: "application",
      },
    ]) {
      expect(shouldRejectDiscoveredSource({ ...example, award_name })).toMatchObject({
        action: "keep",
      });
    }

    for (const example of [
      {
        url: "https://www.noaa.gov/guidance",
        title: "NOAA Guidance Documents",
        page_type: "application",
      },
      {
        url: "https://www.noaa.gov/about-our-agency",
        title: "NOAA's mission",
        page_type: "faq",
      },
      {
        url: "https://www.noaa.gov/noaa_landing_page/comment_modal?email=education%40noaa.gov",
        title: "Comment on this page",
        page_type: "faq",
      },
      {
        url: "https://www.noaa.gov/office-education/hollings-scholarship/current/class-of-2025-2027-hollings-scholar-profiles",
        title: "Class of 2025-2027 Hollings scholar profiles",
        page_type: "other",
      },
      {
        url: "https://www.fisheries.noaa.gov/grant/coastal-habitat-restoration-and-resilience-grants-underserved-communities",
        title: "Coastal Habitat Restoration and Resilience Grants",
        page_type: "application",
      },
      {
        url: "https://media.fisheries.noaa.gov/2025-01/habitat-restoration-grant.pdf",
        title: "Habitat Restoration Grant PDF",
        page_type: "pdf",
      },
      {
        url: "https://helpx.adobe.com/acrobat/using/create-customize-pdf-portfolios.html",
        title: "Create PDF Portfolios",
        page_type: "pdf",
      },
    ]) {
      expect(shouldRejectDiscoveredSource({ ...example, award_name })).toMatchObject({
        action: "review_later",
        reason: "official_domain_spillover",
      });
    }
  });

  it("rejects AHA fellowship CPR and guideline spillover while keeping research application pages", () => {
    const postdocAward = "American Heart Association (AHA) - Postdoctoral Fellowship";
    const predocAward = "American Heart Association (AHA) - Predoctoral Fellowship";

    for (const example of [
      {
        award_name: postdocAward,
        url: "https://professional.heart.org/en/research-programs/application-information/postdoctoral-fellowship",
        title: "Postdoctoral Fellowship",
        page_type: "application",
      },
      {
        award_name: predocAward,
        url: "https://professional.heart.org/en/research-programs/aha-funding-opportunities/predoctoral-fellowship",
        title: "2027 American Heart Association Predoctoral Fellowship",
        page_type: "homepage",
      },
      {
        award_name: predocAward,
        url: "https://professional.heart.org/en/research-programs/application-resources/required-application-documents/biosketch-instructions",
        title: "Biosketch Instructions",
        page_type: "application",
      },
      {
        award_name: postdocAward,
        url: "https://professional.heart.org/en/-/media/PHD-Files/Research/Application-Instructions/AHA_Research_Funding_Application_Instructions_AC.pdf?sc_lang=en",
        title: "Application Instructions",
        page_type: "pdf",
      },
    ]) {
      expect(shouldRejectDiscoveredSource(example)).toMatchObject({
        action: "keep",
      });
    }

    for (const example of [
      {
        award_name: predocAward,
        url: "https://cpr.heart.org/en/resuscitation-science/cpr-and-ecc-guidelines",
        title: "CPR & ECC Guidelines",
        page_type: "requirements",
      },
      {
        award_name: postdocAward,
        url: "https://apps.apple.com/us/app/aha-acls/id1506944443",
        title: "Download in the Apple Store",
        page_type: "pdf",
      },
      {
        award_name: predocAward,
        url: "https://professional.heart.org/-/media/PHD-Files/Guidelines-and-Statements/Correspondence/AACVPR_AHA_ACC_Scientific_Statement_ucm_505694.pdf?sc_lang=en",
        title: "Scientific Statement on Cardiac Rehabilitation",
        page_type: "pdf",
      },
      {
        award_name: postdocAward,
        url: "https://professional.heart.org/en/guidelines-and-statements/correspondence",
        title: "Correspondence",
        page_type: "requirements",
      },
      {
        award_name: predocAward,
        url: "https://professional.heart.org/en/research-programs/sure-scholars",
        title: "SURE Scholars Program",
        page_type: "other",
      },
      {
        award_name: postdocAward,
        url: "https://www.heart.org/en/about-us/editorial-guidelines",
        title: "Editorial Guidelines",
        page_type: "requirements",
      },
      {
        award_name: predocAward,
        url: "https://professional.heart.org/-/media/PHD-Files/Meetings/ISC/2022/Alert--Fraud-Registration-and-Housing-Vendors.pdf?sc_lang=en",
        title: "Fraud Concerns - International Stroke Conference",
        page_type: "pdf",
      },
      {
        award_name: postdocAward,
        url: "https://professional.heart.org/en/research-programs/application-resources/required-application-documents/department-head-letter-instructions",
        title: "Department Head Letter Instructions",
        page_type: "application",
      },
      {
        award_name: postdocAward,
        url: "https://professional.heart.org/en/research-programs/application-resources/required-application-documents/consultant-information",
        title: "Consultant Information",
        page_type: "application",
      },
      {
        award_name: predocAward,
        url: "https://professional.heart.org/en/research-programs/application-resources/required-application-documents/collaborating-investigator-information",
        title: "Collaborating Investigator Information",
        page_type: "application",
      },
      {
        award_name: predocAward,
        url: "https://professional.heart.org/en/research-programs/application-resources/required-application-documents/mentoring-team-for-the-career-development-award-information",
        title: "Mentoring Team for the Career Development Award",
        page_type: "application",
      },
      {
        award_name: postdocAward,
        url: "https://professional.heart.org/en/research-programs/awardee-resources/open-science-frequently-asked-questions",
        title: "Open Science - Frequently Asked Questions",
        page_type: "faq",
      },
      {
        award_name: predocAward,
        url: "https://higherlogicdownload.s3.amazonaws.com/NEUROCRITICALCARE/b8b3b384-bfb9-42af-bb55-45973d5054a4/UploadedImages/Documents/Guidelines/LHI_Final_GL-Published.pdf",
        title: "Evidence-Based Guidelines for the Management of Large Hemispheric Infarction",
        page_type: "pdf",
      },
    ]) {
      expect(shouldRejectDiscoveredSource(example)).toMatchObject({
        action: "review_later",
        reason: "official_domain_spillover",
      });
    }
  });

  it("rejects Eisenhower Transportation Fellowship crawl spillover while keeping the canonical homepage", () => {
    const award_name = "Dwight David Eisenhower Transportation Fellowship Program";

    expect(
      shouldRejectDiscoveredSource({
        award_name,
        url: "https://highways.dot.gov/careers/dwight-david-eisenhower-transportation-fellowship-program",
        title: "Dwight David Eisenhower Transportation Fellowship Program",
        page_type: "homepage",
      }),
    ).toMatchObject({
      action: "keep",
    });

    for (const example of [
      {
        url: "https://www.fhwa.dot.gov/careers/ddetfp.cfm",
        title: "Dwight David Eisenhower Transportation Fellowship Program",
        page_type: "homepage",
      },
      {
        url: "https://www.fhwa.dot.gov/guidance/",
        title: "Federal Highway Policy & Guidance Center",
        page_type: "application",
      },
      {
        url: "https://www.fhwa.dot.gov/bridge/steel/pubs/hif18042.pdf",
        title: "Steel Truss Member Strengthening Design Example",
        page_type: "pdf",
      },
      {
        url: "https://www.fhwa.dot.gov/exit.cfm?link=http://onlinepubs.trb.org/Onlinepubs/circulars/ec037.pdf",
        title: "TRB Circular E-C037",
        page_type: "pdf",
      },
      {
        url: "https://safety.fhwa.dot.gov/legislationandpolicy/fast/guidance.cfm",
        title: "HSIP Eligibility Guidance",
        page_type: "eligibility",
      },
      {
        url: "https://www.in.gov/dot/div/contracts/standards/book/sep07/2008Master.pdf",
        title: "Indiana DOT standards book",
        page_type: "pdf",
      },
    ]) {
      expect(shouldRejectDiscoveredSource({ ...example, award_name })).toMatchObject({
        action: "review_later",
        reason: "official_domain_spillover",
      });
    }
  });

  it("rejects GFOA general finance crawl spillover while keeping scholarship pages", () => {
    const award_name = "Government Finance Officers Association (GFOA) - Scholarships";

    for (const example of [
      {
        url: "https://www.gfoa.org/gfoascholarships",
        title: "GFOA Scholarships",
        page_type: "homepage",
      },
      {
        url: "https://www.gfoa.org/academic-scholarships",
        title: "Academic Scholarships",
        page_type: "application",
      },
      {
        url: "https://www.gfoa.org/available-scholarships",
        title: "Available Scholarships",
        page_type: "application",
      },
      {
        url: "https://www.gfoa.org/cpfo-enrollment-scholarships",
        title: "CPFO Enrollment Scholarships",
        page_type: "application",
      },
      {
        url: "https://www.gfoa.org/cpfo-scholarship-faqs",
        title: "Frequently Asked Questions about the CPFO Enrollment Scholarships",
        page_type: "faq",
      },
      {
        url: "https://www.gfoa.org/gfoas-leadership-development-scholarship",
        title: "GFOA's Leadership Development Scholarship",
        page_type: "application",
      },
      {
        url: "https://www.gfoa.org/leadership-academy-application",
        title: "Leadership Academy Application",
        page_type: "application",
      },
    ]) {
      expect(shouldRejectDiscoveredSource({ ...example, award_name })).toMatchObject({
        action: "keep",
      });
    }

    for (const example of [
      {
        url: "https://www.gfoa.org/bio/roach",
        title: "Eric Roach - Government Finance Officers Association",
        page_type: "homepage",
      },
      {
        url: "https://www.gfoa.org/materials",
        title: "Materials Library",
        page_type: "requirements",
      },
      {
        url: "https://www.gfoa.org/materials/gfr1225-afe",
        title: "2025 Awards for Excellence in Government Finance",
        page_type: "requirements",
      },
      {
        url: "https://www.gfoa.org/2026-academic-scholarship-winners",
        title: "2026 Academic Scholarship Winners",
        page_type: "other",
      },
      {
        url: "https://www.gfoa.org/scholarship-spotlight-gilbert-teklevchiev",
        title: "GFOA Scholarship Spotlight: Gilbert Teklevchiev",
        page_type: "other",
      },
      {
        url: "https://members.gfoa.org/Gfoamember/Gfoamember/logout.aspx?URLSITE=https://www.gfoa.org/member-logout/materials/gfr0426-lessons",
        title: "Log Out",
        page_type: "requirements",
      },
      {
        url: "https://gfoa-craftcms.files.svdcdn.com/production/general/gfr0426-Lessons-From-High-Performing-Governments.pdf?dm=1777500959",
        title: "Lessons From High Performing Governments",
        page_type: "pdf",
      },
      {
        url: "https://www.irs.gov/pub/irs-drop/n-25-69.pdf",
        title: "published guidance",
        page_type: "pdf",
      },
    ]) {
      expect(shouldRejectDiscoveredSource({ ...example, award_name })).toMatchObject({
        action: "review_later",
        reason: "official_domain_spillover",
      });
    }

    expect(
      shouldRejectDiscoveredSource({
        award_name,
        url: "https://www.facebook.com/sharer/sharer.php?u=https%3A%2F%2Fwww.gfoa.org%2Favailable-scholarships",
        title: "Share on Facebook",
        page_type: "other",
      }),
    ).toMatchObject({
      action: "review_later",
    });
  });

  it("rejects Rhodes University whole-site spillover while keeping postdoctoral fellowship sources", () => {
    const award_name = "Rhodes University (South Africa) - Postdoctoral Fellowship";

    for (const example of [
      {
        url: "https://www.ru.ac.za/researchgateway//postdoctoralfellows/",
        title: "Postdoctoral Research Fellowships",
        page_type: "homepage",
      },
      {
        url: "https://www.ru.ac.za/media/rhodesuniversity/content/research/documents/postdoctoral/2026_CSSR_Postdoc_Application_Form.docx",
        title: "CSSR Postdoctoral Application Form",
        page_type: "pdf",
      },
      {
        url: "https://www.ru.ac.za/media/rhodesuniversity/content/research/documents/postdoctoral/2026_RU_Postdoc_Application_Form.docx",
        title: "RU Postdoc Application Form",
        page_type: "pdf",
      },
      {
        url: "https://www.ru.ac.za/media/rhodesuniversity/content/research/documents/postdoctoral/RU_Post-Doctoral_2nd_Year_Renewal_Application.doc",
        title: "RU Postdoc Renewal Application",
        page_type: "pdf",
      },
    ]) {
      expect(shouldRejectDiscoveredSource({ ...example, award_name })).toMatchObject({
        action: "keep",
      });
    }

    for (const example of [
      {
        url: "https://www.ru.ac.za/admissiongateway/",
        title: "Apply for Admissions",
        page_type: "application",
      },
      {
        url: "https://www.ru.ac.za/researchgateway/postgraduates/funding/",
        title: "Postgraduate Funding",
        page_type: "other",
      },
      {
        url: "https://www.ru.ac.za/criticalstudies/",
        title: "Critical Studies in Sexualities and Reproduction",
        page_type: "eligibility",
      },
      {
        url: "https://www.ru.ac.za/media/rhodesuniversity/content/criticalstudiesinsexualitiesandreproduction/documents/CSSR_-_MSSA_Study_Research_Toolkit_-_2020.pdf",
        title: "CSSR/MSSA research toolkit",
        page_type: "pdf",
      },
      {
        url: "https://www.ru.ac.za/media/rhodesuniversity/content/research/documents/funding/Application_Guide_for_SARAO_Doctoral_Scholarships_for_2026.pdf",
        title: "Application Guide for SARAO Doctoral Scholarships",
        page_type: "pdf",
      },
      {
        url: "https://ross.ru.ac.za/ugadmissions",
        title: "Online Application",
        page_type: "application",
      },
      {
        url: "https://www.assaf.org.za/wp-content/uploads/2026/03/Call-for-Nominations-for-SAYAS-new-Members-2026.pdf",
        title: "SAYAS new members call",
        page_type: "pdf",
      },
    ]) {
      expect(shouldRejectDiscoveredSource({ ...example, award_name })).toMatchObject({
        action: "review_later",
        reason: "official_domain_spillover",
      });
    }
  });

  it("rejects LLNL sibling job and research spillover while keeping Lawrence Fellowship sources", () => {
    const award_name = "Lawrence Livermore National Laboratory (LLNL) - Lawrence Postdoctoral Fellowship";

    for (const example of [
      {
        url: "https://st.llnl.gov/opportunities/postdocs/postdoc-program/lawrence-fellowship",
        title: "Lawrence Fellowship",
        page_type: "homepage",
      },
      {
        url: "https://st.llnl.gov/opportunities/postdocs/postdoc-program/lawrence-fellowship/learn-more-and-apply",
        title: "Lawrence Fellowship: Learn more and apply",
        page_type: "application",
      },
      {
        url: "https://st.llnl.gov/sites/default/files/inline-files/LF-Flyer-2025.pdf",
        title: "Lawrence Fellowship Flyer",
        page_type: "pdf",
      },
      {
        url: "https://st.llnl.gov/sites/default/files/inline-files/Interest_Statement_example_0.pdf",
        title: "Interest Statement Example",
        page_type: "pdf",
      },
      {
        url: "https://jobs.smartrecruiters.com/LLNL/3743990009710696-lawrence-fellowship-postdoctoral-researcher",
        title: "LLNL Lawrence Fellowship Postdoctoral Researcher",
        page_type: "application",
      },
      {
        url: "https://us.smrtr.io/49s7z",
        title: "Submit Application",
        page_type: "application",
      },
    ]) {
      expect(shouldRejectDiscoveredSource({ ...example, award_name })).toMatchObject({
        action: "keep",
      });
    }

    for (const example of [
      {
        url: "https://st.llnl.gov/node/943",
        title: "Lawrence Fellowship: How to Apply Button",
        page_type: "application",
      },
      {
        url: "https://st.llnl.gov/opportunities/postdocs/postdoc-program/lawrence-fellowship/current-and-past-lawrence-fellows",
        title: "Current and Former Lawrence Fellows",
        page_type: "other",
      },
      {
        url: "https://st.llnl.gov/opportunities/postdocs/postdoc-program/lawrence-fellowship/current-and-past-lawrence-fellows/zachary-sims",
        title: "Zachary Sims",
        page_type: "other",
      },
      {
        url: "https://st.llnl.gov/sci-ed/SAGE/application-process",
        title: "SAGE Application Process",
        page_type: "application",
      },
      {
        url: "https://www.llnl.gov/join-our-team/careers/find-your-job/8197899c-8f04-4c2a-a3eb-b3bfe99148bf/all/3743990013835796",
        title: "John S. Foster, Jr. and Harold Brown Postdoctoral Fellowships",
        page_type: "application",
      },
      {
        url: "https://pls.llnl.gov/research-and-development/materials-science",
        title: "Materials Science",
        page_type: "requirements",
      },
      {
        url: "https://ldrd-annual.llnl.gov/ldrd-annual-2023/project-highlights/accelerated-materials-and-manufacturing/powderjet-agile-system-high-quality-metal-powder-production",
        title: "PowderJet",
        page_type: "requirements",
      },
      {
        url: "https://st.llnl.gov/sites/default/files/2022-11/Sea%20Change%20in%20High%20School%20STEM%20Education.pdf",
        title: "Sea Change in High School STEM Education",
        page_type: "pdf",
      },
    ]) {
      expect(shouldRejectDiscoveredSource({ ...example, award_name })).toMatchObject({
        action: "review_later",
        reason: "official_domain_spillover",
      });
    }
  });

  it("rejects NASA aerospace-history fellowship spillover while keeping real fellowship pages", () => {
    const award_name =
      "American Historical Association (AHA) and the National Aeronautics & Space Administration (NASA) - Doctoral & Postdoctoral Fellowships in Aerospace History";

    for (const example of [
      {
        url: "https://www.nasa.gov/history/history-office/fellowships/",
        title: "NASA History Office Fellowships",
        page_type: "homepage",
      },
      {
        url: "https://www.historians.org/award-grant/fellowships-in-aerospace-history/",
        title: "Fellowships in Aerospace History",
        page_type: "homepage",
      },
      {
        url: "https://www.historyoftechnology.org/awards/nasa-fellowship-in-the-history-of-space-technology/",
        title: "NASA Fellowship in the History of Space Technology",
        page_type: "homepage",
      },
      {
        url: "https://hssonline.org/page/nasafellowship",
        title: "NASA Fellowship in the History of Space Science",
        page_type: "homepage",
      },
    ]) {
      expect(shouldRejectDiscoveredSource({ ...example, award_name })).toMatchObject({
        action: "keep",
      });
    }

    for (const example of [
      {
        url: "https://www.nasa.gov/international-space-station/",
        title: "International Space Station",
        page_type: "other",
      },
      {
        url: "http://www.nasa.gov/artemis",
        title: "Artemis",
        page_type: "other",
      },
      {
        url: "https://www.nasa.gov/history/history-publications-and-resources/aeronautics-and-space-report-of-the-president/",
        title: "Aeronautics and Space Report of the President",
        page_type: "other",
      },
      {
        url: "https://www.nasa.gov/learning-resources/internship-programs/",
        title: "Internship Programs",
        page_type: "application",
      },
      {
        url: "https://stemgateway.nasa.gov/public/s/explore-opportunities",
        title: "Click Here to Explore Our Opportunities and Apply",
        page_type: "application",
      },
      {
        url: "https://www.earthdata.nasa.gov/data/tools/appeears",
        title: "Application for Extracting and Exploring Analysis Ready Samples",
        page_type: "application",
      },
      {
        url: "https://pds.mcp.nasa.gov/portal/instruments/urn--nasa--pds--context--instrument--eng---co/data",
        title: "Cassini Orbiter Spacecraft Sensors",
        page_type: "application",
      },
      {
        url: "https://nasa.sharepoint.com/sites/GrantsPolicyandCompliance/SiteAssets/SitePages/Regulations-and-Guidance/3617002291GCAM---March-2025.pdf?web=1",
        title: "NASA Grant Cooperative Agreement Manual",
        page_type: "pdf",
      },
      {
        url: "https://github.com/nasa/AppEEARS-Data-Resources/blob/main/guides/How-to-bulk-download-AppEEARS-outputs.md",
        title: "How to bulk download AppEEARS outputs",
        page_type: "pdf",
      },
    ]) {
      expect(shouldRejectDiscoveredSource({ ...example, award_name })).toMatchObject({
        action: "review_later",
        reason: "official_domain_spillover",
      });
    }
  });

  it("rejects generic Oxford spillover while keeping Rhodes Scholarship sources", () => {
    const award_name = "Rhodes Scholarships";

    for (const example of [
      {
        url: "https://www.rhodeshouse.ox.ac.uk/scholarships/the-rhodes-scholarship/",
        title: "The Rhodes Scholarship",
        page_type: "homepage",
      },
      {
        url: "https://www.rhodeshouse.ox.ac.uk/scholarships/applications/united-states/",
        title: "Rhodes Scholarships for the United States",
        page_type: "application",
      },
      {
        url: "http://www.rhodesscholar.org/office-of-the-american-secretary/application-overview/apply/",
        title: "Application Overview",
        page_type: "application",
      },
    ]) {
      expect(shouldRejectDiscoveredSource({ ...example, award_name })).toMatchObject({
        action: "keep",
      });
    }

    for (const example of [
      {
        url: "https://www.ox.ac.uk/admissions/graduate/application-guide/starting-your-application/your-application-account",
        title: "Your application account",
        page_type: "application",
      },
      {
        url: "https://oxweb-platform.admin.ox.ac.uk/admissions/graduate/application-guide/references/changing-a-referee",
        title: "Changing a referee",
        page_type: "application",
      },
      {
        url: "https://www.ox.ac.uk/students/visa/before/cas",
        title: "Your CAS number",
        page_type: "faq",
      },
      {
        url: "https://proctors.web.ox.ac.uk/sites/default/files/proctors/documents/media/procedure_university_student_appeal_mt23_v1.1.pdf",
        title: "University student appeal procedure",
        page_type: "pdf",
      },
      {
        url: "https://www.becomecharity.org.uk/media/1685/factsheet_english_upp_final_v2.pdf",
        title: "Become Higher Education Pamphlet",
        page_type: "pdf",
      },
      {
        url: "https://assets.publishing.service.gov.uk/government/uploads/system/uploads/attachment_data/file/938632/visit-guidance-v10.0ext.pdf",
        title: "Home Office staff visit guidance",
        page_type: "pdf",
      },
      {
        url: "https://uni-of-oxford.custhelp.com/app/answers/detail/a_id/1169/kw/pdf",
        title: "How to convert your document to PDF file format",
        page_type: "pdf",
      },
      {
        url: "https://www.euchems.eu/wp-content/uploads/2018/10/Periodic-Table-ultimate-PDF.pdf",
        title: "Periodic Table",
        page_type: "pdf",
      },
    ]) {
      expect(shouldRejectDiscoveredSource({ ...example, award_name })).toMatchObject({
        action: "review_later",
        reason: "official_domain_spillover",
      });
    }

    expect(
      shouldRejectDiscoveredSource({
        award_name: "Rhodes University (South Africa) - Postdoctoral Fellowship",
        url: "https://www.ru.ac.za/research/postdoctoralfellows/",
        title: "Postdoctoral fellows",
        page_type: "homepage",
      }),
    ).toMatchObject({ action: "keep" });
  });
});
