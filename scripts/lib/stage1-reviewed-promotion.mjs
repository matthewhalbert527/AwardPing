import { createHash } from "node:crypto";
import {
  REQUIRED_SOURCE_ROLES,
  STAGE1_COHORT_DEFINITION,
  STAGE1_POLICY_VERSION,
} from "./stage1-cohort-readiness.mjs";

export const STAGE1_PROMOTION_PLAN_SCHEMA_VERSION =
  "stage1-reviewed-promotion-plan-v1";

const PROMOTABLE_MANIFEST_STATUSES = new Set([
  "present",
  "combined",
  "not_published",
]);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export function resolveStage1PromotionTargets({ cohortKey, all = false } = {}) {
  const normalizedCohortKey = cleanText(cohortKey);
  const allSelected = all === true;
  if (allSelected === Boolean(normalizedCohortKey)) {
    throw new Error(
      "Choose exactly one promotion target: --cohort-key=<key> or --all.",
    );
  }

  if (allSelected) {
    if (STAGE1_COHORT_DEFINITION.length !== 25) {
      throw new Error(
        `The national Stage 1 definition must contain exactly 25 awards; found ${STAGE1_COHORT_DEFINITION.length}.`,
      );
    }
    return STAGE1_COHORT_DEFINITION
      .toSorted((left, right) => left.launchRank - right.launchRank)
      .map((entry) => entry.cohortKey);
  }

  if (!STAGE1_COHORT_DEFINITION.some(
    (entry) => entry.cohortKey === normalizedCohortKey,
  )) {
    throw new Error(`Unknown Stage 1 cohort key: ${normalizedCohortKey}.`);
  }
  return [normalizedCohortKey];
}

export function buildStage1ReviewedPromotionPlan({
  targetCohortKeys,
  reviewRows,
  manifestDocument = null,
  actor,
  reason,
  policyVersion = STAGE1_POLICY_VERSION,
}) {
  const normalizedActor = requireText(actor, "actor");
  const normalizedReason = requireText(reason, "reason");
  const normalizedPolicyVersion = requireText(policyVersion, "policy version");
  if (normalizedPolicyVersion !== STAGE1_POLICY_VERSION) {
    throw new Error(
      `Stage 1 promotion requires policy version ${STAGE1_POLICY_VERSION}.`,
    );
  }

  const targetKeys = validateTargetCohortKeys(targetCohortKeys);
  const normalizedReviews = normalizeReviewRows(reviewRows, targetKeys);
  const manifestEntries = normalizeManifestEntries({
    manifestDocument,
    reviewRows: normalizedReviews,
    targetKeys,
    policyVersion: normalizedPolicyVersion,
  });
  const expectedReviewHashes = Object.fromEntries(
    normalizedReviews.map((review) => [review.cohort_key, review.review_hash]),
  );
  const confirmationPayload = {
    schema_version: STAGE1_PROMOTION_PLAN_SCHEMA_VERSION,
    operation: "apply_stage1_reviewed_promotion",
    target_mode: targetKeys.length === 25 ? "exact_national_25" : "single_award",
    cohort_keys: targetKeys,
    expected_review_hashes: expectedReviewHashes,
    manifest_entries: manifestEntries,
    reason: normalizedReason,
    policy_version: normalizedPolicyVersion,
    actor: normalizedActor,
  };

  return {
    ...confirmationPayload,
    confirmation_hash: sha256Canonical(confirmationPayload),
    evidence_preview: normalizedReviews.map(summarizeReviewRow),
    review_snapshots: Object.fromEntries(
      normalizedReviews.map((review) => [review.cohort_key, review.snapshot]),
    ),
    safety: {
      remote_mutations_in_preview: 0,
      paid_api_calls: 0,
      apply_is_single_database_transaction: true,
      stale_preview_is_rejected: true,
      partial_national_batch_is_rejected: true,
    },
  };
}

export function promotionRpcArgs(plan) {
  return {
    p_cohort_keys: plan.cohort_keys,
    p_expected_review_hashes: plan.expected_review_hashes,
    p_manifest_entries: plan.manifest_entries,
    p_reason: plan.reason,
    p_policy_version: plan.policy_version,
    p_actor: plan.actor,
  };
}

