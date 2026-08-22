import { createHash } from "node:crypto";

import { verifyVisualTextGeometryBinding } from "./visual-event-localization.mjs";
import {
  buildLegacyRetainedProjectionProvenance,
  isExactLegacyRetainedProjectionProvenance,
  legacyR2PointerV7Policy,
  legacyRetainedProjectionProvenanceSchema,
} from "./legacy-r2-retained-projection-provenance.mjs";
import {
  canonicalExpansionStateCaptureCoverage,
  hasExpansionStateCaptureCoverageClaim,
  legacyExpansionStateCaptureCoverageFromMetadata,
  sameExpansionStateCaptureCoverage,
} from "./expansion-state-descriptor-canonicalization.mjs";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const VERSION_PATTERN = /^[0-9a-f]{32}$/u;
const MAX_OBJECT_BYTES = 100 * 1024 * 1024;

const FIXED_SLOTS = Object.freeze({
  page: { fileName: "page.jpg", contentType: "image/jpeg" },
  thumb: { fileName: "thumb.jpg", contentType: "image/jpeg" },
  pdf: { fileName: "document.pdf", contentType: "application/pdf" },
  text: { fileName: "text.txt", contentType: "text/plain; charset=utf-8" },
  layout: { fileName: "layout.json", contentType: "application/json; charset=utf-8" },
  meta: { fileName: "meta.json", contentType: "application/json; charset=utf-8" },
});
const ARTIFACT_BINDINGS_SCHEMA = "awardping.r2.capture-artifact-bindings.v1";
const RETAINED_ARTIFACT_PROJECTION_SCHEMA =
  "awardping.capture-retained-artifact-projection.v1";
export const LEGACY_RETAINED_PROJECTION_PROVENANCE_SCHEMA =
  legacyRetainedProjectionProvenanceSchema;
const LEGACY_RETAINED_PROJECTION_PLAN_BINDING_SCHEMA =
  "awardping.legacy-retained-artifact-projection-plan-binding.v1";

const SNAPSHOT_FIELDS = Object.freeze([
  "shared_award_source_id",
  "shared_award_id",
  "source_url",
  "source_title",
  "source_page_type",
  "kind",
  "bucket",
  "latest_captured_at",
  "latest_object_keys",
  "latest_hashes",
  "latest_metadata",
  "previous_captured_at",
  "previous_object_keys",
  "previous_hashes",
  "previous_metadata",
  "updated_at",
]);

export const LEGACY_R2_POINTER_PLAN_SCHEMA =
  "awardping.legacy-r2-snapshot-pointer-migration-plan.v7";
export const LEGACY_R2_POINTER_RECEIPT_SCHEMA =
  "awardping.legacy-r2-snapshot-pointer-migration-receipt.v7";
export const LEGACY_R2_POINTER_POLICY = legacyR2PointerV7Policy;

export class LegacyR2PointerMigrationError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "LegacyR2PointerMigrationError";
    this.code = normalizedReasonCode(code);
    this.details = details;
  }
}

/**
 * Build the same deterministic capture generation ID as the normal snapshot
 * uploader. Legacy database rows store only part of this hash object, so every
 * omitted field is made explicit as null before hashing.
 */
export function legacyR2CaptureVersion({ capturedAt, hashes } = {}) {
  const timestamp = canonicalTimestamp(capturedAt, "generation captured_at");
  const identity = {
    captured_at: timestamp,
    hashes: normalizedCaptureHashes(hashes),
  };
  return sha256Text(JSON.stringify(identity)).slice(0, 32);
}

export function canonicalSnapshotRow(row) {
  if (!isObject(row)) fail("snapshot_row_invalid", "Snapshot pointer row must be an object.");
  const sourceId = requiredUuid(row.shared_award_source_id, "snapshot source ID");
  const awardId = requiredUuid(row.shared_award_id, "snapshot award ID");
  const kind = requiredText(row.kind, "snapshot kind").toLowerCase();
  if (!new Set(["webpage", "pdf"]).has(kind)) {
    fail("snapshot_kind_invalid", `Snapshot ${sourceId} has unsupported kind ${kind || "(blank)"}.`);
  }
  const output = {};
  for (const field of SNAPSHOT_FIELDS) output[field] = cloneJson(row[field] ?? null);
  output.shared_award_source_id = sourceId;
  output.shared_award_id = awardId;
  output.kind = kind;
  output.bucket = requiredText(row.bucket, "snapshot bucket");
  output.source_url = requiredHttpUrl(row.source_url, "snapshot source URL");
  output.latest_captured_at = nullableCanonicalTimestamp(row.latest_captured_at, "latest captured_at");
  output.previous_captured_at = nullableCanonicalTimestamp(row.previous_captured_at, "previous captured_at");
  output.updated_at = canonicalTimestamp(row.updated_at, "snapshot updated_at");
  output.latest_object_keys = jsonObject(row.latest_object_keys);
  output.latest_hashes = jsonObject(row.latest_hashes);
  output.latest_metadata = jsonObject(row.latest_metadata);
  output.previous_object_keys = jsonObject(row.previous_object_keys);
  output.previous_hashes = jsonObject(row.previous_hashes);
  output.previous_metadata = jsonObject(row.previous_metadata);
  return output;
}

function canonicalSourceRow(source) {
  if (!isObject(source)) fail("source_row_missing", "The source row is missing.");
  return {
    id: requiredUuid(source.id, "source ID"),
    shared_award_id: requiredUuid(source.shared_award_id, "source award ID"),
    url: requiredHttpUrl(source.url, "source URL"),
    title: cloneJson(source.title ?? null),
    display_title: cloneJson(source.display_title ?? null),
    page_type: cloneJson(source.page_type ?? null),
    admin_review_status: cloneJson(source.admin_review_status ?? null),
  };
}

export function snapshotRowFingerprint(row) {
  return sha256Text(stableJson(canonicalSnapshotRow(row)));
}

export function assertReviewedQuarantinePrecondition(item, { row = null, source = null } = {}) {
  if (!isObject(item) || item.action !== "quarantine_only") {
    fail("quarantine_item_invalid", "A reviewed quarantine-only item is required.");
  }
  validateQuarantinePrecondition(item.quarantine_precondition);
  assertReviewedStateBinding({
    label: "snapshot pointer",
    expectedState: item.quarantine_precondition.pointer_state,
    expectedFingerprint: item.quarantine_precondition.pointer_sha256,
    current: row,
    fingerprint: reviewedSnapshotStateFingerprint,
  });
  assertReviewedStateBinding({
    label: "source",
    expectedState: item.quarantine_precondition.source_state,
    expectedFingerprint: item.quarantine_precondition.source_sha256,
    current: source,
    fingerprint: reviewedSourceStateFingerprint,
  });
  return true;
}

export function snapshotPreservedFieldsFingerprint(row) {
  const value = canonicalSnapshotRow(row);
  delete value.latest_object_keys;
  delete value.previous_object_keys;
  delete value.latest_metadata;
  delete value.previous_metadata;
  delete value.updated_at;
  return sha256Text(stableJson(value));
}

export function snapshotPostconditionFingerprint(row) {
  const value = canonicalSnapshotRow(row);
  delete value.updated_at;
  return sha256Text(stableJson(value));
}

/**
 * Read and validate all legacy generations for one pointer row. The returned
 * `item` is JSON-safe; byte buffers remain in `bodies` for a later apply pass.
 */
export async function inspectLegacyR2SnapshotPointer({
  row,
  source,
  objectStore,
  maxObjectBytes = MAX_OBJECT_BYTES,
} = {}) {
  const snapshot = canonicalSnapshotRow(row);
  validateSourceIdentity(source, snapshot);
  if (!objectStore || typeof objectStore.readObject !== "function") {
    fail("object_store_invalid", "An R2 objectStore.readObject function is required.");
  }
  if (requiredText(objectStore.bucket, "object store bucket") !== snapshot.bucket) {
    fail("snapshot_bucket_mismatch", "The snapshot pointer names a different R2 bucket.");
  }
  const bodies = new Map();
  const generations = {};
  let legacyGenerationCount = 0;
  let metadataEnrichmentCount = 0;

  for (const generationName of ["latest", "previous"]) {
    const generation = generationFromSnapshot(snapshot, generationName);
    const manifest = validateGenerationKeySet({
      sourceId: snapshot.shared_award_source_id,
      kind: snapshot.kind,
      generationName,
      capturedAt: generation.capturedAt,
      objectKeys: generation.objectKeys,
    });
    if (manifest.state === "absent") {
      generations[generationName] = { state: "absent" };
      continue;
    }
    validateGenerationPointerIdentity({ snapshot, generation });
    // The uploader became content-addressed: a generation is now derived from
    // {hashes, artifact_bindings} rather than {captured_at, hashes}, so an
    // unchanged re-capture reuses its generation and evidence sealed against
    // those object keys survives a routine freshness capture. Such generations
    // record the artifact-bindings schema in their immutable metadata, and the
    // legacy timestamp-bound formula cannot reproduce their version -- applying
    // it would fail every modern pointer closed and re-quarantine live sources.
    const generationMetadata = jsonObject(generation.metadata);
    const contentAddressedGeneration =
      typeof generationMetadata.artifact_bindings_schema === "string"
      && generationMetadata.artifact_bindings_schema.length > 0;
    if (
      manifest.state === "immutable"
      && !contentAddressedGeneration
      && manifest.version !== legacyR2CaptureVersion({
        capturedAt: generation.capturedAt,
        hashes: generation.hashes,
      })
    ) {
      fail(
        "immutable_generation_version_mismatch",
        `${generationName} capture version is not bound to its timestamp and hashes.`,
      );
    }
    const artifacts = [];
    for (const entry of manifest.entries) {
      const remote = await objectStore.readObject({
        key: entry.key,
        maxBytes: maxObjectBytes,
      });
      const artifact = validateReadObject(remote, entry, { maxObjectBytes, legacy: true });
      artifacts.push(artifact);
      bodies.set(entry.key, artifact.body);
    }
    const payload = validateGenerationPayload({
      snapshot,
      source,
      generation,
      manifest,
      artifacts,
    });
    if (payload.metadataEnriched) metadataEnrichmentCount += 1;

    const verifiedArtifacts = artifacts.map((artifact) => ({
      slot: artifact.slot,
      source_key: artifact.key,
      sha256: artifact.sha256,
      byte_length: artifact.byte_length,
      content_type: artifact.content_type,
      source_etag: artifact.etag,
    }));
    if (manifest.state === "immutable") {
      generations[generationName] = {
        state: "already_immutable",
        family: manifest.family,
        version: manifest.version,
        captured_at: generation.capturedAt,
        object_keys: generation.objectKeys,
        hashes: generation.hashes,
        metadata_before: generation.metadata,
        metadata_after: payload.metadataAfter,
        metadata_enriched: payload.metadataEnriched,
        metadata_added_paths: payload.metadataAddedPaths,
        retained_projection_binding: payload.retainedProjectionBinding,
        verified_artifacts: verifiedArtifacts,
        artifact_manifest_sha256: sha256Text(stableJson(verifiedArtifacts)),
      };
      continue;
    }

    legacyGenerationCount += 1;

    const version = legacyR2CaptureVersion({
      capturedAt: generation.capturedAt,
      hashes: generation.hashes,
    });
    const destinationObjectKeys = Object.fromEntries(
      manifest.entries.map((entry) => [
        entry.slot,
        `visual-snapshots/sources/${snapshot.shared_award_source_id}/captures/${version}/${entry.fileName}`,
      ]),
    );
    const plannedArtifacts = artifacts.map((artifact) => ({
      slot: artifact.slot,
      legacy_key: artifact.key,
      immutable_key: destinationObjectKeys[artifact.slot],
      sha256: artifact.sha256,
      byte_length: artifact.byte_length,
      content_type: artifact.content_type,
      source_etag: artifact.etag,
    }));
    generations[generationName] = {
      state: "migrate_legacy_mutable",
      family: "captures",
      version,
      captured_at: generation.capturedAt,
      object_keys_before: generation.objectKeys,
      object_keys_after: destinationObjectKeys,
      hashes: generation.hashes,
      metadata_before: generation.metadata,
      metadata_after: payload.metadataAfter,
      metadata_enriched: payload.metadataEnriched,
      metadata_added_paths: payload.metadataAddedPaths,
      retained_projection_binding: payload.retainedProjectionBinding,
      localization_status: manifest.entries.some((entry) => entry.slot === "layout")
        ? "retained_layout_requires_rehydration_verification"
        : "evidence_only_geometry_unavailable",
      artifacts: plannedArtifacts,
      artifact_manifest_sha256: sha256Text(stableJson(plannedArtifacts)),
    };
  }

  const nextLatestObjectKeys = generationKeysAfterMigration(
    generations.latest,
    snapshot.latest_object_keys,
  );
  const nextPreviousObjectKeys = generationKeysAfterMigration(
    generations.previous,
    snapshot.previous_object_keys,
  );
  const nextLatestMetadata = generationMetadataAfter(
    generations.latest,
    snapshot.latest_metadata,
  );
  const nextPreviousMetadata = generationMetadataAfter(
    generations.previous,
    snapshot.previous_metadata,
  );
  const metadataFieldsToUpdate = [];
  if (generations.latest?.metadata_enriched) {
    metadataFieldsToUpdate.push("latest_metadata");
  }
  if (generations.previous?.metadata_enriched) {
    metadataFieldsToUpdate.push("previous_metadata");
  }
  const expectedAfter = cloneJson(snapshot);
  expectedAfter.latest_object_keys = cloneJson(nextLatestObjectKeys);
  expectedAfter.previous_object_keys = cloneJson(nextPreviousObjectKeys);
  expectedAfter.latest_metadata = cloneJson(nextLatestMetadata);
  expectedAfter.previous_metadata = cloneJson(nextPreviousMetadata);
  const pointerFieldsChanged = [];
  if (stableJson(snapshot.latest_object_keys) !== stableJson(nextLatestObjectKeys)) {
    pointerFieldsChanged.push("latest_object_keys");
  }
  if (stableJson(snapshot.previous_object_keys) !== stableJson(nextPreviousObjectKeys)) {
    pointerFieldsChanged.push("previous_object_keys");
  }
  pointerFieldsChanged.push(...metadataFieldsToUpdate);
  if (pointerFieldsChanged.length) pointerFieldsChanged.push("updated_at");
  const item = {
    source_id: snapshot.shared_award_source_id,
    shared_award_id: snapshot.shared_award_id,
    source_url: snapshot.source_url,
    kind: snapshot.kind,
    action: legacyGenerationCount || metadataEnrichmentCount ? "migrate" : "already_immutable",
    creates_api_charge: false,
    expected_snapshot: snapshot,
    expected_snapshot_sha256: sha256Text(stableJson(snapshot)),
    expected_preserved_fields_sha256: snapshotPreservedFieldsFingerprint(snapshot),
    expected_postcondition_sha256: snapshotPostconditionFingerprint(expectedAfter),
    next_object_keys: {
      latest: nextLatestObjectKeys,
      previous: nextPreviousObjectKeys,
    },
    next_metadata: {
      latest: nextLatestMetadata,
      previous: nextPreviousMetadata,
    },
    metadata_fields_to_update: metadataFieldsToUpdate,
    generations,
    safety: {
      legacy_objects_deleted: false,
      events_written: false,
      live_fetch_performed: false,
      baseline_refreshed: false,
      paid_api_calls: 0,
      metadata_repair:
        "Only reviewed derived fields may be added: full raw artifact bindings, text_object_bytes from retained bytes, a canonical retained-artifact projection tied to the verified raw meta hash, a conservative incomplete expansion coverage verdict from the validated legacy producer shape, or truthful zero-layout/zero-expansion accounting when every geometry claim is absent. Verified completeness always requires an existing canonical nested v1 verdict.",
      pointer_fields_changed: pointerFieldsChanged,
    },
  };
  item.execution_binding_sha256 = migrationItemExecutionBinding(item);
  return { item, bodies };
}

