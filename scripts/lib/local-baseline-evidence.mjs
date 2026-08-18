import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import {
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import {
  atomicWriteJson,
  withVisualBaselineLockAsync,
} from "./visual-baseline-lock.mjs";
import { retainedCaptureArtifactProjectionSchema } from "./r2-capture-artifact-bindings.mjs";
import {
  canonicalExpansionStateCaptureCoverage,
  conservativeExpansionStateCaptureCoverage,
  hasExpansionStateCaptureCoverageClaim,
  legacyExpansionStateCaptureCoverageFromMetadata,
  sameExpansionStateCaptureCoverage,
} from "./expansion-state-descriptor-canonicalization.mjs";
import { verifyVisualTextGeometryBinding } from "./visual-event-localization.mjs";

export const LOCAL_BASELINE_EVIDENCE_REPAIR_REASON =
  "repaired_dangling_baseline_pointer";

const sourceIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab0-9a-f][0-9a-f]{3}-[0-9a-f]{12}$/i;
const capturePathFields = [
  "dir",
  "page",
  "thumb",
  "pdf",
  "text",
  "expansion_text",
  "sections_text",
  "sections_json",
  "layout",
  "meta",
];
const requiredEvidenceFields = {
  webpage: ["page", "thumb", "text", "meta"],
  pdf: ["pdf", "text", "meta"],
};
const metadataPathFields = new Set(capturePathFields.filter((field) => field !== "dir"));

export function parseSourceIdsFileContent(content) {
  const text = String(content ?? "").trim();
  if (!text) return [];

  if (text.startsWith("[") || text.startsWith("{")) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new TypeError(`Source IDs JSON is invalid: ${errorMessage(error)}`);
    }
    const values = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.source_ids)
        ? parsed.source_ids
        : null;
    if (!values) {
      throw new TypeError("Source IDs JSON must be an array or an object with a source_ids array.");
    }
    if (values.some((value) => typeof value !== "string")) {
      throw new TypeError("Every source ID in JSON must be a string.");
    }
    return uniqueStrings(values);
  }

  return uniqueStrings(
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#")),
  );
}

export async function repairLocalBaselineEvidence({
  archiveRoot,
  sourceId,
  apply = false,
  now = new Date().toISOString(),
} = {}) {
  const root = requiredArchiveRoot(archiveRoot);
  const id = String(sourceId || "").trim();
  if (!sourceIdPattern.test(id)) {
    return refusal(id, "unsafe_or_invalid_source_id");
  }

  return withVisualBaselineLockAsync({
    archiveRoot: root,
    sourceId: id,
    operation: async () => {
      const inspection = inspectLocalBaselineEvidence({
        archiveRoot: root,
        sourceId: id,
        now,
      });
      if (inspection.decision !== "repair") return inspection;
      if (!apply) {
        return {
          ...inspection,
          status: "repairable",
          evidence_complete: false,
        };
      }

      atomicWriteJson(inspection.baseline_path, inspection.repaired_baseline);
      return {
        ...inspection,
        status: "repaired",
        evidence_complete: true,
      };
    },
  });
}

