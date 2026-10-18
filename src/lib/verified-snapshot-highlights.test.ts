import { describe, expect, it, vi } from "vitest";
import { buildEventVisualEvidenceSide } from "@/lib/change-event-visual-evidence";
import { buildVerifiedSnapshotHighlights, snapshotHighlightRects } from "@/lib/verified-snapshot-highlights";

// Synthetic geometry only; these fixtures do not establish real-world coverage.
function fixture(scale = 1) {
  const css = { x: 20, y: 300, width: 900, height: 500 };
  const clip = Object.fromEntries(Object.entries(css).map(([key, value]) => [key, value * scale]));
  const full = { object_key: "visual-snapshots/published/event/full.jpg", sha256: "a".repeat(64),
    byte_length: 12_000, content_type: "image/jpeg", width: 1_200 * scale, height: 4_800 * scale };
  return {
    exactCropAllowed: true,
    captureValue: { full, crop: { object_key: "visual-snapshots/published/event/crop.jpg", content_type: "image/jpeg",
      exact_overlap: true, clip, css_clip: css, width: 900 * scale, height: 500 * scale,
      source_image_object_key: full.object_key, source_image_sha256: full.sha256, source_image_byte_length: full.byte_length } },
    localizationValue: { status: "verified", exact_overlap: true, semantic_verified: true,
      crop_rect: css, crop_rect_pixels: clip,
      matched_rects: [{ x: 65, y: 350, width: 80, height: 20 }, { x: 150, y: 350, width: 95, height: 20 },
        { x: 65, y: 380, width: 135, height: 20 }] },
  };
}

