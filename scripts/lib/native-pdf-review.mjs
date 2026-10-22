import { createHash } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, parse, relative, resolve } from "node:path";
import { isDeepStrictEqual as equal } from "node:util";
import { TextDecoder } from "node:util";
import { normalizeVisibleText } from "./capture-stability.mjs";
import { assessPdfTextCoverage } from "./pdf-text-coverage.mjs";
import { nativePdfWholeOriginalCompletenessSchema, nativePdfWholeOriginalCompletenessDigest,
  nativePdfWholeOriginalCompletenessDecision, legacyReviewCompletenessDecision } from "./legacy-review-completeness.mjs";

export const NATIVE_PDF_REVIEW_PROFILE = "awardping.native-pdf-pair-review.v1";
const limits = Object.freeze({ pages: 25, pdfBytes: 16 * 1024 * 1024, nativeBytes: 2 * 1024 * 1024,
  metaBytes: 256 * 1024, parseMs: 30000, destroyMs: 5000 });
const hash = value => createHash("sha256").update(value).digest("hex");
const sha = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value) && !/^0{8}(?:-0{4}){3}-0{12}$/.test(value);
const object = value => value && typeof value === "object" && !Array.isArray(value);
const keys = (value, expected) => object(value) && equal(Object.keys(value).sort(), [...expected].sort());
const iso = value => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const fail = reason => { const error = new Error(`Native PDF review held: ${reason}.`); error.code = `native_pdf_review_${reason}`; error.nativePdfReviewHold = true; throw error; };
const requireThat = (condition, reason) => { if (!condition) fail(reason); };
const freeze = value => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const sortJson = value => Array.isArray(value) ? value.map(sortJson) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sortJson(value[key])])) : value;
const stable = value => JSON.stringify(sortJson(value));
const sides = ["previous", "current"];
const directionalFields = ["added_text", "removed_text", "date_changes", "amount_changes"];
const refKey = side => side === "previous" ? "previous_snapshot_ref" : "new_snapshot_ref";
const field = (side, suffix) => `${side === "previous" ? "previous" : "new"}_${suffix}`;

/** Detection only; the marker, live claim and ordinary eligibility are separate. */
export function nativePdfCandidate(candidate) {
  return candidate?.candidate_scope !== "initial_official_document" &&
    candidate?.previous_snapshot_ref?.kind === "pdf" && candidate?.new_snapshot_ref?.kind === "pdf";
}

function candidateIdentity(candidate, source, requireSubmissionClaim) {
  requireThat(nativePdfCandidate(candidate) && candidate.candidate_scope === "content_change", "candidate_scope");
  requireThat(candidate.worker_metadata?.native_pdf_review_profile === NATIVE_PDF_REVIEW_PROFILE, "profile_missing");
  requireThat(uuid(candidate.id) && uuid(candidate.shared_award_source_id) && uuid(candidate.shared_award_id) && sha(candidate.candidate_signature), "candidate_identity");
  requireThat(source?.id === candidate.shared_award_source_id && source.shared_award_id === candidate.shared_award_id && source.url === candidate.source_url, "source_identity");
  requireThat(candidate.prompt_payload?.source?.id === source.id && candidate.prompt_payload.source.shared_award_id === source.shared_award_id &&
    candidate.prompt_payload.source.url === source.url, "prompt_source_identity");
  requireThat((candidate.worker_metadata?.review_model || candidate.model) === "gemini-3.8-flash", "model");
  if (requireSubmissionClaim) requireThat(candidate.status === "processing" && uuid(candidate.worker_metadata?.submission_claim_token), "submission_claim");
}

function regularPath(value, archiveRoot, directory = false) {
  requireThat(typeof value === "string" && isAbsolute(value) && value === value.trim(), "artifact_path");
  const root = resolve(archiveRoot), path = resolve(value), inside = relative(root, path);
  requireThat(!inside.startsWith("..") && !isAbsolute(inside) && (directory || inside !== ""), "artifact_outside_archive");
  let cursor = path;
  while (true) {
    const stat = lstatSync(cursor);
    requireThat(!stat.isSymbolicLink() && (cursor === path && !directory ? stat.isFile() : stat.isDirectory()), "artifact_not_regular");
    if (cursor === parse(cursor).root) break;
    cursor = dirname(cursor);
  }
  requireThat(realpathSync(path).toLowerCase() === path.toLowerCase(), "artifact_alias");
  return path;
}

