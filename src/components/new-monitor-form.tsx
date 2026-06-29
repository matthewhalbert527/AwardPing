"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, ChevronUp, Plus } from "lucide-react";

export function NewMonitorForm() {
  const router = useRouter();
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setMessage("");

    const form = new FormData(event.currentTarget);
    const response = await fetch("/api/monitors", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        label: form.get("label"),
        url: form.get("url"),
        contentType: form.get("contentType"),
        cadence: form.get("cadence"),
      }),
    });

    const data = await response.json();
    setLoading(false);

    if (!response.ok) {
      setMessage(data.error || "Monitor could not be created.");
      return;
    }

    event.currentTarget.reset();
    setMessage("Monitor created.");
    setExpanded(false);
    router.refresh();
  }

  return (
    <section className="dashboard-panel dashboard-panel-pad">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="dashboard-panel-title">Track exact URL</h2>
          <p className="dashboard-panel-copy">
            Add a deadline, application, eligibility, instruction, or PDF page that is not in the directory yet.
          </p>
        </div>
        <button
          className="button-primary shrink-0"
          type="button"
          onClick={() => setExpanded((current) => !current)}
          aria-expanded={expanded}
        >
          {expanded ? <ChevronUp size={17} aria-hidden="true" /> : <ChevronDown size={17} aria-hidden="true" />}
          {expanded ? "Close" : "Track URL"}
        </button>
      </div>

      {message && <p className="mt-4 text-sm font-semibold">{message}</p>}

      {expanded && (
        <form className="mt-5 border-t border-[var(--line)] pt-5" onSubmit={submit}>
          <div className="grid gap-4 md:grid-cols-2">
        <div>
          <label className="text-sm font-bold" htmlFor="label">
            Award and exact page label
          </label>
          <input
            id="label"
            name="label"
            className="input mt-1"
            placeholder="Goldwater official deadline page"
            required
          />
        </div>
        <div>
          <label className="text-sm font-bold" htmlFor="url">
            Exact official URL to track
          </label>
          <input
            id="url"
            name="url"
            className="input mt-1"
            placeholder="https://official-award-site.org/deadline"
            type="url"
            required
          />
        </div>
        <div>
          <label className="text-sm font-bold" htmlFor="contentType">
            Source type
          </label>
          <select id="contentType" name="contentType" className="input mt-1">
            <option value="auto">Auto detect</option>
            <option value="html">Award webpage</option>
            <option value="pdf">Award PDF</option>
          </select>
        </div>
        <div>
          <label className="text-sm font-bold" htmlFor="cadence">
            Cadence
          </label>
          <select id="cadence" name="cadence" className="input mt-1">
            <option value="daily">Daily</option>
          </select>
        </div>
          </div>
          <button className="button-primary mt-5" type="submit" disabled={loading}>
            <Plus size={17} aria-hidden="true" />
            {loading ? "Creating..." : "Track award page"}
          </button>
        </form>
      )}
    </section>
  );
}
