import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accuracyReviewInput } from "./scrapling-accuracy-fixtures.mjs";
import { buildScraplingReviewDiff } from "./scrapling-review-diff.mjs";
import {
  buildVisualReviewPromptPayload, normalizeVisualBatchResult, validateVisualBatchReview,
} from "./visual-review-queue.mjs";

const bytes = readFileSync(new URL("../fixtures/scrapling-accuracy/retained-excerpts-20261018.json", import.meta.url));
const corpus = JSON.parse(bytes);
const hash = value => createHash("sha256").update(value).digest("hex");
const fixture = id => structuredClone(corpus.cases.find(row => row.id === id));

// These are reconstructed excerpt contracts at a synthetic URL. The real
// legacy capture identity/hashes live only in fixture provenance. We are not
// fabricating official Scrapling/browser captures or measuring model accuracy.
function reconstructedInput(example, { expandedVisible = true } = {}) {
  const source = {
    id: "11111111-1111-4111-8111-111111111111", shared_award_id: "22222222-2222-4222-8222-222222222222",
    url: `https://example.org/retained-excerpt/${example.id}`, title: "Reconstructed excerpt contract",
    page_type: "application", shared_awards: { name: "Reconstructed excerpt contract" },
    admin_review_status: "open", page_metadata_generated_at: "2026-10-18T16:00:00.000Z",
    page_metadata_model: "offline-fixture-only",
    page_metadata: { baseline_facts: { award_relevance: "primary", cycle_relevance: "current_or_upcoming", quality_flags: [] } },
  };
  const document = side => {
    const blocks = example.blocks.map(block => ({ kind: "p", text: block[side].text,
      heading_path: [], list_path: [], table_row: [],
      ...(block.details_context ? { details_path: [block.details_context[side].text] } : {}) }));
    const text = blocks.map(block => [...(block.details_path || []), block.text].join("\n")).join("\n\n");
    return { schema: "awardping.scrapling-html-document.v1", scope: "html-source-main-document",
      source_url: source.url, title: source.title, text, blocks, links: [], base_hrefs: [],
      limitations: ["Reconstructed excerpt contract; not a historical Scrapling observation."],
      publishable: false, visibility_verified: false };
  };
  const before = document("before"), after = document("after");
  const visible = doc => expandedVisible ? doc.text : doc.blocks.filter(block => !block.details_path).map(block => block.text).join("\n\n");
  return accuracyReviewInput(before, after, { sourceIdentity: source,
    previousVisible: visible(before), currentVisible: visible(after) });
}
function packet(example, options) {
  const input = reconstructedInput(example, options);
  const review = buildScraplingReviewDiff(input);
  const payload = review.diff ? buildVisualReviewPromptPayload({ ...input, diff: review.diff,
    deterministic: review.deterministic, behaviorVersion: 13, behaviorName: "offline-reconstruction-only" }) : null;
  return { input, review, payload, candidate: { deterministic_diff: review.diff, prompt_payload: payload } };
}
function suppliedResponse(before, after, overrides = {}) {
  // Hand-authored guard probe, never a recorded or predicted provider response.
  return normalizeVisualBatchResult({ is_true_change: true, is_alert_worthy: true,
    source_relevance: "primary", confidence: "high", noise_flags: [],
    changed_facts: [{ fact: "Applicant instructions", before, after }],
    exact_before: before, exact_after: after, ...overrides });
}
const check = (prepared, response) => validateVisualBatchReview({ candidate: prepared.candidate,
  source: prepared.input.source, result: response });

