import Link from "next/link";
import { AlertTriangle, Database, ExternalLink, Eye, Sparkles } from "lucide-react";
import { AdminPageIssueActions } from "@/components/admin-page-issue-actions";
import { SetupNotice } from "@/components/setup-notice";
import { requireUser, isSiteAdminEmail } from "@/lib/auth";
import { dashboardAwardPath } from "@/lib/award-slugs";
import { appConfig, hasSupabaseAdminConfig, hasSupabaseConfig } from "@/lib/config";
import type {
  AdminPageIssue,
  AdminReviewLaterSource,
  AdminSuppressedChangeEvent,
  PageIssueSeverity,
} from "@/lib/admin-page-issues";
import {
  loadAdminPageIssues,
  loadAdminReviewLaterSources,
  loadAdminSuppressedChangeEvents,
} from "@/lib/admin-page-issues";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { formatCentralDateTime } from "@/lib/time-zone";

export const dynamic = "force-dynamic";

type Props = {
  searchParams: Promise<{
    tab?: string;
    includeResolved?: string;
    includeSuppressed?: string;
    category?: string;
  }>;
};

export default async function AdminPageIssuesPage({ searchParams }: Props) {
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
          <h1 className="mt-4 text-3xl font-black">Page issue review</h1>
          <p className="mt-2 text-[var(--muted)]">
            Supabase service-role access is not configured, so page issue details cannot be loaded.
          </p>
        </div>
      </IssueShell>
    );
  }

  const admin = createSupabaseAdminClient();
  const params = await searchParams;
  const rawTab = params.tab;
  const includeResolved = truthyParam(params.includeResolved);
  const includeSuppressed = truthyParam(params.includeSuppressed);
  const category = typeof params.category === "string" && params.category.trim() ? params.category.trim() : null;
  const activeTab =
    rawTab === "review" || rawTab === "source-quality" || rawTab === "suppressed"
      ? rawTab
      : "active";
  const [{ summary, issues, loadErrors }, reviewLater, suppressedEvents] = await Promise.all([
    loadAdminPageIssues(admin, undefined, { includeResolved, includeSuppressed, category }),
    loadAdminReviewLaterSources(admin),
    loadAdminSuppressedChangeEvents(admin),
  ]);
  const sourceQualityIssues = issues.filter((issue) => issue.area === "Source quality gate");
  const displayedIssues = activeTab === "source-quality" ? sourceQualityIssues : issues;
  const highCount = displayedIssues.filter((issue) => issue.severity === "high").length;
  const mediumCount = displayedIssues.filter((issue) => issue.severity === "medium").length;
  const lowCount = displayedIssues.filter((issue) => issue.severity === "low").length;
  const allLoadErrors = [...loadErrors, ...reviewLater.loadErrors, ...suppressedEvents.loadErrors];

  return (
    <IssueShell>
      <div className="admin-page-header">
        <div>
          <span className="badge">Admin</span>
          <h1 className="admin-page-title">Page issue review</h1>
          <p className="admin-page-copy">
            One place to review source-page errors, blocked pages, repeated capture failures,
            AI-review coverage gaps, sibling/unrelated sources, reconciliation failures, page-audit findings,
            source-intake blockers, suppressed noisy events, missing baselines, and recent worker page errors.
          </p>
          <p className="admin-page-timestamp">Page data refreshed {formatDate(new Date().toISOString())}.</p>
        </div>
      </div>

      {allLoadErrors.length > 0 && (
        <section className="card admin-section-card border-[var(--brand-pink)]">
          <div className="flex items-start gap-3">
            <AlertTriangle size={18} aria-hidden="true" />
            <div>
              <h2 className="font-black">Some issue data could not be loaded</h2>
              <p className="mt-1 text-sm text-[var(--muted)]">{allLoadErrors.join(" ")}</p>
            </div>
          </div>
        </section>
      )}

      <section className="admin-metric-grid admin-metric-grid-primary">
        <MetricCard
          icon={AlertTriangle}
          label="Current issue queue"
          value={formatNumber(summary.queueTotal)}
          detail={`${formatNumber(highCount)} high, ${formatNumber(mediumCount)} medium, ${formatNumber(lowCount)} low`}
          attention={summary.queueTotal > 0}
        />
        <MetricCard
          icon={Database}
          label="Persistent failures"
          value={formatNumber(summary.persistentSourceErrors)}
          detail="Active source pages with 3 or more consecutive failures"
          attention={summary.persistentSourceErrors > 0}
        />
        <MetricCard
          icon={Eye}
          label="Missing snapshots"
          value={formatNumber(summary.missingSnapshots)}
          detail="Active source pages without a published latest snapshot row"
          attention={summary.missingSnapshots > 0}
        />
        <MetricCard
          icon={Sparkles}
          label="Missing page info"
          value={formatNumber(summary.missingPageInfo)}
          detail="Active source pages without extracted page facts"
          attention={summary.missingPageInfo > 0}
        />
        <MetricCard
          icon={AlertTriangle}
          label="Review later"
          value={formatNumber(summary.reviewLater)}
          detail="Source pages held out for manual troubleshooting"
          attention={summary.reviewLater > 0}
        />
        <MetricCard
          icon={Sparkles}
          label="Source-quality rejected"
          value={formatNumber(summary.sourceQualityRejected)}
          detail="Open sources rejected by the hardened monitoring gate"
          attention={summary.sourceQualityRejected > 0}
        />
        <MetricCard
          icon={Database}
          label="Suppressed events"
          value={formatNumber(summary.suppressedChangeEvents)}
          detail="Historical change events hidden from default/public counts"
          attention={summary.suppressedChangeEvents > 0}
        />
      </section>

      <section className="card admin-section-card">
        <div className="admin-panel-heading">
          <div className="flex items-center gap-2">
            <Database size={18} aria-hidden="true" />
            <h2>Workflow Categories</h2>
          </div>
          <span className="badge">{category ? labelize(category) : "All categories"}</span>
        </div>
        <div className="admin-stat-grid admin-stat-grid-compact">
          {Object.entries(summary.categoryCounts).slice(0, 12).map(([name, count]) => (
            <MiniStat key={name} label={labelize(name)} value={count} attention={count > 0 && highSignalCategory(name)} />
          ))}
          {Object.keys(summary.categoryCounts).length === 0 && (
            <MiniStat label="Issues" value={0} />
          )}
        </div>
        <div className="admin-issue-actions mt-3">
          <Link className="admin-issue-link" href="/dashboard/admin/issues?includeResolved=true">
            Include resolved
          </Link>
          <Link className="admin-issue-link" href="/dashboard/admin/issues?includeSuppressed=true">
            Include suppressed
          </Link>
          {category && (
            <Link className="admin-issue-link" href="/dashboard/admin/issues">
              Clear category filter
            </Link>
          )}
        </div>
      </section>

      <nav aria-label="Page issue queue filters" className="admin-subtabs">
        <Link
          aria-current={activeTab === "active" ? "page" : undefined}
          className={`admin-subtab ${activeTab === "active" ? "admin-subtab-active" : ""}`}
          href="/dashboard/admin/issues"
        >
          Active queue
          <span>{formatNumber(issues.length)}</span>
        </Link>
        <Link
          aria-current={activeTab === "review" ? "page" : undefined}
          className={`admin-subtab ${activeTab === "review" ? "admin-subtab-active" : ""}`}
          href="/dashboard/admin/issues?tab=review"
        >
          Review later
          <span>{formatNumber(reviewLater.sources.length)}</span>
        </Link>
        <Link
          aria-current={activeTab === "source-quality" ? "page" : undefined}
          className={`admin-subtab ${activeTab === "source-quality" ? "admin-subtab-active" : ""}`}
          href="/dashboard/admin/issues?tab=source-quality"
        >
          Source quality
          <span>{formatNumber(sourceQualityIssues.length)}</span>
        </Link>
        <Link
          aria-current={activeTab === "suppressed" ? "page" : undefined}
          className={`admin-subtab ${activeTab === "suppressed" ? "admin-subtab-active" : ""}`}
          href="/dashboard/admin/issues?tab=suppressed"
        >
          Suppressed
          <span>{formatNumber(suppressedEvents.events.length)}</span>
        </Link>
      </nav>

      <section className="card admin-section-card admin-issue-panel">
        <div className="admin-panel-heading">
          <div className="flex items-center gap-2">
            <AlertTriangle size={18} aria-hidden="true" />
            <h2>
              {activeTab === "review"
                ? "Review later"
                : activeTab === "source-quality"
                  ? "Source-quality rejected"
                  : activeTab === "suppressed"
                    ? "Suppressed change events"
                    : "Active review queue"}
            </h2>
          </div>
          {activeTab === "active" || activeTab === "source-quality" ? (
            <span className="badge">
              {formatNumber(highCount)} high, {formatNumber(mediumCount)} medium, {formatNumber(lowCount)} low
            </span>
          ) : activeTab === "suppressed" ? (
            <span className="badge">{formatNumber(suppressedEvents.events.length)} suppressed</span>
          ) : (
            <span className="badge">{formatNumber(reviewLater.sources.length)} saved</span>
          )}
        </div>

        {activeTab === "active" || activeTab === "source-quality" ? (
          <>
            <div className="admin-stat-grid admin-stat-grid-compact">
              <MiniStat label="Source errors" value={summary.sourceErrors} attention={summary.sourceErrors > 0} />
              <MiniStat label="Award detail errors" value={summary.awardStructureErrors} attention={summary.awardStructureErrors > 0} />
              <MiniStat label="Source-quality rejects" value={summary.sourceQualityRejected} attention={summary.sourceQualityRejected > 0} />
              <MiniStat label="Worker page errors" value={summary.recentWorkerPageErrors} attention={summary.recentWorkerPageErrors > 0} />
              <MiniStat label="Missing snapshots" value={summary.missingSnapshots} attention={summary.missingSnapshots > 0} />
              <MiniStat label="Missing page info" value={summary.missingPageInfo} attention={summary.missingPageInfo > 0} />
            </div>

            {displayedIssues.length > 0 ? (
              <div className="admin-issue-list">
                {displayedIssues.map((issue) => (
                  <IssueRow issue={issue} key={issue.key} />
                ))}
              </div>
            ) : (
              <p className="mt-4 text-sm font-semibold text-[var(--muted)]">
                No page-level issues are currently reported.
              </p>
            )}
          </>
        ) : activeTab === "suppressed" ? (
          <SuppressedEventList events={suppressedEvents.events} />
        ) : (
          <ReviewLaterList sources={reviewLater.sources} />
        )}
      </section>
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
        <h1 className="mt-4 text-3xl font-black">Page issue review</h1>
        <p className="mt-2 text-[var(--muted)]">
          This page is limited to AwardPing site admins
          {configured ? "." : ". Set AWARDPING_ADMIN_EMAILS to enable access."}
        </p>
      </div>
    </IssueShell>
  );
}

