import { createHash } from "node:crypto";
import {
  STAGE1_COHORT_DEFINITION,
  STAGE1_FRESHNESS_MS,
  STAGE1_POLICY_VERSION,
  sourceIdentityDisposition,
} from "./stage1-cohort-readiness.mjs";
import {
  STAGE1_HUMAN_REVIEW_ROOT_SCHEMA_VERSION,
  normalizeStage1HumanReviewRoot,
  stage1HumanReviewRootSha256,
  validateStage1ImmutableCaptureBinding,
} from "./stage1-human-review-root.mjs";
import { stage1ExpansionCaptureCoverageValid } from "./expansion-state-descriptor-canonicalization.mjs";

export const REVIEWED_RECONCILIATION_SCHEMA_VERSION =
  STAGE1_HUMAN_REVIEW_ROOT_SCHEMA_VERSION;
export const REVIEWED_RECONCILIATION_COMMIT_VERSION =
  "awardping.stage1.reviewed-reconciliation-commit.v1";
export const REVIEWED_RECONCILIATION_CONFIRMATION_VERSION =
  "awardping.stage1.reviewed-reconciliation-confirmation.v1";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const FUTURE_SKEW_MS = 5 * 60 * 1_000;
const SELECTABLE_STATUSES = new Set([
  "pending",
  "selected",
  "conflicted",
  "superseded",
]);
const SOURCE_RELEVANCE_VALUES = new Set(["primary", "supporting"]);
const CANDIDATE_IMMUTABLE_EVIDENCE_SCHEMA_VERSION =
  "awardping.stage1.candidate-immutable-evidence.v1";
const REVIEWED_CANDIDATE_IMPORT_ITEM_SCHEMA_VERSION =
  "awardping.stage1.reviewed-candidate-import-item.v1";

export function reviewedStage1SelectionScope(selection, now = new Date()) {
  const normalized = normalizeSelection(selection, validDate(now));
  return {
    cohort_key: normalized.cohort.cohort_key,
    canonical_award_id: normalized.cohort.canonical_shared_award_id,
    source_ids: uniqueSorted(normalized.roles.flatMap((role) =>
      role.sources.map((source) => source.source_id))),
    candidate_ids: uniqueSorted(normalized.field_choices.flatMap((entry) => entry.candidate_ids)),
  };
}

