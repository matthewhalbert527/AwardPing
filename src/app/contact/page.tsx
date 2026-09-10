import type { Metadata } from "next";
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
      <main className="public-page-main public-page-main-narrow">
        <header className="public-page-heading">
          <h1>Contact</h1>
          <p>Ask a question or report a problem with an award page or update.</p>
        </header>
        <ContactForm />
      </main>
      <SiteFooter />
    </div>
  );
}
