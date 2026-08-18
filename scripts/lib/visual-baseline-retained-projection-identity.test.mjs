import { describe, expect, it } from "vitest";
import { baselineMatchesRetainedProjectionCapture } from "./visual-baseline-retained-projection-identity.mjs";

function fixture(overrides = {}) {
  const sourceId = "source-1";
  const baseline = {
    source: { id: sourceId },
    kind: "webpage",
    captured_at: "2026-08-14T18:00:00.000Z",
    text_hash: "text-a",
    image_hash: "image-a",
  };
  const capture = {
    source: { id: sourceId },
    kind: "webpage",
    captured_at: baseline.captured_at,
    text_hash: baseline.text_hash,
    image_hash: baseline.image_hash,
  };
  return {
    sourceId,
    baseline,
    capture,
    baselineMetaPath: "visual-snapshots/source-1/captures/a/meta.json",
    captureMetaPath: "visual-snapshots\\source-1\\captures\\a\\meta.json",
    ...overrides,
  };
}

describe("baseline retained-projection rewrite identity", () => {
  it("accepts an exact webpage identity including its primary image hash", () => {
    expect(baselineMatchesRetainedProjectionCapture(fixture())).toBe(true);
  });

  it("rejects same-path and same-time captures with different core hashes", () => {
    const textMismatch = fixture();
    textMismatch.capture = { ...textMismatch.capture, text_hash: "text-b" };
    expect(baselineMatchesRetainedProjectionCapture(textMismatch)).toBe(false);

    const imageMismatch = fixture();
    imageMismatch.capture = { ...imageMismatch.capture, image_hash: "image-b" };
    expect(baselineMatchesRetainedProjectionCapture(imageMismatch)).toBe(false);
  });

  it("requires exact source, kind, timestamp, and metadata path bindings", () => {
    for (const mutate of [
      (value) => { value.capture = { ...value.capture, source: { id: "source-2" } }; },
      (value) => { value.capture = { ...value.capture, kind: "pdf" }; },
      (value) => { value.capture = { ...value.capture, captured_at: "2026-08-14T18:00:01.000Z" }; },
      (value) => { value.captureMetaPath = "visual-snapshots/source-1/captures/b/meta.json"; },
    ]) {
      const value = fixture();
      mutate(value);
      expect(baselineMatchesRetainedProjectionCapture(value)).toBe(false);
    }
  });

  it("uses the PDF file hash as the primary immutable image/file identity", () => {
    const value = fixture();
    value.baseline = {
      ...value.baseline,
      kind: "pdf",
      file_hash: "pdf-a",
      image_hash: "legacy-image-value",
    };
    value.capture = {
      ...value.capture,
      kind: "pdf",
      file_hash: "pdf-b",
      image_hash: "legacy-image-value",
    };
    expect(baselineMatchesRetainedProjectionCapture(value)).toBe(false);
    value.capture.file_hash = "pdf-a";
    expect(baselineMatchesRetainedProjectionCapture(value)).toBe(true);
  });
});
