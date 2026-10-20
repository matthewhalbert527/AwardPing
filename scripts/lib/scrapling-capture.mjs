import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { normalizePublicHttpUrl, startPublicNetworkProxy } from "./public-network-safety.mjs";
import { finalizeCaptureNetworkBoundary } from "./capture-resource-limits.mjs";

export const scraplingCaptureProfile = "scrapling-visible-v1";
export const scraplingEvidenceProfile = "scrapling-evidence-v1";
export const scraplingEvidenceProfileV2 = "scrapling-evidence-v2";
export const scraplingSourceHtmlProfile = "scrapling-source-html-v1";
const digest = (value) => createHash("sha256").update(value).digest("hex");
const fail = (reason) => { throw Object.assign(new Error(reason), { pilotReason: reason }); };
const isText = (value, max = 250000) => typeof value === "string" && value.length <= max;
const publicUrl = (value) => {
  const url = normalizePublicHttpUrl(value);
  if (url.port) fail("unsupported_port");
  return url.href;
};
const headingPath = (value) => Array.isArray(value) && value.length <= 100 && value.every((h) =>
  Number.isInteger(h?.level) && h.level >= 1 && h.level <= 6 && isText(h.text));
const textList = (value) => Array.isArray(value) && value.length <= 1000 && value.every((v) => isText(v));

function jpegDimensions(bytes) {
  if (bytes.length < 4 || bytes.readUInt16BE(0) !== 0xffd8 || bytes.readUInt16BE(bytes.length - 2) !== 0xffd9) fail("invalid_screenshot");
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 255) break;
    while (offset < bytes.length && bytes[offset] === 255) offset++;
    if (offset >= bytes.length) break;
    const marker = bytes[offset++];
    if ([0xd8, 0xd9, 0xda].includes(marker) || offset + 2 > bytes.length) break;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) break;
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (length < 8) break;
      return { width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3) };
    }
    offset += length;
  }
  fail("invalid_screenshot");
}

function validateHtmlDocument(doc, record, scope = "html-source-main-document") {
  if (doc?.schema !== "awardping.scrapling-html-document.v1" || doc.scope !== scope ||
      doc.source_url !== record.final_url || doc.publishable !== false || doc.visibility_verified !== false ||
      !isText(doc.title, 10000) || !isText(doc.text) || !doc.text.trim() || !textList(doc.limitations) ||
      !textList(doc.base_hrefs) || doc.base_hrefs.length > 100 ||
      !Array.isArray(doc.blocks) || !doc.blocks.length || doc.blocks.length > 10000 ||
      !Array.isArray(doc.links) || doc.links.length > 10000 ||
      Buffer.byteLength(JSON.stringify(doc), "utf8") > 5 * 1024 * 1024) fail("invalid_html_document");
  for (const block of doc.blocks) {
    if (!isText(block?.kind, 40) || !block.kind || !isText(block.text) || !block.text.trim() ||
        !headingPath(block.heading_path) || !textList(block.list_path) || !textList(block.table_row)) fail("invalid_html_block");
    if (Object.hasOwn(block, "details_path") && (!textList(block.details_path) || !block.details_path.length || block.details_path.length > 100)) fail("invalid_html_block");
    if (Object.hasOwn(block, "sibling_button_path") && (!textList(block.sibling_button_path) || !block.sibling_button_path.length || block.sibling_button_path.length > 100 ||
        block.sibling_button_path.some(value => !isText(value, 10000) || !value.trim()))) fail("invalid_html_block");
    if (Object.hasOwn(block, "table_cell") && (!block.table_cell || typeof block.table_cell !== "object" || Array.isArray(block.table_cell) ||
        !Object.values(block.table_cell).every((v) => isText(v, 10000) || (Number.isInteger(v) && v >= 0 && v <= 65534)))) fail("invalid_html_block");
  }
  for (const link of doc.links) {
    if (!isText(link?.text) || !isText(link.raw_href, 10000) || link.source_url !== doc.source_url ||
        JSON.stringify(link.base_hrefs) !== JSON.stringify(doc.base_hrefs) ||
        !headingPath(link.heading_path) || !textList(link.list_path)) fail("invalid_html_link");
    if (Object.hasOwn(link, "details_path") && (!textList(link.details_path) || !link.details_path.length || link.details_path.length > 100)) fail("invalid_html_link");
    if (Object.hasOwn(link, "sibling_button_path") && (!textList(link.sibling_button_path) || !link.sibling_button_path.length || link.sibling_button_path.length > 100 ||
        link.sibling_button_path.some(value => !isText(value, 10000) || !value.trim()))) fail("invalid_html_link");
  }
}

