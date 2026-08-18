import { createHash } from "node:crypto";
import {
  assertLatestOnlyVisualSnapshotPointerReplacement,
  assertVisualSnapshotPointerIdentity,
  visualSnapshotPointerIdentity,
  visualSnapshotPointerMatchesIdentity,
} from "./visual-snapshot-latest-only-reconciliation.mjs";

export const STAGE1_EVIDENCE_SCHEMA_UPGRADE_JOURNAL_SCHEMA =
  "awardping.stage1.evidence-schema-upgrade-journal.v1";

export const STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_JOURNAL_SCHEMA =
  "awardping.stage1.evidence-schema-upgrade-journal.v2";

export const STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_OPERATION_BINDING_SCHEMA =
  "awardping.stage1.evidence-schema-upgrade-reviewed-operation-binding.v1";

export const STAGE1_EVIDENCE_SCHEMA_UPGRADE_PRECOMMIT_SOURCE_AUTHORITY_SCHEMA =
  "awardping.stage1.evidence-schema-upgrade-reviewed-apply-source-authority.v1";

export const STAGE1_EVIDENCE_SCHEMA_UPGRADE_PRECOMMIT_SOURCE_AUTHORITY_PROJECTION_KEYS =
  Object.freeze([
    "admin_review_note",
    "admin_review_status",
    "admin_reviewed_at",
    "admin_reviewed_by",
    "consecutive_failures",
    "created_at",
    "display_title",
    "id",
    "last_checked_at",
    "last_error",
    "last_hash",
    "next_check_at",
    "page_description",
    "page_metadata",
    "page_metadata_generated_at",
    "page_metadata_model",
    "page_type",
    "reason",
    "shared_award_id",
    "shared_awards",
    "source",
    "submitted_by_user_id",
    "title",
    "updated_at",
    "url",
  ]);

export const STAGE1_EVIDENCE_SCHEMA_UPGRADE_ARCHIVED_COMPLETION_PROOF_SCHEMA =
  "awardping.stage1.evidence-schema-upgrade-archived-completion-proof.v1";

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const reviewedOperationBindingKeys = Object.freeze([
  "audit_run_id",
  "binding_sha256",
  "execution_nonce",
  "fresh_capture_result_sha256",
  "fresh_capture_sha256",
  "fresh_capture_validation_sha256",
  "fresh_validation_projection_sha256",
  "precommit_authority_receipt_sha256",
  "precommit_source_authority",
  "reviewed_apply_plan_file_sha256",
  "reviewed_apply_plan_sha256",
  "reviewed_report_attempt_id",
  "schema_version",
  "source_id",
  "transaction_id",
]);
const journalV1Keys = Object.freeze([
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
]);
const journalV2Keys = Object.freeze([
  ...journalV1Keys,
  "operation_binding",
]);

export const stage1EvidenceSchemaUpgradePhases = Object.freeze([
  "prepared",
  "local_candidate_written",
  "pointer_cas_attempted",
  "pointer_candidate_committed",
  "completed",
  "recovery_required",
]);

const phaseTransitions = new Map([
  ["prepared", new Set(["local_candidate_written", "recovery_required"])],
  ["local_candidate_written", new Set(["pointer_cas_attempted", "recovery_required"])],
  ["pointer_cas_attempted", new Set(["pointer_candidate_committed", "recovery_required"])],
  ["pointer_candidate_committed", new Set(["completed", "recovery_required"])],
  // `completed` is normally archived immediately. If the process dies in the
  // narrow pre-archive window and authority has since regressed or become
  // unreadable, the recovery runner must be able to retain it fail-closed.
  ["completed", new Set(["recovery_required"])],
  // A high-level recovery runner may leave this fail-closed state only after
  // rereading the authoritative pointer and exact journaled baseline bytes.
  // The low-level journal deliberately cannot perform those I/O-backed guards.
  ["recovery_required", new Set(["pointer_candidate_committed", "completed"])],
]);

/**
 * Constructs a write-ahead journal. Both local baselines are retained as exact
 * base64 bytes, not reserialized JSON, and both pointer states are retained as
 * canonical identities. The journal itself is content sealed.
 */