function readArtifact(descriptor, archiveRoot, cap, identities) {
  requireThat(object(descriptor) && descriptor.exists === true && sha(descriptor.sha256) &&
    Number.isSafeInteger(descriptor.byte_length) && descriptor.byte_length > 0 && descriptor.byte_length <= cap &&
    (descriptor.bytes === undefined || descriptor.bytes === descriptor.byte_length), "artifact_binding");
  const path = regularPath(descriptor.path, archiveRoot), fd = openSync(path, "r");
  try {
    const before = fstatSync(fd, { bigint: true }), inode = `${before.dev}:${before.ino}`, key = path.toLowerCase();
    requireThat(before.isFile() && before.nlink === 1n && before.size === BigInt(descriptor.byte_length) && !identities.has(key) &&
      (!before.ino || !identities.has(inode)), "artifact_alias_or_size");
    identities.add(key); if (before.ino) identities.add(inode);
    const bytes = Buffer.alloc(descriptor.byte_length + 1); let length = 0, read;
    while (length < bytes.length && (read = readSync(fd, bytes, length, bytes.length - length, null))) length += read;
    const after = fstatSync(fd, { bigint: true }), body = bytes.subarray(0, length);
    requireThat(length === descriptor.byte_length && after.size === before.size && after.mtimeNs === before.mtimeNs &&
      after.dev === before.dev && after.ino === before.ino &&
      hash(body) === descriptor.sha256, "artifact_bytes_changed");
    return { body, descriptor, path };
  } finally { closeSync(fd); }
}

function utf8(bytes) {
  try { const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    requireThat(Buffer.from(text).equals(bytes), "artifact_utf8"); return text;
  } catch { fail("artifact_utf8"); }
}

function readSide(candidate, side, archiveRoot, identities) {
  const ref = candidate[refKey(side)];
  requireThat(equal(ref, candidate.prompt_payload?.[refKey(side)]), "prompt_reference_mismatch");
  requireThat(object(ref.local_paths) && Array.isArray(ref.visual_states) && ref.visual_states.length === 0 &&
    Object.entries(ref.local_paths).every(([role, value]) => ["pdf", "meta", "text"].includes(role) || value == null), "pdf_artifact_roles");
  const artifacts = ["pdf", "text", "meta"].map(role => ({ role, sha256: ref.local_paths[role]?.sha256, byte_length: ref.local_paths[role]?.byte_length }))
    .sort((a, b) => a.role.localeCompare(b.role) || String(a.sha256).localeCompare(String(b.sha256)) || a.byte_length - b.byte_length);
  const digest = hash(stable({ version: 1, artifacts }));
  requireThat(equal(ref.artifact_manifest, { version: 1, artifacts, complete: true, digest, missing_roles: [] }) &&
    ref.artifact_manifest_digest === digest, "artifact_manifest");
  const pdf = readArtifact(ref.local_paths.pdf, archiveRoot, limits.pdfBytes, identities);
  const text = readArtifact(ref.local_paths.text, archiveRoot, limits.nativeBytes + 1, identities);
  const metadata = readArtifact(ref.local_paths.meta, archiveRoot, limits.metaBytes, identities);
  requireThat(pdf.body.subarray(0, 5).equals(Buffer.from("%PDF-")), "pdf_signature");
  let meta; try { meta = JSON.parse(utf8(metadata.body)); } catch { fail("metadata_json"); }
  const retainedText = utf8(text.body);
  requireThat(retainedText.endsWith("\n"), "text_writer_frame");
  const native = retainedText.slice(0, -1);
  requireThat(meta?.kind === "pdf" && meta.source?.id === candidate.shared_award_source_id && meta.source.shared_award_id === candidate.shared_award_id &&
    meta.source.url === candidate.source_url && meta.status_code === 200 && /^application\/pdf(?:;|$)/i.test(meta.content_type || "") &&
    iso(meta.captured_at) && meta.captured_at === ref.captured_at && typeof meta.final_url === "string" && meta.final_url === ref.final_url &&
    meta.file_hash === pdf.descriptor.sha256 && meta.file_bytes === pdf.body.length && meta.file_hash === ref.file_hash &&
    meta.file_hash === candidate[field(side, "file_hash")] && meta.image_hash === meta.file_hash && ref.image_hash === meta.file_hash &&
    candidate[field(side, "image_hash")] === meta.file_hash && sha(meta.text_hash) && hash(native) === meta.text_hash &&
    ref.text_hash === meta.text_hash && candidate[field(side, "text_hash")] === meta.text_hash &&
    meta.text_length === native.length && meta.pdf_text_error == null &&
    Number.isSafeInteger(meta.page_count) && meta.page_count >= 1 && meta.page_count <= limits.pages, "sealed_metadata");
  for (const key of ["status_code", "content_type", "page_count"]) requireThat(ref.metadata?.[key] == null || ref.metadata[key] === meta[key], "reference_metadata");
  requireThat(candidate.prompt_payload?.hashes?.[field(side, "file_hash")] === meta.file_hash &&
    candidate.prompt_payload.hashes[field(side, "text_hash")] === meta.text_hash &&
    candidate.prompt_payload.hashes[field(side, "image_hash")] === meta.file_hash &&
    candidate.prompt_payload.hashes[field(side, "artifact_manifest_digest")] === digest, "prompt_hashes");
  return { pdf, text, metadata, meta, native, digest };
}

