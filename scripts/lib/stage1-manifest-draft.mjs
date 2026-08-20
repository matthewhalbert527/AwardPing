import { createHash } from "node:crypto";
import {
  PUBLISHED_FACT_FIELDS,
  STAGE1_COHORT_DEFINITION,
  STAGE1_FRESHNESS_MS,
  STAGE1_POLICY_VERSION,
  sourceIdentityDisposition,
} from "./stage1-cohort-readiness.mjs";
import {
  STAGE1_HUMAN_REVIEW_ROOT_SCHEMA_VERSION,
  normalizeStage1HumanReviewRoot,
  stage1HumanReviewRootScope,
  stage1HumanReviewRootSha256,
  validateStage1ImmutableCaptureBinding,
  validateStage1ImmutableObjectKeys,
} from "./stage1-human-review-root.mjs";

export const STAGE1_MANIFEST_MAPPING_SCHEMA_VERSION =
  STAGE1_HUMAN_REVIEW_ROOT_SCHEMA_VERSION;
export const STAGE1_MANIFEST_REVIEW_SCHEMA_VERSION =
  "awardping.stage1.manifest-draft-review.v2";
export {
  validateStage1ImmutableCaptureBinding,
  validateStage1ImmutableObjectKeys,
};

const FUTURE_SKEW_MS = 5 * 60 * 1_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CANDIDATE_EVIDENCE_SCHEMA_VERSION =
  "awardping.stage1.candidate-immutable-evidence.v1";
const AUDIT_PROOF_KEYS = Object.freeze([
  "reconciliation_audit_signature",
  "stage1_review_root_schema_version",
  "stage1_review_root_sha256",
]);

/**
 * Build a promotion-compatible manifest draft from one signed human-review
 * root and a stable post-reconciliation database snapshot. This function has
 * no I/O and never discovers, ranks, selects, or materializes candidates.
 */
