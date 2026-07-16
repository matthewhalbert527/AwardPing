import { describe, expect, it, vi } from "vitest";
import type { Json } from "@/lib/database.types";
import type { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  defaultAdminManualQuarantineBacklogQuery,
  loadAdminManualQuarantineBacklog,
  loadAdminManualQuarantineSavedViews,
  parseAdminManualQuarantineBacklogPayload,
  parseAdminManualQuarantineBacklogQuery,
} from "@/lib/admin-manual-quarantine-backlog";

describe("admin manual quarantine backlog loader", () => {
  it("keeps the exact total when a page starts after item 200 and builds safe evidence links", async () => {
    const query = {
      ...defaultAdminManualQuarantineBacklogQuery(),
      page: 9,
      snapshotAt: "2026-07-16T12:00:00.000Z",
      snapshotRevision: 17,
      asOfAt: "2026-07-16T12:30:00.000Z",
    };
    const rpc = vi.fn().mockResolvedValue({
      data: backlogPayload(),
      error: null,
    });

    const result = await loadAdminManualQuarantineBacklog(
      { rpc } as unknown as ReturnType<typeof createSupabaseAdminClient>,
      query,
    );

    expect(result.available).toBe(true);
    expect(result.backlog.countsAuthoritative).toBe(true);
    expect(result.backlog).toMatchObject({
      exactTotal: 236,
      unfilteredExactTotal: 236,
      page: 9,
      pageSize: 25,
      pageCount: 10,
    });
    expect(result.backlog.items).toHaveLength(25);
    expect(result.backlog.items[0]).toMatchObject({
      awardHref: "/award-one",
      sourceHref: "https://example.edu/award",
    });
    expect(rpc).toHaveBeenCalledWith(
      "list_manual_quarantine_backlog",
      expect.objectContaining({
        p_page: 9,
        p_page_size: 25,
        p_expected_synced_at: "2026-07-16T12:00:00.000Z",
        p_expected_revision: 17,
        p_as_of_at: "2026-07-16T12:30:00.000Z",
      }),
    );
  });

  it("fails closed when an exact count is missing instead of deriving it from the page length", async () => {
    const payload = backlogPayload() as Record<string, Json | undefined>;
    delete payload.exact_total;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await loadAdminManualQuarantineBacklog(
      mockRpcAdmin({ data: payload as Json, error: null }),
      {
        ...defaultAdminManualQuarantineBacklogQuery(),
        page: 9,
        snapshotAt: "2026-07-16T12:00:00.000Z",
      },
    );

    expect(result.available).toBe(false);
    expect(result.backlog.countsAuthoritative).toBe(false);
    expect(result.loadErrors.join(" ")).toContain("incomplete accounting");
    expect(result.loadErrors.join(" ")).not.toContain("25");
    consoleError.mockRestore();
  });

  it("rejects a partial item page and any result that enables paid or resolving actions", () => {
    const query = {
      ...defaultAdminManualQuarantineBacklogQuery(),
      page: 9,
      snapshotAt: "2026-07-16T12:00:00.000Z",
    };
    const partial = backlogPayload();
    partial.items = partial.items.slice(0, 24);
    const unsafe = backlogPayload();
    unsafe.items[0].safe_actions.creates_api_charge = true as false;

    expect(parseAdminManualQuarantineBacklogPayload(partial, query)).toMatchObject({
      success: false,
    });
    expect(parseAdminManualQuarantineBacklogPayload(unsafe, query)).toMatchObject({
      success: false,
    });
  });

  it("fails closed and sanitizes loader exceptions", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const admin = {
      rpc: vi.fn().mockRejectedValue(new Error("database password leaked here")),
    } as unknown as ReturnType<typeof createSupabaseAdminClient>;

    const result = await loadAdminManualQuarantineBacklog(
      admin,
      defaultAdminManualQuarantineBacklogQuery(),
    );

    expect(result.available).toBe(false);
    expect(result.loadErrors.join(" ")).not.toContain("password");
    expect(result.backlog.countsAuthoritative).toBe(false);
    consoleError.mockRestore();
  });

  it("recognizes a missing RPC by error code even when the message is generic", async () => {
    const result = await loadAdminManualQuarantineBacklog(
      mockRpcAdmin({
        data: null,
        error: { code: "PGRST202", message: "not found" },
      }),
      defaultAdminManualQuarantineBacklogQuery(),
    );

    expect(result.available).toBe(false);
    expect(result.loadErrors.join(" ")).toContain("not available");
  });

  it("bounds and sanitizes query parameters before calling the RPC", () => {
    const query = parseAdminManualQuarantineBacklogQuery({
      mq_page: "1000001",
      mq_page_size: "200",
      mq_domain: [" example.edu , example.org ", "example.edu"],
      mq_status: ["quarantined", "resolved"],
      mq_view: "not-a-uuid",
      mq_snapshot: "yesterday",
      mq_search: "  changed   wording  ",
    });

    expect(query).toMatchObject({
      page: 1,
      pageSize: 25,
      domains: ["example.edu", "example.org"],
      statuses: ["quarantined"],
      activeViewId: null,
      snapshotAt: null,
      search: "changed wording",
    });
  });

  it("loads saved views only through the signed-in user's user_id", async () => {
    const userId = "40000000-0000-4000-8000-000000000004";
    const query = savedViewsQuery({
      data: [savedViewRow()],
      error: null,
    });
    const admin = {
      from: vi.fn().mockReturnValue(query),
    } as unknown as ReturnType<typeof createSupabaseAdminClient>;

    const result = await loadAdminManualQuarantineSavedViews(admin, userId);

    expect(result.available).toBe(true);
    expect(result.views).toHaveLength(1);
    expect(query.eq).toHaveBeenCalledWith("user_id", userId);
    expect(admin.from).toHaveBeenCalledWith("manual_quarantine_saved_views");
  });

  it("does not display malformed saved views", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const row = savedViewRow() as Record<string, unknown>;
    delete row.filters;
    const admin = {
      from: vi.fn().mockReturnValue(
        savedViewsQuery({ data: [row], error: null }),
      ),
    } as unknown as ReturnType<typeof createSupabaseAdminClient>;

    const result = await loadAdminManualQuarantineSavedViews(
      admin,
      "40000000-0000-4000-8000-000000000004",
    );

    expect(result).toMatchObject({ available: false, views: [] });
    consoleError.mockRestore();
  });
});

