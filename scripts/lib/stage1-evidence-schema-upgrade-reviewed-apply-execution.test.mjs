import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_RESULT_SCHEMA,
  stage1EvidenceSchemaUpgradeExpectedManifest,
} from "./stage1-evidence-schema-upgrade.mjs";
import {
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_JOURNAL_ARCHIVE_ACCOUNTING_SCHEMA,
  buildStage1EvidenceSchemaUpgradeReviewedReconciliationEvidence,
} from "./stage1-evidence-schema-upgrade-commit.mjs";
import {
  sealStage1EvidenceSchemaUpgradeMutationAccounting,
  zeroStage1EvidenceSchemaUpgradeMutationCounts,
} from "./stage1-evidence-schema-upgrade-mutation-accounting.mjs";
import {
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_FRESH_VALIDATION_PROJECTION_SCHEMA,
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_PLAN_AUTHORITY,
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_PLAN_SCHEMA,
  stage1EvidenceSchemaUpgradeFreshValidationSha256,
} from "./stage1-evidence-schema-upgrade-reviewed-apply-plan.mjs";
import {
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_EXECUTION_REPORT_SCHEMA,
  runStage1EvidenceSchemaUpgradeReviewedApplyExecution,
  stage1EvidenceSchemaUpgradeReviewedApplyTransactionId,
} from "./stage1-evidence-schema-upgrade-reviewed-apply-execution.mjs";
import {
  stage1EvidenceSchemaUpgradeReviewedAuthorityReceiptSha256,
} from "./stage1-evidence-schema-upgrade-transaction.mjs";
import {
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_AUDIT_ACCOUNTING_SCHEMA,
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_AUDIT_RECEIPT_SCHEMA,
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_AUDIT_RESULT_IDENTITY_SCHEMA,
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_AUDIT_WORKER_NAME,
  finishStage1EvidenceSchemaUpgradeReviewedApplyAudit,
  stage1EvidenceSchemaUpgradeReviewedApplyAuthorityReceipt,
  stage1EvidenceSchemaUpgradeReviewedApplyAuditFreshCompletionAuthority,
  stage1EvidenceSchemaUpgradeReviewedApplyFreshCaptureEvidence,
  stage1EvidenceSchemaUpgradeReviewedApplyAuditRunId,
  startStage1EvidenceSchemaUpgradeReviewedApplyAudit,
} from "./stage1-evidence-schema-upgrade-reviewed-apply-audit.mjs";
import {
  buildLatestOnlyVisualSnapshotPointerReplacement,
  planLatestOnlyVisualSnapshotPointerReconciliation,
  visualSnapshotPointerIdentity,
} from "./visual-snapshot-latest-only-reconciliation.mjs";

const SELECTED_SOURCE_ID = "2ea41875-5c88-5794-81b3-afa8ddaf31c1";
const AUDIT_ID = "11111111-1111-4111-8111-111111111111";
const EXECUTION_NONCE = "33333333-3333-4333-8333-333333333333";
const NOW = "2026-08-15T06:00:00.000Z";

