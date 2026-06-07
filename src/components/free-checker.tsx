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
    <div className="card rounded-3xl p-4 sm:p-6">
      <form className="flex flex-col gap-3 md:flex-row" onSubmit={submit}>
        <label className="sr-only" htmlFor="url-check">
          URL to check
        </label>
        <input
          id="url-check"
          className="input"
          placeholder="https://official-award-site.org/deadline"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          required
        />
        <button className="button-primary md:w-44" type="submit" disabled={loading}>
          {loading ? (
            <Loader2 className="animate-spin" size={17} aria-hidden="true" />
          ) : (
            <Search size={17} aria-hidden="true" />
          )}
          Check URL
        </button>
      </form>

      {result && (
        <div className="mt-5 rounded-2xl border border-[var(--line)] bg-[var(--brand-blue-soft)] p-4">
          {result.ok ? (
            <div>
              <p className="text-sm font-black text-[var(--brand)]">
                This exact award source has readable content.
              </p>
              <p className="mt-2 text-sm text-[var(--muted)]">
                {result.contentType || "Unknown content type"} -{" "}
                {Intl.NumberFormat().format(result.byteLength)} bytes
              </p>
              <p className="mt-3 line-clamp-4 text-sm leading-6 text-[var(--foreground)]">
                {result.sample}
              </p>
            </div>
          ) : (
            <p className="text-sm font-semibold text-[var(--foreground)]">{result.error}</p>
          )}
        </div>
      )}
    </div>
  );
}
