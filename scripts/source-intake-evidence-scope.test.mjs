import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { factCandidateRowsFromIntake, normalizeGeminiIntakeResult } from "./lib/source-intake.mjs";
import { auditCandidateEvidence } from "./lib/award-fact-evidence-audit.mjs";

const pageQuote = "Applications close March 1, 2027.";
const review = {
  status: "accepted",
  source_relevance: "primary",
  cycle_relevance: "current_or_upcoming",
  officialness: "official",
  confidence: "high",
  evidence_quotes: [pageQuote],
  facts: {
    description: "An example award.",
    deadline: "March 1, 2027",
    amount: "$5,000",
    eligibility: ["Graduate students", "U.S. citizens"],
    application_materials: ["Resume", "Two letters"],
    important_dates: ["Applications close: March 1, 2027"],
  },
};
const source = {
  url: "https://example.edu/fellowship",
  title: "Example Fellowship",
  display_title: "Example Fellowship",
  page_type: "homepage",
};
const expectedFacts = [
  ["description", "An example award."],
  ["deadline", "March 1, 2027"],
  ["award_amount", "$5,000"],
  ["eligibility", "Graduate students"],
  ["eligibility", "U.S. citizens"],
  ["application_materials", "Resume"],
  ["application_materials", "Two letters"],
  ["important_dates", "Applications close: March 1, 2027"],
];
function rowsFor(input = review, sourceLike = source) {
  return factCandidateRowsFromIntake({
    awardId: "award-fixture",
    sourceId: "source-fixture",
    sourcePageRequestId: "request-fixture",
    sourceLike,
    review: input,
    extractedAt: "2026-09-09T00:00:00.000Z",
  });
}

describe("intake fact evidence scope", () => {
  it("does not assign a deadline quote to other facts, list items, or URL rows", () => {
    const rows = rowsFor();
    expect(rows).toHaveLength(9);
    for (const row of rows) {
      expect(row.evidence_quote, row.field_name).toBeNull();
      expect(row.evidence_location, row.field_name).toBeNull();
      expect(row.metadata.page_evidence_scope).toBe("source_page");
      expect(row.metadata.page_evidence_quotes).toEqual([pageQuote]);
    }
  });

  it("preserves candidate identity, ordering and pending state", () => {
    const expected = [...expectedFacts, ["official_homepage_url", source.url]];
    const rows = rowsFor();
    expect(rows.map((row) => [row.field_name, row.raw_value])).toEqual(expected);
    rows.forEach((row, index) => {
      const value = expected[index][1];
      expect(row).toMatchObject({
        shared_award_id: "award-fixture",
        shared_award_source_id: "source-fixture",
        source_page_request_id: "request-fixture",
        normalized_value: value,
        intake_value_sha256: createHash("sha256").update(value, "utf8").digest("hex"),
        source_url: source.url,
        candidate_status: "pending",
        confidence: "high",
        extracted_at: "2026-09-09T00:00:00.000Z",
        metadata: { source_page_request_id: "request-fixture", intake_request_id: null },
      });
    });
  });

  it("retains normalized page context even when it literally contains a fact value", () => {
    const input = { ...review, evidence_quotes: ["  Graduate students  ", pageQuote, "Resume"] };
    const normalized = normalizeGeminiIntakeResult(input);
    const rows = rowsFor(input);
    expect(rows.every((row) => row.evidence_quote === null)).toBe(true);
    expect(rows.every((row) => row.evidence_location === null)).toBe(true);
    for (const row of rows) expect(row.metadata.page_evidence_quotes).toEqual(normalized.evidence_quotes);
  });

  it("does not invent field evidence when page quotes are absent", () => {
    for (const evidence_quotes of [[], undefined, null]) {
      for (const row of rowsFor({ ...review, evidence_quotes })) {
        expect(row.evidence_quote).toBeNull();
        expect(row.evidence_location).toBeNull();
        expect(row.metadata.page_evidence_quotes).toEqual([]);
        expect(row.metadata.page_evidence_scope).toBe("source_page");
      }
    }
  });

  it("keeps page quote arrays independent of inputs and sibling candidates", () => {
    const input = structuredClone(review);
    const before = structuredClone(input);
    const rows = rowsFor(input);
    expect(input).toEqual(before);
    expect(rows[0].metadata.page_evidence_quotes).toEqual([pageQuote]);
    rows[0].metadata.page_evidence_quotes.push("Local reviewer annotation");
    expect(rows[1].metadata.page_evidence_quotes).toEqual([pageQuote]);
    expect(input).toEqual(before);
  });

  it.each([["application", "application_url"], ["faq", "faq_url"]])(
    "does not attach a text quote to a derived %s URL",
    (page_type, field_name) => {
      const rows = rowsFor(review, { ...source, page_type });
      expect(rows.at(-1)).toMatchObject({ field_name, raw_value: source.url, evidence_quote: null, evidence_location: null });
      expect(rows).toHaveLength(9);
    },
  );

  it("reports absent per-fact assignments while retaining available source context", () => {
    const rows = rowsFor();
    const report = auditCandidateEvidence(rows, [{
      id: "source-fixture",
      url: source.url,
      page_metadata: { baseline_facts: { evidence_quotes: [pageQuote] } },
    }]);
    expect(report.rows).toHaveLength(rows.length);
    for (const row of report.rows) {
      expect(row.assignedQuote).toBeNull();
      expect(row.flags.noAssignedQuote).toBe(true);
      expect(row.flags.assignedQuoteSharedAcrossFields).toBe(false);
      expect(row.quoteAvailability).toMatchObject({ status: "known", count: 1 });
      expect(row.candidateStatus.known).toBe("pending");
    }
    expect(report.caveat).toContain("never evidence support");
  });
});
