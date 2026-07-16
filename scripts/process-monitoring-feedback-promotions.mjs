#!/usr/bin/env node
import crypto from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  isGloballyActiveMonitoringPolicyRule,
  monitoringPromotionMatcherIdentity,
} from "./lib/award-monitoring-policy.mjs";
import {
  changeEventMatchesMonitoringPolicyRule,
  changeEventSuppressionDecision,
  isChangeEventSuppressed,
} from "./lib/change-event-suppression.mjs";
import { monitoringPromotionMatcherBundleHash } from "./lib/monitoring-promotion-matcher-bundle.mjs";
import {
  isMissingMonitoringPolicySweepStateError,
  monitoringPolicySweepCursorAfterRows,
  monitoringPolicySweepKeysetFilter,
  monitoringPolicySweepStart,
  monitoringPolicySweepStateTable,
} from "./lib/change-event-sweep-state.mjs";
import {
  buildMonitoringPromotionCanaryReport,
  buildMonitoringPromotionHashAttestation,
  buildMonitoringPromotionRegressionReport,
  buildMonitoringPromotionRetroactiveSweepReport,
  buildMonitoringPromotionShadowReport,
  canonicalPreciseRfc3339 as canonicalEvidenceTimestamp,
  comparePreciseRfc3339 as compareEvidenceTimestamps,
  currentMonitoringPromotionWorkerIdentity,
  sealPromotionReport,
} from "./lib/monitoring-feedback-promotion-verification.mjs";
import { createSupabaseServiceClient } from "./supabase-service-client.mjs";

const root = resolve(import.meta.dirname, "..");
const defaultActorId = "eb5e708d-2b08-5b5f-8670-e6e56a9f3f63";
const defaultActorEmail = "verified-promotions@worker.awardping.local";

export const monitoringPromotionMatcherDigest =
  monitoringPromotionMatcherBundleHash;

if (isDirectExecution()) {
  const args = parseArgs(process.argv.slice(2));
  const envPath = resolve(root, cleanText(args.env) || ".env.local");
  const env = { ...loadEnvFile(envPath), ...process.env };
  const config = promotionRunnerConfig(args, env);

  if (!config.supabaseUrl || !config.serviceRoleKey) {
    console.error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
    process.exit(1);
  }
  if (!config.appUrl) {
    console.error("NEXT_PUBLIC_APP_URL is required for live app/worker promotion attestation.");
    process.exit(1);
  }

  const supabase = createSupabaseServiceClient(
    config.supabaseUrl,
    config.serviceRoleKey,
  );
  runMonitoringFeedbackPromotionWorker({ supabase, config, env })
    .then((report) => {
      console.log(JSON.stringify(report, null, 2));
      process.exit(report.failed > 0 ? 1 : 0);
    })
    .catch((error) => {
      console.error(
        `MONITORING_FEEDBACK_PROMOTION_FATAL ${error?.message || String(error)}`,
      );
      process.exit(1);
    });
}

export async function runMonitoringFeedbackPromotionWorker({
  supabase,
  config,
  env = process.env,
  fetchImpl = fetch,
}) {
  const startedAt = new Date().toISOString();
  const report = {
    schema_version: "monitoring-feedback-promotion-worker-v1",
    started_at: startedAt,
    finished_at: null,
    matcher_digest: monitoringPromotionMatcherDigest,
    loaded: 0,
    advanced: 0,
    waiting: 0,
    failed: 0,
    outcomes: [],
  };
  const clusters = await listPromotionWorkerQueue(supabase, config.clusterLimit);
  report.loaded = clusters.length;

  for (const listedCluster of clusters) {
    let cluster = null;
    try {
      cluster = await getPromotionCluster(supabase, listedCluster.cluster_id);
      const outcome = await processPromotionCluster({
        supabase,
        cluster,
        config,
        env,
        fetchImpl,
      });
      report.outcomes.push(outcome);
      if (outcome.status === "advanced") report.advanced += 1;
      else if (outcome.status === "failed") report.failed += 1;
      else report.waiting += 1;
    } catch (error) {
      const reason = cleanText(error?.message || String(error)).slice(0, 2000);
      let currentCluster = cluster;
      try {
        currentCluster = await getPromotionCluster(
          supabase,
          listedCluster.cluster_id,
        );
      } catch {
        // Preserve the originally loaded guarded state when a diagnostic
        // refresh is unavailable. The RPC still rejects a stale revision.
      }
      let durableFailure = null;
      let durableFailureError = null;
      let rollbackMarkerError = null;
      if (currentCluster) {
        try {
          durableFailure = await recordPromotionWorkerFailure({
            supabase,
            cluster: currentCluster,
            config,
            reason,
          });
        } catch (recordError) {
          durableFailureError = cleanText(
            recordError?.message || String(recordError),
          );
        }
        if (promotionExceptionRequiresRollback(currentCluster)) {
          const activationStatus = cleanText(
            currentCluster.activation_status,
          );
          if (["armed", "sweep_completed"].includes(activationStatus)) {
            try {
              await markPromotionRollbackRequired({
                supabase,
                cluster: currentCluster,
                config,
                reason: "retroactive_sweep_failed",
                evidence: postActivationFailureEvidence({
                  cluster: currentCluster,
                  ruleId: cleanText(currentCluster.proposed_rule_id),
                  failureReason: "retroactive_sweep_failed",
                  message: reason,
                }),
                note:
                  "Unexpected post-activation worker failure; require a verified inactive rollback.",
              });
            } catch (markerError) {
              rollbackMarkerError = cleanText(
                markerError?.message || String(markerError),
              );
            }
          }
        }
      }
      report.failed += 1;
      report.outcomes.push({
        cluster_id: listedCluster.cluster_id,
        cluster_key: listedCluster.cluster_key,
        stage: currentCluster?.current_stage || listedCluster.current_stage,
        requested_stage: durableFailure?.failed_stage || null,
        transition_id: durableFailure?.failure_transition_id || null,
        activation_status:
          currentCluster?.activation_status || listedCluster.activation_status,
        status: "failed",
        reason,
        safe_action:
          durableFailure?.safe_action ||
          "Keep the rule inactive, inspect this cluster in Admin workflows, then retry the worker after the evidence or deployment is repaired.",
        durable_failure_recorded: Boolean(durableFailure),
        durable_failure_error: durableFailureError,
        rollback_marker_error: rollbackMarkerError,
      });
    }
  }

  report.finished_at = new Date().toISOString();
  return report;
}

