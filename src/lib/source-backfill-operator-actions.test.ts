import { describe, expect, it } from "vitest";
import {
  SourceIntakeOperatorValidationError,
  isApprovedBackfillSourceActivationRetry,
  isManualBackfillSourceActivationRequest,
  sourceIntakeActionAllowedWithContext,
  sourceIntakeAiReviewRetryPatch,
  sourceIntakeBackfillActivationRetryPatch,
  sourceIntakeBackfillApprovalPatch,
  sourceIntakeReconciliationRetryEligibility,
  type SourceIntakeOperatorAction,
  type SourceIntakeOperatorActionContext,
} from "@/lib/source-intake-operator-actions";

const requestId = "11111111-1111-4111-8111-111111111111";
const awardId = "22222222-2222-4222-8222-222222222222";

describe("low-coverage source activation operator controls", () => {
  it("allows only one explicit approval or rejection at the manual activation boundary", () => {
    const context = manualContext();
    expect(isManualBackfillSourceActivationRequest("needs_manual_review", context)).toBe(true);
    expectOnlyActions(context, ["approve_backfill_source", "reject"]);
  });

  it("preserves paid evidence, binds the operator award, and queues baseline-only replay", () => {
    const context = manualContext();
    const patch = sourceIntakeBackfillApprovalPatch({
      status: "needs_manual_review",
      context,
      sharedAwardId: awardId,
      reason: "Official application page confirmed",
      approvedBy: "  ADMIN@AwardPing.COM ",
      updatedAt: "2026-07-17T12:02:00.000Z",
    });

    expect(patch).toMatchObject({
      status: "ai_review_succeeded",
      status_reason: "low_coverage_backfill_source_approved_baseline_only",
      matched_shared_award_id: awardId,
      notification_mode: "baseline_only",
      worker_run_id: null,
      ai_review: {
        status: "accepted",
        backfill_discovery_evidence: expect.objectContaining({
          policy_version: "low-coverage-source-backfill-v1",
        }),
        manual_source_activation: {
          required: false,
          approved: true,
          approved_shared_award_id: awardId,
          approved_by: "admin@awardping.com",
          source_registered: false,
          official_homepage_changed: false,
          notification_after_approval: "baseline_only",
          replay: "stored_capture_and_ai_review_no_charge",
          provider_input_digest_sha256: "e".repeat(64),
          provider_result_binding_digest_sha256: "f".repeat(64),
          provider_result_sha256: "9".repeat(64),
        },
      },
    });
    expect(patch).not.toHaveProperty("capture_metadata");
    expect(patch).not.toHaveProperty("deterministic_review");
    expect(patch).not.toHaveProperty("official_homepage");
  });

  it("keeps a legacy unbound review truthful and requires a new paid review before approval", () => {
    const context = manualContext();
    const aiReview = context.aiReview as Record<string, unknown>;
    context.aiReview = {
      ...aiReview,
      provider_input_binding: undefined,
      provider_result_binding: undefined,
    };

    expect(isManualBackfillSourceActivationRequest("needs_manual_review", context)).toBe(true);
    expectOnlyActions(context, ["rerun_ai_review", "reject"]);
    try {
      sourceIntakeBackfillApprovalPatch({
        status: "needs_manual_review",
        context,
        sharedAwardId: awardId,
        reason: "legacy approval attempt",
        approvedBy: "admin@awardping.com",
        updatedAt: "2026-07-17T12:02:00.000Z",
      });
      throw new Error("Expected the unbound provider result to be rejected.");
    } catch (error) {
      expect(error).toBeInstanceOf(SourceIntakeOperatorValidationError);
      expect(error).toMatchObject({
        status: 409,
        message: expect.stringContaining(
          "Historical unbound results cannot be approved",
        ),
      });
    }

    expect(sourceIntakeAiReviewRetryPatch(
      "needs_manual_review",
      context,
      "2026-07-17T12:03:00.000Z",
    )).toMatchObject({
      status: "ai_review_pending",
      status_reason: "manual_unbound_provider_result_requeued_for_paid_bound_review",
      ai_review: {
        backfill_discovery_evidence: expect.objectContaining({
          policy_version: "low-coverage-source-backfill-v1",
        }),
        manual_source_activation: expect.objectContaining({ required: true }),
        prior_unbound_provider_review: {
          status: "accepted",
          raw: { status: "accepted", source_relevance: "primary" },
          gemini_batch_name: "batches/source-backfill-1",
          archive_reason: "historical_provider_result_not_cryptographically_bound",
        },
      },
    });
  });

  it("returns a typed conflict when the chosen award differs from sealed discovery evidence", () => {
    try {
      sourceIntakeBackfillApprovalPatch({
        status: "needs_manual_review",
        context: manualContext(),
        sharedAwardId: "33333333-3333-4333-8333-333333333333",
        reason: "incorrect award",
        approvedBy: "admin@awardping.com",
        updatedAt: "2026-07-17T12:02:00.000Z",
      });
      throw new Error("Expected the sealed-award mismatch to be rejected.");
    } catch (error) {
      expect(error).toBeInstanceOf(SourceIntakeOperatorValidationError);
      expect(error).toMatchObject({
        status: 409,
        message:
          "The selected award does not match the award sealed into the discovery evidence.",
      });
    }
  });

  it("protects a failed approved activation with only its exact no-charge replay", () => {
    const context = approvedFailureContext();
    expect(isApprovedBackfillSourceActivationRetry("needs_manual_review", context)).toBe(true);
    expect(sourceIntakeReconciliationRetryEligibility("needs_manual_review", context)).toMatchObject({
      allowed: true,
      reason: "eligible_zero_charge_backfill_activation_retry",
    });
    expectOnlyActions(context, ["retry_reconciliation", "reject"]);
    expect(sourceIntakeBackfillActivationRetryPatch("2026-07-17T12:05:00.000Z")).toEqual({
      status: "ai_review_succeeded",
      status_reason: "low_coverage_backfill_source_approved_baseline_only",
      worker_run_id: null,
      failed_at: null,
      error: null,
      processed_at: null,
      updated_at: "2026-07-17T12:05:00.000Z",
    });
  });

  it("refuses an approved replay whose private audit metadata lacks the authenticated actor", () => {
    const context = approvedFailureContext();
    const aiReview = context.aiReview as Record<string, unknown>;
    context.aiReview = {
      ...aiReview,
      manual_source_activation: {
        ...(aiReview.manual_source_activation as Record<string, unknown>),
        approved_by: null,
      },
    };

    expect(isApprovedBackfillSourceActivationRetry("needs_manual_review", context)).toBe(false);
    expectOnlyActions(context, ["reject"]);
  });

  it("identifies an approved activation but blocks replay when its approval digest is altered", () => {
    const context = approvedFailureContext();
    const aiReview = context.aiReview as Record<string, unknown>;
    context.aiReview = {
      ...aiReview,
      manual_source_activation: {
        ...(aiReview.manual_source_activation as Record<string, unknown>),
        provider_input_digest_sha256: "0".repeat(64),
      },
    };

    expect(isApprovedBackfillSourceActivationRetry("needs_manual_review", context)).toBe(true);
    expect(sourceIntakeReconciliationRetryEligibility("needs_manual_review", context)).toMatchObject({
      allowed: false,
      reason: "provider_result_binding_missing_or_invalid",
    });
    expectOnlyActions(context, ["reject"]);
  });

  it("blocks every replay and every chargeable fallback when immutable R2 proof is missing", () => {
    const context = approvedFailureContext();
    context.captureMetadata = {
      ...(context.captureMetadata as Record<string, unknown>),
      retained_artifact: {
        ...((context.captureMetadata as Record<string, unknown>).retained_artifact as Record<string, unknown>),
        r2_verified_at: null,
      },
    };

    expect(sourceIntakeReconciliationRetryEligibility("needs_manual_review", context)).toMatchObject({
      allowed: false,
      reason: "retained_capture_artifact_missing_or_invalid",
    });
    expectOnlyActions(context, ["reject"]);
  });
});

