import { createHash } from "node:crypto";
import {
  evaluateStage1FirstVisualBaselineActivation,
  stage1BaselineActivationTextSha256,
} from "./stage1-baseline-activation-guard.mjs";
import {
  canonicalPreciseRfc3339,
  comparePreciseRfc3339,
} from "./monitoring-feedback-promotion-verification.mjs";
import {
  assertR2CaptureArtifactSlots,
  r2CaptureArtifactBindingsSchema,
} from "./r2-capture-artifact-bindings.mjs";
import {
  assertStage1EvidenceSchemaUpgradeR2BindingReceipt,
} from "./stage1-evidence-schema-upgrade-r2-binding.mjs";
import {
  assertStage1EvidenceSchemaUpgradeCompletedAuthorityAuditInspection,
} from "./stage1-evidence-schema-upgrade-reviewed-apply-audit.mjs";
import {
  stage1EvidenceSchemaUpgradeReviewedApplyTransactionId,
} from "./stage1-evidence-schema-upgrade-reviewed-apply-execution.mjs";
import {
  classifyStage1EvidenceSchemaUpgradeSourceHealthAuthority,
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_SOURCE_HEALTH_AUTHORITY_COLUMNS,
} from "./stage1-evidence-schema-upgrade-reviewed-source-authority.mjs";
import {
  assertStage1EvidenceSchemaUpgradeJournal,
  assertStage1EvidenceSchemaUpgradeReviewedOperationBinding,
  proveStage1EvidenceSchemaUpgradeArchivedCompletion,
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_JOURNAL_SCHEMA,
} from "./stage1-evidence-schema-upgrade-transaction.mjs";
import {
  visualSnapshotPointerIdentity,
} from "./visual-snapshot-latest-only-reconciliation.mjs";

export const STAGE1_EVIDENCE_SCHEMA_UPGRADE_COMPLETED_AUTHORITY_PROVENANCE_SCHEMA =
  "awardping.stage1.evidence-schema-upgrade-capture-provenance.v1";

export const STAGE1_EVIDENCE_SCHEMA_UPGRADE_COMPLETED_AUTHORITY_RECEIPT_SCHEMA =
  "awardping.stage1.evidence-schema-upgrade-completed-authority-receipt.v1";

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const PROVENANCE_KEYS = Object.freeze([
  "creates_api_charge",
  "existing_r2_binding_receipt",
  "manifest_sha256",
  "prior_recovery_receipt",
  "public_fact_authority",
  "recorded_at",
  "schema_version",
  "source_id",
  "validation",
  "validation_sha256",
  "worker_run_id",
]);

const VALIDATION_KEYS = Object.freeze(["decision", "evidence", "reason", "reasons"]);

const ARTIFACT_KEYS = Object.freeze([
  "binding",
  "body",
  "contentType",
  "fileName",
  "name",
  "path",
]);

const ARTIFACT_BINDING_KEYS = Object.freeze([
  "byte_length",
  "content_type",
  "hash_mode",
  "sha256",
]);

const CURRENT_R2_RECEIPT_KEYS = Object.freeze([
  "artifact_binding_verification",
  "captured_at",
  "creates_api_charge",
  "kind",
  "limitations",
  "mutation_performed",
  "pointer_identity",
  "previous_pointer",
  "receipt_sha256",
  "schema",
  "semantic_text",
  "source_id",
  "status",
  "verified_roles",
]);

const CURRENT_R2_POINTER_IDENTITY_KEYS = Object.freeze([
  "bucket",
  "immutable_generation",
  "kind",
  "latest_captured_at",
  "latest_hashes",
  "latest_metadata_sha256",
  "latest_object_keys",
  "pointer_sha256",
  "shared_award_source_id",
]);

const CURRENT_R2_PREVIOUS_POINTER_KEYS = Object.freeze([
  "preserved",
  "previous_captured_at",
  "previous_hashes",
  "previous_metadata",
  "previous_object_keys",
  "projection_sha256",
  "verification_scope",
]);

const CURRENT_R2_VERIFIED_ROLE_KEYS = Object.freeze([
  "byte_length",
  "content_type",
  "key",
  "remote_body_verified",
  "role",
  "sha256",
]);

const RECEIPT_KEYS = Object.freeze([
  "acquisition_guard_sha256",
  "acquisition_id",
  "acquisition_normalized_text_sha256",
  "archive_proof_sha256",
  "audit_inspection_sha256",
  "authority",
  "capture_performed",
  "captured_at",
  "creates_api_charge",
  "current_baseline_sha256",
  "current_pointer_sha256",
  "current_r2_binding_receipt_sha256",
  "finalization_receipt_sha256",
  "finalized_at",
  "journal_sha256",
  "kind",
  "manifest_sha256",
  "mutation_performed",
  "operation_binding_sha256",
  "provenance_validation_sha256",
  "public_fact_authority",
  "receipt_sha256",
  "schema_version",
  "semantic_scope",
  "source_health_authority_sha256",
  "source_id",
  "status",
  "transaction_id",
]);

const POINTER_HASH_KEYS = Object.freeze([
  "body_text_hash",
  "expansion_hash",
  "file_hash",
  "image_hash",
  "layout_hash",
  "main_content_hash",
  "nav_header_footer_hash",
  "text_hash",
]);

const WEB_SEMANTIC_FIELDS = Object.freeze([
  ["text_hash", "text_length"],
  ["body_text_hash", "body_text_length"],
  ["main_content_hash", "main_content_text_length"],
  ["nav_header_footer_hash", "nav_header_footer_text_length"],
  ["expansion_hash", "expansion_text_length"],
  ["expandable_sections_hash", null],
]);

const FINALIZATION_RECEIPT_KEYS = Object.freeze([
  "creates_api_charge",
  "decision_item_sha256",
  "finalized_at",
  "guard_sha256",
  "observed_normalized_text_sha256",
  "persistence_evidence_sha256",
  "prepare_receipt_sha256",
  "public_fact_authority",
  "schema_version",
  "shared_award_source_id",
  "source_acquisition_id",
  "source_page_request_id",
  "status",
]);

class CompletedAuthorityRefusal extends Error {
  constructor(code, evidence = null) {
    super(code);
    this.name = "CompletedAuthorityRefusal";
    this.code = code;
    this.evidence = evidence;
  }
}

/**
 * Read-only post-commit classification for one reviewed Stage 1 evidence
 * upgrade. All filesystem, database, and R2 reads happen in the caller. This
 * evaluator can neither capture nor mutate and every result states that fact.
 */