function MetricCard({
  icon: Icon,
  label,
  value,
  detail,
  attention = false,
}: {
  icon: typeof AlertTriangle;
  label: string;
  value: React.ReactNode;
  detail: string;
  attention?: boolean;
}) {
  return (
    <div className={`admin-metric-card ${attention ? "admin-metric-card-attention" : ""}`}>
      <div className="admin-metric-head">
        <p className="admin-metric-label">{label}</p>
        <Icon size={17} aria-hidden="true" />
      </div>
      <p className="admin-metric-value">{value}</p>
      <p className="admin-metric-detail">{detail}</p>
    </div>
  );
}

function MiniStat({
  label,
  value,
  attention = false,
}: {
  label: string;
  value: string | number;
  attention?: boolean;
}) {
  return (
    <div className={`admin-mini-stat ${attention ? "admin-mini-stat-attention" : ""}`}>
      <p className="admin-mini-stat-label">{label}</p>
      <p className="admin-mini-stat-value">{typeof value === "number" ? formatNumber(value) : value}</p>
    </div>
  );
}

function IssueRow({ issue }: { issue: AdminPageIssue }) {
  return (
    <article className={`admin-issue-row admin-issue-row-${issue.severity}`}>
      <div className="min-w-0">
        <div className="admin-issue-meta">
          <SeverityPill severity={issue.severity} />
          <span>{issue.area}</span>
          <span>{issue.label}</span>
          <span>{labelize(issue.category)}</span>
          {issue.failures > 0 && <span>{formatNumber(issue.failures)} failures</span>}
        </div>
        <h3>{issue.awardName}</h3>
        <p className="admin-issue-source">{issue.sourceTitle}</p>
        <p className="admin-issue-message">{issue.message}</p>
        {(issue.currentValue || issue.recommendedAction || issue.relatedWorkerRunId) && (
          <dl className="admin-detail-grid admin-detail-grid-tight mt-3">
            {issue.currentValue && <Detail label="Current" value={issue.currentValue} />}
            {issue.recommendedAction && <Detail label="Recommended" value={issue.recommendedAction} />}
            {issue.relatedWorkerRunId && <Detail label="Worker" value={issue.relatedWorkerRunId} />}
          </dl>
        )}
        <div className="admin-issue-actions">
          {issue.awardId && (
            <Link href={dashboardAwardPath(issue.awardSlug, issue.awardName, issue.awardId)} className="admin-issue-link">
              Award page
            </Link>
          )}
          {issue.sourceUrl && (
            <a href={issue.sourceUrl} className="admin-issue-link" target="_blank" rel="noreferrer">
              Source <ExternalLink size={13} aria-hidden="true" />
            </a>
          )}
        </div>
        <AdminPageIssueActions
          mode="active"
          sourceId={issue.sourceId}
          sourceTitle={issue.sourceTitle}
        />
      </div>
      <time dateTime={issue.checkedAt || undefined}>{issue.checkedAt ? formatDate(issue.checkedAt) : "No check time"}</time>
    </article>
  );
}