export function blockedLegacyR2MigrationItem({ sourceId, source = null, row = null, error } = {}) {
  const id = requiredUuid(sourceId, "blocked source ID");
  const reasonCode = normalizedReasonCode(error?.code || "legacy_r2_pointer_inspection_failed");
  return {
    source_id: id,
    shared_award_id: source?.shared_award_id || row?.shared_award_id || null,
    source_url: source?.url || row?.source_url || null,
    kind: row?.kind || null,
    action: "quarantine_only",
    creates_api_charge: false,
    failure: {
      reason_code: reasonCode,
      message: safeMessage(error),
      recommended_action:
        "Keep the current pointer and legacy objects unchanged. Verify the exact source, generation metadata, hashes, lengths, and R2 bytes; then rebuild a reviewed migration plan. Never fetch a replacement baseline to clear this failure.",
    },
    expected_snapshot_sha256: isObject(row) ? safeSnapshotFingerprint(row) : null,
    quarantine_precondition: {
      pointer_state: isObject(row) ? "present" : "missing",
      pointer_sha256: isObject(row) ? reviewedSnapshotStateFingerprint(row) : null,
      source_state: isObject(source) ? "present" : "missing",
      source_sha256: isObject(source) ? reviewedSourceStateFingerprint(source) : null,
    },
    safety: {
      legacy_objects_deleted: false,
      events_written: false,
      live_fetch_performed: false,
      baseline_refreshed: false,
      paid_api_calls: 0,
      pointer_fields_changed: [],
    },
  };
}

export function buildLegacyR2PointerMigrationPlan({
  items,
  selector,
  continuation = null,
  builtAt = new Date().toISOString(),
  ttlMs = 2 * 60 * 60 * 1000,
} = {}) {
  if (!Array.isArray(items) || !items.length) {
    fail("plan_items_missing", "A migration plan requires at least one inspected source.");
  }
  const ids = items.map((item) => requiredUuid(item.source_id, "plan source ID"));
  if (new Set(ids).size !== ids.length) fail("plan_source_duplicate", "Plan source IDs must be unique.");
  for (const item of items) validatePlanItem(item);
  validatePlanSelector(selector, ids);
  const built = canonicalTimestamp(builtAt, "plan built_at");
  const expiresAt = new Date(Date.parse(built) + boundedPositiveInteger(ttlMs, "plan TTL", 86_400_000))
    .toISOString();
  const summary = summarizePlanItems(items);
  const planWithoutConfirmation = {
    schema_version: LEGACY_R2_POINTER_PLAN_SCHEMA,
    policy: LEGACY_R2_POINTER_POLICY,
    mode: "dry_run",
    built_at: built,
    expires_at: expiresAt,
    selector: cloneJson(selector),
    continuation: cloneJson(continuation),
    summary,
    safety_contract: {
      exact_selected_sources_only: true,
      authoritative_r2_head_get_required: true,
      destination_if_absent_or_exact_match_only: true,
      destination_sha256_metadata_required: true,
      pointer_compare_and_set_required: true,
      changes_only_object_keys_derived_metadata_additions_and_updated_at: true,
      missing_text_object_bytes_may_be_derived_from_verified_retained_bytes: true,
      missing_artifact_bindings_may_be_derived_from_verified_retained_bytes: true,
      missing_retained_projection_may_be_derived_from_verified_manifest: true,
      legacy_raw_meta_projection_absence_requires_hash_bound_provenance: true,
      legacy_scalar_expansion_coverage_is_always_conservative_incomplete: true,
      verified_complete_expansion_coverage_requires_nested_v1: true,
      zero_layout_accounting_may_be_added_only_when_all_geometry_claims_are_absent: true,
      existing_metadata_values_are_preserved: true,
      preserve_capture_timestamps_hashes_and_all_existing_metadata_values: true,
      preserve_legacy_objects: true,
      live_fetches: 0,
      public_event_writes: 0,
      baseline_refreshes: 0,
      paid_api_calls: 0,
      failed_items_create_durable_quarantine_on_apply: true,
    },
    items: cloneJson(items),
  };
  const planSha256 = sha256Text(stableJson(planWithoutConfirmation));
  return {
    ...planWithoutConfirmation,
    confirmation: {
      plan_sha256: planSha256,
      exact_confirmation_phrase: `Apply legacy R2 pointer migration plan ${planSha256}`,
    },
  };
}

export function assertLegacyR2PointerMigrationPlan(plan, confirmation, {
  now = new Date().toISOString(),
} = {}) {
  if (!isObject(plan) || plan.schema_version !== LEGACY_R2_POINTER_PLAN_SCHEMA) {
    fail("plan_schema_invalid", "The migration plan schema is unsupported.");
  }
  if (stableJson(plan.policy) !== stableJson(LEGACY_R2_POINTER_POLICY)) {
    fail("plan_policy_invalid", "The migration plan policy identity is not current.");
  }
  const supplied = requiredText(confirmation, "plan confirmation");
  const expected = requiredSha256(plan.confirmation?.plan_sha256, "plan SHA-256");
  if (supplied !== expected && supplied !== plan.confirmation?.exact_confirmation_phrase) {
    fail("plan_confirmation_mismatch", "The exact immutable plan hash was not confirmed.");
  }
  const unsigned = cloneJson(plan);
  delete unsigned.confirmation;
  const actual = sha256Text(stableJson(unsigned));
  if (actual !== expected) fail("plan_hash_mismatch", "The migration plan changed after review.");
  const current = Date.parse(canonicalTimestamp(now, "plan verification time"));
  if (current > Date.parse(canonicalTimestamp(plan.expires_at, "plan expires_at"))) {
    fail("plan_expired", "The migration plan expired; rebuild and review current R2/DB state.");
  }
  if (!Array.isArray(plan.items) || !plan.items.length) {
    fail("plan_items_missing", "The migration plan has no source items.");
  }
  const ids = plan.items.map((item) => requiredUuid(item.source_id, "plan source ID"));
  if (new Set(ids).size !== ids.length) fail("plan_source_duplicate", "Plan source IDs are duplicated.");
  for (const item of plan.items) validatePlanItem(item);
  validatePlanSelector(plan.selector, ids);
  if (stableJson(plan.summary) !== stableJson(summarizePlanItems(plan.items))) {
    fail("plan_summary_invalid", "The migration plan summary does not match its reviewed items.");
  }
  const safety = plan.safety_contract || {};
  if (
    safety.exact_selected_sources_only !== true
    || safety.authoritative_r2_head_get_required !== true
    || safety.destination_if_absent_or_exact_match_only !== true
    || safety.pointer_compare_and_set_required !== true
    || safety.changes_only_object_keys_derived_metadata_additions_and_updated_at !== true
    || safety.missing_text_object_bytes_may_be_derived_from_verified_retained_bytes !== true
    || safety.missing_artifact_bindings_may_be_derived_from_verified_retained_bytes !== true
    || safety.missing_retained_projection_may_be_derived_from_verified_manifest !== true
    || safety.legacy_raw_meta_projection_absence_requires_hash_bound_provenance !== true
    || safety.legacy_scalar_expansion_coverage_is_always_conservative_incomplete !== true
    || safety.verified_complete_expansion_coverage_requires_nested_v1 !== true
    || safety.zero_layout_accounting_may_be_added_only_when_all_geometry_claims_are_absent !== true
    || safety.existing_metadata_values_are_preserved !== true
    || safety.preserve_capture_timestamps_hashes_and_all_existing_metadata_values !== true
    || safety.preserve_legacy_objects !== true
    || safety.live_fetches !== 0
    || safety.public_event_writes !== 0
    || safety.baseline_refreshes !== 0
    || safety.paid_api_calls !== 0
  ) {
    fail("plan_safety_contract_invalid", "The migration plan broadens its zero-refresh safety contract.");
  }
  return cloneJson(plan);
}

/**
 * Apply one already-reviewed source item. This function deliberately has no
 * HTTP-page client, event client, delete method, or model provider dependency.
 */
export async function applyLegacyR2SnapshotPointerItem({
  planItem,
  currentRow,
  source,
  objectStore,
  compareAndSetObjectKeys,
  loadCurrentRow,
  now = new Date().toISOString(),
} = {}) {
  if (!isObject(planItem) || planItem.action !== "migrate") {
    fail("apply_item_invalid", "Only a reviewed migrate item can advance pointer keys.");
  }
  validatePlanItem(planItem);
  if (typeof compareAndSetObjectKeys !== "function" || typeof loadCurrentRow !== "function") {
    fail("apply_callbacks_invalid", "Pointer CAS and reload callbacks are required.");
  }
  const canonicalCurrent = canonicalSnapshotRow(currentRow);
  validateSourceIdentity(source, canonicalCurrent);
  if (canonicalCurrent.shared_award_source_id !== planItem.source_id) {
    fail("apply_source_mismatch", "The current pointer belongs to a different source.");
  }
  if (requiredText(objectStore?.bucket, "object store bucket") !== canonicalCurrent.bucket) {
    fail("snapshot_bucket_mismatch", "The snapshot pointer names a different R2 bucket.");
  }
  if (pointerAlreadyApplied(canonicalCurrent, planItem)) {
    await verifyPlannedImmutableDestinations(planItem, objectStore);
    return applyReceipt(planItem, "already_applied", canonicalCurrent, now, 0);
  }
  if (sha256Text(stableJson(canonicalCurrent)) !== planItem.expected_snapshot_sha256) {
    fail("snapshot_pointer_precondition_changed", "The database pointer changed after plan review.");
  }
  if (migrationItemExecutionBinding(planItem) !== planItem.execution_binding_sha256) {
    fail("plan_item_execution_binding_invalid", "The reviewed item's execution binding is invalid.");
  }

  const inspected = await inspectLegacyR2SnapshotPointer({
    row: canonicalCurrent,
    source,
    objectStore,
  });
  if (inspected.item.execution_binding_sha256 !== planItem.execution_binding_sha256) {
    fail("legacy_r2_evidence_changed", "The legacy R2 generation changed after plan review.");
  }

  let uploaded = 0;
  for (const generation of Object.values(inspected.item.generations)) {
    if (generation?.state !== "migrate_legacy_mutable") continue;
    for (const artifact of generation.artifacts) {
      const body = inspected.bodies.get(artifact.legacy_key);
      if (!Buffer.isBuffer(body)) {
        fail("legacy_r2_body_missing", `Verified bytes are missing for ${artifact.legacy_key}.`);
      }
      const put = await objectStore.putObjectIfAbsent({
        key: artifact.immutable_key,
        body,
        contentType: artifact.content_type,
        sha256: artifact.sha256,
      });
      if (put?.created) uploaded += 1;
      const destination = validateReadObject(
        await objectStore.readObject({ key: artifact.immutable_key, maxBytes: MAX_OBJECT_BYTES }),
        {
          slot: artifact.slot,
          key: artifact.immutable_key,
          contentType: artifact.content_type,
        },
        { maxObjectBytes: MAX_OBJECT_BYTES, legacy: false },
      );
      if (
        destination.sha256 !== artifact.sha256
        || destination.byte_length !== artifact.byte_length
        || destination.metadata_sha256 !== artifact.sha256
        || (destination.checksum_sha256 && destination.checksum_sha256 !== artifact.sha256)
      ) {
        fail(
          "immutable_destination_mismatch",
          `Immutable destination verification failed for ${artifact.immutable_key}.`,
        );
      }
    }
  }

  // Bind the reviewed raw-meta projection state to one final immutable
  // HEAD/GET verification immediately before advancing the pointer.
  await verifyPlannedImmutableDestinations(inspected.item, objectStore);

  const casResult = await compareAndSetObjectKeys({
    sourceId: planItem.source_id,
    expectedUpdatedAt: canonicalCurrent.updated_at,
    latestObjectKeys: cloneJson(planItem.next_object_keys.latest),
    previousObjectKeys: cloneJson(planItem.next_object_keys.previous),
    metadataUpdates: metadataUpdatesFromPlanItem(planItem),
  });
  let after = null;
  if (casResult?.row) {
    try {
      after = canonicalSnapshotRow(casResult.row);
    } catch {
      // The CAS may already be committed even when its returned projection is
      // malformed. Treat that projection as discrepant and reload the row.
    }
  }
  if (casResult?.advanced !== true) {
    after = await loadAuthoritativePostCasRow({
      before: canonicalCurrent,
      planItem,
      pointerAdvanced: false,
      loadCurrentRow,
      uploaded,
    });
    if (!pointerAlreadyApplied(after, planItem)) {
      fail(
        "snapshot_pointer_cas_conflict",
        "Pointer CAS lost to a different source writer.",
        postCasFailureDetails({
          before: canonicalCurrent,
          after,
          planItem,
          pointerAdvanced: false,
          uploaded,
        }),
      );
    }
    return applyReceipt(planItem, "already_applied_after_cas", after, now, uploaded);
  }
  if (!after || !pointerAlreadyApplied(after, planItem)) {
    after = await loadAuthoritativePostCasRow({
      before: canonicalCurrent,
      planItem,
      pointerAdvanced: true,
      loadCurrentRow,
      uploaded,
    });
  }
  if (!pointerAlreadyApplied(after, planItem)) {
    fail(
      "snapshot_pointer_postcondition_failed",
      "Pointer keys did not match the reviewed plan after CAS.",
      postCasFailureDetails({
        before: canonicalCurrent,
        after,
        planItem,
        pointerAdvanced: true,
        uploaded,
      }),
    );
  }
  return applyReceipt(planItem, "applied", after, now, uploaded);
}

