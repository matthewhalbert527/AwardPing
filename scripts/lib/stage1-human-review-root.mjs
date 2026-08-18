import { createHash } from "node:crypto";
import { buildAwardSummaryFromFacts } from "./award-fact-reconciliation.mjs";
import {
  PUBLISHED_FACT_FIELDS,
  REQUIRED_SOURCE_ROLES,
  STAGE1_COHORT_DEFINITION,
  STAGE1_FRESHNESS_MS,
  STAGE1_POLICY_VERSION,
  validateExactStage1Definition,
} from "./stage1-cohort-readiness.mjs";

export const STAGE1_HUMAN_REVIEW_ROOT_SCHEMA_VERSION =
  "awardping.stage1.human-review-root.v1";

const FUTURE_SKEW_MS = 5 * 60 * 1_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const IMMUTABLE_GENERATION_PATTERN = /^[0-9a-f]{32}$/;
const MANIFEST_STATUSES = new Set(["present", "combined", "not_published"]);
const OFFICIAL_IDENTITY_CLASSES = new Set([
  "canonical_program_host",
  "official_authority_host",
  "official_contractor_host",
]);
const SNAPSHOT_FIXED_SLOTS = Object.freeze({
  page: "page.jpg",
  thumb: "thumb.jpg",
  pdf: "document.pdf",
  text: "text.txt",
  layout: "layout.json",
  meta: "meta.json",
});

