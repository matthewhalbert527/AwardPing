import { createHash } from "node:crypto";
import {
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_COMMIT_RECEIPT_SCHEMA,
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_CONTEXT,
  assertStage1EvidenceSchemaUpgradeJournalArchiveAccounting,
  assertStage1EvidenceSchemaUpgradeReviewedReconciliationEvidence,
  buildStage1EvidenceSchemaUpgradeReviewedReconciliationEvidence,
} from "./stage1-evidence-schema-upgrade-commit.mjs";
import {
  assertStage1EvidenceSchemaUpgradeMutationAccounting,
  sealStage1EvidenceSchemaUpgradeMutationAccounting,
  zeroStage1EvidenceSchemaUpgradeMutationCounts,
} from "./stage1-evidence-schema-upgrade-mutation-accounting.mjs";
import {
  validateStage1EvidenceSchemaUpgradeReviewedApplyHistoricalEvidence,
} from "./stage1-evidence-schema-upgrade-reviewed-apply-plan.mjs";
import {
  assertStage1EvidenceSchemaUpgradeReviewedApplyAuditAccounting,
  assertStage1EvidenceSchemaUpgradeReviewedApplyAuditCompletionAuthority,
  assertStage1EvidenceSchemaUpgradeReviewedApplyAuditReceipt,
  assertStage1EvidenceSchemaUpgradeReviewedApplyAuditRecoveryInspection,
  stage1EvidenceSchemaUpgradeReviewedApplyAuditRecoveryCompletionAuthority,
  stage1EvidenceSchemaUpgradeReviewedApplyAuditRunId,
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_AUDIT_ACCOUNTING_SCHEMA,
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_AUDIT_RESULT_IDENTITY_SCHEMA,
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_AUDIT_TERMINAL_SCHEMA,
} from "./stage1-evidence-schema-upgrade-reviewed-apply-audit.mjs";
import {
  stage1EvidenceSchemaUpgradeReviewedApplyTransactionId,
} from "./stage1-evidence-schema-upgrade-reviewed-apply-execution.mjs";
import {
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_JOURNAL_SCHEMA,
  assertStage1EvidenceSchemaUpgradeJournal,
  proveStage1EvidenceSchemaUpgradeArchivedCompletion,
  stage1EvidenceSchemaUpgradeBaselineBytes,
} from "./stage1-evidence-schema-upgrade-transaction.mjs";
import {
  assertStage1EvidenceSchemaUpgradeReviewedRecoveryCandidateR2Pointer,
  assertStage1EvidenceSchemaUpgradeReviewedRecoveryOldR2Authority,
  normalizeStage1EvidenceSchemaUpgradeReviewedRecoveryCurrentR2Receipt,
  projectStage1EvidenceSchemaUpgradeReviewedRecoveryAuthority,
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_RECOVERY_AUTHORITY,
  stage1EvidenceSchemaUpgradeReviewedRecoveryFailureTerminalForDisposition as recoveryFailureTerminalForDisposition,
  stage1EvidenceSchemaUpgradeReviewedRecoveryEvidenceSha256,
  validateStage1EvidenceSchemaUpgradeReviewedRecoveryPlan,
} from "./stage1-evidence-schema-upgrade-reviewed-recovery-plan.mjs";
import {
  buildStage1EvidenceSchemaUpgradeSourceHealthAuthority,
  classifyStage1EvidenceSchemaUpgradeSourceHealthAuthority,
} from "./stage1-evidence-schema-upgrade-reviewed-source-authority.mjs";
import {
  VISUAL_SNAPSHOT_LATEST_ONLY_CLEANUP_DEBT_SCHEMA,
  planLatestOnlyVisualSnapshotPointerReconciliation,
  visualSnapshotPointerIdentity,
} from "./visual-snapshot-latest-only-reconciliation.mjs";

export const STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_RECOVERY_EXECUTION_REPORT_SCHEMA =
  "awardping.stage1.evidence-schema-upgrade-reviewed-exact-transaction-recovery-report.v3";

export const STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_RECOVERY_AUDIT_FINISH_ATTEMPT_SCHEMA =
  "awardping.stage1.evidence-schema-upgrade-reviewed-recovery-audit-finish-attempt.v1";

export const STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_RECOVERY_ARCHIVE_EVIDENCE_SCHEMA =
  "awardping.stage1.evidence-schema-upgrade-reviewed-recovery-journal-archive-evidence.v1";

const MODE = "reviewed_exact_transaction_recovery";
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const EXECUTION_REPORT_KEYS = Object.freeze([
  "audit_after_inspection",
  "audit_after_inspection_observation",
  "audit_after_inspection_sha256",
  "audit_before_inspection_sha256",
  "audit_finish_attempt",
  "audit_finish_authority",
  "audit_finish_evidence",
  "audit_mutation_accounting",
  "audit_receipt",
  "audit_terminal",
  "authority",
  "commit_receipt",
  "completed_at",
  "creates_api_charge",
  "disposition",
  "execution_nonce",
  "interrupted_original_mutation_accounting",
  "inspection_evidence_sha256",
  "inspection_file_sha256",
  "inspection_sha256",
  "journal_archive_persistence",
  "mode",
  "mutation_performed",
  "recovery_invocation_mutation_accounting",
  "recovery_plan_file_sha256",
  "recovery_plan_sha256",
  "recovery_completed_journal",
  "recovery_start_audit_inspection",
  "recovery_start_journal",
  "recovery_start_journal_location",
  "proposed_plan_sha256",
  "report_sha256",
  "response_loss_possible",
  "reviewed_apply_plan_file_sha256",
  "reviewed_apply_plan_sha256",
  "reviewed_expected_disposition",
  "reviewed_reconciliation_evidence",
  "schema_version",
  "selected_result",
  "source_id",
  "source_lock_response_loss_possible",
  "status",
  "transaction_id",
]);
const COMMIT_RESULT_KEYS = Object.freeze([
  "context",
  "creates_api_charge",
  "mutation_accounting",
  "mutation_count_certainty",
  "mutation_counts",
  "receipt",
  "reviewed_reconciliation_evidence",
  "source_id",
  "status",
]);
const COMMIT_RECEIPT_KEYS = Object.freeze([
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
]);
const REQUIRED_INTERFACES = Object.freeze([
  "finishOriginalAudit",
  "readRecoveryEvidence",
  "recoverActiveJournal",
  "withSourceLock",
]);
const ALLOWED_INTERFACES = new Set(REQUIRED_INTERFACES);
const PRE_AUDIT_RECOVERY_REQUIRED_DISPOSITIONS = new Set([
  "active_recovery_archive_not_exactly_verified",
  "active_recovery_crossed_unreviewed_authority_outcome",
  "active_recovery_left_authority_unresolved",
  "active_recovery_post_state_unverified",
  "active_recovery_response_or_outcome_unverified",
  "active_recovery_result_or_receipt_invalid",
  "business_authority_drift_before_audit_finish",
  "inspect_active_ambiguous_leave_running",
  "inspect_active_old_with_source_drift_leave_running",
  "inspect_completed_candidate_source_health_unproven_leave_running",
  "inspect_completed_old_source_health_drift_leave_running",
  "inspect_terminal_candidate_source_health_unproven_no_report_replay",
  "inspect_terminal_old_source_health_drift_no_report_replay",
  "partial_archive_completion_unverified",
  "partial_archive_crossed_unreviewed_authority_outcome",
  "partial_archive_post_state_unverified",
  "recovery_review_expired_before_audit_finish",
]);
const FRESH_REVIEWED_APPLY_ABANDONED_OLD_FAILURE = Object.freeze({
  error_code: "reviewed_unchanged_upgrade_old_authority_preserved",
  error_message: "Reviewed unchanged upgrade ended selected_blocked.",
});

export function stage1EvidenceSchemaUpgradeReviewedRecoveryFailureTerminalForDisposition(
  disposition,
) {
  return recoveryFailureTerminalForDisposition(disposition);
}

export function assertStage1EvidenceSchemaUpgradeReviewedRecoveryExecutionReport(value) {
  const report = requiredObject(value, "reviewed recovery execution report");
  assertExactKeys(report, EXECUTION_REPORT_KEYS, "reviewed recovery execution report");
  const content = cloneJson(report);
  delete content.report_sha256;
  const original = assertStage1EvidenceSchemaUpgradeMutationAccounting(
    content.interrupted_original_mutation_accounting,
    { operation: "pointer_commit" },
  );
  const recovery = assertStage1EvidenceSchemaUpgradeMutationAccounting(
    content.recovery_invocation_mutation_accounting,
  );
  const archive = assertArchiveEvidence(content.journal_archive_persistence);
  const auditAccounting = assertStage1EvidenceSchemaUpgradeReviewedApplyAuditAccounting(
    content.audit_mutation_accounting,
  );
  assertRecoveryReportArchiveAccountingParity(recovery, archive);
  const mutationPerformed =
    Object.values(recovery.lower_bound_counts).some((count) => count > 0)
    || recovery.unknown_write_categories.length > 0
    || journalPersistenceMutationPossible(recovery)
    || archive.local_journal_archive_writes_lower_bound > 0
    || auditMutationPossible(auditAccounting);
  const derivedResponseLossPossible =
    content.source_lock_response_loss_possible
    || content.audit_after_inspection_observation
      === "pre_finish_fallback_after_read_failure"
    || commitResponseLossPossible(recovery, archive)
    || auditAccounting.evidence?.response_loss_possible === true;
  const lockLossDisposition = content.disposition.endsWith(
    "_source_lock_release_response_lost",
  );
  if (
    content.schema_version
      !== STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_RECOVERY_EXECUTION_REPORT_SCHEMA
    || content.mode !== MODE
    || !new Set(["failed", "recovery_required", "succeeded"]).has(content.status)
    || !requiredText(content.disposition, "reviewed recovery report disposition")
    || !SHA256_PATTERN.test(content.recovery_plan_file_sha256 || "")
    || !SHA256_PATTERN.test(content.recovery_plan_sha256 || "")
    || !SHA256_PATTERN.test(content.inspection_file_sha256 || "")
    || !SHA256_PATTERN.test(content.inspection_sha256 || "")
    || !SHA256_PATTERN.test(content.proposed_plan_sha256 || "")
    || !SHA256_PATTERN.test(content.inspection_evidence_sha256 || "")
    || !SHA256_PATTERN.test(content.reviewed_apply_plan_file_sha256 || "")
    || !SHA256_PATTERN.test(content.reviewed_apply_plan_sha256 || "")
    || !requiredText(
      content.reviewed_expected_disposition,
      "reviewed recovery expected disposition",
    )
    || !SHA256_PATTERN.test(content.audit_before_inspection_sha256 || "")
    || !SHA256_PATTERN.test(content.audit_after_inspection_sha256 || "")
    || !UUID_PATTERN.test(content.source_id || "")
    || !UUID_PATTERN.test(content.transaction_id || "")
    || !UUID_PATTERN.test(content.execution_nonce || "")
    || !sameJson(
      content.authority,
      STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_RECOVERY_AUTHORITY,
    )
    || typeof content.response_loss_possible !== "boolean"
    || typeof content.source_lock_response_loss_possible !== "boolean"
    || content.source_lock_response_loss_possible !== lockLossDisposition
    || content.response_loss_possible !== derivedResponseLossPossible
    || content.mutation_performed !== mutationPerformed
    || content.creates_api_charge !== false
    || !new Set([
      "current_evidence",
      "post_finish_read",
      "pre_finish_fallback_after_read_failure",
    ]).has(content.audit_after_inspection_observation)
    || report.report_sha256 !== sha256(canonicalJson(content))
  ) throw new Error("Reviewed recovery execution report seal or accounting is invalid.");
  requiredTimestamp(content.completed_at, "reviewed recovery report completed_at");
  assertInterruptedOriginalMutationAccounting(original, content);
  assertRecoveryReportTerminalPayload({
    report: content,
    auditAccounting,
    recoveryAccounting: recovery,
    archiveEvidence: archive,
  });
  return deepFreeze(cloneJson(report));
}

function assertInterruptedOriginalMutationAccounting(accounting, report) {
  const evidence = requiredObject(
    accounting.evidence,
    "reviewed recovery interrupted-original accounting evidence",
  );
  assertExactKeys(evidence, [
    "boundary",
    "journal_phase",
    "journal_sha256",
    "local_journal_writes_reported_separately",
    "mutation_scope",
  ], "reviewed recovery interrupted-original accounting evidence");
  const phase = evidence.journal_phase;
  const latePhase = new Set([
    "completed",
    "pointer_candidate_committed",
    "pointer_cas_attempted",
    "recovery_required",
  ]).has(phase);
  const journalPhase = latePhase || new Set([
    "local_candidate_written",
    "prepared",
  ]).has(phase);
  const expectedUnknown = phase === "absent_before_journal"
    ? []
    : latePhase
      ? [
          "database_writes",
          "local_baseline_writes",
          "r2_writes",
          "source_state_writes",
        ]
      : ["local_baseline_writes", "r2_writes"];
  const dispositionRequiresNoJournal = new Set([
    "finish_failed_audit_started_before_journal",
    "report_replay_failed_before_journal",
  ]).has(report.reviewed_expected_disposition);
  if (
    accounting.operation !== "pointer_commit"
    || !sameJson(
      accounting.lower_bound_counts,
      zeroStage1EvidenceSchemaUpgradeMutationCounts(),
    )
    || !sameJson(accounting.unknown_write_categories, expectedUnknown)
    || evidence.boundary !== "interrupted_original_invocation"
    || evidence.mutation_scope !== "interrupted_original_invocation_only"
    || evidence.local_journal_writes_reported_separately !== true
    || (!journalPhase && phase !== "absent_before_journal")
    || (
      phase === "absent_before_journal"
        ? evidence.journal_sha256 !== null
        : !SHA256_PATTERN.test(evidence.journal_sha256 || "")
    )
    || dispositionRequiresNoJournal !== (phase === "absent_before_journal")
  ) throw new Error("Reviewed recovery interrupted-original accounting profile is invalid.");
  const carriedStart = report.recovery_start_journal;
  const carriedLocation = report.recovery_start_journal_location;
  if (phase === "absent_before_journal") {
    if (carriedStart !== null || carriedLocation !== null) {
      throw new Error(
        "Reviewed recovery interrupted-original accounting invents an absent start journal.",
      );
    }
    return;
  }
  if (!new Set(["active", "archived"]).has(carriedLocation)) {
    throw new Error("Reviewed recovery interrupted-original accounting lacks start location.");
  }
  const journal = assertStage1EvidenceSchemaUpgradeJournal(carriedStart);
  if (
    journal.source_id !== report.source_id
    || journal.transaction_id !== report.transaction_id
    || journal.phase !== phase
    || journal.journal_sha256 !== evidence.journal_sha256
  ) {
    throw new Error(
      "Reviewed recovery interrupted-original accounting differs from its start journal.",
    );
  }
  assertRecoveryReportJournalOperationBinding(
    journal,
    report.recovery_start_audit_inspection || report.audit_after_inspection,
    report,
  );
}

function assertRecoveryReportJournalOperationBinding(journal, auditValue, report) {
  const audit = assertStage1EvidenceSchemaUpgradeReviewedApplyAuditRecoveryInspection(
    auditValue,
  );
  const binding = requiredObject(
    journal.operation_binding,
    "reviewed recovery start journal operation binding",
  );
  if (
    binding.source_id !== report.source_id
    || binding.transaction_id !== report.transaction_id
    || binding.audit_run_id !== audit.run_id
    || binding.execution_nonce !== audit.execution_nonce
    || binding.reviewed_apply_plan_file_sha256 !== audit.plan_file_sha256
    || binding.reviewed_apply_plan_sha256 !== audit.plan_sha256
    || binding.fresh_capture_sha256 !== audit.fresh_capture.fresh_capture_sha256
    || binding.fresh_capture_result_sha256 !== audit.fresh_capture.capture_result_sha256
    || binding.fresh_capture_validation_sha256
      !== audit.fresh_capture.capture_validation_sha256
    || binding.fresh_validation_projection_sha256
      !== audit.fresh_capture.fresh_validation_projection_sha256
    || binding.precommit_authority_receipt_sha256 !== audit.authority_receipt_sha256
    || !sameJson(
      binding.precommit_source_authority,
      audit.authority_receipt.source_authority,
    )
  ) throw new Error("Reviewed recovery start journal differs from its audit authority.");
}

function assertRecoveryReportTerminalPayload({
  report,
  auditAccounting,
  recoveryAccounting,
  archiveEvidence,
}) {
  const baseDisposition = recoveryReportBaseDisposition(report.disposition);
  const afterAudit = assertStage1EvidenceSchemaUpgradeReviewedApplyAuditRecoveryInspection(
    report.audit_after_inspection,
  );
  if (
    afterAudit.inspection_sha256 !== report.audit_after_inspection_sha256
    || afterAudit.selected_source_id !== report.source_id
    || afterAudit.plan_file_sha256 !== report.reviewed_apply_plan_file_sha256
    || afterAudit.plan_sha256 !== report.reviewed_apply_plan_sha256
    || afterAudit.execution_nonce !== report.execution_nonce
  ) throw new Error("Reviewed recovery after-audit inspection differs from its report.");
  const afterObservation = report.audit_after_inspection_observation;
  const expectedAfterObservation = report.audit_finish_attempt === null
    ? "current_evidence"
    : baseDisposition === "audit_finished_post_state_unobserved"
      ? "pre_finish_fallback_after_read_failure"
      : "post_finish_read";
  if (
    afterObservation !== expectedAfterObservation
  ) throw new Error("Reviewed recovery after-audit observation provenance is invalid.");
  const finishAttempt = report.audit_finish_attempt === null
    ? null
    : assertRecoveryAuditFinishAttempt(report.audit_finish_attempt, report);
  if ((report.commit_receipt === null) !== (report.selected_result === null)) {
    throw new Error("Reviewed recovery report selected result and commit receipt differ.");
  }
  const terminal = report.audit_terminal === null
    ? null
    : assertRecoveryReportAuditTerminal(report.audit_terminal, report);
  const reportStartAudit = report.recovery_start_audit_inspection === null
    ? null
    : assertStage1EvidenceSchemaUpgradeReviewedApplyAuditRecoveryInspection(
        report.recovery_start_audit_inspection,
      );
  const finishEvidence = report.audit_finish_evidence === null
    ? null
    : requiredObject(report.audit_finish_evidence, "reviewed recovery audit finish evidence");
  const finishAuthority = report.audit_finish_authority === null
    ? null
    : requiredObject(report.audit_finish_authority, "reviewed recovery audit finish authority");
  if (reportStartAudit && (
    reportStartAudit.inspection_sha256 !== report.audit_before_inspection_sha256
    || reportStartAudit.selected_source_id !== report.source_id
    || reportStartAudit.execution_nonce !== report.execution_nonce
    || reportStartAudit.plan_file_sha256 !== report.reviewed_apply_plan_file_sha256
    || reportStartAudit.plan_sha256 !== report.reviewed_apply_plan_sha256
  )) throw new Error("Reviewed recovery start audit inspection differs from its report.");
  const auditReceipt = report.audit_receipt === null
    ? null
    : normalizeRecoveryAuditReceipt(report.audit_receipt, {
        sourceId: report.source_id,
        planFileSha256: report.reviewed_apply_plan_file_sha256,
        planSha256: report.reviewed_apply_plan_sha256,
        executionNonce: report.execution_nonce,
        expectedAudit: reportStartAudit,
        expectedTerminal: terminal || finishAttempt,
      }).receipt;
  const recoveredTerminal = report.commit_receipt === null
    ? null
    : assertRecoveryReportCommitReceipt(report.commit_receipt, report);
  const commitReceipt = recoveredTerminal?.commit_receipt || null;
  const selectedResult = report.selected_result === null
    ? null
    : recoveredTerminal?.selected_result || null;
  const startProofPresent = report.recovery_start_journal !== null
    && report.recovery_start_journal_location !== null;
  const startProofAbsent = report.recovery_start_journal === null
    && report.recovery_start_journal_location === null;
  const completionProofPresent = report.recovery_completed_journal !== null
    && report.reviewed_reconciliation_evidence !== null;
  const completionProofAbsent = report.recovery_completed_journal === null
    && report.reviewed_reconciliation_evidence === null;
  const dualCleanupReplay = commitReceipt === null
    && startProofPresent
    && completionProofPresent
    && new Set([
      "finish_partial_archive_then_replay_candidate_success",
      "finish_partial_archive_then_replay_old_abandonment",
    ]).has(report.reviewed_expected_disposition);
  if (
    (!startProofPresent && !startProofAbsent)
    || (!completionProofPresent && !completionProofAbsent)
    || (commitReceipt !== null && (!startProofPresent || !completionProofPresent))
    || (commitReceipt === null && completionProofPresent && !dualCleanupReplay)
  ) {
    throw new Error("Reviewed recovery report commit proof inputs are incomplete.");
  }
  if (dualCleanupReplay) {
    assertRecoveryReportDualCleanupJournalProof({
      report,
      recoveryAccounting,
      archiveEvidence,
    });
  }
  if (auditReceipt && !sameJson(
    auditReceipt.audit_mutation_accounting,
    auditAccounting,
  )) throw new Error("Reviewed recovery report audit receipt accounting differs from its report.");
  if ((auditReceipt || finishAttempt || terminal) && !reportStartAudit) {
    throw new Error("Reviewed recovery report lacks its exact start audit inspection.");
  }
  if (
    (finishAttempt === null) !== (finishEvidence === null)
    || (finishAttempt === null) !== (finishAuthority === null)
  ) {
    throw new Error("Reviewed recovery audit finish attempt lacks its exact live evidence.");
  }
  if (finishAttempt) {
    assertRecoveryReportFinishEvidence({
      report,
      evidence: finishEvidence,
      authority: finishAuthority,
      audit: reportStartAudit,
    });
  }
  if (
    terminal
    && reportStartAudit?.row_kind?.startsWith("terminal_")
    && !sameJson(reportStartAudit.terminal, terminal)
  ) throw new Error("Reviewed recovery replay terminal differs from its audit inspection.");
  if (!sameJson(report.audit_terminal, afterAudit.terminal)) {
    throw new Error("Reviewed recovery terminal differs from its full after-audit inspection.");
  }
  if (
    auditReceipt
    && afterObservation !== "pre_finish_fallback_after_read_failure"
    && auditReceipt.observed_row_sha256 !== afterAudit.observed_row_sha256
  ) throw new Error("Reviewed recovery audit receipt row differs from its after inspection.");
  if (terminal && finishAttempt && (
    terminal.status !== finishAttempt.status
    || (
      auditReceipt?.replay === false
      && terminal.finished_at !== finishAttempt.finished_at
    )
    || !sameJson(terminal.completion_authority, finishAttempt.completion_authority)
    || !sameJson(
      terminal.selected_result_commit_identity,
      finishAttempt.selected_result_commit_identity,
    )
    || !sameJson(terminal.failure, finishAttempt.failure)
  ) && report.status !== "recovery_required") {
    throw new Error("Reviewed recovery finish attempt differs from its observed terminal.");
  }
  assertRecoveryReportDispositionAccounting({
    report,
    auditReceipt,
    auditAccounting,
    recoveryAccounting,
    archiveEvidence,
    finishAttempt,
  });
  if (report.status === "recovery_required") {
    if (selectedResult !== null || commitReceipt !== null) {
      throw new Error("Recovery-required report cannot claim a selected commit result.");
    }
    return;
  }
  if (!terminal || terminal.status !== report.status) {
    throw new Error("Reviewed recovery terminal status differs from its report.");
  }
  if (report.status === "failed") {
    if (
      selectedResult !== null
      || commitReceipt !== null
      || !/failed|failure/u.test(report.disposition)
    ) throw new Error("Failed reviewed recovery report has contradictory terminal fields.");
    return;
  }
  if (!/succeeded|success/u.test(report.disposition)) {
    throw new Error("Succeeded reviewed recovery report has a contradictory disposition.");
  }
  const identity = terminal.selected_result_commit_identity;
  if (selectedResult === null) {
    if (baseDisposition !== "terminal_success_report_replay") {
      throw new Error("Only an exact terminal replay may omit recovered success bytes.");
    }
    return;
  }
  if (
    identity.selected_result_sha256 !== sha256(canonicalJson(selectedResult))
    || identity.commit_receipt_sha256 !== sha256(canonicalJson(commitReceipt))
    || identity.commit_journal_sha256 !== commitReceipt.journal_sha256
    || identity.commit_mutation_accounting_sha256
      !== commitReceipt.mutation_accounting.accounting_sha256
  ) throw new Error("Reviewed recovery report success bytes differ from its audit identity.");
}

