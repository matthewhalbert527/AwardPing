import { createHash } from "node:crypto";

export const RENDERED_HTML_CAPTURE_SCHEMA = "awardping.rendered-html.v1";
export const DEFAULT_MAX_RENDERED_HTML_BYTES = 5 * 1024 * 1024;
export const RENDERED_HTML_CAPTURE_TIMEOUT_MS = 5_000;
export const renderedHtmlCaptureSchema = RENDERED_HTML_CAPTURE_SCHEMA;
export const maxRenderedHtmlBytes = DEFAULT_MAX_RENDERED_HTML_BYTES;

const unavailableReasons = new Set([
  "html_too_large",
  "html_empty",
  "page_url_changed",
]);

/**
 * Retain the main document's current DOM, including its doctype and already-open
 * sections. This is not the original HTTP response, iframe/shadow-root content,
 * a sanitized document, or a claim of exact screenshot alignment. Call only
 * after the worker's existing navigation, expansion and settling checks.
 *
 * The returned HTML is untrusted evidence: store as text, never execute/replay it
 * on the application's origin. This helper does not mutate the page or files.
 */
export async function captureRenderedHtml(page, {
  capturedAt,
  sourceUrl,
  maxBytes = DEFAULT_MAX_RENDERED_HTML_BYTES,
} = {}) {
  validateOptions(page, { capturedAt, sourceUrl, maxBytes });
  const metadata = {
    schema: RENDERED_HTML_CAPTURE_SCHEMA,
    status: "unavailable",
    reason: null,
    representation: "rendered_dom",
    captured_at: capturedAt,
    source_url: sourceUrl,
    max_bytes: maxBytes,
    sha256: null,
    byte_length: null,
    screenshot_alignment: "not_verified",
  };
  const unavailable = (reason) => ({ html: null, metadata: { ...metadata, reason } });
  let timeout;

  try {
    if (page.url() !== sourceUrl) return unavailable("page_url_changed");

    const timeoutResult = Symbol("rendered_html_timeout");
    const result = await Promise.race([
      Promise.resolve().then(() => page.evaluate(({ maxBytes, sourceUrl }) => {
        if (document.URL !== sourceUrl) {
          return { status: "unavailable", reason: "page_url_changed" };
        }
        if (!document.documentElement) {
          return { status: "unavailable", reason: "html_empty" };
        }

        const doctype = document.doctype
          ? `${new XMLSerializer().serializeToString(document.doctype)}\n`
          : "";
        const documentHtml = document.documentElement.outerHTML;
        // A UTF-16 length is a lower bound on UTF-8 bytes here. Reject clearly
        // excessive documents before joining/encoding, and always check bytes.
        if (doctype.length + documentHtml.length > maxBytes) {
          return { status: "unavailable", reason: "html_too_large" };
        }
        const html = doctype + documentHtml;
        if (!html.trim()) return { status: "unavailable", reason: "html_empty" };
        const byteLength = new TextEncoder().encode(html).byteLength;
        if (byteLength > maxBytes) {
          return { status: "unavailable", reason: "html_too_large" };
        }
        // No oversized/partial HTML crosses the browser protocol boundary.
        return { status: "captured", html, byte_length: byteLength, source_url: document.URL };
      }, { maxBytes, sourceUrl })),
      new Promise((resolve) => {
        timeout = setTimeout(() => resolve(timeoutResult), RENDERED_HTML_CAPTURE_TIMEOUT_MS);
      }),
    ]);

    if (result === timeoutResult) return unavailable("html_capture_timeout");
    if (page.url() !== sourceUrl) return unavailable("page_url_changed");
    if (result?.status === "unavailable" && unavailableReasons.has(result.reason)) {
      return unavailable(result.reason);
    }
    if (result?.status !== "captured" || typeof result.html !== "string") {
      return unavailable("invalid_capture_result");
    }
    if (result.source_url !== sourceUrl) return unavailable("page_url_changed");
    if (!result.html.trim()) return unavailable("html_empty");

    const byteLength = Buffer.byteLength(result.html, "utf8");
    if (byteLength > maxBytes) return unavailable("html_too_large");
    if (result.byte_length !== byteLength) return unavailable("invalid_capture_result");

    return {
      html: result.html,
      metadata: {
        ...metadata,
        status: "captured",
        sha256: createHash("sha256").update(result.html, "utf8").digest("hex"),
        byte_length: byteLength,
      },
    };
  } catch {
    // Do not persist browser errors: they can contain source HTML or secrets.
    return unavailable("html_capture_failed");
  } finally {
    clearTimeout(timeout);
  }
}

function validateOptions(page, { capturedAt, sourceUrl, maxBytes }) {
  if (!page || typeof page.evaluate !== "function" || typeof page.url !== "function") {
    throw new TypeError("Rendered HTML capture requires a browser page.");
  }
  if (typeof capturedAt !== "string" || !capturedAt.trim() || !Number.isFinite(Date.parse(capturedAt))) {
    throw new TypeError("Rendered HTML capture requires a valid capture timestamp.");
  }
  let parsedUrl;
  try {
    parsedUrl = new URL(sourceUrl);
  } catch {
    throw new TypeError("Rendered HTML capture requires an absolute HTTP(S) source URL.");
  }
  if (
    typeof sourceUrl !== "string" ||
    !["http:", "https:"].includes(parsedUrl.protocol) ||
    parsedUrl.username || parsedUrl.password
  ) {
    throw new TypeError("Rendered HTML capture requires an absolute HTTP(S) source URL without credentials.");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > DEFAULT_MAX_RENDERED_HTML_BYTES) {
    throw new RangeError(`Rendered HTML byte limit must be an integer from 1 to ${DEFAULT_MAX_RENDERED_HTML_BYTES}.`);
  }
}
