import { visualReviewEnclosingCaptureIdentity } from "./visual-review-queue.mjs";

export function isRequiredVisualPublicationRetry(candidate) {
  const reason = cleanText(candidate?.rejection_reason);
  return reason.startsWith("baseline_promotion_pending:") ||
    reason.startsWith("publish_retry_pending:") ||
    reason.startsWith("source_publication_order_pending:") ||
    candidate?.worker_metadata?.baseline_publication_guard?.action === "retry";
}

export function findBlockingPriorVisualPublication(candidate, earlierCandidates = []) {
  const currentCapture = visualReviewEnclosingCaptureIdentity(candidate);
  return earlierCandidates.find((earlierCandidate) =>
    isNonterminalVisualPublication(earlierCandidate) &&
    visualReviewEnclosingCaptureIdentity(earlierCandidate) !== currentCapture,
  ) || null;
}

export function shouldSupersedeVisualPublication(candidate, hasNewerCandidate) {
  return Boolean(hasNewerCandidate) && !isRequiredVisualPublicationRetry(candidate);
}

function isNonterminalVisualPublication(candidate) {
  if (["pending", "submitted", "processing", "succeeded"].includes(candidate?.status)) return true;
  return candidate?.status === "failed" &&
    cleanText(candidate?.rejection_reason) === "missing_batch_response";
}

export function compareVisualCandidateOrder(left, right) {
  const leftTime = Date.parse(String(left?.created_at || ""));
  const rightTime = Date.parse(String(right?.created_at || ""));
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
    return leftTime < rightTime ? -1 : 1;
  }
  return String(left?.id || "").localeCompare(String(right?.id || ""));
}

function cleanText(value) {
  return String(value || "").trim();
}
