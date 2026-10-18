import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { preparePublishedVisualEventEvidence } from "./visual-event-evidence.mjs";
import { visualSnapshotArtifactManifest } from "./visual-review-queue.mjs";

const temporary = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
function artifact(path) {
  const bytes = readFileSync(path);
  return { path, exists: true, sha256: sha(bytes), bytes: bytes.length, byte_length: bytes.length };
}
function seal(capture) {
  writeFileSync(capture.metaPath, JSON.stringify(capture.meta));
  capture.ref.local_paths.meta = artifact(capture.metaPath);
  capture.ref.artifact_manifest = visualSnapshotArtifactManifest(capture.ref);
  capture.ref.artifact_manifest_digest = capture.ref.artifact_manifest.digest;
}
async function capture(root, side, text) {
  const dir = join(root, side); mkdirSync(dir);
  const page = join(dir, "page.jpg"), textPath = join(dir, "text.txt"), metaPath = join(dir, "meta.json");
  const bytes = await sharp({ create: { width: 320, height: 200, channels: 3, background: "white" } }).jpeg().toBuffer();
  writeFileSync(page, bytes); writeFileSync(textPath, text);
  const unavailable = { status: "unavailable_no_visible_text_nodes", geometry_hash: null, file: null, node_count: 0, run_count: 0, screenshot: { image_hash: null } };
  const meta = { kind: "webpage", source: { id: "source-1" }, captured_at: "2026-08-21T16:13:34.413Z",
    image_hash: sha(bytes), text_hash: sha(text), layout_hash: null, files: { layout: null, expansion_states: [] },
    expansion_state_count: 0, expansion_state_screenshots: [],
    text_geometry: structuredClone(unavailable), localization: { status: "evidence_only_geometry_unavailable", exact: false, geometry_ready: false, geometry_hash: null, bound_image_hash: null } };
  const ref = { kind: "webpage", captured_at: meta.captured_at, image_hash: meta.image_hash, text_hash: meta.text_hash, layout_hash: null,
    metadata: { text_geometry: structuredClone(unavailable) }, local_paths: { page: artifact(page), text: artifact(textPath), layout: null },
    visual_states: [{ state_id: "main", kind: "main", image_hash: meta.image_hash, geometry_hash: null, local_paths: { image: artifact(page), layout: null } }] };
  const result = { metaPath, meta, ref }; seal(result); return result;
}
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "awardping-unavailable-geometry-")); temporary.push(root);
  const previous = await capture(root, "previous", "Deadline February 1");
  const current = await capture(root, "current", "Deadline March 1");
  const objects = new Map(), puts = [];
  const store = { bucket: "test", put: async value => { puts.push(value); objects.set(value.key, value); },
    head: async ({ key }) => { const value = objects.get(key); return { sha256: value.sha256, byte_length: value.body.length, content_type: value.contentType }; } };
  const candidate = () => ({ id: "candidate-1", candidate_signature: "signature-1", shared_award_source_id: "source-1", shared_award_id: "award-1",
    previous_image_hash: previous.ref.image_hash, new_image_hash: current.ref.image_hash,
    previous_text_hash: previous.ref.text_hash, new_text_hash: current.ref.text_hash,
    previous_snapshot_ref: previous.ref, new_snapshot_ref: current.ref,
    prompt_payload: { hashes: { previous_artifact_manifest_digest: previous.ref.artifact_manifest_digest, new_artifact_manifest_digest: current.ref.artifact_manifest_digest } } });
  return { previous, current, puts, run: () => preparePublishedVisualEventEvidence({ candidate: candidate(), source: { id: "source-1", shared_award_id: "award-1" },
    archiveRoot: root, artifactStore: store, changeDetails: { exact_before: "Deadline February 1", exact_after: "Deadline March 1" } }) };
}

