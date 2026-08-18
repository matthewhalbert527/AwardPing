import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_COMMIT_RECEIPT_SCHEMA,
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_CONTEXT,
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_JOURNAL_ARCHIVE_ACCOUNTING_SCHEMA,
  buildStage1EvidenceSchemaUpgradeReviewedReconciliationEvidence,
} from "./stage1-evidence-schema-upgrade-commit.mjs";
import {
  stage1EvidenceSchemaUpgradeR2BindingReceiptSha256,
} from "./stage1-evidence-schema-upgrade-r2-binding.mjs";
import {
  finishStage1EvidenceSchemaUpgradeReviewedApplyAudit,
  inspectStage1EvidenceSchemaUpgradeReviewedApplyAuditRecovery,
  stage1EvidenceSchemaUpgradeReviewedApplyAuditFreshCompletionAuthority,
  stage1EvidenceSchemaUpgradeReviewedApplyAuditRecoveryCompletionAuthority,
} from "./stage1-evidence-schema-upgrade-reviewed-apply-audit.mjs";
import {
  sealStage1EvidenceSchemaUpgradeMutationAccounting,
  zeroStage1EvidenceSchemaUpgradeMutationCounts,
} from "./stage1-evidence-schema-upgrade-mutation-accounting.mjs";
import {
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_RECOVERY_EXECUTION_REPORT_SCHEMA,
  assertStage1EvidenceSchemaUpgradeReviewedRecoveryExecutionReport,
  runStage1EvidenceSchemaUpgradeReviewedRecoveryExecution,
  stage1EvidenceSchemaUpgradeReviewedRecoveryFailureTerminalForDisposition,
} from "./stage1-evidence-schema-upgrade-reviewed-recovery-execution.mjs";
import {
  candidateBaseline,
  createPlan,
  currentSnapshot,
  fixtureState,
  journalAbandonedOld,
  journalAtPhase,
  liveSourceHealthSucceeded,
  sourceId,
  terminalizeAudit,
} from "./stage1-evidence-schema-upgrade-reviewed-recovery-plan.test.mjs";
import {
  VISUAL_SNAPSHOT_LATEST_ONLY_CLEANUP_DEBT_SCHEMA,
  planLatestOnlyVisualSnapshotPointerReconciliation,
} from "./visual-snapshot-latest-only-reconciliation.mjs";

