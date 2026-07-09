import crypto from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { monitoringPolicyPromptLinesForScope } from "./award-monitoring-policy.mjs";
import { sourceBaselineFacts, sourceQualityDecision } from "./source-quality.mjs";

export const visualReviewResponseSchema = {
  type: "object",
  properties: {
    is_true_change: { type: "boolean" },
    is_alert_worthy: { type: "boolean" },
    source_relevance: { type: "string", enum: ["primary", "supporting", "unclear", "unrelated"] },
    source_relevance_reason: { type: "string", nullable: true },
    changed_facts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          fact: { type: "string" },
          before: { type: "string", nullable: true },
          after: { type: "string", nullable: true },
          added_text: { type: "string", nullable: true },
          removed_text: { type: "string", nullable: true },
          visual_evidence: { type: "string", nullable: true },
        },
      },
    },
    changed_award_facts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          fact: { type: "string" },
          before: { type: "string", nullable: true },
          after: { type: "string", nullable: true },
          added_text: { type: "string", nullable: true },
          removed_text: { type: "string", nullable: true },
          visual_evidence: { type: "string", nullable: true },
        },
      },
    },
    exact_before: { type: "string", nullable: true },
    exact_after: { type: "string", nullable: true },
    evidence_location: { type: "string", nullable: true },
    before: { type: "string", nullable: true },
    after: { type: "string", nullable: true },
    section: { type: "string", nullable: true },
    change_type: { type: "string", nullable: true },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    noise_flags: { type: "array", items: { type: "string" } },
    rejection_reason: { type: "string", nullable: true },
    reader_summary: { type: "string", nullable: true },
    advisor_impact: { type: "string", nullable: true },
    structured_diff: {
      type: "object",
      nullable: true,
      properties: {
        added_text: { type: "array", items: { type: "string" } },
        removed_text: { type: "array", items: { type: "string" } },
        date_changes: { type: "array", items: { type: "string" } },
        amount_changes: { type: "array", items: { type: "string" } },
        noise_flags: { type: "array", items: { type: "string" } },
        likely_section: { type: "string", nullable: true },
        page_type: { type: "string", nullable: true },
      },
    },
  },
  required: [
    "is_true_change",
    "is_alert_worthy",
    "source_relevance",
    "source_relevance_reason",
    "changed_facts",
    "exact_before",
    "exact_after",
    "evidence_location",
    "before",
    "after",
    "section",
    "change_type",
    "confidence",
    "noise_flags",
    "rejection_reason",
  ],
};

const rejectNoiseFlags = new Set([
  "access-error",
  "captcha",
  "career-page",
  "cookie-banner",
  "current-date-only",
  "file-size-only",
  "footer",
  "generic-listing",
  "job-page",
  "job-board",
  "job-board-update",
  "lazy-load-expansion-noise",
  "nav",
  "nav-chrome-noise",
  "navigation",
  "news-event-recipient-noise",
  "page-collapse",
  "page-expansion",
  "pdf-metadata-only",
  "popup",
  "popup-modal-noise",
  "profile-rotation",
  "profile-roster-rotation",
  "recipient-news",
  "roster-rotation",
  "search-listing",
  "security-question",
  "sidebar",
  "sibling-program",
  "sibling-program-or-cross-award",
  "style-reflow",
]);

const applicantFactSignalPattern =
  /\b(deadline|due|open(?:ing)? date|closes?|application|apply|eligib|requirement|condition|recommendation|transcript|essay|nomination|funding|stipend|tuition|award amount|amount|prize|grant|materials?|document|guideline|form|citizenship|gpa|interview|selection)\b/i;
const criticalAwardFactPattern =
  /\b(deadline|due|open(?:ing)? date|closes?|funding|stipend|tuition|award amount|amount|prize|grant|eligib|requirement|condition|materials?|document|form|application|apply)\b/i;