function ReviewLaterList({ sources }: { sources: AdminReviewLaterSource[] }) {
  if (sources.length === 0) {
    return (
      <p className="mt-4 text-sm font-semibold text-[var(--muted)]">
        No source pages have been saved for later troubleshooting.
      </p>
    );
  }

  return (
    <div className="admin-issue-list">
      {sources.map((source) => (
        <article className="admin-issue-row admin-issue-row-medium" key={source.id}>
          <div className="min-w-0">
            <div className="admin-issue-meta">
              <span className="admin-severity-pill admin-severity-pill-medium">review</span>
              {source.failures > 0 && <span>{formatNumber(source.failures)} failures</span>}
              {source.reviewedBy && <span>{source.reviewedBy}</span>}
            </div>
            <h3>{source.awardName}</h3>
            <p className="admin-issue-source">{source.sourceTitle}</p>
            <p className="admin-issue-message">{source.note || source.message}</p>
            <div className="admin-issue-actions">
              <Link href={dashboardAwardPath(source.awardSlug, source.awardName, source.awardId)} className="admin-issue-link">
                Award page
              </Link>
              <a href={source.sourceUrl} className="admin-issue-link" target="_blank" rel="noreferrer">
                Source <ExternalLink size={13} aria-hidden="true" />
              </a>
            </div>
            <AdminPageIssueActions
              mode="review"
              sourceId={source.id}
              sourceTitle={source.sourceTitle}
            />
          </div>
          <time dateTime={source.reviewedAt || undefined}>
            {source.reviewedAt ? formatDate(source.reviewedAt) : "No review time"}
          </time>
        </article>
      ))}
    </div>
  );
}

