import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AdminManualQuarantineBacklogControls,
  adminManualQuarantineControlsHref,
} from "@/components/admin-manual-quarantine-backlog-controls";
import {
  manualQuarantineBacklog,
  manualQuarantineBacklogQuery,
} from "@/components/admin-manual-quarantine-backlog-test-fixtures";

const router = {
  push: vi.fn(),
  refresh: vi.fn(),
};

vi.mock("next/navigation", () => ({
  useRouter: () => router,
}));

describe("AdminManualQuarantineBacklogControls", () => {
  beforeEach(() => {
    router.push.mockReset();
    router.refresh.mockReset();
  });

  it("renders rollups, saved views, filters, ownership, age, and page size controls", () => {
    const query = manualQuarantineBacklogQuery();
    const html = renderToStaticMarkup(
      createElement(AdminManualQuarantineBacklogControls, {
        activeViewId: null,
        activeViewName: "",
        available: true,
        facets: manualQuarantineBacklog().facets,
        query,
        savedViewOptions: [
          {
            href: "/dashboard/admin/issues?tab=quarantine&mq_view=view-1",
            id: "view-1",
            name: "Old unassigned repairs",
          },
        ],
        savedViewsAvailable: true,
      }),
    );

    expect(html).toContain("Full repair groups");
    expect(html).toContain("Domain");
    expect(html).toContain("Evidence failure");
    expect(html).toContain("Policy reason");
    expect(html).toContain("Likely repair");
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("Saved view");
    expect(html).toContain("Old unassigned repairs");
    expect(html).toContain("Individual assignment");
    expect(html).toContain("Age");
    expect(html).toContain("Cases per page");
    expect(html).toContain("Apply filters");
  });

  it("serializes all selected filters and pagination state into a stable href", () => {
    const href = adminManualQuarantineControlsHref(
      manualQuarantineBacklogQuery({
        activeViewId: "10000000-0000-4000-8000-000000000099",
        ageBucket: "over_thirty_days",
        clusterPage: 3,
        domains: ["one.example", "two.example"],
        evidenceFailures: ["missing_image"],
        groupBy: "domain",
        owners: ["operator@example.com"],
        page: 4,
        pageSize: 50,
        policyReasons: ["policy-block"],
        repairs: ["rehydrate"],
        search: "baseline image",
        snapshotAt: "2026-07-16T18:00:00.000Z",
        snapshotRevision: 17,
        asOfAt: "2026-07-16T18:02:00.000Z",
        sort: "priority",
        statuses: ["quarantined"],
      }),
    );
    const url = new URL(href, "https://awardping.example");

    expect(url.searchParams.getAll("mq_domain")).toEqual([
      "one.example",
      "two.example",
    ]);
    expect(url.searchParams.get("mq_group_by")).toBe("domain");
    expect(url.searchParams.get("mq_failure")).toBe("missing_image");
    expect(url.searchParams.get("mq_policy")).toBe("policy-block");
    expect(url.searchParams.get("mq_repair")).toBe("rehydrate");
    expect(url.searchParams.get("mq_owner")).toBe("operator@example.com");
    expect(url.searchParams.get("mq_status")).toBe("quarantined");
    expect(url.searchParams.get("mq_age")).toBe("over_thirty_days");
    expect(url.searchParams.get("mq_page")).toBe("4");
    expect(url.searchParams.get("mq_cluster_page")).toBe("3");
    expect(url.searchParams.get("mq_page_size")).toBe("50");
    expect(url.searchParams.get("mq_revision")).toBe("17");
    expect(url.searchParams.get("mq_as_of")).toBe(
      "2026-07-16T18:02:00.000Z",
    );
  });
});