async function bounded(promise, ms, reason) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => { try { fail(reason); } catch (error) { reject(error); } }, ms); })]); }
  finally { clearTimeout(timer); }
}

async function parseNative(doc) {
  let parser;
  try {
    const { PDFParse } = await import("pdf-parse");
    parser = new PDFParse({ data: new Uint8Array(doc.pdf.body), verbosity: 0, isEvalSupported: false, useWorkerFetch: false,
      useSystemFonts: false, disableFontFace: true, useWasm: false });
    const result = await bounded(Promise.resolve().then(() => parser.getText({ first: limits.pages })), limits.parseMs, "parser_timeout");
    requireThat(result?.total === doc.meta.page_count && typeof result.text === "string" &&
      Array.isArray(result.pages) && result.pages.length === result.total &&
      result.pages.every((page, i) => page?.num === i + 1 && typeof page.text === "string") &&
      Buffer.byteLength(result.text) <= limits.nativeBytes && result.pages.reduce((n, page) => n + Buffer.byteLength(page.text), 0) <= limits.nativeBytes,
    "native_page_list");
    requireThat(hash(normalizeVisibleText(result.text)) === doc.meta.text_hash &&
      equal(assessPdfTextCoverage(result, doc.meta.file_hash), doc.meta.pdf_text_coverage) &&
      doc.meta.pdf_text_coverage.status === "native_text_present", "native_text_binding");
    return { text: result.text, pages: result.pages.map(page => ({ page: page.num, text: page.text })) };
  } catch (error) { if (error?.nativePdfReviewHold) throw error; fail("parser_failed"); }
  finally { if (parser) try { await bounded(Promise.resolve().then(() => parser.destroy()), limits.destroyMs, "parser_cleanup_timeout"); }
    catch { fail("parser_cleanup_failed"); } }
}

// One shared reader/parser for fresh admission and the claimed/publication
// consumers. Neither a schema tag nor caller-supplied page counts replace it.
async function readNativePair(binding, archiveRoot) {
  requireThat(typeof archiveRoot === "string" && isAbsolute(archiveRoot), "archive_root"); regularPath(resolve(archiveRoot), archiveRoot, true);
  const identities = new Set(), docs = Object.fromEntries(sides.map(side => [side, readSide(binding, side, archiveRoot, identities)]));
  requireThat(Date.parse(docs.previous.meta.captured_at) < Date.parse(docs.current.meta.captured_at) && docs.previous.meta.file_hash !== docs.current.meta.file_hash &&
    docs.previous.meta.text_hash !== docs.current.meta.text_hash &&
    docs.previous.pdf.body.length + docs.current.pdf.body.length <= limits.pdfBytes, "pair_order_or_bytes");
  const parsed = {};
  for (const side of sides) parsed[side] = await parseNative(docs[side]);
  requireThat(sides.reduce((n, side) => n + Buffer.byteLength(parsed[side].text), 0) <= limits.nativeBytes &&
    sides.reduce((n, side) => n + parsed[side].pages.reduce((m, page) => m + Buffer.byteLength(page.text), 0), 0) <= limits.nativeBytes, "pair_native_bytes");
  const finalIdentities = new Set();
  for (const side of sides) for (const role of ["pdf", "text", "metadata"]) readArtifact(docs[side][role].descriptor, archiveRoot,
    role === "pdf" ? limits.pdfBytes : role === "text" ? limits.nativeBytes + 1 : limits.metaBytes, finalIdentities);
  return { docs, parsed };
}

