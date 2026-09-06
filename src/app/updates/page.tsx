import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, BellRing, ExternalLink, Rss } from "lucide-react";
import { ChangeSummaryDisplay } from "@/components/change-summary-display";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { pageTypeLabel } from "@/lib/award-discovery-types";
import type { LiveUpdateItem } from "@/lib/live-updates";
import { liveUpdateAwardHref } from "@/lib/public-award-links";
import { loadPublicUpdateFeed, publicUpdateFeedNotice } from "@/lib/public-update-feed";
import { PUBLIC_DIGEST_DESCRIPTION, PUBLIC_DIGEST_LABEL, publicDigestStatusMessage, type PublicDigestStatusParams } from "@/lib/public-digest-copy";
import { centralDateKey, formatCentralDate, previousCentralDateKey } from "@/lib/time-zone";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Live Fellowship Updates | AwardPing",
  description:
    "A public, chronological feed of plain-English changes detected on nationally competitive fellowship and scholarship source pages.",
};

type Props = {
  searchParams: Promise<PublicDigestStatusParams>;
};

export default async function UpdatesPage({ searchParams }: Props) {
  const params = await searchParams;
  const statusMessage = publicDigestStatusMessage(params);
  // One clock reading per render: every relative label and day heading agrees.
  const now = new Date();
  const feed = await loadPublicUpdateFeed(80, now);

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
            <h2>{PUBLIC_DIGEST_LABEL}</h2>
            <p>{PUBLIC_DIGEST_DESCRIPTION}</p>
            <Link className="button-primary" href="/updates/subscribe">
              Subscribe
              <ArrowRight size={16} aria-hidden="true" />
            </Link>
          </div>
        </section>

        {statusMessage && (
          <div role="status" className="mt-5 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4 text-sm font-semibold text-[var(--brand-dark)] shadow-[var(--shadow-md)]">
            {statusMessage}
          </div>
        )}

        <section className="public-live-feed" aria-label="Live award updates">
          <div className="public-live-feed-heading">
            <div>
              <p className="page-kicker">Chronological feed</p>
              <h2>Latest source-page changes</h2>
              <p className="mt-1 text-sm font-medium text-[var(--text-tertiary)]">Dates use Central Time.</p>
            </div>
            <Link className="button-secondary" href="/award-directory" prefetch={false}>
              Award Directory
              <ArrowRight size={16} aria-hidden="true" />
            </Link>
          </div>

          <div className="public-live-feed-list">
            {feed.status === "ready" && groupUpdatesByDay(feed.updates, now).map((group, groupIndex) => (
              <section className="public-live-day" key={`${group.key}-${groupIndex}`}>
                <h3 className="public-live-day-label">{group.label}</h3>
                <div className="public-live-day-list">
                  {group.items.map((update) => {
                    // The award link carries the exact source and change so the
                    // award workspace opens on this update, not the overview.
                    const awardHref = liveUpdateAwardHref(update);
              return (
                <article className="public-live-update-row" key={update.id}>
                  <div className="public-live-update-time">
                    <span>
                      {update.detectedDateTime ? (
                        <time dateTime={update.detectedDateTime} title={update.detectedTitle}>
                          {update.detectedLabel}
                          <span className="sr-only"> ({update.detectedTitle})</span>
                        </time>
                      ) : (
                        update.detectedLabel
                      )}
                    </span>
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

            {feed.status !== "ready" && (
              <div className="public-live-feed-empty">{publicUpdateFeedNotice(feed)}</div>
            )}
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}

// Groups by Central calendar day using the same clock reading as the row
// labels. Yesterday is the previous calendar key, not 24 hours earlier, so
// DST transitions never mislabel a day. Items without a readable timestamp
// sort last under their own heading.
function groupUpdatesByDay(updates: LiveUpdateItem[], now: Date) {
  const todayKey = centralDateKey(now);
  const yesterdayKey = previousCentralDateKey(todayKey);
  const detectedTime = (value: string) => {
    const time = Date.parse(value);
    return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
  };

  const groups: Array<{ key: string; label: string; items: LiveUpdateItem[] }> = [];
  const ordered = [...updates].sort(
    (a, b) => detectedTime(b.detectedAt) - detectedTime(a.detectedAt),
  );
  for (const update of ordered) {
    const key = centralDateKey(update.detectedAt);
    const current = groups[groups.length - 1];
    if (current && current.key === key) {
      current.items.push(update);
      continue;
    }
    const label =
      key === ""
        ? "Undated"
        : key === todayKey
          ? "Today"
          : key === yesterdayKey
            ? "Yesterday"
            : formatCentralDate(update.detectedAt, { month: "long", day: "numeric", year: "numeric" });
    groups.push({ key, label, items: [update] });
  }
  return groups;
}
