export function canonicalStage1DiagnosticContentType(value) {
  const contentType = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!contentType) return null;
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+(?:;\s*charset=[a-z0-9._-]+)?$/.test(
    contentType,
  )
    ? contentType
    : "application/octet-stream";
}
