import { Suspense } from "react";
import Link from "next/link";
import {
  Inbox,
  SearchCheck,
} from "lucide-react";
import { BrandLogo } from "@/components/brand-logo";
import { DashboardNav } from "@/components/dashboard-nav";
import { OfficeSwitcher } from "@/components/office-switcher";
import { ProfileMenu } from "@/components/profile-menu";
import { getCurrentUser, getUserProfile, isSiteAdminEmail } from "@/lib/auth";
import { getOfficeContext } from "@/lib/offices";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getCurrentUser();
  const profile = user ? await getUserProfile(user.id) : null;
  const officeContext = user ? await getOfficeContext(user) : null;
  const isSiteAdmin = isSiteAdminEmail(user?.email);
  const officeOptions =
    officeContext?.memberships.map((membership) => ({
      officeId: membership.officeId,
      officeName: membership.officeName,
    })) || [];

  return (
    <div className="dashboard-shell">
      <header className="dashboard-header">
        <div className="dashboard-header-shell">
          <div className="dashboard-header-bar">
            <Link href="/" className="brand-link dashboard-brand-link" aria-label="AwardPing home">
              <BrandLogo />
            </Link>

            <div className="dashboard-header-nav-wrap">
              <Suspense fallback={<DashboardNavFallback />}>
                <DashboardNav />
              </Suspense>
            </div>

            <div className="dashboard-header-actions">
              {officeContext && officeOptions.length > 1 && (
                <OfficeSwitcher
                  offices={officeOptions}
                  currentOfficeId={officeContext.current.officeId}
                />
              )}
              {user && (
                <ProfileMenu
                  email={user.email}
                  fullName={profile?.full_name}
                  showAdminLink={isSiteAdmin}
                />
              )}
            </div>
          </div>
        </div>
      </header>

      <main className="dashboard-content">{children}</main>
    </div>
  );
}

function DashboardNavFallback() {
  return (
    <nav className="dashboard-nav" aria-label="Dashboard navigation">
      <Link
        className="dashboard-nav-link dashboard-nav-link-updates dashboard-nav-link-active"
        href="/updates"
      >
        <Inbox size={16} aria-hidden="true" />
        Updates
      </Link>
      <Link className="dashboard-nav-link dashboard-nav-link-database" href="/award-directory">
        <SearchCheck size={16} aria-hidden="true" />
        Award Directory
      </Link>
    </nav>
  );
}
