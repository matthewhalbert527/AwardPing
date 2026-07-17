import type { AdminPageIssue, PageIssueSeverity } from "@/lib/admin-page-issues";
import type { AdminManualQuarantineItem } from "@/lib/admin-manual-quarantine";
import {
  downstreamLaneRuntimeState,
  type AdminDownstreamLane,
} from "@/lib/admin-worker-operations";
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
    | "manual_quarantine"
    | "monitoring_feedback"
    | "digest_delivery"
    | "downstream_lane"
    | "invite_security_reissue"
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
    | {
        kind: "paid_visual_retry";
        candidateId: string;
        candidateUpdatedAt: string;
        sourceTitle: string;
      }
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
  state?: "legacy_failed" | "ambiguous" | "terminal_failed" | "release_blocked";
  digestKey: string | null;
  recipient: string | null;
  recipientHash?: string | null;
  changeEventCount?: number;
  error: string | null;
  createdAt: string;
  updatedAt?: string | null;
  payloadHash?: string | null;
  attemptCount?: number | null;
  firstProviderAttemptAt?: string | null;
  nextAttemptAt?: string | null;
  contractVersion?: string | null;
};

export type OperatorInviteSecurityReissueInput = {
  inviteId: string;
  officeId: string;
  officeName: string;
  emailHash: string;
  status: "pending_reissue" | "replacement_ready";
  rotatedAt: string;
  replacementPreparedAt: string | null;
  deliveryStatus: string | null;
  lastError: string | null;
};

export type OperatorManualQuarantineBacklogInput = {
  exactTotal: number;
  exactClusterTotal: number;
  evidenceRecords: number;
  terminalCases: number;
  unassignedCases: number;
  chargeGatedCases: number;
  oldestObservedAt: string | null;
  registrySyncedAt: string | null;
};

export type BuildOperatorActionInboxInput = {
  issues: AdminPageIssue[];
  manualQuarantineItems?: AdminManualQuarantineItem[];
  manualQuarantineBacklog?: OperatorManualQuarantineBacklogInput | null;
  promotionClusters?: MonitoringFeedbackPromotionCluster[];
  nightlyFailureGroups?: OperatorNightlyFailureInput[];
  nightlyReportedAt?: string | null;
  visualReviewFailures?: OperatorVisualReviewFailureInput[];
  digestDeliveryFailures?: OperatorDigestDeliveryFailureInput[];
  inviteSecurityReissues?: OperatorInviteSecurityReissueInput[];
  loadErrors?: string[];
  downstreamLanes?: AdminDownstreamLane[];
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
  manualQuarantineItems = [],
  manualQuarantineBacklog = null,
  promotionClusters = [],
  nightlyFailureGroups = [],
  nightlyReportedAt = null,
  visualReviewFailures = [],
  digestDeliveryFailures = [],
  inviteSecurityReissues = [],
  loadErrors = [],
  downstreamLanes = [],
  now = new Date(),
}: BuildOperatorActionInboxInput) {
  const items = [
    ...(manualQuarantineBacklog
      ? [manualQuarantineBacklogToAction(manualQuarantineBacklog, now)]
      : manualQuarantineItems
          .filter((item) => item.requiresAction && item.status !== "resolved")
          .map((item) => manualQuarantineToAction(item, now))),
    ...issues
      .filter((issue) => !retiredIssueCategories.has(issue.category))
      .map((issue) => pageIssueToAction(issue, now)),
    ...nightlyFailureGroups
      .filter(shouldIncludeNightlyFailure)
      .map((failure) => nightlyFailureToAction(failure, nightlyReportedAt, now)),
    ...visualReviewFailures.map((failure) => visualReviewFailureToAction(failure, now)),
    ...promotionClusters.map((cluster) => monitoringFeedbackClusterToAction(cluster, now)),
    ...digestDeliveryFailures.map((failure) => digestDeliveryFailureToAction(failure, now)),
    ...inviteSecurityReissues.map((reissue) => inviteSecurityReissueToAction(reissue, now)),
    ...downstreamLanes
      .filter((lane) => downstreamLaneNeedsAction(lane, now))
      .map((lane) => downstreamLaneToAction(lane, now)),
    ...(loadErrors.length > 0 ? [loadErrorToAction(loadErrors, now)] : []),
  ];

  return dedupeActions(items).sort(compareActions);
}

