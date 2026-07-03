import { describe, expect, it } from "vitest";
import {
  buildHeuristicChangeDetails,
  buildStructuredChangeDiff,
  changeDetailsToSummary,
  isMeaningfulChangeDetails,
  normalizeAiChangeDetails,
  parseChangeDetails,
} from "@/lib/change-details";

describe("structured change details", () => {
  it("builds before/after diff details for changed deadline wording", () => {
    const details = buildHeuristicChangeDetails({
      previousSample: "Application deadline is March 1, 2026. Applicants submit one transcript.",
      nextText: "Application deadline is March 15, 2026. Applicants submit one transcript.",
      source: { source_title: "Application page", source_url: "https://example.edu/apply" },
      generatedAt: "2026-05-28T20:00:00.000Z",
    });

    expect(details.reader_summary).toContain("March 15, 2026");
    expect(details.before).toContain("March 1, 2026");
    expect(details.after).toContain("March 15, 2026");
    expect(details.change_type).toBe("deadline");
    expect(details.is_alert_worthy).toBe(true);
  });

  it("builds structured diff candidates before any AI call", () => {
    const diff = buildStructuredChangeDiff(
      "The stipend is $5,000. Applications close April 1, 2026.",
      "The stipend is $6,000. Applications close April 15, 2026.",
      { page_type: "deadline" },
    );

    expect(diff.amount_changes).toContain("Added $6,000");
    expect(diff.date_changes).toContain("Added April 15, 2026");
    expect(diff.page_type).toBe("deadline");
  });

  it("rejects AI JSON that contains raw scrape signals", () => {
    const fallback = buildHeuristicChangeDetails({
      previousSample: "Applications close April 1, 2026.",
      nextText: "Applications close April 15, 2026.",
      source: { source_title: "Deadlines" },
    });
    const details = normalizeAiChangeDetails({
      fallback,
      value: {
        reader_summary: "LEARN MORE | Applications close April 15, 2026.",
        before: "Applications close April 1, 2026.",
        after: "Applications close April 15, 2026.",
        section: "Deadlines",
        change_type: "deadline",
        advisor_impact: "Review the deadline.",
        is_alert_worthy: true,
        confidence: "high",
      },
    });

    expect(details.reader_summary).toBe(fallback.reader_summary);
    expect(details.quality_flags).toContain("ai_rejected");
  });

  it("rejects structured amount facts that are unsupported by evidence snippets", () => {
    const fallback = buildHeuristicChangeDetails({
      previousSample: "Applications close April 1, 2026.",
      nextText: "Applications close April 15, 2026.",
      source: { source_title: "Deadlines" },
    });
    const details = normalizeAiChangeDetails({
      fallback,
      value: {
        reader_summary: "The Linda Hall page added a new funding amount: $5,000.",
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
      },
    });

    expect(details.reader_summary).toBe(fallback.reader_summary);
    expect(details.quality_flags).toContain("unsupported_structured_fact");
    expect(details.quality_flags).toContain("ai_rejected");
    expect(isMeaningfulChangeDetails(details)).toBe(false);
  });

  it("treats top jump-link prefixes before FAQ headings as scrape noise", () => {
    const previous =
      "For a full database of postgraduate courses available at the University of Cambridge, please visit this website - Course Directory | Postgraduate Study. Applications Does Gates Cambridge provide funding for the University of Cambridge application fee? Unfortunately, Gates Cambridge does not provide funding to cover the cost of the application fee for the University of Cambridge.";
    const next =
      "For a full database of postgraduate courses available at the University of Cambridge, please visit this website - Course Directory | Postgraduate Study. Top Applications Does Gates Cambridge provide funding for the University of Cambridge application fee? Unfortunately, Gates Cambridge does not provide funding to cover the cost of the application fee for the University of Cambridge.";

    const details = buildHeuristicChangeDetails({
      previousSample: previous,
      nextText: next,
      source: {
        source_title: "Frequently Asked Questions",
        source_url: "https://www.gatescambridge.org/apply/frequently-asked-questions/",
        page_type: "application",
      },
      generatedAt: "2026-06-08T20:40:00.000Z",
    });

    expect(details.quality_flags).toContain("raw_scrape_signal");
    expect(details.is_alert_worthy).toBe(false);
    expect(details.reader_summary).toBe("No award-relevant wording changed in the stored excerpt.");
  });

  it("treats source access recovery as scrape noise instead of added award text", () => {
    const previous =
      "FEHLER 403: Zugriff verboten ERROR 403: Access Denied Der Bereich, in dem die angeforderte Seite liegt, ist fuer das Internet gesperrt. The access to this directory/page is restricted HTTP/1.1 200 OK Server: Apache.";
    const next =
      "Research Proposal Information for Postdoc Applicants The Berlin Program funds recent postdocs, i.e. applicants whose Ph.D. was conferred in the last two calendar years or will be conferred before the fellowship would begin. An application for a postdoc fellowship may involve launching a new research project.";

    const details = buildHeuristicChangeDetails({
      previousSample: previous,
      nextText: next,
      source: {
        source_title: "Research Proposal",
        source_url: "https://www.fu-berlin.de/en/sites/bprogram/application/Research-Proposal/index.html",
        page_type: "application",
      },
      generatedAt: "2026-06-09T15:35:00.000Z",
    });

    expect(details.quality_flags).toContain("source_access_error");
    expect(details.is_alert_worthy).toBe(false);
    expect(details.before).toBeNull();
    expect(details.after).toBeNull();
    expect(details.reader_summary).toBe("No award-relevant wording changed in the stored excerpt.");
  });

  it("rejects homepage press carousel recipient churn as non-alert-worthy", () => {
    const previous =
      "CLS Alumni Highlight: Addison Miller Addison Miller, a 2024 CLS Chinese Program participant in New Taipei City, Taiwan, leveraged her experience to shape her path toward a career in international and comparative education. In 2026... February 17, 2026 CLS in the Press Dairen Castro '28 selected for Critical Language Scholarship to study Arabic in Morocco Dairen Castro '28 has been selected for the 2026 U.S. Department of State Critical Language Scholarship (CLS) program. Castro was one of 315 students selected from a competitive pool of more than 4,500 applicants and will continue the longstanding tradition of Carls participating in the program. Shared from Carleton College, June 01, 2026 Five Students Awarded Scholarships to Study Abroad.";
    const next =
      "CLS Alumni Highlight: Addison Miller Addison Miller, a 2024 CLS Chinese Program participant in New Taipei City, Taiwan, leveraged her experience to shape her path toward a career in international and comparative education. In 2026... February 17, 2026 CLS in the Press Winthrop Senior Receives Federal Help to Travel to Japan Winthrop University senior Levi Becht will spend two months this summer in Japan on a U.S. Department of State scholarship to work on his language skills. Shared from , June 16, 2026 Dairen Castro '28 selected for Critical Language Scholarship to study Arabic in Morocco Dairen Castro '28 has been selected for the 2026 U.S. Department of State Critical Language Scholarship (CLS) program. Shared from Carleton College, June 01, 2026 Five Students Awarded Scholarships to Study Abroad.";

    const details = buildHeuristicChangeDetails({
      previousSample: previous,
      nextText: next,
      source: {
        award_name: "Critical Language Scholarships Program",
        source_title: "Critical Language Scholarships Program",
        source_url: "https://clscholarship.org/",
        page_type: "homepage",
      },
      generatedAt: "2026-06-19T11:51:51.483Z",
    });

    expect(details.quality_flags).toContain("recipient_news_change");
    expect(details.is_alert_worthy).toBe(false);
    expect(details.change_type).toBe("noise");
    expect(details.before).toBeNull();
    expect(details.after).toBeNull();
    expect(details.reader_summary).toBe("No award-relevant wording changed in the stored excerpt.");
  });

  it("treats stored recipient press-carousel details without the new flag as non-meaningful", () => {
    const details = {
      after: "Department of State scholarship to work on his language skills.",
      before:
        "In 2026... February 17, 2026 CLS in the Press Dairen Castro '28 selected for Critical Language Scholarship to study Arabic in Morocco Dairen Castro '28 has been selected for the 2026 U.S.",
      source: {
        page_type: "homepage",
        award_name: "Critical Language Scholarships Program",
        source_url: "https://clscholarship.org/",
        source_title: "Critical Language Scholarships Program",
      },
      section: "Critical Language Scholarships Program",
      confidence: "medium",
      change_type: "new_text",
      generated_at: "2026-06-19T11:51:51.483Z",
      quality_flags: [],
      advisor_impact: "Review applicant instructions for any needed office-facing updates.",
      reader_summary:
        "The Critical Language Scholarships Program page added the following wording: Department of State scholarship to work on his language skills. Shared from , June 16, 2026 Dairen Castro '28 selected for Critical Language Scholarship to study Arabic in Morocco Dairen Castro '28 has been selected for the 2026 U.S.",
      is_alert_worthy: true,
      structured_diff: {
        page_type: "homepage",
        added_text: [
          "Department of State scholarship to work on his language skills.",
          "Shared from , June 16, 2026 Dairen Castro '28 selected for Critical Language Scholarship to study Arabic in Morocco Dairen Castro '28 has been selected for the 2026 U.S.",
        ],
        noise_flags: [],
        date_changes: [],
        removed_text: [
          "In 2026... February 17, 2026 CLS in the Press Dairen Castro '28 selected for Critical Language Scholarship to study Arabic in Morocco Dairen Castro '28 has been selected for the 2026 U.S.",
        ],
        amount_changes: [],
        likely_section: "Critical Language Scholarships Program",
      },
      generation_model: "gemini-2.5-flash",
      generation_status: "fallback",
      generation_provider: "gemini",
    };

    expect(isMeaningfulChangeDetails(details)).toBe(false);
  });

  it("treats longer recrawled excerpts as sample expansion when the old compact text is a prefix", () => {
    const truncatedBlock =
      "Skip to main content The Harry S. Truman Scholarship Foundation Apply Sample Application Materials PREPARATION OF MATERIALS AND NOTIFICATION OF STATUSOnly on-line submissions will be accepted. The Foundation will not accept printed materials. Applicants should:Respond precisely to the application questions. Confine responses to the spaces provided. In Items 2 and 3, list your activities in descending order of significance or importance (e.g., start with the one that you believe has been your most substantial contribution).Use ";
    const previous = truncatedBlock.repeat(4);
    const next =
      previous
        .replaceAll("STATUSOnly", "STATUS Only")
        .replaceAll("should:Respond", "should: Respond")
        .replaceAll(").Use", "). Use") +
      "Items 7-10 and 14 reveal values, interests, and motivation for a career in public service. Provide statistical data to put the issue in context and to support your recommendations. The deadline for submission of this application to the Foundation is 11:59 pm in your time zone on February 2, 2027.";

    const details = buildHeuristicChangeDetails({
      previousSample: previous,
      nextText: next,
      source: {
        source_title: "Truman Scholarship - Deadline",
        page_type: "deadline",
      },
      generatedAt: "2026-06-11T16:10:00.000Z",
    });

    expect(details.quality_flags).toContain("sample_expansion");
    expect(details.is_alert_worthy).toBe(false);
    expect(details.after).toBeNull();
    expect(details.reader_summary).toBe("No award-relevant wording changed in the stored excerpt.");
  });

  it("treats shorter compact-prefix recrawls as sample expansion too", () => {
    const previous =
      "Program overview Student internships provide paid research experience. Eligibility Applicants must be enrolled in an accredited undergraduate or graduate program and be available for the listed appointment period.";
    const continuation =
      " Learn about the Department of Energy Vulnerability Disclosure Program and additional applicant resources, notices, and reporting channels.";

    const details = buildHeuristicChangeDetails({
      previousSample: previous.repeat(3),
      nextText: previous.repeat(3) + continuation,
      source: {
        source_title: "Student Internships",
        page_type: "application",
      },
      generatedAt: "2026-06-11T16:08:00.000Z",
    });

    expect(details.quality_flags).toContain("sample_expansion");
    expect(details.is_alert_worthy).toBe(false);
  });

  it("keeps Ph.D. and i.e. abbreviations inside one changed sentence", () => {
    const previous =
      "Research Proposal Applicants should describe their research methods and explain why Berlin is important to the project.";
    const next =
      "Research Proposal Applicants should describe their research methods and explain why Berlin is important to the project. Information for Postdoc Applicants The Berlin Program funds recent postdocs, i.e. applicants whose Ph.D. was conferred in the last two calendar years or will be conferred before the fellowship would begin.";

    const details = buildHeuristicChangeDetails({
      previousSample: previous,
      nextText: next,
      source: {
        source_title: "Research Proposal",
        page_type: "application",
      },
      generatedAt: "2026-06-09T15:35:00.000Z",
    });

    expect(details.structured_diff.added_text[0]).toContain(
      "i.e. applicants whose Ph.D. was conferred",
    );
    expect(details.after).toContain("whose Ph.D. was conferred");
    expect(details.after).not.toMatch(/whose Ph\.D\.$/);
  });

  it("treats invalid AI JSON details as non-meaningful until regenerated", () => {
    const details = {
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
      quality_flags: ["ai_invalid_json"],
      generated_at: "2026-06-08T20:40:00.000Z",
    };

    expect(isMeaningfulChangeDetails(details)).toBe(false);
  });

  it("treats identical truncated before and after snippets as non-meaningful", () => {
    const details = {
      reader_summary:
        'The Eligibility page changed wording from "A citizen or national of the United States; An undergraduate student in good standing at an accredited institution of higher education in..." to "A citizen or national of the United States; An undergraduate student in good standing at an accredited institution of higher education in the United States (including...".',
      before:
        "A citizen or national of the United States; An undergraduate student in good standing at an accredited institution of higher education in the United States (including both two-year and four-year institutions); Receiving a Federal Pell Grant during the time of application...",
      after:
        "A citizen or national of the United States; An undergraduate student in good standing at an accredited institution of higher education in the United States (including both two-year and four-year institutions); Receiving a Federal Pell Grant during the time of application...",
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
    };

    expect(isMeaningfulChangeDetails(details)).toBe(false);
  });

  it("treats short incomplete prefix evidence as non-meaningful", () => {
    const details = {
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
    };

    expect(isMeaningfulChangeDetails(details)).toBe(false);
  });

  it("treats ordinal-only date wording changes as non-meaningful", () => {
    const details = {
      reader_summary:
        'The Lafayette Fellowship homepage now states "Applications open on September 4th" instead of "Applications open on September 4".',
      before: "Applications open on September 4",
      after: "Applications open on September 4th",
      section: "Homepage",
      change_type: "date",
      advisor_impact:
        "Verify the exact application opening date and update any internal reminders or applicant communications.",
      is_alert_worthy: true,
      confidence: "medium",
      structured_diff: {
        added_text: ["Applications open on September 4th"],
        removed_text: ["Applications open on September 4"],
        likely_section: "Homepage",
        page_type: "homepage",
        date_changes: ["Added September 4th", "Removed September 4"],
        amount_changes: [],
        noise_flags: [],
      },
      source: {},
      quality_flags: [],
      generated_at: "2026-05-28T20:00:00.000Z",
    };

    expect(isMeaningfulChangeDetails(details)).toBe(false);
  });

  it("treats relative news age label churn as non-meaningful", () => {
    const details = {
      reader_summary:
        "The dates for recent chapter news items have been updated. The 'Chapter Annual & Treasurer Report Overview' now shows '7 days ago' instead of '6 days ago', and 'Chapter Health, Reports and Online Communities' now shows '9 days ago' instead of '8 days ago'.",
      before: "Chapter Health, Reports and Online Communities 8 days ago",
      after: "Chapter Health, Reports and Online Communities 9 days ago",
      section: "Recent chapter news",
      change_type: "content_update",
      advisor_impact: "Review applicant instructions for any needed office-facing updates.",
      is_alert_worthy: true,
      confidence: "medium",
      structured_diff: {
        added_text: [
          "Chapter Annual & Treasurer Report Overview 7 days ago",
          "Chapter Health, Reports and Online Communities 9 days ago",
        ],
        removed_text: [
          "Chapter Annual & Treasurer Report Overview 6 days ago",
          "Chapter Health, Reports and Online Communities 8 days ago",
        ],
        likely_section: "Recent chapter news",
        page_type: "homepage",
        date_changes: [],
        amount_changes: [],
        noise_flags: [],
      },
      source: {
        award_name: "Grants-in-Aid of Research Program",
        source_title: "George Bugliarello Prize",
        page_type: "homepage",
      },
      quality_flags: [],
      generated_at: "2026-07-03T12:00:00.000Z",
    };

    expect(isMeaningfulChangeDetails(details)).toBe(false);
  });

  it("rejects heuristic diffs where only relative ago labels increment", () => {
    const details = buildHeuristicChangeDetails({
      previousSample:
        "Recent News Chapter Annual & Treasurer Report Overview 6 days ago. Chapter Health, Reports and Online Communities 8 days ago.",
      nextText:
        "Recent News Chapter Annual & Treasurer Report Overview 7 days ago. Chapter Health, Reports and Online Communities 9 days ago.",
      source: {
        award_name: "Grants-in-Aid of Research Program",
        source_title: "George Bugliarello Prize",
        page_type: "homepage",
      },
      generatedAt: "2026-07-03T12:00:00.000Z",
    });

    expect(details.quality_flags).toContain("relative_age_timestamp_churn");
    expect(details.is_alert_worthy).toBe(false);
    expect(details.reader_summary).toBe("No award-relevant wording changed in the stored excerpt.");
  });

  it("keeps real application date changes when the normalized dates differ", () => {
    const details = {
      reader_summary:
        "The Lafayette Fellowship application page has updated its opening date for the next application cycle to September 4th.",
      before: "Applications open on August 29, 2025, and close at 11:59 PM on November 30, 2025.",
      after: "Applications open on September 4th",
      section: "How to Apply",
      change_type: "date",
      advisor_impact: "Update applicant instructions and reminders.",
      is_alert_worthy: true,
      confidence: "medium",
      structured_diff: {
        added_text: ["Applications open on September 4th"],
        removed_text: [
          "Applications open on August 29, 2025, and close at 11:59 PM on November 30, 2025.",
        ],
        likely_section: "How to Apply",
        page_type: "application",
        date_changes: ["Added September 4th", "Removed August 29, 2025"],
        amount_changes: [],
        noise_flags: [],
      },
      source: {},
      quality_flags: [],
      generated_at: "2026-05-28T20:00:00.000Z",
    };

    expect(isMeaningfulChangeDetails(details)).toBe(true);
  });

  it("keeps curated narrative date replacements when before and after snippets support them", () => {
    const details = {
      reader_summary:
        "The Application Overview page replaced its application timing note: it now says to check back in July 2026 instead of saying to check after applications open for the 2026 Rhodes Scholarship cycle, and the nearby playlist heading changed to “Why Apply for the Rhodes Scholarship?”.",
      before:
        "Note: this content is currently being updated. Please check this page after applications are open for the Rhodes Scholarship 2026 (for entry to Oxford University in 2027) for more information. Rhodes Scholarship Application Playlist",
      after:
        "This content is currently being updated. Please check this page in July 2026 for more information. Why Apply for the Rhodes Scholarship?",
      section: "Application Overview",
      change_type: "application",
      advisor_impact:
        "Review Rhodes applicant guidance for timing language; the page now points students to July 2026 for more application information.",
      is_alert_worthy: true,
      confidence: "high",
      structured_diff: {
        added_text: [
          "This content is currently being updated. Please check this page in July 2026 for more information.",
          "Why Apply for the Rhodes Scholarship?",
        ],
        removed_text: [
          "Note: this content is currently being updated. Please check this page after applications are open for the Rhodes Scholarship 2026 (for entry to Oxford University in 2027) for more information.",
          "Rhodes Scholarship Application Playlist",
        ],
        likely_section: "Application Overview",
        page_type: "application",
        date_changes: ["Replaced 2026 application-cycle timing with July 2026 timing"],
        amount_changes: [],
        noise_flags: [],
      },
      source: { source_title: "Application Overview", page_type: "application" },
      quality_flags: [],
      generated_at: "2026-05-30T05:52:32.152Z",
    };

    expect(isMeaningfulChangeDetails(details)).toBe(true);
  });

  it("treats contained recognition-page context shifts as non-meaningful", () => {
    const details = {
      reader_summary:
        "The Recognition page added the following wording: The Hamburg-based foundation seeks to strengthen education, science, and research to make an effective contribution to the self-determined lives of individuals and freedom for all. ROCHE FOUNDATION Roche provided funding.",
      before:
        "ROCHE FOUNDATION Roche provided funding of $663,000 that was matched with chapter funding for a total program impact of more than $800,000.",
      after:
        "The Hamburg-based foundation seeks to strengthen education, science, and research to make an effective contribution to the self-determined lives of individuals and freedom for all. ROCHE FOUNDATION Roche provided funding of $663,000 that was matched with chapter funding for a total program impact of more than $800,000.",
      section: "Recognition",
      change_type: "funding",
      advisor_impact: "Check award descriptions and applicant advising materials for this funding amount.",
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
    };

    expect(isMeaningfulChangeDetails(details)).toBe(false);
  });

  it("marks prefix-only sample expansion as non-alert-worthy noise", () => {
    const previous = `${"Navigation and page overview. ".repeat(70)}Purpose: graduate fellowship support. Awards: Up to (`;
    const next = `${previous}12) $10,000 fellowships will be awarded for the 2026-2027 academic year. Funding will be released subject to NASA authorization.`;
    const details = buildHeuristicChangeDetails({
      previousSample: previous,
      nextText: next,
      source: { source_title: "Graduate Fellowship Information", page_type: "homepage" },
    });

    expect(details.is_alert_worthy).toBe(false);
    expect(details.change_type).toBe("noise");
    expect(details.quality_flags).toContain("sample_expansion");
    expect(details.reader_summary).toContain("No award-relevant wording");
    expect(details.before).toBeNull();
    expect(details.after).toBeNull();
  });

  it("does not classify storefront or donation amounts as award funding", () => {
    const details = buildHeuristicChangeDetails({
      previousSample: "Cart total $0.00. Learn More At Kenyon Review Young Writers Workshops.",
      nextText:
        "Cart total $0.00. Donate $2,500 to support the publication. Store gift amount $2,500.00. Read Past Recipients Toggle page navigation.",
      source: {
        source_title: "Past Recipients of the Kenyon Review Award for Literary Achievement",
        page_type: "other",
      },
    });

    expect(details.structured_diff.amount_changes).toEqual([]);
    expect(details.is_alert_worthy).toBe(false);
    expect(details.change_type).toBe("noise");
    expect(details.quality_flags).toContain("no_actual_changed_fact");
  });

  it("treats donation form changes on award pages as non-meaningful", () => {
    const details = {
      reader_summary:
        "The Parkinson's Foundation has updated its donation form, removing specific one-time donation amounts and a tribute option. The award deadlines themselves remain unchanged.",
      before:
        "One-time donation amount $50 $100 $250 $500. Make this gift in tribute.",
      after: "Donation amount. Donate now.",
      section: "Postdoctoral Fellowship Deadlines",
      change_type: "deadline",
      advisor_impact:
        "No deadline, eligibility, requirement, or application instruction changed.",
      is_alert_worthy: true,
      confidence: "high",
      structured_diff: {
        added_text: ["Donation amount. Donate now."],
        removed_text: [
          "One-time donation amount $50 $100 $250 $500. Make this gift in tribute.",
        ],
        likely_section: "Postdoctoral Fellowship Deadlines",
        page_type: "deadline",
        date_changes: [],
        amount_changes: [],
        noise_flags: [],
      },
      source: {},
      quality_flags: ["visual_snapshot_comparison"],
      generated_at: "2026-06-26T00:00:00.000Z",
    };

    expect(isMeaningfulChangeDetails(details)).toBe(false);
  });

  it("treats storefront product boilerplate as non-meaningful", () => {
    const details = {
      reader_summary:
        "The National German Exam (Levels 2-4) page added the following wording: Price: $95 View Item Featured Products Friends of AATG Endowment AATG Endowed Scholarship Fund AATG General Fund Contact 112 Haddontowne Court#104Cherry Hill, New Jersey 08034United States 856.795.5553 Shop for Materials.",
      before:
        "Price: $95 View Item Featured Products Friends of AATG Endowment AATG General Fund AATG Endowed Scholarship Fund Contact 112 Haddontowne Court#104Cherry Hill, New Jersey 08034United States 856.795.5553 Shop for Materials in the AATG Store!",
      after:
        "Price: $95 View Item Featured Products Friends of AATG Endowment AATG Endowed Scholarship Fund AATG General Fund Contact 112 Haddontowne Court#104Cherry Hill, New Jersey 08034United States 856.795.5553 Shop for Materials in the AATG Store!",
      section: "National German Exam",
      change_type: "application",
      advisor_impact: "Review applicant instructions for any needed office-facing updates.",
      is_alert_worthy: true,
      confidence: "medium",
      structured_diff: {
        added_text: [
          "Price: $95 View Item Featured Products Friends of AATG Endowment AATG Endowed Scholarship Fund AATG General Fund Contact 112 Haddontowne Court#104Cherry Hill, New Jersey 08034United States 856.795.5553 Shop for Materials in the AATG Store!",
        ],
        removed_text: [
          "Price: $95 View Item Featured Products Friends of AATG Endowment AATG General Fund AATG Endowed Scholarship Fund Contact 112 Haddontowne Court#104Cherry Hill, New Jersey 08034United States 856.795.5553 Shop for Materials in the AATG Store!",
        ],
        likely_section: "National German Exam",
        page_type: "other",
        date_changes: [],
        amount_changes: [],
        noise_flags: [],
      },
      source: {},
      quality_flags: [],
      generated_at: "2026-05-29T20:00:00.000Z",
    };

    expect(isMeaningfulChangeDetails(details)).toBe(false);
  });

  it("treats leaked HTML image markup as non-meaningful scrape noise", () => {
    const rawMarkup =
      '<picture><source srcSet="https://www.datocms-assets.com/44232/1632764612-pressreleasechicagomonarchsderbylewis-dropboxwebexport.jpg?dpr=0.25&amp;fm=webp 240w,https://www.datocms-assets.com/44232/1632764612-pressreleasechicagomonarchsderbylewis-dropboxwebexport.jpg?dpr=0.5&amp;fm=webp 480w" sizes="(max-width: 960px) 100vw, 960px" type="image/webp"/><img src="https://www.datocms-assets.com/44232/1632764612-pressreleasechicagomonarchsderbylewis-dropboxwebexport.jpg" alt="Two monarch butterflies are perched atop a flower in downtown Chicago." loading="lazy" referrerPolicy="no-referrer-when-downgrade"/></picture>Community Science';
    const details = {
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
    };

    expect(isMeaningfulChangeDetails(details)).toBe(false);
  });

  it("treats menu navigation blobs as non-meaningful scrape noise", () => {
    const before =
      "Toggle Menu Application Overview Back Application OverviewLearn about the US districts and more about the Rhodes ScholarshipsApplication OverviewApplication OverviewApplyU.S.";
    const after =
      "Toggle Menu Application Overview Back Application Overview Learn about the US districts and more about the Rhodes Scholarships Application Overview Application Overview Apply U.S.";
    const details = {
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
    };

    expect(isMeaningfulChangeDetails(details)).toBe(false);
  });

  it("treats sidebar and footer navigation clusters as non-meaningful scrape noise", () => {
    const before =
      "Primary SidebarApplicants Application Overview Eligibility Essays Priorities & Selection Criteria Submission Tips & Requirements Deadlines & Timeline Applicants FAQ FooterU.S.";
    const after =
      "Primary Sidebar Applicants Application Overview Eligibility Essays Priorities & Selection Criteria Submission Tips & Requirements Deadlines & Timeline Applicants FAQ Footer U.S.";
    const details = {
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
    };

    expect(isMeaningfulChangeDetails(details)).toBe(false);
  });

  it("does not treat sentence-boundary spacing fixes as added award wording", () => {
    const previous =
      "Applications for Marshall Scholarships must have three letters of recommendation and must be submitted to and endorsed by an accredited US college or university, the applicant’s undergraduate institution.Candidates are advised of the following information about selecting recommenders: You should state the names of three persons who can supplement the required Letter of Endorsement.";
    const next =
      "Applications for Marshall Scholarships must have three letters of recommendation and must be submitted to and endorsed by an accredited US college or university, the applicant’s undergraduate institution. Candidates are advised of the following information about selecting recommenders: You should state the names of three persons who can supplement the required Letter of Endorsement.";

    const details = buildHeuristicChangeDetails({
      previousSample: previous,
      nextText: next,
      source: {
        source_title: "Recommenders",
        page_type: "application",
      },
    });

    expect(details.reader_summary).toBe("No award-relevant wording changed in the stored excerpt.");
    expect(details.after).toBeNull();
    expect(details.before).toBeNull();
    expect(details.is_alert_worthy).toBe(false);
    expect(details.quality_flags).toContain("no_actual_changed_fact");
  });

  it("treats glued URL-to-question spacing repairs as non-meaningful", () => {
    const details = {
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
    };

    expect(isMeaningfulChangeDetails(details)).toBe(false);
  });

  it("treats SEO instrumentation date churn as non-meaningful scrape noise", () => {
    const before =
      "be_ixf;ym_202605 d_29; ct_50 be_ixf; php_sdk; php_sdk_1.4.26 https://www.cityyear.org/experience/application-process/connect-with-a-recruiter/ https://www.cityyear.org/experience/application-process/connect-with-a-recruiter/ Change a student’s future.";
    const after =
      "be_ixf;ym_202606 d_02; ct_50 be_ixf; php_sdk; php_sdk_1.4.26 https://www.cityyear.org/experience/application-process/connect-with-a-recruiter/ https://www.cityyear.org/experience/application-process/connect-with-a-recruiter/ Change a student’s future.";
    const details = {
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
    };

    expect(isMeaningfulChangeDetails(details)).toBe(false);
  });

  it("summarizes testimonial/profile rotations without pasting quote blobs", () => {
    const details = buildHeuristicChangeDetails({
      source: {
        source_title: "Summer Institute",
        page_type: "homepage",
      },
      previousSample:
        'The Summer Institute at Georgetown was an opportunity that can’t be matched: studying the Constitution with renowned scholars, meeting a Supreme Court Justice and members of Congress, and experiencing the rich history of the capital were unforgettable. "I’ve made some new friends and learned a lot from colleagues from around the country, it is beyond useful to be able to hear various views from so many different educators." Sara Ziemnik Ohio Fellow Sara earned an MA in History at Cleveland State University. She teaches at Rocky River High School in Rocky River, OH.',
      nextText:
        'The Summer Institute at Georgetown was an opportunity that can’t be matched: studying the Constitution with renowned scholars, meeting a Supreme Court Justice and members of Congress, and experiencing the rich history of the capital were unforgettable. The James Madison Foundation will elevate your scholarship and career to a level that will invigorate your teaching and learning for years to come." Lynda Boyle Utah Fellow Linda is earning her Master’s in History and Government at Ashland University. "I am proud to be a teacher and honored to be teaching the good and the bad found within our nation’s history." Jon Resendez California Fellow Jon earned an MA in Political Science at California State University-Fullerton.',
      generatedAt: "2026-05-30T17:30:00.000Z",
    });

    expect(details.is_alert_worthy).toBe(true);
    expect(details.change_type).toBe("content_update");
    expect(details.quality_flags).toContain("profile_testimonial_change");
    expect(details.reader_summary).toBe(
      "The Summer Institute page refreshed profile, testimonial, or roster content; no application requirements, deadlines, eligibility, or funding text changed.",
    );
    expect(details.reader_summary).not.toContain("Lynda Boyle");
    expect(details.reader_summary).not.toContain("Jon Resendez");
  });

  it("refines stored testimonial/profile change details at render time", () => {
    const details = parseChangeDetails({
      reader_summary:
        'The Summer Institute page added the following wording: The James Madison Foundation will elevate your scholarship and career to a level that will invigorate your teaching and learning for years to come.” Lynda Boyle Utah Fellow Linda is earning her Master’s in History and. I am proud to be a teacher and honored to be teaching the good and the bad found within our nation’s history.” Jon Resendez California Fellow Jon earned an MA in Political Science at California State.',
      before:
        'I’ve made some new friends and learned a lot from colleagues from around the country, it is beyond useful to be able to hear various views from so many different educators.” Sara Ziemnik Ohio Fellow Sara earned an MA in History at Cleveland State University.',
      after:
        'The James Madison Foundation will elevate your scholarship and career to a level that will invigorate your teaching and learning for years to come.” Lynda Boyle Utah Fellow Linda is earning her Master’s in History and Government at Ashland University.',
      section: "Summer Institute",
      change_type: "application",
      advisor_impact: "Review applicant instructions for any needed office-facing updates.",
      is_alert_worthy: true,
      confidence: "medium",
      structured_diff: {
        added_text: [
          'The James Madison Foundation will elevate your scholarship and career to a level that will invigorate your teaching and learning for years to come.” Lynda Boyle Utah Fellow Linda is earning her Master’s in History and Government at Ashland University.',
        ],
        removed_text: [
          'I’ve made some new friends and learned a lot from colleagues from around the country, it is beyond useful to be able to hear various views from so many different educators.” Sara Ziemnik Ohio Fellow Sara earned an MA in History at Cleveland State University.',
        ],
        likely_section: "Summer Institute",
        page_type: "homepage",
        date_changes: [],
        amount_changes: [],
        noise_flags: [],
      },
      source: { source_title: "Summer Institute", page_type: "homepage" },
      quality_flags: [],
      generated_at: "2026-05-30T17:30:00.000Z",
    });

    expect(details?.change_type).toBe("content_update");
    expect(details?.reader_summary).toBe(
      "The Summer Institute page refreshed profile, testimonial, or roster content; no application requirements, deadlines, eligibility, or funding text changed.",
    );
  });

  it("classifies staff roster additions as low-impact content updates", () => {
    const details = parseChangeDetails({
      reader_summary:
        "The Studies and Reports page added the following wording: Donna Christian, Senior Fellow, Center for Applied Linguistics, Washington, DCMs. Donna Christian, Senior Fellow, Center for Applied Linguistics (CAL)Dr.",
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
          "Donna Christian, Senior Fellow, Center for Applied Linguistics (CAL)Dr.",
        ],
        removed_text: [],
        likely_section: "Studies and Reports",
        page_type: "other",
        date_changes: [],
        amount_changes: [],
        noise_flags: [],
      },
      source: {
        source_title: "Studies and Reports",
        page_type: "other",
      },
      quality_flags: ["ai_invalid_json"],
      generated_at: "2026-05-30T04:22:55.466Z",
    });

    expect(details?.change_type).toBe("content_update");
    expect(details?.reader_summary).toBe(
      "The Studies and Reports page refreshed profile, testimonial, or roster content; no application requirements, deadlines, eligibility, or funding text changed.",
    );
  });

  it("does not mark unchanged recommendation prompts as removed when scrape spacing improves", () => {
    const previous =
      "Register recommenders early. 2. Overall RecommendationI ___________ this applicant to Knight-Hennessy Scholars.do not recommendrecommend with reservationsrecommendstrongly recommend3. Answers to five recommendation promptsPlease explain how you know and interact with the applicant.We seek visionary thinkers who demonstrate independence of thought.";
    const next =
      "Register recommenders early. Additional Instructions Remember that your concurrent applications—the Knight-Hennessy Scholars application and the Stanford graduate program application(s)—have distinct evaluation criteria, application requirements, selection processes and timelines, and admission committees. 2. Overall Recommendation I ___________ this applicant to Knight-Hennessy Scholars. do not recommend recommend with reservations recommend strongly recommend 3. Answers to five recommendation prompts Please explain how you know and interact with the applicant. We seek visionary thinkers who demonstrate independence of thought.";

    const details = buildHeuristicChangeDetails({
      previousSample: previous,
      nextText: next,
      source: {
        source_title: "Recommendation Letters Guidance",
        page_type: "application",
      },
      generatedAt: "2026-06-01T19:01:46.458Z",
    });

    expect(details.before).toBeNull();
    expect(details.after).toContain("Additional Instructions");
    expect(details.reader_summary).toContain("added new wording");
    expect(details.reader_summary).not.toContain("Answers to five recommendation prompts");
    expect(details.structured_diff.removed_text).toEqual([]);
  });

  it("uses structured reader summaries when available", () => {
    const details = {
      reader_summary: "The deadline moved to April 15, 2026.",
      before: "April 1, 2026",
      after: "April 15, 2026",
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
    };

    expect(changeDetailsToSummary(details, "The page was updated.")).toBe(
      "The deadline moved to April 15, 2026.",
    );
    expect(isMeaningfulChangeDetails(details)).toBe(true);
  });
});
