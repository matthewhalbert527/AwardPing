import Link from "next/link";
import { AcceptInviteButton } from "@/components/accept-invite-button";
import { AuthForm } from "@/components/auth-form";
import { SetupNotice } from "@/components/setup-notice";
import { SiteHeader } from "@/components/site-header";
import { getCurrentUser } from "@/lib/auth";
import { hasSupabaseAdminConfig, hasSupabaseConfig } from "@/lib/config";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type Props = {
  params: Promise<{ token: string }>;
};

export default async function JoinOfficePage({ params }: Props) {
  const { token } = await params;
  const user = await getCurrentUser();
  const nextPath = `/join/${token}`;
  const preview = user ? null : await getInvitePreview(token);

  return (
    <div className="page-shell">
      <SiteHeader />
      <main className="mx-auto max-w-md px-5 py-16">
        <div className="card rounded-3xl p-6">
          <h1 className="text-3xl font-black">Join an AwardPing office</h1>
          <div className="mt-6">
            {user ? (
              <>
                <p className="mb-5 leading-7 text-[var(--muted)]">
                  Accept the invitation to add this shared awards workspace to
                  your account.
                </p>
                <AcceptInviteButton token={token} />
              </>
            ) : !hasSupabaseConfig() || !hasSupabaseAdminConfig() ? (
              <SetupNotice />
            ) : preview ? (
              <>
                <p className="mb-2 leading-7 text-[var(--muted)]">
                  Create the account invited to <strong>{preview.office_name}</strong>.
                </p>
                <p className="mb-6 text-sm text-[var(--muted)]">
                  This invitation is restricted to {preview.email_hint}.
                </p>
                <AuthForm
                  mode="signup"
                  inviteToken={token}
                  inviteEmailHint={preview.email_hint}
                  nextPath="/dashboard/onboarding"
                />
                <p className="mt-5 text-sm text-[var(--muted)]">
                  Already have an account?{" "}
                  <Link
                    className="font-bold text-[var(--brand)]"
                    href={`/login?next=${encodeURIComponent(nextPath)}`}
                  >
                    Log in
                  </Link>
                </p>
              </>
            ) : (
              <>
                <p className="leading-7 text-[var(--muted)]">
                  This invitation is unavailable. It may have expired, already
                  been accepted, or been replaced. Ask your office administrator
                  for a new invitation.
                </p>
                <Link className="button-secondary mt-6 inline-flex" href="/login">
                  Log in
                </Link>
              </>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

async function getInvitePreview(token: string) {
  const cleanToken = token.trim();
  if (
    !hasSupabaseConfig() ||
    !hasSupabaseAdminConfig() ||
    cleanToken.length < 8 ||
    cleanToken.length > 256 ||
    !/^[A-Za-z0-9_-]+$/.test(cleanToken)
  ) {
    return null;
  }

  const admin = createSupabaseAdminClient();
  const { data, error } = await admin.rpc("get_office_invite_signup_preview", {
    p_invite_secret: cleanToken,
  });

  if (error) {
    console.error("[invite-signup] preview failed", {
      code: error.code,
      message: error.message,
    });
    return null;
  }

  return data?.[0] || null;
}