describe("Stage 1 reviewed exact-one apply execution", () => {
  it("orders both authority checks and plan revalidation before the sole business mutation", async () => {
    const fixture = executionFixture();
    const calls = [];
    let commitRequest;
    let finishRequest;
    const interfaces = successfulInterfaces(fixture, calls, {
      onCommit(request) {
        commitRequest = request;
      },
      onFinish(request) {
        finishRequest = request;
      },
    });

    const report = await runExecution(fixture, interfaces);

    expect(calls).toEqual([
      "pre_authority",
      "capture",
      "post_authority",
      "revalidate",
      "start_audit",
      "revalidate",
      "pre_commit_authority",
      "commit",
      "finish_audit",
    ]);
    expect(commitRequest).toMatchObject({
      source_id: SELECTED_SOURCE_ID,
      audit_id: expectedAuditId(fixture),
      execution_nonce: EXECUTION_NONCE,
      reviewed_report_attempt_id: AUDIT_ID,
      transaction_id: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      ),
      capture_validation: {
        decision: "eligible_unchanged_upgrade",
      },
      expected_active_journal_sha256: null,
      expected_old_baseline:
        fixture.validatedPlan.plan.selected.local_baseline_identity,
      expected_old_pointer_identity:
        fixture.validatedPlan.plan.selected.existing_pointer_identity,
      expected_authoritative_r2_binding:
        fixture.validatedPlan.plan.selected.r2,
      creates_api_charge: false,
    });
    const freshCapture =
      stage1EvidenceSchemaUpgradeReviewedApplyFreshCaptureEvidence({
        reviewedApplyPlan: fixture.validatedPlan,
        captureResult: freshCaptureResultFixture(fixture),
      });
    expect(commitRequest.operation_binding).toMatchObject({
      schema_version:
        "awardping.stage1.evidence-schema-upgrade-reviewed-operation-binding.v1",
      source_id: SELECTED_SOURCE_ID,
      transaction_id: commitRequest.transaction_id,
      reviewed_apply_plan_file_sha256:
        fixture.validatedPlan.plan_file_sha256,
      reviewed_apply_plan_sha256: fixture.validatedPlan.plan_sha256,
      audit_run_id: expectedAuditId(fixture),
      execution_nonce: EXECUTION_NONCE,
      reviewed_report_attempt_id: AUDIT_ID,
      fresh_capture_sha256: freshCapture.fresh_capture_sha256,
      fresh_capture_result_sha256: freshCapture.capture_result_sha256,
      fresh_capture_validation_sha256:
        freshCapture.capture_validation_sha256,
      fresh_validation_projection_sha256:
        freshCapture.fresh_validation_projection_sha256,
      precommit_authority_receipt_sha256:
        stage1EvidenceSchemaUpgradeReviewedAuthorityReceiptSha256(
          authorityReceipt(fixture),
        ),
      precommit_source_authority:
        authorityReceipt(fixture).source_authority,
      binding_sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(Object.isFrozen(commitRequest)).toBe(true);
    expect(Object.isFrozen(commitRequest.operation_binding)).toBe(true);
    expect(Object.isFrozen(commitRequest.capture_validation.evidence)).toBe(true);
    expect(finishRequest).toMatchObject({
      executionNonce: EXECUTION_NONCE,
      completionAuthority:
        stage1EvidenceSchemaUpgradeReviewedApplyAuditFreshCompletionAuthority(),
      terminal: {
        status: "succeeded",
        selected_result: {
          schema_version: STAGE1_EVIDENCE_SCHEMA_UPGRADE_RESULT_SCHEMA,
          source_id: SELECTED_SOURCE_ID,
          mode: "apply",
          status: "upgraded",
          pointer_journal: {
            status: "upgraded",
            receipt: finishRequest.terminal.commit_receipt,
          },
        },
      },
    });

    expect(report).toMatchObject({
      schema_version:
        STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_EXECUTION_REPORT_SCHEMA,
      mode: "reviewed_exact_one_apply",
      status: "selected_completed",
      execution_status: "completed",
      selected_source_id: SELECTED_SOURCE_ID,
      selected_source_count: 1,
      deferred_source_count: 8,
      evaluated_source_count: 1,
      completed_source_count: 1,
      blocked_source_count: 0,
      candidate_source_count: 0,
      quarantined_source_count: 0,
      public_fact_write_count: 0,
      hold_clear_count: 0,
      automated_work_clear: false,
      audit: {
        audit_id: expectedAuditId(fixture),
        execution_nonce: EXECUTION_NONCE,
        state: "terminal",
        mutation_accounting: {
          exact: true,
          lower_bound_counts: {
            local_worker_run_inserts: 1,
            local_worker_run_terminal_updates: 1,
          },
          unknown_write_categories: [],
        },
      },
      forbidden_mutations: {
        visual_review_candidates: 0,
        quarantines: 0,
        public_facts: 0,
        hold_clears: 0,
        worker_run_supersessions: 0,
      },
      business_mutation_counts_are_exact: true,
      business_unknown_write_categories: [],
    });
    expect(report.deferred_source_ids).toEqual(
      fixture.manifest.source_ids.filter((id) => id !== SELECTED_SOURCE_ID),
    );
    expect(report.business_mutation_counts).toEqual(successMutationCounts());
    expect(report.report_sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.selected.capture_result.capture_validation.evidence))
      .toBe(true);
  });

  it.each([
    "assertPreCaptureAuthority",
    "captureDryRun",
    "assertPostCaptureAuthority",
    "startAudit",
    "commitUnchangedUpgrade",
    "finishAudit",
  ])("rejects missing %s before any I/O", async (missingName) => {
    const fixture = executionFixture();
    const calls = [];
    const interfaces = successfulInterfaces(fixture, calls);
    delete interfaces[missingName];

    await expect(runExecution(fixture, interfaces))
      .rejects.toThrow(/missing interfaces/u);
    expect(calls).toEqual([]);
  });

  it("requires a separate caller-supplied UUIDv4 execution nonce before I/O", async () => {
    const fixture = executionFixture();
    const calls = [];
    const interfaces = successfulInterfaces(fixture, calls);

    await expect(runStage1EvidenceSchemaUpgradeReviewedApplyExecution({
      source: fixture.source,
      manifest: fixture.manifest,
      validatedPlan: fixture.validatedPlan,
      executionNonce: AUDIT_ID.replace("-4", "-5"),
      interfaces,
      now: () => NOW,
    })).rejects.toThrow(/execution nonce must be one lowercase UUIDv4/u);
    expect(calls).toEqual([]);
  });

  it("rejects historical-only validated plan evidence before any I/O", async () => {
    const fixture = executionFixture();
    const calls = [];
    const interfaces = successfulInterfaces(fixture, calls);
    fixture.validatedPlan.historical_evidence_only = true;

    await expect(runExecution(fixture, interfaces))
      .rejects.toThrow(/refuses historical-only apply-plan evidence/u);
    expect(calls).toEqual([]);
  });

  it("exports the validated deterministic transaction identity used by commit", () => {
    const fixture = executionFixture();
    const input = {
      sourceId: SELECTED_SOURCE_ID,
      planSha256: fixture.validatedPlan.plan_sha256,
    };

    expect(stage1EvidenceSchemaUpgradeReviewedApplyTransactionId(input)).toBe(
      "74f63624-72db-558a-b67a-1bf158a249e7",
    );
    expect(stage1EvidenceSchemaUpgradeReviewedApplyTransactionId(input)).toBe(
      stage1EvidenceSchemaUpgradeReviewedApplyTransactionId(structuredClone(input)),
    );
    expect(() => stage1EvidenceSchemaUpgradeReviewedApplyTransactionId({
      ...input,
      sourceId: "source-1",
    })).toThrow(/source ID.*lowercase UUID/u);
    expect(() => stage1EvidenceSchemaUpgradeReviewedApplyTransactionId({
      ...input,
      planSha256: input.planSha256.toUpperCase(),
    })).toThrow(/plan SHA-256.*lowercase SHA-256/u);
  });

  it("preserves a readback-confirmed audit insert response loss while allowing the bound commit", async () => {
    const fixture = executionFixture();
    const calls = [];
    const interfaces = successfulInterfaces(fixture, calls);
    interfaces.startAudit = async (request) => {
      calls.push("start_audit");
      return auditReceipt({
        request,
        action: "start",
        disposition: "started_after_insert_response_loss",
        businessExecutionAuthorized: true,
        unknown: ["local_worker_run_inserts"],
      });
    };

    const report = await runExecution(fixture, interfaces);

    expect(report.status).toBe("selected_completed");
    expect(report.audit.mutation_accounting).toMatchObject({
      exact: false,
      lower_bound_counts: {
        local_worker_run_inserts: 0,
        local_worker_run_terminal_updates: 1,
      },
      unknown_write_categories: ["local_worker_run_inserts"],
    });
    expect(report.audit.start_receipt).toMatchObject({
      disposition: "started_after_insert_response_loss",
      business_execution_authorized: true,
      audit_mutation_accounting: {
        exact: false,
        unknown_write_categories: ["local_worker_run_inserts"],
      },
    });
    expect(calls).toContain("commit");
  });

  it("rejects a coherently sealed started receipt for a different active execution nonce", async () => {
    const fixture = executionFixture();
    const calls = [];
    const interfaces = successfulInterfaces(fixture, calls);
    interfaces.startAudit = async (request) => {
      calls.push("start_audit");
      return auditReceipt({
        request,
        action: "start",
        disposition: "started",
        businessExecutionAuthorized: true,
        activeExecutionNonce: "44444444-4444-4444-8444-444444444444",
        counts: {
          local_worker_run_inserts: 1,
          local_worker_run_terminal_updates: 0,
        },
      });
    };

    const report = await runExecution(fixture, interfaces);

    expect(report).toMatchObject({
      status: "selected_recovery_required",
      reason_code: "dedicated_audit_start_authority_invalid",
      audit: {
        state: "insert_response_unknown",
        mutation_accounting: {
          exact: true,
          lower_bound_counts: {
            local_worker_run_inserts: 1,
            local_worker_run_terminal_updates: 0,
          },
        },
      },
    });
    expect(calls).not.toContain("commit");
  });

  it("rejects a resealed audit start receipt bound to a different fresh capture", async () => {
    const fixture = executionFixture();
    const calls = [];
    const interfaces = successfulInterfaces(fixture, calls);
    interfaces.startAudit = async (request) => {
      calls.push("start_audit");
      const receipt = auditReceipt({
        request,
        action: "start",
        disposition: "started",
        businessExecutionAuthorized: true,
        counts: {
          local_worker_run_inserts: 1,
          local_worker_run_terminal_updates: 0,
        },
      });
      receipt.fresh_capture_result_sha256 = fixtureSha256(
        "substituted-fresh-capture-result",
      );
      const content = structuredClone(receipt);
      delete content.receipt_sha256;
      receipt.receipt_sha256 = sha256(canonicalJson(content));
      return receipt;
    };

    const report = await runExecution(fixture, interfaces);

    expect(report).toMatchObject({
      status: "selected_recovery_required",
      reason_code: "dedicated_audit_start_authority_invalid",
      audit: { state: "insert_response_unknown" },
      business_mutation_counts: zeroMutationCounts(),
    });
    expect(calls).not.toContain("commit");
  });

  it("rejects a resealed audit start receipt bound to different persisted authority", async () => {
    const fixture = executionFixture();
    const calls = [];
    const interfaces = successfulInterfaces(fixture, calls);
    interfaces.startAudit = async (request) => {
      calls.push("start_audit");
      const receipt = auditReceipt({
        request,
        action: "start",
        disposition: "started",
        businessExecutionAuthorized: true,
        authorityReceiptSha256: fixtureSha256("substituted-authority-receipt"),
        counts: {
          local_worker_run_inserts: 1,
          local_worker_run_terminal_updates: 0,
        },
      });
      return receipt;
    };

    const report = await runExecution(fixture, interfaces);

    expect(report).toMatchObject({
      status: "selected_recovery_required",
      reason_code: "dedicated_audit_start_authority_invalid",
      audit: { state: "insert_response_unknown" },
      business_mutation_counts: zeroMutationCounts(),
    });
    expect(calls).not.toContain("commit");
  });

  it("integrates with the sealed dedicated audit start and finish APIs", async () => {
    const fixture = executionFixture();
    const calls = [];
    const interfaces = successfulInterfaces(fixture, calls);
    let row = null;
    const auditInterfaces = {
      async insertRun(value) {
        row = structuredClone(value);
        return structuredClone(row);
      },
      async readRun() {
        return structuredClone(row);
      },
      async updateRun({ guard, patch }) {
        expect(row).toMatchObject({
          id: guard.id,
          status: guard.status,
          worker_name: guard.worker_name,
        });
        row = { ...row, ...structuredClone(patch) };
        return structuredClone(row);
      },
    };
    interfaces.startAudit = (request) =>
      startStage1EvidenceSchemaUpgradeReviewedApplyAudit({
        ...request,
        interfaces: auditInterfaces,
      });
    interfaces.finishAudit = (request) =>
      finishStage1EvidenceSchemaUpgradeReviewedApplyAudit({
        ...request,
        interfaces: auditInterfaces,
      });

    const report = await runExecution(fixture, interfaces);

    expect(report.status).toBe("selected_completed");
    expect(report.audit.start_receipt).toMatchObject({
      action: "start",
      disposition: "started",
      business_execution_authorized: true,
      run_id: expectedAuditId(fixture),
    });
    expect(report.audit.finish_receipt).toMatchObject({
      action: "finish",
      disposition: "finished",
      terminal_status: "succeeded",
      terminal_failure_sha256: null,
      terminal_completion_authority_mode: "fresh_reviewed_apply",
      terminal_completion_authority_sha256:
        stage1EvidenceSchemaUpgradeReviewedApplyAuditFreshCompletionAuthority()
          .completion_authority_sha256,
      run_id: expectedAuditId(fixture),
    });
    expect(row).toMatchObject({
      id: expectedAuditId(fixture),
      status: "succeeded",
      checked_count: 1,
      changed_count: 1,
      failed_count: 0,
      metadata: {
        authority_receipt: authorityReceipt(fixture),
        authority_receipt_sha256:
          stage1EvidenceSchemaUpgradeReviewedAuthorityReceiptSha256(
            authorityReceipt(fixture),
          ),
      },
    });
  });

  it("preserves a readback-confirmed audit terminal response loss as unknown accounting", async () => {
    const fixture = executionFixture();
    const calls = [];
    const interfaces = successfulInterfaces(fixture, calls);
    interfaces.finishAudit = async (request) => {
      calls.push("finish_audit");
      return auditReceipt({
        request,
        action: "finish",
        disposition: "finished_after_update_response_loss",
        businessExecutionAuthorized: false,
        terminalStatus: request.terminal.status,
        unknown: ["local_worker_run_terminal_updates"],
        captureResult: freshCaptureResultFixture(fixture),
      });
    };

    const report = await runExecution(fixture, interfaces);

    expect(report.status).toBe("selected_completed");
    expect(report.audit.finish_receipt.disposition)
      .toBe("finished_after_update_response_loss");
    expect(report.audit.mutation_accounting).toMatchObject({
      exact: false,
      lower_bound_counts: {
        local_worker_run_inserts: 1,
        local_worker_run_terminal_updates: 0,
      },
      unknown_write_categories: ["local_worker_run_terminal_updates"],
    });
  });

  it("rejects a sealed finish receipt bound to another completion authority", async () => {
    const fixture = executionFixture();
    const calls = [];
    const interfaces = successfulInterfaces(fixture, calls);
    interfaces.finishAudit = async (request) => {
      calls.push("finish_audit");
      return auditReceipt({
        request,
        action: "finish",
        disposition: "finished",
        businessExecutionAuthorized: false,
        terminalStatus: request.terminal.status,
        terminalCompletionAuthority: {
          mode: "reviewed_recovery",
          completion_authority_sha256: fixtureSha256("other-completion-authority"),
        },
        counts: {
          local_worker_run_inserts: 0,
          local_worker_run_terminal_updates: 1,
        },
        captureResult: freshCaptureResultFixture(fixture),
      });
    };

    const report = await runExecution(fixture, interfaces);

    expect(report).toMatchObject({
      status: "selected_recovery_required",
      reason_code: "reviewed_apply_audit_terminal_not_settled",
      audit: { state: "finished" },
    });
  });

  it.each([
    "enqueueVisualReviewCandidate",
    "quarantineEvidenceFailure",
    "writePublicFacts",
    "clearHold",
    "markSupersededWorkerRuns",
  ])("rejects smuggled %s authority before any I/O", async (name) => {
    const fixture = executionFixture();
    const calls = [];
    const interfaces = successfulInterfaces(fixture, calls);
    interfaces[name] = async () => ({ status: "forbidden" });

    await expect(runExecution(fixture, interfaces))
      .rejects.toThrow(/forbids additional interface authority/u);
    expect(calls).toEqual([]);
  });

  it("blocks fresh projection drift with zero business mutation and no audit row", async () => {
    const fixture = executionFixture();
    const calls = [];
    const interfaces = successfulInterfaces(fixture, calls);
    interfaces.captureDryRun = async () => {
      calls.push("capture");
      const drifted = structuredClone(fixture.captureResult);
      drifted.capture_validation.evidence.comparison.semantic_fields.text_hash.current =
        "f".repeat(64);
      return drifted;
    };

    const report = await runExecution(fixture, interfaces);

    expect(calls).toEqual(["pre_authority", "capture"]);
    expect(report).toMatchObject({
      status: "selected_blocked",
      reason_code: "fresh_validation_projection_drift",
      audit: {
        state: "not_started",
        start_receipt: null,
        finish_receipt: null,
        mutation_accounting: {
          exact: true,
          lower_bound_counts: {
            local_worker_run_inserts: 0,
            local_worker_run_terminal_updates: 0,
          },
        },
      },
      business_mutation_counts: zeroMutationCounts(),
      business_mutation_counts_are_exact: true,
    });
  });

  it("accepts only capture-instance timestamp and prospective layout-hash variance", async () => {
    const fixture = executionFixture();
    const calls = [];
    let commitRequest;
    fixture.captureResult.capture_validation.evidence.capture.layout_hash =
      fixtureSha256("fresh-capture-instance-layout");
    const freshCaptureResult = freshCaptureResultFixture(fixture);
    const freshCaptureEvidence =
      stage1EvidenceSchemaUpgradeReviewedApplyFreshCaptureEvidence({
        reviewedApplyPlan: fixture.validatedPlan,
        captureResult: freshCaptureResult,
      });

    const report = await runExecution(
      fixture,
      successfulInterfaces(fixture, calls, {
        onCommit(request) {
          commitRequest = request;
        },
      }),
    );

    expect(calls).toEqual([
      "pre_authority",
      "capture",
      "post_authority",
      "revalidate",
      "start_audit",
      "revalidate",
      "pre_commit_authority",
      "commit",
      "finish_audit",
    ]);
    expect(report).toMatchObject({
      status: "selected_completed",
      reason_code: "reviewed_unchanged_upgrade_committed",
      selected_source_count: 1,
      automated_work_clear: false,
    });
    expect(commitRequest.capture_validation.evidence.capture.layout_hash)
      .toBe(fixtureSha256("fresh-capture-instance-layout"));
    expect(report.audit.start_receipt).toMatchObject({
      fresh_capture_result_sha256: freshCaptureEvidence.capture_result_sha256,
      fresh_capture_validation_sha256: freshCaptureEvidence.capture_validation_sha256,
      fresh_validation_projection_sha256:
        fixture.validatedPlan.fresh_validation_projection_sha256,
    });
  });

  it("blocks a candidate or quarantine capture decision before post-capture authority", async () => {
    const fixture = executionFixture();
    const calls = [];
    const interfaces = successfulInterfaces(fixture, calls);
    interfaces.captureDryRun = async () => {
      calls.push("capture");
      const smuggled = structuredClone(fixture.captureResult);
      smuggled.capture_validation.decision = "material_difference_candidate";
      smuggled.visual_review_candidate = { status: "would_queue" };
      return smuggled;
    };

    const report = await runExecution(fixture, interfaces);

    expect(calls).toEqual(["pre_authority", "capture"]);
    expect(report.status).toBe("selected_blocked");
    expect(report.reason_code).toBe("fresh_validation_not_exact_unchanged_upgrade");
    expect(report.candidate_source_count).toBe(0);
    expect(report.quarantined_source_count).toBe(0);
    expect(report.audit.state).toBe("not_started");
  });

  it("does not create an audit row when post-capture authority has drifted", async () => {
    const fixture = executionFixture();
    const calls = [];
    const interfaces = successfulInterfaces(fixture, calls);
    interfaces.assertPostCaptureAuthority = async () => {
      calls.push("post_authority");
      throw Object.assign(new Error("Pointer changed."), {
        code: "post_capture_pointer_drift",
      });
    };

    const report = await runExecution(fixture, interfaces);

    expect(calls).toEqual(["pre_authority", "capture", "post_authority"]);
    expect(report).toMatchObject({
      status: "selected_blocked",
      reason_code: "post_capture_pointer_drift",
      audit: { state: "not_started" },
      business_mutation_counts: zeroMutationCounts(),
    });
  });

  it("rejects a coherently resealed authority receipt for a different live source projection", async () => {
    const fixture = executionFixture();
    const calls = [];
    const interfaces = successfulInterfaces(fixture, calls);
    interfaces.assertPostCaptureAuthority = async () => {
      calls.push("post_authority");
      return authorityReceipt(fixture, {
        ...fixture.source,
        url: "https://example.com/reassigned",
      });
    };

    const report = await runExecution(fixture, interfaces);

    expect(calls).toEqual(["pre_authority", "capture", "post_authority"]);
    expect(report).toMatchObject({
      status: "selected_blocked",
      reason_code: "reviewed_source_authority_receipt_invalid",
      audit: { state: "not_started" },
      business_mutation_counts: zeroMutationCounts(),
    });
  });

  it("blocks plan substitution or expiry after capture and before the audit insert", async () => {
    const fixture = executionFixture();
    const calls = [];
    const interfaces = successfulInterfaces(fixture, calls);
    interfaces.revalidatePlan = async () => {
      calls.push("revalidate");
      const substituted = structuredClone(fixture.validatedPlan);
      substituted.plan_sha256 = "9".repeat(64);
      return substituted;
    };

    const substituted = await runExecution(fixture, interfaces);
    expect(calls).toEqual([
      "pre_authority",
      "capture",
      "post_authority",
      "revalidate",
    ]);
    expect(substituted).toMatchObject({
      status: "selected_blocked",
      reason_code: "reviewed_apply_plan_revalidation_drift",
      audit: { state: "not_started" },
    });

    const expiredFixture = executionFixture();
    expiredFixture.validatedPlan.reviewer.expires_at = NOW;
    expiredFixture.validatedPlan.plan.reviewer = structuredClone(
      expiredFixture.validatedPlan.reviewer,
    );
    const expiredCalls = [];
    const expiredInterfaces = successfulInterfaces(expiredFixture, expiredCalls);
    const expired = await runExecution(expiredFixture, expiredInterfaces);
    expect(expiredCalls).toEqual([
      "pre_authority",
      "capture",
      "post_authority",
      "revalidate",
    ]);
    expect(expired).toMatchObject({
      status: "selected_blocked",
      reason_code: "reviewed_apply_plan_expired",
      audit: { state: "not_started" },
    });
  });

  it("expires during audit start, skips commit, and terminalizes the proven zero-mutation failure", async () => {
    const fixture = executionFixture();
    fixture.validatedPlan.reviewer.expires_at = "2026-08-15T06:00:01.000Z";
    fixture.validatedPlan.plan.reviewer = structuredClone(
      fixture.validatedPlan.reviewer,
    );
    const calls = [];
    const interfaces = successfulInterfaces(fixture, calls);
    let finishTerminal;
    const finishAudit = interfaces.finishAudit;
    interfaces.finishAudit = async (request) => {
      finishTerminal = request.terminal;
      return finishAudit(request);
    };
    const times = [
      "2026-08-15T06:00:00.000Z",
      "2026-08-15T06:00:00.500Z",
      "2026-08-15T06:00:01.000Z",
      "2026-08-15T06:00:01.001Z",
      "2026-08-15T06:00:01.002Z",
    ];
    let timeIndex = 0;

    const report = await runStage1EvidenceSchemaUpgradeReviewedApplyExecution({
      source: fixture.source,
      manifest: fixture.manifest,
      validatedPlan: fixture.validatedPlan,
      executionNonce: EXECUTION_NONCE,
      interfaces,
      now: () => times[Math.min(timeIndex++, times.length - 1)],
    });

    expect(calls).toEqual([
      "pre_authority",
      "capture",
      "post_authority",
      "revalidate",
      "start_audit",
      "revalidate",
      "finish_audit",
    ]);
    expect(report).toMatchObject({
      status: "selected_blocked",
      reason_code: "reviewed_apply_plan_expired",
      business_mutation_counts: zeroMutationCounts(),
      selected: { commit: { status: "not_started" } },
      audit: { state: "terminal" },
    });
    expect(finishTerminal).toMatchObject({
      status: "failed",
      error_code: "reviewed_apply_plan_expired",
    });
  });

  it("rechecks full source authority after audit start and skips commit on drift", async () => {
    const fixture = executionFixture();
    const calls = [];
    const interfaces = successfulInterfaces(fixture, calls);
    const assertAuthority = interfaces.assertPostCaptureAuthority;
    interfaces.assertPostCaptureAuthority = async (request) => {
      if (request.phase === "pre_commit") {
        calls.push("pre_commit_authority");
        throw Object.assign(new Error("Source finalization changed during audit I/O."), {
          code: "reviewed_source_activation_authority_changed",
        });
      }
      return assertAuthority(request);
    };
    let finishTerminal;
    const finishAudit = interfaces.finishAudit;
    interfaces.finishAudit = async (request) => {
      finishTerminal = request.terminal;
      return finishAudit(request);
    };

    const report = await runExecution(fixture, interfaces);

    expect(calls).toEqual([
      "pre_authority",
      "capture",
      "post_authority",
      "revalidate",
      "start_audit",
      "revalidate",
      "pre_commit_authority",
      "finish_audit",
    ]);
    expect(report).toMatchObject({
      status: "selected_blocked",
      reason_code: "reviewed_source_activation_authority_changed",
      business_mutation_counts: zeroMutationCounts(),
      authority_assertions: {
        pre_commit_receipt_sha256: null,
      },
      selected: { commit: { status: "not_started" } },
      audit: { state: "terminal" },
    });
    expect(finishTerminal).toMatchObject({
      status: "failed",
      error_code: "reviewed_source_activation_authority_changed",
    });
  });

  it("blocks a sealed zero-mutation commit failure and terminalizes its audit", async () => {
    const fixture = executionFixture();
    const calls = [];
    const interfaces = successfulInterfaces(fixture, calls);
    interfaces.commitUnchangedUpgrade = async () => {
      calls.push("commit");
      const error = Object.assign(new Error("Preimage changed before journal creation."), {
        code: "reviewed_old_baseline_changed",
      });
      error.stage1_mutation_accounting = sealAccounting({
        counts: zeroMutationCounts(),
        evidence: {
          boundary: "before_io",
          journal_phase: null,
          response_loss_possible: false,
          journal_persistence: {
            state: "not_started",
            local_journal_writes_lower_bound: 0,
            response_loss_possible: false,
          },
        },
      });
      throw error;
    };

    const report = await runExecution(fixture, interfaces);

    expect(calls).toEqual([
      "pre_authority",
      "capture",
      "post_authority",
      "revalidate",
      "start_audit",
      "revalidate",
      "pre_commit_authority",
      "commit",
      "finish_audit",
    ]);
    expect(report).toMatchObject({
      status: "selected_blocked",
      reason_code: "reviewed_old_baseline_changed",
      business_mutation_counts: zeroMutationCounts(),
      business_mutation_counts_are_exact: true,
      audit: {
        state: "terminal",
        mutation_accounting: {
          exact: true,
          lower_bound_counts: {
            local_worker_run_inserts: 1,
            local_worker_run_terminal_updates: 1,
          },
        },
      },
      selected: {
        commit: { status: "failed" },
      },
    });
  });

  it("accepts only an exact same-authority terminal failure replay", async () => {
    const fixture = executionFixture();
    const calls = [];
    const interfaces = successfulInterfaces(fixture, calls);
    interfaces.commitUnchangedUpgrade = async () => {
      calls.push("commit");
      const error = Object.assign(new Error("Preimage changed before journal creation."), {
        code: "reviewed_old_baseline_changed",
      });
      error.stage1_mutation_accounting = sealAccounting({
        counts: zeroMutationCounts(),
        evidence: {
          boundary: "before_io",
          journal_phase: null,
          response_loss_possible: false,
          journal_persistence: {
            state: "not_started",
            local_journal_writes_lower_bound: 0,
            response_loss_possible: false,
          },
        },
      });
      throw error;
    };
    interfaces.finishAudit = async (request) => {
      calls.push("finish_audit");
      return auditReceipt({
        request,
        action: "finish",
        disposition: "terminal_failure_replay",
        businessExecutionAuthorized: false,
        replay: true,
        activeExecutionNonce: "44444444-4444-4444-8444-444444444444",
        terminalStatus: "failed",
        captureResult: freshCaptureResultFixture(fixture),
      });
    };

    const report = await runExecution(fixture, interfaces);

    expect(report).toMatchObject({
      status: "selected_blocked",
      reason_code: "reviewed_old_baseline_changed",
      audit: {
        state: "terminal",
        finish_receipt: {
          disposition: "terminal_failure_replay",
          replay: true,
          terminal_completion_authority_mode: "fresh_reviewed_apply",
          terminal_failure_sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
        },
      },
    });
  });

  it("rejects a malformed upgraded receipt and leaves its recovery audit open", async () => {
    const fixture = executionFixture();
    const calls = [];
    const interfaces = successfulInterfaces(fixture, calls);
    interfaces.commitUnchangedUpgrade = async (request) => {
      calls.push("commit");
      const malformed = successfulCommitResult(request);
      malformed.receipt.journal_archived = false;
      return malformed;
    };
    const report = await runExecution(fixture, interfaces);

    expect(report).toMatchObject({
      status: "selected_recovery_required",
      reason_code: "reviewed_commit_success_receipt_invalid",
      business_mutation_counts: successMutationCounts(),
      business_mutation_counts_are_exact: true,
      selected: {
        commit: { status: "commit_authority_unproven" },
      },
      audit: { state: "running_recovery_required" },
    });
    expect(calls.at(-1)).toBe("commit");
    expect(calls).not.toContain("finish_audit");
  });

  it.each(["upgraded", "abandoned_old_authority"])(
    "refuses to terminalize %s without exact verified journal-archive accounting",
    async (status) => {
      const fixture = executionFixture();
      const calls = [];
      const interfaces = successfulInterfaces(fixture, calls);
      interfaces.commitUnchangedUpgrade = async (request) => {
        calls.push("commit");
        const result = status === "abandoned_old_authority"
          ? abandonedCommitResult(request)
          : successfulCommitResult(request);
        const accounting = sealAccounting({
          counts: result.mutation_counts,
          evidence: {
            boundary:
              "completed_journal_archive_write_acknowledged_readback_unverified",
            response_loss_possible: true,
            journal_archive: journalArchiveAccounting({
              state: "archive_write_acknowledged_readback_unverified",
              archivedReadbackVerified: false,
              activeAbsenceVerified: false,
              responseLossPossible: true,
            }),
            cas: result.receipt.cas,
          },
        });
        result.mutation_accounting = accounting;
        result.receipt.mutation_accounting = accounting;
        return result;
      };

      const report = await runExecution(fixture, interfaces);

      expect(report).toMatchObject({
        status: "selected_recovery_required",
        reason_code: "reviewed_commit_archive_not_verified",
        selected: { commit: { status: "commit_authority_unproven" } },
        audit: { state: "running_recovery_required" },
      });
      expect(calls.at(-1)).toBe("commit");
      expect(calls).not.toContain("finish_audit");
    },
  );

  it("retains a valid non-verified archive state on an exact recovery-required result", async () => {
    const fixture = executionFixture();
    const calls = [];
    const interfaces = successfulInterfaces(fixture, calls);
    interfaces.commitUnchangedUpgrade = async (request) => {
      calls.push("commit");
      const result = successfulCommitResult(request);
      const counts = zeroMutationCounts();
      const cas = {
        attempted: true,
        returned: false,
        threw: false,
        recovered: false,
        error_code: null,
        error_message: null,
        confirmed_database_pointer_writes: 0,
        write_attribution: "confirmed_not_written_by_this_cas",
      };
      const accounting = sealAccounting({
        counts,
        evidence: {
          boundary: "completed_journal_archive_write_response_unknown",
          response_loss_possible: true,
          journal_archive: journalArchiveAccounting({
            state: "archive_write_response_unknown",
            localJournalArchiveWritesLowerBound: 0,
            archiveReceiptAcknowledged: false,
            archivedReadbackVerified: false,
            activeAbsenceVerified: false,
            responseLossPossible: true,
          }),
          cas,
        },
      });
      result.status = "recovery_required";
      result.mutation_counts = counts;
      result.mutation_accounting = accounting;
      result.receipt.status = "recovery_required";
      result.receipt.outcome = "archive_response_unknown";
      result.receipt.journal_phase = "completed";
      result.receipt.journal_archived = false;
      result.receipt.authoritative_pointer_sha256 = null;
      result.receipt.authoritative_baseline_sha256 = null;
      result.receipt.cas = cas;
      result.receipt.source_health = null;
      result.receipt.mutation_counts = counts;
      result.receipt.mutation_accounting = accounting;
      return result;
    };

    const report = await runExecution(fixture, interfaces);

    expect(report).toMatchObject({
      status: "selected_recovery_required",
      reason_code: "reviewed_unchanged_upgrade_recovery_required",
      business_mutation_counts: zeroMutationCounts(),
      selected: { commit: { status: "recovery_required" } },
      audit: { state: "running_recovery_required" },
    });
    expect(calls).not.toContain("finish_audit");
  });

  it("terminalizes an exactly proven abandoned-old-authority result as failed", async () => {
    const fixture = executionFixture();
    const calls = [];
    const interfaces = successfulInterfaces(fixture, calls);
    let finishTerminal;
    interfaces.commitUnchangedUpgrade = async (request) => {
      calls.push("commit");
      return abandonedCommitResult(request);
    };
    const finishAudit = interfaces.finishAudit;
    interfaces.finishAudit = async (request) => {
      finishTerminal = request.terminal;
      return finishAudit(request);
    };

    const report = await runExecution(fixture, interfaces);

    expect(report).toMatchObject({
      status: "selected_blocked",
      reason_code: "reviewed_unchanged_upgrade_old_authority_preserved",
      selected: { commit: { status: "abandoned_old_authority" } },
      audit: { state: "terminal" },
    });
    expect(finishTerminal).toMatchObject({
      status: "failed",
      error_code: "reviewed_unchanged_upgrade_old_authority_preserved",
    });
    expect(calls.at(-1)).toBe("finish_audit");
  });

  it.each([
    ["upgraded", "candidate_keys"],
    ["upgraded", "protected_keys"],
    ["upgraded", "deferred_keys"],
    ["abandoned_old_authority", "candidate_keys"],
    ["abandoned_old_authority", "protected_keys"],
    ["abandoned_old_authority", "deferred_keys"],
  ])(
    "rejects forged %s cleanup-debt %s before audit terminalization",
    async (status, field) => {
      const fixture = executionFixture();
      const calls = [];
      const interfaces = successfulInterfaces(fixture, calls);
      interfaces.commitUnchangedUpgrade = async (request) => {
        calls.push("commit");
        const result = status === "upgraded"
          ? successfulCommitResult(request)
          : abandonedCommitResult(request);
        result.receipt.cleanup_debt[field] = ["attacker/forged-object"];
        if (field === "candidate_keys") {
          result.receipt.cleanup_debt.item_count = 1;
        }
        return result;
      };

      const report = await runExecution(fixture, interfaces);

      expect(report).toMatchObject({
        status: "selected_recovery_required",
        reason_code: "reviewed_commit_cleanup_debt_invalid",
        selected: { commit: { status: "commit_authority_unproven" } },
        audit: { state: "running_recovery_required" },
      });
      expect(calls.at(-1)).toBe("commit");
      expect(calls).not.toContain("finish_audit");
    },
  );

  it.each(["upgraded", "abandoned_old_authority"])(
    "requires sealed journal pointer evidence for terminal %s",
    async (status) => {
      const fixture = executionFixture();
      const calls = [];
      const interfaces = successfulInterfaces(fixture, calls);
      interfaces.commitUnchangedUpgrade = async (request) => {
        calls.push("commit");
        const result = status === "upgraded"
          ? successfulCommitResult(request)
          : abandonedCommitResult(request);
        delete result.reviewed_reconciliation_evidence;
        return result;
      };

      const report = await runExecution(fixture, interfaces);

      expect(report).toMatchObject({
        status: "selected_recovery_required",
        reason_code: "reviewed_commit_reconciliation_evidence_missing",
        selected: { commit: { status: "commit_authority_unproven" } },
        audit: { state: "running_recovery_required" },
      });
      expect(calls).not.toContain("finish_audit");
    },
  );

  it.each([
    ["CAS semantics", "reviewed_commit_cas_invalid", (result) => {
      const forgedCas = {
        ...result.receipt.cas,
        confirmed_database_pointer_writes: 0,
      };
      result.receipt.cas = forgedCas;
      const counts = {
        ...result.mutation_counts,
        database_writes: 1,
      };
      replaceReviewedResultAccounting(result, counts, forgedCas);
    }],
    ["CAS/source count attribution", "reviewed_commit_mutation_attribution_invalid", (result) => {
      const counts = {
        ...result.mutation_counts,
        database_writes: 3,
      };
      replaceReviewedResultAccounting(result, counts, result.receipt.cas);
    }],
    ["source-health status/count profile", "reviewed_commit_source_health_invalid", (result) => {
      result.receipt.source_health.mutation_counts = zeroMutationCounts();
      const counts = {
        ...result.mutation_counts,
        database_writes: 1,
        source_state_writes: 0,
      };
      replaceReviewedResultAccounting(result, counts, result.receipt.cas);
    }],
  ])(
    "rejects coherently resealed invalid %s before audit terminalization",
    async (_label, reasonCode, mutate) => {
      const fixture = executionFixture();
      const calls = [];
      const interfaces = successfulInterfaces(fixture, calls);
      interfaces.commitUnchangedUpgrade = async (request) => {
        calls.push("commit");
        const result = successfulCommitResult(request);
        mutate(result);
        return result;
      };

      const report = await runExecution(fixture, interfaces);

      expect(report).toMatchObject({
        status: "selected_recovery_required",
        reason_code: reasonCode,
        selected: { commit: { status: "commit_authority_unproven" } },
        audit: { state: "running_recovery_required" },
      });
      expect(calls.at(-1)).toBe("commit");
      expect(calls).not.toContain("finish_audit");
    },
  );

  it("keeps a malformed abandoned-old-authority claim in recovery with its audit open", async () => {
    const fixture = executionFixture();
    const calls = [];
    const interfaces = successfulInterfaces(fixture, calls);
    interfaces.commitUnchangedUpgrade = async (request) => {
      calls.push("commit");
      const malformed = abandonedCommitResult(request);
      malformed.receipt.journal_archived = false;
      return malformed;
    };

    const report = await runExecution(fixture, interfaces);

    expect(report).toMatchObject({
      status: "selected_recovery_required",
      reason_code: "reviewed_commit_abandoned_receipt_invalid",
      selected: { commit: { status: "commit_authority_unproven" } },
      audit: { state: "running_recovery_required" },
    });
    expect(calls.at(-1)).toBe("commit");
    expect(calls).not.toContain("finish_audit");
  });

  it("keeps a malformed raw recovery-required result in recovery with exact zero accounting", async () => {
    const fixture = executionFixture();
    const calls = [];
    const interfaces = successfulInterfaces(fixture, calls);
    interfaces.commitUnchangedUpgrade = async (request) => {
      calls.push("commit");
      const malformed = successfulCommitResult(request);
      const counts = zeroMutationCounts();
      const accounting = sealAccounting({ counts });
      malformed.status = "recovery_required";
      malformed.mutation_counts = counts;
      malformed.mutation_accounting = accounting;
      malformed.receipt.status = "recovery_required";
      malformed.receipt.journal_archived = false;
      malformed.receipt.authoritative_pointer_sha256 = null;
      malformed.receipt.authoritative_baseline_sha256 = null;
      malformed.receipt.mutation_counts = counts;
      malformed.receipt.mutation_accounting = accounting;
      malformed.receipt.unreviewed_extra_authority = true;
      return malformed;
    };
    const report = await runExecution(fixture, interfaces);

    expect(report).toMatchObject({
      status: "selected_recovery_required",
      execution_status: "recovery_required",
      reason_code: "reviewed_unchanged_upgrade_authority_unresolved",
      business_mutation_counts: zeroMutationCounts(),
      business_mutation_counts_are_exact: true,
      selected: {
        commit: { status: "commit_authority_unproven" },
      },
      audit: { state: "running_recovery_required" },
    });
    expect(calls).not.toContain("finish_audit");
  });

  it("leaves an exact recovery-required commit result on its running audit row", async () => {
    const fixture = executionFixture();
    const calls = [];
    const interfaces = successfulInterfaces(fixture, calls);
    interfaces.commitUnchangedUpgrade = async (request) => {
      calls.push("commit");
      const result = successfulCommitResult(request);
      result.status = "recovery_required";
      result.receipt.status = "recovery_required";
      result.receipt.outcome = "ambiguous_authority";
      result.receipt.journal_phase = "recovery_required";
      result.receipt.journal_archived = false;
      result.receipt.authoritative_pointer_state = "unreadable";
      result.receipt.authoritative_baseline_state = "candidate";
      result.receipt.authoritative_pointer_sha256 = null;
      result.receipt.authoritative_baseline_sha256 = null;
      return result;
    };

    const report = await runExecution(fixture, interfaces);

    expect(report).toMatchObject({
      status: "selected_recovery_required",
      reason_code: "reviewed_unchanged_upgrade_recovery_required",
      selected: { commit: { status: "recovery_required" } },
      audit: {
        state: "running_recovery_required",
        finish_receipt: null,
      },
    });
    expect(calls.at(-1)).toBe("commit");
    expect(calls).not.toContain("finish_audit");
  });

  it("keeps a thrown exact-nonzero commit failure in recovery with its audit open", async () => {
    const fixture = executionFixture();
    const calls = [];
    const interfaces = successfulInterfaces(fixture, calls);
    const lowerBounds = {
      ...zeroMutationCounts(),
      database_writes: 1,
      local_baseline_writes: 1,
    };
    interfaces.commitUnchangedUpgrade = async () => {
      calls.push("commit");
      const error = Object.assign(
        new Error("Commit failed after confirmed authority-affecting writes."),
        { code: "confirmed_commit_writes_authority_unresolved" },
      );
      error.stage1_mutation_accounting = sealAccounting({ counts: lowerBounds });
      throw error;
    };
    const report = await runExecution(fixture, interfaces);

    expect(report).toMatchObject({
      status: "selected_recovery_required",
      reason_code: "confirmed_commit_writes_authority_unresolved",
      business_mutation_counts: lowerBounds,
      business_mutation_counts_are_exact: true,
      selected: {
        commit: { status: "confirmed_mutations_authority_unresolved" },
      },
      audit: { state: "running_recovery_required" },
    });
    expect(calls.at(-1)).toBe("commit");
    expect(calls).not.toContain("finish_audit");
  });

  it("keeps an acknowledged journal write with zero business counts in recovery", async () => {
    const fixture = executionFixture();
    const calls = [];
    const interfaces = successfulInterfaces(fixture, calls);
    interfaces.commitUnchangedUpgrade = async () => {
      calls.push("commit");
      const error = Object.assign(
        new Error("The acknowledged active journal could not be read back."),
        { code: "active_journal_readback_unavailable" },
      );
      error.stage1_mutation_accounting = sealAccounting({
        counts: zeroMutationCounts(),
        evidence: {
          boundary: "active_journal_write_acknowledged_readback_unverified",
          journal_phase: "prepared",
          response_loss_possible: false,
          journal_persistence: {
            state: "write_acknowledged_readback_unverified",
            local_journal_writes_lower_bound: 1,
            response_loss_possible: false,
          },
        },
      });
      throw error;
    };

    const report = await runExecution(fixture, interfaces);

    expect(report).toMatchObject({
      status: "selected_recovery_required",
      reason_code: "active_journal_readback_unavailable",
      business_mutation_counts: zeroMutationCounts(),
      business_mutation_counts_are_exact: true,
      business_mutation_accounting: {
        evidence: {
          journal_persistence: {
            state: "write_acknowledged_readback_unverified",
            local_journal_writes_lower_bound: 1,
          },
        },
      },
      selected: {
        commit: { status: "journal_persistence_authority_unresolved" },
      },
      audit: { state: "running_recovery_required" },
    });
    expect(calls).not.toContain("finish_audit");
  });

  it("preserves sealed lower bounds and unknown writes after commit response loss", async () => {
    const fixture = executionFixture();
    const calls = [];
    const interfaces = successfulInterfaces(fixture, calls);
    const lowerBounds = {
      ...zeroMutationCounts(),
      database_writes: 1,
      r2_writes: 2,
    };
    interfaces.commitUnchangedUpgrade = async () => {
      calls.push("commit");
      const error = Object.assign(new Error("Connection dropped after write dispatch."), {
        code: "pointer_commit_response_lost",
      });
      error.stage1_mutation_accounting = sealAccounting({
        counts: lowerBounds,
        unknown: ["local_baseline_writes"],
      });
      throw error;
    };

    const report = await runExecution(fixture, interfaces);

    expect(report).toMatchObject({
      status: "selected_recovery_required",
      execution_status: "recovery_required",
      reason_code: "pointer_commit_response_lost",
      business_mutation_counts: lowerBounds,
      business_mutation_counts_are_exact: false,
      business_mutation_count_semantics:
        "confirmed_lower_bounds_with_unknown_writes",
      business_unknown_write_categories: ["local_baseline_writes"],
      audit: {
        state: "running_recovery_required",
        mutation_accounting: {
          lower_bound_counts: {
            local_worker_run_inserts: 1,
            local_worker_run_terminal_updates: 0,
          },
        },
      },
      selected: {
        commit: { status: "response_unknown" },
      },
    });
    expect(report.business_mutation_accounting.accounting_sha256)
      .toBe(sealAccounting({
        counts: lowerBounds,
        unknown: ["local_baseline_writes"],
      }).accounting_sha256);
    expect(calls.at(-1)).toBe("commit");
    expect(calls).not.toContain("finish_audit");
  });

  it("treats an unsealed commit exception as response loss across every business category", async () => {
    const fixture = executionFixture();
    const calls = [];
    const interfaces = successfulInterfaces(fixture, calls);
    interfaces.commitUnchangedUpgrade = async () => {
      calls.push("commit");
      throw new Error("Socket closed.");
    };

    const report = await runExecution(fixture, interfaces);

    expect(report.status).toBe("selected_recovery_required");
    expect(report.business_mutation_counts).toEqual(zeroMutationCounts());
    expect(report.business_unknown_write_categories).toEqual(
      Object.keys(zeroMutationCounts()).sort(),
    );
    expect(report.business_mutation_counts_are_exact).toBe(false);
  });

  it("blocks a prior active journal before capture, audit, or business mutation", async () => {
    const fixture = executionFixture();
    const calls = [];
    const interfaces = successfulInterfaces(fixture, calls);
    interfaces.assertPreCaptureAuthority = async () => {
      calls.push("pre_authority");
      throw Object.assign(new Error("An active journal exists."), {
        code: "active_upgrade_journal_present",
      });
    };

    const report = await runExecution(fixture, interfaces);

    expect(calls).toEqual(["pre_authority"]);
    expect(report).toMatchObject({
      status: "selected_blocked",
      reason_code: "active_upgrade_journal_present",
      evaluated_source_count: 0,
      business_mutation_counts: zeroMutationCounts(),
      audit: {
        state: "not_started",
        mutation_accounting: {
          lower_bound_counts: {
            local_worker_run_inserts: 0,
            local_worker_run_terminal_updates: 0,
          },
        },
      },
    });
  });

  it("fails closed when audit start discovers prior success too late to claim no-capture idempotency", async () => {
    const fixture = executionFixture();
    const calls = [];
    const interfaces = successfulInterfaces(fixture, calls);
    interfaces.startAudit = async (request) => {
      calls.push("start_audit");
      return auditReceipt({
        request,
        action: "start",
        disposition: "prior_terminal_success_replay",
        businessExecutionAuthorized: false,
        replay: true,
        terminalStatus: "succeeded",
        terminalIdentitySha256: fixtureSha256("prior-terminal-identity"),
      });
    };

    const report = await runExecution(fixture, interfaces);

    expect(calls).toEqual([
      "pre_authority",
      "capture",
      "post_authority",
      "revalidate",
      "start_audit",
    ]);
    expect(report).toMatchObject({
      status: "selected_blocked",
      reason_code: "prior_success_detected_after_capture_replay_refused",
      business_mutation_counts: zeroMutationCounts(),
      audit: {
        state: "prior_success_detected",
        mutation_accounting: {
          lower_bound_counts: {
            local_worker_run_inserts: 0,
            local_worker_run_terminal_updates: 0,
          },
        },
      },
    });
  });

  it("retains business accounting when the terminal audit update loses its response", async () => {
    const fixture = executionFixture();
    const calls = [];
    const interfaces = successfulInterfaces(fixture, calls);
    interfaces.finishAudit = async () => {
      calls.push("finish_audit");
      throw new Error("Audit update response lost.");
    };

    const report = await runExecution(fixture, interfaces);

    expect(report).toMatchObject({
      status: "selected_recovery_required",
      reason_code: "audit_terminal_update_response_unknown",
      business_mutation_counts: successMutationCounts(),
      business_mutation_counts_are_exact: true,
      audit: {
        state: "terminal_update_response_unknown",
        mutation_accounting: {
          exact: false,
          lower_bound_counts: {
            local_worker_run_inserts: 1,
            local_worker_run_terminal_updates: 0,
          },
          unknown_write_categories: ["local_worker_run_terminal_updates"],
        },
      },
    });
  });
});

