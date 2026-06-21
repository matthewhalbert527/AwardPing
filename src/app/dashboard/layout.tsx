import { Suspense } from "react";
import Link from "next/link";
import { Inbox, ListChecks, SearchCheck } from "lucide-react";
import { DashboardNav } from "@/components/dashboard-nav";
import { OfficeSwitcher } from "@/components/office-switcher";
import { ProfileMenu } from "@/components/profile-menu";
import { BrandLogo } from "@/components/brand-logo";
import { getCurrentUser, getUserProfile } from "@/lib/auth";
import { getOfficeContext } from "@/lib/offices";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getCurrentUser();
  const profile = user ? await getUserProfile(user.id) : null;
  const officeContext = user ? await getOfficeContext(user) : null;
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
              {user && <ProfileMenu email={user.email} fullName={profile?.full_name} />}
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
        href="/dashboard"
      >
        <Inbox size={16} aria-hidden="true" />
        Updates
      </Link>
      <Link className="dashboard-nav-link dashboard-nav-link-database" href="/dashboard/awards">
        <SearchCheck size={16} aria-hidden="true" />
        Database
      </Link>
      <Link
        className="dashboard-nav-link dashboard-nav-link-watchlist"
        href="/dashboard/awards?view=watchlist"
      >
        <ListChecks size={16} aria-hidden="true" />
        Watchlist
      </Link>
    </nav>
  );
}