function manualContext(): SourceIntakeOperatorActionContext {
  return {
    statusReason: "low_coverage_backfill_reviewed_manual_source_activation_required",
    requestId,
    matchedSharedAwardId: awardId,
    acquisitionKind: "admin_intake",
    notificationMode: "manual_review",
    onboardingBatchId: "low-coverage-source-backfill-v1",
    aiReview: {
      status: "accepted",
      raw: { status: "accepted", source_relevance: "primary" },
      completed_at: "2026-07-17T12:00:00.000Z",
      gemini_batch_name: "batches/source-backfill-1",
      possible_external_batch_name: "batches/source-backfill-1",
      gemini_batch_request_key: requestId,
      model: "gemini-2.5-flash-lite",
      provider_input_binding: providerInputBinding(),
      provider_result_binding: providerResultBinding(),
      backfill_discovery_evidence: {
        policy_version: "low-coverage-source-backfill-v1",
        matched_shared_award_id: awardId,
        source_activation: "manual_only",
        notification_after_approval: "baseline_only",
        evidence_sha256: "7".repeat(64),
      },
      manual_source_activation: {
        required: true,
        source_registered: false,
        official_homepage_changed: false,
        notification_after_approval: "baseline_only",
        provider_input_digest_sha256: "e".repeat(64),
        provider_result_binding_digest_sha256: "f".repeat(64),
        provider_result_sha256: "9".repeat(64),
      },
    },
    captureMetadata: retainedCaptureMetadata(),
  };
}

