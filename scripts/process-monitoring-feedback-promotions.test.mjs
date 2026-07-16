import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  awardMonitoringPolicy,
  monitoringPromotionMatcherIdentity,
} from "./lib/award-monitoring-policy.mjs";
import {
  buildMonitoringPromotionConfiguredRuleDraft,
  buildMonitoringPromotionRegressionReport,
  currentMonitoringPromotionWorkerIdentity,
} from "./lib/monitoring-feedback-promotion-verification.mjs";
import { monitoringPromotionMatcherBundleHash } from "./lib/monitoring-promotion-matcher-bundle.mjs";
import {
  applyGuardedPromotionSweepEvent,
  buildPostSweepResolutionWorkerAttestationMetadata,
  deterministicPromotionRequestId,
  enforceActivationIdentityChange,
  enforceRollbackIdentityRestore,
  evaluateCanaryCandidateReadiness,
  expectedCanaryCandidateCount,
  expectedCanaryEnqueuedCount,
  independentProductionSuppressionDecision,
  monitoringPromotionMatcherDigest,
  promotionActivationCycleId,
  promotionExceptionRequiresRollback,
  promotionRollbackCycleId,
  promotionWorkerFailureStage,
  recordPostSweepResolutionWorkerAttestation,
  recordPromotionWorkerFailure,
  runTargetedPromotionSweep,
  selectCanaryCohort,
  selectCanaryEventsBoundToRunIds,
  stabilizePromotionReport,
  submitCompletedRetroactiveSweep,
  validateBoundRegressionNegativeFixtures,
  workerRunCompletedAfterGate,
  workerRunHasSafeCanaryCoverage,
  workerRunMatchesIdentity,
} from "./process-monitoring-feedback-promotions.mjs";

const root = resolve(import.meta.dirname, "..");

