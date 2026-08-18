import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUEUE_CONTEXT,
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_REPORT_SCHEMA,
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_RESULT_SCHEMA,
  stage1EvidenceSchemaUpgradeExpectedManifest,
} from "./stage1-evidence-schema-upgrade.mjs";
import {
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_R2_BINDING_SCHEMA,
  stage1EvidenceSchemaUpgradeR2BindingReceiptSha256,
  verifyStage1EvidenceSchemaUpgradeR2Binding,
} from "./stage1-evidence-schema-upgrade-r2-binding.mjs";
import { prepareR2CaptureArtifacts } from "./r2-capture-artifact-bindings.mjs";
import {
  createStage1EvidenceSchemaUpgradeReviewedApplyPlan,
} from "./stage1-evidence-schema-upgrade-reviewed-apply-plan.mjs";
import {
  finishStage1EvidenceSchemaUpgradeReviewedApplyAudit,
  inspectStage1EvidenceSchemaUpgradeReviewedApplyAuditRecovery,
  stage1EvidenceSchemaUpgradeReviewedApplyAuthorityReceipt,
  stage1EvidenceSchemaUpgradeReviewedApplyAuditFreshCompletionAuthority,
  stage1EvidenceSchemaUpgradeReviewedApplyAuditRecoveryCompletionAuthority,
  startStage1EvidenceSchemaUpgradeReviewedApplyAudit,
} from "./stage1-evidence-schema-upgrade-reviewed-apply-audit.mjs";
import {
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_COMMIT_RECEIPT_SCHEMA,
} from "./stage1-evidence-schema-upgrade-commit.mjs";
import {
  sealStage1EvidenceSchemaUpgradeMutationAccounting,
  zeroStage1EvidenceSchemaUpgradeMutationCounts,
} from "./stage1-evidence-schema-upgrade-mutation-accounting.mjs";
import {
  stage1EvidenceSchemaUpgradeReviewedApplyTransactionId,
} from "./stage1-evidence-schema-upgrade-reviewed-apply-execution.mjs";
import {
  advanceStage1EvidenceSchemaUpgradeJournal,
  buildStage1EvidenceSchemaUpgradeJournal,
  buildStage1EvidenceSchemaUpgradeReviewedOperationBinding,
} from "./stage1-evidence-schema-upgrade-transaction.mjs";
import {
  buildLatestOnlyVisualSnapshotPointerReplacement,
  visualSnapshotPointerIdentity,
} from "./visual-snapshot-latest-only-reconciliation.mjs";
import {
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_RECOVERY_PLAN_SCHEMA,
  createStage1EvidenceSchemaUpgradeReviewedRecoveryPlan,
  createStage1EvidenceSchemaUpgradeReviewedRecoveryPlanDraft,
  stage1EvidenceSchemaUpgradeReviewedRecoveryFailureTerminalForDisposition,
  validateStage1EvidenceSchemaUpgradeReviewedRecoveryPlan,
} from "./stage1-evidence-schema-upgrade-reviewed-recovery-plan.mjs";

const manifest = stage1EvidenceSchemaUpgradeExpectedManifest();
export const sourceId = "2ea41875-5c88-5794-81b3-afa8ddaf31c1";
export const executionNonce = "11111111-1111-4111-8111-111111111111";
const oldGenerationFixture = recoveryRuntimeGenerationFixture({
  label: "old",
  capturedAt: "2026-08-14T18:00:00.000Z",
  generation: "a".repeat(32),
});
const candidateGenerationFixture = recoveryRuntimeGenerationFixture({
  label: "candidate",
  capturedAt: "2026-08-20T10:00:00.000Z",
  generation: "b".repeat(32),
});
const otherGenerationFixture = recoveryRuntimeGenerationFixture({
  label: "other",
  capturedAt: "2026-08-20T12:00:00.000Z",
  generation: "c".repeat(32),
});
export const oldBaseline = Buffer.from(JSON.stringify(oldGenerationFixture.baseline));
export const candidateBaseline = Buffer.from(JSON.stringify(
  candidateGenerationFixture.baseline,
));