export function evaluateStage1EvidenceSchemaUpgradeCompletedAuthority(input = {}) {
  const hints = completedAuthorityProvenanceHints(input);
  if (!hints.present) {
    return completedAuthorityResult({
      applies: false,
      accepted: false,
      reason: "completed_authority_provenance_absent",
      evidence: null,
      receipt: null,
    });
  }

  try {
    return verifyCompletedAuthority(input, hints);
  } catch (error) {
    return completedAuthorityResult({
      applies: true,
      accepted: false,
      reason: error instanceof CompletedAuthorityRefusal
        ? error.code
        : "completed_authority_unexpected_evidence_invalid",
      evidence: error instanceof CompletedAuthorityRefusal ? error.evidence : null,
      receipt: null,
    });
  }
}

export function assertStage1EvidenceSchemaUpgradeCompletedAuthorityReceipt(value) {
  const receipt = exactObject(value, RECEIPT_KEYS, "completed authority receipt");
  const authority = exactObject(
    receipt.authority,
    ["capture", "mutation", "validation_only"],
    "completed authority receipt authority",
  );
  if (
    receipt.schema_version !== STAGE1_EVIDENCE_SCHEMA_UPGRADE_COMPLETED_AUTHORITY_RECEIPT_SCHEMA
    || receipt.status !== "verified"
    || !new Set([
      "full_normalized_text",
      "main_content_only",
      "pdf_exact_file_and_sealed_text",
    ]).has(receipt.semantic_scope)
    || receipt.mutation_performed !== false
    || receipt.capture_performed !== false
    || receipt.creates_api_charge !== false
    || receipt.public_fact_authority !== false
    || authority.validation_only !== true
    || authority.capture !== false
    || authority.mutation !== false
  ) {
    throw new Error("Completed authority receipt safety contract is invalid.");
  }

  requiredUuid(receipt.source_id, "completed authority source_id");
  if (!new Set(["webpage", "pdf"]).has(receipt.kind)) {
    throw new Error("Completed authority receipt kind is invalid.");
  }
  requiredUuid(receipt.transaction_id, "completed authority transaction_id");
  requiredTimestamp(receipt.captured_at, "completed authority captured_at");
  requiredPreciseTimestamp(receipt.finalized_at, "completed authority finalized_at");
  for (const key of RECEIPT_KEYS.filter((key) => key.endsWith("_sha256"))) {
    if (key !== "receipt_sha256") {
      requiredSha256(receipt[key], `completed authority ${key}`);
    }
  }
  requiredUuid(receipt.acquisition_id, "completed authority acquisition_id");
  const content = cloneJson(receipt);
  delete content.receipt_sha256;
  if (receipt.receipt_sha256 !== sha256Json(content)) {
    throw new Error("Completed authority receipt seal is invalid.");
  }
  return deepFreeze(cloneJson(receipt));
}

function verifyCompletedAuthority(input, hints) {
  if (input.activeJournal !== null) {
    refuse("completed_authority_active_journal_present");
  }
  const sourceId = requireOrRefuse(
    () => requiredUuid(input.sourceId, "completed authority sourceId"),
    "completed_authority_source_identity_invalid",
  );
  const expectedManifestSha256 = requireOrRefuse(
    () => requiredSha256(
      input.expectedManifestSha256,
      "completed authority expected manifest SHA-256",
    ),
    "completed_authority_manifest_identity_invalid",
  );
  const source = plainObject(input.source)
    ? input.source
    : refuse("completed_authority_source_missing");
  if (source.id !== sourceId) refuse("completed_authority_source_identity_mismatch");

  const baselineBytes = requireOrRefuse(
    () => exactBytes(input.currentBaselineBytes, "current baseline bytes"),
    "completed_authority_current_baseline_bytes_invalid",
  );
  const parsedBaseline = parseJsonBytes(
    baselineBytes,
    "completed_authority_current_baseline_bytes_invalid",
  );
  const baseline = plainObject(input.currentBaseline)
    ? input.currentBaseline
    : refuse("completed_authority_current_baseline_missing");
  if (!sameJson(parsedBaseline, baseline)) {
    refuse("completed_authority_current_baseline_bytes_disagree");
  }
  const capture = plainObject(input.currentCapture)
    ? input.currentCapture
    : refuse("completed_authority_current_capture_missing");
  const pointer = plainObject(input.currentR2Pointer)
    ? input.currentR2Pointer
    : refuse("completed_authority_current_pointer_missing");
  const prepared = validatePreparedArtifacts(input.currentPreparedArtifacts);

  const provenance = requireIdenticalProvenance({
    baseline: hints.baseline,
    capture: hints.capture,
    meta: prepared.meta.object.stage1_evidence_schema_upgrade,
    pointer: hints.pointer,
  });
  validateProvenanceEnvelope(provenance, { sourceId, expectedManifestSha256 });

  const acquisitionAuthority = validateAcquisitionAndActivation({
    source,
    sourceId,
    baseline,
    capture,
    pointer,
    meta: prepared.meta.object,
  });
  const semanticScope = validatePriorEligibleValidation({
    validation: provenance.validation,
    provenance,
    sourceId,
    baseline,
    capture,
    prepared,
    acquisitionAuthority,
  });
  validateCurrentCandidateIdentity({
    sourceId,
    baseline,
    capture,
    pointer,
    prepared,
  });
  const currentR2Receipt = validateCurrentR2Receipt({
    receipt: input.verifiedR2BindingReceipt,
    sourceId,
    capture,
    pointer,
    prepared,
  });

  const audit = validateAuditInspection({
    inspection: input.terminalAuditInspection,
    provenance,
    sourceId,
    expectedManifestSha256,
  });
  if (
    comparePreciseRfc3339(
      acquisitionAuthority.finalization.finalized_at,
      audit.started_at,
    ) > 0
  ) {
    refuse("completed_authority_finalization_after_audit_started");
  }
  const expectedTransactionId = completedAuthorityTransactionId(audit);
  const journalAuthority = validateCompletedJournalAndProof({
    journal: input.completedJournal,
    archiveProof: input.completedJournalArchiveProof,
    baselineBytes,
    pointer,
    audit,
    sourceId,
    expectedTransactionId,
  });
  const sourceAuthority = validateLiveSourceAuthority({
    source,
    sourceHealth: input.sourceHealth,
    sourceId,
    baselineBytes,
    operationBinding: journalAuthority.operationBinding,
  });

  const acquisition = acquisitionAuthority.acquisition;
  const finalization = acquisitionAuthority.finalization;
  const pointerIdentity = visualSnapshotPointerIdentity(pointer);
  const receiptContent = {
    schema_version: STAGE1_EVIDENCE_SCHEMA_UPGRADE_COMPLETED_AUTHORITY_RECEIPT_SCHEMA,
    status: "verified",
    source_id: sourceId,
    kind: capture.kind,
    captured_at: capture.captured_at,
    transaction_id: expectedTransactionId,
    manifest_sha256: expectedManifestSha256,
    provenance_validation_sha256: provenance.validation_sha256,
    current_baseline_sha256: sha256Bytes(baselineBytes),
    current_pointer_sha256: pointerIdentity.canonical_sha256,
    current_r2_binding_receipt_sha256: currentR2Receipt.receipt_sha256,
    audit_inspection_sha256: audit.inspection_sha256,
    journal_sha256: input.completedJournal.journal_sha256,
    operation_binding_sha256: journalAuthority.operationBinding.binding_sha256,
    archive_proof_sha256: journalAuthority.archiveProof.proof_sha256,
    source_health_authority_sha256: sourceAuthority.current_source_authority_sha256,
    acquisition_id: acquisition.id,
    acquisition_normalized_text_sha256: acquisitionAuthority.normalizedTextSha256,
    acquisition_guard_sha256: acquisitionAuthority.guardSha256,
    finalization_receipt_sha256: finalization.finalization_receipt_sha256,
    finalized_at: finalization.finalized_at,
    semantic_scope: semanticScope,
    mutation_performed: false,
    capture_performed: false,
    creates_api_charge: false,
    public_fact_authority: false,
    authority: {
      validation_only: true,
      mutation: false,
      capture: false,
    },
  };
  const receipt = assertStage1EvidenceSchemaUpgradeCompletedAuthorityReceipt({
    ...receiptContent,
    receipt_sha256: sha256Json(receiptContent),
  });
  return completedAuthorityResult({
    applies: true,
    accepted: true,
    reason: "already_upgraded_completed_authority_verified",
    evidence: {
      source_id: sourceId,
      transaction_id: expectedTransactionId,
      kind: capture.kind,
      captured_at: capture.captured_at,
      semantic_scope: semanticScope,
      provenance_validation_sha256: provenance.validation_sha256,
      current_baseline_sha256: receipt.current_baseline_sha256,
      current_pointer_sha256: receipt.current_pointer_sha256,
      current_r2_binding_receipt_sha256: currentR2Receipt.receipt_sha256,
      audit_inspection_sha256: audit.inspection_sha256,
      journal_sha256: input.completedJournal.journal_sha256,
      archive_proof_sha256: journalAuthority.archiveProof.proof_sha256,
      source_health_classification: sourceAuthority.classification,
      completed_authority_verified: true,
      mutation_performed: false,
      capture_performed: false,
      creates_api_charge: false,
      public_fact_authority: false,
    },
    receipt,
  });
}

