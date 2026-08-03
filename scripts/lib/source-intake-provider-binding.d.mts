export type SourceIntakeProviderPromptPolicy = {
  name: string;
  version: number;
  system_instruction_version: number;
  output_schema_version: number;
  text_excerpt_offset: number;
  text_excerpt_max_chars: number;
};

export type SourceIntakeProviderInputBinding = {
  schema_version: 2;
  namespace: "source-intake-provider-input-v2";
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
  prompt_policy: SourceIntakeProviderPromptPolicy;
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

export type SourceIntakeProviderResultBinding = {
  schema_version: 2;
  namespace: "source-intake-provider-result-v2";
  request_id: string;
  input_digest_sha256: string;
  provider_batch_name: string;
  provider_batch_request_key: string;
  model: string;
  provider_result_sha256: string;
  accepted_at: string;
  digest_sha256: string;
};

export const SOURCE_INTAKE_PROVIDER_INPUT_BINDING_NAMESPACE: "source-intake-provider-input-v2";
export const SOURCE_INTAKE_PROVIDER_RESULT_BINDING_NAMESPACE: "source-intake-provider-result-v2";
export const SOURCE_INTAKE_PROVIDER_BINDING_SCHEMA_VERSION: 2;
export const SOURCE_INTAKE_PROVIDER_PROMPT_POLICY: Readonly<{
  name: "awardping-source-intake-review";
  version: 2;
  system_instruction_version: 1;
  output_schema_version: 1;
  text_excerpt_offset: 0;
  text_excerpt_max_chars: 16000;
}>;

export class SourceIntakeProviderBindingError extends Error {
  code: string;
  constructor(code: string, message: string);
}

export function buildSourceIntakeProviderInputBinding(input: {
  request: Record<string, unknown> & { id: string };
  capture: unknown;
  deterministicReview: unknown;
  providerEnvelope: Record<string, unknown>;
  model: string;
  promptPolicy?: SourceIntakeProviderPromptPolicy;
  requireR2Verified?: boolean;
}): SourceIntakeProviderInputBinding;

export function buildSourceIntakeProviderResultBinding(input: {
  request: Record<string, unknown> & { id: string };
  capture: unknown;
  deterministicReview: unknown;
  inputBinding: SourceIntakeProviderInputBinding;
  rawResult: unknown;
  batchName: string;
  batchRequestKey: string;
  model: string;
  acceptedAt?: string;
}): SourceIntakeProviderResultBinding;

export function validateSourceIntakeProviderInputBinding(
  value: unknown,
  options: {
    request: Record<string, unknown> & { id: string };
    capture: unknown;
    deterministicReview: unknown;
    requireR2Verified?: boolean;
  },
): SourceIntakeProviderInputBinding;

export function validateSourceIntakeProviderReplayBinding(input: {
  request: Record<string, unknown> & { id: string };
  capture: unknown;
  deterministicReview: unknown;
  storedReview: unknown;
  rawResult?: unknown;
  requireR2Verified?: boolean;
}): {
  capture: Record<string, unknown>;
  inputBinding: SourceIntakeProviderInputBinding;
  resultBinding: SourceIntakeProviderResultBinding;
};

export function sourceIntakeProviderCaptureIdentity(
  request: { id: string },
  capture: unknown,
  options?: { requireR2Verified?: boolean },
): Record<string, unknown>;

export function sourceIntakeProviderRequestFields(
  request: Record<string, unknown> & { id: string },
): Record<string, unknown>;

export function sourceIntakeProviderTextExcerpt(
  value: unknown,
  promptPolicy?: SourceIntakeProviderPromptPolicy,
): string;

export function isSourceIntakeProviderBindingError(error: unknown): boolean;
