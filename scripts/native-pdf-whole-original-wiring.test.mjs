import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import * as queue from "./lib/visual-review-queue.mjs";
import * as legacy from "./lib/legacy-review-completeness.mjs";
import { assessPdfTextCoverage, pdfTextComparisonHoldReason } from "./lib/pdf-text-coverage.mjs";
import { sourceBaselineFacts } from "./lib/source-quality.mjs";
import { SOURCE_HTML_PROFILE } from "./lib/source-html-evidence.mjs";
import { NATIVE_PDF_REVIEW_PROFILE } from "./lib/native-pdf-review.mjs";

// Public repository source ONLY. Never import the capture-worker entrypoint.
// Artifact reads and PDF parsing are labelled Map/synthetic boundaries; native
// filesystem safety, real PDF parsing, SQL concurrency and provider calls are
// NOT certified here. The actual producer, enqueue, snapshot/proof/payload and
// complete-diff functions execute unchanged, rather than a rewritten flow.
function parsed(path) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const functions = new Map(ast.statements.filter(ts.isFunctionDeclaration).map(node => [node.name.text, node]));
  return { ast, functions, declaration(name) {
    assert.ok(functions.has(name), `actual function ${name}`);
    return functions.get(name).getText(ast).replace(/^export\s+/, "");
  } };
}
const main = parsed("./capture-visual-snapshots.mjs"), leaf = parsed("./lib/native-pdf-review.mjs"), queued = parsed("./lib/visual-review-queue.mjs");
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const clone = value => JSON.parse(JSON.stringify(value));
// Production inputs are JSON. Normalize VM realm prototypes only, not values.
const jsonEqual = (left, right) => isDeepStrictEqual(clone(left), clone(right));
const decision = options => legacy.legacyReviewCompletenessDecision(clone(options));
const wholeDecision = options => legacy.nativePdfWholeOriginalCompletenessDecision(clone(options));
const archiveRoot = resolve("tmp/native-pdf-whole-original-map-only-no-files");
const pureDiffFunctions = ["buildDiffSummary", "normalizeVisibleText", "isVolatileLine", "normalizeText", "hasAwardRelevantTerms",
  "sentenceCandidates", "splitChangeSentences", "protectSentenceAbbreviations", "restoreSentenceAbbreviations", "dedupeText", "sentenceKey",
  "isUsefulChangedSentence", "contextualDatePhrases", "isAwardDateContext", "datePhrases", "unique", "contextualMoneyPhrases",
  "hasFundingAmountContext", "contextAroundMatch", "inferSection", "truncate", "excludedLegacyChangedUnits",
  "isVolatileOrBoilerplateFragment", "looksLikeRecipientNewsOrPressText", "looksLikeSourceAccessError"];
const pureDiff = runInNewContext(`${pureDiffFunctions.map(name => main.declaration(name)).join("\n")}\n({buildDiffSummary,normalizeVisibleText})`, {
  ...legacy, Buffer, sentenceDotPlaceholder: "__AP_SENTENCE_DOT__",
});

