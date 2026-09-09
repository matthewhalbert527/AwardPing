import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { loadAdminPageIssues } from "@/lib/admin-page-issues";
import { buildOperatorActionInbox } from "@/lib/operator-action-inbox";
import { sourceIntakeReviewExplanation } from "@/lib/source-intake-operator-actions";

const reasons = [
  "invalid_fact_type_facts",
  "invalid_fact_type_description",
  "invalid_fact_type_deadline",
  "invalid_fact_type_amount",
  "invalid_fact_type_award_amount",
  "source_relevance_unclear",
  "cycle_relevance_unclear",
  "officialness_unclear",
  "confidence_low",
] as const;

describe("source intake explanations through the real issue and inbox adapters", () => {
  it.each(["needs_manual_review", "failed"] as const)(
    "keeps all nine explanations, diagnostics, and intake routing consistent at %s",
    async (status) => {
      const rows = reasons.map((reason) => intakeRow(status, reason));
      const { admin, sourceQuery } = mockAdmin(rows);
      const loaded = await loadAdminPageIssues(admin, [], { includeLegacyDiagnostics: false });

      expect(loaded.loadErrors).toEqual([]);
      expect(loaded.issues).toHaveLength(reasons.length);
      expect(sourceQuery.in).toHaveBeenCalledWith("status", ["failed", "needs_manual_review"]);

      const items = buildOperatorActionInbox({
        issues: loaded.issues,
        now: new Date("2026-09-09T06:00:00Z"),
      });
      expect(items).toHaveLength(reasons.length);

      for (const reason of reasons) {
        const issue = loaded.issues.find((entry) => entry.key === `source-intake:${reason}`);
        const item = items.find((entry) => entry.id === issue?.key);
        const explanation = sourceIntakeReviewExplanation(status, reason);
        expect(explanation).toBeTruthy();
        expect(issue).toMatchObject({
          currentValue: status,
          message: reason,
          recommendedAction: explanation,
          failures: status === "failed" ? 1 : 0,
        });
        expect(item).toMatchObject({
          failureReason: reason,
          action: { kind: "source_intake" },
          retry: { automatic: false },
          recommendedAction: {
            label: "Open Source Intake",
            href: "/dashboard/admin/source-intake",
            detail: explanation,
          },
        });
      }
    },
  );

  it("classifies by the reason while preserving a more specific saved error", async () => {
    const row = { ...intakeRow("needs_manual_review", "invalid_fact_type_deadline"), error: "Saved error details." };
    const { admin } = mockAdmin([row]);
    const { issues } = await loadAdminPageIssues(admin, [], { includeLegacyDiagnostics: false });
    expect(issues[0]).toMatchObject({
      message: "Saved error details.",
      recommendedAction: sourceIntakeReviewExplanation(row.status, row.status_reason),
    });
  });

  it.each([null, "", "future_reason", "invalid_fact_type_deadline_extra", "constructor"])(
    "preserves existing generic guidance for unrecognized reason %s",
    async (reason) => {
      const { admin } = mockAdmin([intakeRow("needs_manual_review", reason)]);
      const { issues } = await loadAdminPageIssues(admin, [], { includeLegacyDiagnostics: false });
      expect(issues[0].recommendedAction).toBe(
        "Open Source Intake, decide whether to retry, reject, attach to an award, or approve as a new award.",
      );
    },
  );
});

function intakeRow(status: string, reason: string | null) {
  return {
    id: reason || "request-1",
    award_name: "Example Award",
    homepage_url: "https://example.org/award",
    status,
    status_reason: reason,
    error: null as string | null,
    updated_at: "2026-09-09T05:00:00Z",
    worker_run_id: "worker-1",
  };
}

// No client or network is created: only the loader's existing read chain is modeled.
function mockAdmin(rows: ReturnType<typeof intakeRow>[]) {
  const sourceQuery = readQuery(rows);
  const from = vi.fn((table: string) => table === "source_page_requests" ? sourceQuery : readQuery([]));
  return {
    admin: { from } as unknown as Parameters<typeof loadAdminPageIssues>[0],
    sourceQuery,
  };
}

function readQuery(data: ReturnType<typeof intakeRow>[]) {
  const result = Promise.resolve({ data, count: data.length, error: null });
  const query = Object.assign(result, {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    not: vi.fn(() => query),
    in: vi.fn(() => query),
    order: vi.fn(() => query),
    limit: vi.fn(() => query),
    range: vi.fn(() => query),
    neq: vi.fn(() => query),
    is: vi.fn(() => query),
    or: vi.fn(() => query),
  });
  return query;
}
