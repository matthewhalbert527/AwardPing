"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { BellOff, Plus } from "lucide-react";

export function TrackSharedAwardButton({
  sharedAwardId,
  tracked,
  canManage,
}: {
  sharedAwardId: string;
  tracked: boolean;
  canManage: boolean;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");

  async function trackAward() {
    if (!canManage || tracked) return;

    setLoading(true);
    setMessage("");
    const response = await fetch(`/api/shared-awards/${sharedAwardId}/track`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cadence: "daily" }),
    });
    const data = await response.json();
    setLoading(false);

    if (!response.ok) {
      setMessage(data.error || "Award could not be added to the watchlist.");
      return;
    }

    setMessage(data.alreadyTracked ? "Already on your watchlist." : "Added to your watchlist.");
    router.refresh();
  }

  async function untrackAward() {
    if (!canManage || !tracked) return;
    if (!confirm("Remove this award from your watchlist?")) return;

    setLoading(true);
    setMessage("");
    const response = await fetch(`/api/shared-awards/${sharedAwardId}/track`, {
      method: "DELETE",
    });
    const data = await response.json();
    setLoading(false);

    if (!response.ok) {
      setMessage(data.error || "Award could not be removed from the watchlist.");
      return;
    }

    setMessage("Removed from your watchlist.");
    router.refresh();
  }

  return (
    <div>
      <button
        className={tracked ? "button-secondary" : "button-primary"}
        type="button"
        disabled={!canManage || loading}
        onClick={tracked ? untrackAward : trackAward}
      >
        {tracked ? (
          <BellOff size={17} aria-hidden="true" />
        ) : (
          <Plus size={17} aria-hidden="true" />
        )}
        {loading ? (tracked ? "Removing..." : "Adding...") : tracked ? "Untrack" : "Add to watchlist"}
      </button>
      {message && <p className="mt-2 text-sm font-semibold">{message}</p>}
      {!canManage && (
        <p className="mt-2 text-sm text-[var(--muted)]">
          Only office owners and admins can add awards to the watchlist.
        </p>
      )}
    </div>
  );
}