function completedAuthorityProvenanceHints(input) {
  const baseline = input.currentBaseline?.summary_metadata?.stage1_evidence_schema_upgrade;
  const capture = input.currentCapture?.stage1_evidence_schema_upgrade;
  const pointer = input.currentR2Pointer?.latest_metadata?.stage1_evidence_schema_upgrade;
  let meta;
  let rawMetaHint = false;
  try {
    const artifact = findPreparedMetaArtifact(input.currentPreparedArtifacts);
    if (artifact) {
      const body = exactBytes(artifact.body, "prepared meta bytes");
      rawMetaHint = body.includes(Buffer.from("stage1_evidence_schema_upgrade", "utf8"));
      meta = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body))
        ?.stage1_evidence_schema_upgrade;
    }
  } catch {
    rawMetaHint = true;
  }
  return {
    present: [baseline, capture, pointer, meta]
      .some((value) => value !== undefined && value !== null) || rawMetaHint,
    baseline,
    capture,
    pointer,
    meta,
  };
}

function validatePreparedArtifacts(value) {
  const root = value?.prepared || value;
  if (!plainObject(root) || !Array.isArray(root.artifacts) || !plainObject(root.artifactBindings)) {
    refuse("completed_authority_current_prepared_artifacts_missing");
  }
  try {
    exactObject(
      root,
      ["artifactBindings", "artifacts"],
      "completed authority prepared artifact set",
    );
  } catch {
    refuse("completed_authority_current_prepared_artifact_set_invalid");
  }
  const byRole = new Map();
  for (const raw of root.artifacts) {
    let artifact;
    let binding;
    try {
      artifact = exactObject(raw, ARTIFACT_KEYS, "completed authority prepared artifact");
      binding = exactObject(
        artifact.binding,
        ARTIFACT_BINDING_KEYS,
        "completed authority prepared artifact binding",
      );
    } catch {
      refuse("completed_authority_prepared_artifact_contract_invalid");
    }
    const role = cleanText(artifact.name);
    if (!role || byRole.has(role)) {
      refuse("completed_authority_prepared_artifact_roles_invalid");
    }
    const body = requireOrRefuse(
      () => exactBytes(artifact.body, `prepared ${role} body`),
      "completed_authority_prepared_artifact_body_invalid",
    );
    const computed = {
      sha256: sha256Bytes(body),
      byte_length: body.byteLength,
      content_type: artifact.contentType,
      hash_mode: "raw_sha256",
    };
    if (
      !cleanText(artifact.fileName)
      || !cleanText(artifact.path)
      || !cleanText(artifact.contentType)
      || !sameJson(binding, computed)
      || !sameJson(root.artifactBindings[role], computed)
    ) {
      refuse("completed_authority_prepared_artifact_binding_invalid");
    }
    byRole.set(role, { ...artifact, body, binding: computed });
  }
  const roles = [...byRole.keys()].sort();
  if (!roles.length || !sameJson(Object.keys(root.artifactBindings).sort(), roles)) {
    refuse("completed_authority_prepared_artifact_binding_roles_invalid");
  }
  const meta = byRole.get("meta");
  if (!meta || meta.fileName !== "meta.json") {
    refuse("completed_authority_meta_artifact_missing");
  }
  return {
    root,
    byRole,
    roles,
    meta: {
      ...meta,
      object: parseJsonBytes(meta.body, "completed_authority_meta_json_invalid"),
    },
  };
}

function findPreparedMetaArtifact(prepared) {
  const root = prepared?.prepared || prepared;
  return Array.isArray(root?.artifacts)
    ? root.artifacts.find((artifact) => artifact?.name === "meta") || null
    : null;
}

function requireIdenticalProvenance(provenances) {
  for (const [location, value] of Object.entries(provenances)) {
    if (!plainObject(value)) refuse(`completed_authority_${location}_provenance_missing`);
  }
  const entries = Object.entries(provenances);
  const expected = entries[0][1];
  for (const [location, value] of entries.slice(1)) {
    if (!sameJson(value, expected)) {
      refuse(`completed_authority_${location}_provenance_mismatch`);
    }
  }
  return expected;
}

