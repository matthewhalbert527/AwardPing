import { createHash } from "node:crypto";
import { validateRetainedIntakeArtifactManifest } from "./intake-artifact-retention.mjs";

export const SOURCE_INTAKE_PROVIDER_INPUT_BINDING_NAMESPACE =
  "source-intake-provider-input-v2";
export const SOURCE_INTAKE_PROVIDER_RESULT_BINDING_NAMESPACE =
  "source-intake-provider-result-v2";
export const SOURCE_INTAKE_PROVIDER_BINDING_SCHEMA_VERSION = 2;
export const SOURCE_INTAKE_PROVIDER_PROMPT_POLICY = Object.freeze({
  name: "awardping-source-intake-review",
  version: 2,
  system_instruction_version: 1,
  output_schema_version: 1,
  text_excerpt_offset: 0,
  text_excerpt_max_chars: 16_000,
});

const sha256Pattern = /^[0-9a-f]{64}$/;

export class SourceIntakeProviderBindingError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SourceIntakeProviderBindingError";
    this.code = code;
  }
}

/**
 * Builds the immutable evidence identity for one paid source-intake request.
 * The digest deliberately covers the retained response and normalized text,
 * not a mutable URL or the current contents served by that URL.
 */
export function buildSourceIntakeProviderInputBinding({
  request,
  capture,
  deterministicReview,
  providerEnvelope,
  model,
  promptPolicy = SOURCE_INTAKE_PROVIDER_PROMPT_POLICY,
  requireR2Verified = true,
} = {}) {
  const requestId = requiredText(request?.id, "request id");
  const retainedArtifact = validateBoundCapture(requestId, capture, requireR2Verified);
  const providerModel = requiredText(model, "provider model");
  const policy = normalizedPromptPolicy(promptPolicy);
  const envelope = normalizedProviderEnvelope(providerEnvelope, {
    requestId,
    model: providerModel,
  });
  const requestFields = sourceIntakeProviderRequestFields(request);
  const deterministic = jsonValue(deterministicReview, "deterministic review");
  const textExcerpt = sourceIntakeProviderTextExcerpt(capture?.text, policy);
  const systemInstruction = envelope.request.systemInstruction;
  const userPrompt = envelope.request.contents[0].parts[0].text;
  const generationConfig = envelope.request.generationConfig;
  const basis = {
    schema_version: SOURCE_INTAKE_PROVIDER_BINDING_SCHEMA_VERSION,
    namespace: SOURCE_INTAKE_PROVIDER_INPUT_BINDING_NAMESPACE,
    request_id: requestId,
    retained_capture_sha256: retainedArtifact.file_hash,
    normalized_text_sha256: retainedArtifact.text_hash,
    canonical_url: retainedArtifact.canonical_url,
    response_final_url: retainedArtifact.response_final_url,
    content_type: retainedArtifact.document_content_type,
    retained_capture_byte_length: retainedArtifact.file_bytes,
    normalized_text_length: retainedArtifact.text_length,
    captured_at: retainedArtifact.captured_at,
    model: providerModel,
    prompt_policy: policy,
    prompt_policy_sha256: sha256(canonicalJson(policy)),
    request_fields_sha256: sha256(canonicalJson(requestFields)),
    deterministic_review_sha256: sha256(canonicalJson(deterministic)),
    text_excerpt_offset: policy.text_excerpt_offset,
    text_excerpt_length: textExcerpt.length,
    text_excerpt_sha256: sha256(textExcerpt),
    system_instruction_sha256: sha256(canonicalJson(systemInstruction)),
    user_prompt_sha256: sha256(userPrompt),
    generation_config_sha256: sha256(canonicalJson(generationConfig)),
    provider_envelope_sha256: sha256(canonicalJson(envelope)),
    provider_envelope: envelope,
  };
  return {
    ...basis,
    digest_sha256: sha256(canonicalJson(basis)),
  };
}

export function validateSourceIntakeProviderInputBinding(
  value,
  { request, capture, deterministicReview, requireR2Verified = true } = {},
) {
  const actual = normalizedInputBinding(value);
  const expected = buildSourceIntakeProviderInputBinding({
    request,
    capture,
    deterministicReview,
    providerEnvelope: actual.provider_envelope,
    model: actual.model,
    promptPolicy: actual.prompt_policy,
    requireR2Verified,
  });
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    refuse(
      "source_intake_provider_input_binding_mismatch",
      "The paid-review input binding does not match the immutable retained capture.",
    );
  }
  return expected;
}

