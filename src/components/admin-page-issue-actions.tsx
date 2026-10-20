"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Archive, RotateCcw, Search } from "lucide-react";

type Props = {
  sourceId: string | null;
  mode: "active" | "review";
  sourceTitle: string;
};

export function AdminPageIssueActions({ sourceId, mode, sourceTitle }: Props) {
  const [busyAction, setBusyAction] = useState<"review_later" | "restore" | "delete" | null>(null);
  const inFlightRef = useRef(false);
  const mountedRef = useRef(false);
  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  function updateBusyAction(action: typeof busyAction) {
    if (mountedRef.current) setBusyAction(action);
  }

  if (!sourceId) return null;
  // A refreshed source must not inherit another source/context's confirmation.
  return <AdminPageIssueControls key={JSON.stringify([sourceId, mode, sourceTitle])}
    sourceId={sourceId} mode={mode} sourceTitle={sourceTitle} inFlightRef={inFlightRef}
    busyAction={busyAction} updateBusyAction={updateBusyAction} />;
}

type RestoreConfirmation = { sourceId: string; sourceTitle: string; mode: "review" };

function AdminPageIssueControls({ sourceId, mode, sourceTitle, inFlightRef, busyAction, updateBusyAction }: Props & {
  sourceId: string;
  inFlightRef: { current: boolean };
  busyAction: "review_later" | "restore" | "delete" | null;
  updateBusyAction: (action: "review_later" | "restore" | "delete" | null) => void;
}) {
  const router = useRouter();
  const [message, setMessage] = useState("");
  const [restoreConfirmation, setRestoreConfirmation] = useState<RestoreConfirmation | null>(null);
  const confirmationId = useId();
  const mountedRef = useRef(false);
  const restoreRef = useRef<RestoreConfirmation | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      restoreRef.current = null;
      triggerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!mountedRef.current || restoreConfirmation || busyAction || restoreRef.current || inFlightRef.current) return;
    const trigger = triggerRef.current;
    triggerRef.current = null;
    if (trigger?.isConnected && !trigger.matches(":disabled")) trigger.focus();
  }, [restoreConfirmation, busyAction, inFlightRef]);

  async function moveToReview() {
    const note = window.prompt("Optional note explaining why this source should leave monitoring:", "");
    if (note === null) return;
    await runAction("review_later", "PATCH", {
      action: "review_later",
      note,
    });
  }

  function restore() {
    if (!mountedRef.current || mode !== "review" || restoreRef.current || inFlightRef.current) return;
    const confirmation = { sourceId, sourceTitle, mode };
    triggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    restoreRef.current = confirmation;
    setRestoreConfirmation(confirmation);
    setMessage("");
  }

  function cancelRestore() {
    if (!mountedRef.current || !restoreConfirmation || restoreRef.current !== restoreConfirmation || inFlightRef.current) return;
    restoreRef.current = null;
    setRestoreConfirmation(null);
    setMessage("Cancelled. No request was sent.");
  }

  async function confirmRestore() {
    const confirmation = restoreConfirmation;
    if (!mountedRef.current || !confirmation || restoreRef.current !== confirmation || inFlightRef.current) return;
    // Consume synchronously, before React rerenders or network work begins.
    restoreRef.current = null;
    setRestoreConfirmation(null);
    if (confirmation.sourceId !== sourceId || confirmation.sourceTitle !== sourceTitle || mode !== "review") return;
    await runAction("restore", "PATCH", { action: "restore" });
  }

  async function remove() {
    const confirmed = window.confirm(
      `Retire this source from AwardPing?\n\n${sourceTitle}\n\nThis removes it from active monitoring and linked watchlists. Published updates and immutable visual evidence are preserved.`,
    );
    if (!confirmed) return;
    await runAction("delete", "DELETE");
  }

  async function runAction(
    action: "review_later" | "restore" | "delete",
    method: "PATCH" | "DELETE",
    body?: Record<string, unknown>,
  ) {
    if (!mountedRef.current || restoreRef.current || inFlightRef.current) return;
    inFlightRef.current = true;
    updateBusyAction(action);
    setMessage("");
    try {
      const response = await fetch(`/api/admin/page-issues/${sourceId}`, {
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await response.json().catch(() => ({})) as {
        error?: string;
        message?: string;
        monitoring?: { allowed?: boolean; reason?: string };
      };
      if (!mountedRef.current) return;
      if (!response.ok) {
        throw new Error(typeof data.error === "string" ? data.error : "Page action failed.");
      }
      if (action === "restore" && data.monitoring?.allowed !== true) {
        throw new Error(
          "AwardPing did not confirm that monitoring resumed. Refresh and review the source evidence.",
        );
      }
      if (data.message) setMessage(data.message);
      router.refresh();
    } catch (error) {
      if (mountedRef.current) setMessage(error instanceof Error ? error.message : "Page action failed.");
    } finally {
      inFlightRef.current = false;
      updateBusyAction(null);
    }
  }

  return (
    <div className="admin-issue-button-row">
      {mode === "active" ? (
        <button
          className="admin-issue-button"
          disabled={busyAction !== null || restoreConfirmation !== null}
          onClick={moveToReview}
          type="button"
        >
          <Search size={13} aria-hidden="true" />
          {busyAction === "review_later" ? "Moving" : "Review later"}
        </button>
      ) : (
        <button
          className="admin-issue-button"
          disabled={busyAction !== null || restoreConfirmation !== null}
          onClick={restore}
          type="button"
        >
          <RotateCcw size={13} aria-hidden="true" />
          {busyAction === "restore" ? "Verifying restoration" : "Verify & restore monitoring"}
        </button>
      )}
      <button
        className="admin-issue-button admin-issue-button-danger"
        disabled={busyAction !== null || restoreConfirmation !== null}
        onClick={remove}
        type="button"
      >
        <Archive size={13} aria-hidden="true" />
        {busyAction === "delete" ? "Retiring" : "Retire source"}
      </button>
      {restoreConfirmation && (
        <section
          aria-describedby={`${confirmationId}-warning`}
          aria-labelledby={`${confirmationId}-heading`}
          className="w-full rounded-xl border border-[var(--border)] p-4"
          onKeyDown={(event) => {
            if (event.key === "Escape") { event.preventDefault(); cancelRestore(); }
          }}
          role="region"
        >
          <h4 className="font-bold" id={`${confirmationId}-heading`}>Restore this source to monitoring?</h4>
          <p className="mt-2 font-semibold">{restoreConfirmation.sourceTitle}</p>
          <p className="mt-1 break-all text-sm">Source ID: {restoreConfirmation.sourceId}</p>
          <p className="mt-2 text-sm" id={`${confirmationId}-warning`}>
            AwardPing will restore it only when the latest AI review is unclear and all non-AI source checks still pass.
            The action itself is free. If verified, capture checks resume, but public facts and updates remain unapproved;
            any later detected change still follows the separately capped review lane.
          </p>
          <div className="admin-issue-button-row mt-3">
            <button autoFocus className="admin-issue-button" onClick={cancelRestore} type="button">Cancel</button>
            <button className="admin-issue-button" onClick={confirmRestore} type="button">Confirm restore</button>
          </div>
        </section>
      )}
      {message && <p aria-live="polite" className="admin-issue-action-error">{message}</p>}
    </div>
  );
}
