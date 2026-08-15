import { createHash } from "node:crypto";
import {
  advanceStage1EvidenceSchemaUpgradeJournal,
  assertStage1EvidenceSchemaUpgradeJournal,
  buildStage1EvidenceSchemaUpgradeJournal,
  classifyStage1EvidenceSchemaUpgradeRecovery,
  stage1EvidenceSchemaUpgradeBaselineBytes,
} from "./stage1-evidence-schema-upgrade-transaction.mjs";
import {
  planLatestOnlyVisualSnapshotPointerReconciliation,
  visualSnapshotPointerIdentity,
} from "./visual-snapshot-latest-only-reconciliation.mjs";
import {
  sealStage1EvidenceSchemaUpgradeMutationAccounting,
} from "./stage1-evidence-schema-upgrade-mutation-accounting.mjs";

export const STAGE1_EVIDENCE_SCHEMA_UPGRADE_COMMIT_RECEIPT_SCHEMA =
  "awardping.stage1.evidence-schema-upgrade-commit-receipt.v1";

export const STAGE1_EVIDENCE_SCHEMA_UPGRADE_CONTEXT =
  "stage1_evidence_schema_upgrade";

/**
 * Checkpoints are test/fault-injection seams, not persistence hooks. A caller
 * may throw from one to model a process crash after the named durable boundary.
 */
export const STAGE1_EVIDENCE_SCHEMA_UPGRADE_COMMIT_BOUNDARIES = Object.freeze([
  "active_journal_checked",
  "prepared_journal_persisted",
  "candidate_artifact_uploaded",
  "candidate_artifacts_uploaded",
  "candidate_baseline_written",
  "local_candidate_phase_persisted",
  "pointer_cas_attempt_phase_persisted",
  "pointer_cas_settled",
  "authoritative_pointer_reloaded",
  "resolution_journal_persisted",
  "authoritative_baseline_repaired",
  "authoritative_state_converged",
  "source_health_succeeded",
  "completed_journal_persisted",
  "before_completed_journal_archive",
]);

const MUTATION_COUNT_KEYS = Object.freeze([
  "database_writes",
  "r2_writes",
  "local_baseline_writes",
  "candidate_writes",
  "quarantine_writes",
  "source_state_writes",
]);

const R2_ARTIFACT_BINDINGS_SCHEMA = "awardping.r2.capture-artifact-bindings.v1";
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const POINTER_HASH_FIELDS = Object.freeze([
  "body_text_hash",
  "expansion_hash",
  "file_hash",
  "image_hash",
  "layout_hash",
  "main_content_hash",
  "nav_header_footer_hash",
  "text_hash",
]);
const mutationAccountingSymbol = Symbol("stage1EvidenceSchemaUpgradeMutationAccounting");

/**
 * Commits one already-validated, unchanged Stage 1 evidence-schema upgrade.
 * All I/O is injected. The runner never deletes an object and treats the R2
 * latest pointer as the authority whenever local and remote state diverge.
 *
 * An active journal always wins over the supplied candidate inputs. Recovery
 * is completed or left durably fail-closed before a new transaction may begin.
 */
export async function runStage1EvidenceSchemaUpgradeCommit(options = {}) {
  const accounting = {
    counts: zeroMutationCounts(),
    in_flight_categories: [],
    prior_unknown_categories: [],
    boundary: "before_io",
    journal_phase: null,
  };
  try {
    return await runStage1EvidenceSchemaUpgradeCommitInternal(options, accounting);
  } catch (error) {
    const wrapped = error instanceof Error ? error : new Error(String(error));
    wrapped.stage1_mutation_accounting = sealStage1EvidenceSchemaUpgradeMutationAccounting({
      operation: "pointer_commit",
      lowerBoundCounts: accounting.counts,
      unknownWriteCategories: accounting.in_flight_categories,
      evidence: {
        boundary: accounting.boundary,
        journal_phase: accounting.journal_phase,
        response_loss_possible: accounting.in_flight_categories.length > 0,
      },
    });
    throw wrapped;
  }
}

