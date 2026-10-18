import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { compareScraplingCaptures, scraplingSourceHtmlProfile, validateScraplingCapture } from "./scrapling-capture.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const source = { id: "source-html-test", url: "https://example.edu/award" };
const text = "Eligibility Applications close October 23, 2026. Only U.S. citizens may apply. " + "Complete graduate qualification. ".repeat(8).trim();
const heading = [{ level: 1, text: "Eligibility" }];
function fixture(capturedAt = "2026-10-18T19:00:00.000Z") {
  const html = `<html><head><title>Award</title></head><body><main><h1>Eligibility</h1><p>${text.slice(12)}</p></main></body></html>`;
  const document = { schema: "awardping.scrapling-html-document.v1", scope: "html-source-main-document",
    source_url: source.url, publishable: false, visibility_verified: false, title: "Award", text,
    blocks: [{ kind: "heading", text: "Eligibility", heading_path: heading, list_path: [], table_row: [] },
      { kind: "p", text: text.slice(12), heading_path: heading, list_path: [], table_row: [] }],
    links: [], base_hrefs: [], limitations: ["Source content is not rendered visibility or current-fact proof."] };
  return { schema: "awardping.scrapling-capture.v1", capture_profile: scraplingSourceHtmlProfile,
    source_id: source.id, url: source.url, final_url: source.url, captured_at: capturedAt,
    status_code: 200, content_type: "text/html; charset=utf-8", html, html_document: document,
    source_main_document: { ...structuredClone(document), scope: "html-source-main-element" },
    source_http: { schema: "awardping.scrapling-source-http.v1", method: "GET", response_complete: true,
      redirect_count: 0, body_encoding: "utf-8", content_encoding: "identity", body_byte_length: Buffer.byteLength(html),
      body_sha256: hash(html), acquisition: "ordinary_anonymous_http", visibility_verified: false, screenshot_available: false },
    warnings: ["source_html_only_not_browser_visible_or_screenshot_evidence", "linked_documents_forms_and_client_loaded_content_not_fetched"],
    engine: { scrapling: "0.4.15", client: "Fetcher", adaptive: false, stealth: false, impersonation: false } };
}
const validate = record => validateScraplingCapture(record, { source });
const resealHttp = record => {
  record.source_http.body_sha256 = hash(record.html);
  record.source_http.body_byte_length = Buffer.byteLength(record.html);
  delete record.integrity;
  return record;
};

describe("explicit source-only capture evidence", () => {
  it("seals raw body, full source, main source and transport without invented browser proof", () => {
    const result = validate(fixture());
    expect(result.publishable).toBe(false);
    expect(result.integrity.html_sha256).toBe(hash(result.html));
    expect(result.integrity.source_http_sha256).toBe(hash(JSON.stringify(result.source_http)));
    expect(result.integrity.html_document_sha256).toBe(hash(JSON.stringify(result.html_document)));
    expect(result.integrity.source_main_document_sha256).toBe(hash(JSON.stringify(result.source_main_document)));
    for (const key of ["screenshot", "document", "text", "visible_html", "readiness", "html_links"]) expect(result).not.toHaveProperty(key);
  });
  it.each(["screenshot", "document", "text", "visible_html", "readiness", "html_links", "text_geometry"])("rejects browser field %s in a source-only record", key => {
    const record = fixture(); record[key] = {};
    expect(() => validate(record)).toThrow("invalid_source_html_contract");
  });
  it.each([
    ["method", "POST"], ["response_complete", false], ["redirect_count", 1], ["body_encoding", "latin1"],
    ["content_encoding", "gzip"], ["body_byte_length", 1], ["body_sha256", "a".repeat(64)],
    ["acquisition", "browser"], ["visibility_verified", true], ["screenshot_available", true],
  ])("rejects false transport assertion %s", (key, value) => {
    const record = fixture(); record.source_http[key] = value;
    expect(() => validate(record)).toThrow("invalid_source_http_binding");
  });
  it("rejects partial status, URL drift, visibility claims and mutated retained source", () => {
    for (const change of [record => { record.status_code = 206; }, record => { record.final_url += "/other"; },
      record => { record.html_document.visibility_verified = true; }, record => { record.source_main_document.publishable = true; },
      record => { record.source_main_document.scope = "whole-visible-main-document"; },
      record => { record.html += "<!--changed-->"; }, record => { record.engine.impersonation = true; }]) {
      const record = fixture(); change(record); expect(() => validate(record)).toThrow();
    }
  });
  it("rejects contradictory source charset and strings that cannot round-trip as raw UTF-8", () => {
    const charset = fixture(); charset.content_type = "text/html; charset=latin1";
    expect(() => validate(charset)).toThrow("source_html_unsupported_encoding");
    const invalid = fixture(); invalid.html += "\ud800";
    expect(() => validate(resealHttp(invalid))).toThrow("invalid_capture_content");
  });
  it("rejects retained integrity corruption and unknown transport fields", () => {
    const record = validate(fixture()); record.html_document.blocks[1].text += " changed";
    expect(() => validate(record)).toThrow("capture_integrity_mismatch");
    const unknown = fixture(); unknown.source_http.cookies = "not retained";
    expect(() => validate(unknown)).toThrow("invalid_source_http_binding");
  });
  it("compares unchanged semantic source even if an inert response token changes", () => {
    const before = validate(fixture()); const next = fixture("2026-10-18T19:05:00.000Z");
    next.html += "<!--new non-semantic token-->";
    const after = validate(resealHttp(next));
    expect(before.integrity.html_sha256).not.toBe(after.integrity.html_sha256);
    expect(compareScraplingCaptures(before, after)).toMatchObject({ status: "unchanged", reason: "source_html_semantics_equal",
      scope: "observed_source_html_document", publishable: false, visibility_verified: false, screenshot_available: false });
  });
  it.each(["deadline", "qualification", "context", "links", "hidden-source"])("retains real %s change as unverified review work", kind => {
    const before = validate(fixture()); const next = fixture("2026-10-18T19:05:00.000Z");
    if (kind === "deadline" || kind === "qualification") {
      const [a, b] = kind === "deadline" ? ["October 23", "October 30"] : ["U.S. citizens", "U.S. permanent residents"];
      next.html = next.html.replaceAll(a, b);
      for (const doc of [next.html_document, next.source_main_document]) {
        doc.text = doc.text.replaceAll(a, b); doc.blocks[1].text = doc.blocks[1].text.replaceAll(a, b);
      }
    } else if (kind === "context") next.html_document.blocks[1].details_path = ["International applicants"];
    else if (kind === "links") next.html_document.links = [{ text: "Official rules", raw_href: "/new-rules.pdf",
      source_url: source.url, base_hrefs: [], heading_path: heading, list_path: [] }];
    else next.html_document.text += " Hidden new eligibility requirement.";
    const result = compareScraplingCaptures(before, validate(resealHttp(next)));
    expect(result).toMatchObject({ status: "changed_needs_review", reason: "source_html_semantics_differ", publishable: false });
    expect(result.fields).toContain("html_document");
  });
  it("holds invalid order and mixed profile rather than comparing browser and source baselines", () => {
    const record = validate(fixture());
    expect(compareScraplingCaptures(record, record)).toMatchObject({ status: "unavailable", reason: "capture_order_invalid" });
    const mixed = structuredClone(record); mixed.capture_profile = "scrapling-evidence-v1";
    expect(compareScraplingCaptures(mixed, record).status).toBe("unavailable");
  });
});

