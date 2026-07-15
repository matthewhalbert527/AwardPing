import crypto from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { bindVisualTextGeometry } from "./visual-event-localization.mjs";
import {
  PUBLISHED_VISUAL_EVIDENCE_PREFIX,
  preparePublishedVisualEventEvidence,
  publishedVisualEvidenceObjectKey,
  visualStateGeometryMatchesImage,
} from "./visual-event-evidence.mjs";
import { visualSnapshotArtifactManifest } from "./visual-review-queue.mjs";

const temporary = [];
afterEach(() => {
  while (temporary.length) rmSync(temporary.pop(), { recursive: true, force: true });
});

describe("published visual event evidence", () => {
  it("creates real directional crops and verifies every permanent upload", async () => {
    const archiveRoot = mkdtempSync(join(tmpdir(), "awardping-event-evidence-"));
    temporary.push(archiveRoot);
    const previous = await captureFixture(archiveRoot, "previous", "Deadline February 1");
    const current = await captureFixture(archiveRoot, "current", "Deadline March 1");
    const store = memoryStore();
    const candidate = candidateFixture(previous, current);

    const evidence = await preparePublishedVisualEventEvidence({
      candidate,
      source: { id: "source-1", shared_award_id: "award-1" },
      changeDetails: {
        exact_before: "Deadline February 1",
        exact_after: "Deadline March 1",
      },
      archiveRoot,
      artifactStore: store,
    });

    expect(evidence.evidence_status).toBe("verified");
    expect(evidence.localization.direction).toBe("mixed");
    expect(evidence.localization.sides.previous).toMatchObject({
      status: "verified",
      exact_overlap: true,
      exact_text: "Deadline February 1",
    });
    expect(evidence.previous_capture.crop).toMatchObject({
      exact_overlap: true,
      state_id: "main",
      source_image_object_key: evidence.previous_capture.full.object_key,
      source_image_sha256: evidence.previous_capture.full.sha256,
      source_image_byte_length: evidence.previous_capture.full.byte_length,
    });
    expect(evidence.current_capture.crop.object_key).toContain(
      `${PUBLISHED_VISUAL_EVIDENCE_PREFIX}/candidate-1/current/changed-section-crop/`,
    );
    expect(store.putCalls.length).toBeGreaterThanOrEqual(10);
    expect(store.headCalls).toEqual(store.putCalls.map((item) => item.key));
  });

  it("derives the permanent full image and crop from one verified buffer", async () => {
    const archiveRoot = mkdtempSync(join(tmpdir(), "awardping-event-single-image-read-"));
    temporary.push(archiveRoot);
    const previous = await captureFixture(archiveRoot, "previous", "Deadline February 1");
    const current = await captureFixture(archiveRoot, "current", "Deadline March 1");
    const previousPagePath = previous.ref.local_paths.page.path;
    const replacement = await sharp({
      create: { width: 800, height: 600, channels: 3, background: "black" },
    }).jpeg().toBuffer();
    let replaced = false;
    const store = memoryStore({
      onHead: async ({ key }) => {
        if (!replaced && key.includes("/candidate-1/previous/main-full/")) {
          writeFileSync(previousPagePath, replacement);
          replaced = true;
        }
      },
    });

    const evidence = await preparePublishedVisualEventEvidence({
      candidate: candidateFixture(previous, current),
      source: { id: "source-1", shared_award_id: "award-1" },
      changeDetails: { exact_before: "Deadline February 1", exact_after: "Deadline March 1" },
      archiveRoot,
      artifactStore: store,
    });

    expect(replaced).toBe(true);
    expect(sha(readFileSync(previousPagePath))).toBe(sha(replacement));
    expect(sha(replacement)).not.toBe(evidence.previous_capture.full.sha256);
    const fullUpload = store.putCalls.find((item) =>
      item.key === evidence.previous_capture.full.object_key
    );
    const cropUpload = store.putCalls.find((item) =>
      item.key === evidence.previous_capture.crop.object_key
    );
    const expectedCrop = await sharp(fullUpload.body).extract({
      left: evidence.previous_capture.crop.clip.x,
      top: evidence.previous_capture.crop.clip.y,
      width: evidence.previous_capture.crop.clip.width,
      height: evidence.previous_capture.crop.clip.height,
    }).jpeg({ quality: 92 }).toBuffer();
    expect(sha(cropUpload.body)).toBe(sha(expectedCrop));
    expect(evidence.previous_capture.crop).toMatchObject({
      source_image_object_key: evidence.previous_capture.full.object_key,
      source_image_sha256: evidence.previous_capture.full.sha256,
      source_image_byte_length: evidence.previous_capture.full.byte_length,
    });
  });

  it("uses an opened accordion screenshot when the wording is absent from main", async () => {
    const archiveRoot = mkdtempSync(join(tmpdir(), "awardping-event-accordion-"));
    temporary.push(archiveRoot);
    const previous = await captureFixture(archiveRoot, "previous", "General information", {
      expansionText: "Applications close February 1",
    });
    const current = await captureFixture(archiveRoot, "current", "General information", {
      expansionText: "Applications close March 1",
    });
    const evidence = await preparePublishedVisualEventEvidence({
      candidate: candidateFixture(previous, current),
      source: { id: "source-1", shared_award_id: "award-1" },
      changeDetails: {
        exact_before: "Applications close February 1",
        exact_after: "Applications close March 1",
      },
      archiveRoot,
      artifactStore: memoryStore(),
    });

    expect(evidence.previous_capture.state_id).toBe("expansion-state-01");
    expect(evidence.previous_capture.full.object_key).toContain("state-expansion-state-01");
    expect(evidence.previous_capture.crop.state_id).toBe("expansion-state-01");
  });

  it("falls back to that event's full image when exact geometry is unavailable", async () => {
    const archiveRoot = mkdtempSync(join(tmpdir(), "awardping-event-fallback-"));
    temporary.push(archiveRoot);
    const previous = await captureFixture(archiveRoot, "previous", "Unrelated wording");
    const current = await captureFixture(archiveRoot, "current", "Still unrelated");
    const evidence = await preparePublishedVisualEventEvidence({
      candidate: candidateFixture(previous, current),
      source: { id: "source-1", shared_award_id: "award-1" },
      changeDetails: {
        exact_before: "Deadline February 1",
        exact_after: "Deadline March 1",
      },
      archiveRoot,
      artifactStore: memoryStore(),
    });

    expect(evidence.evidence_status).toBe("unavailable_exact_text_missing");
    expect(evidence.previous_capture.full.object_key).toContain("main-full");
    expect(evidence.previous_capture.crop).toBeNull();
    expect(evidence.localization.sides.previous.status).toBe("unavailable_exact_text_not_found");
  });

  it("rejects a screenshot whose bytes do not match the candidate hash", async () => {
    const archiveRoot = mkdtempSync(join(tmpdir(), "awardping-event-mismatch-"));
    temporary.push(archiveRoot);
    const previous = await captureFixture(archiveRoot, "previous", "Deadline February 1");
    const current = await captureFixture(archiveRoot, "current", "Deadline March 1");
    previous.ref.image_hash = "0".repeat(64);
    previous.ref.visual_states[0].image_hash = "0".repeat(64);
    const candidate = candidateFixture(previous, current);
    candidate.previous_image_hash = "0".repeat(64);

    await expect(preparePublishedVisualEventEvidence({
      candidate,
      source: { id: "source-1", shared_award_id: "award-1" },
      changeDetails: { exact_before: "Deadline February 1", exact_after: "Deadline March 1" },
      archiveRoot,
      artifactStore: memoryStore(),
    })).rejects.toThrow("hash mismatch");
  });

  it("rejects a candidate state that is not bound to an image hash", async () => {
    const archiveRoot = mkdtempSync(join(tmpdir(), "awardping-event-state-hash-missing-"));
    temporary.push(archiveRoot);
    const previous = await captureFixture(archiveRoot, "previous", "Deadline February 1");
    const current = await captureFixture(archiveRoot, "current", "Deadline March 1");
    previous.ref.visual_states[0].image_hash = null;
    refreshRefManifest(previous.ref);
    const store = memoryStore();

    await expect(preparePublishedVisualEventEvidence({
      candidate: candidateFixture(previous, current),
      source: { id: "source-1", shared_award_id: "award-1" },
      changeDetails: { exact_before: "Deadline February 1", exact_after: "Deadline March 1" },
      archiveRoot,
      artifactStore: store,
    })).rejects.toThrow("visual state main image manifest is incomplete");
    expect(store.putCalls).toHaveLength(0);
  });

  it("rejects a candidate geometry hash that differs from the loaded bound geometry", async () => {
    const archiveRoot = mkdtempSync(join(tmpdir(), "awardping-event-geometry-hash-mismatch-"));
    temporary.push(archiveRoot);
    const previous = await captureFixture(archiveRoot, "previous", "Deadline February 1");
    const current = await captureFixture(archiveRoot, "current", "Deadline March 1");
    previous.ref.visual_states[0].geometry_hash = "0".repeat(64);
    refreshRefManifest(previous.ref);
    const store = memoryStore();

    await expect(preparePublishedVisualEventEvidence({
      candidate: candidateFixture(previous, current),
      source: { id: "source-1", shared_award_id: "award-1" },
      changeDetails: { exact_before: "Deadline February 1", exact_after: "Deadline March 1" },
      archiveRoot,
      artifactStore: store,
    })).rejects.toThrow("visual state main geometry hash mismatch");
    expect(store.putCalls).toHaveLength(0);
  });

  it.each(["meta", "layout"])(
    "preflights same-length %s replacements before any permanent upload",
    async (role) => {
      const archiveRoot = mkdtempSync(join(tmpdir(), `awardping-event-${role}-tamper-`));
      temporary.push(archiveRoot);
      const previous = await captureFixture(archiveRoot, "previous", "Deadline February 1");
      const current = await captureFixture(archiveRoot, "current", "Deadline March 1");
      const candidate = candidateFixture(previous, current);
      const path = previous.ref.local_paths[role].path;
      const replacement = Buffer.from(readFileSync(path));
      replacement[replacement.length - 1] = replacement[replacement.length - 1] === 0x20 ? 0x21 : 0x20;
      writeFileSync(path, replacement);
      const store = memoryStore();

      await expect(preparePublishedVisualEventEvidence({
        candidate,
        source: { id: "source-1", shared_award_id: "award-1" },
        changeDetails: { exact_before: "Deadline February 1", exact_after: "Deadline March 1" },
        archiveRoot,
        artifactStore: store,
      })).rejects.toThrow("bytes changed after review");
      expect(store.putCalls).toHaveLength(0);
    },
  );

  it("uses archive-relative artifacts when a stored worker absolute path is stale", async () => {
    const archiveRoot = mkdtempSync(join(tmpdir(), "awardping-event-relocated-"));
    temporary.push(archiveRoot);
    const previous = await captureFixture(archiveRoot, "previous", "Deadline February 1");
    const current = await captureFixture(archiveRoot, "current", "Deadline March 1");
    for (const ref of [previous.ref, current.ref]) relocateSnapshotRef(ref, archiveRoot);

    const evidence = await preparePublishedVisualEventEvidence({
      candidate: candidateFixture(previous, current),
      source: { id: "source-1", shared_award_id: "award-1" },
      changeDetails: { exact_before: "Deadline February 1", exact_after: "Deadline March 1" },
      archiveRoot,
      artifactStore: memoryStore(),
    });

    expect(evidence.evidence_status).toBe("verified");
  });

  it("builds content-addressed permanent keys", () => {
    expect(publishedVisualEvidenceObjectKey({
      candidateId: "candidate-1",
      side: "previous",
      role: "main full",
      sha256: "a".repeat(64),
      extension: "jpg",
    })).toBe(`${PUBLISHED_VISUAL_EVIDENCE_PREFIX}/candidate-1/previous/main-full/${"a".repeat(64)}.jpg`);
  });

  it("rejects geometry whose bound screenshot dimensions differ from the actual image", () => {
    const imageHash = "a".repeat(64);
    const boundGeometry = geometry("Changed wording", imageHash);
    expect(visualStateGeometryMatchesImage(boundGeometry, {
      sha256: imageHash,
      width: 800,
      height: 601,
    })).toBe(false);
    expect(visualStateGeometryMatchesImage(boundGeometry, {
      sha256: imageHash,
      width: 800,
      height: 600,
    })).toBe(true);
    expect(visualStateGeometryMatchesImage(boundGeometry, {
      sha256: "b".repeat(64),
      width: 800,
      height: 600,
    })).toBe(false);
  });

  it("fails publication when any candidate-referenced image state is missing", async () => {
    const archiveRoot = mkdtempSync(join(tmpdir(), "awardping-event-missing-state-"));
    temporary.push(archiveRoot);
    const previous = await captureFixture(archiveRoot, "previous", "Deadline February 1");
    const current = await captureFixture(archiveRoot, "current", "Deadline March 1");
    previous.ref.visual_states.push({
      state_id: "expansion-state-missing",
      kind: "expansion_state",
      image_hash: "a".repeat(64),
      local_paths: {
        image: {
          path: join(archiveRoot, "missing-expansion.jpg"),
          sha256: "a".repeat(64),
          byte_length: 100,
        },
      },
    });
    refreshRefManifest(previous.ref);
    const candidate = candidateFixture(previous, current);

    await expect(preparePublishedVisualEventEvidence({
      candidate,
      source: { id: "source-1", shared_award_id: "award-1" },
      changeDetails: { exact_before: "Deadline February 1", exact_after: "Deadline March 1" },
      archiveRoot,
      artifactStore: memoryStore(),
    })).rejects.toThrow("visual state expansion-state-missing image is missing at publication");
  });

  it("fails publication instead of dropping a duplicate candidate state ID", async () => {
    const archiveRoot = mkdtempSync(join(tmpdir(), "awardping-event-duplicate-state-"));
    temporary.push(archiveRoot);
    const previous = await captureFixture(archiveRoot, "previous", "Deadline February 1");
    const current = await captureFixture(archiveRoot, "current", "Deadline March 1");
    previous.ref.visual_states.push({ ...previous.ref.visual_states[0] });
    refreshRefManifest(previous.ref);

    await expect(preparePublishedVisualEventEvidence({
      candidate: candidateFixture(previous, current),
      source: { id: "source-1", shared_award_id: "award-1" },
      changeDetails: { exact_before: "Deadline February 1", exact_after: "Deadline March 1" },
      archiveRoot,
      artifactStore: memoryStore(),
    })).rejects.toThrow("duplicate visual state IDs: main");
  });

  it("retains both PDF documents and metadata with candidate-bound byte hashes", async () => {
    const archiveRoot = mkdtempSync(join(tmpdir(), "awardping-event-pdf-"));
    temporary.push(archiveRoot);
    const previous = pdfCaptureFixture(archiveRoot, "previous", "old document");
    const current = pdfCaptureFixture(archiveRoot, "current", "new document");
    const store = memoryStore();

    const evidence = await preparePublishedVisualEventEvidence({
      candidate: pdfCandidateFixture(previous, current),
      source: { id: "source-1", shared_award_id: "award-1" },
      changeDetails: {},
      archiveRoot,
      artifactStore: store,
    });

    expect(evidence.evidence_status).toBe("not_applicable_pdf");
    expect(evidence.previous_capture).toMatchObject({
      kind: "pdf",
      state_id: "document",
      full: { sha256: previous.hash, content_type: "application/pdf" },
      metadata: { content_type: "application/json; charset=utf-8" },
      capture_hashes: { file_hash: previous.hash },
    });
    expect(evidence.current_capture.full.sha256).toBe(current.hash);
    expect(store.putCalls).toHaveLength(4);
  });

  it("fails closed when PDF bytes differ from the candidate-bound file hash", async () => {
    const archiveRoot = mkdtempSync(join(tmpdir(), "awardping-event-pdf-mismatch-"));
    temporary.push(archiveRoot);
    const previous = pdfCaptureFixture(archiveRoot, "previous", "old document");
    const current = pdfCaptureFixture(archiveRoot, "current", "new document");

    await expect(preparePublishedVisualEventEvidence({
      candidate: pdfCandidateFixture(previous, current, {
        previous_file_hash: "0".repeat(64),
      }),
      source: { id: "source-1", shared_award_id: "award-1" },
      changeDetails: {},
      archiveRoot,
      artifactStore: memoryStore(),
    })).rejects.toThrow("PDF semantic hash mismatch");
  });

  it("retains the good historical side when the other side fails artifact verification", async () => {
    const archiveRoot = mkdtempSync(join(tmpdir(), "awardping-event-partial-history-"));
    temporary.push(archiveRoot);
    const previous = await captureFixture(archiveRoot, "previous", "Deadline February 1");
    const current = await captureFixture(archiveRoot, "current", "Deadline March 1");
    const candidate = candidateFixture(previous, current);
    candidate.previous_image_hash = "0".repeat(64);

    const evidence = await preparePublishedVisualEventEvidence({
      candidate,
      source: { id: "source-1", shared_award_id: "award-1" },
      changeDetails: { exact_before: "Deadline February 1", exact_after: "Deadline March 1" },
      archiveRoot,
      artifactStore: memoryStore(),
      historical: true,
    });

    expect(evidence.evidence_status).toBe("unavailable_image_missing");
    expect(evidence.previous_capture.full).toBeNull();
    expect(evidence.localization.sides.previous.status).toBe("unavailable_image_missing");
    expect(evidence.current_capture.full).toMatchObject({ content_type: "image/jpeg" });
    expect(evidence.current_capture.metadata).toMatchObject({ content_type: "application/json; charset=utf-8" });
  });

  it("keeps historical storage outages retryable instead of recording missing artifacts", async () => {
    const archiveRoot = mkdtempSync(join(tmpdir(), "awardping-event-history-storage-error-"));
    temporary.push(archiveRoot);
    const previous = await captureFixture(archiveRoot, "previous", "Deadline February 1");
    const current = await captureFixture(archiveRoot, "current", "Deadline March 1");
    const store = memoryStore();
    store.put = async () => {
      throw new Error("R2 temporarily unavailable");
    };

    await expect(preparePublishedVisualEventEvidence({
      candidate: candidateFixture(previous, current),
      source: { id: "source-1", shared_award_id: "award-1" },
      changeDetails: { exact_before: "Deadline February 1", exact_after: "Deadline March 1" },
      archiveRoot,
      artifactStore: store,
      historical: true,
    })).rejects.toThrow("R2 temporarily unavailable");
  });
});

