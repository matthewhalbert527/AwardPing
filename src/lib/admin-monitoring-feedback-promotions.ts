import type { Database, Json } from "@/lib/database.types";
import { isGloballyActiveMonitoringPolicyRule } from "@/lib/award-monitoring-policy";
import { currentMonitoringPromotionAppIdentity } from "@/lib/monitoring-feedback-promotion-identity";
import {
  isMonitoringFeedbackPromotionStage,
  type MonitoringFeedbackPromotionCluster,
  type MonitoringFeedbackPromotionEvidence,
  type MonitoringFeedbackPromotionStage,
} from "@/lib/monitoring-feedback-promotion";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;
type PromotionClusterRow =
  Database["public"]["Functions"]["list_monitoring_feedback_promotion_clusters"]["Returns"][number];

type JsonObject = { [key: string]: Json | undefined };
type MonitoringPromotionAppIdentity = {
  revision: string;
  policy_hash: string;
  batch_policy_hash: string;
  suppression_policy_hash: string;
  matcher_hash: string;
};

export type AdminMonitoringFeedbackPromotionClusters = {
  clusters: MonitoringFeedbackPromotionCluster[];
  total: number;
  loadErrors: string[];
};

export async function loadAdminMonitoringFeedbackPromotionClusters(
  admin: AdminClient,
  options: { includeResolved?: boolean; limit?: number } = {},
): Promise<AdminMonitoringFeedbackPromotionClusters> {
  const limit = Math.max(1, Math.min(options.limit ?? 500, 500));
  const { data, error } = await admin.rpc(
    "list_monitoring_feedback_promotion_clusters",
    {
      p_limit: limit,
      p_include_resolved: options.includeResolved ?? false,
    },
  );

  if (error) {
    return {
      clusters: [],
      total: 0,
      loadErrors: [promotionClusterLoadError(error.message)],
    };
  }

  const rows = data || [];
  const total = Number(rows[0]?.total_clusters || 0);
  const appIdentity = currentMonitoringPromotionAppIdentity();
  return {
    clusters: rows.map((row) =>
      mapMonitoringFeedbackPromotionCluster(row, appIdentity),
    ),
    total,
    loadErrors:
      total > rows.length
        ? [
            `${(total - rows.length).toLocaleString("en-US")} additional verified promotion ${total - rows.length === 1 ? "cluster is" : "clusters are"} not shown because the response reached its ${limit.toLocaleString("en-US")}-item limit.`,
          ]
        : [],
  };
}

