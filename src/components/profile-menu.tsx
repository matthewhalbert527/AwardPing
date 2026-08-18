"use client";

import Link from "next/link";
import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { LayoutDashboard, LogOut, Mail, Settings, ShieldCheck } from "lucide-react";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

export function ProfileMenu({
  email,
  fullName,
  showDashboardLink = false,
  showAdminLink = false,
  dashboardHref = "/updates",
}: {
  email?: string | null;
  fullName?: string | null;
  showDashboardLink?: boolean;
  showAdminLink?: boolean;
  dashboardHref?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const displayName = fullName?.trim() || email || "Profile";
  const initials = initialsForProfile(fullName || email);
  const avatar = avatarColor();

  async function logout() {
    const supabase = createSupabaseBrowserClient();
    await supabase.auth.signOut();
    router.push("/");
    router.refresh();
  }

  return (
    <div
      className="relative"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          setOpen(false);
          event.currentTarget.querySelector<HTMLButtonElement>("button")?.focus();
        }
      }}
    >
      <button
        aria-controls={menuId}
        aria-expanded={open}
        aria-haspopup="true"
        className="inline-flex h-12 w-12 items-center justify-center rounded-full border border-[color-mix(in_srgb,var(--accent-contrast)_70%,transparent)] p-0 font-bold text-[var(--accent-contrast)] shadow-[var(--shadow-lg)] transition hover:-translate-y-0.5"
        onClick={() => setOpen((current) => !current)}
        type="button"
        aria-label={`Profile menu for ${displayName}`}
        style={{
          background: avatar.background,
          color: avatar.color,
        }}
      >
        {initials}
      </button>
      <div
        className={`absolute right-0 top-full z-50 w-64 pt-2 ${open ? "block" : "hidden"}`}
        id={menuId}
      >
        <div className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-2 text-sm shadow-[var(--shadow-xl)]">
          {fullName && (
            <p className="truncate px-3 pt-2 font-bold text-[var(--foreground)]">{fullName}</p>
          )}
          {email && (
            <p className="truncate px-3 pb-2 pt-1 font-semibold text-[var(--muted)]">{email}</p>
          )}
          {showDashboardLink && (
            <Link className="flex items-center gap-2 rounded-xl px-3 py-2 font-bold hover:bg-[var(--brand-blue-soft)]" href={dashboardHref} onClick={() => setOpen(false)}>
              <LayoutDashboard size={16} aria-hidden="true" />
              Dashboard
            </Link>
          )}
          {showAdminLink && (
            <Link className="flex items-center gap-2 rounded-xl px-3 py-2 font-bold hover:bg-[var(--brand-blue-soft)]" href="/dashboard/admin/issues" onClick={() => setOpen(false)}>
              <ShieldCheck size={16} aria-hidden="true" />
              Admin workflows
            </Link>
          )}
          <Link className="flex items-center gap-2 rounded-xl px-3 py-2 font-bold hover:bg-[var(--brand-blue-soft)]" href="/dashboard/office" onClick={() => setOpen(false)}>
            <Settings size={16} aria-hidden="true" />
            Settings
          </Link>
          <Link className="flex items-center gap-2 rounded-xl px-3 py-2 font-bold hover:bg-[var(--brand-blue-soft)]" href="/contact" onClick={() => setOpen(false)}>
            <Mail size={16} aria-hidden="true" />
            Contact
          </Link>
          <button
            className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left font-bold hover:bg-[var(--brand-blue-soft)]"
            type="button"
            onClick={logout}
          >
            <LogOut size={16} aria-hidden="true" />
            Log out
          </button>
        </div>
      </div>
    </div>
  );
}

function initialsForProfile(value: string | null | undefined) {
  const fallback = "AP";
  if (!value) return fallback;

  const cleaned = value.trim();
  if (!cleaned) return fallback;

  const emailName = cleaned.includes("@") ? cleaned.split("@")[0] : cleaned;
  const parts = emailName
    .replace(/[^a-zA-Z0-9\s._-]/g, " ")
    .split(/[\s._-]+/)
    .filter(Boolean);

  if (parts.length === 0) return fallback;
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();

  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

function avatarColor() {
  return {
    background: "var(--profile-accent)",
    color: "#ffffff",
  };
}
