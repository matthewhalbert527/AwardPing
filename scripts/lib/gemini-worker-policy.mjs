import { isStage1ManifestSource } from "./stage1-manifest-sources.mjs";

// Fleet default: every worker lane reviews with the cheap flash-lite model.
export const GEMINI_WORKER_MODEL = "gemini-2.5-flash-lite";

// Strong tier: Stage 1 manifest sources (the ~125 sources behind the released
// cohorts) and escalated retries after an invalid-JSON fleet verdict.
export const GEMINI_STRONG_WORKER_MODEL = "gemini-3.7-flash";

// Strong-model provider batches stay small so a single reservation cannot
// consume the fixed daily lane cap and a bad batch has a bounded blast radius.
export const VISUAL_REVIEW_STRONG_MODEL_MAX_REQUESTS_PER_BATCH = 25;

export const VISUAL_REVIEW_ESCALATION_REASON_INVALID_AI_JSON = "invalid_ai_json";
export const VISUAL_REVIEW_ESCALATION_MAX_ATTEMPTS = 1;
export const VISUAL_REVIEW_ESCALATION_PRIOR_RAW_TEXT_LIMIT = 4_000;

// Output caps bound thinking + answer tokens together. The 2.5 flash-lite
// cap was 900 and 1,590 of 1,591 recent invalid-JSON failures were MAX_TOKENS
// truncations at 880-899 output tokens; gemini-3.x thinks before answering,
// so it needs more headroom even at the lowest thinking level.
// Temperature: Google's Gemini 3 guidance is to keep the default 1.0 (lower
// values "may lead to unexpected behavior, such as looping or degraded
// performance"); the response schema constrains the shape either way.
const VISUAL_REVIEW_GENERATION_CONFIG_BY_FAMILY = Object.freeze({
  "flash-lite": Object.freeze({
    temperature: 0.1,
    maxOutputTokens: 2_048,
    thinkingConfig: Object.freeze({ thinkingBudget: 0 }),
  }),
  "gemini-3-flash": Object.freeze({
    temperature: 1,
    maxOutputTokens: 4_096,
    thinkingConfig: Object.freeze({ thinkingLevel: "low" }),
  }),
});

// Claim / reservation keys that belong to the batch a candidate is leaving.
// An escalation requeue clears them so a crash between the new claim and its
// create-start can never rebind the row to the old, already-settled batch.
const VISUAL_REVIEW_REQUEUE_CLEARED_METADATA_KEYS = Object.freeze([
  "submission_claim_token",
  "submission_claimed_at",
  "submission_claimed_by",
  "batch_create_started_at",
  "possible_external_batch_name",
  "gemini_spend_reservation_id",
  "gemini_spend_reservation_key",
  "gemini_spend_attempt_token",
]);

export function geminiWorkerModel() {
  return GEMINI_WORKER_MODEL;
}

export function geminiStrongWorkerModel() {
  return GEMINI_STRONG_WORKER_MODEL;
}

/**
 * Model family used for output caps, thinking configuration, and tiering.
 * Returns null for a model the visual-review lane has no policy for so the
 * callers fail closed instead of guessing a cap.
 */
