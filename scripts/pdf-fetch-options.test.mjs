import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  isPdfPayload,
  pdfDownloadFallbackReason,
  pdfDownloadNonPdfContentMessage,
} from "./lib/visual-capture-run-report.mjs";

const worker = readFileSync(new URL("./capture-visual-snapshots.mjs", import.meta.url), "utf8");
const start = worker.indexOf("async function fetchPdfSource(");
const end = worker.indexOf("async function extractPdfText(", start);
if (start < 0 || end <= start) throw new Error("PDF downloader functions were not found.");
const downloaderSource = worker.slice(start, end);
const sourceUrl = "https://example.invalid/official.pdf";
const pdf = Buffer.from("%PDF-1.7\nverified test payload");

function harness() {
  const primary = vi.fn().mockResolvedValue({
    status: 200,
    statusText: "OK",
    contentType: "application/pdf",
    buffer: pdf,
  });
  const response = {
    status: () => 200,
    statusText: () => "OK",
    headers: () => ({ "content-type": "application/pdf" }),
    body: vi.fn().mockResolvedValue(pdf),
    url: () => sourceUrl,
    dispose: vi.fn().mockResolvedValue(undefined),
  };
  const request = vi.fn().mockResolvedValue(response);
  const acquireContext = vi.fn().mockResolvedValue({ request: { get: request } });
  const dependencies = {
    fetchPublicHttpBuffer: primary,
    maxPdfBytes: 1024,
    timeoutMs: 1000,
    crawlerUserAgent: "AwardPing offline test",
    isPdfPayload,
    pdfDownloadFallbackReason,
    pdfDownloadNonPdfContentMessage,
    errorMessage: (error) => error.message,
    cleanText: (value) => String(value || "").trim(),
    console: { log: vi.fn() },
  };
  // Execute the real downloader functions, not the worker's top-level run.
  // All network and browser access is injected and remains entirely offline.
  const fetchPdfSource = new Function(
    ...Object.keys(dependencies),
    `${downloaderSource}\nreturn fetchPdfSource;`,
  )(...Object.values(dependencies));
  return { fetchPdfSource, primary, response, request, acquireContext };
}

describe("PDF downloader optional fallback", () => {
  it.each([
    ["omitted", []],
    ["undefined", [undefined]],
    ["null", [null]],
    ["empty object", [{}]],
  ])("downloads normally with %s options and does not start a browser", async (_label, options) => {
    const { fetchPdfSource, primary, acquireContext } = harness();
    await expect(fetchPdfSource(sourceUrl, ...options)).resolves.toMatchObject({
      buffer: pdf,
      fetchPath: "public_http_fetch",
      fallbackReason: null,
    });
    expect(primary).toHaveBeenCalledExactlyOnceWith(sourceUrl, expect.objectContaining({
      maxBytes: 1024,
      maxRedirects: 5,
      timeoutMs: 1000,
    }));
    expect(acquireContext).not.toHaveBeenCalled();
  });

  it.each([undefined, null])("keeps a blocked download blocked without opt-in (%s)", async (options) => {
    const { fetchPdfSource, primary, acquireContext } = harness();
    primary.mockResolvedValue({ status: 403, statusText: "Forbidden" });
    await expect(fetchPdfSource(sourceUrl, options)).rejects.toThrow("PDF download failed with HTTP 403 Forbidden");
    expect(primary).toHaveBeenCalledTimes(1);
    expect(acquireContext).not.toHaveBeenCalled();
  });

  it("uses one supplied browser-context retry for an opted-in 403", async () => {
    const { fetchPdfSource, primary, acquireContext, request, response } = harness();
    primary.mockResolvedValue({ status: 403, statusText: "Forbidden" });
    await expect(fetchPdfSource(sourceUrl, { browserFallback: { acquireContext } })).resolves.toMatchObject({
      buffer: pdf,
      fetchPath: "browser_fallback",
      fallbackReason: "http_403",
    });
    expect(primary).toHaveBeenCalledTimes(1);
    expect(acquireContext).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledExactlyOnceWith(sourceUrl, expect.objectContaining({
      maxRedirects: 5,
      timeout: 1000,
    }));
    expect(response.dispose).toHaveBeenCalledTimes(1);
  });

  it("rejects non-PDF fallback content and disposes its response", async () => {
    const { fetchPdfSource, primary, acquireContext, request, response } = harness();
    primary.mockResolvedValue({ status: 403, statusText: "Forbidden" });
    response.headers = () => ({ "content-type": "text/html" });
    response.body.mockResolvedValue(Buffer.from("<html>Blocked</html>"));
    await expect(fetchPdfSource(sourceUrl, { browserFallback: { acquireContext } })).rejects.toThrow(
      "PDF download failed with HTTP 403 Forbidden (browser fallback: non-PDF content (text/html))",
    );
    expect(request).toHaveBeenCalledTimes(1);
    expect(response.dispose).toHaveBeenCalledTimes(1);
  });

  it("does not retry a non-403 HTTP failure even when opted in", async () => {
    const { fetchPdfSource, primary, acquireContext } = harness();
    primary.mockResolvedValue({ status: 404, statusText: "Not Found" });
    await expect(fetchPdfSource(sourceUrl, { browserFallback: { acquireContext } })).rejects.toThrow("HTTP 404 Not Found");
    expect(primary).toHaveBeenCalledTimes(1);
    expect(acquireContext).not.toHaveBeenCalled();
  });

  it("does not retry a public-network boundary refusal through the browser", async () => {
    const { fetchPdfSource, primary, acquireContext } = harness();
    const refusal = new Error("Public-network destination refused");
    primary.mockRejectedValue(refusal);
    await expect(fetchPdfSource(sourceUrl, { browserFallback: { acquireContext } })).rejects.toBe(refusal);
    expect(primary).toHaveBeenCalledTimes(1);
    expect(acquireContext).not.toHaveBeenCalled();
  });
});
