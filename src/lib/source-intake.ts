export const sourceIntakeStatuses = [
  "pending",
  "queued",
  "validating",
  "capturing",
  "ai_review_pending",
  "ai_review_submitted",
  "ai_review_succeeded",
  "matching",
  "needs_manual_review",
  "added",
  "rejected",
  "failed",
] as const;

export const sourceIntakeTypes = [
  "award_homepage",
  "official_source",
  "sponsor_site",
  "unknown",
] as const;

export type SourceIntakeStatus = (typeof sourceIntakeStatuses)[number];
export type SourceIntakeType = (typeof sourceIntakeTypes)[number];

export type SourceIntakeSubmission = {
  url: string;
  awardName?: string | null;
  notes?: string | null;
  intakeType?: SourceIntakeType | null;
};

export type SourceIntakeDeterministicInput = {
  url: string;
  title?: string | null;
  text?: string | null;
  requestedAwardName?: string | null;
  contentType?: string | null;
};

export type SourceIntakeDeterministicReview = {
  allowed: boolean;
  status: "plausible" | "needs_manual_review" | "rejected";
  reason: string;
  pageType: string;
  qualityFlags: string[];
  normalizedUrl: string | null;
  titleSignal: string;
  textSignal: string;
};

const safeSchemes = new Set(["http:", "https:"]);
const trackingParams = /^(utm_|fbclid$|gclid$|mc_|_hs|vero_|igshid$|ref$|source$|campaign$)/i;
const unsafeHostPattern =
  /(?:^|\.)localhost$|(?:^|\.)local$|(?:^|\.)internal$|(?:^|\.)invalid$|(?:^|\.)test$|(?:^|\.)example$/i;
const genericListingPattern =
  /\b(search|results?|listing|directory|database|finder|find-programs?|program-search|scholarship-search|tag|category|archive)\b/i;
