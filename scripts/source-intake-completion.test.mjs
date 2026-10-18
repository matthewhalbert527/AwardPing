import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import * as intake from "./lib/source-intake.mjs";
import * as binding from "./lib/source-intake-provider-binding.mjs";
import * as batchHelpers from "./lib/gemini-batch-support.mjs";
import * as backfill from "./lib/source-backfill-intake.mjs";

const requestId = "11111111-1111-4111-8111-111111111111";
const awardId = "22222222-2222-4222-8222-222222222222";
const sourceId = "33333333-3333-4333-8333-333333333333";
const batchName = "batches/offline-intake-completion";
const model = "gemini-2.5-flash-lite";
const accepted = {
  status: "accepted", detected_award_name: "Marshall Scholarship", source_relevance: "primary",
  cycle_relevance: "current_or_upcoming", page_type: "application", officialness: "official",
  confidence: "high", evidence_quotes: ["Marshall Scholarship eligibility and application guidance."], facts: {},
};
const payloadFor = (raw = accepted, finishReason = "STOP") => ({
  modelVersion: "gemini-2.5-flash-lite-provider-version", responseId: "offline-provider-response",
  candidates: [{ finishReason, content: { role: "model", parts: [{ text: JSON.stringify(raw) }] } }],
});
const sha = (value) => createHash("sha256").update(value).digest("hex");

const invalidPayloads = [
  ...["MAX_TOKENS", "SAFETY", "RECITATION", "OTHER", "UNKNOWN", null, undefined, ["STOP"]]
    .map((finish) => [String(finish), () => { const value = payloadFor(); value.candidates[0].finishReason = finish; return value; }]),
  ["missing payload", () => undefined],
  ["no candidates", () => ({ candidates: [] })],
  ["multiple candidates", () => { const value = payloadFor(); value.candidates.push(value.candidates[0]); return value; }],
  ["prompt blocked", () => ({ ...payloadFor(), promptFeedback: { blockReason: "SAFETY" } })],
  ["candidate blocked", () => { const value = payloadFor(); value.candidates[0].safetyRatings = [{ blocked: true }]; return value; }],
  ["malformed safety ratings", () => { const value = payloadFor(); value.candidates[0].safetyRatings = { blocked: true }; return value; }],
  ["function call", () => { const value = payloadFor(); value.candidates[0].content.parts.push({ functionCall: { name: "register" } }); return value; }],
  ["binary alongside text", () => { const value = payloadFor(); value.candidates[0].content.parts[0].inlineData = { mimeType: "image/png", data: "AA==" }; return value; }],
  ["thought only", () => { const value = payloadFor(); value.candidates[0].content.parts[0].thought = true; return value; }],
  ["empty text", () => { const value = payloadFor(); value.candidates[0].content.parts[0].text = " "; return value; }],
  ["numeric text", () => { const value = payloadFor(); value.candidates[0].content.parts[0].text = 3; return value; }],
  ["array JSON", () => payloadFor([accepted])],
  ["invalid JSON", () => { const value = payloadFor(); value.candidates[0].content.parts[0].text = "{"; return value; }],
  ["conflicting finish aliases", () => { const value = payloadFor(); value.candidates[0].finish_reason = "MAX_TOKENS"; return value; }],
];

describe("actual source-intake provider completion contract", () => {
  it.each(invalidPayloads)("holds %s even when other content resembles an accepted result", (_name, make) => {
    expect(() => intake.readCompletedSourceIntakeProviderResponse(make())).toThrow(/held/);
  });
  it("accepts one complete unblocked text result and compares canonical JSON, not property order", () => {
    const raw = Object.fromEntries(Object.entries(accepted).reverse());
    expect(intake.readCompletedSourceIntakeProviderResponse(payloadFor(), { rawResult: raw }).parsed).toEqual(accepted);
    expect(() => intake.readCompletedSourceIntakeProviderResponse(payloadFor(), { rawResult: { ...accepted, confidence: "low" } }))
      .toThrow(/response_result_mismatch/);
  });
  it("keeps needs_review ineligible for source monitoring as well as registration", () => {
    const { request, capture } = fixture();
    const review = { ...accepted, status: "needs_review" };
    expect(intake.validateIntakeAiDecision(review).accepted).toBe(false);
    expect(intake.sourceQualityForIntakeSource(intake.sourceLikeFromIntake({ request, capture, review })).allowed).toBe(false);
  });
});