export function normalizeStage1HumanReviewRoot(root, now = new Date()) {
  const asOf = validDate(now, "human-review root as-of time");
  requireExactKeys(
    root,
    ["schema_version", "policy_version", "review", "cohorts"],
    "human-review root",
  );
  if (root.schema_version !== STAGE1_HUMAN_REVIEW_ROOT_SCHEMA_VERSION) {
    fail(`schema_version must be ${STAGE1_HUMAN_REVIEW_ROOT_SCHEMA_VERSION}.`);
  }
  if (cleanText(root.policy_version) !== STAGE1_POLICY_VERSION) {
    fail(`policy_version must be ${STAGE1_POLICY_VERSION}.`);
  }
  requireExactKeys(
    root.review,
    [
      "reviewed_by",
      "reviewed_at",
      "reason",
      "selection_method",
      "auto_accept_ranked_candidates",
      "materialize_candidates",
    ],
    "review attestation",
  );
  const reviewedAt = requireFreshTimestamp(root.review.reviewed_at, asOf, "reviewed_at");
  const review = {
    reviewed_by: requireText(root.review.reviewed_by, "reviewed_by"),
    reviewed_at: reviewedAt,
    reason: requireText(root.review.reason, "review reason"),
    selection_method: root.review.selection_method,
    auto_accept_ranked_candidates: root.review.auto_accept_ranked_candidates,
    materialize_candidates: root.review.materialize_candidates,
  };
  if (review.selection_method !== "explicit_human_review") {
    fail("selection_method must be explicit_human_review.");
  }
  if (review.auto_accept_ranked_candidates !== false) {
    fail("auto_accept_ranked_candidates must be false.");
  }
  if (review.materialize_candidates !== false) {
    fail("materialize_candidates must be false.");
  }
  if (!Array.isArray(root.cohorts) || ![1, 25].includes(root.cohorts.length)) {
    fail("cohorts must contain exactly one cohort or the exact national 25.");
  }
  const definitionErrors = validateExactStage1Definition();
  if (definitionErrors.length) fail(`Stage 1 definition is invalid: ${definitionErrors.join(", ")}.`);
  const definitionByKey = new Map(
    STAGE1_COHORT_DEFINITION.map((entry) => [entry.cohortKey, entry]),
  );
  const cohortKeys = root.cohorts.map((entry) => cleanText(entry?.cohort_key));
  if (new Set(cohortKeys).size !== cohortKeys.length) fail("cohort keys must be unique.");
  if (root.cohorts.length === 25) {
    const expected = STAGE1_COHORT_DEFINITION.map((entry) => entry.cohortKey).toSorted();
    if (!deepEqual([...cohortKeys].toSorted(), expected)) {
      fail("the 25-cohort root does not exactly match the national Stage 1 cohort.");
    }
  }

  const cohorts = root.cohorts.map((rawCohort) => {
    requireOneOfExactKeySets(
      rawCohort,
      [
        ["cohort_key", "canonical_award", "public_facts", "field_choices", "roles"],
        [
          "cohort_key",
          "canonical_award",
          "public_facts",
          "publication",
          "field_choices",
          "roles",
        ],
      ],
      "reviewed cohort",
    );
    const cohortKey = requireText(rawCohort.cohort_key, "cohort key");
    const definition = definitionByKey.get(cohortKey);
    if (!definition) fail(`unknown Stage 1 cohort key: ${cohortKey}.`);
    requireExactKeys(
      rawCohort.canonical_award,
      ["id", "search_key", "name", "official_homepage"],
      `${cohortKey} canonical_award`,
    );
    const canonicalAward = {
      id: requireUuid(rawCohort.canonical_award.id, `${cohortKey} canonical award ID`),
      search_key: requireText(rawCohort.canonical_award.search_key, `${cohortKey} search key`),
      name: requireText(rawCohort.canonical_award.name, `${cohortKey} award name`),
      official_homepage: requireHttps(
        rawCohort.canonical_award.official_homepage,
        `${cohortKey} official homepage`,
      ),
    };
    if (
      canonicalAward.search_key !== definition.canonicalSearchKey
      || canonicalAward.name !== definition.canonicalName
      || canonicalAward.official_homepage !== definition.officialHomepage
    ) {
      fail(`${cohortKey}: canonical identity differs from the exact Stage 1 definition.`);
    }
    requirePlainObject(rawCohort.public_facts, `${cohortKey} public_facts`);
    const publicFacts = stableValue(rawCohort.public_facts);
    const unexpectedFactFields = Object.keys(publicFacts)
      .filter((field) => !PUBLISHED_FACT_FIELDS.includes(field));
    if (unexpectedFactFields.length) {
      fail(`${cohortKey}: public_facts contains unsupported fields: ${unexpectedFactFields.join(", ")}.`);
    }
    const publishedFields = PUBLISHED_FACT_FIELDS.filter((field) => !isEmptyJson(publicFacts[field]));
    if (!publishedFields.length) fail(`${cohortKey}: public_facts has no publishable field values.`);
    const fieldChoices = normalizeFieldChoices(
      rawCohort.field_choices,
      publicFacts,
      cohortKey,
    );
    const publication = {
      summary: buildAwardSummaryFromFacts(
        { name: canonicalAward.name },
        publicFacts,
      ),
      confidence: stage1PublicationConfidence(publicFacts.confidence),
    };
    if (rawCohort.publication !== undefined) {
      requireExactKeys(
        rawCohort.publication,
        ["summary", "confidence"],
        `${cohortKey} publication projection`,
      );
      if (!deepEqual(rawCohort.publication, publication)) {
        fail(`${cohortKey}: publication summary/confidence must exactly match the deterministic reviewed-fact projection.`);
      }
    }

    if (!Array.isArray(rawCohort.roles) || rawCohort.roles.length !== REQUIRED_SOURCE_ROLES.length) {
      fail(`${cohortKey}: exactly ${REQUIRED_SOURCE_ROLES.length} source roles are required.`);
    }
    const roleKeys = rawCohort.roles.map((entry) => cleanText(entry?.source_role));
    if (
      new Set(roleKeys).size !== REQUIRED_SOURCE_ROLES.length
      || !deepEqual([...roleKeys].toSorted(), [...REQUIRED_SOURCE_ROLES].toSorted())
    ) {
      fail(`${cohortKey}: each required source role must appear exactly once.`);
    }
    const rolesByKey = new Map(rawCohort.roles.map((entry) => [entry.source_role, entry]));
    const roles = REQUIRED_SOURCE_ROLES.map((role) =>
      normalizeRole(cohortKey, role, rolesByKey.get(role), canonicalAward, asOf));
    const sourceBindingById = new Map();
    for (const source of roles.flatMap((role) => role.sources)) {
      const existing = sourceBindingById.get(source.source_id);
      if (existing && !deepEqual(existing, source)) {
        fail(`${cohortKey}: source ${source.source_id} has conflicting reviewed bindings across roles.`);
      }
      sourceBindingById.set(source.source_id, source);
    }
    const roleCandidateAssignments = roles.flatMap((role) => role.fact_candidate_ids);
    if (new Set(roleCandidateAssignments).size !== roleCandidateAssignments.length) {
      fail(`${cohortKey}: each candidate must be attributed to exactly one reviewed source role.`);
    }
    const roleCandidateIds = [...roleCandidateAssignments].toSorted();
    const fieldCandidateIds = [...new Set(
      fieldChoices.flatMap((choice) => choice.candidate_ids),
    )].toSorted();
    if (!deepEqual(roleCandidateIds, fieldCandidateIds)) {
      fail(`${cohortKey}: role candidate subsets must union exactly to field-choice candidates.`);
    }
    const roleByCandidateId = new Map(roles.flatMap((role) =>
      role.fact_candidate_ids.map((candidateId) => [candidateId, role])));
    for (const choice of fieldChoices) {
      for (const evidence of choice.candidate_evidence) {
        const role = roleByCandidateId.get(evidence.candidate_id);
        const source = role?.sources.find((entry) => entry.source_id === evidence.source_id);
        if (!source) {
          fail(`${cohortKey}/${choice.field_name}: candidate ${evidence.candidate_id} evidence source is outside its exactly attributed role.`);
        }
        if (
          source.snapshot.hashes.text_hash !== evidence.capture_text_sha256
          || source.snapshot.object_keys.text !== evidence.capture_text_object_key
        ) {
          fail(`${cohortKey}/${choice.field_name}: candidate ${evidence.candidate_id} evidence does not bind its exact immutable text snapshot.`);
        }
      }
    }
    const evidenceTimes = roles.flatMap((role) => role.sources.flatMap((source) => [
      source.last_checked_at,
      source.snapshot.captured_at,
      source.r2.verified_at,
      source.local.verified_at,
    ]));
    if (evidenceTimes.some((value) => Date.parse(value) > Date.parse(reviewedAt))) {
      fail(`${cohortKey}: review predates source evidence that it claims to bind.`);
    }
    return {
      cohort_key: cohortKey,
      canonical_award: canonicalAward,
      public_facts: publicFacts,
      publication,
      field_choices: fieldChoices,
      roles,
    };
  }).toSorted((left, right) =>
    definitionByKey.get(left.cohort_key).launchRank
      - definitionByKey.get(right.cohort_key).launchRank);

  return {
    schema_version: STAGE1_HUMAN_REVIEW_ROOT_SCHEMA_VERSION,
    policy_version: STAGE1_POLICY_VERSION,
    review,
    cohorts,
  };
}