export function buildStage1EvidenceSchemaUpgradeJournal({
  transactionId,
  sourceId,
  oldBaselineBytes,
  oldPointer,
  candidateBaselineBytes,
  candidatePointer,
  operationBinding = null,
  createdAt,
} = {}) {
  const id = requiredText(transactionId, "transactionId");
  const source = requiredText(sourceId, "sourceId");
  const timestamp = requiredTimestamp(createdAt, "createdAt");
  const oldPointerIdentity = visualSnapshotPointerIdentity(oldPointer);
  const candidatePointerIdentity = visualSnapshotPointerIdentity(candidatePointer);
  if (!candidatePointerIdentity.exists) {
    throw new Error("Stage 1 evidence upgrade requires a candidate pointer.");
  }
  assertCandidatePointer(candidatePointerIdentity);
  if (oldPointerIdentity.exists) {
    assertLatestOnlyVisualSnapshotPointerReplacement(
      oldPointerIdentity.projection,
      candidatePointerIdentity.projection,
    );
  } else {
    assertAbsentOldPointerCandidateHistory(candidatePointerIdentity.projection);
  }
  assertPointerSource(oldPointerIdentity, source, "old");
  assertPointerSource(candidatePointerIdentity, source, "candidate");

  const reviewedBinding = operationBinding === null
    ? null
    : assertStage1EvidenceSchemaUpgradeReviewedOperationBinding(operationBinding);
  if (
    reviewedBinding
    && (
      reviewedBinding.source_id !== source
      || reviewedBinding.transaction_id !== id
    )
  ) {
    throw new Error(
      "Stage 1 reviewed operation binding does not match the journal source and transaction.",
    );
  }
  const journal = {
    schema_version: reviewedBinding
      ? STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_JOURNAL_SCHEMA
      : STAGE1_EVIDENCE_SCHEMA_UPGRADE_JOURNAL_SCHEMA,
    transaction_id: id,
    source_id: source,
    created_at: timestamp,
    updated_at: timestamp,
    phase: "prepared",
    old_baseline: baselineByteEnvelope(oldBaselineBytes, { required: false }),
    old_pointer_identity: oldPointerIdentity,
    candidate_baseline: baselineByteEnvelope(candidateBaselineBytes, { required: true }),
    candidate_pointer_identity: candidatePointerIdentity,
    candidate_object_keys: cloneJson(
      candidatePointerIdentity.projection.latest_object_keys,
    ),
    ...(reviewedBinding ? { operation_binding: cloneJson(reviewedBinding) } : {}),
    phase_history: [{ phase: "prepared", at: timestamp, detail: null }],
  };
  return sealJournal(journal);
}

/**
 * Builds the immutable identity that ties a reviewed apply journal to the one
 * separately reviewed plan, running audit row, execution, and fresh capture.
 */
export function buildStage1EvidenceSchemaUpgradeReviewedOperationBinding({
  sourceId,
  transactionId,
  reviewedApplyPlanFileSha256,
  reviewedApplyPlanSha256,
  auditRunId,
  executionNonce,
  reviewedReportAttemptId,
  freshCaptureSha256,
  freshCaptureResultSha256,
  freshCaptureValidationSha256,
  freshValidationProjectionSha256,
  precommitAuthorityReceiptSha256,
  precommitSourceAuthority,
} = {}) {
  const content = {
    schema_version:
      STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_OPERATION_BINDING_SCHEMA,
    source_id: requiredUuid(sourceId, "operation binding source_id"),
    transaction_id: requiredText(transactionId, "operation binding transaction_id"),
    reviewed_apply_plan_file_sha256: requiredSha256(
      reviewedApplyPlanFileSha256,
      "operation binding reviewed apply plan file SHA-256",
    ),
    reviewed_apply_plan_sha256: requiredSha256(
      reviewedApplyPlanSha256,
      "operation binding reviewed apply plan self SHA-256",
    ),
    audit_run_id: requiredUuid(auditRunId, "operation binding audit_run_id"),
    execution_nonce: requiredUuidV4(
      executionNonce,
      "operation binding execution_nonce",
    ),
    reviewed_report_attempt_id: requiredUuid(
      reviewedReportAttemptId,
      "operation binding reviewed report attempt_id",
    ),
    fresh_capture_sha256: requiredSha256(
      freshCaptureSha256,
      "operation binding fresh capture SHA-256",
    ),
    fresh_capture_result_sha256: requiredSha256(
      freshCaptureResultSha256,
      "operation binding fresh capture result SHA-256",
    ),
    fresh_capture_validation_sha256: requiredSha256(
      freshCaptureValidationSha256,
      "operation binding fresh capture validation SHA-256",
    ),
    fresh_validation_projection_sha256: requiredSha256(
      freshValidationProjectionSha256,
      "operation binding fresh validation projection SHA-256",
    ),
    precommit_authority_receipt_sha256: requiredSha256(
      precommitAuthorityReceiptSha256,
      "operation binding precommit authority receipt SHA-256",
    ),
    precommit_source_authority:
      cloneJson(assertStage1EvidenceSchemaUpgradePrecommitSourceAuthority(
        precommitSourceAuthority,
      )),
  };
  const sealed = {
    ...content,
    binding_sha256: sha256Text(stableJson(content)),
  };
  return Object.freeze(
    cloneJson(assertStage1EvidenceSchemaUpgradeReviewedOperationBinding(sealed)),
  );
}