export function inspectLocalBaselineEvidence({
  archiveRoot,
  sourceId,
  now = new Date().toISOString(),
} = {}) {
  const root = requiredArchiveRoot(archiveRoot);
  const id = String(sourceId || "").trim();
  if (!sourceIdPattern.test(id)) {
    return refusal(id, "unsafe_or_invalid_source_id");
  }

  const sourceDir = join(root, "sources", id);
  const baselinePath = join(sourceDir, "baseline.json");
  if (!existsSync(baselinePath)) {
    return refusal(id, "baseline_missing", { baseline_path: baselinePath });
  }

  const currentBaselineRead = readJson(baselinePath);
  if (!currentBaselineRead.ok) {
    return refusal(id, "baseline_json_invalid", {
      baseline_path: baselinePath,
      detail: currentBaselineRead.error,
    });
  }
  const currentBaseline = objectValue(currentBaselineRead.value);
  if (currentBaseline.source?.id !== id) {
    return refusal(id, "current_source_id_mismatch", { baseline_path: baselinePath });
  }

  const currentKind = captureKind(currentBaseline.kind, currentBaseline.capture);
  if (!currentKind.ok) {
    return refusal(id, `current_${currentKind.reason}`, { baseline_path: baselinePath });
  }
  const currentCapture = validateCaptureDescriptor({
    archiveRoot: root,
    sourceDir,
    capture: currentBaseline.capture,
    kind: currentKind.kind,
    label: "current",
    requireCompleteEvidence: false,
  });
  if (!currentCapture.ok) {
    return refusal(id, currentCapture.reason, {
      baseline_path: baselinePath,
      detail: currentCapture.detail,
    });
  }
  if (currentCapture.resolved.meta && isRegularFile(currentCapture.resolved.meta)) {
    const currentMetaRead = readJson(currentCapture.resolved.meta);
    if (!currentMetaRead.ok) {
      return refusal(id, "current_meta_json_invalid", {
        baseline_path: baselinePath,
        detail: currentMetaRead.error,
      });
    }
    const currentMetaValidation = validateEvidenceMeta({
      archiveRoot: root,
      sourceDir,
      sourceId: id,
      kind: currentKind.kind,
      capture: currentCapture,
      meta: objectValue(currentMetaRead.value),
      label: "current",
      expectedBaseline: currentBaseline,
    });
    if (!currentMetaValidation.ok) {
      return refusal(id, currentMetaValidation.reason, {
        baseline_path: baselinePath,
        detail: currentMetaValidation.detail,
      });
    }
  }
  if (!currentCapture.missing_required.length) {
    return refusal(id, "current_evidence_valid", {
      baseline_path: baselinePath,
      evidence_complete: true,
    });
  }

  const previousDescriptor = currentBaseline.summary_metadata?.previous_baseline_capture;
  if (!objectHasKeys(previousDescriptor)) {
    return refusal(id, "previous_baseline_capture_missing", {
      baseline_path: baselinePath,
      missing_current_evidence: currentCapture.missing_required,
    });
  }
  if (sameCaptureDirectory(currentBaseline.capture, previousDescriptor)) {
    return refusal(id, "previous_capture_ambiguous_same_as_current", {
      baseline_path: baselinePath,
    });
  }

  const previousKind = captureKind(currentKind.kind, previousDescriptor);
  if (!previousKind.ok || previousKind.kind !== currentKind.kind) {
    return refusal(id, "previous_capture_kind_ambiguous", { baseline_path: baselinePath });
  }
  const previousCapture = validateCaptureDescriptor({
    archiveRoot: root,
    sourceDir,
    capture: previousDescriptor,
    kind: previousKind.kind,
    label: "previous",
    requireCompleteEvidence: true,
  });
  if (!previousCapture.ok) {
    return refusal(id, previousCapture.reason, {
      baseline_path: baselinePath,
      detail: previousCapture.detail,
      missing_previous_evidence: previousCapture.missing_required || [],
    });
  }
  if (sameResolvedPath(currentCapture.resolved.dir, previousCapture.resolved.dir)) {
    return refusal(id, "previous_capture_ambiguous_same_as_current", {
      baseline_path: baselinePath,
    });
  }

  const previousMetaRead = readJson(previousCapture.resolved.meta);
  if (!previousMetaRead.ok) {
    return refusal(id, "previous_meta_json_invalid", {
      baseline_path: baselinePath,
      detail: previousMetaRead.error,
    });
  }
  const previousMeta = objectValue(previousMetaRead.value);
  const metaValidation = validateEvidenceMeta({
    archiveRoot: root,
    sourceDir,
    sourceId: id,
    kind: previousKind.kind,
    capture: previousCapture,
    meta: previousMeta,
    label: "previous",
    expectedBaseline: currentBaseline.summary_metadata?.previous_baseline,
  });
  if (!metaValidation.ok) {
    return refusal(id, metaValidation.reason, {
      baseline_path: baselinePath,
      detail: metaValidation.detail,
    });
  }

  const repairedBaseline = buildRepairedBaseline({
    currentBaseline,
    danglingCapture: currentCapture.stored,
    previousCapture: previousCapture.stored,
    previousMeta,
    previousExpansionStateCaptureCoverage:
      metaValidation.expansion_state_capture_coverage,
    kind: previousKind.kind,
    now,
  });

  return {
    source_id: id,
    status: "repairable",
    decision: "repair",
    reason: LOCAL_BASELINE_EVIDENCE_REPAIR_REASON,
    evidence_complete: false,
    baseline_path: baselinePath,
    missing_current_evidence: currentCapture.missing_required,
    restored_capture: previousCapture.stored.dir,
    repaired_baseline: repairedBaseline,
  };
}