export function geminiModelFamily(model) {
  const name = cleanText(model).toLowerCase().replace(/^models\//, "");
  if (!name) return null;
  if (name.includes("flash-lite")) return "flash-lite";
  if (/gemini-3(?:\.\d+)?-flash/.test(name)) return "gemini-3-flash";
  return null;
}

export function isGeminiStrongWorkerModel(model) {
  return geminiModelFamily(model) === "gemini-3-flash";
}

export function visualReviewGenerationConfigForModel(model) {
  const family = geminiModelFamily(model);
  const config = family ? VISUAL_REVIEW_GENERATION_CONFIG_BY_FAMILY[family] : null;
  if (!config) {
    throw new Error(
      `Visual review has no generation policy for Gemini model "${cleanText(model) || "empty"}".`,
    );
  }
  return {
    temperature: config.temperature,
    maxOutputTokens: config.maxOutputTokens,
    thinkingConfig: { ...config.thinkingConfig },
  };
}

export function visualReviewMaxOutputTokensForModel(model) {
  return visualReviewGenerationConfigForModel(model).maxOutputTokens;
}

export function visualReviewMaxRequestsPerBatchForModel(model, configuredMaxRequestsPerBatch) {
  const configured = Math.max(1, Math.floor(Number(configuredMaxRequestsPerBatch) || 1));
  if (!isGeminiStrongWorkerModel(model)) return configured;
  return Math.min(configured, VISUAL_REVIEW_STRONG_MODEL_MAX_REQUESTS_PER_BATCH);
}

/**
 * The escalation record stamped by a prior invalid-JSON fleet verdict, or
 * null when the candidate has never been escalated.
 */
export function visualReviewEscalation(candidate) {
  const escalation = objectValue(objectValue(candidate?.worker_metadata).escalation);
  return Object.keys(escalation).length ? escalation : null;
}

export function visualReviewEscalationAttempt(candidate) {
  const attempt = Number(visualReviewEscalation(candidate)?.attempt);
  return Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
}

/**
 * Choose the review model for a pending candidate: the strong tier when the
 * candidate was escalated after an invalid fleet verdict or when its source
 * is pinned by a released Stage 1 cohort; the fleet model otherwise.
 */
export function modelForCandidate(candidate, manifest) {
  if (visualReviewEscalation(candidate)) return GEMINI_STRONG_WORKER_MODEL;
  if (isStage1ManifestSource(manifest, candidate?.shared_award_source_id)) {
    return GEMINI_STRONG_WORKER_MODEL;
  }
  return GEMINI_WORKER_MODEL;
}

export function visualReviewModelSelectionReason(candidate, manifest) {
  if (visualReviewEscalation(candidate)) return "escalation";
  if (isStage1ManifestSource(manifest, candidate?.shared_award_source_id)) {
    return "stage1_manifest_source";
  }
  return "fleet_default";
}

/**
 * Group one lane's candidates by the model they will be submitted with.
 * Insertion order follows the first candidate seen for each model so the
 * fleet tier keeps its position when it is first in the queue.
 */
export function partitionVisualReviewCandidatesByModel(candidates, manifest) {
  const byModel = new Map();
  for (const candidate of candidates || []) {
    const model = modelForCandidate(candidate, manifest);
    const existing = byModel.get(model) || [];
    existing.push(candidate);
    byModel.set(model, existing);
  }
  // The fleet tier submits first so strong-tier reservations (priced at the
  // strong model's standard rate against the fixed daily lane cap) can defer
  // only themselves, never the cheap bulk work behind them.
  return new Map(
    [...byModel.entries()].sort(
      ([left], [right]) => Number(isGeminiStrongWorkerModel(left)) - Number(isGeminiStrongWorkerModel(right)),
    ),
  );
}

/**
 * The model bound to a candidate when its submission claim was taken. The
 * lane stamps it on the claim so the provider request, the request
 * fingerprint, the spend reservation, and the persisted model column all
 * derive from one value.
 */
export function visualReviewClaimedModel(candidate) {
  const model = cleanText(objectValue(candidate?.worker_metadata).review_model);
  if (!model) {
    throw new Error(
      `Visual review candidate ${candidate?.id || "unknown"} was claimed without a bound review model.`,
    );
  }
  return model;
}

/**
 * Decide whether an invalid-JSON verdict should be retried once on the strong
 * model instead of failing the candidate. Failed rows are excluded because a
 * failed -> pending transition is reserved for operator-approved paid retries.
 */
export function visualReviewInvalidJsonEscalationDecision(candidate) {
  const status = cleanText(candidate?.status).toLowerCase();
  if (status === "failed") {
    return { escalate: false, reason: "failed_row_requires_paid_retry_approval" };
  }
  if (status !== "submitted" && status !== "processing") {
    return { escalate: false, reason: `status_${status || "unknown"}_not_in_flight` };
  }
  // An operator-approved paid retry is bound to the provider request it was
  // authorised for (model included); re-asking a different model would fail
  // the authorisation as request drift and burn the approval. Let it fail as
  // invalid_ai_json so the operator can approve a strong-model retry knowingly.
  const metadata = objectValue(candidate?.worker_metadata);
  const retryCount = Number(metadata.failure_retry_count || 0);
  if (cleanText(metadata.paid_retry_approval_id) || (Number.isFinite(retryCount) && retryCount > 0)) {
    return { escalate: false, reason: "paid_retry_bound_to_authorised_request" };
  }
  if (isGeminiStrongWorkerModel(candidate?.model)) {
    return { escalate: false, reason: "already_strong_model" };
  }
  if (visualReviewEscalationAttempt(candidate) >= VISUAL_REVIEW_ESCALATION_MAX_ATTEMPTS) {
    return { escalate: false, reason: "escalation_attempts_exhausted" };
  }
  return { escalate: true, reason: VISUAL_REVIEW_ESCALATION_REASON_INVALID_AI_JSON };
}

/**
 * The candidate patch that moves a submitted/processing row back to pending
 * for a strong-model retry. Spend accounting for the failed batch is kept
 * (actual_usage and the gemini_spend_* metadata) because that reservation was
 * already settled; the escalation record makes modelForCandidate pick the
 * strong tier and caps further escalation.
 */
export function buildEscalationRequeue(
  candidate,
  { usage, rawText, parseError, finishReason, model, batchName, now } = {},
) {
  const escalatedAt = cleanText(now) || new Date().toISOString();
  const existingMetadata = objectValue(candidate?.worker_metadata);
  const fromModel = cleanText(model) || cleanText(candidate?.model) || null;
  const fromBatchName = cleanText(batchName) || cleanText(candidate?.gemini_batch_name) || null;
  const clearedMetadata = Object.fromEntries(
    VISUAL_REVIEW_REQUEUE_CLEARED_METADATA_KEYS.map((key) => [key, null]),
  );
  // gemini_batch_request_key is deliberately NOT touched: the candidate
  // identity trigger (awardping_preserve_published_visual_candidate_identity)
  // rejects any change to it on a non-pending row, and the next submission
  // reuses the same key (= candidate_signature) anyway.
  return {
    status: "pending",
    gemini_batch_name: null,
    model: null,
    ai_result: null,
    rejection_reason: null,
    actual_usage: objectValue(usage),
    submitted_at: null,
    completed_at: null,
    worker_metadata: {
      ...existingMetadata,
      ...clearedMetadata,
      escalation: {
        attempt: visualReviewEscalationAttempt(candidate) + 1,
        reason: VISUAL_REVIEW_ESCALATION_REASON_INVALID_AI_JSON,
        from_model: fromModel,
        from_batch_name: fromBatchName,
        finish_reason: cleanText(finishReason) || null,
        prior_raw_text: String(rawText || "").slice(0, VISUAL_REVIEW_ESCALATION_PRIOR_RAW_TEXT_LIMIT),
        prior_parse_error: cleanText(parseError) || null,
        escalated_at: escalatedAt,
      },
    },
    updated_at: escalatedAt,
  };
}

export function normalizeGeminiBatchMode(value, { allowNone = false, context = "Gemini worker" } = {}) {
  const normalized = String(value || "batch").trim().toLowerCase();
  if (normalized === "batch") return "batch";
  if (allowNone && normalized === "none") return "none";
  const allowed = allowNone ? "batch or none" : "batch";
  throw new Error(`${context} must use Gemini API mode ${allowed}; received "${normalized || "empty"}".`);
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
