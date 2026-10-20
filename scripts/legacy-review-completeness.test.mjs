import crypto, { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { hasRelativeAgeOnlyTextDiff } from "./lib/award-monitoring-policy.mjs";
import { buildLegacyReviewCompleteness, legacyReviewCompletenessDecision,
  visualReviewResultCompletenessDecision, buildLegacyParagraphReviewDiff, legacyReviewCompletenessLimits,
  legacyParagraphReviewSchema, isLegacyParagraphReviewCandidate, legacyParagraphReviewLimits } from "./lib/legacy-review-completeness.mjs";
import { buildVisualReviewPromptPayload, changeDetailsFromVisualBatchResult,
  classifyVisualReviewCandidate, normalizeVisualBatchResult, validateVisualBatchReview,
  buildVisualReviewPromptText, visualReviewResponseSchemaForCandidate, visualReviewResponseSchema } from "./lib/visual-review-queue.mjs";
import { visualReviewCompletionDecision } from "./lib/gemini-worker-policy.mjs";
import { compareVisualCandidateOrder, findBlockingPriorVisualPublication } from "./lib/visual-publication-order.mjs";

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
  hasRelativeAgeOnlyTextDiff, buildLegacyReviewCompleteness, buildLegacyParagraphReviewDiff, legacyReviewCompletenessLimits });
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

