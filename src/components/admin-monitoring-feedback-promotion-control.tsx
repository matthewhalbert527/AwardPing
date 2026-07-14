"use client";

import { useState, type FormEvent } from "react";
import { BadgeCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { monitoringFeedbackLabel } from "@/lib/monitoring-feedback";

type Props = {
  feedbackId: string;
  policyRuleIds: readonly string[];
};

export function AdminMonitoringFeedbackPromotionControl({
  feedbackId,
  policyRuleIds,
}: Props) {
  const router = useRouter();
  const [policyRuleId, setPolicyRuleId] = useState("");
  const [note, setNote] = useState("");
  const [requestId, setRequestId] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    const stableRequestId = requestId || crypto.randomUUID();
    if (!requestId) setRequestId(stableRequestId);

    try {
      const response = await fetch("/api/admin/monitoring-feedback/promotions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestId: stableRequestId,
          feedbackId,
          policyRuleId,
          note: note.trim() || undefined,
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error || "The feedback could not be resolved.");
      }

      setMessage("Resolved under the current active policy.");
      router.refresh();
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "The feedback could not be resolved.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="mt-4 grid gap-2" onSubmit={submit}>
      <label className="grid gap-1 text-xs font-black">
        Resolve with active rule
        <select
          className="input"
          disabled={busy}
          onChange={(event) => {
            setPolicyRuleId(event.target.value);
            setRequestId("");
          }}
          required
          value={policyRuleId}
        >
          <option value="">Choose the implemented rule…</option>
          {policyRuleIds.map((ruleId) => (
            <option key={ruleId} value={ruleId}>
              {monitoringFeedbackLabel(ruleId)}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1 text-xs font-black">
        Resolution note (optional)
        <input
          className="input"
          disabled={busy}
          maxLength={1000}
          onChange={(event) => {
            setNote(event.target.value);
            setRequestId("");
          }}
          placeholder="What changed, test coverage, or implementation reference"
          value={note}
        />
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <button
          className="admin-issue-button"
          disabled={busy || !policyRuleId}
          type="submit"
        >
          <BadgeCheck size={13} aria-hidden="true" />
          {busy ? "Resolving…" : "Mark implemented"}
        </button>
        {message && (
          <p aria-live="polite" className="admin-issue-action-error">
            {message}
          </p>
        )}
      </div>
    </form>
  );
}
