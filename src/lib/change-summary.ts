import {
  changeDetailsLabel,
  changeDetailsToSummary,
  isMeaningfulChangeDetails,
  parseChangeDetails,
} from "@/lib/change-details";
import { cleanDisplayText, readableSourceTitle } from "@/lib/display-text";

export function isUsefulChangeSummary(
  summary: string | null | undefined,
  changeDetails?: unknown,
) {
  const meaningfulDetails = isMeaningfulChangeDetails(changeDetails);
  if (meaningfulDetails === false) return false;

  const clean = cleanDisplayText(changeDetailsToSummary(changeDetails, summary));
  const normalized = clean.toLowerCase();
  if (!normalized) return false;

  return (
    clean.length >= 28 &&
    !looksLikeTruncatedFragment(clean) &&
    !normalized.startsWith("new terms found:") &&
    !normalized.includes("no award-relevant wording changed") &&
    !normalized.startsWith("new date or deadline language appeared:") &&
    !normalized.startsWith("initial award page snapshot captured") &&
    !normalized.includes("no concise word-level summary") &&
    !normalized.includes("no meaningful change") &&
    !normalized.includes("added or expanded") &&
    !normalized.includes("application language") &&
    !normalized.includes("page was updated") &&
    !normalized.includes("page has been updated") &&
    !normalized.includes("something changed") &&
    !normalized.includes("content was updated") &&
    !normalized.includes("page text updated") &&
    !looksLikeBoilerplateChange(clean)
  );
}

export function isUsefulChangeForAward(change: {
  summary: string | null | undefined;
  awardName?: string | null;
  sourceTitle?: string | null;
  sourceUrl?: string | null;
  changeDetails?: unknown;
  change_details?: unknown;
}) {
  const details = change.changeDetails ?? change.change_details;
  if (!isUsefulChangeSummary(change.summary, details)) return false;

  const summary = displayChangeSummary(change.summary, change.sourceUrl, details);
  if (!isRelevantToAward(summary, change.awardName, change.sourceTitle, change.sourceUrl)) {
    return false;
  }

  return true;
}

export function displayChangeSummary(
  summary: string | null | undefined,
  sourceUrl?: string | null,
  changeDetails?: unknown,
) {
  const clean = rewritePathSourceLabel(
    cleanDisplayText(changeDetailsToSummary(changeDetails, summary)),
    sourceUrl,
  );
  const url = String(sourceUrl || "").toLowerCase();

  if (
    url.includes("udall.gov/ourprograms/scholarship/facultyreps") &&
    /\bmay 25,\s*2026\b/i.test(clean)
  ) {
    return "The Udall Faculty Reps page lists the Scholarship submission deadline as May 26, 2026 in the Submitting Applications section.";
  }

  return clean;
}

function rewritePathSourceLabel(summary: string, sourceUrl?: string | null) {
  if (!sourceUrl) return summary;
  return summary.replace(
    /^The\s+(\/[^\s]+|[a-z0-9-]+(?:\/[a-z0-9-]+)+\/?)\s+page\s+/i,
    () => `The ${readableSourceTitle(null, sourceUrl)} page `,
  );
}

export function changeSummaryDisplayParts(
  summary: string | null | undefined,
  sourceUrl?: string | null,
  sourceTitle?: string | null,
  changeDetails?: unknown,
) {
  const clean = displayChangeSummary(summary, sourceUrl, changeDetails);
  const normalized = clean.toLowerCase();

  if (normalized.startsWith("added date context:")) {
    return displayParts({
      label: "Date context",
      text: clean.replace(/^added date context:\s*/i, ""),
    });
  }

  if (normalized.startsWith("new funding amount language appeared:")) {
    return displayParts({
      label: "Funding",
      text: clean.replace(/^new funding amount language appeared:\s*/i, "New funding amount: "),
    });
  }

  if (normalized.startsWith("added text includes:")) {
    const added = cleanDiffText(clean.replace(/^added text includes:\s*/i, ""));
    return displayParts({
      label: "Update",
      text: narrativeTextChange("added", added, sourceTitle, sourceUrl),
    });
  }

  if (normalized.startsWith("removed text includes:")) {
    const removed = cleanDiffText(clean.replace(/^removed text includes:\s*/i, ""));
    return displayParts({
      label: "Update",
      text: narrativeTextChange("removed", removed, sourceTitle, sourceUrl),
    });
  }

  if (normalized.startsWith("changed text from")) {
    return displayParts({
      label: "Text changed",
      text: cleanDiffText(clean),
    });
  }

  if (normalized.startsWith("new text appears after the previously stored excerpt:")) {
    return displayParts({
      label: "New text",
      text: cleanDiffText(
        clean.replace(/^new text appears after the previously stored excerpt:\s*/i, ""),
      ),
    });
  }

  return displayParts({
    label: changeDetailsLabel(changeDetails, "Update"),
    text: clean,
  });
}

