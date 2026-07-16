import type { AdminPageIssue, PageIssueSeverity } from "@/lib/admin-page-issues";
import {
  awardMonitoringPolicyIdentity,
  visualReviewBatchPolicyIdentity,
} from "@/lib/award-monitoring-policy";
import type { Json } from "@/lib/database.types";
import { monitoringFeedbackEvidenceSummary } from "@/lib/monitoring-feedback";
import {
  monitoringFeedbackPromotionFailedGate,
  monitoringFeedbackPromotionNeedsActivationRollback,
  monitoringFeedbackPromotionPostSweepDeactivated,
  monitoringFeedbackPromotionProgress,
  monitoringFeedbackPromotionSafeAction,
  monitoringFeedbackPromotionStageCopy,
  type MonitoringFeedbackPromotionCluster,
} from "@/lib/monitoring-feedback-promotion";

export const operatorActionInboxSchemaVersion = "operator-action-inbox-v1";

export type OperatorActionState = "blocked" | "needs_operator" | "auto_retrying";
export type OperatorChargeLevel = "none" | "will_charge" | "may_charge" | "unknown";

export type OperatorActionInboxItem = {
  schemaVersion: typeof operatorActionInboxSchemaVersion;
  id: string;
  fingerprint: string;
  sourceKind:
    | "page_issue"
    | "nightly_scan"
    | "visual_review"
    | "monitoring_feedback"
    | "digest_delivery"
    | "inbox_load";
  severity: PageIssueSeverity;
  severityLabel: "Urgent" | "Important" | "Routine";
  state: OperatorActionState;
  stateLabel: string;
  title: string;
  context: string | null;
  failureReason: string;
  occurredAt: string | null;
  ageLabel: string;
  owner: {
    label: string;
    detail: string;
  };
  publicImpact: {
    level: "blocked" | "delayed" | "protected" | "none" | "unknown";
    label: string;
    detail: string;
  };
  retry: {
    automatic: boolean;
    label: string;
    detail: string;
  };
  charge: {
    level: OperatorChargeLevel;
    label: string;
    detail: string;
  };
  recommendedAction: {
    label: string;
    detail: string;
    href: string | null;
  };
  evidence: Array<{
    label: string;
    value: string;
  }>;
  policy: {
    id: string;
    version: string;
    hash: string | null;
    description: string;
  };
  award: {
    id: string;
    slug: string | null;
    name: string;
  } | null;
  source: {
    id: string | null;
    title: string;
    url: string | null;
  } | null;
  action:
    | { kind: "source"; sourceId: string; sourceTitle: string }
    | { kind: "source_intake" }
    | { kind: "none" };
};

export type OperatorNightlyFailureInput = {
  code: string;
  label: string;
  severity: "warning" | "critical";
  count: number;
  sourceCount: number;
  retryMode: string;
  repairCode: string;
  solution: string;
};

export type OperatorVisualReviewFailureInput = {
  id: string;
  awardId: string;
  sourceId: string;
  sourceTitle: string;
  sourceUrl: string;
  candidateSignature: string;
  rejectionReason: string | null;
  batchName: string | null;
  model: string | null;
  estimatedCostUsd: number | null;
  workerMetadata: Json;
  updatedAt: string;
};

export type OperatorDigestDeliveryFailureInput = {
  id: string;
  deliveryType: string;
  digestKey: string | null;
  recipient: string | null;
  recipientHash?: string | null;
  changeEventCount?: number;
  error: string | null;
  createdAt: string;
};

export type BuildOperatorActionInboxInput = {
  issues: AdminPageIssue[];
  promotionClusters?: MonitoringFeedbackPromotionCluster[];
  nightlyFailureGroups?: OperatorNightlyFailureInput[];
  nightlyReportedAt?: string | null;
  visualReviewFailures?: OperatorVisualReviewFailureInput[];
  digestDeliveryFailures?: OperatorDigestDeliveryFailureInput[];
  loadErrors?: string[];
  now?: Date;
};

const retiredIssueCategories = new Set([
  "award_structure_scan_failed",
  "source_missing_cycle_relevance",
  "source_missing_evidence",
  "unclear_open_source",
  "unreviewed_open_source",
]);

export function buildOperatorActionInbox({
  issues,
  promotionClusters = [],
  nightlyFailureGroups = [],
  nightlyReportedAt = null,
  visualReviewFailures = [],
  digestDeliveryFailures = [],
  loadErrors = [],
  now = new Date(),
}: BuildOperatorActionInboxInput) {
  const items = [
    ...issues
      .filter((issue) => !retiredIssueCategories.has(issue.category))
      .map((issue) => pageIssueToAction(issue, now)),
    ...nightlyFailureGroups
      .filter(shouldIncludeNightlyFailure)
      .map((failure) => nightlyFailureToAction(failure, nightlyReportedAt, now)),
    ...visualReviewFailures.map((failure) => visualReviewFailureToAction(failure, now)),
    ...promotionClusters.map((cluster) => monitoringFeedbackClusterToAction(cluster, now)),
    ...digestDeliveryFailures.map((failure) => digestDeliveryFailureToAction(failure, now)),
    ...(loadErrors.length > 0 ? [loadErrorToAction(loadErrors, now)] : []),
  ];

  return dedupeActions(items).sort(compareActions);
}

export function operatorActionInboxSummary(items: OperatorActionInboxItem[]) {
  const needsOperator = items.filter((item) => item.state !== "auto_retrying").length;
  const autoRetrying = items.filter((item) => item.state === "auto_retrying").length;
  const publicBlockers = items.filter((item) => item.publicImpact.level === "blocked").length;
  const publicImpactUnknown = items.filter(
    (item) => item.publicImpact.level === "unknown",
  ).length;
  return {
    total: items.length,
    needsOperator,
    autoRetrying,
    publicBlockers,
    publicImpactUnknown,
  };
}

