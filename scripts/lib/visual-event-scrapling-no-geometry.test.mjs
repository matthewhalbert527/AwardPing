import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";
import { captureScraplingWorkerSource } from "./scrapling-worker.mjs";
import { projectRetainedCaptureArtifactsForMaterialization } from "./r2-capture-artifact-bindings.mjs";
import { buildScraplingReviewDiff } from "./scrapling-review-diff.mjs";
import { buildVisualReviewPromptPayload, visualSnapshotArtifactManifest } from "./visual-review-queue.mjs";
import { preparePublishedVisualEventEvidence } from "./visual-event-evidence.mjs";
import { sourceQualityDecision } from "./source-quality.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const source = {
  id: "11111111-1111-4111-8111-111111111111", shared_award_id: "22222222-2222-4222-8222-222222222222",
  url: "https://example.edu/synthetic-scholarship", title: "Synthetic scholarship", page_type: "application",
  admin_review_status: "open", source: "admin", shared_awards: { name: "Synthetic scholarship" },
  page_metadata_generated_at: "2026-10-19T00:00:00.000Z", page_metadata_model: "synthetic-only",
  page_metadata: { baseline_facts: { award_relevance: "primary", cycle_relevance: "current_or_upcoming", confidence: "high", quality_flags: [] } },
};
let jpeg;
beforeAll(async () => {
  jpeg = await sharp({ create: { width: 320, height: 200, channels: 3, background: "white" } }).jpeg().toBuffer();
});
function record(profile, at, text) {
  const blocks = [{ kind: "paragraph", text, heading_path: [], list_path: [], table_row: [] }];
  const html = "<html><head><title>Synthetic scholarship</title></head><body><main><p>" + text + "</p></main></body></html>";
  return {
    schema: "awardping.scrapling-capture.v1", capture_profile: profile,
    source_id: source.id, url: source.url, final_url: source.url, captured_at: at, status_code: 200, content_type: "text/html",
    html, visible_html: "<ap-document>" + text + "</ap-document>", text,
    document: { schema: "awardping.scrapling-document.v1", scope: "whole-visible-main-document",
      title: "Synthetic scholarship", text, blocks: structuredClone(blocks), links: [], limitations: [] },
    html_document: { schema: "awardping.scrapling-html-document.v1", scope: "html-source-main-document",
      source_url: source.url, title: "Synthetic scholarship", text, blocks, links: [], base_hrefs: [],
      limitations: ["Source prose does not establish screenshot coordinates."], publishable: false, visibility_verified: false },
    html_links: [], warnings: [], engine: { scrapling: "0.4.15" },
    readiness: { ready_state: "complete", fonts_status: "loaded", stable: true, samples: 3, stable_ms: 1000 },
    screenshot: { schema: "awardping.scrapling-screenshot.v1", mime_type: "image/jpeg", source_url: source.url,
      base64: jpeg.toString("base64"), sha256: sha(jpeg), byte_length: jpeg.length, width: 320, height: 200,
      captured_at: at, primary_html_captured_at: at, full_page: true, geometry_status: "unavailable",
      alignment: "not_verified", semantics_bracketed: true, semantic_mismatches: [], limitations: [] },
  };
}
async function fixture(profile = "scrapling-evidence-v2") {
  // Retain only unique repository-local synthetic fixtures. No recursive cleanup
  // or writes to an actual worker/archive, including when a test fails.
  const scratch = resolve("tmp");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "scrapling-event-no-geometry-"));
  const capture = async (at, text) => {
    const value = await captureScraplingWorkerSource(source, { archiveRoot: root, captureProfile: profile,
      capture: async () => record(profile, at, text) });
    expect(value.text_geometry).toBeNull();
    expect(value.localization.status).toBe("unavailable");
    const projection = projectRetainedCaptureArtifactsForMaterialization(value, { exists: existsSync, identityScope: source.id });
    // Explicit publication-fixture normalization, not a replacement worker
    // materializer or proof that its entrypoint has executed in this unit test.
    const localization = { status: projection.localizationStatus, exact: false, accounted_for: true,
      geometry_ready: false, geometry_hash: null, bound_image_hash: null };
    Object.assign(value, { localization, retained_artifact_projection: projection.manifest });
    const meta = { ...JSON.parse(readFileSync(value.meta_path, "utf8")), localization,
      retained_artifact_projection: projection.manifest };
    writeFileSync(value.meta_path, JSON.stringify(meta, null, 2));
    return value;
  };
  const baseline = await capture("2026-10-20T12:00:00.000Z", "The application deadline is October 23, 2027.");
  const current = await capture("2026-10-20T13:00:00.000Z", "The application deadline is October 30, 2027.");
  // This is intentionally the sparse readBaselineEvidence descriptor contract,
  // not a spread of the baseline capture carrying optional current-only fields.
  const previous = { ok: true, kind: "webpage", localizationStatus: "evidence_only_geometry_unavailable",
    pagePath: baseline.page_path, thumbPath: baseline.thumb_path, pdfPath: null, textPath: baseline.text_path,
    htmlPath: baseline.html_path, expansionTextPath: null, sectionsTextPath: null, sectionsJsonPath: null,
    layoutPath: null, expansionStateScreenshots: [], metaPath: baseline.meta_path,
    text: readFileSync(baseline.text_path, "utf8"), meta: JSON.parse(readFileSync(baseline.meta_path, "utf8")) };
  const comparison = buildScraplingReviewDiff({ source, baseline, previous, capture: current });
  expect(comparison.status).toBe("changed_needs_review");
  const payload = buildVisualReviewPromptPayload({ source, baseline, previous, capture: current,
    diff: comparison.diff, deterministic: comparison.deterministic, behaviorVersion: current.capture_behavior_version,
    behaviorName: current.capture_behavior_name, archiveRelative: path => relative(root, path).replaceAll("\\", "/") });
  expect(payload.previous_snapshot_ref.metadata).toMatchObject({ localization: null, dimensions: null, status_code: null, text_geometry: null });
  expect(payload.new_snapshot_ref.metadata.localization.status).toBe("evidence_only_geometry_unavailable");
  const candidate = {
    id: "33333333-3333-4333-8333-333333333333", candidate_signature: "a".repeat(64),
    shared_award_source_id: source.id, shared_award_id: source.shared_award_id, source_url: source.url, source_page_type: source.page_type,
    previous_text_hash: baseline.text_hash, new_text_hash: current.text_hash,
    previous_image_hash: baseline.image_hash, new_image_hash: current.image_hash,
    previous_snapshot_ref: payload.previous_snapshot_ref, new_snapshot_ref: payload.new_snapshot_ref, prompt_payload: payload,
    deterministic_diff: comparison.diff,
    worker_metadata: { capture_profile: current.capture_profile, capture_behavior_name: current.capture_behavior_name,
      capture_behavior_version: current.capture_behavior_version },
  };
  const objects = new Map(), puts = [], heads = [];
  const store = { bucket: "synthetic-only",
    async put(value) { expect(objects.has(value.key)).toBe(false); puts.push(value.key); objects.set(value.key, value); },
    async head({ key }) { heads.push(key); const value = objects.get(key); return { sha256: value.sha256, byte_length: value.body.length, content_type: value.contentType }; } };
  return { root, candidate, store, puts, heads, current,
    run: (changeDetails = { exact_before: "October 23, 2027", exact_after: "October 30, 2027" }, identity = source) =>
      preparePublishedVisualEventEvidence({ candidate, source: identity, archiveRoot: root, artifactStore: store, changeDetails }) };
}
function seal(f, side = "previous", mutate = null) {
  const key = side === "previous" ? "previous_snapshot_ref" : "new_snapshot_ref", ref = f.candidate[key];
  if (mutate) {
    const meta = JSON.parse(readFileSync(ref.local_paths.meta.path, "utf8")); mutate(meta);
    writeFileSync(ref.local_paths.meta.path, JSON.stringify(meta, null, 2));
    const bytes = readFileSync(ref.local_paths.meta.path);
    Object.assign(ref.local_paths.meta, { sha256: sha(bytes), byte_length: bytes.length, bytes: bytes.length });
  }
  ref.artifact_manifest = visualSnapshotArtifactManifest(ref);
  ref.artifact_manifest_digest = ref.artifact_manifest.digest;
  f.candidate.prompt_payload[key] = structuredClone(ref);
  f.candidate.prompt_payload.hashes[side === "previous" ? "previous_artifact_manifest_digest" : "new_artifact_manifest_digest"] = ref.artifact_manifest_digest;
}
function replaceImage(f, bytes) {
  const ref = f.candidate.previous_snapshot_ref, hash = sha(bytes);
  writeFileSync(ref.local_paths.page.path, bytes);
  for (const value of [ref.local_paths.page, ref.visual_states[0].local_paths.image])
    Object.assign(value, { sha256: hash, byte_length: bytes.length, bytes: bytes.length });
  ref.image_hash = hash; ref.visual_states[0].image_hash = hash;
  f.candidate.previous_image_hash = hash; f.candidate.prompt_payload.hashes.previous_image_hash = hash;
  seal(f, "previous", meta => {
    meta.image_hash = hash; meta.page_bytes = bytes.length;
    Object.assign(meta.scrapling.screenshot, { sha256: hash, byte_length: bytes.length });
    meta.scrapling.integrity.screenshot_sha256 = hash;
    meta.scrapling.integrity.screenshot_metadata_sha256 = sha(JSON.stringify(meta.scrapling.screenshot));
  });
}

