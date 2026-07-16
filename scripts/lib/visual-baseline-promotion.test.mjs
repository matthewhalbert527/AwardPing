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
import { bindVisualTextGeometry } from "./visual-event-localization.mjs";
import {
  approvedR2SnapshotVersion,
  captureFromVisualReviewCandidate,
  promoteApprovedVisualBaselineLocal,
  promoteApprovedVisualBaselineR2,
  visualBaselinePublicationDecision,
  visualBaselinePromotionDecision,
} from "./visual-baseline-promotion.mjs";

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
      captured_at: "2026-07-14T20:00:00.000Z",
      file_hash: fileHash,
      text_hash: textHash,
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
        `visual-snapshots/sources/source-1/approved/${result.immutable_version}/`,
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
      missing_metadata: ["layout_hash"],
    });
  });

  it("publishes exact main and opened-expansion geometry as one immutable approved generation", async () => {
    const archiveRoot = temporaryArchive();
    const captureDir = join(archiveRoot, "approved-geometry-r2");
    const capture = verifiedWebCapture({ archiveRoot, captureDir, withExpansion: true });
    const operations = [];
    const database = r2DatabaseStub({ existing: null, operations });
    const result = await promoteApprovedVisualBaselineR2({
      candidate: candidateFixture(),
      source: {
        id: "source-1",
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
      expansion_state_count: 1,
      expansion_state_screenshots: [{
        state_id: "eligibility-open",
        image_hash: capture.expansion_state_screenshots[0].image_hash,
        layout_hash: capture.expansion_state_screenshots[0].layout_hash,
      }],
      localization_evidence: { status: "exact_geometry_available" },
    });
  });

  it("repairs a same-capture legacy pointer that has core evidence but no geometry", async () => {
    const archiveRoot = temporaryArchive();
    const captureDir = join(archiveRoot, "legacy-pointer-geometry-repair");
    const capture = verifiedWebCapture({ archiveRoot, captureDir });
    const existing = {
      latest_captured_at: capture.captured_at,
      latest_object_keys: {
        page: "visual-snapshots/sources/source-1/approved/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/page.jpg",
        thumb: "visual-snapshots/sources/source-1/approved/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/thumb.jpg",
        text: "visual-snapshots/sources/source-1/approved/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/text.txt",
        meta: "visual-snapshots/sources/source-1/approved/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/meta.json",
      },
      latest_hashes: { text_hash: capture.text_hash, image_hash: capture.image_hash },
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
    const retainedPage = `visual-snapshots/sources/source-1/approved/${version}/page.jpg`;
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
});

function verifiedWebCapture({
  archiveRoot,
  captureDir,
  text = "Application deadline: March 15, 2027",
  withExpansion = false,
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
      stateId: "eligibility-open",
      text: "Eligibility requirements",
    });
    writeFileSync(expansionLayoutPath, JSON.stringify(expansionGeometry));
    expansionStates.push({
      state_id: "eligibility-open",
      index: 0,
      label: "Eligibility",
      captured_at: "2026-07-14T20:00:00.000Z",
      image_hash: expansionImageHash,
      layout_hash: expansionGeometry.geometry_hash,
      text_geometry: expansionGeometry,
      page_path: expansionPagePath,
      layout_path: expansionLayoutPath,
    });
  }

  const meta = {
    version: 1,
    kind: "webpage",
    captured_at: "2026-07-14T20:00:00.000Z",
    final_url: "https://example.edu/award",
    page_title: "Example Award",
    text_hash: textHash,
    image_hash: imageHash,
    layout_hash: mainGeometry.geometry_hash,
    text_geometry: mainGeometry,
    text_length: text.length,
    dimensions: { width: 1365, height: 2400 },
    expansion_state_screenshots: expansionStates.map((state) => ({
      ...state,
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
    archive_root: archiveRoot,
    dir: captureDir,
    ...paths,
    expansion_state_screenshots: expansionStates,
  };
  capture.artifact_bindings = artifactBindingsForCapture(capture, archiveRoot);
  return capture;
}

function geometryFixture({ imageHash, imageRef, stateId, text = "Award information" }) {
  return bindVisualTextGeometry({
    state_id: stateId,
    document: { width: 1365, height: 2400 },
    viewport: { width: 1365, height: 768 },
    device_pixel_ratio: 1,
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
  }, {
    capturedAt: "2026-07-14T20:00:00.000Z",
    imageHash,
    imageRef,
    screenshot: {
      css_width: 1365,
      css_height: 2400,
      pixel_width: 1365,
      pixel_height: 2400,
    },
  });
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

function r2ClientStub({ operations, failAtSend = null }) {
  return {
    destroyed: false,
    failAtSend,
    sendCount: 0,
    async send(command) {
      this.sendCount += 1;
      const type = command.constructor.name === "DeleteObjectCommand" ? "delete" : "put";
      operations.push({ type, key: command.input.Key });
      if (this.failAtSend === this.sendCount) throw new Error("simulated partial upload");
      return {};
    },
    destroy() {
      this.destroyed = true;
    },
  };
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
        state.current = {
          latest_captured_at: payload.latest_captured_at,
          latest_object_keys: structuredClone(payload.latest_object_keys),
          latest_hashes: structuredClone(payload.latest_hashes),
          latest_metadata: structuredClone(payload.latest_metadata),
          previous_captured_at: payload.previous_captured_at,
          previous_object_keys: structuredClone(payload.previous_object_keys),
          previous_hashes: structuredClone(payload.previous_hashes),
          previous_metadata: structuredClone(payload.previous_metadata),
          updated_at: payload.updated_at,
        };
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