async function processPromotionCluster({
  supabase,
  cluster,
  config,
  env,
  fetchImpl,
}) {
  const common = {
    cluster_id: cluster.cluster_id,
    cluster_key: cluster.cluster_key,
    stage: cluster.current_stage,
  };
  const rollbackRequired = ["blocked_late_evidence", "rollback_required"].includes(
    cleanText(cluster.activation_status),
  );
  if (
    !rollbackRequired &&
    ![
      "rule_drafted",
      "historical_shadow_test",
      "regression_tests_pass",
      "app_worker_hashes_match",
      "six_pm_canary",
      "retroactive_sweep",
    ].includes(cluster.current_stage)
  ) {
    return {
      ...common,
      status: "waiting",
      reason:
        cluster.current_stage === "retroactive_sweep"
          ? "The verified retroactive sweep is complete and awaits final operator resolution."
          : "This stage requires an operator action before automation can continue.",
    };
  }

  const ruleId = cleanText(cluster.proposed_rule_id);
  const draft = objectValue(objectValue(cluster.stage_artifacts).rule_drafted);
  const draftHash = cleanText(draft.draft_hash);
  const draftMatcherDigest = cleanText(
    objectValue(draft.rule).matcher_digest || draft.matcher_digest,
  );
  if (!ruleId || !isSha256(draftHash) || !isSha256(draftMatcherDigest)) {
    throw new Error("The immutable rule draft or matcher digest is missing.");
  }
  if (rollbackRequired) {
    return processBlockedPromotionRollback({
      supabase,
      cluster,
      config,
      env,
      fetchImpl,
      ruleId,
      draftHash,
      draftMatcherDigest,
    });
  }

  if (cluster.current_stage === "retroactive_sweep") {
    if (isGloballyActiveMonitoringPolicyRule(ruleId)) {
      const attestation = await recordPostSweepResolutionWorkerAttestation({
        supabase,
        cluster,
        config,
        env,
        fetchImpl,
      });
      return {
        ...common,
        status: "waiting",
        reason:
          "The verified retroactive sweep is complete. The normal hourly, zero-charge worker attestation is durable; final operator resolution is now safe.",
        worker_run_id: attestation.worker_run_id,
      };
    }
    const evidence = operatorDeactivationEvidence(cluster, ruleId, {
      sweep_started: true,
      attributable_suppression_count: Number(
        objectValue(objectValue(cluster.stage_artifacts).retroactive_sweep)
          .suppressed_count || 0,
      ),
    });
    return markPromotionRollbackRequired({
      supabase,
      cluster,
      config,
      reason: "operator_deactivated",
      evidence,
      note:
        "The activated rule was disabled after its verified sweep and must be safely reversed before the cluster can restart.",
    });
  }

  if (cluster.current_stage === "rule_drafted") {
    const evidenceRows = await loadClusterEvidence(supabase, cluster.cluster_id);
    const history = await loadChangeEventHistory(supabase, {
      pageSize: config.historyPageSize,
      limit: config.historyLimit,
    });
    const events = mergeClusterFallbackEvents(history.rows, evidenceRows);
    const sources = await loadSourcesForEvents(supabase, events);
    const stableNow = latestEvidenceTimestamp([
      cluster.updated_at,
      ...events.map((event) => event.detected_at),
    ]);
    let gateReport = buildMonitoringPromotionShadowReport({
      clusterKey: cluster.cluster_key,
      ruleId,
      draftHash,
      feedbackEventIds: evidenceRows.map((row) => objectValue(row.event_payload).id),
      events,
      sourcesById: sources,
      historyComplete: history.complete,
      now: stableNow,
    });
    gateReport = bindMatcherDigest(gateReport, draftMatcherDigest, {
      runtimeDigest: monitoringPromotionMatcherDigest,
      mismatchSummary:
        "The executable worker matcher differs from the immutable drafted matcher.",
    });
    gateReport = stabilizePromotionReport(gateReport);
    return submitGateReport({
      supabase,
      cluster,
      toStage: "historical_shadow_test",
      evidence: gateReport,
      ruleId,
      config,
      note: history.complete
        ? "Automatic complete historical shadow test."
        : `Historical shadow test stopped at the configured ${config.historyLimit}-event safety cap.`,
    });
  }

  if (cluster.current_stage === "historical_shadow_test") {
    const evidenceRows = await loadClusterEvidence(supabase, cluster.cluster_id);
    const positives = uniqueEventsById(
      evidenceRows.map((row) => objectValue(row.event_payload)),
    );
    const negatives = await loadBoundLegitimateNegativeFixtures({
      supabase,
      boundEventIds: draft.legitimate_negative_event_ids,
      positiveEventIds: positives.map((event) => event.id),
    });
    const fixtures = [...positives, ...negatives.events];
    const sources = await loadSourcesForEvents(supabase, fixtures);
    let gateReport = buildMonitoringPromotionRegressionReport({
      clusterKey: cluster.cluster_key,
      ruleId,
      draftHash,
      positiveFixtures: positives,
      negativeFixtures: negatives.events,
      sourcesById: sources,
      now: latestEvidenceTimestamp([
        cluster.updated_at,
        ...fixtures.map((event) => event.detected_at),
      ]),
    });
    const matcherFailures = (gateReport.fixture_results || []).filter(
      (fixture) =>
        (fixture.expected === "suppressed" && fixture.matched !== true) ||
        (fixture.expected === "visible" && fixture.matched === true),
    );
    const bindingFailures = negatives.failures.map((failure) => ({
      fixture_id: failure.event_id,
      expected: "visible",
      matched: null,
      binding_failure_code: failure.code,
      failure_reason: failure.message,
    }));
    gateReport = sealPromotionReport({
      ...stripReportDigest(gateReport),
      legitimate_negative_event_ids: negatives.bound_event_ids,
      negative_fixture_source: "rule_drafted.legitimate_negative_event_ids",
      fixture_binding_failures: negatives.failures,
      fixture_failures: [...matcherFailures, ...bindingFailures],
      failure_count: Number(gateReport.failure_count || 0) + negatives.failures.length,
      status: negatives.failures.length > 0 ? "failed" : gateReport.status,
      summary:
        negatives.failures.length > 0
          ? negatives.failures.map((failure) => failure.message).join(" ")
          : gateReport.summary,
    });
    gateReport = bindMatcherDigest(gateReport, draftMatcherDigest, {
      runtimeDigest: monitoringPromotionMatcherDigest,
      mismatchSummary:
        "Regression tests ran a different executable matcher than the reviewed draft.",
    });
    gateReport = stabilizePromotionReport(gateReport);
    return submitGateReport({
      supabase,
      cluster,
      toStage: "regression_tests_pass",
      evidence: gateReport,
      ruleId,
      config,
      note: "Automatic promotion-bound positive and operator-confirmed negative regression test.",
    });
  }

  if (cluster.current_stage === "regression_tests_pass") {
    const regression = objectValue(
      objectValue(cluster.stage_artifacts).regression_tests_pass,
    );
    const regressionCompletedAt = cleanText(regression.completed_at);
    if (!validTimestamp(regressionCompletedAt)) {
      throw new Error(
        "The accepted regression report has no concrete worker-attestation not-before timestamp.",
      );
    }
    const app = await fetchLiveAppIdentity(config.appUrl, fetchImpl, config.fetchTimeoutMs);
    const workerBase = currentMonitoringPromotionWorkerIdentity(env);
    const worker = {
      ...workerBase,
      matcher_identity:
        cleanText(workerBase.matcher_identity) || monitoringPromotionMatcherIdentity.id,
      matcher_version:
        cleanText(workerBase.matcher_version) || monitoringPromotionMatcherIdentity.version,
      matcher_hash: monitoringPromotionMatcherDigest,
    };
    const runs = await loadRecentVisualWorkerRuns(supabase, config.workerRunLookback);
    const eligibleRuns = runs.filter(
      (run) =>
        workerRunCompletedAfterGate(run, regressionCompletedAt) &&
        workerRunMatchesIdentity(run, worker),
    );
    let gateReport = buildMonitoringPromotionHashAttestation({
      clusterKey: cluster.cluster_key,
      ruleId,
      draftHash,
      app,
      worker,
      workerRunIds: eligibleRuns.map((run) => run.id),
      expectedRuleActive: false,
      now: latestEvidenceTimestamp([
        cluster.updated_at,
        ...eligibleRuns.map((run) => run.finished_at || run.started_at),
      ]),
    });
    gateReport = bindHashMatcherEvidence(gateReport, {
      draftMatcherDigest,
      appMatcherDigest: app.matcher_hash,
      workerMatcherDigest: monitoringPromotionMatcherDigest,
      workerRuns: eligibleRuns,
    });
    gateReport = enforceHashAttestationPrerequisites(gateReport, {
      app,
      worker,
      eligibleRuns,
    });
    gateReport = stabilizePromotionReport(gateReport);
    return submitGateReport({
      supabase,
      cluster,
      toStage: "app_worker_hashes_match",
      evidence: gateReport,
      ruleId,
      config,
      note: "Automatic live app and installed-worker identity attestation.",
    });
  }

  if (cluster.current_stage === "app_worker_hashes_match") {
    const attestation = objectValue(objectValue(cluster.stage_artifacts).app_worker_hashes_match);
    const notBefore = cleanText(attestation.completed_at);
    if (!validTimestamp(notBefore)) {
      throw new Error("The accepted app/worker attestation has no concrete canary not-before timestamp.");
    }
    const runs = await loadRecentVisualWorkerRuns(supabase, config.canaryRunLookback);
    const cohort = selectCanaryCohort(runs, {
      notBefore,
      expectedRevision: attestation.worker_revision,
      expectedHashes: {
        policy_hash: attestation.worker_policy_hash,
        batch_policy_hash: attestation.worker_batch_policy_hash,
        suppression_policy_hash: attestation.worker_suppression_policy_hash,
      },
      expectedMatcherDigest: draftMatcherDigest,
    });
    if (!cohort) {
      return {
        ...common,
        status: "waiting",
        reason: "Waiting for a later scheduled three-shard 6 PM cohort; no extra capture or paid API call was started.",
      };
    }
    if (!cohort.completed) {
      return {
        ...common,
        status: "waiting",
        reason: "Waiting for every shard in the selected 6 PM cohort to finish; no failure was recorded while capture work was still running.",
      };
    }
    const binding = await loadCanaryEventsForRuns(supabase, cohort.runs);
    const candidateReadiness = evaluateCanaryCandidateReadiness(binding);
    if (candidateReadiness.status === "waiting") {
      return {
        ...common,
        status: "waiting",
        reason: `Waiting for ${candidateReadiness.in_flight_count} exact-cohort visual review ${candidateReadiness.in_flight_count === 1 ? "candidate" : "candidates"} to reach published or rejected.`,
      };
    }
    const sources = await loadSourcesForEvents(supabase, binding.events);
    let gateReport = buildMonitoringPromotionCanaryReport({
      clusterKey: cluster.cluster_key,
      ruleId,
      draftHash,
      monitoringDate: cohort.monitoringDate,
      notBefore,
      scheduledRuns: cohort.runs,
      expectedHashes: {
        policy_hash: attestation.worker_policy_hash,
        batch_policy_hash: attestation.worker_batch_policy_hash,
        suppression_policy_hash: attestation.worker_suppression_policy_hash,
      },
      events: binding.events,
      sourcesById: sources,
      now: latestEvidenceTimestamp(
        cohort.runs.map((run) => run.finished_at || run.started_at),
      ),
    });
    gateReport = bindMatcherDigest(gateReport, draftMatcherDigest, {
      runtimeDigest: monitoringPromotionMatcherDigest,
      mismatchSummary: "The 6 PM canary used a different matcher than the reviewed draft.",
    });
    gateReport = sealPromotionReport({
      ...stripReportDigest(gateReport),
      cohort_id: cohort.cohortId,
      not_before: notBefore,
      bound_candidate_count: binding.candidates.length,
      expected_candidate_count: binding.expectedCandidateCount,
      expected_enqueued_count: binding.expectedEnqueuedCount,
      bound_event_count: binding.events.length,
      event_run_bindings: binding.bindings,
      candidate_status_counts: candidateReadiness.status_counts,
      candidate_terminal_failures: candidateReadiness.failures,
      capture_coverage_safe: cohort.captureCoverageSafe,
      capture_coverage_failures: cohort.runs
        .filter((run) => !workerRunHasSafeCanaryCoverage(run))
        .map((run) => ({
          run_id: run.id,
          failed_count: nonNegativeInt(run.failed_count),
          visual_review_candidate_observation_failures: nonNegativeInt(
            objectValue(objectValue(run.metadata).counts)
              .visual_review_candidate_observation_failures,
          ),
        })),
      resolved_superseded_candidates:
        candidateReadiness.resolved_superseded_candidates,
      status:
        cohort.exactIdentity &&
        cohort.captureCoverageSafe &&
        candidateReadiness.status === "ready"
          ? gateReport.status
          : "failed",
      summary: !cohort.exactIdentity
        ? "At least one selected 6 PM shard has a different revision, policy hash, or matcher digest than the pre-canary attestation."
        : !cohort.captureCoverageSafe
          ? "At least one selected 6 PM shard reported capture failures or an incomplete candidate/run observation ledger."
        : candidateReadiness.status === "failed"
          ? "An exact-cohort candidate failed, had an unsafe supersession, or was marked published without its bound event; the canary remains blocked."
          : gateReport.summary,
    });
    gateReport = stabilizePromotionReport(gateReport);
    return submitGateReport({
      supabase,
      cluster,
      toStage: "six_pm_canary",
      evidence: gateReport,
      ruleId,
      config,
      note: "Automatic observation of the regular scheduled 6 PM cohort; no additional paid call was created.",
    });
  }

  const canary = objectValue(objectValue(cluster.stage_artifacts).six_pm_canary);
  if (!isGloballyActiveMonitoringPolicyRule(ruleId)) {
    const activationProgress = await promotionActivationSweepProgress({
      supabase,
      cluster,
      ruleId,
    });
    if (activationProgress.started) {
      return markPromotionRollbackRequired({
        supabase,
        cluster,
        config,
        reason: "operator_deactivated",
        evidence: operatorDeactivationEvidence(
          cluster,
          ruleId,
          activationProgress,
        ),
        note:
          "The activated rule was disabled after its bounded sweep began; reverse attributable suppressions before revalidation.",
      });
    }
    return {
      ...common,
      status: "waiting",
      reason: "The canary passed. Waiting for the exact immutable rule to be globally activated.",
    };
  }
  if (cleanText(cluster.activation_status) !== "armed") {
    return {
      ...common,
      status: "failed",
      reason:
        "The passing canary is not durably armed for mutation; no retroactive event was changed.",
      safe_action:
        "Keep or return the rule to inactive and inspect the cluster activation marker before restarting verification.",
    };
  }
  let app;
  let worker;
  let runs;
  try {
    app = await fetchLiveAppIdentity(
      config.appUrl,
      fetchImpl,
      config.fetchTimeoutMs,
    );
    const workerBase = currentMonitoringPromotionWorkerIdentity(env);
    worker = {
      ...workerBase,
      matcher_identity:
        cleanText(workerBase.matcher_identity) ||
        monitoringPromotionMatcherIdentity.id,
      matcher_version:
        cleanText(workerBase.matcher_version) ||
        monitoringPromotionMatcherIdentity.version,
      matcher_hash: monitoringPromotionMatcherDigest,
    };
    runs = await loadRecentVisualWorkerRuns(
      supabase,
      config.workerRunLookback,
    );
  } catch (error) {
    const evidence = postActivationFailureEvidence({
      cluster,
      ruleId,
      failureReason: "activation_attestation_failed",
      message: error?.message || String(error),
    });
    return markPromotionRollbackRequired({
      supabase,
      cluster,
      config,
      reason: "activation_attestation_failed",
      evidence,
      note:
        "Post-activation identity evidence could not be loaded; require a verified inactive rollback before retrying.",
    });
  }
  const activationRuns = runs.filter(
    (run) =>
      workerRunCompletedAfterGate(run, canary.completed_at) &&
      workerRunMatchesIdentity(run, worker),
  );
  if (!activationRuns.length) {
    return {
      ...common,
      status: "waiting",
      reason: "The rule is active, but a later installed-worker run has not yet attested the activated deployment.",
    };
  }
  const preActivation = objectValue(
    objectValue(cluster.stage_artifacts).app_worker_hashes_match,
  );
  let activationAttestation = buildMonitoringPromotionHashAttestation({
    clusterKey: cluster.cluster_key,
    ruleId,
    draftHash,
    app,
    worker,
    workerRunIds: activationRuns.map((run) => run.id),
    expectedRuleActive: true,
    now: latestEvidenceTimestamp(
      activationRuns.map((run) => run.finished_at || run.started_at),
    ),
  });
  activationAttestation = bindHashMatcherEvidence(activationAttestation, {
    draftMatcherDigest,
    appMatcherDigest: app.matcher_hash,
    workerMatcherDigest: monitoringPromotionMatcherDigest,
    workerRuns: activationRuns,
  });
  activationAttestation = enforceHashAttestationPrerequisites(
    activationAttestation,
    { app, worker, eligibleRuns: activationRuns },
  );
  activationAttestation = enforceActivationIdentityChange(
    activationAttestation,
    preActivation,
  );
  activationAttestation = stabilizePromotionReport(activationAttestation);

  if (activationAttestation.status !== "passed") {
    const blockedSweep = {
      run_id: deterministicUuid(
        `retro-sweep-blocked:${cluster.cluster_id}:${activationAttestation.digest}`,
      ),
      complete: false,
      cursor_complete: false,
      cursor: { blocked_before_mutation: true },
      policy_hash: worker.suppression_policy_hash,
      scanned_count: 0,
      suppressed_count: 0,
      error_count: 1,
      completed_at: activationAttestation.completed_at,
    };
    const blockedReport = buildPromotionRetroactiveFailureEvidence({
      cluster,
      ruleId,
      draftHash,
      sweep: blockedSweep,
      app,
      worker,
      workerRunIds: activationRuns.map((run) => run.id),
      activationAttestation,
      matcherDigest: draftMatcherDigest,
      errors: [
        { event_id: null, message: activationAttestation.summary },
      ],
      summary:
        "The activated app/worker identity failed before mutation; no historical event was changed.",
      now: activationAttestation.completed_at,
    });
    return markPromotionRollbackRequired({
      supabase,
      cluster,
      evidence: blockedReport,
      config,
      reason: "activation_attestation_failed",
      note:
        "Activated identities failed before retroactive mutation; require a verified inactive rollback.",
    });
  }

  let sweep;
  try {
    sweep = await runTargetedPromotionSweep({
      supabase,
      cluster,
      ruleId,
      policyHash: worker.suppression_policy_hash,
      batchSize: config.retroBatchSize,
      apply: config.apply,
    });
  } catch (error) {
    const message = error?.message || String(error);
    const failedSweep = {
      run_id: deterministicUuid(
        `retro-sweep-failed:${cluster.cluster_id}:${canary.digest}:${message}`,
      ),
      complete: false,
      cursor_complete: false,
      cursor: { failed_before_checkpoint: true },
      policy_hash: worker.suppression_policy_hash,
      scanned_count: 0,
      suppressed_count: 0,
      error_count: 1,
      completed_at: activationAttestation.completed_at,
    };
    const failedReport = buildPromotionRetroactiveFailureEvidence({
      cluster,
      ruleId,
      draftHash,
      sweep: failedSweep,
      app,
      worker,
      workerRunIds: activationRuns.map((run) => run.id),
      activationAttestation,
      matcherDigest: draftMatcherDigest,
      errors: [{ event_id: null, message }],
      summary:
        "The activated retroactive sweep failed before a safe checkpoint and requires rollback.",
      now: activationAttestation.completed_at,
    });
    return markPromotionRollbackRequired({
      supabase,
      cluster,
      config,
      reason: "retroactive_sweep_failed",
      evidence: failedReport,
      note:
        "The activated retroactive sweep failed before a safe checkpoint; require a verified inactive rollback.",
    });
  }
  if (sweep.activation_blocked) {
    return {
      ...common,
      status: "failed",
      blocked_late_evidence: true,
      reason:
        sweep.errors[0]?.message ||
        "Late evidence or a stale evidence revision blocked the guarded retroactive sweep.",
      safe_action:
        "Return the rule to inactive, deploy the rollback, then restart the cluster from Admin so the new evidence receives shadow, regression, hash, and canary verification.",
      cursor: sweep.cursor,
    };
  }
  if (!sweep.complete && sweep.error_count === 0) {
    return {
      ...common,
      status: "waiting",
      reason: `Retroactive sweep checkpoint saved after ${sweep.scanned_count} events; the next hourly run will resume from the durable cursor.`,
      cursor: sweep.cursor,
    };
  }
  let gateReport = buildMonitoringPromotionRetroactiveSweepReport({
    clusterKey: cluster.cluster_key,
    ruleId,
    draftHash,
    sweep,
    app,
    worker,
    workerRunIds: activationRuns.map((run) => run.id),
    now: sweep.completed_at,
  });
  gateReport = sealPromotionReport({
    ...stripReportDigest(gateReport),
    activation_attestation: activationAttestation,
    matcher_digest: draftMatcherDigest,
    sweep_errors: Array.isArray(sweep.errors) ? sweep.errors : [],
  });
  gateReport = stabilizePromotionReport(gateReport);
  if (sweep.error_count > 0) {
    return markPromotionRollbackRequired({
      supabase,
      cluster,
      config,
      reason: "retroactive_sweep_failed",
      evidence: gateReport,
      note:
        "The activated retroactive sweep failed after mutation may have begun; require a verified inactive rollback.",
    });
  }
  return submitCompletedRetroactiveSweep({
    supabase,
    cluster,
    gateReport,
    ruleId,
    config,
  });
}

