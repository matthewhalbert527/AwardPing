import { createHash } from "node:crypto";
import {
  PUBLISHED_FACT_FIELDS,
  STAGE1_COHORT_DEFINITION,
  STAGE1_FRESHNESS_MS,
  STAGE1_POLICY_VERSION,
  sourceIdentityDisposition,
} from "./stage1-cohort-readiness.mjs";
import {
  normalizeStage1OfficialIdentity,
  validateStage1ImmutableCaptureBinding,
} from "./stage1-human-review-root.mjs";

export const STAGE1_CANDIDATE_IMPORT_SCHEMA_VERSION =
  "awardping.stage1.reviewed-candidate-import.v1";
export const STAGE1_CANDIDATE_IMPORT_ITEM_SCHEMA_VERSION =
  "awardping.stage1.reviewed-candidate-import-item.v1";
export const STAGE1_CANDIDATE_IMPORT_BINDING_SCHEMA_VERSION =
  "awardping.stage1.reviewed-candidate-import-binding.v1";
export const STAGE1_CANDIDATE_IMPORT_CONFIRMATION_SCHEMA_VERSION =
  "awardping.stage1.reviewed-candidate-import-confirmation.v1";
export const STAGE1_CANDIDATE_IMPORT_RECEIPT_SCHEMA_VERSION =
  "awardping.stage1.reviewed-candidate-import-apply-receipt.v1";
export const STAGE1_CANDIDATE_EVIDENCE_SCHEMA_VERSION =
  "awardping.stage1.candidate-immutable-evidence.v1";

const FUTURE_SKEW_MS = 5 * 60 * 1_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SOURCE_RELEVANCE = new Set(["primary", "supporting"]);
const EVIDENCE_LOCATION_PATTERN = /^immutable_text_chars:(0|[1-9][0-9]*)-(0|[1-9][0-9]*)$/;

