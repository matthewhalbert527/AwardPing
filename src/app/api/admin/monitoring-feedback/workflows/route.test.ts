import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  isSiteAdminEmail: vi.fn(),
  hasSupabaseConfig: vi.fn(),
  hasSupabaseAdminConfig: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
  rpc: vi.fn(),
  candidateActive: false,
  candidatePersistent: true,
  candidateDefinition: {
    id: "candidate_listing_noise",
    label: "Candidate listing noise",
    alert_blocking: true,
    persistent: true,
    aliases: ["candidate_listing_noise"],
    scopes: ["visual_snapshot"],
    prompt_scopes: ["visual_review_batch"],
    prompt: "Reject listing noise while preserving applicant-facing facts.",
    promotion_test_mode: "deterministic",
    matcher_digest: "c".repeat(64),
  },
}));

vi.mock("@/lib/auth", () => ({
  getCurrentUser: mocks.getCurrentUser,
  isSiteAdminEmail: mocks.isSiteAdminEmail,
}));
vi.mock("@/lib/config", () => ({
  hasSupabaseConfig: mocks.hasSupabaseConfig,
  hasSupabaseAdminConfig: mocks.hasSupabaseAdminConfig,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: mocks.createSupabaseAdminClient,
}));
vi.mock("@/lib/award-monitoring-policy", () => ({
  awardMonitoringPolicyIdentity: {
    id: "policy@current",
    version: "policy-4.memory-2",
    hash: "full-current-hash",
    policyVersion: 4,
    decisionMemoryVersion: 2,
  },
  isCandidateMonitoringPolicyFlag: (value: string) =>
    !mocks.candidateActive &&
    (value === "candidate_listing_noise" || value === "candidate-listing-noise"),
  isGloballyActiveMonitoringPolicyRule: (value: string) =>
    value === "already_global" ||
    value === "already-global" ||
    (mocks.candidateActive &&
      mocks.candidatePersistent &&
      (value === "candidate_listing_noise" || value === "candidate-listing-noise")),
  reviewableMonitoringPolicyFlagIdForAlias: (value: string) =>
    value === "candidate_listing_noise" || value === "candidate-listing-noise"
      ? "candidate_listing_noise"
      : value === "already_global" || value === "already-global"
        ? "already_global"
        : null,
  monitoringPolicyFlagIdForAlias: (value: string) => {
    if (value === "already_global" || value === "already-global") return "already_global";
    return mocks.candidateActive &&
      (value === "candidate_listing_noise" || value === "candidate-listing-noise")
      ? "candidate_listing_noise"
      : null;
  },
  monitoringPolicyRuleDefinitionForReview: (value: string) =>
    value === "candidate_listing_noise" || value === "candidate-listing-noise"
      ? mocks.candidateDefinition
      : value === "already_global" || value === "already-global"
        ? {
            id: "already_global",
            label: "Already global",
            alert_blocking: true,
            persistent: true,
            aliases: ["already_global"],
            scopes: [],
            prompt_scopes: ["visual_review_batch"],
            prompt: "Already active.",
            promotion_test_mode: "unsupported",
          }
        : null,
}));
vi.mock("@/lib/monitoring-feedback-promotion-identity", () => ({
  currentMonitoringPromotionAppIdentity: () => ({
    revision: "app-revision",
    policy_identity: "policy@current",
    policy_version: "policy-4.memory-2",
    policy_hash: "full-current-hash",
    batch_policy_identity: "batch@current",
    batch_policy_version: "batch-1",
    batch_policy_hash: "batch-current-hash",
    suppression_policy_identity: "suppression@current",
    suppression_policy_version: "suppression-1",
    suppression_policy_hash: "suppression-current-hash",
    matcher_identity: "matcher@current",
    matcher_version: "source-bundle-sha256-v1",
    matcher_hash: "matcher-current-hash",
  }),
}));

import { POST, buildMonitoringFeedbackRuleDraft } from "./route";

const requestId = "60000000-0000-4000-8000-000000000006";
const actorId = "80000000-0000-4000-8000-000000000008";
const clusterId = "90000000-0000-4000-8000-000000000009";
const clusterKey = "a".repeat(64);
const legitimateNegativeEventId = "40000000-0000-4000-8000-000000000004";
const secondLegitimateNegativeEventId = "50000000-0000-4000-8000-000000000005";
const resolutionWorkerRunId = "70000000-0000-4000-8000-000000000007";
const sweepCompletedAt = "2026-07-15T20:00:00.000000Z";
const attestationFinishedAt = "2026-07-15T21:00:00.123456Z";

