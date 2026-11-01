import { describe, expect, it } from "vitest";
import { awardFactCurrentness, awardFactCurrentnessNotices, presentAwardApplicationContext, presentAwardDeadlines } from "@/lib/award-page-presentation";
import { publicAwardFactsFromAward } from "@/lib/public-award-facts";

const now = new Date("2026-10-17T20:00:00Z");
const usDeadline = "US citizens resident in the USA round — Wednesday 14 October 2026 at 11:59 p.m. GMT: Application deadline";
const otherDeadline = "All other eligible applicants round — Tuesday 8 December 2026 or Wednesday 6 January 2027 at 11:59 p.m. GMT (dependent on course): Application deadline";

describe("reviewed application context", () => {
  it("shows both explicitly labelled application periods without changing their citizenship scopes or start year", () => {
    const importantDates = [
      "U.S./Global — Class of 2028–2029: U.S./Global application period — Class of 2028–2029: April–September 2027; programme begins August 2028.",
      "Chinese citizenship — Class of 2028–2029: China application period — Class of 2028–2029: March–May 2027; programme begins August 2028.",
    ];
    const facts = { deadline: null, importantDates };
    expect(presentAwardApplicationContext(facts)).toEqual(importantDates.map(value => ({ kind: "period", label: "Application period", value })));
    expect(presentAwardDeadlines(facts).entries).toEqual([]);
  });

  it("keeps the standing nomination rule and its weekend and campus conditions together", () => {
    const value = "Standing nomination schedule: National nominations are normally due January 15; the date can change when January 15 falls on a weekend or holiday. Check the latest application materials for the current deadline; internal university deadlines vary.";
    const facts = { importantDates: [value, value] };
    expect(presentAwardApplicationContext(facts)).toEqual([{ kind: "nomination", label: "Nomination schedule", value }]);
    expect(presentAwardDeadlines(facts).entries).toEqual([]);
  });

  it("uses explicit schedule labels instead of incidental deadline wording in their body", () => {
    const value = "Standing nomination schedule: National nominations are normally due January 15; confirm the current application deadline on the official website.";
    const facts = { importantDates: [value] };
    expect(presentAwardApplicationContext(facts)).toEqual([{ kind: "nomination", label: "Nomination schedule", value }]);
    expect(presentAwardDeadlines(facts).entries).toEqual([]);
    const deadline = "Application deadline — International: January 15, 2027; the application period starts in September.";
    expect(presentAwardDeadlines({ importantDates: [deadline] }).entries).toHaveLength(1);
    expect(presentAwardApplicationContext({ importantDates: [deadline] })).toEqual([]);
  });

  it("does not treat interviews, results, bare months or actual deadlines as additional application context", () => {
    const facts = { importantDates: ["Interviews: April 2027", "Application results: May 2027", "Interview results during the application period: April 2027", "Interview results: application period: April–September 2027", "Notes about application period: research schedule unchanged", "Notes: Application window: April–September 2027", "Research schedule: Application period: April–September 2027", "Applicant results: Application window: May 2027", "April–September 2027", "Application deadline — International: January 15, 2027"] };
    expect(presentAwardApplicationContext(facts)).toEqual([]);
    expect(presentAwardDeadlines(facts).entries).toHaveLength(1);
  });

  it("keeps legitimate research subject scopes on explicitly labelled application periods", () => {
    const importantDates = ["Research fellowship application period: April–September 2027", "Application period — Research grants: March–May 2027"];
    expect(presentAwardApplicationContext({ importantDates })).toEqual(importantDates.map(value => ({ kind: "period", label: "Application period", value })));
  });

  it("retains a Gates round's reference condition on its deadline entry", () => {
    const value = "Application deadline — U.S. citizens resident in the U.S. — October round: October 14, 2026 at 11:59 p.m. UK time; all documents, including references, due in this round.";
    const facts = publicAwardFactsFromAward({ completeSnapshot: true, publicFacts: { important_dates: [value] } });
    expect(presentAwardDeadlines(facts).entries[0].value).toContain("; all documents, including references, due in this round.");
    expect(presentAwardApplicationContext(facts)).toEqual([]);
  });

  it("keeps a closed earlier cycle separate from a qualified month-only next opening", () => {
    const facts = {
      deadline: null,
      cycleStatus: "AY 2026–27 applications are closed.",
      openingDate: "AY 2027–28 applications are expected to open in February 2027.",
    };
    const before = structuredClone(facts);
    expect(presentAwardApplicationContext(facts, "Example Award")).toEqual([
      { kind: "status", label: "Application status", value: facts.cycleStatus },
      { kind: "opening", label: "Opening date", value: facts.openingDate },
    ]);
    expect(presentAwardDeadlines(facts, "Example Award", now).entries).toEqual([]);
    expect(facts).toEqual(before);
  });

  it.each([
    { facts: {}, expected: [] },
    { facts: { cycleStatus: " ", openingDate: " " }, expected: [] },
    { facts: { cycleStatus: "Applications are open for the 2027 cycle." }, expected: [{ kind: "status", label: "Application status", value: "Applications are open for the 2027 cycle." }] },
    { facts: { openingDate: "February 2027 (expected)" }, expected: [{ kind: "opening", label: "Opening date", value: "February 2027 (expected)" }] },
  ])("shows only supplied context: $facts", ({ facts, expected }) => {
    expect(presentAwardApplicationContext(facts)).toEqual(expected);
  });

  it("does not infer cycle status from a passed deadline or opening", () => {
    const facts = { deadline: "October 1, 2026", openingDate: "January 1, 2026" };
    expect(presentAwardDeadlines(facts, "Example", now).entries[0].status).toBe("past");
    expect(presentAwardApplicationContext(facts, "Example")).toEqual([
      { kind: "opening", label: "Opening date", value: "January 1, 2026" },
    ]);
  });
});