function wholeOriginalProof({ source, binding, diff, docs, parsed, archiveRoot }) {
  const proof = { schema: nativePdfWholeOriginalCompletenessSchema, representation: "complete_original_pdfs", archive_root: resolve(archiveRoot),
    source: { id: source.id, stored_owner_id: source.shared_award_id, url: source.url, page_type: source.page_type },
    ...Object.fromEntries(sides.map(side => {
      const doc = docs[side], legacy = diff?.legacy_review_completeness;
      requireThat(doc.meta.source?.page_type === source.page_type, "whole_original_source_type");
      const contextHash = legacy?.[`${side}_text_sha256`];
      requireThat(contextHash === doc.text.descriptor.sha256 || contextHash === doc.meta.text_hash, "whole_original_text_context");
      return [side, { snapshot_ref_sha256: hash(stable(binding[refKey(side)])), artifact_manifest_digest: doc.digest,
        pdf_sha256: doc.meta.file_hash, pdf_byte_length: doc.pdf.body.length,
        text_artifact_sha256: doc.text.descriptor.sha256, text_artifact_byte_length: doc.text.body.length,
        meta_artifact_sha256: doc.metadata.descriptor.sha256, meta_artifact_byte_length: doc.metadata.body.length,
        captured_at: doc.meta.captured_at, final_url: doc.meta.final_url, semantic_text_sha256: doc.meta.text_hash, text_length: doc.native.length,
        text_writer_frame: contextHash === doc.text.descriptor.sha256 ? "one_lf" : "none",
        native_text_sha256: hash(parsed[side].text), native_text_byte_length: Buffer.byteLength(parsed[side].text), page_count: doc.meta.page_count,
        pages: parsed[side].pages.map(page => ({ page: page.page, native_text_sha256: hash(page.text), native_text_byte_length: Buffer.byteLength(page.text) })) }];
    })), directional_counts: diff?.legacy_review_completeness?.directional_counts,
    directional_sha256: diff?.legacy_review_completeness?.directional_sha256,
    excluded_changed_units: diff?.legacy_review_completeness?.excluded_changed_units,
    legacy_proof_sha256: hash(stable(diff?.legacy_review_completeness)) };
  proof.digest = nativePdfWholeOriginalCompletenessDigest(proof);
  const decision = nativePdfWholeOriginalCompletenessDecision({ source, diff: { ...diff, native_pdf_completeness: proof },
    baseline: { text_hash: docs.previous.meta.text_hash, file_hash: docs.previous.meta.file_hash },
    capture: { text_hash: docs.current.meta.text_hash, file_hash: docs.current.meta.file_hash },
    previousSnapshotRef: binding.previous_snapshot_ref, newSnapshotRef: binding.new_snapshot_ref });
  requireThat(decision.allowed, "whole_original_accounting");
  return proof;
}