export function assertStage1EvidenceSchemaUpgradeReviewedOperationBinding(value) {
  const binding = requirePlainObject(value, "reviewed operation binding");
  assertExactKeys(binding, reviewedOperationBindingKeys, "reviewed operation binding");
  if (
    binding.schema_version
      !== STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_OPERATION_BINDING_SCHEMA
  ) {
    throw new Error("Stage 1 reviewed operation binding schema is invalid.");
  }
  requiredUuid(binding.source_id, "operation binding source_id");
  requiredText(binding.transaction_id, "operation binding transaction_id");
  requiredSha256(
    binding.reviewed_apply_plan_file_sha256,
    "operation binding reviewed apply plan file SHA-256",
  );
  const sourceAuthority = assertStage1EvidenceSchemaUpgradePrecommitSourceAuthority(
    binding.precommit_source_authority,
  );
  if (sourceAuthority.source_id !== binding.source_id) {
    throw new Error(
      "Operation binding precommit source authority belongs to another source.",
    );
  }
  requiredSha256(
    binding.reviewed_apply_plan_sha256,
    "operation binding reviewed apply plan self SHA-256",
  );
  requiredUuid(binding.audit_run_id, "operation binding audit_run_id");
  requiredUuidV4(binding.execution_nonce, "operation binding execution_nonce");
  requiredUuid(
    binding.reviewed_report_attempt_id,
    "operation binding reviewed report attempt_id",
  );
  requiredSha256(binding.fresh_capture_sha256, "operation binding fresh capture SHA-256");
  requiredSha256(
    binding.fresh_capture_result_sha256,
    "operation binding fresh capture result SHA-256",
  );
  requiredSha256(
    binding.fresh_capture_validation_sha256,
    "operation binding fresh capture validation SHA-256",
  );
  requiredSha256(
    binding.fresh_validation_projection_sha256,
    "operation binding fresh validation projection SHA-256",
  );
  requiredSha256(
    binding.precommit_authority_receipt_sha256,
    "operation binding precommit authority receipt SHA-256",
  );
  const content = cloneJson(binding);
  delete content.binding_sha256;
  if (
    requiredSha256(binding.binding_sha256, "operation binding self SHA-256")
      !== sha256Text(stableJson(content))
  ) {
    throw new Error("Stage 1 reviewed operation binding seal is invalid.");
  }
  return binding;
}

export function stage1EvidenceSchemaUpgradeReviewedAuthorityReceiptSha256(value) {
  return sha256Text(stableJson(requirePlainObject(
    value,
    "reviewed precommit authority receipt",
  )));
}

export function buildStage1EvidenceSchemaUpgradePrecommitSourceAuthority({
  sourceId,
  sourceProjection,
} = {}) {
  const source = requiredUuid(sourceId, "precommit source authority source_id");
  const projection = cloneJson(requirePlainObject(
    sourceProjection,
    "precommit source authority projection",
  ));
  assertExactKeys(
    projection,
    STAGE1_EVIDENCE_SCHEMA_UPGRADE_PRECOMMIT_SOURCE_AUTHORITY_PROJECTION_KEYS,
    "precommit source authority projection",
  );
  if (projection.id !== source) {
    throw new Error("Precommit source authority projection belongs to another source.");
  }
  const content = {
    schema_version: STAGE1_EVIDENCE_SCHEMA_UPGRADE_PRECOMMIT_SOURCE_AUTHORITY_SCHEMA,
    source_id: source,
    projection,
    projection_sha256: sha256Text(stableJson(projection)),
  };
  return Object.freeze({
    ...content,
    source_authority_sha256: sha256Text(stableJson(content)),
  });
}

