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
    !looksLikeCounterOnlyChange(clean, changeDetails) &&
    !looksLikeAnimatedCounterChange(clean) &&
    !looksLikeProfileRosterChange(clean, changeDetails) &&
    !looksLikeDocumentMetadataOnlyChange(clean) &&
    !looksLikeFundraisingOnlyChange(clean, changeDetails) &&
    !looksLikeNavigationOnlyChange(clean, changeDetails) &&
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

  return softenReplacementLanguage(clean);
}

function rewritePathSourceLabel(summary: string, sourceUrl?: string | null) {
  if (!sourceUrl) return summary;
  return summary.replace(
    /^The\s+(\/[^\s]+|[a-z0-9-]+(?:\/[a-z0-9-]+)+\/?)\s+page\s+/i,
    () => `The ${readableSourceTitle(null, sourceUrl)} page `,
  );
}

function softenReplacementLanguage(summary: string) {
  const changed = summary.match(
    /^The\s+(.+?)\s+page\s+changed\s+wording\s+from\s+"([^"]+)"\s+to\s+"([^"]+)"\.?$/i,
  );
  if (!changed) return summary;

  const [, sourceName, before, after] = changed;
  return `The ${sourceName} page has updated wording. Current stored wording includes: ${sentenceForDisplay(
    after,
  )} Previous stored wording included: ${sentenceForDisplay(before)}`;
}

function sentenceForDisplay(value: string) {
  const clean = cleanDisplayText(value).replace(/\.\.\.$/, "").trim();
  if (!clean) return "";
  return /[.!?]$/.test(clean) ? clean : `${clean}.`;
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
  const semanticSeen: SemanticChangeSignature[] = [];

  return changes.filter((change) => {
    const key = changeSummaryDedupeKey(change);
    if (!key) return false;

    if (seen.has(key)) return false;

    const semanticSignature = semanticChangeDedupeSignature(change);
    if (
      semanticSignature &&
      semanticSeen.some((existing) =>
        semanticChangeSignaturesOverlap(existing, semanticSignature),
      )
    ) {
      return false;
    }

    seen.add(key);
    if (semanticSignature) semanticSeen.push(semanticSignature);
    return true;
  });
}

type SemanticChangeSignature = {
  scope: string;
  tokens: Set<string>;
  conceptKeys: Set<string>;
};

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

function semanticChangeDedupeSignature(change: {
  shared_award_id?: string | null;
  source_url?: string | null;
  summary: string | null | undefined;
  change_details?: unknown;
  changeDetails?: unknown;
}): SemanticChangeSignature | null {
  const details = parseChangeDetails(change.change_details ?? change.changeDetails);
  if (!details || !details.is_alert_worthy) return null;

  const sourceKey = normalizeSourceUrlForDedupe(change.source_url || details.source?.source_url);
  const awardKey = String(change.shared_award_id || details.source?.award_name || "").trim().toLowerCase();
  if (!sourceKey || !awardKey) return null;

  const sectionKey = normalizeSemanticScopePart(
    details.section || details.structured_diff.likely_section || "",
  );
  const evidenceText = [
    details.before,
    details.after,
    ...details.structured_diff.added_text,
    ...details.structured_diff.removed_text,
    ...details.structured_diff.date_changes,
    ...details.structured_diff.amount_changes,
  ]
    .filter(Boolean)
    .join(" ");
  const tokens = semanticChangeTokens(evidenceText);
  const conceptText = [change.summary, details.reader_summary, evidenceText]
    .filter(Boolean)
    .join(" ");
  const conceptKeys = semanticChangeConceptKeys(conceptText);
  if (tokens.size < 8 && conceptKeys.size === 0) return null;
  if (tokens.size < 4) return null;

  return {
    scope: `award:${awardKey}|url:${sourceKey}|section:${sectionKey}`,
    tokens,
    conceptKeys,
  };
}

