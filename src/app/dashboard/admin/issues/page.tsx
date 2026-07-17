import Link from "next/link";
import { AlertTriangle, Archive, CloudDownload, ExternalLink, Gauge, Inbox, Plus, Rocket, ScrollText, ShieldCheck } from "lucide-react";
import { AdminNotAnUpdateControl } from "@/components/admin-not-an-update-control";
import { AdminManualQuarantineBoard } from "@/components/admin-manual-quarantine-board";
import { AdminPageIssueActions } from "@/components/admin-page-issue-actions";
import { AdminRunReport } from "@/components/admin-run-report";
import { AdminStage1ReleaseGate } from "@/components/admin-stage1-release-gate";
import { AdminVerifiedPromotionBoard } from "@/components/admin-verified-promotion-board";
import { AdminWorkerOperationsBoard } from "@/components/admin-worker-operations-board";
import { OperatorActionInbox } from "@/components/operator-action-inbox";
import { SetupNotice } from "@/components/setup-notice";
import { requireUser, isSiteAdminEmail } from "@/lib/auth";
import { alertBlockingMonitoringPolicyFlagIds, candidateMonitoringPolicyFlagIds } from "@/lib/award-monitoring-policy";
import { dashboardAwardPath } from "@/lib/award-slugs";
import { appConfig, hasSupabaseAdminConfig, hasSupabaseConfig } from "@/lib/config";
import type { Database } from "@/lib/database.types";
import { loadAdminManualQuarantine } from "@/lib/admin-manual-quarantine";
import { loadAdminInviteSecurityReissues } from "@/lib/admin-invite-security-reissues";
import {
  defaultAdminManualQuarantineBacklogQuery,
  loadAdminManualQuarantineBacklog,
  loadAdminManualQuarantineSavedViews,
  parseAdminManualQuarantineBacklogQuery,
  type AdminManualQuarantineBacklogSearchParams,
} from "@/lib/admin-manual-quarantine-backlog";
import type { AdminReviewLaterSource, AdminSuppressedChangeEvent } from "@/lib/admin-page-issues";
import {
  loadAdminPageIssues,
  loadAdminReviewLaterSources,
  loadAdminSuppressedChangeEvents,
} from "@/lib/admin-page-issues";
import { buildAdminRunReportFeed } from "@/lib/admin-run-report";
import { loadAdminStage1ReleaseGateEvidence } from "@/lib/admin-stage1-release-gate";
import { loadAdminMonitoringFeedbackPromotionClusters } from "@/lib/admin-monitoring-feedback-promotions";
import {
  loadAdminWorkerOperations,
  scheduledVisualRecoveryWorkerNames,
} from "@/lib/admin-worker-operations";
import {
  buildOperatorActionInbox,
  type OperatorDigestDeliveryFailureInput,
  type OperatorVisualReviewFailureInput,
} from "@/lib/operator-action-inbox";
import { currentMonitoringPromotionAppIdentity } from "@/lib/monitoring-feedback-promotion-identity";
import { summarizeStage1BetaReleaseGate } from "@/lib/stage1-release-gate-summary";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { formatCentralDateTime } from "@/lib/time-zone";

export const dynamic = "force-dynamic";