describe("reviewed exact-transaction recovery plan", () => {
  it("accepts an expired parent plan only as raw historical evidence under a fresh review", async () => {
    const fixture = await fixtureState();
    const built = createPlan(fixture);

    expect(built.checked).toMatchObject({
      valid: true,
      schema_version:
        STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_RECOVERY_PLAN_SCHEMA,
      selected_source_id: sourceId,
      expected_disposition: "finish_failed_audit_started_before_journal",
    });
    expect(built.plan.apply.reviewer.expires_at).toBe("2026-08-16T05:00:00.000Z");
    expect(built.plan.apply).toMatchObject({
      manifest: { source_count: 9 },
      reviewed_report: { attempt_id: expect.any(String) },
      deferred_source_ids: expect.any(Array),
      selected_source: { source_id: sourceId },
    });
    expect(built.plan.audit.authority_receipt.source_authority)
      .toEqual(fixture.audit.authority_receipt.source_authority);
  });

  it("rejects an expired recovery review before authorizing mutation", async () => {
    const fixture = await fixtureState();
    const built = createPlan(fixture);
    expect(() => validatePlan(built, fixture, "2026-08-20T14:00:00.000Z"))
      .toThrow(/bounded review window/i);
  });

  it.each([
    "prepared",
    "local_candidate_written",
    "pointer_cas_attempted",
    "pointer_candidate_committed",
    "recovery_required",
    "completed",
  ])("binds the exact active %s crash phase", async (phase) => {
    const fixture = await fixtureState();
    const journal = journalAtPhase(fixture, phase);
    const current = phase === "completed"
      ? currentSnapshot(fixture, {
          baselineBytes: candidateBaseline,
          pointer: journal.candidate_pointer_identity.projection,
          source: liveSourceHealthSucceeded(),
        })
      : fixture.current;
    const built = createPlan({
      ...fixture,
      journals: { active: journal, archived: null },
      current,
    });

    expect(built.plan.journal.active).toMatchObject({
      phase,
      journal_sha256: journal.journal_sha256,
      old_baseline_identity: {
        present: true,
        sha256: sha256(oldBaseline),
        byte_length: oldBaseline.byteLength,
      },
      operation_binding_sha256: journal.operation_binding.binding_sha256,
    });
    expect(built.checked.expected_disposition).toBe(
      phase === "completed"
        ? "resume_active_candidate_authority"
        : "resume_active_old_authority",
    );
  });

  it("requires completed candidate source-health proof before success", async () => {
    const fixture = await fixtureState();
    const completed = journalAtPhase(fixture, "completed");
    const current = currentSnapshot(fixture, {
      baselineBytes: candidateBaseline,
      pointer: completed.candidate_pointer_identity.projection,
      source: liveSource(),
    });
    const active = createPlan({
      ...fixture,
      journals: { active: completed, archived: null },
      current,
    });
    expect(active.checked.expected_disposition)
      .toBe("inspect_completed_candidate_source_health_unproven_leave_running");

    const archived = createPlan({
      ...fixture,
      journals: { active: null, archived: completed },
      current,
    });
    expect(archived.checked.expected_disposition)
      .toBe("inspect_completed_candidate_source_health_unproven_leave_running");
  });

  it("requires archived old authority to retain exact precommit source health", async () => {
    const fixture = await fixtureState();
    const completed = journalAbandonedOld(fixture);
    const built = createPlan({
      ...fixture,
      journals: { active: null, archived: completed },
      current: currentSnapshot(fixture, { source: liveSourceHealthSucceeded() }),
    });
    expect(built.checked.expected_disposition)
      .toBe("inspect_completed_old_source_health_drift_leave_running");
  });

  it("requires dual active/archive copies to be exact and completes partial archival", async () => {
    const fixture = await fixtureState();
    const completed = journalAtPhase(fixture, "completed");
    const current = currentSnapshot(fixture, {
      baselineBytes: candidateBaseline,
      pointer: completed.candidate_pointer_identity.projection,
      source: liveSourceHealthSucceeded(),
    });
    const built = createPlan({
      ...fixture,
      journals: { active: completed, archived: structuredClone(completed) },
      current,
    });
    expect(built.checked.expected_disposition)
      .toBe("finish_partial_archive_then_succeed");

    const mismatched = structuredClone(completed);
    mismatched.updated_at = "2026-08-20T11:59:59.000Z";
    expect(() => createPlan({
      ...fixture,
      journals: { active: completed, archived: mismatched },
      current,
    })).toThrow();
  });

  it("binds archived candidate proof and rejects the other R2 generation", async () => {
    const fixture = await fixtureState();
    const completed = journalAtPhase(fixture, "completed");
    const candidateCurrent = currentSnapshot(fixture, {
      baselineBytes: candidateBaseline,
      pointer: completed.candidate_pointer_identity.projection,
      source: liveSourceHealthSucceeded(),
    });
    const built = createPlan({
      ...fixture,
      journals: { active: null, archived: completed },
      current: candidateCurrent,
    });
    expect(built.checked.expected_disposition)
      .toBe("finish_succeeded_from_archived_candidate");

    const wrongReceipt = r2ReceiptForPointer(oldPointer());
    expect(() => createPlan({
      ...fixture,
      journals: { active: null, archived: completed },
      current: { ...candidateCurrent, r2BindingReceipt: wrongReceipt },
    })).toThrow(/exact current pointer generation/i);
  });

  it("rejects a coherently resealed R2 role that differs from current pointer bindings", async () => {
    const fixture = await fixtureState();
    const completed = journalAtPhase(fixture, "completed");
    const candidateCurrent = currentSnapshot(fixture, {
      baselineBytes: candidateBaseline,
      pointer: completed.candidate_pointer_identity.projection,
      source: liveSourceHealthSucceeded(),
    });
    const forgedReceipt = structuredClone(candidateCurrent.r2BindingReceipt);
    forgedReceipt.verified_roles[0].sha256 = "f".repeat(64);
    forgedReceipt.receipt_sha256 =
      stage1EvidenceSchemaUpgradeR2BindingReceiptSha256(forgedReceipt);
    expect(() => createPlan({
      ...fixture,
      journals: { active: null, archived: completed },
      current: { ...candidateCurrent, r2BindingReceipt: forgedReceipt },
    })).toThrow(/differs from pointer binding/i);

    expect(() => createPlan({
      ...fixture,
      current: {
        ...fixture.current,
        currentPointer: { ...fixture.current.currentPointer, attacker_claim: true },
      },
    })).toThrow(/outside its canonical projection/i);
  });

  it("rejects active and archived old authority with a different reviewed R2 receipt", async () => {
    const fixture = await fixtureState();
    const forgedReceipt = structuredClone(fixture.current.r2BindingReceipt);
    forgedReceipt.limitations = [
      ...forgedReceipt.limitations,
      "tampered_non_core_legacy_claim",
    ].sort();
    forgedReceipt.receipt_sha256 =
      stage1EvidenceSchemaUpgradeR2BindingReceiptSha256(forgedReceipt);
    const forgedCurrent = {
      ...fixture.current,
      r2BindingReceipt: forgedReceipt,
    };
    for (const journals of [
      { active: journalAtPhase(fixture, "prepared"), archived: null },
      { active: null, archived: journalAbandonedOld(fixture) },
    ]) {
      expect(() => createPlan({ ...fixture, journals, current: forgedCurrent }))
        .toThrow(/old R2 authority differs from its exact review/i);
    }
  });

  it("replays exact terminal rows and binds dual-copy cleanup", async () => {
    const successFixture = await fixtureState();
    const completed = journalAtPhase(successFixture, "completed");
    await terminalizeAudit(successFixture, {
      status: "succeeded",
      journal: completed,
    });
    const successCurrent = currentSnapshot(successFixture, {
      baselineBytes: candidateBaseline,
      pointer: completed.candidate_pointer_identity.projection,
      source: liveSourceHealthSucceeded(),
    });
    expect(createPlan({
      ...successFixture,
      journals: { active: null, archived: completed },
      current: successCurrent,
    }).checked.expected_disposition).toBe(
      "report_replay_archived_candidate_success",
    );
    expect(createPlan({
      ...successFixture,
      journals: { active: completed, archived: structuredClone(completed) },
      current: successCurrent,
    }).checked.expected_disposition).toBe(
      "finish_partial_archive_then_replay_candidate_success",
    );
    expect(createPlan({
      ...successFixture,
      journals: { active: null, archived: completed },
      current: currentSnapshot(successFixture, {
        baselineBytes: candidateBaseline,
        pointer: completed.candidate_pointer_identity.projection,
      }),
    }).checked.expected_disposition).toBe(
      "inspect_terminal_candidate_source_health_unproven_no_report_replay",
    );

    const failedFixture = await fixtureState();
    await terminalizeAudit(failedFixture, { status: "failed" });
    expect(createPlan(failedFixture).checked.expected_disposition)
      .toBe("report_replay_failed_before_journal");
  });

  it("does not relabel a prior active-old recovery terminal as before-journal replay", async () => {
    const fixture = await fixtureState();
    const active = journalAtPhase(fixture, "prepared");
    fixture.journals = { active, archived: null };
    const authorized = createPlan(fixture);
    expect(authorized.checked.expected_disposition).toBe("resume_active_old_authority");
    const completionAuthority =
      stage1EvidenceSchemaUpgradeReviewedApplyAuditRecoveryCompletionAuthority({
        recoveryPlan: authorized.plan,
        expectedRecoveryPlanFileSha256: authorized.plan_file_sha256,
        expectedRecoveryPlanSha256: authorized.plan.plan_sha256,
        sourceId,
        transactionId: active.transaction_id,
      });
    await terminalizeAudit(fixture, {
      status: "failed",
      completionAuthority,
      failureTerminal:
        stage1EvidenceSchemaUpgradeReviewedRecoveryFailureTerminalForDisposition(
          "resume_active_old_authority",
        ),
      finishedAt: "2026-08-20T11:30:00.000Z",
    });
    expect(() => createPlan({
      ...fixture,
      journals: { active: null, archived: null },
    })).toThrow(/provenance|disposition conflicts/i);
  });

  it("replays only the exact fresh abandoned-old terminal over archived old authority", async () => {
    const fixture = await fixtureState();
    const archived = journalAbandonedOld(fixture);
    await terminalizeAudit(fixture, {
      status: "failed",
      failureTerminal: {
        status: "failed",
        error_code: "reviewed_unchanged_upgrade_old_authority_preserved",
        error_message: "Reviewed unchanged upgrade ended selected_blocked.",
      },
    });
    expect(createPlan({
      ...fixture,
      journals: { active: null, archived },
    }).checked.expected_disposition).toBe(
      "report_replay_archived_old_abandonment",
    );
  });

  it.each([
    {
      error_code: "reviewed_unchanged_upgrade_old_authority_preserved_tampered",
      error_message: "Reviewed unchanged upgrade ended selected_blocked.",
    },
    {
      error_code: "reviewed_unchanged_upgrade_old_authority_preserved",
      error_message: "Reviewed unchanged upgrade ended selected_blocked with altered text.",
    },
  ])("rejects tampered fresh archived-old terminal provenance %#", async (failure) => {
    const fixture = await fixtureState();
    await terminalizeAudit(fixture, {
      status: "failed",
      failureTerminal: { status: "failed", ...failure },
    });
    expect(() => createPlan({
      ...fixture,
      journals: { active: null, archived: journalAbandonedOld(fixture) },
    })).toThrow(/exact abandoned-old outcome/i);
  });

  it("rejects terminal status that conflicts with completed authority", async () => {
    const failedFixture = await fixtureState();
    const candidate = journalAtPhase(failedFixture, "completed");
    await terminalizeAudit(failedFixture, { status: "failed" });
    expect(() => createPlan({
      ...failedFixture,
      journals: { active: null, archived: candidate },
      current: currentSnapshot(failedFixture, {
        baselineBytes: candidateBaseline,
        pointer: candidate.candidate_pointer_identity.projection,
        source: liveSourceHealthSucceeded(),
      }),
    })).toThrow(/terminal-failed/i);

    const successFixture = await fixtureState();
    const candidateForIdentity = journalAtPhase(successFixture, "completed");
    await terminalizeAudit(successFixture, {
      status: "succeeded",
      journal: candidateForIdentity,
    });
    expect(() => createPlan({
      ...successFixture,
      journals: { active: null, archived: journalAbandonedOld(successFixture) },
      current: successFixture.current,
    })).toThrow(/terminal-success/i);
  });

  it("leaves neither-old-nor-candidate active authority inspection-only", async () => {
    const fixture = await fixtureState();
    const journal = journalAtPhase(fixture, "pointer_cas_attempted");
    const otherPointer = {
      ...oldPointer(),
      latest_captured_at: otherGenerationFixture.capturedAt,
      latest_object_keys: structuredClone(otherGenerationFixture.objectKeys),
      latest_hashes: structuredClone(otherGenerationFixture.latestHashes),
      latest_metadata: structuredClone(otherGenerationFixture.latestMetadata),
      updated_at: "2026-08-20T12:00:00.000Z",
    };
    const current = currentSnapshot(fixture, {
      baselineBytes: Buffer.from("other"),
      pointer: otherPointer,
    });
    const built = createPlan({
      ...fixture,
      journals: { active: journal, archived: null },
      current,
    });
    expect(built.checked.expected_disposition)
      .toBe("inspect_active_ambiguous_leave_running");
  });

  it("rejects a v1 or operation-mismatched reviewed journal", async () => {
    const fixture = await fixtureState();
    const reviewed = journalAtPhase(fixture, "prepared");
    const generic = buildStage1EvidenceSchemaUpgradeJournal({
      transactionId: reviewed.transaction_id,
      sourceId,
      oldBaselineBytes: oldBaseline,
      oldPointer: oldPointer(),
      candidateBaselineBytes: candidateBaseline,
      candidatePointer: candidatePointer(),
      createdAt: "2026-08-20T10:00:00.000Z",
    });
    expect(() => createPlan({
      ...fixture,
      journals: { active: generic, archived: null },
    })).toThrow(/exact reviewed v2 transaction/i);

    const mismatched = structuredClone(reviewed);
    mismatched.operation_binding.reviewed_apply_plan_sha256 = "f".repeat(64);
    expect(() => createPlan({
      ...fixture,
      journals: { active: mismatched, archived: null },
    })).toThrow();
  });

  it("revalidates parent raw bytes/report/manifest and recovery raw+self seals", async () => {
    const fixture = await fixtureState();
    const built = createPlan(fixture);
    const tamperedBytes = Buffer.from(built.plan_bytes);
    tamperedBytes[tamperedBytes.length - 2] ^= 1;
    expect(() => validatePlan({ ...built, plan_bytes: tamperedBytes }, fixture))
      .toThrow(/raw bytes|JSON/i);

    const badApplyBytes = Buffer.from(fixture.applyPlanBytes);
    badApplyBytes[20] ^= 1;
    expect(() => validateStage1EvidenceSchemaUpgradeReviewedRecoveryPlan({
      ...validationArguments(built, fixture),
      applyPlanBytes: badApplyBytes,
      now: "2026-08-20T11:30:00.000Z",
    })).toThrow(/raw bytes|JSON/i);

    const changedManifest = structuredClone(fixture.manifest);
    changedManifest.generated_at = "2026-08-15T00:00:01.000Z";
    expect(() => validateStage1EvidenceSchemaUpgradeReviewedRecoveryPlan({
      ...validationArguments(built, fixture),
      manifest: changedManifest,
      now: "2026-08-20T11:30:00.000Z",
    })).toThrow(/manifest/i);
  });
});