function fixture({ short = false } = {}) {
  const source = { id: "11111111-1111-4111-8111-111111111111", shared_award_id: "22222222-2222-4222-8222-222222222222",
    url: "https://example.edu/fellowship/guide.pdf", title: "Synthetic fellowship guide", page_type: "pdf",
    shared_awards: { name: "Synthetic Fellowship" } };
  const unchanged = Array.from({ length: short ? 1 : 180 }, (_, i) =>
    `Unchanged application context ${i} retains the audience qualifier, funding condition, exception and complete instructions.`).join("\n\n");
  const files = new Map(), parsedByHash = new Map(), docs = {};
  for (const [index, side] of ["previous", "current"].entries()) {
    const pages = [
      { page: 1, text: `The application deadline is March ${index + 1}, 2027.\n\n${unchanged}` },
      { page: 2, text: "Every applicant must retain the original audience qualifier and nomination conditions. Complete synthetic application instructions remain unchanged." },
    ];
    const native = pages.map(page => page.text).join("\n\n"), semantic = pureDiff.normalizeVisibleText(native);
    const pdf = Buffer.from(`%PDF-1.7\nSYNTHETIC-${side}; not a real PDF/parser fixture.\n%%EOF`);
    const dir = resolve(archiveRoot, side), pdfPath = resolve(dir, "document.pdf"), textPath = resolve(dir, "text.txt"), metaPath = resolve(dir, "meta.json");
    const metadata = { version: 1, kind: "pdf", source: clone(source), captured_at: `2026-10-0${index + 1}T00:00:00.000Z`,
      final_url: "https://cdn.example.edu/retained-guide.pdf", status_code: 200, content_type: "application/pdf",
      file_hash: sha(pdf), image_hash: sha(pdf), file_bytes: pdf.length, text_hash: sha(semantic), text_length: semantic.length,
      page_count: pages.length, pdf_text_error: null,
      pdf_text_coverage: assessPdfTextCoverage({ total: pages.length, pages: pages.map(page => ({ num: page.page, text: page.text })) }, sha(pdf)) };
    files.set(pdfPath, pdf); files.set(textPath, Buffer.from(`${semantic}\n`)); files.set(metaPath, Buffer.from(JSON.stringify(metadata)));
    parsedByHash.set(metadata.file_hash, { text: native, pages });
    docs[side] = { metadata, semantic, dir, pdfPath, textPath, metaPath };
  }
  const old = docs.previous, current = docs.current;
  const baseline = clone(old.metadata);
  // Faithful readBaselineEvidence: hashes/identity remain in baseline, NOT
  // copied into the previous object; text retains its exact writer LF.
  const previous = { kind: "pdf", dir: old.dir, pdfPath: old.pdfPath, textPath: old.textPath, metaPath: old.metaPath,
    text: `${old.semantic}\n`, meta: clone(old.metadata) };
  const capture = { ...clone(current.metadata), dir: current.dir, pdf_path: current.pdfPath,
    text_path: current.textPath, meta_path: current.metaPath, text: current.semantic };
  return { source, baseline, previous, capture, files, parsedByHash, docs };
}

