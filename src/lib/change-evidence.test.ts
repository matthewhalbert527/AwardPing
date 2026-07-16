import { describe, expect, it } from "vitest";
import { buildChangeEvidence, buildTextFragmentUrl } from "@/lib/change-evidence";

describe("change evidence", () => {
  it("extracts added and removed sentences from snapshot text", () => {
    const evidence = buildChangeEvidence({
      sourceUrl: "https://example.edu/award",
      previousTextSample: "Applications are due March 1. Interviews begin in April.",
      newTextSample:
        "Applications are due March 15. Finalists must upload an unofficial transcript.",
    });

    expect(evidence.addedSnippets.join(" ")).toContain("unofficial transcript");
    expect(evidence.removedSnippets.join(" ")).toContain("March 1");
    expect(evidence.highlightedUrl).toContain("#:~:text=");
  });

  it("does not build text-fragment links for PDFs", () => {
    expect(
      buildTextFragmentUrl("https://example.edu/application.pdf", "Applications are due March 15."),
    ).toBeNull();
  });

  it("uses stored change summaries when snapshot text is unavailable", () => {
    const evidence = buildChangeEvidence({
      sourceUrl: "https://example.edu/award",
      sourceTitle: "Application page",
      summary: "Added date context: Applications open on September 10, 2025.",
    });

    expect(evidence.hasSnapshotEvidence).toBe(false);
    expect(evidence.hasSummaryEvidence).toBe(true);
    expect(evidence.summaryLabel).toBe("Date context");
    expect(evidence.summarySnippet).toBe("Applications open on September 10, 2025.");
    expect(evidence.highlightedUrl).toBe(
      "https://example.edu/award#:~:text=Applications%20open%20on%20September%2010%2C%202025.",
    );
  });

  it("uses structured before and after details when stored", () => {
    const evidence = buildChangeEvidence({
      sourceUrl: "https://example.edu/award",
      summary: "The page was updated.",
      changeDetails: {
        reader_summary: "The deadline moved to April 15, 2026.",
        before: "Applications close April 1, 2026.",
        after: "Applications close April 15, 2026.",
        section: "Deadlines",
        change_type: "deadline",
        advisor_impact: "Update advising calendars.",
        is_alert_worthy: true,
        confidence: "high",
        structured_diff: {
          added_text: [],
          removed_text: [],
          likely_section: "Deadlines",
          page_type: "deadline",
          date_changes: ["Added April 15, 2026"],
          amount_changes: [],
          noise_flags: [],
        },
        source: {},
        quality_flags: [],
        generated_at: "2026-05-28T20:00:00.000Z",
      },
    });

    expect(evidence.hasStructuredEvidence).toBe(true);
    expect(evidence.currentSnippets).toEqual(["Applications close April 15, 2026."]);
    expect(evidence.previousSnippets).toEqual(["Applications close April 1, 2026."]);
    expect(evidence.changeTypeLabel).toBe("Date");
    expect(evidence.sectionLabel).toBe("Deadlines");
    expect(evidence.confidenceLabel).toBe("High confidence");
    expect(evidence.descriptionSourceLabel).toBe("Generated description");
    expect(evidence.summarySnippet).toBe("The deadline moved to April 15, 2026.");
    expect(evidence.beforeSnippet).toBe("Applications close April 1, 2026.");
    expect(evidence.afterSnippet).toBe("Applications close April 15, 2026.");
    expect(evidence.advisorImpact).toBe("Update advising calendars.");
  });

  it("does not present unrelated structured snippets as direct replacements", () => {
    const before =
      "Congratulations to the approximately 315 U.S. undergraduate and graduate students selected for the 2026 Critical Language Scholarship (CLS) Program. February 17, 2026 CLS Alumni Highlight: Sam Bowden Sam Bowden, a 2024 CLS Russian Program participant in Tbilisi, Georgia, leveraged his personal and academic interests in Russian language, literature, and geopolitics to build meaningful international connections and launch a career in foreign policy. His experiences with CLS helped bridge the gap.";
    const after =
      "Portuguese Russian Swahili Applicants Eligibility Language Levels and Prerequisites Selection Criteria Participation Requirements Search for an Advisor Applicant Resources. Jun 03, 2026 AI in Action International Alumni Seminar The U.S. Department of State's CLS Program invites alumni to apply for the AI in Action International Alumni Seminar. May 29, 2026 2026 CLS Alumni Ambassador Forum.";

    const evidence = buildChangeEvidence({
      sourceUrl: "https://clscholarship.org/",
      sourceTitle: "Critical Language Scholarship",
      summary:
        "The Critical Language Scholarship page changed wording from a Sam Bowden alumni profile to an AI in Action alumni seminar announcement.",
      previousTextSample: before,
      newTextSample: after,
      changeDetails: {
        reader_summary:
          "The Critical Language Scholarship page changed wording from a Sam Bowden alumni profile to an AI in Action alumni seminar announcement.",
        before:
          "Sam Bowden, a 2024 CLS Russian Program participant in Tbilisi, Georgia, leveraged his personal and academic interests in Russian language, literature, and geopolitics to build meaningful international connections and launch a career in foreign policy.",
        after:
          "The U.S. Department of State's CLS Program invites alumni to apply for the AI in Action International Alumni Seminar.",
        section: "Alumni",
        change_type: "new_text",
        advisor_impact: "Review applicant instructions for any needed office-facing updates.",
        is_alert_worthy: true,
        confidence: "medium",
        structured_diff: {
          added_text: [
            "The U.S. Department of State's CLS Program invites alumni to apply for the AI in Action International Alumni Seminar.",
          ],
          removed_text: [
            "Sam Bowden, a 2024 CLS Russian Program participant in Tbilisi, Georgia, leveraged his personal and academic interests in Russian language, literature, and geopolitics to build meaningful international connections and launch a career in foreign policy.",
          ],
          likely_section: "Alumni",
          page_type: "other",
          date_changes: [],
          amount_changes: [],
          noise_flags: [],
        },
        source: { source_title: "Critical Language Scholarship", page_type: "other" },
        quality_flags: [],
        generated_at: "2026-06-08T19:34:00.000Z",
      },
    });

    expect(evidence.hasStructuredEvidence).toBe(true);
    expect(evidence.hasSnapshotEvidence).toBe(true);
    expect(evidence.afterSnippet).toBe(
      "The U.S. Department of State's CLS Program invites alumni to apply for the AI in Action International Alumni Seminar.",
    );
    expect(evidence.beforeSnippet).toBeNull();
    expect(evidence.currentSnippets).toEqual([
      "The U.S. Department of State's CLS Program invites alumni to apply for the AI in Action International Alumni Seminar.",
    ]);
    expect(evidence.previousSnippets).toEqual([
      "Sam Bowden, a 2024 CLS Russian Program participant in Tbilisi, Georgia, leveraged his personal and academic interests in Russian language, literature, and geopolitics to build meaningful international connections and launch a career in foreign policy.",
    ]);
    expect(evidence.summaryLabel).toBe("Detected change");
    expect(evidence.summarySnippet).toBe(
      "The Critical Language Scholarship page changed wording from a Sam Bowden alumni profile to an AI in Action alumni seminar announcement.",
    );
    expect(evidence.relationshipNote).toBe(
      "The stored added and removed text appears in different parts of the page, so this update is not shown as a direct replacement.",
    );
    expect(evidence.advisorImpact).toBeNull();
  });

  it("hides structured evidence for globally rejected profile and roster rotations", () => {
    const evidence = buildChangeEvidence({
      sourceUrl: "https://pdsoros.org/guidance-for-recommenders/",
      sourceTitle: "Guidance For Recommenders",
      summary:
        "The Guidance For Recommenders page refreshed profile, testimonial, or roster content; no application requirements, deadlines, eligibility, or funding text changed.",
      previousTextSample:
        "For technical issues, contact support. Featured Fellows Safia Zyla MIP, Stanford University Safia Zyla is an immigrant from Ethiopia. Fellowship awarded in 2025 to support work towards an MIP in International Policy at Stanford University Corinna Zygourakis Assistant Professor, Department of Neurosurgery at Stanford University School of Medicine Corinna Zygourakis is the child of immigrants from Greece.",
      newTextSample:
        "For technical issues, contact support. Featured Fellows Anbinh Phan Director of Global Government Affairs, Walmart Anbinh Phan is an immigrant from Malaysia. Fellowship awarded in 2007 to support work towards a JD in Law at Georgetown University Edward Pham Deputy Director, ViRx@Stanford, Stanford Biosecurity and Pandemic Preparedness Initiative Edward Pham is an immigrant from Viet Nam.",
      changeDetails: {
        reader_summary:
          "The Guidance For Recommenders page refreshed profile, testimonial, or roster content; no application requirements, deadlines, eligibility, or funding text changed.",
        before:
          "Featured Fellows Safia Zyla MIP, Stanford University Safia Zyla is an immigrant from Ethiopia.",
        after:
          "Featured Fellows Anbinh Phan Director of Global Government Affairs, Walmart Anbinh Phan is an immigrant from Malaysia.",
        section: "Guidance For Recommenders",
        change_type: "content_update",
        advisor_impact:
          "No applicant-facing action is likely needed unless this page is used in promotional or reference materials.",
        is_alert_worthy: true,
        confidence: "medium",
        structured_diff: {
          added_text: [
            "Featured Fellows Anbinh Phan Director of Global Government Affairs, Walmart Anbinh Phan is an immigrant from Malaysia.",
          ],
          removed_text: [
            "Featured Fellows Safia Zyla MIP, Stanford University Safia Zyla is an immigrant from Ethiopia.",
            "Fellowship awarded in 2025 to support work towards an MIP in International Policy at Stanford University Corinna Zygourakis Assistant Professor, Department of Neurosurgery at Stanford University School of Medicine Corinna Zygourakis is the child of immigrants from Greece.",
          ],
          likely_section: "Guidance For Recommenders",
          page_type: "application",
          date_changes: [],
          amount_changes: [],
          noise_flags: [],
        },
        source: { source_title: "Guidance For Recommenders", page_type: "application" },
        quality_flags: ["profile_testimonial_change"],
        generated_at: "2026-06-17T10:24:31.456Z",
        generation_provider: "gemini",
        generation_status: "generated",
        generation_model: "gemini-2.5-flash-lite",
      },
    });

    expect(evidence.descriptionSourceLabel).toBeNull();
    expect(evidence.changeTypeLabel).toBeNull();
    expect(evidence.confidenceLabel).toBeNull();
    expect(evidence.currentSnippets).toEqual([]);
    expect(evidence.previousSnippets).toEqual([]);
    expect(evidence.hasStructuredEvidence).toBe(false);
    expect(evidence.hasSnapshotEvidence).toBe(false);
    expect(evidence.summarySnippet).toBe(
      "No award-relevant wording changed in the stored excerpt.",
    );
  });

  it("repairs missing sentence spacing in structured snippets", () => {
    const evidence = buildChangeEvidence({
      sourceUrl: "https://www.rhodeshouse.ox.ac.uk/scholarships/application-overview/",
      summary:
        "The Application Overview page added the following wording: Please check this page in July 2026 for more information. Why Apply for the Rhodes Scholarship?",
      changeDetails: {
        reader_summary:
          "The Application Overview page added the following wording: Please check this page in July 2026 for more information.Why Apply for the Rhodes Scholarship?",
        before: null,
        after:
          "Please check this page in July 2026 for more information.Why Apply for the Rhodes Scholarship?",
        section: "Application",
        change_type: "application",
        advisor_impact: "Review applicant instructions for any needed office-facing updates.",
        is_alert_worthy: true,
        confidence: "high",
        structured_diff: {
          added_text: [],
          removed_text: [],
          likely_section: "Application",
          page_type: "application",
          date_changes: [],
          amount_changes: [],
          noise_flags: [],
        },
        source: {},
        quality_flags: [],
        generated_at: "2026-05-30T16:20:00.000Z",
      },
    });

    expect(evidence.summarySnippet).toContain("information. Why");
    expect(evidence.afterSnippet).toBe(
      "Please check this page in July 2026 for more information. Why Apply for the Rhodes Scholarship?",
    );
    expect(evidence.afterSnippet).not.toContain("information.Why");
  });

  it("does not invent structured before snippets from raw snapshot navigation text", () => {
    const evidence = buildChangeEvidence({
      sourceUrl: "https://www.schwarzmanscholars.org/",
      summary:
        "The Schwarzman Scholarship page added new wording: DOWNLOAD Admissions Apply to join a globally interconnected community of Schwarzman Scholars.",
      previousTextSample:
        "About Overview Celebrating 10 Years Leadership Donors Program Experience Overview Curriculum Student Life Faculty & Guest Speakers Scholars Admissions Overview Application Instructions Information Sessions Alumni News STAY UPDATED.",
      newTextSample:
        "Learn More Global Network Schwarzman Scholars provides an international network of high-caliber global leaders. DOWNLOAD Admissions Apply to join a globally interconnected community of Schwarzman Scholars.",
      changeDetails: {
        reader_summary:
          "The Schwarzman Scholarship page added new wording: DOWNLOAD Admissions Apply to join a globally interconnected community of Schwarzman Scholars.",
        before: null,
        after:
          "DOWNLOAD Admissions Apply to join a globally interconnected community of Schwarzman Scholars.",
        section: "Application",
        change_type: "application",
        advisor_impact: "Review applicant instructions for any needed office-facing updates.",
        is_alert_worthy: true,
        confidence: "high",
        structured_diff: {
          added_text: [],
          removed_text: [],
          likely_section: "Application",
          page_type: "homepage",
          date_changes: [],
          amount_changes: [],
          noise_flags: [],
        },
        source: {},
        quality_flags: [],
        generated_at: "2026-05-30T16:22:00.000Z",
      },
    });

    expect(evidence.hasStructuredEvidence).toBe(true);
    expect(evidence.afterSnippet).toBe(
      "DOWNLOAD Admissions Apply to join a globally interconnected community of Schwarzman Scholars.",
    );
    expect(evidence.beforeSnippet).toBeNull();
    expect(evidence.removedSnippets.join(" ")).toContain("Admissions Overview");
  });

  it("suppresses snapshot highlights when structured details are non-alert-worthy", () => {
    const evidence = buildChangeEvidence({
      sourceUrl: "https://example.edu/award",
      previousTextSample: "Awards: Up to (",
      newTextSample: "Awards: Up to (12) $10,000 fellowships will be awarded.",
      changeDetails: {
        reader_summary: "No award-relevant wording changed in the stored excerpt.",
        before: null,
        after: null,
        section: "Funding",
        change_type: "noise",
        advisor_impact: null,
        is_alert_worthy: false,
        confidence: "low",
        structured_diff: {
          added_text: [],
          removed_text: [],
          likely_section: "Funding",
          page_type: "homepage",
          date_changes: [],
          amount_changes: [],
          noise_flags: ["sample_expansion"],
        },
        source: {},
        quality_flags: ["sample_expansion"],
        generated_at: "2026-05-29T14:45:00.000Z",
      },
    });

    expect(evidence.hasSnapshotEvidence).toBe(false);
    expect(evidence.afterSnippet).toBeNull();
    expect(evidence.beforeSnippet).toBeNull();
    expect(evidence.highlightedUrl).toBeNull();
  });

  it("suppresses snapshot highlights when structured amount evidence is unsupported", () => {
    const evidence = buildChangeEvidence({
      sourceUrl: "https://example.edu/award",
      previousTextSample: "Header navigation. Award history and recipients.",
      newTextSample: "Header navigation. Award history and recipients. Read past recipients.",
      changeDetails: {
        reader_summary: "The page added a new funding amount: $5,000.",
        before: null,
        after: null,
        section: "Funding",
        change_type: "funding",
        advisor_impact: "Check applicant funding materials.",
        is_alert_worthy: true,
        confidence: "high",
        structured_diff: {
          added_text: [],
          removed_text: [],
          likely_section: "Funding",
          page_type: "homepage",
          date_changes: [],
          amount_changes: ["Added $5,000"],
          noise_flags: [],
        },
        source: {},
        quality_flags: [],
        generated_at: "2026-05-29T15:00:00.000Z",
      },
    });

    expect(evidence.hasSnapshotEvidence).toBe(false);
    expect(evidence.summaryLabel).not.toBe("Funding");
    expect(evidence.summarySnippet).toBe("No award-relevant wording changed in the stored excerpt.");
    expect(evidence.afterSnippet).toBeNull();
    expect(evidence.highlightedUrl).toBeNull();
  });

  it("suppresses snapshot highlights for indistinct truncated snippets", () => {
    const repeated =
      "A citizen or national of the United States; An undergraduate student in good standing at an accredited institution of higher education in the United States (including both two-year and four-year institutions); Receiving a Federal Pell Grant during the time of application...";
    const evidence = buildChangeEvidence({
      sourceUrl: "https://example.edu/eligibility",
      previousTextSample: repeated,
      newTextSample: `${repeated} Proof of acceptance is required before disbursement.`,
      changeDetails: {
        reader_summary:
          'The Eligibility page changed wording from "A citizen or national of the United States; An undergraduate student in good standing at an accredited institution of higher education in..." to "A citizen or national of the United States; An undergraduate student in good standing at an accredited institution of higher education in the United States (including...".',
        before: repeated,
        after: repeated,
        section: "Eligibility",
        change_type: "eligibility",
        advisor_impact: "Review eligibility guidance before advising applicants from this award.",
        is_alert_worthy: true,
        confidence: "medium",
        structured_diff: {
          added_text: [],
          removed_text: [],
          likely_section: "Eligibility",
          page_type: "eligibility",
          date_changes: [],
          amount_changes: [],
          noise_flags: [],
        },
        source: {},
        quality_flags: [],
        generated_at: "2026-05-29T12:58:44.717Z",
      },
    });

    expect(evidence.hasSnapshotEvidence).toBe(false);
    expect(evidence.afterSnippet).toBeNull();
    expect(evidence.beforeSnippet).toBeNull();
    expect(evidence.highlightedUrl).toBeNull();
  });

  it("suppresses snapshot highlights for short prefix-only evidence", () => {
    const evidence = buildChangeEvidence({
      sourceUrl: "https://example.edu/application",
      previousTextSample: "WHO ARE WE LOOKING FOR? The Fellowship recruits",
      newTextSample:
        "WHO ARE WE LOOKING FOR? The Fellowship recruits consist of young professionals from India and the US, between the ages of 21 and 35, with remarkably diverse professional and personal backgrounds.",
      changeDetails: {
        reader_summary:
          'The "WHO ARE WE LOOKING FOR?" section has been updated to include more detailed information about the fellowship recruits.',
        before: "WHO ARE WE LOOKING FOR? The Fellowship recruits",
        after:
          "WHO ARE WE LOOKING FOR? The Fellowship recruits consist of young professionals from India and the US, between the ages of 21 and 35, with remarkably diverse professional and personal backgrounds.",
        section: "WHO ARE WE LOOKING FOR?",
        change_type: "application",
        advisor_impact: "Review applicant instructions for any needed office-facing updates.",
        is_alert_worthy: true,
        confidence: "medium",
        structured_diff: {
          added_text: [
            "WHO ARE WE LOOKING FOR? The Fellowship recruits consist of young professionals from India and the US, between the ages of 21 and 35, with remarkably diverse professional and personal backgrounds.",
          ],
          removed_text: ["WHO ARE WE LOOKING FOR? The Fellowship recruits"],
          likely_section: "WHO ARE WE LOOKING FOR?",
          page_type: "application",
          date_changes: [],
          amount_changes: [],
          noise_flags: [],
        },
        source: {},
        quality_flags: [],
        generated_at: "2026-05-28T20:00:00.000Z",
      },
    });

    expect(evidence.hasSnapshotEvidence).toBe(false);
    expect(evidence.afterSnippet).toBeNull();
    expect(evidence.beforeSnippet).toBeNull();
    expect(evidence.highlightedUrl).toBeNull();
  });

  it("suppresses raw HTML image markup from structured evidence", () => {
    const rawMarkup =
      '<picture><source srcSet="https://www.datocms-assets.com/44232/1632764612-pressreleasechicagomonarchsderbylewis-dropboxwebexport.jpg?dpr=0.25&amp;fm=webp 240w" sizes="(max-width: 960px) 100vw, 960px" type="image/webp"/><img src="https://www.datocms-assets.com/44232/1632764612-pressreleasechicagomonarchsderbylewis-dropboxwebexport.jpg" alt="Two monarch butterflies are perched atop a flower in downtown Chicago." loading="lazy"/></picture>Community Science';
    const evidence = buildChangeEvidence({
      sourceUrl: "https://example.edu/community-science",
      previousTextSample: "Community Science",
      newTextSample: `${rawMarkup} Fellowship information`,
      changeDetails: {
        reader_summary: `The source page added new wording: ${rawMarkup}`,
        before: null,
        after: rawMarkup,
        section: "Community Science",
        change_type: "new_text",
        advisor_impact: "Review applicant instructions for any needed office-facing updates.",
        is_alert_worthy: true,
        confidence: "medium",
        structured_diff: {
          added_text: [rawMarkup],
          removed_text: [],
          likely_section: "Community Science",
          page_type: "other",
          date_changes: [],
          amount_changes: [],
          noise_flags: [],
        },
        source: {},
        quality_flags: [],
        generated_at: "2026-05-30T15:00:00.000Z",
      },
    });

    expect(evidence.hasSnapshotEvidence).toBe(false);
    expect(evidence.summarySnippet).toBe("No award-relevant wording changed in the stored excerpt.");
    expect(evidence.afterSnippet).toBeNull();
    expect(evidence.highlightedUrl).toBeNull();
  });

  it("suppresses contained context shifts from structured evidence", () => {
    const evidence = buildChangeEvidence({
      sourceUrl: "https://www.arcsfoundation.org/national/recognition",
      sourceTitle: "Recognition",
      summary:
        "The Recognition page added the following wording: The Hamburg-based foundation seeks to strengthen education, science, and research to make an effective contribution to the self-determined lives of individuals and freedom for all. ROCHE FOUNDATION Roche provided funding.",
      previousTextSample:
        "ROCHE FOUNDATION Roche provided funding of $663,000 that was matched with chapter funding for a total program impact of more than $800,000.",
      newTextSample:
        "The Hamburg-based foundation seeks to strengthen education, science, and research to make an effective contribution to the self-determined lives of individuals and freedom for all. ROCHE FOUNDATION Roche provided funding of $663,000 that was matched with chapter funding for a total program impact of more than $800,000.",
      changeDetails: {
        reader_summary:
          "The Recognition page added the following wording: The Hamburg-based foundation seeks to strengthen education, science, and research to make an effective contribution to the self-determined lives of individuals and freedom for all. ROCHE FOUNDATION Roche provided funding.",
        before:
          "ROCHE FOUNDATION Roche provided funding of $663,000 that was matched with chapter funding for a total program impact of more than $800,000.",
        after:
          "The Hamburg-based foundation seeks to strengthen education, science, and research to make an effective contribution to the self-determined lives of individuals and freedom for all. ROCHE FOUNDATION Roche provided funding of $663,000 that was matched with chapter funding for a total program impact of more than $800,000.",
        section: "Recognition",
        change_type: "funding",
        advisor_impact:
          "Check award descriptions and applicant advising materials for this funding amount.",
        is_alert_worthy: true,
        confidence: "medium",
        structured_diff: {
          added_text: [
            "The Hamburg-based foundation seeks to strengthen education, science, and research to make an effective contribution to the self-determined lives of individuals and freedom for all. ROCHE FOUNDATION Roche provided funding of $663,000 that was matched with chapter funding for a total program impact of more than $800,000.",
          ],
          removed_text: [
            "ROCHE FOUNDATION Roche provided funding of $663,000 that was matched with chapter funding for a total program impact of more than $800,000.",
          ],
          likely_section: "Recognition",
          page_type: "other",
          date_changes: [],
          amount_changes: [],
          noise_flags: [],
        },
        source: { source_title: "Recognition", page_type: "other" },
        quality_flags: [],
        generated_at: "2026-05-31T19:21:00.000Z",
      },
    });

    expect(evidence.hasStructuredEvidence).toBe(false);
    expect(evidence.hasSnapshotEvidence).toBe(false);
    expect(evidence.summarySnippet).toBe("No award-relevant wording changed in the stored excerpt.");
    expect(evidence.afterSnippet).toBeNull();
    expect(evidence.beforeSnippet).toBeNull();
  });

  it("suppresses menu navigation blobs from structured evidence", () => {
    const before =
      "Toggle Menu Application Overview Back Application OverviewLearn about the US districts and more about the Rhodes ScholarshipsApplication OverviewApplication OverviewApplyU.S.";
    const after =
      "Toggle Menu Application Overview Back Application Overview Learn about the US districts and more about the Rhodes Scholarships Application Overview Application Overview Apply U.S.";
    const evidence = buildChangeEvidence({
      sourceUrl:
        "http://www.rhodesscholar.org/office-of-the-american-secretary/application-overview/us-brochure-oxford-and-the-rhodes-scholarship/",
      sourceTitle: "U.S. Brochure: Oxford and the Rhodes Scholarship",
      summary:
        'The U.S. Brochure: Oxford and the Rhodes Scholarship page changed wording from "Toggle Menu Application Overview Back Application OverviewLearn about the US districts and more about the Rhodes ScholarshipsApplication..." to "Toggle Menu Application Overview Back Application Overview Learn about the US districts and more about the Rhodes Scholarships Application Overview Application Overview...".',
      previousTextSample: before,
      newTextSample: after,
      changeDetails: {
        reader_summary:
          'The U.S. Brochure: Oxford and the Rhodes Scholarship page changed wording from "Toggle Menu Application Overview Back Application OverviewLearn about the US districts and more about the Rhodes ScholarshipsApplication..." to "Toggle Menu Application Overview Back Application Overview Learn about the US districts and more about the Rhodes Scholarships Application Overview Application Overview...".',
        before,
        after,
        section: "Application",
        change_type: "application",
        advisor_impact: "Review applicant instructions for any needed office-facing updates.",
        is_alert_worthy: true,
        confidence: "medium",
        structured_diff: {
          added_text: [after],
          removed_text: [before],
          likely_section: "Application",
          page_type: "application",
          date_changes: [],
          amount_changes: [],
          noise_flags: [],
        },
        source: {
          source_title: "U.S. Brochure: Oxford and the Rhodes Scholarship",
          page_type: "application",
        },
        quality_flags: [],
        generated_at: "2026-05-31T13:00:14.851Z",
      },
    });

    expect(evidence.hasStructuredEvidence).toBe(false);
    expect(evidence.hasSnapshotEvidence).toBe(false);
    expect(evidence.summarySnippet).toBe("No award-relevant wording changed in the stored excerpt.");
    expect(evidence.afterSnippet).toBeNull();
    expect(evidence.beforeSnippet).toBeNull();
  });

  it("suppresses sidebar and footer navigation clusters from structured evidence", () => {
    const before =
      "Primary SidebarApplicants Application Overview Eligibility Essays Priorities & Selection Criteria Submission Tips & Requirements Deadlines & Timeline Applicants FAQ FooterU.S.";
    const after =
      "Primary Sidebar Applicants Application Overview Eligibility Essays Priorities & Selection Criteria Submission Tips & Requirements Deadlines & Timeline Applicants FAQ Footer U.S.";
    const evidence = buildChangeEvidence({
      sourceUrl: "https://www.gilmanscholarship.org/applicants/tips/",
      sourceTitle: "Submission Tips & Requirements",
      summary:
        'The Submission Tips & Requirements page changed wording from "Primary SidebarApplicants Application Overview Eligibility Essays Priorities & Selection Criteria Submission Tips & Requirements Deadlines &..." to "Primary Sidebar Applicants Application Overview Eligibility Essays Priorities & Selection Criteria Submission Tips & Requirements Deadlines & Timeline Applicants FAQ...".',
      previousTextSample: before,
      newTextSample: after,
      changeDetails: {
        reader_summary:
          'The Submission Tips & Requirements page changed wording from "Primary SidebarApplicants Application Overview Eligibility Essays Priorities & Selection Criteria Submission Tips & Requirements Deadlines &..." to "Primary Sidebar Applicants Application Overview Eligibility Essays Priorities & Selection Criteria Submission Tips & Requirements Deadlines & Timeline Applicants FAQ...".',
        before,
        after,
        section: "Dates and deadlines",
        change_type: "eligibility",
        advisor_impact: "Review eligibility guidance before advising applicants from this award.",
        is_alert_worthy: true,
        confidence: "medium",
        structured_diff: {
          added_text: [after],
          removed_text: [before],
          likely_section: "Dates and deadlines",
          page_type: "requirements",
          date_changes: [],
          amount_changes: [],
          noise_flags: [],
        },
        source: {
          source_title: "Submission Tips & Requirements",
          page_type: "requirements",
        },
        quality_flags: [],
        generated_at: "2026-06-01T12:42:41.777Z",
      },
    });

    expect(evidence.hasStructuredEvidence).toBe(false);
    expect(evidence.hasSnapshotEvidence).toBe(false);
    expect(evidence.summarySnippet).toBe("No award-relevant wording changed in the stored excerpt.");
    expect(evidence.afterSnippet).toBeNull();
    expect(evidence.beforeSnippet).toBeNull();
  });

  it("suppresses added-only structured snippets that were already in the previous snapshot", () => {
    const previous =
      "Applications for Marshall Scholarships must have three letters of recommendation and must be submitted to and endorsed by an accredited US college or university, the applicant’s undergraduate institution.Candidates are advised of the following information about selecting recommenders: You should state the names of three persons who can supplement the required Letter of Endorsement.";
    const next =
      "Applications for Marshall Scholarships must have three letters of recommendation and must be submitted to and endorsed by an accredited US college or university, the applicant’s undergraduate institution. Candidates are advised of the following information about selecting recommenders: You should state the names of three persons who can supplement the required Letter of Endorsement.";
    const evidence = buildChangeEvidence({
      sourceUrl: "https://www.marshallscholarship.org/apply/information/information-for-recommenders",
      sourceTitle: "Recommenders",
      summary:
        "The Recommenders page added new wording: Candidates are advised of the following information about selecting recommenders",
      previousTextSample: previous,
      newTextSample: next,
      changeDetails: {
        reader_summary:
          "The Recommenders page added new wording: Candidates are advised of the following information about selecting recommenders",
        before: null,
        after: "Candidates are advised of the following information about selecting recommenders",
        section: "Application",
        change_type: "application",
        advisor_impact: "Review applicant instructions for any needed office-facing updates.",
        is_alert_worthy: true,
        confidence: "medium",
        structured_diff: {
          added_text: [
            "Candidates are advised of the following information about selecting recommenders",
          ],
          removed_text: [],
          likely_section: "Application",
          page_type: "application",
          date_changes: [],
          amount_changes: [],
          noise_flags: [],
        },
        source: { source_title: "Recommenders", page_type: "application" },
        quality_flags: [],
        generated_at: "2026-06-01T12:42:25.155Z",
      },
    });

    expect(evidence.hasStructuredEvidence).toBe(false);
    expect(evidence.hasSnapshotEvidence).toBe(false);
    expect(evidence.summarySnippet).toBe("No award-relevant wording changed in the stored excerpt.");
    expect(evidence.afterSnippet).toBeNull();
  });

  it("hides profile-only snapshot text when no applicant-facing fact changed", () => {
    const evidence = buildChangeEvidence({
      sourceUrl: "https://www.americancouncils.org/research-assessment/studies-and-reports",
      sourceTitle: "Studies and Reports",
      summary:
        "The Studies and Reports page added the following wording: Donna Christian, Senior Fellow, Center for Applied Linguistics, Washington, DCMs.",
      previousTextSample:
        "Work Field Offices Africa and the Middle East Western Hemisphere East Asia and the Pacific Europe and Eurasia South and Central Asia Study Abroad Language Programs.",
      newTextSample:
        "Our Team The Alliance is led by Dr. Robert Slater. Donna Christian, Senior Fellow, Center for Applied Linguistics, Washington, DCMs.",
      changeDetails: {
        reader_summary:
          "The Studies and Reports page added the following wording: Donna Christian, Senior Fellow, Center for Applied Linguistics, Washington, DCMs.",
        before: null,
        after: "Donna Christian, Senior Fellow, Center for Applied Linguistics, Washington, DCMs.",
        section: "Studies and Reports",
        change_type: "new_text",
        advisor_impact: "Review applicant instructions for any needed office-facing updates.",
        is_alert_worthy: true,
        confidence: "medium",
        structured_diff: {
          added_text: [
            "Donna Christian, Senior Fellow, Center for Applied Linguistics, Washington, DCMs.",
          ],
          removed_text: [],
          likely_section: "Studies and Reports",
          page_type: "other",
          date_changes: [],
          amount_changes: [],
          noise_flags: [],
        },
        source: { source_title: "Studies and Reports", page_type: "other" },
        quality_flags: [],
        generated_at: "2026-05-30T04:22:55.466Z",
      },
    });

    expect(evidence.hasStructuredEvidence).toBe(false);
    expect(evidence.hasSnapshotEvidence).toBe(false);
    expect(evidence.summarySnippet).toBe(
      "No award-relevant wording changed in the stored excerpt.",
    );
    expect(evidence.afterSnippet).toBeNull();
    expect(evidence.beforeSnippet).toBeNull();
  });

  it("does not highlight unchanged recommendation prompts as removed when spacing improves", () => {
    const previousTextSample =
      "Register recommenders early. 2. Overall RecommendationI ___________ this applicant to Knight-Hennessy Scholars.do not recommendrecommend with reservationsrecommendstrongly recommend3. Answers to five recommendation promptsPlease explain how you know and interact with the applicant.We seek visionary thinkers who demonstrate independence of thought.";
    const newTextSample =
      "Register recommenders early. Additional Instructions Remember that your concurrent applications—the Knight-Hennessy Scholars application and the Stanford graduate program application(s)—have distinct evaluation criteria, application requirements, selection processes and timelines, and admission committees. 2. Overall Recommendation I ___________ this applicant to Knight-Hennessy Scholars. do not recommend recommend with reservations recommend strongly recommend 3. Answers to five recommendation prompts Please explain how you know and interact with the applicant. We seek visionary thinkers who demonstrate independence of thought.";

    const evidence = buildChangeEvidence({
      sourceUrl:
        "https://knight-hennessy.stanford.edu/admission/preparing-your-applications/recommendation-letters",
      sourceTitle: "Recommendation Letters Guidance",
      previousTextSample,
      newTextSample,
    });

    expect(evidence.addedSnippets.join(" ")).toContain("Additional Instructions");
    expect(evidence.removedSnippets.join(" ")).not.toContain(
      "Answers to five recommendation prompts",
    );
    expect(evidence.beforeSnippet).toBeNull();
  });

  it("suppresses evidence for glued URL-to-question spacing repairs", () => {
    const evidence = buildChangeEvidence({
      sourceUrl: "http://www.marshallscholarship.org/applications/faqs",
      sourceTitle: "Application FAQs",
      summary:
        "The Application FAQs page added the following wording: The application is available on the Marshall Scholarship website www.marshallscholarship.org Q.",
      previousTextSample:
        "Q: How do I access the online application form? A: The application is available on the Marshall Scholarship website www.marshallscholarship.orgQ: How do I know that I am successfully registered?",
      newTextSample:
        "Q: How do I access the online application form? A: The application is available on the Marshall Scholarship website www.marshallscholarship.org Q: How do I know that I am successfully registered?",
      changeDetails: {
        reader_summary:
          "The Application FAQs page added the following wording: The application is available on the Marshall Scholarship website www.marshallscholarship.org Q.",
        before:
          "The application is available on the Marshall Scholarship website www.marshallscholarship.orgQ:",
        after:
          "The application is available on the Marshall Scholarship website www.marshallscholarship.org Q:",
        section: "Application",
        change_type: "application",
        advisor_impact: "Review applicant instructions for any needed office-facing updates.",
        is_alert_worthy: true,
        confidence: "medium",
        structured_diff: {
          added_text: [
            "The application is available on the Marshall Scholarship website www.marshallscholarship.org Q:",
          ],
          removed_text: [
            "The application is available on the Marshall Scholarship website www.marshallscholarship.orgQ:",
          ],
          likely_section: "Application",
          page_type: "application",
          date_changes: [],
          amount_changes: [],
          noise_flags: [],
        },
        source: {
          source_title: "Application FAQs",
          page_type: "application",
        },
        quality_flags: ["ai_rejected"],
        generated_at: "2026-06-01T19:33:05.865Z",
      },
    });

    expect(evidence.hasStructuredEvidence).toBe(false);
    expect(evidence.hasSnapshotEvidence).toBe(false);
    expect(evidence.afterSnippet).toBeNull();
    expect(evidence.beforeSnippet).toBeNull();
    expect(evidence.summarySnippet).toBe("No award-relevant wording changed in the stored excerpt.");
  });

  it("suppresses SEO instrumentation date churn from structured and snapshot evidence", () => {
    const before =
      "be_ixf;ym_202605 d_29; ct_50 be_ixf; php_sdk; php_sdk_1.4.26 https://www.cityyear.org/experience/application-process/connect-with-a-recruiter/ https://www.cityyear.org/experience/application-process/connect-with-a-recruiter/ Change a student’s future.";
    const after =
      "be_ixf;ym_202606 d_02; ct_50 be_ixf; php_sdk; php_sdk_1.4.26 https://www.cityyear.org/experience/application-process/connect-with-a-recruiter/ https://www.cityyear.org/experience/application-process/connect-with-a-recruiter/ Change a student’s future.";
    const evidence = buildChangeEvidence({
      sourceUrl: "https://www.cityyear.org/experience/application-process/connect-with-a-recruiter/",
      sourceTitle: "Connect with a recruiter",
      summary:
        "The Connect with a recruiter page added the following wording: be_ixf ym_202606 d_02 ct_50 be_ixf php_sdk php_sdk_1.4.26 https://www.cityyear.org/experience/application-process/connect-with-a-recruiter/.",
      previousTextSample: before,
      newTextSample: after,
      changeDetails: {
        reader_summary:
          "The Connect with a recruiter page added the following wording: be_ixf ym_202606 d_02 ct_50 be_ixf php_sdk php_sdk_1.4.26 https://www.cityyear.org/experience/application-process/connect-with-a-recruiter/.",
        before,
        after,
        section: "Connect with a recruiter",
        change_type: "application",
        advisor_impact: "Review applicant instructions for any needed office-facing updates.",
        is_alert_worthy: true,
        confidence: "medium",
        structured_diff: {
          added_text: [after],
          removed_text: [before],
          likely_section: "Connect with a recruiter",
          page_type: "application",
          date_changes: [],
          amount_changes: [],
          noise_flags: [],
        },
        source: {
          source_title: "Connect with a recruiter",
          page_type: "application",
        },
        quality_flags: [],
        generated_at: "2026-06-02T16:30:18.982Z",
      },
    });

    expect(evidence.hasStructuredEvidence).toBe(false);
    expect(evidence.hasSnapshotEvidence).toBe(false);
    expect(evidence.afterSnippet).toBeNull();
    expect(evidence.beforeSnippet).toBeNull();
    expect(evidence.summarySnippet).toBe("No award-relevant wording changed in the stored excerpt.");
  });

  it("does not invent evidence when snapshots and summaries are empty", () => {
    const evidence = buildChangeEvidence({
      sourceUrl: "https://example.edu/award",
    });

    expect(evidence.hasSnapshotEvidence).toBe(false);
    expect(evidence.hasSummaryEvidence).toBe(false);
    expect(evidence.summarySnippet).toBeNull();
    expect(evidence.highlightedUrl).toBeNull();
  });

  it("treats a new official document as a current-only first observation", () => {
    const currentWording = "Candidates must submit two letters of recommendation.";
    const evidence = buildChangeEvidence({
      sourceUrl: "https://example.edu/2027-guidance.pdf",
      sourceTitle: "2027 application guidance",
      summary: "The publisher posted this PDF today.",
      previousTextSample: "A fabricated previous version must never be shown.",
      newTextSample: currentWording,
      changeDetails: {
        event_kind: "new_official_document",
        reader_summary: "The publisher posted this PDF today.",
        before: "A fabricated previous version must never be shown.",
        after: currentWording,
        exact_before: "A fabricated previous version must never be shown.",
        exact_after: currentWording,
        section: "Application requirements",
        change_type: "new_official_document",
        advisor_impact: "Review the guidance before advising applicants.",
        is_alert_worthy: true,
        confidence: "high",
        structured_diff: {
          added_text: [currentWording],
          removed_text: ["A fabricated previous version must never be shown."],
          likely_section: "Application requirements",
          page_type: "pdf",
          date_changes: [],
          amount_changes: [],
          noise_flags: [],
        },
        source: {},
        quality_flags: [],
        first_observed_at: "2026-06-21T14:00:00.000Z",
        recognized_at: "2026-07-16T18:00:00.000Z",
        generated_at: "2026-07-16T18:00:00.000Z",
      },
    });

    expect(evidence.isFirstObservation).toBe(true);
    expect(evidence.firstObservedAt).toBe("2026-06-21T14:00:00.000Z");
    expect(evidence.recognizedAt).toBe("2026-07-16T18:00:00.000Z");
    expect(evidence.changeTypeLabel).toBe("New official document");
    expect(evidence.summarySnippet).toBe(
      `AwardPing first observed this official document for the award. The document includes: "${currentWording}"`,
    );
    expect(evidence.currentSnippets).toContain(currentWording);
    expect(evidence.beforeSnippet).toBeNull();
    expect(evidence.previousSnippets).toEqual([]);
    expect(evidence.removedSnippets).toEqual([]);
  });

  it("encodes highlighted official-page text", () => {
    expect(
      buildTextFragmentUrl("https://example.edu/award?cycle=2026", "Finalists upload transcripts"),
    ).toBe(
      "https://example.edu/award?cycle=2026#:~:text=Finalists%20upload%20transcripts",
    );
  });
});
