export type SnapshotHighlightRect = { x: number; y: number; width: number; height: number };

export type VerifiedSnapshotHighlights = {
  schema: "verified-crop-highlights-v1";
  image_key: string;
  width: number;
  height: number;
  rects: SnapshotHighlightRect[];
};

const maxRectangles = 1_000;
const epsilon = 0.000001;

/** Presentation only: the caller must first validate the event's semantic binding.
 * This never authorizes a crop, publishes an event, or creates missing geometry.
 */
export function buildVerifiedSnapshotHighlights({
  captureValue,
  localizationValue,
  exactCropAllowed,
}: {
  captureValue: unknown;
  localizationValue: unknown;
  exactCropAllowed: boolean;
}): VerifiedSnapshotHighlights | null {
  const capture = record(captureValue);
  const localization = record(localizationValue);
  const crop = record(capture.crop);
  const full = record(capture.full);
  if (!exactCropAllowed || localization.status !== "verified" || localization.semantic_verified !== true ||
    localization.exact_overlap !== true || crop.exact_overlap !== true ||
    !String(crop.content_type || "").startsWith("image/") || !String(full.content_type || "").startsWith("image/") ||
    typeof crop.object_key !== "string" || !crop.object_key ||
    typeof full.object_key !== "string" || !full.object_key ||
    typeof full.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(full.sha256) ||
    typeof full.byte_length !== "number" || !Number.isSafeInteger(full.byte_length) || full.byte_length <= 0 ||
    crop.source_image_object_key !== full.object_key || crop.source_image_sha256 !== full.sha256 ||
    crop.source_image_byte_length !== full.byte_length) return null;

  const css = rectangle(localization.crop_rect);
  const cssClip = rectangle(crop.css_clip);
  const pixels = rectangle(localization.crop_rect_pixels);
  const clip = rectangle(crop.clip);
  if (!css || !cssClip || !pixels || !clip || !sameRectangle(css, cssClip) || !sameRectangle(pixels, clip) ||
    crop.width !== clip.width || crop.height !== clip.height ||
    ![clip.x, clip.y, clip.width, clip.height, full.width, full.height].every(Number.isInteger) ||
    typeof full.width !== "number" || typeof full.height !== "number" ||
    clip.x + clip.width > full.width || clip.y + clip.height > full.height) return null;

  // Production uses floor(left/top), ceil(right/bottom). Intersect all four
  // observed edge constraints instead of guessing a device scale from rounded
  // width/height ratios (which drifts badly far down a long page).
  const scales = cropScaleBounds(css, clip);
  if (!scales) return null;

  const raw = localization.matched_rects;
  if (!Array.isArray(raw) || !raw.length || raw.length > maxRectangles) return null;
  const rectangles: SnapshotHighlightRect[] = [];
  for (const value of raw) {
    const rect = rectangle(value);
    // Partial overlap is sufficient for the legacy crop gate, but not for an
    // outline: no clipping, guessing, or silently dropping a missing rectangle.
    if (!rect || rect.x < css.x || rect.y < css.y ||
      rect.x + rect.width > css.x + css.width + epsilon ||
      rect.y + rect.height > css.y + css.height + epsilon) return null;
    rectangles.push(rect);
  }
  return {
    schema: "verified-crop-highlights-v1",
    image_key: crop.object_key,
    width: clip.width,
    height: clip.height,
    rects: mergeAdjacentWordRects(rectangles).map(rect => {
      // Enclose the measured text for every scale consistent with pixel
      // rounding. This is a conservative sub-pixel envelope, not a new match.
      const left = Math.max(0, rect.x * scales.minimum - clip.x);
      const top = Math.max(0, rect.y * scales.minimum - clip.y);
      const right = Math.min(clip.width, (rect.x + rect.width) * scales.maximum - clip.x);
      const bottom = Math.min(clip.height, (rect.y + rect.height) * scales.maximum - clip.y);
      return { x: left / clip.width, y: top / clip.height,
        width: (right - left) / clip.width, height: (bottom - top) / clip.height };
    }),
  };
}

