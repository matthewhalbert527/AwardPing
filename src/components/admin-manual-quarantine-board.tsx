import {
  AlertTriangle,
  Archive,
  Bot,
  CameraOff,
  CheckCircle2,
  FileSearch,
  History,
  ShieldAlert,
} from "lucide-react";
import { AdminManualQuarantineBacklogBoard } from "@/components/admin-manual-quarantine-backlog-board";
import type {
  AdminManualQuarantineCategorySummary,
  AdminManualQuarantineLoadResult,
} from "@/lib/admin-manual-quarantine";
import type {
  AdminManualQuarantineBacklogLoadResult,
  AdminManualQuarantineBacklogQuery,
  AdminManualQuarantineSavedViewsLoadResult,
} from "@/lib/admin-manual-quarantine-backlog";
import { formatCentralDateTime } from "@/lib/time-zone";

type Props = {
  backlogResult: AdminManualQuarantineBacklogLoadResult;
  currentUserEmail: string;
  currentUserId: string;
  query: AdminManualQuarantineBacklogQuery;
  result: AdminManualQuarantineLoadResult;
  savedViewsResult: AdminManualQuarantineSavedViewsLoadResult;
};

export function AdminManualQuarantineBoard({
  backlogResult,
  currentUserEmail,
  currentUserId,
  query,
  result,
  savedViewsResult,
}: Props) {
  const { summary } = result;
  const historicalImported = summary.historicalInventoryStatus === "complete";
  const completionReportedAt = summary.completionReportedAt
    ? formatCentralDateTime(summary.completionReportedAt)
    : "";
  const completionAssessmentReported = Boolean(
    completionReportedAt &&
      summary.completionStatus !== "not_reported" &&
      summary.automatedWorkClear !== null,
  );
  const statusCopy = quarantineStatusCopy(
    result,
    completionAssessmentReported,
  );

  return (
    <section
      className="operator-inbox"
      aria-labelledby="manual-quarantine-title"
    >
      <div className="card operator-inbox-summary">
        <div>
          <p className="operator-inbox-kicker">
            Truthful completion plus one repair backlog
          </p>
          <h2 id="manual-quarantine-title">5. Manual Quarantine</h2>
          <p>{statusCopy}</p>
          {result.registryAvailable && (
            <p>
              {formatNumber(summary.quarantineEvidenceRecords)} linked evidence
              records are preserved. Audit and reconciliation evidence for the
              same award are grouped so they are not mistaken for separate
              actions.
            </p>
          )}
        </div>
        {result.registryAvailable ? (
          <span
            className={`operator-inbox-summary-status ${
              summary.terminalFailuresRequiringAction > 0
                ? "operator-inbox-summary-status-attention"
                : ""
            }`}
          >
            {summary.terminalFailuresRequiringAction > 0 ? (
              <ShieldAlert size={16} aria-hidden="true" />
            ) : (
              <CheckCircle2 size={16} aria-hidden="true" />
            )}
            {summary.lastSyncedAt
              ? `Registry synced ${formatCentralDateTime(summary.lastSyncedAt)}`
              : "Awaiting first sync"}
          </span>
        ) : (
          <span className="operator-inbox-summary-status operator-inbox-summary-status-attention">
            <AlertTriangle size={16} aria-hidden="true" />
            Registry unavailable
          </span>
        )}
      </div>

      {result.loadErrors.length > 0 && (
        <div className="operator-history-load-warning" role="status">
          <AlertTriangle size={17} aria-hidden="true" />
          {result.loadErrors.join(" ")}
        </div>
      )}

      <div className="admin-metric-grid admin-metric-grid-primary">
        <MetricCard
          attention={
            !result.registryAvailable ||
            !completionAssessmentReported ||
            summary.automatedWorkClear !== true
          }
          detail={
            result.registryAvailable
              ? automatedWorkDetail(
                  summary.automatedWorkClear,
                  completionReportedAt,
                  completionAssessmentReported,
                )
              : "Current automated completion state is unavailable; the Action Inbox uses its raw fallback queues."
          }
          icon={Bot}
          label="Last catch-up completion assessment"
          value={
            !result.registryAvailable
              ? "Unavailable"
              : !completionAssessmentReported
                ? "Not reported"
                : summary.automatedWorkClear === true
                  ? "Automated work clear"
                  : summary.automatedWorkClear === false
                    ? "Automated work remaining"
                : "Not reported"
          }
        />
        <MetricCard
          attention={!result.registryAvailable || summary.quarantinedWorkRemaining > 0}
          detail={
            result.registryAvailable
              ? "Cases needing a person stay visible here until they are resolved."
              : "Current quarantine cases cannot be counted authoritatively; use the Action Inbox fallback."
          }
          icon={Archive}
          label="Quarantined work remaining"
          value={
            result.registryAvailable
              ? formatNumber(summary.quarantinedWorkRemaining)
              : "Unavailable"
          }
        />
        <MetricCard
          attention={!historicalImported}
          detail={
            !result.registryAvailable
              ? "Historical inventory state is unavailable; no imported or missing status is inferred."
              : historicalImported
              ? "Older screenshots that cannot be localized exactly are retained and labeled honestly."
              : "Import the retained historical inventory before treating this number as complete."
          }
          icon={History}
          label="Historical limitations"
          value={
            !result.registryAvailable
              ? "Unavailable"
              : historicalImported && summary.historicalLimitations !== null
              ? formatNumber(summary.historicalLimitations)
              : "Not imported"
          }
        />
        <MetricCard
          attention={
            !result.registryAvailable ||
            summary.terminalFailuresRequiringAction > 0
          }
          detail={
            result.registryAvailable
              ? "These failures exhausted safe automation and require an operator decision."
              : "Terminal failures cannot be counted authoritatively until the registry is fresh."
          }
          icon={ShieldAlert}
          label="Terminal failures requiring action"
          value={
            result.registryAvailable
              ? formatNumber(summary.terminalFailuresRequiringAction)
              : "Unavailable"
          }
        />
      </div>

      {result.registryAvailable && (
        <div className="operator-inbox-list" aria-label="Quarantine groups">
          <QuarantineGroup
            detail="Each unresolved award or source-baseline repair is one case. Page-audit, reconciliation, and authoritative R2 recovery evidence stay linked until the exact repair is verified."
            icon={Archive}
            label="Public-page and baseline repair"
            summary={summary.byCategory.public_page}
          />
          <QuarantineGroup
            detail="Only terminal visual-review failures appear here. Retryable failures remain automated work."
            icon={CameraOff}
            label="Visual review"
            summary={summary.byCategory.visual_review}
          />
          <QuarantineGroup
            detail="A first-observed official document is held here when its sealed review, exact wording, or retained PDF cannot be bound safely. Local evidence repair is tried before any new paid page review."
            icon={FileSearch}
            label="New document evidence"
            summary={summary.byCategory.initial_document}
          />
          <QuarantineGroup
            detail={
              historicalImported
                ? "Retained screenshots without trustworthy exact-location data remain visible without pretending a fuzzy crop is exact."
                : "The historical inventory has not been imported, so AwardPing does not report a false zero."
            }
            historicalUnavailable={!historicalImported}
            icon={History}
            label="Historical screenshot limits"
            summary={summary.byCategory.historical_localization}
          />
        </div>
      )}

      <AdminManualQuarantineBacklogBoard
        currentUserEmail={currentUserEmail}
        currentUserId={currentUserId}
        query={query}
        result={backlogResult}
        savedViews={savedViewsResult}
      />
    </section>
  );
}