export function normalizeStage1CandidateImportBundle(bundle, now = new Date()) {
  const asOf = validDate(now, "candidate import as-of time");
  requireExactKeys(
    bundle,
    ["schema_version", "policy_version", "review", "cohort", "sources", "items"],
    "candidate import bundle",
  );
  if (bundle.schema_version !== STAGE1_CANDIDATE_IMPORT_SCHEMA_VERSION) {
    fail(`schema_version must be ${STAGE1_CANDIDATE_IMPORT_SCHEMA_VERSION}.`);
  }
  if (cleanText(bundle.policy_version) !== STAGE1_POLICY_VERSION) {
    fail(`policy_version must be ${STAGE1_POLICY_VERSION}.`);
  }
  requireExactKeys(
    bundle.review,
    ["reviewed_by", "reviewed_at", "reason", "selection_method", "paid_api_calls"],
    "candidate import review",
  );
  if (bundle.review.selection_method !== "explicit_human_review") {
    fail("selection_method must be explicit_human_review.");
  }
  if (bundle.review.paid_api_calls !== 0) fail("paid_api_calls must be zero.");
  const review = {
    reviewed_by: requireText(bundle.review.reviewed_by, "reviewed_by"),
    reviewed_at: requireFreshTimestamp(bundle.review.reviewed_at, asOf, "reviewed_at"),
    reason: requireText(bundle.review.reason, "review reason"),
    selection_method: "explicit_human_review",
    paid_api_calls: 0,
  };

  requireExactKeys(
    bundle.cohort,
    ["cohort_key", "canonical_award"],
    "candidate import cohort",
  );
  const cohortKey = requireText(bundle.cohort.cohort_key, "cohort_key");
  const definition = STAGE1_COHORT_DEFINITION.find((entry) => entry.cohortKey === cohortKey);
  if (!definition) fail(`unknown Stage 1 cohort key ${cohortKey}.`);
  requireExactKeys(
    bundle.cohort.canonical_award,
    ["id", "search_key", "name", "official_homepage"],
    "canonical_award",
  );
  const canonicalAward = {
    id: requireUuid(bundle.cohort.canonical_award.id, "canonical award ID"),
    search_key: requireText(bundle.cohort.canonical_award.search_key, "canonical search key"),
    name: requireText(bundle.cohort.canonical_award.name, "canonical award name"),
    official_homepage: requireHttps(
      bundle.cohort.canonical_award.official_homepage,
      "canonical homepage",
    ),
  };
  if (
    canonicalAward.search_key !== definition.canonicalSearchKey
    || canonicalAward.name !== definition.canonicalName
    || canonicalAward.official_homepage !== definition.officialHomepage
  ) fail(`${cohortKey}: canonical identity differs from the exact Stage 1 definition.`);

  if (!Array.isArray(bundle.sources) || !bundle.sources.length) {
    fail("sources must contain at least one exact reviewed source binding.");
  }
  const sources = bundle.sources.map((raw) => normalizeSource(
    raw,
    canonicalAward,
    review.reviewed_at,
    asOf,
  )).toSorted((left, right) => left.source_id.localeCompare(right.source_id));
  if (new Set(sources.map((source) => source.source_id)).size !== sources.length) {
    fail("sources contain duplicate source IDs.");
  }
  const sourceById = new Map(sources.map((source) => [source.source_id, source]));

  if (!Array.isArray(bundle.items) || !bundle.items.length || bundle.items.length > 500) {
    fail("items must contain between 1 and 500 explicit reviewed facts.");
  }
  const items = bundle.items.map((raw) => normalizeItem(raw, sourceById))
    .toSorted((left, right) => left.item_key.localeCompare(right.item_key));
  if (new Set(items.map((item) => item.item_key)).size !== items.length) {
    fail("items contain duplicate item_key values.");
  }
  const usedSourceIds = [...new Set(items.map((item) => item.source_id))].toSorted();
  if (!deepEqual(usedSourceIds, sources.map((source) => source.source_id))) {
    fail("sources must exactly equal the sources used by reviewed items.");
  }

  return {
    schema_version: STAGE1_CANDIDATE_IMPORT_SCHEMA_VERSION,
    policy_version: STAGE1_POLICY_VERSION,
    review,
    cohort: {
      cohort_key: cohortKey,
      canonical_award: canonicalAward,
    },
    sources,
    items,
  };
}

export function stage1CandidateImportScope(bundle, now = new Date()) {
  const normalized = normalizeStage1CandidateImportBundle(bundle, now);
  return {
    cohort_key: normalized.cohort.cohort_key,
    canonical_award_id: normalized.cohort.canonical_award.id,
    source_ids: normalized.sources.map((source) => source.source_id),
  };
}

