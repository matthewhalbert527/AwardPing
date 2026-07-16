import { describe, expect, it, vi } from "vitest";
import type { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  loadAdminManualQuarantine,
  mapManualQuarantineItem,
  mapManualQuarantineSummary,
} from "@/lib/admin-manual-quarantine";

describe("admin manual quarantine loader", () => {
  it("maps the durable completion report and grouped evidence without double-counting cases", () => {
    const summary = mapManualQuarantineSummary({
      automated_work_clear: true,
      automated_blockers: {},
      quarantined_work_remaining: 293,
      quarantine_evidence_records: 509,
      historical_limitations: 390,
      historical_inventory_status: "complete",
      terminal_failures_requiring_action: 275,
      by_category: {
        public_page: {
          cases: 236,
          evidence_records: 452,
          terminal_cases: 216,
          terminal_failures: 218,
          oldest_observed_at: "2026-07-01T00:00:00.000Z",
          unknown_public_impact_cases: 20,
        },
        visual_review: {
          cases: 57,
          evidence_records: 57,
          terminal_cases: 57,
          terminal_failures: 57,
          oldest_observed_at: "2026-07-02T00:00:00.000Z",
          unknown_public_impact_cases: 0,
        },
        historical_localization: {
          cases: 390,
          evidence_records: 390,
          terminal_cases: 0,
          terminal_failures: 0,
          oldest_observed_at: "2025-01-01T00:00:00.000Z",
          unknown_public_impact_cases: 0,
        },
      },
      completion_status: "automated_work_clear",
      source_worker_run_id: "worker-one",
      completion_reported_at: "2026-07-15T21:00:00.000Z",
      historical_inventory_reported_at: "2026-07-15T05:09:29.867Z",
      historical_inventory_digest: "a".repeat(64),
      last_synced_at: "2026-07-15T21:05:00.000Z",
    });

    expect(summary).toMatchObject({
      automatedWorkClear: true,
      quarantinedWorkRemaining: 293,
      quarantineEvidenceRecords: 509,
      historicalLimitations: 390,
      historicalInventoryStatus: "complete",
      terminalFailuresRequiringAction: 275,
      completionStatus: "automated_work_clear",
      completionReportedAt: "2026-07-15T21:00:00.000Z",
      lastSyncedAt: "2026-07-15T21:05:00.000Z",
    });
    expect(summary.byCategory.public_page).toEqual({
      cases: 236,
      evidenceRecords: 452,
      terminalCases: 216,
      terminalFailures: 218,
      oldestObservedAt: "2026-07-01T00:00:00.000Z",
      unknownPublicImpactCases: 20,
    });
  });

  it("never turns a missing historical import into a false zero", () => {
    const summary = mapManualQuarantineSummary({
      automated_work_clear: null,
      automated_blockers: {},
      quarantined_work_remaining: 0,
      quarantine_evidence_records: 0,
      historical_limitations: 0,
      historical_inventory_status: "not_imported",
      terminal_failures_requiring_action: 0,
      by_category: {},
      completion_status: "not_reported",
      source_worker_run_id: null,
      completion_reported_at: null,
      historical_inventory_reported_at: null,
      historical_inventory_digest: null,
      last_synced_at: "2026-07-15T21:05:00.000Z",
    });

    expect(summary.historicalLimitations).toBeNull();
    expect(summary.historicalInventoryStatus).toBe("not_imported");
  });

  it("exposes every registry field needed by the Action Inbox", () => {
    const item = mapManualQuarantineItem(registryRow());

    expect(item).toMatchObject({
      id: "10000000-0000-4000-8000-000000000001",
      quarantineKey: "public-page:award-one",
      caseKey: "public-page:award-one",
      classification: "actionable_quarantine",
      category: "public_page",
      status: "quarantined",
      requiresAction: true,
      terminal: true,
      terminalFailureCount: 1,
      severity: "high",
      publicImpact: "protected",
      owner: "Public page review",
      retryMode: "operator_after_repair",
      retryCharge: "none",
      evidenceRecordCount: 2,
      evidenceHash: "b".repeat(64),
      awardId: "20000000-0000-4000-8000-000000000002",
      sourceId: null,
      visualCandidateId: null,
    });
  });

  it("reports a missing migration honestly and leaves the old Action Inbox available", async () => {
    const admin = mockAdmin({
      state: {
        data: null,
        error: {
          message:
            'relation "public.manual_quarantine_registry_state" does not exist',
        },
      },
      items: {
        data: null,
        error: {
          message:
            'relation "public.manual_quarantine_registry" does not exist',
        },
        count: null,
      },
    });

    const result = await loadAdminManualQuarantine(admin);

    expect(result.registryAvailable).toBe(false);
    expect(result.items).toEqual([]);
    expect(result.summary.historicalLimitations).toBeNull();
    expect(result.loadErrors).toEqual([
      "Manual Quarantine is not migrated for this deployment yet. Existing repair queues remain available in the Action Inbox.",
    ]);
  });

  it("paginates every actionable case instead of letting history consume an inbox cap", async () => {
    const rows = Array.from({ length: 1_001 }, (_, index) => ({
      ...registryRow(),
      id: `quarantine-${index}`,
      quarantine_key: `public-page:award-${index}`,
      case_key: `public-page:award-${index}`,
    }));
    const admin = mockAdmin({
      state: {
        data: {
          automated_work_clear: true,
          automated_blockers: {},
          quarantined_work_remaining: 1_001,
          quarantine_evidence_records: 1_217,
          historical_limitations: null,
          historical_inventory_status: "not_imported",
          terminal_failures_requiring_action: 275,
          by_category: {},
          completion_status: "automated_work_clear",
          source_worker_run_id: null,
          completion_reported_at: null,
          historical_inventory_reported_at: null,
          historical_inventory_digest: null,
          last_synced_at: "2026-07-15T21:05:00.000Z",
        },
        error: null,
      },
      items: { data: rows, error: null, count: 1_001 },
    });

    const result = await loadAdminManualQuarantine(admin, {
      now: new Date("2026-07-15T22:00:00.000Z"),
    });

    expect(result.registryAvailable).toBe(true);
    expect(result.total).toBe(1_001);
    expect(result.items).toHaveLength(1_001);
    expect(result.summary.quarantinedWorkRemaining).toBe(1_001);
    expect(result.loadErrors).toEqual([]);
  });

  it("loads an exact summary without materializing every case", async () => {
    const admin = mockAdmin({
      state: {
        data: {
          ...authoritativeState(),
          quarantined_work_remaining: 292,
        },
        error: null,
      },
      items: {
        data: Array.from({ length: 292 }, (_, index) => ({
          ...registryRow(),
          id: `quarantine-${index}`,
        })),
        error: null,
        count: 292,
      },
    });

    const result = await loadAdminManualQuarantine(admin, {
      includeItems: false,
      now: new Date("2026-07-15T22:00:00.000Z"),
    });

    expect(result.registryAvailable).toBe(true);
    expect(result.total).toBe(292);
    expect(result.items).toEqual([]);
    expect(result.summary.quarantinedWorkRemaining).toBe(292);
  });

  it("falls back to raw repair queues when a registry query fails", async () => {
    const admin = mockAdmin({
      state: {
        data: authoritativeState(),
        error: null,
      },
      items: {
        data: null,
        error: { message: "connection reset while loading quarantine rows" },
        count: null,
      },
    });

    const result = await loadAdminManualQuarantine(admin, {
      now: new Date("2026-07-15T22:00:00.000Z"),
    });

    expect(result.registryAvailable).toBe(false);
    expect(result.items).toEqual([]);
    expect(result.loadErrors.join(" ")).toContain("could not be loaded authoritatively");
    expect(result.loadErrors.join(" ")).toContain("not reported as zero");
  });

  it("falls back when the registry state is missing or stale", async () => {
    const missingState = await loadAdminManualQuarantine(
      mockAdmin({
        state: { data: null, error: null },
        items: { data: [registryRow()], error: null, count: 1 },
      }),
      { now: new Date("2026-07-15T22:00:00.000Z") },
    );
    const staleState = await loadAdminManualQuarantine(
      mockAdmin({
        state: {
          data: { ...authoritativeState(), last_synced_at: "2026-07-15T18:00:00.000Z" },
          error: null,
        },
        items: { data: [registryRow()], error: null, count: 1 },
      }),
      { now: new Date("2026-07-15T22:00:00.000Z") },
    );

    expect(missingState.registryAvailable).toBe(false);
    expect(staleState.registryAvailable).toBe(false);
    expect(staleState.loadErrors.join(" ")).toContain("stale");
  });
});

