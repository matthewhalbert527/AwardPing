import {
  InviteMemberForm,
  MemberPreferenceSelect,
  MemberRoleSelect,
  OfficeNameForm,
  ProfileSettingsForm,
} from "@/components/office-forms";
import { SetupNotice } from "@/components/setup-notice";
import { requireUser } from "@/lib/auth";
import { appConfig, hasSupabaseConfig } from "@/lib/config";
import type { Database } from "@/lib/database.types";
import { editableOfficeName } from "@/lib/office-names";
import { canManageOffice, requireOfficeContext } from "@/lib/offices";
import { createSupabaseServerClient } from "@/lib/supabase/server";

type InviteRow = Database["public"]["Tables"]["office_invites"]["Row"];

export default async function OfficePage() {
  if (!hasSupabaseConfig()) return <SetupNotice />;

  const user = await requireUser();
  const officeContext = await requireOfficeContext(user);
  const canManage = canManageOffice(officeContext.current.role);
  const supabase = await createSupabaseServerClient();

  const { data: members } = await supabase
    .from("office_members")
    .select("*")
    .eq("office_id", officeContext.current.officeId)
    .eq("status", "active")
    .order("created_at", { ascending: true });

  const { data: invites } = canManage
    ? await supabase
        .from("office_invites")
        .select("*")
        .eq("office_id", officeContext.current.officeId)
        .is("accepted_at", null)
        .order("created_at", { ascending: false })
    : { data: [] as InviteRow[] };

  const { data: profile } = await supabase
    .from("profiles")
    .select("full_name, organization")
    .eq("id", user.id)
    .maybeSingle();

  return (
    <div className="dashboard-page">
      <div className="dashboard-page-header">
        <span className="badge w-fit">Settings</span>
        <h1 className="dashboard-page-title">Office settings</h1>
        <p className="dashboard-page-copy">
          Manage your profile, shared advisor access, and each member&apos;s alert preference.
        </p>
      </div>

      <div className="grid gap-4">
        <ProfileSettingsForm
          initialFullName={profile?.full_name || ""}
          initialOrganization={profile?.organization || ""}
        />
        {canManage && (
          <OfficeNameForm initialName={editableOfficeName(officeContext.current.officeName)} />
        )}
        {canManage && <InviteMemberForm />}

        <section className="dashboard-panel dashboard-panel-pad" id="notification-preferences">
          <h2 className="dashboard-panel-title">Watchlist notifications</h2>
          <p className="dashboard-panel-copy">
            Choose how each advisor receives email alerts for pages tracked by this office.
          </p>
          <div className="dashboard-list">
            {(members || [])
              .map((member) => (
                <div
                  className="dashboard-list-item flex flex-col gap-3 md:flex-row md:items-center md:justify-between"
                  key={member.id}
                >
                  <div>
                    <p className="font-black">{member.email || "Advisor"}</p>
                    <p className="text-sm capitalize text-[var(--muted)]">
                      {member.role === "owner" ? "Owner/admin" : member.role}
                    </p>
                  </div>
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                    <MemberPreferenceSelect
                      memberId={member.id}
                      value={member.notification_preference}
                    />
                    {canManage && (
                      <MemberRoleSelect
                        memberId={member.id}
                        value={member.role}
                        disabled={member.user_id === user.id}
                      />
                    )}
                  </div>
                </div>
              ))}
          </div>
        </section>

        {canManage && (
          <section className="dashboard-panel dashboard-panel-pad">
            <h2 className="dashboard-panel-title">Pending invites</h2>
            <div className="dashboard-list">
              {(invites || []).map((invite) => (
                <div
                  className="dashboard-list-item flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between"
                  key={invite.id}
                >
                  <div>
                    <p className="font-bold">{invite.email || "Invite code"}</p>
                    <p className="text-sm capitalize text-[var(--muted)]">
                      {invite.role} - code{" "}
                      <span className="font-mono">{invite.invite_code}</span>
                    </p>
                    <p className="mt-1 truncate text-sm font-semibold text-[var(--brand)] underline">
                      {`${appConfig.url}/join/${invite.invite_code}`}
                    </p>
                  </div>
                  <p className="text-sm text-[var(--muted)]">
                    Expires {new Date(invite.expires_at).toLocaleDateString()}
                  </p>
                </div>
              ))}
              {(!invites || invites.length === 0) && (
                <p className="text-[var(--muted)]">No pending invites.</p>
              )}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