function validateProvenanceEnvelope(provenance, { sourceId, expectedManifestSha256 }) {
  try {
    exactObject(provenance, PROVENANCE_KEYS, "completed authority provenance");
  } catch {
    refuse("completed_authority_provenance_envelope_invalid");
  }
  if (
    provenance.schema_version
      !== STAGE1_EVIDENCE_SCHEMA_UPGRADE_COMPLETED_AUTHORITY_PROVENANCE_SCHEMA
    || provenance.source_id !== sourceId
    || provenance.manifest_sha256 !== expectedManifestSha256
    || provenance.creates_api_charge !== false
    || provenance.public_fact_authority !== false
  ) refuse("completed_authority_provenance_envelope_invalid");
  requireOrRefuse(
    () => requiredUuid(provenance.worker_run_id, "completed provenance worker_run_id"),
    "completed_authority_provenance_envelope_invalid",
  );
  requireOrRefuse(
    () => requiredPreciseTimestamp(provenance.recorded_at, "completed provenance recorded_at"),
    "completed_authority_provenance_envelope_invalid",
  );
  try {
    exactObject(provenance.validation, VALIDATION_KEYS, "completed provenance validation");
  } catch {
    refuse("completed_authority_validation_envelope_invalid");
  }
  if (provenance.validation_sha256 !== sha256Json(provenance.validation)) {
    refuse("completed_authority_validation_sha256_mismatch");
  }
}

function validateAcquisitionAndActivation({ source, sourceId, baseline, capture, pointer, meta }) {
  const acquisition = plainObject(source.source_acquisition)
    ? source.source_acquisition
    : refuse("completed_authority_live_acquisition_missing");
  let binding;
  try {
    binding = evaluateStage1FirstVisualBaselineActivation({
      acquisition,
      sourceId,
      bindingOnly: true,
    });
  } catch {
    refuse("completed_authority_live_acquisition_guard_invalid");
  }
  if (binding.applies !== true || binding.allowed !== true) {
    refuse("completed_authority_live_acquisition_guard_invalid");
  }
  const disposition = acquisition.review_seal?.human_source_disposition;
  const guard = disposition?.activation_guard;
  if (!plainObject(disposition) || !plainObject(guard)) {
    refuse("completed_authority_live_acquisition_guard_invalid");
  }

  const activation = baseline.summary_metadata?.stage1_baseline_activation;
  const activationCopies = [
    capture.stage1_baseline_activation,
    meta.stage1_baseline_activation,
    pointer.latest_metadata?.stage1_baseline_activation,
  ];
  if (
    !plainObject(activation)
    || activationCopies.some((candidate) => !sameJson(candidate, activation))
    || !new Set([
      "exact_hash_verified_pending_server_receipt",
      "server_prepare_recorded",
    ]).has(activation.status)
    || activation.shared_award_source_id !== sourceId
    || activation.source_acquisition_id !== acquisition.id
    || activation.source_page_request_id !== acquisition.origin_source_page_request_id
    || activation.expected_normalized_text_sha256 !== guard.normalized_retained_text_sha256
    || activation.observed_normalized_text_sha256 !== guard.normalized_retained_text_sha256
    || activation.capture_file_sha256 !== guard.capture_file_sha256
    || activation.guard_sha256 !== disposition.guard_sha256
    || comparableUrl(activation.reviewed_final_url) !== comparableUrl(guard.final_url)
    || comparableUrl(activation.observed_final_url) !== comparableUrl(guard.final_url)
    || activation.visual_evidence_quotes_verified !== true
    || activation.retained_evidence_quotes_verified !== true
    || activation.authority?.monitoring !== true
    || activation.authority?.public_facts !== false
    || activation.authority?.fact_candidates !== false
    || activation.authority?.reconciliation !== false
    || activation.authority?.publication !== false
    || activation.authority?.first_observation_notification !== false
  ) refuse("completed_authority_baseline_activation_binding_invalid");

  const finalization = validateFinalization({
    source,
    sourceId,
    acquisition,
    disposition,
    guard,
  });
  return {
    acquisition,
    disposition,
    guard,
    activation,
    finalization,
    normalizedTextSha256: guard.normalized_retained_text_sha256,
    guardSha256: disposition.guard_sha256,
  };
}

function validateFinalization({ source, sourceId, acquisition, disposition, guard }) {
  const finalization = plainObject(source.source_activation_finalization)
    ? source.source_activation_finalization
    : refuse("completed_authority_live_finalization_missing");
  const receipt = finalization.receipt;
  try {
    exactObject(receipt, FINALIZATION_RECEIPT_KEYS, "completed authority finalization receipt");
  } catch {
    refuse("completed_authority_live_finalization_receipt_invalid");
  }
  if (
    finalization.shared_award_source_id !== sourceId
    || finalization.source_acquisition_id !== acquisition.id
    || finalization.source_page_request_id !== acquisition.origin_source_page_request_id
    || finalization.disposition_item_sha256 !== guard.decision_item_sha256
    || finalization.guard_sha256 !== disposition.guard_sha256
    || finalization.observed_normalized_text_sha256
      !== guard.normalized_retained_text_sha256
    || !requiredSha256OrFalse(finalization.prepare_receipt_sha256)
    || receipt.schema_version
      !== "awardping.stage1.baseline-activation-finalization-receipt.v1"
    || receipt.status !== "finalized_open"
    || receipt.shared_award_source_id !== sourceId
    || receipt.source_acquisition_id !== acquisition.id
    || receipt.source_page_request_id !== acquisition.origin_source_page_request_id
    || receipt.decision_item_sha256 !== finalization.disposition_item_sha256
    || receipt.prepare_receipt_sha256 !== finalization.prepare_receipt_sha256
    || receipt.guard_sha256 !== finalization.guard_sha256
    || receipt.observed_normalized_text_sha256
      !== finalization.observed_normalized_text_sha256
    || receipt.persistence_evidence_sha256 !== sha256Json(finalization.persistence_evidence)
    || receipt.public_fact_authority !== false
    || receipt.creates_api_charge !== false
    || finalization.finalization_receipt_sha256 !== sha256Json(receipt)
  ) refuse("completed_authority_live_finalization_binding_invalid");
  const finalizedAt = requireOrRefuse(
    () => requiredPreciseTimestamp(finalization.finalized_at, "completed authority finalized_at"),
    "completed_authority_live_finalization_timestamp_invalid",
  );
  if (
    comparePreciseRfc3339(finalizedAt, receipt.finalized_at) !== 0
    || comparePreciseRfc3339(finalizedAt, source.admin_reviewed_at) !== 0
  ) refuse("completed_authority_live_finalization_timestamp_mismatch");
  return finalization;
}

