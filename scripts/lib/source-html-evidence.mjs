import { createHash } from "node:crypto";
import { isDeepStrictEqual as equal } from "node:util";
import { validateScraplingCapture, scraplingSourceHtmlProfile } from "./scrapling-capture.mjs";
import { normalizeVisibleText } from "./capture-stability.mjs";

export const SOURCE_HTML_PROFILE = scraplingSourceHtmlProfile;
export const SOURCE_HTML_EVIDENCE_SCHEMA = "awardping.source-html-evidence.v1";
export const SOURCE_HTML_PROJECTION_SCHEMA = "awardping.source-html-artifact-projection.v1";
const hash = value => createHash("sha256").update(value).digest("hex");
const fail = reason => { throw new Error(`Source HTML evidence: ${reason}`); };

export function sourceHtmlEvidence(record) {
  const checked = validateScraplingCapture(record, { source: { id: record?.source_id, url: record?.url } });
  if (checked.capture_profile !== SOURCE_HTML_PROFILE) fail("profile required");
  const capture = { ...checked };
  delete capture.html;
  return { schema: SOURCE_HTML_EVIDENCE_SCHEMA, capture };
}

/** Source-only proof is separate from browser geometry/expansion authority. */
export function sourceHtmlArtifactProjection() {
  return { schema: SOURCE_HTML_PROJECTION_SCHEMA, kind: "webpage", capture_profile: SOURCE_HTML_PROFILE,
    acquisition: "ordinary_anonymous_http", visibility_verified: false, screenshot_available: false,
    artifact_slots: ["html", "meta", "text"], localization_status: "source_html_no_screenshot",
    authoritative: { layout_retained: false, layout_hash: null, expansion_state_count: 0 } };
}

export function assertSourceHtmlAbsence(capture) {
  if (capture?.capture_profile !== SOURCE_HTML_PROFILE || capture?.kind !== "webpage") fail("profile or kind mismatch");
  for (const field of ["page_path", "thumb_path", "pdf_path", "layout_path", "image_hash", "file_hash", "layout_hash",
    "text_geometry", "html_capture", "browser", "page_readiness", "page_settle", "dimensions", "screenshot", "readiness",
    "visible_html", "visible_text", "document"])
    if (capture[field] !== undefined && capture[field] !== null) fail(`unexpected browser field ${field}`);
  for (const field of ["page_bytes", "thumb_bytes", "file_bytes", "expansion_state_count"])
    if (capture[field] !== undefined && capture[field] !== null && capture[field] !== 0) fail(`unexpected browser count ${field}`);
  for (const field of ["expansion_state_screenshots", "expansion_state_failures"])
    if (capture[field] !== undefined && (!Array.isArray(capture[field]) || capture[field].length)) fail(`unexpected browser states ${field}`);
  if (capture.expansion_state_capture_coverage != null || capture.localization != null) fail("browser authority not applicable");
  for (const [key, value] of Object.entries(capture.files || {}))
    if (!["html", "meta", "text"].includes(key) && value != null && !(key === "expansion_states" && Array.isArray(value) && !value.length)) fail("unexpected artifact reference");
  if (!equal(capture.retained_artifact_projection, sourceHtmlArtifactProjection())) fail("source artifact projection required");
}

/** Revalidates the retained capsule against its actual raw response bytes. */
export function validateSourceHtmlEvidence(capture, { html, source = capture?.source } = {}) {
  assertSourceHtmlAbsence(capture);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  if (!uuid.test(capture.source?.id || "") || !uuid.test(capture.source?.shared_award_id || "")) fail("source UUID identity required");
  const capsule = capture.source_html;
  if (!capsule || capsule.schema !== SOURCE_HTML_EVIDENCE_SCHEMA || Object.keys(capsule).sort().join() !== "capture,schema" ||
      !capsule.capture || Object.hasOwn(capsule.capture, "html") || !capsule.capture.integrity) fail("sealed source capsule required");
  let raw;
  try { raw = Buffer.isBuffer(html) ? new TextDecoder("utf-8", { fatal: true }).decode(html) : html; }
  catch { fail("invalid UTF-8 response"); }
  if (typeof raw !== "string" || (Buffer.isBuffer(html) && !Buffer.from(raw).equals(html))) fail("raw response required");
  const record = validateScraplingCapture({ ...capsule.capture, html: raw }, { source });
  if (record.capture_profile !== SOURCE_HTML_PROFILE || record.source_id !== capture.source?.id ||
      record.url !== capture.source?.url || record.captured_at !== capture.captured_at || record.final_url !== capture.final_url ||
      record.status_code !== capture.status_code || record.content_type !== capture.content_type ||
      (source?.shared_award_id && source.shared_award_id !== capture.source?.shared_award_id)) fail("retained source identity mismatch");
  const text = sourceHtmlReviewText(record);
  if (capture.text_hash !== hash(text) || capture.text_length !== text.length ||
      capture.body_text_hash !== hash(text) || capture.main_content_hash !== hash(text)) fail("review text identity mismatch");
  if (capture.source_html_body_hash != null && capture.source_html_body_hash !== record.source_http.body_sha256) fail("source body hash mismatch");
  return record;
}