describe("shared award deadline presentation", () => {
  it("finds both Gates application rounds without moving outcomes into deadlines", () => {
    const facts = {
      deadline: null,
      importantDates: [usDeadline, "US citizens resident in the USA round — Monday 14 December 2026: Notification of application outcome", otherDeadline],
    };
    const original = structuredClone(facts);
    const result = presentAwardDeadlines(facts, "Gates Cambridge Scholarship", now);
    expect(result.label).toBe("Application deadlines");
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0].value).toContain("8 December 2026 or Wednesday 6 January 2027");
    expect(result.entries[0].value).toContain("(dependent on course)");
    expect(result.entries[0].value).toContain("GMT");
    expect(result.entries[0].status).toBe("listed");
    expect(result.entries[1].value).toContain("US citizens resident in the USA round");
    expect(result.entries[1].value).toContain("14 October 2026");
    expect(result.entries[1].status).toBe("past");
    expect(result.notice).toBeNull();
    expect(facts).toEqual(original);
  });

  it("puts known past dates last without reordering current or uncertain listings", () => {
    const facts = {
      deadline: "October 1, 2026",
      importantDates: [
        "Application deadline for later track: February 1, 2027",
        "Application deadline for rolling track: Rolling; check the official page",
        "Application deadline for archived track: September 1, 2026",
        "Application deadline for earlier track: November 1, 2026",
      ],
    };
    const original = structuredClone(facts);
    Object.freeze(facts.importantDates);
    Object.freeze(facts);
    const result = presentAwardDeadlines(facts, "Example", now);
    expect(result.entries.map(({ label, status }) => ({ label, status }))).toEqual([
      { label: "Application deadline for later track", status: "listed" },
      { label: "Application deadline for rolling track", status: "listed" },
      { label: "Application deadline for earlier track", status: "listed" },
      { label: "Deadline", status: "past" },
      { label: "Application deadline for archived track", status: "past" },
    ]);
    expect(result.entries[1].value).toBe("Rolling; check the official page");
    expect(result.entries[3].value).toBe("October 1, 2026");
    expect(result.entries[4].value).toBe("September 1, 2026");
    expect(result.notice).toBeNull();
    expect(facts).toEqual(original);
  });

  it("retains source order and the existing notice when all deadlines have passed", () => {
    const result = presentAwardDeadlines({
      deadline: "October 1, 2026",
      importantDates: [
        "Application deadline for second track: September 1, 2026",
        "Application deadline for third track: August 1, 2026",
      ],
    }, "Example", now);
    expect(result.entries.map(({ value, status }) => ({ value, status }))).toEqual([
      { value: "October 1, 2026", status: "past" },
      { value: "September 1, 2026", status: "past" },
      { value: "August 1, 2026", status: "past" },
    ]);
    expect(result.notice).toBe("The listed deadlines have passed. A later deadline is not confirmed here.");
  });

  it("retains uncertain and recurring listings in source order without declaring them past", () => {
    const result = presentAwardDeadlines({
      deadline: "Usually October 1, 2026",
      importantDates: [
        "Application deadline for second track: TBA",
        "Application deadline for third track: Rolling; check the official page",
      ],
    }, "Example", now);
    expect(result.entries.map(({ value, status }) => ({ value, status }))).toEqual([
      { value: "Usually October 1, 2026", status: "listed" },
      { value: "TBA", status: "listed" },
      { value: "Rolling; check the official page", status: "listed" },
    ]);
    expect(result.notice).toBeNull();
  });

  it("keeps Boren track labels, zones and distinct timeline scopes", () => {
    const result = presentAwardDeadlines({
      deadline: "January 27, 2027 (Boren Scholarships)",
      importantDates: ["Application deadline for fellowships: January 20, 2027 at 5:00 p.m. EST"],
    }, "Boren Scholarships and Fellowships", now);
    expect(result.entries[0]).toMatchObject({ label: "Scholarships deadline", value: "January 27, 2027" });
    expect(result.entries[1].label).toBe("Application deadline for fellowships");
    expect(result.entries[1].value).toContain("EST");
  });

  it("removes an exact duplicated generic deadline, not same-date audience variants", () => {
    const result = presentAwardDeadlines({
      deadline: "2027-01-27",
      importantDates: ["Application deadline: January 27, 2027", "Application deadline for US applicants: January 27, 2027"],
    });
    expect(result.entries).toHaveLength(2);
    expect(result.entries[1].label).toContain("US applicants");
  });

  it("does not invent a deadline from opening, outcomes, interviews or a bare date", () => {
    const result = presentAwardDeadlines({ importantDates: ["Applications open: September 2026", "March 27, 2026", "Interview deadline: January 1, 2027", "Nomination deadline: January 2, 2027"] }, "Example", now);
    expect(result.entries).toEqual([]);
    expect(result.notice).toContain("No application deadline is recorded");
  });

  it("marks only demonstrably past calendar dates and never declares the award closed", () => {
    const result = presentAwardDeadlines({ deadline: "2026-03-27T17:00:00-05:00" }, "Example", now);
    expect(result.entries[0]).toMatchObject({ value: "March 27, 2026 at 5:00 p.m. (UTC-05:00)", status: "past" });
    expect(result.notice).toBe("The listed deadline has passed. A later deadline is not confirmed here.");
    expect(JSON.stringify(result)).not.toContain("closed");
  });

  it.each(["Last Friday in January, 5:00 p.m. Central Time", "February 30, 2026", "TBA", "Usually October 1, 2026", "Every October 1, 2026", "October 1, 2026 or later", "October 1, 2026 or January 2027"])("does not infer status for %s", (deadline) => {
    expect(presentAwardDeadlines({ deadline }, "Example", now).entries[0].status).toBe("listed");
  });

  it("does not let server/client midnight or missing time zone change status prematurely", () => {
    const input = { deadline: "October 16, 2026" };
    expect(presentAwardDeadlines(input, "Example").entries[0].status).toBe("listed");
    expect(presentAwardDeadlines(input, "Example", new Date("2026-10-17T11:59:59Z")).entries[0].status).toBe("listed");
    expect(presentAwardDeadlines(input, "Example", new Date("2026-10-17T12:00:01Z")).entries[0].status).toBe("past");
  });
});