function semanticChangeSignaturesOverlap(
  existing: SemanticChangeSignature,
  candidate: SemanticChangeSignature,
) {
  if (existing.scope !== candidate.scope) return false;

  const intersection = setIntersectionSize(existing.tokens, candidate.tokens);
  const smallerSize = Math.min(existing.tokens.size, candidate.tokens.size);
  const unionSize = existing.tokens.size + candidate.tokens.size - intersection;
  for (const conceptKey of candidate.conceptKeys) {
    if (
      existing.conceptKeys.has(conceptKey) &&
      intersection >= 7 &&
      intersection / smallerSize >= 0.55
    ) {
      return true;
    }
  }

  return intersection >= 10 && intersection / smallerSize >= 0.72 && intersection / unionSize >= 0.45;
}

function semanticChangeTokens(value: string) {
  const normalized = cleanDisplayText(value)
    .toLowerCase()
    .replace(/\bd\.?\s*c\.?\b/g, "washington")
    .replace(/[^a-z0-9]+/g, " ");
  const stopwords = new Set([
    "about",
    "acceptance",
    "added",
    "after",
    "again",
    "award",
    "before",
    "changed",
    "changes",
    "check",
    "clarifies",
    "college",
    "complete",
    "congress",
    "current",
    "details",
    "during",
    "eligible",
    "eligibility",
    "following",
    "however",
    "information",
    "necessary",
    "participants",
    "policy",
    "preferred",
    "previous",
    "program",
    "requirement",
    "requirements",
    "section",
    "source",
    "student",
    "students",
    "summary",
    "updated",
    "while",
  ]);

  return new Set(
    normalized
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 5 && !stopwords.has(token) && !/^\d+$/.test(token)),
  );
}

function semanticChangeConceptKeys(value: string) {
  const normalized = cleanDisplayText(value)
    .toLowerCase()
    .replace(/\bd\.?\s*c\.?\b/g, "washington")
    .replace(/\s+/g, " ");
  const conceptKeys = new Set<string>();

  if (
    /\battendance\b/.test(normalized) &&
    /\bwashington\b/.test(normalized) &&
    /\b(?:opt out|second half|portion)\b/.test(normalized)
  ) {
    conceptKeys.add("attendance-washington-optional");
  }
  if (
    /\bapplication\b/.test(normalized) &&
    /\bnot complete\b/.test(normalized) &&
    /\brecommendations?\b/.test(normalized)
  ) {
    conceptKeys.add("application-recommendations-incomplete");
  }

  return conceptKeys;
}

