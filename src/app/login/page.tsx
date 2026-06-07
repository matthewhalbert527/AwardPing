import Link from "next/link";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AuthForm } from "@/components/auth-form";
import { SetupNotice } from "@/components/setup-notice";
import { SiteHeader } from "@/components/site-header";
import { getCurrentUser } from "@/lib/auth";
import { hasSupabaseConfig } from "@/lib/config";
import { getOnboardingStatus, onboardingRedirectPath } from "@/lib/onboarding";

export const metadata: Metadata = {
  title: "Log in",
};

type Props = {
  searchParams: Promise<{ next?: string }>;
};

export default async function LoginPage({ searchParams }: Props) {
  const user = await getCurrentUser();
  if (user) {
    const status = await getOnboardingStatus(user);
    redirect(onboardingRedirectPath(status));
  }

  const nextPath = safeNextPath((await searchParams).next || null);

  return (
    <div className="page-shell">
      <SiteHeader />
      <main className="mx-auto flex max-w-md flex-col px-5 py-16">
        <div className="card rounded-3xl p-6">
          <h1 className="text-3xl font-black">Log in</h1>
          <p className="mt-2 text-sm text-[var(--muted)]">
            Open your AwardPing dashboard.
          </p>
          <div className="mt-6">
            {hasSupabaseConfig() ? <AuthForm mode="login" nextPath={nextPath} /> : <SetupNotice />}
          </div>
          <p className="mt-5 text-sm text-[var(--muted)]">
            No account?{" "}
            <Link className="font-bold text-[var(--brand)]" href="/signup">
              Sign up for free
            </Link>
          </p>
        </div>
      </main>
    </div>
  );
}

function safeNextPath(value: string | null) {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "";
  return value;
}
