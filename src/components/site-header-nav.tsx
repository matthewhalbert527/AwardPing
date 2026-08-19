"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Menu, X } from "lucide-react";

const NAV_LINKS = [
  { href: "/updates", label: "Live Updates" },
  { href: "/award-directory", label: "Award Directory", prefetch: false },
  { href: "/advisor-hub", label: "Advisor Hub" },
] as const;

function isActivePath(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function SiteHeaderNav() {
  const pathname = usePathname() || "/";
  const [menuOpen, setMenuOpen] = useState(false);
  const [lastPathname, setLastPathname] = useState(pathname);
  if (lastPathname !== pathname) {
    setLastPathname(pathname);
    setMenuOpen(false);
  }

  return (
    <>
      <nav className="site-header-nav" aria-label="Primary navigation">
        {NAV_LINKS.map((link) => (
          <Link
            aria-current={isActivePath(pathname, link.href) ? "page" : undefined}
            href={link.href}
            key={link.href}
            prefetch={"prefetch" in link ? link.prefetch : undefined}
          >
            {link.label}
          </Link>
        ))}
      </nav>

      <button
        aria-controls="site-header-menu"
        aria-expanded={menuOpen}
        aria-label={menuOpen ? "Close navigation menu" : "Open navigation menu"}
        className="site-header-menu-button"
        type="button"
        onClick={() => setMenuOpen((current) => !current)}
      >
        {menuOpen ? <X size={19} aria-hidden="true" /> : <Menu size={19} aria-hidden="true" />}
      </button>

      {menuOpen && (
        <nav aria-label="Primary navigation" className="site-header-menu-panel" id="site-header-menu">
          {NAV_LINKS.map((link) => (
            <Link
              aria-current={isActivePath(pathname, link.href) ? "page" : undefined}
              href={link.href}
              key={link.href}
              prefetch={"prefetch" in link ? link.prefetch : undefined}
              onClick={() => setMenuOpen(false)}
            >
              {link.label}
            </Link>
          ))}
        </nav>
      )}
    </>
  );
}
