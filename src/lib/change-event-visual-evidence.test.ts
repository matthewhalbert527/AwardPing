import { describe, expect, it, vi } from "vitest";
import {
  buildEventVisualEvidenceSide,
  isPublishedVisualEvidenceObjectKey,
} from "@/lib/change-event-visual-evidence";

describe("change event visual evidence", () => {
  it("signs and exposes a crop only for verified exact overlap", async () => {
    const signObjectKey = vi.fn(async (key: string) => `https://signed.test/${key}`);
    const result = await buildEventVisualEvidenceSide({
      captureValue: capture({ cropExact: true }),
      localizationValue: {
        status: "verified",
        exact_overlap: true,
        reason: "Exact added wording overlaps this crop.",
      },
      signObjectKey,
    });

    expect(result.exact_overlap).toBe(true);
    expect(result.objects.crop?.key).toContain("/crop.jpg");
    expect(result.objects.full?.key).toContain("/full.jpg");
    expect(signObjectKey).toHaveBeenCalledTimes(2);
  });

  it.each([
    [{ status: "unavailable_ambiguous", exact_overlap: true }, true],
    [{ status: "verified", exact_overlap: false }, true],
    [{ status: "verified", exact_overlap: true }, false],
  ])(
    "withholds the crop when any exact-overlap gate fails",
    async (localization, cropExact) => {
      const signObjectKey = vi.fn(async (key: string) => `https://signed.test/${key}`);
      const result = await buildEventVisualEvidenceSide({
        captureValue: capture({ cropExact }),
        localizationValue: localization,
        signObjectKey,
      });

      expect(result.exact_overlap).toBe(false);
      expect(result.objects.crop).toBeUndefined();
      expect(result.objects.full?.key).toContain("/full.jpg");
      expect(result.localization_reason).toBeTruthy();
      expect(signObjectKey).toHaveBeenCalledTimes(1);
    },
  );

  it("never signs mutable source-pointer or path-traversal keys", async () => {
    const signObjectKey = vi.fn(async (key: string) => `https://signed.test/${key}`);
    const result = await buildEventVisualEvidenceSide({
      captureValue: {
        full: { object_key: "visual-snapshots/sources/source-1/latest/page.jpg" },
        metadata: { object_key: "visual-snapshots/published/../private/meta.json" },
        crop: {
          object_key: "visual-snapshots/published/event-1/crop.jpg",
          exact_overlap: false,
        },
      },
      localizationValue: { status: "verified", exact_overlap: true },
      signObjectKey,
    });

    expect(result.objects).toEqual({});
    expect(signObjectKey).not.toHaveBeenCalled();
    expect(isPublishedVisualEvidenceObjectKey("visual-snapshots/published/event-1/full.jpg")).toBe(true);
    expect(isPublishedVisualEvidenceObjectKey("visual-snapshots/published/")).toBe(false);
    expect(isPublishedVisualEvidenceObjectKey("visual-snapshots/published/event-1/full.jpg ")).toBe(false);
    expect(isPublishedVisualEvidenceObjectKey("visual-snapshots/sources/source-1/latest/page.jpg")).toBe(false);
  });

  it("downgrades a contradictory verified result when no trustworthy crop key exists", async () => {
    const signObjectKey = vi.fn(async (key: string) => `https://signed.test/${key}`);
    const value = capture({ cropExact: true });
    value.crop.object_key = "visual-snapshots/sources/source-1/latest/crop.jpg";

    const result = await buildEventVisualEvidenceSide({
      captureValue: value,
      localizationValue: {
        status: "verified",
        exact_overlap: true,
        reason: "The stored crop is verified.",
      },
      signObjectKey,
    });

    expect(result.exact_overlap).toBe(false);
    expect(result.localization_status).toBe("full_screenshot_fallback");
    expect(result.localization_reason).toMatch(/no verified exact crop/i);
    expect(result.objects.crop).toBeUndefined();
  });

  it("withholds a crop that is not bound to the selected full-image bytes", async () => {
    const signObjectKey = vi.fn(async (key: string) => `https://signed.test/${key}`);
    const value = capture({ cropExact: true });
    value.crop.source_image_sha256 = "0".repeat(64);

    const result = await buildEventVisualEvidenceSide({
      captureValue: value,
      localizationValue: { status: "verified", exact_overlap: true },
      signObjectKey,
    });

    expect(result.exact_overlap).toBe(false);
    expect(result.localization_status).toBe("full_screenshot_fallback");
    expect(result.objects.crop).toBeUndefined();
    expect(signObjectKey).toHaveBeenCalledTimes(1);
  });
});

function capture({ cropExact }: { cropExact: boolean }) {
  const full = {
    object_key: "visual-snapshots/published/event-1/current/full.jpg",
    sha256: "a".repeat(64),
    byte_length: 12_000,
    content_type: "image/jpeg",
    width: 1200,
    height: 4800,
  };
  return {
    captured_at: "2026-07-15T01:00:00.000Z",
    state_id: "state-current",
    full,
    metadata: {
      object_key: "visual-snapshots/published/event-1/current/meta.json",
      content_type: "application/json",
    },
    crop: {
      object_key: "visual-snapshots/published/event-1/current/crop.jpg",
      content_type: "image/jpeg",
      width: 900,
      height: 500,
      exact_overlap: cropExact,
      clip: { x: 20, y: 300, width: 900, height: 500 },
      source_image_object_key: full.object_key,
      source_image_sha256: full.sha256,
      source_image_byte_length: full.byte_length,
    },
  };
}
