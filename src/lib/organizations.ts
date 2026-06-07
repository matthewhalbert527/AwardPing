const lowercaseJoiners = new Set([
  "a",
  "an",
  "and",
  "at",
  "by",
  "da",
  "de",
  "del",
  "der",
  "di",
  "du",
  "for",
  "in",
  "la",
  "le",
  "of",
  "on",
  "or",
  "the",
  "to",
  "van",
  "von",
]);

export function normalizedLookupName(value: string) {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

export function normalizeOrganizationName(value: string) {
  const clean = value.trim().replace(/\s+/g, " ");
  if (!clean) return "";

  return clean
    .split(/(\s+|-|,|\/|&)/)
    .map((part, index, parts) => normalizeOrganizationPart(part, index, parts))
    .join("")
    .replace(/\s+([,])/g, "$1")
    .trim();
}

function normalizeOrganizationPart(part: string, index: number, parts: string[]) {
  if (!part || /^[\s,\/-]$/.test(part) || part === "&") return part;

  const lower = part.toLowerCase();
  const previousText = parts.slice(0, index).some((item) => /\w/.test(item));

  if (lowercaseJoiners.has(lower) && previousText) {
    return lower;
  }

  if (/^[A-Z0-9]{2,}$/.test(part) || part.includes(".")) {
    return part.toUpperCase();
  }

  return lower.replace(/(^|')([a-z])/g, (match) => match.toUpperCase());
}
