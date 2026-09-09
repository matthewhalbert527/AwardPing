import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  AUDIT_SCHEMA_VERSION,
  CANDIDATE_STATUS_NOTE,
  KNOWN_CANDIDATE_STATUSES,
  QUOTE_CONTAINER_PATHS,
  REVIEW_CAVEAT,
  auditAwards,
  auditCandidateEvidence,
  parseAuditInput,
  summarizeEvidenceAudit,
} from "./award-fact-evidence-audit.mjs";

const CLI_PATH = fileURLToPath(new URL("../report-award-fact-evidence.mjs", import.meta.url));

function rowFor(rows, fieldName, valueIndex = 0) {
  const row = rows.find((item) => item.fieldName === fieldName && item.valueIndex === valueIndex);
  expect(row, `row for ${fieldName}[${valueIndex}]`).toBeDefined();
  return row;
}

function runCli(args, input) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], { input, encoding: "utf8" });
}

/** A source in the shape production actually writes. */
function productionSource(id, quotes, extra = {}) {
  return { id, url: `https://example.edu/${id}`, page_metadata: { baseline_facts: { evidence_quotes: quotes } }, ...extra };
}

describe("award fact evidence audit", () => {
  it("characterizes the shared first-page quote while a matching quote sits unused", () => {
    // The reconciler stamps one page-level quote on every field from a source.
    // This pins that shape as observable, without asserting it is a fix.
    const sources = [productionSource("source-1", [
      "Applications open in mid-August.",
      "The student deadline is October 1, 2026 at 11:59 p.m. PT.",
    ])];
    const candidates = [
      {
        field_name: "opening_date",
        raw_value: "Mid-August 2026",
        evidence_quote: "Applications open in mid-August.",
        shared_award_source_id: "source-1",
      },
      {
        field_name: "deadline",
        raw_value: "October 1, 2026 at 11:59 p.m. PT",
        evidence_quote: "Applications open in mid-August.",
        shared_award_source_id: "source-1",
      },
    ];

    const { rows, caveat, schemaVersion } = auditCandidateEvidence(candidates, sources);
    expect(schemaVersion).toBe(AUDIT_SCHEMA_VERSION);
    expect(caveat).toBe(REVIEW_CAVEAT);

    const deadline = rowFor(rows, "deadline");
    expect(deadline.assignedQuote).toBe("Applications open in mid-August.");
    expect(deadline.quoteAvailability).toEqual({
      status: "known",
      count: 2,
      containers: [{ path: "page_metadata.baseline_facts.evidence_quotes", kind: "array", count: 2 }],
    });
    expect(deadline.sharedWithFields).toEqual(["opening_date"]);
    expect(deadline.flags.assignedQuoteSharedAcrossFields).toBe(true);
    expect(deadline.flags.assignedQuoteContainsValueItem).toBe(false);
    expect(deadline.flags.otherSourceQuotesContainValueItem).toBe(true);
    // The unused quote is named by position only; it is a place to look, and
    // the audit never promotes it to the candidate's evidence.
    expect(deadline.otherQuotesContainingValueItem).toEqual([1]);
    expect(Object.keys(deadline)).not.toContain("attribution");
  });

  it("flags a genuine assigned lexical match without calling it verified", () => {
    const rows = auditCandidateEvidence(
      [{
        field_name: "deadline",
        raw_value: "October 1, 2026",
        evidence_quote: "The student deadline is October 1, 2026.",
        shared_award_source_id: "source-1",
      }],
      [productionSource("source-1", ["The student deadline is October 1, 2026."])],
    ).rows;

    const row = rowFor(rows, "deadline");
    expect(row.flags.assignedQuoteContainsValueItem).toBe(true);
    expect(row.flags.otherSourceQuotesContainValueItem).toBe(false);
    expect(row.flags.assignedQuoteSharedAcrossFields).toBe(false);
    for (const key of ["score", "confidence", "overlap", "verified", "supported", "pass"]) {
      expect(Object.keys(row)).not.toContain(key);
      expect(Object.keys(row.flags)).not.toContain(key);
    }
  });

  it("still only hints when one date is repeated across rounds and past cycles", () => {
    const quote = "Fall 2026 deadline: October 1, 2026. The Fall 2025 deadline was October 1, 2025.";
    const rows = auditCandidateEvidence(
      [{ field_name: "deadline", raw_value: "October 1, 2025", evidence_quote: quote, shared_award_source_id: "source-1" }],
      [productionSource("source-1", [quote])],
    ).rows;

    // The quote does contain the value, and the value is nonetheless a prior
    // cycle. Containment is exactly why this row needs a human, not less.
    expect(rowFor(rows, "deadline").flags.assignedQuoteContainsValueItem).toBe(true);
    expect(REVIEW_CAVEAT).toMatch(/different round/i);
  });

  it("keeps round qualifiers and punctuation significant when comparing", () => {
    const quote = "The deadline is October 1, 2026 (Fall 2026 Application).";
    const rows = auditCandidateEvidence(
      [{
        field_name: "deadline",
        raw_value: "October 1, 2026 (Spring 2027 Application)",
        evidence_quote: quote,
        shared_award_source_id: "source-1",
      }],
      [productionSource("source-1", [quote])],
    ).rows;

    // Same date, different round: the qualifier must break containment.
    expect(rowFor(rows, "deadline").flags.assignedQuoteContainsValueItem).toBe(false);
  });

  it("reports one row per list item rather than judging the list by its first entry", () => {
    const rows = auditCandidateEvidence(
      [{
        field_name: "important_dates",
        raw_value: ["Advisor certification: March 4, 2027", "Applicant notification: May 2027"],
        evidence_quote: "Advisor certification: March 4, 2027.",
        shared_award_source_id: "source-1",
      }],
      [productionSource("source-1", ["Advisor certification: March 4, 2027."])],
    ).rows;

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.valueIndex)).toEqual([0, 1]);
    expect(rows.every((row) => row.valueItemCount === 2)).toBe(true);
    expect(rowFor(rows, "important_dates", 0).flags.assignedQuoteContainsValueItem).toBe(true);
    expect(rowFor(rows, "important_dates", 1).flags.assignedQuoteContainsValueItem).toBe(false);
  });

  it("keeps an empty list candidate visible with its own reason", () => {
    const rows = auditCandidateEvidence(
      [{ field_name: "documents", raw_value: [], evidence_quote: "Q.", shared_award_source_id: "source-1" }],
      [productionSource("source-1", ["Q."])],
    ).rows;

    // The candidate proposed nothing; it must not vanish from the counts.
    expect(rows).toHaveLength(1);
    const row = rowFor(rows, "documents");
    expect(row.valueItemKind).toBe("empty_list");
    expect(row.unassessedReason).toBe("empty_list_value");
    expect(row.valueItemComparable).toBe(false);
    expect(row.flags.valueItemNotComparable).toBe(true);
    expect(row.flags.assignedQuoteContainsValueItem).toBe(false);

    const summary = summarizeEvidenceAudit(rows);
    expect(summary.candidatesSeen).toBe(1);
    expect(summary.valueItemsAssessed).toBe(0);
    expect(summary.valueItemsUnassessed).toBe(1);
    expect(summary.noCandidatesProvided).toBe(false);
    expect(summary.reasonCounts).toEqual({ empty_list_value: 1 });
  });

  it("refuses object and nested-array values instead of comparing [object Object]", () => {
    const rows = auditCandidateEvidence(
      [
        { field_name: "deadline", raw_value: { when: "October 1, 2026" }, evidence_quote: "Q.", shared_award_source_id: "source-1" },
        { field_name: "important_dates", raw_value: [["nested"]], evidence_quote: "Q.", shared_award_source_id: "source-1" },
      ],
      [productionSource("source-1", ["Q."])],
    ).rows;

    const objectRow = rowFor(rows, "deadline");
    expect(objectRow.valueItemKind).toBe("object");
    expect(objectRow.unassessedReason).toBe("object_value");
    expect(objectRow.valueItemText).toBeNull();
    expect(objectRow.valueItemRaw).toBeNull();
    expect(objectRow.flags.assignedQuoteContainsValueItem).toBe(false);
    expect(JSON.stringify(objectRow)).not.toContain("[object Object]");

    const nestedRow = rowFor(rows, "important_dates");
    expect(nestedRow.valueItemKind).toBe("array");
    expect(nestedRow.unassessedReason).toBe("nested_array_value");
  });

  it("distinguishes a missing quote, a paraphrase, and non-text values", () => {
    const rows = auditCandidateEvidence(
      [
        { field_name: "deadline", raw_value: "October 1, 2026", evidence_quote: null, shared_award_source_id: "source-1" },
        {
          field_name: "opening_date",
          raw_value: "Mid-August 2026",
          evidence_quote: "Applications become available partway through August.",
          shared_award_source_id: "source-1",
        },
        { field_name: "tenure", raw_value: null, evidence_quote: "Anything.", shared_award_source_id: "source-1" },
        { field_name: "stipend", raw_value: 7500, evidence_quote: "The award is 7500 per year.", shared_award_source_id: "source-1" },
      ],
      [productionSource("source-1", ["Applications become available partway through August."])],
    ).rows;

    expect(rowFor(rows, "deadline").flags.noAssignedQuote).toBe(true);
    expect(rowFor(rows, "deadline").flags.assignedQuoteBlank).toBe(false);

    // A correct paraphrase produces no match; that is not a defect signal.
    expect(rowFor(rows, "opening_date").flags.noAssignedQuote).toBe(false);
    expect(rowFor(rows, "opening_date").flags.assignedQuoteContainsValueItem).toBe(false);

    expect(rowFor(rows, "tenure").valueItemKind).toBe("null");
    expect(rowFor(rows, "tenure").unassessedReason).toBe("null_value");

    // A number is preserved as given and never coerced into comparable text,
    // so a numeric coincidence inside a quote cannot look like coverage.
    const stipend = rowFor(rows, "stipend");
    expect(stipend.valueItemRaw).toBe(7500);
    expect(stipend.valueItemText).toBeNull();
    expect(stipend.valueItemComparable).toBe(false);
    expect(stipend.unassessedReason).toBe("non_text_value");
    expect(stipend.flags.assignedQuoteContainsValueItem).toBe(false);
  });

  it("treats a whitespace-only quote as absent while keeping the distinction", () => {
    const rows = auditCandidateEvidence(
      [{ field_name: "deadline", raw_value: "x", evidence_quote: "   \n\t ", shared_award_source_id: "source-1" }],
      [productionSource("source-1", ["Q."])],
    ).rows;

    const row = rowFor(rows, "deadline");
    expect(row.assignedQuote).toBeNull();
    expect(row.flags.noAssignedQuote).toBe(true);
    expect(row.flags.assignedQuoteBlank).toBe(true);
    expect(row.flags.assignedQuoteSharedAcrossFields).toBe(false);
  });

  it("keeps original non-blank quote text exactly, including its own spacing", () => {
    const quote = "  The student deadline is October 1, 2026.  ";
    const rows = auditCandidateEvidence(
      [{ field_name: "deadline", raw_value: "October 1, 2026", evidence_quote: quote, shared_award_source_id: "source-1" }],
      [productionSource("source-1", [quote])],
    ).rows;

    const row = rowFor(rows, "deadline");
    expect(row.assignedQuote).toBe(quote);
    expect(row.flags.assignedQuoteBlank).toBe(false);
    expect(row.flags.assignedQuoteContainsValueItem).toBe(true);
  });

  it("reports malformed candidates as explicit rows instead of skipping them", () => {
    const rows = auditCandidateEvidence(
      [null, "candidate", ["a"], { field_name: "", raw_value: "x", shared_award_source_id: "source-1" }],
      [productionSource("source-1", ["Q."])],
    ).rows;

    expect(rows).toHaveLength(4);
    expect(rows[0].unassessedReason).toBe("candidate_not_object");
    expect(rows[1].unassessedReason).toBe("candidate_not_object");
    expect(rows[2].unassessedReason).toBe("candidate_is_array");
    expect(rows.slice(0, 3).every((row) => row.flags.candidateShapeInvalid)).toBe(true);
    expect(rows[3].fieldName).toBeNull();
    expect(rows[3].unassessedReason).toBe("invalid_field_name");
    expect(summarizeEvidenceAudit(rows).candidatesSeen).toBe(4);
  });

  it("refuses a non-string identifier and never collides 1 with \"1\"", () => {
    const rows = auditCandidateEvidence(
      [
        { field_name: "deadline", raw_value: "x", evidence_quote: "Q.", shared_award_source_id: 1 },
        { field_name: "opening_date", raw_value: "x", evidence_quote: "Q.", shared_award_source_id: "1" },
      ],
      [{ id: "1", page_metadata: { baseline_facts: { evidence_quotes: ["Q."] } } }],
    ).rows;

    const numeric = rowFor(rows, "deadline");
    expect(numeric.sourceResolution).toBe("invalid_identifier");
    expect(numeric.flags.sourceBindingMissingOrAmbiguous).toBe(true);
    expect(numeric.quoteAvailability.status).toBe("unresolved_source");

    // The string-keyed candidate resolves on its own and shares with nobody,
    // because sharing is indexed by the resolved source, not by String(id).
    const text = rowFor(rows, "opening_date");
    expect(text.sourceResolution).toBe("resolved");
    expect(text.flags.assignedQuoteSharedAcrossFields).toBe(false);
    expect(text.sharedWithFields).toEqual([]);
  });

  it("reports absent, unknown and duplicated source identities without guessing", () => {
    const sources = [
      productionSource("dup", ["A."]),
      productionSource("dup", ["B.", "C."]),
      productionSource("only", ["C."]),
    ];
    const rows = auditCandidateEvidence(
      [
        { field_name: "deadline", raw_value: "x", evidence_quote: "A.", shared_award_source_id: null },
        { field_name: "opening_date", raw_value: "x", evidence_quote: "A.", shared_award_source_id: "missing" },
        { field_name: "overview", raw_value: "x", evidence_quote: "A.", shared_award_source_id: "dup" },
      ],
      sources,
    ).rows;

    expect(rowFor(rows, "deadline").sourceResolution).toBe("absent");
    expect(rowFor(rows, "opening_date").sourceResolution).toBe("unmatched");
    expect(rowFor(rows, "overview").sourceResolution).toBe("duplicate");
    expect(rowFor(rows, "overview").sourceIdMatchCount).toBe(2);
    for (const field of ["deadline", "opening_date", "overview"]) {
      const row = rowFor(rows, field);
      expect(row.flags.sourceBindingMissingOrAmbiguous).toBe(true);
      // No sibling or URL fallback: an unresolved binding exposes no source
      // and, crucially, no quote count that could be read as a known zero.
      expect(row.sourceUrl).toBeNull();
      expect(row.quoteAvailability).toEqual({ status: "unresolved_source", count: null, containers: [] });
      expect(row.flags.quoteAvailabilityNotKnown).toBe(true);
    }
  });

  it("does not share a quote across two sources that happen to say the same thing", () => {
    const rows = auditCandidateEvidence(
      [
        { field_name: "deadline", raw_value: "x", evidence_quote: "Same sentence.", shared_award_source_id: "source-1" },
        { field_name: "opening_date", raw_value: "x", evidence_quote: "Same sentence.", shared_award_source_id: "source-2" },
      ],
      [productionSource("source-1", ["Same sentence."]), productionSource("source-2", ["Same sentence."])],
    ).rows;

    expect(rowFor(rows, "deadline").flags.assignedQuoteSharedAcrossFields).toBe(false);
    expect(rowFor(rows, "opening_date").flags.assignedQuoteSharedAcrossFields).toBe(false);
  });

  it("flags an apparently truncated quote so a lost match is not read as absent", () => {
    const long = `${"The student deadline is stated in the paragraph below. ".repeat(6)}...`;
    const rows = auditCandidateEvidence(
      [{ field_name: "deadline", raw_value: "October 1, 2026", evidence_quote: long, shared_award_source_id: "source-1" }],
      [productionSource("source-1", [long])],
    ).rows;

    const row = rowFor(rows, "deadline");
    expect(row.flags.assignedQuoteApparentlyTruncated).toBe(true);
    expect(row.flags.assignedQuoteContainsValueItem).toBe(false);
  });
});

