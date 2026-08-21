import {
  isMonitorableOfficialSource,
  isTrackableOfficialSourceUrl,
} from "@/lib/source-url-policy";
import {
  explainSourceAiReviewStatus,
  sourceBaselineFacts,
} from "@/lib/source-ai-review-status";

export { sourceBaselineFacts } from "@/lib/source-ai-review-status";

export const sourceMonitoringRestoreMarker = "monitoring_restore_v1";
export const sourceMonitoringRestoreDecisionReason =
  "operator_review_restored_ai_unclear_monitoring_only";

export type SourceQualityPurpose =
  | "public"
  | "facts"
  | "monitoring"
  | "discovery"
  | "admin"
  | "debug";

export type SourceQualitySource = {
  id?: string | null;
  url?: string | null;
  title?: string | null;
  display_title?: string | null;
  page_description?: string | null;
  page_metadata?: unknown;
  page_metadata_generated_at?: string | null;
  page_metadata_model?: string | null;
  page_type?: string | null;
  source?: string | null;
  reason?: string | null;
  submitted_by_user_id?: string | null;
  admin_review_status?: string | null;
  admin_review_note?: string | null;
  admin_reviewed_at?: string | null;
  admin_reviewed_by?: string | null;
};

export type SourceQualityDecision = {
  allowed: boolean;
  reason: string;
  facts: Record<string, unknown>;
  hasBaselineFacts: boolean;
  metadataExists: boolean;
  qualityFlags: string[];
};

const rejectedQualityFlags = new Set([
  "source-mismatch",
  "spam",
  "job-board",
  "career-page",
  "search-results",
  "generic-listing",
  "sibling-program",
  "access-error",
  "hacked-page",
  "pharma-spam",
  "unrelated-program",
]);
const spamUploadTitle =
  /\b(viagra|levitra|cialis|pharma|casino|xanax|tramadol|pills|essay writing|payday)\b/i;
const STAGE1_BASELINE_EVIDENCE_PACKET_SHA256 =
  "8a1c1d9aa8ccbdf1dcdbb7b2f4b83ac19c99dd9557a8949dff5f63dd22d1026f";
const STAGE1_BASELINE_APPROVED_REQUEST_IDS = new Set([
  "62a291a2-e64d-5788-a876-f2dca551a021",
  "cc190ad2-8240-5b8c-b5ac-a73180094d24",
  "2bd3018c-d1b6-5d39-85ed-ea278e9d3702",
  "e01d9d33-47de-5ba9-b83c-d6e7c69a4c7f",
  "27ad713b-0332-59e6-b28b-44b9ff631bc1",
  "fd02cb92-8ab6-553f-8e31-752802ac4641",
  "a97507bf-295a-5a81-99e5-4516f96c9612",
  "2cd2f427-753f-5de7-ab0b-616502b287b7",
  "cf731f52-f02d-581e-bf52-c698f53d87d8",
  "4952d327-4fa5-53a0-8247-dd029f7f2c2c",
]);
const STAGE1_SOURCE_ROLES = new Set([
  "identity_home",
  "eligibility",
  "application_materials",
  "dates_cycle",
  "funding",
  "faq",
  "selection_interviews",
  "current_documents",
]);