function backlogPayload() {
  const items = Array.from({ length: 25 }, (_, index) => backlogItem(index + 201));
  const facet = [{ key: "all", label: "All", cases: 236 }];
  return {
    schema_version: "manual-quarantine-backlog-v1" as const,
    as_of: "2026-07-16T12:30:00.000Z",
    as_of_at: "2026-07-16T12:30:00.000Z",
    backlog_revision: 17,
    registry_synced_at: "2026-07-16T12:00:00.000Z",
    registry_state_total: 236,
    registry_fresh: true,
    counts_match: true,
    group_by: "repair_group" as const,
    sort: "oldest" as const,
    unfiltered_exact_total: 236,
    exact_total: 236,
    evidence_records: 452,
    terminal_cases: 216,
    unassigned_cases: 236,
    charge_gated_cases: 12,
    oldest_observed_at: "2026-07-01T00:00:00.000Z",
    page: 9,
    page_size: 25 as const,
    page_count: 10,
    cluster_page: 1,
    cluster_page_size: 12,
    cluster_page_count: 1,
    exact_cluster_total: 1,
    clusters: [
      {
        key: "example.edu|latest_reconciliation_failed|policy:1:protected|repair",
        label: "Repair award data",
        cases: 236,
        evidence_records: 452,
        terminal_cases: 216,
        unassigned_cases: 236,
        charge_gated_cases: 12,
        oldest_observed_at: "2026-07-01T00:00:00.000Z",
        source_domain: "example.edu",
        evidence_failure_code: "latest_reconciliation_failed",
        evidence_failure_label: "Latest reconciliation failed",
        policy_reason_code: "policy:1:protected",
        policy_reason_label: "Keep last-known-good public facts",
        likely_repair_code: "repair",
        likely_repair_label: "Repair award data",
      },
    ],
    items,
    facets: {
      domains: facet,
      evidence_failures: facet,
      policy_reasons: facet,
      repairs: facet,
      owners: facet,
      statuses: facet,
      ages: facet,
    },
  };
}

