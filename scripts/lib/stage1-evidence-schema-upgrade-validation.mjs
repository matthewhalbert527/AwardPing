import { createHash } from "node:crypto";
import { dirname } from "node:path";
import {
  canonicalExpansionStateCaptureCoverage,
  conservativeExpansionStateCaptureCoverage,
  hasExpansionStateCaptureCoverageClaim,
  legacyExpansionStateCaptureCoverageFromMetadata,
} from "./expansion-state-descriptor-canonicalization.mjs";
import {
  evaluateStage1FirstVisualBaselineActivation,
  normalizeStage1BaselineEvidenceWords,
  stage1BaselineActivationTextSha256,
} from "./stage1-baseline-activation-guard.mjs";
import { normalizeSourceIntakeUrl } from "./source-intake.mjs";
import {
  assertR2CaptureArtifactIdentity,
  assertR2CaptureArtifactSlots,
  isR2CaptureGeometryReady,
  prepareR2CaptureArtifacts,
  retainedCaptureArtifactProjectionSchema,
} from "./r2-capture-artifact-bindings.mjs";
import { baselineMatchesRetainedProjectionCapture } from "./visual-baseline-retained-projection-identity.mjs";
import { verifyVisualTextGeometryBinding } from "./visual-event-localization.mjs";

export const STAGE1_EVIDENCE_SCHEMA_UPGRADE_VALIDATION_SCHEMA =
  "awardping.stage1.evidence-schema-upgrade-validation.v1";

export const STAGE1_EVIDENCE_SCHEMA_UPGRADE_DECISIONS = Object.freeze({
  ELIGIBLE_UNCHANGED_UPGRADE: "eligible_unchanged_upgrade",
  MATERIAL_DIFFERENCE_CANDIDATE: "material_difference_candidate",
  EVIDENCE_FAILURE_QUARANTINE: "evidence_failure_quarantine",
});

const sha256Pattern = /^[a-f0-9]{64}$/u;
const exactWebSemanticFields = Object.freeze([
  ["text_hash", "text_length", false],
  ["body_text_hash", "body_text_length", false],
  ["main_content_hash", "main_content_text_length", false],
  ["nav_header_footer_hash", "nav_header_footer_text_length", false],
  ["expansion_hash", "expansion_text_length", false],
  ["expandable_sections_hash", null, true],
]);
const coreArtifactContract = Object.freeze({
  webpage: Object.freeze({
    page: ["page_path", "page.jpg", "image/jpeg"],
    thumb: ["thumb_path", "thumb.jpg", "image/jpeg"],
    text: ["text_path", "text.txt", "text/plain; charset=utf-8"],
    layout: ["layout_path", "layout.json", "application/json; charset=utf-8"],
    meta: ["meta_path", "meta.json", "application/json; charset=utf-8"],
  }),
  pdf: Object.freeze({
    pdf: ["pdf_path", "document.pdf", "application/pdf"],
    text: ["text_path", "text.txt", "text/plain; charset=utf-8"],
    meta: ["meta_path", "meta.json", "application/json; charset=utf-8"],
  }),
});

class Stage1UpgradeValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "Stage1UpgradeValidationError";
    this.code = code;
  }
}

/**
 * Pure, fail-closed decision gate for the isolated Stage 1 evidence-schema
 * upgrade. Buffers and capture records are supplied by the caller; this
 * function performs no filesystem, database, queue, R2, or provider writes.
 */
export function evaluateStage1EvidenceSchemaUpgradeCapture({
  sourceId,
  sourceKind = null,
  reviewedFinalUrl = null,
  reviewedEvidenceQuotes = null,
  immutableAcquisition,
  existingBaseline,
  existingCapture,
  existingPreparedArtifacts,
  capture,
  capturePreparedArtifacts,
  preIntake = null,
  postIntake = null,
} = {}) {
  const evidence = {
    source_id: cleanText(sourceId) || null,
    kind: null,
    reviewed_final_url: null,
    immutable_acquisition: null,
    existing: null,
    capture: null,
    intake: null,
    comparison: null,
  };

  try {
    const canonicalSourceId = requiredText(sourceId, "source_id");
    const acquisition = acquisitionRecord(immutableAcquisition);
    const binding = evaluateStage1FirstVisualBaselineActivation({
      acquisition,
      sourceId: canonicalSourceId,
      bindingOnly: true,
    });
    if (!binding.applies || !binding.allowed) {
      refuse(
        binding.reason || "immutable_acquisition_binding_invalid",
        binding.detail || "The sealed Stage 1 acquisition binding is invalid.",
      );
    }

    const sealed = sealedAcquisitionIdentity(acquisition, immutableAcquisition);
    if (reviewedFinalUrl && comparableUrl(reviewedFinalUrl) !== sealed.final_url) {
      refuse(
        "reviewed_final_url_disagrees_with_acquisition",
        "The supplied reviewed final URL differs from the immutable acquisition.",
      );
    }
    if (
      reviewedEvidenceQuotes
      && !sameJson(reviewedEvidenceQuotes, sealed.evidence_quotes)
    ) {
      refuse(
        "reviewed_evidence_quotes_disagree_with_acquisition",
        "The supplied reviewed evidence quotes differ from the immutable acquisition.",
      );
    }

    const kind = captureKind(sourceKind || capture?.kind || existingCapture?.kind);
    evidence.kind = kind;
    evidence.reviewed_final_url = sealed.final_url;
    evidence.immutable_acquisition = {
      file_hash: sealed.file_hash,
      text_hash: sealed.text_hash,
      normalized_text_hash: sealed.normalized_text_hash,
      evidence_quote_count: sealed.evidence_quotes.length,
      guard_sha256: binding.guard_sha256,
    };

    const baselineCapture = existingCaptureWithBaselineAuthority(
      existingCapture,
      existingBaseline,
    );
    assertCaptureEnvelope({
      label: "existing",
      sourceId: canonicalSourceId,
      kind,
      capture: baselineCapture,
      reviewedFinalUrl: sealed.final_url,
    });
    assertExistingBaselineIdentity({
      sourceId: canonicalSourceId,
      baseline: existingBaseline,
      capture: baselineCapture,
    });
    const existingArtifacts = validatePreparedCaptureArtifacts({
      label: "existing",
      sourceId: canonicalSourceId,
      kind,
      capture: baselineCapture,
      baseline: existingBaseline,
      prepared: existingPreparedArtifacts,
      requireVerifiedCompleteCoverage: false,
      allowLegacySchema: true,
    });
    assertExistingActivationBinding({
      baseline: existingBaseline,
      acquisition,
      binding,
      sealed,
      sourceId: canonicalSourceId,
      existingCapture: baselineCapture,
    });
    assertQuotePresence("existing_visual", baselineCapture.text, sealed.evidence_quotes);
    assertImmutableBaselineIdentity({ kind, capture: baselineCapture, sealed });

    assertCaptureEnvelope({
      label: "capture",
      sourceId: canonicalSourceId,
      kind,
      capture,
      reviewedFinalUrl: sealed.final_url,
    });
    const prospectiveArtifacts = validatePreparedCaptureArtifacts({
      label: "capture",
      sourceId: canonicalSourceId,
      kind,
      capture,
      prepared: capturePreparedArtifacts,
      requireVerifiedCompleteCoverage: kind === "webpage",
      allowLegacySchema: false,
    });
    let intake = null;
    if (kind === "webpage") {
      intake = validateWebIntakePair({
        preIntake,
        postIntake,
        capture,
        sealed,
      });
    } else {
      assertPdfNotApplicableContract(capture, prospectiveArtifacts.metadata, "capture");
      intake = {
        status: "not_applicable_pdf",
        capture_visual_quotes: quotePresence(capture.text, sealed.evidence_quotes),
      };
    }

    const comparison = compareCaptureIdentity({
      kind,
      existing: baselineCapture,
      capture,
      sealed,
      intake,
    });
    evidence.existing = captureEvidenceSummary(baselineCapture, existingArtifacts);
    evidence.capture = captureEvidenceSummary(capture, prospectiveArtifacts);
    evidence.intake = intake;
    evidence.comparison = comparison.evidence;

    if (comparison.material_reasons.length) {
      return result(
        STAGE1_EVIDENCE_SCHEMA_UPGRADE_DECISIONS.MATERIAL_DIFFERENCE_CANDIDATE,
        comparison.material_reasons,
        evidence,
      );
    }

    return result(
      STAGE1_EVIDENCE_SCHEMA_UPGRADE_DECISIONS.ELIGIBLE_UNCHANGED_UPGRADE,
      [{
        code: "exact_semantic_and_primary_visual_identity_verified",
        detail:
          "The prospective capture preserves the exact semantic and primary visual identity while supplying fully verified evidence-schema artifacts.",
      }],
      evidence,
    );
  } catch (error) {
    return result(
      STAGE1_EVIDENCE_SCHEMA_UPGRADE_DECISIONS.EVIDENCE_FAILURE_QUARANTINE,
      [{
        code: validationErrorCode(error),
        detail: errorMessage(error),
      }],
      evidence,
    );
  }
}

