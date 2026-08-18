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
      <main className="mx-auto flex max-w-md flex-col px-5 py-16">
        <div className="card rounded-3xl p-6">
          <h1 className="text-3xl font-bold">Choose a new password</h1>
          <p className="mt-2 text-sm text-[var(--muted)]">
            Your one-time recovery link was verified. Set a new password for
            your invited account.
          </p>
          <div className="mt-6">
            <PasswordUpdateForm nextPath={nextPath} />
          </div>
        </div>
      </main>
    </div>
  );
}