export function buildRepairedBaseline({
  currentBaseline,
  danglingCapture,
  previousCapture,
  previousMeta,
  previousExpansionStateCaptureCoverage = null,
  kind,
  now,
}) {
  const currentSummary = objectValue(currentBaseline.summary_metadata);
  const webCapture = kind === "webpage";
  return {
    version: currentBaseline.version || 1,
    kind,
    capture_behavior_version: webCapture
      ? nullable(previousMeta.capture_behavior_version)
      : null,
    capture_behavior_name: webCapture
      ? nullable(previousMeta.capture_behavior_name)
      : null,
    capture_profile: nullable(previousMeta.capture_profile),
    section_extraction_profile: nullable(previousMeta.section_extraction_profile),
    source: currentBaseline.source,
    captured_at: previousMeta.captured_at,
    final_url: nullable(previousMeta.final_url),
    page_title: nullable(previousMeta.page_title),
    text_hash: nullable(previousMeta.text_hash),
    body_text_hash: nullable(previousMeta.body_text_hash),
    main_content_hash: nullable(previousMeta.main_content_hash),
    nav_header_footer_hash: nullable(previousMeta.nav_header_footer_hash),
    expansion_hash: nullable(previousMeta.expansion_hash),
    expandable_sections_hash: nullable(previousMeta.expandable_sections_hash),
    image_hash: nullable(previousMeta.image_hash),
    layout_hash: previousCapture.layout ? nullable(previousMeta.layout_hash) : null,
    text_geometry: previousCapture.layout
      ? objectOrNull(previousMeta.text_geometry)
      : null,
    file_hash: nullable(previousMeta.file_hash),
    file_bytes: nullable(previousMeta.file_bytes),
    text_length: nonNegativeNumberOrNull(previousMeta.text_length),
    body_text_length: nonNegativeNumberOrNull(previousMeta.body_text_length),
    main_content_text_length: nonNegativeNumberOrNull(previousMeta.main_content_text_length),
    nav_header_footer_text_length: nonNegativeNumberOrNull(previousMeta.nav_header_footer_text_length),
    expansion_text_length: nonNegativeNumberOrNull(previousMeta.expansion_text_length),
    section_text_length: nonNegativeNumberOrNull(previousMeta.section_text_length),
    expandable_sections: Array.isArray(previousMeta.expandable_sections)
      ? previousMeta.expandable_sections
      : [],
    dimensions: objectOrNull(previousMeta.dimensions),
    hidden_noise_counts: objectOrNull(previousMeta.hidden_noise_counts),
    capture: previousCapture,
    summary_metadata: {
      reason: LOCAL_BASELINE_EVIDENCE_REPAIR_REASON,
      updated_at: now,
      ai_provider: nullable(currentSummary.ai_provider),
      ai_model: nullable(currentSummary.ai_model),
      previous_baseline: null,
      previous_baseline_capture: null,
      baseline_facts: objectOrNull(previousMeta.baseline_facts),
      baseline_facts_metadata: objectOrNull(previousMeta.baseline_facts_metadata),
      monitoring_disposition: objectOrNull(previousMeta.monitoring_disposition),
      stage1_baseline_activation: objectOrNull(previousMeta.stage1_baseline_activation),
      expansion_state_capture_coverage:
        kind === "webpage"
          ? previousExpansionStateCaptureCoverage
            ?? legacyExpansionStateCaptureCoverageFromMetadata(previousMeta, {
                retainedStateCount: Array.isArray(previousCapture.expansion_states)
                  ? previousCapture.expansion_states.length
                  : 0,
              })
          : null,
      retained_artifact_projection:
        objectOrNull(previousMeta.retained_artifact_projection)
        ?? null,
      local_evidence_repair: {
        reason: LOCAL_BASELINE_EVIDENCE_REPAIR_REASON,
        repaired_at: now,
        dangling_captured_at: currentBaseline.captured_at || null,
        dangling_capture: danglingCapture || null,
        restored_captured_at: previousMeta.captured_at,
        restored_capture: previousCapture,
        prior_summary_reason: currentSummary.reason || null,
      },
    },
  };
}

function validateCaptureDescriptor({
  archiveRoot,
  sourceDir,
  capture,
  kind,
  label,
  requireCompleteEvidence,
}) {
  const value = objectValue(capture);
  if (!objectHasKeys(value)) return invalid(`${label}_capture_missing`);

  const resolved = {};
  const stored = {};
  for (const field of capturePathFields) {
    const fieldValue = value[field];
    if (fieldValue === null || fieldValue === undefined || fieldValue === "") {
      stored[field] = null;
      resolved[field] = null;
      continue;
    }
    if (typeof fieldValue !== "string") {
      return invalid(`${label}_capture_path_invalid`, `${field} is not a string`);
    }
    const validated = validateStoredPath({
      archiveRoot,
      sourceDir,
      storedPath: fieldValue,
    });
    if (!validated.ok) {
      return invalid(`${label}_${validated.reason}`, field);
    }
    stored[field] = validated.stored;
    resolved[field] = validated.resolved;
  }

  if (!resolved.dir) return invalid(`${label}_capture_dir_missing`);
  if (!pathIsWithin(sourceDir, resolved.dir)) {
    return invalid(`${label}_capture_dir_outside_source`);
  }
  const realCaptureContainment = validateRealCaptureContainment({
    archiveRoot,
    sourceDir,
    captureDir: resolved.dir,
    resolved,
    label,
  });
  if (!realCaptureContainment.ok) return realCaptureContainment;
  for (const field of capturePathFields.filter((entry) => entry !== "dir")) {
    if (resolved[field] && !pathIsWithin(resolved.dir, resolved[field])) {
      return invalid(`${label}_capture_file_outside_capture_dir`, field);
    }
  }

  const conflictingField = kind === "pdf" ? ["page", "thumb"] : ["pdf"];
  if (conflictingField.some((field) => resolved[field])) {
    return invalid(`${label}_capture_kind_ambiguous`);
  }

  const missingRequired = requiredEvidenceFields[kind].filter(
    (field) => !resolved[field] || !isRegularFile(resolved[field]),
  );
  if (kind === "webpage" && value.layout && (!resolved.layout || !isRegularFile(resolved.layout))) {
    missingRequired.push("layout");
  }

  const expansionStatesDeclared = value.expansion_states != null;
  const expansionStates = expansionStatesDeclared ? value.expansion_states : [];
  if (!Array.isArray(expansionStates)) {
    return invalid(`${label}_capture_expansion_states_invalid`);
  }
  if (expansionStatesDeclared) {
    stored.expansion_states = [];
    resolved.expansion_states = [];
  }
  for (const [index, stateValue] of expansionStates.entries()) {
    const state = objectValue(stateValue);
    const suffix = String(index + 1).padStart(2, "0");
    if (state.state_id !== `expansion-state-${suffix}` || !state.page || !state.layout) {
      return invalid(`${label}_capture_expansion_state_invalid`, suffix);
    }
    const storedState = { ...state };
    const resolvedState = { ...state };
    for (const field of ["page", "layout"]) {
      const validated = validateStoredPath({
        archiveRoot,
        sourceDir,
        storedPath: state[field],
      });
      if (!validated.ok) {
        return invalid(`${label}_${validated.reason}`, `expansion_state_${suffix}_${field}`);
      }
      if (!pathIsWithin(resolved.dir, validated.resolved)) {
        return invalid(`${label}_capture_file_outside_capture_dir`, `expansion_state_${suffix}_${field}`);
      }
      const containment = realPathContainment(resolved.dir, validated.resolved);
      if (!containment.ok) {
        return invalid(
          `${label}_capture_file_symlink_outside_capture_dir`,
          `expansion_state_${suffix}_${field}`,
        );
      }
      storedState[field] = validated.stored;
      resolvedState[field] = validated.resolved;
      if (!isRegularFile(validated.resolved)) {
        missingRequired.push(`expansion_state_${suffix}_${field}`);
      }
    }
    stored.expansion_states.push(storedState);
    resolved.expansion_states.push(resolvedState);
  }
  if (requireCompleteEvidence && missingRequired.length) {
    return {
      ...invalid(`${label}_evidence_incomplete`),
      missing_required: missingRequired,
    };
  }

  if (requireCompleteEvidence && !isDirectory(resolved.dir)) {
    return invalid(`${label}_capture_dir_missing`);
  }

  return {
    ok: true,
    kind,
    declared: value,
    resolved,
    stored,
    missing_required: missingRequired,
  };
}