function validatePriorEligibleValidation({
  validation,
  provenance,
  sourceId,
  baseline,
  capture,
  prepared,
  acquisitionAuthority,
}) {
  if (
    validation.decision !== "eligible_unchanged_upgrade"
    || !new Set([
      "exact_semantic_and_primary_visual_identity_verified",
      "exact_pdf_bytes_and_sealed_intake_text_recovery_verified",
    ]).has(validation.reason)
    || !Array.isArray(validation.reasons)
    || validation.reasons.some((reason) => (
      !plainObject(reason)
      || (cleanText(reason.code) && reason.code !== validation.reason)
    ))
  ) refuse("completed_authority_prior_validation_not_eligible_unchanged");
  const evidence = plainObject(validation.evidence)
    ? validation.evidence
    : refuse("completed_authority_prior_validation_evidence_missing");
  const kind = capture.kind;
  if (
    !new Set(["webpage", "pdf"]).has(kind)
    || evidence.source_id !== sourceId
    || evidence.kind !== kind
    || baseline.kind !== kind
    || comparableUrl(evidence.reviewed_final_url)
      !== comparableUrl(acquisitionAuthority.guard.final_url)
  ) refuse("completed_authority_prior_validation_identity_mismatch");

  const immutable = evidence.immutable_acquisition;
  if (
    immutable?.file_hash !== acquisitionAuthority.guard.capture_file_sha256
    || immutable?.normalized_text_hash !== acquisitionAuthority.normalizedTextSha256
    || immutable?.guard_sha256 !== acquisitionAuthority.guardSha256
    || !Number.isSafeInteger(immutable?.evidence_quote_count)
    || immutable.evidence_quote_count < 1
  ) refuse("completed_authority_acquisition_validation_binding_mismatch");

  validateHistoricalR2Authority({ provenance, evidence, sourceId, kind });
  if (!sameJson(provenance.prior_recovery_receipt, evidence.prior_recovery ?? null)) {
    refuse("completed_authority_prior_recovery_provenance_mismatch");
  }
  validatePriorCaptureSummary({ summary: evidence.capture, capture, prepared });
  validatePriorComparison({ comparison: evidence.comparison, capture });

  if (kind === "pdf") {
    if (
      !requiredSha256OrFalse(immutable.text_hash)
      || immutable.text_hash !== capture.text_hash
      || immutable.file_hash !== capture.file_hash
      || evidence.intake?.status !== "not_applicable_pdf"
      || evidence.intake?.capture_visual_quotes?.ok !== true
    ) refuse("completed_authority_pdf_acquisition_semantics_mismatch");
    const textComparison = evidence.comparison?.semantic_fields?.text_hash;
    if (
      textComparison?.current !== capture.text_hash
      || textComparison?.current_length !== capture.text_length
      || (
        textComparison.matches !== true
        && (
          textComparison.accepted_recovery !== true
          || evidence.pdf_text_recovery?.status !== "accepted"
          || validation.reason
            !== "exact_pdf_bytes_and_sealed_intake_text_recovery_verified"
        )
      )
    ) refuse("completed_authority_pdf_comparison_semantics_mismatch");
    return "pdf_exact_file_and_sealed_text";
  }

  return validateWebIntakeSemantics({
    intake: evidence.intake,
    capture,
    acquisitionAuthority,
    sourceId,
  });
}

function validateHistoricalR2Authority({ provenance, evidence, sourceId, kind }) {
  const receipt = provenance.existing_r2_binding_receipt;
  try {
    assertStage1EvidenceSchemaUpgradeR2BindingReceipt(receipt);
  } catch {
    refuse("completed_authority_historical_r2_binding_receipt_invalid");
  }
  if (
    !sameJson(receipt, evidence.authoritative_existing_r2_binding)
    || receipt.source_id !== sourceId
    || receipt.kind !== kind
    || receipt.captured_at !== evidence.existing?.captured_at
    || receipt.semantic_text?.sha256 !== evidence.existing?.text_hash
  ) refuse("completed_authority_historical_r2_validation_binding_mismatch");
}

function validatePriorCaptureSummary({ summary, capture, prepared }) {
  const expectedHistoricalImageHash = capture.kind === "pdf"
    ? null
    : capture.image_hash ?? null;
  if (
    !plainObject(summary)
    || summary.captured_at !== capture.captured_at
    || comparableUrl(summary.final_url) !== comparableUrl(capture.final_url)
    || summary.text_hash !== capture.text_hash
    || summary.image_hash !== expectedHistoricalImageHash
    || summary.file_hash !== (capture.file_hash ?? null)
    || summary.layout_hash !== (capture.layout_hash ?? null)
    || summary.raw_metadata_verified !== true
    || !Array.isArray(summary.artifact_slots)
    || !sameJson([...summary.artifact_slots].sort(), prepared.roles)
  ) refuse("completed_authority_prior_capture_identity_mismatch");
}

function validatePriorComparison({ comparison, capture }) {
  const semanticFields = comparison?.semantic_fields;
  const primary = comparison?.primary_visual_identity;
  if (!plainObject(semanticFields) || !plainObject(primary)) {
    refuse("completed_authority_prior_comparison_identity_mismatch");
  }
  const fields = capture.kind === "pdf" ? [["text_hash", "text_length"]] : WEB_SEMANTIC_FIELDS;
  for (const [hashField, lengthField] of fields) {
    const field = semanticFields[hashField];
    if (
      !plainObject(field)
      || field.current !== capture[hashField]
      || (lengthField && field.current_length !== capture[lengthField])
      || (capture.kind !== "pdf" && (
        field.matches !== true
        || field.previous !== field.current
        || (lengthField && field.previous_length !== field.current_length)
      ))
    ) refuse("completed_authority_prior_comparison_identity_mismatch");
  }
  const primaryField = capture.kind === "pdf" ? "file_hash" : "image_hash";
  if (
    primary.field !== primaryField
    || primary.previous !== capture[primaryField]
    || primary.current !== capture[primaryField]
    || primary.matches !== true
    || primary.equivalence_basis !== "exact_hash"
  ) refuse("completed_authority_prior_comparison_identity_mismatch");
}

