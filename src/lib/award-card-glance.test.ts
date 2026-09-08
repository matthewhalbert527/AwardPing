import { describe, expect, it } from "vitest";
import { awardCardGlance, type AwardCardGlanceInput } from "@/lib/award-card-glance";

const EMPTY: AwardCardGlanceInput = { academicLevels: [], citizenship: [], changeCount: null };
const level = (academicLevels: readonly string[]) => awardCardGlance({ ...EMPTY, academicLevels })[0];
const citizenship = (values: readonly string[]) => awardCardGlance({ ...EMPTY, citizenship: values })[1];

describe("awardCardGlance", () => {
  it("always keeps the same three labelled slots and distinguishes missing criteria from unavailable counts", () => {
    expect(awardCardGlance(EMPTY)).toEqual([
      { key: "level", label: "Level", value: "Not listed" },
      { key: "citizenship", label: "Citizenship", value: "Not listed" },
      { key: "updates", label: "Updates", value: "Not available" },
    ]);
  });

  it("renders the exact Goldwater categories without dropping nationals or permanent residents", () => {
    const original = "U.S. citizen, U.S. national, or permanent resident of the United States.";
    expect(awardCardGlance({ academicLevels: ["Sophomore", "Junior"], citizenship: [original], changeCount: 0 }))
      .toEqual([
        { key: "level", label: "Level", value: "Sophomores; Juniors", detail: "Sophomore; Junior" },
        { key: "citizenship", label: "Citizenship", value: "U.S. citizens, nationals or permanent residents", detail: original },
        { key: "updates", label: "Updates", value: "None recorded" },
      ]);
  });

  it("retains all four SMART levels and all five countries", () => {
    expect(level(["High school senior", "Undergraduate", "Master's", "Doctoral"]).value)
      .toBe("High school senior; Undergraduate; Master's; Doctoral");
    const values = ["United States", "Australia", "Canada", "New Zealand", "United Kingdom"];
    expect(citizenship(values)).toEqual({
      key: "citizenship", label: "Citizenship", value: "U.S.; Australia; Canada; New Zealand; U.K.", detail: values.join("; "),
    });
  });

  it("retains Udall's third level and all three U.S. statuses", () => {
    expect(level(["Sophomore", "Junior", "Undergraduate"]).value).toBe("Sophomores; Juniors; Undergraduate");
    expect(citizenship(["U.S. Citizen", "U.S. National", "U.S. Lawful Permanent Resident"]).value)
      .toBe("U.S. citizens, nationals or permanent residents");
  });

  it("keeps DACA separate and does not imply that recipients must be U.S. citizens", () => {
    expect(citizenship(["U.S. Citizen", "DACA Recipient"]).value).toBe("U.S. citizens; DACA Recipient");
  });

  it("retains the separate dual-citizen category and deduplicates only exact citizen aliases", () => {
    const values = ["U.S. Citizen", "U.S. Dual Citizen", "U.S. National", "United States citizen"];
    expect(citizenship(values).value).toBe("U.S. citizens, dual citizens or nationals");
    expect(citizenship(values).detail).toBe(values.join("; "));
  });

  it("preserves Truman's American Samoa restriction instead of broadening it to all nationals", () => {
    expect(citizenship(["United States citizen", "United States national from American Samoa"]).value)
      .toBe("U.S. citizens; United States national from American Samoa");
  });

  it.each([
    "U.S. citizen or U.S. national at the time of application.",
    "United States citizen (native-born or naturalized)",
    "DACA Recipient",
    "Citizens of any country outside the United Kingdom",
    "Dual citizens of the United Kingdom and another country",
  ])("keeps the full short qualifier: %s", (value) => {
    expect(citizenship([value]).value).toBe(value);
  });

  it.each([
    ["US citizen", "US permanent resident", "U.S. citizens or permanent residents"],
    ["U.S. citizen", "United States national", "U.S. citizens or nationals"],
    ["U.S. national", "US permanent resident", "U.S. nationals or permanent residents"],
  ])("combines complete known statuses %s and %s without changing their categories", (a, b, expected) => {
    expect(citizenship([a, b]).value).toBe(expected);
  });

  it.each([
    ["Citizen or national of the United States", "U.S. citizens or nationals"],
    ["U.S. citizen or national", "U.S. citizens or nationals"],
    ["U.S. citizen, national, or permanent resident", "U.S. citizens, nationals or permanent residents"],
  ])("uses an exact alias for the whole disjunction %s", (value, expected) => {
    expect(citizenship([value]).value).toBe(expected);
  });

  it("deduplicates aliases using case, whitespace, and a final period only", () => {
    expect(level([" Junior ", "JUNIORS.", "Sophomore", "sophomores"]).value).toBe("Juniors; Sophomores");
    expect(level(["College senior", "College seniors", "Graduating senior", "Graduating seniors"]).value)
      .toBe("College seniors; Graduating seniors");
    expect(citizenship(["  US   citizen. ", "U.S. citizens", "United States citizen"]).value).toBe("U.S. citizens");
    expect(citizenship(["United Kingdom", "UK", "Australia"]).value).toBe("U.K.; Australia");
  });

  it("does not merge an unrecognized restriction with a broad alias", () => {
    const values = ["Graduate", "Graduate (master's, doctoral, professional)"];
    expect(level(values).value).toBe(values.join("; "));
  });

  it.each([
    "First-year graduate student (2027–2028 academic year)",
    "Recent graduates (within 12 months prior to the deadline)",
    "Doctoral student (early stage)",
    "Third-year undergraduate in a five-year program",
    "Postgraduate (PhD, MLitt, or one-year postgraduate course)",
  ])("never removes a year, stage, or course restriction: %s", (value) => {
    expect(level([value]).value).toBe(value);
  });

  it("uses the whole-field fallback rather than dropping Hertz's third academic stage", () => {
    const values = ["College senior", "First-year graduate student", "Gap year preparing for graduate school"];
    expect(level(values)).toEqual({ key: "level", label: "Level", value: "See full criteria", detail: values.join("; ") });
  });

  it.each([
    [
      "Applicants must be non-Chinese citizens with a valid passport; former citizens of the Chinese Mainland, Hong Kong, Macao or Taiwan must present a valid passport or citizenship documents dating from before April 30, 2021, along with proof of cancellation of Chinese nationality.",
      "Mainland Chinese applicants holding a P.R.C. passport are eligible if currently enrolled as undergraduates at a Mainland Chinese university.",
    ],
    [
      "U.S. citizenship is not required for applicants attending a U.S. institution if eligible to work in the U.S. for 10–12 months from September 1 through at least June 30 following graduation.",
      "Must be a U.S. citizen if attending a participating institution located outside the United States.",
    ],
    ["Naturalized US citizens, green card holders, asylees, refugees, or individuals who graduated from both high school and college in the United States."],
    ["U.S. citizen or U.S. national from American Samoa or the Commonwealth of the Northern Mariana Islands"],
    ["Citizens and residents of all countries are eligible", "Undocumented students and applicants with DACA status"],
    ["Citizens of any country outside the United Kingdom", "Dual citizens of the United Kingdom and another country"],
  ])("defers complex full criteria without inventing a broad eligibility category", (...values) => {
    const item = citizenship(values);
    expect(item.value).toBe("See full criteria");
    expect(item.detail).toBe(values.join("; "));
    expect(item.value).not.toMatch(/International|All nationalities|^U\.S\.$/);
  });

  it("applies the 80-character display budget to a complete field, not each fragment", () => {
    expect(level(["a".repeat(80)]).value).toBe("a".repeat(80));
    expect(level(["a".repeat(81)])).toEqual({ key: "level", label: "Level", value: "See full criteria", detail: "a".repeat(81) });
    const values = ["a".repeat(40), "b".repeat(40)];
    expect(level(values).value).toBe("See full criteria");
    expect(level(values).detail).toBe(values.join("; "));
  });

  it("does not treat blanks as unrestricted criteria", () => {
    expect(level(["", "   "]).value).toBe("Not listed");
    expect(citizenship(["\n", " "]).value).toBe("Not listed");
    expect(citizenship(["", "US citizen", " "]).value).toBe("U.S. citizens");
  });

  it.each([
    [0, "None recorded", false],
    [1, "1 recorded", true],
    [20, "20 recorded", true],
    [null, "Not available", false],
    [NaN, "Not available", false],
    [Infinity, "Not available", false],
    [-Infinity, "Not available", false],
    [-1, "Not available", false],
    [0.5, "Not available", false],
  ] as const)("reports count %s without inferring updates from other state", (changeCount, value, highlight) => {
    const item = awardCardGlance({ ...EMPTY, changeCount })[2];
    expect(item.value).toBe(value);
    expect(Boolean(item.highlight)).toBe(highlight);
  });

  it("does not mutate frozen reviewed arrays or its input", () => {
    const input = Object.freeze({
      academicLevels: Object.freeze(["Junior", "Sophomore"]),
      citizenship: Object.freeze(["US citizen", "DACA Recipient"]),
      changeCount: 0,
    });
    const before = JSON.stringify(input);
    const first = awardCardGlance(input);
    first[0].value = "caller-owned projection";
    expect(JSON.stringify(input)).toBe(before);
    expect(awardCardGlance(input)[0].value).toBe("Juniors; Sophomores");
  });
});