export async function submitCompletedRetroactiveSweep({
  supabase,
  cluster,
  gateReport,
  ruleId,
  config,
}) {
  const transition = await submitGateReport({
    supabase,
    cluster,
    toStage: "retroactive_sweep",
    evidence: gateReport,
    ruleId,
    config,
    note: "Automatic bounded, resumable, production-agreed retroactive suppression sweep.",
  });
  if (transition.status === "advanced") return transition;

  const rollbackEvidence = sealPromotionReport({
    ...stripReportDigest(gateReport),
    status: "failed",
    completed_sweep_digest: gateReport.digest,
    transition_failure_reason: transition.reason,
    summary:
      "The retroactive sweep mutated retained history, but its final guarded transition was rejected; rollback is required.",
  });
  return markPromotionRollbackRequired({
    supabase,
    cluster,
    config,
    reason: "retroactive_sweep_failed",
    evidence: rollbackEvidence,
    note:
      "The final retroactive-sweep transition was rejected after mutation; require a verified inactive rollback.",
  });
}

export async function recordPostSweepResolutionWorkerAttestation({
  supabase,
  cluster,
  config,
  env = process.env,
  fetchImpl = fetch,
}) {
  const sweep = objectValue(objectValue(cluster.stage_artifacts).retroactive_sweep);
  const sweepCompletedAt = cleanText(sweep.completed_at);
  if (!validTimestamp(sweepCompletedAt)) {
    throw new Error(
      "The completed retroactive sweep has no immutable attestation boundary.",
    );
  }

  const app = await fetchLiveAppIdentity(
    config.appUrl,
    fetchImpl,
    config.fetchTimeoutMs,
  );
  const workerBase = currentMonitoringPromotionWorkerIdentity(env);
  const worker = {
    ...workerBase,
    matcher_identity:
      cleanText(workerBase.matcher_identity) || monitoringPromotionMatcherIdentity.id,
    matcher_version:
      cleanText(workerBase.matcher_version) || monitoringPromotionMatcherIdentity.version,
    matcher_hash: monitoringPromotionMatcherDigest,
  };
  const identityMatches = [
    [app.revision, worker.revision],
    [app.policy_hash, worker.policy_hash],
    [app.batch_policy_hash, worker.batch_policy_hash],
    [app.suppression_policy_hash, worker.suppression_policy_hash],
    [app.matcher_hash, worker.matcher_hash],
  ].every(
    ([appValue, workerValue]) =>
      Boolean(cleanText(appValue)) && cleanText(appValue) === cleanText(workerValue),
  );
  if (!identityMatches) {
    throw new Error(
      "The post-sweep app and hourly worker revision, policy, or matcher identity drifted.",
    );
  }
  const activation = objectValue(sweep.activation_attestation);
  const immutableActivationMatches = [
    [app.revision, worker.revision, activation.app_revision, activation.worker_revision],
    [
      app.policy_hash,
      worker.policy_hash,
      activation.app_policy_hash,
      activation.worker_policy_hash,
    ],
    [
      app.batch_policy_hash,
      worker.batch_policy_hash,
      activation.app_batch_policy_hash,
      activation.worker_batch_policy_hash,
    ],
    [
      app.suppression_policy_hash,
      worker.suppression_policy_hash,
      activation.app_suppression_policy_hash,
      activation.worker_suppression_policy_hash,
    ],
    [
      app.matcher_hash,
      worker.matcher_hash,
      activation.app_matcher_digest,
      activation.worker_matcher_digest,
    ],
  ].every(([appValue, workerValue, immutableAppValue, immutableWorkerValue]) => {
    const current = cleanText(appValue);
    return Boolean(
      current &&
        current === cleanText(workerValue) &&
        current === cleanText(immutableAppValue) &&
        current === cleanText(immutableWorkerValue),
    );
  });
  if (!immutableActivationMatches) {
    throw new Error(
      "The post-sweep app and worker identity drifted from the immutable activated sweep.",
    );
  }

  const metadata = buildPostSweepResolutionWorkerAttestationMetadata({
    cluster,
    worker,
    sweepCompletedAt,
  });
  const { data: existingRuns, error: existingError } = await supabase.rpc(
    "find_monitoring_feedback_resolution_worker_run",
    {
      p_cluster_id: cleanText(cluster.cluster_id),
      p_expected_evidence_revision: Number(cluster.evidence_revision),
      p_not_before: sweepCompletedAt,
      p_worker_revision: cleanText(worker.revision),
      p_worker_policy_hash: cleanText(worker.policy_hash),
      p_worker_batch_policy_hash: cleanText(worker.batch_policy_hash),
      p_worker_suppression_policy_hash: cleanText(
        worker.suppression_policy_hash,
      ),
      p_worker_matcher_digest: cleanText(worker.matcher_hash),
    },
  );
  if (existingError) {
    throw new Error(
      `Find reusable post-sweep hourly worker attestation failed: ${existingError.message}`,
    );
  }
  const existingRun = Array.isArray(existingRuns) ? existingRuns[0] : null;
  if (existingRun) {
    if (
      !cleanText(existingRun.worker_run_id) ||
      !validTimestamp(existingRun.finished_at)
    ) {
      throw new Error(
        "The reusable post-sweep hourly worker attestation is malformed.",
      );
    }
    return {
      worker_run_id: existingRun.worker_run_id,
      finished_at: existingRun.finished_at,
      metadata,
      reused: true,
    };
  }

  const finishedAt = new Date(
    Math.max(Date.now(), Date.parse(sweepCompletedAt) + 1),
  ).toISOString();
  const { data, error } = await supabase
    .from("local_worker_runs")
    .insert({
      worker_name: "local-monitoring-feedback-promotion-worker",
      status: "succeeded",
      ai_provider: null,
      checked_count: 1,
      changed_count: 0,
      unchanged_count: 1,
      initial_count: 0,
      discovered_count: 0,
      failed_count: 0,
      error: null,
      metadata,
      started_at: finishedAt,
      finished_at: finishedAt,
    })
    .select("id,finished_at")
    .maybeSingle();
  if (error || !data?.id || !validTimestamp(data.finished_at)) {
    throw new Error(
      `Record post-sweep hourly worker attestation failed: ${error?.message || "no durable run returned"}`,
    );
  }
  return {
    worker_run_id: data.id,
    finished_at: data.finished_at,
    metadata,
    reused: false,
  };
}

export function buildPostSweepResolutionWorkerAttestationMetadata({
  cluster,
  worker,
  sweepCompletedAt,
}) {
  return {
    report_schema_version: 1,
    kind: "monitoring_feedback_promotion_resolution_attestation",
    attestation_source: "hourly_downstream_queue",
    api_charge: false,
    cluster_id: cleanText(cluster.cluster_id),
    evidence_revision: Number(cluster.evidence_revision),
    sweep_completed_at: cleanText(sweepCompletedAt),
    worker_revision: cleanText(worker.revision),
    monitoring_policy_bundle: {
      identity: cleanText(worker.policy_identity),
      version: cleanText(worker.policy_version),
      hash: cleanText(worker.policy_hash),
    },
    monitoring_policy: {
      identity: cleanText(worker.batch_policy_identity),
      version: cleanText(worker.batch_policy_version),
      hash: cleanText(worker.batch_policy_hash),
    },
    suppression_policy: {
      identity: cleanText(worker.suppression_policy_identity),
      version: cleanText(worker.suppression_policy_version),
      hash: cleanText(worker.suppression_policy_hash),
    },
    matcher_identity: cleanText(worker.matcher_identity),
    matcher_version: cleanText(worker.matcher_version),
    matcher_digest: cleanText(worker.matcher_hash),
  };
}

async function processBlockedPromotionRollback({
  supabase,
  cluster,
  config,
  env,
  fetchImpl,
  ruleId,
  draftHash,
  draftMatcherDigest,
}) {
  const common = {
    cluster_id: cluster.cluster_id,
    cluster_key: cluster.cluster_key,
    stage: cluster.current_stage,
    activation_status: cluster.activation_status,
  };
  if (isGloballyActiveMonitoringPolicyRule(ruleId)) {
    return {
      ...common,
      status: "waiting",
      reason:
        "Activation rollback is required, but the installed worker still has the blocked rule active.",
      safe_action:
        "Return only the drafted rule to inactive and deploy the same rollback revision to the app and worker. The hourly worker will verify and reverse its partial suppressions without a paid API call.",
    };
  }
  const blockedAt = cleanText(cluster.activation_blocked_at);
  if (!validTimestamp(blockedAt)) {
    throw new Error(
      "The durable rollback-required marker has no concrete blocked-at timestamp.",
    );
  }
  const app = await fetchLiveAppIdentity(
    config.appUrl,
    fetchImpl,
    config.fetchTimeoutMs,
  );
  const workerBase = currentMonitoringPromotionWorkerIdentity(env);
  const worker = {
    ...workerBase,
    matcher_identity:
      cleanText(workerBase.matcher_identity) || monitoringPromotionMatcherIdentity.id,
    matcher_version:
      cleanText(workerBase.matcher_version) || monitoringPromotionMatcherIdentity.version,
    matcher_hash: monitoringPromotionMatcherDigest,
  };
  const runs = await loadRecentVisualWorkerRuns(supabase, config.workerRunLookback);
  const rollbackRuns = runs.filter(
    (run) =>
      workerRunCompletedAfterGate(run, blockedAt) &&
      workerRunMatchesIdentity(run, worker),
  );
  const preActivation = objectValue(
    objectValue(cluster.stage_artifacts).app_worker_hashes_match,
  );
  let rollbackAttestation = buildMonitoringPromotionHashAttestation({
    clusterKey: cluster.cluster_key,
    ruleId,
    draftHash,
    app,
    worker,
    workerRunIds: rollbackRuns.map((run) => run.id),
    expectedRuleActive: false,
    now: latestEvidenceTimestamp(
      rollbackRuns.map((run) => run.finished_at || run.started_at),
    ),
  });
  rollbackAttestation = bindHashMatcherEvidence(rollbackAttestation, {
    draftMatcherDigest,
    appMatcherDigest: app.matcher_hash,
    workerMatcherDigest: monitoringPromotionMatcherDigest,
    workerRuns: rollbackRuns,
  });
  rollbackAttestation = enforceHashAttestationPrerequisites(
    rollbackAttestation,
    { app, worker, eligibleRuns: rollbackRuns },
  );
  rollbackAttestation = enforceRollbackIdentityRestore(rollbackAttestation, {
    app,
    preActivation,
    ruleId,
  });
  rollbackAttestation = stabilizePromotionReport(rollbackAttestation);
  if (rollbackAttestation.status !== "passed") {
    return {
      ...common,
      status: "waiting",
      reason: rollbackAttestation.summary,
      safe_action:
        "Deploy one exact inactive app/worker revision matching the pre-canary policy and matcher hashes, then let a normal worker run finish after the block time.",
    };
  }

  const reversal = await runPromotionSuppressionReversal({
    supabase,
    cluster,
    ruleId,
    policyHash: worker.suppression_policy_hash,
    batchSize: config.retroBatchSize,
  });
  if (reversal.errors.length > 0) {
    return {
      ...common,
      status: "failed",
      reason: reversal.errors[0].message,
      safe_action:
        "Keep the rule inactive. Repair the guarded reversal failure; the durable cursor will retry without another API call.",
      cursor: reversal.cursor,
    };
  }
  if (!reversal.complete) {
    return {
      ...common,
      status: "waiting",
      reason: `Rollback reversed or re-attributed ${reversal.processed_count} candidate-attributable suppressions in this bounded pass; the next hourly run resumes from its durable cursor.`,
      cursor: reversal.cursor,
    };
  }
  return submitPromotionActivationRollback({
    supabase,
    cluster,
    config,
    evidence: rollbackAttestation,
  });
}

