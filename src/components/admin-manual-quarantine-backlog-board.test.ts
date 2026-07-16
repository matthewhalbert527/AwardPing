import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AdminManualQuarantineBacklogBoard } from "@/components/admin-manual-quarantine-backlog-board";
import {
  manualQuarantineBacklog,
  manualQuarantineBacklogQuery,
} from "@/components/admin-manual-quarantine-backlog-test-fixtures";
import type {
  AdminManualQuarantineBacklogLoadResult,
  AdminManualQuarantineSavedViewsLoadResult,
} from "@/lib/admin-manual-quarantine-backlog";

vi.mock("@/components/admin-manual-quarantine-backlog-controls", () => ({
  AdminManualQuarantineBacklogControls: () =>
    createElement("div", { "data-testid": "backlog-controls" }, "Backlog controls"),
}));

vi.mock("@/components/admin-manual-quarantine-backlog-queue", () => ({
  AdminManualQuarantineBacklogQueue: () =>
    createElement("div", { "data-testid": "backlog-queue" }, "Backlog queue"),
}));

describe("AdminManualQuarantineBacklogBoard", () => {
  it("states exact totals and page ranges without treating capped rows as totals", () => {
    const html = renderBoard();

    expect(html).toContain("236 exact actionable cases");
    expect(html).toContain(
      "The total comes from the full registry query, not the number of rows on this page.",
    );
    expect(html).toContain("25 are on this page");
    expect(html).toContain(
      "Showing 26–50 of 236 exact filtered cases. Page 2 of 10.",
    );
    expect(html).toContain("Showing 1–1 of 11 exact groups.");
    expect(html).toContain("Group page 1 of 1");
  });

  it("defaults to full repair groups and exposes every repair dimension", () => {
    const html = renderBoard();

    expect(html).toContain("Full repair groups");
    expect(html).toContain("Source domain");
    expect(html).toContain("Evidence failure");
    expect(html).toContain("Policy reason");
    expect(html).toContain("Likely repair");
    expect(html).toContain(">200<p");
    expect(html).toContain("Needs an assignee");
    expect(html).toContain("2 weeks old");
  });

  it.each([
    { factLabel: "Source domain", groupBy: "domain" as const },
    {
      factLabel: "Evidence failure",
      groupBy: "evidence_failure" as const,
    },
    { factLabel: "Policy reason", groupBy: "policy_reason" as const },
    { factLabel: "Likely repair", groupBy: "likely_repair" as const },
  ])(
    "shows only the selected $groupBy fact when other cluster labels are arbitrary minimums",
    ({ factLabel, groupBy }) => {
      const values = {
        domain: "lexical-minimum-domain.example",
        evidence_failure: "Arbitrary minimum evidence failure",
        policy_reason: "Arbitrary minimum policy reason",
        likely_repair: "Arbitrary minimum likely repair",
      } as const;
      const base = manualQuarantineBacklog();
      const cluster = {
        ...base.clusters[0],
        evidenceFailureLabel: values.evidence_failure,
        label: values[groupBy],
        likelyRepairLabel: values.likely_repair,
        policyReasonLabel: values.policy_reason,
        sourceDomain: values.domain,
      };
      const html = renderBoard({
        backlog: manualQuarantineBacklog({
          clusters: [cluster],
          groupBy,
        }),
      });

      expect(html).toContain(`<dt>${factLabel}</dt>`);
      expect(html).toContain(values[groupBy]);
      for (const [dimension, value] of Object.entries(values)) {
        if (dimension !== groupBy) expect(html).not.toContain(value);
      }
    },
  );

  it("binds pagination to registry, revision, and a fixed age clock", () => {
    const html = renderBoard();

    expect(html).toContain(
      "tab=quarantine&amp;mq_snapshot=2026-07-16T17%3A58%3A00.000Z",
    );
    expect(html).toContain("mq_page=3");
    expect(html).toContain("mq_snapshot=2026-07-16T17%3A58%3A00.000Z");
    expect(html).toContain("mq_revision=17");
    expect(html).toContain("mq_as_of=2026-07-16T18%3A00%3A00.000Z");
  });

  it("does not present an unavailable queue as actionable", () => {
    const html = renderBoard({
      available: false,
      backlog: manualQuarantineBacklog({
        clusters: [],
        exactClusterTotal: 0,
        exactTotal: 0,
        items: [],
        unfilteredExactTotal: 0,
      }),
      loadErrors: ["The exact quarantine registry is unavailable."],
    });

    expect(html).toContain("Queue actions unavailable");
    expect(html).toContain("The exact quarantine registry is unavailable.");
    expect(html).toContain(
      "Exact quarantine counts are unavailable. No missing registry data is shown as zero.",
    );
    expect(html).not.toContain("Exact queue is current");
    expect(html).not.toContain("Filtered cases");
    expect(html).not.toContain("0 exact actionable cases");
    expect(html).not.toContain("Cases in this view");
    expect(html).not.toContain("Backlog controls");
    expect(html).not.toContain("Backlog queue");
  });
});

function renderBoard(
  resultOverrides: Partial<AdminManualQuarantineBacklogLoadResult> = {},
) {
  const result = {
    available: true,
    backlog: manualQuarantineBacklog(),
    loadErrors: [],
    ...resultOverrides,
  } satisfies AdminManualQuarantineBacklogLoadResult;
  const savedViews = {
    available: true,
    loadErrors: [],
    views: [],
  } satisfies AdminManualQuarantineSavedViewsLoadResult;
  return renderToStaticMarkup(
    createElement(AdminManualQuarantineBacklogBoard, {
      currentUserEmail: "operator@example.com",
      currentUserId: "30000000-0000-4000-8000-000000000003",
      query: manualQuarantineBacklogQuery(),
      result,
      savedViews,
    }),
  );
}