export function buildReviewedStage1ReconciliationPlan({
  selection,
  database,
  now = new Date(),
}) {
  const asOf = validDate(now);
  const normalized = normalizeSelection(selection, asOf);
  const selectionSha256 = normalized.stage1_review_root_sha256;
  const definition = STAGE1_COHORT_DEFINITION.find(
    (entry) => entry.cohortKey === normalized.cohort.cohort_key,
  );
  const registry = onlyRow(database?.registry, "Stage 1 registry");
  if (
    !definition
    || registry.cohort_key !== normalized.cohort.cohort_key
    || lowerUuid(registry.canonical_shared_award_id)
      !== normalized.cohort.canonical_shared_award_id
    || registry.canonical_name !== normalized.cohort.canonical_name
    || registry.official_homepage !== normalized.cohort.official_homepage
    || registry.policy_version !== STAGE1_POLICY_VERSION
    || definition.canonicalName !== normalized.cohort.canonical_name
    || definition.canonicalSearchKey !== normalized.cohort.canonical_search_key
    || definition.officialHomepage !== normalized.cohort.official_homepage
  ) {
    fail("the selection does not bind the exact configured cohort/canonical identity");
  }

  const memberIds = new Set((database?.members || [])
    .filter((row) => row.cohort_key === normalized.cohort.cohort_key)
    .map((row) => lowerUuid(row.shared_award_id)));
  if (!memberIds.has(normalized.cohort.canonical_shared_award_id)) {
    fail("the canonical award is not an exact member of the selected cohort");
  }
  const award = onlyRow(database?.awards, "canonical award");
  if (
    lowerUuid(award.id) !== normalized.cohort.canonical_shared_award_id
    || award.status !== "active"
    || award.name !== normalized.cohort.canonical_name
    || award.search_key !== normalized.cohort.canonical_search_key
    || award.official_homepage !== normalized.cohort.official_homepage
    || !validTimestamp(award.updated_at)
  ) {
    fail("the canonical award identity or CAS version changed");
  }

  const requestedCandidateIds = uniqueSorted(
    normalized.field_choices.flatMap((entry) => entry.candidate_ids),
  );
  const candidateById = exactMap(
    database?.fact_candidates,
    requestedCandidateIds,
    (row) => lowerUuid(row.id),
    "explicit candidate",
  );
  const contributorSourceIds = uniqueSorted(requestedCandidateIds.map((id) =>
    lowerUuid(candidateById.get(id)?.shared_award_source_id)));
  const mappedSourceById = new Map();
  const sourceRolesById = new Map();
  const roleByCandidateId = new Map();
  for (const role of normalized.roles) {
    for (const mappedSource of role.sources) {
      const existing = mappedSourceById.get(mappedSource.source_id);
      if (existing && !deepEqual(existing, mappedSource)) {
        fail(`reviewed source ${mappedSource.source_id} has conflicting role bindings`);
      }
      mappedSourceById.set(mappedSource.source_id, mappedSource);
      sourceRolesById.set(mappedSource.source_id, uniqueSorted([
        ...(sourceRolesById.get(mappedSource.source_id) || []),
        role.source_role,
      ]));
    }
    for (const candidateId of role.fact_candidate_ids) {
      if (roleByCandidateId.has(candidateId)) {
        fail(`candidate ${candidateId} is assigned to multiple source roles`);
      }
      roleByCandidateId.set(candidateId, role);
    }
  }
  const reviewSourceIds = [...mappedSourceById.keys()].toSorted();
  const sourceById = exactMap(
    database?.sources,
    reviewSourceIds,
    (row) => lowerUuid(row.id),
    "explicitly reviewed source",
  );
  const snapshotBySourceId = exactMap(
    database?.visual_snapshots,
    reviewSourceIds,
    (row) => lowerUuid(row.shared_award_source_id),
    "explicitly reviewed source snapshot",
  );
  const rules = (database?.identity_rules || []).filter(
    (row) => row.cohort_key === normalized.cohort.cohort_key,
  );

  const sourceBindings = reviewSourceIds.map((sourceId) => {
    const source = sourceById.get(sourceId);
    const snapshot = snapshotBySourceId.get(sourceId);
    const mappedSource = mappedSourceById.get(sourceId);
    const identity = sourceIdentityDisposition(source, rules);
    const immutableCapture = validateStage1ImmutableCaptureBinding({
      sourceId,
      kind: snapshot.kind,
      objectKeys: snapshot.latest_object_keys,
      hashes: snapshot.latest_hashes,
      metadata: snapshot.latest_metadata,
    });
    // Mirror of the commit RPC's expansion-coverage requirement so a
    // coverage-invalid pointer fails here instead of inside the RPC.
    if (!stage1ExpansionCaptureCoverageValid(snapshot.kind, snapshot.latest_metadata)) {
      fail(`source ${sourceId} or its immutable snapshot is not currently selectable`);
    }
    if (
      !memberIds.has(lowerUuid(source.shared_award_id))
      || source.admin_review_status !== "open"
      || !isHttps(source.url)
      || cleanText(source.last_error)
      || !isLiveCheckFresh(source.last_checked_at, asOf)
      || identity.excluded
      || identity.invalid_rules.length
      || lowerUuid(snapshot.shared_award_id) !== lowerUuid(source.shared_award_id)
      || snapshot.source_url !== source.url
      || !cleanText(snapshot.bucket)
      || !["webpage", "pdf"].includes(snapshot.kind)
      || !durableTimestampValid(snapshot.latest_captured_at, asOf)
      || !validTimestamp(source.updated_at)
      || !validTimestamp(snapshot.updated_at)
      || source.url !== mappedSource.source_url
      // Instant comparison, not canonical-string: rows written by direct SQL
      // carry microseconds that toISOString-canonicalization truncates, so the
      // string forms legitimately differ while the instants are identical.
      || Date.parse(source.last_checked_at) !== Date.parse(mappedSource.last_checked_at)
      || Date.parse(snapshot.latest_captured_at) !== Date.parse(mappedSource.snapshot.captured_at)
      || snapshot.kind !== mappedSource.snapshot.kind
      || !deepEqual(immutableCapture.object_keys, mappedSource.snapshot.object_keys)
      || !deepEqual(immutableCapture.hashes, mappedSource.snapshot.hashes)
      || !deepEqual(immutableCapture.metadata, mappedSource.snapshot.metadata)
    ) {
      fail(`source ${sourceId} or its immutable snapshot is not currently selectable`);
    }
    return {
      source_id: sourceId,
      shared_award_id: lowerUuid(source.shared_award_id),
      source_url: source.url,
      // Raw DB strings: the commit RPC parses these with stage1_safe_timestamptz
      // and compares them against live timestamptz columns, which can carry
      // microseconds; toISOString truncates to milliseconds and breaks the CAS.
      source_updated_at: source.updated_at,
      last_checked_at: source.last_checked_at,
      snapshot_updated_at: snapshot.updated_at,
      captured_at: snapshot.latest_captured_at,
      bucket: snapshot.bucket,
      kind: snapshot.kind,
      object_keys: stableValue(snapshot.latest_object_keys),
      hashes: stableValue(snapshot.latest_hashes),
      metadata: stableValue(snapshot.latest_metadata),
      source_roles: sourceRolesById.get(sourceId),
    };
  });

  const choiceByCandidateId = new Map();
  for (const choice of normalized.field_choices) {
    for (const candidateId of choice.candidate_ids) {
      choiceByCandidateId.set(candidateId, choice);
    }
  }
  const candidateBindings = requestedCandidateIds.map((candidateId) => {
    const candidate = candidateById.get(candidateId);
    const sourceId = lowerUuid(candidate.shared_award_source_id);
    const role = roleByCandidateId.get(candidateId);
    const choice = choiceByCandidateId.get(candidateId);
    const compositionIndex = choice?.candidate_ids.indexOf(candidateId) ?? -1;
    const reviewedEvidence = compositionIndex >= 0
      ? choice?.candidate_evidence?.[compositionIndex]
      : null;
    const immutableEvidence = reviewedEvidence
      ? {
          schema_version: CANDIDATE_IMMUTABLE_EVIDENCE_SCHEMA_VERSION,
          source_id: reviewedEvidence.source_id,
          capture_text_sha256: reviewedEvidence.capture_text_sha256,
          capture_text_object_key: reviewedEvidence.capture_text_object_key,
          evidence_quote_sha256: sha256Text(reviewedEvidence.evidence_quote),
          verification_method: "exact_local_text_substring",
        }
      : null;
    const intakeValueSha256 = candidate.intake_value_sha256 ?? null;
    const candidateImport = candidate.metadata?.stage1_candidate_import;
    const candidateImportBinding = reviewedCandidateImportBinding(candidateImport);
    const expectedCandidateImportItemSha256 = reviewedEvidence
      ? sha256Canonical({
          schema_version: REVIEWED_CANDIDATE_IMPORT_ITEM_SCHEMA_VERSION,
          policy_version: STAGE1_POLICY_VERSION,
          canonical_shared_award_id: normalized.cohort.canonical_shared_award_id,
          source_id: sourceId,
          source_url: candidate.source_url,
          source_relevance: candidate.source_role,
          field_name: candidate.field_name,
          normalized_value: candidate.normalized_value,
          evidence_quote: reviewedEvidence.evidence_quote,
          evidence_location: reviewedEvidence.evidence_location,
          capture_text_sha256: reviewedEvidence.capture_text_sha256,
          capture_text_object_key: reviewedEvidence.capture_text_object_key,
        })
      : null;
    const composedValue = choice?.composition_method === "ordered_array_items"
      ? normalized.public_facts[choice.field_name]?.[compositionIndex]
      : normalized.public_facts[choice?.field_name];
    if (
      !memberIds.has(lowerUuid(candidate.shared_award_id))
      || !contributorSourceIds.includes(sourceId)
      || lowerUuid(sourceById.get(sourceId)?.shared_award_id)
        !== lowerUuid(candidate.shared_award_id)
      || sourceById.get(sourceId)?.url !== candidate.source_url
      || !role
      || !role.sources.some((entry) => entry.source_id === sourceId)
      || !SOURCE_RELEVANCE_VALUES.has(candidate.source_role)
      || !choice
      || (choice.composition_method === "direct_exact"
        && choice.candidate_ids.length !== 1)
      || candidate.field_name !== choice.field_name
      || !new Set(["direct_exact", "ordered_array_items"]).has(
        choice.composition_method,
      )
      || compositionIndex < 0
      || !deepEqual(candidate.normalized_value, composedValue)
      || !SELECTABLE_STATUSES.has(candidate.candidate_status)
      || !validTimestamp(candidate.updated_at)
      || !reviewedEvidence
      || reviewedEvidence.candidate_id !== candidateId
      || reviewedEvidence.source_id !== sourceId
      || candidate.evidence_quote !== reviewedEvidence.evidence_quote
      || !deepEqual(candidate.evidence_location, reviewedEvidence.evidence_location)
      || mappedSourceById.get(sourceId)?.snapshot.hashes.text_hash
        !== reviewedEvidence.capture_text_sha256
      || mappedSourceById.get(sourceId)?.snapshot.object_keys.text
        !== reviewedEvidence.capture_text_object_key
      || !deepEqual(
        candidate.metadata?.stage1_immutable_evidence,
        immutableEvidence,
      )
      || !validCandidateImportMetadata(candidateImport)
      || candidateImport.item_sha256 !== expectedCandidateImportItemSha256
      || canonicalTimestamp(candidateImport.reviewed_at)
        !== canonicalTimestamp(candidate.extracted_at)
      || Date.parse(candidateImport.reviewed_at) > Date.parse(normalized.review.reviewed_at)
      || candidate.source_page_request_id !== null
      || intakeValueSha256 !== null
    ) {
      fail(`candidate ${candidateId} is not exact retained selectable evidence`);
    }
    return {
      candidate_id: candidateId,
      shared_award_id: lowerUuid(candidate.shared_award_id),
      source_id: sourceId,
      field_name: candidate.field_name,
      candidate_status: candidate.candidate_status,
      updated_at: candidate.updated_at,
      normalized_value: stableValue(candidate.normalized_value),
      evidence_quote: candidate.evidence_quote,
      evidence_location: candidate.evidence_location,
      immutable_evidence: immutableEvidence,
      candidate_import: candidateImportBinding,
      intake_value_sha256: intakeValueSha256,
      extracted_at: candidate.extracted_at ?? null,
      model: candidate.model ?? null,
      source_relevance: candidate.source_role,
      reviewed_stage1_source_role: role.source_role,
      composition_method: choice.composition_method,
      composition_index: choice.composition_method === "ordered_array_items"
        ? compositionIndex
        : null,
      selected_fields: [choice.field_name],
    };
  });

  const selectionState = {
    schema_version: REVIEWED_RECONCILIATION_COMMIT_VERSION,
    cohort_key: normalized.cohort.cohort_key,
    canonical_shared_award_id: normalized.cohort.canonical_shared_award_id,
    policy_version: STAGE1_POLICY_VERSION,
    selection_sha256: selectionSha256,
    stage1_review_root_schema_version: STAGE1_HUMAN_REVIEW_ROOT_SCHEMA_VERSION,
    stage1_review_root_sha256: selectionSha256,
    review_root: normalized.review_root,
    review: normalized.review,
    award: {
      id: lowerUuid(award.id),
      // Raw DB string for the same reason as the source bindings above.
      updated_at: award.updated_at,
      current_public_facts: stableValue(award.public_facts),
      current_public_facts_sha256: sha256Canonical(award.public_facts),
      replacement_public_facts: normalized.public_facts,
      replacement_public_facts_sha256: sha256Canonical(normalized.public_facts),
      replacement_summary: normalized.publication.summary,
      replacement_summary_sha256: sha256Text(normalized.publication.summary),
      replacement_confidence: normalized.publication.confidence,
      replacement_confidence_sha256: sha256Canonical(
        normalized.publication.confidence,
      ),
    },
    public_facts: normalized.public_facts,
    field_choices: normalized.field_choices,
    source_ids: contributorSourceIds,
    review_source_ids: reviewSourceIds,
    candidate_ids: requestedCandidateIds,
    source_snapshots: sourceBindings,
    candidate_versions: candidateBindings,
  };
  const stateSha256 = sha256Canonical(selectionState);
  const queueBinding = exactQueueBinding(database?.active_queue || [], {
    awardId: normalized.cohort.canonical_shared_award_id,
    selectionSha256,
    sourceIds: contributorSourceIds,
    candidateIds: requestedCandidateIds,
  });
  const confirmationPayload = {
    schema_version: REVIEWED_RECONCILIATION_CONFIRMATION_VERSION,
    operation: "commit_reviewed_stage1_reconciliation",
    cohort_key: normalized.cohort.cohort_key,
    canonical_shared_award_id: normalized.cohort.canonical_shared_award_id,
    selection_sha256: selectionSha256,
    stage1_review_root_schema_version: STAGE1_HUMAN_REVIEW_ROOT_SCHEMA_VERSION,
    stage1_review_root_sha256: selectionSha256,
    selection_state_sha256: stateSha256,
    queue_binding: queueBinding,
  };
  const confirmationSha256 = sha256Canonical(confirmationPayload);
  const evidenceRows = normalized.field_choices.map((choice) => {
    const bindings = choice.candidate_ids.map((id) => candidateById.get(id));
    // The commit RPC requires evidence-row candidate_ids to equal the reviewed
    // choice's candidate_ids exactly, composition order included — not sorted.
    const candidateIds = choice.candidate_ids.map((id) => lowerUuid(id));
    const sourceIds = uniqueSorted(bindings.map((candidate) =>
      lowerUuid(candidate.shared_award_source_id)));
    const candidateEvidence = Object.fromEntries(candidateIds.map((id) => {
      const candidate = candidateById.get(id);
      const reviewedRole = roleByCandidateId.get(id);
      const compositionIndex = choice.candidate_ids.indexOf(id);
      const reviewedEvidence = choice.candidate_evidence[compositionIndex];
      const selectedValue = choice.composition_method === "ordered_array_items"
        ? normalized.public_facts[choice.field_name][compositionIndex]
        : normalized.public_facts[choice.field_name];
      return [id, {
        source_id: lowerUuid(candidate.shared_award_source_id),
        source_role: candidate.source_role,
        source_relevance: candidate.source_role,
        reviewed_stage1_source_role: reviewedRole.source_role,
        field_name: candidate.field_name,
        canonical_field_name: candidate.field_name,
        contributes_to_field: choice.field_name,
        composition_method: choice.composition_method,
        composition_index: choice.composition_method === "ordered_array_items"
          ? compositionIndex
          : null,
        contribution_kind: choice.field_name === "confidence"
          ? "aggregate_confidence"
          : "direct_selected_value",
        reviewed_contribution_kind: choice.composition_method === "ordered_array_items"
          ? "ordered_array_item"
          : choice.field_name === "confidence"
            ? "aggregate_confidence"
            : "direct_selected_value",
        normalized_value: candidate.normalized_value,
        composed_value: selectedValue,
        selected_value: normalized.public_facts[choice.field_name],
        public_field_value: normalized.public_facts[choice.field_name],
        evidence_quote: reviewedEvidence.evidence_quote,
        evidence_location: reviewedEvidence.evidence_location,
        capture_text_sha256: reviewedEvidence.capture_text_sha256,
        capture_text_object_key: reviewedEvidence.capture_text_object_key,
        immutable_evidence: candidate.metadata.stage1_immutable_evidence,
        candidate_import: reviewedCandidateImportBinding(
          candidate.metadata.stage1_candidate_import,
        ),
        intake_value_sha256: candidate.intake_value_sha256 ?? null,
        extracted_at: candidate.extracted_at ?? null,
        model: candidate.model ?? null,
      }];
    }));
    const evidence = {
      schema_version: 1,
      award_id: normalized.cohort.canonical_shared_award_id,
      reconciliation_id: queueBinding.id,
      field_name: choice.field_name,
      public_value: normalized.public_facts[choice.field_name],
      candidate_ids: candidateIds,
      source_ids: sourceIds,
      candidate_bindings: candidateEvidence,
      materialized_by: "reconcile-reviewed-stage1-selection",
      reviewed_selection_sha256: selectionSha256,
      stage1_review_root_schema_version: STAGE1_HUMAN_REVIEW_ROOT_SCHEMA_VERSION,
      stage1_review_root_sha256: selectionSha256,
    };
    return {
      field_name: choice.field_name,
      public_value: normalized.public_facts[choice.field_name],
      candidate_ids: candidateIds,
      source_ids: sourceIds,
      evidence,
    };
  });
  const auditProjection = {
    stage1_review_root_schema_version: STAGE1_HUMAN_REVIEW_ROOT_SCHEMA_VERSION,
    stage1_review_root_sha256: selectionSha256,
    stage1_reviewed_public_facts_sha256: sha256Canonical(
      normalized.public_facts,
    ),
    stage1_reviewed_summary_sha256: sha256Text(
      normalized.publication.summary,
    ),
    stage1_reviewed_confidence_sha256: sha256Canonical(
      normalized.publication.confidence,
    ),
    stage1_reviewed_evidence_rows_sha256:
      sha256ReviewedEvidenceRows(evidenceRows),
  };
  const auditBase = {
    shared_award_id: normalized.cohort.canonical_shared_award_id,
    audit_kind: "deterministic",
    audit_status: "passed",
    severity: "info",
    findings: [],
    suggested_fixes: [],
    field_conflicts: [],
    source_rejections: [],
    selected_fact_summary: {
      ...Object.fromEntries(normalized.field_choices.map(
        (choice) => [choice.field_name, choice.candidate_ids],
      )),
      ...auditProjection,
    },
    public_page_snapshot: normalized.public_facts,
    model: "explicit-human-reviewed-stage1-reconciliation",
  };
  const auditRow = {
    ...auditBase,
    public_page_snapshot: {
      ...auditBase.public_page_snapshot,
      reconciliation_audit_signature: sha256Canonical(auditBase),
    },
  };
  const candidateStatusUpdates = requestedCandidateIds.map((id) => {
    const candidate = candidateById.get(id);
    return {
      id,
      expected_status: candidate.candidate_status,
      expected_updated_at: candidate.updated_at,
      candidate_status: "selected",
      selected_reason: `explicit_human_review:${selectionSha256}`,
      rejection_reason: null,
    };
  });

  return {
    schema_version: REVIEWED_RECONCILIATION_CONFIRMATION_VERSION,
    selection: normalized,
    selection_sha256: selectionSha256,
    selection_state_sha256: stateSha256,
    confirmation_payload: confirmationPayload,
    confirmation_sha256: confirmationSha256,
    confirmation_phrase: `CONFIRM STAGE1 RECONCILIATION ${confirmationSha256}`,
    queue_binding: queueBinding,
    review_binding: selectionState,
    commit: {
      shared_award_id: normalized.cohort.canonical_shared_award_id,
      expected_award_updated_at: award.updated_at,
      expected_public_facts: award.public_facts,
      summary: normalized.publication.summary,
      public_facts: normalized.public_facts,
      confidence: normalized.publication.confidence,
      evidence_rows: evidenceRows,
      source_ids: contributorSourceIds,
      review_source_ids: reviewSourceIds,
      candidate_ids: requestedCandidateIds,
      generated_candidates: [],
      candidate_status_updates: candidateStatusUpdates,
      audit_row: auditRow,
    },
    safety: {
      explicit_human_selection: true,
      broader_candidates_loaded: 0,
      candidates_materialized: 0,
      monitoring_sources_retired: 0,
      paid_api_calls: 0,
      preview_remote_mutations: 0,
    },
  };
}