export function buildStage1ManifestDraft({ mapping, database, now = new Date() }) {
  const asOf = validDate(now, "manifest draft as-of time");
  const reviewRoot = normalizeStage1HumanReviewRoot(mapping, asOf);
  const overallReviewRootSha256 = stage1HumanReviewRootSha256(mapping, asOf);
  const reviewRootBindings = stage1ManifestReviewRootBindings(mapping, asOf);
  const reviewRootBindingByCohort = new Map(
    reviewRootBindings.map((binding) => [binding.cohort_key, binding]),
  );
  const normalizedDatabase = normalizeDatabase(database);
  const definitions = new Map(
    STAGE1_COHORT_DEFINITION.map((entry) => [entry.cohortKey, entry]),
  );
  const registryByKey = uniqueBy(
    normalizedDatabase.registry,
    (row) => cleanText(row.cohort_key),
    "database Stage 1 registry cohort",
  );
  const awardById = uniqueBy(
    normalizedDatabase.awards,
    (row) => lowerUuid(row.id),
    "database award ID",
  );
  const sourceById = uniqueBy(
    normalizedDatabase.sources,
    (row) => lowerUuid(row.id),
    "database source ID",
  );
  const snapshotBySourceId = uniqueBy(
    normalizedDatabase.visual_snapshots,
    (row) => lowerUuid(row.shared_award_source_id),
    "database visual snapshot source ID",
  );
  const candidateById = uniqueBy(
    normalizedDatabase.fact_candidates,
    (row) => lowerUuid(row.id),
    "database fact-candidate ID",
  );

  const manifestCohorts = [];
  const evidenceReview = [];
  for (const reviewedCohort of reviewRoot.cohorts) {
    const reviewRootBinding = reviewRootBindingByCohort.get(reviewedCohort.cohort_key);
    const reviewRootSha256 = reviewRootBinding.root_sha256;
    const definition = definitions.get(reviewedCohort.cohort_key);
    const registry = registryByKey.get(reviewedCohort.cohort_key);
    if (!registry) fail(`${reviewedCohort.cohort_key}: database registry row is missing.`);
    validateCohortIdentity({ reviewedCohort, definition, registry, awardById });

    const members = normalizedDatabase.members.filter(
      (row) => cleanText(row.cohort_key) === reviewedCohort.cohort_key,
    );
    const memberIds = new Set(members.map((row) => lowerUuid(row.shared_award_id)));
    const canonicalMembers = members.filter((row) => row.member_kind === "canonical");
    if (
      canonicalMembers.length !== 1
      || lowerUuid(canonicalMembers[0].shared_award_id)
        !== reviewedCohort.canonical_award.id
    ) {
      fail(`${reviewedCohort.cohort_key}: canonical member identity is missing or ambiguous.`);
    }
    const identityRules = normalizedDatabase.identity_rules.filter(
      (row) => cleanText(row.cohort_key) === reviewedCohort.cohort_key,
    );
    for (const rule of identityRules) {
      if (cleanText(rule.policy_version) !== STAGE1_POLICY_VERSION) {
        fail(`${reviewedCohort.cohort_key}: identity rule ${rule.rule_key || rule.id} has the wrong policy version.`);
      }
    }

    const roleManifests = [];
    const reviewSourceIds = new Set();
    const reviewedCandidateIds = new Set();
    for (const role of reviewedCohort.roles) {
      const built = buildRoleManifest({
        reviewedCohort,
        role,
        registry,
        memberIds,
        identityRules,
        sourceById,
        snapshotBySourceId,
        candidateById,
        asOf,
        reviewedAt: reviewRoot.review.reviewed_at,
      });
      roleManifests.push(built.manifest);
      for (const sourceId of built.source_ids) reviewSourceIds.add(sourceId);
      for (const candidateId of built.candidate_ids) reviewedCandidateIds.add(candidateId);
    }

    const candidateIds = [...reviewedCandidateIds].toSorted();
    const contributorSourceIds = [...new Set(candidateIds.map((candidateId) => {
      const sourceId = lowerUuid(candidateById.get(candidateId)?.shared_award_source_id);
      if (!sourceId) fail(`${reviewedCohort.cohort_key}: candidate ${candidateId} has no source.`);
      return sourceId;
    }))].toSorted();
    const allReviewSourceIds = [...reviewSourceIds].toSorted();
    validateFieldChoices({
      reviewedCohort,
      candidateById,
      candidateIds,
    });

    const canonicalAward = awardById.get(reviewedCohort.canonical_award.id);
    validatePersistedReviewRoot({
      reviewedCohort,
      review: reviewRoot.review,
      persistedRoots: normalizedDatabase.persisted_review_roots,
      reviewRootBinding,
    });
    const reconciliation = validateReconciliation({
      reviewedCohort,
      database: normalizedDatabase,
      contributorSourceIds,
      reviewSourceIds: allReviewSourceIds,
      candidateIds,
      reviewRootSha256,
      asOf,
    });
    const pageAudit = validatePageAudit({
      reviewedCohort,
      database: normalizedDatabase,
      memberIds,
      canonicalAward,
      reviewRootSha256,
      asOf,
    });

    manifestCohorts.push({
      cohort_key: reviewedCohort.cohort_key,
      manifests: roleManifests,
    });
    evidenceReview.push({
      cohort_key: reviewedCohort.cohort_key,
      canonical_shared_award_id: reviewedCohort.canonical_award.id,
      source_role_count: roleManifests.length,
      review_source_count: allReviewSourceIds.length,
      contributor_source_count: contributorSourceIds.length,
      selected_candidate_count: candidateIds.length,
      reconciliation_id: lowerUuid(reconciliation.id),
      page_audit_id: lowerUuid(pageAudit.id),
      stage1_review_root_schema_version: STAGE1_HUMAN_REVIEW_ROOT_SCHEMA_VERSION,
      stage1_review_root_sha256: reviewRootSha256,
      public_page_snapshot_sha256: sha256Canonical(reviewedCohort.public_facts),
    });
  }

  const manifestDocument = {
    schema_version: 1,
    cohorts: manifestCohorts,
  };
  const databaseSnapshotSha256 = sha256Canonical(normalizedDatabase);
  const manifestSha256 = sha256Canonical(manifestDocument);
  const confirmationPayload = {
    schema_version: STAGE1_MANIFEST_REVIEW_SCHEMA_VERSION,
    operation: "review_stage1_manifest_draft",
    target_mode: reviewRoot.cohorts.length === 25
      ? "exact_national_25"
      : "single_exact_cohort",
    cohort_keys: reviewRoot.cohorts.map((entry) => entry.cohort_key),
    policy_version: STAGE1_POLICY_VERSION,
    reviewed_by: reviewRoot.review.reviewed_by,
    reviewed_at: reviewRoot.review.reviewed_at,
    reason: reviewRoot.review.reason,
    stage1_review_root_schema_version: STAGE1_HUMAN_REVIEW_ROOT_SCHEMA_VERSION,
    stage1_review_root_sha256: reviewRoot.cohorts.length === 1
      ? reviewRootBindings[0].root_sha256
      : overallReviewRootSha256,
    persisted_review_root_sha256s: Object.fromEntries(reviewRootBindings.map(
      (binding) => [binding.cohort_key, binding.root_sha256],
    )),
    database_snapshot_sha256: databaseSnapshotSha256,
    manifest_sha256: manifestSha256,
  };
  const confirmationSha256 = sha256Canonical(confirmationPayload);

  return {
    ...manifestDocument,
    draft_review: {
      ...confirmationPayload,
      generated_at: asOf.toISOString(),
      confirmation_sha256: confirmationSha256,
      confirmation_phrase: `CONFIRM STAGE1 MANIFEST ${confirmationSha256}`,
      evidence: evidenceReview,
      review_required: [
        "Confirm this is the same normalized human-review root committed by the reviewed reconciliation.",
        "Confirm every reviewed source still binds the exact immutable database, R2, and local capture identity.",
        "Confirm the succeeded reconciliation and deterministic audit persist the same canonical review-root hash.",
        "Use this file only as input to a separate dry-run promotion preview; this generator never applies it.",
      ],
      safety: {
        explicit_human_review_root_required: true,
        ranked_candidates_auto_accepted: false,
        candidates_materialized: 0,
        remote_mutations: 0,
        paid_api_calls: 0,
        page_captures: 0,
        r2_object_requests: 0,
      },
    },
  };
}

