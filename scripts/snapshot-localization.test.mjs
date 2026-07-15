import { describe, expect, it } from "vitest";
import {
  classifySnapshotLocalization,
  hasLayoutMetadata,
  summarizeSnapshotLocalization,
} from "./lib/snapshot-localization.mjs";

const localizedMeta = {
  dimensions: { scroll_height: 4_000 },
  page_settle: { after_layout_sample: "div:0:120:0:40:0:0:0:Application deadline February 1" },
};
const imageObjects = { page: "visual-snapshots/source/latest/page.jpg", meta: "meta.json" };

describe("snapshot localization coverage", () => {
  it("recognizes searchable layout metadata", () => {
    expect(hasLayoutMetadata(localizedMeta)).toBe(true);
    expect(
      classifySnapshotLocalization({
        version: "latest",
        objectKeys: imageObjects,
        hashes: { image_hash: "image-a" },
        meta: localizedMeta,
      }).status,
    ).toBe("ready");
  });

  it("uses layout metadata from an identical retained version", () => {
    const result = classifySnapshotLocalization({
      version: "previous",
      objectKeys: imageObjects,
      hashes: { image_hash: "same-image" },
      meta: { dimensions: { scroll_height: 4_000 } },
      peerHashes: { image_hash: "same-image" },
      peerMeta: localizedMeta,
    });

    expect(result.status).toBe("ready_via_identical_peer");
    expect(result.exact).toBe(true);
  });

  it.each(["latest", "previous"])(
    "uses an identical localized peer before treating %s metadata errors as unresolved",
    (version) => {
      const result = classifySnapshotLocalization({
        version,
        objectKeys: imageObjects,
        hashes: { image_hash: "same-image" },
        meta: null,
        metaError: "R2 metadata object could not be read",
        peerHashes: { image_hash: "same-image" },
        peerMeta: localizedMeta,
      });

      expect(result.status).toBe("ready_via_identical_peer");
      expect(result.exact).toBe(true);
      expect(result.repair_needed).toBe(false);
    },
  );

  it("accounts for non-reconstructable historical screenshots without calling them exact", () => {
    const result = classifySnapshotLocalization({
      version: "previous",
      objectKeys: imageObjects,
      hashes: { image_hash: "old-image" },
      meta: {},
      peerHashes: { image_hash: "current-image" },
      peerMeta: localizedMeta,
    });

    expect(result.status).toBe("historical_layout_unavailable");
    expect(result.accounted_for).toBe(true);
    expect(result.exact).toBe(false);
    expect(result.repair_needed).toBe(false);
  });

  it("treats an unreadable historical metadata object as a truthful fallback", () => {
    const result = classifySnapshotLocalization({
      version: "previous",
      objectKeys: imageObjects,
      hashes: { image_hash: "historical-image" },
      meta: null,
      metaError: "R2 object not found",
    });

    expect(result.status).toBe("historical_layout_unavailable");
    expect(result.accounted_for).toBe(true);
    expect(result.repair_needed).toBe(false);
  });

  it("completes automated localization when only a truthful historical fallback remains", () => {
    const summary = summarizeSnapshotLocalization([
      {
        latest: classifySnapshotLocalization({
          version: "latest",
          objectKeys: imageObjects,
          hashes: { image_hash: "current-image" },
          meta: localizedMeta,
        }),
        previous: classifySnapshotLocalization({
          version: "previous",
          objectKeys: imageObjects,
          hashes: { image_hash: "historical-image" },
          meta: {},
          peerHashes: { image_hash: "current-image" },
          peerMeta: localizedMeta,
        }),
      },
    ]);

    expect(summary.automated_localization_complete).toBe(true);
    expect(summary.historical_layout_unavailable).toBe(1);
    expect(summary.accounted_for_percent).toBe(100);
  });

  it("keeps current screenshots without layout metadata in the repair backlog", () => {
    const summary = summarizeSnapshotLocalization([
      {
        latest: classifySnapshotLocalization({
          version: "latest",
          objectKeys: imageObjects,
          hashes: { image_hash: "current-image" },
          meta: {},
        }),
        previous: classifySnapshotLocalization({
          version: "previous",
          objectKeys: {},
          hashes: {},
          meta: null,
        }),
      },
    ]);

    expect(summary.latest_repair_needed).toBe(1);
    expect(summary.automated_localization_complete).toBe(false);
    expect(summary.accounted_for_percent).toBe(0);
  });

  it("accounts for a completed repair when the page produced no visual layout", () => {
    const result = classifySnapshotLocalization({
      version: "latest",
      objectKeys: imageObjects,
      hashes: { image_hash: "blank" },
      meta: null,
      recordMetadata: {
        capture_profile: "localization-repair",
        localization: { status: "capture_layout_unavailable" },
      },
    });

    expect(result.status).toBe("capture_layout_unavailable");
    expect(result.exact).toBe(false);
    expect(result.accounted_for).toBe(true);
    expect(result.repair_needed).toBe(false);
  });
});
