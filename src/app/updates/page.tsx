import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, BellRing, ExternalLink, Rss } from "lucide-react";
import { ChangeSummaryDisplay } from "@/components/change-summary-display";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { pageTypeLabel } from "@/lib/award-discovery-types";
import { canonicalAwardPath } from "@/lib/award-slugs";
import { hasSupabaseAdminConfig } from "@/lib/config";
import { getLiveUpdateItems, type LiveUpdateItem } from "@/lib/live-updates";

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
  let updateLoadError = "";
  let updates: Awaited<ReturnType<typeof getLiveUpdateItems>> = [];

  if (hasSupabaseAdminConfig()) {
    try {
      updates = await getLiveUpdateItems(80);
    } catch (error) {
      updateLoadError = error instanceof Error ? error.message : "Live updates could not be loaded.";
      console.error(updateLoadError);
    }
  }

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
            <h1 className="display-title mt-5 max-w-[18ch] text-4xl leading-[1.06] md:text-[3.1rem]">
              Plain-English award changes as they are found.
            </h1>
            <p className="mt-5 max-w-[56ch] text-base leading-7 text-[var(--text-secondary)] md:text-[1.05rem] md:leading-8">
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
          <div className="mt-5 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4 text-sm font-semibold text-[var(--brand-dark)] shadow-[var(--shadow-md)]">
            {statusMessage}
          </div>
        )}

        {updateLoadError && (
          <div className="mt-5 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4 text-sm font-semibold text-[var(--brand-dark)] shadow-[var(--shadow-md)]">
            Live updates could not be loaded from Supabase right now. The feed is temporarily unavailable, not confirmed empty.
          </div>
        )}

        <section className="public-live-feed" aria-label="Live award updates">
          <div className="public-live-feed-heading">
            <div>
              <p className="page-kicker">Chronological feed</p>
              <h2>Latest source-page changes</h2>
            </div>
            <Link className="button-secondary" href="/award-directory" prefetch={false}>
              Award Directory
              <ArrowRight size={16} aria-hidden="true" />
            </Link>
          </div>

          <div className="public-live-feed-list">
            {groupUpdatesByDay(updates).map((group, groupIndex) => (
              <section className="public-live-day" key={`${group.key}-${groupIndex}`}>
                <h3 className="public-live-day-label">{group.label}</h3>
                <div className="public-live-day-list">
                  {group.items.map((update) => {
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
                </div>
              </section>
            ))}

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

function groupUpdatesByDay(updates: LiveUpdateItem[]) {
  const dayFormatter = new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "America/Chicago",
  });
  const keyFor = (value: string) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date(value));
  const todayKey = keyFor(new Date().toISOString());
  const yesterdayKey = keyFor(new Date(Date.now() - 86_400_000).toISOString());

  const groups: Array<{ key: string; label: string; items: LiveUpdateItem[] }> = [];
  const ordered = [...updates].sort(
    (a, b) => Date.parse(b.detectedAt) - Date.parse(a.detectedAt),
  );
  for (const update of ordered) {
    const key = keyFor(update.detectedAt);
    const current = groups[groups.length - 1];
    if (current && current.key === key) {
      current.items.push(update);
      continue;
    }
    const label =
      key === todayKey ? "Today" : key === yesterdayKey ? "Yesterday" : dayFormatter.format(new Date(update.detectedAt));
    groups.push({ key, label, items: [update] });
  }
  return groups;
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