export function migrationFailureQuarantineEvidence({ plan, item, error, observedAt } = {}) {
  const reasonCode = normalizedReasonCode(error?.code || item?.failure?.reason_code || "legacy_r2_pointer_migration_failed");
  const postCasState = isObject(error?.details?.post_cas_state)
    ? cloneJson(error.details.post_cas_state)
    : null;
  return {
    schema_version: "awardping.legacy-r2-pointer-migration-quarantine.v7",
    observed_at: canonicalTimestamp(observedAt || new Date().toISOString(), "quarantine observed_at"),
    message: `Legacy R2 pointer migration failed closed (${reasonCode}): ${safeMessage(error || item?.failure?.message)}`,
    failure_stage: "legacy_r2_pointer_migration",
    reason_code: reasonCode,
    source_id: item?.source_id || null,
    plan_sha256: plan?.confirmation?.plan_sha256 || null,
    expected_snapshot_sha256: item?.expected_snapshot_sha256 || null,
    legacy_object_keys: legacyKeysFromItem(item),
    planned_immutable_object_keys: item?.next_object_keys || null,
    post_cas_state: postCasState,
    protection: {
      last_known_good_preserved: postCasState
        ? postCasState.last_known_good_preserved === true
        : true,
      pointer_advanced: postCasState?.pointer_advanced === true,
      legacy_objects_deleted: false,
      live_fetch_performed: false,
      public_event_written: false,
    },
    repair: {
      retry_mode: "manual_exact_r2_rehydration_then_automatic_resume",
      creates_api_charge: false,
      safe_action:
        "Verify the exact legacy R2 object set, pointer timestamp, metadata, hashes, lengths, and plan precondition. Rebuild the dry-run plan and retry only that source. Never fetch or promote a replacement baseline.",
    },
    policy: LEGACY_R2_POINTER_POLICY,
  };
}

export function stableJson(value) {
  return JSON.stringify(sortJson(value));
}

export function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function validateSourceIdentity(source, snapshot) {
  if (!isObject(source)) fail("source_row_missing", "The source row is missing.");
  if (requiredUuid(source.id, "source ID") !== snapshot.shared_award_source_id) {
    fail("source_id_mismatch", "The source and snapshot pointer IDs differ.");
  }
  if (requiredUuid(source.shared_award_id, "source award ID") !== snapshot.shared_award_id) {
    fail("source_award_mismatch", "The source and snapshot pointer award IDs differ.");
  }
  if (normalizedUrl(source.url) !== normalizedUrl(snapshot.source_url)) {
    fail("source_url_mismatch", "The source and snapshot pointer URLs differ.");
  }
}

function generationFromSnapshot(snapshot, name) {
  return {
    name,
    capturedAt: snapshot[`${name}_captured_at`],
    objectKeys: jsonObject(snapshot[`${name}_object_keys`]),
    hashes: jsonObject(snapshot[`${name}_hashes`]),
    metadata: jsonObject(snapshot[`${name}_metadata`]),
  };
}

function validateGenerationKeySet({ sourceId, kind, generationName, capturedAt, objectKeys }) {
  const entries = Object.entries(jsonObject(objectKeys));
  if (!entries.length) {
    if (capturedAt) {
      fail("generation_keys_missing", `${generationName} has captured_at but no object keys.`);
    }
    return { state: "absent", entries: [] };
  }
  if (!capturedAt) fail("generation_captured_at_missing", `${generationName} object keys lack captured_at.`);
  const states = new Set();
  let immutableFamily = null;
  let immutableVersion = null;
  const keys = new Set();
  const manifestEntries = [];
  for (const [slot, keyValue] of entries) {
    const definition = slotDefinition(slot);
    if (!definition) fail("object_slot_unknown", `Unknown ${generationName} object slot ${slot}.`);
    const key = requiredText(keyValue, `${generationName} ${slot} key`);
    if (key.includes("\\") || key.includes("..") || /[\u0000-\u001f]/u.test(key)) {
      fail("object_key_unsafe", `Unsafe ${generationName} ${slot} object key.`);
    }
    if (keys.has(key)) fail("generation_duplicate_key", `${generationName} aliases two slots.`);
    keys.add(key);
    const prefix = `visual-snapshots/sources/${sourceId}/`;
    if (!key.startsWith(prefix)) fail("object_key_source_mismatch", `${generationName} ${slot} belongs to another source.`);
    const remainder = key.slice(prefix.length);
    const parts = remainder.split("/");
    if (parts.length === 2 && parts[0] === generationName && parts[1] === definition.fileName) {
      states.add("legacy");
    } else if (parts.length === 3 && parts[0] === "approved") {
      fail(
        "object_key_approved_family_not_stage1",
        `${generationName} ${slot} uses the legacy approved family, not a Stage1 capture generation.`,
      );
    } else if (
      parts.length === 3
      && parts[0] === "captures"
      && VERSION_PATTERN.test(parts[1])
      && parts[2] === definition.fileName
    ) {
      states.add("immutable");
      if (immutableVersion && immutableVersion !== parts[1]) {
        fail("generation_mixed_immutable_versions", `${generationName} mixes immutable versions.`);
      }
      immutableFamily = "captures";
      immutableVersion = parts[1];
    } else {
      fail("object_key_malformed", `${generationName} ${slot} does not use a recognized exact key.`);
    }
    manifestEntries.push({ slot, key, ...definition });
  }
  if (states.size !== 1) {
    fail("generation_mixed_legacy_immutable", `${generationName} mixes mutable and immutable objects.`);
  }
  validateRequiredSlots(kind, manifestEntries, generationName);
  manifestEntries.sort((left, right) => left.slot.localeCompare(right.slot));
  const state = states.has("legacy") ? "legacy" : "immutable";
  return {
    state,
    family: state === "immutable" ? immutableFamily : null,
    version: state === "immutable" ? immutableVersion : null,
    entries: manifestEntries,
  };
}

function validateRequiredSlots(kind, entries, generationName) {
  const slots = new Set(entries.map((entry) => entry.slot));
  const required = kind === "pdf" ? ["pdf", "text", "meta"] : ["page", "thumb", "text", "meta"];
  for (const slot of required) {
    if (!slots.has(slot)) fail("generation_incomplete", `${generationName} is missing required slot ${slot}.`);
  }
  if (kind === "pdf" && [...slots].some((slot) => !required.includes(slot))) {
    fail("generation_kind_ambiguous", `${generationName} PDF contains webpage artifacts.`);
  }
  if (kind === "webpage" && slots.has("pdf")) {
    fail("generation_kind_ambiguous", `${generationName} webpage contains a PDF artifact.`);
  }
}

function validateGenerationPointerIdentity({ snapshot, generation }) {
  canonicalTimestamp(generation.capturedAt, `${generation.name} captured_at`);
  const requiredHashes = snapshot.kind === "pdf"
    ? ["file_hash", "text_hash"]
    : ["image_hash", "text_hash"];
  for (const field of requiredHashes) requiredSha256(generation.hashes[field], `${generation.name} ${field}`);
  for (const [field, value] of Object.entries(generation.hashes)) {
    if (value != null && value !== "") requiredSha256(value, `${generation.name} ${field}`);
  }
}

function validateReadObject(remote, entry, { maxObjectBytes, legacy }) {
  if (!isObject(remote) || !Buffer.isBuffer(remote.body)) {
    fail("r2_object_body_missing", `R2 ${entry.slot} has no readable byte body.`);
  }
  const actualBytes = remote.body.length;
  if (actualBytes > maxObjectBytes) {
    fail("r2_object_too_large", `R2 ${entry.slot} exceeds the ${maxObjectBytes}-byte repair limit.`);
  }
  if (Number(remote.byte_length) !== actualBytes) {
    fail("r2_object_length_mismatch", `R2 ${entry.slot} HEAD/GET byte length differs from its body.`);
  }
  const actualContentType = canonicalContentType(remote.content_type);
  const expectedContentType = canonicalContentType(entry.contentType);
  if (mediaType(actualContentType) !== mediaType(expectedContentType)) {
    fail("r2_object_content_type_mismatch", `R2 ${entry.slot} content type is unexpected.`);
  }
  if (!legacy && actualContentType !== expectedContentType) {
    fail(
      "immutable_destination_content_type_mismatch",
      `Immutable ${entry.slot} does not use the exact writer content type.`,
    );
  }
  const actualSha256 = sha256Bytes(remote.body);
  const metadataSha256 = optionalSha256(remote.metadata?.sha256 ?? remote.metadata_sha256);
  if (metadataSha256 && metadataSha256 !== actualSha256) {
    fail("r2_object_sha256_metadata_mismatch", `R2 ${entry.slot} custom SHA-256 metadata is wrong.`);
  }
  const checksumSha256 = checksumHex(remote.checksum_sha256);
  if (checksumSha256 && checksumSha256 !== actualSha256) {
    fail("r2_object_checksum_mismatch", `R2 ${entry.slot} checksum differs from its bytes.`);
  }
  const etag = normalizeEtag(remote.etag);
  if (!etag) fail("r2_object_etag_missing", `R2 ${entry.slot} has no ETag.`);
  if (/^[a-f0-9]{32}$/u.test(etag)) {
    const md5 = createHash("md5").update(remote.body).digest("hex");
    if (md5 !== etag) fail("r2_object_etag_mismatch", `R2 ${entry.slot} ETag differs from its bytes.`);
  }
  if (!legacy && metadataSha256 !== actualSha256) {
    fail("immutable_destination_sha256_metadata_missing", `Immutable ${entry.slot} lacks exact SHA-256 metadata.`);
  }
  if (!legacy && checksumSha256 !== actualSha256) {
    fail("immutable_destination_checksum_missing", `Immutable ${entry.slot} lacks its exact SHA-256 checksum.`);
  }
  return {
    slot: entry.slot,
    key: entry.key,
    body: remote.body,
    sha256: actualSha256,
    metadata_sha256: metadataSha256,
    checksum_sha256: checksumSha256,
    byte_length: actualBytes,
    content_type: expectedContentType,
    etag,
  };
}

function validateGenerationPayload({ snapshot, source, generation, manifest, artifacts }) {
  const bySlot = Object.fromEntries(artifacts.map((artifact) => [artifact.slot, artifact]));
  if (snapshot.kind === "pdf") {
    requireBodyHash(bySlot.pdf, generation.hashes.file_hash, `${generation.name} PDF`);
    requireLengthBindings(bySlot.pdf, generation.metadata.file_bytes, "file_bytes", generation.name);
  } else {
    requireBodyHash(bySlot.page, generation.hashes.image_hash, `${generation.name} page`);
    requireLengthBindings(bySlot.page, generation.metadata.page_bytes, "page_bytes", generation.name);
    requireLengthBindings(bySlot.thumb, generation.metadata.thumb_bytes, "thumb_bytes", generation.name);
  }
  const text = decodeUtf8(bySlot.text.body, `${generation.name} text`);
  const semanticText = stripOneTrailingLineBreak(text);
  if (sha256Bytes(Buffer.from(semanticText, "utf8")) !== generation.hashes.text_hash.toLowerCase()) {
    fail("r2_text_hash_mismatch", `${generation.name} semantic text SHA-256 differs from its pointer.`);
  }
  const textObjectBinding = bindOrValidateTextObjectBytes(
    bySlot.text.byte_length,
    generation.metadata,
    generation.name,
  );
  requireScalarLength(semanticText.length, generation.metadata.text_length, "text_length", generation.name);

  let meta;
  try {
    meta = JSON.parse(decodeUtf8(bySlot.meta.body, `${generation.name} meta`));
  } catch (error) {
    fail("r2_meta_json_invalid", `${generation.name} meta.json is invalid: ${safeMessage(error)}`);
  }
  if (meta?.source?.id !== snapshot.shared_award_source_id) {
    fail("r2_meta_source_mismatch", `${generation.name} metadata belongs to another source.`);
  }
  if (meta?.source?.shared_award_id !== snapshot.shared_award_id) {
    fail("r2_meta_award_mismatch", `${generation.name} metadata belongs to another award.`);
  }
  if (meta.kind !== snapshot.kind) fail("r2_meta_kind_mismatch", `${generation.name} metadata kind differs.`);
  if (!sameTimestamp(meta.captured_at, generation.capturedAt)) {
    fail("r2_meta_captured_at_mismatch", `${generation.name} metadata timestamp differs.`);
  }
  if (normalizedUrl(meta.source?.url) !== normalizedUrl(source.url)) {
    fail("r2_meta_source_url_mismatch", `${generation.name} metadata source URL differs.`);
  }
  validateSharedCaptureMetadataIdentity(generation.metadata, meta, generation.name);
  const requiredHashes = snapshot.kind === "pdf"
    ? ["file_hash", "text_hash"]
    : ["image_hash", "text_hash"];
  for (const field of requiredHashes) {
    if (requiredSha256(meta[field], `${generation.name} metadata ${field}`)
        !== requiredSha256(generation.hashes[field], `${generation.name} pointer ${field}`)) {
      fail("r2_meta_core_hash_mismatch", `${generation.name} metadata ${field} differs.`);
    }
  }
  if (snapshot.kind === "pdf") {
    requireScalarLength(bySlot.pdf.byte_length, meta.file_bytes, "metadata file_bytes", generation.name);
  } else {
    requireScalarLength(bySlot.page.byte_length, meta.page_bytes, "metadata page_bytes", generation.name);
    requireScalarLength(bySlot.thumb.byte_length, meta.thumb_bytes, "metadata thumb_bytes", generation.name);
  }
  requireScalarLength(semanticText.length, meta.text_length, "metadata text_length", generation.name);

  const metadataAfterLayout = snapshot.kind === "webpage"
    ? validateWebpageLayoutEvidence({
        generation,
        manifest,
        artifactsBySlot: bySlot,
        rawMeta: meta,
        metadataAfterTextBinding: textObjectBinding.metadataAfter,
      })
    : textObjectBinding.metadataAfter;
  const retainedProjection = bindOrValidateRetainedArtifactProjection({
    pointerMetadata: metadataAfterLayout,
    rawMeta: meta,
    kind: snapshot.kind,
    generation,
    manifest,
    artifactsBySlot: bySlot,
  });
  const metadataAfter = bindOrValidateArtifactBindings(
    retainedProjection.metadataAfter,
    artifacts,
    generation.name,
  );
  return {
    metadataBefore: textObjectBinding.metadataBefore,
    metadataAfter,
    metadataEnriched: stableJson(metadataAfter) !== stableJson(generation.metadata),
    metadataAddedPaths: addedJsonPaths(generation.metadata, metadataAfter),
    retainedProjectionBinding: retainedProjection.binding,
  };
}

