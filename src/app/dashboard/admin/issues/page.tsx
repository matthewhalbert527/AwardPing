import Link from "next/link";
import { AlertTriangle, ExternalLink, Inbox, Plus, ScrollText } from "lucide-react";
import { AdminNotAnUpdateControl } from "@/components/admin-not-an-update-control";
import { AdminPageIssueActions } from "@/components/admin-page-issue-actions";
import { AdminRunReport } from "@/components/admin-run-report";
import {
  type AdminPendingMonitoringFeedback,
} from "@/components/admin-monitoring-feedback-pending-list";
import { OperatorActionInbox } from "@/components/operator-action-inbox";
import { SetupNotice } from "@/components/setup-notice";
import { requireUser, isSiteAdminEmail } from "@/lib/auth";
import { alertBlockingMonitoringPolicyFlagIds } from "@/lib/award-monitoring-policy";
import { dashboardAwardPath } from "@/lib/award-slugs";
import { appConfig, hasSupabaseAdminConfig, hasSupabaseConfig } from "@/lib/config";
import type { Database } from "@/lib/database.types";
import type { AdminReviewLaterSource, AdminSuppressedChangeEvent } from "@/lib/admin-page-issues";
import {
  loadAdminPageIssues,
  loadAdminReviewLaterSources,
  loadAdminSuppressedChangeEvents,
} from "@/lib/admin-page-issues";
import { buildAdminRunReportFeed } from "@/lib/admin-run-report";
import {
  buildOperatorActionInbox,
  type OperatorDigestDeliveryFailureInput,
  type OperatorVisualReviewFailureInput,
} from "@/lib/operator-action-inbox";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { formatCentralDateTime } from "@/lib/time-zone";

export const dynamic = "force-dynamic";

type Props = {
  searchParams: Promise<{
    tab?: string;
  }>;
};

type AdminRecentChangeEvent = {
  id: string;
  awardId: string;
  sourceId: string | null;
  sourceTitle: string;
  sourceUrl: string;
  summary: string;
  detectedAt: string;
};

type LocalWorkerRun = Database["public"]["Tables"]["local_worker_runs"]["Row"];

