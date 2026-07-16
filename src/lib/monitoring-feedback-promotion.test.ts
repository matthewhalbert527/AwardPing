import { describe, expect, it } from "vitest";
import {
  monitoringFeedbackPromotionCanActivateGlobally,
  monitoringFeedbackPromotionFailedGate,
  monitoringFeedbackPromotionProgress,
  monitoringFeedbackPromotionSafeAction,
  nextMonitoringFeedbackPromotionStage,
  type MonitoringFeedbackPromotionCluster,
} from "@/lib/monitoring-feedback-promotion";

describe("monitoring feedback promotion workflow", () => {
  it("keeps the requested stages in strict order", () => {
    expect(nextMonitoringFeedbackPromotionStage(null)).toBe("triaged");
    expect(nextMonitoringFeedbackPromotionStage("historical_shadow_test")).toBe(
      "regression_tests_pass",
    );
    expect(nextMonitoringFeedbackPromotionStage("retroactive_sweep")).toBe(
      "resolved",
    );
    expect(nextMonitoringFeedbackPromotionStage("resolved")).toBeNull();
  });

  it("reports simple progress through all nine stages", () => {
    expect(monitoringFeedbackPromotionProgress(null)).toEqual({
      completed: 0,
      total: 9,
      percent: 0,
    });
    expect(monitoringFeedbackPromotionProgress("six_pm_canary")).toEqual({
      completed: 7,
      total: 9,
      percent: 78,
    });
    expect(monitoringFeedbackPromotionProgress("resolved").percent).toBe(100);
  });

  it("blocks activation when shadow testing finds legitimate updates", () => {
    const cluster = promotionCluster({
      stage: "six_pm_canary",
      shadowReport: {
        status: "passed",
        legitimate_updates_suppressed: 2,
      },
      regressionReport: { status: "passed" },
      hashAttestation: { status: "passed" },
      canaryReport: { status: "passed" },
    });

    expect(monitoringFeedbackPromotionCanActivateGlobally(cluster)).toBe(false);
    expect(monitoringFeedbackPromotionSafeAction(cluster)).toContain(
      "hide 2 legitimate updates",
    );
  });

  it("permits global activation only after every pre-activation gate passes", () => {
    const verified = promotionCluster({
      stage: "six_pm_canary",
      shadowReport: {
        status: "passed",
        legitimate_updates_suppressed: 0,
      },
      regressionReport: { status: "passed" },
      hashAttestation: { status: "passed" },
      canaryReport: { status: "passed" },
    });

    expect(monitoringFeedbackPromotionCanActivateGlobally(verified)).toBe(true);
    expect(
      monitoringFeedbackPromotionCanActivateGlobally({
        ...verified,
        canaryReport: { status: "failed" },
      }),
    ).toBe(false);
  });

  it("blocks a previously passed canary when later feedback changes its evidence", () => {
    const cluster = promotionCluster({
      stage: "six_pm_canary",
      activationStatus: "blocked_late_evidence",
      activationBlockedAt: "2026-07-15T19:45:00.000Z",
      shadowReport: { status: "passed", legitimate_updates_suppressed: 0 },
      regressionReport: { status: "passed" },
      hashAttestation: { status: "passed" },
      canaryReport: { status: "passed" },
    });

    expect(monitoringFeedbackPromotionCanActivateGlobally(cluster)).toBe(false);
    expect(monitoringFeedbackPromotionSafeAction(cluster)).toContain(
      "Deactivate the drafted rule",
    );
  });

  it("keeps a failed activated deployment locked through rollback audit", () => {
    const cluster = promotionCluster({
      stage: "six_pm_canary",
      activationStatus: "rollback_required",
      draftRuleActive: true,
      shadowReport: { status: "passed", legitimate_updates_suppressed: 0 },
      regressionReport: { status: "passed" },
      hashAttestation: { status: "passed" },
      canaryReport: { status: "passed" },
    });

    expect(monitoringFeedbackPromotionCanActivateGlobally(cluster)).toBe(false);
    expect(monitoringFeedbackPromotionSafeAction(cluster)).toContain(
      "Restore the exact inactive app and worker revision",
    );
  });

  it("keeps rollback instructions ahead of a concrete post-activation failure summary", () => {
    const cluster = promotionCluster({
      stage: "six_pm_canary",
      activationStatus: "rollback_required",
      draftRuleActive: true,
      retroactiveSweepReport: {
        status: "failed",
        summary: "The database connection closed after one sweep page.",
      },
    });

    expect(monitoringFeedbackPromotionFailedGate(cluster)).toBe(
      "The database connection closed after one sweep page.",
    );
    expect(monitoringFeedbackPromotionSafeAction(cluster)).toContain(
      "Restore the exact inactive app and worker revision",
    );
  });

  it("shows the durable worker failure and its concrete safe action", () => {
    const cluster = promotionCluster({
      stage: "rule_drafted",
      shadowReport: {
        status: "failed",
        summary: "History pagination failed after page 12.",
        failure_reason: "database timeout",
        safe_action: "Repair the history query and retry the feedback-promotion lane.",
      },
    });

    expect(monitoringFeedbackPromotionSafeAction(cluster)).toBe(
      "Repair the history query and retry the feedback-promotion lane.",
    );
    expect(monitoringFeedbackPromotionFailedGate(cluster)).toBe(
      "History pagination failed after page 12.",
    );
  });

  it("reports a rejected operator checkpoint without mutating accepted artifacts", () => {
    const cluster = promotionCluster({
      stage: "similar_feedback_clustered",
      latestRejectedAttempt: {
        status: "failed",
        requested_stage: "rule_drafted",
        summary: "The candidate belongs to another open cluster.",
        failure_reason: "candidate ownership conflict",
      },
    });

    expect(monitoringFeedbackPromotionFailedGate(cluster)).toBe(
      "The candidate belongs to another open cluster.",
    );
    expect(monitoringFeedbackPromotionSafeAction(cluster)).toContain(
      "Keep the candidate inactive",
    );
    expect(cluster.shadowReport).toBeNull();
  });

  it("blocks final resolution and requires rollback when activation identity drifts", () => {
    const cluster = promotionCluster({
      stage: "retroactive_sweep",
      activationStatus: "sweep_completed",
      draftRuleActive: true,
      resolutionIdentityDrifted: true,
      resolutionIdentityDriftReason:
        "Post-sweep identity drift blocks resolution: matcher/verifier bundle does not match.",
    });

    expect(monitoringFeedbackPromotionFailedGate(cluster)).toContain(
      "matcher/verifier bundle",
    );
    expect(monitoringFeedbackPromotionSafeAction(cluster)).toContain(
      "restore the exact reviewed inactive app and worker identity",
    );
    expect(monitoringFeedbackPromotionCanActivateGlobally(cluster)).toBe(false);
  });

  it("treats a post-sweep inactive draft as rollback repair, never resolution", () => {
    const cluster = promotionCluster({
      stage: "retroactive_sweep",
      activationStatus: "sweep_completed",
      draftRuleActive: false,
      shadowReport: { status: "passed", legitimate_updates_suppressed: 0 },
      regressionReport: { status: "passed" },
      hashAttestation: { status: "passed" },
      canaryReport: { status: "passed" },
      retroactiveSweepReport: { status: "completed" },
    });

    expect(monitoringFeedbackPromotionCanActivateGlobally(cluster)).toBe(false);
    expect(monitoringFeedbackPromotionFailedGate(cluster)).toContain(
      "Do not resolve",
    );
    expect(monitoringFeedbackPromotionSafeAction(cluster)).toContain(
      "next zero-charge feedback-promotion lane run",
    );
    expect(monitoringFeedbackPromotionSafeAction(cluster)).not.toContain(
      "Review the sweep report, then resolve",
    );
  });

  it("keeps final resolution locked until the durable lane attestation is ready", () => {
    const pending = promotionCluster({
      stage: "retroactive_sweep",
      activationStatus: "sweep_completed",
      draftRuleActive: true,
    });
    const ready = promotionCluster({ ...pending, resolutionReady: true });

    expect(monitoringFeedbackPromotionSafeAction(pending)).toContain(
      "Resolve stays locked",
    );
    expect(monitoringFeedbackPromotionSafeAction(ready)).toContain(
      "then resolve the verified cluster",
    );
  });
});

function promotionCluster(
  overrides: Partial<MonitoringFeedbackPromotionCluster> = {},
): MonitoringFeedbackPromotionCluster {
  return {
    clusterKey: "cluster-one",
    evidenceSignature: "evidence-one",
    domainTemplate: "example.org/award/:segment",
    reasonCode: "content_churn",
    recurrenceCount: 2,
    sourceCount: 1,
    firstSeenAt: "2026-07-14T18:00:00.000Z",
    lastSeenAt: "2026-07-15T18:00:00.000Z",
    feedbackIds: ["feedback-one", "feedback-two"],
    requestedScopes: ["global"],
    sampleFeedback: {},
    workflowId: "workflow-one",
    workflowVersion: 1,
    stage: "triaged",
    activationStatus: "inactive",
    activationBlockedAt: null,
    resolutionReady: false,
    resolutionIdentityDrifted: false,
    resolutionIdentityDriftReason: null,
    resolutionWorkerRunId: null,
    resolutionAttestedAt: null,
    ownerEmail: "operator@awardping.test",
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
    updatedAt: "2026-07-15T18:00:00.000Z",
    ...overrides,
  };
}
