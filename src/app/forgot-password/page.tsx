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
      <main className="public-page-main public-page-main-narrow">
        <div className="card mx-auto max-w-md rounded-2xl p-6">
          <header className="public-page-heading">
            <h1>Reset your password</h1>
            <p>
              Enter the email for your invited AwardPing account. We will send a
              one-time link if that account exists.
            </p>
          </header>
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
