import type { Metadata } from "next";
import Link from "next/link";
import { BellRing } from "lucide-react";
import { PublicUpdateCard } from "@/components/public-update-card";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import type { LiveUpdateItem } from "@/lib/live-updates";
import { loadPublicUpdateFeed, publicUpdateFeedNotice } from "@/lib/public-update-feed";
import { publicDigestStatusMessage, type PublicDigestStatusParams } from "@/lib/public-digest-copy";
import { centralDateKey, formatCentralDate, previousCentralDateKey } from "@/lib/time-zone";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Live Fellowship Updates",
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
      <main className="public-updates-main">
        <div className="public-updates-heading">
          <div>
            <h1 className="display-title">Award updates</h1>
            <p>Latest changes found on official award pages.</p>
          </div>
          <Link className="button-secondary" href="/updates/subscribe">
            <BellRing size={16} aria-hidden="true" />
            Get daily emails
          </Link>
        </div>

        {statusMessage && (
          <div role="status" className="mt-5 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4 text-sm font-semibold text-[var(--brand-dark)] shadow-[var(--shadow-md)]">
            {statusMessage}
          </div>
        )}

        <section className="public-live-feed" aria-label="Live award updates">
          <p className="public-live-feed-note">Newest first. Dates use Central Time.</p>

          <div className="public-live-feed-list">
            {feed.status === "ready" && groupUpdatesByDay(feed.updates, now).map((group, groupIndex) => (
              <section className="public-live-day" key={`${group.key}-${groupIndex}`}>
                <h2 className="public-live-day-label">{group.label}</h2>
                <div className="public-live-day-list">
                  {group.items.map((update) => (
                    <PublicUpdateCard update={update} key={update.id} />
                  ))}
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