describe("sealed intentionally unavailable main geometry", () => {
  it.each([
    ["unavailable_layout_changed_during_screenshot", "unavailable_layout_changed_during_screenshot"],
    ["unavailable_retained_geometry_verification", "evidence_only_geometry_unavailable"],
  ])("accepts the sealed R2 projection %s only with its matching localization", async (refStatus, localizationStatus) => {
    const f = await fixture();
    f.current.ref.metadata.text_geometry.status = refStatus;
    f.current.meta.localization.status = localizationStatus;
    f.current.ref.metadata.localization = structuredClone(f.current.meta.localization);
    seal(f.current);
    const evidence = await f.run();
    expect(evidence.evidence_status).toBe("unavailable_geometry_missing");
    expect(evidence.current_capture.full.sha256).toBe(f.current.ref.image_hash);
    expect(evidence.current_capture.crop).toBeNull();
    expect(evidence.current_capture.layout).toBeNull();
    expect(evidence.verified_at).toBeNull();
  });

  it.each(["evidence_only_geometry_unavailable", "unavailable_layout_changed_during_screenshot"])("retains full byte-bound screenshots for %s, never a crop", async status => {
    const f = await fixture(); f.previous.meta.localization.status = status; seal(f.previous);
    const evidence = await f.run();
    expect(evidence.evidence_status).toBe("unavailable_geometry_missing");
    expect(evidence.verified_at).toBeNull();
    for (const side of ["previous", "current"]) {
      const capture = evidence[`${side}_capture`], localization = evidence.localization.sides[side];
      expect(capture.full.sha256).toBe(f[side].ref.image_hash);
      expect(capture.text.sha256).toBe(f[side].ref.local_paths.text.sha256);
      expect(capture.metadata.sha256).toBe(f[side].ref.local_paths.meta.sha256);
      expect(capture.crop).toBeNull(); expect(capture.layout).toBeNull();
      expect(capture.states).toHaveLength(1); expect(capture.states[0].geometry).toBeNull();
      expect(localization.exact_overlap).toBe(false); expect(localization.semantic_verified).toBe(false);
    }
    expect(f.puts.some(value => value.key.includes("crop") || value.key.includes("geometry"))).toBe(false);
  });

  it.each([
    ["unsealed status", f => { delete f.ref.metadata.text_geometry; }],
    ["ready original metadata", f => { f.meta.text_geometry.status = "ready"; }],
    ["unknown unavailable reason", f => { f.meta.localization.status = "unknown"; }],
    ["wrong projected layout reason", f => { f.ref.metadata.text_geometry.status = "unavailable_layout_changed_during_screenshot"; f.ref.metadata.localization = structuredClone(f.meta.localization); }],
    ["wrong projected retained reason", f => { f.ref.metadata.text_geometry.status = "unavailable_retained_geometry_verification"; f.meta.localization.status = "unavailable_layout_changed_during_screenshot"; f.ref.metadata.localization = structuredClone(f.meta.localization); }],
    ["unpaired projected reason", f => { f.ref.metadata.text_geometry.status = "unavailable_retained_geometry_verification"; }],
    ["unknown geometry unavailable prefix", f => { f.ref.metadata.text_geometry.status = "unavailable_unknown"; }],
    ["claimed exact localization", f => { f.meta.localization.exact = true; }],
    ["claimed ready localization", f => { f.meta.localization.geometry_ready = true; }],
    ["declared semantic geometry hash", f => { f.ref.layout_hash = "a".repeat(64); }],
    ["declared original layout", f => { f.meta.files.layout = "layout.json"; }],
    ["declared state geometry hash", f => { f.ref.visual_states[0].geometry_hash = "a".repeat(64); }],
    ["missing null declaration", f => { delete f.ref.visual_states[0].local_paths.layout; }],
    ["positive node count", f => { f.meta.text_geometry.node_count = 1; }],
    ["malformed nodes", f => { f.meta.text_geometry.nodes = { text: "not empty" }; }],
    ["malformed runs", f => { f.meta.text_geometry.runs = "not empty"; }],
    ["nonempty runs", f => { f.meta.text_geometry.runs = [{ text: "wording" }]; }],
    ["malformed screenshot", f => { f.meta.text_geometry.screenshot = false; }],
    ["false screenshot hash", f => { f.meta.text_geometry.screenshot.image_hash = false; }],
    ["false geometry file", f => { f.meta.text_geometry.file = false; }],
    ["false layout path", f => { f.meta.layout_path = false; }],
    ["false localization hash", f => { f.meta.localization.bound_image_hash = false; }],
    ["contradictory reference localization", f => { f.ref.metadata.localization = { status: "verified", exact: true }; }],
    ["malformed reference localization", f => { f.ref.metadata.localization = false; }],
    ["original omitted expansion count", f => { f.meta.expansion_state_count = 1; }],
    ["original omitted expansion screenshot", f => { f.meta.expansion_state_screenshots = [{ state_id: "expansion-state-01" }]; }],
    ["original omitted expansion files", f => { f.meta.files.expansion_states = [{ page: "expansion.jpg" }]; }],
    ["unfulfilled expansion persistence", f => { f.meta.persist_expansion_state_screenshots = true; }],
    ["wrong metadata source", f => { f.meta.source.id = "different-source"; }],
    ["wrong metadata image hash", f => { f.meta.image_hash = "a".repeat(64); }],
    ["wrong metadata text hash", f => { f.meta.text_hash = "a".repeat(64); }],
    ["missing text evidence", f => { delete f.ref.local_paths.text; }],
    ["additional unverified expansion", f => { f.ref.visual_states.push({ ...f.ref.visual_states[0], state_id: "expansion-state-01", kind: "expansion_state" }); }],
  ])("rejects %s before uploading", async (_label, mutate) => {
    const f = await fixture(); mutate(f.previous); seal(f.previous);
    await expect(f.run()).rejects.toThrow();
    expect(f.puts).toHaveLength(0);
  });

  it("does not relax the existing artifact-manifest and raw-byte checks", async () => {
    const f = await fixture();
    writeFileSync(f.previous.ref.local_paths.text.path, "Changed after sealing");
    await expect(f.run()).rejects.toThrow(/changed after review/);
    expect(f.puts).toHaveLength(0);
  });

  it("does not accept a missing sealed manifest", async () => {
    const f = await fixture(); delete f.previous.ref.artifact_manifest;
    await expect(f.run()).rejects.toThrow(/manifest is incomplete/);
    expect(f.puts).toHaveLength(0);
  });
});