export function sourceQualityDecision(
  source: SourceQualitySource | null | undefined,
  options: { purpose: SourceQualityPurpose },
): SourceQualityDecision {
  const purpose = options.purpose;
  const facts = sourceBaselineFacts(source);
  const metadata = objectValue(source?.page_metadata);
  const hasBaselineFacts = Object.keys(facts).length > 0;
  const metadataExists = sourceMetadataExists(source, metadata);
  const qualityFlags = normalizedQualityFlags(metadata, facts);
  const reject = (reason: string): SourceQualityDecision => ({
    allowed: false,
    reason,
    facts,
    hasBaselineFacts,
    metadataExists,
    qualityFlags,
  });
  const allow = (reason = "allowed"): SourceQualityDecision => ({
    allowed: true,
    reason,
    facts,
    hasBaselineFacts,
    metadataExists,
    qualityFlags,
  });

  if (!source?.url) return reject("missing_url");

  if (purpose === "monitoring" || purpose === "discovery") {
    if (!isMonitorableOfficialSource({ url: source.url, page_type: source.page_type })) {
      return reject("url_not_monitorable");
    }
  } else if (!isTrackableOfficialSourceUrl(source.url)) {
    return reject("url_not_public_trackable");
  }

  const titleSignal = [source.title, source.display_title, metadata.page_title, facts.display_title]
    .map((value) => String(value || ""))
    .join(" ");
  if (isSpamUploadHtmlSource(source.url, titleSignal)) return reject("url_spam_upload_html");

  const stage1Approval = stage1BaselineMonitoringApprovalStatus(source, metadata);
  if (stage1Approval === "invalid") {
    return reject("stage1_baseline_monitoring_approval_invalid");
  }
  if (stage1Approval === "valid") {
    if (purpose === "monitoring") return allow("stage1_baseline_monitoring_only");
    if (purpose === "public" || purpose === "facts") {
      return reject("stage1_baseline_monitoring_only_no_fact_authority");
    }
    if (purpose === "discovery") {
      return reject("stage1_baseline_monitoring_only_no_discovery_authority");
    }
  }

  if (purpose === "public" || purpose === "facts" || purpose === "monitoring") {
    const review = explainSourceAiReviewStatus(source);
    if (purpose === "monitoring" && !review.canBeMonitored) {
      if (hasLaterExplicitOperatorMonitoringRestore(source, metadata, review)) {
        return allow(sourceMonitoringRestoreDecisionReason);
      }
      return reject(`ai_review_${review.status}_${review.reason}`);
    }
    if ((purpose === "public" || purpose === "facts") && !review.canContributePublicFacts) {
      return reject(`ai_review_${review.status}_${review.reason}`);
    }
    return allow(`ai_review_${review.status}`);
  }

  if (
    metadata.baseline_facts_rejected === true ||
    metadata.baselineFactsRejected === true ||
    objectValue(metadata.baseline_facts_metadata).rejected === true
  ) {
    return reject("baseline_facts_rejected");
  }

  const badFlag = qualityFlags.find((flag) => rejectedQualityFlags.has(flag));
  if (badFlag) return reject(`quality_flag_${badFlag}`);

  const awardRelevance = hasBaselineFacts ? cleanKey(facts.award_relevance) || "unclear" : "";
  if (awardRelevance === "unrelated") return reject("award_relevance_unrelated");
  if (awardRelevance === "unclear" && purpose !== "admin" && purpose !== "debug") {
    return reject("award_relevance_unclear");
  }

  const cycleRelevance = hasBaselineFacts ? cleanKey(facts.cycle_relevance) || "unclear" : "";
  if (cycleRelevance === "not-program-page") return reject("cycle_relevance_not_program_page");
  if (cycleRelevance === "archived-or-past") return reject("cycle_relevance_archived_or_past");
  if (cycleRelevance === "unclear" && purpose !== "admin" && purpose !== "debug") {
    return reject("cycle_relevance_unclear");
  }

  return allow();
}

// Statuses an authenticated operator may restore for monitoring only: the
// unclear class, plus stale machine verdicts on sources a human review has
// explicitly bound since — the restore never grants fact authority, and a
// fresh capture re-enters the paid AI review lanes to replace the verdict.
const operatorRestorableStatuses = new Set([
  "reviewed_unclear_needs_manual_review",
  "reviewed_rejected_unrelated",
  "reviewed_rejected_sibling_program",
  "reviewed_rejected_archived_or_past",
  "reviewed_rejected_not_program_page",
  "reviewed_rejected_generic_listing",
  "reviewed_invalid_or_incomplete",
  "unreviewed",
]);

function hasLaterExplicitOperatorMonitoringRestore(
  source: SourceQualitySource,
  metadata: Record<string, unknown>,
  review: ReturnType<typeof explainSourceAiReviewStatus>,
) {
  if (
    source.admin_review_status !== "open" ||
    !operatorRestorableStatuses.has(review.status)
  ) {
    return false;
  }

  const actor = cleanText(source.admin_reviewed_by);
  const note = cleanText(source.admin_review_note);
  const actorIsAuthenticatedAdmin =
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(actor) &&
    note.includes(sourceMonitoringRestoreMarker);
  const actorIsRecordedStage1Operator =
    /^codex-stage1-[a-z0-9-]+$/.test(cleanKey(actor)) &&
    /\b(?:explicit|approved|restored)\b/i.test(note);
  if (!actorIsAuthenticatedAdmin && !actorIsRecordedStage1Operator) return false;

  const operatorReviewedAt = timestampMs(source.admin_reviewed_at);
  if (operatorReviewedAt === null) return false;

  const baselineFactsMetadata = objectValue(metadata.baseline_facts_metadata);
  const coverageBackfill = objectValue(metadata.ai_review_coverage_backfill);
  const aiReviewTimestamps = [
    source.page_metadata_generated_at,
    metadata.generated_at,
    baselineFactsMetadata.extracted_at,
    coverageBackfill.at,
  ]
    .map(timestampMs)
    .filter((value): value is number => value !== null);
  if (!aiReviewTimestamps.length) return false;

  return operatorReviewedAt > Math.max(...aiReviewTimestamps);
}

