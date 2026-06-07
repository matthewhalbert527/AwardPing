"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { LayoutDashboard, LogOut, Mail, Settings } from "lucide-react";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

export function ProfileMenu({
  email,
  fullName,
  showDashboardLink = false,
}: {
  email?: string | null;
  fullName?: string | null;
  showDashboardLink?: boolean;
}) {
  const router = useRouter();
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
    <div className="group relative">
      <button
        className="inline-flex h-12 w-12 items-center justify-center rounded-full border border-white/70 p-0 font-black text-white shadow-[0_14px_34px_rgba(108,90,146,0.26)] transition hover:-translate-y-0.5"
        type="button"
        aria-label={`Profile menu for ${displayName}`}
        style={{
          background: avatar.background,
          color: avatar.color,
        }}
      >
        {initials}
      </button>
      <div className="absolute right-0 top-full z-50 hidden w-64 pt-2 group-hover:block group-focus-within:block">
        <div className="rounded-2xl border border-[var(--line)] bg-white p-2 text-sm shadow-[0_24px_60px_rgba(22,34,74,0.14)]">
          {fullName && (
            <p className="truncate px-3 pt-2 font-black text-[var(--foreground)]">{fullName}</p>
          )}
          {email && (
            <p className="truncate px-3 pb-2 pt-1 font-semibold text-[var(--muted)]">{email}</p>
          )}
          {showDashboardLink && (
            <Link className="flex items-center gap-2 rounded-xl px-3 py-2 font-bold hover:bg-[var(--brand-blue-soft)]" href="/dashboard">
              <LayoutDashboard size={16} aria-hidden="true" />
              Dashboard
            </Link>
          )}
          <Link className="flex items-center gap-2 rounded-xl px-3 py-2 font-bold hover:bg-[var(--brand-blue-soft)]" href="/dashboard/office">
            <Settings size={16} aria-hidden="true" />
            Settings
          </Link>
          <Link className="flex items-center gap-2 rounded-xl px-3 py-2 font-bold hover:bg-[var(--brand-blue-soft)]" href="/contact">
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
