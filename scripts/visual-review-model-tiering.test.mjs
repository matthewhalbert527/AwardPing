import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  GEMINI_STRONG_WORKER_MODEL,
  GEMINI_WORKER_MODEL,
  VISUAL_REVIEW_STRONG_MODEL_MAX_REQUESTS_PER_BATCH,
  buildEscalationRequeue,
  geminiModelFamily,
  isGeminiStrongWorkerModel,
  modelForCandidate,
  partitionVisualReviewCandidatesByModel,
  visualReviewClaimedModel,
  visualReviewEscalation,
  visualReviewGenerationConfigForModel,
  visualReviewInvalidJsonEscalationDecision,
  visualReviewMaxOutputTokensForModel,
  visualReviewMaxRequestsPerBatchForModel,
  visualReviewModelSelectionReason,
} from "./lib/gemini-worker-policy.mjs";
import {
  estimateGeminiMaximumBatchRequestsCostUsd,
  GEMINI_PAID_LANES,
} from "./lib/gemini-spend-ledger.mjs";
import {
  extractGeminiFinishReason,
  geminiPricePerMillion,
} from "./lib/gemini-batch-support.mjs";
import { partitionPaidVisualReviewCandidates } from "./lib/paid-visual-review-policy.mjs";
import {
  emptyStage1ManifestSources,
  isStage1ManifestSource,
} from "./lib/stage1-manifest-sources.mjs";

const worker = readFileSync(
  new URL("./process-visual-review-batch.mjs", import.meta.url),
  "utf8",
);

const functionBody = (name, nextName) => {
  const start = worker.indexOf(`${name}(`);
  const end = worker.indexOf(nextName, start + 1);
  expect(start, `${name} must exist`).toBeGreaterThanOrEqual(0);
  expect(end, `${nextName} must follow ${name}`).toBeGreaterThan(start);
  return worker.slice(start, end);
};

const STAGE1_SOURCE = "11111111-1111-4111-8111-111111111111";
const FLEET_SOURCE = "22222222-2222-4222-8222-222222222222";

function manifestWith(...sourceIds) {
  const manifest = emptyStage1ManifestSources();
  manifest.available = true;
  for (const id of sourceIds) {
    manifest.sourceIds.add(id);
    manifest.cohortBySourceId.set(id, "cohort-a");
  }
  return manifest;
}

function candidate(overrides = {}) {
  return {
    id: "cand-1",
    status: "processing",
    candidate_scope: "content_change",
    shared_award_source_id: FLEET_SOURCE,
    model: GEMINI_WORKER_MODEL,
    gemini_batch_name: "batches/fleet-1",
    gemini_batch_request_key: "sig-1",
    worker_metadata: {
      submission_claim_token: "claim-1",
      gemini_spend_reservation_id: "res-1",
      gemini_spend_lane: GEMINI_PAID_LANES.CHANGED_PAGE_REVIEW,
      gemini_spend_estimated_cost_usd: 0.01,
      monitoring_policy: { id: "policy", version: 1, hash: "abc" },
    },
    ...overrides,
  };
}

