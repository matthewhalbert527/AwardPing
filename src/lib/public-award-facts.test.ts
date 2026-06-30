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
                "Three references.",
              ],
              application_materials: [
                "Contact Information",
                "Career Interests",
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
      "Contact Information",
      "Career Interests",
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
});
