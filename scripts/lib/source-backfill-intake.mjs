import { createHash } from "node:crypto";
import { normalizeSourceIntakeUrl } from "./source-intake.mjs";
import { validateSourceIntakeProviderReplayBinding } from "./source-intake-provider-binding.mjs";

export const SOURCE_BACKFILL_POLICY_VERSION = "low-coverage-source-backfill-v1";
export const SOURCE_BACKFILL_ONBOARDING_BATCH_ID = "low-coverage-source-backfill-v1";
export const SOURCE_BACKFILL_MANUAL_STATUS_REASON =
  "low_coverage_backfill_reviewed_manual_source_activation_required";
export const SOURCE_BACKFILL_APPROVAL_REQUEST_REASON =
  "low_coverage_backfill_source_approved_baseline_only";
export const SOURCE_BACKFILL_APPROVAL_CLAIM_REASON =
  "low_coverage_backfill_source_activation_claimed_no_charge";
export const SOURCE_BACKFILL_APPROVAL_PREFLIGHT_FAILURE_REASON =
  "low_coverage_backfill_source_activation_preflight_failed_no_charge";

const activeRequestStatuses = [
  "pending",
  "queued",
  "validating",
  "capturing",
  "ai_review_pending",
  "ai_review_submitted",
  "ai_review_succeeded",
  "matching",
  "needs_manual_review",
];

export function buildLowCoverageSourceIntakeRequest({ award, candidate }) {
  const awardId = requiredText(award?.id, "matched award id");
  const awardName = requiredText(award?.name, "matched award name");
  const submittedUrl = requiredText(candidate?.url, "candidate URL");
  const normalizedUrl = normalizeSourceIntakeUrl(submittedUrl);
  const evidenceBasis = {
    schema_version: 1,
    policy_version: SOURCE_BACKFILL_POLICY_VERSION,
    discovery_method: "low_coverage_official_source_search",
    matched_shared_award_id: awardId,
    matched_award_name: awardName,
    submitted_url: submittedUrl,
    normalized_url: normalizedUrl,
    candidate_title: cleanText(candidate?.title) || null,
    candidate_page_type: cleanText(candidate?.pageType) || "other",
    candidate_score: finiteNumber(candidate?.score),
    candidate_confidence: finiteNumber(candidate?.confidence),
    search_query: cleanText(candidate?.query) || null,
    search_rank: positiveInteger(candidate?.rank),
    verification: cleanText(candidate?.verification) || null,
    discovery_reason: cleanText(candidate?.reason) || null,
    paid_lane: "new_page_review",
    source_activation: "manual_only",
    notification_after_approval: "baseline_only",
  };
  const evidence = {
    ...evidenceBasis,
    evidence_sha256: sha256(canonicalJson(evidenceBasis)),
  };
  const id = deterministicUuid(
    `${SOURCE_BACKFILL_POLICY_VERSION}\n${awardId}\n${normalizedUrl.toLowerCase()}`,
  );

  return {
    id,
    award_name: awardName,
    homepage_url: normalizedUrl,
    notes: [
      "Discovered by the deterministic low-coverage source search.",
      "Route: paid new_page_review lane.",
      "Bulk-onboarding policy: an operator must approve source activation; any later acquisition is baseline_only and must not publish a first-observation alert.",
      "This request must not create/open a source or change the award official homepage automatically.",
      evidence.search_query ? `Search query: ${evidence.search_query}.` : null,
      evidence.verification ? `Verification: ${evidence.verification}.` : null,
      evidence.discovery_reason ? `Discovery evidence: ${evidence.discovery_reason}` : null,
    ].filter(Boolean).join(" "),
    intake_type: candidate?.pageType === "homepage" ? "award_homepage" : "official_source",
    submitted_url: submittedUrl,
    normalized_url: normalizedUrl,
    detected_award_name: awardName,
    matched_shared_award_id: awardId,
    status: "pending",
    status_reason: "queued_low_coverage_backfill_for_paid_review_manual_activation",
    ai_review: {
      backfill_discovery_evidence: evidence,
    },
    deterministic_review: {
      status: "preflight_candidate",
      reason: "deterministic_low_coverage_candidate_requires_paid_review",
      normalizedUrl,
      backfill_discovery_evidence: evidence,
    },
    discovered_links: [],
    capture_metadata: {
      backfill_policy_version: SOURCE_BACKFILL_POLICY_VERSION,
      source_activation: "manual_only",
      notification_after_approval: "baseline_only",
    },
    acquisition_kind: "admin_intake",
    notification_mode: "manual_review",
    onboarding_batch_id: SOURCE_BACKFILL_ONBOARDING_BATCH_ID,
  };
}

export function requiresManualBackfillSourceActivation(request) {
  return isLowCoverageSourceBackfillRequest(request)
    && request?.notification_mode === "manual_review";
}

export function isLowCoverageSourceBackfillRequest(request) {
  return request?.acquisition_kind === "admin_intake"
    && request?.onboarding_batch_id === SOURCE_BACKFILL_ONBOARDING_BATCH_ID;
}