export function stage1HumanReviewRootSha256(root, now = new Date()) {
  return createHash("sha256")
    .update(stableStage1HumanReviewJson(normalizeStage1HumanReviewRoot(root, now)), "utf8")
    .digest("hex");
}

export function stage1HumanReviewRootScope(root, now = new Date()) {
  const normalized = normalizeStage1HumanReviewRoot(root, now);
  return {
    cohort_keys: normalized.cohorts.map((entry) => entry.cohort_key),
    canonical_award_ids: normalized.cohorts.map((entry) => entry.canonical_award.id),
    source_ids: [...new Set(normalized.cohorts.flatMap((cohort) =>
      cohort.roles.flatMap((role) => role.sources.map((source) => source.source_id))))].toSorted(),
    candidate_ids: [...new Set(normalized.cohorts.flatMap((cohort) =>
      cohort.field_choices.flatMap((choice) => choice.candidate_ids)))].toSorted(),
  };
}

export function stableStage1HumanReviewJson(value) {
  return JSON.stringify(stableValue(value));
}

export function validateStage1ImmutableObjectKeys({ sourceId, objectKeys }) {
  const normalizedSourceId = requireUuid(sourceId, "immutable object-key source ID");
  requirePlainObject(objectKeys, "immutable object keys");
  const normalized = stableValue(objectKeys);
  const entries = Object.entries(normalized);
  if (!entries.length) fail("immutable object keys must not be empty.");
  const seenKeys = new Set();
  let generation = null;
  const slots = new Set();
  for (const [slot, rawKey] of entries) {
    const fileName = snapshotSlotFileName(slot);
    if (!fileName) fail(`immutable object keys contain unknown slot ${slot}.`);
    if (typeof rawKey !== "string" || !rawKey.trim()) {
      fail(`immutable object key ${slot} must be a non-empty string.`);
    }
    const key = rawKey.trim();
    if (
      key.includes("\\")
      || key.includes("..")
      || key.includes("/latest/")
      || /[\u0000-\u001f]/.test(key)
    ) fail(`immutable object key ${slot} is unsafe or mutable.`);
    if (seenKeys.has(key)) fail("immutable object keys alias multiple slots to one object.");
    seenKeys.add(key);
    const match = /^visual-snapshots\/sources\/([^/]+)\/captures\/([^/]+)\/([^/]+)$/.exec(key);
    if (!match) fail(`immutable object key ${slot} has an invalid generation path.`);
    if (match[1] !== normalizedSourceId) fail(`immutable object key ${slot} belongs to another source.`);
    if (!IMMUTABLE_GENERATION_PATTERN.test(match[2])) {
      fail(`immutable object key ${slot} has an invalid 32-hex generation ID.`);
    }
    if (match[3] !== fileName) {
      fail(`immutable object key ${slot} has the wrong filename; expected ${fileName}.`);
    }
    if (generation && generation !== match[2]) fail("immutable object keys mix 32-hex generation IDs.");
    generation = match[2];
    slots.add(slot);
  }
  const hasPage = slots.has("page");
  const hasPdf = slots.has("pdf");
  if (hasPage === hasPdf) fail("immutable object keys must identify exactly one webpage or PDF core generation.");
  if (hasPage) {
    const missing = ["page", "thumb", "text", "meta"].filter((slot) => !slots.has(slot));
    if (missing.length) fail(`immutable webpage object keys are missing core slots: ${missing.join(", ")}.`);
    for (const slot of slots) {
      const pageMatch = /^expansion_state_(\d{2})$/.exec(slot);
      const layoutMatch = /^expansion_state_(\d{2})_layout$/.exec(slot);
      if (pageMatch && !slots.has(`${slot}_layout`)) {
        fail(`immutable webpage expansion state ${pageMatch[1]} is missing its layout pair.`);
      }
      if (layoutMatch && !slots.has(`expansion_state_${layoutMatch[1]}`)) {
        fail(`immutable webpage expansion state ${layoutMatch[1]} is missing its page pair.`);
      }
    }
  } else {
    const missing = ["pdf", "text", "meta"].filter((slot) => !slots.has(slot));
    if (missing.length) fail(`immutable PDF object keys are missing core slots: ${missing.join(", ")}.`);
    const forbidden = [...slots].filter((slot) =>
      ["page", "thumb", "layout"].includes(slot) || slot.startsWith("expansion_state_"));
    if (forbidden.length) {
      fail(`immutable PDF object keys contain forbidden webpage slots: ${forbidden.join(", ")}.`);
    }
  }
  return {
    object_keys: normalized,
    kind: hasPdf ? "pdf" : "webpage",
    family: "captures",
    generation,
  };
}

