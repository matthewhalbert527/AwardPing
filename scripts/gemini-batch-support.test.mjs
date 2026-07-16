import { describe, expect, it } from "vitest";
import {
  activeBatchRequestKeys,
  batchJobsAwaitingReconciliation,
  batchInputModeForRequests,
  estimateGeminiCostUsd,
  extractGeminiBatchInlineResponses,
  geminiBatchExactMappingComplete,
  geminiBatchInlineResponseMap,
  geminiBatchUsageAccounting,
  geminiBatchJsonlRequest,
  geminiBatchOutputFileNames,
  geminiInlineError,
  mergeBatchJobRecord,
  latestRequestKeysByBatchJob,
  normalizeGeminiPricingMode,
  parseGeminiModelJsonObject,
  shouldAttachBaselineFactsImage,
  submittedRequestCapReached,
  unfinishedBatchJobs,
} from "./lib/gemini-batch-support.mjs";

describe("Gemini batch support helpers", () => {
  it("does not apply batch pricing to synchronous generateContent calls", () => {
    const usage = { prompt_tokens: 1_000_000, candidates_tokens: 1_000_000 };

    expect(normalizeGeminiPricingMode("batch", { endpoint: "generateContent" })).toBe("standard");
    expect(normalizeGeminiPricingMode("standard", { endpoint: "batchGenerateContent" })).toBe("batch");
    expect(estimateGeminiCostUsd("gemini-2.5-flash", usage, "standard")).toBe(2.8);
    expect(estimateGeminiCostUsd("gemini-2.5-flash", usage, "batch")).toBe(1.4);
  });

  it("tracks unfinished batch request keys without duplicating restarted jobs", () => {
    const first = mergeBatchJobRecord(null, {
      batch_name: "batches/123",
      display_name: "baseline",
      status: "submitted",
      request_keys: ["source-1", "source-2"],
    });
    const second = mergeBatchJobRecord(first, {
      batch_name: "batches/123",
      status: "processing",
      request_keys: ["source-1", "source-2"],
    });

    expect(second.jobs).toHaveLength(1);
    expect(unfinishedBatchJobs(second)).toHaveLength(1);
    expect([...activeBatchRequestKeys(second)].sort()).toEqual(["source-1", "source-2"]);
  });

  it("replaces a pre-create display-name record when the provider batch name arrives", () => {
    const pending = mergeBatchJobRecord(null, {
      display_name: "baseline-attempt-1",
      status: "reservation_pending",
    });
    const submitted = mergeBatchJobRecord(pending, {
      display_name: "baseline-attempt-1",
      batch_name: "batches/created-1",
      status: "submitted",
    });
    expect(submitted.jobs).toHaveLength(1);
    expect(submitted.jobs[0]).toMatchObject({
      display_name: "baseline-attempt-1",
      batch_name: "batches/created-1",
      status: "submitted",
    });
  });

  it("merges a restarted local job into the active spend reservation record", () => {
    const existing = mergeBatchJobRecord(null, {
      display_name: "first-process",
      spend_reservation_id: "reservation-1",
      spend_reservation_key: "reservation-key-1",
      status: "reserved_pre_create",
    });
    const restarted = mergeBatchJobRecord(existing, {
      display_name: "second-process",
      spend_reservation_id: "reservation-1",
      spend_reservation_key: "reservation-key-1",
      status: "submitted",
      batch_name: "batches/1",
    });
    expect(restarted.jobs).toHaveLength(1);
    expect(restarted.jobs[0]).toMatchObject({
      display_name: "second-process",
      spend_reservation_id: "reservation-1",
      status: "submitted",
      batch_name: "batches/1",
    });
  });

  it("accounts pending requests before hitting the submitted-request cap", () => {
    expect(submittedRequestCapReached({ submitted: 25, pending: 74, cap: 100 })).toBe(false);
    expect(submittedRequestCapReached({ submitted: 25, pending: 75, cap: 100 })).toBe(true);
    expect(submittedRequestCapReached({ submitted: 25, pending: 10, cap: 0 })).toBe(false);
  });

  it("parses inline batch responses and detects duplicate keys", () => {
    const responses = extractGeminiBatchInlineResponses({
      response: {
        output: {
          inlinedResponses: [
            { metadata: { key: "source-1" }, response: { candidates: [] } },
            { metadata: { key: "source-1" }, response: { candidates: [] } },
            { response: { candidates: [] } },
          ],
        },
      },
    });
    const mapped = geminiBatchInlineResponseMap(responses);

    expect(responses).toHaveLength(3);
    expect(mapped.responses.get("source-1")).toBeTruthy();
    expect(mapped.duplicateKeys.has("source-1")).toBe(true);
    expect(mapped.missingKeys).toBe(1);
  });

  it("accounts every raw response and requires an exact unique key mapping", () => {
    const responses = [
      { metadata: { key: "source-1" }, response: { usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 } } },
      { metadata: { key: "source-1" }, response: { usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 3 } } },
      { response: { usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 4 } } },
    ];
    const mapped = geminiBatchInlineResponseMap(responses);
    const exact = geminiBatchExactMappingComplete(responses, mapped, ["source-1"]);
    const accounting = geminiBatchUsageAccounting(responses, { mappingComplete: exact });

    expect(accounting).toMatchObject({
      responseCount: 3,
      usageResponseCount: 3,
      mappingComplete: false,
      usage: { prompt_tokens: 60, candidates_tokens: 9 },
    });
    const one = [responses[0]];
    expect(geminiBatchExactMappingComplete(
      one,
      geminiBatchInlineResponseMap(one),
      ["source-1"],
    )).toBe(true);
  });

  it("parses the nested inline response envelope returned by Gemini Batch", () => {
    const responses = extractGeminiBatchInlineResponses({
      response: {
        inlinedResponses: {
          inlinedResponses: [
            {
              metadata: { key: "source-actual" },
              response: { candidates: [{ content: { parts: [{ text: "{}" }] } }] },
            },
          ],
        },
      },
    });

    expect(responses).toHaveLength(1);
    expect(geminiBatchInlineResponseMap(responses).responses.has("source-actual")).toBe(true);
  });

  it("surfaces prompt feedback blocks as item errors", () => {
    expect(
      geminiInlineError({
        response: {
          promptFeedback: { blockReason: "OTHER" },
        },
      }),
    ).toMatchObject({
      status: "PROMPT_BLOCKED",
      message: "Gemini prompt blocked: OTHER",
    });
  });

  it("parses Gemini model objects and singleton-array envelopes", () => {
    expect(parseGeminiModelJsonObject('{"status":"success"}')).toEqual({ status: "success" });
    expect(parseGeminiModelJsonObject('[{"status":"success"}]')).toEqual({ status: "success" });
    expect(parseGeminiModelJsonObject('```json\n[{"status":"success"}]\n```')).toEqual({ status: "success" });
  });

  it("rejects ambiguous or non-object Gemini model results", () => {
    for (const value of [
      "",
      "not JSON",
      "[]",
      "[{}, {}]",
      "[1]",
      "[[{}]]",
      '"text"',
      "null",
      '{"status":',
    ]) {
      expect(parseGeminiModelJsonObject(value)).toBeNull();
    }
  });

  it("finds file-based batch output references", () => {
    expect(
      geminiBatchOutputFileNames({
        response: {
          outputConfig: {
            fileName: "files/output-jsonl",
          },
        },
      }),
    ).toEqual(["files/output-jsonl"]);

    expect(
      geminiBatchOutputFileNames({
        metadata: {
          output: { responsesFile: "files/current-metadata-output" },
        },
        response: {
          responsesFile: "files/current-response-output",
        },
      }),
    ).toEqual(["files/current-metadata-output", "files/current-response-output"]);
  });

  it("writes documented keyed JSONL requests while preserving inline metadata envelopes", () => {
    const entry = {
      request: { contents: [{ parts: [{ text: "hello" }] }] },
      metadata: { key: "source-1", source_url: "https://example.com" },
    };

    expect(geminiBatchJsonlRequest(entry)).toEqual({
      key: "source-1",
      request: entry.request,
    });
    expect(entry.metadata.source_url).toBe("https://example.com");
  });

  it("recovers only the newest completed file result for duplicate request keys", () => {
    const state = {
      jobs: [
        {
          batch_name: "batches/older",
          status: "succeeded",
          input_mode: "jsonl_file",
          submitted_at: "2026-07-14T01:00:00Z",
          request_keys: ["source-1", "source-2"],
        },
        {
          batch_name: "batches/newer",
          status: "succeeded",
          input_mode: "jsonl_file",
          submitted_at: "2026-07-14T02:00:00Z",
          request_keys: ["source-1", "source-2"],
        },
      ],
    };

    const awaiting = batchJobsAwaitingReconciliation(state);
    const latest = latestRequestKeysByBatchJob(awaiting);
    expect(awaiting).toHaveLength(2);
    expect(latest.get("batches/newer")).toEqual(["source-1", "source-2"]);
    expect(latest.get("batches/older")).toEqual([]);
    expect([...activeBatchRequestKeys(state)].sort()).toEqual(["source-1", "source-2"]);

    state.jobs[1].reconciled_at = "2026-07-14T03:00:00Z";
    expect(batchJobsAwaitingReconciliation(state)).toHaveLength(1);
  });

  it("switches oversized batches to JSONL file mode", () => {
    const small = [{ request: { contents: [{ parts: [{ text: "hello" }] }] }, metadata: { key: "one" } }];
    const large = Array.from({ length: 3 }, (_, index) => ({
      request: { contents: [{ parts: [{ text: "x".repeat(2_000) }] }] },
      metadata: { key: `source-${index}` },
    }));

    expect(batchInputModeForRequests(small, { inlineThreshold: 10, maxInlineBytes: 10_000 })).toBe("inline");
    expect(batchInputModeForRequests(large, { inlineThreshold: 10, maxInlineBytes: 1_000 })).toBe("jsonl_file");
  });

  it("downgrades image attachment when text evidence is sufficient", () => {
    const promptText = "Award page context ".repeat(500);
    expect(
      shouldAttachBaselineFactsImage({
        capture: {
          thumb_path: "thumb.jpg",
          text: "Example Award page context ".repeat(500),
          page_title: "Example Award",
        },
        promptText,
      }),
    ).toBe(false);
    expect(
      shouldAttachBaselineFactsImage({
        capture: {
          thumb_path: "thumb.jpg",
          text: "Short text",
          page_title: "Example Award",
        },
        promptText: "Short text",
      }),
    ).toBe(true);
  });
});