/** Validate the signed root and return only its explicit read query scope. */
export function stage1ManifestDraftScope(mapping, now = new Date()) {
  return stage1HumanReviewRootScope(mapping, validDate(now, "manifest draft as-of time"));
}

export function stage1ManifestReviewRootBindings(mapping, now = new Date()) {
  const asOf = validDate(now, "manifest review-root binding time");
  const normalized = normalizeStage1HumanReviewRoot(mapping, asOf);
  const rawByCohort = new Map(mapping.cohorts.map((cohort) => [cohort.cohort_key, cohort]));
  return normalized.cohorts.map((cohort) => {
    const singleRoot = {
      schema_version: mapping.schema_version,
      policy_version: mapping.policy_version,
      review: mapping.review,
      cohorts: [rawByCohort.get(cohort.cohort_key)],
    };
    return {
      cohort_key: cohort.cohort_key,
      canonical_shared_award_id: cohort.canonical_award.id,
      root_sha256: stage1HumanReviewRootSha256(singleRoot, asOf),
      review_root: normalizeStage1HumanReviewRoot(singleRoot, asOf),
    };
  });
}

export function stableStage1ManifestJson(value) {
  return JSON.stringify(stableValue(value));
}

function normalizeDatabase(database) {
  requirePlainObject(database, "database snapshot");
  const fields = [
    "registry",
    "members",
    "identity_rules",
    "awards",
    "sources",
    "visual_snapshots",
    "fact_candidates",
    "reconciliations",
    "page_audits",
    "persisted_review_roots",
  ];
  const normalized = {};
  for (const field of fields) {
    if (!Array.isArray(database[field])) fail(`Database snapshot ${field} must be an array.`);
    normalized[field] = database[field].map((row) => stableValue(row));
  }
  normalized.registry.sort(compareRows("cohort_key"));
  normalized.members.sort(compareRows("cohort_key", "member_kind", "shared_award_id"));
  normalized.identity_rules.sort(compareRows("cohort_key", "rule_key", "id"));
  normalized.awards.sort(compareRows("id"));
  normalized.sources.sort(compareRows("id"));
  normalized.visual_snapshots.sort(compareRows("shared_award_source_id"));
  normalized.fact_candidates.sort(compareRows("id"));
  normalized.reconciliations.sort(compareRows("shared_award_id", "created_at", "id"));
  normalized.page_audits.sort(compareRows("shared_award_id", "created_at", "id"));
  return normalized;
}

