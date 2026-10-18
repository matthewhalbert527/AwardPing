import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chromium } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  captureRenderedHtml,
  DEFAULT_MAX_RENDERED_HTML_BYTES,
  RENDERED_HTML_CAPTURE_SCHEMA,
  RENDERED_HTML_CAPTURE_TIMEOUT_MS,
} from "./rendered-html-capture.mjs";

const sourceUrl = "https://award.example/eligibility";
const capturedAt = "2026-09-25T12:00:00.000Z";
const options = { capturedAt, sourceUrl };
const html = '<!DOCTYPE html>\n<html><body><h1>Eligibility</h1><details open=""><summary>Rules</summary><p>Apply in 2027.</p></details></body></html>';
const browserExecutable = [
  process.env.BROWSER_EXECUTABLE_PATH,
  process.env.CHROME_PATH,
  process.env.EDGE_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  chromium.executablePath(),
].find((path) => path && existsSync(path));

function fakePage(overrides = {}) {
  return {
    url: vi.fn(() => sourceUrl),
    evaluate: vi.fn(async () => ({
      status: "captured", html, byte_length: Buffer.byteLength(html), source_url: sourceUrl,
    })),
    ...overrides,
  };
}

function expectUnavailable(result, reason, maxBytes = DEFAULT_MAX_RENDERED_HTML_BYTES) {
  expect(result).toEqual({
    html: null,
    metadata: {
      schema: RENDERED_HTML_CAPTURE_SCHEMA,
      status: "unavailable",
      reason,
      representation: "rendered_dom",
      captured_at: capturedAt,
      source_url: sourceUrl,
      max_bytes: maxBytes,
      sha256: null,
      byte_length: null,
      screenshot_alignment: "not_verified",
    },
  });
}

afterEach(() => vi.useRealTimers());