export function assertStage1EvidenceSchemaUpgradePrecommitSourceAuthority(value) {
  const authority = requirePlainObject(value, "precommit source authority");
  assertExactKeys(authority, [
    "projection",
    "projection_sha256",
    "schema_version",
    "source_id",
    "source_authority_sha256",
  ], "precommit source authority");
  const source = requiredUuid(authority.source_id, "precommit source authority source_id");
  const projection = requirePlainObject(
    authority.projection,
    "precommit source authority projection",
  );
  assertExactKeys(
    projection,
    STAGE1_EVIDENCE_SCHEMA_UPGRADE_PRECOMMIT_SOURCE_AUTHORITY_PROJECTION_KEYS,
    "precommit source authority projection",
  );
  if (
    authority.schema_version
      !== STAGE1_EVIDENCE_SCHEMA_UPGRADE_PRECOMMIT_SOURCE_AUTHORITY_SCHEMA
    || projection.id !== source
    || requiredSha256(
      authority.projection_sha256,
      "precommit source projection SHA-256",
    ) !== sha256Text(stableJson(projection))
  ) {
    throw new Error("Precommit source authority projection or identity is invalid.");
  }
  const content = cloneJson(authority);
  delete content.source_authority_sha256;
  if (
    requiredSha256(
      authority.source_authority_sha256,
      "precommit source authority SHA-256",
    )
      !== sha256Text(stableJson(content))
  ) {
    throw new Error("Precommit source authority seal is invalid.");
  }
  return authority;
}

/**
 * Advances the durable phase with an expected-phase check. This is pure: the
 * caller is responsible for atomically persisting the returned journal before
 * performing the next side effect.
 */
export function advanceStage1EvidenceSchemaUpgradeJournal(journal, {
  expectedPhase,
  nextPhase,
  at,
  detail = null,
} = {}) {
  assertStage1EvidenceSchemaUpgradeJournal(journal);
  if (journal.phase !== expectedPhase) {
    throw new Error(
      `Stage 1 evidence upgrade phase changed: expected ${expectedPhase}, observed ${journal.phase}.`,
    );
  }
  if (!phaseTransitions.get(journal.phase)?.has(nextPhase)) {
    throw new Error(`Invalid Stage 1 evidence upgrade phase transition: ${journal.phase} -> ${nextPhase}.`);
  }
  const timestamp = requiredTimestamp(at, "phase timestamp");
  if (Date.parse(timestamp) < Date.parse(journal.updated_at)) {
    throw new Error("Stage 1 evidence upgrade phase timestamp moved backwards.");
  }
  if (detail !== null && !isPlainObject(detail)) {
    throw new TypeError("Stage 1 evidence upgrade phase detail must be an object or null.");
  }
  const next = cloneJson(journal);
  delete next.journal_sha256;
  next.phase = nextPhase;
  next.updated_at = timestamp;
  next.phase_history.push({
    phase: nextPhase,
    at: timestamp,
    detail: detail === null ? null : cloneJson(detail),
  });
  return sealJournal(next);
}