export function formatOperatorActionAge(value: string | null, now = new Date()) {
  if (!value) return "Age unavailable";
  const then = new Date(value).getTime();
  const nowMs = now.getTime();
  if (!Number.isFinite(then) || !Number.isFinite(nowMs)) return "Age unavailable";

  const elapsedMs = Math.max(0, nowMs - then);
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m old`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h old`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d old`;
  const weeks = Math.floor(days / 7);
  if (weeks < 9) return `${weeks}w old`;
  const months = Math.floor(days / 30);
  return `${Math.max(1, months)}mo old`;
}

function pageIssueToAction(issue: AdminPageIssue, now: Date): OperatorActionInboxItem {
  const disposition = issueDisposition(issue);
  const impact = issuePublicImpact(issue);
  const policy = issuePolicy(issue);
  const evidence = compactEvidence([
    ["Issue", issue.key],
    ["Category", issue.category],
    ["Area", issue.area],
    ["Current state", issue.currentValue],
    ["Source ID", issue.sourceId],
    ["Worker run", issue.relatedWorkerRunId],
    ["Consecutive failures", issue.failures > 0 ? String(issue.failures) : null],
    ["Last reported", issue.checkedAt],
  ]);
  const isSourceIntake = issue.category.startsWith("source_intake_");
  const action = isSourceIntake
    ? ({ kind: "source_intake" } as const)
    : issue.sourceId
      ? ({ kind: "source", sourceId: issue.sourceId, sourceTitle: issue.sourceTitle } as const)
      : ({ kind: "none" } as const);

  return {
    schemaVersion: operatorActionInboxSchemaVersion,
    id: issue.key,
    fingerprint: issueFingerprint(issue),
    sourceKind: "page_issue",
    severity: issue.severity,
    severityLabel: severityLabel(issue.severity),
    state: disposition.state,
    stateLabel: stateLabel(disposition.state),
    title: issueTitle(issue),
    context: issue.sourceTitle || issue.awardName || null,
    failureReason: issue.message,
    occurredAt: issue.checkedAt,
    ageLabel: formatOperatorActionAge(issue.checkedAt, now),
    owner: disposition.owner,
    publicImpact: impact,
    retry: disposition.retry,
    charge: disposition.charge,
    recommendedAction: {
      label: recommendedActionLabel(issue),
      detail: issue.recommendedAction || "Inspect the evidence and resolve only the failed stage.",
      href: isSourceIntake ? "/dashboard/admin/source-intake" : null,
    },
    evidence,
    policy,
    award: issue.awardId
      ? { id: issue.awardId, slug: issue.awardSlug, name: issue.awardName }
      : null,
    source: issue.sourceTitle || issue.sourceUrl || issue.sourceId
      ? { id: issue.sourceId, title: issue.sourceTitle, url: issue.sourceUrl }
      : null,
    action,
  };
}

function issueDisposition(issue: AdminPageIssue): Pick<
  OperatorActionInboxItem,
  "state" | "owner" | "retry" | "charge"
> {
  const message = `${issue.message} ${issue.currentValue || ""}`.toLowerCase();
  const functionalOwner = (label: string) => ({
    label,
    detail: "Functional owner; no individual assignee is stored.",
  });

  if (issue.category === "gemini_billing_blocked") {
    return {
      state: "blocked",
      owner: functionalOwner("Platform admin"),
      retry: {
        automatic: false,
        label: "Blocked until billing is fixed",
        detail: "Queued AI work can resume after billing or quota is restored; it cannot safely retry before then.",
      },
      charge: {
        level: "will_charge",
        label: "Yes — Gemini Batch",
        detail: "Resuming the queued AI work submits or completes paid Gemini Batch processing.",
      },
    };
  }

  if (issue.category === "award_reconciliation_failed" && issue.currentValue === "processing") {
    return {
      state: "auto_retrying",
      owner: { label: "AwardPing", detail: "Automatic reconciliation worker." },
      retry: {
        automatic: true,
        label: "Yes — after 45 minutes",
        detail: "A stale processing claim returns to pending automatically. Last-known-good public facts stay in place.",
      },
      charge: noPaidAiCharge("Reconciliation itself does not submit a paid AI request."),
    };
  }

  if (issue.category === "source_check_failed" && isTransientCaptureFailure(message)) {
    return {
      state: "auto_retrying",
      owner: { label: "AwardPing", detail: "Automatic 6 PM source scan." },
      retry: {
        automatic: true,
        label: "Yes — next 6 PM scan",
        detail: "The source will be retried with the next scheduled capture. Its last-known-good evidence is preserved.",
      },
      charge: noPaidAiCharge("The capture retry does not create a Gemini Batch job."),
    };
  }

  if (issue.category === "source_check_failed" && isAccessOrIdentityFailure(message)) {
    return {
      state: "blocked",
      owner: functionalOwner("Source review"),
      retry: {
        automatic: false,
        label: "No — source decision needed",
        detail: "A moved, blocked, expired, or missing page should not be retried indefinitely without confirming its official replacement.",
      },
      charge: noPaidAiCharge("Reviewing or recapturing the source does not submit paid AI work."),
    };
  }

  if (issue.category.startsWith("source_intake_")) {
    return {
      state: "needs_operator",
      owner: functionalOwner("Source intake"),
      retry: {
        automatic: false,
        label: "No — choose a safe action",
        detail: "Open Source Intake to retry capture, reject, attach, or rerun AI from the request's actual state.",
      },
      charge: {
        level: "may_charge",
        label: "Possible — Gemini Batch",
        detail: "Capture-only recovery is not a paid AI call. Rerunning AI review or advancing a plausible page can create a Gemini Batch charge.",
      },
    };
  }

  if (issue.area === "Page audit") {
    return {
      state: "needs_operator",
      owner: functionalOwner("Content review"),
      retry: {
        automatic: false,
        label: "No — resolve the finding",
        detail: "The public page stays on last-known-good facts until reconciliation and the audit finding are resolved.",
      },
      charge: {
        level: "may_charge",
        label: "Possible — Gemini Batch",
        detail: "Reconciliation has no paid AI call. A newly flagged page-audit rerun can submit a paid Gemini Batch request.",
      },
    };
  }

  if (issue.category === "award_reconciliation_failed" || issue.category === "award_missing_public_facts") {
    return {
      state: "needs_operator",
      owner: functionalOwner("Content review"),
      retry: {
        automatic: false,
        label: "No — failed rows need rerun",
        detail: "Retry only the affected award reconciliation. Do not replace last-known-good public facts to clear the error.",
      },
      charge: noPaidAiCharge("Award reconciliation has no direct paid AI request."),
    };
  }

  if (
    issue.category === "source_quality_rejected_but_monitoring_enabled" ||
    issue.category === "unrelated_source_still_open" ||
    issue.category === "sibling_source_still_open" ||
    issue.category === "public_facts_using_rejected_source"
  ) {
    return {
      state: "needs_operator",
      owner: functionalOwner("Source review"),
      retry: {
        automatic: false,
        label: "No — source decision needed",
        detail: "The source is policy-blocked. Move it out of monitoring or correct its evidence before any retry.",
      },
      charge: noPaidAiCharge("Moving or correcting the source does not submit a paid AI request."),
    };
  }

  if (issue.category === "worker_page_error") {
    const providerNamed = /api|batch|cloudflare|gemini|provider|r2|resend|s3|stripe/i.test(message);
    return {
      state: "needs_operator",
      owner: functionalOwner(/gemini|batch|ai\b/i.test(message) ? "AI review" : "Platform admin"),
      retry: {
        automatic: false,
        label: "No — inspect the failed stage",
        detail: "Confirm the failed provider stage and whether an external request already exists before retrying.",
      },
      charge: {
        level: "unknown",
        label: "Unknown — do not retry blindly",
        detail: providerNamed
          ? "The worker error names an external provider but does not prove whether the paid request completed or was created. Reconcile that evidence first."
          : "The generic worker error does not identify the provider or charge outcome. Inspect the failed stage before retrying.",
      },
    };
  }

  return {
    state: "needs_operator",
    owner: functionalOwner(issue.sourceId ? "Source review" : "Platform admin"),
    retry: {
      automatic: false,
      label: "No — operator review",
      detail: "Inspect the evidence, then retry only the failed idempotent stage.",
    },
    charge: noPaidAiCharge("This recovery path does not create a paid AI request unless a later action explicitly says so."),
  };
}

function issuePublicImpact(issue: AdminPageIssue): OperatorActionInboxItem["publicImpact"] {
  if (issue.area === "Page audit" || issue.category === "award_reconciliation_failed" || issue.category === "award_missing_public_facts") {
    return {
      level: "blocked",
      label: "Public page update blocked",
      detail: "AwardPing keeps the last-known-good public facts until this is resolved.",
    };
  }
  if (issue.category === "gemini_billing_blocked") {
    return {
      level: "delayed",
      label: "Updates and page reviews delayed",
      detail: "Paid AI review cannot advance, so verified publication work waits in queue.",
    };
  }
  if (issue.category.startsWith("source_intake_")) {
    return {
      level: "none",
      label: "No public impact yet",
      detail: "The submitted source has not been admitted to monitoring or public facts.",
    };
  }
  if (
    issue.category === "source_quality_rejected_but_monitoring_enabled" ||
    issue.category === "unrelated_source_still_open" ||
    issue.category === "sibling_source_still_open" ||
    issue.category === "public_facts_using_rejected_source"
  ) {
    return {
      level: "protected",
      label: "Public data protected",
      detail: "The hardened gate blocks this source, but its open status still needs correction.",
    };
  }
  if (issue.category === "source_check_failed") {
    return {
      level: "delayed",
      label: "One source is delayed",
      detail: "No new update can be verified from this source; last-known-good evidence remains available.",
    };
  }
  if (issue.area === "Publishing" || issue.area === "R2 snapshot") {
    return {
      level: "delayed",
      label: "Evidence publication delayed",
      detail: "The failed downstream stage prevents the affected evidence from publishing.",
    };
  }
  return {
    level: "delayed",
    label: "Monitoring work delayed",
    detail: "The affected item cannot advance until the failed stage is resolved.",
  };
}

function issuePolicy(issue: AdminPageIssue): OperatorActionInboxItem["policy"] {
  const identity = issue.area === "AI review coverage" || /gemini|visual review/i.test(issue.area)
    ? visualReviewBatchPolicyIdentity
    : awardMonitoringPolicyIdentity;
  return {
    id: identity.id,
    version: identity.version,
    hash: identity.hash,
    description: "Current policy used to classify this queue item; historical rows do not all retain their original policy hash.",
  };
}

function nightlyFailureToAction(
  failure: OperatorNightlyFailureInput,
  reportedAt: string | null,
  now: Date,
): OperatorActionInboxItem {
  const automatic = failure.retryMode === "automatic_next_scan";
  const state: OperatorActionState = automatic ? "auto_retrying" : "needs_operator";
  const severity: PageIssueSeverity = failure.severity === "critical" ? "high" : "medium";
  const countLabel = failure.count === 1 ? "1 failure" : `${failure.count} failures`;
  return {
    schemaVersion: operatorActionInboxSchemaVersion,
    id: `nightly:${failure.code}`,
    fingerprint: `nightly:${failure.code}`,
    sourceKind: "nightly_scan",
    severity,
    severityLabel: severityLabel(severity),
    state,
    stateLabel: stateLabel(state),
    title: `6 PM scan: ${failure.label}`,
    context: `${countLabel}${failure.sourceCount > 0 ? ` across ${failure.sourceCount} sources` : ""}`,
    failureReason: failure.label,
    occurredAt: reportedAt,
    ageLabel: formatOperatorActionAge(reportedAt, now),
    owner: automatic
      ? { label: "AwardPing", detail: "Automatic 6 PM source scan." }
      : { label: "Platform admin", detail: "Functional owner; no individual assignee is stored." },
    publicImpact: {
      level: "delayed",
      label: "Monitoring coverage delayed",
      detail: "The affected source pages or shard did not complete the scheduled scan.",
    },
    retry: {
      automatic,
      label: automatic ? "Yes — next 6 PM scan" : "No — repair then restart one shard",
      detail: automatic
        ? "AwardPing will retry with the next scheduled scan. Completed shards are not rerun."
        : "Inspect the task and log, repair the cause, then restart only the affected shard.",
    },
    charge: noPaidAiCharge("The 6 PM capture retry does not create a Gemini Batch job."),
    recommendedAction: {
      label: automatic ? "Let the scheduled retry run" : "Repair only the affected shard",
      detail: failure.solution,
      href: null,
    },
    evidence: compactEvidence([
      ["Failure code", failure.code],
      ["Repair code", failure.repairCode],
      ["Retry mode", failure.retryMode],
      ["Failure count", String(failure.count)],
      ["Affected sources", String(failure.sourceCount)],
      ["Last reported", reportedAt],
    ]),
    policy: currentMonitoringPolicy("Current monitoring policy used by the 6 PM capture report."),
    award: null,
    source: null,
    action: { kind: "none" },
  };
}

function visualReviewFailureToAction(
  failure: OperatorVisualReviewFailureInput,
  now: Date,
): OperatorActionInboxItem {
  const metadata = objectValue(failure.workerMetadata);
  const retryCount = Math.max(0, integerValue(metadata.failure_retry_count));
  const reason = cleanText(failure.rejectionReason) || "Visual review failed without a recorded reason.";
  const missingResponse = reason === "missing_batch_response";
  const ambiguousExternalBatch = reason === "manual_recovery_required_possible_external_batch_created";
  const retryLimitReached = retryCount >= 3;
  const automatic = missingResponse || (!ambiguousExternalBatch && !retryLimitReached);
  const state: OperatorActionState = ambiguousExternalBatch
    ? "blocked"
    : automatic
      ? "auto_retrying"
      : "needs_operator";
  const severity: PageIssueSeverity = state === "auto_retrying" ? "medium" : "high";
  const retry = ambiguousExternalBatch
    ? {
        automatic: false,
        label: "No — external Batch uncertain",
        detail: "Do not submit another Batch until the possible external creation is reconciled.",
      }
    : missingResponse
      ? {
          automatic: true,
          label: "Yes — recover existing result",
          detail: "AwardPing will look for the missing response from the existing Batch without resubmitting it.",
        }
      : retryLimitReached
        ? {
            automatic: false,
            label: "No — retry limit reached",
            detail: "Three paid retries have failed. Inspect the evidence and cause before any new submission.",
          }
        : {
            automatic: true,
            label: `Yes — attempt ${retryCount + 1} of 3`,
            detail: "The failed candidate will be submitted in a new Gemini Batch attempt.",
          };
  const charge: OperatorActionInboxItem["charge"] = ambiguousExternalBatch
    ? {
        level: "unknown",
        label: "Unknown — do not retry",
        detail: "The worker cannot prove whether the external Batch was created, so a second submission could duplicate a charge.",
      }
    : missingResponse
      ? noPaidAiCharge("Recovery reuses the existing Gemini Batch and does not create a new submission.")
      : {
          level: "will_charge",
          label: "Yes — Gemini Batch",
          detail: "Every visual-review resubmission creates a new paid Gemini Batch request.",
        };

  return {
    schemaVersion: operatorActionInboxSchemaVersion,
    id: `visual-review:${failure.id}`,
    fingerprint: `visual-review:${failure.id}`,
    sourceKind: "visual_review",
    severity,
    severityLabel: severityLabel(severity),
    state,
    stateLabel: stateLabel(state),
    title: `${failure.sourceTitle}: visual review failed`,
    context: "Candidate wording change",
    failureReason: humanizeCode(reason),
    occurredAt: failure.updatedAt,
    ageLabel: formatOperatorActionAge(failure.updatedAt, now),
    owner: automatic
      ? { label: "AwardPing", detail: "Automatic visual-review worker." }
      : { label: "AI review", detail: "Functional owner; no individual assignee is stored." },
    publicImpact: {
      level: "delayed",
      label: "Update publication delayed",
      detail: "The candidate cannot become a public update until visual review completes.",
    },
    retry,
    charge,
    recommendedAction: {
      label: automatic ? "Watch the bounded retry" : "Inspect before resubmitting",
      detail: ambiguousExternalBatch
        ? "Reconcile the possible external Batch name and result first. Never use a generic retry in this state."
        : missingResponse
          ? "Allow response recovery to reuse the existing Batch."
          : retryLimitReached
            ? "Inspect the captured evidence, prompt payload, and rejection reason before approving another paid attempt."
            : "Allow the bounded automatic retry; intervene only if it reaches the retry limit.",
      href: null,
    },
    evidence: compactEvidence([
      ["Candidate", failure.id],
      ["Candidate signature", failure.candidateSignature],
      ["Award ID", failure.awardId],
      ["Source ID", failure.sourceId],
      ["Gemini Batch", failure.batchName],
      ["Model", failure.model],
      ["Retry count", String(retryCount)],
      ["Estimated prior cost", failure.estimatedCostUsd == null ? null : `$${failure.estimatedCostUsd.toFixed(4)}`],
      ["Last reported", failure.updatedAt],
    ]),
    policy: {
      id: visualReviewBatchPolicyIdentity.id,
      version: visualReviewBatchPolicyIdentity.version,
      hash: visualReviewBatchPolicyIdentity.hash,
      description: "Current bounded-retry and visual-review Batch policy.",
    },
    award: null,
    source: { id: failure.sourceId, title: failure.sourceTitle, url: failure.sourceUrl },
    action: { kind: "none" },
  };
}

function monitoringFeedbackClusterToAction(
  cluster: MonitoringFeedbackPromotionCluster,
  now: Date,
): OperatorActionInboxItem {
  const progress = monitoringFeedbackPromotionProgress(cluster.stage);
  const failedGate = monitoringFeedbackPromotionFailedGate(cluster);
  const resolutionIdentityDrifted = cluster.resolutionIdentityDrifted;
  const awaitingResolutionAttestation =
    cluster.stage === "retroactive_sweep" &&
    cluster.draftRuleActive &&
    !resolutionIdentityDrifted &&
    !cluster.resolutionReady;
  const appActivationParityPending =
    cluster.stage === "six_pm_canary" &&
    cluster.draftRuleActive;
  const isManualStage =
    cluster.stage === null ||
    cluster.stage === "triaged" ||
    cluster.stage === "similar_feedback_clustered" ||
    (cluster.stage === "six_pm_canary" && !cluster.draftRuleActive) ||
    (cluster.stage === "retroactive_sweep" &&
      (cluster.resolutionReady || resolutionIdentityDrifted));
  const isCanaryStage = cluster.stage === "app_worker_hashes_match";
  const activationBlocked = monitoringFeedbackPromotionNeedsActivationRollback(
    cluster.activationStatus,
  );
  const postSweepDeactivated =
    monitoringFeedbackPromotionPostSweepDeactivated(cluster);
  const automaticRetry =
    activationBlocked ||
    postSweepDeactivated ||
    (!resolutionIdentityDrifted &&
      (awaitingResolutionAttestation ||
        !isManualStage ||
        (Boolean(failedGate) && cluster.stage === "six_pm_canary")));
  const sampleEvidence = Array.isArray(cluster.sampleFeedback)
    ? cluster.sampleFeedback[0]
    : cluster.sampleFeedback;
  const sampleRecord =
    sampleEvidence && typeof sampleEvidence === "object" && !Array.isArray(sampleEvidence)
      ? sampleEvidence
      : null;
  const sourceTitle = jsonText(sampleRecord?.source_title) || "Clustered monitoring feedback";
  const sourceUrl = jsonText(sampleRecord?.source_url);
  const sourceId = jsonText(sampleRecord?.source_id);
  const eventSummary = jsonText(sampleRecord?.event_summary);
  const sampleCapturedEvidence = sampleRecord?.event_evidence
    ? monitoringFeedbackEvidenceSummary(sampleRecord.event_evidence)
    : null;
  const stageLabel = cluster.stage
    ? monitoringFeedbackPromotionStageCopy[cluster.stage].label
    : "Ready for triage";
  const occurrenceLabel = `${cluster.recurrenceCount.toLocaleString("en-US")} ${cluster.recurrenceCount === 1 ? "occurrence" : "occurrences"}`;
  const sourceCountLabel = `${cluster.sourceCount.toLocaleString("en-US")} ${cluster.sourceCount === 1 ? "source" : "sources"}`;
  const severity: PageIssueSeverity = failedGate ? "high" : "medium";
  const state: OperatorActionState = failedGate
    ? "blocked"
    : isManualStage
      ? "needs_operator"
      : "auto_retrying";

  return {
    schemaVersion: operatorActionInboxSchemaVersion,
    id: `monitoring-feedback-cluster:${cluster.clusterKey}`,
    fingerprint: `monitoring-feedback-cluster:${cluster.clusterKey}`,
    sourceKind: "monitoring_feedback",
    severity,
    severityLabel: severityLabel(severity),
    state,
    stateLabel: stateLabel(state),
    title: `Repeated false-update pattern: ${humanizeCode(cluster.reasonCode)}`,
    context: `${cluster.domainTemplate} · ${occurrenceLabel} across ${sourceCountLabel} · Step ${progress.completed} of ${progress.total}`,
    failureReason:
      failedGate ||
      (awaitingResolutionAttestation
        ? "The retroactive sweep passed. Resolve stays locked until the next normal hourly worker records a matching zero-charge attestation."
        : null) ||
      (appActivationParityPending
        ? "App activation detected; worker parity is pending before AwardPing can continue the bounded historical sweep."
        : null) ||
      eventSummary ||
      "Similar corrections are waiting for a verified global rule.",
    occurredAt: cluster.updatedAt || cluster.lastSeenAt,
    ageLabel: formatOperatorActionAge(cluster.updatedAt || cluster.lastSeenAt, now),
    owner: {
      label: state === "auto_retrying" ? "AwardPing" : "Policy review",
      detail:
        state === "auto_retrying"
          ? "Automatic verified-promotion workflow. A person is needed only if a gate fails."
          : cluster.ownerEmail
            ? `Assigned to ${cluster.ownerEmail}.`
            : "Functional owner; no individual assignee is stored.",
    },
    publicImpact: {
      level:
        resolutionIdentityDrifted
          ? "unknown"
          : postSweepDeactivated
          ? "blocked"
          : activationBlocked && cluster.draftRuleActive
            ? "unknown"
            : appActivationParityPending
              ? "unknown"
              : "protected",
      label: resolutionIdentityDrifted
        ? "Post-sweep identity drift requires rollback"
        : postSweepDeactivated
          ? "Post-sweep deactivation requires rollback repair"
          : activationBlocked
            ? cluster.draftRuleActive
              ? "Unverified active rule is being rolled back"
              : "Activation is blocked safely"
            : appActivationParityPending
              ? "App activation detected; worker parity pending"
              : cluster.draftRuleActive
                ? "Verified rule is active globally"
                : "Current false updates are hidden",
      detail:
        resolutionIdentityDrifted
          ? "The current app identity no longer matches the immutable activated app/worker identity. Final resolution cannot become ready; deactivate the candidate, restore the exact inactive deployment, and audit reversal of candidate-attributable suppressions."
          : postSweepDeactivated
          ? "The sweep finished, but its rule is no longer active. Do not resolve: the normal hourly no-charge worker must record deactivation, reverse candidate-attributable suppressions, and return the workflow to draft."
          : activationBlocked
          ? cluster.draftRuleActive
            ? "New evidence invalidated the sealed canary revision. Stop further historical mutation, restore the inactive deployment, and audit reversal of every candidate-attributable suppression before redrafting."
            : "The candidate is inactive and no further historical mutation is allowed. AwardPing is verifying the rollback and suppression-reversal audit before redrafting."
          : appActivationParityPending
            ? "The current app policy contains the candidate, but activated worker parity is not proven. Do not describe global suppression as verified until the hourly identity check advances the workflow."
            : cluster.draftRuleActive
              ? "The verified active deployment suppresses matching future events. The cluster stays open until the bounded historical sweep is verified."
              : "Each reported event stays suppressed immediately. Similar future events remain unchanged until every global activation gate passes.",
    },
    retry: {
      automatic: automaticRetry,
      label:
        automaticRetry
          ? postSweepDeactivated
            ? "Yes — hourly rollback/deactivation repair"
            : activationBlocked
            ? "Yes — hourly rollback verification"
            : cluster.stage === "app_worker_hashes_match"
            ? "Yes — next scheduled 6 PM scan"
            : cluster.stage === "six_pm_canary" && cluster.draftRuleActive
              ? "Yes — hourly activated-deployment verification"
            : awaitingResolutionAttestation
              ? "Yes — next normal hourly attestation"
            : failedGate
              ? "Yes — hourly verified-stage retry"
              : "Yes — verified stage runner"
          : failedGate
            ? resolutionIdentityDrifted
              ? "No — restore the inactive deployment"
              : "No — repair the failed gate"
            : "No — operator checkpoint",
      detail:
        automaticRetry
          ? postSweepDeactivated
            ? "The normal hourly no-charge worker records the inactive deployment, reverses candidate-attributable suppressions, and returns the cluster to draft before any resolution can occur."
            : activationBlocked
            ? "AwardPing retries only the no-charge identity check. It cannot pass until the rule is inactive and the app and worker run the same restored revision."
            : awaitingResolutionAttestation
              ? "The normal hourly promotion worker records one reusable cluster-bound attestation. It creates no paid API request and does not wait for another 6 PM scan."
            : failedGate
            ? "The runner will retry the unchanged evidence automatically, but a rule, deployment, or source repair may still be required before it can pass."
            : "Automation advances only after it records passing evidence for the next exact stage."
          : resolutionIdentityDrifted
            ? "A normal hourly attestation cannot match the stale activated identity. A person must first deactivate the candidate and restore the exact inactive app and worker deployment."
            : "The workflow cannot advance until the displayed operator checkpoint or failed gate is resolved.",
    },
    charge: isCanaryStage
      ? {
          level: "may_charge",
          label: "Possible — scheduled Gemini Batch",
          detail:
            "The normal 6 PM visual-review cohort can create Gemini Batch API charges; the promotion workflow does not launch an extra canary run.",
        }
      : noPaidAiCharge(
          "Clustering, shadow evaluation, regression checks, hash checks, and final resolution do not submit paid AI work.",
        ),
    recommendedAction: {
      label: resolutionIdentityDrifted
        ? "Restore the inactive deployment"
        : postSweepDeactivated
          ? "Keep inactive; let hourly rollback repair run"
          : activationBlocked
          ? "Restore the inactive deployment"
        : failedGate
          ? "Repair the blocked verification gate"
          : awaitingResolutionAttestation
            ? "Wait for the no-charge hourly attestation"
            : cluster.stage === "retroactive_sweep" && cluster.resolutionReady
              ? "Review and resolve the verified pattern"
          : stageLabel,
      detail: monitoringFeedbackPromotionSafeAction(cluster),
      href: `/dashboard/admin/issues?tab=promotions#promotion-${encodeURIComponent(cluster.workflowId || cluster.clusterKey)}`,
    },
    evidence: compactEvidence([
      ["Evidence signature", cluster.evidenceSignature],
      ["Domain template", cluster.domainTemplate],
      ["Reason", humanizeCode(cluster.reasonCode)],
      ["Recurrence", occurrenceLabel],
      ["Affected sources", sourceCountLabel],
      ["Current stage", `${stageLabel} (${progress.completed} of ${progress.total})`],
      ["Activation safety state", humanizeCode(cluster.activationStatus)],
      ["Activation blocked", cluster.activationBlockedAt],
      ["Resolution identity", cluster.resolutionIdentityDriftReason],
      [
        "Final hourly attestation",
        cluster.resolutionIdentityDrifted
          ? "Blocked by post-sweep identity drift"
          : cluster.resolutionReady
            ? cluster.resolutionAttestedAt
            : "Pending",
      ],
      ["Resolution worker run", cluster.resolutionWorkerRunId],
      [
        "Latest rejected stage",
        typeof cluster.latestRejectedAttempt?.requested_stage === "string"
          ? humanizeCode(cluster.latestRejectedAttempt.requested_stage)
          : null,
      ],
      [
        "Latest rejected reason",
        jsonText(cluster.latestRejectedAttempt?.failure_reason) ||
          cluster.latestRejectedAttempt?.summary,
      ],
      [
        "Latest rejected report",
        cluster.latestRejectedAttempt?.report_id ||
          cluster.latestRejectedAttempt?.digest,
      ],
      ["Latest rejected at", cluster.latestRejectedAttempt?.completed_at],
      ["Draft rule", cluster.draftPolicyRuleId],
      [
        "Known real update fixtures",
        cluster.legitimateNegativeEventIds.join(", ") || null,
      ],
      ["Sample evidence", sampleCapturedEvidence],
      ["Workflow ID", cluster.workflowId],
      ["First seen", cluster.firstSeenAt],
      ["Last updated", cluster.updatedAt || cluster.lastSeenAt],
    ]),
    policy: {
      id: awardMonitoringPolicyIdentity.id,
      version: awardMonitoringPolicyIdentity.version,
      hash: awardMonitoringPolicyIdentity.hash,
      description:
        "Current deployed monitoring-policy bundle. The proposed rule ID is shown separately in Evidence, and accepted stages retain their immutable draft evidence.",
    },
    award: null,
    source: {
      id: sourceId,
      title: sourceTitle,
      url: sourceUrl,
    },
    action: { kind: "none" },
  };
}

