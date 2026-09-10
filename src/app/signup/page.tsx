import Link from "next/link";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { SiteHeader } from "@/components/site-header";
import { getCurrentUser } from "@/lib/auth";
import { getOnboardingStatus, onboardingRedirectPath } from "@/lib/onboarding";

export const metadata: Metadata = {
  title: "Invitation Required",
  robots: {
    index: false,
    follow: false,
  },
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
      <main className="public-page-main public-page-main-narrow">
        <div className="card mx-auto max-w-xl rounded-2xl p-6">
          <header className="public-page-heading">
            <h1>Invitation required</h1>
            <p>
              New accounts can only be created from a valid office invitation.
              Open the private invitation link your office sent you to continue.
            </p>
          </header>
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
