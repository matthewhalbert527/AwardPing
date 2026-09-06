import { describe, expect, it } from "vitest";
import {
  AWARDPING_TIME_ZONE,
  centralDateKey,
  describeDetectedAt,
  describeTimestamp,
  formatCentralDate,
  formatCentralDateTime,
  previousCentralDateKey,
} from "@/lib/time-zone";

describe("Central Time formatting", () => {
  it("uses the AwardPing Central timezone explicitly", () => {
    expect(AWARDPING_TIME_ZONE).toBe("America/Chicago");
  });

  it("formats summer timestamps in Central daylight time", () => {
    expect(
      formatCentralDateTime("2026-07-08T15:30:00.000Z", {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }),
    ).toBe("Jul 8, 2026, 10:30 AM");
  });

  it("formats winter timestamps in Central standard time", () => {
    expect(
      formatCentralDateTime("2026-01-08T15:30:00.000Z", {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }),
    ).toBe("Jan 8, 2026, 9:30 AM");
  });

  it("uses the Central calendar day for date-only output", () => {
    expect(formatCentralDate("2026-07-08T04:30:00.000Z")).toBe("Jul 7, 2026");
    expect(centralDateKey("2026-07-08T04:30:00.000Z")).toBe("2026-07-07");
  });
});

describe("describeDetectedAt", () => {
  // Sep 5, 2026, 9:00 AM CDT.
  const now = new Date("2026-09-05T14:00:00.000Z");
  const at = (value: string) => describeDetectedAt(value, now);

  it("floors relative labels at each threshold and clamps future skew to Just now", () => {
    expect(at("2026-09-05T14:05:00.000Z").compact).toBe("Just now");
    expect(at("2026-09-05T13:59:01.000Z").compact).toBe("Just now");
    expect(at("2026-09-05T13:59:00.000Z").compact).toBe("1m ago");
    expect(at("2026-09-05T13:00:01.000Z").compact).toBe("59m ago");
    expect(at("2026-09-05T13:00:00.000Z").compact).toBe("1h ago");
    expect(at("2026-09-04T14:00:01.000Z").compact).toBe("23h ago");
    expect(at("2026-09-04T14:00:00.000Z").compact).toBe("1d ago");
    expect(at("2026-08-22T14:00:00.000Z").compact).toBe("14d ago");
    expect(at("2026-08-21T14:00:01.000Z").compact).toBe("14d ago");
    expect(at("2026-08-21T14:00:00.000Z").compact).toBe("Aug 21");
  });

  it("drops the year only inside the current Central year", () => {
    const january = new Date("2027-01-10T15:00:00.000Z");
    expect(describeDetectedAt("2026-12-20T15:00:00.000Z", january).compact).toBe("Dec 20, 2026");
    expect(describeDetectedAt("2027-01-01T15:00:00.000Z", january).compact).toBe("9d ago");
    // 05:30Z on December 1 is still November 30 at 11:30 PM Central.
    expect(describeDetectedAt("2026-12-01T05:30:00.000Z", january).compact).toBe("Nov 30, 2026");
    expect(
      describeDetectedAt("2026-12-01T05:30:00.000Z", new Date("2026-12-31T05:30:00.000Z")).compact,
    ).toBe("Nov 30");
  });

  it("normalizes every valid input to canonical millisecond ISO for the dateTime attribute", () => {
    // The database stores microseconds; HTML datetime wants milliseconds.
    expect(describeTimestamp("2026-07-16T18:00:00.123456Z").dateTime).toBe("2026-07-16T18:00:00.123Z");
    expect(describeTimestamp("2026-07-16T18:00:00.123456+00:00").dateTime).toBe("2026-07-16T18:00:00.123Z");
    expect(describeTimestamp("2026-07-16T13:00:00-05:00").dateTime).toBe("2026-07-16T18:00:00.000Z");
    // A parseable non-ISO string is never echoed verbatim.
    expect(describeTimestamp("Jul 16 2026 18:00:00 GMT+0000").dateTime).toBe("2026-07-16T18:00:00.000Z");
    expect(describeTimestamp(new Date("2026-07-16T18:00:00.123Z")).dateTime).toBe("2026-07-16T18:00:00.123Z");
    expect(describeTimestamp(Date.UTC(2026, 6, 16, 18)).dateTime).toBe("2026-07-16T18:00:00.000Z");
    expect(describeDetectedAt("2026-07-16T18:00:00.123456Z", now).dateTime).toBe("2026-07-16T18:00:00.123Z");
  });

  it("reports the full Central timestamp with zone, the canonical dateTime and the day key", () => {
    const described = at("2026-09-05T12:00:00.000Z");

    expect(described.dateTime).toBe("2026-09-05T12:00:00.000Z");
    expect(described.full).toBe(formatCentralDateTime("2026-09-05T12:00:00.000Z"));
    expect(described.full).toMatch(/^Sep 5, 2026, 7:00.AM CDT$/);
    expect(described.dateKey).toBe("2026-09-05");
    expect(described.compact).toBe("2h ago");
    expect(describeDetectedAt("2026-01-08T15:30:00.000Z", now).full).toMatch(/^Jan 8, 2026, 9:30.AM CST$/);
    expect(describeDetectedAt(new Date("2026-09-05T12:00:00.000Z"), now).dateTime).toBe("2026-09-05T12:00:00.000Z");
  });

  it("marks invalid values unavailable instead of throwing", () => {
    for (const value of ["", "not a date", null, undefined, "2026-13-45"]) {
      expect(describeDetectedAt(value, now), String(value)).toEqual({
        dateTime: null,
        full: "Date unavailable",
        dateKey: "",
        compact: "Date unavailable",
      });
    }
    // Without a usable `now` the label falls back to a dated absolute value.
    expect(describeDetectedAt("2026-09-05T12:00:00.000Z", "bad now").compact).toBe("Sep 5, 2026");
    expect(describeTimestamp("nope")).toEqual({ dateTime: null, full: "Date unavailable", dateKey: "" });
  });

  it("stays truthful across DST transitions", () => {
    // Spring forward: 1:59 AM CST to 3:00 AM CDT is one real minute.
    const springNow = new Date("2026-03-08T08:00:00.000Z");
    expect(describeDetectedAt("2026-03-08T07:59:00.000Z", springNow).compact).toBe("1m ago");
    expect(describeTimestamp("2026-03-08T07:59:00.000Z").full).toMatch(/1:59.AM CST$/);
    expect(describeTimestamp("2026-03-08T08:00:00.000Z").full).toMatch(/3:00.AM CDT$/);
    // Fall back: 1:30 AM CDT and 1:30 AM CST are an hour apart.
    const fallNow = new Date("2026-11-01T07:30:00.000Z");
    expect(describeDetectedAt("2026-11-01T06:30:00.000Z", fallNow).compact).toBe("1h ago");
    expect(describeTimestamp("2026-11-01T06:30:00.000Z").full).toMatch(/1:30.AM CDT$/);
    expect(describeTimestamp("2026-11-01T07:30:00.000Z").full).toMatch(/1:30.AM CST$/);
  });
});