function acquisitionRecord(value) {
  return objectValue(value?.acquisition || value);
}

function sealedAcquisitionIdentity(acquisition, supplied) {
  const reviewSeal = objectValue(acquisition.review_seal);
  const disposition = objectValue(reviewSeal.human_source_disposition);
  const guard = objectValue(disposition.activation_guard);
  const review = objectValue(disposition.effective_source_review);
  const suppliedIdentity = objectValue(supplied?.identity);
  const retainedManifest = objectValue(
    suppliedIdentity.retained_artifact
      || supplied?.retained_artifact
      || reviewSeal.retained_artifact,
  );
  const fileHash = requiredSha256(
    suppliedIdentity.file_hash
      || supplied?.file_hash
      || retainedManifest.file_hash
      || guard.capture_file_sha256,
    "immutable acquisition file_hash",
  );
  if (fileHash !== requiredSha256(guard.capture_file_sha256, "activation guard file hash")) {
    refuse(
      "immutable_acquisition_file_hash_disagrees_with_guard",
      "The immutable acquisition file hash differs from its sealed activation guard.",
    );
  }
  const normalizedTextHash = requiredSha256(
    guard.normalized_retained_text_sha256,
    "immutable acquisition normalized text hash",
  );
  const textHashValue = cleanText(
    suppliedIdentity.text_hash
      || supplied?.text_hash
      || retainedManifest.text_hash,
  ).toLowerCase();
  const textHash = textHashValue ? requiredSha256(textHashValue, "immutable acquisition text_hash") : null;
  const finalUrl = comparableUrl(guard.final_url);
  if (!finalUrl) {
    refuse(
      "immutable_acquisition_final_url_invalid",
      "The immutable acquisition final URL is invalid.",
    );
  }
  const quotes = Array.isArray(review.evidence_quotes) ? review.evidence_quotes : [];
  if (!quotes.length || quotes.some((quote) => !cleanText(quote))) {
    refuse(
      "immutable_acquisition_evidence_quotes_invalid",
      "The immutable acquisition does not contain complete reviewed evidence quotes.",
    );
  }
  return {
    file_hash: fileHash,
    text_hash: textHash,
    normalized_text_hash: normalizedTextHash,
    final_url: finalUrl,
    evidence_quotes: [...quotes],
    source_acquisition_id: cleanText(acquisition.id),
    request_id: cleanText(acquisition.origin_source_page_request_id),
  };
}

function existingCaptureWithBaselineAuthority(existingCapture, baseline) {
  const capture = objectValue(existingCapture);
  const summary = objectValue(baseline?.summary_metadata);
  return {
    ...capture,
    source: Object.keys(objectValue(capture.source)).length
      ? capture.source
      : baseline?.source,
    retained_artifact_projection:
      capture.retained_artifact_projection
      || summary.retained_artifact_projection,
    expansion_state_capture_coverage:
      capture.expansion_state_capture_coverage
      || summary.expansion_state_capture_coverage,
  };
}

function assertCaptureEnvelope({ label, sourceId, kind, capture, reviewedFinalUrl }) {
  if (!capture || typeof capture !== "object" || Array.isArray(capture)) {
    refuse(`${label}_capture_missing`, `The ${label} capture is missing.`);
  }
  if (capture.kind !== kind) {
    refuse(`${label}_capture_kind_mismatch`, `The ${label} capture kind does not match.`);
  }
  if (cleanText(capture.source?.id) !== sourceId) {
    refuse(`${label}_capture_source_mismatch`, `The ${label} capture belongs to another source.`);
  }
  if (!Number.isFinite(Date.parse(cleanText(capture.captured_at)))) {
    refuse(`${label}_capture_timestamp_invalid`, `The ${label} capture timestamp is invalid.`);
  }
  if (comparableUrl(capture.final_url) !== reviewedFinalUrl) {
    refuse(`${label}_capture_url_drift`, `The ${label} capture resolved to another URL.`);
  }
  if (typeof capture.text !== "string") {
    refuse(`${label}_capture_text_missing`, `The ${label} capture semantic text is missing.`);
  }
}

function assertExistingBaselineIdentity({ sourceId, baseline, capture }) {
  const baselineMetaPath = normalizedPath(baseline?.capture?.meta);
  const captureMetaPath = archiveCaptureRef(sourceId, capture.captured_at, "meta.json");
  if (!baselineMatchesRetainedProjectionCapture({
    sourceId,
    baseline,
    capture,
    baselineMetaPath,
    captureMetaPath,
  })) {
    refuse(
      "existing_baseline_capture_identity_mismatch",
      "The local baseline does not exactly bind the retained source, capture generation, metadata path, timestamp, and core hashes.",
    );
  }
  if (comparableUrl(baseline?.final_url) !== comparableUrl(capture.final_url)) {
    refuse(
      "existing_baseline_final_url_mismatch",
      "The local baseline final URL differs from its retained raw metadata.",
    );
  }
  const fields = capture.kind === "pdf"
    ? [["text_hash", "text_length"], ["file_hash", "file_bytes"]]
    : exactWebSemanticFields.map(([hashField, lengthField]) => [hashField, lengthField]);
  for (const [hashField, lengthField] of fields) {
    if (
      !Object.hasOwn(objectValue(baseline), hashField)
      || baseline[hashField] !== capture[hashField]
      || (
        lengthField
        && (
          !Object.hasOwn(objectValue(baseline), lengthField)
          || baseline[lengthField] !== capture[lengthField]
        )
      )
    ) {
      refuse(
        "existing_baseline_semantic_identity_mismatch",
        `The local baseline ${hashField}${lengthField ? ` or ${lengthField}` : ""} differs from retained raw metadata.`,
      );
    }
  }
}

