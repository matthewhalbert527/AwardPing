/**
 * Characterization of how raw source-intake model facts become candidate
 * rows prepared for persistence, through `normalizeGeminiIntakeResult` and
 * `factCandidateRowsFromIntake`.
 *
 * These tests record what the current code does, so a later change to the
 * splitting, cleaning, dropping or capping rules is visible rather than
 * silent. They are not an argument that any of those rules is semantically
 * right: splitting one model string into several candidate values is a guess
 * about the model's formatting, and nothing here evaluates whether the
 * resulting items are true, well formed, or supported by the page.
 *
 * Scope is the row builder alone. No database, provider, worker or network
 * entrypoint is used, no normalization is re-implemented here, and no row is
 * checked against any evidence.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  factCandidateRowsFromIntake,
  normalizeGeminiIntakeResult,
  sourceIntakeFactCandidateConflictColumns,
} from "./lib/source-intake.mjs";

const EXTRACTED_AT = "2026-09-09T00:00:00.000Z";
/** page_type "other" adds no derived URL row, so list rows stand alone. */
const SOURCE = {
  url: "https://example.edu/fellowship",
  title: "Example Fellowship",
  display_title: "Example Fellowship",
  page_type: "other",
};

function reviewWithFacts(facts) {
  return {
    status: "accepted",
    source_relevance: "primary",
    cycle_relevance: "current_or_upcoming",
    officialness: "official",
    confidence: "high",
    evidence_quotes: ["Applications close March 1."],
    facts,
  };
}

function rowsFor(review, { sourceLike = SOURCE, sourcePageRequestId = "request-fixture" } = {}) {
  return factCandidateRowsFromIntake({
    awardId: "award-fixture",
    sourceId: "source-fixture",
    sourcePageRequestId,
    sourceLike,
    review,
    extractedAt: EXTRACTED_AT,
  });
}

const THIRTEEN = Array.from({ length: 13 }, (_, index) => `Item ${index + 1}`);
const FIRST_TWELVE = THIRTEEN.slice(0, 12);

/** [description, raw field value, candidate values in order] */
const LIST_CASES = [
  ["a bare string is read as a one-entry list", "Graduate students", ["Graduate students"]],
  ["a flat array keeps its order", ["Alpha", "Beta", "Gamma"], ["Alpha", "Beta", "Gamma"]],
  ["semicolons split one entry into several", ["Alpha; Beta; Gamma"], ["Alpha", "Beta", "Gamma"]],
  ["newlines split, and a carriage return is absorbed", ["Alpha\nBeta\r\nGamma"], ["Alpha", "Beta", "Gamma"]],
  ["a bullet splits", ["Alpha \u2022 Beta"], ["Alpha", "Beta"]],
  ["nested arrays are flattened", [["Alpha", "Beta"], ["Gamma"]], ["Alpha", "Beta", "Gamma"]],
  ["nesting is flattened at any depth", [[["Alpha"], "Beta"]], ["Alpha", "Beta"]],
  ["inner whitespace collapses and the ends are trimmed", ["  Alpha   Beta  "], ["Alpha Beta"]],
  ["a NUL is removed without leaving a gap", ["Al\u0000pha"], ["Alpha"]],
  ["blank and separator-only entries are dropped", ["Alpha", "", "   ", ";;", "Beta"], ["Alpha", "Beta"]],
  [
    "non-string entries are dropped, but a nested array is still read",
    ["Alpha", 7, null, true, { v: "Beta" }, ["Gamma"]],
    ["Alpha", "Gamma"],
  ],
  ["duplicate values are kept and case is not folded", ["Alpha", "Alpha", "alpha"], ["Alpha", "Alpha", "alpha"]],
  ["a long array is capped at twelve", THIRTEEN, FIRST_TWELVE],
  ["the cap is applied after splitting, not before", [THIRTEEN.join("; ")], FIRST_TWELVE],
  ["an object is not a list", { a: "Alpha" }, []],
  ["null is not a list", null, []],
  ["a number is not a list", 7, []],
];

const LIST_FIELDS = ["eligibility", "application_materials", "important_dates"];
const CONFLICT_COLUMNS = sourceIntakeFactCandidateConflictColumns.split(",");
const conflictKey = (row) => JSON.stringify(CONFLICT_COLUMNS.map((column) => row[column]));

