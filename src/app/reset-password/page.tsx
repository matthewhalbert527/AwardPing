import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { PasswordUpdateForm } from "@/components/password-update-form";
import { SiteHeader } from "@/components/site-header";
import { getCurrentUser } from "@/lib/auth";
import { safeNextPath } from "@/lib/safe-next-path";

export const metadata: Metadata = {
  title: "Choose a new password",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

type Props = {
  searchParams: Promise<{ next?: string }>;
};

export default async function ResetPasswordPage({ searchParams }: Props) {
  const user = await getCurrentUser();
  if (!user) redirect("/login?recovery=invalid");

  const query = await searchParams;
  const nextPath = safeNextPath(query.next || null);

  return (
    <div className="page-shell">
      <SiteHeader />
      <main className="public-page-main public-page-main-narrow">
        <div className="card mx-auto max-w-md rounded-2xl p-6">
          <header className="public-page-heading">
            <h1>Choose a new password</h1>
            <p>
              Your one-time recovery link was verified. Set a new password for
              your invited account.
            </p>
          </header>
          <div className="mt-6">
            <PasswordUpdateForm nextPath={nextPath} />
          </div>
        </div>
      </main>
    </div>
  );
}
