import crypto from "node:crypto";

export const RECONCILIATION_SNAPSHOT_CHANGED =
  "RECONCILIATION_CANDIDATE_SNAPSHOT_CHANGED";
export const RECONCILIATION_SNAPSHOT_UNSAFE_MAX =
  "RECONCILIATION_CANDIDATE_SNAPSHOT_UNSAFE_MAX";

/**
 * Load an exact, deterministic candidate snapshot without accepting a REST
 * default/max-row truncation. Two complete passes and three exact counts make
 * a concurrent insert, delete, update, or ordering change fail closed.
 */
export async function loadStablePaginatedRows({
  countRows,
  loadPage,
  pageSize = 500,
  maxRows = 100_000,
  rowIdentity = defaultRowIdentity,
} = {}) {
  if (typeof countRows !== "function" || typeof loadPage !== "function") {
    throw new TypeError("countRows and loadPage functions are required.");
  }
  if (typeof rowIdentity !== "function") {
    throw new TypeError("rowIdentity must be a function.");
  }

  const normalizedPageSize = requiredPositiveInteger(pageSize, "pageSize");
  const normalizedMaxRows = requiredPositiveInteger(maxRows, "maxRows");
  const countBefore = await exactCount(countRows, "before_read");
  assertWithinMaximum(countBefore, normalizedMaxRows);

  const firstPass = await loadSnapshotPass({
    expectedCount: countBefore,
    loadPage,
    pageSize: normalizedPageSize,
    pass: 1,
    rowIdentity,
  });
  const countBetween = await exactCount(countRows, "between_reads");
  assertStableCount(countBefore, countBetween, "first_read");
  assertWithinMaximum(countBetween, normalizedMaxRows);

  const secondPass = await loadSnapshotPass({
    expectedCount: countBetween,
    loadPage,
    pageSize: normalizedPageSize,
    pass: 2,
    rowIdentity,
  });
  const countAfter = await exactCount(countRows, "after_read");
  assertStableCount(countBetween, countAfter, "second_read");
  assertWithinMaximum(countAfter, normalizedMaxRows);

  if (firstPass.revisionSha256 !== secondPass.revisionSha256) {
    throw snapshotError(
      RECONCILIATION_SNAPSHOT_CHANGED,
      "Fact candidates changed while the reconciliation snapshot was being loaded; the queue item was not reconciled.",
      {
        count: countAfter,
        first_revision_sha256: firstPass.revisionSha256,
        second_revision_sha256: secondPass.revisionSha256,
      },
    );
  }

  return {
    rows: secondPass.rows,
    exactCount: countAfter,
    revisionSha256: secondPass.revisionSha256,
    pagesRead: firstPass.pagesRead + secondPass.pagesRead,
    rowsObserved: firstPass.rows.length + secondPass.rows.length,
  };
}

async function loadSnapshotPass({
  expectedCount,
  loadPage,
  pageSize,
  pass,
  rowIdentity,
}) {
  const rows = [];
  const identities = new Set();
  let pagesRead = 0;

  for (let offset = 0; offset < expectedCount; offset += pageSize) {
    const limit = Math.min(pageSize, expectedCount - offset);
    const page = await loadPage({ offset, limit, pass });
    if (!Array.isArray(page)) {
      throw new TypeError(`loadPage must return an array (pass=${pass}, offset=${offset}).`);
    }
    pagesRead += 1;
    if (page.length !== limit) {
      throw snapshotError(
        RECONCILIATION_SNAPSHOT_CHANGED,
        `Fact candidate page length changed during snapshot load (pass=${pass}, offset=${offset}, expected=${limit}, actual=${page.length}).`,
        { pass, offset, expected_page_rows: limit, actual_page_rows: page.length },
      );
    }

    for (const row of page) {
      const identity = String(rowIdentity(row) ?? "").trim();
      if (!identity) {
        throw new TypeError(
          `Every reconciliation candidate must have a stable identity (pass=${pass}, offset=${offset}).`,
        );
      }
      if (identities.has(identity)) {
        throw snapshotError(
          RECONCILIATION_SNAPSHOT_CHANGED,
          `Duplicate fact candidate identity ${identity} appeared during deterministic pagination.`,
          { pass, offset, duplicate_identity: identity },
        );
      }
      identities.add(identity);
      rows.push(row);
    }
  }

  if (rows.length !== expectedCount) {
    throw snapshotError(
      RECONCILIATION_SNAPSHOT_CHANGED,
      `Fact candidate count changed during snapshot load (expected=${expectedCount}, actual=${rows.length}).`,
      { pass, expected_count: expectedCount, actual_count: rows.length },
    );
  }

  return {
    rows,
    pagesRead,
    revisionSha256: crypto
      .createHash("sha256")
      .update(canonicalJson(rows))
      .digest("hex"),
  };
}

async function exactCount(countRows, stage) {
  const count = await countRows({ stage });
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new TypeError(`Exact fact candidate count is unavailable at ${stage}.`);
  }
  return count;
}

function assertStableCount(expected, actual, stage) {
  if (actual === expected) return;
  throw snapshotError(
    RECONCILIATION_SNAPSHOT_CHANGED,
    `Fact candidate count changed during ${stage} (before=${expected}, after=${actual}); the queue item was not reconciled.`,
    { stage, count_before: expected, count_after: actual },
  );
}

function assertWithinMaximum(count, maxRows) {
  if (count <= maxRows) return;
  throw snapshotError(
    RECONCILIATION_SNAPSHOT_UNSAFE_MAX,
    `Exact fact candidate count ${count} exceeds the configured safe maximum ${maxRows}; raise --max-fact-candidates only after operator review.`,
    { exact_count: count, max_rows: maxRows },
  );
}

function snapshotError(code, message, details) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  error.details = details;
  return error;
}

function defaultRowIdentity(row) {
  return row && typeof row === "object" ? row.id : null;
}

function requiredPositiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
  return parsed;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalValue(nested)]),
  );
}
