import { describe, expect, it, vi } from "vitest";
import { findProgramTextBrowserExecutable, fetchProgramTextBrowserPdf } from "./program-text-browser.mjs";

const url = "https://www.noaa.gov/media/file/project-plan";
const executablePath = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const pdf = Buffer.from("%PDF-1.4\noriginal source bytes\n%%EOF");

function harness({ status = 200, finalUrl = url, headers = { "content-type": "application/pdf" }, buffer = pdf } = {}) {
  const events = [];
  const response = { status: () => status, url: () => finalUrl, headers: () => headers,
    body: vi.fn(async () => buffer), dispose: vi.fn(async () => events.push("response_disposed")) };
  const context = { request: { get: vi.fn(async () => response) }, close: vi.fn(async () => events.push("context_closed")) };
  const browser = { newContext: vi.fn(async () => context), close: vi.fn(async () => events.push("browser_closed")) };
  const proxy = { url: "http://127.0.0.1:32101", policyCheckpoint: () => 4, close: vi.fn(async () => events.push("proxy_closed")) };
  const adapters = { startProxy: vi.fn(async () => proxy), launchBrowser: vi.fn(async () => browser),
    finalizeBoundary: vi.fn(async options => { await options.context?.close(); await options.networkProxy.close(); events.push("boundary_verified"); }) };
  return { adapters, response, browser, context, proxy, events, options: { executablePath, adapters } };
}

describe("existing standard browser discovery", () => {
  it("prefers existing explicit browser paths without downloading or launching", () => {
    expect(findProgramTextBrowserExecutable({ BROWSER_EXECUTABLE_PATH: executablePath, CHROME_PATH: "C:/other/chrome.exe" }, () => true)).toBe(executablePath);
    expect(findProgramTextBrowserExecutable({ CHROME_PATH: executablePath }, candidate => candidate === executablePath)).toBe(executablePath);
  });
  it("finds a standard installed Chrome or Edge and otherwise returns null", () => {
    const matches = candidate => /Program Files.*Microsoft.*Edge.*msedge\.exe$/.test(candidate);
    expect(findProgramTextBrowserExecutable({ PROGRAMFILES: "C:/Program Files" }, matches)).toMatch(/Microsoft.*Edge.*msedge\.exe$/);
    expect(findProgramTextBrowserExecutable({}, () => false)).toBeNull();
  });
  it.each(["relative/chrome.exe", "chrome.exe --ignore-certificate-errors", "C:/chrome.exe\0argument", {}, 42])("ignores malformed executable/root %j", value => {
    const fileExists = vi.fn(() => false);
    expect(findProgramTextBrowserExecutable({ BROWSER_EXECUTABLE_PATH: value, LOCALAPPDATA: value }, fileExists)).toBeNull();
    expect(fileExists.mock.calls.some(([candidate]) => candidate === value)).toBe(false);
  });
});

