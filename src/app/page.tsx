import Link from "next/link";
import {
  ArrowRight,
  Bell,
  Eye,
  FileWarning,
  ListChecks,
  SearchCheck,
} from "lucide-react";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { getCurrentUser } from "@/lib/auth";
import { canonicalAwardPath } from "@/lib/award-slugs";
import { hasSupabaseAdminConfig } from "@/lib/config";
import { getLiveUpdateItems, type LiveUpdateItem } from "@/lib/live-updates";
import { signedInLandingLabel, signedInLandingPath } from "@/lib/navigation";

export const dynamic = "force-dynamic";

const whyItMatters = [
  {
    icon: Eye,
    title: "Manual re-reading",
    text: "Award pages change quietly. AwardPing keeps checking the source pages that offices and applicants would otherwise reread by hand.",
  },
  {
    icon: ListChecks,
    title: "Hidden prerequisites",
    text: "Eligibility, citizenship, nomination, essay, and transcript language can move inside accordions, PDFs, and secondary pages.",
  },
  {
    icon: FileWarning,
    title: "Broken or moved links",
    text: "Application portals, PDFs, and official instructions are tracked as source pages so failures surface quickly.",
  },
];

const journeys = [
  { label: "Live Update Feed", href: "/updates", text: "Chronological plain-English changes." },
  { label: "Award Directory", href: "/award-directory", text: "Search and filter public award records." },
  { label: "Daily Digest", href: "/updates/subscribe", text: "Quiet email updates when useful changes appear." },
];

export default async function Home() {
  const [user, updates] = await Promise.all([
    getCurrentUser(),
    hasSupabaseAdminConfig() ? getLiveUpdateItems(8) : Promise.resolve([]),
  ]);

  return (
    <div className="page-shell">
      <SiteHeader />
      <main>
        <section className="home-terminal-hero mx-auto grid max-w-6xl gap-8 px-5 py-12 lg:grid-cols-[0.9fr_1.1fr] lg:items-center lg:py-16">
          <div>
            <span className="badge">
              <Bell size={15} aria-hidden="true" />
              National fellowship monitoring
            </span>
            <h1 className="display-title mt-5 max-w-[15ch] text-4xl leading-[1.06] md:text-[3.5rem]">
              The early-warning system for nationally competitive fellowships.
            </h1>
            <p className="mt-5 max-w-[46ch] text-base leading-7 text-[var(--text-secondary)] md:text-[1.05rem] md:leading-8">
              AwardPing watches official award pages, PDFs, deadline lists, and
              application instructions, then turns meaningful changes into
              plain-English updates.
            </p>
            <div className="mt-7 flex flex-col gap-3 sm:flex-row">
              <Link className="button-primary" href={user ? signedInLandingPath() : "/contact"}>
                {user ? signedInLandingLabel() : "Get in touch"}
                <ArrowRight size={17} aria-hidden="true" />
              </Link>
              <Link className="button-secondary" href="/updates">
                View live updates
                <SearchCheck size={17} aria-hidden="true" />
              </Link>
            </div>
          </div>

          <LiveTerminalPreview updates={updates} />
        </section>

        <section className="home-journey-band border-y border-[var(--line)]">
          <div className="mx-auto grid max-w-6xl gap-3 px-5 py-8 md:grid-cols-4">
            {journeys.map((journey) => (
              <Link
                className="home-journey-card"
                href={journey.href}
                key={journey.label}
                prefetch={journey.href === "/award-directory" ? false : undefined}
              >
                <span>{journey.label}</span>
                <p>{journey.text}</p>
              </Link>
            ))}
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-5 py-14">
          <div className="mb-6 max-w-2xl">
            <p className="page-kicker">Why it matters</p>
            <h2 className="display-title mt-2 max-w-[26ch] text-3xl leading-[1.12] md:text-[2.4rem]">
              Award updates are usually small, buried, and easy to miss.
            </h2>
          </div>
          <div className="home-matrix-grid">
            {whyItMatters.map((item) => {
              const Icon = item.icon;
              return (
                <article className="home-matrix-card" key={item.title}>
                  <Icon size={22} aria-hidden="true" />
                  <h3>{item.title}</h3>
                  <p>{item.text}</p>
                </article>
              );
            })}
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}

function LiveTerminalPreview({ updates }: { updates: LiveUpdateItem[] }) {
  return (
    <aside className="home-live-terminal" aria-label="Live award update preview">
      <div className="home-live-terminal-top">
        <div>
          <span />
          <span />
          <span />
        </div>
        <strong>Live Update Feed</strong>
      </div>
      <div className="home-live-terminal-list">
        {updates.length ? (
          updates.slice(0, 5).map((update) => (
            <Link
              className="home-live-terminal-row"
              href={canonicalAwardPath(update.awardSlug, update.awardName, update.awardId)}
              key={update.id}
            >
              <span>{update.detectedLabel}</span>
              <strong>{update.awardName}</strong>
              <p>{update.summary}</p>
            </Link>
          ))
        ) : (
          <div className="home-live-terminal-empty">
            Live update data will appear after the next scan.
          </div>
        )}
      </div>
      <Link className="home-live-terminal-footer" href="/updates">
        Open full feed
        <ArrowRight size={16} aria-hidden="true" />
      </Link>
    </aside>
  );
}
