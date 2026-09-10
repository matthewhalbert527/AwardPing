import Link from "next/link";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

export default function NotFound() {
  return (
    <div className="page-shell">
      <SiteHeader />
      <main className="public-page-main public-page-main-narrow">
        <header className="public-page-heading">
          <h1>Page not found</h1>
          <p>This page could not be found. Browse the award directory or view the latest updates.</p>
        </header>
        <div className="public-page-actions">
          <Link className="button-primary" href="/award-directory" prefetch={false}>
            Browse awards
          </Link>
          <Link className="button-secondary" href="/updates">View updates</Link>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