async function runStage1EvidenceSchemaUpgradeCommitInternal({
  sourceId,
  transactionId,
  candidateBaselineBytes,
  candidatePointer,
  candidateArtifacts,
  interfaces = {},
  now = () => new Date().toISOString(),
} = {}, accounting) {
  const source = requiredText(sourceId, "sourceId");
  const io = requireBaseInterfaces(interfaces);
  const counts = accounting.counts;
  Object.defineProperty(counts, mutationAccountingSymbol, { value: accounting });
  const active = await io.loadActiveJournal({ source_id: source });
  await checkpoint(io, "active_journal_checked", {
    source_id: source,
    active_journal_present: active !== null && active !== undefined,
  });

  if (active !== null && active !== undefined) {
    const journal = assertStage1EvidenceSchemaUpgradeJournal(active);
    if (journal.source_id !== source) {
      throw new Error("Active Stage 1 evidence upgrade journal belongs to another source.");
    }
    if (!journal.old_pointer_identity.exists) {
      throw new Error(
        "Stage 1 evidence-schema upgrade recovery requires a journaled existing pointer.",
      );
    }
    return recoverJournal({ journal, io, counts, now });
  }

  requireNewCommitInterfaces(io);
  const id = requiredText(transactionId, "transactionId");
  const currentPointer = await readRequiredExistingPointer(io, source);
  const currentBaselineBytes = await readBaselineStrict(io, source);
  const artifacts = normalizeCandidateArtifacts({
    value: candidateArtifacts,
    candidatePointer,
    candidateBaselineBytes,
    sourceId: source,
  });
  let journal = buildStage1EvidenceSchemaUpgradeJournal({
    transactionId: id,
    sourceId: source,
    oldBaselineBytes: currentBaselineBytes,
    oldPointer: currentPointer,
    candidateBaselineBytes,
    candidatePointer,
    createdAt: timestamp(now),
  });

  journal = await persistJournalExactly(io, journal, null);
  await checkpoint(io, "prepared_journal_persisted", journalCheckpoint(journal));

  const uploadedKeys = [];
  for (const artifact of artifacts) {
    beginMutationAccounting(counts, ["r2_writes"], "candidate_artifact_upload", journal.phase);
    const upload = await io.uploadImmutableCandidateArtifact({
      source_id: source,
      transaction_id: journal.transaction_id,
      bucket: artifact.bucket,
      slot: artifact.slot,
      object_key: artifact.object_key,
      bytes: Buffer.from(artifact.bytes),
      byte_length: artifact.byte_length,
      sha256: artifact.sha256,
      content_type: artifact.content_type,
      immutable: true,
      creates_api_charge: false,
    });
    const receipt = normalizeArtifactUploadReceipt(upload, artifact);
    counts.r2_writes += receipt.r2_writes;
    completeMutationAccounting(counts, "candidate_artifact_upload_settled", journal.phase);
    uploadedKeys.push(artifact.object_key);
    await checkpoint(io, "candidate_artifact_uploaded", {
      ...journalCheckpoint(journal),
      slot: artifact.slot,
      object_key: artifact.object_key,
      upload_status: receipt.status,
    });
  }
  await checkpoint(io, "candidate_artifacts_uploaded", {
    ...journalCheckpoint(journal),
    uploaded_keys: [...uploadedKeys],
  });

  await writeBaselineExactly(io, {
    sourceId: source,
    bytes: stage1EvidenceSchemaUpgradeBaselineBytes(journal.candidate_baseline),
    expectedEnvelope: journal.candidate_baseline,
    counts,
  });
  await checkpoint(io, "candidate_baseline_written", journalCheckpoint(journal));

  const beforeLocalPhase = journal;
  journal = advanceStage1EvidenceSchemaUpgradeJournal(journal, {
    expectedPhase: "prepared",
    nextPhase: "local_candidate_written",
    at: transitionTimestamp(now, journal.updated_at),
    detail: {
      candidate_baseline_sha256: journal.candidate_baseline.sha256,
      uploaded_keys: [...uploadedKeys],
    },
  });
  journal = await persistJournalExactly(io, journal, beforeLocalPhase.journal_sha256);
  await checkpoint(io, "local_candidate_phase_persisted", journalCheckpoint(journal));

  const beforeCasPhase = journal;
  journal = advanceStage1EvidenceSchemaUpgradeJournal(journal, {
    expectedPhase: "local_candidate_written",
    nextPhase: "pointer_cas_attempted",
    at: transitionTimestamp(now, journal.updated_at),
    detail: {
      expected_pointer_sha256: journal.old_pointer_identity.canonical_sha256,
      candidate_pointer_sha256: journal.candidate_pointer_identity.canonical_sha256,
    },
  });
  journal = await persistJournalExactly(io, journal, beforeCasPhase.journal_sha256);
  await checkpoint(io, "pointer_cas_attempt_phase_persisted", journalCheckpoint(journal));

  const cas = await attemptPointerCas(io, journal, counts);
  if (cas.returned === true) counts.database_writes += 1;
  await checkpoint(io, "pointer_cas_settled", {
    ...journalCheckpoint(journal),
    cas: publicCasReceipt(cas),
  });

  const observed = await readRecoveryState(io, source);
  await checkpoint(io, "authoritative_pointer_reloaded", {
    ...journalCheckpoint(journal),
    pointer_readable: observed.pointer_readable,
    baseline_readable: observed.baseline_readable,
  });
  const reconciliation = reconcileJournal(journal, observed, {
    outcome: observed.pointer_readable
      ? cas.threw
        ? "ambiguous_error"
        : cas.returned
          ? "committed"
          : "cas_lost"
      : "ambiguous_error",
  });

  return resolveJournalAuthority({
    journal,
    observed,
    reconciliation,
    cas,
    io,
    counts,
    now,
  });
}

async function recoverJournal({ journal, io, counts, now }) {
  const observed = await readRecoveryState(io, journal.source_id);
  const reconciliation = reconcileJournal(journal, observed, {
    outcome: observed.pointer_readable
      ? pointerOutcomeForRecovery(journal, observed)
      : "ambiguous_error",
  });
  return resolveJournalAuthority({
    journal,
    observed,
    reconciliation,
    cas: {
      attempted: journal.phase === "pointer_cas_attempted"
        || journal.phase === "pointer_candidate_committed"
        || journal.phase === "completed"
        || journal.phase === "recovery_required",
      returned: null,
      threw: false,
      recovered: true,
      error_code: null,
      error_message: null,
    },
    io,
    counts,
    now,
  });
}

async function resolveJournalAuthority({
  journal,
  observed,
  reconciliation,
  cas,
  io,
  counts,
  now,
}) {
  const recovery = recoveryClassification(journal, observed);
  if (recovery.classification === "ambiguous") {
    const retained = await retainRecoveryRequired({
      journal,
      io,
      now,
      detail: {
        outcome: "ambiguous_authority",
        reason: recovery.reason,
        pointer_state: recovery.pointer_state,
        baseline_state: recovery.baseline_state,
      },
    });
    return buildResult({
      status: "recovery_required",
      outcome: "ambiguous_authority",
      journal: retained,
      recovery,
      reconciliation,
      cas,
      counts,
      archived: false,
      sourceHealth: null,
    });
  }
  if (recovery.classification === "old") {
    return resolveOldAuthority({
      journal,
      recovery,
      reconciliation,
      cas,
      io,
      counts,
      now,
    });
  }
  return resolveCandidateAuthority({
    journal,
    recovery,
    reconciliation,
    cas,
    io,
    counts,
    now,
  });
}

async function resolveOldAuthority({
  journal,
  recovery,
  reconciliation,
  cas,
  io,
  counts,
  now,
}) {
  let current = await retainRecoveryRequired({
    journal,
    io,
    now,
    detail: {
      outcome: "restore_old_authority",
      reason: recovery.reason,
      pointer_state: recovery.pointer_state,
      baseline_state: recovery.baseline_state,
    },
  });
  if (recovery.baseline_repair_required) {
    await writeBaselineExactly(io, {
      sourceId: current.source_id,
      bytes: stage1EvidenceSchemaUpgradeBaselineBytes(current.old_baseline),
      expectedEnvelope: current.old_baseline,
      counts,
    });
    await checkpoint(io, "authoritative_baseline_repaired", {
      ...journalCheckpoint(current),
      authority: "old",
    });
  }

  const verified = await readRecoveryState(io, current.source_id);
  const finalRecovery = recoveryClassification(current, verified);
  const finalReconciliation = finalRecovery.classification === recovery.classification
    ? reconciliation
    : reconcileJournal(current, verified, {
        outcome: verified.pointer_readable ? "cas_lost" : "ambiguous_error",
      });
  if (finalRecovery.classification === "candidate") {
    return resolveCandidateAuthority({
      journal: current,
      recovery: finalRecovery,
      reconciliation: finalReconciliation,
      cas,
      io,
      counts,
      now,
    });
  }
  if (
    finalRecovery.classification !== "old"
    || !["old", "both"].includes(finalRecovery.baseline_state)
  ) {
    current = await retainRecoveryRequired({
      journal: current,
      io,
      now,
      detail: {
        outcome: "old_authority_convergence_failed",
        reason: finalRecovery.reason,
        pointer_state: finalRecovery.pointer_state,
        baseline_state: finalRecovery.baseline_state,
      },
    });
    return buildResult({
      status: "recovery_required",
      outcome: "old_authority_convergence_failed",
      journal: current,
      recovery: finalRecovery,
      reconciliation: finalReconciliation,
      cas,
      counts,
      archived: false,
      sourceHealth: null,
    });
  }
  await checkpoint(io, "authoritative_state_converged", {
    ...journalCheckpoint(current),
    authority: "old",
  });

  const beforeComplete = current;
  current = advanceStage1EvidenceSchemaUpgradeJournal(current, {
    expectedPhase: "recovery_required",
    nextPhase: "completed",
    at: transitionTimestamp(now, current.updated_at),
    detail: {
      outcome: "abandoned_old_authority",
      authoritative_pointer_sha256: current.old_pointer_identity.canonical_sha256,
      authoritative_baseline_sha256: current.old_baseline.sha256,
      cleanup_debt_delete_performed: false,
    },
  });
  current = await persistJournalExactly(io, current, beforeComplete.journal_sha256);
  await checkpoint(io, "completed_journal_persisted", {
    ...journalCheckpoint(current),
    outcome: "abandoned_old_authority",
  });
  await archiveCompletedJournal(io, current);
  return buildResult({
    status: "abandoned_old_authority",
    outcome: "abandoned_old_authority",
    journal: current,
    recovery: finalRecovery,
    reconciliation: finalReconciliation,
    cas,
    counts,
    archived: true,
    sourceHealth: null,
  });
}

