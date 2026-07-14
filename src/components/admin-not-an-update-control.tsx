"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { CircleOff, X } from "lucide-react";
import {
  monitoringFeedbackReasonCodes,
  monitoringFeedbackLabel,
  monitoringFeedbackReasonLabels,
  monitoringFeedbackRequiresNote,
  monitoringFeedbackScopeLabels,
  monitoringFeedbackScopes,
  type MonitoringFeedbackReasonCode,
  type MonitoringFeedbackScope,
} from "@/lib/monitoring-feedback";

type Props = {
  eventId: string;
  policyRuleIds: readonly string[];
};

type FeedbackResponse = {
  error?: string;
  promotionStatus?: "pending_review" | "already_active";
};

export function AdminNotAnUpdateControl({ eventId, policyRuleIds }: Props) {
  const router = useRouter();
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [requestId, setRequestId] = useState("");
  const [reasonCode, setReasonCode] =
    useState<MonitoringFeedbackReasonCode>("capture_noise");
  const [requestedScope, setRequestedScope] =
    useState<MonitoringFeedbackScope>("event");
  const [policyRuleId, setPolicyRuleId] = useState("");
  const [note, setNote] = useState("");
  const noteRequired = monitoringFeedbackRequiresNote(reasonCode, requestedScope);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("");

    const stableRequestId = requestId || crypto.randomUUID();
    if (!requestId) setRequestId(stableRequestId);

    try {
      const response = await fetch("/api/admin/monitoring-feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestId: stableRequestId,
          eventId,
          reasonCode,
          requestedScope,
          policyRuleId: policyRuleId || undefined,
          note: note.trim() || undefined,
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as FeedbackResponse;
      if (!response.ok) {
        throw new Error(payload.error || "The update could not be suppressed.");
      }

      setMessage(
        payload.promotionStatus === "already_active"
          ? "Suppressed and linked to an active monitoring rule."
          : "Suppressed and queued for policy review; no broader rule was activated.",
      );
      router.refresh();
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "The update could not be suppressed.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (!expanded) {
    return (
      <div className="admin-issue-button-row">
        <button
          className="admin-issue-button admin-issue-button-danger"
          onClick={() => setExpanded(true)}
          type="button"
        >
          <CircleOff size={13} aria-hidden="true" />
          Not an update
        </button>
      </div>
    );
  }

  return (
    <form className="mt-4 grid gap-3" onSubmit={submit}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-black">Suppress and record feedback</p>
          <p className="mt-1 text-xs font-semibold leading-5 text-[var(--muted)]">
            This event is hidden immediately. A broader scope is only a review
            request until it is approved and implemented.
          </p>
        </div>
        <button
          aria-label="Close feedback form"
          className="admin-issue-button"
          disabled={busy}
          onClick={() => setExpanded(false)}
          type="button"
        >
          <X size={13} aria-hidden="true" />
        </button>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <label className="grid gap-1 text-xs font-black">
          Reason
          <select
            className="input"
            disabled={busy}
            onChange={(event) => {
              setReasonCode(event.target.value as MonitoringFeedbackReasonCode);
              setRequestId("");
            }}
            value={reasonCode}
          >
            {monitoringFeedbackReasonCodes.map((reason) => (
              <option key={reason} value={reason}>
                {monitoringFeedbackReasonLabels[reason]}
              </option>
            ))}
          </select>
        </label>

        <label className="grid gap-1 text-xs font-black">
          Requested scope
          <select
            className="input"
            disabled={busy}
            onChange={(event) => {
              setRequestedScope(event.target.value as MonitoringFeedbackScope);
              setRequestId("");
            }}
            value={requestedScope}
          >
            {monitoringFeedbackScopes.map((scope) => (
              <option key={scope} value={scope}>
                {monitoringFeedbackScopeLabels[scope]}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="grid gap-1 text-xs font-black">
        Existing active rule
        <select
          className="input"
          disabled={busy}
          onChange={(event) => {
            setPolicyRuleId(event.target.value);
            setRequestId("");
          }}
          value={policyRuleId}
        >
          <option value="">Novel correction — queue for policy review</option>
          {policyRuleIds.map((ruleId) => (
            <option key={ruleId} value={ruleId}>
              Already covered: {monitoringFeedbackLabel(ruleId)}
            </option>
          ))}
        </select>
        <span className="font-semibold leading-5 text-[var(--muted)]">
          Only choose a rule when this exact false-positive pattern is already
          covered by the active alert-blocking policy.
        </span>
      </label>

      <label className="grid gap-1 text-xs font-black">
        Note{noteRequired ? " (required)" : " (optional)"}
        <textarea
          className="input min-h-24 text-sm"
          disabled={busy}
          maxLength={1000}
          onChange={(event) => {
            setNote(event.target.value);
            setRequestId("");
          }}
          placeholder={
            requestedScope === "global"
              ? "Describe the generalized pattern and when legitimate updates must escape it."
              : "Add evidence or context for the reviewer."
          }
          required={noteRequired}
          value={note}
        />
      </label>

      <div className="flex flex-wrap items-center gap-3">
        <button className="button-primary" disabled={busy} type="submit">
          <CircleOff size={14} aria-hidden="true" />
          {busy ? "Suppressing…" : "Confirm not an update"}
        </button>
        {message && (
          <p
            aria-live="polite"
            className="text-xs font-black text-[var(--brand-burgundy)]"
          >
            {message}
          </p>
        )}
      </div>
    </form>
  );
}
