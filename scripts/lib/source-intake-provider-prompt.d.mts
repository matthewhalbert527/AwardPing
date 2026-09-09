/** Every reason the excerpt could not be read back out of a retained prompt. */
export type SourceIntakeProviderPromptExcerptFailure =
  | "prompt_not_string"
  | "captured_page_delimiter_missing"
  | "captured_page_delimiter_duplicated"
  | "captured_page_json_missing"
  | "captured_page_json_invalid"
  | "captured_page_json_not_object"
  | "captured_page_json_not_producer_shaped"
  | "text_excerpt_missing"
  | "text_excerpt_not_string";

/**
 * `text` holds the exact code units the prompt carried: not trimmed, not
 * coerced, and not stripped of NULs.
 */
export type SourceIntakeProviderPromptExcerptResult =
  | { ok: true; text: string }
  | { ok: false; reason: SourceIntakeProviderPromptExcerptFailure };

export declare const SOURCE_INTAKE_PROVIDER_PROMPT_CAPTURED_PAGE_DELIMITER: "\n\nCaptured page:\n\n";

export declare function readSourceIntakeProviderPromptExcerpt(
  userPrompt: unknown,
): SourceIntakeProviderPromptExcerptResult;
