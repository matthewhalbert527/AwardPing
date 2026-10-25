import Link from "next/link";
import { ProgramFactReviewBoard } from "@/components/program-fact-review-board";
import { SetupNotice } from "@/components/setup-notice";
import { isSiteAdminEmail, requireUser } from "@/lib/auth";
import { hasSupabaseAdminConfig, hasSupabaseConfig } from "@/lib/config";
import { loadProgramFactBatch } from "@/lib/program-fact-review.server";

export const dynamic = "force-dynamic";

export default async function AdminProgramFactsPage() {
  if (!hasSupabaseConfig()) return <SetupNotice />;
  const user = await requireUser();
  if (!isSiteAdminEmail(user.email)) return <ReviewShell><p className="card p-6">This page is limited to AwardPing site admins.</p></ReviewShell>;
  if (!hasSupabaseAdminConfig()) return <ReviewShell><p className="card p-6">Supabase service-role access is not configured for this deployment.</p></ReviewShell>;

  // No approval or publication is performed while rendering this page.
  let batch: Awaited<ReturnType<typeof loadProgramFactBatch>>;
  try { batch = await loadProgramFactBatch(); }
  catch { return <ReviewShell><section className="card p-6" role="alert"><h1 className="admin-page-title">Current award details</h1><p className="mt-2">The current 25-award review batch could not be loaded. No approvals or public details were changed. Reload to try again.</p></section></ReviewShell>; }

  return <ReviewShell><ProgramFactReviewBoard initialAwards={batch.awards} initialPublication={batch.publication} /></ReviewShell>;
}

function ReviewShell({ children }: { children: React.ReactNode }) {
  return <div className="admin-page mx-auto w-full max-w-[90rem]"><Link className="mb-4 inline-block text-sm underline" href="/dashboard/admin/issues">Admin workflows</Link>{children}</div>;
}