export function buildStage1CandidateImportPlan({
  bundle,
  database,
  localEvidence,
  now = new Date(),
}) {
  const asOf = validDate(now, "candidate import as-of time");
  const normalized = normalizeStage1CandidateImportBundle(bundle, asOf);
  const normalizedDatabase = normalizeDatabase(database);
  const bundleSha256 = sha256Canonical(normalized);
  const definition = STAGE1_COHORT_DEFINITION.find(
    (entry) => entry.cohortKey === normalized.cohort.cohort_key,
  );
  const registry = onlyRow(normalizedDatabase.registry, "Stage 1 registry");
  const award = onlyRow(normalizedDatabase.awards, "canonical award");
  if (
    registry.cohort_key !== normalized.cohort.cohort_key
    || Number(registry.launch_rank) !== definition.launchRank
    || registry.canonical_name !== definition.canonicalName
    || lowerUuid(registry.canonical_shared_award_id) !== normalized.cohort.canonical_award.id
    || registry.official_homepage !== definition.officialHomepage
    || registry.policy_version !== STAGE1_POLICY_VERSION
    || lowerUuid(award.id) !== normalized.cohort.canonical_award.id
    || award.status !== "active"
    || award.search_key !== definition.canonicalSearchKey
    || award.name !== definition.canonicalName
    || award.official_homepage !== definition.officialHomepage
    || !validTimestamp(award.updated_at)
  ) fail("canonical registry or award identity changed after review.");
  const memberIds = new Set(normalizedDatabase.members
    .filter((row) => row.cohort_key === normalized.cohort.cohort_key)
    .map((row) => lowerUuid(row.shared_award_id)));
  if (!memberIds.has(normalized.cohort.canonical_award.id)) {
    fail("canonical award is not an exact member of the reviewed cohort.");
  }
  const sourceById = exactMap(
    normalizedDatabase.sources,
    normalized.sources.map((source) => source.source_id),
    (row) => lowerUuid(row.id),
    "reviewed source",
  );
  const snapshotBySourceId = exactMap(
    normalizedDatabase.visual_snapshots,
    normalized.sources.map((source) => source.source_id),
    (row) => lowerUuid(row.shared_award_source_id),
    "reviewed source snapshot",
  );
  const rules = normalizedDatabase.identity_rules.filter(
    (row) => row.cohort_key === normalized.cohort.cohort_key,
  );
  const localBySourceId = normalizeLocalEvidence(localEvidence);
  const sourceBindings = normalized.sources.map((reviewedSource) => {
    const source = sourceById.get(reviewedSource.source_id);
    const snapshot = snapshotBySourceId.get(reviewedSource.source_id);
    const identity = sourceIdentityDisposition(source, rules);
    const immutableCapture = validateStage1ImmutableCaptureBinding({
      sourceId: reviewedSource.source_id,
      kind: snapshot.kind,
      objectKeys: snapshot.latest_object_keys,
      hashes: snapshot.latest_hashes,
      metadata: snapshot.latest_metadata,
    });
    const local = localBySourceId.get(reviewedSource.source_id);
    if (
      !memberIds.has(lowerUuid(source.shared_award_id))
      || source.url !== reviewedSource.source_url
      || source.admin_review_status !== "open"
      || cleanText(source.last_error)
      || !isHttps(source.url)
      || !isFresh(source.last_checked_at, asOf)
      || !sameInstant(source.last_checked_at, reviewedSource.last_checked_at)
      || !sameInstant(source.updated_at, reviewedSource.source_updated_at)
      || identity.excluded
      || identity.invalid_rules.length
      || lowerUuid(snapshot.shared_award_id) !== lowerUuid(source.shared_award_id)
      || snapshot.source_url !== source.url
      || !sameInstant(snapshot.updated_at, reviewedSource.snapshot_updated_at)
      || !sameInstant(snapshot.latest_captured_at, reviewedSource.captured_at)
      || immutableCapture.hashes.text_hash !== reviewedSource.capture_text_sha256
      || immutableCapture.object_keys.text !== reviewedSource.capture_text_object_key
      || !local
      || local.capture_text_sha256 !== reviewedSource.capture_text_sha256
      || local.capture_text_object_key !== reviewedSource.capture_text_object_key
      || local.semantic_text_sha256 !== reviewedSource.capture_text_sha256
      || sha256Text(local.semantic_text) !== local.semantic_text_sha256
      || local.semantic_text.length !== Number(local.text_length)
      || Number(local.raw_bytes) !== Number(immutableCapture.metadata.text_object_bytes)
      || Number(local.text_length) !== Number(immutableCapture.metadata.text_length)
      || asOf.getTime() < Date.parse(reviewedSource.captured_at)
    ) fail(`source ${reviewedSource.source_id} or its exact local immutable text changed.`);
    return {
      source_id: reviewedSource.source_id,
      shared_award_id: lowerUuid(source.shared_award_id),
      source_url: source.url,
      source_title: source.display_title || source.title || null,
      source_updated_at: canonicalTimestamp(source.updated_at),
      last_checked_at: canonicalTimestamp(source.last_checked_at),
      snapshot_updated_at: canonicalTimestamp(snapshot.updated_at),
      captured_at: canonicalTimestamp(snapshot.latest_captured_at),
      capture_text_sha256: reviewedSource.capture_text_sha256,
      capture_text_object_key: reviewedSource.capture_text_object_key,
      official_identity: reviewedSource.official_identity,
      local_verified_at: asOf.toISOString(),
    };
  });
  const bindingBySourceId = new Map(sourceBindings.map((source) => [source.source_id, source]));
  const candidateRows = normalized.items.map((item) => {
    const source = bindingBySourceId.get(item.source_id);
    const local = localBySourceId.get(item.source_id);
    const location = parseEvidenceLocation(item.evidence_location);
    if (
      location.end <= location.start
      || location.end > local.semantic_text.length
      || local.semantic_text.slice(location.start, location.end) !== item.evidence_quote
    ) fail(`${item.item_key}: evidence quote does not exactly match its reviewed immutable-text range.`);
    const identity = {
      schema_version: STAGE1_CANDIDATE_IMPORT_ITEM_SCHEMA_VERSION,
      policy_version: STAGE1_POLICY_VERSION,
      canonical_shared_award_id: normalized.cohort.canonical_award.id,
      source_id: item.source_id,
      source_url: source.source_url,
      source_relevance: item.source_relevance,
      field_name: item.field_name,
      normalized_value: item.normalized_value,
      evidence_quote: item.evidence_quote,
      evidence_location: item.evidence_location,
      capture_text_sha256: source.capture_text_sha256,
      capture_text_object_key: source.capture_text_object_key,
    };
    const itemSha256 = sha256Canonical(identity);
    const candidateId = uuidFromHash(itemSha256);
    return {
      id: candidateId,
      // Retain the source-owning cohort member (canonical or alias). The
      // immutable import identity and publication target remain separately
      // bound to the canonical award in `identity` and the private ledger.
      shared_award_id: source.shared_award_id,
      shared_award_source_id: item.source_id,
      source_url: source.source_url,
      source_title: source.source_title,
      source_role: item.source_relevance,
      source_quality_decision: {
        decision: "approved",
        purpose: "stage1_reviewed_candidate_import",
        official_identity: source.official_identity,
      },
      field_name: item.field_name,
      raw_value: typeof item.normalized_value === "string"
        ? item.normalized_value
        : stableStage1CandidateImportJson(item.normalized_value),
      normalized_value: item.normalized_value,
      evidence_quote: item.evidence_quote,
      evidence_location: item.evidence_location,
      extracted_at: normalized.review.reviewed_at,
      model: "explicit-human-stage1-candidate-import",
      confidence: "human_reviewed",
      candidate_status: "pending",
      rejection_reason: null,
      selected_reason: null,
      source_page_request_id: null,
      intake_value_sha256: null,
      metadata: {
        stage1_immutable_evidence: {
          schema_version: STAGE1_CANDIDATE_EVIDENCE_SCHEMA_VERSION,
          source_id: item.source_id,
          capture_text_sha256: source.capture_text_sha256,
          capture_text_object_key: source.capture_text_object_key,
          evidence_quote_sha256: sha256Text(item.evidence_quote),
          verification_method: "exact_local_text_substring",
        },
        stage1_candidate_import: {
          schema_version: STAGE1_CANDIDATE_IMPORT_ITEM_SCHEMA_VERSION,
          bundle_sha256: bundleSha256,
          item_sha256: itemSha256,
          item_key: item.item_key,
          reviewed_by: normalized.review.reviewed_by,
          reviewed_at: normalized.review.reviewed_at,
          review_reason: normalized.review.reason,
          paid_api_calls: 0,
        },
      },
    };
  });
  if (new Set(candidateRows.map((row) => row.id)).size !== candidateRows.length) {
    fail("reviewed item identities collide; item keys or evidence are not distinct.");
  }

  const databaseSnapshotSha256 = sha256Canonical(normalizedDatabase);
  const candidatesSha256 = sha256Canonical(candidateRows);
  const confirmationPayload = {
    schema_version: STAGE1_CANDIDATE_IMPORT_CONFIRMATION_SCHEMA_VERSION,
    operation: "apply_reviewed_stage1_candidate_import",
    cohort_key: normalized.cohort.cohort_key,
    canonical_shared_award_id: normalized.cohort.canonical_award.id,
    policy_version: STAGE1_POLICY_VERSION,
    bundle_sha256: bundleSha256,
    database_snapshot_sha256: databaseSnapshotSha256,
    candidates_sha256: candidatesSha256,
    candidate_ids: candidateRows.map((row) => row.id).toSorted(),
    candidate_count: candidateRows.length,
    reviewed_by: normalized.review.reviewed_by,
    reviewed_at: normalized.review.reviewed_at,
    paid_api_calls: 0,
  };
  const confirmationSha256 = sha256Canonical(confirmationPayload);
  const importBinding = {
    schema_version: STAGE1_CANDIDATE_IMPORT_BINDING_SCHEMA_VERSION,
    policy_version: STAGE1_POLICY_VERSION,
    bundle_sha256: bundleSha256,
    review_bundle: normalized,
    award: {
      id: lowerUuid(award.id),
      updated_at: canonicalTimestamp(award.updated_at),
    },
    source_bindings: sourceBindings,
    candidates: candidateRows,
    confirmation_payload: confirmationPayload,
    confirmation_sha256: confirmationSha256,
  };
  return {
    schema_version: STAGE1_CANDIDATE_IMPORT_CONFIRMATION_SCHEMA_VERSION,
    bundle: normalized,
    bundle_sha256: bundleSha256,
    source_bindings: sourceBindings,
    candidate_rows: candidateRows,
    confirmation_payload: confirmationPayload,
    confirmation_sha256: confirmationSha256,
    confirmation_phrase: `CONFIRM STAGE1 CANDIDATE IMPORT ${confirmationSha256}`,
    import_binding: importBinding,
    safety: {
      explicit_human_review: true,
      exact_local_text_substring_verifications: candidateRows.length,
      paid_api_calls: 0,
      preview_remote_mutations: 0,
      source_mutations: 0,
      release_mutations: 0,
      reconciliation_mutations: 0,
      publication_mutations: 0,
    },
  };
}

