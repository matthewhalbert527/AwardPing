import { createHash } from "node:crypto";

import {
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_SOURCE_IDS,
  stage1EvidenceSchemaUpgradeExpectedManifest,
  validateStage1EvidenceSchemaUpgradeManifest,
} from "./stage1-evidence-schema-upgrade.mjs";
import {
  assertStage1EvidenceSchemaUpgradeR2BindingReceipt,
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_R2_BINDING_SCHEMA,
} from "./stage1-evidence-schema-upgrade-r2-binding.mjs";
import {
  assertStage1EvidenceSchemaUpgradeMutationAccounting,
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_MUTATION_COUNT_KEYS,
} from "./stage1-evidence-schema-upgrade-mutation-accounting.mjs";
import {
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_COMMIT_RECEIPT_SCHEMA,
} from "./stage1-evidence-schema-upgrade-commit.mjs";
import {
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_VALIDATION_SCHEMA,
} from "./stage1-evidence-schema-upgrade-validation.mjs";
import {
  assertStage1EvidenceSchemaUpgradeJournal,
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_JOURNAL_SCHEMA,
} from "./stage1-evidence-schema-upgrade-transaction.mjs";
import {
  assertVisualSnapshotPointerIdentity,
  VISUAL_SNAPSHOT_LATEST_ONLY_CLEANUP_DEBT_SCHEMA,
  VISUAL_SNAPSHOT_POINTER_IDENTITY_SCHEMA,
  visualSnapshotPointerIdentityFields,
} from "./visual-snapshot-latest-only-reconciliation.mjs";

export const STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUARANTINE_EVIDENCE_SCHEMA =
  "awardping.stage1.evidence-schema-upgrade-quarantine-evidence.v1";
export const STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUARANTINE_RECEIPT_SCHEMA =
  "awardping.stage1.evidence-schema-upgrade-quarantine-receipt.v1";
export const STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUARANTINE_POLICY_SCHEMA =
  "awardping.stage1.evidence-schema-upgrade-quarantine-policy.v1";
export const STAGE1_EVIDENCE_SCHEMA_UPGRADE_CANDIDATE_ARTIFACTS_SCHEMA =
  "awardping.stage1.evidence-schema-upgrade-candidate-artifacts.v1";
export const STAGE1_EVIDENCE_SCHEMA_UPGRADE_RECOVERY_EVIDENCE_SCHEMA =
  "awardping.stage1.evidence-schema-upgrade-recovery-evidence.v1";
export const STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUARANTINE_POLICY_ID =
  "awardping-stage1-evidence-schema-upgrade-quarantine";
