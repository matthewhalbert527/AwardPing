import Link from "next/link";
import { LayoutDashboard } from "lucide-react";
import { getCurrentUser, getUserProfile } from "@/lib/auth";
import { BrandLogo } from "@/components/brand-logo";
import { ProfileMenu } from "@/components/profile-menu";

export async function SiteHeader() {
  const user = await getCurrentUser();
  const profile = user ? await getUserProfile(user.id) : null;

  return (
    <header className="app-header">
      <div className="app-header-shell">
        <div className="app-header-bar">
          <Link href="/" className="brand-link app-header-brand" aria-label="AwardPing home">
            <BrandLogo />
          </Link>

          <nav className="site-header-nav" aria-label="Primary navigation">
            <Link href="/updates">Live Updates</Link>
            <Link href="/award-directory" prefetch={false}>Award Directory</Link>
            <Link href="/advisor-hub">Advisor Hub</Link>
          </nav>

          <div className="app-header-actions">
            {user ? (
              <>
                <Link href="/dashboard" className="button-secondary">
                  <LayoutDashboard size={17} aria-hidden="true" />
                  Dashboard
                </Link>
                <ProfileMenu email={user.email} fullName={profile?.full_name} />
              </>
            ) : (
              <Link href="/signup" className="button-primary">
                Sign up for free
              </Link>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}