function harness(options = {}) {
  const f = fixture(options), events = [], reviews = [], inserted = [];
  const report = new Proxy({ errors: [], review_paths: [], worker_run_id: "33333333-3333-4333-8333-333333333333" }, {
    get: (target, key) => Object.hasOwn(target, key) ? target[key] : 0,
  });
  const fakeRead = (path, encoding) => {
    assert.ok(f.files.has(path), "Map-only artifact read must not fall through to filesystem");
    const bytes = Buffer.from(f.files.get(path));
    return encoding ? bytes.toString(encoding) : bytes;
  };
  const queueFunctions = ["buildVisualSnapshotRef", "buildVisualReviewPromptPayload", "snapshotRef", "snapshotVisualStateRefs",
    "visualStateGeometryMetadata", "visualSnapshotGeometryReference", "validateSnapshotArtifactSemantics", "validateCapturedHtmlForReview",
    "assertSemanticFileHash", "validateLayoutSemanticHashes", "pathRef", "directoryRef", "shouldIncludeImagesForCandidate", "thumbnailPath",
    "objectValue", "arrayValue", "stringArray", "cleanNullable", "normalizeText"];
  const producer = runInNewContext(`${queueFunctions.map(name => queued.declaration(name)).join("\n")}\n({buildVisualSnapshotRef,buildVisualReviewPromptPayload})`, {
    ...queue, crypto, Buffer, sourceBaselineFacts, SOURCE_HTML_PROFILE, NATIVE_PDF_REVIEW_PROFILE,
    legacyReviewCompletenessDecision: decision, nativePdfWholeOriginalCompletenessDecision: wholeDecision,
    readFileSync: fakeRead, existsSync: path => [...f.files.keys()].some(key => key.startsWith(`${path}/`) || key.startsWith(`${path}\\`)),
    statSync: () => ({ isDirectory: () => true }),
  });
  const constants = leaf.ast.statements.filter(ts.isVariableStatement).map(node => node.getText(leaf.ast).replace(/^export\s+/, "")).join("\n");
  const leafFunctions = ["utf8", "readSide", "readNativePair", "wholeOriginalProof", "prepareNativePdfReviewCompleteness", "verifyNativePdfReviewCompleteness"];
  const native = runInNewContext(`${constants}\n${leafFunctions.map(name => leaf.declaration(name)).join("\n")}\n({prepareNativePdfReviewCompleteness,verifyNativePdfReviewCompleteness})`, {
    Buffer, TextDecoder, createHash: crypto.createHash, equal: jsonEqual, isAbsolute, resolve,
    ...legacy, legacyReviewCompletenessDecision: decision, nativePdfWholeOriginalCompletenessDecision: wholeDecision,
    regularPath(path, root) { const inside = relative(resolve(root), resolve(path)); assert.ok(!inside.startsWith("..") && !isAbsolute(inside)); return path; },
    readArtifact(descriptor, root, cap) {
      events.push("bound_artifact_read");
      const inside = relative(resolve(root), resolve(descriptor.path)); assert.ok(!inside.startsWith("..") && !isAbsolute(inside));
      const body = fakeRead(descriptor.path);
      assert.ok(body.length <= cap && body.length === descriptor.byte_length && sha(body) === descriptor.sha256, "bound synthetic original bytes");
      return { body, descriptor, path: descriptor.path };
    },
    async parseNative(doc) {
      events.push("synthetic_parser");
      const parsed = clone(f.parsedByHash.get(doc.meta.file_hash));
      assert.equal(pureDiff.normalizeVisibleText(parsed.text), doc.native);
      assert.equal(parsed.pages.length, doc.meta.page_count);
      return parsed;
    },
  });
  let lastDiff;
  const context = { ...queue, ...legacy, ...producer, Buffer, archiveRoot,
    legacyReviewCompletenessDecision: decision,
    interpretVisualChanges: options.interpret !== false, visualReviewMode: options.mode || "batch", keepUnchanged: true, promote: false,
    captureBehaviorVersion: 13, captureBehaviorName: "synthetic-existing-pdf-profile", promptChars: 12_000, visualReviewBatchModel: "gemini-2.5-flash-lite",
    console: { log() {} }, jsonObjectOrEmpty: value => value && typeof value === "object" ? value : {},
    sourceLabel: source => source.id, errorMessage: error => error?.message || String(error), toArchiveRelative: value => value,
    buildDiffSummary(...args) { lastDiff = clone(pureDiff.buildDiffSummary(...args)); options.editDiff?.(lastDiff); return lastDiff; },
    pdfTextComparisonHoldReason,
    async prepareNativePdfReviewCompleteness(input) {
      events.push("prepare"); const proof = clone(await native.prepareNativePdfReviewCompleteness(input));
      options.editPrepared?.(proof); events.push("prepared"); return proof;
    },
    async verifyNativePdfReviewCompleteness(input) { events.push("verify"); const proof = await native.verifyNativePdfReviewCompleteness(input); events.push("verified"); return proof; },
    saveReviewRecord(input) { events.push("hold_record"); reviews.push(clone(input)); return "map-only-review.json"; },
    async markSharedSourceVisualCheckSucceeded() { events.push("health_boundary"); },
    async maybeRepairMissingR2Snapshot() { events.push("repair_boundary"); },
    removeGeneratedCaptureDir() { throw new Error("Unexpected retention deletion"); },
    gateVisualReviewCandidateForAi(input) { events.push("existing_ai_gate"); return { allowed: true, deterministic: input.deterministic }; },
    async findVisualRejectionLedgerMatch() { events.push("ledger_boundary"); return { unavailable: false, match: null }; },
    async recordVisualReviewCandidateRunObservation() { events.push("observation_boundary"); return { inserted: true }; },
    async queueAwardReconciliationFromSource() { events.push("reconciliation_boundary"); },
    beginStage1CandidateMutationAccounting() {},
    supabase: { from(table) {
      assert.equal(table, "shared_award_visual_review_candidates"); events.push("candidate_table");
      return { upsert(row, policy) {
        assert.equal(policy.onConflict, "candidate_signature"); assert.equal(policy.ignoreDuplicates, true);
        events.push("candidate_insert"); inserted.push(clone(row));
        return { select: () => ({ maybeSingle: async () => ({ data: { id: "44444444-4444-4444-8444-444444444444", status: "pending" }, error: null }) }) };
      } };
    } },
  };
  const functions = ["processPdfComparison", "enqueueVisualReviewCandidate", "holdIncompleteLegacyReview"];
  const actual = runInNewContext(`${functions.map(name => main.declaration(name)).join("\n")}\n({processPdfComparison,enqueueVisualReviewCandidate})`, context);
  const args = diff => ({ source: f.source, baseline: f.baseline, previous: f.previous, capture: f.capture, diff,
    deterministic: { classification: "candidate_change", reason: "pdf_file_hash_changed" }, report });
  return { ...f, events, reviews, inserted, report, producer, native,
    get diff() { return lastDiff; },
    async run() { return actual.processPdfComparison(f.source, f.baseline, f.previous, f.capture, report); },
    async completeDiff() {
      const diff = clone(pureDiff.buildDiffSummary(f.previous.text, f.capture.text, f.source));
      diff.native_pdf_completeness = clone(await native.prepareNativePdfReviewCompleteness({ ...args(diff), previousText: f.previous.text,
        currentText: f.capture.text, archiveRoot, previousSnapshotRef: producer.buildVisualSnapshotRef(f.previous, value => value, f.baseline),
        newSnapshotRef: producer.buildVisualSnapshotRef(f.capture, value => value) }));
      return diff;
    },
    async enqueue(diff) { return actual.enqueueVisualReviewCandidate(args(diff)); },
  };
}

