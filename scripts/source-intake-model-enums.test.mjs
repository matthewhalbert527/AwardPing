import { describe, expect, it } from "vitest";
import { normalizeGeminiIntakeResult, validateIntakeAiDecision } from "./lib/source-intake.mjs";

const accepted = {
  status: "accepted",
  source_relevance: "primary",
  cycle_relevance: "current_or_upcoming",
  officialness: "official",
  confidence: "high",
  page_type: "application",
  evidence_quotes: ["Example Fellowship applications open March 1, 2027."],
  facts: { deadline: "March 1, 2027" },
};

const decisionFields = [
  ["source_relevance", "primary", "unclear", "source_relevance_unclear"],
  ["cycle_relevance", "current_or_upcoming", "unclear", "cycle_relevance_unclear"],
  ["officialness", "official", "unclear", "officialness_unclear"],
  ["confidence", "high", "low", "confidence_low"],
];

const malformedTokens = [
  ["array", (token) => [token]],
  ["nested array", (token) => [[token]]],
  ["question", (token) => `${token}?`],
  ["exclamation", (token) => `${token}!`],
  ["quoted token", (token) => `"${token}"`],
  ["embedded NUL", (token) => `${token.slice(0, 1)}\u0000${token.slice(1)}`],
  ["object", (token) => ({ value: token })],
  ["boolean", () => true],
  ["number", () => 1],
  ["missing", () => undefined],
];

describe.each(decisionFields)("model decision token %s", (field, token, fallback, reason) => {
  it.each(malformedTokens)("keeps a %s token in manual review through repeated normalization", (_label, malformed) => {
    const raw = { ...accepted, [field]: malformed(token) };
    const before = structuredClone(raw);
    const normalized = normalizeGeminiIntakeResult(raw);
    expect.soft(normalized[field]).toBe(fallback);
    const expected = { accepted: false, manual: true, reason };
    expect.soft(validateIntakeAiDecision(raw)).toEqual(expected);
    // The worker normalizes before passing the review into this validator.
    expect.soft(validateIntakeAiDecision(normalized)).toEqual(expected);
    expect(normalizeGeminiIntakeResult(normalized)[field]).toBe(normalized[field]);
    expect(raw).toEqual(before);
    expect(normalized.raw).toBe(raw);
  });

  it.each([
    ["canonical", (token) => token],
    ["case and trim", (token) => ` ${token.toUpperCase()}\n`],
    ["hyphen separators", (token) => token.replaceAll("_", "-")],
    ["space separators", (token) => token.replaceAll("_", " ")],
  ])("preserves a valid %s token", (_label, format) => {
    const raw = { ...accepted, [field]: format(token) };
    expect(normalizeGeminiIntakeResult(raw)[field]).toBe(token);
    expect(validateIntakeAiDecision(raw)).toEqual({ accepted: true, manual: false, reason: "accepted" });
  });
});

it.each([
  ["source_relevance", "sibling_program", { accepted: false, manual: false, reason: "source_relevance_sibling_program" }],
  ["cycle_relevance", "archived_or_past", { accepted: false, manual: false, reason: "cycle_relevance_archived_or_past" }],
  ["officialness", "third_party", { accepted: false, manual: true, reason: "officialness_third_party" }],
  ["confidence", "low", { accepted: false, manual: true, reason: "confidence_low" }],
])("retains the explicit blocking token for %s", (field, token, expected) => {
  expect(validateIntakeAiDecision({ ...accepted, [field]: token })).toEqual(expected);
});

it("retains explicit rejection priority over malformed supporting signals", () => {
  expect(validateIntakeAiDecision({ ...accepted, status: "rejected", officialness: ["official"], rejection_reason: "Not this award" }))
    .toEqual({ accepted: false, manual: false, reason: "Not this award" });
});
