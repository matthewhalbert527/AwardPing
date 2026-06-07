const placeholderSummaryPatterns = [
  /^official pages? for\b/i,
  /^default nationally competitive award\b/i,
  /^no official source pages?\b/i,
  /^source pages? for\b/i,
  /^award pages?\b/i,
  /^scholarship$/i,
  /^fellowship$/i,
  /^award$/i,
];

const trailingFragmentPattern =
  /\b(a|an|and|as|by|for|from|in|of|on|or|the|to|with)$/i;

const nonAwardDescriptionPatterns = [
  /^the\s+.+?\s+page\s+(added|removed|changed|provides|offers|contains|includes|lists)\b/i,
  /\b(application status has changed|added the following wording|removed the following wording|changed wording from)\b/i,
  /\b(provides?|offers?|contains?|features?|lists?|includes?)\s+(information|details|resources|guidance|source pages?|official pages?)\b/i,
  /\b(official|source)\s+pages?\b/i,
  /\b(skip to main|toggle menu|privacy policy|cookie policy|search for:|read more|learn more|click here)\b/i,
  /https?:\/\//i,
];

export function summaryNeedsBackfill(
  summary: string | null | undefined,
  options: { minLength?: number } = {},
) {
  const minLength = options.minLength ?? 80;
  const clean = normalizeSummaryBackfillText(summary);
  if (!clean) return true;
  if (clean.length < minLength) return true;
  if (clean.length > 340) return true;
  if (placeholderSummaryPatterns.some((pattern) => pattern.test(clean))) return true;
  if (trailingFragmentPattern.test(clean)) return true;
  if (nonAwardDescriptionPatterns.some((pattern) => pattern.test(clean))) return true;
  if (sentenceCount(clean) > 2 && clean.length > 220) return true;
  return false;
}

export function isUsefulBackfilledSummary(summary: string | null | undefined) {
  const clean = normalizeSummaryBackfillText(summary);
  const normalized = clean.toLowerCase();
  const words = clean.split(/\s+/).filter(Boolean);
  return (
    clean.length >= 70 &&
    clean.length <= 280 &&
    words.length >= 12 &&
    words.length <= 42 &&
    sentenceCount(clean) <= 2 &&
    !placeholderSummaryPatterns.some((pattern) => pattern.test(clean)) &&
    !trailingFragmentPattern.test(clean) &&
    !nonAwardDescriptionPatterns.some((pattern) => pattern.test(clean)) &&
    !normalized.includes("official pages for") &&
    !normalized.includes("this page") &&
    !normalized.includes("the website") &&
    !normalized.includes("source page") &&
    !normalized.includes("click here") &&
    !normalized.includes("learn more")
  );
}

export function normalizeSummaryBackfillText(value: string | null | undefined) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim();
}

function sentenceCount(value: string) {
  const protectedValue = value.replace(
    /\b(U\.S|U\.K|Ph\.D|M\.D|D\.C|D\.Phil|Ed\.D|J\.D|B\.A|M\.A|M\.S|B\.S|Dr|Mr|Ms|Mrs)\./g,
    (match) => match.replace(/\./g, ""),
  );
  const matches = protectedValue.match(/[.!?](?=\s|$)/g);
  return matches?.length || 0;
}
