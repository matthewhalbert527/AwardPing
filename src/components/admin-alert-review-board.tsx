"use client";

import { useEffect, useRef, useState } from "react";
import { formatCentralDateTime } from "@/lib/time-zone";

export type AlertReviewStatus = "pending" | "approved" | "dismissed";
export type AlertReview = {
  id: string;
  contentHash: string;
  awardName: string;
  summary: string;
  sourceUrl: string;
  detectedAt: string;
  status: AlertReviewStatus;
  details: Array<{ category: string; summary: string; previous?: string; current?: string }>;
};

type Props = { initialAlerts?: AlertReview[]; initialStatus?: AlertReviewStatus };
const API = "/api/admin/alert-reviews";
const views: Array<{ status: AlertReviewStatus; label: string }> = [
  { status: "pending", label: "Needs review" },
  { status: "approved", label: "Approved" },
  { status: "dismissed", label: "Dismissed" },
];
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const boundedText = (value: unknown, max: number): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= max;
function sourceLink(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
function isAlert(value: unknown, status: AlertReviewStatus): value is AlertReview {
  return object(value) && typeof value.id === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.id) &&
    typeof value.contentHash === "string" && /^[a-f0-9]{64}$/.test(value.contentHash) && value.status === status &&
    boundedText(value.awardName, 500) && boundedText(value.summary, 8000) && Boolean(sourceLink(value.sourceUrl)) &&
    typeof value.detectedAt === "string" && Number.isFinite(Date.parse(value.detectedAt)) && Array.isArray(value.details) &&
    value.details.length <= 64 && value.details.every(detail => object(detail) && boundedText(detail.category, 100) &&
      boundedText(detail.summary, 8000) && (detail.previous === undefined || boundedText(detail.previous, 16000)) &&
      (detail.current === undefined || boundedText(detail.current, 16000)));
}
async function request(body?: unknown): Promise<unknown> {
  const response = await fetch(API, {
    method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok || !object(value) || value.ok !== true) {
    throw new Error(object(value) && typeof value.error === "string" ? value.error : "The decision was not confirmed. Refresh before trying again.");
  }
  return value;
}

export function AdminAlertReviewBoard({ initialAlerts, initialStatus = "pending" }: Props) {
  const [status, setStatus] = useState<AlertReviewStatus>(initialStatus);
  const [alerts, setAlerts] = useState<AlertReview[]>(initialAlerts || []);
  const [loaded, setLoaded] = useState(initialAlerts !== undefined);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [decisionsBlocked, setDecisionsBlocked] = useState(false);
  const inFlight = useRef(false);
  const initialLoadStarted = useRef(false);
  const requireRefresh = useRef(false);

  async function load(next: AlertReviewStatus) {
    const response = await fetch(`${API}?status=${next}`, { cache: "no-store", credentials: "same-origin" });
    const value: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new Error(object(value) && typeof value.error === "string" ? value.error : "Alerts could not be loaded. Refresh to try again.");
    if (!object(value) || !Array.isArray(value.alerts) || value.alerts.length > 100 ||
        value.alerts.some(alert => !isAlert(alert, next)) || new Set(value.alerts.map(alert => alert.id)).size !== value.alerts.length) {
      throw new Error("The alert list could not be confirmed. Refresh to try again.");
    }
    setAlerts(value.alerts as AlertReview[]); setLoaded(true); requireRefresh.current = false; setDecisionsBlocked(false);
  }
  async function show(next: AlertReviewStatus) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(""); setNotice(""); setStatus(next); setLoaded(false); setAlerts([]);
    try { await load(next); } catch (caught) { setError(caught instanceof Error ? caught.message : "Alerts could not be loaded."); }
    finally { inFlight.current = false; setBusy(false); }
  }
  async function decide(alert: AlertReview, action: "approve" | "dismiss") {
    if (inFlight.current || requireRefresh.current || status !== "pending" || alert.status !== "pending" ||
        !alerts.some(current => current.id === alert.id && current.contentHash === alert.contentHash)) return;
    inFlight.current = true; setBusy(true); setError(""); setNotice("");
    try {
      await request({ id: alert.id, expected_hash: alert.contentHash, action });
      setNotice(action === "approve" ? "Alert approved." : "Alert dismissed.");
      setLoaded(false); setAlerts([]);
      try { await load(status); }
      catch { setError("Your decision was saved, but the list could not refresh. Refresh the list before reviewing another alert."); }
    } catch (caught) {
      requireRefresh.current = true; setDecisionsBlocked(true);
      setError(caught instanceof Error ? caught.message : "The decision was not confirmed. Refresh before trying again.");
    }
    finally { inFlight.current = false; setBusy(false); }
  }

  useEffect(() => {
    if (initialAlerts === undefined && !initialLoadStarted.current) {
      initialLoadStarted.current = true;
      void show(initialStatus);
    }
  });

  return <section className="space-y-5" aria-label="Alert review" aria-busy={busy}>
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div><h1 className="admin-page-title">Review alerts</h1><p className="mt-2 text-[var(--muted)]">Review proposed award changes before subscribers are notified.</p></div>
      <button type="button" className="button-secondary text-sm" disabled={busy} onClick={() => show(status)}>Refresh</button>
    </header>
    <nav aria-label="Alert review views" className="flex flex-wrap gap-2">{views.map(view => <button key={view.status} type="button"
      className={status === view.status ? "button-primary text-sm" : "button-secondary text-sm"} aria-pressed={status === view.status}
      disabled={busy} onClick={() => show(view.status)}>{view.label}</button>)}</nav>
    <div aria-live="polite" role="status" className="text-sm">{busy ? "Updating alerts…" : notice}</div>
    {error ? <p role="alert" className="rounded-md border p-3 text-sm">{error}</p> : null}
    {loaded && alerts.length === 0 ? <p className="card p-5 text-[var(--muted)]">{status === "pending" ? "No alerts waiting for review." : status === "approved" ? "No approved alerts yet." : "No dismissed alerts yet."}</p> : null}
    {loaded ? <ul className="space-y-4">{alerts.map(alert => <li key={alert.id}><article className="card space-y-4 p-5" aria-label={`${alert.awardName} alert`}>
      <div className="flex flex-wrap justify-between gap-2"><h2 className="text-lg font-bold">{alert.awardName}</h2><time className="text-sm text-[var(--muted)]" dateTime={alert.detectedAt}>{formatCentralDateTime(alert.detectedAt)}</time></div>
      <p className="leading-relaxed">{alert.summary}</p>
      <a className="text-sm font-semibold underline" href={sourceLink(alert.sourceUrl)!} target="_blank" rel="noopener noreferrer">View official page</a>
      {alert.details.length ? <details className="rounded-md border p-3"><summary className="cursor-pointer text-sm font-semibold">Review supporting details</summary>
        <ul className="mt-3 space-y-4">{alert.details.map((detail, index) => <li key={index} className="space-y-2 text-sm"><p className="font-semibold">{detail.category}</p><p>{detail.summary}</p>
          {detail.previous ? <div><p className="font-semibold text-[var(--muted)]">Previously</p><blockquote className="border-l-2 pl-3">{detail.previous}</blockquote></div> : null}
          {detail.current ? <div><p className="font-semibold text-[var(--muted)]">Now</p><blockquote className="border-l-2 pl-3">{detail.current}</blockquote></div> : null}</li>)}</ul>
      </details> : null}
      {status === "pending" ? <div className="flex flex-wrap gap-2"><button type="button" className="button-primary text-sm" disabled={busy || decisionsBlocked} onClick={() => decide(alert, "approve")}>Approve alert</button>
        <button type="button" className="button-secondary text-sm" disabled={busy || decisionsBlocked} onClick={() => decide(alert, "dismiss")}>Dismiss</button></div> : null}
    </article></li>)}</ul> : null}
  </section>;
}
