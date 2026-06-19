import Link from "next/link";
import { ArrowRight, Bell, FileText, ShieldCheck, Timer } from "lucide-react";
import { ChangeTicker, type ChangeTickerItem } from "@/components/change-ticker";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { getCurrentUser } from "@/lib/auth";
import { hasSupabaseAdminConfig } from "@/lib/config";
import type { Database } from "@/lib/database.types";
import {
  dedupeChangeSummaries,
  displayChangeSummary,
  isUsefulChangeSummary,
} from "@/lib/change-summary";
import { isMonitorableOfficialSource } from "@/lib/source-url-policy";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

type SharedAwardRow = Pick<Database["public"]["Tables"]["shared_awards"]["Row"], "id" | "name">;
type SharedChangeRow = Pick<
  Database["public"]["Tables"]["shared_award_change_events"]["Row"],
  | "id"
  | "shared_award_id"
  | "source_title"
  | "source_url"
  | "source_page_type"
  | "summary"
  | "change_details"
  | "detected_at"
>;

const useCases = [
  "National deadlines",
  "Eligibility updates",
  "PDF award guides",
  "Application instructions",
  "Official deadline lists",
  "Source page history",
];

const awardExamples = [
  "Goldwater",
  "Marshall",
  "Truman",
  "Gates Cambridge",
  "Udall",
  "NSF GRFP",
  "Rhodes",
  "Fulbright",
];