async function resolveCandidateAuthority({
  journal,
  recovery,
  reconciliation,
  cas,
  io,
  counts,
  now,
}) {
  let current = journal;
  if (current.phase === "completed" && !hasExactCandidateCompletionProof(current)) {
    current = await retainRecoveryRequired({
      journal: current,
      io,
      now,
      detail: {
        outcome: "completed_candidate_proof_invalid",
        reason: "completed_journal_missing_exact_candidate_and_source_health_binding",
      },
    });
  }
  if (current.phase !== "completed" && current.phase !== "pointer_candidate_committed") {
    if (current.phase !== "pointer_cas_attempted" && current.phase !== "recovery_required") {
      current = await retainRecoveryRequired({
        journal: current,
        io,
        now,
        detail: {
          outcome: "candidate_observed_from_pre_cas_phase",
          reason: recovery.reason,
        },
      });
    }
    const beforeCandidate = current;
    current = advanceStage1EvidenceSchemaUpgradeJournal(current, {
      expectedPhase: current.phase,
      nextPhase: "pointer_candidate_committed",
      at: transitionTimestamp(now, current.updated_at),
      detail: {
        outcome: "candidate_authority_observed",
        authoritative_pointer_sha256: current.candidate_pointer_identity.canonical_sha256,
      },
    });
    current = await persistJournalExactly(io, current, beforeCandidate.journal_sha256);
    await checkpoint(io, "resolution_journal_persisted", {
      ...journalCheckpoint(current),
      authority: "candidate",
    });
  }

  if (recovery.baseline_repair_required) {
    await writeBaselineExactly(io, {
      sourceId: current.source_id,
      bytes: stage1EvidenceSchemaUpgradeBaselineBytes(current.candidate_baseline),
      expectedEnvelope: current.candidate_baseline,
      counts,
    });
    await checkpoint(io, "authoritative_baseline_repaired", {
      ...journalCheckpoint(current),
      authority: "candidate",
    });
  }

  let verified = await readRecoveryState(io, current.source_id);
  let finalRecovery = recoveryClassification(current, verified);
  let finalReconciliation = finalRecovery.classification === recovery.classification
    ? reconciliation
    : reconcileJournal(current, verified, { outcome: "ambiguous_error" });
  if (finalRecovery.classification === "old") {
    return resolveOldAuthority({
      journal: current,
      recovery: finalRecovery,
      reconciliation: finalReconciliation,
      cas,
      io,
      counts,
      now,
    });
  }
  if (
    finalRecovery.classification !== "candidate"
    || !["candidate", "both"].includes(finalRecovery.baseline_state)
  ) {
    current = await retainRecoveryRequired({
      journal: current,
      io,
      now,
      detail: {
        outcome: "candidate_authority_convergence_failed",
        reason: finalRecovery.reason,
        pointer_state: finalRecovery.pointer_state,
        baseline_state: finalRecovery.baseline_state,
      },
    });
    return buildResult({
      status: "recovery_required",
      outcome: "candidate_authority_convergence_failed",
      journal: current,
      recovery: finalRecovery,
      reconciliation: finalReconciliation,
      cas,
      counts,
      archived: false,
      sourceHealth: null,
    });
  }
  await checkpoint(io, "authoritative_state_converged", {
    ...journalCheckpoint(current),
    authority: "candidate",
  });

  if (current.phase === "completed") {
    await archiveCompletedJournal(io, current);
    return buildResult({
      status: "upgraded",
      outcome: "candidate_authority_recovered",
      journal: current,
      recovery: finalRecovery,
      reconciliation: finalReconciliation,
      cas,
      counts,
      archived: true,
      sourceHealth: { status: "already_recorded_by_completed_journal" },
    });
  }

  beginMutationAccounting(
    counts,
    ["database_writes", "source_state_writes"],
    "source_health_update",
    current.phase,
  );
  const sourceHealth = normalizeSourceHealthReceipt(
    await requireFunction(io.markSourceHealthSucceeded, "markSourceHealthSucceeded")({
      source_id: current.source_id,
      transaction_id: current.transaction_id,
      context: STAGE1_EVIDENCE_SCHEMA_UPGRADE_CONTEXT,
      authoritative_pointer: cloneJson(current.candidate_pointer_identity.projection),
      candidate_baseline_sha256: current.candidate_baseline.sha256,
      preserve_reviewed_url: true,
      preserve_reviewed_metadata: true,
      creates_api_charge: false,
    }),
    current.source_id,
  );
  addCounts(counts, sourceHealth.mutation_counts);
  completeMutationAccounting(counts, "source_health_update_settled", current.phase);
  await checkpoint(io, "source_health_succeeded", {
    ...journalCheckpoint(current),
    source_health_status: sourceHealth.status,
  });

  // Do not terminally seal a journal if authority changed while source health
  // was being recorded. The callback was invoked only after exact convergence.
  verified = await readRecoveryState(io, current.source_id);
  finalRecovery = recoveryClassification(current, verified);
  if (finalRecovery.classification !== "candidate") {
    finalReconciliation = reconcileJournal(current, verified, {
      outcome: "ambiguous_error",
    });
  }
  if (
    finalRecovery.classification !== "candidate"
    || !["candidate", "both"].includes(finalRecovery.baseline_state)
  ) {
    current = await retainRecoveryRequired({
      journal: current,
      io,
      now,
      detail: {
        outcome: "authority_changed_after_source_health",
        pointer_state: finalRecovery.pointer_state,
        baseline_state: finalRecovery.baseline_state,
      },
    });
    return buildResult({
      status: "recovery_required",
      outcome: "authority_changed_after_source_health",
      journal: current,
      recovery: finalRecovery,
      reconciliation: finalReconciliation,
      cas,
      counts,
      archived: false,
      sourceHealth,
    });
  }

  const beforeComplete = current;
  current = advanceStage1EvidenceSchemaUpgradeJournal(current, {
    expectedPhase: "pointer_candidate_committed",
    nextPhase: "completed",
    at: transitionTimestamp(now, current.updated_at),
    detail: {
      outcome: "committed_candidate",
      authoritative_pointer_sha256: current.candidate_pointer_identity.canonical_sha256,
      authoritative_baseline_sha256: current.candidate_baseline.sha256,
      source_health_status: sourceHealth.status,
      cleanup_debt_delete_performed: false,
    },
  });
  current = await persistJournalExactly(io, current, beforeComplete.journal_sha256);
  await checkpoint(io, "completed_journal_persisted", {
    ...journalCheckpoint(current),
    outcome: "committed_candidate",
  });
  await archiveCompletedJournal(io, current);
  return buildResult({
    status: "upgraded",
    outcome: "committed_candidate",
    journal: current,
    recovery: finalRecovery,
    reconciliation: finalReconciliation,
    cas,
    counts,
    archived: true,
    sourceHealth,
  });
}