function assertRecoveryReportDispositionAccounting({
  report,
  auditReceipt,
  auditAccounting,
  recoveryAccounting,
  archiveEvidence,
  finishAttempt,
}) {
  const disposition = recoveryReportBaseDisposition(report.disposition);
  const exactZeroAudit = auditAccounting.exact === true
    && auditAccounting.lower_bound_counts.local_worker_run_inserts === 0
    && auditAccounting.lower_bound_counts.local_worker_run_terminal_updates === 0
    && auditAccounting.unknown_write_categories.length === 0;
  const auditUncertain = auditAccounting.exact !== true
    || auditAccounting.unknown_write_categories.length > 0
    || auditAccounting.evidence?.response_loss_possible === true;
  if (new Set([
    "terminal_success_report_replay",
    "terminal_failure_report_replay",
  ]).has(disposition)) {
    if (
      auditReceipt !== null
      || finishAttempt !== null
      || !exactZeroAudit
      || !sameJson(auditAccounting, zeroRecoveryAuditAccounting())
    ) throw new Error("Terminal replay report claims audit-finish mutations.");
    assertTerminalReplayBusinessAccounting(recoveryAccounting, archiveEvidence, report);
    return;
  }
  if (/^audit_(?:succeeded|failed)_finished$/u.test(disposition)) {
    if (
      !auditReceipt
      || !finishAttempt
      || auditReceipt.replay !== false
      || auditReceipt.action !== "finish"
      || auditAccounting.evidence?.action !== "finish"
    ) throw new Error("Finished recovery report lacks its exact audit receipt.");
    assertRecoveryBusinessAccountingForExpectedDisposition({
      report,
      accounting: recoveryAccounting,
      archive: archiveEvidence,
    });
    return;
  }
  if (/^terminal_(?:succeeded|failed)_report_replay_after_finish_race$/u.test(
    disposition,
  )) {
    if (
      !auditReceipt
      || !finishAttempt
      || auditReceipt.replay !== true
      || auditReceipt.action !== "finish"
      || auditAccounting.evidence?.action !== "finish"
    ) throw new Error("Audit-finish race replay lacks its exact replay receipt.");
    assertRecoveryBusinessAccountingForExpectedDisposition({
      report,
      accounting: recoveryAccounting,
      archive: archiveEvidence,
    });
    return;
  }
  if (/^audit_(?:succeeded|failed)_verified_after_response_loss$/u.test(
    disposition,
  )) {
    if (
      auditReceipt !== null
      || !finishAttempt
      || report.response_loss_possible !== true
      || !auditUncertain
      || !sameJson(
        auditAccounting,
        unknownAuditFinishAccounting(report.status),
      )
    ) throw new Error("Verified audit response-loss report has contradictory accounting.");
    assertRecoveryBusinessAccountingForExpectedDisposition({
      report,
      accounting: recoveryAccounting,
      archive: archiveEvidence,
    });
    return;
  }
  if (disposition === "audit_finish_response_loss_terminal_unverified") {
    const observedRowStatus = auditAccounting.evidence?.observed_row_status;
    if (
      auditReceipt !== null
      || !finishAttempt
      || report.response_loss_possible !== true
      || !auditUncertain
      || !new Set([
        "failed",
        "running",
        "succeeded",
        "unverified",
      ]).has(observedRowStatus)
      || !sameJson(
        auditAccounting,
        unknownAuditFinishAccounting(observedRowStatus),
      )
    ) {
      throw new Error("Unverified audit response-loss report has contradictory accounting.");
    }
    assertRecoveryBusinessAccountingForExpectedDisposition({
      report,
      accounting: recoveryAccounting,
      archive: archiveEvidence,
    });
    return;
  }
  if (new Set([
    "audit_finish_terminal_unverified",
    "audit_finished_post_state_unobserved",
  ]).has(disposition)) {
    const replayDisposition = new Set([
      "terminal_failure_replay",
      "terminal_success_replay",
    ]).has(auditReceipt?.disposition);
    if (
      !auditReceipt
      || !finishAttempt
      || auditReceipt.action !== "finish"
      || !new Set([
        "finished",
        "finished_after_update_response_loss",
        "terminal_failure_replay",
        "terminal_success_replay",
      ]).has(auditReceipt.disposition)
      || auditReceipt.replay !== replayDisposition
      || auditAccounting.evidence?.action !== "finish"
    ) {
      throw new Error("Unverified audit terminal report lacks its finish receipt.");
    }
    assertRecoveryBusinessAccountingForExpectedDisposition({
      report,
      accounting: recoveryAccounting,
      archive: archiveEvidence,
    });
    return;
  }
  const preAuditRecoveryRequired = report.status === "recovery_required"
    && PRE_AUDIT_RECOVERY_REQUIRED_DISPOSITIONS.has(disposition);
  if (preAuditRecoveryRequired) {
    if (
      auditReceipt !== null
      || finishAttempt !== null
      || !exactZeroAudit
      || !sameJson(auditAccounting, zeroRecoveryAuditAccounting())
    ) throw new Error("Pre-audit recovery-required report claims an audit finish.");
    assertPreAuditRecoveryRequiredBusinessAccounting({
      report,
      disposition,
      recoveryAccounting,
      archiveEvidence,
    });
    assertRecoveryBusinessAccountingForExpectedDisposition({
      report,
      accounting: recoveryAccounting,
      archive: archiveEvidence,
      allowUnverifiedAction: true,
    });
    return;
  }
  throw new Error("Reviewed recovery report disposition/accounting family is invalid.");
}

function assertTerminalReplayBusinessAccounting(accounting, archive, report) {
  const counts = accounting.lower_bound_counts;
  const journalPersistence = reviewedJournalPersistenceEvidence(accounting);
  const nestedArchive = accounting.evidence?.journal_archive ?? null;
  const exactZeroBusiness = accounting.exact === true
    && Object.values(counts).every((count) => count === 0)
    && accounting.unknown_write_categories.length === 0
    && accounting.evidence?.response_loss_possible !== true
    && (journalPersistence === null
      || (journalPersistence.state === "not_started"
        && journalPersistence.local_journal_writes_lower_bound === 0
        && journalPersistence.response_loss_possible === false));
  if (!exactZeroBusiness) {
    throw new Error("Terminal replay report claims current recovery business writes.");
  }
  if (archive.commit_archive_accounting === null) {
    const archivedStart = report.recovery_start_journal_location === "archived"
      ? assertStage1EvidenceSchemaUpgradeJournal(report.recovery_start_journal)
      : null;
    const noJournalReplay = report.recovery_start_journal === null
      && report.recovery_start_journal_location === null
      && report.reviewed_expected_disposition === "report_replay_failed_before_journal";
    const archivedReplay = archivedStart?.phase === "completed"
      && new Set([
        "report_replay_archived_candidate_success",
        "report_replay_archived_old_abandonment",
      ]).has(report.reviewed_expected_disposition);
    const expectedArchiveState = archivedStart ? "completed_verified" : "not_started";
    const expectedEvidenceSource = archivedStart
      ? `preexisting_archived_journal:${archivedStart.journal_sha256}`
      : "no_journal_before_business_boundary";
    if (
      accounting.operation !== "reviewed_exact_transaction_recovery"
      || (!noJournalReplay && !archivedReplay)
      || accounting.evidence?.boundary !== "terminal_report_replay_read_only"
      || accounting.evidence?.mutation_scope !== "current_recovery_invocation_only"
      || !sameJson(Object.keys(accounting.evidence).sort(), [
        "boundary",
        "mutation_scope",
        "response_loss_possible",
      ])
      ||
      nestedArchive !== null
      || archive.local_journal_archive_writes_lower_bound !== 0
      || archive.response_loss_possible
      || archive.state !== expectedArchiveState
      || archive.evidence_source !== expectedEvidenceSource
    ) throw new Error("Read-only terminal replay has contradictory archive accounting.");
    return;
  }
  const trustedArchive = assertStage1EvidenceSchemaUpgradeJournalArchiveAccounting(
    archive.commit_archive_accounting,
  );
  const dualStart = report.recovery_start_journal_location === "active"
    ? assertStage1EvidenceSchemaUpgradeJournal(report.recovery_start_journal)
    : null;
  const dualCompleted = report.recovery_completed_journal === null
    ? null
    : assertStage1EvidenceSchemaUpgradeJournal(report.recovery_completed_journal);
  const exactDualProof = dualStart
    && dualCompleted
    && dualStart.journal_sha256 === dualCompleted.journal_sha256
    && report.reviewed_reconciliation_evidence !== null
    && new Set([
      "finish_partial_archive_then_replay_candidate_success",
      "finish_partial_archive_then_replay_old_abandonment",
    ]).has(report.reviewed_expected_disposition);
  if (
    !exactDualProof
    || accounting.operation !== "pointer_commit"
    || accounting.evidence?.boundary
      !== "terminal_report_replay_dual_archive_cleanup_verified"
    || accounting.evidence?.mutation_scope !== "current_recovery_invocation_only"
    || !sameJson(Object.keys(accounting.evidence).sort(), [
      "boundary",
      "journal_archive",
      "journal_persistence",
      "mutation_scope",
      "response_loss_possible",
    ])
    || !sameJson(nestedArchive, trustedArchive)
    || archive.state !== "completed_verified"
    || trustedArchive.state !== "verified"
    || trustedArchive.local_journal_archive_writes_lower_bound < 1
    || trustedArchive.response_loss_possible
    || archive.evidence_source !== "commit_journal_archive_accounting"
  ) throw new Error("Terminal replay archive cleanup is not exactly verified.");
}

function assertRecoveryReportDualCleanupJournalProof({
  report,
  recoveryAccounting,
  archiveEvidence,
}) {
  const start = assertStage1EvidenceSchemaUpgradeJournal(report.recovery_start_journal);
  const completed = assertStage1EvidenceSchemaUpgradeJournal(
    report.recovery_completed_journal,
  );
  const reconciliation =
    assertStage1EvidenceSchemaUpgradeReviewedReconciliationEvidence(
      report.reviewed_reconciliation_evidence,
    );
  const audit = assertStage1EvidenceSchemaUpgradeReviewedApplyAuditRecoveryInspection(
    report.recovery_start_audit_inspection,
  );
  const binding = requiredObject(
    start.operation_binding,
    "terminal replay cleanup operation binding",
  );
  const nestedArchive = assertStage1EvidenceSchemaUpgradeJournalArchiveAccounting(
    recoveryAccounting.evidence?.journal_archive,
  );
  if (
    report.recovery_start_journal_location !== "active"
    || start.source_id !== report.source_id
    || start.transaction_id !== report.transaction_id
    || completed.source_id !== report.source_id
    || completed.transaction_id !== report.transaction_id
    || start.phase !== "completed"
    || completed.phase !== "completed"
    || !sameJson(start, completed)
    || binding.source_id !== report.source_id
    || binding.transaction_id !== report.transaction_id
    || binding.audit_run_id !== audit.run_id
    || binding.execution_nonce !== audit.execution_nonce
    || binding.reviewed_apply_plan_file_sha256 !== audit.plan_file_sha256
    || binding.reviewed_apply_plan_sha256 !== audit.plan_sha256
    || binding.fresh_capture_sha256 !== audit.fresh_capture.fresh_capture_sha256
    || binding.fresh_capture_result_sha256 !== audit.fresh_capture.capture_result_sha256
    || binding.fresh_capture_validation_sha256
      !== audit.fresh_capture.capture_validation_sha256
    || binding.fresh_validation_projection_sha256
      !== audit.fresh_capture.fresh_validation_projection_sha256
    || binding.precommit_authority_receipt_sha256 !== audit.authority_receipt_sha256
    || !sameJson(
      binding.precommit_source_authority,
      audit.authority_receipt.source_authority,
    )
    || audit.inspection_sha256 !== report.audit_before_inspection_sha256
    || audit.execution_nonce !== report.execution_nonce
    || audit.plan_file_sha256 !== report.reviewed_apply_plan_file_sha256
    || audit.plan_sha256 !== report.reviewed_apply_plan_sha256
    || !sameJson(
      reconciliation,
      expectedReviewedReconciliationEvidence(completed),
    )
    || archiveEvidence.state !== "completed_verified"
    || !sameJson(archiveEvidence.commit_archive_accounting, nestedArchive)
    || nestedArchive.state !== "verified"
  ) throw new Error("Terminal replay dual-copy cleanup journal proof is not exact.");
}

function assertPreAuditRecoveryRequiredBusinessAccounting({
  report,
  disposition,
  recoveryAccounting: accounting,
  archiveEvidence: archive,
}) {
  const inspectionOnly = new Set([
    "inspect_active_ambiguous_leave_running",
    "inspect_active_old_with_source_drift_leave_running",
    "inspect_completed_candidate_source_health_unproven_leave_running",
    "inspect_completed_old_source_health_drift_leave_running",
    "inspect_terminal_candidate_source_health_unproven_no_report_replay",
    "inspect_terminal_old_source_health_drift_no_report_replay",
  ]);
  if (inspectionOnly.has(disposition)) {
    const persistence = reviewedJournalPersistenceEvidence(accounting);
    const startJournal = report.recovery_start_journal === null
      ? null
      : assertStage1EvidenceSchemaUpgradeJournal(report.recovery_start_journal);
    const archivedInspection = report.recovery_start_journal_location === "archived"
      && startJournal?.phase === "completed";
    const activeInspection = report.recovery_start_journal_location === "active"
      && startJournal !== null;
    const exactArchiveProofFlags = archivedInspection
      ? archive.state === "completed_verified"
        && archive.archive_write_acknowledged === true
        && archive.archive_readback_verified === true
        && archive.active_removal_verified === true
      : activeInspection
        && new Set(["ambiguous", "not_started"]).has(archive.state)
        && archive.archive_write_acknowledged === false
        && archive.archive_readback_verified === false
        && archive.active_removal_verified === false;
    if (
      accounting.operation !== "reviewed_exact_transaction_recovery"
      || accounting.exact !== true
      || Object.values(accounting.lower_bound_counts).some((count) => count !== 0)
      || accounting.unknown_write_categories.length !== 0
      || accounting.evidence?.response_loss_possible === true
      || accounting.evidence?.boundary !== "reviewed_recovery_inspection_only"
      || accounting.evidence?.mutation_scope !== "current_recovery_invocation_only"
      || !sameJson(Object.keys(accounting.evidence).sort(), [
        "boundary",
        "mutation_scope",
        "response_loss_possible",
      ])
      || persistence !== null
      || archive.commit_archive_accounting !== null
      || archive.local_journal_archive_writes_lower_bound !== 0
      || archive.response_loss_possible
      || archive.evidence_source !== "reviewed_recovery_read_only_inspection"
      || !exactArchiveProofFlags
    ) throw new Error("Inspection-only recovery report claims current invocation writes.");
    return;
  }
  if (new Set([
    "business_authority_drift_before_audit_finish",
    "recovery_review_expired_before_audit_finish",
  ]).has(disposition)) return;
  const persistence = reviewedJournalPersistenceEvidence(accounting, { required: true });
  const nestedArchive = archive.commit_archive_accounting;
  const expectedEvidenceKeys = [
    "boundary",
    ...(nestedArchive ? ["journal_archive"] : []),
    "journal_persistence",
    "mutation_scope",
    "response_loss_possible",
  ].sort();
  const counts = accounting.lower_bound_counts;
  if (
    accounting.operation !== "reviewed_exact_transaction_recovery"
    || accounting.evidence?.boundary !== `recovery_required:${disposition}`
    || accounting.evidence?.mutation_scope !== "current_recovery_invocation_only"
    || !sameJson(Object.keys(accounting.evidence).sort(), expectedEvidenceKeys)
    || accounting.evidence.response_loss_possible
      !== commitResponseLossPossible(accounting, archive)
    || counts.r2_writes !== 0
    || counts.candidate_writes !== 0
    || counts.quarantine_writes !== 0
    || !new Set([0, 1]).has(counts.local_baseline_writes)
    || !new Set([0, 1]).has(counts.database_writes)
    || counts.database_writes !== counts.source_state_writes
    || (nestedArchive !== null
      && !sameJson(accounting.evidence.journal_archive, nestedArchive))
    || persistence.response_loss_possible === true
      && accounting.evidence.response_loss_possible !== true
  ) throw new Error("Recovery-required action accounting profile is invalid.");
  const unverifiedCallback = new Set([
    "active_recovery_crossed_unreviewed_authority_outcome",
    "active_recovery_left_authority_unresolved",
    "active_recovery_response_or_outcome_unverified",
    "active_recovery_result_or_receipt_invalid",
    "partial_archive_crossed_unreviewed_authority_outcome",
  ]);
  if (unverifiedCallback.has(disposition)) {
    const requiredUnknown = new Set([
      "database_writes",
      "local_baseline_writes",
      "source_state_writes",
    ]);
    if (
      accounting.exact !== false
      || [...requiredUnknown].some(
        (category) => !accounting.unknown_write_categories.includes(category),
      )
      || accounting.evidence?.response_loss_possible !== true
      || archive.state !== "ambiguous"
      || archive.commit_archive_accounting !== null
      || archive.response_loss_possible !== true
    ) throw new Error("Unverified recovery callback report understates write uncertainty.");
    return;
  }
  if (new Set([
    "active_recovery_archive_not_exactly_verified",
    "partial_archive_completion_unverified",
  ]).has(disposition)) {
    if (
      archive.state !== "ambiguous"
      || archive.active_removal_verified
    ) {
      throw new Error("Incomplete archive recovery report claims verified completion.");
    }
    return;
  }
  if (new Set([
    "active_recovery_post_state_unverified",
    "partial_archive_post_state_unverified",
  ]).has(disposition)) {
    if (
      archive.state !== "completed_verified"
      || accounting.exact !== true
      || accounting.unknown_write_categories.length !== 0
    ) throw new Error("Post-state recovery report lacks its completed archive proof.");
    return;
  }
  if (!new Set([
    "active_recovery_archive_not_exactly_verified",
    "partial_archive_completion_unverified",
  ]).has(disposition)) {
    throw new Error("Recovery-required action disposition has no accounting profile.");
  }
}

