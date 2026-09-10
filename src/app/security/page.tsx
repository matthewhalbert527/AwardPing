import type { Metadata } from "next";
import Link from "next/link";
import {
  CheckCircle2,
  FileText,
  Globe,
  Lock,
  Mail,
  School,
  Server,
} from "lucide-react";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

export const metadata: Metadata = {
  title: "Security and Network Access",
  description:
    "Security, privacy, and network allowlist information for university IT teams reviewing AwardPing.",
};

const recommendedCategories = ["Education", "Reference", "Productivity", "Business"];

const allowlistDomains = ["https://awardping.com", "https://www.awardping.com"];

const trustFacts = [
  {
    icon: School,
    title: "Academic purpose",
    text: "AwardPing is built for students, advisors, and fellowship offices that monitor official nationally competitive award pages.",
  },
  {
    icon: Globe,
    title: "Public source monitoring",
    text: "AwardPing checks public award webpages and public PDF guides for deadline, eligibility, application, and instruction updates.",
  },
  {
    icon: Lock,
    title: "HTTPS only",
    text: "The production site is served over HTTPS and is deployed on Vercel infrastructure.",
  },
  {
    icon: Mail,
    title: "Email alerts",
    text: "Account and update emails are sent for opted-in users and office members. AwardPing does not use third-party ads.",
  },
];

const notPresent = [
  "No executable downloads",
  "No browser extensions",
  "No third-party advertising network",
  "No crypto mining",
  "No tech-support pop-ups",
  "No financial-data collection",
];

const processors = [
  {
    title: "Vercel",
    text: "Hosts the web application, static assets, and serverless routes.",
  },
  {
    title: "Supabase",
    text: "Stores account, office, watchlist, and monitored source data. Supabase Auth stores password hashes, not raw passwords.",
  },
  {
    title: "Resend",
    text: "Sends account, invitation, alert, digest, and contact emails.",
  },
  {
    title: "AI summary providers",
    text: "May process public source-page excerpts to produce concise change summaries when configured.",
  },
];

const reviewChecklist = [
  "Review https://awardping.com and https://www.awardping.com.",
  "Classify as Education, Reference, Productivity, or Business.",
  "Allow standard HTTPS traffic to the primary domain.",
  "Use the contact page for security, abuse, or network-access questions.",
];

const allowlistNote = [
  "AwardPing is an educational web application used by students, advisors, and fellowship offices to monitor official nationally competitive award pages.",
  "",
  "Primary domains:",
  "https://awardping.com",
  "https://www.awardping.com",
  "",
  "Suggested categories:",
  "Education / Reference / Productivity / Business",
  "",
  "Security notes:",
  "HTTPS only. Passwords are handled by Supabase Auth as non-reversible hashes. Selected subscriber/profile fields use application-level encryption. No executable downloads, browser extensions, third-party ads, crypto mining, financial-data collection, or tech-support pop-ups.",
  "",
  "Contact:",
  "https://awardping.com/contact",
].join("\n");

export default function SecurityPage() {
  return (
    <div className="page-shell">
      <SiteHeader />
      <main className="public-page-main public-page-main-narrow">
        <section>
          <div className="grid gap-5">
            <header className="public-page-heading">
              <h1>Security and network access</h1>
              <p>
                This page gives campus network, security, and help desk teams a
                concise review of what AwardPing does, what domains it uses, and
                how it should be categorized.
              </p>
              <div className="mt-6 flex flex-col gap-3 sm:flex-row">
                <Link className="button-primary" href="/contact">
                  <Mail size={17} aria-hidden="true" />
                  Contact AwardPing
                </Link>
                <Link className="button-secondary" href="/privacy">
                  <FileText size={17} aria-hidden="true" />
                  Privacy policy
                </Link>
              </div>
            </header>

            <div className="card rounded-2xl p-5">
              <div className="flex items-center gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--brand-blue-soft)] text-[var(--foreground)]">
                  <Server size={20} aria-hidden="true" />
                </span>
                <div>
                  <p className="text-sm font-bold uppercase text-[var(--muted)]">
                    Network allowlist
                  </p>
                  <h2 className="text-xl font-bold">Primary domains</h2>
                </div>
              </div>
              <div className="mt-5 grid gap-3">
                {allowlistDomains.map((domain) => (
                  <code
                    className="block overflow-x-auto rounded-xl border border-[var(--line)] bg-[var(--surface)] px-4 py-3 text-sm font-bold text-[var(--foreground)]"
                    key={domain}
                  >
                    {domain}
                  </code>
                ))}
              </div>
              <div className="mt-5">
                <p className="text-sm font-bold uppercase text-[var(--muted)]">
                  Recommended category
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {recommendedCategories.map((category) => (
                    <span className="badge" key={category}>
                      {category}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="mt-8 border-t border-[var(--line)] pt-6">
          <h2 className="text-xl font-bold">How AwardPing works</h2>
          <div className="mt-4 grid gap-5 sm:grid-cols-2">
            {trustFacts.map((fact) => {
              const Icon = fact.icon;
              return (
                <article key={fact.title}>
                  <h3 className="flex items-center gap-2 font-bold">
                    <Icon size={18} aria-hidden="true" />
                    {fact.title}
                  </h3>
                  <p className="mt-2 text-sm leading-6 text-[var(--muted)]">
                    {fact.text}
                  </p>
                </article>
              );
            })}
          </div>
        </section>

        <section className="mt-8 border-t border-[var(--line)] pt-6">
          <div className="grid gap-6 lg:grid-cols-2">
            <article>
              <h2 className="text-xl font-bold">Not part of AwardPing</h2>
              <ul className="mt-4 grid gap-3">
                {notPresent.map((item) => (
                  <li
                    className="flex items-center gap-3"
                    key={item}
                  >
                    <CheckCircle2
                      className="shrink-0 text-[var(--brand-pink-dark)]"
                      size={18}
                      aria-hidden="true"
                    />
                    <span className="text-sm leading-6 text-[var(--muted)]">{item}</span>
                  </li>
                ))}
              </ul>
            </article>

            <article>
              <h2 className="text-xl font-bold">Service providers</h2>
              <div className="mt-4 grid gap-4">
                {processors.map((processor) => (
                  <div key={processor.title}>
                    <h3 className="font-bold">{processor.title}</h3>
                    <p className="mt-1 text-sm leading-6 text-[var(--muted)]">
                      {processor.text}
                    </p>
                  </div>
                ))}
              </div>
            </article>
          </div>
        </section>

        <section className="mt-8 border-t border-[var(--line)] pt-6">
          <div className="grid gap-6">
            <article>
              <h2 className="text-xl font-bold">IT review checklist</h2>
              <ol className="mt-4 list-decimal space-y-2 pl-5 text-sm leading-6 text-[var(--muted)]">
                {reviewChecklist.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ol>
            </article>

            <article>
              <h2 className="text-xl font-bold">Allowlist request text</h2>
              <pre className="mt-5 max-h-[28rem] overflow-auto whitespace-pre-wrap rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4 text-sm font-semibold leading-6 text-[var(--foreground)]">
                {allowlistNote}
              </pre>
            </article>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