function validateEvidence(record) {
  const doc = record.html_document;
  validateHtmlDocument(doc, record);
  if (!Array.isArray(record.html_links) || record.html_links.length > 10000 ||
      Buffer.byteLength(JSON.stringify(record.html_links), "utf8") > 5 * 1024 * 1024) fail("invalid_html_discovery_links");
  for (const link of record.html_links) {
    if (!link || !["url", "raw_href", "base_url", "text", "title", "aria_label", "download"].every((key) => isText(link[key], 10000)) ||
        !["", "href", "xlink:href"].includes(link.href_attribute) || !isText(link.context, 800) ||
        typeof link.download_present !== "boolean" || typeof link.context_available !== "boolean" ||
        typeof link.context_truncated !== "boolean" || (!link.context_available && (link.context || link.context_truncated)) ||
        (!link.href_attribute && (link.url || link.raw_href))) fail("invalid_html_discovery_link");
    // Pure URL parsing, not navigation. Unsafe/non-HTTP links remain inert data for the discovery gate to reject.
    try { if (link.href_attribute && new URL(link.raw_href, link.base_url).href !== link.url) fail("invalid_html_discovery_link"); }
    catch { fail("invalid_html_discovery_link"); }
  }
  const shot = record.screenshot;
  const age = Date.parse(shot?.captured_at) - Date.parse(record.captured_at);
  if (shot?.schema !== "awardping.scrapling-screenshot.v1" || shot.mime_type !== "image/jpeg" ||
      shot.source_url !== record.final_url || shot.full_page !== true || shot.geometry_status !== "unavailable" ||
      shot.alignment !== "not_verified" || typeof shot.semantics_bracketed !== "boolean" || !textList(shot.limitations) ||
      !/^\d{4}-\d\d-\d\dT/.test(shot.captured_at || "") || !Number.isFinite(age) || age < 0 || age > 90000 ||
      !Number.isInteger(shot.width) || shot.width < 1 || shot.width > 4096 ||
      !Number.isInteger(shot.height) || shot.height < 1 || shot.height > 20000 || shot.width * shot.height > 25000000 ||
      !Number.isInteger(shot.byte_length) || shot.byte_length < 4 || shot.byte_length > 4 * 1024 * 1024 ||
      !isText(shot.base64, 4 * Math.ceil((4 * 1024 * 1024) / 3)) || !/^[A-Za-z0-9+/]*={0,2}$/.test(shot.base64)) fail("invalid_screenshot");
  // Earlier v1 captures with a strict matched bracket remain readable; new mismatches must be explicit and sealed.
  const mismatchFields = new Set(["visible.title", "visible.text", "visible.blocks", "visible.links", "html_source.title",
    "html_source.text", "html_source.blocks", "html_source.links", "html_source.base_hrefs", "discovery.links"]);
  if ((shot.semantic_mismatches === undefined) !== (shot.primary_html_captured_at === undefined)) fail("invalid_screenshot_mismatch");
  if (shot.semantic_mismatches !== undefined) {
    if (!Array.isArray(shot.semantic_mismatches) || shot.semantic_mismatches.length > mismatchFields.size ||
        new Set(shot.semantic_mismatches.map(item => item?.field)).size !== shot.semantic_mismatches.length ||
        shot.semantic_mismatches.some(item => !mismatchFields.has(item?.field) ||
          !/^[0-9a-f]{64}$/.test(item.before_sha256 || "") || !/^[0-9a-f]{64}$/.test(item.after_sha256 || "") ||
          item.before_sha256 === item.after_sha256 || !Number.isInteger(item.before_bytes) || item.before_bytes < 0 || item.before_bytes > 5 * 1024 * 1024 ||
          !Number.isInteger(item.after_bytes) || item.after_bytes < 0 || item.after_bytes > 5 * 1024 * 1024)) fail("invalid_screenshot_mismatch");
    if (shot.primary_html_captured_at !== record.captured_at || shot.semantics_bracketed !== (shot.semantic_mismatches.length === 0)) fail("invalid_screenshot_mismatch");
  }
  const mismatchWarning = record.warnings.includes("supplementary_screenshot_semantics_changed_not_aligned");
  if (!shot.semantics_bracketed && (!shot.semantic_mismatches?.length || !mismatchWarning || !shot.limitations.length)) fail("undisclosed_screenshot_mismatch");
  if (shot.semantics_bracketed && mismatchWarning) fail("invalid_screenshot_mismatch");
  const bytes = Buffer.from(shot.base64, "base64");
  if (bytes.length !== shot.byte_length || bytes.toString("base64") !== shot.base64 || digest(bytes) !== shot.sha256) fail("screenshot_integrity_mismatch");
  const dimensions = jpegDimensions(bytes);
  if (dimensions.width !== shot.width || dimensions.height !== shot.height) fail("screenshot_dimensions_mismatch");
  const metadata = Object.fromEntries(Object.entries(shot).filter(([key]) => key !== "base64"));
  return { html_document_sha256: digest(JSON.stringify(doc)), html_links_sha256: digest(JSON.stringify(record.html_links)), screenshot_sha256: digest(bytes),
    screenshot_metadata_sha256: digest(JSON.stringify(metadata)) };
}

