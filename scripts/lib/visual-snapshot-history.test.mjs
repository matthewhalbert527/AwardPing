import { describe, expect, it } from "vitest";
import {
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