function validateCohortIdentity({ reviewedCohort, definition, registry, awardById }) {
  const prefix = reviewedCohort.cohort_key;
  if (
    Number(registry.launch_rank) !== definition.launchRank
    || cleanText(registry.canonical_name) !== definition.canonicalName
    || lowerUuid(registry.canonical_shared_award_id) !== reviewedCohort.canonical_award.id
    || cleanText(registry.official_homepage) !== definition.officialHomepage
    || cleanText(registry.policy_version) !== STAGE1_POLICY_VERSION
  ) {
    fail(`${prefix}: remote registry identity or policy differs from the reviewed Stage 1 definition.`);
  }
  const award = awardById.get(reviewedCohort.canonical_award.id);
  if (!award) fail(`${prefix}: canonical database award is missing.`);
  if (
    cleanText(award.search_key) !== definition.canonicalSearchKey
    || cleanText(award.name) !== definition.canonicalName
    || cleanText(award.official_homepage) !== definition.officialHomepage
    || cleanText(award.slug) !== cleanText(registry.canonical_slug)
    || cleanText(award.status) !== "active"
  ) {
    fail(`${prefix}: canonical database award identity, status, slug, or homepage drifted.`);
  }
}

function buildRoleManifest({
  reviewedCohort,
  role,
  registry,
  memberIds,
  identityRules,
  sourceById,
  snapshotBySourceId,
  candidateById,
  asOf,
  reviewedAt,
}) {
  const prefix = `${reviewedCohort.cohort_key}/${role.source_role}`;
  const sourceBindings = {};
  for (const reviewedSource of role.sources) {
    const source = sourceById.get(reviewedSource.source_id);
    if (!source) fail(`${prefix}: reviewed source ${reviewedSource.source_id} is absent from the database.`);
    if (!memberIds.has(lowerUuid(source.shared_award_id))) {
      fail(`${prefix}: source ${reviewedSource.source_id} does not belong to this exact cohort.`);
    }
    if (
      cleanText(source.url) !== reviewedSource.source_url
      || !isHttps(source.url)
      || cleanText(source.admin_review_status) !== "open"
      || cleanText(source.last_error)
      || !sameInstant(source.last_checked_at, reviewedSource.last_checked_at)
      || !isFresh(source.last_checked_at, asOf)
    ) {
      fail(`${prefix}: source ${reviewedSource.source_id} URL, status, HTTPS, freshness, or error state does not match.`);
    }
    const identity = sourceIdentityDisposition(source, identityRules);
    if (identity.excluded || identity.invalid_rules.length) {
      fail(`${prefix}: source ${reviewedSource.source_id} fails the cohort identity rules.`);
    }
    const snapshot = snapshotBySourceId.get(reviewedSource.source_id);
    if (!snapshot || lowerUuid(snapshot.shared_award_id) !== lowerUuid(source.shared_award_id)) {
      fail(`${prefix}: exact latest visual snapshot for ${reviewedSource.source_id} is missing or belongs to another award.`);
    }
    const immutableCapture = validateStage1ImmutableCaptureBinding({
      sourceId: reviewedSource.source_id,
      kind: cleanText(snapshot.kind || "webpage"),
      objectKeys: snapshot.latest_object_keys,
      hashes: snapshot.latest_hashes,
      metadata: snapshot.latest_metadata,
    });
    if (
      cleanText(snapshot.source_url) !== source.url
      || cleanText(snapshot.kind || "webpage") !== reviewedSource.snapshot.kind
      || !sameInstant(snapshot.latest_captured_at, reviewedSource.snapshot.captured_at)
      || !deepEqual(immutableCapture.object_keys, reviewedSource.snapshot.object_keys)
      || !deepEqual(immutableCapture.hashes, reviewedSource.snapshot.hashes)
      || !deepEqual(immutableCapture.metadata, reviewedSource.snapshot.metadata)
      || !deepEqual(reviewedSource.r2.hashes, immutableCapture.hashes)
      || !deepEqual(reviewedSource.local.hashes, immutableCapture.hashes)
    ) {
      fail(`${prefix}: source ${reviewedSource.source_id} does not bind the exact latest database, R2, and local snapshot identity.`);
    }
    sourceBindings[reviewedSource.source_id] = {
      source_url: source.url,
      official_identity: reviewedSource.official_identity,
      object_keys: reviewedSource.snapshot.object_keys,
      hashes: reviewedSource.snapshot.hashes,
      metadata: reviewedSource.snapshot.metadata,
      r2_hashes: reviewedSource.r2.hashes,
      local_hashes: reviewedSource.local.hashes,
      captured_at: reviewedSource.snapshot.captured_at,
      r2_verified_at: reviewedSource.r2.verified_at,
      local_verified_at: reviewedSource.local.verified_at,
    };
  }
  const sourceIds = role.sources.map((source) => source.source_id);
  if (role.source_role === "identity_home") {
    if (
      sourceIds.length !== 1
      || role.sources[0].source_url !== registry.official_homepage
      || sourceById.get(sourceIds[0])?.url !== registry.official_homepage
    ) {
      fail(`${prefix}: identity_home must exactly match the registry official homepage URL.`);
    }
  }

  const candidateBindings = {};
  for (const candidateId of role.fact_candidate_ids) {
    const candidate = candidateById.get(candidateId);
    if (!candidate) fail(`${prefix}: explicit candidate ${candidateId} is absent from the database.`);
    const candidateSourceId = lowerUuid(candidate.shared_award_source_id);
    if (
      cleanText(candidate.candidate_status) !== "selected"
      || !memberIds.has(lowerUuid(candidate.shared_award_id))
      || !sourceIds.includes(candidateSourceId)
      || cleanText(candidate.source_url) !== sourceById.get(candidateSourceId)?.url
      || !cleanText(candidate.field_name)
      || !cleanText(candidate.evidence_quote)
    ) {
      fail(`${prefix}: candidate ${candidateId} is not exact selected evidence from a bound role/source.`);
    }
    candidateBindings[candidateId] = {
      source_id: candidateSourceId,
      intake_source_relevance: candidate.source_role ?? null,
      reviewed_stage1_source_role: role.source_role,
      field_name: candidate.field_name,
      normalized_value: candidate.normalized_value,
      evidence_quote: candidate.evidence_quote,
      evidence_location: candidate.evidence_location ?? null,
      intake_value_sha256: cleanText(candidate.intake_value_sha256) || null,
      stage1_candidate_import_item_sha256:
        candidate.metadata?.stage1_candidate_import?.item_sha256 ?? null,
      immutable_evidence: candidate.metadata?.stage1_immutable_evidence ?? null,
    };
  }

  const manifest = {
    source_role: role.source_role,
    manifest_status: role.manifest_status,
    source_ids: sourceIds,
    evidence: {
      official: true,
      source_url: role.sources[0].source_url,
      supporting_text: role.supporting_text,
      captured_at: oldestTimestamp(role.sources.map((source) => source.snapshot.captured_at)),
      r2_verified_at: oldestTimestamp(role.sources.map((source) => source.r2.verified_at)),
      local_verified_at: oldestTimestamp(role.sources.map((source) => source.local.verified_at)),
      cycle: role.cycle,
      reconciliation_status: role.manifest_status === "not_published"
        ? "not_applicable"
        : "verified",
      policy_version: STAGE1_POLICY_VERSION,
      fact_candidate_ids: role.fact_candidate_ids,
      source_bindings: sourceBindings,
      candidate_bindings: candidateBindings,
    },
    checked_at: reviewedAt,
    policy_version: STAGE1_POLICY_VERSION,
  };
  return { manifest, source_ids: sourceIds, candidate_ids: role.fact_candidate_ids };
}