export async function fixtureState() {
  const reportBytes = jsonBytes(reviewedReportFixture());
  const created = createStage1EvidenceSchemaUpgradeReviewedApplyPlan({
    reportBytes,
    manifest,
    selectedSourceId: sourceId,
    reviewer: {
      reviewer_id: "original@example.test",
      reviewed_at: "2026-08-15T05:00:00.000Z",
      expires_at: "2026-08-16T05:00:00.000Z",
    },
    now: "2026-08-15T06:00:00.000Z",
  });
  const apply = created.checked;
  const selected = apply.plan.selected;
  const authorityReceipt = stage1EvidenceSchemaUpgradeReviewedApplyAuthorityReceipt({
    source: liveSource(),
    localBaselineIdentity: selected.local_baseline_identity,
    existingPointerIdentity: selected.existing_pointer_identity,
    r2BindingReceiptSha256: selected.r2.binding_receipt_sha256,
    activeJournalSha256: null,
  });
  const store = memoryAuditStore();
  await startStage1EvidenceSchemaUpgradeReviewedApplyAudit({
    reviewedApplyPlan: apply,
    executionNonce,
    startedAt: "2026-08-15T06:01:00.000Z",
    captureResult: selectedResultFromReport(reportBytes),
    authorityReceipt,
    interfaces: store,
  });
  const audit = await inspectStage1EvidenceSchemaUpgradeReviewedApplyAuditRecovery({
    reviewedApplyPlan: apply,
    interfaces: { readRun: store.readRun },
  });
  const fixture = {
    apply,
    applyPlanBytes: created.plan_bytes,
    expectedApplyPlanFileSha256: created.plan_file_sha256,
    reviewedDryRunReportBytes: reportBytes,
    manifest,
    audit,
    auditStore: store,
    journals: { active: null, archived: null },
  };
  fixture.current = currentSnapshot(fixture);
  return fixture;
}

