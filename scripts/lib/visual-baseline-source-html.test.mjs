import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { captureScraplingWorkerSource } from "./scrapling-worker.mjs";
import { SOURCE_HTML_PROFILE } from "./source-html-evidence.mjs";
import { captureFromVisualReviewCandidate, promoteApprovedVisualBaselineLocal, promoteApprovedVisualBaselineR2 } from "./visual-baseline-promotion.mjs";
import { inspectStage1ImmutableR2CaptureBinding } from "./stage1-cohort-readiness.mjs";
import { buildVisualSnapshotRef } from "./visual-review-queue.mjs";

const sha = body => createHash("sha256").update(body).digest("hex");
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
  const root = mkdtempSync(join(tmpdir(), "awardping-source-promotion-test-"));
  try {
    const capture = await captureScraplingWorkerSource(source, { archiveRoot: root, captureProfile: SOURCE_HTML_PROFILE, capture: async () => record() });
    const binding = path => { const bytes = readFileSync(path); return { archive_relative: relative(root, path).replaceAll("\\", "/"), sha256: sha(bytes), byte_length: bytes.length }; };
    const ref = { capture_profile: SOURCE_HTML_PROFILE, captured_at: capture.captured_at, final_url: capture.final_url,
      kind: "webpage", text_hash: capture.text_hash, image_hash: null, file_hash: null, layout_hash: null,
      capture_dir: { archive_relative: relative(root, capture.dir).replaceAll("\\", "/") }, visual_states: [],
      metadata: { capture_profile: SOURCE_HTML_PROFILE },
      local_paths: { html: binding(capture.html_path), meta: binding(capture.meta_path), text: binding(capture.text_path) } };
    const candidate = { id: "candidate-source-html", shared_award_source_id: source.id, new_text_hash: capture.text_hash,
      new_image_hash: null, new_file_hash: null, new_snapshot_ref: ref };
    await callback({ root, capture, candidate, ref, binding });
  } finally { rmSync(root, { recursive: true, force: true }); }
}
function remote({ existing = null, loseCas = false } = {}) {
  let current = structuredClone(existing); const operations = [];
  return { operations, get current() { return current; },
    supabase: {
      from() { return { select() { return { eq() { return { async maybeSingle() { return { data: structuredClone(current), error: null }; } }; } }; } }; },
      async rpc(name, args) { operations.push({ type: "cas", name, args }); if (loseCas) return { data: false, error: null };
        current = structuredClone(args.p_snapshot); return { data: true, error: null }; },
    },
    s3Client: { async send(command) { operations.push({ type: command.constructor.name, input: command.input }); return {}; } },
  };
}
const localArgs = f => ({ candidate: f.candidate, source, archiveRoot: f.root, approved: true });
const remoteArgs = (f, r) => ({ candidate: f.candidate, source, capture: captureFromVisualReviewCandidate(f.candidate, f.root),
  approved: true, supabase: r.supabase, s3Client: r.s3Client, config: { enabled: true, bucket: "snapshots" } });

