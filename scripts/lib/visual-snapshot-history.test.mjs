import { describe, expect, it } from "vitest";
import {
  refreshedLatestVisualSnapshotHistory,
  isDeletableVisualSnapshotKey,
  isPublishedVisualEvidenceKey,
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

  it("retains displaced generation one even after generation three CAS succeeds", () => {
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
    })).toEqual([]);
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
    })).toEqual([]);
  });

  it("retains uploads after lost CAS without complete reference and create-ownership proof", () => {
    expect(visualSnapshotUploadedKeysToDeleteAfterLostCas({
      uploaded: {
        page: "loser/page.jpg",
        text: "winner/text.txt",
      },
      current: {
        latest_object_keys: { page: "winner/page.jpg", text: "winner/text.txt" },
        previous_object_keys: { page: "previous/page.jpg" },
      },
    })).toEqual([]);
  });

  it("categorically protects permanent published evidence from pointer cleanup", () => {
    const published = "visual-snapshots/published/candidate-1/previous/main/full.jpg";
    expect(isPublishedVisualEvidenceKey(published)).toBe(true);
    expect(visualSnapshotKeysToDeleteAfterCas({
      pointerAdvanced: true,
      existing: {
        latest_object_keys: { page: published },
        previous_object_keys: { page: "generation-1/page.jpg" },
      },
      next: {
        latest_object_keys: { page: "generation-3/page.jpg" },
        previous_object_keys: { page: "generation-2/page.jpg" },
      },
    })).toEqual([]);
    expect(visualSnapshotUploadedKeysToDeleteAfterLostCas({
      uploaded: { page: published },
      current: {},
    })).toEqual([]);
  });
});

const legacySourceId = "11111111-1111-4111-8111-111111111111";
const legacyFixedKey = (generation, filename, sourceId = legacySourceId) =>
  `visual-snapshots/sources/${sourceId}/${generation}/${filename}`;
const legacyFixedFiles = ["page.jpg", "thumb.jpg", "document.pdf", "text.txt",
  "page.html.txt", "layout.json", "meta.json", ...Array.from({ length: 99 }, (_, index) => {
    const number = String(index + 1).padStart(2, "0");
    return [`expansion-state-${number}.jpg`, `expansion-state-${number}-layout.json`];
  }).flat()];