function digestDeliveryFailureToAction(
  failure: OperatorDigestDeliveryFailureInput,
  now: Date,
): OperatorActionInboxItem {
  const recipientLabel = deliveryRecipientLabel(failure);
  return {
    schemaVersion: operatorActionInboxSchemaVersion,
    id: `delivery:${failure.id}`,
    fingerprint: `delivery:${failure.id}`,
    sourceKind: "digest_delivery",
    severity: "medium",
    severityLabel: severityLabel("medium"),
    state: "needs_operator",
    stateLabel: stateLabel("needs_operator"),
    title: `${capitalize(failure.deliveryType || "email")} delivery failed`,
    context: recipientLabel,
    failureReason: failure.error || "The delivery provider returned a failure without a recorded reason.",
    occurredAt: failure.createdAt,
    ageLabel: formatOperatorActionAge(failure.createdAt, now),
    owner: {
      label: "Delivery review",
      detail: "Functional owner; no individual assignee is stored.",
    },
    publicImpact: {
      level: "blocked",
      label: "Subscriber did not receive email",
      detail: "The public site is unaffected, but this subscriber's update delivery failed.",
    },
    retry: {
      automatic: false,
      label: "No — delivery is not auto-retried",
      detail: "Inspect the address and provider error before sending one replacement. Do not create duplicate digests.",
    },
    charge: {
      level: "may_charge",
      label: "Possible — Resend",
      detail: "Sending a replacement email may create a Resend provider charge; no Gemini charge is involved.",
    },
    recommendedAction: {
      label: "Inspect, then resend once if safe",
      detail: "Correct a permanent address problem or confirm the provider recovered, then send only one replacement delivery.",
      href: null,
    },
    evidence: compactEvidence([
      ["Delivery", failure.id],
      ["Type", failure.deliveryType],
      ["Digest", failure.digestKey],
      ["Recipient", recipientLabel],
      ["Updates in digest", failure.changeEventCount == null ? null : String(failure.changeEventCount)],
      ["Failed", failure.createdAt],
    ]),
    policy: {
      id: "public-update-delivery",
      version: "not recorded",
      hash: null,
      description: "Delivery rows currently do not retain a versioned retry policy; the inbox reports that gap honestly.",
    },
    award: null,
    source: null,
    action: { kind: "none" },
  };
}