describe("verified monitoring-feedback promotion worker", () => {
  it("computes the configured digest from the executable dependency bundle", () => {
    expect(monitoringPromotionMatcherDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(monitoringPromotionMatcherDigest).toBe(monitoringPromotionMatcherBundleHash);
    expect(monitoringPromotionMatcherDigest).toBe(monitoringPromotionMatcherIdentity.hash);
  });

  it("builds a cluster-bound zero-charge hourly resolution attestation", () => {
    const metadata = buildPostSweepResolutionWorkerAttestationMetadata({
      cluster: {
        cluster_id: "90000000-0000-4000-8000-000000000009",
        evidence_revision: 8,
      },
      worker: {
        revision: "commit-a",
        policy_identity: "full@1",
        policy_version: "1",
        policy_hash: "full",
        batch_policy_identity: "batch@1",
        batch_policy_version: "1",
        batch_policy_hash: "batch",
        suppression_policy_identity: "suppression@1",
        suppression_policy_version: "1",
        suppression_policy_hash: "suppression",
        matcher_identity: "matcher@1",
        matcher_version: "1",
        matcher_hash: "matcher",
      },
      sweepCompletedAt: "2026-07-15T20:00:00.000Z",
    });

    expect(metadata).toMatchObject({
      kind: "monitoring_feedback_promotion_resolution_attestation",
      attestation_source: "hourly_downstream_queue",
      api_charge: false,
      cluster_id: "90000000-0000-4000-8000-000000000009",
      evidence_revision: 8,
      sweep_completed_at: "2026-07-15T20:00:00.000Z",
      worker_revision: "commit-a",
      monitoring_policy_bundle: { hash: "full" },
      monitoring_policy: { hash: "batch" },
      suppression_policy: { hash: "suppression" },
      matcher_digest: "matcher",
    });
  });

  it("reuses the earliest matching resolution attestation without inserting duplicates", async () => {
    const env = { AWARDPING_WORKER_REVISION: "commit-a" };
    const baseWorker = currentMonitoringPromotionWorkerIdentity(env);
    const worker = {
      ...baseWorker,
      matcher_hash: monitoringPromotionMatcherDigest,
    };
    const workerRunId = "70000000-0000-4000-8000-000000000007";
    const finishedAt = "2026-07-15T21:00:00.000Z";
    const rpc = vi.fn().mockResolvedValue({
      data: [
        {
          worker_run_id: workerRunId,
          finished_at: finishedAt,
          worker_revision: worker.revision,
          worker_policy_hash: worker.policy_hash,
          worker_batch_policy_hash: worker.batch_policy_hash,
          worker_suppression_policy_hash: worker.suppression_policy_hash,
          worker_matcher_digest: worker.matcher_hash,
        },
      ],
      error: null,
    });
    const from = vi.fn();
    const fetchImpl = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            schemaVersion: "monitoring-promotion-app-identity-v1",
            revision: worker.revision,
            policy_hash: worker.policy_hash,
            batch_policy_hash: worker.batch_policy_hash,
            suppression_policy_hash: worker.suppression_policy_hash,
            matcher_hash: worker.matcher_hash,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const input = {
      supabase: { rpc, from },
      cluster: {
        cluster_id: "90000000-0000-4000-8000-000000000009",
        evidence_revision: 8,
        stage_artifacts: {
          retroactive_sweep: {
            completed_at: "2026-07-15T20:00:00.000Z",
            activation_attestation: {
              app_revision: worker.revision,
              worker_revision: worker.revision,
              app_policy_hash: worker.policy_hash,
              worker_policy_hash: worker.policy_hash,
              app_batch_policy_hash: worker.batch_policy_hash,
              worker_batch_policy_hash: worker.batch_policy_hash,
              app_suppression_policy_hash: worker.suppression_policy_hash,
              worker_suppression_policy_hash: worker.suppression_policy_hash,
              app_matcher_digest: worker.matcher_hash,
              worker_matcher_digest: worker.matcher_hash,
            },
          },
        },
      },
      config: { appUrl: "https://awardping.test", fetchTimeoutMs: 1_000 },
      env,
      fetchImpl,
    };

    const first = await recordPostSweepResolutionWorkerAttestation(input);
    const second = await recordPostSweepResolutionWorkerAttestation(input);

    expect(first).toMatchObject({ worker_run_id: workerRunId, reused: true });
    expect(second).toMatchObject({ worker_run_id: workerRunId, reused: true });
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenCalledWith(
      "find_monitoring_feedback_resolution_worker_run",
      expect.objectContaining({
        p_cluster_id: "90000000-0000-4000-8000-000000000009",
        p_expected_evidence_revision: 8,
        p_not_before: "2026-07-15T20:00:00.000Z",
      }),
    );
    expect(from).not.toHaveBeenCalled();
  });

  it("rejects a jointly drifted app and worker before recording post-sweep readiness", async () => {
    const env = { AWARDPING_WORKER_REVISION: "commit-b" };
    const worker = {
      ...currentMonitoringPromotionWorkerIdentity(env),
      matcher_hash: monitoringPromotionMatcherDigest,
    };
    const rpc = vi.fn();
    const from = vi.fn();
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          schemaVersion: "monitoring-promotion-app-identity-v1",
          revision: worker.revision,
          policy_hash: worker.policy_hash,
          batch_policy_hash: worker.batch_policy_hash,
          suppression_policy_hash: worker.suppression_policy_hash,
          matcher_hash: worker.matcher_hash,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await expect(
      recordPostSweepResolutionWorkerAttestation({
        supabase: { rpc, from },
        cluster: {
          cluster_id: "90000000-0000-4000-8000-000000000009",
          evidence_revision: 8,
          stage_artifacts: {
            retroactive_sweep: {
              completed_at: "2026-07-15T20:00:00.000Z",
              activation_attestation: {
                app_revision: "commit-a",
                worker_revision: "commit-a",
                app_policy_hash: worker.policy_hash,
                worker_policy_hash: worker.policy_hash,
                app_batch_policy_hash: worker.batch_policy_hash,
                worker_batch_policy_hash: worker.batch_policy_hash,
                app_suppression_policy_hash: worker.suppression_policy_hash,
                worker_suppression_policy_hash: worker.suppression_policy_hash,
                app_matcher_digest: worker.matcher_hash,
                worker_matcher_digest: worker.matcher_hash,
              },
            },
          },
        },
        config: { appUrl: "https://awardping.test", fetchTimeoutMs: 1_000 },
        env,
        fetchImpl,
      }),
    ).rejects.toThrow("drifted from the immutable activated sweep");
    expect(rpc).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
  });

  it("marks rollback required when the final post-mutation sweep transition is rejected", async () => {
    const clusterId = "90000000-0000-4000-8000-000000000009";
    const gateDigest = "a".repeat(64);
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({
        data: [{ accepted: false, failure_reason: "evidence revision changed" }],
        error: null,
      })
      .mockResolvedValueOnce({
        data: [
          {
            marker_transition_id: "60000000-0000-4000-8000-000000000006",
            marked_cluster_id: clusterId,
            current_activation_status: "rollback_required",
            current_evidence_revision: 8,
          },
        ],
        error: null,
      });

    const result = await submitCompletedRetroactiveSweep({
      supabase: { rpc },
      cluster: {
        cluster_id: clusterId,
        cluster_key: "b".repeat(64),
        current_stage: "six_pm_canary",
        evidence_revision: 8,
      },
      gateReport: {
        schema_version: "monitoring-promotion-retroactive-sweep-v1",
        status: "completed",
        cursor_complete: true,
        cursor: { complete: true },
        activation_attestation: { status: "passed" },
        digest: gateDigest,
        summary: "The verified rule completed its bounded historical sweep.",
      },
      ruleId: "routine_listing_timestamp_churn",
      config: {
        actorId: "80000000-0000-4000-8000-000000000008",
        actorEmail: "worker@awardping.test",
        policyIdentity: "policy@1",
        policyVersion: "1",
        policyHash: "c".repeat(64),
        policyConfigVersion: 1,
        decisionMemoryVersion: 1,
      },
    });

    expect(result).toMatchObject({
      status: "failed",
      activation_status: "rollback_required",
    });
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[1]).toEqual([
      "mark_monitoring_feedback_promotion_rollback_required",
      expect.objectContaining({
        p_reason: "retroactive_sweep_failed",
        p_evidence: expect.objectContaining({
          status: "failed",
          completed_sweep_digest: gateDigest,
          transition_failure_reason: "evidence revision changed",
          cursor: { complete: true },
          activation_attestation: { status: "passed" },
          digest: expect.stringMatching(/^[0-9a-f]{64}$/),
          summary: expect.stringContaining("rollback is required"),
        }),
      }),
    ]);
  });

  it("refuses a canary without a concrete post-attestation not-before", () => {
    expect(
      selectCanaryCohort([scheduledRun({ shard: 0 })], {
        notBefore: null,
        expectedRevision: "commit-a",
        expectedHashes: hashes(),
        expectedMatcherDigest: monitoringPromotionMatcherDigest,
      }),
    ).toBeNull();
  });

  it("selects only a later exact scheduled three-shard cohort", () => {
    const oldRuns = [0, 1, 2].map((shard) =>
      scheduledRun({
        id: `old-${shard}`,
        shard,
        monitoringDate: "2026-07-14",
        startedAt: `2026-07-14T23:0${shard}:00.000Z`,
      }),
    );
    const laterRuns = [0, 1, 2].map((shard) =>
      scheduledRun({
        id: `new-${shard}`,
        shard,
        monitoringDate: "2026-07-15",
        startedAt: `2026-07-15T23:0${shard}:00.000Z`,
      }),
    );
    const cohort = selectCanaryCohort([...oldRuns, ...laterRuns], {
      notBefore: "2026-07-15T00:00:00.000Z",
      expectedRevision: "commit-a",
      expectedHashes: hashes(),
      expectedMatcherDigest: monitoringPromotionMatcherDigest,
    });

    expect(cohort?.cohortId).toBe("visual-nightly:2026-07-15");
    expect(cohort?.runs.map((run) => run.id)).toEqual(["new-0", "new-1", "new-2"]);
    expect(cohort?.exactIdentity).toBe(true);

    const microsecondRuns = [0, 1, 2].map((shard) =>
      scheduledRun({
        id: `micro-${shard}`,
        shard,
        startedAt: `2026-07-15T23:00:00.00000${shard + 1}+00:00`,
      }),
    );
    expect(
      selectCanaryCohort(microsecondRuns, {
        notBefore: "2026-07-15T23:00:00.000000Z",
        expectedRevision: "commit-a",
        expectedHashes: hashes(),
        expectedMatcherDigest: monitoringPromotionMatcherDigest,
      }),
    ).not.toBeNull();
    expect(
      selectCanaryCohort(microsecondRuns, {
        notBefore: "2026-07-15T23:00:00.000001Z",
        expectedRevision: "commit-a",
        expectedHashes: hashes(),
        expectedMatcherDigest: monitoringPromotionMatcherDigest,
      }),
    ).toBeNull();
  });

  it("flags a selected shard whose worker revision or matcher differs", () => {
    const runs = [0, 1, 2].map((shard) =>
      scheduledRun({
        id: `run-${shard}`,
        shard,
        revision: shard === 2 ? "other-commit" : "commit-a",
      }),
    );
    const cohort = selectCanaryCohort(runs, {
      notBefore: "2026-07-15T00:00:00.000Z",
      expectedRevision: "commit-a",
      expectedHashes: hashes(),
      expectedMatcherDigest: monitoringPromotionMatcherDigest,
    });

    expect(cohort?.exactIdentity).toBe(false);
  });

  it("prefers a later repaired exact cohort over an older failed cohort", () => {
    const failed = [0, 1, 2].map((shard) =>
      scheduledRun({
        id: `failed-${shard}`,
        shard,
        monitoringDate: "2026-07-15",
        revision: "stale-commit",
      }),
    );
    const repaired = [0, 1, 2].map((shard) =>
      scheduledRun({
        id: `repaired-${shard}`,
        shard,
        monitoringDate: "2026-07-16",
        startedAt: `2026-07-16T23:0${shard}:00.000Z`,
      }),
    );
    const cohort = selectCanaryCohort([...failed, ...repaired], {
      notBefore: "2026-07-15T00:00:00.000Z",
      expectedRevision: "commit-a",
      expectedHashes: hashes(),
      expectedMatcherDigest: monitoringPromotionMatcherDigest,
    });

    expect(cohort?.cohortId).toBe("visual-nightly:2026-07-16");
    expect(cohort?.exactIdentity).toBe(true);
    expect(cohort?.completed).toBe(true);
  });

  it("uses the newest exact completed cohort so a later repair can recover", () => {
    const first = [0, 1, 2].map((shard) =>
      scheduledRun({ id: `first-${shard}`, shard, monitoringDate: "2026-07-15" }),
    );
    const second = [0, 1, 2].map((shard) =>
      scheduledRun({
        id: `second-${shard}`,
        shard,
        monitoringDate: "2026-07-16",
        startedAt: `2026-07-16T23:0${shard}:00.000Z`,
      }),
    );
    const cohort = selectCanaryCohort([...first, ...second], {
      notBefore: "2026-07-15T00:00:00.000Z",
      expectedRevision: "commit-a",
      expectedHashes: hashes(),
      expectedMatcherDigest: monitoringPromotionMatcherDigest,
    });
    expect(cohort?.cohortId).toBe("visual-nightly:2026-07-16");
  });

  it("keeps an incomplete three-shard cohort in a nonterminal waiting state", () => {
    const runs = [0, 1, 2].map((shard) =>
      scheduledRun({ id: `running-${shard}`, shard }),
    );
    runs[2].status = "running";
    runs[2].finished_at = null;
    const cohort = selectCanaryCohort(runs, {
      notBefore: "2026-07-15T00:00:00.000Z",
      expectedRevision: "commit-a",
      expectedHashes: hashes(),
      expectedMatcherDigest: monitoringPromotionMatcherDigest,
    });

    expect(cohort).toMatchObject({ exactIdentity: true, completed: false });
  });

  it("rejects a terminal canary shard with capture or observation-ledger failures", () => {
    const failedCapture = scheduledRun({ shard: 0 });
    failedCapture.failed_count = 1;
    const failedObservation = scheduledRun({ shard: 1 });
    failedObservation.metadata.counts.visual_review_candidate_observation_failures = 1;
    expect(workerRunHasSafeCanaryCoverage(failedCapture)).toBe(false);
    expect(workerRunHasSafeCanaryCoverage(failedObservation)).toBe(false);
    expect(workerRunHasSafeCanaryCoverage(scheduledRun({ shard: 2 }))).toBe(true);

    const cohort = selectCanaryCohort(
      [failedCapture, failedObservation, scheduledRun({ shard: 2 })],
      {
        notBefore: "2026-07-15T00:00:00.000Z",
        expectedRevision: "commit-a",
        expectedHashes: hashes(),
        expectedMatcherDigest: monitoringPromotionMatcherDigest,
      },
    );
    expect(cohort).toMatchObject({
      exactIdentity: true,
      completed: true,
      captureCoverageSafe: false,
    });
  });

  it("cannot satisfy canary evidence with a candidate from another run", () => {
    const selected = selectCanaryEventsBoundToRunIds({
      runIds: ["run-0", "run-1", "run-2"],
      candidates: [
        { id: "candidate-good", worker_metadata: { worker_run_id: "run-1" } },
        { id: "candidate-other", worker_metadata: { worker_run_id: "run-other" } },
      ],
      events: [
        { id: "event-good", visual_review_candidate_id: "candidate-good" },
        { id: "event-other", visual_review_candidate_id: "candidate-other" },
      ],
    });

    expect(selected.events.map((event) => event.id)).toEqual(["event-good"]);
    expect(selected.bindings).toEqual([
      {
        event_id: "event-good",
        candidate_id: "candidate-good",
        worker_run_id: "run-1",
      },
    ]);
  });

  it("seals canary candidates, observations, events, and bindings in stable order", () => {
    const input = {
      runIds: ["run-0", "run-1"],
      observations: [
        { run_id: "run-1", candidate_id: "candidate-b" },
        { run_id: "run-0", candidate_id: "candidate-a" },
      ],
      candidates: [
        { id: "candidate-b", status: "rejected" },
        { id: "candidate-a", status: "published" },
      ],
      events: [
        {
          id: "event-z",
          detected_at: "2026-07-15T02:00:00.000Z",
          visual_review_candidate_id: "candidate-b",
        },
        {
          id: "event-a",
          detected_at: "2026-07-15T01:00:00.000Z",
          visual_review_candidate_id: "candidate-a",
        },
      ],
      expectedCandidateCount: 2,
    };
    const first = selectCanaryEventsBoundToRunIds(input);
    const reversed = selectCanaryEventsBoundToRunIds({
      ...input,
      observations: [...input.observations].reverse(),
      candidates: [...input.candidates].reverse(),
      events: [...input.events].reverse(),
    });
    expect(first).toEqual(reversed);
    expect(first.bindings.map((item) => item.event_id)).toEqual([
      "event-a",
      "event-z",
    ]);

    const precise = selectCanaryEventsBoundToRunIds({
      runIds: ["run-0"],
      observations: [
        { run_id: "run-0", candidate_id: "candidate-a" },
        { run_id: "run-0", candidate_id: "candidate-b" },
      ],
      candidates: [
        { id: "candidate-a", status: "published" },
        { id: "candidate-b", status: "published" },
      ],
      events: [
        {
          id: "micro-later",
          detected_at: "2026-07-15T01:00:00.000002+00:00",
          visual_review_candidate_id: "candidate-b",
        },
        {
          id: "micro-earlier",
          detected_at: "2026-07-15T01:00:00.000001Z",
          visual_review_candidate_id: "candidate-a",
        },
      ],
    });
    expect(precise.events.map((event) => event.id)).toEqual([
      "micro-earlier",
      "micro-later",
    ]);
  });

  it("waits for pending candidates and fails failed or unbound published candidates", () => {
    expect(
      evaluateCanaryCandidateReadiness({
        candidates: [{ id: "pending", status: "pending" }],
        bindings: [],
      }),
    ).toMatchObject({ status: "waiting", in_flight_count: 1 });
    expect(
      evaluateCanaryCandidateReadiness({
        candidates: [{ id: "failed", status: "failed", rejection_reason: "upload failed" }],
        bindings: [],
      }),
    ).toMatchObject({ status: "failed" });
    expect(
      evaluateCanaryCandidateReadiness({
        candidates: [{ id: "published", status: "published" }],
        bindings: [],
      }),
    ).toMatchObject({ status: "failed" });
  });

  it("accepts published canary candidates only with an exact-run event binding", () => {
    const binding = selectCanaryEventsBoundToRunIds({
      runIds: ["run-0"],
      candidates: [
        {
          id: "candidate",
          status: "published",
          worker_metadata: { worker_run_id: "run-0" },
        },
      ],
      events: [{ id: "event", visual_review_candidate_id: "candidate" }],
    });
    expect(evaluateCanaryCandidateReadiness(binding)).toMatchObject({
      status: "ready",
      in_flight_count: 0,
    });
    expect(binding.bindings[0].worker_run_id).toBe("run-0");
  });

  it("distinguishes a true zero-candidate cohort from missing run bindings", () => {
    const run = scheduledRun({});
    run.metadata.counts = {
      visual_review_candidate_observations: 2,
      text_only_candidate_enqueued: 1,
      visual_only_candidate_enqueued: 1,
      section_change_candidates_enqueued: 0,
    };
    expect(expectedCanaryCandidateCount([run])).toBe(2);
    expect(expectedCanaryEnqueuedCount([run])).toBe(2);
    expect(
      evaluateCanaryCandidateReadiness({
        expectedCandidateCount: 2,
        candidates: [{ id: "only-one", status: "rejected" }],
        bindings: [],
      }),
    ).toMatchObject({ status: "failed" });
    expect(
      evaluateCanaryCandidateReadiness({
        expectedCandidateCount: 0,
        candidates: [],
        bindings: [],
      }),
    ).toMatchObject({ status: "ready" });
  });

  it("conservatively blocks superseded candidates even with a terminal replacement", () => {
    expect(
      evaluateCanaryCandidateReadiness({
        expectedCandidateCount: 2,
        candidates: [
          {
            id: "old",
            status: "superseded",
            worker_metadata: { replacement_candidate_id: "replacement" },
          },
          { id: "replacement", status: "rejected" },
        ],
        bindings: [],
      }),
    ).toMatchObject({
      status: "failed",
      status_counts: { superseded: 1, rejected: 1 },
      failures: [
        {
          candidate_id: "old",
          replacement_candidate_id: "replacement",
          status: "superseded",
        },
      ],
    });
    expect(
      evaluateCanaryCandidateReadiness({
        expectedCandidateCount: 2,
        candidates: [
          {
            id: "old",
            status: "superseded",
            worker_metadata: { superseded_by_candidate_id: "replacement" },
          },
          { id: "replacement", status: "published" },
        ],
        bindings: [{ candidate_id: "replacement", event_id: "event" }],
      }),
    ).toMatchObject({
      status: "failed",
      status_counts: { superseded: 1, published: 1 },
      failures: [
        {
          candidate_id: "old",
          replacement_candidate_id: "replacement",
          status: "superseded",
        },
      ],
    });
    expect(
      evaluateCanaryCandidateReadiness({
        expectedCandidateCount: 1,
        candidates: [
          {
            id: "old",
            status: "superseded",
            worker_metadata: { superseded_by_candidate_id: "later-replacement" },
          },
        ],
        bindings: [],
      }),
    ).toMatchObject({ status: "failed" });
    expect(
      evaluateCanaryCandidateReadiness({
        expectedCandidateCount: 1,
        candidates: [{ id: "old", status: "superseded", worker_metadata: {} }],
        bindings: [],
      }),
    ).toMatchObject({ status: "failed" });
  });

  it("requires a concrete exact worker-run revision, three policies, and matcher", () => {
    const identity = {
      revision: "commit-a",
      policy_hash: "full",
      batch_policy_hash: "batch",
      suppression_policy_hash: "suppression",
      matcher_hash: monitoringPromotionMatcherDigest,
    };
    expect(workerRunMatchesIdentity(scheduledRun({}), identity)).toBe(true);
    expect(
      workerRunMatchesIdentity(
        scheduledRun({ matcherDigest: "0".repeat(64) }),
        identity,
      ),
    ).toBe(false);
    expect(
      workerRunMatchesIdentity(
        { ...scheduledRun({}), status: "completed" },
        identity,
      ),
    ).toBe(false);
    expect(
      workerRunMatchesIdentity(
        { ...scheduledRun({}), failed_count: 1 },
        identity,
      ),
    ).toBe(false);
    expect(
      workerRunMatchesIdentity(
        { ...scheduledRun({}), worker_name: "other-worker" },
        identity,
      ),
    ).toBe(false);
  });

  it("uses a completed worker observation strictly after its prerequisite gate", () => {
    const run = scheduledRun({ startedAt: "2026-07-15T23:00:00.000Z" });
    expect(
      workerRunCompletedAfterGate(run, "2026-07-15T23:00:30.000Z"),
    ).toBe(true);
    expect(
      workerRunCompletedAfterGate(run, "2026-07-15T23:01:00.000Z"),
    ).toBe(false);
    expect(workerRunCompletedAfterGate({ ...run, finished_at: null }, run.started_at)).toBe(
      false,
    );
    expect(
      workerRunCompletedAfterGate(
        { ...run, finished_at: "2026-07-15T23:00:30.000001+00:00" },
        "2026-07-15T23:00:30.000000Z",
      ),
    ).toBe(true);
    expect(
      workerRunCompletedAfterGate(
        { ...run, finished_at: "2026-07-15T23:00:30.000001+00:00" },
        "2026-07-15T23:00:30.000001Z",
      ),
    ).toBe(false);
  });

  it("atomically blocks a sweep event when late evidence changes the revision", async () => {
    const eventId = "10000000-0000-4000-8000-000000000010";
    const clusterId = "10000000-0000-4000-8000-000000000011";
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({
        data: [
          {
            sweep_event_id: eventId,
            applied: true,
            already_applied: false,
            mutation_at: "2026-07-15T23:30:00.001Z",
            current_evidence_revision: 7,
            current_activation_status: "armed",
          },
        ],
        error: null,
      })
      .mockResolvedValueOnce({
        data: null,
        error: {
          code: "40001",
          message: "promotion evidence revision is stale; expected 7, current 8",
        },
      });
    const input = {
      supabase: { rpc },
      clusterId,
      evidenceRevision: 7,
      ruleId: "fundraising_form_change",
      eventId,
      suppressedAt: null,
      suppressionReason: "policy_flag_fundraising_form_change",
    };

    await expect(applyGuardedPromotionSweepEvent(input)).resolves.toMatchObject({
      applied: true,
      current_activation_status: "armed",
    });
    await expect(applyGuardedPromotionSweepEvent(input)).rejects.toMatchObject({
      activationBlocked: true,
      code: "40001",
    });
    expect(rpc).toHaveBeenCalledWith(
      "apply_monitoring_feedback_promotion_sweep_event",
      {
        p_cluster_id: clusterId,
        p_expected_evidence_revision: 7,
        p_policy_rule_id: "fundraising_form_change",
        p_event_id: eventId,
        p_suppressed_at: null,
        p_suppression_reason: "policy_flag_fundraising_form_change",
      },
    );
  });

  it("uses a terminal cursor and the final durable checkpoint for a nonempty final sweep pass", async () => {
    const fixture = targetedSweepFixture();
    const cluster = {
      cluster_id: "10000000-0000-4000-8000-000000000030",
      cluster_key: "f".repeat(64),
      current_stage: "six_pm_canary",
      activation_status: "armed",
      activation_blocked_at: null,
      evidence_revision: 7,
      proposed_rule_id: "fundraising_form_change",
      stage_artifacts: {
        six_pm_canary: {
          digest: "e".repeat(64),
          status: "passed",
          completed_at: "2026-07-15T19:00:00.000Z",
        },
      },
    };
    const input = {
      supabase: fixture.supabase,
      cluster,
      ruleId: "fundraising_form_change",
      policyHash: "suppression-policy",
      batchSize: 1,
      apply: true,
    };

    const firstPass = await runTargetedPromotionSweep(input);
    const finalPass = await runTargetedPromotionSweep(input);

    expect(firstPass).toMatchObject({
      complete: false,
      cursor: {
        detected_at: fixture.events[0].detected_at,
        event_id: fixture.events[0].id,
      },
      checkpoint_at: fixture.times[1],
      last_mutation_at: fixture.times[0],
      completed_at: null,
    });
    expect(finalPass).toMatchObject({
      complete: true,
      cursor: {
        detected_at: null,
        event_id: null,
        end_of_history: true,
      },
      checkpoint_at: fixture.times[3],
      last_mutation_at: fixture.times[2],
      completed_at: fixture.times[3],
      scanned_count: 2,
      suppressed_count: 2,
      applied_count: 1,
    });
    expect(fixture.checkpointArgs).toEqual([
      expect.objectContaining({
        p_cursor_detected_at: fixture.events[0].detected_at,
        p_cursor_event_id: fixture.events[0].id,
        p_scanned_count: 1,
      }),
      expect.objectContaining({
        p_cursor_detected_at: null,
        p_cursor_event_id: null,
        p_scanned_count: 2,
      }),
    ]);
    expect(Date.parse(finalPass.completed_at)).toBeGreaterThan(
      Date.parse(firstPass.checkpoint_at),
    );
    expect(Date.parse(finalPass.completed_at)).toBeGreaterThan(
      Date.parse(finalPass.last_mutation_at),
    );
    expect(finalPass.completed_at).not.toBe(fixture.events[1].detected_at);
    expect(
      workerRunCompletedAfterGate(
        { finished_at: fixture.times[2] },
        finalPass.completed_at,
      ),
    ).toBe(false);
    expect(fixture.checkpointNotBefore).toEqual([
      fixture.times[0],
      fixture.times[2],
    ]);
  });

  it("canonicalizes offset RPC timestamps and preserves a one-microsecond checkpoint boundary", async () => {
    const fixture = targetedSweepFixture({
      times: [
        "2026-07-15T20:00:01.123456+00:00",
        "2026-07-15T20:00:01.123457+00:00",
        "2026-07-15T20:00:01.123458+00:00",
        "2026-07-15T20:00:01.123459+00:00",
      ],
    });
    const cluster = {
      cluster_id: "10000000-0000-4000-8000-000000000030",
      cluster_key: "f".repeat(64),
      current_stage: "six_pm_canary",
      activation_status: "armed",
      activation_blocked_at: null,
      evidence_revision: 7,
      proposed_rule_id: "fundraising_form_change",
      stage_artifacts: {
        six_pm_canary: {
          digest: "e".repeat(64),
          status: "passed",
          completed_at: "2026-07-15T19:00:00.000Z",
        },
      },
    };
    const input = {
      supabase: fixture.supabase,
      cluster,
      ruleId: "fundraising_form_change",
      policyHash: "suppression-policy",
      batchSize: 1,
      apply: true,
    };

    const firstPass = await runTargetedPromotionSweep(input);
    const finalPass = await runTargetedPromotionSweep(input);

    expect(firstPass).toMatchObject({
      last_mutation_at: "2026-07-15T20:00:01.123456Z",
      checkpoint_at: "2026-07-15T20:00:01.123457Z",
    });
    expect(finalPass).toMatchObject({
      complete: true,
      last_mutation_at: "2026-07-15T20:00:01.123458Z",
      checkpoint_at: "2026-07-15T20:00:01.123459Z",
      completed_at: "2026-07-15T20:00:01.123459Z",
    });
    expect(fixture.checkpointNotBefore).toEqual([
      "2026-07-15T20:00:01.123456Z",
      "2026-07-15T20:00:01.123458Z",
    ]);
    expect(Date.parse(finalPass.checkpoint_at)).toBe(
      Date.parse(finalPass.last_mutation_at),
    );
    for (const boundary of [
      finalPass.last_mutation_at,
      finalPass.checkpoint_at,
      finalPass.completed_at,
    ]) {
      expect(boundary).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/,
      );
    }
  });

  it("keeps an exact null last-mutation attestation when a completed sweep changes nothing", async () => {
    const fixture = targetedSweepFixture({
      times: ["2026-07-15T20:00:01.123457+00:00"],
    });
    for (const event of fixture.events) {
      event.summary = "The application deadline changed.";
      event.change_details.quality_flags = [];
    }
    const sweep = await runTargetedPromotionSweep({
      supabase: fixture.supabase,
      cluster: {
        cluster_id: "10000000-0000-4000-8000-000000000030",
        cluster_key: "f".repeat(64),
        current_stage: "six_pm_canary",
        activation_status: "armed",
        activation_blocked_at: null,
        evidence_revision: 7,
        proposed_rule_id: "fundraising_form_change",
        stage_artifacts: {
          six_pm_canary: {
            digest: "e".repeat(64),
            status: "passed",
            completed_at: "2026-07-15T19:00:00.000Z",
          },
        },
      },
      ruleId: "fundraising_form_change",
      policyHash: "suppression-policy",
      batchSize: 10,
      apply: true,
    });

    expect(sweep).toMatchObject({
      complete: true,
      checkpoint_at: "2026-07-15T20:00:01.123457Z",
      completed_at: "2026-07-15T20:00:01.123457Z",
      last_mutation_at: null,
      suppressed_count: 0,
      applied_count: 0,
    });
  });

  it("persists a bounded preactivation worker exception at the actual failed gate", async () => {
    const clusterId = "10000000-0000-4000-8000-000000000020";
    const rpc = vi.fn().mockResolvedValue({
      data: [
        {
          failure_transition_id: "10000000-0000-4000-8000-000000000021",
          recorded_cluster_id: clusterId,
          current_stage: "rule_drafted",
          current_activation_status: "inactive",
          failed_stage: "historical_shadow_test",
          recorded: true,
          current_evidence_revision: 3,
        },
      ],
      error: null,
    });
    const result = await recordPromotionWorkerFailure({
      supabase: { rpc },
      cluster: {
        cluster_id: clusterId,
        cluster_key: "a".repeat(64),
        current_stage: "rule_drafted",
        activation_status: "inactive",
        evidence_revision: 3,
        proposed_rule_id: "fundraising_form_change",
        updated_at: "2026-07-15T18:00:00.000Z",
      },
      config: {
        actorId: "10000000-0000-4000-8000-000000000022",
        actorEmail: "worker@example.org",
      },
      reason: "history query failed safely",
    });

    expect(result).toMatchObject({
      failed_stage: "historical_shadow_test",
      safe_action: expect.stringContaining("history"),
    });
    expect(rpc).toHaveBeenCalledWith(
      "record_monitoring_feedback_promotion_worker_failure",
      expect.objectContaining({
        p_cluster_id: clusterId,
        p_expected_evidence_revision: 3,
        p_expected_current_stage: "rule_drafted",
        p_failure_stage: "historical_shadow_test",
        p_failure_reason: "history query failed safely",
        p_safe_action: expect.any(String),
        p_evidence: expect.objectContaining({
          schema_version: "monitoring-promotion-worker-failure-v1",
          status: "failed",
          current_stage: "rule_drafted",
          failure_stage: "historical_shadow_test",
          safe_action: expect.any(String),
          errors: [{ message: "history query failed safely" }],
          digest: expect.stringMatching(/^[0-9a-f]{64}$/),
        }),
      }),
    );
  });

  it("classifies armed and blocked exceptions as retroactive rollback failures", () => {
    expect(
      promotionExceptionRequiresRollback({ activation_status: "armed" }),
    ).toBe(true);
    expect(
      promotionWorkerFailureStage({
        current_stage: "six_pm_canary",
        activation_status: "armed",
      }),
    ).toBe("retroactive_sweep");
    expect(
      promotionWorkerFailureStage({
        current_stage: "six_pm_canary",
        activation_status: "blocked_late_evidence",
      }),
    ).toBe("retroactive_sweep");
    expect(
      promotionExceptionRequiresRollback({ activation_status: "inactive" }),
    ).toBe(false);
  });

  it("uses stable report and request IDs for unchanged evidence", () => {
    const report = {
      schema_version: "example-v1",
      report_id: crypto.randomUUID(),
      cluster_key: "a".repeat(64),
      completed_at: "2026-07-15T00:00:00.000Z",
      status: "failed",
      summary: "unchanged failure",
      digest: "discarded",
    };
    const first = stabilizePromotionReport(report);
    const second = stabilizePromotionReport({ ...report, report_id: crypto.randomUUID() });
    expect(first).toEqual(second);
    expect(
      deterministicPromotionRequestId("cluster", "stage", first.digest),
    ).toBe(deterministicPromotionRequestId("cluster", "stage", second.digest));
  });

  it("fails closed when bound negative IDs are missing, duplicated, or overlap positives", () => {
    const legitimateId = "10000000-0000-4000-8000-000000000001";
    const positiveId = "10000000-0000-4000-8000-000000000002";
    const missingId = "10000000-0000-4000-8000-000000000003";
    const result = validateBoundRegressionNegativeFixtures({
      boundEventIds: [
        legitimateId,
        legitimateId,
        positiveId,
        missingId,
        "not-a-uuid",
      ],
      positiveEventIds: [positiveId],
      events: [legitimateUpdate(legitimateId), legitimateUpdate(positiveId)],
    });

    expect(result.failures.map((failure) => failure.code)).toEqual([
      "invalid-negative-fixture-id",
      "duplicate-negative-fixture-id",
      "positive-negative-fixture-overlap",
      "missing-negative-fixture-event",
    ]);
    expect(
      validateBoundRegressionNegativeFixtures({ boundEventIds: [], events: [] })
        .failures,
    ).toMatchObject([{ code: "missing-bound-negative-fixtures" }]);
  });

  it("fails an over-broad matcher against a fixed operator-confirmed negative", () => {
    const rule = awardMonitoringPolicy.policy_flags.find(
      (candidate) => candidate.id === "fundraising_form_change",
    );
    const draft = buildMonitoringPromotionConfiguredRuleDraft(
      "fundraising_form_change",
    );
    expect(rule).toBeDefined();
    expect(draft).not.toBeNull();
    const previousActive = rule?.active;
    if (rule) rule.active = false;
    try {
      const negative = legitimateUpdate(
        "10000000-0000-4000-8000-000000000004",
      );
      negative.change_details.quality_flags = ["fundraising-form-change"];
      const report = buildMonitoringPromotionRegressionReport({
        clusterKey: "a".repeat(64),
        ruleId: "fundraising_form_change",
        draftHash: draft?.hash,
        positiveFixtures: [
          {
            id: "10000000-0000-4000-8000-000000000005",
            summary: "The donation widget changed its suggested gift amount.",
            change_details: { is_alert_worthy: true },
          },
        ],
        // This fixture is fixed before matcher execution; the matcher does not
        // get to choose a convenient event it already preserves.
        negativeFixtures: [negative],
      });
      expect(report.status).toBe("failed");
      expect(report.fixture_results).toContainEqual({
        fixture_id: negative.id,
        expected: "visible",
        matched: true,
      });
    } finally {
      if (rule) {
        if (previousActive === undefined) delete rule.active;
        else rule.active = previousActive;
      }
    }
  });

  it("blocks activation unless all three active policy hashes changed", () => {
    const base = {
      schema_version: "monitoring-promotion-hash-attestation-v1",
      status: "passed",
      app_policy_hash: "active-full",
      app_batch_policy_hash: "active-batch",
      app_suppression_policy_hash: "active-suppression",
    };
    expect(
      enforceActivationIdentityChange(base, {
        app_policy_hash: "inactive-full",
        app_batch_policy_hash: "inactive-batch",
        app_suppression_policy_hash: "inactive-suppression",
      }).status,
    ).toBe("passed");
    expect(
      enforceActivationIdentityChange(base, {
        app_policy_hash: "active-full",
        app_batch_policy_hash: "inactive-batch",
        app_suppression_policy_hash: "inactive-suppression",
      }).status,
    ).toBe("failed");
  });

  it("requires an exact inactive restore before activation rollback", () => {
    const report = {
      schema_version: "monitoring-promotion-hash-attestation-v1",
      status: "passed",
      rule_active: false,
      app_policy_hash: "pre-full",
      app_batch_policy_hash: "pre-batch",
      app_suppression_policy_hash: "pre-suppression",
      app_matcher_digest: monitoringPromotionMatcherDigest,
    };
    const preActivation = {
      app_policy_hash: "pre-full",
      app_batch_policy_hash: "pre-batch",
      app_suppression_policy_hash: "pre-suppression",
      app_matcher_digest: monitoringPromotionMatcherDigest,
    };
    const app = { candidateRuleIds: ["fundraising_form_change"] };
    expect(
      enforceRollbackIdentityRestore(report, {
        app,
        preActivation,
        ruleId: "fundraising_form_change",
      }).status,
    ).toBe("passed");
    expect(
      enforceRollbackIdentityRestore(
        { ...report, app_suppression_policy_hash: "different" },
        { app, preActivation, ruleId: "fundraising_form_change" },
      ).status,
    ).toBe("failed");
    expect(
      enforceRollbackIdentityRestore(report, {
        app: { candidateRuleIds: [] },
        preActivation,
        ruleId: "fundraising_form_change",
      }).status,
    ).toBe("failed");
  });

  it("uses a distinct durable identity for every activation and rollback cycle", () => {
    const cluster = {
      cluster_id: "10000000-0000-4000-8000-000000000010",
      evidence_revision: 7,
      activation_blocked_at: "2026-07-16T01:00:00.000Z",
      stage_artifacts: {
        six_pm_canary: {
          digest: "a".repeat(64),
          cohort_id: "visual-nightly:2026-07-15",
          completed_at: "2026-07-15T23:30:00.000Z",
        },
      },
    };
    expect(promotionActivationCycleId(cluster)).not.toBe(
      promotionActivationCycleId({
        ...cluster,
        stage_artifacts: {
          six_pm_canary: {
            ...cluster.stage_artifacts.six_pm_canary,
            digest: "b".repeat(64),
          },
        },
      }),
    );
    expect(promotionRollbackCycleId(cluster)).not.toBe(
      promotionRollbackCycleId({
        ...cluster,
        activation_blocked_at: "2026-07-17T01:00:00.000Z",
      }),
    );
    expect(promotionActivationCycleId(cluster)).toBe(
      promotionActivationCycleId({
        ...cluster,
        stage_artifacts: {
          six_pm_canary: {
            ...cluster.stage_artifacts.six_pm_canary,
            completed_at: "2026-07-16T00:30:00.000000+01:00",
          },
        },
      }),
    );
    expect(promotionRollbackCycleId(cluster)).toBe(
      promotionRollbackCycleId({
        ...cluster,
        activation_blocked_at: "2026-07-16T02:00:00.000000+01:00",
      }),
    );
  });

  it("preserves any independent production suppression during reversal", () => {
    const proposedOnly = {
      source_url: "https://example.org/award",
      summary: "Donation form changed.",
      suppressed_at: "2026-07-15T23:30:00.000Z",
      suppression_reason: "policy_flag_fundraising_form_change",
      suppression_source: "verified-promotion:cluster",
      change_details: { quality_flags: ["fundraising-form-change"] },
    };
    expect(
      independentProductionSuppressionDecision(
        proposedOnly,
        null,
        "fundraising_form_change",
      ),
    ).toEqual({ suppressed: false, reason: null });

    const independentlyNoisy = {
      ...proposedOnly,
      source_url: "https://example.org/jobs",
    };
    expect(
      independentProductionSuppressionDecision(
        independentlyNoisy,
        null,
        "fundraising_form_change",
      ),
    ).toEqual({ suppressed: true, reason: "source_shape_noise" });
  });

  it("wires the runner before the general sweep and captures immutable run binding", () => {
    const downstream = readFileSync(
      resolve(root, "installer", "windows", "Run-AwardPingDownstreamQueues.ps1"),
      "utf8",
    );
    const capture = readFileSync(
      resolve(root, "scripts", "capture-visual-snapshots.mjs"),
      "utf8",
    );
    const generalSweep = readFileSync(
      resolve(root, "scripts", "cleanup-change-event-noise.mjs"),
      "utf8",
    );
    expect(capture).toContain("matcher_digest: monitoringPromotionMatcherDigest");
    expect(capture).toContain("shared_award_visual_review_candidate_run_observations");
    expect(capture).toContain('.eq("candidate_signature", candidateSignature)');
    expect(capture).toContain("visual_review_candidate_observations");
    expect(capture).toContain(
      "localBaselineEvidenceCache.clear();\n  observedVisualReviewCandidateIds.clear();",
    );
    expect(downstream).toContain("process-monitoring-feedback-promotions.mjs");
    expect(downstream.indexOf('-Name "visual-review-batch"')).toBeLessThan(
      downstream.indexOf('-Name "verified-feedback-promotions"'),
    );
    expect(downstream.indexOf('-Name "verified-feedback-promotions"')).toBeLessThan(
      downstream.indexOf('-Name "change-event-suppression-sweep"'),
    );
    expect(generalSweep).toContain(
      '"list_unresolved_monitoring_feedback_promotion_rule_ids"',
    );
    expect(generalSweep).toContain(
      "excludedPolicyRuleIds: excludedPromotionRuleIds",
    );
    expect(generalSweep).toContain(
      "effectiveSweepPolicyHash = monitoringPolicySweepEffectivePolicyHash",
    );
    expect(generalSweep).toContain(
      "changeEventSuppressionPolicyIdentity.hash,\n    excludedPromotionRuleIds",
    );
    expect(generalSweep).toContain(
      "Load unresolved verified-promotion rules failed closed",
    );
    const runner = readFileSync(
      resolve(root, "scripts", "process-monitoring-feedback-promotions.mjs"),
      "utf8",
    );
    expect(runner).toContain('"list_monitoring_feedback_promotion_worker_queue"');
    expect(runner).toContain("rule_drafted.legitimate_negative_event_ids");
    expect(runner).toContain("const positives = uniqueEventsById(");
    expect(runner).toContain("legitimate_negative_event_ids: negatives.bound_event_ids");
    expect(runner).not.toContain("loadRetainedLegitimateNegativeFixture");
    expect(runner).toContain("shared_award_visual_review_candidate_run_observations");
    expect(runner.indexOf("if (!cohort.completed)")).toBeLessThan(
      runner.indexOf("const binding = await loadCanaryEventsForRuns"),
    );
    expect(runner.indexOf("activationAttestation.status !== \"passed\"")).toBeLessThan(
      runner.indexOf("sweep = await runTargetedPromotionSweep"),
    );
    expect(runner).toContain("Durable monitoring_policy_sweep_state storage is unavailable");
    expect(runner).toContain(
      '["blocked_late_evidence", "rollback_required"].includes',
    );
    expect(runner).toContain('"apply_monitoring_feedback_promotion_sweep_event"');
    expect(runner).toContain("if (isChangeEventSuppressed(event)) continue;");
    expect(runner).toContain(
      '"mark_monitoring_feedback_promotion_rollback_required"',
    );
    expect(runner).toContain(
      '"record_monitoring_feedback_promotion_worker_failure"',
    );
    expect(
      runner.indexOf("durableFailure = await recordPromotionWorkerFailure"),
    ).toBeLessThan(
      runner.indexOf(
        "if (promotionExceptionRequiresRollback(currentCluster))",
      ),
    );
    expect(runner).toContain(
      '"revert_monitoring_feedback_promotion_sweep_events"',
    );
    expect(runner).toContain(
      '"rollback_monitoring_feedback_promotion_activation"',
    );
    expect(runner).toContain("ignoreExistingSuppression: true");
    expect(runner).toContain("promotionRollbackCycleId(cluster)");
    expect(runner).toContain("mutable_target_restart: true");
    expect(runner).not.toContain('.update({\n        suppressed_at:');
  });
});