async function retainRecoveryRequired({ journal, io, now, detail }) {
  if (journal.phase === "recovery_required") {
    return journal;
  }
  const before = journal;
  const next = advanceStage1EvidenceSchemaUpgradeJournal(journal, {
    expectedPhase: journal.phase,
    nextPhase: "recovery_required",
    at: transitionTimestamp(now, journal.updated_at),
    detail,
  });
  const persisted = await persistJournalExactly(io, next, before.journal_sha256);
  await checkpoint(io, "resolution_journal_persisted", {
    ...journalCheckpoint(persisted),
    authority: "ambiguous_or_old",
  });
  return persisted;
}

async function persistJournalExactly(io, journal, expectedJournalSha256) {
  assertStage1EvidenceSchemaUpgradeJournal(journal);
  await requireFunction(
    io.persistActiveJournalAtomically,
    "persistActiveJournalAtomically",
  )({
    source_id: journal.source_id,
    transaction_id: journal.transaction_id,
    journal: cloneJson(journal),
    expected_journal_sha256: expectedJournalSha256,
  });
  const observed = await io.loadActiveJournal({ source_id: journal.source_id });
  const persisted = assertStage1EvidenceSchemaUpgradeJournal(observed);
  if (
    persisted.source_id !== journal.source_id
    || persisted.transaction_id !== journal.transaction_id
    || persisted.journal_sha256 !== journal.journal_sha256
  ) {
    throw new Error("Atomically persisted Stage 1 evidence upgrade journal did not read back exactly.");
  }
  return persisted;
}

async function archiveCompletedJournal(io, journal) {
  if (journal.phase !== "completed") {
    throw new Error("Stage 1 evidence upgrade journal cannot be archived before completion.");
  }
  await checkpoint(io, "before_completed_journal_archive", journalCheckpoint(journal));
  const receipt = await requireFunction(
    io.archiveCompletedJournalAtomically,
    "archiveCompletedJournalAtomically",
  )({
    source_id: journal.source_id,
    transaction_id: journal.transaction_id,
    journal: cloneJson(journal),
    expected_journal_sha256: journal.journal_sha256,
    creates_api_charge: false,
  });
  if (
    !isPlainObject(receipt)
    || receipt.status !== "archived"
    || receipt.source_id !== journal.source_id
    || receipt.transaction_id !== journal.transaction_id
    || receipt.journal_sha256 !== journal.journal_sha256
    || receipt.creates_api_charge !== false
  ) {
    throw new Error("Stage 1 completed-journal archive receipt is invalid.");
  }
  const archived = assertStage1EvidenceSchemaUpgradeJournal(
    await io.readArchivedJournal({
      source_id: journal.source_id,
      transaction_id: journal.transaction_id,
    }),
  );
  if (
    archived.phase !== "completed"
    || archived.source_id !== journal.source_id
    || archived.transaction_id !== journal.transaction_id
    || archived.journal_sha256 !== journal.journal_sha256
  ) {
    throw new Error("Archived Stage 1 evidence upgrade journal did not read back exactly.");
  }
  const active = await io.loadActiveJournal({ source_id: journal.source_id });
  if (active !== null && active !== undefined) {
    throw new Error("Completed Stage 1 evidence upgrade journal remained active after archive.");
  }
}

async function writeBaselineExactly(io, {
  sourceId,
  bytes,
  expectedEnvelope,
  counts,
}) {
  beginMutationAccounting(
    counts,
    ["local_baseline_writes"],
    "local_baseline_write",
  );
  await requireFunction(io.writeBaselineBytesAtomically, "writeBaselineBytesAtomically")({
    source_id: sourceId,
    bytes: bytes === null ? null : Buffer.from(bytes),
    expected_sha256: expectedEnvelope.sha256,
    expected_byte_length: expectedEnvelope.byte_length,
  });
  counts.local_baseline_writes += 1;
  const observed = await readBaselineStrict(io, sourceId);
  if (!baselineMatchesEnvelope(observed, expectedEnvelope)) {
    throw new Error("Atomically written Stage 1 baseline bytes did not read back exactly.");
  }
  completeMutationAccounting(counts, "local_baseline_write_verified");
}

async function attemptPointerCas(io, journal, counts) {
  beginMutationAccounting(
    counts,
    ["database_writes"],
    "pointer_cas_response_pending",
    journal.phase,
  );
  try {
    const returned = await requireFunction(
      io.compareAndSwapLatestPointer,
      "compareAndSwapLatestPointer",
    )({
      source_id: journal.source_id,
      transaction_id: journal.transaction_id,
      expected_pointer_identity: cloneJson(journal.old_pointer_identity),
      expected_pointer: cloneJson(journal.old_pointer_identity.projection),
      candidate_pointer_identity: cloneJson(journal.candidate_pointer_identity),
      candidate_pointer: cloneJson(journal.candidate_pointer_identity.projection),
      preserve_previous_generation: true,
      creates_api_charge: false,
    });
    if (returned !== true && returned !== false) {
      throw Object.assign(
        new Error("Latest-pointer CAS must return a strict boolean."),
        { code: "invalid_cas_result" },
      );
    }
    completeMutationAccounting(counts, "pointer_cas_response_received", journal.phase);
    return {
      attempted: true,
      returned,
      threw: false,
      recovered: false,
      error_code: null,
      error_message: null,
    };
  } catch (error) {
    return {
      attempted: true,
      returned: null,
      threw: true,
      recovered: false,
      error_code: cleanText(error?.code) || "pointer_cas_threw",
      error_message: cleanText(error?.message || error) || "Latest-pointer CAS threw.",
    };
  }
}

