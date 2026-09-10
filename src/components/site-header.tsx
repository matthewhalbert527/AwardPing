import Link from "next/link";
import { getCurrentUser, getUserProfile, isSiteAdminEmail } from "@/lib/auth";
import { BrandLogo } from "@/components/brand-logo";
import { SiteHeaderNav } from "@/components/site-header-nav";
import { ProfileMenu } from "@/components/profile-menu";

export async function SiteHeader() {
  const user = await getCurrentUser();
  const profile = user ? await getUserProfile(user.id) : null;
  const isSiteAdmin = isSiteAdminEmail(user?.email);

  return (
    <header className="app-header">
      <div className="app-header-shell">
        <div className="app-header-bar">
          <Link href="/" className="brand-link app-header-brand" aria-label="AwardPing home">
            <BrandLogo />
          </Link>

          <SiteHeaderNav />

          <div className="app-header-actions">
            {user ? (
              <ProfileMenu
                email={user.email}
                fullName={profile?.full_name}
                showAdminLink={isSiteAdmin}
              />
            ) : (
              <Link href="/login" className="button-secondary">
                Log in
              </Link>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}
