import { createHash } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { assertRenderedHtmlArtifactIdentity } from "./r2-capture-artifact-bindings.mjs";
import { maxRenderedHtmlBytes } from "./rendered-html-capture.mjs";
import { extractStructuredHtml } from "./structured-html-content.mjs";

export const renderedHtmlComparisonSchema = "awardping.html-comparison.v1";
const maximumExamples = 4;
const maximumExampleCharacters = 320;
const maximumExampleCells = 16;
const plainHtmlType = "text/plain; charset=utf-8";

/**
 * Observation only. Never use this result to publish, suppress an existing
 * candidate, advance a baseline, or claim screenshot coordinates. Old captures
 * without HTML remain eligible for the existing text/image comparison.
 */
export function compareRetainedHtmlCaptures({
  previous,
  current,
  sourceId,
  archiveRoot,
  baselineRefresh = false,
} = {}) {
  const result = {
    schema: renderedHtmlComparisonSchema,
    mode: "shadow",
    publishable: false,
    visibility: "not_verified",
    screenshot_alignment: "not_verified",
    status: "unavailable",
    reason: null,
    previous: null,
    current: null,
    changes: null,
    visible_text_changed: null,
  };
  if (current?.kind === "pdf" || previous?.kind === "pdf") {
    return { ...result, reason: "pdf_not_applicable" };
  }
  if (baselineRefresh) return { ...result, reason: "baseline_refresh" };
  if (!previous) return { ...result, status: "first_observation", reason: "no_previous_capture" };
  let side = "previous";
  try {
    const before = readVerifiedHtmlCapture(previous, { sourceId, archiveRoot });
    result.previous = captureIdentity(before);
    side = "current";
    const after = readVerifiedHtmlCapture(current, { sourceId, archiveRoot });
    result.current = captureIdentity(after);
    result.visible_text_changed = normalizeText(before.text) !== normalizeText(after.text);
    side = "pair";
    if (before.metadata.final_url !== after.metadata.final_url) reject("source_url_changed");
    if (Date.parse(before.metadata.captured_at) >= Date.parse(after.metadata.captured_at)) {
      reject("capture_order_invalid");
    }
    for (const field of ["capture_profile", "capture_behavior_version", "section_extraction_profile"]) {
      if (before.metadata[field] == null || before.metadata[field] !== after.metadata[field]) {
        reject("capture_configuration_changed");
      }
    }
    const parsed = [];
    for (const [label, capture] of [["previous", before], ["current", after]]) {
      side = label;
      const content = extractStructuredHtml(capture.html, { sourceUrl: capture.metadata.final_url });
      if (content.status !== "ok") reject(`extraction_${safeReason(content.reason)}`);
      // outerHTML cannot prove computed CSS visibility. Require all compared
      // prose to also occur in this capture's byte-verified visible-text file.
      // This is corroboration, not pixel alignment or a completeness guarantee.
      const visibleText = normalizeText(capture.text);
      let visibleOffset = 0;
      for (const block of content.blocks) {
        const normalized = normalizeText(block.text);
        const index = visibleText.indexOf(normalized, visibleOffset);
        if (index < 0) reject("visible_text_not_corroborated");
        visibleOffset = index + normalized.length;
      }
      parsed.push(content);
    }
    side = "pair";
    if (parsed[0].scope !== parsed[1].scope) reject("content_scope_changed");
    const changes = compareStructuredHtmlDocuments(parsed[0], parsed[1]);
    result.previous = { ...result.previous, scope: parsed[0].scope, content_hash: parsed[0].content_hash };
    result.current = { ...result.current, scope: parsed[1].scope, content_hash: parsed[1].content_hash };
    // A selected main/article (or ignored navigation) is not the whole visible
    // page. Do not call the page unchanged when retained visible text disagrees.
    if (result.visible_text_changed && !changes.text_changed && !changes.links_changed && !changes.structure_changed) {
      reject("visible_text_change_not_explained");
    }
    return {
      ...result,
      status: changes.text_changed || changes.links_changed || changes.structure_changed ? "changed" : "unchanged",
      reason: null,
      visible_text_corroborated: true,
      changes,
    };
  } catch (error) {
    // Browser/HTML/file errors can contain arbitrary source text or local paths.
    // Persist stable codes only, not raw exception messages.
    return { ...result, reason: `${side}_${safeReason(error?.htmlComparisonReason)}` };
  }
}