function reviewedPointerFixtures({ sourceId, sharedAwardId }) {
  const oldGeneration = "a".repeat(32);
  const candidateGeneration = "b".repeat(32);
  const prefix = `visual-snapshots/sources/${sourceId}/captures`;
  const old = {
    shared_award_source_id: sourceId,
    shared_award_id: sharedAwardId,
    source_url: "https://example.com/faq",
    source_title: "Reviewed FAQ",
    source_page_type: "faq",
    kind: "webpage",
    bucket: "reviewed-fixture-bucket",
    latest_captured_at: "2026-08-14T18:00:00.000Z",
    latest_object_keys: {
      layout: `${prefix}/${oldGeneration}/layout.json`,
      meta: `${prefix}/${oldGeneration}/meta.json`,
      page: `${prefix}/${oldGeneration}/page.jpg`,
      text: `${prefix}/${oldGeneration}/text.txt`,
      thumb: `${prefix}/${oldGeneration}/thumb.jpg`,
    },
    latest_hashes: {
      image_hash: fixtureSha256("old-image"),
      layout_hash: fixtureSha256("old-layout"),
      text_hash: fixtureSha256("old-text"),
    },
    latest_metadata: {
      artifact_bindings_schema: "awardping.r2.capture-artifact-bindings.v1",
      immutable_generation: oldGeneration,
    },
    previous_captured_at: null,
    previous_object_keys: {},
    previous_hashes: {},
    previous_metadata: {},
    updated_at: "2026-08-14T18:00:00.000Z",
  };
  const candidate = buildLatestOnlyVisualSnapshotPointerReplacement({
    existing: old,
    replacement: {
      latest_captured_at: "2026-08-15T05:44:00.000Z",
      latest_object_keys: {
        layout: `${prefix}/${candidateGeneration}/layout.json`,
        meta: `${prefix}/${candidateGeneration}/meta.json`,
        page: `${prefix}/${candidateGeneration}/page.jpg`,
        text: `${prefix}/${candidateGeneration}/text.txt`,
        thumb: `${prefix}/${candidateGeneration}/thumb.jpg`,
      },
      latest_hashes: {
        image_hash: fixtureSha256("candidate-image"),
        layout_hash: fixtureSha256("candidate-layout"),
        text_hash: fixtureSha256("candidate-text"),
      },
      latest_metadata: {
        artifact_bindings_schema: "awardping.r2.capture-artifact-bindings.v1",
        immutable_generation: candidateGeneration,
      },
    },
    updatedAt: "2026-08-15T05:44:00.001Z",
  });
  return {
    old,
    candidate,
    oldIdentity: visualSnapshotPointerIdentity(old),
    candidateIdentity: visualSnapshotPointerIdentity(candidate),
  };
}