export function validateStage1ImmutableCaptureBinding({
  sourceId,
  kind,
  objectKeys,
  hashes,
  metadata,
}) {
  const normalizedKind = requireText(kind, "immutable capture kind");
  if (!new Set(["webpage", "pdf"]).has(normalizedKind)) {
    fail("immutable capture kind must be webpage or pdf.");
  }
  const immutableObjects = validateStage1ImmutableObjectKeys({ sourceId, objectKeys });
  if (immutableObjects.kind !== normalizedKind) {
    fail("immutable capture kind conflicts with its object-key core set.");
  }
  requirePlainObject(hashes, "immutable capture hashes");
  requirePlainObject(metadata, "immutable capture metadata");
  const normalizedHashes = stableValue(hashes);
  const normalizedMetadata = stableValue(metadata);
  if (!positiveIntegerText(normalizedMetadata.text_object_bytes)) {
    fail("immutable capture metadata requires positive text_object_bytes.");
  }
  if (!nonNegativeIntegerText(normalizedMetadata.text_length)) {
    fail("immutable capture metadata requires non-negative text_length.");
  }
  if (normalizedKind === "webpage") {
    if (!lowerSha256(normalizedHashes.image_hash) || !lowerSha256(normalizedHashes.text_hash)) {
      fail("immutable webpage capture requires lowercase image_hash and text_hash SHA-256 values.");
    }
    if (!positiveIntegerText(normalizedMetadata.page_bytes)) {
      fail("immutable webpage capture metadata requires positive page_bytes.");
    }
  } else {
    if (!lowerSha256(normalizedHashes.file_hash) || !lowerSha256(normalizedHashes.text_hash)) {
      fail("immutable PDF capture requires lowercase file_hash and text_hash SHA-256 values.");
    }
    if (!positiveIntegerText(normalizedMetadata.file_bytes)) {
      fail("immutable PDF capture metadata requires positive file_bytes.");
    }
  }
  return {
    ...immutableObjects,
    hashes: normalizedHashes,
    metadata: normalizedMetadata,
  };
}

