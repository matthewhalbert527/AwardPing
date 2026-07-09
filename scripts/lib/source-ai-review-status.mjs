const hardRejectedFlags = new Set([
  "source-mismatch",
  "spam",
  "job-board",
  "career-page",
  "search-results",
  "generic-listing",
  "sibling-program",
  "access-error",
  "hacked-page",
  "pharma-spam",
  "unrelated-program",
  "payment",
  "profile",
  "recipient",
  "news",
  "not-program-page",
]);

const acceptedAwardRelevance = new Set(["primary", "supporting"]);
const acceptedCycleRelevance = new Set(["current-or-upcoming", "evergreen"]);

export function sourceBaselineFacts(source) {
  const metadata = objectValue(source?.page_metadata);
  const facts = objectValue(metadata.baseline_facts || metadata.baselineFacts);
  if (Object.keys(facts).length) return facts;
  if (metadata.kind || metadata.provider || metadata.model || metadata.baseline_facts_rejected) {
    return {};
  }
  return metadata;
}

export function getSourceAiReviewStatus(source) {
  return explainSourceAiReviewStatus(source).status;
}

export function sourceHasClearAiDetermination(source) {
  return explainSourceAiReviewStatus(source).complete;
}

export function sourceNeedsAiReview(source) {
  return explainSourceAiReviewStatus(source).needsAiReview;
}

export function sourceNeedsManualReview(source) {
  return explainSourceAiReviewStatus(source).needsManualReview;
}

export function sourceCanContributePublicFacts(source) {
  return explainSourceAiReviewStatus(source).canContributePublicFacts;
}

export function sourceCanBeMonitored(source) {
  return explainSourceAiReviewStatus(source).canBeMonitored;
}

export function explainSourceAiReviewStatus(source) {
  const metadata = objectValue(source?.page_metadata);
  const facts = sourceBaselineFacts(source);
  const metadataFacts = objectValue(metadata.baseline_facts || metadata.baselineFacts);
  const hasBaselineFacts = Object.keys(facts).length > 0;
  const hasBaselineFactsRejected = baselineFactsRejected(metadata);
  const hasGeneratedAt = Boolean(source?.page_metadata_generated_at || metadata.generated_at);
  const hasModel = Boolean(source?.page_metadata_model || metadata.model || objectValue(metadata.baseline_facts_metadata).model);
  const awardRelevance = hasBaselineFacts ? cleanKey(facts.award_relevance) || null : null;
  const cycleRelevance = hasBaselineFacts ? cleanKey(facts.cycle_relevance) || null : null;
  const confidence = hasBaselineFacts ? cleanKey(facts.confidence) || null : null;
  const qualityFlags = normalizedQualityFlags(metadata, facts);
  const rejectionReason = cleanReason(
    metadata.rejection_reason ||
      metadata.baseline_facts_rejection_reason ||
      objectValue(metadata.baseline_facts_metadata).rejection_reason ||
      objectValue(metadata.baseline_facts_metadata).reason ||
      facts.rejection_reason,
  );
  const statusFromFailure = reviewFailureStatus(metadata);
  const hardFlag = qualityFlags.find((flag) => hardRejectedFlags.has(flag));

  const result = (status, reason, overrides = {}) => {
    const accepted = status === "reviewed_accepted_primary" || status === "reviewed_accepted_supporting";
    const rejected =
      status === "reviewed_rejected_unrelated" ||
      status === "reviewed_rejected_sibling_program" ||
      status === "reviewed_rejected_archived_or_past" ||
      status === "reviewed_rejected_not_program_page" ||
      status === "reviewed_rejected_access_error" ||
      status === "reviewed_rejected_generic_listing";
    const complete = accepted || rejected || status === "reviewed_unclear_needs_manual_review";
    const canUse =
      accepted &&
      acceptedCycleRelevance.has(cycleRelevance || "") &&
      confidence !== "low" &&
      !hardFlag;
    return {
      status,
      complete,
      canContributePublicFacts: canUse,
      canBeMonitored: canUse,
      needsAiReview: status === "unreviewed" || status === "review_failed" || status === "reviewed_invalid_or_incomplete",
      needsManualReview: status === "reviewed_unclear_needs_manual_review" || status === "reviewed_invalid_or_incomplete",
      reason,
      awardRelevance,
      cycleRelevance,
      confidence,
      qualityFlags,
      rejectionReason,
      hasBaselineFacts,
      hasBaselineFactsRejected,
      hasGeneratedAt,
      hasModel,
      ...overrides,
    };
  };

  if (!hasGeneratedAt && !hasBaselineFacts && !hasBaselineFactsRejected) {
    return result("unreviewed", "missing_page_metadata_generated_at_and_baseline_facts");
  }

  if (statusFromFailure) {
    return result("review_failed", statusFromFailure, { complete: false });
  }

  if (!hasGeneratedAt || !hasModel) {
    return result("reviewed_invalid_or_incomplete", !hasGeneratedAt ? "missing_page_metadata_generated_at" : "missing_page_metadata_model", {
      complete: false,
    });
  }

  if (!hasBaselineFacts && !hasBaselineFactsRejected) {
    return result("reviewed_invalid_or_incomplete", "missing_baseline_facts_or_rejection", {
      complete: false,
    });
  }

  if (hardFlag) {
    return result(statusForRejectedSignal(hardFlag), `quality_flag_${hardFlag}`);
  }

  if (hasBaselineFactsRejected) {
    if (!rejectionReason) {
      return result("reviewed_invalid_or_incomplete", "baseline_facts_rejected_missing_rejection_reason", {
        complete: false,
      });
    }
    return result(statusForRejectedSignal(rejectionReason), `baseline_facts_rejected_${cleanKey(rejectionReason) || "source"}`);
  }

  if (!hasBaselineFacts || !Object.keys(metadataFacts).length) {
    return result("reviewed_invalid_or_incomplete", "missing_nested_baseline_facts", { complete: false });
  }

  if (!awardRelevance) {
    return result("reviewed_invalid_or_incomplete", "missing_award_relevance", { complete: false });
  }
  if (awardRelevance === "unclear") {
    return result("reviewed_unclear_needs_manual_review", "award_relevance_unclear");
  }
  if (awardRelevance === "unrelated") {
    return result("reviewed_rejected_unrelated", "award_relevance_unrelated");
  }
  if (!acceptedAwardRelevance.has(awardRelevance)) {
    return result("reviewed_invalid_or_incomplete", `unknown_award_relevance_${awardRelevance}`, {
      complete: false,
    });
  }

  if (!cycleRelevance) {
    return result("reviewed_invalid_or_incomplete", "missing_cycle_relevance", { complete: false });
  }
  if (cycleRelevance === "unclear") {
    return result("reviewed_unclear_needs_manual_review", "cycle_relevance_unclear");
  }
  if (cycleRelevance === "not-program-page") {
    return result("reviewed_rejected_not_program_page", "cycle_relevance_not_program_page");
  }
  if (cycleRelevance === "archived-or-past") {
    return result("reviewed_rejected_archived_or_past", "cycle_relevance_archived_or_past");
  }
  if (!acceptedCycleRelevance.has(cycleRelevance)) {
    return result("reviewed_invalid_or_incomplete", `unknown_cycle_relevance_${cycleRelevance}`, {
      complete: false,
    });
  }

  if (confidence === "low") {
    return result("reviewed_unclear_needs_manual_review", "confidence_low");
  }

  return result(
    awardRelevance === "primary" ? "reviewed_accepted_primary" : "reviewed_accepted_supporting",
    "accepted",
  );
}