export function assertStage1PromotionConfirmation(plan, suppliedHash) {
  const supplied = cleanText(suppliedHash).toLowerCase();
  if (!SHA256_PATTERN.test(supplied)) {
    throw new Error("--confirm-hash must be a 64-character lowercase SHA-256 value.");
  }
  if (supplied !== plan.confirmation_hash) {
    throw new Error(
      "Confirmation hash mismatch. Nothing was applied; generate and review a new dry-run preview.",
    );
  }
  return true;
}

export function verifyStage1PromotionResult({
  plan,
  promotedRows,
  effectiveRows,
}) {
  const promoted = Array.isArray(promotedRows) ? promotedRows : [];
  const effective = Array.isArray(effectiveRows) ? effectiveRows : [];
  const promotedByKey = new Map(promoted.map((row) => [row?.cohort_key, row]));
  const effectiveByKey = new Map(effective.map((row) => [row?.cohort_key, row]));
  const failures = [];

  for (const cohortKey of plan.cohort_keys) {
    const registry = promotedByKey.get(cohortKey);
    const publication = effectiveByKey.get(cohortKey);
    if (registry?.publication_state !== "verified_beta") {
      failures.push(`${cohortKey}:registry_not_verified_beta`);
    }
    if (!publication?.cohort_ready) {
      failures.push(
        `${cohortKey}:cohort_not_ready:${cleanText(publication?.cohort_readiness_reason) || "missing_status"}`,
      );
    }
  }

  if (promoted.length !== plan.cohort_keys.length) {
    failures.push(
      `promoted_row_count:${promoted.length}:expected_${plan.cohort_keys.length}`,
    );
  }
  if (failures.length) {
    throw new Error(`Stage 1 promotion verification failed: ${failures.join(", ")}`);
  }

  return {
    verified: true,
    target_count: plan.cohort_keys.length,
    cohort_keys: plan.cohort_keys,
    public_release_effective:
      plan.cohort_keys.length === 25 &&
      plan.cohort_keys.every((cohortKey) => effectiveByKey.get(cohortKey)?.effectively_verified === true),
    awaiting_release_acceptance:
      plan.cohort_keys.length === 25 &&
      plan.cohort_keys.every((cohortKey) => effectiveByKey.get(cohortKey)?.cohort_ready === true) &&
      plan.cohort_keys.every((cohortKey) => effectiveByKey.get(cohortKey)?.effectively_verified !== true),
    single_award_note: plan.cohort_keys.length === 1
      ? "The cohort is verified and ready, but public release remains gated on the exact national 25."
      : null,
  };
}

export function stableCanonicalJson(value) {
  return JSON.stringify(stableValue(value));
}

function validateTargetCohortKeys(values) {
  if (!Array.isArray(values)) throw new Error("Promotion targets must be an array.");
  const targetKeys = values.map(cleanText).filter(Boolean);
  const unique = new Set(targetKeys);
  if (targetKeys.length !== unique.size || ![1, 25].includes(targetKeys.length)) {
    throw new Error(
      "A reviewed promotion must target exactly one unique cohort or the exact national 25.",
    );
  }
  const definedKeys = STAGE1_COHORT_DEFINITION
    .toSorted((left, right) => left.launchRank - right.launchRank)
    .map((entry) => entry.cohortKey);
  if (targetKeys.length === 25) {
    if (stableCanonicalJson([...targetKeys].toSorted()) !== stableCanonicalJson([...definedKeys].toSorted())) {
      throw new Error("The all-awards target must exactly match the national Stage 1 cohort.");
    }
    return definedKeys;
  }
  if (!definedKeys.includes(targetKeys[0])) {
    throw new Error(`Unknown Stage 1 cohort key: ${targetKeys[0]}.`);
  }
  return targetKeys;
}

