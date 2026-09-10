import type { Metadata } from "next";
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
      <main className="public-page-main public-page-main-narrow">
        <header className="public-page-heading">
          <h1>{PUBLIC_DIGEST_LABEL}</h1>
          <p>{PUBLIC_DIGEST_DESCRIPTION}</p>
        </header>
        {statusMessage && (
          <div role="status" className="mb-4 rounded-xl border border-[var(--line)] bg-[var(--surface)] p-4 text-sm font-semibold text-[var(--brand-dark)]">
            {statusMessage}
          </div>
        )}
        <PublicUpdatesForm />
        <p className="mt-4 text-sm leading-6 text-[var(--muted)]">
          Confirm your email before the digest starts. Every digest includes an unsubscribe link.
        </p>
      </main>
      <SiteFooter />
    </div>
  );
}
