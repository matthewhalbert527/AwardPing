import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { hasRelativeAgeOnlyTextDiff } from "./lib/award-monitoring-policy.mjs";
import { buildLegacyReviewCompleteness, legacyReviewCompletenessDecision,
  visualReviewResultCompletenessDecision } from "./lib/legacy-review-completeness.mjs";
import { buildVisualReviewPromptPayload, changeDetailsFromVisualBatchResult,
  classifyVisualReviewCandidate, normalizeVisualBatchResult, validateVisualBatchReview } from "./lib/visual-review-queue.mjs";

// Execute only actual extracted function declarations, never either CLI/main.
// No artifacts, provider requests, database calls or worker operations are used.
const captureCode = readFileSync(new URL("./capture-visual-snapshots.mjs", import.meta.url), "utf8");
const batchCode = readFileSync(new URL("./process-visual-review-batch.mjs", import.meta.url), "utf8");
const digest = text => createHash("sha256").update(text).digest("hex");
function declarations(code, names) {
  const file = ts.createSourceFile("local.mjs", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  return names.map(name => {
    const matches = file.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    if (matches.length !== 1) throw new Error(`Expected one actual declaration: ${name}`);
    return matches[0].getText(file);
  }).join("\n");
}
function functions(code, names, globals = {}) {
  const context = vm.createContext({ Buffer, console: { log() {} }, ...globals });
  vm.runInContext(`${declarations(code, names)}\nthis.api={${names.join(",")}}`, context);
  return context.api;
}
const producerNames = ["buildDiffSummary", "excludedLegacyChangedUnits", "normalizeVisibleText", "isVolatileLine",
  "isVolatileOrBoilerplateFragment", "hasAwardRelevantTerms", "isProtectedAwardPageType", "sentenceCandidates",
  "splitChangeSentences", "protectSentenceAbbreviations", "restoreSentenceAbbreviations", "sentenceKey",
  "isUsefulChangedSentence", "contextualDatePhrases", "datePhrases", "isAwardDateContext", "contextualMoneyPhrases",
  "contextAroundMatch", "hasFundingAmountContext", "inferSection", "looksLikeRecipientNewsOrPressText",
  "looksLikeSourceAccessError", "normalizeText", "truncate", "dedupeText", "unique"];
const producer = functions(captureCode, producerNames, { sentenceDotPlaceholder: "__AP_SENTENCE_DOT__",
  hasRelativeAgeOnlyTextDiff, buildLegacyReviewCompleteness });
const source = { id: "source-1", shared_award_id: "award-1", url: "https://example.edu/award/apply",
  title: "Example Award Application", page_type: "application", admin_review_status: "open",
  page_metadata_generated_at: "2026-07-08T00:00:00.000Z", page_metadata_model: "synthetic-test",
  page_metadata: { baseline_facts: { award_relevance: "primary", cycle_relevance: "current_or_upcoming", quality_flags: [] } } };
const blank = () => ({ added_text: [], removed_text: [], date_changes: [], amount_changes: [] });
function pair(oldText = "Applicants must submit the original essay for this award.",
  newText = "Applicants must submit the revised essay for this award.", frame = false) {
  const previous = { text: oldText + (frame ? "\n" : "") };
  const capture = { text: newText, text_hash: digest(newText), kind: "html" };
  const baseline = { text_hash: digest(oldText) };
  const diff = producer.buildDiffSummary(previous.text, capture.text, source);
  const candidate = { id: "candidate-1", shared_award_source_id: source.id, source_url: source.url,
    source_title: source.title, source_page_type: source.page_type, status: "pending",
    updated_at: "2026-10-19T18:00:00.000Z", previous_text_hash: baseline.text_hash, new_text_hash: capture.text_hash,
    deterministic_diff: diff, prompt_payload: { source, deterministic_diff: diff, hashes: { previous_text_hash: baseline.text_hash,
      new_text_hash: capture.text_hash }, previous_text_excerpt: previous.text, new_text_excerpt: capture.text,
      text_evidence: Object.fromEntries(Object.keys(blank()).map(key => [key, diff[key]])), include_images: false } };
  return { source, previous, capture, baseline, diff, candidate };
}
function clauses(n, word) { return Array.from({ length: n }, (_, i) => `Applicants must submit the ${word} essay number ${i} for eligibility.`).join(" "); }
function response(facts = [{ fact: "The required essay changed.", before: "original essay", after: "revised essay",
  removed_text: "original essay", added_text: "revised essay" }]) {
  return { is_true_change: true, is_alert_worthy: true, confidence: "high", source_relevance: "primary",
    changed_facts: facts, reader_summary: "Essay requirement changed.", exact_before: "original essay", exact_after: "revised essay" };
}

describe("bounded complete legacy evidence (not exhaustive AI reporting)", () => {
  it("holds the actual five retained Yenching replacements with all thirteen directions intact", () => {
    const file = readFileSync(new URL("./fixtures/scrapling-accuracy/retained-excerpts-20261018.json", import.meta.url), "utf8");
    expect(digest(file)).toBe("4fc399550d548db831464553247eb0f2b1474bc0f43c8745f896e8b556f48097");
    const retained = JSON.parse(file).cases.find(row => row.id === "yenching-interview-and-degree-precision");
    expect(retained.provenance.source_id).toBe("c28878c0-6a8b-5fa8-b99b-ec826b86d8f2");
    const blocks = [...retained.blocks].sort((a, b) => a.before.first_utf16_offset_in_normalized_text - b.before.first_utf16_offset_in_normalized_text);
    for (const block of blocks) for (const side of ["before", "after"]) expect(digest(block[side].text)).toBe(block[side].sha256);
    const old = blocks.map(row => row.before.text);
    const now = blocks.map(row => row.after.text);
    expect([old.length, now.length]).toEqual([5, 5]);
    const input = pair(old.join("\n\n"), now.join("\n\n"));
    expect(input.diff.added_text).toHaveLength(13);
    expect(input.diff.removed_text).toHaveLength(13);
    expect(input.diff.added_text.at(-1)).toBe("Final admission will be confirmed through the official Peking University acceptance letter, issued in the summer prior to enrollment.");
    expect(input.diff.removed_text[8]).toBe("International candidates can attend interviews online or in person.");
    expect(legacyReviewCompletenessDecision(input)).toMatchObject({ allowed: false, manual_review_required: true,
      reason: "legacy_review_evidence_exceeds_complete_bound", baseline_advance_allowed: false });
    const payload = buildVisualReviewPromptPayload({ ...input, promptChars: 1 });
    expect(payload.previous_text_excerpt).toBe(input.previous.text);
    expect(payload.text_evidence.added_text).toEqual(input.diff.added_text);
    expect(payload.text_evidence.removed_text).toEqual(input.diff.removed_text);
  });
  it.each([1, 8, 9, 10, 13, 16, 17])("retains all %i producer sentences, allowing only complete sets within eight", n => {
    const input = pair(clauses(n, "original"), clauses(n, "revised"));
    expect(input.diff.added_text).toHaveLength(n);
    expect(input.diff.removed_text).toHaveLength(n);
    expect(legacyReviewCompletenessDecision(input).allowed).toBe(n <= 8);
  });
  it("holds old-nine/new-eight rather than publishing an unpaired new-only fact", () => {
    const input = pair(clauses(9, "original"), clauses(8, "revised"));
    const normalized = normalizeVisualBatchResult(response([{ fact: "Interview changed.",
      before: input.diff.removed_text[8], removed_text: input.diff.removed_text[8],
      after: input.diff.added_text[7], added_text: input.diff.added_text[7] }]), { candidate: input.candidate, source });
    expect(normalized.structured_diff.removed_text).toHaveLength(9);
    const details = changeDetailsFromVisualBatchResult({ ...input, result: normalized });
    expect(details).toMatchObject({ manual_review_required: true, changed_facts: [] });
    expect(validateVisualBatchReview({ ...input, result: normalized }).allowed).toBe(false);
  });
  it("preserves both sides and all twelve supported facts within the bounded packet", () => {
    const input = pair();
    const normalized = normalizeVisualBatchResult(response(Array.from({ length: 12 }, () => response().changed_facts[0])), input);
    expect(legacyReviewCompletenessDecision({ ...input, result: normalized }).allowed).toBe(true);
    expect(normalized.changed_facts).toHaveLength(12);
    const details = changeDetailsFromVisualBatchResult({ ...input, result: normalized });
    expect(details.changed_facts).toHaveLength(12);
    expect(details.before).toContain("original essay");
    expect(details.after).toContain("revised essay");
  });
  it("never discards an unsupported thirteenth model fact or throws it into paid escalation", () => {
    const input = pair();
    const raw = response([...Array.from({ length: 12 }, () => response().changed_facts[0]),
      { fact: "Invented tuition benefit.", added_text: "Unsupported full tuition is guaranteed." }]);
    const normalized = normalizeVisualBatchResult(raw, input);
    expect(normalized.changed_facts).toHaveLength(13);
    expect(normalized.raw_result).toBe(raw);
    expect(visualReviewResultCompletenessDecision(normalized)).toMatchObject({ allowed: false, manual_review_required: true });
    expect(validateVisualBatchReview({ ...input, result: normalized })).toMatchObject({ manual_review_required: true });
    expect(raw.changed_facts).toHaveLength(13);
  });
  it.each([{ facts: ["A string claim", null, {}] }, { facts: ["", { fact: "" }] }])("keeps every malformed/string model fact available to validation", ({ facts }) => {
    const input = pair();
    const raw = response(facts);
    const normalized = normalizeVisualBatchResult(raw, input);
    expect(normalized.changed_facts).toHaveLength(facts.length);
    expect(normalized.raw_result).toBe(raw);
    expect(validateVisualBatchReview({ ...input, result: normalized }).allowed).toBe(false);
  });
  it.each(["changed_facts", "changed_award_facts"])("holds oversized raw %s aliases without clipping", field => {
    const input = pair();
    const raw = { ...response(), [field]: Array.from({ length: 13 }, () => response().changed_facts[0]) };
    if (field === "changed_award_facts") delete raw.changed_facts;
    expect(visualReviewResultCompletenessDecision(normalizeVisualBatchResult(raw, input)).allowed).toBe(false);
  });
  it.each(Object.keys(blank()))("preserves and holds oversized model %s evidence", field => {
    const input = pair();
    const raw = { ...response(), structured_diff: { [field]: Array.from({ length: 9 }, (_, i) => `Evidence ${i}`) } };
    const normalized = normalizeVisualBatchResult(raw, input);
    expect(normalized.structured_diff[field]).toHaveLength(9);
    expect(visualReviewResultCompletenessDecision(normalized).allowed).toBe(false);
  });
  it("binds original writer framing LF without trimming or changing either capture", () => {
    const input = pair(undefined, undefined, true);
    const before = JSON.stringify(input);
    expect(legacyReviewCompletenessDecision(input).allowed).toBe(true);
    expect(legacyReviewCompletenessDecision({ candidate: input.candidate, source }).allowed).toBe(true);
    expect(JSON.stringify(input)).toBe(before);
    const changed = structuredClone(input); changed.previous.text += "\n";
    expect(legacyReviewCompletenessDecision(changed).allowed).toBe(false);
  });
  it.each(["Apply now.", `Applicants ${"a".repeat(650)}.`, "Applicants MUST submit the original essay for this award."])("holds excluded short/long/case changes from the real producer", text => {
    const input = pair(undefined, text);
    expect(input.diff.legacy_review_completeness.excluded_changed_units).toBeGreaterThan(0);
    expect(legacyReviewCompletenessDecision(input).allowed).toBe(false);
  });
  it("holds reordered eligible sentences with unexplained zero directional evidence", () => {
    const a = "Applicants must submit an essay for eligibility.", b = "Applicants must submit a transcript for eligibility.";
    const input = pair(`${a} ${b}`, `${b} ${a}`);
    expect(input.diff.added_text).toEqual([]);
    expect(legacyReviewCompletenessDecision(input).allowed).toBe(false);
  });
  it("holds changed duplicate occurrence counts", () => {
    const a = "Applicants must submit an essay for eligibility.";
    expect(legacyReviewCompletenessDecision(pair(`${a} ${a}`, a)).allowed).toBe(false);
  });
  it("retains complete twelve-thousand-character context; holds the next character", () => {
    for (const length of [12_000, 12_001]) {
      const input = pair();
      input.previous.text = "x".repeat(length);
      input.capture.text = "y".repeat(length);
      input.baseline.text_hash = digest(input.previous.text); input.capture.text_hash = digest(input.capture.text);
      input.diff.legacy_review_completeness = buildLegacyReviewCompleteness({ source, previousText: input.previous.text,
        currentText: input.capture.text, diff: input.diff, excludedChangedUnits: 0 });
      Object.assign(input.candidate, { previous_text_hash: input.baseline.text_hash, new_text_hash: input.capture.text_hash });
      Object.assign(input.candidate.prompt_payload, { previous_text_excerpt: input.previous.text, new_text_excerpt: input.capture.text,
        hashes: { previous_text_hash: input.baseline.text_hash, new_text_hash: input.capture.text_hash } });
      expect(legacyReviewCompletenessDecision(input).allowed).toBe(length === 12_000);
    }
  });
  it("does not retroactively certify old capped packets, tampered context, unknown excluded counts or mismatched source", () => {
    const input = pair();
    for (const mutate of [x => delete x.diff.legacy_review_completeness,
      x => delete x.diff.legacy_review_completeness.excluded_changed_units,
      x => x.diff.added_text.push("Applicants must submit an extra essay."),
      x => x.previous.text += " changed", x => x.source.id = "other-source"] ) {
      const changed = structuredClone(input); mutate(changed);
      expect(legacyReviewCompletenessDecision(changed).allowed).toBe(false);
    }
  });
  it.each(["missing evidence", "clipped prompt diff", "old prompt marker", "stale prompt hashes"])("holds %s even when the stored candidate comparison is intact", drift => {
    const input = pair();
    input.candidate.prompt_payload.deterministic_diff = structuredClone(input.diff);
    if (drift === "missing evidence") delete input.candidate.prompt_payload.text_evidence;
    if (drift === "clipped prompt diff") input.candidate.prompt_payload.deterministic_diff.added_text = [];
    if (drift === "old prompt marker") delete input.candidate.prompt_payload.deterministic_diff.legacy_review_completeness;
    if (drift === "stale prompt hashes") input.candidate.prompt_payload.hashes.new_text_hash = "f".repeat(64);
    expect(legacyReviewCompletenessDecision({ candidate: input.candidate, source })).toMatchObject({ allowed: false, reason: "legacy_review_prompt_evidence_mismatch" });
  });
  it.each(["initial", "scrapling", "visual"])("delegates %s contracts without authorizing forgeable tags or missing results", kind => {
    const input = pair(); delete input.diff.legacy_review_completeness;
    if (kind === "initial") input.candidate.candidate_scope = "initial_official_document";
    if (kind === "scrapling") Object.assign(input.diff, { candidate_scope: "scrapling_html_source", scrapling_semantics: { complete: true, version: 4 } });
    if (kind === "visual") { input.diff = blank(); input.candidate.deterministic_diff = input.diff;
      input.capture.text_hash = input.baseline.text_hash; input.candidate.new_text_hash = input.baseline.text_hash; }
    expect(legacyReviewCompletenessDecision(input)).toMatchObject({ applicable: false, allowed: false, requires_existing_contract: true });
    expect(legacyReviewCompletenessDecision({ ...input, requireResult: true })).toMatchObject({ allowed: false, manual_review_required: true });
  });
});

describe("manual hold has no automatic spend, rejection-ledger, cleanup or baseline side effects", () => {
  function captureApi() {
    const save = vi.fn(() => "synthetic-review.json"), mark = vi.fn();
    const api = functions(captureCode, ["holdIncompleteLegacyReview", "enqueueVisualReviewCandidate", "processTextOnlyComparison", "finishSafeDeterministicNoise"], {
      legacyReviewCompletenessDecision, saveReviewRecord: save, toArchiveRelative: x => x,
      markSharedSourceVisualCheckSucceeded: mark, sourceLabel: () => "synthetic", buildDiffSummary: producer.buildDiffSummary,
      pruneTransientExpansionStateScreenshots: vi.fn(() => { throw Error("must retain captures"); }),
      removeGeneratedCaptureDir: vi.fn(() => { throw Error("must retain captures"); }),
      recordVisualRejectionLedger: vi.fn(() => { throw Error("must not write noise ledger"); }),
      writeBaseline: vi.fn(() => { throw Error("must not advance baseline"); }),
      classifyDeterministicChange: vi.fn(() => { throw Error("hold must precede noise classification"); }),
    });
    return { api, save, mark };
  }
  it("actual text producer and enqueue backup hold preserve captures before any noise/queue/cleanup path", async () => {
    const input = pair(clauses(13, "original"), clauses(13, "revised"));
    const { api, save } = captureApi(); const report = { review: 0, review_paths: [] };
    await api.processTextOnlyComparison(source, input.baseline, input.previous, input.capture, report);
    expect(input.capture.persist_expansion_state_screenshots).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
    expect(await api.enqueueVisualReviewCandidate({ ...input, report })).toMatchObject({ manual_review_required: true, candidate_inserted: false });
    expect(save).toHaveBeenCalledTimes(2);
    expect(await api.finishSafeDeterministicNoise({ ...input, report, comparisonComplete: false })).toMatchObject({ absorbed: false });
  });
  it("actual review writer/copy code preserves original file bytes and honestly records unavailable old context", async () => {
    const previousPath = fileURLToPath(new URL("./fixtures/scrapling-accuracy/retained-excerpts-20261018.json", import.meta.url));
    const currentPath = fileURLToPath(new URL("./fixtures/visual-review-compact-output-goldwater-20261018.json", import.meta.url));
    const outputs = new Map();
    const api = functions(captureCode, ["holdIncompleteLegacyReview", "saveReviewRecord", "copyEvidenceFiles"], {
      legacyReviewCompletenessDecision, existsSync, join, mkdirSync: () => {},
      copyFileSync: (from, to) => outputs.set(to, readFileSync(from)),
      writeFileSync: (path, text) => outputs.set(path, text),
      reviewDirForCapture: () => "synthetic-output", sourceMetadata: value => value,
      toArchiveRelative: value => value || null, sourceLabel: () => "synthetic",
      markSharedSourceVisualCheckSucceeded: vi.fn(), aiProvider: null, aiModel: null,
    });
    const capture = { text: readFileSync(currentPath, "utf8"), text_path: currentPath, dir: "synthetic-current" };
    const previous = { text: readFileSync(previousPath, "utf8"), textPath: previousPath };
    const report = { review: 0, review_paths: [] };
    await api.holdIncompleteLegacyReview({ source, capture, previous, baseline: {}, diff: blank(), report });
    expect(outputs.get(join("synthetic-output", "previous-text.txt"))).toEqual(readFileSync(previousPath));
    expect(outputs.get(join("synthetic-output", "new-text.txt"))).toEqual(readFileSync(currentPath));
    outputs.clear();
    await api.holdIncompleteLegacyReview({ source, capture, previous: null, baseline: null, diff: blank(), report });
    const receipt = JSON.parse(outputs.get(join("synthetic-output", "review.json")));
    expect(receipt).toMatchObject({ previous_baseline_capture_path: null, previous_hashes: {},
      deterministic_classification: { previous_context_available: false, comparison_complete: false, baseline_advance_allowed: false } });
    expect(outputs.has(join("synthetic-output", "previous-text.txt"))).toBe(false);
    expect(outputs.get(join("synthetic-output", "new-text.txt"))).toEqual(readFileSync(currentPath));
  });
  function batchApi(row, { publication = false } = {}) {
    const writes = [], filters = [], report = {};
    let patch;
    const query = { update(value) { patch = value; return this; },
      eq(key, value) { filters.push(["eq", key, value]); return this; },
      is(key, value) { filters.push(["is", key, value]); return this; },
      contains(key, value) { filters.push(["contains", key, value]); return this; },
      select() { return this; }, async maybeSingle() {
        const same = filters.every(([op, key, value]) => {
          if (key === "worker_metadata->>submission_claim_token") return (row.worker_metadata?.submission_claim_token ?? null) === value;
          if (op === "contains") return row.worker_metadata?.submission_claim_token === value.submission_claim_token;
          return (row[key] ?? null) === value;
        });
        if (same) writes.push(patch);
        return { data: same ? { id: row.id } : null, error: null };
      } };
    const claimed = vi.fn(async (_candidate, token, value) => { if (token !== "owned-token") throw Error("not owned"); writes.push(value); });
    const api = functions(batchCode, ["preSubmissionRejectReason", "retainIncompleteReviewHold", "publishCandidateResult"], {
      legacyReviewCompletenessDecision, report, supabase: { from: () => query }, markPublicationCandidate: claimed,
      workerMetadataForCandidate: (candidate, value) => ({ ...candidate.worker_metadata, ...value }),
      sourceQualityDecision: () => ({ allowed: true }), visualReviewConditionalSourceApplicantEscape: () => ({ allowed: false }),
      expandableSectionCandidateRejectReason: () => null,
      withVisualBaselineLockAsync: vi.fn(() => { throw Error("must not enter baseline lock"); }),
      publishCandidateResultUnlocked: vi.fn(() => { throw Error("must not publish/requeue"); }),
    });
    return { api, writes, filters, claimed, report };
  }
  it("missing old proof holds before policy refresh/provider submission and remains non-retryable", async () => {
    const input = pair(); delete input.candidate.deterministic_diff.legacy_review_completeness;
    const b = batchApi(input.candidate);
    expect(b.api.preSubmissionRejectReason(input.candidate, source)).toBe("manual_review_required:legacy_review_completeness_missing");
    await b.api.retainIncompleteReviewHold({ candidate: input.candidate, decision: { reason: "legacy_review_completeness_missing" } });
    expect(b.writes[0]).toMatchObject({ status: "failed", worker_metadata: { review_completeness_hold: { automatic_retry_allowed: false, baseline_advance_allowed: false } } });
    const held = { ...input.candidate, ...b.writes[0] };
    held.deterministic_diff = pair().diff;
    expect(b.api.preSubmissionRejectReason(held, source)).toContain("manual_review_required:");
    expect(declarations(batchCode, ["paidRetryRequestPreflight"])).toContain("preSubmissionRejectReason(candidate, source)");
  });
  it("source guard precedence remains ahead of completeness holds", () => {
    const input = pair(); delete input.diff.legacy_review_completeness;
    expect(batchApi(input.candidate).api.preSubmissionRejectReason(input.candidate, { ...source, admin_review_status: "closed" })).toBe("source_not_open_closed");
    expect(classifyVisualReviewCandidate({ ...input, source: { ...source, page_metadata: {
      baseline_facts: { award_relevance: "unrelated", cycle_relevance: "not_applicable" } } } }).source_rejected).toBe(true);
  });
  it("publisher holds before lock, policy requeue and whole-page baseline; preserves full response and releases only its owned claim", async () => {
    const input = pair(); const raw = response(Array.from({ length: 13 }, () => response().changed_facts[0]));
    const result = normalizeVisualBatchResult(raw, input); const b = batchApi(input.candidate);
    expect(await b.api.publishCandidateResult({ ...input, result, usage: { tokens: 3 }, publicationClaimToken: "owned-token" })).toMatchObject({ status: "manual_review_required" });
    expect(b.claimed).toHaveBeenCalledTimes(1);
    expect(b.writes[0].ai_result).toBe(result);
    expect(b.writes[0].ai_result.raw_result).toBe(raw);
    expect(b.writes[0].actual_usage).toEqual({ tokens: 3 });
  });
  it.each(["published", "rejected", "superseded", "new-version", "new-publication-claim", "new-submission-claim"])("lost hold CAS cannot overwrite %s", async drift => {
    const input = pair(); const row = structuredClone(input.candidate);
    if (["published", "rejected", "superseded"].includes(drift)) row.status = drift;
    if (drift === "new-version") row.updated_at = "2026-10-19T18:01:00.000Z";
    if (drift === "new-publication-claim") row.publication_claim_token = "other-owner";
    if (drift === "new-submission-claim") row.worker_metadata = { submission_claim_token: "other-owner" };
    const b = batchApi(row);
    expect(await b.api.retainIncompleteReviewHold({ candidate: input.candidate, decision: { reason: "missing" } })).toMatchObject({ status: "retained_hold_not_applied" });
    expect(b.writes).toEqual([]);
    expect(b.report.manual_review_required).toBeUndefined();
  });
  it("cannot take an already-observed foreign publication claim", async () => {
    const input = pair(); input.candidate.publication_claim_token = "other-owner";
    const b = batchApi(input.candidate);
    expect(await b.api.retainIncompleteReviewHold({ candidate: input.candidate, decision: { reason: "missing" } })).toMatchObject({ status: "retained_hold_not_applied", reason: "publication_claim_not_owned" });
    expect(b.writes).toEqual([]);
  });
  it("keeps the completeness result hold outside JSON/strong-model escalation and before publication claim", () => {
    const holdAt = batchCode.indexOf("const completeness = legacyReviewCompletenessDecision({ candidate, result, requireResult: true });");
    expect(holdAt).toBeGreaterThan(batchCode.indexOf("const publicationCompletion = visualReviewCompletionDecision"));
    expect(holdAt).toBeLessThan(batchCode.indexOf("let publicationClaim = null;", holdAt));
    expect(batchCode.slice(holdAt, batchCode.indexOf("let publicationClaim = null;", holdAt))).not.toContain("buildEscalationRequeue");
    expect(captureCode).toContain('if (queueResult?.manual_review_required) return;');
    expect(captureCode).toContain('if (manualHolds > 0)');
  });
  it("keeps every current production promotion call behind the guarded publisher wrapper", () => {
    const ast = ts.createSourceFile("batch.mjs", batchCode, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const callOwners = name => {
      const found = [];
      const visit = node => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) {
          let owner = node.parent;
          while (owner && !ts.isFunctionDeclaration(owner)) owner = owner.parent;
          found.push(owner?.name?.text);
        }
        ts.forEachChild(node, visit);
      };
      visit(ast); return found;
    };
    expect(callOwners("promoteApprovedBaselineForCandidate")).toEqual(["publishCandidateResultUnlocked"]);
    expect(callOwners("publishCandidateResultUnlocked")).toEqual(["publishCandidateResult", "publishCandidateResult"]);
    for (const name of ["promoteApprovedVisualBaselineLocal", "promoteApprovedVisualBaselineR2"]) {
      expect(callOwners(name)).toEqual(["promoteApprovedBaselineForCandidate"]);
    }
    // The exported baseline helpers still trust approved:true from their
    // existing callers; this release adds no new direct-helper authority claim.
    const wrapper = declarations(batchCode, ["publishCandidateResult"]);
    expect(wrapper.indexOf("legacyReviewCompletenessDecision")).toBeLessThan(wrapper.indexOf("publishCandidateResultUnlocked"));
  });
});
