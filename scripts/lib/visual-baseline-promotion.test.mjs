import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  approvedR2SnapshotVersion,
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
    mkdirSync(captureDir, { recursive: true });
    const paths = {
      page: join(captureDir, "page.jpg"),
      thumb: join(captureDir, "thumb.jpg"),
      text: join(captureDir, "text.txt"),
      meta: join(captureDir, "meta.json"),
    };
    writeFileSync(paths.page, "page");
    writeFileSync(paths.thumb, "thumb");
    writeFileSync(paths.text, "Application deadline: March 15, 2027\n");
    writeFileSync(paths.meta, JSON.stringify({
      version: 1,
      kind: "webpage",
      captured_at: "2026-07-14T20:00:00.000Z",
      final_url: "https://example.edu/award",
      page_title: "Example Award",
      text_hash: "new-text",
      image_hash: "new-image",
      text_length: 45,
      dimensions: { width: 1365, height: 2400 },
    }));
    const candidate = candidateFixture({
      new_text_hash: "section-text",
      deterministic_diff: { candidate_scope: "expandable_section" },
      new_snapshot_ref: {
        captured_at: "2026-07-14T20:00:00.000Z",
        final_url: "https://example.edu/award",
        page_title: "Example Award",
        kind: "webpage",
        text_hash: "section-text",
        image_hash: "new-image",
        local_paths: Object.fromEntries(
          Object.entries(paths).map(([key, path]) => [key, { path }]),
        ),
        capture_dir: { path: captureDir },
      },
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
      text_hash: "new-text",
      image_hash: "new-image",
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
    mkdirSync(captureDir, { recursive: true });
    const paths = {
      page_path: join(captureDir, "page.jpg"),
      thumb_path: join(captureDir, "thumb.jpg"),
      text_path: join(captureDir, "text.txt"),
      meta_path: join(captureDir, "meta.json"),
    };
    for (const [name, path] of Object.entries(paths)) writeFileSync(path, name);
    const capture = {
      kind: "webpage",
      captured_at: "2026-07-14T20:00:00.000Z",
      text_hash: "new-text",
      image_hash: "new-image",
      ...paths,
    };
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
      uploaded: 4,
      rotated: 2,
      immutable_version: approvedR2SnapshotVersion({ candidate, capture }),
    });
    const pointer = database.upserts.at(-1);
    expect(pointer.previous_object_keys).toEqual(existing.latest_object_keys);
    expect(pointer.previous_hashes).toEqual(existing.latest_hashes);
    expect(Object.values(pointer.latest_object_keys)).toHaveLength(4);
    expect(Object.values(pointer.latest_object_keys).every((key) =>
      key.startsWith(
        `visual-snapshots/sources/source-1/approved/${result.immutable_version}/`,
      ))).toBe(true);
    expect(operations.slice(-5).map((operation) => operation.type)).toEqual([
      "put",
      "put",
      "put",
      "put",
      "upsert",
    ]);
    expect(new Set(
      operations.filter((operation) => operation.type === "put").map((operation) => operation.key),
    ).size).toBe(4);
    expect(s3.destroyed).toBe(false);
  });

  it("refuses a partial required R2 capture even when some files remain", async () => {
    const archiveRoot = temporaryArchive();
    const captureDir = join(archiveRoot, "partial-r2");
    mkdirSync(captureDir, { recursive: true });
    const pagePath = join(captureDir, "page.jpg");
    const textPath = join(captureDir, "text.txt");
    const metaPath = join(captureDir, "meta.json");
    writeFileSync(pagePath, "page");
    writeFileSync(textPath, "text");
    writeFileSync(metaPath, "{}");
    const result = await promoteApprovedVisualBaselineR2({
      candidate: candidateFixture(),
      source: { id: "source-1", shared_award_id: "award-1", url: "https://example.edu" },
      capture: {
        kind: "webpage",
        captured_at: "2026-07-14T20:00:00.000Z",
        text_hash: "new-text",
        image_hash: "new-image",
        page_path: pagePath,
        thumb_path: join(captureDir, "missing-thumb.jpg"),
        text_path: textPath,
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

  it("deletes only unreferenced immutable uploads after losing the pointer CAS", async () => {
    const archiveRoot = temporaryArchive();
    const captureDir = join(archiveRoot, "lost-cas-r2");
    mkdirSync(captureDir, { recursive: true });
    const paths = {
      page_path: join(captureDir, "page.jpg"),
      thumb_path: join(captureDir, "thumb.jpg"),
      text_path: join(captureDir, "text.txt"),
      meta_path: join(captureDir, "meta.json"),
    };
    for (const [name, path] of Object.entries(paths)) writeFileSync(path, name);
    const capture = {
      kind: "webpage",
      captured_at: "2026-07-14T20:00:00.000Z",
      text_hash: "new-text",
      image_hash: "new-image",
      ...paths,
    };
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
      deleted_orphan_uploads: 3,
    });
    expect(operations.filter((operation) => operation.type === "delete").map(
      (operation) => operation.key,
    )).not.toContain(retainedPage);
  });
});

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
