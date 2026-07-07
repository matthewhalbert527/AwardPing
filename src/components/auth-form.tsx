"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

type Props = {
  mode: "login" | "signup";
  nextPath?: string;
};

export function AuthForm({ mode, nextPath = "" }: Props) {
  const router = useRouter();
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
    const supabase = createSupabaseBrowserClient();

    const normalizedEmail = email.trim().toLowerCase();
    const result =
      mode === "login"
        ? await supabase.auth.signInWithPassword({
            email: normalizedEmail,
            password,
          })
        : await supabase.auth.signUp({
            email: normalizedEmail,
            password,
            options: {
              emailRedirectTo: `${window.location.origin}/auth/confirm?next=${encodeURIComponent(safeNext)}`,
            },
          });

    setLoading(false);

    if (result.error) {
      setMessage(authErrorMessage(result.error.message));
      return;
    }

    if (mode === "signup" && !result.data.session) {
      setMessage("Check your email to confirm your account.");
      return;
    }

    router.push(safeNext);
    router.refresh();
  }

  return (
    <form className="space-y-4" onSubmit={submit}>
      <div>
        <label className="text-sm font-bold" htmlFor="email">
          Email
        </label>
        <input
          id="email"
          className="input mt-1"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          autoComplete={mode === "login" ? "username" : "email"}
          required
        />
      </div>
      <div>
        <label className="text-sm font-bold" htmlFor="password">
          Password
        </label>
        <input
          id="password"
          className="input mt-1"
          type="password"
          minLength={8}
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

function safeNextPath(value: string | null) {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "";
  return value;
}

function authErrorMessage(message: string) {
  if (/database error|querying schema|finding users/i.test(message)) {
    return "Supabase is temporarily unable to reach the database. Please try again after the database comes back online.";
  }
  return message;
}
