"use client";

import { useState } from "react";

type RecoveryResponse = {
  ok?: boolean;
  error?: string;
  message?: string;
};

export function PasswordRecoveryRequestForm() {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [requested, setRequested] = useState(false);
  const [loading, setLoading] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setMessage("");

    try {
      const response = await fetch("/api/auth/password-recovery", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: email.trim().toLowerCase(),
        }),
      });
      const result = (await response.json().catch(() => null)) as
        | RecoveryResponse
        | null;

      if (!response.ok || !result?.ok) {
        setMessage(
          result?.error ||
            "Password recovery is temporarily unavailable. Try again later.",
        );
        return;
      }

      setRequested(true);
      setMessage(
        result.message ||
          "If an invited account uses that email, a reset link will arrive shortly.",
      );
    } catch {
      setMessage(
        "Password recovery is temporarily unavailable. Try again later.",
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <form className="space-y-4" onSubmit={submit}>
      <div>
        <label className="text-sm font-bold" htmlFor="recovery-email">
          Account email
        </label>
        <input
          id="recovery-email"
          className="input mt-1"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          autoComplete="email"
          disabled={requested}
          required
        />
      </div>
      {message && (
        <p
          className="rounded-xl bg-[var(--brand-pink-soft)] p-3 text-sm font-semibold text-[var(--foreground)]"
          aria-live="polite"
        >
          {message}
        </p>
      )}
      {!requested && (
        <button className="button-primary w-full" type="submit" disabled={loading}>
          {loading ? "Sending..." : "Send reset link"}
        </button>
      )}
    </form>
  );
}