function normalizeSemanticScopePart(value: string) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function setIntersectionSize<T>(left: Set<T>, right: Set<T>) {
  let count = 0;
  for (const value of left) {
    if (right.has(value)) count += 1;
  }
  return count;
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

function looksLikeAnimatedCounterChange(summary: string) {
  const normalized = summary.toLowerCase();
  const numericValues = summary.match(/\b\d{3,}(?:,\d{3})*\b/g) || [];

  if (numericValues.length < 2) return false;

  const hasCounterSignal =
    /\b(counter|count[- ]?up|animated|animation|stat(?:istic)?s?|metric|kpi|impact number|number of|total number)\b/.test(
      normalized,
    ) ||
    /\b(participating universities|universities and colleges|scholarships awarded|awarded globally|total investment|investment amount)\b/.test(
      normalized,
    );

  const hasCounterDrift =
    /\b(?:increased|decreased|changed|moved|went|dropped|rose|updated)\s+from\s+\d[\d,]*\s+to\s+\d[\d,]*/.test(
      normalized,
    ) || /\bfrom\s+\d[\d,]*\s+to\s+\d[\d,]*/.test(normalized);

  const hasApplicantFacingSignal = /\b(deadline|due|eligible|eligibility|requirement|recommendation|transcript|essay|nomination|submit|submission|application (?:deadline|material|portal|opens?|closes?)|award amount|stipend|tuition|funding)\b/.test(
    normalized,
  );

  return hasCounterSignal && hasCounterDrift && !hasApplicantFacingSignal;
}

function looksLikeCounterOnlyChange(summary: string, changeDetails: unknown) {
  const details = parseChangeDetails(changeDetails);
  const structuredDiff = details?.structured_diff;
  const text = [
    summary,
    details?.reader_summary,
    details?.advisor_impact,
    details?.section,
    details?.change_type,
    structuredDiff?.likely_section,
    details?.before,
    details?.after,
    ...(structuredDiff?.added_text || []),
    ...(structuredDiff?.removed_text || []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (!text) return false;

  const hasCounterSignal =
    /\b(?:view count|views count|hit count|read count|visit count|view_count|page views?)\b/.test(
      text,
    ) ||
    /\b(?:writer'?s id|post id)\b/.test(text) ||
    /\bview[-_ ]?count[-_ ]?(?:change|update)\b/.test(text);
  if (!hasCounterSignal) return false;

  const dateChanges = structuredDiff?.date_changes || [];
  const amountChanges = structuredDiff?.amount_changes || [];
  if (dateChanges.length > 0 || amountChanges.length > 0) return false;

  const before = normalizeCounterEvidence(details?.before || structuredDiff?.removed_text?.join(" ") || "");
  const after = normalizeCounterEvidence(details?.after || structuredDiff?.added_text?.join(" ") || "");
  const evidenceOnlyCounterDrift = Boolean(before && after && before === after);
  if (evidenceOnlyCounterDrift) return true;

  const strippedApplicantText = stripUnchangedApplicantReferences(text);
  if (hasApplicantFacingChangeSignal(strippedApplicantText)) return false;

  const explicitlyCounterOnly =
    /\b(?:only|just|merely)\b[^.]{0,80}\b(?:view count|hit count|read count|page views?)\b/.test(
      text,
    ) ||
    /\bdescription text appears to be identical\b/.test(text) ||
    /\bdoes not affect\b[^.]{0,100}\b(?:deadline|eligibility|application|requirements?)\b/.test(
      text,
    );

  return explicitlyCounterOnly || /\bview[-_ ]?count[-_ ]?(?:change|update)\b/.test(text);
}

function normalizeCounterEvidence(value: string) {
  return cleanDisplayText(value)
    .toLowerCase()
    .replace(/\b\d{2,}(?:,\d{3})*\b/g, " ")
    .replace(/\bupdated description\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeDocumentMetadataOnlyChange(summary: string) {
  const normalized = summary.toLowerCase();
  const hasDocumentSignal = /\b(pdf|document|docx?|word version|form|file)\b/.test(normalized);
  if (!hasDocumentSignal) return false;

  const metadataOnlyLanguage =
    /\bspecific changes? (?:within|in) (?:the )?(?:pdf|document|file) (?:are|were) not detailed\b/.test(normalized) ||
    /\bfile itself has changed\b/.test(normalized) ||
    /\bfile size (?:has )?(?:increased|decreased|changed)\b/.test(normalized) ||
    /\bpotential change in content or format\b/.test(normalized);
  const genericDocumentUpdate =
    /\b(?:pdf|document|form|file)\b.*\b(?:has been updated|was updated|changed)\b/.test(
      normalized,
    ) &&
    !/\b(?:deadline|due|eligible|eligibility|required|requirement|recommendation letter|transcript|essay|nomination|award amount|stipend|tuition|funding)\b/.test(
      normalized,
    );

  return metadataOnlyLanguage || genericDocumentUpdate;
}

function looksLikeFundraisingOnlyChange(summary: string, changeDetails: unknown) {
  const details = parseChangeDetails(changeDetails);
  const fundraisingText = [
    summary,
    details?.reader_summary,
    details?.before,
    details?.after,
    details?.section,
    details?.advisor_impact,
    ...(details?.structured_diff.added_text || []),
    ...(details?.structured_diff.removed_text || []),
    ...(details?.structured_diff.amount_changes || []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (!fundraisingText) return false;

  const hasFundraisingSignal =
    /\b(donate|donation|donor|tribute|gift amount|one[- ]time donation|monthly gift|fundraising|cart|checkout|sponsor|sponsorship)\b/.test(
      fundraisingText,
    );
  if (!hasFundraisingSignal) return false;

  const applicantText = [
    summary,
    details?.reader_summary,
    details?.before,
    details?.after,
    details?.advisor_impact,
    ...(details?.structured_diff.added_text || []),
    ...(details?.structured_diff.removed_text || []),
    ...(details?.structured_diff.amount_changes || []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return !hasApplicantFacingChangeSignal(stripUnchangedApplicantReferences(applicantText));
}

function looksLikeNavigationOnlyChange(summary: string, changeDetails: unknown) {
  const details = parseChangeDetails(changeDetails);
  const structuredDiff = details?.structured_diff;
  const text = [
    summary,
    details?.reader_summary,
    details?.advisor_impact,
    details?.section,
    details?.change_type,
    structuredDiff?.likely_section,
    ...(structuredDiff?.added_text || []),
    ...(structuredDiff?.removed_text || []),
    details?.before,
    details?.after,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (!text) return false;

  const hasNavigationSignal =
    /\b(navigation menu|navigation links?|left[- ]hand navigation|left sidebar|sidebar links?|menu items?|link order|order of (?:the )?(?:main )?(?:navigation links|links|menu items)|page structure|content[_ -]?reorder|ui[_ -]?change)\b/.test(
      text,
    ) ||
    /\b(?:reordered|swapped positions?|moved|positioned before|listed before|located below|distinct link)\b/.test(
      text,
    );
  if (!hasNavigationSignal) return false;

  const dateChanges = structuredDiff?.date_changes || [];
  const amountChanges = structuredDiff?.amount_changes || [];
  if (dateChanges.length > 0 || amountChanges.length > 0) return false;

  const concreteAwardFactChanged =
    /\b(?:new|added|removed|changed|updated)\s+(?:application deadline|deadline|due date|award amount|stipend|tuition|funding amount)\b/.test(
      text,
    ) ||
    /\b(?:applications?|nominations?)\s+(?:are|is)?\s*(?:now\s+)?(?:open|closed|due)\b/.test(
      text,
    ) ||
    /\b(?:deadline|due date)\s+(?:is|was|has been|changed|moved|extended)\b/.test(text) ||
    /\b(?:submit|apply|complete)\s+(?:by|before|no later than)\b/.test(text);

  return !concreteAwardFactChanged;
}

function looksLikeProfileRosterChange(summary: string, changeDetails: unknown) {
  const details = parseChangeDetails(changeDetails);
  const flags = new Set([
    ...(details?.quality_flags || []),
    ...(details?.structured_diff.noise_flags || []),
  ]);
  if (flags.has("profile_testimonial_change")) return true;

  const evidenceText = [
    details?.before,
    details?.after,
    ...(details?.structured_diff.added_text || []),
    ...(details?.structured_diff.removed_text || []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const text = [
    summary,
    details?.before,
    details?.after,
    details?.section,
    ...(details?.structured_diff.added_text || []),
    ...(details?.structured_diff.removed_text || []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (!text) return false;
  if (/\b(deadline|due|eligible|eligibility|required|requirement|recommendation|transcript|essay|nomination|submit|submission|award amount|stipend|tuition|funding)\b/.test(evidenceText)) {
    return false;
  }

  return (
    /\b(featured fellows?|meet the fellows?|fellow highlights?|recipient profiles?|past recipients?|alumni profiles?|profile roster|testimonial|roster content|new awardees)\b/.test(
      text,
    ) ||
    /\bfellowship awarded in \d{4} to support work towards\b/.test(text)
  );
}

function stripUnchangedApplicantReferences(value: string) {
  return value
    .replace(
      /\b(?:award\s+)?(?:deadlines?|eligibility|requirements?|application(?:\s+instructions?)?|award amounts?|funding)\b[^.]{0,90}\b(?:remain(?:s)?|are|is|were|was)?\s*(?:unchanged|not changed|no change)\b/gi,
      " ",
    )
    .replace(
      /\b(?:no|not any)\s+(?:changes?|updates?)\s+(?:to|in)\s+(?:award\s+)?(?:deadlines?|eligibility|requirements?|application(?:\s+instructions?)?|award amounts?|funding)\b/gi,
      " ",
    )
    .replace(
      /\bno\b[^.]{0,140}\b(?:deadlines?|eligibility|requirements?|application(?:\s+instructions?)?|award amounts?|funding)\b[^.]{0,140}\b(?:changed|change|updated|updates?)\b/gi,
      " ",
    );
}

function hasApplicantFacingChangeSignal(value: string) {
  return /\b(deadline|due|eligible|eligibility|requirement|recommendation|transcript|essay|nomination|submit|submission|application (?:deadline|material|portal|opens?|closes?)|award amount|stipend|tuition|funding)\b/.test(
    value,
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
