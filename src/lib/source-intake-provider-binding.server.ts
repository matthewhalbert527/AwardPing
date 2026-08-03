import { createHash } from "node:crypto";

const inputNamespace = "source-intake-provider-input-v2";
const resultNamespace = "source-intake-provider-result-v2";
const retainedNamespace = "source-intake-first-observation";
const sha256Pattern = /^[0-9a-f]{64}$/;
const promptPolicy = Object.freeze({
  name: "awardping-source-intake-review",
  version: 2,
  system_instruction_version: 1,
  output_schema_version: 1,
  text_excerpt_offset: 0,
  text_excerpt_max_chars: 16_000,
});

export class SourceIntakeProviderBindingValidationError extends Error {
  readonly status: 400 | 409;

  constructor(message: string, status: 400 | 409 = 409) {
    super(message);
    this.name = "SourceIntakeProviderBindingValidationError";
    this.status = status;
  }
}

type ProviderInputBinding = {
  schema_version: 2;
  namespace: typeof inputNamespace;
  request_id: string;
  retained_capture_sha256: string;
  normalized_text_sha256: string;
  canonical_url: string;
  response_final_url: string;
  content_type: string;
  retained_capture_byte_length: number;
  normalized_text_length: number;
  captured_at: string;
  model: string;
  prompt_policy: typeof promptPolicy;
  prompt_policy_sha256: string;
  request_fields_sha256: string;
  deterministic_review_sha256: string;
  text_excerpt_offset: number;
  text_excerpt_length: number;
  text_excerpt_sha256: string;
  system_instruction_sha256: string;
  user_prompt_sha256: string;
  generation_config_sha256: string;
  provider_envelope_sha256: string;
  provider_envelope: Record<string, unknown>;
  digest_sha256: string;
};

type ProviderResultBinding = {
  schema_version: 2;
  namespace: typeof resultNamespace;
  request_id: string;
  input_digest_sha256: string;
  provider_batch_name: string;
  provider_batch_request_key: string;
  model: string;
  provider_result_sha256: string;
  accepted_at: string;
  digest_sha256: string;
};

export function verifySourceIntakeProviderBindingForAdminApproval({
  request,
  deterministicReview,
  captureMetadata,
  aiReview,
  requireBackfillEvidence = false,
}: {
  request: Record<string, unknown> & { id: string };
  deterministicReview: unknown;
  captureMetadata: unknown;
  aiReview: unknown;
  requireBackfillEvidence?: boolean;
}) {
  const requestId = requiredText(request?.id, "request id");
  const capture = objectValue(captureMetadata);
  const review = objectValue(aiReview);
  const raw = objectValue(review.raw);
  if (cleanText(review.status) !== "accepted" || cleanText(raw.status) !== "accepted") {
    throw new SourceIntakeProviderBindingValidationError("Operator approval requires a stored accepted provider result.");
  }
  const backfillEvidence = objectValue(review.backfill_discovery_evidence);
  const backfillEvidenceSha256 = Object.keys(backfillEvidence).length
    ? verifiedBackfillEvidenceSha256(backfillEvidence)
    : null;
  if (requireBackfillEvidence && !backfillEvidenceSha256) {
    throw new SourceIntakeProviderBindingValidationError("Backfill source approval requires complete hash-bound discovery evidence.");
  }

  const storedInput = normalizedInputBinding(review.provider_input_binding);
  const expectedInput = buildExpectedInputBinding(
    request,
    deterministicReview,
    capture,
    storedInput,
  );
  if (canonicalJson(storedInput) !== canonicalJson(expectedInput)) {
    throw new SourceIntakeProviderBindingValidationError(
      "The paid-review input binding does not match the immutable retained capture.",
    );
  }

  const storedResult = normalizedResultBinding(review.provider_result_binding);
  const providerModel = requiredText(review.model, "provider model");
  if (providerModel !== expectedInput.model) {
    throw new SourceIntakeProviderBindingValidationError("The provider result model does not match the immutable paid-input envelope.");
  }
  const resultBasis = {
    schema_version: 2 as const,
    namespace: "source-intake-provider-result-v2" as const,
    request_id: requestId,
    input_digest_sha256: expectedInput.digest_sha256,
    provider_batch_name: requiredText(review.gemini_batch_name, "provider Batch name"),
    provider_batch_request_key: requiredText(
      review.gemini_batch_request_key,
      "provider Batch request key",
    ),
    model: providerModel,
    provider_result_sha256: sha256(canonicalJson(raw)),
    accepted_at: canonicalTimestamp(storedResult.accepted_at, "provider result accepted_at"),
  };
  if (resultBasis.provider_batch_request_key !== requestId) {
    throw new SourceIntakeProviderBindingValidationError("The provider result request key does not equal the source-intake request id.");
  }
  const expectedResult: ProviderResultBinding = {
    ...resultBasis,
    digest_sha256: sha256(canonicalJson(resultBasis)),
  };
  if (canonicalJson(storedResult) !== canonicalJson(expectedResult)) {
    throw new SourceIntakeProviderBindingValidationError(
      "The stored provider result is not sealed to the exact retained capture and Batch request.",
    );
  }
  return {
    capture,
    inputBinding: expectedInput,
    resultBinding: expectedResult,
    backfillEvidenceSha256,
  };
}

