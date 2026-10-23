import { describe, expect, it, vi } from "vitest";
import { buildProgramTextCapture } from "./program-text-capture.mjs";
import { buildProgramTextComparison, buildProgramTextReviewPackets, programTextReviewResponseSchema, validateProgramTextReviewResult } from "./program-text-review.mjs";
import { programTextBatchRequests, programTextGeminiResponseSchema, submitProgramTextBatch, programTextBatchResult, pollProgramTextBatch } from "./program-text-provider.mjs";
import { geminiStrongWorkerModel } from "./gemini-worker-policy.mjs";
import { GeminiBudgetUnavailableError, GEMINI_PAID_LANES, estimateGeminiMaximumBatchRequestsCostUsd } from "./gemini-spend-ledger.mjs";

function candidate() {
  const source = { id: "10000000-0000-0000-0000-000000000001", shared_award_id: "20000000-0000-0000-0000-000000000001", url: "https://example.edu/award" };
  const capture = (text, day) => buildProgramTextCapture({ source, captured_at: `2026-10-${day}T12:00:00.000Z`, acquisition: "http_html",
    extractor: { name: "test", version: "1" }, content_type: "text/html", raw_bytes: Buffer.from(`<p>${text}</p>`), text,
    blocks: [{ id: "deadline", text, start_utf16: 0, end_utf16: text.length }] });
  const comparison = buildProgramTextComparison(capture("Deadline: October 1, 2027", 10), capture("Deadline: October 15, 2027", 11),
    { epoch: "30000000-0000-0000-0000-000000000001", cycle_id: null });
  const plan = buildProgramTextReviewPackets(comparison);
  return { id: "40000000-0000-0000-0000-000000000001", status: "pending", candidate_scope: "program_text_change", candidate_signature: comparison.comparison_id,
    prompt_payload: { comparison, packet_plan: plan }, worker_metadata: {} };
}

