import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { estimateGeminiCostUsd } from "./gemini-batch-support.mjs";
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

// Fake PDF bytes exercise budget bindings only, not document parsing or ownership.
function nativePdfFixture(previousPages = 13, currentPages = 14) {
  const bodies = [Buffer.from("%PDF-1.7\nprevious synthetic document"), Buffer.from("%PDF-1.7\ncurrent synthetic document")];
  const inputs = bodies.map((bytes, index) => ({
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byte_length: bytes.length,
    page_count: [previousPages, currentPages][index],
    native_text: ["Previous résumé.\nAll conditions.", "Current 条件.\nComplete text."][index],
  }));
  return {
    request: {
      request: {
        contents: [{ role: "user", parts: [{ text: "Compare BOTH complete official PDFs." },
          ...bodies.map(bytes => ({ inlineData: { mimeType: "application/pdf", data: bytes.toString("base64") } }))] }],
        generationConfig: { mediaResolution: "MEDIA_RESOLUTION_HIGH", maxOutputTokens: 4_096 },
      },
      metadata: { key: "synthetic-candidate" },
    },
    inputs,
  };
}

const pdfOptions = inputs => ({ model: "gemini-3.8-flash", verifiedPdfInputs: inputs });
const pdfParts = request => request.request.contents[0].parts.slice(1);

