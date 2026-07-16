import type { Json } from "@/lib/database.types";

export const monitoringFeedbackPromotionStages = [
  "triaged",
  "similar_feedback_clustered",
  "rule_drafted",
  "historical_shadow_test",
  "regression_tests_pass",
  "app_worker_hashes_match",
  "six_pm_canary",
  "retroactive_sweep",
  "resolved",
] as const;

export type MonitoringFeedbackPromotionStage =
  (typeof monitoringFeedbackPromotionStages)[number];

export type MonitoringFeedbackPromotionActivationStatus =
  | "inactive"
  | "armed"
  | "blocked_late_evidence"
  | "rollback_required"
  | "sweep_completed";

export type MonitoringFeedbackPromotionEvidence = {
  status?: string;
  report_id?: string;
  digest?: string;
  summary?: string;
  completed_at?: string;
  total_history_checked?: number;
  proposed_rule_matches?: number;
  legitimate_updates_suppressed?: number;
  legitimate_updates?: Json;
  app_policy_hash?: string;
  worker_policy_hash?: string;
  app_batch_policy_hash?: string;
  worker_batch_policy_hash?: string;
  app_suppression_policy_hash?: string;
  worker_suppression_policy_hash?: string;
  [key: string]: Json | undefined;
};

export type MonitoringFeedbackPromotionCluster = {
  clusterKey: string;
  evidenceSignature: string;
  domainTemplate: string;
  reasonCode: string;
  recurrenceCount: number;
  sourceCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  feedbackIds: string[];
  requestedScopes: string[];
  sampleFeedback: Json;
  workflowId: string | null;
  workflowVersion: number | null;
  stage: MonitoringFeedbackPromotionStage | null;
  activationStatus: MonitoringFeedbackPromotionActivationStatus;
  activationBlockedAt: string | null;
  resolutionReady: boolean;
  resolutionIdentityDrifted: boolean;
  resolutionIdentityDriftReason: string | null;
  resolutionWorkerRunId: string | null;
  resolutionAttestedAt: string | null;
  ownerEmail: string | null;
  draftPolicyRuleId: string | null;
  draftRuleActive: boolean;
  draftSummary: string | null;
  legitimateNegativeEventIds: string[];
  blockingReport: MonitoringFeedbackPromotionEvidence | null;
  latestRejectedAttempt: MonitoringFeedbackPromotionEvidence | null;
  shadowReport: MonitoringFeedbackPromotionEvidence | null;
  regressionReport: MonitoringFeedbackPromotionEvidence | null;
  hashAttestation: MonitoringFeedbackPromotionEvidence | null;
  canaryReport: MonitoringFeedbackPromotionEvidence | null;
  retroactiveSweepReport: MonitoringFeedbackPromotionEvidence | null;
  updatedAt: string | null;
};

export const monitoringFeedbackPromotionStageCopy: Record<
  MonitoringFeedbackPromotionStage,
  { label: string; plainDescription: string }
> = {
  triaged: {
    label: "Triaged",
    plainDescription: "An operator marked the event as not an update, so it is already hidden.",
  },
  similar_feedback_clustered: {
    label: "Similar feedback clustered",
    plainDescription: "Matching evidence, site templates, and reasons are reviewed together.",
  },
  rule_drafted: {
    label: "Rule drafted",
    plainDescription: "A stable proposed rule and its intended boundary are recorded.",
  },
  historical_shadow_test: {
    label: "Historical shadow test",
    plainDescription: "History shows what the rule would hide without changing public updates.",
  },
  regression_tests_pass: {
    label: "Regression tests pass",
    plainDescription: "False updates are caught and legitimate updates stay visible.",
  },
  app_worker_hashes_match: {
    label: "App and worker hashes match",
    plainDescription: "The website and 6 PM workers are using the same reviewed policy.",
  },
  six_pm_canary: {
    label: "6 PM canary",
    plainDescription: "One scheduled scan verifies the rule before global activation.",
  },
  retroactive_sweep: {
    label: "Retroactive sweep",
    plainDescription:
      "The approved rule was applied to retained history; the next normal hourly, zero-charge worker attestation must pass before Resolve unlocks.",
  },
  resolved: {
    label: "Resolved",
    plainDescription: "The cluster is covered by a verified global rule.",
  },
};

export function monitoringFeedbackPromotionStageIndex(
  stage: MonitoringFeedbackPromotionStage | null,
) {
  if (!stage) return -1;
  return monitoringFeedbackPromotionStages.indexOf(stage);
}

export function nextMonitoringFeedbackPromotionStage(
  stage: MonitoringFeedbackPromotionStage | null,
) {
  const nextIndex = monitoringFeedbackPromotionStageIndex(stage) + 1;
  return monitoringFeedbackPromotionStages[nextIndex] || null;
}

