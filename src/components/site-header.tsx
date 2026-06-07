import Link from "next/link";
import { LayoutDashboard } from "lucide-react";
import { getCurrentUser, getUserProfile } from "@/lib/auth";
import { BrandLogo } from "@/components/brand-logo";
import { ProfileMenu } from "@/components/profile-menu";

export async function SiteHeader() {
  const user = await getCurrentUser();
  const profile = user ? await getUserProfile(user.id) : null;

  return (
    <header className="sticky top-0 z-40 px-4 pt-4">
      <div className="mx-auto flex max-w-6xl items-center justify-between rounded-full border border-[var(--line)] bg-white/[0.86] px-4 py-3 shadow-[0_18px_55px_rgba(22,34,74,0.09)] backdrop-blur-xl">
        <Link href="/" className="brand-link">
          <BrandLogo />
        </Link>

        <div className="flex items-center gap-2">
          <span className="hidden sm:block">
            <Link href="/dashboard" className="button-secondary">
              <LayoutDashboard size={17} aria-hidden="true" />
              Dashboard
            </Link>
          </span>
          {user ? (
            <ProfileMenu email={user.email} fullName={profile?.full_name} />
          ) : (
            <Link href="/signup" className="button-primary">
              Sign up for free
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}