function validateEvidenceMeta({
  archiveRoot,
  sourceDir,
  sourceId,
  kind,
  capture,
  meta,
  label,
  expectedBaseline = null,
}) {
  let expansionStateCaptureCoverage = null;
  if (meta.source?.id !== sourceId) {
    return invalid(`${label}_meta_source_id_mismatch`);
  }
  if (meta.kind !== kind) {
    return invalid(`${label}_meta_kind_mismatch`);
  }
  if (!meta.captured_at || !Number.isFinite(Date.parse(meta.captured_at))) {
    return invalid(`${label}_meta_captured_at_invalid`);
  }
  if (!meta.text_hash) return invalid(`${label}_meta_text_hash_missing`);
  if (kind === "pdf" && !meta.file_hash) {
    return invalid(`${label}_meta_file_hash_missing`);
  }
  if (kind === "webpage" && !meta.image_hash) {
    return invalid(`${label}_meta_image_hash_missing`);
  }

  const expectedIdentity = validateExpectedBaselineIdentity({
    expectedBaseline,
    capture,
    meta,
    label,
  });
  if (!expectedIdentity.ok) return expectedIdentity;

  if (meta.files != null && !isObject(meta.files)) {
    return invalid(`${label}_meta_files_invalid`);
  }
  const metaFiles = objectValue(meta.files);
  for (const { field, value: pathValue } of metadataPaths(metaFiles)) {
    const validated = validateStoredPath({
      archiveRoot,
      sourceDir,
      storedPath: pathValue,
    });
    if (!validated.ok) return invalid(`${label}_meta_${validated.reason}`, field);
    if (!pathIsWithin(capture.resolved.dir, validated.resolved)) {
      return invalid(`${label}_meta_file_outside_capture_dir`, field);
    }
    const realContainment = realPathContainment(
      capture.resolved.dir,
      validated.resolved,
    );
    if (!realContainment.ok) {
      return invalid(`${label}_meta_file_symlink_outside_capture_dir`, field);
    }
  }
  for (const field of requiredEvidenceFields[kind]) {
    if (!metaFiles[field]) continue;
    if (typeof metaFiles[field] !== "string") {
      return invalid(`${label}_meta_file_mismatch`, field);
    }
    const validated = validateStoredPath({
      archiveRoot,
      sourceDir,
      storedPath: metaFiles[field],
    });
    if (!validated.ok || validated.resolved !== capture.resolved[field]) {
      return invalid(`${label}_meta_file_mismatch`, field);
    }
  }

  if (!capture.missing_required.length) {
    const coreBytesValidation = validateCoreCaptureBytes({
      capture,
      kind,
      meta,
      metaFiles,
      label,
    });
    if (!coreBytesValidation.ok) return coreBytesValidation;
  }

  if (kind === "webpage") {
    const captureLayout = capture.stored.layout || null;
    const metadataLayout = typeof metaFiles.layout === "string" ? metaFiles.layout : null;
    if (captureLayout !== metadataLayout) {
      return invalid(`${label}_meta_file_mismatch`, "layout");
    }
    const captureStates = Array.isArray(capture.stored.expansion_states)
      ? capture.stored.expansion_states
      : [];
    const resolvedCaptureStates = Array.isArray(capture.resolved.expansion_states)
      ? capture.resolved.expansion_states
      : [];
    const metadataFileStates = Array.isArray(metaFiles.expansion_states)
      ? metaFiles.expansion_states
      : [];
    const metadataStates = Array.isArray(meta.expansion_state_screenshots)
      ? meta.expansion_state_screenshots
      : [];
    if (
      !Number.isSafeInteger(meta.expansion_state_count)
      || meta.expansion_state_count < 0
    ) {
      return invalid(`${label}_meta_expansion_state_count_invalid`);
    }
    const declaredCount = meta.expansion_state_count;
    if (
      captureStates.length !== metadataFileStates.length
      || captureStates.length !== metadataStates.length
      || captureStates.length !== declaredCount
    ) {
      return invalid(`${label}_meta_expansion_state_count_mismatch`);
    }
    const coverageClaimed = hasExpansionStateCaptureCoverageClaim(meta);
    const coverage = legacyExpansionStateCaptureCoverageFromMetadata(meta, {
      retainedStateCount: declaredCount,
    });
    if (!coverage && coverageClaimed) {
      return invalid(`${label}_meta_expansion_state_coverage_invalid`);
    }
    expansionStateCaptureCoverage = coverage
      ?? conservativeExpansionStateCaptureCoverage({
        retainedStateCount: declaredCount,
      });
    const expectedSummary = expectedBaseline?.summary_metadata;
    const expectedCoverageClaimed = Boolean(
      expectedSummary
      && typeof expectedSummary === "object"
      && Object.hasOwn(expectedSummary, "expansion_state_capture_coverage"),
    );
    const expectedCoverageValue = expectedSummary?.expansion_state_capture_coverage;
    if (expectedCoverageClaimed) {
      const expectedCoverage = canonicalExpansionStateCaptureCoverage(
        expectedCoverageValue,
        { expectedRetainedStateCount: declaredCount },
      );
      if (
        !expectedCoverage
        || !sameExpansionStateCaptureCoverage(
          expectedCoverage,
          expansionStateCaptureCoverage,
          {
          expectedRetainedStateCount: declaredCount,
          },
        )
      ) {
        return invalid(`${label}_meta_expansion_state_coverage_mismatch`);
      }
    }
    for (const [index, captureState] of captureStates.entries()) {
      const resolvedCaptureState = objectValue(resolvedCaptureStates[index]);
      const fileState = objectValue(metadataFileStates[index]);
      const metadataState = objectValue(metadataStates[index]);
      const suffix = String(index + 1).padStart(2, "0");
      if (
        fileState.state_id !== captureState.state_id
        || metadataState.state_id !== captureState.state_id
        || fileState.page !== captureState.page
        || metadataState.page !== captureState.page
        || fileState.layout !== captureState.layout
        || metadataState.layout !== captureState.layout
      ) {
        return invalid(`${label}_meta_expansion_state_mismatch`, String(index + 1));
      }
      const imageHash = lowerSha256OrNull(captureState.image_hash);
      const layoutHash = lowerSha256OrNull(captureState.layout_hash);
      const metadataImageHash = lowerSha256OrNull(metadataState.image_hash);
      const metadataLayoutHash = lowerSha256OrNull(metadataState.layout_hash);
      const metadataTextHash = lowerSha256OrNull(metadataState.text_hash);
      if (
        !imageHash
        || !layoutHash
        || metadataImageHash !== imageHash
        || metadataLayoutHash !== layoutHash
        || !metadataTextHash
        || !Number.isSafeInteger(metadataState.text_length)
        || metadataState.text_length < 0
      ) {
        return invalid(`${label}_meta_expansion_state_hash_mismatch`, suffix);
      }
      if (
        !validInstant(captureState.captured_at)
        || !validInstant(metadataState.captured_at)
        || captureState.captured_at !== metadataState.captured_at
      ) {
        return invalid(`${label}_meta_expansion_state_captured_at_mismatch`, suffix);
      }

      let pageBytes;
      try {
        pageBytes = readFileSync(resolvedCaptureState.page);
      } catch (error) {
        return invalid(`${label}_meta_expansion_page_read_failed`, errorMessage(error));
      }
      if (sha256Bytes(pageBytes) !== imageHash) {
        return invalid(`${label}_meta_expansion_page_hash_mismatch`, suffix);
      }
      if (
        !Number.isSafeInteger(metadataState.page_bytes)
        || metadataState.page_bytes !== pageBytes.length
      ) {
        return invalid(`${label}_meta_expansion_page_bytes_mismatch`, suffix);
      }

      const layoutRead = readJson(resolvedCaptureState.layout);
      if (!layoutRead.ok) {
        return invalid(`${label}_meta_expansion_layout_json_invalid`, suffix);
      }
      const layout = objectValue(layoutRead.value);
      const layoutBinding = verifyVisualTextGeometryBinding(layout, imageHash);
      if (!layoutBinding.valid) {
        return invalid(
          `${label}_meta_expansion_layout_binding_invalid`,
          `${suffix}:${layoutBinding.reason}`,
        );
      }
      if (
        layout.state_id !== captureState.state_id
        || layout.geometry_hash !== layoutHash
        || layout.screenshot?.image_hash !== imageHash
        || layout.captured_at !== captureState.captured_at
        || metadataState.text_geometry?.geometry_hash !== layoutHash
        || metadataState.text_geometry?.screenshot?.image_hash !== imageHash
        || metadataState.text_geometry?.file !== captureState.layout
        || metadataState.text_geometry?.screenshot?.image_ref !== captureState.page
      ) {
        return invalid(`${label}_meta_expansion_geometry_identity_mismatch`, suffix);
      }
    }

    const layoutClaimed = Boolean(
      meta.layout_hash
      || meta.text_geometry?.geometry_hash
      || meta.text_geometry?.file
      || meta.text_geometry?.screenshot?.image_hash
      || meta.localization?.geometry_hash
      || meta.localization?.bound_image_hash
      || meta.localization?.geometry_ready === true
    );
    if (!captureLayout && layoutClaimed) {
      return invalid(`${label}_meta_layout_claim_without_artifact`);
    }
    if (captureLayout && !layoutClaimed) {
      return invalid(`${label}_meta_layout_binding_missing`);
    }
    if (captureLayout && !capture.missing_required.length) {
      const mainLayoutValidation = validateMainWebLayoutEvidence({
        capture,
        meta,
        metaFiles,
        label,
      });
      if (!mainLayoutValidation.ok) return mainLayoutValidation;
    }

  }

  const projectionValidation = validateRetainedArtifactProjection({
    capture,
    kind,
    meta,
    label,
  });
  if (!projectionValidation.ok) return projectionValidation;

  return {
    ok: true,
    expansion_state_capture_coverage: expansionStateCaptureCoverage,
  };
}

