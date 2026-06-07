import { describe, expect, it } from "vitest";
import { summarizeChange } from "@/lib/diff";

describe("diff summaries", () => {
  it("returns an initial snapshot message", () => {
    expect(summarizeChange(null, "initial text")).toContain("Initial award page");
  });

  it("summarizes new words", () => {
    expect(
      summarizeChange("application deadline march", "application deadline april updated"),
    ).toContain("april");
  });
  it("uses actual added wording instead of generic section labels", () => {
    expect(
      summarizeChange(
        "Applicants must submit the online application by March 1.",
        "Applicants must submit the online application by March 1. Finalists must upload an unofficial transcript and request two recommendation letters.",
      ),
    ).toContain("unofficial transcript");
  });

  it("ignores navigation and social-media text when summarizing changes", () => {
    expect(
      summarizeChange(
        "Applicants must submit the online application by March 1.",
        'Applicants must submit the online application by March 1. Required Statements Social Media: @udallfoundation | @parksinfocus Morris K.',
      ),
    ).toContain("No award-relevant wording");
  });

  it("does not summarize homepage news dates as deadline updates", () => {
    expect(
      summarizeChange(
        "Latest News April 2, 2026 Scholars publish new research.",
        "Latest News April 2, 2026 Scholars publish new research. May 26, 2026 Gates Cambridge announces a new scholar profile.",
      ),
    ).not.toContain("New date or deadline language appeared");
  });

  it("keeps date changes when the date is in application context", () => {
    expect(
      summarizeChange(
        "Applications open on September 1, 2025.",
        "Applications open on September 10, 2025.",
      ),
    ).toContain("Applications open on September 10, 2025");
  });

  it("does not treat expanded snapshot coverage as newly added page text", () => {
    const previous = `${"Existing page text. ".repeat(120)}Application overview`;
    const next = `${previous} Newly visible admissions note requires applicants to confirm passport validity before enrollment.`;
    expect(summarizeChange(previous, next)).toContain("No award-relevant wording");
  });

  it("does not summarize donation or store amounts as funding changes", () => {
    expect(
      summarizeChange(
        "Cart total $0.00. Donate to support the publication.",
        "Cart total $0.00. Donate $2,500 to support the publication. Store gift amount $2,500.00.",
      ),
    ).toContain("No award-relevant wording");
  });

  it("keeps funding amount changes when the money appears in award context", () => {
    expect(
      summarizeChange(
        "The graduate fellowship stipend is $5,000 for the academic year.",
        "The graduate fellowship stipend is $6,000 for the academic year.",
      ),
    ).toContain("$6,000");
  });

  it("does not summarize unchanged recommendation text as removed when spacing improves", () => {
    const previous =
      "2. Overall RecommendationI ___________ this applicant to Knight-Hennessy Scholars.do not recommendrecommend with reservationsrecommendstrongly recommend3. Answers to five recommendation promptsPlease explain how you know and interact with the applicant.We seek visionary thinkers who demonstrate independence of thought.";
    const next =
      "Additional Instructions Remember that your concurrent applications—the Knight-Hennessy Scholars application and the Stanford graduate program application(s)—have distinct evaluation criteria, application requirements, selection processes and timelines, and admission committees. 2. Overall Recommendation I ___________ this applicant to Knight-Hennessy Scholars. do not recommend recommend with reservations recommend strongly recommend 3. Answers to five recommendation prompts Please explain how you know and interact with the applicant. We seek visionary thinkers who demonstrate independence of thought.";

    const summary = summarizeChange(previous, next);

    expect(summary).toContain("Additional Instructions");
    expect(summary).not.toContain("Answers to five recommendation prompts");
  });
});