/** NEW capture producer only: no guessed candidate ID, claim or paid authority. */
export async function prepareNativePdfReviewCompleteness({ source, baseline, previousSnapshotRef, newSnapshotRef,
  previousText, currentText, diff, archiveRoot } = {}) {
  try {
    const encoded = JSON.stringify({ source, baseline, previousSnapshotRef, newSnapshotRef, previousText, currentText, diff });
    requireThat(typeof encoded === "string" && Buffer.byteLength(encoded) <= 4 * 1024 * 1024, "whole_original_input_size");
    ({ source, baseline, previousSnapshotRef, newSnapshotRef, previousText, currentText, diff } = JSON.parse(encoded));
    requireThat(uuid(source?.id) && uuid(source.shared_award_id) && typeof source.url === "string" && source.url &&
      typeof source.page_type === "string" && source.page_type && baseline?.kind === "pdf" && previousSnapshotRef?.kind === "pdf" && newSnapshotRef?.kind === "pdf" &&
      baseline.source?.id === source.id && baseline.source.shared_award_id === source.shared_award_id && baseline.source.url === source.url &&
      baseline.captured_at === previousSnapshotRef.captured_at && baseline.file_hash === previousSnapshotRef.file_hash && baseline.text_hash === previousSnapshotRef.text_hash &&
      typeof previousText === "string" && typeof currentText === "string" &&
      hash(previousText) === diff?.legacy_review_completeness?.previous_text_sha256 && hash(currentText) === diff?.legacy_review_completeness?.current_text_sha256,
    "whole_original_source_or_context");
    const legacyDiff = { ...diff }; delete legacyDiff.native_pdf_completeness;
    const original = legacyReviewCompletenessDecision({ source, baseline, previous: { text: previousText },
      capture: { text: currentText, text_hash: newSnapshotRef.text_hash }, diff: legacyDiff });
    requireThat(original.reason === "legacy_review_complete_context_exceeds_bound", "whole_original_not_eligible");
    const refs = { previous_snapshot_ref: previousSnapshotRef, new_snapshot_ref: newSnapshotRef };
    const hashes = Object.fromEntries(sides.flatMap(side => ["file_hash", "image_hash", "text_hash", "artifact_manifest_digest"].map(suffix =>
      [field(side, suffix), refs[refKey(side)][suffix]])));
    const binding = { shared_award_source_id: source.id, shared_award_id: source.shared_award_id, source_url: source.url, ...refs, ...hashes,
      prompt_payload: { ...refs, hashes } };
    const { docs, parsed } = await readNativePair(binding, archiveRoot);
    requireThat(previousText === docs.previous.native || previousText === utf8(docs.previous.text.body), "whole_original_text_context");
    requireThat(currentText === docs.current.native, "whole_original_text_context");
    return freeze(wholeOriginalProof({ source, binding, diff, docs, parsed, archiveRoot }));
  } catch (error) { if (error?.nativePdfReviewHold) throw error; fail("whole_original_input_invalid"); }
}

/** Recheck a supplied NEW proof; never manufacture one for an old packet. */
export async function verifyNativePdfReviewCompleteness(options = {}) {
  const supplied = options.diff?.native_pdf_completeness;
  requireThat(object(supplied), "whole_original_proof_missing");
  const rebuilt = await prepareNativePdfReviewCompleteness(options);
  requireThat(equal(supplied, rebuilt), "whole_original_proof_mismatch");
  return rebuilt;
}