/**
 * Seals a parsed provider result to the exact paid input and provider Batch
 * identity. The result hash prevents a later JSON replacement from inheriting
 * the original capture binding.
 */
export function buildSourceIntakeProviderResultBinding({
  request,
  capture,
  deterministicReview,
  inputBinding,
  rawResult,
  batchName,
  batchRequestKey,
  model,
  acceptedAt = new Date().toISOString(),
} = {}) {
  const requestId = requiredText(request?.id, "request id");
  const input = validateSourceIntakeProviderInputBinding(inputBinding, {
    request,
    capture,
    deterministicReview,
  });
  const providerBatchName = requiredText(batchName, "provider Batch name");
  const providerBatchRequestKey = requiredText(batchRequestKey, "provider Batch request key");
  if (providerBatchRequestKey !== requestId) {
    refuse(
      "source_intake_provider_result_request_key_mismatch",
      "The provider result request key does not equal the source-intake request id.",
    );
  }
  const providerModel = requiredText(model, "provider model");
  if (providerModel !== input.model) {
    refuse(
      "source_intake_provider_result_model_mismatch",
      "The provider result model does not match the immutable paid-input envelope.",
    );
  }
  const providerResult = objectValue(rawResult);
  if (!Object.keys(providerResult).length) {
    refuse(
      "source_intake_provider_result_missing",
      "The provider result cannot be bound because its parsed JSON is missing.",
    );
  }
  const basis = {
    schema_version: SOURCE_INTAKE_PROVIDER_BINDING_SCHEMA_VERSION,
    namespace: SOURCE_INTAKE_PROVIDER_RESULT_BINDING_NAMESPACE,
    request_id: requestId,
    input_digest_sha256: input.digest_sha256,
    provider_batch_name: providerBatchName,
    provider_batch_request_key: providerBatchRequestKey,
    model: providerModel,
    provider_result_sha256: sha256(canonicalJson(providerResult)),
    accepted_at: canonicalTimestamp(acceptedAt, "provider result accepted_at"),
  };
  return {
    ...basis,
    digest_sha256: sha256(canonicalJson(basis)),
  };
}

/**
 * Recomputes every capture and result digest before a $0 replay. Historical
 * rows without these seals are intentionally rejected; inventing a seal after
 * the paid call would misstate what the provider actually reviewed.
 */
export function validateSourceIntakeProviderReplayBinding({
  request,
  capture,
  deterministicReview,
  storedReview,
  rawResult = null,
  requireR2Verified = true,
} = {}) {
  const review = objectValue(storedReview);
  const inputBinding = validateSourceIntakeProviderInputBinding(
    review.provider_input_binding,
    { request, capture, deterministicReview, requireR2Verified },
  );
  const resultBinding = normalizedResultBinding(review.provider_result_binding);
  const expectedResultBinding = buildSourceIntakeProviderResultBinding({
    request,
    capture,
    deterministicReview,
    inputBinding,
    rawResult: rawResult || review.raw,
    batchName: review.gemini_batch_name,
    batchRequestKey: review.gemini_batch_request_key,
    model: review.model,
    acceptedAt: resultBinding.accepted_at,
  });
  if (canonicalJson(resultBinding) !== canonicalJson(expectedResultBinding)) {
    refuse(
      "source_intake_provider_result_binding_mismatch",
      "The stored provider result is not sealed to the exact retained capture and Batch request.",
    );
  }
  return {
    capture: {
      ...capture,
      retained_artifact: validateRetainedIntakeArtifactManifest(capture?.retained_artifact, {
        requestId: request?.id,
        fileHash: capture?.capture_file_hash,
        finalUrl: capture?.canonical_url || capture?.final_url,
        requireR2Verified,
      }),
    },
    inputBinding,
    resultBinding: expectedResultBinding,
  };
}

export function isSourceIntakeProviderBindingError(error) {
  return error instanceof SourceIntakeProviderBindingError
    || /^(?:source_intake_provider_|intake_artifact_)/.test(String(error?.code || ""));
}

