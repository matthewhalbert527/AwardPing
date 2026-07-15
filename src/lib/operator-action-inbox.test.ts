import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { AdminPageIssue } from "@/lib/admin-page-issues";
import {
  buildOperatorActionInbox,
  formatOperatorActionAge,
  type OperatorMonitoringFeedbackInput,
  type OperatorVisualReviewFailureInput,
} from "@/lib/operator-action-inbox";

const now = new Date("2026-07-15T18:00:00.000Z");

function issue(overrides: Partial<AdminPageIssue> = {}): AdminPageIssue {
  return {
    key: "issue-1",
    category: "source_check_failed",
    area: "Source checks",
    severity: "medium",
    label: "Source check failed",
    awardId: "award-1",
    awardSlug: "example-award",
    awardName: "Example Award",
    sourceId: "source-1",
    sourceTitle: "Official source",
    sourceUrl: "https://example.com/award",
    message: "The source check failed.",
    currentValue: null,
    recommendedAction: "Review the source.",
    relatedWorkerRunId: "run-1",
    checkedAt: "2026-07-15T16:00:00.000Z",
    failures: 1,
    ...overrides,
  };
}

function visualFailure(
  overrides: Partial<OperatorVisualReviewFailureInput> = {},
): OperatorVisualReviewFailureInput {
  return {
    id: "candidate-1",
    awardId: "award-1",
    sourceId: "source-1",
    sourceTitle: "Official source",
    sourceUrl: "https://example.com/award",
    candidateSignature: "signature-1",
    rejectionReason: "model_request_failed",
    batchName: "batches/visual-1",
    model: "gemini-batch-model",
    estimatedCostUsd: 0.0012,
    workerMetadata: { failure_retry_count: 0 },
    updatedAt: "2026-07-15T16:00:00.000Z",
    ...overrides,
  };
}

function pendingFeedback(
  overrides: Partial<OperatorMonitoringFeedbackInput> = {},
): OperatorMonitoringFeedbackInput {
  return {
    id: "feedback-1",
    eventId: "event-1",
    sourceId: "source-1",
    awardId: "award-1",
    eventSummary: "A rotating testimonial was incorrectly treated as an update.",
    eventSourceUrl: "https://example.com/award",
    eventSourceTitle: "Official source",
    eventSourcePageType: "award_page",
    eventDetectedAt: "2026-07-15T15:00:00.000Z",
    eventEvidence: {
      section: "Testimonials",
      exact_before: "Previous quote",
      exact_after: "Replacement quote",
    },
    reasonCode: "content_churn",
    note: "Suppress rotating testimonials globally.",
    requestedScope: "global",
    policyRuleId: "rotating-testimonial-noise",
    policyVersion: "monitoring-policy-2026-07-12",
    actorEmail: "operator@example.com",
    createdAt: "2026-07-15T15:30:00.000Z",
    ...overrides,
  };
}