function providerInputBinding() {
  return {
    schema_version: 2,
    namespace: "source-intake-provider-input-v2",
    request_id: requestId,
    retained_capture_sha256: "a".repeat(64),
    normalized_text_sha256: "b".repeat(64),
    canonical_url: "https://example.org/apply",
    response_final_url: "https://example.org/apply",
    content_type: "text/html; charset=utf-8",
    retained_capture_byte_length: 1234,
    normalized_text_length: 987,
    captured_at: "2026-07-17T11:59:00.000Z",
    model: "gemini-2.5-flash-lite",
    prompt_policy: { version: 2 },
    prompt_policy_sha256: "1".repeat(64),
    request_fields_sha256: "2".repeat(64),
    deterministic_review_sha256: "3".repeat(64),
    text_excerpt_sha256: "4".repeat(64),
    system_instruction_sha256: "5".repeat(64),
    user_prompt_sha256: "6".repeat(64),
    generation_config_sha256: "7".repeat(64),
    provider_envelope_sha256: "8".repeat(64),
    provider_envelope: { request: {} },
    digest_sha256: "e".repeat(64),
  };
}

function providerResultBinding() {
  return {
    schema_version: 2,
    namespace: "source-intake-provider-result-v2",
    request_id: requestId,
    input_digest_sha256: "e".repeat(64),
    provider_batch_name: "batches/source-backfill-1",
    provider_batch_request_key: requestId,
    model: "gemini-2.5-flash-lite",
    provider_result_sha256: "9".repeat(64),
    accepted_at: "2026-07-17T12:00:00.000Z",
    digest_sha256: "f".repeat(64),
  };
}

function approvedFailureContext(): SourceIntakeOperatorActionContext {
  const context = manualContext();
  return {
    ...context,
    statusReason: "low_coverage_backfill_source_activation_preflight_failed_no_charge",
    notificationMode: "baseline_only",
    aiReview: {
      ...(context.aiReview as Record<string, unknown>),
      manual_source_activation: {
        required: false,
        approved: true,
        approved_shared_award_id: awardId,
        approved_by: "admin@awardping.com",
        approved_at: "2026-07-17T12:02:00.000Z",
        source_registered: false,
        official_homepage_changed: false,
        notification_after_approval: "baseline_only",
        backfill_discovery_evidence_sha256: "7".repeat(64),
        provider_input_digest_sha256: "e".repeat(64),
        provider_result_binding_digest_sha256: "f".repeat(64),
        provider_result_sha256: "9".repeat(64),
      },
    },
  };
}

function retainedCaptureMetadata() {
  const fileHash = "a".repeat(64);
  const prefix = `source-intake-first-observation/v1/requests/${requestId}/sha256/${fileHash}`;
  return {
    capture_file_hash: fileHash,
    canonical_url: "https://example.org/apply",
    retained_artifact: {
      schema_version: 1,
      namespace: "source-intake-first-observation",
      request_id: requestId,
      captured_at: "2026-07-17T11:59:00.000Z",
      final_url: "https://example.org/apply",
      prefix,
      file_hash: fileHash,
      file_bytes: 1234,
      document_content_type: "text/html; charset=utf-8",
      text_hash: "b".repeat(64),
      text_length: 987,
      r2_bucket: "awardping-artifacts",
      r2_store_id: "account.r2.cloudflarestorage.com",
      r2_verified_at: "2026-07-17T12:01:00.000Z",
      artifacts: {
        pdf: {
          key: `${prefix}/document.pdf`,
          sha256: fileHash,
          byte_length: 1234,
          content_type: "text/html; charset=utf-8",
        },
        text: {
          key: `${prefix}/text.txt`,
          sha256: "c".repeat(64),
          byte_length: 988,
          content_type: "text/plain; charset=utf-8",
        },
        capture_metadata: {
          key: `${prefix}/capture.json`,
          sha256: "d".repeat(64),
          byte_length: 456,
          content_type: "application/json",
        },
      },
    },
  };
}

function expectOnlyActions(
  context: SourceIntakeOperatorActionContext,
  allowed: SourceIntakeOperatorAction[],
) {
  const actions: SourceIntakeOperatorAction[] = [
    "retry",
    "retry_reconciliation",
    "reject",
    "attach_to_award",
    "approve_backfill_source",
    "approve_as_new_award",
    "rerun_capture",
    "rerun_ai_review",
  ];
  for (const action of actions) {
    expect(
      sourceIntakeActionAllowedWithContext(action, "needs_manual_review", context),
      `${action} should ${allowed.includes(action) ? "be allowed" : "be blocked"}`,
    ).toBe(allowed.includes(action));
  }
}
