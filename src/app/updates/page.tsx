import type { Metadata } from "next";
import { BellRing, CheckCircle2 } from "lucide-react";
import { PublicUpdatesForm } from "@/components/public-updates-form";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

export const metadata: Metadata = {
  title: "Daily Award Updates",
  description:
    "Subscribe to public daily AwardPing emails when useful nationally competitive award-page updates are detected.",
};

type Props = {
  searchParams: Promise<{ confirmed?: string; unsubscribed?: string }>;
};

export default async function UpdatesPage({ searchParams }: Props) {
  const params = await searchParams;
  const statusMessage = updatesStatusMessage(params);

  return (
    <div className="page-shell">
      <SiteHeader />
      <main>
        <section className="mx-auto grid max-w-6xl gap-10 px-5 py-16 lg:grid-cols-[0.9fr_1.1fr]">
          <div>
            <span className="badge">
              <BellRing size={15} aria-hidden="true" />
              Daily updates
            </span>
            <h1 className="mt-5 text-5xl font-black leading-tight">
              Public award-page updates, once per useful day.
            </h1>
            <p className="mt-5 text-lg leading-8 text-[var(--muted)]">
              Get a daily email only when AwardPing detects useful changes on
              public nationally competitive award source pages. Quiet days stay quiet.
            </p>
            <div className="mt-6 grid gap-3 text-sm font-bold text-[#30384a]">
              {[
                "Double opt-in confirmation before mail starts",
                "Official source-page changes, not product marketing",
                "Unsubscribe link in every public digest",
              ].map((item) => (
                <p className="flex items-center gap-2" key={item}>
                  <CheckCircle2 className="text-[var(--brand)]" size={18} aria-hidden="true" />
                  {item}
                </p>
              ))}
            </div>
          </div>

          <div>
            {statusMessage && (
              <div className="mb-4 rounded-2xl border border-[var(--line)] bg-white p-4 text-sm font-semibold text-[var(--brand-dark)] shadow-[0_18px_45px_rgba(22,34,74,0.05)]">
                {statusMessage}
              </div>
            )}
            <PublicUpdatesForm />
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}

function updatesStatusMessage(params: { confirmed?: string; unsubscribed?: string }) {
  if (params.confirmed === "1") return "Your daily AwardPing updates are confirmed.";
  if (params.confirmed === "invalid") return "That confirmation link is no longer valid.";
  if (params.unsubscribed === "1") return "You have been unsubscribed from public daily updates.";
  if (params.unsubscribed === "invalid") return "That unsubscribe link is no longer valid.";
  return "";
}
