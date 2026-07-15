"use client";

import { useEffect, useRef, useState } from "react";
import { Activity, AlertTriangle, CheckCircle2, Clock3 } from "lucide-react";
import type {
  AdminRunReportFeed,
  RunReportDigest,
  VisualNightlyReport,
  VisualNightlyStatus,
} from "@/lib/admin-run-report";
import { formatCentralDateTime } from "@/lib/time-zone";

type MaintenanceStatusResponse = {
  ok?: boolean;
  runFeed?: AdminRunReportFeed | null;
  runFeedWarning?: string | null;
  error?: string;
};

export function AdminRunReport({
  compact = false,
  initialFeed,
}: {
  compact?: boolean;
  initialFeed: AdminRunReportFeed;
}) {
  const [feed, setFeed] = useState(initialFeed);
  const [refreshWarning, setRefreshWarning] = useState("");
  const feedRef = useRef(initialFeed);

  useEffect(() => {
    if (compact) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;

    const schedule = (delay: number) => {
      if (disposed) return;
      timer = setTimeout(refresh, delay);
    };

    const refresh = async () => {
      if (disposed) return;
      if (document.visibilityState === "hidden") {
        schedule(30_000);
        return;
      }

      controller?.abort();
      controller = new AbortController();
      try {
        const response = await fetch("/api/admin/maintenance-runs", {
          cache: "no-store",
          credentials: "same-origin",
          signal: controller.signal,
        });
        const payload = (await response.json()) as MaintenanceStatusResponse;
        if (!response.ok || !payload.ok || !payload.runFeed) {
          throw new Error(payload.error || "Live worker status is unavailable.");
        }
        if (disposed) return;
        feedRef.current = payload.runFeed;
        setFeed(payload.runFeed);
        setRefreshWarning(payload.runFeedWarning || "");
      } catch (error) {
        if (disposed || (error instanceof DOMException && error.name === "AbortError")) return;
        setRefreshWarning("Live refresh paused; showing the last available report.");
      }
      schedule(feedRef.current.current?.isRunning ? 10_000 : 60_000);
    };

    void refresh();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      controller?.abort();
    };
  }, [compact]);

  const primary = feed.current || feed.overnight;
  const badgeLabel = feed.current ? "Live" : feed.visualNightly ? "6 PM scan" : "Last overnight";

  if (compact) {
    return <CompactSixPmReport feed={feed} refreshWarning={refreshWarning} />;
  }

  return (
    <section className="card admin-section-card admin-run-report">
      <div className="admin-panel-heading">
        <div className="flex items-center gap-2">
          {feed.current ? <Activity size={18} aria-hidden="true" /> : <Clock3 size={18} aria-hidden="true" />}
          <h2>Run Report</h2>
        </div>
        <span className={feed.current ? "badge admin-run-report-live-badge" : "badge"}>
          {feed.current && <span className="admin-run-report-live-dot" aria-hidden="true" />}
          {badgeLabel}
        </span>
      </div>

      {primary ? (
        <>
          <div className="admin-run-report-copy" aria-live="polite" aria-atomic="true">
            <div>
              <h3>{primary.title}</h3>
              <p>{primary.summary}</p>
            </div>
            <RunTime digest={primary} />
          </div>

          {primary.items.length > 0 && (
            <div className="admin-run-report-ticker" aria-label="Worker accomplishments">
              {primary.items.map((reportItem) => (
                <div className={`admin-run-report-item admin-run-report-item-${reportItem.tone}`} key={reportItem.key}>
                  <strong>{formatNumber(reportItem.value)}</strong>
                  <span>{reportItem.label}</span>
                  <small>{reportItem.detail}</small>
                </div>
              ))}
            </div>
          )}

          {feed.current && feed.overnight && !feed.overnight.isRunning && (
            <div className="admin-run-report-previous">
              {["failed", "degraded"].includes(feed.overnight.status) ? (
                <AlertTriangle size={16} aria-hidden="true" />
              ) : (
                <CheckCircle2 size={16} aria-hidden="true" />
              )}
              <div>
                <strong>Previous overnight</strong>
                <p>{feed.overnight.summary}</p>
              </div>
            </div>
          )}

          {feed.visualNightly && <VisualNightlyDetails report={feed.visualNightly} />}
        </>
      ) : (
        <p className="text-sm font-semibold leading-6 text-[var(--muted)]">
          No worker report has been recorded yet.
        </p>
      )}

      <div className="admin-run-report-footer">
        <span>Updated {formatTime(feed.generatedAt)}</span>
        {refreshWarning && <span className="admin-run-report-warning">{refreshWarning}</span>}
      </div>
    </section>
  );
}