describe("explicit source HTML approved baseline promotion", () => {
  it("accepts the actual queue-builder reference without a browser artifact manifest", async () => fixture(f => {
    f.candidate.new_snapshot_ref = buildVisualSnapshotRef(f.capture, path => relative(f.root, path).replaceAll("\\", "/"));
    expect(Object.keys(f.candidate.new_snapshot_ref.local_paths).sort()).toEqual(["html", "meta", "text"]);
    expect(f.candidate.new_snapshot_ref.artifact_manifest.artifacts.map(artifact => artifact.role)).toEqual(["meta", "text"]);
    expect(promoteApprovedVisualBaselineLocal(localArgs(f)).promoted).toBe(true);
  }));
  it("retains sealed source evidence locally, verifies before idempotence, and never invents visual evidence", async () => fixture(f => {
    const promoted = promoteApprovedVisualBaselineLocal(localArgs(f));
    expect(promoted.promoted).toBe(true);
    expect(promoted.baseline.source_html).toEqual(f.capture.source_html);
    expect(promoted.baseline.capture_profile).toBe(SOURCE_HTML_PROFILE);
    expect(promoted.baseline.retained_artifact_projection.screenshot_available).toBe(false);
    expect(promoted.baseline.capture.page).toBeNull(); expect(promoted.baseline.capture.layout).toBeNull();
    expect(promoteApprovedVisualBaselineLocal(localArgs(f)).already_current).toBe(true);
    writeFileSync(f.capture.html_path, "altered HTML");
    expect(() => promoteApprovedVisualBaselineLocal(localArgs(f))).toThrow(/artifact verification failed for html/);
  }));
  it("uploads only3 immutable artifacts, rotates preserved history, and repeats without writes", async () => fixture(async f => {
    const r = remote(); const args = remoteArgs(f, r);
    expect((await promoteApprovedVisualBaselineR2(args)).promoted).toBe(true);
    expect(Object.keys(r.current.latest_object_keys).sort()).toEqual(["html", "meta", "text"]);
    expect(r.current.latest_metadata.source_html).toEqual(f.capture.source_html);
    expect(r.current.latest_metadata).not.toHaveProperty("text_geometry");
    expect(r.current.latest_metadata).not.toHaveProperty("localization");
    expect(r.current.latest_hashes.image_hash).toBeNull();
    expect(inspectStage1ImmutableR2CaptureBinding(r.current).valid).toBe(false);
    const count = r.operations.length;
    expect((await promoteApprovedVisualBaselineR2(args)).already_current).toBe(true);
    expect(r.operations).toHaveLength(count);
  }));
  it.each(["html", "text", "meta"])("rejects corrupted %s bytes before upload", async slot => fixture(async f => {
    writeFileSync(f.capture[`${slot}_path`], "changed");
    const r = remote();
    await expect(async () => promoteApprovedVisualBaselineR2(remoteArgs(f, r))).rejects.toThrow();
    expect(r.operations).toHaveLength(0);
  }));
  it.each(["profile", "top-profile", "timestamp", "text", "candidate-source", "image", "metadata-geometry", "visual-state", "extra-slot", "missing-binding"])
  ("rejects conflicting candidate %s authority", async field => fixture(f => {
    if (field === "profile") f.ref.metadata.capture_profile = "scrapling-evidence-v1";
    if (field === "top-profile") f.ref.capture_profile = "scrapling-evidence-v1";
    if (field === "timestamp") f.ref.captured_at = "2026-10-19T19:00:00.000Z";
    if (field === "text") f.candidate.new_text_hash = "b".repeat(64);
    if (field === "candidate-source") f.candidate.shared_award_source_id = "other";
    if (field === "image") f.ref.image_hash = "a".repeat(64);
    if (field === "metadata-geometry") f.ref.metadata.text_geometry = { status: "unavailable" };
    if (field === "visual-state") f.ref.visual_states.push({ kind: "main" });
    if (field === "extra-slot") f.ref.local_paths.page = f.ref.local_paths.html;
    if (field === "missing-binding") delete f.ref.local_paths.html.sha256;
    expect(() => promoteApprovedVisualBaselineLocal(localArgs(f))).toThrow();
  }));
  it("rejects mismatched caller identity before local baseline or upload", async () => fixture(async f => {
    expect(() => promoteApprovedVisualBaselineLocal({ ...localArgs(f), source: { ...source, url: "https://other.edu/" } })).toThrow(/source identity/);
    const r = remote(); await expect(promoteApprovedVisualBaselineR2({ ...remoteArgs(f, r), source: { ...source, shared_award_id: "other" } })).rejects.toThrow(/source identity/);
    expect(r.operations).toHaveLength(0);
  }));
  it("rejects coordinated metadata and response edits against sealed candidate meta binding", async () => fixture(f => {
    const meta = JSON.parse(readFileSync(f.capture.meta_path));
    meta.source_html.capture.html_document.text += " fabricated";
    writeFileSync(f.capture.meta_path, JSON.stringify(meta));
    expect(() => promoteApprovedVisualBaselineLocal(localArgs(f))).toThrow(/artifact verification failed for meta/);
  }));
  it("fails missing or browser-claimed source metadata without source-only coercion", async () => fixture(f => {
    const meta = JSON.parse(readFileSync(f.capture.meta_path)); meta.text_geometry = { status: "unavailable" };
    writeFileSync(f.capture.meta_path, JSON.stringify(meta)); f.ref.local_paths.meta = f.binding(f.capture.meta_path);
    expect(() => promoteApprovedVisualBaselineLocal(localArgs(f))).toThrow(/unexpected browser field/);
  }));
  it("requires explicit approval", async () => fixture(f => {
    expect(promoteApprovedVisualBaselineLocal({ ...localArgs(f), approved: false }).reason).toBe("candidate_not_approved");
  }));
  it("preserves CAS loss and deletes only unreferenced new upload keys", async () => fixture(async f => {
    const r = remote({ loseCas: true }); const result = await promoteApprovedVisualBaselineR2(remoteArgs(f, r));
    expect(result.reason).toBe("r2_pointer_compare_and_set_lost"); expect(r.current).toBeNull();
    expect(r.operations.filter(o => o.type === "PutObjectCommand")).toHaveLength(3);
    expect(r.operations.filter(o => o.type === "DeleteObjectCommand")).toHaveLength(3);
  }));
  it("refuses newer pointer conflicts before uploads", async () => fixture(async f => {
    const r = remote({ existing: { latest_captured_at: "2026-10-19T00:00:00.000Z", latest_metadata: { capture_profile: SOURCE_HTML_PROFILE } } });
    expect((await promoteApprovedVisualBaselineR2(remoteArgs(f, r))).reason).toBe("newer_or_conflicting_r2_baseline_exists");
    expect(r.operations).toHaveLength(0);
  }));
  it("never substitutes source-only evidence for an existing browser baseline outside explicit maintenance", async () => fixture(async f => {
    const first = promoteApprovedVisualBaselineLocal(localArgs(f));
    const previous = { ...first.baseline, capture_profile: "scrapling-evidence-v1" };
    writeFileSync(first.baseline_path, JSON.stringify(previous));
    expect(promoteApprovedVisualBaselineLocal(localArgs(f)).reason).toBe("capture_profile_migration_required");
    expect(JSON.parse(readFileSync(first.baseline_path))).toEqual(previous);
    const r = remote({ existing: { latest_captured_at: at, latest_metadata: { capture_profile: "scrapling-evidence-v1" } } });
    expect((await promoteApprovedVisualBaselineR2(remoteArgs(f, r))).reason).toBe("capture_profile_migration_required");
    expect(r.operations).toHaveLength(0);
  }));
});
