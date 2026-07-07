import { describe, expect, it } from "vitest";
import { publicAwardFactsFromAward } from "@/lib/public-award-facts";

describe("public award facts", () => {
  it("uses source baseline facts as a fallback for public details", () => {
    const facts = publicAwardFactsFromAward({
      summary: null,
      publicFacts: {},
      sources: [
        {
          page_metadata: {
            baseline_facts: {
              deadline: "January 29, 2026",
              eligibility: ["Sophomores and juniors"],
              application_materials: ["Essays", "Transcript"],
            },
          },
        },
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
        {
          page_metadata: {
            baseline_facts_rejected: true,
            baseline_facts: {
              deadline: "January 1, 1900",
              eligibility: ["Incorrect applicants"],
            },
          },
        },
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
        {
          page_metadata: {
            baseline_facts: {
              award_relevance: "unrelated",
              deadline: "January 1, 1900",
            },
          },
        },
        {
          page_metadata: {
            baseline_facts: {
              cycle_relevance: "archived_or_past",
              eligibility: ["Past recipients only"],
            },
          },
        },
        {
          page_metadata: {
            baseline_facts: {
              cycle_relevance: "not_program_page",
              application_materials: ["Logo file"],
            },
          },
        },
      ],
    });

    expect(facts.deadline).toBeNull();
    expect(facts.eligibility).toEqual([]);
    expect(facts.applicationMaterials).toEqual([]);
  });

  it("does not infer an undergraduate audience from transcript requirements", () => {
    const facts = publicAwardFactsFromAward({
      summary: null,
      publicFacts: {},
      sources: [
        {
          page_metadata: {
            baseline_facts: {
              eligibility: ["Students entering U.S.-based Ph.D. programs in ecology and evolution"],
              requirements: ["Undergraduate transcript", "Two recommendation letters"],
            },
          },
        },
      ],
    });

    expect(facts.academicLevels).toEqual(["Graduate"]);
    expect(facts.disciplines).toEqual(["Life sciences"]);
  });

  it("moves submitted documents out of requirements and into application materials", () => {
    const facts = publicAwardFactsFromAward({
      summary: null,
      publicFacts: {},
      sources: [
        {
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
        },
      ],
    });

    expect(facts.requirements).toEqual([]);
    expect(facts.applicationMaterials).toEqual([
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
    ]);
  });

  it("only keeps true award conditions in the requirements field", () => {
    const facts = publicAwardFactsFromAward({
      summary: null,
      publicFacts: {},
      sources: [
        {
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
        },
      ],
    });

    expect(facts.requirements).toEqual([
      "Recipients must submit a final report at the end of the award year.",
      "Awardees may not hold another major fellowship concurrently.",
      "Students must maintain full-time enrollment throughout the award period.",
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

  it("requires context for every important date", () => {
    const facts = publicAwardFactsFromAward({
      summary: null,
      publicFacts: {
        deadline: "March 15, 2027",
        opening_date: "September 15, 2026",
        important_dates: [
          "March 15, 2027",
          "February 1, 2027",
          "December 15, 2026",
          "September 15, 2026",
          "Awards announced by: May 1",
          "Headshot photo due: June 1",
        ],
      },
    });

    expect(facts.importantDates).toEqual([
      "Application deadline: March 15, 2027",
      "Applications open: September 15, 2026",
      "Awards announced by: May 1",
      "Headshot photo due: June 1",
    ]);
  });
});
