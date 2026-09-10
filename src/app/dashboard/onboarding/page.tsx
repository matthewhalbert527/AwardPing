import Link from "next/link";
import { redirect } from "next/navigation";
import { OfficeNameForm, ProfileSettingsForm } from "@/components/office-forms";
import { SetupNotice } from "@/components/setup-notice";
import { requireUser } from "@/lib/auth";
import { hasSupabaseConfig } from "@/lib/config";
import { canManageOffice } from "@/lib/offices";
import { editableOfficeName } from "@/lib/office-names";
import { getOnboardingStatus } from "@/lib/onboarding";

export default async function OnboardingPage() {
  if (!hasSupabaseConfig()) return <SetupNotice />;

  const user = await requireUser();
  const status = await getOnboardingStatus(user);

  if (status.isComplete) {
    redirect("/updates");
  }

  const officeContext = status.officeContext;
  const canManage = officeContext ? canManageOffice(officeContext.current.role) : false;

  return (
    <div className="dashboard-page">
      <div className="dashboard-page-header">
        <h1 className="dashboard-page-title">Finish setup</h1>
        <p className="dashboard-page-copy">
          Complete the details below to continue to award updates.
        </p>
      </div>

      <div className="grid gap-4">
        {status.needsProfile && (
          <ProfileSettingsForm
            initialFullName={status.profile?.full_name || ""}
            initialOrganization={status.profile?.organization || ""}
            reentryRequired={
              status.profile?.personal_data_reentry_required || false
            }
            legacyRecoveryAvailable={
              status.profile?.personal_data_legacy_recovery_available || false
            }
          />
        )}

        {status.needsOffice && canManage && officeContext && (
          <OfficeNameForm initialName={editableOfficeName(officeContext.current.officeName)} />
        )}

        {status.needsOffice && !canManage && (
          <section className="dashboard-panel dashboard-panel-pad">
            <h2 className="dashboard-panel-title">Office setup needed</h2>
            <p className="dashboard-panel-copy">
              Ask an office owner or admin to name this workspace before continuing.
            </p>
          </section>
        )}

        {!status.needsProfile && !status.needsOffice && (
          <section className="dashboard-panel dashboard-panel-pad">
            <h2 className="dashboard-panel-title">Setup complete</h2>
            <Link className="button-primary mt-4" href="/updates">
              Open updates
            </Link>
          </section>
        )}
      </div>
    </div>
  );
}
