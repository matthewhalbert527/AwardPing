import { describe, expect, it } from "vitest";
import { awardDateZoneSlices, formatAwardDateFact, formatAwardDateText } from "@/lib/award-date-display";

const GOLDWATER_RAW = "Last Friday in January, 5:00 p.m. Central Time";
const GOLDWATER_DISPLAY = "Last Friday in January at 5:00 p.m. (Central Time)";
const SMART_RAW = "5:00 p.m. EST on the first Friday in December 2026";
const SMART_DISPLAY = "First Friday in December 2026 at 5:00 p.m. (EST)";

describe("reviewed recurring deadline presentation", () => {
  it.each([
    [GOLDWATER_RAW, GOLDWATER_DISPLAY],
    ["Second Friday in November at 11:59 pm Eastern Time", "Second Friday in November at 11:59 p.m. (Eastern Time)"],
    ["First Monday in February, 12AM", "First Monday in February at 12:00 a.m."],
    ["Third Wednesday in June at 12PM PT", "Third Wednesday in June at 12:00 p.m. (PT)"],
    ["Fourth Thursday in April, 5PM CDT", "Fourth Thursday in April at 5:00 p.m. (CDT)"],
    ["fifth monday in february, 5PM central time", "fifth monday in february at 5:00 p.m. (central time)"],
    ["Last Sunday in December, 05:00:30.2500PM UTC", "Last Sunday in December at 5:00:30.2500 p.m. (UTC)"],
    ["Last Saturday in July at 5pm -0500", "Last Saturday in July at 5:00 p.m. (UTC-05:00)"],
    ["First Tuesday in September, 9:30AM +05:30", "First Tuesday in September at 9:30 a.m. (UTC+05:30)"],
    ["Last Friday in January at 5PM (Central Time)", GOLDWATER_DISPLAY],
    ["Last Friday in January, 5pm (applicant's time zone)", "Last Friday in January at 5:00 p.m. (applicant's time zone)"],
    ["Second Friday in November at 11:59pm (endorsing institution time zone)", "Second Friday in November at 11:59 p.m. (endorsing institution time zone)"],
    ["Last Friday in January, 5pm in the time zone of the endorsing institution", "Last Friday in January at 5:00 p.m. in the time zone of the endorsing institution"],
  ])("styles the complete rule without resolving its year: %s", (raw, expected) => {
    expect(formatAwardDateText(raw)).toBe(expected);
    expect(formatAwardDateText(expected)).toBe(expected);
    expect(expected).not.toMatch(/\b20\d{2}\b/);
  });

  it.each([
    [`Deadline: ${GOLDWATER_RAW}`, `Deadline: ${GOLDWATER_DISPLAY}`],
    [`Nominations: Campus round: ${GOLDWATER_RAW}`, `Nominations: Campus round: ${GOLDWATER_DISPLAY}`],
    [`${GOLDWATER_RAW}: Application and recommendations due`, `${GOLDWATER_DISPLAY}: Application and recommendations due`],
    ["Second Friday in November at 11:59pm Eastern Time: Applicant deadline (campus deadline varies)", "Second Friday in November at 11:59 p.m. (Eastern Time): Applicant deadline (campus deadline varies)"],
  ])("retains the entire clearly delimited timeline label: %s", (raw, expected) => {
    expect(formatAwardDateText(raw)).toBe(expected);
    expect(formatAwardDateText(expected)).toBe(expected);
  });

  it.each([
    "Last Friday in January",
    "Deadline: Last Friday in January",
    "Last Friday in January: Application deadline",
    "first Friday in December 2026",
    "January 29, 2026",
    "Every January",
    "Annually in the fall",
    "Rolling",
  ])("does not invent a clock, year, or occurrence for %s", (raw) => {
    expect(formatAwardDateText(raw)).toBe(raw);
    expect(awardDateZoneSlices(raw)).toBeNull();
  });

  it.each([
    "Last Friday in January, 0AM Central Time",
    "Last Friday in January, 13pm Central Time",
    "Last Friday in January, 17:05pm Central Time",
    "Last Friday in January, 5:60pm Central Time",
    "Last Friday in January, 5:00:61pm Central Time",
    "Last Friday in January, 5:00.5pm Central Time",
    "Last Friday in January, 5PM UTC-00:00",
    "Last Friday in January, 5PM UTC+24:00",
    "Last Friday in January, 5PM UTC+05:60",
    "Last Friday in January, 5PM Mars Time",
    "Last Friday in January, 5PM Central Time (tentative)",
    "Last Friday in January, 5PM Central Time or later",
    "Last Friday in January, 5PM (dependent on course)",
    "Deadline: Last Friday in January, 5PM Central Time (tentative)",
    "Nominations: Round two: Last Friday in January, 5PM UTC-00:00",
    "Last Friday in January, 5PM Central Time (tentative): Application due",
    "Last Friday in January, 13pm Central Time: 1 July 2026",
    "Last Friday in January, 5PM Central Time (tentative): 1 July 2026",
  ])("does not partially salvage an invalid or qualified complete rule: %s", (raw) => {
    expect(formatAwardDateText(raw)).toBe(raw);
    expect(awardDateZoneSlices(raw)).toBeNull();
  });

  it.each([
    ["Last Friday in March (12:00 p.m. Eastern Time / 11:00 a.m. Central Time): Goldwater Scholars announced", "Last Friday in March (12:00 p.m. Eastern Time / 11:00 a.m. Central Time): Goldwater Scholars announced"],
    ["Last Friday in March (12PM Eastern Time / 11AM Central Time): Goldwater Scholars announced", "Last Friday in March (12:00 p.m. Eastern Time / 11:00 a.m. Central Time): Goldwater Scholars announced"],
    ["Apply by 5PM EST on the first Friday in December 2026", "Apply by 5:00 p.m. EST on the first Friday in December 2026"],
  ])("preserves compound or unrecognized prose apart from existing clock typography: %s", (raw, expected) => {
    expect(formatAwardDateText(raw)).toBe(expected);
    expect(formatAwardDateText(expected)).toBe(expected);
    expect(awardDateZoneSlices(expected)).toBeNull();
  });

  it("formats list entries independently without rewriting the reviewed source array", () => {
    const raw = [GOLDWATER_RAW, "Last Friday in January", "Rolling"];
    const original = [...raw];
    Object.freeze(raw);
    expect(formatAwardDateFact(raw)).toEqual([GOLDWATER_DISPLAY, "Last Friday in January", "Rolling"]);
    expect(raw).toEqual(original);
    expect(formatAwardDateFact(null)).toBeNull();
  });
});