type Props = {
  searchParams: Promise<AdminManualQuarantineBacklogSearchParams>;
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
          <h1 className="mt-4 text-3xl font-black">Admin workflows</h1>
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
    params.tab === "inbox" ||
    params.tab === "promotions" ||
    params.tab === "quarantine" ||
    params.tab === "recovery" ||
    params.tab === "operations" ||
    params.tab === "updates" ||
    params.tab === "suppressed" ||
    params.tab === "excluded"
      ? params.tab
      : "release";
  const backlogQuery =
    activeTab === "quarantine"
      ? parseAdminManualQuarantineBacklogQuery(params)
      : defaultAdminManualQuarantineBacklogQuery();
  const renderedAt = new Date();
  const [
    workerRunsResult,
    recoveryWorkerRunsResult,
    manualQuarantine,
    manualQuarantineBacklog,
    manualQuarantineSavedViews,
    quarantinedVisualCandidates,
  ] = await Promise.all([
    admin
      .from("local_worker_runs")
      .select("*")
      .order("started_at", { ascending: false })
      .limit(200),
    admin
      .from("local_worker_runs")
      .select("*")
      .in("worker_name", [...scheduledVisualRecoveryWorkerNames])
      .order("started_at", { ascending: false })
      .limit(300),
    loadAdminManualQuarantine(admin, { includeItems: false }),
    loadAdminManualQuarantineBacklog(admin, backlogQuery),
    loadAdminManualQuarantineSavedViews(admin, user.id),
    loadQuarantinedVisualCandidateIds(admin),
  ]);
  const workerRuns = (workerRunsResult.data || []) as LocalWorkerRun[];
  const recoveryWorkerRuns = (recoveryWorkerRunsResult.data || []) as LocalWorkerRun[];
  const allRelevantWorkerRuns = [
    ...new Map([...workerRuns, ...recoveryWorkerRuns].map((run) => [run.id, run])).values(),
  ];
  const runReport = buildAdminRunReportFeed(allRelevantWorkerRuns, renderedAt);
  const visualQuarantineRevisionMatches =
    manualQuarantineBacklog.available &&
    quarantinedVisualCandidates.revision !== null &&
    quarantinedVisualCandidates.revision ===
      manualQuarantineBacklog.backlog.backlogRevision;
  const visualQuarantineRevisionErrors =
    manualQuarantineBacklog.available &&
    quarantinedVisualCandidates.revision !== null &&
    !visualQuarantineRevisionMatches
      ? [
          "The quarantine backlog changed while visual-review failures were being matched. Fallback failures remain visible until the next refresh.",
        ]
      : [];

  const [
    pageIssues,
    reviewLater,
    promotionClusters,
    visualReviewFailures,
    deliveryFailures,
    recentUpdates,
    suppressedEvents,
    workerOperations,
    releaseEvidence,
    inviteSecurityReissues,
  ] = await Promise.all([
    loadAdminPageIssues(admin, workerRuns, {
      includeLegacyDiagnostics: false,
      includeQuarantinedDiagnostics: !manualQuarantineBacklog.available,
    }),
    loadAdminReviewLaterSources(admin),
    loadAdminMonitoringFeedbackPromotionClusters(admin),
    loadAdminVisualReviewFailures(admin),
    loadAdminFailedPublicUpdateDeliveries(admin),
    loadAdminRecentChangeEvents(admin),
    loadAdminSuppressedChangeEvents(admin),
    loadAdminWorkerOperations(
      admin,
      recoveryWorkerRuns,
      recoveryWorkerRunsResult.error?.message ? [recoveryWorkerRunsResult.error.message] : [],
      renderedAt,
    ),
    activeTab === "release"
      ? loadAdminStage1ReleaseGateEvidence(admin)
      : Promise.resolve(null),
    loadAdminInviteSecurityReissues(admin),
  ]);
  const releaseGate = releaseEvidence
    ? summarizeStage1BetaReleaseGate({
        ...releaseEvidence,
        now: renderedAt,
        appIdentity: currentMonitoringPromotionAppIdentity(),
        visualNightly: runReport.visualNightly,
        visualWorkerRuns: allRelevantWorkerRuns,
        budgets: workerOperations.budgets,
        lanes: workerOperations.lanes,
        evidenceRecovery: workerOperations.evidenceRecovery,
        loadErrors: [
          ...(releaseEvidence.loadErrors || []),
          ...(workerRunsResult.error?.message ? [`Worker run report: ${workerRunsResult.error.message}`] : []),
          ...(recoveryWorkerRunsResult.error?.message
            ? [`Scheduled 6 PM shard identity: ${recoveryWorkerRunsResult.error.message}`]
            : []),
          ...workerOperations.operationsLoadErrors,
        ],
      })
    : null;
  const actionLoadErrors = [
    workerRunsResult.error?.message,
    ...pageIssues.loadErrors,
    ...promotionClusters.loadErrors,
    ...visualReviewFailures.loadErrors,
    ...deliveryFailures.loadErrors,
    ...manualQuarantine.loadErrors,
    ...manualQuarantineBacklog.loadErrors,
    ...quarantinedVisualCandidates.loadErrors,
    ...visualQuarantineRevisionErrors,
    ...workerOperations.loadErrors,
    ...inviteSecurityReissues.loadErrors,
  ].filter((message): message is string => Boolean(message));
  const historyLoadErrors = [
    ...reviewLater.loadErrors,
    ...recentUpdates.loadErrors,
    ...suppressedEvents.loadErrors,
  ].filter((message): message is string => Boolean(message));
  const actionItems = buildOperatorActionInbox({
    issues: pageIssues.issues,
    manualQuarantineBacklog:
      manualQuarantineBacklog.available &&
      manualQuarantineBacklog.backlog.unfilteredExactTotal > 0
        ? {
            exactTotal: manualQuarantineBacklog.backlog.unfilteredExactTotal,
            exactClusterTotal: manualQuarantineBacklog.backlog.exactClusterTotal,
            evidenceRecords: manualQuarantineBacklog.backlog.evidenceRecords,
            terminalCases: manualQuarantineBacklog.backlog.terminalCases,
            unassignedCases: manualQuarantineBacklog.backlog.unassignedCases,
            chargeGatedCases: manualQuarantineBacklog.backlog.chargeGatedCases,
            oldestObservedAt: manualQuarantineBacklog.backlog.oldestObservedAt,
            registrySyncedAt: manualQuarantineBacklog.backlog.registrySyncedAt,
          }
        : null,
    promotionClusters: promotionClusters.clusters,
    nightlyFailureGroups: runReport.visualNightly?.failureGroups || [],
    nightlyReportedAt: runReport.visualNightly?.finishedAt || runReport.visualNightly?.startedAt || null,
    visualReviewFailures: visualReviewFailures.failures.filter(
      (failure) =>
        !visualQuarantineRevisionMatches ||
        !quarantinedVisualCandidates.ids.has(failure.id),
    ),
    digestDeliveryFailures: deliveryFailures.failures,
    inviteSecurityReissues: inviteSecurityReissues.reissues,
    downstreamLanes: workerOperations.lanes,
    loadErrors: actionLoadErrors,
    now: renderedAt,
  });

  return (
    <IssueShell>
      <div className="admin-page-header">
        <div>
          <span className="badge">Admin</span>
          <h1 className="admin-page-title">Admin workflows</h1>
          <p className="admin-page-copy">
            1 keeps the 25-award beta release closed until every proof passes. 3 repairs current failures. 4 verifies
            global feedback rules. 5 keeps unresolved work visible. 6 protects recoverable evidence. 7 shows every
            independent lane and the two fixed daily budgets.
          </p>
          <p className="admin-page-timestamp">Refreshed {formatDate(renderedAt.toISOString())}.</p>
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

      <nav aria-label="Primary admin workflows" className="admin-subtabs admin-workflow-tabs">
        <Link
          aria-current={activeTab === "release" ? "page" : undefined}
          className={`admin-subtab ${activeTab === "release" ? "admin-subtab-active" : ""}`}
          href="/dashboard/admin/issues"
        >
          <Rocket size={15} aria-hidden="true" />
          1. Beta Release Gate
        </Link>
        <Link
          aria-current={activeTab === "inbox" ? "page" : undefined}
          className={`admin-subtab ${activeTab === "inbox" ? "admin-subtab-active" : ""}`}
          href="/dashboard/admin/issues?tab=inbox"
        >
          <Inbox size={15} aria-hidden="true" />
          3. Action Inbox
        </Link>
        <Link
          aria-current={activeTab === "promotions" ? "page" : undefined}
          className={`admin-subtab ${activeTab === "promotions" ? "admin-subtab-active" : ""}`}
          href="/dashboard/admin/issues?tab=promotions"
        >
          <ShieldCheck size={15} aria-hidden="true" />
          4. Verified Promotions
        </Link>
        <Link
          aria-current={activeTab === "quarantine" ? "page" : undefined}
          className={`admin-subtab ${activeTab === "quarantine" ? "admin-subtab-active" : ""}`}
          href="/dashboard/admin/issues?tab=quarantine"
        >
          <Archive size={15} aria-hidden="true" />
          5. Manual Quarantine
        </Link>
        <Link
          aria-current={activeTab === "recovery" ? "page" : undefined}
          className={`admin-subtab ${activeTab === "recovery" ? "admin-subtab-active" : ""}`}
          href="/dashboard/admin/issues?tab=recovery"
        >
          <CloudDownload size={15} aria-hidden="true" />
          6. Evidence Recovery
        </Link>
        <Link
          aria-current={activeTab === "operations" ? "page" : undefined}
          className={`admin-subtab ${activeTab === "operations" ? "admin-subtab-active" : ""}`}
          href="/dashboard/admin/issues?tab=operations"
        >
          <Gauge size={15} aria-hidden="true" />
          7. Lanes &amp; Spending
        </Link>
      </nav>

      <nav aria-label="Admin history views" className="admin-subtabs admin-history-tabs">
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

      {activeTab === "release" && releaseGate ? (
        <AdminStage1ReleaseGate summary={releaseGate} />
      ) : activeTab === "inbox" ? (
        <>
          <AdminRunReport compact initialFeed={runReport} />
          <OperatorActionInbox items={actionItems} />
        </>
      ) : activeTab === "promotions" ? (
        <>
          {promotionClusters.loadErrors.length > 0 && (
            <div className="operator-history-load-warning" role="status">
              <AlertTriangle size={17} aria-hidden="true" />
              {promotionClusters.loadErrors.join(" ")}
            </div>
          )}
          <AdminVerifiedPromotionBoard
            candidateRuleIds={candidateMonitoringPolicyFlagIds}
            clusters={promotionClusters.clusters}
          />
        </>
      ) : activeTab === "quarantine" ? (
        <AdminManualQuarantineBoard
          backlogResult={manualQuarantineBacklog}
          currentUserEmail={user.email || ""}
          currentUserId={user.id}
          query={backlogQuery}
          result={manualQuarantine}
          savedViewsResult={manualQuarantineSavedViews}
        />
      ) : activeTab === "recovery" ? (
        <AdminWorkerOperationsBoard result={workerOperations} view="recovery" now={renderedAt.toISOString()} />
      ) : activeTab === "operations" ? (
        <AdminWorkerOperationsBoard result={workerOperations} view="operations" now={renderedAt.toISOString()} />
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
        <h1 className="mt-4 text-3xl font-black">Admin workflows</h1>
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
            If an update is not real, hide it here and send the evidence into the Action Inbox for reviewed global
            policy promotion.
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
                    <a className="admin-issue-link" href={event.sourceUrl} rel="noreferrer" target="_blank">
                      Source <ExternalLink size={13} aria-hidden="true" />
                    </a>
                  )}
                </div>
                <AdminNotAnUpdateControl eventId={event.id} policyRuleIds={alertBlockingMonitoringPolicyFlagIds} />
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
      <p className="text-sm font-semibold text-[var(--muted)]">No suppressed change events are currently reported.</p>
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
            These are completed monitoring decisions, not open actions. Restore a source only if new evidence makes it
            official and monitorable again.
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
                  <Link
                    href={dashboardAwardPath(source.awardSlug, source.awardName, source.awardId)}
                    className="admin-issue-link"
                  >
                    Award page
                  </Link>
                  {safeExternalUrl(source.sourceUrl) && (
                    <a href={source.sourceUrl} className="admin-issue-link" target="_blank" rel="noreferrer">
                      Source <ExternalLink size={13} aria-hidden="true" />
                    </a>
                  )}
                </div>
                <AdminPageIssueActions mode="review" sourceId={source.id} sourceTitle={source.sourceTitle} />
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
    .select("id, shared_award_id, shared_award_source_id, source_title, source_url, summary, detected_at")
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

async function loadAdminVisualReviewFailures(admin: ReturnType<typeof createSupabaseAdminClient>): Promise<{
  failures: OperatorVisualReviewFailureInput[];
  loadErrors: string[];
}> {
  const { data, error, count } = await admin
    .from("shared_award_visual_review_candidates")
    .select(
      "id, shared_award_id, shared_award_source_id, source_title, source_url, candidate_signature, rejection_reason, gemini_batch_name, model, estimated_cost_usd, worker_metadata, updated_at",
      {
        count: "exact",
      },
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

async function loadAdminFailedPublicUpdateDeliveries(admin: ReturnType<typeof createSupabaseAdminClient>): Promise<{
  failures: OperatorDigestDeliveryFailureInput[];
  loadErrors: string[];
}> {
  const [outbox, legacy] = await Promise.all([
    admin
      .from("public_digest_outbox")
      .select(
        "id, digest_key, recipient_hash, change_event_ids, status, last_error, send_attempt_count, first_provider_attempt_at, next_attempt_at, payload_hash, payload_schema_version, created_at, updated_at",
        { count: "exact" },
      )
      .in("status", ["ambiguous", "terminal_failed", "release_blocked"])
      .order("updated_at", { ascending: true })
      .limit(500),
    admin
      .from("public_update_deliveries")
      .select(
        "id, digest_key, recipient, recipient_hash, change_event_ids, error, delivery_contract_version, payload_hash, created_at",
        { count: "exact" },
      )
      .eq("status", "failed")
      .order("created_at", { ascending: true })
      .limit(500),
  ]);

  const failures: OperatorDigestDeliveryFailureInput[] = [
    ...(outbox.data || []).map((row) => ({
      id: row.id,
      deliveryType: "public digest outbox",
      state: row.status as "ambiguous" | "terminal_failed" | "release_blocked",
      digestKey: row.digest_key,
      recipient: null,
      recipientHash: row.recipient_hash,
      changeEventCount: row.change_event_ids.length,
      error: row.last_error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      payloadHash: row.payload_hash,
      attemptCount: row.send_attempt_count,
      firstProviderAttemptAt: row.first_provider_attempt_at,
      nextAttemptAt: row.next_attempt_at,
      contractVersion: row.payload_schema_version,
    })),
    ...(legacy.data || []).map((row) => ({
      id: row.id,
      deliveryType: "legacy digest",
      state: "legacy_failed" as const,
      digestKey: row.digest_key,
      recipient: row.recipient,
      recipientHash: row.recipient_hash,
      changeEventCount: row.change_event_ids.length,
      error: row.error,
      createdAt: row.created_at,
      payloadHash: row.payload_hash,
      contractVersion: row.delivery_contract_version,
    })),
  ];

  return {
    failures,
    loadErrors: [
      outbox.error?.message,
      legacy.error?.message,
      (outbox.count || 0) > (outbox.data || []).length
        ? `${(outbox.count || 0) - (outbox.data || []).length} additional durable public digest outbox actions are not shown because the inbox reached its 500-item limit.`
        : null,
      (legacy.count || 0) > (legacy.data || []).length
        ? `${(legacy.count || 0) - (legacy.data || []).length} additional legacy public digest failures are not shown because the inbox reached its 500-item limit.`
        : null,
    ].filter((message): message is string => Boolean(message)),
  };
}

async function loadQuarantinedVisualCandidateIds(
  admin: ReturnType<typeof createSupabaseAdminClient>,
): Promise<{ ids: Set<string>; loadErrors: string[]; revision: number | null }> {
  const ids = new Set<string>();
  const pageSize = 1_000;
  let expectedTotal: number | null = null;
  const startingRevision = await loadManualQuarantineBacklogRevision(admin);

  if (!startingRevision.ok) {
    return {
      ids: new Set<string>(),
      loadErrors: [startingRevision.error],
      revision: null,
    };
  }

  for (let start = 0; ; start += pageSize) {
    const result = await admin
      .from("manual_quarantine_registry")
      .select("visual_review_candidate_id", { count: "exact" })
      .eq("requires_action", true)
      .in("status", ["quarantined", "in_review"])
      .not("visual_review_candidate_id", "is", null)
      .order("visual_review_candidate_id", { ascending: true })
      .range(start, start + pageSize - 1);

    if (result.error) {
      return {
        // A partial exclusion set could hide fallback failures that were not
        // yet reached. Fail open to possible duplicates instead of omissions.
        ids: new Set<string>(),
        loadErrors: [
          `Quarantined visual-review candidates could not be excluded from the fallback failure list: ${result.error.message}.`,
        ],
        revision: null,
      };
    }

    const rows = result.data || [];
    const pageTotal = Number(result.count);
    if (
      result.count === null ||
      !Number.isSafeInteger(pageTotal) ||
      pageTotal < 0 ||
      pageTotal < start + rows.length
    ) {
      return {
        ids: new Set<string>(),
        loadErrors: [
          "The exact quarantined visual-review count was unavailable, so fallback failures were not excluded.",
        ],
        revision: null,
      };
    }
    if (expectedTotal === null) expectedTotal = pageTotal;
    if (pageTotal !== expectedTotal) {
      return {
        ids: new Set<string>(),
        loadErrors: [
          "The quarantine registry changed while visual-review candidates were being matched. Refresh before acting on fallback visual failures.",
        ],
        revision: null,
      };
    }
    rows.forEach((row) => {
      if (row.visual_review_candidate_id) ids.add(row.visual_review_candidate_id);
    });
    if (start + rows.length >= expectedTotal || rows.length < pageSize) break;
  }

  const endingRevision = await loadManualQuarantineBacklogRevision(admin);
  if (!endingRevision.ok || endingRevision.revision !== startingRevision.revision) {
    return {
      ids: new Set<string>(),
      loadErrors: [
        endingRevision.ok
          ? "The quarantine registry changed while visual-review candidates were being matched. Refresh before acting on fallback visual failures."
          : endingRevision.error,
      ],
      revision: null,
    };
  }

  return { ids, loadErrors: [], revision: endingRevision.revision };
}

async function loadManualQuarantineBacklogRevision(
  admin: ReturnType<typeof createSupabaseAdminClient>,
): Promise<
  | { ok: true; revision: number }
  | { ok: false; error: string }
> {
  const result = await admin
    .from("manual_quarantine_backlog_state")
    .select("revision")
    .eq("state_key", "operator_backlog")
    .maybeSingle();
  const revision = Number(result.data?.revision);
  if (result.error || !Number.isSafeInteger(revision) || revision <= 0) {
    return {
      ok: false,
      error:
        "The quarantine backlog revision could not be verified, so fallback visual failures were not excluded.",
    };
  }
  return { ok: true, revision };
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