describe("award fact evidence quote availability", () => {
  it("reads the production page_metadata.baseline_facts shape", () => {
    const rows = auditCandidateEvidence(
      [{ field_name: "deadline", raw_value: "x", evidence_quote: "One.", shared_award_source_id: "s" }],
      [productionSource("s", ["One.", "Two.", "Three."])],
    ).rows;

    const row = rowFor(rows, "deadline");
    expect(row.quoteAvailability.status).toBe("known");
    expect(row.quoteAvailability.count).toBe(3);
    expect(row.quoteAvailability.containers[0].path).toBe("page_metadata.baseline_facts.evidence_quotes");
    expect(row.flags.quoteAvailabilityNotKnown).toBe(false);
  });

  it("documents every consulted path and reads the camel and legacy shapes", () => {
    expect(QUOTE_CONTAINER_PATHS.map((path) => path.join("."))).toEqual([
      "evidence_quotes",
      "baseline_facts.evidence_quotes",
      "page_metadata.baseline_facts.evidence_quotes",
      "page_metadata.baselineFacts.evidence_quotes",
      "page_metadata.evidence_quotes",
    ]);

    const camel = auditCandidateEvidence(
      [{ field_name: "deadline", raw_value: "x", evidence_quote: "Q.", shared_award_source_id: "s" }],
      [{ id: "s", page_metadata: { baselineFacts: { evidence_quotes: ["Q.", "R."] } } }],
    ).rows;
    expect(rowFor(camel, "deadline").quoteAvailability.count).toBe(2);

    const legacy = auditCandidateEvidence(
      [{ field_name: "deadline", raw_value: "x", evidence_quote: "Q.", shared_award_source_id: "s" }],
      [{ id: "s", page_metadata: { evidence_quotes: ["Q."] } }],
    ).rows;
    expect(rowFor(legacy, "deadline").quoteAvailability.count).toBe(1);
  });

  it("separates a missing container from a genuine zero", () => {
    const missing = auditCandidateEvidence(
      [{ field_name: "deadline", raw_value: "x", evidence_quote: "Q.", shared_award_source_id: "s" }],
      [{ id: "s", url: "https://example.edu/s" }],
    ).rows;
    const missingRow = rowFor(missing, "deadline");
    expect(missingRow.quoteAvailability).toEqual({ status: "unknown", count: null, containers: [] });
    expect(missingRow.flags.quoteAvailabilityNotKnown).toBe(true);

    const zero = auditCandidateEvidence(
      [{ field_name: "deadline", raw_value: "x", evidence_quote: "Q.", shared_award_source_id: "s" }],
      [productionSource("s", [])],
    ).rows;
    const zeroRow = rowFor(zero, "deadline");
    expect(zeroRow.quoteAvailability.status).toBe("known");
    expect(zeroRow.quoteAvailability.count).toBe(0);
    expect(zeroRow.flags.quoteAvailabilityNotKnown).toBe(false);
  });

  it("flags an unusable container shape rather than reporting zero quotes", () => {
    const rows = auditCandidateEvidence(
      [{ field_name: "deadline", raw_value: "x", evidence_quote: "Q.", shared_award_source_id: "s" }],
      [{ id: "s", page_metadata: { baseline_facts: { evidence_quotes: "Q." } } }],
    ).rows;

    const row = rowFor(rows, "deadline");
    expect(row.quoteAvailability.status).toBe("invalid");
    expect(row.quoteAvailability.count).toBeNull();
    expect(row.quoteAvailability.containers).toEqual([
      { path: "page_metadata.baseline_facts.evidence_quotes", kind: "string", count: null },
    ]);
  });

  it.each([
    { label: "null entries", quotes: [null] },
    { label: "non-string entries", quotes: [3, false, {}, ["nested"]] },
    { label: "blank entries", quotes: ["", "  \n\t "] },
    { label: "the four unusable entries from review", quotes: [null, 3, {}, "  "] },
    { label: "mixed valid and invalid entries", quotes: ["The deadline is October 1, 2026.", null] },
  ])("does not claim known quote availability for $label", ({ quotes }) => {
    const document = {
      schemaVersion: 1,
      awards: [{
        id: "award-a",
        candidates: [{ field_name: "deadline", raw_value: "October 1, 2026", evidence_quote: "Different assigned wording.", shared_award_source_id: "s" }],
        sources: [productionSource("s", quotes)],
      }],
    };
    const before = structuredClone(document);
    const report = auditAwards(parseAuditInput(document))[0];
    const row = rowFor(report.rows, "deadline");
    expect(row.quoteAvailability.status).toBe("invalid");
    expect(row.quoteAvailability.count).toBeNull();
    expect(row.flags.quoteAvailabilityNotKnown).toBe(true);
    expect(row.otherQuotesContainingValueItem).toEqual([]);
    expect(row.flags.otherSourceQuotesContainValueItem).toBe(false);
    expect(report.summary.availabilityCounts).toEqual({ invalid: 1 });
    expect(document).toEqual(before);
  });

  it("flags disagreeing containers instead of preferring one, including empty over populated", () => {
    const rows = auditCandidateEvidence(
      [{ field_name: "deadline", raw_value: "October 1, 2026", evidence_quote: "Q.", shared_award_source_id: "s" }],
      [{
        id: "s",
        // The reviewer's case: a top-level empty list beside a populated
        // production container. Neither wins; the row says so.
        evidence_quotes: [],
        page_metadata: { baseline_facts: { evidence_quotes: ["The student deadline is October 1, 2026."] } },
      }],
    ).rows;

    const row = rowFor(rows, "deadline");
    expect(row.quoteAvailability.status).toBe("ambiguous");
    expect(row.quoteAvailability.count).toBeNull();
    expect(row.quoteAvailability.containers).toEqual([
      { path: "evidence_quotes", kind: "array", count: 0 },
      { path: "page_metadata.baseline_facts.evidence_quotes", kind: "array", count: 1 },
    ]);
    expect(row.flags.quoteAvailabilityNotKnown).toBe(true);
    // Ambiguity must not be resolved into a lexical claim either way.
    expect(row.otherQuotesContainingValueItem).toEqual([]);
    expect(row.flags.otherSourceQuotesContainValueItem).toBe(false);
  });

  it("treats identical duplicate containers as agreement, not ambiguity", () => {
    const rows = auditCandidateEvidence(
      [{ field_name: "deadline", raw_value: "x", evidence_quote: "Q.", shared_award_source_id: "s" }],
      [{ id: "s", evidence_quotes: ["Q."], page_metadata: { baseline_facts: { evidence_quotes: ["Q."] } } }],
    ).rows;

    expect(rowFor(rows, "deadline").quoteAvailability.status).toBe("known");
    expect(rowFor(rows, "deadline").quoteAvailability.count).toBe(1);
  });
});