export function createPlan(fixture) {
  const timing = fixture.recoveryReviewTiming || {};
  const evidenceObservedAt = timing.evidenceObservedAt
    || "2026-08-20T11:00:00.000Z";
  const draft = createStage1EvidenceSchemaUpgradeReviewedRecoveryPlanDraft({
    ...historicalArguments(fixture),
    auditInspection: fixture.audit,
    journals: fixture.journals,
    currentAuthoritySnapshot: fixture.current,
    evidenceObservedAt,
  });
  return createStage1EvidenceSchemaUpgradeReviewedRecoveryPlan({
    ...historicalArguments(fixture),
    auditInspection: fixture.audit,
    journals: fixture.journals,
    currentAuthoritySnapshot: fixture.current,
    evidenceObservedAt,
    inspectionBinding: {
      schema_version:
        "awardping.stage1.evidence-schema-upgrade-reviewed-recovery-inspection.v1",
      mode: "inspect_and_generate_sealed_evidence",
      inspection_file_sha256: fixtureSha256("reviewed inspection file"),
      inspection_sha256: fixtureSha256("reviewed inspection self seal"),
      proposed_plan_sha256: draft.draft_sha256,
    },
    reviewer: {
      reviewer_id: "operator@example.test",
      reviewed_at: timing.reviewedAt || "2026-08-20T11:05:00.000Z",
      expires_at: timing.expiresAt || "2026-08-20T13:00:00.000Z",
    },
    now: "2026-08-20T11:30:00.000Z",
  });
}

function validatePlan(built, fixture, now = "2026-08-20T11:30:00.000Z") {
  return validateStage1EvidenceSchemaUpgradeReviewedRecoveryPlan({
    ...validationArguments(built, fixture),
    now,
  });
}

function validationArguments(built, fixture) {
  return {
    planBytes: built.plan_bytes,
    expectedPlanFileSha256: built.plan_file_sha256,
    ...historicalArguments(fixture),
    auditInspection: fixture.audit,
    journals: fixture.journals,
    currentAuthoritySnapshot: fixture.current,
  };
}

function historicalArguments(fixture) {
  return {
    applyPlanBytes: fixture.applyPlanBytes,
    expectedApplyPlanFileSha256: fixture.expectedApplyPlanFileSha256,
    reviewedDryRunReportBytes: fixture.reviewedDryRunReportBytes,
    manifest: fixture.manifest,
  };
}

