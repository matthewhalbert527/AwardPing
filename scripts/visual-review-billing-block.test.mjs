import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  geminiBillingBlockPath,
  isGeminiBillingBlockedError,
  isGeminiBillingBlockedResponse,
  markGeminiBillingBlocked,
  readGeminiBillingBlock,
} from "./lib/gemini-spend-guard.mjs";

const worker = readFileSync(
  new URL("./process-visual-review-batch.mjs", import.meta.url),
  "utf8",
);

const LIVE_MESSAGE =
  "Your prepayment credits are depleted. Please go to AI Studio (https://aistudio.google.com/) to check your billing.";
const PLAIN_QUOTA_MESSAGE =
  "Quota exceeded for quota metric 'Generate Content API requests per minute' and limit 'GenerateContent request limit per minute per project'.";

const functionBody = (name, nextName) => {
  const start = worker.indexOf(`${name}(`);
  const end = worker.indexOf(nextName, start + 1);
  expect(start, `${name} must exist`).toBeGreaterThanOrEqual(0);
  expect(end, `${nextName} must follow ${name}`).toBeGreaterThan(start);
  return worker.slice(start, end);
};

const runBlock = () => {
  const start = worker.indexOf("try {\n  stage1Manifest = await loadStage1ManifestSources(supabase);");
  const end = worker.indexOf('} catch (error) {\n  report.status = "failed";', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return worker.slice(start, end);
};

describe("Gemini billing-block predicate", () => {
  it("recognises the live depleted-prepayment 429 and refuses to retry it", () => {
    expect(isGeminiBillingBlockedResponse(429, LIVE_MESSAGE)).toBe(true);
    expect(isGeminiBillingBlockedResponse("429", LIVE_MESSAGE)).toBe(true);
    const error = new Error(`Gemini HTTP 429: ${LIVE_MESSAGE}`);
    error.geminiHttpStatus = 429;
    expect(isGeminiBillingBlockedError(error)).toBe(true);
    const flagged = new Error("Gemini file upload start failed: 429 {}");
    flagged.geminiBillingBlocked = true;
    expect(isGeminiBillingBlockedError(flagged)).toBe(true);
  });

  it("keeps a plain 429 quota message retryable", () => {
    expect(isGeminiBillingBlockedResponse(429, PLAIN_QUOTA_MESSAGE)).toBe(false);
    expect(isGeminiBillingBlockedResponse(429, "Resource has been exhausted (e.g. check quota).")).toBe(false);
    // Google's generic quota text mentions billing but is a rate limit, not a
    // block: matching it would write the fleet-wide block file on a transient 429.
    expect(isGeminiBillingBlockedResponse(
      429,
      "You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits.",
    )).toBe(false);
    expect(isGeminiBillingBlockedResponse(429, "Your prepayment credits are depleted. Please go to AI Studio to manage your project and billing.")).toBe(true);
    const error = new Error(`Gemini HTTP 429: ${PLAIN_QUOTA_MESSAGE}`);
    error.geminiHttpStatus = 429;
    expect(isGeminiBillingBlockedError(error)).toBe(false);
  });

  it("does not treat a 500 as a billing block even when the text mentions credits", () => {
    expect(isGeminiBillingBlockedResponse(500, LIVE_MESSAGE)).toBe(false);
    const error = new Error(`Gemini HTTP 500: ${LIVE_MESSAGE}`);
    error.geminiHttpStatus = 500;
    expect(isGeminiBillingBlockedError(error)).toBe(false);
    expect(isGeminiBillingBlockedError(null)).toBe(false);
    expect(isGeminiBillingBlockedError(new Error(LIVE_MESSAGE))).toBe(false);
  });
});

describe("Gemini billing-block file", () => {
  let archiveRoot = null;

  afterEach(() => {
    if (archiveRoot) rmSync(archiveRoot, { recursive: true, force: true });
    archiveRoot = null;
  });

  it("writes and reads the same operator-owned block file the capture worker uses", () => {
    archiveRoot = mkdtempSync(join(tmpdir(), "awardping-billing-block-"));
    const path = geminiBillingBlockPath(archiveRoot);
    expect(path).toBe(join(archiveRoot, "usage", "gemini-billing-blocked.json"));
    expect(readGeminiBillingBlock(archiveRoot)).toBeNull();

    const record = markGeminiBillingBlocked({
      archiveRoot,
      kind: "batch_create_inline",
      model: null,
      httpStatus: 429,
      providerStatus: "RESOURCE_EXHAUSTED",
      message: LIVE_MESSAGE,
    });
    expect(existsSync(path)).toBe(true);
    expect(record.provider).toBe("gemini");
    expect(record.http_status).toBe(429);
    expect(record.message).toBe(LIVE_MESSAGE);

    const read = readGeminiBillingBlock(archiveRoot);
    expect(read.path).toBe(path);
    expect(read.message).toBe(LIVE_MESSAGE);
    expect(read.kind).toBe("batch_create_inline");
  });
});

describe("visual review batch billing-block wiring", () => {
  it("fails fast on a billing-blocked response before the retry branch", () => {
    const body = functionBody("async function fetchGeminiJson", "function possibleExternalBatchCreatedError");
    const billingCheck = body.indexOf("isGeminiBillingBlockedResponse(response.status, providerError.message)");
    const retryBranch = body.indexOf("isRetryableGeminiFailure(response.status, responseBody)");
    expect(billingCheck).toBeGreaterThan(-1);
    expect(retryBranch).toBeGreaterThan(billingCheck);
    expect(body).toContain("throw geminiBillingBlockedError(message, {");
    expect(body).toContain("if (error?.geminiBillingBlocked) throw error;");
    expect(body.indexOf("if (error?.geminiBillingBlocked) throw error;")).toBeLessThan(
      body.indexOf("isRetryableNetworkFailure(error)"),
    );

    const retryPredicate = functionBody("function isRetryableGeminiFailure", "function isRetryableNetworkFailure");
    expect(retryPredicate.indexOf("isGeminiBillingBlockedResponse(")).toBeLessThan(
      retryPredicate.indexOf("[408, 409, 429, 500, 502, 503, 504]"),
    );
    expect(retryPredicate).toContain("geminiProviderErrorFromBody(body).message");
  });

  it("releases the chunk's claims through the existing definite-failure path", () => {
    const factory = functionBody("function geminiBillingBlockedError", "function recordGeminiBillingBlockFromError");
    expect(factory).toContain("error.geminiBillingBlocked = true;");
    expect(factory).toContain("if (safeToReleaseBatchClaim) error.safeToReleaseBatchClaim = true;");
    expect(factory).toContain("error.geminiHttpStatus = Number(httpStatus);");

    const submit = functionBody("async function submitCandidateChunk", "async function persistSubmittedClaim");
    expect(submit).not.toContain("isGeminiBillingBlockedError(");
    expect(submit).toContain(
      'expectedStatus: error?.safeToReleaseBatchClaim ? "creating" : null,',
    );
    expect(submit).toContain("await releaseSubmissionClaims(claimedCandidates, claimToken, error);");

    const upload = functionBody("function geminiUploadFailure", "function geminiProviderErrorFromBody");
    expect(upload).toContain("safeToReleaseBatchClaim: false,");
  });

  it("stops submitting further chunks and returns instead of throwing", () => {
    const submitPending = functionBody(
      "async function submitPendingCandidates",
      "async function recoverStaleSubmissionClaims",
    );
    expect(submitPending).toContain("await submitCandidateChunk(chunkModel, chunk, laneKey)");
    expect(submitPending).toContain("if (!isGeminiBillingBlockedError(error)) throw error;");
    expect(submitPending).toContain("recordGeminiBillingBlockFromError(error);\n          return;");
  });

  it("reports billing_blocked, writes the block file, logs one line, and exits 0", () => {
    const record = functionBody("function recordGeminiBillingBlock", "async function loadSourcesById");
    expect(record).toContain("if (report.billing_block) return report.billing_block;");
    expect(record).toContain("markGeminiBillingBlocked({\n      archiveRoot,");
    expect(record).toContain("provider_status: 429,");
    expect(record).toContain("block_file: blockPath,");
    expect(record).toContain("GEMINI_BILLING_BLOCKED lane=${paidLane || \"all\"}");
    expect(record).toContain("block_file=${blockPath}");
    expect(record).toContain("message=${truncate(cleanMessage, 240)}");
    expect(record).not.toContain("throw ");
    expect(record).not.toContain("process.exit");

    const run = runBlock();
    expect(run).toContain('report.status = report.billing_block ? "billing_blocked" : "succeeded";');
    expect(run.indexOf("await refreshStatusCounts();")).toBeLessThan(
      run.indexOf('report.status = report.billing_block ? "billing_blocked"'),
    );
    expect(run).not.toContain("throw ");
    expect(worker).toContain('report.status = "failed";\n  report.error = errorMessage(error);\n  throw error;');
    expect(worker).not.toContain("process.exitCode");
  });

  it("skips submission but still polls when the block file already exists", () => {
    const run = runBlock();
    const fileCheck = run.indexOf("readGeminiBillingBlock(archiveRoot)");
    const pollCall = run.indexOf("await pollExistingBatches();");
    const submitGate = run.indexOf("if (submit && !pollOnly && !report.billing_block) {");
    const submitCall = run.indexOf("await submitPendingCandidates();");
    expect(fileCheck).toBeGreaterThan(-1);
    expect(pollCall).toBeGreaterThan(fileCheck);
    expect(submitGate).toBeGreaterThan(pollCall);
    expect(submitCall).toBeGreaterThan(submitGate);
    expect(run).toContain('detectedVia: "block_file",');

    const record = functionBody("function recordGeminiBillingBlock", "async function loadSourcesById");
    expect(record).toContain('if (detectedVia === "provider_response") {\n    markGeminiBillingBlocked({');
  });

  it("records a billing block seen while polling without aborting the poll loop", () => {
    const poll = functionBody("async function pollExistingBatches", "async function reconcileStoredSucceededCandidates");
    expect(poll).toContain("if (isGeminiBillingBlockedError(error)) {\n        recordGeminiBillingBlockFromError(error);");
    expect(poll).not.toContain("throw error;");
  });
});
