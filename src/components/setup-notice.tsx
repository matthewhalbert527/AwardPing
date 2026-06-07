import { Terminal } from "lucide-react";

export function SetupNotice() {
  return (
    <div className="card rounded-2xl p-6">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--brand-blue-soft)] text-[var(--brand)]">
          <Terminal size={20} aria-hidden="true" />
        </span>
        <div>
          <h2 className="text-xl font-black">Environment setup needed</h2>
          <p className="mt-2 text-sm leading-6 text-[var(--muted)]">
            Add Supabase, Resend, Tavily, Gemini or OpenAI, and cron values to
            `.env.local` using `.env.example`, then restart the dev server.
          </p>
        </div>
      </div>
    </div>
  );
}