describe("explicit possible stale-fact notices", () => {
  const details = {
    reader_summary: "The graduation window changed.",
    before: "A junior is currently enrolled, plans full-time study, and expects to receive a bachelor's degree between December 2026 and August 2027.",
    after: "A junior is currently enrolled, plans full-time study, and expects to receive a bachelor's degree between December 2027 and August 2028.",
    is_alert_worthy: true,
    change_type: "eligibility",
  };
  const change = { id: "beinecke-change", detectedAt: "2026-09-03T19:12:00Z", changeDetails: details };

  it("flags the retained Beinecke-style graduation-window conflict without rewriting facts", () => {
    const facts = publicAwardFactsFromAward({ publicFacts: { academic_levels: ["College juniors expecting graduation between December 2026 and August 2027"] } });
    const original = structuredClone(facts);
    const notice = awardFactCurrentness({ facts, changes: [change] });
    expect(notice).toMatchObject({ kind: "possible_conflict", changeId: "beinecke-change", fields: ["academicLevels"] });
    expect(notice?.message).toContain("Review the update and official source");
    expect(facts).toEqual(original);
  });

  it("does not flag reconciled current wording or unchanged clauses shared by both snapshots", () => {
    const facts = publicAwardFactsFromAward({ publicFacts: { academic_levels: ["College juniors expecting graduation between December 2027 and August 2028"], eligibility: ["A junior is currently enrolled, plans full-time study"] } });
    expect(awardFactCurrentness({ facts, changes: [change] })).toBeNull();
  });

  it("uses retained diff snippets when top-level before/after are unavailable", () => {
    const facts = publicAwardFactsFromAward({ publicFacts: { eligibility: [details.before] } });
    expect(awardFactCurrentness({ facts, changes: [{ ...change, changeDetails: { ...details, before: null, after: null, structured_diff: { removed_text: [details.before], added_text: [details.after] } } }] })?.changeId).toBe(change.id);
  });

  it("does not infer a conflict merely from review age, missing data, year overlap or first observations", () => {
    const facts = publicAwardFactsFromAward({ publicFacts: { eligibility: ["Applicants enrolled during 2026"] } });
    for (const changeDetails of [null, { reader_summary: "A new 2027 cycle is open" }, { ...details, event_kind: "new_official_document" }, { ...details, is_alert_worthy: false }]) {
      expect(awardFactCurrentness({ facts, changes: [{ ...change, changeDetails }], factsReviewedAt: "2025-01-01T00:00:00Z" })).toBeNull();
    }
  });

  it("retains independent conflicting fields across events without duplicating an event or mutating input", () => {
    const facts = publicAwardFactsFromAward({ publicFacts: {
      academic_levels: ["College juniors expecting graduation between December 2026 and August 2027"],
      requirements: ["All applicants must submit exactly three reference letters"],
    } });
    const second = { ...change, id: "references-change", changeDetails: {
      ...details, before: "All applicants must submit exactly three reference letters",
      after: "All applicants must submit exactly two reference letters",
    } };
    const input = { facts, changes: [change, second, change] };
    const original = structuredClone(input);
    expect(awardFactCurrentnessNotices(input).map(({ changeId, fields }) => ({ changeId, fields }))).toEqual([
      { changeId: change.id, fields: ["academicLevels"] },
      { changeId: second.id, fields: ["requirements"] },
    ]);
    expect(input).toEqual(original);
  });

  it.each([
    ["Application deadline for all eligible applicants: January 27, 2027", true],
    ["Final interview results for all eligible applicants: January 27, 2027", false],
  ])("qualifies only changed application timeline entries for deadline notices: %s", (value, expected) => {
    const facts = publicAwardFactsFromAward({ publicFacts: { important_dates: [value] } });
    const notice = awardFactCurrentness({ facts, changes: [{ ...change, changeDetails: {
      ...details, before: value, after: value.replace("January 27", "January 28"),
    } }] });
    expect(notice?.affectsApplicationDeadline).toBe(expected);
  });
});