function validateBoundCapture(requestId, capture, requireR2Verified) {
  const fileHash = requiredSha256(capture?.capture_file_hash, "capture file hash");
  const canonicalUrl = absoluteHttpUrl(
    capture?.canonical_url || capture?.final_url,
    "capture canonical URL",
  );
  const responseFinalUrl = absoluteHttpUrl(
    capture?.final_url || capture?.canonical_url,
    "capture response URL",
  );
  const retainedArtifact = validateRetainedIntakeArtifactManifest(capture?.retained_artifact, {
    requestId,
    fileHash,
    finalUrl: canonicalUrl,
    requireR2Verified,
  });
  const normalizedText = canonicalCapturedText(capture?.text);
  const capturedAt = canonicalTimestamp(capture?.captured_at, "capture captured_at");
  const contentType = cleanContentType(capture?.content_type);
  const byteLength = Number(capture?.byte_length);
  if (
    retainedArtifact.file_hash !== fileHash
    || retainedArtifact.text_hash !== sha256(normalizedText)
    || retainedArtifact.text_length !== normalizedText.length
    || retainedArtifact.canonical_url !== canonicalUrl
    || retainedArtifact.response_final_url !== responseFinalUrl
    || retainedArtifact.document_content_type !== contentType
    || retainedArtifact.file_bytes !== byteLength
    || retainedArtifact.captured_at !== capturedAt
  ) {
    refuse(
      "source_intake_provider_capture_binding_mismatch",
      "The capture text, bytes, timestamp, content type, or URLs do not match the immutable retained artifact.",
    );
  }
  return retainedArtifact;
}

function normalizedInputBinding(value) {
  const binding = objectValue(value);
  const schemaVersion = Number(binding.schema_version);
  if (
    schemaVersion !== SOURCE_INTAKE_PROVIDER_BINDING_SCHEMA_VERSION
    || cleanText(binding.namespace) !== SOURCE_INTAKE_PROVIDER_INPUT_BINDING_NAMESPACE
  ) {
    refuse(
      "source_intake_provider_input_binding_missing",
      "This provider result has no supported paid-input binding. Historical unbound results cannot be replayed or approved as if they were sealed.",
    );
  }
  return {
    schema_version: schemaVersion,
    namespace: SOURCE_INTAKE_PROVIDER_INPUT_BINDING_NAMESPACE,
    request_id: requiredText(binding.request_id, "bound request id"),
    retained_capture_sha256: requiredSha256(
      binding.retained_capture_sha256,
      "bound retained capture hash",
    ),
    normalized_text_sha256: requiredSha256(
      binding.normalized_text_sha256,
      "bound normalized text hash",
    ),
    canonical_url: absoluteHttpUrl(binding.canonical_url, "bound canonical URL"),
    response_final_url: absoluteHttpUrl(binding.response_final_url, "bound response URL"),
    content_type: cleanContentType(binding.content_type),
    retained_capture_byte_length: nonNegativeSafeInteger(
      binding.retained_capture_byte_length,
      "bound capture byte length",
    ),
    normalized_text_length: nonNegativeSafeInteger(
      binding.normalized_text_length,
      "bound normalized text length",
    ),
    captured_at: canonicalTimestamp(binding.captured_at, "bound captured_at"),
    model: requiredText(binding.model, "bound provider model"),
    prompt_policy: normalizedPromptPolicy(binding.prompt_policy),
    prompt_policy_sha256: requiredSha256(
      binding.prompt_policy_sha256,
      "bound prompt policy hash",
    ),
    request_fields_sha256: requiredSha256(
      binding.request_fields_sha256,
      "bound request-fields hash",
    ),
    deterministic_review_sha256: requiredSha256(
      binding.deterministic_review_sha256,
      "bound deterministic-review hash",
    ),
    text_excerpt_offset: nonNegativeSafeInteger(
      binding.text_excerpt_offset,
      "bound text excerpt offset",
    ),
    text_excerpt_length: nonNegativeSafeInteger(
      binding.text_excerpt_length,
      "bound text excerpt length",
    ),
    text_excerpt_sha256: requiredSha256(
      binding.text_excerpt_sha256,
      "bound text excerpt hash",
    ),
    system_instruction_sha256: requiredSha256(
      binding.system_instruction_sha256,
      "bound system-instruction hash",
    ),
    user_prompt_sha256: requiredSha256(
      binding.user_prompt_sha256,
      "bound user-prompt hash",
    ),
    generation_config_sha256: requiredSha256(
      binding.generation_config_sha256,
      "bound generation-config hash",
    ),
    provider_envelope_sha256: requiredSha256(
      binding.provider_envelope_sha256,
      "bound provider-envelope hash",
    ),
    provider_envelope: normalizedProviderEnvelope(binding.provider_envelope, {
      requestId: binding.request_id,
      model: binding.model,
    }),
    digest_sha256: requiredSha256(binding.digest_sha256, "paid-input binding digest"),
  };
}

