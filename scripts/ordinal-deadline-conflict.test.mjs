import { describe, expect, it } from "vitest";
import {
  auditPublicAwardPage as auditWorker,
  reconcileAwardFacts as reconcileWorker,
} from "./lib/award-fact-reconciliation.mjs";
import {
  auditPublicAwardPage as auditApplication,
  reconcileAwardFacts as reconcileApplication,
} from "../src/lib/award-fact-reconciliation.ts";

// Synthetic comparator evidence only: no official capture, source approval or
// publication authority is asserted by these in-memory cases.
const award = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  name: "Example Fellowship",
  official_homepage: "https://example.edu/fellowship",
};
const options = { now: "2026-09-09T00:00:00.000Z", generatedAt: "2026-09-09T00:00:00.000Z" };

function reconcileDates(reconcile, values, field = "deadline") {
  const sources = values.map((_value, index) => ({
    id: `source-${index}`, shared_award_id: award.id,
    url: `${award.official_homepage}/${index}`,
    title: award.name, display_title: award.name, page_type: "homepage",
    admin_review_status: "open", confidence: 90,
    page_metadata_generated_at: options.generatedAt, page_metadata_model: "test",
    page_metadata: { baseline_facts: {
      status: "succeeded", award_name_seen: true, award_relevance: "primary",
      cycle_relevance: "evergreen", confidence: "high", quality_flags: [],
      evidence_quotes: [award.name],
    } },
  }));
  const candidates = values.map((value, index) => ({
    id: `candidate-${index}`, shared_award_id: award.id,
    shared_award_source_id: sources[index].id,
    field_name: field, raw_value: value, evidence_quote: value,
    confidence: "high", candidate_status: "pending",
  }));
  const original = structuredClone({ sources, candidates });
  const result = reconcile(award, sources, candidates, options);
  expect(result.rejected).toEqual([]);
  expect({ sources, candidates }).toEqual(original);
  expect(values).toContain(result.selectedFacts[field]);
  return { result, sources };
}

describe.each([
  ["worker", reconcileWorker, auditWorker],
  ["application", reconcileApplication, auditApplication],
])("ordinal calendar comparison: %s", (_name, reconcile, audit) => {
  const conflicts = (values, field = "deadline") =>
    reconcileDates(reconcile, values, field).result.conflicts.some(item => item.field_name === field);

  it.each(["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "15th", "21st", "22nd", "23rd", "31st"])(
    "groups %s only as a calendar day with valid suffix",
    (ordinal) => {
      const day = Number.parseInt(ordinal, 10);
      expect(conflicts([`January ${ordinal}`, `January ${day}`])).toBe(false);
      expect(conflicts([`${ordinal} January 2027`, `January ${day}, 2027`], "opening_date")).toBe(false);
    },
  );

  it("preserves the complete supplied wording and does not invent an unstated year", () => {
    const values = ["January 15th", "January 15"];
    const { result, sources } = reconcileDates(reconcile, values);
    expect(result.selectedFacts.deadline).not.toMatch(/[0-9]{4}/);
    const assessment = audit(award, result.selectedFacts, sources, { reconciliation: result, now: options.now });
    expect(assessment.findings.some(item => item.field_name === "deadline")).toBe(false);
    expect(assessment.should_block_publication).toBe(false);
  });

  it("merges a yearless ordinal only with its single matching year", () => {
    expect(conflicts(["January 15th", "January 15, 2027"])).toBe(false);
    expect(conflicts(["January 15th", "January 15, 2027", "January 15, 2028"])).toBe(true);
  });

  it.each([
    "January 15th or 16th", "January 15th or 16", "January 15th–16",
    "January 15th or February 16", "January 15th and 16th",
    "January 15th to 16", "January 15th through 16", "between January 15th and 16",
    "January 15th at 5 pm",
  ])("does not newly equate complex ordinal text %s with one yearless day", (value) => {
    expect(conflicts([value, "January 15"])).toBe(true);
  });

  it("recognizes one valid ordinal with a year and an unambiguous attached clock tail", () => {
    expect(conflicts(["January 15th, 2027 at 5pm", "January 15, 2027"])).toBe(false);
  });

  it.each([
    ["January 15th", "January 16"],
    ["15th January", "February 15"],
    ["January 15th, 2027", "January 15, 2028"],
  ])("retains a real deadline contradiction between %s and %s", (left, right) => {
    const { result, sources } = reconcileDates(reconcile, [left, right]);
    expect(result.conflicts).toContainEqual(expect.objectContaining({ field_name: "deadline", severity: "critical" }));
    expect(audit(award, result.selectedFacts, sources, { reconciliation: result, now: options.now }).should_block_publication).toBe(true);
  });

  it.each(["11st", "12nd", "13rd", "22th", "31th", "0th", "32nd"])(
    "does not newly recognize malformed calendar ordinal %s",
    (ordinal) => {
      expect(conflicts([`January ${ordinal}`, `January ${Number.parseInt(ordinal, 10)}`])).toBe(true);
      // Preserve the pre-existing month-only fallback; this is not day proof.
      expect(conflicts([`January ${ordinal}`, "January"])).toBe(false);
    },
  );

  it("keeps the existing 1st Tuesday rule ahead of numeric-day comparison", () => {
    expect(conflicts(["1st Tuesday in February", "February 2, 2027"])).toBe(false);
    expect(conflicts(["1st Tuesday in February", "February 3, 2027"])).toBe(true);
  });
});
