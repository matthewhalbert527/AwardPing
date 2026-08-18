import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_COMMIT_RECEIPT_SCHEMA,
} from "./stage1-evidence-schema-upgrade-commit.mjs";
import {
  sealStage1EvidenceSchemaUpgradeMutationAccounting,
  zeroStage1EvidenceSchemaUpgradeMutationCounts,
} from "./stage1-evidence-schema-upgrade-mutation-accounting.mjs";
import {
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_PLAN_AUTHORITY,
  stage1EvidenceSchemaUpgradeFreshValidationSha256,
} from "./stage1-evidence-schema-upgrade-reviewed-apply-plan.mjs";
import {
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_MANIFEST_SCHEMA,
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_RESULT_SCHEMA,
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_SOURCE_IDS,
} from "./stage1-evidence-schema-upgrade.mjs";
import {
  stage1EvidenceSchemaUpgradeReviewedAuthorityReceiptSha256,
} from "./stage1-evidence-schema-upgrade-transaction.mjs";
import {
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_AUDIT_MODE,
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_AUDIT_WORKER_NAME,
  assertStage1EvidenceSchemaUpgradeReviewedApplyAuditCompletionAuthority,
  assertStage1EvidenceSchemaUpgradeCompletedAuthorityAuditInspection,
  assertStage1EvidenceSchemaUpgradeReviewedApplyAuditRecoveryInspection,
  assertStage1EvidenceSchemaUpgradeReviewedApplyAuditReceipt,
  finishStage1EvidenceSchemaUpgradeReviewedApplyAudit,
  inspectStage1EvidenceSchemaUpgradeReviewedApplyAuditRecovery,
  inspectStage1EvidenceSchemaUpgradeCompletedAuthorityAuditRow,
  stage1EvidenceSchemaUpgradeReviewedApplyAuthorityReceipt,
  stage1EvidenceSchemaUpgradeReviewedApplyAuditFreshCompletionAuthority,
  stage1EvidenceSchemaUpgradeReviewedApplyAuditRecoveryCompletionAuthority,
  stage1EvidenceSchemaUpgradeReviewedApplyAuditRunId,
  stage1EvidenceSchemaUpgradeReviewedApplyFreshCaptureEvidence,
  startStage1EvidenceSchemaUpgradeReviewedApplyAudit,
} from "./stage1-evidence-schema-upgrade-reviewed-apply-audit.mjs";

const selectedSourceId = "2ea41875-5c88-5794-81b3-afa8ddaf31c1";
const planFileSha256 = "a".repeat(64);
const planSelfSha256 = "b".repeat(64);
const manifestSha256 = "c".repeat(64);
const startedAt = "2026-08-15T10:00:00.000Z";
const finishedAt = "2026-08-15T10:01:00.000Z";
const executionNonceA = "11111111-1111-4111-8111-111111111111";
const executionNonceB = "22222222-2222-4222-8222-222222222222";
const recoveryTransactionId = "44444444-4444-4444-8444-444444444444";

