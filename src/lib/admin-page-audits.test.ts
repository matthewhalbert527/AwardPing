import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { pageAuditFindingCategory, summarizePageAudits } from "@/lib/admin-page-audits";

describe("admin page audit summary", () => {
  it("counts statuses, severities, unresolved audits, and finding categories", () => {
    const summary = summarizePageAudits([
      {
        id: "audit-1",
        shared_award_id: "award-1",
        audit_status: "failed",
        severity: "critical",
        findings: [{ code: "deadline_missing_evidence", message: "Deadline lacks evidence" }],
        field_conflicts: [{ field_name: "deadline" }],
        created_at: "2026-07-09T00:00:00.000Z",
        resolved_at: null,
        shared_awards: { name: "Example Award", slug: "example-award" },
      },
      {
        id: "audit-2",
        shared_award_id: "award-2",
        audit_status: "warnings",
        severity: "warning",
        findings: [{ code: "missing_amount_with_official_evidence" }],
        created_at: "2026-07-09T00:01:00.000Z",
        resolved_at: "2026-07-09T01:00:00.000Z",
      },
    ]);

    expect(summary.statusCounts.failed).toBe(1);
    expect(summary.statusCounts.warnings).toBe(1);
    expect(summary.severityCounts.critical).toBe(1);
    expect(summary.unresolved).toBe(1);
    expect(summary.critical).toBe(1);
    expect(summary.commonFindings.map((item) => item.reason)).toContain("unsupported_deadline");
    expect(summary.commonFindings.map((item) => item.reason)).toContain("deadline_conflict");
    expect(summary.latestExamples[0].awardName).toBe("Example Award");
  });

  it("normalizes known audit findings into admin categories", () => {
    expect(pageAuditFindingCategory("invented_future_deadline")).toBe("invented_future_deadline");
    expect(pageAuditFindingCategory("field_conflict_deadline")).toBe("deadline_conflict");
    expect(pageAuditFindingCategory("generic_listing_used_for_facts")).toBe("generic_listing_used_for_facts");
  });
});