describe.each(LIST_FIELDS)("source-intake list field %s", (field) => {
  it.each(LIST_CASES)("%s", (_name, raw, expected) => {
    const review = reviewWithFacts({ [field]: raw });

    expect(normalizeGeminiIntakeResult(review).facts[field]).toEqual(expected);

    const rows = rowsFor(review);
    expect(rows.map((row) => row.field_name)).toEqual(expected.map(() => field));
    expect(rows.map((row) => row.raw_value)).toEqual(expected);
    // normalized_value carries the same text as raw_value, so neither column
    // records which raw entry the item came from.
    expect(rows.map((row) => row.normalized_value)).toEqual(expected);
  });

  it("derives each per-value hash from that row's value alone", () => {
    // One entry that splits, then a repeat of the first resulting value.
    const rows = rowsFor(reviewWithFacts({ [field]: ["Alpha; Beta", "Alpha"] }));
    expect(rows.map((row) => row.raw_value)).toEqual(["Alpha", "Beta", "Alpha"]);

    for (const row of rows) {
      expect(row.intake_value_sha256, row.raw_value)
        .toBe(createHash("sha256").update(row.raw_value, "utf8").digest("hex"));
    }
    // Equal values share an identity wherever they came from, and different
    // values do not. Position in the list contributes nothing.
    expect(rows[0].intake_value_sha256).toBe(rows[2].intake_value_sha256);
    expect(rows[0].intake_value_sha256).not.toBe(rows[1].intake_value_sha256);

    // Identity is stamped only when a request id is present.
    const unbound = rowsFor(reviewWithFacts({ [field]: ["Alpha"] }), { sourcePageRequestId: null });
    expect(unbound[0]).toMatchObject({ source_page_request_id: null, intake_value_sha256: null });
  });

  it("assigns no per-field quote or location to any row", () => {
    const rows = rowsFor(reviewWithFacts({ [field]: ["Alpha; Beta", ["Gamma"]] }));
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.evidence_quote, row.raw_value).toBeNull();
      expect(row.evidence_location, row.raw_value).toBeNull();
      expect(row.candidate_status, row.raw_value).toBe("pending");
      expect(row.extracted_at, row.raw_value).toBe(EXTRACTED_AT);
    }
  });

  it("keeps duplicate values in builder output with matching conflict keys", () => {
    const rows = rowsFor(reviewWithFacts({ [field]: ["Alpha", "Alpha", "alpha"] }));
    expect(rows.map((row) => row.raw_value)).toEqual(["Alpha", "Alpha", "alpha"]);
    expect(conflictKey(rows[0])).toBe(conflictKey(rows[1]));
    expect(conflictKey(rows[0])).not.toBe(conflictKey(rows[2]));

    // This shows only that the builder returns three rows. It is not evidence
    // that three candidates are stored: the upsert declares exactly these
    // columns as its conflict target, so two rows sharing that key cannot
    // both become separate stored candidates. No database is involved in this
    // file, and the storage outcome is not asserted here.
    expect(CONFLICT_COLUMNS).toEqual(["source_page_request_id", "field_name", "intake_value_sha256"]);
  });
});

describe("source-intake scalar fact fields", () => {
  /** [description, raw deadline, candidate value] */
  const DEADLINE_CASES = [
    ["a semicolon does not split a scalar", "March 1; March 15", "March 1; March 15"],
    ["a newline collapses to a space rather than splitting", "March 1\nMarch 15", "March 1 March 15"],
    ["a bullet stays inside the value", "March 1 \u2022 March 15", "March 1 \u2022 March 15"],
    ["a NUL is removed and the ends are trimmed", "  March\u00001  ", "March1"],
  ];

  it.each(DEADLINE_CASES)("deadline: %s", (_name, raw, expected) => {
    const review = reviewWithFacts({ deadline: raw });
    expect(normalizeGeminiIntakeResult(review).facts.deadline).toBe(expected);

    const rows = rowsFor(review);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      field_name: "deadline",
      raw_value: expected,
      normalized_value: expected,
      evidence_quote: null,
      evidence_location: null,
    });
  });

  it("splits the same text when it arrives in a list field instead", () => {
    // The separator is not a property of the text. It is a property of which
    // field the model put the text in.
    const asScalar = rowsFor(reviewWithFacts({ deadline: "March 1; March 15" }));
    const asList = rowsFor(reviewWithFacts({ important_dates: "March 1; March 15" }));
    expect(asScalar.map((row) => row.raw_value)).toEqual(["March 1; March 15"]);
    expect(asList.map((row) => row.raw_value)).toEqual(["March 1", "March 15"]);
  });

  it("keeps description and amount whole, and reads amount from either raw key", () => {
    const rows = rowsFor(reviewWithFacts({ description: "  A; B  ", award_amount: "$5,000; $7,500" }));
    expect(rows.map((row) => [row.field_name, row.raw_value])).toEqual([
      ["description", "A; B"],
      // normalizeFacts reads facts.amount first and falls back to
      // facts.award_amount. Either raw key maps to award_amount.
      ["award_amount", "$5,000; $7,500"],
    ]);
    expect(rowsFor(reviewWithFacts({ amount: "$1", award_amount: "$2" }))[0].raw_value).toBe("$1");
  });
});

describe("source-intake row construction across fields", () => {
  const MIXED = {
    description: " An example award. ",
    deadline: "March 1; March 15",
    amount: "$5,000",
    eligibility: ["Graduate students; U.S. citizens"],
    application_materials: ["Resume", "", ["Two letters"]],
    important_dates: ["Opens: January 5\nCloses: March 1"],
  };

  it("emits fields in a fixed order with list items in place", () => {
    const rows = rowsFor(reviewWithFacts(MIXED), { sourceLike: { ...SOURCE, page_type: "homepage" } });
    expect(rows.map((row) => [row.field_name, row.raw_value])).toEqual([
      ["description", "An example award."],
      ["deadline", "March 1; March 15"],
      ["award_amount", "$5,000"],
      ["eligibility", "Graduate students"],
      ["eligibility", "U.S. citizens"],
      ["application_materials", "Resume"],
      ["application_materials", "Two letters"],
      ["important_dates", "Opens: January 5"],
      ["important_dates", "Closes: March 1"],
      ["official_homepage_url", SOURCE.url],
    ]);
  });

  it("does not mutate the review it was given", () => {
    const review = reviewWithFacts(structuredClone(MIXED));
    const before = structuredClone(review);

    const normalized = normalizeGeminiIntakeResult(review);
    const rows = rowsFor(review);
    expect(review).toEqual(before);

    // The normalized lists are fresh arrays, so editing them cannot reach the
    // input. `raw`, by contrast, is the caller's own object: the normalized
    // result is not a deep copy, and callers must not treat it as one.
    normalized.facts.eligibility.push("Local reviewer annotation");
    rows[0].raw_value = "edited";
    expect(review).toEqual(before);
    expect(normalized.raw).toBe(review);
  });

  it("builds identical rows from equal input on repeated calls", () => {
    expect(rowsFor(reviewWithFacts(structuredClone(MIXED))))
      .toEqual(rowsFor(reviewWithFacts(structuredClone(MIXED))));
  });
});