describe("source-only bridge network boundary wiring", () => {
  it("retains the mandatory bounded proxy, sanitized child environment and shutdown barrier", async () => {
    const proxy = { url: "http://127.0.0.1:49152", policyCheckpoint: () => ({ index: 0 }) };
    const startProxy = vi.fn(async () => proxy), finalize = vi.fn(async () => {});
    let request, childOptions, childArgs;
    const spawn = vi.fn((_python, args, options) => {
      childOptions = options; childArgs = args;
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      child.stdin = new EventEmitter(); child.stdin.end = value => {
        request = JSON.parse(value);
        queueMicrotask(() => { child.stdout.emit("data", Buffer.from(JSON.stringify(fixture()))); child.emit("close", 0); });
      };
      return child;
    });
    vi.resetModules();
    vi.doMock("node:child_process", () => ({ spawn }));
    vi.doMock("./public-network-safety.mjs", async () => ({ ...await vi.importActual("./public-network-safety.mjs"), startPublicNetworkProxy: startProxy }));
    vi.doMock("./capture-resource-limits.mjs", () => ({ finalizeCaptureNetworkBoundary: finalize }));
    vi.stubEnv("NO_PROXY", "*"); vi.stubEnv("GEMINI_API_KEY", "must-not-reach-child");
    try {
      const { captureScraplingSource } = await import("./scrapling-capture.mjs");
      const result = await captureScraplingSource(source, { pythonPath: "scratch-python", captureProfile: scraplingSourceHtmlProfile });
      expect(result.capture_profile).toBe(scraplingSourceHtmlProfile);
      expect(startProxy).toHaveBeenCalledWith({ timeoutMs: 15000, maxResponseBytes: 6 * 1024 * 1024 });
      expect(request).toMatchObject({ capture_profile: scraplingSourceHtmlProfile, proxy_url: proxy.url, executable_path: "" });
      expect(childArgs[0]).toBe("-B");
      expect(childOptions.env).toMatchObject({ PYTHONDONTWRITEBYTECODE: "1", PYTHONUTF8: "1" });
      expect(childOptions.env).not.toHaveProperty("NO_PROXY"); expect(childOptions.env).not.toHaveProperty("GEMINI_API_KEY");
      expect(finalize).toHaveBeenCalledWith(expect.objectContaining({ networkProxy: proxy, maxBytes: 6 * 1024 * 1024 }));
      finalize.mockRejectedValueOnce(new Error("private IP/byte boundary violation"));
      await expect(captureScraplingSource(source, { pythonPath: "scratch-python", captureProfile: scraplingSourceHtmlProfile })).rejects.toThrow("network_boundary_rejected");
    } finally {
      vi.unstubAllEnvs(); vi.doUnmock("node:child_process"); vi.doUnmock("./public-network-safety.mjs"); vi.doUnmock("./capture-resource-limits.mjs"); vi.resetModules();
    }
  });
});
