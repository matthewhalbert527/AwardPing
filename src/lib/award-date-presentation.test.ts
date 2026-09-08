import { describe, expect, it } from "vitest";
import { formatAwardDateText } from "@/lib/award-date-display";
import { presentAwardDateField, presentAwardTimelineDate } from "@/lib/award-date-presentation";

// The one combined award this registry covers, spelled as the record spells it.
const BOREN = "Boren Scholarships and Fellowships";
// A single-track award, for the plain redundancy case.
const SINGLE_AWARD = "Example Foundation Scholarship";

// Cycle years are derived, never written down: a hard-coded year would quietly
// go stale, and an assertion that passes because a date drifted into the past
// is worse than no assertion.
const NEXT_YEAR = new Date().getUTCFullYear() + 1;

function isLeapYear(year: number) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function firstLeapYearFrom(year: number) {
  for (let candidate = year; candidate < year + 8; candidate += 1) {
    if (isLeapYear(candidate)) return candidate;
  }
  throw new Error(`no leap year in the eight years from ${year}`);
}

const LEAP_YEAR = firstLeapYearFrom(NEXT_YEAR);
// The year after a leap year is never itself a leap year.
const COMMON_YEAR = LEAP_YEAR + 1;

// The two real Boren scopes, in the shape the reviewed facts carry them.
const SCHOLARSHIPS_DEADLINE = `January 27, ${NEXT_YEAR} (Boren Scholarships)`;
const FELLOWSHIPS_DEADLINE = `January 20, ${NEXT_YEAR} (Boren Fellowships)`;

describe("presentAwardDateField", () => {
  it("states the reported redundancy the date formatter alone leaves on screen", () => {
    // Before: the formatter has no award context, so it can only pass the
    // reviewed text through — the brand is said twice and the track that
    // actually distinguishes the two dates is buried in a parenthetical.
    expect(formatAwardDateText(SCHOLARSHIPS_DEADLINE)).toBe(SCHOLARSHIPS_DEADLINE);
    expect(formatAwardDateText(SCHOLARSHIPS_DEADLINE)).toContain("(Boren Scholarships)");

    // After: the track becomes the label and the value is the date alone.
    expect(presentAwardDateField(SCHOLARSHIPS_DEADLINE, BOREN)).toEqual({
      label: "Scholarships deadline",
      value: `January 27, ${NEXT_YEAR}`,
    });
  });

  it("keeps the two Boren scopes distinct rather than erasing either", () => {
    const scholarships = presentAwardDateField(SCHOLARSHIPS_DEADLINE, BOREN);
    const fellowships = presentAwardDateField(FELLOWSHIPS_DEADLINE, BOREN);

    expect(scholarships).toEqual({ label: "Scholarships deadline", value: `January 27, ${NEXT_YEAR}` });
    expect(fellowships).toEqual({ label: "Fellowships deadline", value: `January 20, ${NEXT_YEAR}` });
    expect(scholarships.label).not.toBe(fellowships.label);
    expect(scholarships.value).not.toBe(fellowships.value);
  });

  it("scopes an opening date with the same wording as its own field", () => {
    expect(presentAwardDateField(`January 5, ${NEXT_YEAR} (Boren Fellowships)`, BOREN, "Opening date")).toEqual({
      label: "Fellowships opening date",
      value: `January 5, ${NEXT_YEAR}`,
    });
  });

  it("drops an identity that only repeats the award's own name, keeping the field label", () => {
    expect(presentAwardDateField(`January 27, ${NEXT_YEAR} (${SINGLE_AWARD})`, SINGLE_AWARD)).toEqual({
      label: "Deadline",
      value: `January 27, ${NEXT_YEAR}`,
    });
    expect(presentAwardDateField(`January 5, ${NEXT_YEAR} (${BOREN})`, BOREN, "Opening date")).toEqual({
      label: "Opening date",
      value: `January 5, ${NEXT_YEAR}`,
    });
  });

  it("styles a machine timestamp behind an identity, offset and all", () => {
    expect(presentAwardDateField(`${NEXT_YEAR}-01-27 (Boren Scholarships)`, BOREN)).toEqual({
      label: "Scholarships deadline",
      value: `January 27, ${NEXT_YEAR}`,
    });
    expect(presentAwardDateField(`${NEXT_YEAR}-01-20T17:00:00-05:00 (Boren Fellowships)`, BOREN)).toEqual({
      label: "Fellowships deadline",
      value: `January 20, ${NEXT_YEAR} at 5:00 p.m. (UTC-05:00)`,
    });
  });

  it("ignores whitespace around the whole value without altering the date", () => {
    expect(presentAwardDateField(`  ${SCHOLARSHIPS_DEADLINE}  `, BOREN)).toEqual({
      label: "Scholarships deadline",
      value: `January 27, ${NEXT_YEAR}`,
    });
  });

  it("recognizes February 29 in a leap year and refuses it in a common one", () => {
    expect(presentAwardDateField(`February 29, ${LEAP_YEAR} (Boren Scholarships)`, BOREN)).toEqual({
      label: "Scholarships deadline",
      value: `February 29, ${LEAP_YEAR}`,
    });
    expect(presentAwardDateField(`February 29, ${COMMON_YEAR} (Boren Scholarships)`, BOREN)).toEqual({
      label: "Deadline",
      value: `February 29, ${COMMON_YEAR} (Boren Scholarships)`,
    });
  });

  it("returns a missing value as missing, under the caller's own label", () => {
    expect(presentAwardDateField(null, BOREN)).toEqual({ label: "Deadline", value: null });
    expect(presentAwardDateField(undefined, BOREN, "Opening date")).toEqual({
      label: "Opening date",
      value: null,
    });
    // A non-null empty string is not missing; it stays whatever the formatter
    // makes of it, so a caller's own "Not listed" fallback still decides.
    expect(presentAwardDateField("", BOREN)).toEqual({ label: "Deadline", value: "" });
  });
});

