import { existsSync } from "node:fs";
import { isAbsolute, join, win32 } from "node:path";
import { normalizePublicHttpUrl, startPublicNetworkProxy } from "./public-network-safety.mjs";
import { finalizeCaptureNetworkBoundary } from "./capture-resource-limits.mjs";

const maximumPdfBytes = 20 * 1024 * 1024;
const fail = (reason, details = {}) => { throw Object.assign(new Error(`Program text browser: ${reason}`), details,
  { code: `program_text_browser_${reason}` }); };
const executable = value => typeof value === "string" && value.length > 0 && value.length <= 4096 &&
  !/[\0\r\n]/.test(value) && (isAbsolute(value) || win32.isAbsolute(value));

/** Discovery only: never download a browser or attach to a user's session. */
export function findProgramTextBrowserExecutable(env = process.env, fileExists = existsSync) {
  const roots = [env.LOCALAPPDATA, env.PROGRAMFILES, env["ProgramFiles(x86)"]].filter(executable);
  const candidates = [env.BROWSER_EXECUTABLE_PATH, env.CHROME_PATH, env.EDGE_PATH,
    ...roots.map(root => join(root, "Google", "Chrome", "Application", "chrome.exe")),
    ...roots.map(root => join(root, "Microsoft", "Edge", "Application", "msedge.exe")),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/usr/bin/google-chrome", "/usr/bin/chromium-browser", "/usr/bin/chromium", "/usr/bin/microsoft-edge"];
  return candidates.find(candidate => executable(candidate) && fileExists(candidate)) || null;
}

function publicUrl(value) {
  const url = normalizePublicHttpUrl(value);
  if (typeof value !== "string" || url.href !== value || url.protocol !== "https:" || url.port || url.hash) fail("invalid_url");
  return url;
}

async function boundedClose(operation, timeoutMs = 5000) {
  let timer;
  try { return await Promise.race([operation, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("browser_shutdown_timeout")), timeoutMs);
  })]); } finally { clearTimeout(timer); }
}

/** Explicit PDF transport, not a retry/fallback. Native PDF extraction remains
 * separate. Every request uses a fresh anonymous default browser context and
 * the existing pinned public-network boundary; no page, script or image loads. */
export async function fetchProgramTextBrowserPdf(url, { executablePath, timeoutMs = 90_000,
  maxBytes = maximumPdfBytes, allowedFinalUrls = [], adapters = {} } = {}) {
  const requested = publicUrl(url);
  if (!executable(executablePath) || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120_000 ||
      !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > maximumPdfBytes ||
      !Array.isArray(allowedFinalUrls) || allowedFinalUrls.length > 20) fail("invalid_options");
  allowedFinalUrls.forEach(publicUrl);
  const started = Date.now(), remaining = () => {
    const left = timeoutMs - (Date.now() - started); if (left < 1) fail("timeout"); return left;
  };
  const proxy = await (adapters.startProxy || startPublicNetworkProxy)({ timeoutMs: Math.min(15_000, remaining()), maxResponseBytes: maxBytes });
  const checkpoint = proxy.policyCheckpoint();
  let browser, context, response, result, failure;
  try {
    const proxyOptions = { server: proxy.url, bypass: "<-loopback>" };
    const browserEnvironment = Object.fromEntries(["SystemRoot", "WINDIR", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "PATH", "COMSPEC", "PATHEXT"]
      .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
    browser = await (adapters.launchBrowser || (async options => (await import("playwright-core")).chromium.launch(options)))({ executablePath, headless: true,
      timeout: remaining(), env: browserEnvironment, proxy: proxyOptions, args: ["--disable-background-networking", "--disable-component-update",
        "--disable-default-apps", "--disable-extensions", "--disable-quic",
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp", "--webrtc-ip-handling-policy=disable_non_proxied_udp"] });
    context = await boundedClose(browser.newContext({ proxy: proxyOptions, ignoreHTTPSErrors: false, serviceWorkers: "block", acceptDownloads: false }), remaining());
    response = await context.request.get(url, { headers: { Accept: "application/pdf,application/octet-stream;q=0.9,*/*;q=0.5" },
      maxRedirects: 5, timeout: remaining() });
    const status = response.status(), headers = response.headers(), finalUrl = response.url(), contentType = headers["content-type"] || "";
    if (headers["x-amzn-waf-action"] || headers["cf-mitigated"]) fail("upstream_challenge");
    if (status !== 200) fail("source_unavailable", { http_status: status });
    const final = publicUrl(finalUrl);
    if (final.origin !== requested.origin && !allowedFinalUrls.includes(final.href)) fail("unapproved_redirect_origin");
    if (!/^application\/pdf(?:;|$)/i.test(contentType)) fail("non_pdf_response");
    if (headers["content-length"] && (!/^\d+$/.test(headers["content-length"]) || Number(headers["content-length"]) > maxBytes)) fail("size_limit");
    const buffer = await boundedClose(response.body(), remaining());
    if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > maxBytes) fail("size_limit");
    if (!buffer.subarray(0, 1024).includes(Buffer.from("%PDF-"))) fail("non_pdf_response");
    remaining();
    result = { buffer, finalUrl, status, contentType };
  } catch (error) {
    failure = error?.code?.startsWith("program_text_browser_") ? error :
      Object.assign(new Error("Program text browser: fetch_failed"), { code: "program_text_browser_fetch_failed" });
  } finally {
    // The context/proxy barrier is authoritative even after a successful body.
    try { await boundedClose(response?.dispose?.()); } catch { /* context closure still required below */ }
    try { await (adapters.finalizeBoundary || finalizeCaptureNetworkBoundary)({ context, networkProxy: proxy, checkpoint,
      maxBytes, shutdownTimeoutMs: 5000 }); } catch { failure = Object.assign(new Error("Program text browser: network_boundary_rejected"),
      { code: "program_text_browser_network_boundary_rejected" }); }
    try { await boundedClose(browser?.close?.()); } catch { failure = Object.assign(new Error("Program text browser: browser_shutdown_failed"),
      { code: "program_text_browser_browser_shutdown_failed" }); }
  }
  if (failure) throw failure;
  return result;
}