describe("reviewed exact-transaction recovery execution", () => {
  it("finishes the original audit failed only for exact no-journal old authority", async () => {
    const harness = await executionHarness();
    const report = await harness.run();

    expect(report).toMatchObject({
      schema_version:
        STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_RECOVERY_EXECUTION_REPORT_SCHEMA,
      status: "failed",
      disposition: "audit_failed_finished",
      source_id: sourceId,
      selected_result: null,
      commit_receipt: null,
      creates_api_charge: false,
      response_loss_possible: false,
    });
    expect(harness.calls.recoverActiveJournal).not.toHaveBeenCalled();
    expect(harness.fixture.audit.row_kind).toBe("terminal_failed");
  });

  it("succeeds from exact archived candidate proof with separate accounting scopes", async () => {
    const fixture = await fixtureState();
    const completed = journalAtPhase(fixture, "completed");
    fixture.journals = { active: null, archived: completed };
    fixture.current = currentSnapshot(fixture, {
      baselineBytes: candidateBaseline,
      pointer: completed.candidate_pointer_identity.projection,
      source: liveSourceHealthSucceeded(),
    });
    const harness = await executionHarness(fixture);
    const report = await harness.run();

    expect(report).toMatchObject({
      status: "succeeded",
      disposition: "audit_succeeded_finished",
      commit_receipt: {
        schema_version: STAGE1_EVIDENCE_SCHEMA_UPGRADE_COMMIT_RECEIPT_SCHEMA,
        status: "upgraded",
        mutation_count_scope: "confirmed_io_receipts_in_this_invocation",
        journal_sha256: completed.journal_sha256,
      },
      journal_archive_persistence: {
        state: "completed_verified",
        local_journal_archive_writes_lower_bound: 0,
      },
    });
    expect(report.interrupted_original_mutation_accounting.evidence.mutation_scope)
      .toBe("interrupted_original_invocation_only");
    expect(report.recovery_invocation_mutation_accounting.evidence.mutation_scope)
      .toBe("current_recovery_invocation_only");
    expect(report.commit_receipt.mutation_accounting.evidence)
      .toMatchObject({
        mutation_scope: "current_recovery_invocation_only",
        original_operation_totals_not_represented: true,
      });

    const forged = structuredClone(report);
    forged.commit_receipt.cas.confirmed_database_pointer_writes = 1;
    forged.selected_result.pointer_journal.receipt = structuredClone(
      forged.commit_receipt,
    );
    resealSucceededReportPayload(forged);
    expect(() => assertStage1EvidenceSchemaUpgradeReviewedRecoveryExecutionReport(
      forged,
    )).toThrow(/unauthorized current CAS write|commit proof is not exact/i);

    const erasedOriginalUncertainty = structuredClone(report);
    erasedOriginalUncertainty.interrupted_original_mutation_accounting =
      sealStage1EvidenceSchemaUpgradeMutationAccounting({
        operation: "pointer_commit",
        lowerBoundCounts: zeroStage1EvidenceSchemaUpgradeMutationCounts(),
        unknownWriteCategories: ["local_baseline_writes", "r2_writes"],
        evidence: {
          boundary: "interrupted_original_invocation",
          journal_phase: "prepared",
          journal_sha256: completed.journal_sha256,
          mutation_scope: "interrupted_original_invocation_only",
          local_journal_writes_reported_separately: true,
        },
      });
    resealReport(erasedOriginalUncertainty);
    expect(() => assertStage1EvidenceSchemaUpgradeReviewedRecoveryExecutionReport(
      erasedOriginalUncertainty,
    )).toThrow(/differs from its start journal/i);
  });

  it("replays terminal success and failure with zero writes and persisted identities", async () => {
    const successFixture = await fixtureState();
    const completed = journalAtPhase(successFixture, "completed");
    successFixture.journals = { active: null, archived: completed };
    successFixture.current = currentSnapshot(successFixture, {
      baselineBytes: candidateBaseline,
      pointer: completed.candidate_pointer_identity.projection,
      source: liveSourceHealthSucceeded(),
    });
    await terminalizeAudit(successFixture, { status: "succeeded", journal: completed });
    const success = await executionHarness(successFixture);
    const successReport = await success.run();
    expect(successReport).toMatchObject({
      status: "succeeded",
      disposition: "terminal_success_report_replay",
      selected_result: null,
      commit_receipt: null,
      mutation_performed: false,
    });
    expect(successReport.audit_terminal).toEqual(successFixture.audit.terminal);
    expect(success.calls.finishOriginalAudit).not.toHaveBeenCalled();

    const erasedReplayJournal = structuredClone(successReport);
    erasedReplayJournal.recovery_start_journal = null;
    erasedReplayJournal.recovery_start_journal_location = null;
    erasedReplayJournal.interrupted_original_mutation_accounting =
      sealStage1EvidenceSchemaUpgradeMutationAccounting({
        operation: "pointer_commit",
        lowerBoundCounts: zeroStage1EvidenceSchemaUpgradeMutationCounts(),
        unknownWriteCategories: [],
        evidence: {
          boundary: "interrupted_original_invocation",
          journal_phase: "absent_before_journal",
          journal_sha256: null,
          mutation_scope: "interrupted_original_invocation_only",
          local_journal_writes_reported_separately: true,
        },
      });
    resealReport(erasedReplayJournal);
    expect(() => assertStage1EvidenceSchemaUpgradeReviewedRecoveryExecutionReport(
      erasedReplayJournal,
    )).toThrow(/interrupted-original accounting profile is invalid/i);

    const downgradedArchivedReplay = structuredClone(successReport);
    Object.assign(downgradedArchivedReplay.journal_archive_persistence, {
      state: "not_started",
      archive_write_acknowledged: false,
      archive_readback_verified: false,
      active_removal_verified: false,
      response_loss_possible: false,
      evidence_source: "no_journal_before_business_boundary",
    });
    resealArchiveEvidence(downgradedArchivedReplay.journal_archive_persistence);
    resealReport(downgradedArchivedReplay);
    expect(() => assertStage1EvidenceSchemaUpgradeReviewedRecoveryExecutionReport(
      downgradedArchivedReplay,
    )).toThrow(/archived replay topology|contradictory archive accounting/i);

    const falsePartialReplay = structuredClone(successReport);
    falsePartialReplay.reviewed_expected_disposition =
      "finish_partial_archive_then_replay_candidate_success";
    falsePartialReplay.recovery_start_journal_location = "active";
    resealReport(falsePartialReplay);
    expect(() => assertStage1EvidenceSchemaUpgradeReviewedRecoveryExecutionReport(
      falsePartialReplay,
    )).toThrow(/contradictory archive accounting|partial-archive replay lacks/i);

    const forgedReplayWrites = structuredClone(successReport);
    forgedReplayWrites.recovery_invocation_mutation_accounting =
      sealStage1EvidenceSchemaUpgradeMutationAccounting({
        operation: "reviewed_exact_transaction_recovery",
        lowerBoundCounts: {
          ...zeroStage1EvidenceSchemaUpgradeMutationCounts(),
          local_baseline_writes: 1,
        },
        unknownWriteCategories: [],
        evidence: {
          boundary: "terminal_report_replay_read_only",
          mutation_scope: "current_recovery_invocation_only",
          response_loss_possible: false,
        },
      });
    forgedReplayWrites.mutation_performed = true;
    resealReport(forgedReplayWrites);
    expect(() => assertStage1EvidenceSchemaUpgradeReviewedRecoveryExecutionReport(
      forgedReplayWrites,
    )).toThrow(/terminal replay.*business writes/i);

    const forgedReplayProfile = structuredClone(successReport);
    forgedReplayProfile.recovery_invocation_mutation_accounting =
      sealStage1EvidenceSchemaUpgradeMutationAccounting({
        operation: "attacker_operation",
        lowerBoundCounts: zeroStage1EvidenceSchemaUpgradeMutationCounts(),
        unknownWriteCategories: [],
        evidence: {
          boundary: "attacker_boundary",
          mutation_scope: "current_recovery_invocation_only",
          response_loss_possible: false,
        },
      });
    resealReport(forgedReplayProfile);
    expect(() => assertStage1EvidenceSchemaUpgradeReviewedRecoveryExecutionReport(
      forgedReplayProfile,
    )).toThrow(/read-only terminal replay has contradictory archive accounting/i);

    const failureFixture = await fixtureState();
    await terminalizeAudit(failureFixture, { status: "failed" });
    const failure = await executionHarness(failureFixture);
    const failureReport = await failure.run();
    expect(failureReport).toMatchObject({
      status: "failed",
      disposition: "terminal_failure_report_replay",
      mutation_performed: false,
    });
    expect(failure.calls.finishOriginalAudit).not.toHaveBeenCalled();

    const freshOldFixture = await fixtureState();
    freshOldFixture.journals = {
      active: null,
      archived: journalAbandonedOld(freshOldFixture),
    };
    await terminalizeAudit(freshOldFixture, {
      status: "failed",
      failureTerminal: {
        status: "failed",
        error_code: "reviewed_unchanged_upgrade_old_authority_preserved",
        error_message: "Reviewed unchanged upgrade ended selected_blocked.",
      },
    });
    const freshOld = await executionHarness(freshOldFixture);
    const freshOldReport = await freshOld.run();
    expect(freshOldReport).toMatchObject({
      status: "failed",
      disposition: "terminal_failure_report_replay",
      reviewed_expected_disposition: "report_replay_archived_old_abandonment",
      mutation_performed: false,
    });
    const falseFreshOldNarrative = structuredClone(freshOldReport);
    falseFreshOldNarrative.audit_terminal.failure = {
      error_code: "attacker_failure",
      error_summary: "attacker failure narrative",
      error_message_sha256: sha256("attacker failure narrative"),
    };
    resealAuditTerminal(falseFreshOldNarrative.audit_terminal);
    resealReport(falseFreshOldNarrative);
    expect(() => assertStage1EvidenceSchemaUpgradeReviewedRecoveryExecutionReport(
      falseFreshOldNarrative,
    )).toThrow(/false failure narrative|differs from its audit inspection/i);
  });

  it("reports a terminal from reviewed recovery plan A under a later replay plan B", async () => {
    const fixture = await fixtureState();
    const active = journalAtPhase(fixture, "prepared");
    fixture.journals = { active, archived: null };
    const planA = createPlan(fixture);
    expect(planA.checked.expected_disposition).toBe("resume_active_old_authority");
    const completionAuthorityA =
      stage1EvidenceSchemaUpgradeReviewedApplyAuditRecoveryCompletionAuthority({
        recoveryPlan: planA.plan,
        expectedRecoveryPlanFileSha256: planA.plan_file_sha256,
        expectedRecoveryPlanSha256: planA.plan.plan_sha256,
        sourceId,
        transactionId: active.transaction_id,
      });
    await terminalizeAudit(fixture, {
      status: "failed",
      completionAuthority: completionAuthorityA,
      failureTerminal:
        stage1EvidenceSchemaUpgradeReviewedRecoveryFailureTerminalForDisposition(
          "resume_active_old_authority",
        ),
      finishedAt: "2026-08-20T11:10:00.000Z",
    });
    fixture.journals = { active: null, archived: journalAbandonedOld(fixture) };
    fixture.recoveryReviewTiming = {
      evidenceObservedAt: "2026-08-20T11:15:00.000Z",
      reviewedAt: "2026-08-20T11:20:00.000Z",
      expiresAt: "2026-08-20T13:00:00.000Z",
    };
    const harness = await executionHarness(fixture);
    expect(harness.built.plan.plan_sha256).not.toBe(planA.plan.plan_sha256);
    const report = await harness.run();
    expect(report).toMatchObject({
      status: "failed",
      disposition: "terminal_failure_report_replay",
      reviewed_expected_disposition: "report_replay_archived_old_abandonment",
    });
    expect(report.audit_terminal.completion_authority.recovery.recovery_plan_sha256)
      .toBe(planA.plan.plan_sha256);
    expect(() => assertStage1EvidenceSchemaUpgradeReviewedRecoveryExecutionReport(
      report,
    )).not.toThrow();

    const candidateFixture = await fixtureState();
    const candidateJournal = journalAtPhase(candidateFixture, "completed");
    candidateFixture.journals = { active: candidateJournal, archived: null };
    candidateFixture.current = currentSnapshot(candidateFixture, {
      baselineBytes: candidateBaseline,
      pointer: candidateJournal.candidate_pointer_identity.projection,
      source: liveSourceHealthSucceeded(),
    });
    const candidatePlanA = createPlan(candidateFixture);
    expect(candidatePlanA.checked.expected_disposition)
      .toBe("resume_active_candidate_authority");
    const candidateAuthorityA =
      stage1EvidenceSchemaUpgradeReviewedApplyAuditRecoveryCompletionAuthority({
        recoveryPlan: candidatePlanA.plan,
        expectedRecoveryPlanFileSha256: candidatePlanA.plan_file_sha256,
        expectedRecoveryPlanSha256: candidatePlanA.plan.plan_sha256,
        sourceId,
        transactionId: candidateJournal.transaction_id,
      });
    await terminalizeAudit(candidateFixture, {
      status: "succeeded",
      journal: candidateJournal,
      completionAuthority: candidateAuthorityA,
      finishedAt: "2026-08-20T11:10:00.000Z",
    });
    candidateFixture.journals = { active: null, archived: candidateJournal };
    candidateFixture.recoveryReviewTiming = fixture.recoveryReviewTiming;
    const candidateHarness = await executionHarness(candidateFixture);
    const candidateReport = await candidateHarness.run();
    expect(candidateReport).toMatchObject({
      status: "succeeded",
      disposition: "terminal_success_report_replay",
      reviewed_expected_disposition: "report_replay_archived_candidate_success",
    });
    expect(candidateReport.audit_terminal.completion_authority.recovery.recovery_plan_sha256)
      .toBe(candidatePlanA.plan.plan_sha256);
    expect(() => assertStage1EvidenceSchemaUpgradeReviewedRecoveryExecutionReport(
      candidateReport,
    )).not.toThrow();
  });

  it.each([
    "prepared",
    "local_candidate_written",
    "pointer_cas_attempted",
    "pointer_candidate_committed",
    "recovery_required",
  ])("recovers active %s old authority and fails the original audit", async (phase) => {
    const fixture = await fixtureState();
    const active = journalAtPhase(fixture, phase);
    fixture.journals = { active, archived: null };
    const harness = await executionHarness(fixture, {
      recoverActiveJournal: async (request) => {
        expect(request.expected_active_journal_sha256).toBe(active.journal_sha256);
        const completed = journalAbandonedOld(fixture);
        fixture.journals = { active: null, archived: completed };
        return commitResult({ journal: completed, status: "abandoned_old_authority" });
      },
    });
    const report = await harness.run();
    expect(report.status).toBe("failed");
    expect(report.commit_receipt).toBeNull();
    expect(fixture.audit.row_kind).toBe("terminal_failed");
  });

  it("rejects a resealed archived-old report with different reviewed R2 evidence", async () => {
    const fixture = await fixtureState();
    fixture.journals = { active: null, archived: journalAbandonedOld(fixture) };
    const harness = await executionHarness(fixture);
    const report = await harness.run();
    expect(report.status).toBe("failed");

    const forged = structuredClone(report);
    const receipt = forged.audit_finish_evidence.currentAuthoritySnapshot.r2BindingReceipt;
    receipt.limitations = [...receipt.limitations, "forged_old_non_core_claim"].sort();
    receipt.receipt_sha256 = stage1EvidenceSchemaUpgradeR2BindingReceiptSha256(receipt);
    forged.audit_finish_authority.r2_binding_receipt = structuredClone(receipt);
    forged.audit_finish_authority.r2_binding_receipt_sha256 = receipt.receipt_sha256;
    const authorityContent = structuredClone(forged.audit_finish_authority);
    delete authorityContent.authority_projection_sha256;
    forged.audit_finish_authority.authority_projection_sha256 =
      sha256(canonicalJson(authorityContent));
    forged.audit_finish_attempt.expected_recovery_evidence_sha256 =
      sha256(canonicalJson(forged.audit_finish_evidence));
    resealAuditFinishAttempt(forged.audit_finish_attempt);
    resealReport(forged);
    expect(() => assertStage1EvidenceSchemaUpgradeReviewedRecoveryExecutionReport(
      forged,
    )).toThrow(/old R2 authority differs from its exact review/i);
  });

  it("archives an active completed candidate and terminalizes success", async () => {
    const fixture = await fixtureState();
    const completed = journalAtPhase(fixture, "completed");
    fixture.journals = { active: completed, archived: null };
    fixture.current = currentSnapshot(fixture, {
      baselineBytes: candidateBaseline,
      pointer: completed.candidate_pointer_identity.projection,
      source: liveSourceHealthSucceeded(),
    });
    const harness = await executionHarness(fixture, {
      recoverActiveJournal: async () => {
        fixture.journals = { active: null, archived: completed };
        return commitResult({
          journal: completed,
          status: "upgraded",
          completedReplay: true,
        });
      },
    });
    const report = await harness.run();
    expect(report.status).toBe("succeeded");
    expect(report.journal_archive_persistence).toMatchObject({
      state: "completed_verified",
      local_journal_archive_writes_lower_bound: 1,
      commit_archive_accounting: { state: "verified" },
    });
    expect(report.mutation_performed).toBe(true);
  });

  it.each([
    "archive_write_response_unknown",
    "archive_write_acknowledged_readback_unverified",
    "archived_readback_verified_active_absence_response_unknown",
  ])("leaves audit running for archive ambiguity %s", async (archiveState) => {
    const fixture = await fixtureState();
    const completed = journalAtPhase(fixture, "completed");
    fixture.journals = { active: completed, archived: null };
    fixture.current = currentSnapshot(fixture, {
      baselineBytes: candidateBaseline,
      pointer: completed.candidate_pointer_identity.projection,
      source: liveSourceHealthSucceeded(),
    });
    const harness = await executionHarness(fixture, {
      recoverActiveJournal: async () => {
        if (archiveState !== "archive_write_response_unknown") {
          fixture.journals = {
            active: archiveState.includes("active_absence") ? null : completed,
            archived: completed,
          };
        }
        const accounting = commitAccounting(
          archiveAccounting(archiveState),
          journalPersistence("not_started", 0, false),
        );
        const error = new Error("archive response lost");
        error.stage1_mutation_accounting = accounting;
        throw error;
      },
    });
    const report = await harness.run();
    expect(report).toMatchObject({
      status: "recovery_required",
      disposition: "active_recovery_response_or_outcome_unverified",
      response_loss_possible: true,
    });
    expect(fixture.audit.row_kind).toBe("running");
    expect(harness.calls.finishOriginalAudit).not.toHaveBeenCalled();
  });

  it("keeps a normalized terminal result running when archive proof is not verified", async () => {
    const fixture = await fixtureState();
    const completed = journalAtPhase(fixture, "completed");
    fixture.journals = { active: completed, archived: null };
    fixture.current = currentSnapshot(fixture, {
      baselineBytes: candidateBaseline,
      pointer: completed.candidate_pointer_identity.projection,
      source: liveSourceHealthSucceeded(),
    });
    const harness = await executionHarness(fixture, {
      recoverActiveJournal: async () => commitResult({
        journal: completed,
        status: "upgraded",
        completedReplay: true,
        archiveState: "archive_write_acknowledged_readback_unverified",
      }),
    });
    const report = await harness.run();
    expect(report).toMatchObject({
      status: "recovery_required",
      disposition: "active_recovery_archive_not_exactly_verified",
      response_loss_possible: true,
    });
    expect(fixture.audit.row_kind).toBe("running");
    expect(harness.calls.finishOriginalAudit).not.toHaveBeenCalled();
  });

  it.each([
    ["malformed", { state: "verified", local_journal_writes_lower_bound: 1,
      response_loss_possible: false, extra: true }],
    ["contradictory", { state: "verified", local_journal_writes_lower_bound: 1,
      response_loss_possible: true }],
  ])("downgrades a terminal result with %s journal persistence without terminalizing", async (
    _label,
    invalidPersistence,
  ) => {
    const fixture = await fixtureState();
    const completed = journalAtPhase(fixture, "completed");
    fixture.journals = { active: completed, archived: null };
    fixture.current = currentSnapshot(fixture, {
      baselineBytes: candidateBaseline,
      pointer: completed.candidate_pointer_identity.projection,
      source: liveSourceHealthSucceeded(),
    });
    const harness = await executionHarness(fixture, {
      recoverActiveJournal: async () => {
        fixture.journals = { active: null, archived: completed };
        const result = commitResult({
          journal: completed,
          status: "upgraded",
          completedReplay: true,
        });
        resealCommitAccountingEvidence(result, {
          ...result.mutation_accounting.evidence,
          journal_persistence: invalidPersistence,
        });
        return result;
      },
    });
    const report = await harness.run();
    expect(report).toMatchObject({
      status: "recovery_required",
      disposition: "active_recovery_result_or_receipt_invalid",
      response_loss_possible: true,
      journal_archive_persistence: { state: "ambiguous" },
      recovery_invocation_mutation_accounting: {
        exact: false,
        evidence: {
          journal_persistence: {
            state: "write_response_unknown",
            response_loss_possible: true,
          },
        },
      },
    });
    expect(fixture.audit.row_kind).toBe("running");
    expect(harness.calls.finishOriginalAudit).not.toHaveBeenCalled();
  });

  it("does not trust verified archive accounting on an unresolved commit result", async () => {
    const fixture = await fixtureState();
    const completed = journalAtPhase(fixture, "completed");
    fixture.journals = { active: completed, archived: null };
    fixture.current = currentSnapshot(fixture, {
      baselineBytes: candidateBaseline,
      pointer: completed.candidate_pointer_identity.projection,
      source: liveSourceHealthSucceeded(),
    });
    const harness = await executionHarness(fixture, {
      recoverActiveJournal: async () => {
        const result = commitResult({
          journal: completed,
          status: "upgraded",
          completedReplay: true,
        });
        result.status = "recovery_required";
        result.receipt.status = "recovery_required";
        return result;
      },
    });
    const report = await harness.run();
    expect(report).toMatchObject({
      status: "recovery_required",
      disposition: "active_recovery_left_authority_unresolved",
      response_loss_possible: true,
      journal_archive_persistence: { state: "ambiguous" },
      recovery_invocation_mutation_accounting: {
        exact: false,
        evidence: {
        boundary: "recovery_required:active_recovery_left_authority_unresolved",
          response_loss_possible: true,
        },
      },
    });
    expect(report.recovery_invocation_mutation_accounting.evidence)
      .not.toHaveProperty("journal_archive");
    expect(fixture.audit.row_kind).toBe("running");

    const erasedPreAuditJournal = structuredClone(report);
    erasedPreAuditJournal.recovery_start_journal = null;
    erasedPreAuditJournal.recovery_start_journal_location = null;
    erasedPreAuditJournal.interrupted_original_mutation_accounting =
      sealStage1EvidenceSchemaUpgradeMutationAccounting({
        operation: "pointer_commit",
        lowerBoundCounts: zeroStage1EvidenceSchemaUpgradeMutationCounts(),
        unknownWriteCategories: [],
        evidence: {
          boundary: "interrupted_original_invocation",
          journal_phase: "absent_before_journal",
          journal_sha256: null,
          mutation_scope: "interrupted_original_invocation_only",
          local_journal_writes_reported_separately: true,
        },
      });
    resealReport(erasedPreAuditJournal);
    expect(() => assertStage1EvidenceSchemaUpgradeReviewedRecoveryExecutionReport(
      erasedPreAuditJournal,
    )).toThrow(/interrupted-original accounting profile is invalid/i);

    const understated = structuredClone(report);
    understated.recovery_invocation_mutation_accounting =
      sealStage1EvidenceSchemaUpgradeMutationAccounting({
        operation: "reviewed_exact_transaction_recovery",
        lowerBoundCounts: zeroStage1EvidenceSchemaUpgradeMutationCounts(),
        unknownWriteCategories: [],
        evidence: {
          boundary: "active_journal_recovery_unresolved_result",
          mutation_scope: "current_recovery_invocation_only",
          response_loss_possible: false,
        },
      });
    understated.journal_archive_persistence = {
      ...understated.journal_archive_persistence,
      state: "not_started",
      archive_write_acknowledged: false,
      archive_readback_verified: false,
      active_removal_verified: false,
      response_loss_possible: false,
      evidence_source: "reviewed_recovery_read_only_inspection",
      commit_archive_accounting: null,
      local_journal_archive_writes_lower_bound: 0,
    };
    resealArchiveEvidence(understated.journal_archive_persistence);
    understated.mutation_performed = false;
    understated.response_loss_possible = false;
    resealReport(understated);
    expect(() => assertStage1EvidenceSchemaUpgradeReviewedRecoveryExecutionReport(
      understated,
    )).toThrow(/journal persistence evidence is missing|understates write uncertainty/i);

    const forgedActionProfile = structuredClone(report);
    forgedActionProfile.recovery_invocation_mutation_accounting =
      sealStage1EvidenceSchemaUpgradeMutationAccounting({
        operation: "attacker_operation",
        lowerBoundCounts:
          report.recovery_invocation_mutation_accounting.lower_bound_counts,
        unknownWriteCategories:
          report.recovery_invocation_mutation_accounting.unknown_write_categories,
        evidence: report.recovery_invocation_mutation_accounting.evidence,
      });
    resealReport(forgedActionProfile);
    expect(() => assertStage1EvidenceSchemaUpgradeReviewedRecoveryExecutionReport(
      forgedActionProfile,
    )).toThrow(/action accounting profile is invalid/i);

    const forgedInspectionProfile = structuredClone(report);
    forgedInspectionProfile.disposition = "inspect_active_ambiguous_leave_running";
    forgedInspectionProfile.reviewed_expected_disposition =
      "inspect_active_ambiguous_leave_running";
    forgedInspectionProfile.recovery_invocation_mutation_accounting =
      sealStage1EvidenceSchemaUpgradeMutationAccounting({
        operation: "attacker_operation",
        lowerBoundCounts: zeroStage1EvidenceSchemaUpgradeMutationCounts(),
        unknownWriteCategories: [],
        evidence: {
          boundary: "attacker_boundary",
          mutation_scope: "current_recovery_invocation_only",
          response_loss_possible: false,
        },
      });
    Object.assign(forgedInspectionProfile.journal_archive_persistence, {
      state: "ambiguous",
      archive_write_acknowledged: false,
      archive_readback_verified: false,
      active_removal_verified: false,
      response_loss_possible: false,
      evidence_source: "reviewed_recovery_read_only_inspection",
      commit_archive_accounting: null,
      local_journal_archive_writes_lower_bound: 0,
    });
    resealArchiveEvidence(forgedInspectionProfile.journal_archive_persistence);
    forgedInspectionProfile.mutation_performed = false;
    forgedInspectionProfile.response_loss_possible = false;
    resealReport(forgedInspectionProfile);
    expect(() => assertStage1EvidenceSchemaUpgradeReviewedRecoveryExecutionReport(
      forgedInspectionProfile,
    )).toThrow(/inspection-only recovery report claims/i);

    const falseCompletedInspection = structuredClone(forgedInspectionProfile);
    falseCompletedInspection.recovery_invocation_mutation_accounting =
      sealStage1EvidenceSchemaUpgradeMutationAccounting({
        operation: "reviewed_exact_transaction_recovery",
        lowerBoundCounts: zeroStage1EvidenceSchemaUpgradeMutationCounts(),
        unknownWriteCategories: [],
        evidence: {
          boundary: "reviewed_recovery_inspection_only",
          mutation_scope: "current_recovery_invocation_only",
          response_loss_possible: false,
        },
      });
    Object.assign(falseCompletedInspection.journal_archive_persistence, {
      state: "completed_verified",
      archive_write_acknowledged: true,
      archive_readback_verified: true,
      active_removal_verified: true,
      response_loss_possible: false,
      evidence_source: "reviewed_recovery_read_only_inspection",
      commit_archive_accounting: null,
      local_journal_archive_writes_lower_bound: 0,
    });
    resealArchiveEvidence(falseCompletedInspection.journal_archive_persistence);
    resealReport(falseCompletedInspection);
    expect(() => assertStage1EvidenceSchemaUpgradeReviewedRecoveryExecutionReport(
      falseCompletedInspection,
    )).toThrow(/inspection-only recovery report claims/i);
  });

  it("preserves cumulative journal-write lower bounds on final response loss", async () => {
    const fixture = await fixtureState();
    const completed = journalAtPhase(fixture, "completed");
    fixture.journals = { active: completed, archived: null };
    fixture.current = currentSnapshot(fixture, {
      baselineBytes: candidateBaseline,
      pointer: completed.candidate_pointer_identity.projection,
      source: liveSourceHealthSucceeded(),
    });
    const harness = await executionHarness(fixture, {
      recoverActiveJournal: async () => {
        const result = commitResult({
          journal: completed,
          status: "upgraded",
          completedReplay: true,
        });
        resealCommitAccountingEvidence(result, {
          ...result.mutation_accounting.evidence,
          response_loss_possible: true,
          journal_persistence: {
            state: "write_response_unknown",
            local_journal_writes_lower_bound: 3,
            response_loss_possible: true,
          },
        });
        return result;
      },
    });
    const report = await harness.run();
    expect(report).toMatchObject({
      status: "recovery_required",
      response_loss_possible: true,
      mutation_performed: true,
      recovery_invocation_mutation_accounting: {
        evidence: {
          journal_persistence: {
            state: "write_response_unknown",
            local_journal_writes_lower_bound: 3,
            response_loss_possible: true,
          },
        },
      },
    });
  });

  it("rejects malformed and cross-outcome commit responses without terminalizing", async () => {
    const fixture = await fixtureState();
    const active = journalAtPhase(fixture, "prepared");
    fixture.journals = { active, archived: null };
    const harness = await executionHarness(fixture, {
      recoverActiveJournal: async () => ({
        ...commitResult({ journal: journalAbandonedOld(fixture), status: "abandoned_old_authority" }),
        smuggled_candidate: true,
      }),
    });
    const malformed = await harness.run();
    expect(malformed.disposition).toBe("active_recovery_result_or_receipt_invalid");
    expect(malformed.recovery_invocation_mutation_accounting).toMatchObject({
      exact: false,
      unknown_write_categories: [
        "database_writes",
        "local_baseline_writes",
        "source_state_writes",
      ],
    });
    expect(malformed.mutation_performed).toBe(true);
    expect(fixture.audit.row_kind).toBe("running");

    const raced = await fixtureState();
    const racedActive = journalAtPhase(raced, "prepared");
    const candidateCompleted = journalAtPhase(raced, "completed");
    raced.journals = { active: racedActive, archived: null };
    const racedHarness = await executionHarness(raced, {
      recoverActiveJournal: async () => {
        raced.journals = { active: null, archived: candidateCompleted };
        raced.current = currentSnapshot(raced, {
          baselineBytes: candidateBaseline,
          pointer: candidateCompleted.candidate_pointer_identity.projection,
          source: liveSourceHealthSucceeded(),
        });
        return commitResult({ journal: candidateCompleted, status: "upgraded" });
      },
    });
    const crossOutcome = await racedHarness.run();
    expect(crossOutcome.disposition)
      .toBe("active_recovery_crossed_unreviewed_authority_outcome");
    expect(raced.audit.row_kind).toBe("running");
  });

  it("finishes exact dual-copy cleanup before terminal replay", async () => {
    const fixture = await fixtureState();
    const completed = journalAtPhase(fixture, "completed");
    fixture.journals = { active: completed, archived: structuredClone(completed) };
    fixture.current = currentSnapshot(fixture, {
      baselineBytes: candidateBaseline,
      pointer: completed.candidate_pointer_identity.projection,
      source: liveSourceHealthSucceeded(),
    });
    await terminalizeAudit(fixture, { status: "succeeded", journal: completed });
    const harness = await executionHarness(fixture, {
      recoverActiveJournal: async () => {
        fixture.journals = { active: null, archived: completed };
        return commitResult({
          journal: completed,
          status: "upgraded",
          completedReplay: true,
        });
      },
    });
    const report = await harness.run();
    expect(report.disposition).toBe("terminal_success_report_replay");
    expect(report.journal_archive_persistence.local_journal_archive_writes_lower_bound)
      .toBe(1);
    expect(report.recovery_start_journal).toEqual(completed);
    expect(report.recovery_completed_journal).toEqual(completed);
    expect(report.recovery_start_journal_location).toBe("active");
    expect(report.reviewed_reconciliation_evidence).toEqual(
      buildStage1EvidenceSchemaUpgradeReviewedReconciliationEvidence({
        sourceId: completed.source_id,
        transactionId: completed.transaction_id,
        journalSha256: completed.journal_sha256,
        oldPointerIdentity: completed.old_pointer_identity,
        candidatePointerIdentity: completed.candidate_pointer_identity,
        candidateObjectKeys: completed.candidate_object_keys,
      }),
    );
    expect(harness.calls.finishOriginalAudit).not.toHaveBeenCalled();
  });

  it("recovers an audit-finish response loss by exact terminal readback", async () => {
    const harness = await executionHarness(undefined, {
      finishOriginalAudit: async (request, state) => {
        await finishAuditRequest(request, state);
        throw new Error("terminal response lost");
      },
    });
    const report = await harness.run();
    expect(report).toMatchObject({
      status: "failed",
      disposition: "audit_failed_verified_after_response_loss",
      response_loss_possible: true,
      audit_mutation_accounting: {
        exact: false,
        unknown_write_categories: ["local_worker_run_terminal_updates"],
      },
    });
  });

  it("preserves the historical terminal time on an exact audit-finish race replay", async () => {
    const harness = await executionHarness(undefined, {
      finishOriginalAudit: async (request, state) => {
        await finishAuditRequest({
          ...request,
          finished_at: "2026-08-20T11:29:00.000Z",
        }, state);
        return finishAuditRequest(request, state);
      },
    });
    const report = await harness.run();
    expect(report).toMatchObject({
      status: "failed",
      disposition: "terminal_failed_report_replay_after_finish_race",
      audit_receipt: { replay: true },
      audit_terminal: { finished_at: "2026-08-20T11:29:00.000Z" },
      audit_finish_attempt: { finished_at: "2026-08-20T11:30:00.000Z" },
    });
    expect(() => assertStage1EvidenceSchemaUpgradeReviewedRecoveryExecutionReport(
      report,
    )).not.toThrow();
  });

  it("treats a missing or wrong-plan finish receipt as response loss after exact readback", async () => {
    const missing = await executionHarness(undefined, {
      finishOriginalAudit: async (request, state) => {
        await finishAuditRequest(request, state);
        return null;
      },
    });
    const missingReport = await missing.run();
    expect(missingReport).toMatchObject({
      status: "failed",
      disposition: "audit_failed_verified_after_response_loss",
      response_loss_possible: true,
      audit_mutation_accounting: { exact: false },
    });
    expect(() => assertStage1EvidenceSchemaUpgradeReviewedRecoveryExecutionReport(
      missingReport,
    )).not.toThrow();

    const wrong = await executionHarness(undefined, {
      finishOriginalAudit: async (request, state) => {
        const receipt = await finishAuditRequest(request, state);
        const content = structuredClone(receipt);
        delete content.receipt_sha256;
        content.plan_file_sha256 = "f".repeat(64);
        return { ...content, receipt_sha256: sha256(canonicalJson(content)) };
      },
    });
    const wrongReport = await wrong.run();
    expect(wrongReport.disposition)
      .toBe("audit_failed_verified_after_response_loss");
    expect(wrongReport.audit_mutation_accounting.unknown_write_categories)
      .toEqual(["local_worker_run_terminal_updates"]);
    expect(() => assertStage1EvidenceSchemaUpgradeReviewedRecoveryExecutionReport(
      wrongReport,
    )).not.toThrow();
  });

  it("preserves a valid finish receipt when the mandatory post-finish read is unavailable", async () => {
    const harness = await executionHarness(undefined, {
      readRecoveryEvidence: async (_request, state) => {
        if (state.audit.row_kind !== "running") {
          throw new Error("post-finish evidence unavailable");
        }
        return {
          auditInspection: state.audit,
          journals: state.journals,
          currentAuthoritySnapshot: state.current,
        };
      },
    });
    const report = await harness.run();
    expect(report).toMatchObject({
      status: "recovery_required",
      disposition: "audit_finished_post_state_unobserved",
      audit_after_inspection_observation: "pre_finish_fallback_after_read_failure",
      response_loss_possible: true,
      audit_receipt: {
        action: "finish",
        disposition: "finished",
      },
    });
    expect(report.audit_terminal).toBeNull();
    expect(() => assertStage1EvidenceSchemaUpgradeReviewedRecoveryExecutionReport(
      report,
    )).not.toThrow();
  });

  it("rechecks full live authority immediately before and after audit finish", async () => {
    const beforeFixture = await fixtureState();
    const completed = journalAtPhase(beforeFixture, "completed");
    beforeFixture.journals = { active: null, archived: completed };
    beforeFixture.current = currentSnapshot(beforeFixture, {
      baselineBytes: candidateBaseline,
      pointer: completed.candidate_pointer_identity.projection,
      source: liveSourceHealthSucceeded(),
    });
    let reads = 0;
    const before = await executionHarness(beforeFixture, {
      readRecoveryEvidence: async (_request, state) => {
        reads += 1;
        if (reads === 3) {
          state.current = {
            ...state.current,
            currentSource: {
              ...state.current.currentSource,
              url: "https://unauthorized.example.test/drift",
            },
          };
        }
        return {
          auditInspection: state.audit,
          journals: state.journals,
          currentAuthoritySnapshot: state.current,
        };
      },
    });
    const beforeReport = await before.run();
    expect(beforeReport.disposition)
      .toBe("business_authority_drift_before_audit_finish");
    expect(before.calls.finishOriginalAudit).not.toHaveBeenCalled();
    expect(beforeFixture.audit.row_kind).toBe("running");

    const afterFixture = await fixtureState();
    const afterCompleted = journalAtPhase(afterFixture, "completed");
    afterFixture.journals = { active: null, archived: afterCompleted };
    afterFixture.current = currentSnapshot(afterFixture, {
      baselineBytes: candidateBaseline,
      pointer: afterCompleted.candidate_pointer_identity.projection,
      source: liveSourceHealthSucceeded(),
    });
    const after = await executionHarness(afterFixture, {
      finishOriginalAudit: async (request, state) => {
        const receipt = await finishAuditRequest(request, state);
        state.current = {
          ...state.current,
          currentSource: {
            ...state.current.currentSource,
            title: "unauthorized post-finish drift",
          },
        };
        return receipt;
      },
    });
    const afterReport = await after.run();
    expect(afterReport).toMatchObject({
      status: "recovery_required",
      disposition: "audit_finish_terminal_unverified",
    });
    expect(() => assertStage1EvidenceSchemaUpgradeReviewedRecoveryExecutionReport(
      afterReport,
    )).not.toThrow();
  });

  it("refuses audit finish when old-authority R2 proof drifts after recovery", async () => {
    const fixture = await fixtureState();
    const active = journalAtPhase(fixture, "prepared");
    fixture.journals = { active, archived: null };
    const completed = journalAbandonedOld(fixture);
    const harness = await executionHarness(fixture, {
      recoverActiveJournal: async () => {
        fixture.journals = { active: null, archived: completed };
        const forgedReceipt = structuredClone(fixture.current.r2BindingReceipt);
        forgedReceipt.limitations = [
          ...forgedReceipt.limitations,
          "late_non_core_old_r2_drift",
        ].sort();
        forgedReceipt.receipt_sha256 =
          stage1EvidenceSchemaUpgradeR2BindingReceiptSha256(forgedReceipt);
        fixture.current = { ...fixture.current, r2BindingReceipt: forgedReceipt };
        return commitResult({ journal: completed, status: "abandoned_old_authority" });
      },
    });
    const report = await harness.run();
    expect(report.status).toBe("recovery_required");
    expect(harness.calls.finishOriginalAudit).not.toHaveBeenCalled();
    expect(fixture.audit.row_kind).toBe("running");
  });

  it("rejects nested commit receipt contradictions without finishing audit", async () => {
    const fixture = await fixtureState();
    const completed = journalAtPhase(fixture, "completed");
    fixture.journals = { active: completed, archived: null };
    fixture.current = currentSnapshot(fixture, {
      baselineBytes: candidateBaseline,
      pointer: completed.candidate_pointer_identity.projection,
      source: liveSourceHealthSucceeded(),
    });
    const harness = await executionHarness(fixture, {
      recoverActiveJournal: async () => {
        fixture.journals = { active: null, archived: completed };
        const result = commitResult({
          journal: completed,
          status: "upgraded",
          completedReplay: true,
        });
        result.receipt.cleanup_debt.delete_performed = true;
        return result;
      },
    });
    const report = await harness.run();
    expect(report.disposition).toBe("active_recovery_result_or_receipt_invalid");
    expect(fixture.audit.row_kind).toBe("running");

    const r2Fixture = await fixtureState();
    const r2Completed = journalAtPhase(r2Fixture, "completed");
    r2Fixture.journals = { active: r2Completed, archived: null };
    r2Fixture.current = currentSnapshot(r2Fixture, {
      baselineBytes: candidateBaseline,
      pointer: r2Completed.candidate_pointer_identity.projection,
      source: liveSourceHealthSucceeded(),
    });
    const r2Harness = await executionHarness(r2Fixture, {
      recoverActiveJournal: async () => {
        r2Fixture.journals = { active: null, archived: r2Completed };
        const result = commitResult({
          journal: r2Completed,
          status: "upgraded",
          completedReplay: true,
        });
        resealCommitCounts(result, { r2_writes: 7 });
        return result;
      },
    });
    expect((await r2Harness.run()).disposition)
      .toBe("active_recovery_result_or_receipt_invalid");

    const debtFixture = await fixtureState();
    const debtCompleted = journalAtPhase(debtFixture, "completed");
    debtFixture.journals = { active: debtCompleted, archived: null };
    debtFixture.current = currentSnapshot(debtFixture, {
      baselineBytes: candidateBaseline,
      pointer: debtCompleted.candidate_pointer_identity.projection,
      source: liveSourceHealthSucceeded(),
    });
    const debtHarness = await executionHarness(debtFixture, {
      recoverActiveJournal: async () => {
        debtFixture.journals = { active: null, archived: debtCompleted };
        const result = commitResult({
          journal: debtCompleted,
          status: "upgraded",
          completedReplay: true,
        });
        result.receipt.cleanup_debt.candidate_keys = ["attacker/forged-object"];
        result.receipt.cleanup_debt.item_count = 1;
        return result;
      },
    });
    expect((await debtHarness.run()).disposition)
      .toBe("active_recovery_result_or_receipt_invalid");

    const healthFixture = await fixtureState();
    const healthActive = journalAtPhase(healthFixture, "pointer_candidate_committed");
    const healthCompleted = journalAtPhase(healthFixture, "completed");
    healthFixture.journals = { active: healthActive, archived: null };
    healthFixture.current = currentSnapshot(healthFixture, {
      baselineBytes: candidateBaseline,
      pointer: healthActive.candidate_pointer_identity.projection,
      source: liveSourceHealthSucceeded(),
    });
    const healthHarness = await executionHarness(healthFixture, {
      recoverActiveJournal: async () => {
        healthFixture.journals = { active: null, archived: healthCompleted };
        const result = commitResult({ journal: healthCompleted, status: "upgraded" });
        resealCommitCounts(result, { database_writes: 1, source_state_writes: 1 });
        result.receipt.source_health.mutation_counts =
          zeroStage1EvidenceSchemaUpgradeMutationCounts();
        return result;
      },
    });
    expect((await healthHarness.run()).disposition)
      .toBe("active_recovery_result_or_receipt_invalid");
  });

  it("returns only the callback's sealed report across lock result smuggling or release loss", async () => {
    const smuggled = await executionHarness(undefined, {
      withSourceLock: async ({ execute }) => {
        await execute();
        return { status: "forged" };
      },
    });
    const actual = await smuggled.run();
    expect(actual.schema_version)
      .toBe(STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_RECOVERY_EXECUTION_REPORT_SCHEMA);
    expect(actual.status).toBe("failed");

    const lost = await executionHarness(undefined, {
      withSourceLock: async ({ execute }) => {
        await execute();
        throw new Error("lock release response lost");
      },
    });
    const lostReport = await lost.run();
    expect(lostReport).toMatchObject({
      status: "failed",
      source_lock_response_loss_possible: true,
      response_loss_possible: true,
    });
    expect(lostReport.disposition).toMatch(/source_lock_release_response_lost$/);
  });

  it("revalidates expiry under the source lock immediately before mutation", async () => {
    const fixture = await fixtureState();
    const active = journalAtPhase(fixture, "prepared");
    fixture.journals = { active, archived: null };
    const times = [
      "2026-08-20T11:30:00.000Z",
      "2026-08-20T13:00:00.000Z",
    ];
    const harness = await executionHarness(fixture, {}, () => times.shift()
      || "2026-08-20T13:00:00.000Z");
    await expect(harness.run()).rejects.toThrow(/bounded review window/i);
    expect(harness.calls.recoverActiveJournal).not.toHaveBeenCalled();
    expect(fixture.audit.row_kind).toBe("running");
  });

  it("rejects an injected adapter clock rollback on its first evidence read", async () => {
    const fixture = await fixtureState();
    const times = [
      "2026-08-20T11:30:00.000Z",
      "2026-08-20T11:29:00.000Z",
    ];
    const harness = await executionHarness(fixture, {}, () => times.shift()
      || "2026-08-20T11:29:00.000Z");
    await expect(harness.run()).rejects.toThrow(/clock moved backward/i);
    expect(harness.calls.recoverActiveJournal).not.toHaveBeenCalled();
    expect(harness.calls.finishOriginalAudit).not.toHaveBeenCalled();
    expect(fixture.audit.row_kind).toBe("running");
  });

  it("rejects any extra capture/upload/CAS/quarantine authority", async () => {
    const harness = await executionHarness();
    await expect(harness.run({ captureDryRun: vi.fn() }))
      .rejects.toThrow(/forbids additional interface authority/i);
    expect(harness.calls.withSourceLock).not.toHaveBeenCalled();
  });

  it("rejects a coherently resealed contradictory terminal report", async () => {
    const harness = await executionHarness();
    const original = await harness.run();
    const contradictory = structuredClone(original);
    contradictory.status = "succeeded";
    resealReport(contradictory);
    expect(() => assertStage1EvidenceSchemaUpgradeReviewedRecoveryExecutionReport(
      contradictory,
    ))
      .toThrow(/terminal status differs|contradictory terminal|not bound to its terminal/i);

    const samePlanHistoricalReplay = structuredClone(original);
    samePlanHistoricalReplay.disposition = "terminal_failure_report_replay";
    samePlanHistoricalReplay.reviewed_expected_disposition =
      "report_replay_failed_before_journal";
    samePlanHistoricalReplay.audit_receipt = null;
    samePlanHistoricalReplay.audit_finish_attempt = null;
    samePlanHistoricalReplay.audit_finish_evidence = null;
    samePlanHistoricalReplay.audit_finish_authority = null;
    samePlanHistoricalReplay.audit_after_inspection_observation = "current_evidence";
    samePlanHistoricalReplay.audit_mutation_accounting = zeroAuditAccounting(
      "not_observed_by_audit_callback",
    );
    samePlanHistoricalReplay.recovery_invocation_mutation_accounting =
      sealStage1EvidenceSchemaUpgradeMutationAccounting({
        operation: "reviewed_exact_transaction_recovery",
        lowerBoundCounts: zeroStage1EvidenceSchemaUpgradeMutationCounts(),
        unknownWriteCategories: [],
        evidence: {
          boundary: "terminal_report_replay_read_only",
          mutation_scope: "current_recovery_invocation_only",
          response_loss_possible: false,
        },
      });
    samePlanHistoricalReplay.mutation_performed = false;
    samePlanHistoricalReplay.response_loss_possible = false;
    resealReport(samePlanHistoricalReplay);
    expect(() => assertStage1EvidenceSchemaUpgradeReviewedRecoveryExecutionReport(
      samePlanHistoricalReplay,
    )).toThrow(/not a distinct prior plan/i);

    const droppedReceipt = structuredClone(original);
    droppedReceipt.audit_receipt = null;
    droppedReceipt.audit_mutation_accounting = zeroAuditAccounting("terminal_failed");
    droppedReceipt.mutation_performed = false;
    droppedReceipt.response_loss_possible = false;
    resealReport(droppedReceipt);
    expect(() => assertStage1EvidenceSchemaUpgradeReviewedRecoveryExecutionReport(
      droppedReceipt,
    )).toThrow(/lacks its exact audit receipt/i);

    for (const mutate of [
      (report) => {
        report.audit_receipt.requested_execution_nonce =
          "22222222-2222-4222-8222-222222222222";
      },
      (report) => {
        report.audit_receipt.run_id =
          "22222222-2222-5222-8222-222222222222";
      },
    ]) {
    const wrongAuditIdentity = structuredClone(original);
      mutate(wrongAuditIdentity);
      resealAuditReceipt(wrongAuditIdentity.audit_receipt);
      resealReport(wrongAuditIdentity);
      expect(() => assertStage1EvidenceSchemaUpgradeReviewedRecoveryExecutionReport(
        wrongAuditIdentity,
      )).toThrow(/audit finish receipt is not exact/i);
    }

    const wrongFreshBinding = structuredClone(original);
    wrongFreshBinding.audit_receipt.fresh_capture_result_sha256 = "f".repeat(64);
    resealAuditReceipt(wrongFreshBinding.audit_receipt);
    resealReport(wrongFreshBinding);
    expect(() => assertStage1EvidenceSchemaUpgradeReviewedRecoveryExecutionReport(
      wrongFreshBinding,
    )).toThrow(/audit finish receipt is not exact/i);

    const zeroedFinishedAccounting = structuredClone(original);
    const zeroed = structuredClone(zeroedFinishedAccounting.audit_mutation_accounting);
    zeroed.lower_bound_counts.local_worker_run_terminal_updates = 0;
    resealAuditAccounting(zeroed);
    zeroedFinishedAccounting.audit_mutation_accounting = zeroed;
    zeroedFinishedAccounting.audit_receipt.audit_mutation_accounting =
      structuredClone(zeroed);
    resealAuditReceipt(zeroedFinishedAccounting.audit_receipt);
    zeroedFinishedAccounting.mutation_performed = false;
    resealReport(zeroedFinishedAccounting);
    expect(() => assertStage1EvidenceSchemaUpgradeReviewedRecoveryExecutionReport(
      zeroedFinishedAccounting,
    )).toThrow(/audit finish receipt is not exact/i);

    const forgedFailedBusinessWrites = structuredClone(original);
    forgedFailedBusinessWrites.recovery_invocation_mutation_accounting =
      sealStage1EvidenceSchemaUpgradeMutationAccounting({
        operation: "reviewed_exact_transaction_recovery",
        lowerBoundCounts: {
          ...zeroStage1EvidenceSchemaUpgradeMutationCounts(),
          local_baseline_writes: 1,
        },
        unknownWriteCategories: [],
        evidence: {
          boundary: "reviewed_recovery_inspection_only",
          mutation_scope: "current_recovery_invocation_only",
          response_loss_possible: false,
        },
      });
    forgedFailedBusinessWrites.mutation_performed = true;
    resealReport(forgedFailedBusinessWrites);
    expect(() => assertStage1EvidenceSchemaUpgradeReviewedRecoveryExecutionReport(
      forgedFailedBusinessWrites,
    )).toThrow(/no-journal failed recovery accounting profile/i);

    const tamperedFinishAttempt = structuredClone(original);
    tamperedFinishAttempt.audit_finish_attempt.failure.error_summary =
      "tampered failure narrative";
    resealAuditFinishAttempt(tamperedFinishAttempt.audit_finish_attempt);
    resealReport(tamperedFinishAttempt);
    expect(() => assertStage1EvidenceSchemaUpgradeReviewedRecoveryExecutionReport(
      tamperedFinishAttempt,
    )).toThrow(/finish attempt narrative is invalid/i);

    const tamperedFinishEvidence = structuredClone(original);
    tamperedFinishEvidence.audit_finish_attempt.expected_recovery_evidence_sha256 =
      "f".repeat(64);
    resealAuditFinishAttempt(tamperedFinishEvidence.audit_finish_attempt);
    resealReport(tamperedFinishEvidence);
    expect(() => assertStage1EvidenceSchemaUpgradeReviewedRecoveryExecutionReport(
      tamperedFinishEvidence,
    )).toThrow(/finish attempt authority is invalid/i);

    const extraFinishSnapshotClaim = structuredClone(original);
    extraFinishSnapshotClaim.audit_finish_evidence.currentAuthoritySnapshot.attacker_claim =
      true;
    extraFinishSnapshotClaim.audit_finish_attempt.expected_recovery_evidence_sha256 =
      sha256(canonicalJson(extraFinishSnapshotClaim.audit_finish_evidence));
    resealAuditFinishAttempt(extraFinishSnapshotClaim.audit_finish_attempt);
    resealReport(extraFinishSnapshotClaim);
    expect(() => assertStage1EvidenceSchemaUpgradeReviewedRecoveryExecutionReport(
      extraFinishSnapshotClaim,
    )).toThrow(/current authority snapshot has unexpected or missing fields/i);

    const substitutedFinishSource = structuredClone(original);
    substitutedFinishSource.audit_finish_evidence.currentAuthoritySnapshot.currentSource.title =
      "Attacker-substituted reviewed title";
    substitutedFinishSource.audit_finish_attempt.expected_recovery_evidence_sha256 =
      sha256(canonicalJson(substitutedFinishSource.audit_finish_evidence));
    resealAuditFinishAttempt(substitutedFinishSource.audit_finish_attempt);
    resealReport(substitutedFinishSource);
    expect(() => assertStage1EvidenceSchemaUpgradeReviewedRecoveryExecutionReport(
      substitutedFinishSource,
    )).toThrow(/finish source authority is not exact/i);

    const forgedR2Role = structuredClone(original);
    const receipt =
      forgedR2Role.audit_finish_evidence.currentAuthoritySnapshot.r2BindingReceipt;
    receipt.verified_roles[0].remote_body_verified = false;
    receipt.receipt_sha256 = stage1EvidenceSchemaUpgradeR2BindingReceiptSha256(receipt);
    const authority = forgedR2Role.audit_finish_authority;
    authority.r2_binding_receipt = structuredClone(receipt);
    authority.r2_binding_receipt_sha256 = receipt.receipt_sha256;
    const authorityContent = structuredClone(authority);
    delete authorityContent.authority_projection_sha256;
    authority.authority_projection_sha256 = sha256(canonicalJson(authorityContent));
    forgedR2Role.audit_finish_attempt.expected_recovery_evidence_sha256 =
      sha256(canonicalJson(forgedR2Role.audit_finish_evidence));
    resealAuditFinishAttempt(forgedR2Role.audit_finish_attempt);
    resealReport(forgedR2Role);
    expect(() => assertStage1EvidenceSchemaUpgradeReviewedRecoveryExecutionReport(
      forgedR2Role,
    )).toThrow(/verified .* role identity is invalid/i);

    const extraAuditAccountingClaim = structuredClone(original);
    extraAuditAccountingClaim.audit_mutation_accounting.evidence.attacker_claim = true;
    resealAuditAccounting(extraAuditAccountingClaim.audit_mutation_accounting);
    extraAuditAccountingClaim.audit_receipt.audit_mutation_accounting = structuredClone(
      extraAuditAccountingClaim.audit_mutation_accounting,
    );
    resealAuditReceipt(extraAuditAccountingClaim.audit_receipt);
    resealReport(extraAuditAccountingClaim);
    expect(() => assertStage1EvidenceSchemaUpgradeReviewedRecoveryExecutionReport(
      extraAuditAccountingClaim,
    )).toThrow(/audit finish accounting evidence has unexpected or missing fields/i);

    const falseObservationProvenance = structuredClone(original);
    falseObservationProvenance.audit_after_inspection_observation = "current_evidence";
    resealReport(falseObservationProvenance);
    expect(() => assertStage1EvidenceSchemaUpgradeReviewedRecoveryExecutionReport(
      falseObservationProvenance,
    )).toThrow(/after-audit observation provenance is invalid/i);

    const freshAuthority = structuredClone(original);
    freshAuthority.audit_receipt = null;
    freshAuthority.audit_terminal.completion_authority =
      stage1EvidenceSchemaUpgradeReviewedApplyAuditFreshCompletionAuthority();
    resealAuditTerminal(freshAuthority.audit_terminal);
    resealReport(freshAuthority);
    expect(() => assertStage1EvidenceSchemaUpgradeReviewedRecoveryExecutionReport(
      freshAuthority,
    )).toThrow(/lacks reviewed-recovery completion authority/i);

    const forgedNotStarted = structuredClone(original);
    Object.assign(forgedNotStarted.journal_archive_persistence, {
      archive_write_acknowledged: true,
      archive_readback_verified: true,
      active_removal_verified: true,
      local_journal_archive_writes_lower_bound: 1,
      response_loss_possible: true,
    });
    resealArchiveEvidence(forgedNotStarted.journal_archive_persistence);
    forgedNotStarted.mutation_performed = true;
    forgedNotStarted.response_loss_possible = true;
    resealReport(forgedNotStarted);
    expect(() => assertStage1EvidenceSchemaUpgradeReviewedRecoveryExecutionReport(
      forgedNotStarted,
    )).toThrow(/not-started archive evidence claims archive activity/i);

    const arbitraryRecovery = structuredClone(original);
    arbitraryRecovery.status = "recovery_required";
    arbitraryRecovery.disposition = "arbitrary_operator_story";
    arbitraryRecovery.audit_receipt = null;
    arbitraryRecovery.audit_mutation_accounting = zeroAuditAccounting("terminal_failed");
    arbitraryRecovery.mutation_performed = false;
    arbitraryRecovery.response_loss_possible = false;
    resealReport(arbitraryRecovery);
    expect(() => assertStage1EvidenceSchemaUpgradeReviewedRecoveryExecutionReport(
      arbitraryRecovery,
    )).toThrow(/disposition\/accounting family is invalid/i);

    for (const disposition of ["inspect_attacker_story", "active_recovery_attacker_story"]) {
      const prefixedAttackerStory = structuredClone(arbitraryRecovery);
      prefixedAttackerStory.disposition = disposition;
      resealReport(prefixedAttackerStory);
      expect(() => assertStage1EvidenceSchemaUpgradeReviewedRecoveryExecutionReport(
        prefixedAttackerStory,
      )).toThrow(/disposition\/accounting family is invalid/i);
    }

    const replayWithSmuggledSelected = structuredClone(original);
    replayWithSmuggledSelected.status = "recovery_required";
    replayWithSmuggledSelected.disposition = "inspect_active_ambiguous_leave_running";
    replayWithSmuggledSelected.audit_receipt = null;
    replayWithSmuggledSelected.audit_mutation_accounting = zeroAuditAccounting(
      "terminal_failed",
    );
    replayWithSmuggledSelected.selected_result = { attacker: true };
    replayWithSmuggledSelected.mutation_performed = false;
    replayWithSmuggledSelected.response_loss_possible = false;
    resealReport(replayWithSmuggledSelected);
    expect(() => assertStage1EvidenceSchemaUpgradeReviewedRecoveryExecutionReport(
      replayWithSmuggledSelected,
    )).toThrow(/selected result and commit receipt differ/i);
  });
});