export function currentSnapshot(fixture, {
  baselineBytes = oldBaseline,
  pointer = oldPointer(),
  source = liveSource(),
} = {}) {
  const selected = fixture.apply.plan.selected;
  return {
    currentSource: structuredClone(source),
    acquisitionProjection: structuredClone(selected.acquisition),
    activationProjection: structuredClone(selected.activation),
    finalizationProjection: structuredClone(selected.finalization),
    currentBaselineBytes: Buffer.from(baselineBytes),
    currentPointer: structuredClone(pointer),
    r2BindingReceipt: r2ReceiptForPointer(pointer),
  };
}

export function journalAtPhase(fixture, targetPhase) {
  const transactionId = stage1EvidenceSchemaUpgradeReviewedApplyTransactionId({
    sourceId,
    planSha256: fixture.apply.plan_sha256,
  });
  const fresh = fixture.audit.fresh_capture;
  const binding = buildStage1EvidenceSchemaUpgradeReviewedOperationBinding({
    sourceId,
    transactionId,
    reviewedApplyPlanFileSha256: fixture.apply.plan_file_sha256,
    reviewedApplyPlanSha256: fixture.apply.plan_sha256,
    auditRunId: fixture.audit.run_id,
    executionNonce,
    reviewedReportAttemptId: fixture.apply.report_binding.attempt_id,
    freshCaptureSha256: fresh.fresh_capture_sha256,
    freshCaptureResultSha256: fresh.capture_result_sha256,
    freshCaptureValidationSha256: fresh.capture_validation_sha256,
    freshValidationProjectionSha256: fresh.fresh_validation_projection_sha256,
    precommitAuthorityReceiptSha256: fixture.audit.authority_receipt_sha256,
    precommitSourceAuthority: fixture.audit.authority_receipt.source_authority,
  });
  let journal = buildStage1EvidenceSchemaUpgradeJournal({
    transactionId,
    sourceId,
    oldBaselineBytes: oldBaseline,
    oldPointer: oldPointer(),
    candidateBaselineBytes: candidateBaseline,
    candidatePointer: candidatePointer(),
    operationBinding: binding,
    createdAt: "2026-08-20T10:00:00.000Z",
  });
  if (targetPhase === "prepared") return journal;
  const path = targetPhase === "recovery_required"
    ? ["recovery_required"]
    : [
        "local_candidate_written",
        "pointer_cas_attempted",
        "pointer_candidate_committed",
        ...(targetPhase === "completed" ? ["completed"] : []),
      ];
  for (const nextPhase of path) {
    const detail = nextPhase === "completed"
      ? {
          outcome: "committed_candidate",
          authoritative_pointer_sha256:
            journal.candidate_pointer_identity.canonical_sha256,
          authoritative_baseline_sha256: journal.candidate_baseline.sha256,
          source_health_status: "succeeded",
          cleanup_debt_delete_performed: false,
        }
      : null;
    journal = advanceStage1EvidenceSchemaUpgradeJournal(journal, {
      expectedPhase: journal.phase,
      nextPhase,
      at: "2026-08-20T10:01:00.000Z",
      detail,
    });
    if (nextPhase === targetPhase) return journal;
  }
  throw new Error(`Unsupported phase ${targetPhase}.`);
}

export function journalAbandonedOld(fixture) {
  let journal = journalAtPhase(fixture, "recovery_required");
  journal = advanceStage1EvidenceSchemaUpgradeJournal(journal, {
    expectedPhase: "recovery_required",
    nextPhase: "completed",
    at: "2026-08-20T10:02:00.000Z",
    detail: {
      outcome: "abandoned_old_authority",
      authoritative_pointer_sha256:
        journal.old_pointer_identity.canonical_sha256,
      authoritative_baseline_sha256: journal.old_baseline.sha256,
      cleanup_debt_delete_performed: false,
    },
  });
  return journal;
}

export async function terminalizeAudit(fixture, {
  status,
  journal = null,
  completionAuthority = null,
  failureTerminal = null,
  finishedAt = "2026-08-20T10:30:00.000Z",
}) {
  let terminal;
  if (status === "succeeded") {
    const accounting = sealStage1EvidenceSchemaUpgradeMutationAccounting({
      operation: "pointer_commit",
      lowerBoundCounts: zeroStage1EvidenceSchemaUpgradeMutationCounts(),
      unknownWriteCategories: [],
      evidence: { boundary: "archived_completed_recovery_replay" },
    });
    const receipt = {
      schema_version: STAGE1_EVIDENCE_SCHEMA_UPGRADE_COMMIT_RECEIPT_SCHEMA,
      source_id: sourceId,
      status: "upgraded",
      operation: "pointer_commit",
      creates_api_charge: false,
      journal_archived: true,
      journal_sha256: journal.journal_sha256,
      mutation_accounting: accounting,
    };
    terminal = {
      status: "succeeded",
      selected_result: {
        ...fixture.audit.fresh_capture.capture_result,
        status: "upgraded",
        pointer_journal: { status: "upgraded", receipt },
      },
      commit_receipt: receipt,
    };
  } else {
    terminal = failureTerminal || {
      status: "failed",
      error_code: "reviewed_recovery_proven_before_journal",
      error_message: "Exact old authority proves no business mutation crossed.",
    };
  }
  await finishStage1EvidenceSchemaUpgradeReviewedApplyAudit({
    reviewedApplyPlan: fixture.apply,
    executionNonce,
    finishedAt,
    terminal,
    completionAuthority: completionAuthority
      || stage1EvidenceSchemaUpgradeReviewedApplyAuditFreshCompletionAuthority(),
    interfaces: fixture.auditStore,
  });
  fixture.audit = await inspectStage1EvidenceSchemaUpgradeReviewedApplyAuditRecovery({
    reviewedApplyPlan: fixture.apply,
    interfaces: { readRun: fixture.auditStore.readRun },
  });
}