/** Read-only preparation; does not claim eligibility, current approval or ownership. */
export async function prepareNativePdfReview({ candidate, source, archiveRoot, requireSubmissionClaim = true } = {}) {
  try {
    const encoded = JSON.stringify(candidate); requireThat(typeof encoded === "string" && Buffer.byteLength(encoded) <= 4 * 1024 * 1024, "candidate_size");
    candidate = JSON.parse(encoded); source = { id: source?.id, shared_award_id: source?.shared_award_id, url: source?.url, page_type: source?.page_type };
    candidateIdentity(candidate, source, requireSubmissionClaim);
    const { docs, parsed } = await readNativePair(candidate, archiveRoot);
    const diff = candidate.deterministic_diff || candidate.prompt_payload?.deterministic_diff || {};
    let completeness = null;
    if (Object.hasOwn(diff, "native_pdf_completeness")) {
      const decision = nativePdfWholeOriginalCompletenessDecision({ candidate, source, diff });
      requireThat(decision.allowed && diff.native_pdf_completeness.archive_root === resolve(archiveRoot), "whole_original_proof_mismatch");
      completeness = wholeOriginalProof({ source, binding: candidate, diff, docs, parsed, archiveRoot });
      requireThat(equal(diff.native_pdf_completeness, completeness), "whole_original_proof_mismatch");
    }
    const pair = { profile: NATIVE_PDF_REVIEW_PROFILE, candidate_id: candidate.id, candidate_signature: candidate.candidate_signature,
      source_id: source.id, award_id: source.shared_award_id, source_url: source.url,
      ...Object.fromEntries(sides.map(side => [side, { sha256: docs[side].meta.file_hash, page_count: docs[side].meta.page_count, pages: parsed[side].pages }])),
      ...(completeness ? { completeness_digest: completeness.digest, directional_evidence: Object.fromEntries(directionalFields.map(name => [name, diff[name]])) } : {}) };
    const instructions = "Both attachments are complete original PDFs, previous then current. Review ALL pages on BOTH sides. Return pdf_review with profile, both exact PDF SHA256s, ordered previous_pages/current_pages, uncertain_pages, and one page_evidence entry per changed_facts index. Cite the native-text page containing each before/removed_text and after/added_text; use a null page only for a genuinely absent side. visual_evidence must be null. Any unreadable/uncertain page requires uncertain_pages and no approval. These PDF inputs only corroborate existing native-text changes; they do not authorize new facts, image-only changes, OCR, baseline advancement, or publication.";
    const wholeInstructions = completeness ? " Whole-original admission: return unit_reviews with exactly one {field,index,disposition,fact_indices} for EVERY added_text, removed_text, date_changes and amount_changes entry. Preserve the exact field/index identity. Use applicant_change only with supported linked changed_facts indices; wording_only/noise requires an empty fact_indices array. Every fact needs its genuine directional sides covered. Any uncertain, missing, extra or duplicate unit holds the whole pair; do not omit or summarize a unit." : "";
    return freeze({ parts: sides.flatMap(side => [{ text: `${side.toUpperCase()} ORIGINAL PDF sha256=${docs[side].meta.file_hash}; pages=${docs[side].meta.page_count}` },
      { inlineData: { mimeType: "application/pdf", data: docs[side].pdf.body.toString("base64") } }]),
    verifiedPdfInputs: sides.map(side => ({ sha256: docs[side].meta.file_hash, byte_length: docs[side].pdf.body.length,
      page_count: docs[side].meta.page_count, native_text: parsed[side].text })), pair, instructions: instructions + wholeInstructions });
  } catch (error) { if (error?.nativePdfReviewHold) throw error; fail("retained_input_invalid"); }
}

export function nativePdfResponseSchema(base, { wholeOriginal = false } = {}) {
  return { ...base, properties: { ...base.properties, pdf_review: { type: "object", properties: {
    profile: { type: "string", enum: [NATIVE_PDF_REVIEW_PROFILE] }, previous_sha256: { type: "string" }, current_sha256: { type: "string" },
    previous_pages: { type: "array", items: { type: "integer" } }, current_pages: { type: "array", items: { type: "integer" } },
    uncertain_pages: { type: "array", items: { type: "object", properties: { side: { type: "string", enum: [...sides] }, page: { type: "integer" }, reason: { type: "string" } }, required: ["side", "page", "reason"] } },
    page_evidence: { type: "array", items: { type: "object", properties: { fact_index: { type: "integer" }, previous_page: { type: "integer", nullable: true }, current_page: { type: "integer", nullable: true } }, required: ["fact_index", "previous_page", "current_page"] } },
    ...(wholeOriginal ? { unit_reviews: { type: "array", items: { type: "object", properties: {
      field: { type: "string", enum: [...directionalFields] }, index: { type: "integer" },
      disposition: { type: "string", enum: ["applicant_change", "wording_only", "noise", "uncertain"] },
      fact_indices: { type: "array", items: { type: "integer" } } }, required: ["field", "index", "disposition", "fact_indices"] } } } : {}),
  }, required: ["profile", "previous_sha256", "current_sha256", "previous_pages", "current_pages", "uncertain_pages", "page_evidence", ...(wholeOriginal ? ["unit_reviews"] : [])] } },
  required: [...new Set([...(base.required || []), "pdf_review"])] };
}

const hold = reason => ({ allowed: false, manual_review_required: true, reason: `native_pdf_review_${reason}`,
  retain_both_captures: true, baseline_advance_allowed: false, creates_api_charge: false });

