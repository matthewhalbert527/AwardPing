import { createHash } from "node:crypto";
import { normalizePublicHttpUrl } from "./public-network-safety.mjs";

// Pure retained-evidence contract. No browser, extraction engine, OCR bridge,
// local file retention, process launch or source fetching is imported here.
export const PROGRAM_TEXT_CAPTURE_SCHEMA = "awardping.program-text-capture.v1";
export const PROGRAM_TEXT_CAPTURE_PROFILE = "program-text-capture-v1";
export const programTextCaptureLimits = Object.freeze({ htmlBytes: 5 * 1024 * 1024,
  pdfBytes: 20 * 1024 * 1024, textCharacters: 1_000_000, textBytes: 8 * 1024 * 1024,
  blocks: 20_000, pages: 1000, processTimeoutMs: 90_000 });
const hash = value => createHash("sha256").update(value).digest("hex");
// Independently restored originals for six SMART identities contained exactly
// this SPA shell. Keep their historical references readable, but never count
// them as collected program content or reset their saved baseline implicitly.
const knownHtmlShellText = "Loading... Skip to page contentSkip to chat Skip to page contentSkip to chat";
const knownHtmlShellSha256 = hash(knownHtmlShellText);
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value) && !/^0{8}(?:-0{4}){3}-0{12}$/.test(value);
const modes = new Set(["http_html", "rendered_html", "pdf_text", "pdf_ocr"]);
const fail = (reason, details = {}) => { throw Object.assign(new Error(`Program text capture: ${reason}`), details, { code: `program_text_${reason}` }); };
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value);
const sha = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const utf8 = bytes => { const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); if (!Buffer.from(text).equals(bytes)) fail("invalid_utf8"); return text; };
function publicUrl(value) {
  if (typeof value !== "string" || value.length > 10_000) fail("invalid_url");
  const url = normalizePublicHttpUrl(value);
  if (url.href !== value || url.port || url.hash) fail("invalid_url");
  return url;
}
function sourceIdentity(source) {
  if (!plain(source) || !uuid(source.id) || !uuid(source.shared_award_id)) fail("invalid_source_identity");
  publicUrl(source.url);
  const result = { id: source.id, shared_award_id: source.shared_award_id, url: source.url };
  for (const key of ["title", "page_type"]) if (source[key] != null) {
    if (typeof source[key] !== "string" || source[key].length > 10_000) fail("invalid_source_identity");
    result[key] = source[key];
  }
  return result;
}
function sameIdentity(a, b) { return a.id === b.id && a.shared_award_id === b.shared_award_id && a.url === b.url; }
const canonical = value => Array.isArray(value) ? value.map(canonical) : plain(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
function fingerprint(capture) {
  return hash(JSON.stringify(canonical([capture.schema, capture.capture_profile, capture.source, capture.final_url,
    capture.captured_at, capture.acquisition, capture.extractor, capture.raw_source.content_type,
    capture.raw_source.sha256, capture.raw_source.byte_length, capture.text_sha256, capture.blocks, capture.completeness])));
}
function scalarText(value, max = 10_000) { return typeof value === "string" && value.length <= max; }
function splitSurrogate(text, index) { return index > 0 && index < text.length && /[\uD800-\uDBFF]/.test(text[index - 1]) && /[\uDC00-\uDFFF]/.test(text[index]); }

/** A narrow content-quality check, not a minimum length or a facts classifier.
 * Every word must be a recognizable loading/skip-navigation placeholder. Any
 * other prose remains available for review, even a very short announcement. */
export function isProgramTextHtmlShell(text) {
  if (typeof text !== "string" || !text.trim()) return false;
  const normalized = text.normalize("NFKC").replace(/[\u200B-\u200D\u2060\uFEFF]/g, "").toLowerCase();
  let markers = 0;
  const remainder = normalized.replace(/loading(?:\s+(?:page|content|data))?|please\s+wait|skip\s+to\s+(?:(?:page|main)\s+content|content|chat|navigation)/g,
    () => { markers++; return ""; });
  return markers > 0 && /^[\s.!\u2026|\u00B7:;()[\]{}\-\u2013\u2014]*$/.test(remainder);
}

/** Quality hold for one historically verified shell digest only. This is not
 * reference validation: old state/evidence must remain readable and preserved. */
export function isKnownProgramTextHtmlShellReference(ref) {
  return ["http_html", "rendered_html"].includes(ref?.acquisition) && ref?.text_length === knownHtmlShellText.length &&
    ref?.text_sha256 === knownHtmlShellSha256;
}

/** Validate a complete observation, not source approval or a factual conclusion. */
export function validateProgramTextCapture(capture, { source } = {}) {
  const allowed = new Set(["schema", "capture_profile", "capture_id", "source", "final_url", "captured_at", "acquisition",
    "extractor", "raw_source", "text", "text_sha256", "blocks", "completeness"]);
  if (!plain(capture) || Object.keys(capture).some(key => !allowed.has(key)) || capture.schema !== PROGRAM_TEXT_CAPTURE_SCHEMA ||
      capture.capture_profile !== PROGRAM_TEXT_CAPTURE_PROFILE || !modes.has(capture.acquisition)) fail("invalid_contract");
  const identity = sourceIdentity(capture.source);
  if (source && !sameIdentity(identity, sourceIdentity(source))) fail("source_identity_mismatch");
  publicUrl(capture.final_url);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(capture.captured_at || "") ||
      !Number.isFinite(Date.parse(capture.captured_at)) || new Date(capture.captured_at).toISOString() !== capture.captured_at) fail("invalid_timestamp");
  if (!plain(capture.extractor) || Object.keys(capture.extractor).sort().join() !== "name,version" ||
      !scalarText(capture.extractor.name, 160) || !capture.extractor.name || !scalarText(capture.extractor.version, 160) || !capture.extractor.version) fail("invalid_extractor");
  const raw = capture.raw_source, isPdf = capture.acquisition.startsWith("pdf_");
  if (!plain(raw) || Object.keys(raw).sort().join() !== "byte_length,bytes,content_type,sha256" || !Buffer.isBuffer(raw.bytes) ||
      raw.byte_length !== raw.bytes.length || raw.bytes.length < 1 || raw.bytes.length > (isPdf ? programTextCaptureLimits.pdfBytes : programTextCaptureLimits.htmlBytes) ||
      !sha(raw.sha256) || hash(raw.bytes) !== raw.sha256 || !scalarText(raw.content_type, 200) ||
      !(isPdf ? /^application\/pdf(?:;|$)/i : /^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i).test(raw.content_type)) fail("invalid_raw_source");
  if (isPdf && !raw.bytes.subarray(0, 1024).includes(Buffer.from("%PDF-"))) fail("invalid_pdf");
  if (typeof capture.text !== "string" || capture.text.length > programTextCaptureLimits.textCharacters ||
      Buffer.byteLength(capture.text) > programTextCaptureLimits.textBytes || capture.text.includes("\0") ||
      Buffer.from(capture.text).toString("utf8") !== capture.text || !sha(capture.text_sha256) || hash(capture.text) !== capture.text_sha256) fail("invalid_text");
  const complete = capture.completeness;
  if (!plain(complete) || Object.keys(complete).sort().join() !== "reasons,status" || !["complete", "incomplete"].includes(complete.status) ||
      !Array.isArray(complete.reasons) || complete.reasons.length > 100 || complete.reasons.some(reason => !scalarText(reason, 300) || !reason) ||
      complete.status === "complete" && complete.reasons.length || complete.status === "incomplete" && !complete.reasons.length) fail("invalid_completeness");
  if (!Array.isArray(capture.blocks) || capture.blocks.length > programTextCaptureLimits.blocks ||
      (!capture.blocks.length || !capture.text.trim()) && complete.status === "complete") fail("invalid_blocks");
  let cursor = 0;
  const ids = new Set();
  for (const block of capture.blocks) {
    if (!plain(block) || Object.keys(block).some(key => !["id", "text", "start_utf16", "end_utf16", "heading", "page", "kind", "context"].includes(key)) ||
        !scalarText(block.id, 160) || !block.id || ids.has(block.id) || !Number.isSafeInteger(block.start_utf16) || !Number.isSafeInteger(block.end_utf16) ||
        block.start_utf16 < cursor || block.end_utf16 <= block.start_utf16 || block.end_utf16 > capture.text.length ||
        splitSurrogate(capture.text, block.start_utf16) || splitSurrogate(capture.text, block.end_utf16) ||
        typeof block.text !== "string" || !block.text.trim() || capture.text.slice(block.start_utf16, block.end_utf16) !== block.text ||
        capture.text.slice(cursor, block.start_utf16).trim() ||
        block.heading !== undefined && !scalarText(block.heading) || block.kind !== undefined && !scalarText(block.kind, 80) ||
        block.page !== undefined && (!isPdf || !Number.isInteger(block.page) || block.page < 1 || block.page > programTextCaptureLimits.pages) ||
        block.context !== undefined && (!plain(block.context) || Buffer.byteLength(JSON.stringify(block.context)) > 64 * 1024)) fail("invalid_block_binding");
    ids.add(block.id); cursor = block.end_utf16;
  }
  if (capture.text.slice(cursor).trim()) fail("uncovered_text");
  if (capture.capture_id !== fingerprint(capture)) fail("capture_identity_mismatch");
  // Source-link attributes are useful evidence, but a URL cannot turn a page
  // containing only loading/skip controls into complete applicant information.
  if (!isPdf && complete.status === "complete" &&
      isProgramTextHtmlShell(capture.blocks.filter(block => block.kind !== "source_link").map(block => block.text).join("\n"))) fail("html_application_shell_only");
  return capture;
}

