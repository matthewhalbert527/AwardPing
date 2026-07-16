import { describe, expect, it } from "vitest";
import {
  analyzeGeminiRequestInput,
  GEMINI_PAID_LANES,
  GeminiBudgetUnavailableError,
  estimateGeminiBatchRequestsCostUsd,
  estimateGeminiMaximumBatchRequestsCostUsd,
  geminiActiveWorkReservation,
  markGeminiSpendCreateStarted,
  releaseGeminiSpendReservation,
  reserveGeminiSpend,
  settleGeminiSpendReservation,
  submitGeminiSpendReservation,
  terminalGeminiSettlement,
  usdToMicroUsd,
} from "./gemini-spend-ledger.mjs";

const ATTEMPT_TOKEN = "11111111-1111-4111-8111-111111111111";
const WORK_FINGERPRINT = "award-page:example:review";

describe("atomic Gemini spend ledger client", () => {
  it("uses exact micro-dollar accounting", () => {
    expect(usdToMicroUsd(5)).toBe(5_000_000);
    expect(usdToMicroUsd(0.000001)).toBe(1);
  });

  it("accepts only the two permanent paid lanes", async () => {
    const calls = [];
    const supabase = {
      rpc: async (name, params) => {
        calls.push([name, params]);
        return {
        data: { granted: true, can_submit: true, reservation_id: "r1" },
        error: null,
        };
      },
    };
    await expect(reserveGeminiSpend({
      supabase,
      laneKey: GEMINI_PAID_LANES.NEW_PAGE_REVIEW,
      reservationKey: "new-page:test",
      attemptToken: ATTEMPT_TOKEN,
      workFingerprint: WORK_FINGERPRINT,
      estimatedCostUsd: 0.01,
      workerSource: "test",
      requestCount: 1,
      model: "gemini-2.5-flash-lite",
    })).resolves.toMatchObject({
      allowed: true,
      reservation_id: "r1",
      attempt_token: ATTEMPT_TOKEN,
      work_fingerprint: WORK_FINGERPRINT,
    });
    expect(calls[0]).toEqual([
      "reserve_gemini_spend",
      expect.objectContaining({
        p_attempt_token: ATTEMPT_TOKEN,
        p_work_fingerprint: WORK_FINGERPRINT,
      }),
    ]);
    await expect(reserveGeminiSpend({
      supabase,
      laneKey: "page_audit",
      reservationKey: "bad:test",
      estimatedCostUsd: 0.01,
      workerSource: "test",
      requestCount: 1,
      model: "gemini-2.5-flash-lite",
    })).rejects.toThrow("Unsupported Gemini paid lane");
  });

  it("turns an atomic refusal into a safe budget-deferred error", async () => {
    const supabase = {
      rpc: async () => ({
        data: { granted: false, can_submit: false, reason: "daily_cap_reached", cap_micro_usd: 5_000_000 },
        error: null,
      }),
    };
    await expect(reserveGeminiSpend({
      supabase,
      laneKey: GEMINI_PAID_LANES.CHANGED_PAGE_REVIEW,
      reservationKey: "changed:test",
      attemptToken: ATTEMPT_TOKEN,
      workFingerprint: WORK_FINGERPRINT,
      estimatedCostUsd: 0.01,
      workerSource: "test",
      requestCount: 1,
      model: "gemini-2.5-flash-lite",
    })).rejects.toBeInstanceOf(GeminiBudgetUnavailableError);
  });

  it("distinguishes equivalent work already in flight from exhausted budget", () => {
    const error = new GeminiBudgetUnavailableError("active", {
      reason: "active_work_reservation_exists",
      active_reservation_id: "reservation-1",
      active_status: "submitted",
    });
    expect(geminiActiveWorkReservation(error)).toEqual({
      reservationId: "reservation-1",
      status: "submitted",
      manualRecoveryRequired: false,
      automaticProviderPoll: true,
    });
    expect(geminiActiveWorkReservation({ reason: "daily_lane_cap_exceeded" })).toBeNull();
  });

  it("fails closed when the exact atomic reservation acknowledgement is incomplete", async () => {
    const supabase = {
      rpc: async () => ({ data: { granted: true, reservation_id: "r1" }, error: null }),
    };
    await expect(reserveGeminiSpend({
      supabase,
      laneKey: GEMINI_PAID_LANES.NEW_PAGE_REVIEW,
      reservationKey: "new-page:missing-can-submit",
      attemptToken: ATTEMPT_TOKEN,
      workFingerprint: WORK_FINGERPRINT,
      estimatedCostUsd: 0.01,
      workerSource: "test",
      requestCount: 1,
      model: "gemini-2.5-flash-lite",
    })).rejects.toBeInstanceOf(GeminiBudgetUnavailableError);
  });

  it("requires an owner UUID and a stable billable-work fingerprint", async () => {
    const supabase = { rpc: async () => ({ data: null, error: null }) };
    const base = {
      supabase,
      laneKey: GEMINI_PAID_LANES.NEW_PAGE_REVIEW,
      reservationKey: "new-page:owner-contract",
      estimatedCostUsd: 0.01,
      workerSource: "test",
      requestCount: 1,
      model: "gemini-2.5-flash-lite",
    };
    await expect(reserveGeminiSpend({
      ...base,
      attemptToken: "not-a-uuid",
      workFingerprint: WORK_FINGERPRINT,
    })).rejects.toThrow("attemptToken must be a UUID");
    await expect(reserveGeminiSpend({
      ...base,
      attemptToken: ATTEMPT_TOKEN,
      workFingerprint: " ",
    })).rejects.toThrow("workFingerprint is required");
  });

  it("estimates source-review batches before the provider call", () => {
    const cost = estimateGeminiBatchRequestsCostUsd("gemini-2.5-flash-lite", [
      { contents: [{ parts: [{ text: "x".repeat(4_000) }] }] },
    ]);
    expect(cost).toBeGreaterThan(0);
    expect(cost).toBeLessThan(0.01);
  });

  it("reserves a conservative maximum using full output limits and standard-rate headroom", () => {
    const requests = [{ contents: [{ parts: [{ text: "x".repeat(4_000) }] }] }];
    const ordinary = estimateGeminiBatchRequestsCostUsd("gemini-2.5-flash-lite", requests, {
      outputTokensPerRequest: 1_600,
    });
    const maximum = estimateGeminiMaximumBatchRequestsCostUsd("gemini-2.5-flash-lite", requests, {
      maxOutputTokensPerRequest: 1_600,
    });
    expect(maximum).toBeGreaterThan(ordinary * 2);
  });

  it("counts inline images by decoded tiles instead of charging base64 as text", () => {
    const png = Buffer.alloc(2 * 1024 * 1024);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
    png.writeUInt32BE(900, 16);
    png.writeUInt32BE(8_000, 20);
    const request = {
      contents: [{ parts: [{ text: "Compare" }, { inlineData: { mimeType: "image/png", data: png.toString("base64") } }] }],
    };
    const analyzed = analyzeGeminiRequestInput(request);
    expect(analyzed.imageTokens).toBe(2 * 11 * 258);
    expect(analyzed.textBytes).toBeLessThan(500);
    expect(estimateGeminiMaximumBatchRequestsCostUsd("gemini-2.5-flash-lite", [request], {
      maxOutputTokensPerRequest: 900,
    })).toBeLessThan(0.01);
  });

  it("requires positive acknowledgements for every paid-call lifecycle transition", async () => {
    const supabase = { rpc: async () => ({ data: {}, error: null }) };
    await expect(markGeminiSpendCreateStarted({
      supabase,
      reservationId: "r1",
      attemptToken: ATTEMPT_TOKEN,
    })).rejects.toThrow("provider-create start was not durably acknowledged");
    await expect(submitGeminiSpendReservation({
      supabase,
      reservationId: "r1",
      attemptToken: ATTEMPT_TOKEN,
      providerBatchName: "batches/1",
    })).rejects.toThrow("submission was not durably acknowledged");
    await expect(settleGeminiSpendReservation({
      supabase,
      reservationId: "r1",
      spentCostUsd: 0.01,
    })).rejects.toThrow("settlement was not durably acknowledged");
    await expect(releaseGeminiSpendReservation({
      supabase,
      reservationId: "r1",
      reason: "provider_create_not_reached:test",
    })).rejects.toThrow("release was not durably acknowledged");
  });

  it("binds release to the observed reservation state and attempt owner", async () => {
    const calls = [];
    const supabase = {
      rpc: async (name, params) => {
        calls.push([name, params]);
        return {
          data: { released: true, reservation_id: "r1", status: "released" },
          error: null,
        };
      },
    };
    await releaseGeminiSpendReservation({
      supabase,
      reservationId: "r1",
      reason: "provider_create_not_reached:test",
      expectedStatus: "reserved",
      expectedAttemptToken: ATTEMPT_TOKEN,
    });
    expect(calls).toEqual([[
      "release_gemini_spend_reservation",
      {
        p_reservation_id: "r1",
        p_reason: "provider_create_not_reached:test",
        p_expected_status: "reserved",
        p_expected_attempt_token: ATTEMPT_TOKEN,
      },
    ]]);
  });

  it("fails closed when provider-create ownership was already consumed", async () => {
    const supabase = {
      rpc: async () => ({
        data: { create_allowed: false, create_started: true, already_started: true },
        error: null,
      }),
    };
    await expect(markGeminiSpendCreateStarted({
      supabase,
      reservationId: "r1",
      attemptToken: ATTEMPT_TOKEN,
    })).rejects.toThrow("provider-create start was not durably acknowledged");
  });

  it("passes the same ownership token through create-start and submission", async () => {
    const calls = [];
    const supabase = {
      rpc: async (name, params) => {
        calls.push([name, params]);
        if (name === "mark_gemini_spend_create_started") {
          return {
            data: { create_allowed: true, create_started: true, already_started: false },
            error: null,
          };
        }
        return {
          data: { submitted: true, provider_batch_name: "batches/1" },
          error: null,
        };
      },
    };
    await markGeminiSpendCreateStarted({
      supabase,
      reservationId: "r1",
      attemptToken: ATTEMPT_TOKEN,
    });
    await submitGeminiSpendReservation({
      supabase,
      reservationId: "r1",
      attemptToken: ATTEMPT_TOKEN,
      providerBatchName: "batches/1",
    });
    expect(calls).toEqual([
      [
        "mark_gemini_spend_create_started",
        expect.objectContaining({ p_attempt_token: ATTEMPT_TOKEN }),
      ],
      [
        "submit_gemini_spend_reservation",
        expect.objectContaining({ p_attempt_token: ATTEMPT_TOKEN }),
      ],
    ]);
  });

  it("charges the full reserved maximum when terminal usage coverage is incomplete", () => {
    const incomplete = terminalGeminiSettlement({
      model: "gemini-2.5-flash-lite",
      usage: { prompt_tokens: 1_000, candidates_tokens: 500 },
      reservation: { request_count: 2, reserved_micro_usd: 250_000 },
      responseCount: 1,
      usageResponseCount: 1,
      mappingComplete: true,
    });
    expect(incomplete).toMatchObject({
      spentCostUsd: 0.25,
      spentSource: "terminal_batch_conservative_reserved_maximum",
      coverage: { complete: false, expected_responses: 2, observed_responses: 1 },
    });

    const complete = terminalGeminiSettlement({
      model: "gemini-2.5-flash-lite",
      usage: { prompt_tokens: 1_000, candidates_tokens: 500 },
      reservation: { request_count: 1, reserved_micro_usd: 250_000 },
      responseCount: 1,
      usageResponseCount: 1,
      mappingComplete: true,
    });
    expect(complete.spentSource).toBe("terminal_provider_usage");
    expect(complete.spentCostUsd).toBeLessThan(0.25);

    const missingUsage = terminalGeminiSettlement({
      model: "gemini-2.5-flash-lite",
      usage: {},
      reservation: { request_count: 1, reserved_micro_usd: 250_000 },
      responseCount: 1,
      usageResponseCount: 0,
    });
    expect(missingUsage).toMatchObject({
      spentCostUsd: 0.25,
      spentSource: "terminal_batch_conservative_reserved_maximum",
      coverage: { complete: false, observed_responses: 1, responses_with_usage: 0 },
    });

    const ambiguousMapping = terminalGeminiSettlement({
      model: "gemini-2.5-flash-lite",
      usage: { prompt_tokens: 1_000, candidates_tokens: 500 },
      reservation: { request_count: 1, reserved_micro_usd: 250_000 },
      responseCount: 1,
      usageResponseCount: 1,
      mappingComplete: false,
    });
    expect(ambiguousMapping).toMatchObject({
      spentCostUsd: 0.25,
      spentSource: "terminal_batch_conservative_reserved_maximum",
      coverage: { complete: false, mapping_complete: false },
    });
  });
});