function executionFixture() {
  const manifest = stage1EvidenceSchemaUpgradeExpectedManifest();
  const manifestSource = manifest.sources.find(
    (source) => source.source_id === SELECTED_SOURCE_ID,
  );
  const manifestSha256 = sha256(canonicalJson(manifest));
  const baselineIdentity = {
    sha256: fixtureSha256("baseline"),
    byte_length: 12_345,
  };
  const pointerIdentity = reviewedPointerFixtures({
    sourceId: SELECTED_SOURCE_ID,
    sharedAwardId: manifestSource.shared_award_id,
  }).oldIdentity;
  const selectedPointerIdentity = {
    schema_version: pointerIdentity.schema_version,
    exists: pointerIdentity.exists,
    canonical_sha256: pointerIdentity.canonical_sha256,
  };
  const captureResult = captureResultFixture({
    manifestSha256,
    baselineIdentity,
    pointerIdentity: selectedPointerIdentity,
  });
  const freshValidationSha256 =
    stage1EvidenceSchemaUpgradeFreshValidationSha256(captureResult);
  const selected = {
    source: structuredClone(manifestSource),
    result: {
      schema_version: captureResult.schema_version,
      evaluated_at: captureResult.evaluated_at,
      result_sha256: fixtureSha256("result"),
      status: "dry_run_ready",
      reason_code: captureResult.reason_code,
    },
    validation: {
      status: "evaluated",
      decision: "eligible_unchanged_upgrade",
      reason: captureResult.reason_code,
      capture_validation_sha256: fixtureSha256("capture-validation"),
      fresh_projection_schema:
        STAGE1_EVIDENCE_SCHEMA_UPGRADE_FRESH_VALIDATION_PROJECTION_SCHEMA,
      fresh_projection_sha256: freshValidationSha256,
    },
    acquisition: {
      source_acquisition_id: "22222222-2222-4222-8222-222222222222",
      file_sha256: fixtureSha256("acquisition-file"),
      text_sha256: fixtureSha256("acquisition-text"),
      normalized_text_sha256: fixtureSha256("acquisition-normalized"),
      evidence_quote_count: 1,
    },
    activation: {
      guard_sha256: fixtureSha256("activation"),
      binding_reason: "stage1_baseline_activation_exact_binding_verified",
    },
    finalization: {
      receipt_sha256: fixtureSha256("finalization"),
      finalized_at: "2026-08-14T19:00:00.000Z",
    },
    local_baseline_identity: baselineIdentity,
    existing_pointer_identity: selectedPointerIdentity,
    r2: {
      binding_receipt_sha256: fixtureSha256("r2-binding"),
      pointer_sha256: fixtureSha256("r2-pointer"),
      previous_pointer_projection_sha256: fixtureSha256("r2-previous-pointer"),
      latest_metadata_sha256: fixtureSha256("r2-metadata"),
      immutable_generation: "a".repeat(32),
      bucket: "reviewed-fixture-bucket",
      kind: "webpage",
      captured_at: "2026-08-14T18:00:00.000Z",
      pointer_latest_object_keys_sha256: fixtureSha256("r2-keys"),
      pointer_latest_hashes_sha256: fixtureSha256("r2-hashes"),
      verified_roles_sha256: fixtureSha256("r2-roles"),
      semantic_text_sha256: fixtureSha256("r2-text"),
    },
    recovery_evidence_sha256: fixtureSha256("recovery"),
  };
  const reviewer = {
    reviewer_id: "reviewed-operator@example.com",
    reviewed_at: "2026-08-15T05:00:00.000Z",
    expires_at: "2026-08-16T05:00:00.000Z",
  };
  const planSha256 = fixtureSha256("reviewed-plan");
  const validatedPlan = {
    valid: true,
    historical_evidence_only: false,
    schema_version: STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_PLAN_SCHEMA,
    plan_file_sha256: fixtureSha256("reviewed-plan-file"),
    plan_sha256: planSha256,
    selected_source_id: SELECTED_SOURCE_ID,
    deferred_source_ids: manifest.source_ids.filter(
      (sourceId) => sourceId !== SELECTED_SOURCE_ID,
    ),
    expected_active_journal_sha256: null,
    reviewer,
    authority: structuredClone(
      STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_PLAN_AUTHORITY,
    ),
    report_binding: {
      attempt_id: AUDIT_ID,
      file_sha256: fixtureSha256("reviewed-report-file"),
      finished_at: "2026-08-15T04:18:00.000Z",
      manifest_sha256: manifestSha256,
      report_schema_version: 2,
      stage1_report_generated_at: "2026-08-15T04:17:30.000Z",
      stage1_report_schema_version:
        "awardping.stage1.evidence-schema-upgrade-report.v1",
      stage1_report_sha256: fixtureSha256("reviewed-stage1-report"),
      started_at: "2026-08-15T04:16:04.313Z",
      worker_run_id: null,
    },
    plan: {
      schema_version: STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_PLAN_SCHEMA,
      manifest: {
        schema_version: manifest.schema_version,
        sha256: manifestSha256,
        source_count: manifest.source_count,
      },
      reviewer: structuredClone(reviewer),
      selected,
      plan_sha256: planSha256,
    },
    selected_result: structuredClone(captureResult),
    fresh_validation_projection_sha256: freshValidationSha256,
  };
  const source = {
    id: SELECTED_SOURCE_ID,
    shared_award_id: manifestSource.shared_award_id,
    url: "https://example.com/faq",
    title: "Reviewed FAQ",
    display_title: "Reviewed FAQ",
    page_description: null,
    page_metadata: null,
    page_metadata_generated_at: null,
    page_metadata_model: null,
    page_type: "faq",
    source: "manual",
    reason: null,
    submitted_by_user_id: null,
    admin_review_status: "open",
    admin_review_note: null,
    admin_reviewed_at: null,
    admin_reviewed_by: null,
    last_hash: null,
    last_checked_at: null,
    next_check_at: null,
    consecutive_failures: 0,
    last_error: null,
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-15T04:00:00.000Z",
    shared_awards: {
      id: manifestSource.shared_award_id,
      name: "Reviewed Award",
      status: "active",
      official_homepage: "https://example.com",
    },
    source_acquisition: { id: selected.acquisition.source_acquisition_id },
  };
  return {
    manifest,
    source,
    captureResult,
    validatedPlan,
  };
}