function liveSource(overrides = {}) {
  const manifestSource = manifest.sources.find((source) => source.source_id === sourceId);
  return {
    id: sourceId,
    shared_award_id: manifestSource.shared_award_id,
    url: "https://example.test/reviewed-source",
    title: "Reviewed source",
    display_title: "Reviewed source display title",
    page_description: "Reviewed source description",
    page_metadata: { language: "en", authority: "official" },
    page_metadata_generated_at: "2026-08-15T09:40:00.000Z",
    page_metadata_model: "deterministic",
    page_type: "html",
    source: "official",
    reason: "reviewed",
    submitted_by_user_id: null,
    admin_review_status: "review_later",
    admin_review_note: "operator hold retained",
    admin_reviewed_at: "2026-08-15T09:30:00.00005+00:00",
    admin_reviewed_by: "operator@example.test",
    last_hash: "legacy-visual-hash",
    last_checked_at: "2026-08-15T09:00:00.000Z",
    next_check_at: "2026-08-16T09:00:00.000Z",
    consecutive_failures: 2,
    last_error: "legacy failure",
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-15T09:30:00.000Z",
    shared_awards: {
      id: manifestSource.shared_award_id,
      name: manifestSource.award,
      status: "active",
      official_homepage: "https://example.test",
    },
    ...overrides,
  };
}

export function liveSourceHealthSucceeded() {
  return liveSource({
    last_hash: `visual:${JSON.parse(candidateBaseline).file_hash}`,
    last_checked_at: "2026-08-20T10:02:00.000Z",
    next_check_at: "2026-08-21T10:02:00.000Z",
    consecutive_failures: 0,
    last_error: null,
    updated_at: "2026-08-20T10:02:00.000Z",
  });
}

function oldPointer() {
  return {
    shared_award_source_id: sourceId,
    shared_award_id: manifest.sources.find((source) => source.source_id === sourceId)
      .shared_award_id,
    source_url: "https://example.test/award",
    source_title: "Award",
    source_page_type: "overview",
    kind: "webpage",
    bucket: "evidence",
    latest_captured_at: oldGenerationFixture.capturedAt,
    latest_object_keys: structuredClone(oldGenerationFixture.objectKeys),
    latest_hashes: structuredClone(oldGenerationFixture.latestHashes),
    latest_metadata: structuredClone(oldGenerationFixture.latestMetadata),
    previous_captured_at: "2026-08-13T18:00:00.000Z",
    previous_object_keys: { text: "previous/text.txt" },
    previous_hashes: { text_hash: fixtureSha256("previous-text") },
    previous_metadata: { schema: "legacy" },
    updated_at: "2026-08-14T18:01:00.000Z",
  };
}

function candidatePointer() {
  return buildLatestOnlyVisualSnapshotPointerReplacement({
    existing: oldPointer(),
    replacement: {
      latest_captured_at: candidateGenerationFixture.capturedAt,
      latest_object_keys: structuredClone(candidateGenerationFixture.objectKeys),
      latest_hashes: structuredClone(candidateGenerationFixture.latestHashes),
      latest_metadata: structuredClone(candidateGenerationFixture.latestMetadata),
    },
    updatedAt: "2026-08-20T10:00:00.000Z",
  });
}

function r2ReceiptForPointer(pointer) {
  const generation = [
    oldGenerationFixture,
    candidateGenerationFixture,
    otherGenerationFixture,
  ].find((fixture) => fixture.capturedAt === pointer.latest_captured_at);
  if (!generation) throw new Error("Unknown recovery test R2 generation.");
  const remoteArtifactsByRole = Object.fromEntries(
    generation.prepared.artifacts.map((artifact) => [artifact.name, {
      key: pointer.latest_object_keys[artifact.name],
      body: Buffer.from(artifact.body),
      content_type: artifact.contentType,
      byte_length: artifact.body.byteLength,
      binding: structuredClone(artifact.binding),
    }]),
  );
  return verifyStage1EvidenceSchemaUpgradeR2Binding({
    sourceId,
    sourceKind: "webpage",
    existingBaseline: generation.baseline,
    existingCapture: generation.capture,
    localPreparedArtifacts: generation.prepared,
    r2Pointer: pointer,
    remoteArtifactsByRole,
  });
}

export function recoveryRuntimeGenerationFixture({ label, capturedAt, generation }) {
  const relative = `sources/${sourceId}/captures/${generation}/`;
  const textValue = `${label} reviewed evidence text`;
  const bodies = {
    page: Buffer.from(`${label} reviewed page image`),
    thumb: Buffer.from(`${label} reviewed thumbnail image`),
    text: Buffer.from(`${textValue}\n`),
  };
  const imageHash = sha256(bodies.page);
  const textHash = sha256(Buffer.from(textValue));
  const metadata = {
    version: 1,
    kind: "webpage",
    source: { id: sourceId },
    captured_at: capturedAt,
    final_url: "https://example.test/award",
    image_hash: imageHash,
    file_hash: imageHash,
    text_hash: textHash,
    text_length: textValue.length,
    page_bytes: bodies.page.byteLength,
    thumb_bytes: bodies.thumb.byteLength,
    files: {
      page: `${relative}page.jpg`,
      thumb: `${relative}thumb.jpg`,
      text: `${relative}text.txt`,
      meta: `${relative}meta.json`,
    },
  };
  bodies.meta = Buffer.from(JSON.stringify(metadata));
  const definitions = {
    page: ["page.jpg", "image/jpeg", bodies.page],
    thumb: ["thumb.jpg", "image/jpeg", bodies.thumb],
    text: ["text.txt", "text/plain; charset=utf-8", bodies.text],
    meta: ["meta.json", "application/json; charset=utf-8", bodies.meta],
  };
  const byPath = new Map();
  const files = Object.entries(definitions).map(([name, [fileName, contentType, body]]) => {
    const path = `${relative}${fileName}`;
    byPath.set(path, body);
    return { name, fileName, path, contentType };
  });
  const prepared = prepareR2CaptureArtifacts(files, {
    readFile: (path) => byPath.get(path),
  });
  const objectKeys = Object.fromEntries(
    prepared.artifacts.map((artifact) => [
      artifact.name,
      `visual-snapshots/sources/${sourceId}/captures/${generation}/${artifact.fileName}`,
    ]),
  );
  const latestMetadata = {
    artifact_bindings_schema: "awardping.r2.capture-artifact-bindings.v1",
    artifact_bindings: structuredClone(prepared.artifactBindings),
    text_length: textValue.length,
    page_bytes: bodies.page.byteLength,
    thumb_bytes: bodies.thumb.byteLength,
  };
  const baseline = {
    version: 1,
    kind: "webpage",
    source_id: sourceId,
    source: { id: sourceId },
    captured_at: capturedAt,
    final_url: metadata.final_url,
    image_hash: imageHash,
    file_hash: imageHash,
    text_hash: textHash,
    text_length: textValue.length,
    page_bytes: bodies.page.byteLength,
    thumb_bytes: bodies.thumb.byteLength,
    capture: {
      dir: relative.slice(0, -1),
      page: `${relative}page.jpg`,
      thumb: `${relative}thumb.jpg`,
      text: `${relative}text.txt`,
      meta: `${relative}meta.json`,
    },
    summary_metadata: {},
  };
  const capture = {
    ...metadata,
    text: textValue,
    dir: relative.slice(0, -1),
    page_path: `${relative}page.jpg`,
    thumb_path: `${relative}thumb.jpg`,
    text_path: `${relative}text.txt`,
    meta_path: `${relative}meta.json`,
    expansion_state_screenshots: [],
  };
  return {
    label,
    capturedAt,
    generation,
    bodies,
    baseline,
    capture,
    prepared,
    objectKeys,
    latestHashes: { image_hash: imageHash, text_hash: textHash },
    latestMetadata,
  };
}