export function openSourceRowsForCoverage(sources) {
  return (Array.isArray(sources) ? sources : []).filter(
    (source) => cleanText(source?.admin_review_status) === "open",
  );
}

export function isApprovedLowCoverageSourceActivation(request) {
  const aiReview = objectValue(request?.ai_review);
  const evidence = objectValue(aiReview.backfill_discovery_evidence);
  const approval = objectValue(aiReview.manual_source_activation);
  const inputBinding = objectValue(aiReview.provider_input_binding);
  const resultBinding = objectValue(aiReview.provider_result_binding);
  const matchedAwardId = cleanText(request?.matched_shared_award_id);
  return request?.acquisition_kind === "admin_intake"
    && request?.notification_mode === "baseline_only"
    && request?.onboarding_batch_id === SOURCE_BACKFILL_ONBOARDING_BATCH_ID
    && evidence.policy_version === SOURCE_BACKFILL_POLICY_VERSION
    && evidence.source_activation === "manual_only"
    && evidence.notification_after_approval === "baseline_only"
    && approval.approved === true
    && approval.required === false
    && approval.source_registered === false
    && approval.official_homepage_changed === false
    && approval.notification_after_approval === "baseline_only"
    && Boolean(matchedAwardId)
    && cleanText(approval.approved_shared_award_id) === matchedAwardId
    && validLowCoverageBackfillEvidence(evidence, {
      requestId: request?.id,
      matchedAwardId,
    })
    && cleanText(approval.backfill_discovery_evidence_sha256).toLowerCase()
      === cleanText(evidence.evidence_sha256).toLowerCase()
    && validActorEmail(approval.approved_by)
    && validTimestamp(approval.approved_at)
    && validApprovedProviderBinding({
      requestId: request?.id,
      inputBinding,
      resultBinding,
      approval,
    });
}

export function validateApprovedBackfillActivationReplay(request, capture, storedReview) {
  if (!isApprovedLowCoverageSourceActivation(request)) {
    throw new Error("Approved low-coverage activation is missing its exact operator, award, or baseline-only binding.");
  }
  const rawReview = objectValue(storedReview?.raw);
  if (cleanText(storedReview?.status) !== "accepted" || cleanText(rawReview.status) !== "accepted") {
    throw new Error("Approved low-coverage activation requires the stored accepted provider result.");
  }
  const replayBinding = validateSourceIntakeProviderReplayBinding({
    request,
    capture,
    deterministicReview: request?.deterministic_review,
    storedReview,
    rawResult: rawReview,
  });
  const approval = objectValue(storedReview?.manual_source_activation);
  const evidence = objectValue(storedReview?.backfill_discovery_evidence);
  if (
    cleanText(approval.provider_input_digest_sha256)
      !== replayBinding.inputBinding.digest_sha256
    || cleanText(approval.provider_result_binding_digest_sha256)
      !== replayBinding.resultBinding.digest_sha256
    || cleanText(approval.provider_result_sha256)
      !== replayBinding.resultBinding.provider_result_sha256
    || cleanText(approval.backfill_discovery_evidence_sha256)
      !== cleanText(evidence.evidence_sha256)
  ) {
    throw new Error(
      "Approved low-coverage activation is not bound to the exact retained capture and provider result approved by the operator.",
    );
  }
  return replayBinding.capture;
}

export async function enqueueLowCoverageSourceIntakeRequests({ supabase, requests }) {
  if (!supabase || typeof supabase.from !== "function") {
    throw new Error("Low-coverage source intake enqueue requires a Supabase client.");
  }
  let enqueued = 0;
  let alreadyPresent = 0;
  for (const request of requests || []) {
    const result = await supabase
      .from("source_page_requests")
      .upsert(request, { onConflict: "id", ignoreDuplicates: true })
      .select("id,status,award_name,normalized_url")
      .maybeSingle();
    if (result.error) {
      if (String(result.error.code || "") !== "23505") {
        throw new Error(`source_page_requests enqueue failed: ${result.error.message}`);
      }
      const existing = await loadActiveLogicalDuplicate(supabase, request);
      if (!existing) {
        throw new Error(
          `source_page_requests enqueue hit an unrecognized uniqueness conflict for ${request.id}.`,
        );
      }
      alreadyPresent += 1;
      continue;
    }
    if (result.data?.id) {
      enqueued += 1;
      continue;
    }
    const existing = await loadRequestById(supabase, request.id);
    const logicalDuplicate = existing
      ? null
      : await loadActiveLogicalDuplicate(supabase, request);
    if (!existing && !logicalDuplicate) {
      throw new Error(
        `source_page_requests idempotent enqueue returned no row and no exact id or active logical duplicate was found for ${request.id}.`,
      );
    }
    alreadyPresent += 1;
  }
  return { enqueued, alreadyPresent };
}

async function loadRequestById(supabase, id) {
  const result = await supabase
    .from("source_page_requests")
    .select("id,status,award_name,normalized_url")
    .eq("id", id)
    .maybeSingle();
  if (result.error) throw new Error(`source_page_requests idempotency lookup failed: ${result.error.message}`);
  return result.data || null;
}