// Execute actual worker functions only, not its entrypoint. Real intake,
// completion, input/result binding, acquisition and source-quality functions
// run against immutable synthetic evidence. All transport/write capabilities
// are in-memory: no credentials, requests, provider spend or baseline files.
const workerPath = new URL("./process-source-intake-requests.mjs", import.meta.url);
const worker = readFileSync(workerPath, "utf8");
const ast = ts.createSourceFile(workerPath.pathname, worker, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const declarations = new Map(ast.statements.filter(ts.isFunctionDeclaration).map((node) => [node.name.text, node.getText(ast)]));
const functionNames = [
  "pollSubmittedBatch", "geminiBatchState", "isGeminiBatchDone", "isGeminiBatchSucceeded", "geminiBatchResponseMap",
  "failSubmittedResponse", "claimSubmittedResponse", "finalizeReviewedRequest", "registerAcceptedSource",
  "resolveAwardForRequest", "loadAward", "loadRegisteredSharedSourceReviewState", "captureFromRow",
  "requireOwnedRequestUpdate", "updateOwnedRequest", "withObservedUpdatedAt", "sourceIntakeOwnershipLost",
  "objectValue", "cleanNullable", "errorMessage", "failOwnedReconciliation", "processRequestedReconciliationRetries",
];

function fixture() {
  const text = accepted.evidence_quotes[0], bytes = Buffer.from(`<html><body>${text}</body></html>`);
  const url = "https://example.org/apply", fileHash = sha(bytes), timestamp = "2026-10-18T12:00:00.000Z";
  const prefix = `source-intake-first-observation/v1/requests/${requestId}/sha256/${fileHash}`;
  const request = { id: requestId, award_name: "Marshall Scholarship", submitted_url: url, homepage_url: url,
    normalized_url: url, intake_type: "official_source", acquisition_kind: "admin_intake", notification_mode: "baseline_only",
    matched_shared_award_id: awardId, status: "ai_review_submitted", updated_at: timestamp, worker_run_id: null };
  const capture = { capture_file_hash: fileHash, byte_length: bytes.length, captured_at: timestamp,
    canonical_url: url, final_url: url, content_type: "text/html; charset=utf-8", text,
    retained_artifact: {
      schema_version: 1, namespace: "source-intake-first-observation", request_id: requestId, captured_at: timestamp,
      final_url: url, response_final_url: url, canonical_url: url, prefix, file_hash: fileHash, file_bytes: bytes.length,
      document_kind: "html", document_content_type: "text/html; charset=utf-8", text_hash: sha(text), text_length: text.length,
      r2_bucket: "offline-fixture", r2_store_id: "account.r2.cloudflarestorage.com", r2_verified_at: timestamp,
      artifacts: {
        pdf: { key: `${prefix}/document.pdf`, sha256: fileHash, byte_length: bytes.length, content_type: "text/html; charset=utf-8" },
        text: { key: `${prefix}/text.txt`, sha256: sha(`${text}\n`), byte_length: Buffer.byteLength(`${text}\n`), content_type: "text/plain; charset=utf-8" },
        capture_metadata: { key: `${prefix}/capture.json`, sha256: "d".repeat(64), byte_length: 456, content_type: "application/json" },
      },
    } };
  const deterministic = { status: "plausible", reason: "passes_deterministic_intake_gate", pageType: "application" };
  const input = binding.buildSourceIntakeProviderInputBinding({ request, capture, deterministicReview: deterministic,
    providerEnvelope: intake.buildGeminiIntakeRequest(request, capture, deterministic, model), model });
  Object.assign(request, { capture_metadata: capture, deterministic_review: deterministic,
    ai_review: { model, gemini_batch_name: batchName, gemini_batch_request_key: requestId, provider_input_binding: input } });
  return { request, capture, deterministic, input };
}

function harness(providerPayload = payloadFor()) {
  const f = fixture();
  const tables = { source_page_requests: [f.request], shared_awards: [{ id: awardId, name: "Marshall Scholarship", status: "active" }], shared_award_sources: [] };
  const mutations = [], rpc = vi.fn(async (name, args) => {
    if (name !== "register_shared_award_source_from_intake") throw new Error(`Unexpected RPC ${name}`);
    tables.shared_award_sources.push({ ...structuredClone(args.p_source), id: sourceId });
    return { data: { source_id: sourceId, source_inserted: true, acquisition_id: "fixture-acquisition", effective_notification_mode: "baseline_only" }, error: null };
  });
  const supabase = { rpc, from(table) {
    const filters = []; let patch = null, single = false, inserts = null;
    const field = (row, key) => key.startsWith("ai_review->>") ? row.ai_review?.[key.slice(12)] : row[key];
    const query = {
      select() { return query; }, update(value) { patch = value; return query; },
      upsert(values) { inserts = values; return query; },
      eq(key, value) { filters.push((row) => field(row, key) === value); return query; },
      is(key, value) { return query.eq(key, value); },
      in(key, values) { filters.push((row) => values.includes(field(row, key))); return query; },
      filter(key, op, value) { if (op !== "eq") throw new Error(op); return query.eq(key, value); },
      order() { return query; }, limit() { return query; }, maybeSingle() { single = true; return query; },
      then(yes, no) {
        if (inserts) (tables[table] ||= []).push(...structuredClone(inserts));
        const selected = tables[table].filter((row) => filters.every((filter) => filter(row)));
        if (patch) { mutations.push(structuredClone(patch)); selected.forEach((row) => Object.assign(row, structuredClone(patch))); }
        return Promise.resolve({ data: structuredClone(single ? selected[0] || null : selected), error: null }).then(yes, no); },
    }; return query;
  } };
  const report = new Proxy({ batches: [], errors: [], warnings: [], requests: [], stage_counts: { reconcile: { loaded: 0, attempted: 0, completed: 0 } } },
    { get: (obj, key) => key in obj ? obj[key] : 0 });
  const fetchGeminiJson = vi.fn(async () => ({ state: "JOB_STATE_SUCCEEDED", response: { inlinedResponses: [{ key: requestId, response: providerPayload }] } }));
  const settle = vi.fn(async () => null), reconcile = vi.fn(async () => ({ created: true }));
  const context = { ...intake, ...binding, ...batchHelpers, ...backfill, supabase, report, requestIds: [],
    apply: true, limit: 10, maxRequestsPerBatch: 10, workerRunId: "offline-worker", model,
    sourceIntakeScopeAllowsWork: async () => true, hasTimeBudget: () => true,
    fetchGeminiJson, settleSourceIntakeBatchSpend: settle, enqueueAwardReconciliation: reconcile,
  };
  const code = functionNames.map((name) => { if (!declarations.has(name)) throw new Error(name); return declarations.get(name); }).join("\n");
  const actual = runInNewContext(`${code}\n({${functionNames.join(",")}})`, context);
  return { ...f, actual, tables, report, rpc, mutations, fetchGeminiJson, settle, reconcile };
}

describe("actual poll → binding → finalizer → registration boundary (offline)", () => {
  it("registers only an explicitly accepted STOP and retains the actual provider payload", async () => {
    const payload = payloadFor(), h = harness(payload);
    await h.actual.pollSubmittedBatch(batchName, [h.request]);
    expect(h.report.errors).toEqual([]);
    expect(h.rpc).toHaveBeenCalledTimes(1);
    expect(h.rpc.mock.calls[0][0]).toBe("register_shared_award_source_from_intake");
    expect(h.request.status).toBe("added");
    expect(h.request.ai_review.provider_response).toEqual(payload);
    expect(h.request.ai_review.provider_result_binding.provider_result_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(h.reconcile).toHaveBeenCalledTimes(1);
    expect(h.fetchGeminiJson.mock.calls.map((args) => args[1].method)).toEqual(["GET"]);
  });
  it.each(["needs_review", undefined, null, "looks_good"])("does not register favorable %s", async (status) => {
    const h = harness(payloadFor({ ...accepted, status }));
    await h.actual.pollSubmittedBatch(batchName, [h.request]);
    expect(h.report.errors).toEqual([]);
    expect(h.request.status).toBe("needs_manual_review");
    expect(h.request.status_reason).toBe("ai_status_needs_review");
    expect(h.rpc).not.toHaveBeenCalled(); expect(h.reconcile).not.toHaveBeenCalled();
  });
  it.each(invalidPayloads)("holds %s before claiming, binding or registering, without a paid retry", async (_name, make) => {
    const h = harness(make());
    // Passing undefined to the harness uses its default; set the fake GET explicitly.
    h.fetchGeminiJson.mockResolvedValue({ state: "JOB_STATE_SUCCEEDED", response: { inlinedResponses: [{ key: requestId, response: make() }] } });
    await h.actual.pollSubmittedBatch(batchName, [h.request]);
    expect(h.request.status).toBe(_name === "prompt blocked" ? "failed" : "needs_manual_review");
    expect(h.mutations.some((patch) => patch.status === "ai_review_succeeded" || patch.status === "matching")).toBe(false);
    expect(h.request.ai_review.provider_result_binding).toBeUndefined();
    expect(h.rpc).not.toHaveBeenCalled(); expect(h.reconcile).not.toHaveBeenCalled();
    expect(h.fetchGeminiJson.mock.calls.map((args) => args[1].method)).toEqual(["GET"]);
    expect(h.settle).toHaveBeenCalledTimes(1); // Already incurred spend still settles.
  });
  it.each(["MAX_TOKENS", "SAFETY", undefined, "missing_payload", "result_mismatch"])("operator replay cannot bypass %s", async (finish) => {
    const h = harness();
    const resultBinding = binding.buildSourceIntakeProviderResultBinding({ request: h.request, capture: h.capture,
      deterministicReview: h.deterministic, inputBinding: h.input, rawResult: accepted,
      batchName, batchRequestKey: requestId, model, acceptedAt: "2026-10-18T12:01:00.000Z" });
    const response = payloadFor(); response.candidates[0].finishReason = finish;
    Object.assign(h.request, { status: "ai_review_succeeded", status_reason: "manual_reconciliation_retry_requested" });
    Object.assign(h.request.ai_review, { status: "accepted", raw: accepted, provider_result_binding: resultBinding,
      provider_response: finish === "missing_payload" ? undefined : finish === "result_mismatch" ? payloadFor({ ...accepted, confidence: "low" }) : response });
    await h.actual.processRequestedReconciliationRetries();
    expect(h.request.status).toBe("needs_manual_review");
    expect(h.request.status_reason).toBe("reconciliation_retry_preflight_failed_no_charge");
    expect(h.rpc).not.toHaveBeenCalled(); expect(h.fetchGeminiJson).not.toHaveBeenCalled(); expect(h.settle).not.toHaveBeenCalled();
    expect(h.mutations.some((patch) => patch.status_reason === "manual_reconciliation_retry_claimed_no_charge")).toBe(false);
    // Direct finalization is guarded too, independently of the retry preflight.
    await expect(h.actual.finalizeReviewedRequest(h.request, h.capture, h.deterministic, accepted, { providerResultMode: "replay" })).rejects.toThrow(/held/);
    expect(h.rpc).not.toHaveBeenCalled();
  });
  it.each(["MAX_TOKENS", "SAFETY", undefined])("direct provider-result finalization cannot bypass %s", async (finish) => {
    const h = harness(), providerResponse = payloadFor();
    providerResponse.candidates[0].finishReason = finish;
    await expect(h.actual.finalizeReviewedRequest(h.request, h.capture, h.deterministic, accepted, {
      providerResultMode: "provider_result", providerResponse,
    })).rejects.toThrow(/held/);
    expect(h.mutations).toEqual([]); expect(h.rpc).not.toHaveBeenCalled();
    expect(h.fetchGeminiJson).not.toHaveBeenCalled(); expect(h.settle).not.toHaveBeenCalled();
  });
  it("replays a genuinely retained STOP without another provider call", async () => {
    const h = harness();
    await h.actual.pollSubmittedBatch(batchName, [h.request]);
    expect(h.request.status).toBe("added");
    Object.assign(h.request, { status: "ai_review_succeeded", status_reason: "manual_reconciliation_retry_requested", worker_run_id: null });
    h.fetchGeminiJson.mockClear(); h.settle.mockClear(); h.rpc.mockClear();
    await h.actual.processRequestedReconciliationRetries();
    expect(h.report.errors).toEqual([]);
    expect(h.request.status).toBe("added");
    expect(h.rpc).toHaveBeenCalledTimes(1);
    expect(h.fetchGeminiJson).not.toHaveBeenCalled(); expect(h.settle).not.toHaveBeenCalled();
  });
});