export function mapMonitoringFeedbackPromotionCluster(
  row: PromotionClusterRow,
  appIdentity: MonitoringPromotionAppIdentity =
    currentMonitoringPromotionAppIdentity(),
): MonitoringFeedbackPromotionCluster {
  const stage = promotionStage(row.current_stage);
  const artifacts = jsonObject(row.stage_artifacts) || {};
  const samples = jsonArray(row.sample_evidence);
  const latestAttemptStage = promotionStage(row.latest_attempt_stage);
  const legitimateCollisions = jsonArray(row.legitimate_collisions);
  const latestRejectedAttempt =
    row.latest_attempt_accepted === false
      ? failedAttemptEvidence(
          row.latest_attempt_evidence,
          row.latest_attempt_failure_reason,
          latestAttemptStage,
          row.latest_attempt_created_at,
          Number(row.legitimate_collision_count || 0),
          legitimateCollisions,
        )
      : null;

  const shadowArtifact = stageEvidence(artifacts, "historical_shadow_test");
  const shadowReport = shadowArtifact
    ? normalizeShadowEvidence(
        shadowArtifact,
        Number(row.legitimate_collision_count || 0),
        legitimateCollisions,
      )
    : null;

  const draftArtifact = jsonObject(artifacts.rule_drafted);
  const draftRule = jsonObject(draftArtifact?.rule);
  const retroactiveSweep = jsonObject(artifacts.retroactive_sweep);
  const activationAttestation = jsonObject(
    retroactiveSweep?.activation_attestation,
  );
  const resolutionState = monitoringFeedbackResolutionState(
    row,
    stage,
    activationAttestation,
    appIdentity,
  );
  const blockingArtifact = jsonObject(
    row.latest_blocking_transition_evidence,
  );
  const blockingReport =
    ["blocked_late_evidence", "rollback_required"].includes(
      row.activation_status,
    ) && blockingArtifact
      ? ({
          ...blockingArtifact,
          status: "failed",
          summary:
            jsonText(blockingArtifact.summary) ||
            "Activation was blocked and requires verified rollback repair.",
          completed_at:
            row.latest_blocking_transition_created_at ||
            jsonText(blockingArtifact.completed_at) ||
            undefined,
          transition_kind:
            row.latest_blocking_transition_kind || undefined,
        } satisfies MonitoringFeedbackPromotionEvidence)
      : null;
  const feedbackIds = uniqueTexts(samples.map((sample) => jsonObject(sample)?.feedback_id));
  const requestedScopes = uniqueTexts(
    samples.map((sample) => jsonObject(sample)?.requested_scope),
  );

  return {
    clusterKey: row.cluster_key,
    evidenceSignature: row.evidence_signature,
    domainTemplate: row.domain_template,
    reasonCode: row.reason_code,
    recurrenceCount: Number(row.recurrence_count || 0),
    sourceCount: Number(row.source_count || 0),
    firstSeenAt: row.created_at,
    lastSeenAt: row.updated_at,
    feedbackIds,
    requestedScopes,
    sampleFeedback: samples,
    workflowId: row.cluster_id,
    workflowVersion: Number(row.evidence_revision),
    stage,
    activationStatus: row.activation_status,
    activationBlockedAt: row.activation_blocked_at,
    resolutionReady: resolutionState.ready,
    resolutionIdentityDrifted: resolutionState.identityDrifted,
    resolutionIdentityDriftReason: resolutionState.identityDriftReason,
    resolutionWorkerRunId: resolutionState.ready
      ? row.resolution_worker_run_id
      : null,
    resolutionAttestedAt: resolutionState.ready
      ? row.resolution_attested_at
      : null,
    // Feedback actors are reporters, not workflow assignees. Keep ownership
    // functional until a durable assignee field exists.
    ownerEmail: null,
    draftPolicyRuleId: row.proposed_rule_id,
    draftRuleActive: isGloballyActiveMonitoringPolicyRule(
      row.proposed_rule_id || "",
    ),
    draftSummary:
      jsonText(draftRule?.summary) ||
      jsonText(draftRule?.boundary) ||
      jsonText(draftArtifact?.draft_summary) ||
      null,
    legitimateNegativeEventIds: uniqueTexts(
      jsonArray(draftArtifact?.legitimate_negative_event_ids),
    ),
    blockingReport,
    latestRejectedAttempt,
    shadowReport,
    regressionReport: normalizeGenericEvidence(
      stageEvidence(artifacts, "regression_tests_pass"),
      "passed",
    ),
    hashAttestation: normalizeHashEvidence(
      stageEvidence(artifacts, "app_worker_hashes_match"),
    ),
    canaryReport: normalizeGenericEvidence(
      stageEvidence(artifacts, "six_pm_canary"),
      "passed",
    ),
    retroactiveSweepReport: normalizeRetroactiveSweepEvidence(
      stageEvidence(artifacts, "retroactive_sweep"),
    ),
    updatedAt: latestActivityAt(
      row.updated_at,
      row.latest_attempt_created_at,
      row.activation_blocked_at,
    ),
  };
}

