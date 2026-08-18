export function baselineMatchesRetainedProjectionCapture({
  sourceId,
  baseline,
  capture,
  baselineMetaPath,
  captureMetaPath,
} = {}) {
  const expectedSourceId = exactText(sourceId);
  const baselineKind = exactText(baseline?.kind);
  const captureKind = exactText(capture?.kind);
  const primaryHashField = baselineKind === "pdf" ? "file_hash" : "image_hash";

  return Boolean(
    expectedSourceId
    && exactText(baseline?.source?.id) === expectedSourceId
    && exactText(capture?.source?.id) === expectedSourceId
    && ["webpage", "pdf"].includes(baselineKind)
    && captureKind === baselineKind
    && exactRequiredMatch(baseline?.captured_at, capture?.captured_at)
    && exactRequiredMatch(baseline?.text_hash, capture?.text_hash)
    && exactRequiredMatch(baseline?.[primaryHashField], capture?.[primaryHashField])
    && exactRequiredMatch(normalizePath(baselineMetaPath), normalizePath(captureMetaPath))
  );
}

function exactRequiredMatch(left, right) {
  const normalizedLeft = exactText(left);
  return Boolean(normalizedLeft && normalizedLeft === exactText(right));
}

function normalizePath(value) {
  return exactText(value).replace(/\\/g, "/");
}

function exactText(value) {
  return typeof value === "string" ? value.trim() : "";
}
