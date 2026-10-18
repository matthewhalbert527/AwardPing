import { describe, expect, it } from "vitest";
import { awardFactCurrentness, awardFactCurrentnessNotices, presentAwardDeadlines } from "@/lib/award-page-presentation";
import { publicAwardFactsFromAward } from "@/lib/public-award-facts";

const now = new Date("2026-10-17T20:00:00Z");
const usDeadline = "US citizens resident in the USA round — Wednesday 14 October 2026 at 11:59 p.m. GMT: Application deadline";
const otherDeadline = "All other eligible applicants round — Tuesday 8 December 2026 or Wednesday 6 January 2027 at 11:59 p.m. GMT (dependent on course): Application deadline";

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
    expect(result.entries[0].value).toContain("US citizens resident in the USA round");
    expect(result.entries[0].value).toContain("14 October 2026");
    expect(result.entries[0].status).toBe("past");
    expect(result.entries[1].value).toContain("8 December 2026 or Wednesday 6 January 2027");
    expect(result.entries[1].value).toContain("(dependent on course)");
    expect(result.entries[1].value).toContain("GMT");
    expect(result.entries[1].status).toBe("listed");
    expect(result.notice).toBeNull();
    expect(facts).toEqual(original);
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
