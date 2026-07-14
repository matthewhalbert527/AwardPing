import { ExternalLink } from "lucide-react";
import { AdminMonitoringFeedbackPromotionControl } from "@/components/admin-monitoring-feedback-promotion-control";
import type { Json } from "@/lib/database.types";
import {
  monitoringFeedbackEvidenceSummary,
  monitoringFeedbackLabel,
} from "@/lib/monitoring-feedback";
import { formatCentralDateTime } from "@/lib/time-zone";

export type AdminPendingMonitoringFeedback = {
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

type Props = {
  feedback: AdminPendingMonitoringFeedback[];
  feedbackTotal: number;
  policyRuleIds: readonly string[];
};

export function AdminMonitoringFeedbackPendingList({
  feedback,
  feedbackTotal,
  policyRuleIds,
}: Props) {
  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-black">Pending policy feedback</h3>
          <p className="mt-1 text-sm font-semibold text-[var(--muted)]">
            Novel corrections stay here until a reviewed rule promotion is
            implemented. Requested global scope is not an active global rule.
          </p>
        </div>
        <span className="badge">{formatNumber(feedbackTotal)} pending</span>
      </div>

      {feedback.length > 0 ? (
        <div className="admin-issue-list">
          {feedback.map((item) => {
            const evidenceSummary = monitoringFeedbackEvidenceSummary(
              item.eventEvidence,
            );
            const sourceUrl = safeExternalUrl(item.eventSourceUrl);

            return (
              <article
                className={`admin-issue-row ${
                  item.requestedScope === "global"
                    ? "admin-issue-row-medium"
                    : "admin-issue-row-low"
                }`}
                key={item.id}
              >
                <div className="min-w-0">
                  <div className="admin-issue-meta">
                    <span className="admin-severity-pill admin-severity-pill-medium">
                      pending review
                    </span>
                    <span>{monitoringFeedbackLabel(item.requestedScope)} scope</span>
                    <span>{monitoringFeedbackLabel(item.reasonCode)}</span>
                    {item.eventSourcePageType && (
                      <span>{monitoringFeedbackLabel(item.eventSourcePageType)} page</span>
                    )}
                    <span>{item.policyVersion}</span>
                  </div>
                  <h3>
                    {item.eventSourceTitle || `Monitoring event ${item.eventId}`}
                  </h3>
                  <p className="admin-issue-message">
                    {item.eventSummary || "Original update summary unavailable."}
                  </p>
                  {evidenceSummary && (
                    <p className="mt-2 text-sm font-semibold text-[var(--muted)]">
                      <span className="font-black text-[var(--foreground)]">
                        Captured evidence:
                      </span>{" "}
                      {evidenceSummary}
                    </p>
                  )}
                  {item.note && (
                    <p className="mt-2 text-sm font-semibold text-[var(--muted)]">
                      <span className="font-black text-[var(--foreground)]">
                        Reviewer context:
                      </span>{" "}
                      {item.note}
                    </p>
                  )}
                  <div className="admin-issue-actions">
                    {sourceUrl && (
                      <a
                        className="admin-issue-link"
                        href={sourceUrl}
                        rel="noreferrer"
                        target="_blank"
                      >
                        Original source <ExternalLink size={13} aria-hidden="true" />
                      </a>
                    )}
                    {item.eventDetectedAt && (
                      <span>
                        Update detected {formatCentralDateTime(item.eventDetectedAt)}
                      </span>
                    )}
                  </div>
                  <p className="mt-2 text-xs font-semibold text-[var(--muted)]">
                    Submitted by {item.actorEmail}
                  </p>
                  <AdminMonitoringFeedbackPromotionControl
                    feedbackId={item.id}
                    policyRuleIds={policyRuleIds}
                  />
                </div>
                <time dateTime={item.createdAt}>
                  {formatCentralDateTime(item.createdAt)}
                </time>
              </article>
            );
          })}
        </div>
      ) : (
        <p className="mt-4 text-sm font-semibold text-[var(--muted)]">
          No false-positive corrections are waiting for policy review.
        </p>
      )}
    </div>
  );
}

function safeExternalUrl(value: string | null) {
  if (!value) return null;

  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}