describe("verified monitoring feedback workflow route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.candidateActive = false;
    mocks.candidatePersistent = true;
    mocks.hasSupabaseConfig.mockReturnValue(true);
    mocks.hasSupabaseAdminConfig.mockReturnValue(true);
    mocks.getCurrentUser.mockResolvedValue({
      id: actorId,
      email: "admin@awardping.test",
    });
    mocks.isSiteAdminEmail.mockReturnValue(true);
    mocks.createSupabaseAdminClient.mockReturnValue({ rpc: mocks.rpc });
  });

  it.each([null, "not an origin"])(
    "fails closed before authentication for an invalid Origin (%s)",
    async (origin) => {
      const response = await POST(workflowRequest(confirmBody(), origin));

      expect(response.status).toBe(403);
      expect(mocks.getCurrentUser).not.toHaveBeenCalled();
      expect(mocks.rpc).not.toHaveBeenCalled();
    },
  );

  it("requires an authenticated site admin before using the service role", async () => {
    mocks.isSiteAdminEmail.mockReturnValue(false);

    const response = await POST(workflowRequest(confirmBody()));

    expect(response.status).toBe(403);
    expect(mocks.createSupabaseAdminClient).not.toHaveBeenCalled();
  });

  it("confirms only the exact durable evidence, template, and reason cluster", async () => {
    mockListAndAdvance(clusterRow({ current_stage: "triaged" }));

    const response = await POST(workflowRequest(confirmBody()));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      ok: true,
      clusterId,
      currentStage: "similar_feedback_clustered",
      recurrenceCount: 7,
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(
      1,
      "get_monitoring_feedback_promotion_cluster",
      { p_cluster_id: clusterId },
    );
    expect(mocks.rpc).toHaveBeenNthCalledWith(
      2,
      "advance_monitoring_feedback_promotion_cluster",
      {
        p_request_id: requestId,
        p_cluster_id: clusterId,
        p_expected_evidence_revision: 1,
        p_to_stage: "similar_feedback_clustered",
        p_actor_user_id: actorId,
        p_actor_email: "admin@awardping.test",
        p_evidence: {
          cluster_reviewed: true,
          recurrence_count: 7,
          source_count: 3,
          evidence_signature: "b".repeat(64),
          domain_template: "example.org/awards/:id|award",
          reason_code: "content_churn",
        },
      },
    );
  });

  it("drafts only an implemented inactive config candidate and hashes the exact entry", async () => {
    mockListAndAdvance(
      clusterRow({ current_stage: "similar_feedback_clustered" }),
    );

    const response = await POST(
      workflowRequest({
        requestId,
        workflowId: clusterId,
        expectedVersion: 2,
        action: "draft_rule",
        policyRuleId: "candidate-listing-noise",
        draftSummary:
          "Hide routine listing churn; preserve applicant-facing deadlines.",
        legitimateNegativeEventIds: [
          secondLegitimateNegativeEventId,
          legitimateNegativeEventId,
        ],
      }),
    );

    expect(response.status).toBe(200);
    const advanceArgs = mocks.rpc.mock.calls[1]?.[1];
    expect(advanceArgs).toMatchObject({
      p_to_stage: "rule_drafted",
      p_expected_evidence_revision: 2,
      p_policy_rule_id: "candidate_listing_noise",
      p_policy_identity: "policy@current",
      p_policy_version: "policy-4.memory-2",
      p_policy_hash: "full-current-hash",
      p_policy_config_version: 4,
      p_decision_memory_version: 2,
      p_note: "Hide routine listing churn; preserve applicant-facing deadlines.",
      p_evidence: {
        rule_id: "candidate_listing_noise",
        rule: mocks.candidateDefinition,
        candidate_active: false,
        draft_summary:
          "Hide routine listing churn; preserve applicant-facing deadlines.",
        legitimate_negative_event_ids: [
          legitimateNegativeEventId,
          secondLegitimateNegativeEventId,
        ],
      },
    });
    expect(advanceArgs.p_evidence.rule).not.toHaveProperty("summary");
    expect(advanceArgs.p_evidence.draft_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(advanceArgs.p_evidence.draft_hash).toBe(
      buildMonitoringFeedbackRuleDraft("candidate_listing_noise")?.hash,
    );
  });

  it("does not let an already-global rule enter pre-activation verification", async () => {
    const response = await POST(
      workflowRequest({
        requestId,
        workflowId: clusterId,
        expectedVersion: 2,
        action: "draft_rule",
        policyRuleId: "already_global",
        draftSummary: "This must not bypass the canary.",
        legitimateNegativeEventIds: [legitimateNegativeEventId],
      }),
    );

    expect(response.status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("rejects unimplemented free-form draft IDs", async () => {
    const response = await POST(
      workflowRequest({
        requestId,
        workflowId: clusterId,
        expectedVersion: 2,
        action: "draft_rule",
        policyRuleId: "invented_rule",
        draftSummary: "A made-up rule cannot be shadow tested.",
        legitimateNegativeEventIds: [legitimateNegativeEventId],
      }),
    );

    expect(response.status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("requires an independently chosen real-update regression fixture", async () => {
    const response = await POST(
      workflowRequest({
        requestId,
        workflowId: clusterId,
        expectedVersion: 2,
        action: "draft_rule",
        policyRuleId: "candidate_listing_noise",
        draftSummary: "A boundary without a known real update is not verified.",
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("operator-confirmed real update"),
    });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("explains exclusive ownership when another open cluster already uses the candidate", async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: [clusterRow({ current_stage: "similar_feedback_clustered" })],
        error: null,
      })
      .mockResolvedValueOnce({
        data: null,
        error: {
          code: "23505",
          message:
            'duplicate key value violates unique constraint "monitoring_feedback_promotion_clusters_unresolved_rule_idx"',
        },
      });

    const response = await POST(
      workflowRequest({
        requestId,
        workflowId: clusterId,
        expectedVersion: 2,
        action: "draft_rule",
        policyRuleId: "candidate_listing_noise",
        draftSummary: "This candidate cannot own two activation workflows.",
        legitimateNegativeEventIds: [legitimateNegativeEventId],
      }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("another open verified-promotion cluster"),
    });
  });

  it("resolves only the same immutable rule after it is active", async () => {
    mocks.candidateActive = true;
    mockResolveAndAdvance();

    const response = await POST(
      workflowRequest({
        requestId,
        workflowId: clusterId,
        expectedVersion: 8,
        action: "resolve",
        policyRuleId: "candidate-listing-noise",
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.rpc).toHaveBeenNthCalledWith(
      2,
      "find_monitoring_feedback_resolution_worker_run",
      {
        p_cluster_id: clusterId,
        p_expected_evidence_revision: 8,
        p_not_before: sweepCompletedAt,
        p_worker_revision: "app-revision",
        p_worker_policy_hash: "full-current-hash",
        p_worker_batch_policy_hash: "batch-current-hash",
        p_worker_suppression_policy_hash: "suppression-current-hash",
        p_worker_matcher_digest: "matcher-current-hash",
      },
    );
    expect(mocks.rpc).toHaveBeenNthCalledWith(
      3,
      "advance_monitoring_feedback_promotion_cluster",
      expect.objectContaining({
        p_to_stage: "resolved",
        p_expected_evidence_revision: 8,
        p_policy_rule_id: "candidate_listing_noise",
        p_policy_identity: "policy@current",
        p_policy_hash: "full-current-hash",
        p_evidence: {
          confirmed: true,
          cluster_id: clusterId,
          evidence_revision: 8,
          completed_at: attestationFinishedAt,
          app_revision: "app-revision",
          app_policy_hash: "full-current-hash",
          app_batch_policy_hash: "batch-current-hash",
          app_suppression_policy_hash: "suppression-current-hash",
          app_matcher_digest: "matcher-current-hash",
          worker_run_ids: [resolutionWorkerRunId],
          worker_revision: "app-revision",
          worker_policy_hash: "full-current-hash",
          worker_batch_policy_hash: "batch-current-hash",
          worker_suppression_policy_hash: "suppression-current-hash",
          worker_matcher_digest: "matcher-current-hash",
        },
      }),
    );
  });

  it("canonicalizes a PostgREST offset timestamp without losing microseconds", async () => {
    mocks.candidateActive = true;
    mocks.rpc
      .mockResolvedValueOnce({ data: [resolutionClusterRow()], error: null })
      .mockResolvedValueOnce({
        data: [
          resolutionWorkerRun({
            finished_at: "2026-07-15T22:30:00.123456+01:30",
          }),
        ],
        error: null,
      })
      .mockResolvedValueOnce({ data: [advanceRow()], error: null });

    const response = await POST(
      workflowRequest({
        requestId,
        workflowId: clusterId,
        expectedVersion: 8,
        action: "resolve",
        policyRuleId: "candidate-listing-noise",
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.rpc).toHaveBeenNthCalledWith(
      3,
      "advance_monitoring_feedback_promotion_cluster",
      expect.objectContaining({
        p_evidence: expect.objectContaining({
          completed_at: attestationFinishedAt,
        }),
      }),
    );
  });

  it.each([
    ["malformed", "not-a-timestamp"],
    ["equal to the sweep boundary", sweepCompletedAt],
    ["older than the sweep boundary", "2026-07-15T19:59:59.999999+00:00"],
  ])("rejects a %s resolution attestation timestamp", async (_case, finishedAt) => {
    mocks.candidateActive = true;
    mocks.rpc
      .mockResolvedValueOnce({ data: [resolutionClusterRow()], error: null })
      .mockResolvedValueOnce({
        data: [resolutionWorkerRun({ finished_at: finishedAt })],
        error: null,
      });

    const response = await POST(
      workflowRequest({
        requestId,
        workflowId: clusterId,
        expectedVersion: 8,
        action: "resolve",
        policyRuleId: "candidate-listing-noise",
      }),
    );

    expect(response.status).toBe(409);
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
  });

  it("waits clearly when no feedback-promotion lane post-sweep attestation exists", async () => {
    mocks.candidateActive = true;
    mocks.rpc
      .mockResolvedValueOnce({ data: [resolutionClusterRow()], error: null })
      .mockResolvedValueOnce({ data: [], error: null });

    const response = await POST(
      workflowRequest({
        requestId,
        workflowId: clusterId,
        expectedVersion: 8,
        action: "resolve",
        policyRuleId: "candidate-listing-noise",
      }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("zero-charge matching feedback-promotion lane attestation"),
    });
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
  });

  it("reuses identical immutable run evidence after a lost response", async () => {
    mocks.candidateActive = true;
    mocks.rpc
      .mockResolvedValueOnce({ data: [resolutionClusterRow()], error: null })
      .mockResolvedValueOnce({ data: [resolutionWorkerRun()], error: null })
      .mockResolvedValueOnce({
        data: null,
        error: { code: "08006", message: "connection lost after commit" },
      })
      .mockResolvedValueOnce({
        data: [
          resolutionClusterRow({
            current_stage: "resolved",
            evidence_revision: 8,
            resolved_at: "2026-07-15T21:00:01.000Z",
          }),
        ],
        error: null,
      })
      .mockResolvedValueOnce({ data: [resolvedReplayRow()], error: null });

    const body = {
      requestId,
      workflowId: clusterId,
      expectedVersion: 8,
      action: "resolve",
      policyRuleId: "candidate-listing-noise",
    };
    const first = await POST(workflowRequest(body));
    mocks.candidateActive = false;
    const retry = await POST(workflowRequest(body));

    expect(first.status).toBe(500);
    expect(retry.status).toBe(200);
    expect(mocks.rpc.mock.calls[2]?.[1]?.p_evidence.completed_at).toBe(
      attestationFinishedAt,
    );
    expect(
      mocks.rpc.mock.calls.filter(
        ([name]) => name === "find_monitoring_feedback_resolution_worker_run",
      ),
    ).toHaveLength(1);
    expect(mocks.rpc).toHaveBeenNthCalledWith(
      5,
      "replay_monitoring_feedback_promotion_resolution",
      {
        p_request_id: requestId,
        p_cluster_id: clusterId,
        p_expected_evidence_revision: 8,
        p_actor_user_id: actorId,
        p_actor_email: "admin@awardping.test",
        p_policy_rule_id: "candidate_listing_noise",
      },
    );
  });

  it("keeps final resolution locked while the immutable rule is inactive", async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: [
        clusterRow({
          current_stage: "retroactive_sweep",
          proposed_rule_id: "candidate_listing_noise",
        }),
      ],
      error: null,
    });

    const response = await POST(
      workflowRequest({
        requestId,
        workflowId: clusterId,
        expectedVersion: 8,
        action: "resolve",
        policyRuleId: "candidate_listing_noise",
      }),
    );

    expect(response.status).toBe(409);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });

  it("keeps final resolution locked when the activated rule is not persistent", async () => {
    mocks.candidateActive = true;
    mocks.candidatePersistent = false;
    mocks.rpc.mockResolvedValueOnce({
      data: [
        clusterRow({
          current_stage: "retroactive_sweep",
          proposed_rule_id: "candidate_listing_noise",
        }),
      ],
      error: null,
    });

    const response = await POST(
      workflowRequest({
        requestId,
        workflowId: clusterId,
        expectedVersion: 8,
        action: "resolve",
        policyRuleId: "candidate_listing_noise",
      }),
    );

    expect(response.status).toBe(409);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });

  it("does not expose automated gate transitions as browser actions", async () => {
    const response = await POST(
      workflowRequest({
        requestId,
        workflowId: clusterId,
        expectedVersion: 3,
        action: "historical_shadow_test",
      }),
    );

    expect(response.status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("returns a failed pre-activation gate to the clustered draft checkpoint", async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: [
          clusterRow({
            current_stage: "historical_shadow_test",
            evidence_revision: 3,
            latest_attempt_stage: "regression_tests_pass",
            latest_attempt_accepted: false,
            latest_attempt_failure_reason: "A legitimate boundary fixture matched.",
          }),
        ],
        error: null,
      })
      .mockResolvedValueOnce({
        data: [
          {
            transition_id: "20000000-0000-4000-8000-000000000002",
            restarted_cluster_id: clusterId,
            previous_stage: "historical_shadow_test",
            current_stage: "similar_feedback_clustered",
            restarted: true,
            restart_evidence_revision: 3,
            failed_transition_id: "30000000-0000-4000-8000-000000000003",
          },
        ],
        error: null,
      });

    const response = await POST(
      workflowRequest({
        requestId,
        workflowId: clusterId,
        expectedVersion: 3,
        action: "restart_draft",
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      restarted: true,
      currentStage: "similar_feedback_clustered",
      evidenceRevision: 3,
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(
      2,
      "restart_monitoring_feedback_promotion_cluster",
      {
        p_request_id: requestId,
        p_cluster_id: clusterId,
        p_expected_evidence_revision: 3,
        p_actor_user_id: actorId,
        p_actor_email: "admin@awardping.test",
        p_note:
          "Operator reviewed the failed gate and requested a narrower replacement draft.",
      },
    );
  });

  it("does not restart a gate until a rejected attempt is recorded", async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: [
        clusterRow({
          current_stage: "rule_drafted",
          evidence_revision: 3,
          latest_attempt_accepted: null,
        }),
      ],
      error: null,
    });

    const response = await POST(
      workflowRequest({
        requestId,
        workflowId: clusterId,
        expectedVersion: 3,
        action: "restart_draft",
      }),
    );

    expect(response.status).toBe(409);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });

  it("does not clear a failed draft while its rule is active globally", async () => {
    mocks.candidateActive = true;
    mocks.rpc.mockResolvedValueOnce({
      data: [
        clusterRow({
          current_stage: "historical_shadow_test",
          proposed_rule_id: "candidate_listing_noise",
          evidence_revision: 3,
          latest_attempt_stage: "regression_tests_pass",
          latest_attempt_accepted: false,
        }),
      ],
      error: null,
    });

    const response = await POST(
      workflowRequest({
        requestId,
        workflowId: clusterId,
        expectedVersion: 3,
        action: "restart_draft",
      }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("Deactivate the live rule"),
    });
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });

  it("allows the database idempotency contract to answer an exact retry", async () => {
    mockListAndAdvance(
      clusterRow({ current_stage: "rule_drafted", evidence_revision: 2 }),
    );

    const response = await POST(
      workflowRequest({
        requestId,
        workflowId: clusterId,
        expectedVersion: 2,
        action: "draft_rule",
        policyRuleId: "candidate_listing_noise",
        draftSummary: "Stable retry body.",
        legitimateNegativeEventIds: [legitimateNegativeEventId],
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
  });

  it("rejects a stale browser after matching feedback changes the evidence revision", async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: [clusterRow({ current_stage: "triaged", evidence_revision: 2 })],
      error: null,
    });

    const response = await POST(workflowRequest(confirmBody()));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("changed after the page loaded"),
    });
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });

  it("returns rejected gate evidence as a conflict", async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: [clusterRow({ current_stage: "triaged" })], error: null })
      .mockResolvedValueOnce({
        data: [
          advanceRow({
            accepted: false,
            advanced: false,
            current_stage: "triaged",
            failure_reason: "The recurrence count changed.",
          }),
        ],
        error: null,
      });

    const response = await POST(workflowRequest(confirmBody()));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: "The recurrence count changed.",
      currentStage: "triaged",
    });
  });

  it("translates the legacy database cadence label into the feedback-promotion lane", async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: [clusterRow({ current_stage: "triaged" })],
        error: null,
      })
      .mockResolvedValueOnce({
        data: null,
        error: {
          code: "P0001",
          message:
            "Wait for the next successful matching hourly worker attestation completed after the retroactive sweep.",
        },
      });

    const response = await POST(workflowRequest(confirmBody()));
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.error).toContain("matching feedback-promotion lane attestation");
    expect(payload.error).not.toContain("hourly worker");
  });

  it("explains a missing workflow migration without implying suppression failed", async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: null,
      error: {
        code: "PGRST202",
        message: "Could not find get_monitoring_feedback_promotion_cluster",
      },
    });

    const response = await POST(workflowRequest(confirmBody()));
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(payload.error).toContain("not migrated");
    expect(payload.error).toContain("Immediate event suppression is still active");
  });
});