test("actual fresh long-native producer prepares full originals before legacy hold, AI gate and independently verified enqueue", async () => {
  const h = harness(); await h.run();
  assert.equal(h.reviews.length, 0); assert.equal(h.inserted.length, 1);
  const at = name => h.events.indexOf(name);
  assert.ok(at("prepare") < at("existing_ai_gate") && at("existing_ai_gate") < at("verify") && at("verified") < at("candidate_table"));
  assert.equal(h.events.filter(name => name === "synthetic_parser").length, 4);
  assert.equal(h.events.filter(name => name === "bound_artifact_read").length, 24);
  const row = h.inserted[0], proof = row.deterministic_diff.native_pdf_completeness;
  assert.equal(proof.schema, legacy.nativePdfWholeOriginalCompletenessSchema);
  assert.equal(proof.excluded_changed_units, 0); assert.equal(proof.previous.page_count, 2); assert.equal(proof.current.page_count, 2);
  assert.equal(proof.previous.text_writer_frame, "one_lf"); assert.equal(proof.current.text_writer_frame, "none");
  assert.ok(proof.previous.text_length > 16_000 && proof.current.text_length > 16_000);
  assert.equal(proof.source.id, h.source.id); assert.equal(proof.source.stored_owner_id, h.source.shared_award_id);
  assert.equal(row.prompt_payload.native_pdf_review_profile, NATIVE_PDF_REVIEW_PROFILE);
  assert.equal(row.prompt_payload.text_context_representation, "complete_original_pdfs");
  assert.equal(row.prompt_payload.previous_text_excerpt, ""); assert.equal(row.prompt_payload.new_text_excerpt, "");
  assert.deepEqual(row.prompt_payload.deterministic_diff.native_pdf_completeness, proof);
  assert.equal(row.candidate_signature, queue.visualReviewCandidateSignatureFromStoredCandidate(row));
  assert.equal(row.gemini_batch_request_key, row.candidate_signature);
  assert.equal(row.previous_snapshot_ref.file_hash, h.baseline.file_hash);
  assert.equal(row.previous_snapshot_ref.metadata.page_count, null, "previous sparse constructor must not be artificially enriched");
  assert.equal(row.new_snapshot_ref.metadata.page_count, 2);
});