function CompactSixPmReport({
  feed,
  refreshWarning,
}: {
  feed: AdminRunReportFeed;
  refreshWarning: string;
}) {
  const report = feed.visualNightly;
  return (
    <section className="card operator-scan-report" aria-labelledby="operator-scan-report-title">
      <div className="operator-scan-report-heading">
        <div>
          <p>Permanent daily workflow</p>
          <h2 id="operator-scan-report-title">6 PM scan report</h2>
        </div>
        <span className={`badge ${report ? `admin-visual-nightly-badge-${report.status}` : ""}`}>
          {report ? nightlyStatusLabel(report.status) : "Not recorded"}
        </span>
      </div>
      <div aria-atomic="true" aria-live="polite">
        {report ? (
          <>
            <p className="operator-scan-report-summary">{report.summary}</p>
            <p className="operator-scan-report-evidence">
              {report.completedShards}/{report.expectedShards} shards completed · {formatNumber(report.checked)} pages captured · {formatNumber(report.failed)} failed
            </p>
            {report.failureGroups.length > 0 ? (
              <p className="operator-scan-report-note operator-scan-report-note-attention">
                Failure details and safe repairs are consolidated in the Action Inbox below.
              </p>
            ) : (
              <p className="operator-scan-report-note">
                No 6 PM failure group needs an operator decision.
              </p>
            )}
          </>
        ) : (
          <p className="operator-scan-report-summary">
            No scheduled 6 PM shard report has been recorded yet.
          </p>
        )}
      </div>
      <div className="admin-run-report-footer">
        <span>Updated {formatTime(feed.generatedAt)}</span>
        {refreshWarning && <span className="admin-run-report-warning">{refreshWarning}</span>}
      </div>
    </section>
  );
}

function VisualNightlyDetails({ report }: { report: VisualNightlyReport }) {
  return (
    <div className="admin-visual-nightly">
      <div className="admin-visual-nightly-heading">
        <div>
          <strong>6 PM capture report · {formatMonitoringDate(report.monitoringDate)}</strong>
          <p>{report.summary}</p>
        </div>
        <span className={`badge admin-visual-nightly-badge admin-visual-nightly-badge-${report.status}`}>
          {nightlyStatusLabel(report.status)}
        </span>
      </div>

      <div className="admin-visual-nightly-summary" aria-label="6 PM capture totals">
        <span><strong>{report.completedShards}/{report.expectedShards}</strong> shards complete</span>
        <span><strong>{formatNumber(report.loaded)}</strong> sources loaded</span>
        <span><strong>{formatNumber(report.checked)}</strong> pages captured</span>
        <span><strong>{formatNumber(report.failed)}</strong> source failures</span>
        <span><strong>{formatPercent(report.failureRatePercent)}</strong> failures / loaded</span>
      </div>

      <div className="admin-visual-nightly-shards" aria-label="6 PM capture shards">
        {Array.from({ length: report.expectedShards }, (_, index) => {
          const shardNumber = index + 1;
          const shard = report.shards.find((candidate) => candidate.shardNumber === shardNumber);
          return (
            <div className={`admin-visual-nightly-shard ${shard ? `admin-visual-nightly-shard-${shard.status}` : "admin-visual-nightly-shard-missing"}`} key={shardNumber}>
              <div>
                <strong>Shard {shardNumber}</strong>
                <span>{shard ? shard.stalled ? "Stalled" : nightlyStatusLabel(shard.status) : "Missing"}</span>
              </div>
              <small>
                {shard
                  ? `${formatNumber(shard.checked)} captured · ${formatNumber(shard.failed)} failed`
                  : "No run reported for this shard"}
              </small>
            </div>
          );
        })}
      </div>

      {report.failureGroups.length > 0 && (
        <div className="admin-visual-nightly-actions">
          <strong>Failures and safe repairs</strong>
          <div>
            {report.failureGroups.map((group) => (
              <article key={group.code}>
                <div>
                  <strong>{formatNumber(group.count)} × {group.label}</strong>
                  <span>{retryModeLabel(group.retryMode)}</span>
                </div>
                <p>{group.solution}</p>
              </article>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function RunTime({ digest }: { digest: RunReportDigest }) {
  if (digest.isRunning) {
    return (
      <span className="admin-run-report-time">
        <Clock3 size={14} aria-hidden="true" />
        Started {formatTime(digest.startedAt)}
      </span>
    );
  }

  return (
    <span className="admin-run-report-time">
      {["failed", "degraded"].includes(digest.status) ? (
        <AlertTriangle size={14} aria-hidden="true" />
      ) : (
        <CheckCircle2 size={14} aria-hidden="true" />
      )}
      {digest.finishedAt ? `Finished ${formatCentralDateTime(digest.finishedAt)}` : "Finished"}
    </span>
  );
}

function nightlyStatusLabel(status: VisualNightlyStatus | "healthy" | "degraded" | "failed" | "running") {
  const labels: Record<string, string> = {
    scheduled: "Scheduled",
    running: "Running",
    healthy: "Healthy",
    degraded: "Needs attention",
    failed: "Failed",
    incomplete: "Incomplete",
    missed: "Missed",
  };
  return labels[status] || status;
}

function retryModeLabel(value: string) {
  const labels: Record<string, string> = {
    automatic_next_scan: "Automatic next-scan retry",
    automatic_then_manual: "Retry once, then inspect",
    operator_guarded: "Operator verification required",
    manual_source_review: "Manual source review",
    resume_idempotently: "Resume the failed handoff only",
    retry_failed_stage: "Retry the failed stage only",
    repair_then_restart_shard: "Repair dependency, then restart shard",
    targeted_evidence_repair: "Targeted evidence repair",
    manual_investigation: "Manual investigation",
  };
  return labels[value] || value.replaceAll("_", " ");
}

function formatMonitoringDate(value: string) {
  const parsed = new Date(`${value}T12:00:00-05:00`);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "America/Chicago",
  }).format(parsed);
}

function formatPercent(value: number) {
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value)}%`;
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatTime(value: string | null) {
  if (!value) return "recently";
  return formatCentralDateTime(value, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}