function assertRecoveryBusinessAccountingForExpectedDisposition({
  report,
  accounting,
  archive,
  allowUnverifiedAction = false,
}) {
  const expected = requiredText(
    report.reviewed_expected_disposition,
    "reviewed recovery expected disposition",
  );
  if (
    expected.startsWith("inspect_")
    || expected.startsWith("report_replay_")
    || expected.startsWith("finish_partial_archive_then_replay_")
  ) return;
  if (allowUnverifiedAction && !new Set([
    "business_authority_drift_before_audit_finish",
    "recovery_review_expired_before_audit_finish",
  ]).has(recoveryReportBaseDisposition(report.disposition))) return;
  const counts = accounting.lower_bound_counts;
  const exactZero = accounting.exact === true
    && Object.values(counts).every((count) => count === 0)
    && accounting.unknown_write_categories.length === 0
    && accounting.evidence?.response_loss_possible !== true;
  if (expected === "finish_failed_audit_started_before_journal") {
    if (
      accounting.operation !== "reviewed_exact_transaction_recovery"
      || !exactZero
      || accounting.evidence?.boundary !== "reviewed_recovery_inspection_only"
      || accounting.evidence?.mutation_scope !== "current_recovery_invocation_only"
      || !sameJson(Object.keys(accounting.evidence).sort(), [
        "boundary",
        "mutation_scope",
        "response_loss_possible",
      ])
      || reviewedJournalPersistenceEvidence(accounting) !== null
      || archive.state !== "not_started"
      || archive.commit_archive_accounting !== null
      || archive.local_journal_archive_writes_lower_bound !== 0
      || archive.evidence_source !== "no_journal_before_business_boundary"
    ) throw new Error("No-journal failed recovery accounting profile is invalid.");
    return;
  }
  if (new Set([
    "finish_failed_from_archived_old",
    "finish_succeeded_from_archived_candidate",
  ]).has(expected)) {
    const expectedOperation = expected === "finish_failed_from_archived_old"
      ? "reviewed_exact_transaction_recovery"
      : "pointer_commit";
    const expectedBoundary = expected === "finish_failed_from_archived_old"
      ? "archived_completion_read_only_replay"
      : "archived_completed_recovery_replay";
    const expectedEvidenceKeys = expected === "finish_failed_from_archived_old"
      ? ["boundary", "mutation_scope", "response_loss_possible"]
      : [
          "archived_journal_sha256",
          "boundary",
          "mutation_scope",
          "original_operation_totals_not_represented",
        ];
    const archivedEvidenceJournal = report.audit_finish_evidence?.journals?.archived
      || report.recovery_start_journal;
    const expectedArchiveEvidenceSource = archivedEvidenceJournal
      ? `preexisting_archived_journal:${archivedEvidenceJournal.journal_sha256}`
      : null;
    if (
      accounting.operation !== expectedOperation
      || !exactZero
      || accounting.evidence?.boundary !== expectedBoundary
      || accounting.evidence?.mutation_scope !== "current_recovery_invocation_only"
      || !sameJson(Object.keys(accounting.evidence).sort(), expectedEvidenceKeys)
      || reviewedJournalPersistenceEvidence(accounting) !== null
      || archive.state !== "completed_verified"
      || archive.commit_archive_accounting !== null
      || archive.local_journal_archive_writes_lower_bound !== 0
      || archive.response_loss_possible
      || (expectedArchiveEvidenceSource
        ? archive.evidence_source !== expectedArchiveEvidenceSource
        : !archive.evidence_source.startsWith("preexisting_archived_journal:"))
    ) throw new Error("Archived read-only recovery accounting profile is invalid.");
    return;
  }
  if (!new Set([
    "finish_partial_archive_then_fail",
    "finish_partial_archive_then_succeed",
    "resume_active_candidate_authority",
    "resume_active_old_authority",
  ]).has(expected)) {
    throw new Error("Reviewed recovery accounting has an unknown expected disposition.");
  }
  const candidate = new Set([
    "finish_partial_archive_then_succeed",
    "resume_active_candidate_authority",
  ]).has(expected);
  const persistence = reviewedJournalPersistenceEvidence(accounting, { required: true });
  if (
    accounting.operation !== "pointer_commit"
    || accounting.exact !== true
    || accounting.unknown_write_categories.length !== 0
    || accounting.evidence?.response_loss_possible !== false
    || accounting.evidence?.boundary !== "completed_journal_archive_verified"
    || accounting.evidence?.journal_phase !== "completed"
    || !sameJson(Object.keys(accounting.evidence).sort(), [
      "boundary",
      "cas",
      "journal_archive",
      "journal_persistence",
      "journal_phase",
      "response_loss_possible",
    ])
    || counts.r2_writes !== 0
    || counts.candidate_writes !== 0
    || counts.quarantine_writes !== 0
    || !new Set([0, 1]).has(counts.local_baseline_writes)
    || counts.database_writes !== counts.source_state_writes
    || (candidate
      ? !new Set([0, 1]).has(counts.database_writes)
      : counts.database_writes !== 0)
    || !new Set(["not_started", "verified"]).has(persistence.state)
    || persistence.response_loss_possible
    || archive.state !== "completed_verified"
    || archive.response_loss_possible
    || archive.commit_archive_accounting?.state !== "verified"
  ) throw new Error("Active recovery accounting profile is invalid.");
  assertRecoverySafeCas(accounting.evidence.cas);
}

function recoveryReportBaseDisposition(value) {
  return requiredText(value, "reviewed recovery report disposition").replace(
    /_source_lock_release_response_lost$/u,
    "",
  );
}

function normalizeRecoveryAuditReceipt(value, {
  sourceId,
  planFileSha256,
  planSha256,
  executionNonce,
  expectedAudit = null,
  expectedTerminal = null,
  expectedCompletionAuthority = null,
  expectedStatus = null,
  expectedFailureSha256 = null,
} = {}) {
  const receipt = assertStage1EvidenceSchemaUpgradeReviewedApplyAuditReceipt(value);
  const accounting = assertStage1EvidenceSchemaUpgradeReviewedApplyAuditAccounting(
    receipt.audit_mutation_accounting,
  );
  assertExactKeys(accounting.evidence, [
    "action",
    "disposition",
    "observed_row_status",
    "response_loss_possible",
  ], "reviewed recovery audit finish accounting evidence");
  const status = expectedStatus || expectedTerminal?.status || receipt.terminal_status;
  const replayDisposition = status === "succeeded"
    ? "terminal_success_replay"
    : status === "failed" ? "terminal_failure_replay" : null;
  const allowedDispositions = new Set([
    "finished",
    "finished_after_update_response_loss",
    replayDisposition,
  ].filter(Boolean));
  const expectedObservedRowStatus = status ? `terminal_${status}` : null;
  const counts = accounting.lower_bound_counts;
  const exactZero = accounting.exact === true
    && counts.local_worker_run_inserts === 0
    && counts.local_worker_run_terminal_updates === 0
    && accounting.unknown_write_categories.length === 0
    && accounting.evidence.response_loss_possible === false;
  const finished = receipt.disposition === "finished";
  const responseLost = receipt.disposition === "finished_after_update_response_loss";
  const replay = receipt.disposition === replayDisposition;
  const accountingMatchesDisposition = (
    finished
      && accounting.exact === true
      && counts.local_worker_run_inserts === 0
      && counts.local_worker_run_terminal_updates === 1
      && accounting.unknown_write_categories.length === 0
      && accounting.evidence.response_loss_possible === false
  ) || (
    responseLost
      && accounting.exact === false
      && counts.local_worker_run_inserts === 0
      && counts.local_worker_run_terminal_updates === 0
      && sameJson(
        accounting.unknown_write_categories,
        ["local_worker_run_terminal_updates"],
      )
      && accounting.evidence.response_loss_possible === true
  ) || (replay && exactZero);
  const terminalIdentitySha256 = expectedTerminal
    ?.selected_result_commit_identity?.identity_sha256 ?? null;
  const terminalFailureSha256 = expectedTerminal?.failure
    ? sha256(canonicalJson(expectedTerminal.failure))
    : expectedFailureSha256;
  if (
    receipt.action !== "finish"
    || receipt.run_id
      !== stage1EvidenceSchemaUpgradeReviewedApplyAuditRunId(planFileSha256)
    || receipt.plan_file_sha256 !== planFileSha256
    || receipt.plan_sha256 !== planSha256
    || receipt.selected_source_id !== sourceId
    || receipt.requested_execution_nonce !== executionNonce
    || receipt.active_execution_nonce !== executionNonce
    || receipt.business_execution_authorized !== false
    || !allowedDispositions.has(receipt.disposition)
    || receipt.terminal_status !== status
    || receipt.replay !== replay
    || accounting.evidence.action !== "finish"
    || accounting.evidence.disposition !== receipt.disposition
    || accounting.evidence.observed_row_status !== expectedObservedRowStatus
    || !accountingMatchesDisposition
    || (expectedTerminal && (
      receipt.terminal_completion_authority_mode
        !== expectedTerminal.completion_authority.mode
      || receipt.terminal_completion_authority_sha256
        !== expectedTerminal.completion_authority.completion_authority_sha256
      || receipt.terminal_identity_sha256 !== terminalIdentitySha256
      || receipt.terminal_failure_sha256 !== terminalFailureSha256
    ))
    || (expectedCompletionAuthority && (
      receipt.terminal_completion_authority_mode
        !== expectedCompletionAuthority.mode
      || receipt.terminal_completion_authority_sha256
        !== expectedCompletionAuthority.completion_authority_sha256
    ))
    || (status === "succeeded"
      ? !SHA256_PATTERN.test(receipt.terminal_identity_sha256 || "")
        || receipt.terminal_failure_sha256 !== null
      : receipt.terminal_identity_sha256 !== null
        || receipt.terminal_failure_sha256 !== terminalFailureSha256)
    || (expectedAudit && (
      receipt.run_id !== expectedAudit.run_id
      || receipt.authority_receipt_sha256 !== expectedAudit.authority_receipt_sha256
      || receipt.fresh_capture_evidence_sha256
        !== expectedAudit.fresh_capture.fresh_capture_sha256
      || receipt.fresh_capture_result_sha256
        !== expectedAudit.fresh_capture.capture_result_sha256
      || receipt.fresh_capture_validation_sha256
        !== expectedAudit.fresh_capture.capture_validation_sha256
      || receipt.fresh_validation_projection_sha256
        !== expectedAudit.fresh_capture.fresh_validation_projection_sha256
    ))
  ) throw new Error("Reviewed recovery audit finish receipt is not exact.");
  return deepFreeze({ receipt: cloneJson(receipt), accounting: cloneJson(accounting) });
}

function assertRecoveryReportArchiveAccountingParity(accounting, archive) {
  const nestedValue = accounting.evidence?.journal_archive;
  if (nestedValue === null || nestedValue === undefined) {
    if (archive.commit_archive_accounting !== null) {
      throw new Error("Reviewed recovery report archive accounting lacks trusted nested proof.");
    }
    return;
  }
  const nested = assertStage1EvidenceSchemaUpgradeJournalArchiveAccounting(nestedValue);
  if (
    !sameJson(archive.commit_archive_accounting, nested)
    || archive.archive_write_acknowledged !== nested.archive_receipt_acknowledged
    || archive.archive_readback_verified !== nested.archived_readback_verified
    || archive.active_removal_verified !== nested.active_absence_verified
    || archive.response_loss_possible !== nested.response_loss_possible
    || archive.local_journal_archive_writes_lower_bound
      !== nested.local_journal_archive_writes_lower_bound
    || archive.state !== (nested.state === "verified" ? "completed_verified" : "ambiguous")
  ) throw new Error("Reviewed recovery report archive accounting proofs contradict each other.");
}

function buildRecoveryAuditFinishAttempt({
  sourceId,
  terminal,
  completionAuthority,
  finishedAt,
  executionNonce,
  expectedAuditInspectionSha256,
  expectedRecoveryEvidenceSha256,
}) {
  const value = requiredObject(terminal, "reviewed recovery audit finish terminal");
  const authority = assertStage1EvidenceSchemaUpgradeReviewedApplyAuditCompletionAuthority(
    completionAuthority,
    { selectedSourceId: sourceId, finishedAt },
  );
  const finished = requiredTimestamp(finishedAt, "reviewed recovery audit finish attempt time");
  let selectedResultCommitIdentity = null;
  let failure = null;
  if (value.status === "succeeded") {
    assertExactKeys(value, ["commit_receipt", "selected_result", "status"],
      "reviewed recovery successful audit finish terminal");
    selectedResultCommitIdentity = buildRecoveryResultCommitIdentity({
      sourceId,
      selectedResult: value.selected_result,
      commitReceipt: value.commit_receipt,
    });
  } else if (value.status === "failed") {
    assertExactKeys(value, ["error_code", "error_message", "status"],
      "reviewed recovery failed audit finish terminal");
    const message = requiredText(
      value.error_message,
      "reviewed recovery audit finish failure message",
    );
    failure = {
      error_code: requiredText(
        value.error_code,
        "reviewed recovery audit finish failure code",
      ).slice(0, 200),
      error_summary: message.slice(0, 1000),
      error_message_sha256: sha256(message),
    };
  } else {
    throw new Error("Reviewed recovery audit finish status is invalid.");
  }
  const content = {
    schema_version:
      STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_RECOVERY_AUDIT_FINISH_ATTEMPT_SCHEMA,
    status: value.status,
    finished_at: finished,
    execution_nonce: requiredUuid(
      executionNonce,
      "reviewed recovery audit finish execution nonce",
    ),
    expected_audit_inspection_sha256: requiredSha256(
      expectedAuditInspectionSha256,
      "reviewed recovery audit finish inspection SHA-256",
    ),
    expected_recovery_evidence_sha256: requiredSha256(
      expectedRecoveryEvidenceSha256,
      "reviewed recovery audit finish evidence SHA-256",
    ),
    completion_authority: cloneJson(authority),
    selected_result_commit_identity: cloneJson(selectedResultCommitIdentity),
    failure: cloneJson(failure),
  };
  return deepFreeze({
    ...content,
    attempt_sha256: sha256(canonicalJson(content)),
  });
}

function assertRecoveryAuditFinishAttempt(value, report) {
  const attempt = requiredObject(value, "reviewed recovery audit finish attempt");
  assertExactKeys(attempt, [
    "attempt_sha256",
    "completion_authority",
    "execution_nonce",
    "expected_audit_inspection_sha256",
    "expected_recovery_evidence_sha256",
    "failure",
    "finished_at",
    "schema_version",
    "selected_result_commit_identity",
    "status",
  ], "reviewed recovery audit finish attempt");
  const content = cloneJson(attempt);
  delete content.attempt_sha256;
  const authority = assertStage1EvidenceSchemaUpgradeReviewedApplyAuditCompletionAuthority(
    content.completion_authority,
    { selectedSourceId: report.source_id, finishedAt: content.finished_at },
  );
  const finishEvidence = requiredObject(
    report.audit_finish_evidence,
    "reviewed recovery audit finish evidence",
  );
  const finishAudit = assertStage1EvidenceSchemaUpgradeReviewedApplyAuditRecoveryInspection(
    finishEvidence.auditInspection,
  );
  requiredTimestamp(content.finished_at, "reviewed recovery audit finish attempt time");
  if (
    content.schema_version
      !== STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_RECOVERY_AUDIT_FINISH_ATTEMPT_SCHEMA
    || !new Set(["failed", "succeeded"]).has(content.status)
    || attempt.attempt_sha256 !== sha256(canonicalJson(content))
    || authority.mode !== "reviewed_recovery"
    || authority.recovery.recovery_plan_file_sha256 !== report.recovery_plan_file_sha256
    || authority.recovery.recovery_plan_sha256 !== report.recovery_plan_sha256
    || authority.recovery.inspection_file_sha256 !== report.inspection_file_sha256
    || authority.recovery.inspection_sha256 !== report.inspection_sha256
    || authority.recovery.proposed_plan_sha256 !== report.proposed_plan_sha256
    || authority.recovery.source_id !== report.source_id
    || authority.recovery.transaction_id !== report.transaction_id
    || authority.recovery.expected_disposition !== report.reviewed_expected_disposition
    || content.execution_nonce !== report.execution_nonce
    || content.expected_audit_inspection_sha256 !== finishAudit.inspection_sha256
    || content.expected_audit_inspection_sha256
      !== report.recovery_start_audit_inspection?.inspection_sha256
    || content.expected_recovery_evidence_sha256
      !== stage1EvidenceSchemaUpgradeReviewedRecoveryEvidenceSha256(finishEvidence)
  ) throw new Error("Reviewed recovery audit finish attempt authority is invalid.");
  if (content.status === "succeeded") {
    if (content.failure !== null) {
      throw new Error("Successful audit finish attempt contains failure evidence.");
    }
    assertRecoveryReportResultIdentity(
      content.selected_result_commit_identity,
      report.source_id,
    );
    if (!new Set([
      "finish_partial_archive_then_succeed",
      "finish_succeeded_from_archived_candidate",
      "resume_active_candidate_authority",
    ]).has(authority.recovery.expected_disposition)) {
      throw new Error("Successful audit finish attempt conflicts with reviewed disposition.");
    }
  } else {
    if (content.selected_result_commit_identity !== null) {
      throw new Error("Failed audit finish attempt contains a result identity.");
    }
    const expected =
      stage1EvidenceSchemaUpgradeReviewedRecoveryFailureTerminalForDisposition(
        authority.recovery.expected_disposition,
      );
    if (!sameJson(content.failure, {
      error_code: expected.error_code,
      error_summary: expected.error_message.slice(0, 1000),
      error_message_sha256: sha256(expected.error_message),
    })) throw new Error("Failed audit finish attempt narrative is invalid.");
  }
  return deepFreeze(cloneJson(attempt));
}

function assertRecoveryReportFinishEvidence({ report, evidence, authority, audit }) {
  assertExactKeys(
    evidence,
    ["auditInspection", "currentAuthoritySnapshot", "journals"],
    "reviewed recovery audit finish evidence",
  );
  if (!sameJson(evidence.auditInspection, audit)) {
    throw new Error("Reviewed recovery finish evidence audit differs from its start audit.");
  }
  const projected = requiredObject(authority, "reviewed recovery finish authority projection");
  assertExactKeys(projected, [
    "activation_projection_sha256",
    "acquisition_projection_sha256",
    "audited_source_authority",
    "audited_source_authority_sha256",
    "authority_projection_sha256",
    "creates_api_charge",
    "current_source_authority",
    "finalization_projection_sha256",
    "local_baseline_identity",
    "mutation_performed",
    "pointer_identity",
    "r2_binding_receipt",
    "r2_binding_receipt_sha256",
    "source_health_classification",
    "source_id",
  ], "reviewed recovery finish authority projection");
  const authorityContent = cloneJson(projected);
  delete authorityContent.authority_projection_sha256;
  const snapshot = requiredObject(
    evidence.currentAuthoritySnapshot,
    "reviewed recovery finish current authority snapshot",
  );
  assertExactKeys(snapshot, [
    "acquisitionProjection",
    "activationProjection",
    "currentBaselineBytes",
    "currentPointer",
    "currentSource",
    "finalizationProjection",
    "r2BindingReceipt",
  ], "reviewed recovery finish current authority snapshot");
  const journals = requiredObject(evidence.journals, "reviewed recovery finish journals");
  assertExactKeys(journals, ["active", "archived"], "reviewed recovery finish journals");
  const selected = requiredObject(audit.binding.selected, "reviewed recovery selected authority");
  const expectedDisposition = report.reviewed_expected_disposition;
  const noJournal = expectedDisposition === "finish_failed_audit_started_before_journal";
  const candidate = new Set([
    "finish_partial_archive_then_succeed",
    "finish_succeeded_from_archived_candidate",
    "resume_active_candidate_authority",
  ]).has(expectedDisposition);
  const old = new Set([
    "finish_failed_from_archived_old",
    "finish_partial_archive_then_fail",
    "resume_active_old_authority",
  ]).has(expectedDisposition);
  if (!noJournal && !candidate && !old) {
    throw new Error("Reviewed recovery finish evidence has an unsupported disposition.");
  }
  let journal = null;
  if (noJournal) {
    if (journals.active !== null || journals.archived !== null) {
      throw new Error("No-journal recovery finish evidence contains a journal.");
    }
  } else {
    if (journals.active !== null || journals.archived === null) {
      throw new Error("Archived recovery finish evidence has the wrong journal locations.");
    }
    journal = assertStage1EvidenceSchemaUpgradeJournal(journals.archived);
    const binding = requiredObject(
      journal.operation_binding,
      "reviewed recovery finish journal operation binding",
    );
    if (
      journal.phase !== "completed"
      || journal.source_id !== report.source_id
      || journal.transaction_id !== report.transaction_id
      || binding.source_id !== report.source_id
      || binding.transaction_id !== report.transaction_id
      || binding.audit_run_id !== audit.run_id
      || binding.execution_nonce !== audit.execution_nonce
      || binding.reviewed_apply_plan_file_sha256 !== audit.plan_file_sha256
      || binding.reviewed_apply_plan_sha256 !== audit.plan_sha256
      || binding.fresh_capture_sha256 !== audit.fresh_capture.fresh_capture_sha256
      || binding.fresh_capture_result_sha256 !== audit.fresh_capture.capture_result_sha256
      || binding.fresh_capture_validation_sha256
        !== audit.fresh_capture.capture_validation_sha256
      || binding.fresh_validation_projection_sha256
        !== audit.fresh_capture.fresh_validation_projection_sha256
      || binding.precommit_authority_receipt_sha256 !== audit.authority_receipt_sha256
      || !sameJson(
        binding.precommit_source_authority,
        audit.authority_receipt.source_authority,
      )
    ) throw new Error("Reviewed recovery finish journal differs from its audit authority.");
  }
  const currentSourceAuthority = buildStage1EvidenceSchemaUpgradeSourceHealthAuthority(
    snapshot.currentSource,
  );
  const expectedClassification = candidate
    ? classifyStage1EvidenceSchemaUpgradeSourceHealthAuthority({
        precommitSourceAuthority: audit.authority_receipt.source_authority,
        currentSource: snapshot.currentSource,
        candidateBaselineBytes: stage1EvidenceSchemaUpgradeBaselineBytes(
          journal.candidate_baseline,
        ),
      }).classification
    : currentSourceAuthority.source_authority_sha256
        === audit.authority_receipt.source_authority.source_authority_sha256
      ? "exact_precommit"
      : "mismatch";
  const baselineProjection = requiredObject(
    snapshot.currentBaselineBytes,
    "reviewed recovery finish baseline projection",
  );
  assertExactKeys(baselineProjection, [
    "binary_byte_length",
    "binary_sha256",
  ], "reviewed recovery finish baseline projection");
  const expectedBaseline = noJournal
    ? selected.local_baseline_identity
    : candidate ? journal.candidate_baseline : journal.old_baseline;
  const expectedPointer = noJournal
    ? null
    : candidate
      ? journal.candidate_pointer_identity.projection
      : journal.old_pointer_identity.projection;
  const pointerIdentity = visualSnapshotPointerIdentity(snapshot.currentPointer);
  const r2Receipt =
    normalizeStage1EvidenceSchemaUpgradeReviewedRecoveryCurrentR2Receipt({
      receipt: snapshot.r2BindingReceipt,
      sourceId: report.source_id,
      currentPointer: snapshot.currentPointer,
    });
  if (candidate) {
    assertStage1EvidenceSchemaUpgradeReviewedRecoveryCandidateR2Pointer(
      snapshot.currentPointer,
    );
  } else {
    assertStage1EvidenceSchemaUpgradeReviewedRecoveryOldR2Authority({
      currentAuthority: projected,
      selected,
      auditInspection: audit,
    });
  }
  if (
    projected.source_id !== report.source_id
    || projected.authority_projection_sha256 !== sha256(canonicalJson(authorityContent))
    || !sameJson(projected.current_source_authority, currentSourceAuthority)
    || !sameJson(projected.audited_source_authority, audit.authority_receipt.source_authority)
    || projected.audited_source_authority_sha256
      !== audit.authority_receipt.source_authority.source_authority_sha256
    || projected.source_health_classification !== expectedClassification
    || expectedClassification !== (candidate ? "exact_already_current" : "exact_precommit")
  ) throw new Error("Reviewed recovery finish source authority is not exact.");
  if (
    !sameJson(projected.local_baseline_identity, {
      present: true,
      sha256: baselineProjection.binary_sha256,
      byte_length: baselineProjection.binary_byte_length,
    })
    || baselineProjection.binary_sha256 !== expectedBaseline.sha256
    || baselineProjection.binary_byte_length !== expectedBaseline.byte_length
  ) throw new Error("Reviewed recovery finish baseline authority is not exact.");
  if (!noJournal && !sameJson(snapshot.currentPointer, expectedPointer)) {
    throw new Error("Reviewed recovery finish pointer projection is not exact.");
  }
  if (!sameJson(projected.pointer_identity, {
      schema_version: pointerIdentity.schema_version,
      exists: pointerIdentity.exists,
      canonical_sha256: pointerIdentity.canonical_sha256,
    })) throw new Error("Reviewed recovery finish pointer identity is not exact.");
  if (noJournal && !sameJson(projected.pointer_identity, selected.existing_pointer_identity)) {
    throw new Error("No-journal recovery finish pointer identity differs from review.");
  }
  if (!sameJson(projected.r2_binding_receipt, r2Receipt)) {
    throw new Error("Reviewed recovery finish R2 receipt projection is not exact.");
  }
  if (
    projected.r2_binding_receipt_sha256 !== r2Receipt.receipt_sha256
    || r2Receipt.source_id !== report.source_id
  ) throw new Error("Reviewed recovery finish R2 receipt identity is not exact.");
  if (
    projected.mutation_performed !== false
    || projected.creates_api_charge !== false
    || projected.acquisition_projection_sha256
      !== sha256(canonicalJson(snapshot.acquisitionProjection))
    || projected.activation_projection_sha256
      !== sha256(canonicalJson(snapshot.activationProjection))
    || projected.finalization_projection_sha256
      !== sha256(canonicalJson(snapshot.finalizationProjection))
    || !sameJson(snapshot.acquisitionProjection, selected.acquisition)
    || !sameJson(snapshot.activationProjection, selected.activation)
    || !sameJson(snapshot.finalizationProjection, selected.finalization)
  ) throw new Error("Reviewed recovery finish evidence authority is not exact.");
}

