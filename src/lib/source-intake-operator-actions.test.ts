import { describe, expect, it } from "vitest";
import {
  FREE_RECONCILIATION_FAILURE_REASON,
  FREE_RECONCILIATION_PREFLIGHT_FAILURE_REASON,
  FREE_RECONCILIATION_RETRY_REASON,
  POST_RETENTION_CAPTURE_PERSISTENCE_UNVERIFIED_REASON,
  sourceIntakeActionAllowed,
  sourceIntakeActionAllowedWithContext,
  sourceIntakeAllowedStatuses,
  sourceIntakeProtectedRecovery,
  sourceIntakeReconciliationRetryEligibility,
  sourceIntakeReconciliationRetryPatch,
} from "@/lib/source-intake-operator-actions";

describe("source intake operator actions", () => {
  it("blocks operator mutations while work or an external Batch is active", () => {
    for (const status of ["validating", "capturing", "ai_review_pending", "ai_review_submitted", "matching"]) {
      for (const action of ["retry", "retry_reconciliation", "reject", "attach_to_award", "rerun_capture", "rerun_ai_review"] as const) {
        expect(sourceIntakeActionAllowed(action, status), `${action} at ${status}`).toBe(false);
      }
    }
  });

  it("allows deliberate recovery only from idle failure states", () => {
    expect(sourceIntakeAllowedStatuses("rerun_ai_review")).toEqual(["failed", "needs_manual_review"]);
    expect(sourceIntakeActionAllowed("rerun_ai_review", "failed")).toBe(true);
    expect(sourceIntakeActionAllowed("retry", "pending")).toBe(true);
    expect(sourceIntakeActionAllowed("reject", "needs_manual_review")).toBe(true);
  });

  it("keeps an active fail-closed submission claim operator-immutable", () => {
    const activeContext = {
      statusReason: "gemini_batch_submission_in_progress_fail_closed",
      aiReview: { submission_claim_token: "claim-1" },
    };
    expect(sourceIntakeActionAllowedWithContext("retry", "needs_manual_review", activeContext)).toBe(false);
    expect(sourceIntakeActionAllowedWithContext("reject", "needs_manual_review", activeContext)).toBe(true);
    const ambiguousContext = {
      aiReview: {
        submission_claim_token: "claim-1",
        submission_claim_failed_closed_at: "2026-07-15T12:00:00.000Z",
      },
    };
    expect(sourceIntakeActionAllowedWithContext("rerun_ai_review", "needs_manual_review", ambiguousContext)).toBe(false);
    expect(sourceIntakeActionAllowedWithContext("retry", "needs_manual_review", ambiguousContext)).toBe(false);
    expect(sourceIntakeActionAllowedWithContext("reject", "needs_manual_review", ambiguousContext)).toBe(true);
  });

  it("keeps a stale known external Batch reject-only", () => {
    const staleBatchContext = {
      statusReason: "stale_gemini_batch_operator_recovery_required",
      aiReview: { gemini_batch_name: "batches/stale-1" },
    };
    expect(sourceIntakeActionAllowedWithContext("retry", "needs_manual_review", staleBatchContext)).toBe(false);
    expect(sourceIntakeActionAllowedWithContext("rerun_ai_review", "needs_manual_review", staleBatchContext)).toBe(false);
    expect(sourceIntakeActionAllowedWithContext("attach_to_award", "needs_manual_review", staleBatchContext)).toBe(false);
    expect(sourceIntakeActionAllowedWithContext("reject", "needs_manual_review", staleBatchContext)).toBe(true);
    expect(
      sourceIntakeActionAllowedWithContext("retry", "needs_manual_review", {
        statusReason: "stale_submitted_missing_gemini_batch_operator_recovery_required",
      }),
    ).toBe(false);
  });

  it("keeps a post-create claim loss reject-only even when an older Batch name remains", () => {
    const claimLossContext = {
      statusReason: "manual_recovery_required_external_batch_created_after_claim_loss",
      aiReview: {
        gemini_batch_name: "batches/older-terminal",
        possible_external_batch_name: "batches/new-ambiguous",
        submission_claim_token: "claim-new",
        submission_claim_failed_closed_at: "2026-07-15T12:00:00.000Z",
      },
    };
    expect(sourceIntakeActionAllowedWithContext("retry", "needs_manual_review", claimLossContext)).toBe(false);
    expect(sourceIntakeActionAllowedWithContext("rerun_capture", "needs_manual_review", claimLossContext)).toBe(false);
    expect(sourceIntakeActionAllowedWithContext("reject", "needs_manual_review", claimLossContext)).toBe(true);
  });

  it("offers only the zero-charge reconciliation retry when accepted AI and retained capture evidence are bound", () => {
    const context = freeReconciliationContext();

    expect(sourceIntakeAllowedStatuses("retry_reconciliation")).toEqual(["failed", "needs_manual_review"]);
    expect(sourceIntakeActionAllowedWithContext("retry_reconciliation", "needs_manual_review", context)).toBe(true);
    expect(sourceIntakeReconciliationRetryEligibility("needs_manual_review", context)).toMatchObject({
      allowed: true,
      reason: "eligible_zero_charge_retry",
    });
    expect(sourceIntakeActionAllowedWithContext("retry", "needs_manual_review", context)).toBe(false);
    expect(sourceIntakeActionAllowedWithContext("rerun_capture", "needs_manual_review", context)).toBe(false);
    expect(sourceIntakeActionAllowedWithContext("rerun_ai_review", "needs_manual_review", context)).toBe(false);
    expect(sourceIntakeActionAllowedWithContext("reject", "needs_manual_review", context)).toBe(true);
  });

  it("fails the free retry closed when the accepted result or exact retained artifact is missing or misbound", () => {
    const valid = freeReconciliationContext();
    const cases = [
      { ...valid, aiReview: { ...(valid.aiReview as Record<string, unknown>), status: "needs_review" } },
      { ...valid, aiReview: { ...(valid.aiReview as Record<string, unknown>), raw: {} } },
      { ...valid, captureMetadata: {} },
      {
        ...valid,
        captureMetadata: {
          ...(valid.captureMetadata as Record<string, unknown>),
          capture_file_hash: "b".repeat(64),
        },
      },
      {
        ...valid,
        captureMetadata: {
          ...(valid.captureMetadata as Record<string, unknown>),
          canonical_url: "https://example.org/changed.pdf",
        },
      },
      { ...valid, requestId: "22222222-2222-4222-8222-222222222222" },
    ];

    for (const context of cases) {
      expect(
        sourceIntakeActionAllowedWithContext("retry_reconciliation", "needs_manual_review", context),
      ).toBe(false);
    }
  });

  it("allows a no-charge preflight failure to be retried after its evidence is repaired", () => {
    const failed = {
      ...freeReconciliationContext(),
      statusReason: FREE_RECONCILIATION_PREFLIGHT_FAILURE_REASON,
      captureMetadata: {},
    };
    expect(sourceIntakeActionAllowedWithContext("retry_reconciliation", "needs_manual_review", failed)).toBe(false);
    expect(sourceIntakeActionAllowedWithContext("retry", "needs_manual_review", failed)).toBe(false);
    expect(sourceIntakeActionAllowedWithContext("rerun_capture", "needs_manual_review", failed)).toBe(false);
    expect(sourceIntakeActionAllowedWithContext("rerun_ai_review", "needs_manual_review", failed)).toBe(false);

    const repaired = {
      ...freeReconciliationContext(),
      statusReason: FREE_RECONCILIATION_PREFLIGHT_FAILURE_REASON,
    };
    expect(sourceIntakeReconciliationRetryEligibility("needs_manual_review", repaired)).toMatchObject({
      allowed: true,
      reason: "eligible_zero_charge_retry",
    });
    expect(sourceIntakeActionAllowedWithContext("retry_reconciliation", "needs_manual_review", repaired)).toBe(true);
    expect(sourceIntakeActionAllowedWithContext("rerun_ai_review", "needs_manual_review", repaired)).toBe(false);
  });

  it("protects every live first-capture failure from generic or chargeable retries", () => {
    const protectedContext = {
      ...freeReconciliationContext(),
      statusReason: "atomic_source_registration_failed_closed",
    };
    expect(sourceIntakeActionAllowedWithContext("retry_reconciliation", "failed", protectedContext)).toBe(true);
    expect(sourceIntakeActionAllowedWithContext("retry", "failed", protectedContext)).toBe(false);
    expect(sourceIntakeActionAllowedWithContext("rerun_capture", "failed", protectedContext)).toBe(false);
    expect(sourceIntakeActionAllowedWithContext("rerun_ai_review", "failed", protectedContext)).toBe(false);
    expect(sourceIntakeActionAllowedWithContext("reject", "failed", protectedContext)).toBe(true);
  });

  it("keeps protected live first-capture rows replay-only even while their artifact needs repair", () => {
    const invalidArtifact = {
      ...freeReconciliationContext(),
      statusReason: "source_acquisition_preflight_failed_closed",
      captureMetadata: {},
    };
    expect(sourceIntakeActionAllowedWithContext("retry_reconciliation", "needs_manual_review", invalidArtifact)).toBe(false);
    expect(sourceIntakeActionAllowedWithContext("retry", "needs_manual_review", invalidArtifact)).toBe(false);
    expect(sourceIntakeActionAllowedWithContext("rerun_capture", "needs_manual_review", invalidArtifact)).toBe(false);
    expect(sourceIntakeActionAllowedWithContext("rerun_ai_review", "needs_manual_review", invalidArtifact)).toBe(false);
    expect(sourceIntakeActionAllowedWithContext("reject", "needs_manual_review", invalidArtifact)).toBe(true);
  });

  it("classifies each protected live first-capture recovery stage and exposes only its safe action", () => {
    const noArtifact = protectedContext({ aiReview: {}, captureMetadata: {} });
    expect(sourceIntakeProtectedRecovery("needs_manual_review", noArtifact)).toMatchObject({
      mode: "retry_capture_may_charge",
      apiCharge: "may_charge",
      refetchesPage: true,
      runsAiReview: true,
    });
    expectOnlyProtectedActions(noArtifact, ["retry", "reject"]);

    const staged = stagedRecoveryContext();
    expect(sourceIntakeProtectedRecovery("needs_manual_review", staged)).toMatchObject({
      mode: "resume_staged_capture_may_charge",
      apiCharge: "may_charge",
      refetchesPage: false,
      runsAiReview: true,
    });
    expectOnlyProtectedActions(staged, ["retry", "reject"]);

    const partiallyBoundStaged = stagedRecoveryContext();
    const partialCapture = partiallyBoundStaged.captureMetadata as Record<string, unknown>;
    partialCapture.retained_artifact_staged = {
      ...(partialCapture.retained_artifact_staged as Record<string, unknown>),
      r2_store_id: null,
    };
    expect(sourceIntakeProtectedRecovery("needs_manual_review", partiallyBoundStaged)).toMatchObject({
      mode: "resume_staged_capture_may_charge",
    });

    const completedWithoutReview = protectedContext({ aiReview: {} });
    expect(sourceIntakeProtectedRecovery("needs_manual_review", completedWithoutReview)).toMatchObject({
      mode: "rerun_ai_review_may_charge",
      apiCharge: "may_charge",
      refetchesPage: false,
      runsAiReview: true,
    });
    expectOnlyProtectedActions(completedWithoutReview, ["rerun_ai_review", "reject"]);

    const completedAccepted = freeReconciliationContext();
    expect(sourceIntakeProtectedRecovery("needs_manual_review", completedAccepted)).toMatchObject({
      mode: "replay_retained_result_no_charge",
      apiCharge: "none",
      refetchesPage: false,
      runsAiReview: false,
    });
    expectOnlyProtectedActions(completedAccepted, ["retry_reconciliation", "reject"]);

    const acceptedWithoutArtifact = protectedContext({ captureMetadata: {} });
    expect(sourceIntakeProtectedRecovery("needs_manual_review", acceptedWithoutArtifact)).toMatchObject({
      mode: "manual_only",
    });
    expectOnlyProtectedActions(acceptedWithoutArtifact, ["reject"]);

    const malformedStaged = protectedContext({
      aiReview: {},
      captureMetadata: { retained_artifact_staged: "not-a-manifest" },
    });
    expect(sourceIntakeProtectedRecovery("needs_manual_review", malformedStaged)).toMatchObject({
      mode: "manual_only",
    });
    expectOnlyProtectedActions(malformedStaged, ["reject"]);
  });

  it("keeps local retained-byte conflicts manual-only instead of refetching the URL", () => {
    for (const statusReason of [
      "intake_pdf_bytes_unavailable",
      "intake_pdf_hash_mismatch",
      "intake_pdf_length_mismatch",
      "intake_local_conflict",
      "intake_local_unsafe_path",
    ]) {
      const context = protectedContext({ aiReview: {}, captureMetadata: {} });
      context.statusReason = statusReason;
      expect(sourceIntakeProtectedRecovery("needs_manual_review", context)).toMatchObject({
        mode: "manual_only",
        refetchesPage: false,
        runsAiReview: false,
      });
      expectOnlyProtectedActions(context, ["reject"]);
    }
  });

  it("keeps unproven post-retention identity manual-only even if partial metadata looks retryable", () => {
    for (const context of [
      protectedContext({ aiReview: {}, captureMetadata: {} }),
      stagedRecoveryContext(),
      protectedContext({ aiReview: {} }),
    ]) {
      context.statusReason = POST_RETENTION_CAPTURE_PERSISTENCE_UNVERIFIED_REASON;
      expect(sourceIntakeProtectedRecovery("needs_manual_review", context)).toMatchObject({
        mode: "manual_only",
        refetchesPage: false,
        runsAiReview: false,
      });
      expectOnlyProtectedActions(context, ["reject"]);
    }
  });

  it("leaves an ordinary stale-matching intake row on the existing recovery actions", () => {
    const ordinary = {
      statusReason: "stale_matching_failed_closed_operator_retry_required",
      acquisitionKind: "admin_intake",
      notificationMode: "baseline_only",
      onboardingBatchId: null,
      aiReview: {},
      captureMetadata: {},
      requestId: "11111111-1111-4111-8111-111111111111",
    };
    expect(sourceIntakeActionAllowedWithContext("retry", "failed", ordinary)).toBe(true);
    expect(sourceIntakeActionAllowedWithContext("rerun_capture", "failed", ordinary)).toBe(true);
    expect(sourceIntakeActionAllowedWithContext("rerun_ai_review", "failed", ordinary)).toBe(true);
    expect(sourceIntakeActionAllowedWithContext("retry_reconciliation", "failed", ordinary)).toBe(false);
  });

  it("gives an ordinary non-PDF matching failure one explicit chargeable retry path", () => {
    const ordinary = {
      ...freeReconciliationContext(),
      statusReason: FREE_RECONCILIATION_FAILURE_REASON,
      acquisitionKind: "admin_intake",
      notificationMode: "baseline_only",
      captureMetadata: {
        capture_file_hash: "a".repeat(64),
        canonical_url: "https://example.org/award-guidance",
      },
    };
    expect(sourceIntakeActionAllowedWithContext("retry", "needs_manual_review", ordinary)).toBe(true);
    expect(sourceIntakeActionAllowedWithContext("reject", "needs_manual_review", ordinary)).toBe(true);
    expect(sourceIntakeActionAllowedWithContext("retry_reconciliation", "needs_manual_review", ordinary)).toBe(false);
    expect(sourceIntakeActionAllowedWithContext("rerun_ai_review", "needs_manual_review", ordinary)).toBe(false);
    expect(sourceIntakeActionAllowedWithContext("rerun_capture", "needs_manual_review", ordinary)).toBe(false);
    expect(sourceIntakeActionAllowedWithContext("attach_to_award", "needs_manual_review", ordinary)).toBe(false);
  });

  it("keeps ambiguous provider state reject-only even if the stored result and artifact look complete", () => {
    const valid = freeReconciliationContext();
    const aiReview = valid.aiReview as Record<string, unknown>;
    for (const ambiguousAiReview of [
      { ...aiReview, gemini_batch_name: null, submission_claim_token: "claim-unbound" },
      { ...aiReview, submission_claim_failed_closed_at: "2026-07-16T12:00:00.000Z" },
      { ...aiReview, possible_external_batch_name: "batches/a-different-batch" },
    ]) {
      const context = { ...valid, aiReview: ambiguousAiReview };
      expect(sourceIntakeActionAllowedWithContext("retry_reconciliation", "needs_manual_review", context)).toBe(false);
      expect(sourceIntakeActionAllowedWithContext("reject", "needs_manual_review", context)).toBe(true);
    }
  });

  it("builds a free retry patch without replacing the retained capture or accepted AI result", () => {
    const patch = sourceIntakeReconciliationRetryPatch("2026-07-16T13:00:00.000Z");
    expect(patch).toEqual({
      status: "ai_review_succeeded",
      status_reason: FREE_RECONCILIATION_RETRY_REASON,
      worker_run_id: null,
      failed_at: null,
      error: null,
      processed_at: null,
      updated_at: "2026-07-16T13:00:00.000Z",
    });
    expect(patch).not.toHaveProperty("ai_review");
    expect(patch).not.toHaveProperty("capture_metadata");
  });
});