function targetedSweepFixture({
  times = [
    "2026-07-15T20:00:01.000000Z",
    "2026-07-15T20:00:02.000000Z",
    "2026-07-15T20:00:03.000000Z",
    "2026-07-15T20:00:04.000000Z",
  ],
} = {}) {
  const events = [
    targetedSweepEvent(
      "10000000-0000-4000-8000-000000000031",
      "2020-01-01T00:00:00.000Z",
    ),
    targetedSweepEvent(
      "10000000-0000-4000-8000-000000000032",
      "2021-01-01T00:00:00.000Z",
    ),
  ];
  let state = null;
  let rpcIndex = 0;
  const checkpointNotBefore = [];
  const checkpointArgs = [];

  const supabase = {
    from(table) {
      if (table === "monitoring_policy_sweep_state") {
        const builder = {
          select() {
            return builder;
          },
          eq() {
            return builder;
          },
          maybeSingle() {
            return Promise.resolve({ data: state, error: null });
          },
        };
        return builder;
      }
      if (table !== "shared_award_change_events") {
        throw new Error(`Unexpected targeted sweep table ${table}.`);
      }
      let head = false;
      let limit = events.length;
      const builder = {
        select(_columns, options = {}) {
          head = options.head === true;
          return builder;
        },
        not() {
          return builder;
        },
        order() {
          return builder;
        },
        limit(value) {
          limit = Number(value);
          return builder;
        },
        or() {
          return builder;
        },
        eq() {
          return builder;
        },
        then(resolveResult, rejectResult) {
          const result = head
            ? {
                data: null,
                error: null,
                count: events.filter((event) => event.suppressed_at).length,
              }
            : {
                data: events
                  .filter(
                    (event) =>
                      !state ||
                      event.detected_at > state.cursor_detected_at ||
                      (event.detected_at === state.cursor_detected_at &&
                        event.id > state.cursor_event_id),
                  )
                  .slice(0, limit),
                error: null,
              };
          return Promise.resolve(result).then(resolveResult, rejectResult);
        },
      };
      return builder;
    },
    rpc(name, args) {
      const occurredAt = times[rpcIndex];
      rpcIndex += 1;
      if (name === "apply_monitoring_feedback_promotion_sweep_event") {
        const event = events.find((candidate) => candidate.id === args.p_event_id);
        event.suppressed_at = occurredAt;
        return Promise.resolve({
          data: [
            {
              sweep_event_id: event.id,
              applied: true,
              already_applied: false,
              mutation_at: occurredAt,
              current_evidence_revision: args.p_expected_evidence_revision,
              current_activation_status: "armed",
            },
          ],
          error: null,
        });
      }
      if (name === "checkpoint_monitoring_feedback_promotion_sweep") {
        checkpointArgs.push({ ...args });
        checkpointNotBefore.push(args.p_not_before);
        const previousCheckpointAt = state?.updated_at || null;
        const lastMutationAt = events
          .map((event) => event.suppressed_at)
          .filter(Boolean)
          .sort()
          .at(-1) || null;
        const cycleStartedAt = state?.cycle_started_at || occurredAt;
        state = {
          sweep_key: args.p_sweep_key,
          policy_hash: args.p_state_policy_hash,
          cursor_detected_at: args.p_cursor_detected_at,
          cursor_event_id: args.p_cursor_event_id,
          scanned_count: args.p_scanned_count,
          cycle_started_at: cycleStartedAt,
          updated_at: occurredAt,
        };
        return Promise.resolve({
          data: [
            {
              checkpoint_sweep_key: args.p_sweep_key,
              checkpoint_at: occurredAt,
              checkpoint_cursor_detected_at: args.p_cursor_detected_at,
              checkpoint_cursor_event_id: args.p_cursor_event_id,
              checkpoint_scanned_count: args.p_scanned_count,
              checkpoint_cycle_started_at: cycleStartedAt,
              checkpoint_previous_at: previousCheckpointAt,
              checkpoint_last_mutation_at: lastMutationAt,
              current_evidence_revision: args.p_expected_evidence_revision,
              current_activation_status: "armed",
            },
          ],
          error: null,
        });
      }
      throw new Error(`Unexpected targeted sweep RPC ${name}.`);
    },
  };

  return { supabase, events, times, checkpointNotBefore, checkpointArgs };
}