function longCandidate({ count = 50, changed = 14, width = 1000 } = {}) {
  const base = candidate(), source = { id: base.prompt_payload.comparison.context.source_id, shared_award_id: base.prompt_payload.comparison.context.award_id, url: "https://example.edu/award" };
  const paragraphs = Array.from({ length: count }, (_, index) => `Section ${index}: application requirement original. ${"Complete source context. ".repeat(Math.ceil(width / 25))}`);
  paragraphs.push("Distant exception: the later deadline applies only to candidates from a different program and application track.");
  const after = paragraphs.map((text, index) => index < changed ? text.replace("original", "revised") : text);
  const capture = (values, day) => {
    let text = "";
    const blocks = values.map((paragraph, index) => {
      if (index) text += "\n\n";
      const start = text.length; text += paragraph;
      return { id: `paragraph-${index}`, text: paragraph, start_utf16: start, end_utf16: text.length };
    });
    return buildProgramTextCapture({ source, captured_at: `2026-10-${day}T12:00:00.000Z`, acquisition: "http_html", extractor: { name: "test", version: "1" },
      content_type: "text/html", raw_bytes: Buffer.from(`<main>${text}</main>`), text, blocks });
  };
  const comparison = buildProgramTextComparison(capture(paragraphs, 10), capture(after, 11), base.prompt_payload.comparison.context);
  const plan = buildProgramTextReviewPackets(comparison);
  if (plan.status !== "ready") throw new Error("Long provider fixture must have complete packets");
  return { ...base, candidate_signature: comparison.comparison_id, prompt_payload: { comparison, packet_plan: plan,
    program_identity: { award_id: source.shared_award_id, award_name: "Specific Target Scholarship", source_url: source.url, source_title: "Application instructions" } } };
}
const asResponse = value => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
function harness(overrides = {}) {
  const sequence = [], saves = [];
  const ledger = {
    reserve: vi.fn(async args => { sequence.push("reserve"); return { reservation_id: "reservation-1", attempt_token: args.attemptToken }; }),
    start: vi.fn(async () => { sequence.push("create-start"); return {}; }),
    submit: vi.fn(async () => { sequence.push("reservation-submit"); return {}; }),
  };
  const dependencies = { supabase: {}, apiKey: "synthetic-test-key-never-used-for-network",
    verify: vi.fn(async () => { sequence.push("verify-originals"); }),
    claim: vi.fn(async (row, _token, model) => { sequence.push("claim"); return { ...row, status: "processing", model }; }),
    save: vi.fn(async (_row, _token, update) => { saves.push(update); sequence.push(update.status || update.gemini_batch_name ? update.status || "batch-journal" : update.worker_metadata?.batch_create_started_at ? "create-journal" : "reservation-journal"); }),
    fetcher: vi.fn(async () => { sequence.push("provider-create"); return asResponse({ name: "batches/test-batch" }); }), ledger,
    ...overrides };
  return { sequence, saves, ledger, dependencies };
}
function submitted() {
  const c = candidate();
  return { ...c, status: "submitted", model: geminiStrongWorkerModel(), gemini_batch_name: "batches/test-batch", worker_metadata: {
    provider_request_keys: c.prompt_payload.packet_plan.packets.map(packet => packet.packet_id), gemini_spend_reservation_id: "reservation-1",
    gemini_spend_attempt_token: "attempt-1",
  } };
}
function batchResult(c, { usage = true } = {}) {
  return { done: true, metadata: { state: "JOB_STATE_SUCCEEDED" }, response: { inlinedResponses: c.prompt_payload.packet_plan.packets.map(packet => ({
    metadata: { key: packet.packet_id }, response: { candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({
      schema: "awardping.program-text-review.v1", comparison_id: packet.comparison_id, packet_id: packet.packet_id, ...packet.context,
      blocks: packet.blocks.map(block => ({ id: block.id, disposition: "no_program_change", reason: "No actual program change was found.", changes: [] })),
    }) }] } }], ...(usage ? { usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, thoughtsTokenCount: 10, totalTokenCount: 160 } } : {}) },
  })) } };
}
function invalidArgumentBatchResult(c) {
  // Shape observed in the three retained October 23 results: successful
  // outer Batch operation, but every individual request failed before output.
  const inlinedResponses = { inlinedResponses: c.worker_metadata.provider_request_keys.map(key => ({
    error: { code: 3, message: "Request contains an invalid argument." }, metadata: { key },
  })) };
  return { name: c.gemini_batch_name, done: true,
    metadata: { "@type": "type.googleapis.com/google.ai.generativelanguage.v1main.GenerateContentBatch",
      name: c.gemini_batch_name, model: `models/${c.model}`, state: "BATCH_STATE_SUCCEEDED",
      batchStats: { requestCount: String(inlinedResponses.inlinedResponses.length), failedRequestCount: String(inlinedResponses.inlinedResponses.length) },
      output: { inlinedResponses: structuredClone(inlinedResponses) } },
    response: { "@type": "type.googleapis.com/google.ai.generativelanguage.v1main.GenerateContentBatchOutput", inlinedResponses } };
}

