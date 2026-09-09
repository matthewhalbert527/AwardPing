import { describe, expect, it } from "vitest";
import { buildFactCandidatesFromSources as buildReference } from "../src/lib/award-fact-reconciliation.ts";
import {
  buildFactCandidatesFromSources as buildWorker,
  planMissingFactCandidateMaterialization,
  reconcileAwardFacts,
  auditPublicAwardPage,
} from "./lib/award-fact-reconciliation.mjs";

const award = { id: "canonical-award", name: "Example Research Fellowship" };
const quote = "Applicants must be enrolled graduate students.";
function source(overrides = {}, baseline = {}) {
  return {
    id: "source-1", shared_award_id: award.id,
    url: "https://example.edu/fellowship", title: award.name, display_title: award.name,
    page_description: "Official fellowship details.", page_type: "homepage",
    source: "admin", reason: null, admin_review_status: "open",
    page_metadata_generated_at: "2026-09-09T00:00:00.000Z", page_metadata_model: "fixture",
    page_metadata: { baseline_facts: {
      award_relevance: "primary", cycle_relevance: "current_or_upcoming", confidence: "high",
      display_title: award.name, page_description: "Official fellowship details.",
      deadline: "October 29, 2026", cycle_status: "open", award_amounts: ["$38,000"],
      eligibility: ["Enrolled graduate students"],
      evidence_quotes: [quote], evidence_location: "Eligibility section", ...baseline,
    } }, ...overrides,
  };
}
const fields = rows => rows.filter(row => row.field_name === "eligibility");
function legacyCandidate(input, status = "pending") {
  return {
    ...fields(buildWorker(award, [input]))[0],
    id: "legacy-candidate", candidate_status: status,
    evidence_quote: quote, evidence_location: "Eligibility section",
    // Historical page-stamped rows predate explicit page-scope metadata.
    metadata: { source_page_type: "homepage" },
    rejection_reason: status === "rejected" ? "missing_exact_evidence" : null,
    updated_at: "2026-09-08T00:00:00.000Z",
  };
}

describe.each([["reference", buildReference], ["worker", buildWorker]])("%s generated evidence scope", (_name, build) => {
  it("does not assign an eligibility quote or location to any generated fact", () => {
    const rows = build(award, [source()]);
    expect(rows.length).toBeGreaterThan(4);
    for (const row of rows) {
      expect(row.evidence_quote, row.field_name).toBeNull();
      expect(row.evidence_location, row.field_name).toBeNull();
      expect(row.metadata).toMatchObject({
        page_evidence_quotes: [quote], page_evidence_location: "Eligibility section", page_evidence_scope: "source_page",
      });
    }
  });

  it("preserves complete page wording after character 240, normalizing only whitespace", () => {
    const longQuote = `${"Source context. ".repeat(25)}Only the first year is funded; renewal is not guaranteed.`;
    const location = `${"Source section ".repeat(20)}final eligibility exception`;
    const quotes = [longQuote, "  Second quotation\nwith original spacing.  "];
    const expectedQuotes = [longQuote, "Second quotation with original spacing."];
    const input = source({}, { evidence_quotes: quotes, evidence_location: location });
    const original = structuredClone(input);
    const rows = build(award, [input]);
    for (const row of rows) {
      expect(row.metadata.page_evidence_quotes).toEqual(expectedQuotes);
      expect(row.metadata.page_evidence_location).toBe(location);
    }
    expect(input).toEqual(original);
    const first = rows[0].metadata.page_evidence_quotes;
    const second = rows[1].metadata.page_evidence_quotes;
    expect(first).not.toBe(quotes);
    expect(first).not.toBe(second);
    first.push("Local annotation");
    expect(second).toEqual(expectedQuotes);
  });

  it.each([
    [undefined, undefined, [], null],
    [null, null, [], null],
    [{ text: quote }, ["section"], [], null],
    [[quote, { text: "not a quote" }, 7, false, null, "  "], 42, [quote], null],
    [quote, "Section A", [quote], "Section A"],
    [[[quote]], {}, [], null],
  ])("keeps only supplied nonempty strings without coercion (%j)", (quotes, location, expected, expectedLocation) => {
    for (const row of build(award, [source({}, { evidence_quotes: quotes, evidence_location: location })])) {
      expect(row.evidence_quote).toBeNull();
      expect(row.evidence_location).toBeNull();
      expect(row.metadata.page_evidence_quotes).toEqual(expected);
      expect(row.metadata.page_evidence_location).toBe(expectedLocation);
    }
  });
});