describe("verified native PDF budget opt-in", () => {
  it.each([[13, 14], [14, 13], [25, 25], [1, 1]])("counts BOTH complete %i/%i page inventories at HIGH plus all native UTF-8 bytes", (previous, current) => {
    const { request, inputs } = nativePdfFixture(previous, current);
    const scrubbed = structuredClone(request);
    pdfParts(scrubbed).forEach(part => { part.inlineData.data = ""; });
    expect(analyzeGeminiRequestInput(request, pdfOptions(inputs))).toEqual({
      imageTokens: (previous + current) * 1_120,
      textBytes: Buffer.byteLength(JSON.stringify(scrubbed)) + inputs.reduce((sum, input) => sum + Buffer.byteLength(input.native_text), 0),
    });
  });

  it("uses standard rates, full output cap, overhead and at least 2x media headroom", () => {
    const { request, inputs } = nativePdfFixture();
    const analyzed = analyzeGeminiRequestInput(request, pdfOptions(inputs));
    const expected = estimateGeminiCostUsd("gemini-3.8-flash", {
      prompt_tokens: analyzed.textBytes + analyzed.imageTokens * 2 + 1_024,
      candidates_tokens: 4_096,
    }, "standard");
    for (const imageTokenSafetyMultiplier of [undefined, 1, 2]) {
      expect(estimateGeminiMaximumBatchRequestsCostUsd("gemini-3.8-flash", [request], {
        maxOutputTokensPerRequest: 4_096,
        verifiedPdfInputsByRequest: [inputs],
        ...(imageTokenSafetyMultiplier === undefined ? {} : { imageTokenSafetyMultiplier }),
      })).toBe(expected);
    }
  });

  it("preserves every request byte and producer input without adding hints to the wire", () => {
    const { request, inputs } = nativePdfFixture();
    const beforeRequest = JSON.stringify(request);
    const beforeInputs = JSON.stringify(inputs);
    const fingerprint = createHash("sha256").update(beforeRequest).digest("hex");
    inputs.forEach(Object.freeze);
    Object.freeze(inputs);
    analyzeGeminiRequestInput(request, pdfOptions(inputs));
    estimateGeminiMaximumBatchRequestsCostUsd("gemini-3.8-flash", [request], {
      maxOutputTokensPerRequest: 4_096, verifiedPdfInputsByRequest: [inputs],
    });
    expect(JSON.stringify(request)).toBe(beforeRequest);
    expect(JSON.stringify(inputs)).toBe(beforeInputs);
    expect(createHash("sha256").update(JSON.stringify(request)).digest("hex")).toBe(fingerprint);
  });

  it("matches nested PDF parts recursively and retains ordinary unknown-media fallback beside them", () => {
    const { request, inputs } = nativePdfFixture();
    const parts = pdfParts(request);
    request.request.contents = [{ nested: [{ previous: parts[0] }, { current: parts[1] }] }];
    request.request.contents.push({ inline_data: { mime_type: "application/octet-stream", data: "c29tZSBieXRlcw==" } });
    expect(analyzeGeminiRequestInput(request, pdfOptions(inputs)).imageTokens).toBe(27 * 1_120 + 16);
    parts[0].inline_data = { mime_type: "application/pdf", data: parts[0].inlineData.data };
    delete parts[0].inlineData;
    expect(analyzeGeminiRequestInput(request, pdfOptions(inputs)).imageTokens).toBe(27 * 1_120 + 16);
  });

  it("does not deduplicate two supplied document parts even when their bytes coincide", () => {
    const { request, inputs } = nativePdfFixture(2, 2);
    pdfParts(request)[1].inlineData.data = pdfParts(request)[0].inlineData.data;
    inputs[1] = { ...inputs[0] };
    expect(analyzeGeminiRequestInput(request, pdfOptions(inputs)).imageTokens).toBe(4 * 1_120);
  });

  it.each(["gemini-2.5-flash-lite", "gemini-3.7-flash", "models/gemini-3.8-flash", "", undefined])("rejects unsupported or missing opt-in model %s", model => {
    const { request, inputs } = nativePdfFixture();
    expect(() => analyzeGeminiRequestInput(request, { model, verifiedPdfInputs: inputs })).toThrow("supported model");
  });

  it.each([undefined, "MEDIA_RESOLUTION_MEDIUM", "MEDIA_RESOLUTION_LOW", "high", {}])("rejects unsupported or missing resolution %s", resolution => {
    const { request, inputs } = nativePdfFixture();
    request.request.generationConfig.mediaResolution = resolution;
    expect(() => analyzeGeminiRequestInput(request, pdfOptions(inputs))).toThrow("HIGH resolution");
  });

  it.each(["mediaResolution", "media_resolution"])("rejects per-part %s overrides", field => {
    const { request, inputs } = nativePdfFixture();
    pdfParts(request)[0][field] = { level: "MEDIA_RESOLUTION_LOW" };
    expect(() => analyzeGeminiRequestInput(request, pdfOptions(inputs))).toThrow("part binding");
  });

  it("rejects conflicting global config aliases and PDF MIME aliases", () => {
    const { request, inputs } = nativePdfFixture();
    request.request.generation_config = { media_resolution: "MEDIA_RESOLUTION_LOW" };
    expect(() => analyzeGeminiRequestInput(request, pdfOptions(inputs))).toThrow("HIGH resolution");
    delete request.request.generation_config;
    request.request.generationConfig.media_resolution = "MEDIA_RESOLUTION_ULTRA_HIGH";
    expect(() => analyzeGeminiRequestInput(request, pdfOptions(inputs))).toThrow("HIGH resolution");
    delete request.request.generationConfig.media_resolution;
    pdfParts(request)[0].inlineData.mime_type = "image/png";
    expect(() => analyzeGeminiRequestInput(request, pdfOptions(inputs))).toThrow("part binding");
  });

  it("supports the same bare GenerateContentRequest as the batch envelope", () => {
    const { request, inputs } = nativePdfFixture();
    const wrapped = analyzeGeminiRequestInput(request, pdfOptions(inputs));
    const bare = analyzeGeminiRequestInput(request.request, pdfOptions(inputs));
    expect(bare.imageTokens).toBe(wrapped.imageTokens);
    expect(bare.textBytes).toBeLessThan(wrapped.textBytes);
  });

  it.each([[], [{}], [null, null], { page_count: 2 }])("requires two complete external metadata entries %#", metadata => {
    const { request } = nativePdfFixture();
    expect(() => analyzeGeminiRequestInput(request, pdfOptions(metadata))).toThrow();
  });

  it.each([
    ["sha256", "a".repeat(64)], ["sha256", "A".repeat(64)], ["sha256", null],
    ["byte_length", 0], ["byte_length", "35"], ["byte_length", 16 * 1024 * 1024 + 1],
    ["page_count", 0], ["page_count", 26], ["page_count", 1.5], ["page_count", "13"],
    ["native_text", null], ["native_text", "\ud800"], ["native_text", "x".repeat(2_500_025)],
  ])("rejects invalid or mismatched producer metadata %s %#", (key, value) => {
    const { request, inputs } = nativePdfFixture();
    inputs[0][key] = value;
    expect(() => analyzeGeminiRequestInput(request, pdfOptions(inputs))).toThrow();
  });

  it("rejects missing and unknown metadata fields instead of silently dropping claims", () => {
    const { request, inputs } = nativePdfFixture();
    delete inputs[0].native_text;
    expect(() => analyzeGeminiRequestInput(request, pdfOptions(inputs))).toThrow("metadata");
    inputs[0].native_text = "";
    inputs[0].page_hint = 1;
    expect(() => analyzeGeminiRequestInput(request, pdfOptions(inputs))).toThrow("metadata");
  });

  it("rejects substituted, reordered, missing, extra and noncanonical encoded PDF bodies", () => {
    for (const alter of [
      request => { pdfParts(request)[0].inlineData.data = Buffer.from("%PDF-1.7\nchanged").toString("base64"); },
      request => { request.request.contents[0].parts.reverse(); },
      request => { request.request.contents[0].parts.pop(); },
      request => { request.request.contents[0].parts.push(structuredClone(pdfParts(request)[0])); },
      request => { pdfParts(request)[0].inlineData.data += "\n"; },
      request => { pdfParts(request)[0].inlineData.data = pdfParts(request)[0].inlineData.data.replace(/.$/, "!"); },
    ]) {
      const { request, inputs } = nativePdfFixture();
      alter(request);
      expect(() => analyzeGeminiRequestInput(request, pdfOptions(inputs))).toThrow();
    }
  });

  it("rejects non-PDF bytes even if the external raw hash is made to match", () => {
    const { request, inputs } = nativePdfFixture();
    const body = Buffer.from("not a PDF");
    pdfParts(request)[0].inlineData.data = body.toString("base64");
    inputs[0].sha256 = createHash("sha256").update(body).digest("hex");
    inputs[0].byte_length = body.length;
    expect(() => analyzeGeminiRequestInput(request, pdfOptions(inputs))).toThrow("bytes do not match");
  });

  it("enforces the combined 16MiB boundary without raising it for two documents", () => {
    const { request, inputs } = nativePdfFixture(25, 25);
    const body = Buffer.alloc(8 * 1024 * 1024, 32);
    Buffer.from("%PDF-1.7").copy(body);
    const encoded = body.toString("base64");
    const sha256 = createHash("sha256").update(body).digest("hex");
    pdfParts(request).forEach(part => { part.inlineData.data = encoded; });
    inputs.forEach(input => { input.byte_length = body.length; input.sha256 = sha256; });
    expect(analyzeGeminiRequestInput(request, pdfOptions(inputs)).imageTokens).toBe(50 * 1_120);
    inputs[1].byte_length += 1;
    expect(() => analyzeGeminiRequestInput(request, pdfOptions(inputs))).toThrow("combined byte limit");
  });

  it("forwards external metadata per request without allowing batch omissions or extra rows", () => {
    const { request, inputs } = nativePdfFixture();
    const plain = { contents: [{ parts: [{ text: "ordinary text" }] }] };
    const options = { maxOutputTokensPerRequest: 4_096 };
    expect(estimateGeminiMaximumBatchRequestsCostUsd("gemini-3.8-flash", [plain, request], {
      ...options, verifiedPdfInputsByRequest: [null, inputs],
    })).toBeGreaterThan(0);
    for (const metadata of [null, [], [inputs], [null, inputs, null], Array(2)]) {
      expect(() => estimateGeminiMaximumBatchRequestsCostUsd("gemini-3.8-flash", [plain, request], {
        ...options, verifiedPdfInputsByRequest: metadata,
      })).toThrow("match every request");
    }
  });

  it("keeps old unknown/PDF fallback and output shape when the opt-in is absent", () => {
    const { request } = nativePdfFixture();
    request.request.generationConfig = {};
    request.request.metadata = { verifiedPdfInputs: [{ page_count: 1, native_text: "" }] };
    const oldFallbackTokens = pdfParts(request).reduce((sum, part) => sum + part.inlineData.data.length, 0);
    const analyzed = analyzeGeminiRequestInput(request);
    expect(analyzed.imageTokens).toBe(oldFallbackTokens);
    expect(Object.keys(analyzed)).toEqual(["textBytes", "imageTokens"]);
    expect(analyzeGeminiRequestInput(request, { model: "gemini-2.5-flash-lite", verifiedPdfInputs: null })).toEqual(analyzed);
    expect(estimateGeminiMaximumBatchRequestsCostUsd("gemini-2.5-flash-lite", [request], {
      maxOutputTokensPerRequest: 2_048,
    })).toBeGreaterThan(0);
  });

  it("leaves nested image tiles and arbitrary unknown-media fallback unchanged", () => {
    const png = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
    png.writeUInt32BE(300, 16);
    png.writeUInt32BE(300, 20);
    const request = { nested: [{ inner: { inline_data: { mime_type: "image/png", data: png.toString("base64") } } },
      { inlineData: { mimeType: "application/x-other", data: "bm90IGFuIGltYWdl" } }] };
    expect(analyzeGeminiRequestInput(request).imageTokens).toBe(258 + 16);
    expect(analyzeGeminiRequestInput(request, { model: "gemini-3.8-flash" })).toEqual(analyzeGeminiRequestInput(request));
  });
});
