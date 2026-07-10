"use client";

import { useEffect, useRef, useState } from "react";
import { Activity, AlertTriangle, CheckCircle2, Clock3 } from "lucide-react";
import type { AdminRunReportFeed, RunReportDigest } from "@/lib/admin-run-report";
import { formatCentralDateTime } from "@/lib/time-zone";

type MaintenanceStatusResponse = {
  ok?: boolean;
  runFeed?: AdminRunReportFeed | null;
  runFeedWarning?: string | null;
  error?: string;
};

export function AdminRunReport({ initialFeed }: { initialFeed: AdminRunReportFeed }) {
  const [feed, setFeed] = useState(initialFeed);
  const [refreshWarning, setRefreshWarning] = useState("");
  const feedRef = useRef(initialFeed);

  useEffect(() => {
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
  }, []);

  const primary = feed.current || feed.overnight;
  const badgeLabel = feed.current ? "Live" : "Last overnight";

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

          {feed.current && feed.overnight && (
            <div className="admin-run-report-previous">
              {feed.overnight.status === "failed" ? (
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
      {digest.status === "failed" ? (
        <AlertTriangle size={14} aria-hidden="true" />
      ) : (
        <CheckCircle2 size={14} aria-hidden="true" />
      )}
      {digest.finishedAt ? `Finished ${formatCentralDateTime(digest.finishedAt)}` : "Finished"}
    </span>
  );
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