function normalizeFieldChoices(rawChoices, publicFacts, cohortKey) {
  if (!Array.isArray(rawChoices)) fail(`${cohortKey}: field_choices must be an array.`);
  const fields = rawChoices.map((choice) => cleanText(choice?.field_name));
  if (new Set(fields).size !== fields.length) fail(`${cohortKey}: field choices contain duplicate fields.`);
  const expected = PUBLISHED_FACT_FIELDS.filter((field) => !isEmptyJson(publicFacts[field]));
  if (!deepEqual([...fields].toSorted(), [...expected].toSorted())) {
    fail(`${cohortKey}: field choices must exactly cover non-empty published public facts.`);
  }
  const seenCandidates = new Set();
  const byField = new Map(rawChoices.map((choice) => [choice.field_name, choice]));
  return expected.map((fieldName) => {
    const raw = byField.get(fieldName);
    requireExactKeys(
      raw,
      ["field_name", "candidate_ids", "composition_method", "candidate_evidence"],
      `${cohortKey}/${fieldName} field choice`,
    );
    const compositionMethod = requireText(
      raw.composition_method,
      `${cohortKey}/${fieldName} composition_method`,
    );
    if (!["direct_exact", "ordered_array_items"].includes(compositionMethod)) {
      fail(`${cohortKey}/${fieldName}: composition_method is unsupported.`);
    }
    if (compositionMethod === "ordered_array_items" && !Array.isArray(publicFacts[fieldName])) {
      fail(`${cohortKey}/${fieldName}: ordered_array_items requires an array public value.`);
    }
    const candidateIds = compositionMethod === "ordered_array_items"
      ? normalizeUuidArrayInOrder(raw.candidate_ids, `${cohortKey}/${fieldName} candidates`)
      : normalizeUuidArray(raw.candidate_ids, `${cohortKey}/${fieldName} candidates`);
    if (!candidateIds.length) fail(`${cohortKey}/${fieldName}: at least one candidate is required.`);
    if (compositionMethod === "direct_exact" && candidateIds.length !== 1) {
      fail(`${cohortKey}/${fieldName}: direct_exact requires exactly one candidate.`);
    }
    if (
      compositionMethod === "ordered_array_items"
      && candidateIds.length !== publicFacts[fieldName].length
    ) {
      fail(`${cohortKey}/${fieldName}: ordered candidate count must exactly match the public array length.`);
    }
    const candidateEvidence = normalizeCandidateEvidence(
      raw.candidate_evidence,
      candidateIds,
      cohortKey,
      fieldName,
    );
    for (const candidateId of candidateIds) {
      if (seenCandidates.has(candidateId)) fail(`${cohortKey}: candidate ${candidateId} is assigned to multiple fields.`);
      seenCandidates.add(candidateId);
    }
    return {
      field_name: fieldName,
      composition_method: compositionMethod,
      candidate_ids: candidateIds,
      candidate_evidence: candidateEvidence,
    };
  });
}

