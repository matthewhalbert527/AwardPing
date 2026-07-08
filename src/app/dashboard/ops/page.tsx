import Link from "next/link";
import { SetupNotice } from "@/components/setup-notice";
import { requireUser } from "@/lib/auth";
import { hasSupabaseAdminConfig, hasSupabaseConfig } from "@/lib/config";
import type { Database } from "@/lib/database.types";
import { canManageOffice, requireOfficeContext } from "@/lib/offices";
import {
  dedupeChangeSummaries,
  displayChangeSummary,
  isUsefulChangeSummary,
} from "@/lib/change-summary";
import {
  isMonitorableOfficialSource,
} from "@/lib/source-url-policy";
import { readableSourceTitle } from "@/lib/display-text";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { formatCentralDateTime } from "@/lib/time-zone";

type JobRun = Database["public"]["Tables"]["job_runs"]["Row"];
type LocalWorkerRun = Database["public"]["Tables"]["local_worker_runs"]["Row"];

export default async function OpsPage() {
  if (!hasSupabaseConfig()) return <SetupNotice />;

  const user = await requireUser();
  const officeContext = await requireOfficeContext(user);
  const canManage = canManageOffice(officeContext.current.role);

  if (!canManage) {
    return (
      <div>
        <div className="mb-8">
          <span className="badge">Ops</span>
          <h1 className="mt-4 text-4xl font-black">Private beta health</h1>
        </div>
        <div className="card rounded-3xl p-6 text-[var(--muted)]">
          This view is available to office owners and admins.
        </div>
      </div>
    );
  }

  const supabase = await createSupabaseServerClient();
  const now = new Date().toISOString();
  const sevenDaysAgo = new Date(
    new Date(now).getTime() - 7 * 24 * 60 * 60 * 1000,
  ).toISOString();
  const [
    { count: dueCount },
    { count: errorCount },
    { data: errorMonitors },
    { data: failedDeliveries },
    { count: sharedSourceCount },
    { count: dueSharedSourceCount },
    { count: failedSharedSourceCount },
    { count: recentSharedChangeCount },
    { count: structureDueCount },
    { data: recentSharedSources },
    { data: recentSharedChanges },
    { data: structureErrors },
    { data: localWorkerRuns },
  ] = await Promise.all([
    supabase
      .from("monitors")
      .select("*", { count: "exact", head: true })
      .eq("office_id", officeContext.current.officeId)
      .eq("status", "active")
      .lte("next_check_at", now),
    supabase
      .from("monitors")
      .select("*", { count: "exact", head: true })
      .eq("office_id", officeContext.current.officeId)
      .eq("status", "error"),
    supabase
      .from("monitors")
      .select("id, label, url, last_error, last_checked_at")
      .eq("office_id", officeContext.current.officeId)
      .eq("status", "error")
      .order("updated_at", { ascending: false })
      .limit(8),
    supabase
      .from("alert_deliveries")
      .select("id, delivery_type, recipient, error, created_at")
      .eq("office_id", officeContext.current.officeId)
      .eq("status", "failed")
      .order("created_at", { ascending: false })
      .limit(8),
    supabase
      .from("shared_award_sources")
      .select("*", { count: "exact", head: true }),
    supabase
      .from("shared_award_sources")
      .select("*", { count: "exact", head: true })
      .lte("next_check_at", now),
    supabase
      .from("shared_award_sources")
      .select("*", { count: "exact", head: true })
      .not("last_error", "is", null),
    supabase
      .from("shared_award_change_events")
      .select("*", { count: "exact", head: true })
      .gte("detected_at", sevenDaysAgo),
    supabase
      .from("shared_awards")
      .select("*", { count: "exact", head: true })
      .eq("status", "active")
      .lte("next_structure_scan_at", now),
    supabase
      .from("shared_award_sources")
      .select("id, shared_award_id, title, url, page_type, last_checked_at, next_check_at, last_error")
      .order("last_checked_at", { ascending: false, nullsFirst: false })
      .limit(8),
    supabase
      .from("shared_award_change_events")
      .select("id, shared_award_id, source_title, source_url, source_page_type, summary, change_details, detected_at")
      .order("detected_at", { ascending: false })
      .limit(25),
    supabase
      .from("shared_awards")
      .select("id, name, structure_scan_error, last_structure_scan_at, next_structure_scan_at")
      .eq("status", "active")
      .not("structure_scan_error", "is", null)
      .order("updated_at", { ascending: false })
      .limit(6),
    supabase
      .from("local_worker_runs")
      .select("*")
      .order("started_at", { ascending: false })
      .limit(5),
  ]);

  let jobRuns: JobRun[] = [];
  let jobRunError: string | null = null;

  if (hasSupabaseAdminConfig()) {
    const admin = createSupabaseAdminClient();
    const { data, error } = await admin
      .from("job_runs")
      .select("*")
      .order("started_at", { ascending: false })
      .limit(10);

    if (error) {
      jobRunError = error.message;
    } else {
      jobRuns = data || [];
    }
  } else {
    jobRunError = "Supabase service role is not configured, so job runs cannot be read.";
  }

  const lastCheckRun = jobRuns.find((run) => run.job_name === "check-monitors");
  const lastDigestRun = jobRuns.find((run) => run.job_name === "send-digests");
  const workerRuns = (localWorkerRuns || []) as LocalWorkerRun[];
  const lastWorkerRun = workerRuns[0] || null;

  const sharedAwardIds = [
    ...new Set(
      [
        ...(recentSharedSources || []).map((source) => source.shared_award_id),
        ...(recentSharedChanges || []).map((change) => change.shared_award_id),
      ].filter(Boolean),
    ),
  ] as string[];
  const { data: sharedAwardRows } = sharedAwardIds.length
    ? await supabase
        .from("shared_awards")
        .select("id, name")
        .in("id", sharedAwardIds)
    : { data: [] };
  const sharedAwardName = new Map(
    (sharedAwardRows || []).map((award) => [award.id, award.name]),
  );
  const officialRecentSharedChanges = dedupeChangeSummaries(
    (recentSharedChanges || []).filter((change) =>
      isMonitorableOfficialSource({ url: change.source_url, page_type: change.source_page_type }) &&
        isUsefulChangeSummary(change.summary, change.change_details),
    ),
  ).slice(0, 6);
  const officialRecentSharedSources = (recentSharedSources || []).filter((source) =>
    isMonitorableOfficialSource(source),
  );

  return (
    <div>
      <div className="mb-8">
        <span className="badge">Ops</span>
        <h1 className="mt-4 text-4xl font-black">Private beta health</h1>
        <p className="mt-2 text-[var(--muted)]">
          Monitor cron runs, stuck pages, and failed alert delivery before inviting more advisors.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <MetricCard label="Due now" value={dueCount || 0} />
        <MetricCard label="Monitor errors" value={errorCount || 0} />
        <MetricCard label="Last check run" value={lastCheckRun ? lastCheckRun.status : "None"} />
        <MetricCard label="Last digest run" value={lastDigestRun ? lastDigestRun.status : "None"} />
      </div>

      <div className="mt-6 grid gap-4 md:grid-cols-5">
        <MetricCard label="Shared sources" value={sharedSourceCount || 0} />
        <MetricCard label="Sources due" value={dueSharedSourceCount || 0} />
        <MetricCard label="Source errors" value={failedSharedSourceCount || 0} />
        <MetricCard label="7-day updates" value={recentSharedChangeCount || 0} />
        <MetricCard label="Structure due" value={structureDueCount || 0} />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_0.9fr]">
        <section className="card rounded-3xl p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-2xl font-black">Local source worker</h2>
              <p className="mt-1 text-sm text-[var(--muted)]">
                Last run: {lastWorkerRun ? formatDate(lastWorkerRun.started_at) : "No run logged"}
              </p>
            </div>
            <StatusPill status={lastWorkerRun?.status || "running"} />
          </div>
          <div className="mt-5 grid gap-3">
            {workerRuns.map((run) => (
              <div
                className="rounded-2xl border border-[var(--line)] bg-[#f5f7ff] p-4"
                key={run.id}
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="font-black">{run.worker_name}</p>
                    <p className="text-sm text-[var(--muted)]">
                      {formatDate(run.started_at)}
                      {run.finished_at ? `, finished ${formatDate(run.finished_at)}` : ""}
                    </p>
                  </div>
                  <StatusPill status={run.status} />
                </div>
                <p className="mt-2 text-sm text-[var(--muted)]">
                  Checked {run.checked_count}, updated {run.changed_count}, discovered{" "}
                  {run.discovered_count}, failed {run.failed_count}
                  {run.ai_provider ? `, AI ${run.ai_provider}` : ""}
                </p>
                {run.error && <p className="mt-2 text-sm font-semibold text-[var(--foreground)]">{run.error}</p>}
              </div>
            ))}
            {workerRuns.length === 0 && (
              <p className="text-[var(--muted)]">
                No local worker run has been recorded yet.
              </p>
            )}
          </div>
        </section>

        <section className="card rounded-3xl p-6">
          <h2 className="text-2xl font-black">Recent source checks</h2>
          <div className="mt-5 grid gap-3">
            {officialRecentSharedSources.map((source) => (
              <a
                className="rounded-2xl border border-[var(--line)] bg-[#f5f7ff] p-4"
                href={source.url}
                key={source.id}
                rel="noreferrer"
                target="_blank"
              >
                <p className="font-black">
                  {sharedAwardName.get(source.shared_award_id) || source.title}
                </p>
                <p className="text-sm capitalize text-[var(--muted)]">
                  {source.page_type} - {source.last_checked_at ? formatDate(source.last_checked_at) : "Not checked"}
                </p>
                <p className="mt-1 truncate text-sm font-semibold text-[var(--brand)] underline">
                  {source.url}
                </p>
                {source.last_error && (
                  <p className="mt-2 text-sm font-semibold text-[var(--foreground)]">{source.last_error}</p>
                )}
              </a>
            ))}
            {officialRecentSharedSources.length === 0 && (
              <p className="text-[var(--muted)]">No shared source checks found.</p>
            )}
          </div>
        </section>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_0.9fr]">
        <section className="card rounded-3xl p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-2xl font-black">Recent cron runs</h2>
            <Link className="button-secondary" href="/award-directory">
              View award directory
            </Link>
          </div>
          <div className="mt-5 grid gap-3">
            {jobRuns.map((run) => (
              <div
                className="rounded-2xl border border-[var(--line)] bg-[#f5f7ff] p-4"
                key={run.id}
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="font-black">{run.job_name}</p>
                    <p className="text-sm text-[var(--muted)]">
                      Started {formatDate(run.started_at)}
                      {run.finished_at ? `, finished ${formatDate(run.finished_at)}` : ""}
                    </p>
                  </div>
                  <StatusPill status={run.status} />
                </div>
                <p className="mt-2 text-sm text-[var(--muted)]">
                  Processed {run.processed_count}
                </p>
                {run.error && <p className="mt-2 text-sm font-semibold text-[var(--foreground)]">{run.error}</p>}
              </div>
            ))}
            {jobRuns.length === 0 && (
              <p className="text-[var(--muted)]">
                {jobRunError || "No cron run has been recorded yet."}
              </p>
            )}
          </div>
        </section>

        <section className="card rounded-3xl p-6">
          <h2 className="text-2xl font-black">Needs attention</h2>
          <div className="mt-5 grid gap-4">
            <div>
              <h3 className="font-black">Monitor errors</h3>
              <div className="mt-3 grid gap-3">
                {(errorMonitors || []).map((monitor) => (
                  <div className="rounded-2xl border border-[var(--line)] bg-[#f5f7ff] p-4" key={monitor.id}>
                    <p className="font-bold">{monitor.label}</p>
                    <a
                      className="mt-1 block truncate text-sm font-semibold text-[var(--brand)] underline"
                      href={monitor.url}
                      rel="noreferrer"
                      target="_blank"
                    >
                      {monitor.url}
                    </a>
                    {monitor.last_error && (
                      <p className="mt-2 text-sm text-[var(--foreground)]">{monitor.last_error}</p>
                    )}
                  </div>
                ))}
                {(!errorMonitors || errorMonitors.length === 0) && (
                  <p className="text-sm text-[var(--muted)]">No monitor errors right now.</p>
                )}
              </div>
            </div>

            <div>
              <h3 className="font-black">Failed email deliveries</h3>
              <div className="mt-3 grid gap-3">
                {(failedDeliveries || []).map((delivery) => (
                  <div className="rounded-2xl border border-[var(--line)] bg-[#f5f7ff] p-4" key={delivery.id}>
                    <p className="font-bold capitalize">
                      {delivery.delivery_type} to {delivery.recipient}
                    </p>
                    <p className="text-sm text-[var(--muted)]">{formatDate(delivery.created_at)}</p>
                    {delivery.error && (
                      <p className="mt-2 text-sm text-[var(--foreground)]">{delivery.error}</p>
                    )}
                  </div>
                ))}
                {(!failedDeliveries || failedDeliveries.length === 0) && (
                  <p className="text-sm text-[var(--muted)]">No failed delivery rows found.</p>
                )}
              </div>
            </div>
          </div>
        </section>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_0.9fr]">
        <section className="card rounded-3xl p-6">
          <h2 className="text-2xl font-black">Recent shared updates</h2>
          <div className="mt-5 grid gap-3">
            {officialRecentSharedChanges.map((change) => (
              <article
                className="rounded-2xl border border-[var(--line)] bg-[#f5f7ff] p-4"
                key={change.id}
              >
                <p className="font-black">
                  {sharedAwardName.get(change.shared_award_id) ||
                    readableSourceTitle(change.source_title, change.source_url)}
                </p>
                <a
                  className="mt-1 block truncate text-sm font-semibold text-[var(--brand)] underline"
                  href={change.source_url}
                  rel="noreferrer"
                  target="_blank"
                >
                  Open official source
                </a>
                <p className="mt-2 text-sm text-[var(--muted)]">{formatDate(change.detected_at)}</p>
                <p className="mt-2 leading-7 text-[var(--muted)]">
                  {displayChangeSummary(change.summary, change.source_url, change.change_details)}
                </p>
              </article>
            ))}
            {officialRecentSharedChanges.length === 0 && (
              <p className="text-[var(--muted)]">No shared updates found.</p>
            )}
          </div>
        </section>

        <section className="card rounded-3xl p-6">
          <h2 className="text-2xl font-black">Structure scan errors</h2>
          <div className="mt-5 grid gap-3">
            {(structureErrors || []).map((award) => (
              <div
                className="rounded-2xl border border-[var(--line)] bg-[#f5f7ff] p-4"
                key={award.id}
              >
                <p className="font-black">{award.name}</p>
                <p className="mt-1 text-sm text-[var(--muted)]">
                  Last scan:{" "}
                  {award.last_structure_scan_at ? formatDate(award.last_structure_scan_at) : "Not scanned"}
                </p>
                {award.structure_scan_error && (
                  <p className="mt-2 text-sm font-semibold text-[var(--foreground)]">
                    {award.structure_scan_error}
                  </p>
                )}
              </div>
            ))}
            {(!structureErrors || structureErrors.length === 0) && (
              <p className="text-[var(--muted)]">No structure scan errors found.</p>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function MetricCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="card rounded-3xl p-6">
      <p className="text-sm font-bold uppercase text-[var(--muted)]">
        {label}
      </p>
      <p className="mt-3 text-3xl font-black capitalize">{value}</p>
    </div>
  );
}

function StatusPill({ status }: { status: JobRun["status"] | LocalWorkerRun["status"] }) {
  const label = status === "succeeded" ? "Succeeded" : status === "failed" ? "Failed" : "Running";
  return (
    <span className={status === "failed" ? "badge bg-[var(--brand-pink-soft)]" : "badge"}>
      {label}
    </span>
  );
}

function formatDate(value: string) {
  return formatCentralDateTime(value);
}
