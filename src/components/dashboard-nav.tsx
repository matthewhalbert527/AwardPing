"use client";

import { useState, type FocusEvent } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import {
  Activity,
  AlertTriangle,
  ChevronDown,
  Inbox,
  ListChecks,
  SearchCheck,
} from "lucide-react";

const links = [
  { href: "/dashboard", label: "Updates", icon: Inbox, section: "updates" },
  { href: "/dashboard/awards", label: "Database", icon: SearchCheck, section: "database" },
  { href: "/dashboard/awards?view=watchlist", label: "Watchlist", icon: ListChecks, section: "watchlist" },
];

export function DashboardNav({ isSiteAdmin = false }: { isSiteAdmin?: boolean }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const activeSection = currentDashboardSection(pathname, searchParams);

  return (
    <nav className="dashboard-nav" aria-label="Dashboard navigation">
      {links.map((link) => {
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
      {isSiteAdmin && <AdminNavMenu active={activeSection === "admin"} />}
    </nav>
  );
}

function AdminNavMenu({ active }: { active: boolean }) {
  const [isOpen, setIsOpen] = useState(false);

  function closeMenu() {
    setIsOpen(false);
  }

  function handleBlur(event: FocusEvent<HTMLDivElement>) {
    if (!event.currentTarget.contains(event.relatedTarget)) {
      closeMenu();
    }
  }

  return (
    <div
      className={`dashboard-nav-admin-menu ${isOpen ? "dashboard-nav-admin-menu-open" : ""}`}
      onBlur={handleBlur}
      onFocus={() => setIsOpen(true)}
      onMouseEnter={() => setIsOpen(true)}
      onMouseLeave={closeMenu}
    >
      <Link
        aria-expanded={isOpen}
        aria-haspopup="menu"
        className={`dashboard-nav-link dashboard-nav-link-admin ${active ? "dashboard-nav-link-active" : ""}`}
        href="/dashboard/admin"
        onClick={closeMenu}
      >
        <Activity size={16} aria-hidden="true" />
        Admin
        <ChevronDown className="dashboard-nav-caret" size={14} aria-hidden="true" />
      </Link>
      <div className="dashboard-nav-admin-dropdown" role="menu">
        <Link
          className="dashboard-nav-admin-item"
          href="/dashboard/admin"
          onClick={closeMenu}
          role="menuitem"
        >
          <Activity size={15} aria-hidden="true" />
          <span>Page data</span>
        </Link>
        <Link
          className="dashboard-nav-admin-item"
          href="/dashboard/admin/issues"
          onClick={closeMenu}
          role="menuitem"
        >
          <AlertTriangle size={15} aria-hidden="true" />
          <span>Issues</span>
        </Link>
      </div>
    </div>
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
