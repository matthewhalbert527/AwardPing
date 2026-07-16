import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { AdminPageIssue } from "@/lib/admin-page-issues";
import type { AdminManualQuarantineItem } from "@/lib/admin-manual-quarantine";
import { awardMonitoringPolicyIdentity } from "@/lib/award-monitoring-policy";
import {
  buildOperatorActionInbox,
  formatOperatorActionAge,
  operatorActionInboxSummary,
  type OperatorVisualReviewFailureInput,
} from "@/lib/operator-action-inbox";
import type { MonitoringFeedbackPromotionCluster } from "@/lib/monitoring-feedback-promotion";

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

function quarantineItem(
  overrides: Partial<AdminManualQuarantineItem> = {},
): AdminManualQuarantineItem {
  return {
    id: "quarantine-1",
    quarantineKey: "public-page:award-1",
    caseKey: "public-page:award-1",
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
    retryCharge: "may_charge",
    title: "Example Award: public page needs review",
    reasonCode: "latest_reconciliation_failed",
    reason: "The latest reconciliation failed.",
    recommendedAction: "Repair this award, then rerun reconciliation and its page audit.",
    awardId: "award-1",
    sourceId: null,
    visualCandidateId: null,
    primarySourceTable: "shared_award_page_audits",
    primarySourceRecordId: "audit-1",
    evidenceRecordCount: 2,
    evidence: {
      award: {
        id: "award-1",
        name: "Example Award",
        slug: "example-award",
      },
    },
    evidenceHash: "a".repeat(64),
    policyId: "awardping-manual-quarantine",
    policyVersion: "1",
    policyHash: "b".repeat(64),
    firstObservedAt: "2026-07-15T14:00:00.000Z",
    lastObservedAt: "2026-07-15T16:00:00.000Z",
    quarantinedAt: "2026-07-15T16:05:00.000Z",
    updatedAt: "2026-07-15T16:05:00.000Z",
    ...overrides,
  };
}

function promotionCluster(
  overrides: Partial<MonitoringFeedbackPromotionCluster> = {},
): MonitoringFeedbackPromotionCluster {
  return {
    clusterKey: "a".repeat(64),
    evidenceSignature: "b".repeat(64),
    domainTemplate: "example.com/award|award_page",
    reasonCode: "content_churn",
    recurrenceCount: 4,
    sourceCount: 3,
    firstSeenAt: "2026-07-14T15:30:00.000Z",
    lastSeenAt: "2026-07-15T15:30:00.000Z",
    feedbackIds: ["feedback-1", "feedback-2", "feedback-3", "feedback-4"],
    requestedScopes: ["global"],
    sampleFeedback: [
      {
        feedback_id: "feedback-1",
        source_id: "source-1",
        source_title: "Official source",
        source_url: "https://example.com/award",
        event_summary: "A rotating testimonial was incorrectly treated as an update.",
        event_evidence: {
          section: "Testimonials",
          exact_before: "Previous quote",
          exact_after: "Replacement quote",
        },
      },
    ],
    workflowId: "workflow-1",
    workflowVersion: 1,
    stage: "triaged",
    activationStatus: "inactive",
    activationBlockedAt: null,
    resolutionReady: false,
    resolutionIdentityDrifted: false,
    resolutionIdentityDriftReason: null,
    resolutionWorkerRunId: null,
    resolutionAttestedAt: null,
    ownerEmail: "operator@example.com",
    draftPolicyRuleId: null,
    draftRuleActive: false,
    draftSummary: null,
    legitimateNegativeEventIds: [],
    blockingReport: null,
    latestRejectedAttempt: null,
    shadowReport: null,
    regressionReport: null,
    hashAttestation: null,
    canaryReport: null,
    retroactiveSweepReport: null,
    updatedAt: "2026-07-15T15:30:00.000Z",
    ...overrides,
  };
}

