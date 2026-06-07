import type { Metadata } from "next";
import { Mail } from "lucide-react";
import { ContactForm } from "@/components/contact-form";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

export const metadata: Metadata = {
  title: "Contact",
  description: "Contact AwardPing about award-page monitoring and daily updates.",
};

export default function ContactPage() {
  return (
    <div className="page-shell">
      <SiteHeader />
      <main>
        <section className="mx-auto grid max-w-6xl gap-10 px-5 py-16 lg:grid-cols-[0.86fr_1.14fr]">
          <div>
            <span className="badge">
              <Mail size={15} aria-hidden="true" />
              Contact
            </span>
            <h1 className="mt-5 text-5xl font-black leading-tight">
              Send AwardPing a message.
            </h1>
            <p className="mt-5 text-lg leading-8 text-[var(--muted)]">
              Use the form for questions about monitoring award pages, public
              updates, office workflows, or getting started with an advisor watchlist.
            </p>
          </div>
          <ContactForm />
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