export default async function AdminActionInboxPage({ searchParams }: Props) {
  if (!hasSupabaseConfig()) return <SetupNotice />;

  const user = await requireUser();
  if (!isSiteAdminEmail(user.email)) {
    return <AccessDenied configured={appConfig.adminEmails.length > 0} />;
  }

  if (!hasSupabaseAdminConfig()) {
    return (
      <IssueShell>
        <div className="card p-6">
          <span className="badge">Admin</span>
          <h1 className="mt-4 text-3xl font-black">Action Inbox</h1>
          <p className="mt-2 text-[var(--muted)]">
            Supabase service-role access is not configured, so operator actions cannot be loaded.
          </p>
        </div>
      </IssueShell>
    );
  }

  const admin = createSupabaseAdminClient();
  const params = await searchParams;
  const activeTab =
    params.tab === "updates" || params.tab === "suppressed" || params.tab === "excluded"
      ? params.tab
      : "inbox";
  const renderedAt = new Date();
  const workerRunsResult = await admin
    .from("local_worker_runs")
    .select("*")
    .order("started_at", { ascending: false })
    .limit(200);
  const workerRuns = (workerRunsResult.data || []) as LocalWorkerRun[];
  const runReport = buildAdminRunReportFeed(workerRuns, renderedAt);

  const [
    pageIssues,
    reviewLater,
    pendingFeedback,
    visualReviewFailures,
    deliveryFailures,
    recentUpdates,
    suppressedEvents,
  ] = await Promise.all([
    loadAdminPageIssues(admin, workerRuns, { includeLegacyDiagnostics: false }),
    loadAdminReviewLaterSources(admin),
    loadAdminPendingMonitoringFeedback(admin),
    loadAdminVisualReviewFailures(admin),
    loadAdminFailedPublicUpdateDeliveries(admin),
    loadAdminRecentChangeEvents(admin),
    loadAdminSuppressedChangeEvents(admin),
  ]);
  const actionLoadErrors = [
    workerRunsResult.error?.message,
    ...pageIssues.loadErrors,
    ...pendingFeedback.loadErrors,
    ...visualReviewFailures.loadErrors,
    ...deliveryFailures.loadErrors,
  ].filter((message): message is string => Boolean(message));
  const historyLoadErrors = [
    ...reviewLater.loadErrors,
    ...recentUpdates.loadErrors,
    ...suppressedEvents.loadErrors,
  ].filter((message): message is string => Boolean(message));
  const actionItems = buildOperatorActionInbox({
    issues: pageIssues.issues,
    pendingFeedback: pendingFeedback.feedback,
    nightlyFailureGroups: runReport.visualNightly?.failureGroups || [],
    nightlyReportedAt:
      runReport.visualNightly?.finishedAt ||
      runReport.visualNightly?.startedAt ||
      null,
    visualReviewFailures: visualReviewFailures.failures,
    digestDeliveryFailures: deliveryFailures.failures,
    loadErrors: actionLoadErrors,
    now: renderedAt,
  });

  return (
    <IssueShell>
      <div className="admin-page-header">
        <div>
          <span className="badge">Admin</span>
          <h1 className="admin-page-title">Action Inbox</h1>
          <p className="admin-page-copy">
            One plain-language queue for failures and decisions. Automatic retries stay visible, but normal pending work and old technical completion counters stay out.
          </p>
          <p className="admin-page-timestamp">
            Refreshed {formatDate(renderedAt.toISOString())}.
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <Link className="button-secondary" href="/dashboard/admin/source-intake">
            <Plus size={16} aria-hidden="true" />
            Add a source
          </Link>
          <Link className="button-secondary" href="/dashboard/admin/issues?tab=updates">
            <ScrollText size={16} aria-hidden="true" />
            Review updates
          </Link>
        </div>
      </div>

      <nav aria-label="Action Inbox views" className="admin-subtabs">
        <Link
          aria-current={activeTab === "inbox" ? "page" : undefined}
          className={`admin-subtab ${activeTab === "inbox" ? "admin-subtab-active" : ""}`}
          href="/dashboard/admin/issues"
        >
          <Inbox size={15} aria-hidden="true" />
          Action Inbox
        </Link>
        <Link
          aria-current={activeTab === "updates" ? "page" : undefined}
          className={`admin-subtab ${activeTab === "updates" ? "admin-subtab-active" : ""}`}
          href="/dashboard/admin/issues?tab=updates"
        >
          Update review
        </Link>
        <Link
          aria-current={activeTab === "suppressed" ? "page" : undefined}
          className={`admin-subtab ${activeTab === "suppressed" ? "admin-subtab-active" : ""}`}
          href="/dashboard/admin/issues?tab=suppressed"
        >
          Suppressed history
        </Link>
        <Link
          aria-current={activeTab === "excluded" ? "page" : undefined}
          className={`admin-subtab ${activeTab === "excluded" ? "admin-subtab-active" : ""}`}
          href="/dashboard/admin/issues?tab=excluded"
        >
          Excluded sources
        </Link>
      </nav>

      {activeTab === "inbox" ? (
        <>
          <AdminRunReport compact initialFeed={runReport} />
          <OperatorActionInbox
            items={actionItems}
            policyRuleIds={alertBlockingMonitoringPolicyFlagIds}
          />
        </>
      ) : (
        <section className="card admin-section-card admin-issue-panel">
          {historyLoadErrors.length > 0 && (
            <div className="operator-history-load-warning" role="status">
              <AlertTriangle size={17} aria-hidden="true" />
              Some history data could not be loaded. Return to the Action Inbox for the full failure evidence.
            </div>
          )}
          {activeTab === "updates" ? (
            <RecentUpdateReview events={recentUpdates.events} />
          ) : activeTab === "excluded" ? (
            <ExcludedSourceList sources={reviewLater.sources} />
          ) : (
            <SuppressedEventList events={suppressedEvents.events} />
          )}
        </section>
      )}
    </IssueShell>
  );
}

