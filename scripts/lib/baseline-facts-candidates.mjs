import { sourceQualityDecision } from "./source-quality.mjs";
import { isStage1ManifestSource } from "./stage1-manifest-sources.mjs";

// Model tiering for the baseline-facts extractor.
//
// Stage 1 manifest sources (the ~125 reviewed sources behind the live award
// pages) are extracted with the strong model. Everything else runs on the
// fleet model first and is escalated to the strong model only when the fleet
// verdict is unusable (invalid JSON) or merely "unclear" on a source that is
// either Stage 1 or about to be auto-cleaned out of monitoring.
//
// The worker imports GEMINI_STRONG_WORKER_MODEL from ./gemini-worker-policy.mjs
// as the source of truth; this default only backs an emptied policy value.
export const BASELINE_FACTS_STRONG_MODEL_FALLBACK = "gemini-3.7-flash";
export const BASELINE_FACTS_STRONG_MODEL_MAX_OUTPUT_TOKENS = 4096;
export const BASELINE_FACTS_STRONG_MODEL_MAX_BATCH_REQUESTS = 25;
export const BASELINE_FACTS_STRONG_MODEL_THINKING_LEVEL = "low";

const escalatableRejectionReasons = new Set([
  "award_relevance_unclear",
  "cycle_relevance_unclear",
  "award_relevance_missing",
  "cycle_relevance_missing",
  "relevance_missing",
]);

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

/**
 * Choose the Gemini model for one baseline-facts source.
 * Stage 1 manifest sources use the strong model; everything else the fleet model.
 */
export function baselineFactsModelForSource({ source, manifest, fleetModel, strongModel }) {
  const fleet = cleanModel(fleetModel);
  const strong = cleanModel(strongModel);
  if (!fleet) throw new Error("baselineFactsModelForSource requires a fleet model.");
  if (!strong) throw new Error("baselineFactsModelForSource requires a strong model.");
  const sourceId = typeof source === "string" ? source : source?.id;
  if (isStage1ManifestSource(manifest, sourceId)) {
    return { model: strong, tier: "strong", reason: "stage1_manifest_source" };
  }
  return {
    model: fleet,
    tier: "fleet",
    reason: manifest?.available ? "fleet_source" : "stage1_manifest_unavailable",
  };
}

/**
 * Group batch entries by the model they must be submitted with. One Gemini
 * Batch job targets exactly one model (the model is part of the URL), so a
 * mixed group can never be submitted. Order of first appearance is kept.
 */
export function partitionBaselineFactsEntriesByModel(entries, { modelForEntry = defaultModelForEntry } = {}) {
  const groups = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const model = cleanModel(modelForEntry(entry));
    if (!model) {
      throw new Error(
        `Baseline facts batch entry ${entry?.source?.id || "unknown"} has no model; refusing to submit an untiered request.`,
      );
    }
    if (!groups.has(model)) groups.set(model, []);
    groups.get(model).push(entry);
  }
  return [...groups.entries()].map(([model, groupEntries]) => ({ model, entries: groupEntries }));
}

/**
 * Model of a single-model batch. Fails closed when the entries disagree.
 */
export function baselineFactsBatchModel(entries, fallbackModel = null) {
  const models = new Set(
    (Array.isArray(entries) ? entries : [])
      .map((entry) => cleanModel(entry?.model))
      .filter(Boolean),
  );
  if (models.size > 1) {
    throw new Error(`Baseline facts batch mixes models (${[...models].join(", ")}); one batch must use one model.`);
  }
  const model = models.size === 1 ? [...models][0] : cleanModel(fallbackModel);
  if (!model) throw new Error("Baseline facts batch has no model.");
  return model;
}

/**
 * Decide whether a fleet-model outcome should be re-run on the strong model
 * before the existing reject/hold path is allowed to write anything.
 *
 * Escalates when the outcome is unusable or merely unclear AND the source is
 * either a Stage 1 manifest source or would otherwise be auto-cleaned to
 * review_later on the strength of a weak-model verdict. Never escalates a
 * strong-model outcome or an entry that was already escalated (one hop per
 * entry per run).
 */