describe("award fact evidence audit purity and summary", () => {
  it("never mutates its inputs and returns the same result on repeat calls", () => {
    const candidates = [{
      field_name: "deadline",
      raw_value: ["October 1, 2026", "February 25, 2027"],
      evidence_quote: "The student deadline is October 1, 2026.",
      shared_award_source_id: "source-1",
    }];
    const sources = [productionSource("source-1", ["The student deadline is October 1, 2026."])];
    const candidatesBefore = structuredClone(candidates);
    const sourcesBefore = structuredClone(sources);

    const first = auditCandidateEvidence(candidates, sources);
    const second = auditCandidateEvidence(candidates, sources);

    expect(candidates).toEqual(candidatesBefore);
    expect(sources).toEqual(sourcesBefore);
    // No clock, counter or randomness: identical input, identical output.
    expect(second).toEqual(first);
  });

  it("performs no IO and reads no clock", () => {
    const source = readFileSync(new URL("./award-fact-evidence-audit.mjs", import.meta.url), "utf8");
    expect(source).not.toMatch(/^import\s/m);
    expect(source).not.toMatch(/require\(/);
    expect(source).not.toMatch(/\bnew Date\b|\bDate\.now\b|\bMath\.random\b|\bprocess\.env\b/);
  });

  it("counts flags and reasons independently and never blesses an empty input", () => {
    const empty = summarizeEvidenceAudit(auditCandidateEvidence([], []).rows);
    expect(empty.rowsProduced).toBe(0);
    expect(empty.candidatesSeen).toBe(0);
    expect(empty.noCandidatesProvided).toBe(true);
    expect(empty.caveat).toBe(REVIEW_CAVEAT);
    expect(Object.keys(empty)).not.toContain("ok");

    const rows = auditCandidateEvidence(
      [
        { field_name: "deadline", raw_value: "x", evidence_quote: "Q.", shared_award_source_id: "source-1" },
        { field_name: "opening_date", raw_value: "x", evidence_quote: "Q.", shared_award_source_id: "source-1" },
        { field_name: "overview", raw_value: "y", evidence_quote: null, shared_award_source_id: "gone" },
      ],
      [productionSource("source-1", ["Q."])],
    ).rows;
    const summary = summarizeEvidenceAudit(rows);
    expect(summary.rowsProduced).toBe(3);
    expect(summary.candidatesSeen).toBe(3);
    expect(summary.valueItemsAssessed).toBe(3);
    expect(summary.flagCounts.assignedQuoteSharedAcrossFields).toBe(2);
    expect(summary.flagCounts.noAssignedQuote).toBe(1);
    expect(summary.flagCounts.sourceBindingMissingOrAmbiguous).toBe(1);
    expect(summary.availabilityCounts).toEqual({ known: 2, unresolved_source: 1 });
  });

  it.each([null, " \t", 7])("counts every item with invalid field_name %j as unassessed", (fieldName) => {
    const rows = auditCandidateEvidence(
      [
        { field_name: fieldName, raw_value: ["October 1, 2026", "March 4, 2027"], evidence_quote: "October 1, 2026 and March 4, 2027.", shared_award_source_id: "s" },
        { field_name: "deadline", raw_value: "October 1, 2026", evidence_quote: "October 1, 2026.", shared_award_source_id: "s" },
      ],
      [productionSource("s", ["October 1, 2026 and March 4, 2027."])],
    ).rows;
    expect(rows).toHaveLength(3);
    expect(rows.slice(0, 2).map((row) => row.valueItemText)).toEqual(["October 1, 2026", "March 4, 2027"]);
    for (const row of rows.slice(0, 2)) {
      expect(row.candidateValid).toBe(false);
      expect(row.fieldName).toBeNull();
      expect(row.unassessedReason).toBe("invalid_field_name");
      expect(row.flags.candidateShapeInvalid).toBe(true);
    }
    const summary = summarizeEvidenceAudit(rows);
    expect(summary.rowsProduced).toBe(3);
    expect(summary.candidatesSeen).toBe(2);
    expect(summary.valueItemsAssessed).toBe(1);
    expect(summary.valueItemsUnassessed).toBe(2);
    expect(summary.reasonCounts).toEqual({ invalid_field_name: 2 });
    expect(summary.fieldsSeen).toEqual(["deadline"]);
    expect(summary.noCandidatesProvided).toBe(false);
  });

  it("rejects malformed input shapes with a named reason", () => {
    expect(() => parseAuditInput(null)).toThrow(/must be a JSON object/);
    expect(() => parseAuditInput([])).toThrow(/must be a JSON object/);
    expect(() => parseAuditInput({ awards: [] })).toThrow(/schemaVersion must be 1/);
    expect(() => parseAuditInput({ schemaVersion: 2, awards: [] })).toThrow(/schemaVersion must be 1/);
    expect(() => parseAuditInput({ schemaVersion: 1 })).toThrow(/awards must be an array/);
    expect(() => parseAuditInput({ schemaVersion: 1, awards: [{ id: "a", candidates: [] }] }))
      .toThrow(/awards\[0\]\.sources must be an array/);
    expect(() => parseAuditInput({ schemaVersion: 1, awards: [{ candidates: [], sources: [] }] }))
      .toThrow(/awards\[0\]\.id must be a non-empty string/);
    expect(() => parseAuditInput({ schemaVersion: 1, awards: [{ id: "a", candidates: [], sources: [null] }] }))
      .toThrow(/awards\[0\]\.sources\[0\] must be an object/);
    expect(() => parseAuditInput({ schemaVersion: 1, awards: [{ id: "a", candidates: [], sources: [{ id: 7 }] }] }))
      .toThrow(/sources\[0\]\.id must be a non-empty string when present/);
    expect(parseAuditInput({ schemaVersion: 1, awards: [] })).toEqual([]);
  });

  it("audits each award separately, in input order", () => {
    const reports = auditAwards([
      {
        id: "award-a",
        name: "A",
        candidates: [{ field_name: "deadline", raw_value: "x", evidence_quote: "Q.", shared_award_source_id: "s1" }],
        sources: [productionSource("s1", ["Q."])],
      },
      { id: "award-b", candidates: [], sources: [] },
    ]);

    expect(reports.map((report) => report.awardId)).toEqual(["award-a", "award-b"]);
    expect(reports[0].summary.candidatesSeen).toBe(1);
    expect(reports[1].summary.noCandidatesProvided).toBe(true);
    expect(reports[1].awardName).toBeNull();
  });
});

describe("award fact evidence report CLI", () => {
  const document = {
    schemaVersion: 1,
    awards: [{
      id: "award-a",
      name: "Example Award",
      candidates: [
        { field_name: "opening_date", raw_value: "Mid-August 2026", evidence_quote: "Applications open in mid-August.", shared_award_source_id: "s1" },
        { field_name: "deadline", raw_value: "October 1, 2026", evidence_quote: "Applications open in mid-August.", shared_award_source_id: "s1" },
      ],
      sources: [productionSource("s1", ["Applications open in mid-August.", "The student deadline is October 1, 2026."])],
    }],
  };

  it("reads stdin and reports the shared quote and the unused matching quote", () => {
    const result = runCli(["--input", "-"], JSON.stringify(document));
    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.caveat).toBe(REVIEW_CAVEAT);
    expect(payload.noCandidatesProvided).toBe(false);
    expect(payload.quoteContainerPaths).toContain("page_metadata.baseline_facts.evidence_quotes");
    const deadline = payload.reports[0].rows.find((row) => row.fieldName === "deadline");
    expect(deadline.flags.assignedQuoteSharedAcrossFields).toBe(true);
    expect(deadline.otherQuotesContainingValueItem).toEqual([1]);
  });

  it("prints a table that carries the caveat and no verdict wording", () => {
    const result = runCli(["--input", "-", "--format", "table"], JSON.stringify(document));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(REVIEW_CAVEAT);
    expect(result.stdout).toContain("assignedQuoteSharedAcrossFields");
    expect(result.stdout).toContain("quotes=2");
    expect(result.stdout).not.toMatch(/\bverified\b|\bpublication-ready\b/i);
  });

  it("says no candidates were provided only when none were", () => {
    const none = runCli(["--input", "-", "--format", "table"], JSON.stringify({ schemaVersion: 1, awards: [] }));
    expect(none.status).toBe(0);
    expect(none.stdout).toContain("no candidates were provided");

    const unassessable = runCli(["--input", "-", "--format", "table"], JSON.stringify({
      schemaVersion: 1,
      awards: [{ id: "a", candidates: [{ field_name: "documents", raw_value: [] }], sources: [] }],
    }));
    expect(unassessable.status).toBe(0);
    expect(unassessable.stdout).not.toContain("no candidates were provided");
    expect(unassessable.stdout).toContain("reason empty_list_value: 1");
  });

  it("fails cleanly on malformed input, bad flags, and missing input", () => {
    const badJson = runCli(["--input", "-"], "{not json");
    expect(badJson.status).toBe(1);
    expect(badJson.stderr).toMatch(/not valid JSON/);

    const badShape = runCli(["--input", "-"], JSON.stringify({ schemaVersion: 9, awards: [] }));
    expect(badShape.status).toBe(1);
    expect(badShape.stderr).toMatch(/schemaVersion must be 1/);

    const badFormat = runCli(["--input", "-", "--format", "csv"], "{}");
    expect(badFormat.status).toBe(1);
    expect(badFormat.stderr).toMatch(/--format must be json or table/);

    const noInput = runCli([], "");
    expect(noInput.status).toBe(1);
    expect(noInput.stderr).toMatch(/--input .* is required/);
  });

  it("documents the input shape, every quote path, and the caveat in --help", () => {
    const result = runCli(["--help"], "");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('"schemaVersion": 1');
    for (const path of QUOTE_CONTAINER_PATHS) expect(result.stdout).toContain(path.join("."));
    expect(result.stdout).toContain("reported as a count of zero");
    expect(result.stdout).toContain(REVIEW_CAVEAT);
    expect(result.stdout).toContain("not success");
  });
});