/** Malformed or unrelated overlay data must not hide the retained image. */
export function snapshotHighlightRects(value: unknown, image: {
  key: string; width?: number | null; height?: number | null;
}): SnapshotHighlightRect[] {
  const highlights = record(value);
  if (highlights.schema !== "verified-crop-highlights-v1" || highlights.image_key !== image.key ||
    highlights.width !== image.width || highlights.height !== image.height ||
    typeof image.width !== "number" || !Number.isFinite(image.width) || image.width <= 0 ||
    typeof image.height !== "number" || !Number.isFinite(image.height) || image.height <= 0 ||
    !Array.isArray(highlights.rects) || !highlights.rects.length || highlights.rects.length > maxRectangles) return [];
  const result: SnapshotHighlightRect[] = [];
  for (const value of highlights.rects) {
    const rect = rectangle(value);
    if (!rect || rect.x + rect.width > 1 + epsilon || rect.y + rect.height > 1 + epsilon) return [];
    result.push(rect);
  }
  return result;
}

function mergeAdjacentWordRects(rectangles: SnapshotHighlightRect[]) {
  const lines: SnapshotHighlightRect[] = [];
  for (const rect of [...rectangles].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const line = lines.at(-1);
    const gap = line ? rect.x - (line.x + line.width) : Infinity;
    if (line && Math.abs(line.y - rect.y) <= 1 && Math.abs(line.height - rect.height) <= 1 &&
      gap >= -epsilon && gap <= Math.min(line.height, rect.height) * 0.75) {
      const bottom = Math.max(line.y + line.height, rect.y + rect.height);
      line.width = rect.x + rect.width - line.x;
      line.y = Math.min(line.y, rect.y);
      line.height = bottom - line.y;
    } else lines.push({ ...rect });
  }
  return lines;
}

function cropScaleBounds(css: SnapshotHighlightRect, pixels: SnapshotHighlightRect) {
  let minimum = 0;
  let maximum = Infinity;
  for (const [coordinate, pixel, round] of [
    [css.x, pixels.x, "floor"], [css.y, pixels.y, "floor"],
    [css.x + css.width, pixels.x + pixels.width, "ceil"],
    [css.y + css.height, pixels.y + pixels.height, "ceil"],
  ] as const) {
    if (!coordinate) { if (pixel !== 0) return null; continue; }
    minimum = Math.max(minimum, (round === "floor" ? pixel : pixel - 1) / coordinate);
    maximum = Math.min(maximum, (round === "floor" ? pixel + 1 : pixel) / coordinate);
  }
  return minimum > 0 && Number.isFinite(maximum) && minimum <= maximum
    ? { minimum, maximum } : null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function rectangle(value: unknown): SnapshotHighlightRect | null {
  const rect = record(value);
  const { x, y, width, height } = rect;
  if (![x, y, width, height].every(value => typeof value === "number" && Number.isFinite(value)) ||
    typeof x !== "number" || typeof y !== "number" || typeof width !== "number" || typeof height !== "number" ||
    x < 0 || y < 0 || width <= 0 || height <= 0) return null;
  if (rect.right !== undefined && (typeof rect.right !== "number" || !Number.isFinite(rect.right) || Math.abs(rect.right - (x + width)) > epsilon)) return null;
  if (rect.bottom !== undefined && (typeof rect.bottom !== "number" || !Number.isFinite(rect.bottom) || Math.abs(rect.bottom - (y + height)) > epsilon)) return null;
  return { x, y, width, height };
}

function sameRectangle(left: SnapshotHighlightRect, right: SnapshotHighlightRect) {
  return ["x", "y", "width", "height"].every(key => left[key as keyof SnapshotHighlightRect] === right[key as keyof SnapshotHighlightRect]);
}