function freeReconciliationContext() {
  const requestId = "11111111-1111-4111-8111-111111111111";
  const fileHash = "a".repeat(64);
  const prefix = `source-intake-first-observation/v1/requests/${requestId}/sha256/${fileHash}`;
  return {
    statusReason: FREE_RECONCILIATION_FAILURE_REASON,
    requestId,
    acquisitionKind: "live_discovery",
    notificationMode: "first_capture_candidate",
    onboardingBatchId: null,
    aiReview: {
      status: "accepted",
      raw: { status: "accepted", source_relevance: "primary" },
      completed_at: "2026-07-16T12:00:00.000Z",
      gemini_batch_name: "batches/source-intake-1",
      possible_external_batch_name: "batches/source-intake-1",
      submission_claim_token: "claim-terminal",
      gemini_batch_request_key: requestId,
    },
    captureMetadata: {
      capture_file_hash: fileHash,
      canonical_url: "https://example.org/official-2027.pdf",
      retained_artifact: {
        schema_version: 1,
        namespace: "source-intake-first-observation",
        request_id: requestId,
        captured_at: "2026-07-16T11:59:00.000Z",
        final_url: "https://example.org/official-2027.pdf",
        prefix,
        file_hash: fileHash,
        file_bytes: 1234,
        text_hash: "c".repeat(64),
        text_length: 987,
        r2_bucket: "awardping-artifacts",
        r2_store_id: "account.r2.cloudflarestorage.com",
        r2_verified_at: "2026-07-16T12:01:00.000Z",
        artifacts: {
          pdf: {
            key: `${prefix}/document.pdf`,
            sha256: fileHash,
            byte_length: 1234,
            content_type: "application/pdf",
          },
          text: {
            key: `${prefix}/text.txt`,
            sha256: "d".repeat(64),
            byte_length: 988,
            content_type: "text/plain; charset=utf-8",
          },
          capture_metadata: {
            key: `${prefix}/capture.json`,
            sha256: "e".repeat(64),
            byte_length: 456,
            content_type: "application/json",
          },
        },
      },
    },
  };
}

