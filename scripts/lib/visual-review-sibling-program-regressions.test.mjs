import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildVisualReviewPromptPayload, classifyVisualReviewCandidate } from "./visual-review-queue.mjs";
import { buildLegacyReviewCompleteness } from "./legacy-review-completeness.mjs";
import { buildMonitoringPromotionMatcherBundleManifest, monitoringPromotionMatcherBundleSources,
  monitoringPromotionMatcherBundleDigestFromManifest } from "./monitoring-promotion-matcher-bundle.mjs";

const corpus = JSON.parse(readFileSync(new URL("../fixtures/scrapling-accuracy/retained-excerpts-20261018.json", import.meta.url)));
const retained = corpus.cases.find(row => row.id === "yenching-interview-and-degree-precision");
const hash = value => createHash("sha256").update(value).digest("hex");
const source = () => ({
  id: retained.provenance.source_id, shared_award_id: retained.provenance.award_id,
  url: retained.provenance.source_url, title: "Yenching Academy — Frequently Asked Questions", page_type: "faq",
  shared_awards: { name: "Yenching Academy" }, admin_review_status: "open",
  page_metadata_generated_at: "2026-08-03T18:20:09.625Z", page_metadata_model: "offline-gate-fixture",
  page_metadata: { baseline_facts: { award_relevance: "primary", cycle_relevance: "current_or_upcoming", quality_flags: [] } },
});
const diffFor = (added, removed = ["Application eligibility requirements were previously listed here."]) => ({
  added_text: Array.isArray(added) ? added : [added], removed_text: removed,
  date_changes: [], amount_changes: [],
});
const gate = (added, overrides = {}) => {
  // Explicitly synthetic clause-sized contexts test the name matcher. They do
  // not certify the historical page or its old clipped producer packet.
  const input = { source: source(), diff: diffFor(added), deterministic: { candidate_change: true }, ...overrides };
  const previousText = input.diff.removed_text.join("\n"), currentText = input.diff.added_text.join("\n");
  const diff = { ...input.diff, legacy_review_completeness: buildLegacyReviewCompleteness({ source: input.source,
    previousText, currentText, diff: input.diff, excludedChangedUnits: 0 }) };
  return classifyVisualReviewCandidate({ ...input, diff, previous: { text: previousText }, baseline: { text_hash: hash(previousText) },
    capture: { text: currentText, text_hash: hash(currentText) } });
};

beforeEach(() => vi.stubGlobal("fetch", vi.fn(() => { throw new Error("unexpected_network_or_provider_call"); })));
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });

describe("generic enrollment clauses are not named sibling programs", () => {
  it("pins all five real changed paragraphs and their retained source provenance", () => {
    expect(retained.provenance.source_id).toBe("c28878c0-6a8b-5fa8-b99b-ec826b86d8f2");
    expect(retained.provenance.before.meta_sha256).toBe("4340cbeb8b626461febdb43631dced3e72193981add3810cba1e52448b302c42");
    expect(retained.provenance.after.meta_sha256).toBe("77a03ffea19ba99a2700cf6068491b56c430b9bfacb00f636702ecccfce093b4");
    expect(retained.blocks).toHaveLength(5);
    for (const block of retained.blocks) for (const side of ["before", "after"]) {
      expect(hash(block[side].text)).toBe(block[side].sha256);
      expect(block[side].first_utf16_offset_in_normalized_text).toBeGreaterThanOrEqual(0);
    }
  });

  it("holds the historical five-paragraph Yenching packet without retroactively certifying its producer", () => {
    const input = { source: source(), diff: diffFor(retained.blocks.map(b => b.after.text), retained.blocks.map(b => b.before.text)),
      deterministic: { candidate_change: true, reason: "award_relevant_terms_or_context" } };
    const before = structuredClone(input);
    expect(classifyVisualReviewCandidate(input)).toMatchObject({ allowed: false, manual_review_required: true,
      reason: "legacy_review_completeness_missing", baseline_advance_allowed: false });
    expect(input).toEqual(before);
  });

  it.each(retained.blocks.map((block, index) => [index + 1, block]))("does not misidentify actual retained paragraph %i as another named program", (_index, block) => {
    const diff = diffFor(block.after.text, [block.before.text]), before = structuredClone(diff);
    // A synthetic clause context checks the name inference only. The raw
    // historical combined packet remains held, not newly certified complete.
    expect(gate(block.after.text, { diff }).reason).not.toBe("sibling_program_or_cross_award");
    expect(diff).toEqual(before);
  });

  it("retains all five paragraph pairs in reading context and snapshot inputs, not an invented full-page fixture", () => {
    // Literal short contexts only. The separate local actual-full-page replay
    // checks the production ten-sentence diff/prefix limits against raw captures.
    const oldText = retained.blocks.map(b => b.before.text).join("\n\n");
    const newText = retained.blocks.map(b => b.after.text).join("\n\n");
    const input = { source: source(), previous: { text: oldText, captured_at: retained.provenance.before.captured_at },
      capture: { text: newText, captured_at: retained.provenance.after.captured_at }, baseline: {},
      diff: diffFor(retained.blocks.map(b => b.after.text), retained.blocks.map(b => b.before.text)), deterministic: { candidate_change: true } };
    const before = structuredClone(input), payload = buildVisualReviewPromptPayload(input);
    for (const block of retained.blocks) {
      expect(payload.previous_text_excerpt).toContain(block.before.text);
      expect(payload.new_text_excerpt).toContain(block.after.text);
    }
    expect(payload.text_evidence.added_text).toHaveLength(5);
    expect(payload.text_evidence.removed_text).toHaveLength(5);
    expect(input).toEqual(before);
  });

  it.each([
    "Peking University does not permit students to be concurrently enrolled in any other degree program. Application eligibility changed.",
    "Peking University does not allow students to be enrolled in other degree programs whilst studying at the university. Application eligibility changed.",
    "Peking University does not allow students to study in other degree programs whilst studying at the university. Application eligibility changed.",
    "Applicants must receive their diploma from their current degree program by August. Application eligibility changed.",
    "Applicants must ensure that your currently enrolled degree program is awarded by August. Application eligibility changed.",
  ])("recognizes only the demonstrated grammatical enrollment form: %s", text => {
    expect(gate(text).allowed).toBe(true);
  });

  it.each([
    "Master of Public Policy Degree Program application deadline changed.",
    "Global Health Degree Program application eligibility changed.",
    "Harry S Truman Scholarship application eligibility changed.",
  ])("still rejects a real named foreign program: %s", text => {
    expect(gate(text)).toMatchObject({ allowed: false, reason: "sibling_program_or_cross_award" });
  });

  it.each([
    "Peking University does not permit students to be concurrently enrolled in any other degree program. Harry S Truman Scholarship application eligibility changed.",
    "Applicants must receive their diploma from their current degree program by August. Global Health Degree Program application eligibility changed.",
    "Applicants must ensure that your currently enrolled degree program is awarded by August. Master of Public Policy Degree Program funding changed.",
  ])("does not camouflage a foreign named award after a generic enrollment clause: %s", text => {
    expect(gate(text)).toMatchObject({ allowed: false, reason: "sibling_program_or_cross_award" });
  });

  it.each([
    "Peking University does not permit students to be concurrently enrolled in any other degree program-International Leadership Program application eligibility changed.",
    "Peking University does not permit students to be concurrently enrolled in any other degree program's application eligibility changed.",
    "Peking University does not permit xstudents to be concurrently enrolled in any other degree program. Application eligibility changed.",
    "Peking University allows students to be enrolled in other degree programs overseas. Application eligibility changed.",
    "Applicants receive a diploma from their current degree program named Global Health Degree Program. Application eligibility changed.",
    "Applicants must ensure that your currently enrolled degree program has a different application deadline.",
  ])("does not broaden the enrollment exception across unsupported boundaries or context: %s", text => {
    expect(gate(text)).toMatchObject({ allowed: false, reason: "sibling_program_or_cross_award" });
  });

  it("preserves same-award named-program handling", () => {
    expect(gate("Yenching Academy Degree Program application eligibility changed.").allowed).toBe(true);
  });

  it("preserves the explicit PhRMA Faculty Starter Grant sibling guard", () => {
    const other = source(); other.shared_awards.name = "PhRMA Foundation Predoctoral Fellowship";
    expect(gate("Faculty Starter Grants application deadline changed.", { source: other }))
      .toMatchObject({ allowed: false, reason: "sibling_program_or_cross_award" });
  });

  it("cannot bypass source/access guard precedence", () => {
    const blocked = source(); blocked.url = "https://example.edu/payment/";
    const result = gate(retained.blocks[0].after.text, { source: blocked });
    expect(result.allowed).toBe(false);
    expect(result.source_rejected).toBe(true);
    expect(result.reason).not.toBe("sibling_program_or_cross_award");
  });

  it("cannot bypass deterministic rejection precedence", () => {
    expect(gate(retained.blocks[0].after.text, { deterministic: { candidate_change: false, reason: "separate_held_evidence" } }))
      .toMatchObject({ allowed: false, reason: "separate_held_evidence" });
  });

  it("does not pretend this candidate gate belongs to the promotion bundle's documented source closure", () => {
    expect(monitoringPromotionMatcherBundleSources).toHaveLength(15);
    expect(monitoringPromotionMatcherBundleSources).not.toContain("scripts/lib/visual-review-queue.mjs");
    const first = buildMonitoringPromotionMatcherBundleManifest(), second = buildMonitoringPromotionMatcherBundleManifest();
    expect(first).toEqual(second);
    expect(monitoringPromotionMatcherBundleDigestFromManifest(first)).toBe(monitoringPromotionMatcherBundleDigestFromManifest(second));
  });
});