export function stage1CandidateImportRpcArgs(plan) {
  requirePlainObject(plan?.import_binding, "candidate import binding");
  return {
    p_import_binding: plan.import_binding,
    p_confirmation_sha256: requireSha256(
      plan.confirmation_sha256,
      "candidate import confirmation SHA-256",
    ),
  };
}

export function validateStage1CandidateImportApplyProof(data, plan) {
  requireExactKeys(
    data,
    [
      "status",
      "bundle_sha256",
      "confirmation_sha256",
      "candidate_count",
      "inserted_count",
      "existing_count",
      "paid_api_calls",
      "source_mutations",
      "release_mutations",
      "reconciliation_mutations",
      "publication_mutations",
    ],
    "candidate import apply proof",
  );
  const candidateCount = requireNonNegativeInteger(
    data.candidate_count,
    "candidate import proof candidate_count",
  );
  const insertedCount = requireNonNegativeInteger(
    data.inserted_count,
    "candidate import proof inserted_count",
  );
  const existingCount = requireNonNegativeInteger(
    data.existing_count,
    "candidate import proof existing_count",
  );
  const expectedCount = Array.isArray(plan?.candidate_rows)
    ? plan.candidate_rows.length
    : -1;
  if (
    data.status !== "succeeded"
    || data.bundle_sha256 !== plan?.bundle_sha256
    || data.confirmation_sha256 !== plan?.confirmation_sha256
    || candidateCount !== expectedCount
    || insertedCount + existingCount !== candidateCount
    || [
      data.paid_api_calls,
      data.source_mutations,
      data.release_mutations,
      data.reconciliation_mutations,
      data.publication_mutations,
    ].some((value) => value !== 0)
  ) fail("atomic candidate import returned an unexpected safety proof.");
  return {
    ...data,
    candidate_count: candidateCount,
    inserted_count: insertedCount,
    existing_count: existingCount,
  };
}

