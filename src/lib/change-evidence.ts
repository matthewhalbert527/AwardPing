import { changeSummaryDisplayParts } from "@/lib/change-summary";
import {
  changeDetailsLabel,
  isMeaningfulChangeDetails,
  parseChangeDetails,
} from "@/lib/change-details";
import { cleanDisplayText } from "@/lib/display-text";

const UNRELATED_STRUCTURED_PAIR_SUMMARY =
  "The stored added and removed text appears in different parts of the page, so this update is not shown as a direct replacement.";

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
  currentSnippets: string[];
  previousSnippets: string[];
  beforeSnippet: string | null;
  afterSnippet: string | null;
  summaryLabel: string | null;
  summarySnippet: string | null;
  highlightedUrl: string | null;
  advisorImpact: string | null;
  changeTypeLabel: string | null;
  sectionLabel: string | null;
  confidenceLabel: string | null;
  descriptionSourceLabel: string | null;
  relationshipNote: string | null;
  hasSnapshotEvidence: boolean;
  hasSummaryEvidence: boolean;
  hasStructuredEvidence: boolean;
  isFirstObservation: boolean;
  firstObservedAt: string | null;
  recognizedAt: string | null;
};

export function buildChangeEvidence(input: ChangeEvidenceInput): ChangeEvidence {
  const previousClean = normalizeEvidenceText(input.previousTextSample || "");
  const nextClean = normalizeEvidenceText(input.newTextSample || "");
  const rawHasSnapshotEvidence = Boolean(previousClean || nextClean);
  const details = parseChangeDetails(input.changeDetails);
  const isFirstObservation = details?.event_kind === "new_official_document";
  const detailsAlreadyInComparison = details && !isFirstObservation
    ? structuredDetailsAlreadyInComparison(details, previousClean, nextClean)
    : false;
  const detailsMeaningful = details
    ? isMeaningfulChangeDetails(details) !== false && !detailsAlreadyInComparison
    : true;
  const suppressSnapshotEvidence = details
    ? suppressSnapshotEvidenceForDetails(details) || detailsAlreadyInComparison
    : false;
  const hasSnapshotEvidence = rawHasSnapshotEvidence && !suppressSnapshotEvidence;
  const unrelatedStructuredPair = details && detailsMeaningful && !suppressSnapshotEvidence
    ? hasUnrelatedStructuredPair(details, previousClean, nextClean)
    : false;
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
  const removedSnippets = !isFirstObservation && previousClean && nextClean && !suppressSnapshotEvidence
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
  const beforeSnippet = isFirstObservation || suppressSnapshotEvidence
    ? null
    : details
      ? unrelatedStructuredPair
        ? null
        : structuredSnippet(details.before) || null
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
  const includeSnapshotSentenceSnippets = details
    ? shouldIncludeSnapshotSentenceSnippets(details)
    : true;
  const currentSnippets = suppressSnapshotEvidence
    ? []
    : details
      ? evidenceSnippetList([
          details.after,
          ...details.structured_diff.added_text,
          ...(includeSnapshotSentenceSnippets ? addedSnippets : []),
        ])
      : evidenceSnippetList([afterSnippet, ...addedSnippets]);
  const previousSnippets = isFirstObservation || suppressSnapshotEvidence
    ? []
    : details
      ? evidenceSnippetList([
          details.before,
          ...details.structured_diff.removed_text,
          ...(includeSnapshotSentenceSnippets ? removedSnippets : []),
        ])
      : evidenceSnippetList([beforeSnippet, ...removedSnippets]);

  return {
    addedSnippets,
    removedSnippets,
    currentSnippets,
    previousSnippets,
    beforeSnippet: beforeSnippet || null,
    afterSnippet: afterSnippet || null,
    summaryLabel: details && detailsMeaningful
      ? changeDetailsLabel(details, summaryEvidence?.label || "What changed")
      : summaryEvidence?.label || null,
    summarySnippet: summaryEvidence?.text || displaySummary || null,
    highlightedUrl: buildTextFragmentUrl(input.sourceUrl, highlightText),
    advisorImpact: detailsMeaningful && !unrelatedStructuredPair
      ? details?.advisor_impact || null
      : null,
    changeTypeLabel: details && detailsMeaningful ? changeDetailsLabel(details, "Update") : null,
    sectionLabel: details && detailsMeaningful ? details.section || details.structured_diff.likely_section : null,
    confidenceLabel: details && detailsMeaningful ? confidenceLabel(details.confidence) : null,
    descriptionSourceLabel: details && detailsMeaningful ? descriptionSourceLabel(details) : null,
    relationshipNote: unrelatedStructuredPair ? UNRELATED_STRUCTURED_PAIR_SUMMARY : null,
    hasSnapshotEvidence,
    hasSummaryEvidence: Boolean(summaryEvidence?.text || details?.reader_summary),
    hasStructuredEvidence: Boolean(details && detailsMeaningful),
    isFirstObservation,
    firstObservedAt: isFirstObservation ? details?.first_observed_at || null : null,
    recognizedAt: isFirstObservation ? details?.recognized_at || null : null,
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

function hasUnrelatedStructuredPair(
  details: NonNullable<ReturnType<typeof parseChangeDetails>>,
  previousText: string,
  nextText: string,
) {
  const before = normalizeEvidenceText(details.before || "");
  const after = normalizeEvidenceText(details.after || "");
  if (!before || !after || !previousText || !nextText) return false;

  const beforeMatch = snippetMatch(previousText, before);
  const afterMatch = snippetMatch(nextText, after);
  if (!beforeMatch || !afterMatch) return false;

  const snippetsDiverge = tokenSetsDiverge(before, after, 8);
  if (!snippetsDiverge) return false;

  const previousContext = localContext(previousText, beforeMatch.index, beforeMatch.length);
  const nextContext = localContext(nextText, afterMatch.index, afterMatch.length);
  return tokenSetsDiverge(previousContext, nextContext, 6);
}

function snippetMatch(text: string, snippet: string) {
  const exactIndex = text.indexOf(snippet);
  if (exactIndex >= 0) return { index: exactIndex, length: snippet.length };

  const snippetKey = sentenceKey(snippet);
  if (snippetKey.length < 25) return null;

  const textKey = sentenceKey(text);
  const keyIndex = textKey.indexOf(snippetKey);
  if (keyIndex < 0) return null;

  const approximateIndex = Math.min(text.length, Math.max(0, keyIndex));
  return { index: approximateIndex, length: Math.min(snippet.length, text.length - approximateIndex) };
}

function localContext(text: string, index: number, length: number) {
  const radius = 240;
  const before = text.slice(Math.max(0, index - radius), index);
  const after = text.slice(index + length, Math.min(text.length, index + length + radius));
  return `${before} ${after}`;
}

function tokenSetsDiverge(left: string, right: string, minimumTokens: number) {
  const leftTokens = evidenceTokens(left);
  const rightTokens = evidenceTokens(right);
  if (leftTokens.size < minimumTokens || rightTokens.size < minimumTokens) return false;

  let shared = 0;
  leftTokens.forEach((token) => {
    if (rightTokens.has(token)) shared += 1;
  });

  const unionSize = new Set([...leftTokens, ...rightTokens]).size;
  const jaccard = unionSize ? shared / unionSize : 0;
  const coverage = shared / Math.min(leftTokens.size, rightTokens.size);
  return jaccard < 0.16 && coverage < 0.28;
}

function evidenceTokens(value: string) {
  const stopWords = new Set([
    "about",
    "after",
    "again",
    "also",
    "and",
    "are",
    "award",
    "awards",
    "been",
    "before",
    "from",
    "has",
    "have",
    "more",
    "page",
    "program",
    "programs",
    "scholarship",
    "scholarships",
    "section",
    "students",
    "that",
    "the",
    "their",
    "this",
    "through",
    "to",
    "united",
    "was",
    "were",
    "with",
  ]);

  return new Set(
    sentenceKey(value)
      .split(/\s+/)
      .filter((token) => token.length >= 3 && !stopWords.has(token)),
  );
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
  return splitEvidenceSentences(normalizeEvidenceText(text))
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 25);
}

function splitEvidenceSentences(text: string) {
  return protectSentenceAbbreviations(text)
    .split(/(?<=[.!?])\s+|(?<=:)\s+(?=[A-Z0-9])/)
    .map(restoreSentenceAbbreviations);
}

const sentenceDotPlaceholder = "__AP_SENTENCE_DOT__";

function protectSentenceAbbreviations(value: string) {
  return value
    .replace(/\bM\.\s*D\./g, `M${sentenceDotPlaceholder}D${sentenceDotPlaceholder}`)
    .replace(/\bPh\.\s*D\./gi, `Ph${sentenceDotPlaceholder}D${sentenceDotPlaceholder}`)
    .replace(/\bU\.\s*S\./g, `U${sentenceDotPlaceholder}S${sentenceDotPlaceholder}`)
    .replace(/\bU\.\s*K\./g, `U${sentenceDotPlaceholder}K${sentenceDotPlaceholder}`)
    .replace(/\bi\.\s*e\./gi, `i${sentenceDotPlaceholder}e${sentenceDotPlaceholder}`)
    .replace(/\be\.\s*g\./gi, `e${sentenceDotPlaceholder}g${sentenceDotPlaceholder}`);
}

function restoreSentenceAbbreviations(value: string) {
  return value.replaceAll(sentenceDotPlaceholder, ".");
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

function evidenceSnippetList(values: Array<string | null | undefined>) {
  return uniqueEvidenceSnippets(values.map(structuredSnippet).filter(Boolean)).slice(0, 4);
}

function shouldIncludeSnapshotSentenceSnippets(
  details: NonNullable<ReturnType<typeof parseChangeDetails>>,
) {
  const flags = new Set([...details.quality_flags, ...details.structured_diff.noise_flags]);
  return details.change_type === "content_update" || flags.has("profile_testimonial_change");
}

function uniqueEvidenceSnippets(values: string[]) {
  const seen = new Set<string>();
  const snippets: string[] = [];

  for (const value of values) {
    const clean = normalizeEvidenceText(value);
    const key = sentenceKey(clean);
    if (!clean || key.length < 8 || seen.has(key)) continue;

    const alreadyCovered = snippets.some((existing) => {
      const existingKey = sentenceKey(existing);
      return existingKey.includes(key) || key.includes(existingKey);
    });
    if (alreadyCovered) continue;

    seen.add(key);
    snippets.push(clean);
  }

  return snippets;
}

function confidenceLabel(value: string) {
  if (value === "high") return "High confidence";
  if (value === "medium") return "Medium confidence";
  return "Low confidence";
}

function descriptionSourceLabel(
  details: NonNullable<ReturnType<typeof parseChangeDetails>>,
) {
  if (
    details.generation_provider === "gemini" ||
    details.generation_provider === "openai"
  ) {
    if (details.generation_status === "generated") return "AI-generated description";
    return "Generated description";
  }

  return "Generated description";
}

function normalizeEvidenceText(value: string) {
  return cleanDisplayText(value).replace(/\bAward Ping\b/g, "AwardPing");
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