describe("reviewed exact-one apply local_worker_runs audit", () => {
  it("derives one stable versioned UUID from the exact lowercase plan-file SHA", () => {
    const first = stage1EvidenceSchemaUpgradeReviewedApplyAuditRunId(planFileSha256);
    const second = stage1EvidenceSchemaUpgradeReviewedApplyAuditRunId(planFileSha256);

    expect(first).toBe(second);
    expect(first).toBe("04619674-2167-5874-9341-9fbb52767ba8");
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(stage1EvidenceSchemaUpgradeReviewedApplyAuditRunId("d".repeat(64)))
      .not.toBe(first);
    expect(() => stage1EvidenceSchemaUpgradeReviewedApplyAuditRunId("A".repeat(64)))
      .toThrow(/exact lowercase SHA-256/iu);
  });

  it("builds deterministic exact fresh and reviewed-recovery completion authorities", () => {
    const fresh =
      stage1EvidenceSchemaUpgradeReviewedApplyAuditFreshCompletionAuthority();
    expect(fresh).toMatchObject({
      mode: "fresh_reviewed_apply",
      recovery: null,
      completion_authority_sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(assertStage1EvidenceSchemaUpgradeReviewedApplyAuditCompletionAuthority(fresh))
      .toEqual(fresh);

    const plan = recoveryPlan();
    const recovery = recoveryCompletionAuthority({ plan });
    expect(recovery).toEqual(recoveryCompletionAuthority({ plan }));
    expect(recovery).toMatchObject({
      mode: "reviewed_recovery",
      recovery: {
        recovery_plan_file_sha256: "9".repeat(64),
        recovery_plan_sha256: plan.plan_sha256,
        inspection_file_sha256: "6".repeat(64),
        inspection_sha256: "7".repeat(64),
        proposed_plan_sha256: "8".repeat(64),
        reviewer_id: "reviewer@example.test",
        reviewed_at: "2026-08-15T10:00:30.000Z",
        expires_at: "2026-08-15T12:00:00.000Z",
        expected_disposition: "candidate_archived_recovery_completed",
        source_id: selectedSourceId,
        transaction_id: recoveryTransactionId,
      },
      completion_authority_sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(assertStage1EvidenceSchemaUpgradeReviewedApplyAuditCompletionAuthority(
      recovery,
      { selectedSourceId, finishedAt },
    )).toEqual(recovery);
  });

  it("rejects tampered, extra-keyed, cross-source, expired, and resealed-invalid recovery authority", async () => {
    const plan = recoveryPlan();
    const authority = recoveryCompletionAuthority({ plan });
    const tampered = clone(authority);
    tampered.recovery.reviewer_id = "attacker@example.test";
    expect(() => assertStage1EvidenceSchemaUpgradeReviewedApplyAuditCompletionAuthority(
      tampered,
      { selectedSourceId, finishedAt },
    )).toThrow(/seal/iu);

    const extraKeyed = clone(authority);
    extraKeyed.recovery.unsupported = true;
    extraKeyed.completion_authority_sha256 = reseal(
      extraKeyed,
      "completion_authority_sha256",
    );
    expect(() => assertStage1EvidenceSchemaUpgradeReviewedApplyAuditCompletionAuthority(
      extraKeyed,
      { selectedSourceId, finishedAt },
    )).toThrow(/must contain exactly/iu);

    expect(() => assertStage1EvidenceSchemaUpgradeReviewedApplyAuditCompletionAuthority(
      authority,
      {
        selectedSourceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        finishedAt,
      },
    )).toThrow(/exact scope/iu);
    expect(() => assertStage1EvidenceSchemaUpgradeReviewedApplyAuditCompletionAuthority(
      authority,
      { selectedSourceId, finishedAt: "2026-08-15T12:00:00.000Z" },
    )).toThrow(/exact scope/iu);

    const invalidPlan = recoveryPlan();
    invalidPlan.inspection.source_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    invalidPlan.plan_sha256 = reseal(invalidPlan, "plan_sha256");
    expect(() => recoveryCompletionAuthority({ plan: invalidPlan }))
      .toThrow(/identity/iu);

    const insertRun = vi.fn();
    const readRun = vi.fn();
    const updateRun = vi.fn();
    await expect(finishAudit({
      interfaces: { insertRun, readRun, updateRun },
      completionAuthority: tampered,
    })).rejects.toThrow(/seal/iu);
    expect(readRun).not.toHaveBeenCalled();
    expect(updateRun).not.toHaveBeenCalled();
  });

  it("inserts exactly one dedicated running row and never exposes a supersession interface", async () => {
    const store = memoryStore();
    const receipt = await startAudit({ store });

    expect(receipt).toMatchObject({
      action: "start",
      disposition: "started",
      business_execution_authorized: true,
      replay: false,
      worker_name: STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_AUDIT_WORKER_NAME,
      requested_execution_nonce: executionNonceA,
      active_execution_nonce: executionNonceA,
    });
    expect(store.insertRun).toHaveBeenCalledTimes(1);
    expect(store.readRun).not.toHaveBeenCalled();
    expect(Object.keys(store.interfaces).sort()).toEqual([
      "insertRun",
      "readRun",
      "updateRun",
    ]);
    expect(store.row).toMatchObject({
      id: stage1EvidenceSchemaUpgradeReviewedApplyAuditRunId(planFileSha256),
      worker_name: STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_AUDIT_WORKER_NAME,
      status: "running",
      ai_provider: null,
      metadata: {
        audit_mode: STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_AUDIT_MODE,
        execution_nonce: executionNonceA,
        phase: "running",
        terminal: null,
      },
    });
    expect(store.row.metadata.binding.scope).toEqual({
      selected_source_id: selectedSourceId,
      deferred_source_ids: STAGE1_EVIDENCE_SCHEMA_UPGRADE_SOURCE_IDS.filter(
        (sourceId) => sourceId !== selectedSourceId,
      ),
    });
    expect(store.row.metadata.authority.allow_worker_run_supersession).toBe(false);
    const freshCapture = stage1EvidenceSchemaUpgradeReviewedApplyFreshCaptureEvidence({
      reviewedApplyPlan: reviewedPlan(),
      captureResult: freshCaptureResult(),
    });
    expect(store.row.metadata.fresh_capture).toEqual(freshCapture);
    const authority = authorityReceipt();
    expect(store.row.metadata.authority_receipt).toEqual(authority);
    expect(store.row.metadata.authority_receipt_sha256)
      .toBe(stage1EvidenceSchemaUpgradeReviewedAuthorityReceiptSha256(authority));
    expect(receipt).toMatchObject({
      authority_receipt_sha256: store.row.metadata.authority_receipt_sha256,
      fresh_capture_evidence_sha256: freshCapture.fresh_capture_sha256,
      fresh_capture_result_sha256: freshCapture.capture_result_sha256,
      fresh_capture_validation_sha256: freshCapture.capture_validation_sha256,
      fresh_validation_projection_sha256:
        freshCapture.fresh_validation_projection_sha256,
    });
    expect(receipt.audit_mutation_accounting).toMatchObject({
      exact: true,
      lower_bound_counts: {
        local_worker_run_inserts: 1,
        local_worker_run_terminal_updates: 0,
      },
      unknown_write_categories: [],
    });
    expect(assertStage1EvidenceSchemaUpgradeReviewedApplyAuditReceipt(receipt))
      .toEqual(receipt);
    expect(Object.isFrozen(receipt)).toBe(true);
  });

  it("rejects missing, altered, or extra-keyed fresh capture evidence before audit I/O", async () => {
    const insertRun = vi.fn();
    const readRun = vi.fn();
    await expect(startStage1EvidenceSchemaUpgradeReviewedApplyAudit({
      reviewedApplyPlan: reviewedPlan(),
      executionNonce: executionNonceA,
      startedAt,
      interfaces: { insertRun, readRun },
    })).rejects.toThrow(/capture/iu);

    const altered = freshCaptureResult();
    altered.capture_validation.evidence.local_baseline_identity.sha256 = "9".repeat(64);
    await expect(startAudit({
      captureResult: altered,
      interfaces: { insertRun, readRun },
    })).rejects.toThrow(/selected|projection/iu);

    const extraKeyed = { ...freshCaptureResult(), unsupported: true };
    await expect(startAudit({
      captureResult: extraKeyed,
      interfaces: { insertRun, readRun },
    })).rejects.toThrow(/must contain exactly/iu);
    expect(insertRun).not.toHaveBeenCalled();
  });

  it("rejects authority receipt tampering and extra keys before audit I/O", async () => {
    const insertRun = vi.fn();
    const readRun = vi.fn();
    const tamperedProjection = clone(authorityReceipt());
    tamperedProjection.source_authority.projection.admin_review_note = "tampered";
    await expect(startAudit({
      authority: tamperedProjection,
      interfaces: { insertRun, readRun },
    })).rejects.toThrow(/projection|seal/iu);

    const tamperedOuterHash = clone(authorityReceipt());
    tamperedOuterHash.source_authority_sha256 = "9".repeat(64);
    await expect(startAudit({
      authority: tamperedOuterHash,
      interfaces: { insertRun, readRun },
    })).rejects.toThrow(/identity/iu);

    const extraKeyed = { ...clone(authorityReceipt()), unsupported: true };
    await expect(startAudit({
      authority: extraKeyed,
      interfaces: { insertRun, readRun },
    })).rejects.toThrow(/must contain exactly/iu);
    expect(insertRun).not.toHaveBeenCalled();
  });

  it("never treats same-nonce health, identity, or admin drift as the inserted authority", async () => {
    const driftedSources = [
      liveSource({
        last_hash: "candidate-hash",
        last_checked_at: "2026-08-15T10:00:30.000Z",
        next_check_at: "2026-08-16T10:00:30.000Z",
        consecutive_failures: 0,
        last_error: null,
        updated_at: "2026-08-15T10:00:30.000Z",
      }),
      liveSource({ url: "https://example.test/concurrent-identity-change" }),
      liveSource({ admin_review_note: "concurrent operator decision" }),
    ];
    for (const source of driftedSources) {
      const store = memoryStore();
      await startAudit({ store });
      const receipt = await startAudit({
        store,
        authority: authorityReceipt({ source }),
      });
      expect(receipt).toMatchObject({
        disposition: "ambiguous_insert_running_row_mismatch",
        business_execution_authorized: false,
        active_execution_nonce: executionNonceA,
      });
      expect(store.writeCount).toBe(1);
    }
  });

  it("accepts normalized row timestamps while sealed audit metadata stays exact", async () => {
    const insertRun = vi.fn(async (candidate) => ({
      ...clone(candidate),
      started_at: "2026-08-15T10:00:00+00:00",
    }));
    const readRun = vi.fn();
    const receipt = await startAudit({ interfaces: { insertRun, readRun } });

    expect(receipt).toMatchObject({
      disposition: "started",
      business_execution_authorized: true,
      active_execution_nonce: executionNonceA,
    });
    expect(readRun).not.toHaveBeenCalled();
  });

  it("continues after insert response loss only from the exact same nonce and row", async () => {
    let row = null;
    const insertRun = vi.fn(async (candidate) => {
      row = clone(candidate);
      throw new Error("response lost after commit");
    });
    const readRun = vi.fn(async () => clone(row));
    const receipt = await startAudit({
      interfaces: { insertRun, readRun },
    });

    expect(receipt).toMatchObject({
      disposition: "started_after_insert_response_loss",
      business_execution_authorized: true,
      replay: false,
      audit_mutation_accounting: {
        exact: false,
        lower_bound_counts: {
          local_worker_run_inserts: 0,
          local_worker_run_terminal_updates: 0,
        },
        unknown_write_categories: ["local_worker_run_inserts"],
      },
    });
    expect(readRun).toHaveBeenCalledWith({
      run_id: stage1EvidenceSchemaUpgradeReviewedApplyAuditRunId(planFileSha256),
    });
  });

  it("blocks a concurrent running execution with a different fresh nonce", async () => {
    const store = memoryStore();
    await startAudit({ store, executionNonce: executionNonceA });
    const receipt = await startAudit({ store, executionNonce: executionNonceB });

    expect(receipt).toMatchObject({
      disposition: "concurrent_execution_running",
      business_execution_authorized: false,
      replay: false,
      active_execution_nonce: executionNonceA,
      audit_mutation_accounting: {
        exact: true,
        lower_bound_counts: {
          local_worker_run_inserts: 0,
          local_worker_run_terminal_updates: 0,
        },
      },
    });
    expect(store.insertRun).toHaveBeenCalledTimes(2);
    expect(store.writeCount).toBe(1);
  });

  it("does not authorize an ambiguous same-nonce insert when the exact fresh capture differs", async () => {
    const store = memoryStore();
    await startAudit({ store, captureResult: freshCaptureResult() });
    const changedVolatileCapture = freshCaptureResult({
      evaluatedAt: "2026-08-15T09:59:01.000Z",
    });
    const receipt = await startAudit({
      store,
      captureResult: changedVolatileCapture,
    });

    expect(receipt).toMatchObject({
      disposition: "ambiguous_insert_running_row_mismatch",
      business_execution_authorized: false,
      active_execution_nonce: executionNonceA,
    });
    expect(receipt.fresh_capture_result_sha256).not.toBe(
      stage1EvidenceSchemaUpgradeReviewedApplyFreshCaptureEvidence({
        reviewedApplyPlan: reviewedPlan(),
        captureResult: changedVolatileCapture,
      }).capture_result_sha256,
    );
    expect(store.writeCount).toBe(1);
  });

  it("returns one sealed read-only running recovery inspection with the exact capture and nonce", async () => {
    const store = memoryStore();
    const captureResult = freshCaptureResult();
    await startAudit({ store, captureResult });

    const inspected = await inspectStage1EvidenceSchemaUpgradeReviewedApplyAuditRecovery({
      reviewedApplyPlan: reviewedPlan(),
      interfaces: { readRun: store.readRun },
    });

    expect(inspected).toMatchObject({
      disposition: "running_recovery_evidence",
      row_kind: "running",
      status: "running",
      execution_nonce: executionNonceA,
      selected_source_id: selectedSourceId,
      mutation_performed: false,
      mutation_permitted: false,
      creates_api_charge: false,
      report_replay: false,
      terminal: null,
      fresh_capture: {
        capture_result: captureResult,
        fresh_capture_sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      },
      authority_receipt: authorityReceipt(),
      authority_receipt_sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      inspection_sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(assertStage1EvidenceSchemaUpgradeReviewedApplyAuditRecoveryInspection(inspected))
      .toEqual(inspected);
    expect(store.insertRun).toHaveBeenCalledTimes(1);
    expect(store.updateRun).not.toHaveBeenCalled();
  });

  it("returns exact terminal success for report-only replay after finish response loss", async () => {
    const store = memoryStore();
    await startAudit({ store });
    await finishAudit({ store });

    const inspected = await inspectStage1EvidenceSchemaUpgradeReviewedApplyAuditRecovery({
      reviewedApplyPlan: reviewedPlan(),
      interfaces: { readRun: store.readRun },
    });

    expect(inspected).toMatchObject({
      disposition: "terminal_success_report_replay_evidence",
      row_kind: "terminal_succeeded",
      status: "succeeded",
      execution_nonce: executionNonceA,
      report_replay: true,
      business_execution_authorized: false,
      mutation_permitted: false,
      mutation_performed: false,
      terminal_status: "succeeded",
      terminal_identity_sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      terminal_failure_sha256: null,
      terminal_completion_authority_mode: "fresh_reviewed_apply",
      terminal_completion_authority_sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      terminal: {
        status: "succeeded",
        completion_authority: {
          mode: "fresh_reviewed_apply",
          recovery: null,
        },
        selected_result_commit_identity: {
          source_id: selectedSourceId,
          identity_sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
        },
      },
    });
    expect(assertStage1EvidenceSchemaUpgradeReviewedApplyAuditRecoveryInspection(inspected))
      .toEqual(inspected);
    expect(store.updateRun).toHaveBeenCalledTimes(1);
  });

  it("returns exact terminal failure for report-only replay after finish response loss", async () => {
    const store = memoryStore();
    await startAudit({ store });
    await finishAudit({
      store,
      terminal: {
        status: "failed",
        error_code: "pre_commit_authority_changed",
        error_message: "Authority changed before any business mutation.",
      },
    });

    const inspected = await inspectStage1EvidenceSchemaUpgradeReviewedApplyAuditRecovery({
      reviewedApplyPlan: reviewedPlan(),
      interfaces: { readRun: store.readRun },
    });

    expect(inspected).toMatchObject({
      disposition: "terminal_failure_report_replay_evidence",
      row_kind: "terminal_failed",
      status: "failed",
      report_replay: true,
      business_execution_authorized: false,
      mutation_permitted: false,
      terminal_status: "failed",
      terminal_identity_sha256: null,
      terminal_failure_sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      terminal_completion_authority_mode: "fresh_reviewed_apply",
      terminal_completion_authority_sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      terminal: {
        status: "failed",
        completion_authority: {
          mode: "fresh_reviewed_apply",
          recovery: null,
        },
        selected_result_commit_identity: null,
        failure: {
          error_code: "pre_commit_authority_changed",
        },
      },
    });
    expect(assertStage1EvidenceSchemaUpgradeReviewedApplyAuditRecoveryInspection(inspected))
      .toEqual(inspected);
  });

  it("projects one self-sealed terminal audit proof for completed-authority validation", async () => {
    const store = memoryStore();
    const plan = reviewedPlan();
    await startAudit({ store, plan });
    await finishAudit({ store, plan });

    const inspected = inspectStage1EvidenceSchemaUpgradeCompletedAuthorityAuditRow({
      row: store.row,
      expectedRunId:
        stage1EvidenceSchemaUpgradeReviewedApplyAuditRunId(planFileSha256),
      expectedSourceId: selectedSourceId,
      expectedManifestSource: plan.plan.selected.source,
      expectedManifestSha256: manifestSha256,
    });

    expect(inspected).toMatchObject({
      disposition: "terminal_succeeded",
      run_id: stage1EvidenceSchemaUpgradeReviewedApplyAuditRunId(planFileSha256),
      selected_source_id: selectedSourceId,
      plan_file_sha256: planFileSha256,
      plan_sha256: planSelfSha256,
      manifest_sha256: manifestSha256,
      fresh_capture_sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      fresh_capture_validation_sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      terminal_commit_journal_sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      terminal_completion_authority: {
        mode: "fresh_reviewed_apply",
        recovery: null,
      },
      business_execution_authorized: false,
      mutation_permitted: false,
      mutation_performed: false,
      creates_api_charge: false,
    });
    expect(assertStage1EvidenceSchemaUpgradeCompletedAuthorityAuditInspection(inspected))
      .toEqual(inspected);

    const tampered = clone(inspected);
    tampered.terminal_commit_journal_sha256 = "e".repeat(64);
    expect(() => assertStage1EvidenceSchemaUpgradeCompletedAuthorityAuditInspection(tampered))
      .toThrow(/seal or state/u);

    const resealedRun = clone(inspected);
    resealedRun.run_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    resealedRun.inspection_sha256 = reseal(resealedRun, "inspection_sha256");
    expect(() => assertStage1EvidenceSchemaUpgradeCompletedAuthorityAuditInspection(
      resealedRun,
    )).toThrow(/identities disagree/u);

    const resealedResultSchema = clone(inspected);
    resealedResultSchema.terminal_result_identity.selected_result_schema_version =
      "attacker.result.v1";
    resealedResultSchema.terminal_result_identity.identity_sha256 = reseal(
      resealedResultSchema.terminal_result_identity,
      "identity_sha256",
    );
    resealedResultSchema.terminal_identity_sha256 =
      resealedResultSchema.terminal_result_identity.identity_sha256;
    resealedResultSchema.inspection_sha256 = reseal(
      resealedResultSchema,
      "inspection_sha256",
    );
    expect(() => assertStage1EvidenceSchemaUpgradeCompletedAuthorityAuditInspection(
      resealedResultSchema,
    )).toThrow(/result\/commit identity is invalid/u);
  });

  it("accepts exact reviewed-recovery completion and rejects externally mismatched history", async () => {
    const plan = reviewedPlan();
    const store = memoryStore();
    await startAudit({ store, plan });
    await finishAudit({
      store,
      plan,
      completionAuthority: recoveryCompletionAuthority(),
    });
    const expected = {
      row: store.row,
      expectedRunId:
        stage1EvidenceSchemaUpgradeReviewedApplyAuditRunId(planFileSha256),
      expectedSourceId: selectedSourceId,
      expectedManifestSource: plan.plan.selected.source,
      expectedManifestSha256: manifestSha256,
    };
    const inspected = inspectStage1EvidenceSchemaUpgradeCompletedAuthorityAuditRow(
      expected,
    );
    expect(inspected.terminal_completion_authority).toMatchObject({
      mode: "reviewed_recovery",
      recovery: {
        source_id: selectedSourceId,
        transaction_id: recoveryTransactionId,
      },
    });
    expect(assertStage1EvidenceSchemaUpgradeCompletedAuthorityAuditInspection(inspected))
      .toEqual(inspected);

    expect(() => inspectStage1EvidenceSchemaUpgradeCompletedAuthorityAuditRow({
      ...expected,
      expectedRunId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    })).toThrow(/externally bound/u);
    expect(() => inspectStage1EvidenceSchemaUpgradeCompletedAuthorityAuditRow({
      ...expected,
      expectedSourceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    })).toThrow(/manifest source and source ID differ/u);
    expect(() => inspectStage1EvidenceSchemaUpgradeCompletedAuthorityAuditRow({
      ...expected,
      expectedManifestSha256: "0".repeat(64),
    })).toThrow(/externally bound/u);

    const mismatchedSource = {
      ...plan.plan.selected.source,
      source_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    };
    expect(() => inspectStage1EvidenceSchemaUpgradeCompletedAuthorityAuditRow({
      ...expected,
      expectedManifestSource: mismatchedSource,
    })).toThrow(/manifest source and source ID differ/u);

    const resealedAuthorityRow = store.row;
    resealedAuthorityRow.metadata.binding.authority.allow_quarantine = true;
    resealedAuthorityRow.metadata.metadata_sha256 = reseal(
      resealedAuthorityRow.metadata,
      "metadata_sha256",
    );
    expect(() => inspectStage1EvidenceSchemaUpgradeCompletedAuthorityAuditRow({
      ...expected,
      row: resealedAuthorityRow,
    })).toThrow(/authority mode is invalid/u);

    const resealedResultSchemaRow = store.row;
    const resultIdentity =
      resealedResultSchemaRow.metadata.terminal.selected_result_commit_identity;
    resultIdentity.selected_result_schema_version = "attacker.result.v1";
    resultIdentity.identity_sha256 = reseal(resultIdentity, "identity_sha256");
    resealedResultSchemaRow.metadata.terminal.terminal_sha256 = reseal(
      resealedResultSchemaRow.metadata.terminal,
      "terminal_sha256",
    );
    resealedResultSchemaRow.metadata.metadata_sha256 = reseal(
      resealedResultSchemaRow.metadata,
      "metadata_sha256",
    );
    expect(() => inspectStage1EvidenceSchemaUpgradeCompletedAuthorityAuditRow({
      ...expected,
      row: resealedResultSchemaRow,
    })).toThrow(/externally bound/u);
  });

  it("refuses recovery inspection for missing and malformed rows", async () => {
    await expect(inspectStage1EvidenceSchemaUpgradeReviewedApplyAuditRecovery({
      reviewedApplyPlan: reviewedPlan(),
      interfaces: { readRun: async () => null },
    })).rejects.toMatchObject({ code: "reviewed_apply_audit_recovery_not_running" });

    const malformedStore = memoryStore();
    await startAudit({ store: malformedStore });
    malformedStore.setRow({ ...malformedStore.row, unsupported: true });
    await expect(inspectStage1EvidenceSchemaUpgradeReviewedApplyAuditRecovery({
      reviewedApplyPlan: reviewedPlan(),
      interfaces: { readRun: malformedStore.readRun },
    })).rejects.toMatchObject({ code: "reviewed_apply_audit_recovery_not_running" });
  });

  it("blocks missing, extra-keyed, and coherently resealed metadata readbacks", async () => {
    const missing = await startAudit({
      interfaces: {
        insertRun: async () => {
          throw new Error("unknown");
        },
        readRun: async () => null,
      },
    });
    expect(missing).toMatchObject({
      disposition: "ambiguous_insert_row_missing",
      business_execution_authorized: false,
      audit_mutation_accounting: {
        exact: false,
        unknown_write_categories: ["local_worker_run_inserts"],
      },
    });

    let expectedRow;
    const extraRow = await startAudit({
      interfaces: {
        insertRun: async (row) => {
          expectedRow = clone(row);
          throw new Error("unknown");
        },
        readRun: async () => ({ ...clone(expectedRow), unsupported: true }),
      },
    });
    expect(extraRow.disposition).toBe("ambiguous_insert_row_mismatch");
    expect(extraRow.business_execution_authorized).toBe(false);

    const metadata = clone(expectedRow.metadata);
    metadata.unsupported = true;
    metadata.metadata_sha256 = reseal(metadata, "metadata_sha256");
    const extraMetadata = await startAudit({
      interfaces: {
        insertRun: async () => {
          throw new Error("unknown");
        },
        readRun: async () => ({ ...clone(expectedRow), metadata }),
      },
    });
    expect(extraMetadata.disposition).toBe("ambiguous_insert_row_mismatch");
    expect(extraMetadata.business_execution_authorized).toBe(false);
  });

  it("rejects extra plan binding keys and non-v4 execution nonces before I/O", async () => {
    const extraReportKey = reviewedPlan();
    extraReportKey.report_binding.unsupported = true;
    const insertRun = vi.fn();

    await expect(startAudit({
      plan: extraReportKey,
      interfaces: { insertRun, readRun: vi.fn() },
    })).rejects.toThrow(/must contain exactly/iu);
    await expect(startAudit({
      executionNonce: "11111111-1111-5111-8111-111111111111",
      interfaces: { insertRun, readRun: vi.fn() },
    })).rejects.toThrow(/UUIDv4/iu);
    expect(insertRun).not.toHaveBeenCalled();
  });

  it("finishes with one guarded running-to-succeeded update bound to nonce and plan", async () => {
    const store = memoryStore();
    await startAudit({ store });
    const terminal = successfulTerminal();
    const receipt = await finishAudit({ store, terminal });

    expect(store.updateRun).toHaveBeenCalledTimes(1);
    const request = store.updateRun.mock.calls[0][0];
    expect(request.guard).toEqual({
      id: stage1EvidenceSchemaUpgradeReviewedApplyAuditRunId(planFileSha256),
      worker_name: STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_AUDIT_WORKER_NAME,
      status: "running",
      execution_nonce: executionNonceA,
      plan_file_sha256: planFileSha256,
      plan_sha256: planSelfSha256,
      running_metadata_sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(request.patch).toMatchObject({
      status: "succeeded",
      checked_count: 1,
      changed_count: 1,
      failed_count: 0,
      error: null,
      finished_at: finishedAt,
      metadata: {
        phase: "terminal",
        execution_nonce: executionNonceA,
        terminal: {
          status: "succeeded",
          failure: null,
          selected_result_commit_identity: {
            source_id: selectedSourceId,
            identity_sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
          },
        },
      },
    });
    expect(receipt).toMatchObject({
      disposition: "finished",
      terminal_status: "succeeded",
      terminal_identity_sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      terminal_failure_sha256: null,
      terminal_completion_authority_mode: "fresh_reviewed_apply",
      terminal_completion_authority_sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      audit_mutation_accounting: {
        exact: true,
        lower_bound_counts: {
          local_worker_run_inserts: 0,
          local_worker_run_terminal_updates: 1,
        },
      },
    });
    expect(store.writeCount).toBe(2);
    expect(assertStage1EvidenceSchemaUpgradeReviewedApplyAuditReceipt(receipt))
      .toEqual(receipt);
  });

  it("persists and exposes the exact reviewed-recovery completion authority", async () => {
    const store = memoryStore();
    const completionAuthority = recoveryCompletionAuthority();
    await startAudit({ store });
    const receipt = await finishAudit({ store, completionAuthority });
    const inspected = await inspectStage1EvidenceSchemaUpgradeReviewedApplyAuditRecovery({
      reviewedApplyPlan: reviewedPlan(),
      interfaces: { readRun: store.readRun },
    });

    expect(store.row.metadata.terminal.completion_authority)
      .toEqual(completionAuthority);
    expect(receipt).toMatchObject({
      terminal_completion_authority_mode: "reviewed_recovery",
      terminal_completion_authority_sha256:
        completionAuthority.completion_authority_sha256,
    });
    expect(inspected).toMatchObject({
      terminal_completion_authority_mode: "reviewed_recovery",
      terminal_completion_authority_sha256:
        completionAuthority.completion_authority_sha256,
      terminal: { completion_authority: completionAuthority },
    });
    expect(assertStage1EvidenceSchemaUpgradeReviewedApplyAuditReceipt(receipt))
      .toEqual(receipt);
    expect(assertStage1EvidenceSchemaUpgradeReviewedApplyAuditRecoveryInspection(inspected))
      .toEqual(inspected);
  });

  it("uses exact readback and unknown accounting after a lost terminal-update response", async () => {
    let row = null;
    let updateRequest = null;
    const interfaces = {
      insertRun: async (candidate) => {
        row = clone(candidate);
        return clone(row);
      },
      readRun: async () => clone(row),
      updateRun: async (request) => {
        updateRequest = clone(request);
        row = { ...row, ...clone(request.patch) };
        throw new Error("response lost after update");
      },
    };
    await startAudit({ interfaces });
    const receipt = await finishAudit({ interfaces });

    expect(updateRequest.guard.execution_nonce).toBe(executionNonceA);
    expect(receipt).toMatchObject({
      disposition: "finished_after_update_response_loss",
      terminal_status: "succeeded",
      audit_mutation_accounting: {
        exact: false,
        lower_bound_counts: {
          local_worker_run_inserts: 0,
          local_worker_run_terminal_updates: 0,
        },
        unknown_write_categories: ["local_worker_run_terminal_updates"],
      },
    });
  });

  it("blocks when an ambiguous terminal update cannot be proven by exact readback", async () => {
    let row = null;
    const interfaces = {
      insertRun: async (candidate) => {
        row = clone(candidate);
        return clone(row);
      },
      readRun: async () => clone(row),
      updateRun: async () => {
        throw new Error("terminal update outcome unknown");
      },
    };
    await startAudit({ interfaces });
    const receipt = await finishAudit({ interfaces });

    expect(receipt).toMatchObject({
      disposition: "ambiguous_update_row_still_running",
      business_execution_authorized: false,
      replay: false,
      terminal_status: null,
      audit_mutation_accounting: {
        exact: false,
        lower_bound_counts: {
          local_worker_run_inserts: 0,
          local_worker_run_terminal_updates: 0,
        },
        unknown_write_categories: ["local_worker_run_terminal_updates"],
      },
    });
  });

  it("replays only an exact prior terminal success with a sealed result/commit identity", async () => {
    const store = memoryStore();
    const terminal = successfulTerminal();
    await startAudit({ store });
    const finished = await finishAudit({ store, terminal });
    const replay = await startAudit({ store, executionNonce: executionNonceB });

    expect(replay).toMatchObject({
      disposition: "prior_terminal_success_replay",
      business_execution_authorized: false,
      replay: true,
      terminal_status: "succeeded",
      terminal_identity_sha256: finished.terminal_identity_sha256,
      active_execution_nonce: executionNonceA,
      audit_mutation_accounting: {
        exact: true,
        lower_bound_counts: {
          local_worker_run_inserts: 0,
          local_worker_run_terminal_updates: 0,
        },
      },
    });
    expect(store.writeCount).toBe(2);

    const finishReplay = await finishAudit({
      store,
      executionNonce: executionNonceB,
      terminal,
    });
    expect(finishReplay).toMatchObject({
      disposition: "terminal_success_replay",
      replay: true,
    });
    expect(store.updateRun).toHaveBeenCalledTimes(1);
  });

  it("blocks a terminal success whose sealed metadata omits the result/commit identity", async () => {
    const store = memoryStore();
    await startAudit({ store });
    await finishAudit({ store });

    const row = clone(store.row);
    row.metadata.terminal.selected_result_commit_identity = null;
    row.metadata.terminal.terminal_sha256 = reseal(
      row.metadata.terminal,
      "terminal_sha256",
    );
    row.metadata.metadata_sha256 = reseal(row.metadata, "metadata_sha256");
    store.setRow(row);

    const replay = await startAudit({ store, executionNonce: executionNonceB });
    expect(replay).toMatchObject({
      disposition: "ambiguous_insert_row_mismatch",
      business_execution_authorized: false,
      replay: false,
      terminal_identity_sha256: null,
    });
  });

  it("persists a sealed failed terminal and replays only its exact failure authority", async () => {
    const store = memoryStore();
    const failedTerminal = {
      status: "failed",
      error_code: "fresh_validation_mismatch",
      error_message: "Fresh result differed from the reviewed plan.",
    };
    await startAudit({ store });
    const failed = await finishAudit({
      store,
      terminal: failedTerminal,
    });

    expect(failed).toMatchObject({
      disposition: "finished",
      terminal_status: "failed",
      terminal_identity_sha256: null,
      terminal_failure_sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      terminal_completion_authority_mode: "fresh_reviewed_apply",
    });
    expect(store.row).toMatchObject({
      status: "failed",
      checked_count: 1,
      changed_count: 0,
      failed_count: 1,
      error: "Fresh result differed from the reviewed plan.",
      metadata: {
        phase: "terminal",
        terminal: {
          status: "failed",
          selected_result_commit_identity: null,
          failure: {
            error_code: "fresh_validation_mismatch",
            error_message_sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
          },
        },
      },
    });

    const retry = await startAudit({ store, executionNonce: executionNonceB });
    expect(retry).toMatchObject({
      disposition: "prior_terminal_failure",
      business_execution_authorized: false,
      replay: false,
    });
    const finishRetry = await finishAudit({
      store,
      executionNonce: executionNonceB,
      terminal: failedTerminal,
      finishTime: "2026-08-15T10:02:00.000Z",
    });
    expect(finishRetry).toMatchObject({
      disposition: "terminal_failure_replay",
      replay: true,
      terminal_failure_sha256: failed.terminal_failure_sha256,
      terminal_completion_authority_sha256:
        failed.terminal_completion_authority_sha256,
    });

    const changedFailure = await finishAudit({
      store,
      executionNonce: executionNonceB,
      terminal: {
        ...failedTerminal,
        error_message: "A different failure narrative.",
      },
    });
    expect(changedFailure).toMatchObject({
      disposition: "terminal_failure_conflict",
      replay: false,
    });

    const changedAuthority = await finishAudit({
      store,
      executionNonce: executionNonceB,
      terminal: failedTerminal,
      completionAuthority: recoveryCompletionAuthority(),
    });
    expect(changedAuthority).toMatchObject({
      disposition: "terminal_failure_conflict",
      replay: false,
    });
    expect(store.writeCount).toBe(2);
  });

  it("blocks terminal identity conflicts and row mismatches without a second update", async () => {
    const store = memoryStore();
    const terminal = successfulTerminal();
    await startAudit({ store });
    await finishAudit({ store, terminal });

    const conflicting = clone(terminal);
    conflicting.selected_result.review_binding = "different";
    const receipt = await finishAudit({
      store,
      executionNonce: executionNonceB,
      terminal: conflicting,
    });
    expect(receipt).toMatchObject({
      disposition: "terminal_success_conflict",
      replay: false,
    });

    const authorityConflict = await finishAudit({
      store,
      executionNonce: executionNonceB,
      terminal,
      completionAuthority: recoveryCompletionAuthority(),
    });
    expect(authorityConflict).toMatchObject({
      disposition: "terminal_success_conflict",
      replay: false,
    });
    expect(store.updateRun).toHaveBeenCalledTimes(1);

    const malformedStore = memoryStore();
    await startAudit({ store: malformedStore });
    malformedStore.setRow({ ...clone(malformedStore.row), unsupported: true });
    const malformed = await finishAudit({ store: malformedStore });
    expect(malformed.disposition).toBe("finish_precondition_row_mismatch");
    expect(malformedStore.updateRun).not.toHaveBeenCalled();
  });

  it("detects receipt and accounting tampering", async () => {
    const receipt = await startAudit({ store: memoryStore() });
    const tamperedReceipt = clone(receipt);
    tamperedReceipt.business_execution_authorized = false;
    expect(() => assertStage1EvidenceSchemaUpgradeReviewedApplyAuditReceipt(
      tamperedReceipt,
    )).toThrow(/receipt seal/iu);

    const tamperedAccounting = clone(receipt);
    tamperedAccounting.audit_mutation_accounting.lower_bound_counts
      .local_worker_run_inserts = 2;
    tamperedAccounting.receipt_sha256 = reseal(tamperedAccounting, "receipt_sha256");
    expect(() => assertStage1EvidenceSchemaUpgradeReviewedApplyAuditReceipt(
      tamperedAccounting,
    )).toThrow(/accounting seal/iu);
  });
});

function reviewedPlan() {
  const captureResult = freshCaptureResult();
  const freshValidationProjectionSha256 =
    stage1EvidenceSchemaUpgradeFreshValidationSha256(captureResult);
  return {
    valid: true,
    plan_file_sha256: planFileSha256,
    plan_sha256: planSelfSha256,
    selected_source_id: selectedSourceId,
    deferred_source_ids: STAGE1_EVIDENCE_SCHEMA_UPGRADE_SOURCE_IDS.filter(
      (sourceId) => sourceId !== selectedSourceId,
    ),
    expected_active_journal_sha256: null,
    fresh_validation_projection_sha256: freshValidationProjectionSha256,
    authority: clone(STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_PLAN_AUTHORITY),
    report_binding: {
      attempt_id: "33333333-3333-4333-8333-333333333333",
      file_sha256: "d".repeat(64),
      finished_at: "2026-08-15T09:55:00.000Z",
      manifest_sha256: manifestSha256,
      report_schema_version: 2,
      stage1_report_generated_at: "2026-08-15T09:54:59.000Z",
      stage1_report_schema_version:
        "awardping.stage1.evidence-schema-upgrade-report.v1",
      stage1_report_sha256: "e".repeat(64),
      started_at: "2026-08-15T09:45:00.000Z",
      worker_run_id: null,
    },
    plan: {
      manifest: {
        schema_version: STAGE1_EVIDENCE_SCHEMA_UPGRADE_MANIFEST_SCHEMA,
        sha256: manifestSha256,
        source_count: 9,
      },
      selected: reviewedSelectedBinding(captureResult),
    },
  };
}

function reviewedSelectedBinding(captureResult) {
  const validation = captureResult.capture_validation;
  const freshProjectionSha256 =
    stage1EvidenceSchemaUpgradeFreshValidationSha256(captureResult);
  return {
    source: { source_id: selectedSourceId },
    result: {
      schema_version: captureResult.schema_version,
      evaluated_at: captureResult.evaluated_at,
      result_sha256: sha256(canonicalJson(captureResult)),
      status: captureResult.status,
      reason_code: captureResult.reason_code,
    },
    validation: {
      status: validation.status,
      decision: validation.decision,
      reason: validation.reason,
      capture_validation_sha256: sha256(canonicalJson(validation)),
      fresh_projection_schema:
        "awardping.stage1.evidence-schema-upgrade-fresh-validation-projection.v3",
      fresh_projection_sha256: freshProjectionSha256,
    },
    acquisition: {
      source_acquisition_id: "55555555-5555-4555-8555-555555555555",
      file_sha256: "5".repeat(64),
      text_sha256: "6".repeat(64),
      normalized_text_sha256: "7".repeat(64),
      evidence_quote_count: 1,
    },
    activation: {
      guard_sha256: "8".repeat(64),
      binding_reason: "exact_stage1_activation_binding_verified",
    },
    finalization: {
      receipt_sha256: "9".repeat(64),
      finalized_at: "2026-08-15T09:30:00.000Z",
    },
    local_baseline_identity:
      clone(validation.evidence.local_baseline_identity),
    existing_pointer_identity:
      clone(validation.evidence.existing_pointer_identity),
    r2: {
      binding_receipt_sha256: "4".repeat(64),
      pointer_sha256: "a".repeat(64),
      previous_pointer_projection_sha256: "b".repeat(64),
      latest_metadata_sha256: "c".repeat(64),
      immutable_generation: "reviewed-generation",
      bucket: "awardping-visual-snapshots",
      kind: "authoritative_existing_r2_binding",
      captured_at: "2026-08-15T09:30:00.000Z",
      pointer_latest_object_keys_sha256: "d".repeat(64),
      pointer_latest_hashes_sha256: "e".repeat(64),
      verified_roles_sha256: "f".repeat(64),
      semantic_text_sha256: "0".repeat(64),
    },
    recovery_evidence_sha256: sha256(canonicalJson({
      pdf_text_recovery: null,
      prior_recovery: null,
    })),
  };
}

function freshCaptureResult({
  evaluatedAt = "2026-08-15T09:59:00.000Z",
} = {}) {
  const reason = "exact_semantic_and_primary_visual_identity_verified";
  return {
    schema_version: STAGE1_EVIDENCE_SCHEMA_UPGRADE_RESULT_SCHEMA,
    source_id: selectedSourceId,
    mode: "dry_run",
    evaluated_at: evaluatedAt,
    manifest_sha256: manifestSha256,
    source_eligible: true,
    status: "dry_run_ready",
    reason_code: reason,
    eligibility: { status: "eligible" },
    capture_validation: {
      status: "evaluated",
      decision: "eligible_unchanged_upgrade",
      reason,
      evidence: {
        source_id: selectedSourceId,
        local_baseline_identity: {
          sha256: "1".repeat(64),
          byte_length: 1024,
        },
        existing_pointer_identity: {
          schema_version: "awardping.visual-snapshot-pointer.v1",
          exists: true,
          canonical_sha256: "2".repeat(64),
        },
      },
    },
    pointer_journal: { status: "would_commit" },
    visual_review_candidate: { status: "not_planned" },
    quarantine: { status: "not_planned" },
    mutation_counts: zeroStage1EvidenceSchemaUpgradeMutationCounts(),
    queue_policy: { status: "not_applicable" },
    safety: { creates_api_charge: false, mutation_performed: false },
  };
}

function liveSource(overrides = {}) {
  return {
    id: selectedSourceId,
    shared_award_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
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
    admin_reviewed_at: "2026-08-15T09:30:00.000Z",
    admin_reviewed_by: "operator@example.test",
    last_hash: "legacy-visual-hash",
    last_checked_at: "2026-08-15T09:00:00.000Z",
    next_check_at: "2026-08-16T09:00:00.000Z",
    consecutive_failures: 2,
    last_error: "legacy failure",
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-15T09:30:00.000Z",
    shared_awards: {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      name: "Reviewed award",
      status: "active",
      official_homepage: "https://example.test",
    },
    ...overrides,
  };
}

function authorityReceipt({ source = liveSource() } = {}) {
  return stage1EvidenceSchemaUpgradeReviewedApplyAuthorityReceipt({
    source,
    localBaselineIdentity: {
      sha256: "1".repeat(64),
      byte_length: 1024,
    },
    existingPointerIdentity: {
      schema_version: "awardping.visual-snapshot-pointer.v1",
      exists: true,
      canonical_sha256: "2".repeat(64),
    },
    r2BindingReceiptSha256: "4".repeat(64),
    activeJournalSha256: null,
  });
}

function successfulTerminal() {
  const mutationAccounting = sealStage1EvidenceSchemaUpgradeMutationAccounting({
    operation: "pointer_commit",
    lowerBoundCounts: {
      database_writes: 1,
      r2_writes: 3,
      local_baseline_writes: 1,
      candidate_writes: 0,
      quarantine_writes: 0,
      source_state_writes: 1,
    },
    unknownWriteCategories: [],
    evidence: { boundary: "result_built" },
  });
  const commitReceipt = {
    schema_version: STAGE1_EVIDENCE_SCHEMA_UPGRADE_COMMIT_RECEIPT_SCHEMA,
    source_id: selectedSourceId,
    status: "upgraded",
    operation: "pointer_commit",
    creates_api_charge: false,
    journal_archived: true,
    journal_sha256: "f".repeat(64),
    mutation_accounting: mutationAccounting,
  };
  return {
    status: "succeeded",
    selected_result: {
      schema_version: STAGE1_EVIDENCE_SCHEMA_UPGRADE_RESULT_SCHEMA,
      source_id: selectedSourceId,
      status: "upgraded",
      pointer_journal: {
        status: "upgraded",
        receipt: clone(commitReceipt),
      },
    },
    commit_receipt: commitReceipt,
  };
}

function recoveryPlan({
  sourceId = selectedSourceId,
  transactionId = recoveryTransactionId,
  reviewedAt = "2026-08-15T10:00:30.000Z",
  expiresAt = "2026-08-15T12:00:00.000Z",
} = {}) {
  const plan = {
    schema_version:
      "awardping.stage1.evidence-schema-upgrade-reviewed-exact-transaction-recovery-plan.v1",
    apply: { selected_source_id: sourceId },
    audit: {},
    authority: {},
    current_authority: {},
    evidence_observed_at: "2026-08-15T10:00:00.000Z",
    expected_disposition: "candidate_archived_recovery_completed",
    inspection: {
      schema_version:
        "awardping.stage1.evidence-schema-upgrade-reviewed-recovery-inspection.v1",
      mode: "inspect_and_generate_sealed_evidence",
      source_id: sourceId,
      transaction_id: transactionId,
      evidence_observed_at: "2026-08-15T10:00:00.000Z",
      evidence_sha256: "5".repeat(64),
      inspection_file_sha256: "6".repeat(64),
      inspection_sha256: "7".repeat(64),
      proposed_plan_sha256: "8".repeat(64),
    },
    journal: {},
    operation_binding: {},
    reviewer: {
      reviewer_id: "reviewer@example.test",
      reviewed_at: reviewedAt,
      expires_at: expiresAt,
    },
  };
  plan.plan_sha256 = sha256(canonicalJson(plan));
  return plan;
}

function recoveryCompletionAuthority({ plan = recoveryPlan() } = {}) {
  return stage1EvidenceSchemaUpgradeReviewedApplyAuditRecoveryCompletionAuthority({
    recoveryPlan: plan,
    expectedRecoveryPlanFileSha256: "9".repeat(64),
    expectedRecoveryPlanSha256: plan.plan_sha256,
    sourceId: plan.inspection.source_id,
    transactionId: plan.inspection.transaction_id,
  });
}

function memoryStore() {
  let row = null;
  let writes = 0;
  const insertRun = vi.fn(async (candidate) => {
    if (row) throw new Error("duplicate primary key");
    row = clone(candidate);
    writes += 1;
    return clone(row);
  });
  const readRun = vi.fn(async () => clone(row));
  const updateRun = vi.fn(async ({ guard, patch }) => {
    if (
      !row
      || row.id !== guard.id
      || row.status !== guard.status
      || row.metadata.execution_nonce !== guard.execution_nonce
      || row.metadata.binding.plan.file_sha256 !== guard.plan_file_sha256
      || row.metadata.binding.plan.self_sha256 !== guard.plan_sha256
      || row.metadata.metadata_sha256 !== guard.running_metadata_sha256
    ) {
      return null;
    }
    row = { ...row, ...clone(patch) };
    writes += 1;
    return clone(row);
  });
  return {
    interfaces: { insertRun, readRun, updateRun },
    insertRun,
    readRun,
    updateRun,
    get row() {
      return clone(row);
    },
    get writeCount() {
      return writes;
    },
    setRow(value) {
      row = clone(value);
    },
  };
}

async function startAudit({
  store = null,
  interfaces = null,
  plan = reviewedPlan(),
  executionNonce = executionNonceA,
  captureResult = freshCaptureResult(),
  authority = authorityReceipt(),
} = {}) {
  const selectedInterfaces = interfaces || store?.interfaces;
  return startStage1EvidenceSchemaUpgradeReviewedApplyAudit({
    reviewedApplyPlan: plan,
    executionNonce,
    startedAt,
    captureResult,
    authorityReceipt: authority,
    interfaces: selectedInterfaces,
  });
}

async function finishAudit({
  store = null,
  interfaces = null,
  plan = reviewedPlan(),
  executionNonce = executionNonceA,
  terminal = successfulTerminal(),
  completionAuthority =
    stage1EvidenceSchemaUpgradeReviewedApplyAuditFreshCompletionAuthority(),
  finishTime = finishedAt,
} = {}) {
  const selectedInterfaces = interfaces || store?.interfaces;
  return finishStage1EvidenceSchemaUpgradeReviewedApplyAudit({
    reviewedApplyPlan: plan,
    executionNonce,
    finishedAt: finishTime,
    terminal,
    completionAuthority,
    interfaces: selectedInterfaces,
  });
}

function reseal(value, sealKey) {
  const basis = clone(value);
  delete basis[sealKey];
  return sha256(canonicalJson(basis));
}

function clone(value) {
  if (value === null || value === undefined) return value;
  return JSON.parse(JSON.stringify(value));
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function sha256(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}
