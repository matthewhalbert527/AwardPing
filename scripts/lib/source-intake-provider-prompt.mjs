/**
 * Reads the captured-page text excerpt back out of a retained source-intake
 * user prompt.
 *
 * The provider binding hashes the prompt and the separately calculated excerpt
 * independently. Callers must compare this parsed excerpt with the excerpt
 * derived from the retained capture before accepting those independent hashes.
 *
 * It reads the v2 prompt shape exactly: chunks joined by two newlines, ending
 * with the label "Captured page:" and one `JSON.stringify` object. Anything
 * that is not that shape is refused with a reason rather than repaired, and
 * the excerpt is returned as the exact code units the JSON carried - never
 * trimmed, coerced, or stripped of NULs.
 *
 * Pure and self-contained: no imports, no I/O, no network, no hashing, no
 * lexical matching, no callbacks, and no metadata lookups.
 */

/** The single delimiter the v2 producer emits before the captured-page JSON. */
export const SOURCE_INTAKE_PROVIDER_PROMPT_CAPTURED_PAGE_DELIMITER = "\n\nCaptured page:\n\n";

/**
 * @param {unknown} userPrompt the retained prompt text, as sent to the provider
 * @returns {{ ok: true, text: string } | { ok: false, reason: string }}
 */
export function readSourceIntakeProviderPromptExcerpt(userPrompt) {
  if (typeof userPrompt !== "string") return { ok: false, reason: "prompt_not_string" };

  const delimiter = SOURCE_INTAKE_PROVIDER_PROMPT_CAPTURED_PAGE_DELIMITER;
  const start = userPrompt.indexOf(delimiter);
  if (start < 0) return { ok: false, reason: "captured_page_delimiter_missing" };
  // A second delimiter makes the terminal chunk ambiguous, so refuse rather
  // than pick one; the producer emits the label exactly once.
  if (userPrompt.indexOf(delimiter, start + 1) >= 0) {
    return { ok: false, reason: "captured_page_delimiter_duplicated" };
  }

  const rawJson = userPrompt.slice(start + delimiter.length);
  if (rawJson.length === 0) return { ok: false, reason: "captured_page_json_missing" };

  let parsed;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    // Trailing prose after the object lands here: JSON.parse refuses a suffix.
    return { ok: false, reason: "captured_page_json_invalid" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "captured_page_json_not_object" };
  }
  // Re-serializing must reproduce the exact JSON text the producer emitted. This
  // rejects duplicate keys (JSON.parse keeps only the last), pretty-printing,
  // and any other spacing no JSON.stringify call would produce - all shapes
  // whose excerpt could differ from what the provider was actually shown.
  if (JSON.stringify(parsed) !== rawJson) {
    return { ok: false, reason: "captured_page_json_not_producer_shaped" };
  }

  if (!Object.prototype.hasOwnProperty.call(parsed, "text_excerpt")) {
    return { ok: false, reason: "text_excerpt_missing" };
  }
  const text = parsed.text_excerpt;
  if (typeof text !== "string") return { ok: false, reason: "text_excerpt_not_string" };

  return { ok: true, text };
}