function normalizeReviewRows(rows, targetKeys) {
  if (!Array.isArray(rows)) throw new Error("Promotion preview RPC returned no row array.");
  const byKey = new Map();
  for (const row of rows) {
    const cohortKey = cleanText(row?.cohort_key);
    if (!targetKeys.includes(cohortKey) || byKey.has(cohortKey)) {
      throw new Error(`Promotion preview returned an unexpected or duplicate cohort: ${cohortKey || "(missing)"}.`);
    }
    const reviewHash = cleanText(row?.review_hash).toLowerCase();
    if (!SHA256_PATTERN.test(reviewHash)) {
      throw new Error(`Promotion preview for ${cohortKey} has no valid review hash.`);
    }
    if (!isPlainObject(row?.snapshot)) {
      throw new Error(`Promotion preview for ${cohortKey} has no evidence snapshot.`);
    }
    if (row.snapshot.cohort_key !== cohortKey) {
      throw new Error(`Promotion preview identity mismatch for ${cohortKey}.`);
    }
    byKey.set(cohortKey, {
      cohort_key: cohortKey,
      review_hash: reviewHash,
      snapshot: row.snapshot,
    });
  }
  const missing = targetKeys.filter((key) => !byKey.has(key));
  if (missing.length || byKey.size !== targetKeys.length) {
    throw new Error(`Promotion preview is incomplete; missing: ${missing.join(", ") || "unknown"}.`);
  }
  return targetKeys.map((key) => byKey.get(key));
}

function normalizeManifestEntries({
  manifestDocument,
  reviewRows,
  targetKeys,
  policyVersion,
}) {
  const cohorts = manifestDocument == null
    ? reviewRows.map((review) => ({
        cohort_key: review.cohort_key,
        manifests: review.snapshot.manifests,
      }))
    : manifestCohorts(manifestDocument);
  if (cohorts.length !== targetKeys.length) {
    throw new Error(
      `Manifest preview must contain exactly ${targetKeys.length} target cohort(s).`,
    );
  }

  const byCohort = new Map();
  for (const cohort of cohorts) {
    const cohortKey = cleanText(cohort?.cohort_key);
    if (!targetKeys.includes(cohortKey) || byCohort.has(cohortKey)) {
      throw new Error(`Manifest preview has an unexpected or duplicate cohort: ${cohortKey || "(missing)"}.`);
    }
    if (!Array.isArray(cohort.manifests)) {
      throw new Error(`Manifest preview for ${cohortKey} must contain a manifests array.`);
    }
    byCohort.set(cohortKey, cohort.manifests);
  }

  const entries = [];
  for (const cohortKey of targetKeys) {
    const manifests = byCohort.get(cohortKey);
    if (!manifests) throw new Error(`Manifest preview is missing ${cohortKey}.`);
    if (manifests.length !== REQUIRED_SOURCE_ROLES.length) {
      throw new Error(
        `${cohortKey} requires exactly ${REQUIRED_SOURCE_ROLES.length} source-role manifests; found ${manifests.length}.`,
      );
    }
    const byRole = new Map();
    for (const manifest of manifests) {
      const role = cleanText(manifest?.source_role);
      if (!REQUIRED_SOURCE_ROLES.includes(role) || byRole.has(role)) {
        throw new Error(`${cohortKey} has an invalid or duplicate source role: ${role || "(missing)"}.`);
      }
      byRole.set(role, normalizeManifestEntry({
        cohortKey,
        manifest,
        policyVersion,
      }));
    }
    const missingRoles = REQUIRED_SOURCE_ROLES.filter((role) => !byRole.has(role));
    if (missingRoles.length) {
      throw new Error(`${cohortKey} is missing source roles: ${missingRoles.join(", ")}.`);
    }
    for (const role of REQUIRED_SOURCE_ROLES) entries.push(byRole.get(role));
  }
  return entries;
}

function manifestCohorts(document) {
  if (!isPlainObject(document)) throw new Error("Manifest file must contain a JSON object.");
  if (document.schema_version !== 1) {
    throw new Error("Manifest file schema_version must be 1.");
  }
  if (Array.isArray(document.cohorts)) return document.cohorts;
  if (Array.isArray(document.manifests) && cleanText(document.cohort_key)) {
    return [document];
  }
  throw new Error("Manifest file must contain cohorts[] or one cohort_key/manifests object.");
}