async function captureFixture(archiveRoot, side, mainText, { expansionText = null } = {}) {
  const dir = join(archiveRoot, side);
  mkdirSync(dir, { recursive: true });
  const mainPath = join(dir, "page.jpg");
  const mainBuffer = await sharp({
    create: { width: 800, height: 600, channels: 3, background: "white" },
  }).jpeg().toBuffer();
  writeFileSync(mainPath, mainBuffer);
  const mainHash = sha(mainBuffer);
  const mainLayoutPath = join(dir, "layout.json");
  const mainGeometry = geometry(mainText, mainHash);
  writeFileSync(mainLayoutPath, JSON.stringify(mainGeometry));
  const thumbPath = join(dir, "thumb.jpg");
  writeFileSync(thumbPath, mainBuffer);
  const metaPath = join(dir, "meta.json");
  writeFileSync(metaPath, JSON.stringify({ kind: "webpage", captured_at: "2026-07-15T12:00:00.000Z" }));
  const textPath = join(dir, "text.txt");
  writeFileSync(textPath, mainText);
  const visualStates = [stateRef("main", "main", mainPath, mainLayoutPath, mainHash, mainGeometry)];
  if (expansionText) {
    const expansionPath = join(dir, "expansion.jpg");
    const expansionBuffer = await sharp({
      create: { width: 800, height: 800, channels: 3, background: "white" },
    }).jpeg().toBuffer();
    writeFileSync(expansionPath, expansionBuffer);
    const expansionHash = sha(expansionBuffer);
    const expansionLayoutPath = join(dir, "expansion-layout.json");
    const expansionGeometry = geometry(expansionText, expansionHash, 300, 800);
    writeFileSync(expansionLayoutPath, JSON.stringify(expansionGeometry));
    visualStates.push(stateRef(
      "expansion-state-01",
      "expansion_state",
      expansionPath,
      expansionLayoutPath,
      expansionHash,
      expansionGeometry,
    ));
  }
  const ref = {
      captured_at: "2026-07-15T12:00:00.000Z",
      kind: "webpage",
      image_hash: mainHash,
      text_hash: sha(Buffer.from(mainText)),
      local_paths: {
        page: artifactPathRef(mainPath),
        thumb: artifactPathRef(thumbPath),
        text: artifactPathRef(textPath),
        meta: artifactPathRef(metaPath),
        layout: artifactPathRef(mainLayoutPath),
      },
      layout_hash: mainGeometry.geometry_hash,
      visual_states: visualStates,
  };
  refreshRefManifest(ref);
  return {
    hash: mainHash,
    ref,
  };
}