function authoritativeState() {
  return {
    automated_work_clear: true,
    automated_blockers: {},
    quarantined_work_remaining: 293,
    quarantine_evidence_records: 509,
    historical_limitations: 390,
    historical_inventory_status: "complete",
    terminal_failures_requiring_action: 275,
    by_category: {},
    completion_status: "automated_work_clear",
    source_worker_run_id: null,
    completion_reported_at: "2026-07-15T21:00:00.000Z",
    historical_inventory_reported_at: "2026-07-15T05:09:29.867Z",
    historical_inventory_digest: "a".repeat(64),
    last_synced_at: "2026-07-15T21:05:00.000Z",
  };
}

function registryRow() {
  return {
    id: "10000000-0000-4000-8000-000000000001",
    quarantine_key: "public-page:award-one",
    case_key: "public-page:award-one",
    classification: "actionable_quarantine",
    category: "public_page",
    status: "quarantined",
    requires_action: true,
    terminal: true,
    terminal_failure_count: 1,
    severity: "high",
    public_impact: "protected",
    owner: "Public page review",
    retry_mode: "operator_after_repair",
    retry_charge: "none",
    title: "Award One: public page needs review",
    reason_code: "latest_reconciliation_failed",
    reason: "The latest reconciliation failed.",
    recommended_action: "Repair this award, then rerun reconciliation.",
    shared_award_id: "20000000-0000-4000-8000-000000000002",
    shared_award_source_id: null,
    visual_review_candidate_id: null,
    primary_source_table: "shared_award_page_audits",
    primary_source_record_id: "30000000-0000-4000-8000-000000000003",
    evidence_record_count: 2,
    evidence: {
      audit: { id: "audit-one" },
      reconciliation: { id: "recon-one" },
    },
    evidence_hash: "b".repeat(64),
    policy_id: "awardping-manual-quarantine",
    policy_version: "1",
    policy_hash: "c".repeat(64),
    first_observed_at: "2026-07-01T00:00:00.000Z",
    last_observed_at: "2026-07-15T20:00:00.000Z",
    quarantined_at: "2026-07-15T20:05:00.000Z",
    updated_at: "2026-07-15T20:05:00.000Z",
  };
}

