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
});