function assertExistingActivationBinding({
  baseline,
  acquisition,
  binding,
  sealed,
  sourceId,
  existingCapture,
}) {
  const activation = objectValue(baseline?.summary_metadata?.stage1_baseline_activation);
  const validStatus = new Set([
    "exact_hash_verified_pending_server_receipt",
    "server_prepare_recorded",
  ]);
  if (
    !validStatus.has(activation.status)
    || activation.shared_award_source_id !== sourceId
    || activation.source_acquisition_id !== acquisition.id
    || activation.source_page_request_id !== acquisition.origin_source_page_request_id
    || activation.expected_normalized_text_sha256 !== sealed.normalized_text_hash
    || activation.observed_normalized_text_sha256 !== sealed.normalized_text_hash
    || activation.guard_sha256 !== binding.guard_sha256
    || comparableUrl(activation.reviewed_final_url) !== sealed.final_url
    || comparableUrl(activation.observed_final_url) !== sealed.final_url
    || activation.visual_evidence_quotes_verified !== true
    || activation.retained_evidence_quotes_verified !== true
  ) {
    refuse(
      "existing_baseline_activation_binding_invalid",
      "The existing baseline does not carry its exact immutable Stage 1 activation verification.",
    );
  }
  if (
    stage1BaselineActivationTextSha256(existingCapture?.text)
      !== sealed.normalized_text_hash
  ) {
    refuse(
      "existing_baseline_normalized_text_disagrees_with_acquisition",
      "The retained local baseline text differs from the immutable reviewed acquisition.",
    );
  }
}

function assertImmutableBaselineIdentity({ kind, capture, sealed }) {
  if (kind !== "pdf") return;
  if (!sealed.text_hash) {
    refuse(
      "immutable_acquisition_pdf_text_hash_missing",
      "PDF upgrade validation requires the immutable retained intake manifest text_hash.",
    );
  }
  if (capture.file_hash !== sealed.file_hash || capture.text_hash !== sealed.text_hash) {
    refuse(
      "existing_pdf_identity_disagrees_with_acquisition",
      "The existing PDF baseline does not match the immutable acquisition file and text hashes.",
    );
  }
}

function validatePreparedCaptureArtifacts({
  label,
  sourceId,
  kind,
  capture,
  baseline = null,
  prepared,
  requireVerifiedCompleteCoverage,
  allowLegacySchema,
}) {
  const suppliedArtifacts = Array.isArray(prepared?.artifacts) ? prepared.artifacts : [];
  if (!suppliedArtifacts.length) {
    refuse(`${label}_retained_artifacts_missing`, `The ${label} retained artifacts are missing.`);
  }
  const paths = suppliedArtifacts.map((artifact) => normalizedPath(
    artifact?.path || capturePathForSlot(capture, artifact?.name),
  ));
  if (paths.some((path) => !path) || new Set(paths).size !== paths.length) {
    refuse(
      `${label}_retained_artifact_paths_invalid`,
      `The ${label} retained artifact paths are missing or duplicated.`,
    );
  }
  let rebuilt;
  try {
    const bodies = new Map(paths.map((path, index) => [path, suppliedArtifacts[index].body]));
    const verified = prepareR2CaptureArtifacts(
      suppliedArtifacts.map((artifact, index) => ({
        name: artifact.name,
        fileName: artifact.fileName,
        path: paths[index],
        contentType: artifact.contentType,
      })),
      { readFile: (path) => bodies.get(path) },
    );
    const pathByName = new Map(
      suppliedArtifacts.map((artifact, index) => [artifact.name, paths[index]]),
    );
    rebuilt = {
      ...verified,
      artifacts: verified.artifacts.map((artifact) => ({
        ...artifact,
        path: pathByName.get(artifact.name),
      })),
    };
  } catch (error) {
    refuse(
      `${label}_retained_artifact_preparation_failed`,
      `The ${label} retained artifacts could not be verified: ${errorMessage(error)}`,
    );
  }
  if (
    !sameJson(rebuilt.artifactBindings, prepared.artifactBindings)
    || suppliedArtifacts.some((artifact) => (
      !sameJson(artifact.binding, rebuilt.artifactBindings[artifact.name])
    ))
  ) {
    refuse(
      `${label}_retained_artifact_binding_mismatch`,
      `The ${label} retained artifact hashes or byte lengths are stale.`,
    );
  }

  const expansionCount = kind === "webpage"
    ? Array.isArray(capture.expansion_state_screenshots)
      ? capture.expansion_state_screenshots.length
      : -1
    : 0;
  if (expansionCount < 0) {
    refuse(
      `${label}_expansion_states_missing`,
      `The ${label} webpage expansion-state list is missing.`,
    );
  }
  const metadata = parseMetadataArtifact(rebuilt, label);
  if (allowLegacySchema) {
    return validateLegacyExistingCaptureArtifacts({
      label,
      sourceId,
      kind,
      capture,
      baseline,
      prepared: rebuilt,
      metadata,
      expansionCount,
    });
  }
  try {
    assertR2CaptureArtifactSlots(kind, rebuilt.artifactBindings, {
      layoutClaimed: kind === "webpage",
      expansionStateCount: expansionCount,
    });
    assertR2CaptureArtifactIdentity(capture, rebuilt, { sourceId });
  } catch (error) {
    refuse(
      `${label}_retained_artifact_identity_invalid`,
      `The ${label} retained artifact identity is invalid: ${errorMessage(error)}`,
    );
  }
  const retainedCaptureText = decodeWriterTextArtifact(rebuilt, label);
  if (capture.text !== retainedCaptureText) {
    refuse(
      `${label}_semantic_text_object_mismatch`,
      `The ${label} in-memory semantic text differs from its retained text artifact.`,
    );
  }

  assertCaptureArtifactPaths({
    label,
    sourceId,
    kind,
    capture,
    prepared: rebuilt,
    metadata,
    requireMainLayout: kind === "webpage",
  });
  if (kind === "webpage") {
    const coverage = canonicalExpansionStateCaptureCoverage(
      capture.expansion_state_capture_coverage,
      { expectedRetainedStateCount: expansionCount },
    );
    if (!coverage) {
      refuse(
        `${label}_expansion_coverage_invalid`,
        `The ${label} expansion-state coverage is missing or malformed.`,
      );
    }
    if (
      requireVerifiedCompleteCoverage
      && (
        coverage.complete !== true
        || coverage.status !== "verified_complete"
        || coverage.truncated
        || coverage.failure_count !== 0
      )
    ) {
      refuse(
        `${label}_expansion_coverage_incomplete`,
        `The ${label} expansion-state discovery or capture is incomplete.`,
      );
    }
    const projection = projectionAuthority(capture.retained_artifact_projection);
    if (
      !projection
      || projection.kind !== "webpage"
      || projection.authoritative.layout_retained !== true
      || projection.authoritative.expansion_state_count !== expansionCount
    ) {
      refuse(
        `${label}_main_geometry_not_verified`,
        `The ${label} webpage does not retain exact main screenshot/layout geometry.`,
      );
    }
  } else {
    assertPdfNotApplicableContract(capture, metadata, label);
  }
  return { prepared: rebuilt, metadata, limitations: [], coverage: null };
}

