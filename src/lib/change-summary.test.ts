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
