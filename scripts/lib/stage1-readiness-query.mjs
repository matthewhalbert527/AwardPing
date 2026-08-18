import { createHash } from "node:crypto";

const DEFAULT_PAGE_SIZE = 1_000;
const DEFAULT_MAX_ROWS = 100_000;

export async function fetchExactStableRows(
  buildQuery,
  label,
  {
    pageSize = DEFAULT_PAGE_SIZE,
    maxRows = DEFAULT_MAX_ROWS,
  } = {},
) {
  const boundedPageSize = positiveInteger(pageSize, DEFAULT_PAGE_SIZE);
  const boundedMaxRows = positiveInteger(maxRows, DEFAULT_MAX_ROWS);
  const first = await fetchExactPass(
    buildQuery,
    label,
    boundedPageSize,
    boundedMaxRows,
  );
  const verification = await fetchExactPass(
    buildQuery,
    label,
    boundedPageSize,
    boundedMaxRows,
  );

  if (
    first.count !== verification.count
    || first.revision !== verification.revision
  ) {
    throw queryFailure(
      "stage1_query_revision_changed",
      `${label}: rows changed while the exact readiness snapshot was being verified.`,
    );
  }

  return verification.rows;
}

export async function fetchExactRows(
  buildQuery,
  label,
  {
    pageSize = DEFAULT_PAGE_SIZE,
    maxRows = DEFAULT_MAX_ROWS,
  } = {},
) {
  const boundedPageSize = positiveInteger(pageSize, DEFAULT_PAGE_SIZE);
  const boundedMaxRows = positiveInteger(maxRows, DEFAULT_MAX_ROWS);
  const pass = await fetchExactPass(
    buildQuery,
    label,
    boundedPageSize,
    boundedMaxRows,
  );
  return pass.rows;
}

export async function fetchExactStableChunkedRows({
  values,
  chunkSize,
  run,
  label = "chunked Stage 1 readiness query",
}) {
  if (typeof run !== "function") {
    throw new TypeError(`${label}: a chunk query function is required.`);
  }
  const uniqueValues = [...new Set((Array.isArray(values) ? values : []).filter(Boolean))];
  const boundedChunkSize = positiveInteger(chunkSize, 25);
  const first = await fetchChunkedPass(uniqueValues, boundedChunkSize, run, label);
  const verification = await fetchChunkedPass(uniqueValues, boundedChunkSize, run, label);

  if (
    first.rows.length !== verification.rows.length
    || first.revision !== verification.revision
  ) {
    throw queryFailure(
      "stage1_chunked_query_revision_changed",
      `${label}: rows changed while the complete cross-chunk readiness snapshot was being verified.`,
    );
  }

  return verification.rows;
}

export function stage1ReadinessRowIdentity(row) {
  if (!row || typeof row !== "object") return null;
  const directId = cleanText(row.id);
  if (directId) return `id:${directId}`;
  const sourceId = cleanText(row.shared_award_source_id);
  if (sourceId) return `source:${sourceId}`;
  const cohortKey = cleanText(row.cohort_key);
  const sourceRole = cleanText(row.source_role);
  if (cohortKey && sourceRole) return `manifest:${cohortKey}:${sourceRole}`;
  return null;
}

export function stage1ReadinessRowsRevision(rows) {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(rows)), "utf8")
    .digest("hex");
}

async function fetchExactPass(buildQuery, label, pageSize, maxRows) {
  const rows = [];
  const identities = new Set();
  let expectedCount = null;

  for (let start = 0; ; start += pageSize) {
    const result = await buildQuery().range(start, start + pageSize - 1);
    if (result.error) {
      const error = queryFailure(
        result.error.code || "stage1_query_failed",
        `${label}: ${safeError(result.error)}`,
      );
      throw error;
    }

    const pageCount = exactCount(result.count);
    if (pageCount === null) {
      throw queryFailure(
        "stage1_exact_count_unavailable",
        `${label}: the required exact row count was unavailable.`,
      );
    }
    if (pageCount > maxRows) {
      throw queryFailure(
        "stage1_query_safety_ceiling_exceeded",
        `${label}: exact count ${pageCount} exceeds the ${maxRows}-row readiness safety ceiling.`,
      );
    }
    if (expectedCount === null) expectedCount = pageCount;
    else if (pageCount !== expectedCount) {
      throw queryFailure(
        "stage1_query_count_changed",
        `${label}: exact row count changed during pagination.`,
      );
    }

    const page = Array.isArray(result.data) ? result.data : [];
    const expectedPageLength = Math.min(
      pageSize,
      Math.max(0, expectedCount - start),
    );
    if (page.length !== expectedPageLength) {
      throw queryFailure(
        "stage1_query_page_incomplete",
        `${label}: expected ${expectedPageLength} row(s) at offset ${start}, received ${page.length}.`,
      );
    }

    for (const row of page) {
      const identity = stage1ReadinessRowIdentity(row);
      if (!identity) {
        throw queryFailure(
          "stage1_query_identity_missing",
          `${label}: a row had no stable readiness identity.`,
        );
      }
      if (identities.has(identity)) {
        throw queryFailure(
          "stage1_query_identity_repeated",
          `${label}: stable row identity ${identity} appeared more than once.`,
        );
      }
      identities.add(identity);
      rows.push(row);
    }

    if (rows.length >= expectedCount) break;
  }

  if (expectedCount === null || rows.length !== expectedCount) {
    throw queryFailure(
      "stage1_query_count_mismatch",
      `${label}: exact count ${expectedCount ?? "unavailable"} differs from ${rows.length} fetched row(s).`,
    );
  }

  return {
    rows,
    count: expectedCount,
    revision: stage1ReadinessRowsRevision(rows),
  };
}

async function fetchChunkedPass(values, chunkSize, run, label) {
  const rows = [];
  const identities = new Set();
  for (let index = 0; index < values.length; index += chunkSize) {
    const chunkRows = await run(values.slice(index, index + chunkSize));
    if (!Array.isArray(chunkRows)) {
      throw queryFailure(
        "stage1_chunked_query_invalid_result",
        `${label}: a chunk query did not return an array.`,
      );
    }
    for (const row of chunkRows) {
      const identity = stage1ReadinessRowIdentity(row);
      if (!identity) {
        throw queryFailure(
          "stage1_query_identity_missing",
          `${label}: a row had no stable readiness identity.`,
        );
      }
      if (identities.has(identity)) {
        throw queryFailure(
          "stage1_query_identity_repeated",
          `${label}: stable row identity ${identity} appeared more than once across chunks.`,
        );
      }
      identities.add(identity);
      rows.push(row);
    }
  }
  return { rows, revision: stage1ReadinessRowsRevision(rows) };
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value ?? null;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, stableValue(nested)]),
  );
}

function exactCount(value) {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function positiveInteger(value, fallback) {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function safeError(error) {
  return String(error?.message || error || "unknown_error")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1_000);
}

function queryFailure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
