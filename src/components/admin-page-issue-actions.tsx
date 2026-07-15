"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Archive, RotateCcw, Search } from "lucide-react";

type Props = {
  sourceId: string | null;
  mode: "active" | "review";
  sourceTitle: string;
};

export function AdminPageIssueActions({ sourceId, mode, sourceTitle }: Props) {
  const router = useRouter();
  const [busyAction, setBusyAction] = useState<"review_later" | "restore" | "delete" | null>(null);
  const [message, setMessage] = useState("");

  if (!sourceId) {
    return null;
  }

  async function moveToReview() {
    const note = window.prompt("Optional note explaining why this source should leave monitoring:", "");
    if (note === null) return;
    await runAction("review_later", "PATCH", {
      action: "review_later",
      note,
    });
  }

  async function restore() {
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
    setBusyAction(action);
    setMessage("");
    try {
      const response = await fetch(`/api/admin/page-issues/${sourceId}`, {
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(typeof data.error === "string" ? data.error : "Page action failed.");
      }
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Page action failed.");
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <div className="admin-issue-button-row">
      {mode === "active" ? (
        <button
          className="admin-issue-button"
          disabled={busyAction !== null}
          onClick={moveToReview}
          type="button"
        >
          <Search size={13} aria-hidden="true" />
          {busyAction === "review_later" ? "Moving" : "Review later"}
        </button>
      ) : (
        <button
          className="admin-issue-button"
          disabled={busyAction !== null}
          onClick={restore}
          type="button"
        >
          <RotateCcw size={13} aria-hidden="true" />
          {busyAction === "restore" ? "Restoring" : "Restore"}
        </button>
      )}
      <button
        className="admin-issue-button admin-issue-button-danger"
        disabled={busyAction !== null}
        onClick={remove}
        type="button"
      >
        <Archive size={13} aria-hidden="true" />
        {busyAction === "delete" ? "Retiring" : "Retire source"}
      </button>
      {message && <p aria-live="polite" className="admin-issue-action-error">{message}</p>}
    </div>
  );
}