async function executionHarness(
  suppliedFixture = undefined,
  overrides = {},
  now = () => "2026-08-20T11:30:00.000Z",
) {
  const fixture = suppliedFixture || await fixtureState();
  const built = createPlan(fixture);
  const calls = {
    withSourceLock: vi.fn(async ({ execute }) => execute()),
    readRecoveryEvidence: vi.fn(async () => ({
      auditInspection: fixture.audit,
      journals: fixture.journals,
      currentAuthoritySnapshot: fixture.current,
    })),
    recoverActiveJournal: vi.fn(async () => {
      throw new Error("unexpected active recovery");
    }),
    finishOriginalAudit: vi.fn(async (request) => finishAuditRequest(request, fixture)),
  };
  for (const [key, implementation] of Object.entries(overrides)) {
    calls[key] = vi.fn((...args) => implementation(...args, fixture));
  }
  return {
    fixture,
    built,
    calls,
    run(extraInterfaces = {}) {
      return runStage1EvidenceSchemaUpgradeReviewedRecoveryExecution({
        recoveryPlanBytes: built.plan_bytes,
        expectedRecoveryPlanFileSha256: built.plan_file_sha256,
        applyPlanBytes: fixture.applyPlanBytes,
        expectedApplyPlanFileSha256: fixture.expectedApplyPlanFileSha256,
        reviewedDryRunReportBytes: fixture.reviewedDryRunReportBytes,
        manifest: fixture.manifest,
        interfaces: { ...calls, ...extraInterfaces },
        now,
      });
    },
  };
}