function unitReviewDecision({ review, raw, result, facts, evidence }) {
  const units = directionalFields.flatMap(field => evidence[field].map((value, index) => ({ field, index, value })));
  if (!Array.isArray(review.unit_reviews) || review.unit_reviews.length !== units.length ||
      (raw.structured_diff != null && (!object(raw.structured_diff) || directionalFields.some(field =>
        Object.hasOwn(raw.structured_diff, field) && !equal(raw.structured_diff[field], evidence[field])))) ||
      (result.structured_diff !== undefined && directionalFields.some(field => !equal(result.structured_diff?.[field], evidence[field])))) return hold("unit_coverage");
  const seen = new Set(), covered = new Set();
  for (const row of review.unit_reviews) {
    const unit = units.find(unit => unit.field === row?.field && unit.index === row?.index);
    const key = `${row?.field}:${row?.index}`;
    if (!keys(row, ["field", "index", "disposition", "fact_indices"]) || !unit || !Number.isSafeInteger(row.index) || seen.has(key) ||
        !["applicant_change", "wording_only", "noise"].includes(row.disposition) || !Array.isArray(row.fact_indices) ||
        new Set(row.fact_indices).size !== row.fact_indices.length || row.fact_indices.some(index => !Number.isSafeInteger(index) || index < 0 || index >= facts.length) ||
        (row.disposition === "applicant_change" ? !row.fact_indices.length : row.fact_indices.length !== 0)) return hold("unit_coverage");
    seen.add(key);
    if (row.disposition !== "applicant_change") continue;
    const direction = unit.field === "added_text" ? "current" : unit.field === "removed_text" ? "previous"
      : unit.value.startsWith("Added ") ? "current" : unit.value.startsWith("Removed ") ? "previous" : null;
    const text = normalizeVisibleText(["date_changes", "amount_changes"].includes(unit.field) ? unit.value.replace(/^(Added|Removed) /, "") : unit.value);
    if (!direction || !text) return hold("unit_fact_binding");
    for (const index of row.fact_indices) {
      const fact = facts[index], quotes = (direction === "previous" ? [fact.before, fact.removed_text] : [fact.after, fact.added_text]).filter(value => value !== null);
      if (!quotes.length || quotes.some(quote => typeof quote !== "string" || !normalizeVisibleText(quote) ||
        !(text.includes(normalizeVisibleText(quote)) || (["date_changes", "amount_changes"].includes(unit.field) && normalizeVisibleText(quote).includes(text))))) return hold("unit_fact_binding");
      covered.add(`${index}:${direction}`);
    }
  }
  if (facts.some((fact, index) => sides.some(side => (side === "previous" ? [fact.before, fact.removed_text] : [fact.after, fact.added_text])
    .some(value => value !== null) && !covered.has(`${index}:${side}`)))) return hold("unit_fact_binding");
  return { allowed: true };
}

