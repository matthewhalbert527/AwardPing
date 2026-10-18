import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { captureScraplingWorkerSource, assertScraplingBaselineCompatibility, validateScraplingSourceManifest } from "./scrapling-worker.mjs";
import { SOURCE_HTML_PROFILE, sourceHtmlReviewText, validateSourceHtmlEvidence, assertSourceHtmlArtifactIdentity } from "./source-html-evidence.mjs";
import { collectR2CaptureArtifactFiles, prepareR2CaptureArtifacts, assertR2CaptureArtifactIdentity, assertR2CaptureArtifactSlots,
  projectRetainedCaptureArtifacts } from "./r2-capture-artifact-bindings.mjs";
const sha = value => createHash("sha256").update(value).digest("hex");
const source = { id: "12345678-1234-4234-8234-123456789012", shared_award_id: "22345678-1234-4234-8234-123456789012", url: "https://example.edu/award" };
const at = "2026-10-18T19:00:00.000Z";
function record() {
  const text = "Applicants must be United States citizens. The graduate program requires a complete application by October 23, 2026. " + "Applicants must submit complete academic transcripts and all required recommendations. ".repeat(2);
  const html = `<html><head><title>Award</title></head><body><main><p>${text}</p></main></body></html>`;
  const doc = { schema: "awardping.scrapling-html-document.v1", scope: "html-source-main-document", source_url: source.url,
    publishable: false, visibility_verified: false, title: "Award", text,
    blocks: [{ kind: "p", text, heading_path: [], list_path: [], table_row: [] }], links: [], base_hrefs: [], limitations: ["Source only."] };
  return { schema: "awardping.scrapling-capture.v1", capture_profile: SOURCE_HTML_PROFILE, source_id: source.id, url: source.url, final_url: source.url,
    captured_at: at, status_code: 200, content_type: "text/html; charset=utf-8", html, html_document: doc,
    source_main_document: { ...structuredClone(doc), title: "", scope: "html-source-main-element" },
    source_http: { schema: "awardping.scrapling-source-http.v1", method: "GET", response_complete: true, redirect_count: 0,
      body_encoding: "utf-8", content_encoding: "identity", body_byte_length: Buffer.byteLength(html), body_sha256: sha(html),
      acquisition: "ordinary_anonymous_http", visibility_verified: false, screenshot_available: false },
    warnings: ["source_html_only_not_browser_visible_or_screenshot_evidence", "linked_documents_forms_and_client_loaded_content_not_fetched"],
    engine: { scrapling: "0.4.15", client: "Fetcher", adaptive: false, stealth: false, impersonation: false } };
}
async function fixture(callback) {
  const root = mkdtempSync(join(tmpdir(), "awardping-source-html-test-"));
  try {
    const capture = await captureScraplingWorkerSource(source, { archiveRoot: root, captureProfile: SOURCE_HTML_PROFILE, capture: async () => record() });
    const prepared = prepareR2CaptureArtifacts(collectR2CaptureArtifactFiles(capture), { readFile: readFileSync });
    await callback({ root, capture, prepared });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

describe("source-only worker and R2 binding", () => {
  it("retains exactly3 files, fullbody/main context and immutable raw bindings without a screenshot", async () => fixture(({ capture, prepared }) => {
    expect(readdirSync(capture.dir).sort()).toEqual(["meta.json", "page.html.txt", "text.txt"]);
    expect(capture.html).toBe(record().html);
    expect(capture.source_html.capture).not.toHaveProperty("html");
    for (const key of ["image_hash", "page_path", "thumb_path", "browser", "html_capture", "text_geometry", "page_readiness"])
      expect(capture).not.toHaveProperty(key);
    const checked = validateSourceHtmlEvidence(capture, { html: readFileSync(capture.html_path), source });
    expect(checked.source_main_document.scope).toBe("html-source-main-element");
    expect(capture.text).toBe(sourceHtmlReviewText(checked));
    expect(() => assertR2CaptureArtifactSlots("webpage", prepared.artifactBindings, { captureProfile: SOURCE_HTML_PROFILE })).not.toThrow();
    expect(() => assertR2CaptureArtifactIdentity(capture, prepared, { sourceId: source.id })).not.toThrow();
    expect(projectRetainedCaptureArtifacts(capture).localizationStatus).toBe("source_html_no_screenshot");
    expect(() => assertR2CaptureArtifactSlots("webpage", prepared.artifactBindings)).toThrow("required page");
  }));
  it.each(["page_path", "thumb_path", "image_hash", "layout_hash", "text_geometry", "html_capture", "browser", "page_readiness", "localization"])
  ("rejects invented %s claims before cloud bytes", async key => fixture(({ capture, prepared }) => {
    capture[key] = key.endsWith("hash") ? "a".repeat(64) : {};
    expect(() => assertR2CaptureArtifactIdentity(capture, prepared)).toThrow();
  }));
  it.each(["html", "text", "meta"])("rejects changed %s bytes even with freshly recomputed raw binding", async slot => fixture(({ capture, prepared }) => {
    const a = prepared.artifacts.find(a => a.name === slot);
    a.body = Buffer.from(slot === "meta" ? JSON.stringify({ ...JSON.parse(a.body), captured_at: "2026-10-19T19:00:00.000Z" }) : `${a.body}changed`);
    a.binding = { ...a.binding, sha256: sha(a.body), byte_length: a.body.length }; prepared.artifactBindings[slot] = a.binding;
    expect(() => assertSourceHtmlArtifactIdentity(capture, prepared)).toThrow();
  }));
  it.each(["source", "main", "http", "integrity", "projection", "path"])("rejects conflicting sealed %s identity", async field => fixture(({ capture, prepared }) => {
    if (field === "source") capture.source.url += "/different";
    if (field === "main") capture.source_html.capture.source_main_document.text += " changed";
    if (field === "http") capture.source_html.capture.source_http.visibility_verified = true;
    if (field === "integrity") delete capture.source_html.capture.integrity;
    if (field === "projection") capture.retained_artifact_projection.authoritative.layout_retained = true;
    if (field === "path") capture.files.html = "../page.html.txt";
    expect(() => assertSourceHtmlArtifactIdentity(capture, prepared)).toThrow();
  }));
  it("requires exactsource profile opt-in, and blocks browser/source migration without maintenance", () => {
    expect(() => assertScraplingBaselineCompatibility({ capture_profile: "scrapling-evidence-v1" }, { useScrapling: true, captureProfile: SOURCE_HTML_PROFILE })).toThrow();
    expect(() => assertScraplingBaselineCompatibility({ capture_profile: SOURCE_HTML_PROFILE }, { useScrapling: true })).toThrow();
    expect(() => assertScraplingBaselineCompatibility({ capture_profile: SOURCE_HTML_PROFILE }, { useScrapling: false })).toThrow();
    expect(() => assertScraplingBaselineCompatibility({ capture_profile: SOURCE_HTML_PROFILE }, { useScrapling: true, captureProfile: SOURCE_HTML_PROFILE })).not.toThrow();
    const awardIds = Array.from({ length: 25 }, (_, i) => `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`);
    const manifest = { schema: "awardping.scrapling-source-manifest.v1", profile: "scrapling-evidence-v1", reviewed_at: at, award_ids: awardIds,
      sources: [{ id: source.id, award_id: awardIds[0], url: source.url, kind: "html", roles: ["eligibility"], capture_profile: SOURCE_HTML_PROFILE }] };
    expect(validateScraplingSourceManifest(manifest).sources[0].capture_profile).toBe(SOURCE_HTML_PROFILE);
    manifest.sources[0].capture_profile = "unknown";
    expect(() => validateScraplingSourceManifest(manifest)).toThrow();
  });
  it("rejects duplicate capture and archive junction escape without overwriting files", async () => fixture(async ({ root, capture }) => {
    const old = readFileSync(capture.meta_path);
    await expect(captureScraplingWorkerSource(source, { archiveRoot: root, captureProfile: SOURCE_HTML_PROFILE, capture: async () => record() })).rejects.toThrow();
    expect(readFileSync(capture.meta_path).equals(old)).toBe(true);
    const outside = mkdtempSync(join(tmpdir(), "awardping-source-html-outside-"));
    try {
      const changedSource = { ...source, id: "32345678-1234-4234-8234-123456789012" };
      mkdirSync(join(root, "sources"), { recursive: true });
      symlinkSync(outside, join(root, "sources", changedSource.id), "junction");
      await expect(captureScraplingWorkerSource(changedSource, { archiveRoot: root, captureProfile: SOURCE_HTML_PROFILE,
        capture: async () => ({ ...record(), source_id: changedSource.id }) })).rejects.toThrow("escaped archive");
      expect(readdirSync(outside)).toEqual([]);
    } finally { rmSync(outside, { recursive: true, force: true }); }
  }));
});
