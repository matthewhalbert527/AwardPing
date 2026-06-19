import { DashboardNav } from "@/components/dashboard-nav";
import { OfficeSwitcher } from "@/components/office-switcher";
import { ProfileMenu } from "@/components/profile-menu";
import { BrandLogo } from "@/components/brand-logo";
import { getCurrentUser, getUserProfile, isSiteAdminEmail } from "@/lib/auth";
import { getOfficeContext } from "@/lib/offices";
import Link from "next/link";
import { Suspense } from "react";

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
              <Suspense fallback={<div className="dashboard-nav" aria-hidden="true" />}>
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
