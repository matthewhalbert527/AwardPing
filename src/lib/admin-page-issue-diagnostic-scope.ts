const durableQuarantineAuditStatuses = new Set(["failed", "needs_review"]);
const durableQuarantineAuditSeverities = new Set(["error", "critical"]);
const staleReconciliationAfterMs = 45 * 60 * 1000;

export const nonQuarantinedPageAuditFilter =
  "audit_status.not.in.(failed,needs_review),severity.not.in.(error,critical),severity.is.null,resolved_at.not.is.null";

export function reconciliationDiagnosticStatuses(
  includeQuarantinedDiagnostics: boolean,
) {
  return includeQuarantinedDiagnostics
    ? (["failed", "processing"] as const)
    : (["processing"] as const);
}

export function shouldIncludeReconciliationDiagnostic(
  row: Record<string, unknown>,
  includeQuarantinedDiagnostics: boolean,
  nowMs = Date.now(),
) {
  const status = diagnosticKey(row.status);
  if (status === "failed") return includeQuarantinedDiagnostics;
  if (status !== "processing") return false;
  return (
    dateMs(cleanText(row.started_at || row.created_at) || null) <=
    nowMs - staleReconciliationAfterMs
  );
}

export function pageAuditIsRepresentedByDurableQuarantine(
  row: Record<string, unknown>,
) {
  return (
    !cleanText(row.resolved_at) &&
    durableQuarantineAuditStatuses.has(diagnosticKey(row.audit_status)) &&
    durableQuarantineAuditSeverities.has(diagnosticKey(row.severity))
  );
}

export function shouldIncludePageAuditDiagnostic(
  row: Record<string, unknown>,
  includeQuarantinedDiagnostics: boolean,
) {
  return (
    includeQuarantinedDiagnostics ||
    !pageAuditIsRepresentedByDurableQuarantine(row)
  );
}

function dateMs(value: string | null) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function cleanText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function diagnosticKey(value: unknown) {
  return cleanText(value).toLowerCase().replaceAll("-", "_");
}