function normalizedResultBinding(value) {
  const binding = objectValue(value);
  const schemaVersion = Number(binding.schema_version);
  if (
    schemaVersion !== SOURCE_INTAKE_PROVIDER_BINDING_SCHEMA_VERSION
    || cleanText(binding.namespace) !== SOURCE_INTAKE_PROVIDER_RESULT_BINDING_NAMESPACE
  ) {
    refuse(
      "source_intake_provider_result_binding_missing",
      "This stored provider result has no supported result binding. Historical unbound results cannot be replayed or approved as sealed evidence.",
    );
  }
  return {
    schema_version: schemaVersion,
    namespace: SOURCE_INTAKE_PROVIDER_RESULT_BINDING_NAMESPACE,
    request_id: requiredText(binding.request_id, "result-bound request id"),
    input_digest_sha256: requiredSha256(
      binding.input_digest_sha256,
      "result-bound input digest",
    ),
    provider_batch_name: requiredText(binding.provider_batch_name, "result-bound Batch name"),
    provider_batch_request_key: requiredText(
      binding.provider_batch_request_key,
      "result-bound request key",
    ),
    model: requiredText(binding.model, "result-bound model"),
    provider_result_sha256: requiredSha256(
      binding.provider_result_sha256,
      "provider result hash",
    ),
    accepted_at: canonicalTimestamp(binding.accepted_at, "result accepted_at"),
    digest_sha256: requiredSha256(binding.digest_sha256, "provider-result binding digest"),
  };
}

export function sourceIntakeProviderCaptureIdentity(
  request,
  capture,
  { requireR2Verified = true } = {},
) {
  const requestId = requiredText(request?.id, "request id");
  const retainedArtifact = validateBoundCapture(requestId, capture, requireR2Verified);
  return {
    request_id: requestId,
    retained_capture_sha256: retainedArtifact.file_hash,
    normalized_text_sha256: retainedArtifact.text_hash,
    canonical_url: retainedArtifact.canonical_url,
    response_final_url: retainedArtifact.response_final_url,
    content_type: retainedArtifact.document_content_type,
    retained_capture_byte_length: retainedArtifact.file_bytes,
    normalized_text_length: retainedArtifact.text_length,
    captured_at: retainedArtifact.captured_at,
  };
}

export function sourceIntakeProviderRequestFields(request) {
  return {
    id: requiredText(request?.id, "request id"),
    requested_award_name: cleanNullable(request?.award_name),
    notes: cleanNullable(request?.notes),
    submitted_url: requiredText(
      request?.submitted_url || request?.homepage_url,
      "submitted request URL",
    ),
    normalized_url: requiredText(request?.normalized_url, "normalized request URL"),
    intake_type: cleanText(request?.intake_type) || "unknown",
  };
}

