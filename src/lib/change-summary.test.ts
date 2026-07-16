import { describe, expect, it } from "vitest";
import {
  changeSummaryDisplayParts,
  changeSummaryDedupeKey,
  dedupeChangeSummaries,
  displayChangeSummary,
  isUsefulChangeForAward,
  isUsefulChangeSummary,
} from "@/lib/change-summary";

describe("change summary filtering", () => {
  it("hides vague generated summaries", () => {
    expect(isUsefulChangeSummary("The page added or expanded application language.")).toBe(
      false,
    );
    expect(
      isUsefulChangeSummary("New date or deadline language appeared: May 26, 2026."),
    ).toBe(false);
    expect(isUsefulChangeSummary("New terms found: application, award, deadline.")).toBe(
      false,
    );
    expect(
      isUsefulChangeSummary(
        'Added text includes: "Required Statements Social Media: @udallfoundation | @parksinfocus Morris K.".',
      ),
    ).toBe(false);
  });

  it("hides malformed truncated summaries", () => {
    expect(isUsefulChangeSummary("The NO")).toBe(false);
    expect(isUsefulChangeSummary('The "')).toBe(false);
    expect(isUsefulChangeSummary('On the "Become a')).toBe(false);
    expect(isUsefulChangeSummary("The award section now says applicants may apply through")).toBe(
      false,
    );
  });

  it("keeps specific advisor-facing summaries", () => {
    expect(
      isUsefulChangeSummary(
        "The eligibility section now says applicants must submit two recommendation letters.",
      ),
    ).toBe(true);
  });

  it("hides navigation-only menu reorder updates", () => {
    expect(
      isUsefulChangeForAward({
        awardName: "Freeman-ASIA Award",
        sourceTitle: "Freeman-ASIA Award",
        sourceUrl: "https://www.iie.org/programs/freeman-asia/",
        summary:
          "The navigation menu for the Freeman-ASIA Award has been reordered. The 'Eligibility' and 'FAQs' links have swapped positions.",
        change_details: {
          reader_summary:
            "The navigation menu for the Freeman-ASIA Award has been reordered. The 'Eligibility' and 'FAQs' links have swapped positions.",
          before: "Eligibility For Advisers FAQs Apply Overview",
          after: "FAQs Apply Overview Eligibility For Advisers",
          section: "Navigation Menu",
          change_type: "content_reorder",
          advisor_impact:
            "Advisors should note the change in the order of the navigation links on the Freeman-ASIA Award page.",
          is_alert_worthy: true,
          confidence: "high",
          structured_diff: {
            added_text: ["FAQs"],
            removed_text: ["Eligibility"],
            likely_section: "Eligibility",
            page_type: "homepage",
            date_changes: [],
            amount_changes: [],
            noise_flags: [],
          },
          source: { page_type: "homepage" },
          quality_flags: ["visual_snapshot_comparison"],
          generated_at: "2026-06-30T06:11:39.962Z",
        },
      }),
    ).toBe(false);
  });

  it("hides PDF file hash changes when no content change is described", () => {
    expect(
      isUsefulChangeForAward({
        awardName: "Mitchell Scholarship",
        sourceTitle: "Download and View the Entire Application (PDF)",
        sourceUrl: "https://example.edu/mitchell-application.pdf",
        summary:
          "The application PDF for the US-Ireland Alliance Scholarship has been updated. The specific changes within the PDF are not detailed, but the file itself has changed.",
        change_details: {
          reader_summary:
            "The application PDF for the US-Ireland Alliance Scholarship has been updated. The specific changes within the PDF are not detailed, but the file itself has changed.",
          before: "de 10120 db 6011766 a 56 ef 8 a 0 e 6 cf 65 ed 44 d 58 ee 7 f",
          after: "ab 3598308 a 5833 a 8 d 4139 d 0055 fca 7 bdd 8 f 41 b 3 d",
          section: "Download and View the Entire Application (PDF)",
          change_type: "document",
          advisor_impact:
            "Advisors should check the updated application PDF for any changes to requirements, deadlines, or eligibility criteria.",
          is_alert_worthy: true,
          confidence: "high",
          structured_diff: {
            added_text: ["ab 3598308 a 5833 a 8 d 4139 d 0055 fca 7 bdd 8 f 41 b 3 d"],
            removed_text: ["de 10120 db 6011766 a 56 ef 8 a 0 e 6 cf 65 ed 44 d 58 ee 7 f"],
            likely_section: "Download and View the Entire Application (PDF)",
            page_type: "pdf",
            date_changes: [],
            amount_changes: [],
            noise_flags: [],
          },
          source: { page_type: "pdf" },
          quality_flags: [],
          generated_at: "2026-06-25T00:00:00.000Z",
        },
      }),
    ).toBe(false);
  });

  it("hides document file-size changes when no wording change is identified", () => {
    expect(
      isUsefulChangeForAward({
        awardName: "Rangel International Affairs Fellowship",
        sourceTitle: "Recommendation Form (Word version)",
        sourceUrl: "https://example.edu/rangel-recommendation-form.docx",
        summary:
          "The Rangel International Affairs Fellowship recommendation form has been updated. The file size has decreased significantly, indicating a potential change in content or format.",
        change_details: {
          reader_summary:
            "The Rangel International Affairs Fellowship recommendation form has been updated. The file size has decreased significantly, indicating a potential change in content or format.",
          before: "36864",
          after: "234",
          section: "Recommendation Form (Word version)",
          change_type: "document",
          advisor_impact:
            "Advisors should download and review the updated recommendation form to ensure they are using the most current version.",
          is_alert_worthy: true,
          confidence: "high",
          structured_diff: {
            added_text: ["234"],
            removed_text: ["36864"],
            likely_section: "Recommendation Form (Word version)",
            page_type: "pdf",
            date_changes: [],
            amount_changes: [],
            noise_flags: [],
          },
          source: { page_type: "pdf" },
          quality_flags: [],
          generated_at: "2026-06-26T00:00:00.000Z",
        },
      }),
    ).toBe(false);
  });

  it("keeps PDF changes when concrete applicant-facing wording changed", () => {
    expect(
      isUsefulChangeSummary(
        "The application PDF changed the deadline from January 15, 2026 to January 22, 2026.",
      ),
    ).toBe(true);
  });

  it("hides animated statistic counter drift", () => {
    expect(
      isUsefulChangeSummary(
        "The number of participating universities and colleges has decreased from 2019 to 1635, and the number of scholarships awarded globally has decreased from 20158 to 16299. The total investment amount remains the same.",
      ),
    ).toBe(false);
  });

  it("hides view-count-only changes even when generated as high-confidence updates", () => {
    const changeDetails = {
      reader_summary:
        "The 'Alberta Made Production Grant' publication has been updated, with the view count changing from 7849 to 7869. The description text appears to be identical.",
      before:
        "7849 UPDATED DESCRIPTION The Alberta Made Production Grant (AMPG) is a competitive grant program designed to provide funding to Alberta producers for projects with a minimum eligible Alberta spend of $50,000 and total...",
      after:
        "7869 UPDATED DESCRIPTION The Alberta Made Production Grant (AMPG) is a competitive grant program designed to provide funding to Alberta producers for projects with a minimum eligible Alberta spend of $50,000 and total...",
      section: "Description",
      change_type: "view_count_change",
      advisor_impact:
        "Advisors should note that the view count for the publication has increased. The description text has not changed.",
      is_alert_worthy: true,
      confidence: "high",
      structured_diff: {
        added_text: [
          "7869 UPDATED DESCRIPTION The Alberta Made Production Grant (AMPG) is a competitive grant program designed to provide funding to Alberta producers for projects with a minimum eligible Alberta spend of $50,000 and total...",
        ],
        removed_text: [
          "7849 UPDATED DESCRIPTION The Alberta Made Production Grant (AMPG) is a competitive grant program designed to provide funding to Alberta producers for projects with a minimum eligible Alberta spend of $50,000 and total...",
        ],
        likely_section: "Eligibility",
        page_type: "deadline",
        date_changes: [],
        amount_changes: [],
        noise_flags: [],
      },
      source: { page_type: "deadline" },
      quality_flags: ["visual_snapshot_comparison"],
      generated_at: "2026-07-01T03:53:46.606Z",
    };

    expect(isUsefulChangeSummary(changeDetails.reader_summary, changeDetails)).toBe(false);
    expect(
      isUsefulChangeForAward({
        awardName: "Government of Alberta - Alberta Student Aid - Sir James Lougheed Graduate Scholarships",
        sourceTitle: "Alberta Made Production Grant",
        sourceUrl:
          "https://open.alberta.ca/publications?pubtype=Reference+Material&tags=Alberta+Made+Production+Grant",
        summary: changeDetails.reader_summary,
        change_details: changeDetails,
      }),
    ).toBe(false);
  });

  it("hides donation form churn even when a deadline page title is involved", () => {
    const changeDetails = {
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

    expect(
      isUsefulChangeForAward({
        awardName: "Parkinson's Foundation - Postdoctoral Fellowship",
        sourceTitle: "Postdoctoral Fellowship Deadlines",
        sourceUrl: "https://example.org/postdoctoral-fellowship-deadlines",
        summary: changeDetails.reader_summary,
        change_details: changeDetails,
      }),
    ).toBe(false);
  });

  it("hides transient site chrome and security-question changes", () => {
    expect(
      isUsefulChangeSummary(
        "A system maintenance notification has been added to the CPE Compliance FAQs page, indicating that access to certain PDF documents will be unavailable on July 3, 2026, due to scheduled maintenance.",
      ),
    ).toBe(false);
    expect(
      isUsefulChangeSummary(
        "The website changed the math question required to submit a reference question. It was previously 19 + 19 and is now 18 - 5.",
      ),
    ).toBe(false);
  });

  it("hides event, news, related-award, and past-winner list churn", () => {
    expect(
      isUsefulChangeSummary(
        "The \"Read the latest news\" section has been updated with new articles and events, including a youth webinar and a new award announcement.",
      ),
    ).toBe(false);
    expect(
      isUsefulChangeSummary(
        "The 'Related Opportunities' section has been updated. The ACS Graduate Student Success Grant has been removed, and another grant has been added.",
      ),
    ).toBe(false);
    expect(
      isUsefulChangeSummary(
        "The \"Meet Past Award Winners\" section has been updated to reflect the 2026 honorees instead of the 2025 honorees.",
      ),
    ).toBe(false);
  });

  it("keeps applicant-facing deadline changes even when an event word appears", () => {
    expect(
      isUsefulChangeSummary(
        "The application deadline for the internship webinar scholarship has been extended from June 29, 2026, to July 15, 2026.",
      ),
    ).toBe(true);
  });

  it("hides featured-fellow roster rotations", () => {
    expect(
      isUsefulChangeSummary(
        "The featured fellows section has been updated to reflect new awardees and their fellowship details.",
        {
          reader_summary:
            "The featured fellows section has been updated to reflect new awardees and their fellowship details.",
          before:
            "FEATURED FELLOWS Silvia Huerta Lopez MD, Harvard University, PhD, Harvard University. Fellowship awarded in 2023 to support work towards an MD and a PhD.",
          after:
            "FEATURED FELLOWS Michael Yusov PhD, California Institute of Technology. Fellowship awarded in 2024 to support work towards a PhD.",
          section: "Featured Fellows",
          change_type: "content_update",
          advisor_impact:
            "No application requirements, deadlines, eligibility, or funding text changed.",
          is_alert_worthy: true,
          confidence: "high",
          structured_diff: {
            added_text: [
              "FEATURED FELLOWS Michael Yusov PhD, California Institute of Technology. Fellowship awarded in 2024 to support work towards a PhD.",
            ],
            removed_text: [
              "FEATURED FELLOWS Silvia Huerta Lopez MD, Harvard University, PhD, Harvard University. Fellowship awarded in 2023 to support work towards an MD and a PhD.",
            ],
            likely_section: "Featured Fellows",
            page_type: "other",
            date_changes: [],
            amount_changes: [],
            noise_flags: [],
          },
          source: {},
          quality_flags: ["visual_snapshot_comparison"],
          generated_at: "2026-06-26T09:38:51.000Z",
        },
      ),
    ).toBe(false);
  });

  it("uses structured reader summaries for filtering and display", () => {
    const changeDetails = {
      reader_summary: "The deadline section now says applications close April 15, 2026.",
      before: "Applications close April 1, 2026.",
      after: "Applications close April 15, 2026.",
      section: "Deadline",
      change_type: "deadline",
      advisor_impact: "Update internal calendars.",
      is_alert_worthy: true,
      confidence: "high",
      structured_diff: {
        added_text: ["Applications close April 15, 2026."],
        removed_text: ["Applications close April 1, 2026."],
        likely_section: "Deadline",
        page_type: "deadline",
        date_changes: ["Added April 15, 2026"],
        amount_changes: [],
        noise_flags: [],
      },
      source: {},
      quality_flags: [],
      generated_at: "2026-05-28T20:00:00.000Z",
    };

    expect(isUsefulChangeSummary("The page was updated.", changeDetails)).toBe(true);
    expect(displayChangeSummary("The page was updated.", null, changeDetails)).toBe(
      "The deadline section now says applications close April 15, 2026.",
    );
    expect(changeSummaryDisplayParts("The page was updated.", null, null, changeDetails)).toMatchObject({
      label: "Date",
      text: "The deadline section now says applications close April 15, 2026.",
    });
  });

  it("renders first-observed documents without asserting a publisher-side change date", () => {
    const changeDetails = {
      event_kind: "new_official_document",
      reader_summary: "The publisher posted this new PDF today.",
      before: null,
      after: "Personal statement: 750 words maximum.",
      exact_before: null,
      exact_after: "Personal statement: 750 words maximum.",
      section: "Application requirements",
      change_type: "new_official_document",
      advisor_impact: "Review the first-observed guidance before advising applicants.",
      is_alert_worthy: true,
      confidence: "high",
      structured_diff: {
        added_text: ["Personal statement: 750 words maximum."],
        removed_text: [],
        likely_section: "Application requirements",
        page_type: "pdf",
        date_changes: [],
        amount_changes: [],
        noise_flags: [],
      },
      source: {},
      quality_flags: [],
      generated_at: "2026-07-16T18:00:00.000Z",
    };

    expect(isUsefulChangeSummary("The publisher posted this new PDF today.", changeDetails)).toBe(
      true,
    );
    expect(
      displayChangeSummary(
        "The publisher posted this new PDF today.",
        "https://example.edu/2027-guidance.pdf",
        changeDetails,
      ),
    ).toBe(
      'AwardPing first observed this official document for the award. The document includes: "Personal statement: 750 words maximum."',
    );
    expect(
      changeSummaryDisplayParts(
        "The publisher posted this new PDF today.",
        "https://example.edu/2027-guidance.pdf",
        "2027 application guidance",
        changeDetails,
      ),
    ).toMatchObject({
      label: "New official document",
      text: 'AwardPing first observed this official document for the award. The document includes: "Personal statement: 750 words maximum."',
    });
  });

  it("hides structured changes that fail the quality gate", () => {
    expect(
      isUsefulChangeSummary("The page was updated.", {
        reader_summary: "LEARN MORE | The page was updated.",
        before: null,
        after: null,
        section: null,
        change_type: "noise",
        advisor_impact: null,
        is_alert_worthy: false,
        confidence: "low",
        structured_diff: {
          added_text: [],
          removed_text: [],
          likely_section: null,
          page_type: null,
          date_changes: [],
          amount_changes: [],
          noise_flags: ["raw_scrape_signal"],
        },
        source: {},
        quality_flags: ["raw_scrape_signal"],
        generated_at: "2026-05-28T20:00:00.000Z",
      }),
    ).toBe(false);
  });

  it("formats generated diff summaries into scannable display parts", () => {
    expect(
      changeSummaryDisplayParts(
        'Added text includes: "Finalists must upload an unofficial transcript.".',
      ),
    ).toMatchObject({
      label: "Update",
      text: "The source page added the following wording.\nFinalists must upload an unofficial transcript.",
    });

    expect(
      changeSummaryDisplayParts(
        'Added text includes: "Students who intend to graduate the following December are not eligible."; "Students who have already applied twice for the scholarship are not eligible.".',
      ),
    ).toMatchObject({
      label: "Update",
      text: "The source page added the following wording.\nStudents who intend to graduate the following December are not eligible. Students who have already applied twice for the scholarship are not eligible.",
    });

    expect(
      changeSummaryDisplayParts("Added date context: Applications open on September 10, 2025."),
    ).toMatchObject({
      label: "Date context",
      text: "Applications open on September 10, 2025.",
    });
  });

  it("breaks long added text into readable paragraphs for display", () => {
    const parts = changeSummaryDisplayParts(
      'Added text includes: "Briefly identify and explain any activities or honors that readers are unlikely to understand Answer Question #8 (additional personal information) Write about an interest, activity, research project, or anything else that hasn\'t been expanded upon elsewhere in the application. Alert the Udall Foundation to any unusual circumstances or hardship Examples include situations that may have affected your academic performance or limited your activities.".',
    );

    expect(parts.paragraphs).toEqual([
      "The source page added the following wording.",
      "Briefly identify and explain any activities or honors that readers are unlikely to understand.",
      "Answer Question #8 (additional personal information).",
      "Write about an interest, activity, research project, or anything else that hasn't been expanded upon elsewhere in the application.",
      "Alert the Udall Foundation to any unusual circumstances or hardship.",
      "Examples include situations that may have affected your academic performance or limited your activities.",
    ]);
  });

  it("cleans run-together article metadata and URL-path source labels", () => {
    expect(
      displayChangeSummary(
        "The Article2 Min ReadNASA Glenn Earns R&D 100 Award page removed wording: Explore More 4 min read New Instrument Used Antarctic Ice Sheet to Probe Extreme Universe.",
      ),
    ).toBe(
      "The NASA Glenn Earns R&D 100 Award page removed wording: Explore More New Instrument Used Antarctic Ice Sheet to Probe Extreme Universe.",
    );

    expect(
      displayChangeSummary(
        "The /resources/view/asa-rise-applications-open-for-cohort-6-fellows page added new wording: Guide to Care of Older Adults in Nursing Homes and Other Nursing Home Resources May 27, 2026.",
        "https://example.org/resources/view/asa-rise-applications-open-for-cohort-6-fellows",
      ),
    ).toBe(
      "The Asa Rise Applications Open For Cohort 6 Fellows page added new wording: Guide to Care of Older Adults in Nursing Homes and Other Nursing Home Resources May 27, 2026.",
    );
  });

  it("does not present stored before and after snippets as a direct replacement", () => {
    expect(
      displayChangeSummary(
        'The Research Proposal page changed wording from "Applicants whose Ph. D. was conferred in the last two years." to "Applicants whose Ph. D. was conferred in the last two calendar years.".',
      ),
    ).toBe(
      "The Research Proposal page has updated wording. Current stored wording includes: Applicants whose Ph.D. was conferred in the last two calendar years. Previous stored wording included: Applicants whose Ph.D. was conferred in the last two years.",
    );
  });

  it("does not split application source names into a standalone The paragraph", () => {
    const parts = changeSummaryDisplayParts(
      "The Application Overview page added the following wording: Please check this page in July 2026 for more information. Why Apply for the Rhodes Scholarship?",
      "https://www.rhodeshouse.ox.ac.uk/scholarships/application-overview/",
      "Application Overview",
    );

    expect(parts.paragraphs[0]).toBe(
      "The Application Overview page added the following wording: Please check this page in July 2026 for more information. Why Apply for the Rhodes Scholarship?",
    );
    expect(parts.paragraphs).not.toContain("The.");
  });

  it("hides unrelated broad homepage changes for a specific award", () => {
    expect(
      isUsefulChangeForAward({
        awardName: "Udall Scholarship",
        sourceTitle: "Udall Scholarship",
        sourceUrl: "http://www.udall.gov/",
        summary:
          'Added text includes: "Congressional Internship A ten-week internship in Washington, D.C., for Native American and Alaska Native students.".',
      }),
    ).toBe(false);

    expect(
      isUsefulChangeForAward({
        awardName: "Udall Scholarship",
        sourceTitle: "How to Apply",
        sourceUrl: "https://www.udall.gov/OurPrograms/Scholarship/HowToApply",
        summary:
          'Added text includes: "Applicants must submit the online application and upload an unofficial transcript.".',
      }),
    ).toBe(true);
  });

  it("corrects the known Udall Faculty Reps date summary", () => {
    expect(
      displayChangeSummary(
        'The Udall Scholarship submission deadline has been updated to May 25, 2026, on the "Submitting Applications" section of the Udall Faculty Reps page.',
        "https://www.udall.gov/OurPrograms/Scholarship/FacultyReps",
      ),
    ).toContain("May 26, 2026");
  });

  it("dedupes identical displayed summaries for the same normalized source URL", () => {
    const changes = dedupeChangeSummaries([
      {
        id: "newer",
        shared_award_id: "award-a",
        source_url: "https://www.schwarzmanscholars.org/",
        summary:
          'The "Global Network" section now states that Scholars serve as a bridge between China and the rest of the world.',
      },
      {
        id: "older",
        shared_award_id: "award-a",
        source_url: "https://schwarzmanscholars.org",
        summary:
          '  The "Global Network" section now states that Scholars serve as a bridge between China and the rest of the world. ',
      },
    ]);

    expect(changes).toHaveLength(1);
    expect(changes[0].id).toBe("newer");
  });

  it("dedupes matching source summaries even when duplicate award records exist", () => {
    const summary =
      'The "Admissions" section encourages applicants to join a globally interconnected community.';

    expect(
      changeSummaryDedupeKey({
        shared_award_id: "award-a",
        source_url: "https://www.schwarzmanscholars.org/?utm_source=test",
        summary,
      }),
    ).toBe(
      changeSummaryDedupeKey({
        shared_award_id: "award-b",
        source_url: "https://schwarzmanscholars.org/",
        summary,
      }),
    );
  });

  it("dedupes repeated structured evidence across different source pages for the same award", () => {
    const removedText =
      "Free Sundays at the Two Mississippi Museums May 31, 2026, 11:00 am - 5:00 pm Admission to the Two Mississippi Museums in Jackson is free every Sunday.";
    const changeDetails = (sourceTitle: string) => ({
      reader_summary: `The ${sourceTitle} page removed the following wording: ${removedText}`,
      before: removedText,
      after: null,
      section: sourceTitle,
      change_type: "removed_text",
      advisor_impact: "Review applicant instructions for any needed office-facing updates.",
      is_alert_worthy: true,
      confidence: "medium",
      structured_diff: {
        added_text: [],
        removed_text: [removedText],
        likely_section: sourceTitle,
        page_type: "other",
        date_changes: [],
        amount_changes: [],
        noise_flags: [],
      },
      source: { source_title: sourceTitle },
      quality_flags: [],
      generated_at: "2026-05-29T20:21:51.000Z",
    });

    const changes = dedupeChangeSummaries([
      {
        id: "windsor",
        shared_award_id: "mdah-award",
        source_url: "https://www.mdah.ms.gov/explore-mississippi/windsor-ruins",
        summary:
          "The Windsor Ruins page removed the following wording: " + removedText,
        change_details: changeDetails("Windsor Ruins"),
      },
      {
        id: "old-capitol",
        shared_award_id: "mdah-award",
        source_url: "https://www.mdah.ms.gov/explore-mississippi/old-capitol-museum",
        summary:
          "The Old Capitol Museum page removed the following wording: " + removedText,
        change_details: changeDetails("Old Capitol Museum"),
      },
      {
        id: "same-evidence-different-award",
        shared_award_id: "other-award",
        source_url: "https://www.mdah.ms.gov/explore-mississippi/merci-train",
        summary:
          "The Merci Train page removed the following wording: " + removedText,
        change_details: changeDetails("Merci Train"),
      },
    ]);

    expect(changes.map((change) => change.id)).toEqual([
      "windsor",
      "same-evidence-different-award",
    ]);
  });

  it("dedupes semantic repeats of the same source change when AI phrases them differently", () => {
    const sourceUrl = "https://henryclaycenter.org/college-student-congress/";
    const commonAttendanceText =
      "While it is our preference that all 51 participants are able to commit to the program in Lexington, KY and Washington, D.C., we recognize that jobs, family events and other conflicts can limit students' abilities to attend the full two-week summer program. Attendance at the first half of the program in Lexington is mandatory for acceptance. However, participants may opt out of the second half of the program in Washington, D.C. if necessary.";

    const changes = dedupeChangeSummaries([
      {
        id: "newer",
        shared_award_id: "henry-clay",
        source_url: sourceUrl,
        summary:
          "The program now clarifies that while attendance for the full two weeks is preferred, participants may opt out of the Washington D.C. portion if necessary, though the Lexington portion is mandatory.",
        change_details: {
          reader_summary:
            "The program now clarifies that while attendance for the full two weeks is preferred, participants may opt out of the Washington D.C. portion if necessary, though the Lexington portion is mandatory.",
          before: "Do I have to attend the program for the full amount of time in Lexington and Washington, D.C.?",
          after: commonAttendanceText,
          section: "Frequently Asked Questions",
          change_type: "requirement_change",
          advisor_impact:
            "Students should be aware that while full attendance is preferred, the D.C. portion of the program is now optional, though the Lexington portion remains mandatory.",
          is_alert_worthy: true,
          confidence: "high",
          structured_diff: {
            added_text: [commonAttendanceText],
            removed_text: [
              "Do I have to attend the program for the full amount of time in Lexington and Washington, D.C.?",
            ],
            likely_section: null,
            page_type: "homepage",
            date_changes: [],
            amount_changes: [],
            noise_flags: [],
          },
          source: { source_url: sourceUrl, page_type: "homepage" },
          quality_flags: ["visual_snapshot_comparison"],
          generated_at: "2026-06-30T19:35:03.569Z",
        },
      },
      {
        id: "older",
        shared_award_id: "henry-clay",
        source_url: sourceUrl,
        summary:
          "The program's attendance policy has been updated. While full attendance is preferred, participants may now opt out of the second half of the program in Washington, D.C., if necessary.",
        change_details: {
          reader_summary:
            "The program's attendance policy has been updated. While full attendance is preferred, participants may now opt out of the second half of the program in Washington, D.C., if necessary.",
          before: commonAttendanceText.replace(" if necessary.", "."),
          after: null,
          section: "Frequently Asked Questions",
          change_type: "eligibility_or_requirement_change",
          advisor_impact:
            "Students should be aware that while attendance in Lexington is mandatory, the requirement to attend the full program in Washington, D.C. has been relaxed.",
          is_alert_worthy: true,
          confidence: "high",
          structured_diff: {
            added_text: [],
            removed_text: [commonAttendanceText.replace(" if necessary.", ".")],
            likely_section: null,
            page_type: "homepage",
            date_changes: [],
            amount_changes: [],
            noise_flags: [],
          },
          source: { source_url: sourceUrl, page_type: "homepage" },
          quality_flags: ["visual_snapshot_comparison"],
          generated_at: "2026-06-30T06:09:30.702Z",
        },
      },
    ]);

    expect(changes.map((change) => change.id)).toEqual(["newer"]);
  });

  it("dedupes repeated recommendation-completeness updates", () => {
    const sourceUrl = "https://erefdn.org/scholarship-program/";

    const changes = dedupeChangeSummaries([
      {
        id: "newer",
        shared_award_id: "eref-scholarships",
        source_url: sourceUrl,
        summary:
          "The Environmental Research & Education Foundation (EREF) scholarship application now explicitly states that it is not complete without 3 recommendations, clarifying a previous ambiguity.",
        change_details: {
          reader_summary:
            "The Environmental Research & Education Foundation (EREF) scholarship application now explicitly states that it is not complete without 3 recommendations, clarifying a previous ambiguity.",
          before:
            "Is my application considered complete if my recommenders have not completed the recommendation? The recommendations are critical to the application.",
          after: null,
          section: "SCHOLARSHIP FAQ",
          change_type: "requirement_change",
          advisor_impact:
            "Advisors should inform students that 3 recommendations are now a mandatory requirement for a complete EREF scholarship application.",
          is_alert_worthy: true,
          confidence: "high",
          structured_diff: {
            added_text: ["The application is not complete without the 3 recommendations."],
            removed_text: [
              "Is my application considered complete if my recommenders have not completed the recommendation?",
            ],
            likely_section: "Application",
            page_type: "homepage",
            date_changes: [],
            amount_changes: [],
            noise_flags: [],
          },
          source: { source_url: sourceUrl, page_type: "homepage" },
          quality_flags: ["visual_snapshot_comparison"],
          generated_at: "2026-06-30T19:18:28.465Z",
        },
      },
      {
        id: "older",
        shared_award_id: "eref-scholarships",
        source_url: sourceUrl,
        summary:
          "The Environmental Research & Education Foundation (EREF) has updated its scholarship application FAQ. Specifically, the section addressing recommendation requirements has been clarified to state that the application is not complete without the three required recommendations.",
        change_details: {
          reader_summary:
            "The Environmental Research & Education Foundation (EREF) has updated its scholarship application FAQ. Specifically, the section addressing recommendation requirements has been clarified to state that the application is not complete without the three required recommendations.",
          before:
            "Is my application considered complete if my recommenders have not completed the recommendation? The application is not complete without the 3 recommendations.",
          after: "The application is not complete without the 3 recommendations.",
          section: "Scholarship FAQ",
          change_type: "requirement_change",
          advisor_impact:
            "Students must ensure all three recommendations are submitted for their application to be considered complete.",
          is_alert_worthy: true,
          confidence: "high",
          structured_diff: {
            added_text: [],
            removed_text: [
              "Is my application considered complete if my recommenders have not completed the recommendation?",
            ],
            likely_section: "Application",
            page_type: "homepage",
            date_changes: [],
            amount_changes: [],
            noise_flags: [],
          },
          source: { source_url: sourceUrl, page_type: "homepage" },
          quality_flags: ["visual_snapshot_comparison"],
          generated_at: "2026-06-28T04:34:13.157Z",
        },
      },
    ]);

    expect(changes.map((change) => change.id)).toEqual(["newer"]);
  });

  it("dedupes matching structured evidence even when AI labels the change differently", () => {
    const before =
      "Ansley Abraham, Director of the SREB-State Doctoral Scholars Program, and the Dean and Chair.";
    const after =
      "Tiffany Harrison, Director of the SREB-State Doctoral Scholars Program, and the Dean and Chair.";
    const changeDetails = (changeType: string, sourceTitle: string) => ({
      reader_summary:
        changeType === "application"
          ? `The ${sourceTitle} page added the following wording: ${after}`
          : "The Director of the SREB-State Doctoral Scholars Program has changed from Dr. Ansley Abraham to Dr. Tiffany Harrison.",
      before,
      after,
      section: sourceTitle,
      change_type: changeType,
      advisor_impact: "Review applicant instructions for any needed office-facing updates.",
      is_alert_worthy: true,
      confidence: "medium",
      structured_diff: {
        added_text: [after],
        removed_text: [before],
        likely_section: sourceTitle,
        page_type: "application",
        date_changes: [],
        amount_changes: [],
        noise_flags: [],
      },
      source: { source_title: sourceTitle },
      quality_flags: [],
      generated_at: "2026-05-29T14:22:04.000Z",
    });

    const changes = dedupeChangeSummaries([
      {
        id: "faq",
        shared_award_id: "sreb-dsp",
        source_url: "https://www.sreb.org/frequently-asked-questions",
        summary:
          "The Director of the SREB-State Doctoral Scholars Program has changed from Dr. Ansley Abraham to Dr. Tiffany Harrison.",
        change_details: changeDetails("detected_change", "DSP Fellowship Application FAQs"),
      },
      {
        id: "node",
        shared_award_id: "sreb-dsp",
        source_url: "https://www.sreb.org/node/2516",
        summary: `The Frequently Asked Questions SREB DSP Application Process page added the following wording: ${after}`,
        change_details: changeDetails(
          "application",
          "Frequently Asked Questions SREB DSP Application Process",
        ),
      },
    ]);

    expect(changes.map((change) => change.id)).toEqual(["faq"]);
  });
});
