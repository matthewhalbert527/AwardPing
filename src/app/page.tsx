import Link from "next/link";
import { ArrowRight, BellRing } from "lucide-react";
import { PublicUpdateCard } from "@/components/public-update-card";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { loadPublicUpdateFeed, publicUpdateFeedNotice } from "@/lib/public-update-feed";

export const dynamic = "force-dynamic";

export default async function Home() {
  // Keep the homepage on the same public feed and clock as the Updates page.
  const now = new Date();
  const feed = await loadPublicUpdateFeed(8, now);

  return (
    <div className="page-shell">
      <SiteHeader />
      <main className="public-updates-main">
        <div className="public-page-heading">
          <div>
            <h1 className="display-title">Keep up with award changes.</h1>
            <p>Changes to deadlines, eligibility, and applications from official award pages.</p>
          </div>
          <div className="public-page-actions">
            <Link className="button-primary" href="/award-directory" prefetch={false}>
              Browse awards
              <ArrowRight size={17} aria-hidden="true" />
            </Link>
            <Link className="button-secondary" href="/updates/subscribe">
              <BellRing size={16} aria-hidden="true" />
              Get daily emails
            </Link>
          </div>
        </div>

        <section className="public-live-feed" aria-label="Live award update preview">
          <div className="public-section-heading">
            <h2>Latest updates</h2>
            <Link className="public-live-update-detail-link" href="/updates">
              View all updates
              <ArrowRight size={15} aria-hidden="true" />
            </Link>
          </div>
          <p className="public-live-feed-note">Dates use Central Time.</p>
          <div className="public-live-day-list">
            {feed.status === "ready" ? (
              feed.updates.slice(0, 5).map((update) => (
                <PublicUpdateCard update={update} key={update.id} />
              ))
            ) : (
              <div className="public-live-feed-empty">{publicUpdateFeedNotice(feed)}</div>
            )}
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
