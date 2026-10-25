import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fetchPublicHttpBuffer } from "./public-network-safety.mjs";
import { captureScraplingSource, scraplingCaptureProfile } from "./scrapling-capture.mjs";
import { extractProgramTextPdfOcr } from "./program-text-ocr.mjs";
import { fetchProgramTextBrowserPdf } from "./program-text-browser.mjs";

import { buildProgramTextCapture, programTextCaptureLimits, programTextCaptureInternals } from "./program-text-capture-contract.mjs";
export { PROGRAM_TEXT_CAPTURE_SCHEMA, PROGRAM_TEXT_CAPTURE_PROFILE, programTextCaptureLimits,
  buildProgramTextCapture, validateProgramTextCapture, blocksFromHtmlDocument } from "./program-text-capture-contract.mjs";
const { hash, fail, utf8, publicUrl, sourceIdentity, isAcquisition, htmlProjection, htmlCompleteness,
  pdfTextProjection, checkFinalUrl } = programTextCaptureInternals;

function processJson(executable, args, input, timeoutMs, maxBytes = programTextCaptureLimits.textBytes) {
  return new Promise((resolve, reject) => {
    const environment = Object.fromEntries(["SystemRoot", "WINDIR", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "PATH", "COMSPEC", "PATHEXT"]
      .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
    environment.PYTHONUTF8 = "1"; environment.PYTHONDONTWRITEBYTECODE = "1";
    const child = spawn(executable, args, { shell: false, windowsHide: true, env: environment, stdio: ["pipe", "pipe", "pipe"] });
    let chunks = [], size = 0, stopped = null, killing = null;
    const stop = reason => {
      stopped ||= reason;
      if (killing || !child.pid) return;
      killing = process.platform === "win32" ? new Promise(done => {
        const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        killer.once("error", () => { child.kill(); done(); }); killer.once("close", done);
      }) : Promise.resolve(child.kill("SIGKILL"));
    };
    const timer = setTimeout(() => stop("extractor_timeout"), timeoutMs);
    child.stdout.on("data", bytes => { size += bytes.length; if (size > maxBytes) { chunks = []; stop("extractor_output_limit"); } else if (!stopped) chunks.push(bytes); });
    child.stderr.on("data", () => {}); child.stdin.on("error", () => {});
    child.once("error", () => { clearTimeout(timer); reject(Object.assign(new Error("Program text extractor failed to start"), { code: "program_text_extractor_start" })); });
    child.once("close", async code => {
      clearTimeout(timer); await killing;
      try { if (stopped) fail(stopped); if (code !== 0) fail("extractor_failed"); const result = JSON.parse(utf8(Buffer.concat(chunks))); if (result.error) fail("extractor_failed"); resolve(result); }
      catch (error) { reject(error); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

async function extractHtml(raw, finalUrl, { pythonPath, timeoutMs }) {
  if (!pythonPath) fail("python_runtime_required");
  return processJson(pythonPath, ["-B", fileURLToPath(new URL("../scrapling/html_document.py", import.meta.url))],
    { html: utf8(raw), url: finalUrl, capture_profile: "scrapling-evidence-v2" }, timeoutMs);
}
async function extractPdf(raw, timeoutMs) {
  return processJson(process.execPath, [fileURLToPath(new URL("./program-text-pdf-worker.mjs", import.meta.url))],
    { pdf_base64: raw.toString("base64"), max_pages: programTextCaptureLimits.pages }, timeoutMs);
}
/** One explicit acquisition mode per source; no automatic browser/OCR fallback. */
export async function captureProgramTextSource({ source, acquisition = source?.page_type === "pdf" ? "pdf_text" : "http_html",
  pythonPath, executablePath, timeoutMs = programTextCaptureLimits.processTimeoutMs, allowedFinalUrls = [], pdf_transport = "http", ocrOptions = {}, adapters = {} } = {}) {
  sourceIdentity(source);
  if (!isAcquisition(acquisition) || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120_000 ||
      !Array.isArray(allowedFinalUrls) || allowedFinalUrls.length > 20) fail("invalid_capture_options");
  if (!["http", "browser"].includes(pdf_transport) || pdf_transport === "browser" && acquisition !== "pdf_text") fail("invalid_pdf_transport");
  allowedFinalUrls.forEach(publicUrl);
  const started = Date.now();
  const remaining = () => { const value = timeoutMs - (Date.now() - started); if (value < 1) fail("capture_timeout"); return value; };
  if (acquisition === "rendered_html") {
    const record = await (adapters.renderedHtml || captureScraplingSource)(source,
      { pythonPath, executablePath, timeoutMs: remaining(), captureProfile: scraplingCaptureProfile });
    if (record.capture_profile !== scraplingCaptureProfile || record.screenshot || record.status_code !== 200 || typeof record.html !== "string") fail("invalid_rendered_adapter");
    checkFinalUrl(source, record.final_url, allowedFinalUrls);
    const raw = Buffer.from(record.html);
    if (raw.length > programTextCaptureLimits.htmlBytes) fail("html_size_limit");
    const document = await (adapters.htmlExtraction || extractHtml)(raw, record.final_url, { pythonPath, timeoutMs: remaining() });
    const capture = buildProgramTextCapture({ source, final_url: record.final_url, captured_at: record.captured_at, acquisition,
      extractor: { name: "scrapling-full-body-html", version: "program-text-v1/html-document-v2" }, raw_bytes: raw,
      content_type: record.content_type, ...htmlProjection(document), completeness: htmlCompleteness(document, record) });
    remaining(); return capture;
  }
  const isPdf = acquisition.startsWith("pdf_");
  const fetched = pdf_transport === "browser" ? await (adapters.browserPdfFetch || fetchProgramTextBrowserPdf)(source.url,
    { executablePath, timeoutMs: remaining(), maxBytes: programTextCaptureLimits.pdfBytes, allowedFinalUrls }) : await (adapters.fetch || fetchPublicHttpBuffer)(source.url, {
    timeoutMs: remaining(), maxBytes: isPdf ? programTextCaptureLimits.pdfBytes : programTextCaptureLimits.htmlBytes, maxRedirects: 5,
    init: { headers: { "user-agent": "AwardPing/1.0 (+https://awardping.com)", accept: isPdf ? "application/pdf" : "text/html, application/xhtml+xml" } } });
  if (fetched.status !== 200 || !Buffer.isBuffer(fetched.buffer)) fail("source_unavailable", { http_status: fetched.status });
  checkFinalUrl(source, fetched.finalUrl, allowedFinalUrls);
  const raw = fetched.buffer, captured_at = new Date().toISOString();
  if (raw.length < 1 || raw.length > (isPdf ? programTextCaptureLimits.pdfBytes : programTextCaptureLimits.htmlBytes)) fail("source_size_limit");
  if (!isPdf) {
    if (!/^(text\/html|application\/xhtml\+xml)(;|$)/i.test(fetched.contentType || "")) fail("invalid_html_content_type");
    const declared = /charset\s*=\s*["']?([^\s;"']+)/i.exec(fetched.contentType || "");
    if (declared && !["utf-8", "utf8"].includes(declared[1].toLowerCase())) fail("unsupported_html_encoding");
    const html = utf8(raw);
    if (/(?:AwsWafIntegration|awswaf\.integration|cf-chl-|<title>\s*(?:Access Denied|Just a moment|403 Forbidden))/i.test(html)) fail("upstream_challenge");
    const document = await (adapters.htmlExtraction || extractHtml)(raw, fetched.finalUrl, { pythonPath, timeoutMs: remaining() });
    const capture = buildProgramTextCapture({ source, final_url: fetched.finalUrl, captured_at, acquisition,
      extractor: { name: "scrapling-full-body-html", version: "program-text-v1/html-document-v2" }, raw_bytes: raw,
      content_type: fetched.contentType, ...htmlProjection(document), completeness: htmlCompleteness(document) });
    remaining(); return capture;
  }
  if (!/^application\/pdf(?:;|$)/i.test(fetched.contentType || "") || !raw.subarray(0, 1024).includes(Buffer.from("%PDF-"))) fail("invalid_pdf");
  const result = acquisition === "pdf_ocr" ? await (adapters.ocrExtraction || extractProgramTextPdfOcr)(raw, { ...ocrOptions, timeoutMs: remaining(), pdf_sha256: hash(raw) })
    : await (adapters.pdfExtraction || extractPdf)(raw, remaining());
  if (acquisition === "pdf_ocr" && result?.pdf_sha256 !== hash(raw)) fail("ocr_original_binding_mismatch");
  const capture = buildProgramTextCapture({ source, final_url: fetched.finalUrl, captured_at, acquisition,
    extractor: { name: acquisition === "pdf_ocr" ? "page-indexed-pdf-ocr" : "pdf-parse", version: acquisition === "pdf_ocr" ? String(result.engine_version || "unverified") :
      pdf_transport === "browser" ? "2.4.5/program-text-v1/browser-pdf-v1" : "2.4.5/program-text-v1" },
    raw_bytes: raw, content_type: fetched.contentType, ...pdfTextProjection(result, { ocr: acquisition === "pdf_ocr" }) });
  remaining(); return capture;
}