function validateRetainedArtifactProjection({ capture, kind, meta, label }) {
  if (meta.retained_artifact_projection == null) return { ok: true };

  const projection = objectValue(meta.retained_artifact_projection);
  const authority = objectValue(projection.authoritative);
  const layoutRetained = kind === "webpage" && Boolean(capture.stored.layout);
  const expectedLayoutHash = layoutRetained
    ? lowerSha256OrNull(meta.layout_hash)
    : null;
  const expectedExpansionStateCount = kind === "webpage"
    ? (Array.isArray(capture.stored.expansion_states)
        ? capture.stored.expansion_states.length
        : 0)
    : 0;
  const expectedLocalizationStatus = kind === "pdf"
    ? "not_applicable_pdf"
    : layoutRetained
      ? "exact_geometry_available"
      : "evidence_only_geometry_unavailable";

  if (
    !objectHasKeys(projection)
    || projection.schema !== retainedCaptureArtifactProjectionSchema
    || projection.kind !== kind
    || projection.localization_status !== expectedLocalizationStatus
    || authority.layout_retained !== layoutRetained
    || (layoutRetained
      ? authority.layout_hash !== expectedLayoutHash
      : authority.layout_hash !== null)
    || !Number.isSafeInteger(authority.expansion_state_count)
    || authority.expansion_state_count < 0
    || authority.expansion_state_count !== expectedExpansionStateCount
  ) {
    return invalid(`${label}_meta_retained_projection_mismatch`);
  }

  return { ok: true };
}