function validateLegacyExistingCaptureArtifacts({
  label,
  sourceId,
  kind,
  capture,
  baseline,
  prepared,
  metadata,
  expansionCount,
}) {
  const limitations = [];
  const bindings = prepared.artifactBindings;
  const hasLayout = kind === "webpage" && Boolean(bindings.layout);
  let authoritativeLayoutRetained = hasLayout;
  try {
    assertR2CaptureArtifactSlots(kind, bindings, {
      layoutClaimed: hasLayout,
      expansionStateCount: expansionCount,
    });
  } catch (error) {
    refuse(
      `${label}_legacy_artifact_slots_invalid`,
      `The ${label} retained core artifact slots are invalid: ${errorMessage(error)}`,
    );
  }
  assertCaptureArtifactPaths({
    label,
    sourceId,
    kind,
    capture,
    prepared,
    metadata,
    requireMainLayout: false,
  });
  if (
    metadata.kind !== kind
    || cleanText(metadata.source?.id) !== sourceId
    || metadata.captured_at !== capture.captured_at
    || comparableUrl(metadata.final_url) !== comparableUrl(capture.final_url)
  ) {
    refuse(
      `${label}_legacy_raw_metadata_identity_invalid`,
      `The ${label} raw metadata belongs to another source, kind, URL, timestamp, or generation.`,
    );
  }

  const text = decodeWriterTextArtifact(prepared, label);
  const semanticTextHash = hashBytes(Buffer.from(text, "utf8"));
  const captureTextMatches = capture.text === text
    || capture.text === `${text}\n`
    || capture.text === `${text}\r\n`;
  if (
    !captureTextMatches
    || semanticTextHash !== requiredSha256(capture.text_hash, `${label} text_hash`)
    || semanticTextHash !== requiredSha256(metadata.text_hash, `${label} metadata text_hash`)
    || requiredNonNegativeInteger(capture.text_length, `${label} text_length`) !== text.length
    || requiredNonNegativeInteger(metadata.text_length, `${label} metadata text_length`)
      !== text.length
  ) {
    refuse(
      `${label}_legacy_text_identity_invalid`,
      `The ${label} retained text bytes, semantic hash, or length do not match.`,
    );
  }

  if (kind === "pdf") {
    assertLegacyCoreArtifact({
      label,
      slot: "pdf",
      hashField: "file_hash",
      lengthField: "file_bytes",
      capture,
      metadata,
      prepared,
    });
    if (
      capture.expansion_state_capture_coverage != null
      || metadata.expansion_state_capture_coverage != null
      || (capture.expansion_state_screenshots?.length || 0) !== 0
      || (metadata.expansion_state_screenshots?.length || 0) !== 0
      || Object.keys(bindings).some((slot) => slot === "layout" || slot.startsWith("expansion_state_"))
    ) {
      refuse(
        `${label}_legacy_pdf_geometry_claim_invalid`,
        `The ${label} PDF baseline contains webpage layout or expansion evidence.`,
      );
    }
    inspectLegacyProjection({
      value: metadata.retained_artifact_projection,
      label: "raw_metadata",
      kind,
      layoutRetained: false,
      expansionCount: 0,
      limitations,
    });
    inspectLegacyProjection({
      value: baseline?.summary_metadata?.retained_artifact_projection,
      label: "baseline",
      kind,
      layoutRetained: false,
      expansionCount: 0,
      limitations,
    });
    return { prepared, metadata, limitations, coverage: null };
  }

  assertLegacyCoreArtifact({
    label,
    slot: "page",
    hashField: "image_hash",
    lengthField: "page_bytes",
    capture,
    metadata,
    prepared,
  });
  assertLegacyLengthArtifact({
    label,
    slot: "thumb",
    lengthField: "thumb_bytes",
    capture,
    metadata,
    prepared,
  });
  if (hasLayout) {
    const geometryStatus = assertLegacyGeometryArtifact({
      label,
      role: "main layout",
      artifact: prepared.artifacts.find((artifact) => artifact.name === "layout"),
      captureGeometry: capture.text_geometry,
      metadataGeometry: metadata.text_geometry,
      expectedImageHash: capture.image_hash,
      expectedLayoutHash: capture.layout_hash,
      metadataLayoutHash: metadata.layout_hash,
      allowExplicitUnavailable: true,
    });
    if (geometryStatus === "explicitly_unavailable") {
      assertExplicitLegacyUnavailableLocalization(capture, metadata, label);
      limitations.push("main_layout_explicitly_unavailable");
      authoritativeLayoutRetained = false;
    }
    if (baseline?.layout_hash !== capture.layout_hash) {
      refuse(
        `${label}_legacy_baseline_layout_identity_invalid`,
        `The ${label} baseline layout hash differs from its retained layout.`,
      );
    }
  } else {
    if (
      capture.layout_hash
      || baseline?.layout_hash
      || metadata.layout_hash
      || metadata.files?.layout
      || metadata.text_geometry?.geometry_hash
    ) {
      refuse(
        `${label}_legacy_layout_artifact_missing`,
        `The ${label} baseline claims main geometry without a retained layout artifact.`,
      );
    }
    limitations.push("main_layout_not_retained");
  }

  const baselineStates = Array.isArray(baseline?.capture?.expansion_states)
    ? baseline.capture.expansion_states
    : [];
  const metadataStates = Array.isArray(metadata.expansion_state_screenshots)
    ? metadata.expansion_state_screenshots
    : [];
  if (baselineStates.length !== expansionCount || metadataStates.length !== expansionCount) {
    refuse(
      `${label}_legacy_expansion_state_count_mismatch`,
      `The ${label} retained expansion-state evidence count is inconsistent.`,
    );
  }
  for (let index = 0; index < expansionCount; index += 1) {
    const suffix = String(index + 1).padStart(2, "0");
    const state = objectValue(capture.expansion_state_screenshots[index]);
    const baselineState = objectValue(baselineStates[index]);
    const metadataState = objectValue(metadataStates[index]);
    const pageArtifact = prepared.artifacts.find(
      (artifact) => artifact.name === `expansion_state_${suffix}`,
    );
    const layoutArtifact = prepared.artifacts.find(
      (artifact) => artifact.name === `expansion_state_${suffix}_layout`,
    );
    const pageHash = requiredSha256(pageArtifact?.binding?.sha256, `${label} state ${suffix} image`);
    if (
      state.state_id !== `expansion-state-${suffix}`
      || baselineState.state_id !== state.state_id
      || metadataState.state_id !== state.state_id
      || pageHash !== requiredSha256(state.image_hash, `${label} state ${suffix} image_hash`)
      || pageHash !== requiredSha256(metadataState.image_hash, `${label} metadata state ${suffix} image_hash`)
      || baselineState.image_hash !== state.image_hash
      || baselineState.layout_hash !== state.layout_hash
      || requiredSha256(state.text_hash, `${label} state ${suffix} text_hash`)
        !== requiredSha256(metadataState.text_hash, `${label} metadata state ${suffix} text_hash`)
      || requiredNonNegativeInteger(state.text_length, `${label} state ${suffix} text_length`)
        !== requiredNonNegativeInteger(
          metadataState.text_length,
          `${label} metadata state ${suffix} text_length`,
        )
      || requiredPositiveInteger(state.page_bytes, `${label} state ${suffix} page_bytes`)
        !== pageArtifact.binding.byte_length
      || requiredPositiveInteger(
        metadataState.page_bytes,
        `${label} metadata state ${suffix} page_bytes`,
      ) !== pageArtifact.binding.byte_length
    ) {
      refuse(
        `${label}_legacy_expansion_state_identity_invalid`,
        `The ${label} expansion state ${suffix} has stale screenshot, text, length, or baseline bindings.`,
      );
    }
    const stateGeometryStatus = assertLegacyGeometryArtifact({
      label,
      role: `expansion state ${suffix} layout`,
      artifact: layoutArtifact,
      captureGeometry: state.text_geometry,
      metadataGeometry: metadataState.text_geometry,
      expectedImageHash: state.image_hash,
      expectedLayoutHash: state.layout_hash,
      metadataLayoutHash: metadataState.layout_hash,
      allowExplicitUnavailable: true,
    });
    if (stateGeometryStatus === "explicitly_unavailable") {
      limitations.push(`expansion_state_${suffix}_layout_explicitly_unavailable`);
    }
  }

  const coverage = legacyExistingCoverage(metadata, expansionCount, limitations, label);
  inspectLegacyProjection({
    value: metadata.retained_artifact_projection,
    label: "raw_metadata",
    kind,
    layoutRetained: authoritativeLayoutRetained,
    expansionCount,
    limitations,
  });
  inspectLegacyProjection({
    value: baseline?.summary_metadata?.retained_artifact_projection,
    label: "baseline",
    kind,
    layoutRetained: authoritativeLayoutRetained,
    expansionCount,
    limitations,
  });
  const baselineCoverage = baseline?.summary_metadata?.expansion_state_capture_coverage;
  if (baselineCoverage == null) {
    limitations.push("baseline_expansion_coverage_missing");
  } else if (!canonicalExpansionStateCaptureCoverage(baselineCoverage, {
    expectedRetainedStateCount: expansionCount,
  })) {
    refuse(
      `${label}_legacy_baseline_expansion_coverage_malformed`,
      `The ${label} baseline carries malformed expansion coverage.`,
    );
  }
  if (!coverage.complete) limitations.push(`expansion_coverage_${coverage.status}`);
  return {
    prepared,
    metadata,
    limitations: [...new Set(limitations)],
    coverage,
  };
}