export function assertStage1EvidenceSchemaUpgradeJournal(journal) {
  const value = requirePlainObject(journal, "Stage 1 evidence upgrade journal");
  const reviewed = value.schema_version
    === STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_JOURNAL_SCHEMA;
  if (
    !reviewed
    && value.schema_version !== STAGE1_EVIDENCE_SCHEMA_UPGRADE_JOURNAL_SCHEMA
  ) {
    throw new Error("Stage 1 evidence upgrade journal schema is invalid.");
  }
  if (
    stableJson(Object.keys(value).sort())
      !== stableJson([...(reviewed ? journalV2Keys : journalV1Keys)].sort())
  ) {
    throw new Error(reviewed
      ? "Stage 1 evidence upgrade v2 reviewed journal has unexpected or missing fields."
      : "active journal must contain only the exact sealed journal fields");
  }
  const transactionId = requiredText(value.transaction_id, "journal transaction_id");
  const sourceId = requiredText(value.source_id, "journal source_id");
  if (reviewed) {
    const binding = assertStage1EvidenceSchemaUpgradeReviewedOperationBinding(
      value.operation_binding,
    );
    if (
      binding.source_id !== sourceId
      || binding.transaction_id !== transactionId
    ) {
      throw new Error(
        "Stage 1 reviewed journal operation binding does not match its identity.",
      );
    }
  } else if (Object.hasOwn(value, "operation_binding")) {
    throw new Error("Stage 1 v1 journal must not contain a reviewed operation binding.");
  }
  requiredTimestamp(value.created_at, "journal created_at");
  requiredTimestamp(value.updated_at, "journal updated_at");
  if (!stage1EvidenceSchemaUpgradePhases.includes(value.phase)) {
    throw new Error("Stage 1 evidence upgrade journal phase is invalid.");
  }
  assertBaselineByteEnvelope(value.old_baseline, { required: false });
  assertBaselineByteEnvelope(value.candidate_baseline, { required: true });
  assertVisualSnapshotPointerIdentity(value.old_pointer_identity);
  assertVisualSnapshotPointerIdentity(value.candidate_pointer_identity);
  if (!value.candidate_pointer_identity.exists) {
    throw new Error("Stage 1 evidence upgrade candidate pointer identity is absent.");
  }
  assertCandidatePointer(value.candidate_pointer_identity);
  assertPointerSource(value.old_pointer_identity, sourceId, "old");
  assertPointerSource(value.candidate_pointer_identity, sourceId, "candidate");
  if (value.old_pointer_identity.exists) {
    assertLatestOnlyVisualSnapshotPointerReplacement(
      value.old_pointer_identity.projection,
      value.candidate_pointer_identity.projection,
    );
  } else {
    assertAbsentOldPointerCandidateHistory(value.candidate_pointer_identity.projection);
  }
  if (stableJson(value.candidate_object_keys) !== stableJson(
    value.candidate_pointer_identity.projection.latest_object_keys,
  )) {
    throw new Error("Stage 1 evidence upgrade candidate object keys are not pointer-bound.");
  }
  assertPhaseHistory(value);
  const expectedSeal = journalSha256(value);
  if (value.journal_sha256 !== expectedSeal) {
    throw new Error("Stage 1 evidence upgrade journal seal does not match its content.");
  }
  return value;
}

/**
 * Proves that an exact archived v2 journal reached a terminal authority and
 * that the current local baseline and pointer still match that authority.
 * The proof is read-only and content sealed; callers separately bind any R2,
 * source, acquisition, and finalization evidence.
 */
export function proveStage1EvidenceSchemaUpgradeArchivedCompletion({
  journal,
  expectedJournalSha256,
  expectedTransactionId,
  expectedOperationBinding,
  currentBaselineBytes,
  currentPointer,
} = {}) {
  const archived = assertStage1EvidenceSchemaUpgradeJournal(journal);
  if (
    archived.schema_version
      !== STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_JOURNAL_SCHEMA
  ) {
    throw new Error(
      "Reviewed archived completion proof requires a v2 operation-bound journal; v1 requires explicit operator migration.",
    );
  }
  const expectedSha = requiredSha256(
    expectedJournalSha256,
    "expected archived journal SHA-256",
  );
  const expectedTransaction = requiredText(
    expectedTransactionId,
    "expected archived transaction_id",
  );
  const expectedBinding = assertStage1EvidenceSchemaUpgradeReviewedOperationBinding(
    expectedOperationBinding,
  );
  if (
    archived.phase !== "completed"
    || archived.journal_sha256 !== expectedSha
    || archived.transaction_id !== expectedTransaction
    || stableJson(archived.operation_binding) !== stableJson(expectedBinding)
  ) {
    throw new Error("Archived reviewed journal does not match the exact recovery authority.");
  }
  const recovery = classifyStage1EvidenceSchemaUpgradeRecovery({
    journal: archived,
    currentBaselineBytes,
    currentPointer,
  });
  const terminal = archived.phase_history.at(-1)?.detail;
  let disposition;
  let authority;
  if (
    recovery.classification === "candidate"
    && ["candidate", "both"].includes(recovery.baseline_state)
    && hasExactCandidateCompletionProof(archived, terminal)
  ) {
    disposition = "archived_candidate_completed";
    authority = "candidate";
  } else if (
    recovery.classification === "old"
    && ["old", "both"].includes(recovery.baseline_state)
    && hasExactOldCompletionProof(archived, terminal)
  ) {
    disposition = "archived_old_abandoned";
    authority = "old";
  } else {
    throw new Error(
      "Archived reviewed journal does not prove an exact current terminal authority.",
    );
  }
  const content = {
    schema_version: STAGE1_EVIDENCE_SCHEMA_UPGRADE_ARCHIVED_COMPLETION_PROOF_SCHEMA,
    disposition,
    authority,
    source_id: archived.source_id,
    transaction_id: archived.transaction_id,
    journal_sha256: archived.journal_sha256,
    operation_binding_sha256: archived.operation_binding.binding_sha256,
    authoritative_pointer_sha256: authority === "candidate"
      ? archived.candidate_pointer_identity.canonical_sha256
      : archived.old_pointer_identity.canonical_sha256,
    authoritative_baseline_sha256: authority === "candidate"
      ? archived.candidate_baseline.sha256
      : archived.old_baseline.sha256,
    source_health_status: authority === "candidate"
      ? terminal.source_health_status
      : null,
    mutation_performed: false,
    creates_api_charge: false,
  };
  return Object.freeze({
    ...content,
    proof_sha256: sha256Text(stableJson(content)),
  });
}

