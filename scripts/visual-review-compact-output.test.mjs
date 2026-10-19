import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as queue from "./lib/visual-review-queue.mjs";
import { buildLegacyReviewCompleteness } from "./lib/legacy-review-completeness.mjs";
import {
  GEMINI_WORKER_MODEL, GEMINI_STRONG_WORKER_MODEL,
  visualReviewClaimedModel, visualReviewCompletionDecision,
  visualReviewGenerationConfigForModel, visualReviewResponseEscalationDecision,
} from "./lib/gemini-worker-policy.mjs";

const real = JSON.parse(readFileSync(new URL("./fixtures/visual-review-compact-output-goldwater-20261018.json", import.meta.url), "utf8"));
const source = {
  id: "test-source", shared_award_id: "test-award", url: "https://example.edu/award/apply",
  title: "Example Award Application", page_type: "application", admin_review_status: "open",
  page_metadata_generated_at: "2026-10-18T00:00:00.000Z", page_metadata_model: "offline-fixture",
  page_metadata: { baseline_facts: { award_relevance: "primary", cycle_relevance: "current_or_upcoming", quality_flags: [] } },
};
const oldText = "Application deadline: March 1, 2027";
const newText = "Application deadline: March 15, 2027";
const diff = { removed_text: [oldText], added_text: [newText], date_changes: [], amount_changes: [] };
const candidate = { deterministic_diff: diff, prompt_payload: { include_images: false, deterministic_diff: diff } };
// This one positive case is synthetic. Do not certify the retained Goldwater
// packet used by the separate failure tests.
diff.legacy_review_completeness = buildLegacyReviewCompleteness({ source, previousText: oldText, currentText: newText, diff, excludedChangedUnits: 0 });
const hash = value => createHash("sha256").update(value).digest("hex");
Object.assign(candidate, { shared_award_source_id: source.id, source_url: source.url, previous_text_hash: hash(oldText), new_text_hash: hash(newText) });
Object.assign(candidate.prompt_payload, { previous_text_excerpt: oldText, new_text_excerpt: newText,
  hashes: { previous_text_hash: hash(oldText), new_text_hash: hash(newText) }, text_evidence: {
    added_text: diff.added_text, removed_text: diff.removed_text, date_changes: [], amount_changes: [] } });
const verdict = () => ({
  is_true_change: true, is_alert_worthy: true, source_relevance: "primary", confidence: "high", noise_flags: [],
  changed_facts: [{ fact: "Application deadline", before: oldText, after: newText, removed_text: oldText, added_text: newText, visual_evidence: null }],
  exact_before: oldText, exact_after: newText, section: "Application", change_type: "deadline",
});
const check = (c, value) => queue.validateVisualBatchReview({ candidate: c, source, result: queue.normalizeVisualBatchResult(value, { candidate: c, source }) });

