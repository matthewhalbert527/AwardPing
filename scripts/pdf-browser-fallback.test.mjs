import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workerSource = readFileSync(
  new URL("./capture-visual-snapshots.mjs", import.meta.url),
  "utf8",
);

function functionSource(name, nextName) {
  const start = workerSource.indexOf(`function ${name}(`);
  const end = workerSource.indexOf(`function ${nextName}(`, start + 1);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return workerSource.slice(start, end);
}

describe("PDF browser fallback wiring", () => {
  const fetchPdf = functionSource("fetchPdfSource", "fetchPdfViaBrowserFallback");
  const fallback = functionSource("fetchPdfViaBrowserFallback", "extractPdfText");
  const pdfCapture = functionSource("capturePdfSource", "pruneFailedPdfCaptureEvidence");
  const forBaseline = functionSource("capturePdfSourceForBaseline", "materializeSealedFirstObservationCapture");
  const acquire = functionSource("acquirePdfBrowserFallbackContext", "pdfFetchOptionsForWorker");
  const workerOptions = functionSource("pdfFetchOptionsForWorker", "processQueuedSource");
  const queued = workerSource.slice(
    workerSource.indexOf("async function processQueuedSource("),
    workerSource.indexOf("await maybeUpdateBaselineCoverageProgress(workerRunId, report, coverageSources);"),
  );

  it("keeps the pinned public fetch as the primary path and guards the body before parsing", () => {
    expect(fetchPdf).toContain('function fetchPdfSource(url, { browserFallback = null } = {})');
    expect(fetchPdf).toContain("await fetchPublicHttpBuffer(url, {");
    expect(fetchPdf).toContain("maxBytes: maxPdfBytes");
    expect(fetchPdf).toContain('"User-Agent": crawlerUserAgent');
    expect(fetchPdf).toContain("`PDF download failed with HTTP ${download.status} ${download.statusText}`.trim()");
    expect(fetchPdf).toContain("isPdfPayload({ contentType: download.contentType, buffer: download.buffer })");
    expect(fetchPdf).toContain("pdfDownloadNonPdfContentMessage(download.contentType)");
    // The primary fetch always runs first; the fallback is only reached after it.
    expect(fetchPdf.indexOf("await fetchPublicHttpBuffer(url, {"))
      .toBeLessThan(fetchPdf.indexOf("pdfDownloadFallbackReason({"));
    expect(fetchPdf.indexOf("pdfDownloadFallbackReason({"))
      .toBeLessThan(fetchPdf.indexOf("await fetchPdfViaBrowserFallback(url, browserFallback)"));
    expect(fetchPdf).toContain('return { ...download, fetchPath: "public_http_fetch", fallbackReason: null };');
  });

  it("only attempts the fallback for HTTP 403 or a non-PDF body, and only when the caller opted in", () => {
    expect(fetchPdf).toContain("const fallbackReason = browserFallback\n    ? pdfDownloadFallbackReason({");
    expect(fetchPdf).toContain("    : null;\n  if (!fallbackReason) throw primaryFailure;");
    // Exactly one fallback attempt, never a loop.
    expect(fetchPdf.match(/fetchPdfViaBrowserFallback\(/g)).toHaveLength(1);
    expect(fetchPdf).not.toContain("while (");
    expect(fetchPdf).not.toContain("for (");
  });

  it("throws the original error with the fallback outcome appended when the fallback fails", () => {
    expect(fetchPdf).toContain("`${primaryFailure.message} (browser fallback: ${errorMessage(error)})`");
    expect(fetchPdf).toContain("{ cause: primaryFailure }");
    expect(fallback).toContain("throw new Error(`HTTP ${status} ${statusText}`.trim());");
    expect(fallback).toContain("throw new Error(`non-PDF content (${cleanText(contentType) || \"unknown content-type\"})`);");
  });

  it("issues the fallback through the proxied Playwright context without bypassing the boundary", () => {
    expect(fallback).toContain("const context = await acquireContext();");
    expect(fallback).toContain("await context.request.get(url, {");
    expect(fallback).toContain('Accept: "application/pdf,application/octet-stream;q=0.9,*/*;q=0.5"');
    expect(fallback).toContain("maxRedirects: 5");
    expect(fallback).toContain("timeout: timeoutMs");
    expect(fallback).toContain("await response.dispose().catch(() => undefined);");
    // Never a private browser, standalone request context, or raw HTTP client.
    for (const region of [fetchPdf, fallback, acquire, workerOptions]) {
      expect(region).not.toContain("newContext(");
      expect(region).not.toContain("request.newContext");
      expect(region).not.toContain("chromium.launch");
      expect(region).not.toContain("launchBrowser(");
      expect(region).not.toContain("fetch(");
      expect(region).not.toContain("http.request");
      expect(region).not.toContain("https.request");
      expect(region).not.toContain("arrayBuffer(");
      expect(region).not.toContain('redirect: "follow"');
    }
    // The context is obtained only via the worker's proxied lifecycle helpers.
    expect(acquire).toContain('await restartBrowser(state, "pdf_browser_fallback");');
    expect(acquire).toContain('await restartCaptureContext(state, "pdf_browser_fallback");');
    expect(acquire).toContain("state.captureContextUsed = true;");
    expect(acquire).toContain("return state.context;");
    const contextLifecycle = functionSource("restartCaptureContext", "restartBrowser");
    expect(contextLifecycle).toContain("startPublicNetworkProxy({");
    expect(contextLifecycle).toContain("createBrowserContext(state.browser, networkProxy)");
  });

  it("accepts only a 2xx PDF payload within the PDF byte cap", () => {
    expect(fallback).toContain("if (status < 200 || status >= 300) {");
    expect(fallback).toContain("contentLength > maxPdfBytes");
    expect(fallback).toContain("const buffer = await response.body();");
    expect(fallback).toContain("if (buffer.length > maxPdfBytes) {");
    expect(fallback).toContain("if (!isPdfPayload({ contentType, buffer })) {");
    expect(fallback.indexOf("const buffer = await response.body();"))
      .toBeLessThan(fallback.indexOf("if (buffer.length > maxPdfBytes) {"));
    expect(fallback.indexOf("if (buffer.length > maxPdfBytes) {"))
      .toBeLessThan(fallback.indexOf("if (!isPdfPayload({ contentType, buffer })) {"));
    // Same return shape as fetchPublicHttpBuffer.
    for (const key of ["buffer,", "finalUrl: response.url()", "status,", "statusText,", "contentType,", "redirectCount:"]) {
      expect(fallback).toContain(key);
    }
    expect(fetchPdf).toContain('return { ...fallback, fetchPath: "browser_fallback", fallbackReason };');
  });

  it("records honest fetch provenance in meta.json and capture-failure.json", () => {
    const successMeta = pdfCapture.slice(
      pdfCapture.indexOf("const meta = {"),
      pdfCapture.indexOf("writeFileSync(metaPath, JSON.stringify(meta, null, 2)"),
    );
    const failureMeta = pdfCapture.slice(
      pdfCapture.indexOf("const failureMetadata = {"),
      pdfCapture.indexOf("writeFileSync(failureMetaPath"),
    );
    for (const region of [successMeta, failureMeta]) {
      expect(region).toContain("fetch_path: download.fetchPath,");
      expect(region).toContain("fallback_reason: download.fallbackReason,");
    }
    expect(pdfCapture).toContain("const download = await fetchPdfSource(source.url, pdfFetchOptions);");
  });

  it("defaults the fallback off and only the nightly queue lane passes worker state", () => {
    expect(pdfCapture).toContain("function capturePdfSource(source, pdfFetchOptions = null)");
    expect(forBaseline).toContain(
      "function capturePdfSourceForBaseline(source, baseline, report, pdfFetchOptions = null)",
    );
    expect(forBaseline).toContain("return capturePdfSource(source, pdfFetchOptions);");
    expect(forBaseline).toContain("return materializeSealedFirstObservationCapture(source, report);");
    expect(workerSource).toContain("  sourceDeadline = null,\n  pdfFetchOptions = null,\n) {");
    expect(workerSource).toContain("capturePdfSourceForBaseline(source, baseline, report, pdfFetchOptions)");
    expect(workerSource).toContain("capturePdfSourceForBaseline(source, state.baseline, report)");
    expect(workerOptions).toContain("acquireContext: () => acquirePdfBrowserFallbackContext(state)");
    // Exactly one call site threads worker state into the PDF lane: the
    // nightly queue's PDF branch.
    expect(workerSource.match(/pdfFetchOptionsForWorker\(state\),/g)).toHaveLength(1);
    expect(queued).toContain("pdfFetchOptionsForWorker(state),");
    expect(queued.indexOf("if (pdfSource) {")).toBeLessThan(queued.indexOf("pdfFetchOptionsForWorker(state),"));
    expect(queued.indexOf("pdfFetchOptionsForWorker(state),"))
      .toBeLessThan(queued.indexOf("const sourceDeadline = createSourcePhaseDeadline("));
    // No other fetchPdfSource caller opts in.
    const fetchCalls = [...workerSource.matchAll(/fetchPdfSource\(([^)]*)\)/g)]
      .map((match) => match[1])
      .filter((argumentList) => !argumentList.startsWith("url, {"));
    expect(fetchCalls).toEqual(["source.url, pdfFetchOptions"]);
    // Sealed intake and recovery lanes never reach the live downloader.
    for (const lane of [
      "materializeSealedFirstObservationCapture",
      "maybeRecoverIncompleteBaselineFromIntakeAcquisition",
      "processInitialOfficialDocumentMaterializationOnly",
    ]) {
      const start = workerSource.indexOf(`async function ${lane}(`);
      expect(start).toBeGreaterThan(-1);
      const body = workerSource.slice(start, workerSource.indexOf("\nasync function ", start + 1));
      expect(body).not.toContain("fetchPdfSource(");
      expect(body).not.toContain("pdfFetchOptions");
    }
  });
});