function assertLegacyCoreArtifact({
  label,
  slot,
  hashField,
  lengthField,
  capture,
  metadata,
  prepared,
}) {
  const artifact = prepared.artifacts.find((item) => item.name === slot);
  const retainedHash = requiredSha256(artifact?.binding?.sha256, `${label} ${slot} bytes`);
  if (
    retainedHash !== requiredSha256(capture[hashField], `${label} ${hashField}`)
    || retainedHash !== requiredSha256(metadata[hashField], `${label} metadata ${hashField}`)
  ) {
    refuse(
      `${label}_${slot}_hash_identity_invalid`,
      `The ${label} ${slot} bytes do not match capture and raw metadata hashes.`,
    );
  }
  assertLegacyLengthArtifact({
    label,
    slot,
    lengthField,
    capture,
    metadata,
    prepared,
  });
}

function assertLegacyLengthArtifact({
  label,
  slot,
  lengthField,
  capture,
  metadata,
  prepared,
}) {
  const artifact = prepared.artifacts.find((item) => item.name === slot);
  const retainedLength = requiredPositiveInteger(
    artifact?.binding?.byte_length,
    `${label} ${slot} byte length`,
  );
  if (
    requiredPositiveInteger(capture[lengthField], `${label} ${lengthField}`) !== retainedLength
    || requiredPositiveInteger(metadata[lengthField], `${label} metadata ${lengthField}`)
      !== retainedLength
  ) {
    refuse(
      `${label}_${slot}_length_identity_invalid`,
      `The ${label} ${slot} byte length does not match capture and raw metadata.`,
    );
  }
}

function assertLegacyGeometryArtifact({
  label,
  role,
  artifact,
  captureGeometry,
  metadataGeometry,
  expectedImageHash,
  expectedLayoutHash,
  metadataLayoutHash,
  allowExplicitUnavailable = false,
}) {
  const layout = parseJsonArtifact(artifact?.body, `${label} ${role}`);
  const layoutHash = requiredSha256(expectedLayoutHash, `${label} ${role} hash`);
  const layoutReady = isR2CaptureGeometryReady({
      kind: "webpage",
      image_hash: expectedImageHash,
      text_geometry: layout,
    });
  const captureReady = isR2CaptureGeometryReady({
      kind: "webpage",
      image_hash: expectedImageHash,
      text_geometry: captureGeometry,
    });
  const explicitlyUnavailable = allowExplicitUnavailable
    && exactUnavailableGeometry(layout, expectedImageHash)
    && exactUnavailableGeometry(captureGeometry, expectedImageHash);
  if (
    (!(layoutReady && captureReady) && !explicitlyUnavailable)
    || requiredSha256(layout.geometry_hash, `${label} ${role} geometry_hash`) !== layoutHash
    || requiredSha256(captureGeometry?.geometry_hash, `${label} ${role} capture geometry_hash`)
      !== layoutHash
    || requiredSha256(metadataGeometry?.geometry_hash, `${label} ${role} metadata geometry_hash`)
      !== layoutHash
    || requiredSha256(metadataLayoutHash, `${label} ${role} metadata layout_hash`)
      !== layoutHash
    || requiredSha256(layout.screenshot?.image_hash, `${label} ${role} screenshot hash`)
      !== requiredSha256(expectedImageHash, `${label} ${role} expected image hash`)
    || requiredSha256(
      metadataGeometry?.screenshot?.image_hash,
      `${label} ${role} metadata screenshot hash`,
    ) !== expectedImageHash
  ) {
    refuse(
      `${label}_legacy_geometry_binding_invalid`,
      `The ${label} ${role} does not exactly bind its geometry to the retained screenshot.`,
    );
  }
  return explicitlyUnavailable ? "explicitly_unavailable" : "verified";
}

function exactUnavailableGeometry(value, expectedImageHash) {
  const geometry = objectValue(value);
  const status = cleanText(geometry.availability_status || geometry.status);
  const binding = verifyVisualTextGeometryBinding(geometry, expectedImageHash);
  return Boolean(
    status.startsWith("unavailable_")
    && cleanText(geometry.unavailable_reason)
    && binding.valid
    && requiredSha256(geometry.screenshot?.image_hash, "unavailable geometry image hash")
      === requiredSha256(expectedImageHash, "unavailable geometry expected image hash"),
  );
}

function assertExplicitLegacyUnavailableLocalization(capture, metadata, label) {
  const captureLocalization = objectValue(capture.localization);
  const metadataLocalization = objectValue(metadata.localization);
  const unavailable = (value) => Boolean(
    cleanText(value.status).includes("unavailable")
    && value.exact === false
    && value.accounted_for === true
    && value.geometry_ready === false
    && cleanText(value.unavailable_reason),
  );
  if (!unavailable(captureLocalization) || !unavailable(metadataLocalization)) {
    refuse(
      `${label}_legacy_unavailable_geometry_not_accounted_for`,
      `The ${label} unavailable layout is not explicitly accounted for by localization metadata.`,
    );
  }
}

function legacyExistingCoverage(metadata, expansionCount, limitations, label) {
  let coverage = legacyExpansionStateCaptureCoverageFromMetadata(metadata, {
    retainedStateCount: expansionCount,
  });
  if (coverage) return coverage;

  const missingCount = !Object.hasOwn(metadata, "expansion_state_count");
  if (missingCount) {
    coverage = legacyExpansionStateCaptureCoverageFromMetadata({
      ...metadata,
      expansion_state_count: expansionCount,
    }, { retainedStateCount: expansionCount });
    if (coverage) {
      limitations.push("raw_expansion_state_count_missing");
      return coverage;
    }
  }
  if (hasExpansionStateCaptureCoverageClaim(metadata)) {
    refuse(
      `${label}_legacy_expansion_coverage_malformed`,
      `The ${label} raw expansion coverage is partial, contradictory, or malformed.`,
    );
  }
  limitations.push("raw_expansion_coverage_missing");
  return conservativeExpansionStateCaptureCoverage({
    retainedStateCount: expansionCount,
    captureLimit: expansionCount,
  });
}