function buildRecoveryResultCommitIdentity({
  sourceId,
  selectedResult,
  commitReceipt,
}) {
  const result = requiredObject(selectedResult, "reviewed recovery selected result");
  const receipt = requiredObject(commitReceipt, "reviewed recovery selected commit receipt");
  if (
    result.source_id !== sourceId
    || result.status !== "upgraded"
    || !requiredText(result.schema_version, "reviewed recovery selected result schema")
    || !sameJson(result.pointer_journal, { status: "upgraded", receipt })
    || receipt.schema_version !== STAGE1_EVIDENCE_SCHEMA_UPGRADE_COMMIT_RECEIPT_SCHEMA
    || receipt.source_id !== sourceId
    || receipt.status !== "upgraded"
    || receipt.operation !== "pointer_commit"
    || receipt.creates_api_charge !== false
    || receipt.journal_archived !== true
  ) throw new Error("Reviewed recovery audit finish result identity is invalid.");
  const accounting = assertStage1EvidenceSchemaUpgradeMutationAccounting(
    receipt.mutation_accounting,
    { operation: "pointer_commit" },
  );
  const content = {
    schema_version:
      STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_AUDIT_RESULT_IDENTITY_SCHEMA,
    source_id: sourceId,
    selected_result_schema_version: result.schema_version,
    selected_result_status: result.status,
    selected_result_sha256: sha256(canonicalJson(result)),
    commit_receipt_schema_version: receipt.schema_version,
    commit_receipt_status: receipt.status,
    commit_receipt_sha256: sha256(canonicalJson(receipt)),
    commit_journal_sha256: requiredSha256(
      receipt.journal_sha256,
      "reviewed recovery commit journal SHA-256",
    ),
    commit_mutation_accounting_sha256: accounting.accounting_sha256,
  };
  return deepFreeze({
    ...content,
    identity_sha256: sha256(canonicalJson(content)),
  });
}

function assertRecoveryReportAuditTerminal(value, report) {
  const terminal = requiredObject(value, "reviewed recovery report audit terminal");
  assertExactKeys(terminal, [
    "completion_authority",
    "failure",
    "finished_at",
    "schema_version",
    "selected_result_commit_identity",
    "status",
    "terminal_sha256",
  ], "reviewed recovery report audit terminal");
  const content = cloneJson(terminal);
  delete content.terminal_sha256;
  if (
    content.schema_version
      !== STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_AUDIT_TERMINAL_SCHEMA
    || !new Set(["failed", "succeeded"]).has(content.status)
    || terminal.terminal_sha256 !== sha256(canonicalJson(content))
  ) throw new Error("Reviewed recovery report audit terminal seal is invalid.");
  requiredTimestamp(content.finished_at, "reviewed recovery report audit terminal time");
  const authority =
    assertStage1EvidenceSchemaUpgradeReviewedApplyAuditCompletionAuthority(
      content.completion_authority,
      { selectedSourceId: report.source_id, finishedAt: content.finished_at },
    );
  const pureHistoricalReplay = new Set([
    "terminal_success_report_replay",
    "terminal_failure_report_replay",
  ]).has(recoveryReportBaseDisposition(report.disposition));
  if (
    report.status !== "recovery_required"
    && !pureHistoricalReplay
    && authority.mode !== "reviewed_recovery"
  ) throw new Error("Current recovery terminal lacks reviewed-recovery completion authority.");
  if (authority.mode === "reviewed_recovery") {
    if (pureHistoricalReplay) {
      assertHistoricalRecoveryTerminalAuthority({ authority, terminal: content, report });
    } else if (
      authority.recovery.recovery_plan_file_sha256 !== report.recovery_plan_file_sha256
      || authority.recovery.recovery_plan_sha256 !== report.recovery_plan_sha256
      || authority.recovery.inspection_file_sha256 !== report.inspection_file_sha256
      || authority.recovery.inspection_sha256 !== report.inspection_sha256
      || authority.recovery.proposed_plan_sha256 !== report.proposed_plan_sha256
      || authority.recovery.expected_disposition !== report.reviewed_expected_disposition
      || authority.recovery.source_id !== report.source_id
      || authority.recovery.transaction_id !== report.transaction_id
    ) throw new Error("Reviewed recovery report terminal authority differs from its plan.");
  } else if (pureHistoricalReplay) {
    assertFreshHistoricalTerminalAuthority({ terminal: content, report });
  }
  if (content.status === "succeeded") {
    if (content.failure !== null) {
      throw new Error("Succeeded reviewed recovery audit terminal contains failure evidence.");
    }
    assertRecoveryReportResultIdentity(content.selected_result_commit_identity, report.source_id);
    if (
      report.commit_receipt !== null
      && authority.mode === "reviewed_recovery"
    ) {
      const expectedDisposition = authority.recovery.expected_disposition;
      const allowed = report.recovery_start_journal_location === "archived"
        ? new Set(["finish_succeeded_from_archived_candidate"])
        : new Set([
            "finish_partial_archive_then_succeed",
            "resume_active_candidate_authority",
          ]);
      if (!allowed.has(expectedDisposition)) {
        throw new Error(
          "Reviewed recovery success proof conflicts with its completion disposition.",
        );
      }
    }
  } else {
    if (content.selected_result_commit_identity !== null) {
      throw new Error("Failed reviewed recovery audit terminal contains a result identity.");
    }
    const failure = requiredObject(content.failure, "reviewed recovery audit failure");
    assertExactKeys(failure, [
      "error_code",
      "error_message_sha256",
      "error_summary",
    ], "reviewed recovery audit failure");
    requiredText(failure.error_code, "reviewed recovery audit failure code");
    requiredText(failure.error_summary, "reviewed recovery audit failure summary");
    if (!SHA256_PATTERN.test(failure.error_message_sha256 || "")) {
      throw new Error("Reviewed recovery audit failure hash is invalid.");
    }
    if (authority.mode === "reviewed_recovery") {
      const expected =
        stage1EvidenceSchemaUpgradeReviewedRecoveryFailureTerminalForDisposition(
          authority.recovery.expected_disposition,
        );
      if (
        failure.error_code !== expected.error_code
        || failure.error_summary !== expected.error_message.slice(0, 1000)
        || failure.error_message_sha256 !== sha256(expected.error_message)
      ) {
        throw new Error(
          "Reviewed recovery failure narrative conflicts with its completion disposition.",
        );
      }
    } else if (
      authority.mode === "fresh_reviewed_apply"
      && new Set([
        "finish_partial_archive_then_replay_old_abandonment",
        "report_replay_archived_old_abandonment",
      ]).has(report.reviewed_expected_disposition)
      && (
        failure.error_code
          !== FRESH_REVIEWED_APPLY_ABANDONED_OLD_FAILURE.error_code
        || failure.error_summary
          !== FRESH_REVIEWED_APPLY_ABANDONED_OLD_FAILURE.error_message
        || failure.error_message_sha256
          !== sha256(FRESH_REVIEWED_APPLY_ABANDONED_OLD_FAILURE.error_message)
      )
    ) {
      throw new Error(
        "Fresh reviewed-apply archived-old report has a false failure narrative.",
      );
    }
  }
  return terminal;
}

function assertHistoricalRecoveryTerminalAuthority({ authority, terminal, report }) {
  if (
    authority.recovery.source_id !== report.source_id
    || authority.recovery.transaction_id !== report.transaction_id
    || authority.recovery.recovery_plan_sha256 === report.recovery_plan_sha256
    || authority.recovery.recovery_plan_file_sha256 === report.recovery_plan_file_sha256
  ) throw new Error("Historical recovery terminal authority is not a distinct prior plan.");
  const originalDisposition = authority.recovery.expected_disposition;
  const replayDisposition = report.reviewed_expected_disposition;
  const journal = report.recovery_start_journal === null
    ? null
    : assertStage1EvidenceSchemaUpgradeJournal(report.recovery_start_journal);
  if (terminal.status === "succeeded") {
    if (
      !new Set([
        "finish_partial_archive_then_succeed",
        "finish_succeeded_from_archived_candidate",
        "resume_active_candidate_authority",
      ]).has(originalDisposition)
      || !new Set([
        "finish_partial_archive_then_replay_candidate_success",
        "report_replay_archived_candidate_success",
      ]).has(replayDisposition)
      || !journalHasCompletionOutcome(journal, "committed_candidate")
      || terminal.selected_result_commit_identity?.commit_journal_sha256
        !== journal.journal_sha256
    ) throw new Error("Historical recovery success authority conflicts with replay proof.");
    assertHistoricalReplayJournalTopology(report, replayDisposition);
    return;
  }
  const beforeJournal = replayDisposition === "report_replay_failed_before_journal";
  if (beforeJournal) {
    if (originalDisposition !== "finish_failed_audit_started_before_journal" || journal !== null) {
      throw new Error("Historical recovery pre-journal failure authority is invalid.");
    }
    return;
  }
  if (
    !new Set([
      "finish_failed_from_archived_old",
      "finish_partial_archive_then_fail",
      "resume_active_old_authority",
    ]).has(originalDisposition)
    || !new Set([
      "finish_partial_archive_then_replay_old_abandonment",
      "report_replay_archived_old_abandonment",
    ]).has(replayDisposition)
    || !journalHasCompletionOutcome(journal, "abandoned_old_authority")
  ) throw new Error("Historical recovery failure authority conflicts with replay proof.");
  assertHistoricalReplayJournalTopology(report, replayDisposition);
}

function assertFreshHistoricalTerminalAuthority({ terminal, report }) {
  const replayDisposition = report.reviewed_expected_disposition;
  const journal = report.recovery_start_journal === null
    ? null
    : assertStage1EvidenceSchemaUpgradeJournal(report.recovery_start_journal);
  if (terminal.status === "succeeded") {
    if (
      !new Set([
        "finish_partial_archive_then_replay_candidate_success",
        "report_replay_archived_candidate_success",
      ]).has(replayDisposition)
      || !journalHasCompletionOutcome(journal, "committed_candidate")
      || terminal.selected_result_commit_identity?.commit_journal_sha256
        !== journal.journal_sha256
    ) throw new Error("Fresh reviewed-apply success replay proof is invalid.");
    assertHistoricalReplayJournalTopology(report, replayDisposition);
    return;
  }
  if (replayDisposition === "report_replay_failed_before_journal") {
    if (journal !== null) {
      throw new Error("Fresh reviewed-apply pre-journal replay contains a journal.");
    }
    return;
  }
  if (
    !new Set([
      "finish_partial_archive_then_replay_old_abandonment",
      "report_replay_archived_old_abandonment",
    ]).has(replayDisposition)
    || !journalHasCompletionOutcome(journal, "abandoned_old_authority")
  ) throw new Error("Fresh reviewed-apply failure replay proof is invalid.");
  assertHistoricalReplayJournalTopology(report, replayDisposition);
}

function assertHistoricalReplayJournalTopology(report, disposition) {
  const partial = disposition.startsWith("finish_partial_archive_then_replay_");
  const archive = requiredObject(
    report.journal_archive_persistence,
    "historical replay archive evidence",
  );
  if (partial) {
    if (
      report.recovery_start_journal_location !== "active"
      || report.recovery_completed_journal === null
      || report.reviewed_reconciliation_evidence === null
      || archive.commit_archive_accounting === null
      || archive.state !== "completed_verified"
    ) throw new Error("Historical partial-archive replay lacks exact cleanup proof.");
    return;
  }
  if (
    report.recovery_start_journal_location !== "archived"
    || report.recovery_completed_journal !== null
    || report.reviewed_reconciliation_evidence !== null
    || archive.commit_archive_accounting !== null
    || archive.state !== "completed_verified"
  ) throw new Error("Historical archived replay topology is invalid.");
}

function journalHasCompletionOutcome(journal, outcome) {
  if (!journal || journal.phase !== "completed") return false;
  const detail = journal.phase_history?.at(-1)?.detail;
  const candidate = outcome === "committed_candidate";
  return detail?.outcome === outcome
    && detail.authoritative_pointer_sha256 === (
      candidate
        ? journal.candidate_pointer_identity.canonical_sha256
        : journal.old_pointer_identity.canonical_sha256
    )
    && detail.authoritative_baseline_sha256 === (
      candidate ? journal.candidate_baseline.sha256 : journal.old_baseline.sha256
    )
    && (
      !candidate
      || new Set(["already_current", "succeeded"]).has(detail.source_health_status)
    )
    && detail.cleanup_debt_delete_performed === false;
}

function assertRecoveryReportResultIdentity(value, sourceId) {
  const identity = requiredObject(value, "reviewed recovery result/commit identity");
  assertExactKeys(identity, [
    "commit_journal_sha256",
    "commit_mutation_accounting_sha256",
    "commit_receipt_schema_version",
    "commit_receipt_sha256",
    "commit_receipt_status",
    "identity_sha256",
    "schema_version",
    "selected_result_schema_version",
    "selected_result_sha256",
    "selected_result_status",
    "source_id",
  ], "reviewed recovery result/commit identity");
  const content = cloneJson(identity);
  delete content.identity_sha256;
  if (
    content.schema_version
      !== STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_AUDIT_RESULT_IDENTITY_SCHEMA
    || content.source_id !== sourceId
    || content.selected_result_status !== "upgraded"
    || content.commit_receipt_schema_version
      !== STAGE1_EVIDENCE_SCHEMA_UPGRADE_COMMIT_RECEIPT_SCHEMA
    || content.commit_receipt_status !== "upgraded"
    || [
      content.selected_result_sha256,
      content.commit_receipt_sha256,
      content.commit_journal_sha256,
      content.commit_mutation_accounting_sha256,
    ].some((hash) => !SHA256_PATTERN.test(hash || ""))
    || identity.identity_sha256 !== sha256(canonicalJson(content))
  ) throw new Error("Reviewed recovery result/commit identity seal is invalid.");
  return identity;
}

function assertRecoveryReportCommitReceipt(value, report) {
  const receipt = requiredObject(value, "reviewed recovery report commit receipt");
  const journal = assertStage1EvidenceSchemaUpgradeJournal(
    report.recovery_start_journal,
  );
  const completedJournal = assertStage1EvidenceSchemaUpgradeJournal(
    report.recovery_completed_journal,
  );
  const audit = assertStage1EvidenceSchemaUpgradeReviewedApplyAuditRecoveryInspection(
    report.recovery_start_audit_inspection,
  );
  const location = requiredText(
    report.recovery_start_journal_location,
    "reviewed recovery start journal location",
  );
  if (!new Set(["active", "archived"]).has(location)) {
    throw new Error("Reviewed recovery start journal location is invalid.");
  }
  const binding = requiredObject(
    journal.operation_binding,
    "reviewed recovery start journal operation binding",
  );
  const expectedReconciliation = expectedReviewedReconciliationEvidence(
    completedJournal,
  );
  const reconciliation = assertStage1EvidenceSchemaUpgradeReviewedReconciliationEvidence(
    report.reviewed_reconciliation_evidence,
  );
  const accounting = assertStage1EvidenceSchemaUpgradeMutationAccounting(
    receipt.mutation_accounting,
    { operation: "pointer_commit" },
  );
  const archivedReplay = location === "archived";
  const receiptProfile = archivedReplay || journal.phase !== "completed"
    ? "committed_candidate"
    : "candidate_authority_recovered";
  const accountingProfile = archivedReplay
    ? "archived_read_only_replay"
    : "current_invocation_verified_archive";
  if (
    journal.schema_version !== STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_JOURNAL_SCHEMA
    || completedJournal.schema_version
      !== STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_JOURNAL_SCHEMA
    || journal.source_id !== report.source_id
    || journal.transaction_id !== report.transaction_id
    || completedJournal.source_id !== report.source_id
    || completedJournal.transaction_id !== report.transaction_id
    || completedJournal.phase !== "completed"
    || completedJournal.journal_sha256 !== receipt.journal_sha256
    || !sameJson(completedJournal.operation_binding, journal.operation_binding)
    || !sameJson(completedJournal.old_baseline, journal.old_baseline)
    || !sameJson(completedJournal.candidate_baseline, journal.candidate_baseline)
    || !sameJson(completedJournal.old_pointer_identity, journal.old_pointer_identity)
    || !sameJson(
      completedJournal.candidate_pointer_identity,
      journal.candidate_pointer_identity,
    )
    || !sameJson(completedJournal.candidate_object_keys, journal.candidate_object_keys)
    || binding.source_id !== report.source_id
    || binding.transaction_id !== report.transaction_id
    || binding.audit_run_id !== audit.run_id
    || binding.execution_nonce !== audit.execution_nonce
    || binding.reviewed_apply_plan_file_sha256 !== audit.plan_file_sha256
    || binding.reviewed_apply_plan_sha256 !== audit.plan_sha256
    || binding.fresh_capture_sha256 !== audit.fresh_capture.fresh_capture_sha256
    || binding.fresh_capture_result_sha256 !== audit.fresh_capture.capture_result_sha256
    || binding.fresh_capture_validation_sha256
      !== audit.fresh_capture.capture_validation_sha256
    || binding.fresh_validation_projection_sha256
      !== audit.fresh_capture.fresh_validation_projection_sha256
    || binding.precommit_authority_receipt_sha256 !== audit.authority_receipt_sha256
    || !sameJson(
      binding.precommit_source_authority,
      audit.authority_receipt.source_authority,
    )
    || audit.inspection_sha256 !== report.audit_before_inspection_sha256
    || audit.selected_source_id !== report.source_id
    || audit.execution_nonce !== report.execution_nonce
    || audit.plan_file_sha256 !== report.reviewed_apply_plan_file_sha256
    || audit.plan_sha256 !== report.reviewed_apply_plan_sha256
    || !sameJson(reconciliation, expectedReconciliation)
    || !sameJson(accounting, report.recovery_invocation_mutation_accounting)
    || (archivedReplay && (
      journal.phase !== "completed"
      || !sameJson(completedJournal, journal)
      || report.journal_archive_persistence.state !== "completed_verified"
      || report.journal_archive_persistence.commit_archive_accounting !== null
      || !report.journal_archive_persistence.evidence_source.startsWith(
        "preexisting_archived_journal:",
      )
    ))
    || (!archivedReplay && (
      report.journal_archive_persistence.state !== "completed_verified"
      || !sameJson(
        report.journal_archive_persistence.commit_archive_accounting,
        accounting.evidence?.journal_archive,
      )
    ))
  ) throw new Error("Reviewed recovery report commit proof is not exact.");
  return assertStage1EvidenceSchemaUpgradeReviewedRecoverySucceededTerminal({
    sourceId: report.source_id,
    transactionId: report.transaction_id,
    journal,
    auditInspection: audit,
    selectedResult: report.selected_result,
    commitReceipt: receipt,
    receiptProfile,
    accountingProfile,
  });
}

/**
 * Executes only a separately reviewed exact-transaction recovery plan.
 *
 * The raw parent apply plan/report/manifest are revalidated as historical
 * evidence before a source lock is acquired. The recovery plan and all live
 * audit/journal/DB/R2/local authority are then re-read and revalidated while
 * the exact source lock is held. No capture, browser, upload, pointer CAS,
 * candidate, quarantine, public-fact, hold, or generic reconciliation callback
 * is accepted by this interface.
 */
