import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Database,
  Gauge,
  PlayCircle,
  ServerCog,
  Sparkles,
} from "lucide-react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SetupNotice } from "@/components/setup-notice";
import { requireUser, isSiteAdminEmail } from "@/lib/auth";
import { countActiveOpenSourcesWithVisualSnapshots } from "@/lib/admin-page-issues";
import { appConfig, hasSupabaseAdminConfig, hasSupabaseConfig } from "@/lib/config";
import type { Database as AwardPingDatabase, Json } from "@/lib/database.types";
import {
  DEFAULT_BASELINE_COST_CAP_USD,
  GEMINI_BATCH_COST_PER_SOURCE_USD,
  MAINTENANCE_PROFILE_IDS,
  MAINTENANCE_PROFILES,
} from "@/lib/maintenance-profiles";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { formatCentralDateTime } from "@/lib/time-zone";

type AdminClient = SupabaseClient<AwardPingDatabase>;
type LocalWorkerRun = AwardPingDatabase["public"]["Tables"]["local_worker_runs"]["Row"];
type IconComponent = typeof Activity;

type CycleCoverage = {
  scannedSources: number;
  sourcesWithFacts: number;
  missingFacts: number;
  sourcesWithCycleRelevance: number;
  missingCycleRelevance: number;
  rejectedFacts: number;
  currentOrUpcoming: number;
  evergreen: number;
  archivedOrPast: number;
  notProgramPage: number;
  unclear: number;
};

type AdminSourceCounts = {
  activeAwards: number;
  openSources: number;
  reviewLaterSources: number;
  openWithMetadata: number;
  openWithoutMetadata: number;
  openWithVisualSnapshots: number;
  openMissingVisualSnapshots: number;
  sourceErrors: number;
  staleChecks: number;
  cycleCoverage: CycleCoverage;
  recentRuns: LocalWorkerRun[];
  loadErrors: string[];
};

type MaintenanceRunPhase = {
  name: string;
  status: string;
  started_at?: string;
  finished_at?: string | null;
  exit_code?: number | null;
  log_path?: string;
};

