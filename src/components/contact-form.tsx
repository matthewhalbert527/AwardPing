"use client";

import { useState } from "react";
import { Loader2, Send } from "lucide-react";

type SubmitState =
  | { type: "idle"; message: "" }
  | { type: "success"; message: string }
  | { type: "error"; message: string };

export function ContactForm() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [website, setWebsite] = useState("");
  const [state, setState] = useState<SubmitState>({ type: "idle", message: "" });
  const [loading, setLoading] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setState({ type: "idle", message: "" });

    try {
      const response = await fetch("/api/contact", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, email, message, website }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) {
        setState({
          type: "error",
          message: data.error || "Your message could not be sent.",
        });
        return;
      }

      setName("");
      setEmail("");
      setMessage("");
      setState({
        type: "success",
        message: data.message || "Thanks. Your message was sent.",
      });
    } catch {
      setState({
        type: "error",
        message: "Your message could not be sent. Try again later.",
      });
    } finally {
      setLoading(false);
    }
  }

  return (
    <form className="card grid gap-4 rounded-3xl p-5 sm:p-6" onSubmit={submit}>
      <div>
        <label className="text-sm font-black" htmlFor="contact-name">
          Name
        </label>
        <input
          id="contact-name"
          className="input mt-2"
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
        />
      </div>

      <div>
        <label className="text-sm font-black" htmlFor="contact-email">
          Email
        </label>
        <input
          id="contact-email"
          className="input mt-2"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
        />
      </div>

      <div>
        <label className="text-sm font-black" htmlFor="contact-message">
          Message
        </label>
        <textarea
          id="contact-message"
          className="input mt-2 min-h-40 resize-y"
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          required
        />
      </div>

      <div className="hidden" aria-hidden="true">
        <label htmlFor="contact-website">Website</label>
        <input
          id="contact-website"
          tabIndex={-1}
          autoComplete="off"
          value={website}
          onChange={(event) => setWebsite(event.target.value)}
        />
      </div>

      <button className="button-primary w-full sm:w-fit" type="submit" disabled={loading}>
        {loading ? (
          <Loader2 className="animate-spin" size={17} aria-hidden="true" />
        ) : (
          <Send size={17} aria-hidden="true" />
        )}
        Send message
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
    </form>
  );
}