beforeEach(() => vi.stubGlobal("fetch", vi.fn(() => { throw new Error("unexpected_provider_or_network_call"); })));
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe("source-grounded retained excerpts, not live-capture/model benchmarks", () => {
  it("pins the literal excerpts and full-source provenance without requiring private archives in CI", () => {
    expect(hash(bytes)).toBe("ded095f3e2c01ecdcdbcf517878beb42185b034221e3c79bef516f9aacc9e9d2");
    expect(corpus.schema).toBe("awardping.retained-excerpt-regressions.v1");
    expect(corpus.cases).toHaveLength(5);
    for (const example of corpus.cases) {
      expect(example.provenance.kind).toBe("literal_excerpts_from_retained_legacy_captures");
      for (const side of ["before", "after"]) {
        const origin = example.provenance[side];
        for (const key of ["meta_sha256", "text_file_sha256", "normalized_text_sha256"]) expect(origin[key]).toMatch(/^[a-f0-9]{64}$/);
        expect(origin.text_ref).toContain(`sources/${example.provenance.source_id}/captures/`);
        for (const block of example.blocks) {
          for (const excerpt of [block[side], ...(block.details_context ? [block.details_context[side]] : [])]) {
            expect(hash(excerpt.text)).toBe(excerpt.sha256);
            expect(excerpt.first_utf16_offset_in_normalized_text).toBeGreaterThanOrEqual(0);
          }
        }
      }
      expect(reconstructedInput(example).source.url).toMatch(/^https:\/\/example\.org\//);
    }
  });

  it.each(["smart-faq-countdown", "smart-home-countdown"])("holds exact retained %s timer text without accepting noise or advancing a baseline", id => {
    const { review, payload } = packet(fixture(id));
    expect(review).toMatchObject({ status: "manual_review_required", reason: "countdown_only_change_requires_manual_review",
      publishable: false, baseline_advance_allowed: false, retain_both_captures: true, screenshot_alignment: "not_verified", diff: null });
    expect(payload).toBeNull();
  });

  it("does not turn unchanged compact countdown text into a new review", () => {
    const example = fixture("smart-home-countdown");
    example.blocks[0].after.text = example.blocks[0].before.text;
    expect(packet(example).review).toMatchObject({ status: "unchanged", reason: "complete_semantics_equal", baseline_advance_allowed: false });
  });

  it("holds a strictly decreasing compact timer with seconds, without changing evidence authority", () => {
    const example = fixture("smart-home-countdown");
    example.blocks[0].before.text = "APPLICATION CLOSES IN: DAYS47 HOURS06 MINUTES10 SECONDS30";
    example.blocks[0].after.text = "APPLICATION CLOSES IN: DAYS47 HOURS06 MINUTES10 SECONDS29";
    expect(packet(example).review).toMatchObject({ status: "manual_review_required",
      reason: "countdown_only_change_requires_manual_review", baseline_advance_allowed: false, publishable: false });
  });

  it.each([
    ["increasing countdown", "APPLICATION CLOSES IN: DAYS47 HOURS06 MINUTES10", "APPLICATION CLOSES IN: DAYS48 HOURS06 MINUTES10"],
    ["invalid hours", "APPLICATION CLOSES IN: DAYS47 HOURS25 MINUTES10", "APPLICATION CLOSES IN: DAYS47 HOURS24 MINUTES10"],
    ["invalid minutes", "APPLICATION CLOSES IN: DAYS47 HOURS06 MINUTES61", "APPLICATION CLOSES IN: DAYS47 HOURS06 MINUTES60"],
    ["invalid seconds", "APPLICATION CLOSES IN: DAYS47 HOURS06 MINUTES10 SECONDS61", "APPLICATION CLOSES IN: DAYS47 HOURS06 MINUTES10 SECONDS60"],
    ["day-only duration", "APPLICATION CLOSES IN: DAYS47", "APPLICATION CLOSES IN: DAYS46"],
    ["reordered labels", "APPLICATION CLOSES IN: HOURS06 DAYS47 MINUTES10", "APPLICATION CLOSES IN: HOURS06 DAYS47 MINUTES09"],
    ["duplicate labels", "APPLICATION CLOSES IN: DAYS47 HOURS06 MINUTES10 MINUTES10", "APPLICATION CLOSES IN: DAYS47 HOURS06 MINUTES10 MINUTES09"],
    ["changed countdown purpose", "APPLICATION CLOSES IN: DAYS47 HOURS06 MINUTES10", "APPLICATION OPENS IN: DAYS47 HOURS06 MINUTES09"],
    ["appended deadline", "APPLICATION CLOSES IN: DAYS47 HOURS06 MINUTES10. Deadline: August 1, 2027.", "APPLICATION CLOSES IN: DAYS47 HOURS06 MINUTES09. Deadline: August 2, 2027."],
    ["appended eligibility", "APPLICATION CLOSES IN: DAYS47 HOURS06 MINUTES10. U.S. citizens may apply.", "APPLICATION CLOSES IN: DAYS47 HOURS06 MINUTES09. International applicants may apply."],
  ])("never classifies %s as an isolated countdown", (_label, before, after) => {
    const example = fixture("smart-home-countdown");
    example.blocks[0].before.text = before; example.blocks[0].after.text = after;
    expect(packet(example).review).toMatchObject({ status: "changed_needs_review", reason: "complete_bounded_prose_change", publishable: false });
  });

  it("still checks screenshot semantics before applying the compact countdown hold", () => {
    const input = reconstructedInput(fixture("smart-faq-countdown"));
    input.capture.scrapling.screenshot.semantics_bracketed = false;
    expect(buildScraplingReviewDiff(input)).toMatchObject({ status: "manual_review_required", reason: "supplementary_screenshot_semantics_changed" });
  });

  it("preserves the real enrollment-date clarification mixed with the SMART timer", () => {
    const example = fixture("smart-expanded-enrollment-date"), prepared = packet(example);
    const { review, payload } = prepared;
    expect(review).toMatchObject({ status: "changed_needs_review", reason: "complete_bounded_prose_change",
      publishable: false, baseline_advance_allowed: false, visible_prose_corroborated: true });
    expect(review.diff.added_text).toEqual(example.blocks.slice(0, 2).map(block => block.after.text));
    expect(review.diff.removed_text).toEqual(example.blocks.slice(0, 2).map(block => block.before.text));
    expect(payload.deterministic_diff).toEqual(review.diff);
    expect(payload.text_evidence.added_text[1]).toContain("August 1, 2027");
    expect(payload.text_evidence.added_text[1]).toContain("incoming college freshmen who are not currently enrolled");
    expect(review.diff.scrapling_semantics.current_context.blocks[1].details_path)
      .toEqual(["Are there additional educational requirements?"]);
    // The date already existed in a DIFFERENT requirement on the same source.
    // Keep that context and the conservative production ambiguity guard; this
    // test does not assert a new deadline or reliable audience disambiguation.
    for (const side of ["previous_source_prose", "current_source_prose"]) {
      expect(review.diff.scrapling_semantics[side]).toContain(example.blocks[2].before.text);
      expect(review.diff.scrapling_semantics[side]).toContain("Are military members eligible?");
    }
    expect(check(prepared, suppliedResponse(example.blocks[1].before.text, example.blocks[1].after.text)))
      .toMatchObject({ allowed: false, reason: "temporal_value_already_in_unchanged_context" });
  });

  it("holds the SMART date edit when it remains hidden, instead of accepting timer-only visible evidence", () => {
    const { review, payload } = packet(fixture("smart-expanded-enrollment-date"), { expandedVisible: false });
    expect(review).toMatchObject({ status: "manual_review_required", reason: "changed_block_not_uniquely_visible",
      retain_both_captures: true, publishable: false, baseline_advance_allowed: false, diff: null });
    expect(payload).toBeNull();
  });

  it("preserves Yenching jurisdiction, interview format and the loss of an exact August day in the real packet", () => {
    const example = fixture("yenching-interview-and-degree-precision"), { review, payload } = packet(example);
    expect(review.status).toBe("changed_needs_review");
    expect(payload.text_evidence.removed_text).toEqual(example.blocks.map(block => block.before.text));
    expect(payload.text_evidence.added_text).toEqual(example.blocks.map(block => block.after.text));
    expect(payload.text_evidence.added_text[0]).toContain("no later than August of the intended enrollment year");
    expect(payload.text_evidence.added_text[0]).not.toContain("August 31");
    expect(payload.text_evidence.removed_text[0]).toContain("August 31");
    expect(payload.text_evidence.added_text[1]).toContain("All Chinese candidates, including those from the HMT regions");
    expect(payload.text_evidence.added_text[1]).toContain("in person at Peking University");
    expect(payload.text_evidence.added_text[1]).toContain("International candidates will be interviewed online.");
  });

  it("accepts grounded Yenching interview evidence but rejects an invented day or wrong jurisdiction in response evidence", () => {
    const example = fixture("yenching-interview-and-degree-precision"), prepared = packet(example);
    expect(check(prepared, suppliedResponse(example.blocks[1].before.text, example.blocks[1].after.text)).allowed).toBe(true);
    for (const invented of [
      "Applicants must receive their degree by August 31, 2027.",
      "All Chinese candidates will be interviewed online.",
      "International candidates may interview online or in person.",
    ]) expect(check(prepared, suppliedResponse(example.blocks[1].before.text, invented))).toMatchObject({ allowed: false });
  });

  it("keeps both old and clarified Goldwater acceptance wording and unchanged transcript restrictions", () => {
    const example = fixture("goldwater-transcripts-editorial"), { review, payload } = packet(example);
    // This is a review packet, not a deterministic claim that the editorial edit
    // is alert-worthy. The model has not been called or scored in this test.
    expect(review.status).toBe("changed_needs_review");
    expect(payload.text_evidence.removed_text).toEqual(["Official or unofficial transcripts are acceptable."]);
    expect(payload.text_evidence.added_text).toEqual(["Official and unofficial transcripts are both accepted."]);
    for (const side of ["previous_source_prose", "current_source_prose"]) {
      expect(review.diff.scrapling_semantics[side]).toContain(example.blocks[1].before.text);
    }
    expect(review).toMatchObject({ publishable: false, baseline_advance_allowed: false });
  });

  it("does not override a no-alert editorial decision or accept invented Goldwater requirements", () => {
    const example = fixture("goldwater-transcripts-editorial"), prepared = packet(example);
    expect(check(prepared, suppliedResponse(example.blocks[0].before.text, example.blocks[0].after.text,
      { is_true_change: false, is_alert_worthy: false, rejection_reason: "editorial_clarification" })))
      .toMatchObject({ allowed: false, reason: "editorial_clarification" });
    for (const invented of ["Applicants must submit both official and unofficial transcripts.",
      "Only official transcripts are accepted.", "Unofficial transcripts are now accepted for the first time."]) {
      expect(check(prepared, suppliedResponse(example.blocks[0].before.text, invented)).allowed).toBe(false);
    }
  });
});