export function buildStage1CandidateImportApplyReceipt({
  plan,
  proof,
  appliedAt = new Date(),
}) {
  const verifiedProof = validateStage1CandidateImportApplyProof(proof, plan);
  const timestamp = validDate(appliedAt, "candidate import receipt applied_at").toISOString();
  const candidateIds = (plan?.candidate_rows || []).map((candidate) =>
    requireUuid(candidate.id, "candidate import receipt candidate ID")).toSorted();
  if (candidateIds.length !== verifiedProof.candidate_count) {
    fail("candidate import receipt candidate IDs do not match the atomic proof.");
  }
  return {
    schema_version: STAGE1_CANDIDATE_IMPORT_RECEIPT_SCHEMA_VERSION,
    applied_at: timestamp,
    cohort_key: requireText(
      plan?.bundle?.cohort?.cohort_key,
      "candidate import receipt cohort_key",
    ),
    canonical_shared_award_id: requireUuid(
      plan?.bundle?.cohort?.canonical_award?.id,
      "candidate import receipt canonical award ID",
    ),
    bundle_sha256: verifiedProof.bundle_sha256,
    confirmation_sha256: verifiedProof.confirmation_sha256,
    candidate_ids: candidateIds,
    candidate_count: verifiedProof.candidate_count,
    inserted_count: verifiedProof.inserted_count,
    existing_count: verifiedProof.existing_count,
    safety_attestation: {
      paid_api_calls: 0,
      source_mutations: 0,
      release_mutations: 0,
      reconciliation_mutations: 0,
      publication_mutations: 0,
    },
  };
}