function validateWebpageLayoutEvidence({
  generation,
  manifest,
  artifactsBySlot,
  rawMeta,
  metadataAfterTextBinding,
}) {
  const expansionCount = validateExpansionStateEvidence({
    generation,
    manifest,
    artifactsBySlot,
    rawMeta,
  });
  const metadataAfterCoverage = bindOrValidateExpansionStateCaptureCoverage({
    pointerMetadata: metadataAfterTextBinding,
    rawMeta,
    retainedStateCount: expansionCount,
    generationName: generation.name,
  });
  const pointerMetadata = generation.metadata;
  const layoutArtifact = artifactsBySlot.layout || null;
  const mainClaims = [
    layoutArtifact,
    generation.hashes.layout_hash,
    pointerMetadata.layout_hash,
    pointerMetadata.text_geometry?.geometry_hash,
    pointerMetadata.text_geometry?.screenshot?.image_hash,
    pointerMetadata.text_geometry?.screenshot?.image_ref,
    pointerMetadata.text_geometry?.file,
    pointerMetadata.localization?.geometry_hash,
    pointerMetadata.localization?.bound_image_hash,
    pointerMetadata.localization?.geometry_ready === true ? true : null,
    pointerMetadata.localization?.status === "geometry_ready" ? true : null,
    rawMeta.layout_hash,
    rawMeta.text_geometry?.geometry_hash,
    rawMeta.text_geometry?.screenshot?.image_hash,
    rawMeta.text_geometry?.screenshot?.image_ref,
    rawMeta.text_geometry?.file,
    rawMeta.localization?.geometry_hash,
    rawMeta.localization?.bound_image_hash,
    rawMeta.localization?.geometry_ready === true ? true : null,
    rawMeta.localization?.status === "geometry_ready" ? true : null,
    rawMeta.files?.layout,
  ].some(hasEvidenceClaim);

  if (!mainClaims) {
    if (expansionCount > 0) {
      fail(
        "r2_expansion_main_layout_missing",
        `${generation.name} has expansion geometry without the required main layout evidence.`,
      );
    }
    validateNoLayoutRawMetaClaims(rawMeta, generation.name);
    return addNoLayoutMetadataAccounting(metadataAfterCoverage, generation.name);
  }

  if (!layoutArtifact) {
    fail("r2_main_layout_object_missing", `${generation.name} claims layout evidence without a layout object.`);
  }
  if (expansionCount === 0) {
    if (
      !Object.hasOwn(pointerMetadata, "expansion_state_count")
      || nonNegativeInteger(pointerMetadata.expansion_state_count) !== 0
      || !Array.isArray(pointerMetadata.expansion_state_screenshots)
      || pointerMetadata.expansion_state_screenshots.length !== 0
      || !Array.isArray(rawMeta.expansion_state_screenshots)
      || rawMeta.expansion_state_screenshots.length !== 0
    ) {
      fail(
        "r2_main_layout_zero_expansion_accounting_missing",
        `${generation.name} layout lacks complete zero-expansion accounting.`,
      );
    }
  }
  const layout = parseJsonObjectBytes(
    layoutArtifact.body,
    `${generation.name} layout`,
    "r2_layout_json_invalid",
  );
  const expectedLayoutHash = requireEqualSha256Claims([
    ["layout object", layout.geometry_hash],
    ["pointer hashes", generation.hashes.layout_hash],
    ["pointer metadata", pointerMetadata.layout_hash],
    ["pointer text geometry", pointerMetadata.text_geometry?.geometry_hash],
    ["pointer localization", pointerMetadata.localization?.geometry_hash],
    ["retained metadata", rawMeta.layout_hash],
    ["retained text geometry", rawMeta.text_geometry?.geometry_hash],
    ["retained localization", rawMeta.localization?.geometry_hash],
  ], `${generation.name} main layout`);
  const expectedImageHash = requireEqualSha256Claims([
    ["pointer image", generation.hashes.image_hash],
    ["layout screenshot", layout.screenshot?.image_hash],
    ["pointer text geometry screenshot", pointerMetadata.text_geometry?.screenshot?.image_hash],
    ["pointer localization image", pointerMetadata.localization?.bound_image_hash],
    ["retained image", rawMeta.image_hash],
    ["retained text geometry screenshot", rawMeta.text_geometry?.screenshot?.image_hash],
    ["retained localization image", rawMeta.localization?.bound_image_hash],
  ], `${generation.name} main layout image`);
  const verification = verifyVisualTextGeometryBinding(layout, expectedImageHash);
  if (!verification.valid || layout.geometry_hash.toLowerCase() !== expectedLayoutHash) {
    fail(
      "r2_main_layout_geometry_invalid",
      `${generation.name} main layout geometry verification failed (${verification.reason}).`,
    );
  }
  if (layout.state_id !== "main") {
    fail("r2_main_layout_state_mismatch", `${generation.name} main layout state_id is not main.`);
  }
  if (!sameTimestamp(layout.captured_at, generation.capturedAt)) {
    fail("r2_main_layout_timestamp_mismatch", `${generation.name} main layout timestamp differs.`);
  }
  requireSameArtifactReferences([
    ["layout screenshot", layout.screenshot?.image_ref],
    ["pointer text geometry screenshot", pointerMetadata.text_geometry?.screenshot?.image_ref],
    ["retained text geometry screenshot", rawMeta.text_geometry?.screenshot?.image_ref],
    ["retained page file", rawMeta.files?.page],
  ], `${generation.name} main screenshot`);
  requireSameArtifactReferences([
    ["pointer text geometry file", pointerMetadata.text_geometry?.file],
    ["retained text geometry file", rawMeta.text_geometry?.file],
    ["retained layout file", rawMeta.files?.layout],
  ], `${generation.name} main layout file`);
  for (const [label, localization] of [
    ["pointer", pointerMetadata.localization],
    ["retained", rawMeta.localization],
  ]) {
    const unavailableReason = localization?.unavailable_reason;
    if (
      localization?.status !== "geometry_ready"
      || (
        unavailableReason !== null
        && unavailableReason !== undefined
        && (
          typeof unavailableReason !== "string"
          || Boolean(unavailableReason.trim())
        )
      )
      || localization?.geometry_ready !== true
      || localization?.accounted_for !== true
      || localization?.semantic_crop_contract !== "visual-exact-text-binding-v2"
    ) {
      fail(
        "r2_main_layout_localization_binding_invalid",
        `${generation.name} ${label} localization does not truthfully bind retained geometry.`,
      );
    }
    if (!sameTimestamp(localization.captured_at, generation.capturedAt)) {
      fail(
        "r2_main_layout_localization_timestamp_mismatch",
        `${generation.name} ${label} localization timestamp differs.`,
      );
    }
  }
  return metadataAfterCoverage;
}

function bindOrValidateExpansionStateCaptureCoverage({
  pointerMetadata,
  rawMeta,
  retainedStateCount,
  generationName,
}) {
  const coverageOptions = { expectedRetainedStateCount: retainedStateCount };
  const rawCoverage = legacyExpansionStateCaptureCoverageFromMetadata(rawMeta, {
    retainedStateCount,
  });
  if (!rawCoverage) {
    if (hasExpansionStateCaptureCoverageClaim(rawMeta)) {
      fail(
        "r2_expansion_coverage_source_invalid",
        `${generationName} retained metadata contains malformed or partial expansion coverage.`,
      );
    }
    if (Object.hasOwn(pointerMetadata, "expansion_state_capture_coverage")) {
      fail(
        "r2_expansion_coverage_source_incomplete",
        `${generationName} pointer coverage has no exact retained-metadata proof.`,
      );
    }
    return jsonObject(pointerMetadata);
  }
  const before = jsonObject(pointerMetadata);
  const pointerCoverage = canonicalExpansionStateCaptureCoverage(
    before.expansion_state_capture_coverage,
    coverageOptions,
  );
  if (Object.hasOwn(before, "expansion_state_capture_coverage")) {
    if (
      !pointerCoverage
      || !sameExpansionStateCaptureCoverage(pointerCoverage, rawCoverage, coverageOptions)
    ) {
      fail(
        "r2_expansion_coverage_mismatch",
        `${generationName} pointer expansion coverage differs from retained capture evidence.`,
      );
    }
    return before;
  }
  return {
    ...before,
    expansion_state_capture_coverage: rawCoverage,
  };
}

function validateSharedCaptureMetadataIdentity(pointerMetadata, rawMeta, generationName) {
  const pointer = jsonObject(pointerMetadata);
  const raw = jsonObject(rawMeta);
  const pointerFinalUrl = nullableText(pointer.final_url);
  const rawFinalUrl = nullableText(raw.final_url);
  if (Boolean(pointerFinalUrl) !== Boolean(rawFinalUrl)) {
    fail("r2_meta_final_url_binding_missing", `${generationName} final URL binding is incomplete.`);
  }
  if (pointerFinalUrl && normalizedUrl(pointerFinalUrl) !== normalizedUrl(rawFinalUrl)) {
    fail("r2_meta_final_url_mismatch", `${generationName} final URL metadata differs.`);
  }
  for (const field of [
    "capture_profile",
    "page_title",
    "status_code",
    "status_text",
    "content_type",
    "stage1_baseline_activation",
    "body_text_length",
    "main_content_text_length",
    "nav_header_footer_text_length",
    "expansion_text_length",
    "dimensions",
    "page_count",
    "pdf_text_error",
  ]) {
    const pointerPresent = metadataValuePresent(pointer[field]);
    const rawPresent = metadataValuePresent(raw[field]);
    if (pointerPresent !== rawPresent) {
      fail(
        "r2_meta_identity_binding_missing",
        `${generationName} ${field} metadata binding is incomplete.`,
      );
    }
    if (pointerPresent && stableJson(pointer[field]) !== stableJson(raw[field])) {
      fail("r2_meta_identity_mismatch", `${generationName} ${field} metadata differs.`);
    }
  }
}

function bindOrValidateArtifactBindings(metadata, artifacts, generationName) {
  const before = jsonObject(metadata);
  const expected = artifactBindingsFromArtifacts(artifacts);
  const after = cloneJson(before);
  if (!Object.hasOwn(after, "artifact_bindings_schema")) {
    after.artifact_bindings_schema = ARTIFACT_BINDINGS_SCHEMA;
  } else if (after.artifact_bindings_schema !== ARTIFACT_BINDINGS_SCHEMA) {
    fail(
      "r2_artifact_bindings_schema_mismatch",
      `${generationName} artifact_bindings_schema is unsupported.`,
    );
  }
  if (!Object.hasOwn(after, "artifact_bindings")) {
    after.artifact_bindings = expected;
    return after;
  }
  if (!isObject(after.artifact_bindings)) {
    fail("r2_artifact_bindings_malformed", `${generationName} artifact_bindings is malformed.`);
  }
  if (stableJson(after.artifact_bindings) !== stableJson(expected)) {
    fail(
      "r2_artifact_bindings_mismatch",
      `${generationName} artifact_bindings differs from the verified retained object set.`,
    );
  }
  return after;
}

function bindOrValidateRetainedArtifactProjection({
  pointerMetadata,
  rawMeta,
  kind,
  generation,
  manifest,
  artifactsBySlot,
}) {
  const before = jsonObject(pointerMetadata);
  const after = cloneJson(before);
  const expected = retainedArtifactProjectionFromManifest({
    kind,
    generation,
    manifest,
  });
  const pointerHasProjection = Object.hasOwn(before, "retained_artifact_projection");
  const rawHasProjection = Object.hasOwn(rawMeta, "retained_artifact_projection");
  if (Object.hasOwn(rawMeta, "legacy_retained_artifact_projection_provenance")) {
    fail(
      "r2_retained_projection_raw_provenance_unexpected",
      `${generation.name} retained raw metadata contains pointer-only projection provenance.`,
    );
  }
  const pointerProjection = canonicalRetainedArtifactProjection(
    before.retained_artifact_projection,
  );
  const rawProjection = canonicalRetainedArtifactProjection(
    rawMeta.retained_artifact_projection,
  );

  if (pointerHasProjection && stableJson(pointerProjection) !== stableJson(expected)) {
    fail(
      "r2_retained_projection_pointer_mismatch",
      `${generation.name} pointer retained-artifact projection differs from the verified manifest.`,
    );
  }
  if (rawHasProjection && stableJson(rawProjection) !== stableJson(expected)) {
    fail(
      "r2_retained_projection_meta_mismatch",
      `${generation.name} retained metadata projection differs from the verified manifest.`,
    );
  }
  if (!pointerHasProjection) after.retained_artifact_projection = expected;

  const provenanceField = "legacy_retained_artifact_projection_provenance";
  const metaHash = requiredSha256(
    artifactsBySlot.meta?.sha256,
    `${generation.name} retained metadata raw SHA-256`,
  );
  if (!rawHasProjection) {
    const expectedProvenance = buildLegacyRetainedProjectionProvenance({
      rawMetaSha256: metaHash,
      projectionSha256: sha256Text(stableJson(expected)),
    });
    if (Object.hasOwn(before, provenanceField)) {
      if (stableJson(before[provenanceField]) !== stableJson(expectedProvenance)) {
        fail(
          "r2_retained_projection_provenance_mismatch",
          `${generation.name} legacy projection provenance is invalid.`,
        );
      }
    } else {
      after[provenanceField] = expectedProvenance;
    }
  } else if (Object.hasOwn(before, provenanceField)) {
    fail(
      "r2_retained_projection_provenance_unexpected",
      `${generation.name} legacy projection provenance conflicts with a retained raw projection.`,
    );
  }
  return {
    metadataAfter: after,
    binding: {
      schema: LEGACY_RETAINED_PROJECTION_PLAN_BINDING_SCHEMA,
      raw_meta_projection_state: rawHasProjection
        ? "canonical_present"
        : "absent",
      raw_meta_sha256: metaHash,
      projection_sha256: sha256Text(stableJson(expected)),
    },
  };
}