export function stableReviewedReconciliationJson(value) {
  return JSON.stringify(stableValue(value));
}

function normalizeSelection(selection, now) {
  const reviewRoot = normalizeStage1HumanReviewRoot(selection, now);
  if (reviewRoot.cohorts.length !== 1) {
    fail("reviewed reconciliation apply requires exactly one cohort");
  }
  const reviewedCohort = reviewRoot.cohorts[0];
  return {
    schema_version: STAGE1_HUMAN_REVIEW_ROOT_SCHEMA_VERSION,
    policy_version: STAGE1_POLICY_VERSION,
    review: reviewRoot.review,
    review_root: reviewRoot,
    stage1_review_root_sha256: stage1HumanReviewRootSha256(selection, now),
    cohort: {
      cohort_key: reviewedCohort.cohort_key,
      canonical_shared_award_id: reviewedCohort.canonical_award.id,
      canonical_search_key: reviewedCohort.canonical_award.search_key,
      canonical_name: reviewedCohort.canonical_award.name,
      official_homepage: reviewedCohort.canonical_award.official_homepage,
    },
    public_facts: reviewedCohort.public_facts,
    publication: reviewedCohort.publication,
    field_choices: reviewedCohort.field_choices,
    roles: reviewedCohort.roles,
  };
}

