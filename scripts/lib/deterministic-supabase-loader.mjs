import crypto from "node:crypto";

const defaultPageSize = 500;
const defaultMaximumRows = 250_000;
const identifierPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Load one table through a stable id keyset twice, proving that its exact row
 * count, latest revision, and canonical full-row projection did not change.
 * Every caller gets either one complete, deduplicated snapshot or an exception;
 * partial or internally inconsistent rows are never returned.
 */
export async function loadDeterministicSupabaseRows({
  supabase,
  table,
  select,
  idColumn = "id",
  revisionColumn = "updated_at",
  pageSize = defaultPageSize,
  maximumRows = defaultMaximumRows,
  label = table,
  filterQuery = null,
}) {
  requireClient(supabase);
  requireIdentifier(table, "table");
  requireIdentifier(idColumn, "id column");
  requireIdentifier(revisionColumn, "revision column");
  requireProjection(select, idColumn, revisionColumn);
  requireFilterQuery(filterQuery);
  const boundedPageSize = boundedPositiveInteger(pageSize, defaultPageSize, 1_000);
  const boundedMaximumRows = boundedPositiveInteger(
    maximumRows,
    defaultMaximumRows,
    1_000_000,
  );

  const initial = await loadExactRevision({
    supabase,
    table,
    idColumn,
    revisionColumn,
    label,
    filterQuery,
  });
  if (initial.count > boundedMaximumRows) {
    throw loadError(
      label,
      `exact row count ${initial.count} exceeds the ${boundedMaximumRows} safety ceiling`,
    );
  }

  const firstPass = await loadProjectionPass({
    supabase,
    table,
    select,
    idColumn,
    revisionColumn,
    pageSize: boundedPageSize,
    expectedCount: initial.count,
    label,
    filterQuery,
    retainRows: true,
  });
  const verificationPass = await loadProjectionPass({
    supabase,
    table,
    select,
    idColumn,
    revisionColumn,
    pageSize: boundedPageSize,
    expectedCount: initial.count,
    label,
    filterQuery,
    retainRows: false,
  });

  const final = await loadExactRevision({
    supabase,
    table,
    idColumn,
    revisionColumn,
    label,
    filterQuery,
  });
  if (final.count !== initial.count || final.revision !== initial.revision) {
    throw loadError(label, "row count or revision changed during deterministic loading");
  }
  if (verificationPass.projectionHash !== firstPass.projectionHash) {
    throw loadError(
      label,
      "full row projection changed between deterministic passes",
    );
  }
  return firstPass.rows;
}

async function loadProjectionPass({
  supabase,
  table,
  select,
  idColumn,
  revisionColumn,
  pageSize,
  expectedCount,
  label,
  filterQuery,
  retainRows,
}) {
  const rows = [];
  const seenIds = new Set();
  const projectionHash = createProjectionHash({
    select,
    idColumn,
    revisionColumn,
  });
  let loadedCount = 0;
  let cursor = null;
  while (loadedCount < expectedCount) {
    let query = supabase.from(table).select(select, { count: "exact" });
    query = applyFilterQuery(query, filterQuery, label);
    query = query.order(idColumn, { ascending: true }).limit(pageSize);
    if (cursor !== null) query = query.gt(idColumn, cursor);
    const result = await query;
    if (result.error) throw loadError(label, result.error.message, result.error.code);

    const remaining = expectedCount - loadedCount;
    const exactRemaining = exactCount(result.count);
    if (exactRemaining === null) {
      throw loadError(
        label,
        "exact remaining-row count was unavailable during pagination",
      );
    }
    if (exactRemaining !== remaining) {
      throw loadError(
        label,
        `row count changed during pagination (expected ${remaining} remaining, found ${exactRemaining})`,
      );
    }

    const page = Array.isArray(result.data) ? result.data : [];
    const expectedPageLength = Math.min(pageSize, remaining);
    if (page.length !== expectedPageLength) {
      throw loadError(
        label,
        `incomplete page (expected ${expectedPageLength} rows, received ${page.length})`,
      );
    }

    let priorPageId = cursor;
    for (const row of page) {
      const id = requiredRowId(row, idColumn, label);
      if (priorPageId !== null && compareIds(id, priorPageId) <= 0) {
        throw loadError(label, `non-increasing ${idColumn} order at ${id}`);
      }
      if (seenIds.has(id)) throw loadError(label, `duplicate ${idColumn} ${id}`);
      seenIds.add(id);
      addProjectionRow(projectionHash, row, label);
      if (retainRows) rows.push(row);
      loadedCount += 1;
      priorPageId = id;
    }
    cursor = priorPageId;
  }

  if (loadedCount !== expectedCount || seenIds.size !== expectedCount) {
    throw loadError(
      label,
      `snapshot completeness failed (expected ${expectedCount}, loaded ${loadedCount}, unique ${seenIds.size})`,
    );
  }
  projectionHash.update(`\nrows:${loadedCount}`);
  return { rows, projectionHash: projectionHash.digest("hex") };
}