async function finishAuditRequest(request, fixture) {
  const receipt = await finishStage1EvidenceSchemaUpgradeReviewedApplyAudit({
    reviewedApplyPlan: fixture.apply,
    executionNonce: request.execution_nonce,
    finishedAt: request.finished_at,
    terminal: request.terminal,
    completionAuthority: request.completion_authority,
    interfaces: fixture.auditStore,
  });
  fixture.audit = await inspectStage1EvidenceSchemaUpgradeReviewedApplyAuditRecovery({
    reviewedApplyPlan: fixture.apply,
    interfaces: { readRun: fixture.auditStore.readRun },
  });
  return receipt;
}

function commitResult({
  journal,
  status,
  completedReplay = false,
  archiveState = "verified",
}) {
  const archive = archiveAccounting(archiveState);
  const accounting = commitAccounting(
    archive,
    completedReplay
      ? journalPersistence("not_started", 0, false)
      : journalPersistence("verified", 1, false),
  );
  const counts = accounting.lower_bound_counts;
  const candidate = status === "upgraded";
  const reviewedReconciliationEvidence =
    buildStage1EvidenceSchemaUpgradeReviewedReconciliationEvidence({
      sourceId: journal.source_id,
      transactionId: journal.transaction_id,
      journalSha256: journal.journal_sha256,
      oldPointerIdentity: journal.old_pointer_identity,
      candidatePointerIdentity: journal.candidate_pointer_identity,
      candidateObjectKeys: journal.candidate_object_keys,
    });
  const receipt = {
    schema_version: STAGE1_EVIDENCE_SCHEMA_UPGRADE_COMMIT_RECEIPT_SCHEMA,
    source_id: sourceId,
    context: STAGE1_EVIDENCE_SCHEMA_UPGRADE_CONTEXT,
    operation: "pointer_commit",
    status,
    creates_api_charge: false,
    transaction_id: journal.transaction_id,
    outcome: candidate
      ? completedReplay ? "candidate_authority_recovered" : "committed_candidate"
      : "abandoned_old_authority",
    journal_phase: "completed",
    journal_sha256: journal.journal_sha256,
    journal_archived: true,
    authoritative_pointer_state: candidate ? "candidate" : "old",
    authoritative_baseline_state: candidate ? "candidate" : "old",
    authoritative_pointer_sha256: candidate
      ? journal.candidate_pointer_identity.canonical_sha256
      : journal.old_pointer_identity.canonical_sha256,
    authoritative_baseline_sha256: candidate
      ? journal.candidate_baseline.sha256
      : journal.old_baseline.sha256,
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
    cleanup_debt: recoveryCleanupDebt(journal, status),
    cleanup_delete_performed: false,
    source_health: candidate
      ? completedReplay
        ? { status: "already_recorded_by_completed_journal" }
        : { status: "already_current", mutation_counts: counts }
      : null,
    mutation_count_scope: "confirmed_io_receipts_in_this_invocation",
    mutation_counts: counts,
    mutation_accounting: accounting,
  };
  return {
    status,
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
  };
}