describe("operator action inbox", () => {
  it("excludes retired baseline and source-completion categories", () => {
    const retiredCategories = [
      "award_structure_scan_failed",
      "source_missing_cycle_relevance",
      "source_missing_evidence",
      "unclear_open_source",
      "unreviewed_open_source",
    ];

    const items = buildOperatorActionInbox({
      issues: retiredCategories.map((category, index) =>
        issue({ key: `retired-${index}`, category }),
      ),
      now,
    });

    expect(items).toEqual([]);
  });

  it("lets transient source-check failures retry at the next 6 PM scan without paid AI", () => {
    const [item] = buildOperatorActionInbox({
      issues: [
        issue({
          message: "The browser timed out while rendering the official page.",
          currentValue: "timeout",
        }),
      ],
      now,
    });

    expect(item.state).toBe("auto_retrying");
    expect(item.owner.label).toBe("AwardPing");
    expect(item.retry).toMatchObject({ automatic: true });
    expect(item.retry.label).toContain("next 6 PM scan");
    expect(item.charge.level).toBe("none");
    expect(item.charge.detail).toContain("does not create a Gemini Batch job");
  });

  it.each(["404 Not Found", "403 blocked by security challenge"])(
    "requires a source decision for an access or identity failure: %s",
    (message) => {
      const [item] = buildOperatorActionInbox({
        issues: [issue({ message })],
        now,
      });

      expect(item.state).toBe("blocked");
      expect(item.owner.label).toBe("Source review");
      expect(item.retry.automatic).toBe(false);
      expect(item.charge.level).toBe("none");
    },
  );

  it("automatically releases stale reconciliation processing after 45 minutes at no charge", () => {
    const [item] = buildOperatorActionInbox({
      issues: [
        issue({
          category: "award_reconciliation_failed",
          area: "Award reconciliation",
          currentValue: "processing",
          sourceId: null,
          sourceTitle: "",
          sourceUrl: null,
        }),
      ],
      now,
    });

    expect(item.state).toBe("auto_retrying");
    expect(item.retry).toMatchObject({ automatic: true });
    expect(item.retry.label).toContain("after 45 minutes");
    expect(item.charge.level).toBe("none");
    expect(item.publicImpact.level).toBe("blocked");
  });

  it("requires a manual rerun for a failed reconciliation and preserves the no-charge contract", () => {
    const [item] = buildOperatorActionInbox({
      issues: [
        issue({
          category: "award_reconciliation_failed",
          area: "Award reconciliation",
          currentValue: "failed",
          message: "Reconciliation failed after validation.",
          sourceId: null,
          sourceTitle: "",
          sourceUrl: null,
        }),
      ],
      now,
    });

    expect(item.state).toBe("needs_operator");
    expect(item.owner.label).toBe("Content review");
    expect(item.retry.automatic).toBe(false);
    expect(item.charge.level).toBe("none");
  });

  it("marks page-audit findings as publication blockers with a possible Gemini charge", () => {
    const [item] = buildOperatorActionInbox({
      issues: [
        issue({
          category: "deadline_conflict",
          area: "Page audit",
          severity: "high",
          message: "The published deadline conflicts with official evidence.",
        }),
      ],
      now,
    });

    expect(item.publicImpact.level).toBe("blocked");
    expect(item.publicImpact.label).toContain("Public page update blocked");
    expect(item.retry.automatic).toBe(false);
    expect(item.charge.level).toBe("may_charge");
    expect(item.charge.label).toContain("Gemini Batch");
  });

  it("sends source-intake failures to an operator and discloses a possible Gemini charge", () => {
    const [item] = buildOperatorActionInbox({
      issues: [
        issue({
          category: "source_intake_failed",
          area: "Source intake",
          message: "Submitted page could not complete intake.",
        }),
      ],
      now,
    });

    expect(item.state).toBe("needs_operator");
    expect(item.owner.label).toBe("Source intake");
    expect(item.charge.level).toBe("may_charge");
    expect(item.recommendedAction).toMatchObject({
      label: "Open Source Intake",
      href: "/dashboard/admin/source-intake",
    });
  });

  it("turns a missing 6 PM shard into one manual no-AI-charge repair", () => {
    const [item] = buildOperatorActionInbox({
      issues: [],
      nightlyReportedAt: "2026-07-15T01:00:00.000Z",
      nightlyFailureGroups: [
        {
          code: "missing_shard",
          label: "Scheduled shard did not report",
          severity: "critical",
          count: 1,
          sourceCount: 0,
          retryMode: "repair_then_restart_shard",
          repairCode: "inspect_task_then_start_missing_shard",
          solution: "Repair the task, then start only the missing shard.",
        },
      ],
      now,
    });

    expect(item.sourceKind).toBe("nightly_scan");
    expect(item.state).toBe("needs_operator");
    expect(item.retry.label).toContain("restart one shard");
    expect(item.charge.level).toBe("none");
    expect(item.recommendedAction.detail).toContain("only the missing shard");
  });

  it("keeps a system-level 6 PM transient failure visible while it waits for the next scan", () => {
    const [item] = buildOperatorActionInbox({
      issues: [],
      nightlyFailureGroups: [
        {
          code: "pipeline_timeout",
          label: "Capture coordinator timed out",
          severity: "warning",
          count: 1,
          sourceCount: 0,
          retryMode: "automatic_next_scan",
          repairCode: "backoff_then_retry",
          solution: "Allow the scheduled retry with backoff.",
        },
      ],
      now,
    });

    expect(item.state).toBe("auto_retrying");
    expect(item.owner.label).toBe("AwardPing");
    expect(item.retry.automatic).toBe(true);
    expect(item.charge.level).toBe("none");
  });

  it("reports a generic provider worker retry charge as unknown", () => {
    const [item] = buildOperatorActionInbox({
      issues: [
        issue({
          category: "worker_page_error",
          area: "Worker error",
          message: "External API request failed after the handoff.",
        }),
      ],
      now,
    });

    expect(item.retry.automatic).toBe(false);
    expect(item.charge.level).toBe("unknown");
    expect(item.charge.label).toContain("do not retry blindly");
  });

  describe("visual-review recovery", () => {
    it("automatically retries an ordinary failure as a new paid Gemini Batch", () => {
      const [item] = buildOperatorActionInbox({
        issues: [],
        visualReviewFailures: [visualFailure()],
        now,
      });

      expect(item.state).toBe("auto_retrying");
      expect(item.retry.automatic).toBe(true);
      expect(item.retry.label).toContain("attempt 1 of 3");
      expect(item.charge.level).toBe("will_charge");
      expect(item.charge.label).toContain("Gemini Batch");
    });

    it("recovers a missing response from the existing Batch without another charge", () => {
      const [item] = buildOperatorActionInbox({
        issues: [],
        visualReviewFailures: [
          visualFailure({
            rejectionReason: "missing_batch_response",
            workerMetadata: { failure_retry_count: 2 },
          }),
        ],
        now,
      });

      expect(item.state).toBe("auto_retrying");
      expect(item.retry.automatic).toBe(true);
      expect(item.retry.label).toContain("recover existing result");
      expect(item.charge.level).toBe("none");
      expect(item.charge.detail).toContain("reuses the existing Gemini Batch");
    });

    it("blocks an ambiguous external Batch and reports the charge as unknown", () => {
      const [item] = buildOperatorActionInbox({
        issues: [],
        visualReviewFailures: [
          visualFailure({
            rejectionReason: "manual_recovery_required_possible_external_batch_created",
          }),
        ],
        now,
      });

      expect(item.state).toBe("blocked");
      expect(item.retry.automatic).toBe(false);
      expect(item.charge.level).toBe("unknown");
      expect(item.recommendedAction.detail).toContain("Never use a generic retry");
    });

    it("stops automatic retries once three paid attempts have failed", () => {
      const [item] = buildOperatorActionInbox({
        issues: [],
        visualReviewFailures: [
          visualFailure({ workerMetadata: { failure_retry_count: 3 } }),
        ],
        now,
      });

      expect(item.state).toBe("needs_operator");
      expect(item.retry.automatic).toBe(false);
      expect(item.retry.label).toContain("retry limit reached");
      expect(item.charge.level).toBe("will_charge");
    });
  });

  it("keeps pending monitoring feedback manual, free, and bound to its recorded policy version", () => {
    const [item] = buildOperatorActionInbox({
      issues: [],
      pendingFeedback: [pendingFeedback()],
      now,
    });

    expect(item.sourceKind).toBe("monitoring_feedback");
    expect(item.state).toBe("needs_operator");
    expect(item.owner.label).toBe("Policy review");
    expect(item.retry.automatic).toBe(false);
    expect(item.charge.level).toBe("none");
    expect(item.policy).toMatchObject({
      id: "rotating-testimonial-noise",
      version: "monitoring-policy-2026-07-12",
    });
    expect(item.evidence).toContainEqual({
      label: "Submitted by",
      value: "operator@example.com",
    });
  });

  it("requires manual digest recovery and discloses a possible Resend charge", () => {
    const [item] = buildOperatorActionInbox({
      issues: [],
      digestDeliveryFailures: [
        {
          id: "delivery-1",
          deliveryType: "digest",
          digestKey: "digest-2026-07-15",
          recipient: "person@example.com",
          error: "Resend rejected the recipient.",
          createdAt: "2026-07-15T17:00:00.000Z",
        },
      ],
      now,
    });

    expect(item.sourceKind).toBe("digest_delivery");
    expect(item.state).toBe("needs_operator");
    expect(item.retry.automatic).toBe(false);
    expect(item.charge.level).toBe("may_charge");
    expect(item.charge.label).toContain("Resend");
    expect(item.context).not.toContain("person@");
  });

  it("creates one urgent load-error action with all loader evidence", () => {
    const items = buildOperatorActionInbox({
      issues: [],
      loadErrors: ["visual queue unavailable", "digest query failed"],
      now,
    });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "inbox-load-error",
      sourceKind: "inbox_load",
      severity: "high",
      state: "blocked",
      publicImpact: { level: "unknown" },
      retry: { automatic: true },
      charge: { level: "none" },
    });
    expect(items[0].evidence).toEqual([
      { label: "Load error 1", value: "visual queue unavailable" },
      { label: "Load error 2", value: "digest query failed" },
    ]);
  });

  it("sorts blocked work first and collapses duplicate source-policy issues", () => {
    const items = buildOperatorActionInbox({
      issues: [
        issue({
          key: "transient",
          message: "Temporary network timeout",
          checkedAt: "2026-07-15T12:00:00.000Z",
        }),
        issue({
          key: "source-policy-low",
          category: "source_quality_rejected_but_monitoring_enabled",
          severity: "low",
          sourceId: "source-duplicate",
          checkedAt: "2026-07-15T10:00:00.000Z",
        }),
        issue({
          key: "source-policy-high",
          category: "source_quality_rejected_but_monitoring_enabled",
          severity: "high",
          sourceId: "source-duplicate",
          checkedAt: "2026-07-15T17:00:00.000Z",
        }),
        issue({
          key: "page-blocker",
          category: "deadline_conflict",
          area: "Page audit",
          severity: "high",
        }),
      ],
      loadErrors: ["one loader failed"],
      now,
    });

    expect(items.map((item) => item.id)).toEqual([
      "inbox-load-error",
      "page-blocker",
      "source-policy-high",
      "transient",
    ]);
    expect(items.filter((item) => item.fingerprint.includes("source-policy:"))).toHaveLength(1);
  });
});

describe("formatOperatorActionAge", () => {
  it.each([
    [null, "Age unavailable"],
    ["not-a-date", "Age unavailable"],
    ["2026-07-15T18:00:00.000Z", "Just now"],
    ["2026-07-15T17:35:00.000Z", "25m old"],
    ["2026-07-15T13:00:00.000Z", "5h old"],
    ["2026-07-12T18:00:00.000Z", "3d old"],
    ["2026-06-17T18:00:00.000Z", "4w old"],
    ["2026-04-01T18:00:00.000Z", "3mo old"],
  ])("formats %s as %s", (value, expected) => {
    expect(formatOperatorActionAge(value, now)).toBe(expected);
  });

  it("does not show a future timestamp as a negative age", () => {
    expect(formatOperatorActionAge("2026-07-16T18:00:00.000Z", now)).toBe("Just now");
  });
});
