import { describe, expect, it } from "vitest";
import { awardCardGlance, type AwardCardGlanceInput } from "@/lib/award-card-glance";
import { getAwardDirectoryCategories } from "@/lib/award-directory-filters";

const EMPTY: AwardCardGlanceInput = { academicLevels: [], citizenship: [], changeCount: null };
const level = (academicLevels: readonly string[]) => awardCardGlance({ ...EMPTY, academicLevels })[0];
const citizenship = (values: readonly string[]) => awardCardGlance({ ...EMPTY, citizenship: values })[1];

describe("awardCardGlance", () => {
  it("always keeps the same three labelled slots and distinguishes missing criteria from unavailable dates", () => {
    expect(awardCardGlance(EMPTY)).toEqual([
      { key: "level", label: "Level", value: "Not listed" },
      { key: "citizenship", label: "Citizenship", value: "Not listed" },
      { key: "updates", label: "Last update", value: "Not available" },
    ]);
  });

  it("renders the exact Goldwater categories without dropping nationals or permanent residents", () => {
    const original = "U.S. citizen, U.S. national, or permanent resident of the United States.";
    expect(awardCardGlance({ academicLevels: ["Sophomore", "Junior"], citizenship: [original], changeCount: 0 }))
      .toEqual([
        { key: "level", label: "Level", value: "Sophomores; Juniors", detail: "Sophomore; Junior" },
        { key: "citizenship", label: "Citizenship", value: "U.S. citizens, nationals or permanent residents", detail: original },
        { key: "updates", label: "Last update", value: "Not available" },
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

  it.each([0, 1, 20, null, NaN, Infinity, -Infinity, -1, 0.5])(
    "does not turn count %s alone into a date or a recency highlight", (changeCount) => {
      const item = awardCardGlance({ ...EMPTY, changeCount })[2];
      expect(item).toEqual({ key: "updates", label: "Last update", value: "Not available" });
    },
  );

  it("uses only the latest recorded update when the count is known positive", () => {
    const item = awardCardGlance({
      ...EMPTY, changeCount: 20,
      latestUpdateAt: "2026-09-08T03:00:00.123456+00:00",
      firstPublishedCaptureAt: "2026-07-01T12:00:00Z",
    })[2];
    expect(item.value).toBe("September 7, 2026");
    expect(item.dateTime).toBe("2026-09-08T03:00:00.123Z");
    expect(item.detail).toMatch(/^Last recorded update: Sep 7, 2026,/);
    expect(item.detail).toContain("CDT");
    expect(item.highlight).toBeUndefined();
  });

  it("uses the first available published capture only for exactly zero changes, even if a latest-update value is supplied", () => {
    const item = awardCardGlance({
      ...EMPTY, changeCount: 0,
      latestUpdateAt: "2026-09-08T12:00:00Z",
      firstPublishedCaptureAt: "2026-01-01T05:30:00Z",
    })[2];
    expect(item.value).toBe("December 31, 2025");
    expect(item.dateTime).toBe("2026-01-01T05:30:00.000Z");
    expect(item.detail).toMatch(/^First available information capture: Dec 31, 2025,/);
    expect(item.detail).toContain("CST");
    expect(item.highlight).toBeUndefined();
  });

  it.each([null, NaN, Infinity, -Infinity, -1, 0.5])(
    "does not choose either timestamp when count %s is unavailable or invalid", (changeCount) => {
      expect(awardCardGlance({
        ...EMPTY, changeCount,
        latestUpdateAt: "2026-09-08T12:00:00Z", firstPublishedCaptureAt: "2026-07-01T12:00:00Z",
      })[2]).toEqual({ key: "updates", label: "Last update", value: "Not available" });
    },
  );

  it.each([
    undefined, null, "", "not-a-date", "2026-02-30T12:00:00Z", "2026-09-08T24:00:00Z",
    "2026-09-08T12:60:00Z", "2026-09-08T12:00:00-00:00", "2026-09-08T12:00:00",
    "2026-09-08", "September 8, 2026",
  ])("keeps a missing or invalid required timestamp unavailable rather than using the other provenance: %s", (timestamp) => {
    const latestMissing = awardCardGlance({
      ...EMPTY, changeCount: 1, latestUpdateAt: timestamp, firstPublishedCaptureAt: "2026-07-01T12:00:00Z",
    })[2];
    const firstMissing = awardCardGlance({
      ...EMPTY, changeCount: 0, firstPublishedCaptureAt: timestamp, latestUpdateAt: "2026-09-08T12:00:00Z",
    })[2];
    expect(latestMissing).toEqual({ key: "updates", label: "Last update", value: "Not available" });
    expect(firstMissing).toEqual(latestMissing);
  });

  it("does not infer recentness from a positive lifetime count or an old date", () => {
    const item = awardCardGlance({ ...EMPTY, changeCount: 100, latestUpdateAt: "2020-01-01T12:00:00Z" })[2];
    expect(item.value).toBe("January 1, 2020");
    expect(item.highlight).toBeUndefined();
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

/**
 * Display-only collapse of a redundant level entry.
 *
 * Ordinary singular/plural aliases are exact and whole-value. The institution
 * phrase can consolidate only beside an explicitly supplied bare broad level;
 * alone, its wording stays visible within the existing length budget. Nothing is
 * inferred from the browse taxonomy: `Sophomore` sits in the Undergraduate
 * filter bucket while being narrower than `Undergraduate`, so a category
 * match can never justify dropping a level.
 *
 * The complete original wording stays in `detail`, and the raw arrays that
 * feed filtering are untouched.
 */
describe("awardCardGlance redundant level wording", () => {
  /** [description, raw levels, card value, filter categories] */
  const CASES: Array<[string, string[], string, string[]]> = [
    [
      "collapses a whole-institution phrase repeated as the bare level",
      ["Undergraduate student (two-year and four-year institutions)", "Undergraduate"],
      "Undergraduate",
      ["Undergraduate"],
    ],
    [
      "collapses a singular and plural recent graduate pair",
      ["Recent graduates", "Recent graduate"],
      "Recent graduates",
      ["Recent graduate"],
    ],
    ["keeps the existing sophomore and junior aliases", ["Sophomore", "Junior"], "Sophomores; Juniors", ["Undergraduate"]],
    [
      "keeps a broader third level beside narrower ones",
      ["Sophomore", "Junior", "Undergraduate"],
      "Sophomores; Juniors; Undergraduate",
      ["Undergraduate"],
    ],
    ["keeps a degree stage beside its umbrella", ["Master's", "Graduate"], "Master's; Graduate", ["Graduate", "Master's"]],
    ["keeps two degree stages", ["Master's", "Doctoral"], "Master's; Doctoral", ["Graduate", "Master's", "Doctoral"]],
    [
      "keeps a year restriction beside the bare level",
      ["Third-year undergraduate in a five-year program", "Undergraduate"],
      "Third-year undergraduate in a five-year program; Undergraduate",
      ["Undergraduate"],
    ],
    [
      "leaves unrecognized wording exactly as written",
      ["Rising second-year scholars in good standing"],
      "Rising second-year scholars in good standing",
      ["Other / not listed"],
    ],
  ];

  it.each(CASES)("%s", (_label, levels, value) => {
    expect(level(levels).value).toBe(value);
  });

  it.each(CASES)("leaves the browse categories unchanged: %s", (_label, levels, _value, categories) => {
    // The workspace derives filter buckets from these raw arrays, never from
    // the card projection, so a display alias cannot move an award.
    expect(getAwardDirectoryCategories({ academicLevels: levels, disciplines: [], citizenship: [] }).academicLevels)
      .toEqual(categories);
  });

  it("keeps the complete original wording in the detail", () => {
    const values = ["Undergraduate student (two-year and four-year institutions)", "Undergraduate"];
    expect(level(values)).toEqual({
      key: "level",
      label: "Level",
      value: "Undergraduate",
      detail: values.join("; "),
    });
    expect(level(["Recent graduates", "Recent graduate"]).detail).toBe("Recent graduates; Recent graduate");
  });

  it("matches the new aliases on case, whitespace and a final period only", () => {
    expect(level(["  UNDERGRADUATES. ", "Undergraduate"]).value).toBe("Undergraduate");
    expect(level(["Recent Graduate.", "recent graduates"]).value).toBe("Recent graduates");
  });

  it.each([
    "Undergraduate student (two-year institutions)",
    "Undergraduate students",
    "Undergraduate (associate, bachelor's)",
    "Recent graduates (within 12 months prior to the deadline)",
    "Individuals who have graduated during the previous academic year",
  ])("does not alias a similar but differently qualified phrase: %s", (value) => {
    expect(level([value]).value).toBe(value);
    expect(level([value, "Undergraduate"]).value).toBe(`${value}; Undergraduate`);
  });

  it("does not mutate the caller's level array", () => {
    const levels = Object.freeze([
      "Undergraduate student (two-year and four-year institutions)",
      "Undergraduate",
    ]);
    const before = JSON.stringify(levels);
    expect(level(levels).value).toBe("Undergraduate");
    expect(JSON.stringify(levels)).toBe(before);
  });
});

describe("awardCardGlance conditional institution wording", () => {
  const phrase = "Undergraduate student (two-year and four-year institutions)";

  it.each([
    { name: "alone", values: [phrase], expected: phrase },
    { name: "with only Sophomore", values: [phrase, "Sophomore"], expected: `${phrase}; Sophomores` },
    { name: "with only Junior", values: [phrase, "Junior"], expected: `${phrase}; Juniors` },
    { name: "with both narrow levels", values: [phrase, "Sophomore", "Junior"], expected: `${phrase}; Sophomores; Juniors` },
    { name: "with original case and spacing", values: [`  ${phrase.toUpperCase()}.  `], expected: `  ${phrase.toUpperCase()}.  ` },
  ])("preserves the institution phrase $name", ({ values, expected }) => {
    const item = level(values);
    expect(item.value).toBe(expected);
    expect(item.detail ?? item.value).toBe(values.join("; "));
  });

  it.each([
    [phrase, "Undergraduate"],
    ["Undergraduate", phrase],
    [phrase, "Undergraduates"],
    ["Undergraduates", phrase],
    [`  ${phrase.toUpperCase()}.  `, "  UNDERGRADUATES.  "],
    ["  UNDERGRADUATES.  ", `  ${phrase.replace(/ /g, "  ")}.  `],
    [phrase, "  UNDERGRADUATE.  "],
  ])("consolidates only with an explicitly supplied broad label: %j, %j", (first, second) => {
    const values = Object.freeze([first, second]);
    const original = JSON.stringify(values);
    const input = Object.freeze({ academicLevels: values, disciplines: Object.freeze([]), citizenship: Object.freeze([]) });
    const categories = getAwardDirectoryCategories(input);
    expect(level(values)).toEqual({ key: "level", label: "Level", value: "Undergraduate", detail: values.join("; ") });
    expect(JSON.stringify(values)).toBe(original);
    expect(getAwardDirectoryCategories(input)).toEqual(categories);
    expect(categories.academicLevels).toEqual(["Undergraduate"]);
  });

  it("preserves existing bare-label presentation when that entry comes first", () => {
    const values = ["  UNDERGRADUATE.  ", phrase];
    expect(level(values)).toEqual({ key: "level", label: "Level", value: values[0], detail: values.join("; ") });
  });

  it.each([
    "Undergraduate (third year)",
    "Undergraduate?",
    "Undergraduate\u0000",
    "Not Undergraduate",
  ])("does not treat %j as an explicit bare broad label", (other) => {
    const values = [phrase, other];
    const full = values.join("; ");
    expect(level(values)).toEqual(full.length > 80
      ? { key: "level", label: "Level", value: "See full criteria", detail: full }
      : { key: "level", label: "Level", value: full });
  });

  it("retains the whole-field budget without removing a narrow level", () => {
    const values = [phrase, "Sophomore", "Junior", "Master's"];
    expect(level(values)).toEqual({ key: "level", label: "Level", value: "See full criteria", detail: values.join("; ") });
  });
});
