import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Database,
  Eye,
  RefreshCcw,
  Sparkles,
} from "lucide-react";
import { SetupNotice } from "@/components/setup-notice";
import { requireUser, isSiteAdminEmail } from "@/lib/auth";
import { appConfig, hasSupabaseAdminConfig, hasSupabaseConfig } from "@/lib/config";
import type { Database as AwardPingDatabase, Json } from "@/lib/database.types";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type LocalWorkerRun = AwardPingDatabase["public"]["Tables"]["local_worker_runs"]["Row"];
type JobRun = AwardPingDatabase["public"]["Tables"]["job_runs"]["Row"];

type RecentSource = {
  id: string;
  shared_award_id: string;
  title: string;
  url: string;
  page_type: string;
  last_checked_at: string | null;
  next_check_at: string;
  last_error: string | null;
  consecutive_failures: number;
};

type RecentChange = {
  id: string;
  shared_award_id: string;
  source_title: string | null;
  source_url: string;
  summary: string;
  detected_at: string;
};

type SourceRequest = {
  id: string;
  award_name: string;
  homepage_url: string;
  status: string;
  created_at: string;
};

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  if (!hasSupabaseConfig()) return <SetupNotice />;

  const user = await requireUser();
  if (!isSiteAdminEmail(user.email)) {
    return <AdminAccessDenied configured={appConfig.adminEmails.length > 0} />;
  }

  if (!hasSupabaseAdminConfig()) {
    return (
      <AdminShell>
        <div className="card p-6">
          <span className="badge">Admin</span>
          <h1 className="mt-4 text-3xl font-black">Background scans</h1>
          <p className="mt-2 text-[var(--muted)]">
            Supabase service-role access is not configured for this deployment, so global scan
            details cannot be loaded.
          </p>
        </div>
      </AdminShell>
    );
  }

  const admin = createSupabaseAdminClient();
  const now = new Date();
  const nowIso = now.toISOString();
  const sevenDaysAgoIso = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const [
    { data: workerRunRows, error: workerRunError },
    { data: jobRunRows, error: jobRunError },
    { count: sharedSourceCount },
    { count: checkedSourceCount },
    { count: dueSourceCount },
    { count: failedSourceCount },
    { count: recentUpdateCount },
    { count: pendingRequestCount },
    { data: recentSourceRows },
    { data: recentChangeRows },
    { data: sourceRequestRows },
  ] = await Promise.all([
    admin.from("local_worker_runs").select("*").order("started_at", { ascending: false }).limit(30),
    admin.from("job_runs").select("*").order("started_at", { ascending: false }).limit(12),
    admin.from("shared_award_sources").select("*", { count: "exact", head: true }),
    admin
      .from("shared_award_sources")
      .select("*", { count: "exact", head: true })
      .not("last_checked_at", "is", null),
    admin
      .from("shared_award_sources")
      .select("*", { count: "exact", head: true })
      .lte("next_check_at", nowIso),
    admin
      .from("shared_award_sources")
      .select("*", { count: "exact", head: true })
      .not("last_error", "is", null),
    admin
      .from("shared_award_change_events")
      .select("*", { count: "exact", head: true })
      .gte("detected_at", sevenDaysAgoIso),
    admin
      .from("source_page_requests")
      .select("*", { count: "exact", head: true })
      .in("status", ["pending", "queued"]),
    admin
      .from("shared_award_sources")
      .select(
        "id, shared_award_id, title, url, page_type, last_checked_at, next_check_at, last_error, consecutive_failures",
      )
      .order("last_checked_at", { ascending: false, nullsFirst: false })
      .limit(8),
    admin
      .from("shared_award_change_events")
      .select("id, shared_award_id, source_title, source_url, summary, detected_at")
      .order("detected_at", { ascending: false })
      .limit(8),
    admin
      .from("source_page_requests")
      .select("id, award_name, homepage_url, status, created_at")
      .in("status", ["pending", "queued"])
      .order("created_at", { ascending: true })
      .limit(8),
  ]);

  const workerRuns = (workerRunRows || []) as LocalWorkerRun[];
  const jobRuns = (jobRunRows || []) as JobRun[];
  const recentSources = (recentSourceRows || []) as RecentSource[];
  const recentChanges = (recentChangeRows || []) as RecentChange[];
  const sourceRequests = (sourceRequestRows || []) as SourceRequest[];
  const sharedAwardIds = [
    ...new Set(
      [...recentSources.map((source) => source.shared_award_id), ...recentChanges.map((change) => change.shared_award_id)]
        .filter(Boolean),
    ),
  ];
  const { data: sharedAwards } = sharedAwardIds.length
    ? await admin.from("shared_awards").select("id, name").in("id", sharedAwardIds)
    : { data: [] };
  const sharedAwardName = new Map((sharedAwards || []).map((award) => [award.id, award.name]));

  const visualRuns = workerRuns.filter((run) => run.worker_name.includes("visual-snapshot"));
  const latestVisualRun = visualRuns[0] || null;
  const latestVisualMetadata = latestVisualRun ? metadataObject(latestVisualRun.metadata) : {};
  const latestVisualCounts = objectValue(latestVisualMetadata.counts);
  const latestGeminiUsage = objectValue(latestVisualMetadata.gemini_usage);
  const latestJobRun = jobRuns[0] || null;
  const sourceCoverage = percent(checkedSourceCount || 0, sharedSourceCount || 0);

  return (
    <AdminShell>
      <div className="mb-8">
        <span className="badge">Admin</span>
        <h1 className="mt-4 text-4xl font-black">Background scans</h1>
        <p className="mt-2 max-w-3xl text-[var(--muted)]">
          Owner-only status for the local visual snapshot worker, Supabase cron jobs, source
          coverage, and recent AwardPing updates.
        </p>
      </div>

      {(workerRunError || jobRunError) && (
        <section className="mb-6 card border-[var(--brand-pink)] p-5">
          <div className="flex items-start gap-3">
            <AlertTriangle size={18} aria-hidden="true" />
            <div>
              <h2 className="font-black">Some admin data could not be loaded</h2>
              <p className="mt-1 text-sm text-[var(--muted)]">
                {[workerRunError?.message, jobRunError?.message].filter(Boolean).join(" ")}
              </p>
            </div>
          </div>
        </section>
      )}

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          icon={Eye}
          label="Latest visual run"
          value={latestVisualRun ? statusLabel(latestVisualRun.status) : "None"}
          detail={latestVisualRun ? formatDate(latestVisualRun.started_at) : "No run logged"}
          attention={latestVisualRun?.status === "failed"}
        />
        <MetricCard
          icon={Database}
          label="Visual baselines"
          value={latestVisualRun ? formatNumber(latestVisualRun.initial_count) : "0"}
          detail={
            latestVisualRun
              ? `${formatNumber(latestVisualRun.checked_count)} checked in latest run`
              : "Waiting for first run"
          }
        />
        <MetricCard
          icon={Sparkles}
          label="Gemini calls"
          value={numberFromObject(latestGeminiUsage, "calls")}
          detail={`${formatNumber(numberFromObject(latestGeminiUsage, "total_tokens"))} local tokens recorded`}
        />
        <MetricCard
          icon={RefreshCcw}
          label="7-day updates"
          value={recentUpdateCount || 0}
          detail={latestJobRun ? `Last cron: ${latestJobRun.job_name}` : "Cron history unavailable"}
        />
      </section>

      <section className="mt-6 grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
        <div className="card p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <Eye size={18} aria-hidden="true" />
                <h2 className="text-2xl font-black">Visual snapshot worker</h2>
              </div>
              <p className="mt-2 text-sm text-[var(--muted)]">
                Daily screenshot comparisons are reported from the local PC worker. Full image
                archives stay on the worker machine.
              </p>
            </div>
            <StatusPill status={latestVisualRun?.status || "running"} />
          </div>

          <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <MiniStat label="Checked" value={latestVisualRun?.checked_count || 0} />
            <MiniStat label="Unchanged" value={latestVisualRun?.unchanged_count || 0} />
            <MiniStat label="True changes" value={latestVisualRun?.changed_count || 0} />
            <MiniStat label="Failed" value={latestVisualRun?.failed_count || 0} attention />
            <MiniStat label="PDF skipped" value={numberFromObject(latestVisualCounts, "skipped_pdf")} />
            <MiniStat label="AI rejected" value={numberFromObject(latestVisualCounts, "ai_rejected")} />
            <MiniStat label="Needs review" value={numberFromObject(latestVisualCounts, "review")} />
            <MiniStat label="Text-only ignored" value={numberFromObject(latestVisualCounts, "text_only_ignored")} />
          </div>

          <div className="mt-5 rounded-2xl border border-[var(--line)] bg-[#f5f7ff] p-4">
            <h3 className="font-black">Latest run detail</h3>
            {latestVisualRun ? (
              <dl className="mt-3 grid gap-3 text-sm text-[var(--muted)] sm:grid-cols-2">
                <Detail label="Started" value={formatDate(latestVisualRun.started_at)} />
                <Detail label="Finished" value={latestVisualRun.finished_at ? formatDate(latestVisualRun.finished_at) : "Still running"} />
                <Detail label="AI provider" value={latestVisualRun.ai_provider || "none"} />
                <Detail label="Archive root" value={stringFromObject(latestVisualMetadata, "archive_root") || "Local worker default"} />
                <Detail label="Gemini prompt tokens" value={formatNumber(numberFromObject(latestGeminiUsage, "prompt_tokens"))} />
                <Detail label="Gemini candidate tokens" value={formatNumber(numberFromObject(latestGeminiUsage, "candidates_tokens"))} />
              </dl>
            ) : (
              <p className="mt-3 text-sm text-[var(--muted)]">
                No visual worker run has been recorded in Supabase yet.
              </p>
            )}
          </div>
        </div>

        <div className="card p-6">
          <div className="flex items-center gap-2">
            <Database size={18} aria-hidden="true" />
            <h2 className="text-2xl font-black">Source coverage</h2>
          </div>
          <div className="mt-5 grid gap-3">
            <MiniStat label="Tracked source pages" value={sharedSourceCount || 0} />
            <MiniStat label="Checked at least once" value={checkedSourceCount || 0} />
            <MiniStat label="Due now" value={dueSourceCount || 0} attention={Boolean(dueSourceCount)} />
            <MiniStat label="With errors" value={failedSourceCount || 0} attention={Boolean(failedSourceCount)} />
          </div>
          <div className="mt-5">
            <div className="flex items-center justify-between text-sm font-bold text-[var(--muted)]">
              <span>Database check coverage</span>
              <span>{sourceCoverage}%</span>
            </div>
            <div className="mt-2 h-3 overflow-hidden rounded-full bg-[var(--brand-blue-soft)]">
              <div
                className="h-full rounded-full bg-[var(--brand)]"
                style={{ width: `${sourceCoverage}%` }}
              />
            </div>
          </div>
          <p className="mt-4 text-sm text-[var(--muted)]">
            Visual screenshot baselines are disk-backed, so this coverage bar reflects the
            Supabase source table. The latest visual worker counts above show image baseline
            progress.
          </p>
        </div>
      </section>

      <section className="mt-6 grid gap-6 xl:grid-cols-[1fr_1fr]">
        <RecentRuns runs={workerRuns} />
        <CronRuns runs={jobRuns} />
      </section>

      <section className="mt-6 grid gap-6 xl:grid-cols-[1fr_1fr]">
        <RecentSources sources={recentSources} awardNames={sharedAwardName} />
        <RecentUpdates changes={recentChanges} awardNames={sharedAwardName} />
      </section>

      <section className="mt-6 card p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-2xl font-black">Queued source requests</h2>
            <p className="mt-1 text-sm text-[var(--muted)]">
              {formatNumber(pendingRequestCount || 0)} pending or queued request
              {(pendingRequestCount || 0) === 1 ? "" : "s"}.
            </p>
          </div>
          <Link href="/dashboard/awards?view=request" className="button-secondary">
            Review sources
          </Link>
        </div>
        <div className="mt-5 grid gap-3">
          {sourceRequests.map((request) => (
            <div className="rounded-2xl border border-[var(--line)] bg-[#f5f7ff] p-4" key={request.id}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-black">{request.award_name}</p>
                  <a
                    className="mt-1 block truncate text-sm font-semibold text-[var(--brand)] underline"
                    href={request.homepage_url}
                    rel="noreferrer"
                    target="_blank"
                  >
                    {request.homepage_url}
                  </a>
                </div>
                <span className="badge capitalize">{request.status}</span>
              </div>
              <p className="mt-2 text-sm text-[var(--muted)]">Requested {formatDate(request.created_at)}</p>
            </div>
          ))}
          {sourceRequests.length === 0 && (
            <p className="text-sm text-[var(--muted)]">No queued source requests right now.</p>
          )}
        </div>
      </section>
    </AdminShell>
  );
}