type MaintenanceRunView = {
  run: LocalWorkerRun;
  metadata: Record<string, unknown>;
  profile: string;
  reportPath: string;
  phases: MaintenanceRunPhase[];
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
          <h1 className="mt-4 text-3xl font-black">Maintenance</h1>
          <p className="mt-2 text-[var(--muted)]">
            Supabase service-role access is not configured for this deployment.
          </p>
        </div>
      </AdminShell>
    );
  }

  const admin = createSupabaseAdminClient();
  const counts = await loadAdminSourceCounts(admin);
  const latestMaintenance = latestMaintenanceRun(counts.recentRuns);
  const renderedAt = new Date().toISOString();
  const metadataPercent = percent(counts.openWithMetadata, counts.openSources);
  const cyclePercent = percent(
    counts.cycleCoverage.sourcesWithCycleRelevance,
    Math.max(1, counts.cycleCoverage.sourcesWithFacts),
  );
  const visualPercent = percent(counts.openWithVisualSnapshots, counts.openSources);
  const estimatedCatchupCost = counts.openSources * GEMINI_BATCH_COST_PER_SOURCE_USD;
  const geminiBlocked = recentRunsIncludeGeminiCreditBlock(counts.recentRuns);

  return (
    <AdminShell>
      <div className="admin-page-header">
        <div>
          <span className="badge">Admin</span>
          <h1 className="admin-page-title">Maintenance</h1>
          <p className="admin-page-copy">
            Source cleanup, visual snapshots, Gemini Batch facts, public fact aggregation, and
            snapshot retention are now organized behind one runner.
          </p>
          <p className="admin-page-timestamp">
            Page data refreshed {formatDate(renderedAt)}.
          </p>
        </div>
        <Link className="button-secondary" href="/dashboard/admin/issues">
          <AlertTriangle size={16} aria-hidden="true" />
          Page Issues
        </Link>
      </div>

      {counts.loadErrors.length > 0 && (
        <section className="card border-[var(--brand-pink)] p-5">
          <div className="flex items-start gap-3">
            <AlertTriangle size={18} aria-hidden="true" />
            <div>
              <h2 className="font-black">Some admin data could not be loaded</h2>
              <p className="mt-1 text-sm text-[var(--muted)]">{counts.loadErrors.join(" ")}</p>
            </div>
          </div>
        </section>
      )}

      {geminiBlocked && (
        <section className="card border-[var(--brand-pink)] p-5">
          <div className="flex items-start gap-3">
            <AlertTriangle size={18} aria-hidden="true" />
            <div>
              <h2 className="font-black">Gemini credits need attention</h2>
              <p className="mt-1 text-sm text-[var(--muted)]">
                Recent worker logs include Gemini prepayment or depleted-credit errors, so catch-up
                work will stall until billing is restored.
              </p>
            </div>
          </div>
        </section>
      )}

      <section className="admin-metric-grid admin-metric-grid-primary">
        <MetricCard
          icon={ServerCog}
          label="Worker Control"
          value="Local Only"
          detail="Start and stop workers from the local command center; this page reflects the latest reported status."
        />
        <MetricCard
          icon={Database}
          label="Open Sources"
          value={formatNumber(counts.openSources)}
          detail={`${formatNumber(counts.activeAwards)} active awards; ${formatNumber(counts.reviewLaterSources)} sources in review later`}
        />
        <MetricCard
          icon={Sparkles}
          label="Cycle Relevance"
          value={`${cyclePercent}%`}
          detail={`${formatNumber(counts.cycleCoverage.missingCycleRelevance)} fact rows still need the new current-cycle field`}
          attention={counts.cycleCoverage.missingCycleRelevance > 0}
        />
        <MetricCard
          icon={Gauge}
          label="Gemini Catch-Up"
          value={`~$${formatUsd(estimatedCatchupCost)}`}
          detail={`${formatNumber(counts.openSources)} open pages at the historical batch average`}
          attention={geminiBlocked}
        />
        <MetricCard
          icon={Clock3}
          label="Recent Runner"
          value={latestMaintenance ? statusLabel(latestMaintenance.run.status) : "None"}
          detail={latestMaintenance ? latestMaintenanceDetail(latestMaintenance) : "No local command-center run has been reported yet"}
        />
      </section>

      <section className="admin-dashboard-grid">
        <div className="card admin-section-card admin-dashboard-card admin-maintenance-control-card">
          <div className="admin-panel-heading">
            <div className="flex items-center gap-2">
              <PlayCircle size={18} aria-hidden="true" />
              <h2>Local Command Center</h2>
            </div>
            <StatusPill status="ready" />
          </div>
          <p className="text-sm font-semibold leading-6 text-[var(--muted)]">
            Worker control stays on the Windows PC. Run these commands from
            <span className="font-mono"> C:\Users\matth\Documents\AwardPing Project</span>;
            this admin page will refresh from Supabase worker status rows.
          </p>
          <div className="grid gap-3">
            <CommandLine command="npm run command:center -- status" />
            <CommandLine command="npm run command:center -- start --profile=catchup --apply=true --baseline-cost-cap-usd=10" />
            <CommandLine command="npm run command:center -- profiles" />
          </div>
        </div>

        <div className="card admin-section-card admin-dashboard-card">
          <div className="admin-panel-heading">
            <div className="flex items-center gap-2">
              <Sparkles size={18} aria-hidden="true" />
              <h2>Data Coverage</h2>
            </div>
            <span className="badge">{metadataPercent}% facts</span>
          </div>
          <div className="admin-stat-grid admin-stat-grid-compact">
            <MiniStat label="Metadata" value={`${formatNumber(counts.openWithMetadata)} / ${formatNumber(counts.openSources)}`} />
            <MiniStat label="Missing info" value={counts.openWithoutMetadata} attention={counts.openWithoutMetadata > 0} />
            <MiniStat label="Visuals" value={`${visualPercent}%`} attention={counts.openMissingVisualSnapshots > 0} />
            <MiniStat label="No visuals" value={counts.openMissingVisualSnapshots} attention={counts.openMissingVisualSnapshots > 0} />
            <MiniStat label="Source errors" value={counts.sourceErrors} attention={counts.sourceErrors > 0} />
            <MiniStat label="Stale checks" value={counts.staleChecks} attention={counts.staleChecks > 0} />
          </div>
          <DetailDisclosure label="Cycle relevance">
            <div className="admin-stat-grid admin-stat-grid-compact">
              <MiniStat label="Current" value={counts.cycleCoverage.currentOrUpcoming} />
              <MiniStat label="Evergreen" value={counts.cycleCoverage.evergreen} />
              <MiniStat label="Archived" value={counts.cycleCoverage.archivedOrPast} />
              <MiniStat label="Not program" value={counts.cycleCoverage.notProgramPage} />
              <MiniStat label="Unclear" value={counts.cycleCoverage.unclear} />
              <MiniStat label="Rejected" value={counts.cycleCoverage.rejectedFacts} />
            </div>
          </DetailDisclosure>
        </div>

        <div className="card admin-section-card admin-dashboard-card">
          <div className="admin-panel-heading">
            <div className="flex items-center gap-2">
              <Activity size={18} aria-hidden="true" />
              <h2>Latest Report</h2>
            </div>
            {latestMaintenance && <StatusPill status={latestMaintenance.run.status} />}
          </div>
          {latestMaintenance ? (
            <>
              <dl className="admin-detail-grid admin-detail-grid-tight">
                <Detail label="Profile" value={latestMaintenance.profile || "Unknown"} />
                <Detail label="Started" value={formatDate(latestMaintenance.run.started_at)} />
                <Detail label="Finished" value={latestMaintenance.run.finished_at ? formatDate(latestMaintenance.run.finished_at) : "Still running"} />
                <Detail label="Report" value={latestMaintenance.reportPath || "Supabase status only"} />
              </dl>
              <div className="admin-flow-list admin-flow-list-compact">
                {latestMaintenance.phases.slice(0, 8).map((phase) => (
                  <PipelineRow
                    detail={phase.finished_at ? `Finished ${formatDate(phase.finished_at)}` : "Still running"}
                    icon={phase.status === "failed" ? AlertTriangle : CheckCircle2}
                    key={`${phase.name}-${phase.started_at}`}
                    status={statusLabel(phase.status || "running")}
                    title={phase.name || "phase"}
                    attention={phase.status === "failed"}
                  />
                ))}
              </div>
            </>
          ) : (
            <p className="text-sm text-[var(--muted)]">
              No local command-center maintenance run has been written to Supabase yet.
            </p>
          )}
        </div>
      </section>

      <section className="admin-dashboard-grid">
        <div className="card admin-section-card admin-dashboard-card">
          <div className="admin-panel-heading">
            <div className="flex items-center gap-2">
              <ServerCog size={18} aria-hidden="true" />
              <h2>Profiles</h2>
            </div>
          </div>
          <div className="admin-flow-list admin-flow-list-compact">
            {MAINTENANCE_PROFILE_IDS.map((profile) => (
              <PipelineRow
                detail={MAINTENANCE_PROFILES[profile].detail}
                icon={MAINTENANCE_PROFILES[profile].primary ? PlayCircle : Activity}
                key={profile}
                status={MAINTENANCE_PROFILES[profile].phases.join(" -> ")}
                title={MAINTENANCE_PROFILES[profile].label}
              />
            ))}
          </div>
        </div>

        <div className="card admin-section-card admin-dashboard-card">
          <div className="admin-panel-heading">
            <div className="flex items-center gap-2">
              <Clock3 size={18} aria-hidden="true" />
              <h2>Recent Worker Activity</h2>
            </div>
          </div>
          <div className="admin-flow-list admin-flow-list-compact">
            {counts.recentRuns.slice(0, 8).map((run) => (
              <PipelineRow
                detail={`${formatDate(run.started_at)}; checked ${formatNumber(run.checked_count)}, changed ${formatNumber(run.changed_count)}, failed ${formatNumber(run.failed_count)}`}
                icon={run.status === "failed" ? AlertTriangle : Activity}
                key={run.id}
                status={statusLabel(run.status)}
                title={run.worker_name}
                attention={run.status === "failed"}
              />
            ))}
            {counts.recentRuns.length === 0 && (
              <p className="text-sm text-[var(--muted)]">
                No local worker runs have been recorded yet.
              </p>
            )}
          </div>
        </div>

        <div className="card admin-section-card admin-dashboard-card">
          <div className="admin-panel-heading">
            <div className="flex items-center gap-2">
              <Gauge size={18} aria-hidden="true" />
              <h2>Catch-Up Budget</h2>
            </div>
          </div>
          <div className="admin-stat-grid admin-stat-grid-compact">
            <MiniStat label="Open pages" value={counts.openSources} />
            <MiniStat label="Avg/page" value={`$${formatUsd(GEMINI_BATCH_COST_PER_SOURCE_USD)}`} />
            <MiniStat label="Estimate" value={`$${formatUsd(estimatedCatchupCost)}`} attention={geminiBlocked} />
            <MiniStat label="Default cap" value={`$${formatUsd(DEFAULT_BASELINE_COST_CAP_USD)}`} />
          </div>
          <p className="text-sm font-semibold leading-6 text-[var(--muted)]">
            The estimate uses the observed Gemini Batch average from previous AwardPing runs.
          </p>
        </div>
      </section>
    </AdminShell>
  );
}

