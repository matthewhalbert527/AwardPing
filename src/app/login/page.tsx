import Link from "next/link";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AuthForm } from "@/components/auth-form";
import { SetupNotice } from "@/components/setup-notice";
import { SiteHeader } from "@/components/site-header";
import { getCurrentUser } from "@/lib/auth";
import { hasSupabaseConfig } from "@/lib/config";
import { getOnboardingStatus, onboardingRedirectPath } from "@/lib/onboarding";
import { safeNextPath } from "@/lib/safe-next-path";

export const metadata: Metadata = {
  title: "Log in",
};

type Props = {
  searchParams: Promise<{
    next?: string;
    account?: string;
    confirmation?: string;
  }>;
};

export default async function LoginPage({ searchParams }: Props) {
  const user = await getCurrentUser();
  if (user) {
    const status = await getOnboardingStatus(user);
    redirect(onboardingRedirectPath(status));
  }

  const query = await searchParams;
  const nextPath = safeNextPath(query.next || null);
  const statusMessage = query.account === "created"
    ? "Your invited account was created. Log in to continue."
    : query.confirmation === "invalid"
      ? "That confirmation link is invalid or expired. Request a new invitation from your office administrator."
      : null;

  return (
    <div className="page-shell">
      <SiteHeader />
      <main className="mx-auto flex max-w-md flex-col px-5 py-16">
        <div className="card rounded-3xl p-6">
          <h1 className="text-3xl font-black">Log in</h1>
          <p className="mt-2 text-sm text-[var(--muted)]">
            Open your AwardPing dashboard.
          </p>
          {statusMessage && (
            <p className="mt-4 rounded-xl border border-[var(--line)] bg-[var(--panel-soft)] p-3 text-sm">
              {statusMessage}
            </p>
          )}
          <div className="mt-6">
            {hasSupabaseConfig() ? <AuthForm mode="login" nextPath={nextPath} /> : <SetupNotice />}
          </div>
          <p className="mt-5 text-sm text-[var(--muted)]">
            New accounts require a secure office invitation.{" "}
            <Link className="font-bold text-[var(--brand)]" href="/contact">
              Request beta access
            </Link>
          </p>
        </div>
      </main>
    </div>
  );
}