for (const [label, mutate] of [
  ["source ID", h => { h.source.id = "55555555-5555-4555-8555-555555555555"; }],
  ["stored owner", h => { h.source.shared_award_id = "55555555-5555-4555-8555-555555555555"; }],
  ["source URL", h => { h.source.url = "https://example.edu/other.pdf"; }],
  ["original PDF", h => { h.files.set(h.docs.previous.pdfPath, Buffer.from("corrupt synthetic original")); }],
  ["retained text", h => { h.files.set(h.docs.current.textPath, Buffer.from("different native context\n")); }],
]) test(`fresh ${label} mismatch cannot manufacture a proof or reach candidate insertion`, async () => {
  const h = harness(); mutate(h); await h.run();
  assert.equal(h.inserted.length, 0); assert.equal(h.reviews.length, 1);
  assert.equal(h.diff.native_pdf_completeness, undefined);
  assert.equal(h.reviews[0].reason, "legacy_review_complete_context_exceeds_bound");
  assert.equal(h.events.includes("existing_ai_gate"), false);
  assert.equal(h.reviews[0].deterministic.baseline_advance_allowed, false);
});

for (const [label, configure, reason] of [
  ["same bytes", h => { h.capture.file_hash = h.baseline.file_hash; }, null],
  ["same native text", h => { h.capture.text_hash = h.baseline.text_hash; }, "pdf_changed_bytes_same_text_requires_visual_review"],
  ["sparse previous", h => { h.previous.meta.pdf_text_coverage.status = "sparse_pages"; }, "pdf_previous_page_text_coverage_unverified"],
  ["sparse current", h => { h.capture.pdf_text_coverage.status = "sparse_pages"; }, "pdf_current_page_text_coverage_unverified"],
]) test(`existing ${label} PDF branch is not admitted by the new producer`, async () => {
  const h = harness(); configure(h); await h.run();
  assert.equal(h.events.includes("prepare"), false); assert.equal(h.inserted.length, 0);
  if (reason) assert.equal(h.reviews[0].reason, reason);
  else { assert.equal(h.report.pdf_unchanged, 1); assert.equal(h.reviews.length, 0); }
});

for (const options of [{ interpret: false }, { mode: "inline" }, { editDiff: diff => { diff.legacy_review_completeness.excluded_changed_units = 1; } }]) {
  test(`disabled/nonbatch/incomplete contract remains held: ${Object.keys(options)[0]}`, async () => {
    const h = harness(options); await h.run();
    assert.equal(h.events.includes("prepare"), false); assert.equal(h.inserted.length, 0); assert.equal(h.reviews.length, 1);
  });
}

test("an old short complete PDF follows its unchanged legacy path without a whole-original proof", async () => {
  const h = harness({ short: true }); await h.run();
  assert.equal(h.events.includes("prepare"), false); assert.equal(h.inserted.length, 1);
  assert.equal(Object.hasOwn(h.inserted[0].deterministic_diff, "native_pdf_completeness"), false);
  assert.equal(h.inserted[0].prompt_payload.text_context_representation, undefined);
  assert.equal(h.inserted[0].prompt_payload.previous_text_excerpt, h.previous.text);
});

