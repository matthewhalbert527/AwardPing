import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, realpathSync, readFileSync, lstatSync, existsSync } from "node:fs";
import { join, relative, isAbsolute } from "node:path";
import sharp from "sharp";
import { captureScraplingSource, validateScraplingCapture } from "./scrapling-capture.mjs";
import { normalizeVisibleText } from "./capture-stability.mjs";
import { normalizePublicHttpUrl } from "./public-network-safety.mjs";
import { renderedHtmlCaptureSchema, maxRenderedHtmlBytes } from "./rendered-html-capture.mjs";
import { expansionStateCaptureCoverage, expansionStateCaptureCoverageLegacyMirrors } from "./expansion-state-descriptor-canonicalization.mjs";
import { SOURCE_HTML_PROFILE, sourceHtmlEvidence, sourceHtmlArtifactProjection,
  sourceHtmlReviewText, validateSourceHtmlEvidence } from "./source-html-evidence.mjs";

export const SCRAPLING_WORKER_PROFILE = "scrapling-evidence-v1";
export const SCRAPLING_SOURCE_MANIFEST_SCHEMA = "awardping.scrapling-source-manifest.v1";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const textHash = (value) => sha256(normalizeVisibleText(value));
const fail = (reason) => { throw new Error(`Scrapling worker: ${reason}`); };

/** An exact URL/UUID opt-in. Neither an award match nor a redirect grants scope. */
export function validateScraplingSourceManifest(value) {
  if (value?.schema !== SCRAPLING_SOURCE_MANIFEST_SCHEMA || value?.profile !== SCRAPLING_WORKER_PROFILE ||
      !Array.isArray(value.sources) || !value.sources.length || value.sources.length > 300 ||
      !Array.isArray(value.award_ids) || value.award_ids.length !== 25 || new Set(value.award_ids).size !== 25 ||
      value.award_ids.some(id => !uuid.test(id)) || !Number.isFinite(Date.parse(value.reviewed_at))) fail("invalid source manifest");
  const ids = new Set();
  const urls = new Set();
  for (const row of value.sources) {
    if (!uuid.test(row?.id) || ids.has(row.id) || !value.award_ids.includes(row.award_id) ||
        typeof row.url !== "string" || normalizePublicHttpUrl(row.url).href !== row.url || new URL(row.url).port ||
        row.kind !== "html" || (row.capture_profile !== undefined && ![SCRAPLING_WORKER_PROFILE, SOURCE_HTML_PROFILE].includes(row.capture_profile)) ||
        (row.capture_profile === SOURCE_HTML_PROFILE && !row.url.startsWith("https://")) || !Array.isArray(row.roles) || !row.roles.length ||
        row.roles.some(role => typeof role !== "string" || !/^[a-z_]{1,60}$/.test(role)) ||
        urls.has(`${row.award_id}\n${row.url}`)) fail("invalid or duplicate source manifest entry");
    ids.add(row.id);
    urls.add(`${row.award_id}\n${row.url}`);
  }
  return value;
}

export function loadScraplingSourceManifest(path) {
  if (!path) return null;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) fail("invalid manifest file");
  return validateScraplingSourceManifest(JSON.parse(readFileSync(path, "utf8")));
}

export function selectScraplingSource(source, manifest) {
  if (!manifest) return null;
  const row = manifest.sources.find(entry => entry.id === source?.id);
  if (!row) return null;
  if (row.award_id !== source.shared_award_id || row.url !== source.url || source.page_type === "pdf") {
    fail("live source identity differs from reviewed manifest");
  }
  return row;
}

/** No parser change, URL move or rollback may be mistaken for an award change. */
export function assertScraplingBaselineCompatibility(baseline, { useScrapling, captureProfile = SCRAPLING_WORKER_PROFILE, baselineRefresh = false } = {}) {
  if (!baseline) return;
  if (useScrapling && ![SCRAPLING_WORKER_PROFILE, SOURCE_HTML_PROFILE].includes(captureProfile)) fail("invalid capture profile");
  const previousIsScrapling = [SCRAPLING_WORKER_PROFILE, SOURCE_HTML_PROFILE].includes(baseline.capture_profile);
  if ((previousIsScrapling !== Boolean(useScrapling) || (useScrapling && baseline.capture_profile !== captureProfile)) && !baselineRefresh) {
    fail("capture profile transition requires an explicit baseline-only maintenance run; old evidence is preserved");
  }
}