describe("exact fixed legacy originals are retained, not certified", () => {
  it.each(["latest", "previous"])("protects every approved %s fixed filename and expansion number", (generation) => {
    for (const filename of legacyFixedFiles) {
      expect(isDeletableVisualSnapshotKey(legacyFixedKey(generation, filename)), filename).toBe(false);
    }
  });

  it("keeps displaced legacy, modern and approved originals after ordinary CAS", () => {
    const originals = Object.fromEntries(legacyFixedFiles.map((filename) => [filename, legacyFixedKey("latest", filename)]));
    const existing = {
      latest_object_keys: { page: `visual-snapshots/sources/${legacySourceId}/captures/kept/page.jpg` },
      previous_object_keys: { ...originals,
        ordinary: `visual-snapshots/sources/${legacySourceId}/captures/displaced/page.jpg`,
        approved: `visual-snapshots/sources/${legacySourceId}/approved/displaced/meta.json`,
        published: "visual-snapshots/published/immutable/previous/main/full.jpg" },
    };
    const before = structuredClone(existing);
    const next = rotatedVisualSnapshotHistory(existing, {
      page: `visual-snapshots/sources/${legacySourceId}/captures/new/page.jpg`,
    });
    expect(visualSnapshotKeysToDeleteAfterCas({ pointerAdvanced: false, existing, next })).toEqual([]);
    expect(visualSnapshotKeysToDeleteAfterCas({ pointerAdvanced: true, existing, next })).toEqual([]);
    expect(existing).toEqual(before);
    expect(next.previous_object_keys).toEqual(existing.latest_object_keys);
  });

  it("keeps unreferenced fixed aliases after a lost CAS without changing upload or pointer objects", () => {
    const uploaded = Object.fromEntries(legacyFixedFiles.map((filename) => [filename, legacyFixedKey("previous", filename)]));
    uploaded.loser = `visual-snapshots/sources/${legacySourceId}/captures/loser/page.jpg`;
    uploaded.retained = `visual-snapshots/sources/${legacySourceId}/captures/winner/text.txt`;
    const current = { latest_object_keys: { text: uploaded.retained }, previous_object_keys: {} };
    const before = structuredClone({ uploaded, current });
    expect(visualSnapshotUploadedKeysToDeleteAfterLostCas({ uploaded, current })).toEqual([]);
    expect({ uploaded, current }).toEqual(before);
  });

  it.each([
    `/${legacyFixedKey("latest", "page.jpg")}`,
    `prefix/${legacyFixedKey("latest", "page.jpg")}`,
    `https://example.test/${legacyFixedKey("latest", "page.jpg")}`,
    legacyFixedKey("latest", "page.jpg") + "/extra",
    legacyFixedKey("latest", "page.jpg") + "?version=old",
    legacyFixedKey("latest", "page.jpg") + "#original",
    legacyFixedKey("latest", "page.jpg") + "\n",
    legacyFixedKey("latest", "page.jpg") + "\r\n",
    " " + legacyFixedKey("latest", "page.jpg"),
    legacyFixedKey("latest", "page.jpg") + " ",
    legacyFixedKey("latest", "page.jpg").replace("sources/", "sources//"),
    legacyFixedKey("latest", "page.jpg").replace("visual-snapshots/", "Visual-snapshots/"),
    legacyFixedKey("LATEST", "page.jpg"), legacyFixedKey("previous-extra", "page.jpg"),
    legacyFixedKey("latest/subdirectory", "page.jpg"),
    legacyFixedKey("latest", "page.jpg", "source-1"),
    legacyFixedKey("latest", "page.jpg", legacySourceId.replaceAll("-", "")),
    legacyFixedKey("latest", "page.jpg", "11111111-1111-0111-8111-111111111111"),
    legacyFixedKey("latest", "page.jpg", "11111111-1111-9111-8111-111111111111"),
    legacyFixedKey("latest", "page.jpg", "11111111-1111-4111-7111-111111111111"),
    legacyFixedKey("latest", "page.jpg", "abcdefab-cdef-4abc-8abc-abcdefabcdef".toUpperCase()),
    legacyFixedKey("latest", "page.jpg").replace("/latest/", "%2Flatest%2F"),
    legacyFixedKey("latest", "page.jpg").replace("page.jpg", "%70age.jpg"),
    ...["", "page.jpeg", "page.JPG", "page.png", "meta.json.bak", "page.html", "other.txt",
      "expansion-state-00.jpg", "expansion-state-100.jpg", "expansion-state-1.jpg",
      "expansion-state-001.jpg", "expansion-state-01.json", "expansion-state-01-layout.json.bak",
      "expansion-state-01-layout.jpg"].map((filename) => legacyFixedKey("latest", filename)),
  ])("does not extend fixed-key protection to malformed or boundary key %s", (key) => {
    expect(isDeletableVisualSnapshotKey(key)).toBe(true);
  });

  it.each(["captures/generation-1", "approved/review-1"])("preserves ordinary %s deletion eligibility", (generation) => {
    expect(isDeletableVisualSnapshotKey(legacyFixedKey(generation, "page.jpg"))).toBe(true);
  });

  it("does not coerce objects into legacy retention matches or change empty-value behavior", () => {
    expect(isDeletableVisualSnapshotKey({ toString: () => legacyFixedKey("latest", "page.jpg") })).toBe(true);
    for (const empty of [undefined, null, "", false, 0]) expect(isDeletableVisualSnapshotKey(empty)).toBe(false);
    expect(isDeletableVisualSnapshotKey("/visual-snapshots/published/immutable/main.jpg")).toBe(false);
  });
});

describe("cleanup has no reference or create-ownership authority", () => {
  it.each([undefined, {}, { reference_status: "unknown" }, { reference_status: "unavailable" },
    { references_complete: true, created_by_this_operation: true, protected_keys: [] }])
  ("never accepts absent or caller-asserted proof as deletion authority: %j", (unverified) => {
    const original = `visual-snapshots/sources/${legacySourceId}/captures/original/meta.json`;
    const existing = { latest_object_keys: { meta: "current/meta.json" }, previous_object_keys: { meta: original } };
    const next = rotatedVisualSnapshotHistory(existing, { meta: "new/meta.json" });
    const uploaded = { meta: original }, current = { latest_object_keys: {}, previous_object_keys: {} };
    const input = { pointerAdvanced: true, existing, next, uploaded, current, ...unverified };
    const before = structuredClone(input);
    expect(visualSnapshotKeysToDeleteAfterCas(input)).toEqual([]);
    expect(visualSnapshotUploadedKeysToDeleteAfterLostCas(input)).toEqual([]);
    expect(input).toEqual(before);
    expect(next.previous_object_keys).toEqual(existing.latest_object_keys);
  });
});