function reconcileJournal(journal, observed, { outcome }) {
  try {
    return planLatestOnlyVisualSnapshotPointerReconciliation({
      existing: journal.old_pointer_identity.projection,
      candidate: journal.candidate_pointer_identity.projection,
      current: observed.pointer_readable ? observed.pointer : undefined,
      outcome,
      uploadedKeys: journal.candidate_object_keys,
    });
  } catch (error) {
    if (observed.pointer_readable) throw error;
    return planLatestOnlyVisualSnapshotPointerReconciliation({
      existing: journal.old_pointer_identity.projection,
      candidate: journal.candidate_pointer_identity.projection,
      current: undefined,
      outcome: "ambiguous_error",
      uploadedKeys: journal.candidate_object_keys,
    });
  }
}

function recoveryClassification(journal, observed) {
  return classifyStage1EvidenceSchemaUpgradeRecovery({
    journal,
    currentBaselineBytes: observed.baseline_readable
      ? observed.baseline_bytes
      : { unreadable: true },
    currentPointer: observed.pointer_readable ? observed.pointer : undefined,
  });
}

async function readRecoveryState(io, sourceId) {
  let pointer;
  let pointerReadable = false;
  let pointerError = null;
  try {
    pointer = await io.readLatestPointer({ source_id: sourceId });
    visualSnapshotPointerIdentity(pointer);
    pointerReadable = true;
  } catch (error) {
    pointerError = error;
  }
  let baselineBytes;
  let baselineReadable = false;
  let baselineError = null;
  try {
    baselineBytes = await readBaselineStrict(io, sourceId);
    baselineReadable = true;
  } catch (error) {
    baselineError = error;
  }
  return {
    pointer,
    pointer_readable: pointerReadable,
    pointer_error: errorSummary(pointerError),
    baseline_bytes: baselineBytes,
    baseline_readable: baselineReadable,
    baseline_error: errorSummary(baselineError),
  };
}

async function readRequiredExistingPointer(io, sourceId) {
  const pointer = await io.readLatestPointer({ source_id: sourceId });
  const identity = visualSnapshotPointerIdentity(pointer);
  if (!identity.exists) {
    throw new Error("Stage 1 evidence-schema upgrade requires an existing latest pointer.");
  }
  if (identity.projection.shared_award_source_id !== sourceId) {
    throw new Error("Existing Stage 1 latest pointer belongs to another source.");
  }
  return identity.projection;
}

async function readBaselineStrict(io, sourceId) {
  const value = await io.readBaselineBytes({ source_id: sourceId });
  if (value === null) return null;
  if (typeof value === "string") return Buffer.from(value, "utf8");
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new TypeError("Baseline reader must return exact bytes or null.");
}

function normalizeCandidateArtifacts({
  value,
  candidatePointer,
  candidateBaselineBytes,
  sourceId,
}) {
  if (!isPlainObject(value)) {
    throw new TypeError("candidateArtifacts must be an object keyed by pointer slot.");
  }
  const pointerIdentity = visualSnapshotPointerIdentity(candidatePointer);
  if (!pointerIdentity.exists) throw new Error("Candidate pointer is required.");
  const pointer = pointerIdentity.projection;
  const bucket = requiredText(pointer.bucket, "candidate pointer bucket");
  const kind = pointer.kind;
  if (!new Set(["webpage", "pdf"]).has(kind)) {
    throw new Error("Candidate pointer kind must be webpage or pdf.");
  }
  const keys = pointer.latest_object_keys;
  if (!isPlainObject(keys) || !Object.keys(keys).length) {
    throw new Error("Candidate pointer has no immutable object keys.");
  }
  const latestMetadata = pointer.latest_metadata;
  if (
    !isPlainObject(latestMetadata)
    || latestMetadata.artifact_bindings_schema !== R2_ARTIFACT_BINDINGS_SCHEMA
    || !isPlainObject(latestMetadata.artifact_bindings)
  ) {
    throw new Error("Candidate pointer has no exact supported artifact-binding schema.");
  }
  const bindings = latestMetadata.artifact_bindings;
  const slots = Object.keys(keys).sort();
  if (
    stableJson(Object.keys(value).sort()) !== stableJson(slots)
    || stableJson(Object.keys(bindings).sort()) !== stableJson(slots)
  ) {
    throw new Error(
      "Candidate artifacts, pointer object keys, and artifact bindings must have one exact role set.",
    );
  }
  assertCandidateArtifactRoleTopology(kind, slots);
  const objectKeys = slots.map((slot) => requiredText(keys[slot], `candidate object key ${slot}`));
  if (new Set(objectKeys).size !== objectKeys.length) {
    throw new Error("Candidate pointer immutable object keys must be unique.");
  }
  const artifacts = slots.map((slot) => {
    const supplied = candidateArtifactValue(value[slot], slot);
    const bytes = supplied.bytes;
    if (!bytes.byteLength) throw new Error(`Candidate artifact ${slot} must not be empty.`);
    const expectedContentType = candidateArtifactContentType(slot);
    if (supplied.content_type && supplied.content_type !== expectedContentType) {
      throw new Error(`Candidate artifact ${slot} content type is not canonical.`);
    }
    const expectedBinding = {
      sha256: sha256Bytes(bytes),
      byte_length: bytes.byteLength,
      content_type: expectedContentType,
      hash_mode: "raw_sha256",
    };
    if (stableJson(bindings[slot]) !== stableJson(expectedBinding)) {
      throw new Error(`Candidate pointer artifact binding for ${slot} does not match its exact bytes.`);
    }
    return Object.freeze({
      bucket,
      slot,
      object_key: keys[slot],
      bytes,
      byte_length: bytes.byteLength,
      sha256: expectedBinding.sha256,
      content_type: expectedContentType,
    });
  });
  assertCandidateCoreIdentity({
    sourceId,
    pointer,
    baselineBytes: candidateBaselineBytes,
    artifacts,
  });
  return artifacts;
}

