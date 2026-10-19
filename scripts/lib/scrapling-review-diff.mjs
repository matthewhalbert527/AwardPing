import { createHash } from "node:crypto";
import { load } from "cheerio";
import { normalizeVisibleText } from "./capture-stability.mjs";
import { normalizePublicHttpUrl } from "./public-network-safety.mjs";
import { SOURCE_HTML_PROFILE, validateSourceHtmlEvidence, sourceHtmlReviewText } from "./source-html-evidence.mjs";

const PROFILE = "scrapling-evidence-v1";
const MARKER = "HTML source context and link attributes (may include hidden or stale content; not screenshot locations):";
const MAX_ARTIFACT_BYTES = 6 * 1024 * 1024;
// Keep compact packets unchanged, but allow complete long-page context through
// the same review path. This is a packet bound, not a larger spending budget:
// the provider reserves against the entire serialized request before submission.
const COMPACT_DIFF_BYTES = 24000;
const MAX_DIFF_BYTES = 128000;
const MAX_PROSE_CHARS = 8000;
// The publication normalizer retains eight blocks even though the queue accepts
// sixteen. Never enqueue a larger complete change set that would be shortened.
const MAX_CHANGED_BLOCKS = 8;
const MAX_CONTEXT_TABLE_ENTRIES = 50000;
const HONEYPOT_DESCRIPTION = "This field is for validation purposes and should be left unchanged.";
const flow = value => value.replace(/\s+/g, " ").trim();
const hash = value => createHash("sha256").update(value).digest("hex");
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fail = reason => { throw Object.assign(new Error(reason), { scraplingReason: reason }); };
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value, max = 250000) => typeof value === "string" && value.length <= max;
const strings = (value, max = 1000) => Array.isArray(value) && value.length <= max && value.every(item => text(item));
const keys = (value, required, optional = []) => object(value) && required.every(key => Object.hasOwn(value, key)) &&
  Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const headings = value => Array.isArray(value) && value.length <= 100 && value.every(item =>
  keys(item, ["level", "text"]) && Number.isInteger(item.level) && item.level >= 1 && item.level <= 6 && text(item.text) && item.text.trim());
const encodeContext = value => JSON.stringify(value).replace(/\s/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);

function publicUrl(value) {
  if (typeof value !== "string") fail("invalid_source_identity");
  const parsed = normalizePublicHttpUrl(value);
  if (parsed.href !== value || parsed.port) fail("invalid_source_identity");
  return value;
}

function validateContext(context, finalUrl) {
  if (!keys(context, ["blocks", "links", "base_hrefs"]) || !strings(context.base_hrefs, 100) ||
      !Array.isArray(context.blocks) || !context.blocks.length || context.blocks.length > 10000 ||
      !Array.isArray(context.links) || context.links.length > 10000) fail("invalid_context");
  for (const block of context.blocks) {
    if (!keys(block, ["kind", "text", "heading_path", "list_path", "table_row"], ["table_cell", "details_path", "sibling_button_path"]) ||
        !text(block.kind, 40) || !block.kind || !text(block.text) || !block.text.trim() ||
        !headings(block.heading_path) || !strings(block.list_path) || !strings(block.table_row)) fail("invalid_block");
    if (Object.hasOwn(block, "details_path") && (!strings(block.details_path, 100) || !block.details_path.length)) fail("invalid_block");
    if (Object.hasOwn(block, "sibling_button_path") && (!strings(block.sibling_button_path, 100) || !block.sibling_button_path.length ||
        block.sibling_button_path.some(value => !text(value, 10000) || !value.trim()))) fail("invalid_block");
    if (Object.hasOwn(block, "table_cell") && (!object(block.table_cell) ||
        Object.keys(block.table_cell).some(key => !text(key, 100)) ||
        !Object.values(block.table_cell).every(value => text(value, 10000) ||
          (Number.isInteger(value) && value >= 0 && value <= 65534)))) fail("invalid_table_context");
  }
  for (const link of context.links) {
    if (!keys(link, ["text", "raw_href", "source_url", "base_hrefs", "heading_path", "list_path"], ["details_path", "sibling_button_path"]) ||
        !text(link.text) || !text(link.raw_href, 10000) || link.source_url !== finalUrl ||
        !equal(link.base_hrefs, context.base_hrefs) || !headings(link.heading_path) || !strings(link.list_path)) fail("invalid_link_context");
    if (Object.hasOwn(link, "details_path") && (!strings(link.details_path, 100) || !link.details_path.length)) fail("invalid_link_context");
    if (Object.hasOwn(link, "sibling_button_path") && (!strings(link.sibling_button_path, 100) || !link.sibling_button_path.length ||
        link.sibling_button_path.some(value => !text(value, 10000) || !value.trim()))) fail("invalid_link_context");
  }
}

/** Parse only the exact, bounded, whitespace-escaped adapter format; no guessing or truncation. */
export function parseScraplingReviewText(value, { finalUrl, maxArtifactBytes = MAX_ARTIFACT_BYTES } = {}) {
  if (!Number.isInteger(maxArtifactBytes) || maxArtifactBytes < 1 || maxArtifactBytes > MAX_ARTIFACT_BYTES) fail("invalid_limits");
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maxArtifactBytes + 1) fail("artifact_size_limit");
  publicUrl(finalUrl);
  const normalized = normalizeVisibleText(value);
  const delimiter = `\n\n${MARKER}\n\n`;
  const offset = normalized.lastIndexOf(delimiter);
  if (offset < 1) fail("missing_context_marker");
  const prose = normalized.slice(0, offset);
  const encoded = normalized.slice(offset + delimiter.length);
  let context;
  try { context = JSON.parse(encoded); } catch { fail("malformed_context_json"); }
  validateContext(context, finalUrl);
  if (encodeContext(context) !== encoded) fail("noncanonical_context_encoding");
  if (!prose.trim()) fail("missing_prose");
  return { prose, context, text_hash: hash(normalized), artifact_sha256: hash(value) };
}

