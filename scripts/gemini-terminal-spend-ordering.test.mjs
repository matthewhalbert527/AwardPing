import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = (name) => readFileSync(resolve(import.meta.dirname, name), "utf8");

describe("terminal Gemini spend ordering", () => {
  it("settles source-intake spend before publishing terminal results", () => {
    const text = source("process-source-intake-requests.mjs");
    const failure = text.slice(
      text.indexOf("if (!isGeminiBatchSucceeded(state))"),
      text.indexOf("const batchResponses = await geminiBatchResponseMap("),
    );
    expect(failure.indexOf("settleSourceIntakeBatchSpend")).toBeLessThan(
      failure.indexOf("markBatchRowsFailed"),
    );

    const success = text.slice(
      text.indexOf("const batchResponses = await geminiBatchResponseMap("),
      text.indexOf("async function settleSourceIntakeBatchSpend"),
    );
    expect(success.indexOf("settleSourceIntakeBatchSpend")).toBeLessThan(
      success.indexOf("for (const row of rows || [])"),
    );
  });

  it("settles visual-review spend before changing terminal candidate state", () => {
    const text = source("process-visual-review-batch.mjs");
    const poll = text.slice(
      text.indexOf("async function pollExistingBatches"),
      text.indexOf("async function reconcileStoredSucceededCandidates"),
    );
    const failure = poll.slice(
      poll.indexOf("if (!isGeminiBatchSucceeded(state))"),
      poll.indexOf("await reconcileCompletedBatch"),
    );
    expect(failure.indexOf("settleVisualBatchSpend")).toBeLessThan(
      failure.indexOf("markBatchRowsFailed"),
    );

    const reconcile = text.slice(
      text.indexOf("async function reconcileCompletedBatch"),
      text.indexOf("async function publishCandidateResultUnlocked"),
    );
    expect(reconcile.indexOf("settleVisualBatchSpend")).toBeLessThan(
      reconcile.indexOf("for (const candidate of candidates)"),
    );
  });

  it("prepares and settles baseline-facts usage before applying results", () => {
    const text = source("backfill-baseline-facts.mjs");
    const currentBatch = text.slice(
      text.indexOf("async function processGeminiApiBatchChunk("),
      text.indexOf("function baselineFactsReservationKey"),
    );
    expect(currentBatch.indexOf("prepareGeminiApiBatchResponses")).toBeLessThan(
      currentBatch.indexOf("applyGeminiApiBatchResponses"),
    );
    expect(currentBatch.indexOf("settleBaselineGeminiBatchSpend", currentBatch.indexOf("prepareGeminiApiBatchResponses"))).toBeLessThan(
      currentBatch.indexOf("applyGeminiApiBatchResponses"),
    );

    const existing = text.slice(
      text.indexOf("async function reconcileUnfinishedGeminiBatchJobs"),
      text.indexOf("function entriesForBatchStateJob"),
    );
    expect(existing.indexOf("prepareGeminiApiBatchResponses")).toBeLessThan(
      existing.indexOf("applyGeminiApiBatchResponses"),
    );
    expect(existing.indexOf("settleBaselineGeminiBatchSpend", existing.indexOf("prepareGeminiApiBatchResponses"))).toBeLessThan(
      existing.indexOf("applyGeminiApiBatchResponses"),
    );
  });

  it("requires complete response and usage coverage before releasing reserved headroom", () => {
    for (const name of [
      "process-source-intake-requests.mjs",
      "process-visual-review-batch.mjs",
      "backfill-baseline-facts.mjs",
    ]) {
      const text = source(name);
      expect(text).toContain("terminalGeminiSettlement({");
      expect(text).toContain("usageResponseCount");
      expect(text).toContain("mappingComplete");
      expect(text).toContain('reservation.status === "settled"');
      expect(text).toContain("coverage: settlement.coverage");
    }
  });

  it("retains known provider jobs and pending reservations across worker crashes", () => {
    const sourceIntake = source("process-source-intake-requests.mjs");
    expect(sourceIntake).toContain('knownBatchName ? "ai_review_submitted" : "needs_manual_review"');
    expect(sourceIntake).toContain('"gemini_batch_binding_recovery_pending"');
    expect(sourceIntake).toContain('reservation.status === "creating"');
    expect(sourceIntake).toContain('paidReviewWorkFingerprint(\n    "new-page-review"');
    expect(sourceIntake).toContain("workFingerprint,");
    expect(sourceIntake).not.toContain("workFingerprint: reservationKey");
    expect(sourceIntake.indexOf("journalSourceIntakeProviderBatchName(claimedRows")).toBeLessThan(
      sourceIntake.indexOf("await submitGeminiSpendReservation({", sourceIntake.indexOf("journalSourceIntakeProviderBatchName(claimedRows")),
    );

    const visualReview = source("process-visual-review-batch.mjs");
    expect(visualReview).toContain('status: knownBatchName ? "submitted" : "failed"');
    expect(visualReview).toContain("provider_binding_recovery_required: Boolean(knownBatchName)");
    expect(visualReview).toContain('reservation.status === "creating"');
    expect(visualReview).toContain('paidReviewWorkFingerprint(\n    "changed-page-review"');
    expect(visualReview).not.toContain("workFingerprint: reservationKey");
    expect(visualReview.indexOf("journalVisualProviderBatchName(claimedCandidates")).toBeLessThan(
      visualReview.indexOf("await submitGeminiSpendReservation({", visualReview.indexOf("journalVisualProviderBatchName(claimedCandidates")),
    );

    const baseline = source("backfill-baseline-facts.mjs");
    expect(baseline).toContain('"reservation_pending"');
    expect(baseline).toContain("recoverBaselinePreCreateReservations(batchState, report)");
    expect(baseline.indexOf('status: "reservation_pending"')).toBeLessThan(
      baseline.indexOf("spendReservation = await reserveGeminiSpend"),
    );
  });

  it("routes equivalent active work to recovery instead of budget reset", () => {
    const sourceIntake = source("process-source-intake-requests.mjs");
    expect(sourceIntake).toContain("const activeWork = geminiActiveWorkReservation(error)");
    expect(sourceIntake).toContain("deferSourceIntakeClaimsForActiveWork");
    expect(sourceIntake).toContain("automatic_retry_after_budget_reset: false");

    const visualReview = source("process-visual-review-batch.mjs");
    expect(visualReview).toContain("const activeWork = geminiActiveWorkReservation(error)");
    expect(visualReview).toContain("deferVisualSubmissionClaimsForActiveWork");
    expect(visualReview).toContain("VISUAL_REVIEW_ACTIVE_WORK");

    const baseline = source("backfill-baseline-facts.mjs");
    expect(baseline).toContain("const activeWork = geminiActiveWorkReservation(error)");
    expect(baseline).toContain('"gemini_equivalent_review_already_in_flight"');
    expect(baseline).toContain('"active_work_waiting"');
    expect(baseline).toContain('expectedStatus: "reserved"');
    expect(baseline).not.toContain('error.status?.status === "creating"');
  });
});