export function stableStage1CandidateImportJson(value) {
  return JSON.stringify(stableValue(value));
}

function normalizeSource(raw, canonicalAward, reviewedAt, asOf) {
  requireExactKeys(
    raw,
    [
      "source_id",
      "source_url",
      "official_identity",
      "source_updated_at",
      "last_checked_at",
      "snapshot_updated_at",
      "captured_at",
      "capture_text_sha256",
      "capture_text_object_key",
    ],
    "candidate import source",
  );
  const sourceId = requireUuid(raw.source_id, "source_id");
  const sourceUrl = requireHttps(raw.source_url, `${sourceId} source_url`);
  const source = {
    source_id: sourceId,
    source_url: sourceUrl,
    official_identity: normalizeStage1OfficialIdentity(
      raw.official_identity,
      sourceUrl,
      canonicalAward.official_homepage,
      `${sourceId} official_identity`,
    ),
    source_updated_at: requireNonFutureTimestamp(
      raw.source_updated_at,
      asOf,
      `${sourceId} source_updated_at`,
    ),
    last_checked_at: requireFreshTimestamp(
      raw.last_checked_at,
      asOf,
      `${sourceId} last_checked_at`,
    ),
    snapshot_updated_at: requireNonFutureTimestamp(
      raw.snapshot_updated_at,
      asOf,
      `${sourceId} snapshot_updated_at`,
    ),
    captured_at: requireNonFutureTimestamp(raw.captured_at, asOf, `${sourceId} captured_at`),
    capture_text_sha256: requireSha256(
      raw.capture_text_sha256,
      `${sourceId} capture_text_sha256`,
    ),
    capture_text_object_key: requireText(
      raw.capture_text_object_key,
      `${sourceId} capture_text_object_key`,
    ),
  };
  if (Date.parse(source.last_checked_at) > Date.parse(reviewedAt)) {
    fail(`${sourceId}: review predates the live source check.`);
  }
  const reviewedWithSkew = Date.parse(reviewedAt) + FUTURE_SKEW_MS;
  if ([
    source.source_updated_at,
    source.snapshot_updated_at,
    source.captured_at,
  ].some((timestamp) => Date.parse(timestamp) > reviewedWithSkew)) {
    fail(`${sourceId}: review predates the exact source or snapshot state that it attests.`);
  }
  const expectedPrefix = `visual-snapshots/sources/${sourceId}/captures/`;
  if (
    !source.capture_text_object_key.startsWith(expectedPrefix)
    || !/\/captures\/[0-9a-f]{32}\/text[.]txt$/.test(source.capture_text_object_key)
  ) fail(`${sourceId}: capture_text_object_key is not one immutable text artifact.`);
  return source;
}