export const STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUARANTINE_POLICY_VERSION = "1";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const sha256Pattern = /^[0-9a-f]{64}$/u;
const reasonPattern = /^[a-z0-9][a-z0-9_]{1,159}$/u;
const contentTypePattern = /^[a-z0-9][a-z0-9!#$&^_.+\-]*\/[a-z0-9][a-z0-9!#$&^_.+\-]*(?:\s*;[^\r\n]+)?$/iu;
const immutableGenerationPattern = /^[0-9a-f]{32}$/u;
const asciiJsonKeyPattern = /^[\x20-\x7e]+$/u;
const upgradeContext = "stage1_evidence_schema_upgrade";
const artifactBindingsSchema = "awardping.r2.capture-artifact-bindings.v1";
const pointerJournalBindingSchema =
  "awardping.stage1.evidence-schema-upgrade-pointer-journal-binding.v1";
const freshRecoveryReason =
  "fresh_active_upgrade_journal_requires_reconciliation";
const freshRecoverySafeAction =
  "Keep the source quarantined and reconcile this exact freshly verified journal before retrying.";
const candidateFutureToleranceMs = 5 * 60 * 1000;
const pointerJournalSafeActions = Object.freeze({
  same_journal:
    "Keep the source quarantined and reconcile the freshly verified journal before retrying.",
  changed_since_failure:
    "Keep the source quarantined and reconcile both the prior receipt journal and the different fresh journal before retrying.",
  prior_observation_only:
    "Treat the receipt journal as a prior observation only; obtain a fresh sealed journal read before retrying.",
  missing_since_failure:
    "Keep the source quarantined; verify current pointer and baseline authority, then restore or reconstruct and reconcile the prior receipt journal before retrying.",
  fresh_observation_only:
    "Keep the source quarantined and reconcile the separately observed fresh journal before retrying the failed operation.",
  fresh_absence_only:
    "Keep the source quarantined; the fresh read verified that no active upgrade journal exists.",
});
const journalReadUnavailableSafeAction =
  "Keep this source quarantined. Repair access to the durable upgrade journal, obtain and validate its exact fresh state, and reconcile any active journal before any new capture or retry.";
const candidateKinds = new Set(["webpage", "pdf"]);
const fixedArtifactContract = Object.freeze({
  page: Object.freeze({ fileName: "page.jpg", contentType: "image/jpeg" }),
  thumb: Object.freeze({ fileName: "thumb.jpg", contentType: "image/jpeg" }),
  pdf: Object.freeze({ fileName: "document.pdf", contentType: "application/pdf" }),
  text: Object.freeze({
    fileName: "text.txt",
    contentType: "text/plain; charset=utf-8",
  }),
  layout: Object.freeze({
    fileName: "layout.json",
    contentType: "application/json; charset=utf-8",
  }),
  meta: Object.freeze({
    fileName: "meta.json",
    contentType: "application/json; charset=utf-8",
  }),
});
const validationDecisions = new Set([
  "eligible_unchanged_upgrade",
  "material_difference_candidate",
  "evidence_failure_quarantine",
]);
const exactSourceIds = new Set(STAGE1_EVIDENCE_SCHEMA_UPGRADE_SOURCE_IDS);
const expectedManifest = stage1EvidenceSchemaUpgradeExpectedManifest();

export const STAGE1_EVIDENCE_SCHEMA_UPGRADE_MANIFEST_SHA256 =
  canonicalJsonSha256(expectedManifest);

const exactPolicy = Object.freeze({
  schema_version: STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUARANTINE_POLICY_SCHEMA,
  policy_id: STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUARANTINE_POLICY_ID,
  policy_version: STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUARANTINE_POLICY_VERSION,
  context: upgradeContext,
  manifest_sha256: STAGE1_EVIDENCE_SCHEMA_UPGRADE_MANIFEST_SHA256,
  reviewed_source_count: STAGE1_EVIDENCE_SCHEMA_UPGRADE_SOURCE_IDS.length,
  creates_api_charge: false,
  public_fact_authority: false,
});

export const STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUARANTINE_POLICY_SHA256 =
  canonicalJsonSha256(exactPolicy);

/**
 * Produces a detached validation document suitable for durable quarantine.
 * Candidate-derived capture identity is filled only where the validator did
 * not have it; an already-present value must agree exactly. Mutation failures
 * and an unavailable fresh journal read are normalized into sealed evidence
 * without retaining mutable Error instances or caller-owned objects.
 */
export function prepareStage1EvidenceSchemaUpgradeQuarantineValidation({
  validation,
  candidateArtifacts = null,
  commitRecovery = null,
  pointerCommitReceipt = null,
  mutationFailure = null,
  journalReadUnavailable = null,
  journalReadAbsent = null,
} = {}) {
  const prepared = cloneJson(requireObject(validation, "validation evidence"));
  const evidence = requireObject(
    prepared.evidence,
    "validation evidence payload",
  );
  const sourceId = requiredUuid(
    evidence.source_id,
    "validation evidence source id",
  );
  const candidateForValidation = candidateArtifacts === null
    || candidateArtifacts === undefined
    ? null
    : candidateValidationIdentity(candidateArtifacts, sourceId);

  if (mutationFailure !== null && mutationFailure !== undefined) {
    const normalizedFailure = normalizeMutationFailureEvidence(mutationFailure);
    fillMissingOrRequireExact(
      evidence,
      "mutation_failure",
      normalizedFailure,
      "validation mutation failure evidence",
    );
  }

  if (pointerCommitReceipt !== null && pointerCommitReceipt !== undefined) {
    fillMissingOrRequireExact(
      evidence,
      "pointer_commit_receipt",
      pointerCommitReceipt,
      "validation prior pointer-commit receipt",
    );
  }

  if (journalReadUnavailable !== null && journalReadUnavailable !== undefined) {
    const normalizedObservation = normalizeJournalReadUnavailable(
      journalReadUnavailable,
    );
    fillMissingOrRequireExact(
      evidence,
      "journal_read_unavailable",
      normalizedObservation,
      "validation journal-read-unavailable evidence",
    );
  }
  if (journalReadAbsent !== null && journalReadAbsent !== undefined) {
    const normalizedObservation = normalizeJournalReadAbsent(journalReadAbsent);
    fillMissingOrRequireExact(
      evidence,
      "journal_read_absent",
      normalizedObservation,
      "validation journal-read-absent evidence",
    );
  }

  let checked = normalizeValidation(prepared, sourceId);
  const checkedRecovery = normalizeCommitRecovery(commitRecovery, sourceId);
  if (
    checkedRecovery !== null
    && (
      plainObject(checked.evidence.journal_read_unavailable)
      || plainObject(checked.evidence.journal_read_absent)
    )
  ) {
    throw new Error(
      "A sealed active-journal recovery envelope contradicts unavailable or absent journal-read evidence.",
    );
  }
  let bound = attachPointerCommitJournalBinding(
    checked,
    checkedRecovery,
    candidateForValidation,
  );
  assertCommitRecoveryNarrative(checkedRecovery, bound);
  if (
    candidateForValidation !== null
    && !new Set([
      "changed_since_failure",
      "fresh_observation_only",
    ]).has(bound.evidence.pointer_commit_journal_binding?.status)
  ) {
    bound = fillCandidateValidationIdentity(bound, candidateForValidation);
    bound = normalizeValidation(bound, sourceId);
  }
  if (candidateForValidation !== null) {
    const normalizedCandidate = normalizeCandidateArtifacts(
      candidateForValidation.candidate,
      sourceId,
      bound,
    );
    assertCandidateRecoveryBinding(normalizedCandidate, checkedRecovery);
  } else if (checkedRecovery !== null) {
    throw new Error(
      "A durable upgrade journal proves a candidate plan exists, so exact candidate artifact evidence is required.",
    );
  }
  canonicalJson(bound);
  return deepFreezeJson(bound);
}

/**
 * Returns the operator action sealed into a derived prior/fresh journal
 * binding. Callers must use this value as the RPC's top-level safe action so
 * the durable inbox cannot present a generic action that contradicts the
 * observed recovery state.
 */
export function stage1EvidenceSchemaUpgradeQuarantineSafeAction(
  validation,
  fallbackSafeAction,
) {
  const binding = validation?.evidence?.pointer_commit_journal_binding;
  const journalAction = plainObject(binding)
    ? normalizePointerCommitJournalBinding(binding).safe_action
    : plainObject(validation?.evidence?.journal_read_unavailable)
      ? journalReadUnavailableSafeAction
      : null;
  const mutationAction = mutationOperatorAction(validation);
  if (journalAction && mutationAction) {
    return `${journalAction} Also ${mutationAction}`;
  }
  if (journalAction) return journalAction;
  if (mutationAction) {
    return `Keep this source quarantined. ${mutationAction}`;
  }
  return requiredText(fallbackSafeAction, "safe action");
}

/**
 * Builds the only accepted RPC payload for an evidence-schema-upgrade
 * quarantine. Every supplied nested proof is normalized JSON and separately
 * content sealed before the complete evidence envelope receives its own seal.
 */
export function buildStage1EvidenceSchemaUpgradeQuarantineRpcArgs(input = {}) {
  const source = plainObject(input.source) ? input.source : {};
  const acquisition = plainObject(input.acquisition)
    ? input.acquisition
    : plainObject(source.source_acquisition)
      ? source.source_acquisition
      : {};
  const finalization = plainObject(input.finalization)
    ? input.finalization
    : plainObject(source.source_activation_finalization)
      ? source.source_activation_finalization
      : {};
  const sourceId = requiredUuid(input.sourceId ?? source.id, "source id");
  if (!exactSourceIds.has(sourceId)) {
    throw new Error("Stage 1 evidence-schema-upgrade quarantine is limited to the exact reviewed nine sources.");
  }
  const acquisitionId = requiredUuid(acquisition.id, "source acquisition id");
  const requestId = requiredUuid(
    acquisition.origin_source_page_request_id,
    "source page request id",
  );
  const disposition = objectValue(acquisition.review_seal?.human_source_disposition);
  const activationGuard = objectValue(disposition.activation_guard);
  const guardSha256 = requiredSha256(
    input.guardSha256 ?? disposition.guard_sha256,
    "activation guard SHA-256",
  );
  const dispositionItemSha256 = requiredSha256(
    input.dispositionItemSha256
      ?? finalization.disposition_item_sha256
      ?? activationGuard.decision_item_sha256,
    "disposition item SHA-256",
  );
  const finalizationReceiptSha256 = requiredSha256(
    input.finalizationReceiptSha256 ?? finalization.finalization_receipt_sha256,
    "finalization receipt SHA-256",
  );

  const manifest = cloneJson(input.manifest ?? expectedManifest);
  validateStage1EvidenceSchemaUpgradeManifest(manifest);
  const manifestSource = manifest.sources.find((row) => row.source_id === sourceId);
  if (!manifestSource) {
    throw new Error("The quarantined source is not bound to the exact reviewed-nine manifest.");
  }

  const failureStage = requiredReason(input.failureStage, "failure stage");
  const reasonCode = requiredReason(
    input.reasonCode ?? input.validation?.reason,
    "reason code",
  );
  const detail = nullableText(input.detail ?? input.validation?.detail);
  let validation = normalizeValidation(input.validation, sourceId);
  const mutationFailurePresent = plainObject(
    validation.evidence.mutation_failure,
  );
  const mutationFailureRequired = new Set([
    "candidate_enqueue",
    "pointer_commit",
  ]).has(failureStage);
  if (mutationFailurePresent !== mutationFailureRequired) {
    throw new Error(
      "Stage 1 candidate-enqueue and pointer-commit failure stages require exactly one sealed mutation failure, and non-mutation stages forbid it.",
    );
  }
  if (
    mutationFailurePresent
    && validation.evidence.mutation_failure.operation !== failureStage
  ) {
    throw new Error(
      "Stage 1 mutation failure operation must exactly match the quarantine failure stage.",
    );
  }
  const r2Binding = normalizeR2Binding(input.r2Binding, sourceId);
  const commitRecovery = normalizeCommitRecovery(input.commitRecovery, sourceId);
  if (
    commitRecovery !== null
    && (
      plainObject(validation.evidence.journal_read_unavailable)
      || plainObject(validation.evidence.journal_read_absent)
    )
  ) {
    throw new Error(
      "A sealed active-journal recovery envelope contradicts unavailable or absent journal-read evidence.",
    );
  }
  const candidateForValidation = input.candidateArtifacts === null
    || input.candidateArtifacts === undefined
    ? null
    : candidateValidationIdentity(input.candidateArtifacts, sourceId);
  validation = attachPointerCommitJournalBinding(
    validation,
    commitRecovery,
    candidateForValidation,
  );
  assertCommitRecoveryNarrative(commitRecovery, validation);
  const safeAction = requiredText(input.safeAction, "safe action");
  const derivedSafeAction = stage1EvidenceSchemaUpgradeQuarantineSafeAction(
    validation,
    safeAction,
  );
  if (safeAction !== derivedSafeAction) {
    throw new Error(
      "Stage 1 quarantine safe action must exactly match the derived prior/fresh journal reconciliation action.",
    );
  }
  const candidateArtifacts = normalizeCandidateArtifacts(
    candidateForValidation?.candidate ?? null,
    sourceId,
    validation,
  );
  assertObservedEvidence({
    input,
    commitRecovery,
    candidateArtifacts,
    r2Binding,
  });
  assertCandidateRecoveryBinding(candidateArtifacts, commitRecovery);
  const evidenceAvailability = buildEvidenceAvailability({
    failureStage,
    input,
    validation,
    r2Binding,
    commitRecovery,
    candidateArtifacts,
  });
  const sourceBinding = {
    source_id: sourceId,
    source_acquisition_id: acquisitionId,
    source_page_request_id: requestId,
    manifest_item: manifestSource.item,
    guard_sha256: guardSha256,
    disposition_item_sha256: dispositionItemSha256,
    finalization_receipt_sha256: finalizationReceiptSha256,
  };
  const policy = cloneJson(exactPolicy);
  const evidence = {
    schema_version: STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUARANTINE_EVIDENCE_SCHEMA,
    source_binding: sourceBinding,
    manifest,
    manifest_sha256: canonicalJsonSha256(manifest),
    policy,
    policy_sha256: canonicalJsonSha256(policy),
    failure_stage: failureStage,
    reason_code: reasonCode,
    detail,
    safe_action: safeAction,
    validation,
    validation_sha256: canonicalJsonSha256(validation),
    r2_binding: r2Binding,
    r2_binding_sha256: nullableJsonSha256(r2Binding),
    commit_recovery: commitRecovery,
    commit_recovery_sha256: nullableJsonSha256(commitRecovery),
    candidate_artifacts: candidateArtifacts,
    candidate_artifacts_sha256: nullableJsonSha256(candidateArtifacts),
    evidence_availability: evidenceAvailability,
    creates_api_charge: false,
    public_fact_authority: false,
    public_award_update_created: false,
  };
  evidence.evidence_sha256 = canonicalJsonSha256(evidence);

  return Object.freeze({
    p_source_id: sourceId,
    p_acquisition_id: acquisitionId,
    p_request_id: requestId,
    p_reason_code: reasonCode,
    p_evidence: Object.freeze(evidence),
  });
}

/**
 * Validates the exact server response and its source/evidence binding. Like the
 * existing Stage 1 receipt helpers, an invalid or partial response is returned
 * as a fail-closed result rather than accidentally treated as success.
 */
export function stage1EvidenceSchemaUpgradeQuarantineReceipt(data, expected = {}) {
  const value = Array.isArray(data) && data.length === 1 ? data[0] : data;
  const receipt = plainObject(value) ? value : {};
  const expectedEvidence = plainObject(expected.p_evidence)
    ? expected.p_evidence
    : plainObject(expected.evidence)
      ? expected.evidence
      : {};
  const expectedSourceId = cleanText(
    expected.p_source_id ?? expected.sourceId ?? expectedEvidence.source_binding?.source_id,
  ).toLowerCase();
  const expectedAcquisitionId = cleanText(
    expected.p_acquisition_id
      ?? expected.acquisitionId
      ?? expectedEvidence.source_binding?.source_acquisition_id,
  ).toLowerCase();
  const expectedRequestId = cleanText(
    expected.p_request_id
      ?? expected.requestId
      ?? expectedEvidence.source_binding?.source_page_request_id,
  ).toLowerCase();
  const expectedReason = cleanText(
    expected.p_reason_code ?? expected.reasonCode ?? expectedEvidence.reason_code,
  );
  const expectedStage = cleanText(
    expected.failureStage ?? expectedEvidence.failure_stage,
  );
  const expectedEvidenceSha256 = cleanText(
    expected.evidenceSha256 ?? expectedEvidence.evidence_sha256,
  );

  const exactKeys = [
    "audit_inserted",
    "creates_api_charge",
    "evidence_sha256",
    "failure_sha256",
    "failure_stage",
    "mutation_count_scope",
    "mutation_counts",
    "observed_at",
    "public_award_update_created",
    "public_fact_authority",
    "quarantine_id",
    "reason_code",
    "release_safety",
    "receipt_sha256",
    "recorded_at",
    "schema_version",
    "shared_award_source_id",
    "source_acquisition_id",
    "source_page_request_id",
    "source_reheld",
    "status",
  ];
  const receiptContent = cloneJson(receipt);
  const receiptSha256 = cleanText(receiptContent.receipt_sha256);
  delete receiptContent.receipt_sha256;
  const mutationCounts = receipt.mutation_counts;
  const releaseSafety = receipt.release_safety;
  const expectedFailureAuditWrites = receipt.audit_inserted === true ? 1 : 0;
  const expectedPublicationSafetyWrites = plainObject(releaseSafety)
    ? releaseSafety.stage1_award_registry_writes
      + releaseSafety.stage1_award_publication_event_writes
      + releaseSafety.stage1_release_registry_writes
      + releaseSafety.stage1_release_state_writes
      + releaseSafety.stage1_release_event_writes
    : Number.NaN;
  const expectedDatabaseWrites = expectedFailureAuditWrites
    + 1 // shared_award_sources re-hold
    + 3 // quarantine registry, audit event, and backlog revision
    + expectedPublicationSafetyWrites;
  const valid = hasExactKeys(receipt, exactKeys)
    && receipt.schema_version
      === STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUARANTINE_RECEIPT_SCHEMA
    && receipt.status === "quarantined"
    && receipt.mutation_count_scope === "quarantine_rpc_only"
    && uuidPattern.test(cleanText(receipt.quarantine_id))
    && sha256Pattern.test(cleanText(receipt.failure_sha256))
    && sha256Pattern.test(cleanText(receipt.evidence_sha256))
    && sha256Pattern.test(receiptSha256)
    && receiptSha256 === canonicalJsonSha256(receiptContent)
    && receipt.source_reheld === true
    && typeof receipt.audit_inserted === "boolean"
    && hasExactKeys(mutationCounts, [
      "candidate_writes",
      "database_writes",
      "failure_audit_writes",
      "local_baseline_writes",
      "publication_safety_writes",
      "quarantine_writes",
      "r2_writes",
      "source_state_writes",
    ])
    && hasExactKeys(releaseSafety, [
      "manual_quarantine_backlog_state_writes",
      "manual_quarantine_event_writes",
      "stage1_award_publication_event_writes",
      "stage1_award_registry_writes",
      "stage1_publication_invalidated",
      "stage1_release_event_writes",
      "stage1_release_invalidated",
      "stage1_release_registry_writes",
      "stage1_release_state_writes",
    ])
    && nonNegativeSafeInteger(releaseSafety.stage1_award_registry_writes)
    && nonNegativeSafeInteger(releaseSafety.stage1_award_publication_event_writes)
    && nonNegativeSafeInteger(releaseSafety.stage1_release_registry_writes)
    && nonNegativeSafeInteger(releaseSafety.stage1_release_state_writes)
    && nonNegativeSafeInteger(releaseSafety.stage1_release_event_writes)
    && releaseSafety.manual_quarantine_event_writes === 1
    && releaseSafety.manual_quarantine_backlog_state_writes === 1
    && releaseSafety.stage1_award_registry_writes
      === releaseSafety.stage1_award_publication_event_writes
    && releaseSafety.stage1_release_state_writes
      === releaseSafety.stage1_release_event_writes
    && releaseSafety.stage1_publication_invalidated
      === (releaseSafety.stage1_award_registry_writes > 0)
    && releaseSafety.stage1_release_invalidated
      === (
        releaseSafety.stage1_release_registry_writes > 0
        || releaseSafety.stage1_release_state_writes > 0
      )
    && mutationCounts.database_writes === expectedDatabaseWrites
    && mutationCounts.failure_audit_writes === expectedFailureAuditWrites
    && mutationCounts.publication_safety_writes === expectedPublicationSafetyWrites
    && mutationCounts.r2_writes === 0
    && mutationCounts.local_baseline_writes === 0
    && mutationCounts.candidate_writes === 0
    && mutationCounts.quarantine_writes === 3
    && mutationCounts.source_state_writes === 1
    && receipt.creates_api_charge === false
    && receipt.public_fact_authority === false
    && receipt.public_award_update_created === false
    && canonicalTimestamp(receipt.recorded_at) !== null
    && canonicalTimestamp(receipt.observed_at) !== null
    && Date.parse(receipt.observed_at) >= Date.parse(receipt.recorded_at)
    && (!expectedSourceId || receipt.shared_award_source_id === expectedSourceId)
    && (!expectedAcquisitionId || receipt.source_acquisition_id === expectedAcquisitionId)
    && (!expectedRequestId || receipt.source_page_request_id === expectedRequestId)
    && (!expectedReason || receipt.reason_code === expectedReason)
    && (!expectedStage || receipt.failure_stage === expectedStage)
    && (!expectedEvidenceSha256 || receipt.evidence_sha256 === expectedEvidenceSha256);

  if (!valid) {
    return Object.freeze({
      allowed: false,
      reason: "stage1_evidence_schema_upgrade_quarantine_receipt_invalid",
      receipt: value ?? null,
    });
  }
  return Object.freeze({
    allowed: true,
    reason: "stage1_evidence_schema_upgrade_failure_quarantined",
    quarantine_id: receipt.quarantine_id,
    failure_sha256: receipt.failure_sha256,
    evidence_sha256: receipt.evidence_sha256,
    mutation_counts: Object.freeze(cloneJson(mutationCounts)),
    receipt: Object.freeze(cloneJson(receipt)),
  });
}

function candidateValidationIdentity(value, sourceId) {
  const candidate = cloneJson(requireObject(
    value,
    "candidate artifact evidence",
  ));
  const pointerIdentity = requireObject(
    candidate.candidate_pointer_identity,
    "candidate pointer identity",
  );
  try {
    assertVisualSnapshotPointerIdentity(pointerIdentity);
  } catch (error) {
    throw new Error(`Candidate pointer identity is invalid: ${error.message}`);
  }
  const pointer = requireObject(
    pointerIdentity.projection,
    "candidate pointer projection",
  );
  const hashes = requireObject(
    pointer.latest_hashes,
    "candidate pointer latest hashes",
  );
  if (
    candidate.source_id !== sourceId
    || pointer.shared_award_source_id !== sourceId
    || candidate.kind !== pointer.kind
    || candidate.captured_at !== pointer.latest_captured_at
  ) {
    throw new Error(
      "Candidate validation preparation requires one exact source, kind, and capture generation.",
    );
  }
  return {
    candidate,
    capture: {
      source_id: pointer.shared_award_source_id,
      kind: pointer.kind,
      captured_at: pointer.latest_captured_at,
      text_hash: hashes.text_hash,
      image_hash: hashes.image_hash,
      file_hash: hashes.file_hash,
      layout_hash: hashes.layout_hash,
      candidate_pointer_sha256: pointerIdentity.canonical_sha256,
    },
    observed: {
      source_id: pointer.shared_award_source_id,
      kind: pointer.kind,
      bucket: candidate.bucket,
      version: candidate.version,
      captured_at: pointer.latest_captured_at,
      candidate_pointer_sha256: pointerIdentity.canonical_sha256,
      journal_sha256: candidate.journal_sha256,
      text_hash: hashes.text_hash,
      image_hash: hashes.image_hash,
      file_hash: hashes.file_hash,
      layout_hash: hashes.layout_hash,
    },
  };
}

function fillCandidateValidationIdentity(validation, candidateIdentity) {
  const prepared = cloneJson(validation);
  const evidence = prepared.evidence;
  fillMissingOrRequireExact(
    evidence,
    "kind",
    candidateIdentity.capture.kind,
    "validation evidence kind",
  );
  if (!Object.hasOwn(evidence, "capture")) evidence.capture = {};
  if (!plainObject(evidence.capture)) {
    throw new Error("Validation capture evidence contradicts the sealed candidate pointer.");
  }
  for (const field of [
    "source_id",
    "captured_at",
    "text_hash",
    "image_hash",
    "file_hash",
    "layout_hash",
  ]) {
    fillMissingOrRequireExact(
      evidence.capture,
      field,
      candidateIdentity.capture[field],
      `validation capture ${field}`,
    );
  }
  return prepared;
}

function normalizeMutationFailureEvidence(value) {
  const failure = requireObject(value, "mutation failure evidence");
  const operation = requiredReason(
    failure.operation,
    "mutation failure operation",
  );
  const accounting = assertStage1EvidenceSchemaUpgradeMutationAccounting(
    failure.mutation_accounting,
    { operation },
  );
  assertMutationFailureOperationProfile(accounting, operation);
  if (operation === "candidate_enqueue") {
    assertCandidateMutationAccountingEvidence(accounting);
  }
  const error = failure.error;
  if (!error || (typeof error !== "object" && typeof error !== "string")) {
    throw new Error("Mutation failure error identity is required.");
  }
  const message = requiredText(
    typeof error === "string" ? error : error.message,
    "mutation failure error message",
  );
  const errorCode = typeof error === "string" ? null : error.code;
  if (
    errorCode !== null
    && errorCode !== undefined
    && (typeof errorCode !== "string" || !cleanText(errorCode))
  ) {
    throw new Error("Mutation failure error code must be null or non-empty text.");
  }
  return {
    operation,
    error: {
      name: cleanText(typeof error === "string" ? "Error" : error.name) || "Error",
      code: nullableText(errorCode),
      message,
    },
    mutation_accounting: cloneJson(accounting),
  };
}

function assertMutationFailureOperationProfile(accounting, operation) {
  const counts = accounting.lower_bound_counts;
  const unknown = new Set(accounting.unknown_write_categories);
  if (operation === "candidate_enqueue") {
    if (
      counts.r2_writes !== 0
      || counts.local_baseline_writes !== 0
      || counts.quarantine_writes !== 0
      || counts.source_state_writes !== 0
      || counts.database_writes < counts.candidate_writes
      || [...unknown].some((category) => !new Set([
        "candidate_writes",
        "database_writes",
      ]).has(category))
    ) {
      throw new Error(
        "Candidate-enqueue mutation accounting contains out-of-scope writes or categories.",
      );
    }
    return;
  }
  if (
    operation === "pointer_commit"
    && (
      counts.candidate_writes !== 0
      || counts.quarantine_writes !== 0
      || counts.database_writes < counts.source_state_writes
      || unknown.has("candidate_writes")
      || unknown.has("quarantine_writes")
    )
  ) {
    throw new Error(
      "Pointer-commit mutation accounting contains out-of-scope candidate or quarantine writes.",
    );
  }
}

function normalizePointerCommitReceipt(value, sourceId, expectedAccounting) {
  const receipt = cloneJson(requireObject(
    value,
    "prior pointer-commit receipt",
  ));
  if (
    !hasExactKeys(receipt, [
      "authoritative_baseline_sha256",
      "authoritative_baseline_state",
      "authoritative_pointer_sha256",
      "authoritative_pointer_state",
      "cas",
      "cleanup_debt",
      "cleanup_delete_performed",
      "context",
      "creates_api_charge",
      "journal_archived",
      "journal_phase",
      "journal_sha256",
      "mutation_accounting",
      "mutation_count_scope",
      "mutation_counts",
      "operation",
      "outcome",
      "schema_version",
      "source_health",
      "source_id",
      "status",
      "transaction_id",
    ])
    || receipt.schema_version !== STAGE1_EVIDENCE_SCHEMA_UPGRADE_COMMIT_RECEIPT_SCHEMA
    || receipt.source_id !== sourceId
    || receipt.context !== upgradeContext
    || receipt.operation !== "pointer_commit"
    || receipt.status !== "recovery_required"
    || receipt.creates_api_charge !== false
    || !requiredText(receipt.transaction_id, "prior pointer-commit transaction id")
    || !requiredText(receipt.outcome, "prior pointer-commit outcome")
    || receipt.journal_phase !== "recovery_required"
    || !sha256Pattern.test(cleanText(receipt.journal_sha256))
    || receipt.journal_archived !== false
    || !requiredText(
      receipt.authoritative_pointer_state,
      "prior authoritative pointer state",
    )
    || !requiredText(
      receipt.authoritative_baseline_state,
      "prior authoritative baseline state",
    )
    || [
      receipt.authoritative_pointer_sha256,
      receipt.authoritative_baseline_sha256,
    ].some((hash) => (
      hash !== null && !sha256Pattern.test(cleanText(hash))
    ))
    || !plainObject(receipt.cas)
    || !plainObject(receipt.cleanup_debt)
    || receipt.cleanup_delete_performed !== false
    || receipt.mutation_count_scope
      !== "confirmed_io_receipts_in_this_invocation"
  ) {
    throw new Error(
      "Prior pointer-commit receipt is incomplete, contradictory, or not exactly accounting-bound.",
    );
  }
  const mutationCounts = normalizeExactMutationCounts(
    receipt.mutation_counts,
    "prior pointer-commit mutation counts",
  );
  let accounting;
  try {
    accounting = assertStage1EvidenceSchemaUpgradeMutationAccounting(
      receipt.mutation_accounting,
      { operation: "pointer_commit" },
    );
  } catch (error) {
    throw new Error(`Prior pointer-commit receipt accounting is invalid: ${error.message}`);
  }
  const cas = normalizePriorPointerCommitCas(receipt.cas);
  const cleanupDebt = normalizePriorPointerCleanupDebt(receipt.cleanup_debt);
  const accountingEvidence = objectValue(accounting.evidence);
  const sourceHealth = normalizePriorPointerSourceHealth(
    receipt.source_health,
    receipt.outcome,
    mutationCounts,
  );
  assertPriorPointerReceiptAuthority(receipt);
  if (
    !hasExactKeys(accountingEvidence, [
      "boundary",
      "cas",
      "journal_phase",
      "response_loss_possible",
    ])
    || !requiredText(
      accountingEvidence.boundary,
      "prior pointer-commit accounting boundary",
    )
    || accountingEvidence.journal_phase !== receipt.journal_phase
    || accountingEvidence.response_loss_possible !== !accounting.exact
    || canonicalJson(accountingEvidence.cas) !== canonicalJson(cas)
    || accounting.exact !== !cas.threw
    || (cas.threw
      && !accounting.unknown_write_categories.includes("database_writes"))
    || mutationCounts.source_state_writes
      !== (sourceHealth?.mutation_counts.source_state_writes ?? 0)
    || (accounting.exact
      ? mutationCounts.database_writes
        !== cas.confirmed_database_pointer_writes
          + (sourceHealth?.mutation_counts.database_writes ?? 0)
      : mutationCounts.database_writes
        < cas.confirmed_database_pointer_writes
          + (sourceHealth?.mutation_counts.database_writes ?? 0))
  ) {
    throw new Error(
      "Prior pointer-commit receipt accounting evidence does not exactly bind its journal phase, CAS receipt, and confirmed writes.",
    );
  }
  receipt.cas = cas;
  receipt.cleanup_debt = cleanupDebt;
  receipt.source_health = sourceHealth;
  if (
    canonicalJson(mutationCounts)
      !== canonicalJson(accounting.lower_bound_counts)
    || canonicalJson(accounting) !== canonicalJson(expectedAccounting)
  ) {
    throw new Error(
      "Prior pointer-commit receipt is incomplete, contradictory, or not exactly accounting-bound.",
    );
  }
  return {
    ...receipt,
    mutation_counts: cloneJson(mutationCounts),
    mutation_accounting: cloneJson(accounting),
  };
}

function assertCandidateMutationAccountingEvidence(accounting) {
  const evidence = objectValue(accounting.evidence);
  const signature = evidence.candidate_signature;
  const preWriteSignatureUnavailable = signature === null
    && evidence.boundary === "before_candidate_enqueue"
    && accounting.exact === true
    && accounting.unknown_write_categories.length === 0
    && STAGE1_EVIDENCE_SCHEMA_UPGRADE_MUTATION_COUNT_KEYS.every(
      (key) => accounting.lower_bound_counts[key] === 0,
    );
  if (
    !hasExactKeys(evidence, [
      "boundary",
      "candidate_signature",
      "response_loss_possible",
    ])
    || !requiredText(evidence.boundary, "candidate mutation boundary")
    || !(
      sha256Pattern.test(cleanText(signature))
      || preWriteSignatureUnavailable
    )
    || evidence.response_loss_possible !== !accounting.exact
  ) {
    throw new Error(
      "Candidate-enqueue mutation accounting must bind its exact candidate signature once writes may occur, or prove an exact zero-write pre-enqueue boundary, plus its response-loss state.",
    );
  }
}

function mutationOperatorAction(validation) {
  const failure = validation?.evidence?.mutation_failure;
  if (
    failure?.operation === "pointer_commit"
    && !plainObject(validation?.evidence?.pointer_commit_receipt)
  ) {
    assertStage1EvidenceSchemaUpgradeMutationAccounting(
      failure.mutation_accounting,
      { operation: "pointer_commit" },
    );
    return "verify the current pointer, baseline, source health, and any archived transaction journal against the sealed pointer-commit accounting; retry only if the commit is proven incomplete.";
  }
  if (failure?.operation !== "candidate_enqueue") return null;
  const accounting = assertStage1EvidenceSchemaUpgradeMutationAccounting(
    failure.mutation_accounting,
    { operation: "candidate_enqueue" },
  );
  assertCandidateMutationAccountingEvidence(accounting);
  if (accounting.evidence.candidate_signature === null) {
    return "repair the sealed pre-enqueue candidate preparation failure, then retry; exact accounting proves no candidate or database write was attempted.";
  }
  return `reconcile the exact visual-review candidate signature ${accounting.evidence.candidate_signature} and its current terminal/observation state before any retry; do not enqueue a duplicate.`;
}

function normalizePriorPointerCommitCas(value) {
  const cas = cloneJson(requireObject(value, "prior pointer CAS receipt"));
  const returned = cas.returned;
  const liveSettled = returned === true || returned === false;
  const threw = cas.threw === true;
  const recovered = cas.recovered === true;
  const expectedAttribution = returned === true
    ? "confirmed_by_strict_true_return"
    : threw
      ? "unattributed_after_exception"
      : returned === false
        ? "confirmed_not_written_by_this_cas"
        : "prior_invocation_not_counted";
  if (
    !hasExactKeys(cas, [
      "attempted",
      "confirmed_database_pointer_writes",
      "error_code",
      "error_message",
      "recovered",
      "returned",
      "threw",
      "write_attribution",
    ])
    || typeof cas.attempted !== "boolean"
    || !(returned === null || typeof returned === "boolean")
    || typeof cas.threw !== "boolean"
    || typeof cas.recovered !== "boolean"
    || !(
      (liveSettled
        && cas.attempted === true
        && !threw
        && !recovered
        && cas.error_code === null
        && cas.error_message === null)
      || (threw
        && cas.attempted === true
        && returned === null
        && !recovered
        && requiredText(cas.error_code, "prior pointer CAS error code")
        && requiredText(cas.error_message, "prior pointer CAS error message"))
      || (recovered
        && returned === null
        && !threw
        && cas.error_code === null
        && cas.error_message === null)
    )
    || cas.confirmed_database_pointer_writes !== (returned === true ? 1 : 0)
    || cas.write_attribution !== expectedAttribution
  ) {
    throw new Error("Prior pointer CAS receipt is malformed or contradictory.");
  }
  return cas;
}

function normalizePriorPointerCleanupDebt(value) {
  const debt = cloneJson(requireObject(
    value,
    "prior pointer cleanup debt",
  ));
  const arrays = [
    "candidate_keys",
    "protected_keys",
    "eligible_keys",
    "deferred_keys",
  ];
  if (
    !hasExactKeys(debt, [
      "candidate_keys",
      "deferred_keys",
      "delete_performed",
      "eligible_count",
      "eligible_keys",
      "item_count",
      "protected_keys",
      "reason",
      "requires_authoritative_recheck",
      "requires_published_reference_graph_check",
      "schema_version",
    ])
    || debt.schema_version !== VISUAL_SNAPSHOT_LATEST_ONLY_CLEANUP_DEBT_SCHEMA
    || !requiredText(debt.reason, "prior pointer cleanup reason")
    || debt.delete_performed !== false
    || typeof debt.requires_authoritative_recheck !== "boolean"
    || typeof debt.requires_published_reference_graph_check !== "boolean"
    || arrays.some((field) => !exactSortedUniqueTextArray(debt[field]))
    || debt.item_count !== debt.candidate_keys.length
    || debt.eligible_count !== debt.eligible_keys.length
    || !debt.protected_keys.every((key) => debt.candidate_keys.includes(key))
    || !debt.eligible_keys.every((key) => debt.candidate_keys.includes(key))
    || !debt.deferred_keys.every((key) => debt.candidate_keys.includes(key))
  ) {
    throw new Error("Prior pointer cleanup debt is malformed or contradictory.");
  }
  return debt;
}

function assertPriorPointerReceiptAuthority(receipt) {
  const pointerState = receipt.authoritative_pointer_state;
  const baselineState = receipt.authoritative_baseline_state;
  const outcome = receipt.outcome;
  const classified = new Set(["candidate", "old"]).has(pointerState);
  const hashPairValid = pointerState === "candidate"
    ? sha256Pattern.test(cleanText(receipt.authoritative_pointer_sha256))
      && sha256Pattern.test(cleanText(receipt.authoritative_baseline_sha256))
    : pointerState === "old"
      ? sha256Pattern.test(cleanText(receipt.authoritative_pointer_sha256))
        && (
          receipt.authoritative_baseline_sha256 === null
          || sha256Pattern.test(cleanText(
            receipt.authoritative_baseline_sha256,
          ))
        )
    : receipt.authoritative_pointer_sha256 === null
      && receipt.authoritative_baseline_sha256 === null;
  const outcomeValid = (
    outcome === "ambiguous_authority"
      && !classified
  ) || (
    outcome === "old_authority_convergence_failed"
      && !(pointerState === "old" && new Set(["old", "both"]).has(baselineState))
  ) || (
    new Set([
      "candidate_authority_convergence_failed",
      "authority_changed_after_source_health",
    ]).has(outcome)
      && !(
        pointerState === "candidate"
        && new Set(["candidate", "both"]).has(baselineState)
      )
  );
  if (
    !new Set([
      "both",
      "candidate",
      "old",
      "other",
      "unknown",
      "unreadable",
    ]).has(pointerState)
    || !new Set([
      "both",
      "candidate",
      "old",
      "other",
      "unknown",
      "unreadable",
    ]).has(baselineState)
    || !hashPairValid
    || !outcomeValid
  ) {
    throw new Error(
      "Prior pointer-commit recovery outcome, authority states, and hashes are contradictory.",
    );
  }
}

function normalizePriorPointerSourceHealth(value, outcome, overallCounts) {
  if (value === null) {
    if (outcome === "authority_changed_after_source_health") {
      throw new Error(
        "Authority-changed pointer receipt requires its exact source-health write receipt.",
      );
    }
    return null;
  }
  const sourceHealth = cloneJson(requireObject(
    value,
    "prior pointer source-health receipt",
  ));
  const counts = normalizeExactMutationCounts(
    sourceHealth.mutation_counts,
    "prior pointer source-health mutation counts",
  );
  if (
    outcome !== "authority_changed_after_source_health"
    || !hasExactKeys(sourceHealth, ["mutation_counts", "status"])
    || !new Set(["already_current", "succeeded"]).has(sourceHealth.status)
    || counts.r2_writes !== 0
    || counts.local_baseline_writes !== 0
    || counts.candidate_writes !== 0
    || counts.quarantine_writes !== 0
    || counts.database_writes !== counts.source_state_writes
    || STAGE1_EVIDENCE_SCHEMA_UPGRADE_MUTATION_COUNT_KEYS.some(
      (key) => overallCounts[key] < counts[key],
    )
  ) {
    throw new Error(
      "Prior pointer source-health receipt is invalid or not mutation-count bound.",
    );
  }
  return { status: sourceHealth.status, mutation_counts: counts };
}

function normalizePointerCommitJournalBinding(value, sourceId = null) {
  const binding = cloneJson(requireObject(
    value,
    "pointer-commit journal binding",
  ));
  const status = cleanText(binding.status);
  const freshStatus = cleanText(binding.fresh_journal_read_status);
  const priorSha256 = binding.prior_receipt_journal_sha256;
  const freshSha256 = binding.fresh_journal_sha256;
  const observedCandidate = normalizeObservedCandidateIdentity(
    binding.observed_candidate_identity,
    sourceId,
  );
  binding.observed_candidate_identity = observedCandidate;
  if (
    !hasExactKeys(binding, [
      "fresh_journal_read_status",
      "fresh_journal_sha256",
      "observed_candidate_identity",
      "prior_receipt_journal_sha256",
      "safe_action",
      "schema_version",
      "status",
    ])
    || binding.schema_version !== pointerJournalBindingSchema
    || !Object.hasOwn(pointerJournalSafeActions, status)
    || binding.safe_action !== pointerJournalSafeActions[status]
    || !(
      priorSha256 === null
      || sha256Pattern.test(cleanText(priorSha256))
    )
    || !new Set(["absent", "sealed_present", "unavailable"]).has(freshStatus)
    || !(
      freshSha256 === null
      || sha256Pattern.test(cleanText(freshSha256))
    )
    || (status === "same_journal"
      && !(
        freshStatus === "sealed_present"
        && priorSha256 !== null
        && freshSha256 === priorSha256
        && observedCandidate !== null
        && observedCandidate.journal_sha256 === freshSha256
      ))
    || (status === "changed_since_failure"
      && !(
        freshStatus === "sealed_present"
        && priorSha256 !== null
        && freshSha256 !== null
        && freshSha256 !== priorSha256
        && observedCandidate !== null
        && observedCandidate.journal_sha256 === freshSha256
      ))
    || (status === "prior_observation_only"
      && !(
        priorSha256 !== null
        && freshStatus === "unavailable"
        && freshSha256 === null
      ))
    || (status === "missing_since_failure"
      && !(
        priorSha256 !== null
        && freshStatus === "absent"
        && freshSha256 === null
      ))
    || (status === "fresh_observation_only"
      && !(
        priorSha256 === null
        && freshStatus === "sealed_present"
        && freshSha256 !== null
        && observedCandidate !== null
        && observedCandidate.journal_sha256 === freshSha256
      ))
    || (status === "fresh_absence_only"
      && !(
        priorSha256 === null
        && freshStatus === "absent"
        && freshSha256 === null
        && (
          observedCandidate === null
          || observedCandidate.journal_sha256 === null
        )
      ))
    || (
      freshStatus !== "sealed_present"
      && observedCandidate !== null
      && observedCandidate.journal_sha256 !== null
    )
  ) {
    throw new Error(
      "Pointer-commit journal binding is malformed or contradicts its observation status.",
    );
  }
  return binding;
}

function normalizeObservedCandidateIdentity(value, sourceId = null) {
  if (value === null) return null;
  const identity = cloneJson(requireObject(
    value,
    "observed candidate identity",
  ));
  const nullableHashes = [
    identity.text_hash,
    identity.image_hash,
    identity.file_hash,
    identity.layout_hash,
    identity.journal_sha256,
  ];
  if (
    !hasExactKeys(identity, [
      "bucket",
      "candidate_pointer_sha256",
      "captured_at",
      "file_hash",
      "image_hash",
      "journal_sha256",
      "kind",
      "layout_hash",
      "source_id",
      "text_hash",
      "version",
    ])
    || !uuidPattern.test(cleanText(identity.source_id))
    || (sourceId !== null && identity.source_id !== sourceId)
    || !candidateKinds.has(identity.kind)
    || !requiredText(identity.bucket, "observed candidate bucket")
    || !immutableGenerationPattern.test(cleanText(identity.version))
    || canonicalTimestamp(identity.captured_at) !== identity.captured_at
    || !sha256Pattern.test(cleanText(identity.candidate_pointer_sha256))
    || nullableHashes.some((hash) => (
      hash !== null && !sha256Pattern.test(cleanText(hash))
    ))
  ) {
    throw new Error(
      "Observed candidate identity is malformed or not bound to one immutable generation.",
    );
  }
  return identity;
}

function attachPointerCommitJournalBinding(
  validation,
  commitRecovery,
  candidateIdentity = null,
) {
  const prepared = cloneJson(validation);
  const evidence = prepared.evidence;
  const suppliedBinding = Object.hasOwn(
    evidence,
    "pointer_commit_journal_binding",
  )
    ? normalizePointerCommitJournalBinding(
        evidence.pointer_commit_journal_binding,
        evidence.source_id,
      )
    : null;
  const receipt = evidence.pointer_commit_receipt;
  const verifiedAbsent = plainObject(evidence.journal_read_absent);
  const bindVerifiedAbsent = verifiedAbsent
    && evidence.mutation_failure?.operation === "pointer_commit";
  if (
    plainObject(receipt)
    && commitRecovery === null
    && !plainObject(evidence.journal_read_unavailable)
    && !verifiedAbsent
  ) {
    throw new Error(
      "A prior pointer-commit receipt requires an explicit fresh journal observation: sealed present, unavailable, or verified absent.",
    );
  }
  if (!plainObject(receipt) && commitRecovery === null && !bindVerifiedAbsent) {
    if (suppliedBinding !== null) {
      throw new Error(
        "Pointer-commit journal binding requires its exact prior commit receipt.",
      );
    }
    return prepared;
  }
  const priorSha256 = plainObject(receipt) ? receipt.journal_sha256 : null;
  const freshSha256 = commitRecovery?.journal_sha256 ?? null;
  const observedCandidate = candidateIdentity?.observed ?? null;
  if (
    (freshSha256 !== null && observedCandidate === null)
    || (freshSha256 !== null
      && observedCandidate?.journal_sha256 !== freshSha256)
    || (freshSha256 === null
      && observedCandidate !== null
      && observedCandidate.journal_sha256 !== null)
  ) {
    throw new Error(
      "The observed candidate identity contradicts the fresh journal observation.",
    );
  }
  const freshJournalReadStatus = freshSha256
    ? "sealed_present"
    : plainObject(evidence.journal_read_unavailable)
      ? "unavailable"
      : "absent";
  const status = freshSha256
    ? priorSha256 === null
      ? "fresh_observation_only"
      : freshSha256 === priorSha256
        ? "same_journal"
        : "changed_since_failure"
    : priorSha256 === null
      ? "fresh_absence_only"
      : freshJournalReadStatus === "unavailable"
        ? "prior_observation_only"
        : "missing_since_failure";
  const expected = {
    schema_version: pointerJournalBindingSchema,
    status,
    prior_receipt_journal_sha256: priorSha256,
    fresh_journal_sha256: freshSha256,
    fresh_journal_read_status: freshJournalReadStatus,
    observed_candidate_identity: observedCandidate,
    safe_action: pointerJournalSafeActions[status],
  };
  if (
    suppliedBinding !== null
    && canonicalJson(suppliedBinding) !== canonicalJson(expected)
  ) {
    throw new Error(
      "Supplied pointer-commit journal binding contradicts the exact prior and fresh journal observations.",
    );
  }
  evidence.pointer_commit_journal_binding = expected;
  return prepared;
}

function assertCommitRecoveryNarrative(commitRecovery, validation) {
  if (commitRecovery === null) return;
  const receipt = validation.evidence.pointer_commit_receipt;
  const binding = validation.evidence.pointer_commit_journal_binding;
  const expectedReason = plainObject(receipt)
    && binding?.status === "same_journal"
    ? receipt.outcome
    : freshRecoveryReason;
  const expectedSafeAction = freshRecoverySafeAction;
  if (
    commitRecovery.reason !== expectedReason
    || commitRecovery.safe_action !== expectedSafeAction
  ) {
    throw new Error(
      "Fresh commit-recovery reason and safe action must exactly match the prior/fresh journal binding.",
    );
  }
  if (plainObject(receipt) && binding?.status === "same_journal") {
    assertSameJournalPointerReceiptBinding(receipt, commitRecovery.journal);
  }
}

function assertSameJournalPointerReceiptBinding(receipt, journal) {
  const pointerState = receipt.authoritative_pointer_state;
  const expectedPointerSha256 = pointerState === "candidate"
    ? journal.candidate_pointer_identity.canonical_sha256
    : pointerState === "old"
      ? journal.old_pointer_identity.canonical_sha256
      : null;
  const expectedBaselineSha256 = pointerState === "candidate"
    ? journal.candidate_baseline.sha256
    : pointerState === "old"
      ? journal.old_baseline.sha256
      : null;
  const journalCandidateKeys = [...new Set(
    Object.values(objectValue(journal.candidate_object_keys)).map(cleanText),
  )].sort();
  if (
    receipt.transaction_id !== journal.transaction_id
    || receipt.journal_phase !== journal.phase
    || receipt.authoritative_pointer_sha256 !== expectedPointerSha256
    || receipt.authoritative_baseline_sha256 !== expectedBaselineSha256
    || canonicalJson(receipt.cleanup_debt.candidate_keys)
      !== canonicalJson(journalCandidateKeys)
  ) {
    throw new Error(
      "Same-journal pointer receipt is not bound to the fresh journal transaction, phase, authority identities, baseline, and candidate cleanup keys.",
    );
  }
}

function normalizeJournalReadUnavailable(value) {
  const observation = requireObject(
    value,
    "journal-read-unavailable observation",
  );
  const allowedKeys = Object.hasOwn(observation, "journal")
    ? ["error", "journal", "status"]
    : ["error", "status"];
  const error = requireObject(
    observation.error,
    "journal-read-unavailable error identity",
  );
  if (
    !hasExactKeys(observation, allowedKeys)
    || observation.status !== "unavailable"
    || (Object.hasOwn(observation, "journal") && observation.journal !== null)
    || !hasExactKeys(error, ["code", "message", "name"])
    || !requiredText(error.name, "journal-read-unavailable error name")
    || !requiredText(error.message, "journal-read-unavailable error message")
    || !(
      error.code === null
      || (typeof error.code === "string" && cleanText(error.code))
    )
  ) {
    throw new Error(
      "Journal-read-unavailable evidence must be one exact unavailable observation and error identity.",
    );
  }
  return {
    status: "unavailable",
    error: {
      name: cleanText(error.name),
      code: nullableText(error.code),
      message: cleanText(error.message),
    },
  };
}

function normalizeJournalReadAbsent(value) {
  const observation = requireObject(
    value,
    "journal-read-absent observation",
  );
  if (
    !hasExactKeys(observation, ["error", "journal", "status"])
    || observation.status !== "absent"
    || observation.journal !== null
    || observation.error !== null
  ) {
    throw new Error(
      "Journal-read-absent evidence must be one exact successful observation with null journal and error.",
    );
  }
  return {
    status: "absent",
    journal: null,
    error: null,
  };
}

function fillMissingOrRequireExact(target, key, value, label) {
  if (!Object.hasOwn(target, key)) {
    target[key] = cloneJson(value);
    return;
  }
  if (canonicalJson(target[key]) !== canonicalJson(value)) {
    throw new Error(`${label} contradicts sealed quarantine evidence.`);
  }
}

function normalizeValidation(value, sourceId) {
  const validation = cloneJson(requireObject(value, "validation evidence"));
  const decision = cleanText(validation.decision);
  const outcome = objectValue(validation.outcome);
  const expected = {
    would_commit: decision === "eligible_unchanged_upgrade",
    would_queue_visual_candidate: decision === "material_difference_candidate",
    would_quarantine: decision === "evidence_failure_quarantine",
  };
  if (
    validation.schema_version !== STAGE1_EVIDENCE_SCHEMA_UPGRADE_VALIDATION_SCHEMA
    || !validationDecisions.has(decision)
    || validation.creates_api_charge !== false
    || outcome.would_commit !== expected.would_commit
    || outcome.would_queue_visual_candidate !== expected.would_queue_visual_candidate
    || outcome.would_quarantine !== expected.would_quarantine
    || outcome.creates_api_charge !== false
    || !Array.isArray(validation.reasons)
    || !plainObject(validation.evidence)
  ) {
    throw new Error("A complete zero-charge Stage 1 evidence-schema-upgrade validation is required.");
  }
  const evidenceSourceId = cleanText(validation.evidence.source_id);
  const nestedSourceIds = [
    [validation.evidence.capture, "capture"],
    [validation.evidence.immutable_acquisition, "immutable acquisition"],
  ];
  if (evidenceSourceId !== sourceId) {
    throw new Error("Stage 1 validation evidence belongs to another source.");
  }
  for (const [nested, label] of nestedSourceIds) {
    if (
      plainObject(nested)
      && Object.hasOwn(nested, "source_id")
      && cleanText(nested.source_id) !== sourceId
    ) {
      throw new Error(`Stage 1 validation ${label} evidence belongs to another source.`);
    }
  }
  if (Object.hasOwn(validation.evidence, "mutation_failure")) {
    validation.evidence.mutation_failure = normalizeMutationFailureEvidence(
      validation.evidence.mutation_failure,
    );
    const operation = validation.evidence.mutation_failure.operation;
    if (
      (operation === "candidate_enqueue"
        && decision !== "material_difference_candidate")
      || (operation === "pointer_commit"
        && !new Set([
          "eligible_unchanged_upgrade",
          "evidence_failure_quarantine",
        ]).has(decision))
      || !new Set(["candidate_enqueue", "pointer_commit"]).has(operation)
    ) {
      throw new Error(
        "Stage 1 mutation failure operation contradicts the validation decision that can reach it.",
      );
    }
  }
  if (Object.hasOwn(validation.evidence, "pointer_commit_receipt")) {
    if (validation.evidence.mutation_failure?.operation !== "pointer_commit") {
      throw new Error(
        "A prior pointer-commit receipt requires the exact pointer-commit mutation failure accounting.",
      );
    }
    validation.evidence.pointer_commit_receipt = normalizePointerCommitReceipt(
      validation.evidence.pointer_commit_receipt,
      sourceId,
      validation.evidence.mutation_failure.mutation_accounting,
    );
  }
  if (Object.hasOwn(validation.evidence, "pointer_commit_journal_binding")) {
    const hasReceipt = Object.hasOwn(
      validation.evidence,
      "pointer_commit_receipt",
    );
    const normalizedBinding = normalizePointerCommitJournalBinding(
      validation.evidence.pointer_commit_journal_binding,
      sourceId,
    );
    const receiptForbidden = new Set([
      "fresh_absence_only",
      "fresh_observation_only",
    ]).has(normalizedBinding.status);
    if (hasReceipt === receiptForbidden) {
      throw new Error(
        "Prior journal bindings require an exact receipt, while fresh-only observation bindings forbid one.",
      );
    }
    validation.evidence.pointer_commit_journal_binding =
      normalizedBinding;
  }
  if (Object.hasOwn(validation.evidence, "journal_read_unavailable")) {
    validation.evidence.journal_read_unavailable = normalizeJournalReadUnavailable(
      validation.evidence.journal_read_unavailable,
    );
  }
  if (Object.hasOwn(validation.evidence, "journal_read_absent")) {
    validation.evidence.journal_read_absent = normalizeJournalReadAbsent(
      validation.evidence.journal_read_absent,
    );
  }
  if (
    Object.hasOwn(validation.evidence, "journal_read_unavailable")
    && Object.hasOwn(validation.evidence, "journal_read_absent")
  ) {
    throw new Error(
      "A fresh journal read cannot be both unavailable and verified absent.",
    );
  }
  return validation;
}

function normalizeR2Binding(value, sourceId) {
  if (value === null || value === undefined) return null;
  const receipt = cloneJson(requireObject(value, "R2 binding evidence"));
  assertStage1EvidenceSchemaUpgradeR2BindingReceipt(receipt);
  if (
    receipt.schema !== STAGE1_EVIDENCE_SCHEMA_UPGRADE_R2_BINDING_SCHEMA
    || receipt.source_id !== sourceId
    || receipt.creates_api_charge !== false
    || receipt.mutation_performed !== false
  ) {
    throw new Error("Stage 1 R2 binding evidence belongs to another source or grants mutation authority.");
  }
  return receipt;
}

function normalizeCommitRecovery(value, sourceId) {
  if (value === null || value === undefined) return null;
  const recovery = cloneJson(requireObject(value, "commit recovery evidence"));
  if (
    !hasExactKeys(recovery, [
      "context",
      "creates_api_charge",
      "journal",
      "journal_sha256",
      "reason",
      "safe_action",
      "schema_version",
      "source_id",
      "status",
    ])
    || recovery.schema_version
      !== STAGE1_EVIDENCE_SCHEMA_UPGRADE_RECOVERY_EVIDENCE_SCHEMA
    ||
    recovery.source_id !== sourceId
    || recovery.context !== upgradeContext
    || recovery.creates_api_charge !== false
    || recovery.status !== "recovery_required"
    || !sha256Pattern.test(cleanText(recovery.journal_sha256))
    || !requiredText(recovery.reason, "commit recovery reason")
    || !requiredText(recovery.safe_action, "commit recovery safe action")
  ) {
    throw new Error("Commit recovery evidence must be an exact sealed, zero-charge active-journal recovery envelope for this source.");
  }
  const journal = objectValue(recovery.journal);
  try {
    assertStage1EvidenceSchemaUpgradeJournal(journal);
    assertExactRecoveryJournalEnvelope(journal);
  } catch (error) {
    throw new Error(
      `Active-journal recovery evidence is incomplete or has an invalid nested journal seal: ${error.message}`,
    );
  }
  if (
    journal.schema_version !== STAGE1_EVIDENCE_SCHEMA_UPGRADE_JOURNAL_SCHEMA
    || journal.source_id !== sourceId
    || journal.journal_sha256 !== recovery.journal_sha256
  ) {
    throw new Error("Active-journal recovery evidence is not bound to this source and journal seal.");
  }
  return recovery;
}

function assertExactRecoveryJournalEnvelope(journal) {
  if (!hasExactKeys(journal, [
    "candidate_baseline",
    "candidate_object_keys",
    "candidate_pointer_identity",
    "created_at",
    "journal_sha256",
    "old_baseline",
    "old_pointer_identity",
    "phase",
    "phase_history",
    "schema_version",
    "source_id",
    "transaction_id",
    "updated_at",
  ])) {
    throw new Error("active journal must contain only the exact sealed journal fields");
  }
  for (const [label, envelope] of [
    ["candidate baseline", journal.candidate_baseline],
    ["old baseline", journal.old_baseline],
  ]) {
    if (!hasExactKeys(envelope, [
      "byte_length",
      "bytes_base64",
      "encoding",
      "present",
      "sha256",
    ])) {
      throw new Error(`${label} must contain only the exact byte-envelope fields`);
    }
  }
  for (const [label, identity] of [
    ["candidate pointer", journal.candidate_pointer_identity],
    ["old pointer", journal.old_pointer_identity],
  ]) {
    if (!hasExactKeys(identity, [
      "canonical_sha256",
      "exists",
      "projection",
      "schema_version",
    ])) {
      throw new Error(`${label} identity must contain only the exact fields`);
    }
    if (identity.exists) {
      if (!hasExactKeys(identity.projection, visualSnapshotPointerIdentityFields)) {
        throw new Error(`${label} projection must contain only the exact pointer fields`);
      }
      assertExactPointerTimestamps(identity.projection, label);
    }
  }
  if (
    canonicalTimestamp(journal.created_at) !== journal.created_at
    || canonicalTimestamp(journal.updated_at) !== journal.updated_at
  ) {
    throw new Error("active journal timestamps must use canonical UTC milliseconds");
  }
  for (const entry of journal.phase_history) {
    if (
      !hasExactKeys(entry, ["at", "detail", "phase"])
      || canonicalTimestamp(entry.at) !== entry.at
    ) {
      throw new Error(
        "active journal phase history must contain exact fields and canonical timestamps",
      );
    }
  }
}

function assertExactPointerTimestamps(pointer, label) {
  if (
    typeof pointer.latest_captured_at !== "string"
    || canonicalTimestamp(pointer.latest_captured_at) !== pointer.latest_captured_at
    || typeof pointer.updated_at !== "string"
    || canonicalTimestamp(pointer.updated_at) !== pointer.updated_at
    || !(
      pointer.previous_captured_at === null
      || (
        typeof pointer.previous_captured_at === "string"
        && canonicalTimestamp(pointer.previous_captured_at)
          === pointer.previous_captured_at
      )
    )
  ) {
    throw new Error(`${label} timestamps must use canonical UTC milliseconds`);
  }
}

function normalizeCandidateArtifacts(value, sourceId, validation) {
  if (value === null || value === undefined) return null;
  const candidate = cloneJson(requireObject(value, "candidate artifact evidence"));
  if (
    !hasExactKeys(candidate, [
      "artifacts",
      "bucket",
      "captured_at",
      "candidate_pointer_identity",
      "creates_api_charge",
      "journal_sha256",
      "kind",
      "public_fact_authority",
      "schema_version",
      "source_id",
      "version",
    ])
    || candidate.schema_version !== STAGE1_EVIDENCE_SCHEMA_UPGRADE_CANDIDATE_ARTIFACTS_SCHEMA
    || candidate.source_id !== sourceId
    || !candidateKinds.has(candidate.kind)
    || canonicalTimestamp(candidate.captured_at) !== candidate.captured_at
    || Date.parse(candidate.captured_at) > Date.now() + candidateFutureToleranceMs
    || !requiredText(candidate.bucket, "candidate bucket")
    || !immutableGenerationPattern.test(cleanText(candidate.version))
    || !(
      candidate.journal_sha256 === null
      || sha256Pattern.test(cleanText(candidate.journal_sha256))
    )
    || candidate.creates_api_charge !== false
    || candidate.public_fact_authority !== false
    || !Array.isArray(candidate.artifacts)
    || candidate.artifacts.length === 0
  ) {
    throw new Error("Candidate artifact evidence is incomplete or belongs to another source.");
  }

  const pointerIdentity = objectValue(candidate.candidate_pointer_identity);
  if (
    !hasExactKeys(pointerIdentity, [
      "canonical_sha256",
      "exists",
      "projection",
      "schema_version",
    ])
    || pointerIdentity.schema_version !== VISUAL_SNAPSHOT_POINTER_IDENTITY_SCHEMA
    || pointerIdentity.exists !== true
    || !hasExactKeys(pointerIdentity.projection, visualSnapshotPointerIdentityFields)
  ) {
    throw new Error("Candidate artifact evidence requires one exact candidate pointer identity.");
  }
  try {
    assertVisualSnapshotPointerIdentity(pointerIdentity);
  } catch (error) {
    throw new Error(`Candidate pointer identity is invalid: ${error.message}`);
  }
  const pointer = pointerIdentity.projection;
  const pointerKeys = objectValue(pointer.latest_object_keys);
  const pointerHashes = objectValue(pointer.latest_hashes);
  const latestMetadata = objectValue(pointer.latest_metadata);
  const bindings = objectValue(latestMetadata.artifact_bindings);
  if (
    pointer.shared_award_source_id !== sourceId
    || pointer.kind !== candidate.kind
    || pointer.bucket !== candidate.bucket
    || pointer.latest_captured_at !== candidate.captured_at
    || canonicalTimestamp(pointer.updated_at) !== pointer.updated_at
    || !(
      pointer.previous_captured_at === null
      || canonicalTimestamp(pointer.previous_captured_at)
        === pointer.previous_captured_at
    )
    || latestMetadata.artifact_bindings_schema !== artifactBindingsSchema
    || !plainObject(pointer.latest_object_keys)
    || !plainObject(latestMetadata.artifact_bindings)
  ) {
    throw new Error("Candidate pointer metadata is not exactly source, kind, bucket, capture, and artifact bound.");
  }
  assertCandidateValidationCaptureBinding({
    candidate,
    pointerHashes,
    validation,
  });

  const roles = new Set();
  const keys = new Set();
  const normalizedArtifacts = [...candidate.artifacts]
    .sort((left, right) => cleanText(left?.role).localeCompare(cleanText(right?.role)));
  for (const artifact of normalizedArtifacts) {
    if (
      !hasExactKeys(artifact, [
        "bucket",
        "byte_length",
        "content_type",
        "hash_mode",
        "object_key",
        "role",
        "sha256",
        "version",
      ])
      || !requiredArtifactToken(artifact.role)
      || !requiredArtifactKey(artifact.object_key)
      || !sha256Pattern.test(cleanText(artifact.sha256))
      || !Number.isSafeInteger(artifact.byte_length)
      || artifact.byte_length <= 0
      || !contentTypePattern.test(cleanText(artifact.content_type))
      || artifact.hash_mode !== "raw_sha256"
      || artifact.bucket !== candidate.bucket
      || artifact.version !== candidate.version
      || roles.has(artifact.role)
      || keys.has(artifact.object_key)
    ) {
      throw new Error("Candidate artifact evidence contains a malformed or duplicate artifact binding.");
    }
    const contract = candidateArtifactRoleContract(artifact.role);
    const keyGeneration = immutableCandidateKeyGeneration(
      artifact.object_key,
      sourceId,
      contract?.fileName,
    );
    const pointerBinding = objectValue(bindings[artifact.role]);
    if (
      !contract
      || contract.contentType !== artifact.content_type
      || keyGeneration !== candidate.version
      || pointerKeys[artifact.role] !== artifact.object_key
      || !hasExactKeys(pointerBinding, [
        "byte_length",
        "content_type",
        "hash_mode",
        "sha256",
      ])
      || pointerBinding.sha256 !== artifact.sha256
      || pointerBinding.byte_length !== artifact.byte_length
      || pointerBinding.content_type !== artifact.content_type
      || pointerBinding.hash_mode !== artifact.hash_mode
    ) {
      throw new Error(`Candidate artifact ${artifact.role} is not exactly pointer, generation, and metadata bound.`);
    }
    roles.add(artifact.role);
    keys.add(artifact.object_key);
  }
  const exactRoles = [...roles].sort();
  if (
    canonicalJson(exactRoles) !== canonicalJson(Object.keys(pointerKeys).sort())
    || canonicalJson(exactRoles) !== canonicalJson(Object.keys(bindings).sort())
  ) {
    throw new Error("Candidate artifacts, pointer keys, and metadata bindings require one exact role set.");
  }
  assertCandidateRoleTopology(
    candidate.kind,
    exactRoles,
    latestMetadata,
    pointerHashes,
  );
  return {
    ...candidate,
    artifacts: normalizedArtifacts,
  };
}

function assertCandidateValidationCaptureBinding({
  candidate,
  pointerHashes,
  validation,
}) {
  const validationEvidence = objectValue(validation.evidence);
  const journalBinding = validationEvidence.pointer_commit_journal_binding;
  if (plainObject(journalBinding)) {
    const observed = journalBinding.observed_candidate_identity;
    const expectedObserved = {
      source_id: candidate.source_id,
      kind: candidate.kind,
      bucket: candidate.bucket,
      version: candidate.version,
      captured_at: candidate.captured_at,
      candidate_pointer_sha256:
        candidate.candidate_pointer_identity.canonical_sha256,
      journal_sha256: candidate.journal_sha256,
      text_hash: pointerHashes.text_hash,
      image_hash: pointerHashes.image_hash,
      file_hash: pointerHashes.file_hash,
      layout_hash: pointerHashes.layout_hash,
    };
    if (canonicalJson(observed) !== canonicalJson(expectedObserved)) {
      throw new Error(
        "Candidate artifact evidence is not bound to the separately observed immutable candidate generation.",
      );
    }
    if (new Set([
      "changed_since_failure",
      "fresh_observation_only",
    ]).has(journalBinding.status)) return;
  }
  const capture = objectValue(validationEvidence.capture);
  if (
    validationEvidence.kind !== candidate.kind
    || !plainObject(validationEvidence.capture)
    || capture.captured_at !== candidate.captured_at
    || capture.source_id !== candidate.source_id
  ) {
    throw new Error(
      `Candidate artifact evidence is not bound to the exact validated capture generation (${canonicalJson({
        candidate: {
          kind: candidate.kind,
          captured_at: candidate.captured_at,
          source_id: candidate.source_id,
        },
        validation: {
          kind: validationEvidence.kind ?? null,
          captured_at: capture.captured_at ?? null,
          source_id: capture.source_id ?? null,
        },
        journal_binding_status: journalBinding?.status ?? null,
      })}).`,
    );
  }
  for (const field of ["text_hash", "image_hash", "file_hash", "layout_hash"]) {
    if (
      !Object.hasOwn(capture, field)
      || pointerHashes[field] !== capture[field]
    ) {
      throw new Error(`Candidate pointer ${field} is not bound to the exact validated capture generation.`);
    }
  }
}

function assertObservedEvidence({ input, r2Binding, commitRecovery, candidateArtifacts }) {
  const observations = [
    ["r2BindingObserved", "R2 binding", r2Binding],
    ["journalObserved", "durable upgrade journal", commitRecovery],
    ["candidatePlanObserved", "candidate artifact plan", candidateArtifacts],
  ];
  for (const [field, label, evidence] of observations) {
    if (input[field] !== undefined && typeof input[field] !== "boolean") {
      throw new TypeError(`${field} must be boolean when supplied.`);
    }
    const observed = input[field] ?? evidence !== null;
    if (observed !== (evidence !== null)) {
      throw new Error(`Observed ${label} requires its exact sealed evidence, and absent evidence must be marked not observed.`);
    }
  }
  if (commitRecovery !== null && candidateArtifacts === null) {
    throw new Error("A durable upgrade journal proves a candidate plan exists, so exact candidate artifact evidence is required.");
  }
}

function buildEvidenceAvailability({
  failureStage,
  validation,
  r2Binding,
  commitRecovery,
  candidateArtifacts,
}) {
  const journalReadUnavailable = plainObject(
    validation?.evidence?.journal_read_unavailable,
  );
  const journalReadAbsent = plainObject(
    validation?.evidence?.journal_read_absent,
  );
  return {
    validation: availabilityEntry(validation, failureStage, "validation_not_observed"),
    r2_binding: availabilityEntry(
      r2Binding,
      failureStage,
      "r2_binding_not_observed_before_failure",
    ),
    commit_recovery: commitRecovery === null
      && (journalReadUnavailable || journalReadAbsent)
      ? journalReadUnavailable
        ? {
            status: "unavailable",
            at_failure_stage: failureStage,
            unavailable_reason: "durable_upgrade_journal_read_unavailable",
          }
        : {
            status: "verified_absent",
            at_failure_stage: failureStage,
            unavailable_reason: null,
          }
      : availabilityEntry(
          commitRecovery,
          failureStage,
          "durable_upgrade_journal_not_observed_before_failure",
        ),
    candidate_artifacts: availabilityEntry(
      candidateArtifacts,
      failureStage,
      "candidate_plan_not_observed_before_failure",
    ),
  };
}

function availabilityEntry(value, failureStage, unavailableReason) {
  return {
    status: value === null ? "not_observed" : "sealed_present",
    at_failure_stage: failureStage,
    unavailable_reason: value === null ? unavailableReason : null,
  };
}

function assertCandidateRecoveryBinding(candidate, recovery) {
  if (candidate === null) return;
  const expectedJournalSha256 = recovery?.journal_sha256 ?? null;
  if (candidate.journal_sha256 !== expectedJournalSha256) {
    throw new Error("Candidate artifact evidence is not bound to the observed journal state.");
  }
  if (recovery === null) return;
  const journal = recovery.journal;
  if (
    canonicalJson(candidate.candidate_pointer_identity)
      !== canonicalJson(journal.candidate_pointer_identity)
    || canonicalJson(journal.candidate_object_keys)
      !== canonicalJson(candidate.candidate_pointer_identity.projection.latest_object_keys)
  ) {
    throw new Error("Candidate artifact evidence does not match the exact sealed journal pointer identity and object keys.");
  }
}

function candidateArtifactRoleContract(role) {
  if (fixedArtifactContract[role]) return fixedArtifactContract[role];
  const page = /^expansion_state_(0[1-9]|[1-9][0-9]+)$/u.exec(role);
  if (page) {
    return {
      fileName: `expansion-state-${page[1]}.jpg`,
      contentType: "image/jpeg",
    };
  }
  const layout = /^expansion_state_(0[1-9]|[1-9][0-9]+)_layout$/u.exec(role);
  if (layout) {
    return {
      fileName: `expansion-state-${layout[1]}-layout.json`,
      contentType: "application/json; charset=utf-8",
    };
  }
  return null;
}

function immutableCandidateKeyGeneration(key, sourceId, fileName) {
  const parts = cleanText(key).split("/");
  if (
    !fileName
    || parts.length !== 6
    || parts[0] !== "visual-snapshots"
    || parts[1] !== "sources"
    || parts[2] !== sourceId
    || parts[3] !== "captures"
    || !immutableGenerationPattern.test(parts[4])
    || parts[5] !== fileName
  ) return null;
  return parts[4];
}

function assertCandidateRoleTopology(kind, roles, metadata, hashes) {
  const required = kind === "pdf"
    ? ["meta", "pdf", "text"]
    : ["meta", "page", "text", "thumb"];
  for (const role of required) {
    if (!roles.includes(role)) {
      throw new Error(`Candidate ${kind} artifact role set is missing ${role}.`);
    }
  }
  if (kind === "pdf") {
    if (canonicalJson(roles) !== canonicalJson([...required].sort())) {
      throw new Error("Candidate PDF artifact role set must be exactly meta, pdf, and text.");
    }
    const projection = objectValue(metadata.retained_artifact_projection);
    const authority = objectValue(projection.authoritative);
    if (
      !hasExactKeys(projection, [
        "authoritative",
        "kind",
        "localization_status",
        "schema",
      ])
      || !hasExactKeys(authority, [
        "expansion_state_count",
        "layout_hash",
        "layout_retained",
      ])
      || projection.schema !== "awardping.capture-retained-artifact-projection.v1"
      || projection.kind !== "pdf"
      || projection.localization_status !== "not_applicable_pdf"
      || authority.layout_retained !== false
      || authority.layout_hash !== null
      || authority.expansion_state_count !== 0
    ) {
      throw new Error("Candidate PDF retained-artifact projection is invalid.");
    }
    return;
  }
  const projection = objectValue(metadata.retained_artifact_projection);
  const authority = objectValue(projection.authoritative);
  const layoutRetained = roles.includes("layout");
  if (
    !hasExactKeys(projection, [
      "authoritative",
      "kind",
      "localization_status",
      "schema",
    ])
    || !hasExactKeys(authority, [
      "expansion_state_count",
      "layout_hash",
      "layout_retained",
    ])
    || projection.schema !== "awardping.capture-retained-artifact-projection.v1"
    || projection.kind !== "webpage"
    || authority.layout_retained !== layoutRetained
    || !Number.isSafeInteger(authority.expansion_state_count)
    || authority.expansion_state_count < 0
    || (layoutRetained
      ? projection.localization_status !== "exact_geometry_available"
        || !sha256Pattern.test(cleanText(authority.layout_hash))
        || authority.layout_hash !== hashes.layout_hash
      : projection.localization_status !== "evidence_only_geometry_unavailable"
        || authority.layout_hash !== null
        || hashes.layout_hash !== null)
  ) {
    throw new Error("Candidate webpage layout retention is not explicitly and exactly pointer-metadata bound.");
  }
  const pages = new Set();
  const layouts = new Set();
  for (const role of roles) {
    if (required.includes(role) || role === "layout") continue;
    const page = /^expansion_state_(0[1-9]|[1-9][0-9]+)$/u.exec(role);
    const layout = /^expansion_state_(0[1-9]|[1-9][0-9]+)_layout$/u.exec(role);
    if (page) pages.add(Number(page[1]));
    else if (layout) layouts.add(Number(layout[1]));
    else throw new Error(`Candidate webpage artifact role ${role} is unsupported.`);
  }
  const indexes = [...pages].sort((left, right) => left - right);
  if (
    pages.size !== layouts.size
    || indexes.some((index, offset) => index !== offset + 1 || !layouts.has(index))
    || authority.expansion_state_count !== pages.size
  ) {
    throw new Error("Candidate expansion screenshot/layout roles must be contiguous exact pairs.");
  }
}

function nullableJsonSha256(value) {
  return value === null ? null : canonicalJsonSha256(value);
}

function canonicalJsonSha256(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (plainObject(value)) {
    const keys = Object.keys(value);
    if (keys.some((key) => !asciiJsonKeyPattern.test(key))) {
      throw new TypeError("Stage 1 quarantine evidence object keys must be non-empty printable ASCII.");
    }
    return `{${keys.sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(",")}}`;
  }
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isSafeInteger(value))
  ) return JSON.stringify(value);
  throw new TypeError(
    "Stage 1 quarantine evidence must contain only null, strings, booleans, and safe integers.",
  );
}