describe("explicit anonymous browser PDF transport", () => {
  it("returns only exact PDF bytes after the mandatory context/proxy shutdown barrier", async () => {
    const test = harness();
    const result = await fetchProgramTextBrowserPdf(url, test.options);
    expect(result).toEqual({ buffer: pdf, status: 200, finalUrl: url, contentType: "application/pdf" });
    expect(test.adapters.startProxy).toHaveBeenCalledWith({ timeoutMs: expect.any(Number), maxResponseBytes: 20 * 1024 * 1024 });
    expect(test.adapters.launchBrowser.mock.calls[0][0]).toMatchObject({ executablePath, headless: true,
      proxy: { server: test.proxy.url, bypass: "<-loopback>" } });
    expect(test.browser.newContext).toHaveBeenCalledWith({ proxy: { server: test.proxy.url, bypass: "<-loopback>" },
      ignoreHTTPSErrors: false, serviceWorkers: "block", acceptDownloads: false });
    expect(test.context.request.get.mock.calls[0]).toEqual([url, { headers: { Accept: "application/pdf,application/octet-stream;q=0.9,*/*;q=0.5" },
      maxRedirects: 5, timeout: expect.any(Number) }]);
    const options = test.adapters.launchBrowser.mock.calls[0][0];
    expect(options).not.toHaveProperty("userAgent"); expect(options).not.toHaveProperty("ignoreDefaultArgs");
    expect(Object.keys(options.env).every(key => ["SystemRoot", "WINDIR", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "PATH", "COMSPEC", "PATHEXT"].includes(key))).toBe(true);
    expect(options.env).not.toHaveProperty("GEMINI_API_KEY"); expect(options.env).not.toHaveProperty("SUPABASE_SERVICE_ROLE_KEY");
    expect(options.args.join(" ")).not.toMatch(/disable-blink|ignore-certificate|no-sandbox/);
    expect(test.adapters.finalizeBoundary.mock.calls[0][0]).toMatchObject({ context: test.context, networkProxy: test.proxy,
      checkpoint: 4, maxBytes: 20 * 1024 * 1024 });
    expect(test.events).toEqual(["response_disposed", "context_closed", "proxy_closed", "boundary_verified", "browser_closed"]);
    expect(Object.keys(result)).not.toContain("screenshot");
  });
  it.each(["http://example.org/a", "https://127.0.0.1/a", "https://localhost/a", "https://example.org/a#fragment",
    "https://user:password@example.org/a", "https://example.org:444/a"])("refuses unsafe or non-HTTPS URL %s before any browser/network launch", async input => {
    const test = harness();
    await expect(fetchProgramTextBrowserPdf(input, test.options)).rejects.toThrow();
    expect(test.adapters.startProxy).not.toHaveBeenCalled(); expect(test.adapters.launchBrowser).not.toHaveBeenCalled();
  });
  it.each([{ executablePath: "relative.exe" }, { timeoutMs: 0 }, { timeoutMs: 120001 }, { maxBytes: 20 * 1024 * 1024 + 1 },
    { allowedFinalUrls: ["https://127.0.0.1/a"] }])("refuses invalid runtime/size/redirect configuration %j", async overrides => {
    const test = harness();
    await expect(fetchProgramTextBrowserPdf(url, { ...test.options, ...overrides })).rejects.toThrow();
    expect(test.adapters.startProxy).not.toHaveBeenCalled();
  });
  it.each([403, 401, 202, 500])("holds HTTP %i with no page load, retries or parsing", async status => {
    const test = harness({ status });
    await expect(fetchProgramTextBrowserPdf(url, test.options)).rejects.toMatchObject({ code: "program_text_browser_source_unavailable", http_status: status });
    expect(test.context.request.get).toHaveBeenCalledTimes(1); expect(test.response.body).not.toHaveBeenCalled();
    expect(test.events).toContain("boundary_verified");
  });
  it.each([{ "content-type": "text/html" }, { "content-type": "application/pdf", "x-amzn-waf-action": "challenge" },
    { "content-type": "application/pdf", "cf-mitigated": "challenge" }])("rejects interstitial/challenge headers %j", async headers => {
    const test = harness({ headers });
    await expect(fetchProgramTextBrowserPdf(url, test.options)).rejects.toThrow();
    expect(test.response.body).not.toHaveBeenCalled();
  });
  it("rejects a mislabeled HTML challenge and oversized declared or actual bodies", async () => {
    for (const options of [{ buffer: Buffer.from("<html>Just a moment</html>") },
      { headers: { "content-type": "application/pdf", "content-length": "1000" } }, { buffer: Buffer.alloc(101, 1) }]) {
      const test = harness(options);
      await expect(fetchProgramTextBrowserPdf(url, { ...test.options, maxBytes: 100 })).rejects.toThrow();
      expect(test.events).toContain("boundary_verified");
    }
  });
  it("allows same-origin redirects, but requires an exact approved cross-origin final URL", async () => {
    const same = harness({ finalUrl: "https://www.noaa.gov/sites/default/files/plan.pdf" });
    expect((await fetchProgramTextBrowserPdf(url, same.options)).finalUrl).toBe("https://www.noaa.gov/sites/default/files/plan.pdf");
    const next = "https://official.example.org/files/plan.pdf";
    const blocked = harness({ finalUrl: next });
    await expect(fetchProgramTextBrowserPdf(url, blocked.options)).rejects.toMatchObject({ code: "program_text_browser_unapproved_redirect_origin" });
    const allowed = harness({ finalUrl: next });
    expect((await fetchProgramTextBrowserPdf(url, { ...allowed.options, allowedFinalUrls: [next] })).finalUrl).toBe(next);
  });
  it("never returns downloaded bytes after a failed public-network policy barrier", async () => {
    const test = harness();
    test.adapters.finalizeBoundary.mockRejectedValue(new Error("late private DNS/byte-limit violation"));
    await expect(fetchProgramTextBrowserPdf(url, test.options)).rejects.toMatchObject({ code: "program_text_browser_network_boundary_rejected" });
    expect(test.browser.close).toHaveBeenCalledTimes(1);
  });
  it("closes the proxy after browser launch failure without exposing driver diagnostics", async () => {
    const test = harness(); test.adapters.launchBrowser.mockRejectedValue(new Error("sensitive driver paths and URLs"));
    await expect(fetchProgramTextBrowserPdf(url, test.options)).rejects.toMatchObject({ message: "Program text browser: fetch_failed" });
    expect(test.proxy.close).toHaveBeenCalledTimes(1);
  });
  it("holds even a complete download if browser shutdown fails", async () => {
    const test = harness(); test.browser.close.mockRejectedValue(new Error("shutdown failed"));
    await expect(fetchProgramTextBrowserPdf(url, test.options)).rejects.toMatchObject({ code: "program_text_browser_browser_shutdown_failed" });
  });
});