function inviteSecurityReissueToAction(
  reissue: OperatorInviteSecurityReissueInput,
  now: Date,
): OperatorActionInboxItem {
  const replacementReady = reissue.status === "replacement_ready";
  return {
    schemaVersion: operatorActionInboxSchemaVersion,
    id: `invite-security-reissue:${reissue.inviteId}`,
    fingerprint: `invite-security-reissue:${reissue.inviteId}:${reissue.status}:${reissue.deliveryStatus || "none"}`,
    sourceKind: "invite_security_reissue",
    severity: "medium",
    severityLabel: severityLabel("medium"),
    state: "needs_operator",
    stateLabel: stateLabel("needs_operator"),
    title: `${reissue.officeName}: resend a secure beta invitation`,
    context: `Invite ${reissue.emailHash.slice(0, 10)}\u2026`,
    failureReason: replacementReady
      ? reissue.lastError || "A strong replacement exists, but confirmed email delivery has not completed."
      : "AwardPing retired an older short invitation code during the beta security upgrade. The original link no longer works and must not fail silently.",
    occurredAt: reissue.replacementPreparedAt || reissue.rotatedAt,
    ageLabel: formatOperatorActionAge(reissue.replacementPreparedAt || reissue.rotatedAt, now),
    owner: {
      label: "Office owner or admin",
      detail: "Only an administrator for the affected office may create and resend its replacement invitation.",
    },
    publicImpact: {
      level: "blocked",
      label: "Invited advisor cannot join yet",
      detail: "Public award data is unaffected, but this advisor's invite-only beta access is blocked until a replacement is delivered.",
    },
    retry: {
      automatic: false,
      label: "No \u2014 deliberate resend required",
      detail: "AwardPing will not repeatedly email a replacement or expose a bearer link without an authorized office admin action.",
    },
    charge: {
      level: "may_charge",
      label: "Possible email-provider charge",
      detail: "Creating the replacement uses no paid AI. Sending it may create a normal email-provider charge.",
    },
    recommendedAction: {
      label: replacementReady ? "Copy or resend the prepared replacement" : "Create and resend a secure replacement",
      detail: "Open the affected office's Pending invites section, create one strong replacement, and confirm delivery before clearing this action.",
      href: "/dashboard/office#pending-invites",
    },
    evidence: compactEvidence([
      ["Invite", reissue.inviteId],
      ["Office", reissue.officeId],
      ["Recipient binding", reissue.emailHash],
      ["Security rotation", reissue.rotatedAt],
      ["Replacement prepared", reissue.replacementPreparedAt],
      ["Delivery status", reissue.deliveryStatus],
      ["Last delivery error", reissue.lastError],
    ]),
    policy: {
      id: "invite-only-beta-security-reissue",
      version: "v1",
      hash: null,
      description: "Legacy low-entropy invitation codes are retired with durable, auditable replacement delivery instead of silent invalidation.",
    },
    award: null,
    source: null,
    action: { kind: "none" },
  };
}

function downstreamLaneNeedsAction(lane: AdminDownstreamLane, now: Date) {
  const runtime = downstreamLaneRuntimeState(lane, now);
  return runtime.disabled ||
    runtime.expiredLease ||
    runtime.overdueUnclaimed ||
    runtime.overdue ||
    Boolean(lane.lastError) ||
    lane.consecutiveFailures > 0;
}