function recoveryCleanupDebt(journal, status) {
  const candidate = status === "upgraded";
  const debt = planLatestOnlyVisualSnapshotPointerReconciliation({
    existing: journal.old_pointer_identity.projection,
    candidate: journal.candidate_pointer_identity.projection,
    current: candidate
      ? journal.candidate_pointer_identity.projection
      : journal.old_pointer_identity.projection,
    outcome: candidate ? "ambiguous_error" : "cas_lost",
    uploadedKeys: journal.candidate_object_keys,
  }).cleanup_debt;
  expect(debt.schema_version).toBe(VISUAL_SNAPSHOT_LATEST_ONLY_CLEANUP_DEBT_SCHEMA);
  return structuredClone(debt);
}

function commitAccounting(
  journalArchive,
  journalPersistenceEvidence = journalPersistence("verified", 1, false),
) {
  return sealStage1EvidenceSchemaUpgradeMutationAccounting({
    operation: "pointer_commit",
    lowerBoundCounts: zeroStage1EvidenceSchemaUpgradeMutationCounts(),
    unknownWriteCategories: [],
    evidence: {
      boundary: "completed_journal_archive",
      journal_phase: "completed",
      response_loss_possible: journalArchive.response_loss_possible,
      journal_persistence: journalPersistenceEvidence,
      journal_archive: journalArchive,
    },
  });
}

