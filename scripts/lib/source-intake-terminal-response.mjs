const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const sha256 = /^[0-9a-f]{64}$/;
const model = "gemini-2.5-flash-lite";
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const present = (value) => value !== null && value !== undefined && value !== "";

/**
 * Recognizes one stored, terminal FAILED source-intake item. The worker only
 * stores this provider response after a terminal Batch, but retains its older
 * submission markers on MAX_TOKENS. This is not result acceptance, provider
 * state polling, input-digest authentication, or permission to retry/pay.
 * @param {unknown} value
 * @param {unknown} requestId
 * @param {unknown} fileHash
 */
export function hasTerminalFailedSourceIntakeResponse(value, requestId, fileHash) {
  if (!object(value) || typeof requestId !== "string" || !uuid.test(requestId)
      || typeof fileHash !== "string" || !sha256.test(fileHash)) return false;
  const ai = value;
  const binding = ai.provider_input_binding;
  const response = ai.provider_response;
  const claim = ai.submission_claim_token;
  if (typeof ai.gemini_batch_name !== "string" || !/^batches\/[A-Za-z0-9_-]{1,200}$/.test(ai.gemini_batch_name)
      || ai.possible_external_batch_name !== ai.gemini_batch_name
      || ai.gemini_batch_request_key !== requestId
      || typeof claim !== "string" || !uuid.test(claim) || ai.gemini_spend_attempt_token !== claim
      || typeof ai.provider_batch_returned_at !== "string"
      || !Number.isFinite(Date.parse(ai.provider_batch_returned_at))
      || new Date(ai.provider_batch_returned_at).toISOString() !== ai.provider_batch_returned_at
      || ai.completion_error !== "source_intake_provider_incomplete_ai_response"
      || present(ai.submission_claim_failed_closed_at) || present(ai.publication_claim_token)
      || present(ai.gemini_item_error) || present(ai.parse_error) || present(ai.error)
      || present(ai.completed_at) || present(ai.raw) || present(ai.provider_result_binding)
      || (present(ai.status) && !["failed", "needs_review"].includes(ai.status))
      || ai.model !== model || !object(binding) || binding.schema_version !== 2
      || binding.namespace !== "source-intake-provider-input-v2"
      || binding.request_id !== requestId || binding.retained_capture_sha256 !== fileHash
      || binding.model !== model || typeof binding.digest_sha256 !== "string" || !sha256.test(binding.digest_sha256)
      || !object(response) || present(response.error) || response.modelVersion !== model
      || (present(response.model_version) && response.model_version !== model)
      || !Array.isArray(response.candidates) || response.candidates.length !== 1) return false;
  const candidate = response.candidates[0];
  if (!object(candidate) || present(candidate.error)
      || (candidate.finishReason ?? candidate.finish_reason) !== "MAX_TOKENS"
      || (present(candidate.finishReason) && present(candidate.finish_reason)
        && candidate.finishReason !== candidate.finish_reason)) return false;
  for (const feedback of [response.promptFeedback, response.prompt_feedback]) {
    if (present(feedback) && (!object(feedback) || present(feedback.blockReason) || present(feedback.block_reason))) return false;
  }
  for (const ratings of [candidate.safetyRatings, candidate.safety_ratings]) {
    if (present(ratings) && (!Array.isArray(ratings) || ratings.some((rating) => !object(rating) || rating.blocked === true))) return false;
  }
  const parts = candidate.content?.parts;
  return Array.isArray(parts) && parts.length > 0 && parts.every((part) => object(part)
    && typeof part.text === "string" && part.thought !== true
    && Object.keys(part).every((key) => ["text", "thought", "thoughtSignature"].includes(key)))
    && parts.some((part) => part.text.trim().length > 0);
}