export function monitoringFeedbackPromotionProgress(
  stage: MonitoringFeedbackPromotionStage | null,
) {
  const completed = Math.max(0, monitoringFeedbackPromotionStageIndex(stage) + 1);
  return {
    completed,
    total: monitoringFeedbackPromotionStages.length,
    percent: Math.round((completed / monitoringFeedbackPromotionStages.length) * 100),
  };
}

export function monitoringFeedbackPromotionSafeAction(
  cluster: MonitoringFeedbackPromotionCluster,
) {
  if (cluster.activationStatus === "blocked_late_evidence") {
    return "Deactivate the drafted rule if it is live in either deployed surface, keep the candidate inactive, deploy the same inactive revision to the app and worker, and let the hourly rollback verification reverse candidate-attributable suppression before redrafting.";
  }
  if (cluster.activationStatus === "rollback_required") {
    return "Restore the exact inactive app and worker revision, then let the hourly rollback verification reverse or safely re-attribute candidate-attributable suppression before the cluster returns to draft.";
  }
  if (monitoringFeedbackPromotionPostSweepDeactivated(cluster)) {
    return "Keep the drafted rule inactive. The next normal hourly, zero-charge worker run will record the deactivation, require rollback, reverse candidate-attributable suppressions, and return the cluster to a safe draft checkpoint; do not resolve it.";
  }
  if (cluster.resolutionIdentityDrifted) {
    return "Deactivate the drafted rule, restore the exact reviewed inactive app and worker identity from the pre-canary hash attestation, and let the normal hourly zero-charge rollback audit reverse or safely re-attribute every candidate-attributable suppression before redrafting.";
  }
  const failedEvidence = monitoringFeedbackPromotionFailedEvidence(cluster);
  const evidenceSafeAction = evidenceText(failedEvidence, "safe_action");
  if (evidenceSafeAction) return evidenceSafeAction;
  const failedAttemptStage =
    evidenceText(failedEvidence, "requested_stage") ||
    evidenceText(failedEvidence, "failure_stage");
  const failedAttemptAction = failedPromotionAttemptSafeAction(failedAttemptStage);
  if (failedAttemptAction) return failedAttemptAction;
  const failedGate = monitoringFeedbackPromotionFailedGate(cluster);
  if (failedGate) return failedGate;

  switch (cluster.stage) {
    case null:
      return "Triage the cluster and assign an owner.";
    case "triaged":
      return "Confirm that the grouped examples share the same pattern.";
    case "similar_feedback_clustered":
      return "Draft one narrow rule and describe what it must never hide.";
    case "rule_drafted":
      return "Run the rule against retained history without suppressing anything.";
    case "historical_shadow_test":
      return "Run the positive and negative regression fixtures.";
    case "regression_tests_pass":
      return "Verify the deployed app and worker policy hashes.";
    case "app_worker_hashes_match":
      return "Wait for the next scheduled 6 PM canary scan.";
    case "six_pm_canary":
      return cluster.draftRuleActive
        ? "App activation is detected, but worker parity is still pending. Let automation re-attest the activated deployment before it continues the bounded retroactive sweep."
        : "Activate the verified rule globally and start the retroactive sweep.";
    case "retroactive_sweep":
      return cluster.resolutionReady
        ? "Review the durable hourly attestation with the completed sweep report, then resolve the verified cluster."
        : "Wait for the next normal hourly, zero-charge matching worker attestation. Resolve stays locked and no extra 6 PM scan is required.";
    case "resolved":
      return "No action is needed unless this pattern recurs under a new signature.";
  }
}

export function monitoringFeedbackPromotionFailedGate(
  cluster: MonitoringFeedbackPromotionCluster,
) {
  if (monitoringFeedbackPromotionPostSweepDeactivated(cluster)) {
    return "The retroactive sweep completed, but the drafted rule is no longer active. Do not resolve it; hourly rollback/deactivation repair must reverse candidate-attributable suppressions and return the workflow to draft.";
  }
  if (cluster.resolutionIdentityDrifted) {
    return (
      cluster.resolutionIdentityDriftReason ||
      "The current app identity no longer matches the immutable activated app/worker identity, so final resolution is blocked and rollback is required."
    );
  }
  const failedEvidence = monitoringFeedbackPromotionFailedEvidence(cluster);
  const concreteSummary = evidenceText(failedEvidence, "summary");
  if (concreteSummary) return concreteSummary;
  if (cluster.activationStatus === "blocked_late_evidence") {
    return "New matching feedback arrived after the canary. Deactivate the rule if it is live and deploy the same inactive revision to the app and worker; AwardPing verifies that rollback hourly, then returns the enlarged cluster to draft automatically.";
  }
  if (cluster.activationStatus === "rollback_required") {
    return "The activated deployment or historical sweep failed. Restore the exact inactive app and worker revision; AwardPing verifies that rollback hourly, reverses candidate-attributable suppression, and returns the cluster to draft only after the audit passes.";
  }
  const legitimateCollisions = evidenceNumber(
    cluster.shadowReport,
    "legitimate_updates_suppressed",
  );
  if (legitimateCollisions > 0) {
    return `Narrow the proposed rule; it would also hide ${legitimateCollisions.toLocaleString("en-US")} legitimate ${legitimateCollisions === 1 ? "update" : "updates"}.`;
  }
  if (isFailed(cluster.shadowReport)) {
    return "Repair the historical shadow test before continuing.";
  }
  if (isFailed(cluster.regressionReport)) {
    return "Fix the failing regression examples before continuing.";
  }
  if (isFailed(cluster.hashAttestation)) {
    return "Deploy the same reviewed policy revision to the app and workers.";
  }
  if (isFailed(cluster.canaryReport)) {
    return "Repair the canary failure and wait for a new scheduled 6 PM scan.";
  }
  if (isFailed(cluster.retroactiveSweepReport)) {
    return "Repair the sweep failure and resume from its saved cursor.";
  }
  return null;
}

