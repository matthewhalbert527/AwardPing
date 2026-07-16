import { AlertTriangle, CheckCircle2, Clock3, CloudDownload, RefreshCw, WalletCards } from "lucide-react";
import type {
  AdminDownstreamLane,
  AdminWorkerOperations,
} from "@/lib/admin-worker-operations";
import { downstreamLaneRuntimeState } from "@/lib/admin-worker-operations";
import { formatCentralDateTime } from "@/lib/time-zone";

type Props = {
  result: AdminWorkerOperations;
  view: "recovery" | "operations";
  now: string;
};

export function AdminWorkerOperationsBoard({ result, view, now }: Props) {
  return view === "recovery"
    ? <AdminEvidenceRecoveryBoard result={result} />
    : <AdminLanesAndSpendingBoard result={result} now={now} />;
}

function AdminEvidenceRecoveryBoard({ result }: { result: AdminWorkerOperations }) {
  const recovery = result.evidenceRecovery;
  const attention = recovery.enabled !== true || recovery.failed > 0 || recovery.refused > 0;
  const statusLabel = recovery.enabled === false
    ? "Recovery disabled"
    : recovery.enabled !== true
      ? "Recovery not verified"
      : attention
        ? "Recovery needs attention"
        : "Fail-closed recovery ready";
  return (
    <section className="operator-inbox" aria-labelledby="evidence-recovery-title">
      <div className="card operator-inbox-summary">
        <div>
          <p className="operator-inbox-kicker">R2 is the recoverable source of truth</p>
          <h2 id="evidence-recovery-title">6. Evidence recovery</h2>
          <p>
            If a PC loses a baseline file, the worker now downloads the exact immutable R2 generation, verifies its
            source, timestamp, hashes, and required files, then restores the cache atomically. A mismatch is refused;
            the last-known-good baseline is never replaced.
          </p>
        </div>
        <span className={`operator-inbox-summary-status ${attention ? "operator-inbox-summary-status-attention" : ""}`}>
          {attention ? <AlertTriangle size={16} aria-hidden="true" /> : <CheckCircle2 size={16} aria-hidden="true" />}
          {statusLabel}
        </span>
      </div>
      {result.recoveryLoadErrors.length > 0 && (
        <div className="operator-history-load-warning" role="alert">
          <AlertTriangle size={17} aria-hidden="true" />
          Recovery readiness could not be loaded completely. {result.recoveryLoadErrors.join(" ")}
        </div>
      )}
      <div className={attention ? "operator-history-load-warning" : "card flex gap-3 p-5"} role="status">
        {attention ? <AlertTriangle size={17} aria-hidden="true" /> : <CheckCircle2 size={17} aria-hidden="true" />}
        <div>
          <p className="font-black">{recovery.statusReason}</p>
          <p className="mt-1 text-sm font-semibold">Safe action: {recovery.safeAction}</p>
          {recovery.reasons.length > 0 && (
            <p className="mt-1 text-sm font-semibold">Reported reasons: {formatRecoveryReasons(recovery.reasons)}</p>
          )}
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <RecoveryMetric
          label="Scheduled shards reporting"
          value={`${recovery.reportingShards} / ${recovery.expectedShards}`}
        />
        <RecoveryMetric label="Recovery attempts" value={recovery.attempts} />
        <RecoveryMetric label="Baseline caches restored" value={recovery.recovered} />
        <RecoveryMetric label="Exact geometry restored" value={recovery.exactGeometryRecovered} />
        <RecoveryMetric label="Evidence-only restores" value={recovery.evidenceOnlyRecovered} />
        <RecoveryMetric label="Unsafe restores refused" value={recovery.refused} />
        <RecoveryMetric label="Recovery failures" value={recovery.failed} />
        <div className="card p-5">
          <p className="text-xs font-black uppercase tracking-[0.12em] text-[var(--muted)]">Last worker report</p>
          <p className="mt-2 text-sm font-bold">
            {recovery.lastReportedAt ? formatCentralDateTime(recovery.lastReportedAt) : "Awaiting first report"}
          </p>
          <p className="mt-2 text-xs font-semibold text-[var(--muted)]">{recovery.configurationSource}</p>
        </div>
      </div>
    </section>
  );
}