function identities({ source, baseline, previous, capture }) {
  const profile = capture?.capture_profile;
  if (!source?.id || !source.shared_award_id || ![PROFILE, SOURCE_HTML_PROFILE].includes(profile) || baseline?.capture_profile !== profile) {
    fail("capture_profile_mismatch");
  }
  publicUrl(source.url);
  for (const metadata of [baseline, capture, ...(previous?.meta ? [previous.meta] : [])]) {
    if (metadata?.source?.id !== source.id || metadata.source.shared_award_id !== source.shared_award_id ||
        metadata.source.url !== source.url) fail("source_identity_mismatch");
    if (metadata.capture_profile !== profile) fail("capture_profile_mismatch");
  }
  publicUrl(baseline.final_url);
  publicUrl(capture.final_url);
  if (baseline.final_url !== capture.final_url) fail("final_url_changed_requires_baseline_review");
  const earlier = Date.parse(baseline.captured_at), later = Date.parse(capture.captured_at);
  if (!Number.isFinite(earlier) || !Number.isFinite(later) || later <= earlier) fail("capture_order_invalid");
  if (previous?.meta && (previous.meta.final_url !== baseline.final_url || previous.meta.captured_at !== baseline.captured_at ||
      previous.meta.text_hash !== baseline.text_hash)) fail("previous_metadata_mismatch");
  if (!/^[a-f0-9]{64}$/.test(baseline.text_hash || "") || !/^[a-f0-9]{64}$/.test(capture.text_hash || "")) fail("missing_text_integrity");
}

function sourceMainEvidence(metadata, html, retainedText, source) {
  const record = validateSourceHtmlEvidence(metadata, { html, source });
  if (normalizeVisibleText(retainedText) !== sourceHtmlReviewText(record)) fail("source_html_review_text_mismatch");
  if (metadata.page_title !== record.html_document.title) fail("source_html_title_binding_mismatch");
  const context = Object.fromEntries(["blocks", "links", "base_hrefs"].map(key => [key, record.html_document[key]]));
  validateContext(context, record.final_url);
  // The main-element parser intentionally has no document <head>. Bind title
  // identity to the full response, not a fabricated title on the main fragment.
  return { title: flow(record.html_document.title), text: flow(record.source_main_document.text),
    sha256: record.integrity.source_main_document_sha256, record,
    parsed: { prose: normalizeVisibleText([record.html_document.title, record.html_document.text].join("\n\n")),
      context, text_hash: hash(normalizeVisibleText(retainedText)), artifact_sha256: hash(retainedText) } };
}

// Gravity Forms varies this bot-trap label between requests. Recognize only
// its exact retained controls outside main; never infer CSS visibility or
// discard other form content. The full raw response remains evidence.
function gravityFormsHoneypot(html) {
  const $ = load(html);
  const marked = $(".gfield--type-honeypot, .gform_validation_container");
  if (marked.length !== 1) return null;
  const field = marked.first(), form = field.closest("form");
  if (!field.is("li.gfield.gfield--type-honeypot.gform_validation_container") || form.length !== 1 ||
      field.parents().filter((_, node) => node.name === "main" || node.attribs?.role?.trim().toLowerCase() === "main").length ||
      field.children().length !== 3) return null;
  const match = /^field_([1-9]\d*)_([1-9]\d*)$/.exec(field.attr("id") || "");
  if (!match || form.attr("id") !== `gform_${match[1]}` || form.attr("data-formid") !== match[1] ||
      form.attr("method")?.toLowerCase() !== "post") return null;
  const label = field.children("label.gfield_label.gform-field-label"), wrapper = field.children("div.ginput_container"),
    description = field.children("div.gfield_description"), input = wrapper.children("input");
  if (label.length !== 1 || label.children().length || wrapper.length !== 1 || wrapper.children().length !== 1 ||
      input.length !== 1 || field.find("input,select,textarea,button").length !== 1 ||
      description.length !== 1 || description.children().length || flow(description.text()) !== HONEYPOT_DESCRIPTION ||
      description.attr("id") !== `gfield_description_${match[1]}_${match[2]}` ||
      input.attr("type") !== "text" || input.attr("name") !== `input_${match[2]}` ||
      input.attr("id") !== `input_${match[1]}_${match[2]}` || label.attr("for") !== input.attr("id") ||
      input.attr("value") !== "" || input.attr("autocomplete") !== "new-password") return null;
  const labelText = label.text();
  if (!labelText || labelText !== flow(labelText) || labelText.length > 80) return null;
  const normalizedField = field.clone();
  normalizedField.children("label").text("AWARDPING_HONEYPOT_LABEL");
  return { text: `${labelText} ${HONEYPOT_DESCRIPTION}`, label: labelText,
    markup: $.html(normalizedField), form: form[0].attribs };
}

function onlyOutsideMainHoneypotLabelChanged(previous, current) {
  if (!equal(previous.record.source_main_document, current.record.source_main_document)) return false;
  const before = previous.record.html_document, after = current.record.html_document;
  if (before.blocks.length !== after.blocks.length) return false;
  const changed = before.blocks.map((block, index) => ({ before: block, after: after.blocks[index], index }))
    .filter(pair => !equal(pair.before, pair.after));
  if (changed.length !== 1) return false;
  const oldTrap = gravityFormsHoneypot(previous.record.html), newTrap = gravityFormsHoneypot(current.record.html);
  if (!oldTrap || !newTrap || oldTrap.label === newTrap.label || oldTrap.markup !== newTrap.markup ||
      !equal(oldTrap.form, newTrap.form)) return false;
  const pair = changed[0];
  if (pair.before.kind !== "li" || pair.before.text !== oldTrap.text || pair.after.text !== newTrap.text ||
      !equal(withoutBlockText(pair.before), withoutBlockText(pair.after)) ||
      blockOccurrenceCount(before.blocks, oldTrap.text) !== 1 || blockOccurrenceCount(after.blocks, newTrap.text) !== 1) return false;
  const oldMatch = occurrence(before.text, oldTrap.text), newMatch = occurrence(after.text, newTrap.text);
  if (oldMatch.count !== 1 || newMatch.count !== 1 ||
      !substitutionsExplain(before.text, after.text, [{ start: oldMatch.start, oldLength: oldTrap.text.length, text: newTrap.text }])) return false;
  const restored = { ...after, text: before.text,
    blocks: after.blocks.map((block, index) => index === pair.index ? { ...block, text: pair.before.text } : block) };
  // Raw response sizes can differ; bind each size to its own retained bytes.
  // All other document counters and every other field must remain identical.
  if (Object.hasOwn(before, "counts") || Object.hasOwn(after, "counts")) {
    if (!object(before.counts) || !object(after.counts) ||
        before.counts.html_bytes !== Buffer.byteLength(previous.record.html) ||
        after.counts.html_bytes !== Buffer.byteLength(current.record.html)) return false;
    restored.counts = { ...after.counts, html_bytes: before.counts.html_bytes };
  }
  return equal(restored, before);
}

