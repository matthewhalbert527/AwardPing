import { createHash } from "node:crypto";
import { normalizeSourceIntakeUrl } from "./source-intake.mjs";

export const STAGE1_BASELINE_ACTIVATION_BATCH_ID =
  "stage1-national-25-reviewed-sources-v1";
export const STAGE1_BASELINE_ACTIVATION_DISPOSITION_SCHEMA =
  "awardping.stage1.baseline-source-human-disposition.v1";
export const STAGE1_BASELINE_ACTIVATION_POLICY_VERSION =
  "stage1-baseline-source-disposition-v1";
export const STAGE1_BASELINE_ACTIVATION_GUARD_MODE =
  "first_visual_baseline_exact_normalized_retained_text";
export const STAGE1_BASELINE_ACTIVATION_VERIFICATION_SCHEMA =
  "awardping.stage1.first-visual-baseline-activation-verification.v1";
export const STAGE1_BASELINE_ACTIVATION_TEXT_NORMALIZATION =
  "source-intake-collapsed-whitespace-v1";
export const STAGE1_BASELINE_ACTIVATION_PENDING_REVIEW_NOTE =
  "approved_pending_exact_first_visual_baseline";
export const STAGE1_BASELINE_ACTIVATION_PENDING_REVIEWED_BY =
  "stage1-baseline-source-disposition";

const sha256Pattern = /^[0-9a-f]{64}$/;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const reviewedRoleSet = new Set([
  "identity_home",
  "eligibility",
  "application_materials",
  "dates_cycle",
  "funding",
  "faq",
  "selection_interviews",
  "current_documents",
]);
const dispositionKeys = [
  "activation_guard",
  "authority",
  "decision",
  "effective_source_review",
  "guard_sha256",
  "policy_version",
  "schema_version",
];
const activationGuardKeys = [
  "capture_file_sha256",
  "decision_item_sha256",
  "evidence_packet_sha256",
  "final_url",
  "mode",
  "normalized_retained_text_sha256",
  "notification_mode",
  "onboarding_batch_id",
  "retained_text_artifact",
  "shared_award_source_acquisition_id",
  "shared_award_source_id",
  "source_page_request_id",
];
const retainedTextArtifactKeys = [
  "bucket",
  "bytes",
  "key",
  "r2_verified_at",
  "sha256",
  "store_id",
];
const effectiveReviewKeys = [
  "confidence",
  "cycle_relevance",
  "evidence_quotes",
  "exact_evidence_verified",
  "facts",
  "officialness",
  "page_type",
  "reviewed_roles",
  "source_relevance",
  "status",
];
const factKeys = [
  "amount",
  "application_materials",
  "deadline",
  "description",
  "eligibility",
  "important_dates",
];
const authorityKeys = [
  "fact_candidates",
  "first_observation_notification",
  "monitoring",
  "public_facts",
  "publication",
  "reconciliation",
];
const persistenceEvidenceKeys = [
  "acquisition_id",
  "creates_api_charge",
  "guard_sha256",
  "local_baseline",
  "local_baseline_written",
  "observed_normalized_text_sha256",
  "persisted_at",
  "r2",
  "r2_sync_succeeded",
  "request_id",
  "schema_version",
  "source_id",
];
const localBaselineEvidenceKeys = [
  "activation_guard_sha256",
  "activation_status",
  "archive_relative_path",
  "capture_meta_path",
  "captured_at",
  "file_hash",
  "image_hash",
  "kind",
  "layout_hash",
  "normalized_text_sha256",
  "text_hash",
];
const r2PersistenceEvidenceKeys = [
  "activation_guard_sha256",
  "bucket",
  "latest_captured_at",
  "latest_hashes",
  "latest_object_keys",
  "uploaded_object_count",
];

export function isStage1BaselineActivationAcquisition(value) {
  const acquisition = objectValue(value);
  return Boolean(
    acquisition.id
      && acquisition.acquisition_kind === "historical_import"
      && acquisition.notification_mode === "baseline_only"
      && acquisition.onboarding_batch_id === STAGE1_BASELINE_ACTIVATION_BATCH_ID,
  );
}