function verifiedBackfillEvidenceSha256(value: unknown) {
  const evidence = objectValue(value);
  const normalizedText = (input: unknown) => String(input ?? "").replace(/\s+/g, " ").trim();
  const nullableText = (input: unknown) => normalizedText(input) || null;
  const finiteNumber = (input: unknown) => {
    if (input === null || input === undefined || normalizedText(input) === "") return null;
    const number = Number(input);
    return Number.isFinite(number) ? number : null;
  };
  const positiveInteger = (input: unknown) => {
    const number = Math.trunc(Number(input));
    return Number.isFinite(number) && number > 0 ? number : null;
  };
  const basis = {
    schema_version: Number(evidence.schema_version),
    policy_version: normalizedText(evidence.policy_version),
    discovery_method: normalizedText(evidence.discovery_method),
    matched_shared_award_id: normalizedText(evidence.matched_shared_award_id),
    matched_award_name: normalizedText(evidence.matched_award_name),
    submitted_url: normalizedText(evidence.submitted_url),
    normalized_url: normalizedText(evidence.normalized_url),
    candidate_title: nullableText(evidence.candidate_title),
    candidate_page_type: normalizedText(evidence.candidate_page_type) || "other",
    candidate_score: finiteNumber(evidence.candidate_score),
    candidate_confidence: finiteNumber(evidence.candidate_confidence),
    search_query: nullableText(evidence.search_query),
    search_rank: positiveInteger(evidence.search_rank),
    verification: nullableText(evidence.verification),
    discovery_reason: nullableText(evidence.discovery_reason),
    paid_lane: normalizedText(evidence.paid_lane),
    source_activation: normalizedText(evidence.source_activation),
    notification_after_approval: normalizedText(evidence.notification_after_approval),
  };
  const evidenceHash = requiredSha256(
    evidence.evidence_sha256,
    "backfill discovery evidence hash",
  );
  if (
    basis.schema_version !== 1
    || basis.policy_version !== "low-coverage-source-backfill-v1"
    || basis.discovery_method !== "low_coverage_official_source_search"
    || !basis.matched_shared_award_id
    || !basis.matched_award_name
    || !basis.submitted_url
    || !basis.normalized_url
    || basis.paid_lane !== "new_page_review"
    || basis.source_activation !== "manual_only"
    || basis.notification_after_approval !== "baseline_only"
    || sha256(canonicalJson(basis)) !== evidenceHash
  ) {
    throw new SourceIntakeProviderBindingValidationError(
      "The low-coverage discovery evidence or its activation policy fields were changed after discovery.",
    );
  }
  return evidenceHash;
}