function IssueShell({ children }: { children: React.ReactNode }) {
  return <div className="admin-page mx-auto w-full max-w-[90rem]">{children}</div>;
}

function AccessDenied({ configured }: { configured: boolean }) {
  return (
    <IssueShell>
      <div className="card p-6">
        <span className="badge">Admin</span>
        <h1 className="mt-4 text-3xl font-black">Action Inbox</h1>
        <p className="mt-2 text-[var(--muted)]">
          This page is limited to AwardPing site admins
          {configured ? "." : ". Set AWARDPING_ADMIN_EMAILS to enable access."}
        </p>
      </div>
    </IssueShell>
  );
}

function RecentUpdateReview({ events }: { events: AdminRecentChangeEvent[] }) {
  return (
    <div>
      <div className="admin-panel-heading">
        <div>
          <h2>Review recent published updates</h2>
          <p className="mt-1 text-sm font-semibold text-[var(--muted)]">
            If an update is not real, hide it here and send the evidence into the Action Inbox for reviewed global policy promotion.
          </p>
        </div>
      </div>

      {events.length > 0 ? (
        <div className="admin-issue-list">
          {events.map((event) => (
            <article className="admin-issue-row admin-issue-row-low" key={event.id}>
              <div className="min-w-0">
                <div className="admin-issue-meta">
                  <span className="admin-severity-pill admin-severity-pill-low">published update</span>
                  <span>Event {event.id}</span>
                </div>
                <h3>{event.sourceTitle}</h3>
                <p className="admin-issue-message">{event.summary}</p>
                <div className="admin-issue-actions">
                  {safeExternalUrl(event.sourceUrl) && (
                    <a
                      className="admin-issue-link"
                      href={event.sourceUrl}
                      rel="noreferrer"
                      target="_blank"
                    >
                      Source <ExternalLink size={13} aria-hidden="true" />
                    </a>
                  )}
                </div>
                <AdminNotAnUpdateControl
                  eventId={event.id}
                  policyRuleIds={alertBlockingMonitoringPolicyFlagIds}
                />
              </div>
              <time dateTime={event.detectedAt}>{formatDate(event.detectedAt)}</time>
            </article>
          ))}
        </div>
      ) : (
        <p className="mt-4 text-sm font-semibold text-[var(--muted)]">
          No unsuppressed change events are currently reported.
        </p>
      )}
    </div>
  );
}

function SuppressedEventList({ events }: { events: AdminSuppressedChangeEvent[] }) {
  if (events.length === 0) {
    return (
      <p className="text-sm font-semibold text-[var(--muted)]">
        No suppressed change events are currently reported.
      </p>
    );
  }

  return (
    <div>
      <div className="admin-panel-heading">
        <div>
          <h2>Suppressed update history</h2>
          <p className="mt-1 text-sm font-semibold text-[var(--muted)]">
            Audit history only. These are not open operator actions.
          </p>
        </div>
      </div>
      <div className="admin-issue-list">
        {events.map((event) => (
          <article className="admin-issue-row admin-issue-row-low" key={event.id}>
            <div className="min-w-0">
              <div className="admin-issue-meta">
                <span className="admin-severity-pill admin-severity-pill-low">suppressed</span>
                {event.reason && <span>{event.reason}</span>}
                {event.source && <span>{event.source}</span>}
              </div>
              <h3>{event.sourceTitle}</h3>
              <p className="admin-issue-message">{event.summary}</p>
              {safeExternalUrl(event.sourceUrl) && (
                <div className="admin-issue-actions">
                  <a href={event.sourceUrl} className="admin-issue-link" target="_blank" rel="noreferrer">
                    Source <ExternalLink size={13} aria-hidden="true" />
                  </a>
                </div>
              )}
            </div>
            <time dateTime={event.suppressedAt || event.detectedAt}>
              {formatDate(event.suppressedAt || event.detectedAt)}
            </time>
          </article>
        ))}
      </div>
    </div>
  );
}

