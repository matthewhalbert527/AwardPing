import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  AdminManualQuarantineBacklogQueue,
  manualQuarantineBulkEligibility,
  refreshManualQuarantineQueue,
  shouldRetainManualQuarantineRequestId,
} from "@/components/admin-manual-quarantine-backlog-queue";
import { manualQuarantineBacklogItem } from "@/components/admin-manual-quarantine-backlog-test-fixtures";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }),
}));

describe("AdminManualQuarantineBacklogQueue", () => {
  it("shows case age, functional owner, assignment, grouping evidence, and safe actions", () => {
    const html = renderToStaticMarkup(
      createElement(AdminManualQuarantineBacklogQueue, {
        available: true,
        currentUserEmail: "operator@example.com",
        currentUserId: "30000000-0000-4000-8000-000000000003",
        items: [manualQuarantineBacklogItem()],
        refreshHref: "/dashboard/admin/issues?tab=quarantine",
      }),
    );

    expect(html).toContain("18 days old");
    expect(html).toContain("Functional owner");
    expect(html).toContain("Evidence repair");
    expect(html).toContain("Individual assignment");
    expect(html).toContain("Unassigned");
    expect(html).toContain("Baseline image evidence is missing");
    expect(html).toContain("Last-known-good protection blocked publication");
    expect(html).toContain("Rehydrate immutable evidence from R2");
    expect(html).toContain("event-specific source");
    expect(html).toContain("Event source");
    expect(html).not.toContain("Original source");
    expect(html).toContain("Assign to me");
    expect(html).toContain("Start review");
    expect(html).toContain("Return my cases to queue");
    expect(html).not.toMatch(/>Retry</);
    expect(html).not.toMatch(/>Resolve</);
  });

  it("labels source links by their actual provenance", () => {
    const html = renderToStaticMarkup(
      createElement(AdminManualQuarantineBacklogQueue, {
        available: true,
        currentUserEmail: "operator@example.com",
        currentUserId: "30000000-0000-4000-8000-000000000003",
        items: [
          manualQuarantineBacklogItem({
            sourceDomainBasis: "award_homepage_fallback",
          }),
        ],
        refreshHref: "/dashboard/admin/issues?tab=quarantine",
      }),
    );

    expect(html).toContain("Award homepage");
    expect(html).not.toContain("Original source");
  });

  it("allows only ownership-safe actions for a homogeneous selection", () => {
    const unassigned = manualQuarantineBacklogItem();
    expect(
      manualQuarantineBulkEligibility(
        [unassigned],
        "30000000-0000-4000-8000-000000000003",
        "operator@example.com",
      ),
    ).toEqual({
      assignToMe: true,
      startReview: false,
      unassignOwn: false,
    });

    const own = manualQuarantineBacklogItem({
      assignedToUserId: "30000000-0000-4000-8000-000000000003",
      assignedToEmail: "old-operator@example.com",
      safeActions: {
        ...unassigned.safeActions,
        unassign: true,
      },
    });
    expect(
      manualQuarantineBulkEligibility(
        [own],
        "30000000-0000-4000-8000-000000000003",
        "operator@example.com",
      ),
    ).toEqual({
      assignToMe: true,
      startReview: true,
      unassignOwn: true,
    });

    const other = manualQuarantineBacklogItem({
      assignedToUserId: "40000000-0000-4000-8000-000000000004",
      assignedToEmail: "other@example.com",
      safeActions: {
        ...unassigned.safeActions,
        unassign: true,
      },
    });
    expect(
      manualQuarantineBulkEligibility(
        [other],
        "30000000-0000-4000-8000-000000000003",
        "operator@example.com",
      ),
    ).toEqual({
      assignToMe: false,
      startReview: false,
      unassignOwn: false,
    });
  });

  it("returns an owned in-review case to quarantine without starting review twice", () => {
    const item = manualQuarantineBacklogItem({
      assignedToUserId: "30000000-0000-4000-8000-000000000003",
      assignedToEmail: "operator@example.com",
      safeActions: {
        ...manualQuarantineBacklogItem().safeActions,
        startReview: false,
        unassign: true,
      },
      status: "in_review",
    });

    expect(
      manualQuarantineBulkEligibility(
        [item],
        "30000000-0000-4000-8000-000000000003",
        "operator@example.com",
      ),
    ).toEqual({
      assignToMe: true,
      startReview: false,
      unassignOwn: true,
    });
  });

  it("retains idempotency keys only when the outcome is ambiguous", () => {
    expect(shouldRetainManualQuarantineRequestId(null)).toBe(true);
    expect(shouldRetainManualQuarantineRequestId(500)).toBe(true);
    expect(shouldRetainManualQuarantineRequestId(503)).toBe(true);
    expect(shouldRetainManualQuarantineRequestId(400)).toBe(false);
    expect(shouldRetainManualQuarantineRequestId(409)).toBe(false);
    expect(shouldRetainManualQuarantineRequestId(403)).toBe(false);
  });

  it("clears stale snapshot tokens and guarantees a fresh server render", () => {
    const router = { refresh: vi.fn(), replace: vi.fn() };
    refreshManualQuarantineQueue(
      router,
      "/dashboard/admin/issues?tab=quarantine",
    );

    expect(router.replace).toHaveBeenCalledWith(
      "/dashboard/admin/issues?tab=quarantine",
      { scroll: false },
    );
    expect(router.refresh).toHaveBeenCalledOnce();
  });
});
