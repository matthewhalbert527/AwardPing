import type { Metadata } from "next";
import Link from "next/link";
import {
  Bell,
  Database,
  FileText,
  Lock,
  Mail,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description:
    "How AwardPing collects, uses, protects, and deletes account, office, watchlist, and contact information.",
};

const collectedData = [
  {
    icon: UserRound,
    title: "Account details",
    text: "Name, email address, login state, office membership, invite status, and notification preferences.",
  },
  {
    icon: Bell,
    title: "Watchlist activity",
    text: "Awards, source URLs, notes, tasks, update history, and alert preferences created by users or offices.",
  },
  {
    icon: Mail,
    title: "Contact messages",
    text: "Name, email address, and message content submitted through the contact and source-request forms.",
  },
  {
    icon: Database,
    title: "Operational data",
    text: "Rate limits, job runs, crawl results, source health, and public source-page snapshots needed to operate monitoring.",
  },
];

const useCases = [
  "Create and secure accounts",
  "Maintain office workspaces and invitations",
  "Monitor public award source pages",
  "Send alerts, digests, invitations, and support replies",
  "Improve change summaries and source health",
  "Protect the service from abuse and excessive automated use",
];

const rights = [
  "Access and export account data from dashboard privacy controls.",
  "Delete an AwardPing account from dashboard privacy controls.",
  "Unsubscribe from public update emails using the link in each message.",
  "Request correction, restriction, or other privacy help through the contact page.",
  "Use the contact page for US state privacy requests, including access, deletion, correction, or appeal requests where applicable.",
];

const processors = [
  "Vercel hosts the web application and serverless routes.",
  "Supabase stores account, office, watchlist, and monitoring data.",
  "Resend sends service emails.",
  "AI providers may process public source-page excerpts to generate change summaries when configured.",
];

