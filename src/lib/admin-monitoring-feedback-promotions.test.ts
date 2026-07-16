import { describe, expect, it, vi } from "vitest";
import type { createSupabaseAdminClient } from "@/lib/supabase/admin";

vi.mock("@/lib/monitoring-feedback-promotion-identity", () => ({
  currentMonitoringPromotionAppIdentity: () => ({
    revision: "test-app-revision",
    policy_hash: "test-full-hash",
    batch_policy_hash: "test-batch-hash",
    suppression_policy_hash: "test-suppression-hash",
    matcher_hash: "test-matcher-hash",
  }),
}));

import {
  loadAdminMonitoringFeedbackPromotionClusters,
  mapMonitoringFeedbackPromotionCluster,
} from "@/lib/admin-monitoring-feedback-promotions";

describe("admin verified promotion loader", () => {
  it("keeps a rejected shadow attempt separate from immutable accepted artifacts", () => {
    const cluster = mapMonitoringFeedbackPromotionCluster(
      row({
        current_stage: "rule_drafted",
        proposed_rule_id: "candidate_listing_noise",
        stage_artifacts: {
          rule_drafted: {
            rule_id: "candidate_listing_noise",
            draft_hash: "draft-hash",
            draft_summary: "Hide listing churn; preserve real deadlines.",
            legitimate_negative_event_ids: [
              "40000000-0000-4000-8000-000000000004",
            ],
            rule: { id: "candidate_listing_noise", active: false },
          },
        },
        legitimate_collision_count: 2,
        legitimate_collisions: [
          { event_id: "event-one", summary: "Deadline moved" },
          { event_id: "event-two", summary: "Award amount increased" },
        ],
        latest_attempt_stage: "historical_shadow_test",
        latest_attempt_accepted: false,
        latest_attempt_failure_reason:
          "The proposed rule would suppress legitimate historical updates.",
        latest_attempt_created_at: "2026-07-15T19:30:00.000Z",
        latest_attempt_evidence: {
          status: "failed",
          report_id: "shadow-one",
          total_history_checked: 120,
          proposed_rule_matches: 7,
          legitimate_updates_suppressed: 2,
        },
      }),
    );

    expect(cluster).toMatchObject({
      clusterKey: "a".repeat(64),
      recurrenceCount: 7,
      sourceCount: 3,
      workflowVersion: 3,
      stage: "rule_drafted",
      ownerEmail: null,
      feedbackIds: ["feedback-one", "feedback-two"],
      requestedScopes: ["global", "source"],
      updatedAt: "2026-07-15T19:30:00.000Z",
      draftPolicyRuleId: "candidate_listing_noise",
      draftSummary: "Hide listing churn; preserve real deadlines.",
      legitimateNegativeEventIds: [
        "40000000-0000-4000-8000-000000000004",
      ],
      latestRejectedAttempt: {
        status: "failed",
        requested_stage: "historical_shadow_test",
        report_id: "shadow-one",
        summary:
          "The proposed rule would suppress legitimate historical updates.",
        completed_at: "2026-07-15T19:30:00.000Z",
        total_history_checked: 120,
        proposed_rule_matches: 7,
        legitimate_updates_suppressed: 2,
      },
      shadowReport: null,
    });
    expect(cluster.latestRejectedAttempt?.legitimate_updates).toHaveLength(2);
  });

  it("preserves a worker exception summary, safe action, and DB failure reason", () => {
    const cluster = mapMonitoringFeedbackPromotionCluster(
      row({
        current_stage: "rule_drafted",
        latest_attempt_stage: "historical_shadow_test",
        latest_attempt_accepted: false,
        latest_attempt_failure_reason: "database timeout",
        latest_attempt_evidence: {
          status: "failed",
          summary: "History pagination failed after page 12.",
          safe_action: "Repair the history query and retry the hourly worker.",
        },
      }),
    );

    expect(cluster.latestRejectedAttempt).toMatchObject({
      status: "failed",
      requested_stage: "historical_shadow_test",
      summary: "History pagination failed after page 12.",
      safe_action: "Repair the history query and retry the hourly worker.",
      failure_reason: "database timeout",
    });
    expect(cluster.shadowReport).toBeNull();
  });

  it("preserves a rejected operator checkpoint after refresh", () => {
    const cluster = mapMonitoringFeedbackPromotionCluster(
      row({
        current_stage: "similar_feedback_clustered",
        latest_attempt_stage: "rule_drafted",
        latest_attempt_accepted: false,
        latest_attempt_failure_reason:
          "The candidate rule is already assigned to another open cluster.",
        latest_attempt_created_at: "2026-07-15T19:35:00.000Z",
        latest_attempt_evidence: {
          conflicting_cluster_id: "workflow-two",
        },
      }),
    );

    expect(cluster.latestRejectedAttempt).toMatchObject({
      status: "failed",
      requested_stage: "rule_drafted",
      completed_at: "2026-07-15T19:35:00.000Z",
      failure_reason:
        "The candidate rule is already assigned to another open cluster.",
      summary:
        "The candidate rule is already assigned to another open cluster.",
      conflicting_cluster_id: "workflow-two",
    });
    expect(cluster.regressionReport).toBeNull();
  });

  it("does not replace an accepted stage artifact with a later rejected attempt", () => {
    const cluster = mapMonitoringFeedbackPromotionCluster(
      row({
        current_stage: "historical_shadow_test",
        stage_artifacts: {
          historical_shadow_test: {
            status: "passed",
            report_id: "accepted-shadow",
            legitimate_updates_suppressed: 0,
          },
        },
        latest_attempt_stage: "regression_tests_pass",
        latest_attempt_accepted: false,
        latest_attempt_failure_reason: "A known real update fixture was hidden.",
        latest_attempt_evidence: { fixture_id: "real-deadline" },
      }),
    );

    expect(cluster.shadowReport).toMatchObject({
      status: "passed",
      report_id: "accepted-shadow",
    });
    expect(cluster.latestRejectedAttempt).toMatchObject({
      status: "failed",
      requested_stage: "regression_tests_pass",
      fixture_id: "real-deadline",
    });
    expect(cluster.regressionReport).toBeNull();
  });

  it("normalizes accepted hash, canary, and sweep artifacts", () => {
    const cluster = mapMonitoringFeedbackPromotionCluster(
      row({
        current_stage: "retroactive_sweep",
        stage_artifacts: {
          app_worker_hashes_match: {
            status: "passed",
            app_policy_hash: "full",
            worker_policy_hash: "full",
            app_batch_policy_hash: "batch",
            worker_batch_policy_hash: "batch",
            app_suppression_policy_hash: "suppress",
            worker_suppression_policy_hash: "suppress",
          },
          six_pm_canary: { passed: true, run_id: "canary-one" },
          retroactive_sweep: {
            status: "completed",
            error_count: 0,
            report_id: "sweep-one",
            cursor: { complete: true },
          },
        },
      }),
    );

    expect(cluster.hashAttestation).toMatchObject({
      status: "passed",
      app_policy_hash: "full",
      worker_policy_hash: "full",
      app_batch_policy_hash: "batch",
      worker_batch_policy_hash: "batch",
      app_suppression_policy_hash: "suppress",
      worker_suppression_policy_hash: "suppress",
    });
    expect(cluster.canaryReport).toMatchObject({
      status: "passed",
      report_id: "canary-one",
    });
    expect(cluster.retroactiveSweepReport).toMatchObject({
      status: "completed",
      report_id: "sweep-one",
    });
  });

  it("unlocks resolution only when the DB run and current app match immutable activation identity", () => {
    const appIdentity = {
      revision: "commit-a",
      policy_identity: "full@1",
      policy_version: "1",
      policy_hash: "full-hash",
      batch_policy_identity: "batch@1",
      batch_policy_version: "1",
      batch_policy_hash: "batch-hash",
      suppression_policy_identity: "suppression@1",
      suppression_policy_version: "1",
      suppression_policy_hash: "suppression-hash",
      matcher_identity: "matcher@1",
      matcher_version: "1",
      matcher_hash: "matcher-hash",
    };
    const durableRow = row({
      current_stage: "retroactive_sweep",
      activation_status: "sweep_completed",
      resolution_ready: true,
      resolution_worker_run_id: "70000000-0000-4000-8000-000000000007",
      resolution_attested_at: "2026-07-15T21:00:00.000Z",
      stage_artifacts: {
        retroactive_sweep: {
          activation_attestation: {
            app_revision: "commit-a",
            worker_revision: "commit-a",
            app_policy_hash: "full-hash",
            worker_policy_hash: "full-hash",
            app_batch_policy_hash: "batch-hash",
            worker_batch_policy_hash: "batch-hash",
            app_suppression_policy_hash: "suppression-hash",
            worker_suppression_policy_hash: "suppression-hash",
            app_matcher_digest: "matcher-hash",
            worker_matcher_digest: "matcher-hash",
          },
        },
      },
    });

    const ready = mapMonitoringFeedbackPromotionCluster(
      durableRow,
      appIdentity,
    );
    const drifted = mapMonitoringFeedbackPromotionCluster(durableRow, {
      ...appIdentity,
      revision: "commit-b",
    });

    expect(ready).toMatchObject({
      resolutionReady: true,
      resolutionIdentityDrifted: false,
      resolutionIdentityDriftReason: null,
      resolutionWorkerRunId: "70000000-0000-4000-8000-000000000007",
      resolutionAttestedAt: "2026-07-15T21:00:00.000Z",
    });
    expect(drifted).toMatchObject({
      resolutionReady: false,
      resolutionIdentityDrifted: true,
      resolutionWorkerRunId: null,
      resolutionAttestedAt: null,
    });
    expect(drifted.resolutionIdentityDriftReason).toContain("app revision");
    expect(drifted.resolutionIdentityDriftReason).toContain(
      "Restore the exact inactive deployment",
    );
  });

  it("prefers the latest durable rollback blocker over a rejected completed-sweep report", () => {
    const cluster = mapMonitoringFeedbackPromotionCluster(
      row({
        current_stage: "six_pm_canary",
        activation_status: "rollback_required",
        latest_attempt_stage: "retroactive_sweep",
        latest_attempt_accepted: false,
        latest_attempt_failure_reason: "the guarded transition was rejected",
        latest_attempt_evidence: {
          status: "completed",
          summary: "The verified rule completed its bounded historical sweep.",
        },
        latest_blocking_transition_kind: "activation_rollback_required",
        latest_blocking_transition_created_at: "2026-07-15T21:01:00.000Z",
        latest_blocking_transition_evidence: {
          status: "failed",
          summary:
            "The retroactive sweep mutated retained history, but its final guarded transition was rejected; rollback is required.",
          transition_failure_reason: "the guarded transition was rejected",
          completed_sweep_digest: "a".repeat(64),
        },
      }),
    );

    expect(cluster.blockingReport).toMatchObject({
      status: "failed",
      transition_kind: "activation_rollback_required",
      completed_at: "2026-07-15T21:01:00.000Z",
      summary: expect.stringContaining("rollback is required"),
      completed_sweep_digest: "a".repeat(64),
    });
  });

  it("returns a clean missing-migration message", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: {
        code: "PGRST202",
        message: "Could not find list_monitoring_feedback_promotion_clusters",
      },
    });
    const admin = { rpc } as unknown as ReturnType<typeof createSupabaseAdminClient>;

    const result = await loadAdminMonitoringFeedbackPromotionClusters(admin);

    expect(result).toEqual({
      clusters: [],
      total: 0,
      loadErrors: [
        "Verified feedback promotion is not migrated for this deployment yet. Immediate event suppression is still active.",
      ],
    });
  });

  it("reports response truncation while returning mapped clusters", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [row({ total_clusters: 3 })],
      error: null,
    });
    const admin = { rpc } as unknown as ReturnType<typeof createSupabaseAdminClient>;

    const result = await loadAdminMonitoringFeedbackPromotionClusters(admin, {
      limit: 1,
    });

    expect(rpc).toHaveBeenCalledWith(
      "list_monitoring_feedback_promotion_clusters",
      { p_limit: 1, p_include_resolved: false },
    );
    expect(result.clusters).toHaveLength(1);
    expect(result.total).toBe(3);
    expect(result.loadErrors[0]).toContain("2 additional verified promotion clusters");
  });
});