function protectedContext({
  aiReview,
  captureMetadata,
}: {
  aiReview?: unknown;
  captureMetadata?: unknown;
} = {}) {
  const base = freeReconciliationContext();
  return {
    ...base,
    statusReason: "protected_live_first_capture_failure",
    aiReview: aiReview === undefined ? base.aiReview : aiReview,
    captureMetadata: captureMetadata === undefined ? base.captureMetadata : captureMetadata,
  };
}

function stagedRecoveryContext() {
  const base = protectedContext({ aiReview: {} });
  const captureMetadata = base.captureMetadata as Record<string, unknown>;
  const completed = captureMetadata.retained_artifact as Record<string, unknown>;
  return {
    ...base,
    captureMetadata: {
      ...captureMetadata,
      retained_artifact: undefined,
      retained_artifact_staged: {
        ...completed,
        r2_verified_at: null,
      },
    },
  };
}

function expectOnlyProtectedActions(
  context: ReturnType<typeof protectedContext>,
  allowed: string[],
) {
  for (const action of [
    "retry",
    "retry_reconciliation",
    "reject",
    "attach_to_award",
    "approve_as_new_award",
    "rerun_capture",
    "rerun_ai_review",
  ] as const) {
    expect(
      sourceIntakeActionAllowedWithContext(action, "needs_manual_review", context),
      `${action} should ${allowed.includes(action) ? "be allowed" : "be blocked"}`,
    ).toBe(allowed.includes(action));
  }
}