function retainedArtifactProjectionFromManifest({ kind, generation, manifest }) {
  const slots = new Set(manifest.entries.map((entry) => entry.slot));
  const layoutRetained = kind === "webpage" && slots.has("layout");
  const expansionPages = [...slots]
    .map((slot) => /^expansion_state_(\d{2})$/u.exec(slot)?.[1] || null)
    .filter(Boolean)
    .toSorted();
  const expansionLayouts = [...slots]
    .map((slot) => /^expansion_state_(\d{2})_layout$/u.exec(slot)?.[1] || null)
    .filter(Boolean)
    .toSorted();
  if (
    stableJson(expansionPages) !== stableJson(expansionLayouts)
    || expansionPages.some((suffix, index) => suffix !== String(index + 1).padStart(2, "0"))
    || (kind === "pdf" && (
      slots.has("layout")
      || expansionPages.length > 0
      || expansionLayouts.length > 0
    ))
  ) {
    fail(
      "r2_retained_projection_expansion_manifest_invalid",
      `${generation.name} expansion artifact manifest is incomplete or non-contiguous.`,
    );
  }
  const claimedLayoutHash = optionalSha256(
    generation.hashes?.layout_hash || generation.metadata?.layout_hash,
  );
  const layoutHash = layoutRetained
    ? requiredSha256(
        claimedLayoutHash,
        `${generation.name} retained layout hash`,
      )
    : null;
  if (!layoutRetained && claimedLayoutHash) {
    fail(
      "r2_retained_projection_layout_hash_unretained",
      `${generation.name} claims a layout hash without a retained layout artifact.`,
    );
  }
  return {
    schema: RETAINED_ARTIFACT_PROJECTION_SCHEMA,
    kind,
    localization_status: kind === "pdf"
      ? "not_applicable_pdf"
      : layoutRetained
        ? "exact_geometry_available"
        : "evidence_only_geometry_unavailable",
    authoritative: {
      layout_retained: layoutRetained,
      layout_hash: layoutHash,
      expansion_state_count: kind === "webpage" ? expansionPages.length : 0,
    },
  };
}

function canonicalRetainedArtifactProjection(value) {
  if (!isObject(value)) return null;
  const authority = jsonObject(value.authoritative);
  const kind = value.kind;
  const layoutHash = authority.layout_hash === null
    ? null
    : optionalSha256(authority.layout_hash);
  const expectedStatus = kind === "pdf"
    ? "not_applicable_pdf"
    : authority.layout_retained === true
      ? "exact_geometry_available"
      : "evidence_only_geometry_unavailable";
  if (
    value.schema !== RETAINED_ARTIFACT_PROJECTION_SCHEMA
    || !new Set(["webpage", "pdf"]).has(kind)
    || value.localization_status !== expectedStatus
    || typeof authority.layout_retained !== "boolean"
    || nonNegativeInteger(authority.expansion_state_count) === null
    || (authority.layout_retained && !layoutHash)
    || (!authority.layout_retained && authority.layout_hash !== null)
    || (kind === "pdf" && (authority.layout_retained || authority.expansion_state_count !== 0))
  ) return null;
  return {
    schema: value.schema,
    kind,
    localization_status: value.localization_status,
    authoritative: {
      layout_retained: authority.layout_retained,
      layout_hash: layoutHash,
      expansion_state_count: authority.expansion_state_count,
    },
  };
}

function artifactBindingsFromArtifacts(artifacts) {
  const entries = [...artifacts]
    .sort((left, right) => left.slot.localeCompare(right.slot))
    .map((artifact) => [artifact.slot, {
      sha256: requiredSha256(artifact.sha256, `${artifact.slot} raw artifact SHA-256`),
      byte_length: positiveInteger(artifact.byte_length, `${artifact.slot} raw artifact byte length`),
      content_type: requiredText(artifact.content_type, `${artifact.slot} raw artifact content type`),
      hash_mode: "raw_sha256",
    }]);
  if (!entries.length) fail("r2_artifact_bindings_empty", "A present generation has no artifact bindings.");
  return Object.fromEntries(entries);
}

function validateExpansionStateEvidence({ generation, manifest, artifactsBySlot, rawMeta }) {
  const pageIndexes = manifest.entries
    .map((entry) => /^expansion_state_(\d{2})$/u.exec(entry.slot)?.[1] || null)
    .filter(Boolean)
    .toSorted();
  const layoutIndexes = manifest.entries
    .map((entry) => /^expansion_state_(\d{2})_layout$/u.exec(entry.slot)?.[1] || null)
    .filter(Boolean)
    .toSorted();
  const allIndexes = [...new Set([...pageIndexes, ...layoutIndexes])].toSorted();
  for (const suffix of allIndexes) {
    if (!pageIndexes.includes(suffix) || !layoutIndexes.includes(suffix)) {
      fail(
        "r2_expansion_pair_incomplete",
        `${generation.name} expansion state ${suffix} lacks a screenshot/layout pair.`,
      );
    }
  }
  for (const [index, suffix] of pageIndexes.entries()) {
    if (suffix !== String(index + 1).padStart(2, "0")) {
      fail("r2_expansion_indexes_noncontiguous", `${generation.name} expansion indexes are not contiguous.`);
    }
  }

  const pointerHasStates = Object.hasOwn(generation.metadata, "expansion_state_screenshots");
  const rawHasStates = Object.hasOwn(rawMeta, "expansion_state_screenshots");
  const pointerStates = pointerHasStates && Array.isArray(generation.metadata.expansion_state_screenshots)
    ? generation.metadata.expansion_state_screenshots
    : [];
  const rawStates = rawHasStates && Array.isArray(rawMeta.expansion_state_screenshots)
    ? rawMeta.expansion_state_screenshots
    : [];
  const rawFileStatesPresent = Object.hasOwn(jsonObject(rawMeta.files), "expansion_states");
  const rawFileStates = rawFileStatesPresent && Array.isArray(rawMeta.files.expansion_states)
    ? rawMeta.files.expansion_states
    : [];
  if (pointerHasStates && !Array.isArray(generation.metadata.expansion_state_screenshots)) {
    fail("r2_expansion_pointer_states_malformed", `${generation.name} pointer expansion states are malformed.`);
  }
  if (rawHasStates && !Array.isArray(rawMeta.expansion_state_screenshots)) {
    fail("r2_expansion_meta_states_malformed", `${generation.name} retained expansion states are malformed.`);
  }
  if (rawFileStatesPresent && !Array.isArray(rawMeta.files.expansion_states)) {
    fail("r2_expansion_file_states_malformed", `${generation.name} retained expansion file claims are malformed.`);
  }
  const pointerHasCount = Object.hasOwn(generation.metadata, "expansion_state_count");
  const pointerCount = pointerHasCount
    ? nonNegativeInteger(generation.metadata.expansion_state_count)
    : null;
  if (pointerHasCount && pointerCount === null) {
    fail("r2_expansion_count_malformed", `${generation.name} expansion_state_count is malformed.`);
  }
  const rawHasCount = Object.hasOwn(rawMeta, "expansion_state_count");
  const rawCount = rawHasCount ? nonNegativeInteger(rawMeta.expansion_state_count) : null;
  if (rawHasCount && rawCount === null) {
    fail("r2_expansion_meta_count_malformed", `${generation.name} retained expansion count is malformed.`);
  }
  const claimed = Boolean(
    allIndexes.length
    || pointerStates.length
    || rawStates.length
    || rawFileStates.length
    || (pointerCount || 0) > 0
    || (rawCount || 0) > 0
  );
  if (!claimed) {
    if ((pointerHasCount && pointerCount !== 0) || (rawHasCount && rawCount !== 0)) {
      fail("r2_expansion_zero_count_mismatch", `${generation.name} zero-state accounting conflicts.`);
    }
    return 0;
  }
  if (
    !pointerHasCount
    || pointerCount !== pageIndexes.length
    || pointerStates.length !== pageIndexes.length
    || rawStates.length !== pageIndexes.length
    || !rawFileStatesPresent
    || rawFileStates.length !== pageIndexes.length
    || (rawHasCount && rawCount !== pageIndexes.length)
  ) {
    fail(
      "r2_expansion_count_mismatch",
      `${generation.name} expansion keys, count, pointer metadata, and retained metadata disagree.`,
    );
  }

  const rawIndexes = new Set();
  for (const [arrayIndex, suffix] of pageIndexes.entries()) {
    const expectedStateId = `expansion-state-${suffix}`;
    const pointer = jsonObject(generation.metadata.expansion_state_screenshots[arrayIndex]);
    const raw = jsonObject(rawMeta.expansion_state_screenshots[arrayIndex]);
    const rawFile = jsonObject(rawFileStates[arrayIndex]);
    if (
      pointer.state_id !== expectedStateId
      || raw.state_id !== expectedStateId
      || rawFile.state_id !== expectedStateId
    ) {
      fail("r2_expansion_state_id_mismatch", `${generation.name} expansion ${suffix} state identity differs.`);
    }
    const rawIndex = nonNegativeInteger(raw.index);
    if (rawIndex === null || rawIndexes.has(rawIndex)) {
      fail("r2_expansion_source_index_invalid", `${generation.name} expansion ${suffix} source index is invalid.`);
    }
    rawIndexes.add(rawIndex);
    if (Object.hasOwn(pointer, "index") && Number(pointer.index) !== rawIndex) {
      fail("r2_expansion_source_index_mismatch", `${generation.name} expansion ${suffix} source index differs.`);
    }
    if (
      !cleanText(pointer.label)
      || cleanText(pointer.label) !== cleanText(raw.label)
      || cleanText(pointer.label) !== cleanText(rawFile.label)
    ) {
      fail("r2_expansion_label_mismatch", `${generation.name} expansion ${suffix} label differs.`);
    }
    if (
      !Object.hasOwn(pointer, "isolation")
      || !Object.hasOwn(raw, "isolation")
      || stableJson(pointer.isolation) !== stableJson(raw.isolation)
    ) {
      fail(
        "r2_expansion_isolation_mismatch",
        `${generation.name} expansion ${suffix} isolation evidence differs.`,
      );
    }

    const pageArtifact = artifactsBySlot[`expansion_state_${suffix}`];
    const layoutArtifact = artifactsBySlot[`expansion_state_${suffix}_layout`];
    const expectedImageHash = requireEqualSha256Claims([
      ["retained screenshot bytes", pageArtifact?.sha256],
      ["pointer expansion image", pointer.image_hash],
      ["retained expansion image", raw.image_hash],
      ["pointer expansion geometry image", pointer.text_geometry?.screenshot?.image_hash],
      ["retained expansion geometry image", raw.text_geometry?.screenshot?.image_hash],
    ], `${generation.name} expansion ${suffix} image`);
    requireEqualPositiveLengths([
      ["retained screenshot bytes", pageArtifact?.byte_length],
      ["pointer page_bytes", pointer.page_bytes],
      ["retained metadata page_bytes", raw.page_bytes],
    ], `${generation.name} expansion ${suffix}`);
    requireEqualSha256Claims([
      ["pointer expansion text", pointer.text_hash],
      ["retained expansion text", raw.text_hash],
    ], `${generation.name} expansion ${suffix} text`);
    requireEqualNonNegativeLengths([
      ["pointer text_length", pointer.text_length],
      ["retained metadata text_length", raw.text_length],
    ], `${generation.name} expansion ${suffix}`);

    const layout = parseJsonObjectBytes(
      layoutArtifact?.body,
      `${generation.name} expansion ${suffix} layout`,
      "r2_expansion_layout_json_invalid",
    );
    const expectedLayoutHash = requireEqualSha256Claims([
      ["layout object", layout.geometry_hash],
      ["pointer expansion layout", pointer.layout_hash],
      ["retained expansion layout", raw.layout_hash],
      ["pointer expansion geometry", pointer.text_geometry?.geometry_hash],
      ["retained expansion geometry", raw.text_geometry?.geometry_hash],
    ], `${generation.name} expansion ${suffix} layout`);
    const verification = verifyVisualTextGeometryBinding(layout, expectedImageHash);
    if (!verification.valid || layout.geometry_hash.toLowerCase() !== expectedLayoutHash) {
      fail(
        "r2_expansion_geometry_invalid",
        `${generation.name} expansion ${suffix} geometry verification failed (${verification.reason}).`,
      );
    }
    if (layout.state_id !== expectedStateId) {
      fail("r2_expansion_layout_state_mismatch", `${generation.name} expansion ${suffix} layout state differs.`);
    }
    validateExpansionTimestamp(layout.captured_at, generation.capturedAt, pointer, raw, generation.name, suffix);
    requireSameArtifactReferences([
      ["layout screenshot", layout.screenshot?.image_ref],
      ["pointer geometry screenshot", pointer.text_geometry?.screenshot?.image_ref],
      ["retained geometry screenshot", raw.text_geometry?.screenshot?.image_ref],
      ["retained expansion page", raw.page],
      ["retained expansion file-list page", rawFile.page],
    ], `${generation.name} expansion ${suffix} screenshot`);
    requireSameArtifactReferences([
      ["pointer geometry file", pointer.text_geometry?.file],
      ["retained geometry file", raw.text_geometry?.file],
      ["retained expansion layout", raw.layout],
      ["retained expansion file-list layout", rawFile.layout],
    ], `${generation.name} expansion ${suffix} layout file`);
  }
  return pageIndexes.length;
}

