import type { Metadata } from "next";
import Link from "next/link";
import {
  Bell,
  Database,
  FileText,
  Mail,
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
      <main className="public-page-main public-page-main-narrow">
        <section>
          <div className="grid gap-5">
            <header className="public-page-heading">
              <h1>Privacy policy</h1>
              <p>
                AwardPing collects only the information needed to run account,
                office, watchlist, source monitoring, alert, and support workflows.
              </p>
              <p className="mt-4 text-sm font-bold text-[var(--muted)]">
                Last updated: June 21, 2026
              </p>
            </header>

            <article>
              <h2 className="text-xl font-bold">What AwardPing protects</h2>
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

        <section className="mt-8 border-t border-[var(--line)] pt-6">
          <h2 className="text-xl font-bold">Information collected</h2>
          <div className="mt-4 grid gap-5 sm:grid-cols-2">
            {collectedData.map((item) => {
              const Icon = item.icon;
              return (
                <article key={item.title}>
                  <h3 className="flex items-center gap-2 font-bold">
                    <Icon size={18} aria-hidden="true" />
                    {item.title}
                  </h3>
                  <p className="mt-2 text-sm leading-6 text-[var(--muted)]">
                    {item.text}
                  </p>
                </article>
              );
            })}
          </div>
        </section>

        <section className="mt-8 border-t border-[var(--line)] pt-6">
          <div className="grid gap-6 lg:grid-cols-2">
            <article>
              <h2 className="text-xl font-bold">How data is used</h2>
              <ul className="mt-4 list-disc space-y-2 pl-5 text-sm leading-6 text-[var(--muted)]">
                {useCases.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </article>

            <article>
              <h2 className="text-xl font-bold">Service providers</h2>
              <ul className="mt-4 list-disc space-y-2 pl-5 text-sm leading-6 text-[var(--muted)]">
                {processors.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </article>
          </div>
        </section>

        <section className="mt-8 border-t border-[var(--line)] pt-6">
         <div className="grid gap-6 lg:grid-cols-2">
            <article>
              <h2 className="text-xl font-bold">Privacy rights</h2>
              <ul className="mt-4 list-disc space-y-2 pl-5 text-sm leading-6 text-[var(--muted)]">
                {rights.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </article>

            <article>
              <h2 className="text-xl font-bold">Encryption and safeguards</h2>
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

        <section className="mt-8 border-t border-[var(--line)] pt-6">
          <div>
            <div className="grid gap-6">
              <div>
                <h2 className="text-xl font-bold">Retention</h2>
                <p className="mt-3 text-sm leading-6 text-[var(--muted)]">
                  Account, office, watchlist, and monitoring data is retained
                  while the account or workspace is active, unless deletion is
                  requested or retention is required for service integrity.
                </p>
              </div>
              <div>
                <h2 className="text-xl font-bold">Deletion</h2>
                <p className="mt-3 text-sm leading-6 text-[var(--muted)]">
                  Logged-in users can export or delete account data from dashboard
                  privacy controls. AwardPing may retain minimal records needed
                  for abuse prevention, security, and legal compliance.
                </p>
              </div>
              <div>
                <h2 className="text-xl font-bold">Security</h2>
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