/** Adapter boundary: bytes and extraction are retained together; no screenshot slot. */
export function buildProgramTextCapture({ source, final_url = source?.url, captured_at = new Date().toISOString(), acquisition,
  extractor, raw_bytes, content_type, text, blocks, completeness = { status: "complete", reasons: [] } } = {}) {
  if (!Buffer.isBuffer(raw_bytes)) fail("raw_bytes_required");
  const capture = { schema: PROGRAM_TEXT_CAPTURE_SCHEMA, capture_profile: PROGRAM_TEXT_CAPTURE_PROFILE,
    source: sourceIdentity(source), final_url, captured_at: new Date(captured_at).toISOString(), acquisition,
    extractor: structuredClone(extractor), raw_source: { bytes: Buffer.from(raw_bytes), content_type,
      sha256: hash(raw_bytes), byte_length: raw_bytes.length }, text, text_sha256: hash(typeof text === "string" ? text : ""),
    blocks: structuredClone(blocks), completeness: structuredClone(completeness) };
  capture.capture_id = fingerprint(capture);
  return validateProgramTextCapture(capture, { source });
}

/** Full-body extraction may contain hidden/stale text; headings are source context. */
export function blocksFromHtmlDocument(document) {
  if (!plain(document) || typeof document.text !== "string" || !Array.isArray(document.blocks)) fail("invalid_html_extraction");
  const text = document.text, spans = [];
  let cursor = 0, searchCursor = 0;
  for (const item of document.blocks) {
    if (!item || typeof item.text !== "string" || !item.text.trim()) continue;
    const start = text.indexOf(item.text, searchCursor);
    if (start < 0) continue;
    // The parser visits parents before children. A child's text may already be
    // covered by its parent; do not mistakenly match it in a later repeated list.
    searchCursor = start + 1;
    if (start < cursor) continue;
    if (text.slice(cursor, start).trim()) spans.push({ start: cursor, end: start });
    const context = Object.fromEntries(["heading_path", "list_path", "table_row", "details_path", "sibling_button_path", "table_cell"]
      .filter(key => item[key] !== undefined).map(key => [key, item[key]]));
    spans.push({ start, end: start + item.text.length, kind: item.kind,
      ...(item.heading_path?.length ? { heading: item.heading_path.map(h => h.text).join(" > ") } : {}), context });
    cursor = start + item.text.length;
  }
  if (text.slice(cursor).trim()) spans.push({ start: cursor, end: text.length });
  return spans.flatMap((span, index) => {
    const value = text.slice(span.start, span.end), base = { ...(span.kind ? { kind: span.kind } : {}),
      ...(span.heading ? { heading: span.heading } : {}), ...(span.context ? { context: span.context } : {}) };
    const id = `block-${String(index).padStart(6, "0")}`;
    if (value.length <= 3500) return [{ id, text: value, start_utf16: span.start, end_utf16: span.end, ...base }];
    return pageBlocks(value, span.start, undefined, false).map((piece, part) => ({ id: `${id}-part-${part + 1}`,
      text: piece.text, start_utf16: piece.start_utf16, end_utf16: piece.end_utf16, ...base }));
  });
}