function baselineFactsRejected(metadata) {
  return Boolean(
    metadata.baseline_facts_rejected === true ||
      metadata.baselineFactsRejected === true ||
      objectValue(metadata.baseline_facts_metadata).rejected === true,
  );
}

function reviewFailureStatus(metadata) {
  const status = cleanKey(metadata.status || metadata.review_status || objectValue(metadata.baseline_facts_metadata).status);
  if (status === "failed" || status === "error") return `review_status_${status}`;
  const reason = cleanKey(metadata.error || metadata.last_error || objectValue(metadata.baseline_facts_metadata).error);
  if (reason) return `review_error_${reason}`;
  return null;
}

function statusForRejectedSignal(signal) {
  const key = cleanKey(signal);
  if (key.includes("sibling") || key.includes("unrelated-program")) return "reviewed_rejected_sibling_program";
  if (key.includes("archive") || key.includes("past")) return "reviewed_rejected_archived_or_past";
  if (key.includes("not-program")) return "reviewed_rejected_not_program_page";
  if (key.includes("access") || key.includes("captcha") || key.includes("security") || key.includes("login")) {
    return "reviewed_rejected_access_error";
  }
  if (
    key.includes("generic") ||
    key.includes("listing") ||
    key.includes("search") ||
    key.includes("job") ||
    key.includes("career") ||
    key.includes("payment") ||
    key.includes("profile") ||
    key.includes("recipient") ||
    key.includes("news")
  ) {
    return "reviewed_rejected_generic_listing";
  }
  return "reviewed_rejected_unrelated";
}

function normalizedQualityFlags(metadata, facts) {
  return [
    ...stringArray(facts.quality_flags),
    ...stringArray(metadata.quality_flags),
    ...stringArray(objectValue(metadata.baseline_facts_metadata).quality_flags),
    cleanKey(metadata.rejection_reason),
    cleanKey(facts.rejection_reason),
  ]
    .map(cleanKey)
    .filter(Boolean);
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stringArray(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || ""));
  if (typeof value === "string") return value.split(/[,;|]/);
  return [];
}

function cleanReason(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}

function cleanKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]+/g, "")
    .replace(/-+/g, "-");
}