function normalizeManifestEntry({ cohortKey, manifest, policyVersion }) {
  const role = cleanText(manifest.source_role);
  const status = cleanText(manifest.manifest_status);
  if (!PROMOTABLE_MANIFEST_STATUSES.has(status)) {
    throw new Error(
      `${cohortKey}/${role} is not reviewed: manifest_status must be present, combined, or not_published.`,
    );
  }
  const entryPolicy = cleanText(manifest.policy_version);
  if (entryPolicy !== policyVersion) {
    throw new Error(`${cohortKey}/${role} has policy version ${entryPolicy || "(missing)"}; expected ${policyVersion}.`);
  }
  if (!Array.isArray(manifest.source_ids) || manifest.source_ids.length === 0) {
    throw new Error(`${cohortKey}/${role} requires at least one official source ID.`);
  }
  const sourceIds = [...new Set(manifest.source_ids.map((value) => cleanText(value).toLowerCase()))]
    .toSorted();
  if (sourceIds.length !== manifest.source_ids.length || sourceIds.some((value) => !UUID_PATTERN.test(value))) {
    throw new Error(`${cohortKey}/${role} contains a duplicate or invalid source UUID.`);
  }
  if (!isPlainObject(manifest.evidence)) {
    throw new Error(`${cohortKey}/${role} requires an evidence object.`);
  }
  validateManifestEvidence({
    cohortKey,
    role,
    status,
    sourceIds,
    evidence: manifest.evidence,
    policyVersion,
  });
  const checkedAt = cleanText(manifest.checked_at);
  if (!checkedAt || !Number.isFinite(Date.parse(checkedAt))) {
    throw new Error(`${cohortKey}/${role} requires a valid checked_at timestamp.`);
  }

  return {
    cohort_key: cohortKey,
    source_role: role,
    manifest_status: status,
    source_ids: sourceIds,
    evidence: stableValue(manifest.evidence),
    checked_at: new Date(checkedAt).toISOString(),
    policy_version: entryPolicy,
  };
}

function validateManifestEvidence({
  cohortKey,
  role,
  status,
  sourceIds,
  evidence,
  policyVersion,
}) {
  const prefix = `${cohortKey}/${role}`;
  if (evidence.official !== true) {
    throw new Error(`${prefix} evidence must identify an official source.`);
  }
  if (!/^https:\/\//i.test(cleanText(evidence.source_url))) {
    throw new Error(`${prefix} evidence requires an HTTPS source_url.`);
  }
  if (!cleanText(evidence.supporting_text)) {
    throw new Error(`${prefix} evidence requires supporting_text.`);
  }
  if (!isPlainObject(evidence.source_bindings)) {
    throw new Error(`${prefix} evidence requires source_bindings.`);
  }
  if (!isPlainObject(evidence.candidate_bindings)) {
    throw new Error(`${prefix} evidence requires candidate_bindings.`);
  }
  if (!Array.isArray(evidence.fact_candidate_ids)) {
    throw new Error(`${prefix} evidence requires fact_candidate_ids.`);
  }
  const candidateIds = evidence.fact_candidate_ids
    .map((value) => cleanText(value).toLowerCase());
  if (
    candidateIds.some((value) => !UUID_PATTERN.test(value))
    || new Set(candidateIds).size !== candidateIds.length
    || (status !== "not_published" && candidateIds.length === 0)
  ) {
    throw new Error(`${prefix} has missing, duplicate, or invalid fact-candidate IDs.`);
  }
  for (const sourceId of sourceIds) {
    const binding = evidence.source_bindings[sourceId];
    if (
      !isPlainObject(binding)
      || !/^https:\/\//i.test(cleanText(binding.source_url))
      || !isPlainObject(binding.object_keys)
      || !isPlainObject(binding.hashes)
      || !isPlainObject(binding.r2_hashes)
      || !isPlainObject(binding.local_hashes)
      || !isIsoTimestamp(binding.captured_at)
    ) {
      throw new Error(`${prefix} has incomplete immutable source binding ${sourceId}.`);
    }
  }
  for (const candidateId of candidateIds) {
    if (!isPlainObject(evidence.candidate_bindings[candidateId])) {
      throw new Error(`${prefix} has no binding for fact candidate ${candidateId}.`);
    }
  }
  if (
    !isIsoTimestamp(evidence.captured_at)
    || !isIsoTimestamp(evidence.r2_verified_at)
    || !isIsoTimestamp(evidence.local_verified_at)
  ) {
    throw new Error(`${prefix} requires captured, R2, and local verification timestamps.`);
  }
  if (!cleanText(evidence.cycle)) {
    throw new Error(`${prefix} evidence requires an award cycle.`);
  }
  if (!new Set(["passed", "verified", "not_applicable"]).has(
    cleanText(evidence.reconciliation_status),
  )) {
    throw new Error(`${prefix} evidence has no accepted reconciliation status.`);
  }
  if (cleanText(evidence.policy_version) !== policyVersion) {
    throw new Error(`${prefix} evidence policy version does not match ${policyVersion}.`);
  }
}