function validateExpansionTimestamp(value, generationCapturedAt, pointer, raw, name, suffix) {
  const timestamp = Date.parse(String(value || ""));
  const generationTimestamp = Date.parse(String(generationCapturedAt || ""));
  if (!Number.isFinite(timestamp) || !Number.isFinite(generationTimestamp)) {
    fail("r2_expansion_timestamp_invalid", `${name} expansion ${suffix} timestamp is invalid.`);
  }
  for (const [label, claimed] of [["pointer", pointer.captured_at], ["retained", raw.captured_at]]) {
    if (claimed && !sameTimestamp(claimed, value)) {
      fail("r2_expansion_timestamp_mismatch", `${name} expansion ${suffix} ${label} timestamp differs.`);
    }
  }
  if (timestamp < generationTimestamp - 60_000 || timestamp > generationTimestamp + 60 * 60_000) {
    fail(
      "r2_expansion_timestamp_out_of_capture_window",
      `${name} expansion ${suffix} timestamp is outside its capture window.`,
    );
  }
}

function validateNoLayoutRawMetaClaims(rawMeta, generationName) {
  const localization = jsonObject(rawMeta.localization);
  if (
    hasEvidenceClaim(rawMeta.layout_hash)
    || hasEvidenceClaim(rawMeta.text_geometry?.geometry_hash)
    || hasEvidenceClaim(rawMeta.text_geometry?.screenshot?.image_hash)
    || hasEvidenceClaim(rawMeta.files?.layout)
    || localization.geometry_ready === true
    || hasEvidenceClaim(localization.geometry_hash)
    || hasEvidenceClaim(localization.bound_image_hash)
  ) {
    fail(
      "r2_no_layout_meta_claim_conflict",
      `${generationName} retained metadata claims layout evidence that is not retained.`,
    );
  }
}

function addNoLayoutMetadataAccounting(metadata, generationName) {
  const next = cloneJson(metadata);
  if (Object.hasOwn(next, "text_geometry") && next.text_geometry !== null) {
    const textGeometry = next.text_geometry;
    const status = isObject(textGeometry) ? cleanText(textGeometry.status) : "";
    if (
      !isObject(textGeometry)
      || !(status === "unavailable" || status.startsWith("unavailable_"))
    ) {
      fail(
        "r2_no_layout_text_geometry_conflict",
        `${generationName} text geometry does not truthfully record layout unavailability.`,
      );
    }
  }
  if (!Object.hasOwn(next, "expansion_state_count")) next.expansion_state_count = 0;
  else if (nonNegativeInteger(next.expansion_state_count) !== 0) {
    fail("r2_no_layout_expansion_count_conflict", `${generationName} zero-layout expansion count conflicts.`);
  }
  if (!Object.hasOwn(next, "expansion_state_screenshots")) next.expansion_state_screenshots = [];
  else if (!Array.isArray(next.expansion_state_screenshots) || next.expansion_state_screenshots.length) {
    fail("r2_no_layout_expansion_states_conflict", `${generationName} zero-layout expansion states conflict.`);
  }

  const canonical = {
    status: "evidence_only_geometry_unavailable",
    geometry_ready: false,
    accounted_for: true,
    unavailable_reason: "legacy_no_retained_geometry",
  };
  if (!Object.hasOwn(next, "localization")) next.localization = canonical;
  else {
    if (!isObject(next.localization)) {
      fail("r2_no_layout_localization_malformed", `${generationName} localization accounting is malformed.`);
    }
    const localization = cloneJson(next.localization);
    for (const [field, value] of Object.entries(canonical)) {
      if (!Object.hasOwn(localization, field)) localization[field] = value;
    }
    if (
      !layoutExplicitlyUnavailable(localization)
      || localization.geometry_ready !== false
      || localization.accounted_for !== true
      || !cleanText(localization.unavailable_reason)
    ) {
      fail(
        "r2_no_layout_localization_conflict",
        `${generationName} existing localization values conflict with truthful unavailability accounting.`,
      );
    }
    next.localization = localization;
  }
  return next;
}

function parseJsonObjectBytes(value, label, code) {
  if (!Buffer.isBuffer(value)) fail(code, `${label} bytes are missing.`);
  let parsed;
  try {
    parsed = JSON.parse(decodeUtf8(value, label));
  } catch (error) {
    fail(code, `${label} is invalid JSON: ${safeMessage(error)}`);
  }
  if (!isObject(parsed)) fail(code, `${label} is not a JSON object.`);
  return parsed;
}

function requireEqualSha256Claims(claims, label) {
  const values = claims.map(([claim, value]) => [claim, requiredSha256(value, `${label} ${claim}`)]);
  if (new Set(values.map(([, value]) => value)).size !== 1) {
    fail("r2_sha256_claim_mismatch", `${label} SHA-256 claims disagree.`);
  }
  return values[0][1];
}

function requireEqualPositiveLengths(claims, label) {
  const values = claims.map(([claim, value]) => [claim, positiveInteger(value, `${label} ${claim}`)]);
  if (new Set(values.map(([, value]) => value)).size !== 1) {
    fail("r2_positive_length_claim_mismatch", `${label} positive length claims disagree.`);
  }
  return values[0][1];
}

function requireEqualNonNegativeLengths(claims, label) {
  const values = claims.map(([claim, value]) => [claim, nonNegativeIntegerRequired(value, `${label} ${claim}`)]);
  if (new Set(values.map(([, value]) => value)).size !== 1) {
    fail("r2_length_claim_mismatch", `${label} length claims disagree.`);
  }
  return values[0][1];
}

function requireSameArtifactReferences(claims, label) {
  const values = claims.map(([claim, value]) => [claim, normalizedArtifactReference(value, `${label} ${claim}`)]);
  if (new Set(values.map(([, value]) => value)).size !== 1) {
    fail("r2_artifact_reference_mismatch", `${label} artifact references disagree.`);
  }
  return values[0][1];
}