describe("visual review model tiering", () => {
  it("keeps the fleet and strong model names in one place", () => {
    expect(GEMINI_WORKER_MODEL).toBe("gemini-2.5-flash-lite");
    expect(GEMINI_STRONG_WORKER_MODEL).toBe("gemini-3.7-flash");
    expect(geminiModelFamily("gemini-2.5-flash-lite")).toBe("flash-lite");
    expect(geminiModelFamily("models/gemini-3.7-flash")).toBe("gemini-3-flash");
    expect(geminiModelFamily("gemini-3.1-flash-lite")).toBe("flash-lite");
    expect(geminiModelFamily("gemini-2.5-flash")).toBeNull();
    expect(isGeminiStrongWorkerModel(GEMINI_STRONG_WORKER_MODEL)).toBe(true);
    expect(isGeminiStrongWorkerModel(GEMINI_WORKER_MODEL)).toBe(false);
  });

  it("derives the output cap and thinking config from the model family", () => {
    expect(visualReviewGenerationConfigForModel(GEMINI_WORKER_MODEL)).toEqual({
      temperature: 0.1,
      maxOutputTokens: 2048,
      thinkingConfig: { thinkingBudget: 0 },
    });
    // Gemini 3 guidance: temperature stays at its default 1.0.
    expect(visualReviewGenerationConfigForModel(GEMINI_STRONG_WORKER_MODEL)).toEqual({
      temperature: 1,
      maxOutputTokens: 4096,
      thinkingConfig: { thinkingLevel: "low" },
    });
    expect(visualReviewMaxOutputTokensForModel(GEMINI_WORKER_MODEL)).toBe(2048);
    expect(visualReviewMaxOutputTokensForModel(GEMINI_STRONG_WORKER_MODEL)).toBe(4096);
    expect(() => visualReviewGenerationConfigForModel("gemini-2.5-flash")).toThrow(
      /no generation policy/,
    );
    expect(() => visualReviewGenerationConfigForModel("")).toThrow(/no generation policy/);
  });

  it("returns a fresh config object each call so callers cannot mutate the policy", () => {
    const first = visualReviewGenerationConfigForModel(GEMINI_STRONG_WORKER_MODEL);
    first.thinkingConfig.thinkingLevel = "high";
    first.maxOutputTokens = 1;
    expect(visualReviewGenerationConfigForModel(GEMINI_STRONG_WORKER_MODEL)).toEqual({
      temperature: 1,
      maxOutputTokens: 4096,
      thinkingConfig: { thinkingLevel: "low" },
    });
  });

  it("prices the strong tier explicitly and estimates with its own cap", () => {
    expect(geminiPricePerMillion(GEMINI_STRONG_WORKER_MODEL, "batch")).toEqual({
      input: 0.375,
      output: 1.875,
    });
    expect(geminiPricePerMillion(GEMINI_STRONG_WORKER_MODEL, "standard")).toEqual({
      input: 0.75,
      output: 3.75,
    });
    const requests = [{ contents: [{ parts: [{ text: "compare these pages" }] }] }];
    const fleet = estimateGeminiMaximumBatchRequestsCostUsd(GEMINI_WORKER_MODEL, requests, {
      maxOutputTokensPerRequest: visualReviewMaxOutputTokensForModel(GEMINI_WORKER_MODEL),
    });
    const strong = estimateGeminiMaximumBatchRequestsCostUsd(GEMINI_STRONG_WORKER_MODEL, requests, {
      maxOutputTokensPerRequest: visualReviewMaxOutputTokensForModel(GEMINI_STRONG_WORKER_MODEL),
    });
    // 4096 output tokens at $3.75/M versus 2048 at $0.40/M.
    expect(strong).toBeGreaterThan(fleet * 10);
    expect(strong).toBeGreaterThanOrEqual((4096 * 3.75) / 1_000_000);
    expect(strong).toBeLessThan(0.02);
  });

  it("selects the strong model for Stage 1 manifest sources and escalations only", () => {
    const manifest = manifestWith(STAGE1_SOURCE);
    expect(isStage1ManifestSource(manifest, STAGE1_SOURCE)).toBe(true);

    const stage1 = candidate({ shared_award_source_id: STAGE1_SOURCE });
    const fleet = candidate();
    const escalated = candidate({
      worker_metadata: { escalation: { attempt: 1, reason: "invalid_ai_json" } },
    });

    expect(modelForCandidate(stage1, manifest)).toBe(GEMINI_STRONG_WORKER_MODEL);
    expect(modelForCandidate(escalated, manifest)).toBe(GEMINI_STRONG_WORKER_MODEL);
    expect(modelForCandidate(escalated, emptyStage1ManifestSources())).toBe(GEMINI_STRONG_WORKER_MODEL);
    expect(modelForCandidate(fleet, manifest)).toBe(GEMINI_WORKER_MODEL);
    expect(modelForCandidate(fleet, emptyStage1ManifestSources())).toBe(GEMINI_WORKER_MODEL);
    expect(modelForCandidate(fleet, null)).toBe(GEMINI_WORKER_MODEL);
    // A model pre-stamped by capture does not decide the tier.
    expect(modelForCandidate(candidate({ model: GEMINI_STRONG_WORKER_MODEL }), manifest)).toBe(
      GEMINI_WORKER_MODEL,
    );

    expect(visualReviewModelSelectionReason(stage1, manifest)).toBe("stage1_manifest_source");
    expect(visualReviewModelSelectionReason(escalated, manifest)).toBe("escalation");
    expect(visualReviewModelSelectionReason(fleet, manifest)).toBe("fleet_default");
    expect(visualReviewEscalation(escalated)).toEqual({ attempt: 1, reason: "invalid_ai_json" });
    expect(visualReviewEscalation(fleet)).toBeNull();
    expect(visualReviewEscalation(candidate({ worker_metadata: { escalation: {} } }))).toBeNull();
  });

  it("partitions each paid lane into one submission group per model", () => {
    const manifest = manifestWith(STAGE1_SOURCE);
    const rows = [
      candidate({ id: "fleet-a" }),
      candidate({ id: "stage1-a", shared_award_source_id: STAGE1_SOURCE }),
      candidate({ id: "fleet-b" }),
      candidate({
        id: "escalated-a",
        worker_metadata: { escalation: { attempt: 1, reason: "invalid_ai_json" } },
      }),
      candidate({ id: "new-page-fleet", candidate_scope: "initial_official_document" }),
      candidate({
        id: "new-page-stage1",
        candidate_scope: "initial_official_document",
        shared_award_source_id: STAGE1_SOURCE,
      }),
    ];

    const submitCalls = [];
    const maxRequestsPerBatch = 250;
    for (const [laneKey, laneCandidates] of partitionPaidVisualReviewCandidates(rows)) {
      const byModel = partitionVisualReviewCandidatesByModel(laneCandidates, manifest);
      for (const [chunkModel, modelCandidates] of byModel) {
        const chunkSize = visualReviewMaxRequestsPerBatchForModel(chunkModel, maxRequestsPerBatch);
        for (let index = 0; index < modelCandidates.length; index += chunkSize) {
          submitCalls.push({
            laneKey,
            model: chunkModel,
            ids: modelCandidates.slice(index, index + chunkSize).map((row) => row.id),
          });
        }
      }
    }

    expect(submitCalls).toEqual([
      {
        laneKey: GEMINI_PAID_LANES.CHANGED_PAGE_REVIEW,
        model: GEMINI_WORKER_MODEL,
        ids: ["fleet-a", "fleet-b"],
      },
      {
        laneKey: GEMINI_PAID_LANES.CHANGED_PAGE_REVIEW,
        model: GEMINI_STRONG_WORKER_MODEL,
        ids: ["stage1-a", "escalated-a"],
      },
      {
        laneKey: GEMINI_PAID_LANES.NEW_PAGE_REVIEW,
        model: GEMINI_WORKER_MODEL,
        ids: ["new-page-fleet"],
      },
      {
        laneKey: GEMINI_PAID_LANES.NEW_PAGE_REVIEW,
        model: GEMINI_STRONG_WORKER_MODEL,
        ids: ["new-page-stage1"],
      },
    ]);
    // Every group carries exactly one model, so settlement reads one model per batch.
    for (const call of submitCalls) {
      expect(new Set(call.ids.map((id) => modelForCandidate(rows.find((row) => row.id === id), manifest))).size).toBe(1);
    }
  });

  it("caps strong-model provider batches at the named constant", () => {
    expect(VISUAL_REVIEW_STRONG_MODEL_MAX_REQUESTS_PER_BATCH).toBe(25);
    expect(visualReviewMaxRequestsPerBatchForModel(GEMINI_STRONG_WORKER_MODEL, 250)).toBe(25);
    expect(visualReviewMaxRequestsPerBatchForModel(GEMINI_STRONG_WORKER_MODEL, 10)).toBe(10);
    expect(visualReviewMaxRequestsPerBatchForModel(GEMINI_WORKER_MODEL, 250)).toBe(250);
    expect(visualReviewMaxRequestsPerBatchForModel(GEMINI_WORKER_MODEL, 0)).toBe(1);

    const manifest = manifestWith(STAGE1_SOURCE);
    const rows = Array.from({ length: 60 }, (_, index) =>
      candidate({ id: `stage1-${index}`, shared_award_source_id: STAGE1_SOURCE }));
    const groups = partitionVisualReviewCandidatesByModel(rows, manifest);
    expect([...groups.keys()]).toEqual([GEMINI_STRONG_WORKER_MODEL]);
    const chunkSize = visualReviewMaxRequestsPerBatchForModel(GEMINI_STRONG_WORKER_MODEL, 250);
    const chunkCount = Math.ceil(groups.get(GEMINI_STRONG_WORKER_MODEL).length / chunkSize);
    expect(chunkCount).toBe(3);
  });

  it("wires the lane so the submission loop partitions by model and chunks per tier", () => {
    const submitPending = functionBody(
      "async function submitPendingCandidates",
      "async function recoverStaleSubmissionClaims",
    );
    expect(submitPending).toContain("partitionPaidVisualReviewCandidates(eligible)");
    expect(submitPending).toContain("partitionVisualReviewCandidatesByModel(laneCandidates, stage1Manifest)");
    expect(submitPending).toContain("visualReviewMaxRequestsPerBatchForModel(chunkModel, maxRequestsPerBatch)");
    expect(submitPending).toContain("await submitCandidateChunk(chunkModel, chunk, laneKey)");
    expect(submitPending.indexOf("partitionPaidVisualReviewCandidates(eligible)")).toBeLessThan(
      submitPending.indexOf("partitionVisualReviewCandidatesByModel("),
    );
    expect(worker).toContain("stage1Manifest = await loadStage1ManifestSources(supabase)");
    expect(worker).not.toContain("const model = geminiWorkerModel();");
  });

  it("binds the claimed model to the request, the estimate, and the persisted row", () => {
    const submit = functionBody(
      "async function submitCandidateChunk",
      "async function persistSubmittedClaim",
    );
    expect(submit).toContain("const maxOutputTokensPerRequest = visualReviewMaxOutputTokensForModel(model)");
    expect(submit).toContain("review_model: model,");
    expect(submit).toContain("geminiBatchRequestForCandidate(candidate)");
    expect(submit).toContain("maxOutputTokensPerRequest,\n  });");
    expect(submit).not.toContain("maxOutputTokensPerRequest: 900");
    expect(submit.indexOf("review_model: model,")).toBeLessThan(
      submit.indexOf("geminiBatchRequestForCandidate(candidate)"),
    );

    const request = functionBody(
      "function geminiBatchRequestForCandidate",
      "async function createGeminiBatchJob",
    );
    expect(request).toContain("visualReviewGenerationConfigForModel(");
    expect(request).toContain("visualReviewClaimedModel(candidate)");
    expect(request).toContain("...generationConfig,");
    expect(request).toContain('responseMimeType: "application/json"');
    expect(request).toContain("responseSchema: visualReviewResponseSchema");
    expect(request).not.toContain("maxOutputTokens: 900");
    expect(request).not.toContain("thinkingBudget");

    expect(visualReviewClaimedModel(candidate({
      worker_metadata: { review_model: GEMINI_STRONG_WORKER_MODEL },
    }))).toBe(GEMINI_STRONG_WORKER_MODEL);
    expect(() => visualReviewClaimedModel(candidate({ worker_metadata: {} }))).toThrow(
      /claimed without a bound review model/,
    );
  });

  it("reads the provider finish reason from the first candidate", () => {
    expect(extractGeminiFinishReason({
      candidates: [
        { finishReason: "MAX_TOKENS", content: { parts: [{ text: '{"is_true_change":' }] } },
        { finishReason: "STOP" },
      ],
    })).toBe("MAX_TOKENS");
    expect(extractGeminiFinishReason({ candidates: [{ content: { parts: [] } }] })).toBeNull();
    expect(extractGeminiFinishReason({})).toBeNull();
  });

  it("requeues an invalid fleet verdict for the strong model with the accounting kept", () => {
    const usage = {
      prompt_tokens: 5_000,
      candidates_tokens: 899,
      total_tokens: 5_899,
      thoughts_tokens: 0,
      cached_content_tokens: 0,
    };
    const rawText = "{".repeat(6_000);
    const row = candidate();
    const decision = visualReviewInvalidJsonEscalationDecision(row);
    expect(decision).toEqual({ escalate: true, reason: "invalid_ai_json" });

    const requeue = buildEscalationRequeue(row, {
      usage,
      rawText,
      parseError: "Gemini visual review returned invalid JSON.",
      finishReason: "MAX_TOKENS",
      model: row.model,
      batchName: row.gemini_batch_name,
      now: "2026-09-03T12:00:00.000Z",
    });

    // gemini_batch_request_key is left alone: the candidate-identity trigger
    // rejects any change to it on a non-pending row. Claim and reservation
    // keys of the settled fleet batch are cleared so a crash between the new
    // claim and its create-start cannot rebind the row to the old batch.
    expect(requeue).not.toHaveProperty("gemini_batch_request_key");
    expect(requeue).toEqual({
      status: "pending",
      gemini_batch_name: null,
      model: null,
      ai_result: null,
      rejection_reason: null,
      actual_usage: usage,
      submitted_at: null,
      completed_at: null,
      worker_metadata: {
        submission_claim_token: null,
        submission_claimed_at: null,
        submission_claimed_by: null,
        batch_create_started_at: null,
        possible_external_batch_name: null,
        gemini_spend_reservation_id: null,
        gemini_spend_reservation_key: null,
        gemini_spend_attempt_token: null,
        gemini_spend_lane: GEMINI_PAID_LANES.CHANGED_PAGE_REVIEW,
        gemini_spend_estimated_cost_usd: 0.01,
        monitoring_policy: { id: "policy", version: 1, hash: "abc" },
        escalation: {
          attempt: 1,
          reason: "invalid_ai_json",
          from_model: GEMINI_WORKER_MODEL,
          from_batch_name: "batches/fleet-1",
          finish_reason: "MAX_TOKENS",
          prior_raw_text: "{".repeat(4_000),
          prior_parse_error: "Gemini visual review returned invalid JSON.",
          escalated_at: "2026-09-03T12:00:00.000Z",
        },
      },
      updated_at: "2026-09-03T12:00:00.000Z",
    });
    expect(requeue.worker_metadata.escalation.prior_raw_text).toHaveLength(4_000);
    // The requeued row now routes to the strong tier.
    expect(modelForCandidate({ ...row, ...requeue }, emptyStage1ManifestSources())).toBe(
      GEMINI_STRONG_WORKER_MODEL,
    );
    // The original row is not mutated.
    expect(row.worker_metadata.escalation).toBeUndefined();
  });

  it("falls back to candidate fields and a fresh timestamp when options are omitted", () => {
    const requeue = buildEscalationRequeue(candidate({ worker_metadata: null }), {});
    expect(requeue.worker_metadata.escalation.from_model).toBe(GEMINI_WORKER_MODEL);
    expect(requeue.worker_metadata.escalation.from_batch_name).toBe("batches/fleet-1");
    expect(requeue.worker_metadata.escalation.finish_reason).toBeNull();
    expect(requeue.worker_metadata.escalation.prior_raw_text).toBe("");
    expect(requeue.worker_metadata.escalation.prior_parse_error).toBeNull();
    expect(requeue.actual_usage).toEqual({});
    expect(Number.isNaN(Date.parse(requeue.worker_metadata.escalation.escalated_at))).toBe(false);
    expect(requeue.updated_at).toBe(requeue.worker_metadata.escalation.escalated_at);
  });

  it("caps escalation at one attempt and never escalates a strong-model or failed row", () => {
    const escalatedOnce = candidate({
      model: GEMINI_STRONG_WORKER_MODEL,
      gemini_batch_name: "batches/strong-1",
      worker_metadata: { escalation: { attempt: 1, reason: "invalid_ai_json" } },
    });
    expect(visualReviewInvalidJsonEscalationDecision(escalatedOnce)).toEqual({
      escalate: false,
      reason: "already_strong_model",
    });
    expect(visualReviewInvalidJsonEscalationDecision(candidate({
      worker_metadata: { escalation: { attempt: 1, reason: "invalid_ai_json" } },
    }))).toEqual({ escalate: false, reason: "escalation_attempts_exhausted" });
    expect(visualReviewInvalidJsonEscalationDecision(candidate({
      model: GEMINI_STRONG_WORKER_MODEL,
    }))).toEqual({ escalate: false, reason: "already_strong_model" });
    expect(visualReviewInvalidJsonEscalationDecision(candidate({
      status: "failed",
      rejection_reason: "missing_batch_response",
    }))).toEqual({ escalate: false, reason: "failed_row_requires_paid_retry_approval" });
    expect(visualReviewInvalidJsonEscalationDecision(candidate({ model: null }))).toEqual({
      escalate: true,
      reason: "invalid_ai_json",
    });
    // Only in-flight rows escalate; a succeeded row re-parsed with an empty
    // ai_result must not be moved back to pending under a publication claim.
    expect(visualReviewInvalidJsonEscalationDecision(candidate({ status: "succeeded" }))).toEqual({
      escalate: false,
      reason: "status_succeeded_not_in_flight",
    });
    // An operator-approved paid retry is bound to the fleet request it was
    // authorised for; re-asking another model would fail as request drift.
    expect(visualReviewInvalidJsonEscalationDecision(candidate({
      worker_metadata: { paid_retry_approval_id: "approval-1" },
    }))).toEqual({ escalate: false, reason: "paid_retry_bound_to_authorised_request" });
    expect(visualReviewInvalidJsonEscalationDecision(candidate({
      worker_metadata: { failure_retry_count: 1 },
    }))).toEqual({ escalate: false, reason: "paid_retry_bound_to_authorised_request" });
  });

  it("submits the fleet tier before the strong tier within a lane", () => {
    const manifest = manifestWith(STAGE1_SOURCE);
    const byModel = partitionVisualReviewCandidatesByModel([
      candidate({ id: "stage1-first", shared_award_source_id: STAGE1_SOURCE }),
      candidate({ id: "fleet-second" }),
    ], manifest);
    expect([...byModel.keys()]).toEqual([GEMINI_WORKER_MODEL, GEMINI_STRONG_WORKER_MODEL]);
  });

  it("writes the terminal invalid_ai_json failure only after the escalation decision declines", () => {
    const reconcile = functionBody(
      "async function reconcileCompletedBatch",
      "async function claimCompletedCandidatePublication",
    );
    expect(reconcile.indexOf("settleVisualBatchSpend")).toBeLessThan(
      reconcile.indexOf("for (const candidate of candidates)"),
    );
    expect(reconcile).toContain("const finishReason = extractGeminiFinishReason(responsePayload)");
    expect(reconcile).toContain("finish_reason: finishReason,");
    expect(reconcile).toContain("visualReviewInvalidJsonEscalationDecision(candidate)");
    expect(reconcile).toContain("buildEscalationRequeue(candidate, {");
    expect(reconcile).toContain("VISUAL_REVIEW_ESCALATED candidate=");
    expect(reconcile).toContain("rejection_reason: `invalid_ai_json: ${errorMessage(error)}`");
    expect(reconcile.indexOf("if (escalation.escalate) {")).toBeLessThan(
      reconcile.indexOf('status: "failed",\n          ai_result: {\n            raw_text: rawText,'),
    );
    const failureWrite = reconcile.slice(
      reconcile.indexOf('status: "failed",\n          ai_result: {\n            raw_text: rawText,'),
      reconcile.indexOf("rejection_reason: `invalid_ai_json:"),
    );
    expect(failureWrite).toContain("finish_reason: finishReason,");
    expect(failureWrite).toContain("usage,");
  });
});
