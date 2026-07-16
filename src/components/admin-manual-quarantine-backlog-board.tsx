import Link from "next/link";
import {
  AlertTriangle,
  CalendarClock,
  Layers3,
  ShieldCheck,
  UserRoundCheck,
} from "lucide-react";
import { AdminManualQuarantineBacklogControls } from "@/components/admin-manual-quarantine-backlog-controls";
import { AdminManualQuarantineBacklogQueue } from "@/components/admin-manual-quarantine-backlog-queue";
import {
  adminManualQuarantineBacklogHref,
  adminManualQuarantineClusterHref,
  adminManualQuarantineSavedViewHref,
} from "@/lib/admin-manual-quarantine-backlog";
import type {
  AdminManualQuarantineBacklogCluster,
  AdminManualQuarantineBacklogLoadResult,
  AdminManualQuarantineBacklogQuery,
  AdminManualQuarantineSavedViewsLoadResult,
  AdminManualQuarantineGroupBy,
} from "@/lib/admin-manual-quarantine-backlog";
import { formatCentralDateTime } from "@/lib/time-zone";

type Props = {
  currentUserEmail: string;
  currentUserId: string;
  query: AdminManualQuarantineBacklogQuery;
  result: AdminManualQuarantineBacklogLoadResult;
  savedViews: AdminManualQuarantineSavedViewsLoadResult;
};

const groupLabels = {
  repair_group: "full repair groups",
  domain: "source domains",
  evidence_failure: "evidence failures",
  policy_reason: "policy reasons",
  likely_repair: "likely repairs",
} as const;