function validateExpectedBaselineIdentity({ expectedBaseline, capture, meta, label }) {
  const expected = objectValue(expectedBaseline);
  if (!objectHasKeys(expected)) return { ok: true };

  if (expected.source?.id && expected.source.id !== meta.source?.id) {
    return invalid(`${label}_meta_generation_source_mismatch`);
  }
  if (expected.captured_at && expected.captured_at !== meta.captured_at) {
    return invalid(`${label}_meta_generation_captured_at_mismatch`);
  }

  const expectedCapture = objectValue(expected.capture);
  for (const field of ["dir", "page", "pdf", "text", "layout", "meta"]) {
    if (
      expectedCapture[field] != null
      && expectedCapture[field] !== capture.stored[field]
    ) {
      return invalid(`${label}_meta_generation_capture_mismatch`, field);
    }
  }

  for (const field of ["text_hash", "image_hash", "file_hash", "layout_hash"]) {
    if (expected[field] != null && expected[field] !== meta[field]) {
      return invalid(`${label}_meta_generation_hash_mismatch`, field);
    }
  }
  for (const field of ["text_length", "file_bytes", "page_bytes", "thumb_bytes"]) {
    if (expected[field] != null && expected[field] !== meta[field]) {
      return invalid(`${label}_meta_generation_length_mismatch`, field);
    }
  }
  const expectedGeometryHash = expected.text_geometry?.geometry_hash;
  if (
    expectedGeometryHash != null
    && expectedGeometryHash !== meta.text_geometry?.geometry_hash
  ) {
    return invalid(`${label}_meta_generation_hash_mismatch`, "text_geometry.geometry_hash");
  }
  return { ok: true };
}

