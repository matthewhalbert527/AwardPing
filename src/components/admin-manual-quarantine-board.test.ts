import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AdminManualQuarantineBoard } from "@/components/admin-manual-quarantine-board";
import type { AdminManualQuarantineLoadResult } from "@/lib/admin-manual-quarantine";
import {
  defaultAdminManualQuarantineBacklogQuery,
  type AdminManualQuarantineBacklogLoadResult,
  type AdminManualQuarantineSavedViewsLoadResult,
} from "@/lib/admin-manual-quarantine-backlog";
import { formatCentralDateTime } from "@/lib/time-zone";

vi.mock("@/components/admin-manual-quarantine-backlog-board", () => ({
  AdminManualQuarantineBacklogBoard: () =>
    createElement("div", { "data-testid": "quarantine-backlog" }, "Exact grouped backlog"),
}));

describe("AdminManualQuarantineBoard", () => {
  it("explains the four completion measures and grouped case evidence plainly", () => {
    const html = renderToStaticMarkup(
      createElement(AdminManualQuarantineBoard, {
        ...boardProps(quarantineResult()),
      }),
    );

    expect(html).toContain("5. Manual Quarantine");
    expect(html).toContain("Last catch-up completion assessment");
    expect(html).toContain(">Automated work clear<");
    expect(html).toContain("Quarantined work remaining");
    expect(html).toContain(">295<");
    expect(html).toContain("Historical limitations");
    expect(html).toContain(">390<");
    expect(html).toContain("Terminal failures requiring action");
    expect(html).toContain(">277<");
    expect(html).toContain(
      "The last catch-up completion assessment reported automated work clear. The registry currently holds 295 quarantined review cases.",
    );
    expect(html).toContain(
      `Reported ${formatCentralDateTime("2026-07-15T21:00:00.000Z")}.`,
    );
    expect(html).toContain(
      `Registry synced ${formatCentralDateTime("2026-07-15T21:05:00.000Z")}`,
    );
    expect(html).toContain("511 linked evidence records are preserved.");
    expect(html).toContain("Public-page and baseline repair");
    expect(html).toContain("authoritative R2 recovery evidence");
    expect(html).toContain("452");
    expect(html).toContain("Visual review");
    expect(html).toContain("New document evidence");
    expect(html).toContain("Historical screenshot limits");
    expect(html).toContain("Exact grouped backlog");
  });

  it("says Not imported instead of displaying a false historical zero", () => {
    const result = quarantineResult();
    result.summary.historicalInventoryStatus = "not_imported";
    result.summary.historicalLimitations = null;
    result.summary.byCategory.historical_localization = {
      cases: 0,
      evidenceRecords: 0,
      terminalCases: 0,
      terminalFailures: 0,
      oldestObservedAt: null,
      unknownPublicImpactCases: 0,
    };

    const html = renderToStaticMarkup(
      createElement(AdminManualQuarantineBoard, boardProps(result)),
    );

    expect(html).toContain("Not imported");
    expect(html).toContain("does not report a false zero");
  });

  it("does not present unavailable registry data as a cleared queue", () => {
    const result = quarantineResult();
    result.registryAvailable = false;
    result.loadErrors = ["Manual Quarantine is not migrated yet."];
    result.summary.automatedWorkClear = null;
    result.summary.quarantinedWorkRemaining = 0;

    const html = renderToStaticMarkup(
      createElement(AdminManualQuarantineBoard, boardProps(result)),
    );

    expect(html).toContain("Registry unavailable");
    expect(html).toContain(
      "No missing registry data is being reported as zero.",
    );
    expect(html.match(/>Unavailable</g)).toHaveLength(4);
    expect(html).not.toContain(">Not reported<");
    expect(html).not.toContain(">Not imported<");
    expect(html).not.toContain("reported automated work clear");
    expect(html).not.toContain("Registry synced");
    expect(html).not.toContain(
      formatCentralDateTime(result.summary.completionReportedAt),
    );
  });

  it("shows the catch-up assessment timestamp separately from a newer registry sync", () => {
    const result = quarantineResult();
    result.summary.completionReportedAt = "2026-07-01T18:00:00.000Z";
    result.summary.lastSyncedAt = "2026-07-15T21:05:00.000Z";

    const html = renderToStaticMarkup(
      createElement(AdminManualQuarantineBoard, boardProps(result)),
    );

    expect(html).toContain(
      `Reported ${formatCentralDateTime(result.summary.completionReportedAt)}.`,
    );
    expect(html).toContain(
      `Registry synced ${formatCentralDateTime(result.summary.lastSyncedAt)}`,
    );
  });

  it("does not claim a catch-up assessment was reported without its timestamp", () => {
    const result = quarantineResult();
    result.summary.completionReportedAt = null;

    const html = renderToStaticMarkup(
      createElement(AdminManualQuarantineBoard, boardProps(result)),
    );

    expect(html).toContain(">Not reported<");
    expect(html).toContain("No catch-up completion assessment has been reported.");
    expect(html).not.toContain(">Automated work clear<");
  });
});

function boardProps(result: AdminManualQuarantineLoadResult) {
  return {
    backlogResult: {
      available: false,
      backlog: {} as AdminManualQuarantineBacklogLoadResult["backlog"],
      loadErrors: [],
    },
    currentUserEmail: "operator@example.com",
    currentUserId: "30000000-0000-4000-8000-000000000003",
    query: defaultAdminManualQuarantineBacklogQuery(),
    result,
    savedViewsResult: {
      available: true,
      loadErrors: [],
      views: [],
    } satisfies AdminManualQuarantineSavedViewsLoadResult,
  };
}

function quarantineResult(): AdminManualQuarantineLoadResult {
  return {
    registryAvailable: true,
    items: [],
    total: 295,
    loadErrors: [],
    summary: {
      automatedWorkClear: true,
      automatedBlockers: {},
      quarantinedWorkRemaining: 295,
      quarantineEvidenceRecords: 511,
      historicalLimitations: 390,
      historicalInventoryStatus: "complete",
      terminalFailuresRequiringAction: 277,
      byCategory: {
        public_page: {
          cases: 236,
          evidenceRecords: 452,
          terminalCases: 216,
          terminalFailures: 218,
          oldestObservedAt: "2026-07-01T00:00:00.000Z",
          unknownPublicImpactCases: 20,
        },
        visual_review: {
          cases: 57,
          evidenceRecords: 57,
          terminalCases: 57,
          terminalFailures: 57,
          oldestObservedAt: "2026-07-02T00:00:00.000Z",
          unknownPublicImpactCases: 0,
        },
        initial_document: {
          cases: 2,
          evidenceRecords: 2,
          terminalCases: 2,
          terminalFailures: 2,
          oldestObservedAt: "2026-07-16T00:00:00.000Z",
          unknownPublicImpactCases: 0,
        },
        historical_localization: {
          cases: 390,
          evidenceRecords: 390,
          terminalCases: 0,
          terminalFailures: 0,
          oldestObservedAt: "2025-01-01T00:00:00.000Z",
          unknownPublicImpactCases: 0,
        },
      },
      completionStatus: "automated_work_clear",
      sourceWorkerRunId: "worker-one",
      completionReportedAt: "2026-07-15T21:00:00.000Z",
      historicalInventoryReportedAt: "2026-07-15T05:09:29.867Z",
      historicalInventoryDigest: "a".repeat(64),
      lastSyncedAt: "2026-07-15T21:05:00.000Z",
    },
  };
}