export async function runStage1EvidenceSchemaUpgradeReviewedRecoveryExecution({
  recoveryPlanBytes,
  expectedRecoveryPlanFileSha256,
  applyPlanBytes,
  expectedApplyPlanFileSha256,
  reviewedDryRunReportBytes,
  manifest,
  interfaces = {},
  now = () => new Date().toISOString(),
} = {}) {
  const historical =
    validateStage1EvidenceSchemaUpgradeReviewedApplyHistoricalEvidence({
      planBytes: applyPlanBytes,
      expectedPlanFileSha256: expectedApplyPlanFileSha256,
      reportBytes: reviewedDryRunReportBytes,
      manifest,
    });
  const io = validateInterfaces(interfaces);
  const sourceId = historical.selected_source_id;
  const transactionId = stage1EvidenceSchemaUpgradeReviewedApplyTransactionId({
    sourceId,
    planSha256: historical.plan_sha256,
  });
  const clock = executionClock(now);
  let entered = false;
  let lockedReport = null;
  let lockError = null;
  try {
    await io.withSourceLock(deepFreeze({
      source_id: sourceId,
      transaction_id: transactionId,
      creates_api_charge: false,
      execute: async () => {
        if (entered) {
          throw new Error("Reviewed recovery source lock invoked its execution more than once.");
        }
        entered = true;
        // Establish the monotonic clock authority after the source lock is
        // acquired and before the first potentially slow DB/R2 evidence read.
        // A rollback during that read must never extend the reviewed window.
        clock.read();
        lockedReport = await executeLocked({
          recoveryPlanBytes,
          expectedRecoveryPlanFileSha256,
          applyPlanBytes,
          expectedApplyPlanFileSha256,
          reviewedDryRunReportBytes,
          manifest,
          historical,
          sourceId,
          transactionId,
          io,
          clock,
        });
        return lockedReport;
      },
    }));
  } catch (error) {
    lockError = error;
  }
  if (!entered) {
    if (lockError) throw lockError;
    throw new Error("Reviewed recovery source lock did not execute the locked operation.");
  }
  if (!lockedReport) throw lockError || new Error("Reviewed recovery produced no locked report.");
  return lockError ? markSourceLockResponseLoss(lockedReport) : lockedReport;
}

async function executeLocked(context) {
  const before = await readAndValidateReviewedEvidence(context);
  const disposition = before.validated.expected_disposition;
  const originalAccounting = interruptedOriginalAccounting(before.evidence.journals);
  const zeroRecoveryAccounting = recoveryAccounting({
    boundary: "reviewed_recovery_inspection_only",
    lowerBoundCounts: zeroStage1EvidenceSchemaUpgradeMutationCounts(),
    unknownWriteCategories: [],
    responseLossPossible: false,
  });

  if (disposition.startsWith("inspect_")) {
    return buildReport({
      context,
      before,
      after: before,
      status: "recovery_required",
      disposition,
      selectedResult: null,
      commitReceipt: null,
      terminal: before.audit.terminal,
      originalAccounting,
      recoveryAccounting: zeroRecoveryAccounting,
      archiveEvidence: archiveEvidenceForInspection(before),
      auditReceipt: null,
      responseLossPossible: false,
    });
  }

  if (disposition === "report_replay_failed_before_journal") {
    return terminalReplayReport({ context, before, originalAccounting });
  }
  if (disposition === "report_replay_archived_candidate_success"
      || disposition === "report_replay_archived_old_abandonment") {
    return terminalReplayReport({ context, before, originalAccounting });
  }

  if (disposition.startsWith("finish_partial_archive_then_replay_")) {
    return finishPartialArchive({
      context,
      before,
      originalAccounting,
      replayTerminal: true,
    });
  }

  if (disposition === "finish_partial_archive_then_succeed"
      || disposition === "finish_partial_archive_then_fail") {
    return finishPartialArchive({
      context,
      before,
      originalAccounting,
      replayTerminal: false,
    });
  }

  if (disposition === "finish_failed_audit_started_before_journal") {
    const failure =
      stage1EvidenceSchemaUpgradeReviewedRecoveryFailureTerminalForDisposition(
        disposition,
      );
    const stable = await readAndValidateReviewedEvidence(context);
    assertSameValidatedRecoveryPlan(stable.validated, before.validated);
    return finishFailedAudit({
      context,
      before: stable,
      afterBusiness: stable,
      originalAccounting,
      recoveryAccounting: zeroRecoveryAccounting,
      archiveEvidence: notStartedArchiveEvidence(),
      errorCode: failure.error_code,
      errorMessage: failure.error_message,
    });
  }

  if (disposition === "finish_succeeded_from_archived_candidate") {
    return finishFromArchived({
      context,
      before,
      originalAccounting,
      authority: "candidate",
    });
  }
  if (disposition === "finish_failed_from_archived_old") {
    return finishFromArchived({
      context,
      before,
      originalAccounting,
      authority: "old",
    });
  }

  if (disposition === "resume_active_candidate_authority"
      || disposition === "resume_active_old_authority") {
    return recoverActive({ context, before, originalAccounting });
  }

  throw new Error(`Unsupported reviewed recovery disposition: ${disposition}.`);
}

async function recoverActive({ context, before, originalAccounting }) {
  const stable = await readAndValidateReviewedEvidence(context);
  assertSameValidatedRecoveryPlan(stable.validated, before.validated);
  const active = requiredObject(stable.evidence.journals.active, "active reviewed journal");
  let returned = null;
  let actionError = null;
  try {
    returned = await context.io.recoverActiveJournal(deepFreeze({
      source_id: context.sourceId,
      transaction_id: context.transactionId,
      expected_active_journal_sha256: active.journal_sha256,
      operation_binding: cloneJson(active.operation_binding),
      recovery_plan_file_sha256: stable.validated.plan_file_sha256,
      recovery_plan_sha256: stable.validated.plan_sha256,
      recovery_plan_expires_at: stable.validated.reviewer.expires_at,
      expected_recovery_evidence_sha256:
        stage1EvidenceSchemaUpgradeReviewedRecoveryEvidenceSha256(stable.evidence),
      expected_audit_inspection_sha256: stable.audit.inspection_sha256,
      creates_api_charge: false,
    }));
  } catch (error) {
    actionError = error;
  }
  const recoveryAccountingValue = recoveryAccountingFromCommit({
    result: returned,
    error: actionError,
    boundary: "active_journal_recovery",
  });
  let archiveEvidence = archiveEvidenceFromCommit({
    result: returned,
    error: actionError,
  });
  if (actionError || !returned) {
    archiveEvidence = downgradeUntrustedArchiveEvidence(
      archiveEvidence,
      "active_recovery_callback_response_unverified",
    );
    const unverifiedAccounting = unverifiedCommitResponseAccounting(
      recoveryAccountingValue,
      "active_journal_recovery_response_unverified",
    );
    return recoveryRequiredAfterAction({
      context,
      before: stable,
      originalAccounting,
      recoveryAccounting: unverifiedAccounting,
      archiveEvidence,
      disposition: "active_recovery_response_or_outcome_unverified",
      responseLossPossible: commitResponseLossPossible(
        unverifiedAccounting,
        archiveEvidence,
      ),
    });
  }
  let commit;
  try {
    commit = normalizeCommitResult(returned, {
      sourceId: context.sourceId,
      transactionId: context.transactionId,
      expectedJournal: active,
    });
  } catch {
    archiveEvidence = downgradeUntrustedArchiveEvidence(
      archiveEvidence,
      "active_recovery_result_invalid",
    );
    const unverifiedAccounting = unverifiedCommitResponseAccounting(
      recoveryAccountingValue,
      "active_journal_recovery_result_invalid",
    );
    return recoveryRequiredAfterAction({
      context,
      before: stable,
      originalAccounting,
      recoveryAccounting: unverifiedAccounting,
      archiveEvidence,
      disposition: "active_recovery_result_or_receipt_invalid",
      responseLossPossible: true,
    });
  }
  if (commit.status === "recovery_required") {
    archiveEvidence = downgradeUntrustedArchiveEvidence(
      archiveEvidence,
      "active_recovery_unresolved_result_archive_unverified",
    );
    const unverifiedAccounting = unverifiedCommitResponseAccounting(
      recoveryAccountingValue,
      "active_journal_recovery_unresolved_result",
    );
    return recoveryRequiredAfterAction({
      context,
      before: stable,
      originalAccounting,
      recoveryAccounting: unverifiedAccounting,
      archiveEvidence,
      disposition: "active_recovery_left_authority_unresolved",
      responseLossPossible: commitResponseLossPossible(
        unverifiedAccounting,
        archiveEvidence,
      ),
    });
  }
  const expectedCommitStatus = stable.validated.expected_disposition
    === "resume_active_candidate_authority"
    ? "upgraded"
    : "abandoned_old_authority";
  if (commit.status !== expectedCommitStatus) {
    archiveEvidence = downgradeUntrustedArchiveEvidence(
      archiveEvidence,
      "active_recovery_cross_outcome_archive_unverified",
    );
    const unverifiedAccounting = unverifiedCommitResponseAccounting(
      recoveryAccountingValue,
      "active_journal_recovery_crossed_unreviewed_outcome",
    );
    return recoveryRequiredAfterAction({
      context,
      before: stable,
      originalAccounting,
      recoveryAccounting: unverifiedAccounting,
      archiveEvidence,
      disposition: "active_recovery_crossed_unreviewed_authority_outcome",
      responseLossPossible: commitResponseLossPossible(
        unverifiedAccounting,
        archiveEvidence,
      ),
    });
  }
  if (
    archiveEvidence.state !== "completed_verified"
    || archiveEvidence.response_loss_possible === true
  ) {
    return recoveryRequiredAfterAction({
      context,
      before: stable,
      originalAccounting,
      recoveryAccounting: recoveryAccountingValue,
      archiveEvidence,
      disposition: "active_recovery_archive_not_exactly_verified",
      responseLossPossible: archiveEvidence.response_loss_possible,
    });
  }
  const post = await safeReadPostArchive(context, {
    expectedOperationBinding: active.operation_binding,
    expectedJournalSha256: commit.receipt.journal_sha256,
    expectedAuthority: commit.status === "upgraded" ? "candidate" : "old",
    expectedAudit: stable.audit,
  });
  if (!post.verified) {
    return recoveryRequiredAfterAction({
      context,
      before: stable,
      originalAccounting,
      recoveryAccounting: recoveryAccountingValue,
      archiveEvidence,
      disposition: "active_recovery_post_state_unverified",
      responseLossPossible: post.responseLossPossible,
    });
  }
  if (commit.status === "upgraded") {
    const selectedResult = selectedRecoveryResult({
      audit: post.state.audit,
      commitResult: commit,
      evaluatedAt: context.clock.read(),
    });
    return finishSucceededAudit({
      context,
      before: stable,
      afterBusiness: post.state,
      selectedResult,
      commitReceipt: commit.receipt,
      originalAccounting,
      recoveryAccounting: recoveryAccountingValue,
      archiveEvidence,
    });
  }
  const failure =
    stage1EvidenceSchemaUpgradeReviewedRecoveryFailureTerminalForDisposition(
      stable.validated.expected_disposition,
    );
  return finishFailedAudit({
    context,
    before: stable,
    afterBusiness: post.state,
    originalAccounting,
    recoveryAccounting: recoveryAccountingValue,
    archiveEvidence,
    errorCode: failure.error_code,
    errorMessage: failure.error_message,
  });
}

async function finishFromArchived({
  context,
  before,
  originalAccounting,
  authority,
}) {
  const stable = await readAndValidateReviewedEvidence(context);
  assertSameValidatedRecoveryPlan(stable.validated, before.validated);
  const archived = requiredObject(stable.evidence.journals.archived, "archived journal");
  const archiveEvidence = verifiedArchivedEvidence(archived);
  const recoveryAccountingValue = recoveryAccounting({
    boundary: "archived_completion_read_only_replay",
    lowerBoundCounts: zeroStage1EvidenceSchemaUpgradeMutationCounts(),
    unknownWriteCategories: [],
    responseLossPossible: false,
  });
  if (authority === "old") {
    const failure =
      stage1EvidenceSchemaUpgradeReviewedRecoveryFailureTerminalForDisposition(
        stable.validated.expected_disposition,
      );
    return finishFailedAudit({
      context,
      before: stable,
      afterBusiness: stable,
      originalAccounting,
      recoveryAccounting: recoveryAccountingValue,
      archiveEvidence,
      errorCode: failure.error_code,
      errorMessage: failure.error_message,
    });
  }
  const commit = archivedReplayCommitResult({
    sourceId: context.sourceId,
    transactionId: context.transactionId,
    journal: archived,
  });
  const selectedResult = selectedRecoveryResult({
    audit: stable.audit,
    commitResult: commit,
    evaluatedAt: context.clock.read(),
  });
  return finishSucceededAudit({
    context,
    before: stable,
    afterBusiness: stable,
    selectedResult,
    commitReceipt: commit.receipt,
    originalAccounting,
    recoveryAccounting: commit.mutation_accounting,
    archiveEvidence,
  });
}

async function finishPartialArchive({
  context,
  before,
  originalAccounting,
  replayTerminal,
}) {
  const stable = await readAndValidateReviewedEvidence(context);
  assertSameValidatedRecoveryPlan(stable.validated, before.validated);
  const active = requiredObject(stable.evidence.journals.active, "partial active journal");
  let returned = null;
  let error = null;
  try {
    returned = await context.io.recoverActiveJournal(deepFreeze({
      source_id: context.sourceId,
      transaction_id: context.transactionId,
      expected_active_journal_sha256: active.journal_sha256,
      expected_archived_journal_sha256:
        stable.evidence.journals.archived.journal_sha256,
      operation_binding: cloneJson(active.operation_binding),
      recovery_plan_file_sha256: stable.validated.plan_file_sha256,
      recovery_plan_sha256: stable.validated.plan_sha256,
      recovery_plan_expires_at: stable.validated.reviewer.expires_at,
      expected_recovery_evidence_sha256:
        stage1EvidenceSchemaUpgradeReviewedRecoveryEvidenceSha256(stable.evidence),
      expected_audit_inspection_sha256: stable.audit.inspection_sha256,
      creates_api_charge: false,
    }));
  } catch (cause) {
    error = cause;
  }
  let archiveEvidence = archiveEvidenceFromCommit({ result: returned, error });
  let recoveryAccountingValue = recoveryAccountingFromCommit({
    result: returned,
    error,
    boundary: "finish_partial_completed_archive",
  });
  let commit = null;
  if (!error && returned) {
    try {
      commit = normalizeCommitResult(returned, {
        sourceId: context.sourceId,
        transactionId: context.transactionId,
        expectedJournal: active,
      });
    } catch (cause) {
      error = cause;
      archiveEvidence = downgradeUntrustedArchiveEvidence(
        archiveEvidence,
        "partial_archive_result_invalid",
      );
    }
  }
  if (
    error
    || !commit
    || archiveEvidence.state !== "completed_verified"
    || archiveEvidence.response_loss_possible
  ) {
    if (error || !commit) {
      archiveEvidence = downgradeUntrustedArchiveEvidence(
        archiveEvidence,
        "partial_archive_callback_response_unverified",
      );
    }
    if (error || !commit) {
      recoveryAccountingValue = unverifiedCommitResponseAccounting(
        recoveryAccountingValue,
        "partial_archive_commit_response_unverified",
      );
    }
    return recoveryRequiredAfterAction({
      context,
      before: stable,
      originalAccounting,
      recoveryAccounting: recoveryAccountingValue,
      archiveEvidence,
      disposition: "partial_archive_completion_unverified",
      responseLossPossible: commitResponseLossPossible(
        recoveryAccountingValue,
        archiveEvidence,
      ),
    });
  }
  const expectedAuthority = stable.validated.expected_disposition.includes("candidate")
    || stable.validated.expected_disposition.endsWith("succeed")
    ? "candidate"
    : "old";
  const expectedStatus = expectedAuthority === "candidate"
    ? "upgraded"
    : "abandoned_old_authority";
  if (commit.status !== expectedStatus) {
    archiveEvidence = downgradeUntrustedArchiveEvidence(
      archiveEvidence,
      "partial_archive_cross_outcome_archive_unverified",
    );
    const unverifiedAccounting = unverifiedCommitResponseAccounting(
      recoveryAccountingValue,
      "partial_archive_crossed_unreviewed_outcome",
    );
    return recoveryRequiredAfterAction({
      context,
      before: stable,
      originalAccounting,
      recoveryAccounting: unverifiedAccounting,
      archiveEvidence,
      disposition: "partial_archive_crossed_unreviewed_authority_outcome",
      responseLossPossible: commitResponseLossPossible(
        unverifiedAccounting,
        archiveEvidence,
      ),
    });
  }
  const post = await safeReadPostArchive(context, {
    expectedOperationBinding: active.operation_binding,
    expectedJournalSha256: active.journal_sha256,
    expectedAuthority,
    expectedAudit: stable.audit,
  });
  if (!post.verified) {
    return recoveryRequiredAfterAction({
      context,
      before: stable,
      originalAccounting,
      recoveryAccounting: recoveryAccountingValue,
      archiveEvidence,
      disposition: "partial_archive_post_state_unverified",
      responseLossPossible: post.responseLossPossible,
    });
  }
  if (replayTerminal) {
    return terminalReplayReport({
      context,
      before: { ...post.state, validated: stable.validated },
      originalAccounting,
      recoveryAccounting: recoveryAccountingValue,
      archiveEvidence,
      recoveryStartJournal: active,
      recoveryCompletedJournal: post.state.evidence.journals.archived,
    });
  }
  if (expectedAuthority === "candidate") {
    const selectedResult = selectedRecoveryResult({
      audit: post.state.audit,
      commitResult: commit,
      evaluatedAt: context.clock.read(),
    });
    return finishSucceededAudit({
      context,
      before: stable,
      afterBusiness: post.state,
      selectedResult,
      commitReceipt: commit.receipt,
      originalAccounting,
      recoveryAccounting: recoveryAccountingValue,
      archiveEvidence,
    });
  }
  const failure =
    stage1EvidenceSchemaUpgradeReviewedRecoveryFailureTerminalForDisposition(
      stable.validated.expected_disposition,
    );
  return finishFailedAudit({
        context,
        before: stable,
        afterBusiness: post.state,
        originalAccounting,
        recoveryAccounting: recoveryAccountingValue,
        archiveEvidence,
        errorCode: failure.error_code,
        errorMessage: failure.error_message,
      });
}

async function finishSucceededAudit({
  context,
  before,
  afterBusiness,
  selectedResult,
  commitReceipt,
  originalAccounting,
  recoveryAccounting: recoveryAccountingValue,
  archiveEvidence,
}) {
  return finishAuditAndReport({
    context,
    before,
    afterBusiness,
    desiredStatus: "succeeded",
    terminal: {
      status: "succeeded",
      selected_result: selectedResult,
      commit_receipt: commitReceipt,
    },
    selectedResult,
    commitReceipt,
    originalAccounting,
    recoveryAccounting: recoveryAccountingValue,
    archiveEvidence,
  });
}

async function finishFailedAudit({
  context,
  before,
  afterBusiness,
  originalAccounting,
  recoveryAccounting: recoveryAccountingValue,
  archiveEvidence,
  errorCode,
  errorMessage,
}) {
  return finishAuditAndReport({
    context,
    before,
    afterBusiness,
    desiredStatus: "failed",
    terminal: {
      status: "failed",
      error_code: errorCode,
      error_message: errorMessage,
    },
    selectedResult: null,
    commitReceipt: null,
    originalAccounting,
    recoveryAccounting: recoveryAccountingValue,
    archiveEvidence,
  });
}