function downstreamLaneToAction(lane: AdminDownstreamLane, now: Date): OperatorActionInboxItem {
  const runtime = downstreamLaneRuntimeState(lane, now);
  const automaticRetry = runtime.retryWaiting;
  const state: OperatorActionState = automaticRetry ? "auto_retrying" : "needs_operator";
  const condition = runtime.disabled
    ? "disabled"
    : runtime.expiredLease
      ? "expired-lease"
      : runtime.overdueUnclaimed
        ? runtime.overdue
          ? "overdue-unclaimed"
          : "retry-due-unclaimed"
        : lane.lastError
          ? lane.lastError
          : runtime.overdue
            ? "sla-breached"
            : "failed-attempt";
  const failureReason = runtime.disabled
    ? "This lane is disabled, so no worker can claim its work."
    : runtime.expiredLease
      ? "The last worker lease expired without a safe completion."
      : runtime.overdueUnclaimed
        ? runtime.overdue
          ? "The lane is past its service-level target and no worker currently owns it."
          : "The lane retry was due, but no worker claimed it."
        : lane.lastError || (runtime.overdue
          ? lane.oldestItemAt
            ? "The oldest waiting item is beyond this lane's service-level target."
            : "This periodic lane missed its service-level deadline."
          : "The lane has consecutive failed attempts.");
  const occurredAt = runtime.expiredLease
    ? lane.leaseExpiresAt
    : runtime.overdue
      ? lane.nextSlaDueAt || lane.oldestItemAt
      : runtime.retryDue
        ? lane.nextRetryAt
        : lane.lastFailedAt || lane.lastFinishedAt || lane.oldestItemAt;
  const paid = lane.paid;
  const delayedUpdate = lane.laneKey === "changed_page_review";
  const delayedSource = lane.laneKey === "new_page_review";
  return {
    schemaVersion: operatorActionInboxSchemaVersion,
    id: `downstream-lane:${lane.laneKey}`,
    fingerprint: `downstream-lane:${lane.laneKey}:${condition}`,
    sourceKind: "downstream_lane",
    severity: delayedUpdate || lane.laneKey === "reconciliation" ? "high" : "medium",
    severityLabel: delayedUpdate || lane.laneKey === "reconciliation" ? "Important" : "Routine",
    state,
    stateLabel: stateLabel(state),
    title: `${lane.label} lane needs attention`,
    context: `${lane.queueDepth.toLocaleString("en-US")} waiting`,
    failureReason,
    occurredAt,
    ageLabel: formatOperatorActionAge(occurredAt, now),
    owner: {
      label: paid ? "Review operations" : "Worker operations",
      detail: "This lane is isolated, so other lanes continue while its owner repairs the failure.",
    },
    publicImpact: delayedUpdate
      ? { level: "delayed", label: "Public update delayed", detail: "Changed wording remains unpublished until review completes." }
      : delayedSource
        ? { level: "none", label: "Existing public data unaffected", detail: "The new page is not added until its review completes." }
        : { level: "protected", label: "Last-known-good data protected", detail: "This failed lane cannot overwrite verified public facts." },
    retry: {
      automatic: automaticRetry,
      label: runtime.disabled
        ? "No — lane is disabled"
        : runtime.expiredLease
          ? "No — expired lease needs recovery"
          : runtime.overdueUnclaimed
            ? runtime.overdue
              ? "No — overdue and unclaimed"
              : "No — retry due and unclaimed"
            : automaticRetry
              ? "Yes — isolated automatic retry"
              : "No retry currently scheduled",
      detail: runtime.disabled
        ? "Automation cannot resume until an operator verifies why this lane was disabled and re-enables it."
        : runtime.expiredLease
          ? "Confirm the prior worker stopped, preserve its evidence, then recover only this lane before another claim."
          : runtime.overdueUnclaimed
            ? "Start or repair this lane's worker; no other lane needs to be restarted."
            : automaticRetry
              ? `Only this lane retries at ${lane.nextRetryAt}; no other workflow is held behind it.`
              : "Inspect the lane error and run the same isolated lane after repair.",
    },
    charge: paid
      ? {
          level: "may_charge",
          label: "Only a new review submission charges",
          detail: "Polling or applying an existing result is free. A new provider submission must first reserve this lane's $5 daily budget.",
        }
      : noPaidAiCharge("This operational lane cannot reserve or create a paid Gemini request."),
    recommendedAction: {
      label: runtime.disabled
        ? "Verify and enable this lane"
        : runtime.expiredLease
          ? "Recover the expired lease"
          : runtime.overdueUnclaimed
            ? runtime.overdue
              ? "Start this overdue lane"
              : "Start this unclaimed retry"
            : automaticRetry
              ? "Review evidence while retry waits"
              : "Repair this isolated lane",
      detail: runtime.disabled
        ? "Confirm the lane should run, identify its worker owner, then enable and start only this lane."
        : runtime.expiredLease
          ? "Verify the old worker is no longer active, reconcile its preserved run evidence, then safely claim only this lane."
          : runtime.overdueUnclaimed
            ? "Run or repair this lane's worker now; investigate its scheduler if it remains claimable without an owner."
            : lane.lastError
              ? `Fix the reported failure without restarting unrelated lanes: ${lane.lastError}`
              : "Inspect the oldest item and lane run evidence; keep last-known-good public data in place.",
      href: "/dashboard/admin/issues?tab=operations",
    },
    evidence: compactEvidence([
      ["Lane", lane.laneKey],
      ["Enabled", lane.enabled ? "Yes" : "No"],
      ["Claimable", lane.claimable ? "Yes" : "No"],
      ["Queue depth", String(lane.queueDepth)],
      ["Oldest item", lane.oldestItemAt],
      ["Oldest-item target", lane.oldestItemSlaSeconds > 0 ? `${lane.oldestItemSlaSeconds}s` : null],
      ["Next SLA due", lane.nextSlaDueAt],
      [
        "SLA status",
        runtime.overdueUnclaimed
          ? runtime.overdue
            ? "Breached; overdue and unclaimed"
            : "Within target; retry due and unclaimed"
          : runtime.overdue
            ? "Breached"
            : "Within target",
      ],
      ["Timeout", `${lane.timeoutSeconds}s`],
      ["Lease TTL", `${lane.leaseTtlSeconds}s`],
      ["Lease owner", lane.leaseOwner || "None"],
      [
        "Lease status",
        runtime.expiredLease
          ? "Expired"
          : lane.leaseOwner
            ? "Active"
            : lane.claimable
              ? "Available"
              : "Unclaimed; not currently claimable",
      ],
      ["Lease expires", lane.leaseExpiresAt],
      ["Consecutive failures", String(lane.consecutiveFailures)],
      ["Next retry", lane.nextRetryAt],
      ["Last status", lane.lastStatus],
      ["Last started", lane.lastStartedAt],
      ["Last finished", lane.lastFinishedAt],
      ["Last succeeded", lane.lastSucceededAt],
      ["Last failed", lane.lastFailedAt],
      ["Policy source", lane.policySource],
    ]),
    policy: {
      id: "independent-downstream-lanes",
      version: "v1",
      hash: null,
      description: lane.policySource,
    },
    award: null,
    source: null,
    action: { kind: "none" },
  };
}