function monitoringFeedbackResolutionState(
  row: PromotionClusterRow,
  stage: MonitoringFeedbackPromotionStage | null,
  activation: JsonObject | null,
  app: MonitoringPromotionAppIdentity,
) {
  const postSweep =
    stage === "retroactive_sweep" &&
    row.activation_status === "sweep_completed";
  if (!postSweep) {
    return {
      ready: false,
      identityDrifted: false,
      identityDriftReason: null,
    };
  }

  if (!activation) {
    return {
      ready: false,
      identityDrifted: true,
      identityDriftReason:
        "The immutable activation identity is missing from the completed sweep artifact. Final resolution is blocked; restore the exact inactive app and worker deployment and complete the rollback audit.",
    };
  }

  const comparisons = [
    ["app revision", app.revision, activation.app_revision, activation.worker_revision],
    [
      "policy bundle",
      app.policy_hash,
      activation.app_policy_hash,
      activation.worker_policy_hash,
    ],
    [
      "Batch policy",
      app.batch_policy_hash,
      activation.app_batch_policy_hash,
      activation.worker_batch_policy_hash,
    ],
    [
      "suppression policy",
      app.suppression_policy_hash,
      activation.app_suppression_policy_hash,
      activation.worker_suppression_policy_hash,
    ],
    [
      "matcher/verifier bundle",
      app.matcher_hash,
      activation.app_matcher_digest,
      activation.worker_matcher_digest,
    ],
  ] as const;
  const driftedLabels = comparisons.flatMap(
    ([label, current, immutableApp, immutableWorker]) => {
      const expectedApp = jsonText(immutableApp);
      const expectedWorker = jsonText(immutableWorker);
      return current &&
        expectedApp &&
        expectedWorker &&
        current === expectedApp &&
        current === expectedWorker
        ? []
        : [label];
    },
  );
  const identityDrifted = driftedLabels.length > 0;
  const identityDriftReason = identityDrifted
    ? `Post-sweep identity drift blocks resolution: ${driftedLabels.join(", ")} ${driftedLabels.length === 1 ? "does" : "do"} not match the immutable activated app/worker identity. Restore the exact inactive deployment and complete the hourly rollback audit.`
    : null;
  const ready = Boolean(
    !identityDrifted &&
      row.resolution_ready === true &&
      row.resolution_worker_run_id &&
      row.resolution_attested_at,
  );

  return { ready, identityDrifted, identityDriftReason };
}

function stageEvidence(
  artifacts: JsonObject,
  stage: MonitoringFeedbackPromotionStage,
) {
  return jsonObject(artifacts[stage]);
}

function failedAttemptEvidence(
  value: Json | null,
  failureReason: string | null,
  requestedStage: MonitoringFeedbackPromotionStage | null,
  attemptedAt: string | null,
  legitimateCollisionCount: number,
  legitimateCollisions: Json[],
): MonitoringFeedbackPromotionEvidence {
  const evidence = jsonObject(value) || {};
  const isShadowAttempt = requestedStage === "historical_shadow_test";
  return {
    ...evidence,
    status: "failed",
    report_id:
      jsonText(evidence.report_id) || jsonText(evidence.run_id) || undefined,
    digest:
      jsonText(evidence.digest) || jsonText(evidence.report_hash) || undefined,
    summary:
      jsonText(evidence.summary) ||
      failureReason ||
      "This verification attempt did not pass.",
    failure_reason: failureReason || jsonText(evidence.failure_reason),
    requested_stage: requestedStage || jsonText(evidence.requested_stage),
    completed_at:
      jsonText(evidence.completed_at) || attemptedAt || undefined,
    legitimate_updates_suppressed: isShadowAttempt
      ? (jsonNumber(evidence.legitimate_updates_suppressed) ??
        legitimateCollisionCount)
      : jsonNumber(evidence.legitimate_updates_suppressed),
    legitimate_updates: isShadowAttempt
      ? (jsonArray(evidence.legitimate_updates).length > 0
        ? jsonArray(evidence.legitimate_updates)
        : legitimateCollisions)
      : evidence.legitimate_updates,
  };
}

function normalizeShadowEvidence(
  evidence: JsonObject,
  legitimateCollisionCount: number,
  legitimateCollisions: Json[],
): MonitoringFeedbackPromotionEvidence {
  return {
    ...evidence,
    status: evidenceStatus(evidence, "passed"),
    report_id: jsonText(evidence.report_id) || jsonText(evidence.run_id) || undefined,
    digest: jsonText(evidence.digest) || jsonText(evidence.report_hash) || undefined,
    summary: jsonText(evidence.summary) || jsonText(evidence.failure_reason) || undefined,
    completed_at: jsonText(evidence.completed_at) || undefined,
    total_history_checked:
      jsonNumber(evidence.total_history_checked) ??
      jsonNumber(evidence.events_scanned),
    proposed_rule_matches:
      jsonNumber(evidence.proposed_rule_matches) ??
      jsonNumber(evidence.matched_feedback_count),
    legitimate_updates_suppressed: legitimateCollisionCount,
    legitimate_updates: legitimateCollisions,
  };
}

