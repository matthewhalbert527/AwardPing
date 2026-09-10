import Link from "next/link";

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="site-footer-shell">
        <p className="font-bold">AwardPing</p>
        <nav className="site-footer-links" aria-label="Footer navigation">
          <Link href="/updates">Live updates</Link>
          <Link href="/award-directory" prefetch={false}>Find awards</Link>
          <Link href="/award-page-change-checker">Award page checker</Link>
          <Link href="/contact">Contact</Link>
          <Link href="/security">Security</Link>
          <Link href="/privacy">Privacy</Link>
        </nav>
      </div>
    </footer>
  );
}