/**
 * Classifies a crash recovery snapshot using R2's pointer as authority. A
 * split local baseline is repaired from the exact journaled bytes. Only an
 * unreadable pointer or one matching neither journaled identity is ambiguous.
 */
export function classifyStage1EvidenceSchemaUpgradeRecovery({
  journal,
  currentBaselineBytes,
  currentPointer,
} = {}) {
  assertStage1EvidenceSchemaUpgradeJournal(journal);
  const baselineState = classifyBaselineState({
    oldEnvelope: journal.old_baseline,
    candidateEnvelope: journal.candidate_baseline,
    currentBaselineBytes,
  });
  const pointerState = classifyPointerState({
    oldIdentity: journal.old_pointer_identity,
    candidateIdentity: journal.candidate_pointer_identity,
    currentPointer,
  });
  let classification;
  let reason;
  let safeAction;
  let targetBaseline;
  if (pointerState === "candidate") {
    classification = "candidate";
    reason = "authoritative_pointer_matches_candidate_identity";
    targetBaseline = journal.candidate_baseline;
    safeAction = baselineState === "candidate" || baselineState === "both"
      ? "candidate_state_current_revalidate_and_complete"
      : "write_exact_journaled_candidate_baseline_then_revalidate";
  } else if (pointerState === "old") {
    classification = "old";
    reason = "authoritative_pointer_matches_old_identity";
    targetBaseline = journal.old_baseline;
    safeAction = baselineState === "old" || baselineState === "both"
      ? "old_state_current_retry_or_abandon_transaction"
      : journal.old_baseline.present
        ? "restore_exact_journaled_old_baseline"
        : "remove_local_baseline_to_restore_journaled_absence";
  } else {
    classification = "ambiguous";
    reason = pointerState === "unknown" || pointerState === "unreadable"
      ? "authoritative_pointer_unreadable"
      : "authoritative_pointer_matches_neither_journal_identity";
    safeAction = "quarantine_and_reconcile_exact_baseline_bytes_and_pointer_identity";
    targetBaseline = null;
  }

  return {
    classification,
    reason,
    safe_action: safeAction,
    journal_phase: journal.phase,
    baseline_state: baselineState,
    pointer_state: pointerState,
    baseline_repair_required: classification !== "ambiguous"
      && ![classification, "both"].includes(baselineState),
    target_baseline_present: targetBaseline?.present ?? null,
    target_baseline_sha256: targetBaseline?.sha256 ?? null,
    candidate_object_keys: cloneJson(journal.candidate_object_keys),
  };
}

export function stage1EvidenceSchemaUpgradeBaselineBytes(envelope) {
  assertBaselineByteEnvelope(envelope, { required: false });
  return envelope.present ? Buffer.from(envelope.bytes_base64, "base64") : null;
}