async function loadAdminSourceCounts(admin: AdminClient): Promise<AdminSourceCounts> {
  const staleCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const [
    activeAwards,
    openSources,
    reviewLaterSources,
    openWithMetadata,
    sourceErrors,
    staleChecks,
    recentRuns,
    visualSnapshotCount,
    cycleCoverageResult,
  ] = await Promise.all([
    admin.from("shared_awards").select("id", { count: "exact", head: true }).eq("status", "active"),
    admin
      .from("shared_award_sources")
      .select("id, shared_awards!inner(status)", { count: "exact", head: true })
      .eq("shared_awards.status", "active")
      .eq("admin_review_status", "open"),
    admin
      .from("shared_award_sources")
      .select("id, shared_awards!inner(status)", { count: "exact", head: true })
      .eq("shared_awards.status", "active")
      .eq("admin_review_status", "review_later"),
    admin
      .from("shared_award_sources")
      .select("id, shared_awards!inner(status)", { count: "exact", head: true })
      .eq("shared_awards.status", "active")
      .eq("admin_review_status", "open")
      .not("page_metadata_generated_at", "is", null),
    admin
      .from("shared_award_sources")
      .select("id, shared_awards!inner(status)", { count: "exact", head: true })
      .eq("shared_awards.status", "active")
      .eq("admin_review_status", "open")
      .not("last_error", "is", null),
    admin
      .from("shared_award_sources")
      .select("id, shared_awards!inner(status)", { count: "exact", head: true })
      .eq("shared_awards.status", "active")
      .eq("admin_review_status", "open")
      .lt("last_checked_at", staleCutoff),
    admin.from("local_worker_runs").select("*").order("started_at", { ascending: false }).limit(20),
    countActiveOpenSourcesWithVisualSnapshots(admin),
    loadCycleCoverageResult(admin),
  ]);

  const loadErrors = [
    activeAwards.error?.message,
    openSources.error?.message,
    reviewLaterSources.error?.message,
    openWithMetadata.error?.message,
    sourceErrors.error?.message,
    staleChecks.error?.message,
    recentRuns.error?.message,
    visualSnapshotCount.error?.message,
    cycleCoverageResult.error,
  ].filter((message): message is string => Boolean(message));

  const openSourceCount = openSources.count || 0;
  const openWithMetadataCount = openWithMetadata.count || 0;
  const openWithVisualSnapshots = visualSnapshotCount.count || 0;
  return {
    activeAwards: activeAwards.count || 0,
    openSources: openSourceCount,
    reviewLaterSources: reviewLaterSources.count || 0,
    openWithMetadata: openWithMetadataCount,
    openWithoutMetadata: Math.max(0, openSourceCount - openWithMetadataCount),
    openWithVisualSnapshots,
    openMissingVisualSnapshots: Math.max(0, openSourceCount - openWithVisualSnapshots),
    sourceErrors: sourceErrors.count || 0,
    staleChecks: staleChecks.count || 0,
    cycleCoverage: cycleCoverageResult.coverage,
    recentRuns: (recentRuns.data || []) as LocalWorkerRun[],
    loadErrors,
  };
}