function normalizeItem(raw, sourceById) {
  requireExactKeys(
    raw,
    [
      "item_key",
      "source_id",
      "source_relevance",
      "field_name",
      "normalized_value",
      "evidence_quote",
      "evidence_location",
    ],
    "candidate import item",
  );
  const sourceId = requireUuid(raw.source_id, "item source_id");
  if (!sourceById.has(sourceId)) fail(`item source ${sourceId} is not explicitly reviewed.`);
  const sourceRelevance = requireText(raw.source_relevance, "source_relevance");
  if (!SOURCE_RELEVANCE.has(sourceRelevance)) {
    fail("source_relevance must preserve intake provenance as primary or supporting.");
  }
  const fieldName = requireText(raw.field_name, "field_name");
  if (!PUBLISHED_FACT_FIELDS.includes(fieldName)) {
    fail(`${fieldName}: field_name is not a published Stage 1 fact field.`);
  }
  if (isEmptyJson(raw.normalized_value)) fail(`${fieldName}: normalized_value is empty.`);
  const evidenceLocation = requireText(raw.evidence_location, "evidence_location");
  parseEvidenceLocation(evidenceLocation);
  return {
    item_key: requireItemKey(raw.item_key),
    source_id: sourceId,
    source_relevance: sourceRelevance,
    field_name: fieldName,
    normalized_value: stableValue(raw.normalized_value),
    evidence_quote: requireText(raw.evidence_quote, "evidence_quote"),
    evidence_location: evidenceLocation,
  };
}

function normalizeDatabase(database) {
  requirePlainObject(database, "candidate import database snapshot");
  const fields = [
    "registry",
    "members",
    "identity_rules",
    "awards",
    "sources",
    "visual_snapshots",
  ];
  const normalized = {};
  for (const field of fields) {
    if (!Array.isArray(database[field])) fail(`database ${field} must be an array.`);
    normalized[field] = database[field].map((row) => stableValue(row));
  }
  for (const rows of Object.values(normalized)) {
    rows.sort((left, right) => stableStage1CandidateImportJson(left)
      .localeCompare(stableStage1CandidateImportJson(right)));
  }
  return normalized;
}

function normalizeLocalEvidence(localEvidence) {
  if (!Array.isArray(localEvidence)) fail("localEvidence must be an array.");
  const map = new Map();
  for (const entry of localEvidence) {
    requireExactKeys(
      entry,
      [
        "source_id",
        "path",
        "raw_bytes",
        "semantic_text",
        "semantic_text_sha256",
        "text_length",
        "capture_text_sha256",
        "capture_text_object_key",
      ],
      "local immutable text evidence",
    );
    const sourceId = requireUuid(entry.source_id, "local evidence source_id");
    if (map.has(sourceId)) fail(`duplicate local evidence source ${sourceId}.`);
    map.set(sourceId, {
      source_id: sourceId,
      path: requireText(entry.path, `${sourceId} local path`),
      raw_bytes: requireNonNegativeInteger(entry.raw_bytes, `${sourceId} raw_bytes`),
      semantic_text: String(entry.semantic_text),
      semantic_text_sha256: requireSha256(
        entry.semantic_text_sha256,
        `${sourceId} semantic_text_sha256`,
      ),
      text_length: requireNonNegativeInteger(entry.text_length, `${sourceId} text_length`),
      capture_text_sha256: requireSha256(
        entry.capture_text_sha256,
        `${sourceId} capture_text_sha256`,
      ),
      capture_text_object_key: requireText(
        entry.capture_text_object_key,
        `${sourceId} capture_text_object_key`,
      ),
    });
  }
  return map;
}

function parseEvidenceLocation(value) {
  const match = EVIDENCE_LOCATION_PATTERN.exec(value);
  if (!match) {
    fail("evidence_location must be immutable_text_chars:<start>-<end> with an exclusive end.");
  }
  return { start: Number(match[1]), end: Number(match[2]) };
}

