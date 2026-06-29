import { cleanDisplayText } from "@/lib/display-text";

export const defaultAwardPlaceholderSummary =
  "Default nationally competitive award monitored for new offices.";

export function displayAwardSummary(summary: string | null | undefined) {
  if (!summary) return null;

  const trimmed = cleanDisplayText(summary);
  if (!trimmed || trimmed === defaultAwardPlaceholderSummary) return null;
  if (looksLikeBrokenSummary(trimmed)) return null;

  return trimmed;
}

export type AwardBaselineSummaryParts = {
  overview: string | null;
  facts: Array<{ label: string; value: string }>;
};

const baselineFactLabels = [
  "Deadline",
  "Opening date",
  "Award amount",
  "Eligibility",
  "Requirements",
  "Application materials",
  "How to apply",
  "Important dates",
  "Documents",
  "Contacts",
  "Notes",
  "Baseline detail confidence",
] as const;

export function awardBaselineSummaryParts(summary: string | null | undefined): AwardBaselineSummaryParts | null {
  const clean = displayAwardSummary(summary);
  if (!clean) return null;

  const labelPattern = new RegExp(`\\b(${baselineFactLabels.map(escapeRegex).join("|")}):`, "gi");
  const matches = [...clean.matchAll(labelPattern)];
  if (matches.length === 0) {
    return { overview: clean, facts: [] };
  }

  const overview = clean.slice(0, matches[0].index).trim() || null;
  const facts: Array<{ label: string; value: string }> = [];
  for (const [index, match] of matches.entries()) {
    const label = normalizeBaselineLabel(match[1]);
    const valueStart = (match.index || 0) + match[0].length;
    const valueEnd = matches[index + 1]?.index ?? clean.length;
    const value = clean.slice(valueStart, valueEnd).replace(/\s+/g, " ").replace(/[. ]+$/g, "").trim();
    if (label && value) facts.push({ label, value });
  }

  return { overview, facts };
}

export function compactAwardDirectorySummary(
  summary: string | null | undefined,
  awardName: string,
) {
  const clean = displayAwardSummary(summary);
  if (!clean) return null;

  const firstSentence = firstMeaningfulSentence(clean) || clean;
  return singleLineAwardSentence(firstSentence, awardName);
}

function normalizeBaselineLabel(value: string) {
  const lower = value.toLowerCase();
  return baselineFactLabels.find((label) => label.toLowerCase() === lower) || null;
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function firstMeaningfulSentence(value: string) {
  return (
    value
      .split(/(?<=[.!?])\s+/)
      .map((sentence) => sentence.trim())
      .find((sentence) => sentence.length >= 35) || null
  );
}

function singleLineAwardSentence(value: string, awardName: string) {
  const clean = value.replace(/\s+/g, " ").trim();
  if (!clean) return null;

  const normalizedName = awardName.replace(/\s+/g, " ").trim();
  const withoutParenthetical = clean.replace(/\s*\([^)]{2,80}\)\s*/g, " ");
  const sentence = withoutParenthetical.replace(/\s+/g, " ").trim();
  if (sentence.length <= 145) return ensureSentencePunctuation(sentence);

  const leadMatch = sentence.match(
    /^(The\s+)?(.+?)\s+(provides?|offers?|supports?|funds?|awards?|gives?|recognizes?|honors?|helps?|enables?)\s+(.+?)(?:\s+(?:for|to|that|who|from|through|including|matching|with)\b|,|;|$)/i,
  );
  if (leadMatch) {
    const subject = leadMatch[2]?.length > 58
      ? normalizedName
      : `${leadMatch[1] || ""}${leadMatch[2]}`.trim();
    const verb = leadMatch[3]?.toLowerCase() || "supports";
    const object = leadMatch[4]?.trim() || "applicants";
    const concise = `${subject} ${verb} ${object}`;
    if (concise.length <= 145) return ensureSentencePunctuation(concise);
  }

  const boundary = sentence.slice(0, 146).search(/\s(?:for|to|that|who|from|through|including|matching|with)\b/i);
  if (boundary > 65) return ensureSentencePunctuation(sentence.slice(0, boundary).trim());

  const words = sentence.split(/\s+/);
  const limited = words.reduce((acc, word) => {
    const next = acc ? `${acc} ${word}` : word;
    return next.length <= 135 ? next : acc;
  }, "");

  return ensureSentencePunctuation(limited || sentence.slice(0, 135).trim());
}

function ensureSentencePunctuation(value: string) {
  const clean = value.replace(/\s+/g, " ").replace(/[,:;-\s]+$/g, "").trim();
  if (!clean) return null;
  return /[.!?]$/.test(clean) ? clean : `${clean}.`;
}

function looksLikeBrokenSummary(summary: string) {
  const words = summary.split(/\s+/).filter(Boolean);

  return (
    /^(the|on the|in the|from the)\s+"?[\w\s-]{0,45}$/i.test(summary) ||
    (words.length <= 3 && summary.length < 40 && !/[.!?]$/.test(summary)) ||
    /^the\s+.+?\s+page\s+(added|removed|changed|provides|offers|contains|includes|lists)\b/i.test(
      summary,
    ) ||
    /\b(application status has changed|added the following wording|removed the following wording|changed wording from)\b/i.test(
      summary,
    ) ||
    /\b(provides?|offers?|contains?|features?|lists?|includes?)\s+(information|details|resources|guidance|source pages?|official pages?)\b/i.test(
      summary,
    ) ||
    /\b(official|source)\s+pages?\b/i.test(summary) ||
    /\b(skip to main|toggle menu|privacy policy|cookie policy|search for:|read more|learn more|click here)\b/i.test(
      summary,
    ) ||
    /https?:\/\//i.test(summary)
  );
}