describe("bounded rendered HTML capture", () => {
  it("retains exact markup, timestamp and URL without changing comparison hashes", async () => {
    const page = fakePage();
    const result = await captureRenderedHtml(page, options);
    expect(result).toEqual({
      html,
      metadata: {
        schema: RENDERED_HTML_CAPTURE_SCHEMA,
        status: "captured",
        reason: null,
        representation: "rendered_dom",
        captured_at: capturedAt,
        source_url: sourceUrl,
        max_bytes: DEFAULT_MAX_RENDERED_HTML_BYTES,
        sha256: createHash("sha256").update(html).digest("hex"),
        byte_length: Buffer.byteLength(html),
        screenshot_alignment: "not_verified",
      },
    });
    expect(page.evaluate).toHaveBeenCalledWith(expect.any(Function), {
      sourceUrl, maxBytes: DEFAULT_MAX_RENDERED_HTML_BYTES,
    });
  });

  it("independently enforces a UTF-8 byte cap after the browser result", async () => {
    const unicodeHtml = "é🦉";
    const page = fakePage({ evaluate: async () => ({
      status: "captured", html: unicodeHtml, byte_length: 3, source_url: sourceUrl,
    }) });
    expectUnavailable(await captureRenderedHtml(page, { ...options, maxBytes: 5 }), "html_too_large", 5);
    page.evaluate = async () => ({ status: "captured", html: unicodeHtml, byte_length: 6, source_url: sourceUrl });
    const result = await captureRenderedHtml(page, { ...options, maxBytes: 6 });
    expect(result.metadata.status).toBe("captured");
    expect(result.metadata.byte_length).toBe(6);
  });

  it.each(["html_too_large", "html_empty", "page_url_changed"])("preserves safe browser failure %s without partial markup", async (reason) => {
    const page = fakePage({ evaluate: async () => ({ status: "unavailable", reason, html: "partial" }) });
    expectUnavailable(await captureRenderedHtml(page, options), reason);
  });

  it.each([null, {}, { status: "captured", html: 23 }, { status: "unavailable", reason: "secret error" }])(
    "rejects malformed browser result %j", async (result) => {
      expectUnavailable(await captureRenderedHtml(fakePage({ evaluate: async () => result }), options), "invalid_capture_result");
    },
  );

  it("rejects empty HTML and incorrect reported byte length", async () => {
    const page = fakePage({ evaluate: async () => ({ status: "captured", html: " \n", byte_length: 2, source_url: sourceUrl }) });
    expectUnavailable(await captureRenderedHtml(page, options), "html_empty");
    page.evaluate = async () => ({ status: "captured", html, byte_length: -1, source_url: sourceUrl });
    expectUnavailable(await captureRenderedHtml(page, options), "invalid_capture_result");
  });

  it("refuses a page already navigated away without evaluating it", async () => {
    const page = fakePage({ url: () => "https://other.example/" });
    expectUnavailable(await captureRenderedHtml(page, options), "page_url_changed");
    expect(page.evaluate).not.toHaveBeenCalled();
  });

  it("rejects URL drift during or immediately after capture", async () => {
    const changedDuring = fakePage({ evaluate: async () => ({ status: "captured", html, byte_length: Buffer.byteLength(html), source_url: "https://other.example/" }) });
    expectUnavailable(await captureRenderedHtml(changedDuring, options), "page_url_changed");
    const changedAfter = fakePage({ url: vi.fn().mockReturnValueOnce(sourceUrl).mockReturnValue("https://other.example/") });
    expectUnavailable(await captureRenderedHtml(changedAfter, options), "page_url_changed");
  });

  it("returns unavailable for a closed/crashed page without copying error details", async () => {
    const page = fakePage({ evaluate: async () => { throw new Error("private response"); } });
    expectUnavailable(await captureRenderedHtml(page, options), "html_capture_failed");
  });

  it("bounds evaluation time and handles a later evaluation rejection", async () => {
    vi.useFakeTimers();
    let rejectEvaluation;
    const page = fakePage({ evaluate: () => new Promise((_, reject) => { rejectEvaluation = reject; }) });
    const pending = captureRenderedHtml(page, options);
    await vi.advanceTimersByTimeAsync(RENDERED_HTML_CAPTURE_TIMEOUT_MS);
    expectUnavailable(await pending, "html_capture_timeout");
    rejectEvaluation(new Error("late browser shutdown"));
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans up its timeout after successful capture", async () => {
    vi.useFakeTimers();
    await captureRenderedHtml(fakePage(), options);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, -1, NaN, Infinity, 1.5, "100", DEFAULT_MAX_RENDERED_HTML_BYTES + 1])("rejects invalid byte limit %s", async (maxBytes) => {
    const page = fakePage();
    await expect(captureRenderedHtml(page, { ...options, maxBytes })).rejects.toThrow(RangeError);
    expect(page.evaluate).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "invalid", Infinity])("rejects invalid timestamp %s", async (value) => {
    await expect(captureRenderedHtml(fakePage(), { ...options, capturedAt: value })).rejects.toThrow(TypeError);
  });

  it.each([undefined, "", "/relative", "file:///private", "https://user:pass@award.example/"])("rejects invalid source URL %s", async (value) => {
    await expect(captureRenderedHtml(fakePage(), { ...options, sourceUrl: value })).rejects.toThrow(TypeError);
  });

  it("rejects a missing browser page", async () => {
    await expect(captureRenderedHtml(null, options)).rejects.toThrow(TypeError);
  });

  it.skipIf(!browserExecutable)("captures JavaScript-rendered expanded DOM and enforces caps inside the browser without mutation", async () => {
    const browser = await chromium.launch({ executablePath: browserExecutable, headless: true });
    try {
      const page = await browser.newPage();
      const fixture = '<!DOCTYPE html><html><body><main id="award"></main><div id="shadow"></div><script>document.querySelector("#award").innerHTML = \'<h1>Current award</h1><details open><summary>Eligibility</summary><p id="dynamic">é🦉 Apply in 2027.</p></details>\'; document.querySelector("#shadow").attachShadow({mode:"open"}).textContent = "SHADOW_ONLY_TEXT";</script></body></html>';
      await page.route("**/*", (route) => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: fixture }));
      await page.goto(sourceUrl);
      const before = await page.content();
      const result = await captureRenderedHtml(page, options);
      expect(result.metadata.status).toBe("captured");
      expect(result.html).toMatch(/^<!DOCTYPE html>\n<html>/);
      expect(result.html).toContain('<p id="dynamic">é🦉 Apply in 2027.</p>');
      expect(result.html).toContain('<details open="">');
      expect(result.html).toContain('<div id="shadow"></div>');
      expect(result.html).not.toContain('<div id="shadow">SHADOW_ONLY_TEXT</div>');
      expect(await page.content()).toBe(before);

      // Exercise the real browser callback, not just the independent Node cap.
      const evaluate = page.evaluate.bind(page);
      const browserResults = [];
      const observedPage = { url: () => page.url(), evaluate: async (...args) => {
        const value = await evaluate(...args);
        browserResults.push(value);
        return value;
      } };
      expectUnavailable(await captureRenderedHtml(observedPage, { ...options, maxBytes: result.html.length }), "html_too_large", result.html.length);
      expect(browserResults[0]).toEqual({ status: "unavailable", reason: "html_too_large" });
      expectUnavailable(await captureRenderedHtml(observedPage, { ...options, maxBytes: 30 }), "html_too_large", 30);
      expect(browserResults[1]).toEqual({ status: "unavailable", reason: "html_too_large" });
      expect(await page.content()).toBe(before);
    } finally {
      await browser.close();
    }
  }, 20_000);
});