function reviewedReportFixture() {
  const manifestSha256 = sha256(canonicalJson(manifest));
  const results = manifest.sources.map((source) => reviewedSourceResultFixture({
    source,
    manifestSha256,
    ready: source.source_id === sourceId,
  }));
  return {
    report_schema_version: 2,
    worker_run_id: null,
    started_at: "2026-08-15T04:16:04.313Z",
    finished_at: "2026-08-15T04:18:00.000Z",
    status: "blocked",
    execution_status: "blocked",
    stop_reason: "stage1_evidence_schema_upgrade_not_ready",
    run_identity: {
      workflow: "visual_capture",
      trigger: "manual",
      shard_count: 1,
      shard_index: 0,
      attempt_id: "33333333-3333-4333-8333-333333333333",
    },
    options: {
      stage1_evidence_schema_upgrade: true,
      stage1_evidence_schema_upgrade_dry_run: true,
      source_id: null,
      source_ids_filter_count: manifest.source_count,
      limit: manifest.source_count,
      stage1_evidence_schema_upgrade_selector: {
        exact_source_count: manifest.source_count,
        dry_run: true,
        source_ids: [...manifest.source_ids],
      },
    },
    stage1_evidence_schema_upgrade: {
      schema_version: STAGE1_EVIDENCE_SCHEMA_UPGRADE_REPORT_SCHEMA,
      mode: "dry_run",
      generated_at: "2026-08-15T04:17:30.000Z",
      manifest_sha256: manifestSha256,
      exact_source_count: manifest.source_count,
      evaluated_source_count: manifest.source_count,
      eligible_source_count: 1,
      upgraded_source_count: 0,
      candidate_source_count: 0,
      quarantined_source_count: 0,
      completed_source_count: 0,
      blocked_source_count: manifest.source_count - 1,
      terminal_failure_source_count: manifest.source_count - 1,
      automated_work_clear: false,
      quarantined_work_remaining: 0,
      status: "blocked",
      mutation_counts_are_exact: true,
      mutation_count_semantics: "exact",
      mutation_count_uncertain_source_count: 0,
      unknown_write_categories: [],
      mutation_counts: zeroMutationCounts(),
      safety: dryRunSafety(),
      results,
    },
  };
}

function reviewedSourceResultFixture({ source, manifestSha256, ready }) {
  const reasonCode = ready
    ? "exact_semantic_and_primary_visual_identity_verified"
    : "existing_baseline_semantic_identity_mismatch";
  const guardSha256 = fixtureSha256(`${source.source_id}:guard`);
  const finalizationReceipt = recoveryRuntimeFinalizationReceiptFixture({
    reviewedSourceId: source.source_id,
    guardSha256,
  });
  const selected = source.source_id === sourceId;
  const r2 = selected
    ? r2ReceiptForPointer(oldPointer())
    : genericR2Receipt(source.source_id);
  return {
    schema_version: STAGE1_EVIDENCE_SCHEMA_UPGRADE_RESULT_SCHEMA,
    mode: "dry_run",
    source_id: source.source_id,
    manifest_sha256: manifestSha256,
    evaluated_at: "2026-08-15T04:17:00.000Z",
    source_eligible: ready,
    status: ready ? "dry_run_ready" : "dry_run_evidence_failure",
    reason_code: reasonCode,
    eligibility: {
      activation_binding: {
        applies: true,
        allowed: true,
        guard_sha256: guardSha256,
        reason: "stage1_baseline_activation_exact_binding_verified",
      },
      award: source.award,
      eligible: ready,
      evidence_completeness_checked: false,
      finalization_binding: {
        present: true,
        source_acquisition_id: "22222222-2222-4222-8222-222222222222",
        finalization_receipt_sha256: sha256(canonicalJson(finalizationReceipt)),
        finalized_at: "2026-08-15T09:30:00.000Z",
      },
      manifest_item: source.item,
      page: source.page,
      reason_codes: ready ? [] : [reasonCode],
      semantic_difference_checked: false,
      source_id: source.source_id,
    },
    capture_validation: {
      status: "evaluated",
      decision: ready
        ? "eligible_unchanged_upgrade"
        : "evidence_failure_quarantine",
      reason: reasonCode,
      evidence: {
        source_id: source.source_id,
        kind: "webpage",
        local_baseline_identity: selected
          ? { sha256: sha256(oldBaseline), byte_length: oldBaseline.byteLength }
          : { sha256: fixtureSha256(`${source.source_id}:baseline`), byte_length: 12345 },
        existing_pointer_identity: selected
          ? compactPointerIdentity(oldPointer())
          : {
              schema_version: "awardping.visual-snapshot-pointer.v1",
              exists: true,
              canonical_sha256: fixtureSha256(`${source.source_id}:pointer`),
            },
        immutable_acquisition: {
          file_hash: fixtureSha256(`${source.source_id}:file`),
          text_hash: r2.semantic_text.sha256,
          normalized_text_hash: fixtureSha256(`${source.source_id}:normalized-text`),
          evidence_quote_count: 1,
          guard_sha256: guardSha256,
        },
        authoritative_existing_r2_binding: r2,
        existing: { text_hash: r2.semantic_text.sha256 },
        capture: {
          captured_at: "2026-08-15T04:17:00.000Z",
          layout_hash: fixtureSha256(`${source.source_id}:layout`),
          expansion_coverage_status: "complete",
        },
        comparison: {
          semantic_fields: { text_hash: { current: r2.semantic_text.sha256 } },
          primary_visual_identity: {
            current: fixtureSha256(`${source.source_id}:primary-visual`),
          },
        },
        pdf_text_recovery: null,
        prior_recovery: null,
      },
    },
    queue_policy: {
      context: STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUEUE_CONTEXT,
      bypassRejectionLedger: true,
      queueReconciliation: false,
    },
    pointer_journal: ready ? { status: "would_commit" } : { status: "not_planned" },
    visual_review_candidate: { status: "not_planned" },
    quarantine: { status: "not_planned" },
    mutation_counts: zeroMutationCounts(),
    safety: dryRunSafety(),
  };
}