export function sourceIntakeProviderTextExcerpt(
  value,
  promptPolicy = SOURCE_INTAKE_PROVIDER_PROMPT_POLICY,
) {
  const policy = normalizedPromptPolicy(promptPolicy);
  const normalized = String(value || "")
    .replace(/\u0000/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.slice(
    policy.text_excerpt_offset,
    policy.text_excerpt_offset + policy.text_excerpt_max_chars,
  );
}

function normalizedPromptPolicy(value) {
  const policy = objectValue(value);
  const normalized = {
    name: requiredText(policy.name, "prompt policy name"),
    version: positiveSafeInteger(policy.version, "prompt policy version"),
    system_instruction_version: positiveSafeInteger(
      policy.system_instruction_version,
      "system-instruction version",
    ),
    output_schema_version: positiveSafeInteger(
      policy.output_schema_version,
      "output-schema version",
    ),
    text_excerpt_offset: nonNegativeSafeInteger(
      policy.text_excerpt_offset,
      "prompt text excerpt offset",
    ),
    text_excerpt_max_chars: positiveSafeInteger(
      policy.text_excerpt_max_chars,
      "prompt text excerpt maximum",
    ),
  };
  if (canonicalJson(normalized) !== canonicalJson(SOURCE_INTAKE_PROVIDER_PROMPT_POLICY)) {
    refuse(
      "source_intake_provider_prompt_policy_unsupported",
      "The paid-review prompt policy is not the supported v2 policy.",
    );
  }
  return normalized;
}

function normalizedProviderEnvelope(value, { requestId, model } = {}) {
  const envelope = jsonValue(value, "provider envelope");
  const request = objectValue(envelope.request);
  const metadata = objectValue(envelope.metadata);
  const systemInstruction = objectValue(request.systemInstruction);
  const systemParts = Array.isArray(systemInstruction.parts) ? systemInstruction.parts : [];
  const contents = Array.isArray(request.contents) ? request.contents : [];
  const firstContent = objectValue(contents[0]);
  const userParts = Array.isArray(firstContent.parts) ? firstContent.parts : [];
  const generationConfig = objectValue(request.generationConfig);
  if (
    systemParts.length !== 1
    || !requiredText(objectValue(systemParts[0]).text, "provider system instruction")
    || contents.length !== 1
    || cleanText(firstContent.role) !== "user"
    || userParts.length !== 1
    || !requiredText(objectValue(userParts[0]).text, "provider user prompt")
    || !Object.keys(generationConfig).length
    || cleanText(metadata.key) !== requiredText(requestId, "provider request id")
    || cleanText(metadata.source_page_request_id) !== requiredText(requestId, "provider request id")
    || cleanText(metadata.model) !== requiredText(model, "provider model")
  ) {
    refuse(
      "source_intake_provider_envelope_invalid",
      "The stored paid-review provider envelope is incomplete or bound to another request/model.",
    );
  }
  return envelope;
}

function canonicalCapturedText(value) {
  return String(value || "").replace(/\u0000/g, "").trim();
}

function cleanContentType(value) {
  const contentType = requiredText(value, "capture content type").toLowerCase();
  const mediaType = contentType.split(";", 1)[0].trim();
  if (
    contentType.length > 255
    || /[\r\n]/.test(contentType)
    || /[^\x20-\x7e]/.test(contentType)
    || !/^[A-Za-z0-9!#$%&'*+.^_`|~-]+\/[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(mediaType)
  ) {
    refuse(
      "source_intake_provider_content_type_invalid",
      "The capture content type cannot be included in a provider binding.",
    );
  }
  return contentType;
}

function absoluteHttpUrl(value, label) {
  try {
    const parsed = new URL(requiredText(value, label));
    if (
      !["http:", "https:"].includes(parsed.protocol)
      || !parsed.host
      || parsed.username
      || parsed.password
    ) {
      throw new Error("invalid public URL");
    }
    return parsed.toString();
  } catch {
    refuse(
      "source_intake_provider_url_invalid",
      `${label} is not a public absolute HTTP(S) URL.`,
    );
  }
}

function canonicalTimestamp(value, label) {
  const parsed = Date.parse(cleanText(value));
  if (!Number.isFinite(parsed)) {
    refuse("source_intake_provider_timestamp_invalid", `${label} is not a timestamp.`);
  }
  return new Date(parsed).toISOString();
}

function nonNegativeSafeInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    refuse("source_intake_provider_length_invalid", `${label} is invalid.`);
  }
  return number;
}

function positiveSafeInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    refuse("source_intake_provider_length_invalid", `${label} is invalid.`);
  }
  return number;
}

function requiredSha256(value, label) {
  const hash = requiredText(value, label).toLowerCase();
  if (!sha256Pattern.test(hash)) {
    refuse("source_intake_provider_hash_invalid", `${label} is not SHA-256.`);
  }
  return hash;
}

function requiredText(value, label) {
  const text = cleanText(value);
  if (!text) refuse("source_intake_provider_field_missing", `${label} is required.`);
  return text;
}

function cleanText(value) {
  return String(value ?? "").trim();
}

function cleanNullable(value) {
  const text = cleanText(value);
  return text || null;
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function jsonValue(value, label) {
  try {
    const serialized = JSON.stringify(value);
    if (!serialized) throw new Error("missing JSON");
    const parsed = JSON.parse(serialized);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("expected object");
    }
    return parsed;
  } catch {
    refuse(
      "source_intake_provider_json_invalid",
      `${label} is not a JSON object.`,
    );
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  return JSON.stringify(sortJson(value));
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, sortJson(value[key])]),
  );
}

function refuse(code, message) {
  throw new SourceIntakeProviderBindingError(code, message);
}
