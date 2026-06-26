import { summarizeChange } from "@/lib/diff";

export type ChangeDetailsConfidence = "low" | "medium" | "high";
export type ChangeGenerationProvider = "heuristic" | "gemini" | "openai";
export type ChangeGenerationStatus =
  | "generated"
  | "invalid_json"
  | "rejected"
  | "fallback";

export type StructuredChangeDiff = {
  added_text: string[];
  removed_text: string[];
  likely_section: string | null;
  page_type: string | null;
  date_changes: string[];
  amount_changes: string[];
  noise_flags: string[];
};

export type ChangeDetailSource = {
  award_name?: string | null;
  source_title?: string | null;
  source_url?: string | null;
  page_type?: string | null;
};

export type ChangeDetails = {
  reader_summary: string;
  before: string | null;
  after: string | null;
  section: string | null;
  change_type: string;
  advisor_impact: string | null;
  is_alert_worthy: boolean;
  confidence: ChangeDetailsConfidence;
  structured_diff: StructuredChangeDiff;
  source: ChangeDetailSource;
  quality_flags: string[];
  generated_at: string;
  generation_provider: ChangeGenerationProvider;
  generation_status: ChangeGenerationStatus;
  generation_model: string | null;
};

export function buildStructuredChangeDiff(
  previousSample: string | null | undefined,
  nextText: string,
  source: ChangeDetailSource = {},
): StructuredChangeDiff {
  const previousClean = normalizeChangeText(previousSample || "");
  const nextClean = normalizeChangeText(nextText);
  const addedText = previousClean
    ? changedSentences(previousClean, nextClean, "added").slice(0, 5)
    : [];
  const removedText = previousClean
    ? changedSentences(previousClean, nextClean, "removed").slice(0, 4)
    : [];
  const previousDates = new Set(contextualDatePhrases(previousClean));
  const nextDates = new Set(contextualDatePhrases(nextClean));
  const previousAmounts = new Set(contextualMoneyPhrases(previousClean));
  const nextAmounts = new Set(contextualMoneyPhrases(nextClean));
  const addedDates = unique([...nextDates].filter((date) => !previousDates.has(date)));
  const removedDates = unique([...previousDates].filter((date) => !nextDates.has(date)));
  const addedAmounts = unique([...nextAmounts].filter((amount) => !previousAmounts.has(amount)));
  const removedAmounts = unique([...previousAmounts].filter((amount) => !nextAmounts.has(amount)));
  const sampleExpansion = isLikelySampleExpansion(previousClean, nextClean);
  const likelySection = inferLikelySection(
    addedText[0] || removedText[0] || source.source_title || "",
    source,
  );
  const noiseFlags = qualityFlagsForDiff({
    addedText,
    removedText,
    previousClean,
    nextClean,
    addedDates,
    removedDates,
    addedAmounts,
    removedAmounts,
    sampleExpansion,
  });

  return {
    added_text: addedText,
    removed_text: removedText,
    likely_section: likelySection,
    page_type: source.page_type || null,
    date_changes: [
      ...addedDates.map((date) => `Added ${date}`),
      ...removedDates.map((date) => `Removed ${date}`),
    ],
    amount_changes: [
      ...addedAmounts.map((amount) => `Added ${amount}`),
      ...removedAmounts.map((amount) => `Removed ${amount}`),
    ],
    noise_flags: noiseFlags,
  };
}

export function buildHeuristicChangeDetails(input: {
  previousSample?: string | null;
  nextText: string;
  source?: ChangeDetailSource;
  generatedAt?: string;
}): ChangeDetails {
  const source = normalizeSource(input.source);
  const diff = buildStructuredChangeDiff(input.previousSample || null, input.nextText, source);
  const legacySummary = summarizeChange(input.previousSample || null, input.nextText);
  const legacySnippets = legacySummarySnippets(legacySummary);
  const before = diff.removed_text[0] || legacySnippets.before;
  const after = diff.added_text[0] || legacySnippets.after;
  const changeType = inferChangeType(diff, legacySummary);
  const section = diff.likely_section;
  const generatedAt = input.generatedAt || new Date().toISOString();
  const contentRotation = profileTestimonialChangeSummary(source, diff);
  const baseSummary = readerSummaryFromDiff({
    source,
    diff,
    before,
    after,
    changeType,
    legacySummary,
  });
  const confidence = confidenceForDiff(diff, input.previousSample || null);
  const qualityFlags = qualityFlagsForDetails({
    reader_summary: baseSummary,
    before,
    after,
    section,
    change_type: changeType,
    advisor_impact: advisorImpact(changeType, diff),
    is_alert_worthy: true,
    confidence,
    structured_diff: diff,
    source,
    quality_flags: [],
    generated_at: generatedAt,
    generation_provider: "heuristic",
    generation_status: "generated",
    generation_model: null,
  });
  const alertWorthy = isAlertWorthyFromFlags(qualityFlags);

  return {
    reader_summary: alertWorthy
      ? contentRotation?.summary || baseSummary
      : "No award-relevant wording changed in the stored excerpt.",
    before: alertWorthy ? before : null,
    after: alertWorthy ? after : null,
    section,
    change_type: alertWorthy ? contentRotation?.changeType || changeType : "noise",
    advisor_impact: alertWorthy
      ? contentRotation?.advisorImpact || advisorImpact(changeType, diff)
      : null,
    is_alert_worthy: alertWorthy,
    confidence: alertWorthy ? confidence : "low",
    structured_diff: diff,
    source,
    quality_flags: qualityFlags,
    generated_at: generatedAt,
    generation_provider: "heuristic",
    generation_status: alertWorthy ? "generated" : "rejected",
    generation_model: null,
  };
}

