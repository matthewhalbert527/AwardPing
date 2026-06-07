import { describe, expect, it } from "vitest";
import {
  bestExistingOrganizationMatch,
  dedupeOrganizationsForQuery,
  sortOrganizationsForQuery,
} from "@/lib/organization-matching";

const organizations = [
  { id: "community", name: "Cossatot Community College of the University of Arkansas" },
  { id: "fayetteville", name: "University of Arkansas - Fayetteville" },
  { id: "fort-smith", name: "University of Arkansas - Fort Smith" },
];

describe("organization matching", () => {
  it("prioritizes organizations that begin with the typed query", () => {
    expect(sortOrganizationsForQuery("University of Arkansas", organizations)[0].id).toBe(
      "fayetteville",
    );
  });

  it("matches punctuation variants for campus names", () => {
    expect(bestExistingOrganizationMatch("university of arkansas fayetteville", organizations)?.id).toBe(
      "fayetteville",
    );
  });

  it("deduplicates punctuation variants and keeps the better-described record", () => {
    const results = dedupeOrganizationsForQuery("University of Arkansas", [
      { id: "hyphen", name: "University of Arkansas - Fayetteville", country: "United States" },
      {
        id: "comma",
        name: "University of Arkansas, Fayetteville",
        country: "United States",
        state_province: "Arkansas",
      },
      ...organizations,
    ]);

    expect(results.filter((organization) => organization.name.includes("Fayetteville"))).toEqual([
      expect.objectContaining({ id: "comma" }),
    ]);
  });
});
