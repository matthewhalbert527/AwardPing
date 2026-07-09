import { describe, expect, it } from "vitest";
import {
  activeBatchRequestKeys,
  batchInputModeForRequests,
  estimateGeminiCostUsd,
  extractGeminiBatchInlineResponses,
  geminiBatchInlineResponseMap,
  geminiBatchOutputFileNames,
  mergeBatchJobRecord,
  normalizeGeminiPricingMode,
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