function backlogItem(index: number) {
  return {
    id: indexedUuid(index),
    quarantine_key: `public-page:award-${index}`,
    case_key: `public-page:award-${index}`,
    category: "public_page" as const,
    status: "quarantined" as const,
    terminal: index <= 216,
    terminal_failure_count: index <= 216 ? 1 : 0,
    severity: "high" as const,
    public_impact: "protected" as const,
    functional_owner: "Public page review",
    assigned_to_user_id: null,
    assigned_to_email: null,
    assigned_at: null,
    retry_mode: "operator_after_repair",
    retry_charge: "none" as const,
    title: `Award ${index} needs review`,
    reason_code: "latest_reconciliation_failed",
    reason: "The latest reconciliation failed.",
    recommended_action: "Repair the award, then rerun reconciliation.",
    award_id: "10000000-0000-4000-8000-000000000001",
    award_name: "Award One",
    award_slug: "award-one",
    source_id: "20000000-0000-4000-8000-000000000002",
    source_url: "https://example.edu/award",
    source_domain: "example.edu",
    source_domain_basis: "event_specific_source" as const,
    visual_candidate_id: null,
    evidence_record_count: 2,
    evidence_hash: "a".repeat(64),
    policy_id: "awardping-manual-quarantine",
    policy_version: "1",
    policy_hash: "b".repeat(64),
    evidence_failure_code: "latest_reconciliation_failed",
    evidence_failure_label: "Latest reconciliation failed",
    policy_reason_code: "policy:1:protected",
    policy_reason_label: "Keep last-known-good public facts",
    likely_repair_code: "repair",
    likely_repair_label: "Repair award data",
    first_observed_at: "2026-07-01T00:00:00.000Z",
    last_observed_at: "2026-07-16T11:30:00.000Z",
    updated_at: "2026-07-16T12:00:00.000Z",
    age_days: 15,
    age_bucket: "eight_to_thirty_days" as const,
    safe_actions: {
      assign_to_me: true,
      unassign: false,
      start_review: true,
      creates_api_charge: false as const,
      can_retry: false as const,
      can_resolve: false as const,
    },
  };
}

function indexedUuid(index: number) {
  return `30000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function mockRpcAdmin(result: unknown) {
  return {
    rpc: vi.fn().mockResolvedValue(result),
  } as unknown as ReturnType<typeof createSupabaseAdminClient>;
}

function savedViewRow() {
  return {
    id: "50000000-0000-4000-8000-000000000005",
    name: "Oldest unassigned",
    filters: {
      domains: ["example.edu"],
      evidence_failures: [],
      policy_reasons: [],
      repairs: [],
      owners: ["unassigned"],
      statuses: ["quarantined"],
      age_bucket: null,
      search: "",
    },
    group_by: "domain",
    sort_key: "oldest",
    page_size: 25,
    updated_at: "2026-07-16T12:00:00.000Z",
  };
}

function savedViewsQuery(result: unknown) {
  const query = {
    select: vi.fn(),
    eq: vi.fn(),
    order: vi.fn(),
  };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  query.order.mockReturnValueOnce(query).mockResolvedValueOnce(result);
  return query;
}