export function enforceRollbackIdentityRestore(
  report,
  { app, preActivation, ruleId },
) {
  const appCandidateIds = new Set(
    (Array.isArray(app?.candidateRuleIds) ? app.candidateRuleIds : [])
      .map(cleanText)
      .filter(Boolean),
  );
  const restored = [
    [report.app_policy_hash, preActivation?.app_policy_hash],
    [report.app_batch_policy_hash, preActivation?.app_batch_policy_hash],
    [
      report.app_suppression_policy_hash,
      preActivation?.app_suppression_policy_hash,
    ],
    [report.app_matcher_digest, preActivation?.app_matcher_digest],
  ].every(
    ([current, previous]) =>
      Boolean(cleanText(current) && cleanText(previous)) &&
      cleanText(current) === cleanText(previous),
  );
  const passed =
    report.status === "passed" &&
    report.rule_active === false &&
    appCandidateIds.has(cleanText(ruleId)) &&
    restored;
  return sealPromotionReport({
    ...stripReportDigest(report),
    status: passed ? "passed" : "failed",
    summary: passed
      ? "The inactive app and worker exactly restore the reviewed pre-canary policy and matcher identities."
      : "Rollback is waiting for the live app and installed worker to expose the same inactive revision, pre-canary policy hashes, matcher, and a later durable worker run.",
  });
}

async function submitPromotionActivationRollback({
  supabase,
  cluster,
  config,
  evidence,
}) {
  const requestId = deterministicPromotionRequestId(
    cluster.cluster_id,
    `activation_rollback:${promotionRollbackCycleId(cluster)}`,
    evidence.digest,
  );
  const { data, error } = await supabase.rpc(
    "rollback_monitoring_feedback_promotion_activation",
    {
      p_request_id: requestId,
      p_cluster_id: cluster.cluster_id,
      p_expected_evidence_revision: cluster.evidence_revision,
      p_actor_user_id: config.actorId,
      p_actor_email: config.actorEmail,
      p_evidence: evidence,
      p_note:
        "Automatic verified inactive rollback after bounded candidate-attributable suppression reversal.",
    },
  );
  if (error) {
    throw new Error(`Record verified activation rollback failed: ${error.message}`);
  }
  const result = Array.isArray(data) ? data[0] : data;
  if (!result?.rolled_back || result.current_stage !== "similar_feedback_clustered") {
    throw new Error("Verified activation rollback returned an invalid reset result.");
  }
  return {
    cluster_id: cluster.cluster_id,
    cluster_key: cluster.cluster_key,
    stage: cluster.current_stage,
    requested_stage: "similar_feedback_clustered",
    transition_id: result.rollback_transition_id || null,
    report_digest: evidence.digest,
    status: "advanced",
    reason:
      "The inactive rollback was verified, attributable suppressions were reversed, and the cluster reset for full revalidation.",
    safe_action: null,
  };
}

async function listPromotionWorkerQueue(supabase, limit) {
  const { data, error } = await supabase.rpc(
    "list_monitoring_feedback_promotion_worker_queue",
    { p_limit: limit },
  );
  if (error) throw new Error(`List promotion worker queue failed: ${error.message}`);
  return Array.isArray(data) ? data : [];
}

async function getPromotionCluster(supabase, clusterId) {
  const { data, error } = await supabase.rpc(
    "get_monitoring_feedback_promotion_cluster",
    { p_cluster_id: clusterId },
  );
  if (error) throw new Error(`Load promotion cluster failed: ${error.message}`);
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new Error("The promotion cluster no longer exists.");
  return row;
}

async function loadClusterEvidence(supabase, clusterId) {
  const { data, error } = await supabase.rpc(
    "list_monitoring_feedback_promotion_cluster_evidence",
    { p_cluster_id: clusterId },
  );
  if (error) throw new Error(`Load cluster evidence failed: ${error.message}`);
  if (!Array.isArray(data) || !data.length) {
    throw new Error("The promotion cluster has no retained feedback/event evidence.");
  }
  return data;
}