describe("v2 complete paired paragraphs: one bounded request, not request chunks", () => {
  const fixtureBytes = readFileSync(new URL("./fixtures/scrapling-accuracy/yenching-complete-retained-pair-20261018.json", import.meta.url));
  const fixture = JSON.parse(fixtureBytes);
  function actualPair() {
    const input = pair(fixture.before.text, fixture.after.text, true);
    input.source = { ...source, ...fixture.source };
    input.diff = producer.buildDiffSummary(input.previous.text, input.capture.text, input.source);
    input.candidate = { ...input.candidate, shared_award_id: input.source.shared_award_id,
      shared_award_source_id: input.source.id, source_url: input.source.url, source_title: input.source.title,
      deterministic_diff: input.diff, prompt_payload: buildVisualReviewPromptPayload(input) };
    return input;
  }
  function reviewed(input = actualPair()) {
    const changes = [0, 1, 3, 4];
    const raw = { ...response(changes.map(block_index => ({ fact: "Application requirements changed.", block_index,
      before: input.diff.removed_text[block_index], after: input.diff.added_text[block_index],
      removed_text: input.diff.removed_text[block_index], added_text: input.diff.added_text[block_index], visual_evidence: null }))),
      exact_before: input.diff.removed_text[3], exact_after: input.diff.added_text[3],
      block_reviews: input.diff.added_text.map((_, block_index) => ({ block_index,
        disposition: changes.includes(block_index) ? "applicant_change" : "wording_only", reason: "Both complete paragraphs reviewed with their full audience and cycle context." })) };
    return { ...normalizeVisualBatchResult(raw, input), finish_reason: "STOP", provider_candidate_count: 1 };
  }
  function quotedResult(input, facts) {
    const raw = { ...response(facts), exact_before: facts[0]?.before ?? null, exact_after: facts[0]?.after ?? null,
      structured_diff: null, block_reviews: input.diff.added_text.map((_, block_index) => ({ block_index,
        disposition: facts.some(fact => fact.block_index === block_index) ? "applicant_change" : "wording_only",
        reason: "Synthetic quote-validation fixture only, not an actual assessment of the remaining blocks." })) };
    // Standalone producer fixtures still supply their full deterministic packet
    // through the normalizer's actual candidate argument, not an ignored diff key.
    return { ...normalizeVisualBatchResult(raw, { ...input, candidate: input.candidate || { deterministic_diff: input.diff } }),
      finish_reason: "STOP", provider_candidate_count: 1 };
  }
  function quotedFact(block_index, before, after) {
    return { fact: "Application requirements changed.", block_index, before, removed_text: before,
      after, added_text: after, visual_evidence: null };
  }
  it("binds the actual historical source, exact writer files and all91 paragraphs; five replacements reconstruct the entire captured text", () => {
    expect(digest(fixtureBytes)).toBe("9500cc222600232839335772e887650db5b69effe82b2edc67cf1a50960c8122");
    expect(fixture.source.id).toBe("c28878c0-6a8b-5fa8-b99b-ec826b86d8f2");
    expect([fixture.before.meta_sha256, fixture.after.meta_sha256]).toEqual([
      "4340cbeb8b626461febdb43631dced3e72193981add3810cba1e52448b302c42", "77a03ffea19ba99a2700cf6068491b56c430b9bfacb00f636702ecccfce093b4"]);
    for (const side of ["before", "after"]) {
      expect(digest(fixture[side].text)).toBe(fixture[side].text_sha256);
      expect(digest(fixture[side].text + fixture[side].writer_suffix)).toBe(fixture[side].text_file_sha256);
      expect(fixture[side].text.split(/\n\s*\n/)).toHaveLength(91);
    }
    const input = actualPair(), proof = input.diff.legacy_review_completeness;
    expect([input.previous.text.length, input.capture.text.length]).toEqual([13_227, 13_173]);
    expect(proof).toMatchObject({ schema: legacyParagraphReviewSchema, paragraph_count: 91, previous_writer_frame: true,
      previous_text_sha256: fixture.before.text_file_sha256, previous_capture_text_sha256: fixture.before.text_sha256 });
    expect(input.diff.added_text).toHaveLength(5); expect(input.diff.removed_text).toHaveLength(5);
    let reconstructed = fixture.before.text;
    for (const block of [...proof.changed_blocks].reverse()) {
      const expected = fixture.changed_ranges[block.block_index];
      expect([block.previous_start, block.previous_end, block.current_start, block.current_end]).toEqual([
        expected.before.start, expected.before.end, expected.after.start, expected.after.end]);
      expect([block.previous_sha256, block.current_sha256]).toEqual([expected.before.sha256, expected.after.sha256]);
      reconstructed = reconstructed.slice(0, block.previous_start) + input.diff.added_text[block.block_index] + reconstructed.slice(block.previous_end);
    }
    expect(reconstructed).toBe(fixture.after.text);
    const repeated = "Peking University does not permit students to be concurrently enrolled in any other degree program.";
    expect(input.diff.added_text.join("\n\n").split(repeated)).toHaveLength(3);
    expect(legacyReviewCompletenessDecision(input)).toMatchObject({ allowed: true, reason: "complete_bounded_paired_paragraph_input" });
    const result = reviewed(input);
    expect(legacyReviewCompletenessDecision({ ...input, result, requireResult: true }).allowed).toBe(true);
    expect(validateVisualBatchReview({ ...input, result }).allowed).toBe(true);
    expect(changeDetailsFromVisualBatchResult({ ...input, result }).changed_facts).toHaveLength(4);
  });
  it("holds the concrete false-summary reproduction when two different quotes both survive in the same actual paired paragraph", () => {
    const input = actualPair(), before = "a minimum of a Bachelor's degree in any field.", after = "Peking University";
    for (const quote of [before, after]) {
      expect(input.diff.removed_text[1]).toContain(quote); expect(input.diff.added_text[1]).toContain(quote);
    }
    const result = quotedResult(input, [quotedFact(1, before, after)]), original = JSON.stringify({ input, result });
    const decision = legacyReviewCompletenessDecision({ ...input, result, requireResult: true });
    expect(decision).toMatchObject({ allowed: false, manual_review_required: true,
      reason: "legacy_paragraph_review_fact_contrast_unverified", baseline_advance_allowed: false, creates_api_charge: false });
    expect(validateVisualBatchReview({ ...input, result })).toMatchObject(decision);
    const details = changeDetailsFromVisualBatchResult({ ...input, result });
    expect(details).toMatchObject({ manual_review_required: true, changed_facts: [], reader_summary: "Saved change evidence requires manual review." });
    expect(details.reader_summary).not.toContain("changed from");
    expect(JSON.stringify({ input, result })).toBe(original);
  });
  it.each(["unchanged before", "unchanged after", "unchanged removed alias", "unchanged added alias", "case counterpart"])("holds raw %s rather than borrowing unchanged context as directional evidence", kind => {
    const input = actualPair(), result = reviewed(input), fact = result.raw_result.changed_facts[1];
    if (kind === "unchanged before") fact.before = fact.removed_text = "a minimum of a Bachelor's degree in any field.";
    if (kind === "unchanged after") fact.after = fact.added_text = "Peking University";
    if (kind === "unchanged removed alias") fact.removed_text = "Peking University";
    if (kind === "unchanged added alias") fact.added_text = "Peking University";
    if (kind === "case counterpart") {
      const old = "Applicants must send the original essay. Shared Applicant Context stays.";
      const next = "Applicants must send the revised essay. shared applicant context stays.";
      const diff = buildLegacyParagraphReviewDiff({ source, previousText: old, currentText: next });
      const input = { source, previous: { text: old }, capture: { text: next, text_hash: digest(next) }, baseline: { text_hash: digest(old) }, diff };
      const raw = quotedResult(input, [quotedFact(0, "Shared Applicant Context", "Applicants must send the revised essay.")]);
      expect(legacyReviewCompletenessDecision({ ...input, result: raw })).toMatchObject({ allowed: false,
        reason: "legacy_paragraph_review_fact_contrast_unverified" });
      return;
    }
    expect(legacyReviewCompletenessDecision({ ...input, result })).toMatchObject({ allowed: false,
      reason: "legacy_paragraph_review_fact_contrast_unverified" });
  });
  it.each(["before", "after", "removed_text", "added_text"])("holds normalized-only unchanged %s without altering the complete raw response", field => {
    const input = actualPair(), result = reviewed(input), originalRaw = JSON.stringify(result.raw_result);
    result.changed_facts[1][field] = "Peking University";
    expect(legacyReviewCompletenessDecision({ ...input, result })).toMatchObject({ allowed: false,
      reason: "legacy_paragraph_review_normalized_fact_contrast_unverified" });
    expect(validateVisualBatchReview({ ...input, result }).allowed).toBe(false);
    expect(changeDetailsFromVisualBatchResult({ ...input, result }).changed_facts).toEqual([]);
    expect(JSON.stringify(result.raw_result)).toBe(originalRaw);
  });
  it("holds a swapped block reference even when the quoted source words remain somewhere in the complete page", () => {
    const input = actualPair(), result = reviewed(input);
    result.raw_result.changed_facts[1].block_index = result.changed_facts[1].block_index = 3;
    expect(legacyReviewCompletenessDecision({ ...input, result })).toMatchObject({ allowed: false,
      reason: "legacy_paragraph_review_fact_pair_mismatch" });
  });
  it.each([
    [0, "no later than August 31 of the year in which you wish to enroll.", "no later than August of the intended enrollment year."],
    [3, "International candidates can attend interviews online or in person.", "International candidates will be interviewed online."],
    [4, "Those who accept our offers will then be approved through an internal process at Peking University, and receive their official acceptance letters in the summer before enrollment.", "Candidates who accept our offers must complete internal procedures at Peking University before being pre-admitted. Final admission will be confirmed through the official Peking University acceptance letter, issued in the summer prior to enrollment."],
  ])("keeps genuine actual paired-block %i precision and audience constraints intact", (index, before, after) => {
    const input = actualPair(), result = quotedResult(input, [quotedFact(index, before, after)]);
    expect(legacyReviewCompletenessDecision({ ...input, result, requireResult: true }).allowed).toBe(true);
    expect(validateVisualBatchReview({ ...input, result }).allowed).toBe(true);
    const details = changeDetailsFromVisualBatchResult({ ...input, result });
    expect(details.changed_facts[0]).toMatchObject({ before, after, removed_text: before, added_text: after });
    if (index === 0) expect(details.after).not.toContain("August 31");
    if (index === 3) expect(details.after).toContain("International candidates");
    if (index === 4) { expect(details.after).toContain("pre-admitted"); expect(details.after).toContain("Final admission"); }
  });
  it("does not reject directionally changed quotes merely because they survive in a different paired block", () => {
    const old = "Applicants must submit the original essay for eligibility.\n\nFor other applicants, the revised essay remains optional.";
    const next = "Applicants must submit the revised essay for eligibility.\n\nFor other applicants, the original essay remains optional.";
    const input = pair(old, next);
    input.diff = buildLegacyParagraphReviewDiff({ source: input.source, previousText: old, currentText: next });
    input.candidate = { ...input.candidate, shared_award_id: input.source.shared_award_id, deterministic_diff: input.diff,
      prompt_payload: buildVisualReviewPromptPayload(input) };
    const result = quotedResult(input, [quotedFact(0, "original essay", "revised essay")]);
    expect(input.diff.added_text[1]).toContain("original essay"); expect(input.diff.removed_text[1]).toContain("revised essay");
    expect(legacyReviewCompletenessDecision({ ...input, result }).allowed).toBe(true);
    expect(validateVisualBatchReview({ ...input, result }).allowed).toBe(true);
    expect(changeDetailsFromVisualBatchResult({ ...input, result }).changed_facts[0]).toMatchObject({ before: "original essay", after: "revised essay" });
  });
  it("conservatively holds an old quote that survives inside an extended requirement rather than inventing a directional deletion", () => {
    const old = "Applicants must submit an essay.", next = "Applicants must submit an essay. International applicants must also submit a translation.";
    const diff = buildLegacyParagraphReviewDiff({ source, previousText: old, currentText: next });
    const input = { source, previous: { text: old }, capture: { text: next, text_hash: digest(next) }, baseline: { text_hash: digest(old) }, diff };
    const result = quotedResult(input, [quotedFact(0, old, next)]), frozen = JSON.stringify(result);
    expect(legacyReviewCompletenessDecision({ ...input, result })).toMatchObject({ allowed: false, manual_review_required: true,
      reason: "legacy_paragraph_review_fact_contrast_unverified", baseline_advance_allowed: false });
    expect(JSON.stringify(result)).toBe(frozen);
  });
  it.each(["raw", "normalized"])("actual publisher retains the %s contrast hold and full response before any event, noise, provider or baseline write", async kind => {
    const input = actualPair(), result = kind === "raw"
      ? quotedResult(input, [quotedFact(1, "a minimum of a Bachelor's degree in any field.", "Peking University")]) : reviewed(input);
    if (kind === "normalized") result.changed_facts[1].after = "Peking University";
    const original = JSON.stringify({ input, result }), raw = result.raw_result, usage = { input_tokens: 7, output_tokens: 3 }, report = {};
    const mark = vi.fn(async (_candidate, token) => { expect(token).toBe("synthetic-owned"); });
    const forbidden = vi.fn(() => { throw Error("Contrast hold must not acquire a lock, submit, publish, reconcile, write noise or promote a baseline"); });
    const api = functions(batchCode, ["publishCandidateResult", "retainIncompleteReviewHold"], { legacyReviewCompletenessDecision,
      markPublicationCandidate: mark, workerMetadataForCandidate: (candidate, value) => ({ ...candidate.worker_metadata, ...value }), report,
      supabase: { from: forbidden }, withVisualBaselineLockAsync: forbidden, publishCandidateResultUnlocked: forbidden,
      promoteApprovedBaselineForCandidate: forbidden, persistVisualChangeAndReconciliation: forbidden,
      recordVisualRejectionLedger: forbidden, reserveGeminiSpend: forbidden, createGeminiBatchJob: forbidden });
    expect(await api.publishCandidateResult({ ...input, result, usage, publicationClaimToken: "synthetic-owned" })).toMatchObject({ status: "manual_review_required" });
    expect(mark).toHaveBeenCalledOnce(); const patch = mark.mock.calls[0][2];
    expect(patch).toMatchObject({ status: "failed", worker_metadata: { baseline_advanced: false,
      review_completeness_hold: { automatic_retry_allowed: false, baseline_advance_allowed: false, retain_both_captures: true, creates_api_charge: false } } });
    expect(patch.ai_result).toBe(result); expect(patch.ai_result.raw_result).toBe(raw); expect(patch.actual_usage).toBe(usage);
    expect(report.manual_review_required).toBe(1); expect(forbidden).not.toHaveBeenCalled();
    expect(JSON.stringify({ input, result })).toBe(original);
  });
  it("keeps full contexts and every paired paragraph through the actual prompt, normalization and version-selected schema", () => {
    const input = actualPair(), result = reviewed(input);
    expect(input.candidate.prompt_payload.previous_text_excerpt).toBe(input.previous.text);
    expect(input.candidate.prompt_payload.new_text_excerpt).toBe(input.capture.text);
    const prompt = buildVisualReviewPromptText(input.candidate.prompt_payload);
    expect(prompt).toContain(fixture.before.text); expect(prompt).toContain(fixture.after.text);
    expect(prompt).toContain("never infer an unstated day or conflate preliminary and final admission");
    expect(prompt).toContain("Return structured_diff:null");
    expect(prompt.split("Required JSON keys:\n")[1].split("\n")[0]).toContain("block_reviews");
    expect(buildVisualReviewPromptText(pair().candidate.prompt_payload).split("Required JSON keys:\n")[1].split("\n")[0]).not.toContain("block_reviews");
    expect(result.changed_facts.map(fact => fact.block_index)).toEqual([0, 1, 3, 4]);
    const schema = visualReviewResponseSchemaForCandidate(input.candidate);
    expect(schema.required).toContain("block_reviews");
    expect(schema.properties.changed_facts.items.required).toContain("block_index");
    expect(visualReviewResponseSchemaForCandidate(pair().candidate)).toBe(visualReviewResponseSchema);
    expect(legacyReviewCompletenessLimits).toEqual({ evidenceItems: 8, resultFacts: 12, contextChars: 12_000, packetBytes: 128_000 });
  });
  it("uses the actual native request with unchanged model/output cap and rejects a full serialized request beyond128KB before submission", () => {
    const input = actualPair();
    const api = functions(batchCode, ["geminiBatchRequestForCandidate"], { visualReviewGenerationConfigForModel: () => ({ maxOutputTokens: 2048 }),
      visualReviewClaimedModel: () => "gemini-2.5-flash-lite", refreshVisualReviewPromptPayloadPolicy: value => value,
      buildVisualReviewPromptText, visualReviewResponseSchemaForCandidate, isLegacyParagraphReviewCandidate,
      legacyParagraphReviewLimits, monitoringPolicy: {} });
    const request = api.geminiBatchRequestForCandidate(input.candidate);
    expect(request.request.generationConfig.maxOutputTokens).toBe(2048);
    expect(request.request.generationConfig.responseSchema.required).toContain("block_reviews");
    expect(request.request.contents[0].parts[0].text).toContain(fixture.after.text);
    input.candidate.prompt_payload.source.baseline_facts = { synthetic_large_context: "x".repeat(65_000) };
    expect(legacyReviewCompletenessDecision(input).allowed).toBe(true);
    expect(() => api.geminiBatchRequestForCandidate(input.candidate)).toThrow("exceeds128KB");
    input.candidate.prompt_payload.source.baseline_facts.synthetic_large_context += "x".repeat(65_000);
    expect(legacyReviewCompletenessDecision(input)).toMatchObject({ allowed: false, reason: "legacy_paragraph_review_complete_prompt_exceeds_bound" });
  });
  it.each(["owned", "concurrent published", "concurrent claim"])("actual submit/request/failure path keeps oversize input in an explicit nonresumable manual hold (%s)", async drift => {
    const input = actualPair();
    input.candidate.prompt_payload.source.baseline_facts = { synthetic_large_context: "x".repeat(65_000) };
    expect(legacyReviewCompletenessDecision(input).allowed).toBe(true);
    const frozenPayload = JSON.stringify(input.candidate.prompt_payload), frozenDiff = JSON.stringify(input.diff);
    let row = structuredClone(input.candidate), patch, filters = [], updates = 0;
    const query = { update(value) { patch = value; filters = []; updates++;
      if (updates === 2 && drift === "concurrent published") row.status = "published";
      if (updates === 2 && drift === "concurrent claim") row.worker_metadata.submission_claim_token = "new-owner";
      return this; }, eq(key, value) { filters.push(["eq", key, value]); return this; },
      is(key, value) { filters.push(["is", key, value]); return this; }, contains(key, value) { filters.push(["contains", key, value]); return this; },
      select() { return this; }, in() { return this; }, neq() { return this; }, order() { return this; },
      async limit() { return { data: [row], error: null }; },
      async maybeSingle() { const matches = filters.every(([op, key, value]) => op === "contains"
        ? row.worker_metadata?.submission_claim_token === value.submission_claim_token : (row[key] ?? null) === value);
        if (!matches) return { data: null, error: null };
        row = { ...row, ...patch }; return { data: structuredClone(row), error: null }; } };
    const forbidden = vi.fn(() => { throw Error("Oversize input must not authorize, reserve, fingerprint, submit or charge"); });
    const report = { submission_claim_conflicts: 0, errors: [] };
    const api = functions(batchCode, ["submitCandidateChunk", "geminiBatchRequestForCandidate", "failVisualProviderRequestEvidence",
      "retainIncompleteReviewHold", "preSubmissionRejectReason", "findPriorNonterminalPublication"], {
      crypto, paidReviewWorkKindForLane: () => "synthetic-changed", paidReviewLaneForCandidate: () => "changed_page_review",
      visualReviewMaxOutputTokensForModel: () => 2048, timestampForPath: () => "synthetic-time",
      supabase: { from: () => query }, report, workerMetadataForCandidate: (candidate, value) => ({ ...candidate.worker_metadata, ...value }),
      visualReviewGenerationConfigForModel: () => ({ maxOutputTokens: 2048 }), visualReviewClaimedModel: () => "gemini-2.5-flash-lite",
      refreshVisualReviewPromptPayloadPolicy: value => value, buildVisualReviewPromptText, visualReviewResponseSchemaForCandidate,
      isLegacyParagraphReviewCandidate, legacyParagraphReviewLimits, legacyReviewCompletenessDecision, monitoringPolicy: {},
      paidVisualProviderRequestFingerprint: forbidden, authorizePaidRetryCandidatesForSubmission: forbidden,
      reserveGeminiSpend: forbidden, createGeminiBatchJob: forbidden, estimateGeminiMaximumBatchRequestsCostUsd: forbidden,
      errorMessage: error => error.message, sourceQualityDecision: () => ({ allowed: true }),
      visualReviewConditionalSourceApplicantEscape: () => ({ allowed: false }), expandableSectionCandidateRejectReason: () => null,
      compareVisualCandidateOrder, findBlockingPriorVisualPublication, recoverMissingBatchResponses: false });
    await api.submitCandidateChunk("gemini-2.5-flash-lite", [input.candidate], "changed_page_review");
    expect(forbidden).not.toHaveBeenCalled();
    expect(JSON.stringify(row.prompt_payload)).toBe(frozenPayload); expect(JSON.stringify(row.deterministic_diff)).toBe(frozenDiff);
    if (drift === "owned") {
      expect(row).toMatchObject({ status: "failed", rejection_reason: "manual_review_required:legacy_paragraph_review_provider_request_exceeds_bound",
        worker_metadata: { review_completeness_hold: { automatic_retry_allowed: false, baseline_advance_allowed: false, retain_both_captures: true, creates_api_charge: false } } });
      expect(report.manual_review_required).toBe(1);
      expect(api.preSubmissionRejectReason(row, input.source)).toContain("manual_review_required:");
      const later = { ...input.candidate, id: "later-source-candidate", created_at: "2027-01-01T00:00:00Z" };
      expect(await api.findPriorNonterminalPublication(later)).toBe(row);
    } else {
      expect(report.manual_review_required).toBeUndefined();
      expect(row.worker_metadata.review_completeness_hold).toBeUndefined();
      if (drift === "concurrent published") expect(row.status).toBe("published");
      else expect(row.worker_metadata.submission_claim_token).toBe("new-owner");
    }
  });
  it("does not change the existing generic request-failure disposition for an untagged error", async () => {
    const input = actualPair(); input.candidate.status = "processing";
    input.candidate.worker_metadata = { submission_claim_token: "owned" };
    let patch;
    const query = { update(value) { patch = value; return this; }, eq() { return this; }, is() { return this; }, contains() { return this; },
      select() { return this; }, async maybeSingle() { return { data: { id: input.candidate.id }, error: null }; } };
    const api = functions(batchCode, ["failVisualProviderRequestEvidence"], { supabase: { from: () => query },
      isLegacyParagraphReviewCandidate, workerMetadataForCandidate: (candidate, value) => ({ ...candidate.worker_metadata, ...value }),
      errorMessage: error => error.message, truncate: value => value, report: { provider_request_evidence_invalid: 0, errors: [] },
      retainIncompleteReviewHold: vi.fn(() => { throw Error("Only the new tagged bound may use the new path"); }) });
    await api.failVisualProviderRequestEvidence([{ candidate: input.candidate, error: new Error("Other artifact failure") }], "owned");
    expect(patch).toMatchObject({ rejection_reason: "provider_request_evidence_invalid", worker_metadata: { automatic_retry_after_repair: false } });
    expect(patch.worker_metadata.review_completeness_hold).toBeUndefined();
  });
  it.each(["missing", "omitted", "extra", "duplicate", "uncertain", "noninteger", "blank reason", "extra field"])("holds %s block dispositions without allowing a partial page", kind => {
    const input = actualPair(), result = reviewed(input);
    if (kind === "missing") delete result.raw_result.block_reviews;
    if (kind === "omitted") result.raw_result.block_reviews.pop();
    if (kind === "extra") result.raw_result.block_reviews.push({ block_index: 5, disposition: "noise", reason: "Extra" });
    if (kind === "duplicate") result.raw_result.block_reviews[4].block_index = 3;
    if (kind === "uncertain") result.raw_result.block_reviews[4].disposition = "uncertain";
    if (kind === "noninteger") result.raw_result.block_reviews[4].block_index = "4";
    if (kind === "blank reason") result.raw_result.block_reviews[4].reason = "";
    if (kind === "extra field") result.raw_result.block_reviews[4].unreviewed = true;
    expect(legacyReviewCompletenessDecision({ ...input, result, requireResult: true })).toMatchObject({ allowed: false,
      manual_review_required: true, baseline_advance_allowed: false, creates_api_charge: false });
  });
  it.each(["missing last fact", "wrong block", "cross pair", "unbound quote", "wording fact", "false flags", "visual quote"])("holds %s rather than dropping evidence or inventing a complete verdict", kind => {
    const input = actualPair(), result = reviewed(input), raw = result.raw_result;
    if (kind === "missing last fact") raw.changed_facts.pop();
    if (kind === "wrong block") raw.changed_facts[0].block_index = 8;
    if (kind === "cross pair") raw.changed_facts[0].after = input.diff.added_text[4];
    if (kind === "unbound quote") raw.changed_facts[0].after = "Applicants are guaranteed admission on August 31.";
    if (kind === "wording fact") raw.block_reviews[0].disposition = "wording_only";
    if (kind === "false flags") raw.is_true_change = false;
    if (kind === "visual quote") raw.changed_facts[0].visual_evidence = "The screenshot proves this.";
    expect(legacyReviewCompletenessDecision({ ...input, result }).allowed).toBe(false);
  });
  it.each(["MAX_TOKENS", "missing STOP", "multiple candidates", "missing count"])("holds %s metadata even with complete-looking JSON", kind => {
    const input = actualPair(), result = reviewed(input);
    if (kind === "MAX_TOKENS") result.finish_reason = "MAX_TOKENS";
    if (kind === "missing STOP") delete result.finish_reason;
    if (kind === "multiple candidates") result.provider_candidate_count = 2;
    if (kind === "missing count") delete result.provider_candidate_count;
    expect(legacyReviewCompletenessDecision({ ...input, result })).toMatchObject({ allowed: false, creates_api_charge: false });
  });
  it.each([undefined, null, [], "not an object", 3])("holds missing or invalid raw_result %j instead of treating normalized content as original provenance", raw => {
    const input = actualPair(), result = reviewed(input);
    if (raw === undefined) delete result.raw_result; else result.raw_result = raw;
    expect(legacyReviewCompletenessDecision({ ...input, result })).toMatchObject({ allowed: false, reason: "legacy_paragraph_review_raw_result_unavailable",
      baseline_advance_allowed: false, creates_api_charge: false });
  });
  it.each(["raw-normalized flags", "normalized block ref", "normalized quote", "partial structured diff", "missing fact key", "fact extra key"])("holds %s result drift before public projection", kind => {
    const input = actualPair(), result = reviewed(input);
    if (kind === "raw-normalized flags") result.is_true_change = false;
    if (kind === "normalized block ref") result.changed_facts[0].block_index = 4;
    if (kind === "normalized quote") result.changed_facts[0].after = "Invented guaranteed acceptance.";
    if (kind === "partial structured diff") result.structured_diff.added_text.pop();
    if (kind === "missing fact key") delete result.raw_result.changed_facts[0].before;
    if (kind === "fact extra key") result.raw_result.changed_facts[0].extra_claim = "Not assessed";
    expect(legacyReviewCompletenessDecision({ ...input, result }).allowed).toBe(false);
  });
  it.each(["omitted", "null", "empty object", "one complete supplied field"])("keeps all deterministic evidence when compact raw structured_diff is %s", kind => {
    const input = actualPair(), raw = reviewed(input).raw_result;
    if (kind === "null") raw.structured_diff = null;
    if (kind === "empty object") raw.structured_diff = {};
    if (kind === "one complete supplied field") raw.structured_diff = { added_text: input.diff.added_text };
    const result = { ...normalizeVisualBatchResult(raw, input), finish_reason: "STOP", provider_candidate_count: 1 };
    expect(legacyReviewCompletenessDecision({ ...input, result }).allowed).toBe(true);
    for (const field of Object.keys(blank())) expect(result.structured_diff[field]).toEqual(input.diff[field]);
  });
  it.each(["prefix", "empty array", "invented", "non-object", "normalized missing"])("holds %s compact structured_diff rather than repairing supplied content", kind => {
    const input = actualPair(), raw = reviewed(input).raw_result;
    raw.structured_diff = { added_text: kind === "empty array" ? [] : kind === "invented" ? ["Invented award facts."] : input.diff.added_text.slice(0, 1) };
    if (kind === "non-object") raw.structured_diff = [];
    if (kind === "normalized missing") raw.structured_diff = null;
    const result = { ...normalizeVisualBatchResult(raw, input), finish_reason: "STOP", provider_candidate_count: 1 };
    if (kind === "normalized missing") delete result.structured_diff;
    expect(legacyReviewCompletenessDecision({ ...input, result })).toMatchObject({ allowed: false, reason: "legacy_paragraph_review_result_evidence_mismatch" });
  });
  it("allows a complete all-wording/noise verdict, but not an empty-facts rejection that leaves a changed block unresolved", () => {
    const input = actualPair(), raw = { ...response([]), is_true_change: false, is_alert_worthy: false,
      block_reviews: input.diff.added_text.map((_, block_index) => ({ block_index, disposition: "wording_only", reason: "Synthetic fully assessed wording-only result, not a human Yenching verdict." })) };
    const result = { ...normalizeVisualBatchResult(raw, input), finish_reason: "STOP", provider_candidate_count: 1 };
    expect(legacyReviewCompletenessDecision({ ...input, result }).allowed).toBe(true);
    result.raw_result.block_reviews[4].disposition = "applicant_change";
    expect(legacyReviewCompletenessDecision({ ...input, result }).allowed).toBe(false);
  });
  it.each(["changed old", "changed new", "wrong source", "wrong award", "wrong hash", "wrong range", "clipped prompt", "wrong frame"])("holds %s binding drift", kind => {
    const input = actualPair();
    if (kind === "changed old") input.previous.text += "x";
    if (kind === "changed new") input.capture.text += "x";
    if (kind === "wrong source") input.source.id = "other-source";
    if (kind === "wrong award") input.candidate.shared_award_id = "other-award";
    if (kind === "wrong hash") input.candidate.new_text_hash = "a".repeat(64);
    if (kind === "wrong range") input.diff.legacy_review_completeness.changed_blocks[4].previous_start++;
    if (kind === "clipped prompt") input.candidate.prompt_payload.text_evidence = { ...input.candidate.prompt_payload.text_evidence, added_text: [] };
    if (kind === "wrong frame") input.baseline.text_hash = digest(input.previous.text);
    expect(legacyReviewCompletenessDecision(input).allowed).toBe(false);
  });
  it("accepts JSONB object-key ordering without changing any values, occurrences or raw hashes", () => {
    const input = actualPair();
    const reorder = value => Array.isArray(value) ? value.map(reorder) : value && typeof value === "object"
      ? Object.fromEntries(Object.entries(value).reverse().map(([key, value]) => [key, reorder(value)])) : value;
    const restored = reorder(input);
    expect(legacyReviewCompletenessDecision(restored).allowed).toBe(true);
  });
  it("does not turn section completeness into whole-page authority or repair an older saved packet", () => {
    const input = actualPair(); input.diff.candidate_scope = "expandable_section";
    expect(legacyReviewCompletenessDecision(input)).toMatchObject({ allowed: false, reason: "legacy_paragraph_review_requires_whole_page_scope" });
    const old = pair(); delete old.diff.legacy_review_completeness;
    const frozen = JSON.stringify(old);
    expect(legacyReviewCompletenessDecision(old)).toMatchObject({ allowed: false, reason: "legacy_review_completeness_missing" });
    expect(JSON.stringify(old)).toBe(frozen);
  });
  it("does not deduplicate two changed paragraph occurrences, but holds reordering, additions and unexplained separator changes", () => {
    const old = "Applicants must submit the original essay for eligibility.", next = "Applicants must submit the revised essay for eligibility.";
    const diff = buildLegacyParagraphReviewDiff({ source, previousText: `${old}\n\n${old}`, currentText: `${next}\n\n${next}` });
    expect(diff.added_text).toEqual([next, next]); expect(diff.legacy_review_completeness.changed_blocks).toHaveLength(2);
    for (const [before, after] of [[`${old}\n\n${next}`, `${next}\n\n${old}`], [old, `${next}\n\nAnother paragraph.`], [`${old}\n\nSame.`, `${next}\n\n\nSame.`]]) {
      expect(buildLegacyParagraphReviewDiff({ source, previousText: before, currentText: after })).toBeNull();
    }
  });
  it("holds nine blocks, full context beyond16k and a UTF8 packet beyond128KB; never keeps a prefix", () => {
    expect(buildLegacyParagraphReviewDiff({ source, previousText: clauses(9, "old").split(". ").join(".\n\n"), currentText: clauses(9, "new").split(". ").join(".\n\n") })).toBeNull();
    expect(buildLegacyParagraphReviewDiff({ source, previousText: "x".repeat(16_001), currentText: "y".repeat(16_001) })).toBeNull();
    expect(buildLegacyParagraphReviewDiff({ source, previousText: "甲".repeat(15_999), currentText: "乙".repeat(15_999) })).toBeNull();
  });
  it("accepts all eight complete blocks and the exact16k boundary, preserving Unicode and CRLF offsets", () => {
    const before = clauses(8, "original").split(". ").join(".\n\n"), current = clauses(8, "revised").split(". ").join(".\n\n");
    expect(buildLegacyParagraphReviewDiff({ source, previousText: before, currentText: current }).added_text).toHaveLength(8);
    const old = "Applicants must submit the original essay.", next = "Applicants must submit the revised essay.";
    const padding = "x".repeat(16_000 - old.length - 2);
    const previous = { text: `${padding}\n\n${old}` }, capture = { text: `${padding}\n\n${next}` };
    capture.text_hash = digest(capture.text);
    const diff = buildLegacyParagraphReviewDiff({ source, previousText: previous.text, currentText: capture.text });
    expect(legacyReviewCompletenessDecision({ source, previous, capture, baseline: { text_hash: digest(previous.text) }, diff }).allowed).toBe(true);
    const unicode = buildLegacyParagraphReviewDiff({ source, previousText: `🧭 Unchanged context.\r\n \r\n${old}`, currentText: `🧭 Unchanged context.\r\n \r\n${next}` });
    expect(unicode.legacy_review_completeness.changed_blocks[0].previous_start).toBe(`🧭 Unchanged context.\r\n \r\n`.length);
    expect(unicode.added_text).toEqual([next]);
  });
  it.each(["MAX_TOKENS", "bad JSON", "missing block", "stored partial", "missing response", "provider error"])("actual reconciler retains %s with zero escalation, publication and baseline calls", async kind => {
    const input = actualPair(); input.candidate.status = kind === "stored partial" ? "succeeded" : "submitted";
    const complete = reviewed(input); const rawText = kind === "bad JSON" ? "{incomplete" : JSON.stringify(complete.raw_result);
    if (kind === "missing block") { complete.raw_result.block_reviews.pop(); }
    if (kind === "stored partial") input.candidate.ai_result = { ...complete, finish_reason: "MAX_TOKENS" };
    const provider = { candidates: [{ finishReason: kind === "MAX_TOKENS" ? "MAX_TOKENS" : "STOP", content: { parts: [{ text: kind === "missing block" ? JSON.stringify(complete.raw_result) : rawText }] } }] };
    const query = {}; for (const method of ["select", "eq", "in"]) query[method] = () => query;
    query.order = async () => ({ data: [input.candidate], error: null });
    const retained = vi.fn(async () => ({ status: "manual_review_required" }));
    const prohibited = vi.fn(() => { throw Error("No retry/publication/claim/baseline operation allowed"); });
    const api = functions(batchCode, ["reconcileCompletedBatch"], { supabase: { from: () => query },
      recoverMissingBatchResponses: false, applyPaidLaneCandidateScopeFilter: x => x,
      loadSourcesById: async () => new Map([[input.source.id, input.source]]),
      geminiBatchResponseMap: async () => ({ responses: new Map(kind === "missing response" ? [] : [[input.candidate.id, provider]]), accounting: {} }),
      settleVisualBatchSpend: vi.fn(async () => {}), geminiBatchState: () => "BATCH_STATE_SUCCEEDED",
      objectValue: x => x || {}, normalizeGeminiUsage: () => ({}), geminiInlineError: () => kind === "provider error" ? { message: "Synthetic provider error" } : null,
      geminiInlineErrorMessage: value => value.message,
      geminiInlineResponsePayload: x => x, extractUsageMetadata: () => ({}), extractGeminiText: x => x.candidates[0].content.parts[0].text,
      extractGeminiFinishReason: x => x.candidates[0].finishReason, cleanNullable: x => x || null,
      visualReviewCompletionDecision, normalizeVisualBatchResult, isLegacyParagraphReviewCandidate,
      legacyReviewCompletenessDecision, apply: true, retainIncompleteReviewHold: retained,
      errorMessage: error => error.message, visualReviewResponseEscalationDecision: prohibited,
      claimCompletedCandidatePublication: prohibited, publishCandidateResult: prohibited, markCandidate: prohibited,
      report: { failed: 0, errors: [] } });
    const batchReport = {};
    await api.reconcileCompletedBatch("synthetic-batch", {}, batchReport);
    expect(retained).toHaveBeenCalledOnce(); expect(prohibited).not.toHaveBeenCalled();
    expect(batchReport.manual_review_required).toBe(1);
    if (kind === "MAX_TOKENS" || kind === "bad JSON") expect(retained.mock.calls[0][0].result.provider_response).toBe(provider);
  });
  it.each(["v1 marker", "v1 reason", "v2 marker", "v2 reason"])("actual guarded publisher cannot bypass an older failed evidence hold with %s", async version => {
    const input = version.startsWith("v2") ? actualPair() : pair();
    input.candidate.created_at = "2026-10-19T18:00:00Z";
    const old = { id: "older-held", status: "failed", created_at: "2026-10-18T18:00:00Z",
      ...(version.endsWith("marker") ? { worker_metadata: { review_completeness_hold: { baseline_advance_allowed: false } } }
        : { rejection_reason: "manual_review_required:legacy_review_completeness_missing" }) };
    const query = {}; for (const method of ["select", "eq", "in", "neq", "order"]) query[method] = () => query;
    query.limit = async () => ({ data: [old], error: null });
    const marked = vi.fn(async () => {}), prohibited = vi.fn(() => { throw Error("Must not publish/requeue/promote past an unresolved older hold"); });
    const api = functions(batchCode, ["publishCandidateResult", "publishCandidateResultUnlocked", "findPriorNonterminalPublication"], {
      legacyReviewCompletenessDecision, isLegacyParagraphReviewCandidate, archiveRoot: "synthetic-only",
      withVisualBaselineLockAsync: async ({ operation }) => operation(), assertVisualReviewCompletedResult: () => {},
      INITIAL_OFFICIAL_DOCUMENT_SCOPE: "initial_official_document", visualReviewSourceIdentityFreshness: () => ({ allowed: true }),
      supabase: { from: () => query }, compareVisualCandidateOrder, findBlockingPriorVisualPublication,
      recoverMissingBatchResponses: false, workerMetadataForCandidate: (candidate, value) => ({ ...candidate.worker_metadata, ...value }),
      markPublicationCandidate: marked, rebuildVisualReviewCandidateForCurrentPolicy: prohibited,
      promoteApprovedBaselineForCandidate: prohibited, retainIncompleteReviewHold: prohibited, report: {} });
    const result = version.startsWith("v2") ? reviewed(input) : { ...normalizeVisualBatchResult(response(), input), finish_reason: "STOP", provider_candidate_count: 1 };
    expect(await api.publishCandidateResult({ ...input, result, usage: {}, publicationClaimToken: "synthetic-owned" })).toEqual({ status: "retry_pending", reason: "prior_source_publication_pending" });
    expect(marked).toHaveBeenCalledOnce(); expect(marked.mock.calls[0][2]).toMatchObject({ status: "succeeded",
      worker_metadata: { baseline_advanced: false, blocked_by_prior_publication_candidate_id: old.id, reuse_completed_batch_response: true } });
    expect(prohibited).not.toHaveBeenCalled();
    expect(old.status).toBe("failed");
  });
  it.each(["ordinary terminal failure", "future held row"])("does not expand the existing ordering semantics for %s", async kind => {
    const input = actualPair(); input.candidate.created_at = "2026-10-19T18:00:00Z";
    const row = { id: "other-row", status: "failed", created_at: kind === "future held row" ? "2026-10-20T18:00:00Z" : "2026-10-18T18:00:00Z",
      rejection_reason: kind === "future held row" ? "manual_review_required:uncertain" : "terminal_provider_error" };
    const query = {}; for (const method of ["select", "eq", "in", "neq", "order"]) query[method] = () => query;
    query.limit = async () => ({ data: [row], error: null });
    const api = functions(batchCode, ["findPriorNonterminalPublication"], { supabase: { from: () => query },
      compareVisualCandidateOrder, findBlockingPriorVisualPublication, recoverMissingBatchResponses: false });
    expect(await api.findPriorNonterminalPublication(input.candidate)).toBeNull();
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