export function isStage1PendingBaselineActivationSource(value) {
  const source = objectValue(value);
  return Boolean(
    isStage1BaselineActivationAcquisition(source.source_acquisition)
      && source.admin_review_status === "review_later"
      && source.admin_review_note === STAGE1_BASELINE_ACTIVATION_PENDING_REVIEW_NOTE
      && source.admin_reviewed_by === STAGE1_BASELINE_ACTIVATION_PENDING_REVIEWED_BY,
  );
}

export function normalizeStage1BaselineActivationText(value) {
  return String(value ?? "")
    .replace(/\u0000/g, "")
    .replace(/\s+/gu, " ")
    .trim();
}

export function normalizeStage1BaselineEvidenceWords(value) {
  // Word boundaries are inserted at lowercase-to-uppercase transitions BEFORE
  // case folding: the two extraction paths (intake HTML-to-text and browser
  // visual text) disagree about whitespace at block boundaries, so the same
  // page yields "Time.EligibilityAn applicant" on one side and
  // "Time.\nEligibility\nAn applicant" on the other. Splitting case-fused
  // tokens applies identically to the quote and to both texts, so a quote
  // whose words are genuinely absent still fails; only tokenization of the
  // same words stops mattering. (The churchill activation deadlocked on
  // exactly this: sealed quote 2 fused on the visual side, and the live
  // comparison text fuses quote 1 the other way.)
  return String(value ?? "")
    .replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2")
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function stage1BaselineActivationTextSha256(value) {
  return sha256(normalizeStage1BaselineActivationText(value));
}

export function stage1BaselineActivationPersistedTextIdentity({
  persistedText,
  capturedText,
} = {}) {
  if (
    typeof persistedText !== "string"
    || typeof capturedText !== "string"
    || persistedText !== `${capturedText}\n`
  ) {
    return null;
  }
  return {
    text_sha256: sha256(capturedText),
    normalized_text_sha256: stage1BaselineActivationTextSha256(capturedText),
  };
}

export function stage1BaselineActivationGuardSha256(value) {
  const disposition = objectValue(value);
  const { guard_sha256: ignored, ...basis } = disposition;
  void ignored;
  return sha256(canonicalJson(basis));
}

export function evaluateStage1FirstVisualBaselineActivation({
  acquisition,
  capture,
  retainedComparisonCapture = null,
  sourceId = null,
  verifiedAt = new Date().toISOString(),
  bindingOnly = false,
} = {}) {
  if (!isStage1BaselineActivationAcquisition(acquisition)) {
    return {
      applies: false,
      allowed: true,
      status: "not_applicable",
      reason: "not_stage1_reviewed_baseline_only_acquisition",
      verification: null,
    };
  }

  const sourceAcquisition = objectValue(acquisition);
  const reviewSeal = objectValue(sourceAcquisition.review_seal);
  const disposition = objectValue(reviewSeal.human_source_disposition);
  const guard = objectValue(disposition.activation_guard);
  const effectiveReview = objectValue(disposition.effective_source_review);
  const authority = objectValue(disposition.authority);
  const retainedTextArtifact = objectValue(guard.retained_text_artifact);
  const requestId = cleanText(sourceAcquisition.origin_source_page_request_id);
  const acquisitionId = cleanText(sourceAcquisition.id);
  const sharedAwardSourceId = cleanText(sourceAcquisition.shared_award_source_id);
  const expectedHash = cleanText(guard.normalized_retained_text_sha256);
  const observedText = typeof retainedComparisonCapture?.text === "string"
    ? retainedComparisonCapture.text
    : null;
  const observedHash = observedText === null
    ? null
    : stage1BaselineActivationTextSha256(observedText);
  const guardSha256 = stage1BaselineActivationGuardSha256(disposition);

  const fail = (reason, detail) => ({
    applies: true,
    allowed: false,
    status: "quarantine_required",
    reason,
    detail,
    expected_normalized_text_sha256: sha256Pattern.test(expectedHash) ? expectedHash : null,
    observed_normalized_text_sha256: observedHash,
    guard_sha256: guardSha256,
    verification: null,
  });

  if (!Object.keys(disposition).length) {
    return fail(
      "stage1_baseline_activation_disposition_missing",
      "The acquisition does not carry its reviewed human source disposition.",
    );
  }
  if (!hasExactKeys(disposition, dispositionKeys)) {
    return fail(
      "stage1_baseline_activation_disposition_keys_invalid",
      "The human source disposition does not have the exact reviewed key set.",
    );
  }
  if (
    disposition.schema_version !== STAGE1_BASELINE_ACTIVATION_DISPOSITION_SCHEMA
      || disposition.policy_version !== STAGE1_BASELINE_ACTIVATION_POLICY_VERSION
  ) {
    return fail(
      "stage1_baseline_activation_disposition_schema_invalid",
      "The acquisition carries an unsupported human source disposition schema.",
    );
  }
  if (disposition.decision !== "approve_baseline_only") {
    return fail(
      "stage1_baseline_activation_disposition_not_approved",
      "The human source disposition does not approve baseline-only activation.",
    );
  }
  if (
    !sha256Pattern.test(cleanText(disposition.guard_sha256))
      || disposition.guard_sha256 !== guardSha256
  ) {
    return fail(
      "stage1_baseline_activation_guard_sha256_mismatch",
      "The human source disposition does not match its canonical guard SHA-256.",
    );
  }
  if (
    !hasExactKeys(authority, authorityKeys)
      || authority.monitoring !== true
      || authority.public_facts !== false
      || authority.fact_candidates !== false
      || authority.reconciliation !== false
      || authority.publication !== false
      || authority.first_observation_notification !== false
  ) {
    return fail(
      "stage1_baseline_activation_authority_invalid",
      "Baseline-only approval must explicitly deny fact, reconciliation, publication, and notification authority.",
    );
  }
  if (
    !hasExactKeys(guard, activationGuardKeys)
      || guard.mode !== STAGE1_BASELINE_ACTIVATION_GUARD_MODE
      || guard.onboarding_batch_id !== STAGE1_BASELINE_ACTIVATION_BATCH_ID
      || guard.notification_mode !== "baseline_only"
      || !uuidPattern.test(cleanText(guard.source_page_request_id))
      || guard.source_page_request_id !== requestId
      || !uuidPattern.test(cleanText(guard.shared_award_source_id))
      || !uuidPattern.test(cleanText(guard.shared_award_source_acquisition_id))
      || !sha256Pattern.test(cleanText(guard.evidence_packet_sha256))
      || !sha256Pattern.test(cleanText(guard.decision_item_sha256))
      || !sha256Pattern.test(expectedHash)
      || !sha256Pattern.test(cleanText(guard.capture_file_sha256))
      || !isExactHttpsUrl(guard.final_url)
  ) {
    return fail(
      "stage1_baseline_activation_guard_binding_malformed",
      "The reviewed activation guard is missing an exact request, URL, or retained artifact hash binding.",
    );
  }
  if (
    !uuidPattern.test(acquisitionId)
      || !uuidPattern.test(requestId)
      || (sourceId && sharedAwardSourceId !== cleanText(sourceId))
      || guard.shared_award_source_id !== sharedAwardSourceId
      || guard.shared_award_source_acquisition_id !== acquisitionId
  ) {
    return fail(
      "stage1_baseline_activation_acquisition_binding_mismatch",
      "The source, request, and acquisition identity binding is incomplete or inconsistent.",
    );
  }
  if (
    cleanText(reviewSeal.source_page_request_id) !== requestId
      || cleanText(reviewSeal.capture_file_hash) !== guard.capture_file_sha256
      || cleanText(reviewSeal.capture_final_url) !== guard.final_url
  ) {
    return fail(
      "stage1_baseline_activation_review_seal_mismatch",
      "The human activation guard differs from the acquisition's immutable review seal.",
    );
  }
  if (!validRetainedTextArtifact(retainedTextArtifact, { requestId, guard })) {
    return fail(
      "stage1_baseline_activation_retained_text_artifact_invalid",
      "The activation guard does not contain an exact immutable R2 retained-text binding.",
    );
  }
  if (!validEffectiveReview(effectiveReview)) {
    return fail(
      "stage1_baseline_activation_effective_review_invalid",
      "The approved effective source review is incomplete or carries fact-publication content.",
    );
  }
  if (bindingOnly) {
    return {
      applies: true,
      allowed: true,
      status: "exact_binding_verified_capture_required",
      reason: "stage1_baseline_activation_exact_binding_verified",
      expected_normalized_text_sha256: expectedHash,
      observed_normalized_text_sha256: null,
      guard_sha256: guardSha256,
      verification: null,
    };
  }
  if (observedText === null) {
    return fail(
      "stage1_baseline_activation_intake_comparison_capture_missing",
      "The free deterministic intake comparison capture has no text to verify against retained review evidence.",
    );
  }
  if (retainedComparisonCapture?.ok === false) {
    return fail(
      "stage1_baseline_activation_intake_comparison_capture_failed",
      "The free deterministic intake comparison capture returned a non-success response.",
    );
  }
  const reviewedUrl = normalizedComparableUrl(guard.final_url);
  const comparisonUrl = normalizedComparableUrl(
    retainedComparisonCapture?.canonical_url || retainedComparisonCapture?.final_url,
  );
  const visualUrl = normalizedComparableUrl(capture?.final_url);
  if (!reviewedUrl || comparisonUrl !== reviewedUrl || visualUrl !== reviewedUrl) {
    return fail(
      "stage1_baseline_activation_final_url_mismatch",
      "The visual or deterministic intake comparison capture resolved to a different reviewed URL.",
    );
  }
  if (observedHash !== expectedHash) {
    return fail(
      "stage1_baseline_activation_normalized_text_hash_mismatch",
      "The deterministic intake comparison text differs from the exact human-reviewed retained text.",
    );
  }
  const retainedEvidence = exactVisualEvidenceQuotePresence({
    visualText: retainedComparisonCapture.text,
    evidenceQuotes: effectiveReview.evidence_quotes,
  });
  if (!retainedEvidence.ok) {
    return fail(
      "stage1_baseline_activation_retained_evidence_quotes_missing",
      `The deterministic intake comparison omits ${retainedEvidence.missing_count} complete reviewed evidence quote(s).`,
    );
  }
  const visualEvidence = exactVisualEvidenceQuotePresence({
    visualText: capture?.text,
    evidenceQuotes: effectiveReview.evidence_quotes,
  });
  if (!visualEvidence.ok) {
    return fail(
      "stage1_baseline_activation_visual_evidence_quotes_missing",
      `The visual baseline omits ${visualEvidence.missing_count} complete reviewed evidence quote(s).`,
    );
  }

  const verification = {
    schema_version: STAGE1_BASELINE_ACTIVATION_VERIFICATION_SCHEMA,
    status: "exact_hash_verified_pending_server_receipt",
    verified_at: requiredTimestamp(verifiedAt),
    mode: STAGE1_BASELINE_ACTIVATION_GUARD_MODE,
    text_normalization: STAGE1_BASELINE_ACTIVATION_TEXT_NORMALIZATION,
    onboarding_batch_id: STAGE1_BASELINE_ACTIVATION_BATCH_ID,
    shared_award_source_id: sharedAwardSourceId || cleanText(sourceId) || null,
    source_acquisition_id: acquisitionId,
    source_page_request_id: requestId,
    disposition_schema_version: disposition.schema_version,
    disposition_decision: disposition.decision,
    expected_normalized_text_sha256: expectedHash,
    observed_normalized_text_sha256: observedHash,
    comparison_capture_method: cleanText(retainedComparisonCapture.capture_method) || null,
    evidence_packet_sha256: guard.evidence_packet_sha256,
    decision_item_sha256: guard.decision_item_sha256,
    retained_text_artifact: retainedTextArtifact,
    capture_file_sha256: guard.capture_file_sha256,
    reviewed_final_url: guard.final_url,
    observed_final_url: capture.final_url,
    comparison_final_url:
      retainedComparisonCapture.canonical_url || retainedComparisonCapture.final_url,
    visual_evidence_quote_count: visualEvidence.quote_count,
    visual_evidence_quotes_verified: true,
    retained_evidence_quotes_verified: true,
    guard_sha256: guardSha256,
    authority: {
      monitoring: true,
      public_facts: false,
      fact_candidates: false,
      reconciliation: false,
      publication: false,
      first_observation_notification: false,
    },
  };
  return {
    applies: true,
    allowed: true,
    status: "exact_hash_verified_pending_server_receipt",
    reason: "stage1_baseline_activation_exact_hash_verified",
    expected_normalized_text_sha256: expectedHash,
    observed_normalized_text_sha256: observedHash,
    guard_sha256: guardSha256,
    verification,
  };
}

export function buildStage1BaselineActivationRecordRpcArgs({
  sourceId,
  acquisition,
  evaluation,
} = {}) {
  if (!evaluation?.applies || !evaluation?.allowed || !evaluation?.verification) {
    throw new Error("A successful Stage 1 activation evaluation is required for its server receipt.");
  }
  return {
    p_source_id: requiredUuid(sourceId, "source id"),
    p_acquisition_id: requiredUuid(acquisition?.id, "acquisition id"),
    p_observed_normalized_text_sha256: requiredSha256(
      evaluation.observed_normalized_text_sha256,
      "observed normalized text SHA-256",
    ),
    p_guard_sha256: requiredSha256(evaluation.guard_sha256, "activation guard SHA-256"),
  };
}

export function stage1BaselineActivationReceipt(data, evaluation) {
  const value = Array.isArray(data) && data.length === 1 ? data[0] : data;
  const receipt = objectValue(value);
  const allowed = receipt.allowed === true
    && sha256Pattern.test(cleanText(receipt.prepare_receipt_sha256));
  if (!allowed) {
    return {
      allowed: false,
      reason: "stage1_baseline_activation_server_receipt_not_allowed",
      server_reason: cleanText(receipt.reason) || null,
      receipt: value ?? null,
      verification: null,
    };
  }
  return {
    allowed: true,
    reason: "stage1_baseline_activation_server_prepare_recorded",
    receipt,
    verification: {
      ...evaluation.verification,
      status: "server_prepare_recorded",
      server_prepare_receipt: receipt,
    },
  };
}

export function buildStage1BaselineActivationFinalizeRpcArgs({
  sourceId,
  acquisition,
  evaluation,
  prepareReceipt,
  persistenceEvidence,
} = {}) {
  const receipt = objectValue(prepareReceipt);
  const evidence = objectValue(persistenceEvidence);
  if (!evaluation?.applies || !evaluation?.allowed) {
    throw new Error("A successful Stage 1 activation evaluation is required for finalization.");
  }
  const canonicalSourceId = requiredUuid(sourceId, "source id");
  const canonicalAcquisitionId = requiredUuid(acquisition?.id, "acquisition id");
  if (!validPersistenceEvidence(evidence, {
    sourceId: canonicalSourceId,
    acquisitionId: canonicalAcquisitionId,
    requestId: acquisition?.origin_source_page_request_id,
    guardSha256: evaluation.guard_sha256,
    observedTextSha256: evaluation.observed_normalized_text_sha256,
  })) {
    throw new Error("Stage 1 activation finalization requires exact local and R2 persistence evidence.");
  }
  return {
    p_source_id: canonicalSourceId,
    p_acquisition_id: canonicalAcquisitionId,
    p_observed_normalized_text_sha256: requiredSha256(
      evaluation.observed_normalized_text_sha256,
      "observed normalized text SHA-256",
    ),
    p_guard_sha256: requiredSha256(evaluation.guard_sha256, "activation guard SHA-256"),
    p_prepare_receipt_sha256: requiredSha256(
      receipt.prepare_receipt_sha256,
      "prepare receipt SHA-256",
    ),
    p_persistence_evidence: evidence,
  };
}

export function stage1BaselineActivationFinalizationReceipt(data) {
  const value = Array.isArray(data) && data.length === 1 ? data[0] : data;
  const receipt = objectValue(value);
  if (
    receipt.allowed !== true
      || !sha256Pattern.test(cleanText(receipt.finalization_receipt_sha256))
  ) {
    return {
      allowed: false,
      reason: "stage1_baseline_activation_server_finalization_not_allowed",
      server_reason: cleanText(receipt.reason) || null,
      receipt: value ?? null,
    };
  }
  return {
    allowed: true,
    reason: "stage1_baseline_activation_server_finalized",
    receipt,
  };
}

export function buildStage1BaselineActivationFailureRpcArgs({
  sourceId,
  acquisition,
  evaluation,
  capture,
  retainedComparisonCapture = null,
  failureStage = "first_visual_baseline_guard",
  persistenceState = null,
} = {}) {
  if (!evaluation?.applies || evaluation?.allowed) {
    throw new Error("A failed Stage 1 activation evaluation is required for quarantine persistence.");
  }
  const persistence = objectValue(persistenceState);
  const canonicalSourceId = requiredUuid(sourceId, "source id");
  const canonicalAcquisitionId = requiredUuid(acquisition?.id, "acquisition id");
  const boundPersistenceEvidence =
    validPersistenceEvidence(persistence, {
      sourceId: canonicalSourceId,
      acquisitionId: canonicalAcquisitionId,
      requestId: acquisition?.origin_source_page_request_id,
      guardSha256: evaluation.guard_sha256,
      observedTextSha256: evaluation.observed_normalized_text_sha256,
    })
      ? persistence
      : null;
  return {
    p_source_id: canonicalSourceId,
    p_acquisition_id: canonicalAcquisitionId,
    p_request_id: requiredUuid(
      acquisition?.origin_source_page_request_id,
      "source page request id",
    ),
    p_reason_code: requiredReason(evaluation.reason),
    p_evidence: {
      schema_version: "awardping.stage1.baseline-activation-failure-evidence.v1",
      failure_stage: cleanText(failureStage) || "first_visual_baseline_guard",
      detail: cleanText(evaluation.detail) || null,
      expected_normalized_text_sha256:
        evaluation.expected_normalized_text_sha256 || null,
      observed_normalized_text_sha256:
        evaluation.observed_normalized_text_sha256 || null,
      guard_sha256: evaluation.guard_sha256 || null,
      observed_final_url: cleanText(capture?.final_url) || null,
      observed_visual_text_sha256: typeof capture?.text === "string"
        ? stage1BaselineActivationTextSha256(capture.text)
        : null,
      observed_comparison_final_url: cleanText(
        retainedComparisonCapture?.canonical_url || retainedComparisonCapture?.final_url,
      ) || null,
      observed_comparison_text_sha256:
        typeof retainedComparisonCapture?.text === "string"
          ? stage1BaselineActivationTextSha256(retainedComparisonCapture.text)
          : null,
      creates_api_charge: false,
      public_event_created: false,
      baseline_written: persistence.local_baseline_written === true,
      r2_sync_succeeded: persistence.r2_sync_succeeded === true,
      persistence_evidence: boundPersistenceEvidence,
      baseline_facts_requested: false,
      safe_action:
        "Compare the retained review artifact with this first visual capture, then issue a new exact human disposition before retrying.",
    },
  };
}

function validEffectiveReview(value) {
  if (!hasExactKeys(value, effectiveReviewKeys)) return false;
  if (value.status !== "accepted") return false;
  if (!new Set(["primary", "supporting"]).has(value.source_relevance)) return false;
  if (!new Set(["official", "likely_official"]).has(value.officialness)) return false;
  if (!new Set(["medium", "high"]).has(value.confidence)) return false;
  const roles = Array.isArray(value.reviewed_roles) ? value.reviewed_roles : [];
  if (!roles.length || roles.some((role) => !reviewedRoleSet.has(role))) return false;
  const quotes = Array.isArray(value.evidence_quotes) ? value.evidence_quotes : [];
  if (
    value.exact_evidence_verified !== true
      || !quotes.length
      || quotes.some((quote) => !cleanText(quote))
  ) return false;
  const facts = objectValue(value.facts);
  return (
    hasExactKeys(facts, factKeys)
      && facts.description === null
      && facts.deadline === null
      && facts.amount === null
      && emptyArray(facts.eligibility)
      && emptyArray(facts.application_materials)
      && emptyArray(facts.important_dates)
  );
}

function validPersistenceEvidence(value, {
  sourceId,
  acquisitionId,
  requestId,
  guardSha256,
  observedTextSha256,
}) {
  if (!hasExactKeys(value, persistenceEvidenceKeys)) return false;
  const local = objectValue(value.local_baseline);
  const r2 = objectValue(value.r2);
  const r2Hashes = objectValue(r2.latest_hashes);
  const r2Keys = objectValue(r2.latest_object_keys);
  const canonicalRequestId = cleanText(requestId);
  const canonicalGuardSha256 = cleanText(guardSha256);
  const canonicalObservedHash = cleanText(observedTextSha256);
  return Boolean(
    value.schema_version === "awardping.stage1.baseline-activation-persistence-evidence.v3"
      && value.source_id === sourceId
      && value.acquisition_id === acquisitionId
      && uuidPattern.test(canonicalRequestId)
      && value.request_id === canonicalRequestId
      && sha256Pattern.test(canonicalGuardSha256)
      && value.guard_sha256 === canonicalGuardSha256
      && sha256Pattern.test(canonicalObservedHash)
      && value.observed_normalized_text_sha256 === canonicalObservedHash
      && Number.isFinite(Date.parse(cleanText(value.persisted_at)))
      && value.local_baseline_written === true
      && value.r2_sync_succeeded === true
      && value.creates_api_charge === false
      && hasExactKeys(local, localBaselineEvidenceKeys)
      && cleanText(local.archive_relative_path)
      && cleanText(local.capture_meta_path)
      && Number.isFinite(Date.parse(cleanText(local.captured_at)))
      && cleanText(local.kind)
      && sha256Pattern.test(cleanText(local.text_hash))
      && sha256Pattern.test(cleanText(local.normalized_text_sha256))
      && sha256Pattern.test(cleanText(local.image_hash))
      && (local.file_hash === null || sha256Pattern.test(cleanText(local.file_hash)))
      && (local.layout_hash === null || sha256Pattern.test(cleanText(local.layout_hash)))
      && local.activation_guard_sha256 === canonicalGuardSha256
      && local.activation_status === "server_prepare_recorded"
      && hasExactKeys(r2, r2PersistenceEvidenceKeys)
      && cleanText(r2.bucket)
      && r2.latest_captured_at === local.captured_at
      && Object.keys(r2Keys).length > 0
      && cleanText(r2Keys.text)
      && r2Hashes.text_hash === local.text_hash
      && r2Hashes.image_hash === local.image_hash
      && r2.activation_guard_sha256 === canonicalGuardSha256
      && Number.isSafeInteger(r2.uploaded_object_count)
      && r2.uploaded_object_count > 0
  );
}

function validRetainedTextArtifact(value, { requestId, guard }) {
  if (!hasExactKeys(value, retainedTextArtifactKeys)) return false;
  const expectedKey =
    `source-intake-first-observation/v1/requests/${requestId}/sha256/` +
    `${guard.capture_file_sha256}/text.txt`;
  return Boolean(
    cleanText(value.store_id)
      && cleanText(value.bucket)
      && value.key === expectedKey
      && sha256Pattern.test(cleanText(value.sha256))
      && Number.isSafeInteger(value.bytes)
      && value.bytes > 0
      && Number.isFinite(Date.parse(cleanText(value.r2_verified_at)))
  );
}

function exactVisualEvidenceQuotePresence({ visualText, evidenceQuotes }) {
  const visualWords = normalizeStage1BaselineEvidenceWords(visualText);
  const quotes = Array.isArray(evidenceQuotes) ? evidenceQuotes : [];
  const missing = quotes.filter((quote) => {
    const quoteWords = normalizeStage1BaselineEvidenceWords(quote);
    return !quoteWords || !` ${visualWords} `.includes(` ${quoteWords} `);
  });
  return {
    ok: quotes.length > 0 && missing.length === 0,
    quote_count: quotes.length,
    missing_count: missing.length,
  };
}

function normalizedComparableUrl(value) {
  try {
    return normalizeSourceIntakeUrl(value);
  } catch {
    return null;
  }
}

function emptyArray(value) {
  return Array.isArray(value) && value.length === 0;
}

function canonicalJson(value) {
  return JSON.stringify(sortJson(value));
}

function hasExactKeys(value, keys) {
  const actual = Object.keys(objectValue(value)).sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortJson(value[key])]),
  );
}

function sha256(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function cleanText(value) {
  return String(value ?? "").replace(/\u0000/g, "").trim();
}

function requiredUuid(value, label) {
  const clean = cleanText(value);
  if (!uuidPattern.test(clean)) throw new Error(`Stage 1 activation ${label} must be a UUID.`);
  return clean;
}

function requiredSha256(value, label) {
  const clean = cleanText(value);
  if (!sha256Pattern.test(clean)) {
    throw new Error(`Stage 1 activation ${label} must be a lowercase SHA-256.`);
  }
  return clean;
}

function requiredReason(value) {
  const clean = cleanText(value).toLowerCase();
  if (!/^stage1_baseline_activation_[a-z0-9_]+$/.test(clean)) {
    throw new Error("Stage 1 activation failure reason is invalid.");
  }
  return clean;
}

function requiredTimestamp(value) {
  const parsed = Date.parse(cleanText(value));
  if (!Number.isFinite(parsed)) throw new Error("Stage 1 activation verification time is invalid.");
  return new Date(parsed).toISOString();
}

function isExactHttpsUrl(value) {
  const clean = cleanText(value);
  try {
    const parsed = new URL(clean);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password && parsed.hash === "";
  } catch {
    return false;
  }
}