function loadErrorToAction(errors: string[], now: Date): OperatorActionInboxItem {
  const occurredAt = now.toISOString();
  return {
    schemaVersion: operatorActionInboxSchemaVersion,
    id: "inbox-load-error",
    fingerprint: "inbox-load-error",
    sourceKind: "inbox_load",
    severity: "high",
    severityLabel: severityLabel("high"),
    state: "blocked",
    stateLabel: stateLabel("blocked"),
    title: "Part of the Action Inbox could not load",
    context: `${errors.length} data source${errors.length === 1 ? "" : "s"} unavailable`,
    failureReason: errors[0] || "Unknown inbox loading error.",
    occurredAt,
    ageLabel: "Just now",
    owner: {
      label: "Platform admin",
      detail: "Functional owner; no individual assignee is stored.",
    },
    publicImpact: {
      level: "unknown",
      label: "Public impact unknown",
      detail: "The queue is incomplete, so AwardPing cannot prove that every blocker is visible here.",
    },
    retry: {
      automatic: true,
      label: "Yes — on the next page load",
      detail: "The read is attempted again when the inbox refreshes; repeated failures need platform review.",
    },
    charge: noPaidAiCharge("Reloading inbox data does not submit paid AI work."),
    recommendedAction: {
      label: "Restore the missing admin data source",
      detail: "Inspect the database error or missing migration, restore access, and reload this page before treating the inbox as complete.",
      href: null,
    },
    evidence: errors.slice(0, 8).map((error, index) => ({
      label: `Load error ${index + 1}`,
      value: error,
    })),
    policy: currentMonitoringPolicy("Current policy identity; the failed loader did not provide an event-specific policy record."),
    award: null,
    source: null,
    action: { kind: "none" },
  };
}

