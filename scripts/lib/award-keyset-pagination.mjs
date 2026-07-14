const supportedSortColumns = new Set(["created_at", "name"]);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function applyAscendingAwardKeyset(query, sortColumn, cursor = null) {
  const column = awardSortColumn(sortColumn);
  let ordered = query
    .order(column, { ascending: true })
    .order("id", { ascending: true });
  const filter = ascendingAwardKeysetFilter(column, cursor);
  if (filter) ordered = ordered.or(filter);
  return ordered;
}

export function ascendingAwardKeysetFilter(sortColumn, cursor) {
  const column = awardSortColumn(sortColumn);
  if (!cursor) return null;
  const sortValue = postgrestQuotedValue(cursor.sortValue, `${column} cursor`);
  const id = awardCursorId(cursor.id);
  return [
    `${column}.gt.${sortValue}`,
    `and(${column}.eq.${sortValue},id.gt.${id})`,
  ].join(",");
}

export function awardCursorAfterPage(page, sortColumn, fallback = null) {
  const column = awardSortColumn(sortColumn);
  if (!Array.isArray(page) || !page.length) return fallback;
  const last = page.at(-1);
  const sortValue = last?.[column];
  const id = last?.id;
  if (sortValue === null || sortValue === undefined) {
    throw new Error(`Award keyset page is missing ${column}.`);
  }
  awardCursorId(id);
  return { sortValue, id };
}

function awardSortColumn(value) {
  const column = String(value || "");
  if (!supportedSortColumns.has(column)) {
    throw new Error(`Unsupported award keyset sort column: ${column || "missing"}.`);
  }
  return column;
}

function awardCursorId(value) {
  const id = String(value || "");
  if (!uuidPattern.test(id)) {
    throw new Error("Award keyset cursor id must be a UUID.");
  }
  return id;
}

function postgrestQuotedValue(value, label) {
  if (value === null || value === undefined) {
    throw new Error(`${label} is required.`);
  }
  return JSON.stringify(String(value));
}