describe("text-only Gemini request and submission boundary", () => {
  it("uses only the native Gemini response schema and text parts without sending raw files", () => {
    const c = candidate(), original = structuredClone(c), requests = programTextBatchRequests(c);
    expect(requests).toHaveLength(1);
    const request = requests[0].request;
    expect(request.generationConfig.responseMimeType).toBe("application/json");
    expect(request.generationConfig.responseSchema.type).toBe("OBJECT");
    expect(request.generationConfig.responseJsonSchema).toBeUndefined();
    expect(request.generationConfig.maxOutputTokens).toBe(8192);
    const schema = request.generationConfig.responseSchema;
    expect(schema.properties.blocks.minItems).toBe(String(c.prompt_payload.packet_plan.packets[0].blocks.length));
    expect(schema.properties.blocks.maxItems).toBe(String(c.prompt_payload.packet_plan.packets[0].blocks.length));
    expect(schema.properties.blocks.items.properties.changes.maxItems).toBeUndefined();
    expect(schema.properties.cycle_id).toEqual({ type: "STRING", nullable: true });
    const changes = schema.properties.blocks.items.properties.changes.items.properties;
    expect(changes.previous_quote.nullable).toBe(true);
    expect(changes.current_quote.nullable).toBe(true);
    expect(request.contents[0].parts.every(part => Object.keys(part).join() === "text")).toBe(true);
    expect(JSON.stringify(request)).not.toContain("inlineData");
    expect(JSON.stringify(request)).not.toContain("fileData");
    expect(JSON.stringify(request)).not.toContain("raw_bytes");
    expect(requests[0].metadata.key).toBe(c.prompt_payload.packet_plan.packets[0].packet_id);
    expect(requests[0].metadata.key).toMatch(/^[a-f0-9]{64}$/);
    expect(c).toEqual(original);
  });

  it("uses native closed objects, uppercase types and integer-string bounds without JSON-schema-only keywords", () => {
    const schema = programTextGeminiResponseSchema(32), nodes = [];
    const visit = node => {
      nodes.push(node);
      expect(["OBJECT", "ARRAY", "STRING", "BOOLEAN"]).toContain(node.type);
      expect(Object.keys(node).every(key => ["type", "properties", "required", "maxProperties", "propertyOrdering", "nullable", "enum", "items", "minItems", "maxItems"].includes(key))).toBe(true);
      if (node.type === "OBJECT") {
        expect(node.required).toEqual(Object.keys(node.properties));
        expect(node.propertyOrdering).toEqual(node.required);
        expect(node.maxProperties).toBe(String(node.required.length));
        Object.values(node.properties).forEach(visit);
      } else if (node.type === "ARRAY") visit(node.items);
      if (node.minItems !== undefined) expect(node.minItems).toMatch(/^[1-9]\d*$/);
      if (node.maxItems !== undefined) expect(node.maxItems).toMatch(/^[1-9]\d*$/);
    };
    visit(schema);
    expect(nodes.filter(node => node.type === "OBJECT")).toHaveLength(5);
    expect(nodes.filter(node => node.type === "ARRAY")).toHaveLength(2);
    expect(nodes.filter(node => node.nullable)).toHaveLength(3);
    const local = programTextReviewResponseSchema.properties;
    const nativeBlock = schema.properties.blocks.items.properties;
    expect(schema.properties.schema.enum).toEqual(local.schema.enum);
    expect(nativeBlock.disposition.enum).toEqual(local.blocks.items.properties.disposition.enum);
    expect(nativeBlock.changes.items.properties.field.enum).toEqual(local.blocks.items.properties.changes.items.properties.field.enum);
    expect(nativeBlock.changes.items.properties.operation.enum).toEqual(local.blocks.items.properties.changes.items.properties.operation.enum);
  });

  it.each([0, -1, 33, 1.5, NaN, Infinity, null, "1"])("refuses invalid native packet cardinality %s", count => {
    expect(() => programTextGeminiResponseSchema(count)).toThrow("invalid_packet_block_count");
  });

  it("leaves the strict local schema unchanged and returns independent native schemas", () => {
    const original = structuredClone(programTextReviewResponseSchema);
    const first = programTextGeminiResponseSchema(1), second = programTextGeminiResponseSchema(2);
    first.properties.blocks.items.properties.changes.items.properties.field.enum.length = 0;
    first.properties.blocks.items.properties.changes.items.properties.previous_quote.properties.text.type = "BOOLEAN";
    expect(second.properties.blocks.items.properties.changes.items.properties.field.enum.length).toBeGreaterThan(0);
    expect(second.properties.blocks.items.properties.changes.items.properties.previous_quote.properties.text.type).toBe("STRING");
    expect(second.properties.blocks.maxItems).toBe("2");
    expect(programTextReviewResponseSchema).toEqual(original);
    expect(original.properties.blocks.items.properties.changes.maxItems).toBe(64);
    expect(original.properties.blocks.items.properties.reason.maxLength).toBe(600);
  });

  it("still holds incomplete block coverage and fabricated quotations after parsing native-format responses", () => {
    const c = submitted(), envelope = batchResult(c);
    const response = JSON.parse(envelope.response.inlinedResponses[0].response.candidates[0].content.parts[0].text);
    response.blocks[0].disposition = "program_change";
    response.blocks[0].changes = [{ field: "deadline", operation: "replace", summary: "The application deadline changed.",
      previous_quote: { block_id: "deadline", text: "Deadline: October 1, 2027" },
      current_quote: { block_id: "deadline", text: "Deadline: October 15, 2027" }, applicant_impact: true }];
    const encode = () => { envelope.response.inlinedResponses[0].response.candidates[0].content.parts[0].text = JSON.stringify(response); };
    encode();
    let parsed = programTextBatchResult(c, envelope);
    expect(parsed.status).toBe("ready");
    expect(validateProgramTextReviewResult(c.prompt_payload.comparison, c.prompt_payload.packet_plan, parsed.responses).status).toBe("accepted");
    response.blocks[0].changes[0].current_quote.text = "Deadline: October 99, 2027";
    encode(); parsed = programTextBatchResult(c, envelope);
    expect(validateProgramTextReviewResult(c.prompt_payload.comparison, c.prompt_payload.packet_plan, parsed.responses).status).toBe("held");
    response.blocks = [];
    encode(); parsed = programTextBatchResult(c, envelope);
    expect(validateProgramTextReviewResult(c.prompt_payload.comparison, c.prompt_payload.packet_plan, parsed.responses).status).toBe("held");
  });

  it("sends the exact complete source past 24KB and authoritative program identity in every packet request", () => {
    const c = longCandidate(), requests = programTextBatchRequests(c);
    expect(requests.length).toBeGreaterThan(1);
    expect(c.prompt_payload.comparison.previous_text.length).toBeGreaterThan(24_000);
    for (const { request } of requests) {
      const parts = request.contents[0].parts;
      expect(parts[0].text).toContain(JSON.stringify(c.prompt_payload.program_identity));
      expect(parts[0].text).toContain("Specific Target Scholarship");
      const context = parts.find(part => part.text.startsWith("Complete source text for resolving"));
      const full = JSON.parse(context.text.slice(context.text.indexOf("{")));
      expect(full.previous_text).toBe(c.prompt_payload.comparison.previous_text);
      expect(full.current_text).toBe(c.prompt_payload.comparison.current_text);
      expect(full.current_text).toContain("Distant exception: the later deadline applies only");
      expect(parts.every(part => Object.keys(part).join() === "text")).toBe(true);
    }
    requests.forEach(({ request }, index) => {
      expect(request.generationConfig.responseSchema.properties.blocks.minItems).toBe(String(c.prompt_payload.packet_plan.packets[index].blocks.length));
      expect(request.generationConfig.responseSchema.properties.blocks.maxItems).toBe(String(c.prompt_payload.packet_plan.packets[index].blocks.length));
    });
  });

  it("holds an oversized complete page before claims, reservations or a provider call", async () => {
    const c = longCandidate({ count: 400, changed: 1 }), h = harness();
    await expect(submitProgramTextBatch(c, h.dependencies)).rejects.toThrow("complete_page_context_exceeds_request_limit");
    expect(h.sequence).toEqual([]);
    expect(h.dependencies.claim).not.toHaveBeenCalled(); expect(h.ledger.reserve).not.toHaveBeenCalled(); expect(h.dependencies.fetcher).not.toHaveBeenCalled();
  });

  it("counts repeated full context against the complete inline batch cap before charging", async () => {
    const c = longCandidate({ count: 180, changed: 140 }), h = harness();
    await expect(submitProgramTextBatch(c, h.dependencies)).rejects.toThrow("complete_batch_exceeds_inline_limit");
    expect(h.sequence).toEqual([]);
    expect(h.ledger.reserve).not.toHaveBeenCalled(); expect(h.dependencies.fetcher).not.toHaveBeenCalled();
  });

  it("reserves for every copy of full context rather than only the changed-block packets", async () => {
    const c = longCandidate(), requests = programTextBatchRequests(c), withoutFullContext = structuredClone(requests);
    for (const row of withoutFullContext) row.request.contents[0].parts = row.request.contents[0].parts.filter(part => !part.text.startsWith("Complete source text for resolving"));
    const fullCost = estimateGeminiMaximumBatchRequestsCostUsd(geminiStrongWorkerModel(), requests, { maxOutputTokensPerRequest: 8192 });
    const shortCost = estimateGeminiMaximumBatchRequestsCostUsd(geminiStrongWorkerModel(), withoutFullContext, { maxOutputTokensPerRequest: 8192 });
    expect(fullCost).toBeGreaterThan(shortCost);
    const h = harness();
    expect((await submitProgramTextBatch(c, h.dependencies)).status).toBe("submitted");
    expect(h.ledger.reserve.mock.calls[0][0].estimatedCostUsd).toBe(fullCost);
    expect(h.ledger.reserve.mock.calls[0][0].requestCount).toBe(requests.length);
  });

  it.each([
    ["modified comparison", c => { c.prompt_payload.comparison.current_text += "invented"; }],
    ["modified packet", c => { c.prompt_payload.packet_plan.packets[0].blocks[0].current.text += "invented"; }],
    ["duplicate packet", c => { c.prompt_payload.packet_plan.packets.push(c.prompt_payload.packet_plan.packets[0]); }],
    ["missing packet", c => { c.prompt_payload.packet_plan.packets = []; }],
    ["fake unchanged plan", c => { c.prompt_payload.packet_plan.status = "unchanged"; }],
  ])("refuses %s before verification, claims or charges", async (_, mutate) => {
    const c = candidate(); mutate(c); const h = harness();
    await expect(submitProgramTextBatch(c, h.dependencies)).rejects.toThrow();
    expect(h.sequence).toEqual([]);
  });

  it("accepts genuine JSONB reordering while preserving exact packet content", () => {
    const c = candidate();
    const reorder = value => Array.isArray(value) ? value.map(reorder) : value && typeof value === "object"
      ? Object.fromEntries(Object.keys(value).sort().reverse().map(key => [key, reorder(value[key])])) : value;
    expect(programTextBatchRequests(reorder(c))[0].metadata.key).toBe(programTextBatchRequests(c)[0].metadata.key);
  });

  it("verifies originals, claims and journals budget before one provider create", async () => {
    const h = harness(), result = await submitProgramTextBatch(candidate(), h.dependencies);
    expect(result).toEqual({ status: "submitted", batch_name: "batches/test-batch" });
    expect(h.sequence).toEqual(["verify-originals", "claim", "reserve", "reservation-journal", "verify-originals", "create-start", "create-journal", "provider-create", "batch-journal", "reservation-submit", "submitted"]);
    expect(h.dependencies.fetcher).toHaveBeenCalledTimes(1);
    expect(h.ledger.reserve.mock.calls[0][0]).toMatchObject({ laneKey: GEMINI_PAID_LANES.CHANGED_PAGE_REVIEW, requestCount: 1, model: geminiStrongWorkerModel() });
    expect(h.ledger.reserve.mock.calls[0][0].estimatedCostUsd).toBeGreaterThan(0);
    expect(h.dependencies.fetcher.mock.calls[0][0]).toBe(`https://generativelanguage.googleapis.com/v1beta/models/${geminiStrongWorkerModel()}:batchGenerateContent`);
  });

  it("makes no claim or charge when raw-original verification fails", async () => {
    const h = harness({ verify: vi.fn(async () => { throw new Error("originals missing"); }) });
    await expect(submitProgramTextBatch(candidate(), h.dependencies)).rejects.toThrow("originals missing");
    expect(h.dependencies.claim).not.toHaveBeenCalled(); expect(h.ledger.reserve).not.toHaveBeenCalled(); expect(h.dependencies.fetcher).not.toHaveBeenCalled();
  });

  it("does not reserve spend when the claim is stale or belongs to another candidate", async () => {
    const c = candidate(), h = harness({ claim: vi.fn(async () => ({ ...c, candidate_signature: "other" })) });
    await expect(submitProgramTextBatch(c, h.dependencies)).rejects.toThrow("claim_identity_mismatch");
    expect(h.ledger.reserve).not.toHaveBeenCalled(); expect(h.dependencies.fetcher).not.toHaveBeenCalled();
  });

  it("defers insufficient budget without a provider call", async () => {
    const h = harness(); h.ledger.reserve.mockRejectedValueOnce(new GeminiBudgetUnavailableError("daily cap"));
    expect(await submitProgramTextBatch(candidate(), h.dependencies)).toEqual({ status: "budget_deferred" });
    expect(h.saves).toContainEqual({ status: "pending", rejection_reason: "budget_deferred" });
    expect(h.dependencies.fetcher).not.toHaveBeenCalled();
  });

  it("holds create uncertainty with a fixed reason and never resubmits a failed candidate", async () => {
    const h = harness({ fetcher: vi.fn(async () => { throw new Error("secret-containing transport exception"); }) });
    expect(await submitProgramTextBatch(candidate(), h.dependencies)).toEqual({ status: "held" });
    expect(h.saves.at(-1)).toEqual({ status: "failed", rejection_reason: "manual_review_required:provider_create_or_journal_uncertain" });
    expect(JSON.stringify(h.saves)).not.toContain("secret-containing");
    expect(await submitProgramTextBatch({ ...candidate(), status: "failed" }, h.dependencies)).toEqual({ status: "skipped" });
    expect(h.dependencies.fetcher).toHaveBeenCalledTimes(1);
  });

  it("journals the actual batch name before ledger acknowledgement and preserves uncertainty", async () => {
    const h = harness(); h.ledger.submit.mockRejectedValueOnce(new Error("uncertain ledger"));
    expect(await submitProgramTextBatch(candidate(), h.dependencies)).toEqual({ status: "held" });
    expect(h.saves.find(update => update.gemini_batch_name)).toMatchObject({ gemini_batch_name: "batches/test-batch" });
    expect(h.saves.at(-1).status).toBe("failed");
    expect(h.dependencies.fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("complete response mapping and conservative settlement", () => {
  it.each([null, [], "not a result", 1])("holds malformed provider envelopes without exposing their contents", result => {
    expect(programTextBatchResult(submitted(), result).status).toBe("held");
  });
  it("returns one complete text JSON response for every bound packet", () => {
    const c = submitted(), result = programTextBatchResult(c, batchResult(c));
    expect(result.status).toBe("ready"); expect(result.responses).toHaveLength(1);
    expect(result.accounting).toMatchObject({ mappingComplete: true, responseCount: 1, usageResponseCount: 1 });
  });

  it("holds an actual-shaped successful Batch containing a code3 failed request, without treating it as model output", () => {
    const c = submitted(), envelope = invalidArgumentBatchResult(c);
    expect(envelope.metadata.state).toBe("BATCH_STATE_SUCCEEDED");
    expect(envelope.metadata.batchStats.failedRequestCount).toBe("1");
    const parsed = programTextBatchResult(c, envelope);
    expect(parsed).toMatchObject({ status: "held", reason: "invalid_or_incomplete_provider_result",
      accounting: { mappingComplete: true, responseCount: 1, usageResponseCount: 0 } });
    expect(parsed.responses).toBeUndefined();
  });

  it("settles a code3 failed request conservatively and never retries its terminal candidate", async () => {
    const c = submitted(), fetcher = vi.fn(async () => asResponse(invalidArgumentBatchResult(c)));
    const ledger = { load: vi.fn(async () => ({ id: "reservation-1", provider_batch_name: c.gemini_batch_name, model: c.model,
      attempt_token: "attempt-1", request_count: 1, reserved_micro_usd: 10000 })), settle: vi.fn(async () => {}) };
    const result = await pollProgramTextBatch(c, { supabase: {}, apiKey: "synthetic-key", fetcher, ledger });
    expect(result.status).toBe("held");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1].method).toBe("GET");
    expect(ledger.settle).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ spentCostUsd: 0.01,
      spentSource: "terminal_batch_conservative_reserved_maximum" }));
    const terminal = { ...c, status: "failed", rejection_reason: `manual_review_required:${result.reason}` }, h = harness();
    expect(await submitProgramTextBatch(terminal, h.dependencies)).toEqual({ status: "skipped" });
    expect(await pollProgramTextBatch(terminal, { supabase: {}, apiKey: "synthetic-key", fetcher, ledger })).toEqual({ status: "skipped" });
    expect(h.sequence).toEqual([]);
    expect(h.dependencies.fetcher).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(ledger.settle).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["missing response", (_c, r) => { r.response.inlinedResponses = []; }],
    ["duplicate response", (_c, r) => { r.response.inlinedResponses.push(r.response.inlinedResponses[0]); }],
    ["wrong key", (_c, r) => { r.response.inlinedResponses[0].metadata.key = "other"; }],
    ["changed request journal", c => { c.worker_metadata.provider_request_keys = ["other"]; }],
    ["duplicate request journal", c => { c.worker_metadata.provider_request_keys.push(c.worker_metadata.provider_request_keys[0]); }],
    ["truncated output", (_c, r) => { r.response.inlinedResponses[0].response.candidates[0].finishReason = "MAX_TOKENS"; }],
    ["missing finish reason", (_c, r) => { delete r.response.inlinedResponses[0].response.candidates[0].finishReason; }],
    ["multiple candidates", (_c, r) => { r.response.inlinedResponses[0].response.candidates.push(r.response.inlinedResponses[0].response.candidates[0]); }],
    ["image response", (_c, r) => { r.response.inlinedResponses[0].response.candidates[0].content.parts.push({ inlineData: { data: "fake" } }); }],
    ["JSON prefix", (_c, r) => { r.response.inlinedResponses[0].response.candidates[0].content.parts[0].text += "trailing prose"; }],
    ["provider error", (_c, r) => { r.error = { message: "job error" }; }],
    ["failed terminal job", (_c, r) => { r.metadata.state = "JOB_STATE_FAILED"; }],
    ["cancelled terminal job", (_c, r) => { r.metadata.state = "JOB_STATE_CANCELLED"; }],
    ["expired terminal job", (_c, r) => { r.metadata.state = "JOB_STATE_EXPIRED"; }],
  ])("holds %s", (_, mutate) => {
    const c = submitted(), r = batchResult(c); mutate(c, r); expect(programTextBatchResult(c, r).status).toBe("held");
  });

  it("uses actual terminal usage only when complete; otherwise retains the reserved maximum", async () => {
    for (const usage of [true, false]) {
      const c = submitted(), ledger = { load: vi.fn(async () => ({ id: "reservation-1", provider_batch_name: c.gemini_batch_name, model: c.model,
        attempt_token: "attempt-1", request_count: 1, reserved_micro_usd: 10000 })), settle: vi.fn(async () => {}) };
      expect((await pollProgramTextBatch(c, { supabase: {}, apiKey: "synthetic-key", fetcher: async () => asResponse(batchResult(c, { usage })), ledger })).status).toBe("ready");
      const settlement = ledger.settle.mock.calls[0][0];
      expect(settlement.spentSource).toBe(usage ? "terminal_provider_usage" : "terminal_batch_conservative_reserved_maximum");
      if (!usage) expect(settlement.spentCostUsd).toBe(0.01);
    }
  });

  it("rejects a reservation belonging to different request coverage before settling", async () => {
    const c = submitted(), ledger = { load: vi.fn(async () => ({ id: "reservation-1", provider_batch_name: c.gemini_batch_name, model: c.model,
      attempt_token: "attempt-1", request_count: 2, reserved_micro_usd: 10000 })), settle: vi.fn(async () => {}) };
    await expect(pollProgramTextBatch(c, { supabase: {}, apiKey: "synthetic-key", fetcher: async () => asResponse(batchResult(c)), ledger })).rejects.toThrow("reservation_identity_mismatch");
    expect(ledger.settle).not.toHaveBeenCalled();
  });
});