function classifyBaselineState({ oldEnvelope, candidateEnvelope, currentBaselineBytes }) {
  if (currentBaselineBytes === undefined) return "unknown";
  let current;
  try {
    current = baselineByteEnvelope(currentBaselineBytes, { required: false });
  } catch {
    return "unreadable";
  }
  const matchesOld = sameBaselineEnvelope(current, oldEnvelope);
  const matchesCandidate = sameBaselineEnvelope(current, candidateEnvelope);
  if (matchesOld && matchesCandidate) return "both";
  if (matchesCandidate) return "candidate";
  if (matchesOld) return "old";
  return "other";
}

function classifyPointerState({ oldIdentity, candidateIdentity, currentPointer }) {
  if (currentPointer === undefined) return "unknown";
  let matchesOld;
  let matchesCandidate;
  try {
    matchesOld = visualSnapshotPointerMatchesIdentity(currentPointer, oldIdentity);
    matchesCandidate = visualSnapshotPointerMatchesIdentity(currentPointer, candidateIdentity);
  } catch {
    return "unreadable";
  }
  if (matchesOld && matchesCandidate) return "both";
  if (matchesCandidate) return "candidate";
  if (matchesOld) return "old";
  return "other";
}

function baselineByteEnvelope(value, { required }) {
  if (value === null) {
    if (required) throw new Error("Candidate baseline bytes are required.");
    return {
      present: false,
      encoding: null,
      bytes_base64: null,
      byte_length: 0,
      sha256: null,
    };
  }
  if (value === undefined) {
    throw new Error(required
      ? "Candidate baseline bytes are required."
      : "Old baseline bytes must be supplied as bytes or null.");
  }
  const bytes = exactBytes(value);
  if (required && bytes.byteLength === 0) {
    throw new Error("Candidate baseline bytes must not be empty.");
  }
  return {
    present: true,
    encoding: "base64",
    bytes_base64: bytes.toString("base64"),
    byte_length: bytes.byteLength,
    sha256: sha256Bytes(bytes),
  };
}

function assertBaselineByteEnvelope(envelope, { required }) {
  const value = requirePlainObject(envelope, "baseline byte envelope");
  if (value.present === false) {
    if (
      required
      || value.encoding !== null
      || value.bytes_base64 !== null
      || value.byte_length !== 0
      || value.sha256 !== null
    ) {
      throw new Error("Absent baseline byte envelope is invalid.");
    }
    return value;
  }
  if (
    value.present !== true
    || value.encoding !== "base64"
    || typeof value.bytes_base64 !== "string"
    || !Number.isSafeInteger(value.byte_length)
    || value.byte_length < (required ? 1 : 0)
    || !/^[0-9a-f]{64}$/.test(String(value.sha256 || ""))
  ) {
    throw new Error("Baseline byte envelope is invalid.");
  }
  const decoded = Buffer.from(value.bytes_base64, "base64");
  if (
    decoded.toString("base64") !== value.bytes_base64
    || decoded.byteLength !== value.byte_length
    || sha256Bytes(decoded) !== value.sha256
  ) {
    throw new Error("Baseline byte envelope bytes do not match their bindings.");
  }
  return value;
}

function sameBaselineEnvelope(left, right) {
  return left.present === right.present
    && left.byte_length === right.byte_length
    && left.sha256 === right.sha256
    && left.bytes_base64 === right.bytes_base64;
}

function assertPointerSource(identity, sourceId, label) {
  if (
    identity.exists
    && identity.projection.shared_award_source_id !== sourceId
  ) {
    throw new Error(`Stage 1 evidence upgrade ${label} pointer source does not match sourceId.`);
  }
}

function assertCandidatePointer(identity) {
  const projection = identity.projection;
  if (
    !isPlainObject(projection.latest_object_keys)
    || !Object.keys(projection.latest_object_keys).length
    || Object.values(projection.latest_object_keys).some((key) => !requiredKey(key))
  ) {
    throw new Error("Stage 1 evidence upgrade candidate pointer object keys are invalid.");
  }
  if (!projection.latest_captured_at || !projection.updated_at) {
    throw new Error("Stage 1 evidence upgrade candidate pointer timestamps are incomplete.");
  }
}

function assertAbsentOldPointerCandidateHistory(candidate) {
  if (
    candidate.previous_captured_at !== null
    || Object.keys(isPlainObject(candidate.previous_object_keys)
      ? candidate.previous_object_keys
      : {}).length
    || Object.keys(isPlainObject(candidate.previous_hashes)
      ? candidate.previous_hashes
      : {}).length
    || Object.keys(isPlainObject(candidate.previous_metadata)
      ? candidate.previous_metadata
      : {}).length
  ) {
    throw new Error("Stage 1 evidence upgrade candidate invented previous history for an absent old pointer.");
  }
}

