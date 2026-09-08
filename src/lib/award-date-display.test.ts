import { describe, expect, it } from "vitest";
import { formatAwardDateFact, formatAwardDateText } from "@/lib/award-date-display";

// The exact value the reported screenshot rendered raw.
const SCREENSHOT_DEADLINE = "2026-03-27T17:00:00-05:00";
// The already-readable house style the fix matches.
const GOLDWATER_DEADLINE = "Last Friday in January, 5:00 p.m. Central Time";

describe("formatAwardDateText", () => {
  it("turns the reported raw timestamp into the house style", () => {
    expect(formatAwardDateText(SCREENSHOT_DEADLINE)).toBe("March 27, 2026 at 5:00 p.m. (UTC-05:00)");
  });

  it.each([
    // A numeric offset is rendered as the offset it is, never as a named zone:
    // -05:00 is Central daylight time, but also Peru and Colombia year round.
    ["2026-03-27T17:00:00-05:00", "March 27, 2026 at 5:00 p.m. (UTC-05:00)"],
    ["2026-03-27T17:00:00-0500", "March 27, 2026 at 5:00 p.m. (UTC-05:00)"],
    ["2026-03-27T09:30:00+05:30", "March 27, 2026 at 9:30 a.m. (UTC+05:30)"],
    // Only the input's own designator is trusted, and only Z is named.
    ["2026-03-27T17:00:00Z", "March 27, 2026 at 5:00 p.m. (UTC)"],
    ["2026-03-27T17:00:00z", "March 27, 2026 at 5:00 p.m. (UTC)"],
    ["2026-03-27T00:00:00+00:00", "March 27, 2026 at 12:00 a.m. (UTC+00:00)"],
    // No designator means no zone claim at all.
    ["2026-03-27T17:00:00", "March 27, 2026 at 5:00 p.m."],
    ["2026-03-27T17:00", "March 27, 2026 at 5:00 p.m."],
    ["2026-03-27 17:00:00", "March 27, 2026 at 5:00 p.m."],
    // Midnight and noon read correctly rather than as "0:00" or "12 a.m."
    ["2026-03-27T00:00:00-05:00", "March 27, 2026 at 12:00 a.m. (UTC-05:00)"],
    ["2026-03-27T12:00:00-05:00", "March 27, 2026 at 12:00 p.m. (UTC-05:00)"],
    // Nonzero seconds carry information and survive; a zero second does not.
    ["2026-03-27T17:00:30Z", "March 27, 2026 at 5:00:30 p.m. (UTC)"],
  ])("renders %s readably", (input, expected) => {
    expect(formatAwardDateText(input)).toBe(expected);
  });

  it.each([
    // A nonzero fraction is information: it is reproduced digit for digit and
    // forces its own whole second to show, even when that second is zero.
    ["2026-03-27T17:00:00.250Z", "March 27, 2026 at 5:00:00.250 p.m. (UTC)"],
    ["2026-03-27T17:00:30.5Z", "March 27, 2026 at 5:00:30.5 p.m. (UTC)"],
    // Trailing zeros are part of the recorded precision, so they stay.
    ["2026-03-27T17:00:00.2500Z", "March 27, 2026 at 5:00:00.2500 p.m. (UTC)"],
    // Precision beyond what a JS number holds must survive untouched.
    ["2026-03-27T17:00:00.123456789012345678Z", "March 27, 2026 at 5:00:00.123456789012345678 p.m. (UTC)"],
    ["2026-03-27T17:00:30.000000001-05:00", "March 27, 2026 at 5:00:30.000000001 p.m. (UTC-05:00)"],
    // An all-zero fraction states nothing, so it is dropped with its second.
    ["2026-03-27T17:00:00.000Z", "March 27, 2026 at 5:00 p.m. (UTC)"],
    ["2026-03-27T17:00:30.0Z", "March 27, 2026 at 5:00:30 p.m. (UTC)"],
  ])("preserves the exact fractional second of %s", (input, expected) => {
    expect(formatAwardDateText(input)).toBe(expected);
  });

  it.each([
    // A date with no time stays a date: no midnight invented, no day shifted.
    ["2026-03-27", "March 27, 2026"],
    ["2026-01-01", "January 1, 2026"],
    ["2026-12-31", "December 31, 2026"],
    ["2024-02-29", "February 29, 2024"],
  ])("keeps %s a plain calendar date", (input, expected) => {
    expect(formatAwardDateText(input)).toBe(expected);
  });

  it("never shifts the calendar day across a year or month boundary", () => {
    // A late-evening UTC instant and an early-morning offset instant both keep
    // the day their own text states, whatever the host time zone is.
    expect(formatAwardDateText("2025-12-31T23:59:00Z")).toBe("December 31, 2025 at 11:59 p.m. (UTC)");
    expect(formatAwardDateText("2026-01-01T00:30:00+13:00")).toBe("January 1, 2026 at 12:30 a.m. (UTC+13:00)");
    expect(formatAwardDateText("2026-03-01T00:00:00-11:00")).toBe("March 1, 2026 at 12:00 a.m. (UTC-11:00)");
    expect(formatAwardDateText("2026-02-28")).toBe("February 28, 2026");
  });

  it.each([
    // Already-readable reviewed wording is the target style, not an input.
    GOLDWATER_DEADLINE,
    "January 29, 2026",
    "Rolling",
    "Rolling; check the official page",
    "TBA",
    "Not listed",
    "Varies by campus",
    "Annually in the fall",
    "",
    "   ",
  ])("returns reviewed wording %s unchanged", (input) => {
    expect(formatAwardDateText(input)).toBe(input);
  });

  it.each([
    // Impossible dates are refused outright: JS would roll these forward.
    "2026-02-30",
    "2026-02-30T09:00:00Z",
    "2025-02-29",
    "2026-13-01",
    "2026-00-10",
    "2026-04-31",
    "2026-03-27T24:00:00Z",
    "2026-03-27T17:60:00Z",
    "2026-03-27T17:00:60Z",
    // Partial or decorated values stay unrecognised rather than guessed.
    "2026-03",
    "2026",
    "26-03-27",
    "2026-3-27",
    "2026-03-27T17:00:00-05:00 (approximate)",
    "before 2026-03-27",
    "2026-03-27/2026-04-30",
    // A fractional MINUTE is a form this helper does not render. Accepting it
    // would silently drop the fraction and show a wrong time of day.
    "2026-03-27T17:00.5Z",
    "2026-03-27T17:00.5",
    "2026-03-27T17:30.25-05:00",
    // A fraction with no digits is not a fraction.
    "2026-03-27T17:00:00.Z",
    // Impossible offsets are refused rather than rendered as fact.
    "2026-03-27T17:00:00+99:99",
    "2026-03-27T17:00:00+05:90",
    "2026-03-27T17:00:00-24:00",
    "2026-03-27T17:00:00+2460",
    // RFC 3339 reads "-00:00" as "offset unknown", which is not UTC and must
    // never be shown as though the zone were known.
    "2026-03-27T17:00:00-00:00",
    "2026-03-27T17:00:00-0000",
  ])("leaves the unsupported value %s untouched", (input) => {
    expect(formatAwardDateText(input)).toBe(input);
  });

  it("still accepts the offsets at the edge of what it validates", () => {
    // +00:00 is a stated zero offset, unlike the "unknown" -00:00.
    expect(formatAwardDateText("2026-03-27T17:00:00+00:00")).toBe("March 27, 2026 at 5:00 p.m. (UTC+00:00)");
    expect(formatAwardDateText("2026-03-27T17:00:00+23:59")).toBe("March 27, 2026 at 5:00 p.m. (UTC+23:59)");
    expect(formatAwardDateText("2026-03-27T17:00:00-11:30")).toBe("March 27, 2026 at 5:00 p.m. (UTC-11:30)");
  });

  it("keeps a reviewer's label and styles only the value after it", () => {
    expect(formatAwardDateText("Interviews: 2026-03-27")).toBe("Interviews: March 27, 2026");
    expect(formatAwardDateText("Notification: 2026-04-15T17:00:00Z"))
      .toBe("Notification: April 15, 2026 at 5:00 p.m. (UTC)");
    // A labelled value that is not a machine timestamp is prose, so it stays.
    expect(formatAwardDateText("Interviews: mid-March")).toBe("Interviews: mid-March");
    expect(formatAwardDateText("Deadline: Last Friday in January"))
      .toBe("Deadline: Last Friday in January");
  });

  it("does not depend on the host time zone", () => {
    const original = process.env.TZ;
    const rendered: string[] = [];
    try {
      for (const zone of ["UTC", "America/Chicago", "Pacific/Kiritimati", "Pacific/Niue"]) {
        process.env.TZ = zone;
        rendered.push(formatAwardDateText(SCREENSHOT_DEADLINE), formatAwardDateText("2026-03-27"));
      }
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
    expect(new Set(rendered)).toEqual(new Set(["March 27, 2026 at 5:00 p.m. (UTC-05:00)", "March 27, 2026"]));
  });
});

describe("formatAwardDateFact", () => {
  it("keeps missing values missing so a caller's fallback still applies", () => {
    expect(formatAwardDateFact(null)).toBeNull();
    expect(formatAwardDateFact(undefined)).toBeNull();
    expect(formatAwardDateFact(null) || "Not listed").toBe("Not listed");
    expect(formatAwardDateFact("") || "Not listed").toBe("Not listed");
  });

  it("formats each item of a list independently", () => {
    expect(formatAwardDateFact([
      "Opens: 2026-01-05",
      GOLDWATER_DEADLINE,
      SCREENSHOT_DEADLINE,
      "Rolling",
    ])).toEqual([
      "Opens: January 5, 2026",
      GOLDWATER_DEADLINE,
      "March 27, 2026 at 5:00 p.m. (UTC-05:00)",
      "Rolling",
    ]);
  });

  it("passes a single value straight through the same rules", () => {
    expect(formatAwardDateFact(SCREENSHOT_DEADLINE)).toBe("March 27, 2026 at 5:00 p.m. (UTC-05:00)");
    expect(formatAwardDateFact(GOLDWATER_DEADLINE)).toBe(GOLDWATER_DEADLINE);
  });

  it("produces text that can wrap, with no unbroken machine token left", () => {
    const formatted = formatAwardDateFact(SCREENSHOT_DEADLINE);
    expect(formatted).not.toContain("T17:00:00");
    // Every run between spaces is short enough to wrap inside a narrow card.
    for (const word of formatted.split(" ")) expect(word.length).toBeLessThanOrEqual(12);
  });
});