async function finishAuditAndReport({
  context,
  before,
  afterBusiness,
  desiredStatus,
  terminal,
  selectedResult,
  commitReceipt,
  originalAccounting,
  recoveryAccounting: recoveryAccountingValue,
  archiveEvidence,
}) {
  const freshBusiness = await revalidateBusinessBeforeAuditFinish({
    context,
    before,
    afterBusiness,
    desiredStatus,
    commitReceipt,
  });
  if (!freshBusiness.verified) {
    return buildReport({
      context,
      before,
      after: afterBusiness,
      status: "recovery_required",
      disposition: "business_authority_drift_before_audit_finish",
      selectedResult: null,
      commitReceipt: null,
      terminal: afterBusiness.audit.terminal,
      originalAccounting,
      recoveryAccounting: recoveryAccountingValue,
      archiveEvidence,
      auditReceipt: null,
      responseLossPossible: freshBusiness.responseLossPossible,
    });
  }
  afterBusiness = freshBusiness.state;
  const finishNow = context.clock.read();
  if (!recoveryReviewCurrent(before.validated, finishNow)) {
    return buildReport({
      context,
      before,
      after: afterBusiness,
      status: "recovery_required",
      disposition: "recovery_review_expired_before_audit_finish",
      selectedResult: null,
      commitReceipt: null,
      terminal: afterBusiness.audit.terminal,
      originalAccounting,
      recoveryAccounting: recoveryAccountingValue,
      archiveEvidence,
      auditReceipt: null,
      responseLossPossible: false,
    });
  }
  const completionAuthority =
    stage1EvidenceSchemaUpgradeReviewedApplyAuditRecoveryCompletionAuthority({
      recoveryPlan: before.validated.plan,
      expectedRecoveryPlanFileSha256: before.validated.plan_file_sha256,
      expectedRecoveryPlanSha256: before.validated.plan_sha256,
      sourceId: context.sourceId,
      transactionId: context.transactionId,
    });
  const expectedRecoveryEvidenceSha256 =
    stage1EvidenceSchemaUpgradeReviewedRecoveryEvidenceSha256(
      afterBusiness.evidence,
    );
  const auditFinishAttempt = buildRecoveryAuditFinishAttempt({
    sourceId: context.sourceId,
    terminal,
    completionAuthority,
    finishedAt: finishNow,
    executionNonce: afterBusiness.audit.execution_nonce,
    expectedAuditInspectionSha256: afterBusiness.audit.inspection_sha256,
    expectedRecoveryEvidenceSha256,
  });
  let receipt = null;
  let error = null;
  try {
    receipt = await context.io.finishOriginalAudit(deepFreeze({
      source_id: context.sourceId,
      transaction_id: context.transactionId,
      reviewed_apply_plan_file_sha256: context.historical.plan_file_sha256,
      reviewed_apply_plan_sha256: context.historical.plan_sha256,
      recovery_plan_file_sha256: before.validated.plan_file_sha256,
      recovery_plan_sha256: before.validated.plan_sha256,
      recovery_plan_expires_at: before.validated.reviewer.expires_at,
      completion_authority: completionAuthority,
      expected_recovery_evidence_sha256:
        expectedRecoveryEvidenceSha256,
      execution_nonce: afterBusiness.audit.execution_nonce,
      expected_audit_inspection_sha256: afterBusiness.audit.inspection_sha256,
      finished_at: finishNow,
      terminal: cloneJson(terminal),
      creates_api_charge: false,
    }));
  } catch (cause) {
    error = cause;
  }
  let auditReceipt = null;
  try {
    auditReceipt = normalizeAuditReceiptOrNull(receipt, {
      context,
      desiredStatus,
      expectedAudit: afterBusiness.audit,
      expectedCompletionAuthority: completionAuthority,
      terminal,
    });
  } catch (cause) {
    error ||= cause;
  }
  const postFinish = await revalidateBusinessAfterAuditFinish({
    context,
    before,
    afterBusiness,
    desiredStatus,
    commitReceipt,
  });
  const observedAfter = postFinish.state || null;
  const after = postFinish.verified ? observedAfter : null;
  const auditResponseLossPossible = Boolean(error)
    || auditReceipt?.audit_mutation_accounting?.evidence?.response_loss_possible === true
    || (auditReceipt?.audit_mutation_accounting?.unknown_write_categories?.length ?? 0) > 0;
  if (
    !after
    || !terminalMatches({
      inspection: after.audit,
      desiredStatus,
      selectedResult,
      commitReceipt,
      terminal,
      completionAuthority,
    })
  ) {
    return buildReport({
      context,
      before,
      after: observedAfter || afterBusiness,
      status: "recovery_required",
      disposition: !observedAfter && auditReceipt
        ? "audit_finished_post_state_unobserved"
        : error
          ? "audit_finish_response_loss_terminal_unverified"
          : "audit_finish_terminal_unverified",
      selectedResult: null,
      commitReceipt: null,
      terminal: observedAfter?.audit?.terminal || null,
      originalAccounting,
      recoveryAccounting: recoveryAccountingValue,
      archiveEvidence,
      auditReceipt,
      auditFinishAttempt,
      auditFinishEvidence: afterBusiness.evidence,
      auditFinishAuthority: afterBusiness.currentAuthority,
      auditAfterObservation: observedAfter
        ? "post_finish_read"
        : "pre_finish_fallback_after_read_failure",
      responseLossPossible: auditResponseLossPossible
        || postFinish.responseLossPossible,
      auditAccountingOverride: auditReceipt
        ? auditReceipt.audit_mutation_accounting
          : unknownAuditFinishAccounting(observedAfter?.audit?.status || "unverified"),
    });
  }
  return buildReport({
    context,
    before,
    after,
    status: desiredStatus,
    disposition: error
      ? `audit_${desiredStatus}_verified_after_response_loss`
      : auditReceipt?.replay === true
          || auditReceipt?.disposition === "prior_terminal_failure"
        ? `terminal_${desiredStatus}_report_replay_after_finish_race`
        : `audit_${desiredStatus}_finished`,
    selectedResult,
    commitReceipt,
    terminal: after.audit.terminal,
    originalAccounting,
    recoveryAccounting: recoveryAccountingValue,
    archiveEvidence,
    auditReceipt,
    auditFinishAttempt,
    auditFinishEvidence: afterBusiness.evidence,
    auditFinishAuthority: afterBusiness.currentAuthority,
    auditAfterObservation: "post_finish_read",
    responseLossPossible: auditResponseLossPossible,
    auditAccountingOverride: auditReceipt
      ? auditReceipt.audit_mutation_accounting
      : unknownAuditFinishAccounting(after.audit.status),
  });
}

function terminalReplayReport({
  context,
  before,
  originalAccounting,
  recoveryAccounting: recoveryAccountingValue = null,
  archiveEvidence = null,
  recoveryStartJournal = null,
  recoveryCompletedJournal = null,
}) {
  const status = before.audit.row_kind === "terminal_succeeded"
    ? "succeeded"
    : before.audit.row_kind === "terminal_failed" ? "failed" : null;
  if (!status) throw new Error("Terminal replay requires an exact terminal audit inspection.");
  const replayRecoveryAccounting = recoveryAccountingValue
    ? terminalReplayCleanupAccounting(recoveryAccountingValue, archiveEvidence)
    : recoveryAccounting({
        boundary: "terminal_report_replay_read_only",
        lowerBoundCounts: zeroStage1EvidenceSchemaUpgradeMutationCounts(),
        unknownWriteCategories: [],
        responseLossPossible: false,
      });
  return buildReport({
    context,
    before,
    after: before,
    status,
    disposition: status === "succeeded"
      ? "terminal_success_report_replay"
      : "terminal_failure_report_replay",
    selectedResult: null,
    commitReceipt: null,
    terminal: before.audit.terminal,
    originalAccounting,
    recoveryAccounting: replayRecoveryAccounting,
    archiveEvidence: archiveEvidence || (before.evidence.journals.archived
      ? verifiedArchivedEvidence(before.evidence.journals.archived)
      : notStartedArchiveEvidence()),
    auditReceipt: null,
    responseLossPossible: false,
    recoveryStartJournalOverride: recoveryStartJournal,
    recoveryCompletedJournalOverride: recoveryCompletedJournal,
  });
}

function terminalReplayCleanupAccounting(value, archiveEvidence) {
  const accounting = assertStage1EvidenceSchemaUpgradeMutationAccounting(value, {
    operation: "pointer_commit",
  });
  const archive = assertArchiveEvidence(archiveEvidence);
  const persistence = reviewedJournalPersistenceEvidence(accounting, { required: true });
  const nestedArchive = assertStage1EvidenceSchemaUpgradeJournalArchiveAccounting(
    accounting.evidence?.journal_archive,
  );
  if (
    accounting.exact !== true
    || Object.values(accounting.lower_bound_counts).some((count) => count !== 0)
    || accounting.unknown_write_categories.length !== 0
    || accounting.evidence?.response_loss_possible !== false
    || persistence.state !== "not_started"
    || persistence.local_journal_writes_lower_bound !== 0
    || persistence.response_loss_possible
    || nestedArchive.state !== "verified"
    || !sameJson(nestedArchive, archive.commit_archive_accounting)
  ) throw new Error("Terminal replay cleanup accounting is not exactly verified.");
  return sealStage1EvidenceSchemaUpgradeMutationAccounting({
    operation: "pointer_commit",
    lowerBoundCounts: zeroStage1EvidenceSchemaUpgradeMutationCounts(),
    unknownWriteCategories: [],
    evidence: {
      boundary: "terminal_report_replay_dual_archive_cleanup_verified",
      mutation_scope: "current_recovery_invocation_only",
      response_loss_possible: false,
      journal_persistence: cloneJson(persistence),
      journal_archive: cloneJson(nestedArchive),
    },
  });
}

async function recoveryRequiredAfterAction({
  context,
  before,
  originalAccounting,
  recoveryAccounting: recoveryAccountingValue,
  archiveEvidence,
  disposition,
  responseLossPossible,
}) {
  const after = await safeReadEvidence(context, before.audit);
  const reportedRecoveryAccounting = recoveryRequiredReportAccounting({
    accounting: recoveryAccountingValue,
    archiveEvidence,
    disposition,
    responseLossPossible,
  });
  return buildReport({
    context,
    before,
    after: after || before,
    status: "recovery_required",
    disposition,
    selectedResult: null,
    commitReceipt: null,
    terminal: after?.audit?.terminal || before.audit.terminal,
    originalAccounting,
    recoveryAccounting: reportedRecoveryAccounting,
    archiveEvidence,
    auditReceipt: null,
    responseLossPossible: commitResponseLossPossible(
      reportedRecoveryAccounting,
      archiveEvidence,
    ),
  });
}

function recoveryRequiredReportAccounting({
  accounting: accountingValue,
  archiveEvidence,
  disposition,
  responseLossPossible,
}) {
  const accounting = assertStage1EvidenceSchemaUpgradeMutationAccounting(accountingValue);
  const archive = assertArchiveEvidence(archiveEvidence);
  let persistence;
  try {
    persistence = reviewedJournalPersistenceEvidence(accounting, { required: true });
  } catch {
    persistence = conservativeUnknownJournalPersistenceEvidence();
  }
  const nestedArchive = archive.commit_archive_accounting === null
    ? null
    : assertStage1EvidenceSchemaUpgradeJournalArchiveAccounting(
        archive.commit_archive_accounting,
      );
  const responseLoss = responseLossPossible === true
    || accounting.evidence?.response_loss_possible === true
    || persistence.response_loss_possible === true
    || archive.response_loss_possible === true
    || accounting.unknown_write_categories.length > 0;
  return sealStage1EvidenceSchemaUpgradeMutationAccounting({
    operation: "reviewed_exact_transaction_recovery",
    lowerBoundCounts: accounting.lower_bound_counts,
    unknownWriteCategories: accounting.unknown_write_categories,
    evidence: {
      boundary: `recovery_required:${requiredText(
        disposition,
        "recovery-required action disposition",
      )}`,
      mutation_scope: "current_recovery_invocation_only",
      response_loss_possible: responseLoss,
      journal_persistence: cloneJson(persistence),
      ...(nestedArchive ? { journal_archive: cloneJson(nestedArchive) } : {}),
    },
  });
}

async function readAndValidateReviewedEvidence(context) {
  const evidence = await readEvidence(context);
  const validated = validateStage1EvidenceSchemaUpgradeReviewedRecoveryPlan({
    planBytes: context.recoveryPlanBytes,
    expectedPlanFileSha256: context.expectedRecoveryPlanFileSha256,
    applyPlanBytes: context.applyPlanBytes,
    expectedApplyPlanFileSha256: context.expectedApplyPlanFileSha256,
    reviewedDryRunReportBytes: context.reviewedDryRunReportBytes,
    manifest: context.manifest,
    auditInspection: evidence.auditInspection,
    journals: evidence.journals,
    currentAuthoritySnapshot: evidence.currentAuthoritySnapshot,
    now: context.clock.read(),
  });
  if (
    validated.selected_source_id !== context.sourceId
    || validated.transaction_id !== context.transactionId
  ) {
    throw new Error("Reviewed recovery plan source or transaction identity changed.");
  }
  return deepFreeze({
    validated,
    audit: assertStage1EvidenceSchemaUpgradeReviewedApplyAuditRecoveryInspection(
      evidence.auditInspection,
    ),
    evidence,
  });
}

async function readEvidence(context) {
  const value = await context.io.readRecoveryEvidence(deepFreeze({
    source_id: context.sourceId,
    transaction_id: context.transactionId,
    reviewed_apply_plan_file_sha256: context.historical.plan_file_sha256,
    reviewed_apply_plan_sha256: context.historical.plan_sha256,
    creates_api_charge: false,
  }));
  const evidence = requiredObject(value, "reviewed recovery evidence read");
  assertExactKeys(
    evidence,
    ["auditInspection", "currentAuthoritySnapshot", "journals"],
    "reviewed recovery evidence read",
  );
  const journals = requiredObject(evidence.journals, "reviewed recovery journal locations");
  assertExactKeys(journals, ["active", "archived"], "reviewed recovery journal locations");
  return evidence;
}

async function safeReadEvidence(context, expectedAudit = null) {
  try {
    const evidence = await readEvidence(context);
    const audit = assertStage1EvidenceSchemaUpgradeReviewedApplyAuditRecoveryInspection(
      evidence.auditInspection,
    );
    if (!auditBoundToContext(audit, context, expectedAudit)) return null;
    return deepFreeze({
      audit,
      evidence,
    });
  } catch {
    return null;
  }
}

async function safeReadPostArchive(context, {
  expectedOperationBinding,
  expectedJournalSha256,
  expectedAuthority,
  expectedAudit,
}) {
  try {
    const state = await safeReadEvidence(context, expectedAudit);
    if (!state) return { verified: false, responseLossPossible: true };
    const journals = state.evidence.journals;
    if (journals.active !== null || !journals.archived) {
      return { verified: false, state, responseLossPossible: false };
    }
    const archived = assertStage1EvidenceSchemaUpgradeJournal(journals.archived);
    if (
      archived.schema_version !== STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_JOURNAL_SCHEMA
      || archived.journal_sha256 !== expectedJournalSha256
      || !sameJson(archived.operation_binding, expectedOperationBinding)
    ) return { verified: false, state, responseLossPossible: false };
    const proof = proveStage1EvidenceSchemaUpgradeArchivedCompletion({
      journal: archived,
      expectedJournalSha256,
      expectedTransactionId: context.transactionId,
      expectedOperationBinding,
      currentBaselineBytes: state.evidence.currentAuthoritySnapshot.currentBaselineBytes,
      currentPointer: state.evidence.currentAuthoritySnapshot.currentPointer,
    });
    if (proof.authority !== expectedAuthority) {
      return { verified: false, state, responseLossPossible: false };
    }
    const currentAuthority = projectStage1EvidenceSchemaUpgradeReviewedRecoveryAuthority({
      ...state.evidence.currentAuthoritySnapshot,
      sourceId: context.sourceId,
      auditedSourceAuthority: state.audit.authority_receipt.source_authority,
      candidateBaselineBytes:
        stage1EvidenceSchemaUpgradeBaselineBytes(archived.candidate_baseline),
    });
    if (
      (expectedAuthority === "candidate"
        && currentAuthority.source_health_classification !== "exact_already_current")
      || (expectedAuthority === "old"
        && currentAuthority.source_health_classification !== "exact_precommit")
      || !businessAuthorityMatches(context.historical.plan.selected, {
        currentAuthority,
        snapshot: state.evidence.currentAuthoritySnapshot,
      })
    ) return { verified: false, state, responseLossPossible: false };
    try {
      if (expectedAuthority === "old") {
        assertStage1EvidenceSchemaUpgradeReviewedRecoveryOldR2Authority({
          currentAuthority,
          selected: context.historical.plan.selected,
          auditInspection: state.audit,
        });
      } else {
        assertStage1EvidenceSchemaUpgradeReviewedRecoveryCandidateR2Pointer(
          state.evidence.currentAuthoritySnapshot.currentPointer,
        );
      }
    } catch {
      return { verified: false, state, responseLossPossible: false };
    }
    return { verified: true, state: { ...state, currentAuthority, proof } };
  } catch {
    return { verified: false, responseLossPossible: true };
  }
}

function businessAuthorityMatches(selected, { currentAuthority, snapshot }) {
  return currentAuthority.source_id === selected.source.source_id
    && sameJson(snapshot.acquisitionProjection, selected.acquisition)
    && sameJson(snapshot.activationProjection, selected.activation)
    && sameJson(snapshot.finalizationProjection, selected.finalization);
}

async function revalidateBusinessBeforeAuditFinish({
  context,
  before,
  afterBusiness,
  desiredStatus,
  commitReceipt,
}) {
  return revalidateBusinessState({
    context,
    before,
    reference: afterBusiness,
    desiredStatus,
    commitReceipt,
  });
}

async function revalidateBusinessAfterAuditFinish({
  context,
  before,
  afterBusiness,
  desiredStatus,
  commitReceipt,
}) {
  return revalidateBusinessState({
    context,
    before,
    reference: afterBusiness,
    desiredStatus,
    commitReceipt,
  });
}

async function revalidateBusinessState({
  context,
  before,
  reference,
  desiredStatus,
  commitReceipt,
}) {
  const archived = reference.evidence.journals.archived;
  if (archived) {
    return safeReadPostArchive(context, {
      expectedOperationBinding: archived.operation_binding,
      expectedJournalSha256: commitReceipt?.journal_sha256 || archived.journal_sha256,
      expectedAuthority: desiredStatus === "succeeded" ? "candidate" : "old",
      expectedAudit: reference.audit,
    });
  }
  if (desiredStatus !== "failed") {
    return { verified: false, responseLossPossible: false };
  }
  return safeReadPostNoJournal(context, {
    expectedAudit: reference.audit,
    validated: before.validated,
  });
}

async function safeReadPostNoJournal(context, { expectedAudit, validated }) {
  try {
    const state = await safeReadEvidence(context, expectedAudit);
    if (!state) return { verified: false, responseLossPossible: true };
    if (
      state.evidence.journals.active !== null
      || state.evidence.journals.archived !== null
    ) return { verified: false, state, responseLossPossible: false };
    const snapshot = state.evidence.currentAuthoritySnapshot;
    const authority = projectStage1EvidenceSchemaUpgradeReviewedRecoveryAuthority({
      ...snapshot,
      sourceId: context.sourceId,
      auditedSourceAuthority: state.audit.authority_receipt.source_authority,
      candidateBaselineBytes: null,
    });
    const selected = context.historical.plan.selected;
    if (
      authority.source_health_classification !== "exact_precommit"
      || !businessAuthorityMatches(selected, { currentAuthority: authority, snapshot })
      || !sameJson(authority.local_baseline_identity, {
        present: true,
        ...selected.local_baseline_identity,
      })
      || !sameJson(authority.pointer_identity, selected.existing_pointer_identity)
      || authority.r2_binding_receipt_sha256 !== selected.r2.binding_receipt_sha256
    ) return { verified: false, state, responseLossPossible: false };
    return {
      verified: true,
      state: { ...state, validated, currentAuthority: authority },
      responseLossPossible: false,
    };
  } catch {
    return { verified: false, responseLossPossible: true };
  }
}

function auditBoundToContext(audit, context, expectedAudit) {
  if (
    audit.plan_file_sha256 !== context.historical.plan_file_sha256
    || audit.plan_sha256 !== context.historical.plan_sha256
    || audit.selected_source_id !== context.sourceId
    || audit.binding.plan.file_sha256 !== context.historical.plan_file_sha256
    || audit.binding.plan.self_sha256 !== context.historical.plan_sha256
    || audit.binding.scope.selected_source_id !== context.sourceId
    || !sameJson(audit.binding.selected, context.historical.plan.selected)
  ) return false;
  if (!expectedAudit) return true;
  return audit.run_id === expectedAudit.run_id
    && audit.execution_nonce === expectedAudit.execution_nonce
    && sameJson(audit.binding, expectedAudit.binding)
    && sameJson(audit.fresh_capture, expectedAudit.fresh_capture)
    && audit.authority_receipt_sha256 === expectedAudit.authority_receipt_sha256
    && sameJson(audit.authority_receipt, expectedAudit.authority_receipt);
}

function archivedReplayCommitResult({ sourceId, transactionId, journal }) {
  const accounting = sealStage1EvidenceSchemaUpgradeMutationAccounting({
    operation: "pointer_commit",
    lowerBoundCounts: zeroStage1EvidenceSchemaUpgradeMutationCounts(),
    unknownWriteCategories: [],
    evidence: {
      boundary: "archived_completed_recovery_replay",
      mutation_scope: "current_recovery_invocation_only",
      original_operation_totals_not_represented: true,
      archived_journal_sha256: journal.journal_sha256,
    },
  });
  const counts = zeroStage1EvidenceSchemaUpgradeMutationCounts();
  const reviewedReconciliationEvidence =
    expectedReviewedReconciliationEvidence(journal);
  const cleanupDebt = expectedRecoveryCleanupDebt(
    reviewedReconciliationEvidence,
    "upgraded",
  );
  const receipt = {
    schema_version: STAGE1_EVIDENCE_SCHEMA_UPGRADE_COMMIT_RECEIPT_SCHEMA,
    source_id: sourceId,
    context: STAGE1_EVIDENCE_SCHEMA_UPGRADE_CONTEXT,
    operation: "pointer_commit",
    status: "upgraded",
    creates_api_charge: false,
    transaction_id: transactionId,
    outcome: "committed_candidate",
    journal_phase: "completed",
    journal_sha256: journal.journal_sha256,
    journal_archived: true,
    authoritative_pointer_state: "candidate",
    authoritative_baseline_state: "candidate",
    authoritative_pointer_sha256:
      journal.candidate_pointer_identity.canonical_sha256,
    authoritative_baseline_sha256: journal.candidate_baseline.sha256,
    cas: {
      attempted: false,
      returned: null,
      threw: false,
      recovered: true,
      error_code: null,
      error_message: null,
      confirmed_database_pointer_writes: 0,
      write_attribution: "prior_invocation_not_counted",
    },
    cleanup_debt: cloneJson(cleanupDebt),
    cleanup_delete_performed: false,
    source_health: { status: "already_current", mutation_counts: counts },
    mutation_count_scope: "confirmed_io_receipts_in_this_invocation",
    mutation_counts: counts,
    mutation_accounting: accounting,
  };
  const result = deepFreeze({
    status: "upgraded",
    source_id: sourceId,
    context: STAGE1_EVIDENCE_SCHEMA_UPGRADE_CONTEXT,
    creates_api_charge: false,
    mutation_counts: counts,
    mutation_accounting: accounting,
    mutation_count_certainty: {
      exact: true,
      count_semantics: "exact",
      unknown_write_categories: [],
    },
    reviewed_reconciliation_evidence: reviewedReconciliationEvidence,
    receipt,
  });
  return normalizeCommitResult(result, {
    sourceId,
    transactionId,
    expectedJournal: journal,
    archivedReplay: true,
  });
}

function selectedRecoveryResult({ audit, commitResult, evaluatedAt }) {
  const selected = cloneJson(audit.fresh_capture.capture_result);
  selected.evaluated_at = requiredTimestamp(evaluatedAt, "recovered selected result time");
  selected.mode = "apply";
  selected.status = "upgraded";
  selected.pointer_journal = {
    status: "upgraded",
    receipt: cloneJson(commitResult.receipt),
  };
  selected.visual_review_candidate = { status: "not_planned", receipt: null };
  selected.quarantine = { status: "not_requested" };
  selected.mutation_counts = cloneJson(commitResult.mutation_counts);
  selected.mutation_count_certainty = cloneJson(commitResult.mutation_count_certainty);
  for (const key of Object.keys(zeroStage1EvidenceSchemaUpgradeMutationCounts())) {
    if (isPlainObject(selected.safety)) delete selected.safety[key];
  }
  return deepFreeze(selected);
}

