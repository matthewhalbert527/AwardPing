"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { safeNextPath } from "@/lib/safe-next-path";

type Props = {
  nextPath?: string;
};

type UpdateResponse = {
  ok?: boolean;
  error?: string;
};

export function PasswordUpdateForm({ nextPath = "" }: Props) {
  const router = useRouter();
  const safeNext = safeNextPath(nextPath) || "/updates";
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setMessage("");

    try {
      const response = await fetch("/api/auth/password-update", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password, confirmation }),
      });
      const result = (await response.json().catch(() => null)) as
        | UpdateResponse
        | null;

      if (!response.ok || !result?.ok) {
        setMessage(
          result?.error ||
            "The password could not be updated. Request a new reset link and try again.",
        );
        return;
      }

      router.replace(safeNext);
      router.refresh();
    } catch {
      setMessage(
        "The password could not be updated. Request a new reset link and try again.",
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <form className="space-y-4" onSubmit={submit}>
      <div>
        <label className="text-sm font-bold" htmlFor="new-password">
          New password
        </label>
        <input
          id="new-password"
          className="input mt-1"
          type="password"
          minLength={12}
          maxLength={128}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="new-password"
          required
        />
        <p className="mt-1 text-xs text-[var(--muted)]">
          Use at least 12 characters.
        </p>
      </div>
      <div>
        <label className="text-sm font-bold" htmlFor="confirm-password">
          Confirm new password
        </label>
        <input
          id="confirm-password"
          className="input mt-1"
          type="password"
          minLength={12}
          maxLength={128}
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
          autoComplete="new-password"
          required
        />
      </div>
      {message && (
        <p
          className="rounded-xl bg-[var(--brand-pink-soft)] p-3 text-sm font-semibold text-[var(--foreground)]"
          role="alert"
        >
          {message}
        </p>
      )}
      <button className="button-primary w-full" type="submit" disabled={loading}>
        {loading ? "Updating..." : "Update password"}
      </button>
    </form>
  );
}