function captureResultFixture({ manifestSha256, baselineIdentity, pointerIdentity }) {
  const textHash = fixtureSha256("capture-text");
  return {
    schema_version: STAGE1_EVIDENCE_SCHEMA_UPGRADE_RESULT_SCHEMA,
    evaluated_at: "2026-08-15T05:30:00.000Z",
    mode: "dry_run",
    source_id: SELECTED_SOURCE_ID,
    manifest_sha256: manifestSha256,
    source_eligible: true,
    eligibility: {
      eligible: true,
      source_id: SELECTED_SOURCE_ID,
    },
    queue_policy: {
      context: "stage1_evidence_schema_upgrade",
      bypassRejectionLedger: true,
      queueReconciliation: false,
    },
    capture_validation: {
      status: "evaluated",
      decision: "eligible_unchanged_upgrade",
      reason: "exact_semantic_and_primary_visual_identity_verified",
      evidence: {
        source_id: SELECTED_SOURCE_ID,
        kind: "webpage",
        local_baseline_identity: structuredClone(baselineIdentity),
        existing_pointer_identity: structuredClone(pointerIdentity),
        capture: {
          captured_at: "2026-08-15T05:29:00.000Z",
          layout_hash: fixtureSha256("layout"),
        },
        comparison: {
          semantic_fields: {
            text_hash: { current: textHash },
          },
        },
        pdf_text_recovery: null,
        prior_recovery: null,
      },
    },
    pointer_journal: { status: "would_commit" },
    visual_review_candidate: { status: "not_planned" },
    quarantine: { status: "not_planned" },
    safety: {
      creates_api_charge: false,
      public_fact_writes: 0,
    },
    mutation_counts: zeroMutationCounts(),
    status: "dry_run_ready",
    reason_code: "exact_semantic_and_primary_visual_identity_verified",
  };
}

