import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("./process-visual-review-batch.mjs", import.meta.url),
  "utf8",
);

describe("stored visual publication retry wiring", () => {
  it("processes durable succeeded results before any Gemini batch GET", () => {
    const pollStart = source.indexOf("async function pollExistingBatches()");
    const localRetry = source.indexOf("await reconcileStoredSucceededCandidates()", pollStart);
    const providerGet = source.indexOf("const job = await fetchGeminiJson", pollStart);
    expect(localRetry).toBeGreaterThan(pollStart);
    expect(providerGet).toBeGreaterThan(localRetry);
    const pollPrefix = source.slice(pollStart, providerGet);
    expect(pollPrefix).not.toContain('["submitted", "processing", "succeeded"');
  });

  it("rotates retry-pending rows and isolates per-candidate failures", () => {
    const retryStart = source.indexOf("async function reconcileStoredSucceededCandidates()");
    const retryEnd = source.indexOf("async function submitPendingCandidates()", retryStart);
    const body = source.slice(retryStart, retryEnd);
    expect(body).toContain('.order("updated_at", { ascending: true })');
    expect(body).toContain('.order("id", { ascending: true })');
    expect(body).toContain("publication_claim_token.is.null");
    expect(body).toContain("publication_claimed_at.lt.");
    expect(body).toContain("for (const candidate of candidates) {\n    try {");
    expect(body).toContain("stored_publication_retry_errors += 1");
    expect(body).not.toContain("throw error;");
  });

  it("isolates an unavailable provider batch so later polling and submission continue", () => {
    const pollStart = source.indexOf("async function pollExistingBatches()");
    const pollEnd = source.indexOf(
      "async function reconcileStoredSucceededCandidates()",
      pollStart,
    );
    const body = source.slice(pollStart, pollEnd);
    expect(body).toContain("for (const batchName of batchNames) {\n    const batchReport");
    expect(body).toContain("try {\n      const job = await fetchGeminiJson");
    expect(body).toContain('batchReport.state = "poll_error"');
    expect(body).toContain('pollFailure.action === "fail_for_bounded_retry"');
    expect(body).toContain("await markBatchRowsFailed(batchName, missingReason)");
    expect(body).toContain('stage: "batch_poll_or_reconcile"');
    expect(body).not.toContain("throw error;");

    const runStart = source.indexOf("try {\n  if (poll && !submitOnly)");
    const submitCall = source.indexOf("await submitPendingCandidates()", runStart);
    expect(submitCall).toBeGreaterThan(runStart);
  });

  it("preserves Gemini HTTP status so only 404 and 410 enter bounded resubmission", () => {
    const requestStart = source.indexOf("async function fetchGeminiJson(");
    const requestEnd = source.indexOf("function possibleExternalBatchCreatedError", requestStart);
    const body = source.slice(requestStart, requestEnd);
    expect(body).toContain("definiteError.geminiHttpStatus = Number(response.status)");
    expect(body).toContain("definiteError.geminiRequestKind = cleanText(kind)");
  });

  it("tracks stored results that are requeued for current policy or source context", () => {
    const retryStart = source.indexOf("async function reconcileStoredSucceededCandidates()");
    const retryEnd = source.indexOf("async function submitPendingCandidates()", retryStart);
    const body = source.slice(retryStart, retryEnd);
    expect(body).toContain('publishResult.status === "requeued"');
    expect(body).toContain("requeued_for_current_source_context += 1");
    expect(body).toContain("requeued_for_current_policy += 1");
  });
});
