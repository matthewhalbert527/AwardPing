import Link from "next/link";
import type { Metadata } from "next";
import { PasswordRecoveryRequestForm } from "@/components/password-recovery-request-form";
import { SetupNotice } from "@/components/setup-notice";
import { SiteHeader } from "@/components/site-header";
import { hasSupabaseConfig } from "@/lib/config";

export const metadata: Metadata = {
  title: "Reset password",
  robots: { index: false, follow: false },
};

export default function ForgotPasswordPage() {
  return (
    <div className="page-shell">
      <SiteHeader />
      <main className="mx-auto flex max-w-md flex-col px-5 py-16">
        <div className="card rounded-3xl p-6">
          <h1 className="text-3xl font-bold">Reset your password</h1>
          <p className="mt-2 text-sm text-[var(--muted)]">
            Enter the email for your invited AwardPing account. We will send a
            one-time link if that account exists.
          </p>
          <div className="mt-6">
            {hasSupabaseConfig() ? (
              <PasswordRecoveryRequestForm />
            ) : (
              <SetupNotice />
            )}
          </div>
          <p className="mt-5 text-sm text-[var(--muted)]">
            <Link className="font-bold text-[var(--brand)]" href="/login">
              Return to login
            </Link>
          </p>
        </div>
      </main>
    </div>
  );
}