function ExcludedSourceList({ sources }: { sources: AdminReviewLaterSource[] }) {
  return (
    <div>
      <div className="admin-panel-heading">
        <div>
          <h2>Excluded source history</h2>
          <p className="mt-1 text-sm font-semibold text-[var(--muted)]">
            These are completed monitoring decisions, not open actions. Restore a source only if new evidence makes it official and monitorable again.
          </p>
        </div>
      </div>
      {sources.length > 0 ? (
        <div className="admin-issue-list">
          {sources.map((source) => (
            <article className="admin-issue-row admin-issue-row-low" key={source.id}>
              <div className="min-w-0">
                <div className="admin-issue-meta">
                  <span className="admin-severity-pill admin-severity-pill-low">excluded</span>
                  {source.failures > 0 && <span>{source.failures} failures</span>}
                  {source.reviewedBy && <span>{source.reviewedBy}</span>}
                </div>
                <h3>{source.awardName}</h3>
                <p className="admin-issue-source">{source.sourceTitle}</p>
                <p className="admin-issue-message">{source.note || source.message}</p>
                <div className="admin-issue-actions">
                  <Link href={dashboardAwardPath(source.awardSlug, source.awardName, source.awardId)} className="admin-issue-link">
                    Award page
                  </Link>
                  {safeExternalUrl(source.sourceUrl) && (
                    <a href={source.sourceUrl} className="admin-issue-link" target="_blank" rel="noreferrer">
                      Source <ExternalLink size={13} aria-hidden="true" />
                    </a>
                  )}
                </div>
                <AdminPageIssueActions
                  mode="review"
                  sourceId={source.id}
                  sourceTitle={source.sourceTitle}
                />
              </div>
              <time dateTime={source.reviewedAt || undefined}>
                {source.reviewedAt ? formatDate(source.reviewedAt) : "Review time unavailable"}
              </time>
            </article>
          ))}
        </div>
      ) : (
        <p className="mt-4 text-sm font-semibold text-[var(--muted)]">
          No sources are currently excluded from monitoring.
        </p>
      )}
    </div>
  );
}

async function loadAdminRecentChangeEvents(
  admin: ReturnType<typeof createSupabaseAdminClient>,
): Promise<{ events: AdminRecentChangeEvent[]; loadErrors: string[] }> {
  const { data, error } = await admin
    .from("shared_award_change_events")
    .select(
      "id, shared_award_id, shared_award_source_id, source_title, source_url, summary, detected_at",
    )
    .is("suppressed_at", null)
    .order("detected_at", { ascending: false })
    .limit(100);

  return {
    events: (data || []).map((row) => ({
      id: row.id,
      awardId: row.shared_award_id,
      sourceId: row.shared_award_source_id,
      sourceTitle: row.source_title || row.source_url || "Untitled source",
      sourceUrl: row.source_url,
      summary: row.summary,
      detectedAt: row.detected_at,
    })),
    loadErrors: error?.message ? [error.message] : [],
  };
}