export function assertStage1EvidenceSchemaUpgradeReviewedRecoverySucceededTerminal({
  sourceId,
  transactionId,
  journal,
  auditInspection,
  selectedResult,
  commitReceipt,
  receiptProfile,
  accountingProfile,
} = {}) {
  const archived = assertStage1EvidenceSchemaUpgradeJournal(journal);
  const audit = assertStage1EvidenceSchemaUpgradeReviewedApplyAuditRecoveryInspection(
    auditInspection,
  );
  const receipt = requiredObject(
    commitReceipt,
    "reviewed recovery successful terminal commit receipt",
  );
  if (!new Set(["candidate_authority_recovered", "committed_candidate"]).has(
    receiptProfile,
  )) throw new Error("Reviewed recovery terminal receipt profile is invalid.");
  const accounting = assertStage1EvidenceSchemaUpgradeMutationAccounting(
    receipt.mutation_accounting,
    { operation: "pointer_commit" },
  );
  assertSuccessfulTerminalAccountingProfile({
    accounting,
    accountingProfile,
    journal: archived,
  });
  const commit = normalizeCommitResult({
    status: "upgraded",
    source_id: sourceId,
    context: STAGE1_EVIDENCE_SCHEMA_UPGRADE_CONTEXT,
    creates_api_charge: false,
    mutation_counts: cloneJson(receipt.mutation_counts),
    mutation_accounting: cloneJson(accounting),
    mutation_count_certainty: {
      exact: accounting.exact,
      count_semantics: accounting.exact
        ? "exact"
        : "confirmed_lower_bounds_with_unknown_writes",
      unknown_write_categories: cloneJson(accounting.unknown_write_categories),
    },
    reviewed_reconciliation_evidence:
      expectedReviewedReconciliationEvidence(archived, receipt.journal_sha256),
    receipt: cloneJson(receipt),
  }, {
    sourceId,
    transactionId,
    expectedJournal: archived,
    archivedReplay: accountingProfile === "archived_read_only_replay",
  });
  if (receipt.outcome !== receiptProfile) {
    throw new Error("Reviewed recovery terminal receipt outcome differs from its sealed profile.");
  }
  const selected = requiredObject(
    selectedResult,
    "reviewed recovery successful terminal selected result",
  );
  const expectedSelected = selectedRecoveryResult({
    audit,
    commitResult: commit,
    evaluatedAt: selected.evaluated_at,
  });
  if (!sameJson(selected, expectedSelected)) {
    throw new Error("Reviewed recovery successful terminal selected result is not exact.");
  }
  return deepFreeze({
    selected_result: cloneJson(expectedSelected),
    commit_receipt: cloneJson(commit.receipt),
  });
}

export function buildStage1EvidenceSchemaUpgradeReviewedRecoveryArchivedSucceededTerminal({
  sourceId,
  transactionId,
  journal,
  auditInspection,
  evaluatedAt,
} = {}) {
  const archived = assertStage1EvidenceSchemaUpgradeJournal(journal);
  const audit = assertStage1EvidenceSchemaUpgradeReviewedApplyAuditRecoveryInspection(
    auditInspection,
  );
  const commit = archivedReplayCommitResult({ sourceId, transactionId, journal: archived });
  const terminal = {
    status: "succeeded",
    selected_result: selectedRecoveryResult({
      audit,
      commitResult: commit,
      evaluatedAt,
    }),
    commit_receipt: cloneJson(commit.receipt),
  };
  assertStage1EvidenceSchemaUpgradeReviewedRecoverySucceededTerminal({
    sourceId,
    transactionId,
    journal: archived,
    auditInspection: audit,
    selectedResult: terminal.selected_result,
    commitReceipt: terminal.commit_receipt,
    receiptProfile: "committed_candidate",
    accountingProfile: "archived_read_only_replay",
  });
  return deepFreeze(terminal);
}

function assertSuccessfulTerminalAccountingProfile({ accounting, accountingProfile, journal }) {
  if (accountingProfile === "archived_read_only_replay") {
    assertExactKeys(accounting.evidence, [
      "archived_journal_sha256",
      "boundary",
      "mutation_scope",
      "original_operation_totals_not_represented",
    ], "archived reviewed recovery replay accounting evidence");
    if (
      accounting.exact !== true
      || Object.values(accounting.lower_bound_counts).some((count) => count !== 0)
      || accounting.unknown_write_categories.length !== 0
      || accounting.evidence.boundary !== "archived_completed_recovery_replay"
      || accounting.evidence.mutation_scope !== "current_recovery_invocation_only"
      || accounting.evidence.original_operation_totals_not_represented !== true
      || accounting.evidence.archived_journal_sha256 !== journal.journal_sha256
    ) throw new Error("Archived reviewed recovery replay accounting is not exact zero-write proof.");
    return;
  }
  if (accountingProfile === "current_invocation_verified_archive") {
    const archive = assertStage1EvidenceSchemaUpgradeJournalArchiveAccounting(
      accounting.evidence?.journal_archive,
    );
    if (
      archive.state !== "verified"
      || archive.local_journal_archive_writes_lower_bound !== 1
      || archive.archive_receipt_acknowledged !== true
      || archive.archived_readback_verified !== true
      || archive.active_absence_verified !== true
      || archive.response_loss_possible !== false
    ) throw new Error("Current reviewed recovery invocation lacks exact verified archive proof.");
    return;
  }
  throw new Error("Reviewed recovery terminal accounting profile is invalid.");
}

function normalizeCommitResult(value, {
  sourceId,
  transactionId,
  expectedJournal,
  archivedReplay = false,
}) {
  const result = requiredObject(value, "reviewed active recovery commit result");
  assertExactKeys(result, COMMIT_RESULT_KEYS, "reviewed active recovery commit result");
  const reviewedReconciliationEvidence =
    assertStage1EvidenceSchemaUpgradeReviewedReconciliationEvidence(
      result.reviewed_reconciliation_evidence,
    );
  const receipt = requiredObject(result.receipt, "reviewed active recovery commit receipt");
  assertExactKeys(receipt, COMMIT_RECEIPT_KEYS, "reviewed active recovery commit receipt");
  const expectedReconciliationEvidence = expectedReviewedReconciliationEvidence(
    expectedJournal,
    receipt.journal_sha256,
  );
  const accounting = assertStage1EvidenceSchemaUpgradeMutationAccounting(
    result.mutation_accounting,
    { operation: "pointer_commit" },
  );
  // Every result returned by the live reviewed-v2 commit callback must carry
  // exact journal-persistence evidence. Only the module-owned archived
  // read-only replay synthesizes accounting without an active-journal write.
  const journalPersistence = archivedReplay
    ? null
    : reviewedJournalPersistenceEvidence(accounting, { required: true });
  const receiptAccounting = assertStage1EvidenceSchemaUpgradeMutationAccounting(
    receipt.mutation_accounting,
    { operation: "pointer_commit" },
  );
  const certainty = requiredObject(
    result.mutation_count_certainty,
    "reviewed active recovery mutation certainty",
  );
  assertExactKeys(certainty, [
    "count_semantics",
    "exact",
    "unknown_write_categories",
  ], "reviewed active recovery mutation certainty");
  if (
    !new Set(["upgraded", "abandoned_old_authority", "recovery_required"])
      .has(result.status)
    || result.source_id !== sourceId
    || result.context !== STAGE1_EVIDENCE_SCHEMA_UPGRADE_CONTEXT
    || result.creates_api_charge !== false
    || reviewedReconciliationEvidence.journal_sha256 !== receipt.journal_sha256
    || !sameJson(reviewedReconciliationEvidence, expectedReconciliationEvidence)
    || receipt.schema_version !== STAGE1_EVIDENCE_SCHEMA_UPGRADE_COMMIT_RECEIPT_SCHEMA
    || receipt.source_id !== sourceId
    || receipt.transaction_id !== transactionId
    || receipt.status !== result.status
    || receipt.operation !== "pointer_commit"
    || receipt.context !== STAGE1_EVIDENCE_SCHEMA_UPGRADE_CONTEXT
    || receipt.creates_api_charge !== false
    || receipt.cleanup_delete_performed !== false
    || receipt.mutation_count_scope !== "confirmed_io_receipts_in_this_invocation"
    || receiptAccounting.accounting_sha256 !== accounting.accounting_sha256
    || !sameJson(result.mutation_counts, accounting.lower_bound_counts)
    || !sameJson(receipt.mutation_counts, result.mutation_counts)
    || certainty.exact !== accounting.exact
    || !sameJson(
      certainty.unknown_write_categories,
      accounting.unknown_write_categories,
    )
    || certainty.count_semantics !== (
      accounting.exact
        ? "exact"
        : "confirmed_lower_bounds_with_unknown_writes"
    )
    || accounting.lower_bound_counts.candidate_writes !== 0
    || accounting.lower_bound_counts.quarantine_writes !== 0
    || accounting.lower_bound_counts.r2_writes !== 0
    || accounting.lower_bound_counts.local_baseline_writes > 1
    || accounting.lower_bound_counts.database_writes
      !== accounting.lower_bound_counts.source_state_writes
    || !SHA256_PATTERN.test(receipt.journal_sha256 || "")
  ) throw new Error("Reviewed active recovery commit result is invalid.");
  if (
    new Set(["upgraded", "abandoned_old_authority"]).has(result.status)
    && !archivedReplay
    && journalPersistence.state !== (
      expectedJournal.phase === "completed" ? "not_started" : "verified"
    )
  ) {
    throw new Error("Reviewed terminal recovery journal persistence differs from its starting phase.");
  }
  assertRecoverySafeCas(receipt.cas);
  assertRecoverySafeCleanupDebt(receipt.cleanup_debt);
  if (
    new Set(["upgraded", "abandoned_old_authority"]).has(result.status)
    && !sameJson(
      receipt.cleanup_debt,
      expectedRecoveryCleanupDebt(reviewedReconciliationEvidence, result.status),
    )
  ) throw new Error("Reviewed recovery cleanup debt differs from the exact journal authority.");
  if (result.status === "upgraded" && (
    receipt.outcome !== (
      archivedReplay || expectedJournal.phase !== "completed"
        ? "committed_candidate"
        : "candidate_authority_recovered"
    )
    || receipt.journal_phase !== "completed"
    || receipt.journal_archived !== true
    || receipt.authoritative_pointer_state !== "candidate"
    || receipt.authoritative_baseline_state !== "candidate"
    || receipt.authoritative_pointer_sha256
      !== expectedJournal.candidate_pointer_identity.canonical_sha256
    || receipt.authoritative_baseline_sha256
      !== expectedJournal.candidate_baseline.sha256
    || accounting.exact !== true
  )) throw new Error("Reviewed active candidate recovery receipt is invalid.");
  if (result.status === "upgraded") {
    assertRecoverySafeSourceHealth(receipt.source_health, {
      completedReplay: !archivedReplay && expectedJournal.phase === "completed",
      totalCounts: accounting.lower_bound_counts,
    });
  }
  if (result.status === "abandoned_old_authority" && (
    receipt.outcome !== "abandoned_old_authority"
    || receipt.journal_phase !== "completed"
    || receipt.journal_archived !== true
    || receipt.authoritative_pointer_state !== "old"
    || !new Set(["old", "both"]).has(receipt.authoritative_baseline_state)
    || receipt.authoritative_pointer_sha256
      !== expectedJournal.old_pointer_identity.canonical_sha256
    || receipt.authoritative_baseline_sha256 !== expectedJournal.old_baseline.sha256
    || receipt.source_health !== null
    || accounting.lower_bound_counts.database_writes !== 0
    || accounting.lower_bound_counts.source_state_writes !== 0
    || accounting.exact !== true
  )) throw new Error("Reviewed active old-authority recovery receipt is invalid.");
  return deepFreeze({ ...cloneJson(result), mutation_accounting: accounting });
}

function assertRecoverySafeCas(value) {
  const cas = requiredObject(value, "reviewed recovery CAS receipt");
  assertExactKeys(cas, [
    "attempted",
    "confirmed_database_pointer_writes",
    "error_code",
    "error_message",
    "recovered",
    "returned",
    "threw",
    "write_attribution",
  ], "reviewed recovery CAS receipt");
  if (
    typeof cas.attempted !== "boolean"
    || cas.returned !== null
    || cas.threw !== false
    || cas.recovered !== true
    || cas.error_code !== null
    || cas.error_message !== null
    || cas.confirmed_database_pointer_writes !== 0
    || cas.write_attribution !== "prior_invocation_not_counted"
  ) throw new Error("Reviewed recovery receipt claims an unauthorized current CAS write.");
}

function assertRecoverySafeCleanupDebt(value) {
  const debt = requiredObject(value, "reviewed recovery cleanup debt");
  assertExactKeys(debt, [
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
  ], "reviewed recovery cleanup debt");
  if (
    debt.schema_version !== VISUAL_SNAPSHOT_LATEST_ONLY_CLEANUP_DEBT_SCHEMA
    || debt.delete_performed !== false
    || !Array.isArray(debt.candidate_keys)
    || !Array.isArray(debt.protected_keys)
    || !Array.isArray(debt.eligible_keys)
    || !Array.isArray(debt.deferred_keys)
    || debt.item_count !== debt.candidate_keys.length
    || debt.eligible_count !== debt.eligible_keys.length
  ) throw new Error("Reviewed recovery cleanup debt is malformed or claims deletion.");
}

function expectedReviewedReconciliationEvidence(
  journal,
  journalSha256 = journal.journal_sha256,
) {
  return buildStage1EvidenceSchemaUpgradeReviewedReconciliationEvidence({
    sourceId: journal.source_id,
    transactionId: journal.transaction_id,
    journalSha256,
    oldPointerIdentity: journal.old_pointer_identity,
    candidatePointerIdentity: journal.candidate_pointer_identity,
    candidateObjectKeys: journal.candidate_object_keys,
  });
}

function expectedRecoveryCleanupDebt(reconciliationEvidence, status) {
  const candidate = status === "upgraded";
  return planLatestOnlyVisualSnapshotPointerReconciliation({
    existing: reconciliationEvidence.old_pointer_identity.projection,
    candidate: reconciliationEvidence.candidate_pointer_identity.projection,
    current: candidate
      ? reconciliationEvidence.candidate_pointer_identity.projection
      : reconciliationEvidence.old_pointer_identity.projection,
    outcome: candidate ? "ambiguous_error" : "cas_lost",
    uploadedKeys: reconciliationEvidence.candidate_object_keys,
  }).cleanup_debt;
}

function assertRecoverySafeSourceHealth(value, { completedReplay, totalCounts }) {
  const sourceHealth = requiredObject(value, "reviewed recovery source-health receipt");
  if (completedReplay) {
    assertExactKeys(sourceHealth, ["status"], "completed recovery source-health receipt");
    if (sourceHealth.status !== "already_recorded_by_completed_journal") {
      throw new Error("Completed recovery source-health receipt is invalid.");
    }
    if (totalCounts.database_writes !== 0 || totalCounts.source_state_writes !== 0) {
      throw new Error("Completed recovery receipt invents a source-health write.");
    }
    return;
  }
  assertExactKeys(
    sourceHealth,
    ["mutation_counts", "status"],
    "reviewed recovery source-health receipt",
  );
  if (!new Set(["succeeded", "already_current"]).has(sourceHealth.status)) {
    throw new Error("Reviewed recovery source-health status is invalid.");
  }
  const counts = sourceHealth.mutation_counts;
  const zero = zeroStage1EvidenceSchemaUpgradeMutationCounts();
  if (
    !isPlainObject(counts)
    || !sameJson(Object.keys(counts).sort(), Object.keys(zero).sort())
    || Object.values(counts).some((count) => !Number.isSafeInteger(count) || count < 0)
    || counts.r2_writes !== 0
    || counts.local_baseline_writes !== 0
    || counts.candidate_writes !== 0
    || counts.quarantine_writes !== 0
    || counts.database_writes !== counts.source_state_writes
    || counts.database_writes !== totalCounts.database_writes
    || counts.source_state_writes !== totalCounts.source_state_writes
  ) throw new Error("Reviewed recovery source-health mutations exceed authority.");
  if (
    (sourceHealth.status === "already_current" && counts.database_writes !== 0)
    || (sourceHealth.status === "succeeded" && counts.database_writes !== 1)
  ) throw new Error("Reviewed recovery source-health status and counts disagree.");
}

function terminalMatches({
  inspection,
  desiredStatus,
  selectedResult,
  commitReceipt,
  terminal,
  completionAuthority,
}) {
  const audit = assertStage1EvidenceSchemaUpgradeReviewedApplyAuditRecoveryInspection(
    inspection,
  );
  if (desiredStatus === "failed") {
    return audit.row_kind === "terminal_failed"
      && audit.terminal.failure.error_code === terminal.error_code
      && audit.terminal.failure.error_message_sha256 === sha256(terminal.error_message)
      && sameJson(audit.terminal.completion_authority, completionAuthority);
  }
  const identity = audit.terminal?.selected_result_commit_identity;
  return audit.row_kind === "terminal_succeeded"
    && identity?.selected_result_sha256 === sha256(canonicalJson(selectedResult))
    && identity?.commit_receipt_sha256 === sha256(canonicalJson(commitReceipt))
    && identity?.commit_journal_sha256 === commitReceipt.journal_sha256
    && identity?.commit_mutation_accounting_sha256
      === commitReceipt.mutation_accounting.accounting_sha256
    && sameJson(audit.terminal.completion_authority, completionAuthority);
}

function normalizeAuditReceiptOrNull(value, {
  context,
  desiredStatus,
  expectedAudit,
  expectedCompletionAuthority,
  terminal,
}) {
  if (value === null || value === undefined) {
    throw new Error("Reviewed recovery audit finish callback returned no sealed receipt.");
  }
  const expectedFailure = desiredStatus === "failed"
    ? {
        error_code: terminal.error_code.slice(0, 200),
        error_summary: terminal.error_message.slice(0, 1000),
        error_message_sha256: sha256(terminal.error_message),
      }
    : null;
  const expectedFailureSha256 = expectedFailure
    ? sha256(canonicalJson(expectedFailure))
    : null;
  return normalizeRecoveryAuditReceipt(value, {
    sourceId: context.sourceId,
    planFileSha256: context.historical.plan_file_sha256,
    planSha256: context.historical.plan_sha256,
    executionNonce: expectedAudit.execution_nonce,
    expectedAudit,
    expectedCompletionAuthority,
    expectedStatus: desiredStatus,
    expectedFailureSha256,
  }).receipt;
}

function interruptedOriginalAccounting(journals) {
  const journal = journals.active || journals.archived;
  const counts = zeroStage1EvidenceSchemaUpgradeMutationCounts();
  const unknown = [];
  let phase = "absent_before_journal";
  if (journal) {
    phase = journal.phase;
    unknown.push("r2_writes", "local_baseline_writes");
    if (new Set([
      "pointer_cas_attempted",
      "pointer_candidate_committed",
      "recovery_required",
      "completed",
    ]).has(phase)) {
      unknown.push("database_writes", "source_state_writes");
    }
  }
  return sealStage1EvidenceSchemaUpgradeMutationAccounting({
    operation: "pointer_commit",
    lowerBoundCounts: counts,
    unknownWriteCategories: unknown,
    evidence: {
      boundary: "interrupted_original_invocation",
      journal_phase: phase,
      journal_sha256: journal?.journal_sha256 || null,
      mutation_scope: "interrupted_original_invocation_only",
      local_journal_writes_reported_separately: true,
    },
  });
}

function recoveryAccounting({
  boundary,
  lowerBoundCounts,
  unknownWriteCategories,
  responseLossPossible,
  journalPersistence = null,
}) {
  return sealStage1EvidenceSchemaUpgradeMutationAccounting({
    operation: "reviewed_exact_transaction_recovery",
    lowerBoundCounts,
    unknownWriteCategories,
    evidence: {
      boundary,
      mutation_scope: "current_recovery_invocation_only",
      response_loss_possible: responseLossPossible,
      ...(journalPersistence
        ? { journal_persistence: cloneJson(journalPersistence) }
        : {}),
    },
  });
}

function recoveryAccountingFromCommit({ result, error, boundary }) {
  const value = result?.mutation_accounting || error?.stage1_mutation_accounting;
  if (value) {
    let accounting = null;
    try {
      accounting = assertStage1EvidenceSchemaUpgradeMutationAccounting(value, {
        operation: "pointer_commit",
      });
    } catch {
      // A malformed outer seal is conservatively unknown below.
    }
    if (accounting) {
      try {
        reviewedJournalPersistenceEvidence(accounting, { required: true });
        return accounting;
      } catch {
        return recoveryAccounting({
          boundary: `${boundary}_journal_persistence_unverified`,
          lowerBoundCounts: accounting.lower_bound_counts,
          unknownWriteCategories: [
            ...accounting.unknown_write_categories,
            "database_writes",
            "local_baseline_writes",
            "source_state_writes",
          ],
          responseLossPossible: true,
          journalPersistence: conservativeUnknownJournalPersistenceEvidence(),
        });
      }
    }
  }
  return recoveryAccounting({
    boundary,
    lowerBoundCounts: zeroStage1EvidenceSchemaUpgradeMutationCounts(),
    unknownWriteCategories: [
      "database_writes",
      "local_baseline_writes",
      "source_state_writes",
    ],
    responseLossPossible: true,
    journalPersistence: conservativeUnknownJournalPersistenceEvidence(),
  });
}

function unverifiedCommitResponseAccounting(accountingValue, boundary) {
  const accounting = assertStage1EvidenceSchemaUpgradeMutationAccounting(accountingValue);
  let journalPersistence;
  try {
    journalPersistence = reviewedJournalPersistenceEvidence(accounting, {
      required: true,
    });
  } catch {
    journalPersistence = conservativeUnknownJournalPersistenceEvidence();
  }
  return recoveryAccounting({
    boundary,
    lowerBoundCounts: accounting.lower_bound_counts,
    unknownWriteCategories: [
      ...accounting.unknown_write_categories,
      "database_writes",
      "local_baseline_writes",
      "source_state_writes",
    ],
    responseLossPossible: true,
    journalPersistence,
  });
}

