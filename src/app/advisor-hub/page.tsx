import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowRight,
  BellRing,
  ClipboardCheck,
  History,
  ListChecks,
  SearchCheck,
  Users,
} from "lucide-react";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { getCurrentUser } from "@/lib/auth";

export const metadata: Metadata = {
  title: "Advisor Hub | AwardPing",
  description:
    "AwardPing workflows for fellowship advisors: custom watchlists, daily alerts, cohort advising, source-page history, and early-warning checks.",
};

const workflowCards = [
  {
    icon: ListChecks,
    title: "Custom watchlists",
    text: "Track the fellowships your office actively advises and keep broad discovery separate from student-facing updates.",
  },
  {
    icon: Users,
    title: "Cohort advising",
    text: "Use shared update history to brief students, flag deadlines, and coordinate office follow-up.",
  },
  {
    icon: BellRing,
    title: "Daily alerts",
    text: "See meaningful source-page changes without manually rereading the same public pages every week.",
  },
  {
    icon: History,
    title: "Source-page history",
    text: "Review the official page, PDF, or application guide that changed and compare it with the previous snapshot.",
  },
];

const useCases = [
  "A deadline page quietly moves from last year's cycle to this year's date.",
  "An application PDF changes required materials or recommendation wording.",
  "An eligibility page adds citizenship, degree-level, GPA, or nomination language.",
  "A source URL breaks, redirects, or gets replaced with a new application portal.",
];

export default async function AdvisorHubPage() {
  const user = await getCurrentUser();

  return (
    <div className="page-shell">
      <SiteHeader />
      <main>
        <section className="advisor-hero mx-auto grid max-w-6xl gap-8 px-5 py-12 lg:grid-cols-[0.95fr_1.05fr] lg:items-center lg:py-16">
          <div>
            <span className="badge">
              <ClipboardCheck size={15} aria-hidden="true" />
              Advisor Hub
            </span>
            <h1 className="mt-4 text-4xl font-black leading-tight md:text-6xl">
              A shared early-warning desk for fellowship advising.
            </h1>
            <p className="mt-4 max-w-2xl text-base leading-7 text-[var(--muted)] md:text-lg md:leading-8">
              AwardPing helps university staff watch the public source pages that
              matter: deadlines, eligibility rules, application instructions,
              PDF guides, and portal links.
            </p>
            <div className="mt-6 flex flex-col gap-3 sm:flex-row">
              <Link className="button-primary" href={user ? "/dashboard" : "/signup"}>
                {user ? "Open dashboard" : "Start a watchlist"}
                <ArrowRight size={17} aria-hidden="true" />
              </Link>
              <Link className="button-secondary" href="/award-directory" prefetch={false}>
                Search awards
                <SearchCheck size={17} aria-hidden="true" />
              </Link>
            </div>
          </div>

          <div className="advisor-terminal" aria-label="Advisor update examples">
            <div className="advisor-terminal-header">
              <span />
              <span />
              <span />
            </div>
            <div className="advisor-terminal-list">
              {useCases.map((useCase, index) => (
                <p key={useCase}>
                  <strong>0{index + 1}</strong>
                  {useCase}
                </p>
              ))}
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-5 pb-16">
          <div className="advisor-workflow-grid">
            {workflowCards.map((card) => {
              const Icon = card.icon;
              return (
                <article className="advisor-workflow-card" key={card.title}>
                  <Icon size={22} aria-hidden="true" />
                  <h2>{card.title}</h2>
                  <p>{card.text}</p>
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