function inspectLegacyProjection({
  value,
  label,
  kind,
  layoutRetained,
  expansionCount,
  limitations,
}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    limitations.push(`${label}_retained_projection_missing`);
    return;
  }
  const projection = projectionAuthority(value);
  if (!projection) {
    if (value.schema === retainedCaptureArtifactProjectionSchema) {
      refuse(
        `existing_${label}_retained_projection_malformed`,
        `The existing ${label} carries a malformed current retained-artifact projection.`,
      );
    }
    limitations.push(`${label}_retained_projection_legacy`);
    return;
  }
  if (
    projection.kind !== kind
    || projection.authoritative.layout_retained !== layoutRetained
    || projection.authoritative.expansion_state_count !== expansionCount
  ) {
    refuse(
      `existing_${label}_retained_projection_conflict`,
      `The existing ${label} retained-artifact projection conflicts with retained artifact slots.`,
    );
  }
}

function decodeWriterTextArtifact(prepared, label) {
  const artifact = prepared.artifacts.find((item) => item.name === "text");
  let raw;
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(artifact?.body);
  } catch {
    refuse(`${label}_text_utf8_invalid`, `The ${label} retained text is not valid UTF-8.`);
  }
  const text = raw.endsWith("\r\n")
    ? raw.slice(0, -2)
    : raw.endsWith("\n")
      ? raw.slice(0, -1)
      : null;
  if (text === null || text.endsWith("\n") || text.endsWith("\r")) {
    refuse(
      `${label}_text_writer_framing_invalid`,
      `The ${label} retained text must have exactly one writer framing newline.`,
    );
  }
  return text;
}

function parseJsonArtifact(body, label) {
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    refuse("legacy_layout_json_invalid", `The ${label} artifact is not exact UTF-8 JSON.`);
  }
}

function parseMetadataArtifact(prepared, label) {
  const artifact = prepared.artifacts.find((item) => item.name === "meta");
  try {
    const metadata = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(artifact.body));
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error();
    return metadata;
  } catch {
    refuse(
      `${label}_raw_metadata_invalid`,
      `The ${label} raw metadata artifact is not an exact UTF-8 JSON object.`,
    );
  }
}

function assertCaptureArtifactPaths({
  label,
  sourceId,
  kind,
  capture,
  prepared,
  metadata,
  requireMainLayout,
}) {
  const generation = captureGeneration(capture.captured_at);
  const expectedDirectorySuffix = `/sources/${sourceId}/captures/${generation}`;
  const captureDirectory = normalizedPath(capture.dir);
  if (!captureDirectory.endsWith(expectedDirectorySuffix)) {
    refuse(
      `${label}_capture_generation_path_invalid`,
      `The ${label} capture directory does not match its source and timestamp generation.`,
    );
  }
  const byName = new Map(prepared.artifacts.map((artifact) => [artifact.name, artifact]));
  const slots = { ...coreArtifactContract[kind] };
  if (kind === "webpage" && !requireMainLayout && !byName.has("layout")) {
    delete slots.layout;
  }
  const coreSlots = Object.keys(slots);
  if (kind === "webpage") {
    for (const [index, state] of capture.expansion_state_screenshots.entries()) {
      const suffix = String(index + 1).padStart(2, "0");
      slots[`expansion_state_${suffix}`] = [
        `expansion_state_screenshots.${index}.page_path`,
        `expansion-state-${suffix}.jpg`,
        "image/jpeg",
      ];
      slots[`expansion_state_${suffix}_layout`] = [
        `expansion_state_screenshots.${index}.layout_path`,
        `expansion-state-${suffix}-layout.json`,
        "application/json; charset=utf-8",
      ];
      if (state?.state_id !== `expansion-state-${suffix}`) {
        refuse(
          `${label}_expansion_state_id_invalid`,
          `The ${label} expansion state ${suffix} has a stale or non-canonical identity.`,
        );
      }
    }
  }
  if (byName.size !== Object.keys(slots).length) {
    refuse(
      `${label}_retained_artifact_slot_set_invalid`,
      `The ${label} retained artifact set contains missing or unsupported slots.`,
    );
  }
  for (const [slot, [capturePathField, fileName, contentType]] of Object.entries(slots)) {
    const artifact = byName.get(slot);
    const capturePath = normalizedPath(valueAtPath(capture, capturePathField));
    const expectedPath = `${captureDirectory}/${fileName}`;
    if (
      !artifact
      || artifact.fileName !== fileName
      || artifact.contentType !== contentType
      || normalizedPath(artifact.path) !== expectedPath
      || capturePath !== expectedPath
      || dirname(normalizedPath(artifact.path)).replace(/\\/g, "/") !== captureDirectory
    ) {
      refuse(
        `${label}_${slot}_path_binding_invalid`,
        `The ${label} ${slot} artifact belongs to another path or capture generation.`,
      );
    }
  }

  const prefix = `sources/${sourceId}/captures/${generation}/`;
  for (const slot of coreSlots) {
    const [, fileName] = slots[slot];
    const metadataRef = normalizedPath(metadata.files?.[slot]);
    if (metadataRef !== `${prefix}${fileName}`) {
      refuse(
        `${label}_${slot}_metadata_path_invalid`,
        `The ${label} raw metadata ${slot} reference belongs to another source or generation.`,
      );
    }
  }
  if (kind === "webpage") {
    const metadataStates = Array.isArray(metadata.expansion_state_screenshots)
      ? metadata.expansion_state_screenshots
      : [];
    const metadataFileStates = Array.isArray(metadata.files?.expansion_states)
      ? metadata.files.expansion_states
      : [];
    for (const [index, state] of capture.expansion_state_screenshots.entries()) {
      const suffix = String(index + 1).padStart(2, "0");
      const page = `${prefix}expansion-state-${suffix}.jpg`;
      const layout = `${prefix}expansion-state-${suffix}-layout.json`;
      if (
        metadataStates[index]?.state_id !== state.state_id
        || normalizedPath(metadataStates[index]?.page) !== page
        || normalizedPath(metadataStates[index]?.layout) !== layout
        || metadataFileStates[index]?.state_id !== state.state_id
        || normalizedPath(metadataFileStates[index]?.page) !== page
        || normalizedPath(metadataFileStates[index]?.layout) !== layout
      ) {
        refuse(
          `${label}_expansion_metadata_path_invalid`,
          `The ${label} expansion metadata refers to another source, generation, or state.`,
        );
      }
    }
  }
}

function assertPdfNotApplicableContract(capture, metadata, label) {
  const projection = projectionAuthority(capture.retained_artifact_projection);
  const captureStates = capture.expansion_state_screenshots;
  const metadataStates = metadata.expansion_state_screenshots;
  const metadataFileStates = metadata.files?.expansion_states;
  if (
    !projection
    || projection.kind !== "pdf"
    || projection.localization_status !== "not_applicable_pdf"
    || projection.authoritative.layout_retained
    || projection.authoritative.expansion_state_count !== 0
    || capture.expansion_state_capture_coverage != null
    || (captureStates != null && (!Array.isArray(captureStates) || captureStates.length !== 0))
    || metadata.expansion_state_capture_coverage != null
    || (metadata.expansion_state_count != null && metadata.expansion_state_count !== 0)
    || (metadataStates != null && (!Array.isArray(metadataStates) || metadataStates.length !== 0))
    || (metadataFileStates != null && (!Array.isArray(metadataFileStates) || metadataFileStates.length !== 0))
    || (capture.localization?.status && capture.localization.status !== "not_applicable_pdf")
    || (metadata.localization?.status && metadata.localization.status !== "not_applicable_pdf")
  ) {
    refuse(
      `${label}_pdf_not_applicable_contract_invalid`,
      `The ${label} PDF contains layout or expansion claims instead of an explicit not-applicable contract.`,
    );
  }
}

