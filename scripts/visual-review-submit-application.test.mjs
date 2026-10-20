import { describe, expect, it } from "vitest";
import { accuracyReviewInput } from "./lib/scrapling-accuracy-fixtures.mjs";
import { buildScraplingReviewDiff } from "./lib/scrapling-review-diff.mjs";
import {
  buildVisualReviewPromptPayload,
  changeDetailsFromVisualBatchResult,
  classifyVisualReviewCandidate,
  normalizeVisualBatchResult,
  validateVisualBatchReview,
  visualReviewConditionalSourceApplicantEscape,
} from "./lib/visual-review-queue.mjs";

// Fresh, fabricated complete evidence only. No saved capture/provider response,
// ordinary candidate, source approval, publication or older hold is changed.
const source = {
  id: "11111111-1111-4111-8111-111111111111", shared_award_id: "22222222-2222-4222-8222-222222222222",
  url: "https://example.org/synthetic-award", title: "Fictional Test Award", page_type: "application", source: "admin",
  shared_awards: { name: "Fictional Test Award" }, admin_review_status: "open",
  page_metadata_generated_at: "2026-10-19T00:00:00.000Z", page_metadata_model: "synthetic-fixture-only",
  page_metadata: { baseline_facts: { award_relevance: "primary", cycle_relevance: "current_or_upcoming", confidence: "high", quality_flags: [] } },
};
const qualifier = "International applicants use a separate programme.";
function document(text, src, heading = null) {
  return { schema: "awardping.scrapling-html-document.v1", scope: "html-source-main-document", source_url: src.url,
    title: "Fictional Test Award", text: `${heading ? `${heading} ` : ""}${text} ${qualifier}`,
    blocks: [text, qualifier].map(value => ({ kind: "p", text: value, heading_path: heading ? [{ level: 2, text: heading }] : [], list_path: [], table_row: [] })),
    links: [], base_hrefs: [], limitations: [], publishable: false, visibility_verified: false };
}
function packet(before, after, src = source, heading = null) {
  const input = accuracyReviewInput(document(before, src, heading), document(after, src, heading), { sourceIdentity: src,
    previousProfile: "scrapling-evidence-v2", currentProfile: "scrapling-evidence-v2" });
  const review = buildScraplingReviewDiff(input);
  expect(review.status).toBe("changed_needs_review");
  expect(review.diff.scrapling_semantics.complete).toBe(true);
  const gate = classifyVisualReviewCandidate({ ...input, diff: review.diff, deterministic: review.deterministic });
  const payload = buildVisualReviewPromptPayload({ ...input, diff: review.diff, deterministic: review.deterministic });
  const candidate = { id: "33333333-3333-4333-8333-333333333333", shared_award_id: src.shared_award_id,
    shared_award_source_id: src.id, source_url: src.url, deterministic_diff: review.diff, prompt_payload: payload };
  const raw = { is_true_change: true, is_alert_worthy: true, source_relevance: "primary", source_relevance_reason: "Synthetic applicant instruction.",
    confidence: "high", noise_flags: [], quality_flags: [], rejection_reason: null,
    changed_facts: [{ fact: "Applicant submission cutoff", before, after, removed_text: before, added_text: after, visual_evidence: null }],
    exact_before: before, exact_after: after, section: "Application", change_type: "deadline",
    reader_summary: "The submission cutoff changed for U.S. applicants.", advisor_impact: "Review the official instruction." };
  const normalize = value => normalizeVisualBatchResult(JSON.stringify(value), { candidate, source: src });
  return { src, input, review, gate, candidate, raw, normalize, validate: result => validateVisualBatchReview({ candidate, source: src, result }) };
}
const before = "U.S. applicants must submit the complete application by October 23, 2027.";
const after = "U.S. applicants must submit the complete application by October 30, 2027.";