function issueTitle(issue: AdminPageIssue) {
  if (issue.category === "gemini_billing_blocked") return "Gemini workers are blocked";
  if (issue.category.startsWith("source_intake_")) return `${issue.awardName}: source intake needs review`;
  if (issue.area === "Page audit") return `${issue.awardName}: public page check failed`;
  if (issue.category === "award_reconciliation_failed") return `${issue.awardName}: reconciliation did not complete`;
  if (issue.category === "award_missing_public_facts") return `${issue.awardName}: public facts are missing`;
  if (
    issue.category === "source_quality_rejected_but_monitoring_enabled" ||
    issue.category === "unrelated_source_still_open" ||
    issue.category === "sibling_source_still_open"
  ) {
    return `${issue.sourceTitle}: blocked source is still open`;
  }
  return `${issue.awardName}: ${issue.label}`;
}

function recommendedActionLabel(issue: AdminPageIssue) {
  if (issue.category === "gemini_billing_blocked") return "Restore billing, then resume queued work";
  if (issue.category.startsWith("source_intake_")) return "Open Source Intake";
  if (issue.area === "Page audit" || issue.category === "award_reconciliation_failed" || issue.category === "award_missing_public_facts") return "Repair the public-page pipeline";
  if (issue.sourceId) return "Review this source";
  return "Inspect the failed stage";
}

