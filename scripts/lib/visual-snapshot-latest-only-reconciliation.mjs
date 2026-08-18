import { createHash } from "node:crypto";
import { isPublishedVisualEvidenceKey } from "./visual-snapshot-history.mjs";

export const VISUAL_SNAPSHOT_LATEST_ONLY_CLEANUP_DEBT_SCHEMA =
  "awardping.visual-snapshot.latest-only-cleanup-debt.v1";

export const VISUAL_SNAPSHOT_POINTER_IDENTITY_SCHEMA =
  "awardping.visual-snapshot.pointer-identity.v1";

export const visualSnapshotPointerIdentityFields = Object.freeze([
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

const timestampFields = new Set([
  "latest_captured_at",
  "previous_captured_at",
  "updated_at",
]);

const latestReplacementFields = Object.freeze([
  "latest_captured_at",
  "latest_object_keys",
  "latest_hashes",
  "latest_metadata",
]);

const previousFields = Object.freeze([
  "previous_captured_at",
  "previous_object_keys",
  "previous_hashes",
  "previous_metadata",
]);

const preservedIdentityFields = Object.freeze([
  "shared_award_source_id",
  "shared_award_id",
  "source_url",
  "source_title",
  "source_page_type",
  "kind",
  "bucket",
]);

const reconciliationOutcomes = new Set([
  "committed",
  "failed_before_cas",
  "cas_lost",
  "ambiguous_error",
]);

/**
 * Builds the exact row proposed by a latest-only repair. Unlike a normal
 * capture rotation, this deliberately leaves the historical `previous_*`
 * generation untouched and does not rotate the old latest generation into it.
 */
export function buildLatestOnlyVisualSnapshotPointerReplacement({
  existing,
  replacement,
  updatedAt,
} = {}) {
  const before = requirePointer(existing, "existing pointer");
  const latest = requirePlainObject(replacement, "latest replacement");
  for (const field of previousFields) {
    if (Object.hasOwn(latest, field)) {
      throw new Error(`Latest-only replacement must not supply ${field}.`);
    }
  }

  const next = {};
  for (const field of visualSnapshotPointerIdentityFields) {
    if (latestReplacementFields.includes(field)) {
      if (!Object.hasOwn(latest, field)) {
        throw new Error(`Latest-only replacement requires ${field}.`);
      }
      next[field] = cloneJson(latest[field]);
    } else if (field === "updated_at") {
      next[field] = canonicalTimestamp(updatedAt);
    } else {
      next[field] = cloneJson(before[field] ?? null);
    }
  }

  if (!next.updated_at) throw new Error("Latest-only replacement updatedAt is required.");
  if (!next.latest_captured_at) {
    throw new Error("Latest-only replacement latest_captured_at is required.");
  }
  if (!Object.keys(objectValue(next.latest_object_keys)).length) {
    throw new Error("Latest-only replacement requires at least one latest object key.");
  }
  assertLatestOnlyVisualSnapshotPointerReplacement(before, next);
  return next;
}

/**
 * Returns a content identity for the complete public pointer projection. The
 * canonical projection is retained alongside its digest so a recovery journal
 * can both compare and reconstruct the exact intended state.
 */
export function visualSnapshotPointerIdentity(pointer) {
  if (pointer === null) {
    return {
      schema_version: VISUAL_SNAPSHOT_POINTER_IDENTITY_SCHEMA,
      exists: false,
      canonical_sha256: null,
      projection: null,
    };
  }
  const value = requirePointer(pointer, "visual snapshot pointer");
  const projection = pointerProjection(value);
  return {
    schema_version: VISUAL_SNAPSHOT_POINTER_IDENTITY_SCHEMA,
    exists: true,
    canonical_sha256: sha256Utf8(stableJson(projection)),
    projection,
  };
}

export function assertVisualSnapshotPointerIdentity(identity) {
  const value = requirePlainObject(identity, "visual snapshot pointer identity");
  if (value.schema_version !== VISUAL_SNAPSHOT_POINTER_IDENTITY_SCHEMA) {
    throw new Error("Visual snapshot pointer identity schema is invalid.");
  }
  if (value.exists === false) {
    if (value.canonical_sha256 !== null || value.projection !== null) {
      throw new Error("Absent visual snapshot pointer identity contains state.");
    }
    return value;
  }
  if (value.exists !== true) {
    throw new Error("Visual snapshot pointer identity existence flag is invalid.");
  }
  const projection = pointerProjection(
    requirePointer(value.projection, "visual snapshot pointer identity projection"),
  );
  const expectedHash = sha256Utf8(stableJson(projection));
  if (value.canonical_sha256 !== expectedHash) {
    throw new Error("Visual snapshot pointer identity hash does not match its projection.");
  }
  return value;
}

export function visualSnapshotPointerMatchesIdentity(pointer, identity) {
  assertVisualSnapshotPointerIdentity(identity);
  if (pointer === undefined) return false;
  const observed = visualSnapshotPointerIdentity(pointer);
  return observed.exists === identity.exists
    && observed.canonical_sha256 === identity.canonical_sha256;
}

export function assertLatestOnlyVisualSnapshotPointerReplacement(existing, candidate) {
  const before = requirePointer(existing, "existing pointer");
  const next = requirePointer(candidate, "candidate pointer");
  for (const field of preservedIdentityFields) {
    if (stableJson(before[field] ?? null) !== stableJson(next[field] ?? null)) {
      throw new Error(`Latest-only replacement changed preserved ${field}.`);
    }
  }
  for (const field of previousFields) {
    const beforeValue = timestampFields.has(field)
      ? canonicalTimestamp(before[field])
      : before[field] ?? null;
    const nextValue = timestampFields.has(field)
      ? canonicalTimestamp(next[field])
      : next[field] ?? null;
    if (stableJson(beforeValue) !== stableJson(nextValue)) {
      throw new Error(`Latest-only replacement changed preserved ${field}.`);
    }
  }
  if (!Object.keys(objectValue(next.latest_object_keys)).length) {
    throw new Error("Candidate pointer has no latest object keys.");
  }
  if (!canonicalTimestamp(next.latest_captured_at)) {
    throw new Error("Candidate pointer has no latest capture timestamp.");
  }
  const beforeUpdatedAt = canonicalTimestamp(before.updated_at);
  const nextUpdatedAt = canonicalTimestamp(next.updated_at);
  if (!beforeUpdatedAt || !nextUpdatedAt || Date.parse(nextUpdatedAt) <= Date.parse(beforeUpdatedAt)) {
    throw new Error("Latest-only replacement must advance the pointer updated_at version.");
  }
  return true;
}

/**
 * Purely classifies the observable CAS outcome and emits cleanup *debt*. It
 * never calls R2 and never authorizes deletion of a key referenced by the
 * authoritative outcome (or any permanent published-evidence key).
 */
export function planLatestOnlyVisualSnapshotPointerReconciliation({
  existing,
  candidate,
  current,
  outcome,
  uploadedKeys,
} = {}) {
  const before = requirePointer(existing, "existing pointer");
  const proposed = requirePointer(candidate, "candidate pointer");
  assertLatestOnlyVisualSnapshotPointerReplacement(before, proposed);
  if (!reconciliationOutcomes.has(outcome)) {
    throw new Error("Latest-only reconciliation outcome is invalid.");
  }

  const beforeIdentity = visualSnapshotPointerIdentity(before);
  const candidateIdentity = visualSnapshotPointerIdentity(proposed);
  const currentKnown = current !== undefined;
  const currentMatchesOld = currentKnown
    && visualSnapshotPointerMatchesIdentity(current, beforeIdentity);
  const currentMatchesCandidate = currentKnown
    && visualSnapshotPointerMatchesIdentity(current, candidateIdentity);

  let classification;
  let reason;
  if (currentMatchesCandidate) {
    classification = "candidate";
    reason = outcome === "ambiguous_error"
      ? "candidate_observed_after_ambiguous_cas_error"
      : "candidate_pointer_observed";
  } else if (currentMatchesOld) {
    classification = "old";
    reason = outcome === "cas_lost"
      ? "old_pointer_retained_after_lost_cas"
      : "old_pointer_observed";
  } else if (outcome === "committed" && !currentKnown) {
    classification = "candidate";
    reason = "candidate_pointer_commit_confirmed";
  } else if (outcome === "failed_before_cas" && !currentKnown) {
    classification = "old";
    reason = "pointer_cas_not_attempted";
  } else {
    classification = "ambiguous";
    reason = currentKnown
      ? "authoritative_pointer_matches_neither_journal_identity"
      : "authoritative_pointer_not_observed";
  }

  const uploaded = normalizedKeys(uploadedKeys);
  const proposedLatest = new Set(normalizedKeys(proposed.latest_object_keys));
  const unexpectedUploads = uploaded.filter((key) => !proposedLatest.has(key));
  if (unexpectedUploads.length) {
    throw new Error(
      `Latest-only reconciliation contains upload keys outside the candidate pointer: ${unexpectedUploads.join(", ")}.`,
    );
  }
  const oldLatest = normalizedKeys(before.latest_object_keys);
  const authoritativeReferences = classification === "candidate"
    ? pointerReferences(currentMatchesCandidate ? current : proposed)
    : classification === "old"
      ? pointerReferences(currentMatchesOld ? current : before)
      : uniqueSorted([
        ...pointerReferences(before),
        ...pointerReferences(proposed),
        ...(currentKnown && current ? pointerReferences(current) : []),
      ]);
  const debtCandidates = classification === "candidate" ? oldLatest : uploaded;
  const debt = buildCleanupDebt({
    classification,
    reason,
    candidateKeys: debtCandidates,
    authoritativeReferences,
    authoritativeOldObserved: currentMatchesOld,
  });

  return {
    classification,
    reason,
    current_observed: currentKnown,
    before_pointer_identity: beforeIdentity,
    candidate_pointer_identity: candidateIdentity,
    current_pointer_identity: currentKnown
      ? visualSnapshotPointerIdentity(current)
      : null,
    cleanup_debt: debt,
  };
}

export function visualSnapshotPointerReferencedKeys(pointer) {
  if (!pointer) return [];
  return pointerReferences(requirePointer(pointer, "visual snapshot pointer"));
}

function buildCleanupDebt({
  classification,
  reason,
  candidateKeys,
  authoritativeReferences,
  authoritativeOldObserved,
}) {
  const candidates = normalizedKeys(candidateKeys);
  const referenced = new Set(normalizedKeys(authoritativeReferences));
  const permanentlyProtected = candidates.filter(isPublishedVisualEvidenceKey);
  const referencedCandidates = candidates.filter((key) => referenced.has(key));
  const protectedKeys = uniqueSorted([...permanentlyProtected, ...referencedCandidates]);
  const potentiallyUnreferenced = candidates.filter((key) => !protectedKeys.includes(key));
  const ambiguous = classification === "ambiguous";
  const oldCleanupProven = classification === "old" && authoritativeOldObserved;
  const requiresAuthoritativeRecheck = ambiguous
    || (classification === "old" && !oldCleanupProven);
  const requiresPublishedReferenceGraphCheck = classification === "candidate"
    && potentiallyUnreferenced.length > 0;
  const eligibleKeys = oldCleanupProven ? potentiallyUnreferenced : [];
  const deferredKeys = classification === "candidate"
    ? potentiallyUnreferenced
    : ambiguous || !oldCleanupProven
      ? candidates.filter((key) => !permanentlyProtected.includes(key))
      : [];
  return {
    schema_version: VISUAL_SNAPSHOT_LATEST_ONLY_CLEANUP_DEBT_SCHEMA,
    reason,
    delete_performed: false,
    requires_authoritative_recheck: requiresAuthoritativeRecheck,
    requires_published_reference_graph_check: requiresPublishedReferenceGraphCheck,
    candidate_keys: candidates,
    protected_keys: protectedKeys,
    eligible_keys: eligibleKeys,
    // Old latest keys may be referenced by immutable published events even
    // when their path uses the ordinary captures/ prefix. Ambiguous keys may
    // also be referenced by an unobserved pointer outcome. Neither category is
    // eligible until the corresponding authoritative graph check succeeds.
    deferred_keys: deferredKeys,
    item_count: candidates.length,
    eligible_count: eligibleKeys.length,
  };
}

function pointerProjection(pointer) {
  const projection = {};
  for (const field of visualSnapshotPointerIdentityFields) {
    projection[field] = timestampFields.has(field)
      ? canonicalTimestamp(pointer[field])
      : cloneJson(pointer[field] ?? null);
  }
  return projection;
}

function pointerReferences(pointer) {
  return uniqueSorted([
    ...normalizedKeys(pointer?.latest_object_keys),
    ...normalizedKeys(pointer?.previous_object_keys),
  ]);
}

function normalizedKeys(value) {
  const values = Array.isArray(value)
    ? value
    : Object.values(objectValue(value));
  return uniqueSorted(values.map(cleanText).filter(Boolean));
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function canonicalTimestamp(value) {
  const text = cleanText(value);
  if (!text) return null;
  const milliseconds = Date.parse(text);
  if (!Number.isFinite(milliseconds)) {
    throw new Error(`Invalid pointer timestamp: ${text}`);
  }
  return new Date(milliseconds).toISOString();
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256Utf8(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function requirePointer(value, label) {
  const pointer = requirePlainObject(value, label);
  if (!cleanText(pointer.shared_award_source_id)) {
    throw new Error(`${label} requires shared_award_source_id.`);
  }
  return pointer;
}

function requirePlainObject(value, label) {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be an object.`);
  return value;
}

function cloneJson(value) {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value));
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function objectValue(value) {
  return isPlainObject(value) ? value : {};
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