describe("clock-first recurring deadlines with explicitly stated years", () => {
  it.each([
    [SMART_RAW, SMART_DISPLAY],
    ["5PM EST on the first Friday in December 2026", SMART_DISPLAY],
    ["11:59pm on the second Friday in November", "Second Friday in November at 11:59 p.m."],
    ["9:30AM +05:30 on the first Monday in June 2027", "First Monday in June 2027 at 9:30 a.m. (UTC+05:30)"],
    ["12AM (EST) on the last Friday in January 2027", "Last Friday in January 2027 at 12:00 a.m. (EST)"],
    ["5PM EST on the fIrSt friday in december 2026", "FIrSt friday in december 2026 at 5:00 p.m. (EST)"],
    ["first Friday in December 2026 at 5PM EST", "first Friday in December 2026 at 5:00 p.m. (EST)"],
    ["Last Friday in January 2027, 5PM CT", "Last Friday in January 2027 at 5:00 p.m. (CT)"],
    [`Deadline: ${SMART_RAW}`, `Deadline: ${SMART_DISPLAY}`],
    [`${SMART_RAW}: Applications close`, `${SMART_DISPLAY}: Applications close`],
  ])("reorders only a complete statement and retains its actual rule and year: %s", (raw, expected) => {
    expect(formatAwardDateText(raw)).toBe(expected);
    expect(formatAwardDateText(expected)).toBe(expected);
  });

  it.each([
    "5PM Mars Time on the first Friday in December 2026",
    "5PM UTC-00:00 on the first Friday in December 2026",
    "5PM UTC+24:00 on the first Friday in December 2026",
    "0AM EST on the first Friday in December 2026",
    "13pm EST on the first Friday in December 2026",
    "17:05pm EST on the first Friday in December 2026",
    "5:60pm EST on the first Friday in December 2026",
    "5:00.5pm EST on the first Friday in December 2026",
    "5PM EST on the first Friday in December 2026 (tentative)",
    "5PM EST on the first Friday in December 2026 or later",
    "Deadline: 5PM EST on the first Friday in December 2026 (dependent on course)",
    "5PM EST on the first Friday in December 2026 (tentative): 1 July 2026",
    "13pm EST on the first Friday in December 2026: 1 July 2026",
    "5PM Mars Time on the first Friday in December 2026: 1 July 2026",
    "First Friday in December 2026 at 5PM EST (tentative): 1 July 2026",
  ])("does not salvage the clock or a valid tail from an invalid or qualified rule: %s", (raw) => {
    expect(formatAwardDateText(raw)).toBe(raw);
    expect(awardDateZoneSlices(raw)).toBeNull();
  });
});

describe("recurring deadline UTC token boundaries", () => {
  it.each([
    ["Last Friday in January at 5:00 p.m. ", "(UTC-05:00)", ""],
    ["Deadline: Last Friday in January at 5:00 p.m. ", "(UTC)", ""],
    ["Second Friday in November at 11:59 p.m. ", "(UTC+05:30)", ": Application deadline (local campus dates vary)"],
    ["First Friday in December 2026 at 5:00 p.m. ", "(UTC-05:00)", ""],
  ])("groups only the canonical stated UTC token in %s%s%s", (prefix, zone, suffix) => {
    const text = prefix + zone + suffix;
    expect(formatAwardDateText(text)).toBe(text);
    const parts = awardDateZoneSlices(text);
    expect(parts).toEqual({ prefix, zone, suffix });
    expect(parts && parts.prefix + parts.zone + parts.suffix).toBe(text);
  });

  it.each([
    "Last Friday in January, 5:00 p.m. (UTC-05:00)",
    "Last Friday in January at 5PM (UTC-05:00)",
    " Last Friday in January at 5:00 p.m. (UTC-05:00)",
    "Last Friday in January at 5:00 p.m. (UTC-05:00) (tentative)",
    "Last Friday in January at 5:00 p.m. (UTC-00:00)",
    "Last Friday in January at 5:00 p.m. (Central Time)",
    "Last Friday in January at 5:00 p.m. (applicant's time zone)",
    "Last Friday in January (UTC-05:00)",
    "Note: Last Friday in January (UTC-05:00)",
    "Apply before Last Friday in January at 5:00 p.m. (UTC-05:00)",
    "5:00 p.m. (UTC-05:00) on the first Friday in December 2026",
  ])("does not wrap raw, qualified, or unrecognized recurrence text: %s", (raw) => {
    expect(awardDateZoneSlices(raw)).toBeNull();
  });
});
