import { describe, expect, it } from "vitest";
import {
  directoryFilterOptions,
  getAwardDirectoryCategories,
  type DirectoryFilterField,
  type DirectoryFilterInput,
} from "./award-directory-filters";

const OTHER = "Other / not listed";
const fields: DirectoryFilterField[] = ["academicLevels", "disciplines", "citizenship"];
const ordered: Record<DirectoryFilterField, string[]> = {
  academicLevels: ["High school", "Undergraduate", "Recent graduate", "Graduate", "Master's", "Doctoral", "Professional", OTHER],
  disciplines: ["STEM", "Engineering", "Computing & data", "Mathematics", "Natural sciences", "Environment & earth sciences", "Social sciences & policy", "Arts", "Business & law", "Health & medicine", "Education", "No field restriction", "Multiple fields (check courses)", OTHER],
  citizenship: ["U.S. citizens", "U.S. nationals", "U.S. permanent residents", "DACA / undocumented", "All nationalities", "Country-specific criteria", "New American criteria", "Work authorization", OTHER],
};
const labels: Record<string, string> = {
  Arts: "Arts & humanities",
  "Environment & earth sciences": "Environment & earth",
  "Social sciences & policy": "Society & policy",
  "Multiple fields (check courses)": "Multiple fields",
  "Country-specific criteria": "Country-specific",
  "U.S. permanent residents": "U.S. green card",
};
function input(field?: DirectoryFilterField, values: readonly string[] = []): DirectoryFilterInput {
  return { academicLevels: [], disciplines: [], citizenship: [], ...(field ? { [field]: values } : {}) };
}
function options(values: readonly string[]) {
  return values.map(value => ({ value, label: labels[value] ?? value }));
}

