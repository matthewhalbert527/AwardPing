"use client";

import { useState } from "react";
import { Loader2, Mail } from "lucide-react";

type SubmitState =
  | { type: "idle"; message: "" }
  | { type: "success"; message: string }
  | { type: "error"; message: string };

export function PublicUpdatesForm() {
  const [email, setEmail] = useState("");
  const [website, setWebsite] = useState("");
  const [state, setState] = useState<SubmitState>({ type: "idle", message: "" });
  const [loading, setLoading] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setState({ type: "idle", message: "" });

    try {
      const response = await fetch("/api/public-updates/subscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, website }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) {
        setState({
          type: "error",
          message: data.error || "Daily updates could not be requested.",
        });
        return;
      }

      setEmail("");
      setState({
        type: "success",
        message: data.message || "Check your email to confirm daily updates.",
      });
    } catch {
      setState({
        type: "error",
        message: "Daily updates could not be requested. Try again later.",
      });
    } finally {
      setLoading(false);
    }
  }

  return (
    <form className="card rounded-3xl p-5 sm:p-6" onSubmit={submit}>
      <div>
        <label className="text-sm font-black" htmlFor="public-updates-email">
          Email address
        </label>
        <div className="mt-2 flex flex-col gap-3 sm:flex-row">
          <input
            id="public-updates-email"
            className="input"
            type="email"
            placeholder="advisor@example.edu"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
          <button className="button-primary sm:w-44" type="submit" disabled={loading}>
            {loading ? (
              <Loader2 className="animate-spin" size={17} aria-hidden="true" />
            ) : (
              <Mail size={17} aria-hidden="true" />
            )}
            Subscribe
          </button>
        </div>
      </div>

      <div className="hidden" aria-hidden="true">
        <label htmlFor="public-updates-website">Website</label>
        <input
          id="public-updates-website"
          tabIndex={-1}
          autoComplete="off"
          value={website}
          onChange={(event) => setWebsite(event.target.value)}
        />
      </div>

      {state.message && (
        <p
          className={`mt-4 text-sm font-semibold ${
            state.type === "error" ? "text-[var(--foreground)]" : "text-[var(--brand-dark)]"
          }`}
        >
          {state.message}
        </p>
      )}
    </form>
  );
}