function normalizedArtifactReference(value, label) {
  const reference = requiredText(value, label).replaceAll("\\", "/").replace(/^\.\//u, "");
  if (reference.startsWith("/") || reference.includes("..") || /[\u0000-\u001f]/u.test(reference)) {
    fail("r2_artifact_reference_unsafe", `${label} is unsafe.`);
  }
  return reference;
}

function layoutExplicitlyUnavailable(value) {
  const localization = jsonObject(value);
  const status = cleanText(localization.status);
  if (
    new Set(["geometry_ready", "ready", "exact_geometry_available"]).has(status)
    || localization.geometry_ready === true
    || hasEvidenceClaim(localization.geometry_hash)
    || hasEvidenceClaim(localization.bound_image_hash)
  ) return false;
  return Boolean(
    status === "unavailable"
    || status.startsWith("unavailable_")
    || status === "capture_layout_unavailable"
    || status === "evidence_only_geometry_unavailable"
    || (
      localization.accounted_for === true
      && localization.geometry_ready === false
      && cleanText(localization.unavailable_reason)
    )
  );
}

function hasEvidenceClaim(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return Boolean(value.trim());
  return true;
}

function requireBodyHash(artifact, expected, label) {
  if (!artifact || artifact.sha256 !== requiredSha256(expected, `${label} SHA-256`)) {
    fail("r2_object_hash_mismatch", `${label} bytes differ from the pointer SHA-256.`);
  }
}

function requireLengthBindings(artifact, expected, field, generationName) {
  if (!artifact) fail("r2_object_missing", `${generationName} ${field} artifact is missing.`);
  requireScalarLength(artifact.byte_length, expected, field, generationName);
}

function requireScalarLength(actual, expected, field, generationName) {
  const expectedNumber = typeof expected === "number" ? expected : Number.NaN;
  if (!Number.isSafeInteger(expectedNumber) || expectedNumber < 0) {
    fail("r2_length_binding_missing", `${generationName} ${field} is not a complete length binding.`);
  }
  if (actual !== expectedNumber) {
    fail("r2_length_binding_mismatch", `${generationName} ${field} differs from retained bytes.`);
  }
}

function bindOrValidateTextObjectBytes(actual, metadata, generationName) {
  if (!Number.isSafeInteger(actual) || actual <= 0) {
    fail("r2_text_object_empty", `${generationName} retained text object is empty.`);
  }
  const before = jsonObject(metadata);
  if (!Object.hasOwn(before, "text_object_bytes")) {
    return {
      metadataBefore: before,
      metadataAfter: { ...before, text_object_bytes: actual },
      metadataEnriched: true,
    };
  }
  const expectedNumber = typeof before.text_object_bytes === "number"
    ? before.text_object_bytes
    : Number.NaN;
  if (!Number.isSafeInteger(expectedNumber) || expectedNumber <= 0) {
    fail(
      "r2_text_object_bytes_binding_malformed",
      `${generationName} text_object_bytes is present but is not a positive integer.`,
    );
  }
  if (actual !== expectedNumber) {
    fail(
      "r2_text_object_bytes_binding_mismatch",
      `${generationName} text_object_bytes differs from the retained text object bytes.`,
    );
  }
  return {
    metadataBefore: before,
    metadataAfter: before,
    metadataEnriched: false,
  };
}

function migrationItemExecutionBinding(item) {
  return sha256Text(stableJson({
    source_id: item.source_id,
    expected_snapshot_sha256: item.expected_snapshot_sha256,
    expected_preserved_fields_sha256: item.expected_preserved_fields_sha256,
    expected_postcondition_sha256: item.expected_postcondition_sha256,
    next_object_keys: item.next_object_keys,
    next_metadata: item.next_metadata,
    metadata_fields_to_update: item.metadata_fields_to_update,
    generations: Object.fromEntries(
      Object.entries(item.generations || {}).map(([name, generation]) => [name, {
        state: generation.state,
        version: generation.version || null,
        captured_at: generation.captured_at || null,
        object_keys_before: generation.object_keys_before || generation.object_keys || null,
        object_keys_after: generation.object_keys_after || generation.object_keys || null,
        hashes: generation.hashes || null,
        metadata_before: generation.metadata_before || null,
        metadata_after: generation.metadata_after || null,
        metadata_enriched: generation.metadata_enriched === true,
        metadata_added_paths: generation.metadata_added_paths || null,
        retained_projection_binding: generation.retained_projection_binding || null,
        artifacts: generation.artifacts || null,
        verified_artifacts: generation.verified_artifacts || null,
        artifact_manifest_sha256: generation.artifact_manifest_sha256 || null,
      }]),
    ),
  }));
}

function pointerAlreadyApplied(row, item) {
  return (
    snapshotPostconditionFingerprint(row) === item.expected_postcondition_sha256
    && snapshotPreservedFieldsFingerprint(row) === item.expected_preserved_fields_sha256
  );
}

async function loadAuthoritativePostCasRow({
  before,
  planItem,
  pointerAdvanced,
  loadCurrentRow,
  uploaded,
}) {
  try {
    return canonicalSnapshotRow(await loadCurrentRow(planItem.source_id));
  } catch (error) {
    fail(
      "snapshot_pointer_postcondition_reload_failed",
      `The authoritative pointer could not be reloaded after CAS: ${safeMessage(error)}`,
      postCasFailureDetails({
        before,
        after: null,
        planItem,
        pointerAdvanced,
        uploaded,
        reloadError: error,
      }),
    );
  }
}

function postCasFailureDetails({
  before,
  after,
  planItem,
  pointerAdvanced,
  uploaded,
  reloadError = null,
}) {
  const authoritative = after ? canonicalSnapshotRow(after) : null;
  const lastKnownGoodPreserved = Boolean(
    authoritative
    && snapshotPostconditionFingerprint(authoritative) === snapshotPostconditionFingerprint(before),
  );
  return {
    post_cas_state: {
      authoritative_state: authoritative ? "loaded" : "unavailable",
      pointer_advanced: pointerAdvanced === true,
      last_known_good_preserved: lastKnownGoodPreserved,
      authoritative_snapshot: authoritative ? cloneJson(authoritative) : null,
      authoritative_snapshot_sha256: authoritative
        ? sha256Text(stableJson(authoritative))
        : null,
      authoritative_postcondition_sha256: authoritative
        ? snapshotPostconditionFingerprint(authoritative)
        : null,
      expected_postcondition_sha256: planItem.expected_postcondition_sha256,
      immutable_objects_uploaded: Number.isInteger(uploaded) && uploaded >= 0 ? uploaded : 0,
      reload_error: reloadError
        ? {
            reason_code: normalizedReasonCode(reloadError?.code || "post_cas_reload_failed"),
            message: safeMessage(reloadError),
          }
        : null,
    },
  };
}

function applyReceipt(item, status, row, now, uploaded) {
  return {
    schema_version: LEGACY_R2_POINTER_RECEIPT_SCHEMA,
    status,
    source_id: item.source_id,
    applied_at: canonicalTimestamp(now, "apply receipt timestamp"),
    snapshot_updated_at: row.updated_at,
    latest_object_keys: cloneJson(row.latest_object_keys),
    previous_object_keys: cloneJson(row.previous_object_keys),
    latest_metadata: cloneJson(row.latest_metadata),
    previous_metadata: cloneJson(row.previous_metadata),
    immutable_objects_uploaded: uploaded,
    legacy_objects_deleted: 0,
    live_fetches: 0,
    public_event_writes: 0,
    baseline_refreshes: 0,
    paid_api_calls: 0,
    protection: {
      last_known_good_preserved: true,
      pointer_advanced: status === "applied",
      legacy_objects_deleted: false,
      live_fetch_performed: false,
      public_event_written: false,
    },
    execution_binding_sha256: item.execution_binding_sha256,
  };
}

async function verifyPlannedImmutableDestinations(item, objectStore) {
  if (!objectStore || typeof objectStore.readObject !== "function") {
    fail("object_store_invalid", "An R2 objectStore.readObject function is required.");
  }
  for (const [generationName, generation] of Object.entries(item.generations || {})) {
    const migrated = generation?.state === "migrate_legacy_mutable";
    const existingImmutable = generation?.state === "already_immutable";
    if (!migrated && !existingImmutable) continue;
    const artifacts = migrated ? generation.artifacts || [] : generation.verified_artifacts || [];
    const verifiedBySlot = new Map();
    for (const artifact of artifacts) {
      const key = migrated ? artifact.immutable_key : artifact.source_key;
      const destination = validateReadObject(
        await objectStore.readObject({
          key,
          maxBytes: MAX_OBJECT_BYTES,
        }),
        {
          slot: artifact.slot,
          key,
          contentType: artifact.content_type,
        },
        { maxObjectBytes: MAX_OBJECT_BYTES, legacy: existingImmutable },
      );
      if (
        destination.sha256 !== artifact.sha256
        || destination.byte_length !== artifact.byte_length
        || (migrated && destination.metadata_sha256 !== artifact.sha256)
        || (migrated && destination.checksum_sha256 !== artifact.sha256)
        || (existingImmutable && destination.etag !== artifact.source_etag)
      ) {
        fail(
          "immutable_destination_mismatch",
          `Immutable destination verification failed for ${key}.`,
        );
      }
      verifiedBySlot.set(artifact.slot, destination);
    }
    validateReReadRetainedProjectionState({
      itemKind: item.kind,
      generationName,
      generation,
      metaArtifact: verifiedBySlot.get("meta"),
    });
  }
}

function validateReReadRetainedProjectionState({
  itemKind,
  generationName,
  generation,
  metaArtifact,
}) {
  if (!Buffer.isBuffer(metaArtifact?.body)) {
    fail(
      "immutable_destination_meta_missing",
      `Immutable ${generationName} metadata bytes are unavailable.`,
    );
  }
  let rawMeta;
  try {
    rawMeta = JSON.parse(decodeUtf8(metaArtifact.body, `${generationName} immutable meta`));
  } catch (error) {
    fail(
      "immutable_destination_meta_invalid",
      `Immutable ${generationName} metadata is invalid JSON: ${safeMessage(error)}`,
    );
  }
  const binding = jsonObject(generation.retained_projection_binding);
  const actualRawMetaSha256 = sha256Bytes(metaArtifact.body);
  if (binding.raw_meta_sha256 !== actualRawMetaSha256) {
    fail(
      "immutable_destination_projection_raw_meta_mismatch",
      `Immutable ${generationName} metadata differs from its reviewed projection binding.`,
    );
  }
  const rawHasProjection = Object.hasOwn(rawMeta, "retained_artifact_projection");
  const expectedRawHasProjection =
    binding.raw_meta_projection_state === "canonical_present";
  if (
    rawHasProjection !== expectedRawHasProjection
    || Object.hasOwn(rawMeta, "legacy_retained_artifact_projection_provenance")
  ) {
    fail(
      "immutable_destination_projection_presence_mismatch",
      `Immutable ${generationName} retained-projection field presence differs from the reviewed plan.`,
    );
  }
  if (!rawHasProjection) return;
  const pointerProjection = canonicalRetainedArtifactProjection(
    generation.metadata_after?.retained_artifact_projection,
  );
  const rawProjection = canonicalRetainedArtifactProjection(
    rawMeta.retained_artifact_projection,
  );
  if (
    !pointerProjection
    || !rawProjection
    || pointerProjection.kind !== itemKind
    || stableJson(pointerProjection) !== stableJson(rawProjection)
    || sha256Text(stableJson(pointerProjection)) !== binding.projection_sha256
  ) {
    fail(
      "immutable_destination_projection_mismatch",
      `Immutable ${generationName} retained projection differs from the reviewed canonical projection.`,
    );
  }
}

function generationKeysAfterMigration(generation, fallback) {
  if (!generation || generation.state === "absent") return {};
  if (generation.state === "migrate_legacy_mutable") return cloneJson(generation.object_keys_after);
  return cloneJson(generation.object_keys || fallback);
}

function generationMetadataAfter(generation, fallback) {
  if (!generation || generation.state === "absent") return cloneJson(fallback);
  return cloneJson(generation.metadata_after || fallback);
}

function metadataUpdatesFromPlanItem(item) {
  const updates = {};
  for (const field of item.metadata_fields_to_update || []) {
    if (field === "latest_metadata") updates.latest_metadata = cloneJson(item.next_metadata.latest);
    else if (field === "previous_metadata") {
      updates.previous_metadata = cloneJson(item.next_metadata.previous);
    } else fail("plan_metadata_field_invalid", `Unsupported metadata update field ${field}.`);
  }
  return updates;
}

function summarizePlanItems(items) {
  return {
    selected: items.length,
    migrate: items.filter((item) => item.action === "migrate").length,
    already_immutable: items.filter((item) => item.action === "already_immutable").length,
    quarantine_only: items.filter((item) => item.action === "quarantine_only").length,
    legacy_generations: items.reduce(
      (count, item) => count + Object.values(jsonObject(item.generations))
        .filter((generation) => generation?.state === "migrate_legacy_mutable").length,
      0,
    ),
    paid_api_calls: 0,
  };
}

function validatePlanSelector(selector, itemIds) {
  if (!isObject(selector)) fail("plan_selector_invalid", "Plan selector must be an object.");
  if (selector.mode === "exact_allowlist") {
    if (!Array.isArray(selector.source_ids)) {
      fail("plan_selector_allowlist_missing", "Exact plan selector has no source ID allowlist.");
    }
    const selectedIds = selector.source_ids.map((value) => requiredUuid(value, "selector source ID"));
    if (
      new Set(selectedIds).size !== selectedIds.length
      || stableJson(selectedIds) !== stableJson(itemIds)
      || Number(selector.source_count) !== selectedIds.length
    ) {
      fail("plan_selector_allowlist_mismatch", "Exact plan selector and item IDs differ.");
    }
    return;
  }
  if (selector.mode === "bounded_cursor") {
    const limit = Number(selector.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500 || itemIds.length > limit) {
      fail("plan_selector_limit_invalid", "Bounded plan selector exceeds its reviewed limit.");
    }
    const after = selector.after_source_id == null
      ? null
      : requiredUuid(selector.after_source_id, "selector cursor source ID");
    for (const [index, sourceId] of itemIds.entries()) {
      if (after && sourceId.localeCompare(after) <= 0) {
        fail("plan_selector_cursor_mismatch", "Bounded plan item is not after its reviewed cursor.");
      }
      if (index > 0 && sourceId.localeCompare(itemIds[index - 1]) <= 0) {
        fail("plan_selector_order_invalid", "Bounded plan item IDs are not strictly ordered.");
      }
    }
    return;
  }
  fail("plan_selector_mode_invalid", "Plan selector mode is unsupported.");
}

function validatePlanItem(item) {
  if (!isObject(item)) fail("plan_item_invalid", "A plan item must be an object.");
  const sourceId = requiredUuid(item.source_id, "plan source ID");
  if (!new Set(["migrate", "already_immutable", "quarantine_only"]).has(item.action)) {
    fail("plan_item_action_invalid", `Plan source ${sourceId} has an unsupported action.`);
  }
  if (item.action === "quarantine_only") {
    validateQuarantinePrecondition(item.quarantine_precondition);
    return;
  }
  const expected = canonicalSnapshotRow(item.expected_snapshot);
  if (expected.shared_award_source_id !== sourceId) {
    fail("plan_item_source_mismatch", "Plan item and expected snapshot source IDs differ.");
  }
  if (sha256Text(stableJson(expected)) !== requiredSha256(
    item.expected_snapshot_sha256,
    "expected snapshot SHA-256",
  )) {
    fail("plan_expected_snapshot_hash_invalid", "Plan expected snapshot hash is invalid.");
  }
  if (snapshotPreservedFieldsFingerprint(expected) !== requiredSha256(
    item.expected_preserved_fields_sha256,
    "expected preserved-fields SHA-256",
  )) {
    fail("plan_preserved_fields_hash_invalid", "Plan preserved-fields hash is invalid.");
  }
  if (!isObject(item.next_object_keys) || !isObject(item.next_metadata)) {
    fail("plan_next_pointer_invalid", "Plan next object keys and metadata must be objects.");
  }
  const fields = Array.isArray(item.metadata_fields_to_update)
    ? item.metadata_fields_to_update
    : [];
  if (new Set(fields).size !== fields.length) {
    fail("plan_metadata_fields_duplicate", "Plan metadata update fields are duplicated.");
  }
  for (const field of fields) {
    if (!new Set(["latest_metadata", "previous_metadata"]).has(field)) {
      fail("plan_metadata_field_invalid", `Unsupported metadata update field ${field}.`);
    }
  }
  const expectedAfter = cloneJson(expected);
  for (const generationName of ["latest", "previous"]) {
    const databaseField = `${generationName}_metadata`;
    const before = expected[databaseField];
    const after = jsonObject(item.next_metadata[generationName]);
    validateMetadataTransition({
      before,
      after,
      updateExpected: fields.includes(databaseField),
      generationName,
    });
    const generation = item.generations?.[generationName];
    if (!generation) fail("plan_generation_missing", `Plan ${generationName} generation is missing.`);
    if (generation.state !== "absent") {
      if (stableJson(generation.metadata_before) !== stableJson(before)) {
        fail("plan_metadata_before_mismatch", `Plan ${generationName} metadata-before binding differs.`);
      }
      if (stableJson(generation.metadata_after) !== stableJson(after)) {
        fail("plan_metadata_after_mismatch", `Plan ${generationName} metadata-after binding differs.`);
      }
      const plannedArtifacts = generation.state === "migrate_legacy_mutable"
        ? generation.artifacts || []
        : generation.verified_artifacts || [];
      if (
        after.artifact_bindings_schema !== ARTIFACT_BINDINGS_SCHEMA
        || stableJson(after.artifact_bindings) !== stableJson(
          artifactBindingsFromArtifacts(plannedArtifacts),
        )
      ) {
        fail(
          "plan_artifact_bindings_mismatch",
          `Plan ${generationName} artifact bindings differ from its verified object set.`,
        );
      }
      validateRetainedProjectionPlanBinding({
        itemKind: expected.kind,
        generationName,
        generation,
        plannedArtifacts,
        metadataAfter: after,
      });
      if (generation.metadata_enriched !== fields.includes(databaseField)) {
        fail("plan_metadata_enrichment_flag_mismatch", `Plan ${generationName} enrichment flag differs.`);
      }
      const actualAddedPaths = addedJsonPaths(before, after);
      if (stableJson(generation.metadata_added_paths) !== stableJson(actualAddedPaths)) {
        fail("plan_metadata_added_paths_mismatch", `Plan ${generationName} metadata additions differ.`);
      }
    }
    const expectedKeys = generationKeysAfterMigration(
      generation,
      expected[`${generationName}_object_keys`],
    );
    if (stableJson(expectedKeys) !== stableJson(item.next_object_keys[generationName])) {
      fail("plan_next_object_keys_mismatch", `Plan ${generationName} next object keys differ.`);
    }
    expectedAfter[`${generationName}_object_keys`] = cloneJson(item.next_object_keys[generationName]);
    expectedAfter[databaseField] = after;
  }
  if (snapshotPostconditionFingerprint(expectedAfter) !== requiredSha256(
    item.expected_postcondition_sha256,
    "expected postcondition SHA-256",
  )) {
    fail("plan_postcondition_hash_invalid", "Plan pointer postcondition hash is invalid.");
  }
  if (migrationItemExecutionBinding(item) !== requiredSha256(
    item.execution_binding_sha256,
    "plan execution binding SHA-256",
  )) {
    fail("plan_item_execution_binding_invalid", "Plan item execution binding is invalid.");
  }
}

function validateRetainedProjectionPlanBinding({
  itemKind,
  generationName,
  generation,
  plannedArtifacts,
  metadataAfter,
}) {
  const binding = jsonObject(generation.retained_projection_binding);
  const exactBindingKeys = [
    "projection_sha256",
    "raw_meta_projection_state",
    "raw_meta_sha256",
    "schema",
  ];
  if (
    stableJson(Object.keys(binding).toSorted()) !== stableJson(exactBindingKeys)
    || binding.schema !== LEGACY_RETAINED_PROJECTION_PLAN_BINDING_SCHEMA
    || !new Set(["absent", "canonical_present"]).has(
      binding.raw_meta_projection_state,
    )
  ) {
    fail(
      "plan_retained_projection_binding_invalid",
      `Plan ${generationName} retained-projection binding is invalid.`,
    );
  }
  const metaArtifact = plannedArtifacts.find((artifact) => artifact?.slot === "meta");
  const rawMetaSha256 = requiredSha256(
    binding.raw_meta_sha256,
    `Plan ${generationName} retained raw metadata SHA-256`,
  );
  if (
    !metaArtifact
    || rawMetaSha256 !== requiredSha256(
      metaArtifact.sha256,
      `Plan ${generationName} meta artifact SHA-256`,
    )
  ) {
    fail(
      "plan_retained_projection_raw_meta_binding_mismatch",
      `Plan ${generationName} retained-projection provenance is not bound to its exact meta artifact.`,
    );
  }
  const expectedProjection = retainedArtifactProjectionFromManifest({
    kind: itemKind,
    generation: {
      name: generationName,
      hashes: jsonObject(generation.hashes),
      metadata: metadataAfter,
    },
    manifest: {
      entries: plannedArtifacts.map((artifact) => ({ slot: artifact?.slot })),
    },
  });
  const expectedProjectionSha256 = sha256Text(stableJson(expectedProjection));
  if (
    requiredSha256(
      binding.projection_sha256,
      `Plan ${generationName} retained projection SHA-256`,
    ) !== expectedProjectionSha256
    || stableJson(canonicalRetainedArtifactProjection(
      metadataAfter.retained_artifact_projection,
    )) !== stableJson(expectedProjection)
  ) {
    fail(
      "plan_retained_projection_manifest_mismatch",
      `Plan ${generationName} retained projection differs from its exact artifact manifest.`,
    );
  }

  const provenanceField = "legacy_retained_artifact_projection_provenance";
  const provenancePresent = Object.hasOwn(metadataAfter, provenanceField);
  if (binding.raw_meta_projection_state === "absent") {
    const expectedProvenance = buildLegacyRetainedProjectionProvenance({
      rawMetaSha256,
      projectionSha256: expectedProjectionSha256,
    });
    if (
      !provenancePresent
      || stableJson(metadataAfter[provenanceField]) !== stableJson(expectedProvenance)
    ) {
      fail(
        "plan_retained_projection_provenance_mismatch",
        `Plan ${generationName} missing-raw projection provenance is invalid.`,
      );
    }
  } else if (provenancePresent) {
    fail(
      "plan_retained_projection_provenance_unexpected",
      `Plan ${generationName} carries legacy provenance despite a retained raw projection.`,
    );
  }
}

function validateMetadataTransition({ before, after, updateExpected, generationName }) {
  const canonicalBefore = jsonObject(before);
  const canonicalAfter = jsonObject(after);
  if (!updateExpected) {
    if (stableJson(canonicalBefore) !== stableJson(canonicalAfter)) {
      fail("plan_metadata_unreviewed_change", `Plan ${generationName} metadata changed unexpectedly.`);
    }
    return;
  }
  const additions = metadataAdditionAnalysis(canonicalBefore, canonicalAfter, generationName);
  if (!additions.length) {
    fail("plan_metadata_addition_missing", `Plan ${generationName} marks unchanged metadata for update.`);
  }
  for (const addition of additions) validateDerivedMetadataAddition(addition, generationName);
}

function addedJsonPaths(before, after) {
  return metadataAdditionAnalysis(jsonObject(before), jsonObject(after), "metadata")
    .map((entry) => entry.path)
    .toSorted();
}

function metadataAdditionAnalysis(before, after, generationName, prefix = "") {
  if (!isObject(before) || !isObject(after)) {
    if (stableJson(before) !== stableJson(after)) {
      fail(
        "plan_metadata_existing_value_changed",
        `Plan ${generationName} changes an existing metadata value.`,
      );
    }
    return [];
  }
  const additions = [];
  for (const [field, beforeValue] of Object.entries(before)) {
    const path = prefix ? `${prefix}.${field}` : field;
    if (!Object.hasOwn(after, field)) {
      fail("plan_metadata_existing_field_removed", `Plan ${generationName} removes metadata ${path}.`);
    }
    const afterValue = after[field];
    if (isObject(beforeValue) && isObject(afterValue)) {
      additions.push(...metadataAdditionAnalysis(beforeValue, afterValue, generationName, path));
    } else if (stableJson(beforeValue) !== stableJson(afterValue)) {
      fail("plan_metadata_existing_value_changed", `Plan ${generationName} changes metadata ${path}.`);
    }
  }
  for (const [field, value] of Object.entries(after)) {
    if (Object.hasOwn(before, field)) continue;
    additions.push({ path: prefix ? `${prefix}.${field}` : field, value: cloneJson(value) });
  }
  return additions.toSorted((left, right) => left.path.localeCompare(right.path));
}

function validateDerivedMetadataAddition({ path, value }, generationName) {
  const canonicalLocalization = {
    status: "evidence_only_geometry_unavailable",
    geometry_ready: false,
    accounted_for: true,
    unavailable_reason: "legacy_no_retained_geometry",
  };
  if (path === "text_object_bytes") {
    if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return;
  } else if (path === "expansion_state_count") {
    if (value === 0) return;
  } else if (path === "expansion_state_screenshots") {
    if (Array.isArray(value) && value.length === 0) return;
  } else if (path === "artifact_bindings_schema") {
    if (value === ARTIFACT_BINDINGS_SCHEMA) return;
  } else if (path === "artifact_bindings") {
    if (validArtifactBindingsShape(value)) return;
  } else if (path === "retained_artifact_projection") {
    if (canonicalRetainedArtifactProjection(value)) return;
  } else if (path === "legacy_retained_artifact_projection_provenance") {
    if (
      isExactLegacyRetainedProjectionProvenance({
        value,
        rawMetaSha256: value?.raw_meta_sha256,
        projectionSha256: value?.projection_sha256,
      })
    ) return;
  } else if (path === "localization") {
    if (stableJson(value) === stableJson(canonicalLocalization)) return;
  } else if (path === "localization.status") {
    if (value === canonicalLocalization.status) return;
  } else if (path === "localization.geometry_ready") {
    if (value === false) return;
  } else if (path === "localization.accounted_for") {
    if (value === true) return;
  } else if (path === "localization.unavailable_reason") {
    if (value === canonicalLocalization.unavailable_reason) return;
  }
  fail(
    "plan_metadata_derived_field_invalid",
    `Plan ${generationName} contains unauthorized derived metadata ${path}.`,
  );
}

function validArtifactBindingsShape(value) {
  if (!isObject(value) || !Object.keys(value).length) return false;
  for (const [slot, binding] of Object.entries(value)) {
    const definition = slotDefinition(slot);
    if (!definition || !isObject(binding)) return false;
    if (stableJson(Object.keys(binding).toSorted()) !== stableJson([
      "byte_length",
      "content_type",
      "hash_mode",
      "sha256",
    ])) return false;
    if (!SHA256_PATTERN.test(String(binding.sha256 || ""))) return false;
    if (!Number.isSafeInteger(binding.byte_length) || binding.byte_length <= 0) return false;
    if (binding.content_type !== definition.contentType) return false;
    if (binding.hash_mode !== "raw_sha256") return false;
  }
  return true;
}

function legacyKeysFromItem(item) {
  return Object.fromEntries(
    Object.entries(item?.generations || {})
      .filter(([, generation]) => generation?.state === "migrate_legacy_mutable")
      .map(([name, generation]) => [name, generation.object_keys_before]),
  );
}

function slotDefinition(slot) {
  if (FIXED_SLOTS[slot]) return FIXED_SLOTS[slot];
  const page = /^expansion_state_(\d{2})$/u.exec(slot);
  if (page && Number(page[1]) > 0) {
    return { fileName: `expansion-state-${page[1]}.jpg`, contentType: "image/jpeg" };
  }
  const layout = /^expansion_state_(\d{2})_layout$/u.exec(slot);
  if (layout && Number(layout[1]) > 0) {
    return {
      fileName: `expansion-state-${layout[1]}-layout.json`,
      contentType: "application/json; charset=utf-8",
    };
  }
  return null;
}

function normalizedCaptureHashes(value) {
  const hashes = jsonObject(value);
  return {
    image_hash: optionalSha256(hashes.image_hash),
    text_hash: optionalSha256(hashes.text_hash),
    body_text_hash: optionalSha256(hashes.body_text_hash),
    main_content_hash: optionalSha256(hashes.main_content_hash),
    nav_header_footer_hash: optionalSha256(hashes.nav_header_footer_hash),
    expansion_hash: optionalSha256(hashes.expansion_hash),
    layout_hash: optionalSha256(hashes.layout_hash),
    file_hash: optionalSha256(hashes.file_hash),
  };
}

function checksumHex(value) {
  const text = cleanText(value);
  if (!text) return null;
  if (SHA256_PATTERN.test(text.toLowerCase())) return text.toLowerCase();
  try {
    const bytes = Buffer.from(text, "base64");
    if (bytes.length === 32 && bytes.toString("base64").replace(/=+$/u, "") === text.replace(/=+$/u, "")) {
      return bytes.toString("hex");
    }
  } catch {
    // Fall through to a typed fail-closed error below.
  }
  fail("r2_object_checksum_invalid", "A supplied R2 SHA-256 checksum is malformed.");
}

function optionalSha256(value) {
  const text = cleanText(value).toLowerCase();
  if (!text) return null;
  if (!SHA256_PATTERN.test(text)) fail("sha256_invalid", "A supplied SHA-256 value is malformed.");
  return text;
}

function requiredSha256(value, label) {
  const hash = optionalSha256(value);
  if (!hash) fail("sha256_missing", `${label} is required.`);
  return hash;
}

function safeSnapshotFingerprint(row) {
  try {
    return snapshotRowFingerprint(row);
  } catch {
    return reviewedSnapshotStateFingerprint(row);
  }
}

function reviewedSnapshotStateFingerprint(row) {
  return reviewedStateFingerprint(row, canonicalSnapshotRow, "snapshot");
}

function reviewedSourceStateFingerprint(source) {
  return reviewedStateFingerprint(source, canonicalSourceRow, "source");
}

function reviewedStateFingerprint(value, canonicalizer, kind) {
  if (!isObject(value)) fail(`${kind}_state_invalid`, `Reviewed ${kind} state must be an object.`);
  try {
    return sha256Text(stableJson({ mode: "canonical", value: canonicalizer(value) }));
  } catch {
    return sha256Text(stableJson({ mode: "raw_fail_closed", value: cloneJson(value) }));
  }
}

function validateQuarantinePrecondition(value) {
  if (!isObject(value)) fail("quarantine_precondition_missing", "Quarantine precondition is missing.");
  for (const [label, state, fingerprint] of [
    ["pointer", value.pointer_state, value.pointer_sha256],
    ["source", value.source_state, value.source_sha256],
  ]) {
    if (!new Set(["present", "missing"]).has(state)) {
      fail("quarantine_precondition_state_invalid", `Quarantine ${label} state is invalid.`);
    }
    if (state === "present") requiredSha256(fingerprint, `quarantine ${label} SHA-256`);
    else if (fingerprint !== null) {
      fail("quarantine_precondition_missing_hash_invalid", `Missing quarantine ${label} has a hash.`);
    }
  }
}

function assertReviewedStateBinding({
  label,
  expectedState,
  expectedFingerprint,
  current,
  fingerprint,
}) {
  const currentPresent = isObject(current);
  if ((expectedState === "present") !== currentPresent) {
    fail(
      "quarantine_precondition_stale",
      `Reviewed ${label} presence changed; rebuild the dry-run before quarantining.`,
    );
  }
  if (currentPresent && fingerprint(current) !== expectedFingerprint) {
    fail(
      "quarantine_precondition_stale",
      `Reviewed ${label} changed; rebuild the dry-run before quarantining.`,
    );
  }
}

function requiredUuid(value, label) {
  const text = cleanText(value).toLowerCase();
  if (!UUID_PATTERN.test(text)) fail("uuid_invalid", `${label} is not a UUID.`);
  return text;
}

function canonicalTimestamp(value, label) {
  const parsed = Date.parse(requiredText(value, label));
  if (!Number.isFinite(parsed)) fail("timestamp_invalid", `${label} is invalid.`);
  return new Date(parsed).toISOString();
}

function nullableCanonicalTimestamp(value, label) {
  return value == null || value === "" ? null : canonicalTimestamp(value, label);
}

function sameTimestamp(left, right) {
  const a = Date.parse(String(left || ""));
  const b = Date.parse(String(right || ""));
  return Number.isFinite(a) && Number.isFinite(b) && a === b;
}

function requiredHttpUrl(value, label) {
  const text = requiredText(value, label);
  let url;
  try {
    url = new URL(text);
  } catch {
    fail("url_invalid", `${label} is invalid.`);
  }
  if (!new Set(["http:", "https:"]).has(url.protocol)) fail("url_invalid", `${label} is not HTTP(S).`);
  url.hash = "";
  return url.toString();
}

function normalizedUrl(value) {
  const url = new URL(requiredHttpUrl(value, "source URL"));
  url.hash = "";
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/$/u, "");
  return url.toString();
}

