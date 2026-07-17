import { verifyVisualEventSemanticBindings } from "./visual-event-localization.mjs";

export const SNAPSHOT_LOCALIZATION_READY = new Set([
  "ready",
  "ready_via_identical_peer",
]);

export const VERIFIED_EVENT_CROP_STATUS = "verified";

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
    metric_scope: "source_pointer_layout_metadata_not_event_crop",
    source_count: rows.length,
    visual_versions_required: visualSides.length,
    searchable_layout_versions: exact,
    exact_localization_versions: exact,
    accounted_for_versions: accountedFor,
    repair_needed_versions: repairNeeded,
    latest_repair_needed: latestRepairNeeded,
    previous_repair_needed: previousRepairNeeded,
    historical_layout_unavailable: historicalUnavailable,
    r2_meta_errors: r2Errors,
    exact_coverage_percent: percent(exact, visualSides.length),
    searchable_layout_coverage_percent: percent(exact, visualSides.length),
    accounted_for_percent: percent(accountedFor, visualSides.length),
    automated_localization_complete: latestRepairNeeded === 0 && previousRepairNeeded === 0,
    all_versions_exactly_localizable: visualSides.length === exact,
    by_status: byStatus,
  };
}

export function classifyChangeEventVisualEvidence({
  event = {},
  evidence = null,
  artifactChecks = {},
} = {}) {
  const eventRequiredSides = requiredChangeEventLocalizationSides(event);
  const evidenceRequirement = evidenceLocalizationRequiredSides(evidence);
  const requiredSides = evidenceRequirement.authoritative
    ? evidenceRequirement.sides
    : eventRequiredSides;
  const requiredSideMismatch = evidenceRequirement.authoritative &&
    !sameStringSet(requiredSides, eventRequiredSides);
  if (!evidence?.change_event_id) {
    return {
      event_id: event?.id || null,
      status: "missing_evidence_binding",
      immutable_binding: false,
      required_side_source: "event_change_details",
      required_side_mismatch: false,
      event_required_sides: eventRequiredSides,
      required_sides: requiredSides,
      sides: Object.fromEntries(requiredSides.map((side) => [side, {
        status: "missing_evidence_binding",
        verified_crop: false,
        retained_full: false,
      }])),
    };
  }

  const localization = objectValue(evidence.localization);
  const localizationSides = objectValue(localization.sides);
  const semanticVerification = evidence.evidence_schema_version === "visual-event-evidence-v2"
    ? verifyVisualEventSemanticBindings({
        changeDetails: event.change_details,
        localization,
        previousCapture: evidence.previous_capture,
        currentCapture: evidence.current_capture,
      })
    : { valid: false, reason: "legacy_visual_event_evidence_v1", sides: {} };
  const sides = {};
  for (const side of ["previous", "current"]) {
    const required = requiredSides.includes(side);
    const capture = objectValue(evidence[`${side}_capture`]);
    const full = objectValue(capture.full);
    const crop = objectValue(capture.crop);
    const localized = objectValue(localizationSides[side]);
    const checks = objectValue(artifactChecks[side]);
    const retainedFull = validArtifactManifest(full) && checks.full === true;
    const cropArtifactVerified = validArtifactManifest(crop) && checks.crop === true;
    const exactOverlap = localized.exact_overlap === true && crop.exact_overlap === true;
    const semanticBindingVerified = objectValue(semanticVerification.sides)[side]?.valid === true;
    const verifiedCrop = required && localized.status === VERIFIED_EVENT_CROP_STATUS &&
      exactOverlap && cropArtifactVerified && semanticBindingVerified;

    let status = "not_required";
    if (required && verifiedCrop) status = VERIFIED_EVENT_CROP_STATUS;
    else if (required && retainedFull) status = "full_screenshot_fallback";
    else if (required) status = cleanText(localized.status) || "unavailable_image_missing";
    else if (retainedFull) status = "retained_full_not_localization_target";

    sides[side] = {
      status,
      required,
      verified_crop: verifiedCrop,
      retained_full: retainedFull,
      exact_overlap: exactOverlap,
      crop_artifact_verified: cropArtifactVerified,
      semantic_binding_verified: semanticBindingVerified,
      semantic_binding_reason: objectValue(semanticVerification.sides)[side]?.reason ||
        semanticVerification.reason || null,
      reason: cleanText(localized.reason) || null,
    };
  }

  const requiredResults = requiredSides.map((side) => sides[side]);
  const verifiedRequired = requiredResults.filter((side) => side.verified_crop).length;
  const retainedFullSides = Object.values(sides).filter((side) => side.retained_full).length;
  const evidenceStatus = cleanText(evidence.evidence_status);
  const allRequiredVerified = requiredResults.length && verifiedRequired === requiredResults.length;
  const effectiveStatus = allRequiredVerified
    ? VERIFIED_EVENT_CROP_STATUS
    : requiredResults.length && requiredResults.every((side) => side.retained_full)
      ? "full_screenshot_fallback"
      : evidenceStatus || (retainedFullSides ? "full_screenshot_fallback" : "unavailable_image_missing");
  return {
    event_id: event?.id || evidence.change_event_id,
    status: effectiveStatus,
    immutable_binding: true,
    candidate_bound: Boolean(cleanText(evidence.visual_review_candidate_id)),
    historical: Boolean(evidence.backfilled_at),
    evidence_schema_version: cleanText(evidence.evidence_schema_version) || null,
    semantic_binding_verified: semanticVerification.valid === true,
    semantic_binding_reason: semanticVerification.reason || null,
    legacy_crop_downgraded: evidence.evidence_schema_version === "visual-event-evidence-v1" &&
      evidenceStatus === VERIFIED_EVENT_CROP_STATUS,
    required_side_source: evidenceRequirement.authoritative
      ? "immutable_evidence"
      : "event_change_details",
    required_side_mismatch: requiredSideMismatch,
    event_required_sides: eventRequiredSides,
    required_sides: requiredSides,
    sides,
  };
}