export function compareStructuredHtmlDocuments(previous, current) {
  const textChanged = normalizeText(previous.text) !== normalizeText(current.text);
  const structureChanged = !textChanged && structuredContextIdentity(previous) !== structuredContextIdentity(current);
  const blockKey = (block) => JSON.stringify([block.heading_path, block.list_path || [], block.text, block.cells || null]);
  const linkKey = (link) => JSON.stringify([link.heading_path, link.list_path || [], link.text, link.url]);
  const blocks = textChanged || structureChanged ? multisetDifference(previous.blocks, current.blocks, blockKey) : { added: [], removed: [] };
  const links = multisetDifference(previous.links, current.links, linkKey);
  const linksChanged = links.added.length > 0 || links.removed.length > 0;
  const example = (entry) => ({
    ...(entry.kind ? { kind: entry.kind } : {}),
    text: entry.text.slice(0, maximumExampleCharacters),
    heading_path: entry.heading_path.slice(-8).map((heading) => heading.slice(0, maximumExampleCharacters)),
    ...(entry.list_path?.length ? { list_path: entry.list_path.slice(-8).map((item) => item.slice(0, maximumExampleCharacters)) } : {}),
    ...(entry.url ? { url: entry.url.slice(0, maximumExampleCharacters) } : {}),
    ...(entry.cells ? { cells: entry.cells.slice(0, maximumExampleCells).map((cell) => ({
      ...cell, text: cell.text.slice(0, maximumExampleCharacters),
    })) } : {}),
  });
  const groups = [blocks.added, blocks.removed, links.added, links.removed];
  return {
    text_changed: textChanged,
    links_changed: linksChanged,
    structure_changed: structureChanged,
    order_only: textChanged && !linksChanged && blocks.added.length === 0 && blocks.removed.length === 0,
    added_blocks: blocks.added.length,
    removed_blocks: blocks.removed.length,
    added_links: links.added.length,
    removed_links: links.removed.length,
    examples: {
      added_blocks: blocks.added.slice(0, maximumExamples).map(example),
      removed_blocks: blocks.removed.slice(0, maximumExamples).map(example),
      added_links: links.added.slice(0, maximumExamples).map(example),
      removed_links: links.removed.slice(0, maximumExamples).map(example),
    },
    examples_truncated: groups.some((group) => group.length > maximumExamples || group.some((entry) => (
      entry.text.length > maximumExampleCharacters || (entry.url?.length || 0) > maximumExampleCharacters ||
      entry.heading_path.length > 8 || entry.heading_path.some((heading) => heading.length > maximumExampleCharacters) ||
      (entry.list_path?.length || 0) > 8 || entry.list_path?.some((item) => item.length > maximumExampleCharacters) ||
      (entry.cells?.length || 0) > maximumExampleCells || entry.cells?.some((cell) => cell.text.length > maximumExampleCharacters)
    ))),
  };
}

function structuredContextIdentity(content) {
  // Join adjacent same-context prose to ignore harmless paragraph/div wrapping,
  // but keep qualifications under their headings and values in their cells.
  const sections = [];
  const tables = [];
  for (const block of content.blocks) {
    const context = JSON.stringify([block.heading_path, block.list_path || []]);
    const last = sections.at(-1);
    if (last?.context === context) last.text = normalizeText(`${last.text} ${block.text}`);
    else sections.push({ context, text: normalizeText(block.text) });
    if (block.cells) tables.push({ context, cells: block.cells });
  }
  return JSON.stringify({ sections, tables });
}

function multisetDifference(previous, current, key) {
  const remaining = new Map();
  for (const entry of previous) {
    const identity = key(entry);
    const bucket = remaining.get(identity) || [];
    bucket.push(entry);
    remaining.set(identity, bucket);
  }
  const added = [];
  for (const entry of current) {
    const bucket = remaining.get(key(entry));
    if (bucket?.length) bucket.pop();
    else added.push(entry);
  }
  return { added, removed: [...remaining.values()].flat() };
}

/** Read a local record without executing HTML or rewriting retained evidence. */
export function loadRetainedHtmlCaptureRecord({ metadataPath, archiveRoot }) {
  const file = readBoundedArchiveFile(metadataPath, archiveRoot);
  if (basename(file.path) !== "meta.json") reject("metadata_name_invalid");
  const metadata = JSON.parse(decodeUtf8(file.body));
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) reject("metadata_invalid");
  const artifactPath = (reference) => {
    if (reference == null) return null;
    if (typeof reference !== "string" || !reference || isAbsolute(reference) || reference.includes("\\") || reference.includes(":")) {
      reject("capture_reference_mismatch");
    }
    if (reference.split("/").some((part) => !part || part === "." || part === "..")) reject("capture_reference_mismatch");
    return resolve(archiveRoot, reference);
  };
  return {
    metadata_sha256: hash(file.body),
    capture: {
      kind: metadata.kind,
      source: metadata.source,
      captured_at: metadata.captured_at,
      final_url: metadata.final_url,
      text_hash: metadata.text_hash,
      html_capture: metadata.html_capture,
      files: metadata.files,
      retained_metadata_sha256: hash(file.body),
      meta_path: file.path,
      html_path: artifactPath(metadata.files?.html),
      text_path: artifactPath(metadata.files?.text),
    },
  };
}