/** Both full-body qualifications and exact main-element context remain evidence. */
export function sourceHtmlReviewText(record) {
  const documents = [record?.html_document, record?.source_main_document];
  if (documents.some(doc => doc?.schema !== "awardping.scrapling-html-document.v1" || typeof doc.text !== "string")) fail("source documents required");
  const context = documents.map(doc => ({ scope: doc.scope, title: doc.title, text: doc.text,
    blocks: doc.blocks, links: doc.links, base_hrefs: doc.base_hrefs }));
  const text = normalizeVisibleText([record.html_document.title, record.html_document.text,
    "HTML source evidence only; not browser-visible content, screenshot locations, or a current-fact assertion:",
    JSON.stringify(context).replace(/\s/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`)].join("\n\n"));
  if (Buffer.byteLength(text) > 6 * 1024 * 1024) fail("review text too large");
  return text;
}

export function assertSourceHtmlArtifactSlots(artifactBindings) {
  if (Object.keys(artifactBindings || {}).sort().join() !== "html,meta,text") fail("exact html/meta/text slots required");
}

/** Complete source-only writer/readback binding, not a browser fallback. */
export function assertSourceHtmlArtifactIdentity(capture, prepared, { sourceId, verifyLocalPath = true } = {}) {
  assertSourceHtmlArtifactSlots(prepared?.artifactBindings);
  const list = prepared?.artifacts;
  if (!Array.isArray(list) || list.length !== 3 || new Set(list.map(a => a.name)).size !== 3) fail("exact prepared artifacts required");
  const artifacts = new Map(list.map(a => [a.name, a]));
  const definitions = { html: ["page.html.txt", "text/plain; charset=utf-8"], text: ["text.txt", "text/plain; charset=utf-8"], meta: ["meta.json", "application/json; charset=utf-8"] };
  for (const [slot, [filename, contentType]] of Object.entries(definitions)) {
    const artifact = artifacts.get(slot), binding = prepared.artifactBindings[slot];
    if (!artifact || !Buffer.isBuffer(artifact.body) || !artifact.body.length || artifact.body.length > 24 * 1024 * 1024 ||
        artifact.fileName !== filename || artifact.contentType !== contentType || binding?.content_type !== contentType ||
        Object.keys(binding).sort().join() !== "byte_length,content_type,hash_mode,sha256" ||
        binding.hash_mode !== "raw_sha256" || binding.sha256 !== hash(artifact.body) || binding.byte_length !== artifact.body.length ||
        !equal(binding, artifact.binding)) fail(`invalid raw artifact ${slot}`);
  }
  let metadata;
  try { metadata = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(artifacts.get("meta").body)); }
  catch { fail("invalid raw metadata"); }
  const record = validateSourceHtmlEvidence(capture, { html: artifacts.get("html").body });
  validateSourceHtmlEvidence(metadata, { html: artifacts.get("html").body, source: capture.source });
  if ((sourceId && sourceId !== capture.source.id) || !equal(capture.source_html, metadata.source_html) ||
      metadata.source.shared_award_id !== capture.source.shared_award_id) fail("source capsule metadata mismatch");
  const prefix = `sources/${capture.source.id}/captures/${new Date(capture.captured_at).toISOString().replace(/[:.]/g, "-")}/`;
  for (const [slot, [filename]] of Object.entries(definitions)) {
    const reference = `${prefix}${filename}`;
    if (capture.files?.[slot] !== reference || metadata.files?.[slot] !== reference ||
        (verifyLocalPath && capture[`${slot}_path`] !== artifacts.get(slot).path)) fail("artifact path identity mismatch");
  }
  if (!artifacts.get("text").body.equals(Buffer.from(`${sourceHtmlReviewText(record)}\n`))) fail("review text bytes mismatch");
  if (capture.source_html.capture.source_http.body_sha256 !== prepared.artifactBindings.html.sha256 ||
      capture.source_html.capture.source_http.body_byte_length !== prepared.artifactBindings.html.byte_length) fail("raw HTTP body binding mismatch");
  return record;
}