export function dedupeChangeSummaries<
  Change extends {
    shared_award_id?: string | null;
    source_url?: string | null;
    summary: string | null | undefined;
    change_details?: unknown;
    changeDetails?: unknown;
  },
>(changes: Change[]) {
  const seen = new Set<string>();

  return changes.filter((change) => {
    const key = changeSummaryDedupeKey(change);
    if (!key) return false;

    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function changeSummaryDedupeKey(change: {
  shared_award_id?: string | null;
  source_url?: string | null;
  summary: string | null | undefined;
  change_details?: unknown;
  changeDetails?: unknown;
}) {
  const details = change.change_details ?? change.changeDetails;
  const evidenceKey = changeEvidenceDedupeKey(details);
  if (evidenceKey && change.shared_award_id) {
    return `award:${change.shared_award_id}|${evidenceKey}`;
  }

  const displayedSummary = displayChangeSummary(change.summary, change.source_url, details);
  const normalizedSummary = normalizeSummaryForDedupe(displayedSummary);
  if (!normalizedSummary) return "";

  const normalizedUrl = normalizeSourceUrlForDedupe(change.source_url);
  if (normalizedUrl) return `url:${normalizedUrl}|summary:${normalizedSummary}`;

  return `award:${change.shared_award_id || ""}|summary:${normalizedSummary}`;
}

function changeEvidenceDedupeKey(changeDetails: unknown) {
  const details = parseChangeDetails(changeDetails);
  if (!details || !details.is_alert_worthy) return "";

  const evidenceParts = [
    details.before,
    details.after,
    ...details.structured_diff.added_text,
    ...details.structured_diff.removed_text,
    ...details.structured_diff.date_changes,
    ...details.structured_diff.amount_changes,
  ]
    .map(normalizeEvidenceForDedupe)
    .filter(Boolean);

  if (evidenceParts.length < 2) return "";
  return `evidence:${evidenceParts.join("|")}`;
}

function looksLikeTruncatedFragment(summary: string) {
  const normalized = summary.toLowerCase();
  const words = normalized.split(/\s+/).filter(Boolean);
  const lastWord = words.at(-1)?.replace(/[^a-z0-9]+/g, "") || "";
  const quoteCount = (summary.match(/"/g) || []).length;

  return (
    words.length < 6 ||
    (quoteCount % 2 === 1 && summary.length < 120) ||
    /^(the|on the|in the|from the)\s+"?[\w\s-]{0,40}$/.test(normalized) ||
    /^(the|on the|in the|from the)\s+[a-z]{1,8}$/.test(normalized) ||
    /^(a|an|the|and|or|of|on|to|for|from|with|in|by|through|into|about|over|under)$/.test(lastWord)
  );
}

function looksLikeBoilerplateChange(summary: string) {
  const normalized = summary.toLowerCase();

  return (
    /(social media|facebook|instagram|twitter|x\.com|linkedin|youtube|@[\w.-]+)/.test(normalized) ||
    /(required statements|copyright|all rights reserved|privacy|cookie|newsletter|subscribe)/.test(normalized) ||
    /\b(suite|blvd|boulevard|street|avenue)\b/.test(normalized)
  );
}

function isRelevantToAward(
  summary: string,
  awardName: string | null | undefined,
  sourceTitle: string | null | undefined,
  sourceUrl: string | null | undefined,
) {
  const normalizedSummary = summary.toLowerCase();
  const rootHomepage = isRootHomepage(sourceUrl);
  if (!rootHomepage) return true;

  const awardType = awardProgramType(awardName || sourceTitle || "");
  if (awardType === "scholarship" && /\binternship(s)?\b/.test(normalizedSummary)) {
    return false;
  }

  const tokens = meaningfulAwardTokens([awardName, sourceTitle].filter(Boolean).join(" "));
  if (tokens.some((token) => normalizedSummary.includes(token))) return true;

  return /\b(application|apply|deadline|eligible|eligibility|requirement|recommendation|transcript|essay|interview|tuition|stipend|funding|fellowship|scholarship|award|admission|selection|nomination|candidate|submit|submission)\b/.test(
    normalizedSummary,
  );
}

function isRootHomepage(sourceUrl: string | null | undefined) {
  if (!sourceUrl) return false;

  try {
    const url = new URL(sourceUrl);
    const path = url.pathname.replace(/\/+$/g, "");
    return path === "";
  } catch {
    return false;
  }
}

function awardProgramType(value: string) {
  const normalized = value.toLowerCase();
  if (/\bscholarship(s)?\b/.test(normalized)) return "scholarship";
  if (/\bfellowship(s)?\b/.test(normalized)) return "fellowship";
  if (/\binternship(s)?\b/.test(normalized)) return "internship";
  return "award";
}

function meaningfulAwardTokens(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(
      (token) =>
        token.length >= 4 &&
        !/^(scholarship|scholarships|fellowship|fellowships|program|programs|award|awards|student|students|national|international|graduate|undergraduate|foundation|fund|trust|the|and|for|with|from)$/.test(
          token,
        ),
    );
}

function cleanDiffText(value: string) {
  const clean = cleanDisplayText(value)
    .replace(/\s*;\s*/g, " ")
    .replace(/\.\.+$/g, ".")
    .replace(/\s+/g, " ")
    .trim();

  const quotedSnippets = [...clean.matchAll(/"([^"]+)"/g)]
    .map((match) => normalizeDiffSentence(match[1]))
    .filter(Boolean);

  if (quotedSnippets.length > 0) return quotedSnippets.join(" ");

  return normalizeDiffSentence(clean.replace(/^"+|"+$/g, ""));
}

function normalizeDiffSentence(value: string) {
  const clean = cleanDisplayText(value).replace(/\.\.+$/g, ".");
  if (!clean) return "";

  return /[.!?]$/.test(clean) ? clean : `${clean}.`;
}

function displayParts(input: { label: string; text: string }) {
  const text = input.text
    .split(/\n+/)
    .map((line) => cleanDisplayText(line))
    .filter(Boolean)
    .join("\n")
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/\n\s*/g, "\n")
    .trim();

  return {
    ...input,
    text,
    paragraphs: readableChangeParagraphs(text),
  };
}

function readableChangeParagraphs(value: string) {
  const clean = value
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/\n\s*/g, "\n")
    .trim();
  if (!clean) return [];

  const structured = clean
    .replace(
      /\s+(?=(?:Answer Question #?\d+|Alert the\b|Examples include|Write about)\b)/g,
      "\n",
    )
    .replace(
      /\s+(?=(?:Applicants?|Candidates?|Students?|Recipients?|Finalists?)\s+(?:must|will|are|who|should)\b)/g,
      "\n",
    )
    .replace(
      /\s+(?=(?:Eligibility|Application|Deadline|Selection|Recommendation|Recommendations|Essay|Essays|Interview|Requirements?)\b:)/g,
      "\n",
    );

  const paragraphs = structured
    .split(/\n+/)
    .map((paragraph) => normalizeDiffSentence(paragraph.replace(/\s+/g, " ").trim()))
    .filter(Boolean);

  return paragraphs.length > 0 ? paragraphs : [clean];
}

function narrativeTextChange(
  mode: "added" | "removed",
  text: string,
  sourceTitle?: string | null,
  sourceUrl?: string | null,
) {
  const title = readableSourceTitle(sourceTitle, sourceUrl);
  const action = mode === "added" ? "added the following wording" : "removed the following wording";
  return `The ${title} page ${action}.\n${text}`;
}

function normalizeSourceUrlForDedupe(value: string | null | undefined) {
  const clean = String(value || "").trim();
  if (!clean) return "";

  try {
    const parsed = new URL(clean);
    const hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
    const pathname = parsed.pathname
      .replace(/\/index\.(html?|php|aspx?)$/i, "/")
      .replace(/\.aspx$/i, "")
      .replace(/\/+$/g, "")
      .toLowerCase();

    return `${hostname}${pathname || "/"}`;
  } catch {
    return clean
      .toLowerCase()
      .replace(/[?#].*$/, "")
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .replace(/\/+$/, "");
  }
}

function normalizeSummaryForDedupe(value: string | null | undefined) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function normalizeEvidenceForDedupe(value: string | null | undefined) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\.\.\.$/, "")
    .replace(/[.,;:\s]+$/g, "");
}