function validateWebIntakePair({ preIntake, postIntake, capture, sealed }) {
  const pre = validateIntake("pre", preIntake, sealed);
  const post = validateIntake("post", postIntake, sealed);
  if (pre.normalized_text_hash !== post.normalized_text_hash) {
    refuse(
      "web_intake_not_stable",
      "The deterministic webpage intake changed during visual capture.",
    );
  }
  const captureNormalizedTextHash = stage1BaselineActivationTextSha256(capture.text);
  if (captureNormalizedTextHash !== pre.normalized_text_hash) {
    refuse(
      "web_intake_capture_text_mismatch",
      "The prospective visual capture text does not match the stable pre/post deterministic intake.",
    );
  }
  const preQuotes = quotePresence(preIntake.text, sealed.evidence_quotes);
  const postQuotes = quotePresence(postIntake.text, sealed.evidence_quotes);
  const visualQuotes = quotePresence(capture.text, sealed.evidence_quotes);
  return {
    pre_normalized_text_hash: pre.normalized_text_hash,
    post_normalized_text_hash: post.normalized_text_hash,
    capture_normalized_text_hash: captureNormalizedTextHash,
    capture_matches_stable_intake: true,
    immutable_normalized_text_hash: sealed.normalized_text_hash,
    matches_immutable_acquisition:
      pre.normalized_text_hash === sealed.normalized_text_hash,
    final_url: sealed.final_url,
    evidence_quotes_verified: preQuotes.ok && postQuotes.ok && visualQuotes.ok,
    pre_intake_quotes: preQuotes,
    post_intake_quotes: postQuotes,
    capture_visual_quotes: visualQuotes,
  };
}

function validateIntake(label, intake, sealed) {
  if (
    !intake
    || typeof intake !== "object"
    || intake.ok !== true
    || typeof intake.text !== "string"
    || !cleanText(intake.text)
  ) {
    refuse(
      `${label}_intake_capture_invalid`,
      `The ${label}-visual deterministic intake capture is missing or unsuccessful.`,
    );
  }
  const finalUrl = comparableUrl(intake.canonical_url || intake.final_url);
  if (finalUrl !== sealed.final_url) {
    refuse(
      `${label}_intake_url_drift`,
      `The ${label}-visual deterministic intake resolved to another URL.`,
    );
  }
  return {
    normalized_text_hash: stage1BaselineActivationTextSha256(intake.text),
    final_url: finalUrl,
  };
}

function compareCaptureIdentity({ kind, existing, capture, sealed, intake }) {
  const materialReasons = [];
  const semanticFields = kind === "pdf"
    ? [["text_hash", "text_length", false]]
    : exactWebSemanticFields;
  const semanticComparison = {};
  for (const [hashField, lengthField, nullable] of semanticFields) {
    const left = exactHashField(existing, hashField, nullable, "existing");
    const right = exactHashField(capture, hashField, nullable, "capture");
    if ((left === null) !== (right === null)) {
      refuse(
        `semantic_${hashField}_partial`,
        `The semantic ${hashField} is present on only one side of the comparison.`,
      );
    }
    let lengthsMatch = true;
    if (lengthField) {
      const leftLength = requiredNonNegativeInteger(existing[lengthField], `existing ${lengthField}`);
      const rightLength = requiredNonNegativeInteger(capture[lengthField], `capture ${lengthField}`);
      lengthsMatch = leftLength === rightLength;
    }
    const matches = left === right && lengthsMatch;
    semanticComparison[hashField] = {
      previous: left,
      current: right,
      matches,
      ...(lengthField
        ? { previous_length: existing[lengthField], current_length: capture[lengthField] }
        : {}),
    };
    if (!matches) {
      materialReasons.push({
        code: `material_${hashField}_changed`,
        detail: `The capture ${hashField}${lengthField ? ` or ${lengthField}` : ""} differs from the existing baseline.`,
      });
    }
  }

  if (kind === "pdf") {
    const previousFileHash = requiredSha256(existing.file_hash, "existing PDF file_hash");
    const currentFileHash = requiredSha256(capture.file_hash, "capture PDF file_hash");
    requiredPositiveInteger(existing.file_bytes, "existing PDF file_bytes");
    requiredPositiveInteger(capture.file_bytes, "capture PDF file_bytes");
    if (currentFileHash !== sealed.file_hash || capture.text_hash !== sealed.text_hash) {
      materialReasons.push({
        code: "material_pdf_identity_changed_from_acquisition",
        detail: "The capture PDF file or exact semantic text differs from the immutable acquisition.",
      });
    }
    if (!intake.capture_visual_quotes.ok) {
      materialReasons.push({
        code: "material_reviewed_quotes_removed",
        detail:
          `The current PDF text omits ${intake.capture_visual_quotes.missing_count} reviewed evidence quote(s).`,
      });
    }
    if (previousFileHash !== currentFileHash || existing.file_bytes !== capture.file_bytes) {
      materialReasons.push({
        code: "material_pdf_file_changed",
        detail: "The PDF file hash or byte length differs from the existing baseline.",
      });
    }
    return {
      material_reasons: dedupeReasons(materialReasons),
      evidence: {
        semantic_fields: semanticComparison,
        primary_visual_identity: {
          field: "file_hash",
          previous: previousFileHash,
          current: currentFileHash,
          matches: previousFileHash === currentFileHash,
          equivalence_basis: previousFileHash === currentFileHash ? "exact_hash" : null,
        },
      },
    };
  }

  const previousImageHash = requiredSha256(existing.image_hash, "existing webpage image_hash");
  const currentImageHash = requiredSha256(capture.image_hash, "capture webpage image_hash");
  if (previousImageHash !== currentImageHash) {
    materialReasons.push({
      code: "material_primary_image_changed",
      detail:
        "The main webpage screenshot hash changed; no exported exact deterministic chrome/noise equivalence proof was supplied.",
    });
  }
  if (!intake.matches_immutable_acquisition) {
    materialReasons.push({
      code: "material_intake_text_changed_from_acquisition",
      detail: "The stable pre/post intake text differs from the immutable reviewed acquisition.",
    });
  }
  const missingQuoteCount = Math.max(
    intake.pre_intake_quotes.missing_count,
    intake.post_intake_quotes.missing_count,
    intake.capture_visual_quotes.missing_count,
  );
  if (missingQuoteCount > 0) {
    materialReasons.push({
      code: "material_reviewed_quotes_removed",
      detail:
        `The stable current webpage observation omits ${missingQuoteCount} reviewed evidence quote(s).`,
    });
  }
  return {
    material_reasons: dedupeReasons(materialReasons),
    evidence: {
      semantic_fields: semanticComparison,
      primary_visual_identity: {
        field: "image_hash",
        previous: previousImageHash,
        current: currentImageHash,
        matches: previousImageHash === currentImageHash,
        equivalence_basis: previousImageHash === currentImageHash ? "exact_hash" : null,
      },
    },
  };
}

function assertQuotePresence(label, text, quotes) {
  const presence = quotePresence(text, quotes);
  if (!presence.ok) {
    refuse(
      `${label}_reviewed_quotes_missing`,
      `The ${label} omits ${presence.missing_count} complete reviewed evidence quote(s).`,
    );
  }
}