function exactQueueBinding(rows, {
  awardId,
  selectionSha256,
  sourceIds,
  candidateIds,
}) {
  if (!Array.isArray(rows) || rows.length > 1) {
    fail("the cohort has an ambiguous active reconciliation queue");
  }
  if (!rows.length) {
    return {
      mode: "create",
      id: uuidFromHash(selectionSha256),
      status: "pending",
      generation: 0,
      source_ids: [],
      candidate_ids: [],
      created_at: null,
    };
  }
  const row = rows[0];
  const metadata = row.metadata && typeof row.metadata === "object"
    && !Array.isArray(row.metadata)
    ? row.metadata
    : {};
  if (
    lowerUuid(row.shared_award_id) !== awardId
    || row.reason !== "explicit_human_review"
    || row.status !== "pending"
    || row.started_at
    || row.completed_at
    || metadata.processor !== "reconcile-reviewed-stage1-selection"
    || metadata.selection_mode !== "explicit_human_review"
    || metadata.selection_sha256 !== selectionSha256
    || metadata.stage1_review_root_schema_version
      !== STAGE1_HUMAN_REVIEW_ROOT_SCHEMA_VERSION
    || metadata.stage1_review_root_sha256 !== selectionSha256
    || !deepEqual(metadata.reviewed_contributor_source_ids, sourceIds)
    || !deepEqual(metadata.reviewed_candidate_ids, candidateIds)
    || !deepEqual(
      normalizeUuidArray(row.source_ids || [], "active queue source_ids"),
      sourceIds,
    )
    || !deepEqual(
      normalizeUuidArray(row.candidate_ids || [], "active queue candidate_ids"),
      candidateIds,
    )
  ) {
    fail("the active reconciliation queue is not exact dedicated reviewed work");
  }
  return {
    mode: "existing",
    id: requireUuid(row.id, "active queue id"),
    status: "pending",
    generation: Number(row.generation) || 0,
    source_ids: normalizeUuidArray(row.source_ids || [], "active queue source_ids"),
    candidate_ids: normalizeUuidArray(row.candidate_ids || [], "active queue candidate_ids"),
    created_at: canonicalTimestamp(row.created_at),
  };
}