describe("compact output contract, with retained Goldwater failure provenance", () => {
  it("asks for canonical short evidence instead of two redundant top-level page copies", () => {
    const schema = queue.visualReviewResponseSchema;
    for (const key of ["before", "after"]) {
      expect(schema.properties).not.toHaveProperty(key);
      expect(schema.required).not.toContain(key);
    }
    for (const key of ["exact_before", "exact_after", "changed_facts"]) expect(schema.required).toContain(key);
    // Per-fact directional fields remain unchanged; no acceptance guard is removed.
    expect(schema.properties.changed_facts.items.required).toEqual(["fact", "before", "after", "added_text", "removed_text", "visual_evidence"]);
    const prompt = queue.buildVisualReviewPromptText(candidate.prompt_payload);
    const keyList = prompt.split("Required JSON keys:\n")[1].split("\n")[0].replace(/[{}]/g, "").split(", ");
    expect(keyList).not.toContain("before");
    expect(keyList).not.toContain("after");
    expect(prompt).toContain("not a page transcription");
    expect(prompt).toContain("without dropping audience, cycle or exception qualifiers");
    expect(prompt).toContain("unchanged applicant-facing words around an added navigation label");
  });

  it("retains complete long-page input, including late audience and exception context", () => {
    const qualifier = "Only international applicants may apply online. Domestic applicants must attend in person. The transcript exception applies only to the listed institutions.";
    const previous = `${"Unchanged source context. ".repeat(900)}${oldText}\n${qualifier}`;
    const current = previous.replace(oldText, newText);
    const payload = { ...candidate.prompt_payload, previous_text_excerpt: previous, new_text_excerpt: current };
    const frozen = structuredClone(payload);
    const prompt = queue.buildVisualReviewPromptText(payload);
    expect(prompt).toContain(`Previous normalized text excerpt:\n${previous}\n`);
    expect(prompt).toContain(`New normalized text excerpt:\n${current}`);
    expect(payload).toEqual(frozen);
  });

  it("normalizes canonical-only evidence identically to historical top-level aliases", () => {
    const canonical = verdict();
    const legacy = { ...canonical, before: canonical.exact_before, after: canonical.exact_after };
    delete legacy.exact_before; delete legacy.exact_after;
    const clean = value => { const normalized = queue.normalizeVisualBatchResult(value, { candidate, source }); delete normalized.raw_result; return normalized; };
    expect(clean(canonical)).toEqual(clean(legacy));
    expect(check(candidate, canonical).allowed).toBe(true);
    expect(check(candidate, legacy).allowed).toBe(true);
    expect(clean(canonical).structured_diff.added_text).toEqual(diff.added_text);
  });

  it("keeps the real incomplete response held and never turns the diagnostic into a corrected verdict", () => {
    expect(real.completion.finish_reason).toBe("MAX_TOKENS");
    expect(real.response_shape.complete_before_alias_chars).toBeGreaterThan(5000);
    expect(real.response_shape.truncated_inside_top_level_after).toBe(true);
    expect(visualReviewCompletionDecision(real.completion.finish_reason, { candidateCount: real.completion.provider_candidate_count }).allowed).toBe(false);
    expect(visualReviewResponseEscalationDecision({ status: "processing", model: real.completion.requested_model, worker_metadata: { paid_retry_approval_id: "already-authorized-once" } }, real.completion.finish_reason))
      .toEqual({ escalate: false, reason: "paid_retry_bound_to_authorised_request" });
    const c = { deterministic_diff: real.deterministic_diff, prompt_payload: { include_images: false } };
    // Exact retained short fact is misleading and one-sided; even a hypothetical
    // completed JSON wrapper must not repair its missing removed-text evidence.
    const claimed = { ...verdict(), exact_before: null, exact_after: real.deterministic_diff.added_text[0], changed_facts: [real.failed_fact_excerpt] };
    expect(check(c, claimed).allowed).toBe(false);
  });

  it("does not replace rejection or exact directional validation with a compact-output heuristic", () => {
    const c = { deterministic_diff: real.deterministic_diff, prompt_payload: { include_images: false } };
    expect(check(c, { ...verdict(), is_true_change: false, is_alert_worthy: false, changed_facts: [], rejection_reason: "Only navigation changed.", noise_flags: ["navigation"] }).allowed).toBe(false);
    const invented = verdict(); invented.changed_facts[0].added_text = "Application deadline: April 1, 2027";
    expect(check(candidate, invented).allowed).toBe(false);
    for (const finish of ["MAX_TOKENS", "SAFETY", null]) expect(visualReviewCompletionDecision(finish).allowed).toBe(false);
  });

  it.each([GEMINI_WORKER_MODEL, GEMINI_STRONG_WORKER_MODEL])("wires the compact schema into the actual request without changing %s budgets", model => {
    // Extract only the pure actual function, never import the credential-loading
    // worker entrypoint. No provider or filesystem evidence path is executed.
    const worker = readFileSync(new URL("./process-visual-review-batch.mjs", import.meta.url), "utf8");
    const ast = ts.createSourceFile("worker.mjs", worker, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const fn = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name.text === "geminiBatchRequestForCandidate");
    expect(fn).toBeTruthy();
    const makeRequest = runInNewContext(`${fn.getText(ast)}; geminiBatchRequestForCandidate`, {
      ...queue, visualReviewGenerationConfigForModel, visualReviewClaimedModel, monitoringPolicy: null,
    });
    const request = makeRequest({ id: "test-candidate", candidate_signature: "test-signature", model, worker_metadata: { review_model: model }, prompt_payload: candidate.prompt_payload }).request;
    expect(request.generationConfig).toEqual({ ...visualReviewGenerationConfigForModel(model), responseMimeType: "application/json", responseSchema: queue.visualReviewResponseSchema });
    expect(request.generationConfig.maxOutputTokens).toBe(model === GEMINI_WORKER_MODEL ? 2048 : 4096);
    expect(request.generationConfig.responseSchema.properties).not.toHaveProperty("before");
    expect(request.contents[0].parts).toHaveLength(1);
    expect(request.contents[0].parts[0].text).toContain("not a page transcription");
  });
});