function validateCoreCaptureBytes({ capture, kind, meta, metaFiles, label }) {
  const requiredPaths = kind === "pdf"
    ? ["pdf", "text"]
    : ["page", "thumb", "text"];
  for (const field of requiredPaths) {
    if (metaFiles[field] !== capture.stored[field]) {
      return invalid(`${label}_meta_file_mismatch`, field);
    }
  }

  let textBytes;
  try {
    textBytes = readFileSync(capture.resolved.text);
  } catch (error) {
    return invalid(`${label}_meta_text_read_failed`, errorMessage(error));
  }
  const decodedText = decodeWriterFramedText(textBytes);
  if (!decodedText.ok) {
    return invalid(`${label}_meta_${decodedText.reason}`);
  }
  const textHash = lowerSha256OrNull(meta.text_hash);
  if (!textHash) return invalid(`${label}_meta_text_hash_invalid`);
  if (sha256Bytes(Buffer.from(decodedText.text, "utf8")) !== textHash) {
    return invalid(`${label}_meta_text_hash_mismatch`);
  }
  if (!Number.isSafeInteger(meta.text_length) || meta.text_length !== decodedText.text.length) {
    return invalid(`${label}_meta_text_length_mismatch`);
  }

  if (kind === "pdf") {
    let pdfBytes;
    try {
      pdfBytes = readFileSync(capture.resolved.pdf);
    } catch (error) {
      return invalid(`${label}_meta_pdf_read_failed`, errorMessage(error));
    }
    const fileHash = lowerSha256OrNull(meta.file_hash);
    if (!fileHash) return invalid(`${label}_meta_file_hash_invalid`);
    if (sha256Bytes(pdfBytes) !== fileHash) {
      return invalid(`${label}_meta_pdf_hash_mismatch`);
    }
    if (!Number.isSafeInteger(meta.file_bytes) || meta.file_bytes !== pdfBytes.length) {
      return invalid(`${label}_meta_pdf_bytes_mismatch`);
    }
    return { ok: true };
  }

  let pageBytes;
  try {
    pageBytes = readFileSync(capture.resolved.page);
  } catch (error) {
    return invalid(`${label}_meta_page_read_failed`, errorMessage(error));
  }
  const imageHash = lowerSha256OrNull(meta.image_hash);
  if (!imageHash) return invalid(`${label}_meta_image_hash_invalid`);
  if (sha256Bytes(pageBytes) !== imageHash) {
    return invalid(`${label}_meta_page_hash_mismatch`);
  }
  if (!Number.isSafeInteger(meta.page_bytes) || meta.page_bytes !== pageBytes.length) {
    return invalid(`${label}_meta_page_bytes_mismatch`);
  }

  let thumbBytes;
  try {
    thumbBytes = readFileSync(capture.resolved.thumb);
  } catch (error) {
    return invalid(`${label}_meta_thumb_read_failed`, errorMessage(error));
  }
  if (!Number.isSafeInteger(meta.thumb_bytes) || meta.thumb_bytes !== thumbBytes.length) {
    return invalid(`${label}_meta_thumb_bytes_mismatch`);
  }
  return { ok: true };
}

function decodeWriterFramedText(bytes) {
  let raw;
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, reason: "text_utf8_invalid" };
  }
  const text = raw.endsWith("\r\n")
    ? raw.slice(0, -2)
    : raw.endsWith("\n")
      ? raw.slice(0, -1)
      : null;
  if (text === null || text.endsWith("\n") || text.endsWith("\r")) {
    return { ok: false, reason: "text_writer_framing_invalid" };
  }
  return { ok: true, text };
}

function validateMainWebLayoutEvidence({ capture, meta, metaFiles, label }) {
  const imageHash = lowerSha256OrNull(meta.image_hash);
  if (!imageHash) return invalid(`${label}_meta_image_hash_invalid`);

  const declared = objectValue(capture.declared);
  for (const [field, expected] of [
    ["image_hash", imageHash],
    ["layout_hash", meta.layout_hash],
    ["captured_at", meta.captured_at],
  ]) {
    if (declared[field] != null && declared[field] !== expected) {
      return invalid(`${label}_capture_${field}_mismatch`);
    }
  }

  const layoutRead = readJson(capture.resolved.layout);
  if (!layoutRead.ok) {
    return invalid(`${label}_meta_layout_json_invalid`, layoutRead.error);
  }
  const layout = objectValue(layoutRead.value);
  const binding = verifyVisualTextGeometryBinding(layout, imageHash);
  if (!binding.valid) {
    return invalid(`${label}_meta_layout_binding_invalid`, binding.reason);
  }

  const layoutHash = lowerSha256OrNull(layout.geometry_hash);
  const metadataLayoutHash = lowerSha256OrNull(meta.layout_hash);
  const geometry = objectValue(meta.text_geometry);
  const localization = objectValue(meta.localization);
  if (
    !layoutHash
    || metadataLayoutHash !== layoutHash
    || lowerSha256OrNull(geometry.geometry_hash) !== layoutHash
    || lowerSha256OrNull(localization.geometry_hash) !== layoutHash
  ) {
    return invalid(`${label}_meta_layout_geometry_identity_mismatch`);
  }
  if (
    layout.state_id !== "main"
    || layout.captured_at !== meta.captured_at
    || localization.captured_at !== meta.captured_at
  ) {
    return invalid(`${label}_meta_layout_captured_at_mismatch`);
  }
  if (
    metaFiles.page !== capture.stored.page
    || geometry.file !== capture.stored.layout
    || geometry.screenshot?.image_ref !== capture.stored.page
    || layout.screenshot?.image_ref !== capture.stored.page
  ) {
    return invalid(`${label}_meta_layout_path_identity_mismatch`);
  }
  if (
    lowerSha256OrNull(layout.screenshot?.image_hash) !== imageHash
    || lowerSha256OrNull(geometry.screenshot?.image_hash) !== imageHash
    || lowerSha256OrNull(localization.bound_image_hash) !== imageHash
  ) {
    return invalid(`${label}_meta_layout_image_identity_mismatch`);
  }
  if (
    localization.geometry_ready !== true
    || localization.accounted_for !== true
  ) {
    return invalid(`${label}_meta_layout_localization_not_ready`);
  }
  if (!sameGeometryReference(geometry, layout)) {
    return invalid(`${label}_meta_layout_reference_mismatch`);
  }
  return { ok: true };
}

function sameGeometryReference(reference, layout) {
  return reference.version === layout.version
    && reference.coordinate_space === layout.coordinate_space
    && reference.node_count === layout.node_count
    && reference.run_count === layout.run_count
    && sameJson(reference.document, layout.document)
    && sameJson(reference.viewport, layout.viewport)
    && sameJson(reference.screenshot, layout.screenshot);
}