function journalPersistence(state, localJournalWritesLowerBound, responseLossPossible) {
  return {
    state,
    local_journal_writes_lower_bound: localJournalWritesLowerBound,
    response_loss_possible: responseLossPossible,
  };
}

function resealCommitCounts(result, overrides) {
  const counts = { ...result.mutation_counts, ...overrides };
  const accounting = sealStage1EvidenceSchemaUpgradeMutationAccounting({
    operation: "pointer_commit",
    lowerBoundCounts: counts,
    unknownWriteCategories: [],
    evidence: result.mutation_accounting.evidence,
  });
  result.mutation_counts = counts;
  result.mutation_accounting = accounting;
  result.mutation_count_certainty = {
    exact: true,
    count_semantics: "exact",
    unknown_write_categories: [],
  };
  result.receipt.mutation_counts = counts;
  result.receipt.mutation_accounting = accounting;
}

function resealCommitAccountingEvidence(result, evidence) {
  const accounting = sealStage1EvidenceSchemaUpgradeMutationAccounting({
    operation: "pointer_commit",
    lowerBoundCounts: result.mutation_counts,
    unknownWriteCategories: result.mutation_count_certainty.unknown_write_categories,
    evidence,
  });
  result.mutation_accounting = accounting;
  result.receipt.mutation_accounting = accounting;
}