export function recoveryRuntimeFinalizationReceiptFixture({
  reviewedSourceId = sourceId,
  guardSha256 = fixtureSha256(`${reviewedSourceId}:guard`),
  finalizedAt = "2026-08-15T09:30:00.00005+00:00",
} = {}) {
  return {
    schema_version: "awardping.stage1.baseline-activation-finalization-receipt.v1",
    status: "finalized_open",
    shared_award_source_id: reviewedSourceId,
    source_acquisition_id: "22222222-2222-4222-8222-222222222222",
    source_page_request_id: null,
    decision_item_sha256: "1".repeat(64),
    guard_sha256: guardSha256,
    observed_normalized_text_sha256:
      fixtureSha256(`${reviewedSourceId}:normalized-text`),
    prepare_receipt_sha256: "2".repeat(64),
    persistence_evidence_sha256: sha256(canonicalJson({})),
    finalized_at: finalizedAt,
    public_fact_authority: false,
    creates_api_charge: false,
  };
}

function genericR2Receipt(otherSourceId) {
  const key = `snapshots/${otherSourceId}/${"d".repeat(32)}/text.txt`;
  const hash = fixtureSha256(`${otherSourceId}:text`);
  const pointerContent = {
    shared_award_source_id: otherSourceId,
    kind: "webpage",
    bucket: "evidence",
    latest_captured_at: "2026-08-14T18:00:00.000Z",
    latest_object_keys: { text: key },
    latest_hashes: { text_hash: hash },
    latest_metadata_sha256: fixtureSha256(`${otherSourceId}:metadata`),
    immutable_generation: "d".repeat(32),
  };
  const previousContent = { preserved: true, verification_scope: "report_only_not_validated" };
  const content = {
    schema: STAGE1_EVIDENCE_SCHEMA_UPGRADE_R2_BINDING_SCHEMA,
    status: "verified",
    source_id: otherSourceId,
    kind: "webpage",
    captured_at: "2026-08-14T18:00:00.000Z",
    creates_api_charge: false,
    mutation_performed: false,
    pointer_identity: {
      ...pointerContent,
      pointer_sha256: sha256(canonicalJson(pointerContent)),
    },
    previous_pointer: {
      ...previousContent,
      projection_sha256: sha256(canonicalJson(previousContent)),
    },
    verified_roles: [{
      role: "text",
      key,
      sha256: hash,
      byte_length: 42,
      content_type: "text/plain; charset=utf-8",
      remote_body_verified: true,
    }],
    semantic_text: {
      sha256: hash,
      character_length: 41,
      object_byte_length: 42,
      writer_framing: "lf",
    },
  };
  return {
    ...content,
    receipt_sha256: stage1EvidenceSchemaUpgradeR2BindingReceiptSha256(content),
  };
}

function selectedResultFromReport(bytes) {
  return JSON.parse(bytes.toString("utf8")).stage1_evidence_schema_upgrade.results
    .find((result) => result.source_id === sourceId);
}

function compactPointerIdentity(pointer) {
  const identity = visualSnapshotPointerIdentity(pointer);
  return {
    schema_version: identity.schema_version,
    exists: identity.exists,
    canonical_sha256: identity.canonical_sha256,
  };
}

function zeroMutationCounts() {
  return {
    database_writes: 0,
    r2_writes: 0,
    local_baseline_writes: 0,
    candidate_writes: 0,
    quarantine_writes: 0,
    source_state_writes: 0,
  };
}

function dryRunSafety() {
  return {
    creates_api_charge: false,
    live_capture_permitted: true,
    local_capture_artifacts_permitted: true,
    public_fact_writes: 0,
    reconciliation_requests: 0,
    public_events: 0,
    source_discovery: false,
    baseline_refreshes: 0,
    ...zeroMutationCounts(),
  };
}

function memoryAuditStore() {
  let row = null;
  const insertRun = vi.fn(async (candidate) => {
    row = structuredClone(candidate);
    return structuredClone(row);
  });
  const readRun = vi.fn(async () => structuredClone(row));
  const updateRun = vi.fn(async ({ guard, patch }) => {
    if (
      !row
      || row.id !== guard.id
      || row.status !== guard.status
      || row.metadata.metadata_sha256 !== guard.running_metadata_sha256
    ) return null;
    row = { ...row, ...structuredClone(patch) };
    return structuredClone(row);
  });
  return { insertRun, readRun, updateRun };
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
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

function fixtureSha256(label) {
  return sha256(Buffer.from(label, "utf8"));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