describe("award context", () => {
  const cases: Array<[string, string | undefined]> = [
    ["a different award", "Fulbright U.S. Student Program"],
    ["no award name at all", undefined],
    ["an empty award name", ""],
  ];

  it.each(cases)("leaves a scoped-looking value untouched with %s", (_description, awardName) => {
    expect(presentAwardDateField(SCHOLARSHIPS_DEADLINE, awardName)).toEqual({
      label: "Deadline",
      value: SCHOLARSHIPS_DEADLINE,
    });
    expect(presentAwardTimelineDate(SCHOLARSHIPS_DEADLINE, awardName)).toBe(SCHOLARSHIPS_DEADLINE);
  });

  it("will not borrow another award's registry entry", () => {
    // "Boren Fellowships" is a registered identity, but only under Boren.
    expect(presentAwardDateField(FELLOWSHIPS_DEADLINE, "Fulbright U.S. Student Program")).toEqual({
      label: "Deadline",
      value: FELLOWSHIPS_DEADLINE,
    });
  });

  it("cannot be answered by an inherited object property", () => {
    expect(presentAwardDateField(`January 27, ${NEXT_YEAR} (constructor)`, "toString")).toEqual({
      label: "Deadline",
      value: `January 27, ${NEXT_YEAR} (constructor)`,
    });
  });
});

describe("identities the registry does not name", () => {
  // Every one of these is a near miss that a substring, prefix, plural or
  // conjunction rule would have "recognized". None of them may lose a word.
  const nearMisses = [
    "Boren Scholarship",
    "boren scholarships",
    "BOREN SCHOLARSHIPS",
    "The Boren Scholarships",
    "Boren Scholarships and Fellowships (Africa)",
    "Boren Awards",
    "Scholarships",
  ];

  it.each(nearMisses)("keeps the whole value when the identity is %s", (identity) => {
    const value = `January 27, ${NEXT_YEAR} (${identity})`;
    expect(presentAwardDateField(value, BOREN)).toEqual({ label: "Deadline", value });
    expect(presentAwardTimelineDate(value, BOREN)).toBe(value);
  });
});

describe("qualifiers that carry meaning", () => {
  // Each of these is something a reviewer wrote because it changes what the
  // date means. None of them is a program identity, and none may be dropped.
  const meaningful: Array<[string, string]> = [
    [
      `${NEXT_YEAR}-01-27T17:00:00-05:00`,
      `January 27, ${NEXT_YEAR} at 5:00 p.m. (UTC-05:00)`,
    ],
    [
      `${NEXT_YEAR}-01-27T17:00 (applicant's time zone)`,
      `January 27, ${NEXT_YEAR} at 5:00 p.m. (applicant's time zone)`,
    ],
    [
      `January 27, ${NEXT_YEAR} (endorsing institution time zone)`,
      `January 27, ${NEXT_YEAR} (endorsing institution time zone)`,
    ],
    [`January 27, ${NEXT_YEAR} (dependent on course)`, `January 27, ${NEXT_YEAR} (dependent on course)`],
  ];

  it.each(meaningful)("keeps %s intact", (value, expected) => {
    expect(presentAwardDateField(value, BOREN)).toEqual({ label: "Deadline", value: expected });
    expect(presentAwardTimelineDate(value, BOREN)).toBe(expected);
  });
});