function candidateArtifactValue(value, slot) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array || typeof value === "string") {
    return { bytes: exactBytes(value, `candidate artifact ${slot}`), content_type: null };
  }
  if (!isPlainObject(value) || !Object.hasOwn(value, "bytes")) {
    throw new TypeError(`candidate artifact ${slot} must supply exact bytes.`);
  }
  return {
    bytes: exactBytes(value.bytes, `candidate artifact ${slot}`),
    content_type: cleanText(value.content_type ?? value.contentType) || null,
  };
}

function candidateArtifactContentType(slot) {
  if (
    new Set(["page", "thumb"]).has(slot)
    || /^expansion_state_(0[1-9]|[1-9][0-9]+)$/u.test(slot)
  ) return "image/jpeg";
  if (slot === "pdf") return "application/pdf";
  if (slot === "text") return "text/plain; charset=utf-8";
  if (
    new Set(["layout", "meta"]).has(slot)
    || /^expansion_state_(0[1-9]|[1-9][0-9]+)_layout$/u.test(slot)
  ) return "application/json; charset=utf-8";
  throw new Error(`Candidate artifact role ${slot} is unsupported.`);
}

function assertCandidateArtifactRoleTopology(kind, slots) {
  const required = kind === "pdf"
    ? ["meta", "pdf", "text"]
    : ["layout", "meta", "page", "text", "thumb"];
  for (const role of required) {
    if (!slots.includes(role)) {
      throw new Error(`Candidate ${kind} artifact role set is missing ${role}.`);
    }
  }
  if (kind === "pdf") {
    if (stableJson(slots) !== stableJson([...required].sort())) {
      throw new Error("Candidate PDF artifact role set must be exactly meta, pdf, and text.");
    }
    return;
  }
  const pages = new Set();
  const layouts = new Set();
  for (const slot of slots) {
    if (required.includes(slot)) continue;
    const page = slot.match(/^expansion_state_(0[1-9]|[1-9][0-9]+)$/u);
    const layout = slot.match(/^expansion_state_(0[1-9]|[1-9][0-9]+)_layout$/u);
    if (page) pages.add(Number(page[1]));
    else if (layout) layouts.add(Number(layout[1]));
    else throw new Error(`Candidate webpage artifact role ${slot} is unsupported.`);
  }
  const indexes = [...pages].sort((left, right) => left - right);
  if (
    pages.size !== layouts.size
    || indexes.some((index, offset) => index !== offset + 1 || !layouts.has(index))
  ) {
    throw new Error("Candidate expansion screenshot/layout roles must be contiguous exact pairs.");
  }
}

function assertCandidateCoreIdentity({ sourceId, pointer, baselineBytes, artifacts }) {
  const baseline = parseJsonBytes(baselineBytes, "candidate baseline");
  const byRole = new Map(artifacts.map((artifact) => [artifact.slot, artifact]));
  const kind = pointer.kind;
  if (
    baseline.kind !== kind
    || cleanText(baseline.source?.id) !== sourceId
    || canonicalTimestampOrNull(baseline.captured_at) !== pointer.latest_captured_at
  ) {
    throw new Error("Candidate baseline identity does not match its latest pointer.");
  }
  const primaryRole = kind === "pdf" ? "pdf" : "page";
  const primaryField = kind === "pdf" ? "file_hash" : "image_hash";
  const primaryHash = requiredSha256(baseline[primaryField], `candidate baseline ${primaryField}`);
  if (byRole.get(primaryRole)?.sha256 !== primaryHash) {
    throw new Error(`Candidate ${primaryRole} bytes do not match baseline ${primaryField}.`);
  }
  const semanticText = decodeWriterText(byRole.get("text")?.bytes);
  const semanticTextHash = sha256Bytes(Buffer.from(semanticText, "utf8"));
  if (
    semanticTextHash !== requiredSha256(baseline.text_hash, "candidate baseline text_hash")
    || !Number.isSafeInteger(baseline.text_length)
    || baseline.text_length !== semanticText.length
  ) {
    throw new Error("Candidate text bytes do not match baseline semantic text identity.");
  }

  const expectedHashes = {
    image_hash: kind === "webpage" ? primaryHash : null,
    text_hash: semanticTextHash,
    body_text_hash: kind === "webpage"
      ? optionalSha256(baseline.body_text_hash, "candidate baseline body_text_hash")
      : null,
    main_content_hash: kind === "webpage"
      ? optionalSha256(baseline.main_content_hash, "candidate baseline main_content_hash")
      : null,
    nav_header_footer_hash: kind === "webpage"
      ? optionalSha256(
          baseline.nav_header_footer_hash,
          "candidate baseline nav_header_footer_hash",
        )
      : null,
    expansion_hash: kind === "webpage"
      ? optionalSha256(baseline.expansion_hash, "candidate baseline expansion_hash")
      : null,
    layout_hash: kind === "webpage"
      ? requiredSha256(baseline.layout_hash, "candidate baseline layout_hash")
      : null,
    file_hash: kind === "pdf" ? primaryHash : null,
  };
  const pointerHashes = pointer.latest_hashes;
  if (
    !isPlainObject(pointerHashes)
    || stableJson(Object.keys(pointerHashes).sort())
      !== stableJson([...POINTER_HASH_FIELDS].sort())
    || stableJson(pointerHashes) !== stableJson(expectedHashes)
  ) {
    throw new Error("Candidate pointer latest_hashes do not exactly match the candidate baseline.");
  }

  const metadata = pointer.latest_metadata;
  const primaryLengthField = kind === "pdf" ? "file_bytes" : "page_bytes";
  if (
    metadata.text_length !== semanticText.length
    || metadata.text_object_bytes !== byRole.get("text").byte_length
    || metadata[primaryLengthField] !== byRole.get(primaryRole).byte_length
  ) {
    throw new Error("Candidate pointer metadata byte and semantic lengths are not artifact-bound.");
  }
  if (kind === "webpage") {
    if (
      metadata.thumb_bytes !== byRole.get("thumb").byte_length
      || metadata.layout_hash !== expectedHashes.layout_hash
    ) {
      throw new Error("Candidate webpage pointer metadata does not match retained artifacts.");
    }
    const layout = parseJsonBytes(byRole.get("layout").bytes, "candidate layout");
    if (
      layout.geometry_hash !== expectedHashes.layout_hash
      || layout.screenshot?.image_hash !== expectedHashes.image_hash
    ) {
      throw new Error("Candidate layout does not match baseline geometry and screenshot identity.");
    }
  }
  const rawMetadata = parseJsonBytes(byRole.get("meta").bytes, "candidate capture metadata");
  if (
    rawMetadata.kind !== kind
    || cleanText(rawMetadata.source?.id) !== sourceId
    || canonicalTimestampOrNull(rawMetadata.captured_at) !== pointer.latest_captured_at
    || rawMetadata.text_hash !== expectedHashes.text_hash
    || rawMetadata[primaryField] !== expectedHashes[primaryField]
  ) {
    throw new Error("Candidate raw metadata does not match baseline core identity.");
  }
}

