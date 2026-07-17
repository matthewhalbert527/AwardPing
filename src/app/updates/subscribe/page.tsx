import type { Metadata } from "next";
import { BellRing, CheckCircle2 } from "lucide-react";
import { PublicUpdatesForm } from "@/components/public-updates-form";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

export const metadata: Metadata = {
  title: "Subscribe to Award Updates | AwardPing",
  description:
    "Subscribe to public daily AwardPing emails when useful nationally competitive award-page updates are detected.",
};

type Props = {
  searchParams: Promise<{ confirmed?: string; unsubscribed?: string }>;
};

export default async function UpdatesSubscribePage({ searchParams }: Props) {
  const params = await searchParams;
  const statusMessage = updatesStatusMessage(params);

  return (
    <div className="page-shell">
      <SiteHeader />
      <main>
        <section className="mx-auto grid max-w-6xl gap-6 px-5 py-10 lg:grid-cols-[0.82fr_1.18fr] lg:items-start lg:py-14">
          <div>
            <span className="badge">
              <BellRing size={15} aria-hidden="true" />
              Daily updates
            </span>
            <h1 className="mt-4 text-4xl font-black leading-tight md:text-5xl">
              Useful award updates by email.
            </h1>
            <p className="mt-3 text-base leading-7 text-[var(--muted)] md:text-lg md:leading-8">
              Get a daily email only when AwardPing detects useful changes on
              public nationally competitive award source pages. Quiet days stay quiet.
            </p>
            <div className="mt-4 grid gap-2 text-sm font-bold text-[#30384a]">
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
  if (params.unsubscribed === "retry") {
    return "A daily update is already being sent. Please use the unsubscribe link again in a few minutes.";
  }
  if (params.unsubscribed === "invalid") return "That unsubscribe link is no longer valid.";
  return "";
}