function successfulInterfaces(fixture, calls, { onCommit, onFinish } = {}) {
  let freshCaptureResult = null;
  return {
    async assertPreCaptureAuthority() {
      calls.push("pre_authority");
      return authorityReceipt(fixture);
    },
    async captureDryRun() {
      calls.push("capture");
      const fresh = freshCaptureResultFixture(fixture);
      freshCaptureResult = structuredClone(fresh);
      return fresh;
    },
    async assertPostCaptureAuthority(request) {
      calls.push(request.phase === "pre_commit"
        ? "pre_commit_authority"
        : "post_authority");
      return authorityReceipt(fixture);
    },
    async revalidatePlan() {
      calls.push("revalidate");
      return structuredClone(fixture.validatedPlan);
    },
    async startAudit(request) {
      calls.push("start_audit");
      return auditReceipt({
        request,
        action: "start",
        disposition: "started",
        businessExecutionAuthorized: true,
        counts: {
          local_worker_run_inserts: 1,
          local_worker_run_terminal_updates: 0,
        },
      });
    },
    async commitUnchangedUpgrade(request) {
      calls.push("commit");
      onCommit?.(request);
      return successfulCommitResult(request);
    },
    async finishAudit(request) {
      calls.push("finish_audit");
      onFinish?.(request);
      return auditReceipt({
        request,
        action: "finish",
        disposition: "finished",
        businessExecutionAuthorized: false,
        terminalStatus: request.terminal.status,
        counts: {
          local_worker_run_inserts: 0,
          local_worker_run_terminal_updates: 1,
        },
        captureResult: freshCaptureResult,
      });
    },
  };
}

