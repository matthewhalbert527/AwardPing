import Link from "next/link";
import { AcceptInviteButton } from "@/components/accept-invite-button";
import { SiteHeader } from "@/components/site-header";
import { getCurrentUser } from "@/lib/auth";

type Props = {
  params: Promise<{ token: string }>;
};

export default async function JoinOfficePage({ params }: Props) {
  const { token } = await params;
  const user = await getCurrentUser();
  const nextPath = `/join/${token}`;

  return (
    <div className="page-shell">
      <SiteHeader />
      <main className="mx-auto max-w-md px-5 py-16">
        <div className="card rounded-3xl p-6">
          <h1 className="text-3xl font-black">Join an AwardPing office</h1>
          <p className="mt-3 leading-7 text-[var(--muted)]">
            Log in or sign up, then accept the invitation to join the shared
            university awards workspace.
          </p>
          <div className="mt-6">
            {user ? (
              <AcceptInviteButton token={token} />
            ) : (
              <div className="flex flex-col gap-3 sm:flex-row">
                <Link className="button-primary" href={`/login?next=${encodeURIComponent(nextPath)}`}>
                  Log in
                </Link>
                <Link className="button-secondary" href={`/signup?next=${encodeURIComponent(nextPath)}`}>
                  Create account
                </Link>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
