const sourceGeneratedAtColumn = "page_metadata_generated_at";

export function awardFactScanWatermark(value = new Date()) {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error("Award fact scan watermark must be a valid timestamp.");
  }
  return parsed.toISOString();
}

export function applyAwardFactScanWatermark(query, scanWatermark) {
  return query.lte(sourceGeneratedAtColumn, awardFactScanWatermark(scanWatermark));
}

export function awardFactsAreCurrent(lastStructureScanAt, newestSourceGeneratedAt) {
  const awardScanAt = new Date(lastStructureScanAt || "").getTime();
  const sourceScanAt = new Date(newestSourceGeneratedAt || "").getTime();
  // Keep equality pending: a concurrent writer can share the watermark's
  // millisecond even though its row was committed after the scan began.
  return (
    Number.isFinite(awardScanAt) &&
    Number.isFinite(sourceScanAt) &&
    awardScanAt > sourceScanAt
  );
}
