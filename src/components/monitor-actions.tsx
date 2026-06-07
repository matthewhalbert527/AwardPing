"use client";

import { useRouter } from "next/navigation";
import { Pause, Play, Trash2 } from "lucide-react";

type Props = {
  id: string;
  status: "active" | "paused" | "error";
};

export function MonitorActions({ id, status }: Props) {
  const router = useRouter();

  async function updateStatus(nextStatus: "active" | "paused") {
    await fetch(`/api/monitors/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: nextStatus }),
    });
    router.refresh();
  }

  async function remove() {
    if (!confirm("Delete this tracked award page?")) return;
    await fetch(`/api/monitors/${id}`, { method: "DELETE" });
    router.refresh();
  }

  return (
    <div className="flex flex-wrap gap-2">
      {status === "paused" ? (
        <button className="button-secondary" type="button" onClick={() => updateStatus("active")}>
          <Play size={15} aria-hidden="true" />
          Resume
        </button>
      ) : (
        <button className="button-secondary" type="button" onClick={() => updateStatus("paused")}>
          <Pause size={15} aria-hidden="true" />
          Pause
        </button>
      )}
      <button className="button-secondary" type="button" onClick={remove}>
        <Trash2 size={15} aria-hidden="true" />
        Delete
      </button>
    </div>
  );
}
