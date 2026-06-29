import Link from "next/link";

export function SiteFooter() {
  return (
    <footer className="border-t border-[var(--line)] bg-white text-[var(--foreground)]">
      <div className="mx-auto grid max-w-6xl gap-8 px-5 py-12 md:grid-cols-[1.2fr_1fr_1fr]">
        <div>
          <p className="text-lg font-black">AwardPing</p>
          <p className="mt-3 max-w-sm text-sm leading-6 text-[var(--muted)]">
            Official award page monitoring for updates you do not want to check manually.
          </p>
        </div>
        <div>
          <p className="text-sm font-bold text-[var(--muted)]">
            Product
          </p>
          <div className="mt-3 flex flex-col gap-2 text-sm font-semibold text-[var(--foreground)]">
            <Link href="/dashboard">Dashboard</Link>
            <Link href="/award-directory" prefetch={false}>Find awards</Link>
            <Link href="/award-page-change-checker">Award page checker</Link>
          </div>
        </div>
        <div>
          <p className="text-sm font-bold text-[var(--muted)]">
            Support
          </p>
          <div className="mt-3 flex flex-col gap-2 text-sm font-semibold text-[var(--foreground)]">
            <Link href="/contact">Contact</Link>
            <Link href="/security">Security</Link>
            <Link href="/privacy">Privacy</Link>
          </div>
        </div>
      </div>
    </footer>
  );
}
