import { describe, expect, it, vi } from "vitest";
import {
  buildChangeEventVisualEvidenceCoverageReport,
  verifyChangeEventManifestArtifacts,
} from "./event-visual-evidence-coverage.mjs";
import {
  sha256VisualSemanticValue,
  visualChangeSemanticManifest,
} from "./visual-event-localization.mjs";

describe("event visual evidence coverage", () => {
  it("HEAD-verifies full and crop SHA metadata plus exact byte length", async () => {
    const evidence = evidenceRow();
    const headObject = vi.fn(headFromEvidence(evidence));

    const result = await verifyChangeEventManifestArtifacts({ evidence, headObject });

    expect(result.checks).toEqual({
      previous: { full: true, crop: false },
      current: { full: true, crop: true },
    });
    expect(headObject).toHaveBeenCalledTimes(8);
    expect(result.details.current.crop.status).toBe("verified");
    expect(result.details.current.verified_crop_chain.verified).toBe(true);
  });

  it("does not count a crop whose HEAD SHA or byte length disagrees with its manifest", async () => {
    const evidence = evidenceRow();
    const result = await verifyChangeEventManifestArtifacts({
      evidence,
      headObject: async ({ key }) => {
        const manifest = manifestByKey(evidence, key);
        return {
          sha256: key.includes("crop") ? "f".repeat(64) : manifest.sha256,
          byte_length: key.includes("crop") ? 1 : manifest.byte_length,
          content_type: manifest.content_type,
        };
      },
    });

    expect(result.checks.current.crop).toBe(false);
    expect(result.details.current.crop).toMatchObject({
      status: "head_mismatch",
      sha256_matches: false,
      byte_length_matches: false,
      solution: expect.stringMatching(/current-pointer data/i),
    });
  });

  it("does not count a crop whose declared source image differs from the selected full image", async () => {
    const evidence = evidenceRow();
    evidence.current_capture.crop.source_image_sha256 = "0".repeat(64);
    const result = await verifyChangeEventManifestArtifacts({
      evidence,
      headObject: headFromEvidence(evidence),
    });

    expect(result.details.current.crop.status).toBe("verified");
    expect(result.checks.current.crop).toBe(false);
    expect(result.details.current.verified_crop_chain).toMatchObject({
      verified: false,
      crop_source_image_bound: false,
      solution: expect.stringMatching(/source image key\/hash\/bytes/i),
    });
  });

  it("reports missing metadata and state images with safe remediation", async () => {
    const evidence = evidenceRow();
    evidence.previous_capture.metadata = null;
    evidence.current_capture.states = [{
      state_id: "expanded-1",
      image: null,
      geometry: artifact("current/state-geometry", "d", 40, "application/json"),
    }];

    const result = await verifyChangeEventManifestArtifacts({
      evidence,
      headObject: headFromEvidence(evidence),
    });

    expect(result.details.previous.metadata).toMatchObject({
      status: "missing_required_manifest",
      solution: expect.stringMatching(/mark only that side unavailable/i),
    });
    expect(result.artifacts).toContainEqual(expect.objectContaining({
      side: "current",
      role: "state.image",
      state_id: "expanded-1",
      status: "missing_required_manifest",
      solution: expect.any(String),
    }));
    expect(result.checks.current.crop).toBe(false);
    expect(result.details.current.verified_crop_chain).toMatchObject({
      verified: false,
      crop_verified: true,
      selected_state_image_verified: false,
      solution: expect.stringMatching(/selected state image/i),
    });
  });

  it("fails HEAD integrity when stored content type differs from the manifest", async () => {
    const evidence = evidenceRow();
    const result = await verifyChangeEventManifestArtifacts({
      evidence,
      headObject: async ({ key }) => {
        const manifest = manifestByKey(evidence, key);
        return {
          sha256: manifest.sha256,
          byte_length: manifest.byte_length,
          content_type: key.includes("current/full") ? "text/plain" : manifest.content_type,
        };
      },
    });

    expect(result.checks.current.full).toBe(false);
    expect(result.details.current.full).toMatchObject({
      status: "head_mismatch",
      sha256_matches: true,
      byte_length_matches: true,
      content_type_matches: false,
      solution: expect.any(String),
    });
  });

  it("includes suppressed events in retention while splitting public metrics", () => {
    const publicEvent = eventRow();
    const suppressedEvent = eventRow({ id: "event-2", suppressed_at: "2026-07-15T02:00:00.000Z" });
    const publicEvidence = evidenceRow();
    const suppressedEvidence = evidenceRow({ change_event_id: "event-2" });
    const checks = { previous: { full: true, crop: false }, current: { full: true, crop: true } };

    const report = buildChangeEventVisualEvidenceCoverageReport({
      events: [publicEvent, suppressedEvent],
      evidenceByEvent: new Map([
        [publicEvent.id, publicEvidence],
        [suppressedEvent.id, suppressedEvidence],
      ]),
      artifactChecksByEvent: new Map([
        [publicEvent.id, checks],
        [suppressedEvent.id, checks],
      ]),
    });

    expect(report).toMatchObject({
      event_count: 2,
      public_unsuppressed_event_count: 1,
      suppressed_retained_event_count: 1,
      retention: {
        published_event_count: 2,
        verified_event_crop_sides: 2,
      },
      public_unsuppressed: {
        published_event_count: 1,
        verified_event_crop_sides: 1,
      },
      suppressed_retention: {
        published_event_count: 1,
        verified_event_crop_sides: 1,
      },
    });
  });

  it("reports verified crop sides rather than treating layout metadata as coverage", () => {
    const event = eventRow();
    const evidence = evidenceRow();
    evidence.current_capture.crop = null;
    evidence.current_capture.layout = {
      object_key: "visual-snapshots/published/candidate/current/layout.json",
      sha256: "e".repeat(64),
      byte_length: 500,
    };

    const report = buildChangeEventVisualEvidenceCoverageReport({
      events: [event],
      evidenceByEvent: new Map([[event.id, evidence]]),
      artifactChecksByEvent: new Map([[
        event.id,
        { previous: { full: true, crop: false }, current: { full: true, crop: false } },
      ]]),
    });

    expect(report.retention.verified_event_crop_sides).toBe(0);
    expect(report.retention.full_screenshot_fallback_sides).toBe(1);
  });

  it("HEAD-checks retained PDF documents as full artifacts without inventing crop coverage", async () => {
    const event = eventRow({ change_details: {} });
    const evidence = evidenceRow({
      evidence_status: "not_applicable_pdf",
      previous_capture: {
        full: { ...artifact("previous/document", "a", 100), content_type: "application/pdf" },
        metadata: artifact("previous/metadata", "d", 30, "application/json"),
        crop: null,
      },
      current_capture: {
        full: { ...artifact("current/document", "b", 100), content_type: "application/pdf" },
        metadata: artifact("current/metadata", "e", 30, "application/json"),
        crop: null,
      },
      localization: {
        direction: "changed",
        sides: {
          previous: { status: "not_applicable_pdf", exact_overlap: false },
          current: { status: "not_applicable_pdf", exact_overlap: false },
        },
      },
    });
    const verified = await verifyChangeEventManifestArtifacts({
      evidence,
      headObject: headFromEvidence(evidence),
    });
    const report = buildChangeEventVisualEvidenceCoverageReport({
      events: [event],
      evidenceByEvent: new Map([[event.id, evidence]]),
      artifactChecksByEvent: new Map([[event.id, verified.checks]]),
    });

    expect(verified.checks).toEqual({
      previous: { full: true, crop: false },
      current: { full: true, crop: false },
    });
    expect(report.retention).toMatchObject({
      retained_full_capture_sides: 2,
      required_localization_sides: 0,
      verified_event_crop_sides: 0,
    });
  });

  it("treats a truthfully unavailable historical side as absent, not a broken manifest", async () => {
    const evidence = evidenceRow({
      evidence_status: "unavailable_image_missing",
      previous_capture: {
        full: null,
        metadata: null,
        crop: null,
      },
      localization: {
        direction: "mixed",
        sides: {
          previous: {
            status: "historical_artifact_unrecoverable",
            required: true,
            exact_overlap: false,
          },
          current: { status: "verified", required: true, exact_overlap: true },
        },
      },
    });

    const verified = await verifyChangeEventManifestArtifacts({
      evidence,
      headObject: headFromEvidence(evidence),
    });

    expect(verified.details.previous.full).toEqual({ verified: false, status: "not_present" });
    expect(verified.artifacts).not.toContainEqual(expect.objectContaining({
      side: "previous",
      status: "missing_required_manifest",
    }));
    expect(verified.checks.current.full).toBe(true);
  });
});