function commitResponseLossPossible(accounting, archiveEvidence) {
  return archiveEvidence.response_loss_possible === true
    || accounting.evidence?.response_loss_possible === true
    || reviewedJournalPersistenceEvidence(accounting)?.response_loss_possible === true
    || accounting.unknown_write_categories.length > 0;
}

function reviewedJournalPersistenceEvidence(accounting, { required = false } = {}) {
  const value = accounting?.evidence?.journal_persistence;
  if (value === null || value === undefined) {
    if (required) throw new Error("Reviewed recovery journal persistence evidence is missing.");
    return null;
  }
  const evidence = requiredObject(value, "reviewed recovery journal persistence evidence");
  assertExactKeys(evidence, [
    "local_journal_writes_lower_bound",
    "response_loss_possible",
    "state",
  ], "reviewed recovery journal persistence evidence");
  const state = requiredText(evidence.state, "reviewed recovery journal persistence state");
  if (!new Set([
    "not_started",
    "verified",
    "write_acknowledged_readback_pending",
    "write_acknowledged_readback_unverified",
    "write_in_flight",
    "write_response_unknown",
  ]).has(state)) throw new Error("Reviewed recovery journal persistence state is invalid.");
  const lowerBound = requiredNonnegativeInteger(
    evidence.local_journal_writes_lower_bound,
    "reviewed recovery local journal writes lower bound",
  );
  if (typeof evidence.response_loss_possible !== "boolean") {
    throw new Error("Reviewed recovery journal persistence response-loss flag is invalid.");
  }
  if (
    (state === "not_started"
      && (lowerBound !== 0 || evidence.response_loss_possible !== false))
    || (state === "write_in_flight"
      && evidence.response_loss_possible !== true)
    || (state === "write_response_unknown"
      && evidence.response_loss_possible !== true)
    || (new Set([
      "verified",
      "write_acknowledged_readback_pending",
      "write_acknowledged_readback_unverified",
    ]).has(state) && (lowerBound < 1 || evidence.response_loss_possible !== false))
  ) throw new Error("Reviewed recovery journal persistence evidence is contradictory.");
  return evidence;
}

function conservativeUnknownJournalPersistenceEvidence() {
  return {
    state: "write_response_unknown",
    local_journal_writes_lower_bound: 0,
    response_loss_possible: true,
  };
}

function journalPersistenceMutationPossible(accounting) {
  const evidence = reviewedJournalPersistenceEvidence(accounting);
  return evidence !== null && (
    evidence.state !== "not_started"
    || evidence.local_journal_writes_lower_bound > 0
    || evidence.response_loss_possible
  );
}

function archiveEvidenceFromCommit({ result, error }) {
  const value = result?.receipt?.mutation_accounting?.evidence?.journal_archive
    || result?.mutation_accounting?.evidence?.journal_archive
    || error?.stage1_mutation_accounting?.evidence?.journal_archive;
  if (!value) return ambiguousArchiveEvidence("commit_archive_evidence_missing");
  try {
    const accounting = assertStage1EvidenceSchemaUpgradeJournalArchiveAccounting(value);
    return sealArchiveEvidence({
      state: accounting.state === "verified" ? "completed_verified" : "ambiguous",
      archive_write_acknowledged: accounting.archive_receipt_acknowledged,
      archive_readback_verified: accounting.archived_readback_verified,
      active_removal_verified: accounting.active_absence_verified,
      response_loss_possible: accounting.response_loss_possible,
      evidence_source: "commit_journal_archive_accounting",
      commit_archive_accounting: accounting,
      local_journal_archive_writes_lower_bound:
        accounting.local_journal_archive_writes_lower_bound,
    });
  } catch {
    return ambiguousArchiveEvidence("commit_archive_evidence_invalid");
  }
}

function downgradeUntrustedArchiveEvidence(value, boundary) {
  const evidence = requiredObject(value, "untrusted reviewed recovery archive evidence");
  return sealArchiveEvidence({
    state: "ambiguous",
    archive_write_acknowledged: evidence.archive_write_acknowledged === true,
    archive_readback_verified: false,
    active_removal_verified: false,
    response_loss_possible: true,
    evidence_source: boundary,
    commit_archive_accounting: null,
    local_journal_archive_writes_lower_bound:
      evidence.local_journal_archive_writes_lower_bound,
  });
}

function normalizeAuditArchiveState(state) {
  return state === "completed_verified" ? state : "ambiguous";
}

function verifiedArchivedEvidence(journal) {
  return sealArchiveEvidence({
    state: "completed_verified",
    archive_write_acknowledged: true,
    archive_readback_verified: true,
    active_removal_verified: true,
    response_loss_possible: false,
    evidence_source: `preexisting_archived_journal:${journal.journal_sha256}`,
    commit_archive_accounting: null,
    local_journal_archive_writes_lower_bound: 0,
  });
}

function archiveEvidenceForInspection(before) {
  const state = before.evidence.journals.archived
    ? before.evidence.journals.active ? "ambiguous" : "completed_verified"
    : "not_started";
  return sealArchiveEvidence({
    state,
    archive_write_acknowledged: state === "completed_verified",
    archive_readback_verified: state === "completed_verified",
    active_removal_verified: state === "completed_verified",
    response_loss_possible: false,
    evidence_source: "reviewed_recovery_read_only_inspection",
    commit_archive_accounting: null,
    local_journal_archive_writes_lower_bound: 0,
  });
}

function notStartedArchiveEvidence() {
  return sealArchiveEvidence({
    state: "not_started",
    archive_write_acknowledged: false,
    archive_readback_verified: false,
    active_removal_verified: false,
    response_loss_possible: false,
    evidence_source: "no_journal_before_business_boundary",
    commit_archive_accounting: null,
    local_journal_archive_writes_lower_bound: 0,
  });
}

function ambiguousArchiveEvidence(source) {
  return sealArchiveEvidence({
    state: "ambiguous",
    archive_write_acknowledged: false,
    archive_readback_verified: false,
    active_removal_verified: false,
    response_loss_possible: true,
    evidence_source: source,
    commit_archive_accounting: null,
    local_journal_archive_writes_lower_bound: 0,
  });
}

function sealArchiveEvidence({
  state,
  archive_write_acknowledged,
  archive_readback_verified,
  active_removal_verified,
  response_loss_possible,
  evidence_source,
  commit_archive_accounting = null,
  local_journal_archive_writes_lower_bound = 0,
}) {
  const content = {
    schema_version:
      STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_RECOVERY_ARCHIVE_EVIDENCE_SCHEMA,
    state: normalizeAuditArchiveState(state) === "completed_verified"
      ? "completed_verified"
      : state === "not_started" ? "not_started" : "ambiguous",
    archive_write_acknowledged: archive_write_acknowledged === true,
    archive_readback_verified: archive_readback_verified === true,
    active_removal_verified: active_removal_verified === true,
    response_loss_possible: response_loss_possible === true,
    evidence_source: requiredText(evidence_source, "archive evidence source"),
    commit_archive_accounting: commit_archive_accounting
      ? cloneJson(assertStage1EvidenceSchemaUpgradeJournalArchiveAccounting(
          commit_archive_accounting,
        ))
      : null,
    local_journal_archive_writes_lower_bound:
      requiredNonnegativeInteger(
        local_journal_archive_writes_lower_bound,
        "local journal archive writes lower bound",
      ),
  };
  if (content.state === "completed_verified" && (
    !content.archive_write_acknowledged
    || !content.archive_readback_verified
    || !content.active_removal_verified
    || content.response_loss_possible
  )) throw new Error("Completed archive evidence is not exactly verified.");
  const nested = content.commit_archive_accounting;
  if (content.state === "not_started" && (
    content.archive_write_acknowledged
    || content.archive_readback_verified
    || content.active_removal_verified
    || content.response_loss_possible
    || content.local_journal_archive_writes_lower_bound !== 0
    || nested !== null
    || !new Set([
      "no_journal_before_business_boundary",
      "reviewed_recovery_read_only_inspection",
    ]).has(content.evidence_source)
  )) throw new Error("Not-started archive evidence claims archive activity.");
  if (content.state === "completed_verified" && nested === null && (
    content.local_journal_archive_writes_lower_bound !== 0
    || !(content.evidence_source.startsWith("preexisting_archived_journal:")
      || content.evidence_source === "reviewed_recovery_read_only_inspection")
  )) throw new Error("Preexisting completed archive evidence has invalid provenance.");
  if (nested !== null && (
    content.archive_write_acknowledged !== nested.archive_receipt_acknowledged
    || content.local_journal_archive_writes_lower_bound
      !== nested.local_journal_archive_writes_lower_bound
    || (content.archive_readback_verified && !nested.archived_readback_verified)
    || (content.active_removal_verified && !nested.active_absence_verified)
    || (nested.response_loss_possible && !content.response_loss_possible)
    || (content.state === "completed_verified" && nested.state !== "verified")
  )) throw new Error("Archive evidence differs from its nested commit accounting.");
  if (content.state === "ambiguous" && (
    content.active_removal_verified
    || (content.archive_readback_verified && !content.archive_write_acknowledged)
    || (!content.archive_write_acknowledged
      && content.local_journal_archive_writes_lower_bound > 0)
  )) throw new Error("Ambiguous archive evidence contains contradictory proof flags.");
  return deepFreeze({
    ...content,
    archive_evidence_sha256: sha256(canonicalJson(content)),
  });
}

function assertArchiveEvidence(value) {
  const evidence = requiredObject(value, "reviewed journal archive evidence");
  assertExactKeys(evidence, [
    "active_removal_verified",
    "archive_evidence_sha256",
    "archive_readback_verified",
    "archive_write_acknowledged",
    "commit_archive_accounting",
    "evidence_source",
    "local_journal_archive_writes_lower_bound",
    "response_loss_possible",
    "schema_version",
    "state",
  ], "reviewed journal archive evidence");
  const content = cloneJson(evidence);
  delete content.archive_evidence_sha256;
  const rebuilt = sealArchiveEvidence(content);
  if (rebuilt.archive_evidence_sha256 !== evidence.archive_evidence_sha256) {
    throw new Error("Reviewed journal archive evidence seal is invalid.");
  }
  return rebuilt;
}

function buildReport({
  context,
  before,
  after,
  status,
  disposition,
  selectedResult,
  commitReceipt,
  terminal,
  originalAccounting,
  recoveryAccounting: recoveryAccountingValue,
  archiveEvidence,
  auditReceipt,
  auditFinishAttempt = null,
  auditFinishEvidence = null,
  auditFinishAuthority = null,
  auditAfterObservation = "current_evidence",
  responseLossPossible,
  auditAccountingOverride = null,
  recoveryStartJournalOverride = null,
  recoveryCompletedJournalOverride = null,
}) {
  const recovery = assertStage1EvidenceSchemaUpgradeMutationAccounting(
    recoveryAccountingValue,
  );
  const original = assertStage1EvidenceSchemaUpgradeMutationAccounting(
    originalAccounting,
    { operation: "pointer_commit" },
  );
  const auditAccounting = assertStage1EvidenceSchemaUpgradeReviewedApplyAuditAccounting(
    auditAccountingOverride
      || auditReceipt?.audit_mutation_accounting
      || zeroRecoveryAuditAccounting(),
  );
  const recoveryStartJournalLocation = recoveryStartJournalOverride
    ? "active"
    : before.evidence.journals.active
      ? "active"
      : before.evidence.journals.archived ? "archived" : null;
  const recoveryStartJournal = recoveryStartJournalOverride
    ? assertStage1EvidenceSchemaUpgradeJournal(recoveryStartJournalOverride)
    : recoveryStartJournalLocation
      ? assertStage1EvidenceSchemaUpgradeJournal(
        before.evidence.journals[recoveryStartJournalLocation],
      )
    : null;
  const recoveryStartAudit = commitReceipt || auditFinishAttempt || auditReceipt || terminal
    ? assertStage1EvidenceSchemaUpgradeReviewedApplyAuditRecoveryInspection(before.audit)
    : null;
  const recoveryCompletedJournal = recoveryCompletedJournalOverride
    ? assertStage1EvidenceSchemaUpgradeJournal(recoveryCompletedJournalOverride)
    : commitReceipt
      ? assertStage1EvidenceSchemaUpgradeJournal(after.evidence.journals.archived)
    : null;
  const reviewedReconciliationEvidence = recoveryCompletedJournal
    ? expectedReviewedReconciliationEvidence(
      recoveryCompletedJournal,
    )
    : null;
  const content = {
    schema_version:
      STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_RECOVERY_EXECUTION_REPORT_SCHEMA,
    mode: MODE,
    status,
    disposition,
    source_id: context.sourceId,
    transaction_id: context.transactionId,
    recovery_plan_file_sha256: before.validated?.plan_file_sha256
      || context.expectedRecoveryPlanFileSha256,
    recovery_plan_sha256: before.validated?.plan_sha256 || null,
    recovery_completed_journal: recoveryCompletedJournal
      ? cloneJson(recoveryCompletedJournal)
      : null,
    recovery_start_audit_inspection: recoveryStartAudit
      ? cloneJson(recoveryStartAudit)
      : null,
    recovery_start_journal: recoveryStartJournal
      ? cloneJson(recoveryStartJournal)
      : null,
    recovery_start_journal_location: recoveryStartJournalLocation,
    inspection_file_sha256: before.validated?.plan?.inspection?.inspection_file_sha256,
    inspection_sha256: before.validated?.plan?.inspection?.inspection_sha256,
    proposed_plan_sha256: before.validated?.plan?.inspection?.proposed_plan_sha256,
    inspection_evidence_sha256: before.validated?.plan?.inspection?.evidence_sha256,
    reviewed_apply_plan_file_sha256: context.historical.plan_file_sha256,
    reviewed_apply_plan_sha256: context.historical.plan_sha256,
    reviewed_expected_disposition: before.validated.expected_disposition,
    reviewed_reconciliation_evidence: reviewedReconciliationEvidence
      ? cloneJson(reviewedReconciliationEvidence)
      : null,
    execution_nonce: before.audit.execution_nonce,
    audit_before_inspection_sha256: before.audit.inspection_sha256,
    audit_after_inspection_sha256: after.audit.inspection_sha256,
    audit_after_inspection: cloneJson(after.audit),
    audit_after_inspection_observation: requiredText(
      auditAfterObservation,
      "reviewed recovery after-audit observation provenance",
    ),
    audit_terminal: cloneJson(terminal),
    audit_finish_attempt: auditFinishAttempt ? cloneJson(auditFinishAttempt) : null,
    audit_finish_authority: auditFinishAuthority ? cloneJson(auditFinishAuthority) : null,
    audit_finish_evidence: auditFinishEvidence
      ? recoveryEvidenceReportProjection(auditFinishEvidence)
      : null,
    audit_receipt: auditReceipt ? cloneJson(auditReceipt) : null,
    audit_mutation_accounting: cloneJson(auditAccounting),
    selected_result: selectedResult ? cloneJson(selectedResult) : null,
    commit_receipt: commitReceipt ? cloneJson(commitReceipt) : null,
    interrupted_original_mutation_accounting: cloneJson(original),
    recovery_invocation_mutation_accounting: cloneJson(recovery),
    journal_archive_persistence: cloneJson(assertArchiveEvidence(archiveEvidence)),
    source_lock_response_loss_possible: false,
    response_loss_possible:
      responseLossPossible === true
      || commitResponseLossPossible(recovery, archiveEvidence)
      || auditAccounting.evidence?.response_loss_possible === true,
    mutation_performed:
      Object.values(recovery.lower_bound_counts).some((count) => count > 0)
      || recovery.unknown_write_categories.length > 0
      || journalPersistenceMutationPossible(recovery)
      || archiveEvidence.local_journal_archive_writes_lower_bound > 0
      || auditMutationPossible(auditAccounting),
    creates_api_charge: false,
    authority: cloneJson(before.validated?.authority || before.validated?.plan?.authority),
    completed_at: context.clock.read(),
  };
  return deepFreeze({
    ...content,
    report_sha256: sha256(canonicalJson(content)),
  });
}

function markSourceLockResponseLoss(report) {
  const content = cloneJson(requiredObject(report, "locked reviewed recovery report"));
  delete content.report_sha256;
  content.disposition = `${content.disposition}_source_lock_release_response_lost`;
  content.source_lock_response_loss_possible = true;
  content.response_loss_possible = true;
  return deepFreeze({
    ...content,
    report_sha256: sha256(canonicalJson(content)),
  });
}

function assertSameValidatedRecoveryPlan(observed, expected) {
  if (
    observed.plan_file_sha256 !== expected.plan_file_sha256
    || observed.plan_sha256 !== expected.plan_sha256
    || observed.selected_source_id !== expected.selected_source_id
    || observed.transaction_id !== expected.transaction_id
    || observed.audit_run_id !== expected.audit_run_id
    || observed.execution_nonce !== expected.execution_nonce
    || observed.expected_disposition !== expected.expected_disposition
    || !sameJson(observed.plan, expected.plan)
  ) throw new Error("Reviewed recovery evidence changed after source-lock validation.");
}

function validateInterfaces(value) {
  const interfaces = requiredObject(value, "reviewed recovery interfaces");
  const unexpected = Object.keys(interfaces).filter((name) => !ALLOWED_INTERFACES.has(name));
  if (unexpected.length) {
    throw new Error(
      `Reviewed recovery forbids additional interface authority: ${unexpected.sort().join(",")}.`,
    );
  }
  const missing = REQUIRED_INTERFACES.filter(
    (name) => typeof interfaces[name] !== "function",
  );
  if (missing.length) {
    throw new Error(`Reviewed recovery is missing interfaces: ${missing.join(",")}.`);
  }
  return interfaces;
}

function recoveryReviewCurrent(validated, now) {
  const currentMs = Date.parse(requiredTimestamp(now, "recovery finish now"));
  const reviewer = requiredObject(validated.reviewer, "recovery plan reviewer");
  return currentMs >= Date.parse(reviewer.reviewed_at)
    && currentMs < Date.parse(reviewer.expires_at);
}

function auditMutationPossible(value) {
  const accounting = assertStage1EvidenceSchemaUpgradeReviewedApplyAuditAccounting(value);
  return Object.values(accounting.lower_bound_counts).some((count) => count > 0)
    || accounting.unknown_write_categories.length > 0;
}

function zeroRecoveryAuditAccounting() {
  return sealRecoveryAuditAccounting({
    disposition: "not_called",
    observedRowStatus: "not_observed_by_audit_callback",
    unknownWriteCategories: [],
    responseLossPossible: false,
  });
}

function unknownAuditFinishAccounting(observedRowStatus) {
  return sealRecoveryAuditAccounting({
    disposition: "finish_callback_response_unverified",
    observedRowStatus,
    unknownWriteCategories: ["local_worker_run_terminal_updates"],
    responseLossPossible: true,
  });
}

function sealRecoveryAuditAccounting({
  disposition,
  observedRowStatus,
  unknownWriteCategories,
  responseLossPossible,
}) {
  const unknown = [...new Set(unknownWriteCategories)].sort();
  const content = {
    schema_version:
      STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_AUDIT_ACCOUNTING_SCHEMA,
    count_scope: "local_worker_runs_writes_in_this_orchestration_invocation",
    count_semantics: "confirmed_lower_bounds",
    exact: unknown.length === 0,
    lower_bound_counts: {
      local_worker_run_inserts: 0,
      local_worker_run_terminal_updates: 0,
    },
    unknown_write_categories: unknown,
    evidence: {
      action: disposition === "not_called" ? "none" : "finish",
      disposition,
      response_loss_possible: responseLossPossible,
      observed_row_status: observedRowStatus,
    },
  };
  return deepFreeze({
    ...content,
    accounting_sha256: sha256(canonicalJson(content)),
  });
}

function executionClock(value) {
  if (typeof value === "function") {
    let lastMilliseconds = null;
    return Object.freeze({
      read: () => {
        const current = requiredTimestamp(value(), "recovery execution now");
        const milliseconds = Date.parse(current);
        if (lastMilliseconds !== null && milliseconds < lastMilliseconds) {
          throw new Error("Reviewed recovery execution clock moved backward.");
        }
        lastMilliseconds = milliseconds;
        return current;
      },
    });
  }
  const fixed = requiredTimestamp(value, "recovery execution now");
  return Object.freeze({ read: () => fixed });
}

function requiredTimestamp(value, label) {
  const text = requiredText(value, label);
  const milliseconds = Date.parse(text);
  if (!Number.isFinite(milliseconds)) throw new Error(`${label} is invalid.`);
  return new Date(milliseconds).toISOString();
}

function requiredSha256(value, label) {
  if (!SHA256_PATTERN.test(value || "")) throw new Error(`${label} is invalid.`);
  return value;
}

function requiredUuid(value, label) {
  if (!UUID_PATTERN.test(value || "")) throw new Error(`${label} is invalid.`);
  return value;
}

function requiredText(value, label) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`${label} is required.`);
  return text;
}

function requiredNonnegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function requiredObject(value, label) {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be an object.`);
  return value;
}

function assertExactKeys(value, expected, label) {
  if (!sameJson(Object.keys(value).sort(), [...expected].sort())) {
    throw new Error(`${label} has unexpected or missing fields.`);
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sameJson(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function cloneJson(value) {
  if (value === null || value === undefined) return value;
  return JSON.parse(JSON.stringify(value));
}

function recoveryEvidenceReportProjection(value) {
  if (value instanceof Uint8Array) {
    const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    return {
      binary_byte_length: bytes.byteLength,
      binary_sha256: sha256(bytes),
    };
  }
  if (Array.isArray(value)) return value.map(recoveryEvidenceReportProjection);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value).sort().map(
        (key) => [key, recoveryEvidenceReportProjection(value[key])],
      ),
    );
  }
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value))
  ) return value;
  throw new Error("Reviewed recovery report evidence contains a non-canonical value.");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  if (ArrayBuffer.isView(value)) return value;
  Object.freeze(value);
  for (const entry of Object.values(value)) deepFreeze(entry);
  return value;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
