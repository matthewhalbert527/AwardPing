import { describe, expect, it } from "vitest";
import {
  pageAuditIsRepresentedByDurableQuarantine,
  reconciliationDiagnosticStatuses,
  shouldIncludePageAuditDiagnostic,
  shouldIncludeReconciliationDiagnostic,
} from "@/lib/admin-page-issue-diagnostic-scope";

describe("admin issue diagnostics beside durable quarantine", () => {
  it("keeps stale processing reconciliation visible without duplicating failed quarantine rows", () => {
    const now = Date.parse("2026-07-15T12:00:00.000Z");
    const staleProcessing = {
      status: "processing",
      started_at: "2026-07-15T11:00:00.000Z",
    };
    const recentProcessing = {
      status: "processing",
      started_at: "2026-07-15T11:30:00.000Z",
    };
    const failed = {
      status: "failed",
      completed_at: "2026-07-15T11:45:00.000Z",
    };

    expect(reconciliationDiagnosticStatuses(false)).toEqual(["processing"]);
    expect(
      shouldIncludeReconciliationDiagnostic(staleProcessing, false, now),
    ).toBe(true);
    expect(
      shouldIncludeReconciliationDiagnostic(recentProcessing, false, now),
    ).toBe(false);
    expect(shouldIncludeReconciliationDiagnostic(failed, false, now)).toBe(
      false,
    );
    expect(shouldIncludeReconciliationDiagnostic(failed, true, now)).toBe(
      true,
    );
  });

  it("suppresses only unresolved error and critical audit rows represented by quarantine", () => {
    const quarantinedError = {
      audit_status: "needs_review",
      severity: "error",
      resolved_at: null,
    };
    const warning = {
      audit_status: "warnings",
      severity: "warning",
      resolved_at: null,
    };
    const lowSeverityFailure = {
      audit_status: "failed",
      severity: "warning",
      resolved_at: null,
    };
    const resolvedCritical = {
      audit_status: "failed",
      severity: "critical",
      resolved_at: "2026-07-15T11:00:00.000Z",
    };

    expect(pageAuditIsRepresentedByDurableQuarantine(quarantinedError)).toBe(
      true,
    );
    expect(shouldIncludePageAuditDiagnostic(quarantinedError, false)).toBe(
      false,
    );
    expect(shouldIncludePageAuditDiagnostic(warning, false)).toBe(true);
    expect(shouldIncludePageAuditDiagnostic(lowSeverityFailure, false)).toBe(
      true,
    );
    expect(shouldIncludePageAuditDiagnostic(resolvedCritical, false)).toBe(
      true,
    );
    expect(shouldIncludePageAuditDiagnostic(quarantinedError, true)).toBe(true);
  });
});
