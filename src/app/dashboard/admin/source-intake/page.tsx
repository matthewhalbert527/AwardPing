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

export default async function AdminSourceIntakePage({
  searchParams = Promise.resolve({}),
}: {
  searchParams?: Promise<{ request?: string | string[]; award?: string | string[] }>;
} = {}) {
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

  const params = await searchParams;
  const requestParam = params.request;
  if (requestParam !== undefined && (typeof requestParam !== "string" || requestParam.length !== 36 ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestParam))) {
    return (
      <AdminSourceIntakeShell>
        <section className="card p-6" role="alert">
          <h1 className="admin-page-title">Source intake</h1>
          <p className="mt-2 text-[var(--muted)]">
            Enter exactly one valid request ID (UUID). No requests were loaded.
          </p>
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- Full navigation clears stale request and award-selection state. */}
          <a className="button-secondary mt-4" href="/dashboard/admin/source-intake">
            All recent requests
          </a>
        </section>
      </AdminSourceIntakeShell>
    );
  }
  const requestId = requestParam?.toLowerCase();
  const awardParam = params.award;
  const awardQuery = typeof awardParam === "string" ? awardParam.trim() : "";
  if (awardParam !== undefined && (typeof awardParam !== "string" || awardParam.length > 80 ||
      /[\u0000-\u001f\u007f*]/.test(awardParam) || (awardQuery.length > 0 && awardQuery.length < 2))) {
    return (
      <AdminSourceIntakeShell>
        <section className="card p-6" role="alert">
          <h1 className="admin-page-title">Source intake</h1>
          <p className="mt-2 text-[var(--muted)]">
            Enter one award name using 2–80 characters without an asterisk (*), or leave it empty to clear the search. No requests or awards were loaded.
          </p>
        </section>
        <AwardSearchForm requestId={requestId} query="" />
      </AdminSourceIntakeShell>
    );
  }

  const admin = createSupabaseAdminClient();
  let requestsQuery = admin
    .from("source_page_requests")
    .select("*")
    .order("updated_at", { ascending: false });
  requestsQuery = requestId ? requestsQuery.eq("id", requestId).limit(1) : requestsQuery.limit(100);
  let awardsQuery = admin.from("shared_awards").select("id,name,slug").eq("status", "active");
  if (awardQuery) {
    // Escape SQL LIKE metacharacters; PostgREST's additional * wildcard alias is rejected above.
    awardsQuery = awardsQuery.ilike("name", `%${awardQuery.replace(/[\\%_]/g, "\\$&")}%`);
  }
  const [requestsResult, awardsResult] = await Promise.all([
    requestsQuery,
    awardsQuery.order("name", { ascending: true }).order("id", { ascending: true }).limit(51),
  ]);

  const loadErrors = [requestsResult.error?.message, awardsResult.error?.message].filter(Boolean);
  const requests = (requestsResult.error ? [] : requestsResult.data || []).slice(0, requestId ? 1 : 100) as SourceIntakeRequestView[];
  const existingAwardIds = [...new Set(requests.flatMap(request =>
    [request.matched_shared_award_id, request.created_shared_award_id].filter((id): id is string => Boolean(id))))].sort();
  // At most two stored associations per visible request: 2 for one request, 200 for the recent 100.
  const matchedAwardsResult = existingAwardIds.length
    ? await admin.from("shared_awards").select("id,name,slug").in("id", existingAwardIds)
      .order("name", { ascending: true }).order("id", { ascending: true }).limit(existingAwardIds.length)
    : { data: [], error: null };
  const matchedAwards = (matchedAwardsResult.error ? [] : matchedAwardsResult.data || []) as SourceIntakeAwardOption[];
  const matchedIds = new Set(matchedAwards.map(award => award.id));
  const existingMatchesUnavailable = Boolean(matchedAwardsResult.error) || existingAwardIds.some(id => !matchedIds.has(id));
  if (existingMatchesUnavailable) {
    loadErrors.push("Existing award matches could not be loaded. Matching controls are unavailable until those matches can be shown correctly.");
  }
  const searchResults = (awardsResult.error ? [] : awardsResult.data || []) as SourceIntakeAwardOption[];
  const hasMoreAwards = searchResults.length > 50;
  const awardOptions = [...new Map([...searchResults.slice(0, 50), ...matchedAwards].map(award => [award.id, award])).values()]
    .sort((a, b) => a.name.localeCompare(b.name, "en") || a.id.localeCompare(b.id));

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

      <AwardSearchForm requestId={requestId} query={awardQuery} />
      {!awardsResult.error && (
        <p className="text-sm text-[var(--muted)]" role="status">
          {awardQuery
            ? searchResults.length === 0
              ? `No active awards match “${awardQuery}”.`
              : hasMoreAwards
                ? "Showing the first 50 matching awards. More matches exist; refine your search."
                : `Showing ${searchResults.length} matching ${searchResults.length === 1 ? "award" : "awards"}.`
            : "Showing up to 50 active awards alphabetically. Search by name to find any award."}
          {" Existing award matches are also included."}
        </p>
      )}

      {requestId && (
        <section className="card flex flex-wrap items-center justify-between gap-3 p-4" aria-label="Request filter">
          <div>
            <h2 className="font-bold">Viewing one request</h2>
            <p className="mt-1 break-all text-sm text-[var(--muted)]">{requestId}</p>
          </div>
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- Full navigation clears stale request and award-selection state. */}
          <a className="button-secondary" href="/dashboard/admin/source-intake">
            All recent requests
          </a>
        </section>
      )}

      {requestId && !requestsResult.error && requests.length === 0 && (
        <p className="card p-5 text-[var(--muted)]" role="status">No request found for this ID.</p>
      )}

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

      {!existingMatchesUnavailable && <AdminSourceIntakePanel initialRequests={requests} awardOptions={awardOptions} />}
    </AdminSourceIntakeShell>
  );
}

function AwardSearchForm({ requestId, query }: { requestId?: string; query: string }) {
  // Native GET/clear navigation also resets unsaved selections when the available options change.
  return (
    <form action="/dashboard/admin/source-intake" method="get" className="card flex flex-wrap items-end gap-3 p-4" aria-label="Search awards">
      {requestId && <input type="hidden" name="request" value={requestId} />}
      <div className="min-w-0 flex-1">
        <label htmlFor="source-intake-award-search" className="font-bold">Find an award</label>
        <input id="source-intake-award-search" type="search" name="award" defaultValue={query}
          minLength={2} maxLength={80} placeholder="Search all active awards by name" className="mt-2 w-full" />
      </div>
      <button type="submit" className="button-secondary">Search awards</button>
      {query && <a className="button-secondary" href={requestId ? `/dashboard/admin/source-intake?request=${requestId}` : "/dashboard/admin/source-intake"}>Clear search</a>}
    </form>
  );
}

function AdminSourceIntakeShell({ children }: { children: React.ReactNode }) {
  return <div className="admin-page mx-auto w-full max-w-[90rem]">{children}</div>;
}