function issueFingerprint(issue: AdminPageIssue) {
  if (
    issue.sourceId &&
    [
      "source_quality_rejected_but_monitoring_enabled",
      "unrelated_source_still_open",
      "sibling_source_still_open",
    ].includes(issue.category)
  ) {
    return `source-policy:${issue.category}:${issue.sourceId}`;
  }
  return issue.key;
}

function shouldIncludeNightlyFailure(failure: OperatorNightlyFailureInput) {
  if (failure.sourceCount === 0) return true;
  return /shard|pipeline|storage|r2|publish|legacy/i.test(`${failure.code} ${failure.repairCode}`);
}

function currentMonitoringPolicy(description: string): OperatorActionInboxItem["policy"] {
  return {
    id: awardMonitoringPolicyIdentity.id,
    version: awardMonitoringPolicyIdentity.version,
    hash: awardMonitoringPolicyIdentity.hash,
    description,
  };
}

function noPaidAiCharge(detail: string): OperatorActionInboxItem["charge"] {
  return {
    level: "none",
    label: "No paid AI call",
    detail,
  };
}

function isTransientCaptureFailure(message: string) {
  return /\b(408|425|429|5\d\d|econnreset|network|rate.?limit|temporar|timeout|timed out|render|browser closed|socket hang up)\b/i.test(message);
}

