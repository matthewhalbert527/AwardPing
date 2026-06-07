import { describe, expect, it } from "vitest";
import { sortAwardsForSearch } from "@/lib/award-search";

const awards = [
  {
    id: "national-science-grfp",
    name: "National Science Foundation Graduate Research Fellowship Program",
    summary: "Supports graduate students in NSF-supported STEM disciplines.",
  },
  {
    id: "nsf-grfp",
    name: "NSF Graduate Research Fellowship Program",
    summary: "Official GRFP application and eligibility information.",
  },
  {
    id: "math-reu",
    name: "Math Research Experience for Undergraduates",
    summary: "A summer math research opportunity.",
  },
  {
    id: "reu",
    name: "National Science Foundation Research Experience for Undergraduates",
    summary: "NSF-funded summer undergraduate research programs.",
  },
  {
    id: "goldwater",
    name: "Goldwater Scholarship",
    summary: "Undergraduate STEM research scholarship.",
  },
];

describe("award search", () => {
  it("matches NSF GRFP shorthand to the graduate research fellowship", () => {
    expect(sortAwardsForSearch("NSF GRFP", awards)[0].id).toBe("nsf-grfp");
  });

  it("matches NSF REU shorthand to the National Science Foundation REU award", () => {
    expect(sortAwardsForSearch("NSF REU", awards)[0].id).toBe("reu");
  });

  it("keeps normal award name search working", () => {
    expect(sortAwardsForSearch("goldwater", awards).map((award) => award.id)).toEqual([
      "goldwater",
    ]);
  });
});