function freshCaptureResultFixture(fixture) {
  const fresh = structuredClone(fixture.captureResult);
  fresh.evaluated_at = "2026-08-15T05:45:00.000Z";
  fresh.capture_validation.evidence.capture.captured_at =
    "2026-08-15T05:44:00.000Z";
  return fresh;
}

function authorityReceipt(fixture, source = fixture.source) {
  const selected = fixture.validatedPlan.plan.selected;
  return stage1EvidenceSchemaUpgradeReviewedApplyAuthorityReceipt({
    source,
    localBaselineIdentity: selected.local_baseline_identity,
    existingPointerIdentity: selected.existing_pointer_identity,
    r2BindingReceiptSha256: selected.r2.binding_receipt_sha256,
    activeJournalSha256: null,
  });
}

function successfulCommitResult(request) {
  return reviewedCommitResult(request, { status: "upgraded" });
}

function abandonedCommitResult(request) {
  return reviewedCommitResult(request, { status: "abandoned_old_authority" });
}

function reviewedCommitResult(request, { status }) {
  const upgraded = status === "upgraded";
  const counts = upgraded
    ? successMutationCounts()
    : abandonedMutationCounts();
  const cas = upgraded
    ? {
        attempted: true,
        returned: true,
        threw: false,
        recovered: false,
        error_code: null,
        error_message: null,
        confirmed_database_pointer_writes: 1,
        write_attribution: "confirmed_by_strict_true_return",
      }
    : {
        attempted: true,
        returned: false,
        threw: false,
        recovered: false,
        error_code: null,
        error_message: null,
        confirmed_database_pointer_writes: 0,
        write_attribution: "confirmed_not_written_by_this_cas",
      };
  const accounting = sealAccounting({
    counts,
    evidence: {
      boundary: "completed_journal_archive_verified",
      response_loss_possible: false,
      journal_archive: journalArchiveAccounting(),
      cas,
    },
  });
  const pointers = reviewedPointerFixtures({
    sourceId: request.source_id,
    sharedAwardId: request.source.shared_award_id,
  });
  const journalSha256 = fixtureSha256("commit-journal");
  const reconciliationEvidence =
    buildStage1EvidenceSchemaUpgradeReviewedReconciliationEvidence({
      sourceId: request.source_id,
      transactionId: request.transaction_id,
      journalSha256,
      oldPointerIdentity: pointers.oldIdentity,
      candidatePointerIdentity: pointers.candidateIdentity,
      candidateObjectKeys: pointers.candidate.latest_object_keys,
    });
  const sourceHealth = upgraded
    ? {
        status: "succeeded",
        mutation_counts: {
          ...zeroMutationCounts(),
          database_writes: 1,
          source_state_writes: 1,
        },
      }
    : null;
  const cleanupDebt = planLatestOnlyVisualSnapshotPointerReconciliation({
    existing: pointers.old,
    candidate: pointers.candidate,
    current: upgraded ? pointers.candidate : pointers.old,
    outcome: upgraded ? "committed" : "cas_lost",
    uploadedKeys: pointers.candidate.latest_object_keys,
  }).cleanup_debt;
  return {
    status,
    source_id: request.source_id,
    context: "stage1_evidence_schema_upgrade",
    transaction_id: request.transaction_id,
    creates_api_charge: false,
    mutation_counts: counts,
    mutation_accounting: accounting,
    mutation_count_certainty: {
      exact: true,
      count_semantics: "exact",
      unknown_write_categories: [],
    },
    reviewed_reconciliation_evidence: structuredClone(reconciliationEvidence),
    receipt: {
      schema_version: "awardping.stage1.evidence-schema-upgrade-commit-receipt.v1",
      status,
      source_id: request.source_id,
      context: "stage1_evidence_schema_upgrade",
      operation: "pointer_commit",
      transaction_id: request.transaction_id,
      creates_api_charge: false,
      outcome: upgraded ? "committed_candidate" : "abandoned_old_authority",
      journal_phase: "completed",
      journal_archived: true,
      journal_sha256: journalSha256,
      authoritative_pointer_state: upgraded ? "candidate" : "old",
      authoritative_baseline_state: upgraded ? "candidate" : "old",
      authoritative_pointer_sha256: upgraded
        ? pointers.candidateIdentity.canonical_sha256
        : pointers.oldIdentity.canonical_sha256,
      authoritative_baseline_sha256: upgraded
        ? fixtureSha256("authoritative-baseline")
        : request.expected_old_baseline.sha256,
      cas,
      cleanup_debt: cleanupDebt,
      cleanup_delete_performed: false,
      source_health: sourceHealth,
      mutation_count_scope: "confirmed_io_receipts_in_this_invocation",
      mutation_counts: counts,
      mutation_accounting: accounting,
    },
  };
}