describe("award fact evidence candidate lifecycle context", () => {
  const source = productionSource("s", ["Q."]);
  const candidateWith = (overrides) => ({
    field_name: "deadline",
    raw_value: "x",
    evidence_quote: "Q.",
    shared_award_source_id: "s",
    ...overrides,
  });

  it("names every lifecycle status the candidate table allows", () => {
    expect([...KNOWN_CANDIDATE_STATUSES]).toEqual([
      "pending", "selected", "rejected", "conflicted", "superseded",
    ]);
  });

  it("exports an immutable catalogue that cannot change lifecycle recognition", () => {
    const candidates = [candidateWith({ candidate_status: "published" }), candidateWith({ candidate_status: "selected" })];
    const before = auditCandidateEvidence(candidates, [source]).rows.map((row) => row.candidateStatus);
    expect(Array.isArray(KNOWN_CANDIDATE_STATUSES)).toBe(true);
    expect(Object.isFrozen(KNOWN_CANDIDATE_STATUSES)).toBe(true);
    expect(() => KNOWN_CANDIDATE_STATUSES.push("published")).toThrow(TypeError);
    expect(() => KNOWN_CANDIDATE_STATUSES.splice(0, 1)).toThrow(TypeError);
    expect(Reflect.set(KNOWN_CANDIDATE_STATUSES, "0", "published")).toBe(false);
    expect(Reflect.deleteProperty(KNOWN_CANDIDATE_STATUSES, "1")).toBe(false);
    expect([...KNOWN_CANDIDATE_STATUSES]).toEqual(["pending", "selected", "rejected", "conflicted", "superseded"]);
    expect(auditCandidateEvidence(candidates, [source]).rows.map((row) => row.candidateStatus)).toEqual(before);
    expect(before).toEqual([
      { raw: "published", recognition: "unknown", known: null },
      { raw: "selected", recognition: "known", known: "selected" },
    ]);
  });

  it("recognizes each known status and keeps the literal input", () => {
    for (const status of KNOWN_CANDIDATE_STATUSES) {
      const rows = auditCandidateEvidence([candidateWith({ candidate_status: status })], [source]).rows;
      expect(rows[0].candidateStatus).toEqual({ raw: status, recognition: "known", known: status });
    }
  });

  it("separates missing, unknown and malformed statuses without mapping them to a known one", () => {
    const cases = [
      { given: {}, raw: null, recognition: "missing" },
      { given: { candidate_status: null }, raw: null, recognition: "missing" },
      { given: { candidate_status: "archived" }, raw: "archived", recognition: "unknown" },
      // Trimming would be a silent normalization, so a padded value stays unknown.
      { given: { candidate_status: " selected " }, raw: " selected ", recognition: "unknown" },
      { given: { candidate_status: "SELECTED" }, raw: "SELECTED", recognition: "unknown" },
      { given: { candidate_status: "" }, raw: "", recognition: "invalid" },
      { given: { candidate_status: "   " }, raw: "   ", recognition: "invalid" },
      { given: { candidate_status: 3 }, raw: 3, recognition: "invalid" },
      { given: { candidate_status: { state: "selected" } }, raw: { state: "selected" }, recognition: "invalid" },
      { given: { candidate_status: ["selected"] }, raw: ["selected"], recognition: "invalid" },
    ];
    for (const { given, raw, recognition } of cases) {
      const rows = auditCandidateEvidence([candidateWith(given)], [source]).rows;
      expect(rows[0].candidateStatus, JSON.stringify(given)).toEqual({ raw, recognition, known: null });
    }
  });

  it("counts a multi-item list candidate once, not once per value item", () => {
    const rows = auditCandidateEvidence(
      [candidateWith({ candidate_status: "selected", raw_value: ["a", "b", "c"] })],
      [source],
    ).rows;

    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.candidateStatus.known === "selected")).toBe(true);

    const summary = summarizeEvidenceAudit(rows);
    expect(summary.candidateStatusCounts).toEqual({ selected: 1 });
    expect(summary.candidateStatusRecognitionCounts).toEqual({ known: 1, missing: 0, unknown: 0, invalid: 0 });
    expect(summary.candidateStatusConflictCount).toBe(0);
    // The row-level totals stay per value item, as they were.
    expect(summary.rowsProduced).toBe(3);
    expect(summary.candidatesSeen).toBe(1);
  });

  it.each([
    { label: "forged known name", status: { raw: "selected", recognition: "known", known: "published" }, recognition: "known", counts: { selected: 1 } },
    { label: "unknown raw promoted to selected", status: { raw: "archived", recognition: "known", known: "selected" }, recognition: "unknown", counts: {} },
    { label: "prototype-like derived labels", status: { raw: "selected", recognition: "toString", known: "constructor" }, recognition: "known", counts: { selected: 1 } },
    { label: "prototype-like raw text", status: { raw: "constructor", recognition: "known", known: "constructor" }, recognition: "unknown", counts: {} },
    { label: "padded raw text", status: { raw: " selected ", recognition: "known", known: "selected" }, recognition: "unknown", counts: {} },
    { label: "non-string raw value", status: { raw: { state: "selected" }, recognition: "known", known: "selected" }, recognition: "invalid", counts: {} },
    { label: "missing raw value", status: { recognition: "known", known: "selected" }, recognition: "missing", counts: {} },
  ])("recomputes summary lifecycle from raw for $label", ({ status, recognition, counts }) => {
    const rows = auditCandidateEvidence([candidateWith({ raw_value: ["a", "b"] })], [source]).rows
      .map((row) => ({ ...row, candidateStatus: structuredClone(status) }));
    const before = structuredClone(rows);
    const summary = summarizeEvidenceAudit(rows);
    expect(summary.candidateStatusCounts).toEqual(counts);
    expect(summary.candidateStatusRecognitionCounts).toEqual({
      known: 0, missing: 0, unknown: 0, invalid: 0, [recognition]: 1,
    });
    expect(summary.candidatesSeen).toBe(1);
    expect(summary.rowsProduced).toBe(2);
    expect(Object.values(summary.candidateStatusRecognitionCounts).every(Number.isInteger)).toBe(true);
    expect(rows).toEqual(before);
  });

  it("counts legacy rows without lifecycle metadata as missing once per candidate", () => {
    const rows = auditCandidateEvidence([candidateWith({ raw_value: ["a", "b"] })], [source]).rows
      .map(({ candidateStatus, ...row }) => {
        expect(candidateStatus).toBeDefined();
        return row;
      });
    const summary = summarizeEvidenceAudit(rows);
    expect(summary.candidateStatusCounts).toEqual({});
    expect(summary.candidateStatusRecognitionCounts).toEqual({ known: 0, missing: 1, unknown: 0, invalid: 0 });
  });

  it.each([
    { label: "different known lifecycles", statuses: ["selected", "rejected", "selected"] },
    { label: "different unknown literal lifecycles", statuses: ["archived", "held", "archived"] },
    { label: "known versus missing lifecycle", statuses: ["selected", null, "selected"] },
  ])("keeps a per-candidate conflict sticky for $label", ({ statuses }) => {
    const rows = statuses.map((status) => auditCandidateEvidence(
      [candidateWith({ candidate_status: status })], [source],
    ).rows[0]);
    // Each row describes candidateIndex 0. Returning to its first status does
    // not erase the contradiction introduced by the middle row.
    const before = structuredClone(rows);
    const summary = summarizeEvidenceAudit(rows);
    expect(summary.candidatesSeen).toBe(1);
    expect(summary.candidateStatusCounts).toEqual({});
    expect(summary.candidateStatusRecognitionCounts).toEqual({ known: 0, missing: 0, unknown: 0, invalid: 1 });
    expect(summary.candidateStatusConflictCount).toBe(1);
    expect(rows).toEqual(before);
  });

  it("does not invent a conflict from distinct malformed raw object identities", () => {
    const rows = [{ state: "selected" }, { other: "rejected" }].map((status) => auditCandidateEvidence(
      [candidateWith({ candidate_status: status })], [source],
    ).rows[0]);
    const before = structuredClone(rows);
    const summary = summarizeEvidenceAudit(rows);
    expect(summary.candidatesSeen).toBe(1);
    expect(summary.candidateStatusCounts).toEqual({});
    expect(summary.candidateStatusRecognitionCounts).toEqual({ known: 0, missing: 0, unknown: 0, invalid: 1 });
    expect(summary.candidateStatusConflictCount).toBe(0);
    expect(rows).toEqual(before);
  });

  it("gives a malformed candidate an explicit unassessed lifecycle rather than a guess", () => {
    const rows = auditCandidateEvidence([null, "candidate", candidateWith({ candidate_status: "rejected" })], [source]).rows;

    expect(rows[0].candidateStatus).toEqual({ raw: null, recognition: "missing", known: null });
    expect(rows[1].candidateStatus).toEqual({ raw: null, recognition: "missing", known: null });
    expect(rows[2].candidateStatus.known).toBe("rejected");

    const summary = summarizeEvidenceAudit(rows);
    expect(summary.candidateStatusCounts).toEqual({ rejected: 1 });
    expect(summary.candidateStatusRecognitionCounts).toEqual({ known: 1, missing: 2, unknown: 0, invalid: 0 });
  });

  it("states that a selected candidate is not a published fact", () => {
    expect(CANDIDATE_STATUS_NOTE).toMatch(/not a publication state/i);
    expect(CANDIDATE_STATUS_NOTE).toMatch(/selected/i);
    expect(summarizeEvidenceAudit([]).candidateStatusNote).toBe(CANDIDATE_STATUS_NOTE);
    expect(auditCandidateEvidence([], []).candidateStatusNote).toBe(CANDIDATE_STATUS_NOTE);
    // Still no verdict of any kind.
    for (const key of ["readiness", "approval", "score", "verified", "publishable"]) {
      expect(Object.keys(summarizeEvidenceAudit([]))).not.toContain(key);
    }
  });

  it("never mutates the candidate while reading its lifecycle", () => {
    const candidates = [candidateWith({ candidate_status: "conflicted", raw_value: ["a", "b"] })];
    const sources = [productionSource("s", ["Q."])];
    const before = structuredClone(candidates);

    auditCandidateEvidence(candidates, sources);
    summarizeEvidenceAudit(auditCandidateEvidence(candidates, sources).rows);

    expect(candidates).toEqual(before);
  });

  it("counts a synthetic 19-candidate, 9-list, 56-item fixture once per candidate", () => {
    // Deliberately fictional, deterministic data: this is portable unit-test
    // coverage of aggregation, not evidence about any retained/live export.
    const statuses = [
      ...Array(4).fill("selected"), ...Array(9).fill("rejected"),
      ...Array(4).fill("superseded"), ...Array(2).fill("conflicted"),
    ];
    const candidates = statuses.map((status, index) => candidateWith({
      id: `fictional-candidate-${index}`,
      field_name: `fictional_field_${index}`,
      candidate_status: status,
      raw_value: index < 9
        ? Array.from({ length: index === 8 ? 6 : 5 }, (_, item) => `Fictional value ${index}.${item}`)
        : `Fictional value ${index}`,
    }));
    expect(candidates).toHaveLength(19);
    expect(candidates.filter((candidate) => Array.isArray(candidate.raw_value))).toHaveLength(9);
    const before = structuredClone(candidates);
    const rows = auditCandidateEvidence(candidates, [source]).rows;
    const summary = summarizeEvidenceAudit(rows);

    expect(summary.candidatesSeen).toBe(19);
    expect(summary.candidateStatusCounts).toEqual({ selected: 4, rejected: 9, superseded: 4, conflicted: 2 });
    expect(summary.candidateStatusRecognitionCounts).toEqual({ known: 19, missing: 0, unknown: 0, invalid: 0 });
    // Rows outnumber candidates because lists expand; statuses must not.
    expect(summary.rowsProduced).toBe(56);
    expect(Object.values(summary.candidateStatusCounts).reduce((total, count) => total + count, 0)).toBe(19);
    expect(candidates).toEqual(before);
  });
});