function eventRow(overrides = {}) {
  return {
    id: "event-1",
    change_details: { exact_after: "Applications close April 15." },
    suppressed_at: null,
    ...overrides,
  };
}

function evidenceRow(overrides = {}) {
  const currentFull = artifact("current/full", "b", 100, "image/jpeg");
  const currentLayout = artifact("current/layout", "f", 70, "application/json; charset=utf-8");
  const rect = { x: 10, y: 20, width: 300, height: 120 };
  const manifest = visualChangeSemanticManifest(eventRow().change_details);
  const candidate = manifest.sides.current.candidates[0];
  const bindingCore = {
    contract: "visual-exact-text-binding-v2",
    algorithm_version: 3,
    side: "current",
    wording_source: candidate.source,
    exact_text_sha256: candidate.normalized_text_sha256,
    candidates_sha256: manifest.sides.current.candidates_sha256,
    change_semantics_sha256: manifest.change_semantics_sha256,
    state_id: "main",
    geometry_sha256: "9".repeat(64),
    matched_node_orders: [0],
    matched_rects_sha256: sha256VisualSemanticValue([rect]),
    crop_rect_sha256: sha256VisualSemanticValue(rect),
    crop_rect_pixels_sha256: sha256VisualSemanticValue(rect),
  };
  const binding = { ...bindingCore, binding_sha256: sha256VisualSemanticValue(bindingCore) };
  return {
    change_event_id: "event-1",
    visual_review_candidate_id: "candidate-1",
    bucket: "bucket-1",
    evidence_status: "verified",
    evidence_schema_version: "visual-event-evidence-v2",
    previous_capture: {
      full: artifact("previous/full", "a", 100, "image/jpeg"),
      metadata: artifact("previous/metadata", "d", 30, "application/json"),
      crop: null,
    },
    current_capture: {
      full: currentFull,
      metadata: artifact("current/metadata", "e", 30, "application/json"),
      layout: { ...currentLayout, state_id: "main", geometry_hash: "9".repeat(64) },
      crop: {
        ...artifact("current/crop", "c", 50, "image/jpeg"),
        exact_overlap: true,
        state_id: "main",
        source_image_object_key: currentFull.object_key,
        source_image_sha256: currentFull.sha256,
        source_image_byte_length: currentFull.byte_length,
        semantic_binding_sha256: binding.binding_sha256,
        exact_text_sha256: binding.exact_text_sha256,
        geometry_sha256: binding.geometry_sha256,
      },
      state_id: "main",
      states: [{
        state_id: "main",
        kind: "main",
        image: currentFull,
        geometry: currentLayout,
        geometry_hash: "9".repeat(64),
      }],
    },
    localization: {
      direction: "added",
      semantic_contract: manifest.contract,
      change_semantics_sha256: manifest.change_semantics_sha256,
      sides: {
        previous: {
          status: "unavailable_not_required_for_added_wording",
          required: false,
          exact_overlap: false,
          reason: "No previous wording is required for this added text.",
        },
        current: {
          status: "verified",
          required: true,
          exact_overlap: true,
          exact_text: candidate.normalized_text,
          matched_rects: [rect],
          crop_rect: rect,
          crop_rect_pixels: rect,
          algorithm_version: "3",
          state_id: "main",
          semantic_verified: true,
          semantic_binding: binding,
        },
      },
    },
    backfilled_at: null,
    ...overrides,
  };
}

function artifact(path, digest, byteLength, contentType = "image/jpeg") {
  return {
    object_key: `visual-snapshots/published/candidate-1/${path}.jpg`,
    sha256: digest.repeat(64),
    byte_length: byteLength,
    content_type: contentType,
  };
}

function headFromEvidence(evidence) {
  return async ({ key }) => {
    const manifest = manifestByKey(evidence, key);
    if (!manifest) throw Object.assign(new Error("missing"), { name: "NotFound" });
    return {
      sha256: manifest.sha256,
      byte_length: manifest.byte_length,
      content_type: manifest.content_type,
    };
  };
}

function manifestByKey(evidence, key) {
  for (const side of ["previous", "current"]) {
    const capture = evidence[`${side}_capture`] || {};
    for (const role of ["full", "crop", "metadata", "main_full", "thumbnail", "text", "layout"]) {
      if (capture[role]?.object_key === key) return capture[role];
    }
    for (const state of capture.states || []) {
      if (state.image?.object_key === key) return state.image;
      if (state.geometry?.object_key === key) return state.geometry;
    }
  }
  return null;
}