function validateSourceHtmlCapture(record) {
  const allowed = new Set(["schema", "capture_profile", "source_id", "url", "final_url", "captured_at", "status_code",
    "content_type", "html", "html_document", "source_main_document", "source_http", "warnings", "engine", "integrity", "publishable"]);
  if (Object.keys(record).some(key => !allowed.has(key)) || record.status_code !== 200 ||
      !record.url.startsWith("https://") || record.final_url !== record.url ||
      (Object.hasOwn(record, "publishable") && record.publishable !== false)) fail("invalid_source_html_contract");
  if (!isText(record.html, 5 * 1024 * 1024) || Buffer.byteLength(record.html, "utf8") > 5 * 1024 * 1024 ||
      record.html.length < 20 || record.html.includes("\0") || Buffer.from(record.html, "utf8").toString("utf8") !== record.html) fail("invalid_capture_content");
  const charset = /charset\s*=\s*["']?([^\s;"']+)/i.exec(record.content_type);
  if (charset && !["utf-8", "utf8"].includes(charset[1].toLowerCase())) fail("source_html_unsupported_encoding");
  validateHtmlDocument(record.html_document, record);
  validateHtmlDocument(record.source_main_document, record, "html-source-main-element");
  if (record.source_main_document.text.trim().length < 200) fail("source_html_insufficient_main_text");
  const http = record.source_http;
  const httpKeys = ["schema", "method", "response_complete", "redirect_count", "body_encoding", "content_encoding",
    "body_byte_length", "body_sha256", "acquisition", "visibility_verified", "screenshot_available"];
  if (!http || Object.keys(http).length !== httpKeys.length || httpKeys.some(key => !Object.hasOwn(http, key)) ||
      http.schema !== "awardping.scrapling-source-http.v1" || http.method !== "GET" || http.response_complete !== true ||
      http.redirect_count !== 0 || http.body_encoding !== "utf-8" || http.content_encoding !== "identity" ||
      http.acquisition !== "ordinary_anonymous_http" || http.visibility_verified !== false || http.screenshot_available !== false ||
      http.body_byte_length !== Buffer.byteLength(record.html, "utf8") || http.body_sha256 !== digest(record.html)) fail("invalid_source_http_binding");
  const engine = record.engine;
  if (!engine || Object.keys(engine).length !== 5 || engine.scrapling !== "0.4.15" || engine.client !== "Fetcher" ||
      engine.adaptive !== false || engine.stealth !== false || engine.impersonation !== false || !textList(record.warnings) ||
      !record.warnings.includes("source_html_only_not_browser_visible_or_screenshot_evidence") ||
      !record.warnings.includes("linked_documents_forms_and_client_loaded_content_not_fetched")) fail("invalid_source_html_engine");
  const semantic = doc => Object.fromEntries(["title", "text", "blocks", "links", "base_hrefs"].map(key => [key, doc[key]]));
  const integrity = { html_sha256: digest(record.html), html_document_sha256: digest(JSON.stringify(record.html_document)),
    source_main_document_sha256: digest(JSON.stringify(record.source_main_document)), source_http_sha256: digest(JSON.stringify(http)),
    document_sha256: digest(JSON.stringify(semantic(record.html_document))),
    main_document_sha256: digest(JSON.stringify(semantic(record.source_main_document))) };
  if (record.integrity && (Object.keys(record.integrity).length !== Object.keys(integrity).length ||
      Object.entries(integrity).some(([key, value]) => record.integrity[key] !== value))) fail("capture_integrity_mismatch");
  if (Buffer.byteLength(JSON.stringify(record), "utf8") >= 24 * 1024 * 1024) fail("collector_output_limit");
  return { ...record, integrity, publishable: false };
}

/** Validate a collector record before retaining it. Does not authorize publishing. */
export function validateScraplingCapture(record, { source }) {
  if (!record || record.schema !== "awardping.scrapling-capture.v1" || ![scraplingCaptureProfile, scraplingEvidenceProfile, scraplingEvidenceProfileV2, scraplingSourceHtmlProfile].includes(record.capture_profile) ||
      !/^[A-Za-z0-9._-]{1,160}$/.test(record.source_id || "") ||
      record.source_id !== source?.id || record.url !== source?.url || publicUrl(record.url) !== source.url ||
      !Number.isInteger(record.status_code) || record.status_code < 200 || record.status_code >= 300 ||
      !/^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(record.content_type || "") ||
      !/^\d{4}-\d\d-\d\dT/.test(record.captured_at || "") || !Number.isFinite(Date.parse(record.captured_at))) fail("invalid_capture_identity");
  publicUrl(record.final_url);
  if (record.capture_profile === scraplingSourceHtmlProfile) return validateSourceHtmlCapture(record);
  if (!isText(record.html, 5 * 1024 * 1024) || Buffer.byteLength(record.html, "utf8") > 5 * 1024 * 1024 ||
      record.html.length < 20 || !isText(record.text) || record.text.trim().length < 40) fail("invalid_capture_content");
  if (!isText(record.visible_html, 5 * 1024 * 1024) || Buffer.byteLength(record.visible_html, "utf8") > 5 * 1024 * 1024 ||
      !record.visible_html.startsWith("<ap-document>")) fail("invalid_visible_projection");
  const ready = record.readiness;
  if (ready?.ready_state !== "complete" || ready.fonts_status !== "loaded" || ready.stable !== true ||
      !Number.isInteger(ready.samples) || ready.samples < 3 || !Number.isFinite(ready.stable_ms) || ready.stable_ms < 1000) fail("capture_not_ready");
  const doc = record.document;
  if (doc?.schema !== "awardping.scrapling-document.v1" || doc.scope !== "whole-visible-main-document" ||
      doc.text !== record.text || !isText(doc.title, 10000) ||
      !Array.isArray(doc.blocks) || !doc.blocks.length || doc.blocks.length > 10000 ||
      !Array.isArray(doc.links) || doc.links.length > 10000 || !textList(doc.limitations) ||
      !textList(record.warnings) || record.engine?.scrapling !== "0.4.15") fail("invalid_document");
  for (const block of doc.blocks) {
    if (!isText(block?.kind, 40) || !block.kind || !isText(block.text) || !block.text.trim() ||
        !headingPath(block.heading_path) || !textList(block.list_path) || !textList(block.table_row)) fail("invalid_block");
  }
  for (const link of doc.links) {
    if (!isText(link?.text) || !isText(link.url, 10000) || !link.url ||
        !headingPath(link.heading_path) || !textList(link.list_path)) fail("invalid_link");
  }
  if (Buffer.byteLength(JSON.stringify(doc), "utf8") > 5 * 1024 * 1024) fail("document_too_large");
  const semantic = { title: doc.title, text: doc.text, blocks: doc.blocks, links: doc.links };
  const integrity = { html_sha256: digest(record.html), visible_html_sha256: digest(record.visible_html), text_sha256: digest(record.text),
    document_sha256: digest(JSON.stringify(semantic)) };
  if ([scraplingEvidenceProfile, scraplingEvidenceProfileV2].includes(record.capture_profile)) Object.assign(integrity, validateEvidence(record));
  else if (Object.hasOwn(record, "screenshot") || Object.hasOwn(record, "html_document") || Object.hasOwn(record, "html_links")) fail("unexpected_evidence_profile");
  if (Buffer.byteLength(JSON.stringify(record), "utf8") >= 24 * 1024 * 1024) fail("collector_output_limit");
  if (record.integrity && Object.entries(integrity).some(([key, value]) => record.integrity[key] !== value)) fail("capture_integrity_mismatch");
  return { ...record, integrity, publishable: false };
}

/** Differences are review candidates, never an automatic assertion of award change. */
export function compareScraplingCaptures(previous, current) {
  const sourceOnly = current?.capture_profile === scraplingSourceHtmlProfile;
  const base = { publishable: false, scope: sourceOnly ? "observed_source_html_document" : "observed_visible_main_document", accuracy_benchmark: false };
  try {
    if (!previous?.integrity || !current?.integrity) fail("missing_capture_integrity");
    const a = validateScraplingCapture(previous, { source: { id: previous.source_id, url: previous.url } });
    const b = validateScraplingCapture(current, { source: { id: current.source_id, url: current.url } });
    if (a.source_id !== b.source_id || a.url !== b.url || a.final_url !== b.final_url) fail("source_mismatch");
    if (a.capture_profile !== b.capture_profile) fail("capture_profile_mismatch");
    if (Date.parse(a.captured_at) >= Date.parse(b.captured_at)) fail("capture_order_invalid");
    if (sourceOnly) {
      const limitations = [...new Set([...a.html_document.limitations, ...b.html_document.limitations,
        ...a.source_main_document.limitations, ...b.source_main_document.limitations, ...a.warnings, ...b.warnings])];
      const equal = a.integrity.document_sha256 === b.integrity.document_sha256 && a.integrity.main_document_sha256 === b.integrity.main_document_sha256;
      return { ...base, status: equal ? "unchanged" : "changed_needs_review", reason: equal ? "source_html_semantics_equal" : "source_html_semantics_differ",
        visibility_verified: false, screenshot_available: false, limitations,
        fields: equal ? [] : ["html_document", "source_main_document"].filter(key =>
          ["title", "text", "blocks", "links", "base_hrefs"].some(field => JSON.stringify(a[key][field]) !== JSON.stringify(b[key][field]))) };
    }
    const limitations = [...new Set([...a.document.limitations, ...b.document.limitations, ...a.warnings, ...b.warnings])];
    if (a.integrity.document_sha256 === b.integrity.document_sha256) return { ...base, status: "unchanged", reason: "observed_content_equal", limitations };
    const fields = ["title", "text", "blocks", "links"].filter((key) => JSON.stringify(a.document[key]) !== JSON.stringify(b.document[key]));
    // Full evidence remains in the capture records; no truncated excerpt is treated as a complete claim.
    return { ...base, status: "changed_needs_review", reason: "observed_content_differs", fields, limitations };
  } catch (error) {
    return { ...base, status: "unavailable", reason: error?.pilotReason || "invalid_capture" };
  }
}

/** Scrapling owns fetching/extraction; this small bridge retains the existing egress boundary. */
export async function captureScraplingSource(source, { pythonPath, executablePath, timeoutMs = 90000, captureProfile = scraplingCaptureProfile } = {}) {
  publicUrl(source.url);
  const sourceOnly = captureProfile === scraplingSourceHtmlProfile;
  if (!pythonPath || (!sourceOnly && !executablePath) || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000 ||
      ![scraplingCaptureProfile, scraplingEvidenceProfile, scraplingEvidenceProfileV2, scraplingSourceHtmlProfile].includes(captureProfile)) fail("invalid_runtime_options");
  if (sourceOnly && !source.url.startsWith("https://")) fail("source_html_https_identity_required");
  const maxBytes = (sourceOnly ? 6 : 60) * 1024 * 1024;
  const proxy = await startPublicNetworkProxy({ timeoutMs: 15000, maxResponseBytes: maxBytes });
  const checkpoint = proxy.policyCheckpoint();
  let result;
  let failure;
  try {
    result = await runCollectorProcess({ pythonPath, executablePath, source, proxyUrl: proxy.url, timeoutMs, captureProfile });
    result = validateScraplingCapture(result, { source });
    if (result.capture_profile !== captureProfile) fail("capture_profile_mismatch");
  } catch (error) { failure = error; }
  finally {
    try { await finalizeCaptureNetworkBoundary({ networkProxy: proxy, checkpoint, maxBytes, shutdownTimeoutMs: 5000 }); }
    catch { failure = Object.assign(new Error("network_boundary_rejected"), { pilotReason: "network_boundary_rejected" }); }
  }
  if (failure) throw failure;
  return result;
}

function runCollectorProcess({ pythonPath, executablePath, source, proxyUrl, timeoutMs, captureProfile }) {
  return new Promise((resolve, reject) => {
    const env = Object.fromEntries(["SystemRoot", "WINDIR", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "PATH", "COMSPEC", "PATHEXT"]
      .filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
    env.PYTHONUTF8 = "1";
    env.PYTHONDONTWRITEBYTECODE = "1";
    const child = spawn(pythonPath, ["-B", fileURLToPath(new URL("../scrapling/collector.py", import.meta.url))], {
      windowsHide: true, shell: false, env, stdio: ["pipe", "pipe", "pipe"],
    });
    let output = [];
    let bytes = 0;
    let reason;
    let killed;
    const stop = (why) => {
      reason ||= why;
      if (killed || !child.pid) return;
      // Kill only this exact spawned process tree; no user browser/session is attached.
      killed = process.platform === "win32" ? new Promise((done) => {
        const taskkill = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        taskkill.once("error", () => { child.kill(); done(); });
        taskkill.once("close", () => done());
      }) : Promise.resolve(child.kill("SIGKILL"));
    };
    const deadline = setTimeout(() => stop("capture_timeout"), timeoutMs);
    child.stdout.on("data", (data) => {
      bytes += data.length;
      if (bytes > 24 * 1024 * 1024) { output = []; stop("collector_output_limit"); }
      else if (!reason) output.push(data);
    });
    // Drain library logs without exposing page data, URLs with tokens or runtime environment.
    child.stderr.on("data", () => {});
    child.stdin.on("error", () => {});
    child.once("error", () => { clearTimeout(deadline); reject(Object.assign(new Error("collector_start_failed"), { pilotReason: "collector_start_failed" })); });
    child.once("close", async (code) => {
      clearTimeout(deadline);
      await killed;
      try {
        if (reason) fail(reason);
        const value = JSON.parse(Buffer.concat(output).toString("utf8"));
        if (value.error) fail(/^[a-z][a-z0-9_]{0,100}$/.test(value.error) ? value.error : "collector_failed");
        if (code !== 0) fail("collector_exit_failed");
        resolve(value);
      } catch (error) { reject(error?.pilotReason ? error : Object.assign(new Error("invalid_collector_output"), { pilotReason: "invalid_collector_output" })); }
    });
    child.stdin.end(JSON.stringify({ url: source.url, source_id: source.id, proxy_url: proxyUrl, executable_path: executablePath || "",
      ...(captureProfile !== scraplingCaptureProfile ? { capture_profile: captureProfile } : {}) }));
  });
}