function validateFieldChoices({ reviewedCohort, candidateById, candidateIds }) {
  const expectedCandidateIds = [...new Set(reviewedCohort.field_choices.flatMap(
    (choice) => choice.candidate_ids,
  ))].toSorted();
  if (!deepEqual(candidateIds, expectedCandidateIds)) {
    fail(`${reviewedCohort.cohort_key}: role and field-choice candidate IDs differ.`);
  }
  for (const choice of reviewedCohort.field_choices) {
    for (const [index, candidateId] of choice.candidate_ids.entries()) {
      const candidate = candidateById.get(candidateId);
      const evidence = choice.candidate_evidence[index];
      const expectedValue = choice.composition_method === "ordered_array_items"
        ? reviewedCohort.public_facts[choice.field_name]?.[index]
        : reviewedCohort.public_facts[choice.field_name];
      const expectedImmutableEvidence = {
        schema_version: CANDIDATE_EVIDENCE_SCHEMA_VERSION,
        source_id: evidence.source_id,
        capture_text_sha256: evidence.capture_text_sha256,
        capture_text_object_key: evidence.capture_text_object_key,
        evidence_quote_sha256: sha256Text(evidence.evidence_quote),
        verification_method: "exact_local_text_substring",
      };
      if (
        !candidate
        || candidate.candidate_status !== "selected"
        || candidate.field_name !== choice.field_name
        || lowerUuid(candidate.shared_award_source_id) !== evidence.source_id
        || candidate.evidence_quote !== evidence.evidence_quote
        || candidate.evidence_location !== evidence.evidence_location
        || !deepEqual(
          candidate.metadata?.stage1_immutable_evidence,
          expectedImmutableEvidence,
        )
        || !deepEqual(candidate.normalized_value, expectedValue)
      ) {
        fail(`${reviewedCohort.cohort_key}/${choice.field_name}: candidate ${candidateId} does not bind the reviewed public value.`);
      }
    }
  }
}