function MetricCard({
  attention = false,
  detail,
  icon: Icon,
  label,
  value,
}: {
  attention?: boolean;
  detail: string;
  icon: typeof Bot;
  label: string;
  value: string;
}) {
  return (
    <article
      className={`admin-metric-card ${attention ? "admin-metric-card-attention" : ""}`}
    >
      <div className="admin-metric-head">
        <span className="admin-metric-label">{label}</span>
        <Icon size={17} aria-hidden="true" />
      </div>
      <strong className="admin-metric-value">{value}</strong>
      <p className="admin-metric-detail">{detail}</p>
    </article>
  );
}

function QuarantineGroup({
  detail,
  historicalUnavailable = false,
  icon: Icon,
  label,
  summary,
}: {
  detail: string;
  historicalUnavailable?: boolean;
  icon: typeof Archive;
  label: string;
  summary: AdminManualQuarantineCategorySummary;
}) {
  return (
    <article className="card operator-inbox-item operator-inbox-item-low">
      <header className="operator-inbox-item-header">
        <div className="operator-inbox-title-block">
          <h3>{label}</h3>
          <p>{detail}</p>
        </div>
        <span className="operator-state-pill operator-state-pill-needs_operator">
          <Icon size={14} aria-hidden="true" />
          {historicalUnavailable
            ? "Inventory not imported"
            : `${formatNumber(summary.cases)} ${summary.cases === 1 ? "case" : "cases"}`}
        </span>
      </header>
      <dl className="operator-inbox-facts">
        <QuarantineFact
          label="Cases"
          value={
            historicalUnavailable ? "Not imported" : formatNumber(summary.cases)
          }
        />
        <QuarantineFact
          label="Linked evidence"
          value={
            historicalUnavailable
              ? "Not imported"
              : formatNumber(summary.evidenceRecords)
          }
        />
        <QuarantineFact
          label="Terminal failures"
          value={formatNumber(summary.terminalFailures)}
        />
        <QuarantineFact
          label="Public impact unknown"
          value={formatNumber(summary.unknownPublicImpactCases)}
        />
      </dl>
    </article>
  );
}

function QuarantineFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="operator-inbox-fact">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function quarantineStatusCopy(
  result: AdminManualQuarantineLoadResult,
  completionAssessmentReported: boolean,
) {
  if (!result.registryAvailable) {
    return "This deployment cannot load the durable quarantine registry yet. No missing registry data is being reported as zero.";
  }
  const { summary } = result;
  if (completionAssessmentReported && summary.automatedWorkClear === true) {
    return `The last catch-up completion assessment reported automated work clear. The registry currently holds ${formatNumber(summary.quarantinedWorkRemaining)} quarantined review ${summary.quarantinedWorkRemaining === 1 ? "case" : "cases"}.`;
  }
  if (completionAssessmentReported && summary.automatedWorkClear === false) {
    return `The last catch-up completion assessment reported automated work remaining. The registry currently holds ${formatNumber(summary.quarantinedWorkRemaining)} quarantined review ${summary.quarantinedWorkRemaining === 1 ? "case" : "cases"}.`;
  }
  return `No catch-up completion assessment has been reported. The registry currently holds ${formatNumber(summary.quarantinedWorkRemaining)} quarantined review ${summary.quarantinedWorkRemaining === 1 ? "case" : "cases"}.`;
}

function automatedWorkDetail(
  value: boolean | null,
  completionReportedAt: string,
  completionAssessmentReported: boolean,
) {
  if (!completionAssessmentReported) {
    return "The catch-up worker has not recorded an authoritative completion report and timestamp yet.";
  }
  if (value === true) {
    return `Reported ${completionReportedAt}. No retryable catch-up work was waiting at that assessment.`;
  }
  if (value === false) {
    return `Reported ${completionReportedAt}. Retryable catch-up work remained outside manual quarantine at that assessment.`;
  }
  return "The catch-up worker has not recorded an authoritative completion report and timestamp yet.";
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}
