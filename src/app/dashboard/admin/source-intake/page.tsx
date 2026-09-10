import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { SetupNotice } from "@/components/setup-notice";
import {
  AdminSourceIntakePanel,
  type SourceIntakeAwardOption,
  type SourceIntakeRequestView,
} from "@/components/admin-source-intake-panel";
import { requireUser, isSiteAdminEmail } from "@/lib/auth";
import { appConfig, hasSupabaseAdminConfig, hasSupabaseConfig } from "@/lib/config";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export default async function AdminSourceIntakePage() {
  if (!hasSupabaseConfig()) return <SetupNotice />;

  const user = await requireUser();
  if (!isSiteAdminEmail(user.email)) {
    return (
      <AdminSourceIntakeShell>
        <div className="card p-6">
          <h1 className="admin-page-title">Source intake</h1>
          <p className="mt-2 text-[var(--muted)]">
            This page is limited to AwardPing site admins
            {appConfig.adminEmails.length ? "." : ". Set AWARDPING_ADMIN_EMAILS to enable access."}
          </p>
        </div>
      </AdminSourceIntakeShell>
    );
  }

  if (!hasSupabaseAdminConfig()) {
    return (
      <AdminSourceIntakeShell>
        <div className="card p-6">
          <h1 className="admin-page-title">Source intake</h1>
          <p className="mt-2 text-[var(--muted)]">
            Supabase service-role access is not configured for this deployment.
          </p>
        </div>
      </AdminSourceIntakeShell>
    );
  }

  const admin = createSupabaseAdminClient();
  const [requestsResult, awardsResult] = await Promise.all([
    admin
      .from("source_page_requests")
      .select("*")
      .order("updated_at", { ascending: false })
      .limit(100),
    admin
      .from("shared_awards")
      .select("id,name,slug")
      .eq("status", "active")
      .order("name", { ascending: true })
      .limit(750),
  ]);

  const loadErrors = [requestsResult.error?.message, awardsResult.error?.message].filter(Boolean);
  const requests = (requestsResult.data || []) as SourceIntakeRequestView[];
  const awardOptions = (awardsResult.data || []) as SourceIntakeAwardOption[];

  return (
    <AdminSourceIntakeShell>
      <div className="admin-page-header">
        <div>
          <h1 className="admin-page-title">Source intake</h1>
          <p className="admin-page-copy">
            Review official source URLs and match them to awards before monitoring.
          </p>
        </div>
        <Link className="button-secondary" href="/dashboard/admin/issues">
          Admin workflows
        </Link>
      </div>

      {loadErrors.length > 0 && (
        <section className="card border-[var(--brand-pink)] p-5">
          <div className="flex items-start gap-3">
            <AlertTriangle size={18} aria-hidden="true" />
            <div>
              <h2 className="font-bold">Some source-intake data could not be loaded</h2>
              <p className="mt-1 text-sm text-[var(--muted)]">{loadErrors.join(" ")}</p>
            </div>
          </div>
        </section>
      )}

      <AdminSourceIntakePanel initialRequests={requests} awardOptions={awardOptions} />
    </AdminSourceIntakeShell>
  );
}

function AdminSourceIntakeShell({ children }: { children: React.ReactNode }) {
  return <div className="admin-page mx-auto w-full max-w-[90rem]">{children}</div>;
}