function stateRef(stateId, kind, imagePath, layoutPath, imageHash, boundGeometry) {
  return {
    state_id: stateId,
    kind,
    image_hash: imageHash,
    geometry_hash: boundGeometry.geometry_hash,
    local_paths: { image: artifactPathRef(imagePath), layout: artifactPathRef(layoutPath) },
  };
}

function geometry(text, imageHash, y = 120, height = 600) {
  return bindVisualTextGeometry({
    document: { width: 800, height },
    viewport: { width: 800, height: 600 },
    device_pixel_ratio: 1,
    nodes: [{
      order: 0,
      text,
      runs: [{ start: 0, end: text.length, text, rects: [{ x: 100, y, width: 280, height: 24 }] }],
    }],
  }, {
    imageHash,
    screenshot: { css_width: 800, css_height: height, pixel_width: 800, pixel_height: height },
  });
}

function candidateFixture(previous, current) {
  return {
    id: "candidate-1",
    candidate_signature: "candidate-signature-1",
    shared_award_id: "award-1",
    shared_award_source_id: "source-1",
    previous_image_hash: previous.hash,
    new_image_hash: current.hash,
    previous_snapshot_ref: previous.ref,
    new_snapshot_ref: current.ref,
    prompt_payload: {
      hashes: {
        previous_artifact_manifest_digest: previous.ref.artifact_manifest_digest,
        new_artifact_manifest_digest: current.ref.artifact_manifest_digest,
      },
    },
    deterministic_diff: {},
  };
}