function confirmBody() {
  return {
    requestId,
    workflowId: clusterId,
    expectedVersion: 1,
    action: "confirm_cluster",
  };
}

function workflowRequest(
  body: Record<string, unknown>,
  origin: string | null = "https://awardping.test",
) {
  const headers = new Headers({ "content-type": "application/json" });
  if (origin !== null) headers.set("origin", origin);
  return new Request(
    "https://awardping.test/api/admin/monitoring-feedback/workflows",
    { method: "POST", headers, body: JSON.stringify(body) },
  );
}

function resolutionClusterRow(overrides: Record<string, unknown> = {}) {
  return clusterRow({
    current_stage: "retroactive_sweep",
    proposed_rule_id: "candidate_listing_noise",
    activation_status: "sweep_completed",
    stage_artifacts: {
      retroactive_sweep: { completed_at: sweepCompletedAt },
    },
    ...overrides,
  });
}

function resolutionWorkerRun(overrides: Record<string, unknown> = {}) {
  return {
    worker_run_id: resolutionWorkerRunId,
    finished_at: attestationFinishedAt,
    worker_revision: "app-revision",
    worker_policy_hash: "full-current-hash",
    worker_batch_policy_hash: "batch-current-hash",
    worker_suppression_policy_hash: "suppression-current-hash",
    worker_matcher_digest: "matcher-current-hash",
    ...overrides,
  };
}

