import { createHash } from "node:crypto";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({ results: [], calls: [], destroys: 0, hook: null, hang: false, cleanup: null, fileStat: null, statOptions: [] }));
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, fstatSync(fd, options) {
    const stat = actual.fstatSync(fd, options); mocked.statOptions.push(options);
    return mocked.fileStat ? mocked.fileStat(stat, options) : stat;
  } };
});
vi.mock("pdf-parse", () => ({ PDFParse: class {
  constructor(options) { mocked.calls.push({ options }); }
  async getText(options) {
    mocked.calls.at(-1).getText = options;
    if (mocked.hang) return new Promise(() => {});
    const result = mocked.results.shift(); if (mocked.hook) await mocked.hook();
    return result;
  }
  async destroy() { mocked.destroys++; if (mocked.cleanup) await mocked.cleanup(); }
} }));

import { NATIVE_PDF_REVIEW_PROFILE, nativePdfCandidate, nativePdfResponseSchema, prepareNativePdfReview, validateNativePdfReviewResult,
  prepareNativePdfReviewCompleteness, verifyNativePdfReviewCompleteness } from "./native-pdf-review.mjs";
import { buildVisualReviewPromptPayload, normalizeVisualBatchResult, visualReviewEvidenceSignatureFromStoredCandidate,
  visualReviewResponseSchemaForCandidate, rebuildVisualReviewCandidateForCurrentPolicy } from "./visual-review-queue.mjs";
import { buildLegacyReviewCompleteness, legacyReviewCompletenessDecision, nativePdfWholeOriginalCompletenessDecision,
  nativePdfWholeOriginalCompletenessDigest } from "./legacy-review-completeness.mjs";
import { assessPdfTextCoverage } from "./pdf-text-coverage.mjs";
import { normalizeVisibleText } from "./capture-stability.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const clone = value => JSON.parse(JSON.stringify(value));
const source = { id: "11111111-1111-4111-8111-111111111111", shared_award_id: "22222222-2222-4222-8222-222222222222",
  url: "https://example.edu/award.pdf", title: "SYNTHETIC award", page_type: "pdf" };
const before = "The application deadline is March 1, 2027.", after = "The application deadline is March 2, 2027.";
const context = " Applicants must retain all audience qualifiers and conditions. This is synthetic test text, not an actual award fact.";
let directory, docs, candidate;

function writeDoc(side) {
  const doc = docs[side];
  writeFileSync(doc.pdf_path, doc.pdf); writeFileSync(doc.text_path, `${doc.semantic}\n`);
  writeFileSync(doc.meta_path, JSON.stringify(doc.meta));
}
function rebuild(diff = { added_text: [after], removed_text: [before], date_changes: [], amount_changes: [] }) {
  const previous = docs.previous, current = docs.current;
  const payload = buildVisualReviewPromptPayload({ source, baseline: previous.meta,
    // Faithful previous readBaselineEvidence shape: metadata stays nested.
    previous: { kind: "pdf", dir: previous.dir, pdfPath: previous.pdf_path, textPath: previous.text_path,
      metaPath: previous.meta_path, text: `${previous.semantic}\n`, meta: previous.meta },
    capture: { ...current.meta, dir: current.dir, pdf_path: current.pdf_path, text_path: current.text_path,
      meta_path: current.meta_path, text: current.semantic },
    diff,
    deterministic: { classification: "candidate_change", reason: "pdf_file_hash_changed" },
    behaviorVersion: 13, behaviorName: "synthetic-existing-native-text-profile" });
  candidate = { id: "33333333-3333-4333-8333-333333333333", shared_award_source_id: source.id, shared_award_id: source.shared_award_id,
    source_url: source.url, candidate_scope: "content_change", candidate_signature: hash("SYNTHETIC real-stored-ID fixture"),
    status: "processing", model: "gemini-2.5-flash-lite", worker_metadata: { native_pdf_review_profile: NATIVE_PDF_REVIEW_PROFILE,
      submission_claim_token: "44444444-4444-4444-8444-444444444444", review_model: "gemini-3.8-flash" },
    previous_snapshot_ref: payload.previous_snapshot_ref, new_snapshot_ref: payload.new_snapshot_ref,
    previous_file_hash: previous.meta.file_hash, new_file_hash: current.meta.file_hash,
    previous_image_hash: previous.meta.file_hash, new_image_hash: current.meta.file_hash,
    previous_text_hash: previous.meta.text_hash, new_text_hash: current.meta.text_hash, prompt_payload: payload };
}
function fixture() {
  const base = resolve(dirname(fileURLToPath(import.meta.url)), "../../tmp/scrapling-finalization-20261018");
  mkdirSync(base, { recursive: true }); directory = mkdtempSync(join(base, "native-pdf-review-synthetic-")); docs = {};
  for (const [i, side] of ["previous", "current"].entries()) {
    const dir = join(directory, side); mkdirSync(dir);
    const sentence = side === "previous" ? before : after;
    const pages = [{ num: 1, text: sentence + context }, { num: 2, text: "Second complete synthetic native page." + context }];
    const parsed = { total: pages.length, pages, text: pages.map(page => page.text).join("\n\n") };
    const pdf = Buffer.from(`%PDF-1.7\nSYNTHETIC ${side}; parser is mocked and does not open this as a real PDF.`);
    const semantic = normalizeVisibleText(parsed.text);
    const meta = { version: 1, kind: "pdf", source: clone(source), captured_at: `2026-01-0${i + 1}T00:00:00.000Z`,
      final_url: "https://cdn.example.edu/redirected-award.pdf", status_code: 200, content_type: "application/pdf",
      file_hash: hash(pdf), image_hash: hash(pdf), text_hash: hash(semantic), text_length: semantic.length,
      file_bytes: pdf.length, page_count: parsed.total, pdf_text_error: null, pdf_text_coverage: assessPdfTextCoverage(parsed, hash(pdf)) };
    docs[side] = { dir, parsed, pdf, meta, semantic, pdf_path: join(dir, "document.pdf"), text_path: join(dir, "text.txt"), meta_path: join(dir, "meta.json") };
    writeDoc(side);
  }
  rebuild(); mocked.results = [clone(docs.previous.parsed), clone(docs.current.parsed)]; mocked.calls = []; mocked.destroys = 0;
  mocked.hook = null; mocked.hang = false; mocked.cleanup = null; mocked.fileStat = null; mocked.statOptions = [];
}
const prepare = (options = {}) => prepareNativePdfReview({ candidate, source, archiveRoot: directory, ...options });
const held = reason => expect(prepare()).rejects.toMatchObject({ code: `native_pdf_review_${reason}`, nativePdfReviewHold: true });
function editMeta(side, fn) { fn(docs[side].meta); writeDoc(side); rebuild(); }
function synchronizeRef(side) {
  candidate.prompt_payload[side === "previous" ? "previous_snapshot_ref" : "new_snapshot_ref"] = clone(candidate[side === "previous" ? "previous_snapshot_ref" : "new_snapshot_ref"]);
}
function response(pair) {
  const raw = { is_true_change: true, is_alert_worthy: true,
    changed_facts: [{ fact: "Synthetic application deadline changed", before, after, removed_text: before, added_text: after, visual_evidence: null }],
    pdf_review: { profile: NATIVE_PDF_REVIEW_PROFILE, previous_sha256: pair.previous.sha256, current_sha256: pair.current.sha256,
      previous_pages: pair.previous.pages.map(page => page.page), current_pages: pair.current.pages.map(page => page.page), uncertain_pages: [],
      page_evidence: [{ fact_index: 0, previous_page: 1, current_page: 1 }] } };
  return { ...clone(raw), raw_result: raw, finish_reason: "STOP", provider_candidate_count: 1 };
}
function decision(pair, result) { return validateNativePdfReviewResult({ candidate, pair, result }); }
beforeEach(fixture);
afterEach(() => {
  vi.useRealTimers(); vi.restoreAllMocks();
  // Retain only this test's unique canonical-tmp fixtures. No recursive cleanup.
});