export function normalizeAiChangeDetails(input: {
  value: unknown;
  fallback: ChangeDetails;
  source?: ChangeDetailSource;
  provider?: Exclude<ChangeGenerationProvider, "heuristic">;
  model?: string | null;
}): ChangeDetails {
  const provider = input.provider || input.fallback.generation_provider;
  const model = input.model ?? input.fallback.generation_model ?? null;
  const parsed = parseJsonObject(input.value);
  if (!parsed) {
    return withGenerationMetadata(
      withQualityFlag(input.fallback, "ai_invalid_json"),
      provider,
      "invalid_json",
      model,
    );
  }

  const source = normalizeSource({
    ...input.fallback.source,
    ...input.source,
    ...(objectValue(parsed.source) || {}),
  });
  const merged: ChangeDetails = {
    reader_summary:
      cleanShortText(parsed.reader_summary) || input.fallback.reader_summary,
    before: nullableCleanText(parsed.before) ?? input.fallback.before,
    after: nullableCleanText(parsed.after) ?? input.fallback.after,
    section: nullableCleanText(parsed.section) ?? input.fallback.section,
    change_type: cleanSlugText(parsed.change_type) || input.fallback.change_type,
    advisor_impact:
      nullableCleanText(parsed.advisor_impact) ?? input.fallback.advisor_impact,
    is_alert_worthy:
      typeof parsed.is_alert_worthy === "boolean"
        ? parsed.is_alert_worthy
        : input.fallback.is_alert_worthy,
    confidence: normalizeConfidence(parsed.confidence) || input.fallback.confidence,
    structured_diff: normalizeStructuredDiff(
      objectValue(parsed.structured_diff),
      input.fallback.structured_diff,
    ),
    source,
    quality_flags: [],
    generated_at: new Date().toISOString(),
    generation_provider: provider,
    generation_status: "generated",
    generation_model: model,
  };
  const refined = refineContentOnlyChange(merged);
  const qualityFlags = unique([
    ...input.fallback.quality_flags.filter(isPersistentQualityFlag),
    ...stringArray(parsed.quality_flags),
    ...qualityFlagsForDetails(refined),
  ]);

  if (!isAlertWorthyFromFlags(qualityFlags)) {
    return {
      ...input.fallback,
      quality_flags: unique([...input.fallback.quality_flags, ...qualityFlags, "ai_rejected"]),
      generation_provider: provider,
      generation_status: "rejected",
      generation_model: model,
    };
  }

  return {
    ...refined,
    quality_flags: qualityFlags,
  };
}

export function parseChangeDetails(value: unknown): ChangeDetails | null {
  const parsed = parseJsonObject(value);
  if (!parsed) return null;
  const readerSummary = cleanShortText(parsed.reader_summary);
  if (!readerSummary) return null;

  return refineContentOnlyChange({
    reader_summary: readerSummary,
    before: nullableCleanText(parsed.before),
    after: nullableCleanText(parsed.after),
    section: nullableCleanText(parsed.section),
    change_type: cleanSlugText(parsed.change_type) || "other",
    advisor_impact: nullableCleanText(parsed.advisor_impact),
    is_alert_worthy:
      typeof parsed.is_alert_worthy === "boolean" ? parsed.is_alert_worthy : true,
    confidence: normalizeConfidence(parsed.confidence) || "low",
    structured_diff: normalizeStructuredDiff(objectValue(parsed.structured_diff), {
      added_text: [],
      removed_text: [],
      likely_section: null,
      page_type: null,
      date_changes: [],
      amount_changes: [],
      noise_flags: [],
    }),
    source: normalizeSource(objectValue(parsed.source) || {}),
    quality_flags: stringArray(parsed.quality_flags),
    generated_at: cleanShortText(parsed.generated_at) || "",
    generation_provider: normalizeGenerationProvider(parsed.generation_provider) || "heuristic",
    generation_status: normalizeGenerationStatus(parsed.generation_status) || "generated",
    generation_model: nullableCleanText(parsed.generation_model),
  });
}

export function changeDetailsToSummary(
  changeDetails: unknown,
  fallbackSummary: string | null | undefined,
) {
  const details = parseChangeDetails(changeDetails);
  const summary = cleanShortText(details?.reader_summary);
  return summary || cleanShortText(fallbackSummary);
}

export function changeDetailsSearchText(changeDetails: unknown) {
  const details = parseChangeDetails(changeDetails);
  if (!details) return "";

  return [
    details.reader_summary,
    details.before,
    details.after,
    details.section,
    details.advisor_impact,
    details.change_type,
    ...details.structured_diff.added_text,
    ...details.structured_diff.removed_text,
    ...details.structured_diff.date_changes,
    ...details.structured_diff.amount_changes,
  ]
    .filter(Boolean)
    .join(" ");
}

export function isMeaningfulChangeDetails(changeDetails: unknown) {
  const details = parseChangeDetails(changeDetails);
  if (!details) return null;
  if (!details.is_alert_worthy) return false;
  return isAlertWorthyFromFlags([
    ...details.quality_flags,
    ...qualityFlagsForDetails(details),
  ]);
}

export function changeDetailsLabel(changeDetails: unknown, fallback = "Update") {
  const details = parseChangeDetails(changeDetails);
  if (!details) return fallback;

  if (details.change_type === "date" || details.change_type === "deadline") return "Date";
  if (details.change_type === "amount" || details.change_type === "funding") return "Funding";
  if (details.change_type === "eligibility") return "Eligibility";
  if (details.change_type === "application") return "Application";
  if (details.change_type === "document") return "Document";
  if (details.change_type === "content_update") return "Content";
  if (details.change_type === "removed_text") return "Removed";
  return fallback;
}

function legacySummarySnippets(summary: string) {
  const changed = summary.match(/changed text from\s+"([^"]+)"\s+to\s+"([^"]+)"/i);
  if (changed) return { before: changed[1], after: changed[2] };

  const added = summary.match(/(?:added text includes|new text appears after the previously stored excerpt):\s+"([^"]+)"/i);
  if (added) return { before: null, after: added[1] };

  const removed = summary.match(/removed text includes:\s+"([^"]+)"/i);
  if (removed) return { before: removed[1], after: null };

  return { before: null, after: null };
}

