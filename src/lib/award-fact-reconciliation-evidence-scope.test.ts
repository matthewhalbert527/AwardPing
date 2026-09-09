import { describe, expect, it } from "vitest";

import {
  auditPublicAwardPage,
  buildFactCandidatesFromSources,
  reconcileAwardFacts,
  validateFactCandidate,
  type FactCandidate,
} from "@/lib/award-fact-reconciliation";

/**
 * Scope of the evidence a source-generated candidate may claim.
 *
 * A page-level quote describes the page, not any one fact. These tests pin
 * that `buildFactCandidatesFromSources` no longer copies one into the per-fact
 * `evidence_quote` and `evidence_location` columns, and that the page context
 * is kept at page scope instead, the way `factCandidateRowsFromIntake` keeps
 * it.
 *
 * They do not claim the source-wide fallback is gone. Admission in
 * `validateFactCandidate` and the deadline check in the page audit both still
 * accept a page-level quote, and the last two tests pin exactly that. Nothing
 * here evaluates whether any value is true.
 */

const AWARD = {
  id: "award-1",
  name: "Example Research Fellowship",
  summary: null,
  public_facts: {},
};

/** The only quote the page carries. It states an eligibility rule, nothing else. */
const ELIGIBILITY_QUOTE = "Applicants must be enrolled graduate students.";

/** `award_amount` is stored under its canonical alias on the candidate. */
const AMOUNT_FIELD = "award_amounts";

function source(baselineOverrides: Record<string, unknown> = {}) {
  return {
    id: "source-1",
    shared_award_id: AWARD.id,
    url: "https://example.edu/fellowship",
    title: AWARD.name,
    display_title: AWARD.name,
    page_description: "Official fellowship page.",
    page_type: "homepage",
    source: "admin",
    reason: null,
    admin_review_status: "open",
    page_metadata_generated_at: "2026-09-09T00:00:00.000Z",
    page_metadata_model: "source-intake-gemini-batch",
    page_metadata: {
      baseline_facts: {
        award_relevance: "primary",
        cycle_relevance: "current_or_upcoming",
        confidence: "high",
        evidence_quotes: [ELIGIBILITY_QUOTE],
        evidence_location: "Eligibility section",
        display_title: AWARD.name,
        page_description: "Official fellowship page.",
        deadline: "October 29, 2026",
        award_amounts: ["$38,000"],
        // The page quote is about eligibility, so this field is the strongest
        // case for a page-scoped quote. It still gets no per-fact evidence:
        // the quote is not bound to this stored item.
        eligibility: ["Enrolled graduate students"],
        ...baselineOverrides,
      },
    },
  } as never;
}

function generated(sources: unknown[] = [source()]) {
  return buildFactCandidatesFromSources(AWARD as never, sources as never);
}

function byField(candidates: FactCandidate[], field: string) {
  return candidates.filter((candidate) => candidate.field_name === field);
}

describe("source-generated candidate evidence scope", () => {
  it("leaves per-fact evidence null for amount and deadline on an eligibility-only quote", () => {
    const candidates = generated();
    for (const field of [AMOUNT_FIELD, "deadline", "eligibility"]) {
      expect(byField(candidates, field).length, field).toBeGreaterThan(0);
      for (const candidate of byField(candidates, field)) {
        expect(candidate.evidence_quote, field).toBeNull();
        expect(candidate.evidence_location, field).toBeNull();
      }
    }
    // No generated candidate claims any per-fact evidence at all.
    expect(candidates.every((candidate) => candidate.evidence_quote === null)).toBe(true);
    expect(candidates.every((candidate) => candidate.evidence_location === null)).toBe(true);
  });

  it("keeps the page quote and location at page scope in metadata", () => {
    for (const candidate of generated()) {
      expect(candidate.metadata).toMatchObject({
        page_evidence_quotes: [ELIGIBILITY_QUOTE],
        page_evidence_location: "Eligibility section",
        page_evidence_scope: "source_page",
      });
    }
  });

  it("gives every candidate its own array, aliasing neither the source nor a sibling", () => {
    const quotes = [ELIGIBILITY_QUOTE];
    const candidates = generated([source({ evidence_quotes: quotes })]);
    expect(candidates.length).toBeGreaterThan(1);

    const first = candidates[0].metadata?.page_evidence_quotes as string[];
    const second = candidates[1].metadata?.page_evidence_quotes as string[];
    expect(first).not.toBe(second);
    expect(first).not.toBe(quotes);

    first.push("Local reviewer annotation");
    expect(second).toEqual([ELIGIBILITY_QUOTE]);
    expect(quotes).toEqual([ELIGIBILITY_QUOTE]);
  });

  it("refuses to turn missing or malformed page evidence into a claimed quote", () => {
    const cases: Array<[string, unknown, unknown, string[], string | null]> = [
      ["absent", undefined, undefined, [], null],
      ["null", null, null, [], null],
      ["an object", { quote: ELIGIBILITY_QUOTE }, { section: "Eligibility" }, [], null],
      ["a number", 5000, 5000, [], null],
      ["an empty array", [], "", [], null],
      ["entries that are objects", [{ text: ELIGIBILITY_QUOTE }, 7, null], null, [], null],
      ["a bare string rather than a list", ELIGIBILITY_QUOTE, "Eligibility section", [ELIGIBILITY_QUOTE], "Eligibility section"],
      ["a mix of usable and unusable entries", [ELIGIBILITY_QUOTE, { a: 1 }, "  "], null, [ELIGIBILITY_QUOTE], null],
    ];

    for (const [label, evidence_quotes, evidence_location, expectedQuotes, expectedLocation] of cases) {
      const candidates = generated([source({ evidence_quotes, evidence_location })]);
      expect(candidates.length, label).toBeGreaterThan(0);
      for (const candidate of candidates) {
        expect(candidate.evidence_quote, label).toBeNull();
        expect(candidate.evidence_location, label).toBeNull();
        expect(candidate.metadata?.page_evidence_quotes, label).toEqual(expectedQuotes);
        expect(candidate.metadata?.page_evidence_location, label).toBe(expectedLocation);
        expect(JSON.stringify(candidate.metadata), label).not.toContain("[object Object]");
      }
    }
  });

  it("changes nothing about values, owner identity or lifecycle", () => {
    const amount = byField(generated(), AMOUNT_FIELD)[0];
    expect(amount).toMatchObject({
      shared_award_id: AWARD.id,
      shared_award_source_id: "source-1",
      source_url: "https://example.edu/fellowship",
      source_title: AWARD.name,
      source_role: "primary",
      raw_value: ["$38,000"],
      normalized_value: ["$38,000"],
      extracted_at: "2026-09-09T00:00:00.000Z",
      model: "source-intake-gemini-batch",
      confidence: "high",
      candidate_status: "pending",
    });
    expect(amount.metadata).toMatchObject({ source_page_type: "homepage" });
  });
});