function requireItemKey(value) {
  const key = requireText(value, "item_key");
  if (!/^[a-z0-9][a-z0-9._-]{0,119}$/.test(key)) {
    fail("item_key must be 1-120 lowercase letters, digits, dot, underscore, or hyphen.");
  }
  return key;
}

function exactMap(rows, expectedIds, idFor, label) {
  const map = new Map();
  for (const row of rows) {
    const id = idFor(row);
    if (!id || map.has(id)) fail(`${label} rows are missing or duplicated.`);
    map.set(id, row);
  }
  if (!deepEqual([...map.keys()].toSorted(), [...expectedIds].toSorted())) {
    fail(`${label} rows do not exactly match explicit reviewed IDs.`);
  }
  return map;
}

function onlyRow(rows, label) {
  if (!Array.isArray(rows) || rows.length !== 1) fail(`${label} must contain exactly one row.`);
  return rows[0];
}

function uuidFromHash(hash) {
  const characters = hash.slice(0, 32).split("");
  characters[12] = "4";
  characters[16] = ((Number.parseInt(characters[16], 16) & 3) | 8).toString(16);
  const value = characters.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function sha256Canonical(value) {
  return createHash("sha256").update(stableStage1CandidateImportJson(value), "utf8").digest("hex");
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
  return stableStage1CandidateImportJson(left) === stableStage1CandidateImportJson(right);
}

function isEmptyJson(value) {
  if (value == null || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value).length === 0;
  return false;
}

function requireExactKeys(value, keys, label) {
  requirePlainObject(value, label);
  if (!deepEqual(Object.keys(value).toSorted(), [...keys].toSorted())) {
    fail(`${label} must contain exactly: ${[...keys].toSorted().join(", ")}.`);
  }
}

function requirePlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object.`);
  }
}

function requireText(value, label) {
  const text = cleanText(value);
  if (!text) fail(`${label} is required.`);
  return text;
}

function requireUuid(value, label) {
  const uuid = lowerUuid(value);
  if (!UUID_PATTERN.test(uuid)) fail(`${label} must be a valid UUID.`);
  return uuid;
}

function requireSha256(value, label) {
  const hash = cleanText(value);
  if (!SHA256_PATTERN.test(hash)) fail(`${label} must be lowercase SHA-256.`);
  return hash;
}

function requireHttps(value, label) {
  const text = requireText(value, label);
  if (!isHttps(text)) fail(`${label} must be an HTTPS URL.`);
  return text;
}

function requireNonNegativeInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) fail(`${label} must be a non-negative integer.`);
  return number;
}

function requireFreshTimestamp(value, now, label) {
  const timestamp = requireTimestamp(value, label);
  if (!isFresh(timestamp, now)) fail(`${label} must be within 24 hours and not future-dated.`);
  return timestamp;
}

function requireNonFutureTimestamp(value, now, label) {
  const timestamp = requireTimestamp(value, label);
  if (Date.parse(timestamp) > now.getTime() + FUTURE_SKEW_MS) {
    fail(`${label} must not be future-dated.`);
  }
  return timestamp;
}

function requireTimestamp(value, label) {
  const text = cleanText(value);
  if (!/^\d{4}-\d{2}-\d{2}T.+Z$/.test(text) || !Number.isFinite(Date.parse(text))) {
    fail(`${label} must be an ISO timestamp ending in Z.`);
  }
  return new Date(text).toISOString();
}

function validTimestamp(value) {
  return Number.isFinite(Date.parse(value));
}

function canonicalTimestamp(value) {
  if (!validTimestamp(value)) fail("database timestamp is invalid.");
  return new Date(value).toISOString();
}

function isFresh(value, now) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    && timestamp >= now.getTime() - STAGE1_FRESHNESS_MS
    && timestamp <= now.getTime() + FUTURE_SKEW_MS;
}

function sameInstant(left, right) {
  return Number.isFinite(Date.parse(left)) && Date.parse(left) === Date.parse(right);
}

function isHttps(value) {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
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
  throw new Error(`Stage 1 candidate import blocked: ${message}`);
}