export default async function Home() {
  const [tickerItems, user] = await Promise.all([getTickerItems(), getCurrentUser()]);

  return (
    <div className="page-shell">
      <SiteHeader />
      <main>
        <section className="mx-auto max-w-6xl px-5 pb-10 pt-12 lg:pb-12 lg:pt-16">
          <div className="mx-auto max-w-5xl text-center">
            <h1 className="text-4xl font-black leading-[0.98] md:text-6xl lg:text-7xl">
              Never miss an <span className="home-hero-emphasis">update.</span>
            </h1>
            <p className="mx-auto mt-4 max-w-2xl text-base leading-7 text-[var(--muted)] md:text-lg md:leading-8">
              AwardPing checks official nationally competitive award pages for
              deadline, eligibility, application instruction, and PDF updates.
            </p>
            <div className="mt-6 flex flex-col justify-center gap-3 sm:flex-row">
              <Link className="button-primary" href={user ? "/dashboard" : "/signup"}>
                {user ? "Open dashboard" : "Sign up for free"}
                <ArrowRight size={17} aria-hidden="true" />
              </Link>
              <Link className="button-secondary" href="/award-directory">
                Find exact pages
              </Link>
            </div>
            <div className="hero-proof-strip" aria-label="AwardPing checks">
              {["Official source pages", "Plain-English updates", "Personal watchlists"].map((item) => (
                <p className="hero-proof-item" key={item}>
                  <span className="hero-proof-dot" aria-hidden="true" />
                  {item}
                </p>
              ))}
            </div>
          </div>
        </section>

        <ChangeTicker items={tickerItems} />

        <section className="home-feature-band border-y border-[var(--line)]">
          <div className="mx-auto grid max-w-6xl gap-4 px-5 py-12 md:grid-cols-3">
            {[
              {
                icon: Timer,
                title: "Source-first checks",
                text: "Watch official award page text for deadline, eligibility, and instruction updates.",
              },
              {
                icon: FileText,
                title: "PDF award guides",
                text: "Track public prospectuses, application guides, rubrics, and forms.",
              },
              {
                icon: Bell,
                title: "Advisor-ready alerts",
                text: "Hourly scheduled checks are included for free, with simple update history for follow-up.",
              },
            ].map((item, index) => {
              const Icon = item.icon;
              return (
                <div className="card home-feature-card rounded-[1.6rem] p-6" key={item.title}>
                  <div className="flex items-center justify-between gap-4">
                    <Icon className="home-feature-icon" size={24} aria-hidden="true" />
                    <span className="text-sm font-black text-[var(--muted)]">
                      0{index + 1}
                    </span>
                  </div>
                  <h2 className="mt-5 text-xl font-black">{item.title}</h2>
                  <p className="mt-2 text-sm leading-6 text-[var(--muted)]">
                    {item.text}
                  </p>
                </div>
              );
            })}
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-5 py-16">
          <div className="grid gap-10 lg:grid-cols-[0.78fr_1.22fr]">
            <div>
              <span className="badge">Exact-source strategy</span>
              <h2 className="mt-5 text-4xl font-black md:text-5xl">
                Built around nationally competitive award workflows.
              </h2>
              <p className="mt-4 text-[var(--muted)]">
                Directory cards are useful starting points, but the watchlist
                should track the exact official page that updates: deadline
                pages, application instructions, eligibility pages, and PDF
                guides.
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {useCases.map((useCase) => (
                <div className="home-workflow-card flex min-h-20 items-center gap-3 rounded-2xl border border-[var(--line)] bg-white p-4 shadow-[0_18px_45px_rgba(22,34,74,0.05)]" key={useCase}>
                  <span className="home-workflow-icon flex h-9 w-9 shrink-0 items-center justify-center rounded-full">
                    <ShieldCheck size={18} aria-hidden="true" />
                  </span>
                  <span className="font-bold">{useCase}</span>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="home-office-section">
          <div className="mx-auto grid max-w-6xl gap-8 px-5 py-14 lg:grid-cols-[0.95fr_1.05fr]">
            <div>
              <span className="inline-flex rounded-full border border-[var(--line)] bg-white/[0.62] px-3 py-1 text-sm font-bold text-[var(--foreground)]">
                For award offices
              </span>
              <h2 className="mt-5 text-4xl font-black md:text-5xl">
                Track the pages that update quietly.
              </h2>
              <p className="mt-4 leading-7 text-[var(--muted)]">
                National award pages, application instructions, official award
                directories, and PDF guides update throughout the year. AwardPing
                gives students and advisors a shared early-warning system for
                public updates.
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {awardExamples.map((award) => (
                <div
                  className="home-award-chip rounded-2xl border border-white/70 bg-white/[0.58] p-4 font-bold text-[var(--foreground)]"
                  key={award}
                >
                  {award}
                </div>
              ))}
            </div>
          </div>
        </section>

      </main>
      <SiteFooter />
    </div>
  );
}

async function getTickerItems(): Promise<ChangeTickerItem[]> {
  if (!hasSupabaseAdminConfig()) return [];

  const admin = createSupabaseAdminClient();
  const { data: changes } = await admin
    .from("shared_award_change_events")
    .select("id, shared_award_id, source_title, source_url, source_page_type, summary, change_details, detected_at")
    .order("detected_at", { ascending: false })
    .limit(50);

  if (!changes || changes.length === 0) return [];

  const usefulChanges = dedupeChangeSummaries(
    (changes as SharedChangeRow[]).filter(
      (change) =>
        isUsefulTickerSummary(change.summary, change.change_details) &&
        isMonitorableOfficialSource({ url: change.source_url, page_type: change.source_page_type }),
    ),
  )
    .slice(0, 8);
  if (usefulChanges.length === 0) return [];

  const awardIds = [
    ...new Set(usefulChanges.map((change) => change.shared_award_id).filter(Boolean)),
  ];
  const { data: awards } = awardIds.length
    ? await admin.from("shared_awards").select("id, name").in("id", awardIds)
    : { data: [] as SharedAwardRow[] };
  const awardNameById = new Map((awards || []).map((award) => [award.id, award.name]));

  return usefulChanges.map((change) => ({
    id: change.id,
    awardName: awardNameById.get(change.shared_award_id) || "Tracked award",
    sourceTitle: change.source_title || "Source page",
    sourceUrl: change.source_url,
    summary: displayChangeSummary(change.summary, change.source_url, change.change_details),
    detectedLabel: formatTickerDate(change.detected_at),
  }));
}

function isUsefulTickerSummary(summary: string, changeDetails?: unknown) {
  return isUsefulChangeSummary(summary, changeDetails);
}

function formatTickerDate(value: string) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}