describe("ranking after the evidence bonus stops being earned by page context", () => {
  /** A caller-supplied candidate, as the worker loads it from storage. */
  function supplied(value: unknown, evidence_quote: string | null): FactCandidate {
    return {
      id: "stored-candidate",
      shared_award_id: AWARD.id,
      shared_award_source_id: "source-1",
      source_url: "https://example.edu/fellowship",
      source_title: AWARD.name,
      field_name: "award_amount",
      raw_value: value,
      normalized_value: value,
      evidence_quote,
      evidence_location: null,
      extracted_at: "2026-09-09T00:00:00.000Z",
      model: "source-intake-gemini-batch",
      confidence: "high",
      candidate_status: "pending",
    };
  }

  function winner(candidates: FactCandidate[]) {
    const result = reconcileAwardFacts(AWARD as never, [source()] as never, candidates as never);
    const selection = result.selected[AMOUNT_FIELD];
    return { value: selection?.value, score: selection?.score };
  }

  it("ties a generated candidate with an unbound stored one, so input order decides", () => {
    const generatedAmount = byField(generated(), AMOUNT_FIELD)[0];
    const storedAmount = supplied(["$40,000"], null);

    const generatedFirst = winner([generatedAmount, storedAmount]);
    const storedFirst = winner([storedAmount, generatedAmount]);

    expect(generatedFirst.score).toBe(storedFirst.score);
    // Equal scores, so the stable sort keeps whichever arrived first.
    expect(generatedFirst.value).toEqual(["$38,000"]);
    expect(storedFirst.value).toEqual(["$40,000"]);
  });

  it("keeps the existing bonus for a caller-supplied nonempty quote", () => {
    const generatedAmount = byField(generated(), AMOUNT_FIELD)[0];
    const boundAmount = supplied(["$40,000"], "The award provides a $40,000 stipend.");

    const generatedFirst = winner([generatedAmount, boundAmount]);
    const boundFirst = winner([boundAmount, generatedAmount]);

    // The supplied-quote candidate wins from either position. The fixture's
    // wording is relevant; the scoring rule itself does not validate binding.
    expect(generatedFirst.value).toEqual(["$40,000"]);
    expect(boundFirst.value).toEqual(["$40,000"]);
    expect(Number(boundFirst.score) - Number(winner([generatedAmount]).score)).toBe(5);
  });
});

describe("what this slice deliberately does not change", () => {
  it("still admits amount and deadline on a page quote that mentions neither", () => {
    for (const [field, value] of [["award_amount", "$38,000"], ["deadline", "October 29, 2026"]] as const) {
      const verdict = validateFactCandidate(
        { field_name: field, raw_value: value, evidence_quote: null, shared_award_source_id: "source-1" } as never,
        AWARD as never,
        source(),
      );
      expect(verdict.allowed, field).toBe(true);
      expect(verdict.reason, field).toBe("accepted");
    }
    expect(ELIGIBILITY_QUOTE).not.toContain("$38,000");
    expect(ELIGIBILITY_QUOTE).not.toContain("October 29, 2026");
  });

  it("still passes the deadline evidence audit on that same page quote", () => {
    const reconciliation = reconcileAwardFacts(
      AWARD as never,
      [source()] as never,
      byField(generated(), "deadline") as never,
    );
    const audit = auditPublicAwardPage(AWARD as never, reconciliation.selectedFacts, [source()] as never, { reconciliation });
    expect(reconciliation.selectedFacts.deadline).toBe("October 29, 2026");
    expect(audit.findings.some((finding) => finding.code === "deadline_missing_evidence")).toBe(false);
  });
});