function readerSummaryFromDiff(input: {
  source: ChangeDetailSource;
  diff: StructuredChangeDiff;
  before: string | null;
  after: string | null;
  changeType: string;
  legacySummary: string;
}) {
  const sourceName = readableSourceName(input.source);
  const dateText = input.diff.date_changes[0]?.replace(/^(Added|Removed)\s+/i, "");
  const amountText = input.diff.amount_changes[0]?.replace(/^(Added|Removed)\s+/i, "");

  if (input.after && input.before) {
    return `The ${sourceName} page has updated wording. Current stored wording includes: ${sentenceForReader(
      truncateForReader(input.after, 170),
    )} Previous stored wording included: ${sentenceForReader(truncateForReader(input.before, 140))}`;
  }

  if (input.after) {
    if (input.changeType === "date" || input.changeType === "deadline") {
      return `The ${sourceName} page added date or deadline wording: ${input.after}`;
    }
    if (input.changeType === "amount" || input.changeType === "funding") {
      return `The ${sourceName} page added funding amount wording: ${input.after}`;
    }
    return `The ${sourceName} page added new wording: ${input.after}`;
  }

  if (input.before) {
    return `The ${sourceName} page removed wording: ${input.before}`;
  }

  if (dateText) return `The ${sourceName} page added date or deadline text: ${dateText}.`;
  if (amountText) return `The ${sourceName} page added funding amount text: ${amountText}.`;

  return cleanShortText(input.legacySummary) ||
    "No award-relevant wording changed in the stored excerpt.";
}

function advisorImpact(changeType: string, diff: StructuredChangeDiff) {
  if (changeType === "date" || changeType === "deadline") {
    return "Check whether office timelines, reminders, and applicant instructions need the new date.";
  }
  if (changeType === "amount" || changeType === "funding") {
    return "Check whether funding descriptions and applicant advising materials need the new amount.";
  }
  if (changeType === "eligibility") {
    return "Review eligibility guidance before advising applicants from this award.";
  }
  if (changeType === "application" || diff.added_text.length || diff.removed_text.length) {
    return "Review applicant instructions for any needed office-facing updates.";
  }
  return null;
}

function confidenceForDiff(diff: StructuredChangeDiff, previousSample: string | null) {
  if (!previousSample || diff.noise_flags.includes("sample_expansion")) return "low";
  if (diff.date_changes.length || diff.amount_changes.length) return "high";
  if (diff.added_text.length || diff.removed_text.length) return "medium";
  return "low";
}

function inferChangeType(diff: StructuredChangeDiff, summary: string) {
  const haystack = [
    summary,
    ...diff.added_text,
    ...diff.removed_text,
    ...diff.date_changes,
    ...diff.amount_changes,
  ]
    .join(" ")
    .toLowerCase();

  if (diff.amount_changes.length || /\b(funding|stipend|tuition|fellowships? will be awarded|award amount|amount awarded)\b/.test(haystack)) {
    return "funding";
  }
  if (diff.date_changes.length || /\b(deadline|due|opens?|closes?|date)\b/.test(haystack)) {
    return "deadline";
  }
  if (/\b(eligible|eligibility|citizenship|gpa|enrolled)\b/.test(haystack)) {
    return "eligibility";
  }
  if (/\b(apply|application|submit|submission|recommendation|transcript|essay)\b/.test(haystack)) {
    return "application";
  }
  if (/\b(pdf|guide|handbook|instructions|document)\b/.test(haystack)) {
    return "document";
  }
  if (looksLikeProfileOrTestimonialRotation(diff)) return "content_update";
  if (diff.removed_text.length && !diff.added_text.length) return "removed_text";
  if (diff.added_text.length) return "new_text";
  return "other";
}

function inferLikelySection(text: string, source: ChangeDetailSource) {
  const title = cleanShortText(source.source_title);
  const lower = `${text} ${title}`.toLowerCase();
  if (/\b(deadline|timeline|dates?)\b/.test(lower)) return "Dates and deadlines";
  if (/\b(eligible|eligibility|requirements?)\b/.test(lower)) return "Eligibility";
  if (/\b(apply|application|submit|submission)\b/.test(lower)) return "Application";
  if (/\b(recommendation|transcript|essay|materials?)\b/.test(lower)) return "Materials";
  if (/\b(funding|stipend|tuition|amount)\b/.test(lower)) return "Funding";
  return title || null;
}

function qualityFlagsForDiff(input: {
  addedText: string[];
  removedText: string[];
  previousClean: string;
  nextClean: string;
  addedDates: string[];
  removedDates: string[];
  addedAmounts: string[];
  removedAmounts: string[];
  sampleExpansion: boolean;
}) {
  const changedText = [...input.addedText, ...input.removedText].join(" ");
  const flags: string[] = [];
  if (!input.previousClean) flags.push("no_previous_snapshot");
  if (
    looksLikeSourceAccessError(input.previousClean) ||
    looksLikeSourceAccessError(input.nextClean)
  ) {
    flags.push("source_access_error");
  }
  if (input.sampleExpansion) flags.push("sample_expansion");
  if (hasRawScrapeSignals(changedText)) flags.push("raw_scrape_signal");
  if (looksLikeOrphanPunctuation(changedText)) flags.push("orphan_punctuation");
  if (looksLikeProfileOrTestimonialRotationText(changedText)) {
    flags.push("profile_testimonial_change");
  }
  if (
    looksLikeRecipientNewsOrPressChange({
      changedText,
      previousText: input.previousClean,
      nextText: input.nextClean,
      addedDates: input.addedDates,
      removedDates: input.removedDates,
      addedAmounts: input.addedAmounts,
      removedAmounts: input.removedAmounts,
    })
  ) {
    flags.push("recipient_news_change");
  }
  if (
    !input.addedText.length &&
    !input.removedText.length &&
    !input.addedDates.length &&
    !input.removedDates.length &&
    !input.addedAmounts.length &&
    !input.removedAmounts.length
  ) {
    flags.push("no_actual_changed_fact");
  }
  if (input.nextClean.length < 50) flags.push("short_snapshot_text");
  return unique(flags);
}

