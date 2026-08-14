import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  bindVisualTextGeometry,
  visualTextGeometryLayoutFingerprint,
} from "./visual-event-localization.mjs";
import {
  projectRetainedCaptureArtifacts,
  retainedCaptureArtifactProjectionSchema,
} from "./r2-capture-artifact-bindings.mjs";
import {
  approvedR2SnapshotVersion,
  captureFromVisualReviewCandidate,
  promoteApprovedVisualBaselineLocal,
  promoteApprovedVisualBaselineR2,
  visualBaselinePublicationDecision,
  visualBaselinePromotionDecision,
} from "./visual-baseline-promotion.mjs";
import { inspectStage1ImmutableR2CaptureBinding } from "./stage1-cohort-readiness.mjs";
import {
  expansionStateCaptureCoverage,
  expansionStateCaptureCoverageLegacyMirrors,
} from "./expansion-state-descriptor-canonicalization.mjs";

const temporaryRoots = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  }
});

describe("approved visual baseline promotion", () => {
  it("never promotes rejected evidence but allows an approved section's enclosing capture", () => {
    const candidate = candidateFixture({
      deterministic_diff: { candidate_scope: "expandable_section" },
    });
    expect(visualBaselinePromotionDecision({ candidate, approved: false })).toEqual({
      promote: false,
      reason: "candidate_not_approved",
    });
    expect(visualBaselinePromotionDecision({ candidate, approved: true })).toEqual({
      promote: true,
      reason: "approved_whole_page_snapshot",
    });
  });

  it("atomically advances an approved whole-page capture as the next local baseline", () => {
    const archiveRoot = temporaryArchive();
    const captureDir = join(archiveRoot, "sources", "source-1", "captures", "capture-1");
    const capture = verifiedWebCapture({
      archiveRoot,
      captureDir,
      text: "Application deadline: March 15, 2027",
    });
    const candidate = candidateFixture({
      new_text_hash: "section-text",
      new_image_hash: capture.image_hash,
      deterministic_diff: { candidate_scope: "expandable_section" },
      new_snapshot_ref: snapshotRefForCapture(capture, archiveRoot, { text_hash: "section-text" }),
    });
    const source = {
      id: "source-1",
      shared_award_id: "award-1",
      url: "https://example.edu/award",
      title: "Example Award",
      page_type: "application",
    };

    const result = promoteApprovedVisualBaselineLocal({
      candidate,
      source,
      archiveRoot,
      approved: true,
      now: "2026-07-14T21:00:00.000Z",
    });
    expect(result).toMatchObject({
      promoted: true,
      reason: "approved_whole_page_snapshot",
    });
    const baseline = JSON.parse(readFileSync(result.baseline_path, "utf8"));
    expect(baseline).toMatchObject({
      captured_at: "2026-07-14T20:00:00.000Z",
      text_hash: capture.text_hash,
      image_hash: capture.image_hash,
      summary_metadata: {
        reason: "batch_approved_true_change",
        approved_visual_candidate_id: "candidate-1",
        promotion_scope: "whole_page",
        approved_candidate_scope: "expandable_section",
      },
    });
    expect(promoteApprovedVisualBaselineLocal({
      candidate,
      source,
      archiveRoot,
      approved: true,
    })).toMatchObject({
      promoted: false,
      already_current: true,
      reason: "approved_snapshot_already_current",
    });
  });

  it("replaces stale local geometry authority when verified core evidence is unchanged", () => {
    const archiveRoot = temporaryArchive();
    const sourceId = "source-geometry-replacement";
    const source = {
      id: sourceId,
      shared_award_id: "award-1",
      url: "https://example.edu/award",
    };
    const candidateFor = (capture, id) => candidateFixture({
      id,
      new_text_hash: capture.text_hash,
      new_image_hash: capture.image_hash,
      new_snapshot_ref: snapshotRefForCapture(capture, archiveRoot),
    });

    const withExpansion = verifiedWebCapture({
      archiveRoot,
      captureDir: join(archiveRoot, "sources", sourceId, "captures", "with-expansion"),
      sourceId,
      withExpansion: true,
    });
    expect(promoteApprovedVisualBaselineLocal({
      candidate: candidateFor(withExpansion, "candidate-with-expansion"),
      source,
      archiveRoot,
      approved: true,
    })).toMatchObject({ promoted: true });

    const withoutExpansion = verifiedWebCapture({
      archiveRoot,
      captureDir: join(archiveRoot, "sources", sourceId, "captures", "without-expansion"),
      sourceId,
    });
    const expansionRemoval = promoteApprovedVisualBaselineLocal({
      candidate: candidateFor(withoutExpansion, "candidate-without-expansion"),
      source,
      archiveRoot,
      approved: true,
    });
    expect(expansionRemoval).toMatchObject({
      promoted: true,
      baseline: { capture: { expansion_states: [] } },
    });

    const withoutMainLayout = verifiedWebCapture({
      archiveRoot,
      captureDir: join(archiveRoot, "sources", sourceId, "captures", "without-main-layout"),
      sourceId,
    });
    markMainGeometryUnavailable(withoutMainLayout);
    const layoutRemoval = promoteApprovedVisualBaselineLocal({
      candidate: candidateFor(withoutMainLayout, "candidate-without-main-layout"),
      source,
      archiveRoot,
      approved: true,
    });
    expect(layoutRemoval).toMatchObject({
      promoted: true,
      baseline: {
        layout_hash: null,
        text_geometry: null,
        capture: { layout: null, expansion_states: [] },
      },
    });
  });

  it("validates immutable raw metadata identity before advancing the local baseline", () => {
    const archiveRoot = temporaryArchive();
    const sourceId = "source-local-meta-identity";
    const capture = verifiedWebCapture({
      archiveRoot,
      captureDir: join(archiveRoot, "sources", sourceId, "captures", "mismatched-meta"),
      sourceId,
    });
    const rawMeta = JSON.parse(readFileSync(capture.meta_path, "utf8"));
    rawMeta.source.id = "different-source";
    writeFileSync(capture.meta_path, JSON.stringify(rawMeta));
    capture.artifact_bindings.meta = artifactBindingForTest(capture.meta_path);
    const candidate = candidateFixture({
      new_text_hash: capture.text_hash,
      new_image_hash: capture.image_hash,
      new_snapshot_ref: snapshotRefForCapture(capture, archiveRoot),
    });

    expect(() => promoteApprovedVisualBaselineLocal({
      candidate,
      source: { id: sourceId, shared_award_id: "award-1", url: "https://example.edu" },
      archiveRoot,
      approved: true,
    })).toThrow("metadata source ID does not match");
    expect(existsSync(join(archiveRoot, "sources", sourceId, "baseline.json"))).toBe(false);
  });

  it("uses the verified full layout artifact while preserving production compact metadata", async () => {
    const archiveRoot = temporaryArchive();
    const sourceId = "55555555-5555-4555-8555-555555555555";
    const capture = verifiedWebCapture({
      archiveRoot,
      captureDir: join(archiveRoot, "sources", sourceId, "captures", "compact-meta"),
      sourceId,
    });
    const candidate = candidateFixture({
      new_text_hash: capture.text_hash,
      new_image_hash: capture.image_hash,
      new_snapshot_ref: snapshotRefForCapture(capture, archiveRoot),
    });
    const source = {
      id: sourceId,
      shared_award_id: "award-1",
      url: "https://example.edu/award",
    };
    const reconstructed = captureFromVisualReviewCandidate(candidate, archiveRoot);
    expect(reconstructed.text_geometry).toMatchObject({
      geometry_hash: capture.layout_hash,
      screenshot: { image_hash: capture.image_hash },
    });
    expect(reconstructed.text_geometry).not.toHaveProperty("paint_stack");
    expect(reconstructed.text_geometry).not.toHaveProperty("capture_verification");

    const local = promoteApprovedVisualBaselineLocal({
      candidate,
      source,
      archiveRoot,
      approved: true,
    });
    expect(local).toMatchObject({
      promoted: true,
      baseline: {
        layout_hash: capture.layout_hash,
        capture: { layout: expect.stringMatching(/layout\.json$/) },
      },
    });
    expect(local.baseline.text_geometry).not.toHaveProperty("paint_stack");
    expect(local.baseline.text_geometry).not.toHaveProperty("capture_verification");

    const operations = [];
    const database = r2DatabaseStub({ existing: null, operations });
    const r2 = await promoteApprovedVisualBaselineR2({
      candidate,
      source,
      capture: reconstructed,
      supabase: database.client,
      s3Client: r2ClientStub({ operations }),
      approved: true,
      config: { enabled: true, bucket: "snapshots" },
    });
    expect(r2).toMatchObject({ promoted: true, uploaded: 5 });
    expect(database.current.latest_object_keys).toHaveProperty("layout");
    expect(database.current.latest_metadata.text_geometry).not.toHaveProperty("paint_stack");
    expect(database.current.latest_metadata.text_geometry)
      .not.toHaveProperty("capture_verification");
  });

  it("does not inherit a prior capture's retained-artifact projection", () => {
    const archiveRoot = temporaryArchive();
    const sourceId = "source-projection";
    const capture = verifiedWebCapture({
      archiveRoot,
      captureDir: join(archiveRoot, "sources", sourceId, "captures", "next-capture"),
      sourceId,
    });
    const baselineDir = join(archiveRoot, "sources", sourceId);
    mkdirSync(baselineDir, { recursive: true });
    writeFileSync(join(baselineDir, "baseline.json"), JSON.stringify({
      captured_at: "2026-07-13T20:00:00.000Z",
      text_hash: "a".repeat(64),
      image_hash: "b".repeat(64),
      summary_metadata: {
        retained_artifact_projection: {
          schema: "awardping.capture-retained-artifact-projection.v1",
          authoritative: {
            layout_retained: false,
            layout_hash: null,
            expansion_state_count: 9,
          },
        },
      },
    }));
    const result = promoteApprovedVisualBaselineLocal({
      candidate: candidateFixture({
        new_text_hash: capture.text_hash,
        new_image_hash: capture.image_hash,
        new_snapshot_ref: snapshotRefForCapture(capture, archiveRoot),
      }),
      source: { id: sourceId, shared_award_id: "award-1", url: "https://example.edu" },
      archiveRoot,
      approved: true,
    });

    expect(result).toMatchObject({ promoted: true });
    expect(result.baseline.summary_metadata.retained_artifact_projection).toEqual(
      capture.retained_artifact_projection,
    );
    expect(result.baseline.summary_metadata.retained_artifact_projection.authoritative)
      .not.toEqual({
        layout_retained: false,
        layout_hash: null,
        expansion_state_count: 9,
      });
  });

  it("fails closed for a historical reviewed capture whose raw projection is missing", () => {
    const archiveRoot = temporaryArchive();
    const sourceId = "source-missing-projection";
    const capture = verifiedWebCapture({
      archiveRoot,
      captureDir: join(archiveRoot, "sources", sourceId, "captures", "historical"),
      sourceId,
    });
    const rawMeta = JSON.parse(readFileSync(capture.meta_path, "utf8"));
    delete rawMeta.retained_artifact_projection;
    writeFileSync(capture.meta_path, JSON.stringify(rawMeta));
    const candidate = candidateFixture({
      new_text_hash: capture.text_hash,
      new_image_hash: capture.image_hash,
      new_snapshot_ref: snapshotRefForCapture(capture, archiveRoot),
    });

    const result = promoteApprovedVisualBaselineLocal({
      candidate,
      source: { id: sourceId, shared_award_id: "award-1", url: "https://example.edu" },
      archiveRoot,
      approved: true,
    });

    expect(result).toMatchObject({
      promoted: false,
      reason: "approved_snapshot_geometry_metadata_missing",
      missing_metadata: ["retained_artifact_projection"],
    });
    expect(existsSync(join(archiveRoot, "sources", sourceId, "baseline.json"))).toBe(false);
    expect(JSON.parse(readFileSync(capture.meta_path, "utf8")))
      .not.toHaveProperty("retained_artifact_projection");
  });

  it("verifies retained PDF and extracted-text bytes before local promotion", () => {
    const archiveRoot = temporaryArchive();
    const captureDir = join(archiveRoot, "sources", "source-pdf", "captures", "capture-1");
    mkdirSync(captureDir, { recursive: true });
    const pdfPath = join(captureDir, "document.pdf");
    const textPath = join(captureDir, "text.txt");
    const metaPath = join(captureDir, "meta.json");
    const text = "PDF application deadline: April 1, 2027";
    writeFileSync(pdfPath, "%PDF-1.7 verified award document");
    writeFileSync(textPath, `${text}\n`);
    const fileHash = sha256ForTest(readFileSync(pdfPath));
    const textHash = sha256ForTest(Buffer.from(text));
    writeFileSync(metaPath, JSON.stringify({
      kind: "pdf",
      source: { id: "source-pdf", shared_award_id: "award-1" },
      captured_at: "2026-07-14T20:00:00.000Z",
      file_hash: fileHash,
      file_bytes: readFileSync(pdfPath).length,
      text_hash: textHash,
      text_length: text.length,
      retained_artifact_projection: retainedProjectionForTest({ kind: "pdf" }),
      files: {
        pdf: archiveRelativeForTest(pdfPath, archiveRoot),
        text: archiveRelativeForTest(textPath, archiveRoot),
        meta: archiveRelativeForTest(metaPath, archiveRoot),
      },
    }));
    const candidate = candidateFixture({
      new_text_hash: textHash,
      new_image_hash: null,
      new_file_hash: fileHash,
      new_snapshot_ref: {
        captured_at: "2026-07-14T20:00:00.000Z",
        kind: "pdf",
        text_hash: textHash,
        file_hash: fileHash,
        capture_dir: {
          path: captureDir,
          archive_relative: archiveRelativeForTest(captureDir, archiveRoot),
        },
        local_paths: {
          pdf: artifactRefForTest(pdfPath, archiveRoot),
          text: artifactRefForTest(textPath, archiveRoot),
          meta: artifactRefForTest(metaPath, archiveRoot),
        },
      },
    });

    const result = promoteApprovedVisualBaselineLocal({
      candidate,
      source: { id: "source-pdf", shared_award_id: "award-1", url: "https://example.edu/award.pdf" },
      archiveRoot,
      approved: true,
    });
    expect(result).toMatchObject({ promoted: true });
    expect(result.baseline).toMatchObject({ kind: "pdf", file_hash: fileHash, text_hash: textHash });
  });

  it("loads main and expansion geometry from the immutable visual-review reference", () => {
    const archiveRoot = temporaryArchive();
    const captureDir = join(archiveRoot, "sources", "source-1", "captures", "capture-geometry");
    mkdirSync(captureDir, { recursive: true });
    const paths = {
      page: join(captureDir, "page.jpg"),
      thumb: join(captureDir, "thumb.jpg"),
      text: join(captureDir, "text.txt"),
      layout: join(captureDir, "layout.json"),
      meta: join(captureDir, "meta.json"),
      expansionPage: join(captureDir, "expansion-state-01.jpg"),
      expansionLayout: join(captureDir, "expansion-state-01-layout.json"),
    };
    for (const [name, path] of Object.entries(paths)) writeFileSync(path, name);
    writeFileSync(paths.meta, JSON.stringify({
      kind: "webpage",
      captured_at: "2026-07-14T20:00:00.000Z",
      text_hash: "new-text",
      image_hash: "new-image",
      layout_hash: "main-layout",
      text_geometry: { geometry_hash: "main-layout" },
      files: {
        layout: paths.layout,
        expansion_states: [{
          state_id: "eligibility-open",
          label: "Eligibility",
          page: paths.expansionPage,
          layout: paths.expansionLayout,
        }],
      },
      expansion_state_screenshots: [{
        state_id: "eligibility-open",
        label: "Eligibility",
        image_hash: "expanded-image",
        layout_hash: "expanded-layout",
        page: paths.expansionPage,
        layout: paths.expansionLayout,
        text_geometry: { geometry_hash: "expanded-layout" },
      }],
    }));
    const candidate = candidateFixture({
      new_snapshot_ref: {
        captured_at: "2026-07-14T20:00:00.000Z",
        kind: "webpage",
        text_hash: "new-text",
        image_hash: "new-image",
        layout_hash: "main-layout",
        capture_dir: { path: captureDir },
        local_paths: {
          page: { path: paths.page },
          thumb: { path: paths.thumb },
          text: { path: paths.text },
          layout: { path: paths.layout },
          meta: { path: paths.meta },
        },
        visual_states: [{
          state_id: "main",
          kind: "main",
          image_hash: "new-image",
          geometry_hash: "main-layout",
          local_paths: {
            image: { path: paths.page },
            layout: { path: paths.layout },
          },
        }, {
          state_id: "eligibility-open",
          kind: "expansion_state",
          label: "Eligibility",
          image_hash: "expanded-image",
          geometry_hash: "expanded-layout",
          local_paths: {
            image: { path: paths.expansionPage },
            layout: { path: paths.expansionLayout },
          },
        }],
      },
    });

    const capture = captureFromVisualReviewCandidate(candidate, archiveRoot);
    expect(capture).toMatchObject({
      layout_path: paths.layout,
      layout_hash: "main-layout",
      expansion_state_screenshots: [{
        state_id: "eligibility-open",
        image_hash: "expanded-image",
        layout_hash: "expanded-layout",
        page_path: paths.expansionPage,
        layout_path: paths.expansionLayout,
      }],
    });
  });

  it("uses archive-relative artifact keys when machine-local absolute paths are stale", () => {
    const archiveRoot = temporaryArchive();
    const capture = verifiedWebCapture({
      archiveRoot,
      captureDir: join(archiveRoot, "sources", "source-1", "captures", "moved-capture"),
    });
    const ref = snapshotRefForCapture(capture, archiveRoot);
    for (const [role, artifact] of Object.entries(ref.local_paths)) {
      artifact.path = join(archiveRoot, "stale-local-path", `${role}.missing`);
    }
    ref.capture_dir.path = join(archiveRoot, "stale-local-path", "capture-dir");
    ref.visual_states[0].local_paths.image.path = join(archiveRoot, "stale-local-path", "page.jpg");
    ref.visual_states[0].local_paths.layout.path = join(archiveRoot, "stale-local-path", "layout.json");

    const reconstructed = captureFromVisualReviewCandidate(candidateFixture({
      new_text_hash: capture.text_hash,
      new_image_hash: capture.image_hash,
      new_snapshot_ref: ref,
    }), archiveRoot);

    expect(reconstructed).toMatchObject({
      page_path: capture.page_path,
      thumb_path: capture.thumb_path,
      text_path: capture.text_path,
      layout_path: capture.layout_path,
      meta_path: capture.meta_path,
      dir: capture.dir,
    });
  });

  it("rejects artifacts that exist outside the configured archive", () => {
    const archiveRoot = temporaryArchive();
    const outsideRoot = temporaryArchive();
    const outsideMeta = join(outsideRoot, "meta.json");
    writeFileSync(outsideMeta, "{}");

    expect(() => captureFromVisualReviewCandidate(candidateFixture({
      new_snapshot_ref: {
        captured_at: "2026-07-14T20:00:00.000Z",
        text_hash: "a".repeat(64),
        image_hash: "b".repeat(64),
        local_paths: { meta: { path: outsideMeta } },
      },
    }), archiveRoot)).toThrow("outside the archive root");
  });

  it("rejects archive paths that traverse a directory junction", () => {
    const archiveRoot = temporaryArchive();
    const outsideRoot = temporaryArchive();
    const outsideMeta = join(outsideRoot, "meta.json");
    writeFileSync(outsideMeta, "{}");
    const linkedDirectory = join(archiveRoot, "linked-capture");
    symlinkSync(outsideRoot, linkedDirectory, "junction");

    expect(() => captureFromVisualReviewCandidate(candidateFixture({
      new_snapshot_ref: {
        captured_at: "2026-07-14T20:00:00.000Z",
        text_hash: "a".repeat(64),
        image_hash: "b".repeat(64),
        local_paths: { meta: { path: join(linkedDirectory, "meta.json") } },
      },
    }), archiveRoot)).toThrow("symbolic link");
  });

  it("refuses byte-tampered approved evidence before advancing the local baseline", () => {
    const archiveRoot = temporaryArchive();
    const capture = verifiedWebCapture({
      archiveRoot,
      captureDir: join(archiveRoot, "sources", "source-1", "captures", "tampered-capture"),
    });
    const ref = snapshotRefForCapture(capture, archiveRoot);
    writeFileSync(capture.page_path, "tampered after visual approval");
    const candidate = candidateFixture({
      new_text_hash: capture.text_hash,
      new_image_hash: capture.image_hash,
      new_snapshot_ref: ref,
    });

    expect(() => promoteApprovedVisualBaselineLocal({
      candidate,
      source: { id: "source-1", shared_award_id: "award-1", url: "https://example.edu" },
      archiveRoot,
      approved: true,
    })).toThrow("SHA-256 does not match the retained artifact");
    expect(existsSync(join(archiveRoot, "sources", "source-1", "baseline.json"))).toBe(false);
  });

  it("refuses a declared layout artifact that is bound to a different screenshot", () => {
    const archiveRoot = temporaryArchive();
    const capture = verifiedWebCapture({
      archiveRoot,
      captureDir: join(archiveRoot, "sources", "source-1", "captures", "misbound-layout"),
    });
    const forgedLayout = geometryFixture({
      imageHash: "f".repeat(64),
      imageRef: archiveRelativeForTest(capture.page_path, archiveRoot),
      stateId: "main",
    });
    writeFileSync(capture.layout_path, JSON.stringify(forgedLayout));
    const ref = snapshotRefForCapture(capture, archiveRoot);
    const forgedLayoutRef = artifactRefForTest(capture.layout_path, archiveRoot);
    ref.layout_hash = forgedLayout.geometry_hash;
    ref.local_paths.layout = forgedLayoutRef;
    ref.visual_states[0].geometry_hash = forgedLayout.geometry_hash;
    ref.visual_states[0].local_paths.layout = forgedLayoutRef;
    const candidate = candidateFixture({
      new_text_hash: capture.text_hash,
      new_image_hash: capture.image_hash,
      new_snapshot_ref: ref,
    });

    expect(() => promoteApprovedVisualBaselineLocal({
      candidate,
      source: { id: "source-1", shared_award_id: "award-1", url: "https://example.edu" },
      archiveRoot,
      approved: true,
    })).toThrow("bound_image_hash_mismatch");
    expect(existsSync(join(archiveRoot, "sources", "source-1", "baseline.json"))).toBe(false);
  });

  it("keeps a failed promotion retryable and publishes after the same evidence is current", () => {
    const candidate = candidateFixture();
    expect(visualBaselinePublicationDecision({
      candidate,
      local: { promoted: false, reason: "approved_snapshot_files_missing" },
      r2: { promoted: false, reason: "local_promotion_required" },
      r2Required: false,
    })).toEqual({
      action: "retry",
      reason: "approved_snapshot_files_missing",
    });
    expect(visualBaselinePublicationDecision({
      candidate,
      local: { promoted: false, already_current: true, reason: "approved_snapshot_already_current" },
      r2: { promoted: false, reason: "r2_snapshot_sync_disabled" },
      r2Required: false,
    })).toEqual({
      action: "publish",
      reason: "required_baseline_targets_current",
    });
    expect(visualBaselinePublicationDecision({
      candidate,
      local: { promoted: false, already_current: true },
      r2: { promoted: false, reason: "r2_promotion_error" },
      r2Required: true,
    })).toEqual({
      action: "retry",
      reason: "r2_promotion_error",
    });
    expect(visualBaselinePublicationDecision({
      candidate,
      local: { promoted: false, already_current: true },
      r2: { promoted: false, already_current: true },
      r2Required: true,
    })).toEqual({
      action: "publish",
      reason: "required_baseline_targets_current",
    });
    expect(visualBaselinePublicationDecision({
      candidate,
      local: { promoted: false, reason: "newer_whole_page_baseline_exists" },
      r2: { promoted: false },
    })).toEqual({
      action: "supersede",
      reason: "newer_whole_page_baseline_exists",
    });
  });

  it("retries partial uploads and failed pointer switches without mutating prior R2 objects", async () => {
    const archiveRoot = temporaryArchive();
    const captureDir = join(archiveRoot, "capture-r2");
    const capture = verifiedWebCapture({ archiveRoot, captureDir });
    const candidate = candidateFixture();
    const source = {
      id: "source-1",
      shared_award_id: "award-1",
      url: "https://example.edu/award",
      title: "Example Award",
      page_type: "application",
    };
    const existing = {
      latest_captured_at: "2026-07-13T20:00:00.000Z",
      latest_object_keys: {
        page: "visual-snapshots/sources/source-1/latest/page.jpg",
        text: "visual-snapshots/sources/source-1/latest/text.txt",
      },
      latest_hashes: { text_hash: "old-text", image_hash: "old-image" },
      latest_metadata: { page_title: "Old" },
      updated_at: "2026-07-13T21:00:00.000Z",
    };
    const operations = [];
    const database = r2DatabaseStub({ existing, operations, upsertFailures: 1 });
    const s3 = r2ClientStub({ operations, failAtSend: 2 });
    const args = {
      candidate,
      source,
      capture,
      supabase: database.client,
      s3Client: s3,
      approved: true,
      config: { enabled: true, bucket: "snapshots" },
      now: "2026-07-14T21:00:00.000Z",
    };

    await expect(promoteApprovedVisualBaselineR2(args)).rejects.toThrow("simulated partial upload");
    expect(database.upserts).toHaveLength(0);
    expect(database.current).toEqual(existing);

    s3.failAtSend = null;
    await expect(promoteApprovedVisualBaselineR2(args)).rejects.toThrow(
      "Advance visual snapshot pointer failed: simulated pointer failure",
    );
    expect(database.upserts).toHaveLength(1);
    expect(database.current).toEqual(existing);

    const result = await promoteApprovedVisualBaselineR2(args);
    expect(result).toMatchObject({
      promoted: true,
      uploaded: 5,
      rotated: 2,
      immutable_version: approvedR2SnapshotVersion({ candidate, capture }),
    });
    const pointer = database.upserts.at(-1);
    expect(pointer.previous_object_keys).toEqual(existing.latest_object_keys);
    expect(pointer.previous_hashes).toEqual(existing.latest_hashes);
    expect(Object.values(pointer.latest_object_keys)).toHaveLength(5);
    expect(Object.values(pointer.latest_object_keys).every((key) =>
      key.startsWith(
        `visual-snapshots/sources/source-1/captures/${result.immutable_version}/`,
      ))).toBe(true);
    expect(operations.slice(-6).map((operation) => operation.type)).toEqual([
      "put",
      "put",
      "put",
      "put",
      "put",
      "upsert",
    ]);
    expect(new Set(
      operations.filter((operation) => operation.type === "put").map((operation) => operation.key),
    ).size).toBe(5);
    expect(s3.destroyed).toBe(false);
  });

  it("returns the actionable missing-capture result before R2 canonicalization", async () => {
    await expect(promoteApprovedVisualBaselineR2({
      candidate: candidateFixture(),
      source: { id: "source-1", shared_award_id: "award-1", url: "https://example.edu" },
      capture: null,
      approved: true,
      config: { enabled: true, bucket: "snapshots" },
    })).resolves.toEqual({
      promoted: false,
      reason: "missing_local_capture_for_r2",
    });
  });

  it("refuses a partial required R2 capture even when some files remain", async () => {
    const archiveRoot = temporaryArchive();
    const captureDir = join(archiveRoot, "partial-r2");
    mkdirSync(captureDir, { recursive: true });
    const pagePath = join(captureDir, "page.jpg");
    const textPath = join(captureDir, "text.txt");
    const layoutPath = join(captureDir, "layout.json");
    const metaPath = join(captureDir, "meta.json");
    writeFileSync(pagePath, "page");
    writeFileSync(textPath, "text");
    writeFileSync(layoutPath, "{}");
    writeFileSync(metaPath, "{}");
    const result = await promoteApprovedVisualBaselineR2({
      candidate: candidateFixture(),
      source: { id: "source-1", shared_award_id: "award-1", url: "https://example.edu" },
      capture: {
        kind: "webpage",
        captured_at: "2026-07-14T20:00:00.000Z",
        text_hash: "new-text",
        image_hash: "new-image",
        layout_hash: "new-layout",
        page_path: pagePath,
        thumb_path: join(captureDir, "missing-thumb.jpg"),
        text_path: textPath,
        layout_path: layoutPath,
        meta_path: metaPath,
      },
      supabase: r2DatabaseStub({ existing: null, operations: [] }).client,
      s3Client: r2ClientStub({ operations: [] }),
      approved: true,
      config: { enabled: true, bucket: "snapshots" },
    });
    expect(result).toMatchObject({
      promoted: false,
      reason: "approved_snapshot_files_missing",
      missing_slots: ["thumb"],
    });
  });

  it("refuses approved webpage geometry that is not bound by hashes", async () => {
    const archiveRoot = temporaryArchive();
    const captureDir = join(archiveRoot, "missing-geometry-metadata-r2");
    mkdirSync(captureDir, { recursive: true });
    const paths = {
      page_path: join(captureDir, "page.jpg"),
      thumb_path: join(captureDir, "thumb.jpg"),
      text_path: join(captureDir, "text.txt"),
      layout_path: join(captureDir, "layout.json"),
      meta_path: join(captureDir, "meta.json"),
    };
    for (const [name, path] of Object.entries(paths)) writeFileSync(path, name);
    const result = await promoteApprovedVisualBaselineR2({
      candidate: candidateFixture(),
      source: { id: "source-1", shared_award_id: "award-1", url: "https://example.edu" },
      capture: {
        kind: "webpage",
        captured_at: "2026-07-14T20:00:00.000Z",
        text_hash: "new-text",
        image_hash: "new-image",
        ...paths,
      },
      supabase: r2DatabaseStub({ existing: null, operations: [] }).client,
      s3Client: r2ClientStub({ operations: [] }),
      approved: true,
      config: { enabled: true, bucket: "snapshots" },
    });
    expect(result).toMatchObject({
      promoted: false,
      reason: "approved_snapshot_geometry_metadata_missing",
      missing_metadata: [
        "retained_artifact_projection",
        "expansion_state_capture_coverage",
        "layout_hash",
      ],
    });
  });

  it("rejects a contradictory reviewed projection before any R2 upload", async () => {
    const archiveRoot = temporaryArchive();
    const sourceId = "99999999-9999-4999-8999-999999999999";
    const capture = verifiedWebCapture({
      archiveRoot,
      captureDir: join(archiveRoot, "contradictory-projection-r2"),
      sourceId,
    });
    const contradictoryProjection = {
      schema: retainedCaptureArtifactProjectionSchema,
      kind: "webpage",
      localization_status: "exact_geometry_available",
      authoritative: {
        layout_retained: true,
        layout_hash: "f".repeat(64),
        expansion_state_count: 0,
      },
    };
    capture.retained_artifact_projection = contradictoryProjection;
    const rawMeta = JSON.parse(readFileSync(capture.meta_path, "utf8"));
    rawMeta.retained_artifact_projection = contradictoryProjection;
    writeFileSync(capture.meta_path, JSON.stringify(rawMeta));
    capture.artifact_bindings.meta = artifactBindingForTest(capture.meta_path);
    const operations = [];

    await expect(promoteApprovedVisualBaselineR2({
      candidate: candidateFixture(),
      source: { id: sourceId, shared_award_id: "award-1", url: "https://example.edu" },
      capture,
      supabase: r2DatabaseStub({ existing: null, operations }).client,
      s3Client: r2ClientStub({ operations }),
      approved: true,
      config: { enabled: true, bucket: "snapshots" },
    })).rejects.toThrow(
      "retained artifact projection does not match verified publication evidence",
    );
    expect(operations).toHaveLength(0);
  });

  it("rejects raw metadata that contradicts the capture projection", async () => {
    const archiveRoot = temporaryArchive();
    const sourceId = "88888888-8888-4888-8888-888888888888";
    const capture = verifiedWebCapture({
      archiveRoot,
      captureDir: join(archiveRoot, "raw-projection-mismatch-r2"),
      sourceId,
    });
    const rawMeta = JSON.parse(readFileSync(capture.meta_path, "utf8"));
    rawMeta.retained_artifact_projection = {
      ...rawMeta.retained_artifact_projection,
      authoritative: {
        ...rawMeta.retained_artifact_projection.authoritative,
        expansion_state_count: 1,
      },
    };
    writeFileSync(capture.meta_path, JSON.stringify(rawMeta));
    capture.artifact_bindings.meta = artifactBindingForTest(capture.meta_path);
    const operations = [];

    await expect(promoteApprovedVisualBaselineR2({
      candidate: candidateFixture(),
      source: { id: sourceId, shared_award_id: "award-1", url: "https://example.edu" },
      capture,
      supabase: r2DatabaseStub({ existing: null, operations }).client,
      s3Client: r2ClientStub({ operations }),
      approved: true,
      config: { enabled: true, bucket: "snapshots" },
    })).rejects.toThrow(
      "raw metadata and capture retained artifact projections do not match",
    );
    expect(operations).toHaveLength(0);
  });

  it("publishes exact main and opened-expansion geometry as one immutable approved generation", async () => {
    const archiveRoot = temporaryArchive();
    const captureDir = join(archiveRoot, "approved-geometry-r2");
    const sourceId = "11111111-1111-4111-8111-111111111111";
    const capture = verifiedWebCapture({
      archiveRoot,
      captureDir,
      withExpansion: true,
      sourceId,
    });
    const operations = [];
    const database = r2DatabaseStub({ existing: null, operations });
    const result = await promoteApprovedVisualBaselineR2({
      candidate: candidateFixture(),
      source: {
        id: sourceId,
        shared_award_id: "award-1",
        url: "https://example.edu/award",
      },
      capture,
      supabase: database.client,
      s3Client: r2ClientStub({ operations }),
      approved: true,
      config: { enabled: true, bucket: "snapshots" },
    });

    expect(result).toMatchObject({ promoted: true, uploaded: 7 });
    expect(database.current.latest_object_keys).toMatchObject({
      page: expect.stringMatching(/\/page\.jpg$/),
      layout: expect.stringMatching(/\/layout\.json$/),
      expansion_state_01: expect.stringMatching(/\/expansion-state-01\.jpg$/),
      expansion_state_01_layout: expect.stringMatching(/\/expansion-state-01-layout\.json$/),
    });
    expect(database.current.latest_hashes).toMatchObject({
      layout_hash: capture.layout_hash,
      expansion_states_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(database.current.latest_metadata).toMatchObject({
      artifact_bindings_schema: "awardping.r2.capture-artifact-bindings.v1",
      retained_artifact_projection: {
        schema: retainedCaptureArtifactProjectionSchema,
        kind: "webpage",
        localization_status: "exact_geometry_available",
        authoritative: {
          layout_retained: true,
          layout_hash: capture.layout_hash,
          expansion_state_count: 1,
        },
      },
      text_object_bytes: readFileSync(capture.text_path).length,
      expansion_state_count: 1,
      expansion_state_screenshots: [{
        state_id: "expansion-state-01",
        image_hash: capture.expansion_state_screenshots[0].image_hash,
        layout_hash: capture.expansion_state_screenshots[0].layout_hash,
      }],
      localization_evidence: { status: "exact_geometry_available" },
    });
    const pointer = database.upserts.at(-1);
    expect(inspectStage1ImmutableR2CaptureBinding(pointer)).toMatchObject({
      valid: true,
      errors: [],
      generation: result.immutable_version,
    });
    expect(Object.values(pointer.latest_object_keys).every((key) => (
      key.startsWith(`visual-snapshots/sources/${sourceId}/captures/${result.immutable_version}/`)
      && !key.includes("/approved/")
    ))).toBe(true);
    assertPointerBindingsMatchUploads(pointer, operations);

    const operationCount = operations.length;
    await expect(promoteApprovedVisualBaselineR2({
      candidate: candidateFixture({ id: "candidate-2" }),
      source: {
        id: sourceId,
        shared_award_id: "award-1",
        url: "https://example.edu/award",
      },
      capture,
      supabase: database.client,
      s3Client: r2ClientStub({ operations }),
      approved: true,
      config: { enabled: true, bucket: "snapshots" },
    })).resolves.toMatchObject({
      promoted: false,
      already_current: true,
      reason: "approved_r2_snapshot_already_current",
    });
    expect(operations).toHaveLength(operationCount);
  });

  it("publishes exact opened-accordion evidence when main-page geometry is explicitly unavailable", async () => {
    const archiveRoot = temporaryArchive();
    const sourceId = "44444444-4444-4444-8444-444444444444";
    const capture = verifiedWebCapture({
      archiveRoot,
      captureDir: join(archiveRoot, "approved-expansion-only-r2"),
      withExpansion: true,
      sourceId,
    });
    markMainGeometryUnavailable(capture);
    const operations = [];
    const database = r2DatabaseStub({ existing: null, operations });

    const result = await promoteApprovedVisualBaselineR2({
      candidate: candidateFixture(),
      source: {
        id: sourceId,
        shared_award_id: "award-1",
        url: "https://example.edu/award",
      },
      capture,
      supabase: database.client,
      s3Client: r2ClientStub({ operations }),
      approved: true,
      config: { enabled: true, bucket: "snapshots" },
    });

    expect(result).toMatchObject({ promoted: true, uploaded: 6 });
    const pointer = database.upserts.at(-1);
    expect(pointer.latest_object_keys).toMatchObject({
      expansion_state_01: expect.stringMatching(/\/expansion-state-01\.jpg$/),
      expansion_state_01_layout: expect.stringMatching(/\/expansion-state-01-layout\.json$/),
    });
    expect(pointer.latest_object_keys).not.toHaveProperty("layout");
    expect(pointer.latest_hashes.layout_hash).toBeNull();
    expect(pointer.latest_metadata).toMatchObject({
      expansion_state_count: 1,
      localization: {
        accounted_for: true,
        geometry_ready: false,
      },
      localization_evidence: {
        status: "exact_expansion_geometry_available",
        main_layout_hash: null,
        expansion_state_count: 1,
      },
    });
    expect(inspectStage1ImmutableR2CaptureBinding(pointer)).toMatchObject({
      valid: true,
      errors: [],
      generation: result.immutable_version,
    });
    assertPointerBindingsMatchUploads(pointer, operations);
  });

  it("rejects incomplete unavailable-main markers before publishing R2 evidence", async () => {
    const cases = [
      ["exact", (capture, meta) => {
        delete capture.localization.exact;
        delete meta.localization.exact;
      }],
      ["accounted_for", (capture, meta) => {
        delete capture.localization.accounted_for;
        delete meta.localization.accounted_for;
      }],
      ["geometry_ready", (capture, meta) => {
        delete capture.localization.geometry_ready;
        delete meta.localization.geometry_ready;
      }],
      ["localization unavailable reason", (capture, meta) => {
        delete capture.localization.unavailable_reason;
        delete meta.localization.unavailable_reason;
      }],
      ["geometry unavailable reason", (capture, meta) => {
        delete capture.text_geometry.unavailable_reason;
        delete meta.text_geometry.unavailable_reason;
      }],
      ["zero geometry runs", (capture, meta) => {
        capture.text_geometry.run_count = 1;
        meta.text_geometry.run_count = 1;
      }],
      ["raw layout claim", (capture, meta) => {
        capture.files.layout = "sources/source/captures/capture/layout.json";
        meta.files.layout = capture.files.layout;
      }],
    ];

    for (const [index, [label, mutate]] of cases.entries()) {
      const archiveRoot = temporaryArchive();
      const sourceId = `${index + 6}`.repeat(8).slice(0, 8)
        + "-6666-4666-8666-666666666666";
      const capture = verifiedWebCapture({
        archiveRoot,
        captureDir: join(archiveRoot, `invalid-unavailable-${index}`),
        sourceId,
      });
      markMainGeometryUnavailable(capture);
      capture.layout_path = null;
      capture.artifact_bindings.layout = null;
      const meta = JSON.parse(readFileSync(capture.meta_path, "utf8"));
      mutate(capture, meta);
      writeFileSync(capture.meta_path, JSON.stringify(meta));
      capture.artifact_bindings.meta = artifactBindingForTest(capture.meta_path);
      const operations = [];

      const result = await promoteApprovedVisualBaselineR2({
        candidate: candidateFixture({ id: `candidate-invalid-${index}` }),
        source: { id: sourceId, shared_award_id: "award-1", url: "https://example.edu" },
        capture,
        supabase: r2DatabaseStub({ existing: null, operations }).client,
        s3Client: r2ClientStub({ operations }),
        approved: true,
        config: { enabled: true, bucket: "snapshots" },
      });

      expect(result, label).toMatchObject({
        promoted: false,
        reason: "approved_snapshot_geometry_metadata_missing",
        missing_metadata: ["main_layout_unavailable_contract"],
      });
      expect(operations, label).toHaveLength(0);
    }
  });

  it("publishes a PDF with the same exact immutable artifact contract", async () => {
    const archiveRoot = temporaryArchive();
    const sourceId = "22222222-2222-4222-8222-222222222222";
    const capture = verifiedPdfCapture({
      archiveRoot,
      captureDir: join(archiveRoot, "approved-pdf-r2"),
      sourceId,
    });
    const operations = [];
    const database = r2DatabaseStub({ existing: null, operations });
    const result = await promoteApprovedVisualBaselineR2({
      candidate: candidateFixture(),
      source: {
        id: sourceId,
        shared_award_id: "award-1",
        url: "https://example.edu/award.pdf",
      },
      capture,
      supabase: database.client,
      s3Client: r2ClientStub({ operations }),
      approved: true,
      config: { enabled: true, bucket: "snapshots" },
    });

    expect(result).toMatchObject({ promoted: true, uploaded: 3 });
    const pointer = database.upserts.at(-1);
    expect(inspectStage1ImmutableR2CaptureBinding(pointer)).toMatchObject({
      valid: true,
      errors: [],
      kind: "pdf",
      generation: result.immutable_version,
    });
    expect(pointer.latest_object_keys).toEqual({
      meta: expect.stringMatching(/\/meta\.json$/),
      pdf: expect.stringMatching(/\/document\.pdf$/),
      text: expect.stringMatching(/\/text\.txt$/),
    });
    assertPointerBindingsMatchUploads(pointer, operations);
  });

  it("repairs hash-current pointers whose readiness metadata or identity is invalid", async () => {
    const archiveRoot = temporaryArchive();
    const sourceId = "33333333-3333-4333-8333-333333333333";
    const capture = verifiedWebCapture({
      archiveRoot,
      captureDir: join(archiveRoot, "approved-repair-r2"),
      withExpansion: true,
      sourceId,
    });
    const source = {
      id: sourceId,
      shared_award_id: "award-1",
      url: "https://example.edu/award",
    };
    const initialOperations = [];
    const initialDatabase = r2DatabaseStub({ existing: null, operations: initialOperations });
    await promoteApprovedVisualBaselineR2({
      candidate: candidateFixture(),
      source,
      capture,
      supabase: initialDatabase.client,
      s3Client: r2ClientStub({ operations: initialOperations }),
      approved: true,
      config: { enabled: true, bucket: "snapshots" },
    });
    const validPointer = initialDatabase.upserts.at(-1);
    expect(inspectStage1ImmutableR2CaptureBinding(validPointer).valid).toBe(true);

    const corruptions = [
      ["native text length", (pointer) => {
        pointer.latest_metadata.text_length = String(pointer.latest_metadata.text_length);
      }],
      ["localization state", (pointer) => {
        pointer.latest_metadata.localization.geometry_ready = false;
      }],
      ["native expansion count", (pointer) => {
        pointer.latest_metadata.expansion_state_count = "1";
      }],
      ["kind", (pointer) => {
        pointer.kind = "pdf";
      }],
      ["source URL", (pointer) => {
        pointer.source_url = "https://example.edu/wrong-award";
      }],
      ["bucket", (pointer) => {
        pointer.bucket = "wrong-bucket";
      }],
      ["capture timestamp", (pointer) => {
        pointer.latest_captured_at = "2026-07-14T19:00:00.000Z";
      }],
      ["missing retained projection", (pointer) => {
        delete pointer.latest_metadata.retained_artifact_projection;
      }],
      ["contradictory retained projection", (pointer) => {
        pointer.latest_metadata.retained_artifact_projection.authoritative.expansion_state_count = 0;
      }],
    ];
    for (const [index, [label, corrupt]] of corruptions.entries()) {
      const existing = structuredClone(validPointer);
      corrupt(existing);
      const operations = [];
      const database = r2DatabaseStub({ existing, operations });
      await expect(promoteApprovedVisualBaselineR2({
        candidate: candidateFixture({ id: `repair-candidate-${index}` }),
        source,
        capture,
        supabase: database.client,
        s3Client: r2ClientStub({ operations }),
        approved: true,
        config: { enabled: true, bucket: "snapshots" },
      }), label).resolves.toMatchObject({
        promoted: true,
        reason: "approved_whole_page_snapshot",
      });
      expect(operations.some((operation) => operation.type === "upsert"), label).toBe(true);
    }
  });

  it("repairs a hash-current legacy pointer that lacks the exact capture manifest contract", async () => {
    const archiveRoot = temporaryArchive();
    const captureDir = join(archiveRoot, "legacy-pointer-geometry-repair");
    const capture = verifiedWebCapture({ archiveRoot, captureDir });
    const existing = {
      latest_captured_at: capture.captured_at,
      latest_object_keys: {
        page: "visual-snapshots/sources/source-1/approved/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/page.jpg",
        thumb: "visual-snapshots/sources/source-1/approved/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/thumb.jpg",
        text: "visual-snapshots/sources/source-1/approved/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/text.txt",
        layout: "visual-snapshots/sources/source-1/approved/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/layout.json",
        meta: "visual-snapshots/sources/source-1/approved/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/meta.json",
      },
      latest_hashes: {
        text_hash: capture.text_hash,
        image_hash: capture.image_hash,
        layout_hash: capture.layout_hash,
      },
      latest_metadata: {},
      updated_at: "2026-07-14T20:30:00.000Z",
    };
    const operations = [];
    const database = r2DatabaseStub({ existing, operations });

    const result = await promoteApprovedVisualBaselineR2({
      candidate: candidateFixture(),
      source: { id: "source-1", shared_award_id: "award-1", url: "https://example.edu" },
      capture,
      supabase: database.client,
      s3Client: r2ClientStub({ operations }),
      approved: true,
      config: { enabled: true, bucket: "snapshots" },
    });

    expect(result).toMatchObject({ promoted: true, uploaded: 5 });
    expect(database.current.latest_object_keys.layout).toMatch(/\/layout\.json$/);
    expect(database.current.latest_hashes.layout_hash).toBe(capture.layout_hash);
  });

  it("deletes only unreferenced immutable uploads after losing the pointer CAS", async () => {
    const archiveRoot = temporaryArchive();
    const captureDir = join(archiveRoot, "lost-cas-r2");
    const capture = verifiedWebCapture({ archiveRoot, captureDir });
    const candidate = candidateFixture();
    const source = {
      id: "source-1",
      shared_award_id: "award-1",
      url: "https://example.edu/award",
    };
    const version = approvedR2SnapshotVersion({ candidate, capture });
    const retainedPage = `visual-snapshots/sources/source-1/captures/${version}/page.jpg`;
    const operations = [];
    const database = r2DatabaseStub({
      existing: null,
      operations,
      casWinner: {
        latest_object_keys: { page: retainedPage },
        previous_object_keys: {},
        updated_at: "2026-07-14T21:00:01.000Z",
      },
    });
    const result = await promoteApprovedVisualBaselineR2({
      candidate,
      source,
      capture,
      supabase: database.client,
      s3Client: r2ClientStub({ operations }),
      approved: true,
      config: { enabled: true, bucket: "snapshots" },
      now: "2026-07-14T21:00:00.000Z",
    });

    expect(result).toMatchObject({
      promoted: false,
      reason: "r2_pointer_compare_and_set_lost",
      deleted_orphan_uploads: 4,
    });
    expect(operations.filter((operation) => operation.type === "delete").map(
      (operation) => operation.key,
    )).not.toContain(retainedPage);
  });

  it("reports post-CAS cleanup debt without misreporting an authoritative promotion", async () => {
    const archiveRoot = temporaryArchive();
    const capture = verifiedWebCapture({
      archiveRoot,
      captureDir: join(archiveRoot, "cleanup-debt-r2"),
    });
    const stalePage = "visual-snapshots/sources/source-1/captures/old/page.jpg";
    const staleText = "visual-snapshots/sources/source-1/captures/old/text.txt";
    const existing = {
      latest_captured_at: "2026-07-13T20:00:00.000Z",
      latest_object_keys: {
        page: "visual-snapshots/sources/source-1/captures/current/page.jpg",
        text: "visual-snapshots/sources/source-1/captures/current/text.txt",
      },
      latest_hashes: { text_hash: "old-text", image_hash: "old-image" },
      latest_metadata: { page_title: "Current" },
      previous_captured_at: "2026-07-12T20:00:00.000Z",
      previous_object_keys: { page: stalePage, text: staleText },
      previous_hashes: { text_hash: "stale-text", image_hash: "stale-image" },
      previous_metadata: { page_title: "Stale" },
      updated_at: "2026-07-13T21:00:00.000Z",
    };
    const operations = [];
    const database = r2DatabaseStub({ existing, operations });
    const result = await promoteApprovedVisualBaselineR2({
      candidate: candidateFixture(),
      source: {
        id: "source-1",
        shared_award_id: "award-1",
        url: "https://example.edu/award",
      },
      capture,
      supabase: database.client,
      s3Client: r2ClientStub({ operations, failDeleteKeys: [stalePage] }),
      approved: true,
      config: { enabled: true, bucket: "snapshots" },
      now: "2026-07-14T21:00:00.000Z",
    });

    expect(result).toMatchObject({
      promoted: true,
      deleted: 1,
      cleanup: {
        attempted: 2,
        deleted: 1,
        failed: 1,
        failures: [{ key: stalePage, message: "simulated delete failure" }],
      },
    });
    expect(database.current.latest_captured_at).toBe(capture.captured_at);
    expect(operations.filter((operation) => operation.type === "delete").map(
      (operation) => operation.key,
    )).toEqual(expect.arrayContaining([stalePage, staleText]));
  });
});

function verifiedWebCapture({
  archiveRoot,
  captureDir,
  text = "Application deadline: March 15, 2027",
  withExpansion = false,
  sourceId = "source-1",
} = {}) {
  mkdirSync(captureDir, { recursive: true });
  const paths = {
    page_path: join(captureDir, "page.jpg"),
    thumb_path: join(captureDir, "thumb.jpg"),
    text_path: join(captureDir, "text.txt"),
    layout_path: join(captureDir, "layout.json"),
    meta_path: join(captureDir, "meta.json"),
  };
  writeFileSync(paths.page_path, "verified main screenshot bytes");
  writeFileSync(paths.thumb_path, "verified thumbnail bytes");
  writeFileSync(paths.text_path, `${text}\n`);
  const imageHash = sha256ForTest(readFileSync(paths.page_path));
  const textHash = sha256ForTest(Buffer.from(text, "utf8"));
  const mainGeometry = geometryFixture({
    imageHash,
    imageRef: archiveRelativeForTest(paths.page_path, archiveRoot),
    stateId: "main",
    text,
  });
  writeFileSync(paths.layout_path, JSON.stringify(mainGeometry));

  const expansionStates = [];
  if (withExpansion) {
    const expansionPagePath = join(captureDir, "expansion-state-01.jpg");
    const expansionLayoutPath = join(captureDir, "expansion-state-01-layout.json");
    writeFileSync(expansionPagePath, "verified opened accordion screenshot bytes");
    const expansionImageHash = sha256ForTest(readFileSync(expansionPagePath));
    const expansionGeometry = geometryFixture({
      imageHash: expansionImageHash,
      imageRef: archiveRelativeForTest(expansionPagePath, archiveRoot),
      stateId: "expansion-state-01",
      text: "Eligibility requirements",
    });
    writeFileSync(expansionLayoutPath, JSON.stringify(expansionGeometry));
    expansionStates.push({
      state_id: "expansion-state-01",
      index: 0,
      label: "Eligibility",
      captured_at: "2026-07-14T20:00:00.000Z",
      image_hash: expansionImageHash,
      layout_hash: expansionGeometry.geometry_hash,
      text_geometry: expansionGeometry,
      text_hash: sha256ForTest(Buffer.from("Eligibility requirements", "utf8")),
      text_length: "Eligibility requirements".length,
      page_bytes: readFileSync(expansionPagePath).length,
      page_path: expansionPagePath,
      layout_path: expansionLayoutPath,
    });
  }

  const retainedArtifactProjection = retainedProjectionForTest({
    kind: "webpage",
    image_hash: imageHash,
    layout_hash: mainGeometry.geometry_hash,
    text_geometry: mainGeometry,
    layout_path: paths.layout_path,
    expansion_state_screenshots: expansionStates,
  });
  const expansionCoverage = expansionStateCaptureCoverage({
    raw_candidates: expansionStates.length,
    raw_candidate_count_exact: true,
    candidates: expansionStates.length,
    candidate_count_exact: true,
    attempted: expansionStates.length,
    capture_limit: 24,
    capture_complete: true,
    capture_status: "verified_complete",
    truncated: false,
    truncated_count: 0,
    truncated_count_exact: true,
    failures: [],
  }, { retainedStateCount: expansionStates.length });

  const meta = {
    version: 1,
    kind: "webpage",
    source: { id: sourceId, shared_award_id: "award-1" },
    captured_at: "2026-07-14T20:00:00.000Z",
    final_url: "https://example.edu/award",
    page_title: "Example Award",
    text_hash: textHash,
    image_hash: imageHash,
    layout_hash: mainGeometry.geometry_hash,
    text_geometry: compactGeometryReferenceForTest(
      mainGeometry,
      archiveRelativeForTest(paths.layout_path, archiveRoot),
    ),
    localization: readyLocalizationForTest(mainGeometry, imageHash),
    retained_artifact_projection: retainedArtifactProjection,
    text_length: text.length,
    page_bytes: readFileSync(paths.page_path).length,
    thumb_bytes: readFileSync(paths.thumb_path).length,
    dimensions: { width: 1365, height: 2400 },
    expansion_state_count: expansionStates.length,
    ...expansionStateCaptureCoverageLegacyMirrors(expansionCoverage),
    expansion_state_capture_coverage: expansionCoverage,
    expansion_state_screenshots: expansionStates.map((state) => ({
      ...state,
      text_geometry: compactGeometryReferenceForTest(
        state.text_geometry,
        archiveRelativeForTest(state.layout_path, archiveRoot),
      ),
      page: archiveRelativeForTest(state.page_path, archiveRoot),
      layout: archiveRelativeForTest(state.layout_path, archiveRoot),
    })),
    files: {
      page: archiveRelativeForTest(paths.page_path, archiveRoot),
      thumb: archiveRelativeForTest(paths.thumb_path, archiveRoot),
      text: archiveRelativeForTest(paths.text_path, archiveRoot),
      layout: archiveRelativeForTest(paths.layout_path, archiveRoot),
      meta: archiveRelativeForTest(paths.meta_path, archiveRoot),
      expansion_states: expansionStates.map((state) => ({
        state_id: state.state_id,
        label: state.label,
        page: archiveRelativeForTest(state.page_path, archiveRoot),
        layout: archiveRelativeForTest(state.layout_path, archiveRoot),
      })),
    },
  };
  writeFileSync(paths.meta_path, JSON.stringify(meta));

  const capture = {
    ...meta,
    text_geometry: mainGeometry,
    archive_root: archiveRoot,
    dir: captureDir,
    ...paths,
    expansion_state_screenshots: expansionStates,
  };
  capture.artifact_bindings = artifactBindingsForCapture(capture, archiveRoot);
  return capture;
}

function verifiedPdfCapture({ archiveRoot, captureDir, sourceId }) {
  mkdirSync(captureDir, { recursive: true });
  const pdfPath = join(captureDir, "document.pdf");
  const textPath = join(captureDir, "text.txt");
  const metaPath = join(captureDir, "meta.json");
  const text = "Official award instructions for the 2027 cycle";
  writeFileSync(pdfPath, "%PDF-1.7 immutable award guidance");
  writeFileSync(textPath, `${text}\n`);
  const fileHash = sha256ForTest(readFileSync(pdfPath));
  const textHash = sha256ForTest(Buffer.from(text, "utf8"));
  const meta = {
    version: 1,
    kind: "pdf",
    source: { id: sourceId, shared_award_id: "award-1" },
    captured_at: "2026-07-14T20:00:00.000Z",
    final_url: "https://example.edu/award.pdf",
    file_hash: fileHash,
    text_hash: textHash,
    retained_artifact_projection: retainedProjectionForTest({ kind: "pdf" }),
    text_length: text.length,
    file_bytes: readFileSync(pdfPath).length,
  };
  writeFileSync(metaPath, JSON.stringify(meta));
  const capture = {
    ...meta,
    archive_root: archiveRoot,
    dir: captureDir,
    pdf_path: pdfPath,
    text_path: textPath,
    meta_path: metaPath,
  };
  capture.artifact_bindings = {
    pdf: artifactBindingForTest(pdfPath),
    text: artifactBindingForTest(textPath),
    meta: artifactBindingForTest(metaPath),
  };
  return capture;
}

function markMainGeometryUnavailable(capture) {
  const unavailableReason = "The page moved while the main screenshot was captured.";
  const textGeometry = {
    version: 1,
    availability_status: "unavailable_layout_changed_during_screenshot",
    status: "unavailable_layout_changed_during_screenshot",
    unavailable_reason: unavailableReason,
    run_count: 0,
  };
  const localization = {
    status: "evidence_only_geometry_unavailable",
    exact: false,
    accounted_for: true,
    geometry_ready: false,
    unavailable_reason: unavailableReason,
    geometry_hash: null,
    bound_image_hash: null,
    semantic_crop_contract: "visual-exact-text-binding-v2",
  };
  capture.layout_hash = null;
  capture.text_geometry = textGeometry;
  capture.localization = localization;
  capture.files = { ...capture.files, layout: null };
  capture.retained_artifact_projection = retainedProjectionForTest(capture);

  const meta = JSON.parse(readFileSync(capture.meta_path, "utf8"));
  meta.layout_hash = null;
  meta.text_geometry = textGeometry;
  meta.localization = localization;
  meta.files = { ...meta.files, layout: null };
  meta.retained_artifact_projection = capture.retained_artifact_projection;
  writeFileSync(capture.meta_path, JSON.stringify(meta));
  capture.artifact_bindings.meta = artifactBindingForTest(capture.meta_path);
}

function geometryFixture({ imageHash, imageRef, stateId, text = "Award information" }) {
  const geometry = {
    version: 1,
    state_id: stateId,
    document: { width: 1365, height: 2400 },
    viewport: { width: 1365, height: 768 },
    device_pixel_ratio: 1,
    paint_stack: {
      contract: "browser-paint-stack-v1",
      status: "verified",
    },
    nodes: [{
      order: 0,
      path: "main > p",
      text,
      separator_before: "",
      rects: [{ x: 120, y: 420, width: 700, height: 28 }],
      runs: [{
        start: 0,
        end: text.length,
        text,
        rects: [{ x: 120, y: 420, width: 700, height: 28 }],
      }],
    }],
  };
  const binding = {
    capturedAt: "2026-07-14T20:00:00.000Z",
    imageHash,
    imageRef,
    screenshot: {
      css_width: 1365,
      css_height: 2400,
      pixel_width: 1365,
      pixel_height: 2400,
    },
  };
  const preliminary = bindVisualTextGeometry(geometry, binding);
  const fingerprint = visualTextGeometryLayoutFingerprint({
    ...preliminary,
    version: 1,
  });
  return bindVisualTextGeometry({
    ...preliminary,
    version: 1,
    geometry_hash: undefined,
    capture_verification: {
      contract: "visual-screenshot-layout-binding-v1",
      status: "verified",
      before_fingerprint: fingerprint,
      after_fingerprint: fingerprint,
    },
  }, binding);
}

function compactGeometryReferenceForTest(geometry, file) {
  return {
    version: geometry.version || 1,
    status: geometry.availability_status
      || (geometry.run_count > 0 ? "ready" : "unavailable_no_visible_text_nodes"),
    unavailable_reason: geometry.unavailable_reason || null,
    geometry_hash: geometry.geometry_hash || null,
    coordinate_space: geometry.coordinate_space || "document-css-pixels",
    node_count: geometry.node_count || 0,
    run_count: geometry.run_count || 0,
    document: geometry.document || null,
    viewport: geometry.viewport || null,
    screenshot: geometry.screenshot || null,
    file: file || null,
  };
}

function readyLocalizationForTest(geometry, imageHash) {
  return {
    status: "geometry_ready",
    exact: false,
    accounted_for: true,
    geometry_ready: true,
    unavailable_reason: null,
    geometry_hash: geometry.geometry_hash,
    bound_image_hash: imageHash,
    semantic_crop_contract: "visual-exact-text-binding-v2",
  };
}

function retainedProjectionForTest(capture) {
  return projectRetainedCaptureArtifacts(capture, { exists: existsSync }).manifest;
}

function snapshotRefForCapture(capture, archiveRoot, overrides = {}) {
  const localPaths = {
    page: artifactRefForTest(capture.page_path, archiveRoot),
    thumb: artifactRefForTest(capture.thumb_path, archiveRoot),
    text: artifactRefForTest(capture.text_path, archiveRoot),
    layout: artifactRefForTest(capture.layout_path, archiveRoot),
    meta: artifactRefForTest(capture.meta_path, archiveRoot),
  };
  return {
    captured_at: capture.captured_at,
    final_url: capture.final_url,
    page_title: capture.page_title,
    kind: capture.kind,
    text_hash: capture.text_hash,
    image_hash: capture.image_hash,
    layout_hash: capture.layout_hash,
    capture_dir: {
      path: capture.dir,
      archive_relative: archiveRelativeForTest(capture.dir, archiveRoot),
    },
    local_paths: localPaths,
    visual_states: [{
      state_id: "main",
      kind: "main",
      image_hash: capture.image_hash,
      geometry_hash: capture.layout_hash,
      local_paths: {
        image: artifactRefForTest(capture.page_path, archiveRoot),
        layout: artifactRefForTest(capture.layout_path, archiveRoot),
      },
    }, ...capture.expansion_state_screenshots.map((state) => ({
      state_id: state.state_id,
      kind: "expansion_state",
      label: state.label,
      image_hash: state.image_hash,
      geometry_hash: state.layout_hash,
      local_paths: {
        image: artifactRefForTest(state.page_path, archiveRoot),
        layout: artifactRefForTest(state.layout_path, archiveRoot),
      },
    }))],
    ...overrides,
  };
}

function artifactBindingsForCapture(capture, archiveRoot) {
  const bindings = {
    page: artifactBindingForTest(capture.page_path, archiveRoot),
    thumb: artifactBindingForTest(capture.thumb_path, archiveRoot),
    text: artifactBindingForTest(capture.text_path, archiveRoot),
    layout: artifactBindingForTest(capture.layout_path, archiveRoot),
    meta: artifactBindingForTest(capture.meta_path, archiveRoot),
  };
  for (const [index, state] of capture.expansion_state_screenshots.entries()) {
    const suffix = String(index + 1).padStart(2, "0");
    bindings[`expansion_state_${suffix}`] = artifactBindingForTest(state.page_path, archiveRoot);
    bindings[`expansion_state_${suffix}_layout`] = artifactBindingForTest(state.layout_path, archiveRoot);
  }
  return bindings;
}

function artifactRefForTest(path, archiveRoot) {
  return {
    path,
    archive_relative: archiveRelativeForTest(path, archiveRoot),
    ...artifactBindingForTest(path),
  };
}

function artifactBindingForTest(path) {
  const body = readFileSync(path);
  return {
    byte_length: body.length,
    sha256: sha256ForTest(body),
  };
}

function archiveRelativeForTest(path, archiveRoot) {
  return relative(archiveRoot, path).replaceAll("\\", "/");
}

function sha256ForTest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function temporaryArchive() {
  const root = mkdtempSync(join(tmpdir(), "awardping-baseline-promotion-"));
  temporaryRoots.push(root);
  return root;
}

function candidateFixture(overrides = {}) {
  return {
    id: "candidate-1",
    new_text_hash: "new-text",
    new_image_hash: "new-image",
    deterministic_diff: {},
    new_snapshot_ref: {
      captured_at: "2026-07-14T20:00:00.000Z",
      text_hash: "new-text",
      image_hash: "new-image",
    },
    ...overrides,
  };
}

function r2ClientStub({ operations, failAtSend = null, failDeleteKeys = [] }) {
  const deleteFailures = new Set(failDeleteKeys);
  return {
    destroyed: false,
    failAtSend,
    sendCount: 0,
    async send(command) {
      this.sendCount += 1;
      const type = command.constructor.name === "DeleteObjectCommand" ? "delete" : "put";
      operations.push(type === "put"
        ? {
            type,
            key: command.input.Key,
            body: Buffer.from(command.input.Body),
            content_type: command.input.ContentType,
            metadata: structuredClone(command.input.Metadata),
          }
        : { type, key: command.input.Key });
      if (this.failAtSend === this.sendCount) throw new Error("simulated partial upload");
      if (type === "delete" && deleteFailures.has(command.input.Key)) {
        throw new Error("simulated delete failure");
      }
      return {};
    },
    destroy() {
      this.destroyed = true;
    },
  };
}

function assertPointerBindingsMatchUploads(pointer, operations) {
  const uploads = new Map(
    operations
      .filter((operation) => operation.type === "put")
      .map((operation) => [operation.key, operation]),
  );
  expect(Object.keys(pointer.latest_metadata.artifact_bindings).sort()).toEqual(
    Object.keys(pointer.latest_object_keys).sort(),
  );
  for (const [slot, key] of Object.entries(pointer.latest_object_keys)) {
    const upload = uploads.get(key);
    expect(upload, `missing upload for ${slot}`).toBeTruthy();
    expect(pointer.latest_metadata.artifact_bindings[slot]).toEqual({
      sha256: sha256ForTest(upload.body),
      byte_length: upload.body.length,
      content_type: upload.content_type,
      hash_mode: "raw_sha256",
    });
    expect(upload.metadata).toEqual({
      sha256: sha256ForTest(upload.body),
    });
  }
}

function r2DatabaseStub({ existing, operations, upsertFailures = 0, casWinner = null }) {
  const state = {
    current: structuredClone(existing),
    upserts: [],
    remainingUpsertFailures: upsertFailures,
    casWinner: structuredClone(casWinner),
  };
  return {
    get current() {
      return state.current;
    },
    get upserts() {
      return state.upserts;
    },
    client: {
      async rpc(name, args) {
        const payload = structuredClone(args.p_snapshot);
        state.upserts.push(payload);
        operations.push({ type: "upsert" });
        if (state.remainingUpsertFailures > 0) {
          state.remainingUpsertFailures -= 1;
          return { data: null, error: { message: "simulated pointer failure" } };
        }
        if (state.casWinner) {
          state.current = state.casWinner;
          state.casWinner = null;
          return { data: false, error: null };
        }
        if (
          args.p_expected_exists !== Boolean(state.current) ||
          (state.current && args.p_expected_updated_at !== state.current.updated_at)
        ) return { data: false, error: null };
        state.current = structuredClone(payload);
        return { data: true, error: null };
      },
      from() {
        return {
          select() {
            return {
              eq() {
                return {
                  async maybeSingle() {
                    return { data: structuredClone(state.current), error: null };
                  },
                };
              },
            };
          },
        };
      },
    },
  };
}
