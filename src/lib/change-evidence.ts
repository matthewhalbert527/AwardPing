import { changeSummaryDisplayParts } from "@/lib/change-summary";
import {
  changeDetailsLabel,
  isMeaningfulChangeDetails,
  parseChangeDetails,
} from "@/lib/change-details";
import { cleanDisplayText } from "@/lib/display-text";

export type ChangeEvidenceInput = {
  sourceUrl?: string | null;
  sourceTitle?: string | null;
  summary?: string | null;
  changeDetails?: unknown;
  previousTextSample?: string | null;
  newTextSample?: string | null;
};

export type ChangeEvidence = {
  addedSnippets: string[];
  removedSnippets: string[];
  beforeSnippet: string | null;
  afterSnippet: string | null;
  summaryLabel: string | null;
  summarySnippet: string | null;
  highlightedUrl: string | null;
  advisorImpact: string | null;
  hasSnapshotEvidence: boolean;
  hasSummaryEvidence: boolean;
  hasStructuredEvidence: boolean;
};

export function buildChangeEvidence(input: ChangeEvidenceInput): ChangeEvidence {
  const previousClean = normalizeEvidenceText(input.previousTextSample || "");
  const nextClean = normalizeEvidenceText(input.newTextSample || "");
  const rawHasSnapshotEvidence = Boolean(previousClean || nextClean);
  const details = parseChangeDetails(input.changeDetails);
  const detailsAlreadyInComparison = details
    ? structuredDetailsAlreadyInComparison(details, previousClean, nextClean)
    : false;
  const detailsMeaningful = details
    ? isMeaningfulChangeDetails(details) !== false && !detailsAlreadyInComparison
    : true;
  const suppressSnapshotEvidence = details
    ? suppressSnapshotEvidenceForDetails(details) || detailsAlreadyInComparison
    : false;
  const hasSnapshotEvidence = rawHasSnapshotEvidence && !suppressSnapshotEvidence;
  const displaySummary =
    details && !detailsMeaningful
      ? "No award-relevant wording changed in the stored excerpt."
      : details?.reader_summary || input.summary;
  const summaryEvidence = buildSummaryEvidence(
    displaySummary,
    input.sourceUrl,
    input.sourceTitle,
    detailsMeaningful ? input.changeDetails : undefined,
  );
  const addedSnippets = previousClean && nextClean && !suppressSnapshotEvidence
    ? changedSentences(previousClean, nextClean, "added").slice(0, 3)
    : [];
  const removedSnippets = previousClean && nextClean && !suppressSnapshotEvidence
    ? changedSentences(previousClean, nextClean, "removed").slice(0, 3)
    : [];
  const fallback = suppressSnapshotEvidence
    ? { before: "", after: "" }
    : changedTextFallback(previousClean, nextClean);
  const afterSnippet = suppressSnapshotEvidence
    ? null
    : details
      ? structuredSnippet(details.after) || null
      : addedSnippets[0] ||
        fallback.after ||
        firstMeaningfulSentence(nextClean) ||
        truncateEvidence(nextClean, 240);
  const beforeSnippet = suppressSnapshotEvidence
    ? null
    : details
      ? structuredSnippet(details.before) || null
      : removedSnippets[0] ||
        (!addedSnippets.length
          ? fallback.before || firstMeaningfulSentence(previousClean) || truncateEvidence(previousClean, 240)
          : "");
  const highlightText = suppressSnapshotEvidence
    ? null
    : details?.after ||
      (hasSnapshotEvidence
        ? addedSnippets[0] || fallback.after || afterSnippet || summaryEvidence?.highlightText
        : summaryEvidence?.highlightText);

  return {
    addedSnippets,
    removedSnippets,
    beforeSnippet: beforeSnippet || null,
    afterSnippet: afterSnippet || null,
    summaryLabel: details && detailsMeaningful
      ? changeDetailsLabel(details, summaryEvidence?.label || "What changed")
      : summaryEvidence?.label || null,
    summarySnippet: summaryEvidence?.text || displaySummary || null,
    highlightedUrl: buildTextFragmentUrl(input.sourceUrl, highlightText),
    advisorImpact: detailsMeaningful ? details?.advisor_impact || null : null,
    hasSnapshotEvidence,
    hasSummaryEvidence: Boolean(summaryEvidence?.text || details?.reader_summary),
    hasStructuredEvidence: Boolean(details && detailsMeaningful),
  };
}