export function summarizeChangeEventVisualEvidence(rows = []) {
  const eventCount = rows.length;
  const boundEvents = rows.filter((row) => row.immutable_binding).length;
  const candidateBoundEvents = rows.filter((row) => row.candidate_bound).length;
  const eventsWithExactLocalizationTarget = rows.filter(
    (row) => (row.required_sides || []).length > 0,
  );
  const eventsWithoutExactLocalizationTarget = rows.filter(
    (row) => (row.required_sides || []).length === 0,
  );
  const sideRows = rows.flatMap((row) =>
    (row.required_sides || []).map((side) => ({ event: row, side: row.sides?.[side] || {} })),
  );
  const verifiedCropSides = sideRows.filter(({ side }) => side.verified_crop).length;
  const fullFallbackSides = sideRows.filter(
    ({ side }) => !side.verified_crop && side.retained_full,
  ).length;
  const unavailableSides = sideRows.filter(
    ({ side }) => !side.verified_crop && !side.retained_full,
  ).length;
  const retainedFullSides = rows.flatMap((row) => Object.values(row.sides || {}))
    .filter((side) => side.retained_full).length;
  const byStatus = countBy(rows, (row) => row.status || "unknown");
  const requiredSideMismatches = rows.filter((row) => row.required_side_mismatch).length;
  const semanticallyVerifiedEvents = rows.filter((row) => row.semantic_binding_verified).length;
  const legacyCropDowngrades = rows.filter((row) => row.legacy_crop_downgraded).length;

  return {
    published_event_count: eventCount,
    immutable_evidence_event_count: boundEvents,
    candidate_bound_event_count: candidateBoundEvents,
    missing_evidence_event_count: eventCount - boundEvents,
    events_with_exact_localization_target: eventsWithExactLocalizationTarget.length,
    events_without_exact_localization_target: eventsWithoutExactLocalizationTarget.length,
    events_without_exact_localization_target_by_status: countBy(
      eventsWithoutExactLocalizationTarget,
      (row) => row.status || "unknown",
    ),
    required_localization_sides: sideRows.length,
    verified_event_crop_sides: verifiedCropSides,
    full_screenshot_fallback_sides: fullFallbackSides,
    unavailable_event_sides: unavailableSides,
    retained_full_capture_sides: retainedFullSides,
    immutable_evidence_coverage_percent: percent(boundEvents, eventCount),
    verified_event_crop_coverage_percent: sideRows.length
      ? percent(verifiedCropSides, sideRows.length)
      : null,
    all_required_event_crops_verified: sideRows.length
      ? sideRows.length === verifiedCropSides
      : null,
    exact_localization_target_status: sideRows.length
      ? "applicable"
      : "not_applicable_no_exact_wording",
    no_exact_localization_target_solution: eventsWithoutExactLocalizationTarget.length
      ? "Add exact before/after wording to the event change details, then backfill from its bound visual-review candidate when retained artifacts permit it."
      : null,
    required_side_mismatch_events: requiredSideMismatches,
    semantically_verified_event_count: semanticallyVerifiedEvents,
    legacy_v1_crop_fallback_event_count: legacyCropDowngrades,
    required_side_mismatch_solution: requiredSideMismatches
      ? "Keep the immutable evidence requirement authoritative for coverage, then repair the event change details so its exact directional wording agrees with the published evidence."
      : null,
    by_status: byStatus,
  };
}

