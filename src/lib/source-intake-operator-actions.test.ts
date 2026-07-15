import { describe, expect, it } from "vitest";
import {
  sourceIntakeActionAllowed,
  sourceIntakeActionAllowedWithContext,
  sourceIntakeAllowedStatuses,
} from "@/lib/source-intake-operator-actions";

describe("source intake operator actions", () => {
  it("blocks operator mutations while work or an external Batch is active", () => {
    for (const status of ["validating", "capturing", "ai_review_pending", "ai_review_submitted", "matching"]) {
      for (const action of ["retry", "reject", "attach_to_award", "rerun_capture", "rerun_ai_review"] as const) {
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
});
