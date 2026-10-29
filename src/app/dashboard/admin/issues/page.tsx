import { AdminAlertReviewBoard } from "@/components/admin-alert-review-board";
import { SetupNotice } from "@/components/setup-notice";
import { requireUser, isSiteAdminEmail } from "@/lib/auth";
import { hasSupabaseAdminConfig, hasSupabaseConfig } from "@/lib/config";
import { loadAlertReviews } from "@/lib/alert-review.server";

export const dynamic = "force-dynamic";

export default async function AdminAlertReviewsPage() {
  if (!hasSupabaseConfig()) return <SetupNotice />;
  const user = await requireUser();
  if (!isSiteAdminEmail(user.email)) return <div className="card p-6">This page is limited to AwardPing site admins.</div>;
  if (!hasSupabaseAdminConfig()) return <div className="card p-6">Alert review is unavailable. Please check the server configuration.</div>;
  let alerts: Awaited<ReturnType<typeof loadAlertReviews>>;
  try { alerts = await loadAlertReviews("pending"); }
  catch { return <section className="card p-6" role="alert"><h1 className="admin-page-title">Review alerts</h1><p className="mt-2">The review queue could not be loaded. Reload to try again. No decisions changed.</p></section>; }
  return <div className="admin-page mx-auto w-full max-w-5xl"><AdminAlertReviewBoard initialAlerts={alerts} initialStatus="pending" /></div>;
}