function quotePresence(text, quotes) {
  if (typeof text !== "string") {
    return {
      ok: false,
      quote_count: quotes.length,
      missing_count: quotes.length,
      missing_indexes: quotes.map((_, index) => index),
    };
  }
  const words = normalizeStage1BaselineEvidenceWords(text);
  const missingIndexes = quotes.flatMap((quote, index) => {
    const quoteWords = normalizeStage1BaselineEvidenceWords(quote);
    return !quoteWords || !` ${words} `.includes(` ${quoteWords} `) ? [index] : [];
  });
  return {
    ok: quotes.length > 0 && missingIndexes.length === 0,
    quote_count: quotes.length,
    missing_count: missingIndexes.length,
    missing_indexes: missingIndexes,
  };
}

function captureEvidenceSummary(capture, verified) {
  const projection = projectionAuthority(capture.retained_artifact_projection);
  const canonicalCoverage = capture.kind === "webpage"
    ? canonicalExpansionStateCaptureCoverage(
        capture.expansion_state_capture_coverage,
        { expectedRetainedStateCount: capture.expansion_state_screenshots.length },
      )
    : null;
  const coverage = verified.coverage || canonicalCoverage;
  return {
    captured_at: capture.captured_at,
    final_url: comparableUrl(capture.final_url),
    text_hash: capture.text_hash,
    image_hash: capture.kind === "webpage" ? capture.image_hash : null,
    file_hash: capture.kind === "pdf" ? capture.file_hash : null,
    layout_hash: projection?.authoritative.layout_hash || null,
    retained_expansion_state_count:
      projection?.authoritative.expansion_state_count ?? null,
    expansion_coverage_status: coverage?.status || (capture.kind === "pdf" ? "not_applicable" : null),
    artifact_slots: verified.prepared.artifacts.map((artifact) => artifact.name),
    raw_metadata_verified: true,
    legacy_limitations: verified.limitations,
  };
}

function result(decision, reasons, evidence) {
  const eligible = decision
    === STAGE1_EVIDENCE_SCHEMA_UPGRADE_DECISIONS.ELIGIBLE_UNCHANGED_UPGRADE;
  const material = decision
    === STAGE1_EVIDENCE_SCHEMA_UPGRADE_DECISIONS.MATERIAL_DIFFERENCE_CANDIDATE;
  const quarantine = decision
    === STAGE1_EVIDENCE_SCHEMA_UPGRADE_DECISIONS.EVIDENCE_FAILURE_QUARANTINE;
  return {
    schema_version: STAGE1_EVIDENCE_SCHEMA_UPGRADE_VALIDATION_SCHEMA,
    decision,
    creates_api_charge: false,
    reason: reasons[0]?.code || null,
    reasons,
    evidence,
    outcome: {
      would_commit: eligible,
      would_queue_visual_candidate: material,
      would_quarantine: quarantine,
      creates_api_charge: false,
    },
  };
}

function projectionAuthority(value) {
  const projection = objectValue(value);
  const authority = objectValue(projection.authoritative);
  const layoutHash = authority.layout_hash === null
    ? null
    : normalizedSha256(authority.layout_hash);
  const expectedStatus = projection.kind === "pdf"
    ? "not_applicable_pdf"
    : authority.layout_retained === true
      ? "exact_geometry_available"
      : "evidence_only_geometry_unavailable";
  if (
    projection.schema !== retainedCaptureArtifactProjectionSchema
    || !new Set(["webpage", "pdf"]).has(projection.kind)
    || projection.localization_status !== expectedStatus
    || typeof authority.layout_retained !== "boolean"
    || !Number.isSafeInteger(authority.expansion_state_count)
    || authority.expansion_state_count < 0
    || (authority.layout_retained && !layoutHash)
    || (!authority.layout_retained && authority.layout_hash !== null)
    || (
      projection.kind === "pdf"
      && (authority.layout_retained || authority.expansion_state_count !== 0)
    )
  ) return null;
  return {
    schema: projection.schema,
    kind: projection.kind,
    localization_status: projection.localization_status,
    authoritative: {
      layout_retained: authority.layout_retained,
      layout_hash: layoutHash,
      expansion_state_count: authority.expansion_state_count,
    },
  };
}

function exactHashField(value, field, nullable, label) {
  if (!Object.hasOwn(objectValue(value), field)) {
    refuse(`semantic_${field}_missing`, `The ${label} semantic ${field} is absent.`);
  }
  if (nullable && value[field] === null) return null;
  return requiredSha256(value[field], `${label} ${field}`);
}

function valueAtPath(value, fieldPath) {
  return fieldPath.split(".").reduce((current, key) => current?.[key], value);
}

function capturePathForSlot(capture, slot) {
  const core = coreArtifactContract[capture?.kind]?.[slot];
  if (core) return valueAtPath(capture, core[0]);
  const match = cleanText(slot).match(/^expansion_state_(\d{2})(?:(_layout))?$/u);
  if (!match) return null;
  const index = Number(match[1]) - 1;
  const field = match[2] ? "layout_path" : "page_path";
  return capture?.expansion_state_screenshots?.[index]?.[field] || null;
}

function archiveCaptureRef(sourceId, capturedAt, fileName) {
  return `sources/${sourceId}/captures/${captureGeneration(capturedAt)}/${fileName}`;
}

function captureGeneration(value) {
  const parsed = Date.parse(cleanText(value));
  if (!Number.isFinite(parsed)) {
    refuse("capture_generation_timestamp_invalid", "The capture generation timestamp is invalid.");
  }
  return new Date(parsed).toISOString().replace(/[:.]/gu, "-");
}

function captureKind(value) {
  const kind = cleanText(value).toLowerCase();
  if (!new Set(["webpage", "pdf"]).has(kind)) {
    refuse("capture_kind_invalid", "The Stage 1 evidence upgrade capture kind is invalid.");
  }
  return kind;
}

function comparableUrl(value) {
  try {
    return normalizeSourceIntakeUrl(value);
  } catch {
    return null;
  }
}

function normalizedPath(value) {
  const path = cleanText(value).replace(/\\/gu, "/").replace(/\/{2,}/gu, "/");
  if (!path || path.includes("\u0000") || path.split("/").includes("..")) return "";
  return path.replace(/^\.\//u, "").replace(/\/$/u, "");
}

function normalizedSha256(value) {
  const hash = cleanText(value).toLowerCase();
  return sha256Pattern.test(hash) ? hash : null;
}

function requiredSha256(value, label) {
  const hash = normalizedSha256(value);
  if (!hash) refuse("sha256_invalid", `${label} must be an exact lowercase SHA-256.`);
  return hash;
}

function requiredNonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    refuse("length_invalid", `${label} must be a non-negative integer.`);
  }
  return value;
}

function requiredPositiveInteger(value, label) {
  const result = requiredNonNegativeInteger(value, label);
  if (result < 1) refuse("length_invalid", `${label} must be positive.`);
  return result;
}

function requiredText(value, label) {
  const text = cleanText(value);
  if (!text) refuse("required_text_missing", `${label} is required.`);
  return text;
}

function dedupeReasons(reasons) {
  return [...new Map(reasons.map((reason) => [reason.code, reason])).values()];
}

function sameJson(left, right) {
  return JSON.stringify(sortJson(left)) === JSON.stringify(sortJson(right));
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, sortJson(value[key])]),
  );
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function cleanText(value) {
  return String(value ?? "").replace(/\u0000/gu, "").trim();
}

function refuse(code, message) {
  throw new Stage1UpgradeValidationError(code, message);
}

function validationErrorCode(error) {
  return cleanText(error?.code) || "stage1_evidence_schema_upgrade_validation_failed";
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || "Unknown validation failure.");
}

function hashBytes(value) {
  return createHash("sha256").update(value).digest("hex");
}
