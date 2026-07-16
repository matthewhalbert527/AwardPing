import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/admin-verified-promotion-control", () => ({
  AdminVerifiedPromotionControl: () => null,
}));

import { AdminVerifiedPromotionBoard } from "@/components/admin-verified-promotion-board";
import type { MonitoringFeedbackPromotionCluster } from "@/lib/monitoring-feedback-promotion";

describe("AdminVerifiedPromotionBoard", () => {
  it("shows a clustered pattern, progress, legitimate collisions, and verification evidence", () => {
    const cluster = promotionCluster({
      recurrenceCount: 12,
      sourceCount: 4,
      stage: "historical_shadow_test",
      shadowReport: {
        status: "passed",
        report_id: "shadow-report-one",
        total_history_checked: 500,
        proposed_rule_matches: 14,
        legitimate_updates_suppressed: 2,
        legitimate_updates: [
          {
            event_id: "event-one",
            summary: "The application deadline moved to April 15.",
            source_url: "https://example.org/award/deadline",
            reason: "Applicant-facing deadline change",
          },
          "The award amount increased.",
        ],
      },
      hashAttestation: {
        status: "passed",
        app_policy_hash: "app-policy-hash",
        worker_policy_hash: "worker-policy-hash",
      },
    });

    const html = renderToStaticMarkup(
      createElement(AdminVerifiedPromotionBoard, {
        candidateRuleIds: ["routine_listing_timestamp_churn"],
        clusters: [cluster],
      }),
    );

    expect(html).toContain("4. Verified Promotions");
    expect(html).toContain("1 pattern is moving through verification");
    expect(html).toContain("12 occurrences");
    expect(html).toContain("4 sources");
    expect(html).toContain("Step 4 of 9");
    expect(html).toContain("Historical shadow test");
    expect(html).toContain("2 legitimate updates would also be hidden");
    expect(html).toContain("The application deadline moved to April 15.");
    expect(html).toContain('href="https://example.org/award/deadline"');
    expect(html).toContain("The award amount increased.");
    expect(html).toContain('aria-current="step"');
    expect(html.match(/<li/g) || []).toHaveLength(11);
    expect(html).toContain("Evidence signature");
    expect(html).toContain("app-policy-hash");
    expect(html).toContain("worker-policy-hash");
    expect(html).toContain("shadow-report-one");
    expect(html).toContain("Narrow the draft rule and rerun verification");
  });

  it("states when every global activation gate has passed", () => {
    const cluster = promotionCluster({
      stage: "six_pm_canary",
      shadowReport: { status: "passed", legitimate_updates_suppressed: 0 },
      regressionReport: { status: "passed" },
      hashAttestation: { status: "passed" },
      canaryReport: { status: "passed" },
    });

    const html = renderToStaticMarkup(
      createElement(AdminVerifiedPromotionBoard, {
        candidateRuleIds: ["routine_listing_timestamp_churn"],
        clusters: [cluster],
      }),
    );

    expect(html).toContain("Step 7 of 9");
    expect(html).toContain("Global activation gates passed");
    expect(html).toContain("6 PM canary are verified");
    expect(html).toContain("Change only this candidate to active");
  });

  it("moves an already-active canary cluster into automatic lane verification", () => {
    const cluster = promotionCluster({
      stage: "six_pm_canary",
      draftRuleActive: true,
      activationStatus: "armed",
      shadowReport: { status: "passed", legitimate_updates_suppressed: 0 },
      regressionReport: { status: "passed" },
      hashAttestation: { status: "passed" },
      canaryReport: { status: "passed" },
    });

    const html = renderToStaticMarkup(
      createElement(AdminVerifiedPromotionBoard, {
        candidateRuleIds: ["routine_listing_timestamp_churn"],
        clusters: [cluster],
      }),
    );

    expect(html).toContain("0 need a person");
    expect(html).toContain("1 is in automatic verification");
    expect(html).toContain("App activation detected; worker parity pending");
    expect(html).toContain("Active in app; worker parity pending");
    expect(html).toContain(
      "activated worker identity has not been re-attested yet",
    );
    expect(html).not.toContain("Rule active globally");
  });

  it("renders a plain empty state", () => {
    const html = renderToStaticMarkup(
      createElement(AdminVerifiedPromotionBoard, {
        candidateRuleIds: [],
        clusters: [],
      }),
    );

    expect(html).toContain("No feedback patterns are awaiting promotion");
    expect(html).toContain("No rule promotion is waiting");
    expect(html).toContain("Global activation is gated");
  });

  it("shows concrete failed evidence and a plain-language safe fix", () => {
    const cluster = promotionCluster({
      stage: "app_worker_hashes_match",
      regressionReport: {
        status: "failed",
        failure_count: 1,
        fixture_failures: [
          {
            fixture_id: "legitimate-deadline-change",
            expected: "visible",
            matched: true,
          },
        ],
      },
      canaryReport: {
        status: "failed",
        expected_candidate_count: 2,
        bound_candidate_count: 2,
        candidate_status_counts: { published: 1, rejected: 1 },
        candidate_terminal_failures: [
          {
            candidate_id: "candidate-two",
            status: "failed",
            reason: "Visual review returned no publishable event.",
          },
        ],
      },
      retroactiveSweepReport: {
        status: "failed",
        error_count: 1,
        sweep_errors: [
          { event_id: "event-three", message: "The source row was locked." },
        ],
      },
    });

    const html = renderToStaticMarkup(
      createElement(AdminVerifiedPromotionBoard, {
        candidateRuleIds: ["routine_listing_timestamp_churn"],
        clusters: [cluster],
      }),
    );

    expect(html).toContain("What failed");
    expect(html).toContain("Fixture legitimate-deadline-change");
    expect(html).toContain("A legitimate update matched the proposed suppression rule.");
    expect(html).toContain("Candidate candidate-two");
    expect(html).toContain("Visual review returned no publishable event.");
    expect(html).toContain("1 published · 1 rejected");
    expect(html).toContain("Update event-three");
    expect(html).toContain("The source row was locked.");
    expect(html).toContain("Safe fix");
    expect(html).toContain("wait for the next normal 6 PM cohort");
    expect(html).toContain("reverse or safely re-attribute candidate-attributable suppressions");
  });

  it("shows a rejected operator checkpoint as separate current-revision evidence", () => {
    const cluster = promotionCluster({
      stage: "similar_feedback_clustered",
      latestRejectedAttempt: {
        status: "failed",
        requested_stage: "rule_drafted",
        summary: "The candidate belongs to another open cluster.",
        failure_reason: "candidate ownership conflict",
        conflicting_cluster_id: "workflow-two",
      },
    });

    const html = renderToStaticMarkup(
      createElement(AdminVerifiedPromotionBoard, {
        candidateRuleIds: ["routine_listing_timestamp_churn"],
        clusters: [cluster],
      }),
    );

    expect(html).toContain("The latest verification attempt did not pass");
    expect(html).toContain("The candidate belongs to another open cluster.");
    expect(html).toContain("Latest rejected attempt");
    expect(html).toContain("Attempted stage");
    expect(html).toContain("Rule drafted");
    expect(html).toContain("Failure reason");
    expect(html).toContain("candidate ownership conflict");
    expect(html).toContain("Complete rejected-attempt evidence");
    expect(html).toContain("workflow-two");
    expect(html).toContain("Keep the candidate inactive");
  });

  it("keeps a rejected final checkpoint visible even when activation gates passed", () => {
    const cluster = promotionCluster({
      stage: "retroactive_sweep",
      draftRuleActive: true,
      activationStatus: "sweep_completed",
      resolutionReady: true,
      shadowReport: { status: "passed", legitimate_updates_suppressed: 0 },
      regressionReport: { status: "passed" },
      hashAttestation: { status: "passed" },
      canaryReport: { status: "passed" },
      retroactiveSweepReport: { status: "completed" },
      latestRejectedAttempt: {
        status: "failed",
        requested_stage: "resolved",
        summary: "The workflow changed while resolution was being recorded.",
      },
    });

    const html = renderToStaticMarkup(
      createElement(AdminVerifiedPromotionBoard, {
        candidateRuleIds: ["routine_listing_timestamp_churn"],
        clusters: [cluster],
      }),
    );

    expect(html).toContain("The latest verification attempt did not pass");
    expect(html).toContain(
      "The workflow changed while resolution was being recorded.",
    );
    expect(html).not.toContain("Global activation gates passed");
  });

  it("makes post-canary evidence drift impossible to miss", () => {
    const cluster = promotionCluster({
      stage: "six_pm_canary",
      draftRuleActive: true,
      activationStatus: "blocked_late_evidence",
      activationBlockedAt: "2026-07-15T19:45:00.000Z",
      canaryReport: { status: "passed" },
    });

    const html = renderToStaticMarkup(
      createElement(AdminVerifiedPromotionBoard, {
        candidateRuleIds: ["routine_listing_timestamp_churn"],
        clusters: [cluster],
      }),
    );

    expect(html).toContain("New evidence blocked activation");
    expect(html).toContain("Blocked late evidence");
    expect(html).toContain("Verification invalidated");
    expect(html).toContain("New evidence invalidated the canary revision");
    expect(html).toContain("New matching feedback arrived after the canary");
    expect(html).not.toContain("Global activation gates passed");
  });

  it("shows the same rollback safety state after an activation or sweep failure", () => {
    const cluster = promotionCluster({
      stage: "six_pm_canary",
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
    });

    const html = renderToStaticMarkup(
      createElement(AdminVerifiedPromotionBoard, {
        candidateRuleIds: ["routine_listing_timestamp_churn"],
        clusters: [cluster],
      }),
    );

    expect(html).toContain("Rollback required");
    expect(html).toContain("Verification invalidated");
    expect(html).toContain("Current activation / rollback blocker");
    expect(html).toContain("final guarded transition was rejected");
    expect(html).not.toContain(
      "The verified rule completed its bounded historical sweep.",
    );
  });

  it("shows post-sweep deactivation as blocked rollback repair, not resolution", () => {
    const cluster = promotionCluster({
      stage: "retroactive_sweep",
      draftRuleActive: false,
      activationStatus: "sweep_completed",
      shadowReport: { status: "passed", legitimate_updates_suppressed: 0 },
      regressionReport: { status: "passed" },
      hashAttestation: { status: "passed" },
      canaryReport: { status: "passed" },
      retroactiveSweepReport: { status: "completed" },
    });

    const html = renderToStaticMarkup(
      createElement(AdminVerifiedPromotionBoard, {
        candidateRuleIds: ["routine_listing_timestamp_churn"],
        clusters: [cluster],
      }),
    );

    expect(html).toContain("Post-sweep rule deactivated");
    expect(html).toContain("Verification invalidated");
    expect(html).toContain("Post-sweep deactivation requires rollback repair");
    expect(html).toContain("feedback-promotion lane rollback/deactivation repair");
    expect(html).not.toContain("Global activation gates passed");
    expect(html).not.toContain("Review the sweep report, then resolve");
  });

  it("counts a completed sweep as automatic until its durable lane attestation is ready", () => {
    const pending = promotionCluster({
      stage: "retroactive_sweep",
      draftRuleActive: true,
      activationStatus: "sweep_completed",
      ownerEmail: null,
    });
    const ready = promotionCluster({
      ...pending,
      resolutionReady: true,
      resolutionWorkerRunId: "70000000-0000-4000-8000-000000000007",
      resolutionAttestedAt: "2026-07-15T21:00:00.000Z",
    });

    const pendingHtml = renderToStaticMarkup(
      createElement(AdminVerifiedPromotionBoard, {
        candidateRuleIds: ["routine_listing_timestamp_churn"],
        clusters: [pending],
      }),
    );
    const readyHtml = renderToStaticMarkup(
      createElement(AdminVerifiedPromotionBoard, {
        candidateRuleIds: ["routine_listing_timestamp_churn"],
        clusters: [ready],
      }),
    );

    expect(pendingHtml).toContain("0 need a person");
    expect(pendingHtml).toContain("1 is in automatic verification");
    expect(pendingHtml).toContain("Feedback-promotion attestation pending");
    expect(pendingHtml).toContain("Policy review");
    expect(readyHtml).toContain("1 needs a person");
    expect(readyHtml).toContain("0 are in automatic verification");
    expect(readyHtml).toContain("Ready to resolve");
    expect(readyHtml).toContain("70000000-0000-4000-8000-000000000007");
  });

  it("shows post-sweep identity drift as rollback, not a pending attestation", () => {
    const cluster = promotionCluster({
      stage: "retroactive_sweep",
      draftRuleActive: true,
      activationStatus: "sweep_completed",
      resolutionIdentityDrifted: true,
      resolutionIdentityDriftReason:
        "Post-sweep identity drift blocks resolution: matcher/verifier bundle changed.",
      retroactiveSweepReport: { status: "completed" },
    });

    const html = renderToStaticMarkup(
      createElement(AdminVerifiedPromotionBoard, {
        candidateRuleIds: ["routine_listing_timestamp_churn"],
        clusters: [cluster],
      }),
    );

    expect(html).toContain("1 needs a person");
    expect(html).toContain("Post-sweep identity drift");
    expect(html).toContain("Post-sweep identity drift requires rollback");
    expect(html).toContain("matcher/verifier bundle changed");
    expect(html).toContain("Blocked by post-sweep identity drift");
    expect(html).toContain(
      "restore the exact reviewed inactive app and worker identity",
    );
    expect(html).not.toContain("Feedback-promotion attestation pending");
  });
});