function manualQuarantineBacklogToAction(
  backlog: OperatorManualQuarantineBacklogInput,
  now: Date,
): OperatorActionInboxItem {
  const exactTotal = Math.max(0, Math.trunc(backlog.exactTotal));
  const clusterTotal = Math.max(0, Math.trunc(backlog.exactClusterTotal));
  const unassignedCases = Math.max(0, Math.trunc(backlog.unassignedCases));
  const chargeGatedCases = Math.max(0, Math.trunc(backlog.chargeGatedCases));
  const evidenceRecords = Math.max(0, Math.trunc(backlog.evidenceRecords));
  const terminalCases = Math.max(0, Math.trunc(backlog.terminalCases));
  const clusterLabel = clusterTotal === 1 ? "repair group" : "repair groups";
  const caseLabel = exactTotal === 1 ? "case" : "cases";

  return {
    schemaVersion: operatorActionInboxSchemaVersion,
    id: "manual-quarantine:backlog",
    fingerprint: `manual-quarantine:backlog:${backlog.registrySyncedAt || "unsynced"}:${exactTotal}:${clusterTotal}`,
    sourceKind: "manual_quarantine",
    severity: terminalCases > 0 ? "high" : "medium",
    severityLabel: terminalCases > 0 ? "Important" : "Routine",
    state: "needs_operator",
    stateLabel: stateLabel("needs_operator"),
    title: `${exactTotal.toLocaleString("en-US")} quarantined ${caseLabel} in ${clusterTotal.toLocaleString("en-US")} ${clusterLabel}`,
    context: `${unassignedCases.toLocaleString("en-US")} unassigned; grouped by common source, evidence failure, policy reason, and likely repair`,
    failureReason:
      "These cases exhausted their safe automated path. They are grouped into repair-sized work so an operator can address repeated failures together without hiding the exact case total.",
    occurredAt: backlog.oldestObservedAt,
    ageLabel: formatOperatorActionAge(backlog.oldestObservedAt, now),
    owner: {
      label: "Manual Quarantine",
      detail: `${unassignedCases.toLocaleString("en-US")} ${unassignedCases === 1 ? "case still needs" : "cases still need"} an individual owner. Functional ownership remains attached to every case.`,
    },
    publicImpact: {
      level: "unknown",
      label: "Case-specific public impact",
      detail:
        "The grouped summary does not infer an impact mix. Open the backlog to see each case's exact public-impact status.",
    },
    retry: {
      automatic: false,
      label: "No — review the grouped cases",
      detail:
        "Opening, filtering, assigning, or starting review never retries work. Any later retry remains case-specific and policy-gated.",
    },
    charge: {
      level: chargeGatedCases > 0 ? "may_charge" : "none",
      label: "No charge for queue actions",
      detail:
        chargeGatedCases > 0
          ? `${chargeGatedCases.toLocaleString("en-US")} ${chargeGatedCases === 1 ? "case is" : "cases are"} gated before any paid review. The available bulk actions create no API charge.`
          : "The available queue and bulk actions create no API charge.",
    },
    recommendedAction: {
      label: "Open the grouped quarantine backlog",
      detail:
        "Start with unassigned or oldest repair groups, assign a bounded selection, and move only reviewed cases into in-review status.",
      href: "/dashboard/admin/issues?tab=quarantine",
    },
    evidence: compactEvidence([
      ["Exact cases", String(exactTotal)],
      ["Exact repair groups", String(clusterTotal)],
      ["Linked evidence records", String(evidenceRecords)],
      ["Terminal cases", String(terminalCases)],
      ["Unassigned cases", String(unassignedCases)],
      ["Charge-gated cases", String(chargeGatedCases)],
      ["Oldest observed", backlog.oldestObservedAt],
      ["Registry synced", backlog.registrySyncedAt],
    ]),
    policy: {
      id: "awardping-manual-quarantine",
      version: "operator-backlog-v1",
      hash: null,
      description:
        "Exact durable quarantine accounting with evidence-bound, no-charge bulk assignment and review controls.",
    },
    award: null,
    source: null,
    action: { kind: "none" },
  };
}