export function requiredChangeEventLocalizationSides(event = {}) {
  const details = objectValue(event.change_details);
  const structured = objectValue(details.structured_diff);
  const facts = Array.isArray(details.changed_facts)
    ? details.changed_facts
    : Array.isArray(details.changed_award_facts)
      ? details.changed_award_facts
      : [];
  const hasPrevious = Boolean(
    hasTextValue(details.exact_before) ||
    hasTextValue(structured.removed_text) ||
    facts.some((fact) =>
      hasTextValue(objectValue(fact).removed_text)
    ),
  );
  const hasCurrent = Boolean(
    hasTextValue(details.exact_after) ||
    hasTextValue(structured.added_text) ||
    facts.some((fact) =>
      hasTextValue(objectValue(fact).added_text)
    ),
  );
  if (hasPrevious || hasCurrent) {
    return [hasPrevious ? "previous" : null, hasCurrent ? "current" : null].filter(Boolean);
  }
  return [];
}

function evidenceLocalizationRequiredSides(evidence) {
  if (!evidence?.change_event_id) return { authoritative: false, sides: [] };
  const localizationSides = objectValue(objectValue(evidence.localization).sides);
  const values = ["previous", "current"].map((side) => ({
    side,
    value: objectValue(localizationSides[side]),
  }));
  const hasExplicitRequirement = values.some(({ value }) => typeof value.required === "boolean");
  if (hasExplicitRequirement) {
    return {
      authoritative: true,
      sides: values.filter(({ value }) => value.required === true).map(({ side }) => side),
    };
  }
  const hasStatuses = values.some(({ value }) => cleanText(value.status));
  if (!hasStatuses) return { authoritative: false, sides: [] };
  return {
    authoritative: true,
    sides: values.filter(({ value }) => {
      const status = cleanText(value.status);
      return Boolean(status) && status !== "not_required" && status !== "not_applicable_pdf" &&
        !status.startsWith("unavailable_not_required_");
    }).map(({ side }) => side),
  };
}

function hasTextValue(value) {
  if (Array.isArray(value)) return value.some(hasTextValue);
  return Boolean(cleanText(value));
}

function sameStringSet(left, right) {
  const leftSet = new Set(left || []);
  const rightSet = new Set(right || []);
  return leftSet.size === rightSet.size && [...leftSet].every((value) => rightSet.has(value));
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

function validArtifactManifest(value) {
  const artifact = objectValue(value);
  return Boolean(
    cleanText(artifact.object_key) &&
    /^[a-f0-9]{64}$/i.test(cleanText(artifact.sha256)) &&
    positiveNumber(artifact.byte_length),
  );
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}
