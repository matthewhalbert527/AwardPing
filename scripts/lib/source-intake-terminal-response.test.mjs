import { describe, expect, it } from "vitest";
import { hasTerminalFailedSourceIntakeResponse } from "./source-intake-terminal-response.mjs";

const requestId = "11111111-1111-4111-8111-111111111111";
const fileHash = "a".repeat(64);

describe("stored terminal failed source-intake response", () => {
  it("recognizes the precise retained MAX_TOKENS marker shape without accepting its unfinished JSON", () => {
    const ai = terminalFailure();
    const before = JSON.stringify(ai);
    expect(hasTerminalFailedSourceIntakeResponse(ai, requestId, fileHash)).toBe(true);
    expect(JSON.stringify(ai)).toBe(before);
    expect(() => JSON.parse(ai.provider_response.candidates[0].content.parts[0].text)).toThrow();
  });

  it("permits only consistent finish/model aliases", () => {
    const ai = terminalFailure();
    ai.provider_response.candidates[0].finish_reason = "MAX_TOKENS";
    ai.provider_response.model_version = "gemini-2.5-flash-lite";
    expect(hasTerminalFailedSourceIntakeResponse(ai, requestId, fileHash)).toBe(true);
    delete ai.provider_response.candidates[0].finishReason;
    expect(hasTerminalFailedSourceIntakeResponse(ai, requestId, fileHash)).toBe(true);
  });

  it.each([
    ["different known batch", (a) => { a.possible_external_batch_name = "batches/different"; }],
    ["missing possible name", (a) => { delete a.possible_external_batch_name; }],
    ["unsafe batch", (a) => { a.gemini_batch_name = a.possible_external_batch_name = "https://example.edu/batches/one"; }],
    ["wrong key", (a) => { a.gemini_batch_request_key = "other"; }],
    ["different attempt", (a) => { a.gemini_spend_attempt_token = "22222222-2222-4222-8222-222222222222"; }],
    ["empty claim", (a) => { a.submission_claim_token = a.gemini_spend_attempt_token = ""; }],
    ["no returned time", (a) => { delete a.provider_batch_returned_at; }],
    ["invalid returned time", (a) => { a.provider_batch_returned_at = "not-a-date"; }],
    ["wrong completion error", (a) => { a.completion_error = "source_intake_provider_invalid_intake_json"; }],
    ["failed closed", (a) => { a.submission_claim_failed_closed_at = "2026-10-19T01:00:00.000Z"; }],
    ["publication claim", (a) => { a.publication_claim_token = "claim"; }],
    ["provider item error", (a) => { a.gemini_item_error = {}; }],
    ["parse error", (a) => { a.parse_error = "bad JSON"; }],
    ["stored error", (a) => { a.error = "provider failed"; }],
    ["completed result", (a) => { a.completed_at = "2026-10-19T01:00:00.000Z"; }],
    ["accepted raw", (a) => { a.raw = { status: "accepted" }; }],
    ["result binding", (a) => { a.provider_result_binding = {}; }],
    ["accepted status", (a) => { a.status = "accepted"; }],
    ["still submitted", (a) => { a.status = "submitted"; }],
    ["wrong requested model", (a) => { a.model = "other"; }],
    ["missing binding", (a) => { delete a.provider_input_binding; }],
    ["old binding", (a) => { a.provider_input_binding.schema_version = 1; }],
    ["wrong namespace", (a) => { a.provider_input_binding.namespace = "other"; }],
    ["wrong bound request", (a) => { a.provider_input_binding.request_id = "other"; }],
    ["wrong bound body", (a) => { a.provider_input_binding.retained_capture_sha256 = "b".repeat(64); }],
    ["wrong binding model", (a) => { a.provider_input_binding.model = "other"; }],
    ["invalid binding digest", (a) => { a.provider_input_binding.digest_sha256 = "abc"; }],
    ["missing response", (a) => { delete a.provider_response; }],
    ["response error", (a) => { a.provider_response.error = {}; }],
    ["wrong returned model", (a) => { a.provider_response.modelVersion = "other"; }],
    ["conflicting model alias", (a) => { a.provider_response.model_version = "other"; }],
    ["no candidates", (a) => { a.provider_response.candidates = []; }],
    ["two candidates", (a) => { a.provider_response.candidates.push(a.provider_response.candidates[0]); }],
    ["STOP", (a) => { a.provider_response.candidates[0].finishReason = "STOP"; }],
    ["conflicting finish alias", (a) => { a.provider_response.candidates[0].finish_reason = "STOP"; }],
    ["candidate error", (a) => { a.provider_response.candidates[0].error = {}; }],
    ["blocked prompt", (a) => { a.provider_response.promptFeedback = { blockReason: "SAFETY" }; }],
    ["blocked prompt alias", (a) => { a.provider_response.prompt_feedback = { block_reason: "SAFETY" }; }],
    ["blocked safety", (a) => { a.provider_response.candidates[0].safetyRatings = [{ blocked: true }]; }],
    ["malformed ratings", (a) => { a.provider_response.candidates[0].safety_ratings = {}; }],
    ["missing content", (a) => { delete a.provider_response.candidates[0].content; }],
    ["nontext content", (a) => { a.provider_response.candidates[0].content.parts = [{ inlineData: {} }]; }],
    ["empty content", (a) => { a.provider_response.candidates[0].content.parts = [{ text: "  " }]; }],
    ["thought only", (a) => { a.provider_response.candidates[0].content.parts[0].thought = true; }],
  ])("does not recognize %s as this terminal failure", (_name, mutate) => {
    const ai = terminalFailure();
    mutate(ai);
    const before = JSON.stringify(ai);
    expect(hasTerminalFailedSourceIntakeResponse(ai, requestId, fileHash)).toBe(false);
    expect(JSON.stringify(ai)).toBe(before);
  });

  it("rejects malformed supplied identities without any I/O or authority", () => {
    for (const value of [null, [], "text", false]) expect(hasTerminalFailedSourceIntakeResponse(value, requestId, fileHash)).toBe(false);
    expect(hasTerminalFailedSourceIntakeResponse(terminalFailure(), "other", fileHash)).toBe(false);
    expect(hasTerminalFailedSourceIntakeResponse(terminalFailure(), requestId, "wrong")).toBe(false);
  });
});

function terminalFailure() {
  const claim = "33333333-3333-4333-8333-333333333333";
  return {
    submission_claim_token: claim, gemini_spend_attempt_token: claim,
    gemini_batch_name: "batches/known_one", possible_external_batch_name: "batches/known_one",
    gemini_batch_request_key: requestId, provider_batch_returned_at: "2026-10-19T01:00:00.000Z",
    completion_error: "source_intake_provider_incomplete_ai_response", model: "gemini-2.5-flash-lite",
    provider_input_binding: { schema_version: 2, namespace: "source-intake-provider-input-v2", request_id: requestId,
      retained_capture_sha256: fileHash, digest_sha256: "c".repeat(64), model: "gemini-2.5-flash-lite" },
    provider_response: { modelVersion: "gemini-2.5-flash-lite", candidates: [{ finishReason: "MAX_TOKENS",
      content: { parts: [{ text: '{"status":"accepted","facts":{' }] } }] },
  };
}