function SuppressedEventList({ events }: { events: AdminSuppressedChangeEvent[] }) {
  if (events.length === 0) {
    return (
      <p className="mt-4 text-sm font-semibold text-[var(--muted)]">
        No suppressed change events are currently reported.
      </p>
    );
  }

  return (
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
            <div className="admin-issue-actions">
              {event.sourceUrl && (
                <a href={event.sourceUrl} className="admin-issue-link" target="_blank" rel="noreferrer">
                  Source <ExternalLink size={13} aria-hidden="true" />
                </a>
              )}
            </div>
          </div>
          <time dateTime={event.suppressedAt || event.detectedAt}>
            {event.suppressedAt ? formatDate(event.suppressedAt) : formatDate(event.detectedAt)}
          </time>
        </article>
      ))}
    </div>
  );
}

function SeverityPill({ severity }: { severity: PageIssueSeverity }) {
  return <span className={`admin-severity-pill admin-severity-pill-${severity}`}>{severity}</span>;
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="admin-detail-item">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function truthyParam(value: string | undefined) {
  return typeof value === "string" && /^(1|true|yes|y)$/i.test(value);
}

function highSignalCategory(value: string) {
  return /unrelated|sibling|critical|deadline|billing|failed|rejected|missing|stale|invented/i.test(value);
}

function labelize(value: string) {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatDate(value: string) {
  return formatCentralDateTime(value);
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}