async function loadActiveLogicalDuplicate(supabase, request) {
  const result = await supabase
    .from("source_page_requests")
    .select("id,status,award_name,normalized_url")
    .eq("normalized_url", request.normalized_url)
    .in("status", activeRequestStatuses)
    .order("created_at", { ascending: true })
    .limit(100);
  if (result.error) {
    throw new Error(`source_page_requests logical idempotency lookup failed: ${result.error.message}`);
  }
  const awardKey = normalizedAwardName(request.award_name);
  return (result.data || []).find(
    (row) => normalizedAwardName(row.award_name) === awardKey,
  ) || null;
}

function deterministicUuid(value) {
  const bytes = Buffer.from(sha256(value), "hex").subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function sha256(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function normalizedAwardName(value) {
  return cleanText(value).toLowerCase();
}

function requiredText(value, label) {
  const text = cleanText(value);
  if (!text) throw new Error(`Low-coverage source intake requires ${label}.`);
  return text;
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function finiteNumber(value) {
  if (value === null || value === undefined || cleanText(value) === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positiveInteger(value) {
  const number = Math.trunc(Number(value));
  return Number.isFinite(number) && number > 0 ? number : null;
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function validTimestamp(value) {
  const text = cleanText(value);
  return Boolean(text) && Number.isFinite(Date.parse(text));
}

function validActorEmail(value) {
  const text = cleanText(value);
  return text === text.toLowerCase() && /^[^\s@]+@[^\s@]+$/.test(text);
}

function validApprovedProviderBinding({ requestId, inputBinding, resultBinding, approval }) {
  const request = cleanText(requestId);
  const inputDigest = cleanText(inputBinding.digest_sha256).toLowerCase();
  const resultDigest = cleanText(resultBinding.digest_sha256).toLowerCase();
  const resultHash = cleanText(resultBinding.provider_result_sha256).toLowerCase();
  return Boolean(request)
    && Number(inputBinding.schema_version) === 2
    && cleanText(inputBinding.namespace) === "source-intake-provider-input-v2"
    && cleanText(inputBinding.request_id) === request
    && /^[0-9a-f]{64}$/.test(inputDigest)
    && Number(resultBinding.schema_version) === 2
    && cleanText(resultBinding.namespace) === "source-intake-provider-result-v2"
    && cleanText(resultBinding.request_id) === request
    && cleanText(resultBinding.input_digest_sha256).toLowerCase() === inputDigest
    && cleanText(resultBinding.provider_batch_request_key) === request
    && Boolean(cleanText(resultBinding.provider_batch_name))
    && Boolean(cleanText(resultBinding.model))
    && /^[0-9a-f]{64}$/.test(resultHash)
    && /^[0-9a-f]{64}$/.test(resultDigest)
    && validTimestamp(resultBinding.accepted_at)
    && cleanText(approval.provider_input_digest_sha256).toLowerCase() === inputDigest
    && cleanText(approval.provider_result_binding_digest_sha256).toLowerCase() === resultDigest
    && cleanText(approval.provider_result_sha256).toLowerCase() === resultHash;
}

export function validLowCoverageBackfillEvidence(
  value,
  { matchedAwardId = null } = {},
) {
  try {
    const evidence = objectValue(value);
    const basis = {
      schema_version: Number(evidence.schema_version),
      policy_version: cleanText(evidence.policy_version),
      discovery_method: cleanText(evidence.discovery_method),
      matched_shared_award_id: cleanText(evidence.matched_shared_award_id),
      matched_award_name: cleanText(evidence.matched_award_name),
      submitted_url: cleanText(evidence.submitted_url),
      normalized_url: cleanText(evidence.normalized_url),
      candidate_title: cleanText(evidence.candidate_title) || null,
      candidate_page_type: cleanText(evidence.candidate_page_type) || "other",
      candidate_score: finiteNumber(evidence.candidate_score),
      candidate_confidence: finiteNumber(evidence.candidate_confidence),
      search_query: cleanText(evidence.search_query) || null,
      search_rank: positiveInteger(evidence.search_rank),
      verification: cleanText(evidence.verification) || null,
      discovery_reason: cleanText(evidence.discovery_reason) || null,
      paid_lane: cleanText(evidence.paid_lane),
      source_activation: cleanText(evidence.source_activation),
      notification_after_approval: cleanText(evidence.notification_after_approval),
    };
    return basis.schema_version === 1
      && basis.policy_version === SOURCE_BACKFILL_POLICY_VERSION
      && basis.discovery_method === "low_coverage_official_source_search"
      && Boolean(basis.matched_shared_award_id)
      && (!matchedAwardId || basis.matched_shared_award_id === cleanText(matchedAwardId))
      && Boolean(basis.matched_award_name)
      && Boolean(basis.submitted_url)
      && Boolean(basis.normalized_url)
      && basis.paid_lane === "new_page_review"
      && basis.source_activation === "manual_only"
      && basis.notification_after_approval === "baseline_only"
      && /^[0-9a-f]{64}$/.test(cleanText(evidence.evidence_sha256).toLowerCase())
      && sha256(canonicalJson(basis)) === cleanText(evidence.evidence_sha256).toLowerCase();
  } catch {
    return false;
  }
}