describe("claimed native-PDF pair preparation (PDFParse mocked; no provider/native process)", () => {
  it("uses actual producer refs, sparse previous metadata and exact complete originals", async () => {
    expect(candidate.previous_snapshot_ref.metadata.page_count).toBeNull();
    expect(candidate.new_snapshot_ref.metadata.page_count).toBe(2);
    const out = await prepare();
    expect(out.parts.map(part => part.inlineData?.mimeType || "label")).toEqual(["label", "application/pdf", "label", "application/pdf"]);
    for (const [i, side] of ["previous", "current"].entries()) {
      expect(Buffer.from(out.parts[i * 2 + 1].inlineData.data, "base64")).toEqual(docs[side].pdf);
      expect(out.verifiedPdfInputs[i]).toEqual({ sha256: docs[side].meta.file_hash, byte_length: docs[side].pdf.length,
        page_count: 2, native_text: docs[side].parsed.text });
      expect(out.pair[side].pages).toEqual(docs[side].parsed.pages.map(page => ({ page: page.num, text: page.text })));
    }
    expect(out.pair).toMatchObject({ candidate_id: candidate.id, candidate_signature: candidate.candidate_signature, source_id: source.id,
      award_id: source.shared_award_id, source_url: source.url, profile: NATIVE_PDF_REVIEW_PROFILE });
    expect(mocked.calls).toHaveLength(2); expect(mocked.calls.every(call => call.getText.first === 25 && call.options.useWorkerFetch === false)).toBe(true);
    expect(mocked.destroys).toBe(2); expect(Object.isFrozen(out.pair.current.pages)).toBe(true);
    expect(out.instructions).toContain("only corroborate existing native-text changes");
    expect(out).not.toHaveProperty("provider_call_allowed"); expect(out).not.toHaveProperty("publication_allowed");
  });
  it("publication rebind skips only submission state/claim, not profile, model or retained inputs", async () => {
    candidate.status = "succeeded"; delete candidate.worker_metadata.submission_claim_token;
    await held("submission_claim"); await expect(prepare({ requireSubmissionClaim: false })).resolves.toHaveProperty("pair.candidate_id", candidate.id);
  });
  it.each([
    ["marker", c => delete c.worker_metadata.native_pdf_review_profile, "profile_missing"],
    ["bad ID", c => c.id = "not-a-stored-uuid", "candidate_identity"],
    ["bad signature", c => c.candidate_signature = "x", "candidate_identity"],
    ["unclaimed", c => delete c.worker_metadata.submission_claim_token, "submission_claim"],
    ["wrong status", c => c.status = "pending", "submission_claim"],
    ["wrong model", c => c.worker_metadata.review_model = "gemini-2.5-flash-lite", "model"],
    ["wrong source owner", c => c.shared_award_id = source.id, "source_identity"],
    ["changed URL", c => c.source_url += "?changed", "source_identity"],
    ["prompt source drift", c => c.prompt_payload.source.id = source.shared_award_id, "prompt_source_identity"],
  ])("holds %s before parsing", async (_, mutate, code) => { mutate(candidate); await held(code); expect(mocked.calls).toHaveLength(0); });
  it("does not detect or prepare first-document and mixed PDF/browser candidates", async () => {
    candidate.candidate_scope = "initial_official_document"; expect(nativePdfCandidate(candidate)).toBe(false); await held("candidate_scope");
    candidate.candidate_scope = "content_change"; candidate.previous_snapshot_ref.kind = "webpage"; expect(nativePdfCandidate(candidate)).toBe(false);
  });
  it("rejects direct/prompt ref disagreement", async () => {
    candidate.prompt_payload = clone(candidate.prompt_payload); candidate.prompt_payload.new_snapshot_ref.final_url = source.url;
    await held("prompt_reference_mismatch");
  });
  it("rejects a wrong closed manifest even when top and prompt copies agree", async () => {
    candidate.new_snapshot_ref.artifact_manifest.artifacts[0].byte_length++;
    synchronizeRef("current"); await held("artifact_manifest");
  });
  it("does not route a PDF through thumb/page/layout or expansion-state fields", async () => {
    candidate.new_snapshot_ref.local_paths.thumb = clone(candidate.new_snapshot_ref.local_paths.pdf); synchronizeRef("current");
    await held("pdf_artifact_roles");
  });
  it("holds altered raw bytes rather than accepting newly observed hashes", async () => {
    writeFileSync(docs.current.pdf_path, Buffer.alloc(docs.current.pdf.length, 1)); await held("artifact_bytes_changed");
  });
  it("rejects hard-linked input files", async () => {
    linkSync(docs.current.pdf_path, join(directory, "same-file.pdf")); await held("artifact_alias_or_size");
  });
  it("keeps adjacent large file IDs distinct even when Number would round them together", async () => {
    const ids = new Map(), first = 2n ** 60n;
    expect(Number(first)).toBe(Number(first + 1n));
    mocked.fileStat = (stat, options) => {
      const key = `${stat.dev}:${stat.ino}`;
      if (!ids.has(key)) ids.set(key, first + BigInt(ids.size));
      return { ...stat, ino: options?.bigint ? ids.get(key) : Number(ids.get(key)), isFile: () => stat.isFile() };
    };
    await expect(prepare()).resolves.toHaveProperty("pair.candidate_id", candidate.id);
    expect(ids.size).toBe(6); expect(mocked.statOptions.every(options => options?.bigint === true)).toBe(true);
  });
  it("still rejects the same exact large file ID on different paths", async () => {
    mocked.fileStat = (stat, options) => ({ ...stat, ino: options?.bigint ? 2n ** 60n : Number(2n ** 60n), isFile: () => stat.isFile() });
    await held("artifact_alias_or_size"); expect(mocked.calls).toHaveLength(0);
  });
  it("detects a one-unit large file ID mutation during the read", async () => {
    let reads = 0; const first = 2n ** 60n;
    mocked.fileStat = (stat, options) => {
      const inode = first + BigInt(reads++);
      return { ...stat, ino: options?.bigint ? inode : Number(inode), isFile: () => stat.isFile() };
    };
    await held("artifact_bytes_changed"); expect(mocked.calls).toHaveLength(0);
  });
  it("rejects paths outside the exact supplied archive", async () => {
    await expect(prepare({ archiveRoot: docs.current.dir })).rejects.toMatchObject({ code: "native_pdf_review_artifact_outside_archive" });
  });
  it.each([
    ["source", m => m.source.id = source.shared_award_id], ["owner", m => m.source.shared_award_id = source.id],
    ["URL", m => m.source.url += "?other"], ["kind", m => m.kind = "webpage"], ["status", m => m.status_code = 403],
    ["MIME", m => m.content_type = "text/html"], ["timestamp", m => m.captured_at = "2026-01-03T00:00:00.000Z"],
    ["final URL", m => m.final_url = source.url], ["file SHA", m => m.file_hash = hash("other")],
    ["text SHA", m => m.text_hash = hash("other")], ["byte length", m => m.file_bytes++], ["native length", m => m.text_length++],
    ["zero pages", m => m.page_count = 0], ["26 pages", m => m.page_count = 26], ["parser error", m => m.pdf_text_error = "held"],
  ])("holds sealed %s drift with an otherwise re-bound raw manifest", async (_, mutate) => {
    // Preserve genuine candidate/ref scalar identity while changing only sealed metadata.
    const original = clone(candidate); const meta = clone(docs.current.meta); mutate(meta);
    writeFileSync(docs.current.meta_path, JSON.stringify(meta));
    const bytes = readFileSync(docs.current.meta_path), ref = candidate.new_snapshot_ref;
    ref.local_paths.meta = { ...ref.local_paths.meta, sha256: hash(bytes), bytes: bytes.length, byte_length: bytes.length };
    const artifacts = ref.artifact_manifest.artifacts.map(row => row.role === "meta" ? { ...row, sha256: hash(bytes), byte_length: bytes.length } : row);
    // Actual producer recomputes exactly the same closed sorted role manifest.
    const stable = value => JSON.stringify(Object.fromEntries(Object.keys(value).sort().map(k => [k, Array.isArray(value[k])
      ? value[k].map(row => Object.fromEntries(Object.keys(row).sort().map(key => [key, row[key]]))) : value[k]])));
    ref.artifact_manifest = { version: 1, artifacts, complete: true, digest: hash(stable({ version: 1, artifacts })), missing_roles: [] };
    ref.artifact_manifest_digest = ref.artifact_manifest.digest;
    candidate.prompt_payload = clone(original.prompt_payload); candidate.prompt_payload.new_snapshot_ref = clone(ref);
    candidate.prompt_payload.hashes.new_artifact_manifest_digest = ref.artifact_manifest.digest;
    await held("sealed_metadata"); expect(mocked.calls).toHaveLength(0);
  });
  it("requires any declared ref metadata to agree with sealed metadata", async () => {
    candidate.previous_snapshot_ref.metadata.page_count = 3; synchronizeRef("previous"); await held("reference_metadata");
  });
  it("requires prompt hashes rather than trusting the ref alone", async () => {
    candidate.prompt_payload.hashes.new_file_hash = hash("unbound"); await held("prompt_hashes");
  });
  it.each([
    ["missing page", result => result.pages.pop(), "native_page_list"],
    ["page order", result => result.pages.reverse(), "native_page_list"],
    ["wrong count", result => result.total++, "native_page_list"],
    ["different native text", result => result.text += " changed condition", "native_text_binding"],
    ["different per-page count", result => result.pages[0].text = "sparse", "native_text_binding"],
  ])("holds independently parsed %s", async (_, mutate, code) => { mutate(mocked.results[0]); await held(code); expect(mocked.destroys).toBe(1); });
  it("does not remove the pre-existing sparse-page hold", async () => {
    const parsed = docs.previous.parsed; parsed.pages[1].text = "sparse"; parsed.text = parsed.pages.map(page => page.text).join("\n\n");
    docs.previous.semantic = normalizeVisibleText(parsed.text); docs.previous.meta.text_hash = hash(docs.previous.semantic); docs.previous.meta.text_length = docs.previous.semantic.length;
    docs.previous.meta.pdf_text_coverage = assessPdfTextCoverage(parsed, docs.previous.meta.file_hash); writeDoc("previous"); rebuild();
    mocked.results[0] = clone(parsed); await held("native_text_binding");
  });
  it("detects raw mutation during asynchronous parsing before returning provider parts", async () => {
    mocked.hook = () => { writeFileSync(docs.previous.pdf_path, Buffer.alloc(docs.previous.pdf.length, 1)); };
    await held("artifact_bytes_changed"); expect(mocked.destroys).toBe(2);
  });
  it("holds cleanup failure and never returns parts", async () => {
    mocked.cleanup = () => { throw new Error("PRIVATE/path/secret must not escape"); };
    await held("parser_cleanup_failed");
  });
  it("bounds stalled parsing, destroys the parser and does not parse the other side", async () => {
    vi.useFakeTimers(); mocked.hang = true;
    const check = held("parser_timeout"); await vi.advanceTimersByTimeAsync(30001); await check;
    expect(mocked.destroys).toBe(1); expect(mocked.calls).toHaveLength(1);
  });
  it("rejects a same-time pair before parsing", async () => {
    editMeta("current", meta => meta.captured_at = docs.previous.meta.captured_at); await held("pair_order_or_bytes");
  });
  it.each([
    ["extended-year forward", "2026-01-01T00:00:00.000Z", "+010000-01-01T00:00:00.000Z", true],
    ["extended-year reverse", "+010000-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z", false],
  ])("orders concrete %s metadata by parsed instants", async (_, previousAt, currentAt, allowed) => {
    editMeta("previous", meta => meta.captured_at = previousAt);
    editMeta("current", meta => meta.captured_at = currentAt);
    if (allowed) {
      await expect(prepare()).resolves.toHaveProperty("pair.candidate_id", candidate.id);
      expect(mocked.calls).toHaveLength(2);
    } else {
      await held("pair_order_or_bytes"); expect(mocked.calls).toHaveLength(0);
    }
  });
  it.each(["2026-01-02T01:00:00+01:00", "2026-01-02T00:00:00Z"])("still rejects noncanonical sealed capture time %s before parsing", async capturedAt => {
    editMeta("current", meta => meta.captured_at = capturedAt);
    await held("sealed_metadata"); expect(mocked.calls).toHaveLength(0);
  });
  it("bounds the combined original PDFs before parsing", async () => {
    for (const side of ["previous", "current"]) {
      const doc = docs[side]; doc.pdf = Buffer.concat([doc.pdf, Buffer.alloc(8 * 1024 * 1024)]);
      doc.meta.file_hash = doc.meta.image_hash = hash(doc.pdf); doc.meta.file_bytes = doc.pdf.length;
      doc.meta.pdf_text_coverage = assessPdfTextCoverage(doc.parsed, doc.meta.file_hash); writeDoc(side);
    }
    rebuild(); await held("pair_order_or_bytes"); expect(mocked.calls).toHaveLength(0);
  });
});

