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
});