describe("award fact evidence report CLI lifecycle output", () => {
  const document = {
    schemaVersion: 1,
    awards: [{
      id: "award-a",
      name: "Example Award",
      candidates: [
        { field_name: "eligibility", raw_value: ["a", "b"], evidence_quote: "Q.", shared_award_source_id: "s1", candidate_status: "selected" },
        { field_name: "deadline", raw_value: "x", evidence_quote: "Q.", shared_award_source_id: "s1", candidate_status: "archived" },
        { field_name: "overview", raw_value: "y", evidence_quote: "Q.", shared_award_source_id: "s1" },
      ],
      sources: [productionSource("s1", ["Q."])],
    }],
  };

  it("carries the lifecycle note and known statuses in JSON", () => {
    const result = runCli(["--input", "-"], JSON.stringify(document));
    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.candidateStatusNote).toBe(CANDIDATE_STATUS_NOTE);
    expect(payload.knownCandidateStatuses).toEqual([...KNOWN_CANDIDATE_STATUSES]);

    const summary = payload.reports[0].summary;
    // The two-item list is one candidate, so selected counts once.
    expect(summary.candidateStatusCounts).toEqual({ selected: 1 });
    expect(summary.candidateStatusRecognitionCounts).toEqual({ known: 1, missing: 1, unknown: 1, invalid: 0 });
    expect(summary.rowsProduced).toBe(4);

    const rows = payload.reports[0].rows;
    expect(rows[0].candidateStatus).toEqual({ raw: "selected", recognition: "known", known: "selected" });
    expect(rows[2].candidateStatus).toEqual({ raw: "archived", recognition: "unknown", known: null });
    expect(rows[3].candidateStatus).toEqual({ raw: null, recognition: "missing", known: null });
  });

  it("shows a compact lifecycle column and per-candidate counts in the table", () => {
    const result = runCli(["--input", "-", "--format", "table"], JSON.stringify(document));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(CANDIDATE_STATUS_NOTE);
    expect(result.stdout).toContain("candidate_status (per candidate): selected=1");
    expect(result.stdout).toContain("candidate_status recognition: known=1 missing=1 unknown=1 invalid=0");
    expect(result.stdout).toContain("candidate_status conflicts: 0");
    expect(result.stdout).toContain("| status=selected |");
    expect(result.stdout).toContain('| status=unknown("archived") |');
    expect(result.stdout).toContain("| status=missing |");
    // Existing evidence output is untouched.
    expect(result.stdout).toContain(REVIEW_CAVEAT);
    expect(result.stdout).toContain("assignedQuoteSharedAcrossFields");
    expect(result.stdout).not.toMatch(/\bverified\b|\bpublication-ready\b|\breadiness\b/i);
  });

  it("explains the lifecycle and its publication limit in --help", () => {
    const result = runCli(["--help"], "");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Candidate lifecycle:");
    expect(result.stdout).toContain([...KNOWN_CANDIDATE_STATUSES].join(", "));
    expect(result.stdout).toContain("never mapped onto a");
    expect(result.stdout).toContain(CANDIDATE_STATUS_NOTE);
  });
});