/** Additional check only. Existing source/legacy/directional/policy gates still apply. */
export function validateNativePdfReviewResult({ candidate, result, pair } = {}) {
  const diff = candidate?.deterministic_diff || candidate?.prompt_payload?.deterministic_diff || {};
  const wholeOriginal = Object.hasOwn(diff, "native_pdf_completeness");
  if (!nativePdfCandidate(candidate) || candidate.candidate_scope !== "content_change" || !uuid(candidate.id) || !uuid(candidate.shared_award_source_id) ||
      !uuid(candidate.shared_award_id) || !sha(candidate.candidate_signature) ||
      candidate.worker_metadata?.native_pdf_review_profile !== NATIVE_PDF_REVIEW_PROFILE ||
      pair?.profile !== NATIVE_PDF_REVIEW_PROFILE || pair.candidate_id !== candidate.id || pair.candidate_signature !== candidate.candidate_signature ||
      pair.source_id !== candidate.shared_award_source_id || pair.award_id !== candidate.shared_award_id || pair.source_url !== candidate.source_url ||
      sides.some(side => !sha(pair[side]?.sha256) || pair[side].sha256 !== candidate[field(side, "file_hash")] ||
        !Number.isSafeInteger(pair[side].page_count) || pair[side].page_count < 1 || pair[side].page_count > limits.pages ||
        !Array.isArray(pair[side].pages) || pair[side].pages.length !== pair[side].page_count ||
        pair[side].pages.some((page, i) => page?.page !== i + 1 || typeof page.text !== "string") ||
        pair[side].pages.reduce((n, page) => n + Buffer.byteLength(page.text), 0) > limits.nativeBytes)) return hold("pair_binding");
  if (wholeOriginal && (!nativePdfWholeOriginalCompletenessDecision({ candidate, diff }).allowed || pair.completeness_digest !== diff.native_pdf_completeness.digest ||
      !equal(pair.directional_evidence, Object.fromEntries(directionalFields.map(field => [field, diff[field]]))))) return hold("whole_original_proof_mismatch");
  const raw = result?.raw_result, review = raw?.pdf_review, facts = raw?.changed_facts;
  if (result?.finish_reason !== "STOP" || result.provider_candidate_count !== 1) return hold("incomplete_response");
  if (!object(raw) || !keys(review, ["profile", "previous_sha256", "current_sha256", "previous_pages", "current_pages", "uncertain_pages", "page_evidence", ...(wholeOriginal ? ["unit_reviews"] : [])]) ||
      review.profile !== NATIVE_PDF_REVIEW_PROFILE || review.previous_sha256 !== pair.previous.sha256 || review.current_sha256 !== pair.current.sha256 ||
      sides.some(side => !equal(review[`${side}_pages`], pair[side].pages.map(page => page.page))) ||
      !Array.isArray(review.uncertain_pages) || review.uncertain_pages.length !== 0) return hold("page_coverage");
  if ((result.pdf_review !== undefined && !equal(result.pdf_review, review)) || !Array.isArray(facts) || facts.length > 12 ||
      !equal(facts, result.changed_facts) || (raw.changed_award_facts !== undefined && !equal(raw.changed_award_facts, facts)) ||
      (result.changed_award_facts !== undefined && !equal(result.changed_award_facts, facts)) ||
      result.is_true_change !== raw.is_true_change || result.is_alert_worthy !== raw.is_alert_worthy ||
      (facts.length ? raw.is_true_change !== true || raw.is_alert_worthy !== true : raw.is_true_change !== false || raw.is_alert_worthy !== false) ||
      !Array.isArray(review.page_evidence) || review.page_evidence.length !== facts.length) return hold("result_consistency");
  const seen = new Set();
  for (const citation of review.page_evidence) {
    if (!keys(citation, ["fact_index", "previous_page", "current_page"]) || !Number.isSafeInteger(citation.fact_index) || citation.fact_index < 0 ||
        citation.fact_index >= facts.length || seen.has(citation.fact_index)) return hold("fact_index");
    seen.add(citation.fact_index); const fact = facts[citation.fact_index];
    if (!object(fact) || typeof fact.fact !== "string" || !fact.fact.trim() || fact.visual_evidence !== null) return hold("visual_only_or_malformed_fact");
    let quotes = 0;
    for (const side of sides) {
      const values = (side === "previous" ? [fact.before, fact.removed_text] : [fact.after, fact.added_text]).filter(value => value !== null);
      if (!values.length) { if (citation[`${side}_page`] !== null) return hold("absent_side_citation"); continue; }
      quotes += values.length; const page = pair[side].pages[citation[`${side}_page`] - 1];
      if (!Number.isSafeInteger(citation[`${side}_page`]) || !page || values.some(value => typeof value !== "string" ||
        normalizeVisibleText(value).length < 4 || !normalizeVisibleText(page.text).includes(normalizeVisibleText(value)))) return hold("page_quote_mismatch");
    }
    if (!quotes) return hold("missing_native_quotes");
  }
  if (wholeOriginal) {
    const units = unitReviewDecision({ review, raw, result, facts, evidence: pair.directional_evidence });
    if (!units.allowed) return units;
  }
  return { allowed: true, reason: wholeOriginal ? "native_pdf_review_complete_originals_and_all_directional_units"
    : "native_pdf_review_complete_page_acknowledgements_and_native_quotes", exhaustive_visual_accuracy_verified: false };
}