async function loadCycleCoverageResult(admin: AdminClient) {
  try {
    return { coverage: await loadCycleCoverage(admin), error: "" };
  } catch (error) {
    return {
      coverage: emptyCycleCoverage(),
      error: error instanceof Error ? error.message : "Cycle relevance coverage could not be loaded.",
    };
  }
}

async function loadCycleCoverage(admin: AdminClient): Promise<CycleCoverage> {
  const coverage = emptyCycleCoverage();

  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin
      .from("shared_award_sources")
      .select("id, page_metadata, shared_awards!inner(status)")
      .eq("shared_awards.status", "active")
      .eq("admin_review_status", "open")
      .not("page_metadata_generated_at", "is", null)
      .range(from, from + 999);

    if (error) throw new Error(error.message);
    const rows = (data || []) as Array<{ page_metadata: Json }>;
    for (const row of rows) {
      coverage.scannedSources += 1;
      const metadata = objectValue(row.page_metadata);
      if (
        metadata.baseline_facts_rejected === true ||
        objectValue(metadata.baseline_facts_metadata).rejected === true
      ) {
        coverage.rejectedFacts += 1;
      }

      const facts = objectValue(metadata.baseline_facts || metadata.baselineFacts);
      if (Object.keys(facts).length === 0) {
        coverage.missingFacts += 1;
        continue;
      }

      coverage.sourcesWithFacts += 1;
      const cycleRelevance = cleanKey(facts.cycle_relevance);
      if (!cycleRelevance) {
        coverage.missingCycleRelevance += 1;
        continue;
      }

      coverage.sourcesWithCycleRelevance += 1;
      if (cycleRelevance === "current_or_upcoming") coverage.currentOrUpcoming += 1;
      else if (cycleRelevance === "evergreen") coverage.evergreen += 1;
      else if (cycleRelevance === "archived_or_past") coverage.archivedOrPast += 1;
      else if (cycleRelevance === "not_program_page") coverage.notProgramPage += 1;
      else coverage.unclear += 1;
    }

    if (rows.length < 1000) break;
  }

  return coverage;
}