describe("verified screenshot highlights", () => {
  it.each([1, 2])("maps observed CSS rectangles into a %sx crop and joins only adjacent words", scale => {
    const result = buildVerifiedSnapshotHighlights(fixture(scale));
    expect(result?.rects).toEqual([{ x: 0.05, y: 0.1, width: 0.2, height: 0.04 },
      { x: 0.05, y: 0.16, width: 0.15, height: 0.04 }]);
    expect(result?.width).toBe(900 * scale);
  });

  it("allows outward pixel rounding without treating it as stretched geometry", () => {
    const value = fixture();
    value.captureValue.crop.css_clip = value.localizationValue.crop_rect = { x: 20.4, y: 300.3, width: 899.2, height: 499.4 };
    expect(buildVerifiedSnapshotHighlights(value)).not.toBeNull();
  });

  it("does not drift at deep positions on long pages with fractional crop edges", () => {
    const value = fixture();
    value.captureValue.full.height = 20_000;
    value.captureValue.crop.css_clip = value.localizationValue.crop_rect = { x: 20.4, y: 18_300.3, width: 899.2, height: 499.4 };
    value.captureValue.crop.clip = value.localizationValue.crop_rect_pixels = { x: 20, y: 18_300, width: 900, height: 500 };
    value.localizationValue.matched_rects = [{ x: 65, y: 18_350, width: 180, height: 20 }];
    const rect = buildVerifiedSnapshotHighlights(value)?.rects[0];
    expect(rect).toBeDefined();
    expect(rect!.y).toBeCloseTo(0.1, 2);
    expect(rect!.height).toBeCloseTo(0.04, 2);
  });

  it.each([
    ["semantic approval missing", (v: ReturnType<typeof fixture>) => { v.exactCropAllowed = false; }],
    ["unverified", (v: ReturnType<typeof fixture>) => { v.localizationValue.status = "unavailable_geometry"; }],
    ["semantic proof missing", (v: ReturnType<typeof fixture>) => { v.localizationValue.semantic_verified = false; }],
    ["partial match", (v: ReturnType<typeof fixture>) => { v.localizationValue.exact_overlap = false; }],
    ["PDF", (v: ReturnType<typeof fixture>) => { v.captureValue.full.content_type = "application/pdf"; }],
    ["different image", (v: ReturnType<typeof fixture>) => { v.captureValue.crop.source_image_sha256 = "b".repeat(64); }],
    ["different CSS crop", (v: ReturnType<typeof fixture>) => { v.captureValue.crop.css_clip = { x: 30, y: 300, width: 900, height: 500 }; }],
    ["wrong output width", (v: ReturnType<typeof fixture>) => { v.captureValue.crop.width = 901; }],
    ["nonuniform scale", (v: ReturnType<typeof fixture>) => { v.localizationValue.crop_rect = v.captureValue.crop.css_clip = { x: 20, y: 300, width: 450, height: 500 }; }],
    ["crop beyond image", (v: ReturnType<typeof fixture>) => { v.captureValue.full.height = 500; }],
    ["out-of-crop text", (v: ReturnType<typeof fixture>) => { v.localizationValue.matched_rects[0].x = 0; }],
    ["partial text", (v: ReturnType<typeof fixture>) => { v.localizationValue.matched_rects[0].width = 900; }],
    ["NaN", (v: ReturnType<typeof fixture>) => { v.localizationValue.matched_rects[0].y = NaN; }],
    ["missing rectangles", (v: ReturnType<typeof fixture>) => { v.localizationValue.matched_rects = []; }],
    ["too many rectangles", (v: ReturnType<typeof fixture>) => { v.localizationValue.matched_rects = Array(1_001).fill(v.localizationValue.matched_rects[0]); }],
  ])("withholds outlines for %s without guessing coordinates", (_label, mutate) => {
    const value = fixture();
    mutate(value);
    expect(buildVerifiedSnapshotHighlights(value)).toBeNull();
  });

  it("does not bridge columns or include unmeasured intervening lines", () => {
    const value = fixture();
    value.localizationValue.matched_rects.push({ x: 600, y: 350, width: 70, height: 20 });
    expect(buildVerifiedSnapshotHighlights(value)?.rects).toHaveLength(3);
  });

  it("only exposes overlays through the existing server exact-crop gate", async () => {
    const value = fixture();
    const signObjectKey = vi.fn(async (key: string) => `https://example.org/${key}`);
    const allowed = await buildEventVisualEvidenceSide({ ...value, signObjectKey });
    expect(allowed.highlights?.rects).toHaveLength(2);
    expect(allowed.exact_overlap).toBe(true);
    const held = await buildEventVisualEvidenceSide({ ...value, exactCropAllowed: false, signObjectKey });
    expect(held.highlights).toBeNull();
    expect(held.objects.crop).toBeUndefined();
    expect(held.objects.full).toBeDefined();
  });

  it("retains a trusted crop when optional overlay geometry is missing", async () => {
    const value = fixture();
    value.localizationValue.matched_rects = [];
    const result = await buildEventVisualEvidenceSide({ ...value, signObjectKey: async key => `https://example.org/${key}` });
    expect(result.highlights).toBeNull();
    expect(result.objects.crop).toBeDefined();
  });

  it("client validation fails closed for foreign/malformed overlays without changing image selection", () => {
    const value = fixture();
    const highlights = buildVerifiedSnapshotHighlights(value)!;
    const image = { key: highlights.image_key, width: highlights.width, height: highlights.height };
    expect(snapshotHighlightRects(highlights, image)).toHaveLength(2);
    expect(snapshotHighlightRects(highlights, { ...image, key: "other.jpg" })).toEqual([]);
    expect(snapshotHighlightRects(highlights, { ...image, width: 1800 })).toEqual([]);
    expect(snapshotHighlightRects({ ...highlights, rects: [{ x: 0.9, y: 0, width: 0.5, height: 0.1 }] }, image)).toEqual([]);
    expect(snapshotHighlightRects({ ...highlights, rects: [{ x: -0.1, y: 0, width: 0.1, height: 0.1 }] }, image)).toEqual([]);
    expect(snapshotHighlightRects({ ...highlights, rects: "not rectangles" }, image)).toEqual([]);
    expect(snapshotHighlightRects({ ...highlights, rects: [{ ...highlights.rects[0], right: NaN }] }, image)).toEqual([]);
    expect(snapshotHighlightRects({ ...highlights, width: Infinity }, { ...image, width: Infinity })).toEqual([]);
  });
});