function sameJson(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function lowerSha256OrNull(value) {
  const text = String(value || "").trim();
  return /^[0-9a-f]{64}$/.test(text) ? text : null;
}

function validInstant(value) {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

function validateStoredPath({ archiveRoot, sourceDir, storedPath }) {
  const value = String(storedPath || "").trim();
  if (!value || isAbsolute(value)) return invalid("path_not_archive_relative");
  const resolvedPath = resolve(archiveRoot, value);
  if (!pathIsWithin(sourceDir, resolvedPath)) return invalid("path_outside_source");
  try {
    const realArchive = realpathSync(archiveRoot);
    const realSource = realpathSync(sourceDir);
    if (!pathIsWithin(realArchive, realSource)) {
      return invalid("source_symlink_outside_archive");
    }
  } catch (error) {
    return invalid("source_realpath_failed", errorMessage(error));
  }
  if (existsSync(resolvedPath)) {
    try {
      const realSource = realpathSync(sourceDir);
      const realTarget = realpathSync(resolvedPath);
      if (!pathIsWithin(realSource, realTarget)) return invalid("path_symlink_outside_source");
    } catch (error) {
      return invalid("path_realpath_failed", errorMessage(error));
    }
  }
  return {
    ok: true,
    resolved: resolvedPath,
    stored: relative(archiveRoot, resolvedPath).split(sep).join("/"),
  };
}

function captureKind(explicitKind, capture) {
  const value = objectValue(capture);
  const explicit = explicitKind === "webpage" || explicitKind === "pdf"
    ? explicitKind
    : null;
  if (explicitKind && !explicit) return invalid("capture_kind_ambiguous");
  const hasWeb = Boolean(value.page || value.thumb);
  const hasPdf = Boolean(value.pdf);
  if (hasWeb && hasPdf) return invalid("capture_kind_ambiguous");
  const inferred = hasPdf ? "pdf" : hasWeb ? "webpage" : null;
  if (explicit && inferred && explicit !== inferred) {
    return invalid("capture_kind_ambiguous");
  }
  if (!explicit && !inferred) return invalid("capture_kind_ambiguous");
  return { ok: true, kind: explicit || inferred };
}

function sameCaptureDirectory(left, right) {
  const leftDir = typeof left?.dir === "string" ? left.dir.replaceAll("\\", "/") : "";
  const rightDir = typeof right?.dir === "string" ? right.dir.replaceAll("\\", "/") : "";
  return Boolean(leftDir && rightDir && leftDir === rightDir);
}

function sameResolvedPath(left, right) {
  if (!left || !right) return false;
  const normalizedLeft = canonicalPath(left);
  const normalizedRight = canonicalPath(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function validateRealCaptureContainment({
  archiveRoot,
  sourceDir,
  captureDir,
  resolved,
  label,
}) {
  if (!existsSync(captureDir)) return { ok: true };
  try {
    const realArchive = realpathSync(archiveRoot);
    const realSource = realpathSync(sourceDir);
    const realCapture = realpathSync(captureDir);
    if (!pathIsWithin(realArchive, realSource)) {
      return invalid(`${label}_source_symlink_outside_archive`);
    }
    if (!pathIsWithin(realSource, realCapture)) {
      return invalid(`${label}_capture_symlink_outside_source`);
    }
    for (const [field, target] of Object.entries(resolved)) {
      if (field === "dir" || !target || !existsSync(target)) continue;
      if (!pathIsWithin(realCapture, realpathSync(target))) {
        return invalid(`${label}_capture_file_symlink_outside_capture_dir`, field);
      }
    }
  } catch (error) {
    return invalid(`${label}_capture_realpath_failed`, errorMessage(error));
  }
  return { ok: true };
}

function realPathContainment(parent, candidate) {
  if (!existsSync(parent) || !existsSync(candidate)) return { ok: true };
  try {
    return pathIsWithin(realpathSync(parent), realpathSync(candidate))
      ? { ok: true }
      : { ok: false };
  } catch (error) {
    return { ok: false, detail: errorMessage(error) };
  }
}

function canonicalPath(value) {
  try {
    return realpathSync(value);
  } catch {
    return resolve(value);
  }
}

function pathIsWithin(parent, candidate) {
  const path = relative(resolve(parent), resolve(candidate));
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function readJson(path) {
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, "utf8")) };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

function isRegularFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function metadataPaths(value) {
  if (Array.isArray(value)) return value.flatMap(metadataPaths);
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([field, entry]) => {
    if (metadataPathFields.has(field) && typeof entry === "string") {
      return [{ field, value: entry }];
    }
    return metadataPaths(entry);
  });
}

function refusal(sourceId, reason, details = {}) {
  return {
    source_id: sourceId || null,
    status: "refused",
    decision: "refuse",
    reason,
    ...details,
  };
}

function invalid(reason, detail = null) {
  return { ok: false, reason, detail };
}

function objectValue(value) {
  return isObject(value) ? value : {};
}

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function objectHasKeys(value) {
  return Object.keys(objectValue(value)).length > 0;
}

function objectOrNull(value) {
  return objectHasKeys(value) ? value : null;
}

function nullable(value) {
  return value === undefined ? null : value;
}

function nonNegativeNumberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function requiredArchiveRoot(value) {
  const path = String(value ?? "").trim();
  if (!path) throw new TypeError("archiveRoot is required.");
  return resolve(path);
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function errorMessage(error) {
  return String(error?.message || error || "unknown error");
}