function buildExpectedInputBinding(
  request: Record<string, unknown> & { id: string },
  deterministicReview: unknown,
  capture: Record<string, unknown>,
  stored: ProviderInputBinding,
): ProviderInputBinding {
  const requestId = requiredText(request.id, "request id");
  const artifact = objectValue(capture.retained_artifact);
  const fileHash = requiredSha256(capture.capture_file_hash, "capture file hash");
  const canonicalUrl = absoluteHttpUrl(
    capture.canonical_url || capture.final_url,
    "capture canonical URL",
  );
  const responseFinalUrl = absoluteHttpUrl(
    capture.final_url || capture.canonical_url,
    "capture response URL",
  );
  const normalizedText = canonicalCapturedText(capture.text);
  const textHash = sha256(normalizedText);
  const contentType = cleanContentType(capture.content_type);
  const capturedAt = canonicalTimestamp(capture.captured_at, "capture captured_at");
  const byteLength = nonNegativeSafeInteger(capture.byte_length, "capture byte length");
  const textLength = normalizedText.length;
  const prefix = `${retainedNamespace}/v1/requests/${requestId}/sha256/${fileHash}`;
  const artifacts = objectValue(artifact.artifacts);
  const document = objectValue(artifacts.pdf);
  const text = objectValue(artifacts.text);
  const metadata = objectValue(artifacts.capture_metadata);
  const r2VerifiedAt = canonicalTimestamp(artifact.r2_verified_at, "retained R2 verified_at");
  const r2Bucket = cleanText(artifact.r2_bucket);
  const r2StoreId = cleanText(artifact.r2_store_id).toLowerCase();
  if (
    Number(artifact.schema_version) !== 1
    || cleanText(artifact.namespace) !== retainedNamespace
    || cleanText(artifact.request_id) !== requestId
    || cleanText(artifact.prefix) !== prefix
    || requiredSha256(artifact.file_hash, "retained capture hash") !== fileHash
    || absoluteHttpUrl(artifact.canonical_url || artifact.final_url, "retained canonical URL") !== canonicalUrl
    || absoluteHttpUrl(artifact.response_final_url || artifact.final_url, "retained response URL") !== responseFinalUrl
    || cleanContentType(artifact.document_content_type || "application/pdf") !== contentType
    || nonNegativeSafeInteger(artifact.file_bytes, "retained byte length") !== byteLength
    || requiredSha256(artifact.text_hash, "retained text hash") !== textHash
    || nonNegativeSafeInteger(artifact.text_length, "retained text length") !== textLength
    || canonicalTimestamp(artifact.captured_at, "retained captured_at") !== capturedAt
    || r2Bucket.length > 255
    || !/^[a-z0-9][a-z0-9._-]*$/i.test(r2Bucket)
    || r2StoreId.length > 255
    || !/^[a-z0-9][a-z0-9.:-]*$/i.test(r2StoreId)
    || !r2VerifiedAt
    || cleanText(document.key) !== `${prefix}/document.pdf`
    || requiredSha256(document.sha256, "retained document hash") !== fileHash
    || nonNegativeSafeInteger(document.byte_length, "retained document byte length") !== byteLength
    || cleanContentType(document.content_type) !== contentType
    || !validArtifactRole(text, `${prefix}/text.txt`, "text/plain; charset=utf-8")
    || !validArtifactRole(metadata, `${prefix}/capture.json`, "application/json")
  ) {
    throw new SourceIntakeProviderBindingValidationError(
      "The capture text, bytes, timestamp, content type, URLs, or R2 manifest do not match the immutable retained artifact.",
    );
  }
  const policy = normalizedPromptPolicy(stored.prompt_policy);
  const envelope = normalizedProviderEnvelope(stored.provider_envelope, {
    requestId,
    model: stored.model,
  });
  const requestFields = providerRequestFields(request);
  const deterministic = jsonObject(deterministicReview, "deterministic review");
  const excerpt = providerTextExcerpt(capture.text, policy);
  const envelopeRequest = objectValue(envelope.request);
  const systemInstruction = objectValue(envelopeRequest.systemInstruction);
  const contents = Array.isArray(envelopeRequest.contents) ? envelopeRequest.contents : [];
  const firstContent = objectValue(contents[0]);
  const userParts = Array.isArray(firstContent.parts) ? firstContent.parts : [];
  const userPrompt = requiredText(objectValue(userParts[0]).text, "provider user prompt");
  const generationConfig = objectValue(envelopeRequest.generationConfig);
  const basis = {
    schema_version: 2 as const,
    namespace: "source-intake-provider-input-v2" as const,
    request_id: requestId,
    retained_capture_sha256: fileHash,
    normalized_text_sha256: textHash,
    canonical_url: canonicalUrl,
    response_final_url: responseFinalUrl,
    content_type: contentType,
    retained_capture_byte_length: byteLength,
    normalized_text_length: textLength,
    captured_at: capturedAt,
    model: requiredText(stored.model, "bound provider model"),
    prompt_policy: policy,
    prompt_policy_sha256: sha256(canonicalJson(policy)),
    request_fields_sha256: sha256(canonicalJson(requestFields)),
    deterministic_review_sha256: sha256(canonicalJson(deterministic)),
    text_excerpt_offset: policy.text_excerpt_offset,
    text_excerpt_length: excerpt.length,
    text_excerpt_sha256: sha256(excerpt),
    system_instruction_sha256: sha256(canonicalJson(systemInstruction)),
    user_prompt_sha256: sha256(userPrompt),
    generation_config_sha256: sha256(canonicalJson(generationConfig)),
    provider_envelope_sha256: sha256(canonicalJson(envelope)),
    provider_envelope: envelope,
  };
  return { ...basis, digest_sha256: sha256(canonicalJson(basis)) };
}