const noisePathPattern =
  /\/(?:careers?|jobs?|employment|profile|profiles?|recipients?|awardees?|fellows?|news|events?|calendar|payment|payments|billing|bursar|1098t|1098-t|security|question|login|signin|sign-in|account|donate|privacy|terms)(?:[/?#]|$)/i;
const accessTextPattern = /\b(access denied|forbidden|captcha|security question|sign in required|log in required|please login|not authorized)\b/i;
const spamTextPattern = /\b(viagra|levitra|cialis|casino|xanax|tramadol|payday|pharma)\b/i;
const awardSignalPattern = /\b(award|scholarship|fellowship|grant|funding|application|apply|eligibility|deadline|stipend|tuition|nomination)\b/i;
const pdfPattern = /\.pdf(?:$|[?#])/i;

export function normalizeSourceIntakeUrl(value: string) {
  const raw = value.trim();
  if (!raw) throw new Error("Enter a URL.");
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  const url = new URL(withScheme);
  if (!safeSchemes.has(url.protocol)) {
    throw new Error("Only public http and https URLs can be reviewed.");
  }
  if (unsafeHostPattern.test(url.hostname) || isPrivateIpLikeHost(url.hostname)) {
    throw new Error("Private, local, or internal URLs cannot be reviewed.");
  }
  url.hash = "";
  for (const key of Array.from(url.searchParams.keys())) {
    if (trackingParams.test(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  url.pathname = url.pathname.replace(/\/{2,}/g, "/");
  if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/g, "");
  return url.toString();
}

export function normalizeSourceIntakeKey(value: string) {
  return normalizeSourceIntakeUrl(value).toLowerCase();
}

export function parseBulkSourceIntakeText(
  value: string,
  defaults: { awardName?: string | null; notes?: string | null; intakeType?: SourceIntakeType | null } = {},
) {
  const submissions: SourceIntakeSubmission[] = [];
  for (const line of value.split(/\r?\n/)) {
    const clean = line.trim();
    if (!clean) continue;
    const parts = clean.split(/\s*\|\s*/);
    const url = parts[0]?.trim();
    if (!url) continue;
    submissions.push({
      url,
      awardName: parts[1]?.trim() || defaults.awardName || null,
      notes: parts[2]?.trim() || defaults.notes || null,
      intakeType: defaults.intakeType || "unknown",
    });
  }
  return submissions;
}

export function dedupeIntakeSubmissions(submissions: SourceIntakeSubmission[]) {
  const seen = new Set<string>();
  const result: SourceIntakeSubmission[] = [];
  for (const submission of submissions) {
    const normalizedUrl = normalizeSourceIntakeUrl(submission.url);
    const awardKey = normalizeAwardNameForIntake(submission.awardName || "");
    const key = `${normalizedUrl.toLowerCase()}::${awardKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ ...submission, url: normalizedUrl });
  }
  return result;
}

export function deterministicSourceIntakeReview(
  input: SourceIntakeDeterministicInput,
): SourceIntakeDeterministicReview {
  let normalizedUrl: string | null = null;
  try {
    normalizedUrl = normalizeSourceIntakeUrl(input.url);
  } catch (error) {
    return review(false, "rejected", error instanceof Error ? error.message : "invalid_url", "other", [], null, input);
  }

  const titleSignal = cleanText(input.title);
  const textSignal = cleanText(input.text).slice(0, 8000);
  const combined = `${normalizedUrl} ${titleSignal} ${textSignal}`;
  const flags: string[] = [];
  const pageType = inferIntakePageType({
    url: normalizedUrl,
    title: titleSignal,
    text: textSignal,
    contentType: input.contentType,
  });

  if (noisePathPattern.test(normalizedUrl)) flags.push("blocked-url-shape");
  if (genericListingPattern.test(normalizedUrl) && pageType !== "pdf") flags.push("generic-listing");
  if (accessTextPattern.test(combined)) flags.push("access-error");
  if (spamTextPattern.test(combined)) flags.push("spam");
  if (!awardSignalPattern.test(combined) && pageType !== "pdf") flags.push("missing-award-signal");

  if (flags.includes("spam") || flags.includes("access-error") || flags.includes("blocked-url-shape")) {
    return review(false, "rejected", flags[0], pageType, flags, normalizedUrl, input);
  }

  if (flags.includes("generic-listing") || flags.includes("missing-award-signal")) {
    return review(false, "needs_manual_review", flags[0], pageType, flags, normalizedUrl, input);
  }

  return review(true, "plausible", "passes_deterministic_intake_gate", pageType, flags, normalizedUrl, input);
}

export function inferIntakePageType(input: {
  url?: string | null;
  title?: string | null;
  text?: string | null;
  contentType?: string | null;
}) {
  const url = String(input.url || "");
  const title = String(input.title || "");
  const text = String(input.text || "").slice(0, 3000);
  const combined = `${url} ${title} ${text}`;
  if (pdfPattern.test(url) || /pdf/i.test(String(input.contentType || ""))) return "pdf";
  if (/\b(faq|frequently asked questions)\b/i.test(combined)) return "faq";
  if (/\b(deadline|due date|closing date|application close)/i.test(combined)) return "deadline";
  if (/\b(eligibility|eligible|who can apply)\b/i.test(combined)) return "eligibility";
  if (/\b(requirements|required|criteria|conditions)\b/i.test(combined)) return "requirements";
  if (/\b(apply|application|portal|submit|nomination)\b/i.test(combined)) return "application";
  if (genericListingPattern.test(combined)) return "listing";
  return "homepage";
}

export function normalizeAwardNameForIntake(value: string | null | undefined) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function review(
  allowed: boolean,
  status: SourceIntakeDeterministicReview["status"],
  reason: string,
  pageType: string,
  qualityFlags: string[],
  normalizedUrl: string | null,
  input: SourceIntakeDeterministicInput,
): SourceIntakeDeterministicReview {
  return {
    allowed,
    status,
    reason,
    pageType,
    qualityFlags,
    normalizedUrl,
    titleSignal: cleanText(input.title),
    textSignal: cleanText(input.text).slice(0, 8000),
  };
}

function isPrivateIpLikeHost(hostname: string) {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (/^(10|127)\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return true;
  if (host === "0.0.0.0" || host === "::1") return true;
  return false;
}

function cleanText(value: unknown) {
  return String(value || "")
    .replace(/\u0000/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
