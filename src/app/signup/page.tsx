import Link from "next/link";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { SiteHeader } from "@/components/site-header";
import { getCurrentUser } from "@/lib/auth";
import { getOnboardingStatus, onboardingRedirectPath } from "@/lib/onboarding";

export const metadata: Metadata = {
  title: "Invitation Required",
};

export default async function SignupPage() {
  const user = await getCurrentUser();
  if (user) {
    const status = await getOnboardingStatus(user);
    redirect(onboardingRedirectPath(status));
  }

  return (
    <div className="page-shell">
      <SiteHeader />
      <main className="mx-auto flex max-w-xl flex-col px-5 py-16">
        <div className="card rounded-3xl p-6">
          <h1 className="text-3xl font-black">AwardPing is invitation-only</h1>
          <p className="mt-3 leading-7 text-[var(--muted)]">
            New beta accounts can only be created from a valid office invitation.
            Open the private invitation link your office sent you to continue.
          </p>
          <p className="mt-5 text-sm text-[var(--muted)]">
            Already have an AwardPing account?{" "}
            <Link className="font-bold text-[var(--brand)]" href="/login">
              Log in
            </Link>
          </p>
        </div>
      </main>
    </div>
  );
}