function boundedPositiveInteger(value, label, maximum) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0 || number > maximum) {
    fail("integer_invalid", `${label} must be an integer from 1 through ${maximum}.`);
  }
  return number;
}

function positiveInteger(value, label) {
  const number = typeof value === "number" ? value : Number.NaN;
  if (!Number.isSafeInteger(number) || number <= 0) {
    fail("positive_integer_invalid", `${label} must be a positive integer.`);
  }
  return number;
}

function nonNegativeIntegerRequired(value, label) {
  const number = nonNegativeInteger(value);
  if (number === null) fail("non_negative_integer_invalid", `${label} must be a non-negative integer.`);
  return number;
}

function nonNegativeInteger(value) {
  if (typeof value !== "number") {
    return null;
  }
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function requiredText(value, label) {
  const text = cleanText(value);
  if (!text) fail("text_missing", `${label} is required.`);
  return text;
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function nullableText(value) {
  return cleanText(value) || null;
}

function metadataValuePresent(value) {
  return value !== null && value !== undefined && value !== "";
}

function normalizedReasonCode(value) {
  return cleanText(value || "legacy_r2_pointer_migration_failed")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 200) || "legacy_r2_pointer_migration_failed";
}

function safeMessage(value) {
  return String(value?.message || value || "unknown failure")
    .replace(/(eyJ[a-zA-Z0-9._-]+)/gu, "[redacted-token]")
    .replace(/(sb_(?:secret|publishable)_[a-zA-Z0-9_-]+)/gu, "[redacted-key]")
    .slice(0, 1_000);
}

function mediaType(value) {
  return cleanText(value).split(";", 1)[0].toLowerCase();
}

function canonicalContentType(value) {
  return requiredText(value, "content type")
    .split(";")
    .map((part) => part.trim().toLowerCase())
    .join("; ");
}

function normalizeEtag(value) {
  return cleanText(value).replace(/^W\//iu, "").replace(/^"|"$/gu, "").toLowerCase();
}

function decodeUtf8(value, label) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch (error) {
    fail("utf8_invalid", `${label} is not valid UTF-8: ${safeMessage(error)}`);
  }
}

function stripOneTrailingLineBreak(value) {
  if (value.endsWith("\r\n")) return value.slice(0, -2);
  if (value.endsWith("\n")) return value.slice(0, -1);
  return value;
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, sortJson(value[key])]),
  );
}

function cloneJson(value) {
  if (value === undefined) return null;
  return structuredClone(value);
}

function jsonObject(value) {
  return isObject(value) ? cloneJson(value) : {};
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sha256Text(value) {
  return sha256Bytes(Buffer.from(String(value), "utf8"));
}

function fail(code, message, details = null) {
  throw new LegacyR2PointerMigrationError(code, message, details);
}