function archiveAccounting(state) {
  const verified = state === "verified";
  const acknowledged = verified || state !== "archive_write_response_unknown";
  const readback = verified || state.startsWith("archived_readback_verified");
  const activeAbsent = verified;
  const content = {
    schema_version: STAGE1_EVIDENCE_SCHEMA_UPGRADE_JOURNAL_ARCHIVE_ACCOUNTING_SCHEMA,
    state,
    local_journal_archive_writes_lower_bound: acknowledged ? 1 : 0,
    archive_receipt_acknowledged: acknowledged,
    archived_readback_verified: readback,
    active_absence_verified: activeAbsent,
    response_loss_possible: !verified,
  };
  return {
    ...content,
    evidence_sha256: sha256(canonicalJson(content)),
  };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

function zeroAuditAccounting(observedRowStatus) {
  const content = {
    schema_version:
      "awardping.stage1.evidence-schema-upgrade-reviewed-apply-audit-accounting.v1",
    count_scope: "local_worker_runs_writes_in_this_orchestration_invocation",
    count_semantics: "confirmed_lower_bounds",
    exact: true,
    lower_bound_counts: {
      local_worker_run_inserts: 0,
      local_worker_run_terminal_updates: 0,
    },
    unknown_write_categories: [],
    evidence: {
      action: "none",
      disposition: "not_called",
      response_loss_possible: false,
      observed_row_status: observedRowStatus,
    },
  };
  return { ...content, accounting_sha256: sha256(canonicalJson(content)) };
}

function resealAuditTerminal(terminal) {
  const content = structuredClone(terminal);
  delete content.terminal_sha256;
  terminal.terminal_sha256 = sha256(canonicalJson(content));
}

function resealAuditAccounting(accounting) {
  const content = structuredClone(accounting);
  delete content.accounting_sha256;
  accounting.accounting_sha256 = sha256(canonicalJson(content));
}

function resealAuditReceipt(receipt) {
  const content = structuredClone(receipt);
  delete content.receipt_sha256;
  receipt.receipt_sha256 = sha256(canonicalJson(content));
}

function resealAuditFinishAttempt(attempt) {
  const content = structuredClone(attempt);
  delete content.attempt_sha256;
  attempt.attempt_sha256 = sha256(canonicalJson(content));
}

function resealSucceededReportPayload(report) {
  const identity = report.audit_terminal.selected_result_commit_identity;
  identity.selected_result_sha256 = sha256(canonicalJson(report.selected_result));
  identity.commit_receipt_sha256 = sha256(canonicalJson(report.commit_receipt));
  identity.commit_journal_sha256 = report.commit_receipt.journal_sha256;
  identity.commit_mutation_accounting_sha256 =
    report.commit_receipt.mutation_accounting.accounting_sha256;
  const identityContent = structuredClone(identity);
  delete identityContent.identity_sha256;
  identity.identity_sha256 = sha256(canonicalJson(identityContent));
  resealAuditTerminal(report.audit_terminal);
  if (report.audit_receipt) {
    report.audit_receipt.terminal_identity_sha256 = identity.identity_sha256;
    const receiptContent = structuredClone(report.audit_receipt);
    delete receiptContent.receipt_sha256;
    report.audit_receipt.receipt_sha256 = sha256(canonicalJson(receiptContent));
  }
  resealReport(report);
}

function resealArchiveEvidence(evidence) {
  const content = structuredClone(evidence);
  delete content.archive_evidence_sha256;
  evidence.archive_evidence_sha256 = sha256(canonicalJson(content));
}

function resealReport(report) {
  const content = structuredClone(report);
  delete content.report_sha256;
  report.report_sha256 = sha256(canonicalJson(content));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