describe("bounded source-backed submit application by signal", () => {
  it.each(["submit application by", "submit the application by", "submit complete application by", "submit the complete application by", "SUBMIT THE COMPLETE APPLICATION BY"])(
    "accepts complete real diff evidence for '%s' without requiring a deadline heading", phrase => {
      const p = packet(before.replace("submit the complete application by", phrase), after.replace("submit the complete application by", phrase));
      const saved = JSON.stringify(p.candidate), result = p.normalize(p.raw);
      expect(p.gate).toMatchObject({ allowed: true, label: "applicant_fact_change" });
      expect(p.validate(result)).toEqual({ allowed: true, reason: "approved" });
      const details = changeDetailsFromVisualBatchResult({ candidate: p.candidate, source, result, model: "synthetic-only" });
      expect(details.reader_summary).toContain("U.S. applicants");
      expect(details.reader_summary).toContain("October 30, 2027");
      expect(p.candidate.prompt_payload.deterministic_diff.scrapling_semantics.current_source_prose).toContain(qualifier);
      expect(result.raw_result).toEqual(p.raw); expect(JSON.stringify(p.candidate)).toBe(saved);
    },
  );

  it.each(["application by", "resubmit the complete application by", "submit the complete application bylaws", "submit the complete applications by", "submit an application by", "submit an unrelated application by"])(
    "does not broaden the phrase to '%s'", phrase => {
      const p = packet(`U.S. applicants must ${phrase} October 23, 2027.`, `U.S. applicants must ${phrase} October 30, 2027.`);
      // Existing singular application may queue; plural is already held upstream.
      // Neither is final approval without this exact bounded phrase family.
      expect(p.gate.allowed).toBe(phrase !== "submit the complete applications by");
      expect(p.validate(p.normalize(p.raw))).toEqual({ allowed: false, reason: "missing_deterministic_applicant_fact_signal" });
    },
  );

  it("does not use an AI-authored claim, structured diff or section as source evidence", () => {
    const p = packet("Application content panel Alpha.", "Application content panel Beta.");
    const raw = { ...p.raw, section: "Submit the complete application by October 30, 2027", reader_summary: after,
      changed_facts: [{ ...p.raw.changed_facts[0], fact: after }], structured_diff: { added_text: [after], removed_text: [before] } };
    expect(p.validate(p.normalize(raw))).toEqual({ allowed: false, reason: "missing_deterministic_applicant_fact_signal" });
  });

  it("does not borrow the phrase from the source title when only generic prose changed", () => {
    const src = { ...source, title: after, display_title: after };
    const p = packet("Application content panel Alpha.", "Application content panel Beta.", src);
    expect(p.validate(p.normalize(p.raw))).toEqual({ allowed: false, reason: "missing_deterministic_applicant_fact_signal" });
  });

  it("does not borrow an unchanged retained heading_path signal from complete source/native context", () => {
    const heading = "Submit the complete application by October 30, 2027";
    const p = packet("Application content panel Alpha.", "Application content panel Beta.", source, heading);
    expect(p.review.diff.scrapling_semantics.current_source_prose).toContain(heading);
    expect(p.review.diff.added_text.join(" ")).not.toContain(heading);
    expect(p.candidate.prompt_payload.deterministic_diff).toEqual(p.review.diff);
    expect(p.validate(p.normalize(p.raw))).toEqual({ allowed: false, reason: "missing_deterministic_applicant_fact_signal" });
  });

  it.each([
    ["newsletter", "Subscribe to our newsletter: "],
    ["named sibling program", "Applicants for the Atlantis Research Program: "],
  ])("still rejects %s through the normal upstream candidate gate", (_label, prefix) => {
    const p = packet(prefix + before, prefix + after);
    expect(p.gate.allowed).toBe(false);
    expect(p.gate.reason).toBe(prefix.startsWith("Subscribe") ? "popup_or_modal_text" : "sibling_program_or_cross_award");
  });

  it("never uses the new phrase to escape always-blocked job sources", () => {
    const src = { ...source, url: "https://example.org/jobs/position", title: "Career page" }, p = packet(before, after, src);
    expect(p.gate.allowed).toBe(false);
    expect(p.validate(p.normalize(p.raw))).toMatchObject({ allowed: false, reason: "source_quality_url_not_monitorable" });
    expect(visualReviewConditionalSourceApplicantEscape({ source: src, candidate: p.candidate }).allowed).toBe(false);
  });

  it("retains unsupported, ellipsis, one-sided and unchanged-quote rejection", () => {
    const p = packet(before, after);
    for (const raw of [
      { ...p.raw, exact_after: after.replace("October 30", "November 30") },
      { ...p.raw, changed_facts: [{ ...p.raw.changed_facts[0], before: "U.S. applicants ... application by October 23, 2027." }] },
      { ...p.raw, changed_facts: [{ ...p.raw.changed_facts[0], before: null, removed_text: null }] },
      { ...p.raw, changed_facts: [{ fact: "Submission cutoff", before: "application by", after: "application by" }] },
    ]) expect(p.validate(p.normalize(raw)).allowed).toBe(false);
  });

  it("does not create a reviewable packet when retained capture text hash is corrupt", () => {
    const p = packet(before, after); p.input.capture.text_hash = "0".repeat(64);
    expect(buildScraplingReviewDiff(p.input)).toMatchObject({ status: "unavailable", reason: "text_integrity_mismatch" });
  });

});