describe("native-PDF response contract adds no source/publication authority", () => {
  it("adds pdf_review without mutating the old schema or dropping old required fields", () => {
    const base = { type: "object", properties: { changed_facts: { type: "array" } }, required: ["changed_facts"] }, before = clone(base);
    const result = nativePdfResponseSchema(base); expect(base).toEqual(before); expect(result.required).toEqual(["changed_facts", "pdf_review"]);
    expect(result.properties.pdf_review.required).toHaveLength(7);
  });
  it("does not expose the internal side list through a returned response schema", async () => {
    const schema = nativePdfResponseSchema({ properties: {}, required: [] });
    schema.properties.pdf_review.properties.uncertain_pages.items.properties.side.enum.push("caller-mutated");
    const out = await prepare(); expect(out.parts).toHaveLength(4);
    expect(nativePdfResponseSchema({ properties: {}, required: [] }).properties.pdf_review.properties.uncertain_pages.items.properties.side.enum).toEqual(["previous", "current"]);
  });
  it("accepts the actual normalizer's retained raw PDF contract and exact clean native facts", async () => {
    const { pair } = await prepare(), supplied = response(pair);
    const result = { ...normalizeVisualBatchResult(JSON.stringify(supplied.raw_result), { candidate, source }), finish_reason: "STOP", provider_candidate_count: 1 };
    expect(result.raw_result.pdf_review).toEqual(supplied.raw_result.pdf_review);
    expect(result.changed_facts).toEqual(supplied.raw_result.changed_facts);
    expect(decision(pair, result).allowed).toBe(true);
  });
  it("accepts full page acknowledgements and exact native directional citations, not visual truth", async () => {
    const { pair } = await prepare(); const result = response(pair);
    expect(decision(pair, result)).toEqual({ allowed: true, reason: "native_pdf_review_complete_page_acknowledgements_and_native_quotes", exhaustive_visual_accuracy_verified: false });
  });
  it("allows raw authoritative pdf_review without inventing a normalized alias", async () => {
    const { pair } = await prepare(); const result = response(pair); delete result.pdf_review;
    expect(decision(pair, result).allowed).toBe(true);
  });
  it.each([
    ["profile", r => r.raw_result.pdf_review.profile = "legacy"],
    ["PDF SHA", r => r.raw_result.pdf_review.current_sha256 = hash("other")],
    ["omitted page", r => r.raw_result.pdf_review.previous_pages.pop()],
    ["reordered page", r => r.raw_result.pdf_review.current_pages.reverse()],
    ["duplicate page", r => r.raw_result.pdf_review.current_pages = [1, 1]],
    ["uncertain page", r => r.raw_result.pdf_review.uncertain_pages.push({ side: "current", page: 2, reason: "unreadable" })],
    ["unknown claim", r => r.raw_result.pdf_review.approved = true],
    ["missing acknowledgement", r => delete r.raw_result.pdf_review],
  ])("holds %s in the raw page review", async (_, mutate) => { const { pair } = await prepare(); const result = response(pair); mutate(result); expect(decision(pair, result)).toMatchObject({ allowed: false, manual_review_required: true, reason: "native_pdf_review_page_coverage" }); });
  it.each([
    ["normalized PDF alias", r => r.pdf_review.current_sha256 = hash("alias")],
    ["normalized facts", r => r.changed_facts[0].after = "unsupported"],
    ["normalized flags", r => r.is_alert_worthy = false],
    ["conflicting fact alias", r => r.raw_result.changed_award_facts = []],
    ["missing citation", r => r.raw_result.pdf_review.page_evidence = []],
  ])("holds %s instead of repairing a response", async (_, mutate) => { const { pair } = await prepare(); const result = response(pair); mutate(result); expect(decision(pair, result).reason).toBe("native_pdf_review_result_consistency"); });
  it.each([
    ["wrong cited page", c => c.current_page = 2, "page_quote_mismatch"],
    ["zero page", c => c.previous_page = 0, "page_quote_mismatch"],
    ["fractional page", c => c.current_page = 1.5, "page_quote_mismatch"],
    ["out of range", c => c.current_page = 3, "page_quote_mismatch"],
    ["wrong fact index", c => c.fact_index = 1, "fact_index"],
    ["unknown citation field", c => c.reviewed = true, "fact_index"],
  ])("holds %s", async (_, mutate, reason) => {
    const { pair } = await prepare(); const result = response(pair); mutate(result.raw_result.pdf_review.page_evidence[0]); delete result.pdf_review;
    expect(decision(pair, result).reason).toBe(`native_pdf_review_${reason}`);
  });
  it.each(["added", "removed"])("accepts genuinely %s-only native wording with a null opposite page", async direction => {
    const { pair } = await prepare(); const result = response(pair), fact = result.raw_result.changed_facts[0];
    const side = direction === "added" ? "previous" : "current";
    for (const key of direction === "added" ? ["before", "removed_text"] : ["after", "added_text"]) fact[key] = null;
    result.raw_result.pdf_review.page_evidence[0][`${side}_page`] = null;
    result.changed_facts = clone(result.raw_result.changed_facts); delete result.pdf_review;
    expect(decision(pair, result).allowed).toBe(true);
    result.raw_result.pdf_review.page_evidence[0][`${side}_page`] = 1;
    expect(decision(pair, result).reason).toBe("native_pdf_review_absent_side_citation");
  });
  it("does not accept screenshot-only/uncited facts or swap the native side", async () => {
    const { pair } = await prepare(); const result = response(pair);
    result.raw_result.changed_facts[0].visual_evidence = "an illustrative chart changed"; result.changed_facts = clone(result.raw_result.changed_facts);
    expect(decision(pair, result).reason).toBe("native_pdf_review_visual_only_or_malformed_fact");
    result.raw_result.changed_facts[0].visual_evidence = null; result.raw_result.changed_facts[0].before = after; result.changed_facts = clone(result.raw_result.changed_facts);
    expect(decision(pair, result).reason).toBe("native_pdf_review_page_quote_mismatch");
  });
  it("requires STOP and exactly one provider candidate", async () => {
    const { pair } = await prepare(); const result = response(pair); result.finish_reason = "MAX_TOKENS";
    expect(decision(pair, result).reason).toBe("native_pdf_review_incomplete_response"); result.finish_reason = "STOP"; result.provider_candidate_count = 2;
    expect(decision(pair, result).allowed).toBe(false);
  });
  it("binds the pair to this actual stored ID, signature, source and both originals", async () => {
    const { pair } = await prepare(); const result = response(pair);
    for (const key of ["candidate_id", "candidate_signature", "source_id", "award_id", "source_url"]) {
      const changed = clone(pair); changed[key] = "other"; expect(decision(changed, result).reason).toBe("native_pdf_review_pair_binding");
    }
  });
  it("accepts a complete no-change response only with both flags false and no facts/citations", async () => {
    const { pair } = await prepare(); const result = response(pair); result.raw_result.is_true_change = result.raw_result.is_alert_worthy = false;
    result.raw_result.changed_facts = []; result.raw_result.pdf_review.page_evidence = [];
    result.is_true_change = result.is_alert_worthy = false; result.changed_facts = []; delete result.pdf_review;
    expect(decision(pair, result).allowed).toBe(true);
    result.raw_result.is_true_change = result.is_true_change = true; expect(decision(pair, result).allowed).toBe(false);
  });
});

