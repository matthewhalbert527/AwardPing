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

function normalizeBaselineLabel(value: string) {
  const lower = value.toLowerCase();
  return baselineFactLabels.find((label) => label.toLowerCase() === lower) || null;
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
