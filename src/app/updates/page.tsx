import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, BellRing, ExternalLink, Rss } from "lucide-react";
import { ChangeSummaryDisplay } from "@/components/change-summary-display";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { pageTypeLabel } from "@/lib/award-discovery-types";
import { canonicalAwardPath } from "@/lib/award-slugs";
import { hasSupabaseAdminConfig } from "@/lib/config";
import { getLiveUpdateItems } from "@/lib/live-updates";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Live Fellowship Updates | AwardPing",
  description:
    "A public, chronological feed of plain-English changes detected on nationally competitive fellowship and scholarship source pages.",
};

type Props = {
  searchParams: Promise<{ confirmed?: string; unsubscribed?: string }>;
};

export default async function UpdatesPage({ searchParams }: Props) {
  const params = await searchParams;
  const statusMessage = updatesStatusMessage(params);
  const updates = hasSupabaseAdminConfig() ? await getLiveUpdateItems(80) : [];

  return (
    <div className="page-shell">
      <SiteHeader />
      <main className="mx-auto max-w-6xl px-5 py-10 lg:py-14">
        <section className="public-updates-hero">
          <div>
            <span className="badge">
              <Rss size={15} aria-hidden="true" />
              Live update feed
            </span>
            <h1 className="mt-4 text-4xl font-black leading-tight md:text-6xl">
              Plain-English award changes as they are found.
            </h1>
            <p className="mt-4 max-w-3xl text-base leading-7 text-[var(--muted)] md:text-lg md:leading-8">
              AwardPing watches official fellowship pages, PDFs, deadline lists,
              eligibility pages, and application instructions, then turns meaningful
              changes into a scannable feed.
            </p>
          </div>
          <div className="public-updates-cta">
            <BellRing size={22} aria-hidden="true" />
            <h2>Daily email digest</h2>
            <p>Get a quiet daily email only when useful public updates are detected.</p>
            <Link className="button-primary" href="/updates/subscribe">
              Subscribe
              <ArrowRight size={16} aria-hidden="true" />
            </Link>
          </div>
        </section>

        {statusMessage && (
          <div className="mt-5 rounded-2xl border border-[var(--line)] bg-white p-4 text-sm font-semibold text-[var(--brand-dark)] shadow-[0_18px_45px_rgba(22,34,74,0.05)]">
            {statusMessage}
          </div>
        )}

        <section className="public-live-feed" aria-label="Live award updates">
          <div className="public-live-feed-heading">
            <div>
              <p className="dashboard-label">Chronological feed</p>
              <h2>Latest source-page changes</h2>
            </div>
            <Link className="button-secondary" href="/award-directory" prefetch={false}>
              Award Directory
              <ArrowRight size={16} aria-hidden="true" />
            </Link>
          </div>

          <div className="public-live-feed-list">
            {updates.map((update) => {
              const awardHref = canonicalAwardPath(update.awardSlug, update.awardName, update.awardId);
              return (
                <article className="public-live-update-row" key={update.id}>
                  <div className="public-live-update-time">
                    <span>{update.detectedLabel}</span>
                    <strong>{update.changeTypeLabel}</strong>
                  </div>
                  <div className="min-w-0">
                    <div className="public-live-update-title-row">
                      <Link href={awardHref}>{update.awardName}</Link>
                      {update.sourcePageType && (
                        <span className="badge">{pageTypeLabel(update.sourcePageType)}</span>
                      )}
                    </div>
                    <p className="public-live-update-source">{update.sourceTitle}</p>
                    <ChangeSummaryDisplay
                      compact
                      summary={update.summary}
                      sourceUrl={update.sourceUrl}
                      sourceTitle={update.sourceTitle}
                      changeDetails={update.changeDetails}
                    />
                  </div>
                  <a
                    className="public-live-update-source-link"
                    href={update.sourceUrl}
                    rel="noreferrer"
                    target="_blank"
                    aria-label={`Open ${update.sourceTitle}`}
                  >
                    <ExternalLink size={16} aria-hidden="true" />
                  </a>
                </article>
              );
            })}

            {updates.length === 0 && (
              <div className="public-live-feed-empty">
                No public changes are ready to show yet.
              </div>
            )}
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
