import crypto from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import {
  awardMonitoringPolicyIdentity,
  hasRelativeAgeOnlyPolicyChange,
  isAlertBlockingMonitoringPolicyFlag,
  monitoringPolicyFlagIdForAlias,
  monitoringPolicyPromptLinesForScope,
  visualReviewBatchPolicyIdentity,
} from "./award-monitoring-policy.mjs";
import { changeEventSuppressionDecision } from "./change-event-suppression.mjs";
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
const conditionalApplicantSourceShapePattern =
  /\b(?:profile|profiles|recipients?|awardees?|testimonial|news|press release|events? calendar)\b|\/(?:profile|profiles|recipients?|awardees?|news|press|events?|calendar)(?:[/?#]|$)/i;
const alwaysBlockedApplicantSourceShapePattern =
  /\b(?:jobs?|careers?|employment|search results?|payment|bursar|1098t|security question|access denied|login|sign in)\b|\/(?:jobs?|careers?|employment|search|results|listing|list|directory|database|payment|payments|bursar|1098t|login|signin|sign-in)(?:[/?#]|$)/i;
const strictApplicantFacingEvidencePattern =
  /\b(?:application deadline|deadline|due date|opening date|applications? (?:open|close|are open|are due)|closing date|award amount|funding|stipend|tuition|eligib(?:ility|le)|application requirements?|award conditions?|letters? of recommendation|transcript|essay|nomination|application materials?|required documents?|how to apply|apply by|submit by|application portal|application instructions?|citizenship|gpa|interview)\b/i;

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
  const applicantSourceEscape = visualReviewConditionalSourceApplicantEscape({
    source,
    changedText: evidence.changed_text,
    quality,
  });
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

  if (!quality.allowed && !applicantSourceEscape.allowed) {
    return reject(sourceNoiseClassFromSource(source, evidence.changed_text)?.label || labelForSourceQualityReason(quality.reason), `source_quality_${quality.reason}`, {
      source_rejected: true,
      source_quality: quality,
    });
  }

  const sourceNoise = sourceNoiseClassFromSource(source, evidence.changed_text);
  if (sourceNoise && !applicantSourceEscape.allowed) {
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

export function visualReviewConditionalSourceApplicantEscape({
  source,
  candidate = null,
  changedText = "",
  quality = null,
} = {}) {
  const effectiveQuality = quality || sourceQualityDecision(source, { purpose: "monitoring" });
  const deterministicDiff = candidate?.deterministic_diff || candidate?.prompt_payload?.deterministic_diff || {};
  const evidenceText = normalizeText([
    changedText,
    ...stringArray(deterministicDiff.added_text),
    ...stringArray(deterministicDiff.removed_text),
    ...stringArray(deterministicDiff.date_changes),
    ...stringArray(deterministicDiff.amount_changes),
  ].join(" "));
  const sourceText = normalizeText([
    source?.url,
    source?.title,
    source?.display_title,
    source?.page_type,
  ].join(" "));
  const allowed =
    effectiveQuality?.allowed === false &&
    effectiveQuality.reason === "url_not_monitorable" &&
    conditionalApplicantSourceShapePattern.test(sourceText) &&
    !alwaysBlockedApplicantSourceShapePattern.test(sourceText) &&
    strictApplicantFacingEvidencePattern.test(evidenceText);
  return {
    allowed,
    reason: allowed ? "conditional_source_shape_with_applicant_evidence" : null,
  };
}

export function visualReviewCandidateSignature({
  source,
  baseline,
  capture,
  diff,
  deterministic,
  behaviorVersion,
  policyIdentity = visualReviewBatchPolicyIdentity,
}) {
  const evidenceSignature = visualReviewEvidenceSignature({
    source,
    baseline,
    capture,
    diff,
    deterministic,
    behaviorVersion,
  });
  return crypto.createHash("sha256").update(stableJsonStringify({
    evidence_signature: evidenceSignature,
    occurrence_identity: visualReviewOccurrenceIdentity(capture),
    monitoring_policy: normalizePolicyIdentity(policyIdentity),
  })).digest("hex");
}

export function visualReviewEvidenceSignature({
  source,
  baseline,
  capture,
  diff,
  deterministic,
  behaviorVersion,
}) {
  const payload = {
    source_context: visualReviewSourcePromptContext(source),
    previous_text_hash: baseline?.text_hash || null,
    new_text_hash: capture?.text_hash || null,
    previous_image_hash: baseline?.image_hash || null,
    new_image_hash: capture?.image_hash || null,
    previous_file_hash: baseline?.file_hash || null,
    new_file_hash: capture?.file_hash || null,
    candidate_scope: diff?.candidate_scope || null,
    section_key: diff?.section_key || null,
    previous_section_hash: diff?.previous_section_hash || null,
    new_section_hash: diff?.new_section_hash || null,
    deterministic_diff: compactDiffSignature(diff),
    deterministic_classification: deterministic?.classification || deterministic?.reason || null,
    behavior_version: behaviorVersion || null,
  };
  return crypto.createHash("sha256").update(stableJsonStringify(payload)).digest("hex");
}

export function visualReviewEvidenceSignatureFromStoredCandidate(candidate) {
  const promptSource = objectValue(candidate?.prompt_payload?.source);
  return visualReviewEvidenceSignature({
    source: {
      ...promptSource,
      id: candidate?.shared_award_source_id || promptSource.id || null,
      url: promptSource.url || candidate?.source_url || null,
      title: promptSource.title || candidate?.source_title || null,
      page_type: promptSource.page_type || candidate?.source_page_type || null,
    },
    baseline: {
      text_hash: candidate?.previous_text_hash,
      image_hash: candidate?.previous_image_hash,
      file_hash: candidate?.previous_file_hash,
    },
    capture: {
      text_hash: candidate?.new_text_hash,
      image_hash: candidate?.new_image_hash,
      file_hash: candidate?.new_file_hash,
    },
    diff: candidate?.deterministic_diff || candidate?.prompt_payload?.deterministic_diff || {},
    deterministic: {
      classification: candidate?.deterministic_classification ||
        candidate?.prompt_payload?.deterministic_classification?.classification ||
        candidate?.prompt_payload?.deterministic_classification?.reason ||
        null,
    },
    behaviorVersion:
      candidate?.prompt_payload?.behavior_version ||
      candidate?.worker_metadata?.capture_behavior_version ||
      null,
  });
}

export function visualReviewCandidateSignatureFromStoredCandidate(
  candidate,
  policyIdentity = visualReviewBatchPolicyIdentity,
) {
  return crypto.createHash("sha256").update(stableJsonStringify({
    evidence_signature: visualReviewEvidenceSignatureFromStoredCandidate(candidate),
    occurrence_identity: visualReviewOccurrenceIdentity(
      objectValue(candidate?.new_snapshot_ref).captured_at
        ? candidate.new_snapshot_ref
        : candidate?.prompt_payload?.new_snapshot_ref,
    ),
    monitoring_policy: normalizePolicyIdentity(policyIdentity),
  })).digest("hex");
}

export function rebuildVisualReviewCandidateForCurrentPolicy(
  candidate,
  { source = null } = {},
) {
  const promptPayload = refreshVisualReviewPromptPayloadPolicy({
    ...objectValue(candidate?.prompt_payload),
    ...(source ? { source: visualReviewSourcePromptContext(source) } : {}),
  });
  return {
    candidate_signature: visualReviewCandidateSignatureFromStoredCandidate(
      { ...candidate, prompt_payload: promptPayload },
      visualReviewBatchPolicyIdentity,
    ),
    prompt_payload: promptPayload,
    prompt_context: buildVisualReviewPromptText(promptPayload),
    monitoring_policy: currentVisualReviewPolicyIdentity(),
    source_context: objectValue(promptPayload.source),
  };
}

export function visualReviewSourcePromptContext(source) {
  const directBaselineFacts = objectValue(source?.baseline_facts);
  return {
    id: source?.id || null,
    shared_award_id: source?.shared_award_id || null,
    award_name: source?.award_name || source?.shared_awards?.name || null,
    title: source?.title || null,
    url: source?.url || null,
    page_type: source?.page_type || null,
    baseline_facts: Object.keys(directBaselineFacts).length
      ? directBaselineFacts
      : sourceBaselineFacts(source),
  };
}

export function currentVisualReviewPolicyIdentity() {
  return normalizePolicyIdentity(visualReviewBatchPolicyIdentity);
}

export function currentMonitoringPolicyAuditIdentity() {
  return normalizePolicyIdentity(awardMonitoringPolicyIdentity);
}

export function refreshVisualReviewPromptPayloadPolicy(payload = {}) {
  return {
    ...objectValue(payload),
    monitoring_policy: currentVisualReviewPolicyIdentity(),
    monitoring_policy_bundle: currentMonitoringPolicyAuditIdentity(),
  };
}

export function visualReviewCandidatePolicyFreshness(candidate, { requireIdentity = true } = {}) {
  const activePolicy = currentVisualReviewPolicyIdentity();
  const submittedPolicy = normalizePolicyIdentity(
    candidate?.worker_metadata?.monitoring_policy || candidate?.prompt_payload?.monitoring_policy,
  );
  if (!submittedPolicy) {
    return {
      allowed: !requireIdentity,
      reason: requireIdentity ? "missing_submission_policy_identity" : "policy_identity_not_recorded",
      active_policy: activePolicy,
      submitted_policy: null,
    };
  }
  if (!samePolicyIdentity(submittedPolicy, activePolicy)) {
    return {
      allowed: false,
      reason: "policy_changed_since_batch_submission",
      active_policy: activePolicy,
      submitted_policy: submittedPolicy,
    };
  }
  return {
    allowed: true,
    reason: "current_policy",
    active_policy: activePolicy,
    submitted_policy: submittedPolicy,
  };
}

export function canonicalVisualReviewSourceUrl(value) {
  const raw = normalizeText(value);
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    parsed.hash = "";
    parsed.hostname = parsed.hostname.toLowerCase();
    if (
      (parsed.protocol === "https:" && parsed.port === "443") ||
      (parsed.protocol === "http:" && parsed.port === "80")
    ) {
      parsed.port = "";
    }
    const entries = [...parsed.searchParams.entries()]
      .filter(([key]) => !/^utm_|^(?:fbclid|gclid|mc_cid|mc_eid)$/i.test(key))
      .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
        leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue));
    parsed.search = "";
    for (const [key, value] of entries) parsed.searchParams.append(key, value);
    parsed.pathname = parsed.pathname.replace(/\/{2,}/g, "/").replace(/\/$/, "") || "/";
    return parsed.toString();
  } catch {
    return raw.replace(/#.*$/, "").replace(/\/$/, "").toLowerCase();
  }
}

export function visualReviewSourceIdentityFreshness(candidate, source) {
  const capturedSourceUrl = canonicalVisualReviewSourceUrl(
    candidate?.prompt_payload?.source?.url || candidate?.source_url,
  );
  const currentSourceUrl = canonicalVisualReviewSourceUrl(source?.url);
  if (capturedSourceUrl && currentSourceUrl && capturedSourceUrl !== currentSourceUrl) {
    return {
      allowed: false,
      reason: "source_url_changed_since_capture",
      captured_source_url: capturedSourceUrl,
      current_source_url: currentSourceUrl,
    };
  }
  return {
    allowed: true,
    reason: capturedSourceUrl && currentSourceUrl
      ? "source_url_identity_current"
      : "source_url_identity_unavailable",
    captured_source_url: capturedSourceUrl,
    current_source_url: currentSourceUrl,
  };
}

export function visualReviewFailureRetryDecision(candidate, { maxRetries = 3 } = {}) {
  const retryCount = Math.max(
    0,
    Number.parseInt(candidate?.worker_metadata?.failure_retry_count, 10) || 0,
  );
  if (candidate?.status !== "failed") {
    return { retry: false, reason: "candidate_not_failed", retry_count: retryCount };
  }
  if (normalizeText(candidate?.rejection_reason) === "missing_batch_response") {
    return { retry: false, reason: "awaiting_missing_batch_response_recovery", retry_count: retryCount };
  }
  if (
    normalizeText(candidate?.rejection_reason) ===
    "manual_recovery_required_possible_external_batch_created"
  ) {
    return { retry: false, reason: "possible_external_batch_requires_manual_recovery", retry_count: retryCount };
  }
  if (retryCount >= Math.max(0, Number(maxRetries) || 0)) {
    return { retry: false, reason: "failure_retry_limit_reached", retry_count: retryCount };
  }
  return {
    retry: true,
    reason: "ordinary_failure_retryable",
    retry_count: retryCount,
    next_retry_count: retryCount + 1,
  };
}

export function visualReviewStaleClaimRecoveryDecision(candidate) {
  if (candidate?.status !== "processing" || candidate?.gemini_batch_name) {
    return { action: "none", reason: "not_an_unpersisted_submission_claim" };
  }
  const metadata = objectValue(candidate?.worker_metadata);
  if (metadata.batch_create_started_at) {
    return {
      action: "fail_closed",
      reason: "possible_external_batch_created",
      batch_display_name: cleanNullable(metadata.batch_display_name),
      batch_create_started_at: cleanNullable(metadata.batch_create_started_at),
    };
  }
  return { action: "requeue", reason: "stale_claim_before_batch_create" };
}

export function visualReviewEnclosingCaptureIdentity(candidate) {
  const ref = objectValue(
    Object.keys(objectValue(candidate?.new_snapshot_ref)).length
      ? candidate.new_snapshot_ref
      : candidate?.prompt_payload?.new_snapshot_ref,
  );
  const localPaths = objectValue(ref.local_paths);
  const captureDir = objectValue(ref.capture_dir);
  const meta = objectValue(localPaths.meta);
  const stablePath = normalizeText(
    captureDir.archive_relative ||
      captureDir.path ||
      meta.archive_relative ||
      meta.path,
  );
  if (stablePath) return `path:${stablePath.toLowerCase()}`;
  return `capture:${[
    normalizeText(ref.captured_at),
    normalizeText(ref.final_url),
    normalizeText(candidate?.new_file_hash || ref.file_hash),
    normalizeText(candidate?.new_image_hash || ref.image_hash),
  ].join("|").toLowerCase()}`;
}

export function visualReviewBatchCreateFailureDisposition({
  kind,
  httpStatus = null,
  networkFailure = false,
} = {}) {
  const batchCreate = /^batch_create(?:_|$)/.test(normalizeText(kind));
  const status = Number(httpStatus);
  const ambiguousStatus = [408, 409, 500, 502, 503, 504].includes(status);
  if (batchCreate && (networkFailure || ambiguousStatus)) {
    return {
      action: "fail_closed",
      reason: "possible_external_batch_created",
    };
  }
  return {
    action: "retry_or_release",
    reason: "provider_creation_not_ambiguous",
  };
}

export function visualReviewBatchPollFailureDisposition({
  kind,
  httpStatus = null,
} = {}) {
  const batchPoll = /^batch_poll(?:_|$)/.test(normalizeText(kind));
  const status = Number(httpStatus);
  if (batchPoll && [404, 410].includes(status)) {
    return {
      action: "fail_for_bounded_retry",
      reason: "provider_batch_permanently_missing",
      http_status: status,
    };
  }
  return {
    action: "preserve_batch_reference",
    reason: "provider_batch_state_uncertain",
    http_status: Number.isFinite(status) && status > 0 ? status : null,
  };
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
    monitoring_policy: currentVisualReviewPolicyIdentity(),
    monitoring_policy_bundle: currentMonitoringPolicyAuditIdentity(),
    source: visualReviewSourcePromptContext({
      ...objectValue(source),
      baseline_facts: baselineFacts,
    }),
    previous_snapshot_ref: previousRef,
    new_snapshot_ref: newRef,
    hashes: {
      previous_text_hash: baseline?.text_hash || null,
      new_text_hash: capture?.text_hash || null,
      previous_image_hash: baseline?.image_hash || null,
      new_image_hash: capture?.image_hash || null,
      previous_file_hash: baseline?.file_hash || null,
      new_file_hash: capture?.file_hash || null,
      previous_section_hash: diff?.previous_section_hash || null,
      new_section_hash: diff?.new_section_hash || null,
    },
    section_context: diff?.candidate_scope === "expandable_section"
      ? {
          candidate_scope: "expandable_section",
          section_key: cleanNullable(diff?.section_key),
          section_label: cleanNullable(diff?.section_label),
          section_path: cleanNullable(diff?.section_path),
          previous_section_hash: cleanNullable(diff?.previous_section_hash),
          new_section_hash: cleanNullable(diff?.new_section_hash),
          section_addition_confirmed: diff?.section_addition_confirmed === true,
          section_removal_confirmed: diff?.section_removal_confirmed === true,
          section_presence_evidence: diff?.section_presence_evidence || null,
        }
      : null,
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
  const activePolicyIdentity = currentVisualReviewPolicyIdentity();
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
    "For an expandable-section addition or removal, reject unless deterministic evidence explicitly marks section_addition_confirmed or section_removal_confirmed true. A missing extraction is not proof that a section was removed.",
    "Every approved changed_facts item must include exact added_text or removed_text from the deterministic diff, or a specific visual_evidence phrase when the screenshot changed but text extraction did not capture the changed section.",
    "exact_before and exact_after must be exact strings from deterministic diff evidence, or null only when the change is one-sided and the other side is genuinely absent.",
    "source_relevance must be primary or supporting only when this exact page is about the named award or a directly supporting official source for it.",
    "",
    "Required JSON keys:",
    "{is_true_change, is_alert_worthy, source_relevance, source_relevance_reason, changed_facts, exact_before, exact_after, evidence_location, before, after, section, change_type, confidence, noise_flags, rejection_reason, reader_summary, advisor_impact, structured_diff}",
    "",
    "Active monitoring policy identity (this supersedes any policy metadata captured with the queued candidate):",
    stableJsonStringify(activePolicyIdentity),
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
    ...(payload.section_context
      ? [
          "",
          "Changed expandable section context:",
          stableJsonStringify(payload.section_context),
        ]
      : []),
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

export function expandableSectionCandidateRejectReason(candidate) {
  const deterministicDiff =
    candidate?.deterministic_diff || candidate?.prompt_payload?.deterministic_diff || {};
  if (deterministicDiff.candidate_scope !== "expandable_section") return null;

  const oneSidedRemoval = Boolean(
    deterministicDiff.previous_section_hash && !deterministicDiff.new_section_hash,
  );
  const oneSidedAddition = Boolean(
    !deterministicDiff.previous_section_hash && deterministicDiff.new_section_hash,
  );
  if (oneSidedRemoval && deterministicDiff.section_removal_confirmed !== true) {
    return "unconfirmed_expandable_section_removal";
  }
  if (oneSidedAddition && deterministicDiff.section_addition_confirmed !== true) {
    return "unconfirmed_expandable_section_addition";
  }

  const presenceEvidence = deterministicDiff.section_presence_evidence || {};
  if (
    oneSidedRemoval &&
    (presenceEvidence.current_label_present || presenceEvidence.current_body_present)
  ) {
    return "expandable_section_still_present";
  }
  if (
    oneSidedAddition &&
    (presenceEvidence.previous_label_present || presenceEvidence.previous_body_present)
  ) {
    return "expandable_section_previously_present";
  }
  return null;
}

export function validateVisualBatchReview({ candidate, source, result }) {
  const reject = (reason) => ({ allowed: false, reason });
  const quality = sourceQualityDecision(source, { purpose: "monitoring" });
  const applicantSourceEscape = visualReviewConditionalSourceApplicantEscape({
    source,
    candidate,
    quality,
  });
  if (!quality.allowed && !applicantSourceEscape.allowed) {
    return reject(`source_quality_${quality.reason}`);
  }

  const policyFlag = alertBlockingPolicyFlag(result);
  if (!result?.is_true_change || !result?.is_alert_worthy) {
    return reject(
      policyFlag
        ? `policy_flag_${policyFlag}`
        : result?.rejection_reason || "not_alert_worthy",
    );
  }
  if (!["medium", "high"].includes(result.confidence)) return reject("low_confidence");
  if (!["primary", "supporting"].includes(result.source_relevance)) {
    return reject(`source_relevance_${result.source_relevance || "missing"}`);
  }

  const sectionRejectReason = expandableSectionCandidateRejectReason(candidate);
  if (sectionRejectReason) return reject(sectionRejectReason);

  if (policyFlag) return reject(`policy_flag_${policyFlag}`);

  if (resultLooksLikeRelativeAgeOnlyPolicyChange({ candidate, result })) {
    return reject("policy_flag_relative_age_timestamp_churn");
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
  const deterministicDiff = candidate?.deterministic_diff || candidate?.prompt_payload?.deterministic_diff || {};
  const deterministicEvidence = normalizeText([
    ...stringArray(deterministicDiff.added_text),
    ...stringArray(deterministicDiff.removed_text),
    ...stringArray(deterministicDiff.date_changes),
    ...stringArray(deterministicDiff.amount_changes),
  ].join(" "));
  if (deterministicEvidence) {
    if (!strictApplicantFacingEvidencePattern.test(deterministicEvidence)) {
      return reject("missing_deterministic_applicant_fact_signal");
    }
  } else {
    const reviewedVisualOnly = Boolean(
      candidate?.prompt_payload?.include_images &&
      facts.some((fact) => cleanNullable(fact.visual_evidence)),
    );
    if (!reviewedVisualOnly) return reject("missing_reviewed_visual_evidence");
  }

  return { allowed: true, reason: "approved" };
}

export function latestVisualReviewPolicyDecision({
  candidate,
  source,
  result,
  changeDetails = null,
  requirePolicyIdentity = true,
} = {}) {
  const policyIdentity = currentVisualReviewPolicyIdentity();
  const freshness = visualReviewCandidatePolicyFreshness(candidate, {
    requireIdentity: requirePolicyIdentity,
  });
  if (!freshness.allowed) {
    return {
      allowed: false,
      reason: freshness.reason,
      policy_identity: policyIdentity,
      submitted_policy_identity: freshness.submitted_policy,
      guard: "policy_freshness",
    };
  }
  const validation = validateVisualBatchReview({ candidate, source, result });
  if (!validation.allowed) {
    return {
      allowed: false,
      reason: validation.reason,
      policy_identity: policyIdentity,
      guard: "visual_review_validation",
    };
  }

  const details = changeDetails || changeDetailsFromVisualBatchResult({
    candidate,
    source,
    result,
    model: candidate?.model,
  });
  const suppression = changeEventSuppressionDecision(
    {
      shared_award_id: candidate?.shared_award_id || source?.shared_award_id || null,
      shared_award_source_id: candidate?.shared_award_source_id || source?.id || null,
      source_url: source?.url || candidate?.source_url || null,
      source_title: source?.title || candidate?.source_title || null,
      source_page_type: source?.page_type || candidate?.source_page_type || null,
      summary: details.reader_summary || null,
      change_details: details,
    },
    source,
  );
  if (suppression.suppressed) {
    return {
      allowed: false,
      reason: suppression.reason || "change_event_suppressed",
      policy_identity: policyIdentity,
      guard: "change_event_suppression",
    };
  }

  return {
    allowed: true,
    reason: "approved",
    policy_identity: policyIdentity,
    guard: "latest_policy",
  };
}

export function changeDetailsFromVisualBatchResult({ candidate, source, result, model }) {
  const deterministicDiff = candidate?.deterministic_diff || candidate?.prompt_payload?.deterministic_diff || {};
  const structuredDiff = normalizeStructuredDiff(
    { noise_flags: result?.noise_flags },
    deterministicDiff,
    source,
  );
  const publicClaims = evidenceDerivedPublicClaims({ candidate, result, structuredDiff });
  const sectionContext = candidate?.prompt_payload?.section_context || null;
  return {
    reader_summary: publicClaims.reader_summary,
    before: publicClaims.before,
    after: publicClaims.after,
    section: cleanNullable(structuredDiff.likely_section),
    change_type: publicClaims.change_type,
    advisor_impact: publicClaims.advisor_impact,
    is_alert_worthy: Boolean(result.is_alert_worthy),
    confidence: normalizeConfidence(result.confidence) || "low",
    structured_diff: structuredDiff,
    section_context: sectionContext,
    changed_award_facts: publicClaims.changed_facts,
    changed_facts: publicClaims.changed_facts,
    source_relevance: result.source_relevance || null,
    source_relevance_reason: result.source_relevance
      ? `The reviewed source was classified as ${normalizeSourceRelevance(result.source_relevance)}.`
      : null,
    exact_before: publicClaims.before,
    exact_after: publicClaims.after,
    evidence_location: cleanNullable(structuredDiff.likely_section),
    source: {
      award_name: source?.shared_awards?.name || candidate?.prompt_payload?.source?.award_name || null,
      source_title: source?.title || candidate?.source_title || null,
      source_url: source?.url || candidate?.source_url || null,
      page_type: source?.page_type || candidate?.source_page_type || null,
    },
    quality_flags: unique(["visual_snapshot_batch_review", ...stringArray(result.noise_flags)]),
    candidate_signature: candidate?.candidate_signature || null,
    monitoring_policy: currentVisualReviewPolicyIdentity(),
    monitoring_policy_bundle: currentMonitoringPolicyAuditIdentity(),
    queued_monitoring_policy: normalizePolicyIdentity(
      candidate?.prompt_payload?.monitoring_policy,
    ),
    submission_monitoring_policy: normalizePolicyIdentity(candidate?.worker_metadata?.monitoring_policy),
    generated_at: new Date().toISOString(),
    generation_provider: "gemini_batch",
    generation_status: "generated",
    generation_model: model || candidate?.model || null,
    public_claims_provenance: {
      source: "deterministic_diff",
      model_narrative_published: false,
    },
  };
}

export function visualHashFromCandidate(candidate, side) {
  const prefix = side === "previous" ? "previous" : "new";
  const diff = candidate?.deterministic_diff || candidate?.prompt_payload?.deterministic_diff || {};
  if (diff.candidate_scope === "expandable_section") {
    const sectionKey = normalizeText(diff.section_key || diff.section_label || "unknown_section");
    const sectionHash = diff[`${prefix}_section_hash`] ||
      candidate?.prompt_payload?.hashes?.[`${prefix}_section_hash`] ||
      `__${prefix}_section_absent__`;
    const identity = crypto.createHash("sha256").update(stableJsonStringify({
      scope: "expandable_section",
      section_key: sectionKey,
      side: prefix,
      section_hash: sectionHash,
      occurrence_identity: visualReviewOccurrenceIdentity(
        objectValue(candidate?.new_snapshot_ref).captured_at
          ? candidate.new_snapshot_ref
          : candidate?.prompt_payload?.new_snapshot_ref,
      ),
    })).digest("hex");
    return `visual-section:${identity}`;
  }
  const hash =
    candidate?.[`${prefix}_file_hash`] ||
    candidate?.[`${prefix}_image_hash`] ||
    candidate?.[`${prefix}_text_hash`] ||
    candidate?.prompt_payload?.hashes?.[`${prefix}_file_hash`] ||
    candidate?.prompt_payload?.hashes?.[`${prefix}_image_hash`] ||
    candidate?.prompt_payload?.hashes?.[`${prefix}_text_hash`] ||
    "";
  if (!hash) return "";
  const occurrenceIdentity = visualReviewOccurrenceIdentity(
    objectValue(candidate?.new_snapshot_ref).captured_at
      ? candidate.new_snapshot_ref
      : candidate?.prompt_payload?.new_snapshot_ref,
  );
  if (!occurrenceIdentity) return `visual:${hash}`;
  return `visual:${crypto.createHash("sha256").update(stableJsonStringify({
    hash,
    side: prefix,
    occurrence_identity: occurrenceIdentity,
  })).digest("hex")}`;
}

function visualReviewOccurrenceIdentity(capture) {
  const value = objectValue(capture);
  const localPaths = objectValue(value.local_paths);
  const captureDir = objectValue(value.capture_dir);
  const identity = {
    captured_at: value.captured_at || null,
    capture_dir: value.dir || captureDir.archive_relative || captureDir.path || null,
    meta_path: objectValue(localPaths.meta).archive_relative || objectValue(localPaths.meta).path || null,
  };
  if (!Object.values(identity).some(Boolean)) return null;
  return crypto.createHash("sha256").update(stableJsonStringify(identity)).digest("hex");
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
    candidate_scope: cleanNullable(diff.candidate_scope),
    section_key: cleanNullable(diff.section_key),
    previous_section_hash: cleanNullable(diff.previous_section_hash),
    new_section_hash: cleanNullable(diff.new_section_hash),
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

function evidenceDerivedPublicClaims({ candidate, result, structuredDiff }) {
  const addedEvidence = directionalEvidenceValues(structuredDiff, "added");
  const removedEvidence = directionalEvidenceValues(structuredDiff, "removed");
  const rawFacts = normalizeChangedFacts(result?.changed_facts || result?.changed_award_facts);
  const changedFacts = rawFacts
    .map((fact) => {
      const addedText = supportedEvidenceValue(fact.added_text, addedEvidence);
      const removedText = supportedEvidenceValue(fact.removed_text, removedEvidence);
      const after = supportedEvidenceValue(fact.after, addedEvidence) || addedText;
      const before = supportedEvidenceValue(fact.before, removedEvidence) || removedText;
      const hasReviewedVisualEvidence = Boolean(
        cleanNullable(fact.visual_evidence) && candidate?.prompt_payload?.include_images,
      );
      if (!before && !after && !hasReviewedVisualEvidence) return null;
      const changeType = evidenceChangeType({
        addedText: [after, addedText],
        removedText: [before, removedText],
        structuredDiff,
        visualOnly: hasReviewedVisualEvidence && !before && !after,
      });
      return {
        fact: evidenceFactLabel(changeType),
        before: before || null,
        after: after || null,
        added_text: addedText || null,
        removed_text: removedText || null,
        visual_evidence: hasReviewedVisualEvidence
          ? "The queued before-and-after screenshots were reviewed."
          : null,
      };
    })
    .filter(Boolean);

  if (!changedFacts.length && (addedEvidence.length || removedEvidence.length)) {
    const before = supportedEvidenceValue(result?.exact_before || result?.before, removedEvidence) || removedEvidence[0] || null;
    const after = supportedEvidenceValue(result?.exact_after || result?.after, addedEvidence) || addedEvidence[0] || null;
    const changeType = evidenceChangeType({
      addedText: [after],
      removedText: [before],
      structuredDiff,
    });
    changedFacts.push({
      fact: evidenceFactLabel(changeType),
      before,
      after,
      added_text: after,
      removed_text: before,
      visual_evidence: null,
    });
  }

  const primary = changedFacts[0] || null;
  const before =
    supportedEvidenceValue(result?.exact_before || result?.before, removedEvidence) ||
    primary?.before ||
    primary?.removed_text ||
    null;
  const after =
    supportedEvidenceValue(result?.exact_after || result?.after, addedEvidence) ||
    primary?.after ||
    primary?.added_text ||
    null;
  const changeType = evidenceChangeType({
    addedText: changedFacts.flatMap((fact) => [fact.after, fact.added_text]),
    removedText: changedFacts.flatMap((fact) => [fact.before, fact.removed_text]),
    structuredDiff,
    visualOnly: Boolean(primary?.visual_evidence && !before && !after),
  });
  const readerSummary = changedFacts.length
    ? changedFacts.slice(0, 3).map(evidenceFactSummary).join(" ")
    : "An applicant-facing visual change was confirmed in the queued before-and-after screenshots.";

  return {
    reader_summary: readerSummary,
    advisor_impact: evidenceAdvisorImpact(changeType),
    before,
    after,
    change_type: changeType,
    changed_facts: changedFacts.slice(0, 12),
  };
}

function directionalEvidenceValues(structuredDiff, direction) {
  const direct = direction === "added"
    ? stringArray(structuredDiff?.added_text)
    : stringArray(structuredDiff?.removed_text);
  const prefix = direction === "added" ? /^(?:added|new)\s*[:\-]?\s*/i : /^(?:removed|old)\s*[:\-]?\s*/i;
  const directional = [
    ...stringArray(structuredDiff?.date_changes),
    ...stringArray(structuredDiff?.amount_changes),
  ]
    .filter((value) => prefix.test(value))
    .map((value) => normalizeText(value).replace(prefix, ""))
    .filter(Boolean);
  return unique([...direct, ...directional].map(normalizeText).filter(Boolean));
}

function supportedEvidenceValue(value, evidenceValues) {
  const clean = cleanNullable(value);
  if (!clean) return null;
  return textContainsEvidence(evidenceValues, clean) ? clean : null;
}

function evidenceChangeType({ addedText = [], removedText = [], structuredDiff = {}, visualOnly = false }) {
  if (visualOnly) return "visual";
  const text = normalizeText([
    ...addedText,
    ...removedText,
    ...stringArray(structuredDiff.date_changes),
    ...stringArray(structuredDiff.amount_changes),
  ].join(" ")).toLowerCase();
  if (/\b(deadline|due|opening date|closing date|applications? (?:open|close))\b/.test(text)) return "deadline";
  if (
    stringArray(structuredDiff.amount_changes).length ||
    /(?:[$€£]\s?\d|\b(?:amount|funding|stipend|tuition|award value|prize)\b)/.test(text)
  ) return "funding";
  if (/\b(eligible|eligibility|citizenship|gpa|academic standing|award condition)\b/.test(text)) return "eligibility";
  if (/\b(requirement|recommendation|transcript|essay|nomination|materials?|documents?|guidelines?)\b/.test(text)) return "requirements";
  if (/\b(apply|application|submit|submission|portal|instructions?)\b/.test(text)) return "application";
  return "other";
}

function evidenceFactLabel(changeType) {
  return {
    deadline: "Application deadline or cycle date",
    funding: "Award amount or funding",
    eligibility: "Applicant eligibility",
    requirements: "Application requirements or materials",
    application: "Application instructions",
    visual: "Applicant-facing visual content",
    other: "Applicant-facing award information",
  }[changeType] || "Applicant-facing award information";
}

function evidenceFactSummary(fact) {
  const label = fact.fact || "Applicant-facing award information";
  const before = publicEvidenceExcerpt(fact.before || fact.removed_text);
  const after = publicEvidenceExcerpt(fact.after || fact.added_text);
  if (before && after) return `${label} changed from “${before}” to “${after}”.`;
  if (after) return `${label} now includes “${after}”.`;
  if (before) return `${label} no longer includes “${before}”.`;
  return `${label} changed in the reviewed before-and-after screenshots.`;
}

function evidenceAdvisorImpact(changeType) {
  return {
    deadline: "Review advising calendars and applicant deadline guidance.",
    funding: "Review applicant-facing funding guidance.",
    eligibility: "Review eligibility guidance before advising applicants.",
    requirements: "Review application requirements and applicant materials guidance.",
    application: "Review applicant instructions and submission guidance.",
    visual: "Review the confirmed visual change before advising applicants.",
    other: "Review the cited source evidence before advising applicants.",
  }[changeType] || "Review the cited source evidence before advising applicants.";
}

function publicEvidenceExcerpt(value, maxLength = 220) {
  const text = normalizeText(value);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

function exactBeforeAfterSupportedByEvidence({ result, candidate }) {
  const diff = candidate?.deterministic_diff || candidate?.prompt_payload?.deterministic_diff || {};
  const addedText = [
    ...stringArray(diff.added_text),
    ...stringArray(diff.date_changes).filter((value) => cleanKey(value).startsWith("added")),
    ...stringArray(diff.amount_changes).filter((value) => cleanKey(value).startsWith("added")),
  ];
  const removedText = [
    ...stringArray(diff.removed_text),
    ...stringArray(diff.date_changes).filter((value) => cleanKey(value).startsWith("removed")),
    ...stringArray(diff.amount_changes).filter((value) => cleanKey(value).startsWith("removed")),
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
  ];
  const removedText = [
    ...stringArray(diff.removed_text),
    ...stringArray(diff.date_changes).filter((value) => cleanKey(value).startsWith("removed")),
    ...stringArray(diff.amount_changes).filter((value) => cleanKey(value).startsWith("removed")),
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

function alertBlockingPolicyFlag(result) {
  for (const rawFlag of [
    ...stringArray(result?.noise_flags),
    ...stringArray(result?.quality_flags),
    ...stringArray(result?.structured_diff?.noise_flags),
    result?.rejection_reason,
  ]) {
    const candidates = unique([
      cleanKey(rawFlag),
      cleanKey(rawFlag).replace(/-/g, "_"),
      String(rawFlag || "").trim().toLowerCase(),
    ]);
    const matching = candidates
      .map((flag) => monitoringPolicyFlagIdForAlias(flag))
      .find((flag) => flag && isAlertBlockingMonitoringPolicyFlag(flag));
    if (matching) return matching;
  }
  return null;
}

function resultLooksLikeRelativeAgeOnlyPolicyChange({ candidate, result }) {
  const structured = objectValue(result?.structured_diff);
  const deterministic = objectValue(
    candidate?.deterministic_diff || candidate?.prompt_payload?.deterministic_diff,
  );
  return hasRelativeAgeOnlyPolicyChange({
    readerSummary: result?.reader_summary,
    section: result?.section,
    before: result?.exact_before || result?.before,
    after: result?.exact_after || result?.after,
    addedText: stringArray(structured.added_text).length
      ? structured.added_text
      : deterministic.added_text,
    removedText: stringArray(structured.removed_text).length
      ? structured.removed_text
      : deterministic.removed_text,
    dateChanges: stringArray(structured.date_changes).length
      ? structured.date_changes
      : deterministic.date_changes,
    amountChanges: stringArray(structured.amount_changes).length
      ? structured.amount_changes
      : deterministic.amount_changes,
  });
}

function normalizePolicyIdentity(value) {
  const identity = objectValue(value);
  if (!Object.keys(identity).length) return null;
  return {
    id: cleanNullable(identity.id),
    version: cleanNullable(identity.version),
    hash: cleanNullable(identity.hash),
    policyVersion: cleanNullable(identity.policyVersion),
    decisionMemoryVersion: cleanNullable(identity.decisionMemoryVersion),
  };
}

function samePolicyIdentity(left, right) {
  if (!left || !right) return false;
  if (left.hash && right.hash) return left.hash === right.hash;
  if (left.id && right.id) return left.id === right.id;
  return left.version === right.version &&
    left.policyVersion === right.policyVersion &&
    left.decisionMemoryVersion === right.decisionMemoryVersion;
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