function decodeWriterText(bytes) {
  if (!bytes) throw new Error("Candidate text artifact is missing.");
  let raw;
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Candidate text artifact is not valid UTF-8.");
  }
  const text = raw.endsWith("\r\n")
    ? raw.slice(0, -2)
    : raw.endsWith("\n")
      ? raw.slice(0, -1)
      : null;
  if (text === null || text.endsWith("\n") || text.endsWith("\r")) {
    throw new Error("Candidate text artifact must have exactly one writer framing newline.");
  }
  return text;
}

function parseJsonBytes(value, label) {
  const bytes = exactBytes(value, label);
  try {
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!isPlainObject(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new Error(`${label} must be a valid UTF-8 JSON object.`);
  }
}

function requiredSha256(value, label) {
  const hash = cleanText(value).toLowerCase();
  if (!SHA256_PATTERN.test(hash)) throw new Error(`${label} must be a SHA-256 hash.`);
  return hash;
}

function optionalSha256(value, label) {
  if (value === null || value === undefined || value === "") return null;
  return requiredSha256(value, label);
}

function canonicalTimestampOrNull(value) {
  const milliseconds = Date.parse(cleanText(value));
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function normalizeArtifactUploadReceipt(value, artifact) {
  if (!isPlainObject(value)) {
    throw new Error("Immutable candidate upload must return a verification receipt.");
  }
  const status = cleanText(value.status);
  const expectedWrites = status === "uploaded"
    ? 1
    : status === "existing_verified"
      ? 0
      : null;
  if (
    expectedWrites === null
    || value.creates_api_charge !== false
    || value.immutable !== true
    || value.bucket !== artifact.bucket
    || value.object_key !== artifact.object_key
    || value.sha256 !== artifact.sha256
    || value.byte_length !== artifact.byte_length
    || value.content_type !== artifact.content_type
    || value.r2_writes !== expectedWrites
  ) {
    throw new Error("Immutable candidate upload receipt is not exactly artifact-bound.");
  }
  return Object.freeze({ status, r2_writes: expectedWrites });
}

function normalizeSourceHealthReceipt(value, sourceId) {
  if (!isPlainObject(value)) {
    throw new Error("Stage 1 source-health update must return a receipt.");
  }
  const status = cleanText(value.status);
  if (
    !new Set(["succeeded", "already_current"]).has(status)
    || value.source_id !== sourceId
    || value.context !== STAGE1_EVIDENCE_SCHEMA_UPGRADE_CONTEXT
    || value.creates_api_charge !== false
  ) {
    throw new Error("Stage 1 source-health receipt identity is invalid.");
  }
  const counts = normalizeMutationCounts(value.mutation_counts);
  if (
    counts.r2_writes !== 0
    || counts.local_baseline_writes !== 0
    || counts.candidate_writes !== 0
    || counts.quarantine_writes !== 0
    || counts.database_writes !== counts.source_state_writes
  ) {
    throw new Error("Stage 1 source-health receipt contains out-of-scope mutations.");
  }
  return Object.freeze({ status, mutation_counts: counts });
}

function buildResult({
  status,
  outcome,
  journal,
  recovery,
  reconciliation,
  cas,
  counts,
  archived,
  sourceHealth,
}) {
  const mutationCounts = normalizeMutationCounts(counts);
  const accountingState = mutationAccountingForCounts(counts);
  const mutationAccounting = sealStage1EvidenceSchemaUpgradeMutationAccounting({
    operation: "pointer_commit",
    lowerBoundCounts: mutationCounts,
    unknownWriteCategories: accountingState?.in_flight_categories || [],
    evidence: {
      boundary: accountingState?.boundary || "result_built",
      journal_phase: journal.phase,
      response_loss_possible:
        Boolean(accountingState?.in_flight_categories?.length),
      cas: publicCasReceipt(cas),
    },
  });
  const receipt = Object.freeze({
    schema_version: STAGE1_EVIDENCE_SCHEMA_UPGRADE_COMMIT_RECEIPT_SCHEMA,
    source_id: journal.source_id,
    context: STAGE1_EVIDENCE_SCHEMA_UPGRADE_CONTEXT,
    operation: "pointer_commit",
    status,
    creates_api_charge: false,
    transaction_id: journal.transaction_id,
    outcome,
    journal_phase: journal.phase,
    journal_sha256: journal.journal_sha256,
    journal_archived: archived,
    authoritative_pointer_state: recovery.pointer_state,
    authoritative_baseline_state: recovery.baseline_state,
    authoritative_pointer_sha256: recovery.classification === "candidate"
      ? journal.candidate_pointer_identity.canonical_sha256
      : recovery.classification === "old"
        ? journal.old_pointer_identity.canonical_sha256
        : null,
    authoritative_baseline_sha256: recovery.classification === "candidate"
      ? journal.candidate_baseline.sha256
      : recovery.classification === "old"
        ? journal.old_baseline.sha256
        : null,
    cas: publicCasReceipt(cas),
    cleanup_debt: cloneJson(reconciliation.cleanup_debt),
    cleanup_delete_performed: false,
    source_health: sourceHealth ? cloneJson(sourceHealth) : null,
    mutation_count_scope: "confirmed_io_receipts_in_this_invocation",
    mutation_counts: mutationCounts,
    mutation_accounting: mutationAccounting,
  });
  return Object.freeze({
    status,
    source_id: journal.source_id,
    context: STAGE1_EVIDENCE_SCHEMA_UPGRADE_CONTEXT,
    creates_api_charge: false,
    mutation_counts: mutationCounts,
    mutation_accounting: mutationAccounting,
    mutation_count_certainty: Object.freeze({
      exact: mutationAccounting.exact,
      count_semantics: mutationAccounting.exact
        ? "exact"
        : "confirmed_lower_bounds_with_unknown_writes",
      unknown_write_categories: mutationAccounting.unknown_write_categories,
    }),
    receipt,
  });
}

function pointerOutcomeForRecovery(journal, observed) {
  const state = recoveryClassification(journal, observed);
  return state.classification === "old" ? "cas_lost" : "ambiguous_error";
}

function requireBaseInterfaces(interfaces) {
  if (!isPlainObject(interfaces)) throw new TypeError("interfaces must be an object.");
  return {
    ...interfaces,
    loadActiveJournal: requireFunction(interfaces.loadActiveJournal, "loadActiveJournal"),
    persistActiveJournalAtomically: requireFunction(
      interfaces.persistActiveJournalAtomically,
      "persistActiveJournalAtomically",
    ),
    archiveCompletedJournalAtomically: requireFunction(
      interfaces.archiveCompletedJournalAtomically,
      "archiveCompletedJournalAtomically",
    ),
    readArchivedJournal: requireFunction(
      interfaces.readArchivedJournal,
      "readArchivedJournal",
    ),
    readBaselineBytes: requireFunction(interfaces.readBaselineBytes, "readBaselineBytes"),
    writeBaselineBytesAtomically: requireFunction(
      interfaces.writeBaselineBytesAtomically,
      "writeBaselineBytesAtomically",
    ),
    readLatestPointer: requireFunction(interfaces.readLatestPointer, "readLatestPointer"),
  };
}

function requireNewCommitInterfaces(io) {
  requireFunction(io.uploadImmutableCandidateArtifact, "uploadImmutableCandidateArtifact");
  requireFunction(io.compareAndSwapLatestPointer, "compareAndSwapLatestPointer");
  requireFunction(io.markSourceHealthSucceeded, "markSourceHealthSucceeded");
}

async function checkpoint(io, boundary, detail) {
  if (!STAGE1_EVIDENCE_SCHEMA_UPGRADE_COMMIT_BOUNDARIES.includes(boundary)) {
    throw new Error(`Unknown Stage 1 evidence upgrade checkpoint: ${boundary}.`);
  }
  if (io.checkpoint === undefined) return;
  await requireFunction(io.checkpoint, "checkpoint")({
    boundary,
    detail: cloneJson(detail),
  });
}

function journalCheckpoint(journal) {
  return {
    source_id: journal.source_id,
    transaction_id: journal.transaction_id,
    phase: journal.phase,
    journal_sha256: journal.journal_sha256,
  };
}

function baselineMatchesEnvelope(value, envelope) {
  if (value === null) return envelope.present === false;
  if (!Buffer.isBuffer(value)) return false;
  return envelope.present === true
    && value.byteLength === envelope.byte_length
    && sha256Bytes(value) === envelope.sha256
    && value.toString("base64") === envelope.bytes_base64;
}

function hasExactCandidateCompletionProof(journal) {
  const terminal = journal.phase_history.at(-1);
  const detail = terminal?.detail;
  return terminal?.phase === "completed"
    && isPlainObject(detail)
    && detail.outcome === "committed_candidate"
    && detail.authoritative_pointer_sha256
      === journal.candidate_pointer_identity.canonical_sha256
    && detail.authoritative_baseline_sha256 === journal.candidate_baseline.sha256
    && new Set(["succeeded", "already_current"]).has(detail.source_health_status)
    && detail.cleanup_debt_delete_performed === false;
}

function publicCasReceipt(cas) {
  const pointerWritesCounted = cas.returned === true ? 1 : 0;
  return Object.freeze({
    attempted: cas.attempted === true,
    returned: cas.returned === true ? true : cas.returned === false ? false : null,
    threw: cas.threw === true,
    recovered: cas.recovered === true,
    error_code: cleanText(cas.error_code) || null,
    error_message: cleanText(cas.error_message) || null,
    confirmed_database_pointer_writes: pointerWritesCounted,
    write_attribution: cas.returned === true
      ? "confirmed_by_strict_true_return"
      : cas.threw === true
        ? "unattributed_after_exception"
        : cas.returned === false
          ? "confirmed_not_written_by_this_cas"
          : "prior_invocation_not_counted",
  });
}

function errorSummary(error) {
  if (!error) return null;
  return {
    code: cleanText(error?.code) || null,
    message: cleanText(error?.message || error) || "Unknown read error.",
  };
}

function timestamp(now) {
  const raw = typeof now === "function" ? now() : now;
  const text = requiredText(raw, "commit timestamp");
  const milliseconds = Date.parse(text);
  if (!Number.isFinite(milliseconds)) throw new Error("commit timestamp is invalid.");
  return new Date(milliseconds).toISOString();
}

function transitionTimestamp(now, prior) {
  const proposed = timestamp(now);
  const priorMilliseconds = Date.parse(requiredText(prior, "prior journal timestamp"));
  if (!Number.isFinite(priorMilliseconds)) {
    throw new Error("prior journal timestamp is invalid.");
  }
  return Date.parse(proposed) < priorMilliseconds
    ? new Date(priorMilliseconds).toISOString()
    : proposed;
}

function exactBytes(value, label) {
  if (typeof value === "string") return Buffer.from(value, "utf8");
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new TypeError(`${label} must be exact bytes.`);
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function zeroMutationCounts() {
  return Object.fromEntries(MUTATION_COUNT_KEYS.map((key) => [key, 0]));
}

function normalizeMutationCounts(value) {
  if (
    !isPlainObject(value)
    || stableJson(Object.keys(value).sort()) !== stableJson([...MUTATION_COUNT_KEYS].sort())
  ) {
    throw new Error("Stage 1 evidence upgrade mutation counts are invalid.");
  }
  const counts = {};
  for (const key of MUTATION_COUNT_KEYS) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) {
      throw new Error("Stage 1 evidence upgrade mutation counts are invalid.");
    }
    counts[key] = value[key];
  }
  return Object.freeze(counts);
}

function addCounts(target, addition) {
  const value = normalizeMutationCounts(addition);
  for (const key of MUTATION_COUNT_KEYS) target[key] += value[key];
}

function mutationAccountingForCounts(counts) {
  return counts?.[mutationAccountingSymbol] || null;
}

function beginMutationAccounting(counts, categories, boundary, journalPhase = null) {
  const accounting = mutationAccountingForCounts(counts);
  if (!accounting) return;
  accounting.prior_unknown_categories = [...accounting.in_flight_categories];
  accounting.in_flight_categories = [
    ...new Set([...accounting.prior_unknown_categories, ...categories]),
  ].sort();
  accounting.boundary = boundary;
  accounting.journal_phase = journalPhase;
}

function completeMutationAccounting(counts, boundary, journalPhase = null) {
  const accounting = mutationAccountingForCounts(counts);
  if (!accounting) return;
  accounting.in_flight_categories = [...accounting.prior_unknown_categories];
  accounting.prior_unknown_categories = [];
  accounting.boundary = boundary;
  accounting.journal_phase = journalPhase;
}

function requireFunction(value, label) {
  if (typeof value !== "function") throw new Error(`${label} interface is required.`);
  return value;
}

function requiredText(value, label) {
  const text = cleanText(value);
  if (!text) throw new Error(`${label} is required.`);
  return text;
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
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

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
