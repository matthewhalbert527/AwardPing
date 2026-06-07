"use client";

import { useState } from "react";
import { Loader2, Send } from "lucide-react";

type SubmitState =
  | { type: "idle"; message: "" }
  | { type: "success"; message: string }
  | { type: "error"; message: string };

export function SourceRequestForm() {
  const [awardName, setAwardName] = useState("");
  const [homepageUrl, setHomepageUrl] = useState("");
  const [notes, setNotes] = useState("");
  const [website, setWebsite] = useState("");
  const [state, setState] = useState<SubmitState>({ type: "idle", message: "" });
  const [loading, setLoading] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setState({ type: "idle", message: "" });

    try {
      const response = await fetch("/api/source-requests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          awardName,
          homepageUrl,
          notes,
          website,
        }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) {
        setState({
          type: "error",
          message: data.error || "Source request could not be queued.",
        });
        return;
      }

      setAwardName("");
      setHomepageUrl("");
      setNotes("");
      setState({
        type: "success",
        message:
          data.message ||
          "Request queued. AwardPing will use this page as the starting point for source discovery.",
      });
    } catch {
      setState({
        type: "error",
        message: "Source request could not be queued. Try again later.",
      });
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="update-filter-panel">
      <div className="max-w-3xl">
        <p className="dashboard-label">Request a source scan</p>
        <h2 className="dashboard-panel-title mt-2">Give AwardPing the official main award page.</h2>
        <p className="dashboard-panel-copy">
          Use the main page for the award so the scraper can find application, eligibility,
          deadline, FAQ, and PDF subpages during the next source-discovery scrape. For example,
          for Marshall you could submit <span className="font-bold">https://www.marshallscholarship.org/</span>.
        </p>
      </div>

      <form className="mt-5 grid gap-4" onSubmit={submit}>
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label className="text-sm font-bold" htmlFor="source-request-award">
              Award name
            </label>
            <input
              id="source-request-award"
              className="input mt-1"
              placeholder="Marshall Scholarship"
              value={awardName}
              onChange={(event) => setAwardName(event.target.value)}
              required
            />
          </div>
          <div>
            <label className="text-sm font-bold" htmlFor="source-request-url">
              Official main award page
            </label>
            <input
              id="source-request-url"
              className="input mt-1"
              placeholder="https://www.marshallscholarship.org/"
              type="url"
              value={homepageUrl}
              onChange={(event) => setHomepageUrl(event.target.value)}
              required
            />
          </div>
        </div>

        <div>
          <label className="text-sm font-bold" htmlFor="source-request-notes">
            Notes
          </label>
          <textarea
            id="source-request-notes"
            className="input mt-1 min-h-28"
            placeholder="Optional: mention a specific deadline, application, recommender, or PDF page you want AwardPing to find."
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
          />
        </div>

        <div className="hidden" aria-hidden="true">
          <label htmlFor="source-request-website">Website</label>
          <input
            id="source-request-website"
            tabIndex={-1}
            autoComplete="off"
            value={website}
            onChange={(event) => setWebsite(event.target.value)}
          />
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <button className="button-primary sm:w-fit" type="submit" disabled={loading}>
            {loading ? (
              <Loader2 className="animate-spin" size={17} aria-hidden="true" />
            ) : (
              <Send size={17} aria-hidden="true" />
            )}
            Request source scan
          </button>
          {state.message && (
            <p
              className={`text-sm font-semibold ${
                state.type === "error" ? "text-[var(--foreground)]" : "text-[var(--brand-dark)]"
              }`}
            >
              {state.message}
            </p>
          )}
        </div>
      </form>
    </section>
  );
}