function stage1BaselineMonitoringApprovalStatus(
  source: SourceQualitySource,
  metadata: Record<string, unknown>,
) {
  if (!("stage1_baseline_monitoring_approval" in metadata)) return "absent";
  const approval = objectValue(metadata.stage1_baseline_monitoring_approval);
  const exactKeys = [
    "decision",
    "decision_item_sha256",
    "evidence_packet_sha256",
    "exact_evidence_verified",
    "fact_candidate_authority",
    "notification_mode",
    "policy_version",
    "public_fact_authority",
    "reviewed_roles",
    "schema_version",
    "shared_award_source_id",
    "source_page_request_id",
  ];
  const actualKeys = Object.keys(approval).sort();
  const reviewedRoles = Array.isArray(approval.reviewed_roles)
    ? approval.reviewed_roles
    : [];
  return (
    actualKeys.length === exactKeys.length &&
    actualKeys.every((key, index) => key === exactKeys[index]) &&
    approval.schema_version === "awardping.stage1.baseline-monitoring-approval.v1" &&
    approval.policy_version === "stage1-baseline-source-disposition-v1" &&
    approval.decision === "monitoring_only" &&
    approval.shared_award_source_id === source.id &&
    STAGE1_BASELINE_APPROVED_REQUEST_IDS.has(String(approval.source_page_request_id || "")) &&
    approval.evidence_packet_sha256 === STAGE1_BASELINE_EVIDENCE_PACKET_SHA256 &&
    /^[0-9a-f]{64}$/.test(String(approval.decision_item_sha256 || "")) &&
    approval.exact_evidence_verified === true &&
    approval.notification_mode === "baseline_only" &&
    approval.public_fact_authority === false &&
    approval.fact_candidate_authority === false &&
    reviewedRoles.length > 0 &&
    new Set(reviewedRoles).size === reviewedRoles.length &&
    reviewedRoles.every((role) => typeof role === "string" && STAGE1_SOURCE_ROLES.has(role)) &&
    [...reviewedRoles].sort().every((role, index) => role === reviewedRoles[index])
  ) ? "valid" : "invalid";
}

export function isPublicAwardSource(source: SourceQualitySource | null | undefined) {
  return sourceQualityDecision(source, { purpose: "public" }).allowed;
}

export function isUsableAwardFactSource(source: SourceQualitySource | null | undefined) {
  return sourceQualityDecision(source, { purpose: "facts" }).allowed;
}

export function isMonitorableAwardSource(source: SourceQualitySource | null | undefined) {
  return sourceQualityDecision(source, { purpose: "monitoring" }).allowed;
}

function sourceMetadataExists(source: SourceQualitySource | null | undefined, metadata: Record<string, unknown>) {
  return Boolean(
    source?.page_metadata_generated_at ||
      Object.keys(metadata).length ||
      metadata.baseline_facts ||
      metadata.baselineFacts ||
      metadata.baseline_facts_rejected,
  );
}

function normalizedQualityFlags(metadata: Record<string, unknown>, facts: Record<string, unknown>) {
  return [
    ...stringArray(facts.quality_flags),
    ...stringArray(metadata.quality_flags),
    ...stringArray(objectValue(metadata.baseline_facts_metadata).quality_flags),
    cleanKey(metadata.rejection_reason),
  ]
    .map(cleanKey)
    .filter(Boolean);
}

function isSpamUploadHtmlSource(urlValue: string, titleSignal: string) {
  try {
    const url = new URL(urlValue);
    return (
      /\/wp-content\/uploads\/\d{4}\/\d{2}\/[^/]+\.html?$/i.test(url.pathname) &&
      spamUploadTitle.test(`${titleSignal} ${decodeURIComponent(url.pathname)}`)
    );
  } catch {
    return false;
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringArray(value: unknown) {
  if (Array.isArray(value)) return value.map((item) => String(item || ""));
  if (typeof value === "string") return value.split(/[,;|]/);
  return [];
}

function cleanText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function timestampMs(value: unknown) {
  const parsed = Date.parse(cleanText(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function cleanKey(value: unknown) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]+/g, "")
    .replace(/-+/g, "-");
}