function qualityFlagsForDetails(details: ChangeDetails) {
  const flags = [
    ...details.structured_diff.noise_flags,
  ];
  const text = [
    details.reader_summary,
    details.before,
    details.after,
    details.section,
    details.advisor_impact,
  ]
    .filter(Boolean)
    .join(" ");

  if (hasRawScrapeSignals(text)) flags.push("raw_scrape_signal");
  if (looksLikeOrphanPunctuation(details.reader_summary)) flags.push("orphan_punctuation");
  if (isVagueReaderSummary(details.reader_summary)) flags.push("vague_summary");
  if (hasIndistinctTruncatedSnippets(details.before, details.after)) {
    flags.push("indistinct_truncated_snippet");
  }
  if (hasFormatOnlySnippetChange(details.before, details.after)) {
    flags.push("format_only_change");
  }
  if (hasContextOnlySnippetChange(details)) {
    flags.push("context_only_change");
  }
  if (hasDocumentMetadataOnlyChange(details)) {
    flags.push("document_metadata_only_change");
  }
  if (looksLikeProfileOrTestimonialRotation(details.structured_diff)) {
    flags.push("profile_testimonial_change");
  }
  if (
    looksLikeRecipientNewsOrPressChange({
      changedText: [
        details.before,
        details.after,
        ...details.structured_diff.added_text,
        ...details.structured_diff.removed_text,
      ]
        .filter(Boolean)
        .join(" "),
      previousText: details.structured_diff.removed_text.join(" "),
      nextText: details.structured_diff.added_text.join(" "),
      addedDates: details.structured_diff.date_changes.filter((change) =>
        /^Added\s+/i.test(change),
      ),
      removedDates: details.structured_diff.date_changes.filter((change) =>
        /^Removed\s+/i.test(change),
      ),
      addedAmounts: details.structured_diff.amount_changes.filter((change) =>
        /^Added\s+/i.test(change),
      ),
      removedAmounts: details.structured_diff.amount_changes.filter((change) =>
        /^Removed\s+/i.test(change),
      ),
    })
  ) {
    flags.push("recipient_news_change");
  }
  if (
    !details.before &&
    !details.after &&
    !details.structured_diff.date_changes.length &&
    !details.structured_diff.amount_changes.length
  ) {
    flags.push("no_actual_changed_fact");
  }
  if (hasUnsupportedStructuredFact(details)) flags.push("unsupported_structured_fact");

  return unique(flags);
}

function isAlertWorthyFromFlags(flags: string[]) {
  return !flags.some((flag) =>
    [
      "ai_invalid_json",
      "source_access_error",
      "raw_scrape_signal",
      "orphan_punctuation",
      "vague_summary",
      "no_actual_changed_fact",
      "sample_expansion",
      "unsupported_structured_fact",
      "indistinct_truncated_snippet",
      "format_only_change",
      "context_only_change",
      "document_metadata_only_change",
      "recipient_news_change",
    ].includes(flag),
  );
}