describe("operator action inbox", () => {
  it("turns each actionable quarantine case into one evidence-bound operator action", () => {
    const [item] = buildOperatorActionInbox({
      issues: [],
      manualQuarantineItems: [quarantineItem()],
      now,
    });

    expect(item).toMatchObject({
      fingerprint: "public-page:award-1",
      sourceKind: "manual_quarantine",
      state: "needs_operator",
      publicImpact: { level: "protected" },
      retry: { automatic: false },
      charge: { level: "may_charge" },
      award: { id: "award-1", slug: "example-award", name: "Example Award" },
      policy: {
        id: "awardping-manual-quarantine",
        version: "1",
        hash: "b".repeat(64),
      },
    });
    expect(item.context).toContain("2 linked evidence records");
    expect(item.evidence).toContainEqual({ label: "Evidence records", value: "2" });
    expect(item.evidence).toContainEqual({ label: "Evidence hash", value: "a".repeat(64) });
  });

  it("keeps historical limitations out of the repair inbox", () => {
    const items = buildOperatorActionInbox({
      issues: [],
      manualQuarantineItems: [
        quarantineItem({
          classification: "historical_limitation",
          category: "historical_localization",
          requiresAction: false,
          terminal: false,
          terminalFailureCount: 0,
          publicImpact: "none",
          retryCharge: "none",
        }),
      ],
      now,
    });

    expect(items).toEqual([]);
  });

  it("blocks a quarantine retry when an existing paid request is uncertain", () => {
    const [item] = buildOperatorActionInbox({
      issues: [],
      manualQuarantineItems: [
        quarantineItem({
          category: "visual_review",
          retryMode: "operator_before_retry",
          retryCharge: "unknown",
        }),
      ],
      now,
    });

    expect(item.state).toBe("blocked");
    expect(item.charge.level).toBe("unknown");
    expect(item.recommendedAction.label).toContain("paid attempt");
  });

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

  it("shows each clustered feedback pattern once with recurrence and a verified-workflow link", () => {
    const [item] = buildOperatorActionInbox({
      issues: [],
      promotionClusters: [promotionCluster()],
      now,
    });

    expect(item.sourceKind).toBe("monitoring_feedback");
    expect(item.state).toBe("needs_operator");
    expect(item.owner.label).toBe("Policy review");
    expect(item.retry.automatic).toBe(false);
    expect(item.charge.level).toBe("none");
    expect(item.context).toContain("4 occurrences across 3 sources");
    expect(item.recommendedAction.href).toBe(
      "/dashboard/admin/issues?tab=promotions#promotion-workflow-1",
    );
    expect(item.evidence).toContainEqual({
      label: "Recurrence",
      value: "4 occurrences",
    });
    expect(item.policy).toMatchObject({
      id: awardMonitoringPolicyIdentity.id,
      version: awardMonitoringPolicyIdentity.version,
      hash: awardMonitoringPolicyIdentity.hash,
    });
  });

  it("keeps the deployed policy identity separate from the proposed rule ID", () => {
    const [item] = buildOperatorActionInbox({
      issues: [],
      promotionClusters: [
        promotionCluster({
          stage: "rule_drafted",
          draftPolicyRuleId: "candidate_listing_noise",
        }),
      ],
      now,
    });

    expect(item.evidence).toContainEqual({
      label: "Draft rule",
      value: "candidate_listing_noise",
    });
    expect(item.policy).toMatchObject({
      id: awardMonitoringPolicyIdentity.id,
      version: awardMonitoringPolicyIdentity.version,
      hash: awardMonitoringPolicyIdentity.hash,
    });
    expect(item.policy.id).not.toBe("candidate_listing_noise");
  });

  it("blocks a clustered rule that would hide legitimate updates", () => {
    const [item] = buildOperatorActionInbox({
      issues: [],
      promotionClusters: [
        promotionCluster({
          stage: "rule_drafted",
          shadowReport: {
            status: "failed",
            legitimate_updates_suppressed: 2,
            legitimate_updates: [
              { event_id: "real-1", summary: "Deadline extended" },
              { event_id: "real-2", summary: "Award amount increased" },
            ],
          },
        }),
      ],
      now,
    });

    expect(item.state).toBe("blocked");
    expect(item.severity).toBe("high");
    expect(item.failureReason).toContain("2 legitimate updates");
    expect(item.retry.automatic).toBe(true);
    expect(item.retry.label).toContain("hourly verified-stage retry");
    expect(item.retry.detail).toContain("rule, deployment, or source repair");
  });

  it("surfaces the durable reason and safe fix for a rejected operator checkpoint", () => {
    const [item] = buildOperatorActionInbox({
      issues: [],
      promotionClusters: [
        promotionCluster({
          stage: "similar_feedback_clustered",
          latestRejectedAttempt: {
            status: "failed",
            requested_stage: "rule_drafted",
            summary: "The candidate belongs to another open cluster.",
            failure_reason: "candidate ownership conflict",
            conflicting_cluster_id: "workflow-two",
          },
        }),
      ],
      now,
    });

    expect(item).toMatchObject({
      state: "blocked",
      severity: "high",
      retry: { automatic: false },
      failureReason: "The candidate belongs to another open cluster.",
    });
    expect(item.recommendedAction.detail).toContain("Keep the candidate inactive");
    expect(item.evidence).toContainEqual({
      label: "Latest rejected stage",
      value: "Rule drafted",
    });
    expect(item.evidence).toContainEqual({
      label: "Latest rejected reason",
      value: "candidate ownership conflict",
    });
  });

  it("marks the regular 6 PM canary observation as automatic and potentially charged", () => {
    const [item] = buildOperatorActionInbox({
      issues: [],
      promotionClusters: [
        promotionCluster({
          stage: "app_worker_hashes_match",
          shadowReport: { status: "passed", legitimate_updates_suppressed: 0 },
          regressionReport: { status: "passed" },
          hashAttestation: { status: "passed" },
        }),
      ],
      now,
    });

    expect(item.state).toBe("auto_retrying");
    expect(item.retry.label).toContain("next scheduled 6 PM scan");
    expect(item.charge).toMatchObject({ level: "may_charge" });
  });

  it("routes a passed canary to the reviewed activation deployment", () => {
    const [item] = buildOperatorActionInbox({
      issues: [],
      promotionClusters: [
        promotionCluster({
          stage: "six_pm_canary",
          shadowReport: { status: "passed", legitimate_updates_suppressed: 0 },
          regressionReport: { status: "passed" },
          hashAttestation: { status: "passed" },
          canaryReport: { status: "passed" },
        }),
      ],
      now,
    });

    expect(item.state).toBe("needs_operator");
    expect(item.retry.automatic).toBe(false);
    expect(item.recommendedAction.detail).toContain("Activate the verified rule globally");
    expect(item.charge.level).toBe("none");
  });

  it("reports app activation without claiming worker parity or global verification", () => {
    const [item] = buildOperatorActionInbox({
      issues: [],
      promotionClusters: [
        promotionCluster({
          stage: "six_pm_canary",
          draftPolicyRuleId: "candidate_listing_noise",
          draftRuleActive: true,
          shadowReport: { status: "passed", legitimate_updates_suppressed: 0 },
          regressionReport: { status: "passed" },
          hashAttestation: { status: "passed" },
          canaryReport: { status: "passed" },
        }),
      ],
      now,
    });

    expect(item.publicImpact).toMatchObject({
      level: "unknown",
      label: "App activation detected; worker parity pending",
    });
    expect(item.state).toBe("auto_retrying");
    expect(item.retry.automatic).toBe(true);
    expect(item.publicImpact.detail).toContain("worker parity is not proven");
    expect(item.publicImpact.detail).not.toContain("verified active deployment");
    expect(item.recommendedAction.detail).toContain("App activation is detected");
    expect(item.recommendedAction.detail).not.toContain("Activate the verified rule globally");
  });

  it("creates a visible manual action when late feedback blocks activation", () => {
    const [item] = buildOperatorActionInbox({
      issues: [],
      promotionClusters: [
        promotionCluster({
          stage: "six_pm_canary",
          draftPolicyRuleId: "candidate_listing_noise",
          draftRuleActive: true,
          activationStatus: "blocked_late_evidence",
          activationBlockedAt: "2026-07-15T19:45:00.000Z",
          canaryReport: { status: "passed" },
        }),
      ],
      now,
    });

    expect(item.state).toBe("blocked");
    expect(item.severity).toBe("high");
    expect(item.retry.automatic).toBe(true);
    expect(item.retry.label).toContain("hourly rollback verification");
    expect(item.retry.detail).toContain("no-charge identity check");
    expect(item.failureReason).toContain("New matching feedback arrived after the canary");
    expect(item.recommendedAction.detail).toContain(
      "Deactivate the drafted rule if it is live",
    );
    expect(item.recommendedAction.label).toBe("Restore the inactive deployment");
    expect(item.publicImpact.level).toBe("unknown");
    expect(item.publicImpact.label).toContain("Unverified active rule");
    expect(item.publicImpact.detail).toContain("suppression");
    expect(item.evidence).toContainEqual({
      label: "Activation safety state",
      value: "Blocked late evidence",
    });
    expect(operatorActionInboxSummary([item])).toMatchObject({
      publicBlockers: 0,
      publicImpactUnknown: 1,
    });
  });

  it("keeps rollback-required promotion work high severity without a failed gate artifact", () => {
    const [item] = buildOperatorActionInbox({
      issues: [],
      promotionClusters: [
        promotionCluster({
          stage: "six_pm_canary",
          draftPolicyRuleId: "candidate_listing_noise",
          draftRuleActive: true,
          activationStatus: "rollback_required",
          activationBlockedAt: "2026-07-15T19:45:00.000Z",
          blockingReport: {
            status: "failed",
            summary:
              "The retroactive sweep mutated retained history, but its final guarded transition was rejected; rollback is required.",
            transition_failure_reason: "the guarded transition was rejected",
          },
          canaryReport: { status: "passed" },
        }),
      ],
      now,
    });

    expect(item).toMatchObject({
      severity: "high",
      state: "blocked",
      publicImpact: { level: "unknown" },
    });
    expect(item.failureReason).toContain("final guarded transition was rejected");
    expect(item.failureReason).not.toContain(
      "completed its bounded historical sweep",
    );
  });

  it("makes post-sweep deactivation a high blocked hourly rollback action", () => {
    const [item] = buildOperatorActionInbox({
      issues: [],
      promotionClusters: [
        promotionCluster({
          stage: "retroactive_sweep",
          draftPolicyRuleId: "candidate_listing_noise",
          draftRuleActive: false,
          activationStatus: "sweep_completed",
          shadowReport: { status: "passed", legitimate_updates_suppressed: 0 },
          regressionReport: { status: "passed" },
          hashAttestation: { status: "passed" },
          canaryReport: { status: "passed" },
          retroactiveSweepReport: { status: "completed" },
        }),
      ],
      now,
    });

    expect(item).toMatchObject({
      severity: "high",
      state: "blocked",
      publicImpact: {
        level: "blocked",
        label: "Post-sweep deactivation requires rollback repair",
      },
      retry: { automatic: true },
      charge: { level: "none" },
    });
    expect(item.failureReason).toContain("Do not resolve");
    expect(item.retry.label).toContain("hourly rollback/deactivation repair");
    expect(item.recommendedAction.detail).toContain(
      "next normal hourly, zero-charge worker run",
    );
    expect(item.recommendedAction.detail).not.toContain(
      "Review the sweep report, then resolve",
    );
  });

  it("moves a completed sweep from zero-charge retry to operator resolution only after attestation", () => {
    const pendingCluster = promotionCluster({
      stage: "retroactive_sweep",
      draftPolicyRuleId: "candidate_listing_noise",
      draftRuleActive: true,
      activationStatus: "sweep_completed",
      retroactiveSweepReport: { status: "completed" },
    });
    const readyCluster = promotionCluster({
      ...pendingCluster,
      resolutionReady: true,
      resolutionWorkerRunId: "70000000-0000-4000-8000-000000000007",
      resolutionAttestedAt: "2026-07-15T21:00:00.000Z",
    });

    const [pending] = buildOperatorActionInbox({
      issues: [],
      promotionClusters: [pendingCluster],
      now,
    });
    const [ready] = buildOperatorActionInbox({
      issues: [],
      promotionClusters: [readyCluster],
      now,
    });

    expect(pending).toMatchObject({
      state: "auto_retrying",
      retry: { automatic: true, label: "Yes — next normal hourly attestation" },
      charge: { level: "none" },
    });
    expect(pending.failureReason).toContain("Resolve stays locked");
    expect(ready).toMatchObject({
      state: "needs_operator",
      retry: { automatic: false },
      recommendedAction: { label: "Review and resolve the verified pattern" },
    });
    expect(ready.evidence).toContainEqual({
      label: "Resolution worker run",
      value: "70000000-0000-4000-8000-000000000007",
    });
  });

  it("classifies post-sweep identity drift as a manual unknown-impact rollback", () => {
    const [item] = buildOperatorActionInbox({
      issues: [],
      promotionClusters: [
        promotionCluster({
          stage: "retroactive_sweep",
          draftPolicyRuleId: "candidate_listing_noise",
          draftRuleActive: true,
          activationStatus: "sweep_completed",
          resolutionIdentityDrifted: true,
          resolutionIdentityDriftReason:
            "Post-sweep identity drift blocks resolution: matcher/verifier bundle does not match the immutable activated identity.",
          retroactiveSweepReport: { status: "completed" },
        }),
      ],
      now,
    });

    expect(item).toMatchObject({
      severity: "high",
      state: "blocked",
      publicImpact: {
        level: "unknown",
        label: "Post-sweep identity drift requires rollback",
      },
      retry: {
        automatic: false,
        label: "No — restore the inactive deployment",
      },
      recommendedAction: { label: "Restore the inactive deployment" },
    });
    expect(item.failureReason).toContain("matcher/verifier bundle");
    expect(item.retry.detail).toContain("cannot match the stale activated identity");
    expect(item.recommendedAction.detail).toContain(
      "restore the exact reviewed inactive app and worker identity",
    );
    expect(item.evidence).toContainEqual({
      label: "Final hourly attestation",
      value: "Blocked by post-sweep identity drift",
    });
    expect(item.evidence).toContainEqual({
      label: "Resolution identity",
      value:
        "Post-sweep identity drift blocks resolution: matcher/verifier bundle does not match the immutable activated identity.",
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