describe("award directory broad filter categories", () => {
  it("keeps missing fields visible as Other / not listed rather than inferring eligibility", () => {
    expect(getAwardDirectoryCategories(input())).toEqual({
      academicLevels: [OTHER], disciplines: [OTHER], citizenship: [OTHER],
    });
  });

  it("deduplicates normalized known values and returns a stable logical order", () => {
    expect(getAwardDirectoryCategories({
      academicLevels: ["Graduate", " undergraduate ", "UNDERGRADUATE."],
      disciplines: ["Arts", "STEM", " stem "],
      citizenship: ["U.S. citizens", "  U.S.   CITIZENS. "],
    })).toEqual({ academicLevels: ["Undergraduate", "Graduate"], disciplines: ["STEM", "Arts"], citizenship: ["U.S. citizens"] });
  });

  it.each([
    { field: "academicLevels", raw: "Not eligible: Undergraduate" },
    { field: "academicLevels", raw: "Graduate students are not eligible" },
    { field: "academicLevels", raw: "Undergraduate or Graduate (unreviewed condition)" },
    { field: "academicLevels", raw: "Undergraduate.." },
    { field: "disciplines", raw: "Not STEM" },
    { field: "disciplines", raw: "Engineering excluded" },
    { field: "disciplines", raw: "STEM except an unreviewed subject" },
    { field: "citizenship", raw: "No U.S. citizens" },
    { field: "citizenship", raw: "Not a U.S. citizen" },
    { field: "citizenship", raw: "U.S. citizenship is not required" },
    { field: "citizenship", raw: "U.S. citizens only if an unreviewed condition is met" },
  ] as const)("does not infer a category from words inside unknown $field text: $raw", ({ field, raw }) => {
    expect(getAwardDirectoryCategories(input(field, [raw]))[field]).toEqual([OTHER]);
  });

  it.each(fields)("handles blank and unknown %s without losing the fallback", field => {
    expect(getAwardDirectoryCategories(input(field, ["", " \t\n "]))[field]).toEqual([OTHER]);
    expect(getAwardDirectoryCategories(input(field, ["Unreviewed requirement"]))[field]).toEqual([OTHER]);
  });

  it("preserves both a known category and unknown substantive criteria", () => {
    expect(getAwardDirectoryCategories(input("academicLevels", ["Undergraduate", "Unreviewed restriction"])).academicLevels).toEqual(["Undergraduate", OTHER]);
  });

  it.each([
    { field: "academicLevels", raw: ["Sophomore", "Junior", "Graduating seniors", "Undergraduate (associate, bachelor's)"], expected: ["Undergraduate"] },
    { field: "academicLevels", raw: ["Recent graduates", "Individuals who have graduated during the previous academic year"], expected: ["Recent graduate"] },
    { field: "academicLevels", raw: ["Postgraduate / Recent graduate"], expected: ["Recent graduate", "Graduate"] },
    { field: "academicLevels", raw: ["  MASTER’S   student.  "], expected: ["Graduate", "Master's"] },
    { field: "academicLevels", raw: ["Doctoral student (early stage)"], expected: ["Graduate", "Doctoral"] },
    { field: "academicLevels", raw: ["Graduate (master's, doctoral, professional)"], expected: ["Graduate", "Master's", "Doctoral", "Professional"] },
    { field: "academicLevels", raw: ["Undergraduate senior, bachelor's degree-holder with no graduate degree enrollment, joint bachelor's-master's student with at least three undergraduate years completed, or first-year graduate student in their first graduate degree program"], expected: ["Undergraduate", "Graduate", "Master's"] },
    { field: "academicLevels", raw: ["Gap year preparing for graduate school"], expected: [OTHER] },
    { field: "disciplines", raw: ["Science, mathematics, and engineering"], expected: ["STEM", "Engineering", "Mathematics"] },
    { field: "disciplines", raw: ["Science, technology, engineering, and mathematics (STEM) fields, including STEM education"], expected: ["STEM", "Engineering", "Mathematics", "Education"] },
    { field: "disciplines", raw: ["STEM, including STEM education"], expected: ["STEM", "Education"] },
    { field: "disciplines", raw: ["Social sciences (excluding neuroscience and clinical psychology)"], expected: ["Social sciences & policy"] },
    { field: "disciplines", raw: ["Environmental, Tribal public policy, and health care fields"], expected: ["Environment & earth sciences", "Social sciences & policy", "Health & medicine"] },
    { field: "disciplines", raw: ["All fields of study", "All fields of study (no restrictions based on field of study or career aspiration)"], expected: ["No field restriction"] },
    { field: "disciplines", raw: ["Almost any discipline at graduate level leading to the award of a British university degree", "Any postgraduate subject available at the University of Cambridge"], expected: ["Multiple fields (check courses)"] },
    { field: "citizenship", raw: ["U.S. citizen, U.S. national, or permanent resident of the United States.", "US citizen", "U.S. National", "US permanent resident"], expected: ["U.S. citizens", "U.S. nationals", "U.S. permanent residents"] },
    { field: "citizenship", raw: ["U.S. citizen or U.S. national at the time of application."], expected: ["U.S. citizens", "U.S. nationals"] },
    { field: "citizenship", raw: ["U.S. Dual Citizen"], expected: ["U.S. citizens", "Country-specific criteria"] },
    { field: "citizenship", raw: ["United States", "Australia", "Canada", "New Zealand", "United Kingdom"], expected: ["Country-specific criteria"] },
    { field: "citizenship", raw: ["U.S. citizenship is not required for applicants attending a U.S. institution if eligible to work in the U.S. for 10–12 months from September 1 through at least June 30 following graduation.", "Must be a U.S. citizen if attending a participating institution located outside the United States."], expected: ["Country-specific criteria", "Work authorization"] },
    { field: "citizenship", raw: ["Naturalized US citizens, green card holders, asylees, refugees, or individuals who graduated from both high school and college in the United States."], expected: ["New American criteria"] },
    { field: "citizenship", raw: ["Citizens of any country outside the United Kingdom", "Dual citizens of the United Kingdom and another country", "Mainland Chinese applicants holding a P.R.C. passport are eligible if currently enrolled as undergraduates at a Mainland Chinese university."], expected: ["Country-specific criteria"] },
    { field: "citizenship", raw: ["DACA Recipient", "Undocumented students and applicants with DACA status"], expected: ["DACA / undocumented"] },
  ] as const)("maps reviewed whole $field criteria without dropping their conditional category: $raw", ({ field, raw, expected }) => {
    expect(getAwardDirectoryCategories(input(field, raw))[field]).toEqual(expected);
  });

  it("does not infer degree eligibility from a discipline phrase mentioning a degree", () => {
    expect(getAwardDirectoryCategories(input("disciplines", ["STEM fields (MS/MA)"]))).toEqual({
      academicLevels: [OTHER], disciplines: ["STEM"], citizenship: [OTHER],
    });
  });

  it("treats broad field/nationality categories as explicit options rather than wildcard eligibility", () => {
    const result = getAwardDirectoryCategories({
      academicLevels: ["Undergraduate"],
      disciplines: ["No field restriction"],
      citizenship: ["All nationalities"],
    });
    expect(result.disciplines).toEqual(["No field restriction"]);
    expect(result.citizenship).toEqual(["All nationalities"]);
    expect(result.disciplines).not.toContain("STEM");
    expect(result.citizenship).not.toContain("U.S. citizens");
  });

  it.each(fields)("returns only present %s options, deduplicated in the frozen order", field => {
    const values = ordered[field];
    const categories = [input(field, [...values].reverse()), input(field, values)];
    expect(directoryFilterOptions(field, categories)).toEqual(options(values));
    expect(directoryFilterOptions(field, [])).toEqual([]);
    const subset = [values.at(-1)!, values[1], values[0], values[1]];
    expect(directoryFilterOptions(field, [input(field, subset)])).toEqual(options([values[0], values[1], values.at(-1)!]));
  });

  it("does not mutate frozen input arrays or return shared mutable result arrays", () => {
    const raw = Object.freeze({
      academicLevels: Object.freeze(["Graduate", "Undergraduate"]),
      disciplines: Object.freeze(["Arts", "STEM"]),
      citizenship: Object.freeze(["U.S. citizens"]),
    });
    const before = structuredClone(raw);
    const categorized = getAwardDirectoryCategories(raw);
    const firstOptions = directoryFilterOptions("disciplines", Object.freeze([categorized]));
    firstOptions[0].label = "Mutated caller label";
    expect(directoryFilterOptions("disciplines", [categorized])).toEqual(options(["STEM", "Arts"]));
    expect(raw).toEqual(before);
    expect(categorized).toEqual({ academicLevels: ["Undergraduate", "Graduate"], disciplines: ["STEM", "Arts"], citizenship: ["U.S. citizens"] });
  });
});