export async function loadChangeEventHistory(
  supabase,
  { pageSize = 500, limit = 250_000 } = {},
) {
  const rows = [];
  let cursor = null;
  let complete = true;
  while (rows.length < limit) {
    const wanted = Math.min(pageSize, limit - rows.length);
    let query = supabase
      .from("shared_award_change_events")
      .select(changeEventSelect)
      .not("detected_at", "is", null)
      .order("detected_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(wanted);
    const filter = monitoringPolicySweepKeysetFilter(cursor);
    if (filter) query = query.or(filter);
    const { data, error } = await query;
    if (error) throw new Error(`Load historical change events failed: ${error.message}`);
    const page = data || [];
    rows.push(...page);
    cursor = monitoringPolicySweepCursorAfterRows(page, cursor);
    if (page.length < wanted) break;
  }
  if (rows.length >= limit) {
    let query = supabase
      .from("shared_award_change_events")
      .select("id")
      .not("detected_at", "is", null)
      .order("detected_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(1);
    const filter = monitoringPolicySweepKeysetFilter(cursor);
    if (filter) query = query.or(filter);
    const { data, error } = await query;
    if (error) throw new Error(`Check historical scan completeness failed: ${error.message}`);
    complete = !(data || []).length;
  }
  return { rows, cursor, complete };
}

async function loadBoundLegitimateNegativeFixtures({
  supabase,
  boundEventIds,
  positiveEventIds,
}) {
  const requestedIds = Array.isArray(boundEventIds)
    ? boundEventIds.map(cleanText).filter(Boolean)
    : [];
  const validIds = unique(requestedIds.filter(isUuid));
  const events = [];
  for (const idsChunk of chunks(validIds, 200)) {
    const { data, error } = await supabase
      .from("shared_award_change_events")
      .select(changeEventSelect)
      .in("id", idsChunk);
    if (error) {
      throw new Error(`Load operator-confirmed regression negatives failed: ${error.message}`);
    }
    events.push(...(data || []));
  }
  return validateBoundRegressionNegativeFixtures({
    boundEventIds,
    positiveEventIds,
    events,
  });
}

export function validateBoundRegressionNegativeFixtures({
  boundEventIds,
  positiveEventIds = [],
  events = [],
}) {
  const boundIds = Array.isArray(boundEventIds)
    ? boundEventIds.map(cleanText).filter(Boolean)
    : [];
  const failures = [];
  if (!boundIds.length) {
    failures.push({
      code: "missing-bound-negative-fixtures",
      event_id: null,
      message:
        "No operator-confirmed legitimate update IDs were bound to the immutable rule draft.",
    });
  }
  const invalidIds = unique(boundIds.filter((eventId) => !isUuid(eventId))).sort();
  for (const eventId of invalidIds) {
    failures.push({
      code: "invalid-negative-fixture-id",
      event_id: eventId,
      message: `Bound legitimate negative ID ${eventId} is not a UUID.`,
    });
  }
  const seen = new Set();
  const duplicateIds = new Set();
  for (const eventId of boundIds) {
    if (seen.has(eventId)) duplicateIds.add(eventId);
    seen.add(eventId);
  }
  for (const eventId of [...duplicateIds].sort()) {
    failures.push({
      code: "duplicate-negative-fixture-id",
      event_id: eventId,
      message: `Bound legitimate negative ID ${eventId} appears more than once.`,
    });
  }
  const positiveIds = new Set((positiveEventIds || []).map(cleanText).filter(Boolean));
  for (const eventId of unique(boundIds.filter((id) => positiveIds.has(id))).sort()) {
    failures.push({
      code: "positive-negative-fixture-overlap",
      event_id: eventId,
      message: `Event ${eventId} cannot be both a clustered false update and a legitimate negative fixture.`,
    });
  }
  const eventById = new Map((events || []).map((event) => [cleanText(event.id), event]));
  const orderedEvents = [];
  for (const eventId of unique(boundIds.filter(isUuid))) {
    const event = eventById.get(eventId);
    if (!event) {
      failures.push({
        code: "missing-negative-fixture-event",
        event_id: eventId,
        message: `Operator-confirmed legitimate event ${eventId} is no longer retained.`,
      });
      continue;
    }
    if (!isRetainedLegitimateEvent(event)) {
      failures.push({
        code: "negative-fixture-not-legitimate",
        event_id: eventId,
        message: `Operator-confirmed event ${eventId} no longer has retained legitimate-update state.`,
      });
    }
    orderedEvents.push(event);
  }
  return {
    bound_event_ids: boundIds,
    events: orderedEvents,
    failures,
  };
}

async function loadSourcesForEvents(supabase, events) {
  const ids = unique(events.map((event) => event.shared_award_source_id).filter(Boolean));
  const sources = new Map();
  for (const idsChunk of chunks(ids, 200)) {
    const { data, error } = await supabase
      .from("shared_award_sources")
      .select(sourceSelect)
      .in("id", idsChunk);
    if (error) throw new Error(`Load event sources failed: ${error.message}`);
    for (const source of data || []) sources.set(source.id, source);
  }
  return sources;
}

async function loadRecentVisualWorkerRuns(supabase, limit) {
  const { data, error } = await supabase
    .from("local_worker_runs")
    .select("id,worker_name,status,metadata,started_at,finished_at,failed_count")
    .like("worker_name", "local-visual-snapshot-worker%")
    .order("started_at", { ascending: false })
    .order("id", { ascending: true })
    .limit(limit);
  if (error) throw new Error(`Load visual worker attestations failed: ${error.message}`);
  return data || [];
}

export function workerRunMatchesIdentity(run, identity) {
  const metadata = objectValue(run?.metadata);
  return (
    cleanKey(run?.status) === "succeeded" &&
    Number(run?.failed_count) === 0 &&
    cleanText(run?.worker_name).startsWith("local-visual-snapshot-worker") &&
    cleanKey(metadata.kind) === "visual-snapshot" &&
    cleanText(metadata.worker_revision) === cleanText(identity?.revision) &&
    cleanText(objectValue(metadata.monitoring_policy_bundle).hash) === cleanText(identity?.policy_hash) &&
    cleanText(objectValue(metadata.monitoring_policy).hash) === cleanText(identity?.batch_policy_hash) &&
    cleanText(objectValue(metadata.suppression_policy).hash) === cleanText(identity?.suppression_policy_hash) &&
    cleanText(metadata.matcher_digest) === cleanText(identity?.matcher_hash)
  );
}

export function workerRunCompletedAfterGate(run, gateCompletedAt) {
  return (
    validTimestamp(gateCompletedAt) &&
    validTimestamp(run?.finished_at) &&
    compareEvidenceTimestamps(run.finished_at, gateCompletedAt) === 1
  );
}

export function selectCanaryCohort(
  runs,
  { notBefore, expectedRevision, expectedHashes, expectedMatcherDigest },
) {
  if (!validTimestamp(notBefore)) return null;
  const eligible = (runs || []).filter((run) => {
    const metadata = objectValue(run.metadata);
    const identity = objectValue(metadata.run_identity);
    return (
      cleanKey(identity.trigger) === "scheduled" &&
      Number(identity.shard_count) === 3 &&
      Number.isInteger(Number(identity.shard_index)) &&
      validTimestamp(run.started_at) &&
      compareEvidenceTimestamps(run.started_at, notBefore) === 1
    );
  });
  const byCohort = new Map();
  for (const run of eligible) {
    const identity = objectValue(objectValue(run.metadata).run_identity);
    const cohortId = cleanText(identity.cohort_id);
    const monitoringDate = cleanText(identity.monitoring_date);
    if (!cohortId || cohortId !== `visual-nightly:${monitoringDate}`) continue;
    if (!byCohort.has(cohortId)) byCohort.set(cohortId, []);
    byCohort.get(cohortId).push(run);
  }
  const cohorts = [...byCohort.entries()].sort(([left], [right]) => left.localeCompare(right));
  const candidates = [];
  for (const [cohortId, cohortRuns] of cohorts) {
    const newestByShard = new Map();
    for (const run of [...cohortRuns].sort(
      (a, b) => {
        const preciseOrder = compareEvidenceTimestamps(
          b.started_at,
          a.started_at,
        );
        return (
          (preciseOrder === null
            ? timestamp(b.started_at) - timestamp(a.started_at)
            : preciseOrder) || cleanText(a.id).localeCompare(cleanText(b.id))
        );
      },
    )) {
      const shard = Number(objectValue(objectValue(run.metadata).run_identity).shard_index);
      if (!newestByShard.has(shard)) newestByShard.set(shard, run);
    }
    if (![0, 1, 2].every((shard) => newestByShard.has(shard))) continue;
    const selected = [0, 1, 2].map((shard) => newestByShard.get(shard));
    const exactIdentity = selected.every((run) => {
      const metadata = objectValue(run.metadata);
      return (
        cleanText(metadata.worker_revision) === cleanText(expectedRevision) &&
        cleanText(metadata.matcher_digest) === cleanText(expectedMatcherDigest) &&
        cleanText(objectValue(metadata.monitoring_policy_bundle).hash) === cleanText(expectedHashes?.policy_hash) &&
        cleanText(objectValue(metadata.monitoring_policy).hash) === cleanText(expectedHashes?.batch_policy_hash) &&
        cleanText(objectValue(metadata.suppression_policy).hash) === cleanText(expectedHashes?.suppression_policy_hash)
      );
    });
    candidates.push({
      cohortId,
      monitoringDate: cohortId.slice("visual-nightly:".length),
      runs: selected,
      exactIdentity,
      completed: selected.every((run) =>
        ["succeeded", "completed"].includes(cleanKey(run.status)),
      ),
      captureCoverageSafe: selected.every(workerRunHasSafeCanaryCoverage),
    });
  }
  return (
    [...candidates]
      .reverse()
      .find((candidate) => candidate.exactIdentity && candidate.completed) ||
    candidates.at(-1) ||
    null
  );
}

export function workerRunHasSafeCanaryCoverage(run) {
  const counts = objectValue(objectValue(run?.metadata).counts);
  return (
    Number.isInteger(Number(run?.failed_count)) &&
    Number(run.failed_count) === 0 &&
    Object.prototype.hasOwnProperty.call(
      counts,
      "visual_review_candidate_observation_failures",
    ) &&
    Number.isInteger(Number(counts.visual_review_candidate_observation_failures)) &&
    Number(counts.visual_review_candidate_observation_failures) === 0
  );
}

async function loadCanaryEventsForRuns(supabase, runs) {
  const runIds = runs.map((run) => run.id);
  const { data: observationRows, error: observationError } = await supabase
    .from("shared_award_visual_review_candidate_run_observations")
    .select("run_id,candidate_id,observed_at")
    .in("run_id", runIds)
    .order("observed_at", { ascending: true })
    .order("run_id", { ascending: true })
    .order("candidate_id", { ascending: true });
  if (observationError) {
    throw new Error(
      `Load canary candidate/run observations failed: ${observationError.message}`,
    );
  }
  const observations = observationRows || [];
  const candidates = [];
  for (const candidateIds of chunks(
    unique(observations.map((observation) => observation.candidate_id)),
    200,
  )) {
    const { data, error } = await supabase
      .from("shared_award_visual_review_candidates")
      .select("id,status,rejection_reason,published_at,completed_at,worker_metadata")
      .in("id", candidateIds);
    if (error) throw new Error(`Load canary candidates failed: ${error.message}`);
    candidates.push(...(data || []));
  }
  const events = [];
  for (const candidateIds of chunks(unique(candidates.map((candidate) => candidate.id)), 200)) {
    const { data, error } = await supabase
      .from("shared_award_change_events")
      .select(changeEventSelect)
      .in("visual_review_candidate_id", candidateIds);
    if (error) throw new Error(`Load canary change events failed: ${error.message}`);
    events.push(...(data || []));
  }
  candidates.sort((left, right) => cleanText(left.id).localeCompare(cleanText(right.id)));
  events.sort(
    (left, right) => {
      const preciseOrder = compareEvidenceTimestamps(
        left.detected_at,
        right.detected_at,
      );
      return (
        (preciseOrder === null
          ? timestamp(left.detected_at) - timestamp(right.detected_at)
          : preciseOrder) || cleanText(left.id).localeCompare(cleanText(right.id))
      );
    },
  );
  return selectCanaryEventsBoundToRunIds({
    events,
    candidates,
    runIds,
    observations,
    expectedCandidateCount: expectedCanaryCandidateCount(runs),
    expectedEnqueuedCount: expectedCanaryEnqueuedCount(runs),
  });
}

export function selectCanaryEventsBoundToRunIds({
  events,
  candidates,
  runIds,
  observations = null,
  expectedCandidateCount = undefined,
  expectedEnqueuedCount = undefined,
}) {
  const allowed = new Set(runIds || []);
  const selectedObservations = (Array.isArray(observations)
    ? observations.filter((observation) => allowed.has(cleanText(observation.run_id)))
    : (candidates || []).map((candidate) => ({
        run_id: cleanText(objectValue(candidate.worker_metadata).worker_run_id),
        candidate_id: candidate.id,
      })).filter((observation) => allowed.has(observation.run_id)))
    .sort(
      (left, right) =>
        cleanText(left.run_id).localeCompare(cleanText(right.run_id)) ||
        cleanText(left.candidate_id).localeCompare(cleanText(right.candidate_id)),
    );
  const runByCandidate = new Map(
    selectedObservations.map((observation) => [
      observation.candidate_id,
      observation.run_id,
    ]),
  );
  const observedCandidateIds = new Set(
    selectedObservations.map((observation) => observation.candidate_id),
  );
  const selectedCandidates = (candidates || [])
    .filter((candidate) => observedCandidateIds.has(candidate.id))
    .sort((left, right) => cleanText(left.id).localeCompare(cleanText(right.id)));
  const selected = [];
  const bindings = [];
  for (const event of [...(events || [])].sort(
    (left, right) => {
      const preciseOrder = compareEvidenceTimestamps(
        left.detected_at,
        right.detected_at,
      );
      return (
        (preciseOrder === null
          ? timestamp(left.detected_at) - timestamp(right.detected_at)
          : preciseOrder) || cleanText(left.id).localeCompare(cleanText(right.id))
      );
    },
  )) {
    const runId = runByCandidate.get(event.visual_review_candidate_id);
    if (!runId || !allowed.has(runId)) continue;
    selected.push(event);
    bindings.push({
      event_id: event.id,
      candidate_id: event.visual_review_candidate_id,
      worker_run_id: runId,
    });
  }
  return {
    events: selected,
    candidates: selectedCandidates,
    observations: selectedObservations,
    bindings,
    expectedCandidateCount:
      expectedCandidateCount === undefined
        ? selectedObservations.length
        : expectedCandidateCount,
    expectedEnqueuedCount:
      expectedEnqueuedCount === undefined
        ? 0
        : expectedEnqueuedCount,
  };
}

export function evaluateCanaryCandidateReadiness(binding) {
  const statusCounts = {};
  const failures = [];
  const parityObservations = Array.isArray(binding?.observations)
    ? binding.observations
    : (binding?.candidates || []).map((candidate) => ({ candidate_id: candidate.id }));
  const eventCandidateIds = new Set(
    (binding?.bindings || []).map((item) => item.candidate_id).filter(Boolean),
  );
  let inFlight = 0;
  const expectedCandidateCount =
    binding?.expectedCandidateCount === null ||
    binding?.expectedCandidateCount === undefined
      ? (binding?.candidates || []).length
      : Number(binding.expectedCandidateCount);
  const expectedEnqueuedCount =
    binding?.expectedEnqueuedCount === null ||
    binding?.expectedEnqueuedCount === undefined
      ? 0
      : Number(binding.expectedEnqueuedCount);
  if (
    !Number.isInteger(expectedCandidateCount) ||
    expectedCandidateCount < 0 ||
    expectedCandidateCount !== parityObservations.length ||
    (binding?.candidates || []).length !==
      new Set(parityObservations.map((row) => row.candidate_id)).size ||
    !Number.isInteger(expectedEnqueuedCount) ||
    expectedEnqueuedCount < 0 ||
    expectedEnqueuedCount > expectedCandidateCount
  ) {
    failures.push({
      candidate_id: null,
      status: "candidate-count-mismatch",
      reason: `The three runs reported ${expectedCandidateCount} enqueued candidates, but ${
        (binding?.candidates || []).length
      } exact-run candidate rows were retained.`,
    });
  }
  for (const candidate of binding?.candidates || []) {
    const status = cleanKey(candidate.status);
    if (["pending", "submitted", "processing", "succeeded"].includes(status)) {
      incrementStatusCount(statusCounts, status);
      inFlight += 1;
      continue;
    }
    if (status === "rejected") {
      incrementStatusCount(statusCounts, status);
      continue;
    }
    if (status === "published") {
      incrementStatusCount(statusCounts, status);
      if (eventCandidateIds.has(candidate.id)) continue;
    }
    if (status === "superseded") {
      const metadata = objectValue(candidate.worker_metadata);
      const replacementId = cleanText(
        metadata.superseded_by_candidate_id || metadata.replacement_candidate_id,
      );
      incrementStatusCount(statusCounts, status);
      failures.push({
        candidate_id: candidate.id,
        status,
        replacement_candidate_id: replacementId || null,
        reason:
          "A superseded candidate cannot authorize this canary because the database intentionally validates its raw nonterminal status; wait for a clean later 6 PM cohort.",
      });
      continue;
    } else if (status !== "published") {
      incrementStatusCount(statusCounts, status || "unknown");
    }
    failures.push({
      candidate_id: candidate.id,
      status: status || "unknown",
      reason:
        status === "published"
            ? "Published candidate has no event bound to its exact cohort run ID."
            : cleanText(candidate.rejection_reason) || "Candidate did not reach a safe terminal result.",
    });
  }
  return {
    status: failures.length > 0 ? "failed" : inFlight > 0 ? "waiting" : "ready",
    in_flight_count: inFlight,
    status_counts: statusCounts,
    failures,
    resolved_superseded_candidates: [],
  };
}

function incrementStatusCount(statusCounts, status) {
  statusCounts[status] = (statusCounts[status] || 0) + 1;
}

export function expectedCanaryCandidateCount(runs) {
  if (
    !(runs || []).every((run) =>
      Object.prototype.hasOwnProperty.call(
        objectValue(objectValue(run.metadata).counts),
        "visual_review_candidate_observations",
      ),
    )
  ) return -1;
  return (runs || []).reduce((total, run) => {
    const counts = objectValue(objectValue(run.metadata).counts);
    return total + nonNegativeInt(counts.visual_review_candidate_observations);
  }, 0);
}

export function expectedCanaryEnqueuedCount(runs) {
  return (runs || []).reduce((total, run) => {
    const counts = objectValue(objectValue(run.metadata).counts);
    return (
      total +
      nonNegativeInt(counts.text_only_candidate_enqueued) +
      nonNegativeInt(counts.visual_only_candidate_enqueued) +
      nonNegativeInt(counts.section_change_candidates_enqueued)
    );
  }, 0);
}

async function fetchLiveAppIdentity(appUrl, fetchImpl, timeoutMs) {
  const url = new URL("/api/monitoring-policy-identity", ensureTrailingSlash(appUrl));
  const response = await fetchImpl(url, {
    headers: { accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`Live app identity returned HTTP ${response.status}.`);
  const body = await response.json();
  if (body?.schemaVersion !== "monitoring-promotion-app-identity-v1") {
    throw new Error("Live app identity returned an unsupported schema.");
  }
  return body;
}

export function promotionActivationCycleId(cluster) {
  const canary = objectValue(objectValue(cluster?.stage_artifacts).six_pm_canary);
  const canaryIdentity = {
    digest: cleanText(canary.digest) || null,
    cohort_id: cleanText(canary.cohort_id) || null,
    completed_at: canonicalEvidenceTimestamp(canary.completed_at),
  };
  if (
    !isSha256(canaryIdentity.digest) &&
    !(canaryIdentity.cohort_id && validTimestamp(canaryIdentity.completed_at))
  ) {
    throw new Error(
      "The accepted 6 PM canary is missing an immutable activation-cycle identity.",
    );
  }
  return sha256(
    canonicalJson({
      cluster_id: cleanText(cluster?.cluster_id),
      evidence_revision: Number(cluster?.evidence_revision),
      canary: canaryIdentity,
    }),
  );
}

function promotionForwardSweepKey(cluster) {
  return (
    `monitoring-feedback-promotion:${cleanText(cluster?.cluster_id)}:` +
    promotionActivationCycleId(cluster)
  );
}

export function promotionRollbackCycleId(cluster) {
  const blockedAt = canonicalEvidenceTimestamp(cluster?.activation_blocked_at);
  if (!blockedAt) {
    throw new Error(
      "The blocked activation is missing its immutable rollback-cycle timestamp.",
    );
  }
  return sha256(
    canonicalJson({
      cluster_id: cleanText(cluster?.cluster_id),
      evidence_revision: Number(cluster?.evidence_revision),
      activation_blocked_at: blockedAt,
    }),
  );
}

function promotionActivationGuardChanged(original, current, ruleId) {
  return (
    Number(current?.evidence_revision) !== Number(original?.evidence_revision) ||
    cleanText(current?.current_stage) !== "six_pm_canary" ||
    cleanText(current?.proposed_rule_id) !== cleanText(ruleId) ||
    !["armed"].includes(cleanText(current?.activation_status)) ||
    validTimestamp(current?.activation_blocked_at)
  );
}

async function promotionActivationSweepProgress({ supabase, cluster, ruleId }) {
  const sweepKey = promotionForwardSweepKey(cluster);
  const stateResult = await loadTargetedSweepState(supabase, sweepKey);
  if (stateResult.unavailable) {
    throw new Error(
      "Durable monitoring_policy_sweep_state storage is unavailable; operator deactivation cannot be classified safely.",
    );
  }
  const { count, error } = await supabase
    .from("shared_award_change_events")
    .select("id", { count: "exact", head: true })
    .not("suppressed_at", "is", null)
    .or(promotionAttributableSuppressionFilter(cluster.cluster_id, ruleId));
  if (error) {
    throw new Error(
      `Count candidate-attributable suppressions failed: ${error.message}`,
    );
  }
  const scannedCount = nonNegativeInt(stateResult.state?.scanned_count);
  const attributableCount = nonNegativeInt(count);
  return {
    started: scannedCount > 0 || attributableCount > 0,
    sweep_started: scannedCount > 0,
    scanned_count: scannedCount,
    attributable_suppression_count: attributableCount,
    activation_cycle_id: promotionActivationCycleId(cluster),
  };
}

export async function runTargetedPromotionSweep({
  supabase,
  cluster,
  ruleId,
  policyHash,
  batchSize,
  apply,
}) {
  const activationCycleId = promotionActivationCycleId(cluster);
  const sweepKey = promotionForwardSweepKey(cluster);
  const statePolicyHash = sha256(
    canonicalJson({
      policy_hash: policyHash,
      activation_cycle_id: activationCycleId,
      rule_id: ruleId,
      evidence_revision: Number(cluster.evidence_revision),
    }),
  );
  const stateResult = await loadTargetedSweepState(supabase, sweepKey);
  if (stateResult.unavailable) {
    throw new Error(
      "Durable monitoring_policy_sweep_state storage is unavailable; no retroactive event was changed.",
    );
  }
  const start = monitoringPolicySweepStart(
    stateResult.state,
    statePolicyHash,
  );
  let query = supabase
    .from("shared_award_change_events")
    .select(changeEventSelect)
    .not("detected_at", "is", null)
    .order("detected_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(batchSize + 1);
  const filter = monitoringPolicySweepKeysetFilter(start.cursor);
  if (filter) query = query.or(filter);
  const { data, error } = await query;
  if (error) throw new Error(`Load targeted retroactive sweep events failed: ${error.message}`);
  const loaded = data || [];
  const hasMore = loaded.length > batchSize;
  const rows = loaded.slice(0, batchSize);
  const sources = await loadSourcesForEvents(supabase, rows);
  const errors = [];
  let applied = 0;
  let activationBlocked = false;
  let lastMutationAt = null;
  for (const event of rows) {
    if (isChangeEventSuppressed(event)) continue;
    const source = event.shared_award_source_id
      ? sources.get(event.shared_award_source_id) || null
      : null;
    if (!changeEventMatchesMonitoringPolicyRule(event, source, ruleId)) continue;
    const production = changeEventSuppressionDecision(event, source, {
      mode: "retro_sweep",
    });
    if (!production.suppressed) {
      errors.push({
        event_id: event.id,
        message: "The candidate matcher and active production suppression decision disagree.",
      });
      break;
    }
    if (!apply) continue;
    try {
      const result = await applyGuardedPromotionSweepEvent({
        supabase,
        clusterId: cluster.cluster_id,
        evidenceRevision: cluster.evidence_revision,
        ruleId,
        eventId: event.id,
        suppressedAt: null,
        suppressionReason: production.reason || ruleId,
      });
      if (result.applied) {
        applied += 1;
        lastMutationAt = latestEvidenceTimestamp([
          lastMutationAt,
          result.mutation_at,
        ]);
      }
    } catch (error) {
      try {
        const currentCluster = await getPromotionCluster(
          supabase,
          cluster.cluster_id,
        );
        activationBlocked = promotionActivationGuardChanged(
          cluster,
          currentCluster,
          ruleId,
        );
      } catch {
        activationBlocked = false;
      }
      errors.push({
        event_id: event.id,
        message: error?.message || String(error),
      });
      break;
    }
  }
  const nextCursor = hasMore
    ? monitoringPolicySweepCursorAfterRows(rows, start.cursor)
    : {
        detected_at: null,
        event_id: null,
        end_of_history: true,
      };
  let cursor = start.cursor;
  let scannedCount = start.scanned_count;
  let checkpointAt = null;
  if (apply && errors.length === 0 && !stateResult.unavailable) {
    try {
      const previousBoundary = latestEvidenceTimestamp([
        stateResult.state?.updated_at,
        lastMutationAt,
      ]);
      const checkpoint = await checkpointTargetedPromotionSweep({
        supabase,
        cluster,
        ruleId,
        sweepKey,
        statePolicyHash,
        nextCursor,
        scannedCount: start.scanned_count + rows.length,
        cycleStartedAt:
          start.reset || !stateResult.state?.cycle_started_at
            ? null
            : stateResult.state.cycle_started_at,
        notBefore: validTimestamp(previousBoundary) ? previousBoundary : null,
      });
      cursor = nextCursor;
      scannedCount = start.scanned_count + rows.length;
      checkpointAt = canonicalEvidenceTimestamp(checkpoint.checkpoint_at);
      const durableLastMutationAt = latestEvidenceTimestamp([
        lastMutationAt,
        checkpoint.checkpoint_last_mutation_at,
      ]);
      lastMutationAt = validTimestamp(durableLastMutationAt)
        ? durableLastMutationAt
        : null;
    } catch (error) {
      activationBlocked = Boolean(error?.activationBlocked);
      errors.push({ event_id: null, message: error?.message || String(error) });
    }
  }
  const { count, error: countError } = await supabase
    .from("shared_award_change_events")
    .select("id", { count: "exact", head: true })
    .eq("suppression_source", `verified-promotion:${cluster.cluster_id}`);
  if (countError) errors.push({ event_id: null, message: countError.message });
  return {
    run_id: deterministicUuid(
      `retro-sweep:${cluster.cluster_id}:${activationCycleId}:${statePolicyHash}`,
    ),
    sweep_key: sweepKey,
    state_policy_hash: statePolicyHash,
    complete: apply && !hasMore && errors.length === 0,
    cursor_complete: apply && !hasMore && errors.length === 0,
    cursor,
    policy_hash: policyHash,
    scanned_count: scannedCount,
    suppressed_count: Number(count || 0),
    applied_count: applied,
    error_count: errors.length,
    activation_blocked: activationBlocked,
    errors,
    checkpoint_at: checkpointAt,
    last_mutation_at: lastMutationAt,
    completed_at:
      apply && !hasMore && errors.length === 0 ? checkpointAt : null,
  };
}

async function runPromotionSuppressionReversal({
  supabase,
  cluster,
  ruleId,
  policyHash,
  batchSize,
}) {
  const activationCycleId = promotionRollbackCycleId(cluster);
  const sweepKey =
    `monitoring-feedback-promotion-rollback:${cluster.cluster_id}:` +
    `${activationCycleId}`;
  const reversalPolicyHash = sha256(
    canonicalJson({
      policy_hash: policyHash,
      matcher_digest: monitoringPromotionMatcherDigest,
      rule_id: ruleId,
      evidence_revision: Number(cluster.evidence_revision),
      activation_cycle_id: activationCycleId,
    }),
  );
  const stateResult = await loadTargetedSweepState(supabase, sweepKey);
  if (stateResult.unavailable) {
    throw new Error(
      "Durable monitoring_policy_sweep_state storage is unavailable; no rollback suppression was changed.",
    );
  }
  const start = monitoringPolicySweepStart(
    stateResult.state,
    reversalPolicyHash,
  );
  const targetFilter = promotionAttributableSuppressionFilter(
    cluster.cluster_id,
    ruleId,
  );
  const boundedBatchSize = Math.max(1, Math.min(Number(batchSize) || 1, 500));
  const query = supabase
    .from("shared_award_change_events")
    .select(changeEventSelect)
    .order("detected_at", { ascending: true, nullsFirst: true })
    .order("id", { ascending: true })
    .limit(boundedBatchSize)
    .or(targetFilter);
  const { data, error } = await query;
  if (error) {
    throw new Error(`Load promotion rollback suppressions failed: ${error.message}`);
  }
  const loaded = data || [];
  const rows = loaded.slice(0, boundedBatchSize);
  const sources = await loadSourcesForEvents(supabase, rows);
  const actions = rows.map((event) => {
    const source = event.shared_award_source_id
      ? sources.get(event.shared_award_source_id) || null
      : null;
    const replacement = independentProductionSuppressionDecision(
      event,
      source,
      ruleId,
    );
    return replacement.suppressed
      ? {
          event_id: event.id,
          decision: "retain_other_policy",
          replacement_source: "scheduled-downstream-policy-sweep",
          replacement_reason: replacement.reason,
        }
      : { event_id: event.id, decision: "unsuppress" };
  });
  const errors = [];
  let processedCount = 0;
  let remainingCount = null;
  if (actions.length > 0) {
    const requestId = deterministicUuid(
      `promotion-sweep-reversal:${cluster.cluster_id}:` +
        `${activationCycleId}:${sha256(canonicalJson(actions))}`,
    );
    const { data: reversalData, error: reversalError } = await supabase.rpc(
      "revert_monitoring_feedback_promotion_sweep_events",
      {
        p_request_id: requestId,
        p_cluster_id: cluster.cluster_id,
        p_expected_evidence_revision: cluster.evidence_revision,
        p_event_actions: actions,
      },
    );
    if (reversalError) {
      errors.push({ event_id: null, message: reversalError.message });
    } else {
      const result = Array.isArray(reversalData)
        ? reversalData[0]
        : reversalData;
      if (
        !result ||
        !["blocked_late_evidence", "rollback_required"].includes(
          cleanText(result.current_activation_status),
        )
      ) {
        errors.push({
          event_id: null,
          message: "Guarded suppression reversal returned an invalid activation marker.",
        });
      } else {
        processedCount = Number(result.processed_count || 0);
        remainingCount = Number(result.remaining_attributable_count || 0);
      }
    }
  }

  let cursor = {
    detected_at: null,
    event_id: null,
    mutable_target_restart: true,
  };
  if (errors.length === 0) {
    const now = new Date().toISOString();
    const { error: stateError } = await supabase
      .from(monitoringPolicySweepStateTable)
      .upsert(
        {
          sweep_key: sweepKey,
          policy_hash: reversalPolicyHash,
          cursor_detected_at: null,
          cursor_event_id: null,
          scanned_count: start.scanned_count + rows.length,
          cycle_started_at:
            start.reset || !stateResult.state?.cycle_started_at
              ? now
              : stateResult.state.cycle_started_at,
          updated_at: now,
        },
        { onConflict: "sweep_key" },
      );
    if (stateError) {
      errors.push({ event_id: null, message: stateError.message });
    }
  }
  if (errors.length === 0 && remainingCount === null) {
    const { count, error: countError } = await supabase
      .from("shared_award_change_events")
      .select("id", { count: "exact", head: true })
      .not("suppressed_at", "is", null)
      .or(targetFilter);
    if (countError) {
      errors.push({ event_id: null, message: countError.message });
    } else {
      remainingCount = Number(count || 0);
    }
  }
  return {
    complete: errors.length === 0 && remainingCount === 0,
    cursor,
    processed_count: processedCount,
    remaining_attributable_count: remainingCount,
    errors,
  };
}

export function independentProductionSuppressionDecision(
  event,
  source,
  excludedRuleId,
) {
  return changeEventSuppressionDecision(event, source, {
    mode: "retro_sweep",
    excludedPolicyRuleIds: [excludedRuleId],
    ignoreExistingSuppression: true,
  });
}

function promotionAttributableSuppressionFilter(clusterId, ruleId) {
  return [
    `suppression_source.eq.verified-promotion:${cleanText(clusterId)}`,
    "and(" +
      "suppression_source.eq.scheduled-downstream-policy-sweep," +
      `suppression_reason.eq.policy_flag_${cleanText(ruleId)}` +
      ")",
  ].join(",");
}

export async function applyGuardedPromotionSweepEvent({
  supabase,
  clusterId,
  evidenceRevision,
  ruleId,
  eventId,
  suppressedAt,
  suppressionReason,
}) {
  const { data, error } = await supabase.rpc(
    "apply_monitoring_feedback_promotion_sweep_event",
    {
      p_cluster_id: clusterId,
      p_expected_evidence_revision: evidenceRevision,
      p_policy_rule_id: ruleId,
      p_event_id: eventId,
      p_suppressed_at: suppressedAt,
      p_suppression_reason: suppressionReason,
    },
  );
  if (error) {
    const guardedError = new Error(
      `Guarded promotion sweep blocked event ${eventId}: ${error.message}`,
    );
    guardedError.code = cleanText(error.code) || null;
    guardedError.activationBlocked =
      ["40001", "55000"].includes(guardedError.code) ||
      /late evidence|evidence revision is stale|not armed/i.test(error.message);
    throw guardedError;
  }
  const result = Array.isArray(data) ? data[0] : data;
  if (
    !result ||
    cleanText(result.sweep_event_id) !== cleanText(eventId) ||
    Number(result.current_evidence_revision) !== Number(evidenceRevision) ||
    cleanText(result.current_activation_status) !== "armed" ||
    !validTimestamp(result.mutation_at) ||
    result.applied === result.already_applied
  ) {
    const guardedError = new Error(
      `Guarded promotion sweep returned invalid activation evidence for event ${eventId}.`,
    );
    guardedError.activationBlocked = true;
    throw guardedError;
  }
  return result;
}

export async function checkpointTargetedPromotionSweep({
  supabase,
  cluster,
  ruleId,
  sweepKey,
  statePolicyHash,
  nextCursor,
  scannedCount,
  cycleStartedAt = null,
  notBefore = null,
}) {
  const { data, error } = await supabase.rpc(
    "checkpoint_monitoring_feedback_promotion_sweep",
    {
      p_cluster_id: cluster.cluster_id,
      p_expected_evidence_revision: cluster.evidence_revision,
      p_policy_rule_id: ruleId,
      p_sweep_key: sweepKey,
      p_state_policy_hash: statePolicyHash,
      p_cursor_detected_at: cleanText(nextCursor?.detected_at) || null,
      p_cursor_event_id: cleanText(nextCursor?.event_id) || null,
      p_scanned_count: scannedCount,
      p_not_before: validTimestamp(notBefore) ? cleanText(notBefore) : null,
      p_cycle_started_at: validTimestamp(cycleStartedAt)
        ? cleanText(cycleStartedAt)
        : null,
    },
  );
  if (error) {
    const checkpointError = new Error(
      `Guarded promotion sweep checkpoint failed: ${error.message}`,
    );
    checkpointError.code = cleanText(error.code) || null;
    checkpointError.activationBlocked =
      ["40001", "55000"].includes(checkpointError.code) ||
      /late evidence|evidence revision is stale|not armed/i.test(error.message);
    throw checkpointError;
  }
  const result = Array.isArray(data) ? data[0] : data;
  const expectedDetectedAt = cleanText(nextCursor?.detected_at) || null;
  const expectedEventId = cleanText(nextCursor?.event_id) || null;
  const checkpointAt = canonicalEvidenceTimestamp(result?.checkpoint_at);
  const previousCheckpointAt = canonicalEvidenceTimestamp(
    result?.checkpoint_previous_at,
  );
  const lastMutationAt = canonicalEvidenceTimestamp(
    result?.checkpoint_last_mutation_at,
  );
  const returnedDetectedAt = cleanText(
    result?.checkpoint_cursor_detected_at,
  ) || null;
  const cursorTimestampMatches =
    expectedDetectedAt === null
      ? returnedDetectedAt === null
      : returnedDetectedAt !== null &&
        compareEvidenceTimestamps(returnedDetectedAt, expectedDetectedAt) === 0;
  if (
    !result ||
    cleanText(result.checkpoint_sweep_key) !== cleanText(sweepKey) ||
    !cursorTimestampMatches ||
    cleanText(result.checkpoint_cursor_event_id) !== cleanText(expectedEventId) ||
    Number(result.checkpoint_scanned_count) !== Number(scannedCount) ||
    Number(result.current_evidence_revision) !==
      Number(cluster.evidence_revision) ||
    cleanText(result.current_activation_status) !== "armed" ||
    !checkpointAt ||
    (cleanText(result.checkpoint_previous_at) &&
      !previousCheckpointAt) ||
    (cleanText(result.checkpoint_last_mutation_at) &&
      !lastMutationAt) ||
    (validTimestamp(notBefore) &&
      compareEvidenceTimestamps(checkpointAt, notBefore) !== 1) ||
    (previousCheckpointAt &&
      compareEvidenceTimestamps(checkpointAt, previousCheckpointAt) !== 1) ||
    (lastMutationAt &&
      compareEvidenceTimestamps(checkpointAt, lastMutationAt) !== 1)
  ) {
    const checkpointError = new Error(
      "Guarded promotion sweep returned invalid durable checkpoint evidence.",
    );
    checkpointError.activationBlocked = true;
    throw checkpointError;
  }
  return {
    ...result,
    checkpoint_at: checkpointAt,
    checkpoint_previous_at: previousCheckpointAt,
    checkpoint_last_mutation_at: lastMutationAt,
    checkpoint_cycle_started_at:
      canonicalEvidenceTimestamp(result.checkpoint_cycle_started_at) ||
      result.checkpoint_cycle_started_at,
  };
}

async function loadTargetedSweepState(supabase, sweepKey) {
  const { data, error } = await supabase
    .from(monitoringPolicySweepStateTable)
    .select("sweep_key,policy_hash,cursor_detected_at,cursor_event_id,scanned_count,cycle_started_at,updated_at")
    .eq("sweep_key", sweepKey)
    .maybeSingle();
  if (error) {
    if (isMissingMonitoringPolicySweepStateError(error)) {
      return { state: null, unavailable: true };
    }
    throw new Error(`Load targeted promotion sweep state failed: ${error.message}`);
  }
  return { state: data || null, unavailable: false };
}

function buildPromotionRetroactiveFailureEvidence({
  cluster,
  ruleId,
  draftHash,
  sweep,
  app,
  worker,
  workerRunIds,
  activationAttestation,
  matcherDigest,
  errors,
  summary,
  now,
}) {
  let report = buildMonitoringPromotionRetroactiveSweepReport({
    clusterKey: cluster.cluster_key,
    ruleId,
    draftHash,
    sweep,
    app,
    worker,
    workerRunIds,
    now,
  });
  report = sealPromotionReport({
    ...stripReportDigest(report),
    activation_attestation: activationAttestation,
    matcher_digest: matcherDigest,
    activation_cycle_id: promotionActivationCycleId(cluster),
    sweep_errors: Array.isArray(errors) ? errors : [],
    status: "failed",
    summary,
  });
  return stabilizePromotionReport(report);
}

function operatorDeactivationEvidence(cluster, ruleId, progress) {
  const canary = objectValue(objectValue(cluster.stage_artifacts).six_pm_canary);
  return stabilizePromotionReport({
    schema_version: "monitoring-promotion-rollback-required-v1",
    report_id: null,
    cluster_key: cluster.cluster_key,
    rule_id: ruleId,
    evidence_revision: Number(cluster.evidence_revision),
    activation_cycle_id: promotionActivationCycleId(cluster),
    failure_reason: "operator_deactivated",
    status: "failed",
    completed_at: canonicalEvidenceTimestamp(canary.completed_at),
    sweep_started: progress?.sweep_started === true,
    scanned_count: nonNegativeInt(progress?.scanned_count),
    attributable_suppression_count: nonNegativeInt(
      progress?.attributable_suppression_count,
    ),
    summary:
      "The candidate rule was disabled after post-canary activation work began and requires a verified inactive rollback.",
  });
}

function postActivationFailureEvidence({
  cluster,
  ruleId,
  failureReason,
  message,
}) {
  const canary = objectValue(objectValue(cluster.stage_artifacts).six_pm_canary);
  return stabilizePromotionReport({
    schema_version: "monitoring-promotion-rollback-required-v1",
    report_id: null,
    cluster_key: cluster.cluster_key,
    rule_id: ruleId,
    evidence_revision: Number(cluster.evidence_revision),
    activation_cycle_id: promotionActivationCycleId(cluster),
    failure_reason: failureReason,
    status: "failed",
    completed_at: canonicalEvidenceTimestamp(canary.completed_at),
    errors: [{ event_id: null, message: cleanText(message) }],
    summary:
      "Post-activation verification could not prove a safe deployment and requires a verified inactive rollback.",
  });
}

export function promotionExceptionRequiresRollback(cluster) {
  return [
    "armed",
    "blocked_late_evidence",
    "rollback_required",
    "sweep_completed",
  ].includes(cleanText(cluster?.activation_status));
}

export function promotionWorkerFailureStage(cluster) {
  const currentStage = cleanText(cluster?.current_stage);
  if (
    currentStage === "retroactive_sweep" ||
    ["blocked_late_evidence", "rollback_required", "sweep_completed"].includes(
      cleanText(cluster?.activation_status),
    )
  ) {
    return "retroactive_sweep";
  }
  const nextStages = {
    triaged: "similar_feedback_clustered",
    similar_feedback_clustered: "rule_drafted",
    rule_drafted: "historical_shadow_test",
    historical_shadow_test: "regression_tests_pass",
    regression_tests_pass: "app_worker_hashes_match",
    app_worker_hashes_match: "six_pm_canary",
    six_pm_canary: "retroactive_sweep",
  };
  return nextStages[currentStage] || currentStage;
}

export async function recordPromotionWorkerFailure({
  supabase,
  cluster,
  config,
  reason,
}) {
  const failureStage = promotionWorkerFailureStage(cluster);
  const postActivation = promotionExceptionRequiresRollback(cluster);
  const safeAction = postActivation
    ? "Keep the drafted rule inactive. Repair the reported worker failure; hourly recovery will reverse candidate-attributable suppressions and restart full validation without a paid API call."
    : safeActionForGate(failureStage);
  const evidence = stabilizePromotionReport({
    schema_version: "monitoring-promotion-worker-failure-v1",
    report_id: null,
    cluster_key: cluster.cluster_key,
    rule_id: cleanText(cluster.proposed_rule_id) || null,
    status: "failed",
    current_stage: cleanText(cluster.current_stage),
    failure_stage: failureStage,
    evidence_revision: Number(cluster.evidence_revision),
    activation_status: cleanText(cluster.activation_status),
    completed_at: canonicalEvidenceTimestamp(cluster.updated_at),
    summary: `Worker exception while verifying ${failureStage}: ${reason}`.slice(
      0,
      2000,
    ),
    safe_action: safeAction,
    errors: [{ message: reason }],
  });
  const requestId = deterministicPromotionRequestId(
    cluster.cluster_id,
    `worker_failure:${cleanText(cluster.current_stage)}:${failureStage}`,
    evidence.digest,
  );
  const { data, error } = await supabase.rpc(
    "record_monitoring_feedback_promotion_worker_failure",
    {
      p_request_id: requestId,
      p_cluster_id: cluster.cluster_id,
      p_expected_evidence_revision: cluster.evidence_revision,
      p_expected_current_stage: cluster.current_stage,
      p_failure_stage: failureStage,
      p_actor_user_id: config.actorId,
      p_actor_email: config.actorEmail,
      p_failure_reason: reason,
      p_evidence: evidence,
      p_safe_action: safeAction,
      p_note:
        "Automatic durable fail-closed record for an unexpected promotion worker exception.",
    },
  );
  if (error) {
    throw new Error(`Record durable promotion worker failure failed: ${error.message}`);
  }
  const result = Array.isArray(data) ? data[0] : data;
  if (
    !result ||
    cleanText(result.recorded_cluster_id) !== cleanText(cluster.cluster_id) ||
    cleanText(result.current_stage) !== cleanText(cluster.current_stage) ||
    cleanText(result.failed_stage) !== failureStage ||
    Number(result.current_evidence_revision) !== Number(cluster.evidence_revision)
  ) {
    throw new Error("Durable promotion worker failure returned an invalid result.");
  }
  return {
    ...result,
    report_digest: evidence.digest,
    safe_action: safeAction,
  };
}

async function markPromotionRollbackRequired({
  supabase,
  cluster,
  config,
  reason,
  evidence,
  note,
}) {
  if (!isSha256(evidence?.digest)) {
    throw new Error("Rollback-required evidence must have a sealed digest.");
  }
  const requestId = deterministicPromotionRequestId(
    cluster.cluster_id,
    `rollback_required:${reason}`,
    evidence.digest,
  );
  const { data, error } = await supabase.rpc(
    "mark_monitoring_feedback_promotion_rollback_required",
    {
      p_request_id: requestId,
      p_cluster_id: cluster.cluster_id,
      p_expected_evidence_revision: cluster.evidence_revision,
      p_actor_user_id: config.actorId,
      p_actor_email: config.actorEmail,
      p_reason: reason,
      p_evidence: evidence,
      p_note: note,
    },
  );
  if (error) {
    throw new Error(`Record rollback-required marker failed: ${error.message}`);
  }
  const result = Array.isArray(data) ? data[0] : data;
  if (
    !result ||
    cleanText(result.marked_cluster_id) !== cleanText(cluster.cluster_id) ||
    cleanText(result.current_activation_status) !== "rollback_required" ||
    Number(result.current_evidence_revision) !== Number(cluster.evidence_revision)
  ) {
    throw new Error("Rollback-required marker returned an invalid guarded result.");
  }
  return {
    cluster_id: cluster.cluster_id,
    cluster_key: cluster.cluster_key,
    stage: cluster.current_stage,
    activation_status: "rollback_required",
    transition_id: result.marker_transition_id || null,
    report_digest: evidence.digest,
    status: "failed",
    reason: evidence.summary || "Post-activation verification failed.",
    safe_action:
      "Keep the drafted rule inactive. The hourly worker will verify the rollback identity, reverse only candidate-attributable suppressions, and restart full validation without a paid API call.",
  };
}

async function submitGateReport({
  supabase,
  cluster,
  toStage,
  evidence,
  ruleId,
  config,
  note,
}) {
  const requestId = deterministicPromotionRequestId(
    cluster.cluster_id,
    toStage,
    evidence.digest,
  );
  const { data, error } = await supabase.rpc(
    "advance_monitoring_feedback_promotion_cluster",
    {
      p_request_id: requestId,
      p_cluster_id: cluster.cluster_id,
      p_expected_evidence_revision: cluster.evidence_revision,
      p_to_stage: toStage,
      p_actor_user_id: config.actorId,
      p_actor_email: config.actorEmail,
      p_evidence: evidence,
      p_policy_rule_id: ruleId,
      p_policy_identity: null,
      p_policy_version: null,
      p_policy_hash: null,
      p_policy_config_version: null,
      p_decision_memory_version: null,
      p_note: note,
    },
  );
  if (error) throw new Error(`Record ${toStage} gate failed: ${error.message}`);
  const result = Array.isArray(data) ? data[0] : data;
  return {
    cluster_id: cluster.cluster_id,
    cluster_key: cluster.cluster_key,
    stage: cluster.current_stage,
    requested_stage: toStage,
    transition_id: result?.transition_id || null,
    report_digest: evidence.digest,
    status: result?.accepted ? "advanced" : "failed",
    reason: result?.accepted
      ? `Advanced to ${toStage}.`
      : result?.failure_reason || evidence.summary || `${toStage} did not pass.`,
    safe_action: result?.accepted
      ? null
      : safeActionForGate(toStage),
  };
}

function bindMatcherDigest(report, draftMatcherDigest, { runtimeDigest, mismatchSummary }) {
  const matches =
    isSha256(draftMatcherDigest) && cleanText(runtimeDigest) === draftMatcherDigest;
  return sealPromotionReport({
    ...stripReportDigest(report),
    matcher_digest: cleanText(runtimeDigest) || null,
    status: matches ? report.status : "failed",
    summary: matches ? report.summary : mismatchSummary,
  });
}

function bindHashMatcherEvidence(
  report,
  { draftMatcherDigest, appMatcherDigest, workerMatcherDigest, workerRuns },
) {
  const comparisons = Array.isArray(report.comparisons)
    ? report.comparisons.filter((item) => item?.kind !== "matcher")
    : [];
  comparisons.push({
    kind: "matcher",
    app_hash: cleanText(appMatcherDigest) || null,
    worker_hash: cleanText(workerMatcherDigest) || null,
    matches:
      cleanText(appMatcherDigest) === cleanText(workerMatcherDigest) &&
      cleanText(workerMatcherDigest) === cleanText(draftMatcherDigest),
  });
  const runsMatch = (workerRuns || []).length > 0 && (workerRuns || []).every((run) =>
    cleanText(objectValue(run.metadata).matcher_digest) === cleanText(draftMatcherDigest),
  );
  const passed =
    report.status === "passed" &&
    comparisons.length === 5 &&
    comparisons.every((item) => item.matches) &&
    runsMatch;
  return sealPromotionReport({
    ...stripReportDigest(report),
    app_matcher_digest: cleanText(appMatcherDigest) || null,
    worker_matcher_digest: cleanText(workerMatcherDigest) || null,
    comparisons,
    status: passed ? "passed" : "failed",
    summary: passed
      ? "The app, worker, executable matcher, and all three policy identities match."
      : "The app, worker revision, executable matcher, worker observation, or policy identities do not match.",
  });
}

function enforceHashAttestationPrerequisites(report, { app, worker, eligibleRuns }) {
  const concrete = [app?.revision, worker?.revision].every(
    (value) => cleanText(value) && cleanKey(value) !== "unavailable",
  );
  const matcherIdentityMatches =
    Boolean(cleanText(app?.matcher_identity) && cleanText(app?.matcher_version)) &&
    cleanText(app?.matcher_identity) === cleanText(worker?.matcher_identity) &&
    cleanText(app?.matcher_version) === cleanText(worker?.matcher_version);
  const passed =
    report.status === "passed" &&
    concrete &&
    matcherIdentityMatches &&
    eligibleRuns.length > 0;
  return sealPromotionReport({
    ...stripReportDigest(report),
    status: passed ? "passed" : "failed",
    summary: passed
      ? report.summary
      : "A concrete matching app/worker revision and at least one exact worker-run observation are required.",
  });
}

export function enforceActivationIdentityChange(report, preActivation) {
  const distinct = [
    [report.app_policy_hash, preActivation?.app_policy_hash],
    [report.app_batch_policy_hash, preActivation?.app_batch_policy_hash],
    [
      report.app_suppression_policy_hash,
      preActivation?.app_suppression_policy_hash,
    ],
  ].every(
    ([activated, inactive]) =>
      Boolean(cleanText(activated) && cleanText(inactive)) &&
      cleanText(activated) !== cleanText(inactive),
  );
  return sealPromotionReport({
    ...stripReportDigest(report),
    status: report.status === "passed" && distinct ? "passed" : "failed",
    summary:
      report.status === "passed" && distinct
        ? report.summary
        : "Activation must keep the reviewed matcher while producing distinct active full, Batch, and suppression policy hashes.",
  });
}

export function stabilizePromotionReport(report) {
  const base = { ...stripReportDigest(report) };
  delete base.report_id;
  const fingerprint = sha256(canonicalJson(base));
  return sealPromotionReport({
    ...base,
    report_id: deterministicUuid(`promotion-report:${fingerprint}`),
  });
}

export function deterministicPromotionRequestId(clusterId, stage, evidenceDigest) {
  return deterministicUuid(
    `promotion-transition:${cleanText(clusterId)}:${cleanText(stage)}:${cleanText(evidenceDigest)}`,
  );
}

function mergeClusterFallbackEvents(events, evidenceRows) {
  const byId = new Map(events.map((event) => [event.id, event]));
  for (const row of evidenceRows) {
    const event = objectValue(row.event_payload);
    if (event.id && !byId.has(event.id)) byId.set(event.id, event);
  }
  return [...byId.values()];
}

function uniqueEventsById(events) {
  const byId = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    const id = cleanText(event?.id);
    if (id && !byId.has(id)) byId.set(id, event);
  }
  return [...byId.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, event]) => event);
}

function isRetainedLegitimateEvent(event) {
  if (!event || event.suppressed_at) return false;
  const details = objectValue(event.change_details);
  if (details.suppression_reason || details.suppressed_at) return false;
  if (details.is_alert_worthy === false || details.isAlertWorthy === false) return false;
  return !["rejected", "invalid-json"].includes(cleanKey(details.generation_status));
}

function safeActionForGate(stage) {
  const actions = {
    historical_shadow_test:
      "Review the retained collisions or raise the history cap only after confirming the full scan can complete; keep the rule inactive.",
    regression_tests_pass:
      "Repair the candidate matcher or retain a legitimate negative fixture, then rerun without activating the rule.",
    app_worker_hashes_match:
      "Deploy the same concrete revision and policy bundle to the app and worker, then let a normal worker run attest it.",
    six_pm_canary:
      "Inspect the exact three scheduled shards and their bound events; do not launch an extra paid scan.",
    retroactive_sweep:
      "Keep the cursor and audit evidence, repair the reported event or identity mismatch, and resume the bounded sweep.",
  };
  return actions[stage] || "Inspect the retained gate evidence before retrying.";
}

export function promotionRunnerConfig(args, env) {
  return {
    supabaseUrl: cleanText(env.NEXT_PUBLIC_SUPABASE_URL),
    serviceRoleKey: cleanText(env.SUPABASE_SERVICE_ROLE_KEY),
    appUrl: cleanText(env.NEXT_PUBLIC_APP_URL),
    actorId: cleanText(env.AWARDPING_PROMOTION_WORKER_ACTOR_ID) || defaultActorId,
    actorEmail:
      cleanText(env.AWARDPING_PROMOTION_WORKER_ACTOR_EMAIL) || defaultActorEmail,
    clusterLimit: positiveInt(args.limit, 500),
    historyPageSize: positiveInt(args["history-page-size"], 500),
    historyLimit: positiveInt(args["history-limit"], 250_000),
    workerRunLookback: positiveInt(args["worker-run-lookback"], 250),
    canaryRunLookback: positiveInt(args["canary-run-lookback"], 750),
    retroBatchSize: positiveInt(args["retro-batch-size"], 5_000),
    fetchTimeoutMs: positiveInt(args["fetch-timeout-ms"], 15_000),
    apply: boolArg(args.apply, true),
  };
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    cleanText(value),
  );
}

function deterministicUuid(value) {
  const bytes = Buffer.from(sha256(value), "hex").subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function latestEvidenceTimestamp(values) {
  let latest = null;
  for (const value of values || []) {
    const canonical = canonicalEvidenceTimestamp(value);
    if (!canonical || timestamp(canonical) <= 0) continue;
    if (!latest || compareEvidenceTimestamps(canonical, latest) > 0) {
      latest = canonical;
    }
  }
  return latest || "1970-01-01T00:00:00.000000Z";
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const [key, inlineValue] = value.slice(2).split("=");
    if (inlineValue !== undefined) parsed[key] = inlineValue;
    else if (values[index + 1] && !values[index + 1].startsWith("--")) {
      parsed[key] = values[index + 1];
      index += 1;
    } else parsed[key] = "true";
  }
  return parsed;
}

function loadEnvFile(path) {
  if (!existsSync(path)) return {};
  const values = {};
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals < 1) continue;
    const key = line.slice(0, equals).trim();
    let value = line.slice(equals + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) value = value.slice(1, -1);
    values[key] = value;
  }
  return values;
}

