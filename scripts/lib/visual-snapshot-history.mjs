export function rotatedVisualSnapshotHistory(existing, latestObjectKeys) {
  const priorLatest = objectValue(existing?.latest_object_keys);
  const hasPriorLatest = Object.keys(priorLatest).length > 0;
  return {
    latest_object_keys: objectValue(latestObjectKeys),
    previous_captured_at: hasPriorLatest ? existing?.latest_captured_at || null : null,
    previous_object_keys: hasPriorLatest ? priorLatest : {},
    previous_hashes: hasPriorLatest ? objectValue(existing?.latest_hashes) : {},
    previous_metadata: hasPriorLatest ? objectValue(existing?.latest_metadata) : {},
  };
}

export function refreshedLatestVisualSnapshotHistory(existing, { resetPrevious = false } = {}) {
  return {
    previous_captured_at: resetPrevious ? null : existing?.previous_captured_at || null,
    previous_object_keys: resetPrevious ? {} : objectValue(existing?.previous_object_keys),
    previous_hashes: resetPrevious ? {} : objectValue(existing?.previous_hashes),
    previous_metadata: resetPrevious ? {} : objectValue(existing?.previous_metadata),
  };
}

export function visualSnapshotKeysToDeleteAfterCas({
  pointerAdvanced,
  existing,
  next,
} = {}) {
  if (!pointerAdvanced) return [];
  const retained = new Set([
    ...Object.values(objectValue(next?.latest_object_keys)),
    ...Object.values(objectValue(next?.previous_object_keys)),
  ].filter(Boolean));
  return [...new Set([
    ...Object.values(objectValue(existing?.latest_object_keys)),
    ...Object.values(objectValue(existing?.previous_object_keys)),
  ].filter(Boolean))]
    .filter((key) => !retained.has(key) && isDeletableVisualSnapshotKey(key));
}

export function visualSnapshotUploadedKeysToDeleteAfterLostCas({
  uploaded,
  current,
} = {}) {
  const retained = new Set([
    ...Object.values(objectValue(current?.latest_object_keys)),
    ...Object.values(objectValue(current?.previous_object_keys)),
  ].filter(Boolean));
  return [...new Set(Object.values(objectValue(uploaded)).filter(Boolean))]
    .filter((key) => !retained.has(key) && isDeletableVisualSnapshotKey(key));
}

export function isPublishedVisualEvidenceKey(value) {
  return String(value || "").replace(/^\/+/, "").startsWith("visual-snapshots/published/");
}

export function isDeletableVisualSnapshotKey(value) {
  return Boolean(value) && !isPublishedVisualEvidenceKey(value)
    && !isLegacyFixedVisualSnapshotKey(value);
}

function isLegacyFixedVisualSnapshotKey(value) {
  // Fixed aliases may be the only retained originals. Cleanup protection does
  // not establish immutable origin, coverage, freshness or migration readiness.
  if (typeof value !== "string") return false;
  return /^visual-snapshots\/sources\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/(?:latest|previous)\/(?:page\.jpg|thumb\.jpg|document\.pdf|text\.txt|page\.html\.txt|layout\.json|meta\.json|expansion-state-(?:0[1-9]|[1-9][0-9])(?:\.jpg|-layout\.json))$/u.exec(value)?.[0] === value;
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