function emptyCycleCoverage(): CycleCoverage {
  return {
    scannedSources: 0,
    sourcesWithFacts: 0,
    missingFacts: 0,
    sourcesWithCycleRelevance: 0,
    missingCycleRelevance: 0,
    rejectedFacts: 0,
    currentOrUpcoming: 0,
    evergreen: 0,
    archivedOrPast: 0,
    notProgramPage: 0,
    unclear: 0,
  };
}

function AdminShell({ children }: { children: React.ReactNode }) {
  return <div className="admin-page mx-auto w-full max-w-[90rem]">{children}</div>;
}

function AdminAccessDenied({ configured }: { configured: boolean }) {
  return (
    <AdminShell>
      <div className="card p-6">
        <span className="badge">Admin</span>
        <h1 className="mt-4 text-3xl font-black">Maintenance</h1>
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
  icon: IconComponent;
  label: string;
  value: React.ReactNode;
  detail: string;
  attention?: boolean;
}) {
  return (
    <div className={`admin-metric-card ${attention ? "admin-metric-card-attention" : ""}`}>
      <div className="admin-metric-head">
        <p className="admin-metric-label">{label}</p>
        <Icon size={17} aria-hidden="true" />
      </div>
      <p className="admin-metric-value">{value}</p>
      <p className="admin-metric-detail">{detail}</p>
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
    <div className={`admin-mini-stat ${attention ? "admin-mini-stat-attention" : ""}`}>
      <p className="admin-mini-stat-label">{label}</p>
      <p className="admin-mini-stat-value">{typeof value === "number" ? formatNumber(value) : value}</p>
    </div>
  );
}