function normalizeCandidateEvidence(rawEvidence, candidateIds, cohortKey, fieldName) {
  if (!Array.isArray(rawEvidence) || rawEvidence.length !== candidateIds.length) {
    fail(`${cohortKey}/${fieldName}: candidate_evidence must align 1:1 with candidate_ids.`);
  }
  const byCandidateId = new Map();
  for (const raw of rawEvidence) {
    requireExactKeys(
      raw,
      [
        "candidate_id",
        "source_id",
        "evidence_quote",
        "evidence_location",
        "capture_text_sha256",
        "capture_text_object_key",
      ],
      `${cohortKey}/${fieldName} candidate evidence`,
    );
    const candidateId = requireUuid(
      raw.candidate_id,
      `${cohortKey}/${fieldName} evidence candidate_id`,
    );
    if (byCandidateId.has(candidateId)) {
      fail(`${cohortKey}/${fieldName}: candidate_evidence contains duplicate candidate IDs.`);
    }
    const captureTextSha256 = requireText(
      raw.capture_text_sha256,
      `${cohortKey}/${fieldName}/${candidateId} capture_text_sha256`,
    );
    if (!lowerSha256(captureTextSha256)) {
      fail(`${cohortKey}/${fieldName}/${candidateId}: capture_text_sha256 must be lowercase SHA-256.`);
    }
    byCandidateId.set(candidateId, {
      candidate_id: candidateId,
      source_id: requireUuid(
        raw.source_id,
        `${cohortKey}/${fieldName}/${candidateId} source_id`,
      ),
      evidence_quote: requireText(
        raw.evidence_quote,
        `${cohortKey}/${fieldName}/${candidateId} evidence_quote`,
      ),
      evidence_location: requireText(
        raw.evidence_location,
        `${cohortKey}/${fieldName}/${candidateId} evidence_location`,
      ),
      capture_text_sha256: captureTextSha256,
      capture_text_object_key: requireText(
        raw.capture_text_object_key,
        `${cohortKey}/${fieldName}/${candidateId} capture_text_object_key`,
      ),
    });
  }
  if (!deepEqual([...byCandidateId.keys()].toSorted(), [...candidateIds].toSorted())) {
    fail(`${cohortKey}/${fieldName}: candidate_evidence IDs must exactly match candidate_ids.`);
  }
  return candidateIds.map((candidateId) => byCandidateId.get(candidateId));
}

function normalizeRole(cohortKey, role, rawRole, canonicalAward, asOf) {
  requireExactKeys(
    rawRole,
    [
      "source_role",
      "manifest_status",
      "official",
      "supporting_text",
      "cycle",
      "sources",
      "fact_candidate_ids",
    ],
    `${cohortKey}/${role}`,
  );
  const status = cleanText(rawRole.manifest_status);
  if (!MANIFEST_STATUSES.has(status)) {
    fail(`${cohortKey}/${role}: manifest_status must be present, combined, or not_published.`);
  }
  if (rawRole.official !== true) fail(`${cohortKey}/${role}: official must be true.`);
  if (!Array.isArray(rawRole.sources) || !rawRole.sources.length) {
    fail(`${cohortKey}/${role}: at least one explicit official source is required.`);
  }
  const sources = rawRole.sources.map((rawSource) => {
    requireExactKeys(
      rawSource,
      [
        "source_id",
        "source_url",
        "official_identity",
        "last_checked_at",
        "snapshot",
        "r2",
        "local",
      ],
      `${cohortKey}/${role} source`,
    );
    const sourceId = requireUuid(rawSource.source_id, `${cohortKey}/${role} source ID`);
    const sourceUrl = requireHttps(rawSource.source_url, `${cohortKey}/${role}/${sourceId} URL`);
    requireOneOfExactKeySets(
      rawSource.snapshot,
      [
        ["captured_at", "object_keys", "hashes", "metadata"],
        ["captured_at", "object_keys", "kind", "hashes", "metadata"],
      ],
      `${cohortKey}/${role}/${sourceId} snapshot`,
    );
    requireExactKeys(
      rawSource.r2,
      ["verified_at", "hashes"],
      `${cohortKey}/${role}/${sourceId} R2 verification`,
    );
    requireExactKeys(
      rawSource.local,
      ["verified_at", "hashes"],
      `${cohortKey}/${role}/${sourceId} local verification`,
    );
    const objectSet = validateStage1ImmutableObjectKeys({
      sourceId,
      objectKeys: rawSource.snapshot.object_keys,
    });
    if (
      rawSource.snapshot.kind !== undefined
      && rawSource.snapshot.kind !== objectSet.kind
    ) {
      fail(`${cohortKey}/${role}/${sourceId} snapshot kind conflicts with its immutable object keys.`);
    }
    const snapshot = validateStage1ImmutableCaptureBinding({
      sourceId,
      kind: objectSet.kind,
      objectKeys: objectSet.object_keys,
      hashes: requireHashes(rawSource.snapshot.hashes, `${cohortKey}/${role}/${sourceId} hashes`),
      metadata: rawSource.snapshot.metadata,
    });
    const normalizedSnapshot = {
      captured_at: requireNonFutureTimestamp(
        rawSource.snapshot.captured_at,
        asOf,
        `${cohortKey}/${role}/${sourceId} captured_at`,
      ),
      object_keys: snapshot.object_keys,
      kind: snapshot.kind,
      hashes: snapshot.hashes,
      metadata: snapshot.metadata,
    };
    return {
      source_id: sourceId,
      source_url: sourceUrl,
      official_identity: normalizeStage1OfficialIdentity(
        rawSource.official_identity,
        sourceUrl,
        canonicalAward.official_homepage,
        `${cohortKey}/${role}/${sourceId} official_identity`,
      ),
      last_checked_at: requireFreshTimestamp(
        rawSource.last_checked_at,
        asOf,
        `${cohortKey}/${role}/${sourceId} last_checked_at`,
      ),
      snapshot: normalizedSnapshot,
      r2: normalizeVerification(rawSource.r2, normalizedSnapshot, asOf,
        `${cohortKey}/${role}/${sourceId} R2`),
      local: normalizeVerification(rawSource.local, normalizedSnapshot, asOf,
        `${cohortKey}/${role}/${sourceId} local`),
    };
  }).toSorted((left, right) => left.source_id.localeCompare(right.source_id));
  if (new Set(sources.map((source) => source.source_id)).size !== sources.length) {
    fail(`${cohortKey}/${role}: duplicate source IDs are not allowed.`);
  }
  const candidates = normalizeUuidArray(
    rawRole.fact_candidate_ids,
    `${cohortKey}/${role} fact_candidate_ids`,
  );
  if (status === "not_published" && candidates.length) {
    fail(`${cohortKey}/${role}: not_published must have zero candidates.`);
  }
  if (status !== "not_published" && !candidates.length) {
    fail(`${cohortKey}/${role}: present or combined requires candidates.`);
  }
  if (role === "identity_home" && (sources.length !== 1 || status === "not_published")) {
    fail(`${cohortKey}/identity_home must bind one present or combined source.`);
  }
  return {
    source_role: role,
    manifest_status: status,
    official: true,
    supporting_text: requireText(rawRole.supporting_text, `${cohortKey}/${role} supporting_text`),
    cycle: requireText(rawRole.cycle, `${cohortKey}/${role} cycle`),
    sources,
    fact_candidate_ids: candidates,
  };
}

