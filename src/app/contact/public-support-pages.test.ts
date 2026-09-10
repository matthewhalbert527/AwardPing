import { load } from "cheerio";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/site-header", () => ({ SiteHeader: () => null }));
vi.mock("@/components/site-footer", () => ({ SiteFooter: () => null }));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => { throw new Error(`redirect:${path}`); },
}));

import ContactPage from "@/app/contact/page";
import PrivacyPage from "@/app/privacy/page";
import SecurityPage from "@/app/security/page";
import PricingPage from "@/app/pricing/page";

function pageText(html: string) {
  return load(html)("main").text().replace(/\s+/g, " ");
}

describe("compact public support pages", () => {
  it.each([
    [ContactPage, "Contact"],
    [PrivacyPage, "Privacy policy"],
    [SecurityPage, "Security and network access"],
  ] as const)("uses one compact heading on %s", (Page, title) => {
    const $ = load(renderToStaticMarkup(Page()));
    expect($("main.public-page-main.public-page-main-narrow")).toHaveLength(1);
    expect($("main h1")).toHaveLength(1);
    expect($(".public-page-heading > h1").text()).toBe(title);
    expect($("main .display-title, main .home-feature-band, main .home-feature-card")).toHaveLength(0);
  });

  it("leads directly to the original labeled contact form", () => {
    const $ = load(renderToStaticMarkup(ContactPage()));
    expect($("main form")).toHaveLength(1);
    for (const id of ["contact-name", "contact-email", "contact-message"]) {
      expect($(`#${id}[required]`)).toHaveLength(1);
      expect($(`label[for="${id}"]`)).toHaveLength(1);
    }
    expect($("#contact-email").attr("type")).toBe("email");
    expect($("#contact-website").attr("tabindex")).toBe("-1");
    expect($('button[type="submit"]').text().trim()).toBe("Send message");
  });

  it("keeps privacy disclosures, choices, providers, and retention limits readable", () => {
    const html = renderToStaticMarkup(PrivacyPage());
    const text = pageText(html);
    const statements = [
      "Last updated: June 21, 2026",
      "AwardPing collects only the information needed to run account, office, watchlist, source monitoring, alert, and support workflows.",
      "AwardPing is an educational monitoring tool. It does not sell user contact details, does not run third-party ads, and does not collect payment card or financial account information. Passwords are handled by Supabase Auth as non-reversible password hashes; AwardPing does not store raw passwords.",
      "Name, email address, login state, office membership, invite status, and notification preferences.",
      "Awards, source URLs, notes, tasks, update history, and alert preferences created by users or offices.",
      "Name, email address, and message content submitted through the contact and source-request forms.",
      "Rate limits, job runs, crawl results, source health, and public source-page snapshots needed to operate monitoring.",
      "Create and secure accounts", "Maintain office workspaces and invitations", "Monitor public award source pages",
      "Send alerts, digests, invitations, and support replies", "Improve change summaries and source health",
      "Protect the service from abuse and excessive automated use",
      "Vercel hosts the web application and serverless routes.",
      "Supabase stores account, office, watchlist, and monitoring data.",
      "Resend sends service emails.",
      "AI providers may process public source-page excerpts to generate change summaries when configured.",
      "Access and export account data from dashboard privacy controls.",
      "Delete an AwardPing account from dashboard privacy controls.",
      "Unsubscribe from public update emails using the link in each message.",
      "Request correction, restriction, or other privacy help through the contact page.",
      "Use the contact page for US state privacy requests, including access, deletion, correction, or appeal requests where applicable.",
      "AwardPing uses HTTPS in transit and encrypted hosted storage. Public update subscriber email addresses and selected profile fields are additionally encrypted by AwardPing before storage. Delivery logs store keyed recipient hashes instead of readable recipient email addresses.",
      "Account sessions use essential authentication cookies. AwardPing does not use third-party advertising cookies or sell/share personal information for cross-context behavioral advertising.",
      "Account, office, watchlist, and monitoring data is retained while the account or workspace is active, unless deletion is requested or retention is required for service integrity.",
      "Logged-in users can export or delete account data from dashboard privacy controls. AwardPing may retain minimal records needed for abuse prevention, security, and legal compliance.",
      "AwardPing uses HTTPS, access-controlled account workflows, and hosted infrastructure providers. Security or abuse reports can be sent through the contact page.",
    ];
    for (const statement of statements) expect(text).toContain(statement);
    const $ = load(html);
    expect($('main a[href="/contact"]')).toHaveLength(1);
    expect($('main a[href="/security"]')).toHaveLength(1);
    expect($("main details")).toHaveLength(0);
  });

  it("preserves university IT information and the complete copyable allowlist note", () => {
    const html = renderToStaticMarkup(SecurityPage());
    const text = pageText(html);
    for (const statement of [
      "AwardPing is built for students, advisors, and fellowship offices that monitor official nationally competitive award pages.",
      "AwardPing checks public award webpages and public PDF guides for deadline, eligibility, application, and instruction updates.",
      "The production site is served over HTTPS and is deployed on Vercel infrastructure.",
      "Account and update emails are sent for opted-in users and office members. AwardPing does not use third-party ads.",
      "No executable downloads", "No browser extensions", "No third-party advertising network", "No crypto mining", "No tech-support pop-ups", "No financial-data collection",
      "Hosts the web application, static assets, and serverless routes.",
      "Stores account, office, watchlist, and monitored source data. Supabase Auth stores password hashes, not raw passwords.",
      "Sends account, invitation, alert, digest, and contact emails.",
      "May process public source-page excerpts to produce concise change summaries when configured.",
      "Review https://awardping.com and https://www.awardping.com.",
      "Classify as Education, Reference, Productivity, or Business.",
      "Allow standard HTTPS traffic to the primary domain.",
      "Use the contact page for security, abuse, or network-access questions.",
    ]) expect(text).toContain(statement);
    const $ = load(html);
    expect($("main pre").text()).toBe([
      "AwardPing is an educational web application used by students, advisors, and fellowship offices to monitor official nationally competitive award pages.",
      "", "Primary domains:", "https://awardping.com", "https://www.awardping.com",
      "", "Suggested categories:", "Education / Reference / Productivity / Business",
      "", "Security notes:",
      "HTTPS only. Passwords are handled by Supabase Auth as non-reversible hashes. Selected subscriber/profile fields use application-level encryption. No executable downloads, browser extensions, third-party ads, crypto mining, financial-data collection, or tech-support pop-ups.",
      "", "Contact:", "https://awardping.com/contact",
    ].join("\n"));
    expect($('main a[href="/contact"]')).toHaveLength(1);
    expect($('main a[href="/privacy"]')).toHaveLength(1);
  });

  it("keeps the existing pricing-to-contact redirect", () => {
    expect(() => PricingPage()).toThrow("redirect:/contact");
  });
});
