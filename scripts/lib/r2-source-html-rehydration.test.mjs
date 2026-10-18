import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, mkdirSync, writeFileSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { captureScraplingWorkerSource } from "./scrapling-worker.mjs";
import { SOURCE_HTML_PROFILE } from "./source-html-evidence.mjs";
import { collectR2CaptureArtifactFiles, prepareR2CaptureArtifacts } from "./r2-capture-artifact-bindings.mjs";
import { rehydrateLocalBaselineFromR2 } from "./r2-baseline-rehydration.mjs";
const sha = x => createHash("sha256").update(x).digest("hex");
const source = { id: "12345678-1234-4234-8234-123456789012", shared_award_id: "22345678-1234-4234-8234-123456789012", url: "https://example.edu/award" };
const capturedAt = "2026-10-18T19:00:00.000Z", bucket = "test-evidence";
function record() {
  const text = "Applicants must submit all required academic transcripts and references. ".repeat(5).trim();
  const html = `<html><head><title>Award</title></head><body><main><p>${text}</p></main></body></html>`;
  const doc = { schema: "awardping.scrapling-html-document.v1", scope: "html-source-main-document", source_url: source.url,
    publishable: false, visibility_verified: false, title: "Award", text, blocks: [{ kind: "p", text, heading_path: [], list_path: [], table_row: [] }],
    links: [], base_hrefs: [], limitations: ["Source only."] };
  return { schema: "awardping.scrapling-capture.v1", capture_profile: SOURCE_HTML_PROFILE, source_id: source.id, url: source.url,
    final_url: source.url, captured_at: capturedAt, status_code: 200, content_type: "text/html; charset=utf-8", html, html_document: doc,
    source_main_document: { ...structuredClone(doc), title: "", scope: "html-source-main-element" },
    source_http: { schema: "awardping.scrapling-source-http.v1", method: "GET", response_complete: true, redirect_count: 0, body_encoding: "utf-8",
      content_encoding: "identity", body_byte_length: Buffer.byteLength(html), body_sha256: sha(html), acquisition: "ordinary_anonymous_http", visibility_verified: false, screenshot_available: false },
    warnings: ["source_html_only_not_browser_visible_or_screenshot_evidence", "linked_documents_forms_and_client_loaded_content_not_fetched"],
    engine: { scrapling: "0.4.15", client: "Fetcher", adaptive: false, stealth: false, impersonation: false } };
}
async function fixture(callback, { missing = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "awardping-r2-source-test-"));
  try {
    const capture = await captureScraplingWorkerSource(source, { archiveRoot: root, captureProfile: SOURCE_HTML_PROFILE, capture: async () => record() });
    const prepared = prepareR2CaptureArtifacts(collectR2CaptureArtifactFiles(capture), { readFile: readFileSync });
    const meta = JSON.parse(readFileSync(capture.meta_path, "utf8"));
    const sourceDir = join(root, "sources", source.id), baselinePath = join(sourceDir, "baseline.json");
    const baseline = { ...meta, source_html_body_hash: meta.source_html.capture.source_http.body_sha256,
      capture: { dir: meta.files.meta.slice(0, -10), ...meta.files } };
    const snapshotRecord = { kind: "webpage", shared_award_source_id: source.id, shared_award_id: source.shared_award_id, source_url: source.url, bucket,
      latest_captured_at: capturedAt, latest_hashes: { text_hash: meta.text_hash, body_text_hash: meta.body_text_hash, main_content_hash: meta.main_content_hash,
        image_hash: null, file_hash: null, layout_hash: null }, latest_metadata: { ...structuredClone(meta), artifact_bindings_schema: "awardping.r2.capture-artifact-bindings.v1", artifact_bindings: prepared.artifactBindings },
      latest_object_keys: Object.fromEntries(prepared.artifacts.map(a => [a.name, `visual-snapshots/sources/${source.id}/captures/${"a".repeat(32)}/${a.fileName}`])) };
    const objects = new Map(prepared.artifacts.map(a => [snapshotRecord.latest_object_keys[a.name], { body: a.body, type: a.contentType }]));
    rmSync(capture.dir, { recursive: true, force: true });
    if (missing) rmSync(sourceDir, { recursive: true, force: true });
    else writeFileSync(baselinePath, JSON.stringify(baseline));
    const calls = [];
    const client = { send: async command => {
      calls.push(command.constructor.name); const o = objects.get(command.input.Key);
      if (!o) throw Error("missing object");
      return { ContentLength: o.body.length, ContentType: o.type, ...(command.constructor.name === "GetObjectCommand" ? { Body: o.body } : {}) };
    } };
    const run = options => rehydrateLocalBaselineFromR2({ archiveRoot: root, source, baseline: missing ? null : baseline, snapshotRecord, bucket, client, ...options });
    await callback({ root, sourceDir, capture, baseline, baselinePath, snapshotRecord, objects, calls, client, run });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

describe("separate source-only exact R2 recovery", () => {
  it.each([false, true])("restores exactthree raw files with missingbaseline=%s and no invented image", async missing => fixture(async f => {
    const result = await f.run();
    expect(result).toMatchObject({ rehydrated: true, recovery_scope: "source_html_evidence_only", artifact_count: 3,
      localization_recovered: false, restored_missing_baseline: missing });
    expect(f.calls).toEqual(["HeadObjectCommand", "GetObjectCommand", "HeadObjectCommand", "GetObjectCommand", "HeadObjectCommand", "GetObjectCommand"]);
    expect(readdirSync(result.capture_dir).sort()).toEqual(["meta.json", "page.html.txt", "text.txt"]);
    for (const [slot, key] of Object.entries(f.snapshotRecord.latest_object_keys)) expect(readFileSync(join(f.root, result.baseline.capture[slot])).equals(f.objects.get(key).body)).toBe(true);
    expect(result.baseline).not.toHaveProperty("image_hash");
  }, { missing }));
  it("restores matchingprevious generation rather than taking a newer source baseline", async () => fixture(async f => {
    for (const key of ["captured_at", "hashes", "metadata", "object_keys"]) f.snapshotRecord[`previous_${key}`] = structuredClone(f.snapshotRecord[`latest_${key}`]);
    f.snapshotRecord.latest_captured_at = "2026-10-19T19:00:00.000Z";
    f.snapshotRecord.latest_metadata.source_html.capture.captured_at = f.snapshotRecord.latest_captured_at;
    const result = await f.run(); expect(result.rehydrated).toBe(true); expect(result.generation).toBe("previous");
  }));
  it.each(["profile", "image", "bodyhash", "source", "alias", "extra", "capsule", "url", "length", "pointergeometry", "pointerexpansion"])("holds mismatched %s without writing a capture", async field => fixture(async f => {
    if (field === "profile") f.snapshotRecord.latest_metadata.capture_profile = "scrapling-evidence-v1";
    if (field === "image") f.snapshotRecord.latest_hashes.image_hash = "b".repeat(64);
    if (field === "bodyhash") f.snapshotRecord.latest_metadata.artifact_bindings.html.sha256 = "b".repeat(64);
    if (field === "source") f.snapshotRecord.shared_award_source_id = "32345678-1234-4234-8234-123456789012";
    if (field === "alias") f.snapshotRecord.latest_object_keys.html = `visual-snapshots/sources/${source.id}/latest/page.html.txt`;
    if (field === "extra") f.snapshotRecord.latest_object_keys.page = "page.jpg";
    if (field === "capsule") f.snapshotRecord.latest_metadata.source_html.capture.source_http.visibility_verified = true;
    if (field === "url") f.snapshotRecord.source_url += "/different";
    if (field === "length") f.snapshotRecord.latest_metadata.artifact_bindings.meta.byte_length++;
    if (field === "pointergeometry") f.snapshotRecord.latest_metadata.text_geometry = { verified: true };
    if (field === "pointerexpansion") f.snapshotRecord.latest_metadata.expansion_state_screenshots = [{ page: "invented.jpg" }];
    const result = await f.run(); expect(result.rehydrated).toBe(false); expect(existsSync(f.capture.dir)).toBe(false);
    expect(JSON.parse(readFileSync(f.baselinePath, "utf8"))).toEqual(f.baseline);
  }));
  it("refuses an existing partial immutabletarget instead of overwriting its bytes", async () => fixture(async f => {
    mkdirSync(f.capture.dir); writeFileSync(join(f.capture.dir, "text.txt"), "keep me");
    const result = await f.run(); expect(result.rehydrated).toBe(false);
    expect(readFileSync(join(f.capture.dir, "text.txt"), "utf8")).toBe("keep me");
  }));
  it("holds concurrent baseline replacement and preserves the replacement", async () => fixture(async f => {
    const send = f.client.send;
    f.client.send = async command => { const response = await send(command); writeFileSync(f.baselinePath, JSON.stringify({ ...f.baseline, concurrent: true })); return response; };
    const result = await f.run(); expect(result).toMatchObject({ rehydrated: false, reason: "local_baseline_changed_during_rehydration" });
    expect(JSON.parse(readFileSync(f.baselinePath, "utf8")).concurrent).toBe(true); expect(existsSync(f.capture.dir)).toBe(false);
  }));
  it("bounds streaming bytes and rejects streamoverflow without capture writes", async () => fixture(async f => {
    const send = f.client.send;
    f.client.send = async command => { const response = await send(command); const bytes = response.Body;
      if (bytes) response.Body = (async function* () { yield bytes; yield Buffer.from("extra"); })(); return response; };
    const result = await f.run(); expect(result).toMatchObject({ rehydrated: false, reason: "r2_object_length_mismatch" }); expect(existsSync(f.capture.dir)).toBe(false);
  }));
  it("rejects an archive junction before any cloud read", async () => fixture(async f => {
    const outside = mkdtempSync(join(tmpdir(), "awardping-r2-source-outside-"));
    try {
      rmSync(f.sourceDir, { recursive: true, force: true }); symlinkSync(outside, f.sourceDir, "junction");
      const result = await f.run({ baseline: null }); expect(result.rehydrated).toBe(false); expect(f.calls.length).toBe(0);
      expect(readdirSync(outside)).toEqual([]);
    } finally { rmSync(outside, { recursive: true, force: true }); }
  }));
});