describe("sealed Scrapling profiles without captured geometry", () => {
  it.each(["scrapling-evidence-v1", "scrapling-evidence-v2"])("retains real %s adapter evidence as full images, not crop or location proof", async profile => {
    const f = await fixture(profile), evidence = await f.run();
    expect(f.current.capture_profile).toBe(profile);
    expect(f.current.capture_behavior_version).toBe(profile.endsWith("v2") ? 2 : 1);
    expect(evidence.evidence_status).toBe("unavailable_geometry_missing"); expect(evidence.verified_at).toBeNull();
    for (const side of ["previous", "current"]) {
      const retained = evidence[side + "_capture"], ref = f.candidate[side === "previous" ? "previous_snapshot_ref" : "new_snapshot_ref"];
      expect(retained.full.sha256).toBe(ref.image_hash); expect(retained.metadata.sha256).toBe(ref.local_paths.meta.sha256);
      expect(retained.text.sha256).toBe(ref.local_paths.text.sha256);
      expect(retained.crop).toBeNull(); expect(retained.layout).toBeNull(); expect(retained.states).toHaveLength(1);
      expect(evidence.localization.sides[side]).toMatchObject({ status: "unavailable_geometry_not_captured_by_profile",
        exact_overlap: false, semantic_verified: false, required: true });
    }
    expect(f.heads).toEqual(f.puts); expect(f.puts.some(key => key.includes("crop") || key.includes("geometry"))).toBe(false);
  });
  it("does not grant public/fact authority to a monitoring-only source", async () => {
    const monitoring = { ...source, page_metadata: { baseline_facts: { award_relevance: "primary", confidence: "high", cycle_relevance: "unclear", quality_flags: [] } },
      admin_review_note: "monitoring_restore_v1 synthetic only", admin_reviewed_by: "reviewer@example.test", admin_reviewed_at: "2026-10-20T00:00:00.000Z" };
    expect(sourceQualityDecision(monitoring, { purpose: "monitoring" }).allowed).toBe(true);
    expect(sourceQualityDecision(monitoring, { purpose: "public" }).allowed).toBe(false);
    expect(sourceQualityDecision(monitoring, { purpose: "facts" }).allowed).toBe(false);
    const f = await fixture(), evidence = await f.run(undefined, monitoring);
    expect(evidence.verified_at).toBeNull(); expect(evidence.localization.sides.current.semantic_verified).toBe(false);
  });
  it.each(["added", "removed"])("preserves %s-only direction and its nonrequired side", async direction => {
    const f = await fixture(), evidence = await f.run(direction === "added" ? { exact_after: "October 30, 2027" } : { exact_before: "October 23, 2027" });
    const optional = direction === "added" ? "previous" : "current";
    expect(evidence.localization.direction).toBe(direction);
    expect(evidence.localization.sides[optional].required).toBe(false);
    expect(evidence.localization.sides[optional].status).toMatch(/^unavailable_not_required_/);
    expect(evidence.previous_capture.crop).toBeNull(); expect(evidence.current_capture.crop).toBeNull();
  });
  it.each([
    ["missing projection", m => { delete m.retained_artifact_projection; }],
    ["legacy profile", m => { m.capture_profile = "discovery"; }],
    ["wrong source", m => { m.source.id = source.shared_award_id; }],
    ["wrong owner", m => { m.source.shared_award_id = source.id; }],
    ["wrong URL", m => { m.source.url += "/foreign"; }],
    ["wrong text hash", m => { m.text_hash = "0".repeat(64); }],
    ["wrong image hash", m => { m.image_hash = "0".repeat(64); }],
    ["native text mutation", m => { m.scrapling.visible_text += " hidden change"; }],
    ["screenshot metadata digest", m => { m.scrapling.integrity.screenshot_metadata_sha256 = "0".repeat(64); }],
    ["formerly ready geometry", m => { m.text_geometry = { status: "ready" }; }],
    ["declared layout", m => { m.files.layout = "layout.json"; }],
    ["expansion count", m => { m.expansion_state_count = 1; }],
    ["excluded expansion", m => { m.retained_artifact_projection.diagnostics.excluded_state_count = 1; }],
    ["formerly present layout", m => { m.retained_artifact_projection.diagnostics.main_layout.present = true; }],
  ])("rejects raw-resealed %s before any upload", async (_label, mutate) => {
    const f = await fixture(); seal(f, "previous", mutate);
    await expect(f.run()).rejects.toMatchObject({ code: "visual_state_geometry_missing" });
    expect(f.puts).toHaveLength(0);
  });
  it.each(["localization", "dimensions", "status_code"])("rejects missing current %s rather than borrowing previous omissions", async field => {
    const f = await fixture(); f.candidate.new_snapshot_ref.metadata[field] = null; seal(f, "current");
    await expect(f.run()).rejects.toMatchObject({ code: "visual_state_geometry_missing" });
  });
  it("rejects an unsupported worker behavior contract", async () => {
    const f = await fixture(); f.candidate.worker_metadata.capture_behavior_version = 13;
    await expect(f.run()).rejects.toMatchObject({ code: "visual_state_geometry_missing" }); expect(f.puts).toHaveLength(0);
  });
  it("retains raw-manifest refusal for an unsealed metadata edit", async () => {
    const f = await fixture(); writeFileSync(f.candidate.previous_snapshot_ref.local_paths.meta.path, "{}");
    await expect(f.run()).rejects.toMatchObject({ code: "visual_artifact_byte_length_mismatch" }); expect(f.puts).toHaveLength(0);
  });
  it("checks JPEG pixel dimensions rather than self-consistent declarations", async () => {
    const f = await fixture(); seal(f, "previous", m => {
      m.dimensions.width++; m.scrapling.screenshot.width++;
      m.scrapling.integrity.screenshot_metadata_sha256 = sha(JSON.stringify(m.scrapling.screenshot));
    });
    await expect(f.run()).rejects.toMatchObject({ code: "visual_profile_image_dimensions_mismatch" }); expect(f.puts).toHaveLength(0);
  });
  it("rejects corrupt compressed pixels behind a valid JPEG frame header", async () => {
    const f = await fixture(), bytes = jpeg.subarray(0, Math.floor(jpeg.length / 2));
    await expect(sharp(bytes).metadata()).resolves.toMatchObject({ format: "jpeg", width: 320, height: 200 });
    replaceImage(f, bytes);
    await expect(f.run()).rejects.toMatchObject({ code: "visual_profile_image_decode_invalid" }); expect(f.puts).toHaveLength(0);
  });
});
