import type { Metadata } from "next";
import { BellRing, CheckCircle2 } from "lucide-react";
import { PublicUpdatesForm } from "@/components/public-updates-form";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { PUBLIC_DIGEST_DESCRIPTION, PUBLIC_DIGEST_LABEL, publicDigestStatusMessage, type PublicDigestStatusParams } from "@/lib/public-digest-copy";

export const metadata: Metadata = {
  title: "Daily digest | AwardPing",
  description:
    "Subscribe to public daily AwardPing emails when useful nationally competitive award-page updates are detected.",
};

type Props = {
  searchParams: Promise<PublicDigestStatusParams>;
};

export default async function UpdatesSubscribePage({ searchParams }: Props) {
  const params = await searchParams;
  const statusMessage = publicDigestStatusMessage(params);

  return (
    <div className="page-shell">
      <SiteHeader />
      <main>
        <section className="mx-auto grid max-w-6xl gap-6 px-5 py-10 lg:grid-cols-[0.82fr_1.18fr] lg:items-start lg:py-14">
          <div>
            <span className="badge">
              <BellRing size={15} aria-hidden="true" />
              {PUBLIC_DIGEST_LABEL}
            </span>
            <h1 className="display-title mt-4 text-4xl leading-[1.06] md:text-[2.8rem]">
              Useful award updates by email.
            </h1>
            <p className="mt-3 text-base leading-7 text-[var(--muted)] md:text-lg md:leading-8">
              {PUBLIC_DIGEST_DESCRIPTION}
            </p>
            <div className="mt-4 grid gap-2 text-sm font-bold text-[var(--text-secondary)]">
              {[
                "Confirm your email before the digest starts",
                "Changes from official award pages",
                "Unsubscribe link in every digest",
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
              <div role="status" className="mb-4 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4 text-sm font-semibold text-[var(--brand-dark)] shadow-[var(--shadow-md)]">
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