function longNativeFixture() {
  const complete = Array.from({ length: 180 }, (_, i) => `Unchanged native context ${i} retains every audience qualifier, funding condition, exception and application instruction.`).join("\n\n");
  for (const side of ["previous", "current"]) {
    const doc = docs[side]; doc.parsed.pages[0].text = (side === "previous" ? before : after) + "\n\n" + complete;
    doc.parsed.text = doc.parsed.pages.map(page => page.text).join("\n\n"); doc.semantic = normalizeVisibleText(doc.parsed.text);
    doc.meta.text_hash = hash(doc.semantic); doc.meta.text_length = doc.semantic.length;
    doc.meta.pdf_text_coverage = assessPdfTextCoverage(doc.parsed, doc.meta.file_hash); writeDoc(side);
  }
  const diff = { added_text: [after], removed_text: [before], date_changes: ["Added March 2, 2027", "Removed March 1, 2027"], amount_changes: [] };
  diff.legacy_review_completeness = buildLegacyReviewCompleteness({ source, previousText: `${docs.previous.semantic}\n`,
    currentText: docs.current.semantic, diff, excludedChangedUnits: 0 });
  rebuild(diff); candidate.deterministic_diff = diff;
  resetParsed(); return diff;
}
function resetParsed() { mocked.results = [clone(docs.previous.parsed), clone(docs.current.parsed)]; }
function producerOptions(diff) {
  return { source, baseline: docs.previous.meta, previousSnapshotRef: candidate.previous_snapshot_ref, newSnapshotRef: candidate.new_snapshot_ref,
    previousText: `${docs.previous.semantic}\n`, currentText: docs.current.semantic, diff, archiveRoot: directory };
}
async function completeLongPair() {
  const diff = longNativeFixture(); diff.native_pdf_completeness = await prepareNativePdfReviewCompleteness(producerOptions(diff));
  rebuild(diff); candidate.deterministic_diff = diff; resetParsed();
  return { diff, ...(await prepare()) };
}
function wholeResponse(pair) {
  const result = response(pair);
  result.raw_result.pdf_review.unit_reviews = Object.entries(pair.directional_evidence).flatMap(([field, values]) => values.map((_, index) =>
    ({ field, index, disposition: "applicant_change", fact_indices: [0] })));
  result.pdf_review = clone(result.raw_result.pdf_review);
  result.structured_diff = clone(pair.directional_evidence);
  return result;
}