function isAccessOrIdentityFailure(message: string) {
  return /\b(401|403|404|410|blocked|captcha|certificate|cert_has_expired|domain failed|enotfound|gone|nxdomain|not found|security.challenge|ssl)\b/i.test(message);
}

function severityLabel(severity: PageIssueSeverity): OperatorActionInboxItem["severityLabel"] {
  if (severity === "high") return "Urgent";
  if (severity === "medium") return "Important";
  return "Routine";
}

function stateLabel(state: OperatorActionState) {
  if (state === "blocked") return "Blocked";
  if (state === "auto_retrying") return "Retrying automatically";
  return "Needs you";
}

function compareActions(left: OperatorActionInboxItem, right: OperatorActionInboxItem) {
  const stateDelta = stateRank(right.state) - stateRank(left.state);
  if (stateDelta !== 0) return stateDelta;
  const severityDelta = severityRank(right.severity) - severityRank(left.severity);
  if (severityDelta !== 0) return severityDelta;
  const impactDelta = impactRank(right.publicImpact.level) - impactRank(left.publicImpact.level);
  if (impactDelta !== 0) return impactDelta;
  const leftTime = dateMs(left.occurredAt) || Number.MAX_SAFE_INTEGER;
  const rightTime = dateMs(right.occurredAt) || Number.MAX_SAFE_INTEGER;
  if (leftTime !== rightTime) return leftTime - rightTime;
  return left.title.localeCompare(right.title);
}