function manualQuarantineToAction(
  quarantine: AdminManualQuarantineItem,
  now: Date,
): OperatorActionInboxItem {
  const evidence = objectValue(quarantine.evidence);
  const awardEvidence = objectValue(evidence.award);
  const sourceEvidence = objectValue(evidence.source);
  const candidateEvidence = objectValue(evidence.candidate);
  const awardName = jsonText(awardEvidence.name) || "Affected award";
  const awardSlug = jsonText(awardEvidence.slug);
  const sourceTitle =
    jsonText(sourceEvidence.title) ||
    (quarantine.category === "visual_review" ? "Visual review candidate" : null);
  const sourceUrl = jsonText(sourceEvidence.url);
  const r2BaselineRecovery =
    quarantine.category === "public_page" &&
    quarantine.policyId === "awardping-r2-baseline-recovery-quarantine" &&
    quarantine.caseKey.startsWith("r2-baseline-recovery:");
  const noCostPublicPage = quarantine.category === "public_page";
  const blocked = !noCostPublicPage && quarantine.retryCharge === "unknown";
  const retry = r2BaselineRecovery
    ? {
        automatic: false,
        label: "No \u2014 exact R2 restore required",
        detail:
          "A person must repair the immutable R2 generation and run the exact-source recovery. Once those exact bytes verify, AwardPing resolves the case and resumes the source automatically.",
      }
    : noCostPublicPage
    ? {
        automatic: false,
        label: "No — repair, then rerun the free audit",
        detail: "Repair only this award, then rerun reconciliation and its deterministic no-cost page audit.",
      }
    : manualQuarantineRetry(quarantine.retryMode);
  const charge = r2BaselineRecovery
    ? noPaidAiCharge("Exact-source R2 verification and local-cache restoration do not submit paid AI work.")
    : noCostPublicPage
    ? noPaidAiCharge("Public-page reconciliation and deterministic page-audit reruns do not submit paid AI work.")
    : manualQuarantineCharge(quarantine.retryCharge);
  const failureReason = noCostPublicPage && quarantine.reasonCode === "page_audit_retry_limit_reached"
    ? "The deterministic page audit reached its safe retry limit and remains unresolved."
    : quarantine.reason;
  const recommendedAction = r2BaselineRecovery
    ? quarantine.recommendedAction
    : noCostPublicPage
    ? "Inspect the linked evidence, repair only this award, then rerun reconciliation and the deterministic no-cost page audit."
    : quarantine.recommendedAction;

  return {
    schemaVersion: operatorActionInboxSchemaVersion,
    id: `manual-quarantine:${quarantine.id}`,
    fingerprint: quarantine.caseKey,
    sourceKind: "manual_quarantine",
    severity: quarantine.severity,
    severityLabel: severityLabel(quarantine.severity),
    state: blocked ? "blocked" : "needs_operator",
    stateLabel: stateLabel(blocked ? "blocked" : "needs_operator"),
    title: quarantine.title,
    context:
      quarantine.evidenceRecordCount > 1
        ? `${quarantine.evidenceRecordCount.toLocaleString("en-US")} linked evidence records, grouped as one case`
        : "1 preserved evidence record",
    failureReason,
    occurredAt: quarantine.firstObservedAt,
    ageLabel: formatOperatorActionAge(quarantine.firstObservedAt, now),
    owner: {
      label: quarantine.owner,
      detail: "Functional owner recorded by the quarantine policy.",
    },
    publicImpact: manualQuarantinePublicImpact(quarantine.publicImpact),
    retry,
    charge,
    recommendedAction: {
      label: r2BaselineRecovery
        ? "Repair the authoritative baseline"
        : manualQuarantineActionLabel(quarantine.category),
      detail: recommendedAction,
      href: null,
    },
    evidence: compactEvidence([
      ["Quarantine case", quarantine.caseKey],
      ["Category", humanizeCode(quarantine.category)],
      ["Reason code", quarantine.reasonCode],
      ["Evidence records", String(quarantine.evidenceRecordCount)],
      ["Primary record", `${quarantine.primarySourceTable}:${quarantine.primarySourceRecordId}`],
      ["Evidence hash", quarantine.evidenceHash],
      ["Award ID", quarantine.awardId],
      ["Source ID", quarantine.sourceId],
      ["Visual candidate", quarantine.visualCandidateId || jsonText(candidateEvidence.id)],
      ["First observed", quarantine.firstObservedAt],
      ["Last observed", quarantine.lastObservedAt],
    ]),
    policy: {
      id: quarantine.policyId,
      version: quarantine.policyVersion,
      hash: quarantine.policyHash,
      description: "Policy identity stored with this durable quarantine case and its preserved evidence.",
    },
    award: quarantine.awardId
      ? { id: quarantine.awardId, slug: awardSlug, name: awardName }
      : null,
    source: quarantine.sourceId || sourceTitle || sourceUrl
      ? { id: quarantine.sourceId, title: sourceTitle || "Affected source", url: sourceUrl }
      : null,
    action: { kind: "none" },
  };
}