function validateWebIntakeSemantics({ intake, capture, acquisitionAuthority, sourceId }) {
  const normalized = acquisitionAuthority.normalizedTextSha256;
  const captureNormalized = stage1BaselineActivationTextSha256(capture.text);
  if (
    !plainObject(intake)
    || intake.pre_normalized_text_hash !== normalized
    || intake.post_normalized_text_hash !== normalized
    || intake.immutable_normalized_text_hash !== normalized
    || intake.capture_normalized_text_hash !== captureNormalized
    || intake.matches_immutable_acquisition !== true
    || intake.evidence_quotes_verified !== true
    || intake.pre_intake_quotes?.ok !== true
    || intake.post_intake_quotes?.ok !== true
    || intake.capture_visual_quotes?.ok !== true
    || comparableUrl(intake.final_url) !== comparableUrl(acquisitionAuthority.guard.final_url)
  ) refuse("completed_authority_web_intake_semantics_mismatch");

  if (
    intake.capture_matches_stable_intake === true
    && intake.capture_matches_stable_intake_basis === "exact_full_normalized_text_hash"
    && intake.capture_main_content_matches_stable_intake === null
    && intake.semantic_scope_bridge === null
    && captureNormalized === normalized
  ) return "full_normalized_text";

  const bridge = intake.semantic_scope_bridge;
  if (
    intake.capture_matches_stable_intake !== false
    || intake.capture_matches_stable_intake_basis
      !== "exact_source_bound_main_content_hash_bridge"
    || intake.capture_main_content_matches_stable_intake !== true
    || !plainObject(bridge)
    || bridge.source_id !== sourceId
    || bridge.kind !== "webpage"
    || bridge.source_acquisition_id !== acquisitionAuthority.acquisition.id
    || bridge.source_page_request_id
      !== acquisitionAuthority.acquisition.origin_source_page_request_id
    || bridge.sealed_acquisition_file_sha256
      !== acquisitionAuthority.guard.capture_file_sha256
    || bridge.sealed_acquisition_guard_sha256 !== acquisitionAuthority.guardSha256
    || bridge.comparison_scope !== "main_content_only"
    || bridge.immutable_acquisition_normalized_text_sha256 !== normalized
    || bridge.prospective_main_content_sha256 !== normalized
    || capture.main_content_hash !== normalized
    || captureNormalized === normalized
    || !Array.isArray(bridge.limitations)
    || !bridge.limitations.includes(
      "full_browser_text_mismatch_is_preserved_and_explicit_not_treated_as_equality",
    )
  ) refuse("completed_authority_main_content_semantics_mismatch");
  return "main_content_only";
}

function validateCurrentCandidateIdentity({ sourceId, baseline, capture, pointer, prepared }) {
  const meta = prepared.meta.object;
  if (
    capture.source?.id !== sourceId
    || baseline.source?.id !== sourceId
    || meta.source?.id !== sourceId
    || pointer.shared_award_source_id !== sourceId
    || capture.kind !== baseline.kind
    || capture.kind !== meta.kind
    || capture.kind !== pointer.kind
    || capture.captured_at !== baseline.captured_at
    || capture.captured_at !== meta.captured_at
    || comparePreciseRfc3339(capture.captured_at, pointer.latest_captured_at) !== 0
    || comparableUrl(capture.final_url) !== comparableUrl(baseline.final_url)
    || comparableUrl(capture.final_url) !== comparableUrl(meta.final_url)
    || comparableUrl(capture.final_url) !== comparableUrl(pointer.latest_metadata?.final_url)
  ) refuse("completed_authority_current_candidate_identity_mismatch");
  if (capture.kind === "pdf" && capture.image_hash !== capture.file_hash) {
    refuse("completed_authority_current_baseline_capture_mismatch");
  }

  const expectedHashes = Object.fromEntries(POINTER_HASH_KEYS.map((key) => [
    key,
    key === "layout_hash" && !prepared.byRole.has("layout")
      ? null
      : capture[key] ?? null,
  ]));
  if (!sameJson(pointer.latest_hashes, expectedHashes)) {
    refuse("completed_authority_current_pointer_hashes_mismatch");
  }
  for (const key of [
    "text_hash",
    "body_text_hash",
    "main_content_hash",
    "nav_header_footer_hash",
    "expansion_hash",
    "expandable_sections_hash",
    "image_hash",
    "layout_hash",
    "file_hash",
    "text_length",
    "body_text_length",
    "main_content_text_length",
    "nav_header_footer_text_length",
    "expansion_text_length",
    "file_bytes",
  ]) {
    if (
      (baseline[key] ?? null) !== (capture[key] ?? null)
      || (meta[key] ?? null) !== (capture[key] ?? null)
    ) {
      refuse("completed_authority_current_baseline_capture_mismatch");
    }
  }
  for (const key of [
    "text_length",
    "body_text_length",
    "main_content_text_length",
    "nav_header_footer_text_length",
    "expansion_text_length",
    "file_bytes",
  ]) {
    if ((pointer.latest_metadata?.[key] ?? null) !== (capture[key] ?? null)) {
      refuse("completed_authority_current_pointer_metadata_mismatch");
    }
  }
  try {
    assertR2CaptureArtifactSlots(capture.kind, prepared.root.artifactBindings, {
      layoutClaimed: prepared.byRole.has("layout"),
      expansionStateCount: prepared.roles
        .filter((role) => /^expansion_state_[0-9]{2}$/u.test(role)).length,
    });
  } catch {
    refuse("completed_authority_current_artifact_topology_invalid");
  }
  if (
    pointer.latest_metadata?.artifact_bindings_schema !== r2CaptureArtifactBindingsSchema
    || !sameJson(pointer.latest_metadata?.artifact_bindings, prepared.root.artifactBindings)
    || !sameJson(Object.keys(pointer.latest_object_keys || {}).sort(), prepared.roles)
  ) refuse("completed_authority_current_pointer_artifact_bindings_mismatch");
  for (const role of prepared.roles) {
    const artifact = prepared.byRole.get(role);
    if (!cleanText(pointer.latest_object_keys[role]).endsWith(`/${artifact.fileName}`)) {
      refuse("completed_authority_current_pointer_artifact_key_mismatch");
    }
  }
}

