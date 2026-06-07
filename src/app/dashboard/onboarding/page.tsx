import Link from "next/link";
import { redirect } from "next/navigation";
import { CheckCircle2, CircleDashed } from "lucide-react";
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
    redirect("/dashboard");
  }

  const officeContext = status.officeContext;
  const canManage = officeContext ? canManageOffice(officeContext.current.role) : false;

  return (
    <div className="dashboard-page">
      <div className="dashboard-page-header">
        <h1 className="dashboard-page-title">Finish your AwardPing setup</h1>
        <p className="dashboard-page-copy">
          Add the profile and office details AwardPing needs before opening the
          dashboard.
        </p>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <OnboardingStep
          complete={!status.needsProfile}
          title="Profile"
          text="Your name and university or organization."
        />
        <OnboardingStep
          complete={!status.needsOffice}
          title="Office"
          text="The office workspace your alerts and watchlist belong to."
        />
        <OnboardingStep
          complete
          title="Watchlist"
          text="New offices start with the core nationally competitive awards."
        />
      </div>

      <div className="grid gap-4">
        {status.needsProfile && (
          <ProfileSettingsForm
            initialFullName={status.profile?.full_name || ""}
            initialOrganization={status.profile?.organization || ""}
          />
        )}

        {status.needsOffice && canManage && officeContext && (
          <OfficeNameForm initialName={editableOfficeName(officeContext.current.officeName)} />
        )}

        {status.needsOffice && !canManage && (
          <section className="dashboard-panel dashboard-panel-pad">
            <h2 className="dashboard-panel-title">Office setup needed</h2>
            <p className="dashboard-panel-copy">
              Ask an office owner or admin to rename this workspace before using
              the shared dashboard.
            </p>
          </section>
        )}

        {!status.needsProfile && !status.needsOffice && (
          <section className="dashboard-panel dashboard-panel-pad">
            <h2 className="dashboard-panel-title">Setup complete</h2>
            <Link className="button-primary mt-4" href="/dashboard">
              Open dashboard
            </Link>
          </section>
        )}
      </div>
    </div>
  );
}

function OnboardingStep({
  complete,
  title,
  text,
}: {
  complete: boolean;
  title: string;
  text: string;
}) {
  const Icon = complete ? CheckCircle2 : CircleDashed;

  return (
    <section className="dashboard-panel dashboard-panel-pad">
      <div className="flex items-start gap-3">
        <span
          className={`mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
            complete
              ? "bg-[#eaf5ff] text-[var(--brand)]"
              : "bg-[#f5f7ff] text-[var(--muted)]"
          }`}
        >
          <Icon size={19} aria-hidden="true" />
        </span>
        <div>
          <h2 className="text-lg font-black">{title}</h2>
          <p className="mt-1 text-sm leading-6 text-[var(--muted)]">{text}</p>
        </div>
      </div>
    </section>
  );
}