function AdminLanesAndSpendingBoard({ result, now }: { result: AdminWorkerOperations; now: string }) {
  return (
    <section className="operator-inbox" aria-labelledby="lanes-spending-title">
      <div className="card operator-inbox-summary">
        <div>
          <p className="operator-inbox-kicker">Independent work, one atomic account budget</p>
          <h2 id="lanes-spending-title">7. Lanes &amp; spending</h2>
          <p>
            New-page review and changed-page review are the only paid lanes, capped independently at $5 per UTC day.
            Every other lane is $0 and has its own lease, timeout, retry clock, and oldest-item target.
          </p>
        </div>
        <span className="operator-inbox-summary-status">
          <WalletCards size={16} aria-hidden="true" /> Maximum $10/day
        </span>
      </div>

      {result.operationsLoadErrors.length > 0 && (
        <div className="operator-history-load-warning" role="status">
          <AlertTriangle size={17} aria-hidden="true" /> {result.operationsLoadErrors.join(" ")}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {result.budgets.map((budget) => {
          const used = budget.spentUsd + budget.reservedUsd;
          const percent = budget.capUsd > 0 ? Math.min(100, (used / budget.capUsd) * 100) : 0;
          return (
            <article className="card p-5" key={budget.laneKey}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-xs font-black uppercase tracking-[0.12em] text-[var(--muted)]">Paid pipeline</p>
                  <h3 className="mt-1 text-lg font-black">{budget.label}</h3>
                </div>
                <span className="badge">${formatMoney(budget.capUsd)}/day</span>
              </div>
              <p className="mt-4 text-2xl font-black">${formatMoney(budget.remainingUsd)} remaining</p>
              <div className="mt-3 h-2 overflow-hidden rounded-full bg-[var(--surface-strong)]" aria-hidden="true">
                <div className="h-full rounded-full bg-[var(--accent)]" style={{ width: `${percent}%` }} />
              </div>
              <div className="mt-4 grid grid-cols-3 gap-3 text-sm">
                <MoneyCell label="Spent" value={budget.spentUsd} />
                <MoneyCell label="Reserved" value={budget.reservedUsd} />
                <MoneyCell label="Effective cap" value={budget.capUsd} />
              </div>
              <p className="mt-4 flex items-center gap-2 text-xs font-semibold text-[var(--muted)]">
                <Clock3 size={14} aria-hidden="true" /> Resets {budget.resetAt ? formatCentralDateTime(budget.resetAt) : "at next UTC midnight"}
              </p>
              <p className="mt-1 text-xs font-semibold text-[var(--muted)]">Source: {budget.configurationSource}</p>
            </article>
          );
        })}
      </div>

      <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {result.lanes.map((lane) => <LaneCard key={lane.laneKey} lane={lane} now={now} />)}
      </div>
    </section>
  );
}

function LaneCard({ lane, now }: { lane: AdminDownstreamLane; now: string }) {
  const currentTime = Date.parse(now);
  const oldestTime = lane.oldestItemAt ? Date.parse(lane.oldestItemAt) : Number.NaN;
  const oldestAgeSeconds = Number.isFinite(currentTime) && Number.isFinite(oldestTime)
    ? Math.max(0, Math.floor((currentTime - oldestTime) / 1_000))
    : 0;
  const runtime = downstreamLaneRuntimeState(lane, now);
  const attention = runtime.disabled || runtime.expiredLease || runtime.overdueUnclaimed || Boolean(lane.lastError);
  const statusLabel = runtime.disabled
    ? "Disabled"
    : runtime.expiredLease
      ? "Lease expired"
      : runtime.overdueUnclaimed
        ? runtime.overdue
          ? "SLA breached; unclaimed"
          : "Retry due; unclaimed"
        : lane.leaseOwner
          ? "Leased"
          : runtime.retryWaiting
            ? "Retry scheduled"
            : lane.claimable
              ? "Ready"
              : lane.lastStatus || "Awaiting first run";
  return (
    <article className="card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-black capitalize">{lane.label}</h3>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span className="badge">{lane.paid ? "$5/day" : "$0"}</span>
          <span className={attention ? "admin-severity-pill admin-severity-pill-high" : "badge"}>
            {statusLabel}
          </span>
        </div>
      </div>
      <p className="mt-3 text-sm font-bold">{lane.queueDepth} waiting</p>
      <p className={`mt-1 text-xs font-semibold ${runtime.overdue ? "text-[var(--danger)]" : "text-[var(--muted)]"}`}>
        {lane.oldestItemAt ? `Oldest ${formatDuration(oldestAgeSeconds)} · target ${formatDuration(lane.oldestItemSlaSeconds)}` : "No waiting item"}
      </p>
      <div className="mt-3 space-y-1 text-xs font-semibold text-[var(--muted)]">
        <p>Timeout {formatDuration(lane.timeoutSeconds)}</p>
        <p>Lease TTL {formatDuration(lane.leaseTtlSeconds)}</p>
        <p className={runtime.overdue ? "text-[var(--danger)]" : undefined}>
          {lane.nextSlaDueAt
            ? `${runtime.overdue ? "SLA breached" : "Next SLA due"} ${formatCentralDateTime(lane.nextSlaDueAt)}`
            : "SLA deadline not reported"}
        </p>
        <p>Lease owner {lane.leaseOwner || "None"}</p>
        <p className={runtime.disabled || runtime.expiredLease ? "text-[var(--danger)]" : undefined}>
          {runtime.disabled
            ? "Lane disabled; no worker can claim it"
            : runtime.expiredLease
              ? `Lease expired ${lane.leaseExpiresAt ? formatCentralDateTime(lane.leaseExpiresAt) : "without a recorded time"}`
              : lane.leaseOwner
                ? `Lease active${lane.leaseExpiresAt ? ` until ${formatCentralDateTime(lane.leaseExpiresAt)}` : ""}`
                : "Lease available; no owner"}
        </p>
        <p className={runtime.retryDue ? "text-[var(--danger)]" : undefined}>
          {lane.nextRetryAt
            ? `${runtime.retryDue ? "Retry was due" : "Retry scheduled"} ${formatCentralDateTime(lane.nextRetryAt)}`
            : "No retry delay"}
        </p>
        <p>{lane.lastFinishedAt ? `Last finished ${formatCentralDateTime(lane.lastFinishedAt)}` : "No completed run recorded"}</p>
        <p>{lane.lastSucceededAt ? `Last success ${formatCentralDateTime(lane.lastSucceededAt)}` : "No successful run recorded"}</p>
        {lane.lastFailedAt && <p>Last failure {formatCentralDateTime(lane.lastFailedAt)}</p>}
      </div>
      {lane.lastError ? (
        <p className="mt-3 line-clamp-3 text-xs font-semibold text-[var(--danger)]">{lane.lastError}</p>
      ) : (
        <p className="mt-3 flex items-center gap-1 text-xs font-semibold text-[var(--muted)]">
          <RefreshCw size={13} aria-hidden="true" /> {lane.lastStatus || "Awaiting first run"}
        </p>
      )}
    </article>
  );
}

function RecoveryMetric({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="card p-5">
      <CloudDownload size={18} aria-hidden="true" />
      <p className="mt-3 text-3xl font-black">{typeof value === "number" ? value.toLocaleString() : value}</p>
      <p className="mt-1 text-sm font-bold text-[var(--muted)]">{label}</p>
    </div>
  );
}

function formatRecoveryReasons(reasons: Array<{ code: string; count: number }>) {
  return reasons
    .slice(0, 5)
    .map((reason) => `${reason.code.replaceAll("_", " ")} (${reason.count})`)
    .join(", ");
}

function MoneyCell({ label, value }: { label: string; value: number }) {
  return <div><p className="font-black">${formatMoney(value)}</p><p className="text-xs font-semibold text-[var(--muted)]">{label}</p></div>;
}

function formatMoney(value: number) {
  return value.toFixed(2);
}

function formatDuration(seconds: number) {
  if (!seconds) return "not reported";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3_600)}h`;
}
