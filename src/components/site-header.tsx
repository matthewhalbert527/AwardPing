import Link from "next/link";
import { LayoutDashboard } from "lucide-react";
import { getCurrentUser, getUserProfile, isSiteAdminEmail } from "@/lib/auth";
import { BrandLogo } from "@/components/brand-logo";
import { ProfileMenu } from "@/components/profile-menu";
import { signedInLandingLabel, signedInLandingPath } from "@/lib/navigation";

export async function SiteHeader() {
  const user = await getCurrentUser();
  const profile = user ? await getUserProfile(user.id) : null;
  const signedInHref = signedInLandingPath();
  const signedInLabel = signedInLandingLabel();
  const isSiteAdmin = isSiteAdminEmail(user?.email);

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
                <Link href={signedInHref} className="button-secondary">
                  <LayoutDashboard size={17} aria-hidden="true" />
                  {signedInLabel}
                </Link>
                <ProfileMenu
                  email={user.email}
                  fullName={profile?.full_name}
                  showAdminLink={isSiteAdmin}
                />
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