function cloudflareEmailTokens(html) {
  const $ = load(html), rows = [], seen = new Set();
  const path = node => { const parts = []; for (let n = node; n.parent; n = n.parent)
    parts.unshift(`${n.name || n.type}:${n.parent.children.indexOf(n)}`); return parts.join("/"); };
  const decode = hex => {
    if (!/^(?:[a-fA-F0-9]{2}){2,256}$/.test(hex || "")) return null;
    const bytes = Buffer.from(hex, "hex"), decoded = Buffer.from(bytes.subarray(1).map(value => value ^ bytes[0]));
    if (!decoded.every(value => value >= 33 && value <= 126)) return null;
    const address = decoded.toString("ascii");
    return /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/.test(address) ? address : null;
  };
  let valid = true;
  $("*").each((_, node) => {
    const element = $(node), attrs = node.attribs || {}, href = attrs.href;
    const marker = Object.entries(attrs).some(([key, value]) => key === "data-cfemail" ||
      value.includes("/cdn-cgi/l/email-protection") || (key === "class" && value.split(/\s+/).includes("__cf_email__")));
    if (!marker) return;
    const target = typeof href === "string" && /^\/cdn-cgi\/l\/email-protection#([a-fA-F0-9]+)$/.exec(href);
    const kind = target ? "target" : "display", hex = target ? target[1] : attrs["data-cfemail"], address = decode(hex);
    const row = { path: path(node), kind, raw: hex, href: href || null, address, node,
      inMain: element.parents("main").length === 1, text: flow(element.text()), attrs: { ...attrs } };
    rows.push(row);
    if (!address || seen.has(`${kind}:${address}`) ||
        Object.entries(attrs).some(([key, value]) => value.includes("/cdn-cgi/l/email-protection") && key !== "href") ||
        (target && (node.name !== "a" || Object.hasOwn(attrs, "data-cfemail") || !row.text ||
          element.children().length > 1 || (element.children().length === 1 && !element.children().is("span.__cf_email__[data-cfemail]")))) ||
        (!target && (node.name !== "span" || !element.hasClass("__cf_email__") || element.children().length ||
          element.parent().prop("tagName") !== "A" || !/^\/cdn-cgi\/l\/email-protection#[a-fA-F0-9]+$/.test(element.parent().attr("href") || "")))) valid = false;
    seen.add(`${kind}:${address}`);
  });
  const signature = rows.map(({ node: _node, ...row }) => row);
  if (valid) {
    for (const [index, row] of rows.entries()) $(row.node).attr(row.kind === "target" ? "href" : "data-cfemail", `PROVEN_CF_${row.kind}_${index}`);
    for (const row of rows) row.structure = $.html(row.node);
  }
  return { rows, signature, valid };
}

// This is the existing retained-semantic comparison boundary, not raw DOM
// equality. Opaque form values/classes are not modeled by either path. Only
// structurally proven CF tokens may explain ordered retained-link differences.
function sourceCloudflareEmailChange(previous, current) {
  const before = cloudflareEmailTokens(previous.record.html), after = cloudflareEmailTokens(current.record.html);
  if (equal(before.signature, after.signature)) return { changed: false };
  if (!before.valid || !after.valid || !before.rows.length || before.rows.length !== after.rows.length) return { changed: true, only: false };
  for (const [index, old] of before.rows.entries()) {
    const now = after.rows[index];
    if (old.path !== now.path || old.kind !== now.kind || old.address !== now.address || old.inMain !== now.inMain || old.structure !== now.structure) return { changed: true, only: false };
  }
  for (const key of ["html_document", "source_main_document"]) {
    const old = previous.record[key], now = current.record[key], main = key === "source_main_document";
    if (old.links.length !== now.links.length) return { changed: true, only: false };
    const replacements = new Map();
    for (const [index, token] of before.rows.entries()) {
      if (token.kind !== "target") continue;
      const next = after.rows[index], expected = main && !token.inMain ? 0 : 1;
      const oldIndices = old.links.flatMap((link, i) => link.raw_href === token.href && flow(link.text) === token.text ? [i] : []);
      const newIndices = now.links.flatMap((link, i) => link.raw_href === next.href && flow(link.text) === next.text ? [i] : []);
      if (oldIndices.length !== expected || newIndices.length !== expected || !equal(oldIndices, newIndices)) return { changed: true, only: false };
      if (expected) replacements.set(newIndices[0], token.href);
    }
    const restored = { ...now, links: now.links.map((link, index) => replacements.has(index) ? { ...link, raw_href: replacements.get(index) } : link) };
    if (!main && (Object.hasOwn(old, "counts") || Object.hasOwn(now, "counts"))) {
      if (!object(old.counts) || !object(now.counts) || old.counts.html_bytes !== Buffer.byteLength(previous.record.html) ||
          now.counts.html_bytes !== Buffer.byteLength(current.record.html)) return { changed: true, only: false };
      restored.counts = { ...now.counts, html_bytes: old.counts.html_bytes };
    }
    if (!equal(restored, old)) return { changed: true, only: false };
  }
  return { changed: true, only: true };
}

function withoutBlockText(block) {
  return Object.fromEntries(Object.entries(block).filter(([key]) => key !== "text"));
}

function isBlockReordering(a, b) {
  if (equal(a, b)) return false;
  const oldKeys = a.map(item => JSON.stringify(item)), newKeys = b.map(item => JSON.stringify(item));
  // A pure permutation, including repeated blocks, is not added/removed prose.
  if (equal([...oldKeys].sort(), [...newKeys].sort())) return true;
  const newSet = new Set(newKeys);
  const common = new Set(oldKeys.filter(key => newSet.has(key)));
  return !equal(oldKeys.filter(key => common.has(key)), newKeys.filter(key => common.has(key)));
}

function visibleProseEvidence(metadata, { maxArtifactBytes }) {
  const visible = metadata?.scrapling?.visible_text;
  const sha256 = metadata?.scrapling?.visible_text_sha256;
  const title = metadata?.scrapling?.visible_title;
  if (metadata?.scrapling?.visible_text_scope !== "whole-visible-main-document" ||
      typeof title !== "string" || title.length > 250000 ||
      typeof visible !== "string" || !visible.trim() || Buffer.byteLength(visible, "utf8") > maxArtifactBytes ||
      !/^[a-f0-9]{64}$/.test(sha256 || "")) return { reason: "visible_prose_evidence_unavailable" };
  // The exact same-capture native text must be sealed in metadata. A normalized
  // prose match alone must never excuse a broken raw-text integrity binding.
  if (hash(visible) !== sha256) return { reason: "visible_text_integrity_unverified" };
  return { title: flow(title), text: flow(visible), sha256 };
}

// Match complete supplied block/label text, preserving case and punctuation.
// Token boundaries prevent a prefix/suffix inside a larger token from matching.
// Stop at two: ambiguous occurrences are never selected or set-deduplicated.
function occurrence(haystack, needle) {
  if (!needle) return { count: 0, start: -1 };
  const padded = ` ${haystack} `, target = ` ${needle} `;
  let count = 0, start = -1, cursor = 0;
  while (count < 2) {
    const found = padded.indexOf(target, cursor);
    if (found < 0) break;
    count += 1;
    if (start < 0) start = found;
    cursor = found + 1;
  }
  return { count, start };
}

function blockOccurrenceCount(blocks, needle) {
  let count = 0;
  for (const block of blocks) {
    count += occurrence(flow(block.text), needle).count;
    if (count > 1) return 2;
  }
  return count;
}

function htmlBody(prose, metadata) {
  if (typeof metadata?.page_title !== "string") return null;
  const title = normalizeVisibleText(metadata.page_title);
  const prefix = title ? `${title}\n\n` : "";
  if (!prose.startsWith(prefix)) return null;
  return { title: flow(title), text: flow(prose.slice(prefix.length)) };
}

function contextCorroborated(block, body, visible, sourceMatch, visibleMatch) {
  // A source FAQ question cannot be silently detached from its answer. Empty,
  // ambiguous or differently ordered contexts stay held rather than guessing.
  const anchors = [...block.heading_path.map(heading => heading.text), ...(block.details_path || []), ...(block.sibling_button_path || []),
    ...block.list_path, ...block.table_row].map(flow);
  let sourceStart = sourceMatch.start, visibleStart = visibleMatch.start;
  let previousSourceEnd = -1, previousVisibleEnd = -1;
  for (const [index, anchor] of anchors.entries()) {
    const sourceAnchor = occurrence(body, anchor), visibleAnchor = occurrence(visible, anchor);
    if (sourceAnchor.count !== 1 || visibleAnchor.count !== 1 ||
        sourceAnchor.start < previousSourceEnd || visibleAnchor.start < previousVisibleEnd ||
        sourceAnchor.start + anchor.length > sourceMatch.start ||
        visibleAnchor.start + anchor.length > visibleMatch.start) return false;
    if (index === 0) { sourceStart = sourceAnchor.start; visibleStart = visibleAnchor.start; }
    previousSourceEnd = sourceAnchor.start + anchor.length;
    previousVisibleEnd = visibleAnchor.start + anchor.length;
  }
  // Tie the complete ordered context to THIS occurrence. Merely finding a U.S.
  // label elsewhere on a page cannot corroborate a paragraph under International.
  return body.slice(sourceStart, sourceMatch.start + flow(block.text).length) ===
    visible.slice(visibleStart, visibleMatch.start + flow(block.text).length);
}

function substitutionsExplain(before, after, replacements) {
  let cursor = 0, result = "";
  for (const replacement of replacements) {
    if (replacement.start < cursor) return false;
    result += before.slice(cursor, replacement.start) + replacement.text;
    cursor = replacement.start + replacement.oldLength;
  }
  return result + before.slice(cursor) === after;
}

// Recognize only complete, explicitly labeled countdown blocks. This is a
// manual hold, never evidence that an award deadline stayed the same. Dates,
// amounts, additional sentences, changed labels and day-only durations do not
// qualify. Keep spelling/case/punctuation exact when comparing both sides.
function countdownBlock(value) {
  const normalized = flow(value);
  if (normalized.length > 180) return null;
  const prefix = /^(?:Application closes|Applications close) in:? /i;
  if (!prefix.test(normalized)) return null;
  const body = normalized.replace(prefix, "").replace(/\.$/, "");
  let pairs;
  if (/^\d{1,6} (?:days?|hours?|minutes?|seconds?)(?:(?:,? (?:and )?)\d{1,6} (?:days?|hours?|minutes?|seconds?)){0,3}$/i.test(body)) {
    pairs = [...body.matchAll(/(\d{1,6}) (days?|hours?|minutes?|seconds?)/gi)].map(match => [match[2], Number(match[1])]);
  } else if (/^Days \d{1,6} Hours \d{1,6} Minutes \d{1,6} Seconds \d{1,6}$/i.test(body)) {
    pairs = [...body.matchAll(/(Days|Hours|Minutes|Seconds) (\d{1,6})/gi)].map(match => [match[1], Number(match[2])]);
  } else if (/^Days\d{1,6} Hours\d{1,6} Minutes\d{1,6}(?: Seconds\d{1,6})?$/i.test(body)) {
    // SMART's retained native text joins each label to its number. Recognize
    // only the complete ordered timer, still a manual hold, never accepted noise.
    pairs = [...body.matchAll(/(Days|Hours|Minutes|Seconds)(\d{1,6})/gi)].map(match => [match[1], Number(match[2])]);
  } else return null;
  const units = ["day", "hour", "minute", "second"], seconds = [86400, 3600, 60, 1];
  let previousUnit = -1, duration = 0;
  for (const [label, value] of pairs) {
    const unit = units.indexOf(label.toLowerCase().replace(/s$/, ""));
    if (unit <= previousUnit || (previousUnit >= 0 && value >= (unit === 1 ? 24 : 60))) return null;
    previousUnit = unit;
    duration += value * seconds[unit];
  }
  if (previousUnit < 2) return null;
  return { template: normalized.replace(/\d+/g, "#"), duration };
}

function onlyCountdownBlocksChanged(changed) {
  return changed.every(pair => {
    const before = countdownBlock(pair.before.text), after = countdownBlock(pair.after.text);
    return before && after && before.template === after.template && after.duration < before.duration;
  });
}

function visibleBlockChanges(before, after, previousVisible, currentVisible, previousMeta, capture) {
  const oldBody = htmlBody(before.prose, previousMeta), newBody = htmlBody(after.prose, capture);
  if (!oldBody || !newBody) return { reason: "html_title_binding_unavailable" };
  if (oldBody.title !== newBody.title || previousVisible.title !== currentVisible.title ||
      oldBody.title !== previousVisible.title || newBody.title !== currentVisible.title) return { reason: "title_change_requires_manual_review" };
  const changed = before.context.blocks.map((block, index) => ({ index, before: block, after: after.context.blocks[index] }))
    .filter(pair => flow(pair.before.text) !== flow(pair.after.text));
  if (!changed.length) return { reason: "prose_change_has_no_complete_changed_block" };
  if (changed.length > MAX_CHANGED_BLOCKS) return { reason: "complete_changed_blocks_exceed_review_bound" };
  const bodyReplacements = [], visibleReplacements = [];
  let lastNewBodyEnd = -1, lastNewVisibleEnd = -1;
  for (const pair of changed) {
    const oldText = flow(pair.before.text), newText = flow(pair.after.text);
    const oldSource = occurrence(oldBody.text, oldText), newSource = occurrence(newBody.text, newText);
    const oldVisible = occurrence(previousVisible.text, oldText), newVisible = occurrence(currentVisible.text, newText);
    if (oldSource.count !== 1 || newSource.count !== 1 ||
        blockOccurrenceCount(before.context.blocks, oldText) !== 1 || blockOccurrenceCount(after.context.blocks, newText) !== 1) {
      return { reason: "changed_block_source_occurrence_ambiguous" };
    }
    if (oldVisible.count !== 1 || newVisible.count !== 1) return { reason: "changed_block_not_uniquely_visible" };
    if (occurrence(currentVisible.text, oldText).count || occurrence(previousVisible.text, newText).count) {
      return { reason: "changed_block_already_present_on_opposite_side" };
    }
    if (!contextCorroborated(pair.before, oldBody.text, previousVisible.text, oldSource, oldVisible) ||
        !contextCorroborated(pair.after, newBody.text, currentVisible.text, newSource, newVisible)) {
      return { reason: "changed_block_context_not_uniquely_visible" };
    }
    if (newSource.start < lastNewBodyEnd || newVisible.start < lastNewVisibleEnd) return { reason: "changed_block_occurrence_order_ambiguous" };
    lastNewBodyEnd = newSource.start + newText.length;
    lastNewVisibleEnd = newVisible.start + newText.length;
    bodyReplacements.push({ start: oldSource.start, oldLength: oldText.length, text: newText });
    visibleReplacements.push({ start: oldVisible.start, oldLength: oldText.length, text: newText });
  }
  if (!substitutionsExplain(oldBody.text, newBody.text, bodyReplacements)) return { reason: "unexplained_full_source_prose_change" };
  if (!substitutionsExplain(previousVisible.text, currentVisible.text, visibleReplacements)) return { reason: "unexplained_visible_prose_change" };
  return { changed };
}

function exactProseRange(prose, value) {
  const needle = normalizeVisibleText(value);
  if (!needle) return null;
  let found = null, cursor = 0;
  while (cursor <= prose.length) {
    const start = prose.indexOf(needle, cursor);
    if (start < 0) break;
    const end = start + needle.length;
    if ((start === 0 || /\s/.test(prose[start - 1])) && (end === prose.length || /\s/.test(prose[end]))) {
      if (found) return null;
      found = { start, end };
    }
    cursor = start + 1;
  }
  return found;
}

// Pack unchanged context once, not into selected excerpts. Verify the complete
// previous normalized prose and structured context can actually be restored.
// Raw original artifacts remain separately retained and integrity-bound.
function losslessSharedContext(before, after, changed) {
  const replacements = [];
  for (const [changeIndex, pair] of changed.entries()) {
    const range = exactProseRange(after.prose, pair.after.text);
    if (!range) return null;
    replacements.push({ change_index: changeIndex, current_start: range.start, current_end: range.end,
      previous_text: normalizeVisibleText(pair.before.text) });
  }
  if (!substitutionsExplain(after.prose, before.prose, replacements.map(item => ({ start: item.current_start,
    oldLength: item.current_end - item.current_start, text: item.previous_text })))) return null;
  const oldTextByIndex = new Map(changed.map(pair => [pair.index, pair.before.text]));
  const restoredContext = { ...after.context, blocks: after.context.blocks.map((block, index) => oldTextByIndex.has(index)
    ? { ...block, text: oldTextByIndex.get(index) } : block) };
  if (!equal(restoredContext, before.context)) return null;
  return { version: 3, representation: "lossless_shared_context",
    source_context_complete: true, change_accounting_complete: true,
    previous_source_prose_included: false, previous_source_prose_reconstructable: true,
    previous_prose_replacement_offsets: "utf16_code_units_into_current_source_prose",
    previous_prose_replacements: replacements,
    previous_source_prose_sha256: hash(before.prose), current_source_prose_sha256: hash(after.prose),
    previous_context_sha256: hash(JSON.stringify(before.context)), current_context_sha256: hash(JSON.stringify(after.context)),
    reconstruction: "Restore previous prose by replacing current_source_prose ranges in order with previous_text. Restore previous context by replacing current_context.blocks[changed_block_indices[i]].text with removed_text[i]. All other prose and context are unchanged. Current source context is complete, not a selected excerpt; neither source context asserts visibility or current award validity." };
}

// This is dictionary/row storage, not semantic deduplication: every original
// block, link, path item, duplicate and property order is restored exactly.
// Full current prose and exact changed blocks remain plain text in the packet.
function losslessContextTables(before, after, changed) {
  const packed = { schema: "awardping.scrapling-context-tables.v1", context_fields: Object.keys(after.context),
    strings: [], heading_paths: [], string_lists: [] };
  const maps = { strings: new Map(), heading_paths: new Map(), string_lists: new Map() };
  const intern = (value, entries, map) => {
    const key = JSON.stringify(value);
    if (!map.has(key)) {
      if (entries.length >= MAX_CONTEXT_TABLE_ENTRIES) throw new Error("context_table_limit");
      map.set(key, entries.length); entries.push(value);
    }
    return map.get(key);
  };
  const string = value => intern(value, packed.strings, maps.strings);
  const list = values => intern(values.map(string), packed.string_lists, maps.string_lists);
  const heading = values => intern(values.map(item => Object.fromEntries(Object.entries(item)
    .map(([key, value]) => [key, key === "text" ? string(value) : value]))), packed.heading_paths, maps.heading_paths);
  const listFields = ["list_path", "table_row", "details_path", "sibling_button_path", "base_hrefs"];
  const encodeValue = (key, value) => key === "kind" || key === "table_cell" ? value :
    key === "heading_path" ? heading(value) : listFields.includes(key) ? list(value) : string(value);
  const rows = items => {
    const table = { field_orders: [], rows: [] }, fieldMap = new Map();
    for (const item of items) table.rows.push([intern(Object.keys(item), table.field_orders, fieldMap),
      ...Object.entries(item).map(([key, value]) => encodeValue(key, value))]);
    return table;
  };
  try {
    packed.blocks = rows(after.context.blocks);
    packed.links = rows(after.context.links);
    packed.base_hrefs = list(after.context.base_hrefs);
    if (Buffer.byteLength(JSON.stringify(packed), "utf8") > MAX_ARTIFACT_BYTES) return null;
    const at = (entries, index) => {
      if (!Number.isInteger(index) || index < 0 || index >= entries.length) throw new Error("invalid_context_table_index");
      return entries[index];
    };
    const decodeList = index => at(packed.string_lists, index).map(value => at(packed.strings, value));
    const decodeHeading = index => at(packed.heading_paths, index).map(item => Object.fromEntries(Object.entries(item)
      .map(([key, value]) => [key, key === "text" ? at(packed.strings, value) : value])));
    const decodeValue = (key, value) => key === "kind" || key === "table_cell" ? value :
      key === "heading_path" ? decodeHeading(value) : listFields.includes(key) ? decodeList(value) : at(packed.strings, value);
    const decodeRows = table => table.rows.map(row => {
      const fields = at(table.field_orders, row[0]);
      if (row.length !== fields.length + 1) throw new Error("invalid_context_table_row");
      return Object.fromEntries(fields.map((field, index) => [field, decodeValue(field, row[index + 1])]));
    });
    const decoded = Object.fromEntries(packed.context_fields.map(field => [field,
      field === "base_hrefs" ? decodeList(packed.base_hrefs) : decodeRows(packed[field])]));
    if (!equal(decoded, after.context)) return null;
    const oldTextByIndex = new Map(changed.map(pair => [pair.index, pair.before.text]));
    const restored = { ...decoded, blocks: decoded.blocks.map((block, index) => oldTextByIndex.has(index)
      ? { ...block, text: oldTextByIndex.get(index) } : block) };
    if (!equal(restored, before.context)) return null;
    return packed;
  } catch {
    // No partial tables, guessed indices, or silently discarded context.
    return null;
  }
}

/**
 * No legacy sentence/noise heuristics are used. Queue only complete bounded prose
 * same-index block substitutions with unchanged relationships, unique complete
 * source/visible occurrences and corroborated local context. Every source and
 * visible prose change must be explained; hidden/ambiguous text stays on hold.
 */
export function buildScraplingReviewDiff(input = {}, {
  maxArtifactBytes = MAX_ARTIFACT_BYTES, maxDiffBytes = MAX_DIFF_BYTES, maxProseChars = MAX_PROSE_CHARS,
} = {}) {
  const base = { publishable: false, baseline_advance_allowed: false, scope: "html-source-main-document",
    visibility_verified: false, screenshot_alignment: "not_verified", accuracy_benchmark: false };
  try {
    if (!Number.isInteger(maxDiffBytes) || maxDiffBytes < 128 || maxDiffBytes > MAX_DIFF_BYTES ||
        !Number.isInteger(maxProseChars) || maxProseChars < 1 || maxProseChars > MAX_PROSE_CHARS) fail("invalid_limits");
    identities(input);
    const { source, baseline, previous, capture } = input;
    const sourceOnly = capture.capture_profile === SOURCE_HTML_PROFILE;
    // Source-only evidence is validated even when comparison text is unchanged.
    // It is not native visible text, and can never authorize a screenshot claim.
    const sourcePair = sourceOnly ? [
      sourceMainEvidence(previous?.meta, previous?.html, previous?.text, source),
      sourceMainEvidence(capture, capture.html, capture.text, source),
    ] : null;
    const before = sourceOnly ? sourcePair[0].parsed : parseScraplingReviewText(previous?.text, { finalUrl: baseline.final_url, maxArtifactBytes });
    const after = sourceOnly ? sourcePair[1].parsed : parseScraplingReviewText(capture.text, { finalUrl: capture.final_url, maxArtifactBytes });
    if (before.text_hash !== baseline.text_hash || after.text_hash !== capture.text_hash) fail("text_integrity_mismatch");
    const fields = ["prose", "blocks", "links", "base_hrefs"].filter(key =>
      !equal(key === "prose" ? before.prose : before.context[key], key === "prose" ? after.prose : after.context[key]));
    const evidence = { source_id: source.id, award_id: source.shared_award_id, source_url: source.url, final_url: capture.final_url,
      previous_captured_at: baseline.captured_at, current_captured_at: capture.captured_at,
      previous_text_hash: before.text_hash, current_text_hash: after.text_hash,
      previous_artifact_sha256: before.artifact_sha256, current_artifact_sha256: after.artifact_sha256 };
    if (sourceOnly) Object.assign(evidence, { capture_profile: SOURCE_HTML_PROFILE,
      previous_html_sha256: sourcePair[0].record.integrity.html_sha256,
      current_html_sha256: sourcePair[1].record.integrity.html_sha256,
      previous_source_main_sha256: sourcePair[0].sha256, current_source_main_sha256: sourcePair[1].sha256 });
    const cf = sourceOnly ? sourceCloudflareEmailChange(...sourcePair) : null;
    if (cf?.only) return { ...base, status: "unchanged", reason: "source_semantics_cloudflare_email_only", fields, evidence,
      retain_both_captures: true, raw_dom_equality_verified: false,
      limitations: ["Equality covers complete retained source semantics and proven Cloudflare email representations; unmodeled raw form state, classes and other attributes are not compared."] };
    if (cf?.changed) return { ...base, status: "manual_review_required", reason: "cloudflare_email_change_requires_review", fields, evidence,
      retain_both_captures: true, diff: null };
    if (!fields.length) {
      if (sourceOnly && sourcePair[0].record.integrity.main_document_sha256 !== sourcePair[1].record.integrity.main_document_sha256) {
        return { ...base, status: "manual_review_required", reason: "source_main_semantics_changed",
          fields, evidence, retain_both_captures: true, diff: null };
      }
      return { ...base, status: "unchanged", reason: "complete_semantics_equal", fields, evidence };
    }
    if (sourceOnly && onlyOutsideMainHoneypotLabelChanged(...sourcePair)) {
      return { ...base, status: "unchanged", reason: "gravity_forms_honeypot_label_only", fields, evidence,
        retain_both_captures: true };
    }
    const manual = reason => ({ ...base, status: "manual_review_required", reason, fields, evidence,
      retain_both_captures: true, diff: null,
      instructions: "Keep both exact retained captures. Do not use sentence-noise rejection, publish a change, or advance the baseline." });
    if (!fields.includes("prose")) return manual("structural_only_change");
    if (fields.includes("links") || fields.includes("base_hrefs")) return manual("link_or_base_context_changed");
    if (before.context.blocks.length !== after.context.blocks.length || isBlockReordering(before.context.blocks, after.context.blocks)) {
      return manual("block_order_or_multiplicity_changed");
    }
    if (!equal(before.context.blocks.map(withoutBlockText), after.context.blocks.map(withoutBlockText))) return manual("structural_relationship_changed");
    const needsSharedContext = before.prose.length > maxProseChars || after.prose.length > maxProseChars;
    const previousVisible = sourceOnly ? sourcePair[0] : visibleProseEvidence(previous?.meta, { maxArtifactBytes });
    const currentVisible = sourceOnly ? sourcePair[1] : visibleProseEvidence(capture, { maxArtifactBytes });
    if (previousVisible.reason) return manual(`previous_${previousVisible.reason}`);
    if (currentVisible.reason) return manual(`current_${currentVisible.reason}`);
    const screenshotPairing = [previous?.meta?.scrapling?.screenshot?.semantics_bracketed,
      capture.scrapling?.screenshot?.semantics_bracketed];
    // The existing publication path can show a generic full-image fallback but
    // cannot disclose primary-HTML/supplementary-image semantic mismatches yet.
    // Retain those captures without queueing; true is not a geometry claim.
    if (!sourceOnly && screenshotPairing.includes(false)) return manual("supplementary_screenshot_semantics_changed");
    if (!sourceOnly && screenshotPairing.some(value => value !== true)) return manual("supplementary_screenshot_pairing_unverified");
    const visibleChanges = visibleBlockChanges(before, after, previousVisible, currentVisible, previous?.meta, capture);
    if (visibleChanges.reason) return manual(sourceOnly ? visibleChanges.reason.replaceAll("visible", "source_main") : visibleChanges.reason);
    if (sourceOnly) {
      const oldMain = sourcePair[0].record.source_main_document, newMain = sourcePair[1].record.source_main_document;
      const oldContext = Object.fromEntries(["blocks", "links", "base_hrefs"].map(key => [key, oldMain[key]]));
      const newContext = Object.fromEntries(["blocks", "links", "base_hrefs"].map(key => [key, newMain[key]]));
      validateContext(oldContext, baseline.final_url);
      validateContext(newContext, capture.final_url);
      if (!equal(oldMain.links, newMain.links) || !equal(oldMain.base_hrefs, newMain.base_hrefs) ||
          !equal(oldMain.blocks.map(withoutBlockText), newMain.blocks.map(withoutBlockText))) {
        return manual("source_main_relationship_changed");
      }
      const mainChanged = oldMain.blocks.map((block, index) => [block.text, newMain.blocks[index].text])
        .filter(([oldText, newText]) => flow(oldText) !== flow(newText));
      if (!equal(mainChanged, visibleChanges.changed.map(pair => [pair.before.text, pair.after.text]))) {
        return manual("source_main_changed_blocks_mismatch");
      }
    }
    if (visibleChanges.changed.reduce((total, pair) => total + pair.before.text.length, 0) > maxProseChars ||
        visibleChanges.changed.reduce((total, pair) => total + pair.after.text.length, 0) > maxProseChars) {
      return manual("complete_changed_prose_exceeds_review_bound");
    }
    if (!sourceOnly) {
      evidence.previous_visible_text_sha256 = previousVisible.sha256;
      evidence.current_visible_text_sha256 = currentVisible.sha256;
    }
    if (onlyCountdownBlocksChanged(visibleChanges.changed)) return manual("countdown_only_change_requires_manual_review");
    const diff = {
      candidate_scope: "scrapling_html_source", source_context: { award_name: source.shared_awards?.name || null,
        source_title: source.title || null, source_url: source.url, page_type: source.page_type || null },
      added_text: visibleChanges.changed.map(pair => pair.after.text), removed_text: visibleChanges.changed.map(pair => pair.before.text),
      date_changes: [], amount_changes: [],
      likely_section: "Award source content", changed_text_excerpt: "Only complete changed blocks are listed; full before/current source prose and context are retained separately.",
      previous_text_length: before.prose.length, new_text_length: after.prose.length,
      text_length_delta: after.prose.length - before.prose.length,
      scrapling_semantics: { version: 2, fields, complete: true, visibility_verified: false,
        visible_prose_corroborated: !sourceOnly,
        ...(sourceOnly ? { acquisition: "ordinary_anonymous_http", capture_profile: SOURCE_HTML_PROFILE,
          source_main_prose_corroborated: true,
          source_main_prose_rule: "unique_complete_changed_blocks_with_ordered_source_main_context",
          screenshot_available: false } : { visible_prose_rule: "unique_complete_changed_blocks_with_ordered_visible_context" }),
        screenshot_alignment: "not_verified", evidence,
        previous_source_prose: before.prose, current_source_prose: after.prose,
        changed_block_indices: visibleChanges.changed.map(pair => pair.index),
        previous_context: before.context, current_context: after.context,
        caution: sourceOnly
          ? "These are complete changes in official HTTP HTML source, uniquely corroborated within its main element and full body with ordered context. No browser visibility, screenshot, client-loaded content or form journey was verified. Hidden or stale source content can still exist. Review the complete named-award, audience, cycle and exception context; reject uncertainty. Structural context is not a source quotation."
          : "Only the complete changed blocks are uniquely corroborated in native visible text with ordered context. Other full HTML source context may be hidden or stale. This is not proof of current award facts or screenshot coordinates. Review the named award, audience and cycle; structural context is not a source quotation." },
    };
    const compactBound = Math.min(maxDiffBytes, COMPACT_DIFF_BYTES);
    if (needsSharedContext || Buffer.byteLength(JSON.stringify(diff), "utf8") > compactBound) {
      const shared = losslessSharedContext(before, after, visibleChanges.changed);
      if (!shared) return manual("lossless_shared_context_reconstruction_failed");
      delete diff.scrapling_semantics.previous_source_prose;
      delete diff.scrapling_semantics.previous_context;
      Object.assign(diff.scrapling_semantics, shared);
      diff.changed_text_excerpt = "Complete changed blocks are listed. Full current source prose/context is included once; all previous values can be reconstructed from exact replacements. Original before/current artifacts remain retained.";
    }
    if (Buffer.byteLength(JSON.stringify(diff), "utf8") > compactBound) {
      const tables = losslessContextTables(before, after, visibleChanges.changed);
      if (!tables) return manual("lossless_context_table_reconstruction_failed");
      delete diff.scrapling_semantics.current_context;
      Object.assign(diff.scrapling_semantics, { version: 4, representation: "lossless_context_tables",
        current_context_tables: tables, context_table_reconstruction_verified: true,
        context_table_decoding: "All indices are zero-based. Each blocks/links row starts with its field_orders index; remaining values follow those named fields. kind and table_cell are literal. text, raw_href and source_url index strings. heading_path indexes heading_paths, whose heading text indexes strings. list_path, table_row, details_path, sibling_button_path and base_hrefs index string_lists, whose entries index strings. context_fields preserves root property order; field_orders preserves row property order and optional-field presence. Rows and path items remain ordered and duplicates are retained. No text was omitted or shortened.",
        reconstruction: "Decode current_context_tables to the complete current context. Restore previous context by replacing decoded blocks[changed_block_indices[i]].text with removed_text[i]. Restore previous prose using the exact previous_prose_replacements in the complete current_source_prose. Verify the retained full-context/prose SHA256 values. Full original artifacts remain retained; neither this storage format nor source context asserts visibility, screenshot coordinates or current award validity." });
    }
    if (Buffer.byteLength(JSON.stringify(diff), "utf8") > maxDiffBytes) return manual("complete_diff_exceeds_review_bound");
    return { ...base, status: "changed_needs_review", reason: "complete_bounded_prose_change", fields, evidence, diff,
      visible_prose_corroborated: !sourceOnly,
      ...(sourceOnly ? { source_main_prose_corroborated: true, screenshot_available: false } : {}),
      deterministic: { classification: "candidate_change", reason: "scrapling_complete_prose_change_requires_review",
        candidate_change: true, comparison_basis: "html-source-main-document", evidence_complete: true },
      retain_both_captures: true };
  } catch (error) {
    return { ...base, status: "unavailable", reason: error?.scraplingReason || "invalid_evidence", retain_both_captures: true, diff: null };
  }
}
