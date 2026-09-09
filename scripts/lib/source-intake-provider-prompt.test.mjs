import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { buildGeminiIntakePrompt } from "./source-intake.mjs";
import {
  SOURCE_INTAKE_PROVIDER_PROMPT_CAPTURED_PAGE_DELIMITER as DELIMITER,
  readSourceIntakeProviderPromptExcerpt,
} from "./source-intake-provider-prompt.mjs";

/** A v2-shaped prompt: chunks joined by two newlines, captured page last. */
function v2Prompt(capturedPage, { chunks = ["Review this pasted source URL for AwardPing intake."] } = {}) {
  return [...chunks, "Captured page:", JSON.stringify(capturedPage)].join("\n\n");
}

function capturedPage(textExcerpt, extra = {}) {
  return {
    retained_capture_identity: null,
    prompt_policy: { name: "awardping-source-intake-review", version: 2 },
    final_url: "https://example.edu/fellowship",
    canonical_url: "https://example.edu/fellowship",
    status_code: 200,
    content_type: "text/html",
    title: "Example Fellowship",
    page_description: "Official fellowship page.",
    text_excerpt: textExcerpt,
    pdf_links: [],
    links: [],
    ...extra,
  };
}

describe("source intake provider prompt excerpt", () => {
  it("returns the excerpt from a v2-shaped prompt", () => {
    const prompt = v2Prompt(capturedPage("Applications close March 1."));
    expect(readSourceIntakeProviderPromptExcerpt(prompt)).toEqual({
      ok: true,
      text: "Applications close March 1.",
    });
  });

  it("round-trips text whose JSON encoding is not its own bytes", () => {
    const excerpts = [
      'She said "apply by March 1" and left.',
      "Line one\nline two\ttabbed",
      "Backslash \\ and slash / and \u0000 embedded NUL",
      "Unicode: café — “quoted” 中文 🎓",
      "\u2028 line separator \u2029 paragraph separator",
      "  leading and trailing spaces  ",
      "",
    ];
    for (const excerpt of excerpts) {
      const result = readSourceIntakeProviderPromptExcerpt(v2Prompt(capturedPage(excerpt)));
      expect(result, JSON.stringify(excerpt)).toEqual({ ok: true, text: excerpt });
      // Exact code units: nothing trimmed, coerced or stripped.
      expect(result.text.length, JSON.stringify(excerpt)).toBe(excerpt.length);
    }
  });

  it("reads back the excerpt the real v2 producer embedded", () => {
    // Guards the shape assumption itself: if buildGeminiIntakePrompt changes
    // its delimiter or terminal chunk, this fails rather than silently drifting.
    const text = "Example Research Fellowship applications close March 1. “Apply” online.";
    const prompt = buildGeminiIntakePrompt(
      {
        id: "request-1",
        award_name: "Example Research Fellowship",
        homepage_url: "https://example.edu/f",
        submitted_url: "https://example.edu/f",
        normalized_url: "https://example.edu/f",
        intake_type: "award_homepage",
      },
      {
        final_url: "https://example.edu/f",
        canonical_url: "https://example.edu/f",
        status_code: 200,
        content_type: "text/html",
        title: "Example Research Fellowship",
        page_description: "Official fellowship page.",
        text,
        pdf_links: [],
        links: [],
      },
      { allowed: true, status: "queued", reason: null, qualityFlags: [] },
    );

    const result = readSourceIntakeProviderPromptExcerpt(prompt);
    expect(result.ok).toBe(true);
    expect(result.text).toBe(JSON.parse(prompt.slice(prompt.indexOf(DELIMITER) + DELIMITER.length)).text_excerpt);
    expect(prompt.split(DELIMITER)).toHaveLength(2);
  });

  it("refuses a prompt that is not a string", () => {
    for (const value of [undefined, null, 7, true, {}, [], Object("text")]) {
      expect(readSourceIntakeProviderPromptExcerpt(value), JSON.stringify(value))
        .toEqual({ ok: false, reason: "prompt_not_string" });
    }
  });

  it("refuses a missing or repeated delimiter instead of guessing", () => {
    expect(readSourceIntakeProviderPromptExcerpt("Captured page:\n\n{}"))
      .toEqual({ ok: false, reason: "captured_page_delimiter_missing" });
    expect(readSourceIntakeProviderPromptExcerpt(`Intro${DELIMITER}${JSON.stringify(capturedPage("a"))}`).ok).toBe(true);

    const doubled = `Intro${DELIMITER}${JSON.stringify(capturedPage("a"))}${DELIMITER}${JSON.stringify(capturedPage("b"))}`;
    expect(readSourceIntakeProviderPromptExcerpt(doubled))
      .toEqual({ ok: false, reason: "captured_page_delimiter_duplicated" });
    // Adjacent delimiters are still two delimiters.
    expect(readSourceIntakeProviderPromptExcerpt(`Intro${DELIMITER}${DELIMITER}{}`))
      .toEqual({ ok: false, reason: "captured_page_delimiter_duplicated" });
  });

  it("refuses an empty, malformed, or non-object terminal chunk", () => {
    expect(readSourceIntakeProviderPromptExcerpt(`Intro${DELIMITER}`))
      .toEqual({ ok: false, reason: "captured_page_json_missing" });
    expect(readSourceIntakeProviderPromptExcerpt(`Intro${DELIMITER}{"text_excerpt":`))
      .toEqual({ ok: false, reason: "captured_page_json_invalid" });
    for (const terminal of ['["text_excerpt"]', '"a string"', "42", "true", "null"]) {
      expect(readSourceIntakeProviderPromptExcerpt(`Intro${DELIMITER}${terminal}`), terminal)
        .toEqual({ ok: false, reason: "captured_page_json_not_object" });
    }
  });

  it("refuses trailing prose after the captured-page object", () => {
    const json = JSON.stringify(capturedPage("Applications close March 1."));
    expect(readSourceIntakeProviderPromptExcerpt(`Intro${DELIMITER}${json}\n\nThanks.`))
      .toEqual({ ok: false, reason: "captured_page_json_invalid" });
    // Trailing whitespace is legal JSON, so the producer-shape guard is what
    // catches it: JSON.stringify never emits a trailing space.
    expect(readSourceIntakeProviderPromptExcerpt(`Intro${DELIMITER}${json} `))
      .toEqual({ ok: false, reason: "captured_page_json_not_producer_shaped" });
  });

  it("refuses JSON the current producer would never emit", () => {
    // Duplicate keys: JSON.parse keeps the last, so the prompt the provider
    // read is not the object we would reconstruct.
    expect(readSourceIntakeProviderPromptExcerpt(
      `Intro${DELIMITER}{"text_excerpt":"first","text_excerpt":"second"}`,
    )).toEqual({ ok: false, reason: "captured_page_json_not_producer_shaped" });

    // Pretty-printed or otherwise re-spaced output.
    expect(readSourceIntakeProviderPromptExcerpt(
      `Intro${DELIMITER}${JSON.stringify(capturedPage("a"), null, 2)}`,
    )).toEqual({ ok: false, reason: "captured_page_json_not_producer_shaped" });
    expect(readSourceIntakeProviderPromptExcerpt(`Intro${DELIMITER}{ "text_excerpt": "a" }`))
      .toEqual({ ok: false, reason: "captured_page_json_not_producer_shaped" });
  });

  it("refuses an absent or non-string excerpt field", () => {
    const withoutExcerpt = capturedPage("a");
    delete withoutExcerpt.text_excerpt;
    expect(readSourceIntakeProviderPromptExcerpt(v2Prompt(withoutExcerpt)))
      .toEqual({ ok: false, reason: "text_excerpt_missing" });

    for (const value of [null, 7, true, ["a"], { text: "a" }]) {
      expect(readSourceIntakeProviderPromptExcerpt(v2Prompt(capturedPage(value))), JSON.stringify(value))
        .toEqual({ ok: false, reason: "text_excerpt_not_string" });
    }
  });

  it("stays pure: no imports, no I/O, no hashing, no matching", () => {
    const text = readFileSync(new URL("./source-intake-provider-prompt.mjs", import.meta.url), "utf8");
    expect(text).not.toMatch(/^import\s/m);
    expect(text).not.toMatch(/require\(|createHash|fetch\(|process\.env|eval\(|new Function/);
  });
});