function dedupeActions(items: OperatorActionInboxItem[]) {
  const byFingerprint = new Map<string, OperatorActionInboxItem>();
  for (const item of items) {
    const current = byFingerprint.get(item.fingerprint);
    if (!current || compareActions(item, current) < 0) byFingerprint.set(item.fingerprint, item);
  }
  return [...byFingerprint.values()];
}

function stateRank(state: OperatorActionState) {
  if (state === "blocked") return 3;
  if (state === "needs_operator") return 2;
  return 1;
}

function severityRank(severity: PageIssueSeverity) {
  if (severity === "high") return 3;
  if (severity === "medium") return 2;
  return 1;
}

function impactRank(impact: OperatorActionInboxItem["publicImpact"]["level"]) {
  if (impact === "blocked") return 5;
  if (impact === "unknown") return 4;
  if (impact === "delayed") return 3;
  if (impact === "protected") return 2;
  return 1;
}

function compactEvidence(
  entries: Array<[label: string, value: string | null | undefined]>,
) {
  return entries
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .map(([label, value]) => ({ label, value }));
}

function objectValue(value: Json): Record<string, Json | undefined> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, Json | undefined>)
    : {};
}

function integerValue(value: unknown) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function cleanText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function jsonText(value: Json | undefined) {
  const cleaned = cleanText(value);
  return cleaned || null;
}

function humanizeCode(value: string) {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\w/, (letter) => letter.toUpperCase());
}

function capitalize(value: string) {
  return value ? value[0].toUpperCase() + value.slice(1) : value;
}

function maskedRecipient(value: string | null) {
  if (!value) return "Recipient unavailable";
  const [local, domain] = value.split("@");
  if (!domain) return "Recipient recorded";
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${"•".repeat(Math.max(3, local.length - visible.length))}@${domain}`;
}

function deliveryRecipientLabel(failure: OperatorDigestDeliveryFailureInput) {
  if (failure.recipient) return maskedRecipient(failure.recipient);
  if (failure.recipientHash) return `Subscriber ${failure.recipientHash.slice(0, 10)}…`;
  return "Subscriber reference unavailable";
}

function dateMs(value: string | null) {
  const parsed = value ? new Date(value).getTime() : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}
