import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import * as queue from "./lib/visual-review-queue.mjs";
import { buildLegacyReviewCompleteness, isLegacyParagraphReviewCandidate, legacyParagraphReviewLimits, legacyReviewCompletenessDecision } from "./lib/legacy-review-completeness.mjs";
import { compareVisualCandidateOrder, findBlockingPriorVisualPublication } from "./lib/visual-publication-order.mjs";
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

// Exercise real declarations only; never import the credential-loading worker.
const batchText = readFileSync(new URL("./process-visual-review-batch.mjs", import.meta.url), "utf8");
function publicationFunctions(names, globals) {
  const ast = ts.createSourceFile("worker.mjs", batchText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const declarations = names.map(name => {
    const matches = ast.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    if (matches.length !== 1) throw new Error(`Expected one real declaration: ${name}`);
    return matches[0].getText(ast);
  }).join("\n");
  return runInNewContext(`${declarations}; ({${names.join(",")}})`, { Buffer, ...globals });
}
const historyId = n => `20000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const historyTime = n => new Date(Date.UTC(2026, 9, 18) + n * 1000).toISOString();
function historyRow(n, overrides = {}) {
  return { id: historyId(n), shared_award_source_id: source.id, created_at: historyTime(n), status: "failed",
    rejection_reason: "ordinary_terminal_failure", worker_metadata: {}, ...overrides };
}
function historyFixture(rows, { race = null, queryError = null } = {}) {
  const current = { ...structuredClone(candidate), id: historyId(2000), created_at: historyTime(2000),
    status: "succeeded", updated_at: historyTime(2001), publication_claim_token: "owned-publication",
    worker_metadata: {}, new_snapshot_ref: { meta_path: "retained/current.json" }, previous_snapshot_ref: { meta_path: "retained/previous.json" } };
  const record = structuredClone(current);
  if (race === "published") Object.assign(record, { status: "published", publication_claim_token: null });
  if (race === "new claim") record.publication_claim_token = "other-publication";
  const calls = [], updates = [], returned = [];
  const supabase = { from(table) {
    if (table !== "shared_award_visual_review_candidates") throw new Error("No other table is permitted");
    const filters = [], order = []; let patch = null;
    const query = {
      select(...args) { calls.push(["select", ...args]); return this; },
      eq(key, value) { calls.push(["eq", key, value]); filters.push(row => row[key] === value); return this; },
      in(key, values) { calls.push(["in", key, values]); filters.push(row => values.includes(row[key])); return this; },
      neq(key, value) { calls.push(["neq", key, value]); filters.push(row => row[key] !== value); return this; },
      order(key, options) { calls.push(["order", key, options]); order.push([key, options]); return this; },
      async limit(limit) {
        calls.push(["limit", limit]);
        const data = rows.filter(row => filters.every(test => test(row))).sort((a, b) => {
          for (const [key, options] of order) {
            const comparison = key === "created_at" ? Date.parse(a[key]) - Date.parse(b[key]) : a[key].localeCompare(b[key]);
            if (comparison) return options.ascending ? comparison : -comparison;
          }
          return 0;
        }).slice(0, limit);
        returned.push(...data); return { data, error: queryError };
      },
      update(value) { patch = value; updates.push(value); return this; },
      async maybeSingle() {
        if (!filters.every(test => test(record))) return { data: null, error: null };
        Object.assign(record, patch); return { data: { id: record.id }, error: null };
      },
    };
    return query;
  } };
  const prohibited = vi.fn(() => { throw new Error("No source/event/baseline/queue/provider operation is permitted"); });
  const report = {};
  const api = publicationFunctions(["findPriorNonterminalPublication", "publishCandidateResult", "publishCandidateResultUnlocked",
    "retainIncompleteReviewHold", "markPublicationCandidate", "publicationFinalizationPatch", "objectValue"], {
    supabase, compareVisualCandidateOrder, findBlockingPriorVisualPublication, recoverMissingBatchResponses: false,
    legacyReviewCompletenessDecision, archiveRoot: "synthetic-only", withVisualBaselineLockAsync: async ({ operation }) => operation(),
    assertVisualReviewCompletedResult: () => {}, INITIAL_OFFICIAL_DOCUMENT_SCOPE: "initial_official_document",
    visualReviewSourceIdentityFreshness: () => ({ allowed: true }), initialOfficialDocumentSourceIdentityDecision: () => ({ allowed: true }),
    workerMetadataForCandidate: (row, patch) => ({ ...row.worker_metadata, ...patch }), cleanText: value => String(value || "").trim(), report,
    rebuildVisualReviewCandidateForCurrentPolicy: prohibited, publishInitialOfficialDocumentCandidate: prohibited,
    promoteApprovedBaselineForCandidate: prohibited, persistVisualChangeAndReconciliation: prohibited,
  });
  const result = { ...queue.normalizeVisualBatchResult(verdict(), { candidate: current, source }), finish_reason: "STOP", provider_candidate_count: 1 };
  return { api, current, record, result, calls, updates, returned, report, prohibited };
}

describe("bounded source history never certifies unseen older reviews as clear", () => {
  it.each(["oldest hold beyond1000", "exact1000 future rows", "equal timestamp IDs"])("holds saturated actual sorted/limited history: %s", async kind => {
    const rows = Array.from({ length: kind === "oldest hold beyond1000" ? 1001 : 1000 }, (_, i) => historyRow(i + 1));
    if (kind === "oldest hold beyond1000") Object.assign(rows[0], { rejection_reason: "manual_review_required:old_evidence", worker_metadata: { review_completeness_hold: {} } });
    if (kind === "exact1000 future rows") rows.forEach((row, i) => { row.created_at = historyTime(3000 + i); });
    if (kind === "equal timestamp IDs") rows.forEach(row => { row.created_at = historyTime(2000); });
    const fixture = historyFixture(rows);
    const decision = await fixture.api.findPriorNonterminalPublication(fixture.current);
    expect(decision).toMatchObject({ allowed: false, manual_review_required: true, source_history_incomplete: true,
      reason: "source_publication_history_incomplete", observed_rows: 1000, query_limit: 1000, baseline_advance_allowed: false, creates_api_charge: false });
    expect(decision).not.toHaveProperty("id");
    expect(fixture.calls).toContainEqual(["eq", "shared_award_source_id", source.id]);
    expect(fixture.calls).toContainEqual(["neq", "id", fixture.current.id]);
    expect(fixture.calls.filter(call => call[0] === "order")).toEqual([["order", "created_at", { ascending: false }], ["order", "id", { ascending: false }]]);
    expect(fixture.calls.at(-1)).toEqual(["limit", 1000]);
    if (kind === "oldest hold beyond1000") expect(fixture.returned).not.toContain(rows[0]);
    expect(fixture.updates).toHaveLength(0);
  });
  it.each(["terminal only", "earlier marker", "earlier reason", "equal smaller ID", "equal larger ID"])("keeps normal999 ordering semantics: %s", async kind => {
    const rows = Array.from({ length: 999 }, (_, i) => historyRow(i + 1));
    if (kind === "earlier marker") rows[0].worker_metadata.review_completeness_hold = {};
    if (kind === "earlier reason") rows[0].rejection_reason = "manual_review_required:old_evidence";
    if (kind.startsWith("equal")) Object.assign(rows[0], { id: historyId(kind === "equal smaller ID" ? 1 : 3000), created_at: historyTime(2000), rejection_reason: "manual_review_required:old_evidence" });
    const fixture = historyFixture(rows);
    const result = await fixture.api.findPriorNonterminalPublication(fixture.current);
    expect(result).toBe(["earlier marker", "earlier reason", "equal smaller ID"].includes(kind) ? rows[0] : null);
  });
  it("filters other sources, finalized rows and the current ID before applying the bounded cap", async () => {
    const rows = Array.from({ length: 999 }, (_, i) => historyRow(i + 1));
    rows.push(...Array.from({ length: 1001 }, (_, i) => historyRow(3000 + i, { shared_award_source_id: "other-source" })),
      historyRow(5000, { status: "published" }), historyRow(2000));
    const fixture = historyFixture(rows);
    expect(await fixture.api.findPriorNonterminalPublication(fixture.current)).toBeNull();
    expect(fixture.returned).toHaveLength(999);
    expect(fixture.calls).toContainEqual(["in", "status", ["pending", "submitted", "processing", "succeeded", "failed"]]);
  });
  it.each([null, "published", "new claim"])("actual publisher retains the completed result only under its owned claim (%s)", async race => {
    const fixture = historyFixture(Array.from({ length: 1000 }, (_, i) => historyRow(i + 1)), { race });
    const before = structuredClone(fixture.current), previousRecord = structuredClone(fixture.record);
    const usage = { input_tokens: 47, output_tokens: 12 };
    const publish = fixture.api.publishCandidateResult({ candidate: fixture.current, source, result: fixture.result, usage, publicationClaimToken: "owned-publication" });
    if (race) {
      await expect(publish).rejects.toThrow("claim");
      expect(fixture.record).toEqual(previousRecord); expect(fixture.report.manual_review_required).toBeUndefined();
    } else {
      await expect(publish).resolves.toEqual({ status: "manual_review_required", reason: "source_publication_history_incomplete" });
      expect(fixture.record).toMatchObject({ status: "failed", rejection_reason: "manual_review_required:source_publication_history_incomplete",
        publication_claim_token: null, worker_metadata: { baseline_advanced: false, review_completeness_hold: { automatic_retry_allowed: false, creates_api_charge: false } } });
      expect(fixture.record.ai_result).toBe(fixture.result); expect(fixture.record.actual_usage).toBe(usage);
      expect(fixture.report.manual_review_required).toBe(1);
    }
    expect(fixture.current).toEqual(before);
    expect(fixture.record.new_snapshot_ref).toEqual(before.new_snapshot_ref);
    expect(fixture.record.previous_snapshot_ref).toEqual(before.previous_snapshot_ref);
    expect(fixture.prohibited).not.toHaveBeenCalled();
    expect(fixture.updates).toHaveLength(1);
  });
  it("preserves the existing query-error failure without publishing or fabricating an order result", async () => {
    const fixture = historyFixture([], { queryError: { message: "synthetic read unavailable" } });
    await expect(fixture.api.publishCandidateResult({ candidate: fixture.current, source, result: fixture.result, usage: {}, publicationClaimToken: "owned-publication" }))
      .rejects.toThrow("Check prior visual publication retries failed");
    expect(fixture.updates).toHaveLength(0); expect(fixture.prohibited).not.toHaveBeenCalled();
  });
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
      Buffer, isLegacyParagraphReviewCandidate, legacyParagraphReviewLimits,
    });
    const request = makeRequest({ id: "test-candidate", candidate_signature: "test-signature", model, worker_metadata: { review_model: model }, prompt_payload: candidate.prompt_payload }).request;
    expect(request.generationConfig).toEqual({ ...visualReviewGenerationConfigForModel(model), responseMimeType: "application/json", responseSchema: queue.visualReviewResponseSchema });
    expect(request.generationConfig.maxOutputTokens).toBe(model === GEMINI_WORKER_MODEL ? 2048 : 4096);
    expect(request.generationConfig.responseSchema.properties).not.toHaveProperty("before");
    expect(request.contents[0].parts).toHaveLength(1);
    expect(request.contents[0].parts[0].text).toContain("not a page transcription");
  });
});
