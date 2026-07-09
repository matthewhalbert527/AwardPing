import { sourceQualityDecision, type SourceQualitySource } from "@/lib/source-quality";

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

const applicantSignalPattern =
  /\b(application deadline|deadline|due date|opening date|opens?|closing date|closes?|award amount|amount|funding|stipend|tuition|eligib|requirements?|award conditions?|recommendation|transcript|essay|nomination|materials?|documents?|form|how to apply|apply by|submit by)\b/i;

const badSourcePattern =
  /\b(job|jobs|career|careers|employment|search results?|listing|payment|bursar|1098t|security question|access denied|login|sign in|profile|profiles|recipients?|awardees?|testimonial|news|press release)\b|\/(?:jobs?|careers?|employment|search|results|listing|list|directory|database|payment|payments|bursar|1098t|login|signin|sign-in|profile|profiles|recipients?|awardees?|news|events?)(?:[/?#]|$)/i;

const noiseSummaryPatterns = [
  { reason: "file_size_or_loading_time_noise", pattern: /\b(?:file size|pdf file size|loading time|load time|hash only|metadata only)\b/i },
  { reason: "security_question_or_access_noise", pattern: /\b(?:security question|access denied|login required|authentication required|captcha|forbidden)\b/i },
  { reason: "plugin_or_version_noise", pattern: /\b(?:jump appsolutions|appsolutions|plugin version|version (?:number )?(?:changed|updated)|v\d+(?:\.\d+){1,3})\b/i },
  { reason: "related_content_link_noise", pattern: /\b(?:related content|related links|more like this|similar activities|recommended links)\b/i },
  { reason: "profile_roster_news_noise", pattern: /\b(?:current fellows?|profile content|testimonial|recipient(?:s)?|awardee(?:s)?|roster|news item|press release)\b/i },
  { reason: "generic_page_update_noise", pattern: /\b(?:page (?:content )?(?:changed|updated|refreshed)|website content changed|visual update detected|detected change)\b/i },
];

export function isChangeEventSuppressed(change: ChangeEventSuppressionCandidate | null | undefined) {
  if (!change) return false;
  if (change.suppressed_at) return true;
  const details = objectValue(change.change_details);
  return Boolean(details.suppressed_at || details.suppression_reason);
}

export function changeEventSuppressionDecision(
  change: ChangeEventSuppressionCandidate,
  source?: ChangeEventSuppressionSource | null,
): ChangeEventSuppressionDecision {
  if (isChangeEventSuppressed(change)) {
    return { suppressed: true, reason: change.suppression_reason || "already_suppressed" };
  }

  if (change.shared_award_source_id && !source) {
    return { suppressed: true, reason: "source_missing" };
  }

  if (source && source.admin_review_status && source.admin_review_status !== "open") {
    return { suppressed: true, reason: `source_status_${cleanKey(source.admin_review_status)}` };
  }

  if (source) {
    const quality = sourceQualityDecision(source, { purpose: "monitoring" });
    if (!quality.allowed) return { suppressed: true, reason: `source_quality_${quality.reason}` };
  }

  const details = objectValue(change.change_details);
  if (details.is_alert_worthy === false || details.isAlertWorthy === false) {
    return { suppressed: true, reason: "not_alert_worthy" };
  }
  if (cleanKey(details.generation_status) === "rejected") {
    return { suppressed: true, reason: "generation_status_rejected" };
  }

  const flag = changeEventQualityFlags(details).find((value) => rejectedNoiseFlags.has(value));
  if (flag) return { suppressed: true, reason: `quality_flag_${flag}` };

  const sourceText = normalizeText([
    change.source_url,
    change.source_title,
    change.source_page_type,
    source?.url,
    source?.title,
    source?.display_title,
    source?.page_type,
  ].join(" "));
  if (badSourcePattern.test(sourceText)) {
    return { suppressed: true, reason: "source_shape_noise" };
  }

  const summaryText = normalizeText([
    change.summary,
    details.reader_summary,
    details.advisor_impact,
    details.before,
    details.after,
    details.section,
    details.change_type,
    ...stringArray(objectValue(details.structured_diff).noise_flags),
    ...stringArray(objectValue(details.structured_diff).added_text),
    ...stringArray(objectValue(details.structured_diff).removed_text),
  ].join(" "));
  const hasApplicantSignal = applicantSignalPattern.test(summaryText);
  for (const item of noiseSummaryPatterns) {
    if (item.pattern.test(summaryText) && !hasApplicantSignal) {
      return { suppressed: true, reason: item.reason };
    }
  }

  return { suppressed: false, reason: null };
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