export function buildTextFragmentUrl(sourceUrl: string | null | undefined, text: string | null | undefined) {
  const fragment = textFragmentText(text);
  if (!sourceUrl || !fragment) return null;

  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    return null;
  }

  if (!["http:", "https:"].includes(url.protocol)) return null;
  if (url.pathname.toLowerCase().endsWith(".pdf")) return null;

  url.hash = "";
  return `${url.toString()}#:~:text=${encodeURIComponent(fragment)}`;
}

function changedSentences(previousText: string, nextText: string, mode: "added" | "removed") {
  const previousSentences = sentenceCandidates(previousText);
  const nextSentences = sentenceCandidates(nextText);
  const previousKeys = new Set(previousSentences.map(sentenceKey));
  const nextKeys = new Set(nextSentences.map(sentenceKey));
  const source = mode === "added" ? nextSentences : previousSentences;
  const comparison = mode === "added" ? previousKeys : nextKeys;
  const comparisonTextKey = ` ${sentenceKey(mode === "added" ? previousText : nextText)} `;
  const comparisonCompactTextKey = compactSentenceKey(
    mode === "added" ? previousText : nextText,
  );

  return source
    .filter((sentence) => !comparison.has(sentenceKey(sentence)))
    .filter((sentence) => !comparisonTextKey.includes(` ${sentenceKey(sentence)} `))
    .filter((sentence) => !comparisonContainsCompactSentence(comparisonCompactTextKey, sentence))
    .filter(isUsefulEvidenceSentence)
    .map((sentence) => truncateEvidence(sentence, 360));
}

function structuredDetailsAlreadyInComparison(
  details: NonNullable<ReturnType<typeof parseChangeDetails>>,
  previousText: string,
  nextText: string,
) {
  const before = structuredSnippet(details.before);
  const after = structuredSnippet(details.after);
  const afterWasAlreadyPresent = Boolean(after && previousText && textContainsSnippet(previousText, after));
  const beforeStillPresent = Boolean(before && nextText && textContainsSnippet(nextText, before));

  if (after && !before) return afterWasAlreadyPresent;
  if (before && !after) return beforeStillPresent;
  return false;
}

function textContainsSnippet(text: string, snippet: string) {
  const snippetKey = sentenceKey(snippet);
  if (snippetKey.length < 25) return false;
  return ` ${sentenceKey(text)} `.includes(` ${snippetKey} `);
}

function changedTextFallback(previousText: string, nextText: string) {
  if (!previousText || !nextText || previousText === nextText) {
    return { before: "", after: "" };
  }

  const prefixLength = commonPrefixLength(previousText, nextText);
  const suffixLength = commonSuffixLength(
    previousText.slice(prefixLength),
    nextText.slice(prefixLength),
  );
  const before = previousText.slice(prefixLength, previousText.length - suffixLength);
  const after = nextText.slice(prefixLength, nextText.length - suffixLength);

  return {
    before: truncateEvidence(before, 260),
    after: truncateEvidence(after, 300),
  };
}

function buildSummaryEvidence(
  summary: string | null | undefined,
  sourceUrl: string | null | undefined,
  sourceTitle: string | null | undefined,
  changeDetails?: unknown,
) {
  const clean = normalizeEvidenceText(summary || "");
  if (!clean) return null;

  const parts = changeSummaryDisplayParts(clean, sourceUrl, sourceTitle, changeDetails);
  const text = truncateEvidence(
    (parts.paragraphs.length > 0 ? parts.paragraphs.join(" ") : parts.text) || clean,
    520,
  );
  if (!text) return null;

  return {
    label: parts.label === "Update" ? "Detected change" : parts.label,
    text,
    highlightText: summaryHighlightText(clean),
  };
}

function summaryHighlightText(summary: string) {
  const clean = normalizeEvidenceText(summary);
  const normalized = clean.toLowerCase();

  if (normalized.startsWith("added date context:")) {
    return cleanSummaryDiffText(clean.replace(/^added date context:\s*/i, ""));
  }

  if (normalized.startsWith("new funding amount language appeared:")) {
    return cleanSummaryDiffText(clean.replace(/^new funding amount language appeared:\s*/i, ""));
  }

  if (normalized.startsWith("added text includes:")) {
    return cleanSummaryDiffText(clean.replace(/^added text includes:\s*/i, ""));
  }

  if (normalized.startsWith("new text appears after the previously stored excerpt:")) {
    return cleanSummaryDiffText(
      clean.replace(/^new text appears after the previously stored excerpt:\s*/i, ""),
    );
  }

  if (normalized.startsWith("changed text from")) {
    const quotedAfter = clean.match(/\bto\s+"([^"]+)"/i)?.[1];
    if (quotedAfter) return cleanSummaryDiffText(quotedAfter);

    const afterTo = clean.match(/\bto\s+(.+)$/i)?.[1];
    if (afterTo) return cleanSummaryDiffText(afterTo);
  }

  return null;
}