export function baselineFactsEscalationDecision({
  outcome,
  reason = null,
  facts = null,
  source,
  manifest,
  model,
  strongModel,
  escalation = null,
}) {
  const strong = cleanModel(strongModel);
  const current = cleanModel(model);
  if (escalation && typeof escalation === "object" && escalation.escalated_from_model) {
    return { escalate: false, reason: "already_escalated" };
  }
  if (!strong) return { escalate: false, reason: "strong_model_unconfigured" };
  if (current && current === strong) return { escalate: false, reason: "strong_model_result" };

  const normalizedOutcome = normalizeToken(outcome);
  const normalizedReason = normalizeToken(reason);
  let trigger = null;
  if (normalizedOutcome === "invalid_json") trigger = "invalid_json";
  else if (normalizedOutcome === "rejected" && escalatableRejectionReasons.has(normalizedReason)) trigger = normalizedReason;
  if (!trigger) return { escalate: false, reason: "not_escalatable_outcome" };

  const sourceId = typeof source === "string" ? source : source?.id;
  if (isStage1ManifestSource(manifest, sourceId)) {
    return { escalate: true, trigger, basis: "stage1_manifest_source", reason: `${trigger}:stage1_manifest_source` };
  }
  if (
    normalizedOutcome === "rejected" &&
    baselineFactsRejectionDisposition({ facts, reason: normalizedReason }).reviewLater
  ) {
    return { escalate: true, trigger, basis: "review_later_disposition", reason: `${trigger}:review_later_disposition` };
  }
  return {
    escalate: false,
    reason: trigger === "invalid_json" ? "fleet_source_invalid_json" : "fleet_source_needs_review_only",
  };
}

export function baselineFactsMaxOutputTokensForModel({ model, strongModel, fleetMaxOutputTokens }) {
  if (cleanModel(model) && cleanModel(model) === cleanModel(strongModel)) {
    return BASELINE_FACTS_STRONG_MODEL_MAX_OUTPUT_TOKENS;
  }
  const fleet = Number(fleetMaxOutputTokens);
  if (!Number.isFinite(fleet) || fleet <= 0) {
    throw new Error("baselineFactsMaxOutputTokensForModel requires a positive fleet max_output_tokens.");
  }
  return Math.floor(fleet);
}

/**
 * generationConfig for one model tier. The strong model thinks at the low
 * level and needs the 4096 cap because maxOutputTokens bounds thinking and
 * output together; the fleet model keeps thinking off and its configured cap.
 */
export function baselineFactsGenerationConfig({ model, strongModel, fleetMaxOutputTokens }) {
  const maxOutputTokens = baselineFactsMaxOutputTokensForModel({ model, strongModel, fleetMaxOutputTokens });
  if (cleanModel(model) && cleanModel(model) === cleanModel(strongModel)) {
    // Gemini 3 guidance: keep temperature at its default 1.0 (lower values
    // "may lead to unexpected behavior, such as looping").
    return {
      temperature: 1,
      maxOutputTokens,
      thinkingConfig: { thinkingLevel: BASELINE_FACTS_STRONG_MODEL_THINKING_LEVEL },
      responseMimeType: "application/json",
    };
  }
  return {
    temperature: 0.1,
    maxOutputTokens,
    thinkingConfig: { thinkingBudget: 0 },
    responseMimeType: "application/json",
  };
}

/**
 * Batch-rate cost estimate for a single-model batch. `rates` is the
 * { input, output } USD-per-million pair from geminiPricePerMillion(model, "batch").
 * Output is bounded by the per-request cap, so the total is a maximum.
 */
export function estimateBaselineFactsBatchCostUsd({ promptTokens, requestCount, maxOutputTokens, rates }) {
  const input = Number(rates?.input);
  const output = Number(rates?.output);
  if (!Number.isFinite(input) || !Number.isFinite(output)) {
    throw new Error("estimateBaselineFactsBatchCostUsd requires numeric input/output rates.");
  }
  const prompt = Math.max(0, Number(promptTokens) || 0);
  const requests = Math.max(0, Math.floor(Number(requestCount) || 0));
  const cap = Math.max(0, Math.floor(Number(maxOutputTokens) || 0));
  const inputUsd = roundUsd((prompt / 1_000_000) * input);
  const outputUsdMax = roundUsd(((requests * cap) / 1_000_000) * output);
  return {
    prompt_tokens: prompt,
    max_output_tokens_total: requests * cap,
    input_usd: inputUsd,
    output_usd_max: outputUsdMax,
    total_usd_max: roundUsd(inputUsd + outputUsdMax),
  };
}

function defaultModelForEntry(entry) {
  return entry?.model;
}

function cleanModel(value) {
  return String(value || "").trim();
}

function roundUsd(value) {
  return Math.round((Number(value) || 0) * 1_000_000) / 1_000_000;
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
