"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Inbox,
  SearchCheck,
} from "lucide-react";

const links = [
  { href: "/updates", label: "Updates", icon: Inbox, section: "updates" },
  { href: "/award-directory", label: "Award Directory", icon: SearchCheck, section: "database" },
];

export function DashboardNav() {
  const pathname = usePathname();
  const activeSection = currentDashboardSection(pathname);

  return (
    <nav className="dashboard-nav" aria-label="Dashboard navigation">
      {links.map((link) => {
        const Icon = link.icon;
        const active = activeSection === link.section;
        return (
          <Link
            className={`dashboard-nav-link dashboard-nav-link-${link.section} ${active ? "dashboard-nav-link-active" : ""}`}
            href={link.href}
            aria-current={active ? "page" : undefined}
            key={link.href}
          >
            <Icon size={16} aria-hidden="true" />
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}

function currentDashboardSection(pathname: string | null) {
  if (pathname === "/award-directory" || pathname?.startsWith("/award-directory/")) {
    return "database";
  }

  if (pathname === "/updates" || pathname?.startsWith("/updates/")) {
    return "updates";
  }

  return null;
}
