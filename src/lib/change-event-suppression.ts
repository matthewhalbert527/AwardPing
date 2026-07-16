import { sourceQualityDecision, type SourceQualitySource } from "@/lib/source-quality";
import {
  hasRelativeAgeOnlyPolicyChange,
  isAlertBlockingMonitoringPolicyFlag,
  isPersistentMonitoringPolicyFlag,
  monitoringPolicyFlagIdForAlias,
  reviewableMonitoringPolicyFlagIdForAlias,
} from "@/lib/award-monitoring-policy";

export type ChangeEventSuppressionSource = SourceQualitySource & {
  id?: string | null;
  admin_review_status?: string | null;
};

export type ChangeEventSuppressionCandidate = {
  id?: string | null;
  shared_award_source_id?: string | null;
  source_url?: string | null;
  source_title?: string | null;
  source_page_type?: string | null;
  summary?: string | null;
  change_details?: unknown;
  suppressed_at?: string | null;
  suppression_reason?: string | null;
  suppression_source?: string | null;
};

export type ChangeEventSuppressionDecision = {
  suppressed: boolean;
  reason: string | null;
};

export type ChangeEventSuppressionMode = "publication" | "retro_sweep";

export type ChangeEventSuppressionOptions = {
  mode?: ChangeEventSuppressionMode;
  excludedPolicyRuleIds?: string[];
  ignoreExistingSuppression?: boolean;
};

const rejectedNoiseFlags = new Set([
  "access-error",
  "access_error",
  "captcha",
  "career-page",
  "career_page",
  "document-metadata-only-change",
  "document_metadata_only_change",
  "file-size-only",
  "file_size_only",
  "generic-listing",
  "generic_listing",
  "job-board",
  "job_board",
  "job-page",
  "job_page",
  "nav-chrome-noise",
  "nav_chrome_noise",
  "navigation",
  "news-event-recipient-noise",
  "news_event_recipient_noise",
  "page-collapse",
  "page-collapse-expansion",
  "page-expansion",
  "pdf-metadata-only",
  "pdf_metadata_only",
  "popup",
  "popup-modal-noise",
  "popup_modal_noise",
  "profile-roster-rotation",
  "profile_roster_rotation",
  "recipient-news",
  "recipient_news",
  "roster-rotation",
  "roster_rotation",
  "search-listing",
  "search_listing",
  "security-question",
  "security_question",
  "sibling-program",
  "sibling_program",
  "sibling-program-or-cross-award",
  "sibling_program_or_cross_award",
  "source-mismatch",
  "source_mismatch",
  "style-reflow",
  "style_reflow",
]);

const correctedEvidenceDiagnosticFlags = new Set([
  "unsupported-added-text",
  "unsupported-removed-text",
  "unsupported-date-change",
  "unsupported-amount-change",
  "before-after-identical",
  "before-text-still-present",
  "after-text-already-present",
  "before-text-not-found",
  "after-text-not-found",
]);

const applicantSignalPattern =
  /\b(?:application deadline|deadline|due date|opening date|applications?(?: period| cycle| status)? (?:is |are |has |have |will )?(?:now )?(?:open|opened|close|closed|closing|due)|closing date|award amount|funding|stipend|tuition|eligib(?:ility|le)|application requirements?|award conditions?|letters? of recommendation|transcript|essay|nomination|application materials?|required documents?|how to apply|apply by|submit by|application portal|application instructions?|citizenship|gpa|interview)\b/i;

