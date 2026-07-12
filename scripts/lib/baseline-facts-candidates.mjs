import { sourceQualityDecision } from "./source-quality.mjs";

const forceReviewableQualityReasons = new Set([
  "award_relevance_unclear",
  "cycle_relevance_unclear",
]);

const reviewLaterQualityFlags = new Set([
  "source_mismatch",
  "spam",
  "job_board",
  "career_page",
  "search_results",
  "generic_listing",
  "sibling_program",
  "access_error",
  "hacked_page",
  "pharma_spam",
  "unrelated_program",
]);

const identityMismatchQualityFlags = new Set([
  "source_mismatch",
  "sibling_program",
  "unrelated_program",
]);

export function baselineReviewPreflightDecision({
  source,
  hasExistingFacts = false,
  force = false,
  activeBatchRequest = false,
}) {
  if (activeBatchRequest) {
    return { shouldReview: false, reason: "active_batch_request" };
  }

  const discoveryQuality = sourceQualityDecision(source, { purpose: "discovery" });
  const unresolvedMetadataNeedsReview =
    forceReviewableQualityReasons.has(discoveryQuality.reason) &&
    !sourceHasRejectedBaselineFacts(source);
  const forceAllowsUnclear = force && forceReviewableQualityReasons.has(discoveryQuality.reason);
  if (!discoveryQuality.allowed && !unresolvedMetadataNeedsReview && !forceAllowsUnclear) {
    return {
      shouldReview: false,
      reason: discoveryQuality.reason,
      quality: discoveryQuality,
    };
  }

  if (hasExistingFacts && !force) {
    const monitoringQuality = sourceQualityDecision(source, { purpose: "monitoring" });
    if (monitoringQuality.allowed) {
      return {
        shouldReview: false,
        reason: "existing_complete_ai_review",
        quality: monitoringQuality,
      };
    }
  }

  return {
    shouldReview: true,
    reason: forceAllowsUnclear
      ? "force_recheck_unclear"
      : unresolvedMetadataNeedsReview
        ? "resolve_unclear_ai_metadata"
        : "eligible_for_ai_review",
    quality: discoveryQuality,
  };
}

export function baselineFactsRejectionDisposition({ facts, reason }) {
  const awardRelevance = normalizeToken(facts?.award_relevance);
  const cycleRelevance = normalizeToken(facts?.cycle_relevance);
  const flags = new Set(
    (Array.isArray(facts?.quality_flags) ? facts.quality_flags : [])
      .map(normalizeToken)
      .filter(Boolean),
  );
  const normalizedReason = normalizeToken(reason);
  const hardFlags = [...flags].filter((flag) => reviewLaterQualityFlags.has(flag));
  const identityMismatch =
    awardRelevance === "unrelated" ||
    awardRelevance === "unclear" ||
    [...flags].some((flag) => identityMismatchQualityFlags.has(flag));
  const invalidProgramPage = ["not_program_page", "archived_or_past"].includes(cycleRelevance);
  const hardUrlRejection = normalizedReason.startsWith("url_");
  const reviewLater = identityMismatch || invalidProgramPage || hardFlags.length > 0 || hardUrlRejection;

  return {
    reviewLater,
    addSourceMismatch: identityMismatch,
    status: reviewLater ? "rejected" : "needs_review",
    reason: normalizedReason || "baseline_facts_rejected",
  };
}

function normalizeToken(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function sourceHasRejectedBaselineFacts(source) {
  const metadata = source?.page_metadata && typeof source.page_metadata === "object" && !Array.isArray(source.page_metadata)
    ? source.page_metadata
    : {};
  return metadata.baseline_facts_rejected === true || metadata.baselineFactsRejected === true;
}