function pdfCandidateFixture(previous, current, overrides = {}) {
  return {
    id: "candidate-pdf",
    candidate_signature: "candidate-signature-pdf",
    shared_award_id: "award-1",
    shared_award_source_id: "source-1",
    previous_file_hash: previous.hash,
    new_file_hash: current.hash,
    previous_snapshot_ref: previous.ref,
    new_snapshot_ref: current.ref,
    prompt_payload: {
      hashes: {
        previous_artifact_manifest_digest: previous.ref.artifact_manifest_digest,
        new_artifact_manifest_digest: current.ref.artifact_manifest_digest,
      },
    },
    ...overrides,
  };
}

function pdfCaptureFixture(archiveRoot, side, contents) {
  const dir = join(archiveRoot, side);
  mkdirSync(dir, { recursive: true });
  const pdfPath = join(dir, "document.pdf");
  const pdf = Buffer.from(`%PDF-1.4\n${contents}\n%%EOF\n`);
  writeFileSync(pdfPath, pdf);
  const metaPath = join(dir, "meta.json");
  writeFileSync(metaPath, JSON.stringify({ kind: "pdf", captured_at: "2026-07-15T12:00:00.000Z" }));
  const hash = sha(pdf);
  const ref = {
      captured_at: "2026-07-15T12:00:00.000Z",
      kind: "pdf",
      file_hash: hash,
      local_paths: {
        pdf: artifactPathRef(pdfPath),
        meta: artifactPathRef(metaPath),
      },
  };
  refreshRefManifest(ref);
  return {
    hash,
    ref,
  };
}