const alwaysBadSourcePattern =
  /\b(?:jobs?|careers?|employment|search results?|payment|bursar|1098t|security question|access denied|login|sign in)\b|\/(?:jobs?|careers?|employment|search|results|listing|list|directory|database|payment|payments|bursar|1098t|login|signin|sign-in)(?:[/?#]|$)/i;

const conditionalSourceShapePattern =
  /\b(?:profile|profiles|recipients?|awardees?|testimonial|news|press release|events? calendar)\b|\/(?:profile|profiles|recipients?|awardees?|news|press|events?|calendar)(?:[/?#]|$)/i;

const noiseSummaryPatterns = [
  { reason: "file_size_or_loading_time_noise", pattern: /\b(?:file size|pdf file size|loading time|load time|hash only|metadata only)\b/i },
  { reason: "security_question_or_access_noise", policyId: "source_access_error", pattern: /\b(?:security question|access denied|login required|authentication required|captcha|forbidden)\b/i },
  { reason: "plugin_or_version_noise", pattern: /\b(?:jump appsolutions|appsolutions|plugin version|version (?:number )?(?:changed|updated)|v\d+(?:\.\d+){1,3})\b/i },
  { reason: "related_content_link_noise", pattern: /\b(?:related content|related links|more like this|similar activities|recommended links)\b/i },
  { reason: "profile_roster_news_noise", pattern: /\b(?:current fellows?|profile content|testimonial|recipient(?:s)?|awardee(?:s)?|roster|news item|press release)\b/i },
  { reason: "generic_page_update_noise", pattern: /\b(?:page (?:content )?(?:changed|updated|refreshed)|website content changed|visual update detected|detected change)\b/i },
];

export const deterministicChangeEventSuppressionPolicyFlagIds = Object.freeze([
  "relative_age_timestamp_churn",
  "current_date_only_churn",
  "recipient_news_change",
  "profile_roster_rotation",
  "document_metadata_only_change",
  "fundraising_form_change",
  "navigation_or_reorder_only_change",
  "calendar_event_noise",
  "site_chrome_or_transient_notice",
  "animated_stat_counter",
  "source_access_error",
  "raw_scrape_signal",
  "generic_latest_updates_block",
  "sample_expansion",
  "no_actual_changed_fact",
  "unsupported_structured_fact",
  "format_only_change",
  "context_only_change",
  "indistinct_truncated_snippet",
  "orphan_punctuation",
  "vague_summary",
  "ai_invalid_json",
]);

export const changeEventSuppressionRulesRequiringEvidenceOrAi = Object.freeze([
  "sample_expansion",
  "no_actual_changed_fact",
  "unsupported_structured_fact",
  "context_only_change",
  "indistinct_truncated_snippet",
]);

export function isChangeEventSuppressed(change: ChangeEventSuppressionCandidate | null | undefined) {
  if (!change) return false;
  if (change.suppressed_at) return true;
  const details = objectValue(change.change_details);
  return Boolean(details.suppressed_at || details.suppression_reason);
}

export function changeEventSuppressionDecision(
  change: ChangeEventSuppressionCandidate,
  source?: ChangeEventSuppressionSource | null,
  options: ChangeEventSuppressionOptions = {},
): ChangeEventSuppressionDecision {
  const retroSweep = options.mode === "retro_sweep";
  const excludedPolicyRuleIds = new Set(
    (Array.isArray(options.excludedPolicyRuleIds)
      ? options.excludedPolicyRuleIds
      : [])
      .map(reviewableMonitoringPolicyFlagIdForAlias)
      .filter((policyId): policyId is string => Boolean(policyId)),
  );
  if (!options.ignoreExistingSuppression && isChangeEventSuppressed(change)) {
    return { suppressed: true, reason: change.suppression_reason || "already_suppressed" };
  }

  if (!retroSweep && change.shared_award_source_id && !source) {
    return { suppressed: true, reason: "source_missing" };
  }

  if (
    !retroSweep &&
    source &&
    source.admin_review_status &&
    source.admin_review_status !== "open"
  ) {
    return { suppressed: true, reason: `source_status_${cleanKey(source.admin_review_status)}` };
  }

  const details = objectValue(change.change_details);
  const detailsStructured = objectValue(details.structured_diff);
  const sourceText = normalizeText([
    change.source_url,
    change.source_title,
    change.source_page_type,
    ...(retroSweep
      ? []
      : [source?.url, source?.title, source?.display_title, source?.page_type]),
  ].join(" "));
  const summaryText = normalizeText([
    change.summary,
    details.reader_summary,
    details.advisor_impact,
    details.exact_before,
    details.exact_after,
    details.before,
    details.after,
    details.section,
    details.change_type,
    ...stringArray(detailsStructured.noise_flags),
    ...stringArray(detailsStructured.added_text),
    ...stringArray(detailsStructured.removed_text),
    ...stringArray(detailsStructured.date_changes),
    ...stringArray(detailsStructured.amount_changes),
  ].join(" "));
  const hasApplicantSignal = applicantSignalPattern.test(summaryText);
  const deterministicEvidenceText = normalizeText([
    ...stringArray(detailsStructured.added_text),
    ...stringArray(detailsStructured.removed_text),
    ...stringArray(detailsStructured.date_changes),
    ...stringArray(detailsStructured.amount_changes),
  ].join(" "));
  const hasDeterministicApplicantSignal = applicantSignalPattern.test(deterministicEvidenceText);

  if (source && !retroSweep) {
    const quality = sourceQualityDecision(source, { purpose: "monitoring" });
    const applicantEvidenceEscapesConditionalShape =
      quality.reason === "url_not_monitorable" &&
      conditionalSourceShapePattern.test(sourceText) &&
      hasDeterministicApplicantSignal;
    if (!quality.allowed && !applicantEvidenceEscapesConditionalShape) {
      return { suppressed: true, reason: `source_quality_${quality.reason}` };
    }
  }

  if (details.is_alert_worthy === false || details.isAlertWorthy === false) {
    return { suppressed: true, reason: "not_alert_worthy" };
  }
  if (cleanKey(details.generation_status) === "rejected") {
    return { suppressed: true, reason: "generation_status_rejected" };
  }

  const qualityFlags = changeEventQualityFlags(details);
  const preservesCorrectedEvidence = hasSupportedCorrectedEvidence(details);
  const flag = qualityFlags
    .map((value) =>
      qualityFlagSuppressionCandidate(value, {
        excludedPolicyRuleIds,
        preservesCorrectedEvidence,
      }),
    )
    .find((candidate) => candidate !== null);
  if (flag) {
    return {
      suppressed: true,
      reason: `${flag.policyFlag ? "policy_flag" : "quality_flag"}_${policyFlagId(flag.policyId || flag.value)}`,
    };
  }

  if (
    alwaysBadSourcePattern.test(sourceText) ||
    (conditionalSourceShapePattern.test(sourceText) && !hasDeterministicApplicantSignal)
  ) {
    return { suppressed: true, reason: "source_shape_noise" };
  }

  for (const item of noiseSummaryPatterns) {
    if (item.pattern.test(summaryText) && !hasApplicantSignal) {
      if (item.policyId && excludedPolicyRuleIds.has(item.policyId)) continue;
      if (retroSweep && item.policyId) continue;
      return { suppressed: true, reason: item.reason };
    }
  }

  const detectedPolicyFlag = textDetectedPolicyFlags({
    details,
    structured: detailsStructured,
    summaryText,
    hasApplicantSignal,
    hasDeterministicApplicantSignal,
  }).find(
    (policyId) =>
      !excludedPolicyRuleIds.has(policyId) &&
      isAlertBlockingMonitoringPolicyFlag(policyId) &&
      isPersistentMonitoringPolicyFlag(policyId),
  );
  if (detectedPolicyFlag) {
    return { suppressed: true, reason: `policy_flag_${detectedPolicyFlag}` };
  }

  return { suppressed: false, reason: null };
}

export function qualityFlagSuppressionCandidate(
  value: string,
  {
    excludedPolicyRuleIds = new Set<string>(),
    preservesCorrectedEvidence = false,
    activePolicyId = monitoringPolicyFlagIdForAlias(value),
    reviewablePolicyId = reviewableMonitoringPolicyFlagIdForAlias(value),
  }: {
    excludedPolicyRuleIds?: Set<string>;
    preservesCorrectedEvidence?: boolean;
    activePolicyId?: string | null;
    reviewablePolicyId?: string | null;
  } = {},
) {
  const cleanValue = cleanKey(value);
  if (reviewablePolicyId && excludedPolicyRuleIds.has(reviewablePolicyId)) {
    return null;
  }
  if (
    preservesCorrectedEvidence &&
    correctedEvidenceDiagnosticFlags.has(cleanValue)
  ) {
    return null;
  }
  const policyFlag = Boolean(
    activePolicyId &&
      isAlertBlockingMonitoringPolicyFlag(activePolicyId) &&
      isPersistentMonitoringPolicyFlag(activePolicyId),
  );
  const rawQualityFlag =
    rejectedNoiseFlags.has(cleanValue) && !reviewablePolicyId;
  if (!rawQualityFlag && !policyFlag) return null;
  return {
    value: cleanValue,
    policyId: activePolicyId,
    reviewablePolicyId,
    policyFlag,
    rawQualityFlag,
  };
}

function changeEventQualityFlags(details: Record<string, unknown>) {
  const structured = objectValue(details.structured_diff);
  return [
    ...stringArray(details.quality_flags),
    ...stringArray(details.noise_flags),
    ...stringArray(structured.noise_flags),
    cleanKey(details.noise_reason),
    cleanKey(details.rejection_reason),
  ].map(cleanKey).filter(Boolean);
}

function textDetectedPolicyFlags({
  details,
  structured,
  summaryText,
  hasApplicantSignal,
  hasDeterministicApplicantSignal,
}: {
  details: Record<string, unknown>;
  structured: Record<string, unknown>;
  summaryText: string;
  hasApplicantSignal: boolean;
  hasDeterministicApplicantSignal: boolean;
}): string[] {
  const matches: string[] = [];
  if (
    cleanKey(details.generation_status) === "invalid-json" ||
    /\b(?:invalid ai json|ai (?:returned|produced) invalid json|json parse (?:error|failure))\b/i.test(summaryText)
  ) matches.push("ai_invalid_json");

  if (
    /\b(?:access denied|security challenge|security question|captcha|forbidden|error 403|error 404|page not found|service unavailable)\b/i.test(summaryText) ||
    (!hasApplicantSignal && /\b(?:authentication (?:is )?required|login (?:is )?required|required to log in)\b/i.test(summaryText))
  ) matches.push("source_access_error");

  if (
    /\b(?:no actual (?:changed )?fact|no concrete (?:changed )?fact|before and after (?:text )?(?:are )?identical|claimed (?:new|added) text (?:was )?already present|claimed removed text (?:is|was) still present|nothing applicant-facing changed)\b/i.test(summaryText)
  ) matches.push("no_actual_changed_fact");

  if (
    /\b(?:unsupported structured fact|changed facts? (?:are |were )?not supported by (?:the )?evidence|exact before(?:-and-| and )after (?:is |was |are |were )?not supported by (?:the )?evidence|(?:added|removed|date|amount) (?:text |change |fact )?(?:is |was )?unsupported|before text not found|after text not found)\b/i.test(summaryText)
  ) matches.push("unsupported_structured_fact");

  if (hasRelativeAgeOnlyPolicyChange({
    readerSummary: normalizeText(details.reader_summary) || null,
    section: normalizeText(details.section) || null,
    before: normalizeText(details.exact_before || details.before) || null,
    after: normalizeText(details.exact_after || details.after) || null,
    addedText: stringArray(structured.added_text),
    removedText: stringArray(structured.removed_text),
    dateChanges: stringArray(structured.date_changes),
    amountChanges: stringArray(structured.amount_changes),
  })) matches.push("relative_age_timestamp_churn");

  if (!hasApplicantSignal) {
    if (
      /\b(?:current date|today's date|(?:open|closed) today|last updated|generated (?:on|at)|copyright year|post id|writer id|view count|countdown)\b/i.test(summaryText)
    ) matches.push("current_date_only_churn");
    if (
      /\b(?:recipient|awardee|winner|finalist|alumni|fellow)\b.{0,50}\b(?:announced|announcement|news|story|profile|roster|list|changed|updated|rotated)\b|\b(?:news item|press release)\b/i.test(summaryText)
    ) matches.push("recipient_news_change");
    if (
      /\b(?:profile|testimonial|roster|carousel|featured (?:fellow|student|recipient)|alumni story|student story)\b.{0,60}\b(?:changed|updated|refreshed|rotated|reordered|new|removed)\b/i.test(summaryText)
    ) matches.push("profile_roster_rotation");
    if (
      /\b(?:pdf |document )?(?:file size|metadata|hash|modified timestamp|creation date)(?: only| changed| updated)|\bmetadata-only\b/i.test(summaryText)
    ) matches.push("document_metadata_only_change");
    if (
      /\b(?:donat(?:e|ion)|fundrais(?:e|er|ing)|give now|giving form|checkout|shopping cart|gift amount|donor form|sponsor(?:ship)? (?:form|widget))\b/i.test(summaryText)
    ) matches.push("fundraising_form_change");
    if (
      /\b(?:navigation|nav menu|footer|header|sidebar|breadcrumb|faq|frequently asked questions|link order|reorder(?:ed|ing)?|layout|style reflow|font|line wrap)\b.{0,60}\b(?:changed|updated|refreshed|moved|reordered|only)\b/i.test(summaryText)
    ) matches.push("navigation_or_reorder_only_change");
    if (
      /\b(?:calendar|conference|admissions event|webinar|workshop|event registration|events? listing)\b.{0,60}\b(?:changed|updated|added|removed|refreshed|rotated)\b/i.test(summaryText)
    ) matches.push("calendar_event_noise");
    if (
      /\b(?:cookie|consent|privacy banner|popup|pop-up|modal|newsletter prompt|advertisement|captcha widget|sitewide notice|holiday hours|office hours|transient notice|loading state)\b.{0,60}\b(?:changed|updated|appeared|disappeared|opened|closed|refreshed|rotated|only)\b/i.test(summaryText)
    ) matches.push("site_chrome_or_transient_notice");
    if (
      /\b(?:animated|count-up|counter|impact number|kpi|statistic)\b.{0,60}\b(?:changed|drift|loaded|loading|animation|incremented)\b/i.test(summaryText)
    ) matches.push("animated_stat_counter");
    if (
      /\b(?:raw scrape|scrape artifact|leaked markup|html markup|jump links?|menu blob|learn more links?)\b/i.test(summaryText)
    ) matches.push("raw_scrape_signal");
    if (
      /\b(?:latest updates?|latest news|news sidebar|cross-program updates?)\b.{0,60}\b(?:changed|updated|refreshed|rotated|added|removed)\b/i.test(summaryText)
    ) matches.push("generic_latest_updates_block");
    if (
      /\b(?:sample expansion|recrawl length|crawl length|pre-existing surrounding content|more of the same page was captured)\b/i.test(summaryText)
    ) matches.push("sample_expansion");
  }

  if (
    !hasDeterministicApplicantSignal &&
    /\b(?:(?:format|formatting|whitespace|capitalization|punctuation|line wrapping|styling)(?:[- ]only| alone)|only (?:the )?(?:format|formatting|whitespace|capitalization|punctuation|line wrapping|styling) changed|only .{0,60}\b(?:format|formatting|whitespace|capitalization|punctuation|line wrapping|styling) changed)\b/i.test(summaryText)
  ) matches.push("format_only_change");
  if (
    !hasDeterministicApplicantSignal &&
    /\b(?:context-only|container-only|only (?:the )?(?:context|container) changed|surrounding context changed but (?:the )?fact (?:did not|does not|was unchanged))\b/i.test(summaryText)
  ) matches.push("context_only_change");
  if (
    !hasDeterministicApplicantSignal &&
    /\b(?:indistinct|truncated (?:snippet|evidence|text)|insufficient (?:evidence|context)|snippet too vague|cannot determine from (?:the )?(?:snippet|evidence))\b/i.test(summaryText)
  ) matches.push("indistinct_truncated_snippet");
  if (
    !hasDeterministicApplicantSignal &&
    /\b(?:orphan punctuation|punctuation mark (?:appeared|disappeared) by itself|standalone punctuation)\b/i.test(summaryText)
  ) matches.push("orphan_punctuation");
  if (
    !hasApplicantSignal &&
    /\b(?:the )?(?:page|website|content) (?:changed|updated|refreshed)(?: without (?:a )?specific|,? but no specific| generally| visually)?\b/i.test(summaryText)
  ) matches.push("vague_summary");

  return matches;
}

function hasSupportedCorrectedEvidence(details: Record<string, unknown>) {
  if (details.is_alert_worthy !== true || cleanKey(details.generation_status) !== "generated") {
    return false;
  }
  const qualityFlags = stringArray(details.quality_flags).map(cleanKey).filter(Boolean);
  if (
    !qualityFlags.includes("evidence-sanity-corrected") ||
    !qualityFlags.includes("visual-snapshot-comparison")
  ) {
    return false;
  }

  const structured = objectValue(details.structured_diff);
  if (
    [
      ...stringArray(structured.added_text),
      ...stringArray(structured.removed_text),
      ...stringArray(structured.date_changes),
      ...stringArray(structured.amount_changes),
    ].some((value) => normalizeText(value))
  ) {
    return true;
  }

  const before = normalizeText(details.exact_before || details.before).toLowerCase();
  const after = normalizeText(details.exact_after || details.after).toLowerCase();
  return Boolean((before || after) && (!before || !after || before !== after));
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringArray(value: unknown) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((item) => String(item || ""));
  if (typeof value === "string") return value.split(/[,;|]/);
  return [];
}

function normalizeText(value: unknown) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function cleanKey(value: unknown) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]+/g, "")
    .replace(/-+/g, "-");
}

function policyFlagId(value: unknown) {
  return cleanKey(value).replace(/-/g, "_");
}
