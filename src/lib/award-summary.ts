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