function validateCurrentR2Receipt({ receipt, sourceId, capture, pointer, prepared }) {
  try {
    assertStage1EvidenceSchemaUpgradeR2BindingReceipt(receipt);
    exactObject(receipt, CURRENT_R2_RECEIPT_KEYS, "current R2 receipt");
    exactObject(
      receipt.pointer_identity,
      CURRENT_R2_POINTER_IDENTITY_KEYS,
      "current R2 pointer identity",
    );
    exactObject(
      receipt.previous_pointer,
      CURRENT_R2_PREVIOUS_POINTER_KEYS,
      "current R2 previous pointer",
    );
    exactObject(
      receipt.artifact_binding_verification,
      ["derived_binding_count", "pointer_claim_present", "status"],
      "current R2 artifact-binding verification",
    );
    exactObject(
      receipt.semantic_text,
      ["character_length", "object_byte_length", "sha256", "writer_framing"],
      "current R2 semantic text",
    );
  } catch {
    refuse("completed_authority_current_r2_binding_receipt_invalid");
  }
  const pointerReceipt = receipt.pointer_identity;
  if (
    receipt.source_id !== sourceId
    || receipt.kind !== capture.kind
    || comparePreciseRfc3339(receipt.captured_at, capture.captured_at) !== 0
    || receipt.creates_api_charge !== false
    || receipt.mutation_performed !== false
    || pointerReceipt?.shared_award_source_id !== sourceId
    || pointerReceipt?.kind !== capture.kind
    || pointerReceipt?.bucket !== pointer.bucket
    || comparePreciseRfc3339(pointerReceipt?.latest_captured_at, pointer.latest_captured_at) !== 0
    || !sameJson(pointerReceipt?.latest_object_keys, pointer.latest_object_keys)
    || !sameJson(pointerReceipt?.latest_hashes, pointer.latest_hashes)
    || pointerReceipt?.latest_metadata_sha256 !== sha256Json(pointer.latest_metadata)
    || !sameJson(receipt.previous_pointer?.previous_captured_at, pointer.previous_captured_at ?? null)
    || !sameJson(receipt.previous_pointer?.previous_object_keys, pointer.previous_object_keys ?? {})
    || !sameJson(receipt.previous_pointer?.previous_hashes, pointer.previous_hashes ?? {})
    || !sameJson(receipt.previous_pointer?.previous_metadata, pointer.previous_metadata ?? {})
    || receipt.artifact_binding_verification?.status !== "pointer_v1_bindings_verified"
    || receipt.artifact_binding_verification?.pointer_claim_present !== true
    || receipt.artifact_binding_verification?.derived_binding_count !== 0
  ) refuse("completed_authority_current_r2_pointer_binding_mismatch");

  const generations = new Set(Object.values(pointer.latest_object_keys).map((key) => {
    const match = /\/captures\/([0-9a-f]{32})\//u.exec(cleanText(key));
    return match?.[1] || null;
  }));
  if (
    generations.size !== 1
    || generations.has(null)
    || pointerReceipt.immutable_generation !== [...generations][0]
  ) refuse("completed_authority_current_r2_generation_mismatch");

  if (!Array.isArray(receipt.verified_roles) || receipt.verified_roles.length !== prepared.roles.length) {
    refuse("completed_authority_current_r2_verified_roles_mismatch");
  }
  const roles = new Map();
  for (const entry of receipt.verified_roles) {
    try {
      exactObject(entry, CURRENT_R2_VERIFIED_ROLE_KEYS, "current R2 verified role");
    } catch {
      refuse("completed_authority_current_r2_verified_roles_mismatch");
    }
    if (roles.has(entry.role)) {
      refuse("completed_authority_current_r2_verified_roles_mismatch");
    }
    roles.set(entry.role, entry);
  }
  if (!sameJson([...roles.keys()].sort(), prepared.roles)) {
    refuse("completed_authority_current_r2_verified_roles_mismatch");
  }
  for (const role of prepared.roles) {
    const entry = roles.get(role);
    const binding = prepared.byRole.get(role).binding;
    if (
      entry.key !== pointer.latest_object_keys[role]
      || entry.sha256 !== binding.sha256
      || entry.byte_length !== binding.byte_length
      || entry.content_type !== binding.content_type
      || entry.remote_body_verified !== true
    ) refuse("completed_authority_current_r2_verified_role_binding_mismatch");
  }

  const text = prepared.byRole.get("text");
  if (!text) refuse("completed_authority_current_r2_semantic_text_missing");
  const decoded = decodeSemanticText(text.body, receipt.semantic_text?.writer_framing);
  if (
    (capture.text !== decoded.semantic && capture.text !== decoded.raw)
    || receipt.semantic_text?.sha256 !== sha256Bytes(decoded.semantic)
    || receipt.semantic_text?.sha256 !== capture.text_hash
    || receipt.semantic_text?.character_length !== decoded.semantic.length
    || capture.text_length !== decoded.semantic.length
    || receipt.semantic_text?.object_byte_length !== text.body.byteLength
  ) refuse("completed_authority_current_r2_semantic_text_mismatch");
  return receipt;
}

function validateAuditInspection({
  inspection,
  provenance,
  sourceId,
  expectedManifestSha256,
}) {
  let audit;
  try {
    audit = assertStage1EvidenceSchemaUpgradeCompletedAuthorityAuditInspection(
      inspection,
    );
  } catch {
    refuse("completed_authority_terminal_audit_inspection_invalid");
  }
  if (
    audit.selected_source_id !== sourceId
    || audit.run_id !== provenance.worker_run_id
    || audit.manifest_sha256 !== expectedManifestSha256
    || comparePreciseRfc3339(provenance.recorded_at, audit.started_at) < 0
    || comparePreciseRfc3339(provenance.recorded_at, audit.finished_at) > 0
  ) refuse("completed_authority_terminal_audit_provenance_mismatch");
  return audit;
}

function completedAuthorityTransactionId(audit) {
  const completion = audit.terminal_completion_authority;
  if (completion.mode === "reviewed_recovery") {
    return requireOrRefuse(
      () => requiredUuid(
        completion.recovery?.transaction_id,
        "reviewed recovery completed transaction ID",
      ),
      "completed_authority_recovery_transaction_invalid",
    );
  }
  if (completion.mode !== "fresh_reviewed_apply" || completion.recovery !== null) {
    refuse("completed_authority_completion_mode_invalid");
  }
  try {
    return stage1EvidenceSchemaUpgradeReviewedApplyTransactionId({
      sourceId: audit.selected_source_id,
      planSha256: audit.plan_sha256,
    });
  } catch {
    refuse("completed_authority_fresh_transaction_derivation_invalid");
  }
}

function validateCompletedJournalAndProof({
  journal,
  archiveProof,
  baselineBytes,
  pointer,
  audit,
  sourceId,
  expectedTransactionId,
}) {
  try {
    assertStage1EvidenceSchemaUpgradeJournal(journal);
  } catch {
    refuse("completed_authority_journal_invalid");
  }
  if (
    journal.schema_version !== STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_JOURNAL_SCHEMA
    || journal.phase !== "completed"
    || journal.source_id !== sourceId
    || journal.transaction_id !== expectedTransactionId
    || audit.terminal_commit_journal_sha256 !== journal.journal_sha256
    || audit.terminal_result_identity?.commit_journal_sha256 !== journal.journal_sha256
  ) refuse("completed_authority_journal_terminal_identity_mismatch");
  let operationBinding;
  try {
    operationBinding = assertStage1EvidenceSchemaUpgradeReviewedOperationBinding(
      journal.operation_binding,
    );
  } catch {
    refuse("completed_authority_operation_binding_invalid");
  }
  if (
    operationBinding.source_id !== sourceId
    || operationBinding.transaction_id !== expectedTransactionId
    || operationBinding.audit_run_id !== audit.run_id
    || operationBinding.execution_nonce !== audit.execution_nonce
    || operationBinding.reviewed_apply_plan_file_sha256 !== audit.plan_file_sha256
    || operationBinding.reviewed_apply_plan_sha256 !== audit.plan_sha256
    || operationBinding.reviewed_report_attempt_id !== audit.reviewed_report_attempt_id
    || operationBinding.fresh_capture_sha256 !== audit.fresh_capture_sha256
    || operationBinding.fresh_capture_result_sha256 !== audit.fresh_capture_result_sha256
    || operationBinding.fresh_capture_validation_sha256
      !== audit.fresh_capture_validation_sha256
    || operationBinding.fresh_validation_projection_sha256
      !== audit.fresh_validation_projection_sha256
    || operationBinding.precommit_authority_receipt_sha256
      !== audit.authority_receipt_sha256
  ) refuse("completed_authority_audit_operation_binding_mismatch");

  let recomputedProof;
  try {
    recomputedProof = proveStage1EvidenceSchemaUpgradeArchivedCompletion({
      journal,
      expectedJournalSha256: journal.journal_sha256,
      expectedTransactionId,
      expectedOperationBinding: operationBinding,
      currentBaselineBytes: baselineBytes,
      currentPointer: pointer,
    });
  } catch {
    refuse("completed_authority_archived_completion_not_proven");
  }
  if (
    !sameJson(recomputedProof, archiveProof)
    || recomputedProof.disposition !== "archived_candidate_completed"
    || recomputedProof.authority !== "candidate"
    || recomputedProof.source_id !== sourceId
    || !new Set(["succeeded", "already_current"]).has(
      recomputedProof.source_health_status,
    )
    || recomputedProof.mutation_performed !== false
    || recomputedProof.creates_api_charge !== false
  ) refuse("completed_authority_archive_proof_mismatch");
  return { operationBinding, archiveProof: recomputedProof };
}