function exactMap(rows, expectedIds, idFor, label) {
  const map = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = idFor(row);
    if (!id || map.has(id)) fail(`${label} rows are missing or duplicated`);
    map.set(id, row);
  }
  if (!deepEqual([...map.keys()].toSorted(), expectedIds)) {
    fail(`${label} rows do not exactly match the explicit selection`);
  }
  return map;
}

function onlyRow(rows, label) {
  if (!Array.isArray(rows) || rows.length !== 1) fail(`${label} must contain exactly one row`);
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
  return createHash("sha256").update(stableReviewedReconciliationJson(value), "utf8").digest("hex");
}

function sha256Text(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256ReviewedEvidenceRows(rows) {
  return sha256Canonical([...rows].toSorted((left, right) => {
    const leftField = String(left?.field_name ?? "");
    const rightField = String(right?.field_name ?? "");
    return leftField < rightField ? -1 : leftField > rightField ? 1 : 0;
  }));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value ?? null;
}

function deepEqual(left, right) {
  return stableReviewedReconciliationJson(left) === stableReviewedReconciliationJson(right);
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].toSorted();
}

function normalizeUuidArray(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  const values = value.map((entry) => requireUuid(entry, label)).toSorted();
  if (new Set(values).size !== values.length) fail(`${label} contains duplicates`);
  return values;
}