function PipelineRow({
  icon: Icon,
  title,
  detail,
  status,
  attention = false,
}: {
  icon: IconComponent;
  title: string;
  detail: string;
  status: string;
  attention?: boolean;
}) {
  return (
    <div className={`admin-pipeline-row ${attention ? "admin-pipeline-row-attention" : ""}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <Icon className="mt-1 shrink-0" size={18} aria-hidden="true" />
          <div className="min-w-0">
            <p className="font-black">{title}</p>
            <p className="mt-1 text-sm text-[var(--muted)]">{detail}</p>
          </div>
        </div>
        <span className={attention ? "badge bg-[var(--brand-pink-soft)]" : "badge"}>{status}</span>
      </div>
    </div>
  );
}

function DetailDisclosure({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <details className="admin-detail-disclosure">
      <summary>{label}</summary>
      <div className="admin-detail-disclosure-body">{children}</div>
    </details>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="admin-detail-item">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function CommandLine({ command }: { command: string }) {
  return (
    <div className="admin-command-box">
      <code>{command}</code>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const failed = status === "failed" || status === "unavailable" || status === "completed_with_failures";
  return (
    <span className={failed ? "badge bg-[var(--brand-pink-soft)]" : "badge"}>
      {statusLabel(status)}
    </span>
  );
}

function latestMaintenanceRun(runs: LocalWorkerRun[]): MaintenanceRunView | null {
  const run = runs.find((candidate) => {
    const metadata = objectValue(candidate.metadata);
    return candidate.worker_name === "local-maintenance-runner" || metadata.kind === "maintenance";
  });
  if (!run) return null;

  const metadata = objectValue(run.metadata);
  return {
    run,
    metadata,
    profile: cleanText(metadata.profile) || "maintenance",
    reportPath: cleanText(metadata.report_path),
    phases: maintenanceRunPhases(metadata.phases),
  };
}

function latestMaintenanceDetail(view: MaintenanceRunView) {
  const phases = view.phases.length ? `${formatNumber(view.phases.length)} phases` : "no phases";
  return `${view.profile}; ${phases}; started ${formatDate(view.run.started_at)}`;
}

function maintenanceRunPhases(value: unknown): MaintenanceRunPhase[] {
  if (!Array.isArray(value)) return [];
  const phases: Array<MaintenanceRunPhase | null> = value.map((phase) => {
      const source = objectValue(phase);
      const name = cleanText(source.name);
      if (!name) return null;
      return {
        name,
        status: cleanText(source.status) || "running",
        started_at: cleanText(source.started_at),
        finished_at: cleanText(source.finished_at) || null,
        exit_code: typeof source.exit_code === "number" ? source.exit_code : null,
        log_path: cleanText(source.log_path),
      };
    });
  return phases.filter((phase): phase is MaintenanceRunPhase => phase !== null);
}

function recentRunsIncludeGeminiCreditBlock(runs: LocalWorkerRun[]) {
  return runs.some((run) =>
    /prepayment credits|credits are depleted|billing needs attention/i.test(
      JSON.stringify([run.error, run.metadata]),
    ),
  );
}

function statusLabel(status: string) {
  if (status === "succeeded") return "Succeeded";
  if (status === "failed") return "Failed";
  if (status === "completed_with_failures") return "Completed With Failures";
  if (status === "unavailable") return "Unavailable";
  if (status === "ready") return "Ready";
  return "Running";
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function cleanKey(value: unknown) {
  return typeof value === "string"
    ? value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")
    : "";
}

function cleanText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function formatDate(value: string) {
  return formatCentralDateTime(value);
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatUsd(value: number) {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: value >= 1 ? 2 : 4,
    maximumFractionDigits: value >= 1 ? 2 : 4,
  });
}

function percent(value: number, total: number) {
  if (total <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((value / total) * 100)));
}