function cleanSummaryDiffText(value: string) {
  const clean = normalizeEvidenceText(value)
    .replace(/\s*;\s*/g, " ")
    .replace(/\.\.+$/g, ".")
    .trim();
  const quotedSnippets = [...clean.matchAll(/"([^"]+)"/g)]
    .map((match) => normalizeSummarySentence(match[1]))
    .filter(Boolean);

  if (quotedSnippets.length > 0) return quotedSnippets.join(" ");
  return normalizeSummarySentence(clean.replace(/^"+|"+$/g, ""));
}

function normalizeSummarySentence(value: string) {
  const clean = normalizeEvidenceText(value).replace(/\.\.+$/g, ".");
  if (!clean) return "";
  return /[.!?]$/.test(clean) ? clean : `${clean}.`;
}

function sentenceCandidates(text: string) {
  return normalizeEvidenceText(text)
    .split(/(?<=[.!?])\s+|(?<=:)\s+(?=[A-Z0-9])/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 25);
}

function sentenceKey(sentence: string) {
  return sentence.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function compactSentenceKey(sentence: string) {
  return sentence.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function comparisonContainsCompactSentence(comparisonCompactTextKey: string, sentence: string) {
  const compactKey = compactSentenceKey(sentence);
  return compactKey.length >= 40 && comparisonCompactTextKey.includes(compactKey);
}

function firstMeaningfulSentence(text: string) {
  return sentenceCandidates(text).find(isUsefulEvidenceSentence) || "";
}

function isUsefulEvidenceSentence(sentence: string) {
  const lower = sentence.toLowerCase();
  if (/\b(learn more|read more|click here|skip to|main menu|toggle page navigation|search menu|read current issue|cart|dismiss|login|copyright|privacy policy|all rights reserved|facebook|instagram|x\.com|twitter|linkedin|youtube|subscribe|newsletter)\b/.test(lower)) {
    return false;
  }
  if (/\b(past recipients?|recipient profiles?|latest news|press release|received the .* award|receives the .* award|photo by|getty images|new york, new york)\b/.test(lower)) {
    return false;
  }
  return /\b(applications?|apply|deadline|due|opens?|closes?|eligible|eligibility|requirements?|recommendations?|transcripts?|essays?|interviews?|tuition|stipend|funding|fellows?|fellowship|scholarships?|awards?|admissions?|selection|nomination|candidates?|program|internship|grant|submit|submission|citizenship|gpa|pdf|guide|instructions?)\b/.test(lower);
}

function suppressSnapshotEvidenceForDetails(details: NonNullable<ReturnType<typeof parseChangeDetails>>) {
  if (isMeaningfulChangeDetails(details) === false) return true;
  if (!details.is_alert_worthy) return true;
  const flags = new Set([...details.quality_flags, ...details.structured_diff.noise_flags]);
  return [
    "sample_expansion",
    "raw_scrape_signal",
    "orphan_punctuation",
    "no_actual_changed_fact",
    "unsupported_structured_fact",
    "indistinct_truncated_snippet",
  ].some((flag) => flags.has(flag));
}

function textFragmentText(text: string | null | undefined) {
  return truncateEvidence(normalizeEvidenceText(text || ""), 180)
    .replace(/^["'“”]+|["'“”]+$/g, "")
    .trim();
}

function truncateEvidence(value: string, maxLength: number) {
  const clean = normalizeEvidenceText(value);
  if (clean.length <= maxLength) return clean;

  const truncated = clean.slice(0, maxLength + 1);
  const boundary = truncated.lastIndexOf(" ");
  return `${truncated.slice(0, boundary > maxLength * 0.65 ? boundary : maxLength).trim()}...`;
}

function structuredSnippet(value: string | null | undefined) {
  if (!value) return "";
  return truncateEvidence(value, 520);
}

function normalizeEvidenceText(value: string) {
  return cleanDisplayText(value);
}

function commonPrefixLength(left: string, right: string) {
  let index = 0;
  while (index < left.length && index < right.length && left[index] === right[index]) {
    index += 1;
  }
  return index;
}

function commonSuffixLength(left: string, right: string) {
  let index = 0;
  while (
    index < left.length &&
    index < right.length &&
    left[left.length - 1 - index] === right[right.length - 1 - index]
  ) {
    index += 1;
  }
  return index;
}