export function AdminManualQuarantineBacklogBoard({
  currentUserEmail,
  currentUserId,
  query,
  result,
  savedViews,
}: Props) {
  const { backlog } = result;
  const activeView = savedViews.views.find(
    (view) => view.id === query.activeViewId,
  );
  const savedViewOptions = savedViews.views.map((view) => ({
    href: adminManualQuarantineSavedViewHref(view),
    id: view.id,
    name: view.name,
  }));
  const clusterRange = displayedRange(
    backlog.clusterPage,
    backlog.clusterPageSize,
    backlog.exactClusterTotal,
    backlog.clusters.length,
  );
  const caseRange = displayedRange(
    backlog.page,
    backlog.pageSize,
    backlog.exactTotal,
    backlog.items.length,
  );
  const oldestExact = backlog.oldestObservedAt
    ? formatCentralDateTime(backlog.oldestObservedAt)
    : "No open cases";
  const exactTotalCopy = result.available
    ? backlog.exactTotal === backlog.unfilteredExactTotal
      ? `${formatNumber(backlog.exactTotal)} exact actionable ${plural(backlog.exactTotal, "case")}. The total comes from the full registry query, not the number of rows on this page.`
      : `${formatNumber(backlog.exactTotal)} of ${formatNumber(backlog.unfilteredExactTotal)} exact actionable cases match. The total comes from the full registry query, not the number of rows on this page.`
    : "Exact quarantine counts are unavailable. No missing registry data is shown as zero.";
  const controlsStateKey = JSON.stringify({
    activeViewId: activeView?.id || null,
    activeViewName: activeView?.name || "",
    query,
  });
  const queueStateKey = [
    backlog.registrySyncedAt || "no-snapshot",
    backlog.backlogRevision || "no-revision",
    backlog.asOf || "no-age-clock",
    backlog.page,
    ...backlog.items.map((item) => `${item.id}:${item.evidenceHash}`),
  ].join("|");

  return (
    <section
      aria-labelledby="manual-quarantine-backlog-title"
      className="manual-backlog"
    >
      <div className="card manual-backlog-summary">
        <div>
          <p className="operator-inbox-kicker">One backlog, grouped by a shared repair</p>
          <h3 id="manual-quarantine-backlog-title">Quarantine work queue</h3>
          <p>{exactTotalCopy}</p>
        </div>
        <span
          className={`operator-inbox-summary-status ${
            result.available
              ? ""
              : "operator-inbox-summary-status-attention"
          }`}
        >
          {result.available ? (
            <ShieldCheck aria-hidden="true" size={16} />
          ) : (
            <AlertTriangle aria-hidden="true" size={16} />
          )}
          {result.available ? "Exact queue is current" : "Queue actions unavailable"}
        </span>
      </div>

      {[...result.loadErrors, ...savedViews.loadErrors].length > 0 && (
        <div className="operator-history-load-warning" role="status">
          <AlertTriangle aria-hidden="true" size={17} />
          {[...result.loadErrors, ...savedViews.loadErrors].join(" ")}
        </div>
      )}

      {result.available && (
        <>
      <dl className="manual-backlog-stat-grid">
        <div className="admin-metric-card">
          <dt className="admin-metric-head">
            <span className="admin-metric-label">Filtered cases</span>
            <Layers3 aria-hidden="true" size={17} />
          </dt>
          <dd className="admin-metric-value">
            {formatNumber(backlog.exactTotal)}
            <p className="admin-metric-detail">
              Exact total across every matching case; {formatNumber(backlog.items.length)} are on this page.
            </p>
          </dd>
        </div>
        <div className="admin-metric-card">
          <dt className="admin-metric-head">
            <span className="admin-metric-label">Current groups</span>
            <Layers3 aria-hidden="true" size={17} />
          </dt>
          <dd className="admin-metric-value">
            {formatNumber(backlog.exactClusterTotal)}
            <p className="admin-metric-detail">
              Grouped as {groupLabels[backlog.groupBy]} so one repair can cover similar cases.
            </p>
          </dd>
        </div>
        <div className="admin-metric-card">
          <dt className="admin-metric-head">
            <span className="admin-metric-label">Needs an assignee</span>
            <UserRoundCheck aria-hidden="true" size={17} />
          </dt>
          <dd className="admin-metric-value">
            {formatNumber(backlog.unassignedCases)}
            <p className="admin-metric-detail">
              Functional ownership remains separate from the person currently handling a case.
            </p>
          </dd>
        </div>
        <div className="admin-metric-card">
          <dt className="admin-metric-head">
            <span className="admin-metric-label">Oldest matching case</span>
            <CalendarClock aria-hidden="true" size={17} />
          </dt>
          <dd className="admin-metric-value manual-backlog-date-value">
            {ageLabel(backlog.oldestObservedAt, backlog.asOf)}
            <p className="admin-metric-detail">{oldestExact}</p>
          </dd>
        </div>
      </dl>

      <AdminManualQuarantineBacklogControls
        activeViewId={activeView?.id || null}
        activeViewName={activeView?.name || ""}
        available={result.available}
        facets={backlog.facets}
        key={controlsStateKey}
        query={query}
        savedViewOptions={savedViewOptions}
        savedViewsAvailable={savedViews.available}
      />

      <div className="card manual-backlog-cluster-panel">
        <div className="manual-backlog-section-heading">
          <div>
            <p className="operator-inbox-kicker">Shared causes, shared solutions</p>
            <h3>{capitalize(groupLabels[backlog.groupBy])}</h3>
            <p>
              Showing {formatRange(clusterRange)} of {formatNumber(backlog.exactClusterTotal)} exact {plural(backlog.exactClusterTotal, "group")}.
            </p>
          </div>
          <span className="operator-state-pill operator-state-pill-needs_operator">
            {formatNumber(backlog.terminalCases)} terminal {plural(backlog.terminalCases, "case")}
          </span>
        </div>

        {backlog.clusters.length > 0 ? (
          <div className="manual-backlog-cluster-grid">
            {backlog.clusters.map((cluster) => (
              <article className="manual-backlog-cluster" key={cluster.key}>
                <div className="manual-backlog-cluster-header">
                  <div>
                    <h4>{cluster.label}</h4>
                    <p>
                      {formatNumber(cluster.cases)} exact {plural(cluster.cases, "case")} · {formatNumber(cluster.evidenceRecords)} linked evidence {plural(cluster.evidenceRecords, "record")}
                    </p>
                  </div>
                  <span className="operator-state-pill operator-state-pill-needs_operator">
                    {ageLabel(cluster.oldestObservedAt, backlog.asOf)}
                  </span>
                </div>
                <dl className="manual-backlog-cluster-facts">
                  {clusterFacts(cluster, backlog.groupBy).map((fact) => (
                    <div key={fact.label}>
                      <dt>{fact.label}</dt>
                      <dd>{fact.value}</dd>
                    </div>
                  ))}
                </dl>
                <div className="manual-backlog-cluster-footer">
                  <span>{formatNumber(cluster.unassignedCases)} unassigned</span>
                  <span>{formatNumber(cluster.chargeGatedCases)} require individual charge review</span>
                  <Link
                    className="button-secondary"
                    href={adminManualQuarantineClusterHref(query, cluster.key)}
                  >
                    Open cases
                  </Link>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <p className="manual-backlog-empty-copy">
            No repair groups match these filters. Clear a filter or choose a saved view.
          </p>
        )}

        <nav aria-label="Repair group pages" className="manual-backlog-pagination">
          {backlog.clusterPage > 1 ? (
            <Link
              className="button-secondary"
              href={adminManualQuarantineBacklogHref(query, {
                clusterPage: backlog.clusterPage - 1,
                snapshotAt: backlog.registrySyncedAt,
                snapshotRevision: backlog.backlogRevision,
                asOfAt: backlog.asOf,
              })}
            >
              Previous groups
            </Link>
          ) : (
            <span aria-disabled="true" className="button-secondary manual-backlog-disabled-link">
              Previous groups
            </span>
          )}
          <span>
            Group page {formatNumber(backlog.clusterPage)} of {formatNumber(backlog.clusterPageCount)}
          </span>
          {backlog.clusterPage < backlog.clusterPageCount ? (
            <Link
              className="button-secondary"
              href={adminManualQuarantineBacklogHref(query, {
                clusterPage: backlog.clusterPage + 1,
                snapshotAt: backlog.registrySyncedAt,
                snapshotRevision: backlog.backlogRevision,
                asOfAt: backlog.asOf,
              })}
            >
              Next groups
            </Link>
          ) : (
            <span aria-disabled="true" className="button-secondary manual-backlog-disabled-link">
              Next groups
            </span>
          )}
        </nav>
      </div>

      <div className="manual-backlog-case-panel">
        <div className="manual-backlog-section-heading">
          <div>
            <p className="operator-inbox-kicker">Paginated case details</p>
            <h3>Cases in this view</h3>
            <p>
              Showing {formatRange(caseRange)} of {formatNumber(backlog.exactTotal)} exact filtered {plural(backlog.exactTotal, "case")}. Page {formatNumber(backlog.page)} of {formatNumber(backlog.pageCount)}.
            </p>
          </div>
          <span className="operator-state-pill operator-state-pill-auto_retrying">
            {formatNumber(backlog.evidenceRecords)} evidence {plural(backlog.evidenceRecords, "record")}
          </span>
        </div>

        <AdminManualQuarantineBacklogQueue
          available={result.available}
          currentUserEmail={currentUserEmail}
          currentUserId={currentUserId}
          items={backlog.items}
          key={queueStateKey}
          refreshHref={adminManualQuarantineBacklogHref(query, {
            asOfAt: null,
            clusterPage: 1,
            page: 1,
            snapshotAt: null,
            snapshotRevision: null,
          })}
        />

        <nav aria-label="Quarantine case pages" className="manual-backlog-pagination">
          {backlog.page > 1 ? (
            <Link
              className="button-secondary"
              href={adminManualQuarantineBacklogHref(query, {
                page: backlog.page - 1,
                snapshotAt: backlog.registrySyncedAt,
                snapshotRevision: backlog.backlogRevision,
                asOfAt: backlog.asOf,
              })}
            >
              Previous cases
            </Link>
          ) : (
            <span aria-disabled="true" className="button-secondary manual-backlog-disabled-link">
              Previous cases
            </span>
          )}
          <span>
            Case page {formatNumber(backlog.page)} of {formatNumber(backlog.pageCount)}
          </span>
          {backlog.page < backlog.pageCount ? (
            <Link
              className="button-secondary"
              href={adminManualQuarantineBacklogHref(query, {
                page: backlog.page + 1,
                snapshotAt: backlog.registrySyncedAt,
                snapshotRevision: backlog.backlogRevision,
                asOfAt: backlog.asOf,
              })}
            >
              Next cases
            </Link>
          ) : (
            <span aria-disabled="true" className="button-secondary manual-backlog-disabled-link">
              Next cases
            </span>
          )}
        </nav>
      </div>
        </>
      )}
    </section>
  );
}

function displayedRange(
  page: number,
  pageSize: number,
  total: number,
  displayed: number,
) {
  if (total === 0 || displayed === 0) return { end: 0, start: 0 };
  const start = (Math.max(1, page) - 1) * Math.max(1, pageSize) + 1;
  return { end: Math.min(total, start + displayed - 1), start };
}

function clusterFacts(
  cluster: AdminManualQuarantineBacklogCluster,
  groupBy: AdminManualQuarantineGroupBy,
) {
  const facts = {
    domain: { label: "Source domain", value: cluster.sourceDomain },
    evidence_failure: {
      label: "Evidence failure",
      value: cluster.evidenceFailureLabel,
    },
    policy_reason: {
      label: "Policy reason",
      value: cluster.policyReasonLabel,
    },
    likely_repair: {
      label: "Likely repair",
      value: cluster.likelyRepairLabel,
    },
  } as const;
  if (groupBy === "repair_group") {
    return [
      facts.domain,
      facts.evidence_failure,
      facts.policy_reason,
      facts.likely_repair,
    ];
  }
  return [facts[groupBy]];
}

function formatRange(range: { end: number; start: number }) {
  if (range.start === 0) return "0";
  return `${formatNumber(range.start)}–${formatNumber(range.end)}`;
}

function ageLabel(value: string | null, asOf: string | null) {
  if (!value) return "No open cases";
  const start = Date.parse(value);
  const end = Date.parse(asOf || new Date().toISOString());
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "Age unavailable";
  const days = Math.max(0, Math.floor((end - start) / 86_400_000));
  if (days === 0) return "Under 24h old";
  if (days === 1) return "1 day old";
  if (days < 14) return `${days} days old`;
  const weeks = Math.floor(days / 7);
  if (weeks < 9) return `${weeks} weeks old`;
  return `${Math.max(1, Math.floor(days / 30))} months old`;
}

function capitalize(value: string) {
  return value ? value[0].toUpperCase() + value.slice(1) : value;
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

function plural(value: number, singular: string) {
  return value === 1 ? singular : `${singular}s`;
}
