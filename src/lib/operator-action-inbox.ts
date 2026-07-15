import type { AdminPageIssue, PageIssueSeverity } from "@/lib/admin-page-issues";
import {
  awardMonitoringPolicyIdentity,
  visualReviewBatchPolicyIdentity,
} from "@/lib/award-monitoring-policy";
import type { Json } from "@/lib/database.types";
import { monitoringFeedbackEvidenceSummary } from "@/lib/monitoring-feedback";

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
    | { kind: "monitoring_feedback"; feedbackId: string }
    | { kind: "source_intake" }
    | { kind: "none" };
};

export type OperatorMonitoringFeedbackInput = {
  id: string;
  eventId: string;
  sourceId: string | null;
  awardId: string;
  eventSummary: string | null;
  eventSourceUrl: string | null;
  eventSourceTitle: string | null;
  eventSourcePageType: string | null;
  eventDetectedAt: string | null;
  eventEvidence: Json;
  reasonCode: string;
  note: string | null;
  requestedScope: string;
  policyRuleId: string | null;
  policyVersion: string;
  actorEmail: string;
  createdAt: string;
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
  pendingFeedback?: OperatorMonitoringFeedbackInput[];
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
  pendingFeedback = [],
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
    ...pendingFeedback.map((feedback) => monitoringFeedbackToAction(feedback, now)),
    ...digestDeliveryFailures.map((failure) => digestDeliveryFailureToAction(failure, now)),
    ...(loadErrors.length > 0 ? [loadErrorToAction(loadErrors, now)] : []),
  ];

  return dedupeActions(items).sort(compareActions);
}

export function operatorActionInboxSummary(items: OperatorActionInboxItem[]) {
  const needsOperator = items.filter((item) => item.state !== "auto_retrying").length;
  const autoRetrying = items.filter((item) => item.state === "auto_retrying").length;
  const publicBlockers = items.filter((item) => item.publicImpact.level === "blocked").length;
  return { total: items.length, needsOperator, autoRetrying, publicBlockers };
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

function monitoringFeedbackToAction(
  feedback: OperatorMonitoringFeedbackInput,
  now: Date,
): OperatorActionInboxItem {
  const severity: PageIssueSeverity = feedback.requestedScope === "global" ? "medium" : "low";
  const evidenceSummary = monitoringFeedbackEvidenceSummary(feedback.eventEvidence);
  return {
    schemaVersion: operatorActionInboxSchemaVersion,
    id: `monitoring-feedback:${feedback.id}`,
    fingerprint: `monitoring-feedback:${feedback.id}`,
    sourceKind: "monitoring_feedback",
    severity,
    severityLabel: severityLabel(severity),
    state: "needs_operator",
    stateLabel: stateLabel("needs_operator"),
    title: feedback.eventSourceTitle || `False-update correction ${feedback.eventId}`,
    context: feedback.requestedScope === "global" ? "Requested as a global rule" : "Event-specific correction",
    failureReason: feedback.note || feedback.eventSummary || humanizeCode(feedback.reasonCode),
    occurredAt: feedback.createdAt,
    ageLabel: formatOperatorActionAge(feedback.createdAt, now),
    owner: {
      label: "Policy review",
      detail: "Functional owner; the submitter is recorded in evidence.",
    },
    publicImpact: {
      level: "protected",
      label: "Current false update is hidden",
      detail: "A similar false update can recur until the reviewed rule is implemented globally.",
    },
    retry: {
      automatic: false,
      label: "No — policy decision needed",
      detail: "Requested global scope is not active until a tested rule is implemented and selected below.",
    },
    charge: noPaidAiCharge("Promoting or resolving a monitoring rule does not submit paid AI work."),
    recommendedAction: {
      label: "Implement or match a safe global rule",
      detail: "Review the captured evidence, implement and test the rule, then mark this correction resolved with the exact active rule.",
      href: null,
    },
    evidence: compactEvidence([
      ["Feedback", feedback.id],
      ["Event", feedback.eventId],
      ["Award ID", feedback.awardId],
      ["Source ID", feedback.sourceId],
      ["Reason", humanizeCode(feedback.reasonCode)],
      ["Requested scope", feedback.requestedScope],
      ["Captured evidence", evidenceSummary],
      ["Event detected", feedback.eventDetectedAt],
      ["Submitted by", feedback.actorEmail],
      ["Submitted", feedback.createdAt],
    ]),
    policy: {
      id: feedback.policyRuleId || "monitoring-feedback-record",
      version: feedback.policyVersion || "not recorded",
      hash: null,
      description: "Policy version stored with the original correction. This row does not retain a historical policy hash.",
    },
    award: null,
    source: feedback.eventSourceTitle || feedback.eventSourceUrl || feedback.sourceId
      ? {
          id: feedback.sourceId,
          title: feedback.eventSourceTitle || "Original source",
          url: feedback.eventSourceUrl,
        }
      : null,
    action: { kind: "monitoring_feedback", feedbackId: feedback.id },
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