function normalizedInputBinding(value: unknown): ProviderInputBinding {
  const binding = objectValue(value);
  if (Number(binding.schema_version) !== 2 || cleanText(binding.namespace) !== inputNamespace) {
    throw new SourceIntakeProviderBindingValidationError(
      "This provider result has no supported paid-input binding. Historical unbound results cannot be approved as sealed evidence.",
    );
  }
  return {
    schema_version: 2,
    namespace: inputNamespace,
    request_id: requiredText(binding.request_id, "bound request id"),
    retained_capture_sha256: requiredSha256(binding.retained_capture_sha256, "bound capture hash"),
    normalized_text_sha256: requiredSha256(binding.normalized_text_sha256, "bound text hash"),
    canonical_url: absoluteHttpUrl(binding.canonical_url, "bound canonical URL"),
    response_final_url: absoluteHttpUrl(binding.response_final_url, "bound response URL"),
    content_type: cleanContentType(binding.content_type),
    retained_capture_byte_length: nonNegativeSafeInteger(binding.retained_capture_byte_length, "bound capture length"),
    normalized_text_length: nonNegativeSafeInteger(binding.normalized_text_length, "bound text length"),
    captured_at: canonicalTimestamp(binding.captured_at, "bound captured_at"),
    model: requiredText(binding.model, "bound provider model"),
    prompt_policy: normalizedPromptPolicy(binding.prompt_policy),
    prompt_policy_sha256: requiredSha256(binding.prompt_policy_sha256, "bound prompt policy hash"),
    request_fields_sha256: requiredSha256(binding.request_fields_sha256, "bound request-fields hash"),
    deterministic_review_sha256: requiredSha256(binding.deterministic_review_sha256, "bound deterministic-review hash"),
    text_excerpt_offset: nonNegativeSafeInteger(binding.text_excerpt_offset, "bound text excerpt offset"),
    text_excerpt_length: nonNegativeSafeInteger(binding.text_excerpt_length, "bound text excerpt length"),
    text_excerpt_sha256: requiredSha256(binding.text_excerpt_sha256, "bound text excerpt hash"),
    system_instruction_sha256: requiredSha256(binding.system_instruction_sha256, "bound system-instruction hash"),
    user_prompt_sha256: requiredSha256(binding.user_prompt_sha256, "bound user-prompt hash"),
    generation_config_sha256: requiredSha256(binding.generation_config_sha256, "bound generation-config hash"),
    provider_envelope_sha256: requiredSha256(binding.provider_envelope_sha256, "bound provider-envelope hash"),
    provider_envelope: normalizedProviderEnvelope(binding.provider_envelope, {
      requestId: binding.request_id,
      model: binding.model,
    }),
    digest_sha256: requiredSha256(binding.digest_sha256, "bound input digest"),
  };
}

function normalizedResultBinding(value: unknown): ProviderResultBinding {
  const binding = objectValue(value);
  if (Number(binding.schema_version) !== 2 || cleanText(binding.namespace) !== resultNamespace) {
    throw new SourceIntakeProviderBindingValidationError(
      "This stored provider result has no supported result binding. Historical unbound results cannot be approved as sealed evidence.",
    );
  }
  return {
    schema_version: 2,
    namespace: resultNamespace,
    request_id: requiredText(binding.request_id, "result-bound request id"),
    input_digest_sha256: requiredSha256(binding.input_digest_sha256, "result-bound input digest"),
    provider_batch_name: requiredText(binding.provider_batch_name, "result-bound Batch name"),
    provider_batch_request_key: requiredText(binding.provider_batch_request_key, "result-bound request key"),
    model: requiredText(binding.model, "result-bound model"),
    provider_result_sha256: requiredSha256(binding.provider_result_sha256, "provider result hash"),
    accepted_at: canonicalTimestamp(binding.accepted_at, "result accepted_at"),
    digest_sha256: requiredSha256(binding.digest_sha256, "provider-result binding digest"),
  };
}

function normalizedPromptPolicy(value: unknown): typeof promptPolicy {
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
  if (canonicalJson(normalized) !== canonicalJson(promptPolicy)) {
    throw new SourceIntakeProviderBindingValidationError("The paid-review prompt policy is not the supported v2 policy.");
  }
  return normalized as typeof promptPolicy;
}