function memoryStore({ onHead = null } = {}) {
  const objects = new Map();
  return {
    bucket: "test-bucket",
    putCalls: [],
    headCalls: [],
    async put(value) {
      this.putCalls.push(value);
      objects.set(value.key, value);
    },
    async head({ key }) {
      this.headCalls.push(key);
      const value = objects.get(key);
      if (onHead) await onHead({ key, value });
      return {
        byte_length: value.body.length,
        content_type: value.contentType,
        sha256: value.sha256,
      };
    },
  };
}

function sha(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function artifactPathRef(path) {
  const body = readFileSync(path);
  return {
    path,
    sha256: sha(body),
    byte_length: body.length,
    bytes: body.length,
  };
}

function refreshRefManifest(ref) {
  const manifest = visualSnapshotArtifactManifest(ref);
  ref.artifact_manifest = manifest;
  ref.artifact_manifest_digest = manifest.digest;
  return ref;
}

function relocateSnapshotRef(ref, archiveRoot) {
  const refs = [
    ...Object.values(ref.local_paths || {}),
    ...(ref.visual_states || []).flatMap((state) => Object.values(state.local_paths || {})),
  ];
  for (const artifact of refs) {
    if (!artifact?.path) continue;
    artifact.archive_relative = relative(archiveRoot, artifact.path);
    artifact.path = join(archiveRoot, "stale-worker-root", artifact.archive_relative);
  }
}