function AdminShell({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-7xl">{children}</div>;
}

function AdminAccessDenied({ configured }: { configured: boolean }) {
  return (
    <AdminShell>
      <div className="card p-6">
        <span className="badge">Admin</span>
        <h1 className="mt-4 text-3xl font-black">Background scans</h1>
        <p className="mt-2 text-[var(--muted)]">
          This page is limited to AwardPing site admins
          {configured ? "." : ". Set AWARDPING_ADMIN_EMAILS to enable access."}
        </p>
      </div>
    </AdminShell>
  );
}

function MetricCard({
  icon: Icon,
  label,
  value,
  detail,
  attention = false,
}: {
  icon: typeof Activity;
  label: string;
  value: string | number;
  detail: string;
  attention?: boolean;
}) {
  return (
    <div className={`dashboard-metric-card ${attention ? "dashboard-metric-card-attention" : ""}`}>
      <div className="flex items-center justify-between gap-3">
        <p className="dashboard-metric-label">{label}</p>
        <Icon size={18} aria-hidden="true" />
      </div>
      <p className="dashboard-metric-value">{value}</p>
      <p className="mt-2 text-sm font-semibold text-[var(--muted)]">{detail}</p>
    </div>
  );
}

function MiniStat({
  label,
  value,
  attention = false,
}: {
  label: string;
  value: string | number;
  attention?: boolean;
}) {
  return (
    <div className={`rounded-2xl border border-[var(--line)] bg-[#f5f7ff] p-4 ${attention ? "border-[var(--brand-pink)]" : ""}`}>
      <p className="text-xs font-black uppercase text-[var(--muted)]">{label}</p>
      <p className="mt-2 text-2xl font-black">{typeof value === "number" ? formatNumber(value) : value}</p>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-black uppercase">{label}</dt>
      <dd className="mt-1 break-words font-semibold text-[var(--foreground)]">{value}</dd>
    </div>
  );
}

function RecentRuns({ runs }: { runs: LocalWorkerRun[] }) {
  return (
    <section className="card p-6">
      <div className="flex items-center gap-2">
        <Activity size={18} aria-hidden="true" />
        <h2 className="text-2xl font-black">Recent worker runs</h2>
      </div>
      <div className="mt-5 grid gap-3">
        {runs.slice(0, 10).map((run) => (
          <div className="rounded-2xl border border-[var(--line)] bg-[#f5f7ff] p-4" key={run.id}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="font-black">{workerRunLabel(run.worker_name)}</p>
                <p className="text-sm text-[var(--muted)]">
                  {formatDate(run.started_at)}
                  {run.finished_at ? `, finished ${formatDate(run.finished_at)}` : ""}
                </p>
              </div>
              <StatusPill status={run.status} />
            </div>
            <p className="mt-2 text-sm text-[var(--muted)]">
              Checked {formatNumber(run.checked_count)}, baselined {formatNumber(run.initial_count)}, changed{" "}
              {formatNumber(run.changed_count)}, failed {formatNumber(run.failed_count)}
            </p>
            {run.error && <p className="mt-2 text-sm font-semibold">{run.error}</p>}
          </div>
        ))}
        {runs.length === 0 && <p className="text-sm text-[var(--muted)]">No worker runs recorded.</p>}
      </div>
    </section>
  );
}

function CronRuns({ runs }: { runs: JobRun[] }) {
  return (
    <section className="card p-6">
      <div className="flex items-center gap-2">
        <Clock3 size={18} aria-hidden="true" />
        <h2 className="text-2xl font-black">Cron and updates</h2>
      </div>
      <div className="mt-5 grid gap-3">
        {runs.map((run) => (
          <div className="rounded-2xl border border-[var(--line)] bg-[#f5f7ff] p-4" key={run.id}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="font-black">{jobRunLabel(run.job_name)}</p>
                <p className="text-sm text-[var(--muted)]">
                  Started {formatDate(run.started_at)}
                  {run.finished_at ? `, finished ${formatDate(run.finished_at)}` : ""}
                </p>
              </div>
              <StatusPill status={run.status} />
            </div>
            <p className="mt-2 text-sm text-[var(--muted)]">
              Processed {formatNumber(run.processed_count)}
            </p>
            {run.error && <p className="mt-2 text-sm font-semibold">{run.error}</p>}
          </div>
        ))}
        {runs.length === 0 && <p className="text-sm text-[var(--muted)]">No cron runs recorded.</p>}
      </div>
    </section>
  );
}

function RecentSources({
  sources,
  awardNames,
}: {
  sources: RecentSource[];
  awardNames: Map<string, string>;
}) {
  return (
    <section className="card p-6">
      <div className="flex items-center gap-2">
        <CheckCircle2 size={18} aria-hidden="true" />
        <h2 className="text-2xl font-black">Recent source checks</h2>
      </div>
      <div className="mt-5 grid gap-3">
        {sources.map((source) => (
          <a
            className="rounded-2xl border border-[var(--line)] bg-[#f5f7ff] p-4"
            href={source.url}
            key={source.id}
            rel="noreferrer"
            target="_blank"
          >
            <p className="font-black">{awardNames.get(source.shared_award_id) || source.title}</p>
            <p className="text-sm capitalize text-[var(--muted)]">
              {source.page_type} - {source.last_checked_at ? formatDate(source.last_checked_at) : "Not checked"}
            </p>
            <p className="mt-1 truncate text-sm font-semibold text-[var(--brand)] underline">{source.url}</p>
            {source.last_error && <p className="mt-2 text-sm font-semibold">{source.last_error}</p>}
          </a>
        ))}
        {sources.length === 0 && <p className="text-sm text-[var(--muted)]">No source checks recorded.</p>}
      </div>
    </section>
  );
}

function RecentUpdates({
  changes,
  awardNames,
}: {
  changes: RecentChange[];
  awardNames: Map<string, string>;
}) {
  return (
    <section className="card p-6">
      <div className="flex items-center gap-2">
        <RefreshCcw size={18} aria-hidden="true" />
        <h2 className="text-2xl font-black">Recent updates</h2>
      </div>
      <div className="mt-5 grid gap-3">
        {changes.map((change) => (
          <article className="rounded-2xl border border-[var(--line)] bg-[#f5f7ff] p-4" key={change.id}>
            <p className="font-black">{awardNames.get(change.shared_award_id) || change.source_title || "Shared award"}</p>
            <a
              className="mt-1 block truncate text-sm font-semibold text-[var(--brand)] underline"
              href={change.source_url}
              rel="noreferrer"
              target="_blank"
            >
              {change.source_url}
            </a>
            <p className="mt-2 text-sm text-[var(--muted)]">{formatDate(change.detected_at)}</p>
            <p className="mt-2 text-sm leading-6 text-[var(--muted)]">{change.summary}</p>
          </article>
        ))}
        {changes.length === 0 && <p className="text-sm text-[var(--muted)]">No recent updates recorded.</p>}
      </div>
    </section>
  );
}

function StatusPill({ status }: { status: "running" | "succeeded" | "failed" }) {
  return (
    <span className={status === "failed" ? "badge bg-[var(--brand-pink-soft)]" : "badge"}>
      {statusLabel(status)}
    </span>
  );
}

function statusLabel(status: string) {
  if (status === "succeeded") return "Succeeded";
  if (status === "failed") return "Failed";
  return "Running";
}

function workerRunLabel(value: string) {
  return value
    .replace(/^local-/, "")
    .replaceAll("-", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function jobRunLabel(value: string) {
  return value === "send-digests" ? "Send digests" : "Check monitors";
}

function formatDate(value: string) {
  return new Date(value).toLocaleString();
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

function percent(value: number, total: number) {
  if (total <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((value / total) * 100)));
}

function metadataObject(value: Json | undefined): Record<string, unknown> {
  return objectValue(value);
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function numberFromObject(value: Record<string, unknown>, key: string) {
  const number = Number(value[key]);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

function stringFromObject(value: Record<string, unknown>, key: string) {
  const raw = value[key];
  return typeof raw === "string" ? raw : "";
}