const sourceNoisePatterns = [
  {
    label: "access_error",
    reason: "security_or_access_page",
    pattern: /\b(?:security question|captcha|access denied|authentication required|auth required|login required|forbidden|blocked|ask\.loc\.gov|libanswers)\b|\/(?:login|signin|sign-in|account|password)(?:[/?#]|$)/i,
  },
  {
    label: "access_error",
    reason: "payment_or_bursar_page",
    pattern: /\b(?:payment|payments|bursar|billing|1098t|1098-t|tax form|tuition payment)\b|\/(?:payment|payments|pay|billing|bursar|1098t|1098-t)(?:[/?#]|$)/i,
  },
  {
    label: "news_event_recipient_noise",
    reason: "job_board_or_career_page",
    pattern: /\b(?:job board|career page|job posting|employment opportunity)\b|\/(?:careers?|jobs?|employment|job-profile|jobprofile)(?:[/?#]|$)/i,
  },
  {
    label: "profile_roster_rotation",
    reason: "profile_roster_or_testimonial_page",
    pattern: /\b(?:testimonial|profile|profiles|featured fellow|fellow profile|alumni story|student story|spotlight)\b|\/(?:profiles?|profile|testimonials?|stories?|spotlight|alumni)(?:[/?#]|$)/i,
  },
  {
    label: "news_event_recipient_noise",
    reason: "news_event_recipient_or_listing_page",
    pattern: /\b(?:news listing|press release|recipient(?:s)?|awardee(?:s)?|past fellows?|current fellows?|events? calendar)\b|\/(?:news|events|event|calendar|recipients?|awardees?|fellows?|past-fellows|current-fellows|press)(?:[/?#]|$)/i,
  },
  {
    label: "nav_chrome_noise",
    reason: "search_listing_or_broad_portal",
    pattern: /\b(?:search results?|database results?|listing page|broad portal|find programs?)\b|\/(?:search|results|listing|list|directory|database|find-programs?|program-search|scholarship-search)(?:[/?#]|$)|[?&](?:q|query|search|keyword|category|tag|page|sort)=/i,
  },
];
const popupModalPattern =
  /\b(?:cookie|cookies|popup|pop-up|modal|newsletter|subscribe|free app|download app|install app|accept all|privacy preferences|jump appsolutions|appsolutions|version\s*\d+(?:\.\d+){1,3}|v\d+(?:\.\d+){1,3})\b/i;
const navChromePattern =
  /\b(?:navigation|menu|footer|header|sidebar|breadcrumb|skip to content|social media|share this|search|site map|copyright|all rights reserved|font size|layout|style|expanded|collapsed|accordion)\b/i;
const profileRosterPattern =
  /\b(?:profile|testimonial|featured fellow|fellows?|recipient|awardee|alumni|roster|story|spotlight|honoree|winner|committee member)\b/i;
const newsEventRecipientPattern =
  /\b(?:news|event|calendar|webinar|press release|recipient|awardee|fellows? announced|more like this|related articles?|latest posts?)\b/i;
const accessErrorPattern =
  /\b(?:security question|captcha|access denied|authentication required|auth required|login required|forbidden|blocked|error 403|error 404|not found|service unavailable)\b/i;
const lazyLoadPattern =
  /\b(?:more like this|similar activities|load more|show more|read more|expanded|collapsed|accordion|lazy loaded|related content|you may also like)\b/i;
const timestampNoisePattern =
  /\b(?:current date|today is|last updated|updated on|updated at|generated on|copyright|countdown|days? left|hours? left|minutes? left|\d+\s*(?:days?|hours?|minutes?)\s*(?:ago|left|remaining))\b/i;

export function normalizeVisualReviewMode(value, fallback = "batch") {
  if (value === undefined || value === null || value === "") return fallback;
  const raw = String(value).trim().toLowerCase();
  if (["batch", "queued", "queue"].includes(raw)) return "batch";
  if (["immediate", "sync", "synchronous", "debug"].includes(raw)) return "immediate";
  if (["none", "false", "0", "no", "off", "disabled"].includes(raw)) return "none";
  if (["true", "1", "yes", "on"].includes(raw)) return fallback;
  return fallback;
}

export function classifyVisualReviewCandidate({
  source,
  diff = {},
  deterministic = {},
  baseline = {},
  previous = {},
  capture = {},
} = {}) {
  const quality = sourceQualityDecision(source, { purpose: "monitoring" });
  const evidence = candidateEvidence({ diff, deterministic, baseline, previous, capture });
  const reject = (label, reason, extra = {}) => ({
    allowed: false,
    label,
    reason,
    candidate_kind: evidence.has_text_evidence ? "text_only" : "visual_only",
    evidence,
    ...extra,
  });
  const allow = (label, reason, extra = {}) => ({
    allowed: true,
    label,
    reason,
    candidate_kind: evidence.has_text_evidence ? "text_only" : "visual_only",
    evidence,
    ...extra,
  });

  if (!quality.allowed) {
    return reject(sourceNoiseClassFromSource(source, evidence.changed_text)?.label || labelForSourceQualityReason(quality.reason), `source_quality_${quality.reason}`, {
      source_rejected: true,
      source_quality: quality,
    });
  }

  const sourceNoise = sourceNoiseClassFromSource(source, evidence.changed_text);
  if (sourceNoise) {
    return reject(sourceNoise.label, sourceNoise.reason, {
      source_rejected: true,
      source_noise: sourceNoise,
    });
  }

  if (deterministic?.candidate_change === false) {
    return reject(noiseLabelForReason(deterministic.reason), deterministic.reason || "deterministic_rejected");
  }

  if (looksLikePdfMetadataOnly({ diff, deterministic, evidence })) {
    return reject("pdf_metadata_only", "pdf_metadata_only");
  }

  const textNoise = contentNoiseClass(evidence.changed_text, source);
  if (textNoise) return reject(textNoise.label, textNoise.reason);

  if (!evidence.has_text_evidence) {
    if (
      evidence.has_visual_evidence &&
      evidence.visual_reason &&
      evidence.thumbnail_ref &&
      stableVisualOnlySource(source, quality)
    ) {
      return allow("visual_only_candidate", "visual_only_with_thumbnail_evidence");
    }
    return reject("lazy_load_expansion_noise", "visual_only_missing_localized_or_thumbnail_evidence");
  }

  if (!evidence.added_text.length && !evidence.removed_text.length) {
    return reject("text_only_candidate", "missing_added_or_removed_text_evidence");
  }

  if (hasSiblingProgramSignal(source, evidence.changed_text)) {
    return reject("sibling_program_or_cross_award", "sibling_program_or_cross_award");
  }

  if (criticalAwardFactPattern.test(evidence.changed_text)) {
    return allow("applicant_fact_change", "applicant_fact_signal");
  }

  if (applicantFactSignalPattern.test(evidence.changed_text)) {
    return allow("text_only_candidate", "text_only_applicant_signal");
  }

  return reject("text_only_candidate", "text_only_noise_without_applicant_signal");
}

export function visualReviewCandidateSignature({
  source,
  baseline,
  capture,
  diff,
  deterministic,
  behaviorVersion,
}) {
  const payload = {
    source_id: source?.id || null,
    previous_text_hash: baseline?.text_hash || null,
    new_text_hash: capture?.text_hash || null,
    previous_image_hash: baseline?.image_hash || null,
    new_image_hash: capture?.image_hash || null,
    previous_file_hash: baseline?.file_hash || null,
    new_file_hash: capture?.file_hash || null,
    deterministic_diff: compactDiffSignature(diff),
    deterministic_classification: deterministic?.classification || deterministic?.reason || null,
    behavior_version: behaviorVersion || null,
  };
  return crypto.createHash("sha256").update(stableJsonStringify(payload)).digest("hex");
}

export function buildVisualReviewPromptPayload({
  source,
  baseline,
  previous,
  capture,
  diff,
  deterministic,
  promptChars = 12_000,
  behaviorVersion,
  behaviorName,
  archiveRelative = (value) => value || null,
}) {
  const baselineFacts = sourceBaselineFacts(source);
  const previousRef = snapshotRef(previous, baseline, archiveRelative);
  const newRef = snapshotRef(capture, capture, archiveRelative);
  const includeImages = shouldIncludeImagesForCandidate({
    previous,
    capture,
    diff,
    deterministic,
  });

  return {
    version: 1,
    behavior_version: behaviorVersion || null,
    behavior_name: behaviorName || null,
    source: {
      id: source?.id || null,
      shared_award_id: source?.shared_award_id || null,
      award_name: source?.shared_awards?.name || null,
      title: source?.title || null,
      url: source?.url || null,
      page_type: source?.page_type || null,
      baseline_facts: baselineFacts,
    },
    previous_snapshot_ref: previousRef,
    new_snapshot_ref: newRef,
    hashes: {
      previous_text_hash: baseline?.text_hash || null,
      new_text_hash: capture?.text_hash || null,
      previous_image_hash: baseline?.image_hash || null,
      new_image_hash: capture?.image_hash || null,
      previous_file_hash: baseline?.file_hash || null,
      new_file_hash: capture?.file_hash || null,
    },
    deterministic_classification: deterministic || {},
    deterministic_diff: diff || {},
    include_images: includeImages,
    previous_text_excerpt: String(previous?.text || "").slice(0, promptChars),
    new_text_excerpt: String(capture?.text || "").slice(0, promptChars),
    text_evidence: {
      added_text: stringArray(diff?.added_text).slice(0, 16),
      removed_text: stringArray(diff?.removed_text).slice(0, 16),
      date_changes: stringArray(diff?.date_changes).slice(0, 12),
      amount_changes: stringArray(diff?.amount_changes).slice(0, 12),
    },
  };
}

export function buildVisualReviewPromptText(payload) {
  return [
    "You are reviewing an official scholarship/fellowship award source page for AwardPing.",
    "Return strict JSON only. Do not use markdown.",
    "Default to rejection when uncertain.",
    "Approve only concrete, applicant-facing changes to the named award: deadlines, opening/closing dates, eligibility, award conditions, application materials, nomination/recommendation instructions, award amount/funding, documents/guidelines, or how to apply.",
    "Reject profile rotations, recipient/news/listing churn, nav/footer/sidebar changes, popups, access/security questions, CAPTCHA, search/listing changes, job/career pages, sibling-program changes, and file-size-only PDF changes.",
    "Do not treat page redesign, image changes, popups, navigation, staff/profile/fellow/news rotations, or file metadata as applicant-facing changes.",
    "Never use facts from sibling awards or broad search/listing pages.",
    ...monitoringPolicyPromptLinesForScope("visual_review_batch"),
    "Do not infer a change from a page title, layout movement, menu expansion/collapse, or generic page refresh.",
    "Every approved changed_facts item must include exact added_text or removed_text from the deterministic diff, or a specific visual_evidence phrase when the screenshot changed but text extraction did not capture the changed section.",
    "exact_before and exact_after must be exact strings from deterministic diff evidence, or null only when the change is one-sided and the other side is genuinely absent.",
    "source_relevance must be primary or supporting only when this exact page is about the named award or a directly supporting official source for it.",
    "",
    "Required JSON keys:",
    "{is_true_change, is_alert_worthy, source_relevance, source_relevance_reason, changed_facts, exact_before, exact_after, evidence_location, before, after, section, change_type, confidence, noise_flags, rejection_reason, reader_summary, advisor_impact, structured_diff}",
    "",
    "Award/source context:",
    stableJsonStringify(payload.source),
    "",
    "Source baseline facts/relevance metadata:",
    stableJsonStringify(payload.source?.baseline_facts || {}),
    "",
    "Previous snapshot metadata:",
    stableJsonStringify(payload.previous_snapshot_ref || {}),
    "",
    "New snapshot metadata:",
    stableJsonStringify(payload.new_snapshot_ref || {}),
    "",
    "Hashes:",
    stableJsonStringify(payload.hashes || {}),
    "",
    "Deterministic classification:",
    stableJsonStringify(payload.deterministic_classification || {}),
    "",
    "Deterministic diff summary:",
    stableJsonStringify(payload.deterministic_diff || {}),
    "",
    "Previous normalized text excerpt:",
    payload.previous_text_excerpt || "",
    "",
    "New normalized text excerpt:",
    payload.new_text_excerpt || "",
  ].join("\n");
}

export function normalizeVisualBatchResult(value, { candidate = null, source = null } = {}) {
  const parsed = typeof value === "string" ? parseJsonObject(value) : objectValue(value);
  if (!parsed || !Object.keys(parsed).length) {
    throw new Error("Gemini visual review returned invalid JSON.");
  }
  const isTrueChange = booleanValue(parsed.is_true_change);
  const isAlertWorthy = booleanValue(parsed.is_alert_worthy);
  const confidence = normalizeConfidence(parsed.confidence);
  const structuredDiff = normalizeStructuredDiff(
    parsed.structured_diff,
    candidate?.deterministic_diff || candidate?.prompt_payload?.deterministic_diff || {},
    source,
  );
  const noiseFlags = unique([
    ...stringArray(parsed.noise_flags),
    ...stringArray(parsed.quality_flags),
    ...structuredDiff.noise_flags,
  ].map(cleanKey).filter(Boolean));

  return {
    is_true_change: Boolean(isTrueChange),
    is_alert_worthy: Boolean(isAlertWorthy),
    source_relevance: normalizeSourceRelevance(parsed.source_relevance),
    source_relevance_reason: cleanNullable(parsed.source_relevance_reason),
    changed_facts: normalizeChangedFacts(parsed.changed_facts || parsed.changed_award_facts),
    changed_award_facts: normalizeChangedFacts(parsed.changed_award_facts || parsed.changed_facts),
    exact_before: cleanNullable(parsed.exact_before ?? parsed.before),
    exact_after: cleanNullable(parsed.exact_after ?? parsed.after),
    evidence_location: cleanNullable(parsed.evidence_location),
    before: cleanNullable(parsed.exact_before ?? parsed.before),
    after: cleanNullable(parsed.exact_after ?? parsed.after),
    section: cleanNullable(parsed.section || parsed.changed_section || structuredDiff.likely_section),
    change_type: cleanKey(parsed.change_type) || inferChangeType(parsed, structuredDiff),
    confidence,
    noise_flags: noiseFlags,
    rejection_reason: cleanNullable(parsed.rejection_reason || parsed.noise_reason),
    reader_summary: cleanNullable(parsed.reader_summary),
    advisor_impact: cleanNullable(parsed.advisor_impact),
    structured_diff: structuredDiff,
    quality_flags: noiseFlags,
    raw_result: parsed,
  };
}

export function validateVisualBatchReview({ candidate, source, result }) {
  const reject = (reason) => ({ allowed: false, reason });
  const quality = sourceQualityDecision(source, { purpose: "monitoring" });
  if (!quality.allowed) return reject(`source_quality_${quality.reason}`);

  if (!result?.is_true_change || !result?.is_alert_worthy) {
    return reject(result?.rejection_reason || "not_alert_worthy");
  }
  if (!["medium", "high"].includes(result.confidence)) return reject("low_confidence");
  if (!["primary", "supporting"].includes(result.source_relevance)) {
    return reject(`source_relevance_${result.source_relevance || "missing"}`);
  }

  const rejectFlag = stringArray(result.noise_flags)
    .map(cleanKey)
    .find((flag) => rejectNoiseFlags.has(flag));
  if (rejectFlag) return reject(`noise_flag_${rejectFlag}`);

  const facts = normalizeChangedFacts(result.changed_facts || result.changed_award_facts);
  if (!facts.length) return reject("missing_changed_award_facts");
  if (!exactBeforeAfterSupportedByEvidence({ result, candidate })) return reject("exact_before_after_not_supported_by_evidence");
  const unsupportedFact = facts.find((fact) => !changedFactHasEvidence({ fact, result, candidate }));
  if (unsupportedFact) {
    return reject("changed_facts_not_supported_by_evidence");
  }

  const combined = normalizeText([
    result.reader_summary,
    result.advisor_impact,
    result.section,
    result.change_type,
    result.before,
    result.after,
      ...facts.flatMap((fact) => [
      fact.fact,
      fact.before,
      fact.after,
      fact.added_text,
      fact.removed_text,
      fact.visual_evidence,
    ]),
  ].join(" "));

  if (looksLikeRejectedNoise(combined)) return reject("known_noise_pattern");
  if (!hasAwardChangeSignal(combined)) return reject("missing_award_change_signal");

  return { allowed: true, reason: "approved" };
}

export function changeDetailsFromVisualBatchResult({ candidate, source, result, model }) {
  const structuredDiff = result.structured_diff || normalizeStructuredDiff({}, candidate?.deterministic_diff || {}, source);
  return {
    reader_summary:
      cleanNullable(result.reader_summary) ||
      cleanNullable(result.advisor_impact) ||
      "An award source page changed.",
    before: cleanNullable(result.before),
    after: cleanNullable(result.after),
    section: cleanNullable(result.section || structuredDiff.likely_section),
    change_type: cleanKey(result.change_type) || inferChangeType(result, structuredDiff),
    advisor_impact: cleanNullable(result.advisor_impact),
    is_alert_worthy: Boolean(result.is_alert_worthy),
    confidence: normalizeConfidence(result.confidence) || "low",
    structured_diff: structuredDiff,
    changed_award_facts: normalizeChangedFacts(result.changed_facts || result.changed_award_facts),
    changed_facts: normalizeChangedFacts(result.changed_facts || result.changed_award_facts),
    source_relevance: result.source_relevance || null,
    source_relevance_reason: result.source_relevance_reason || null,
    exact_before: cleanNullable(result.exact_before || result.before),
    exact_after: cleanNullable(result.exact_after || result.after),
    evidence_location: result.evidence_location || null,
    source: {
      award_name: source?.shared_awards?.name || candidate?.prompt_payload?.source?.award_name || null,
      source_title: source?.title || candidate?.source_title || null,
      source_url: source?.url || candidate?.source_url || null,
      page_type: source?.page_type || candidate?.source_page_type || null,
    },
    quality_flags: unique(["visual_snapshot_batch_review", ...stringArray(result.noise_flags)]),
    candidate_signature: candidate?.candidate_signature || null,
    generated_at: new Date().toISOString(),
    generation_provider: "gemini_batch",
    generation_status: "generated",
    generation_model: model || candidate?.model || null,
  };
}

export function visualHashFromCandidate(candidate, side) {
  const prefix = side === "previous" ? "previous" : "new";
  const hash =
    candidate?.[`${prefix}_file_hash`] ||
    candidate?.[`${prefix}_image_hash`] ||
    candidate?.[`${prefix}_text_hash`] ||
    candidate?.prompt_payload?.hashes?.[`${prefix}_file_hash`] ||
    candidate?.prompt_payload?.hashes?.[`${prefix}_image_hash`] ||
    candidate?.prompt_payload?.hashes?.[`${prefix}_text_hash`] ||
    "";
  return hash ? `visual:${hash}` : "";
}

export function stableJsonStringify(value) {
  return JSON.stringify(sortJson(value));
}

function snapshotRef(captureLike, hashLike, archiveRelative) {
  const ref = {
    captured_at: captureLike?.captured_at || hashLike?.captured_at || null,
    final_url: captureLike?.final_url || hashLike?.final_url || null,
    page_title: captureLike?.page_title || hashLike?.page_title || null,
    kind: captureLike?.kind || hashLike?.kind || null,
    text_hash: hashLike?.text_hash || captureLike?.text_hash || null,
    image_hash: hashLike?.image_hash || captureLike?.image_hash || null,
    file_hash: hashLike?.file_hash || captureLike?.file_hash || null,
    local_paths: {
      page: pathRef(captureLike?.pagePath || captureLike?.page_path, archiveRelative),
      thumb: pathRef(captureLike?.thumbPath || captureLike?.thumb_path, archiveRelative),
      pdf: pathRef(captureLike?.pdfPath || captureLike?.pdf_path, archiveRelative),
      text: pathRef(captureLike?.textPath || captureLike?.text_path, archiveRelative),
      meta: pathRef(captureLike?.metaPath || captureLike?.meta_path, archiveRelative),
    },
    capture_dir: pathRef(captureLike?.dir, archiveRelative),
    metadata: {
      status_code: captureLike?.status_code || null,
      content_type: captureLike?.content_type || null,
      page_count: captureLike?.page_count || null,
      dimensions: captureLike?.dimensions || null,
      hidden_noise_counts: captureLike?.hidden_noise_counts || null,
      localization: captureLike?.localization || captureLike?.location_metadata || null,
    },
  };
  return ref;
}

function pathRef(path, archiveRelative) {
  if (!path) return null;
  const ref = {
    path,
    archive_relative: archiveRelative(path),
    exists: false,
    bytes: null,
  };
  try {
    if (existsSync(path)) {
      const stats = statSync(path);
      ref.exists = true;
      ref.bytes = stats.size;
    }
  } catch {
    // Best-effort evidence metadata only.
  }
  return ref;
}

function shouldIncludeImagesForCandidate({ previous, capture, diff, deterministic }) {
  if (!thumbnailPath(previous) && !thumbnailPath(capture)) return false;
  const added = stringArray(diff?.added_text).join(" ");
  const removed = stringArray(diff?.removed_text).join(" ");
  if (!normalizeText(`${added} ${removed}`)) return true;
  const reason = normalizeText([deterministic?.classification, deterministic?.reason].join(" ")).toLowerCase();
  return reason.includes("visual") || reason.includes("screenshot");
}

function compactDiffSignature(diff = {}) {
  return {
    added_text: stringArray(diff.added_text).slice(0, 12).map(sentenceKey),
    removed_text: stringArray(diff.removed_text).slice(0, 12).map(sentenceKey),
    date_changes: stringArray(diff.date_changes).slice(0, 8).map(sentenceKey),
    amount_changes: stringArray(diff.amount_changes).slice(0, 8).map(sentenceKey),
    likely_section: cleanNullable(diff.likely_section),
  };
}

function candidateEvidence({ diff = {}, deterministic = {}, baseline = {}, previous = {}, capture = {} }) {
  const addedText = stringArray(diff.added_text);
  const removedText = stringArray(diff.removed_text);
  const dateChanges = stringArray(diff.date_changes);
  const amountChanges = stringArray(diff.amount_changes);
  const changedText = normalizeText([
    ...addedText,
    ...removedText,
    ...dateChanges,
    ...amountChanges,
    diff.changed_text_excerpt,
  ].join(" "));
  const thumbnailRef = thumbnailPath(previous) || thumbnailPath(capture);
  const imageChanged = Boolean(
    (capture?.image_hash && baseline?.image_hash && capture.image_hash !== baseline.image_hash) ||
      (capture?.file_hash && baseline?.file_hash && capture.file_hash !== baseline.file_hash) ||
      deterministic?.reason?.includes?.("screenshot") ||
      deterministic?.classification?.includes?.("visual"),
  );

  return {
    added_text: addedText.slice(0, 16),
    removed_text: removedText.slice(0, 16),
    date_changes: dateChanges.slice(0, 12),
    amount_changes: amountChanges.slice(0, 12),
    changed_text: changedText,
    has_text_evidence: Boolean(addedText.length || removedText.length),
    has_visual_evidence: Boolean(imageChanged),
    visual_reason: cleanNullable([deterministic?.classification, deterministic?.reason].join(" ")),
    thumbnail_ref: thumbnailRef,
  };
}

function thumbnailPath(value) {
  return (
    value?.thumbPath ||
    value?.thumb_path ||
    value?.thumbnailPath ||
    value?.thumbnail_path ||
    value?.pagePath ||
    value?.page_path ||
    value?.pdfPath ||
    value?.pdf_path ||
    null
  );
}

function sourceNoiseClassFromSource(source, changedText = "") {
  const facts = sourceBaselineFacts(source);
  const haystack = normalizeText([
    source?.url,
    safeUrlPath(source?.url),
    source?.title,
    source?.display_title,
    source?.page_type,
    source?.shared_awards?.name,
    facts.display_title,
    facts.source_title,
    changedText,
  ].join(" "));
  for (const item of sourceNoisePatterns) {
    if (item.pattern.test(haystack)) return item;
  }
  if (hasSiblingProgramSignal(source, haystack)) {
    return { label: "sibling_program_or_cross_award", reason: "sibling_program_or_cross_award" };
  }
  return null;
}

function contentNoiseClass(changedText, source) {
  const text = normalizeText(changedText);
  if (!text) return null;
  if (accessErrorPattern.test(text)) return { label: "access_error", reason: "access_error_text" };
  if (popupModalPattern.test(text)) return { label: "popup_modal_noise", reason: "popup_or_modal_text" };
  if (timestampNoisePattern.test(text)) return { label: "nav_chrome_noise", reason: "timestamp_or_countdown_noise" };
  if (hasSiblingProgramSignal(source, text)) {
    return { label: "sibling_program_or_cross_award", reason: "sibling_program_or_cross_award" };
  }
  const hasApplicantSignal = applicantFactSignalPattern.test(text);
  if (profileRosterPattern.test(text) && !hasApplicantSignal) {
    return { label: "profile_roster_rotation", reason: "profile_roster_rotation" };
  }
  if (newsEventRecipientPattern.test(text) && !hasApplicantSignal) {
    return { label: "news_event_recipient_noise", reason: "news_event_recipient_noise" };
  }
  if (lazyLoadPattern.test(text) && !hasApplicantSignal) {
    return { label: "lazy_load_expansion_noise", reason: "lazy_load_expansion_noise" };
  }
  if (navChromePattern.test(text) && !hasApplicantSignal) {
    return { label: "nav_chrome_noise", reason: "nav_chrome_noise" };
  }
  return null;
}

function looksLikePdfMetadataOnly({ diff = {}, deterministic = {}, evidence }) {
  const reason = normalizeText([deterministic?.classification, deterministic?.reason].join(" ")).toLowerCase();
  if (!reason.includes("pdf")) return false;
  return !evidence.has_text_evidence && !stringArray(diff.date_changes).length && !stringArray(diff.amount_changes).length;
}

function stableVisualOnlySource(source, quality) {
  if (!quality?.allowed) return false;
  const pageType = cleanKey(source?.page_type);
  if (["homepage", "application", "deadline", "requirements", "eligibility", "pdf", "faq"].includes(pageType)) {
    return true;
  }
  const facts = sourceBaselineFacts(source);
  const relevance = cleanKey(facts.award_relevance);
  return ["primary", "supporting"].includes(relevance);
}

function noiseLabelForReason(reason) {
  const text = normalizeText(reason).toLowerCase();
  if (text.includes("pdf")) return "pdf_metadata_only";
  if (text.includes("profile") || text.includes("roster")) return "profile_roster_rotation";
  if (text.includes("recipient") || text.includes("news") || text.includes("press")) return "news_event_recipient_noise";
  if (text.includes("relative") || text.includes("boilerplate") || text.includes("nav")) return "nav_chrome_noise";
  if (text.includes("popup") || text.includes("modal")) return "popup_modal_noise";
  return "text_only_candidate";
}

function labelForSourceQualityReason(reason) {
  const text = normalizeText(reason).toLowerCase();
  if (text.includes("access") || text.includes("auth") || text.includes("security")) return "access_error";
  if (text.includes("job") || text.includes("career") || text.includes("listing") || text.includes("search")) {
    return "news_event_recipient_noise";
  }
  if (text.includes("sibling") || text.includes("unrelated")) return "sibling_program_or_cross_award";
  if (text.includes("archived") || text.includes("not_program_page")) return "news_event_recipient_noise";
  return "text_only_candidate";
}

function hasSiblingProgramSignal(source, value) {
  const text = normalizeText(value).toLowerCase();
  if (!text) return false;
  const awardName = normalizeText(source?.shared_awards?.name || "").toLowerCase();
  if (/phrma/.test(`${awardName} ${text}`) && /faculty starter grants?/.test(text) && !/faculty starter grants?/.test(awardName)) {
    return true;
  }

  const changedAwardishTitle = text.match(
    /\b([a-z][a-z0-9&.' -]{6,80}\b(?:scholarship|fellowship|grant|award|program)s?)\b/i,
  )?.[1];
  if (!changedAwardishTitle || !awardName) return false;
  const titleTokens = meaningfulTokens(changedAwardishTitle);
  const awardTokens = meaningfulTokens(awardName);
  if (titleTokens.length < 2 || awardTokens.length < 2) return false;
  const overlap = titleTokens.filter((token) => awardTokens.includes(token)).length;
  return overlap === 0 && !titleTokens.some((token) => token === "scholarship" || token === "fellowship" || token === "grant" || token === "award");
}

function meaningfulTokens(value) {
  const stop = new Set([
    "the",
    "and",
    "for",
    "with",
    "from",
    "program",
    "scholarship",
    "scholarships",
    "fellowship",
    "fellowships",
    "grant",
    "grants",
    "award",
    "awards",
    "application",
  ]);
  return normalizeText(value)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2 && !stop.has(token))
    .slice(0, 20);
}

function safeUrlPath(value) {
  if (!value) return "";
  try {
    const url = new URL(value);
    return decodeURIComponent(`${url.hostname} ${url.pathname} ${url.search}`);
  } catch {
    return String(value || "");
  }
}

function normalizeChangedFacts(values) {
  if (!Array.isArray(values)) return [];
  return values
    .map((value) => {
      if (typeof value === "string") {
        return { fact: cleanNullable(value), before: null, after: null, added_text: null, removed_text: null, visual_evidence: null };
      }
      const object = objectValue(value);
      return {
        fact: cleanNullable(object.fact || object.name || object.summary),
        before: cleanNullable(object.before),
        after: cleanNullable(object.after),
        added_text: cleanNullable(object.added_text || object.addedText),
        removed_text: cleanNullable(object.removed_text || object.removedText),
        visual_evidence: cleanNullable(object.visual_evidence || object.visualEvidence || object.evidence),
      };
    })
    .filter((value) => value.fact || value.before || value.after || value.added_text || value.removed_text || value.visual_evidence)
    .slice(0, 12);
}

function exactBeforeAfterSupportedByEvidence({ result, candidate }) {
  const diff = candidate?.deterministic_diff || candidate?.prompt_payload?.deterministic_diff || {};
  const addedText = [
    ...stringArray(diff.added_text),
    ...stringArray(diff.date_changes).filter((value) => cleanKey(value).startsWith("added")),
    ...stringArray(diff.amount_changes).filter((value) => cleanKey(value).startsWith("added")),
    ...stringArray(result?.structured_diff?.added_text),
    ...stringArray(result?.structured_diff?.date_changes).filter((value) => cleanKey(value).startsWith("added")),
    ...stringArray(result?.structured_diff?.amount_changes).filter((value) => cleanKey(value).startsWith("added")),
  ];
  const removedText = [
    ...stringArray(diff.removed_text),
    ...stringArray(diff.date_changes).filter((value) => cleanKey(value).startsWith("removed")),
    ...stringArray(diff.amount_changes).filter((value) => cleanKey(value).startsWith("removed")),
    ...stringArray(result?.structured_diff?.removed_text),
    ...stringArray(result?.structured_diff?.date_changes).filter((value) => cleanKey(value).startsWith("removed")),
    ...stringArray(result?.structured_diff?.amount_changes).filter((value) => cleanKey(value).startsWith("removed")),
  ];

  if (result?.exact_before && !textContainsEvidence(removedText, result.exact_before)) return false;
  if (result?.exact_after && !textContainsEvidence(addedText, result.exact_after)) return false;
  return true;
}

function changedFactHasEvidence({ fact, result, candidate }) {
  const diff = candidate?.deterministic_diff || candidate?.prompt_payload?.deterministic_diff || {};
  const addedText = [
    ...stringArray(diff.added_text),
    ...stringArray(diff.date_changes).filter((value) => cleanKey(value).startsWith("added")),
    ...stringArray(diff.amount_changes).filter((value) => cleanKey(value).startsWith("added")),
    ...stringArray(result?.structured_diff?.added_text),
    ...stringArray(result?.structured_diff?.date_changes).filter((value) => cleanKey(value).startsWith("added")),
    ...stringArray(result?.structured_diff?.amount_changes).filter((value) => cleanKey(value).startsWith("added")),
  ];
  const removedText = [
    ...stringArray(diff.removed_text),
    ...stringArray(diff.date_changes).filter((value) => cleanKey(value).startsWith("removed")),
    ...stringArray(diff.amount_changes).filter((value) => cleanKey(value).startsWith("removed")),
    ...stringArray(result?.structured_diff?.removed_text),
    ...stringArray(result?.structured_diff?.date_changes).filter((value) => cleanKey(value).startsWith("removed")),
    ...stringArray(result?.structured_diff?.amount_changes).filter((value) => cleanKey(value).startsWith("removed")),
  ];
  if (fact.added_text && textContainsEvidence(addedText, fact.added_text)) return true;
  if (fact.removed_text && textContainsEvidence(removedText, fact.removed_text)) return true;
  if (fact.after && textContainsEvidence(addedText, fact.after)) return true;
  if (fact.before && textContainsEvidence(removedText, fact.before)) return true;

  const hasVisualEvidence = cleanNullable(fact.visual_evidence) || cleanNullable(result?.visual_evidence);
  return Boolean(hasVisualEvidence && candidate?.prompt_payload?.include_images);
}

function textContainsEvidence(haystackValues, needle) {
  const cleanNeedle = normalizeText(needle).toLowerCase();
  if (!cleanNeedle || cleanNeedle.length < 4) return false;
  return haystackValues
    .map((value) => normalizeText(value).toLowerCase())
    .filter(Boolean)
    .some((value) => value.includes(cleanNeedle) || cleanNeedle.includes(value));
}

function normalizeStructuredDiff(value, fallbackDiff = {}, source = null) {
  const object = objectValue(value);
  return {
    added_text: stringArray(object.added_text).length
      ? stringArray(object.added_text).slice(0, 8)
      : stringArray(fallbackDiff.added_text).slice(0, 8),
    removed_text: stringArray(object.removed_text).length
      ? stringArray(object.removed_text).slice(0, 8)
      : stringArray(fallbackDiff.removed_text).slice(0, 8),
    date_changes: stringArray(object.date_changes).length
      ? stringArray(object.date_changes).slice(0, 8)
      : stringArray(fallbackDiff.date_changes).slice(0, 8),
    amount_changes: stringArray(object.amount_changes).length
      ? stringArray(object.amount_changes).slice(0, 8)
      : stringArray(fallbackDiff.amount_changes).slice(0, 8),
    noise_flags: unique(stringArray(object.noise_flags).map(cleanKey).filter(Boolean)).slice(0, 20),
    likely_section: cleanNullable(object.likely_section || object.section || fallbackDiff.likely_section),
    page_type: cleanNullable(object.page_type || fallbackDiff.page_type || source?.page_type),
  };
}

function inferChangeType(parsed, structuredDiff = {}) {
  const text = normalizeText([
    parsed?.change_type,
    parsed?.section,
    parsed?.reader_summary,
    parsed?.advisor_impact,
    ...(structuredDiff.date_changes || []),
    ...(structuredDiff.amount_changes || []),
    ...(structuredDiff.added_text || []),
    ...(structuredDiff.removed_text || []),
  ].join(" ")).toLowerCase();
  if (/\b(deadline|date|opens?|closes?|due)\b/.test(text)) return "deadline";
  if (/\b(amount|funding|stipend|tuition|grant|award amount|prize)\b/.test(text)) return "funding";
  if (/\b(eligible|eligibility|citizenship|gpa|condition)\b/.test(text)) return "eligibility";
  if (/\b(apply|application|submit|submission|recommendation|transcript|essay|nomination)\b/.test(text)) return "application";
  if (/\b(pdf|document|guide|guideline|instruction|form)\b/.test(text)) return "document";
  return "other";
}

function looksLikeRejectedNoise(value) {
  return /\b(profile rotation|recipient profile|past recipient|featured fellow|news listing|search results?|job posting|career page|nav(?:igation)?|footer|sidebar|cookie|popup|captcha|security question|collapsed?|expanded?|layout|font|reflow|file size only|hash only)\b/i.test(
    value,
  );
}

function hasAwardChangeSignal(value) {
  return /\b(deadline|due|open|close|application|apply|eligib|requirement|condition|recommendation|transcript|essay|nomination|funding|stipend|tuition|award amount|amount|document|guideline|form|materials?|citizenship|gpa|interview|selection)\b/i.test(
    value,
  );
}

function parseJsonObject(text) {
  const clean = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  if (!clean) return null;
  try {
    const parsed = JSON.parse(clean);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    const match = clean.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      const parsed = JSON.parse(match[0]);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
}

function booleanValue(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const clean = value.trim().toLowerCase();
    if (["true", "yes", "1"].includes(clean)) return true;
    if (["false", "no", "0"].includes(clean)) return false;
  }
  return false;
}

function normalizeConfidence(value) {
  const clean = cleanKey(value);
  return ["low", "medium", "high"].includes(clean) ? clean : "low";
}

function normalizeSourceRelevance(value) {
  const clean = cleanKey(value);
  return ["primary", "supporting", "unclear", "unrelated"].includes(clean) ? clean : "unclear";
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stringArray(value) {
  if (!value) return [];
  const raw = Array.isArray(value) ? value : [value];
  return raw.map((item) => cleanNullable(item)).filter(Boolean);
}

function cleanNullable(value) {
  const text = typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
  const clean = normalizeText(text);
  return clean || null;
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function cleanKey(value) {
  return normalizeText(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function sentenceKey(value) {
  return normalizeText(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortJson(value[key])]),
  );
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

export function fileToInlineGeminiPart(path) {
  if (!path || !existsSync(path)) return null;
  const mimeType = /\.png$/i.test(path) ? "image/png" : "image/jpeg";
  return {
    inlineData: {
      mimeType,
      data: readFileSync(path).toString("base64"),
    },
  };
}
