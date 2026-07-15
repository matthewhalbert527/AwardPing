import { describe, expect, it } from "vitest";
import {
  refreshedLatestVisualSnapshotHistory,
  rotatedVisualSnapshotHistory,
  visualSnapshotKeysToDeleteAfterCas,
  visualSnapshotUploadedKeysToDeleteAfterLostCas,
} from "./visual-snapshot-history.mjs";

describe("immutable visual snapshot history", () => {
  it("rotates exact approved pointers into previous on the next scheduled capture", () => {
    const approved = {
      latest_captured_at: "2026-07-14T18:00:00.000Z",
      latest_object_keys: { page: "approved/b/page.jpg", text: "approved/b/text.txt" },
      latest_hashes: { image_hash: "b-image", text_hash: "b-text" },
      latest_metadata: { reason: "approved" },
    };
    expect(rotatedVisualSnapshotHistory(approved, {
      page: "captures/c/page.jpg",
      text: "captures/c/text.txt",
    })).toMatchObject({
      previous_captured_at: approved.latest_captured_at,
      previous_object_keys: approved.latest_object_keys,
      previous_hashes: approved.latest_hashes,
      previous_metadata: approved.latest_metadata,
    });
  });

  it("garbage-collects generation one only after generation three CAS succeeds", () => {
    const beforeThird = {
      latest_object_keys: { page: "generation-2/page.jpg" },
      previous_object_keys: { page: "generation-1/page.jpg" },
    };
    const afterThird = rotatedVisualSnapshotHistory(beforeThird, {
      page: "generation-3/page.jpg",
    });
    expect(visualSnapshotKeysToDeleteAfterCas({
      pointerAdvanced: false,
      existing: beforeThird,
      next: afterThird,
    })).toEqual([]);
    expect(visualSnapshotKeysToDeleteAfterCas({
      pointerAdvanced: true,
      existing: beforeThird,
      next: afterThird,
    })).toEqual(["generation-1/page.jpg"]);
  });

  it("refreshes latest metadata without rotating or deleting historical previous objects", () => {
    const existing = {
      latest_object_keys: { page: "latest-old/page.jpg", meta: "latest-old/meta.json" },
      previous_captured_at: "2026-07-13T18:00:00.000Z",
      previous_object_keys: { page: "historical/page.jpg", meta: "historical/meta.json" },
      previous_hashes: { image_hash: "historical-image" },
      previous_metadata: { capture_profile: "legacy" },
    };
    const preserved = refreshedLatestVisualSnapshotHistory(existing);
    const next = {
      latest_object_keys: { page: "latest-new/page.jpg", meta: "latest-new/meta.json" },
      ...preserved,
    };

    expect(preserved).toEqual({
      previous_captured_at: existing.previous_captured_at,
      previous_object_keys: existing.previous_object_keys,
      previous_hashes: existing.previous_hashes,
      previous_metadata: existing.previous_metadata,
    });
    expect(visualSnapshotKeysToDeleteAfterCas({
      pointerAdvanced: true,
      existing,
      next,
    })).toEqual(["latest-old/page.jpg", "latest-old/meta.json"]);
  });

  it("removes only an unreferenced upload after a lost pointer CAS", () => {
    expect(visualSnapshotUploadedKeysToDeleteAfterLostCas({
      uploaded: {
        page: "loser/page.jpg",
        text: "winner/text.txt",
      },
      current: {
        latest_object_keys: { page: "winner/page.jpg", text: "winner/text.txt" },
        previous_object_keys: { page: "previous/page.jpg" },
      },
    })).toEqual(["loser/page.jpg"]);
  });
});