function mockAdmin(results: {
  state: { data: unknown; error: { message: string } | null };
  items: {
    data: unknown;
    error: { message: string } | null;
    count: number | null;
  };
}) {
  const stateQuery = {
    select: vi.fn(),
    eq: vi.fn(),
    maybeSingle: vi.fn(async () => results.state),
  };
  stateQuery.select.mockReturnValue(stateQuery);
  stateQuery.eq.mockReturnValue(stateQuery);

  const itemQuery = {
    select: vi.fn(),
    eq: vi.fn(),
    in: vi.fn(),
    order: vi.fn(),
    range: vi.fn(async (start: number, end: number) => {
      if (results.items.error) return results.items;
      const rows = Array.isArray(results.items.data) ? results.items.data : [];
      return {
        data: rows.slice(start, end + 1),
        error: null,
        count: results.items.count ?? rows.length,
      };
    }),
  };
  itemQuery.select.mockReturnValue(itemQuery);
  itemQuery.eq.mockReturnValue(itemQuery);
  itemQuery.in.mockReturnValue(itemQuery);
  itemQuery.order.mockReturnValue(itemQuery);

  return {
    from: vi.fn((table: string) =>
      table === "manual_quarantine_registry_state" ? stateQuery : itemQuery,
    ),
  } as unknown as ReturnType<typeof createSupabaseAdminClient>;
}