describe("reference and actual worker consistency", () => {
  it("produces identical candidate data for retained aliases, values and page context", () => {
    const input = source({ shared_award_id: "retained-alias" });
    const worker = buildWorker(award, [input]);
    expect(worker).toEqual(buildReference(award, [input]));
    expect(worker.every(row => row.shared_award_id === "retained-alias")).toBe(true);
    expect(worker.find(row => row.field_name === "award_amounts")).toMatchObject({
      raw_value: ["$38,000"], normalized_value: ["$38,000"], candidate_status: "pending",
      shared_award_source_id: "source-1", extracted_at: "2026-09-09T00:00:00.000Z", model: "fixture",
    });
  });
});

describe("legacy materialization identity is not silently bypassed", () => {
  it.each(["pending", "selected", "superseded", "rejected"])("preserves same-source legacy %s identity without rematerializing it", status => {
    const input = source();
    const retained = legacyCandidate(input, status);
    const original = structuredClone(retained);
    const plan = planMissingFactCandidateMaterialization(award, [input], [retained]);
    expect(fields(plan.generatedCandidates)).toEqual([]);
    expect(plan.usableLoadedCandidates).toEqual(status === "rejected" ? [] : [retained]);
    expect(retained).toEqual(original);
  });

  it("materializes a changed value without rewriting the older rejected row", () => {
    const retained = legacyCandidate(source(), "rejected");
    const input = source({}, { eligibility: ["Enrolled doctoral students"] });
    const plan = planMissingFactCandidateMaterialization(award, [input], [retained]);
    expect(fields(plan.generatedCandidates)).toHaveLength(1);
    expect(fields(plan.generatedCandidates)[0].normalized_value).toEqual(["Enrolled doctoral students"]);
    expect(plan.usableLoadedCandidates).toEqual([]);
    expect(retained.candidate_status).toBe("rejected");
  });

  it.each(["rejected", "superseded"])("retains evidence-sensitive identity for a legacy %s row when only quote or location changes", status => {
    const retained = legacyCandidate(source(), status);
    for (const baseline of [
      { evidence_quotes: ["Different current page wording."] },
      { evidence_location: "A different source section" },
    ]) {
      const plan = planMissingFactCandidateMaterialization(award, [source({}, baseline)], [retained]);
      expect(fields(plan.generatedCandidates)).toHaveLength(1);
      expect(plan.usableLoadedCandidates).toEqual([]);
      expect(retained.candidate_status).toBe(status);
    }
  });

  it("uses the old truncated first quote and full normalized location only for compatibility", () => {
    const text = "x".repeat(300);
    const location = `  ${"Section ".repeat(50)}end  `;
    const input = source({}, { evidence_quotes: [text], evidence_location: location });
    const retained = {
      ...legacyCandidate(input, "rejected"),
      evidence_quote: `${"x".repeat(237)}...`,
      evidence_location: location.replace(/\s+/g, " ").trim(),
    };
    const plan = planMissingFactCandidateMaterialization(award, [input], [retained]);
    expect(fields(plan.generatedCandidates)).toEqual([]);
    const generated = fields(buildWorker(award, [input]))[0];
    expect(generated.evidence_quote).toBeNull();
    expect(generated.metadata.page_evidence_quotes).toEqual([text]);
    expect(generated.metadata.page_evidence_location).toBe(retained.evidence_location);
  });

  it("reproduces the old value-matching fallback after a truthy whitespace first quote", () => {
    const matched = `Eligibility: Enrolled graduate students ${"qualifying wording ".repeat(25)}final condition`;
    const input = source({}, { evidence_quotes: ["   ", matched] });
    const retained = { ...legacyCandidate(input, "rejected"), evidence_quote: matched };
    expect(retained.evidence_quote.length).toBeGreaterThan(240);
    const plan = planMissingFactCandidateMaterialization(award, [input], [retained]);
    expect(fields(plan.generatedCandidates)).toEqual([]);
  });

  it.each([
    { evidence_quotes: { toString: null } },
    { evidence_quotes: [{ toString: null }] },
    { evidence_location: { toString: null } },
  ])("fails closed with a plain error when legacy evidence identity cannot be reconstructed (%j)", baseline => {
    const input = source({}, baseline);
    const original = structuredClone(input);
    expect(() => planMissingFactCandidateMaterialization(award, [input], []))
      .toThrow("Legacy candidate evidence identity is unavailable; review the source before reconciliation.");
    expect(input).toEqual(original);
  });

  it.each(["rejected", "superseded"])("documents that a new unbound %s identity tracks value, not a changed page-context capture", status => {
    const retained = {
      ...fields(buildWorker(award, [source()]))[0],
      id: "unbound-candidate", candidate_status: status,
    };
    expect(retained.evidence_quote).toBeNull();
    const changed = source({}, { evidence_quotes: ["Different page context"], evidence_location: "Different section" });
    const plan = planMissingFactCandidateMaterialization(award, [changed], [retained]);
    expect(fields(plan.generatedCandidates)).toEqual([]);
    expect(plan.usableLoadedCandidates).toEqual(status === "rejected" ? [] : [retained]);
  });

  it("does not let a wrong source owner suppress canonical or retained-alias materialization", () => {
    const input = source({ shared_award_id: "retained-alias" });
    const wrongOwner = { ...legacyCandidate(input, "rejected"), shared_award_id: award.id };
    const plan = planMissingFactCandidateMaterialization(award, [input], [wrongOwner]);
    expect(plan.sourceOwnerMismatches).toEqual([wrongOwner]);
    expect(fields(plan.generatedCandidates)).toHaveLength(1);
    expect(fields(plan.generatedCandidates)[0].shared_award_id).toBe("retained-alias");
  });

  it("does not create another row on a second identical source pass", () => {
    const input = source();
    const first = planMissingFactCandidateMaterialization(award, [input], []);
    expect(first.generatedCandidates.length).toBeGreaterThan(4);
    const retained = first.generatedCandidates.map((row, index) => ({ ...row, id: `stored-${index}` }));
    const second = planMissingFactCandidateMaterialization(award, [input], retained);
    expect(second.generatedCandidates).toEqual([]);
    expect(second.usableLoadedCandidates).toEqual(retained);
  });

  it("preserves a caller-supplied quote and the existing selection bonus without claiming validation", () => {
    const input = source();
    const bound = { ...legacyCandidate(input, "selected"), evidence_quote: "Eligibility: Enrolled graduate students", evidence_location: "Exact paragraph 3" };
    const original = structuredClone(bound);
    const plan = planMissingFactCandidateMaterialization(award, [input], [bound]);
    expect(plan.usableLoadedCandidates).toContainEqual(bound);
    const result = reconcileAwardFacts(award, [input], [...plan.usableLoadedCandidates, ...plan.generatedCandidates]);
    expect(result.selected.eligibility.candidate.id).toBe(bound.id);
    expect(result.selected.eligibility.candidate.evidence_quote).toBe(bound.evidence_quote);
    expect(result.selected.eligibility.candidate.evidence_location).toBe(bound.evidence_location);
    expect(bound).toEqual(original);
  });

  it("explicitly retains the unresolved source-wide deadline-audit limitation", () => {
    const input = source();
    const generated = buildWorker(award, [input]);
    const result = reconcileAwardFacts(award, [input], generated);
    const audit = auditPublicAwardPage(award, result.selectedFacts, [input], { reconciliation: result });
    expect(result.selectedFacts.deadline).toBe("October 29, 2026");
    expect(quote).not.toContain("October 29");
    expect(audit.findings.some(f => f.code === "deadline_missing_evidence")).toBe(false);
  });
});