function normalizedProviderEnvelope(
  value: unknown,
  { requestId, model }: { requestId: unknown; model: unknown },
) {
  const envelope = jsonObject(value, "provider envelope");
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
    throw new SourceIntakeProviderBindingValidationError(
      "The stored paid-review provider envelope is incomplete or bound to another request/model.",
    );
  }
  return envelope;
}

function providerRequestFields(request: Record<string, unknown> & { id: string }) {
  return {
    id: requiredText(request.id, "request id"),
    requested_award_name: cleanNullable(request.award_name),
    notes: cleanNullable(request.notes),
    submitted_url: requiredText(
      request.submitted_url || request.homepage_url,
      "submitted request URL",
    ),
    normalized_url: requiredText(request.normalized_url, "normalized request URL"),
    intake_type: cleanText(request.intake_type) || "unknown",
  };
}

function providerTextExcerpt(value: unknown, policy: typeof promptPolicy) {
  const normalized = String(value || "")
    .replace(/\u0000/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.slice(
    policy.text_excerpt_offset,
    policy.text_excerpt_offset + policy.text_excerpt_max_chars,
  );
}

function validArtifactRole(
  artifact: Record<string, unknown>,
  key: string,
  contentType: string,
) {
  return cleanText(artifact.key) === key
    && sha256Pattern.test(cleanText(artifact.sha256).toLowerCase())
    && nonNegativeSafeInteger(artifact.byte_length, "retained artifact length") >= 0
    && cleanText(artifact.content_type).toLowerCase() === contentType;
}

function canonicalCapturedText(value: unknown) {
  return String(value || "").replace(/\u0000/g, "").trim();
}

function cleanContentType(value: unknown) {
  const contentType = requiredText(value, "capture content type").toLowerCase();
  const mediaType = contentType.split(";", 1)[0].trim();
  if (
    contentType.length > 255
    || /[\r\n]/.test(contentType)
    || /[^\x20-\x7e]/.test(contentType)
    || !/^[A-Za-z0-9!#$%&'*+.^_`|~-]+\/[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(mediaType)
  ) {
    throw new SourceIntakeProviderBindingValidationError("The capture content type cannot be included in a provider binding.");
  }
  return contentType;
}

function absoluteHttpUrl(value: unknown, label: string) {
  try {
    const parsed = new URL(requiredText(value, label));
    if (!new Set(["http:", "https:"]).has(parsed.protocol) || parsed.username || parsed.password) {
      throw new SourceIntakeProviderBindingValidationError("unsafe URL");
    }
    return parsed.toString();
  } catch {
    throw new SourceIntakeProviderBindingValidationError(`${label} is not a public absolute HTTP(S) URL.`);
  }
}

function canonicalTimestamp(value: unknown, label: string) {
  const parsed = Date.parse(cleanText(value));
  if (!Number.isFinite(parsed)) throw new SourceIntakeProviderBindingValidationError(`${label} is not a timestamp.`);
  return new Date(parsed).toISOString();
}

function nonNegativeSafeInteger(value: unknown, label: string) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new SourceIntakeProviderBindingValidationError(`${label} is invalid.`);
  return number;
}

function positiveSafeInteger(value: unknown, label: string) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new SourceIntakeProviderBindingValidationError(`${label} is invalid.`);
  return number;
}

function requiredSha256(value: unknown, label: string) {
  const hash = requiredText(value, label).toLowerCase();
  if (!sha256Pattern.test(hash)) throw new SourceIntakeProviderBindingValidationError(`${label} is not SHA-256.`);
  return hash;
}

function requiredText(value: unknown, label: string) {
  const text = cleanText(value);
  if (!text) throw new SourceIntakeProviderBindingValidationError(`${label} is required.`);
  return text;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function jsonObject(value: unknown, label: string): Record<string, unknown> {
  try {
    const serialized = JSON.stringify(value);
    if (!serialized) throw new SourceIntakeProviderBindingValidationError("missing JSON");
    const parsed = JSON.parse(serialized) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new SourceIntakeProviderBindingValidationError("expected object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new SourceIntakeProviderBindingValidationError(`${label} is not a JSON object.`);
  }
}

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function cleanNullable(value: unknown) {
  const text = cleanText(value);
  return text || null;
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record).sort().map((key) => [key, sortJson(record[key])]),
  );
}
