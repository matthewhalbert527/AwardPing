import { describe, expect, it } from "vitest";
import { awardDateZoneSlices, formatAwardDateFact, formatAwardDateText } from "@/lib/award-date-display";

// The exact value the reported screenshot rendered raw.
const SCREENSHOT_DEADLINE = "2026-03-27T17:00:00-05:00";
// Reviewed recurrence and the same house style used by exact calendar dates.
const GOLDWATER_DEADLINE = "Last Friday in January, 5:00 p.m. Central Time";
const GOLDWATER_DISPLAY = "Last Friday in January at 5:00 p.m. (Central Time)";

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
    GOLDWATER_DISPLAY,
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

  it.each([
    ["2026-03-27: Deadline for receipt of all nominations", "March 27, 2026: Deadline for receipt of all nominations"],
    ["2026-04-01: Deadline for nominee to submit Financial Aid Data Sheet (5:00 PM EST)", "April 1, 2026: Deadline for nominee to submit Financial Aid Data Sheet (5:00 p.m. EST)"],
    ["2026-06-01: Deadline for announcement of awards", "June 1, 2026: Deadline for announcement of awards"],
    ["2027-02-02: Truman Application Deadline (11:59 pm, your time zone)", "February 2, 2027: Truman Application Deadline (11:59 p.m., your time zone)"],
    ["2027-02-08: Foundation Confirms Receipt of Materials by", "February 8, 2027: Foundation Confirms Receipt of Materials by"],
    ["2027-02-15: Finalists Notified", "February 15, 2027: Finalists Notified"],
    ["2027-02-18: Finalist Confirmation Due by 9:00 am ET", "February 18, 2027: Finalist Confirmation Due by 9:00 a.m. ET"],
    ["2027-02-19: Finalist Posting", "February 19, 2027: Finalist Posting"],
    ["2027-04-23: Scholar Posting", "April 23, 2027: Scholar Posting"],
  ])("makes the observed date-first timeline item %s readable", (input, expected) => {
    expect(formatAwardDateText(input)).toBe(expected);
  });

  it.each([
    ["2027-03-01 to 2027-04-15", "March 1, 2027 to April 15, 2027"],
    ["2027-03-01 to 2027-04-15: Regional Review Panels", "March 1, 2027 to April 15, 2027: Regional Review Panels"],
    ["2027-05-25 to 2027-05-30: Truman Scholars Leadership Week", "May 25, 2027 to May 30, 2027: Truman Scholars Leadership Week"],
    ["Interviews: 2026-12-31 to 2027-01-02", "Interviews: December 31, 2026 to January 2, 2027"],
    ["2024-02-29 to 2024-03-01: Interviews", "February 29, 2024 to March 1, 2024: Interviews"],
    ["2027-03-01 to 2027-03-01", "March 1, 2027 to March 1, 2027"],
  ])("formats both ends of the complete date range %s", (input, expected) => {
    expect(formatAwardDateText(input)).toBe(expected);
  });

  it.each([
    ["2027-02-02 23:59:00 (applicant's time zone)", "February 2, 2027 at 11:59 p.m. (applicant's time zone)"],
    ["Deadline: 2027-02-02 23:59:00 (applicant's time zone)", "Deadline: February 2, 2027 at 11:59 p.m. (applicant's time zone)"],
    ["2027-02-02T00:01:00.250 (applicant's time zone)", "February 2, 2027 at 12:01:00.250 a.m. (applicant's time zone)"],
  ])("preserves the explicit applicant-local qualifier of %s without inventing a zone", (input, expected) => {
    expect(formatAwardDateText(input)).toBe(expected);
  });

  it.each([
    "2027-02-30: Finalists Notified",
    "2027-02-30: 2027-03-01",
    "2027-02: Finalists Notified",
    "2027-02-02:",
    "2027-02-02:   ",
    "2027-02-02:Finalists Notified",
    "2027-02-02 (approximate): Finalists Notified",
    "2027-02-30 to 2027-03-01",
    "2027-03-01 to 2027-04-31: Interviews",
    "Interviews: 2027-03-01 to 2027-04-31",
    "2027-04-15 to 2027-03-01: Interviews",
    "2027-03-01 to TBA: Interviews",
    "2027-03-01 to 2027-04: Interviews",
    "2027-03-01 to 2027-04-15 to 2027-04-30: Interviews",
    "2027-03-01 through 2027-04-15: Interviews",
    "2027-03-01 to 2027-04-15 (approximate): Interviews",
    "2027-03-01T17:00:00Z to 2027-04-15T17:00:00Z: Interviews",
    "Interviews: 2027-03-01 to unavailable: 2027-04-15",
    "2027-02-30 23:59:00 (applicant's time zone)",
    "2027-02-02 24:00:00 (applicant's time zone)",
    "2027-02-02 23:59.5 (applicant's time zone)",
    "2027-02-02 23:59:00Z (applicant's time zone)",
    "2027-02-02 23:59:00-05:00 (applicant's time zone)",
    "2027-02-02 (applicant's time zone)",
    "2027-02-02 23:59:00 (approximate)",
    "2027-02-02 23:59:00 (Central Time)",
    "2027-02-02 23:59:00 (applicant's time zone) or later",
    "Apply before 2027-02-02: Final deadline",
  ])("never partially reformats the invalid or unsupported labelled value %s", (input) => {
    expect(formatAwardDateText(input)).toBe(input);
  });

  it("retains exact label wording and does not rewrite dates embedded in it", () => {
    expect(formatAwardDateText("Interviews: Round two: 2027-03-01"))
      .toBe("Interviews: Round two: March 1, 2027");
    expect(formatAwardDateText("2027-03-01: Compared with 2026-03-01: exact historical wording"))
      .toBe("March 1, 2027: Compared with 2026-03-01: exact historical wording");
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

describe("reviewed clock typography", () => {
  it.each([
    ["October 1, 2026 at 11:59PM PT", "October 1, 2026 at 11:59 p.m. (PT)"],
    ["October 6, 2026 at 1:00 PM PT", "October 6, 2026 at 1:00 p.m. (PT)"],
    ["October 6, 2026 at 5pm Eastern Time", "October 6, 2026 at 5:00 p.m. (Eastern Time)"],
    ["7 October 2026, 11:59 PM Eastern Time", "October 7, 2026 at 11:59 p.m. (Eastern Time)"],
    ["March 4, 2026 at 11:59 p.m. MST", "March 4, 2026 at 11:59 p.m. (MST)"],
    ["September 8, 2026 at 5:00 p.m. Eastern", "September 8, 2026 at 5:00 p.m. (Eastern)"],
    ["September 9, 2026 at 3:00 PM EDT", "September 9, 2026 at 3:00 p.m. (EDT)"],
    ["October 1, 2026 at 11:59PM", "October 1, 2026 at 11:59 p.m."],
    ["October 1, 2026 at 12AM GMT", "October 1, 2026 at 12:00 a.m. (GMT)"],
    ["October 1, 2026 at 12PM UTC", "October 1, 2026 at 12:00 p.m. (UTC)"],
    ["October 1, 2026 at 05:00:30.2500PM PT", "October 1, 2026 at 5:00:30.2500 p.m. (PT)"],
    ["October 1, 2026 at 5:00PM +0530", "October 1, 2026 at 5:00 p.m. (UTC+05:30)"],
    ["October 1, 2026 at 5:00PM (UTC-05:00)", "October 1, 2026 at 5:00 p.m. (UTC-05:00)"],
    ["February 2, 2027 at 11:59PM (applicant's time zone)", "February 2, 2027 at 11:59 p.m. (applicant's time zone)"],
    ["29 September 2026 at 5:00pm in the time zone of the endorsing institution", "September 29, 2026 at 5:00 p.m. in the time zone of the endorsing institution"],
    ["1 October 2026 at 5:00pm (endorsing institution time zone): Deadline for endorsing institution to submit endorsed application and recommendations", "October 1, 2026 at 5:00 p.m. (endorsing institution time zone): Deadline for endorsing institution to submit endorsed application and recommendations"],
    ["Deadline: October 1, 2026 at 11:59PM PT", "Deadline: October 1, 2026 at 11:59 p.m. (PT)"],
    ["Second Friday in November at 11:59 pm Eastern Time", "Second Friday in November at 11:59 p.m. (Eastern Time)"],
    ["US citizens resident in the USA round — Wednesday 14 October 2026 at 11:59 pm GMT: Application deadline", "US citizens resident in the USA round — Wednesday 14 October 2026 at 11:59 p.m. GMT: Application deadline"],
    ["All other eligible applicants round — Tuesday 8 December 2026 or Wednesday 6 January 2027 at 11:59 pm GMT (dependent on course): Application deadline", "All other eligible applicants round — Tuesday 8 December 2026 or Wednesday 6 January 2027 at 11:59 p.m. GMT (dependent on course): Application deadline"],
    ["Finalists: (5:00 PM EST); interviews: (9 AM, your time zone)", "Finalists: (5:00 p.m. EST); interviews: (9:00 a.m., your time zone)"],
  ])("standardizes %s without changing date, zone, precision or qualification", (input, expected) => {
    expect(formatAwardDateText(input)).toBe(expected);
    expect(formatAwardDateText(expected)).toBe(expected);
  });

  it.each([
    "13pm", "0AM", "17:05pm", "5:60pm", "5:00:61pm", "5:00.5pm",
    "5:00:00.pm", "5pm/6pm", "15pm", "5:00PMish", "code5pm", "5PM-6PM",
    "October 1, 2026 at 17:05pm PT", "February 30, 2026 at 5PM PT",
    "29 February 2025, 5PM PT", "October 1, 2026 at 5PM UTC-00:00",
    "October 1, 2026 at 5PM UTC+99:99", "October 1, 2026 at 5PM PT (tentative)",
    "2027-02-30: Deadline at 5PM", "Deadline: 2027-02-30 at 5PM",
    "Deadline: February 30, 2026 at 5PM PT",
    "Interviews: 29 February 2025, 5PM PT",
    "Deadline: October 1, 2026 at 5PM UTC-00:00",
    "Deadline: October 1, 2026 at 5PM UTC+99:99",
    "Deadline: October 1, 2026 at 5PM PT (tentative)",
    "Interviews: Round two: February 30, 2026 at 5PM PT",
  ])("does not partially salvage malformed or unsupported statement %s", (value) => {
    expect(formatAwardDateText(value)).toBe(value);
  });

  it("keeps compound clock wording intact while styling a complete recurring deadline", () => {
    const compound = "Last Friday in March (12:00 p.m. Eastern Time / 11:00 a.m. Central Time): Goldwater Scholars announced";
    expect(formatAwardDateText(compound)).toBe(compound);
    expect(formatAwardDateText(GOLDWATER_DEADLINE)).toBe(GOLDWATER_DISPLAY);
    expect(formatAwardDateText("5:00 p.m. EST on the first Friday in December 2026"))
      .toBe("First Friday in December 2026 at 5:00 p.m. (EST)");
  });

  it("is equally deterministic for written and machine times in different host zones", () => {
    const original = process.env.TZ;
    try {
      for (const zone of ["UTC", "America/Chicago", "Pacific/Kiritimati", "Pacific/Niue"]) {
        process.env.TZ = zone;
        expect(formatAwardDateText("October 1, 2026 at 11:59PM PT"))
          .toBe("October 1, 2026 at 11:59 p.m. (PT)");
        expect(formatAwardDateText(SCREENSHOT_DEADLINE))
          .toBe("March 27, 2026 at 5:00 p.m. (UTC-05:00)");
      }
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
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
      GOLDWATER_DISPLAY,
      "March 27, 2026 at 5:00 p.m. (UTC-05:00)",
      "Rolling",
    ]);
  });

  it("passes a single value straight through the same rules", () => {
    expect(formatAwardDateFact(SCREENSHOT_DEADLINE)).toBe("March 27, 2026 at 5:00 p.m. (UTC-05:00)");
    expect(formatAwardDateFact(GOLDWATER_DEADLINE)).toBe(GOLDWATER_DISPLAY);
  });

  it("produces text that can wrap, with no unbroken machine token left", () => {
    const formatted = formatAwardDateFact(SCREENSHOT_DEADLINE);
    expect(formatted).not.toContain("T17:00:00");
    // Every run between spaces is short enough to wrap inside a narrow card.
    for (const word of formatted.split(" ")) expect(word.length).toBeLessThanOrEqual(12);
  });
});

describe("awardDateZoneSlices", () => {
  const date = "March 27, 2026 at 5:00 p.m.";

  it("exports the display-only zone slicing helper", () => {
    expect(awardDateZoneSlices).toBeTypeOf("function");
  });

  it.each([
    "(UTC-05:00)", // The exact UTC token in the 25-page public date audit.
    "(UTC)",
    "(UTC+00:00)",
    "(UTC+05:30)",
    "(UTC+23:59)",
    "(UTC-11:30)",
    "(UTC-00:01)",
  ])("groups only the terminal canonical %s without changing ASCII text", (zone) => {
    const value = `${date} ${zone}`;
    const result = awardDateZoneSlices(value);
    expect(result).toEqual({ prefix: `${date} `, zone, suffix: "" });
    expect(result && result.prefix + result.zone + result.suffix).toBe(value);
  });

  it.each([
    [`Notification: ${date} `, "(UTC)", ""],
    [`Interviews: Round two: ${date} `, "(UTC+05:30)", ""],
    [`${date} `, "(UTC-05:00)", ": Deadline for nominations"],
    [`${date} `, "(UTC-05:00)", ": Compared with (UTC+99:99); quoted (UTC) stays literal"],
    [`${date} `, "(UTC-05:00)", `: Previous wording: ${date} (UTC+05:30)`],
    [`Quoted (UTC+99:99): ${date} `, "(UTC)", ""],
    ["March 27, 2026 at 5:00:30.2500 p.m. ", "(UTC)", ""],
    ["March 27, 2026 at 5:00:00.123456789012345678 p.m. ", "(UTC+05:30)", ""],
    ["February 29, 2024 at 12:00 a.m. ", "(UTC)", ": Leap-day observation"],
  ])("preserves the exact recognized segment boundary in %s%s%s", (prefix, zone, suffix) => {
    const value = prefix + zone + suffix;
    const result = awardDateZoneSlices(value);
    expect(result).toEqual({ prefix, zone, suffix });
    expect(result && result.prefix + result.zone + result.suffix).toBe(value);
    expect(awardDateZoneSlices(value)).toEqual(result);
  });

  it.each([
    ` \t${date} (UTC-05:00)\n `,
    `Notification:  ${date} (UTC)`,
  ])("leaves noncanonical whitespace ungrouped in %s", (value) => {
    // Slicing is not a second formatter: the caller must preserve the entire
    // original value whenever canonical descriptor reassembly would change it.
    expect(formatAwardDateText(value)).not.toBe(value);
    expect(awardDateZoneSlices(value)).toBeNull();
  });

  it.each([
    "", "   ", "Not listed", "Rolling", "non-finalist decisions issued",
    "Application outcome", "Rolling (UTC-05:00)", "Unknown (UTC)",
    "Last Friday in January, 5:00 p.m. (UTC-05:00)",
    GOLDWATER_DEADLINE,
    "Last Friday in March (12:00 p.m. Eastern Time / 11:00 a.m. Central Time): Goldwater Scholars announced",
    "5:00 p.m. EST on the first Friday in December 2026",
    "February 2, 2027 at 11:59 p.m. (applicant's time zone)",
    "October 1, 2026 at 5:00 p.m. (endorsing institution time zone)",
    `${date} (Eastern Time)`, `${date} (PT)`, `${date} (GMT)`, `${date} (utc)`,
    `${date} (UTC-00:00)`, `${date} (UTC+24:00)`, `${date} (UTC+05:60)`,
    `${date} (UTC-0000)`, `${date} (UTC+0530)`, `${date} (UTC+5:30)`,
    `${date} (UTC-05:00) (tentative)`, `${date} (UTC-05:00) or later`,
    `${date} (UTC-05:00) (dependent on course)`,
    `Apply before ${date} (UTC-05:00)`,
    `Deadline: ${date} (UTC-05:00) (tentative)`,
    `Deadline: ${date} (UTC-00:00)`,
    `February 30, 2026 at 5:00 p.m. (UTC): ${date} (UTC)`,
    `2026-02-30: ${date} (UTC)`,
    `2026-03-27 to unavailable: ${date} (UTC)`,
    "February 30, 2026 at 5:00 p.m. (UTC)",
    "February 29, 2025 at 5:00 p.m. (UTC)",
    "March 27, 2026 at 13:00 p.m. (UTC)",
    "March 27, 2026 at 5:60 p.m. (UTC)",
    "March 27, 2026 at 5:00:60 p.m. (UTC)",
    "March 27, 2026 at 5:00.5 p.m. (UTC)",
    "March 27, 2026 at 5:00 PM (UTC)",
    "27 March 2026, 5:00 p.m. (UTC)",
    "March 27, 2026 at 05:00 p.m. (UTC)",
    "March 27, 2026 at 5:00:00.000 p.m. (UTC)",
    "2026-03-27T17:00:00-05:00",
    "March 27, 2026 (UTC-05:00)",
    `${date} (UTC-05:00):`, `${date} (UTC-05:00):   `,
  ])("does not grant date grouping to unsupported text %s", (value) => {
    expect(awardDateZoneSlices(value)).toBeNull();
  });
});

describe("complete written calendar dates", () => {
  it.each([
    // The only residual date-only style difference in the saved public audit.
    ["1 July 2026", "July 1, 2026"],
    ["01 July 2026", "July 1, 2026"],
    ["July 01, 2026", "July 1, 2026"],
    ["April 8, 2026", "April 8, 2026"],
    ["29 February 2000", "February 29, 2000"],
    ["Opening date: 1 July 2026", "Opening date: July 1, 2026"],
    ["Interviews: Round two: 1 July 2026", "Interviews: Round two: July 1, 2026"],
    ["1 July 2026: Applications open", "July 1, 2026: Applications open"],
    ["1 July 2026: Compared with 02 July 2026: exact historical wording", "July 1, 2026: Compared with 02 July 2026: exact historical wording"],
    ["July 1, 2026: Compared with 02 July 2026: exact historical wording", "July 1, 2026: Compared with 02 July 2026: exact historical wording"],
    ["1 July 2026: Quoted (UTC-05:00) remains prose", "July 1, 2026: Quoted (UTC-05:00) remains prose"],
  ])("formats only the complete calendar segment of %s", (value, expected) => {
    expect(formatAwardDateText(value)).toBe(expected);
    expect(formatAwardDateText(expected)).toBe(expected);
    // A calendar date never invents a clock, zone, or UTC wrapping target.
    expect(awardDateZoneSlices(value)).toBeNull();
    expect(awardDateZoneSlices(expected)).toBeNull();
  });

  it.each([
    "29 February 1900", "31 June 2026", "0 July 2026", "1 Notamonth 2026",
    "July 2026", "1 July", "October 30", "First Tuesday in September",
    "1 July 2026 (tentative)", "1 July 2026 or later",
    "Before 1 July 2026", "Opening date: 1 July 2026 (tentative)",
    "1 July 2026 to 4 July 2026",
    "March 1, 2027 to April 15, 2027: Regional Review Panels",
    "Interviews: 1 July 2026 to 4 July 2026",
    // Invalid, qualified, or ranged leading dates must never fall through to
    // the label-tail branch and style only their later, valid date.
    "31 June 2026: 1 July 2026",
    "June 31, 2026: 1 July 2026",
    "1 July 2026 (tentative): 2 July 2026",
    "1 July 2026 to 4 July 2026: 2 July 2026",
    // Written date-first descriptions follow the existing ISO-led rule:
    // they are not a second labelled date to salvage or normalize.
    "June 1, 2028: 2026-03-27",
    "1 May 2026 Symposium: 2026-06-01",
    "1 July 2026:", "1 July 2026:   ", "1 July 2026:Applications open",
  ])("keeps unsupported or incomplete written date statement %s literal", (value) => {
    expect(formatAwardDateText(value)).toBe(value);
    expect(awardDateZoneSlices(value)).toBeNull();
  });

  it.each([
    ["7 October 2026, 11:59 PM Eastern Time", "October 7, 2026 at 11:59 p.m. (Eastern Time)"],
    ["1 October 2026 at 5:00pm (endorsing institution time zone): Endorsements due", "October 1, 2026 at 5:00 p.m. (endorsing institution time zone): Endorsements due"],
    ["2026-03-27T17:00:00.2500-05:00", "March 27, 2026 at 5:00:00.2500 p.m. (UTC-05:00)"],
    ["February 2, 2027 at 11:59 p.m. (applicant's time zone)", "February 2, 2027 at 11:59 p.m. (applicant's time zone)"],
  ])("preserves the established timed-date output for %s", (value, expected) => {
    expect(formatAwardDateText(value)).toBe(expected);
    expect(formatAwardDateText(expected)).toBe(expected);
  });
});