function targetedSweepEvent(id, detectedAt) {
  return {
    id,
    detected_at: detectedAt,
    shared_award_source_id: null,
    source_url: "https://example.org/award",
    source_title: "Award",
    source_page_type: "award",
    summary: "A donation widget changed.",
    suppressed_at: null,
    suppression_reason: null,
    change_details: {
      quality_flags: ["fundraising_form_change"],
      structured_diff: {},
    },
  };
}

function hashes() {
  return {
    policy_hash: "full",
    batch_policy_hash: "batch",
    suppression_policy_hash: "suppression",
  };
}

function legitimateUpdate(id) {
  return {
    id,
    summary: "The application deadline changed from March 1 to March 15.",
    detected_at: "2026-07-15T18:00:00.000Z",
    suppressed_at: null,
    change_details: {
      is_alert_worthy: true,
      generation_status: "generated",
      structured_diff: {
        added_text: ["Application deadline: March 15"],
        removed_text: ["Application deadline: March 1"],
      },
    },
  };
}

function scheduledRun({
  id = "run-0",
  shard = 0,
  monitoringDate = "2026-07-15",
  startedAt = `2026-07-15T23:0${shard}:00.000Z`,
  revision = "commit-a",
  matcherDigest = monitoringPromotionMatcherDigest,
} = {}) {
  return {
    id,
    worker_name: `local-visual-snapshot-worker-shard-${shard + 1}-of-3`,
    status: "succeeded",
    failed_count: 0,
    started_at: startedAt,
    finished_at: new Date(new Date(startedAt).getTime() + 60_000).toISOString(),
    metadata: {
      kind: "visual_snapshot",
      worker_revision: revision,
      matcher_digest: matcherDigest,
      run_identity: {
        trigger: "scheduled",
        cohort_id: `visual-nightly:${monitoringDate}`,
        monitoring_date: monitoringDate,
        shard_count: 3,
        shard_index: shard,
      },
      monitoring_policy_bundle: { hash: "full" },
      monitoring_policy: { hash: "batch" },
      suppression_policy: { hash: "suppression" },
      counts: {
        visual_review_candidate_observations: 0,
        visual_review_candidate_observation_failures: 0,
        text_only_candidate_enqueued: 0,
        visual_only_candidate_enqueued: 0,
        section_change_candidates_enqueued: 0,
      },
    },
  };
}