export function normalizeStage1OfficialIdentity(
  raw,
  sourceUrl,
  canonicalHomepage,
  label = "official_identity",
) {
  requireExactKeys(
    raw,
    ["host", "classification", "evidence_url", "reviewed_reason"],
    label,
  );
  const sourceHost = new URL(sourceUrl).hostname.toLowerCase();
  const canonicalHost = new URL(canonicalHomepage).hostname.toLowerCase();
  const host = requireText(raw.host, `${label} host`).toLowerCase();
  const classification = requireText(raw.classification, `${label} classification`);
  const evidenceUrl = requireHttps(raw.evidence_url, `${label} evidence_url`);
  const evidenceHost = new URL(evidenceUrl).hostname.toLowerCase();
  if (host !== sourceHost) fail(`${label} host must exactly match the source URL host.`);
  if (!OFFICIAL_IDENTITY_CLASSES.has(classification)) {
    fail(`${label} classification is unsupported.`);
  }
  if (classification === "canonical_program_host") {
    if (host !== canonicalHost || evidenceUrl !== canonicalHomepage) {
      fail(`${label} canonical host must bind the exact canonical homepage.`);
    }
  } else {
    if (host === canonicalHost) {
      fail(`${label} external authority/contractor classification cannot relabel the canonical host.`);
    }
    if (classification === "official_contractor_host" && evidenceHost !== canonicalHost) {
      fail(`${label} contractor evidence must be on the canonical program host.`);
    }
    if (![canonicalHost, sourceHost].includes(evidenceHost)) {
      fail(`${label} authority evidence must be on the canonical or exact authority host.`);
    }
  }
  return {
    host,
    classification,
    evidence_url: evidenceUrl,
    reviewed_reason: requireText(raw.reviewed_reason, `${label} reviewed_reason`),
  };
}

function normalizeVerification(raw, snapshot, asOf, label) {
  const verifiedAt = requireNonFutureTimestamp(raw.verified_at, asOf, `${label} verified_at`);
  const hashes = requireHashes(raw.hashes, `${label} hashes`);
  if (!deepEqual(hashes, snapshot.hashes)) fail(`${label} hashes do not match the snapshot.`);
  if (Date.parse(verifiedAt) < Date.parse(snapshot.captured_at)) {
    fail(`${label} verification predates the capture.`);
  }
  return { verified_at: verifiedAt, hashes };
}