function manualQuarantineRetry(retryMode: string): OperatorActionInboxItem["retry"] {
  if (retryMode === "automatic_zero_charge_publication_retry") {
    return {
      automatic: true,
      label: "Yes \u2014 publication only",
      detail:
        "AwardPing automatically retries atomic event/evidence publication with the retained candidate. It does not submit a paid AI request or create a replacement review.",
    };
  }
  if (retryMode === "automatic_local_evidence_retry") {
    return {
      automatic: true,
      label: "Yes — local evidence only",
      detail: "AwardPing retries the retained local evidence automatically. That retry does not submit a paid AI request.",
    };
  }
  if (retryMode === "operator_before_retry") {
    return {
      automatic: false,
      label: "No — verify the existing request first",
      detail: "A possible external request may already exist. Reconcile that evidence before approving any retry.",
    };
  }
  if (retryMode === "retry_limit_reached") {
    return {
      automatic: false,
      label: "No — retry limit reached",
      detail: "The bounded retry policy stopped. A person must inspect the evidence before another attempt.",
    };
  }
  return {
    automatic: false,
    label: "No — repair and approve",
    detail: "The case stays quarantined until a person repairs the affected record and explicitly approves the safe next step.",
  };
}

function manualQuarantineCharge(
  level: AdminManualQuarantineItem["retryCharge"],
): OperatorActionInboxItem["charge"] {
  if (level === "none") {
    return noPaidAiCharge("The recorded recovery path does not create a paid AI request.");
  }
  if (level === "will_charge") {
    return {
      level,
      label: "Yes — paid AI retry",
      detail: "Approving another visual-review submission creates a paid AI request.",
    };
  }
  if (level === "may_charge") {
    return {
      level,
      label: "Possible — depends on action",
      detail: "Repairing or reconciling data is free; explicitly rerunning an AI review can create a charge.",
    };
  }
  return {
    level: "unknown",
    label: "Unknown — do not retry blindly",
    detail: "The registry cannot prove whether an external paid request already exists. Reconcile it first.",
  };
}

function manualQuarantinePublicImpact(
  level: AdminManualQuarantineItem["publicImpact"],
): OperatorActionInboxItem["publicImpact"] {
  if (level === "blocked") {
    return {
      level,
      label: "Public update blocked",
      detail: "The affected public update cannot advance until this case is resolved.",
    };
  }
  if (level === "protected") {
    return {
      level,
      label: "Public data protected",
      detail: "Last-known-good public facts remain in place while the failed evidence is quarantined.",
    };
  }
  if (level === "unknown") {
    return {
      level,
      label: "Public impact needs verification",
      detail: "The audit remains unresolved, so confirm whether published wording was affected before closing the case.",
    };
  }
  if (level === "none") {
    return {
      level,
      label: "No public impact",
      detail: "This case does not currently block or delay a public update.",
    };
  }
  return {
    level: "delayed",
    label: "Update publication delayed",
    detail: "The affected update remains unpublished while its evidence is quarantined.",
  };
}