async function loadExactRevision({
  supabase,
  table,
  idColumn,
  revisionColumn,
  label,
  filterQuery,
}) {
  let query = supabase
    .from(table)
    .select(`${idColumn},${revisionColumn}`, { count: "exact" });
  query = applyFilterQuery(query, filterQuery, label);
  const result = await query
    .order(revisionColumn, { ascending: false, nullsFirst: false })
    .order(idColumn, { ascending: true })
    .limit(1);
  if (result.error) throw loadError(label, result.error.message, result.error.code);
  const count = exactCount(result.count);
  if (count === null) throw loadError(label, "exact row count was unavailable");
  const rows = Array.isArray(result.data) ? result.data : [];
  if (count > 0 && rows.length !== 1) {
    throw loadError(label, "revision row was unavailable for a non-empty table");
  }
  if (count === 0 && rows.length !== 0) {
    throw loadError(label, "revision query returned a row for an empty table");
  }
  const row = rows[0] || null;
  return {
    count,
    revision: row
      ? `${String(row[revisionColumn] ?? "<null>")}\n${requiredRowId(row, idColumn, label)}`
      : null,
  };
}

function requireClient(value) {
  if (!value || typeof value.from !== "function") {
    throw new Error("Deterministic Supabase loading requires a Supabase client.");
  }
}

function requireIdentifier(value, label) {
  if (!identifierPattern.test(String(value || ""))) {
    throw new Error(`Deterministic Supabase loading received an invalid ${label}.`);
  }
}

function requireProjection(value, idColumn, revisionColumn) {
  const columns = String(value || "")
    .split(",")
    .map((column) => column.trim())
    .filter(Boolean);
  if (!columns.includes(idColumn) || !columns.includes(revisionColumn)) {
    throw new Error(
      `Deterministic Supabase selection must include ${idColumn} and ${revisionColumn}.`,
    );
  }
}

function requireFilterQuery(value) {
  if (value !== null && typeof value !== "function") {
    throw new Error("Deterministic Supabase filterQuery must be a function.");
  }
}

function applyFilterQuery(query, filterQuery, label) {
  if (!filterQuery) return query;
  const filtered = filterQuery(query);
  if (!filtered || typeof filtered !== "object") {
    throw loadError(label, "filterQuery did not return a query builder");
  }
  return filtered;
}

function createProjectionHash({ select, idColumn, revisionColumn }) {
  const hash = crypto.createHash("sha256");
  hash.update("awardping:deterministic-supabase-projection:v2\n");
  hash.update(`${select}\n${idColumn}\n${revisionColumn}\n`);
  return hash;
}

function addProjectionRow(hash, row, label) {
  let canonical;
  try {
    canonical = canonicalJson(row);
  } catch (error) {
    throw loadError(
      label,
      `row projection could not be canonicalized: ${error?.message || "unknown value"}`,
    );
  }
  hash.update(`${Buffer.byteLength(canonical, "utf8")}:`);
  hash.update(canonical);
}

function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => {
        if (value[key] === undefined) throw new Error(`undefined field ${key}`);
        return `${JSON.stringify(key)}:${canonicalJson(value[key])}`;
      })
      .join(",")}}`;
  }
  throw new Error(`unsupported ${typeof value}`);
}

function requiredRowId(row, idColumn, label) {
  const value = row?.[idColumn];
  if (typeof value !== "string" || !value.trim()) {
    throw loadError(label, `row is missing a non-empty ${idColumn}`);
  }
  return value;
}

function exactCount(value) {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function compareIds(left, right) {
  const leftText = String(left);
  const rightText = String(right);
  if (leftText === rightText) return 0;
  return leftText < rightText ? -1 : 1;
}

function boundedPositiveInteger(value, fallback, maximum) {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function loadError(label, message, code = null) {
  const error = new Error(`${label}: deterministic snapshot failed: ${message}`);
  if (code) error.code = code;
  return error;
}
