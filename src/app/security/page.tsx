import type { Metadata } from "next";
import Link from "next/link";
import {
  Ban,
  CheckCircle2,
  Database,
  FileText,
  Globe,
  Lock,
  Mail,
  School,
  Server,
  ShieldCheck,
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
    text: "Stores account, office, watchlist, and monitored source data.",
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
  "HTTPS only. Hosted on Vercel. No executable downloads, browser extensions, third-party ads, crypto mining, financial-data collection, or tech-support pop-ups.",
  "",
  "Contact:",
  "https://awardping.com/contact",
].join("\n");

export default function SecurityPage() {
  return (
    <div className="page-shell">
      <SiteHeader />
      <main>
        <section className="mx-auto max-w-6xl px-5 pb-12 pt-14 lg:pb-16 lg:pt-18">
          <div className="grid gap-10 lg:grid-cols-[0.9fr_1.1fr] lg:items-start">
            <div>
              <span className="badge">
                <ShieldCheck size={15} aria-hidden="true" />
                Security and network access
              </span>
              <h1 className="mt-5 text-4xl font-black leading-tight md:text-6xl">
                University IT review details for AwardPing.
              </h1>
              <p className="mt-5 max-w-2xl text-lg leading-8 text-[var(--muted)]">
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
            </div>

            <div className="card rounded-3xl p-5 sm:p-6">
              <div className="flex items-center gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--brand-blue-soft)] text-[var(--foreground)]">
                  <Server size={20} aria-hidden="true" />
                </span>
                <div>
                  <p className="text-sm font-black uppercase text-[var(--muted)]">
                    Network allowlist
                  </p>
                  <h2 className="text-2xl font-black">Primary domains</h2>
                </div>
              </div>
              <div className="mt-5 grid gap-3">
                {allowlistDomains.map((domain) => (
                  <code
                    className="block overflow-x-auto rounded-xl border border-[var(--line)] bg-white px-4 py-3 text-sm font-bold text-[var(--foreground)]"
                    key={domain}
                  >
                    {domain}
                  </code>
                ))}
              </div>
              <div className="mt-5">
                <p className="text-sm font-black uppercase text-[var(--muted)]">
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

        <section className="home-feature-band border-y border-[var(--line)]">
          <div className="mx-auto grid max-w-6xl gap-4 px-5 py-12 md:grid-cols-2 lg:grid-cols-4">
            {trustFacts.map((fact) => {
              const Icon = fact.icon;
              return (
                <article className="card home-feature-card rounded-[1.6rem] p-6" key={fact.title}>
                  <Icon className="home-feature-icon" size={24} aria-hidden="true" />
                  <h2 className="mt-5 text-xl font-black">{fact.title}</h2>
                  <p className="mt-2 text-sm leading-6 text-[var(--muted)]">
                    {fact.text}
                  </p>
                </article>
              );
            })}
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-5 py-14">
          <div className="grid gap-6 lg:grid-cols-[0.9fr_1.1fr]">
            <article className="card rounded-3xl p-5 sm:p-6">
              <span className="badge">
                <Ban size={15} aria-hidden="true" />
                Not part of AwardPing
              </span>
              <h2 className="mt-5 text-3xl font-black">Common filter concerns</h2>
              <div className="mt-5 grid gap-3 sm:grid-cols-2">
                {notPresent.map((item) => (
                  <div
                    className="flex items-center gap-3 rounded-2xl border border-[var(--line)] bg-white p-4"
                    key={item}
                  >
                    <CheckCircle2
                      className="shrink-0 text-[var(--brand-pink-dark)]"
                      size={18}
                      aria-hidden="true"
                    />
                    <span className="text-sm font-black">{item}</span>
                  </div>
                ))}
              </div>
            </article>

            <article className="card rounded-3xl p-5 sm:p-6">
              <span className="badge">
                <Database size={15} aria-hidden="true" />
                Service providers
              </span>
              <h2 className="mt-5 text-3xl font-black">Operational dependencies</h2>
              <div className="mt-5 grid gap-3">
                {processors.map((processor) => (
                  <div
                    className="rounded-2xl border border-[var(--line)] bg-white p-4"
                    key={processor.title}
                  >
                    <h3 className="font-black">{processor.title}</h3>
                    <p className="mt-1 text-sm leading-6 text-[var(--muted)]">
                      {processor.text}
                    </p>
                  </div>
                ))}
              </div>
            </article>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-5 pb-16">
          <div className="grid gap-6 lg:grid-cols-[0.82fr_1.18fr]">
            <article className="card rounded-3xl p-5 sm:p-6">
              <span className="badge">
                <School size={15} aria-hidden="true" />
                IT review checklist
              </span>
              <h2 className="mt-5 text-3xl font-black">Suggested review steps</h2>
              <ol className="mt-5 grid gap-3">
                {reviewChecklist.map((item, index) => (
                  <li className="flex gap-3" key={item}>
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--brand-blue-soft)] text-sm font-black">
                      {index + 1}
                    </span>
                    <span className="pt-0.5 text-sm font-bold leading-6 text-[var(--foreground)]">
                      {item}
                    </span>
                  </li>
                ))}
              </ol>
            </article>

            <article className="card rounded-3xl p-5 sm:p-6">
              <span className="badge">
                <FileText size={15} aria-hidden="true" />
                Help desk note
              </span>
              <h2 className="mt-5 text-3xl font-black">Allowlist request text</h2>
              <pre className="mt-5 max-h-[28rem] overflow-auto whitespace-pre-wrap rounded-2xl border border-[var(--line)] bg-white p-4 text-sm font-semibold leading-6 text-[var(--foreground)]">
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
