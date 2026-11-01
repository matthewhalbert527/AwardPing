import { describe, expect, it } from "vitest";
import { presentAwardCardDeadline } from "@/lib/award-card-deadline";
import { presentAwardDeadlines, type AwardDeadlinePresentation } from "@/lib/award-page-presentation";

type Entry = AwardDeadlinePresentation["entries"][number];
const entry = (value: string, label = "Deadline", status: Entry["status"] = "listed"): Entry => ({ label, value, status });

describe("award card deadline visual lines", () => {
  it("splits Goldwater's explicit nomination scope without inventing a year or day", () => {
    expect(presentAwardCardDeadline(entry("National nomination: Last Friday in January at 5:00 p.m. (Central Time)"))).toEqual({
      label: "National nomination", date: "Last Friday in January", time: "5:00 p.m. (Central Time)", closedCycle: false,
    });
  });

  it("keeps Beinecke's exact institutional year, date and stated zone", () => {
    expect(presentAwardCardDeadline(entry("2027 institutional nomination: March 26, 2027 at 5:00 p.m. (Eastern Time)"))).toEqual({
      label: "2027 institutional nomination", date: "March 26, 2027", time: "5:00 p.m. (Eastern Time)", closedCycle: false,
    });
  });

  it("retains both Gilman cycle labels and only the explicitly closed cycle", () => {
    const spring = entry("February 25, 2027 at 11:59 p.m. (Pacific Time)", "Application deadline — Spring 2027 cycle");
    const fall = entry("October 1, 2026 at 11:59 p.m. (Pacific Time) — closed cycle", "Application deadline — Fall 2026 cycle", "past");
    expect([spring, fall].map(presentAwardCardDeadline)).toEqual([
      { label: "Application · Spring 2027", date: "February 25, 2027", time: "11:59 p.m. (Pacific Time)", closedCycle: false },
      { label: "Application · Fall 2026", date: "October 1, 2026", time: "11:59 p.m. (Pacific Time)", closedCycle: true },
    ]);
  });

  it("preserves Boren's two tracks without making up either clock", () => {
    const undergraduate = entry("January 27, 2027", "Application deadline — Undergraduate Scholarships");
    const graduate = entry("January 20, 2027", "Application deadline — Graduate Fellowships");
    expect([undergraduate, graduate].map(presentAwardCardDeadline)).toEqual([
      { label: "Application · Undergraduate Scholarships", date: undergraduate.value, time: null, closedCycle: false },
      { label: "Application · Graduate Fellowships", date: graduate.value, time: null, closedCycle: false },
    ]);
  });

  it("lifts an explicit application cycle from a generic label", () => {
    expect(presentAwardCardDeadline(entry("Application deadline — Spring 2027 cycle: February 25, 2027 at 11:59 p.m. (Pacific Time)", "Application deadline"))).toEqual({
      label: "Application · Spring 2027", date: "February 25, 2027", time: "11:59 p.m. (Pacific Time)", closedCycle: false,
    });
  });

  it("does not discard or replace an already-specific label with another scope", () => {
    const value = "National nomination: March 26, 2027 at 5:00 p.m. (Eastern Time)";
    const label = "Application deadline — Graduate Fellowships";
    expect(presentAwardCardDeadline(entry(value, label))).toEqual({ label: "Application · Graduate Fellowships", date: value, time: null, closedCycle: false });
  });

  it("does not repeat an identical existing scope label", () => {
    expect(presentAwardCardDeadline(entry("National nomination: January 27, 2027", "National nomination"))).toEqual({
      label: "National nomination", date: "January 27, 2027", time: null, closedCycle: false,
    });
  });

  it.each([
    ["Application deadline", "Application"],
    ["Application deadline — Spring 2027 cycle", "Application · Spring 2027"],
    ["Application deadline – Summer 2027 cycle", "Application · Summer 2027"],
    ["Application deadline -- Fall 2026 cycle", "Application · Fall 2026"],
    ["Application deadline — Autumn 2027 cycle", "Application · Autumn 2027"],
    ["Application deadline — Winter 2028 cycle", "Application · Winter 2028"],
    ["Application deadline — Graduate Fellowships", "Application · Graduate Fellowships"],
    ["National nomination deadline", "National nomination"],
    ["2027 institutional nomination deadline", "2027 institutional nomination"],
  ])("shortens redundant category wording in %s without changing scope", (label, expected) => {
    expect(presentAwardCardDeadline(entry("January 27, 2027 at 5:00 p.m. (UTC)", label))).toEqual({
      label: expected, date: "January 27, 2027", time: "5:00 p.m. (UTC)", closedCycle: false,
    });
  });

  it.each([
    "Application deadline for graduate applicants",
    "Applications deadline — Spring 2027 cycle",
    "Application deadline — Spring 2027 cycle (dependent on course)",
    "Application deadline — Spring 2027 cycle if selected",
    "Application deadline — Tentative Spring 2027 cycle",
    "Application deadline — Spring 2027 cycle — campus nomination",
    "Application deadline — Spring 2027 or Summer 2027 cycle",
    "Application deadline: Spring 2027 cycle",
    "National nomination deadline if endorsed",
    "National nomination deadline (institution time zone)",
    "Other nomination deadline",
  ])("retains every substantive qualifier in an unrecognized label: %s", (label) => {
    const result = presentAwardCardDeadline(entry("January 27, 2027", label));
    expect(result.label).toBe(label);
    expect(result.date).toBe("January 27, 2027");
  });

  it.each([
    "Not listed", "TBA", "Unconfirmed", "Rolling; check the official page", "", "January 2027", "January 27", "2027-01",
    "February 30, 2027 at 5:00 p.m. (Eastern Time)",
    "2027-02-30 at 5:00 p.m. (UTC)",
    "January 27, 2027 at 13:00 p.m. (Eastern Time)",
    "January 27, 2027 at 5:60 p.m. (Eastern Time)",
    "January 27, 2027 at 5:00:60 p.m. (Eastern Time)",
    "January 27, 2027 at 5:00.5 p.m. (Eastern Time)",
    "January 27, 2027 at 5:00 p.m. (Atlantis Time)",
    "January 27, 2027 at 5:00 p.m. (UTC-00:00)",
    "January 27, 2027 at 5:00 p.m. (UTC+24:00)",
    "January 27, 2027 at 5:00 p.m. (UTC+05:60)",
    "Usually January 27, 2027 at 5:00 p.m. (Eastern Time)",
    "January 27, 2027 or later at 5:00 p.m. (Eastern Time)",
    "January 27, 2027 at 5:00 p.m. (Eastern Time) (tentative)",
    "January 27, 2027 at 5:00 p.m. (Eastern Time) unless extended",
    "January 27, 2027 at 5:00 p.m. or 6:00 p.m. (Eastern Time)",
    "January 20, 2027 to January 27, 2027 at 5:00 p.m. (Eastern Time)",
    "January 20, 2027 at 5:00 p.m. (Eastern Time) to January 27, 2027 at 5:00 p.m. (Eastern Time)",
    "January 27, 2027 or February 2027 at 5:00 p.m. (Eastern Time)",
    "National nomination: January 27, 2027 at 5:00 p.m. (Eastern Time) (dependent on institution)",
    "Application deadline if selected: January 27, 2027 at 5:00 p.m. (Eastern Time)",
    "Interviews: January 27, 2027 at 5:00 p.m. (Eastern Time)",
    "January 27, 2027 at 5:00 p.m. (Eastern Time): interview results",
    "January 27, 2027\nat 5:00 p.m. (Eastern Time)",
  ])("retains every byte of unsupported or qualified wording: %s", (value) => {
    expect(presentAwardCardDeadline(entry(value))).toEqual({ label: "Deadline", date: value, time: null, closedCycle: false });
  });

  it.each([
    ["(UTC-05:00)", "5:00 p.m. (UTC-05:00)"],
    ["(UTC+05:30)", "5:00 p.m. (UTC+05:30)"],
    ["(UTC)", "5:00 p.m. (UTC)"],
    ["GMT", "5:00 p.m. GMT"],
    ["(PDT)", "5:00 p.m. (PDT)"],
    ["(applicant's time zone)", "5:00 p.m. (applicant's time zone)"],
    ["(endorsing institution time zone)", "5:00 p.m. (endorsing institution time zone)"],
  ])("preserves the exact explicit zone %s", (zone, time) => {
    expect(presentAwardCardDeadline(entry(`January 27, 2027 at 5:00 p.m. ${zone}`))).toEqual({
      label: "Deadline", date: "January 27, 2027", time, closedCycle: false,
    });
  });

  it("never adds a zone to a clock that did not state one", () => {
    expect(presentAwardCardDeadline(entry("January 27, 2027 at 5:00 p.m."))).toEqual({
      label: "Deadline", date: "January 27, 2027", time: "5:00 p.m.", closedCycle: false,
    });
  });

  it("keeps exact fractional seconds and existing clock spacing", () => {
    expect(presentAwardCardDeadline(entry("Last Friday in January 2027 at 5:00:00.123456789012345678 p.m.(Central Time)"))).toEqual({
      label: "Deadline", date: "Last Friday in January 2027", time: "5:00:00.123456789012345678 p.m.(Central Time)", closedCycle: false,
    });
  });

  it.each(["--", "—"])("recognizes only an explicit terminal closed cycle using %s", (separator) => {
    expect(presentAwardCardDeadline(entry(`October 1, 2026 at 11:59 p.m. (Pacific Time) ${separator} closed cycle`))).toEqual({
      label: "Deadline", date: "October 1, 2026", time: "11:59 p.m. (Pacific Time)", closedCycle: true,
    });
  });

  it("does not infer closure from past classification or an old year", () => {
    expect(presentAwardCardDeadline(entry("October 1, 2026 at 11:59 p.m. (Pacific Time)", "Fall 2026 application", "past")).closedCycle).toBe(false);
  });

  it.each([
    "October 1, 2026 — closed cycle if not extended",
    "Closed cycle — October 1, 2026",
    "October 1, 2026 — closed cycle — closed cycle",
    "October 1, 2026 (closed cycle)",
  ])("does not extract a conditional, repeated or nonterminal closure: %s", (value) => {
    expect(presentAwardCardDeadline(entry(value, "Deadline", "past"))).toEqual({ label: "Deadline", date: value, time: null, closedCycle: false });
  });

  it("keeps unknown wording while separately representing an explicit closed cycle", () => {
    expect(presentAwardCardDeadline(entry("Check the archived official page — closed cycle"))).toEqual({
      label: "Deadline", date: "Check the archived official page", time: null, closedCycle: true,
    });
  });

  it("does not mutate entries or change the presentation layer's ordering and classification", () => {
    const presented = presentAwardDeadlines({
      deadline: "October 1, 2026",
      importantDates: ["Application deadline for graduate applicants: January 20, 2027", "Application deadline for undergraduate applicants: January 27, 2027"],
    }, "Example", new Date("2026-11-01T15:00:00Z"));
    const before = structuredClone(presented);
    presented.entries.forEach(Object.freeze);
    Object.freeze(presented.entries);
    const cards = presented.entries.map(presentAwardCardDeadline);
    expect(cards.map((card) => card.label)).toEqual(presented.entries.map((item) => item.label));
    expect(cards.map((card) => card.date)).toEqual(presented.entries.map((item) => item.value));
    expect(cards.every((card) => !card.closedCycle)).toBe(true);
    expect(presented).toEqual(before);
    expect(presented.entries.map((item) => item.status)).toEqual(["listed", "listed", "past"]);
  });
});