function requireHashes(value, label) {
  requirePlainObject(value, label);
  const normalized = stableValue(value);
  const present = Object.values(normalized).filter((entry) => entry != null && entry !== "");
  if (!present.length || present.some((entry) => !SHA256_PATTERN.test(cleanText(entry)))) {
    fail(`${label} must contain non-empty SHA-256 values.`);
  }
  return normalized;
}

function snapshotSlotFileName(slot) {
  if (SNAPSHOT_FIXED_SLOTS[slot]) return SNAPSHOT_FIXED_SLOTS[slot];
  const pageMatch = /^expansion_state_(\d{2})$/.exec(slot);
  if (pageMatch) return `expansion-state-${pageMatch[1]}.jpg`;
  const layoutMatch = /^expansion_state_(\d{2})_layout$/.exec(slot);
  if (layoutMatch) return `expansion-state-${layoutMatch[1]}-layout.json`;
  return null;
}

function normalizeUuidArray(value, label) {
  return normalizeUuidArrayInOrder(value, label).toSorted();
}

function normalizeUuidArrayInOrder(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array.`);
  const values = value.map((entry) => requireUuid(entry, label));
  if (new Set(values).size !== values.length) fail(`${label} must not contain duplicates.`);
  return values;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).toSorted().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function deepEqual(left, right) {
  return stableStage1HumanReviewJson(left) === stableStage1HumanReviewJson(right);
}

function isEmptyJson(value) {
  if (value == null || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  return typeof value === "object" && Object.keys(value).length === 0;
}

function requirePlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object.`);
}

function requireExactKeys(value, allowedKeys, label) {
  requirePlainObject(value, label);
  const actual = Object.keys(value).toSorted();
  const expected = [...allowedKeys].toSorted();
  if (!deepEqual(actual, expected)) {
    fail(`${label} must contain exactly: ${expected.join(", ")}.`);
  }
}

function requireOneOfExactKeySets(value, allowedKeySets, label) {
  requirePlainObject(value, label);
  const actual = Object.keys(value).toSorted();
  if (!allowedKeySets.some((keys) => deepEqual(actual, [...keys].toSorted()))) {
    fail(`${label} must contain exactly one supported field set.`);
  }
}

function stage1PublicationConfidence(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.min(1, value));
  }
  if (value === "high") return 0.9;
  if (value === "medium") return 0.72;
  return 0.5;
}

function requireText(value, label) {
  const text = cleanText(value);
  if (!text) fail(`${label} is required.`);
  return text;
}

function requireUuid(value, label) {
  const uuid = cleanText(value).toLowerCase();
  if (!UUID_PATTERN.test(uuid)) fail(`${label} must be a valid UUID.`);
  return uuid;
}

function requireHttps(value, label) {
  const text = requireText(value, label);
  try {
    if (new URL(text).protocol !== "https:") fail(`${label} must be HTTPS.`);
  } catch {
    fail(`${label} must be an HTTPS URL.`);
  }
  return text;
}

function requireFreshTimestamp(value, now, label) {
  const parsed = requireTimestamp(value, label);
  if (!isFresh(parsed, now)) fail(`${label} must be within 24 hours and not future-dated.`);
  return parsed;
}

function requireNonFutureTimestamp(value, now, label) {
  const parsed = requireTimestamp(value, label);
  if (Date.parse(parsed) > now.getTime() + FUTURE_SKEW_MS) {
    fail(`${label} must not be future-dated.`);
  }
  return parsed;
}

function requireTimestamp(value, label) {
  const text = cleanText(value);
  const parsed = Date.parse(text);
  if (!/^\d{4}-\d{2}-\d{2}T.+Z$/.test(text) || !Number.isFinite(parsed)) {
    fail(`${label} must be an ISO timestamp ending in Z.`);
  }
  return new Date(parsed).toISOString();
}

function isFresh(value, now) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    && timestamp >= now.getTime() - STAGE1_FRESHNESS_MS
    && timestamp <= now.getTime() + FUTURE_SKEW_MS;
}

function validDate(value, label) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) fail(`${label} is invalid.`);
  return date;
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function lowerSha256(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function positiveIntegerText(value) {
  return /^[1-9][0-9]*$/.test(String(value ?? ""));
}

function nonNegativeIntegerText(value) {
  return /^[0-9]+$/.test(String(value ?? ""));
}

function fail(message) {
  throw new Error(`Stage 1 human-review root blocked: ${message}`);
}