function normalizeGenericEvidence(
  evidence: JsonObject | null,
  passKey: string,
): MonitoringFeedbackPromotionEvidence | null {
  if (!evidence) return null;
  return {
    ...evidence,
    status: evidenceStatus(evidence, passKey),
    report_id: jsonText(evidence.report_id) || jsonText(evidence.run_id) || undefined,
    digest: jsonText(evidence.digest) || jsonText(evidence.report_hash) || undefined,
    summary: jsonText(evidence.summary) || jsonText(evidence.failure_reason) || undefined,
    completed_at: jsonText(evidence.completed_at) || undefined,
  };
}

function normalizeHashEvidence(
  evidence: JsonObject | null,
): MonitoringFeedbackPromotionEvidence | null {
  if (!evidence) return null;
  const appHashes = jsonObject(evidence.app_hashes);
  const workerHashes = jsonObject(evidence.worker_hashes);
  return {
    ...evidence,
    status: evidenceStatus(evidence, "matched"),
    summary: jsonText(evidence.summary) || jsonText(evidence.failure_reason) || undefined,
    app_policy_hash:
      jsonText(evidence.app_policy_hash) || jsonText(appHashes?.full) || undefined,
    worker_policy_hash:
      jsonText(evidence.worker_policy_hash) ||
      jsonText(workerHashes?.full) ||
      undefined,
    app_batch_policy_hash:
      jsonText(evidence.app_batch_policy_hash) ||
      jsonText(appHashes?.batch) ||
      undefined,
    worker_batch_policy_hash:
      jsonText(evidence.worker_batch_policy_hash) ||
      jsonText(workerHashes?.batch) ||
      undefined,
    app_suppression_policy_hash:
      jsonText(evidence.app_suppression_policy_hash) ||
      jsonText(appHashes?.suppression) ||
      undefined,
    worker_suppression_policy_hash:
      jsonText(evidence.worker_suppression_policy_hash) ||
      jsonText(workerHashes?.suppression) ||
      undefined,
  };
}

function normalizeRetroactiveSweepEvidence(
  evidence: JsonObject | null,
): MonitoringFeedbackPromotionEvidence | null {
  if (!evidence) return null;
  const completed = evidence.completed === true;
  const cursorComplete = evidence.cursor_complete === true;
  const failureCount = jsonNumber(evidence.failure_count);
  return {
    ...evidence,
    status:
      jsonText(evidence.status) ||
      (completed && cursorComplete && failureCount === 0 ? "completed" : "failed"),
    report_id: jsonText(evidence.report_id) || jsonText(evidence.run_id) || undefined,
    digest: jsonText(evidence.digest) || jsonText(evidence.report_hash) || undefined,
    summary: jsonText(evidence.summary) || jsonText(evidence.failure_reason) || undefined,
    completed_at: jsonText(evidence.completed_at) || undefined,
  };
}

function evidenceStatus(evidence: JsonObject, passKey: string) {
  const explicit = jsonText(evidence.status);
  if (explicit) return explicit;
  return evidence[passKey] === true ? "passed" : "failed";
}

function promotionStage(value: unknown): MonitoringFeedbackPromotionStage | null {
  const text = typeof value === "string" ? value : null;
  return isMonitoringFeedbackPromotionStage(text)
    ? (text as MonitoringFeedbackPromotionStage)
    : null;
}

function uniqueTexts(values: Array<Json | undefined>) {
  return [...new Set(values.map(jsonText).filter((value): value is string => Boolean(value)))];
}

function jsonObject(value: Json | undefined | null): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function jsonArray(value: Json | undefined | null): Json[] {
  return Array.isArray(value) ? value : [];
}

function jsonText(value: Json | undefined | null) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function jsonNumber(value: Json | undefined | null) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function latestActivityAt(...values: Array<string | null>) {
  return values.reduce<string | null>((latest, value) => {
    if (!value) return latest;
    if (!latest) return value;
    const valueMs = new Date(value).getTime();
    const latestMs = new Date(latest).getTime();
    if (!Number.isFinite(valueMs)) return latest;
    if (!Number.isFinite(latestMs) || valueMs > latestMs) return value;
    return latest;
  }, null);
}

function promotionClusterLoadError(message: string) {
  return /list_monitoring_feedback_promotion_clusters|monitoring_feedback_promotion_clusters|schema cache|PGRST202|42P01/i.test(
    message,
  )
    ? "Verified feedback promotion is not migrated for this deployment yet. Immediate event suppression is still active."
    : message;
}
