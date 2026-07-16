"use client";

import { useMemo, useRef, useState } from "react";
import {
  CheckSquare2,
  Clock3,
  ExternalLink,
  Play,
  ShieldCheck,
  UserMinus,
  UserPlus,
  UserRound,
  Wrench,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { AdminManualQuarantineBacklogItem } from "@/lib/admin-manual-quarantine-backlog";
import { formatCentralDateTime } from "@/lib/time-zone";

type Props = {
  available: boolean;
  currentUserEmail: string;
  currentUserId: string;
  items: AdminManualQuarantineBacklogItem[];
  refreshHref: string;
};

type BulkAction = "assign_to_me" | "start_review" | "unassign";

type ActionMessage = {
  text: string;
  tone: "error" | "success";
};

export function AdminManualQuarantineBacklogQueue({
  available,
  currentUserEmail,
  currentUserId,
  items,
  refreshHref,
}: Props) {
  const router = useRouter();
  const requestIds = useRef(new Map<string, string>());
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [busyAction, setBusyAction] = useState<BulkAction | null>(null);
  const [message, setMessage] = useState<ActionMessage | null>(null);
  const selectedItems = useMemo(
    () => items.filter((item) => selectedIds.has(item.id)),
    [items, selectedIds],
  );
  const eligibility = manualQuarantineBulkEligibility(
    selectedItems,
    currentUserId,
    currentUserEmail,
  );
  const allDisplayedSelected =
    items.length > 0 && items.every((item) => selectedIds.has(item.id));

  function toggleItem(id: string) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setMessage(null);
  }

  function toggleDisplayed() {
    setSelectedIds(
      allDisplayedSelected ? new Set() : new Set(items.map((item) => item.id)),
    );
    setMessage(null);
  }

  async function applyBulkAction(action: BulkAction) {
    if (selectedItems.length === 0 || busyAction) return;
    const signature = `${action}:${selectedItems
      .map((item) => `${item.id}:${item.evidenceHash}`)
      .sort()
      .join("|")}`;
    const requestId = requestIds.current.get(signature) || crypto.randomUUID();
    requestIds.current.set(signature, requestId);
    setBusyAction(action);
    setMessage(null);

    try {
      const response = await fetch("/api/admin/manual-quarantine/bulk", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action,
          cases: selectedItems.map((item) => ({
            assignedToEmail: item.assignedToEmail,
            evidenceHash: item.evidenceHash,
            id: item.id,
            status: item.status,
          })),
          requestId,
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        changed?: number;
        createsApiCharge?: boolean;
        error?: string;
        ok?: boolean;
        replayed?: boolean;
      };
      if (!response.ok) {
        if (!shouldRetainManualQuarantineRequestId(response.status)) {
          requestIds.current.delete(signature);
        }
        throw new Error(payload.error || "The no-charge ownership action could not be applied.");
      }
      if (payload.ok !== true || payload.createsApiCharge !== false) {
        throw new Error(
          "The ownership action returned an incomplete safety receipt. Refresh before trying again.",
        );
      }

      requestIds.current.delete(signature);
      setSelectedIds(new Set());
      setMessage({
        tone: "success",
        text: `${bulkActionPastTense(action)} ${formatNumber(payload.changed || 0)} ${plural(
          payload.changed || 0,
          "case",
        )}. This action created no API charge${payload.replayed ? " and safely replayed the original request" : ""}.`,
      });
      refreshManualQuarantineQueue(router, refreshHref);
    } catch (error) {
      setMessage({
        tone: "error",
        text:
          error instanceof Error
            ? error.message
            : "The no-charge ownership action could not be applied.",
      });
    } finally {
      setBusyAction(null);
    }
  }

  if (items.length === 0) {
    return (
      <div className="card manual-backlog-empty-copy">
        <CheckSquare2 aria-hidden="true" size={20} />
        <p>No quarantine cases are on this page.</p>
      </div>
    );
  }

  return (
    <div className="manual-backlog-case-queue">
      <div className="card manual-backlog-bulk-toolbar">
        <div>
          <p className="operator-inbox-kicker">Safe queue organization</p>
          <strong>
            {formatNumber(selectedItems.length)} of {formatNumber(items.length)} displayed {plural(items.length, "case")} selected
          </strong>
          <p>
            These controls only change ownership or review state. They never run a paid review or close a case.
          </p>
        </div>
        <div className="manual-backlog-bulk-actions">
          <button
            className="button-secondary"
            disabled={!available || busyAction !== null}
            onClick={toggleDisplayed}
            type="button"
          >
            <CheckSquare2 aria-hidden="true" size={15} />
            {allDisplayedSelected ? "Clear selection" : "Select displayed"}
          </button>
          <button
            className="admin-issue-button"
            disabled={!available || busyAction !== null || !eligibility.assignToMe}
            onClick={() => applyBulkAction("assign_to_me")}
            type="button"
          >
            <UserPlus aria-hidden="true" size={15} />
            {busyAction === "assign_to_me" ? "Assigning…" : "Assign to me"}
          </button>
          <button
            className="admin-issue-button"
            disabled={!available || busyAction !== null || !eligibility.startReview}
            onClick={() => applyBulkAction("start_review")}
            type="button"
          >
            <Play aria-hidden="true" size={15} />
            {busyAction === "start_review" ? "Starting…" : "Start review"}
          </button>
          <button
            className="admin-issue-button"
            disabled={!available || busyAction !== null || !eligibility.unassignOwn}
            onClick={() => applyBulkAction("unassign")}
            type="button"
          >
            <UserMinus aria-hidden="true" size={15} />
            {busyAction === "unassign"
              ? "Returning…"
              : "Return my cases to queue"}
          </button>
        </div>
        {message && (
          <p
            className={`manual-backlog-bulk-message manual-backlog-bulk-message-${message.tone}`}
            role={message.tone === "error" ? "alert" : "status"}
          >
            {message.text}
          </p>
        )}
      </div>

      <div className="manual-backlog-case-list">
        {items.map((item) => {
          const selected = selectedIds.has(item.id);
          const exactFirstSeen = formatCentralDateTime(item.firstObservedAt);
          const assignment = item.assignedToEmail || "Unassigned";
          const statusLabel = item.status === "in_review" ? "In review" : "Quarantined";
          return (
            <article
              className={`card operator-inbox-item operator-inbox-item-${item.severity} manual-backlog-case${
                selected ? " manual-backlog-case-selected" : ""
              }`}
              key={item.id}
            >
              <label className="manual-backlog-case-select">
                <input
                  aria-label={`Select ${item.title}`}
                  checked={selected}
                  disabled={!available || busyAction !== null}
                  onChange={() => toggleItem(item.id)}
                  type="checkbox"
                />
              </label>
              <div className="manual-backlog-case-content">
                <header className="operator-inbox-item-header">
                  <div className="operator-inbox-badges">
                    <span className={`admin-severity-pill admin-severity-pill-${item.severity}`}>
                      {capitalize(item.severity)} severity
                    </span>
                    <span className={`operator-impact-pill operator-impact-pill-${item.publicImpact}`}>
                      {publicImpactLabel(item.publicImpact)}
                    </span>
                    <span
                      className={`operator-state-pill operator-state-pill-${
                        item.status === "in_review" ? "auto_retrying" : "needs_operator"
                      }`}
                    >
                      {statusLabel}
                    </span>
                    {item.terminal && (
                      <span className="operator-state-pill operator-state-pill-blocked">
                        Terminal failure
                      </span>
                    )}
                  </div>
                  <time dateTime={item.firstObservedAt} title={exactFirstSeen}>
                    {ageLabel(item.ageDays)}
                  </time>
                </header>

                <div className="operator-inbox-title-block">
                  <h3>{item.title}</h3>
                  <p>
                    {item.sourceDomain} · {sourceBasisLabel(item.sourceDomainBasis)}
                  </p>
                </div>

                <div className="operator-inbox-reason">
                  <span>Evidence failure</span>
                  <p>{item.evidenceFailureLabel}</p>
                </div>

                <dl className="operator-inbox-facts manual-backlog-case-facts">
                  <div className="operator-inbox-fact">
                    <dt>
                      <Clock3 aria-hidden="true" size={14} />
                      Age
                    </dt>
                    <dd>
                      {ageLabel(item.ageDays)}
                      <p>First observed {exactFirstSeen || "at an unavailable time"}.</p>
                    </dd>
                  </div>
                  <div className="operator-inbox-fact">
                    <dt>
                      <Wrench aria-hidden="true" size={14} />
                      Functional owner
                    </dt>
                    <dd>
                      {item.functionalOwner || "Unassigned function"}
                      <p>The team responsible for this type of repair.</p>
                    </dd>
                  </div>
                  <div className="operator-inbox-fact">
                    <dt>
                      <UserRound aria-hidden="true" size={14} />
                      Individual assignment
                    </dt>
                    <dd>
                      {assignment}
                      <p>{item.assignedAt ? `Assigned ${formatCentralDateTime(item.assignedAt)}.` : "No individual has claimed this case."}</p>
                    </dd>
                  </div>
                  <div className="operator-inbox-fact">
                    <dt>
                      <ShieldCheck aria-hidden="true" size={14} />
                      Evidence and policy
                    </dt>
                    <dd>
                      {formatNumber(item.evidenceRecordCount)} evidence {plural(item.evidenceRecordCount, "record")}
                      <p>Policy {item.policyVersion || "version unavailable"}.</p>
                    </dd>
                  </div>
                </dl>

                <dl className="manual-backlog-case-repair-grid">
                  <div>
                    <dt>Policy reason</dt>
                    <dd>{item.policyReasonLabel}</dd>
                  </div>
                  <div>
                    <dt>Likely repair</dt>
                    <dd>{item.likelyRepairLabel}</dd>
                  </div>
                  <div>
                    <dt>Recommended safe action</dt>
                    <dd>{item.recommendedAction}</dd>
                  </div>
                </dl>

                {(item.awardHref || item.sourceHref) && (
                  <div aria-label="Related case evidence" className="operator-inbox-links manual-backlog-case-links">
                    {item.awardHref && <Link href={item.awardHref}>Award workspace</Link>}
                    {item.sourceHref && (
                      <a href={item.sourceHref} rel="noreferrer" target="_blank">
                        {sourceLinkLabel(item.sourceDomainBasis)} <ExternalLink aria-hidden="true" size={13} />
                      </a>
                    )}
                  </div>
                )}

                <details className="operator-inbox-evidence manual-backlog-case-evidence">
                  <summary>
                    Evidence identity <span>{item.policyVersion}</span>
                  </summary>
                  <dl className="manual-backlog-case-evidence-grid">
                    <div>
                      <dt>Evidence hash</dt>
                      <dd>{item.evidenceHash}</dd>
                    </div>
                    <div>
                      <dt>Policy identity</dt>
                      <dd>{item.policyId}</dd>
                    </div>
                    <div>
                      <dt>Policy hash</dt>
                      <dd>{item.policyHash}</dd>
                    </div>
                    <div>
                      <dt>Failure code</dt>
                      <dd>{item.evidenceFailureCode}</dd>
                    </div>
                  </dl>
                </details>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}

export function manualQuarantineBulkEligibility(
  items: AdminManualQuarantineBacklogItem[],
  currentUserId: string,
  currentUserEmail: string,
) {
  const actorId = currentUserId.trim().toLowerCase();
  const actor = currentUserEmail.trim().toLowerCase();
  const hasSelection = items.length > 0;
  const assignedToActor = (item: AdminManualQuarantineBacklogItem) =>
    item.assignedToUserId
      ? item.assignedToUserId.trim().toLowerCase() === actorId
      : item.assignedToEmail?.trim().toLowerCase() === actor;
  return {
    assignToMe:
      hasSelection &&
      Boolean(actorId && actor) &&
      items.every(
        (item) =>
          item.safeActions.assignToMe &&
          (!item.assignedToEmail || assignedToActor(item)),
      ),
    startReview:
      hasSelection &&
      Boolean(actorId && actor) &&
      items.every(
        (item) =>
          item.safeActions.startReview &&
          item.status === "quarantined" &&
          assignedToActor(item),
      ),
    unassignOwn:
      hasSelection &&
      Boolean(actorId && actor) &&
      items.every(
        (item) => item.safeActions.unassign && assignedToActor(item),
      ),
  };
}

export function shouldRetainManualQuarantineRequestId(
  responseStatus: number | null,
) {
  return responseStatus === null || responseStatus >= 500;
}

export function refreshManualQuarantineQueue(
  router: Pick<ReturnType<typeof useRouter>, "refresh" | "replace">,
  refreshHref: string,
) {
  router.replace(refreshHref, { scroll: false });
  router.refresh();
}

function bulkActionPastTense(action: BulkAction) {
  if (action === "assign_to_me") return "Assigned";
  if (action === "start_review") return "Started review for";
  return "Unassigned";
}

function sourceBasisLabel(
  basis: AdminManualQuarantineBacklogItem["sourceDomainBasis"],
) {
  if (basis === "event_specific_source") return "event-specific source";
  if (basis === "current_source") return "current source";
  if (basis === "award_homepage_fallback") return "award homepage fallback";
  return "source basis unavailable";
}

function sourceLinkLabel(
  basis: AdminManualQuarantineBacklogItem["sourceDomainBasis"],
) {
  if (basis === "event_specific_source") return "Event source";
  if (basis === "current_source") return "Current tracked source";
  if (basis === "award_homepage_fallback") return "Award homepage";
  return "Source website";
}

function publicImpactLabel(impact: AdminManualQuarantineBacklogItem["publicImpact"]) {
  if (impact === "blocked") return "Public update blocked";
  if (impact === "delayed") return "Public update delayed";
  if (impact === "protected") return "Public output protected";
  if (impact === "none") return "No public impact";
  return "Public impact unknown";
}

function ageLabel(days: number) {
  if (days < 1) return "Under 24 hours old";
  return `${formatNumber(days)} ${plural(days, "day")} old`;
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