function cloneJson(value) {
  return JSON.parse(canonicalJson(value));
}

function deepFreezeJson(value) {
  if (Array.isArray(value)) {
    value.forEach(deepFreezeJson);
  } else if (plainObject(value)) {
    Object.values(value).forEach(deepFreezeJson);
  }
  return Object.freeze(value);
}

function objectValue(value) {
  return plainObject(value) ? value : {};
}

function requireObject(value, label) {
  if (!plainObject(value)) throw new TypeError(`${label} must be an object.`);
  return value;
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  return plainObject(value)
    && canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort());
}

function requiredUuid(value, label) {
  const text = cleanText(value).toLowerCase();
  if (!uuidPattern.test(text)) throw new Error(`${label} must be a UUID.`);
  return text;
}

function requiredSha256(value, label) {
  const text = cleanText(value).toLowerCase();
  if (!sha256Pattern.test(text)) throw new Error(`${label} must be a SHA-256 digest.`);
  return text;
}

function requiredReason(value, label) {
  const text = cleanText(value).toLowerCase();
  if (!reasonPattern.test(text)) {
    throw new Error(`${label} must contain only lowercase letters, digits, and underscores.`);
  }
  return text;
}

function requiredText(value, label) {
  const text = cleanText(value);
  if (!text) throw new Error(`${label} is required.`);
  return text;
}