function stripReportDigest(report) {
  const copy = { ...objectValue(report) };
  delete copy.digest;
  return copy;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function chunks(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function unique(values) {
  return [...new Set(values)];
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInt(value) {
  const parsed = Number.parseInt(String(value ?? "0"), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function boolArg(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = cleanKey(value);
  if (["1", "true", "yes", "y"].includes(normalized)) return true;
  if (["0", "false", "no", "n"].includes(normalized)) return false;
  return fallback;
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function cleanKey(value) {
  return cleanText(value).toLowerCase().replace(/[\s_]+/g, "-");
}

function timestamp(value) {
  const parsed = new Date(value || 0).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function validTimestamp(value) {
  const canonical = canonicalEvidenceTimestamp(value);
  return Boolean(canonical && timestamp(canonical) > 0);
}

function isSha256(value) {
  return /^[0-9a-f]{64}$/.test(cleanText(value));
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function ensureTrailingSlash(value) {
  return value.endsWith("/") ? value : `${value}/`;
}

function isDirectExecution() {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

const changeEventSelect = [
  "id",
  "shared_award_id",
  "shared_award_source_id",
  "source_title",
  "source_url",
  "source_page_type",
  "summary",
  "change_details",
  "detected_at",
  "suppressed_at",
  "suppression_reason",
  "suppression_source",
  "visual_review_candidate_id",
].join(",");

const sourceSelect = [
  "id",
  "shared_award_id",
  "url",
  "title",
  "display_title",
  "page_type",
  "admin_review_status",
].join(",");
