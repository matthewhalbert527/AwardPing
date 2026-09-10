"use client";

import { useState } from "react";
import { Search, Loader2 } from "lucide-react";

type CheckResult =
  | { ok: true; hash: string; sample: string; contentType: string; byteLength: number }
  | { ok: false; error: string };

export function FreeChecker() {
  const [url, setUrl] = useState("");
  const [result, setResult] = useState<CheckResult | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setResult(null);

    try {
      const response = await fetch("/api/check", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url }),
      });
      setResult(await response.json());
    } catch {
      setResult({ ok: false, error: "The check failed. Try another URL." });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="card rounded-2xl p-5 sm:p-6">
      <form className="grid gap-3" onSubmit={submit} aria-busy={loading}>
        <label className="text-sm font-bold" htmlFor="url-check">
          Page URL
        </label>
        <div className="flex flex-col gap-3 sm:flex-row">
          <input
            id="url-check"
            className="input min-w-0"
            type="url"
            placeholder="https://example.org/award"
            aria-describedby="url-check-scope"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            required
          />
          <button className="button-primary shrink-0" type="submit" disabled={loading}>
            {loading ? (
              <Loader2 className="animate-spin" size={17} aria-hidden="true" />
            ) : (
              <Search size={17} aria-hidden="true" />
            )}
            {loading ? "Checking…" : "Check URL"}
          </button>
        </div>
      </form>
      <p id="url-check-scope" className="mt-3 text-sm leading-6 text-[var(--muted)]">
        This checks readable content only. It does not verify that a page is official or start monitoring it.
      </p>
      <p role="status" aria-live="polite" aria-atomic="true" className="mt-4 text-sm font-semibold text-[var(--foreground)]">
        {loading ? "Checking the page…" : result ? (
          result.ok
            ? result.sample.trim() ? "This page has readable content." : "No readable text was returned for this page."
            : result.error
        ) : null}
      </p>
      {result?.ok && result.sample.trim() ? (
        <details className="mt-3 border-t border-[var(--line)] pt-3">
          <summary className="cursor-pointer text-sm font-bold">View readable text</summary>
          <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-6 text-[var(--foreground)]">
            {result.sample}
          </p>
        </details>
      ) : null}
    </div>
  );
}