export function monitoringFeedbackPromotionPostSweepDeactivated(
  cluster: MonitoringFeedbackPromotionCluster,
) {
  return cluster.stage === "retroactive_sweep" && !cluster.draftRuleActive;
}

function monitoringFeedbackPromotionFailedEvidence(
  cluster: MonitoringFeedbackPromotionCluster,
) {
  return [
    cluster.blockingReport,
    cluster.latestRejectedAttempt,
    cluster.shadowReport,
    cluster.regressionReport,
    cluster.hashAttestation,
    cluster.canaryReport,
    cluster.retroactiveSweepReport,
  ].find(isFailed) || null;
}

export function monitoringFeedbackPromotionNeedsActivationRollback(
  status: MonitoringFeedbackPromotionActivationStatus,
) {
  return status === "blocked_late_evidence" || status === "rollback_required";
}

export function monitoringFeedbackPromotionCanActivateGlobally(
  cluster: MonitoringFeedbackPromotionCluster,
) {
  return (
    monitoringFeedbackPromotionStageIndex(cluster.stage) >=
      monitoringFeedbackPromotionStageIndex("six_pm_canary") &&
    !monitoringFeedbackPromotionNeedsActivationRollback(
      cluster.activationStatus,
    ) &&
    !monitoringFeedbackPromotionPostSweepDeactivated(cluster) &&
    !cluster.resolutionIdentityDrifted &&
    evidenceNumber(cluster.shadowReport, "legitimate_updates_suppressed") === 0 &&
    isPassed(cluster.shadowReport) &&
    isPassed(cluster.regressionReport) &&
    isPassed(cluster.hashAttestation) &&
    isPassed(cluster.canaryReport)
  );
}

export function isMonitoringFeedbackPromotionStage(value: string | null) {
  return monitoringFeedbackPromotionStages.includes(
    value as MonitoringFeedbackPromotionStage,
  );
}

function evidenceNumber(
  evidence: MonitoringFeedbackPromotionEvidence | null,
  key: keyof MonitoringFeedbackPromotionEvidence,
) {
  const value = evidence?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function evidenceText(
  evidence: MonitoringFeedbackPromotionEvidence | null,
  key: keyof MonitoringFeedbackPromotionEvidence,
) {
  const value = evidence?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isPassed(evidence: MonitoringFeedbackPromotionEvidence | null) {
  return evidence?.status === "passed" || evidence?.status === "completed";
}

function isFailed(evidence: MonitoringFeedbackPromotionEvidence | null) {
  return evidence?.status === "failed" || evidence?.status === "blocked";
}

function failedPromotionAttemptSafeAction(stage: string | null) {
  switch (stage) {
    case "similar_feedback_clustered":
      return "Refresh the cluster, verify that its evidence signature, domain template, and reason still describe one reusable pattern, then confirm it again.";
    case "rule_drafted":
      return "Keep the candidate inactive, correct the rule boundary or known-real-update fixtures named in the failure evidence, refresh the cluster, and save the narrow draft again.";
    case "historical_shadow_test":
      return "Keep the candidate inactive, repair the history query or narrow the rule, then let the hourly shadow test retry against the unchanged evidence revision.";
    case "regression_tests_pass":
      return "Repair the named regression fixture or narrow the candidate rule, then rerun verification from the draft checkpoint.";
    case "app_worker_hashes_match":
      return "Deploy the same reviewed app and worker identity, then let the hourly no-charge hash check run again.";
    case "six_pm_canary":
      return "Repair the listed candidate or shard failure and wait for the next normal 6 PM cohort; do not start an extra paid scan.";
    case "retroactive_sweep":
      return "Keep the candidate inactive if rollback is required, repair the saved sweep failure, and let the hourly worker resume only after app/worker identity is verified.";
    case "resolved":
      return "Keep the cluster open, restore the exact activated identity or obtain its matching hourly attestation, refresh, and resolve only after the final gate is ready.";
    default:
      return null;
  }
}