function hasUnsupportedStructuredFact(details: ChangeDetails) {
  const evidenceText = [
    details.before,
    details.after,
    ...details.structured_diff.added_text,
    ...details.structured_diff.removed_text,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  const unsupportedAmounts = details.structured_diff.amount_changes
    .flatMap((change) => moneyFactPhrases(change))
    .filter((amount) => !evidenceText.includes(amount));
  if (unsupportedAmounts.length > 0) return true;

  const unsupportedDates = details.structured_diff.date_changes
    .flatMap((change) => dateFactPhrases(change))
    .filter((date) => !evidenceText.includes(date));
  return unsupportedDates.length > 0;
}

function moneyFactPhrases(value: string) {
  return unique(
    [...normalizeChangeText(value).matchAll(/\$\s?\d[\d,]*(?:\.\d{2})?\b/g)]
      .map((match) => normalizeChangeText(match[0]).toLowerCase())
      .filter(Boolean),
  );
}

function dateFactPhrases(value: string) {
  const clean = normalizeChangeText(value.replace(/^(Added|Removed)\s+/i, ""));
  const month =
    "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
  const monthYear = new RegExp(`\\b(?:${month})\\.?\\s+\\d{4}\\b`, "gi");

  return unique([...datePhrases(clean), ...[...clean.matchAll(monthYear)].map((match) => normalizeChangeText(match[0]))])
    .map((date) => date.toLowerCase())
    .filter(Boolean);
}

function hasContextOnlySnippetChange(details: ChangeDetails) {
  if (!details.before || !details.after) return false;
  if (details.structured_diff.date_changes.length || details.structured_diff.amount_changes.length) {
    return false;
  }

  const pageType = cleanSlugText(details.structured_diff.page_type || details.source.page_type);
  if (/^(application|deadline|eligibility|requirements?)$/.test(pageType)) return false;

  const before = normalizeComparableSnippet(details.before);
  const after = normalizeComparableSnippet(details.after);
  if (!before || !after || before === after) return false;

  const shorter = before.length <= after.length ? before : after;
  const longer = before.length > after.length ? before : after;
  if (shorter.length < 55 || !longer.includes(shorter)) return false;

  const extra = normalizeChangeText(longer.replace(shorter, " "));
  if (extra.length < 24) return false;
  if (hasApplicationRequirementSignal(extra) || hasFundingAmountContext(extra)) return false;

  const sourceContext = `${details.source.source_title || ""} ${details.section || ""}`.toLowerCase();
  return (
    pageType === "other" ||
    pageType === "homepage" ||
    /\b(recognition|news|story|stories|events?|donors?|sponsors?|partners?|press|profiles?|past recipients?)\b/.test(
      sourceContext,
    )
  );
}

function hasDocumentMetadataOnlyChange(details: ChangeDetails) {
  const summaryText = [
    details.reader_summary,
    details.advisor_impact,
    details.section,
    details.change_type,
  ]
    .filter(Boolean)
    .join(" ");
  const evidence = [
    details.before,
    details.after,
    ...details.structured_diff.added_text,
    ...details.structured_diff.removed_text,
    ...details.structured_diff.date_changes,
    ...details.structured_diff.amount_changes,
  ].filter((value): value is string => Boolean(value));
  const evidenceText = evidence.join(" ");
  const pageType = cleanSlugText(details.structured_diff.page_type || details.source.page_type);
  const sourceContext = `${details.source.source_title || ""} ${details.source.source_url || ""}`;
  const documentContext =
    /^(pdf|document|application_pdf|materials?)$/.test(pageType) ||
    /\.(?:pdf|docx?)(?:[?#]|$)/i.test(sourceContext) ||
    /\b(pdf|docx?|word version|application pdf|download form|recommendation form)\b/i.test(
      `${summaryText} ${sourceContext}`,
    );

  if (!documentContext) return false;
  if (hasApplicationRequirementSignal(evidenceText) || hasFundingAmountContext(evidenceText)) {
    return false;
  }
  if (
    details.structured_diff.date_changes.length ||
    details.structured_diff.amount_changes.length
  ) {
    return false;
  }

  const metadataOnlyLanguage = /\b(?:specific changes? (?:within|in) (?:the )?(?:pdf|document|file) (?:are|were) not detailed|file itself has changed|file size (?:has )?(?:increased|decreased|changed)|potential change in content or format|download and review the updated|check the updated (?:application )?(?:pdf|document|form)|updated (?:pdf|document|file|form) for any changes)\b/i.test(
    summaryText,
  );
  const genericDocumentUpdate =
    /\b(?:pdf|document|file|form)\b/i.test(summaryText) &&
    /\b(?:has been updated|was updated|changed)\b/i.test(summaryText) &&
    !/\b(?:deadline|due|eligible|eligibility|required|requirement|recommendation letter|transcript|essay|nomination|award amount|stipend|tuition|funding)\b/i.test(
      summaryText,
    );
  const opaqueEvidence = evidence.length > 0 && evidence.every(isOpaqueDocumentEvidence);

  return (metadataOnlyLanguage || genericDocumentUpdate) && (opaqueEvidence || evidence.length === 0);
}

function refineContentOnlyChange(details: ChangeDetails): ChangeDetails {
  const contentRotation = profileTestimonialChangeSummary(details.source, details.structured_diff);
  if (!contentRotation) return details;

  return {
    ...details,
    reader_summary: contentRotation.summary,
    change_type: contentRotation.changeType,
    advisor_impact: contentRotation.advisorImpact,
    confidence: details.confidence === "high" ? "medium" : details.confidence,
  };
}

function profileTestimonialChangeSummary(source: ChangeDetailSource, diff: StructuredChangeDiff) {
  if (!looksLikeProfileOrTestimonialRotation(diff)) return null;
  const sourceName = readableSourceName(source);
  return {
    summary: `The ${sourceName} page refreshed profile, testimonial, or roster content; no application requirements, deadlines, eligibility, or funding text changed.`,
    changeType: "content_update",
    advisorImpact:
      "No applicant-facing action is likely needed unless this page is used in promotional or reference materials.",
  };
}

function looksLikeProfileOrTestimonialRotation(diff: StructuredChangeDiff) {
  if (diff.date_changes.length || diff.amount_changes.length) return false;
  const changed = `${diff.added_text.join(" ")} ${diff.removed_text.join(" ")}`;
  if (!looksLikeProfileOrTestimonialRotationText(changed)) return false;
  if (hasApplicationRequirementSignal(changed)) return false;
  return Boolean(diff.added_text.length || diff.removed_text.length);
}

function looksLikeProfileOrTestimonialRotationText(value: string) {
  const clean = normalizeChangeText(value);
  if (!clean) return false;
  const featuredFellowSignals =
    /\b(featured fellows?|meet the fellows?|fellow highlights?|recipient profiles?|past recipients?)\b/i.test(
      clean,
    ) &&
    /\b(fellowship awarded|immigrant from|child of immigrants?|ph\.?\s*d|m\.?\s*d|j\.?\s*d|university|college)\b/i.test(
      clean,
    );
  const quoteSignals = (clean.match(/[“”"]/g) || []).length >= 2;
  const personSignals =
    /\b(fellow|fellowship|scholar|recipient|alum(?:na|ni|nus)?|student|teacher|professor|faculty|speaker|bio|biography|profile|testimonial|quote|immigrant)\b/i.test(
      clean,
    );
  const storySignals =
    /\b(earned an? ma|earned an? m\.?a\.?|earned an? master's|teaches at|i am proud|i've made|my fellowship|my career|learned from colleagues|honored to be teaching|profile|testimonial|fellowship awarded in \d{4} to support work towards|immigrant from|child of immigrants?)\b/i.test(
      clean,
    );
  const rosterSignals =
    /\b(our team|staff|leadership|board of trustees|steering group members?|senior fellow|director|co-?director|specialist|researcher|members?|center for applied linguistics)\b/i.test(
      clean,
    ) && /\b(dr\.|ms\.|mr\.|mrs\.|director|fellow|specialist|professor|researcher)\b/i.test(clean);
  const stateFellowSignals =
    /\b(?:alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming)\s+fellow\b/i.test(
      clean,
    );

  return featuredFellowSignals || (personSignals && (quoteSignals || storySignals || rosterSignals || stateFellowSignals));
}

function looksLikeRecipientNewsOrPressChange(input: {
  changedText: string;
  previousText: string;
  nextText: string;
  addedDates: string[];
  removedDates: string[];
  addedAmounts: string[];
  removedAmounts: string[];
}) {
  if (
    input.addedDates.length ||
    input.removedDates.length ||
    input.addedAmounts.length ||
    input.removedAmounts.length
  ) {
    return false;
  }
  if (hasApplicationRequirementSignal(input.changedText)) return false;

  const changedClean = normalizeChangeText(input.changedText);
  if (
    changedClean &&
    !looksLikeRecipientNewsOrPressText(changedClean) &&
    !/\b(department of state scholarship|(?:his|her|their) language skills?|work on (?:his|her|their) language skills?|travel to|will spend)\b/i.test(
      changedClean,
    )
  ) {
    return false;
  }

  return looksLikeRecipientNewsOrPressText(
    `${input.changedText} ${input.previousText} ${input.nextText}`,
  );
}

function looksLikeRecipientNewsOrPressText(value: string) {
  const clean = normalizeChangeText(value);
  if (!clean) return false;

  const pressSignals =
    /\b(latest news|news|press release|in the press|shared from|alumni highlight|student profile|recipient profile)\b/i.test(
      clean,
    );
  const recipientSignals =
    /\b(selected for|selected as|has been selected for|named finalist|named a finalist|receives? federal help|students? awarded scholarships?|awarded scholarships? to study abroad|will spend (?:the summer|two months)|competitive pool|one of \d+ students selected|class of|['’]\d{2})\b/i.test(
      clean,
    );
  const awardSignals = /\b(scholarship|fellowship|award|program|department of state)\b/i.test(
    clean,
  );
  const personOrInstitutionSignals =
    /\b(student|senior|alumni|alumna|alumnus|university|college|school|cohort|finalist|recipient)\b/i.test(
      clean,
    );

  return (
    (pressSignals && awardSignals && (recipientSignals || personOrInstitutionSignals)) ||
    (recipientSignals && awardSignals && personOrInstitutionSignals)
  );
}

function hasApplicationRequirementSignal(value: string) {
  return /\b(deadline|due|applications?\s+(?:open|close|due)|apply by|submit(?:ted)? by|eligib(?:le|ility)|must submit|required|requirements?|recommendation|transcript|essay|interview|tuition|stipend|award amount|funding amount|citizenship|gpa)\b/i.test(
    value,
  );
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
    .filter(isUsefulChangeSentence)
    .map((sentence) => truncateForReader(sentence, 360));
}

function sentenceCandidates(text: string) {
  return splitChangeSentences(normalizeChangeText(text))
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 25 && sentence.length <= 520);
}

function splitChangeSentences(text: string) {
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

function isUsefulChangeSentence(sentence: string) {
  const lower = sentence.toLowerCase();
  if (hasRawScrapeSignals(sentence)) return false;
  if (looksLikeOrphanPunctuation(sentence)) return false;
  if (/\b(latest news|blog|story|press release|published)\b/.test(lower)) return false;
  if (isHistoricalRecipientOrMarketingText(sentence)) return false;

  return /\b(applications?|apply|deadline|due|opens?|closes?|eligible|eligibility|requirements?|recommendations?|transcripts?|essays?|interviews?|tuition|stipend|funding|fellows?|fellowship|scholarships?|awards?|admissions?|selection|nomination|candidates?|program|internship|grant|submit|submission|citizenship|gpa|pdf|guide|instructions?)\b/.test(
    lower,
  );
}

function datePhrases(text: string) {
  const month =
    "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
  const patterns = [
    new RegExp(`\\b(?:${month})\\.?\\s+\\d{1,2}(?:,\\s*\\d{4})?\\b`, "gi"),
    /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g,
    /\b\d{4}-\d{2}-\d{2}\b/g,
  ];

  return patterns.flatMap((pattern) =>
    [...text.matchAll(pattern)].map((match) => normalizeChangeText(match[0])),
  );
}

function contextualMoneyPhrases(text: string) {
  return unique(
    [...text.matchAll(/\$\s?\d[\d,]*(?:\.\d{2})?\b/g)]
      .filter((match) => hasFundingAmountContext(contextAroundMatch(text, match.index || 0)))
      .map((match) => normalizeChangeText(match[0])),
  );
}

function contextualDatePhrases(text: string) {
  return unique(
    sentenceCandidates(text)
      .filter(isAwardDateContext)
      .flatMap(datePhrases),
  );
}

function contextAroundMatch(text: string, index: number) {
  return normalizeChangeText(text.slice(Math.max(0, index - 180), index + 220));
}

function hasFundingAmountContext(value: string) {
  const lower = value.toLowerCase();
  if (
    /\b(cart|donate|donation|shop|store|subscribe|subscription|ticket|tickets|purchase|checkout|subtotal|merchandise|membership|sponsor|sponsorship)\b/.test(
      lower,
    )
  ) {
    return false;
  }

  return /\b(stipend|tuition|funding|funds?|grant|scholarships?|fellowships?|award amount|awards?:|amount awarded|prize|financial support|honorarium|living allowance|travel expenses?|research expenses?)\b/.test(
    lower,
  );
}

function isAwardDateContext(sentence: string) {
  const lower = sentence.toLowerCase();
  if (isHistoricalRecipientOrMarketingText(sentence)) return false;
  return /\b(deadline|due|application|apply|opens?|closes?|timeline|round|eligible|eligibility|interview|selection|notification|acceptance|nomination|submit|submission)\b/.test(
    lower,
  );
}

function normalizeStructuredDiff(
  value: Record<string, unknown> | null,
  fallback: StructuredChangeDiff,
): StructuredChangeDiff {
  if (!value) return fallback;

  return {
    added_text: stringArray(value.added_text).slice(0, 8),
    removed_text: stringArray(value.removed_text).slice(0, 8),
    likely_section: nullableCleanText(value.likely_section) ?? fallback.likely_section,
    page_type: nullableCleanText(value.page_type) ?? fallback.page_type,
    date_changes: stringArray(value.date_changes).slice(0, 8),
    amount_changes: stringArray(value.amount_changes).slice(0, 8),
    noise_flags: unique([
      ...fallback.noise_flags,
      ...stringArray(value.noise_flags).map((flag) => cleanSlugText(flag)),
    ].filter(Boolean)),
  };
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return objectValue(parsed);
    } catch {
      return null;
    }
  }
  return objectValue(value);
}

function objectValue(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stringArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => cleanShortText(item))
    .filter((item): item is string => Boolean(item));
}

function normalizeConfidence(value: unknown): ChangeDetailsConfidence | null {
  const clean = cleanSlugText(value);
  if (clean === "low" || clean === "medium" || clean === "high") return clean;
  return null;
}

function normalizeGenerationProvider(value: unknown): ChangeGenerationProvider | null {
  const clean = cleanSlugText(value);
  if (clean === "heuristic" || clean === "gemini" || clean === "openai") return clean;
  return null;
}

function normalizeGenerationStatus(value: unknown): ChangeGenerationStatus | null {
  const clean = cleanSlugText(value);
  if (
    clean === "generated" ||
    clean === "invalid_json" ||
    clean === "rejected" ||
    clean === "fallback"
  ) {
    return clean;
  }
  return null;
}

function normalizeSource(source: ChangeDetailSource | Record<string, unknown> | null | undefined) {
  return {
    award_name: nullableCleanText(source?.award_name) || null,
    source_title: nullableCleanText(source?.source_title) || null,
    source_url: nullableCleanText(source?.source_url) || null,
    page_type: nullableCleanText(source?.page_type) || null,
  };
}

function readableSourceName(source: ChangeDetailSource) {
  const title = cleanShortText(source.source_title);
  if (title && !/^(source page|homepage|other source)$/i.test(title)) return title;
  const awardName = cleanShortText(source.award_name);
  if (awardName) return awardName;
  return "source";
}

function withQualityFlag(details: ChangeDetails, flag: string): ChangeDetails {
  return {
    ...details,
    quality_flags: unique([...details.quality_flags, flag]),
  };
}

function withGenerationMetadata(
  details: ChangeDetails,
  provider: ChangeGenerationProvider,
  status: ChangeGenerationStatus,
  model: string | null,
): ChangeDetails {
  return {
    ...details,
    generation_provider: provider,
    generation_status: status,
    generation_model: model,
  };
}

function cleanShortText(value: unknown) {
  return normalizeChangeText(String(value || "")).slice(0, 1200);
}

function nullableCleanText(value: unknown) {
  const clean = cleanShortText(value);
  return clean || null;
}

function cleanSlugText(value: unknown) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function normalizeChangeText(value: string) {
  return value.replace(/\s+/g, " ").replace(/\u0000/g, "").trim();
}

function isLikelySampleExpansion(previousText: string, nextText: string) {
  if (previousText.length < 500 || nextText.length <= previousText.length + 80) {
    return false;
  }

  if (nextText.startsWith(previousText)) return true;
  if (compactSentenceKey(nextText).startsWith(compactSentenceKey(previousText))) {
    return true;
  }
  if (!endsLikeTruncatedSample(previousText)) return false;

  for (const length of [180, 140, 100, 70]) {
    const tail = previousText.slice(-length).trim();
    if (tail.length < 60) continue;
    const index = nextText.indexOf(tail);
    if (index >= 0 && index + tail.length < nextText.length - 40) return true;
  }

  return false;
}

function endsLikeTruncatedSample(value: string) {
  const clean = normalizeChangeText(value);
  if (!clean) return false;
  if (/[([{:/,-]\s*$/.test(clean)) return true;
  if (/[.!?)]['"]?$/.test(clean)) return false;
  const lastWord = clean.match(/[A-Za-z]+$/)?.[0] || "";
  return lastWord.length <= 3 || clean.length >= 1950;
}

function truncateForReader(value: string, maxLength: number) {
  const clean = normalizeChangeText(value).replace(/^[-:;,.\s]+/, "").replace(/[-:;,\s]+$/, "");
  if (clean.length <= maxLength) return clean;
  const truncated = clean.slice(0, maxLength + 1);
  const boundary = truncated.lastIndexOf(" ");
  return `${truncated.slice(0, boundary > maxLength * 0.65 ? boundary : maxLength).trim()}...`;
}

function sentenceForReader(value: string) {
  const clean = normalizeChangeText(value).replace(/\.\.\.$/, "").trim();
  if (!clean) return "";
  return /[.!?]$/.test(clean) ? clean : `${clean}.`;
}

function hasRawScrapeSignals(value: string) {
  return (
    looksLikeSourceAccessError(value) ||
    hasRawMarkupSignals(value) ||
    hasSeoInstrumentationSignals(value) ||
    hasJumpLinkHeadingPrefixSignals(value) ||
    /\b(learn more|read more|click here|skip to|main menu|toggle menu|toggle page navigation|search menu|read current issue|cart|dismiss|login|copyright|privacy policy|all rights reserved|facebook|instagram|x\.com|twitter|linkedin|youtube|subscribe|newsletter)\b/i.test(
      value,
    ) ||
    hasNavigationBoilerplate(value) ||
    hasStorefrontBoilerplate(value)
  );
}

function looksLikeSourceAccessError(value: string) {
  const clean = normalizeChangeText(value);
  if (!clean) return false;
  return (
    /\b(?:fehler|error)\s*(?:401|403|404|410|429|50[0-4])\b/i.test(clean) ||
    /\b(access denied|zugriff verboten|forbidden|not found|page not found|service unavailable|too many requests)\b/i.test(
      clean,
    ) ||
    /\bthe access to this directory\/page is restricted\b/i.test(clean) ||
    /\bHTTP\/1\.1\s+(?:401|403|404|410|429|50[0-4])\b/i.test(clean)
  );
}

function hasJumpLinkHeadingPrefixSignals(value: string) {
  const clean = normalizeChangeText(value);
  return /\bTop\s+(?:Applications?|The Selection Process|Selection Process|Eligibility|Requirements?|Deadlines?|Timeline|FAQs?|Funding|References?|Courses?)\b/.test(
    clean,
  );
}

function hasSeoInstrumentationSignals(value: string) {
  const clean = normalizeChangeText(value);
  return (
    /\bbe_ixf\b/i.test(clean) ||
    /\bym_20\d{4}\s+d_\d{2}\b/i.test(clean) ||
    /\bphp_sdk(?:_\d+(?:\.\d+){1,3})?\b/i.test(clean) ||
    /\bct_\d+\s+be_ixf\b/i.test(clean)
  );
}

function hasRawMarkupSignals(value: string) {
  const clean = normalizeChangeText(value);
  return (
    /<\/?(?:picture|source|img|script|style|div|span|section|article|figure|figcaption|a|p|br|ul|ol|li|svg|path)\b/i.test(clean) ||
    /\b(?:srcset|classname|referrerpolicy|loading|sizes|alt|href|style)=["'][^"']{8,}/i.test(clean) ||
    /https?:\/\/[^\s"']+\.(?:jpg|jpeg|png|gif|webp|svg)(?:[?#][^\s"']*)?/i.test(clean)
  );
}

function hasStorefrontBoilerplate(value: string) {
  const clean = normalizeChangeText(value);
  return (
    /\b(view item|featured products?|shop for materials?|add to cart|checkout|subtotal|merchandise)\b/i.test(clean) ||
    /\bprice:\s*\$\s?\d/i.test(clean)
  );
}

function hasNavigationBoilerplate(value: string) {
  const clean = normalizeChangeText(value);
  const lower = clean.toLowerCase();
  const structuralNavMarkers = /\b(primary sidebar|secondary sidebar|sidebar navigation|site navigation|breadcrumb|footer)\b/i.test(
    clean,
  );
  const navTerms = [
    "application overview",
    "eligibility",
    "essays",
    "priorities",
    "selection criteria",
    "submission tips",
    "requirements",
    "deadlines",
    "timeline",
    "applicants faq",
    "current recipients",
    "scholars abroad",
    "alumni",
    "advisors",
    "general inquiries",
  ];
  const navTermCount = navTerms.filter((term) => lower.includes(term)).length;

  if (structuralNavMarkers && navTermCount >= 4) return true;

  return (
    /\b(back|previous|next)\s+(?:application|overview|news|search|winners?|representatives?)\b/i.test(clean) &&
    /\b(application overview|search|winners?|representatives?|districts?|brochure|frequently asked questions?)\b/i.test(clean) &&
    /\b(apply|back|search|toggle menu)\b/i.test(clean)
  );
}

function isHistoricalRecipientOrMarketingText(value: string) {
  return (
    /\b(past recipients?|recipient profiles?|latest news|press release|received the .* award|receives the .* award|photo by|getty images|new york, new york)\b/i.test(
      value,
    ) || looksLikeRecipientNewsOrPressText(value)
  );
}

function isPersistentQualityFlag(flag: string) {
  return [
    "ai_invalid_json",
    "no_previous_snapshot",
    "sample_expansion",
    "raw_scrape_signal",
    "orphan_punctuation",
    "indistinct_truncated_snippet",
    "format_only_change",
    "document_metadata_only_change",
    "profile_testimonial_change",
    "recipient_news_change",
  ].includes(flag);
}

function isOpaqueDocumentEvidence(value: string) {
  const clean = normalizeChangeText(value);
  if (!clean) return true;
  if (/^\d{1,10}$/.test(clean)) return true;
  const tokens = clean.match(/[a-z0-9]+/gi) || [];
  if (!tokens.length) return true;
  const hexTokenCount = tokens.filter((token) => /^[a-f0-9]{1,16}$/i.test(token)).length;
  const longHashCount = tokens.filter((token) => /^[a-f0-9]{16,}$/i.test(token)).length;
  const readableWordCount = tokens.filter((token) => /[g-z]/i.test(token) && token.length >= 4).length;

  return (
    longHashCount > 0 ||
    (tokens.length >= 6 && hexTokenCount / tokens.length >= 0.82 && readableWordCount === 0)
  );
}

function hasIndistinctTruncatedSnippets(before: string | null, after: string | null) {
  if (!before || !after) return false;
  const cleanBefore = normalizeComparableSnippet(before);
  const cleanAfter = normalizeComparableSnippet(after);
  if (!cleanBefore || !cleanAfter) return false;
  if (cleanBefore === cleanAfter) return true;
  const shorter = cleanBefore.length <= cleanAfter.length ? cleanBefore : cleanAfter;
  const longer = cleanBefore.length > cleanAfter.length ? cleanBefore : cleanAfter;
  if (shorter.length >= 160 && longer.startsWith(shorter.slice(0, 160))) {
    return true;
  }
  return (
    shorter.length >= 40 &&
    longer.startsWith(shorter) &&
    looksLikeIncompletePrefixSnippet(shorter)
  );
}

function normalizeComparableSnippet(value: string) {
  return normalizeChangeText(value)
    .replace(/\.\.\.$/, "")
    .replace(/[.。]+$/g, "")
    .toLowerCase();
}

function looksLikeIncompletePrefixSnippet(value: string) {
  const clean = normalizeChangeText(value).replace(/\.\.\.$/, "").trim();
  if (!clean) return false;
  if (/[.!?)]["']?$/.test(clean)) return false;
  if (/\$\s?\d|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b|\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+\d{1,2}\b/i.test(clean)) {
    return false;
  }
  return (clean.match(/[a-z0-9]+/gi) || []).length >= 5;
}

function hasFormatOnlySnippetChange(before: string | null, after: string | null) {
  if (!before || !after) return false;
  const cleanBefore = normalizeComparableSnippet(before);
  const cleanAfter = normalizeComparableSnippet(after);
  if (!cleanBefore || !cleanAfter || cleanBefore === cleanAfter) return false;
  if (compactComparableSnippet(cleanBefore) === compactComparableSnippet(cleanAfter)) {
    return true;
  }
  if (!containsMonthDay(cleanBefore) || !containsMonthDay(cleanAfter)) return false;
  return normalizeDateFormattingSnippet(cleanBefore) === normalizeDateFormattingSnippet(cleanAfter);
}

function compactComparableSnippet(value: string) {
  return value.replace(/[^a-z0-9]+/g, "");
}

function normalizeDateFormattingSnippet(value: string) {
  const month =
    "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
  return value
    .replace(new RegExp(`\\b(${month})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)\\b`, "gi"), "$1 $2")
    .replace(/\s+/g, " ")
    .replace(/[.!?;:,\s]+$/g, "")
    .trim();
}

function containsMonthDay(value: string) {
  return /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+\d{1,2}(?:st|nd|rd|th)?\b/i.test(value);
}

function looksLikeOrphanPunctuation(value: string) {
  const clean = normalizeChangeText(value);
  if (!clean) return false;
  return /^[\s:;,.!?|/\\()[\]{}'"-]+$/.test(clean) || /(?:^|\s)[|/\\]{2,}(?:\s|$)/.test(clean);
}

function isVagueReaderSummary(value: string) {
  const normalized = value.toLowerCase();
  return (
    value.length < 28 ||
    normalized.includes("page was updated") ||
    normalized.includes("page has been updated") ||
    normalized.includes("content was updated") ||
    normalized.includes("page text updated") ||
    normalized.includes("something changed") ||
    normalized.includes("application language changed") ||
    normalized.includes("added or expanded") ||
    normalized.includes("no meaningful change") ||
    normalized.includes("no award-relevant wording changed")
  );
}

function unique<T>(values: T[]) {
  return [...new Set(values)];
}