function promotionCluster(
  overrides: Partial<MonitoringFeedbackPromotionCluster> = {},
): MonitoringFeedbackPromotionCluster {
  return {
    clusterKey: "evidence-one|example.org/award/:segment|content_churn",
    evidenceSignature: "evidence-one",
    domainTemplate: "example.org/award/:segment",
    reasonCode: "content_churn",
    recurrenceCount: 2,
    sourceCount: 1,
    firstSeenAt: "2026-07-14T18:00:00.000Z",
    lastSeenAt: "2026-07-15T18:00:00.000Z",
    feedbackIds: ["feedback-one", "feedback-two"],
    requestedScopes: ["global"],
    sampleFeedback: { exact_before: "8 days ago", exact_after: "9 days ago" },
    workflowId: "workflow-one",
    workflowVersion: 3,
    stage: "triaged",
    activationStatus: "inactive",
    activationBlockedAt: null,
    resolutionReady: false,
    resolutionIdentityDrifted: false,
    resolutionIdentityDriftReason: null,
    resolutionWorkerRunId: null,
    resolutionAttestedAt: null,
    ownerEmail: "operator@awardping.test",
    draftPolicyRuleId: "routine_listing_timestamp_churn",
    draftRuleActive: false,
    draftSummary: "Hide relative-age label churn while preserving applicant-facing dates.",
    legitimateNegativeEventIds: ["40000000-0000-4000-8000-000000000004"],
    blockingReport: null,
    latestRejectedAttempt: null,
    shadowReport: null,
    regressionReport: null,
    hashAttestation: null,
    canaryReport: null,
    retroactiveSweepReport: null,
    updatedAt: "2026-07-15T19:00:00.000Z",
    ...overrides,
  };
}