/** Full context is evidence, not a current-fact assertion. Do not drop hidden text. */
export function scraplingReviewText(document) {
  if (document?.schema !== "awardping.scrapling-html-document.v1" || typeof document.text !== "string") fail("HTML document missing");
  const context = { blocks: document.blocks, links: document.links, base_hrefs: document.base_hrefs };
  const text = normalizeVisibleText([
    document.title,
    document.text,
    "HTML source context and link attributes (may include hidden or stale content; not screenshot locations):",
    // The legacy text hash normalizes whitespace. Escape it inside raw attributes
    // so distinct destinations/context cannot collapse to the same evidence.
    JSON.stringify(context).replace(/\s/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`),
  ].join("\n\n"));
  if (Buffer.byteLength(text, "utf8") > 6 * 1024 * 1024) fail("review evidence too large");
  return text;
}

/** Retain a validated Scrapling bundle in the existing screenshot/text/HTML contract. */
export async function captureScraplingWorkerSource(source, {
  archiveRoot, pythonPath, executablePath, timeoutMs = 90000,
  capture = captureScraplingSource, captureProfile = SCRAPLING_WORKER_PROFILE,
} = {}) {
  if (!uuid.test(source?.id) || !uuid.test(source?.shared_award_id)) fail("invalid source identity");
  if (![SCRAPLING_WORKER_PROFILE, SOURCE_HTML_PROFILE].includes(captureProfile)) fail("invalid capture profile");
  const root = realpathSync(archiveRoot);
  const record = validateScraplingCapture(await capture(source, { pythonPath, executablePath, timeoutMs,
    captureProfile }), { source });
  if (record.capture_profile !== captureProfile) fail("collector profile mismatch");
  if (captureProfile === SOURCE_HTML_PROFILE) return retainSourceHtmlCapture(source, record, root);
  if (record.capture_profile !== SCRAPLING_WORKER_PROFILE || !record.html_document || !record.screenshot) fail("production evidence unavailable");
  const text = scraplingReviewText(record.html_document);
  const page = Buffer.from(record.screenshot.base64, "base64");
  if (sha256(page) !== record.screenshot.sha256 || page.length !== record.screenshot.byte_length) fail("screenshot binding mismatch");
  const image = sharp(page, { limitInputPixels: 80_000_000 });
  const imageInfo = await image.metadata();
  if (imageInfo.format !== "jpeg" || imageInfo.width !== record.screenshot.width || imageInfo.height !== record.screenshot.height) fail("screenshot dimensions mismatch");
  const thumbnail = await sharp(page, { limitInputPixels: 80_000_000 }).resize({ width: 640, withoutEnlargement: true }).jpeg({ quality: 75 }).toBuffer();
  let dir = root;
  for (const segment of ["sources", source.id, "captures", new Date(record.captured_at).toISOString().replace(/[:.]/g, "-")]) {
    dir = join(dir, segment);
    if (existsSync(dir)) {
      const stat = lstatSync(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail("capture directory escaped archive");
    } else mkdirSync(dir);
    const relDir = relative(root, realpathSync(dir));
    if (!relDir || relDir.startsWith("..") || isAbsolute(relDir)) fail("capture directory escaped archive");
  }
  const path = (name) => join(dir, name);
  const ref = (name) => relative(root, path(name)).replaceAll("\\", "/");
  const htmlCapture = {
    schema: renderedHtmlCaptureSchema, status: "captured", reason: null, representation: "rendered_dom",
    captured_at: record.captured_at, source_url: record.final_url, max_bytes: maxRenderedHtmlBytes,
    sha256: sha256(record.html), byte_length: Buffer.byteLength(record.html), screenshot_alignment: "not_verified",
  };
  const expansionCoverage = expansionStateCaptureCoverage({ capture_status: "skipped_profile",
    capture_complete: false, raw_candidate_count_exact: false, logical_candidate_count_exact: false,
  }, { retainedStateCount: 0 });
  const metadata = {
    version: 1, kind: "webpage", capture_behavior_version: 1, capture_behavior_name: SCRAPLING_WORKER_PROFILE,
    capture_profile: SCRAPLING_WORKER_PROFILE,
    source: { id: source.id, shared_award_id: source.shared_award_id, url: source.url,
      title: source.title || null, page_type: source.page_type || null,
      award_name: source.shared_awards?.name || null },
    captured_at: record.captured_at, final_url: record.final_url, page_title: record.html_document.title,
    status_code: record.status_code, status_text: "", text_hash: textHash(text),
    body_text_hash: textHash(text), main_content_hash: textHash(text), nav_header_footer_hash: null,
    expansion_hash: null, image_hash: record.screenshot.sha256, layout_hash: null,
    text_length: text.length, body_text_length: text.length, main_content_text_length: text.length,
    nav_header_footer_text_length: 0, expansion_text_length: 0, page_bytes: page.length, thumb_bytes: thumbnail.length,
    dimensions: { width: imageInfo.width, height: imageInfo.height }, browser: record.engine,
    page_readiness: record.readiness, page_settle: { stable: false, primary_html_semantics_stable: true,
      screenshot_semantics_bracketed: record.screenshot.semantics_bracketed,
      reason: "physical_layout_and_image_animation_not_independently_verified" }, html_capture: htmlCapture,
    localization: { status: "unavailable", reason: "scrapling_has_no_verified_screenshot_geometry" },
    text_geometry: null, hidden_noise_counts: {},
    expandable_section_extraction_enabled: false, expandable_sections_detected: 0, expandable_sections_extracted: 0,
    expandable_sections_hash: null, expansion_state_screenshots: [], expansion_state_count: 0,
    expansion_state_failures: [], expansion_state_capture_coverage: expansionCoverage,
    ...expansionStateCaptureCoverageLegacyMirrors(expansionCoverage),
    scrapling: { engine: record.engine, integrity: record.integrity, warnings: record.warnings, telemetry: record.telemetry,
      visible_title: record.document.title, visible_text: record.text, visible_text_sha256: sha256(record.text),
      visible_text_scope: "whole-visible-main-document",
      screenshot: Object.fromEntries(Object.entries(record.screenshot).filter(([key]) => key !== "base64")),
      evidence_scope: "html-source-main-document", visibility_verified: false,
      limitations: record.html_document.limitations, screenshot_alignment: "not_verified" },
    files: { page: ref("page.jpg"), thumb: ref("thumb.jpg"), text: ref("text.txt"),
      html: ref("page.html.txt"), meta: ref("meta.json"), layout: null, expansion_states: [] },
  };
  // Exclusive writes preserve any interrupted capture. Metadata is committed last.
  for (const [name, bytes] of [["page.jpg", page], ["thumb.jpg", thumbnail], ["text.txt", `${text}\n`], ["page.html.txt", record.html]]) {
    writeFileSync(path(name), bytes, { flag: "wx" });
  }
  writeFileSync(path("meta.json"), JSON.stringify(metadata, null, 2), { flag: "wx" });
  return { ...metadata, dir, page_path: path("page.jpg"), thumb_path: path("thumb.jpg"),
    text_path: path("text.txt"), html_path: path("page.html.txt"), meta_path: path("meta.json"),
    text, expansion_text_path: null, layout_path: null, sections_text_path: null, sections_json_path: null,
    expandable_sections: [], section_extraction: { sections: [], detected: 0, extracted: 0 },
    section_text_for_baseline_facts: "", section_text_length: 0,
    // Native resolved links support the existing PDF discovery gate; raw attributes stay in retained HTML.
    scrapling_discovered_links: record.html_links.map(link => ({ href: link.url, text: link.text,
      title: link.title, ariaLabel: link.aria_label, download: link.download, contextText: link.context,
      contextTruncated: link.context_truncated })),
  };
}

function retainSourceHtmlCapture(source, record, root) {
  const text = sourceHtmlReviewText(record);
  let dir = root;
  for (const segment of ["sources", source.id, "captures", new Date(record.captured_at).toISOString().replace(/[:.]/g, "-")]) {
    dir = join(dir, segment);
    if (existsSync(dir)) {
      const stat = lstatSync(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail("capture directory escaped archive");
    } else mkdirSync(dir);
    const relDir = relative(root, realpathSync(dir));
    if (!relDir || relDir.startsWith("..") || isAbsolute(relDir)) fail("capture directory escaped archive");
  }
  const path = name => join(dir, name);
  const ref = name => relative(root, path(name)).replaceAll("\\", "/");
  const metadata = {
    version: 1, kind: "webpage", capture_behavior_version: 1, capture_behavior_name: SOURCE_HTML_PROFILE,
    capture_profile: SOURCE_HTML_PROFILE, source: { id: source.id, shared_award_id: source.shared_award_id,
      url: source.url, title: source.title || null, page_type: source.page_type || null,
      award_name: source.shared_awards?.name || null },
    captured_at: record.captured_at, final_url: record.final_url, page_title: record.html_document.title,
    status_code: record.status_code, content_type: record.content_type,
    text_hash: textHash(text), body_text_hash: textHash(text), main_content_hash: textHash(text),
    text_length: text.length, body_text_length: text.length, main_content_text_length: text.length,
    source_html: sourceHtmlEvidence(record), retained_artifact_projection: sourceHtmlArtifactProjection(),
    files: { text: ref("text.txt"), html: ref("page.html.txt"), meta: ref("meta.json") },
  };
  validateSourceHtmlEvidence(metadata, { html: record.html, source });
  for (const [name, bytes] of [["text.txt", `${text}\n`], ["page.html.txt", record.html], ["meta.json", JSON.stringify(metadata, null, 2)]])
    writeFileSync(path(name), bytes, { flag: "wx" });
  return { ...metadata, dir, text, html: record.html, text_path: path("text.txt"), html_path: path("page.html.txt"), meta_path: path("meta.json"),
    expandable_sections: [], section_extraction: { sections: [], detected: 0, extracted: 0 },
    section_text_for_baseline_facts: "", section_text_length: 0, scrapling_discovered_links: [] };
}
