import { describe, expect, it } from "vitest";
import { GEMINI_PAID_LANES } from "./gemini-spend-ledger.mjs";
import {
  paidVisualProviderRequestFingerprint,
  paidVisualRetryAuthorizationPrecheck,
  paidVisualReviewLaneForCandidate,
  paidVisualReviewWorkKindForLane,
  partitionPaidVisualReviewCandidates,
  runPaidVisualProviderCreateBoundary,
} from "./paid-visual-review-policy.mjs";

const fingerprint = "a".repeat(64);

describe("paid visual-review lane policy", () => {
  it("partitions mixed new-document and changed-page work into independent lanes", () => {
    const initialDocument = {
      id: "new-page",
      candidate_scope: "initial_official_document",
      worker_metadata: {},
    };
    const changedPage = {
      id: "changed-page",
      candidate_scope: "content_change",
      worker_metadata: {},
    };
    const lanes = partitionPaidVisualReviewCandidates([
      changedPage,
      initialDocument,
    ]);

    expect([...lanes.keys()].sort()).toEqual([
      GEMINI_PAID_LANES.CHANGED_PAGE_REVIEW,
      GEMINI_PAID_LANES.NEW_PAGE_REVIEW,
    ]);
    expect(lanes.get(GEMINI_PAID_LANES.NEW_PAGE_REVIEW)).toEqual([
      initialDocument,
    ]);
    expect(lanes.get(GEMINI_PAID_LANES.CHANGED_PAGE_REVIEW)).toEqual([
      changedPage,
    ]);
    expect(paidVisualReviewWorkKindForLane(GEMINI_PAID_LANES.NEW_PAGE_REVIEW))
      .toBe("new-page-review");
    expect(paidVisualReviewWorkKindForLane(GEMINI_PAID_LANES.CHANGED_PAGE_REVIEW))
      .toBe("changed-page-review");
  });

  it("requires an exact request fingerprint and the matching spend lane for retries", () => {
    const retry = {
      candidate_scope: "initial_official_document",
      worker_metadata: {
        failure_retry_count: 1,
        paid_retry_approval_id: "approval-1",
        paid_retry_approved_request_fingerprint: fingerprint,
      },
    };
    expect(paidVisualReviewLaneForCandidate(retry)).toBe(
      GEMINI_PAID_LANES.NEW_PAGE_REVIEW,
    );
    expect(paidVisualRetryAuthorizationPrecheck(
      retry,
      GEMINI_PAID_LANES.NEW_PAGE_REVIEW,
    )).toMatchObject({
      required: true,
      allowed: true,
      requestFingerprint: fingerprint,
    });
    expect(paidVisualRetryAuthorizationPrecheck(
      retry,
      GEMINI_PAID_LANES.CHANGED_PAGE_REVIEW,
    )).toMatchObject({
      required: true,
      allowed: false,
      reason: "paid_retry_lane_mismatch",
    });
    expect(paidVisualRetryAuthorizationPrecheck(
      { ...retry, worker_metadata: { failure_retry_count: 1 } },
      GEMINI_PAID_LANES.NEW_PAGE_REVIEW,
    )).toMatchObject({
      required: true,
      allowed: false,
      reason: "paid_retry_approval_missing",
    });
  });

  it("binds model, lane, config, and exact inline bytes into the provider request", () => {
    const base = {
      laneKey: GEMINI_PAID_LANES.CHANGED_PAGE_REVIEW,
      model: "gemini-3-flash",
      batchRequest: {
        request: {
          generationConfig: { temperature: 0.1 },
          contents: [{ parts: [{ inlineData: { mimeType: "image/png", data: "YWJj" } }] }],
        },
        metadata: { key: "candidate-1" },
      },
    };
    const exact = paidVisualProviderRequestFingerprint(base);
    expect(exact).toMatch(/^[0-9a-f]{64}$/);
    expect(paidVisualProviderRequestFingerprint({
      ...base,
      model: "gemini-3.1-flash",
    })).not.toBe(exact);
    expect(paidVisualProviderRequestFingerprint({
      ...base,
      batchRequest: {
        ...base.batchRequest,
        request: {
          ...base.batchRequest.request,
          contents: [{ parts: [{ inlineData: { mimeType: "image/png", data: "dGFtcGVyZWQ=" } }] }],
        },
      },
    })).not.toBe(exact);
  });

  it("rechecks after create-start journaling and never invokes provider after near-expiry", async () => {
    const calls = [];
    let now = 99;
    const expiresAt = 100;

    await expect(runPaidVisualProviderCreateBoundary({
      journalCreateStart: async () => {
        calls.push("journal");
        now = 101;
      },
      authorizeAtProviderBoundary: async () => {
        calls.push("authorize");
        return {
          failures: now >= expiresAt
            ? [{ reason: "paid_retry_approval_expired" }]
            : [],
        };
      },
      providerCreate: async () => {
        calls.push("provider_post");
        return { name: "batches/unsafe" };
      },
    })).rejects.toMatchObject({
      paidRetryAuthorizationFailures: [
        { reason: "paid_retry_approval_expired" },
      ],
    });
    expect(calls).toEqual(["journal", "authorize"]);
  });
});