function requiredKey(value) {
  return typeof value === "string" && Boolean(value.trim());
}

function assertPhaseHistory(journal) {
  if (!Array.isArray(journal.phase_history) || !journal.phase_history.length) {
    throw new Error("Stage 1 evidence upgrade phase history is missing.");
  }
  let prior = null;
  let priorAt = null;
  for (const [index, entry] of journal.phase_history.entries()) {
    if (!isPlainObject(entry) || !stage1EvidenceSchemaUpgradePhases.includes(entry.phase)) {
      throw new Error("Stage 1 evidence upgrade phase history entry is invalid.");
    }
    const at = requiredTimestamp(entry.at, "phase history timestamp");
    if (entry.detail !== null && !isPlainObject(entry.detail)) {
      throw new Error("Stage 1 evidence upgrade phase history detail is invalid.");
    }
    if (index === 0 && entry.phase !== "prepared") {
      throw new Error("Stage 1 evidence upgrade phase history must begin prepared.");
    }
    if (prior && !phaseTransitions.get(prior)?.has(entry.phase)) {
      throw new Error("Stage 1 evidence upgrade phase history transition is invalid.");
    }
    if (priorAt && Date.parse(at) < Date.parse(priorAt)) {
      throw new Error("Stage 1 evidence upgrade phase history moved backwards.");
    }
    prior = entry.phase;
    priorAt = at;
  }
  if (
    prior !== journal.phase
    || priorAt !== journal.updated_at
    || journal.phase_history[0].at !== journal.created_at
  ) {
    throw new Error("Stage 1 evidence upgrade phase history does not match the journal head.");
  }
}

function hasExactCandidateCompletionProof(journal, detail) {
  return isPlainObject(detail)
    && detail.outcome === "committed_candidate"
    && detail.authoritative_pointer_sha256
      === journal.candidate_pointer_identity.canonical_sha256
    && detail.authoritative_baseline_sha256 === journal.candidate_baseline.sha256
    && new Set(["succeeded", "already_current"]).has(detail.source_health_status)
    && detail.cleanup_debt_delete_performed === false;
}

function hasExactOldCompletionProof(journal, detail) {
  return isPlainObject(detail)
    && detail.outcome === "abandoned_old_authority"
    && detail.authoritative_pointer_sha256
      === journal.old_pointer_identity.canonical_sha256
    && detail.authoritative_baseline_sha256 === journal.old_baseline.sha256
    && detail.cleanup_debt_delete_performed === false;
}

function sealJournal(journal) {
  const value = cloneJson(journal);
  value.journal_sha256 = journalSha256(value);
  assertStage1EvidenceSchemaUpgradeJournal(value);
  return value;
}

function journalSha256(journal) {
  const value = cloneJson(journal);
  delete value.journal_sha256;
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

function exactBytes(value) {
  if (typeof value === "string") return Buffer.from(value, "utf8");
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new TypeError("Baseline bytes must be a string, Buffer, Uint8Array, or null.");
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function requiredText(value, label) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`${label} is required.`);
  return text;
}

function requiredSha256(value, label) {
  const text = requiredText(value, label);
  if (!SHA256_PATTERN.test(text)) throw new Error(`${label} is invalid.`);
  return text;
}

function requiredUuid(value, label) {
  const text = requiredText(value, label);
  if (!UUID_PATTERN.test(text)) throw new Error(`${label} is invalid.`);
  return text;
}

function requiredUuidV4(value, label) {
  const text = requiredText(value, label);
  if (!UUID_V4_PATTERN.test(text)) throw new Error(`${label} is invalid.`);
  return text;
}

function requiredTimestamp(value, label) {
  const text = requiredText(value, label);
  const milliseconds = Date.parse(text);
  if (!Number.isFinite(milliseconds)) throw new Error(`${label} is invalid.`);
  return new Date(milliseconds).toISOString();
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256Text(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function assertExactKeys(value, expected, label) {
  if (stableJson(Object.keys(value).sort()) !== stableJson([...expected].sort())) {
    throw new Error(`${label} has unexpected or missing fields.`);
  }
}

function requirePlainObject(value, label) {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be an object.`);
  return value;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
