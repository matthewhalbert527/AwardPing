"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./admin-alert-review-board.module.css";
import { formatCentralDateTime } from "@/lib/time-zone";
import { alertSourceLink as sourceLink, parseAlertReviewList, parseMergePreview, mergePreviewMatchesSelection, relatedMergeOptions,
  type AlertReview, type AlertReviewLeaf, type AlertReviewStatus, type MergeOption, type MergePreview } from "@/lib/alert-group-review";
export type { AlertReview, AlertReviewLeaf, AlertReviewStatus, MergeOption } from "@/lib/alert-group-review";

type Props = { initialAlerts?: AlertReview[]; initialStatus?: AlertReviewStatus; initialMergeOptions?: MergeOption[] };
const API = "/api/admin/alert-reviews";
const GROUP_API = "/api/admin/alert-groups";
const views: Array<{ status: AlertReviewStatus; label: string }> = [
  { status: "pending", label: "Needs review" },
  { status: "approved", label: "Approved" },
  { status: "dismissed", label: "Dismissed" },
];
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
async function request(body: unknown, api = API): Promise<unknown> {
  const response = await fetch(api, {
    method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok || !object(value) || value.ok !== true) {
    throw new Error(object(value) && typeof value.error === "string" ? value.error : "The decision was not confirmed. Refresh before trying again.");
  }
  return value;
}

function supportingDetails(details: AlertReviewLeaf["details"]) {
  return <ul className={styles.supportList}>{details.map((detail, index) => <li key={index} className={styles.supportItem}><p className={styles.detailLabel}>{detail.category}</p><p>{detail.summary}</p>
    {detail.previous ? <div><p className={styles.detailLabel}>Previously</p><blockquote className={styles.quote}>{detail.previous}</blockquote></div> : null}
    {detail.current ? <div><p className={styles.detailLabel}>Now</p><blockquote className={styles.quote}>{detail.current}</blockquote></div> : null}</li>)}</ul>;
}
function memberDetails(members: AlertReviewLeaf[], publishedIds: string[]) {
  return <ul className={styles.memberList} aria-label="Included source updates">{members.map(member => <li key={member.id} className={styles.memberCard}>
    <div className={styles.memberHeader}><span className={styles.detailLabel}>{publishedIds.includes(member.id) ? "Previously approved" : "Needs review"}</span>
      <time className={styles.timestamp} dateTime={member.detectedAt}>{formatCentralDateTime(member.detectedAt)}</time></div>
    <p>{member.summary}</p><a className={styles.sourceLink} href={sourceLink(member.sourceUrl)!} target="_blank" rel="noopener noreferrer">View official page</a>
    {member.details.length ? <details className={styles.memberDetails}><summary>Exact source wording</summary>{supportingDetails(member.details)}</details> : null}
  </li>)}</ul>;
}

export function AdminAlertReviewBoard({ initialAlerts, initialStatus = "pending", initialMergeOptions }: Props) {
  const [status, setStatus] = useState<AlertReviewStatus>(initialStatus);
  const [alerts, setAlerts] = useState<AlertReview[]>(initialAlerts || []);
  const [loaded, setLoaded] = useState(initialAlerts !== undefined);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [decisionsBlocked, setDecisionsBlocked] = useState(false);
  const [mergeOptions, setMergeOptions] = useState<MergeOption[]>(initialMergeOptions || []);
  const [mergeSourceId, setMergeSourceId] = useState<string | null>(null);
  const [mergeTargetId, setMergeTargetId] = useState("");
  const [mergePreview, setMergePreview] = useState<MergePreview | null>(null);
  const inFlight = useRef(false);
  const initialLoadStarted = useRef(false);
  const requireRefresh = useRef(false);
  const [incoming, setIncoming] = useState({ alerts: initialAlerts, options: initialMergeOptions, status: initialStatus });
  function clearMerge() { setMergeSourceId(null); setMergeTargetId(""); setMergePreview(null); }

  async function load(next: AlertReviewStatus) {
    const response = await fetch(`${API}?status=${next}`, { cache: "no-store", credentials: "same-origin" });
    const value: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new Error(object(value) && typeof value.error === "string" ? value.error : "Alerts could not be loaded. Refresh to try again.");
    const parsed = parseAlertReviewList(value, next);
    if (!parsed) throw new Error("The alert list could not be confirmed. Refresh to try again.");
    setAlerts(parsed.alerts); setMergeOptions(parsed.mergeOptions); clearMerge(); setLoaded(true); requireRefresh.current = false; setDecisionsBlocked(false);
  }
  async function show(next: AlertReviewStatus) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(""); setNotice(""); setStatus(next); setLoaded(false); setAlerts([]); clearMerge();
    try { await load(next); } catch (caught) { setError(caught instanceof Error ? caught.message : "Alerts could not be loaded."); }
    finally { inFlight.current = false; setBusy(false); }
  }
  async function decide(alert: AlertReview, action: "approve" | "dismiss" | "undo") {
    if (inFlight.current || requireRefresh.current || status !== "pending" || alert.status !== "pending" ||
        !alerts.some(current => current.id === alert.id && current.contentHash === alert.contentHash) ||
        alert.group && action === "dismiss" || !alert.group && action === "undo") return;
    inFlight.current = true; setBusy(true); setError(""); setNotice("");
    try {
      await request({ id: alert.id, expected_hash: alert.contentHash, action }, alert.group ? GROUP_API : API);
      setNotice(action === "undo" ? "Combined draft removed. The original updates are preserved." : action === "approve" ? alert.group ? "Combined update approved." : "Alert approved." : "Alert dismissed.");
      setLoaded(false); setAlerts([]); clearMerge();
      try { await load(status); }
      catch { setError("Your decision was saved, but the list could not refresh. Refresh the list before reviewing another alert."); }
    } catch (caught) {
      requireRefresh.current = true; setDecisionsBlocked(true);
      setError(caught instanceof Error ? caught.message : "The decision was not confirmed. Refresh before trying again.");
    }
    finally { inFlight.current = false; setBusy(false); }
  }

  function openMerge(alert: AlertReview) {
    if (inFlight.current || requireRefresh.current) return;
    if (mergeSourceId === alert.id) { clearMerge(); return; }
    setMergeSourceId(alert.id); setMergeTargetId(""); setMergePreview(null); setNotice(""); setError("");
  }
  async function previewMerge(source: AlertReview, targetId: string) {
    if (inFlight.current || requireRefresh.current) return;
    setMergeTargetId(targetId); setMergePreview(null); setError("");
    if (!targetId) return;
    const target = relatedMergeOptions(source, mergeOptions).find(option => option.id === targetId);
    if (!target) { setError("Choose a current related update."); return; }
    inFlight.current = true; setBusy(true);
    try {
      const query = new URLSearchParams({ source: source.id, target: target.id });
      const response = await fetch(`${GROUP_API}?${query}`, { cache: "no-store", credentials: "same-origin" });
      const value: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(object(value) && typeof value.error === "string" ? value.error : "The combined preview could not be loaded.");
      const preview = parseMergePreview(value);
      if (!preview || !mergePreviewMatchesSelection(preview, source, target)) throw new Error("The selected updates changed. Refresh before combining them.");
      setMergePreview(preview);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "The combined preview could not be loaded."); }
    finally { inFlight.current = false; setBusy(false); }
  }
  async function saveMerge() {
    if (inFlight.current || requireRefresh.current || !mergePreview) return;
    const source = alerts.find(alert => alert.id === mergeSourceId), target = mergeOptions.find(option => option.id === mergeTargetId);
    if (!source || !target || !mergePreviewMatchesSelection(mergePreview, source, target)) { setError("The selected updates changed. Refresh before combining them."); return; }
    inFlight.current = true; setBusy(true); setError(""); setNotice("");
    try {
      await request({ action: "save", group_id: mergePreview.groupId, expected_hash: mergePreview.expectedHash, members: mergePreview.memberRefs }, GROUP_API);
      setNotice("Combined draft saved. Review it before publishing."); setStatus("pending"); setLoaded(false); setAlerts([]); clearMerge();
      try { await load("pending"); }
      catch { setError("The combined draft was saved, but the list could not refresh. Refresh before reviewing it."); }
    } catch (caught) {
      requireRefresh.current = true; setDecisionsBlocked(true);
      setError(caught instanceof Error ? caught.message : "The combined draft was not confirmed. Refresh before trying again.");
    } finally { inFlight.current = false; setBusy(false); }
  }

  // React rerenders this component before committing when fresh server props
  // change. Wording can improve without changing the original evidence hash.
  const changed = incoming.alerts !== initialAlerts || incoming.options !== initialMergeOptions || incoming.status !== initialStatus;
  if (changed) {
    const contentChanged = incoming.status !== initialStatus || JSON.stringify(incoming.alerts) !== JSON.stringify(initialAlerts) ||
      JSON.stringify(incoming.options || []) !== JSON.stringify(initialMergeOptions || []);
    setIncoming({ alerts: initialAlerts, options: initialMergeOptions, status: initialStatus });
    if (contentChanged && initialAlerts !== undefined && !busy && status === initialStatus) {
      const parsed = parseAlertReviewList({ alerts: initialAlerts, mergeOptions: initialMergeOptions }, initialStatus);
      if (!parsed) { setAlerts([]); setLoaded(false); setDecisionsBlocked(true); setError("The alert list could not be confirmed. Refresh to try again."); }
      else { setAlerts(parsed.alerts); setMergeOptions(parsed.mergeOptions); clearMerge(); setLoaded(true); setDecisionsBlocked(false); }
    }
  }
  useEffect(() => {
    requireRefresh.current = decisionsBlocked;
    if (initialAlerts === undefined && !initialLoadStarted.current) {
      initialLoadStarted.current = true;
      void show(initialStatus);
    }
  });

  return <section className={styles.board} aria-label="Alert review" aria-busy={busy}>
    <header className={styles.toolbar}>
      <div><h1 className="admin-page-title">Review alerts</h1><p className={styles.intro}>Review proposed award changes before subscribers are notified.</p></div>
      <button type="button" className={`button-secondary ${styles.refresh}`} disabled={busy} onClick={() => show(status)}>Refresh</button>
    </header>
    <nav aria-label="Alert review views" className={styles.views}>{views.map(view => <button key={view.status} type="button"
      className={styles.viewButton} aria-pressed={status === view.status}
      disabled={busy} onClick={() => show(view.status)}>{view.label}</button>)}</nav>
    <div aria-live="polite" role="status" className={styles.notice}>{busy ? "Updating alerts…" : notice}</div>
    {error ? <p role="alert" className={styles.error}>{error}</p> : null}
    {loaded && alerts.length === 0 ? <p className={styles.empty}>{status === "pending" ? "No alerts waiting for review." : status === "approved" ? "No approved alerts yet." : "No dismissed alerts yet."}</p> : null}
    {loaded ? <ul className={styles.list}>{alerts.map(alert => {
      const related = relatedMergeOptions(alert, mergeOptions), merging = mergeSourceId === alert.id;
      return <li key={alert.id}><article className={styles.card} aria-label={`${alert.awardName} alert`}>
      <div className={styles.cardHeader}><div><h2 className={styles.title}>{alert.awardName}</h2>
        {alert.group ? <p className={styles.groupLabel}>{status === "pending" ? "Combined draft" : "Combined update"} · {alert.group.members.length} source updates</p> : null}</div>
        <time className={styles.timestamp} dateTime={alert.detectedAt}>{formatCentralDateTime(alert.detectedAt)}</time></div>
      {alert.group?.hasPendingDraft ? <p className={styles.meta}>A newer combined draft is waiting in Needs review.</p> : null}
      <div className={styles.summaryPanel}><p className={styles.summary}>{alert.summary}</p>
        {alert.context ? <p className={`change-summary-context ${styles.context}`}>{alert.context}</p> : null}</div>
      {alert.group ? <>{status === "pending" && alert.group.publishedMemberIds.length ? <p className={styles.meta}>Previously approved updates stay live until this combined draft is approved.</p> : null}
        {memberDetails(alert.group.members, alert.group.publishedMemberIds)}</> : <>
        <a className={styles.sourceLink} href={sourceLink(alert.sourceUrl)!} target="_blank" rel="noopener noreferrer">View official page</a>
        {alert.details.length ? <details className={styles.supportDetails}><summary>Review supporting details</summary>{supportingDetails(alert.details)}</details> : null}</>}
      {status === "pending" || status !== "dismissed" && related.length ? <div className={styles.actions}>
        {status === "pending" ? <><button type="button" className="button-primary" disabled={busy || decisionsBlocked} onClick={() => decide(alert, "approve")}>{alert.group ? "Approve combined update" : "Approve alert"}</button>
          <button type="button" className="button-secondary" disabled={busy || decisionsBlocked} onClick={() => decide(alert, alert.group ? "undo" : "dismiss")}>{alert.group ? "Undo merge" : "Dismiss"}</button></> : null}
        {status !== "dismissed" && related.length ? <button type="button" className={`button-secondary ${styles.combineButton}`} aria-expanded={merging} aria-controls={`merge-${alert.id}`}
          disabled={busy || decisionsBlocked} onClick={() => openMerge(alert)}>Combine with another update</button> : null}
      </div> : null}
      {merging ? <section id={`merge-${alert.id}`} className={styles.mergePanel} aria-label="Combine related updates">
        <p className={styles.meta}>Choose another update for this award. A combination is saved as a draft for your review.</p>
        <label className={styles.detailLabel} htmlFor={`merge-target-${alert.id}`}>Related update</label>
        <select id={`merge-target-${alert.id}`} className="input" value={mergeTargetId} disabled={busy || decisionsBlocked}
          onChange={event => previewMerge(alert, event.target.value)}>
          <option value="">Choose an update</option>{related.map(option => <option key={option.id} value={option.id}>
            {option.relatedToIds?.includes(alert.id) ? "Possibly related · " : ""}{option.status === "approved" ? "Recently approved" : "Needs review"} · {formatCentralDateTime(option.detectedAt)} · {option.summary.length > 100 ? `${option.summary.slice(0, 100)}…` : option.summary}
          </option>)}
        </select>
        {related.find(option => option.id === mergeTargetId && option.relatedToIds?.includes(alert.id))?.relatedReason ?
          <p className={styles.meta}>Possible match: {related.find(option => option.id === mergeTargetId)!.relatedReason}</p> : null}
        {mergePreview ? <section className={styles.preview} aria-label="Combined update preview">
          <h3 className={styles.detailLabel}>Combined draft preview</h3><p>{mergePreview.summary}</p>
          {mergePreview.context ? <p className={styles.meta}>{mergePreview.context}</p> : null}
          <p className={styles.meta}>{mergePreview.message}</p>
          {mergePreview.publishedMemberIds.length ? <p className={styles.meta}>Previously approved updates stay live while you review this draft. Combining updates does not resend emails already sent.</p> : null}
          {memberDetails(mergePreview.members, mergePreview.publishedMemberIds)}
          <button type="button" className="button-primary" disabled={busy || decisionsBlocked} onClick={saveMerge}>Save combined draft</button>
        </section> : null}
        <button type="button" className="button-secondary" disabled={busy} onClick={clearMerge}>Cancel</button>
      </section> : null}
    </article></li>;
    })}</ul> : null}
  </section>;
}