function isIsoTimestamp(value) {
  const text = cleanText(value);
  return /^\d{4}-\d{2}-\d{2}T.+Z$/.test(text) && Number.isFinite(Date.parse(text));
}

function summarizeReviewRow(review) {
  const snapshot = review.snapshot;
  const registry = isPlainObject(snapshot.registry) ? snapshot.registry : {};
  const canonicalAward = isPlainObject(snapshot.canonical_award)
    ? snapshot.canonical_award
    : {};
  const manifests = Array.isArray(snapshot.manifests) ? snapshot.manifests : [];
  const boundSources = Array.isArray(snapshot.bound_sources) ? snapshot.bound_sources : [];
  const boundCandidates = Array.isArray(snapshot.bound_candidates) ? snapshot.bound_candidates : [];
  const quarantines = Array.isArray(snapshot.actionable_quarantine)
    ? snapshot.actionable_quarantine
    : [];
  const reconciledEvidence = Array.isArray(snapshot.reconciled_fact_evidence)
    ? snapshot.reconciled_fact_evidence
    : [];

  return {
    cohort_key: review.cohort_key,
    review_hash: review.review_hash,
    award_name: registry.canonical_name || canonicalAward.name || null,
    canonical_shared_award_id: registry.canonical_shared_award_id || canonicalAward.id || null,
    publication_state: registry.publication_state || null,
    member_count: Array.isArray(snapshot.members) ? snapshot.members.length : 0,
    manifest_role_count: manifests.length,
    manifests: manifests.map((manifest) => ({
      source_role: manifest.source_role,
      manifest_status: manifest.manifest_status,
      source_ids: manifest.source_ids,
      fact_candidate_count: Array.isArray(manifest.evidence?.fact_candidate_ids)
        ? manifest.evidence.fact_candidate_ids.length
        : 0,
      checked_at: manifest.checked_at,
      policy_version: manifest.policy_version,
    })),
    bound_source_count: boundSources.length,
    bound_sources: boundSources.map((binding) => ({
      source_id: binding?.source?.id || null,
      url: binding?.source?.url || null,
      last_checked_at: binding?.source?.last_checked_at || null,
      last_error: binding?.source?.last_error || null,
      latest_captured_at: binding?.visual_snapshot?.latest_captured_at || null,
      latest_hashes: binding?.visual_snapshot?.latest_hashes || null,
      latest_object_keys: binding?.visual_snapshot?.latest_object_keys || null,
    })),
    bound_candidate_count: boundCandidates.length,
    bound_candidates: boundCandidates.map((candidate) => ({
      id: candidate.id,
      shared_award_id: candidate.shared_award_id,
      shared_award_source_id: candidate.shared_award_source_id,
      source_role: candidate.source_role,
      field_name: candidate.field_name,
      candidate_status: candidate.candidate_status,
      evidence_quote: candidate.evidence_quote,
      evidence_location: candidate.evidence_location,
      intake_value_sha256: candidate.intake_value_sha256,
    })),
    latest_reconciliation: snapshot.latest_reconciliation || null,
    latest_page_audit: snapshot.latest_page_audit || null,
    reconciled_fact_evidence_count: reconciledEvidence.length,
    actionable_quarantine_count: quarantines.length,
  };
}

function sha256Canonical(value) {
  return createHash("sha256").update(stableCanonicalJson(value)).digest("hex");
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .toSorted()
      .map((key) => [key, stableValue(value[key])]),
  );
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cleanText(value) {
  return String(value ?? "").trim();
}

function requireText(value, label) {
  const normalized = cleanText(value);
  if (!normalized) throw new Error(`Reviewed promotion requires an explicit ${label}.`);
  return normalized;
}