describe("previousCentralDateKey", () => {
  it("steps back one calendar day across DST, month, year and leap boundaries", () => {
    expect(previousCentralDateKey("2026-03-09")).toBe("2026-03-08");
    expect(previousCentralDateKey("2026-11-02")).toBe("2026-11-01");
    expect(previousCentralDateKey("2026-03-01")).toBe("2026-02-28");
    expect(previousCentralDateKey("2028-03-01")).toBe("2028-02-29");
    expect(previousCentralDateKey("2027-01-01")).toBe("2026-12-31");
    expect(previousCentralDateKey("")).toBe("");
    expect(previousCentralDateKey("2026-3-9")).toBe("");
  });

  it("agrees with the Central calendar where a 24-hour subtraction does not", () => {
    // 00:30 CDT on March 9: subtracting 24 hours lands on March 7 in Central.
    const springNow = new Date("2026-03-09T05:30:00.000Z");
    expect(centralDateKey(springNow)).toBe("2026-03-09");
    expect(centralDateKey(new Date(springNow.getTime() - 86_400_000))).toBe("2026-03-07");
    expect(previousCentralDateKey(centralDateKey(springNow))).toBe("2026-03-08");
    // 11:30 PM CST on November 1: subtracting 24 hours stays on November 1.
    const fallNow = new Date("2026-11-02T05:30:00.000Z");
    expect(centralDateKey(fallNow)).toBe("2026-11-01");
    expect(centralDateKey(new Date(fallNow.getTime() - 86_400_000))).toBe("2026-11-01");
    expect(previousCentralDateKey(centralDateKey(fallNow))).toBe("2026-10-31");
  });
});
