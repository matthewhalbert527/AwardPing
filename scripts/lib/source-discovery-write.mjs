export function insertedDiscoveryRows(requestedRows, returnedRows) {
  if (!Array.isArray(requestedRows) || !Array.isArray(returnedRows)) return [];

  const returnedUrls = new Set(
    returnedRows
      .map((row) => cleanUrl(row?.url))
      .filter(Boolean),
  );
  if (!returnedUrls.size) return [];

  const seen = new Set();
  const inserted = [];
  for (const row of requestedRows) {
    const url = cleanUrl(row?.url);
    if (!url || seen.has(url) || !returnedUrls.has(url)) continue;
    seen.add(url);
    inserted.push(row);
  }
  return inserted;
}

function cleanUrl(value) {
  return typeof value === "string" ? value.trim() : "";
}
