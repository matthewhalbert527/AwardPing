export function normalizeImportantDateItems(
  values: string[],
  context: { deadline?: string | null; openingDate?: string | null } = {},
) {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const value of values.flatMap(splitImportantDateItems)) {
    const item = contextualImportantDate(value, context);
    if (!item) continue;
    const key = item.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    normalized.push(truncate(item, 180));
  }

  return normalized.slice(0, 10);
}

export function splitImportantDateItems(value: string) {
  return String(value || "")
    .split(/\s*;\s*/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

function contextualImportantDate(
  value: string,
  context: { deadline?: string | null; openingDate?: string | null },
) {
  const clean = cleanString(value).replace(/^important dates?:\s*/i, "");
  if (!clean) return null;
  if (!hasDateSignal(clean)) return null;
  if (!isBareDateValue(clean)) return clean;

  if (sameDateText(clean, context.deadline)) {
    return `Application deadline: ${clean}`;
  }
  if (sameDateText(clean, context.openingDate)) {
    return `Applications open: ${clean}`;
  }

  return null;
}

function sameDateText(value: string, reference?: string | null) {
  const left = normalizeDateText(value);
  const right = normalizeDateText(reference || "");
  return Boolean(left && right && (left === right || right.includes(left) || left.includes(right)));
}

function normalizeDateText(value: string) {
  return cleanString(value)
    .toLowerCase()
    .replace(/\b(?:deadline|due|opens?|opening|applications?|application|date|by|on|at)\b/g, " ")
    .replace(/\b(\d{1,2})(?:st|nd|rd|th)\b/g, "$1")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasDateSignal(value: string) {
  return (
    /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i.test(
      value,
    ) ||
    /\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/.test(value) ||
    /\b(?:spring|summer|fall|autumn|winter)\s+\d{4}\b/i.test(value)
  );
}

function isBareDateValue(value: string) {
  const stripped = cleanString(value)
    .toLowerCase()
    .replace(/\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/g, " ")
    .replace(/\b(?:spring|summer|fall|autumn|winter|early|mid|late|end|beginning|start|through|to|and|or|of|the|by|on|at)\b/g, " ")
    .replace(/\b\d{1,4}(?:st|nd|rd|th)?\b/g, " ")
    .replace(/[,\-–—/().:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return stripped.length === 0;
}

function cleanString(value: unknown) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function truncate(value: string, length: number) {
  const clean = value.replace(/\s+/g, " ").trim();
  if (clean.length <= length) return clean;
  return `${clean.slice(0, length - 1).replace(/\s+\S*$/, "")}...`;
}
