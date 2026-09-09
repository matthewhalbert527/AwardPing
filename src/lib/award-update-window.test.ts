import { describe, expect, it } from "vitest";
import { awardMatchesUpdateWindow, UPDATE_WINDOW_OPTIONS } from "./award-update-window";

const NOW = Date.parse("2026-09-08T23:59:59.500Z");
const DAY = 24 * 60 * 60 * 1000;
const windows = [
  { value: "day", days: 1 },
  { value: "week", days: 7 },
  { value: "month", days: 30 },
  { value: "3months", days: 90 },
  { value: "6months", days: 180 },
  { value: "year", days: 365 },
] as const;
const at = (timestamp: number) => new Date(timestamp).toISOString();
const recorded = (timestamp = NOW) => ({ changeCount: 1, latestUpdateAt: at(timestamp) });

// These cases exercise malformed runtime metadata without making the normal
// application contract accept strings, booleans, or absent required fields.
function runtimeMatch(award: unknown, window: string, now = NOW): boolean {
  return Reflect.apply(awardMatchesUpdateWindow, undefined, [award, window, now]);
}

describe("recorded award update windows", () => {
  it("offers exactly the six requested windows after All in order", () => {
    expect(UPDATE_WINDOW_OPTIONS.map(({ value, label }) => ({ value, label }))).toEqual([
      { value: "all", label: "All" },
      { value: "day", label: "Last day" },
      { value: "week", label: "Last week" },
      { value: "month", label: "Last month" },
      { value: "3months", label: "Last 3 months" },
      { value: "6months", label: "Last 6 months" },
      { value: "year", label: "Last year" },
    ]);
  });

  it.each(windows)("uses inclusive rolling $days-day boundaries for $value", ({ value, days }) => {
    const cutoff = NOW - days * DAY;
    expect(awardMatchesUpdateWindow(recorded(cutoff), value, NOW), "exact cutoff").toBe(true);
    expect(awardMatchesUpdateWindow(recorded(cutoff + 1), value, NOW), "1 ms inside").toBe(true);
    expect(awardMatchesUpdateWindow(recorded(cutoff - 1), value, NOW), "1 ms too old").toBe(false);
    expect(awardMatchesUpdateWindow(recorded(NOW - 1), value, NOW), "recent recorded update").toBe(true);
    expect(awardMatchesUpdateWindow(recorded(), value, NOW), "exact now").toBe(true);
    expect(awardMatchesUpdateWindow(recorded(NOW + 1), value, NOW), "1 ms in future").toBe(false);
  });

  it("compares timestamp instants rather than their written timezone", () => {
    expect(awardMatchesUpdateWindow({ changeCount: 2, latestUpdateAt: "2026-09-08T18:59:59.500-05:00" }, "day", NOW)).toBe(true);
    expect(awardMatchesUpdateWindow({ changeCount: 2, latestUpdateAt: "2026-09-09T05:29:59.500+05:30" }, "day", NOW)).toBe(true);
  });

  it.each([0, -1, 0.5, null, undefined, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "1", true])(
    "requires an actual positive integer recorded count, not %s",
    changeCount => {
      for (const { value } of windows) {
        expect(runtimeMatch({ changeCount, latestUpdateAt: at(NOW) }, value)).toBe(false);
      }
    },
  );

  it.each([
    null, undefined, "", "not a date", "2026-13-08T23:59:59Z", "2026-09-32T23:59:59Z",
    "2026-09-08T25:59:59Z", "2026-02-30T23:59:59Z", "2026-02-29T23:59:59Z",
    "2026-09-08", "2026-09-08T23:59:59", "2026-09-08T23:59:59-00:00", "2026-09-08T23:59:59-0000",
  ])(
    "requires a valid recorded timestamp, not %s",
    latestUpdateAt => {
      for (const { value } of windows) {
        expect(runtimeMatch({ changeCount: 1, latestUpdateAt }, value)).toBe(false);
      }
    },
  );

  it.each([
    { name: "recentlyUpdated alone", fields: { recentlyUpdated: true } },
    { name: "first published evidence", fields: { firstPublishedCaptureAt: at(NOW) } },
    { name: "last source check", fields: { lastCheckedAt: at(NOW) } },
    { name: "all fallback fields", fields: { recentlyUpdated: true, firstPublishedCaptureAt: at(NOW), lastCheckedAt: at(NOW) } },
  ])("does not substitute $name for an absent latest recorded change", ({ fields }) => {
    const award = { changeCount: 3, latestUpdateAt: null, ...fields };
    for (const { value } of windows) expect(awardMatchesUpdateWindow(award, value, NOW)).toBe(false);
  });

  it("does not let a recent fallback replace an old or future actual change", () => {
    for (const latestUpdateAt of [at(NOW - 366 * DAY), at(NOW + 1)]) {
      const award = { changeCount: 3, latestUpdateAt, recentlyUpdated: true, firstPublishedCaptureAt: at(NOW), lastCheckedAt: at(NOW) };
      for (const { value } of windows) expect(awardMatchesUpdateWindow(award, value, NOW)).toBe(false);
    }
  });

  it("accepts an actual leap-day instant within the chosen rolling window", () => {
    expect(awardMatchesUpdateWindow(
      { changeCount: 1, latestUpdateAt: "2024-02-29T12:00:00Z" },
      "day", Date.parse("2024-03-01T12:00:00Z"),
    )).toBe(true);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])("fails closed for invalid supplied now %s while All needs no clock", now => {
    for (const { value } of windows) expect(awardMatchesUpdateWindow(recorded(), value, now)).toBe(false);
    expect(awardMatchesUpdateWindow(recorded(), "all", now)).toBe(true);
  });

  it("All retains every row regardless of missing, malformed, old, or future update metadata", () => {
    for (const award of [
      {}, { changeCount: null, latestUpdateAt: null },
      { changeCount: 0, latestUpdateAt: "not a date" },
      { changeCount: -1, latestUpdateAt: at(NOW) },
      recorded(NOW - 400 * DAY), recorded(NOW + DAY),
    ]) expect(runtimeMatch(award, "all")).toBe(true);
  });

  it.each(["", "recent", "listed", "All", "days", "unknown", "toString", "constructor"])(
    "fails closed for an unrecognized window %s",
    value => expect(runtimeMatch(recorded(), value)).toBe(false),
  );

  it("does not mutate input metadata or consult the wall clock in place of the supplied instant", () => {
    const award = Object.freeze({ ...recorded(NOW - DAY), recentlyUpdated: false, firstPublishedCaptureAt: "2000-01-01T00:00:00Z" });
    const before = structuredClone(award);
    expect(awardMatchesUpdateWindow(award, "day", NOW)).toBe(true);
    expect(awardMatchesUpdateWindow(award, "day", NOW + 1)).toBe(false);
    expect(award).toEqual(before);
  });
});
