import crypto from "node:crypto";
import { GEMINI_PAID_LANES } from "./gemini-spend-ledger.mjs";

const INITIAL_OFFICIAL_DOCUMENT_SCOPE = "initial_official_document";
const SHA256_HEX = /^[0-9a-f]{64}$/;

export function paidVisualReviewLaneForCandidate(candidate) {
  return candidate?.candidate_scope === INITIAL_OFFICIAL_DOCUMENT_SCOPE
    ? GEMINI_PAID_LANES.NEW_PAGE_REVIEW
    : GEMINI_PAID_LANES.CHANGED_PAGE_REVIEW;
}

export function paidVisualReviewWorkKindForLane(laneKey) {
  if (laneKey === GEMINI_PAID_LANES.NEW_PAGE_REVIEW) return "new-page-review";
  if (laneKey === GEMINI_PAID_LANES.CHANGED_PAGE_REVIEW) return "changed-page-review";
  throw new Error(`Unknown paid visual-review lane: ${laneKey || "missing"}.`);
}

export function paidVisualRetryRequiresAuthorization(candidate) {
  if (cleanText(candidate?.worker_metadata?.paid_retry_approval_id)) return true;
  const retryCount = Number(candidate?.worker_metadata?.failure_retry_count || 0);
  return Number.isFinite(retryCount) && retryCount > 0;
}

export function paidVisualRetryAuthorizationPrecheck(candidate, expectedLaneKey) {
  if (!paidVisualRetryRequiresAuthorization(candidate)) {
    return { required: false, allowed: true, reason: "first_attempt" };
  }
  const actualLaneKey = paidVisualReviewLaneForCandidate(candidate);
  if (actualLaneKey !== expectedLaneKey) {
    return {
      required: true,
      allowed: false,
      reason: "paid_retry_lane_mismatch",
      actualLaneKey,
    };
  }
  const requestFingerprint = cleanText(
    candidate?.worker_metadata?.paid_retry_approved_request_fingerprint,
  );
  if (!SHA256_HEX.test(requestFingerprint)) {
    return {
      required: true,
      allowed: false,
      reason: "paid_retry_approval_missing",
      actualLaneKey,
    };
  }
  return {
    required: true,
    allowed: true,
    reason: "database_recheck_required",
    actualLaneKey,
    requestFingerprint,
  };
}

export function partitionPaidVisualReviewCandidates(candidates) {
  const lanes = new Map();
  for (const candidate of candidates || []) {
    const laneKey = paidVisualReviewLaneForCandidate(candidate);
    const existing = lanes.get(laneKey) || [];
    existing.push(candidate);
    lanes.set(laneKey, existing);
  }
  return lanes;
}

export function paidVisualProviderRequestFingerprint({
  laneKey,
  model,
  batchRequest,
}) {
  paidVisualReviewWorkKindForLane(laneKey);
  const normalizedModel = cleanText(model);
  if (!normalizedModel) throw new Error("A Gemini model is required for request binding.");
  if (!batchRequest || typeof batchRequest !== "object" || Array.isArray(batchRequest)) {
    throw new Error("A complete Gemini batch request is required for request binding.");
  }
  return crypto.createHash("sha256").update(stableJsonStringify({
    lane_key: laneKey,
    model: normalizedModel,
    batch_request: batchRequest,
  })).digest("hex");
}

export async function runPaidVisualProviderCreateBoundary({
  journalCreateStart,
  authorizeAtProviderBoundary,
  providerCreate,
}) {
  await journalCreateStart();
  const authorization = await authorizeAtProviderBoundary();
  const failures = Array.isArray(authorization?.failures)
    ? authorization.failures
    : [];
  if (failures.length) {
    const error = new Error(
      "A paid visual-review approval expired or drifted before provider create.",
    );
    error.paidRetryAuthorizationFailures = failures;
    throw error;
  }
  return providerCreate();
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function stableJsonStringify(value) {
  return JSON.stringify(sortJson(value));
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, sortJson(value[key])]),
  );
}