async function loadAdminPendingMonitoringFeedback(
  admin: ReturnType<typeof createSupabaseAdminClient>,
): Promise<{
  feedback: AdminPendingMonitoringFeedback[];
  total: number;
  loadErrors: string[];
}> {
  const { data, error } = await admin.rpc("list_pending_monitoring_feedback", {
    p_limit: 500,
  });

  if (error) {
    return {
      feedback: [],
      total: 0,
      loadErrors: [
        /list_pending_monitoring_feedback|monitoring_feedback|schema cache|42P01|PGRST/i.test(
          error.message,
        )
          ? "Monitoring feedback is not migrated for this deployment yet."
          : error.message,
      ],
    };
  }

  const rows = data || [];
  const total = Number(rows[0]?.total_pending || 0);
  return {
    feedback: rows.map((row) => ({
      id: row.feedback_id,
      eventId: row.event_id,
      sourceId: row.source_id,
      awardId: row.award_id,
      eventSummary: row.event_summary,
      eventSourceUrl: row.event_source_url,
      eventSourceTitle: row.event_source_title,
      eventSourcePageType: row.event_source_page_type,
      eventDetectedAt: row.event_detected_at,
      eventEvidence: row.event_evidence,
      reasonCode: row.reason_code,
      note: row.note,
      requestedScope: row.requested_scope,
      policyRuleId: row.policy_rule_id,
      policyVersion: row.policy_version,
      actorEmail: row.actor_email,
      createdAt: row.created_at,
    })),
    total,
    loadErrors: total > rows.length
      ? [`${total - rows.length} additional policy corrections are not shown because the inbox response reached its limit.`]
      : [],
  };
}

async function loadAdminVisualReviewFailures(
  admin: ReturnType<typeof createSupabaseAdminClient>,
): Promise<{ failures: OperatorVisualReviewFailureInput[]; loadErrors: string[] }> {
  const { data, error, count } = await admin
    .from("shared_award_visual_review_candidates")
    .select(
      "id, shared_award_id, shared_award_source_id, source_title, source_url, candidate_signature, rejection_reason, gemini_batch_name, model, estimated_cost_usd, worker_metadata, updated_at",
      { count: "exact" },
    )
    .eq("status", "failed")
    .order("updated_at", { ascending: true })
    .limit(500);

  return {
    failures: (data || []).map((row) => ({
      id: row.id,
      awardId: row.shared_award_id,
      sourceId: row.shared_award_source_id,
      sourceTitle: row.source_title || row.source_url || "Visual review candidate",
      sourceUrl: row.source_url,
      candidateSignature: row.candidate_signature,
      rejectionReason: row.rejection_reason,
      batchName: row.gemini_batch_name,
      model: row.model,
      estimatedCostUsd: row.estimated_cost_usd,
      workerMetadata: row.worker_metadata,
      updatedAt: row.updated_at,
    })),
    loadErrors: [
      error?.message,
      (count || 0) > (data || []).length
        ? `${(count || 0) - (data || []).length} additional visual-review failures are not shown because the inbox reached its 500-item limit.`
        : null,
    ].filter((message): message is string => Boolean(message)),
  };
}

async function loadAdminFailedPublicUpdateDeliveries(
  admin: ReturnType<typeof createSupabaseAdminClient>,
): Promise<{ failures: OperatorDigestDeliveryFailureInput[]; loadErrors: string[] }> {
  const { data, error, count } = await admin
    .from("public_update_deliveries")
    .select("id, digest_key, recipient, recipient_hash, change_event_ids, error, created_at", { count: "exact" })
    .eq("status", "failed")
    .order("created_at", { ascending: true })
    .limit(500);

  return {
    failures: (data || []).map((row) => ({
      id: row.id,
      deliveryType: "digest",
      digestKey: row.digest_key,
      recipient: row.recipient,
      recipientHash: row.recipient_hash,
      changeEventCount: row.change_event_ids.length,
      error: row.error,
      createdAt: row.created_at,
    })),
    loadErrors: [
      error?.message,
      (count || 0) > (data || []).length
        ? `${(count || 0) - (data || []).length} additional public digest failures are not shown because the inbox reached its 500-item limit.`
        : null,
    ].filter((message): message is string => Boolean(message)),
  };
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

function formatDate(value: string) {
  return formatCentralDateTime(value);
}
