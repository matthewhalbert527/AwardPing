"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { safeNextPath } from "@/lib/safe-next-path";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

type Props =
  | {
      mode: "login";
      nextPath?: string;
    }
  | {
      mode: "signup";
      inviteToken: string;
      inviteEmailHint: string;
      nextPath?: string;
    };

export function AuthForm(props: Props) {
  const router = useRouter();
  const { mode } = props;
  const nextPath = props.nextPath || "";
  const fallbackPath = mode === "signup" ? "/dashboard/onboarding" : "/updates";
  const safeNext = safeNextPath(nextPath) || fallbackPath;
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setMessage("");
    try {
      if (mode === "login") {
        const supabase = createSupabaseBrowserClient();
        const result = await supabase.auth.signInWithPassword({
          email: email.trim().toLowerCase(),
          password,
        });

        if (result.error) {
          setMessage(authErrorMessage(result.error.message));
          return;
        }

        router.push(safeNext);
        router.refresh();
        return;
      }

      const response = await fetch("/api/auth/invite-signup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          inviteToken: props.inviteToken,
          password,
        }),
      });
      const result = (await response.json().catch(() => null)) as {
        ok?: boolean;
        signedIn?: boolean;
      } | null;

      if (!response.ok || !result?.ok) {
        setMessage("We could not create an account with that invitation.");
        return;
      }

      router.push(result.signedIn ? safeNext : "/login?account=created");
      router.refresh();
    } catch {
      setMessage("We could not create an account with that invitation.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form className="space-y-4" onSubmit={submit}>
      <div>
        <label className="text-sm font-bold" htmlFor="email">
          Email
        </label>
        {mode === "login" ? (
          <input
            id="email"
            className="input mt-1"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="username"
            required
          />
        ) : (
          <input
            id="email"
            className="input mt-1"
            type="text"
            value={props.inviteEmailHint}
            autoComplete="email"
            readOnly
          />
        )}
      </div>
      <div>
        <label className="text-sm font-bold" htmlFor="password">
          Password
        </label>
        <input
          id="password"
          className="input mt-1"
          type="password"
          minLength={mode === "signup" ? 12 : 8}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete={mode === "login" ? "current-password" : "new-password"}
          required
        />
      </div>
      {message && (
        <p className="rounded-xl bg-[var(--brand-pink-soft)] p-3 text-sm font-semibold text-[var(--foreground)]">
          {message}
        </p>
      )}
      <button className="button-primary w-full" type="submit" disabled={loading}>
        {loading ? "Working..." : mode === "login" ? "Log in" : "Create account"}
      </button>
    </form>
  );
}

function authErrorMessage(message: string) {
  if (/database error|querying schema|finding users/i.test(message)) {
    return "Supabase is temporarily unable to reach the database. Please try again after the database comes back online.";
  }
  return message;
}