for (const [label, mutate] of [
  ["source", h => { h.source.id = "55555555-5555-4555-8555-555555555555"; }],
  ["owner", h => { h.source.shared_award_id = "55555555-5555-4555-8555-555555555555"; }],
  ["root", (_h, diff) => { diff.native_pdf_completeness.archive_root = resolve(archiveRoot, "other"); }],
  ["proof page hash", (_h, diff) => { diff.native_pdf_completeness.current.pages[0].native_text_sha256 = "a".repeat(64); }],
  ["raw original race", h => { h.files.set(h.docs.previous.pdfPath, Buffer.from("changed after acquisition")); }],
  ["metadata time race", h => { const meta = clone(h.docs.current.metadata); meta.captured_at = "2026-10-03T00:00:00.000Z"; h.files.set(h.docs.current.metaPath, Buffer.from(JSON.stringify(meta))); }],
]) test(`actual enqueue re-verifies ${label} before any candidate table/ledger boundary`, async () => {
  const h = harness(), diff = await h.completeDiff(); mutate(h, diff);
  diff.native_pdf_completeness.digest = legacy.nativePdfWholeOriginalCompletenessDigest(diff.native_pdf_completeness);
  const result = await h.enqueue(diff);
  assert.equal(result.manual_review_required, true); assert.equal(result.candidate_inserted, false);
  assert.equal(h.inserted.length, 0); assert.equal(h.events.includes("candidate_table"), false); assert.equal(h.events.includes("ledger_boundary"), false);
  assert.equal(h.reviews.length, 1); assert.equal(h.reviews[0].deterministic.baseline_advance_allowed, false);
  assert.deepEqual(h.reviews[0].diff, diff, "failed verification retains the original complete diff, not a fabricated empty one");
});

test("stored policy rebuild cannot retrofit whole-original proof into an old long-context hold", () => {
  const h = harness(), diff = clone(pureDiff.buildDiffSummary(h.previous.text, h.capture.text, h.source));
  const payload = clone(h.producer.buildVisualReviewPromptPayload({ source: h.source, baseline: h.baseline, previous: h.previous,
    capture: h.capture, diff, deterministic: { reason: "pdf_file_hash_changed" }, behaviorVersion: 13, behaviorName: "synthetic", archiveRelative: value => value }));
  const row = { shared_award_source_id: h.source.id, shared_award_id: h.source.shared_award_id, source_url: h.source.url, source_page_type: "pdf",
    candidate_scope: "content_change", deterministic_diff: diff, prompt_payload: payload, previous_text_hash: h.baseline.text_hash,
    new_text_hash: h.capture.text_hash, previous_file_hash: h.baseline.file_hash, new_file_hash: h.capture.file_hash,
    previous_snapshot_ref: payload.previous_snapshot_ref, new_snapshot_ref: payload.new_snapshot_ref };
  const before = clone(row), rebuilt = queue.rebuildVisualReviewCandidateForCurrentPolicy(row, { source: h.source });
  assert.deepEqual(row, before); assert.equal(Object.hasOwn(rebuilt.prompt_payload.deterministic_diff, "native_pdf_completeness"), false);
  assert.equal(rebuilt.prompt_payload.text_context_representation, undefined);
  assert.equal(legacy.legacyReviewCompletenessDecision({ candidate: { ...row, ...rebuilt }, source: h.source }).reason, "legacy_review_complete_context_exceeds_bound");
});

test("whole-original proof participates in the actual stored candidate signature", async () => {
  const h = harness(); await h.run(); const row = h.inserted[0], changed = clone(row);
  changed.deterministic_diff.native_pdf_completeness.current.pages[0].native_text_sha256 = "a".repeat(64);
  changed.deterministic_diff.native_pdf_completeness.digest = legacy.nativePdfWholeOriginalCompletenessDigest(changed.deterministic_diff.native_pdf_completeness);
  changed.prompt_payload.deterministic_diff = clone(changed.deterministic_diff);
  assert.notEqual(queue.visualReviewCandidateSignatureFromStoredCandidate(changed), row.candidate_signature);
  // A valid whole-original proof delegates rather than returning allowed:true;
  // that alone is NOT a negative assertion. Exercise the real raw verifier.
  const refused = await h.enqueue(changed.deterministic_diff);
  assert.equal(refused.manual_review_required, true);
  assert.equal(h.inserted.length, 1, "a changed proof cannot create a second candidate");
});