describe("NEW whole-original native PDF admission (long synthetic originals; mocked parser)", () => {
  it("replaces only the old excerpt bottleneck with both complete binaries and a compact bound proof", async () => {
    const diff = longNativeFixture();
    expect(docs.previous.semantic.length).toBeGreaterThan(16_000);
    expect(legacyReviewCompletenessDecision({ candidate, source }).allowed).toBe(false);
    const proof = await prepareNativePdfReviewCompleteness(producerOptions(diff));
    expect(proof).toMatchObject({ representation: "complete_original_pdfs", source: { id: source.id, stored_owner_id: source.shared_award_id, url: source.url },
      excluded_changed_units: 0, directional_counts: { added_text: 1, removed_text: 1, date_changes: 2, amount_changes: 0 } });
    expect(proof.digest).toBe(nativePdfWholeOriginalCompletenessDigest(proof));
    expect(proof.previous.pages).toHaveLength(2); expect(proof.current.pages).toHaveLength(2);
    expect(proof.previous.text_writer_frame).toBe("one_lf"); expect(proof.current.text_writer_frame).toBe("none");
    expect(proof.previous.meta_artifact_sha256).toBe(hash(readFileSync(docs.previous.meta_path)));
    expect(Object.isFrozen(proof.current.pages)).toBe(true); expect(proof).not.toHaveProperty("candidate_id");
    diff.native_pdf_completeness = proof; rebuild(diff); candidate.deterministic_diff = diff;
    expect(legacyReviewCompletenessDecision({ candidate, source })).toMatchObject({ applicable: false, allowed: false, requires_existing_contract: true });
    expect(candidate.prompt_payload.text_context_representation).toBe("complete_original_pdfs");
    expect(candidate.prompt_payload.previous_text_excerpt).toBe(""); expect(candidate.prompt_payload.new_text_excerpt).toBe("");
    resetParsed(); const out = await prepare();
    expect(out.pair.completeness_digest).toBe(proof.digest); expect(out.pair.directional_evidence).toEqual(Object.fromEntries(["added_text", "removed_text", "date_changes", "amount_changes"].map(key => [key, diff[key]])));
    expect(out.instructions).toContain("EVERY added_text");
    for (const [i, side] of ["previous", "current"].entries()) expect(Buffer.from(out.parts[i * 2 + 1].inlineData.data, "base64")).toEqual(docs[side].pdf);
    expect(visualReviewResponseSchemaForCandidate(candidate).properties.pdf_review.required).toContain("unit_reviews");
  });
  it.each([
    ["extended-year forward", "2026-01-01T00:00:00.000Z", "+010000-01-01T00:00:00.000Z", true],
    ["extended-year reverse", "+010000-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z", false],
    ["offset-reversed instants", "2026-01-01T00:00:00+01:00", "2026-01-01T00:30:00+02:00", false],
    ["offset-equal instants", "2026-01-01T00:00:00.000Z", "2026-01-01T01:00:00+01:00", false],
  ])("orders structural %s proof dates without granting raw verification", async (_, previousAt, currentAt, allowed) => {
    const { diff } = await completeLongPair(), proof = clone(diff.native_pdf_completeness);
    const args = { source, baseline: docs.previous.meta, capture: docs.current.meta, diff: { ...diff, native_pdf_completeness: proof } };
    expect(nativePdfWholeOriginalCompletenessDecision(args)).toMatchObject({ allowed: true, requires_original_pdf_verification: true });
    // Structural-only date claims: no raw metadata/claim authority is inferred.
    proof.previous.captured_at = previousAt; proof.current.captured_at = currentAt;
    proof.digest = nativePdfWholeOriginalCompletenessDigest(proof);
    const decision = nativePdfWholeOriginalCompletenessDecision(args);
    if (allowed) expect(decision).toMatchObject({ allowed: true, requires_original_pdf_verification: true });
    else expect(decision).toMatchObject({ allowed: false, reason: "native_pdf_whole_original_pair_bounds", baseline_advance_allowed: false });
  });
  it("independently verifies the supplied proof again before enqueue without creating a missing one", async () => {
    const { diff } = await completeLongPair(); resetParsed();
    await expect(verifyNativePdfReviewCompleteness(producerOptions(diff))).resolves.toEqual(diff.native_pdf_completeness);
    delete diff.native_pdf_completeness;
    await expect(verifyNativePdfReviewCompleteness(producerOptions(diff))).rejects.toMatchObject({ code: "native_pdf_review_whole_original_proof_missing" });
  });
  it("does not create a whole-original proof for old short or paragraph-v2 contracts", async () => {
    const diff = { added_text: [after], removed_text: [before], date_changes: [], amount_changes: [] };
    diff.legacy_review_completeness = buildLegacyReviewCompleteness({ source, previousText: `${docs.previous.semantic}\n`, currentText: docs.current.semantic, diff, excludedChangedUnits: 0 });
    await expect(prepareNativePdfReviewCompleteness(producerOptions(diff))).rejects.toMatchObject({ code: "native_pdf_review_whole_original_not_eligible" });
    diff.legacy_review_completeness.schema = "awardping.legacy-paired-paragraph-completeness.v2";
    await expect(prepareNativePdfReviewCompleteness(producerOptions(diff))).rejects.toMatchObject({ nativePdfReviewHold: true });
    expect(mocked.calls).toHaveLength(0);
  });
  it.each([
    ["excluded unit", diff => diff.legacy_review_completeness.excluded_changed_units = 1],
    ["ninth unit", diff => diff.added_text = Array(9).fill(after)],
    ["changed directional tail", diff => diff.date_changes[1] += " changed"],
  ])("holds %s before independent parsing", async (_, mutate) => {
    const diff = longNativeFixture(); mutate(diff);
    await expect(prepareNativePdfReviewCompleteness(producerOptions(diff))).rejects.toMatchObject({ code: "native_pdf_review_whole_original_not_eligible" });
    expect(mocked.calls).toHaveLength(0);
  });
  it.each([
    ["owner", opts => opts.source = { ...opts.source, shared_award_id: source.id }],
    ["URL", opts => opts.source = { ...opts.source, url: source.url + "?wrong" }],
    ["old baseline time", opts => opts.baseline = { ...opts.baseline, captured_at: docs.current.meta.captured_at }],
    ["full old context", opts => opts.previousText = opts.previousText.slice(1)],
  ])("holds unbound producer %s before parsing", async (_, mutate) => {
    const diff = longNativeFixture(), opts = producerOptions(diff); mutate(opts);
    await expect(prepareNativePdfReviewCompleteness(opts)).rejects.toMatchObject({ code: "native_pdf_review_whole_original_source_or_context" });
    expect(mocked.calls).toHaveLength(0);
  });
  it("binds the full proof digest to evidence identity rather than the compact sentence key", async () => {
    await completeLongPair(); const first = visualReviewEvidenceSignatureFromStoredCandidate(candidate);
    candidate.deterministic_diff = clone(candidate.deterministic_diff); candidate.deterministic_diff.native_pdf_completeness.digest = hash("different full proof");
    expect(visualReviewEvidenceSignatureFromStoredCandidate(candidate)).not.toBe(first);
  });
  it("policy rebuild never retrostamps old held payloads with whole-original completeness", () => {
    longNativeFixture(); const old = clone(candidate.prompt_payload);
    const freshSource = { ...source, title: "Fresh synthetic source context" };
    const rebuilt = { ...candidate, ...rebuildVisualReviewCandidateForCurrentPolicy(candidate, { source: freshSource }) };
    expect(candidate.prompt_payload).toEqual(old); expect(rebuilt.prompt_payload.deterministic_diff).not.toHaveProperty("native_pdf_completeness");
    expect(rebuilt.prompt_payload.source.title).toBe(freshSource.title);
    expect(legacyReviewCompletenessDecision({ candidate: rebuilt, source: freshSource }).reason).toBe("legacy_review_complete_context_exceeds_bound");
  });
  it.each([
    ["unknown proof field", proof => proof.authorized = true],
    ["page list", proof => proof.current.pages.pop()],
    ["page native hash", proof => proof.current.pages[0].native_text_sha256 = hash("other")],
    ["root", proof => proof.archive_root = docs.current.dir],
    ["raw metadata", proof => proof.previous.meta_artifact_sha256 = hash("other")],
    ["exact directional hash", proof => proof.directional_sha256 = hash("other")],
  ])("rejects %s, including a newly recomputed untrusted digest", async (_, mutate) => {
    const { diff } = await completeLongPair(); const proof = clone(diff.native_pdf_completeness); mutate(proof); proof.digest = nativePdfWholeOriginalCompletenessDigest(proof);
    candidate.deterministic_diff = clone(candidate.deterministic_diff); candidate.prompt_payload = clone(candidate.prompt_payload);
    candidate.deterministic_diff.native_pdf_completeness = proof; candidate.prompt_payload.deterministic_diff.native_pdf_completeness = clone(proof); resetParsed();
    await expect(prepare()).rejects.toMatchObject({ nativePdfReviewHold: true });
  });
  it("requires raw identity to remain intact across producer parsing", async () => {
    const diff = longNativeFixture(); mocked.hook = () => writeFileSync(docs.current.meta_path, Buffer.alloc(readFileSync(docs.current.meta_path).length, 32));
    await expect(prepareNativePdfReviewCompleteness(producerOptions(diff))).rejects.toMatchObject({ code: "native_pdf_review_artifact_bytes_changed" });
  });
  it("does not waive an actual sparse native page in a long document", async () => {
    const diff = longNativeFixture();
    for (const side of ["previous", "current"]) {
      const doc = docs[side]; doc.parsed.pages[1].text = "Flowchart title and page number only";
      doc.parsed.text = doc.parsed.pages.map(page => page.text).join("\n\n"); doc.semantic = normalizeVisibleText(doc.parsed.text);
      doc.meta.text_hash = hash(doc.semantic); doc.meta.text_length = doc.semantic.length;
      doc.meta.pdf_text_coverage = assessPdfTextCoverage(doc.parsed, doc.meta.file_hash); writeDoc(side);
      expect(doc.meta.pdf_text_coverage.status).toBe("sparse_pages");
      expect(doc.meta.pdf_text_coverage).toEqual(assessPdfTextCoverage(doc.parsed, doc.meta.file_hash));
    }
    diff.legacy_review_completeness = buildLegacyReviewCompleteness({ source, previousText: `${docs.previous.semantic}\n`,
      currentText: docs.current.semantic, diff, excludedChangedUnits: 0 });
    rebuild(diff); candidate.deterministic_diff = diff; resetParsed();
    await expect(prepareNativePdfReviewCompleteness(producerOptions(diff))).rejects.toMatchObject({ code: "native_pdf_review_native_text_binding" });
  });
  it("keeps malformed or alias-divergent complete proof a hold, not a legacy fallback", async () => {
    await completeLongPair(); candidate.prompt_payload = clone(candidate.prompt_payload);
    candidate.prompt_payload.deterministic_diff.native_pdf_completeness.directional_counts.added_text++;
    expect(nativePdfWholeOriginalCompletenessDecision({ candidate, source }).allowed).toBe(false);
    expect(legacyReviewCompletenessDecision({ candidate, source }).allowed).toBe(false);
  });
  it("accepts exactly all directional dispositions and native-page citations without asserting visual completeness", async () => {
    const { pair } = await completeLongPair(); const result = wholeResponse(pair);
    expect(decision(pair, result)).toMatchObject({ allowed: true, reason: "native_pdf_review_complete_originals_and_all_directional_units", exhaustive_visual_accuracy_verified: false });
    const normalized = { ...normalizeVisualBatchResult(JSON.stringify(result.raw_result), { candidate, source }), finish_reason: "STOP", provider_candidate_count: 1 };
    expect(decision(pair, normalized).allowed).toBe(true);
    result.raw_result.structured_diff = null;
    const explicitNull = { ...normalizeVisualBatchResult(JSON.stringify(result.raw_result), { candidate, source }), finish_reason: "STOP", provider_candidate_count: 1 };
    expect(decision(pair, explicitNull).allowed).toBe(true);
  });
  it.each([
    ["missing", rows => rows.pop()], ["extra", rows => rows.push(clone(rows[0]))],
    ["duplicate", rows => rows[1] = clone(rows[0])], ["uncertain", rows => rows[0].disposition = "uncertain"],
    ["unknown field", rows => rows[0].authorized = true], ["wrong field", rows => rows[0].field = "model_context"],
    ["wrong index", rows => rows[0].index = 100], ["duplicate fact index", rows => rows[0].fact_indices = [0, 0]],
    ["missing applicant fact", rows => rows[0].fact_indices = []], ["noise with fact", rows => rows[0].disposition = "noise"],
  ])("holds %s unit dispositions for the entire pair", async (_, mutate) => {
    const { pair } = await completeLongPair(), result = wholeResponse(pair); mutate(result.raw_result.pdf_review.unit_reviews); delete result.pdf_review;
    expect(decision(pair, result)).toMatchObject({ allowed: false, reason: "native_pdf_review_unit_coverage", baseline_advance_allowed: false });
  });
  it("does not silently repair a response's omitted directional arrays", async () => {
    const { pair } = await completeLongPair(), result = wholeResponse(pair); result.raw_result.structured_diff = { added_text: [] };
    expect(decision(pair, result).reason).toBe("native_pdf_review_unit_coverage");
  });
  it("holds unsupported unit-to-fact pairing and a fact with an unreviewed native side", async () => {
    const { pair } = await completeLongPair(), result = wholeResponse(pair);
    for (const row of result.raw_result.pdf_review.unit_reviews) if (row.field === "removed_text" || row.field === "date_changes" && row.index === 1) {
      row.disposition = "noise"; row.fact_indices = [];
    }
    delete result.pdf_review; expect(decision(pair, result).reason).toBe("native_pdf_review_unit_fact_binding");
  });
  it("keeps false/no-facts input dispositions separate from baseline/publication authority", async () => {
    const { pair } = await completeLongPair(), result = wholeResponse(pair);
    result.is_true_change = result.is_alert_worthy = result.raw_result.is_true_change = result.raw_result.is_alert_worthy = false;
    result.changed_facts = result.raw_result.changed_facts = []; result.raw_result.pdf_review.page_evidence = [];
    for (const row of result.raw_result.pdf_review.unit_reviews) { row.disposition = "wording_only"; row.fact_indices = []; }
    delete result.pdf_review;
    expect(decision(pair, result)).toEqual({ allowed: true, reason: "native_pdf_review_complete_originals_and_all_directional_units", exhaustive_visual_accuracy_verified: false });
    expect(decision(pair, result)).not.toHaveProperty("baseline_advance_allowed", true);
  });
});
