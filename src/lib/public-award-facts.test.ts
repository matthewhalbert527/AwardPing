import { describe, expect, it } from "vitest";
import { publicAwardFactsFromAward } from "@/lib/public-award-facts";

function factSource(source: Record<string, unknown>) {
  const pageMetadata = (source.page_metadata || {}) as Record<string, unknown>;
  const baselineFacts = pageMetadata.baseline_facts as Record<string, unknown> | undefined;
  return {
    url: "https://example.edu/award/apply",
    page_type: "application",
    page_metadata_generated_at: "2026-07-08T00:00:00.000Z",
    page_metadata_model: "gemini-test",
    ...source,
    page_metadata: baselineFacts
      ? {
          ...pageMetadata,
          baseline_facts: {
            award_relevance: "primary",
            cycle_relevance: "evergreen",
            evidence_quotes: ["Example Award Application"],
            quality_flags: [],
            ...baselineFacts,
          },
        }
      : source.page_metadata,
  };
}

describe("public award facts", () => {
  it("uses reconciled public facts for public details", () => {
    const facts = publicAwardFactsFromAward({
      summary: null,
      publicFacts: {
        deadline: "January 29, 2026",
        eligibility: ["Sophomores and juniors"],
        application_materials: ["Essays", "Transcript"],
      },
      sources: [
        factSource({
          page_metadata: {
            baseline_facts: {
              deadline: "January 29, 2026",
              eligibility: ["Sophomores and juniors"],
              application_materials: ["Essays", "Transcript"],
            },
          },
        }),
      ],
    });

    expect(facts.deadline).toBe("January 29, 2026");
    expect(facts.eligibility).toEqual(["Sophomores and juniors"]);
    expect(facts.applicationMaterials).toEqual(["Essays", "Transcript"]);
  });

  it("ignores rejected source baseline facts on public SEO pages", () => {
    const facts = publicAwardFactsFromAward({
      summary: null,
      publicFacts: {},
      sources: [
        factSource({
          page_metadata: {
            baseline_facts_rejected: true,
            baseline_facts: {
              deadline: "January 1, 1900",
              eligibility: ["Incorrect applicants"],
            },
          },
        }),
      ],
    });

    expect(facts.deadline).toBeNull();
    expect(facts.eligibility).toEqual([]);
  });

  it("ignores non-program and archived-cycle source baseline facts", () => {
    const facts = publicAwardFactsFromAward({
      summary: null,
      publicFacts: {},
      sources: [
        factSource({
          page_metadata: {
            baseline_facts: {
              award_relevance: "unrelated",
              deadline: "January 1, 1900",
            },
          },
        }),
        factSource({
          page_metadata: {
            baseline_facts: {
              cycle_relevance: "archived_or_past",
              eligibility: ["Past recipients only"],
            },
          },
        }),
        factSource({
          page_metadata: {
            baseline_facts: {
              cycle_relevance: "not_program_page",
              application_materials: ["Logo file"],
            },
          },
        }),
      ],
    });

    expect(facts.deadline).toBeNull();
    expect(facts.eligibility).toEqual([]);
    expect(facts.applicationMaterials).toEqual([]);
  });

  it("never infers academic level, discipline or citizenship from other fields' wording", () => {
    const facts = publicAwardFactsFromAward({
      summary: null,
      publicFacts: {
        eligibility: ["Students entering U.S.-based Ph.D. programs in ecology and evolution"],
        requirements: ["Undergraduate transcript", "Two recommendation letters"],
      },
      sources: [
        factSource({
          page_metadata: {
            baseline_facts: {
              eligibility: ["Students entering U.S.-based Ph.D. programs in ecology and evolution"],
              requirements: ["Undergraduate transcript", "Two recommendation letters"],
            },
          },
        }),
      ],
    });

    // Reviewed facts carry these fields explicitly when the review found them;
    // keyword inference once turned a Gilman insurance requirement mentioning
    // "health" into "Discipline: Health".
    expect(facts.academicLevels).toEqual([]);
    expect(facts.disciplines).toEqual([]);
    expect(facts.citizenship).toEqual([]);
  });

  it("renders reviewed requirements and application materials verbatim in their reviewed fields", () => {
    const facts = publicAwardFactsFromAward({
      summary: null,
      publicFacts: {
        eligibility: [
          "Must be a full-time student",
          "Research topic must fit with EREF's mission",
        ],
        requirements: [
          "Online application submission.",
          "Three references required.",
          "College transcripts (unofficial accepted).",
          "Personal statement (500 words or less).",
          "Research statement (500 words or less).",
          "Complete three questions in Section C.",
          "Answer all sections of the supporting statement.",
          "Upload the supporting statement as a PDF document.",
          "Contact Information.",
          "Career Interests.",
          "College Information.",
          "Three references.",
        ],
        application_materials: [
          "College transcripts",
        ],
      },
      sources: [
        factSource({
          page_metadata: {
            baseline_facts: {
              eligibility: [
                "Must be a full-time student",
                "Research topic must fit with EREF's mission",
              ],
              requirements: [
                "Online application submission.",
                "Three references required.",
                "College transcripts (unofficial accepted).",
                "Personal statement (500 words or less).",
                "Research statement (500 words or less).",
                "Complete three questions in Section C.",
                "Answer all sections of the supporting statement.",
                "Upload the supporting statement as a PDF document.",
                "Contact Information.",
                "Career Interests.",
                "College Information.",
                "Three references.",
              ],
              application_materials: [
                "College transcripts",
              ],
            },
          },
        }),
      ],
    });

    // The review assigned each item to a field; the page honours that
    // assignment instead of re-sorting (and, for unmatched items, dropping)
    // reviewed facts through regex heuristics.
    expect(facts.requirements).toEqual([
      "Online application submission.",
      "Three references required.",
      "College transcripts (unofficial accepted).",
      "Personal statement (500 words or less).",
      "Research statement (500 words or less).",
      "Complete three questions in Section C.",
      "Answer all sections of the supporting statement.",
      "Upload the supporting statement as a PDF document.",
      "Contact Information.",
      "Career Interests.",
      "College Information.",
      "Three references.",
    ]);
    expect(facts.applicationMaterials).toEqual(["College transcripts"]);
  });

  it("keeps every reviewed requirement, including items the legacy heuristic classed as selection philosophy", () => {
    const facts = publicAwardFactsFromAward({
      summary: null,
      publicFacts: {
        requirements: [
          "Academic performance",
          "Relevance of work to solid waste management science",
          "Potential for success",
          "Recipients must submit a final report at the end of the award year.",
          "Awardees may not hold another major fellowship concurrently.",
          "Students must maintain full-time enrollment throughout the award period.",
        ],
      },
      sources: [
        factSource({
          page_metadata: {
            baseline_facts: {
              requirements: [
                "Academic performance",
                "Relevance of work to solid waste management science",
                "Potential for success",
                "Recipients must submit a final report at the end of the award year.",
                "Awardees may not hold another major fellowship concurrently.",
                "Students must maintain full-time enrollment throughout the award period.",
              ],
            },
          },
        }),
      ],
    });

    expect(facts.requirements).toEqual([
      "Academic performance",
      "Relevance of work to solid waste management science",
      "Potential for success",
      "Recipients must submit a final report at the end of the award year.",
      "Awardees may not hold another major fellowship concurrently.",
      "Students must maintain full-time enrollment throughout the award period.",
    ]);
  });

  it("does not truncate or cap reviewed values", () => {
    const long = `Applicants must ${"demonstrate sustained commitment to public service ".repeat(6)}across their undergraduate years.`;
    const facts = publicAwardFactsFromAward({
      summary: null,
      publicFacts: {
        eligibility: [long],
        application_materials: Array.from({ length: 12 }, (_, index) => `Document ${index + 1}`),
      },
    });

    expect(facts.eligibility).toEqual([long.replace(/\s+/g, " ").trim()]);
    expect(facts.applicationMaterials).toHaveLength(12);
  });

  it("keeps reviewed important dates verbatim, including items without a month or year", () => {
    const facts = publicAwardFactsFromAward({
      summary: null,
      publicFacts: {
        deadline: "October 1, 2026 at 11:59PM PT",
        important_dates: [
          "Advisor certification deadline: March 4, 2027",
          "Interviews: late fall",
          "Applicant notification via email: May 2027",
        ],
      },
    });

    expect(facts.importantDates).toEqual([
      "Advisor certification deadline: March 4, 2027",
      "Interviews: late fall",
      "Applicant notification via email: May 2027",
    ]);
  });

  it("preserves multiple award amounts as separate public fact items", () => {
    const facts = publicAwardFactsFromAward({
      summary: null,
      publicFacts: {
        award_amounts: ["Full tuition; Living stipend"],
      },
    });

    expect(facts.awardAmount).toEqual(["Full tuition", "Living stipend"]);
  });

  it("renders reviewed important dates exactly as reviewed", () => {
    const facts = publicAwardFactsFromAward({
      summary: null,
      publicFacts: {
        deadline: "March 15, 2027",
        opening_date: "September 15, 2026",
        important_dates: [
          "Application deadline: March 15, 2027",
          "Semifinalist notification: February 1, 2027",
          "Applications open: September 15, 2026",
          "Awards announced by: May 1",
          "Headshot photo due: June 1",
        ],
      },
    });

    // The review supplies the context (the editorial policy requires it), so
    // nothing is relabelled, re-ordered, dropped or truncated on the page.
    expect(facts.importantDates).toEqual([
      "Application deadline: March 15, 2027",
      "Semifinalist notification: February 1, 2027",
      "Applications open: September 15, 2026",
      "Awards announced by: May 1",
      "Headshot photo due: June 1",
    ]);
  });
});
