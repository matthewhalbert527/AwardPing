import {
  isDeletableVisualSnapshotKey,
  visualSnapshotKeysToDeleteAfterCas,
  visualSnapshotUploadedKeysToDeleteAfterLostCas,
} from "./visual-snapshot-history.mjs";

const pointerFields = [
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
];

const timestampFields = new Set([
  "latest_captured_at",
  "previous_captured_at",
  "updated_at",
]);

export function visualSnapshotPointerExactlyMatchesProposal(current, proposed) {
  if (!isObject(current) || !isObject(proposed)) return false;
  const currentProjection = {};
  const proposedProjection = {};
  for (const field of pointerFields) {
    currentProjection[field] = timestampFields.has(field)
      ? canonicalTimestamp(current[field])
      : current[field] ?? null;
    proposedProjection[field] = timestampFields.has(field)
      ? canonicalTimestamp(proposed[field])
      : proposed[field] ?? null;
  }
  return stableJson(currentProjection) === stableJson(proposedProjection);
}

export async function reconcileVisualSnapshotPointerAdvance({
  advance,
  reload,
  cleanup,
  existing,
  proposed,
  uploaded,
} = {}) {
  requireFunction(advance, "advance");
  requireFunction(reload, "reload");
  requireFunction(cleanup, "cleanup");

  let advanced = false;
  let advanceError = null;
  try {
    advanced = (await advance()) === true;
  } catch (error) {
    advanceError = asError(error, "Visual snapshot pointer advance failed.");
  }

  if (advanced) {
    const cleanupKeys = visualSnapshotKeysToDeleteAfterCas({
      pointerAdvanced: true,
      existing,
      next: proposed,
    });
    return {
      committed: true,
      reconciled_after_ambiguous_error: false,
      cleanup: await cleanupWithoutMasking(cleanup, cleanupKeys),
    };
  }

  let current = null;
  let reloadError = null;
  try {
    current = await reload();
  } catch (error) {
    reloadError = asError(error, "Visual snapshot pointer reload failed.");
  }

  if (
    advanceError
    && !reloadError
    && visualSnapshotPointerExactlyMatchesProposal(current, proposed)
  ) {
    const cleanupKeys = visualSnapshotKeysToDeleteAfterCas({
      pointerAdvanced: true,
      existing,
      next: proposed,
    });
    return {
      committed: true,
      reconciled_after_ambiguous_error: true,
      cleanup: await cleanupWithoutMasking(cleanup, cleanupKeys),
    };
  }

  const pointerFailure = advanceError || Object.assign(
    new Error("Visual snapshot pointer compare-and-set lost to another source writer."),
    { code: "visual_snapshot_pointer_lost_cas" },
  );
  if (!pointerFailure.code) pointerFailure.code = "visual_snapshot_pointer_advance_failed";

  let cleanupResult;
  if (reloadError) {
    cleanupResult = deferredCleanupDebt(
      uploadedKeys(uploaded),
      `Authoritative pointer reload failed; deletion was deferred: ${reloadError.message}`,
    );
    pointerFailure.r2PointerReloadError = reloadError.message;
  } else {
    const cleanupKeys = visualSnapshotUploadedKeysToDeleteAfterLostCas({ uploaded, current });
    cleanupResult = await cleanupWithoutMasking(cleanup, cleanupKeys);
  }

  pointerFailure.r2Cleanup = cleanupResult;
  pointerFailure.r2PointerOutcome = advanceError
    ? "advance_failed_not_committed"
    : "lost_compare_and_set";
  throw pointerFailure;
}

async function cleanupWithoutMasking(cleanup, keys) {
  const uniqueKeys = uniqueDeletableKeys(keys);
  if (!uniqueKeys.length) return emptyCleanupResult();
  try {
    const result = await cleanup(uniqueKeys);
    return normalizeCleanupResult(result, uniqueKeys);
  } catch (error) {
    return deferredCleanupDebt(
      uniqueKeys,
      `Immutable-object cleanup failed: ${errorMessage(error)}`,
      { attempted: uniqueKeys.length },
    );
  }
}

function normalizeCleanupResult(result, keys) {
  if (!isObject(result)) {
    return deferredCleanupDebt(keys, "Immutable-object cleanup returned no result.", {
      attempted: keys.length,
    });
  }
  const failures = Array.isArray(result.failures) ? result.failures : [];
  const failed = nonNegativeInteger(result.failed, failures.length);
  const attempted = nonNegativeInteger(result.attempted, keys.length);
  const deleted = nonNegativeInteger(result.deleted, Math.max(0, attempted - failed));
  return { attempted, deleted, failed, failures };
}

function deferredCleanupDebt(keys, message, { attempted = 0 } = {}) {
  const uniqueKeys = uniqueDeletableKeys(keys);
  return {
    attempted,
    deleted: 0,
    failed: uniqueKeys.length,
    failures: uniqueKeys.map((key) => ({ key, message })),
  };
}

function emptyCleanupResult() {
  return { attempted: 0, deleted: 0, failed: 0, failures: [] };
}

function uploadedKeys(uploaded) {
  return Object.values(isObject(uploaded) ? uploaded : {});
}

function uniqueDeletableKeys(keys) {
  return [...new Set((Array.isArray(keys) ? keys : []).filter((key) => (
    typeof key === "string" && key.trim() && isDeletableVisualSnapshotKey(key)
  )))];
}

function canonicalTimestamp(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

function nonNegativeInteger(value, fallback) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function requireFunction(value, label) {
  if (typeof value !== "function") throw new TypeError(`${label}() is required.`);
}

function asError(value, fallback) {
  return value instanceof Error ? value : new Error(errorMessage(value) || fallback);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || "Unknown error");
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