function manualQuarantineActionLabel(category: AdminManualQuarantineItem["category"]) {
  if (category === "visual_review") return "Inspect before another paid attempt";
  return "Repair and verify this award";
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
        detail: "The public page stays on last-known-good facts until reconciliation and the deterministic audit finding are resolved.",
      },
      charge: noPaidAiCharge(
        "Reconciliation and deterministic page-audit reruns do not submit paid AI work.",
      ),
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
  const ambiguousExternalBatch = reason.startsWith("manual_recovery_required_");
  const automatic = missingResponse;
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
      : {
          automatic: false,
          label: "No — approval required",
          detail: "A site admin must approve this exact failed candidate before one new paid Batch submission.",
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
      label: automatic ? "Watch existing-result recovery" : "Inspect and approve one retry",
      detail: ambiguousExternalBatch
        ? "Reconcile the possible external Batch name and result first. Never use a generic retry in this state."
        : missingResponse
          ? "Allow response recovery to reuse the existing Batch."
          : "Inspect the captured evidence, prompt payload, and rejection reason. Approve one exact retry only when a new paid submission is justified.",
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
      description: "Current operator-approved paid-retry and visual-review Batch policy.",
    },
    award: null,
    source: { id: failure.sourceId, title: failure.sourceTitle, url: failure.sourceUrl },
    action: ambiguousExternalBatch || missingResponse
      ? { kind: "none" }
      : {
          kind: "paid_visual_retry",
          candidateId: failure.id,
          candidateUpdatedAt: failure.updatedAt,
          sourceTitle: failure.sourceTitle,
        },
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
        ? "The retroactive sweep passed. Resolve stays locked until the next feedback-promotion lane run records a matching zero-charge attestation."
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
          ? "The sweep finished, but its rule is no longer active. Do not resolve: the next no-charge feedback-promotion lane run must record deactivation, reverse candidate-attributable suppressions, and return the workflow to draft."
          : activationBlocked
          ? cluster.draftRuleActive
            ? "New evidence invalidated the sealed canary revision. Stop further historical mutation, restore the inactive deployment, and audit reversal of every candidate-attributable suppression before redrafting."
            : "The candidate is inactive and no further historical mutation is allowed. AwardPing is verifying the rollback and suppression-reversal audit before redrafting."
          : appActivationParityPending
            ? "The current app policy contains the candidate, but activated worker parity is not proven. Do not describe global suppression as verified until the next feedback-promotion lane identity check advances the workflow."
            : cluster.draftRuleActive
              ? "The verified active deployment suppresses matching future events. The cluster stays open until the bounded historical sweep is verified."
              : "Each reported event stays suppressed immediately. Similar future events remain unchanged until every global activation gate passes.",
    },
    retry: {
      automatic: automaticRetry,
      label:
        automaticRetry
          ? postSweepDeactivated
            ? "Yes — feedback-promotion lane rollback/deactivation repair"
            : activationBlocked
            ? "Yes — feedback-promotion lane rollback verification"
            : cluster.stage === "app_worker_hashes_match"
            ? "Yes — next scheduled 6 PM scan"
            : cluster.stage === "six_pm_canary" && cluster.draftRuleActive
              ? "Yes — feedback-promotion lane activated-deployment verification"
            : awaitingResolutionAttestation
              ? "Yes — next feedback-promotion lane attestation"
            : failedGate
              ? "Yes — feedback-promotion lane verified-stage retry"
              : "Yes — verified stage runner"
          : failedGate
            ? resolutionIdentityDrifted
              ? "No — restore the inactive deployment"
              : "No — repair the failed gate"
            : "No — operator checkpoint",
      detail:
        automaticRetry
          ? postSweepDeactivated
            ? "The next no-charge feedback-promotion lane run records the inactive deployment, reverses candidate-attributable suppressions, and returns the cluster to draft before any resolution can occur."
            : activationBlocked
            ? "AwardPing retries only the no-charge identity check. It cannot pass until the rule is inactive and the app and worker run the same restored revision."
            : awaitingResolutionAttestation
              ? "The next feedback-promotion lane run records one reusable cluster-bound attestation. It creates no paid API request and does not wait for another 6 PM scan."
            : failedGate
            ? "The runner will retry the unchanged evidence automatically, but a rule, deployment, or source repair may still be required before it can pass."
            : "Automation advances only after it records passing evidence for the next exact stage."
          : resolutionIdentityDrifted
            ? "A feedback-promotion lane attestation cannot match the stale activated identity. A person must first deactivate the candidate and restore the exact inactive app and worker deployment."
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
          ? "Keep inactive; let lane rollback repair run"
          : activationBlocked
          ? "Restore the inactive deployment"
        : failedGate
          ? "Repair the blocked verification gate"
          : awaitingResolutionAttestation
            ? "Wait for the no-charge lane attestation"
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
        "Final feedback-promotion attestation",
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
  const deliveryState = failure.state || "legacy_failed";
  const autoRetry = deliveryState === "ambiguous";
  const releaseBlocked = deliveryState === "release_blocked";
  const legacy = deliveryState === "legacy_failed";
  const occurredAt = failure.updatedAt || failure.createdAt;
  return {
    schemaVersion: operatorActionInboxSchemaVersion,
    id: `delivery:${failure.id}`,
    fingerprint: `delivery:${failure.id}`,
    sourceKind: "digest_delivery",
    severity: "medium",
    severityLabel: severityLabel("medium"),
    state: "needs_operator",
    stateLabel: stateLabel("needs_operator"),
    title: releaseBlocked
      ? "Public digest blocked by a changed release"
      : autoRetry
        ? "Public digest provider outcome is ambiguous"
        : `${capitalize(failure.deliveryType || "email")} delivery failed`,
    context: recipientLabel,
    failureReason: failure.error || "The delivery provider returned a failure without a recorded reason.",
    occurredAt,
    ageLabel: formatOperatorActionAge(occurredAt, now),
    owner: {
      label: "Delivery review",
      detail: "Functional owner; no individual assignee is stored.",
    },
    publicImpact: {
      level: "blocked",
      label: "Subscriber did not receive email",
      detail: releaseBlocked
        ? "No stale digest was sent; a fresh verified release must create a new payload."
        : "The public site is unaffected, but this subscriber may not have received the digest.",
    },
    retry: {
      automatic: autoRetry,
      label: autoRetry
        ? "Yes — only inside the sealed 23-hour window"
        : "No — operator review is required",
      detail: autoRetry
        ? "The drain retries the same payload hash and provider idempotency key. It stops before 24 hours so an expired key cannot create a duplicate."
        : releaseBlocked
          ? "This payload belongs to an invalidated release and will never be sent. Re-verification must produce a new digest."
          : legacy
            ? "This pre-outbox row has no immutable payload, so AwardPing cannot safely infer or replay it."
            : "The automatic retry limit or safe provider-idempotency window ended. Do not send a replacement without reconciling provider evidence.",
    },
    charge: {
      level: "may_charge",
      label: "Possible — Resend",
      detail: autoRetry
        ? "A provider request is made with the same idempotency key and may count toward Resend usage; no Gemini charge is involved."
        : "A manual replacement may create a Resend provider charge; no Gemini charge is involved.",
    },
    recommendedAction: {
      label: releaseBlocked
        ? "Re-verify before creating a new digest"
        : "Reconcile provider evidence before any resend",
      detail: legacy
        ? "Preserve this historical row as unsealed legacy evidence. Create a replacement only after confirming the provider did not deliver it."
        : "Check the immutable payload hash, provider logs, attempt timestamps, and release evidence before authorizing any manual replacement.",
      href: null,
    },
    evidence: compactEvidence([
      ["Delivery", failure.id],
      ["Type", failure.deliveryType],
      ["Digest", failure.digestKey],
      ["Recipient", recipientLabel],
      ["Updates in digest", failure.changeEventCount == null ? null : String(failure.changeEventCount)],
      ["State", deliveryState],
      ["Payload hash", failure.payloadHash],
      ["Attempts", failure.attemptCount == null ? null : String(failure.attemptCount)],
      ["First provider request", failure.firstProviderAttemptAt],
      ["Next automatic attempt", failure.nextAttemptAt],
      ["Recorded", occurredAt],
    ]),
    policy: {
      id: "public-update-delivery",
      version: failure.contractVersion || "legacy-unsealed",
      hash: failure.payloadHash || null,
      description: failure.contractVersion
        ? "The rendered payload, event bindings, Stage 1 release, provider key, lease, and retry state are durable."
        : "This delivery predates the durable outbox and does not claim an immutable rendered payload.",
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

function objectValue(value: Json | undefined | null): Record<string, Json | undefined> {
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