function row(overrides: Record<string, unknown> = {}) {
  return {
    cluster_id: "90000000-0000-4000-8000-000000000009",
    cluster_key: "a".repeat(64),
    evidence_signature: "b".repeat(64),
    domain_template: "example.org/awards/:id|award",
    reason_code: "content_churn" as const,
    current_stage: "triaged" as const,
    proposed_rule_id: null,
    evidence_revision: 3,
    activation_status: "inactive",
    activation_blocked_at: null,
    stage_artifacts: {},
    recurrence_count: 7,
    source_count: 3,
    sample_evidence: [
      {
        feedback_id: "feedback-one",
        requested_scope: "global",
        actor_email: "first@awardping.test",
      },
      {
        feedback_id: "feedback-two",
        requested_scope: "source",
        actor_email: "second@awardping.test",
      },
    ],
    legitimate_collision_count: 0,
    legitimate_collisions: [],
    latest_attempt_stage: null,
    latest_attempt_accepted: null,
    latest_attempt_failure_reason: null,
    latest_attempt_created_at: null,
    latest_attempt_evidence: null,
    latest_blocking_transition_kind: null,
    latest_blocking_transition_created_at: null,
    latest_blocking_transition_evidence: null,
    created_at: "2026-07-15T18:00:00.000Z",
    updated_at: "2026-07-15T19:00:00.000Z",
    resolved_at: null,
    resolution_ready: false,
    resolution_worker_run_id: null,
    resolution_attested_at: null,
    total_clusters: 1,
    ...overrides,
  } as Parameters<typeof mapMonitoringFeedbackPromotionCluster>[0];
}