function validatePersistedReviewRoot({
  reviewedCohort,
  review,
  persistedRoots,
  reviewRootBinding,
}) {
  const matches = persistedRoots.filter((record) =>
    record?.root_sha256 === reviewRootBinding.root_sha256);
  if (matches.length !== 1) {
    fail(`${reviewedCohort.cohort_key}: exact private persisted human-review root is missing or ambiguous.`);
  }
  const record = matches[0];
  if (
    record.schema_version !== "awardping.stage1.human-review-root-retrieval.v1"
    || record.recomputed_sha256 !== reviewRootBinding.root_sha256
    || record.hash_matches !== true
    || record.cohort_key !== reviewedCohort.cohort_key
    || lowerUuid(record.canonical_shared_award_id) !== reviewedCohort.canonical_award.id
    || !sameInstant(record.reviewed_at, review.reviewed_at)
    || !deepEqual(record.review_root, reviewRootBinding.review_root)
  ) {
    fail(`${reviewedCohort.cohort_key}: private persisted human-review root does not exactly match the supplied reviewed decision.`);
  }
}

function validateReconciliation({
  reviewedCohort,
  database,
  contributorSourceIds,
  reviewSourceIds,
  candidateIds,
  reviewRootSha256,
  asOf,
}) {
  const rows = database.reconciliations.filter(
    (row) => lowerUuid(row.shared_award_id) === reviewedCohort.canonical_award.id,
  );
  const latest = latestByCreatedAt(rows);
  const metadata = isPlainObject(latest?.metadata) ? latest.metadata : {};
  if (
    !latest
    || latest.reason !== "explicit_human_review"
    || latest.status !== "succeeded"
    || cleanText(latest.error)
    || !isFresh(latest.completed_at, asOf)
    || !deepEqual(normalizeUuidArray(latest.source_ids, "database reconciliation source_ids"), contributorSourceIds)
    || !deepEqual(normalizeUuidArray(latest.candidate_ids, "database reconciliation candidate_ids"), candidateIds)
    || metadata.processor !== "reconcile-reviewed-stage1-selection"
    || metadata.selection_mode !== "explicit_human_review"
    || metadata.stage1_review_root_schema_version !== STAGE1_HUMAN_REVIEW_ROOT_SCHEMA_VERSION
    || metadata.stage1_review_root_sha256 !== reviewRootSha256
    || metadata.selection_sha256 !== reviewRootSha256
    || !deepEqual(normalizeUuidArray(metadata.review_source_ids, "reconciliation review_source_ids"), reviewSourceIds)
    || !deepEqual(normalizeUuidArray(metadata.reviewed_contributor_source_ids, "reconciliation contributor source_ids"), contributorSourceIds)
    || !deepEqual(normalizeUuidArray(metadata.reviewed_candidate_ids, "reconciliation reviewed_candidate_ids"), candidateIds)
    || Number(metadata.paid_api_calls) !== 0
    || Number(metadata.ranked_candidates_accepted) !== 0
    || Number(metadata.monitoring_sources_retired) !== 0
  ) {
    fail(`${reviewedCohort.cohort_key}: latest reconciliation is not a fresh exact success for this persisted human-review root.`);
  }
  return latest;
}

