import { fetchPinnedPublicHttpHop, readResponseBodyBounded } from "./public-network-safety.mjs";
import { programTextPublicDrivePdfIdentity, isProgramTextPublicDrivePdfTransition,
  isProgramTextPublicDrivePdfContentType } from "./program-text-public-drive-pdf.mjs";

const maximumBytes = 20 * 1024 * 1024;
const redirectStatuses = new Set([301, 302, 303, 307, 308]);
const fail = reason => { throw Object.assign(new Error(`Public program PDF: ${reason}`),
  { code: `program_text_public_drive_${reason}` }); };

/** Two anonymous, pinned GETs at most. Check the finite same-file redirect
 * before issuing another request. No cookie jar, confirmation or auth flow. */
export async function fetchProgramTextPublicDrivePdf(url, { timeoutMs = 90_000,
  maxBytes = maximumBytes, adapters = {} } = {}) {
  const identity = programTextPublicDrivePdfIdentity(url);
  if (!identity || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000 ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > maximumBytes) fail("invalid_options");
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now(), redirectChain = [];
  let current = url;
  try {
    for (let hop = 0; hop < 2; hop++) {
      const remaining = timeoutMs - (Date.now() - started);
      if (remaining < 1 || controller.signal.aborted) fail("timeout");
      let fetched;
      try {
        fetched = await (adapters.fetchHop || fetchPinnedPublicHttpHop)(current, {
          method: "GET", credentials: "omit", signal: controller.signal,
          headers: { "user-agent": "AwardPing/1.0 (+https://awardping.com)", accept: "application/pdf" },
        }, { lookupTimeoutMs: Math.min(15_000, remaining) });
        if (fetched.url?.toString() !== current || fetched.response?.redirected) fail("unvalidated_redirect");
        const response = fetched.response, status = response.status;
        if (response.headers.get("x-amzn-waf-action") || response.headers.get("cf-mitigated")) fail("upstream_challenge");
        const location = response.headers.get("location");
        redirectChain.push({ url: current, status, ...(location ? { location } : {}) });
        if (redirectStatuses.has(status)) {
          // Only the literal observed absolute destination is accepted. Even a
          // public login/confirmation URL must never receive a follow-up GET.
          if (hop !== 0 || identity.pathname !== "/uc" || !isProgramTextPublicDrivePdfTransition(url, location)) fail("unapproved_redirect");
          current = location;
          continue;
        }
        if (status !== 200) fail("source_unavailable");
        if (!isProgramTextPublicDrivePdfTransition(url, current)) fail("unapproved_final_url");
        const contentType = response.headers.get("content-type");
        if (!isProgramTextPublicDrivePdfContentType(contentType)) fail("non_pdf_response");
        const length = response.headers.get("content-length");
        if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) fail("size_limit");
        const buffer = await readResponseBodyBounded(response, maxBytes, "Public program PDF");
        if (!buffer.length || buffer.length > maxBytes) fail("size_limit");
        if (controller.signal.aborted || Date.now() - started >= timeoutMs) fail("timeout");
        return { buffer, finalUrl: current, status, contentType, redirectCount: hop, redirectChain };
      } finally {
        await fetched?.response.body?.cancel().catch(() => undefined);
        await fetched?.close().catch(() => undefined);
      }
    }
    fail("redirect_limit");
  } catch (error) {
    if (controller.signal.aborted) fail("timeout");
    if (error?.code?.startsWith("program_text_public_drive_")) throw error;
    fail("fetch_failed");
  } finally { clearTimeout(timer); }
}