/** Relevant source attributes are text evidence, not a claim about displayed
 * words. Preserve their literal values in separately labelled blocks so an
 * application destination can change without changing its visible link label. */
function htmlProjection(document) {
  const blocks = blocksFromHtmlDocument(document); let text = document.text;
  const relevant = /(?:appl(?:y|ication)|portal|nominat|eligib|citizen|deadline|funding|stipend|tuition|academic|discipline|duration|tenure|guideline|handbook|requirement|recommend|transcript|essay|selection|contact|\.pdf(?:[?#]|$))/i;
  let count = 0;
  for (const link of document.links || []) {
    if (!link || typeof link.raw_href !== "string" || !link.raw_href.trim() || /^(?:javascript|vbscript|data|blob):/i.test(link.raw_href.trim())) continue;
    const contextText = [link.text, link.raw_href, ...(link.heading_path || []).map(item => item.text), ...(link.details_path || [])].join(" ");
    if (!relevant.test(contextText)) continue;
    if (++count > 2000 || link.raw_href.length > 10_000) fail("relevant_link_limit");
    text += "\n\n"; const start = text.length; text += link.raw_href;
    blocks.push({ id: `source-link-${String(count).padStart(6, "0")}`, kind: "source_link", text: link.raw_href,
      start_utf16: start, end_utf16: text.length,
      heading: [...(link.heading_path || []).map(item => item.text), link.text || ""].filter(Boolean).join(" > "),
      context: { source_attribute: "href", link_text: link.text || "", base_hrefs: document.base_hrefs || [],
        heading_path: link.heading_path || [], list_path: link.list_path || [], ...(link.details_path ? { details_path: link.details_path } : {}) } });
  }
  return { text, blocks };
}

function pageBlocks(text, offset, page, ocr) {
  const blocks = [];
  const append = (from, to) => {
    while (from < to) {
      let end = Math.min(to, from + 3500);
      if (end < to) {
        const value = text.slice(from, end), boundary = Math.max(value.lastIndexOf("\n"), value.lastIndexOf(" "));
        if (boundary >= 1000) end = from + boundary + 1;
        if (splitSurrogate(text, end)) end--;
      }
      const value = text.slice(from, end);
      if (value.trim()) blocks.push({ id: `page-${page}-block-${blocks.length + 1}`, text: value,
        start_utf16: offset + from, end_utf16: offset + end, page, kind: ocr ? "ocr_page" : "pdf_page" });
      from = end;
    }
  };
  // Keep normal paragraphs intact. Long paragraphs use sentence boundaries so
  // an early word change does not shift every later fixed-width block.
  let start = 0;
  for (const match of text.matchAll(/\n[\t \r]*\n|$/g)) {
    const end = match.index + match[0].length;
    if (end <= start) continue;
    if (end - start <= 3500) append(start, end);
    else {
      let sentence = start;
      for (const point of text.slice(start, end).matchAll(/[.!?;]\s+/g)) {
        const stop = start + point.index + point[0].length;
        if (/(?:\b[A-Za-z]\.|\b(?:a\.m|p\.m|e\.g|i\.e|Mr|Mrs|Dr|St|U\.S)\.)\s*$/i.test(text.slice(sentence, stop))) continue;
        append(sentence, stop); sentence = stop;
      }
      append(sentence, end);
    }
    start = end;
  }
  return blocks;
}

function checkFinalUrl(source, finalUrl, allowedFinalUrls) {
  const requested = publicUrl(source.url), final = publicUrl(finalUrl);
  if (requested.origin !== final.origin && !allowedFinalUrls.includes(final.href)) fail("unapproved_redirect_origin", { final_url: final.href });
}
function htmlCompleteness(document, record = null) {
  const reasons = [];
  if (document.text.trim().length < 40) reasons.push("insufficient_body_text");
  if (isProgramTextHtmlShell(document.text)) reasons.push("html_application_shell_only");
  if (record?.telemetry?.blocked_websockets > 0) reasons.push("rendered_live_content_not_observed");
  return { status: reasons.length ? "incomplete" : "complete", reasons };
}
function pdfTextProjection(result, { ocr = false } = {}) {
  if (!plain(result) || !Number.isInteger(result.total) || result.total < 1 || result.total > programTextCaptureLimits.pages ||
      !Array.isArray(result.pages) || result.pages.length !== result.total ||
      result.pages.some((page, index) => page?.num !== index + 1 || typeof page.text !== "string")) fail("pdf_page_coverage_invalid");
  const reasons = [], blocks = []; let text = "";
  for (const page of result.pages) {
    if (text) text += "\n\f\n";
    const offset = text.length; text += page.text;
    if (page.text.trim().length < 20) reasons.push(`page_${page.num}_sparse_text`);
    if (ocr && page.reading_order_verified !== true) reasons.push(`page_${page.num}_ocr_reading_order_unverified`);
    blocks.push(...pageBlocks(page.text, offset, page.num, ocr));
  }
  return { text, blocks, completeness: { status: reasons.length ? "incomplete" : "complete", reasons: reasons.slice(0, 100) } };
}


/** Internal pure helpers shared by the PC-only acquisition adapter. */
export const programTextCaptureInternals = Object.freeze({ hash, fail, plain, utf8, publicUrl, sourceIdentity,
  isAcquisition: value => modes.has(value), htmlProjection, htmlCompleteness, pdfTextProjection, checkFinalUrl });