function validateLiveSourceAuthority({
  source,
  sourceHealth,
  sourceId,
  baselineBytes,
  operationBinding,
}) {
  const exactHealth = exactSourceHealthProjection(sourceHealth, source);
  let classification;
  try {
    classification = classifyStage1EvidenceSchemaUpgradeSourceHealthAuthority({
      precommitSourceAuthority: operationBinding.precommit_source_authority,
      currentSource: exactHealth,
      candidateBaselineBytes: baselineBytes,
    });
  } catch {
    refuse("completed_authority_source_health_authority_invalid");
  }
  if (
    classification.classification !== "exact_already_current"
    || classification.source_id !== sourceId
    || classification.mutation_performed !== false
  ) refuse("completed_authority_source_health_not_exact_terminal_authority");
  return classification;
}

function exactSourceHealthProjection(value, source) {
  if (!plainObject(value)) refuse("completed_authority_source_health_missing");
  const projection = {};
  for (const key of STAGE1_EVIDENCE_SCHEMA_UPGRADE_SOURCE_HEALTH_AUTHORITY_COLUMNS) {
    if (!Object.hasOwn(value, key) || !Object.hasOwn(source, key)) {
      refuse("completed_authority_source_health_projection_incomplete");
    }
    projection[key] = cloneJson(value[key]);
    if (!sameJson(value[key], source[key])) {
      refuse("completed_authority_source_health_disagrees_with_live_source");
    }
  }
  if (!sameJson(
    Object.keys(value).sort(),
    [...STAGE1_EVIDENCE_SCHEMA_UPGRADE_SOURCE_HEALTH_AUTHORITY_COLUMNS].sort(),
  )) refuse("completed_authority_source_health_projection_has_unexpected_fields");
  return projection;
}

function decodeSemanticText(bytes, framing) {
  let raw;
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    refuse("completed_authority_current_r2_semantic_text_invalid_utf8");
  }
  const crlf = raw.endsWith("\r\n");
  const lf = !crlf && raw.endsWith("\n");
  const semantic = crlf
    ? raw.slice(0, -2)
    : lf
      ? raw.slice(0, -1)
      : null;
  const actualFraming = crlf ? "crlf" : lf ? "lf" : null;
  if (
    semantic !== null
    && !semantic.endsWith("\n")
    && !semantic.endsWith("\r")
    && framing === actualFraming
  ) {
    return { raw, semantic };
  }
  refuse("completed_authority_current_r2_semantic_text_framing_invalid");
}

function completedAuthorityResult({ applies, accepted, reason, evidence, receipt }) {
  return deepFreeze({
    applies,
    accepted,
    reason,
    creates_api_charge: false,
    capture_permitted: false,
    capture_performed: false,
    mutation_permitted: false,
    mutation_performed: false,
    public_fact_authority: false,
    outcome: {
      would_commit: false,
      would_queue_visual_candidate: false,
      would_quarantine: false,
    },
    evidence,
    receipt,
  });
}

function comparableUrl(value) {
  try {
    const url = new URL(requiredText(value, "URL"));
    url.hash = "";
    url.pathname = url.pathname.replace(/\/+$/u, "") || "/";
    return url.toString();
  } catch {
    return null;
  }
}

function refuse(code, evidence = null) {
  throw new CompletedAuthorityRefusal(code, evidence);
}

function requireOrRefuse(fn, code) {
  try {
    return fn();
  } catch (error) {
    if (error instanceof CompletedAuthorityRefusal) throw error;
    refuse(code);
  }
}

function exactObject(value, keys, label) {
  if (!plainObject(value)) throw new TypeError(`${label} must be an object.`);
  if (!sameJson(Object.keys(value).sort(), [...keys].sort())) {
    throw new Error(`${label} has unexpected or missing fields.`);
  }
  return value;
}

function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function exactBytes(value, label) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (typeof value === "string") return Buffer.from(value, "utf8");
  throw new TypeError(`${label} must be exact bytes.`);
}

function parseJsonBytes(bytes, reason) {
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!plainObject(value)) refuse(reason);
    return value;
  } catch (error) {
    if (error instanceof CompletedAuthorityRefusal) throw error;
    refuse(reason);
  }
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function requiredText(value, label) {
  const text = cleanText(value);
  if (!text) throw new Error(`${label} is required.`);
  return text;
}

function requiredUuid(value, label) {
  const text = requiredText(value, label);
  if (!UUID_PATTERN.test(text)) throw new Error(`${label} is invalid.`);
  return text;
}

function requiredSha256(value, label) {
  const text = requiredText(value, label);
  if (!SHA256_PATTERN.test(text)) throw new Error(`${label} is invalid.`);
  return text;
}

function requiredSha256OrFalse(value) {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function requiredTimestamp(value, label) {
  const parsed = Date.parse(requiredText(value, label));
  if (!Number.isFinite(parsed)) throw new Error(`${label} is invalid.`);
  return new Date(parsed).toISOString();
}

function requiredPreciseTimestamp(value, label) {
  const canonical = canonicalPreciseRfc3339(value);
  if (!canonical) throw new Error(`${label} is invalid.`);
  return canonical;
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Json(value) {
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sameJson(left, right) {
  return stableJson(left) === stableJson(right);
}

function cloneJson(value) {
  if (value === null || value === undefined) return value;
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}