function nullableText(value) {
  const text = cleanText(value);
  return text || null;
}

function cleanText(value) {
  return String(value ?? "").trim();
}

function canonicalTimestamp(value) {
  const milliseconds = Date.parse(cleanText(value));
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function requiredArtifactToken(value) {
  return /^[a-z][a-z0-9_]{0,63}$/u.test(cleanText(value));
}

function requiredArtifactKey(value) {
  const key = cleanText(value);
  return Boolean(key)
    && key.length <= 1024
    && !key.startsWith("/")
    && !key.includes("\\")
    && !key.split("/").includes("..");
}

function normalizeExactMutationCounts(value, label) {
  const counts = cloneJson(requireObject(value, label));
  if (
    !hasExactKeys(
      counts,
      STAGE1_EVIDENCE_SCHEMA_UPGRADE_MUTATION_COUNT_KEYS,
    )
    || Object.values(counts).some((count) => !nonNegativeSafeInteger(count))
  ) {
    throw new Error(`${label} are invalid.`);
  }
  return counts;
}

function exactSortedUniqueTextArray(value) {
  if (
    !Array.isArray(value)
    || value.some((item) => typeof item !== "string" || !cleanText(item))
  ) return false;
  const normalized = [...new Set(value)].sort();
  return canonicalJson(value) === canonicalJson(normalized);
}

function nonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}
