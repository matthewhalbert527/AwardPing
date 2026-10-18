import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureScraplingWorkerSource } from "./scrapling-worker.mjs";
import { SOURCE_HTML_PROFILE } from "./source-html-evidence.mjs";
import { verifyLocalSourceHtmlCapture, sourceHtmlBaselineEvidence, sourceHtmlR2Metadata } from "./source-html-worker-state.mjs";
import { prepareR2CaptureArtifacts, collectR2CaptureArtifactFiles } from "./r2-capture-artifact-bindings.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const source = { id: "10000000-0000-0000-0000-000000000001", shared_award_id: "20000000-0000-0000-0000-000000000001", url: "https://example.edu/award" };
const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "awardping-source-state-")); dirs.push(root);
  const text = "Only eligible graduate applicants may apply. ".repeat(6).trim();
  const html = `<html><head><title>Award</title></head><body><main><p>${text}</p></main></body></html>`;
  const doc = { schema: "awardping.scrapling-html-document.v1", scope: "html-source-main-document", source_url: source.url,
    title: "Award", text, publishable: false, visibility_verified: false, limitations: ["Source only"],
    blocks: [{ kind: "p", text, heading_path: [], list_path: [], table_row: [] }], links: [], base_hrefs: [] };
  const record = { schema: "awardping.scrapling-capture.v1", capture_profile: SOURCE_HTML_PROFILE,
    source_id: source.id, url: source.url, final_url: source.url, captured_at: "2026-10-18T19:00:00.000Z",
    status_code: 200, content_type: "text/html; charset=utf-8", html, html_document: doc,
    source_main_document: { ...structuredClone(doc), scope: "html-source-main-element" },
    source_http: { schema: "awardping.scrapling-source-http.v1", method: "GET", response_complete: true,
      redirect_count: 0, body_encoding: "utf-8", content_encoding: "identity", body_byte_length: Buffer.byteLength(html),
      body_sha256: hash(html), acquisition: "ordinary_anonymous_http", visibility_verified: false, screenshot_available: false },
    warnings: ["source_html_only_not_browser_visible_or_screenshot_evidence", "linked_documents_forms_and_client_loaded_content_not_fetched"],
    engine: { scrapling: "0.4.15", client: "Fetcher", adaptive: false, stealth: false, impersonation: false } };
  const capture = await captureScraplingWorkerSource(source, { archiveRoot: root, captureProfile: SOURCE_HTML_PROFILE, capture: async () => record });
  const baseline = { ...capture, source_html_body_hash: capture.source_html.capture.source_http.body_sha256,
    capture: { ...capture.files, page: null, thumb: null, expansion_states: [] } };
  return { root, capture, baseline };
}
describe("source-only local worker state", () => {
  it("validates all3 raw artifacts without modifying metadata", async () => {
    const { root, capture, baseline } = await fixture();
    const original = readFileSync(capture.meta_path);
    expect(verifyLocalSourceHtmlCapture(capture, { archiveRoot: root })).toMatchObject({ screenshot_available: false });
    expect(sourceHtmlBaselineEvidence(baseline, { archiveRoot: root })).toMatchObject({ ok: true, localizationStatus: "source_html_no_screenshot" });
    expect(readFileSync(capture.meta_path)).toEqual(original);
  });
  it.each(["html", "meta", "text"])("holds corrupt retained %s", async slot => {
    const { root, capture, baseline } = await fixture();
    writeFileSync(capture[`${slot}_path`], "corrupt");
    expect(sourceHtmlBaselineEvidence(baseline, { archiveRoot: root }).ok).toBe(false);
    expect(() => verifyLocalSourceHtmlCapture(capture, { archiveRoot: root })).toThrow();
  });
  it.each(["image_hash", "file_hash", "layout_hash", "text_geometry"])("refuses invented %s", async field => {
    const { root, baseline } = await fixture(); baseline[field] = "claimed";
    expect(sourceHtmlBaselineEvidence(baseline, { archiveRoot: root }).ok).toBe(false);
  });
  it("refuses profile/source/capsule/path drift", async () => {
    const { root, baseline } = await fixture();
    for (const mutate of [b => { b.capture_profile = "scrapling-evidence-v1"; }, b => { b.source.id = "different"; },
      b => { b.source_html.capture.source_http.response_complete = false; }, b => { b.capture.html = "../outside.html"; },
      b => { b.capture.meta = b.capture.text; }, b => { b.capture.page = b.capture.text; }]) {
      const value = structuredClone(baseline); mutate(value);
      expect(sourceHtmlBaselineEvidence(value, { archiveRoot: root }).ok).toBe(false);
    }
  });
  it("builds explicit source-only cloud metadata, never a rendered or image contract", async () => {
    const { capture } = await fixture();
    const prepared = prepareR2CaptureArtifacts(collectR2CaptureArtifactFiles(capture), { readFile: readFileSync });
    const metadata = sourceHtmlR2Metadata(capture, prepared.artifactBindings);
    expect(Object.keys(metadata.artifact_bindings).sort()).toEqual(["html", "meta", "text"]);
    expect(metadata.source_html).toEqual(capture.source_html);
    for (const key of ["html_capture", "browser", "text_geometry", "dimensions", "page_bytes", "localization"]) expect(metadata).not.toHaveProperty(key);
  });
});
