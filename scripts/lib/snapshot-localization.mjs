export const SNAPSHOT_LOCALIZATION_READY = new Set([
  "ready",
  "ready_via_identical_peer",
]);

export function classifySnapshotLocalization({
  version,
  objectKeys,
  hashes,
  meta,
  metaError = null,
  recordMetadata = null,
  peerHashes = null,
  peerMeta = null,
} = {}) {
  const objects = objectValue(objectKeys);
  const hasVisual = Boolean(cleanText(objects.page) || cleanText(objects.thumb));
  const hasPdf = Boolean(cleanText(objects.pdf));

  if (!hasVisual) {
    if (!hasPdf && version === "latest") {
      return {
        status: "missing_snapshot",
        reason: "No current screenshot image is retained.",
        exact: false,
        accounted_for: false,
        repair_needed: true,
      };
    }
    return {
      status: hasPdf ? "not_applicable_pdf" : "not_applicable_no_image",
      reason: hasPdf ? "PDF snapshots do not use page-scroll localization." : "No screenshot image is retained.",
      exact: false,
      accounted_for: true,
      repair_needed: false,
    };
  }

  if (sameVisualHash(hashes, peerHashes) && hasLayoutMetadata(peerMeta)) {
    return {
      status: "ready_via_identical_peer",
      reason: "The identical retained screenshot version has searchable layout metadata.",
      exact: true,
      accounted_for: true,
      repair_needed: false,
    };
  }

  if (metaError) {
    if (version === "previous") {
      return {
        status: "historical_layout_unavailable",
        reason: `Historical snapshot metadata could not be read and cannot be safely reconstructed: ${cleanText(metaError)}`,
        exact: false,
        accounted_for: true,
        repair_needed: false,
      };
    }
    return {
      status: "r2_meta_error",
      reason: cleanText(metaError) || "The snapshot metadata could not be read from R2.",
      exact: false,
      accounted_for: false,
      repair_needed: true,
    };
  }

  if (hasLayoutMetadata(meta)) {
    return {
      status: "ready",
      reason: "The retained screenshot has searchable layout metadata.",
      exact: true,
      accounted_for: true,
      repair_needed: false,
    };
  }

  if (captureLayoutUnavailable(meta, recordMetadata)) {
    return {
      status: "capture_layout_unavailable",
      reason: "A localization recapture completed, but the page produced no searchable visual layout.",
      exact: false,
      accounted_for: true,
      repair_needed: false,
    };
  }

  if (version === "previous") {
    return {
      status: "historical_layout_unavailable",
      reason: "This historical screenshot predates location metadata and cannot be safely reconstructed from the current page.",
      exact: false,
      accounted_for: true,
      repair_needed: false,
    };
  }

  return {
    status: "repair_needed",
    reason: "The current screenshot needs a metadata-preserving localization recapture.",
    exact: false,
    accounted_for: false,
    repair_needed: true,
  };
}

export function summarizeSnapshotLocalization(rows = []) {
  const sides = rows.flatMap((row) => [row.latest, row.previous]).filter(Boolean);
  const byStatus = countBy(sides, (side) => side.status || "unknown");
  const visualSides = sides.filter((side) => !String(side.status || "").startsWith("not_applicable_"));
  const exact = visualSides.filter((side) => side.exact).length;
  const accountedFor = visualSides.filter((side) => side.accounted_for).length;
  const repairNeeded = visualSides.filter((side) => side.repair_needed).length;
  const latestRepairNeeded = rows.filter((row) => row.latest?.repair_needed).length;
  const previousRepairNeeded = rows.filter((row) => row.previous?.repair_needed).length;
  const historicalUnavailable = visualSides.filter(
    (side) => side.status === "historical_layout_unavailable",
  ).length;
  const r2Errors = visualSides.filter((side) => side.status === "r2_meta_error").length;

  return {
    source_count: rows.length,
    visual_versions_required: visualSides.length,
    exact_localization_versions: exact,
    accounted_for_versions: accountedFor,
    repair_needed_versions: repairNeeded,
    latest_repair_needed: latestRepairNeeded,
    previous_repair_needed: previousRepairNeeded,
    historical_layout_unavailable: historicalUnavailable,
    r2_meta_errors: r2Errors,
    exact_coverage_percent: percent(exact, visualSides.length),
    accounted_for_percent: percent(accountedFor, visualSides.length),
    automated_localization_complete: latestRepairNeeded === 0 && previousRepairNeeded === 0,
    all_versions_exactly_localizable: visualSides.length === exact,
    by_status: byStatus,
  };
}

export function hasLayoutMetadata(value) {
  const meta = objectValue(value);
  const pageSettle = objectValue(meta.page_settle);
  const after = objectValue(pageSettle.after);
  const dimensions = objectValue(meta.dimensions);
  const layoutSample = cleanText(pageSettle.after_layout_sample);
  const scrollHeight = positiveNumber(dimensions.scroll_height) || positiveNumber(after.scroll_height);
  return Boolean(layoutSample && scrollHeight);
}

export function sameVisualHash(left, right) {
  const leftHash = cleanText(objectValue(left).image_hash);
  const rightHash = cleanText(objectValue(right).image_hash);
  return Boolean(leftHash && rightHash && leftHash === rightHash);
}

function captureLayoutUnavailable(meta, recordMetadata) {
  for (const value of [meta, recordMetadata]) {
    const metadata = objectValue(value);
    const localization = objectValue(metadata.localization);
    if (cleanText(localization.status) === "capture_layout_unavailable") return true;
    if (
      cleanText(metadata.capture_profile) === "localization-repair" &&
      ["metadata_missing", "capture_layout_unavailable"].includes(cleanText(localization.status))
    ) {
      return true;
    }
  }
  return false;
}

function countBy(values, picker) {
  const counts = {};
  for (const value of values) {
    const key = cleanText(picker(value)) || "unknown";
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(counts).sort((left, right) => Number(right[1]) - Number(left[1])),
  );
}

function percent(numerator, denominator) {
  if (!denominator) return 100;
  return Math.round((numerator / denominator) * 10_000) / 100;
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}
