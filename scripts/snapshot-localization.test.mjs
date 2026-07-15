import { describe, expect, it } from "vitest";
import {
  classifyChangeEventVisualEvidence,
  classifySnapshotLocalization,
  hasLayoutMetadata,
  summarizeChangeEventVisualEvidence,
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
    expect(summary).toMatchObject({
      metric_scope: "source_pointer_layout_metadata_not_event_crop",
      searchable_layout_coverage_percent: 50,
    });
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

describe("published event crop coverage", () => {
  const artifact = (name) => ({
    object_key: `visual-snapshots/published/candidate/${name}.jpg`,
    sha256: "a".repeat(64),
    byte_length: 120,
    content_type: "image/jpeg",
  });
  const event = {
    id: "event-1",
    change_details: {
      exact_before: "Applications close February 1.",
      exact_after: "Applications close March 1.",
    },
  };

  it("does not count layout metadata or an unchecked crop as verified", () => {
    const result = classifyChangeEventVisualEvidence({
      event,
      evidence: {
        change_event_id: "event-1",
        evidence_status: "verified",
        previous_capture: { full: artifact("previous-full"), crop: artifact("previous-crop") },
        current_capture: { full: artifact("current-full"), crop: artifact("current-crop") },
        localization: {
          sides: {
            previous: { status: "verified", exact_overlap: true },
            current: { status: "verified", exact_overlap: true },
          },
        },
      },
      artifactChecks: {
        previous: { full: true, crop: false },
        current: { full: true, crop: false },
      },
    });

    expect(result.sides.previous.verified_crop).toBe(false);
    expect(result.sides.current.verified_crop).toBe(false);
    expect(summarizeChangeEventVisualEvidence([result])).toMatchObject({
      required_localization_sides: 2,
      verified_event_crop_sides: 0,
      verified_event_crop_coverage_percent: 0,
      full_screenshot_fallback_sides: 2,
    });
  });

  it("requires directional exact overlap and verified retained crop objects", () => {
    const result = classifyChangeEventVisualEvidence({
      event,
      evidence: {
        change_event_id: "event-1",
        visual_review_candidate_id: "candidate-1",
        evidence_status: "verified",
        previous_capture: {
          full: artifact("previous-full"),
          crop: { ...artifact("previous-crop"), exact_overlap: true },
        },
        current_capture: {
          full: artifact("current-full"),
          crop: { ...artifact("current-crop"), exact_overlap: true },
        },
        localization: {
          sides: {
            previous: { status: "verified", exact_overlap: true },
            current: { status: "verified", exact_overlap: true },
          },
        },
      },
      artifactChecks: {
        previous: { full: true, crop: true },
        current: { full: true, crop: true },
      },
    });

    expect(summarizeChangeEventVisualEvidence([result])).toMatchObject({
      immutable_evidence_event_count: 1,
      candidate_bound_event_count: 1,
      verified_event_crop_sides: 2,
      verified_event_crop_coverage_percent: 100,
    });
  });

  it("marks historical events without evidence instead of borrowing source pointers", () => {
    const result = classifyChangeEventVisualEvidence({ event, evidence: null });
    expect(result.status).toBe("missing_evidence_binding");
    expect(result.sides.previous.retained_full).toBe(false);
    expect(result.sides.current.retained_full).toBe(false);
  });

  it("reports no exact-wording denominator as not applicable instead of perfect coverage", () => {
    const result = classifyChangeEventVisualEvidence({
      event: {
        id: "event-without-exact-wording",
        change_details: { summary: "The page changed visually." },
      },
      evidence: null,
    });

    expect(summarizeChangeEventVisualEvidence([result])).toMatchObject({
      events_with_exact_localization_target: 0,
      events_without_exact_localization_target: 1,
      events_without_exact_localization_target_by_status: { missing_evidence_binding: 1 },
      required_localization_sides: 0,
      verified_event_crop_coverage_percent: null,
      all_required_event_crops_verified: null,
      exact_localization_target_status: "not_applicable_no_exact_wording",
    });
  });

  it("uses immutable evidence requirements and reports stale event-side metadata", () => {
    const currentCrop = { ...artifact("current-crop"), exact_overlap: true };
    const result = classifyChangeEventVisualEvidence({
      event: {
        id: "event-structured-diff",
        change_details: {},
      },
      evidence: {
        change_event_id: "event-structured-diff",
        visual_review_candidate_id: "candidate-structured-diff",
        evidence_status: "verified",
        previous_capture: { full: artifact("previous-full"), crop: null },
        current_capture: { full: artifact("current-full"), crop: currentCrop },
        localization: {
          direction: "added",
          sides: {
            previous: { status: "not_required", required: false, exact_overlap: false },
            current: { status: "verified", required: true, exact_overlap: true },
          },
        },
      },
      artifactChecks: {
        previous: { full: true, crop: false },
        current: { full: true, crop: true },
      },
    });

    expect(result).toMatchObject({
      required_sides: ["current"],
      required_side_source: "immutable_evidence",
      required_side_mismatch: true,
      event_required_sides: [],
      sides: { current: { verified_crop: true } },
    });
    expect(summarizeChangeEventVisualEvidence([result])).toMatchObject({
      required_localization_sides: 1,
      verified_event_crop_sides: 1,
      verified_event_crop_coverage_percent: 100,
      required_side_mismatch_events: 1,
    });
  });

  it("derives missing-evidence sides from structured directional wording", () => {
    const result = classifyChangeEventVisualEvidence({
      event: {
        id: "event-structured-only",
        change_details: {
          structured_diff: {
            removed_text: ["Deadline February 1"],
            added_text: ["Deadline March 1"],
          },
        },
      },
      evidence: null,
    });

    expect(result.required_sides).toEqual(["previous", "current"]);
  });
});