function requireUuid(value, label) {
  const text = lowerUuid(value);
  if (!UUID_PATTERN.test(text)) fail(`${label} must be a UUID`);
  return text;
}

function isHttps(value) {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function canonicalTimestamp(value) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) fail("an evidence timestamp is invalid");
  return new Date(time).toISOString();
}

function validTimestamp(value) {
  return Number.isFinite(Date.parse(value));
}

function durableTimestampValid(value, now) {
  const time = Date.parse(value);
  return Number.isFinite(time) && time <= now.getTime() + FUTURE_SKEW_MS;
}

function isLiveCheckFresh(value, now) {
  const time = Date.parse(value);
  return Number.isFinite(time)
    && time >= now.getTime() - STAGE1_FRESHNESS_MS
    && time <= now.getTime() + FUTURE_SKEW_MS;
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function lowerUuid(value) {
  return cleanText(value).toLowerCase();
}

function validDate(value) {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (!Number.isFinite(date.getTime())) fail("the evaluation time is invalid");
  return date;
}

function validCandidateImportMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (!deepEqual(Object.keys(value).toSorted(), [
    "bundle_sha256",
    "item_key",
    "item_sha256",
    "paid_api_calls",
    "review_reason",
    "reviewed_at",
    "reviewed_by",
    "schema_version",
  ])) return false;
  return value.schema_version === REVIEWED_CANDIDATE_IMPORT_ITEM_SCHEMA_VERSION
    && typeof value.bundle_sha256 === "string"
    && SHA256_PATTERN.test(value.bundle_sha256)
    && typeof value.item_sha256 === "string"
    && SHA256_PATTERN.test(value.item_sha256)
    && typeof value.item_key === "string"
    && /^[a-z0-9][a-z0-9._-]{0,119}$/.test(value.item_key)
    && value.paid_api_calls === 0
    && Boolean(cleanText(value.reviewed_by))
    && Boolean(cleanText(value.review_reason))
    && typeof value.reviewed_at === "string"
    && validTimestamp(value.reviewed_at);
}

function reviewedCandidateImportBinding(value) {
  if (!value) return null;
  return {
    schema_version: value.schema_version,
    bundle_sha256: value.bundle_sha256,
    item_sha256: value.item_sha256,
  };
}

function fail(message) {
  throw new Error(`Reviewed Stage 1 reconciliation blocked: ${message}.`);
}
