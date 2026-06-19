"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import {
  Activity,
  Inbox,
  ListChecks,
  SearchCheck,
} from "lucide-react";

const links = [
  { href: "/dashboard", label: "Updates", icon: Inbox, section: "updates" },
  { href: "/dashboard/awards", label: "Database", icon: SearchCheck, section: "database" },
  { href: "/dashboard/awards?view=watchlist", label: "Watchlist", icon: ListChecks, section: "watchlist" },
];

const adminLink = { href: "/dashboard/admin", label: "Admin", icon: Activity, section: "admin" };

export function DashboardNav({ isSiteAdmin = false }: { isSiteAdmin?: boolean }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const activeSection = currentDashboardSection(pathname, searchParams);
  const visibleLinks = isSiteAdmin ? [...links, adminLink] : links;

  return (
    <nav className="dashboard-nav" aria-label="Dashboard navigation">
      {visibleLinks.map((link) => {
        const Icon = link.icon;
        const active = activeSection === link.section;
        return (
          <Link
            className={`dashboard-nav-link dashboard-nav-link-${link.section} ${active ? "dashboard-nav-link-active" : ""}`}
            href={link.href}
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

function currentDashboardSection(
  pathname: string,
  searchParams: { get(name: string): string | null },
) {
  if (pathname.startsWith("/dashboard/awards")) {
    return searchParams.get("view") === "watchlist" ? "watchlist" : "database";
  }

  if (pathname === "/dashboard" || pathname.startsWith("/dashboard/updates")) {
    return "updates";
  }

  if (pathname.startsWith("/dashboard/admin") || pathname.startsWith("/dashboard/ops")) {
    return "admin";
  }

  return "updates";
}