function readVerifiedHtmlCapture(capture, { sourceId, archiveRoot }) {
  if (!capture?.html_path || !capture?.meta_path || !capture?.text_path) reject("html_or_text_missing");
  if (!sourceId || !archiveRoot) reject("identity_missing");
  const metaFile = readBoundedArchiveFile(capture.meta_path, archiveRoot);
  if (capture.retained_metadata_sha256 !== undefined && capture.retained_metadata_sha256 !== hash(metaFile.body)) {
    reject("metadata_changed_during_replay");
  }
  const metadata = JSON.parse(decodeUtf8(metaFile.body));
  if (metadata.kind !== "webpage" || capture.kind !== "webpage") reject("kind_invalid");
  if (metadata.source?.id !== sourceId || capture.source?.id !== sourceId) reject("source_mismatch");
  if (metadata.captured_at !== capture.captured_at || metadata.final_url !== capture.final_url) reject("capture_identity_mismatch");
  if (!Number.isFinite(Date.parse(metadata.captured_at))) reject("capture_timestamp_invalid");
  if (!Number.isInteger(metadata.status_code) || metadata.status_code < 200 || metadata.status_code >= 300) reject("http_status_not_successful");
  if (metadata.page_settle?.stable !== true || metadata.page_settle?.timed_out !== false || metadata.page_readiness?.timed_out !== false) {
    reject("capture_incomplete");
  }
  if (metadata.html_capture?.status !== "captured") reject("html_unavailable");
  const htmlFile = readBoundedArchiveFile(capture.html_path, archiveRoot);
  const textFile = readBoundedArchiveFile(capture.text_path, archiveRoot);
  for (const [file, name, reference] of [
    [htmlFile, "page.html.txt", metadata.files?.html],
    [textFile, "text.txt", metadata.files?.text],
  ]) {
    if (basename(file.path) !== name || dirname(file.path) !== dirname(metaFile.path)) reject("capture_path_mismatch");
    if (typeof reference !== "string" || isAbsolute(reference) || resolve(archiveRoot, reference) !== file.path) reject("capture_reference_mismatch");
  }
  assertRenderedHtmlArtifactIdentity({
    capture,
    metadata,
    kind: "webpage",
    artifacts: new Map([["html", {
      path: capture.html_path,
      fileName: "page.html.txt",
      contentType: plainHtmlType,
      body: htmlFile.body,
      binding: {
        sha256: hash(htmlFile.body), byte_length: htmlFile.body.length,
        content_type: plainHtmlType, hash_mode: "raw_sha256",
      },
    }]]),
  });
  const rawText = decodeUtf8(textFile.body);
  const text = rawText.endsWith("\r\n") ? rawText.slice(0, -2) : rawText.endsWith("\n") ? rawText.slice(0, -1) : null;
  if (text === null || /[\r\n]$/.test(text) || hash(text) !== metadata.text_hash || metadata.text_hash !== capture.text_hash || metadata.text_length !== text.length) {
    reject("visible_text_identity_mismatch");
  }
  const html = decodeUtf8(htmlFile.body);
  if (/\b(?:checking your browser|verify you are human|access denied|just a moment|enable javascript and cookies to continue|sign in to continue)\b/i.test(text.slice(0, 500))) {
    reject("blocked_page_content");
  }
  return { metadata, html, text };
}

function readBoundedArchiveFile(path, archiveRoot) {
  const root = realpathSync(archiveRoot);
  const absolute = resolve(path);
  const pathFromRoot = relative(root, absolute);
  if (!pathFromRoot || pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) reject("archive_path_unsafe");
  let cursor = root;
  let checked;
  for (const segment of pathFromRoot.split(sep)) {
    cursor = resolve(cursor, segment);
    checked = lstatSync(cursor);
    if (checked.isSymbolicLink()) reject("archive_path_unsafe");
  }
  if (!checked.isFile() || checked.size > maxRenderedHtmlBytes) reject("artifact_size_invalid");
  const fd = openSync(absolute, "r");
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.ino !== checked.ino || opened.dev !== checked.dev || opened.size > maxRenderedHtmlBytes) reject("archive_file_changed");
    const body = Buffer.alloc(opened.size + 1);
    let bytes = 0;
    while (bytes < body.length) {
      const count = readSync(fd, body, bytes, body.length - bytes, null);
      if (count === 0) break;
      bytes += count;
    }
    if (bytes > maxRenderedHtmlBytes || bytes !== opened.size) reject("artifact_size_invalid");
    return { path: absolute, body: body.subarray(0, bytes) };
  } finally {
    closeSync(fd);
  }
}

function captureIdentity(value) {
  return { captured_at: value.metadata.captured_at, html_sha256: value.metadata.html_capture.sha256, visible_text_sha256: value.metadata.text_hash };
}

function normalizeText(text) { return String(text || "").replace(/\s+/gu, " ").trim(); }
function hash(value) { return createHash("sha256").update(value).digest("hex"); }
function decodeUtf8(body) { return new TextDecoder("utf-8", { fatal: true }).decode(body); }
function reject(reason) { throw Object.assign(new Error(reason), { htmlComparisonReason: reason }); }
function safeReason(value) { return /^[a-z][a-z0-9_]{0,100}$/.test(String(value || "")) ? value : "evidence_invalid"; }
