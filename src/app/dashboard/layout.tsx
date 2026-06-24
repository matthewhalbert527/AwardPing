import { Suspense } from "react";
import Link from "next/link";
import { Activity, AlertTriangle, ChevronDown, Inbox, ListChecks, SearchCheck } from "lucide-react";
import { DashboardNav } from "@/components/dashboard-nav";
import { OfficeSwitcher } from "@/components/office-switcher";
import { ProfileMenu } from "@/components/profile-menu";
import { BrandLogo } from "@/components/brand-logo";
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
              <Suspense fallback={<DashboardNavFallback isSiteAdmin={isSiteAdmin} />}>
                <DashboardNav isSiteAdmin={isSiteAdmin} />
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

function DashboardNavFallback({ isSiteAdmin }: { isSiteAdmin: boolean }) {
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
      {isSiteAdmin && (
        <div className="dashboard-nav-admin-menu">
          <Link className="dashboard-nav-link dashboard-nav-link-admin" href="/dashboard/admin">
            <Activity size={16} aria-hidden="true" />
            Admin
            <ChevronDown className="dashboard-nav-caret" size={14} aria-hidden="true" />
          </Link>
          <div className="dashboard-nav-admin-dropdown" role="menu">
            <Link className="dashboard-nav-admin-item" href="/dashboard/admin" role="menuitem">
              <Activity size={15} aria-hidden="true" />
              <span>Page data</span>
            </Link>
            <Link className="dashboard-nav-admin-item" href="/dashboard/admin/issues" role="menuitem">
              <AlertTriangle size={15} aria-hidden="true" />
              <span>Issues</span>
            </Link>
          </div>
        </div>
      )}
    </nav>
  );
}