function validatePageAudit({
  reviewedCohort,
  database,
  memberIds,
  canonicalAward,
  reviewRootSha256,
  asOf,
}) {
  const canonicalAudits = database.page_audits.filter((row) =>
    lowerUuid(row.shared_award_id) === reviewedCohort.canonical_award.id
    && row.audit_kind === "deterministic");
  const latest = latestByCreatedAt(canonicalAudits);
  const snapshot = isPlainObject(latest?.public_page_snapshot)
    ? latest.public_page_snapshot
    : {};
  const summary = isPlainObject(latest?.selected_fact_summary)
    ? latest.selected_fact_summary
    : {};
  const publicSnapshot = omitKeys(snapshot, AUDIT_PROOF_KEYS);
  // The commit RPC's audit contract stores the field->candidate map alongside
  // the root binding and four stage1_reviewed_* projection hashes; strip the
  // whole projection before comparing the field map.
  const fieldSummary = omitKeys(summary, [
    "stage1_review_root_schema_version",
    "stage1_review_root_sha256",
    "stage1_reviewed_public_facts_sha256",
    "stage1_reviewed_summary_sha256",
    "stage1_reviewed_confidence_sha256",
    "stage1_reviewed_evidence_rows_sha256",
  ]);
  const expectedFieldSummary = Object.fromEntries(reviewedCohort.field_choices.map(
    (choice) => [choice.field_name, choice.candidate_ids],
  ));
  const canonicalFacts = publishedFactProjection(canonicalAward?.public_facts);
  if (
    !latest
    || latest.audit_status !== "passed"
    || new Set(["error", "critical"]).has(latest.severity)
    || latest.model !== "explicit-human-reviewed-stage1-reconciliation"
    || !isFresh(latest.created_at, asOf)
    // The commit RPC binds the review root inside selected_fact_summary (checked
    // below) and enriches public_page_snapshot only with the reconciliation
    // signature — the snapshot itself never carries the root keys.
    || !SHA256_PATTERN.test(cleanText(snapshot.reconciliation_audit_signature))
    || summary.stage1_review_root_schema_version !== STAGE1_HUMAN_REVIEW_ROOT_SCHEMA_VERSION
    || summary.stage1_review_root_sha256 !== reviewRootSha256
    || !deepEqual(fieldSummary, expectedFieldSummary)
    || !deepEqual(publicSnapshot, reviewedCohort.public_facts)
    || !deepEqual(canonicalFacts, reviewedCohort.public_facts)
  ) {
    fail(`${reviewedCohort.cohort_key}: latest deterministic page audit is not a fresh exact proof for this persisted human-review root.`);
  }
  const blocking = database.page_audits.filter((row) =>
    memberIds.has(lowerUuid(row.shared_award_id))
    && !row.resolved_at
    && (new Set(["failed", "needs_review"]).has(row.audit_status)
      || row.severity === "critical"));
  if (blocking.length) {
    fail(`${reviewedCohort.cohort_key}: unresolved blocking page-audit records remain in the cohort.`);
  }
  return latest;
}

