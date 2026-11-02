import { describe, expect, it } from "vitest";
import { getAwardDirectoryCategories } from "./award-directory-filters";
import { matchesDirectorySelections, toggleDirectorySelection, type DirectorySelections } from "./award-directory-selection";

const none: DirectorySelections = { academicLevels: [], disciplines: [], citizenship: [] };
const undergraduate = { academicLevels: ["Undergraduate"], disciplines: ["STEM"], citizenship: ["U.S. citizens"] };
const graduate = { academicLevels: ["Graduate"], disciplines: ["Arts"], citizenship: ["All nationalities"] };

describe("directory multi-selection", () => {
  it("includes the full catalog when no category has a selection", () => {
    expect([undergraduate, graduate, { academicLevels: [], disciplines: [], citizenship: [] }]
      .filter((row) => matchesDirectorySelections(row, none))).toHaveLength(3);
  });

  it("matches any checked academic level, rather than requiring all of them", () => {
    const choices = { ...none, academicLevels: ["Undergraduate", "Graduate"] };
    expect(matchesDirectorySelections(undergraduate, choices)).toBe(true);
    expect(matchesDirectorySelections(graduate, choices)).toBe(true);
    expect(matchesDirectorySelections({ ...graduate, academicLevels: ["High school"] }, choices)).toBe(false);
  });

  it("matches any checked discipline and citizenship category", () => {
    const choices = { ...none, disciplines: ["STEM", "Arts"], citizenship: ["U.S. citizens", "All nationalities"] };
    expect(matchesDirectorySelections(undergraduate, choices)).toBe(true);
    expect(matchesDirectorySelections(graduate, choices)).toBe(true);
    expect(matchesDirectorySelections({ ...graduate, disciplines: ["Education"] }, choices)).toBe(false);
    expect(matchesDirectorySelections({ ...graduate, citizenship: ["Country-specific criteria"] }, choices)).toBe(false);
  });

  it("requires a match in every category that has checked options", () => {
    const choices = { academicLevels: ["Undergraduate", "Graduate"], disciplines: ["STEM"], citizenship: ["U.S. citizens"] };
    expect(matchesDirectorySelections(undergraduate, choices)).toBe(true);
    expect(matchesDirectorySelections(graduate, choices)).toBe(false);
    expect(matchesDirectorySelections({ ...undergraduate, citizenship: ["All nationalities"] }, choices)).toBe(true);
    expect(matchesDirectorySelections({ ...undergraduate, academicLevels: ["High school"] }, choices)).toBe(false);
  });

  it("includes nationality-neutral awards while keeping specific subjects scoped", () => {
    expect(matchesDirectorySelections(graduate, { ...none, citizenship: ["U.S. citizens"] })).toBe(true);
    expect(matchesDirectorySelections(undergraduate, { ...none, disciplines: ["No field restriction"] })).toBe(false);
  });

  it("keeps missing and unrecognized information out of specific-category matches", () => {
    const missing = getAwardDirectoryCategories({ academicLevels: [], disciplines: [], citizenship: [] });
    const unknown = getAwardDirectoryCategories({ academicLevels: ["Unreviewed status"], disciplines: ["Unreviewed field"], citizenship: ["Unreviewed requirement"] });
    for (const row of [missing, unknown]) {
      expect(matchesDirectorySelections(row, { academicLevels: ["Undergraduate"], disciplines: [], citizenship: [] })).toBe(false);
      expect(matchesDirectorySelections(row, { academicLevels: [], disciplines: ["STEM"], citizenship: [] })).toBe(false);
      expect(matchesDirectorySelections(row, { academicLevels: [], disciplines: [], citizenship: ["All nationalities"] })).toBe(false);
      expect(matchesDirectorySelections(row, { academicLevels: ["Other / not listed"], disciplines: [], citizenship: [] })).toBe(true);
    }
  });

  it("does not mutate reviewed categories or selected options", () => {
    const row = Object.freeze({ academicLevels: Object.freeze(["Undergraduate"]), disciplines: Object.freeze(["STEM"]), citizenship: Object.freeze(["U.S. citizens"]) });
    const selected = Object.freeze({ academicLevels: Object.freeze(["Undergraduate", "Graduate"]), disciplines: Object.freeze([]), citizenship: Object.freeze([]) });
    expect(matchesDirectorySelections(row, selected)).toBe(true);
    expect(row.academicLevels).toEqual(["Undergraduate"]);
    expect(selected.academicLevels).toEqual(["Undergraduate", "Graduate"]);
  });

  it("adds a choice and removes just that choice without clearing the others", () => {
    const initial = Object.freeze(["Undergraduate"]);
    const added = toggleDirectorySelection(initial, "Graduate");
    expect(added).toEqual(["Undergraduate", "Graduate"]);
    expect(initial).toEqual(["Undergraduate"]);
    expect(toggleDirectorySelection(added, "Undergraduate")).toEqual(["Graduate"]);
    expect(added).toEqual(["Undergraduate", "Graduate"]);
  });

  it("returns to the all-options state when the last checked choice is removed", () => {
    expect(toggleDirectorySelection(["Graduate"], "Graduate")).toEqual([]);
    expect(matchesDirectorySelections(undergraduate, { ...none, academicLevels: toggleDirectorySelection(["Graduate"], "Graduate") })).toBe(true);
  });
});


describe("inclusive broad discovery scopes", () => {
 const broad = { academicLevels: ["Graduate"], disciplines: ["No field restriction"], citizenship: ["All nationalities"] };
 it.each(["STEM", "Engineering", "Computing & data", "Mathematics", "Natural sciences", "Environment & earth sciences", "Social sciences & policy", "Arts", "Business & law", "Health & medicine", "Education"])("includes an unrestricted award for %s", value => { expect(matchesDirectorySelections(broad, { ...none, disciplines: [value] })).toBe(true); });
 it.each(["U.S. citizens", "U.S. nationals", "U.S. permanent residents"])("includes nationality-neutral awards for %s", value => { expect(matchesDirectorySelections(broad, { ...none, citizenship: [value] })).toBe(true); });
 it.each(["DACA / undocumented", "New American criteria", "Work authorization", "Other / not listed", "Unknown"])("does not invent %s eligibility from unrestricted nationality", value => { expect(matchesDirectorySelections(broad, { ...none, citizenship: [value] })).toBe(false); });
 it("never treats missing or course-specific fields as unrestricted", () => { for (const disciplines of [["Other / not listed"], ["Multiple fields (check courses)"], []]) expect(matchesDirectorySelections({ ...broad, disciplines }, { ...none, disciplines: ["STEM"] })).toBe(false); });
 it("still requires the selected academic stage", () => { expect(matchesDirectorySelections(broad, { ...none, academicLevels: ["Undergraduate"], disciplines: ["STEM"] })).toBe(false); });
});