describe("values this projection must not touch", () => {
  const unrecognized = [
    // A date that does not exist, behind a registered identity.
    `February 30, ${NEXT_YEAR} (Boren Scholarships)`,
    `April 31, ${NEXT_YEAR} (Boren Scholarships)`,
    `${NEXT_YEAR}-13-01 (Boren Scholarships)`,
    // Partial values.
    `${NEXT_YEAR}-01 (Boren Scholarships)`,
    `January ${NEXT_YEAR} (Boren Scholarships)`,
    // More than one date in front of the identity.
    `${NEXT_YEAR}-01-20 to ${NEXT_YEAR}-01-27 (Boren Scholarships)`,
    // A known limit, pinned deliberately: the date/time separator is the only
    // whitespace a machine value may carry here, which is what keeps the range
    // above out. A space-separated zone designator is a shape the formatter
    // accepts on its own but this projection declines rather than widen that
    // gate — it falls back whole, losing nothing.
    `${NEXT_YEAR}-01-27 17:00:00 -05:00 (Boren Scholarships)`,
    // A day written in a style this codebase does not render.
    `January 07, ${NEXT_YEAR} (Boren Scholarships)`,
    `01/27/${NEXT_YEAR} (Boren Scholarships)`,
    // No date in front of the identity at all.
    "(Boren Scholarships)",
    `Rolling (Boren Scholarships)`,
    // The identity is not the last thing in the value.
    `January 27, ${NEXT_YEAR} (Boren Scholarships) — see the official site`,
    `(Boren Scholarships) January 27, ${NEXT_YEAR}`,
    // A nested parenthetical is not a flat identity.
    `January 27, ${NEXT_YEAR} (Boren Scholarships (Africa))`,
    // An empty parenthetical names nothing.
    `January 27, ${NEXT_YEAR} ()`,
    // A labelled item keeps the reviewer's label; the label is not a date.
    `Deadline: January 27, ${NEXT_YEAR} (Boren Scholarships)`,
    `Campus deadline: ${NEXT_YEAR}-01-27 (Boren Scholarships)`,
    // Event text that happens to name the award.
    `${NEXT_YEAR}-03-01: Boren Scholarships interviews`,
    "Boren Scholarships interviews are held in March",
    // Prose the formatter already leaves alone.
    "Rolling",
    "TBA",
    "Last Friday in January, 5:00 p.m. Central Time",
    "",
  ];

  it.each(unrecognized)("hands %s to the date formatter whole", (value) => {
    const expected = formatAwardDateText(value);
    expect(presentAwardDateField(value, BOREN)).toEqual({ label: "Deadline", value: expected });
    expect(presentAwardDateField(value, BOREN, "Opening date")).toEqual({
      label: "Opening date",
      value: expected,
    });
    expect(presentAwardTimelineDate(value, BOREN)).toBe(expected);
  });

  it("preserves the whole suffix of an unrecognized value, not just its date", () => {
    const range = `${NEXT_YEAR}-01-20 to ${NEXT_YEAR}-01-27 (Boren Scholarships)`;
    expect(presentAwardDateField(range, BOREN).value).toBe(range);
    expect(presentAwardDateField(range, BOREN).value).toContain("(Boren Scholarships)");

    const appended = `January 27, ${NEXT_YEAR} (Boren Scholarships) — see the official site`;
    expect(presentAwardDateField(appended, BOREN).value).toBe(appended);

    // The declined machine shape keeps every character it arrived with, so a
    // reviewer can still read the value that was approved.
    const spacedDesignator = `${NEXT_YEAR}-01-27 17:00:00 -05:00 (Boren Scholarships)`;
    expect(presentAwardDateField(spacedDesignator, BOREN).value).toBe(spacedDesignator);
  });
});

describe("presentAwardTimelineDate", () => {
  it("states the track in front of the date", () => {
    expect(presentAwardTimelineDate(FELLOWSHIPS_DEADLINE, BOREN)).toBe(`Fellowships: January 20, ${NEXT_YEAR}`);
    expect(presentAwardTimelineDate(SCHOLARSHIPS_DEADLINE, BOREN)).toBe(`Scholarships: January 27, ${NEXT_YEAR}`);
  });

  it("invents no category for a timeline entry", () => {
    const presented = presentAwardTimelineDate(FELLOWSHIPS_DEADLINE, BOREN);
    expect(presented).not.toMatch(/deadline/i);
    expect(presented).not.toMatch(/opening/i);
  });

  it("drops an identity that only repeats the award's own name", () => {
    expect(presentAwardTimelineDate(`January 27, ${NEXT_YEAR} (${BOREN})`, BOREN)).toBe(
      `January 27, ${NEXT_YEAR}`,
    );
  });

  it("styles a timeline entry the formatter understands, award context or not", () => {
    const entry = `${NEXT_YEAR}-03-01: interviews`;
    const expected = `March 1, ${NEXT_YEAR}: interviews`;
    expect(presentAwardTimelineDate(entry, BOREN)).toBe(expected);
    expect(presentAwardTimelineDate(entry)).toBe(expected);
  });

  it("needs award context before it will scope anything", () => {
    expect(presentAwardTimelineDate(FELLOWSHIPS_DEADLINE)).toBe(FELLOWSHIPS_DEADLINE);
  });
});