function publishedFactProjection(publicFacts) {
  const facts = isPlainObject(publicFacts) ? publicFacts : {};
  return Object.fromEntries(PUBLISHED_FACT_FIELDS
    .filter((field) => !isEmptyJson(facts[field]))
    .map((field) => [field, facts[field]]));
}

function omitKeys(value, keys) {
  const omitted = new Set(keys);
  return Object.fromEntries(Object.entries(value).filter(([key]) => !omitted.has(key)));
}

function normalizeUuidArray(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array.`);
  const values = value.map((entry) => requireUuid(entry, label)).toSorted();
  if (new Set(values).size !== values.length) fail(`${label} contains duplicate UUIDs.`);
  return values;
}

function requireUuid(value, label) {
  const uuid = lowerUuid(value);
  if (!UUID_PATTERN.test(uuid)) fail(`${label} must be a valid UUID.`);
  return uuid;
}

function isHttps(value) {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function isFresh(value, now) {
  const time = Date.parse(value);
  return Number.isFinite(time)
    && time >= now.getTime() - STAGE1_FRESHNESS_MS
    && time <= now.getTime() + FUTURE_SKEW_MS;
}

function sameInstant(left, right) {
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  return Number.isFinite(leftTime) && leftTime === rightTime;
}

function oldestTimestamp(values) {
  const times = values.map((value) => Date.parse(value));
  if (!times.length || times.some((value) => !Number.isFinite(value))) {
    fail("Cannot derive a deterministic evidence timestamp from invalid values.");
  }
  return new Date(Math.min(...times)).toISOString();
}

function latestByCreatedAt(rows) {
  return [...rows].sort((left, right) =>
    Date.parse(right.created_at) - Date.parse(left.created_at)
      || String(right.id).localeCompare(String(left.id)))[0] || null;
}

function uniqueBy(rows, keyFor, label) {
  const result = new Map();
  for (const row of rows) {
    const key = keyFor(row);
    if (!key) fail(`${label} is missing.`);
    if (result.has(key)) fail(`Duplicate ${label}: ${key}.`);
    result.set(key, row);
  }
  return result;
}

function compareRows(...fields) {
  return (left, right) => {
    for (const field of fields) {
      const comparison = String(left?.[field] ?? "").localeCompare(
        String(right?.[field] ?? ""),
      );
      if (comparison) return comparison;
    }
    return 0;
  };
}

function sha256Canonical(value) {
  return createHash("sha256").update(stableStage1ManifestJson(value), "utf8").digest("hex");
}

function sha256Text(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).toSorted().map((key) => [key, stableValue(value[key])]));
  }
  return value ?? null;
}

function deepEqual(left, right) {
  return stableStage1ManifestJson(left) === stableStage1ManifestJson(right);
}

function isEmptyJson(value) {
  if (value == null || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value).length === 0;
  return false;
}

function requirePlainObject(value, label) {
  if (!isPlainObject(value)) fail(`${label} must be an object.`);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function lowerUuid(value) {
  return cleanText(value).toLowerCase();
}

function validDate(value, label) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) fail(`${label} is invalid.`);
  return date;
}

function fail(message) {
  throw new Error(`Stage 1 manifest draft blocked: ${message}`);
}
