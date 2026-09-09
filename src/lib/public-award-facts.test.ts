import { describe, expect, it } from "vitest";
import { publicAwardFactsFromAward, publicAwardMetaDescription } from "@/lib/public-award-facts";

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

describe("public award deadline descriptions", () => {
  it("keeps the Boren program scope in the metadata label and preserves the reviewed fact", () => {
    const facts = publicAwardFactsFromAward({ publicFacts: {
      overview: "Study language abroad.", deadline: "January 27, 2027 (Boren Scholarships)",
    } });
    expect(publicAwardMetaDescription("Boren Scholarships and Fellowships", facts))
      .toBe("Study language abroad. Scholarships deadline: January 27, 2027.");
    expect(facts.deadline).toBe("January 27, 2027 (Boren Scholarships)");
  });

  it.each([
    ["2026-03-27T17:00:00-05:00", "March 27, 2026 at 5:00 p.m. (UTC-05:00)"],
    ["October 1, 2026 at 11:59PM PT", "October 1, 2026 at 11:59 p.m. (PT)"],
    ["2026-03-27", "March 27, 2026"],
    ["Last Friday in January, 5:00 p.m. Central Time", "Last Friday in January at 5:00 p.m. (Central Time)"],
    ["5:00 p.m. EST on the first Friday in December 2026", "First Friday in December 2026 at 5:00 p.m. (EST)"],
    ["TBA", "TBA"],
    ["2026-02-30", "2026-02-30"],
  ])("formats %s only in the metadata sentence", (deadline, expected) => {
    const reviewed = {
      overview: "Reviewed award details.",
      deadline,
      opening_date: "2026-01-05",
      important_dates: ["Interviews: 2026-04-01T09:00:00Z"],
    };
    const original = structuredClone(reviewed);
    const facts = publicAwardFactsFromAward({ publicFacts: reviewed });
    const originalFacts = structuredClone(facts);

    expect(publicAwardMetaDescription("Example Award", facts))
      .toBe(`Reviewed award details. Deadline: ${expected}.`);
    expect(reviewed).toEqual(original);
    expect(facts).toEqual(originalFacts);
    expect(facts.deadline).toBe(deadline);
    expect(facts.openingDate).toBe(reviewed.opening_date);
    expect(facts.importantDates).toEqual(reviewed.important_dates);
  });

  it("does not invent a deadline when none was reviewed", () => {
    const facts = publicAwardFactsFromAward({ publicFacts: { overview: "Reviewed award details." } });
    expect(publicAwardMetaDescription("Example Award", facts)).toBe("Reviewed award details.");
    expect(facts.deadline).toBeNull();
  });
});

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

describe("public award facts read no source metadata and assert no review", () => {
  // The two source tests above use rejected and archived-cycle metadata, so
  // they would still pass if a relevance filter were doing the work. This
  // source is clean by every signal the helper sets, and still supplies
  // nothing, because source baseline facts are not read at this layer at all.
  const acceptableSource = () => factSource({
    page_metadata: {
      baseline_facts: {
        deadline: "December 31, 2099",
        opening_date: "January 1, 2099",
        eligibility: ["Applicants named in source metadata"],
        academic_levels: ["Graduate"],
        citizenship: ["Any nationality"],
        award_amounts: ["$99,999"],
        important_dates: ["Source metadata date"],
      },
    },
  });

  it("takes no deadline or criteria from an otherwise acceptable source", () => {
    const facts = publicAwardFactsFromAward({ summary: null, publicFacts: {}, sources: [acceptableSource()] });

    expect(facts.deadline).toBeNull();
    expect(facts.openingDate).toBeNull();
    expect(facts.awardAmount).toBeNull();
    expect(facts.eligibility).toEqual([]);
    expect(facts.academicLevels).toEqual([]);
    expect(facts.citizenship).toEqual([]);
    expect(facts.importantDates).toEqual([]);
  });

  it("lets no source value override a stored fact of the same field", () => {
    const facts = publicAwardFactsFromAward({
      summary: null,
      publicFacts: {
        deadline: "November 30, 2026",
        eligibility: ["Stored criterion"],
        academic_levels: ["Undergraduate"],
      },
      sources: [acceptableSource()],
    });

    expect(facts.deadline).toBe("November 30, 2026");
    expect(facts.eligibility).toEqual(["Stored criterion"]);
    expect(facts.academicLevels).toEqual(["Undergraduate"]);
    // The source values appear nowhere, neither replacing nor joining them.
    expect(JSON.stringify(facts)).not.toContain("2099");
    expect(JSON.stringify(facts)).not.toContain("Applicants named in source metadata");
  });

  it("adds no review, approval or provenance field for either input shape", () => {
    // A non-empty structured object changes how items are shaped, never what
    // the result claims. This function formats; the public route is what
    // decides whether an award may be published at all.
    const expected = [
      "academicLevels", "applicationMaterials", "awardAmount", "citizenship", "confidence",
      "contacts", "deadline", "disciplines", "documents", "eligibility", "howToApply",
      "importantDates", "openingDate", "overview", "requirements",
    ];
    for (const [label, publicFacts] of [["empty", {}], ["populated", { deadline: "November 30, 2026" }]] as const) {
      const keys = Object.keys(publicAwardFactsFromAward({ publicFacts })).sort();
      expect(keys, label).toEqual(expected);
      expect(keys.filter((key) => /review|verif|approv|publish|provenance|attest/i.test(key)), label).toEqual([]);
    }
  });
});