function auditReceipt({
  request,
  action,
  disposition,
  businessExecutionAuthorized,
  replay = false,
  terminalStatus = null,
  terminalIdentitySha256,
  terminalFailureSha256,
  terminalCompletionAuthority = terminalStatus === null
    ? null
    : request.completionAuthority
      ?? stage1EvidenceSchemaUpgradeReviewedApplyAuditFreshCompletionAuthority(),
  activeExecutionNonce = request.executionNonce,
  counts = {
    local_worker_run_inserts: 0,
    local_worker_run_terminal_updates: 0,
  },
  unknown = [],
  captureResult = request.captureResult ?? null,
  authorityReceiptSha256 = request.authorityReceipt
    ? stage1EvidenceSchemaUpgradeReviewedAuthorityReceiptSha256(
        request.authorityReceipt,
      )
    : stage1EvidenceSchemaUpgradeReviewedAuthorityReceiptSha256(
        authorityReceipt(executionFixture()),
      ),
}) {
  const plan = request.reviewedApplyPlan;
  const derivedTerminalIdentity = terminalStatus === "succeeded"
    ? terminalIdentitySha256
      ?? (request.terminal ? auditTerminalIdentityFixture(request.terminal) : null)
    : null;
  const derivedTerminalFailure = terminalStatus === "failed"
    ? terminalFailureSha256
      ?? (request.terminal ? auditTerminalIdentityFixture(request.terminal) : null)
    : null;
  const freshCapture = captureResult === null
    ? null
    : stage1EvidenceSchemaUpgradeReviewedApplyFreshCaptureEvidence({
        reviewedApplyPlan: plan,
        captureResult,
      });
  const accounting = sealedAuditAccounting({
    action,
    disposition,
    counts,
    unknown,
    observedRowStatus: terminalStatus === "succeeded"
      ? "terminal_succeeded"
      : terminalStatus === "failed"
        ? "terminal_failed"
        : action === "start"
          ? "running"
          : "missing",
  });
  const content = {
    schema_version:
      STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_AUDIT_RECEIPT_SCHEMA,
    action,
    disposition,
    business_execution_authorized: businessExecutionAuthorized,
    replay,
    run_id: stage1EvidenceSchemaUpgradeReviewedApplyAuditRunId(
      plan.plan_file_sha256,
    ),
    worker_name:
      STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_AUDIT_WORKER_NAME,
    requested_execution_nonce: request.executionNonce,
    active_execution_nonce: activeExecutionNonce,
    plan_file_sha256: plan.plan_file_sha256,
    plan_sha256: plan.plan_sha256,
    selected_source_id: plan.selected_source_id,
    authority_receipt_sha256: authorityReceiptSha256,
    fresh_capture_evidence_sha256: freshCapture?.fresh_capture_sha256 ?? null,
    fresh_capture_result_sha256: freshCapture?.capture_result_sha256 ?? null,
    fresh_capture_validation_sha256:
      freshCapture?.capture_validation_sha256 ?? null,
    fresh_validation_projection_sha256:
      freshCapture?.fresh_validation_projection_sha256 ?? null,
    terminal_status: terminalStatus,
    terminal_identity_sha256: derivedTerminalIdentity,
    terminal_failure_sha256: derivedTerminalFailure,
    terminal_completion_authority_mode: terminalCompletionAuthority?.mode ?? null,
    terminal_completion_authority_sha256:
      terminalCompletionAuthority?.completion_authority_sha256 ?? null,
    observed_row_sha256: fixtureSha256(
      `${action}:${disposition}:observed-row`,
    ),
    audit_mutation_accounting: accounting,
  };
  return {
    ...content,
    receipt_sha256: sha256(canonicalJson(content)),
  };
}

function auditTerminalIdentityFixture(terminal) {
  if (terminal.status === "failed") {
    const errorCode = terminal.error_code.trim();
    const errorMessage = terminal.error_message.trim();
    return sha256(canonicalJson({
      error_code: errorCode.slice(0, 200),
      error_summary: errorMessage.slice(0, 1000),
      error_message_sha256: sha256(errorMessage),
    }));
  }
  const result = terminal.selected_result;
  const receipt = terminal.commit_receipt;
  const content = {
    schema_version:
      STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_AUDIT_RESULT_IDENTITY_SCHEMA,
    source_id: result.source_id,
    selected_result_schema_version: result.schema_version,
    selected_result_status: result.status,
    selected_result_sha256: sha256(canonicalJson(result)),
    commit_receipt_schema_version: receipt.schema_version,
    commit_receipt_status: receipt.status,
    commit_receipt_sha256: sha256(canonicalJson(receipt)),
    commit_journal_sha256: receipt.journal_sha256,
    commit_mutation_accounting_sha256:
      receipt.mutation_accounting.accounting_sha256,
  };
  return sha256(canonicalJson(content));
}

function sealedAuditAccounting({
  action,
  disposition,
  counts,
  unknown,
  observedRowStatus,
}) {
  const sortedUnknown = [...unknown].sort();
  const content = {
    schema_version:
      STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_AUDIT_ACCOUNTING_SCHEMA,
    count_scope: "local_worker_runs_writes_in_this_orchestration_invocation",
    count_semantics: "confirmed_lower_bounds",
    exact: sortedUnknown.length === 0,
    lower_bound_counts: counts,
    unknown_write_categories: sortedUnknown,
    evidence: {
      action,
      disposition,
      response_loss_possible: sortedUnknown.length > 0,
      observed_row_status: observedRowStatus,
    },
  };
  return {
    ...content,
    accounting_sha256: sha256(canonicalJson(content)),
  };
}

function expectedAuditId(fixture) {
  return stage1EvidenceSchemaUpgradeReviewedApplyAuditRunId(
    fixture.validatedPlan.plan_file_sha256,
  );
}

function successMutationCounts() {
  return {
    ...zeroMutationCounts(),
    database_writes: 2,
    r2_writes: 3,
    local_baseline_writes: 1,
    source_state_writes: 1,
  };
}

function abandonedMutationCounts() {
  return {
    ...zeroMutationCounts(),
    r2_writes: 3,
    local_baseline_writes: 2,
  };
}

function sealAccounting({ counts, unknown = [], evidence = null }) {
  return sealStage1EvidenceSchemaUpgradeMutationAccounting({
    operation: "pointer_commit",
    lowerBoundCounts: counts,
    unknownWriteCategories: unknown,
    evidence: evidence ?? {
      boundary: unknown.length ? "response_lost" : "settled",
      response_loss_possible: unknown.length > 0,
    },
  });
}

function replaceReviewedResultAccounting(result, counts, cas) {
  const accounting = sealAccounting({
    counts,
    evidence: {
      boundary: "completed_journal_archive_verified",
      response_loss_possible: false,
      journal_archive: journalArchiveAccounting(),
      cas,
    },
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

function journalArchiveAccounting({
  state = "verified",
  localJournalArchiveWritesLowerBound = 1,
  archiveReceiptAcknowledged = true,
  archivedReadbackVerified = true,
  activeAbsenceVerified = true,
  responseLossPossible = false,
} = {}) {
  const content = {
    schema_version:
      STAGE1_EVIDENCE_SCHEMA_UPGRADE_JOURNAL_ARCHIVE_ACCOUNTING_SCHEMA,
    state,
    local_journal_archive_writes_lower_bound:
      localJournalArchiveWritesLowerBound,
    archive_receipt_acknowledged: archiveReceiptAcknowledged,
    archived_readback_verified: archivedReadbackVerified,
    active_absence_verified: activeAbsenceVerified,
    response_loss_possible: responseLossPossible,
  };
  return {
    ...content,
    evidence_sha256: sha256(canonicalJson(content)),
  };
}

function zeroMutationCounts() {
  return zeroStage1EvidenceSchemaUpgradeMutationCounts();
}

function runExecution(fixture, interfaces) {
  return runStage1EvidenceSchemaUpgradeReviewedApplyExecution({
    source: fixture.source,
    manifest: fixture.manifest,
    validatedPlan: fixture.validatedPlan,
    executionNonce: EXECUTION_NONCE,
    interfaces,
    now: () => NOW,
  });
}

function fixtureSha256(label) {
  return sha256(`reviewed-apply-execution-fixture:${label}`);
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

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