function resolvedReplayRow() {
  return {
    ...advanceRow(),
    previous_stage: "retroactive_sweep",
    current_stage: "resolved",
    requested_stage: "resolved",
    accepted: true,
    advanced: false,
    promotion_count: 7,
    current_evidence_revision: 8,
  };
}

function mockResolveAndAdvance() {
  mocks.rpc
    .mockResolvedValueOnce({ data: [resolutionClusterRow()], error: null })
    .mockResolvedValueOnce({ data: [resolutionWorkerRun()], error: null })
    .mockResolvedValueOnce({ data: [advanceRow()], error: null });
}

function mockListAndAdvance(row: ReturnType<typeof clusterRow>) {
  mocks.rpc
    .mockResolvedValueOnce({ data: [row], error: null })
    .mockResolvedValueOnce({ data: [advanceRow()], error: null });
}

function clusterRow(overrides: Record<string, unknown> = {}) {
  const stage = String(overrides.current_stage || "triaged");
  const defaultRevision = {
    triaged: 1,
    similar_feedback_clustered: 2,
    rule_drafted: 3,
    historical_shadow_test: 4,
    regression_tests_pass: 5,
    app_worker_hashes_match: 6,
    six_pm_canary: 7,
    retroactive_sweep: 8,
    resolved: 9,
  }[stage] || 1;
  return {
    cluster_id: clusterId,
    cluster_key: clusterKey,
    evidence_signature: "b".repeat(64),
    domain_template: "example.org/awards/:id|award",
    reason_code: "content_churn",
    current_stage: "triaged",
    proposed_rule_id: null,
    evidence_revision: defaultRevision,
    activation_status: "inactive",
    activation_blocked_at: null,
    stage_artifacts: {},
    recurrence_count: 7,
    source_count: 3,
    sample_evidence: [],
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
    total_clusters: 1,
    ...overrides,
  };
}

function advanceRow(overrides: Record<string, unknown> = {}) {
  return {
    transition_id: "10000000-0000-4000-8000-000000000001",
    advanced_cluster_id: clusterId,
    previous_stage: "triaged",
    current_stage: "similar_feedback_clustered",
    requested_stage: "similar_feedback_clustered",
    accepted: true,
    advanced: true,
    failure_reason: null,
    promotion_count: 0,
    recurrence_count: 7,
    current_evidence_revision: 1,
    ...overrides,
  };
}