export default function PrivacyPage() {
  return (
    <div className="page-shell">
      <SiteHeader />
      <main>
        <section className="mx-auto max-w-6xl px-5 pb-12 pt-14 lg:pb-16 lg:pt-18">
          <div className="grid gap-10 lg:grid-cols-[0.86fr_1.14fr] lg:items-start">
            <div>
              <span className="badge">
                <ShieldCheck size={15} aria-hidden="true" />
                Privacy policy
              </span>
              <h1 className="mt-5 text-4xl font-black leading-tight md:text-6xl">
                Privacy for students, advisors, and award offices.
              </h1>
              <p className="mt-5 max-w-2xl text-lg leading-8 text-[var(--muted)]">
                AwardPing collects only the information needed to run account,
                office, watchlist, source monitoring, alert, and support workflows.
              </p>
              <p className="mt-4 text-sm font-bold text-[var(--muted)]">
                Last updated: June 21, 2026
              </p>
            </div>

            <article className="card rounded-3xl p-5 sm:p-6">
              <span className="badge">
                <Lock size={15} aria-hidden="true" />
                Short version
              </span>
              <h2 className="mt-5 text-3xl font-black">What AwardPing protects</h2>
              <p className="mt-4 leading-7 text-[var(--muted)]">
                AwardPing is an educational monitoring tool. It does not sell user
                contact details, does not run third-party ads, and does not collect
                payment card or financial account information. Passwords are handled
                by Supabase Auth as non-reversible password hashes; AwardPing does
                not store raw passwords.
              </p>
              <div className="mt-6 flex flex-col gap-3 sm:flex-row">
                <Link className="button-primary" href="/contact">
                  <Mail size={17} aria-hidden="true" />
                  Contact AwardPing
                </Link>
                <Link className="button-secondary" href="/security">
                  <FileText size={17} aria-hidden="true" />
                  Security details
                </Link>
              </div>
            </article>
          </div>
        </section>

        <section className="home-feature-band border-y border-[var(--line)]">
          <div className="mx-auto grid max-w-6xl gap-4 px-5 py-12 md:grid-cols-2 lg:grid-cols-4">
            {collectedData.map((item) => {
              const Icon = item.icon;
              return (
                <article className="card home-feature-card rounded-[1.6rem] p-6" key={item.title}>
                  <Icon className="home-feature-icon" size={24} aria-hidden="true" />
                  <h2 className="mt-5 text-xl font-black">{item.title}</h2>
                  <p className="mt-2 text-sm leading-6 text-[var(--muted)]">
                    {item.text}
                  </p>
                </article>
              );
            })}
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-5 py-14">
          <div className="grid gap-6 lg:grid-cols-2">
            <article className="card rounded-3xl p-5 sm:p-6">
              <h2 className="text-3xl font-black">How data is used</h2>
              <ul className="mt-5 grid gap-3">
                {useCases.map((item) => (
                  <li className="flex gap-3" key={item}>
                    <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-[var(--brand-pink)]" />
                    <span className="text-sm font-bold leading-6 text-[var(--foreground)]">
                      {item}
                    </span>
                  </li>
                ))}
              </ul>
            </article>

            <article className="card rounded-3xl p-5 sm:p-6">
              <h2 className="text-3xl font-black">Service providers</h2>
              <ul className="mt-5 grid gap-3">
                {processors.map((item) => (
                  <li
                    className="rounded-2xl border border-[var(--line)] bg-white p-4 text-sm font-semibold leading-6 text-[var(--muted)]"
                    key={item}
                  >
                    {item}
                  </li>
                ))}
              </ul>
            </article>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-5 pb-14">
          <div className="grid gap-6 lg:grid-cols-2">
            <article className="card rounded-3xl p-5 sm:p-6">
              <h2 className="text-3xl font-black">Privacy rights</h2>
              <ul className="mt-5 grid gap-3">
                {rights.map((item) => (
                  <li
                    className="rounded-2xl border border-[var(--line)] bg-white p-4 text-sm font-semibold leading-6 text-[var(--muted)]"
                    key={item}
                  >
                    {item}
                  </li>
                ))}
              </ul>
            </article>

            <article className="card rounded-3xl p-5 sm:p-6">
              <h2 className="text-3xl font-black">Encryption and safeguards</h2>
              <p className="mt-4 leading-7 text-[var(--muted)]">
                AwardPing uses HTTPS in transit and encrypted hosted storage.
                Public update subscriber email addresses and selected profile
                fields are additionally encrypted by AwardPing before storage.
                Delivery logs store keyed recipient hashes instead of readable
                recipient email addresses.
              </p>
              <p className="mt-4 leading-7 text-[var(--muted)]">
                Account sessions use essential authentication cookies. AwardPing
                does not use third-party advertising cookies or sell/share personal
                information for cross-context behavioral advertising.
              </p>
            </article>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-5 pb-16">
          <div className="card rounded-3xl p-5 sm:p-6">
            <div className="grid gap-8 lg:grid-cols-3">
              <div>
                <h2 className="text-2xl font-black">Retention</h2>
                <p className="mt-3 text-sm leading-6 text-[var(--muted)]">
                  Account, office, watchlist, and monitoring data is retained
                  while the account or workspace is active, unless deletion is
                  requested or retention is required for service integrity.
                </p>
              </div>
              <div>
                <h2 className="text-2xl font-black">Deletion</h2>
                <p className="mt-3 text-sm leading-6 text-[var(--muted)]">
                  Logged-in users can export or delete account data from dashboard
                  privacy controls. AwardPing may retain minimal records needed
                  for abuse prevention, security, and legal compliance.
                </p>
              </div>
              <div>
                <h2 className="text-2xl font-black">Security</h2>
                <p className="mt-3 text-sm leading-6 text-[var(--muted)]">
                  AwardPing uses HTTPS, access-controlled account workflows, and
                  hosted infrastructure providers. Security or abuse reports can
                  be sent through the contact page.
                </p>
              </div>
            </div>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
