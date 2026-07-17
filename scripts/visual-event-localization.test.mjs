import { describe, expect, it } from "vitest";
import {
  VISUAL_EVENT_LOCALIZATION_ALGORITHM_VERSION,
  bindVisualTextGeometry,
  directionalVisualLocalizationPhrases,
  findExactTextNodeMatch,
  localizeVisualEventSide,
  normalizeVisualExactText,
  planVerifiedCrop,
  verifyVisualTextGeometryBinding,
  verifyVisualEventSemanticBindings,
  verifyVisualExactTextSemanticBinding,
  visualChangeSemanticManifest,
  visualExactTokens,
} from "./lib/visual-event-localization.mjs";

describe("visual event localization", () => {
  it("normalizes only Unicode, quote, and whitespace variants for exact matching", () => {
    expect(normalizeVisualExactText("  Applications\u00a0close \u201cFebruary 1\u201d  ")).toBe(
      'Applications close "February 1"',
    );
    expect(visualExactTokens("Award: $5,000.")).toEqual(["Award", ":", "$", "5,000", "."]);
  });

  it("matches exact wording across ordered text nodes and plans an overlapping crop", () => {
    const geometry = boundGeometry({
      imageHash: "current-image",
      nodes: [
        textNode(0, "Applications close", 80, 300, { flowPath: "body>main>p#deadline" }),
        textNode(1, "February 1, 2027.", 230, 300, { flowPath: "body>main>p#deadline" }),
      ],
    });
    const result = localizeVisualEventSide({
      side: "current",
      changeDetails: { exact_after: "Applications close February 1, 2027." },
      states: [state("main", "main", geometry, "current-image")],
      padding: 24,
    });

    expect(result).toMatchObject({
      status: "verified",
      side: "current",
      state_id: "main",
      exact_text: "Applications close February 1, 2027.",
      phrase_source: "change_details.exact_after",
      exact_overlap: true,
      algorithm_version: VISUAL_EVENT_LOCALIZATION_ALGORITHM_VERSION,
    });
    expect(result.matched_rects.length).toBeGreaterThanOrEqual(5);
    expect(result.crop_rect.width).toBeGreaterThanOrEqual(360);
    expect(result.crop_rect_pixels).toMatchObject({ x: expect.any(Number), width: expect.any(Number) });
    expect(result.semantic_verified).toBe(true);
    expect(result.semantic_binding).toMatchObject({
      contract: "visual-exact-text-binding-v2",
      algorithm_version: 3,
      side: "current",
      wording_source: "change_details.exact_after",
      geometry_sha256: geometry.geometry_hash,
      binding_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(verifyVisualExactTextSemanticBinding({
      side: "current",
      changeDetails: { exact_after: "Applications close February 1, 2027." },
      localization: result,
      capture: semanticCapture(result, geometry),
    })).toMatchObject({ valid: true });
  });

  it("rejects exact wording synthesized across distant or unrelated text nodes", () => {
    const distantGeometry = boundGeometry({
      imageHash: "current-image",
      nodes: [
        textNode(0, "Applications close", 80, 100, { flowPath: "body>main>p#deadline" }),
        textNode(1, "February 1, 2027.", 80, 4_100, { flowPath: "body>main>p#deadline" }),
      ],
    });
    const unrelatedGeometry = boundGeometry({
      imageHash: "current-image",
      nodes: [
        textNode(0, "Applications close", 80, 100, { flowPath: "body>main>section#eligibility" }),
        textNode(1, "February 1, 2027.", 230, 100, { flowPath: "body>footer" }),
      ],
    });

    for (const geometry of [distantGeometry, unrelatedGeometry]) {
      expect(findExactTextNodeMatch({
        geometry,
        exactText: "Applications close February 1, 2027.",
      })).toMatchObject({ status: "unavailable_exact_text_not_found" });
    }
  });

  it("rejects wording synthesized by inserting whitespace across a no-separator node boundary", () => {
    const geometry = boundGeometry({
      imageHash: "current-image",
      nodes: [
        textNode(0, "Applications", 80, 100, { flowPath: "body>main>p#deadline" }),
        textNode(1, "close February 1, 2027.", 180, 100, {
          flowPath: "body>main>p#deadline",
          separatorBefore: "",
        }),
      ],
    });

    expect(findExactTextNodeMatch({
      geometry,
      exactText: "Applications close February 1, 2027.",
    })).toMatchObject({ status: "unavailable_exact_text_not_found" });
  });

  it("does not authorize summaries or candidate-only deterministic text as event-semantic wording", () => {
    const geometry = boundGeometry({
      imageHash: "current-image",
      nodes: [textNode(0, "The deadline is March 1.", 40, 300)],
    });
    const result = localizeVisualEventSide({
      side: "current",
      changeDetails: { after: "The deadline is March 1." },
      deterministicDiff: { added_text: ["The deadline is March 1."] },
      states: [state("main", "main", geometry, "current-image")],
    });

    expect(result.status).toBe("unavailable_exact_text");
    expect(visualChangeSemanticManifest({ after: "The deadline is March 1." })
      .sides.current.candidates).toEqual([]);
  });

  it("fails a mixed event unless both directional crops retain their event-semantic bindings", () => {
    const details = {
      exact_before: "Deadline February 1",
      exact_after: "Deadline March 1",
    };
    const previousGeometry = boundGeometry({
      imageHash: "previous-image",
      nodes: [textNode(0, details.exact_before, 40, 300)],
    });
    const currentGeometry = boundGeometry({
      imageHash: "current-image",
      nodes: [textNode(0, details.exact_after, 40, 300)],
    });
    const previous = localizeVisualEventSide({
      side: "previous",
      changeDetails: details,
      states: [state("previous", "main", previousGeometry, "previous-image")],
    });
    const current = localizeVisualEventSide({
      side: "current",
      changeDetails: details,
      states: [state("current", "main", currentGeometry, "current-image")],
    });
    const currentCapture = semanticCapture(current, currentGeometry);
    currentCapture.crop.exact_text_sha256 = "0".repeat(64);

    expect(verifyVisualEventSemanticBindings({
      changeDetails: details,
      localization: { direction: "mixed", sides: { previous, current } },
      previousCapture: semanticCapture(previous, previousGeometry),
      currentCapture,
    })).toMatchObject({ valid: false, reason: "required_semantic_side_invalid" });
  });

  it("selects removed wording only from the previous side", () => {
    const previousGeometry = boundGeometry({
      imageHash: "previous-image",
      nodes: [textNode(0, "Letters of recommendation are required.", 70, 520)],
    });
    const details = {
      exact_before: "Letters of recommendation are required.",
      exact_after: null,
      structured_diff: { removed_text: ["Letters of recommendation are required."] },
    };

    expect(localizeVisualEventSide({
      side: "previous",
      changeDetails: details,
      states: [state("previous-main", "main", previousGeometry, "previous-image")],
    }).status).toBe("verified");
    expect(localizeVisualEventSide({
      side: "current",
      changeDetails: details,
      states: [state("current-main", "main", previousGeometry, "previous-image")],
    }).status).toBe("unavailable_not_required_for_removed_wording");
  });

  it("selects added wording only from the current side", () => {
    const details = {
      exact_before: null,
      exact_after: "A portfolio is now required.",
      structured_diff: { added_text: ["A portfolio is now required."] },
    };
    expect(directionalVisualLocalizationPhrases({ side: "previous", changeDetails: details })).toEqual([]);
    expect(directionalVisualLocalizationPhrases({ side: "current", changeDetails: details })[0]).toMatchObject({
      normalized: "A portfolio is now required.",
    });
    expect(localizeVisualEventSide({
      side: "previous",
      changeDetails: details,
      states: [],
    }).status).toBe("unavailable_not_required_for_added_wording");
  });

  it("prefers the exact changed delta over a longer whole-section fallback", () => {
    const sectionText =
      "Eligibility details for all applicants. The deadline is March 1. Supporting documents remain unchanged.";
    const geometry = boundGeometry({
      imageHash: "current-image",
      nodes: [textNode(0, sectionText, 40, 300)],
    });
    const result = localizeVisualEventSide({
      side: "current",
      changeDetails: { exact_after: "The deadline is March 1." },
      deterministicDiff: {
        added_text: ["The deadline is March 1."],
        exact_after_text: sectionText,
      },
      states: [state("main", "main", geometry, "current-image")],
      padding: 12,
    });

    expect(result).toMatchObject({
      status: "verified",
      exact_text: "The deadline is March 1.",
      phrase_source: "change_details.exact_after",
    });
    expect(result.matched_rects.length).toBeLessThan(visualExactTokens(sectionText).length);
  });

  it("rejects token-overlap and case variants instead of fuzzy matching", () => {
    const geometry = boundGeometry({
      imageHash: "image-a",
      nodes: [textNode(0, "Applications for graduate students close on February 1.", 40, 240)],
    });
    const stateValue = state("main", "main", geometry, "image-a");

    expect(localizeVisualEventSide({
      side: "current",
      exactText: "Graduate applications close February 1.",
      states: [stateValue],
    }).status).toBe("unavailable_exact_text_not_found");
    expect(localizeVisualEventSide({
      side: "current",
      exactText: "applications for graduate students close on February 1.",
      states: [stateValue],
    }).status).toBe("unavailable_exact_text_not_found");
  });

  it("fails closed when exact wording occurs more than once", () => {
    const geometry = boundGeometry({
      imageHash: "image-a",
      nodes: [
        textNode(0, "Deadline: February 1.", 40, 200),
        textNode(1, "Deadline: February 1.", 40, 900),
      ],
    });
    const result = findExactTextNodeMatch({ geometry, exactText: "Deadline: February 1." });
    expect(result.status).toBe("unavailable_ambiguous_exact_match");
  });

  it("uses an opened accordion state only when the main image lacks the exact wording", () => {
    const main = boundGeometry({
      imageHash: "main-image",
      nodes: [textNode(0, "Eligibility", 40, 200)],
    });
    const accordion = boundGeometry({
      imageHash: "accordion-image",
      nodes: [textNode(0, "Applicants must have a 3.5 GPA.", 60, 760)],
    });
    const result = localizeVisualEventSide({
      side: "current",
      exactText: "Applicants must have a 3.5 GPA.",
      states: [
        state("main", "main", main, "main-image"),
        state("accordion-eligibility", "expansion_state", accordion, "accordion-image"),
      ],
    });

    expect(result).toMatchObject({
      status: "verified",
      state_id: "accordion-eligibility",
      state_kind: "expansion_state",
      exact_overlap: true,
    });
  });

  it("rejects the same exact wording across multiple accordion states as ambiguous", () => {
    const first = boundGeometry({
      imageHash: "first-image",
      nodes: [textNode(0, "Submit by March 1.", 60, 500)],
    });
    const second = boundGeometry({
      imageHash: "second-image",
      nodes: [textNode(0, "Submit by March 1.", 60, 700)],
    });
    expect(localizeVisualEventSide({
      side: "current",
      exactText: "Submit by March 1.",
      states: [
        state("one", "expansion_state", first, "first-image"),
        state("two", "expansion_state", second, "second-image"),
      ],
    }).status).toBe("unavailable_ambiguous_exact_match");
  });

  it("fails closed when geometry is rebound to a different image", () => {
    const geometry = boundGeometry({
      imageHash: "bound-image",
      nodes: [textNode(0, "Deadline changed to May 1.", 40, 300)],
    });
    expect(verifyVisualTextGeometryBinding(geometry, "different-image")).toEqual({
      valid: false,
      reason: "bound_image_hash_mismatch",
    });
    expect(localizeVisualEventSide({
      side: "current",
      exactText: "Deadline changed to May 1.",
      states: [state("main", "main", geometry, "different-image")],
    }).status).toBe("unavailable_geometry_binding");
  });

  it("refuses a crop when a supplied exact rectangle lies outside the screenshot", () => {
    const geometry = boundGeometry({ imageHash: "image-a", nodes: [textNode(0, "Text", 20, 20)] });
    const result = planVerifiedCrop({
      geometry,
      matchedRects: [{ x: 1_500, y: 1_500, width: 50, height: 20 }],
    });
    expect(result).toMatchObject({
      status: "unavailable_crop_overlap_failed",
      exact_overlap: false,
    });
  });

  it("rejects malformed negative-size rectangles instead of treating them as exact evidence", () => {
    const geometry = boundGeometry({ imageHash: "image-a", nodes: [textNode(0, "Text", 20, 20)] });
    expect(planVerifiedCrop({
      geometry,
      matchedRects: [{ x: 100, y: 100, right: 50, bottom: 80 }],
    }).status).toBe("unavailable_match_rectangles");
  });
});

function boundGeometry({ imageHash, nodes }) {
  return bindVisualTextGeometry({
    captured_at: "2026-07-15T18:00:00.000Z",
    document: { width: 1_000, height: 2_000 },
    viewport: { width: 1_000, height: 800 },
    device_pixel_ratio: 1,
    nodes,
  }, {
    capturedAt: "2026-07-15T18:00:00.000Z",
    imageHash,
    screenshot: {
      css_width: 1_000,
      css_height: 2_000,
      pixel_width: 1_000,
      pixel_height: 2_000,
    },
  });
}

function textNode(order, text, x, y, { flowPath = null, separatorBefore = null } = {}) {
  let cursor = x;
  const runs = visualExactTokens(text).map((token, index) => {
    const width = Math.max(8, token.length * 8);
    const run = {
      start: index,
      end: index + token.length,
      text: token,
      rects: [{ x: cursor, y, width, height: 20 }],
    };
    cursor += width + 5;
    return run;
  });
  return {
    order,
    path: `main>p:nth-of-type(${order + 1})`,
    flow_path: flowPath || `body>main>p:nth-of-type(${order + 1})`,
    text,
    separator_before: separatorBefore ?? (order === 0 ? "" : " "),
    rects: [{ x, y, width: Math.max(20, cursor - x), height: 20 }],
    runs,
  };
}

function state(stateId, kind, geometry, imageHash) {
  return {
    state_id: stateId,
    kind,
    image_path: `C:/captures/${stateId}.jpg`,
    image_hash: imageHash,
    geometry,
  };
}

function semanticCapture(localization, geometry) {
  return {
    state_id: localization.state_id,
    layout: { geometry_hash: geometry.geometry_hash },
    crop: {
      semantic_binding_sha256: localization.semantic_binding.binding_sha256,
      exact_text_sha256: localization.semantic_binding.exact_text_sha256,
      geometry_sha256: localization.semantic_binding.geometry_sha256,
    },
  };
}
